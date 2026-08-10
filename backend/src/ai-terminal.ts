import {
  type AgentSessionApp,
  type AgentSessionSummary,
  isAgentSessionInProject,
  listAgentSessions,
} from "./agent-sessions.js";
import type { CliProviderKind } from "./ai-cli.js";
import { config, platform } from "./config.js";
import {
  addTap,
  createSession,
  getSession,
  killSession,
  type TerminalSession,
  writeRawInput,
} from "./pty.js";
import {
  AgentTerminalConversationCollector,
  cleanAgentTerminalConversation,
  extractAgentRunMetadata,
  extractLastClaudeAnswer,
  extractLastStructuredClaudeAnswer,
  readClaudeSessionConversation,
  readCodexSessionFinalAnswer,
} from "./terminal-conversation.js";
import type { WorkspaceInfo } from "./workspace.js";
import {
  captureWorkspaceChanges,
  changedWorkspaceFiles,
  type WorkspaceChangeBaseline,
} from "./workspace-change-tracker.js";

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
export type AgentTerminalContentState = "empty" | "waiting-for-choice" | "ready-for-success";
export type AgentTerminalStatus =
  | "starting"
  | "waiting-for-input"
  | "ready"
  | "prompt-injected"
  | "prompt-sent"
  | "prompt-timeout"
  | "waiting-for-choice"
  | "ready-for-success"
  | "auto-error"
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
  /** Keep the raw terminal stream for workflow-level failure classification. */
  retainRawTranscript?: boolean;
  alwaysEnter?: boolean;
  conversationSessionId?: string;
  resumeConversation?: boolean;
  signal?: AbortSignal;
  onFrame?: (frame: AgentTerminalFrame) => void;
}

export type AgentTerminalFrame =
  | { type: "session"; sessionId: string }
  | { type: "conversation"; sessionId: string }
  | { type: "output"; data: string }
  | {
      type: "status";
      status: AgentTerminalStatus;
    }
  | { type: "exit"; code: number | null; signal: number | string | null };

export interface AgentTerminalResult {
  sessionId: string;
  conversationSessionId?: string;
  content: string;
  transcript: string;
  /** Raw terminal output retained for workflow failure classification. */
  rawTranscript?: string;
  changedFiles: string[];
  verification: string[];
  exitCode: number | null;
  signal: number | string | null;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const READY_TIMEOUT_MS = 8_000;
const QUIET_READY_MS = 700;
const RESPONSE_MIN_MS = 2_400;
const RESPONSE_IDLE_MS = 6_000;
const MAX_AGENT_TRANSCRIPT_CHARS = 512 * 1024;
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

export async function runAgentTerminal(opts: AgentTerminalOptions): Promise<AgentTerminalResult> {
  const conversationBaseline = await captureConversationSessionBaseline(opts);
  const workspaceBaseline = await captureWorkspaceChanges(opts.workspace.path).catch(
    () => null as WorkspaceChangeBaseline | null,
  );
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
  const conversation = new AgentTerminalConversationCollector(opts.prompt, opts.kind);
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
      transcript = appendBoundedTail(transcript, frame.data, MAX_AGENT_TRANSCRIPT_CHARS);
      conversation.push(frame.data);
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
    transcript = appendBoundedTail(transcript, replayed, MAX_AGENT_TRANSCRIPT_CHARS);
    conversation.push(replayed);
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
      `${
        buildAgentTerminalCommand(opts.kind, opts.model, {
          claudePermissionMode: opts.claudePermissionMode,
          mode: opts.mode,
          codexApproval: opts.codexApproval,
          codexSandbox: opts.codexSandbox,
          effort: opts.effort,
          conversationSessionId: opts.conversationSessionId,
          resumeConversation: opts.resumeConversation,
        }).command
      }\r`,
    );
    opts.onFrame?.({ type: "status", status: "waiting-for-input" });
    const ready = await waitForInputReady(
      opts.kind,
      () => transcript,
      () => lastOutputAt,
      (wake) => {
        wakeOutput = wake;
      },
      opts.signal,
    );
    if (!opts.signal?.aborted) {
      opts.onFrame?.({ type: "status", status: ready ? "ready" : "prompt-timeout" });
      await injectAgentTerminalPrompt(session.id, { submit: false });
      opts.onFrame?.({ type: "status", status: "prompt-injected" });
      await waitForPromptInputRendered(
        opts.prompt,
        () => transcript,
        () => lastOutputAt,
        opts.signal,
      );
      await submitAgentTerminalPrompt(session.id);
      opts.onFrame?.({ type: "status", status: "prompt-sent" });
    }
    const completion = await waitForAgentCompletion(
      session.id,
      opts.kind,
      () => exited,
      () => transcript,
      () => lastOutputAt,
      () => extractTerminalContent(transcript, opts.prompt, opts.kind),
      (status) => opts.onFrame?.({ type: "status", status }),
      opts.signal,
    );
    if (
      completion === "idle" ||
      completion === "stalled" ||
      completion === "manual-success" ||
      completion === "terminal-error"
    ) {
      const conversationSessionId = await resolveConversationSessionId(opts, conversationBaseline);
      const structuredConversation = await structuredAgentConversation(opts, conversationSessionId);
      const structuredAnswer = await structuredAgentFinalAnswer(
        opts,
        conversationSessionId,
        structuredConversation,
      );
      const content = selectAgentTerminalFinalContent(
        structuredAnswer,
        extractTerminalContent(transcript, opts.prompt, opts.kind),
      );
      const cleanTranscript =
        structuredConversation ||
        conversation.value() ||
        cleanTerminalTranscript(transcript, opts.prompt);
      const metadata = await agentRunMetadata(cleanTranscript, opts, workspaceBaseline);
      opts.onFrame?.({
        type: "status",
        status:
          completion === "manual-success"
            ? "manual-success"
            : completion === "terminal-error" || completion === "stalled"
              ? "auto-error"
              : "auto-finished",
      });
      try {
        session.pty.kill();
      } catch {
        /* already closed */
      }
      if (conversationSessionId) {
        opts.onFrame?.({ type: "conversation", sessionId: conversationSessionId });
      }
      opts.onFrame?.({ type: "status", status: "exited" });
      return {
        sessionId: session.id,
        conversationSessionId,
        content,
        transcript: cleanTranscript,
        rawTranscript: opts.retainRawTranscript ? transcript : undefined,
        changedFiles: metadata.changedFiles,
        verification: metadata.verification,
        exitCode: 0,
        signal:
          completion === "stalled"
            ? "agent-stalled"
            : completion === "manual-success"
              ? "manual-success"
              : completion === "terminal-error"
                ? "terminal-error"
                : "auto-finished",
      };
    }
    opts.onFrame?.({ type: "status", status: "exited" });
    const conversationSessionId = await resolveConversationSessionId(opts, conversationBaseline);
    const structuredConversation = await structuredAgentConversation(opts, conversationSessionId);
    const structuredAnswer = await structuredAgentFinalAnswer(
      opts,
      conversationSessionId,
      structuredConversation,
    );
    const cleanTranscript =
      structuredConversation ||
      conversation.value() ||
      cleanTerminalTranscript(transcript, opts.prompt);
    const metadata = await agentRunMetadata(cleanTranscript, opts, workspaceBaseline);
    if (conversationSessionId) {
      opts.onFrame?.({ type: "conversation", sessionId: conversationSessionId });
    }
    return {
      sessionId: session.id,
      conversationSessionId,
      content: selectAgentTerminalFinalContent(
        structuredAnswer,
        extractTerminalContent(transcript, opts.prompt, opts.kind),
      ),
      transcript: cleanTranscript,
      rawTranscript: opts.retainRawTranscript ? transcript : undefined,
      changedFiles: metadata.changedFiles,
      verification: metadata.verification,
      exitCode,
      signal: exitSignal,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    controls.delete(session.id);
    detach();
  }
}

