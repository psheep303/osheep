import { DEFAULT_SETTINGS, mergeSettings, type OsheepSettings } from "./settings";

export interface FsNode {
  name: string;
  path: string;
  kind: "file" | "directory";
  handle: FileSystemHandle;
}

const IGNORED_DIRS = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  ".next",
  ".vite",
  ".cache",
]);

export async function pickRootDirectory(): Promise<FileSystemDirectoryHandle> {
  if (!("showDirectoryPicker" in window)) {
    throw new Error(
      "当前浏览器不支持 File System Access API，请使用 Chrome / Edge 等 Chromium 内核浏览器"
    );
  }
  return await (
    window as unknown as {
      showDirectoryPicker: (opts?: {
        mode?: "read" | "readwrite";
      }) => Promise<FileSystemDirectoryHandle>;
    }
  ).showDirectoryPicker({ mode: "readwrite" });
}

export async function readDirShallow(
  dirHandle: FileSystemDirectoryHandle,
  basePath: string
): Promise<FsNode[]> {
  const nodes: FsNode[] = [];
  // @ts-expect-error iterator is part of the FS Access API
  for await (const [name, handle] of dirHandle.entries()) {
    if (handle.kind === "directory" && IGNORED_DIRS.has(name)) continue;
    nodes.push({
      name,
      path: basePath ? `${basePath}/${name}` : name,
      kind: handle.kind,
      handle,
    });
  }
  nodes.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return nodes;
}

export async function readFileText(
  fileHandle: FileSystemFileHandle
): Promise<string> {
  const file = await fileHandle.getFile();
  return await file.text();
}

export async function writeFileText(
  fileHandle: FileSystemFileHandle,
  content: string
): Promise<void> {
  const writable = await fileHandle.createWritable();
  await writable.write(content);
  await writable.close();
}

export async function ensurePermission(
  handle: FileSystemHandle,
  mode: "read" | "readwrite" = "readwrite"
): Promise<boolean> {
  const anyHandle = handle as unknown as {
    queryPermission: (opts: { mode: string }) => Promise<PermissionState>;
    requestPermission: (opts: { mode: string }) => Promise<PermissionState>;
  };
  if ((await anyHandle.queryPermission({ mode })) === "granted") return true;
  return (await anyHandle.requestPermission({ mode })) === "granted";
}

export async function createFile(
  dirHandle: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemFileHandle> {
  return await dirHandle.getFileHandle(name, { create: true });
}

export async function createDirectory(
  dirHandle: FileSystemDirectoryHandle,
  name: string
): Promise<FileSystemDirectoryHandle> {
  return await dirHandle.getDirectoryHandle(name, { create: true });
}

export async function removeEntry(
  parent: FileSystemDirectoryHandle,
  name: string,
  recursive = true
): Promise<void> {
  await parent.removeEntry(name, { recursive });
}

export async function renameEntry(
  parent: FileSystemDirectoryHandle,
  oldHandle: FileSystemHandle,
  oldName: string,
  newName: string
): Promise<void> {
  if (!newName || newName === oldName) return;
  const anyH = oldHandle as unknown as {
    move?: (n: string) => Promise<void>;
  };
  if (typeof anyH.move === "function") {
    await anyH.move(newName);
    return;
  }
  if (oldHandle.kind !== "file") {
    throw new Error("当前浏览器不支持重命名文件夹，请升级到最新版 Chrome / Edge");
  }
  const fileHandle = oldHandle as FileSystemFileHandle;
  const text = await (await fileHandle.getFile()).text();
  const next = await parent.getFileHandle(newName, { create: true });
  const w = await next.createWritable();
  await w.write(text);
  await w.close();
  await parent.removeEntry(oldName);
}

export async function findFreeName(
  dir: FileSystemDirectoryHandle,
  base: string,
  kind: "file" | "directory"
): Promise<string> {
  const exists = async (name: string): Promise<boolean> => {
    try {
      if (kind === "file") await dir.getFileHandle(name);
      else await dir.getDirectoryHandle(name);
      return true;
    } catch {
      return false;
    }
  };
  if (!(await exists(base))) return base;
  const dot = kind === "file" ? base.lastIndexOf(".") : -1;
  const stem = dot > 0 ? base.slice(0, dot) : base;
  const ext = dot > 0 ? base.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${stem} 副本${ext}` : `${stem} 副本 ${i}${ext}`;
    if (!(await exists(candidate))) return candidate;
  }
  return `${stem} 副本 ${Date.now()}${ext}`;
}

export async function copyHandleInto(
  src: FileSystemHandle,
  destDir: FileSystemDirectoryHandle,
  destName: string
): Promise<void> {
  if (src.kind === "file") {
    const file = await (src as FileSystemFileHandle).getFile();
    const buf = await file.arrayBuffer();
    const target = await destDir.getFileHandle(destName, { create: true });
    const w = await target.createWritable();
    await w.write(buf);
    await w.close();
    return;
  }
  const srcDir = src as FileSystemDirectoryHandle;
  const targetDir = await destDir.getDirectoryHandle(destName, { create: true });
  // @ts-expect-error iterator is part of the FS Access API
  for await (const [name, child] of srcDir.entries()) {
    await copyHandleInto(child, targetDir, name);
  }
}

export async function moveHandleInto(
  src: FileSystemHandle,
  srcParent: FileSystemDirectoryHandle,
  srcName: string,
  destDir: FileSystemDirectoryHandle,
  destName: string
): Promise<void> {
  const anyH = src as unknown as {
    move?: (
      dest: FileSystemDirectoryHandle | string,
      name?: string
    ) => Promise<void>;
  };
  if (typeof anyH.move === "function") {
    try {
      await anyH.move(destDir, destName);
      return;
    } catch {
      // fall through to copy + delete
    }
  }
  await copyHandleInto(src, destDir, destName);
  await srcParent.removeEntry(srcName, { recursive: true });
}

export async function loadOsheepSettings(
  root: FileSystemDirectoryHandle
): Promise<OsheepSettings> {
  const osheep = await root.getDirectoryHandle(".osheep", { create: true });
  // Ensure docs/ subdir exists for project documentation
  await osheep.getDirectoryHandle("docs", { create: true });
  let handle: FileSystemFileHandle;
  try {
    handle = await osheep.getFileHandle("settings.json");
  } catch {
    handle = await osheep.getFileHandle("settings.json", { create: true });
    await writeJson(handle, DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
  const text = (await (await handle.getFile()).text()).trim();
  if (!text) {
    await writeJson(handle, DEFAULT_SETTINGS);
    return DEFAULT_SETTINGS;
  }
  try {
    return mergeSettings(JSON.parse(text));
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveOsheepSettings(
  root: FileSystemDirectoryHandle,
  s: OsheepSettings
): Promise<void> {
  const osheep = await root.getDirectoryHandle(".osheep", { create: true });
  const handle = await osheep.getFileHandle("settings.json", { create: true });
  await writeJson(handle, s);
}

async function writeJson(
  handle: FileSystemFileHandle,
  obj: unknown
): Promise<void> {
  const w = await handle.createWritable();
  await w.write(JSON.stringify(obj, null, 2));
  await w.close();
}
