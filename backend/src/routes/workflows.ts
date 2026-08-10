import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import {
  type AgentSessionApp,
  type AgentSessionUsage,
  readAgentSessionUsage,
} from "../agent-sessions.js";
import { errors } from "../errors.js";
import { calculateModelCost, readStoredModelPrices } from "../model-pricing.js";
import { updateTemplateFromWorkflow } from "../templates.js";
import { subscribeWorkflowRuntime } from "../workflow-events.js";
import { startWorkflowRun, stopWorkflowRun, stopWorkflowRunAndWait } from "../workflow-runner.js";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
  type WorkflowRecord,
} from "../workflows.js";
import { resolveWorkspace } from "../workspace.js";

const WORKFLOW_SESSION_USAGE_CACHE_LIMIT = 128;
const workflowSessionUsageCache = new Map<string, Promise<AgentSessionUsage>>();

function sendWithEtag(req: FastifyRequest, reply: FastifyReply, payload: unknown) {
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
  reply.header("etag", etag);
  if (req.headers["if-none-match"] === etag) {
    return reply.status(304).send();
  }
  return reply.type("application/json; charset=utf-8").send(body);
}

export async function registerWorkflowRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/workflows", async (req, reply) => {
    const ws = await resolveWorkspace(req.params.id);
    const workflows = await listWorkflows(ws.path);
    return sendWithEtag(req, reply, { workflows });
  });

  app.get<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid",
    async (req, reply) => {
      const ws = await resolveWorkspace(req.params.id);
      const workflow = await getWorkflow(ws.path, req.params.wid);
      const [prices, currentSessionUsage] = await Promise.all([
        readStoredModelPrices().catch(() => []),
        readCurrentWorkflowSessionUsage(workflow),
      ]);
      const pricedWorkflow = {
        ...workflow,
        runs: workflow.runs.map((run) => {
          const trace = run.trace?.map((item) => {
            if (item.cost !== undefined) return item;
            const node = workflow.nodes.find((node) => node.id === item.nodeId);
            const sessionUsage = currentSessionUsage.get(
              workflowTraceKey(item.nodeId, item.startedAt),
            );
            const model = item.model ?? sessionUsage?.model ?? node?.model;
            const tokens = item.tokens ?? sessionUsage?.tokens;
            const cost =
              sessionUsage?.cost ??
              (model
                ? calculateModelCost(model, tokens, prices, {
                    inputIncludesCache: node?.providerKind !== "claude-cli",
                  })
                : undefined);
            return cost === undefined
              ? item
              : { ...item, model: item.model ?? sessionUsage?.model, tokens, cost };
          });
          const calculatedCost = trace?.reduce((sum, item) => sum + (item.cost ?? 0), 0) ?? 0;
          return {
            ...run,
            trace,
            stats:
              run.stats || calculatedCost > 0
                ? { ...(run.stats ?? {}), cost: calculatedCost || run.stats?.cost }
                : run.stats,
          };
        }),
      };
      return sendWithEtag(req, reply, pricedWorkflow);
    },
  );

  app.get<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid/events",
    { websocket: true },
    (socket, req) => {
      let unsubscribe = () => {};
      let heartbeat: NodeJS.Timeout | null = null;
      let closed = false;

      void (async () => {
        try {
          const workspace = await resolveWorkspace(req.params.id);
          unsubscribe = subscribeWorkflowRuntime(workspace.path, req.params.wid, (event) => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
          });
          const workflow = await getWorkflow(workspace.path, req.params.wid);
          if (closed || socket.readyState !== socket.OPEN) {
            unsubscribe();
            return;
          }
          socket.send(JSON.stringify({ type: "ready", updatedAt: workflow.updatedAt }));
          heartbeat = setInterval(() => {
            if (socket.readyState === socket.OPEN) socket.send(JSON.stringify({ type: "ping" }));
          }, 15_000);
        } catch (error) {
          unsubscribe();
          if (socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "error", message: (error as Error).message }));
            socket.close();
          }
        }
      })();

      socket.on("message", (raw: Buffer) => {
        try {
          const message = JSON.parse(raw.toString("utf8")) as { type?: string };
          if (message.type === "ping" && socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "pong" }));
          }
        } catch {
          /* ignore malformed keepalive frames */
        }
      });
      socket.on("close", () => {
        closed = true;
        unsubscribe();
        if (heartbeat) clearInterval(heartbeat);
      });
    },
  );

  app.post<{
    Params: { id: string };
    Body: Partial<WorkflowRecord>;
  }>("/api/workspaces/:id/workflows", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const { templateBinding: _templateBinding, ...body } = req.body ?? {};
    return await createWorkflow(ws.path, body);
  });

  app.put<{
    Params: { id: string; wid: string };
    Body: WorkflowRecord;
  }>("/api/workspaces/:id/workflows/:wid", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body;
    if (!body || body.id !== req.params.wid) {
      throw errors.invalidPath("workflow id does not match URL");
    }
    const saved = await saveWorkflow(ws.path, body);
    await updateTemplateFromWorkflow(saved);
    return saved;
  });

  app.post<{
    Params: { id: string; wid: string };
    Body: { nodeIds?: string[] };
  }>("/api/workspaces/:id/workflows/:wid/run", async (req) => {
    const nodeIds = Array.isArray(req.body?.nodeIds)
      ? req.body.nodeIds.filter((id): id is string => typeof id === "string")
      : undefined;
    return await startWorkflowRun(req.params.id, req.params.wid, nodeIds);
  });

  app.post<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid/stop",
    async (req) => {
      const stopped = stopWorkflowRun(req.params.id, req.params.wid);
      return { ok: true, stopped };
    },
  );

  app.delete<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid",
    async (req) => {
      await stopWorkflowRunAndWait(req.params.id, req.params.wid);
      const ws = await resolveWorkspace(req.params.id);
      await deleteWorkflow(ws.path, req.params.wid);
      return { ok: true };
    },
  );
}

