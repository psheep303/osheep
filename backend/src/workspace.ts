import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import { errors } from "./errors.js";

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
}

const WORKSPACE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;

function isValidWorkspaceId(name: string): boolean {
  return Boolean(name) && !name.startsWith(".") && WORKSPACE_ID_RE.test(name);
}

export async function ensureWorkspacesRoot(): Promise<void> {
  await fs.mkdir(config.workspacesRoot, { recursive: true });
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  await ensureWorkspacesRoot();
  const entries = await fs.readdir(config.workspacesRoot, { withFileTypes: true });
  return entries
    .filter((entry) => entry.isDirectory() && isValidWorkspaceId(entry.name))
    .map((entry) => ({
      id: entry.name,
      name: entry.name,
      path: path.join(config.workspacesRoot, entry.name),
    }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

export async function resolveWorkspace(id: string): Promise<WorkspaceInfo> {
  if (!isValidWorkspaceId(id)) throw errors.workspaceNotFound(id);
  const workspacePath = path.join(config.workspacesRoot, id);
  try {
    if (!(await fs.stat(workspacePath)).isDirectory()) {
      throw errors.workspaceNotFound(id);
    }
  } catch (error) {
    if (error instanceof Error && "statusCode" in error) throw error;
    throw errors.workspaceNotFound(id);
  }
  return { id, name: id, path: workspacePath };
}

export async function setWorkspacesRoot(rawPath: string): Promise<string> {
  if (!path.isAbsolute(rawPath)) {
    throw errors.invalidPath("workspaces 根目录必须是绝对路径");
  }
  const candidate = path.resolve(rawPath);
  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(candidate);
  } catch {
    throw errors.invalidPath("workspaces 根目录不存在");
  }
  if (!stat.isDirectory()) throw errors.invalidPath("workspaces 根目录不是目录");

  config.workspacesRoot = await fs.realpath(candidate);
  await ensureWorkspacesRoot();
  if (config.workspaceRootConfigFile) {
    await fs.mkdir(path.dirname(config.workspaceRootConfigFile), { recursive: true });
    await fs.writeFile(
      config.workspaceRootConfigFile,
      JSON.stringify({ root: config.workspacesRoot }, null, 2),
      "utf8",
    );
  }
  return config.workspacesRoot;
}

export async function createWorkspace(name: string): Promise<WorkspaceInfo> {
  const id = name.trim();
  if (!isValidWorkspaceId(id)) {
    throw errors.invalidPath("工作区名称只能包含字母、数字、点、下划线和短横线");
  }
  await ensureWorkspacesRoot();
  const workspacePath = path.join(config.workspacesRoot, id);
  try {
    await fs.mkdir(workspacePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw errors.entryExists();
    }
    throw error;
  }
  await ensureOsheepLayout(workspacePath);
  return { id, name: id, path: workspacePath };
}

/** Resolve a workspace-relative path without allowing it to escape the root. */
export function resolveWorkspacePath(workspaceRoot: string, rel: string): string {
  if (rel === undefined || rel === null || typeof rel !== "string") {
    throw errors.invalidPath();
  }
  if (rel.includes("\0")) throw errors.invalidPath("路径包含 NUL");

  const unified = rel.replace(/\\/g, "/").trim();
  if (unified === "" || unified === ".") return workspaceRoot;
  if (unified.startsWith("/")) throw errors.invalidPath("不允许绝对路径");
  if (/^[a-zA-Z]:/.test(unified)) throw errors.invalidPath("不允许盘符路径");

  const segments = unified.split("/").filter(Boolean);
  for (const segment of segments) {
    if (segment === "..") throw errors.pathOutside();
    if (segment === "." || segment.includes("\0")) continue;
  }

  const joined = path.resolve(workspaceRoot, ...segments);
  const rootResolved = path.resolve(workspaceRoot);
  const rootWithSep = rootResolved.endsWith(path.sep) ? rootResolved : rootResolved + path.sep;
  if (joined !== rootResolved && !joined.startsWith(rootWithSep)) {
    throw errors.pathOutside();
  }
  return joined;
}

export async function ensureOsheepLayout(workspaceRoot: string): Promise<void> {
  const osheepRoot = path.join(workspaceRoot, ".osheep");
  await fs.mkdir(path.join(osheepRoot, "docs"), { recursive: true });
  const settingsPath = path.join(osheepRoot, "settings.json");
  try {
    await fs.access(settingsPath);
  } catch {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ editor: { fontSize: 14, tabSize: 2 } }, null, 2),
      "utf8",
    );
  }
}
