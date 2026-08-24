export const FILE_TREE_DRAG_MIME = "application/x-osheep-path";
const DRAG_TEXT_PREFIX = "osheep-path:";
const DRAG_URI_PREFIX = "osheep-path-uri:";

export function hasFileTreeDrag(types: Iterable<string>): boolean {
  return (
    [...types].includes(FILE_TREE_DRAG_MIME) ||
    [...types].includes("Files") ||
    [...types].includes("application/x-moz-file") ||
    [...types].includes("text/plain") ||
    [...types].includes("text/uri-list")
  );
}

export function encodeFileTreeDragPaths(paths: string[]): string {
  return JSON.stringify(paths);
}

function decodeFileTreeDragPaths(value: string): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((path): path is string => typeof path === "string" && path.length > 0);
    }
  } catch {
    // Accept drag data written by older single-path clients.
  }
  return [value];
}

function externalUriPath(value: string): string {
  const trimmed = value.trim().replace(/^['"]|['"]$/g, "");
  if (!trimmed.toLowerCase().startsWith("file://")) return trimmed;
  try {
    const url = new URL(trimmed);
    const pathname = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost") {
      return `\\\\${url.hostname}${pathname.replace(/\//g, "\\")}`;
    }
    if (/^\/[a-zA-Z]:\//.test(pathname)) return pathname.slice(1).replace(/\//g, "\\");
    return pathname;
  } catch {
    return trimmed.slice("file://".length);
  }
}

function externalTextPaths(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .map(externalUriPath)
    .filter(
      (path) => /^[a-zA-Z]:[\\/]/.test(path) || path.startsWith("\\\\") || path.startsWith("/"),
    );
}

export function readFileTreeDragEntries(data: {
  files?: ArrayLike<{ path?: string; webkitRelativePath?: string }>;
}): Array<{ path: string; kind: "file" | "directory" }> {
  if (!data.files) return [];
  const out: Array<{ path: string; kind: "file" | "directory" }> = [];
  for (let index = 0; index < data.files.length; index += 1) {
    const file = data.files[index];
    if (!file) continue;
    const path = file.path;
    if (!path) continue;
    if (file.webkitRelativePath?.endsWith("/")) {
      out.push({ path, kind: "directory" });
    } else {
      out.push({ path, kind: "file" });
    }
  }
  return out;
}

export function readFileTreeDragPaths(data: {
  getData: (format: string) => string;
  files?: ArrayLike<{ path?: string; webkitRelativePath?: string }>;
}): string[] {
  const custom = data.getData(FILE_TREE_DRAG_MIME);
  if (custom) return decodeFileTreeDragPaths(custom);
  const text = data.getData("text/plain");
  if (text.startsWith(DRAG_TEXT_PREFIX)) {
    return decodeFileTreeDragPaths(text.slice(DRAG_TEXT_PREFIX.length));
  }
  const uri = data.getData("text/uri-list");
  if (uri.startsWith(DRAG_URI_PREFIX))
    return decodeFileTreeDragPaths(uri.slice(DRAG_URI_PREFIX.length));
  const uriPaths = externalTextPaths(uri);
  if (uriPaths.length > 0) return uriPaths;
  const textPaths = externalTextPaths(text);
  if (textPaths.length > 0) return textPaths;
  const files = data.files;
  if (!files) return [];
  const paths: string[] = [];
  for (let index = 0; index < files.length; index += 1) {
    const filePath = files[index]?.path;
    if (filePath) paths.push(filePath);
  }
  return paths;
}

export function readFileTreeDragFiles(data: { files?: ArrayLike<File> }): File[] {
  if (!data.files) return [];
  const files: File[] = [];
  for (let index = 0; index < data.files.length; index += 1) {
    const file = data.files[index];
    if (file) files.push(file);
  }
  return files;
}

export interface BrowserDropFile {
  file: File;
  relativePath: string;
}

interface FileSystemEntryLike {
  isFile: boolean;
  isDirectory: boolean;
  name: string;
  file?: (callback: (file: File) => void, error?: (error: unknown) => void) => void;
  createReader?: () => {
    readEntries: (callback: (entries: FileSystemEntryLike[]) => void) => void;
  };
}

async function readBrowserEntry(
  entry: FileSystemEntryLike,
  prefix: string,
): Promise<BrowserDropFile[]> {
  if (entry.isFile && entry.file) {
    const file = await new Promise<File>((resolve, reject) => entry.file?.(resolve, reject));
    return [{ file, relativePath: `${prefix}${entry.name}` }];
  }
  if (!entry.isDirectory || !entry.createReader) return [];
  const reader = entry.createReader();
  const children: FileSystemEntryLike[] = [];
  while (true) {
    const batch = await new Promise<FileSystemEntryLike[]>((resolve) =>
      reader.readEntries(resolve),
    );
    if (batch.length === 0) break;
    children.push(...batch);
  }
  const nextPrefix = `${prefix}${entry.name}/`;
  const nested = await Promise.all(children.map((child) => readBrowserEntry(child, nextPrefix)));
  return nested.flat();
}

export async function readBrowserDropItems(
  items: DataTransferItemList,
): Promise<BrowserDropFile[]> {
  const output: BrowserDropFile[] = [];
  for (let index = 0; index < items.length; index += 1) {
    const item = items[index];
    if (!item) continue;
    const entry = (
      item as DataTransferItem & { webkitGetAsEntry?: () => FileSystemEntryLike | null }
    ).webkitGetAsEntry?.();
    if (entry) output.push(...(await readBrowserEntry(entry, "")));
    else {
      const file = item.getAsFile();
      if (file) output.push({ file, relativePath: file.name });
    }
  }
  return output;
}

export function writeFileTreeDragData(
  data: { setData: (format: string, value: string) => void },
  paths: string[],
): void {
  const encoded = encodeFileTreeDragPaths(paths);
  data.setData(FILE_TREE_DRAG_MIME, encoded);
  data.setData("text/plain", `${DRAG_TEXT_PREFIX}${encoded}`);
  data.setData("text/uri-list", `${DRAG_URI_PREFIX}${encoded}`);
}
