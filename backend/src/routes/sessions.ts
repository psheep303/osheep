import type { FastifyInstance } from "fastify";
import { resolveWorkspace } from "../workspace.js";
import {
  createSession,
  deleteSession,
  getSession,
  listSessions,
  saveSession,
  type SessionRecord,
} from "../sessions.js";
import { errors } from "../errors.js";

export async function registerSessionRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/sessions",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      const sessions = await listSessions(ws.path);
      return { sessions };
    }
  );

  app.get<{ Params: { id: string; sid: string } }>(
    "/api/workspaces/:id/sessions/:sid",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      return await getSession(ws.path, req.params.sid);
    }
  );

  app.post<{
    Params: { id: string };
    Body: Partial<SessionRecord>;
  }>("/api/workspaces/:id/sessions", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    return await createSession(ws.path, req.body ?? {});
  });

  app.put<{
    Params: { id: string; sid: string };
    Body: SessionRecord;
  }>("/api/workspaces/:id/sessions/:sid", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body;
    if (!body || body.id !== req.params.sid) {
      throw errors.invalidPath("session id 与 URL 不一致");
    }
    return await saveSession(ws.path, body);
  });

  app.delete<{ Params: { id: string; sid: string } }>(
    "/api/workspaces/:id/sessions/:sid",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await deleteSession(ws.path, req.params.sid);
      return { ok: true };
    }
  );
}
