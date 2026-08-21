import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";
import {
  deleteSkill,
  disableSkill,
  enableSkill,
  getSkillsSnapshot,
  installSkill,
  type SkillAgent,
  type SkillOrigin,
  searchSkillsLibrary,
} from "../skills.js";

function agentField(body: unknown): SkillAgent {
  const value =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).agent
      : undefined;
  const agent = typeof value === "string" ? value.trim() : "";
  if (agent !== "claude" && agent !== "codex")
    throw errors.invalidQuery("agent must be claude or codex");
  return agent;
}

function originField(body: unknown): SkillOrigin {
  const value =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>).origin
      : undefined;
  return value === "skills.sh" ? "skills.sh" : "manual";
}

function stringField(body: unknown, field: string): string | undefined {
  const value =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)[field]
      : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function registerSkillsRoutes(app: FastifyInstance) {
  app.get("/api/skills", async () => await getSkillsSnapshot());
  app.get<{ Querystring: { q?: string } }>(
    "/api/skills/library",
    async (req) => await searchSkillsLibrary(req.query.q ?? ""),
  );
  app.post<{ Body: unknown }>("/api/skills/install", async (req) => {
    const source = stringField(req.body, "source");
    if (!source) throw errors.invalidQuery("source is required");
    const skill = stringField(req.body, "skill");
    return {
      ok: true,
      snapshot: await installSkill({
        source,
        skill,
        agent: agentField(req.body),
        origin: originField(req.body),
      }),
    };
  });
  app.post<{ Body: unknown }>("/api/skills/enable", async (req) => {
    const name = stringField(req.body, "name");
    if (!name) throw errors.invalidQuery("name is required");
    return { ok: true, snapshot: await enableSkill({ name, agent: agentField(req.body) }) };
  });
  app.post<{ Body: unknown }>("/api/skills/disable", async (req) => {
    const name = stringField(req.body, "name");
    if (!name) throw errors.invalidQuery("name is required");
    return { ok: true, snapshot: await disableSkill({ name, agent: agentField(req.body) }) };
  });
  app.post<{ Body: unknown }>("/api/skills/delete", async (req) => {
    const name = stringField(req.body, "name");
    if (!name) throw errors.invalidQuery("name is required");
    return { ok: true, snapshot: await deleteSkill({ name, agent: agentField(req.body) }) };
  });
}
