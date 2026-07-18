import type { FastifyInstance } from "fastify";
import {
  attachSink,
  createSession,
  getProfiles,
  getSession,
  killSession,
  listSessions,
  resizeSession,
  writeInput,
} from "../pty.js";
import { resolveWorkspace } from "../workspace.js";
import { errors } from "../errors.js";
import { platform } from "../config.js";

export async function registerTerminalRoutes(app: FastifyInstance) {
  app.get("/api/terminals/profiles", async () => {
    return {
      os: platform,
      profiles: getProfiles().map((p) => ({
        id: p.id,
        label: p.label,
        executable: p.executable,
      })),
    };
  });

  app.get("/api/terminals", async () => {
    return { sessions: listSessions() };
  });

  app.post<{
    Body: {
      workspaceId?: string;
      shell?: string;
      cols?: number;
      rows?: number;
    };
  }>("/api/terminals", async (req) => {
    const body = req.body ?? {};
    if (typeof body.workspaceId !== "string")
      throw errors.invalidPath("缺少 workspaceId");
    if (typeof body.shell !== "string")
      throw errors.unsupportedShell(String(body.shell));
    const ws = await resolveWorkspace(body.workspaceId);
    const session = createSession({
      workspace: ws,
      shell: body.shell,
      cols: body.cols ?? 80,
      rows: body.rows ?? 24,
    });
    return {
      id: session.id,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      wsUrl: `/api/terminals/${session.id}/io`,
    };
  });

  app.delete<{ Params: { id: string } }>(
    "/api/terminals/:id",
    async (req) => {
      // Throws if not found
      getSession(req.params.id);
      killSession(req.params.id, "client-delete");
      return { id: req.params.id };
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/terminals/:id/io",
    { websocket: true },
    (socket, req) => {
      const id = req.params.id;
      let session;
      try {
        session = getSession(id);
      } catch (e) {
        try {
          socket.send(
            JSON.stringify({
              type: "error",
              message: (e as Error).message,
            })
          );
        } catch {
          /* ignore */
        }
        socket.close();
        return;
      }

      const { detach, replayed } = attachSink(session, (frame) => {
        if (socket.readyState === socket.OPEN) socket.send(frame);
      });

      if (replayed) {
        socket.send(JSON.stringify({ type: "output", data: replayed }));
      }

      const heartbeat = setInterval(() => {
        if (socket.readyState === socket.OPEN) {
          try {
            socket.send(JSON.stringify({ type: "ping" }));
          } catch {
            /* ignore */
          }
        }
      }, 15000);

      socket.on("message", (raw: Buffer) => {
        let msg: unknown;
        try {
          msg = JSON.parse(raw.toString("utf-8"));
        } catch {
          socket.send(
            JSON.stringify({ type: "error", message: "invalid JSON frame" })
          );
          return;
        }
        if (typeof msg !== "object" || msg === null) return;
        const m = msg as {
          type?: string;
          data?: string;
          cols?: number;
          rows?: number;
        };
        try {
          switch (m.type) {
            case "input":
              if (typeof m.data === "string") writeInput(session, m.data);
              break;
            case "resize":
              if (typeof m.cols === "number" && typeof m.rows === "number") {
                resizeSession(session, m.cols, m.rows);
              }
              break;
            case "ping":
              socket.send(JSON.stringify({ type: "pong" }));
              break;
            case "pong":
              // client reply to our ping — ignore
              break;
            default:
              // ignore unknown
              break;
          }
        } catch (e) {
          socket.send(
            JSON.stringify({ type: "error", message: (e as Error).message })
          );
        }
      });

      socket.on("close", () => {
        clearInterval(heartbeat);
        detach();
        if (session.killOnDetach) {
          // Conservative default for regular terminal panel sessions.
          killSession(session.id, "ws-close");
        }
      });
    }
  );
}