interface ConversationSessionBaseline {
  app: AgentSessionApp;
  startedAt: number;
  ids: Set<string>;
}

async function captureConversationSessionBaseline(
  opts: AgentTerminalOptions,
): Promise<ConversationSessionBaseline> {
  const app = opts.kind === "claude-cli" ? "claude" : "codex";
  const sessions = await listAgentSessions(app).catch(() => []);
  return {
    app,
    startedAt: Date.now(),
    ids: new Set(
      sessions
        .filter((session) => isAgentSessionInProject(session, opts.workspace.path))
        .map((session) => session.id),
    ),
  };
}

async function resolveConversationSessionId(
  opts: AgentTerminalOptions,
  baseline: ConversationSessionBaseline,
): Promise<string | undefined> {
  const expectedId = opts.conversationSessionId?.trim() || "";
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const sessions = await listAgentSessions(baseline.app).catch(() => []);
    const selected = selectConversationSessionId(
      sessions,
      opts.workspace.path,
      baseline.ids,
      baseline.startedAt,
      expectedId,
    );
    if (selected) return selected;
    if (attempt < 5) {
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
    }
  }
  return undefined;
}

function selectConversationSessionId(
  sessions: AgentSessionSummary[],
  projectPath: string,
  existingIds: Set<string>,
  startedAt: number,
  expectedId = "",
): string | undefined {
  const projectSessions = sessions.filter((session) =>
    isAgentSessionInProject(session, projectPath),
  );
  if (expectedId && projectSessions.some((session) => session.id === expectedId)) {
    return expectedId;
  }
  return projectSessions
    .filter((session) => !existingIds.has(session.id) && session.updatedAt >= startedAt - 2_000)
    .sort((a, b) => b.updatedAt - a.updatedAt)[0]?.id;
}

export function selectConversationSessionIdForTest(
  sessions: AgentSessionSummary[],
  projectPath: string,
  existingIds: string[],
  startedAt: number,
  expectedId = "",
): string | undefined {
  return selectConversationSessionId(
    sessions,
    projectPath,
    new Set(existingIds),
    startedAt,
    expectedId,
  );
}

