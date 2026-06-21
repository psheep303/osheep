import type { FastifyInstance } from "fastify";
import * as fs from "node:fs/promises";
import { errors } from "../errors.js";
import { resolveWorkspace, resolveWorkspacePath } from "../workspace.js";
import {
  createEntry,
  deleteEntry,
  listTree,
  moveEntry,
  readFileText,
  writeFileText,
} from "../fs-ops.js";
import { searchWorkspace } from "../search.js";
import { execRun } from "../ai-exec.js";

type ProviderKind = "openai" | "anthropic" | "claude-code";

type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high";

const AI_READ_LIMIT = 256 * 1024;

interface ChatMessageIn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function toPosix(p: string): string {
  return p.replace(/\\/g, "/");
}

async function readAiFileText(
  workspaceRoot: string,
  relPath: string
): Promise<{
  path: string;
  content: string;
  size: number;
  mtime: number;
  truncated: boolean;
}> {
  const abs = resolveWorkspacePath(workspaceRoot, relPath);
  let stat;
  try {
    stat = await fs.stat(abs);
  } catch {
    throw errors.notFound();
  }
  if (stat.isDirectory()) throw errors.isDirectory();

  const bytesToRead = Math.min(stat.size, AI_READ_LIMIT);
  if (bytesToRead === 0) {
    return {
      path: toPosix(relPath),
      content: "",
      size: stat.size,
      mtime: stat.mtimeMs,
      truncated: false,
    };
  }

  const handle = await fs.open(abs, "r");
  try {
    const buffer = Buffer.allocUnsafe(bytesToRead);
    const { bytesRead } = await handle.read(buffer, 0, bytesToRead, 0);
    return {
      path: toPosix(relPath),
      content: buffer.subarray(0, bytesRead).toString("utf-8"),
      size: stat.size,
      mtime: stat.mtimeMs,
      truncated: stat.size > bytesRead,
    };
  } finally {
    await handle.close().catch(() => undefined);
  }
}

function isObviousWritePlaceholder(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed === "..." ||
    trimmed === "…" ||
    trimmed === "<content>" ||
    trimmed === "{{content}}" ||
    trimmed === "[content]"
  );
}

function toPositiveInt(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 1) return null;
  return value;
}

function sliceLines(
  content: string,
  startLine: number | null,
  lineCount: number | null
): {
  content: string;
  startLine: number;
  endLine: number;
  totalLines: number;
  truncated: boolean;
} {
  const lines = content.split(/\r?\n/);
  const totalLines = lines.length;
  if (!startLine && !lineCount) {
    return {
      content,
      startLine: totalLines > 0 ? 1 : 0,
      endLine: totalLines,
      totalLines,
      truncated: false,
    };
  }
  const start = Math.min(Math.max(startLine ?? 1, 1), Math.max(totalLines, 1));
  const count = Math.max(lineCount ?? 200, 1);
  const end = Math.min(start + count - 1, totalLines);
  return {
    content: lines.slice(start - 1, end).join("\n"),
    startLine: start,
    endLine: end,
    totalLines,
    truncated: start > 1 || end < totalLines,
  };
}

/** 1-based line number of `index` within `text` (0-based char offset). */
function lineOfIndex(text: string, index: number): number {
  if (index <= 0) return 1;
  let n = 1;
  for (let i = 0; i < index && i < text.length; i += 1) {
    if (text.charCodeAt(i) === 10 /* \n */) n += 1;
  }
  return n;
}

/** Count `\n` characters in `s`. Useful for "lines spanned by this slice". */
function countNewlines(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i += 1) {
    if (s.charCodeAt(i) === 10) n += 1;
  }
  return n;
}

