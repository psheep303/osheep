import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { config } from "./config.js";
import { errors } from "./errors.js";

export interface WorkspaceInfo {
  id: string;
  name: string;
  path: string;
}

const WORKSPACE_ID_RE = /^[a-zA-Z0-9._-]{1,64}$/;
const EXTERNAL_WORKSPACES_FILE = ".osheep-workspaces.json";

interface ExternalWorkspaceRecord {
  id: string;
  name: string;
  path: string;
}

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
  const external = await readExternalWorkspaces();
  return [...out, ...external].sort((a, b) => a.name.localeCompare(b.name));
}

export async function resolveWorkspace(id: string): Promise<WorkspaceInfo> {
  if (!isValidWorkspaceId(id)) throw errors.workspaceNotFound(id);
  const external = await readExternalWorkspaces();
  const registered = external.find((workspace) => workspace.id === id);
  if (registered) {
    try {
      const stat = await fs.stat(registered.path);
      if (stat.isDirectory()) return registered;
    } catch {
      // Treat removed external folders as unavailable.
    }
    throw errors.workspaceNotFound(id);
  }
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

export async function registerExternalWorkspace(rawPath: string): Promise<WorkspaceInfo> {
  if (!path.isAbsolute(rawPath)) throw errors.invalidPath("工作区必须是绝对路径");
  const abs = path.resolve(rawPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw errors.workspaceNotFound(abs);
  }
  if (!stat.isDirectory()) throw errors.workspaceNotFound(abs);

  const realPath = await fs.realpath(abs);
  const existing = await readExternalWorkspaces();
  const found = existing.find((workspace) => workspace.path.toLowerCase() === realPath.toLowerCase());
  if (found) return found;

  const id = `external-${createHash("sha256").update(realPath.toLowerCase()).digest("hex").slice(0, 16)}`;
  const record: ExternalWorkspaceRecord = {
    id,
    name: path.basename(realPath) || realPath,
    path: realPath,
  };
  await writeExternalWorkspaces([...existing, record]);
  return record;
}

async function readExternalWorkspaces(): Promise<ExternalWorkspaceRecord[]> {
  const filePath = path.join(config.workspacesRoot, EXTERNAL_WORKSPACES_FILE);
  try {
    const parsed = JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(isExternalWorkspaceRecord);
  } catch {
    return [];
  }
}

async function writeExternalWorkspaces(records: ExternalWorkspaceRecord[]): Promise<void> {
  await ensureWorkspacesRoot();
  const filePath = path.join(config.workspacesRoot, EXTERNAL_WORKSPACES_FILE);
  await fs.writeFile(filePath, JSON.stringify(records, null, 2), "utf8");
}

function isExternalWorkspaceRecord(value: unknown): value is ExternalWorkspaceRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Partial<ExternalWorkspaceRecord>;
  return (
    typeof record.id === "string" &&
    isValidWorkspaceId(record.id) &&
    record.id.startsWith("external-") &&
    typeof record.name === "string" &&
    typeof record.path === "string" &&
    path.isAbsolute(record.path)
  );
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
