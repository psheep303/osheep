import type { FastifyInstance } from "fastify";
import { resolveWorkspace } from "../workspace.js";
import {
  addRemote,
  commit,
  discardPaths,
  getDiff,
  getLog,
  getRepoInfo,
  getStatus,
  gitInit,
  isRepo,
  listRemotes,
  removeRemote,
  stagePaths,
  unstagePaths,
} from "../git-ops.js";
import { errors } from "../errors.js";

function requireStringArray(v: unknown): string[] {
  if (!Array.isArray(v)) throw errors.invalidPath("paths 必须是字符串数组");
  for (const p of v) {
    if (typeof p !== "string") throw errors.invalidPath("paths 元素必须是字符串");
  }
  return v as string[];
}

async function ensureRepo(workspaceRoot: string): Promise<void> {
  if (!(await isRepo(workspaceRoot))) throw errors.notARepo();
}

export async function registerGitRoutes(app: FastifyInstance) {
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/git/repo",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      return await getRepoInfo(ws.path);
    }
  );

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/git/status",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      return await getStatus(ws.path);
    }
  );

  app.post<{
    Params: { id: string };
    Body: { paths?: unknown };
  }>("/api/workspaces/:id/git/stage", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    const paths = requireStringArray(req.body?.paths);
    await stagePaths(ws.path, paths);
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: { paths?: unknown };
  }>("/api/workspaces/:id/git/unstage", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    const paths = requireStringArray(req.body?.paths);
    await unstagePaths(ws.path, paths);
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: { paths?: unknown };
  }>("/api/workspaces/:id/git/discard", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    const paths = requireStringArray(req.body?.paths);
    const discarded = await discardPaths(ws.path, paths);
    return { ok: true, discarded };
  });

  app.post<{
    Params: { id: string };
    Body: { message?: string };
  }>("/api/workspaces/:id/git/commit", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    const msg = req.body?.message;
    if (typeof msg !== "string") throw errors.emptyCommitMessage();
    const head = await commit(ws.path, msg);
    return { ok: true, head };
  });

  app.post<{ Params: { id: string }; Body: unknown }>(
    "/api/workspaces/:id/git/init",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await gitInit(ws.path);
      return { ok: true };
    }
  );

  app.get<{
    Params: { id: string };
    Querystring: { path?: string; base?: string; head?: string };
  }>("/api/workspaces/:id/git/diff", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    const p = req.query.path;
    if (typeof p !== "string") throw errors.invalidPath("缺少 path 参数");
    const base = (req.query.base ?? "HEAD") as "HEAD" | "INDEX";
    const head = (req.query.head ?? "WORKTREE") as "INDEX" | "WORKTREE";
    if (base !== "HEAD" && base !== "INDEX") throw errors.invalidRef("base");
    if (head !== "INDEX" && head !== "WORKTREE") throw errors.invalidRef("head");
    return await getDiff(ws.path, p, base, head);
  });

  // ─── Remotes ───

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/git/remotes",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await ensureRepo(ws.path);
      const remotes = await listRemotes(ws.path);
      return { remotes };
    }
  );

  app.post<{
    Params: { id: string };
    Body: { name?: string; url?: string };
  }>("/api/workspaces/:id/git/remotes", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    const name = req.body?.name;
    const url = req.body?.url;
    if (typeof name !== "string") throw errors.invalidPath("缺少 name");
    if (typeof url !== "string") throw errors.invalidPath("缺少 url");
    await addRemote(ws.path, name, url);
    return { ok: true };
  });

  app.delete<{ Params: { id: string; name: string } }>(
    "/api/workspaces/:id/git/remotes/:name",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await ensureRepo(ws.path);
      await removeRemote(ws.path, req.params.name);
      return { ok: true };
    }
  );

  // ─── Log ───

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; ref?: string };
  }>("/api/workspaces/:id/git/log", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    if (!(await isRepo(ws.path))) return { commits: [], head: null };
    const limit = Math.min(
      1000,
      Math.max(1, Number.parseInt(req.query.limit ?? "200", 10) || 200)
    );
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? "0", 10) || 0);
    const ref = req.query.ref && req.query.ref.length > 0 ? req.query.ref : "HEAD";
    return await getLog(ws.path, limit, offset, ref);
  });
}
