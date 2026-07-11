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

export type ClaudePermissionMode =
  | "default"
  | "acceptEdits"
  | "auto"
  | "dontAsk"
  | "bypassPermissions";
export type AgentMode = "default" | "goal" | "plan";
export type CodexApproval = "untrusted" | "on-request" | "never";
export type CodexSandbox = "read-only" | "workspace-write" | "danger-full-access";
export type AgentEffort =
  | "off"
  | "minimal"
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max"
  | "ultracode";
export type AgentTerminalContentState =
  | "empty"
  | "waiting-for-choice"
  | "ready-for-success";
export type AgentTerminalStatus =
  | "starting"
  | "waiting-for-input"
  | "ready"
  | "prompt-injected"
  | "prompt-sent"
  | "prompt-timeout"
  | "waiting-for-choice"
  | "ready-for-success"
  | "auto-finished"
  | "manual-success"
  | "exited";

export interface AgentTerminalOptions {
  workspace: WorkspaceInfo;
  kind: CliProviderKind;
  model: string;
  prompt: string;
  autoSuccess?: boolean;
  claudePermissionMode?: ClaudePermissionMode;
  mode?: AgentMode;
  codexApproval?: CodexApproval;
  codexSandbox?: CodexSandbox;
  effort?: AgentEffort;
  alwaysEnter?: boolean;
  signal?: AbortSignal;
  onFrame?: (frame: AgentTerminalFrame) => void;
}

export type AgentTerminalFrame =
  | { type: "session"; sessionId: string }
  | { type: "output"; data: string }
  | {
      type: "status";
      status: AgentTerminalStatus;
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
const RESPONSE_MIN_MS = 2_400;
const RESPONSE_IDLE_MS = 6_000;
const RESPONSE_MAX_MS = 20 * 60_000;
const BRACKETED_PASTE_MIN_LENGTH = 512;
const PASTE_CHUNK_SIZE = 2048;
const PROMPT_SUBMIT_DELAY_MS = 80;
const PASTED_PROMPT_SUBMIT_BASE_DELAY_MS = 300;
const PASTED_PROMPT_CHARS_PER_DELAY_MS = 12;
const PASTED_PROMPT_SUBMIT_MAX_DELAY_MS = 1_500;
const PASTED_PROMPT_SECOND_ENTER_DELAY_MS = 180;
const PASTED_PROMPT_FOLLOW_UP_ENTER_DELAY_MS = 1_200;
const PASTED_PROMPT_FOLLOW_UP_ENTER_MAX = 2;
const PROMPT_INPUT_RENDER_QUIET_MS = 350;
const PROMPT_INPUT_RENDER_NO_ECHO_MS = 900;
const PROMPT_INPUT_RENDER_TIMEOUT_MS = 8_000;
const ALWAYS_ENTER_COOLDOWN_MS = 1_500;

interface AgentTerminalControl {
  prompt: string;
  createdAt: number;
  autoSuccess: boolean;
  alwaysEnter: boolean;
  autoFinishPaused: boolean;
  promptInjected: boolean;
  promptSubmitted: boolean;
  promptSubmittedAt?: number;
  pastedPromptFollowUpEnterCount?: number;
  lastPastedPromptFollowUpEnterAt?: number;
  manualSuccessRequested: boolean;
  lastCompletionState?: AgentTerminalContentState;
  lastAlwaysEnterAt?: number;
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
    autoSuccess: opts.autoSuccess !== false,
    alwaysEnter: opts.alwaysEnter === true,
    autoFinishPaused: false,
    promptInjected: false,
    promptSubmitted: false,
    manualSuccessRequested: false,
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
    writeRawInput(
      session,
      `${buildAgentTerminalCommand(opts.kind, opts.model, {
        claudePermissionMode: opts.claudePermissionMode,
        mode: opts.mode,
        codexApproval: opts.codexApproval,
        codexSandbox: opts.codexSandbox,
        effort: opts.effort,
      }).command}\r`
    );
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
      await waitForPromptInputRendered(
        opts.prompt,
        () => transcript,
        () => lastOutputAt,
        opts.signal
      );
      await submitAgentTerminalPrompt(session.id);
      opts.onFrame?.({ type: "status", status: "prompt-sent" });
    }
    const completion = await waitForAgentCompletion(
      session.id,
      () => exited,
      () => lastOutputAt,
      () => transcript,
      () => extractTerminalContent(transcript, opts.prompt, opts.kind),
      (status) => opts.onFrame?.({ type: "status", status }),
      opts.signal
    );
    if (completion === "idle" || completion === "timeout" || completion === "manual-success") {
      const content = extractTerminalContent(transcript, opts.prompt, opts.kind);
      const cleanTranscript = cleanTerminalTranscript(transcript, opts.prompt);
      opts.onFrame?.({
        type: "status",
        status: completion === "manual-success" ? "manual-success" : "auto-finished",
      });
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
        signal:
          completion === "timeout"
            ? "auto-timeout"
            : completion === "manual-success"
              ? "manual-success"
              : "auto-finished",
      };
    }
    opts.onFrame?.({ type: "status", status: "exited" });
    return {
      sessionId: session.id,
      content: extractTerminalContent(transcript, opts.prompt, opts.kind),
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
  control.autoSuccess = enabled;
  return { autoContinue: control.autoSuccess };
}

