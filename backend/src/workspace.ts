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
  if (!name) return false;
  if (name.startsWith(".")) return false;
  return WORKSPACE_ID_RE.test(name);
}

export async function ensureWorkspacesRoot(): Promise<void> {
  await fs.mkdir(config.workspacesRoot, { recursive: true });
}

export async function listWorkspaces(): Promise<WorkspaceInfo[]> {
  await ensureWorkspacesRoot();
  const entries = await fs.readdir(config.workspacesRoot, {
    withFileTypes: true,
  });
  const out: WorkspaceInfo[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!isValidWorkspaceId(e.name)) continue;
    out.push({
      id: e.name,
      name: e.name,
      path: path.join(config.workspacesRoot, e.name),
    });
  }
  out.sort((a, b) => a.id.localeCompare(b.id));
  return out;
}

export async function resolveWorkspace(id: string): Promise<WorkspaceInfo> {
  if (!isValidWorkspaceId(id)) throw errors.workspaceNotFound(id);
  const abs = path.join(config.workspacesRoot, id);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw errors.workspaceNotFound(id);
  }
  if (!stat.isDirectory()) throw errors.workspaceNotFound(id);
  return { id, name: id, path: abs };
}

/**
 * Resolve a workspace-relative POSIX-style path to an absolute filesystem
 * path, refusing anything that would escape the workspace root.
 *
 * Acceptable input: "", "src", "src/main.ts", "src/sub/dir"
 * Rejected: "/abs", "C:\\x", "..", "src/../../etc", paths with NUL byte
 */
export function resolveWorkspacePath(
  workspaceRoot: string,
  rel: string
): string {
  if (rel === undefined || rel === null) throw errors.invalidPath();
  if (typeof rel !== "string") throw errors.invalidPath();
  if (rel.includes("\0")) throw errors.invalidPath("路径含 NUL");

  // Normalize separators to POSIX style for validation
  const unified = rel.replace(/\\/g, "/").trim();
  if (unified === "" || unified === ".") return workspaceRoot;

  // Reject absolute paths in any form
  if (unified.startsWith("/")) throw errors.invalidPath("不允许绝对路径");
  if (/^[a-zA-Z]:/.test(unified)) throw errors.invalidPath("不允许盘符");

  // Reject explicit `..` segments
  const segments = unified.split("/").filter((s) => s !== "");
  for (const seg of segments) {
    if (seg === "..") throw errors.pathOutside();
    if (seg === ".") continue;
    if (seg.includes("\0")) throw errors.invalidPath("路径含 NUL");
  }

  const joined = path.resolve(workspaceRoot, ...segments);
  const rootResolved = path.resolve(workspaceRoot);

  // On case-insensitive filesystems (Windows / macOS default), compare
  // case-insensitively. We still go through path.resolve so symlinks at
  // the workspace root are not followed beyond it.
  const sep = path.sep;
  const rootWithSep = rootResolved.endsWith(sep)
    ? rootResolved
    : rootResolved + sep;
  if (joined !== rootResolved && !joined.startsWith(rootWithSep)) {
    throw errors.pathOutside();
  }
  return joined;
}

/**
 * Ensure the workspace's `.osheep/` skeleton exists. Idempotent.
 */
export async function ensureOsheepLayout(workspaceRoot: string): Promise<void> {
  const oshroot = path.join(workspaceRoot, ".osheep");
  await fs.mkdir(oshroot, { recursive: true });
  await fs.mkdir(path.join(oshroot, "docs"), { recursive: true });
  await fs.mkdir(path.join(oshroot, "plan"), { recursive: true });
  const settingsPath = path.join(oshroot, "settings.json");
  try {
    await fs.access(settingsPath);
  } catch {
    await fs.writeFile(
      settingsPath,
      JSON.stringify({ editor: { fontSize: 14, tabSize: 2 } }, null, 2),
      "utf-8"
    );
  }
}
