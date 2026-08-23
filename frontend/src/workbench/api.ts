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

const etagCache = new Map<string, { etag: string; body: unknown }>();
let apiSessionPromise: Promise<void> | null = null;

export function resetApiSession(): void {
  apiSessionPromise = null;
}

function fragmentAccessToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const params = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const token = params.get("osheep-token")?.trim() || undefined;
  if (!token) return undefined;

  params.delete("osheep-token");
  const hash = params.toString();
  window.history.replaceState(
    null,
    "",
    `${window.location.pathname}${window.location.search}${hash ? `#${hash}` : ""}`,
  );
  return token;
}

export async function ensureApiSession(): Promise<void> {
  if (apiSessionPromise) return apiSessionPromise;
  const token = fragmentAccessToken();
  apiSessionPromise = (async () => {
    const headers = token ? { authorization: `Bearer ${token}` } : undefined;
    const response = await fetch("/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      headers,
    });
    if (response.ok) return;

    const parsed = (await response.json().catch(() => null)) as ApiErrorBody | null;
    throw new ApiClientError(
      response.status,
      parsed?.error?.code ?? `HTTP_${response.status}`,
      parsed?.error?.message ?? `无法建立 Osheep 会话 (${response.status})`,
    );
  })().catch((error) => {
    apiSessionPromise = null;
    throw error;
  });
  return apiSessionPromise;
}

async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  await ensureApiSession();
  const requestInit = { ...init, credentials: "same-origin" as const };
  let response = await fetch(input, requestInit);
  if (response.status !== 401) return response;

  resetApiSession();
  await ensureApiSession();
  response = await fetch(input, requestInit);
  return response;
}

async function request<T>(method: string, url: string, body?: unknown): Promise<T> {
  const init: RequestInit = { method };
  const cached = method === "GET" ? etagCache.get(url) : undefined;
  if (cached) {
    init.headers = { "if-none-match": cached.etag };
  }
  if (body !== undefined) {
    init.headers = { "content-type": "application/json" };
    init.body = JSON.stringify(body);
  }

  let res = await apiFetch(url, init);
  if (res.status === 304) {
    if (cached) return cached.body as T;
    res = await apiFetch(url, { method: "GET" });
  }

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
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? `请求失败 ${res.status}`,
    );
  }
  if (method === "GET") {
    const etag = res.headers.get("etag");
    if (etag) etagCache.set(url, { etag, body: parsed });
  }
  return parsed as T;
}

