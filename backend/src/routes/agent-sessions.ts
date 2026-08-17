import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import {
  type AgentSessionApp,
  deleteAgentSessionsInProject,
  getAgentSession,
  isAgentSessionInProject,
  listAgentSessions,
} from "../agent-sessions.js";
import { platform } from "../config.js";
import { errors } from "../errors.js";
import { createSession, writeInput } from "../pty.js";
import { resolveWorkspace } from "../workspace.js";

export async function registerAgentSessionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { app?: string; workspaceId?: string } }>(
    "/api/agent-sessions",
    async (req) => {
      const sessionApp = parseAgentSessionApp(req.query.app);
      const workspace = await resolveWorkspace(parseWorkspaceId(req.query.workspaceId));
      const sessions = (await listAgentSessions(sessionApp)).filter((session) =>
        isAgentSessionInProject(session, workspace.path),
      );
      return { sessions };
    },
  );

  app.delete<{
    Params: { app: string; id: string };
    Querystring: { workspaceId?: string };
  }>("/api/agent-sessions/:app/:id", async (req) => {
    const sessionApp = parseAgentSessionApp(req.params.app);
    const workspace = await resolveWorkspace(parseWorkspaceId(req.query.workspaceId));
    const result = await deleteAgentSessionsInProject(sessionApp, [req.params.id], workspace.path);
    const deleted = result.deleted[0];
    if (!deleted) throw errors.notFound("Agent session not found in the current project");
    return { session: deleted };
  });

  app.post<{
    Params: { app: string };
    Body: { workspaceId?: string; ids?: unknown };
  }>("/api/agent-sessions/:app/batch-delete", async (req) => {
    const sessionApp = parseAgentSessionApp(req.params.app);
    const body = req.body ?? {};
    const workspace = await resolveWorkspace(parseWorkspaceId(body.workspaceId));
    const ids = parseSessionIds(body.ids);
    return await deleteAgentSessionsInProject(sessionApp, ids, workspace.path);
  });

  app.post<{
    Params: { app: string; id: string };
    Body: { workspaceId?: string; shell?: string; cols?: number; rows?: number };
  }>("/api/agent-sessions/:app/:id/terminal", async (req) => {
    const sessionApp = parseAgentSessionApp(req.params.app);
    const body = req.body ?? {};
    const workspace = await resolveWorkspace(parseWorkspaceId(body.workspaceId));
    if (typeof body.shell !== "string") {
      throw errors.unsupportedShell(String(body.shell));
    }
    const agentSession = await getAgentSession(sessionApp, req.params.id);
    if (!agentSession || !isAgentSessionInProject(agentSession, workspace.path)) {
      throw errors.notFound("Agent session not found in the current project");
    }
    const cwdStat = await fs.stat(agentSession.cwd).catch(() => null);
    if (!cwdStat?.isDirectory()) {
      throw errors.notFound(`Session working directory no longer exists: ${agentSession.cwd}`);
    }

    const session = createSession({
      workspace: {
        id: `agent-${sessionApp}-${agentSession.id}`,
        name: path.basename(agentSession.cwd) || agentSession.title,
        path: agentSession.cwd,
      },
      shell: body.shell,
      cols: body.cols ?? 80,
      rows: body.rows ?? 24,
      guardRoot: agentSession.cwd,
      // Advertise a native CSI-u terminal. Claude Code enables its Kitty
      // keyboard protocol for WezTerm, while VS Code requires a separate
      // keybinding installation step.
      terminalProgram: "WezTerm",
    });
    writeInput(session, `${resumeCommand(sessionApp)} ${agentSession.id}\r`);
    return {
      id: session.id,
      shell: session.shell,
      cols: session.cols,
      rows: session.rows,
      wsUrl: `/api/terminals/${session.id}/io`,
    };
  });
}

function parseAgentSessionApp(value: string | undefined): AgentSessionApp {
  if (value === "claude" || value === "codex") return value;
  throw errors.invalidQuery("app must be claude or codex");
}

function parseWorkspaceId(value: string | undefined): string {
  if (typeof value === "string" && value.trim()) return value.trim();
  throw errors.invalidQuery("workspaceId is required");
}

function parseSessionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) {
    throw errors.invalidQuery("ids must contain 1 to 500 session ids");
  }
  const ids = value.filter((id): id is string => typeof id === "string" && !!id.trim());
  if (ids.length !== value.length) throw errors.invalidQuery("ids contains an invalid session id");
  return ids.map((id) => id.trim());
}

function resumeCommand(app: AgentSessionApp): string {
  if (app === "claude") return "claude --resume";
  return platform === "windows" ? "codex.cmd resume" : "codex resume";
}
