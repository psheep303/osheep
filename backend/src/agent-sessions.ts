import { type Dirent, existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

export type AgentSessionApp = "claude" | "codex";

export interface AgentSessionSummary {
  app: AgentSessionApp;
  id: string;
  title: string;
  cwd: string;
  createdAt: number;
  updatedAt: number;
  size: number;
}

export interface AgentSessionUsage {
  model?: string;
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
}

export interface AgentSessionRoots {
  claudeHome: string;
  codexHome: string;
}

export interface AgentSessionBatchDeleteResult {
  deleted: AgentSessionSummary[];
  failed: Array<{ id: string; message: string }>;
}

interface AgentSessionRecord extends AgentSessionSummary {
  filePath: string;
  auxiliaryPath?: string;
}

interface CodexTitle {
  title: string;
  updatedAt: number | null;
}

const SESSION_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{7,127}$/;
const JSON_PREFIX_BYTES = 512 * 1024;

export function getAgentSessionRoots(): AgentSessionRoots {
  const home = os.homedir() || ".";
  const nativeClaude = path.join(home, ".claude");
  const nativeCodex = path.join(home, ".codex");
  return {
    claudeHome: path.resolve(
      process.env.CLAUDE_CONFIG_DIR ||
        (existsSync(path.join(nativeClaude, "projects"))
          ? nativeClaude
          : process.env.OSHEEP_CLAUDE_CONFIG_DIR || nativeClaude),
    ),
    codexHome: path.resolve(
      process.env.CODEX_HOME ||
        (existsSync(path.join(nativeCodex, "sessions"))
          ? nativeCodex
          : process.env.OSHEEP_CODEX_CONFIG_DIR || nativeCodex),
    ),
  };
}

export async function readAgentSessionUsage(
  app: AgentSessionApp,
  id: string,
  roots: AgentSessionRoots = getAgentSessionRoots(),
): Promise<AgentSessionUsage> {
  const record = await findAgentSessionRecord(app, id, roots);
  if (!record) return {};
  const text = await fs.readFile(record.filePath, "utf8");
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total: number | undefined;
  let cost: number | undefined;
  let model: string | undefined;
  let sawInput = false;
  let sawOutput = false;
  let sawCacheRead = false;
  let sawCacheWrite = false;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      continue;
    }
    const root = objectValue(value);
    const payload = objectValue(root.payload);
    if (app === "codex") {
      model = stringValue(payload.model ?? root.model) || model;
      const info = objectValue(payload.info);
      const usage = objectValue(info.total_token_usage);
      const nextInput = numberValue(usage.input_tokens ?? usage.inputTokens);
      const nextOutput = numberValue(usage.output_tokens ?? usage.outputTokens);
      const nextCacheRead = numberValue(
        usage.cached_input_tokens ?? usage.cache_read_input_tokens ?? usage.cacheRead,
      );
      const nextCacheWrite = numberValue(
        usage.cache_write_input_tokens ?? usage.cache_creation_input_tokens ?? usage.cacheWrite,
      );
      const nextTotal = numberValue(usage.total_tokens ?? usage.totalTokens);
      if (nextInput !== undefined) {
        input = nextInput;
        sawInput = true;
      }
      if (nextOutput !== undefined) {
        output = nextOutput;
        sawOutput = true;
      }
      if (nextCacheRead !== undefined) {
        cacheRead = nextCacheRead;
        sawCacheRead = true;
      }
      if (nextCacheWrite !== undefined) {
        cacheWrite = nextCacheWrite;
        sawCacheWrite = true;
      }
      if (nextTotal !== undefined) total = nextTotal;
    } else {
      const message = objectValue(root.message);
      model = stringValue(message.model ?? root.model) || model;
      const nestedUsage = objectValue(message.usage);
      const directUsage = objectValue(root.usage);
      const usage = Object.keys(nestedUsage).length > 0 ? nestedUsage : directUsage;
      const nextInput = numberValue(usage.input_tokens ?? usage.inputTokens);
      const nextOutput = numberValue(usage.output_tokens ?? usage.outputTokens);
      const nextCacheRead = numberValue(
        usage.cache_read_input_tokens ?? usage.cached_input_tokens ?? usage.cacheRead,
      );
      const nextCacheWrite = numberValue(
        usage.cache_creation_input_tokens ?? usage.cache_write_input_tokens ?? usage.cacheWrite,
      );
      if (nextInput !== undefined) {
        input += nextInput;
        sawInput = true;
      }
      if (nextOutput !== undefined) {
        output += nextOutput;
        sawOutput = true;
      }
      if (nextCacheRead !== undefined) {
        cacheRead += nextCacheRead;
        sawCacheRead = true;
      }
      if (nextCacheWrite !== undefined) {
        cacheWrite += nextCacheWrite;
        sawCacheWrite = true;
      }
    }
    const nextCost = numberValue(
      root.cost_usd ?? root.total_cost_usd ?? payload.cost_usd ?? payload.total_cost_usd,
    );
    if (nextCost !== undefined) cost = nextCost;
  }
  if (
    !sawInput &&
    !sawOutput &&
    !sawCacheRead &&
    !sawCacheWrite &&
    total === undefined &&
    cost === undefined &&
    model === undefined
  )
    return {};
  return {
    ...(model ? { model } : {}),
    tokens:
      sawInput || sawOutput || sawCacheRead || sawCacheWrite || total !== undefined
        ? {
            input: sawInput ? input : undefined,
            output: sawOutput ? output : undefined,
            cacheRead: sawCacheRead ? cacheRead : undefined,
            cacheWrite: sawCacheWrite ? cacheWrite : undefined,
            total:
              total ??
              (sawInput || sawOutput || sawCacheRead || sawCacheWrite
                ? input + output + cacheRead + cacheWrite
                : undefined),
          }
        : undefined,
    cost,
  };
}

