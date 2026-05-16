// Single-file HTTP + WebSocket client for osheep-backend.
// Frontend code should import from here instead of touching fetch directly.

export interface ApiErrorBody {
  error: { code: string; message: string };
}

export class ApiClientError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

async function request<T>(
  method: string,
  url: string,
  body?: unknown
): Promise<T> {
  const init: RequestInit = { method };
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }
  const res = await fetch(url, init);
  const text = await res.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  if (!res.ok) {
    const err = (parsed as ApiErrorBody | null)?.error;
    throw new ApiClientError(
      res.status,
      err?.code ?? "HTTP_" + res.status,
      err?.message ?? `请求失败 ${res.status}`
    );
  }
  return parsed as T;
}

export const http = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  delete: <T>(url: string) => request<T>("DELETE", url),
};

// ─── Domain shapes (mirror backend types) ───

export interface Workspace {
  id: string;
  name: string;
}

export interface FsEntry {
  name: string;
  path: string;
  kind: "file" | "directory";
  size?: number;
  mtime?: number;
}

export interface ShellProfile {
  id: string;
  label: string;
  executable: string;
}

export interface TerminalCreateResp {
  id: string;
  shell: string;
  cols: number;
  rows: number;
  wsUrl: string;
}

// ─── Workspaces ───

export async function listWorkspaces(): Promise<Workspace[]> {
  const { workspaces } = await http.get<{ workspaces: Workspace[] }>(
    "/api/workspaces"
  );
  return workspaces;
}

export async function getWorkspace(id: string): Promise<Workspace> {
  return await http.get<Workspace>(`/api/workspaces/${encodeURIComponent(id)}`);
}

// ─── File API ───

const wsUrl = (id: string, suffix: string, query?: Record<string, string>) => {
  const base = `/api/workspaces/${encodeURIComponent(id)}/fs${suffix}`;
  if (!query) return base;
  const qs = new URLSearchParams(query).toString();
  return qs ? `${base}?${qs}` : base;
};

export async function listTree(
  workspaceId: string,
  path: string,
  includeHidden = false
): Promise<FsEntry[]> {
  const q: Record<string, string> = { path };
  if (includeHidden) q.includeHidden = "true";
  const { entries } = await http.get<{ entries: FsEntry[] }>(
    wsUrl(workspaceId, "/tree", q)
  );
  return entries;
}

export async function readFile(
  workspaceId: string,
  path: string
): Promise<{ content: string; size: number; mtime: number }> {
  return await http.get(wsUrl(workspaceId, "/file", { path }));
}

export async function writeFile(
  workspaceId: string,
  path: string,
  content: string,
  createParents = true
): Promise<{ size: number; mtime: number }> {
  return await http.put(wsUrl(workspaceId, "/file"), {
    path,
    content,
    createParents,
  });
}

export async function createEntry(
  workspaceId: string,
  path: string,
  kind: "file" | "directory"
): Promise<void> {
  await http.post(wsUrl(workspaceId, "/entry"), { path, kind });
}

export async function moveEntry(
  workspaceId: string,
  from: string,
  to: string
): Promise<void> {
  await http.post(wsUrl(workspaceId, "/move"), { from, to });
}

export async function copyEntry(
  workspaceId: string,
  from: string,
  to: string
): Promise<void> {
  await http.post(wsUrl(workspaceId, "/copy"), { from, to });
}

export async function deleteEntry(
  workspaceId: string,
  path: string,
  recursive = true
): Promise<void> {
  await http.delete(
    wsUrl(workspaceId, "/entry", {
      path,
      recursive: recursive ? "true" : "false",
    })
  );
}

// ─── Settings ───

export async function getSettings<T = unknown>(
  workspaceId: string
): Promise<T> {
  return await http.get<T>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/settings`
  );
}

export async function putSettings(
  workspaceId: string,
  value: unknown
): Promise<void> {
  await http.put(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/settings`,
    value
  );
}

// ─── Terminal ───

export async function getProfiles(): Promise<{
  os: "windows" | "macos" | "linux";
  profiles: ShellProfile[];
}> {
  return await http.get("/api/terminals/profiles");
}

export async function createTerminal(input: {
  workspaceId: string;
  shell: string;
  cols: number;
  rows: number;
}): Promise<TerminalCreateResp> {
  return await http.post("/api/terminals", input);
}

export async function killTerminal(id: string): Promise<void> {
  await http.delete(`/api/terminals/${encodeURIComponent(id)}`);
}

export function openTerminalSocket(wsPath: string): WebSocket {
  const proto = window.location.protocol === "https:" ? "wss" : "ws";
  const url = `${proto}://${window.location.host}${wsPath}`;
  return new WebSocket(url);
}

// ─── Helpers ───

/**
 * Given a target directory and an existing name, ask the server for a free
 * non-conflicting name in that dir by listing the tree once. Used for
 * paste-on-duplicate.
 */
export async function findFreeName(
  workspaceId: string,
  dir: string,
  baseName: string,
  kind: "file" | "directory"
): Promise<string> {
  const siblings = await listTree(workspaceId, dir, true);
  const taken = new Set(siblings.map((e) => e.name));
  if (!taken.has(baseName)) return baseName;
  const dot = kind === "file" ? baseName.lastIndexOf(".") : -1;
  const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
  const ext = dot > 0 ? baseName.slice(dot) : "";
  for (let i = 1; i < 1000; i++) {
    const candidate = i === 1 ? `${stem} 副本${ext}` : `${stem} 副本 ${i}${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
  return `${stem} 副本 ${Date.now()}${ext}`;
}

export function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i) : "";
}

export function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  return parent + "/" + name;
}