export const http = {
  get: <T>(url: string) => request<T>("GET", url),
  post: <T>(url: string, body?: unknown) => request<T>("POST", url, body ?? {}),
  put: <T>(url: string, body?: unknown) => request<T>("PUT", url, body ?? {}),
  patch: <T>(url: string, body?: unknown) => request<T>("PATCH", url, body ?? {}),
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

export type AgentSessionApp = "claude" | "codex";

export type CliToolName = "claude" | "codex";
export type CliToolAction = "install" | "update";

export type SkillAgent = "claude" | "codex";

export type SkillOrigin = "skills.sh" | "manual";

export interface InstalledSkill {
  name: string;
  description?: string;
  path: string;
  agents: SkillAgent[];
  source: "local" | "skills.sh";
}

export interface StagedSkill {
  name: string;
  description?: string;
  path: string;
  agent: SkillAgent;
  origin: SkillOrigin;
  source?: string;
}

export interface SkillsSnapshot {
  enabled: InstalledSkill[];
  user: StagedSkill[];
  paths: Record<SkillAgent, string[]>;
}

export interface SkillsLibraryItem {
  name: string;
  owner?: string;
  repo?: string;
  description?: string;
  installCount: number;
  source?: string;
  url?: string;
}

export interface CliToolStatus {
  name: CliToolName;
  activeAction: CliToolAction | null;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  platform: "windows" | "macos" | "linux";
  error: string | null;
}

export async function getCliToolStatuses(): Promise<CliToolStatus[]> {
  const result = await http.get<{ tools: CliToolStatus[] }>("/api/ai/cli-tools");
  return result.tools;
}

export async function runCliToolAction(
  name: CliToolName,
  action: CliToolAction,
): Promise<CliToolStatus> {
  const result = await http.post<{ status: CliToolStatus }>(
    `/api/ai/cli-tools/${encodeURIComponent(name)}/action`,
    { action },
  );
  return result.status;
}

export interface AgentSessionSummary {
  app: AgentSessionApp;
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  size: number;
}

// ─── Workspaces ───

export async function listWorkspaces(): Promise<Workspace[]> {
  const { workspaces } = await http.get<{ workspaces: Workspace[] }>("/api/workspaces");
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
  includeHidden = false,
): Promise<FsEntry[]> {
  const q: Record<string, string> = { path };
  if (includeHidden) q.includeHidden = "true";
  const { entries } = await http.get<{ entries: FsEntry[] }>(wsUrl(workspaceId, "/tree", q));
  return entries;
}

export async function readFile(
  workspaceId: string,
  path: string,
): Promise<{ content: string; size: number; mtime: number }> {
  return await http.get(wsUrl(workspaceId, "/file", { path }));
}

export async function resolveExternalFilePath(workspaceId: string, path: string): Promise<string> {
  const result = await http.post<{ path: string }>(wsUrl(workspaceId, "/external"), { path });
  return result.path;
}

export function workspaceImageUrl(workspaceId: string, path: string): string {
  return wsUrl(workspaceId, "/image", { path });
}

export async function writeFile(
  workspaceId: string,
  path: string,
  content: string,
  createParents = true,
): Promise<{ size: number; mtime: number }> {
  return await http.put(wsUrl(workspaceId, "/file"), {
    path,
    content,
    createParents,
  });
}

export async function writeFileBase64(
  workspaceId: string,
  path: string,
  contentBase64: string,
  createParents = true,
): Promise<{ size: number; mtime: number }> {
  return await http.put(wsUrl(workspaceId, "/file"), { path, contentBase64, createParents });
}

export async function createEntry(
  workspaceId: string,
  path: string,
  kind: "file" | "directory",
): Promise<void> {
  await http.post(wsUrl(workspaceId, "/entry"), { path, kind });
}

export async function moveEntry(workspaceId: string, from: string, to: string): Promise<void> {
  await http.post(wsUrl(workspaceId, "/move"), { from, to });
}

export async function copyEntry(workspaceId: string, from: string, to: string): Promise<void> {
  await http.post(wsUrl(workspaceId, "/copy"), { from, to });
}

export async function copyExternalEntry(
  workspaceId: string,
  sourcePath: string,
  targetPath: string,
): Promise<void> {
  await http.post(wsUrl(workspaceId, "/copy-external"), {
    sourcePath,
    targetPath,
  });
}

export async function deleteEntry(
  workspaceId: string,
  path: string,
  recursive = true,
): Promise<void> {
  await http.delete(
    wsUrl(workspaceId, "/entry", {
      path,
      recursive: recursive ? "true" : "false",
    }),
  );
}

// ─── Settings ───

export async function getSettings<T = unknown>(workspaceId: string): Promise<T> {
  return await http.get<T>(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`);
}

export async function putSettings(workspaceId: string, value: unknown): Promise<void> {
  await http.put(`/api/workspaces/${encodeURIComponent(workspaceId)}/settings`, value);
}

export async function getGlobalSettings<T = unknown>(): Promise<T> {
  return await http.get<T>("/api/settings");
}

export async function putGlobalSettings(value: unknown): Promise<void> {
  await http.put("/api/settings", value);
}

export interface ModelPriceRecord {
  model: string;
  provider: string;
  billingMode: "dynamic" | "per-request";
  costPerRequest?: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  favorite?: boolean;
  favoriteCustomized?: boolean;
  source?: "litellm" | "manual";
  updatedAt?: number;
}

export async function syncModelPrices(): Promise<{
  models: ModelPriceRecord[];
  source: string;
  updatedAt: number;
}> {
  return await http.post("/api/model-prices/sync", {});
}

export async function getUiPreferences<T = unknown>(): Promise<T> {
  return await http.get<T>("/api/ui-preferences");
}

export async function putUiPreferences(value: unknown): Promise<void> {
  await http.put("/api/ui-preferences", value);
}

export interface ClaudeOnboardingStatus {
  enabled: boolean;
  path: string;
}

export async function getClaudeOnboardingStatus(): Promise<ClaudeOnboardingStatus> {
  return await http.get("/api/claude/onboarding-skip");
}

export async function putClaudeOnboardingSkip(enabled: boolean): Promise<ClaudeOnboardingStatus> {
  return await http.put("/api/claude/onboarding-skip", { enabled });
}

// ─── Terminal ───

// AI Settings

export type AiSettingsApp = "claude" | "codex";

export interface AiSettingsProvider {
  id: string;
  name: string;
  settingsConfig: unknown;
  websiteUrl?: string;
  category?: string;
  createdAt?: number;
  sortIndex?: number;
  notes?: string;
  meta?: Record<string, unknown>;
  icon?: string;
  iconColor?: string;
  inFailoverQueue?: boolean;
  billingMultiplier?: number;
}

export interface AiSettingsProviderManager {
  providers: Record<string, AiSettingsProvider>;
  current: string;
}

export interface AiSettingsState {
  version: 1;
  apps: Record<AiSettingsApp, AiSettingsProviderManager>;
}

export interface AiSettingsSnapshot {
  state: AiSettingsState;
  paths: {
    store: string;
    claude: { dir: string; settings: string; exists: boolean };
    codex: {
      dir: string;
      auth: string;
      config: string;
      authExists: boolean;
      configExists: boolean;
    };
  };
}

export async function getAiSettings(): Promise<AiSettingsSnapshot> {
  return await http.get("/api/ai-settings");
}

export async function importAiLiveProvider(app: AiSettingsApp): Promise<AiSettingsSnapshot> {
  return await http.post("/api/ai-settings/import-live", { app });
}

export async function saveAiProvider(
  app: AiSettingsApp,
  provider: AiSettingsProvider,
  originalId?: string,
  apply = false,
): Promise<AiSettingsSnapshot> {
  if (originalId) {
    return await http.put(`/api/ai-settings/providers/${encodeURIComponent(originalId)}`, {
      app,
      provider,
      apply,
    });
  }
  return await http.post("/api/ai-settings/providers", { app, provider, apply });
}

export async function deleteAiSettingsProvider(
  app: AiSettingsApp,
  id: string,
): Promise<AiSettingsSnapshot> {
  const qs = new URLSearchParams({ app }).toString();
  return await http.delete(`/api/ai-settings/providers/${encodeURIComponent(id)}?${qs}`);
}

export async function switchAiSettingsProvider(
  app: AiSettingsApp,
  id: string,
): Promise<AiSettingsSnapshot> {
  return await http.post("/api/ai-settings/switch", { app, id });
}

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

export async function listAgentSessions(
  app: AgentSessionApp,
  workspaceId: string,
): Promise<AgentSessionSummary[]> {
  const query = new URLSearchParams({ app, workspaceId }).toString();
  const { sessions } = await http.get<{ sessions: AgentSessionSummary[] }>(
    `/api/agent-sessions?${query}`,
  );
  return sessions;
}

export async function deleteAgentSession(
  app: AgentSessionApp,
  id: string,
  workspaceId: string,
): Promise<void> {
  const query = new URLSearchParams({ workspaceId }).toString();
  await http.delete(
    `/api/agent-sessions/${encodeURIComponent(app)}/${encodeURIComponent(id)}?${query}`,
  );
}

export async function batchDeleteAgentSessions(
  app: AgentSessionApp,
  ids: string[],
  workspaceId: string,
): Promise<{ deleted: AgentSessionSummary[]; failed: Array<{ id: string; message: string }> }> {
  return await http.post(`/api/agent-sessions/${encodeURIComponent(app)}/batch-delete`, {
    ids,
    workspaceId,
  });
}

export async function createAgentSessionTerminal(input: {
  app: AgentSessionApp;
  sessionId: string;
  workspaceId: string;
  shell: string;
  cols: number;
  rows: number;
}): Promise<TerminalCreateResp> {
  return await http.post(
    `/api/agent-sessions/${encodeURIComponent(input.app)}/${encodeURIComponent(
      input.sessionId,
    )}/terminal`,
    {
      workspaceId: input.workspaceId,
      shell: input.shell,
      cols: input.cols,
      rows: input.rows,
    },
  );
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
  kind: "file" | "directory",
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
  return `${parent}/${name}`;
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
  opts: SearchOptions = {},
): Promise<SearchResult> {
  const q: Record<string, string> = { query };
  if (opts.caseSensitive) q.caseSensitive = "true";
  if (opts.wholeWord) q.wholeWord = "true";
  if (opts.regex) q.regex = "true";
  if (opts.include) q.include = opts.include;
  if (opts.exclude) q.exclude = opts.exclude;
  if (opts.maxFiles) q.maxFiles = String(opts.maxFiles);
  if (opts.maxMatchesPerFile) q.maxMatchesPerFile = String(opts.maxMatchesPerFile);
  const qs = new URLSearchParams(q).toString();
  return await http.get(`/api/workspaces/${encodeURIComponent(workspaceId)}/search?${qs}`);
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
  ignoredPaths?: string[];
}

export async function getSkills(): Promise<SkillsSnapshot> {
  return await http.get<SkillsSnapshot>("/api/skills");
}

export async function searchSkillsLibrary(query = ""): Promise<SkillsLibraryItem[]> {
  const result = await http.get<{ skills: SkillsLibraryItem[] }>(
    `/api/skills/library?${new URLSearchParams({ q: query }).toString()}`,
  );
  return result.skills;
}

export async function installSkillApi(input: {
  source: string;
  skill?: string;
  agent: SkillAgent;
  origin: SkillOrigin;
}): Promise<SkillsSnapshot> {
  const result = await http.post<{ snapshot: SkillsSnapshot }>("/api/skills/install", input);
  return result.snapshot;
}

export async function importSkillApi(input: {
  agent: SkillAgent;
  sourcePath?: string;
  files?: Array<{ path: string; data: string }>;
}): Promise<SkillsSnapshot> {
  const result = await http.post<{ snapshot: SkillsSnapshot }>("/api/skills/import", input);
  return result.snapshot;
}

export async function enableSkillApi(name: string, agent: SkillAgent): Promise<SkillsSnapshot> {
  const result = await http.post<{ snapshot: SkillsSnapshot }>("/api/skills/enable", {
    name,
    agent,
  });
  return result.snapshot;
}

export async function disableSkillApi(name: string, agent: SkillAgent): Promise<SkillsSnapshot> {
  const result = await http.post<{ snapshot: SkillsSnapshot }>("/api/skills/disable", {
    name,
    agent,
  });
  return result.snapshot;
}

export async function applySkillSelectionApi(
  names: string[],
  agent: SkillAgent,
): Promise<SkillsSnapshot> {
  const result = await http.post<{ snapshot: SkillsSnapshot }>("/api/skills/apply", {
    names,
    agent,
  });
  return result.snapshot;
}

export async function deleteSkillApi(name: string, agent: SkillAgent): Promise<SkillsSnapshot> {
  const result = await http.post<{ snapshot: SkillsSnapshot }>("/api/skills/delete", {
    name,
    agent,
  });
  return result.snapshot;
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

export async function gitStage(workspaceId: string, paths: string[]): Promise<void> {
  await http.post(gitUrl(workspaceId, "/stage"), { paths });
}

export async function gitUnstage(workspaceId: string, paths: string[]): Promise<void> {
  await http.post(gitUrl(workspaceId, "/unstage"), { paths });
}

export async function gitDiscard(
  workspaceId: string,
  paths: string[],
): Promise<{ discarded: string[] }> {
  return await http.post(gitUrl(workspaceId, "/discard"), { paths });
}

export async function gitCommit(workspaceId: string, message: string): Promise<{ head: string }> {
  return await http.post(gitUrl(workspaceId, "/commit"), { message });
}

export async function gitInit(workspaceId: string): Promise<void> {
  await http.post(gitUrl(workspaceId, "/init"), {});
}

export async function getGitDiff(
  workspaceId: string,
  path: string,
  base: "HEAD" | "INDEX" = "HEAD",
  head: "INDEX" | "WORKTREE" = "WORKTREE",
): Promise<GitDiff> {
  const qs = new URLSearchParams({ path, base, head }).toString();
  return await http.get(gitUrl(workspaceId, `/diff?${qs}`));
}

export interface GitRemote {
  name: string;
  url: string;
}

export async function listGitRemotes(workspaceId: string): Promise<GitRemote[]> {
  const { remotes } = await http.get<{ remotes: GitRemote[] }>(gitUrl(workspaceId, "/remotes"));
  return remotes;
}

export async function addGitRemote(workspaceId: string, name: string, url: string): Promise<void> {
  await http.post(gitUrl(workspaceId, "/remotes"), { name, url });
}

export async function removeGitRemote(workspaceId: string, name: string): Promise<void> {
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
  currentRef: string | null;
  currentRemoteRef: string | null;
}

export interface GitCommitDetails {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: number;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: GitCommitFile[];
}

export interface GitCommitFile {
  path: string;
  status: string;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitCommitDiff {
  path: string;
  base: string | null;
  head: string;
  leftContent: string;
  rightContent: string;
  leftMissing: boolean;
  rightMissing: boolean;
  binary: boolean;
}

export async function getWorkspacesRoot(): Promise<string> {
  const result = await http.get<{ path: string }>("/api/workspaces/root");
  return result.path;
}

export async function setWorkspacesRoot(path: string): Promise<string> {
  const result = await http.post<{ path: string }>("/api/workspaces/root", { path });
  return result.path;
}

export async function createWorkspace(name: string): Promise<Workspace> {
  return await http.post<Workspace>("/api/workspaces", { name });
}

export async function getGitLog(
  workspaceId: string,
  limit = 200,
  offset = 0,
  ref = "HEAD",
): Promise<GitLog> {
  const qs = new URLSearchParams({
    limit: String(limit),
    offset: String(offset),
    ref,
  }).toString();
  return await http.get(gitUrl(workspaceId, `/log?${qs}`));
}

export async function getGitCommitDetails(
  workspaceId: string,
  sha: string,
): Promise<GitCommitDetails> {
  return await http.get(gitUrl(workspaceId, `/commits/${encodeURIComponent(sha)}`));
}

export async function getGitCommitDiff(
  workspaceId: string,
  sha: string,
  path: string,
): Promise<GitCommitDiff> {
  const query = new URLSearchParams({ path }).toString();
  return await http.get(gitUrl(workspaceId, `/commits/${encodeURIComponent(sha)}/diff?${query}`));
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

export async function listGitBranches(workspaceId: string): Promise<GitBranchesResp> {
  return await http.get(gitUrl(workspaceId, "/branches"));
}

export async function gitCheckout(
  workspaceId: string,
  ref: string,
  opts: { create?: boolean; fromRef?: string | null } = {},
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
  prune = false,
): Promise<void> {
  await http.post(gitUrl(workspaceId, "/fetch"), { remote, prune });
}

export async function gitPull(
  workspaceId: string,
  opts: { remote?: string | null; branch?: string | null; ffOnly?: boolean } = {},
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
  } = {},
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
  const { agents } = await http.get<{ agents: AgentRecord[] }>(agentsUrl(workspaceId));
  return agents;
}

export async function createAgent(workspaceId: string, agent: AgentRecord): Promise<void> {
  await http.post(agentsUrl(workspaceId), agent);
}

export async function updateAgent(
  workspaceId: string,
  originalName: string,
  agent: AgentRecord,
): Promise<void> {
  await http.put(agentsUrl(workspaceId, `/${encodeURIComponent(originalName)}`), agent);
}

export async function deleteAgent(workspaceId: string, name: string): Promise<void> {
  await http.delete(agentsUrl(workspaceId, `/${encodeURIComponent(name)}`));
}

// ─── Sessions ───

export type ChatRole = "user" | "assistant" | "tool";

/** Step records attached to assistant messages by osheep code. */
export type ChatStep =
  | { kind: "plan"; items: string[] }
  | { kind: "thought"; id: string; text: string; startedAt?: number; endedAt?: number }
  | {
      kind: "tool";
      id: string;
      tool: ToolKind;
      args: unknown;
      status: "queued" | "running" | "ok" | "err" | "denied" | "cached";
      result?: unknown;
      error?: string;
    }
  | { kind: "ask"; id?: string; question: string; options: string[]; answer?: string }
  | { kind: "verify"; text: string }
  | { kind: "text"; text: string };

export interface ChatMessage {
  role: ChatRole;
  content: string;
  timestamp: number;
  /** Present on assistant messages. */
  steps?: ChatStep[];
  /** Present on tool messages. */
  tool_call_id?: string;
}

export interface SessionRecord {
  id: string;
  title: string;
  /** @deprecated kept for backward compat */
  agentName: string;
  providerId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messages: ChatMessage[];
}

export interface SessionSummary {
  id: string;
  title: string;
  agentName: string;
  providerId?: string;
  model?: string;
  createdAt: number;
  updatedAt: number;
  messageCount: number;
}

const sessionsUrl = (id: string, suffix = "") =>
  `/api/workspaces/${encodeURIComponent(id)}/sessions${suffix}`;

export async function listSessions(workspaceId: string): Promise<SessionSummary[]> {
  const { sessions } = await http.get<{ sessions: SessionSummary[] }>(sessionsUrl(workspaceId));
  return sessions;
}

export async function getSession(workspaceId: string, sessionId: string): Promise<SessionRecord> {
  return await http.get(sessionsUrl(workspaceId, `/${encodeURIComponent(sessionId)}`));
}

export async function createSession(
  workspaceId: string,
  partial: Partial<SessionRecord> = {},
): Promise<SessionRecord> {
  return await http.post(sessionsUrl(workspaceId), partial);
}

export async function saveSession(
  workspaceId: string,
  record: SessionRecord,
): Promise<SessionRecord> {
  return await http.put(sessionsUrl(workspaceId, `/${encodeURIComponent(record.id)}`), record);
}

export async function deleteSession(workspaceId: string, sessionId: string): Promise<void> {
  await http.delete(sessionsUrl(workspaceId, `/${encodeURIComponent(sessionId)}`));
}

// Codex Plugins

export interface CodexPluginRecord {
  name: string;
  marketplace?: string;
  selector: string;
  displayName: string;
  version?: string;
  description?: string;
  icon?: string;
  iconColor?: string;
  status: {
    installed: boolean;
    available: boolean;
    enabled: boolean;
    cached: boolean;
    local: boolean;
  };
  source: {
    kind: "marketplace" | "personal" | "cache" | "config";
    path?: string;
  };
}

export interface CodexMarketplaceRecord {
  name: string;
  source?: string;
  path?: string;
}

export interface CodexPluginSnapshot {
  plugins: CodexPluginRecord[];
  marketplaces: CodexMarketplaceRecord[];
  warnings: string[];
  paths: {
    codexDir: string;
    codexConfig: string;
    codexPluginCache: string;
    personalMarketplace: string;
    personalPluginRoot: string;
  };
}

export async function getCodexPlugins(): Promise<CodexPluginSnapshot> {
  return await http.get("/api/codex-plugins");
}

export async function installCodexPluginApi(selector: string): Promise<CodexPluginSnapshot> {
  const result = await http.post<{ snapshot: CodexPluginSnapshot }>("/api/codex-plugins/install", {
    selector,
  });
  return result.snapshot;
}

export async function uninstallCodexPluginApi(selector: string): Promise<CodexPluginSnapshot> {
  const result = await http.post<{ snapshot: CodexPluginSnapshot }>(
    "/api/codex-plugins/uninstall",
    { selector },
  );
  return result.snapshot;
}

export async function createLocalCodexPluginApi(input: {
  name: string;
  displayName?: string;
  description?: string;
}): Promise<CodexPluginSnapshot> {
  return await http.post("/api/codex-plugins/local", input);
}

export async function importLocalCodexPluginApi(path: string): Promise<CodexPluginSnapshot> {
  return await http.post("/api/codex-plugins/import-local", { path });
}

export async function removeLocalCodexPluginApi(
  name: string,
  deleteSource: boolean,
): Promise<CodexPluginSnapshot> {
  const qs = new URLSearchParams({
    deleteSource: deleteSource ? "true" : "false",
  }).toString();
  return await http.delete(`/api/codex-plugins/local/${encodeURIComponent(name)}?${qs}`);
}

export async function addCodexMarketplaceApi(source: string): Promise<CodexPluginSnapshot> {
  const result = await http.post<{ snapshot: CodexPluginSnapshot }>(
    "/api/codex-plugins/marketplaces",
    { source },
  );
  return result.snapshot;
}

// Claude Plugins

export interface ClaudePluginRecord {
  name: string;
  marketplace?: string;
  selector: string;
  displayName: string;
  version?: string;
  description?: string;
  icon?: string;
  iconColor?: string;
  scope?: string;
  installCount?: number;
  status: {
    installed: boolean;
    available: boolean;
    enabled: boolean;
    cached: boolean;
    local: boolean;
  };
  source: {
    kind: "marketplace" | "cache" | "settings";
    path?: string;
  };
}

export interface ClaudeMarketplaceRecord {
  name: string;
  source?: string;
  repo?: string;
  url?: string;
  path?: string;
}

export interface ClaudePluginSnapshot {
  plugins: ClaudePluginRecord[];
  marketplaces: ClaudeMarketplaceRecord[];
  warnings: string[];
  paths: {
    claudeDir: string;
    settings: string;
    localSettings: string;
    pluginCache: string;
    marketplaces: string;
    skills: string;
  };
}

export async function getClaudePlugins(): Promise<ClaudePluginSnapshot> {
  return await http.get("/api/claude-plugins");
}

export async function installClaudePluginApi(selector: string): Promise<ClaudePluginSnapshot> {
  const result = await http.post<{ snapshot: ClaudePluginSnapshot }>(
    "/api/claude-plugins/install",
    { selector },
  );
  return result.snapshot;
}

export async function uninstallClaudePluginApi(
  selector: string,
  scope?: string,
): Promise<ClaudePluginSnapshot> {
  const result = await http.post<{ snapshot: ClaudePluginSnapshot }>(
    "/api/claude-plugins/uninstall",
    { selector, ...(scope ? { scope } : {}) },
  );
  return result.snapshot;
}

export async function enableClaudePluginApi(selector: string): Promise<ClaudePluginSnapshot> {
  const result = await http.post<{ snapshot: ClaudePluginSnapshot }>("/api/claude-plugins/enable", {
    selector,
  });
  return result.snapshot;
}

export async function disableClaudePluginApi(selector: string): Promise<ClaudePluginSnapshot> {
  const result = await http.post<{ snapshot: ClaudePluginSnapshot }>(
    "/api/claude-plugins/disable",
    { selector },
  );
  return result.snapshot;
}

export async function addClaudeMarketplaceApi(source: string): Promise<ClaudePluginSnapshot> {
  const result = await http.post<{ snapshot: ClaudePluginSnapshot }>(
    "/api/claude-plugins/marketplaces",
    { source },
  );
  return result.snapshot;
}

// Workflows

export type AdapterConfigField = {
  key: string;
  label: string;
  type: "text" | "select" | "number" | "boolean";
  required?: boolean;
  defaultValue?: unknown;
  options?: Array<{ value: string; label: string }>;
};
export interface AdapterMetadata {
  id: string;
  name: string;
  kind: "agent" | "harness";
  capabilities: Record<string, boolean>;
  configSchema: { fields: AdapterConfigField[] };
}
export async function getAdapters(): Promise<AdapterMetadata[]> {
  const result = await http.get<{ adapters: AdapterMetadata[] }>("/api/adapters");
  return result.adapters;
}

export type WorkflowProviderKind = "codex-cli" | "claude-cli";
export type WorkflowNodeKind =
  | "agent"
  | "input"
  | "variable"
  | "trigger"
  | "manual-trigger"
  | "cron"
  | "webhook-trigger"
  | "command"
  | "web"
  | "http-request"
  | "set"
  | "if"
  | "diff-approval"
  | "git-commit"
  | "git-checkout"
  | "git-delete-branch"
  | "github-pr"
  | "merge"
  | "code"
  | "loop-items"
  | "wait"
  | "json"
  | "file-read"
  | "file-write"
  | "markdown"
  | "mcp"
  | "codex-plugin"
  | "claude-plugin"
  | "codex-skill"
  | "claude-skill";
export type WorkflowNodeStatus = "idle" | "running" | "success" | "error";
export type WorkflowRunStatus = "idle" | "running" | "success" | "error" | "stopped";

export interface WorkflowNode {
  id: string;
  blockId?: number;
  kind?: WorkflowNodeKind;
  title: string;
  providerKind: WorkflowProviderKind;
  adapterId?: string;
  model: string;
  prompt: string;
  x: number;
  y: number;
  status: WorkflowNodeStatus;
  summary?: string;
  rawOutput?: string;
  error?: string;
  config?: Record<string, unknown>;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  passSummary: boolean;
  sourceHandle?: string;
}

export interface WorkflowRun {
  id: string;
  status: WorkflowRunStatus;
  startedAt: number;
  completedAt?: number;
  nodeIds: string[];
  error?: string;
  trace?: WorkflowRunTrace[];
  stats?: WorkflowRunStats;
  resumable?: boolean;
  resumeFingerprint?: string;
}

export interface WorkflowRunTrace {
  nodeId: string;
  title: string;
  kind: WorkflowNodeKind;
  model?: string;
  status: WorkflowNodeStatus | "stopped";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  retryReasons?: string[];
  terminal?: {
    commandLine?: string;
    stdout?: string;
    stderr?: string;
    transcript?: string;
    exitCode?: number | null;
    signal?: string | null;
  };
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  providerId?: string;
  billingMultiplier?: number;
}

export interface WorkflowRunStats {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  nodeCount?: number;
  retryCount?: number;
}

export interface WorkflowRecord {
  id: string;
  title: string;
  readme: string;
  templateBinding?: {
    source: TemplateSource;
    id: string;
  };
  createdAt: number;
  updatedAt: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  runs: WorkflowRun[];
}

export type WorkflowRuntimeEvent =
  | { type: "ready"; updatedAt: number }
  | { type: "node"; updatedAt: number; node: WorkflowNode }
  | { type: "run"; updatedAt: number; run: WorkflowRun };

export interface WorkflowSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  edgeCount: number;
  status: WorkflowRunStatus;
}

export type WorkflowUsageRange = "7d" | "30d" | "all";

export interface WorkflowUsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface WorkflowUsageStatistics {
  generatedAt: number;
  range: WorkflowUsageRange;
  totals: WorkflowUsageTotals;
  daily: Array<{ date: string; runs: number; tokens: number; cost: number }>;
  workflows: Array<{
    workflowId: string;
    title: string;
    runs: number;
    tokens: number;
    cost: number;
  }>;
  models: Array<{ model: string; runs: number; tokens: number; cost: number }>;
  recentRuns: Array<{
    workflowId: string;
    workflowTitle: string;
    runId: string;
    status: WorkflowRunStatus;
    startedAt: number;
    completedAt?: number;
    tokens: number;
    cost: number;
  }>;
}

export interface AllProjectsWorkflowUsage {
  generatedAt: number;
  range: WorkflowUsageRange;
  projectCount: number;
  totals: WorkflowUsageTotals;
}

const workflowsUrl = (id: string, suffix = "") =>
  `/api/workspaces/${encodeURIComponent(id)}/workflows${suffix}`;

export async function listWorkflows(workspaceId: string): Promise<WorkflowSummary[]> {
  const { workflows } = await http.get<{ workflows: WorkflowSummary[] }>(workflowsUrl(workspaceId));
  return workflows;
}

export async function getWorkflow(
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowRecord> {
  return await http.get(workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}`));
}