export async function listAgentSessions(
  app: AgentSessionApp,
  roots: AgentSessionRoots = getAgentSessionRoots(),
): Promise<AgentSessionSummary[]> {
  const records =
    app === "codex" ? await listCodexSessionRecords(roots) : await listClaudeSessionRecords(roots);
  return records.map(stripPrivateFields);
}

export async function getAgentSession(
  app: AgentSessionApp,
  id: string,
  roots: AgentSessionRoots = getAgentSessionRoots(),
): Promise<AgentSessionSummary | null> {
  const record = await findAgentSessionRecord(app, id, roots);
  return record ? stripPrivateFields(record) : null;
}

export async function deleteAgentSession(
  app: AgentSessionApp,
  id: string,
  roots: AgentSessionRoots = getAgentSessionRoots(),
): Promise<AgentSessionSummary | null> {
  const record = await findAgentSessionRecord(app, id, roots);
  if (!record) return null;

  await deleteAgentSessionRecord(app, record, roots);
  return stripPrivateFields(record);
}

export function isAgentSessionInProject(
  session: AgentSessionSummary,
  projectRoot: string,
): boolean {
  const relative = path.relative(path.resolve(projectRoot), path.resolve(session.cwd));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export async function deleteAgentSessionsInProject(
  app: AgentSessionApp,
  ids: string[],
  projectRoot: string,
  roots: AgentSessionRoots = getAgentSessionRoots(),
): Promise<AgentSessionBatchDeleteResult> {
  const uniqueIds = [...new Set(ids)];
  const records =
    app === "codex" ? await listCodexSessionRecords(roots) : await listClaudeSessionRecords(roots);
  const allowed = new Map(
    records
      .filter((record) => isAgentSessionInProject(record, projectRoot))
      .map((record) => [record.id, record]),
  );
  const deleted: AgentSessionSummary[] = [];
  const failed: Array<{ id: string; message: string }> = [];

  for (const id of uniqueIds) {
    const record = allowed.get(id);
    if (!record) {
      failed.push({ id, message: "Session not found in the current project" });
      continue;
    }
    try {
      await deleteAgentSessionRecord(app, record, roots);
      deleted.push(stripPrivateFields(record));
    } catch (error) {
      failed.push({ id, message: (error as Error).message });
    }
  }
  return { deleted, failed };
}

async function deleteAgentSessionRecord(
  app: AgentSessionApp,
  record: AgentSessionRecord,
  roots: AgentSessionRoots,
): Promise<void> {
  await fs.unlink(record.filePath);
  if (record.auxiliaryPath) {
    await fs.rm(record.auxiliaryPath, { recursive: true, force: true });
  }
  if (app === "codex") {
    await removeCodexTitleIndexEntry(roots.codexHome, record.id);
  } else {
    await removeClaudeSessionIndexEntry(path.dirname(record.filePath), record.id);
  }
}

async function findAgentSessionRecord(
  app: AgentSessionApp,
  id: string,
  roots: AgentSessionRoots,
): Promise<AgentSessionRecord | null> {
  if (!SESSION_ID_RE.test(id)) return null;
  return app === "codex"
    ? await findCodexSessionRecord(roots, id)
    : await findClaudeSessionRecord(roots, id);
}

async function findCodexSessionRecord(
  roots: AgentSessionRoots,
  id: string,
): Promise<AgentSessionRecord | null> {
  const files = await collectJsonlFiles(path.join(roots.codexHome, "sessions"));
  const filePath = files.find((file) => sessionIdFromFilename(file) === id);
  if (!filePath) return null;
  return await readCodexSession(filePath, await readCodexTitleIndex(roots.codexHome));
}

async function findClaudeSessionRecord(
  roots: AgentSessionRoots,
  id: string,
): Promise<AgentSessionRecord | null> {
  const projectsRoot = path.join(roots.claudeHome, "projects");
  for (const projectDir of await readDirSafe(projectsRoot)) {
    if (!projectDir.isDirectory()) continue;
    const filePath = path.join(projectsRoot, projectDir.name, `${id}.jsonl`);
    try {
      const stat = await fs.stat(filePath);
      if (stat.isFile()) return await readClaudeSession(filePath, id);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  return null;
}

async function listCodexSessionRecords(roots: AgentSessionRoots): Promise<AgentSessionRecord[]> {
  const sessionsRoot = path.join(roots.codexHome, "sessions");
  const [files, titles] = await Promise.all([
    collectJsonlFiles(sessionsRoot),
    readCodexTitleIndex(roots.codexHome),
  ]);
  const records: AgentSessionRecord[] = [];
  for (const filePath of files) {
    const record = await readCodexSession(filePath, titles);
    if (record) records.push(record);
  }
  return sortRecords(records);
}

async function listClaudeSessionRecords(roots: AgentSessionRoots): Promise<AgentSessionRecord[]> {
  const projectsRoot = path.join(roots.claudeHome, "projects");
  const projectDirs = await readDirSafe(projectsRoot);
  const records: AgentSessionRecord[] = [];
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const projectPath = path.join(projectsRoot, projectDir.name);
    const entries = await readDirSafe(projectPath);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const id = entry.name.slice(0, -".jsonl".length);
      if (!SESSION_ID_RE.test(id)) continue;
      const record = await readClaudeSession(path.join(projectPath, entry.name), id);
      if (record) records.push(record);
    }
  }
  return sortRecords(records);
}

async function readCodexSession(
  filePath: string,
  titles: Map<string, CodexTitle>,
): Promise<AgentSessionRecord | null> {
  const [stat, prefix] = await Promise.all([fs.stat(filePath), readFilePrefix(filePath)]);
  let id = sessionIdFromFilename(filePath);
  let cwd = "";
  let createdAt: number | null = null;
  let fallbackTitle = "";

  for (const value of parseJsonLines(prefix)) {
    const type = stringValue(value.type);
    const payload = objectValue(value.payload);
    const timestamp = parseTimestamp(value.timestamp);
    if (timestamp !== null && createdAt === null) createdAt = timestamp;

    if (type === "session_meta") {
      id = stringValue(payload.id) || stringValue(payload.session_id) || id;
      cwd = stringValue(payload.cwd) || cwd;
      createdAt = parseTimestamp(payload.timestamp) ?? createdAt;
      continue;
    }
    if (!cwd && type === "turn_context") cwd = stringValue(payload.cwd);
    if (!fallbackTitle && type === "event_msg" && stringValue(payload.type) === "user_message") {
      fallbackTitle = cleanPromptContext(stringValue(payload.message));
    }
    if (!fallbackTitle && type === "response_item") {
      fallbackTitle = userMessageTitle(payload);
    }
    if (!fallbackTitle && type === "event_msg" && stringValue(payload.type) === "user_message") {
      fallbackTitle = cleanPromptContext(stringValue(payload.message));
    }
  }

  if (!id || !SESSION_ID_RE.test(id)) return null;
  const indexed = titles.get(id);
  // The title index can lag behind the session file while Codex is finishing.
  // Prefer the newest signal so workflow runs can resolve the session they just created.
  const updatedAt = Math.max(indexed?.updatedAt ?? 0, stat.mtimeMs);
  return {
    app: "codex",
    id,
    title: normalizeTitle(indexed?.title || fallbackTitle) || `Codex session ${shortId(id)}`,
    cwd: cwd || os.homedir() || ".",
    createdAt: createdAt ?? stat.birthtimeMs ?? stat.mtimeMs,
    updatedAt,
    size: stat.size,
    filePath,
  };
}

async function readClaudeSession(
  filePath: string,
  fallbackId: string,
): Promise<AgentSessionRecord | null> {
  const [stat, prefix] = await Promise.all([fs.stat(filePath), readFilePrefix(filePath)]);
  let id = fallbackId;
  let cwd = "";
  let customTitle = "";
  let summary = "";
  let firstPrompt = "";
  let slug = "";
  let createdAt: number | null = null;
  let updatedAt = stat.mtimeMs;

  for (const value of parseJsonLines(prefix)) {
    id = stringValue(value.sessionId) || id;
    cwd = stringValue(value.cwd) || cwd;
    customTitle = stringValue(value.customTitle) || customTitle;
    summary = stringValue(value.summary) || summary;
    slug = stringValue(value.slug) || slug;
    const timestamp = parseTimestamp(value.timestamp);
    if (timestamp !== null) {
      if (createdAt === null) createdAt = timestamp;
      updatedAt = Math.max(updatedAt, timestamp);
    }
    if (!firstPrompt && stringValue(value.type) === "user") {
      const message = objectValue(value.message);
      if (stringValue(message.role) === "user" && value.isMeta !== true) {
        firstPrompt = contentText(message.content);
      }
    }
  }

  if (!SESSION_ID_RE.test(id)) return null;
  return {
    app: "claude",
    id,
    title:
      normalizeTitle(customTitle || summary || firstPrompt || slug) ||
      `Claude session ${shortId(id)}`,
    cwd: cwd || os.homedir() || ".",
    createdAt: createdAt ?? stat.birthtimeMs ?? stat.mtimeMs,
    updatedAt,
    size: stat.size,
    filePath,
    auxiliaryPath: path.join(path.dirname(filePath), id),
  };
}

async function collectJsonlFiles(root: string): Promise<string[]> {
  const files: string[] = [];
  const pending = [root];
  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) break;
    for (const entry of await readDirSafe(dir)) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) pending.push(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(fullPath);
    }
  }
  return files;
}

