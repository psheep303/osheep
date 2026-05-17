import Fastify from "fastify";
import cors from "@fastify/cors";
import websocket from "@fastify/websocket";
import { config } from "./config.js";
import { ApiError } from "./errors.js";
import { ensureWorkspacesRoot } from "./workspace.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";
import { registerTerminalRoutes } from "./routes/terminals.js";
import { registerSearchRoutes } from "./routes/search.js";
import { registerGitRoutes } from "./routes/git.js";
import { registerAgentRoutes } from "./routes/agents.js";
import { registerSessionRoutes } from "./routes/sessions.js";
import { registerAiRoutes } from "./routes/ai.js";

export async function buildServer() {
  const app = Fastify({
    logger: { transport: { target: "pino-pretty", options: { colorize: true } } },
    bodyLimit: 16 * 1024 * 1024,
  });

  await app.register(cors, { origin: config.corsOrigin });
  await app.register(websocket);

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
  await registerAiRoutes(app);

  await ensureWorkspacesRoot();
  return app;
}
