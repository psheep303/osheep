import type { FastifyInstance } from "fastify";
import {
  type AiProvider,
  type AiSettingsApp,
  deleteAiProvider,
  importLiveProvider,
  readLiveSettings,
  snapshotAiSettings,
  switchAiProvider,
  upsertAiProvider,
  writeAiSettings,
} from "../ai-settings.js";
import { errors } from "../errors.js";

function parseApp(value: unknown): AiSettingsApp {
  if (value === "claude" || value === "codex") return value;
  throw errors.invalidQuery("app must be claude or codex");
}

export async function registerAiSettingsRoutes(app: FastifyInstance) {
  app.get("/api/ai-settings", async () => snapshotAiSettings());

  app.put<{
    Body: unknown;
  }>("/api/ai-settings", async (req) => {
    await writeAiSettings(req.body as never);
    return snapshotAiSettings();
  });

  app.get<{
    Params: { app: string };
  }>("/api/ai-settings/live/:app", async (req) => {
    const appId = parseApp(req.params.app);
    return { app: appId, settingsConfig: await readLiveSettings(appId) };
  });

  app.post<{
    Body: { app?: unknown; id?: unknown; name?: unknown };
  }>("/api/ai-settings/import-live", async (req) => {
    const appId = parseApp(req.body?.app);
    const id =
      typeof req.body?.id === "string" && req.body.id.trim() ? req.body.id.trim() : "default";
    const name =
      typeof req.body?.name === "string" && req.body.name.trim() ? req.body.name.trim() : undefined;
    return importLiveProvider(appId, id, name);
  });

  app.post<{
    Body: { app?: unknown; provider?: AiProvider; apply?: boolean };
  }>("/api/ai-settings/providers", async (req) => {
    const appId = parseApp(req.body?.app);
    if (!req.body?.provider) throw errors.invalidQuery("provider is required");
    return upsertAiProvider(appId, req.body.provider, undefined, req.body.apply === true);
  });

  app.put<{
    Params: { id: string };
    Body: { app?: unknown; provider?: AiProvider; apply?: boolean };
  }>("/api/ai-settings/providers/:id", async (req) => {
    const appId = parseApp(req.body?.app);
    if (!req.body?.provider) throw errors.invalidQuery("provider is required");
    return upsertAiProvider(appId, req.body.provider, req.params.id, req.body.apply === true);
  });

  app.delete<{
    Params: { id: string };
    Querystring: { app?: string };
  }>("/api/ai-settings/providers/:id", async (req) => {
    const appId = parseApp(req.query.app);
    return deleteAiProvider(appId, req.params.id);
  });

  app.post<{
    Body: { app?: unknown; id?: unknown };
  }>("/api/ai-settings/switch", async (req) => {
    const appId = parseApp(req.body?.app);
    if (typeof req.body?.id !== "string" || !req.body.id.trim()) {
      throw errors.invalidQuery("id is required");
    }
    return switchAiProvider(appId, req.body.id.trim());
  });
}
