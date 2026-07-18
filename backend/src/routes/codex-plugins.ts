import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";
import {
  addCodexMarketplace,
  createLocalCodexPlugin,
  getCodexPluginSnapshot,
  importLocalCodexPlugin,
  installCodexPlugin,
  removeLocalCodexPlugin,
  uninstallCodexPlugin,
} from "../codex-plugins.js";

export function parseRequiredStringField(body: unknown, field: string): string {
  const obj = body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
  const value = obj[field];
  if (typeof value !== "string" || !value.trim()) {
    throw errors.invalidQuery(`${field} is required`);
  }
  return value.trim();
}

export function parseDeleteSourceFlag(query: unknown): boolean {
  const obj = query && typeof query === "object" && !Array.isArray(query)
    ? (query as Record<string, unknown>)
    : {};
  return obj.deleteSource === true || obj.deleteSource === "true";
}

function objectBody(body: unknown): Record<string, unknown> {
  return body && typeof body === "object" && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : {};
}

export async function registerCodexPluginRoutes(app: FastifyInstance) {
  app.get("/api/codex-plugins", async () => {
    return await getCodexPluginSnapshot();
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/install", async (req) => {
    const selector = parseRequiredStringField(req.body, "selector");
    const result = await installCodexPlugin(selector);
    return { ok: true, result, snapshot: await getCodexPluginSnapshot() };
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/uninstall", async (req) => {
    const selector = parseRequiredStringField(req.body, "selector");
    const result = await uninstallCodexPlugin(selector);
    return { ok: true, result, snapshot: await getCodexPluginSnapshot() };
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/local", async (req) => {
    const body = objectBody(req.body);
    const name = parseRequiredStringField(body, "name");
    const displayName = typeof body.displayName === "string"
      ? body.displayName
      : undefined;
    const description = typeof body.description === "string"
      ? body.description
      : undefined;
    return await createLocalCodexPlugin({ name, displayName, description });
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/import-local", async (req) => {
    const pluginPath = parseRequiredStringField(req.body, "path");
    return await importLocalCodexPlugin({ path: pluginPath });
  });

  app.delete<{
    Params: { name: string };
    Querystring: { deleteSource?: string | boolean };
  }>("/api/codex-plugins/local/:name", async (req) => {
    return await removeLocalCodexPlugin(
      req.params.name,
      parseDeleteSourceFlag(req.query)
    );
  });

  app.post<{ Body: unknown }>("/api/codex-plugins/marketplaces", async (req) => {
    const source = parseRequiredStringField(req.body, "source");
    const result = await addCodexMarketplace(source);
    return { ok: true, result, snapshot: await getCodexPluginSnapshot() };
  });
}