export function setAgentTerminalAutoSuccess(
  sessionId: string,
  enabled: boolean
): { autoSuccess: boolean } {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  control.autoSuccess = enabled;
  return { autoSuccess: control.autoSuccess };
}

export function finishAgentTerminalSuccess(sessionId: string): void {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  control.lastCompletionState = "ready-for-success";
  control.manualSuccessRequested = true;
}

export function createAgentTerminalControlForTest(
  sessionId: string,
  patch: Partial<AgentTerminalControl> = {}
): void {
  controls.set(sessionId, {
    prompt: "",
    createdAt: Date.now(),
    autoSuccess: true,
    alwaysEnter: false,
    autoFinishPaused: false,
    promptInjected: true,
    promptSubmitted: true,
    promptSubmittedAt: Date.now(),
    manualSuccessRequested: false,
    ...patch,
  });
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
  const submit = options.submit ?? true;
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
  await submitPromptInput(session, control.prompt);
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

export function buildAgentTerminalCommand(
  kind: CliProviderKind,
  model: string,
  options: {
    claudePermissionMode?: ClaudePermissionMode;
    mode?: AgentMode;
    codexApproval?: CodexApproval;
    codexSandbox?: CodexSandbox;
    effort?: AgentEffort;
  } = {}
): { command: string } {
  const base = kind === "codex-cli" ? "codex" : "claude";
  const args: string[] = [];
  if (kind === "claude-cli") {
    args.push(
      "--permission-mode",
      options.mode === "plan" ? "plan" : options.claudePermissionMode ?? "acceptEdits"
    );
    const effort = agentEffortCliValue(kind, options.effort);
    if (effort) args.push("--effort", effort);
  } else {
    args.push(...codexPermissionArgs(options.codexApproval, options.codexSandbox));
    const effort = agentEffortCliValue(kind, options.effort);
    if (effort) {
      args.push("-c", quoteCodexConfig(`model_reasoning_effort="${effort}"`));
    }
  }
  if (model && model !== "default") args.push("--model", quoteShell(model));
  return { command: [base, ...args].join(" ") };
}

function codexPermissionArgs(
  approval: CodexApproval | undefined,
  sandbox: CodexSandbox | undefined
): string[] {
  return [
    "--ask-for-approval",
    normalizeCodexApproval(approval),
    "--sandbox",
    sandbox ?? "workspace-write",
  ];
}

function normalizeCodexApproval(approval: unknown): CodexApproval {
  if (approval === "untrusted" || approval === "on-request" || approval === "never") {
    return approval;
  }
  return "on-request";
}

function agentEffortCliValue(
  kind: CliProviderKind,
  effort: AgentEffort | undefined
): string | null {
  if (!effort || effort === "off") return null;
  if (kind === "claude-cli") {
    if (
      effort === "low" ||
      effort === "medium" ||
      effort === "high" ||
      effort === "xhigh" ||
      effort === "max" ||
      effort === "ultracode"
    ) {
      return effort;
    }
    return effort === "minimal" ? "low" : null;
  }
  if (
    effort === "minimal" ||
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh"
  ) {
    return effort;
  }
  return effort === "max" ? "high" : null;
}

function quoteCodexConfig(value: string): string {
  return `'${value.replace(/'/g, platform === "windows" ? "''" : "'\\''")}'`;
}

export function shouldAutoEnterChoice(input: {
  alwaysEnter: boolean;
  state: AgentTerminalContentState;
  now: number;
  lastEnterAt?: number;
}): boolean {
  return (
    input.alwaysEnter &&
    input.state === "waiting-for-choice" &&
    (input.lastEnterAt === undefined ||
      input.now - input.lastEnterAt >= ALWAYS_ENTER_COOLDOWN_MS)
  );
}

async function writePrompt(
  session: TerminalSession,
  prompt: string,
  submit: boolean
): Promise<void> {
  for (const chunk of buildAgentTerminalPromptWrites(prompt, submit)) {
    if (chunk === "\r") {
      await submitPromptInput(session, prompt);
      continue;
    }
    writeRawInput(session, chunk);
    await sleep(8);
  }
}

async function submitPromptInput(
  session: TerminalSession,
  prompt: string
): Promise<void> {
  await sleep(agentTerminalPromptSubmitDelayMs(prompt));
  const enterCount = agentTerminalPromptEnterCount(prompt);
  for (let index = 0; index < enterCount; index += 1) {
    if (index > 0) await sleep(PASTED_PROMPT_SECOND_ENTER_DELAY_MS);
    writeRawInput(session, "\r");
  }
}

export function agentTerminalPromptEnterCount(prompt: string): number {
  return isPastedAgentTerminalPrompt(prompt) ? 2 : 1;
}

export function agentTerminalPromptSubmitDelayMs(prompt: string): number {
  if (!isPastedAgentTerminalPrompt(prompt)) return PROMPT_SUBMIT_DELAY_MS;
  return Math.min(
    PASTED_PROMPT_SUBMIT_MAX_DELAY_MS,
    PASTED_PROMPT_SUBMIT_BASE_DELAY_MS +
      Math.ceil(prompt.length / PASTED_PROMPT_CHARS_PER_DELAY_MS)
  );
}

export function buildAgentTerminalPromptWrites(
  prompt: string,
  submit: boolean
): string[] {
  const writes: string[] = [];
  if (isPastedAgentTerminalPrompt(prompt)) {
    writes.push("\x1b[200~");
    for (let i = 0; i < prompt.length; i += PASTE_CHUNK_SIZE) {
      writes.push(prompt.slice(i, i + PASTE_CHUNK_SIZE));
    }
    writes.push("\x1b[201~");
  } else {
    for (let i = 0; i < prompt.length; i += PASTE_CHUNK_SIZE) {
      writes.push(prompt.slice(i, i + PASTE_CHUNK_SIZE));
    }
  }
  if (submit) writes.push("\r");
  return writes;
}

function isPastedAgentTerminalPrompt(prompt: string): boolean {
  return prompt.length > BRACKETED_PASTE_MIN_LENGTH || /[\r\n]/.test(prompt);
}

async function waitForPromptInputRendered(
  prompt: string,
  transcript: () => string,
  lastOutputAt: () => number,
  signal?: AbortSignal
): Promise<void> {
  if (!isPastedAgentTerminalPrompt(prompt)) return;
  const startedAt = Date.now();
  const baselineOutputAt = lastOutputAt();
  await new Promise<void>((resolve) => {
    let timer: NodeJS.Timeout | null = null;
    const cleanup = () => {
      if (timer) clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = () => {
      cleanup();
      resolve();
    };
    const onAbort = () => finish();
    const check = () => {
      if (signal?.aborted) return finish();
      const now = Date.now();
      const outputAt = lastOutputAt();
      if (isPastedPromptVisible(transcript())) return finish();
      if (outputAt > baselineOutputAt && now - outputAt >= PROMPT_INPUT_RENDER_QUIET_MS) {
        return finish();
      }
      if (outputAt <= baselineOutputAt && now - startedAt >= PROMPT_INPUT_RENDER_NO_ECHO_MS) {
        return finish();
      }
      if (now - startedAt >= PROMPT_INPUT_RENDER_TIMEOUT_MS) return finish();
      timer = setTimeout(check, 80);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    check();
  });
}

function isPastedPromptVisible(rawTranscript: string): boolean {
  const rendered = renderTerminalScreen(rawTranscript);
  const plain = normalizeTerminalPlainText(rendered || rawTranscript);
  return /\[Pasted Content\s+\d+\s+chars\]/i.test(plain);
}

export function shouldFollowUpPastedPromptSubmit(input: {
  prompt: string;
  rawTranscript: string;
  state: AgentTerminalContentState;
  now: number;
  promptSubmittedAt: number;
  lastEnterAt?: number;
  enterCount: number;
}): boolean {
  if (!isPastedAgentTerminalPrompt(input.prompt)) return false;
  if (input.state !== "empty") return false;
  if (input.enterCount >= PASTED_PROMPT_FOLLOW_UP_ENTER_MAX) return false;
  const lastEnterAt = input.lastEnterAt ?? input.promptSubmittedAt;
  if (input.now - lastEnterAt < PASTED_PROMPT_FOLLOW_UP_ENTER_DELAY_MS) {
    return false;
  }
  if (!isPastedPromptVisible(input.rawTranscript)) return false;
  if (isAgentTerminalRunning(input.rawTranscript)) return false;
  return true;
}

function isAgentTerminalRunning(rawTranscript: string): boolean {
  const rendered = renderTerminalScreen(rawTranscript);
  const plain = normalizeTerminalPlainText(rendered || rawTranscript);
  return /\b(?:Working|Thinking|Esc to interrupt|Interrupting|tokens used|Running)\b/i.test(
    plain
  );
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

function extractTerminalContent(
  transcript: string,
  prompt = "",
  kind?: CliProviderKind
): string {
  if (kind === "codex-cli") {
    const rendered = renderTerminalScreen(transcript);
    const plain = normalizeTerminalPlainText(rendered || transcript);
    const codexAnswer = stripAgentTerminalChrome(extractCodexFinalAnswer(plain));
    if (isPromptEchoOnly(codexAnswer, prompt)) return "";
    if (codexAnswer) return codexAnswer;
  }
  const clean = stripAgentTerminalChrome(cleanTerminalTranscript(transcript, prompt));
  const output = clean
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      if (!trimmed) return false;
      return true;
    })
    .join("\n")
    .trim();
  return isPromptEchoOnly(output, prompt) ? "" : output;
}

export function extractAgentTerminalContentForTest(
  transcript: string,
  prompt = "",
  kind?: CliProviderKind
): string {
  return extractTerminalContent(transcript, prompt, kind);
}

function stripAgentTerminalChrome(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return !!trimmed && !isAgentTerminalChromeLine(trimmed) && !isAgentTerminalPromptLine(trimmed);
    })
    .join("\n")
    .trim();
}