interface EditDiffPayload {
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

function buildEditDiff(
  before: string,
  after: string,
  oldString: string,
  newString: string
): EditDiffPayload {
  // Single match guaranteed by caller (occurrences === 1).
  const idx = before.indexOf(oldString);
  const startLine = idx >= 0 ? lineOfIndex(before, idx) : 1;
  // Newlines that `oldString`/`newString` themselves contain. `+1` so a
  // single-line slice still spans line N → N.
  const oldLines = countNewlines(oldString) + 1;
  const newLines = countNewlines(newString) + 1;
  return {
    oldString,
    newString,
    startLine,
    endLineBefore: startLine + oldLines - 1,
    endLineAfter: startLine + newLines - 1,
    added: newLines,
    removed: oldLines,
    before,
    after,
  };
}

/**
 * Build a hint message for `edit_file` when `oldString` was not found. Tries
 * to locate the first non-empty line of `oldString` elsewhere in the file and
 * appends "可能位置: line A, B, …" with up to 5 candidates.
 */
function formatEditMissHint(
  before: string,
  oldString: string,
  pathDisplay: string
): string {
  const trimmedSearch = oldString.replace(/^\s+/, "");
  const firstLineEnd = trimmedSearch.indexOf("\n");
  const firstLine =
    firstLineEnd >= 0
      ? trimmedSearch.slice(0, firstLineEnd).trim()
      : trimmedSearch.trim();
  if (!firstLine || firstLine.length < 4) {
    return `oldString 在 ${pathDisplay} 中未匹配`;
  }
  const fileLines = before.split(/\r?\n/);
  const hits: number[] = [];
  for (let i = 0; i < fileLines.length && hits.length < 5; i += 1) {
    if (fileLines[i]!.includes(firstLine)) hits.push(i + 1);
  }
  if (hits.length === 0) {
    return `oldString 在 ${pathDisplay} 中未匹配`;
  }
  return `oldString 在 ${pathDisplay} 中未匹配；可能位置: ${hits
    .map((n) => `line ${n}`)
    .join(", ")}（基于 oldString 首行）`;
}

function formatEditAmbiguousHint(
  before: string,
  oldString: string,
  occurrences: number
): string {
  const lines: number[] = [];
  let from = 0;
  while (lines.length < 8) {
    const i = before.indexOf(oldString, from);
    if (i < 0) break;
    lines.push(lineOfIndex(before, i));
    from = i + Math.max(1, oldString.length);
  }
  const loc = lines.length ? `: ${lines.map((n) => `line ${n}`).join(", ")}` : "";
  return `oldString 匹配到 ${occurrences} 处${loc}，请提供更多上下文以唯一定位`;
}

function parseKind(v: unknown): ProviderKind {
  if (v === "anthropic") return "anthropic";
  if (v === "claude-code") return "claude-code";
  return "openai";
}

function parseEffort(v: unknown): ReasoningEffort | null {
  if (typeof v !== "string") return null;
  if (
    v === "off" ||
    v === "minimal" ||
    v === "low" ||
    v === "medium" ||
    v === "high"
  ) {
    return v;
  }
  return null;
}

/**
 * Returns true if the upstream model name is known to honour reasoning
 * effort (OpenAI) or extended thinking (Anthropic). Anything else has the
 * `reasoning.effort` field silently dropped so we don't surprise an old
 * upstream with an unknown payload key.
 */
function modelSupportsReasoning(kind: ProviderKind, model: string): boolean {
  const m = model.toLowerCase();
  if (kind === "openai") {
    return (
      m.startsWith("gpt-5") ||
      m.startsWith("o1") ||
      m.startsWith("o3") ||
      m.startsWith("o4")
    );
  }
  return (
    m.startsWith("claude-3-7") ||
    m.startsWith("claude-4") ||
    m.startsWith("claude-opus-4") ||
    m.startsWith("claude-sonnet-4") ||
    m.startsWith("claude-haiku-4")
  );
}

/** Anthropic budget tokens per effort level. `off` → no thinking. */
// Deprecated: Claude 4.8+ uses adaptive thinking, not manual budgets

/**
 * Some upstreams (older OpenAI-compatible endpoints) don't accept role=tool.
 * Fold those messages into role=user with a [tool_result] prefix so the model
 * still sees the result without the API rejecting the request.
 */
function downgradeToolMessages(messages: ChatMessageIn[]): {
  role: "system" | "user" | "assistant";
  content: string;
}[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      const tag = m.tool_call_id ? `[tool_result ${m.tool_call_id}]` : "[tool_result]";
      return { role: "user" as const, content: `${tag}\n${m.content}` };
    }
    return { role: m.role, content: m.content };
  });
}

/**
 * Convert OpenAI-style messages array into Anthropic Messages payload.
 * Anthropic requires `system` as a top-level string and messages alternating
 * user/assistant. Tool results are folded into user messages with a
 * `[tool_result]` prefix (same shape as the OpenAI downgrade so the model
 * sees a consistent format regardless of the underlying provider).
 */
