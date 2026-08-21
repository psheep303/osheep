import type { FastifyInstance } from "fastify";
import { adapterRegistry } from "../adapters/default-registry.js";
export async function registerAdapterRoutes(app: FastifyInstance): Promise<void> {
  app.get("/api/adapters", async () => ({
    adapters: adapterRegistry.list().map((adapter) => ({
      id: adapter.id,
      name: adapter.name,
      kind: adapter.kind,
      capabilities: adapter.getCapabilities(),
      configSchema: adapter.getConfigSchema(),
    })),
  }));
}