function isPromptEchoOnly(content: string, prompt: string): boolean {
  const compactContent = compactPromptEchoText(content);
  if (!compactContent) return true;
  const compactPrompt = compactPromptEchoText(prompt);
  if (compactPrompt.length < 120 || compactContent.length < 40) return false;
  return compactPrompt.includes(compactContent);
}

function compactPromptEchoText(text: string): string {
  return normalizeTerminalPlainText(text).replace(/\s+/g, "");
}

function extractCodexFinalAnswer(clean: string): string {
  const lines = clean.split("\n").map((line) => line.trimEnd());
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]!.trim();
    if (!isCodexAssistantLine(trimmed)) continue;
    const out = [trimmed.replace(/^[•●]\s*/, "")];
    for (let j = i + 1; j < lines.length; j += 1) {
      const next = lines[j]!;
      const nextTrimmed = next.trim();
      if (!nextTrimmed) continue;
      if (isTerminalPromptLine(nextTrimmed) || isTerminalChromeLine(nextTrimmed)) break;
      if (isCodexAssistantLine(nextTrimmed)) break;
      out.push(next.replace(/^\s{2,}/, ""));
    }
    return out.join("\n").trim();
  }

  const lastPrompt = findLastIndex(lines, (line) => isTerminalPromptLine(line.trim()));
  if (lastPrompt >= 0) {
    return lines
      .slice(lastPrompt + 1)
      .map((line) => line.trimEnd())
      .filter((line) => {
        const trimmed = line.trim();
        return !!trimmed && !isTerminalChromeLine(trimmed);
      })
      .join("\n")
      .trim();
  }
  return "";
}

