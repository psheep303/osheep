import type { FastifyInstance } from "fastify";
import {
  addClaudeMarketplace,
  disableClaudePlugin,
  enableClaudePlugin,
  getClaudePluginSnapshot,
  installClaudePlugin,
  uninstallClaudePlugin,
} from "../claude-plugins.js";
import { parseRequiredStringField } from "./codex-plugins.js";

export async function registerClaudePluginRoutes(app: FastifyInstance) {
  app.get("/api/claude-plugins", async () => {
    return await getClaudePluginSnapshot();
  });

  app.post<{ Body: unknown }>("/api/claude-plugins/install", async (req) => {
    const selector = parseRequiredStringField(req.body, "selector");
    const result = await installClaudePlugin(selector);
    return { ok: true, result, snapshot: await getClaudePluginSnapshot() };
  });

  app.post<{ Body: unknown }>("/api/claude-plugins/uninstall", async (req) => {
    const selector = parseRequiredStringField(req.body, "selector");
    const body = req.body as { scope?: unknown };
    const scope = typeof body.scope === "string" ? body.scope : undefined;
    const result = await uninstallClaudePlugin(selector, { scope });
    return { ok: true, result, snapshot: await getClaudePluginSnapshot() };
  });

  app.post<{ Body: unknown }>("/api/claude-plugins/enable", async (req) => {
    const selector = parseRequiredStringField(req.body, "selector");
    const result = await enableClaudePlugin(selector);
    return { ok: true, result, snapshot: await getClaudePluginSnapshot() };
  });

  app.post<{ Body: unknown }>("/api/claude-plugins/disable", async (req) => {
    const selector = parseRequiredStringField(req.body, "selector");
    const result = await disableClaudePlugin(selector);
    return { ok: true, result, snapshot: await getClaudePluginSnapshot() };
  });

  app.post<{ Body: unknown }>("/api/claude-plugins/marketplaces", async (req) => {
    const source = parseRequiredStringField(req.body, "source");
    const result = await addClaudeMarketplace(source);
    return { ok: true, result, snapshot: await getClaudePluginSnapshot() };
  });
}
