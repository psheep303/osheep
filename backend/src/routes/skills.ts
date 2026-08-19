import type { FastifyInstance } from "fastify";
import { getSkillsSnapshot, installSkill, searchSkillsLibrary, type SkillAgent, uninstallSkill } from "../skills.js";
import { errors } from "../errors.js";

function agents(value: unknown): SkillAgent[] {
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : [];
  const result = values.map((item) => String(item).trim()).filter((item): item is SkillAgent => item === "claude" || item === "codex");
  if (result.length === 0 || result.length !== values.length) throw errors.invalidQuery("agents must contain claude or codex");
  return [...new Set(result)];
}

function stringField(body: unknown, field: string): string | undefined {
  const value = body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>)[field] : undefined;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export async function registerSkillsRoutes(app: FastifyInstance) {
  app.get("/api/skills", async () => await getSkillsSnapshot());
  app.get<{ Querystring: { q?: string } }>("/api/skills/library", async (req) => await searchSkillsLibrary(req.query.q ?? ""));
  app.post<{ Body: unknown }>("/api/skills/install", async (req) => {
    const source = stringField(req.body, "source");
    if (!source) throw errors.invalidQuery("source is required");
    const skill = stringField(req.body, "skill");
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    return { ok: true, snapshot: await installSkill({ source, skill, agents: agents(body.agents) }) };
  });
  app.post<{ Body: unknown }>("/api/skills/uninstall", async (req) => {
    const name = stringField(req.body, "name");
    if (!name) throw errors.invalidQuery("name is required");
    const body = req.body && typeof req.body === "object" ? (req.body as Record<string, unknown>) : {};
    return { ok: true, snapshot: await uninstallSkill({ name, agents: agents(body.agents) }) };
  });
}