function toAnthropicPayload(
  cleaned: ChatMessageIn[],
  model: string,
  stream: boolean,
  effort: ReasoningEffort | null
): {
  model: string;
  system?: string;
  messages: { role: "user" | "assistant"; content: string }[];
  stream: boolean;
  max_tokens: number;
  thinking?: { type: "enabled" | "adaptive"; budget_tokens?: number };
} {
  const systemParts: string[] = [];
  const conv: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of cleaned) {
    if (m.role === "system") {
      systemParts.push(m.content);
      continue;
    }
    if (m.role === "tool") {
      const tag = m.tool_call_id ? `[tool_result ${m.tool_call_id}]` : "[tool_result]";
      conv.push({ role: "user", content: `${tag}\n${m.content}` });
      continue;
    }
    conv.push({ role: m.role, content: m.content });
  }
  // Anthropic rejects two consecutive same-role messages — merge them.
  const merged: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of conv) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) {
      last.content = `${last.content}\n\n${m.content}`;
    } else {
      merged.push({ ...m });
    }
  }
  if (merged.length === 0 || merged[0]!.role !== "user") {
    merged.unshift({ role: "user", content: "(continue)" });
  }
  const payload: {
    model: string;
    system?: string;
    messages: { role: "user" | "assistant"; content: string }[];
    stream: boolean;
    max_tokens: number;
    thinking?: { type: "enabled" | "adaptive"; budget_tokens?: number };
  } = {
    model,
    messages: merged,
    stream,
    max_tokens: 4096,
  };
  if (systemParts.length > 0) payload.system = systemParts.join("\n\n");

  // Claude 4.8+ uses adaptive thinking with output_config.effort
  if (effort && effort !== "off" && modelSupportsReasoning("anthropic", model)) {
    payload.thinking = {
      type: "adaptive",  // 使用 adaptive 而非 enabled
    };

    // 使用 output_config.effort 控制思考强度
    // @ts-ignore - output_config 是新的 API 参数
    payload.output_config = {
      effort: effort,  // "low" | "medium" | "high"
    };

    payload.max_tokens = Math.max(payload.max_tokens, 8192);
  }
  return payload;
}

function sanitizeMessages(messages: unknown): ChatMessageIn[] {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw errors.invalidQuery("messages 必须为非空数组");
  }
  const cleaned: ChatMessageIn[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object") continue;
    const r = (m as { role?: unknown }).role;
    const c = (m as { content?: unknown }).content;
    const tcid = (m as { tool_call_id?: unknown }).tool_call_id;
    if (r !== "system" && r !== "user" && r !== "assistant" && r !== "tool") continue;
    if (typeof c !== "string") continue;
    const entry: ChatMessageIn = { role: r, content: c };
    if (typeof tcid === "string") entry.tool_call_id = tcid;
    cleaned.push(entry);
  }
  if (cleaned.length === 0) {
    throw errors.invalidQuery("messages 中没有有效项");
  }
  return cleaned;
}

function authHeaders(kind: ProviderKind, apiKey: string): Record<string, string> {
  // 通用浏览器 User-Agent，避免某些代理服务检测到 Node.js 后拒绝请求
  const browserUA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36";

  if (kind === "claude-code") {
    // Claude Code 原生方式：完全模拟真实的 Claude Code 请求
    // 基于真实的 Claude Code 请求头分析
    // 生成唯一的 session ID（UUID v4 格式）
    const sessionId = `${Date.now().toString(36)}-${Math.random().toString(36).substring(2, 15)}`;

    return {
      "authorization": `Bearer ${apiKey}`,  // 真实 Claude Code 使用 Bearer
      "anthropic-version": "2023-06-01",
      // 使用真实 Claude Code 的 beta 功能列表
      "anthropic-beta": "claude-code-20250219,context-1m-2025-08-07,interleaved-thinking-2025-05-14,redact-thinking-2026-02-12,context-management-2025-06-27,prompt-caching-scope-2026-01-05,advanced-tool-use-2025-11-20,effort-2025-11-24",
      "anthropic-dangerous-direct-browser-access": "true",
      "user-agent": "claude-cli/2.1.123 (external, cli)",
      "x-app": "cli",
      "x-claude-code-session-id": sessionId,  // Session ID 可能是关键
      "x-stainless-lang": "js",
      "x-stainless-package-version": "0.81.0",
      "x-stainless-runtime": "node",
      "x-stainless-runtime-version": "v24.3.0",
      "x-stainless-arch": "x64",
      "x-stainless-os": "Windows",
    };
  }
  if (kind === "anthropic") {
    // Anthropic 官方 API（标准模式，不带 Beta 功能）
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "user-agent": browserUA,
    };
  }
  // OpenAI 兼容接口
  return {
    authorization: `Bearer ${apiKey}`,
    "user-agent": browserUA,
  };
}

