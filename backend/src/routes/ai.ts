import type { FastifyInstance } from "fastify";
import { errors } from "../errors.js";
import { resolveWorkspace } from "../workspace.js";
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

type ProviderKind = "openai" | "anthropic";

type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high";

interface ChatMessageIn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

function normalizeBase(baseUrl: string): string {
  return baseUrl.replace(/\/+$/, "");
}

function parseKind(v: unknown): ProviderKind {
  return v === "anthropic" ? "anthropic" : "openai";
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
function anthropicBudget(effort: ReasoningEffort): number | null {
  switch (effort) {
    case "off":
      return null;
    case "low":
      return 4096;
    case "medium":
      return 16384;
    case "high":
      return 32768;
    case "minimal":
      return 4096; // anthropic doesn't have a "minimal" — alias to low
    default:
      return null;
  }
}

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
  thinking?: { type: "enabled"; budget_tokens: number };
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
    thinking?: { type: "enabled"; budget_tokens: number };
  } = {
    model,
    messages: merged,
    stream,
    max_tokens: 4096,
  };
  if (systemParts.length > 0) payload.system = systemParts.join("\n\n");
  if (effort && modelSupportsReasoning("anthropic", model)) {
    const budget = anthropicBudget(effort);
    if (budget !== null) {
      payload.thinking = { type: "enabled", budget_tokens: budget };
      // Extended thinking requires max_tokens > budget_tokens.
      payload.max_tokens = Math.max(payload.max_tokens, budget + 2048);
    }
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
  if (kind === "anthropic") {
    return {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      // Some Anthropic-compatible proxies still expect Authorization too —
      // sending both is harmless to the official API.
      authorization: `Bearer ${apiKey}`,
    };
  }
  return { authorization: `Bearer ${apiKey}` };
}

async function callUpstream(
  url: string,
  apiKey: string,
  kind: ProviderKind,
  init: RequestInit
): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        ...authHeaders(kind, apiKey),
        ...(init.headers ?? {}),
      },
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

    if (kind === "anthropic") {
      const url = `${normalizeBase(baseUrl)}/messages`;
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
  // error events. The osheep code tag protocol (<plan>/<thought>/<tool>/
  // <verify>) is parsed client-side from the raw delta stream.
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
      kind === "anthropic"
        ? `${normalizeBase(baseUrl)}/messages`
        : `${normalizeBase(baseUrl)}/chat/completions`;

    const upstreamBody =
      kind === "anthropic"
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
      upstream = await fetch(upstreamUrl, {
        method: "POST",
        signal: abort.signal,
        headers: {
          "content-type": "application/json",
          accept: "text/event-stream",
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
        if (kind === "anthropic") {
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
          if (kind === "anthropic") {
            // Anthropic SSE: event: content_block_delta / message_stop / etc.
            // Translate to OpenAI-style delta/done so the frontend parser
            // doesn't need to know the upstream wire format.
            if (currentEvent === "message_stop" || payload === "[DONE]") {
              send("done", {});
              continue;
            }
            if (currentEvent === "content_block_delta") {
              try {
                const obj = JSON.parse(payload) as {
                  delta?: { type?: string; text?: string };
                };
                const piece = obj.delta?.text;
                if (typeof piece === "string" && piece.length > 0) {
                  send("delta", { content: piece });
                }
              } catch {
                /* ignore */
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
            // Other events (ping, message_start, content_block_start, etc.)
            // are not forwarded.
            continue;
          }

          // OpenAI-style
          if (payload === "[DONE]") {
            send("done", {});
            continue;
          }
          try {
            const obj = JSON.parse(payload) as {
              choices?: Array<{ delta?: { content?: string } }>;
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
    };
  }>("/api/workspaces/:id/ai/exec/read", async (req) => {
    const ws = await resolveWorkspace(req.params.id);
    const body = req.body ?? {};
    if (body.kind === "file") {
      if (typeof body.path !== "string") throw errors.invalidQuery("缺少 path");
      const f = await readFileText(ws.path, body.path);
      const MAX_READ = 256 * 1024;
      let content = f.content;
      let truncated = false;
      if (content.length > MAX_READ) {
        content = content.slice(0, MAX_READ);
        truncated = true;
      }
      return {
        kind: "file",
        path: f.path,
        content,
        size: f.size,
        mtime: f.mtime,
        truncated,
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
        | "move"
        | "delete"
        | "create";
      path?: string;
      content?: string;
      createParents?: boolean;
      oldString?: string;
      newString?: string;
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
      const occurrences = f.content.split(b.oldString).length - 1;
      if (occurrences === 0) {
        throw errors.invalidQuery("oldString 在文件中未找到");
      }
      if (occurrences > 1) {
        throw errors.invalidQuery(
          `oldString 匹配到 ${occurrences} 处，请提供更多上下文以唯一定位`
        );
      }
      const next = f.content.replace(b.oldString, b.newString);
      const out = await writeFileText(ws.path, b.path, next, false);
      return { ok: true, kind: "edit_file", ...out, replacements: 1 };
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
