import type { FastifyInstance } from "fastify";
import { adapterRegistry } from "../adapters/default-registry.js";
import { listAdapterSessions, subscribeAdapterEvents } from "../adapters/session-store.js";
import { subscribeWorkspaceWorkflowRuntime } from "../workflow-events.js";
import { resolveWorkspace } from "../workspace.js";
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

  app.get<{ Querystring: { workspaceId?: string } }>(
    "/api/adapter-events",
    { websocket: true },
    (socket, req) => {
      let closed = false;
      const unsubscribe = subscribeAdapterEvents((event) => {
        if (!closed && socket.readyState === socket.OPEN) socket.send(JSON.stringify(event));
      });
      let unsubscribeWorkflow = () => {};
      void (async () => {
        try {
          const workspace = req.query.workspaceId
            ? await resolveWorkspace(req.query.workspaceId)
            : null;
          if (workspace) {
            unsubscribeWorkflow = subscribeWorkspaceWorkflowRuntime(workspace.path, (event) => {
              if (!closed && socket.readyState === socket.OPEN) {
                socket.send(JSON.stringify({ ...event, type: `workflow.${event.type}` }));
              }
            });
          }
          if (!closed && socket.readyState === socket.OPEN) {
            socket.send(
              JSON.stringify({
                type: "ready",
                sessions: listAdapterSessions().map((item) => item.session),
                updatedAt: Date.now(),
              }),
            );
          }
        } catch {
          if (!closed && socket.readyState === socket.OPEN) {
            socket.send(JSON.stringify({ type: "ready", sessions: [], updatedAt: Date.now() }));
          }
        }
      })();
      socket.on("close", () => {
        closed = true;
        unsubscribe();
        unsubscribeWorkflow();
      });
    },
  );
}
