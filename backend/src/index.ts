import { config } from "./config.js";
import { migrateLegacyGlobalData } from "./global-data-migration.js";
import { buildServer } from "./server.js";

async function main() {
  const migration = await migrateLegacyGlobalData();
  const app = await buildServer();
  try {
    await app.listen({ host: config.host, port: config.port });
    app.log.info(`osheep-backend listening on http://${config.host}:${config.port}`);
    app.log.info(`workspaces root: ${config.workspacesRoot}`);
    if (migration.copied || migration.deduplicated || migration.conflicts) {
      app.log.info({ migration }, "migrated legacy global data into backend/.osheep");
    }
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