async function callUpstream(
  url: string,
  apiKey: string,
  kind: ProviderKind,
  init: RequestInit
): Promise<unknown> {
  let res: Response;
  try {
    // 对于 claude-code 类型，不添加浏览器特征头（会覆盖 Claude Code 的请求头）
    const browserHeaders: Record<string, string> = kind === "claude-code" ? {} : {
      "accept": "application/json",
      "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
      "accept-encoding": "gzip, deflate, br",
      "cache-control": "no-cache",
      "pragma": "no-cache",
      "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      "sec-ch-ua-mobile": "?0",
      "sec-ch-ua-platform": '"Windows"',
      "sec-fetch-dest": "empty",
      "sec-fetch-mode": "cors",
      "sec-fetch-site": "same-origin",
    };
    const headers = new Headers();
    headers.set("content-type", "application/json");
    for (const [key, value] of Object.entries(browserHeaders)) {
      headers.set(key, value);
    }
    for (const [key, value] of Object.entries(authHeaders(kind, apiKey))) {
      headers.set(key, value);
    }
    new Headers(init.headers).forEach((value, key) => {
      headers.set(key, value);
    });

    res = await fetch(url, {
      ...init,
      headers,
    });
  } catch (e) {
    throw errors.upstreamFailed(`无法连接到 LLM: ${(e as Error).message}`);
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
    const msg =
      (parsed &&
        typeof parsed === "object" &&
        ((parsed as { error?: { message?: string } }).error?.message ??
          (parsed as { message?: string }).message)) ||
      (typeof parsed === "string" ? parsed : `HTTP ${res.status}`);
    throw errors.upstreamFailed(`上游 ${res.status}: ${msg}`);
  }
  return parsed;
}

