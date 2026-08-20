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
import {
  interruptWorkflowRunRecord,
  isWorkflowRunActive,
  pauseWorkflowRun,
  resolveWorkflowDiffApproval,
  resolveWorkflowInput,
  retryWorkflowNodeNow,
  startWorkflowRun,
  stopWorkflowRun,
  stopWorkflowRunAndWait,
} from "../workflow-runner.js";
import {
  createWorkflow,
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  saveWorkflow,
  updateWorkflow,
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

async function recoverInterruptedWorkflow(
  workspaceId: string,
  workspaceRoot: string,
  workflowId: string,
): Promise<WorkflowRecord> {
  let workflow = await getWorkflow(workspaceRoot, workflowId);
  if (
    isWorkflowRunActive(workspaceId, workflowId) ||
    !workflow.runs.some((run) => run.status === "running")
  ) {
    return workflow;
  }
  workflow = await updateWorkflow(workspaceRoot, workflowId, (current) =>
    isWorkflowRunActive(workspaceId, workflowId) ? current : interruptWorkflowRunRecord(current),
  );
  return workflow;
}

export async function registerWorkflowRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/workflows", async (req, reply) => {
    const ws = await resolveWorkspace(req.params.id);
    let workflows = await listWorkflows(ws.path);
    const interrupted = workflows.filter(
      (workflow) =>
        workflow.status === "running" && !isWorkflowRunActive(req.params.id, workflow.id),
    );
    if (interrupted.length > 0) {
      await Promise.all(
        interrupted.map((workflow) =>
          recoverInterruptedWorkflow(req.params.id, ws.path, workflow.id),
        ),
      );
      workflows = await listWorkflows(ws.path);
    }
    return sendWithEtag(req, reply, { workflows });
  });

  app.get<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid",
    async (req, reply) => {
      const ws = await resolveWorkspace(req.params.id);
      const workflow = await recoverInterruptedWorkflow(req.params.id, ws.path, req.params.wid);
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

  app.patch<{
    Params: { id: string; wid: string };
    Body: WorkflowRecord;
  }>("/api/workspaces/:id/workflows/:wid/content", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body;
    if (!body || body.id !== req.params.wid) {
      throw errors.invalidPath("workflow id does not match URL");
    }
    const saved = await updateWorkflow(ws.path, req.params.wid, (current) => ({
      ...body,
      title: current.title,
    }));
    await updateTemplateFromWorkflow(saved);
    return saved;
  });

  app.patch<{
    Params: { id: string; wid: string };
    Body: { title?: string };
  }>("/api/workspaces/:id/workflows/:wid/title", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const title = req.body?.title?.trim();
    if (!title) throw errors.invalidPath("workflow title is required");
    const saved = await updateWorkflow(ws.path, req.params.wid, (current) => ({
      ...current,
      title,
    }));
    await updateTemplateFromWorkflow(saved);
    return saved;
  });

  app.post<{
    Params: { id: string; wid: string };
    Body: { nodeIds?: string[]; language?: "zh-CN" | "en"; resume?: boolean };
  }>("/api/workspaces/:id/workflows/:wid/run", async (req) => {
    const nodeIds = Array.isArray(req.body?.nodeIds)
      ? req.body.nodeIds.filter((id): id is string => typeof id === "string")
      : undefined;
    const retryLanguage = req.body?.language === "zh-CN" ? "zh-CN" : "en";
    return await startWorkflowRun(
      req.params.id,
      req.params.wid,
      nodeIds,
      retryLanguage,
      req.body?.resume === true,
    );
  });

  app.post<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid/pause",
    async (req) => {
      const paused = pauseWorkflowRun(req.params.id, req.params.wid);
      return { ok: true, paused };
    },
  );

  app.post<{ Params: { id: string; wid: string } }>(
    "/api/workspaces/:id/workflows/:wid/stop",
    async (req) => {
      const stopped = stopWorkflowRun(req.params.id, req.params.wid);
      return { ok: true, stopped };
    },
  );

  app.post<{
    Params: { id: string; wid: string; nodeId: string };
    Body: { approved?: unknown };
  }>("/api/workspaces/:id/workflows/:wid/nodes/:nodeId/approval", async (req) => {
    if (typeof req.body?.approved !== "boolean") {
      throw errors.invalidPath("approved must be a boolean");
    }
    const resolved = await resolveWorkflowDiffApproval(
      req.params.id,
      req.params.wid,
      req.params.nodeId,
      req.body.approved,
    );
    if (!resolved) throw errors.invalidPath("approval is no longer pending");
    return { ok: true };
  });

  app.post<{
    Params: { id: string; wid: string; nodeId: string };
    Body: { value?: unknown };
  }>("/api/workspaces/:id/workflows/:wid/nodes/:nodeId/input", async (req) => {
    if (typeof req.body?.value !== "string") {
      throw errors.invalidPath("value must be a string");
    }
    const resolved = await resolveWorkflowInput(
      req.params.id,
      req.params.wid,
      req.params.nodeId,
      req.body.value,
    );
    if (!resolved) throw errors.invalidPath("input is no longer pending");
    return { ok: true };
  });

  app.post<{ Params: { id: string; wid: string; nodeId: string } }>(
    "/api/workspaces/:id/workflows/:wid/nodes/:nodeId/retry-now",
    async (req) => {
      const retried = await retryWorkflowNodeNow(
        req.params.id,
        req.params.wid,
        req.params.nodeId,
      );
      if (!retried) throw errors.invalidPath("agent retry is no longer pending");
      return { ok: true };
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
