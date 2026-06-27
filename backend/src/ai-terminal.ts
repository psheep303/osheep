import { platform } from "./config.js";
import {
  addTap,
  createSession,
  getSession,
  killSession,
  writeRawInput,
  type TerminalSession,
} from "./pty.js";
import type { WorkspaceInfo } from "./workspace.js";
import type { CliProviderKind } from "./ai-cli.js";

export interface AgentTerminalOptions {
  workspace: WorkspaceInfo;
  kind: CliProviderKind;
  model: string;
  prompt: string;
  autoContinue?: boolean;
  signal?: AbortSignal;
  onFrame?: (frame: AgentTerminalFrame) => void;
}

export type AgentTerminalFrame =
  | { type: "session"; sessionId: string }
  | { type: "output"; data: string }
  | {
      type: "status";
      status:
        | "starting"
        | "waiting-for-input"
        | "ready"
        | "prompt-injected"
        | "prompt-sent"
        | "prompt-timeout"
        | "auto-finished"
        | "exited";
    }
  | { type: "exit"; code: number | null; signal: number | string | null };

export interface AgentTerminalResult {
  sessionId: string;
  content: string;
  transcript: string;
  exitCode: number | null;
  signal: number | string | null;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const READY_TIMEOUT_MS = 8_000;
const QUIET_READY_MS = 700;
const AUTO_CONTINUE_GRACE_MS = 1_200;
const RESPONSE_MIN_MS = 2_400;
const RESPONSE_IDLE_MS = 6_000;
const RESPONSE_MAX_MS = 20 * 60_000;
const PASTE_CHUNK_SIZE = 2048;

interface AgentTerminalControl {
  prompt: string;
  createdAt: number;
  autoContinue: boolean;
  autoFinishPaused: boolean;
  promptInjected: boolean;
  promptSubmitted: boolean;
  promptSubmittedAt?: number;
}

const controls = new Map<string, AgentTerminalControl>();

export async function runAgentTerminal(
  opts: AgentTerminalOptions
): Promise<AgentTerminalResult> {
  const session = createSession({
    workspace: opts.workspace,
    shell: platform === "windows" ? "powershell" : "bash",
    cols: DEFAULT_COLS,
    rows: DEFAULT_ROWS,
    killOnDetach: false,
  });
  controls.set(session.id, {
    prompt: opts.prompt,
    createdAt: Date.now(),
    autoContinue: opts.autoContinue !== false,
    autoFinishPaused: false,
    promptInjected: false,
    promptSubmitted: false,
  });
  opts.onFrame?.({ type: "session", sessionId: session.id });

  let transcript = "";
  let exitCode: number | null = null;
  let exitSignal: number | string | null = null;
  let exited = false;
  let lastOutputAt = Date.now();
  let wakeOutput = () => {};

  const { detach, replayed } = addTap(session, (raw) => {
    const frame = parsePtyFrame(raw);
    if (!frame) return;
    if (frame.type === "output") {
      lastOutputAt = Date.now();
      transcript += frame.data;
      opts.onFrame?.({ type: "output", data: frame.data });
      wakeOutput();
      return;
    }
    if (frame.type === "exit") {
      exitCode = frame.code;
      exitSignal = frame.signal;
      exited = true;
      opts.onFrame?.({ type: "exit", code: exitCode, signal: exitSignal });
    }
  });
  if (replayed) {
    transcript += replayed;
    opts.onFrame?.({ type: "output", data: replayed });
  }

  const onAbort = () => {
    killSession(session.id, "agent-terminal-abort");
  };
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    opts.onFrame?.({ type: "status", status: "starting" });
    writeRawInput(session, `${commandFor(opts.kind, opts.model)}\r`);
    opts.onFrame?.({ type: "status", status: "waiting-for-input" });
    const ready = await waitForInputReady(
      opts.kind,
      () => transcript,
      () => lastOutputAt,
      (wake) => {
        wakeOutput = wake;
      },
      opts.signal
    );
    if (!opts.signal?.aborted) {
      opts.onFrame?.({ type: "status", status: ready ? "ready" : "prompt-timeout" });
      await injectAgentTerminalPrompt(session.id, { submit: false });
      opts.onFrame?.({ type: "status", status: "prompt-injected" });
      if (isAgentTerminalAutoContinueEnabled(session.id)) {
        await sleep(AUTO_CONTINUE_GRACE_MS, opts.signal);
      }
      if (!opts.signal?.aborted && isAgentTerminalAutoContinueEnabled(session.id)) {
        await submitAgentTerminalPrompt(session.id);
        opts.onFrame?.({ type: "status", status: "prompt-sent" });
      } else if (!opts.signal?.aborted) {
        opts.onFrame?.({ type: "status", status: "waiting-for-input" });
      }
    }
    const completion = await waitForAgentCompletion(
      session.id,
      () => exited,
      () => lastOutputAt,
      () => extractTerminalContent(transcript, opts.prompt),
      opts.signal
    );
    if (completion === "idle" || completion === "timeout") {
      const content = extractTerminalContent(transcript, opts.prompt);
      const cleanTranscript = cleanTerminalTranscript(transcript, opts.prompt);
      opts.onFrame?.({ type: "status", status: "auto-finished" });
      try {
        session.pty.kill();
      } catch {
        /* already closed */
      }
      opts.onFrame?.({ type: "status", status: "exited" });
      return {
        sessionId: session.id,
        content,
        transcript: cleanTranscript,
        exitCode: 0,
        signal: completion === "timeout" ? "auto-timeout" : "auto-finished",
      };
    }
    opts.onFrame?.({ type: "status", status: "exited" });
    return {
      sessionId: session.id,
      content: extractTerminalContent(transcript, opts.prompt),
      transcript: cleanTerminalTranscript(transcript, opts.prompt),
      exitCode,
      signal: exitSignal,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    controls.delete(session.id);
    detach();
  }
}

export function setAgentTerminalAutoContinue(
  sessionId: string,
  enabled: boolean
): { autoContinue: boolean } {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  control.autoContinue = enabled;
  return { autoContinue: control.autoContinue };
}

export async function injectAgentTerminalPrompt(
  sessionId: string,
  options: { submit?: boolean } = {}
): Promise<void> {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  const session = getSession(sessionId);
  if (!control.promptInjected) {
    await writePrompt(session, control.prompt, false);
    control.promptInjected = true;
  }
  const submit = options.submit ?? control.autoContinue;
  if (submit) {
    await submitAgentTerminalPrompt(sessionId);
  }
}

export async function submitAgentTerminalPrompt(sessionId: string): Promise<void> {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  const session = getSession(sessionId);
  if (!control.promptInjected) {
    await writePrompt(session, control.prompt, false);
    control.promptInjected = true;
  }
  if (control.promptSubmitted) return;
  await sleep(80);
  writeRawInput(session, "\r");
  markPromptSubmitted(control);
}

export function pauseAgentTerminal(sessionId: string): void {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  const session = getSession(sessionId);
  control.autoFinishPaused = true;
  writeRawInput(session, "\x03");
}

export function continueAgentTerminal(sessionId: string): void {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  const session = getSession(sessionId);
  writeRawInput(session, "\r");
  control.autoFinishPaused = false;
  markPromptSubmitted(control);
}

function markPromptSubmitted(control: AgentTerminalControl): void {
  control.promptSubmitted = true;
  control.promptSubmittedAt = Date.now();
  control.autoFinishPaused = false;
}

function commandFor(kind: CliProviderKind, model: string): string {
  const base = kind === "codex-cli" ? "codex" : "claude";
  if (!model || model === "default") return base;
  return `${base} --model ${quoteShell(model)}`;
}

function isAgentTerminalAutoContinueEnabled(sessionId: string): boolean {
  return controls.get(sessionId)?.autoContinue ?? true;
}

async function writePrompt(
  session: TerminalSession,
  prompt: string,
  submit: boolean
): Promise<void> {
  if (prompt.length <= 512 && !/[\r\n]/.test(prompt)) {
    writeRawInput(session, prompt);
    if (submit) {
      await sleep(80);
      writeRawInput(session, "\r");
    }
    return;
  }
  writeRawInput(session, "\x1b[200~");
  for (let i = 0; i < prompt.length; i += PASTE_CHUNK_SIZE) {
    writeRawInput(session, prompt.slice(i, i + PASTE_CHUNK_SIZE));
    await sleep(8);
  }
  writeRawInput(session, "\x1b[201~");
  if (submit) {
    await sleep(80);
    writeRawInput(session, "\r");
  }
}

function parsePtyFrame(
  raw: string
): { type: "output"; data: string } | { type: "exit"; code: number | null; signal: number | string | null } | null {
  try {
    const frame = JSON.parse(raw) as {
      type?: string;
      data?: string;
      code?: number | null;
      signal?: number | string | null;
    };
    if (frame.type === "output" && typeof frame.data === "string") {
      return { type: "output", data: frame.data };
    }
    if (frame.type === "exit") {
      return {
        type: "exit",
        code: typeof frame.code === "number" ? frame.code : null,
        signal:
          typeof frame.signal === "number" || typeof frame.signal === "string"
            ? frame.signal
            : null,
      };
    }
  } catch {
    /* ignore */
  }
  return null;
}

function extractTerminalContent(transcript: string, prompt = ""): string {
  const clean = cleanTerminalTranscript(transcript, prompt);
  return clean
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "");
}

