import { buildServer } from "./server.js";
import { config } from "./config.js";

async function main() {
  const app = await buildServer();
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`osheep-backend listening on http://${config.host}:${config.port}`);
    app.log.info(`workspaces root: ${config.workspacesRoot}`);
  } catch (e) {
    app.log.error(e);
    process.exit(1);
  }

  const shutdown = async (sig: string) => {
    app.log.info(`received ${sig}, shutting down`);
    try {
      await app.close();
    } finally {
      process.exit(0);
    }
  };
  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

void main();