export function openWorkflowRuntimeSocket(workspaceId: string, workflowId: string): WebSocket {
  return openTerminalSocket(workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}/events`));
}

export function openAdapterEventsSocket(workspaceId?: string): WebSocket {
  const suffix = workspaceId ? `?workspaceId=${encodeURIComponent(workspaceId)}` : "";
  return openTerminalSocket(`/api/adapter-events${suffix}`);
}

export async function createWorkflow(
  workspaceId: string,
  partial: Partial<WorkflowRecord> = {},
): Promise<WorkflowRecord> {
  return await http.post(workflowsUrl(workspaceId), partial);
}

export async function saveWorkflow(
  workspaceId: string,
  record: WorkflowRecord,
): Promise<WorkflowRecord> {
  return await http.put(workflowsUrl(workspaceId, `/${encodeURIComponent(record.id)}`), record);
}

export async function getWorkflowUsageStatistics(
  workspaceId: string,
  range: WorkflowUsageRange,
): Promise<WorkflowUsageStatistics> {
  const query = new URLSearchParams({
    range,
    timezoneOffset: String(new Date().getTimezoneOffset()),
  });
  return await http.get<WorkflowUsageStatistics>(workflowsUrl(workspaceId, `/usage?${query}`));
}

export async function getAllProjectsWorkflowUsage(
  range: WorkflowUsageRange,
): Promise<AllProjectsWorkflowUsage> {
  const query = new URLSearchParams({
    range,
    timezoneOffset: String(new Date().getTimezoneOffset()),
  });
  return await http.get<AllProjectsWorkflowUsage>(`/api/workflow-usage?${query}`);
}

export async function saveWorkflowContent(
  workspaceId: string,
  record: WorkflowRecord,
): Promise<WorkflowRecord> {
  return await http.patch(
    workflowsUrl(workspaceId, `/${encodeURIComponent(record.id)}/content`),
    record,
  );
}

export async function renameWorkflow(
  workspaceId: string,
  workflowId: string,
  title: string,
): Promise<WorkflowRecord> {
  return await http.patch(workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}/title`), {
    title,
  });
}

