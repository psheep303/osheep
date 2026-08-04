import { createHash } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { errors } from "../errors.js";
import { updateTemplateFromWorkflow } from "../templates.js";
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

function sendWithEtag(req: FastifyRequest, reply: FastifyReply, payload: unknown) {
  const body = JSON.stringify(payload);
  const etag = `W/"${createHash("sha1").update(body).digest("base64url")}"`;
  reply.header("etag", etag);
  if (req.headers["if-none-match"] === etag) {
    return reply.status(304).send();
  }
  return reply.send(payload);
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
      return sendWithEtag(req, reply, workflow);
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
