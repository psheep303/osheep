import type { FastifyInstance } from "fastify";
import { resolveWorkspace } from "../workspace.js";
import {
  deleteAgent,
  getAgent,
  listAgents,
  renameAgent,
  saveAgent,
  type AgentRecord,
} from "../agents.js";
import { errors } from "../errors.js";

function parseAgent(body: unknown): AgentRecord {
  const b = (body ?? {}) as Partial<AgentRecord>;
  if (typeof b.name !== "string" || b.name.trim() === "") {
    throw errors.invalidPath("缺少 name");
  }
  return {
    name: b.name,
    prompt: typeof b.prompt === "string" ? b.prompt : "",
    providerId: typeof b.providerId === "string" ? b.providerId : "",
    model: typeof b.model === "string" ? b.model : "",
  };
}

export async function registerAgentRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/agents",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      const agents = await listAgents(ws.path);
      return { agents };
    }
  );

  app.get<{ Params: { id: string; name: string } }>(
    "/api/workspaces/:id/agents/:name",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      return await getAgent(ws.path, req.params.name);
    }
  );

  app.put<{ Params: { id: string; name: string }; Body: unknown }>(
    "/api/workspaces/:id/agents/:name",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      const agent = parseAgent(req.body);
      if (agent.name !== req.params.name) {
        await renameAgent(ws.path, req.params.name, agent.name);
      }
      await saveAgent(ws.path, agent);
      return { ok: true };
    }
  );

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/workspaces/:id/agents",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      const agent = parseAgent(req.body);
      await saveAgent(ws.path, agent);
      return { ok: true };
    }
  );

  app.delete<{ Params: { id: string; name: string } }>(
    "/api/workspaces/:id/agents/:name",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await deleteAgent(ws.path, req.params.name);
      return { ok: true };
    }
  );
}
