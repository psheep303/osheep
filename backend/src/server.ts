import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import Fastify from "fastify";
import { config } from "./config.js";
import { ApiError } from "./errors.js";
import { registerAgentSessionRoutes } from "./routes/agent-sessions.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerAiRoutes } from "./routes/ai.js";
import { registerAiSettingsRoutes } from "./routes/ai-settings.js";
import { registerClaudeOnboardingRoutes } from "./routes/claude-onboarding.js";
import { registerClaudePluginRoutes } from "./routes/claude-plugins.js";
import { registerCliToolRoutes } from "./routes/cli-tools.js";
import { registerCodexPluginRoutes } from "./routes/codex-plugins.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerMcpRoutes } from "./routes/mcp.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerSkillsRoutes } from "./routes/skills.js";
import { registerTemplateRoutes } from "./routes/templates.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { createSecurity } from "./security.js";
import { registerStaticSite } from "./static-site.js";
import { ensureWorkspacesRoot } from "./workspace.js";

export async function buildServer() {
  const security = createSecurity({
    host: config.host,
    corsOrigins: config.corsOrigins,
    authToken: config.authToken,
  });
  const app = Fastify({
    logger:
      process.env.NODE_ENV === "production"
        ? true
        : { transport: { target: "pino-pretty", options: { colorize: true } } },
    bodyLimit: 16 * 1024 * 1024,
  });

  await app.register(cors, {
    credentials: true,
    origin: (origin, callback) => callback(null, security.isTrustedOrigin(origin)),
  });
  await app.register(websocket);
  await security.register(app);

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ApiError) {
      reply.status(err.statusCode).send({
        error: { code: err.code, message: err.message },
      });
      return;
    }
    const errObj = err as NodeJS.ErrnoException;
    const code = errObj.code;
    if (code === "ENOENT") {
      reply.status(404).send({
        error: { code: "NOT_FOUND", message: errObj.message },
      });
      return;
    }
    if (code === "EEXIST") {
      reply.status(409).send({
        error: { code: "ENTRY_EXISTS", message: errObj.message },
      });
      return;
    }
    app.log.error(err);
    reply.status(500).send({
      error: { code: "INTERNAL", message: errObj.message ?? "internal error" },
    });
  });

  app.get("/api/health", async () => ({ ok: true }));

  await registerWorkspaceRoutes(app);
  await registerTerminalRoutes(app);
  await registerSearchRoutes(app);
  await registerGitRoutes(app);
  await registerAgentRoutes(app);
  await registerSessionRoutes(app);
  await registerWorkflowRoutes(app);
  await registerAiRoutes(app);
  await registerAiSettingsRoutes(app);
  await registerCliToolRoutes(app);
  await registerMcpRoutes(app);
  await registerClaudeOnboardingRoutes(app);
  await registerClaudePluginRoutes(app);
  await registerCodexPluginRoutes(app);
  await registerAgentSessionRoutes(app);
  await registerSkillsRoutes(app);
  await registerTemplateRoutes(app);

  if (config.frontendRoot) {
    await registerStaticSite(app, config.frontendRoot);
  }

  await ensureWorkspacesRoot();
  return app;
}
