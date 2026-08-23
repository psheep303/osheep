// Workspace file-system helpers. These delegate to the backend API.
//
// All paths are workspace-relative POSIX strings ("", "src", "src/main.ts").

import {
  copyEntry as apiCopyEntry,
  copyExternalEntry as apiCopyExternalEntry,
  createEntry as apiCreateEntry,
  deleteEntry as apiDeleteEntry,
  findFreeName as apiFindFreeName,
  getGlobalSettings as apiGetGlobalSettings,
  getSettings as apiGetSettings,
  listTree as apiListTree,
  moveEntry as apiMoveEntry,
  putGlobalSettings as apiPutGlobalSettings,
  putSettings as apiPutSettings,
  readFile as apiReadFile,
  writeFile as apiWriteFile,
  writeFileBase64 as apiWriteFileBase64,
  type FsEntry,
} from "./api";
import { DEFAULT_SETTINGS, mergeSettings, type OsheepSettings } from "./settings";

export interface FsNode {
  name: string;
  path: string;
  kind: "file" | "directory";
}

function toNode(e: FsEntry): FsNode {
  return { name: e.name, path: e.path, kind: e.kind };
}

export async function readDirShallow(workspaceId: string, dirPath: string): Promise<FsNode[]> {
  const entries = await apiListTree(workspaceId, dirPath, false);
  return entries.map(toNode);
}

export async function readFileText(workspaceId: string, filePath: string): Promise<string> {
  const { content } = await apiReadFile(workspaceId, filePath);
  return content;
}

export async function writeFileText(
  workspaceId: string,
  filePath: string,
  content: string,
): Promise<void> {
  await apiWriteFile(workspaceId, filePath, content);
}

export async function writeFileBase64(
  workspaceId: string,
  filePath: string,
  contentBase64: string,
): Promise<void> {
  await apiWriteFileBase64(workspaceId, filePath, contentBase64);
}

export async function createFile(workspaceId: string, filePath: string): Promise<void> {
  await apiCreateEntry(workspaceId, filePath, "file");
}

export async function createDirectory(workspaceId: string, dirPath: string): Promise<void> {
  await apiCreateEntry(workspaceId, dirPath, "directory");
}

export async function removeEntry(workspaceId: string, entryPath: string): Promise<void> {
  await apiDeleteEntry(workspaceId, entryPath, true);
}

export async function renameEntry(
  workspaceId: string,
  oldPath: string,
  newName: string,
): Promise<string> {
  const slash = oldPath.lastIndexOf("/");
  const dir = slash >= 0 ? oldPath.slice(0, slash) : "";
  const newPath = dir ? `${dir}/${newName}` : newName;
  if (newPath === oldPath) return oldPath;
  await apiMoveEntry(workspaceId, oldPath, newPath);
  return newPath;
}

export async function moveEntryTo(
  workspaceId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  await apiMoveEntry(workspaceId, fromPath, toPath);
}

export async function copyEntryTo(
  workspaceId: string,
  fromPath: string,
  toPath: string,
): Promise<void> {
  await apiCopyEntry(workspaceId, fromPath, toPath);
}

export async function copyExternalEntryTo(
  workspaceId: string,
  sourcePath: string,
  toPath: string,
): Promise<void> {
  await apiCopyExternalEntry(workspaceId, sourcePath, toPath);
}

export async function findFreeName(
  workspaceId: string,
  dirPath: string,
  baseName: string,
  kind: "file" | "directory",
): Promise<string> {
  return await apiFindFreeName(workspaceId, dirPath, baseName, kind);
}

export async function findFreeImageName(
  workspaceId: string,
  dirPath: string,
  extension: string,
): Promise<string> {
  const entries = await readDirShallow(workspaceId, dirPath);
  const taken = new Set(entries.map((entry) => entry.name));
  const suffix = extension.replace(/^\./, "");
  const base = `image.${suffix}`;
  if (!taken.has(base)) return base;
  for (let index = 1; ; index += 1) {
    const candidate = `image-${index}.${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export async function loadOsheepSettings(workspaceId: string): Promise<OsheepSettings> {
  try {
    const raw = await apiGetSettings<unknown>(workspaceId);
    return mergeSettings(raw);
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveOsheepSettings(workspaceId: string, s: OsheepSettings): Promise<void> {
  await apiPutSettings(workspaceId, s);
}

export async function loadGlobalOsheepSettings(): Promise<OsheepSettings> {
  try {
    return mergeSettings(await apiGetGlobalSettings<unknown>());
  } catch {
    return DEFAULT_SETTINGS;
  }
}

export async function saveGlobalOsheepSettings(s: OsheepSettings): Promise<void> {
  await apiPutGlobalSettings(s);
}

export const DOCS_DIR = ".osheep/docs";
