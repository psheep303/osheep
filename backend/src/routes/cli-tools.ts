import type { FastifyInstance } from "fastify";
import { type CliToolAction, type CliToolName, cliToolManager } from "../cli-tools.js";
import { errors } from "../errors.js";

const TOOL_NAMES: CliToolName[] = ["claude", "codex"];

function parseToolName(value: unknown): CliToolName {
  if (value === "claude" || value === "codex") return value;
  throw errors.invalidQuery("CLI tool must be claude or codex");
}

function parseToolAction(value: unknown): CliToolAction {
  if (value === "install" || value === "update") return value;
  throw errors.invalidQuery("CLI action must be install or update");
}

export async function registerCliToolRoutes(app: FastifyInstance) {
  app.get("/api/ai/cli-tools", async () => ({
    tools: await Promise.all(TOOL_NAMES.map((name) => cliToolManager.getStatus(name))),
  }));

  app.post<{ Params: { name: string }; Body: { action?: unknown } }>(
    "/api/ai/cli-tools/:name/action",
    async (req) => {
      const name = parseToolName(req.params.name);
      const action = parseToolAction(req.body?.action);
      return { status: await cliToolManager.runAction(name, action) };
    },
  );
}