async function readCodexTitleIndex(codexHome: string): Promise<Map<string, CodexTitle>> {
  const result = new Map<string, CodexTitle>();
  const indexPath = path.join(codexHome, "session_index.jsonl");
  let text: string;
  try {
    text = await fs.readFile(indexPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return result;
    throw error;
  }
  for (const value of parseJsonLines(text)) {
    const id = stringValue(value.id);
    const title = stringValue(value.thread_name);
    if (!id || !title) continue;
    result.set(id, { title, updatedAt: parseTimestamp(value.updated_at) });
  }
  return result;
}

async function removeCodexTitleIndexEntry(codexHome: string, id: string): Promise<void> {
  const indexPath = path.join(codexHome, "session_index.jsonl");
  let text: string;
  try {
    text = await fs.readFile(indexPath, "utf8");
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
  const lines = text.split(/\r?\n/);
  const retained = lines.filter((line) => {
    if (!line.trim()) return false;
    try {
      const value = JSON.parse(line) as Record<string, unknown>;
      return stringValue(value.id) !== id;
    } catch {
      return true;
    }
  });
  if (retained.length === lines.filter((line) => line.trim()).length) return;
  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, retained.length > 0 ? `${retained.join("\n")}\n` : "", "utf8");
  await fs.rename(tempPath, indexPath);
}

async function removeClaudeSessionIndexEntry(projectDir: string, id: string): Promise<void> {
  const indexPath = path.join(projectDir, "sessions-index.json");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(indexPath, "utf8")) as unknown;
  } catch (error) {
    if (isMissing(error) || error instanceof SyntaxError) return;
    throw error;
  }

  let changed = false;
  if (Array.isArray(parsed)) {
    const next = parsed.filter((entry) => !matchesSessionId(entry, id));
    changed = next.length !== parsed.length;
    parsed = next;
  } else {
    const root = objectValue(parsed);
    if (Array.isArray(root.entries)) {
      const next = root.entries.filter((entry) => !matchesSessionId(entry, id));
      changed = next.length !== root.entries.length;
      root.entries = next;
    }
    if (Array.isArray(root.sessions)) {
      const next = root.sessions.filter((entry) => !matchesSessionId(entry, id));
      changed = next.length !== root.sessions.length || changed;
      root.sessions = next;
    }
  }
  if (!changed) return;

  const tempPath = `${indexPath}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, indexPath);
}

async function readFilePrefix(filePath: string): Promise<string> {
  const handle = await fs.open(filePath, "r");
  try {
    const stat = await handle.stat();
    const size = Math.min(stat.size, JSON_PREFIX_BYTES);
    const buffer = Buffer.alloc(size);
    const { bytesRead } = await handle.read(buffer, 0, size, 0);
    return buffer.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

function parseJsonLines(text: string): Record<string, unknown>[] {
  const values: Record<string, unknown>[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line) as unknown;
      if (value && typeof value === "object" && !Array.isArray(value)) {
        values.push(value as Record<string, unknown>);
      }
    } catch {
      // A prefix can end halfway through its final JSON line.
    }
  }
  return values;
}

function userMessageTitle(payload: Record<string, unknown>): string {
  if (stringValue(payload.type) !== "message" || stringValue(payload.role) !== "user") {
    return "";
  }
  const text = contentText(payload.content);
  return cleanPromptContext(text);
}

function cleanPromptContext(value: string): string {
  return value
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, " ")
    .replace(/<permissions instructions>[\s\S]*?<\/permissions instructions>/gi, " ")
    .replace(/^# AGENTS\.md[\s\S]*?(?=\n\n[^#]|$)/i, " ")
    .trim();
}

function matchesSessionId(value: unknown, id: string): boolean {
  const entry = objectValue(value);
  return stringValue(entry.sessionId) === id || stringValue(entry.id) === id;
}

function contentText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => {
      if (!part || typeof part !== "object" || Array.isArray(part)) return "";
      const value = part as Record<string, unknown>;
      return stringValue(value.text) || stringValue(value.content);
    })
    .filter(Boolean)
    .join(" ");
}

function normalizeTitle(value: string): string {
  const normalized = value
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (normalized.length <= 96) return normalized;
  return `${normalized.slice(0, 93).trimEnd()}...`;
}

function sessionIdFromFilename(filePath: string): string {
  const name = path.basename(filePath, ".jsonl");
  const match = name.match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i);
  return match?.[1] ?? "";
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function numberValue(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function parseTimestamp(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function sortRecords(records: AgentSessionRecord[]): AgentSessionRecord[] {
  return records.sort((a, b) => b.updatedAt - a.updatedAt || a.id.localeCompare(b.id));
}

function stripPrivateFields(record: AgentSessionRecord): AgentSessionSummary {
  return {
    app: record.app,
    id: record.id,
    title: record.title,
    cwd: record.cwd,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    size: record.size,
  };
}

async function readDirSafe(dir: string): Promise<Dirent[]> {
  try {
    return await fs.readdir(dir, { withFileTypes: true });
  } catch (error) {
    if (isMissing(error)) return [];
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException | null)?.code === "ENOENT";
}
