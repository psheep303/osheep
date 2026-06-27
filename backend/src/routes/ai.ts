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
import {
  cliModelShortcuts,
  isCliProviderKind,
  runCliChat,
  type CliProviderKind,
} from "../ai-cli.js";
import {
  continueAgentTerminal,
  injectAgentTerminalPrompt,
  pauseAgentTerminal,
  runAgentTerminal,
  setAgentTerminalAutoContinue,
} from "../ai-terminal.js";

type ProviderKind = CliProviderKind | "unsupported";

const AI_READ_LIMIT = 256 * 1024;

interface ChatMessageIn {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
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
  if (v === "claude-cli") return "claude-cli";
  if (v === "codex-cli") return "codex-cli";
  return "unsupported";
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

function terminalPromptFromMessages(messages: ChatMessageIn[]): string {
  return messages
    .map((m) => {
      const role = m.role === "tool" ? `tool:${m.tool_call_id ?? "result"}` : m.role;
      return messages.length === 1 && m.role === "user"
        ? m.content
        : `### ${role}\n${m.content}`;
    })
    .join("\n\n")
    .trim();
}

export async function registerAiRoutes(app: FastifyInstance) {
  app.post<{
    Params: { id: string };
    Body: { kind?: ProviderKind };
  }>("/api/workspaces/:id/ai/models", async (req) => {
    const kind = parseKind(req.body?.kind);
    if (isCliProviderKind(kind)) {
      return { models: cliModelShortcuts(kind) };
    }
    throw errors.invalidQuery("osheep code only supports Claude Code CLI or Codex CLI");
  });

  app.post<{
    Params: { id: string };
    Body: {
      model?: string;
      messages?: ChatMessageIn[];
      kind?: ProviderKind;
      terminalPrompt?: string;
      autoContinue?: boolean;
    };
  }>("/api/workspaces/:id/ai/chat/terminal", async (req, reply) => {
    const { model, messages } = req.body ?? {};
    const kind = parseKind(req.body?.kind);
    if (!isCliProviderKind(kind)) {
      throw errors.invalidQuery("osheep code only supports Claude Code CLI or Codex CLI");
    }
    const ws = await resolveWorkspace(req.params.id);
    const cleaned = sanitizeMessages(messages);
    const prompt =
      typeof req.body?.terminalPrompt === "string"
        ? req.body.terminalPrompt
        : terminalPromptFromMessages(cleaned);

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let doneSent = false;
    const send = (event: string, data: unknown) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      if (event === "done") {
        if (doneSent) return;
        doneSent = true;
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const abort = new AbortController();
    let runDone = false;
    const onSocketClose = () => {
      if (!runDone) abort.abort();
    };
    reply.raw.on("close", onSocketClose);

    try {
      const result = await runAgentTerminal({
        workspace: ws,
        kind,
        model: typeof model === "string" && model ? model : "default",
        prompt,
        autoContinue: req.body?.autoContinue !== false,
        signal: abort.signal,
        onFrame: (frame) => {
          send(frame.type, frame);
        },
      });
      send("result", result);
    } catch (e) {
      if (!abort.signal.aborted) {
        send("error", { message: (e as Error).message });
      }
    } finally {
      runDone = true;
      send("done", {});
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      reply.raw.off("close", onSocketClose);
    }
  });

  app.post<{
    Params: { id: string; sessionId: string };
    Body: { submit?: boolean };
  }>("/api/workspaces/:id/ai/chat/terminal/:sessionId/inject", async (req) => {
    await resolveWorkspace(req.params.id);
    await injectAgentTerminalPrompt(req.params.sessionId, {
      submit: req.body?.submit,
    });
    return { ok: true };
  });

  app.post<{
    Params: { id: string; sessionId: string };
    Body: { autoContinue?: boolean };
  }>("/api/workspaces/:id/ai/chat/terminal/:sessionId/auto-continue", async (req) => {
    await resolveWorkspace(req.params.id);
    const result = setAgentTerminalAutoContinue(
      req.params.sessionId,
      req.body?.autoContinue !== false
    );
    return { ok: true, ...result };
  });

  app.post<{
    Params: { id: string; sessionId: string };
  }>("/api/workspaces/:id/ai/chat/terminal/:sessionId/pause", async (req) => {
    await resolveWorkspace(req.params.id);
    pauseAgentTerminal(req.params.sessionId);
    return { ok: true };
  });

  app.post<{
    Params: { id: string; sessionId: string };
  }>("/api/workspaces/:id/ai/chat/terminal/:sessionId/continue", async (req) => {
    await resolveWorkspace(req.params.id);
    continueAgentTerminal(req.params.sessionId);
    return { ok: true };
  });

  app.post<{
    Params: { id: string };
    Body: {
      model?: string;
      messages?: ChatMessageIn[];
      kind?: ProviderKind;
    };
  }>("/api/workspaces/:id/ai/chat", async (req) => {
    const { model, messages } = req.body ?? {};
    const kind = parseKind(req.body?.kind);
    if (isCliProviderKind(kind)) {
      const ws = await resolveWorkspace(req.params.id);
      const cleaned = sanitizeMessages(messages);
      const result = await runCliChat({
        kind,
        workspaceRoot: ws.path,
        model: typeof model === "string" && model ? model : "default",
        messages: cleaned,
      });
      return {
        content: result.content,
        raw: {
          stderr: result.stderr,
          exitCode: result.exitCode,
          signal: result.signal,
        },
      };
    }
    throw errors.invalidQuery("osheep code only supports Claude Code CLI or Codex CLI");
  });

  // ── Streaming (SSE) chat ──────────────────────────────────────────────
  // Server stays the simple transparent proxy: it only emits delta / done /
  // error events. The osheep code tag protocol (<tasks>/<thought>/<tool>/
  // <ask>/<verify>) is parsed client-side from the raw delta stream.
  app.post<{
    Params: { id: string };
    Body: {
      model?: string;
      messages?: ChatMessageIn[];
      mode?: string;
      kind?: ProviderKind;
    };
  }>("/api/workspaces/:id/ai/chat/stream", async (req, reply) => {
    const { model, messages } = req.body ?? {};
    const kind = parseKind(req.body?.kind);
    if (isCliProviderKind(kind)) {
      const ws = await resolveWorkspace(req.params.id);
      const cleaned = sanitizeMessages(messages);

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
      let cliDone = false;
      const onSocketClose = () => {
        if (!cliDone) abort.abort();
      };
      reply.raw.on("close", onSocketClose);

      try {
        let emitted = false;
        const result = await runCliChat({
          kind,
          workspaceRoot: ws.path,
          model: typeof model === "string" && model ? model : "default",
          messages: cleaned,
          signal: abort.signal,
          onDelta: (content) => {
            emitted = true;
            send("delta", { content });
          },
          onLog: (entry) => {
            send("log", entry);
          },
        });
        if (!emitted && result.content.trim()) {
          send("delta", { content: result.content });
        }
      } catch (e) {
        if (!abort.signal.aborted) {
          send("error", { message: (e as Error).message });
        }
      } finally {
        send("done", {});
        reply.raw.end();
        cliDone = true;
        reply.raw.off("close", onSocketClose);
      }
      return;
    }
    throw errors.invalidQuery("osheep code only supports Claude Code CLI or Codex CLI");
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

  app.post<{
    Params: { id: string };
    Body: {
      command?: string;
      cwd?: string;
      shell?: string;
      timeoutMs?: number;
    };
  }>("/api/workspaces/:id/ai/exec/run/stream", async (req, reply) => {
    const ws = await resolveWorkspace(req.params.id);
    const b = req.body ?? {};
    if (typeof b.command !== "string" || !b.command.trim()) {
      throw errors.invalidQuery("缂哄皯 command");
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });

    let doneSent = false;
    const send = (event: string, data: unknown) => {
      if (reply.raw.destroyed || reply.raw.writableEnded) return;
      if (event === "done") {
        if (doneSent) return;
        doneSent = true;
      }
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    const abort = new AbortController();
    let runDone = false;
    const onSocketClose = () => {
      if (!runDone) abort.abort();
    };
    reply.raw.on("close", onSocketClose);

    try {
      const result = await execRun(
        ws.path,
        b.command,
        typeof b.cwd === "string" ? b.cwd : "",
        typeof b.timeoutMs === "number" ? b.timeoutMs : 60_000,
        typeof b.shell === "string" ? b.shell : undefined,
        {
          signal: abort.signal,
          onLog: (entry) => {
            send("log", entry);
          },
        }
      );
      send("result", result);
    } catch (e) {
      if (!abort.signal.aborted) {
        send("error", { message: (e as Error).message });
      }
    } finally {
      runDone = true;
      send("done", {});
      if (!reply.raw.destroyed && !reply.raw.writableEnded) reply.raw.end();
      reply.raw.off("close", onSocketClose);
    }
  });
}
