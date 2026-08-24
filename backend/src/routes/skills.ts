import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";
import {
  applySkillSelection,
  deleteSkill,
  disableSkill,
  enableSkill,
  getSkillsSnapshot,
  importSkill,
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

function stringArrayField(body: unknown, field: string): string[] {
  const value =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as Record<string, unknown>)[field]
      : undefined;
  if (!Array.isArray(value)) throw errors.invalidQuery(`${field} must be an array`);
  return value.filter((item): item is string => typeof item === "string");
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
  app.post<{ Body: unknown }>("/api/skills/import", async (req) => {
    const body =
      req.body && typeof req.body === "object" && !Array.isArray(req.body)
        ? (req.body as Record<string, unknown>)
        : {};
    const files = Array.isArray(body.files)
      ? body.files.filter((item): item is { path: string; data: string } =>
          Boolean(
            item &&
              typeof item === "object" &&
              typeof (item as Record<string, unknown>).path === "string" &&
              typeof (item as Record<string, unknown>).data === "string",
          ),
        )
      : undefined;
    const sourcePath = typeof body.sourcePath === "string" ? body.sourcePath.trim() : undefined;
    return {
      ok: true,
      snapshot: await importSkill({ agent: agentField(req.body), sourcePath, files }),
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
  app.post<{ Body: unknown }>("/api/skills/apply", async (req) => ({
    ok: true,
    snapshot: await applySkillSelection({
      agent: agentField(req.body),
      selectedNames: stringArrayField(req.body, "names"),
    }),
  }));
  app.post<{ Body: unknown }>("/api/skills/delete", async (req) => {
    const name = stringField(req.body, "name");
    if (!name) throw errors.invalidQuery("name is required");
    return { ok: true, snapshot: await deleteSkill({ name, agent: agentField(req.body) }) };
  });
}
