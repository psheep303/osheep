import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";
import {
  addRemote,
  checkoutBranch,
  commit,
  discardPaths,
  fetchRemote,
  getCommitDetails,
  getCommitDiff,
  getDiff,
  getLog,
  getRepoInfo,
  getStatus,
  gitInit,
  isRepo,
  listBranches,
  listRemotes,
  pullCurrent,
  pushCurrent,
  removeRemote,
  stagePaths,
  unstagePaths,
} from "../git-ops.js";
import { resolveWorkspace } from "../workspace.js";

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
  app.get<{ Params: { id: string } }>("/api/workspaces/:id/git/repo", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    return await getRepoInfo(ws.path);
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/git/status", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    return await getStatus(ws.path);
  });

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
    },
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

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/git/remotes", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    const remotes = await listRemotes(ws.path);
    return { remotes };
  });

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
    },
  );

  // ─── Branches ───

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/git/branches", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    return await listBranches(ws.path);
  });

  app.post<{
    Params: { id: string };
    Body: { ref?: string; create?: boolean; fromRef?: string | null };
  }>("/api/workspaces/:id/git/checkout", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    const ref = req.body?.ref;
    if (typeof ref !== "string" || !ref) throw errors.invalidRef("缺少 ref");
    await checkoutBranch(ws.path, ref, {
      create: !!req.body?.create,
      fromRef: req.body?.fromRef ?? null,
    });
    return { ok: true, branch: ref };
  });

  // ─── Fetch / Pull / Push ───

  app.post<{
    Params: { id: string };
    Body: { remote?: string | null; prune?: boolean };
  }>("/api/workspaces/:id/git/fetch", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    await fetchRemote(ws.path, req.body?.remote ?? null, !!req.body?.prune);
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: { remote?: string | null; branch?: string | null; ffOnly?: boolean };
  }>("/api/workspaces/:id/git/pull", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    await pullCurrent(ws.path, {
      remote: req.body?.remote ?? null,
      branch: req.body?.branch ?? null,
      ffOnly: req.body?.ffOnly !== false,
    });
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: {
      remote?: string | null;
      branch?: string | null;
      setUpstream?: boolean;
      force?: boolean;
    };
  }>("/api/workspaces/:id/git/push", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    await pushCurrent(ws.path, {
      remote: req.body?.remote ?? null,
      branch: req.body?.branch ?? null,
      setUpstream: !!req.body?.setUpstream,
      force: !!req.body?.force,
    });
    return { ok: true };
  });

  // ─── Log ───

  app.get<{
    Params: { id: string };
    Querystring: { limit?: string; offset?: string; ref?: string };
  }>("/api/workspaces/:id/git/log", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    if (!(await isRepo(ws.path))) return { commits: [], head: null };
    const limit = Math.min(100_000, Math.max(1, Number.parseInt(req.query.limit ?? "200", 10) || 200));
    const offset = Math.max(0, Number.parseInt(req.query.offset ?? "0", 10) || 0);
    const ref = req.query.ref && req.query.ref.length > 0 ? req.query.ref : "HEAD";
    return await getLog(ws.path, limit, offset, ref);
  });

  app.get<{ Params: { id: string; sha: string } }>(
    "/api/workspaces/:id/git/commits/:sha",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await ensureRepo(ws.path);
      return await getCommitDetails(ws.path, req.params.sha);
    },
  );

  app.get<{
    Params: { id: string; sha: string };
    Querystring: { path?: string };
  }>("/api/workspaces/:id/git/commits/:sha/diff", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureRepo(ws.path);
    if (typeof req.query.path !== "string") throw errors.invalidPath("缺少 path 参数");
    return await getCommitDiff(ws.path, req.params.sha, req.query.path);
  });
}
