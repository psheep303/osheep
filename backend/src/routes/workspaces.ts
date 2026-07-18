import type { FastifyInstance } from "fastify";
import {
  ensureOsheepLayout,
  listWorkspaces,
  registerExternalWorkspace,
  resolveWorkspace,
} from "../workspace.js";
import {
  copyEntry,
  createEntry,
  deleteEntry,
  listTree,
  moveEntry,
  readFileText,
  writeFileText,
} from "../fs-ops.js";
import { errors } from "../errors.js";
import { config } from "../config.js";

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.get("/api/workspaces", async () => {
    const list = await listWorkspaces();
    return { workspaces: list.map(({ id, name }) => ({ id, name })) };
  });

  app.post<{ Body: { path?: string } }>("/api/workspaces/open", async (req) => {
    if (!config.allowExternalWorkspacePaths) {
      throw errors.invalidPath("当前服务未启用外部工作区");
    }
    if (typeof req.body?.path !== "string" || !req.body.path.trim()) {
      throw errors.invalidPath("缺少工作区路径");
    }
    const workspace = await registerExternalWorkspace(req.body.path.trim());
    await ensureOsheepLayout(workspace.path);
    return { id: workspace.id, name: workspace.name };
  });

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await ensureOsheepLayout(ws.path);
      return { id: ws.id, name: ws.name };
    }
  );

  // ─── File API: /api/workspaces/:id/fs/* ───

  app.get<{
    Params: { id: string };
    Querystring: { path?: string; includeHidden?: string };
  }>("/api/workspaces/:id/fs/tree", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureOsheepLayout(ws.path);
    const includeHidden = req.query.includeHidden === "true";
    const entries = await listTree(ws.path, req.query.path ?? "", includeHidden);
    return { entries };
  });

  app.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>("/api/workspaces/:id/fs/file", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    if (req.query.path === undefined)
      throw errors.invalidPath("缺少 path 参数");
    return await readFileText(ws.path, req.query.path);
  });

  app.put<{
    Params: { id: string };
    Body: { path?: string; content?: string; createParents?: boolean };
  }>("/api/workspaces/:id/fs/file", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body ?? {};
    if (typeof body.path !== "string") throw errors.invalidPath("缺少 path");
    if (typeof body.content !== "string")
      throw errors.invalidPath("缺少 content");
    return await writeFileText(
      ws.path,
      body.path,
      body.content,
      body.createParents !== false
    );
  });

  app.post<{
    Params: { id: string };
    Body: { path?: string; kind?: "file" | "directory" };
  }>("/api/workspaces/:id/fs/entry", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body ?? {};
    if (typeof body.path !== "string") throw errors.invalidPath("缺少 path");
    if (body.kind !== "file" && body.kind !== "directory")
      throw errors.invalidPath("kind 必须为 file 或 directory");
    return await createEntry(ws.path, body.path, body.kind);
  });

  app.post<{
    Params: { id: string };
    Body: { from?: string; to?: string };
  }>("/api/workspaces/:id/fs/move", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body ?? {};
    if (typeof body.from !== "string" || typeof body.to !== "string")
      throw errors.invalidPath("缺少 from 或 to");
    return await moveEntry(ws.path, body.from, body.to);
  });

  app.post<{
    Params: { id: string };
    Body: { from?: string; to?: string };
  }>("/api/workspaces/:id/fs/copy", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body ?? {};
    if (typeof body.from !== "string" || typeof body.to !== "string")
      throw errors.invalidPath("缺少 from 或 to");
    return await copyEntry(ws.path, body.from, body.to);
  });

  app.delete<{
    Params: { id: string };
    Querystring: { path?: string; recursive?: string };
  }>("/api/workspaces/:id/fs/entry", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    if (req.query.path === undefined)
      throw errors.invalidPath("缺少 path 参数");
    const recursive = req.query.recursive === "true";
    return await deleteEntry(ws.path, req.query.path, recursive);
  });

  // ─── Settings convenience ───

  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/settings",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await ensureOsheepLayout(ws.path);
      const { content } = await readFileText(
        ws.path,
        ".osheep/settings.json"
      );
      try {
        return JSON.parse(content);
      } catch {
        return { editor: { fontSize: 14, tabSize: 2 } };
      }
    }
  );

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/workspaces/:id/settings",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await ensureOsheepLayout(ws.path);
      const text = JSON.stringify(req.body, null, 2);
      await writeFileText(
        ws.path,
        ".osheep/settings.json",
        text,
        true
      );
      return { ok: true };
    }
  );
}