function cleanTerminalTranscript(raw: string, prompt = ""): string {
  const rendered = renderTerminalScreen(raw);
  const plain = normalizeTerminalPlainText(rendered || raw);
  const promptLines = new Set(
    normalizeTerminalPlainText(prompt)
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
  return plain
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => keepTerminalLine(line, promptLines))
    .join("\n")
    .trim();
}

function keepTerminalLine(line: string, promptLines: Set<string>): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;
  if (promptLines.has(trimmed)) return false;
  if (/^(?:PS [^>]+>|[$>])\s*/.test(trimmed)) return false;
  if (/^(?:codex|claude)(?:\.exe)?(?:\s|$)/i.test(trimmed)) return false;
  if (/^(?:OpenAI Codex|Claude Code)\b/i.test(trimmed)) return false;
  if (/^(?:cwd|directory|model)\s*:/i.test(trimmed)) return false;
  if (/^(?:press|try)\s+/i.test(trimmed)) return false;
  if (/^(?:working|thinking|interrupting|esc to interrupt)\b/i.test(trimmed)) return false;
  if (/^[\u2500-\u257f\s]+$/.test(trimmed)) return false;
  return true;
}

function normalizeTerminalPlainText(text: string): string {
  return stripAnsi(text)
    .replace(/\r/g, "\n")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "")
    .split("\n")
    .map((line) => line.replace(/\s+$/g, ""))
    .join("\n");
}

