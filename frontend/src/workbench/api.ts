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

// ─── Search ───

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
  regex?: boolean;
  include?: string;
  exclude?: string;
  maxFiles?: number;
  maxMatchesPerFile?: number;
}

export interface SearchMatchLine {
  line: number;
  column: number;
  preview: string;
  matchStart: number;
  matchEnd: number;
}

export interface SearchFileMatch {
  path: string;
  lines: SearchMatchLine[];
}

export interface SearchResult {
  matches: SearchFileMatch[];
  truncated: boolean;
  filesScanned: number;
  elapsedMs: number;
}

export async function searchWorkspace(
  workspaceId: string,
  query: string,
  opts: SearchOptions = {}
): Promise<SearchResult> {
  const q: Record<string, string> = { query };
  if (opts.caseSensitive) q.caseSensitive = "true";
  if (opts.wholeWord) q.wholeWord = "true";
  if (opts.regex) q.regex = "true";
  if (opts.include) q.include = opts.include;
  if (opts.exclude) q.exclude = opts.exclude;
  if (opts.maxFiles) q.maxFiles = String(opts.maxFiles);
  if (opts.maxMatchesPerFile)
    q.maxMatchesPerFile = String(opts.maxMatchesPerFile);
  const qs = new URLSearchParams(q).toString();
  return await http.get(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/search?${qs}`
  );
}

// ─── Git ───

export interface GitRepoInfo {
  isRepo: boolean;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  upstream?: string | null;
  detached?: boolean;
}

export interface GitChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  renamedFrom: string | null;
}

export interface GitStatus extends GitRepoInfo {
  changes: GitChange[];
}

export interface GitDiff {
  path: string;
  base: "HEAD" | "INDEX";
  head: "INDEX" | "WORKTREE";
  leftContent: string;
  rightContent: string;
  leftMissing: boolean;
  rightMissing: boolean;
  binary: boolean;
}

const gitUrl = (id: string, suffix: string) =>
  `/api/workspaces/${encodeURIComponent(id)}/git${suffix}`;

export async function getGitRepo(workspaceId: string): Promise<GitRepoInfo> {
  return await http.get(gitUrl(workspaceId, "/repo"));
}

export async function getGitStatus(workspaceId: string): Promise<GitStatus> {
  return await http.get(gitUrl(workspaceId, "/status"));
}

export async function gitStage(
  workspaceId: string,
  paths: string[]
): Promise<void> {
  await http.post(gitUrl(workspaceId, "/stage"), { paths });
}

export async function gitUnstage(
  workspaceId: string,
  paths: string[]
): Promise<void> {
  await http.post(gitUrl(workspaceId, "/unstage"), { paths });
}

export async function gitDiscard(
  workspaceId: string,
  paths: string[]
): Promise<{ discarded: string[] }> {
  return await http.post(gitUrl(workspaceId, "/discard"), { paths });
}

export async function gitCommit(
  workspaceId: string,
  message: string
): Promise<{ head: string }> {
  return await http.post(gitUrl(workspaceId, "/commit"), { message });
}

export async function gitInit(workspaceId: string): Promise<void> {
  await http.post(gitUrl(workspaceId, "/init"), {});
}

export async function getGitDiff(
  workspaceId: string,
  path: string,
  base: "HEAD" | "INDEX" = "HEAD",
  head: "INDEX" | "WORKTREE" = "WORKTREE"
): Promise<GitDiff> {
  const qs = new URLSearchParams({ path, base, head }).toString();
  return await http.get(gitUrl(workspaceId, `/diff?${qs}`));
}

export interface GitRemote {
  name: string;
  url: string;
}

export async function listGitRemotes(workspaceId: string): Promise<GitRemote[]> {
  const { remotes } = await http.get<{ remotes: GitRemote[] }>(
    gitUrl(workspaceId, "/remotes")
  );
  return remotes;
}

export async function addGitRemote(
  workspaceId: string,
  name: string,
  url: string
): Promise<void> {
  await http.post(gitUrl(workspaceId, "/remotes"), { name, url });
}

export async function removeGitRemote(
  workspaceId: string,
  name: string
): Promise<void> {
  await http.delete(gitUrl(workspaceId, `/remotes/${encodeURIComponent(name)}`));
}

export interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  date: number;
  subject: string;
  refs: string[];
}

export interface GitLog {
  commits: GitCommit[];
  head: string | null;
}

export async function getGitLog(
  workspaceId: string,
  limit = 200,
  offset = 0,
  ref = "HEAD"
): Promise<GitLog> {
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    ref,
  }).toString();
  return await http.get(gitUrl(workspaceId, `/log?${qs}`));
}

// ─── Branches & remote ops ───

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  kind: "local" | "remote";
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}

export interface GitBranchesResp {
  current: string | null;
  detached: boolean;
  branches: GitBranch[];
}

export async function listGitBranches(
  workspaceId: string
): Promise<GitBranchesResp> {
  return await http.get(gitUrl(workspaceId, "/branches"));
}

export async function gitCheckout(
  workspaceId: string,
  ref: string,
  opts: { create?: boolean; fromRef?: string | null } = {}
): Promise<void> {
  await http.post(gitUrl(workspaceId, "/checkout"), {
    ref,
    create: !!opts.create,
    fromRef: opts.fromRef ?? null,
  });
}

export async function gitFetch(
  workspaceId: string,
  remote: string | null = null,
  prune = false
): Promise<void> {
  await http.post(gitUrl(workspaceId, "/fetch"), { remote, prune });
}

export async function gitPull(
  workspaceId: string,
  opts: { remote?: string | null; branch?: string | null; ffOnly?: boolean } = {}
): Promise<void> {
  await http.post(gitUrl(workspaceId, "/pull"), {
    remote: opts.remote ?? null,
    branch: opts.branch ?? null,
    ffOnly: opts.ffOnly !== false,
  });
}

export async function gitPush(
  workspaceId: string,
  opts: {
    remote?: string | null;
    branch?: string | null;
    setUpstream?: boolean;
    force?: boolean;
  } = {}
): Promise<void> {
  await http.post(gitUrl(workspaceId, "/push"), {
    remote: opts.remote ?? null,
    branch: opts.branch ?? null,
    setUpstream: !!opts.setUpstream,
    force: !!opts.force,
  });
}

// ─── Agents ───

export interface AgentRecord {
  name: string;
  prompt: string;
  providerId: string;
  model: string;
}

const agentsUrl = (id: string, suffix = "") =>
  `/api/workspaces/${encodeURIComponent(id)}/agents${suffix}`;

export async function listAgents(workspaceId: string): Promise<AgentRecord[]> {
  const { agents } = await http.get<{ agents: AgentRecord[] }>(
    agentsUrl(workspaceId)
  );
  return agents;
}

export async function createAgent(
  workspaceId: string,
  agent: AgentRecord
): Promise<void> {
  await http.post(agentsUrl(workspaceId), agent);
}

export async function updateAgent(
  workspaceId: string,
  originalName: string,
  agent: AgentRecord
): Promise<void> {
  await http.put(
    agentsUrl(workspaceId, `/${encodeURIComponent(originalName)}`),
    agent
  );
}

export async function deleteAgent(
  workspaceId: string,
  name: string
): Promise<void> {
  await http.delete(agentsUrl(workspaceId, `/${encodeURIComponent(name)}`));
}

// ─── Sessions ───

export type ChatRole = "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
  timestamp: number;
}

export interface SessionRecord {
  id: string;
  title: string;
  agentName: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  agentName: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const sessionsUrl = (id: string, suffix = "") =>
  `/api/workspaces/${encodeURIComponent(id)}/sessions${suffix}`;

export async function listSessions(
  workspaceId: string
): Promise<SessionSummary[]> {
  const { sessions } = await http.get<{ sessions: SessionSummary[] }>(
    sessionsUrl(workspaceId)
  );
  return sessions;
}

export async function getSession(
  workspaceId: string,
  sessionId: string
): Promise<SessionRecord> {
  return await http.get(
    sessionsUrl(workspaceId, `/${encodeURIComponent(sessionId)}`)
  );
}

export async function createSession(
  workspaceId: string,
  partial: Partial<SessionRecord> = {}
): Promise<SessionRecord> {
  return await http.post(sessionsUrl(workspaceId), partial);
}

export async function saveSession(
  workspaceId: string,
  record: SessionRecord
): Promise<SessionRecord> {
  return await http.put(
    sessionsUrl(workspaceId, `/${encodeURIComponent(record.id)}`),
    record
  );
}

export async function deleteSession(
  workspaceId: string,
  sessionId: string
): Promise<void> {
  await http.delete(
    sessionsUrl(workspaceId, `/${encodeURIComponent(sessionId)}`)
  );
}

// ─── AI proxy ───

export interface AiChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export async function fetchProviderModels(
  workspaceId: string,
  baseUrl: string,
  apiKey: string
): Promise<string[]> {
  const { models } = await http.post<{ models: string[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/models`,
    { baseUrl, apiKey }
  );
  return models;
}

export async function aiChat(
  workspaceId: string,
  input: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: AiChatMessage[];
  }
): Promise<{ content: string }> {
  return await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/chat`,
    input
  );
}