async function agentRunMetadata(
  conversation: string,
  opts: AgentTerminalOptions,
  baseline: WorkspaceChangeBaseline | null,
): Promise<{ changedFiles: string[]; verification: string[] }> {
  const extracted = extractAgentRunMetadata(conversation, opts.workspace.path);
  const observed = baseline
    ? await changedWorkspaceFiles(opts.workspace.path, baseline).catch(() => [])
    : [];
  return {
    changedFiles: [...new Set([...observed, ...extracted.changedFiles])],
    verification: extracted.verification,
  };
}

async function structuredAgentConversation(
  opts: AgentTerminalOptions,
  conversationSessionId?: string,
): Promise<string> {
  if (opts.kind !== "claude-cli" || !conversationSessionId) return "";
  let latest = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const conversation = await readClaudeSessionConversation(conversationSessionId);
    if (conversation && conversation === latest) return conversation;
    if (conversation) latest = conversation;
    if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, 75));
  }
  return latest;
}

async function structuredAgentFinalAnswer(
  opts: AgentTerminalOptions,
  conversationSessionId: string | undefined,
  structuredConversation: string,
): Promise<string> {
  if (opts.kind === "claude-cli") {
    return extractLastStructuredClaudeAnswer(structuredConversation);
  }
  if (!conversationSessionId) return "";
  let latest = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const answer = await readCodexSessionFinalAnswer(conversationSessionId);
    if (answer && answer === latest) return answer;
    if (answer) latest = answer;
    if (attempt < 3) await new Promise<void>((resolve) => setTimeout(resolve, 75));
  }
  return latest;
}

function selectAgentTerminalFinalContent(structuredAnswer: string, terminalFallback: string): string {
  return structuredAnswer.trim() || terminalFallback;
}

export function selectAgentTerminalFinalContentForTest(
  structuredAnswer: string,
  terminalFallback: string,
): string {
  return selectAgentTerminalFinalContent(structuredAnswer, terminalFallback);
}

export function setAgentTerminalAutoContinue(
  sessionId: string,
  enabled: boolean,
): { autoContinue: boolean } {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  control.autoSuccess = enabled;
  return { autoContinue: control.autoSuccess };
}

export function setAgentTerminalAutoSuccess(
  sessionId: string,
  enabled: boolean,
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
  patch: Partial<AgentTerminalControl> = {},
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
  options: { submit?: boolean } = {},
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
    conversationSessionId?: string;
    resumeConversation?: boolean;
  } = {},
): { command: string } {
  const base = kind === "codex-cli" ? "codex" : "claude";
  const args: string[] = [];
  if (kind === "claude-cli") {
    if (options.resumeConversation && options.conversationSessionId) {
      args.push("--resume", quoteShell(options.conversationSessionId));
    } else {
      args.push(
        "--permission-mode",
        options.mode === "plan" ? "plan" : (options.claudePermissionMode ?? "acceptEdits"),
      );
      if (options.conversationSessionId) {
        args.push("--session-id", quoteShell(options.conversationSessionId));
      }
    }
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
  sandbox: CodexSandbox | undefined,
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
  effort: AgentEffort | undefined,
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
    effort === "xhigh" ||
    effort === "max"
  ) {
    return effort;
  }
  return null;
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
    (input.lastEnterAt === undefined || input.now - input.lastEnterAt >= ALWAYS_ENTER_COOLDOWN_MS)
  );
}

export function shouldExposeWaitingForChoice(
  alwaysEnter: boolean,
  state: AgentTerminalContentState,
): boolean {
  return !alwaysEnter && state === "waiting-for-choice";
}

export function shouldClearWaitingForChoice(
  previousState: AgentTerminalContentState | undefined,
  state: AgentTerminalContentState,
  busy: boolean,
): boolean {
  return previousState === "waiting-for-choice" && (busy || state !== "waiting-for-choice");
}

type AgentTerminalPollPriority = "waiting-for-choice" | "busy" | "continue";

function agentTerminalPollPriority(
  state: AgentTerminalContentState,
  busy: boolean,
): AgentTerminalPollPriority {
  if (state === "waiting-for-choice") return "waiting-for-choice";
  return busy ? "busy" : "continue";
}

export function agentTerminalPollPriorityForTest(
  state: AgentTerminalContentState,
  busy: boolean,
): AgentTerminalPollPriority {
  return agentTerminalPollPriority(state, busy);
}

async function writePrompt(
  session: TerminalSession,
  prompt: string,
  submit: boolean,
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

async function submitPromptInput(session: TerminalSession, prompt: string): Promise<void> {
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
      Math.ceil(prompt.length / PASTED_PROMPT_CHARS_PER_DELAY_MS),
  );
}

export function buildAgentTerminalPromptWrites(prompt: string, submit: boolean): string[] {
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
  signal?: AbortSignal,
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
  return /\b(?:Working|Thinking|Esc to interrupt|Interrupting|tokens used|Running)\b/i.test(plain);
}