function renderTerminalScreen(raw: string): string {
  const rows: string[] = [""];
  let row = 0;
  let col = 0;

  const ensureRow = () => {
    while (rows.length <= row) rows.push("");
  };
  const setLine = (value: string) => {
    ensureRow();
    rows[row] = value;
  };
  const put = (ch: string) => {
    ensureRow();
    const line = rows[row] ?? "";
    const padded = line.length < col ? line + " ".repeat(col - line.length) : line;
    setLine(padded.slice(0, col) + ch + padded.slice(col + 1));
    col += 1;
  };
  const move = (nextRow: number, nextCol: number) => {
    row = Math.max(0, nextRow);
    col = Math.max(0, nextCol);
    ensureRow();
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch === "\x1b") {
      const consumed = consumeEscape(raw, i, rows, () => row, () => col, move, setLine);
      if (consumed > i) {
        i = consumed;
      }
      continue;
    }
    if (ch === "\r") {
      col = 0;
      continue;
    }
    if (ch === "\n") {
      row += 1;
      col = 0;
      ensureRow();
      continue;
    }
    if (ch === "\b" || ch === "\x7f") {
      col = Math.max(0, col - 1);
      continue;
    }
    if (ch === "\t") {
      const spaces = 4 - (col % 4);
      for (let j = 0; j < spaces; j += 1) put(" ");
      continue;
    }
    if (ch >= " ") put(ch);
  }

  return rows.join("\n");
}