function findLastIndex<T>(items: T[], predicate: (item: T) => boolean): number {
  for (let i = items.length - 1; i >= 0; i -= 1) {
    if (predicate(items[i]!)) return i;
  }
  return -1;
}

function isCodexAssistantLine(trimmed: string): boolean {
  return /^[•●]\s+\S/.test(trimmed);
}

function isTerminalChromeOnly(text: string): boolean {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  return (
    lines.length > 0 &&
    lines.every((line) => isAgentTerminalChromeLine(line) || isAgentTerminalPromptLine(line))
  );
}

function isAgentTerminalPromptLine(trimmed: string): boolean {
  return /^[\u276f\u203a]\s*(?:\S.*)?$/.test(trimmed);
}

function isAgentTerminalChromeLine(trimmed: string): boolean {
  if (isTerminalChromeLine(trimmed)) return true;
  if (/\(shift\+tab to cycle\)/i.test(trimmed)) return true;
  return false;
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
  if (isTerminalPromptLine(trimmed)) return false;
  if (isTerminalChromeLine(trimmed)) return false;
  if (/^(?:PS [^>]+>|[$>])\s*/.test(trimmed)) return false;
  if (/^(?:codex|claude)(?:\.exe)?(?:\s|$)/i.test(trimmed)) return false;
  if (/^(?:OpenAI Codex|Claude Code)\b/i.test(trimmed)) return false;
  if (/^(?:cwd|directory|model)\s*:/i.test(trimmed)) return false;
  if (/^(?:press|try)\s+/i.test(trimmed)) return false;
  if (/^(?:working|thinking|interrupting|esc to interrupt)\b/i.test(trimmed)) return false;
  if (/^[\u2500-\u257f\s]+$/.test(trimmed)) return false;
  return true;
}

