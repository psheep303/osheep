import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { FastifyInstance } from "fastify";
import { readAppSettings, updateAppSettings } from "../app-settings.js";
import { config } from "../config.js";
import { errors } from "../errors.js";
import {
  copyEntry,
  copyExternalEntry,
  createEntry,
  deleteEntry,
  listTree,
  moveEntry,
  readFileBinary,
  readFileText,
  writeFileBase64,
  writeFileText,
} from "../fs-ops.js";
import { syncLiteLlmModelPrices } from "../model-pricing.js";
import {
  createWorkspace,
  ensureOsheepLayout,
  listWorkspaces,
  markWorkspaceOpened,
  resolveWorkspace,
  setWorkspacesRoot,
} from "../workspace.js";

export async function registerWorkspaceRoutes(app: FastifyInstance) {
  app.get("/api/settings", async () =>
    readAppSettings({
      ui: { language: "system", theme: "dark" },
      editor: { fontSize: 14, tabSize: 2, autoSave: false },
      ai: { autoAllow: {} },
      workflow: { maxParallelNodes: 4 },
    }),
  );

  app.put<{ Body: unknown }>("/api/settings", async (req) => {
    await updateAppSettings((settings) => {
      if (req.body && typeof req.body === "object" && !Array.isArray(req.body)) {
        Object.assign(settings, req.body as Record<string, unknown>);
      }
    });
    return { ok: true };
  });

  app.post("/api/model-prices/sync", async () => {
    const models = await syncLiteLlmModelPrices();
    return { models, source: "litellm", updatedAt: Date.now() };
  });

  app.get("/api/ui-preferences", async () => {
    const settings = await readAppSettings<{ ui?: unknown }>({});
    return settings.ui ?? { language: "system", theme: "dark" };
  });

  app.put<{ Body: unknown }>("/api/ui-preferences", async (req) => {
    await updateAppSettings((settings) => {
      settings.ui = req.body;
    });
    return { ok: true };
  });

  app.get("/api/dismissed-confirmations", async () => {
    const settings = await readAppSettings<{ uiState?: { dismissedConfirmations?: unknown } }>({});
    const values = settings.uiState?.dismissedConfirmations;
    return {
      values: Array.isArray(values)
        ? values.filter((value): value is string => typeof value === "string")
        : [],
    };
  });

  app.put<{ Body: { values?: unknown } }>("/api/dismissed-confirmations", async (req) => {
    const values = Array.isArray(req.body?.values)
      ? [
          ...new Set(
            req.body.values
              .filter((value): value is string => typeof value === "string")
              .map((value) => value.trim())
              .filter(Boolean),
          ),
        ].slice(0, 200)
      : [];
    await updateAppSettings((settings) => {
      const current =
        settings.uiState && typeof settings.uiState === "object" && !Array.isArray(settings.uiState)
          ? (settings.uiState as Record<string, unknown>)
          : {};
      settings.uiState = { ...current, dismissedConfirmations: values };
    });
    return { ok: true };
  });

  app.get("/api/workspaces", async () => {
    const list = await listWorkspaces();
    return { workspaces: list.map(({ id, name }) => ({ id, name })) };
  });

  app.get("/api/workspaces/root", async () => {
    return { path: config.workspacesRoot };
  });

  app.post<{ Body: { path?: string } }>("/api/workspaces/root", async (req) => {
    if (!config.allowExternalWorkspacePaths) {
      throw errors.invalidPath("当前服务未启用外部工作区");
    }
    if (typeof req.body?.path !== "string" || !req.body.path.trim()) {
      throw errors.invalidPath("缺少工作区路径");
    }
    return { path: await setWorkspacesRoot(req.body.path.trim()) };
  });

  app.post<{ Body: { name?: string } }>("/api/workspaces", async (req) => {
    if (typeof req.body?.name !== "string" || !req.body.name.trim()) {
      throw errors.invalidPath("缺少工作区名称");
    }
    const workspace = await createWorkspace(req.body.name);
    return { id: workspace.id, name: workspace.name };
  });

  app.get<{ Params: { id: string } }>("/api/workspaces/:id", async (req) => {
    const ws = await markWorkspaceOpened(req.params.id);
    await ensureOsheepLayout(ws.path);
    return { id: ws.id, name: ws.name };
  });

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
    if (req.query.path === undefined) throw errors.invalidPath("缺少 path 参数");
    return await readFileText(ws.path, req.query.path);
  });

  app.post<{
    Params: { id: string };
    Body: { path?: string };
  }>("/api/workspaces/:id/fs/external", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const externalPath = req.body?.path;
    if (typeof externalPath !== "string" || !externalPath.trim()) {
      throw errors.invalidPath("缺少外部文件路径");
    }
    const candidate = path.resolve(externalPath);
    const relative = path.relative(ws.path, candidate);
    if (
      relative === "" ||
      relative.startsWith(`..${path.sep}`) ||
      relative === ".." ||
      path.isAbsolute(relative)
    ) {
      throw errors.invalidPath("只能打开当前工作区内的文件");
    }
    await readFileText(ws.path, relative);
    return { path: relative.replace(/\\/g, "/") };
  });

  app.post<{
    Params: { id: string };
    Body: { path?: string };
  }>("/api/workspaces/:id/fs/external-read", async (req) => {
    await resolveWorkspace(req.params.id);
    const externalPath = req.body?.path;
    if (typeof externalPath !== "string" || !path.isAbsolute(externalPath)) {
      throw errors.invalidPath("外部文件路径必须是绝对路径");
    }
    const absolute = path.resolve(externalPath);
    const stat = await fs.stat(absolute).catch(() => null);
    if (!stat?.isFile()) throw errors.notFound();
    if (stat.size > config.maxFileSizeBytes) throw errors.fileTooLarge(config.maxFileSizeBytes);
    const bytes = await fs.readFile(absolute);
    const extension = path.extname(absolute).slice(1).toLowerCase();
    const image = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp", "ico"]).has(
      extension,
    );
    if (!image && bytes.includes(0)) throw errors.invalidPath("二进制文件无法直接预览");
    return {
      name: path.basename(absolute),
      content: image ? undefined : new TextDecoder("utf-8").decode(bytes),
      contentBase64: image ? bytes.toString("base64") : undefined,
      mime: image
        ? ((
            {
              png: "image/png",
              jpg: "image/jpeg",
              jpeg: "image/jpeg",
              gif: "image/gif",
              webp: "image/webp",
              svg: "image/svg+xml",
              avif: "image/avif",
              bmp: "image/bmp",
              ico: "image/x-icon",
            } as Record<string, string>
          )[extension] ?? "application/octet-stream")
        : undefined,
    };
  });

  app.get<{
    Params: { id: string };
    Querystring: { path?: string };
  }>("/api/workspaces/:id/fs/image", async (req, reply) => {
    const ws = await resolveWorkspace(req.params.id);
    if (req.query.path === undefined) throw errors.invalidPath("缺少 path 参数");
    const file = await readFileBinary(ws.path, req.query.path);
    const ext = req.query.path.toLowerCase().match(/\.([a-z0-9]+)$/)?.[1] ?? "";
    const mime =
      (
        {
          png: "image/png",
          jpg: "image/jpeg",
          jpeg: "image/jpeg",
          gif: "image/gif",
          webp: "image/webp",
          svg: "image/svg+xml",
          avif: "image/avif",
          bmp: "image/bmp",
          ico: "image/x-icon",
        } as Record<string, string>
      )[ext] ?? "application/octet-stream";
    return reply.type(mime).header("cache-control", "no-cache").send(file.content);
  });

  app.put<{
    Params: { id: string };
    Body: { path?: string; content?: string; contentBase64?: string; createParents?: boolean };
  }>("/api/workspaces/:id/fs/file", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body ?? {};
    if (typeof body.path !== "string") throw errors.invalidPath("缺少 path");
    if (typeof body.contentBase64 === "string") {
      return await writeFileBase64(
        ws.path,
        body.path,
        body.contentBase64,
        body.createParents !== false,
      );
    }
    if (typeof body.content !== "string") throw errors.invalidPath("缺少 content");
    return await writeFileText(ws.path, body.path, body.content, body.createParents !== false);
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

  app.post<{
    Params: { id: string };
    Body: { sourcePath?: string; targetPath?: string };
  }>("/api/workspaces/:id/fs/copy-external", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body ?? {};
    if (typeof body.sourcePath !== "string" || typeof body.targetPath !== "string") {
      throw errors.invalidPath("缺少外部源路径或目标路径");
    }
    return await copyExternalEntry(ws.path, body.sourcePath, body.targetPath);
  });

  app.delete<{
    Params: { id: string };
    Querystring: { path?: string; recursive?: string };
  }>("/api/workspaces/:id/fs/entry", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    if (req.query.path === undefined) throw errors.invalidPath("缺少 path 参数");
    const recursive = req.query.recursive === "true";
    return await deleteEntry(ws.path, req.query.path, recursive);
  });

  // ─── Settings convenience ───

  app.get<{ Params: { id: string } }>("/api/workspaces/:id/settings", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    await ensureOsheepLayout(ws.path);
    const { content } = await readFileText(ws.path, ".osheep/settings.json");
    try {
      return JSON.parse(content);
    } catch {
      return { editor: { fontSize: 14, tabSize: 2 } };
    }
  });

  app.put<{ Params: { id: string }; Body: unknown }>(
    "/api/workspaces/:id/settings",
    async (req) => {
      const ws = await resolveWorkspace(req.params.id);
      await ensureOsheepLayout(ws.path);
      const text = JSON.stringify(req.body, null, 2);
      await writeFileText(ws.path, ".osheep/settings.json", text, true);
      return { ok: true };
    },
  );
}
