import { platform } from "./config.js";
import {
  addTap,
  createSession,
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
  signal?: AbortSignal;
  onFrame?: (frame: AgentTerminalFrame) => void;
}

export type AgentTerminalFrame =
  | { type: "session"; sessionId: string }
  | { type: "output"; data: string }
  | { type: "status"; status: "starting" | "ready" | "prompt-sent" | "exited" }
  | { type: "exit"; code: number | null; signal: number | string | null };

export interface AgentTerminalResult {
  sessionId: string;
  content: string;
  transcript: string;
  exitCode: number | null;
  signal: number | string | null;
}

const AUTO_PROMPT_DELAY_MS = 1600;
const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;

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
  opts.onFrame?.({ type: "session", sessionId: session.id });

  let transcript = "";
  let exitCode: number | null = null;
  let exitSignal: number | string | null = null;
  let exited = false;

  const { detach, replayed } = addTap(session, (raw) => {
    const frame = parsePtyFrame(raw);
    if (!frame) return;
    if (frame.type === "output") {
      transcript += frame.data;
      opts.onFrame?.({ type: "output", data: frame.data });
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
    await sleep(AUTO_PROMPT_DELAY_MS, opts.signal);
    if (!opts.signal?.aborted) {
      opts.onFrame?.({ type: "status", status: "ready" });
      writePrompt(session, opts.prompt);
      opts.onFrame?.({ type: "status", status: "prompt-sent" });
    }
    await waitForExit(() => exited, opts.signal);
    opts.onFrame?.({ type: "status", status: "exited" });
    return {
      sessionId: session.id,
      content: extractTerminalContent(transcript),
      transcript,
      exitCode,
      signal: exitSignal,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    detach();
  }
}

function commandFor(kind: CliProviderKind, model: string): string {
  const base = kind === "codex-cli" ? "codex" : "claude";
  if (!model || model === "default") return base;
  return `${base} --model ${quoteShell(model)}`;
}

function writePrompt(session: TerminalSession, prompt: string): void {
  writeRawInput(session, `\x1b[200~${prompt}\x1b[201~\r`);
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

function extractTerminalContent(transcript: string): string {
  return stripAnsi(transcript)
    .replace(/\r/g, "\n")
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      if (/^(?:PS [^>]+>|[$>])\s*/.test(trimmed)) return false;
      if (/^(?:codex|claude)(?:\s|$)/i.test(trimmed)) return false;
      return true;
    })
    .join("\n")
    .trim();
}

function stripAnsi(text: string): string {
  return text.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
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

function waitForExit(done: () => boolean, signal?: AbortSignal): Promise<void> {
  if (done() || signal?.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (done() || signal?.aborted) {
        clearInterval(timer);
        resolve();
      }
    }, 250);
  });
}