async function readCurrentWorkflowSessionUsage(
  workflow: WorkflowRecord,
): Promise<Map<string, AgentSessionUsage>> {
  const reads: Array<Promise<readonly [string, AgentSessionUsage]>> = [];
  for (const node of workflow.nodes) {
    if (node.providerKind !== "claude-cli" && node.providerKind !== "codex-cli") continue;
    const details =
      node.config && typeof node.config.runDetails === "object"
        ? (node.config.runDetails as Record<string, unknown>)
        : undefined;
    const sessionId =
      typeof details?.conversationSessionId === "string"
        ? details.conversationSessionId
        : undefined;
    const startedAt = typeof details?.startedAt === "number" ? details.startedAt : undefined;
    const completedAt = typeof details?.completedAt === "number" ? details.completedAt : undefined;
    if (!sessionId || startedAt === undefined || completedAt === undefined) continue;
    const matchingTrace = workflow.runs.some((run) =>
      run.trace?.some(
        (trace) =>
          trace.nodeId === node.id && trace.startedAt === startedAt && trace.cost === undefined,
      ),
    );
    if (!matchingTrace) continue;
    const app: AgentSessionApp = node.providerKind === "claude-cli" ? "claude" : "codex";
    const traceKey = workflowTraceKey(node.id, startedAt);
    reads.push(
      readCachedWorkflowSessionUsage(app, sessionId, completedAt).then(
        (usage) => [traceKey, usage] as const,
      ),
    );
  }
  return new Map(await Promise.all(reads));
}

async function readCachedWorkflowSessionUsage(
  app: AgentSessionApp,
  sessionId: string,
  completedAt: number,
): Promise<AgentSessionUsage> {
  const cacheKey = `${app}:${sessionId}:${completedAt}`;
  let pending = workflowSessionUsageCache.get(cacheKey);
  if (!pending) {
    if (workflowSessionUsageCache.size >= WORKFLOW_SESSION_USAGE_CACHE_LIMIT) {
      const oldestKey = workflowSessionUsageCache.keys().next().value;
      if (oldestKey !== undefined) workflowSessionUsageCache.delete(oldestKey);
    }
    pending = readAgentSessionUsage(app, sessionId);
    workflowSessionUsageCache.set(cacheKey, pending);
  }
  try {
    return await pending;
  } catch {
    workflowSessionUsageCache.delete(cacheKey);
    return {};
  }
}

function workflowTraceKey(nodeId: string, startedAt: number): string {
  return `${nodeId}:${startedAt}`;
}