export async function runWorkflow(
  workspaceId: string,
  workflowId: string,
  language: "zh-CN" | "en",
  nodeIds?: string[],
  resume = false,
): Promise<{ runId: string; workflow: WorkflowRecord }> {
  return await http.post(workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}/run`), {
    nodeIds,
    language,
    resume,
  });
}

export async function pauseWorkflow(
  workspaceId: string,
  workflowId: string,
): Promise<{ ok: boolean; paused: boolean }> {
  return await http.post(workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}/pause`));
}

export async function stopWorkflow(
  workspaceId: string,
  workflowId: string,
): Promise<{ ok: boolean; stopped: boolean }> {
  return await http.post(workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}/stop`));
}

export async function resolveWorkflowApproval(
  workspaceId: string,
  workflowId: string,
  nodeId: string,
  approved: boolean,
): Promise<{ ok: boolean }> {
  return await http.post(
    workflowsUrl(
      workspaceId,
      `/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/approval`,
    ),
    { approved },
  );
}

export async function resolveWorkflowInput(
  workspaceId: string,
  workflowId: string,
  nodeId: string,
  value: string,
): Promise<{ ok: boolean }> {
  return await http.post(
    workflowsUrl(
      workspaceId,
      `/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/input`,
    ),
    { value },
  );
}

export async function retryWorkflowNodeNow(
  workspaceId: string,
  workflowId: string,
  nodeId: string,
): Promise<{ ok: boolean }> {
  return await http.post(
    workflowsUrl(
      workspaceId,
      `/${encodeURIComponent(workflowId)}/nodes/${encodeURIComponent(nodeId)}/retry-now`,
    ),
  );
}

export async function deleteWorkflow(workspaceId: string, workflowId: string): Promise<void> {
  await http.delete(workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}`));
}

// ─── AI proxy ───

export type TemplateSource = "system" | "user";

export interface WorkflowTemplateSummary {
  id: string;
  source: TemplateSource;
  title: string;
  description: string;
  icon?: string;
  updatedAt: number;
  nodeCount: number;
}

export interface WorkflowTemplate {
  id: string;
  source: TemplateSource;
  title: string;
  description: string;
  readme: string;
  icon?: string;
  createdAt: number;
  updatedAt: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
}

export async function listWorkflowTemplates(): Promise<{
  system: WorkflowTemplateSummary[];
  user: WorkflowTemplateSummary[];
  developerMode: boolean;
}> {
  return await http.get("/api/templates");
}

export async function getTemplateCapabilities(): Promise<{
  developerMode: boolean;
}> {
  return await http.get("/api/templates/capabilities");
}

export async function getWorkflowTemplate(
  source: TemplateSource,
  templateId: string,
): Promise<WorkflowTemplate> {
  return await http.get(`/api/templates/${source}/${encodeURIComponent(templateId)}`);
}