function consumeEscape(
  raw: string,
  start: number,
  rows: string[],
  getRow: () => number,
  getCol: () => number,
  move: (row: number, col: number) => void,
  setLine: (value: string) => void
): number {
  const next = raw[start + 1];
  if (!next) return start;
  if (next === "]") {
    for (let i = start + 2; i < raw.length; i += 1) {
      if (raw[i] === "\x07") return i;
      if (raw[i] === "\x1b" && raw[i + 1] === "\\") return i + 1;
    }
    return raw.length - 1;
  }
  if (next !== "[") return start + 1;

  let end = start + 2;
  while (end < raw.length && !/[@-~]/.test(raw[end]!)) end += 1;
  if (end >= raw.length) return raw.length - 1;
  const final = raw[end]!;
  const body = raw.slice(start + 2, end);
  const parts = body
    .replace(/^\?/, "")
    .split(";")
    .map((part) => Number.parseInt(part || "0", 10));
  const row = getRow();
  const col = getCol();

  if (final === "J" && (parts[0] === 2 || parts[0] === 3)) {
    rows.splice(0, rows.length, "");
    move(0, 0);
  } else if (final === "K") {
    const line = rows[row] ?? "";
    setLine(line.slice(0, col));
  } else if (final === "H" || final === "f") {
    move(Math.max(0, (parts[0] || 1) - 1), Math.max(0, (parts[1] || 1) - 1));
  } else if (final === "G") {
    move(row, Math.max(0, (parts[0] || 1) - 1));
  } else if (final === "A") {
    move(row - (parts[0] || 1), col);
  } else if (final === "B") {
    move(row + (parts[0] || 1), col);
  } else if (final === "C") {
    move(row, col + (parts[0] || 1));
  } else if (final === "D") {
    move(row, col - (parts[0] || 1));
  }
  return end;
}

async function waitForInputReady(
  kind: CliProviderKind,
  transcript: () => string,
  lastOutputAt: () => number,
  setWake: (wake: () => void) => void,
  signal?: AbortSignal
): Promise<boolean> {
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      setWake(() => {});
    };
    const finish = (value: boolean) => {
      cleanup();
      resolve(value);
    };
    const onAbort = () => finish(false);
    const check = () => {
      if (signal?.aborted) return finish(false);
      const plain = stripAnsi(transcript()).replace(/\r/g, "\n");
      const quietMs = Date.now() - lastOutputAt();
      if (isReadyText(kind, plain) && quietMs >= QUIET_READY_MS) {
        return finish(true);
      }
      if (Date.now() - startedAt >= READY_TIMEOUT_MS) {
        return finish(false);
      }
      timer = setTimeout(check, 160);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    setWake(() => {
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      timer = setTimeout(check, 160);
    });
    check();
  });
}

function isReadyText(kind: CliProviderKind, text: string): boolean {
  const compact = text.replace(/\s+/g, " ").trim();
  if (kind === "codex-cli") {
    return (
      /OpenAI Codex/i.test(compact) &&
      (/\/model\b/i.test(compact) || /directory:/i.test(compact) || /\u203a/.test(text))
    );
  }
  return (
    /Claude Code/i.test(compact) ||
    /Welcome to Claude/i.test(compact) ||
    /cwd:/i.test(compact) ||
    /try "claude"/i.test(compact)
  );
}

function waitForAgentCompletion(
  sessionId: string,
  done: () => boolean,
  lastOutputAt: () => number,
  content: () => string,
  signal?: AbortSignal
): Promise<"exited" | "idle" | "timeout" | "aborted"> {
  if (done()) return Promise.resolve("exited");
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (done()) {
        clearInterval(timer);
        resolve("exited");
        return;
      }
      if (signal?.aborted) {
        clearInterval(timer);
        resolve("aborted");
        return;
      }
      const control = controls.get(sessionId);
      if (!control?.promptSubmittedAt || control.autoFinishPaused) return;
      const now = Date.now();
      const sinceSubmit = now - control.promptSubmittedAt;
      if (sinceSubmit >= RESPONSE_MAX_MS) {
        clearInterval(timer);
        resolve("timeout");
        return;
      }
      if (
        sinceSubmit >= RESPONSE_MIN_MS &&
        now - lastOutputAt() >= RESPONSE_IDLE_MS &&
        content().trim()
      ) {
        clearInterval(timer);
        resolve("idle");
      }
    }, 500);
  });
}

function quoteShell(value: string): string {
  if (/^[A-Za-z0-9._:-]+$/.test(value)) return value;
  return platform === "windows"
    ? `"${value.replace(/"/g, '\\"')}"`
    : `'${value.replace(/'/g, "'\\''")}'`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        resolve();
      },
      { once: true }
    );
  });
}