function parsePtyFrame(
  raw: string,
):
  | { type: "output"; data: string }
  | { type: "exit"; code: number | null; signal: number | string | null }
  | null {
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

function extractTerminalContent(transcript: string, prompt = "", kind?: CliProviderKind): string {
  if (kind === "codex-cli") {
    const rendered = renderTerminalScreen(transcript);
    const plain = normalizeTerminalPlainText(rendered || transcript);
    const codexAnswer = stripAgentTerminalChrome(extractCodexFinalAnswer(plain));
    if (isPromptEchoOnly(codexAnswer, prompt)) return "";
    if (codexAnswer) return codexAnswer;
  }
  if (kind === "claude-cli") {
    const conversation = cleanAgentTerminalConversation(transcript, prompt);
    const finalAnswer = extractLastClaudeAnswer(conversation);
    if (isPromptEchoOnly(finalAnswer, prompt)) return "";
    if (finalAnswer) return finalAnswer;
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
  kind?: CliProviderKind,
): string {
  return extractTerminalContent(transcript, prompt, kind);
}

export function extractAgentTerminalContent(
  transcript: string,
  prompt = "",
  kind?: CliProviderKind,
): string {
  return extractTerminalContent(transcript, prompt, kind);
}

function stripAgentTerminalChrome(text: string): string {
  return text
    .split("\n")
    .map((line) => line.trimEnd())
    .filter((line) => {
      const trimmed = line.trim();
      return (
        !!trimmed && !isAgentTerminalChromeLine(trimmed) && !isAgentTerminalPromptLine(trimmed)
      );
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
  const footer = findLastIndex(lines, (line) => isCodexCompletionFooterLine(line.trim()));
  const end = footer >= 0 ? footer : lines.length;
  for (let i = end - 1; i >= 0; i -= 1) {
    const trimmed = lines[i]!.trim();
    if (isCodexToolActivityLine(trimmed)) return "";
    if (!isCodexAssistantLine(trimmed)) continue;
    const out = [trimmed.replace(/^[•●]\s*/, "")];
    for (let j = i + 1; j < end; j += 1) {
      const next = lines[j]!;
      const nextTrimmed = next.trim();
      if (!nextTrimmed) continue;
      if (isTerminalPromptLine(nextTrimmed) || isTerminalChromeLine(nextTrimmed)) break;
      if (
        isCodexAssistantLine(nextTrimmed) ||
        isCodexToolActivityLine(nextTrimmed) ||
        isCodexCollapsedOutputLine(nextTrimmed)
      ) {
        break;
      }
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
  return /^[•●]\s+\S/.test(trimmed) && !isCodexToolActivityLine(trimmed);
}

function isCodexToolActivityLine(trimmed: string): boolean {
  const content = trimmed.replace(/^[•●]\s*/, "").trim();
  return /^(?:Ran|Running|Explored|Searched|Read|Edited|Updated|Wrote|Deleted|Moved|Copied|Listed|Opened|Called|Checked|Viewed|Inspected)\b/i.test(
    content,
  );
}

function isCodexCompletionFooterLine(trimmed: string): boolean {
  return /^[─━═_\-\s]*Worked for\s+\d/i.test(trimmed);
}

function isCodexCollapsedOutputLine(trimmed: string): boolean {
  return /^(?:[│┃]\s*)?…\s*\+\d+\s+lines\b/i.test(trimmed);
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
  if (isCodexCompletionFooterLine(trimmed)) return true;
  if (isCodexCollapsedOutputLine(trimmed)) return true;
  if (/\(shift\+tab to cycle\)/i.test(trimmed)) return true;
  if (/^[\u2500-\u257f\s]+$/.test(trimmed)) return true;
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
      .filter(Boolean),
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
  if (
    /^(?:gpt|codex|claude)[\w.-]*\s+(?:minimal|low|medium|high|xhigh|max|ultracode)\s+·\s+/i.test(
      trimmed,
    )
  ) {
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

function renderTerminalScreen(raw: string, maxRows?: number): string {
  const rows: string[] = [""];
  let row = 0;
  let col = 0;

  const ensureRow = () => {
    while (rows.length <= row) rows.push("");
    if (maxRows && rows.length > maxRows) rows.splice(0, rows.length - maxRows);
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
    row = Math.max(0, maxRows ? Math.min(maxRows - 1, nextRow) : nextRow);
    col = Math.max(0, nextCol);
    ensureRow();
  };

  for (let i = 0; i < raw.length; i += 1) {
    const ch = raw[i]!;
    if (ch === "\x1b") {
      const consumed = consumeEscape(
        raw,
        i,
        rows,
        () => row,
        () => col,
        move,
        setLine,
      );
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
      if (maxRows && row >= maxRows - 1) {
        rows.shift();
        rows.push("");
        row = maxRows - 1;
      } else {
        row += 1;
      }
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
  setLine: (value: string) => void,
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
  signal?: AbortSignal,
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
  kind: CliProviderKind,
  done: () => boolean,
  rawTranscript: () => string,
  lastOutputAt: () => number,
  content: () => string,
  onStatus: (status: AgentTerminalStatus) => void,
  signal?: AbortSignal,
): Promise<"exited" | "idle" | "stalled" | "aborted" | "manual-success" | "terminal-error"> {
  if (done()) return Promise.resolve("exited");
  if (signal?.aborted) return Promise.resolve("aborted");
  return new Promise((resolve) => {
    let screenSignature = agentTerminalScreenSignature(rawTranscript());
    let screenChangedAt = Date.now();
    let completionMarkerArmed = !isAgentTerminalCompletionMarkerVisible(kind, rawTranscript());
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
      if (!control?.promptSubmittedAt) return;
      const now = Date.now();
      const sinceSubmit = now - control.promptSubmittedAt;
      const transcript = rawTranscript();
      const completionMarkerVisible = isAgentTerminalCompletionMarkerVisible(kind, transcript);
      if (!completionMarkerVisible) completionMarkerArmed = true;
      const hasFreshCompletionMarker = completionMarkerArmed && completionMarkerVisible;
      const nextScreenSignature = agentTerminalScreenSignature(transcript);
      if (nextScreenSignature !== screenSignature) {
        screenSignature = nextScreenSignature;
        screenChangedAt = now;
      }
      if (control.autoFinishPaused) return;
      if (control.manualSuccessRequested) {
        clearInterval(timer);
        resolve("manual-success");
        return;
      }
      const state = resolveAgentTerminalContentState(kind, transcript, content());
      if (
        shouldFollowUpPastedPromptSubmit({
          prompt: control.prompt,
          rawTranscript: transcript,
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
      const pollPriority = agentTerminalPollPriority(state, isAgentTerminalBusy(transcript));
      if (pollPriority === "waiting-for-choice") {
        if (control.alwaysEnter) {
          if (
            shouldAutoEnterChoice({
              alwaysEnter: true,
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
          }
          return;
        }
        if (
          shouldExposeWaitingForChoice(control.alwaysEnter, state) &&
          state !== control.lastCompletionState
        ) {
          control.lastCompletionState = state;
          onStatus("waiting-for-choice");
        }
        return;
      }
      // A visible approval menu is actionable even when the preceding shell
      // command remains in the current viewport. Once the menu is gone,
      // generation activity takes priority over success and error detection.
      if (pollPriority === "busy") {
        if (shouldClearWaitingForChoice(control.lastCompletionState, state, true)) {
          control.lastCompletionState = "empty";
          onStatus("prompt-sent");
        }
        return;
      }
      if (shouldClearWaitingForChoice(control.lastCompletionState, state, false)) {
        control.lastCompletionState = "empty";
        onStatus("prompt-sent");
      } else if (state !== control.lastCompletionState && state !== "ready-for-success") {
        control.lastCompletionState = state;
      }
      if (shouldFinishAgentTerminalWithError(kind, transcript)) {
        clearInterval(timer);
        resolve("terminal-error");
        return;
      }
      // Total runtime is intentionally unbounded. Only a continuous period
      // without terminal output is treated as a stalled agent.
      if (
        hasAgentTerminalStalled(
          now,
          control.promptSubmittedAt,
          lastOutputAt(),
          config.agentStallTimeoutMs,
        )
      ) {
        clearInterval(timer);
        resolve("stalled");
        return;
      }
      if (
        sinceSubmit >= RESPONSE_MIN_MS &&
        (hasFreshCompletionMarker ||
          now - screenChangedAt >= RESPONSE_IDLE_MS ||
          isClaudeCompletionReady(kind, transcript)) &&
        isAgentTerminalReadyForAutoFinish(kind, transcript, state)
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

function hasAgentTerminalStalled(
  now: number,
  promptSubmittedAt: number,
  lastOutputAt: number,
  timeoutMs: number,
): boolean {
  if (timeoutMs <= 0) return false;
  return now - Math.max(promptSubmittedAt, lastOutputAt) >= timeoutMs;
}

export function agentTerminalStalledForTest(
  now: number,
  promptSubmittedAt: number,
  lastOutputAt: number,
  timeoutMs: number,
): boolean {
  return hasAgentTerminalStalled(now, promptSubmittedAt, lastOutputAt, timeoutMs);
}

export function hasAgentTerminalFailure(rawTranscript: string): boolean {
  const screen = agentTerminalScreenSignature(rawTranscript)
    .split("\n")
    .filter((line) => !isClaudeUpdateWarningLine(line.trim()))
    .join("\n");
  if (isAgentTerminalRetrying(screen)) return false;
  const patterns = [
    /^[ \t]*(?:[●•*✖✗×!]\s*)?(?:Please run\s+\/login\s*(?:[·•-]\s*)?)?API Error\s*:\s*\S[^\n]*/im,
    /^[ \t]*(?:[●•*✖✗×!]\s*)?Please run\s+\/login\b[^\n]*/im,
    /^[ \t]*(?:[●•*✖✗×!]\s*)?Image generation is not enabled for this (?:group|organization|account)\b[^\n]*/im,
    /^[ \t]*[●•✖✗×!]\s*(?:(?:fatal|authentication|authorization|request)\s+)?error\s*:\s*\S[^\n]*/im,
    /\bunexpected status\s+(?:4\d\d|5\d\d)\b[^\n]*/i,
    /^[ \t]*(?![\u203a\u276f])(?:[\u25a0\u25cf\u2022*\u2716\u2717\u00d7!]\s*[^\n]*(?:\b(?:errors?|failed|failure|fatal|exception|panic(?:ked)?)\b|\bunexpected status\s+\d{3}\b|\b(?:service|temporarily) unavailable\b|\b(?:permission|access|request) denied\b|\b(?:timed?|time)\s*out\b|\bconnection reset\b)|(?:(?:api\s+)?errors?|failed|failure|fatal|exception|panic(?:ked)?|traceback)\b[^\n]*|unexpected status\s+\d{3}\b[^\n]*|(?:service|temporarily) unavailable\b[^\n]*|(?:permission|access|request) denied\b[^\n]*|(?:timed?|time)\s*out\b[^\n]*|connection reset\b[^\n]*|npm\s+ERR![^\n]*)/im,
    /^[ \t]*(?![\u203a\u276f])(?:request|command|process|task|tool|operation|execution|connection|authentication|authorization|permission|network|server|provider|model)\s+(?:errors?|failed|failure|denied|unavailable|refused|aborted|(?:timed?|time)\s*out)\b[^\n]*/im,
    /^[ \t]*(?![\u203a\u276f])(?:no available channel\b|something went wrong\b|HTTP\s+[45]\d\d\b|E(?:CONNREFUSED|CONNRESET|TIMEDOUT)\b)[^\n]*/im,
  ];
  let lastErrorAt = -1;
  let lastErrorEnd = -1;
  for (const pattern of patterns) {
    const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
    for (const match of screen.matchAll(new RegExp(pattern.source, flags))) {
      if ((match.index ?? -1) >= lastErrorAt) {
        lastErrorAt = match.index ?? -1;
        lastErrorEnd = lastErrorAt + match[0].length;
      }
    }
  }
  if (lastErrorAt < 0) return false;
  const recovery = screen
    .slice(lastErrorEnd)
    .replace(/(?:^|\n)\s*(?:Reconnecting|Retrying)\b[^\n]*/gi, "\n");
  return !/(?:^|\n)\s*(?:[\p{S}\p{P}]\s*)?(?:Thought\s+for\s+\d|\p{L}[\p{L}'’-]*(?:…|\.\.\.)?\s*\(\s*\d+(?:\.\d+)?(?:ms|s|m|h)\b)/imu.test(
    recovery,
  );
}

export function hasAgentTerminalFailureForTest(rawTranscript: string): boolean {
  return hasAgentTerminalFailure(rawTranscript);
}

function shouldFinishAgentTerminalWithError(kind: CliProviderKind, rawTranscript: string): boolean {
  if (isAgentTerminalBusy(rawTranscript)) return false;
  if (!hasAgentTerminalFailure(rawTranscript)) return false;
  const screen = agentTerminalScreenSignature(rawTranscript);
  if (kind === "claude-cli") {
    return isClaudeIdlePromptVisible(screen) && !isClaudeChoicePromptVisible(screen);
  }
  return isCodexIdlePromptVisible(screen);
}

export function shouldFinishAgentTerminalWithErrorForTest(
  kind: CliProviderKind,
  rawTranscript: string,
): boolean {
  return shouldFinishAgentTerminalWithError(kind, rawTranscript);
}

function agentTerminalScreenSignature(rawTranscript: string): string {
  const rendered = renderTerminalScreen(rawTranscript, DEFAULT_ROWS);
  return normalizeTerminalPlainText(rendered || rawTranscript).trimEnd();
}

export function agentTerminalScreenSignatureForTest(rawTranscript: string): string {
  return agentTerminalScreenSignature(rawTranscript);
}

function isAgentTerminalBusy(rawTranscript: string): boolean {
  const screen = agentTerminalScreenSignature(rawTranscript);
  const activityAt = lastAgentActivityIndex(screen);
  if (activityAt < 0) return false;
  return activityAt > lastClaudeCompletionFooterIndex(screen);
}

function isAgentTerminalRetrying(screen: string): boolean {
  return /\b(?:Reconnecting|Retrying)(?:\.\.\.)?(?:\s+\d+\s*\/\s*\d+)?/i.test(screen);
}

function isClaudeUpdateWarningLine(trimmed: string): boolean {
  return /^(?:[✖✗×!]\s*)?Auto-update failed\b.*\bclaude doctor\b/i.test(trimmed);
}

function lastAgentActivityIndex(screen: string): number {
  return maxLastRegexIndex(screen, [
    /\bEsc to interrupt\b/i,
    /\b(?:Reconnecting|Retrying)(?:\.\.\.)?(?:\s+\d+\s*\/\s*\d+)?/i,
    /(?:^|\n)\s*Thought\s+for\s+\d+(?:\.\d+)?(?:ms|s|m|h)\b[^\n]*\bctrl\+o\s+to\s+expand\b/iu,
    /(?:^|\n)\s*(?:[\p{S}\p{P}]\s*)?\p{L}[\p{L}'’-]*(?:…|\.\.\.)?\s*\(\s*\d+(?:\.\d+)?(?:ms|s|m|h)\b[^\n)]*\)/iu,
  ]);
}

function lastClaudeCompletionFooterIndex(screen: string): number {
  let offset = 0;
  let last = -1;
  for (const line of screen.split("\n")) {
    if (isClaudeCompletionFooterLine(line.trim())) last = offset;
    offset += line.length + 1;
  }
  return last;
}

function isAgentTerminalReadyForAutoFinish(
  kind: CliProviderKind,
  rawTranscript: string,
  state: AgentTerminalContentState,
): boolean {
  if (isAgentTerminalBusy(rawTranscript)) return false;
  const screen = agentTerminalScreenSignature(rawTranscript);
  if (kind === "claude-cli") {
    const completionMarkerVisible = isClaudeCompletionFooterVisible(screen);
    if (state === "empty" && !completionMarkerVisible) return false;
    if (hasActiveClaudeBackgroundAgent(screen)) return false;
    if (isClaudeChoicePromptVisible(screen)) return false;
    return completionMarkerVisible || isClaudeIdlePromptVisible(screen);
  }
  if (!isCodexIdlePromptVisible(screen)) return false;
  return state === "ready-for-success" || isCodexCompletionFooterVisible(screen);
}

function isCodexCompletionFooterVisible(screen: string): boolean {
  return terminalTail(screen, 12)
    .split("\n")
    .some((line) => isCodexCompletionFooterLine(line.trim()));
}

function hasActiveClaudeBackgroundAgent(screen: string): boolean {
  if (
    /\bWaiting for\s+(?:\d+\s+)?(?:background\s+)?(?:agents?|teammates?)\s+to finish\b/i.test(
      screen,
    )
  ) {
    return true;
  }

  return screen.split("\n").some((line) => {
    const trimmed = line.trim();
    if (!/^[\u25cb\u25ef]\s+\S/.test(trimmed)) return false;
    if (/\b(?:idle|done|finished|completed|failed|stopped)\b/i.test(trimmed)) {
      return false;
    }
    return /\b\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s+\d+(?:\.\d+)?(?:ms|s|m|h))*\s*$/i.test(trimmed);
  });
}

export function agentTerminalReadyForAutoFinishForTest(
  kind: CliProviderKind,
  rawTranscript: string,
  state: AgentTerminalContentState,
): boolean {
  return isAgentTerminalReadyForAutoFinish(kind, rawTranscript, state);
}

export function agentTerminalReadyForManualSuccessForTest(
  kind: CliProviderKind,
  rawTranscript: string,
  state: AgentTerminalContentState,
): boolean {
  return isAgentTerminalReadyForAutoFinish(kind, rawTranscript, state);
}

function isClaudeIdlePromptVisible(screen: string): boolean {
  const tail = terminalTail(screen, 10);
  return tail.split("\n").some((line) => isClaudeIdleFooterLine(line.trim()));
}

function isAgentTerminalCompletionMarkerVisible(
  kind: CliProviderKind,
  rawTranscript: string,
): boolean {
  if (kind !== "claude-cli") return false;
  return isClaudeCompletionFooterVisible(agentTerminalScreenSignature(rawTranscript));
}

function isClaudeCompletionReady(kind: CliProviderKind, rawTranscript: string): boolean {
  if (kind !== "claude-cli") return false;
  const screen = agentTerminalScreenSignature(rawTranscript);
  return isClaudeCompletionFooterVisible(screen) && isClaudeIdlePromptVisible(screen);
}

function isClaudeIdleFooterLine(trimmed: string): boolean {
  return /\b(?:(?:auto|manual|plan)\s+mode|bypass permissions|accept edits)\s+on\b[^\n]*\bagents?\b/i.test(
    trimmed,
  );
}

function isClaudeCompletionFooterVisible(screen: string): boolean {
  return terminalTail(screen, 12)
    .split("\n")
    .some((line) => isClaudeCompletionFooterLine(line.trim()));
}

function isClaudeCompletionFooterLine(trimmed: string): boolean {
  return /^[^\p{L}\p{N}]*\p{L}[\p{L}'’-]*(?:\s+\p{L}[\p{L}'’-]*)*\s+for\s+\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s+\d+(?:\.\d+)?(?:ms|s|m|h))*\s*$/iu.test(
    trimmed,
  );
}

function isClaudeChoicePromptVisible(screen: string): boolean {
  const tail = terminalTail(screen, 18);
  return isTerminalChoicePrompt(tail);
}

function resolveAgentTerminalContentState(
  kind: CliProviderKind,
  rawTranscript: string,
  content: string,
): AgentTerminalContentState {
  const state = classifyAgentTerminalContent(content);
  if (kind !== "claude-cli") return state;

  const screen = agentTerminalScreenSignature(rawTranscript);
  if (isClaudeChoicePromptVisible(screen)) return "waiting-for-choice";
  if (state === "empty" && isClaudeCompletionFooterVisible(screen) && isClaudeIdlePromptVisible(screen)) {
    return "ready-for-success";
  }
  return state === "waiting-for-choice" ? "ready-for-success" : state;
}

export function resolveAgentTerminalContentStateForTest(
  kind: CliProviderKind,
  rawTranscript: string,
  content: string,
): AgentTerminalContentState {
  return resolveAgentTerminalContentState(kind, rawTranscript, content);
}

function isCodexIdlePromptVisible(screen: string): boolean {
  const tail = terminalTail(screen, 10);
  return /(?:^|\n)[\u203a\u276f]\s+\S/.test(tail);
}

function terminalTail(text: string, lineCount: number): string {
  return text.split("\n").slice(-lineCount).join("\n");
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
  const block = lastInteractiveChoiceBlock(text);
  if (!block) return false;
  if (hasLaterTerminalChoiceContent(text, block.endAt)) return false;
  return block.startAt > lastTerminalChoiceReleaseIndex(text);
}

function hasLaterTerminalChoiceContent(text: string, choiceEndAt: number): boolean {
  return text
    .slice(choiceEndAt)
    .split("\n")
    .some((line) => isTerminalChoiceReleaseLine(line.trim()));
}

function lastInteractiveChoiceBlock(text: string): { startAt: number; endAt: number } | null {
  const lines = text.split("\n");
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) {
    offsets.push(offset);
    offset += line.length + 1;
  }

  for (let cueLine = lines.length - 1; cueLine >= 0; cueLine -= 1) {
    if (!isTerminalChoiceInteractionCue(lines[cueLine]!.trim())) continue;
    const startLine = Math.max(0, cueLine - 12);
    const endLine = cueLine;
    const window = lines.slice(startLine, cueLine + 1).map((line) => line.trim());
    const selected = window.filter(isSelectedTerminalChoiceOption).length;
    const options = window.filter(isTerminalChoiceOption).length;
    if (selected < 1 || options < 2) continue;
    return {
      startAt: offsets[startLine] ?? 0,
      endAt: (offsets[endLine] ?? text.length) + (lines[endLine]?.length ?? 0),
    };
  }
  return null;
}

function isTerminalChoiceInteractionCue(trimmed: string): boolean {
  return /\b(?:Enter to select|Tab\/Arrow keys to navigate|Esc to cancel|approve with this feedback)\b/i.test(
    trimmed,
  );
}

function isSelectedTerminalChoiceOption(trimmed: string): boolean {
  return /^[\u276f\u203a>]\s*(?:\d+[.)]?\s*)?\S/.test(trimmed);
}

function isTerminalChoiceOption(trimmed: string): boolean {
  return isSelectedTerminalChoiceOption(trimmed) || /^\d+[.)]\s+\S/.test(trimmed);
}

function isTerminalChoiceChromeLine(trimmed: string): boolean {
  if (/^(?:[\u276f\u203a>]\s*)?\d+\.\s+(?:Yes,|Tell Claude\b)/i.test(trimmed)) {
    return true;
  }
  if (/\bshift\+tab to approve with this feedback\b/i.test(trimmed)) return true;
  if (/\bctrl\+g to edit\b/i.test(trimmed)) return true;
  if (/\.claude[\\/]+plans[\\/]+/i.test(trimmed)) return true;
  if (/^[\u25cb\u25ef]\s+\S+/.test(trimmed)) return true;
  return false;
}

function isTerminalChoiceReleaseLine(trimmed: string): boolean {
  if (!trimmed) return false;
  if (isAgentTerminalChromeLine(trimmed) || isAgentTerminalPromptLine(trimmed)) return false;
  if (isTerminalChoiceChromeLine(trimmed)) return false;
  if (/^[●•]\s+\S/.test(trimmed)) return true;
  if (/^(?:Thought|Thinking)\s+for\s+\d/i.test(trimmed)) return true;
  if (isClaudeCompletionFooterLine(trimmed) || isClaudeIdleFooterLine(trimmed)) return true;
  if (/\b(?:Done|completed|successfully|auto-finished|manual-success)\b/i.test(trimmed)) {
    return true;
  }
  return /(?:已完成|完成|整理完成|执行完成|通过|成功)/.test(trimmed);
}

function lastTerminalChoiceReleaseIndex(text: string): number {
  return maxLastRegexIndex(text, [
    /\bDone\b/i,
    /\bcompleted\b/i,
    /\bsuccessfully\b/i,
    /\bauto-finished\b/i,
    /\bmanual-success\b/i,
    /\b(?:auto mode|bypass permissions) on\s*\(shift\+tab to cycle\)/i,
    /\baccept edits on\s*\(shift\+tab to cycle\)/i,
    /(?:^|\n)[^\p{L}\p{N}\n]*\p{L}[\p{L}'’-]*(?:\s+\p{L}[\p{L}'’-]*)*\s+for\s+\d+(?:\.\d+)?(?:ms|s|m|h)(?:\s+\d+(?:\.\d+)?(?:ms|s|m|h))*\s*$/imu,
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

function appendBoundedTail(current: string, chunk: string, maxChars: number): string {
  if (!chunk) return current;
  if (maxChars <= 0) return "";
  if (chunk.length >= maxChars) return chunk.slice(-maxChars);
  const roomForCurrent = Math.max(0, maxChars - chunk.length);
  return (roomForCurrent > 0 ? current.slice(-roomForCurrent) : "") + chunk;
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
      { once: true },
    );
  });
}