export async function saveWorkflowAsTemplate(
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowTemplate> {
  return await http.post(workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}/template`));
}

export async function saveWorkflowAsSystemTemplate(
  workspaceId: string,
  workflowId: string,
): Promise<WorkflowTemplate> {
  return await http.post(
    workflowsUrl(workspaceId, `/${encodeURIComponent(workflowId)}/system-template`),
  );
}

export async function editWorkflowTemplate(
  workspaceId: string,
  source: TemplateSource,
  templateId: string,
): Promise<WorkflowRecord> {
  return await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/templates/${source}/${encodeURIComponent(templateId)}/edit`,
  );
}

export async function updateWorkflowTemplateIcon(
  source: TemplateSource,
  templateId: string,
  icon: string,
): Promise<WorkflowTemplate> {
  return await http.put(`/api/templates/${source}/${encodeURIComponent(templateId)}/icon`, {
    icon,
  });
}

export async function deleteWorkflowTemplate(
  source: TemplateSource,
  templateId: string,
): Promise<void> {
  await http.delete(`/api/templates/${source}/${encodeURIComponent(templateId)}`);
}

// Remote MCP

export interface RemoteMcpTool {
  name: string;
  description?: string;
  inputSchema?: unknown;
  [key: string]: unknown;
}

export interface RemoteMcpConnectionInput {
  remoteLink: string;
  postUrl?: string;
  headers?: Record<string, string>;
  apiKey?: string;
}

export interface RemoteMcpDiscovery {
  remoteLink: string;
  postUrl: string;
  tools: RemoteMcpTool[];
  raw: unknown;
  connectedAt: number;
}

export interface RemoteMcpCallResult {
  remoteLink: string;
  postUrl: string;
  ok: boolean;
  status?: "success" | "failed";
  result?: unknown;
  error?: unknown;
  response: unknown;
}

const mcpUrl = (id: string, suffix: string) =>
  `/api/workspaces/${encodeURIComponent(id)}/mcp${suffix}`;

export async function discoverRemoteMcp(
  workspaceId: string,
  input: RemoteMcpConnectionInput,
): Promise<RemoteMcpDiscovery> {
  return await http.post(mcpUrl(workspaceId, "/discover"), input);
}

export async function callRemoteMcp(
  workspaceId: string,
  input: RemoteMcpConnectionInput & {
    name: string;
    arguments?: Record<string, unknown>;
  },
): Promise<RemoteMcpCallResult> {
  return await http.post(mcpUrl(workspaceId, "/call"), input);
}

export interface AiChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** present when role === "tool"  - used to correlate with the originating tool_call */
  tool_call_id?: string;
}

export async function fetchProviderModels(
  workspaceId: string,
  kind: "claude-cli" | "codex-cli" = "claude-cli",
): Promise<string[]> {
  const { models } = await http.post<{ models: string[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/models`,
    { kind },
  );
  return models;
}

export async function aiChat(
  workspaceId: string,
  input: {
    model: string;
    messages: AiChatMessage[];
    kind?: "claude-cli" | "codex-cli";
  },
): Promise<{ content: string }> {
  return await http.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/ai/chat`, input);
}

/**
 * Stream a chat completion from the backend SSE endpoint.
 *
 * Calls `onDelta` for each token (or larger chunk) the server emits.
 * Resolves with the full concatenated text once the server emits `done`.
 * If the user aborts via `signal`, the partial text accumulated so far is
 * returned (no rejection) so the caller can persist whatever was generated.
 * Network or upstream errors reject with an Error whose message is the
 * server-supplied reason (or fetch failure).
 */
async function aiChatStreamOnce(
  workspaceId: string,
  input: {
    model: string;
    messages: AiChatMessage[];
    kind?: "claude-cli" | "codex-cli";
    reasoning?: { effort: "off" | "minimal" | "low" | "medium" | "high" };
  },
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
  onReasoningDelta?: (chunk: string) => void,
  onLog?: (entry: { stream: "stdout" | "stderr"; content: string }) => void,
): Promise<{ content: string; aborted: boolean }> {
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/chat/stream`;

  let res: Response;
  try {
    res = await apiFetch(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(input),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return { content: "", aborted: true };
    }
    throw e;
  }

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(txt) as ApiErrorBody;
      msg = parsed.error?.message ?? msg;
    } catch {
      if (txt) msg = txt;
    }
    throw new ApiClientError(res.status, "STREAM_FAILED", msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let acc = "";
  let event = "";
  let dataLine = "";
  let serverError: string | null = null;
  let aborted = false;
  let done = false;

  const flushEvent = () => {
    if (!event && !dataLine) return;
    if (event === "delta") {
      try {
        const obj = JSON.parse(dataLine) as { content?: string };
        const piece = typeof obj.content === "string" ? obj.content : "";
        if (piece) {
          acc += piece;
          onDelta(piece);
        }
      } catch {
        /* ignore malformed payload */
      }
    } else if (event === "reasoning") {
      try {
        const obj = JSON.parse(dataLine) as { content?: string };
        const piece = typeof obj.content === "string" ? obj.content : "";
        if (piece) onReasoningDelta?.(piece);
      } catch {
        /* ignore malformed payload */
      }
    } else if (event === "log") {
      try {
        const obj = JSON.parse(dataLine) as {
          stream?: "stdout" | "stderr";
          content?: string;
        };
        if (
          (obj.stream === "stdout" || obj.stream === "stderr") &&
          typeof obj.content === "string"
        ) {
          onLog?.({ stream: obj.stream, content: obj.content });
        }
      } catch {
        /* ignore malformed payload */
      }
    } else if (event === "done") {
      done = true;
    } else if (event === "error") {
      try {
        const obj = JSON.parse(dataLine) as { message?: string };
        serverError = obj.message ?? "stream error";
      } catch {
        serverError = "stream error";
      }
    }
    event = "";
    dataLine = "";
  };

  try {
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = raw.replace(/\r$/, "");
        if (line === "") {
          flushEvent();
          continue;
        }
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          // Append (in case of multi-line data  - rare here but safe)
          const piece = line.slice(5).trimStart();
          dataLine = dataLine ? `${dataLine}\n${piece}` : piece;
        }
      }
    }
    flushEvent();
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      aborted = true;
    } else {
      throw e;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  if (serverError && !aborted) {
    throw new ApiClientError(502, "UPSTREAM_FAILED", serverError);
  }

  return { content: acc, aborted };
}

export async function aiChatStream(
  workspaceId: string,
  input: {
    model: string;
    messages: AiChatMessage[];
    kind?: "claude-cli" | "codex-cli";
    reasoning?: { effort: "off" | "minimal" | "low" | "medium" | "high" };
  },
  onDelta: (chunk: string) => void,
  signal?: AbortSignal,
  onReasoningDelta?: (chunk: string) => void,
  onLog?: (entry: { stream: "stdout" | "stderr"; content: string }) => void,
): Promise<{ content: string; aborted: boolean }> {
  const maxRetries = 3;
  const maxAttempts = 1 + maxRetries;
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let emitted = false;
    try {
      const result = await aiChatStreamOnce(
        workspaceId,
        input,
        (chunk) => {
          emitted = true;
          onDelta(chunk);
        },
        signal,
        (chunk) => {
          emitted = true;
          onReasoningDelta?.(chunk);
        },
        onLog,
      );
      return result;
    } catch (e) {
      lastError = e;
      if (signal?.aborted || emitted || !isRetryableStreamError(e) || attempt >= maxAttempts) {
        throw e;
      }
      await sleep(350 * attempt, signal);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export interface AiTerminalFrame {
  type: "session" | "conversation" | "status";
  sessionId?: string;
  data?: string;
  status?:
    | "starting"
    | "prompt-sent"
    | "waiting-for-choice"
    | "ready-for-success"
    | "auto-error"
    | "auto-finished"
    | "manual-success"
    | "exited";
}

export interface AiTerminalResult {
  sessionId: string;
  conversationSessionId?: string;
  content: string;
  transcript: string;
  changedFiles: string[];
  verification: string[];
  exitCode: number | null;
  signal: number | string | null;
  outcome?: "success" | "error" | "cancelled" | "user-rejected";
  errorMessage?: string;
}

export type AiTerminalMode = "default" | "goal" | "plan";
export type AiTerminalClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";
export type AiTerminalCodexApproval = "untrusted" | "on-request" | "never";
export type AiTerminalCodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AiTerminalEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultracode";

export async function aiChatTerminalStream(
  workspaceId: string,
  input: {
    model: string;
    messages: AiChatMessage[];
    kind?: "claude-cli" | "codex-cli";
    terminalPrompt?: string;
    autoSuccess?: boolean;
    claudePermissionMode?: AiTerminalClaudePermissionMode;
    mode?: AiTerminalMode;
    codexApproval?: AiTerminalCodexApproval;
    codexSandbox?: AiTerminalCodexSandbox;
    effort?: AiTerminalEffort;
    alwaysEnter?: boolean;
    keepRunningOnInterrupt?: boolean;
    conversationSessionId?: string;
    requestedConversationSessionId?: string;
    resumeConversation?: boolean;
  },
  onFrame: (frame: AiTerminalFrame) => void,
  signal?: AbortSignal,
): Promise<{ result: AiTerminalResult | null; aborted: boolean }> {
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/chat/terminal`;
  let res: Response;
  try {
    res = await apiFetch(url, {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(input),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return { result: null, aborted: true };
    throw e;
  }

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(txt) as ApiErrorBody;
      msg = parsed.error?.message ?? msg;
    } catch {
      if (txt) msg = txt;
    }
    throw new ApiClientError(res.status, "TERMINAL_STREAM_FAILED", msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let dataLine = "";
  let result: AiTerminalResult | null = null;
  let serverError: string | null = null;
  let aborted = false;
  let done = false;

  const flushEvent = () => {
    if (!event && !dataLine) return;
    if (event === "result") {
      try {
        result = JSON.parse(dataLine) as AiTerminalResult;
      } catch {
        serverError = "malformed terminal result";
      }
    } else if (event === "done") {
      done = true;
    } else if (event === "error") {
      try {
        const obj = JSON.parse(dataLine) as { message?: string };
        serverError = obj.message ?? "terminal stream error";
      } catch {
        serverError = "terminal stream error";
      }
    } else if (event) {
      try {
        onFrame(JSON.parse(dataLine) as AiTerminalFrame);
      } catch {
        /* ignore malformed payload */
      }
    }
    event = "";
    dataLine = "";
  };

  try {
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = raw.replace(/\r$/, "");
        if (line === "") {
          flushEvent();
          continue;
        }
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const piece = line.slice(5).trimStart();
          dataLine = dataLine ? `${dataLine}\n${piece}` : piece;
        }
      }
    }
    flushEvent();
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      aborted = true;
    } else {
      throw e;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  if (serverError && !aborted) {
    throw new ApiClientError(502, "TERMINAL_STREAM_FAILED", serverError);
  }
  return { result, aborted };
}

export async function setAiTerminalAutoSuccess(
  workspaceId: string,
  sessionId: string,
  autoSuccess: boolean,
): Promise<void> {
  await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/chat/terminal/${encodeURIComponent(
      sessionId,
    )}/auto-success`,
    { autoSuccess },
  );
}

export async function pauseAiTerminal(workspaceId: string, sessionId: string): Promise<void> {
  await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/chat/terminal/${encodeURIComponent(
      sessionId,
    )}/pause`,
  );
}