function isTerminalPromptLine(trimmed: string): boolean {
  return /^[›>]\s+\S/.test(trimmed);
}

function isTerminalChromeLine(trimmed: string): boolean {
  if (/^Tip:\s+/i.test(trimmed)) return true;
  if (/^\/(?:model|init|help)\b/i.test(trimmed)) return true;
  if (/^(?:gpt|codex|claude)[\w.-]*\s+(?:minimal|low|medium|high|xhigh|max|ultracode)\s+·\s+/i.test(trimmed)) {
    return true;
  }
  return false;
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
  rawTranscript: () => string,
  content: () => string,
  onStatus: (status: AgentTerminalStatus) => void,
  signal?: AbortSignal
): Promise<"exited" | "idle" | "timeout" | "aborted" | "manual-success"> {
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
      if (control.manualSuccessRequested) {
        clearInterval(timer);
        resolve("manual-success");
        return;
      }
      const now = Date.now();
      const sinceSubmit = now - control.promptSubmittedAt;
      const state = classifyAgentTerminalContent(content());
      if (
        shouldFollowUpPastedPromptSubmit({
          prompt: control.prompt,
          rawTranscript: rawTranscript(),
          state,
          now,
          promptSubmittedAt: control.promptSubmittedAt,
          lastEnterAt: control.lastPastedPromptFollowUpEnterAt,
          enterCount: control.pastedPromptFollowUpEnterCount ?? 0,
        })
      ) {
        try {
          writeRawInput(getSession(sessionId), "\r");
          control.pastedPromptFollowUpEnterCount =
            (control.pastedPromptFollowUpEnterCount ?? 0) + 1;
          control.lastPastedPromptFollowUpEnterAt = now;
          onStatus("prompt-sent");
        } catch {
          /* session may have exited between classification and input */
        }
        return;
      }
      if (state === "waiting-for-choice") {
        if (
          shouldAutoEnterChoice({
            alwaysEnter: control.alwaysEnter,
            state,
            now,
            lastEnterAt: control.lastAlwaysEnterAt,
          })
        ) {
          try {
            writeRawInput(getSession(sessionId), "\r");
            control.lastAlwaysEnterAt = now;
            control.lastCompletionState = "empty";
            onStatus("prompt-sent");
          } catch {
            /* session may have exited between classification and input */
          }
          return;
        }
        if (state !== control.lastCompletionState) {
          control.lastCompletionState = state;
          onStatus("waiting-for-choice");
        }
        return;
      }
      if (control.lastCompletionState === "waiting-for-choice") {
        control.lastCompletionState = "empty";
        onStatus("prompt-sent");
      } else if (state !== control.lastCompletionState && state !== "ready-for-success") {
        control.lastCompletionState = state;
      }
      if (sinceSubmit >= RESPONSE_MAX_MS && control.autoSuccess) {
        clearInterval(timer);
        resolve("timeout");
        return;
      }
      if (
        sinceSubmit >= RESPONSE_MIN_MS &&
        now - lastOutputAt() >= RESPONSE_IDLE_MS &&
        state === "ready-for-success"
      ) {
        if (control.lastCompletionState !== "ready-for-success") {
          control.lastCompletionState = "ready-for-success";
          onStatus("ready-for-success");
        }
        if (control.autoSuccess) {
          clearInterval(timer);
          resolve("idle");
        } else {
          onStatus("ready-for-success");
        }
      }
    }, 500);
  });
}

