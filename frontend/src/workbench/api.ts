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

export type ChatRole = "user" | "assistant" | "tool";

/** Step records attached to assistant messages by osheep code. */
export type ChatStep =
  | { kind: "plan"; items: string[] }
  | { kind: "thought"; id: string; text: string }
  | {
      kind: "tool";
      id: string;
      tool: ToolKind;
      args: unknown;
      status: "running" | "ok" | "err" | "denied";
      result?: unknown;
      error?: string;
    }
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
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** present when role === "tool" — used to correlate with the originating tool_call */
  tool_call_id?: string;
}

export async function fetchProviderModels(
  workspaceId: string,
  baseUrl: string,
  apiKey: string,
  kind: "openai" | "anthropic" = "openai"
): Promise<string[]> {
  const { models } = await http.post<{ models: string[] }>(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/models`,
    { baseUrl, apiKey, kind }
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
    kind?: "openai" | "anthropic";
  }
): Promise<{ content: string }> {
  return await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/chat`,
    input
  );
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
export async function aiChatStream(
  workspaceId: string,
  input: {
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: AiChatMessage[];
    kind?: "openai" | "anthropic";
    reasoning?: { effort: "off" | "minimal" | "low" | "medium" | "high" };
  },
  onDelta: (chunk: string) => void,
  signal?: AbortSignal
): Promise<{ content: string; aborted: boolean }> {
  const url = `/api/workspaces/${encodeURIComponent(
    workspaceId
  )}/ai/chat/stream`;

  let res: Response;
  try {
    res = await fetch(url, {
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
          // Append (in case of multi-line data — rare here but safe)
          const piece = line.slice(5).trimStart();
          dataLine = dataLine ? dataLine + "\n" + piece : piece;
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

// ─── AI tool exec (osheep code) ───

export type ToolKind = "read" | "write" | "run";

export interface ReadFileArgs { kind: "file"; path: string }
export interface ReadListArgs { kind: "list"; path: string; includeHidden?: boolean }
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
export interface AppendFileArgs { kind: "append_file"; path: string; content: string }
export interface EditFileArgs {
  kind: "edit_file";
  path: string;
  oldString: string;
  newString: string;
}
export interface MoveArgs { kind: "move"; from: string; to: string }
export interface DeleteArgs { kind: "delete"; path: string; recursive?: boolean }
export interface CreateArgs {
  kind: "create";
  path: string;
  entryKind?: "file" | "directory";
}
export type WriteArgs =
  | WriteFileArgs
  | AppendFileArgs
  | EditFileArgs
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
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

export async function execRead(
  workspaceId: string,
  args: ReadArgs
): Promise<unknown> {
  return await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/exec/read`,
    args
  );
}

export async function execWrite(
  workspaceId: string,
  args: WriteArgs
): Promise<unknown> {
  return await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/exec/write`,
    args
  );
}

export async function execRun(
  workspaceId: string,
  args: RunArgs
): Promise<RunResult> {
  return await http.post(
    `/api/workspaces/${encodeURIComponent(workspaceId)}/ai/exec/run`,
    args
  );
}

// ─── osheep code tag-aware streaming ───
//
// The backend `/ai/chat/stream` still emits a raw delta stream. osheep code's
// tag protocol (<plan>/<thought>/<tool>/<verify>) is parsed here, on the
// client. The caller passes semantic callbacks instead of a single onDelta.

export interface OsheepCodeStreamHandlers {
  onPlan?: (items: string[]) => void;
  onThoughtStart?: (id: string) => void;
  onThoughtDelta?: (id: string, chunk: string) => void;
  onThoughtEnd?: (id: string) => void;
  onTextDelta?: (chunk: string) => void;
  onToolCall?: (call: {
    id: string;
    tool: ToolKind;
    args: unknown;
  }) => void;
  onVerify?: (text: string) => void;
}

class TagStreamParser {
  private buffer = "";
  private state: "outside" | "in_plan" | "in_thought" | "in_tool" | "in_verify" =
    "outside";
  private tagSeq = 0;
  private currentId = "";
  // Tool open-tag may carry attrs like name="run". We capture the full opening
  // tag text until we see the matching `>` before we know what tool it is.
  private toolName: ToolKind | null = null;
  private accInTag = "";

  constructor(private readonly h: OsheepCodeStreamHandlers) {}

  feed(chunk: string) {
    this.buffer += chunk;
    this.drain();
  }

  finish() {
    // Flush any pending text or in-tag content as best-effort.
    if (this.state === "outside" && this.buffer) {
      this.emitText(this.buffer);
      this.buffer = "";
    }
    // Unclosed tags: surface accumulated content as plain text so user sees something.
    if (this.state !== "outside" && this.accInTag) {
      this.emitText(this.accInTag);
      this.accInTag = "";
    }
    this.state = "outside";
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
          // "skip" — pattern didn't actually resolve to a tool call, fall
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
          // No tag-start in sight — entire buffer is plain text.
          if (this.buffer) {
            this.emitText(this.buffer);
            this.buffer = "";
          }
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
        // Not a tag we recognise — emit the `<` as text and continue scanning.
        this.emitText("<");
        this.buffer = this.buffer.slice(1);
        continue;
      }

      // Inside a tag — find the matching closing tag.
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
    // including) it before retrying — this keeps prose ending in a newline
    // intact.
    return m.index + 1;
  }

  /**
   * Try to consume a bare tool call at the start of the buffer. Returns:
   *   "ok"   — consumed a complete tool call and emitted it
   *   "wait" — pattern looks right but the JSON args aren't complete yet
   *   "skip" — pattern didn't match cleanly; let normal text handling resume
   */
  private tryConsumeBareToolCall(): "ok" | "wait" | "skip" {
    const m = this.buffer.match(
      /^\s*(Read|Write|Run|read|write|run)\s*\r?\n\s*\{/
    );
    if (!m) return "skip";
    const openIdx = m[0].length - 1; // index of `{` in the buffer
    const closeIdx = findMatchingBrace(this.buffer, openIdx);
    if (closeIdx === -1) {
      // Args still streaming — wait for more.
      return "wait";
    }
    const jsonStr = this.buffer.slice(openIdx, closeIdx + 1);
    let args: unknown;
    try {
      args = JSON.parse(jsonStr);
    } catch {
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
    switch (s) {
      case "in_plan":
        return "</plan>";
      case "in_thought":
        return "</thought>";
      case "in_tool":
        return "</tool>";
      case "in_verify":
        return "</verify>";
      default:
        return "";
    }
  }

  private tryEnterTag(opening: string): boolean {
    const lower = opening.toLowerCase();
    if (lower === "<plan>") {
      this.state = "in_plan";
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
    if (this.state === "in_thought") {
      this.accInTag += part;
      this.h.onThoughtDelta?.(this.currentId, part);
    } else {
      // plan / verify / tool: accumulate, emit on close.
      this.accInTag += part;
    }
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
        .map((l) => l.replace(/^[\d]+[\.\)、]\s*(?=\[)/, "- "))
        .filter((l) => l.length > 0);
      this.h.onPlan?.(items);
    } else if (this.state === "in_thought") {
      this.h.onThoughtEnd?.(this.currentId);
    } else if (this.state === "in_verify") {
      this.h.onVerify?.(this.accInTag.trim());
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
  }
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
  let escape = false;
  for (let i = openIdx; i < s.length; i += 1) {
    const c = s[i]!;
    if (escape) {
      escape = false;
      continue;
    }
    if (inStr) {
      if (c === "\\") {
        escape = true;
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
    baseUrl: string;
    apiKey: string;
    model: string;
    messages: AiChatMessage[];
    kind?: "openai" | "anthropic";
    reasoning?: { effort: "off" | "minimal" | "low" | "medium" | "high" };
  },
  handlers: OsheepCodeStreamHandlers,
  signal?: AbortSignal
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
    signal
  );
  parser.finish();
  // `content` and `rawAcc` should match; keep `rawAcc` since it's the one we
  // accumulated through the parser path.
  void content;
  return { rawAcc, aborted };
}