export async function finishAiTerminalSuccess(
  workspaceId: string,
  sessionId: string,
): Promise<void> {
  await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/chat/terminal/${encodeURIComponent(
      sessionId,
    )}/success`,
  );
}

function isRetryableStreamError(e: unknown): boolean {
  if (e instanceof ApiClientError) {
    if (e.status === 408 || e.status === 425 || e.status === 429) return true;
    return e.status >= 500 && e.status < 600;
  }
  return true;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const id = window.setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        window.clearTimeout(id);
        resolve();
      },
      { once: true },
    );
  });
}

// ─── AI tool exec (osheep code) ───

export type ToolKind = "read" | "write" | "run";

export interface ReadFileArgs {
  kind: "file";
  path: string;
  startLine?: number;
  lineCount?: number;
}
export interface ReadListArgs {
  kind: "list";
  path: string;
  includeHidden?: boolean;
}
export interface ReadSearchArgs {
  kind: "search";
  query: string;
  include?: string | string[];
  exclude?: string | string[];
}
export type ReadArgs = ReadFileArgs | ReadListArgs | ReadSearchArgs;

export interface WriteFileArgs {
  kind: "write_file";
  path: string;
  content: string;
  createParents?: boolean;
}
export interface AppendFileArgs {
  kind: "append_file";
  path: string;
  content: string;
}
export interface EditFileArgs {
  kind: "edit_file";
  path: string;
  oldString: string;
  newString: string;
}
export interface MultiEditArgs {
  kind: "multi_edit";
  path: string;
  edits: Array<{ oldString: string; newString: string }>;
}
export interface MoveArgs {
  kind: "move";
  from: string;
  to: string;
}
export interface DeleteArgs {
  kind: "delete";
  path: string;
  recursive?: boolean;
}
export interface CreateArgs {
  kind: "create";
  path: string;
  entryKind?: "file" | "directory";
}
export type WriteArgs =
  | WriteFileArgs
  | AppendFileArgs
  | EditFileArgs
  | MultiEditArgs
  | MoveArgs
  | DeleteArgs
  | CreateArgs;

export interface RunArgs {
  command: string;
  cwd?: string;
  shell?: string;
  timeoutMs?: number;
}

export interface RunResult {
  command: string;
  cwd: string;
  shell?: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  attempts?: Array<{
    shell: string;
    exitCode: number | null;
    signal: string | null;
    durationMs: number;
  }>;
}

/**
 * Structured diff payload returned by `edit_file`. Used by the chat UI to
 * render an inline thumbnail and (on click) a full Monaco DiffEditor tab.
 *
 * `before` / `after` are full file contents  - heavy fields that the chat
 * runtime strips before sending the tool result back to the model so the
 * conversation context doesn't double-quote the whole file.
 */
export interface EditFileDiff {
  oldString: string;
  newString: string;
  startLine: number;
  endLineBefore: number;
  endLineAfter: number;
  added: number;
  removed: number;
  before: string;
  after: string;
}

export interface EditFileResult {
  ok: true;
  kind: "edit_file";
  path: string;
  size: number;
  mtime: number;
  replacements: number;
  diff: EditFileDiff;
}

/**
 * Per-edit diff entry inside a `multi_edit` result. Same shape as
 * `EditFileDiff` minus the heavy `before` / `after` strings  - those live once
 * at the top of the multi_edit `diff` payload covering the whole file
 * before/after the entire batch.
 */
export interface MultiEditEntry {
  oldString: string;
  newString: string;
  startLine: number;
  endLineBefore: number;
  endLineAfter: number;
  added: number;
  removed: number;
}

export interface MultiEditDiff {
  edits: MultiEditEntry[];
  added: number;
  removed: number;
  before: string;
  after: string;
}

export interface MultiEditResult {
  ok: true;
  kind: "multi_edit";
  path: string;
  size: number;
  mtime: number;
  replacements: number;
  diff: MultiEditDiff;
}

export async function execRead(workspaceId: string, args: ReadArgs): Promise<unknown> {
  return await http.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/ai/exec/read`, args);
}