export function classifyAgentTerminalContent(content: string): AgentTerminalContentState {
  const text = normalizeTerminalPlainText(content);
  const compact = text.replace(/\s+/g, " ").trim();
  if (!compact) return "empty";
  if (isTerminalChromeOnly(text)) return "empty";
  if (isTerminalChoicePrompt(text)) return "waiting-for-choice";
  return "ready-for-success";
}

function isTerminalChoicePrompt(text: string): boolean {
  const promptAt = lastTerminalChoicePromptIndex(text);
  if (promptAt < 0) return false;
  if (hasLaterTerminalChoiceContent(text, promptAt)) return false;
  return promptAt > lastTerminalChoiceReleaseIndex(text);
}

function hasLaterTerminalChoiceContent(text: string, promptAt: number): boolean {
  return text
    .slice(promptAt)
    .split("\n")
    .slice(1)
    .some((line) => {
      const trimmed = line.trim();
      return (
        !!trimmed &&
        !isAgentTerminalChromeLine(trimmed) &&
        !isAgentTerminalPromptLine(trimmed)
      );
    });
}

function lastTerminalChoicePromptIndex(text: string): number {
  let index = maxLastRegexIndex(text, [
    /\bEnter to select\b/i,
    /\bTab\/Arrow keys to navigate\b/i,
    /\bEsc to cancel\b/i,
    /\bReady to code\?/i,
    /\bapprove with this feedback\b/i,
    /\bYes,\s*(?:and bypass permissions|manually approve edits)\b/i,
  ]);
  const arrowIndex = Math.max(text.lastIndexOf("\u276f"), text.lastIndexOf("\u203a"));
  if (
    arrowIndex >= 0 &&
    /\b(?:select|navigate|cancel|submit|approve|type something)\b/i.test(
      text.slice(arrowIndex, arrowIndex + 800)
    )
  ) {
    index = Math.max(index, arrowIndex);
  }
  return index;
}

function lastTerminalChoiceReleaseIndex(text: string): number {
  return maxLastRegexIndex(text, [
    /\bDone\b/i,
    /\bcompleted\b/i,
    /\bsuccessfully\b/i,
    /\bauto-finished\b/i,
    /\bmanual-success\b/i,
    /\bSaut(?:e|é)ed for\b/i,
    /(?:已完成|完成|整理完成|执行完成|通过)/,
  ]);
}

function maxLastRegexIndex(text: string, patterns: RegExp[]): number {
  let max = -1;
  for (const pattern of patterns) {
    max = Math.max(max, lastRegexIndex(text, pattern));
  }
  return max;
}

function lastRegexIndex(text: string, pattern: RegExp): number {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const re = new RegExp(pattern.source, flags);
  let last = -1;
  let match: RegExpExecArray | null;
  while ((match = re.exec(text)) !== null) {
    last = match.index;
    if (!match[0]) re.lastIndex += 1;
  }
  return last;
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
