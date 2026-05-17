import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errors } from "./errors.js";

const SESSION_ID_RE = /^ses_[a-z0-9]{8,32}$/;

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

function sessionDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".osheep", "session");
}

function sessionFile(workspaceRoot: string, id: string): string {
  return path.join(sessionDir(workspaceRoot), `${id}.json`);
}

function validateId(id: string): void {
  if (typeof id !== "string" || !SESSION_ID_RE.test(id)) {
    throw errors.invalidPath("session id 非法");
  }
}

export function generateSessionId(): string {
  const rand = Math.random().toString(36).slice(2, 10);
  const t = Date.now().toString(36).slice(-4);
  return `ses_${rand}${t}`;
}

async function ensureSessionDir(workspaceRoot: string): Promise<void> {
  await fs.mkdir(sessionDir(workspaceRoot), { recursive: true });
}

function sanitize(raw: unknown, fallbackId: string): SessionRecord {
  const r = (raw ?? {}) as Partial<SessionRecord> & { messages?: unknown };
  const id =
    typeof r.id === "string" && SESSION_ID_RE.test(r.id) ? r.id : fallbackId;
  const title = typeof r.title === "string" ? r.title : "新对话";
  const agentName = typeof r.agentName === "string" ? r.agentName : "";
  const createdAt =
    typeof r.createdAt === "number" ? r.createdAt : Date.now();
  const updatedAt =
    typeof r.updatedAt === "number" ? r.updatedAt : createdAt;
  let messages: ChatMessage[] = [];
  if (Array.isArray(r.messages)) {
    messages = r.messages
      .map((m): ChatMessage | null => {
        if (!m || typeof m !== "object") return null;
        const mm = m as Partial<ChatMessage>;
        if (mm.role !== "user" && mm.role !== "assistant") return null;
        if (typeof mm.content !== "string") return null;
        return {
          role: mm.role,
          content: mm.content,
          timestamp:
            typeof mm.timestamp === "number" ? mm.timestamp : Date.now(),
        };
      })
      .filter((m): m is ChatMessage => m !== null);
  }
  return { id, title, agentName, createdAt, updatedAt, messages };
}

export async function listSessions(
  workspaceRoot: string
): Promise<SessionSummary[]> {
  await ensureSessionDir(workspaceRoot);
  const dir = sessionDir(workspaceRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(dir);
  } catch {
    return [];
  }
  const out: SessionSummary[] = [];
  for (const f of entries) {
    if (!f.endsWith(".json")) continue;
    const id = f.slice(0, -5);
    if (!SESSION_ID_RE.test(id)) continue;
    try {
      const text = await fs.readFile(path.join(dir, f), "utf-8");
      const s = sanitize(JSON.parse(text), id);
      out.push({
        id: s.id,
        title: s.title,
        agentName: s.agentName,
        createdAt: s.createdAt,
        updatedAt: s.updatedAt,
        messageCount: s.messages.length,
      });
    } catch {
      /* skip */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function getSession(
  workspaceRoot: string,
  id: string
): Promise<SessionRecord> {
  validateId(id);
  let text: string;
  try {
    text = await fs.readFile(sessionFile(workspaceRoot, id), "utf-8");
  } catch {
    throw errors.notFound(`session 不存在: ${id}`);
  }
  try {
    return sanitize(JSON.parse(text), id);
  } catch {
    throw errors.ioError("session 文件解析失败");
  }
}

export async function createSession(
  workspaceRoot: string,
  partial: Partial<SessionRecord>
): Promise<SessionRecord> {
  await ensureSessionDir(workspaceRoot);
  const now = Date.now();
  const id = generateSessionId();
  const record: SessionRecord = {
    id,
    title: typeof partial.title === "string" && partial.title ? partial.title : "新对话",
    agentName: typeof partial.agentName === "string" ? partial.agentName : "",
    createdAt: now,
    updatedAt: now,
    messages: [],
  };
  await writeSessionFile(workspaceRoot, record);
  return record;
}

export async function saveSession(
  workspaceRoot: string,
  record: SessionRecord
): Promise<SessionRecord> {
  validateId(record.id);
  await ensureSessionDir(workspaceRoot);
  const next = sanitize(record, record.id);
  next.updatedAt = Date.now();
  await writeSessionFile(workspaceRoot, next);
  return next;
}

async function writeSessionFile(
  workspaceRoot: string,
  record: SessionRecord
): Promise<void> {
  const abs = sessionFile(workspaceRoot, record.id);
  const body = JSON.stringify(record, null, 2);
  const tmp = abs + ".osheep.tmp." + Date.now();
  await fs.writeFile(tmp, body, "utf-8");
  try {
    await fs.rename(tmp, abs);
  } catch (e) {
    await fs.unlink(tmp).catch(() => undefined);
    throw errors.ioError((e as Error).message);
  }
}

export async function deleteSession(
  workspaceRoot: string,
  id: string
): Promise<void> {
  validateId(id);
  try {
    await fs.unlink(sessionFile(workspaceRoot, id));
  } catch {
    throw errors.notFound(`session 不存在: ${id}`);
  }
}