export async function execWrite(workspaceId: string, args: WriteArgs): Promise<unknown> {
  return await http.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/ai/exec/write`, args);
}

export async function execRun(workspaceId: string, args: RunArgs): Promise<RunResult> {
  return await http.post(`/api/workspaces/${encodeURIComponent(workspaceId)}/ai/exec/run`, args);
}

export async function execRunStream(
  workspaceId: string,
  args: RunArgs,
  options: {
    signal?: AbortSignal;
    onLog?: (entry: { stream: "stdout" | "stderr"; content: string; shell?: string }) => void;
  } = {},
): Promise<{ result: RunResult | null; aborted: boolean }> {
  const url = `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/exec/run/stream`;
  let res: Response;
  try {
    res = await apiFetch(url, {
      method: "POST",
      signal: options.signal,
      headers: {
        "content-type": "application/json",
        accept: "text/event-stream",
      },
      body: JSON.stringify(args),
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return { result: null, aborted: true };
    throw e;
  }

  if (!res.ok || !res.body) {
    const txt = await res.text().catch(() => "");
    let msg = `HTTP ${res.status}`;
    try {
      const parsed = JSON.parse(txt) as ApiErrorBody;
      msg = parsed.error?.message ?? msg;
    } catch {
      if (txt) msg = txt;
    }
    throw new ApiClientError(res.status, "STREAM_FAILED", msg);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8");
  let buffer = "";
  let event = "";
  let dataLine = "";
  let result: RunResult | null = null;
  let serverError: string | null = null;
  let aborted = false;
  let done = false;

  const flushEvent = () => {
    if (!event && !dataLine) return;
    if (event === "log") {
      try {
        const obj = JSON.parse(dataLine) as {
          stream?: "stdout" | "stderr";
          content?: string;
          shell?: string;
        };
        if (
          (obj.stream === "stdout" || obj.stream === "stderr") &&
          typeof obj.content === "string"
        ) {
          options.onLog?.({ stream: obj.stream, content: obj.content, shell: obj.shell });
        }
      } catch {
        /* ignore malformed payload */
      }
    } else if (event === "result") {
      try {
        result = JSON.parse(dataLine) as RunResult;
      } catch {
        serverError = "malformed run result";
      }
    } else if (event === "done") {
      done = true;
    } else if (event === "error") {
      try {
        const obj = JSON.parse(dataLine) as { message?: string };
        serverError = obj.message ?? "stream error";
      } catch {
        serverError = "stream error";
      }
    }
    event = "";
    dataLine = "";
  };

  try {
    while (!done) {
      const r = await reader.read();
      if (r.done) break;
      buffer += decoder.decode(r.value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const raw = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        const line = raw.replace(/\r$/, "");
        if (line === "") {
          flushEvent();
          continue;
        }
        if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          const piece = line.slice(5).trimStart();
          dataLine = dataLine ? `${dataLine}\n${piece}` : piece;
        }
      }
    }
    flushEvent();
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      aborted = true;
    } else {
      throw e;
    }
  } finally {
    try {
      await reader.cancel();
    } catch {
      /* ignore */
    }
  }

  if (serverError && !aborted) {
    throw new ApiClientError(502, "RUN_STREAM_FAILED", serverError);
  }

  return { result, aborted };
}

// ─── osheep code tag-aware streaming ───
//
// The backend `/ai/chat/stream` still emits a raw delta stream. osheep code's
// tag protocol (<tasks>/<thought>/<tool>/<ask>/<verify>) is parsed here, on the
// client. The caller passes semantic callbacks instead of a single onDelta.

export interface OsheepCodeStreamHandlers {
  onPlan?: (items: string[]) => void;
  /**
   * Fired once when a thought / reasoning node begins, so the UI can show a
   * placeholder ("正在思考 - ) with the running animation. No per-token deltas
   * are emitted  - see `onThought` for the atomic fill.
   */
  onThoughtStart?: (id: string) => void;
  /**
   * Fired once when a thought / reasoning node is complete, carrying the FULL
   * text. osheep code renders each timeline node atomically: the upstream
   * request still streams, but a node only materialises (or fills its
   * placeholder) once it has fully closed  - we never repaint a node mid-token.
   */
  onThought?: (id: string, text: string) => void;
  onTextDelta?: (chunk: string) => void;
  onToolCall?: (call: { id: string; tool: ToolKind; args: unknown }) => void;
  onAsk?: (ask: { id: string; question: string; options: string[] }) => void;
  onVerify?: (text: string) => void;
}

class TagStreamParser {
  private buffer = "";
  private state:
    | "outside"
    | "in_plan"
    | "in_thought"
    | "in_tool"
    | "in_tool_result"
    | "in_ask"
    | "in_verify" = "outside";
  private tagSeq = 0;
  private currentId = "";
  private reasoningId: string | null = null;
  private accReasoning = "";
  // Tool open-tag may carry attrs like name="run". We capture the full opening
  // tag text until we see the matching `>` before we know what tool it is.
  private toolName: ToolKind | null = null;
  private accInTag = "";
  private expectedCloseTag = "";

  constructor(private readonly h: OsheepCodeStreamHandlers) {}

  feed(chunk: string) {
    // A thought/reasoning node renders atomically: as soon as the model
    // starts emitting tagged/plain content, the preceding reasoning phase is
    // over, so flush it as one complete node (filling its placeholder).
    this.flushReasoning();
    this.buffer += chunk;
    this.drain();
  }

  feedReasoning(chunk: string) {
    if (!chunk) return;
    if (!this.reasoningId) {
      this.reasoningId = this.nextId("rt");
      this.accReasoning = "";
      // Placeholder only  - content is buffered and emitted whole on flush.
      this.h.onThoughtStart?.(this.reasoningId);
    }
    this.accReasoning += chunk;
  }

  /** Emit the buffered reasoning node atomically, if any is open. */
  private flushReasoning() {
    if (!this.reasoningId) return;
    this.h.onThought?.(this.reasoningId, this.accReasoning.trim());
    this.reasoningId = null;
    this.accReasoning = "";
  }

  finish() {
    // Flush a still-open reasoning node as one complete thought.
    this.flushReasoning();
    // Flush any pending text or in-tag content as best-effort.
    if (this.state === "outside" && this.buffer) {
      this.emitText(this.buffer);
      this.buffer = "";
    }
    // Unclosed tags: surface accumulated content so the user sees something,
    // except tool_result echoes which are never user-facing. An unclosed
    // <thought> still fills its placeholder atomically via onThought.
    if (this.state !== "outside" && this.state !== "in_tool_result" && this.accInTag) {
      if (this.state === "in_thought" && this.currentId) {
        this.h.onThought?.(this.currentId, this.accInTag.trim());
      } else {
        this.emitText(this.accInTag);
      }
      this.accInTag = "";
    }
    this.state = "outside";
    this.expectedCloseTag = "";
  }

  private emitText(t: string) {
    if (!t) return;
    this.h.onTextDelta?.(t);
  }

  private nextId(prefix: string): string {
    this.tagSeq += 1;
    return `${prefix}_${this.tagSeq}`;
  }

  /**
   * Pull complete tag events out of the buffer. Anything that *might* be the
   * start of a tag is left in the buffer (we don't emit a partial `<` as
   * normal text because we may still be mid-tag).
   */
  private drain() {
    // Loop until we can't make progress.
    // eslint-disable-next-line no-constant-condition
    while (true) {
      if (this.state === "outside") {
        // Safety net: some models forget the `<tool name="...">` wrapper and
        // emit "Write\n{...}" inline. Without this, the entire JSON (including
        // multi-KB `content` fields) gets streamed verbatim into the chat and
        // no tool_call event ever fires, so the confirm bar never appears.
        // Detect the pattern and synthesize a proper tool_call instead.
        const bareIdx = this.findBareToolStart();
        if (bareIdx === 0) {
          const consumed = this.tryConsumeBareToolCall();
          if (consumed === "ok") continue;
          if (consumed === "wait") return;
          // "skip"  - pattern didn't actually resolve to a tool call, fall
          // through to normal `<` handling so we emit a single char as text
          // and keep scanning.
        } else if (bareIdx > 0) {
          // Emit text up to the bare pattern, then loop and let the next
          // iteration pick it up at offset 0.
          this.emitText(this.buffer.slice(0, bareIdx));
          this.buffer = this.buffer.slice(bareIdx);
          continue;
        }

        const ltIdx = this.buffer.indexOf("<");
        if (ltIdx === -1) {
          // No complete node yet. Keep buffering plain text so the UI only
          // receives completed nodes, not token-by-token deltas.
          return;
        }
        // Emit everything before the `<` as text.
        if (ltIdx > 0) {
          this.emitText(this.buffer.slice(0, ltIdx));
          this.buffer = this.buffer.slice(ltIdx);
        }
        // Try to recognise an opening tag we care about.
        // The opening tag completes at the next `>` (`<tool ...>` may have attrs).
        const gtIdx = this.buffer.indexOf(">");
        if (gtIdx === -1) {
          // Wait for more.
          return;
        }
        const opening = this.buffer.slice(0, gtIdx + 1);
        const matched = this.tryEnterTag(opening);
        if (matched) {
          this.buffer = this.buffer.slice(gtIdx + 1);
          continue;
        }
        // Some upstreams/models echo host tool-result tags in the assistant
        // stream. They are protocol noise, not user-facing text; consume them
        // as a whole so raw JSON never appears in the timeline.
        if (/^<tool_result\b[^>]*>$/i.test(opening)) {
          this.state = "in_tool_result";
          this.expectedCloseTag = "</tool_result>";
          this.accInTag = "";
          this.buffer = this.buffer.slice(gtIdx + 1);
          continue;
        }
        // Not a tag we recognise  - emit the `<` as text and continue scanning.
        this.emitText("<");
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // Inside a tag  - find the matching closing tag.
      const closeTag = this.closingFor(this.state);
      const cIdx = this.buffer.indexOf(closeTag);
      if (cIdx === -1) {
        // Buffer everything we have as in-tag content, but keep a small tail
        // in case the close tag spans the boundary.
        const safe = Math.max(0, this.buffer.length - closeTag.length + 1);
        if (safe > 0) {
          const part = this.buffer.slice(0, safe);
          this.onInTagChunk(part);
          this.buffer = this.buffer.slice(safe);
        }
        return;
      }
      // Flush the slice before the closing tag, then close.
      const tail = this.buffer.slice(0, cIdx);
      if (tail) this.onInTagChunk(tail);
      this.buffer = this.buffer.slice(cIdx + closeTag.length);
      this.onCloseTag();
    }
  }

  /**
   * Returns the index of the next bare `(Read|Write|Run)\n{` tool-shaped
   * preamble in the buffer, or -1 if none. The match must be either at the
   * very start of the buffer or preceded by a newline so we don't trigger on
   * casual prose mentioning "Run" / "Read".
   */
  private findBareToolStart(): number {
    // Match at start-of-buffer first (the common case after we've already
    // sliced previous content).
    if (/^\s*(?:Read|Write|Run|read|write|run)\s*\r?\n\s*\{/.test(this.buffer)) {
      return this.buffer.search(/(?:Read|Write|Run|read|write|run)\s*\r?\n\s*\{/);
    }
    // Otherwise require a leading newline before the keyword.
    const m = this.buffer.match(/\n[ \t]*(?:Read|Write|Run|read|write|run)\s*\r?\n\s*\{/);
    if (!m || m.index === undefined) return -1;
    // Return the position of the newline so the caller emits text up to (and
    // including) it before retrying  - this keeps prose ending in a newline
    // intact.
    return m.index + 1;
  }

  /**
   * Try to consume a bare tool call at the start of the buffer. Returns:
   *   "ok"    - consumed a complete tool call and emitted it
   *   "wait"  - pattern looks right but the JSON args aren't complete yet
   *   "skip"  - pattern didn't match cleanly; let normal text handling resume
   */
  private tryConsumeBareToolCall(): "ok" | "wait" | "skip" {
    const m = this.buffer.match(/^\s*(Read|Write|Run|read|write|run)\s*\r?\n\s*\{/);
    if (!m) return "skip";
    const openIdx = m[0].length - 1; // index of `{` in the buffer
    const closeIdx = findMatchingBrace(this.buffer, openIdx);
    if (closeIdx === -1) {
      // Args still streaming  - wait for more.
      return "wait";
    }
    const jsonStr = this.buffer.slice(openIdx, closeIdx + 1);
    let args: unknown;
    try {
      args = JSON.parse(jsonStr);
    } catch {
      return "skip";
    }
    // Only treat this as a tool call if the JSON actually looks like one of
    // our tool argument shapes. Otherwise prose like "Read this:\n{...}" with
    // an arbitrary object would get hijacked.
    if (!looksLikeToolArgs(m[1]!.toLowerCase() as ToolKind, args)) {
      return "skip";
    }
    const toolName = m[1]!.toLowerCase() as ToolKind;
    this.tagSeq += 1;
    this.h.onToolCall?.({
      id: `tc_${this.tagSeq}`,
      tool: toolName,
      args,
    });
    this.buffer = this.buffer.slice(closeIdx + 1);
    return "ok";
  }

  private closingFor(s: typeof this.state): string {
    if (this.expectedCloseTag) return this.expectedCloseTag;
    switch (s) {
      case "in_plan":
        return "</tasks>";
      case "in_thought":
        return "</thought>";
      case "in_tool":
        return "</tool>";
      case "in_tool_result":
        return "</tool_result>";
      case "in_ask":
        return "</ask>";
      case "in_verify":
        return "</verify>";
      default:
        return "";
    }
  }

  private tryEnterTag(opening: string): boolean {
    const lower = opening.toLowerCase();
    if (lower === "<plan>" || lower === "<tasks>") {
      // <tasks> is the new name; <plan> stays as a legacy alias and flows
      // through the same state  - downstream `kind: "plan"` is the persistent
      // data field, the UI label is "Tasks".
      this.state = "in_plan";
      this.expectedCloseTag = lower === "<tasks>" ? "</tasks>" : "</plan>";
      this.accInTag = "";
      return true;
    }
    if (lower === "<thought>") {
      this.state = "in_thought";
      this.accInTag = "";
      this.currentId = this.nextId("t");
      this.h.onThoughtStart?.(this.currentId);
      return true;
    }
    if (lower === "<verify>") {
      this.state = "in_verify";
      this.accInTag = "";
      return true;
    }
    if (lower === "<ask>") {
      this.state = "in_ask";
      this.accInTag = "";
      this.currentId = this.nextId("ask");
      return true;
    }
    // <tool name="run"> / <tool name='read'> / <tool name=write>
    const m = opening.match(/^<tool\b[^>]*\bname\s*=\s*["']?(read|write|run)["']?[^>]*>$/i);
    if (m) {
      this.state = "in_tool";
      this.accInTag = "";
      this.toolName = m[1]!.toLowerCase() as ToolKind;
      this.currentId = this.nextId("tc");
      return true;
    }
    return false;
  }

  private onInTagChunk(part: string) {
    // Buffer only. Every semantic block  - including <thought>  - is emitted as
    // one complete node on its closing tag, so the timeline never repaints a
    // node mid-token (the upstream request still streams; the UI does not).
    this.accInTag += part;
  }

  private onCloseTag() {
    if (this.state === "in_plan") {
      // Preserve the full markdown-checkbox prefix (`- [ ]` / `- [~]` /
      // `- [x]`) so downstream renderers can hand the joined items straight
      // to marked's GFM task-list extension. Only the leading whitespace and
      // empty lines are trimmed; numeric `1.` / `2.` prefixes are converted
      // to `-` so they also become valid checkbox bullets when the line is
      // already in `1. [ ] foo` form.
      const items = this.accInTag
        .split(/\n+/)
        .map((l) => l.replace(/\s+$/, ""))
        .map((l) => l.replace(/^\s+/, ""))
        .map((l) => l.replace(/^[\d]+[.)、]\s*(?=\[)/, "- "))
        .filter((l) => l.length > 0);
      this.h.onPlan?.(items);
    } else if (this.state === "in_thought") {
      this.h.onThought?.(this.currentId, this.accInTag.trim());
    } else if (this.state === "in_verify") {
      this.h.onVerify?.(this.accInTag.trim());
    } else if (this.state === "in_ask") {
      const parsed = parseAskBody(this.accInTag);
      if (parsed) {
        this.h.onAsk?.({
          id: this.currentId,
          question: parsed.question,
          options: parsed.options,
        });
      } else {
        // Fall back to plain text so the user still sees the model's words.
        this.emitText(this.accInTag);
      }
    } else if (this.state === "in_tool" && this.toolName) {
      let parsedArgs: unknown = null;
      const trimmed = this.accInTag.trim();
      try {
        parsedArgs = JSON.parse(trimmed);
      } catch {
        parsedArgs = { _raw: trimmed };
      }
      this.h.onToolCall?.({
        id: this.currentId,
        tool: this.toolName,
        args: parsedArgs,
      });
    }
    this.state = "outside";
    this.accInTag = "";
    this.toolName = null;
    this.expectedCloseTag = "";
  }
}

/**
 * Parse the body of an `<ask>` tag. Accepts:
 *   - JSON object: {"question": "...", "options": ["a", "b"]}
 *   - Lenient fallback: first non-empty line as question, lines starting with
 *     `A.` / `B.` / `1.` / `-` etc. as options. This catches models that
 *     forget the JSON shape (rare but cheap to support).
 */
function parseAskBody(raw: string): { question: string; options: string[] } | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  // JSON path
  if (trimmed.startsWith("{")) {
    try {
      const obj = JSON.parse(trimmed) as {
        question?: unknown;
        options?: unknown;
      };
      const question = typeof obj.question === "string" ? obj.question.trim() : "";
      const opts = Array.isArray(obj.options)
        ? obj.options
            .filter((o): o is string => typeof o === "string")
            .map((o) => o.trim())
            .filter((o) => o.length > 0)
        : [];
      if (question && opts.length >= 2) {
        // Cap at 4 options; anything beyond is dropped.
        return { question, options: opts.slice(0, 4) };
      }
    } catch {
      /* fall through */
    }
  }
  // Lenient: first non-empty line = question, subsequent list items =
  // options. This is a best-effort fallback for models that didn't follow
  // the JSON contract.
  const lines = trimmed.split(/\r?\n/).map((l) => l.replace(/\s+$/, ""));
  let question = "";
  const options: string[] = [];
  for (const ln of lines) {
    const l = ln.replace(/^\s+/, "");
    if (!l) continue;
    const optMatch = l.match(/^(?:[-*+]|\(?[A-Da-d]\)|[A-Da-d][.)、]|\d+[.)、])\s*(.+)$/);
    if (optMatch) {
      options.push(optMatch[1]!.trim());
    } else if (!question) {
      question = l;
    }
  }
  if (question && options.length >= 2) {
    return { question, options: options.slice(0, 4) };
  }
  return null;
}

/**
 * Cheap shape check for "this JSON object actually plausibly maps to the named
 * osheep code tool argument set." Used by the bare-tool fallback to avoid
 * hijacking prose like `Read this:\n{ "title": "..." }`.
 */
function looksLikeToolArgs(tool: ToolKind, args: unknown): boolean {
  if (!args || typeof args !== "object" || Array.isArray(args)) return false;
  const a = args as Record<string, unknown>;
  if (tool === "run") {
    return typeof a.command === "string";
  }
  if (tool === "read") {
    return a.kind === "file" || a.kind === "list" || a.kind === "search";
  }
  // write
  return (
    a.kind === "write_file" ||
    a.kind === "append_file" ||
    a.kind === "edit_file" ||
    a.kind === "multi_edit" ||
    a.kind === "move" ||
    a.kind === "delete" ||
    a.kind === "create"
  );
}

/**
 * Find the index of the `}` that closes the `{` at `openIdx` in `s`. Returns
 * -1 if the brace is unbalanced (or hasn't been fully streamed yet). Respects
 * JSON string quoting so `}` inside a string literal doesn't terminate the
 * scan.
 */
function findMatchingBrace(s: string, openIdx: number): number {
  if (s[openIdx] !== "{") return -1;
  let depth = 0;
  let inStr = false;
  let escaping = false;
  for (let i = openIdx; i < s.length; i += 1) {
    const c = s[i]!;
    if (escaping) {
      escaping = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        escaping = true;
        continue;
      }
      if (c === '"') {
        inStr = false;
      }
      continue;
    }
    if (c === '"') {
      inStr = true;
      continue;
    }
    if (c === "{") {
      depth += 1;
    } else if (c === "}") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/**
 * Same wire as aiChatStream, but the caller receives semantic events instead
 * of a single concatenated string. `rawAcc` in the returned object is the
 * full raw model text (with tags) so the host can persist it verbatim.
 */
export async function aiChatStreamOsheepCode(
  workspaceId: string,
  input: {
    model: string;
    messages: AiChatMessage[];
    kind?: "claude-cli" | "codex-cli";
    reasoning?: { effort: "off" | "minimal" | "low" | "medium" | "high" };
  },
  handlers: OsheepCodeStreamHandlers,
  signal?: AbortSignal,
): Promise<{ rawAcc: string; aborted: boolean }> {
  const parser = new TagStreamParser(handlers);
  let rawAcc = "";
  const { content, aborted } = await aiChatStream(
    workspaceId,
    input,
    (delta) => {
      rawAcc += delta;
      parser.feed(delta);
    },
    signal,
    (delta) => {
      parser.feedReasoning(delta);
    },
  );
  parser.finish();
  // `content` and `rawAcc` should match; keep `rawAcc` since it's the one we
  // accumulated through the parser path.
  void content;
  return { rawAcc, aborted };
}
