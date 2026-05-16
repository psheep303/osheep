import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import { errors } from "./errors.js";
import { resolveWorkspacePath } from "./workspace.js";

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".vite",
  ".cache",
]);

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  mtime?: number;
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

function joinPosix(parent: string, name: string): string {
  if (!parent) return name;
  return parent + "/" + name;
}

export async function listTree(
  workspaceRoot: string,
  relPath: string,
  includeHidden: boolean
): Promise<FsEntry[]> {
  const abs = resolveWorkspacePath(workspaceRoot, relPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw errors.notFound();
  }
  if (!stat.isDirectory()) throw errors.notDirectory();

  const entries = await fs.readdir(abs, { withFileTypes: true });
  const out: FsEntry[] = [];
  for (const e of entries) {
    const isDir = e.isDirectory();
    if (!includeHidden && isDir && IGNORED_DIRS.has(e.name)) continue;
    const childRel = toPosix(joinPosix(relPath, e.name));
    const entry: FsEntry = {
      name: e.name,
      path: childRel,
      kind: isDir ? "directory" : "file",
    };
    if (!isDir) {
      try {
        const s = await fs.stat(path.join(abs, e.name));
        entry.size = s.size;
        entry.mtime = s.mtimeMs;
      } catch {
        /* ignore lstat failures */
      }
    }
    out.push(entry);
  }
  out.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return out;
}

export async function readFileText(
  workspaceRoot: string,
  relPath: string
): Promise<{
  path: string;
  content: string;
  encoding: "utf-8";
  size: number;
  mtime: number;
}> {
  const abs = resolveWorkspacePath(workspaceRoot, relPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw errors.notFound();
  }
  if (stat.isDirectory()) throw errors.isDirectory();
  if (stat.size > config.maxFileSizeBytes) {
    throw errors.fileTooLarge(config.maxFileSizeBytes);
  }
  const content = await fs.readFile(abs, "utf-8");
  return {
    path: toPosix(relPath),
    content,
    encoding: "utf-8",
    size: stat.size,
    mtime: stat.mtimeMs,
  };
}

export async function writeFileText(
  workspaceRoot: string,
  relPath: string,
  content: string,
  createParents: boolean
): Promise<{ path: string; size: number; mtime: number }> {
  if (typeof content !== "string") throw errors.invalidPath("content 必须为字符串");
  const bytes = Buffer.byteLength(content, "utf-8");
  if (bytes > config.maxFileSizeBytes) {
    throw errors.fileTooLarge(config.maxFileSizeBytes);
  }
  const abs = resolveWorkspacePath(workspaceRoot, relPath);

  const parent = path.dirname(abs);
  if (createParents) {
    await fs.mkdir(parent, { recursive: true });
  } else {
    try {
      const ps = await fs.stat(parent);
      if (!ps.isDirectory()) throw errors.parentNotFound();
    } catch {
      throw errors.parentNotFound();
    }
  }

  // Atomic-ish replace: write tmp then rename
  const tmp =
    abs + ".osheep.tmp." + Date.now() + "." + Math.random().toString(36).slice(2);
  await fs.writeFile(tmp, content, "utf-8");
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw errors.ioError((e as Error).message);
  }
  const stat = await fs.stat(abs);
  return { path: toPosix(relPath), size: stat.size, mtime: stat.mtimeMs };
}

export async function createEntry(
  workspaceRoot: string,
  relPath: string,
  kind: "file" | "directory"
): Promise<{ path: string; kind: "file" | "directory" }> {
  const abs = resolveWorkspacePath(workspaceRoot, relPath);
  const parent = path.dirname(abs);
  try {
    const ps = await fs.stat(parent);
    if (!ps.isDirectory()) throw errors.parentNotFound();
  } catch {
    throw errors.parentNotFound();
  }
  try {
    await fs.access(abs);
    throw errors.entryExists();
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      // good — does not exist
    } else if ((e as { statusCode?: number }).statusCode === 409) {
      throw e;
    }
  }
  if (kind === "directory") {
    await fs.mkdir(abs);
  } else {
    const h = await fs.open(abs, "wx");
    await h.close();
  }
  return { path: toPosix(relPath), kind };
}

export async function moveEntry(
  workspaceRoot: string,
  fromRel: string,
  toRel: string
): Promise<{ from: string; to: string }> {
  const fromAbs = resolveWorkspacePath(workspaceRoot, fromRel);
  const toAbs = resolveWorkspacePath(workspaceRoot, toRel);
  try {
    await fs.stat(fromAbs);
  } catch {
    throw errors.notFound();
  }
  try {
    await fs.access(toAbs);
    throw errors.entryExists();
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      // good
    } else if ((e as { statusCode?: number }).statusCode === 409) {
      throw e;
    }
  }
  const parent = path.dirname(toAbs);
  await fs.mkdir(parent, { recursive: true });
  await fs.rename(fromAbs, toAbs);
  return { from: toPosix(fromRel), to: toPosix(toRel) };
}

export async function copyEntry(
  workspaceRoot: string,
  fromRel: string,
  toRel: string
): Promise<{ from: string; to: string }> {
  const fromAbs = resolveWorkspacePath(workspaceRoot, fromRel);
  const toAbs = resolveWorkspacePath(workspaceRoot, toRel);
  let st;
  try {
    st = await fs.stat(fromAbs);
  } catch {
    throw errors.notFound();
  }
  try {
    await fs.access(toAbs);
    throw errors.entryExists();
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === "ENOENT") {
      // good
    } else if ((e as { statusCode?: number }).statusCode === 409) {
      throw e;
    }
  }
  await fs.mkdir(path.dirname(toAbs), { recursive: true });
  if (st.isDirectory()) {
    await fs.cp(fromAbs, toAbs, { recursive: true });
  } else {
    await fs.copyFile(fromAbs, toAbs);
  }
  return { from: toPosix(fromRel), to: toPosix(toRel) };
}

export async function deleteEntry(
  workspaceRoot: string,
  relPath: string,
  recursive: boolean
): Promise<{ path: string }> {
  const abs = resolveWorkspacePath(workspaceRoot, relPath);
  if (abs === path.resolve(workspaceRoot)) {
    throw errors.invalidPath("不能删除工作区根");
  }
  let st;
  try {
    st = await fs.stat(abs);
  } catch {
    throw errors.notFound();
  }
  if (st.isDirectory()) {
    if (!recursive) {
      const kids = await fs.readdir(abs);
      if (kids.length > 0) throw errors.dirNotEmpty();
      await fs.rmdir(abs);
    } else {
      await fs.rm(abs, { recursive: true, force: false });
    }
  } else {
    await fs.unlink(abs);
  }
  return { path: toPosix(relPath) };
}