export async function registerAiRoutes(app: FastifyInstance) {
  app.post<{
    Params: { id: string };
    Body: { baseUrl?: string; apiKey?: string; kind?: ProviderKind };
  }>("/api/workspaces/:id/ai/models", async (req) => {
    const { baseUrl, apiKey } = req.body ?? {};
    const kind = parseKind(req.body?.kind);
    if (typeof baseUrl !== "string" || !baseUrl) {
      throw errors.invalidQuery("缺少 baseUrl");
    }
    if (typeof apiKey !== "string" || !apiKey) {
      throw errors.invalidQuery("缺少 apiKey");
    }

    // Claude Code uses hardcoded model list
    if (kind === "claude-code") {
      return {
        models: [
          "claude-opus-4-8",
          "claude-opus-4-7",
          "claude-opus-4-6",
          "claude-sonnet-4-6",
          "claude-haiku-4-5-20251001",
        ]
      };
    }

    const url = `${normalizeBase(baseUrl)}/models`;
    const data = (await callUpstream(url, apiKey, kind, { method: "GET" })) as {
      data?: Array<{ id?: string }>;
    } | null;
    const models: string[] = [];
    if (data && Array.isArray(data.data)) {
      for (const m of data.data) {
        if (m && typeof m.id === "string") models.push(m.id);
      }
    }
    models.sort((a, b) => a.localeCompare(b));
    return { models };
  });

  app.post<{
    Params: { id: string };
    Body: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      messages?: ChatMessageIn[];
      kind?: ProviderKind;
      reasoning?: { effort?: ReasoningEffort };
    };
  }>("/api/workspaces/:id/ai/chat", async (req) => {
    const { baseUrl, apiKey, model, messages } = req.body ?? {};
    const kind = parseKind(req.body?.kind);
    const effort = parseEffort(req.body?.reasoning?.effort);
    if (typeof baseUrl !== "string" || !baseUrl) {
      throw errors.invalidQuery("缺少 baseUrl");
    }
    if (typeof apiKey !== "string" || !apiKey) {
      throw errors.invalidQuery("缺少 apiKey");
    }
    if (typeof model !== "string" || !model) {
      throw errors.invalidQuery("缺少 model");
    }
    const cleaned = sanitizeMessages(messages);

    if (kind === "anthropic" || kind === "claude-code") {
      // 如果 baseUrl 已经包含 /v1/messages 或 /messages，直接使用
      // 否则追加 /v1/messages
      let url: string;
      const normalized = normalizeBase(baseUrl);
      if (normalized.endsWith('/messages') || normalized.includes('/v1/messages')) {
        url = normalized;
      } else if (normalized.endsWith('/v1')) {
        url = `${normalized}/messages`;
      } else {
        url = `${normalized}/v1/messages`;
      }

      // Claude Code 使用 ?beta=true 参数
      if (kind === "claude-code") {
        url += "?beta=true";
      }

      const payload = toAnthropicPayload(cleaned, model, false, effort);
      const raw = (await callUpstream(url, apiKey, kind, {
        method: "POST",
        body: JSON.stringify(payload),
      })) as {
        content?: Array<{ type?: string; text?: string }>;
      } | null;
      let content = "";
      if (raw && Array.isArray(raw.content)) {
        for (const part of raw.content) {
          if (part && part.type === "text" && typeof part.text === "string") {
            content += part.text;
          }
        }
      }
      return { content, raw };
    }

    const downgraded = downgradeToolMessages(cleaned);
    const url = `${normalizeBase(baseUrl)}/chat/completions`;
    const body: Record<string, unknown> = {
      model,
      messages: downgraded,
      stream: false,
    };
    if (effort && effort !== "off" && modelSupportsReasoning("openai", model)) {
      body.reasoning_effort = effort;
    }
    const raw = (await callUpstream(url, apiKey, kind, {
      method: "POST",
      body: JSON.stringify(body),
    })) as {
      choices?: Array<{ message?: { content?: string } }>;
    } | null;
    const content = raw?.choices?.[0]?.message?.content;
    if (typeof content !== "string") {
      throw errors.upstreamFailed("上游响应缺少 choices[0].message.content");
    }
    return { content, raw };
  });

  // ── Streaming (SSE) chat ──────────────────────────────────────────────
  // Server stays the simple transparent proxy: it only emits delta / done /
  // error events. The osheep code tag protocol (<tasks>/<thought>/<tool>/
  // <ask>/<verify>) is parsed client-side from the raw delta stream.
  app.post<{
    Params: { id: string };
    Body: {
      baseUrl?: string;
      apiKey?: string;
      model?: string;
      messages?: ChatMessageIn[];
      mode?: string;
      kind?: ProviderKind;
      reasoning?: { effort?: ReasoningEffort };
    };
  }>("/api/workspaces/:id/ai/chat/stream", async (req, reply) => {
    const { baseUrl, apiKey, model, messages } = req.body ?? {};
    const kind = parseKind(req.body?.kind);
    const effort = parseEffort(req.body?.reasoning?.effort);
    if (typeof baseUrl !== "string" || !baseUrl) {
      throw errors.invalidQuery("缺少 baseUrl");
    }
    if (typeof apiKey !== "string" || !apiKey) {
      throw errors.invalidQuery("缺少 apiKey");
    }
    if (typeof model !== "string" || !model) {
      throw errors.invalidQuery("缺少 model");
    }
    const cleaned = sanitizeMessages(messages);

    // Take ownership of the raw response from Fastify — otherwise Fastify
    // sees the async handler hasn't called reply.send() and tries to manage
    // the lifecycle itself, which races with our manual reply.raw.* writes
    // and triggers req.raw 'close' → AbortController → fetch is aborted
    // before it even gets a response.
    reply.hijack();

    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let doneSent = false;
    const send = (event: string, data: unknown) => {
      if (event === "done") {
        if (doneSent) return;
        doneSent = true;
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const abort = new AbortController();
    // Only abort upstream when the client *actually* disconnects mid-stream.
    // req.raw.on('close') is misleading: Node fires it whenever the request
    // stream ends, including after we hijack the reply and write our own
    // response — that would abort the very fetch we just kicked off. The
    // right hook is reply.raw.on('close') *before* we've called end() on it,
    // which only fires if the socket dies under us.
    let upstreamDone = false;
    const onSocketClose = () => {
      if (!upstreamDone) abort.abort();
    };
    reply.raw.on("close", onSocketClose);

    const upstreamUrl =
      kind === "anthropic" || kind === "claude-code"
        ? (() => {
            const normalized = normalizeBase(baseUrl);
            let url: string;
            if (normalized.endsWith('/messages') || normalized.includes('/v1/messages')) {
              url = normalized;
            } else if (normalized.endsWith('/v1')) {
              url = `${normalized}/messages`;
            } else {
              url = `${normalized}/v1/messages`;
            }
            // Claude Code 使用 ?beta=true 参数
            if (kind === "claude-code") {
              url += "?beta=true";
            }
            return url;
          })()
        : `${normalizeBase(baseUrl)}/chat/completions`;

    const upstreamBody =
      kind === "anthropic" || kind === "claude-code"
        ? JSON.stringify(toAnthropicPayload(cleaned, model, true, effort))
        : JSON.stringify(
            (() => {
              const b: Record<string, unknown> = {
                model,
                messages: downgradeToolMessages(cleaned),
                stream: true,
              };
              if (
                effort &&
                effort !== "off" &&
                modelSupportsReasoning("openai", model)
              ) {
                b.reasoning_effort = effort;
              }
              return b;
            })()
          );


    let upstream: Response;
    try {
      // 添加更多浏览器特征来绕过严格的客户端检测
      const browserHeaders = {
        "accept-language": "zh-CN,zh;q=0.9,en;q=0.8",
        "accept-encoding": "gzip, deflate, br",
        "cache-control": "no-cache",
        "pragma": "no-cache",
        "sec-ch-ua": '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
        "sec-ch-ua-mobile": "?0",
        "sec-ch-ua-platform": '"Windows"',
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-origin",
      };

      upstream = await fetch(upstreamUrl, {
        method: "POST",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
          ...browserHeaders,
          ...authHeaders(kind, apiKey),
        },
        body: upstreamBody,
      });
    } catch (e) {
      if (!abort.signal.aborted) {
        send("error", { message: `无法连接到 LLM: ${(e as Error).message}` });
      }
      send("done", {});
      reply.raw.end();
      upstreamDone = true; reply.raw.off("close", onSocketClose);
      return;
    }

    if (!upstream.ok || !upstream.body) {
      const text = await upstream.text().catch(() => "");
      send("error", {
        message: `上游 ${upstream.status}: ${text || "无 body"}`,
      });
      send("done", {});
      reply.raw.end();
      upstreamDone = true; reply.raw.off("close", onSocketClose);
      return;
    }

    const ct = upstream.headers.get("content-type") ?? "";
    if (!ct.includes("event-stream")) {
      const txt = await upstream.text();
      try {
        if (kind === "anthropic" || kind === "claude-code") {
          const json = JSON.parse(txt) as {
            content?: Array<{ type?: string; text?: string }>;
            error?: { message?: string; type?: string };
          };
          if (json.error && typeof json.error.message === "string") {
            send("error", { message: `上游错误: ${json.error.message}` });
            send("done", {});
            reply.raw.end();
            upstreamDone = true; reply.raw.off("close", onSocketClose);
            return;
          }
          let content = "";
          if (Array.isArray(json.content)) {
            for (const p of json.content) {
              if (p && p.type === "text" && typeof p.text === "string") {
                content += p.text;
              }
            }
          }
          if (content) send("delta", { content });
        } else {
          const json = JSON.parse(txt) as {
            choices?: Array<{ message?: { content?: string } }>;
            error?: { message?: string; code?: string; type?: string };
          };
          if (json.error && typeof json.error.message === "string") {
            send("error", { message: `上游错误: ${json.error.message}` });
            send("done", {});
            reply.raw.end();
            upstreamDone = true; reply.raw.off("close", onSocketClose);
            return;
          }
          const content = json.choices?.[0]?.message?.content ?? "";
          if (content) send("delta", { content });
        }
      } catch {
        if (txt) send("delta", { content: txt });
      }
      send("done", {});
      reply.raw.end();
      upstreamDone = true; reply.raw.off("close", onSocketClose);
      return;
    }

    const reader = upstream.body.getReader();
    const decoder = new TextDecoder("utf-8");
    let buffer = "";
    let currentEvent = "";

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let nlIdx: number;
        while ((nlIdx = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, nlIdx).replace(/\r$/, "");
          buffer = buffer.slice(nlIdx + 1);
          if (!line) {
            currentEvent = "";
            continue;
          }
          if (line.startsWith(":")) continue; // comment / heartbeat
          if (line.startsWith("event:")) {
            currentEvent = line.slice(6).trim();
            continue;
          }
          if (!line.startsWith("data:")) continue;
          const payload = line.slice(5).trimStart();
          if (kind === "anthropic" || kind === "claude-code") {
            // Anthropic SSE: event: content_block_delta / message_stop / etc.
            if (currentEvent === "message_stop" || payload === "[DONE]") {
              send("done", {});
              continue;
            }
            if (currentEvent === "content_block_delta") {
              try {
                const obj = JSON.parse(payload) as {
                  delta?: { type?: string; text?: string; thinking?: string };
                };
                const piece = obj.delta?.text;
                if (typeof piece === "string" && piece.length > 0) {
                  send("delta", { content: piece });
                }
                const thinking = obj.delta?.thinking;
                if (typeof thinking === "string" && thinking.length > 0) {
                  send("reasoning", { content: thinking });
                }
              } catch (e) {
                // Ignore parse errors in SSE chunks
              }
              continue;
            }
            if (currentEvent === "error" || currentEvent === "message_error") {
              try {
                const obj = JSON.parse(payload) as {
                  error?: { message?: string };
                };
                send("error", { message: obj.error?.message ?? "anthropic error" });
              } catch {
                send("error", { message: "anthropic error" });
              }
              continue;
            }
            continue;
          }

          // OpenAI-style
          if (payload === "[DONE]") {
            send("done", {});
            continue;
          }
          try {
            const obj = JSON.parse(payload) as {
              choices?: Array<{
                delta?: {
                  content?: string;
                  reasoning?: string;
                  reasoning_content?: string;
                };
              }>;
              error?: { message?: string; code?: string; type?: string };
            };
            // Some OpenAI-compatible proxies (and OpenAI itself for things like
            // unknown model id) push errors inline as `data: {"error":{...}}`
            // over a 200/event-stream response instead of failing the HTTP
            // call. Silently dropping them looks identical to "model returned
            // nothing", which is exactly the symptom you're seeing.
            if (obj.error && typeof obj.error.message === "string") {
              send("error", { message: `上游错误: ${obj.error.message}` });
              continue;
            }
            const piece = obj.choices?.[0]?.delta?.content;
            if (typeof piece === "string" && piece.length > 0) {
              send("delta", { content: piece });
            }
            const reasoning =
              obj.choices?.[0]?.delta?.reasoning_content ??
              obj.choices?.[0]?.delta?.reasoning;
            if (typeof reasoning === "string" && reasoning.length > 0) {
              send("reasoning", { content: reasoning });
            }
          } catch {
            /* ignore */
          }
        }
      }
      send("done", {});
    } catch (e) {
      if (!abort.signal.aborted) {
        send("error", { message: (e as Error).message });
      }
      send("done", {});
    } finally {
      try {
        await reader.cancel();
      } catch {
        /* ignore */
      }
      reply.raw.end();
      upstreamDone = true; reply.raw.off("close", onSocketClose);
    }
  });

  // ── Tool exec: read ──────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: {
      kind?: "file" | "list" | "search";
      path?: string;
      includeHidden?: boolean;
      query?: string;
      include?: string | string[];
      exclude?: string | string[];
      startLine?: number;
      lineCount?: number;
    };
  }>("/api/workspaces/:id/ai/exec/read", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body ?? {};
    if (body.kind === "file") {
      if (typeof body.path !== "string") throw errors.invalidQuery("缺少 path");
      const f = await readAiFileText(ws.path, body.path);
      const startLine = toPositiveInt(body.startLine);
      const lineCount = toPositiveInt(body.lineCount);
      const sliced = sliceLines(f.content, startLine, lineCount);
      return {
        kind: "file",
        path: f.path,
        content: sliced.content,
        size: f.size,
        mtime: f.mtime,
        truncated: f.truncated || sliced.truncated,
        startLine: sliced.startLine,
        endLine: sliced.endLine,
        totalLines: sliced.totalLines,
      };
    }
    if (body.kind === "list") {
      const p = typeof body.path === "string" ? body.path : "";
      const entries = await listTree(ws.path, p, body.includeHidden === true);
      return { kind: "list", path: p, entries };
    }
    if (body.kind === "search") {
      if (typeof body.query !== "string" || !body.query) {
        throw errors.invalidQuery("缺少 query");
      }
      const toList = (v: unknown): string[] => {
        if (Array.isArray(v)) return v.filter((s): s is string => typeof s === "string");
        if (typeof v === "string" && v) return [v];
        return [];
      };
      const result = await searchWorkspace(ws.path, {
        query: body.query,
        caseSensitive: false,
        wholeWord: false,
        regex: false,
        include: toList(body.include),
        exclude: toList(body.exclude),
        maxFiles: 5000,
        maxMatchesPerFile: 100,
      });
      return { kind: "search", ...result };
    }
    throw errors.invalidQuery("read.kind 必须为 file/list/search");
  });

  // ── Tool exec: write ─────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: {
      kind?:
        | "write_file"
        | "append_file"
        | "edit_file"
        | "multi_edit"
        | "move"
        | "delete"
        | "create";
      path?: string;
      content?: string;
      createParents?: boolean;
      oldString?: string;
      newString?: string;
      edits?: Array<{ oldString?: unknown; newString?: unknown }>;
      from?: string;
      to?: string;
      recursive?: boolean;
      entryKind?: "file" | "directory";
    };
  }>("/api/workspaces/:id/ai/exec/write", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const b = req.body ?? {};
    if (b.kind === "write_file") {
      if (typeof b.path !== "string") throw errors.invalidQuery("缺少 path");
      if (typeof b.content !== "string") throw errors.invalidQuery("缺少 content");
      if (isObviousWritePlaceholder(b.content)) {
        throw errors.invalidQuery(
          "write_file content 看起来是占位符；请先读取文件并提供完整内容，或改用 edit_file"
        );
      }
      const out = await writeFileText(ws.path, b.path, b.content, b.createParents !== false);
      return { ok: true, kind: "write_file", ...out };
    }
    if (b.kind === "append_file") {
      if (typeof b.path !== "string") throw errors.invalidQuery("缺少 path");
      if (typeof b.content !== "string") throw errors.invalidQuery("缺少 content");
      let existing = "";
      try {
        const f = await readFileText(ws.path, b.path);
        existing = f.content;
      } catch {
        /* missing file → create */
      }
      const out = await writeFileText(ws.path, b.path, existing + b.content, true);
      return { ok: true, kind: "append_file", ...out };
    }
    if (b.kind === "edit_file") {
      if (typeof b.path !== "string") throw errors.invalidQuery("缺少 path");
      if (typeof b.oldString !== "string") throw errors.invalidQuery("缺少 oldString");
      if (typeof b.newString !== "string") throw errors.invalidQuery("缺少 newString");
      const f = await readFileText(ws.path, b.path);
      const before = f.content;
      const occurrences = before.split(b.oldString).length - 1;
      if (occurrences === 0) {
        throw errors.invalidQuery(formatEditMissHint(before, b.oldString, toPosix(b.path)));
      }
      if (occurrences > 1) {
        throw errors.invalidQuery(formatEditAmbiguousHint(before, b.oldString, occurrences));
      }
      const after = before.replace(b.oldString, b.newString);
      const out = await writeFileText(ws.path, b.path, after, false);
      const diff = buildEditDiff(before, after, b.oldString, b.newString);
      return {
        ok: true,
        kind: "edit_file",
        ...out,
        replacements: 1,
        diff,
      };
    }
    if (b.kind === "multi_edit") {
      if (typeof b.path !== "string") throw errors.invalidQuery("缺少 path");
      if (!Array.isArray(b.edits) || b.edits.length === 0) {
        throw errors.invalidQuery("multi_edit 需要非空 edits 数组");
      }
      const edits: Array<{ oldString: string; newString: string }> = [];
      for (let i = 0; i < b.edits.length; i += 1) {
        const e = b.edits[i] as { oldString?: unknown; newString?: unknown };
        if (typeof e?.oldString !== "string" || !e.oldString) {
          throw errors.invalidQuery(`multi_edit edits[${i}]: oldString 必须为非空字符串`);
        }
        if (typeof e?.newString !== "string") {
          throw errors.invalidQuery(`multi_edit edits[${i}]: newString 必须为字符串`);
        }
        edits.push({ oldString: e.oldString, newString: e.newString });
      }
      const f = await readFileText(ws.path, b.path);
      const before = f.content;
      const pathDisplay = toPosix(b.path);
      // Apply edits in order against the running state. Compute each edit's
      // diff metadata against the file *as it stood just before that edit* so
      // startLine numbers are meaningful even when earlier edits shifted text.
      let current = before;
      const perEditDiffs: Array<{
        oldString: string;
        newString: string;
        startLine: number;
        endLineBefore: number;
        endLineAfter: number;
        added: number;
        removed: number;
      }> = [];
      let totalAdded = 0;
      let totalRemoved = 0;
      for (let i = 0; i < edits.length; i += 1) {
        const { oldString, newString } = edits[i]!;
        const occurrences = current.split(oldString).length - 1;
        if (occurrences === 0) {
          throw errors.invalidQuery(
            `multi_edit edits[${i}] 失败：${formatEditMissHint(current, oldString, pathDisplay)}`
          );
        }
        if (occurrences > 1) {
          throw errors.invalidQuery(
            `multi_edit edits[${i}] 失败：${formatEditAmbiguousHint(current, oldString, occurrences)}`
          );
        }
        const next = current.replace(oldString, newString);
        const diff = buildEditDiff(current, next, oldString, newString);
        perEditDiffs.push({
          oldString: diff.oldString,
          newString: diff.newString,
          startLine: diff.startLine,
          endLineBefore: diff.endLineBefore,
          endLineAfter: diff.endLineAfter,
          added: diff.added,
          removed: diff.removed,
        });
        totalAdded += diff.added;
        totalRemoved += diff.removed;
        current = next;
      }
      const out = await writeFileText(ws.path, b.path, current, false);
      return {
        ok: true,
        kind: "multi_edit",
        ...out,
        replacements: edits.length,
        diff: {
          edits: perEditDiffs,
          added: totalAdded,
          removed: totalRemoved,
          before,
          after: current,
        },
      };
    }
    if (b.kind === "move") {
      if (typeof b.from !== "string" || typeof b.to !== "string") {
        throw errors.invalidQuery("缺少 from / to");
      }
      const out = await moveEntry(ws.path, b.from, b.to);
      return { ok: true, kind: "move", ...out };
    }
    if (b.kind === "delete") {
      if (typeof b.path !== "string") throw errors.invalidQuery("缺少 path");
      const out = await deleteEntry(ws.path, b.path, b.recursive === true);
      return { ok: true, kind: "delete", ...out };
    }
    if (b.kind === "create") {
      if (typeof b.path !== "string") throw errors.invalidQuery("缺少 path");
      const k = b.entryKind === "directory" ? "directory" : "file";
      const out = await createEntry(ws.path, b.path, k);
      return { ok: true, action: "create", path: out.path, entryKind: out.kind };
    }
    throw errors.invalidQuery("write.kind 不合法");
  });

  // ── Tool exec: run ───────────────────────────────────────────────────
  app.post<{
    Params: { id: string };
    Body: {
      command?: string;
      cwd?: string;
      shell?: string;
      timeoutMs?: number;
    };
  }>("/api/workspaces/:id/ai/exec/run", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const b = req.body ?? {};
    if (typeof b.command !== "string" || !b.command.trim()) {
      throw errors.invalidQuery("缺少 command");
    }
    const result = await execRun(
      ws.path,
      b.command,
      typeof b.cwd === "string" ? b.cwd : "",
      typeof b.timeoutMs === "number" ? b.timeoutMs : 60_000,
      typeof b.shell === "string" ? b.shell : undefined
    );
    return result;
  });
}
