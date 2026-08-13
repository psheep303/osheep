import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type AgentSessionEvent, watchAgentSession } from "./agent-session-monitor.js";
import {
  type AgentSessionApp,
  type AgentSessionSummary,
  findAgentSessionFilePath,
  isAgentSessionInProject,
  listAgentSessions,
} from "./agent-sessions.js";
import type { CliProviderKind } from "./ai-cli.js";
import { platform } from "./config.js";
import {
  createSession,
  getSession,
  killSession,
  type TerminalSession,
  writeRawInput,
} from "./pty.js";
import {
  extractAgentRunMetadata,
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
  | "prompt-sent"
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
  alwaysEnter?: boolean;
  conversationSessionId?: string;
  resumeConversation?: boolean;
  signal?: AbortSignal;
  onFrame?: (frame: AgentTerminalFrame) => void;
}

export type AgentTerminalFrame =
  | { type: "session"; sessionId: string }
  | { type: "conversation"; sessionId: string }
  | { type: "status"; status: AgentTerminalStatus };

export interface AgentTerminalResult {
  sessionId: string;
  conversationSessionId?: string;
  content: string;
  transcript: string;
  changedFiles: string[];
  verification: string[];
  exitCode: number | null;
  signal: number | string | null;
  outcome?: "success" | "error" | "cancelled" | "user-rejected";
  errorMessage?: string;
}

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 34;
const SESSION_DISCOVERY_TIMEOUT_MS = 30_000;
const SESSION_DISCOVERY_POLL_MS = 120;

interface AgentTerminalControl {
  autoSuccess: boolean;
  alwaysEnter: boolean;
  autoFinishPaused: boolean;
  manualSuccessRequested: boolean;
  manualSuccessWaiters: Set<() => void>;
  lastCompletionState?: AgentTerminalContentState;
}

const controls = new Map<string, AgentTerminalControl>();

export async function runAgentTerminal(opts: AgentTerminalOptions): Promise<AgentTerminalResult> {
  const conversationBaseline = await captureConversationSessionBaseline(opts);
  const resumeOffset = await existingSessionSize(opts, conversationBaseline.app);
  const workspaceBaseline = await captureWorkspaceChanges(opts.workspace.path).catch(
    () => null as WorkspaceChangeBaseline | null,
  );
  const permissionHook =
    opts.kind === "claude-cli"
      ? await createClaudePermissionHookRuntime()
      : await createCodexPermissionHookRuntime();
  const command = buildAgentTerminalCommand(opts.kind, opts.model, {
    claudePermissionMode: opts.claudePermissionMode,
    mode: opts.mode,
    codexApproval: opts.codexApproval,
    codexSandbox: opts.codexSandbox,
    effort: opts.effort,
    conversationSessionId: opts.conversationSessionId,
    resumeConversation: opts.resumeConversation,
    prompt: opts.prompt,
    settingsPath: permissionHook?.settingsPath,
    codexPermissionHookConfig: permissionHook?.codexConfig,
  }).command;
  let session: TerminalSession;
  try {
    session = createSession({
      workspace: opts.workspace,
      shell: platform === "windows" ? "powershell" : "bash",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      killOnDetach: false,
      initialCommand: command,
    });
  } catch (error) {
    await fs.rm(permissionHook.directory, { recursive: true, force: true });
    throw error;
  }
  controls.set(session.id, {
    autoSuccess: opts.autoSuccess !== false,
    alwaysEnter: opts.alwaysEnter === true,
    autoFinishPaused: false,
    manualSuccessRequested: false,
    manualSuccessWaiters: new Set(),
  });
  opts.onFrame?.({ type: "session", sessionId: session.id });

  const onAbort = () => killSession(session.id, "agent-terminal-abort");
  opts.signal?.addEventListener("abort", onAbort, { once: true });

  try {
    opts.onFrame?.({ type: "status", status: "starting" });
    opts.onFrame?.({ type: "status", status: "prompt-sent" });

    const conversationSessionId = await resolveConversationSessionId(opts, conversationBaseline);
    if (!conversationSessionId) {
      throw new Error(`${providerLabel(opts.kind)} session JSONL was not created.`);
    }
    opts.onFrame?.({ type: "conversation", sessionId: conversationSessionId });

    const observedCompletion = await waitForAgentSessionCompletion(
      session,
      conversationBaseline.app,
      conversationSessionId,
      opts.resumeConversation ? resumeOffset : 0,
      opts.onFrame,
      opts.signal,
      permissionHook.eventsPath,
    );
    const completion = await waitForManualSuccessIfNeeded(
      session.id,
      observedCompletion.event,
      observedCompletion.manual,
      opts.onFrame,
      opts.signal,
    );

    const structuredConversation = await structuredAgentConversation(opts, conversationSessionId);
    const structuredAnswer = await structuredAgentFinalAnswer(
      opts,
      conversationSessionId,
      structuredConversation,
    );
    const transcript = structuredConversation || structuredAnswer;
    const metadata = await agentRunMetadata(transcript, opts, workspaceBaseline);
    opts.onFrame?.({
      type: "status",
      status:
        completion.event.outcome === "user-rejected"
          ? "auto-finished"
          : completion.manual && completion.event.outcome === "success"
            ? "manual-success"
            : completion.event.outcome === "success"
              ? "auto-finished"
              : "auto-error",
    });
    try {
      session.pty.kill();
    } catch {
      /* already closed */
    }
    opts.onFrame?.({ type: "status", status: "exited" });
    return {
      sessionId: session.id,
      conversationSessionId,
      content: structuredAnswer.trim(),
      transcript,
      changedFiles: metadata.changedFiles,
      verification: metadata.verification,
      exitCode:
        completion.event.outcome === "success" || completion.event.outcome === "user-rejected"
          ? 0
          : 1,
      signal:
        completion.event.outcome === "user-rejected"
          ? "user-rejected"
          : completion.event.outcome === "success"
            ? completion.manual
              ? "manual-success"
              : "auto-finished"
            : (completion.event.outcome ?? null),
      outcome: completion.event.outcome,
      errorMessage: completion.event.error,
    };
  } finally {
    opts.signal?.removeEventListener("abort", onAbort);
    controls.delete(session.id);
    await fs.rm(permissionHook.directory, { recursive: true, force: true });
  }
}

function providerLabel(kind: CliProviderKind): string {
  return kind === "claude-cli" ? "Claude Code" : "Codex";
}

async function existingSessionSize(
  opts: AgentTerminalOptions,
  app: AgentSessionApp,
): Promise<number> {
  if (!opts.resumeConversation || !opts.conversationSessionId) return 0;
  const filePath = await findAgentSessionFilePath(app, opts.conversationSessionId).catch(
    () => null,
  );
  if (!filePath) return 0;
  return (await fs.stat(filePath).catch(() => ({ size: 0 }))).size;
}

function handleAgentSessionEvent(
  session: TerminalSession,
  event: AgentSessionEvent,
  onFrame?: (frame: AgentTerminalFrame) => void,
): void {
  if (event.state === "completed") return;
  const control = controls.get(session.id);
  if (!control) return;
  if (event.state === "waiting-for-choice") {
    control.lastCompletionState = "waiting-for-choice";
    if (control.alwaysEnter) {
      writeRawInput(session, "\r");
      onFrame?.({ type: "status", status: "prompt-sent" });
    } else {
      onFrame?.({ type: "status", status: "waiting-for-choice" });
    }
    return;
  }
  control.lastCompletionState = "empty";
  onFrame?.({ type: "status", status: "prompt-sent" });
}

async function waitForAgentSessionCompletion(
  session: TerminalSession,
  app: AgentSessionApp,
  conversationSessionId: string,
  startOffset: number,
  onFrame?: (frame: AgentTerminalFrame) => void,
  signal?: AbortSignal,
  permissionFilePath?: string,
): Promise<{ event: AgentSessionEvent; manual: boolean }> {
  const localAbort = new AbortController();
  const onAbort = () => localAbort.abort();
  if (signal?.aborted) localAbort.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  const control = requireControl(session.id);
  try {
    const result = await Promise.race([
      watchAgentSession({
        app,
        sessionId: conversationSessionId,
        startOffset,
        permissionFilePath,
        signal: localAbort.signal,
        onEvent: (event) => handleAgentSessionEvent(session, event, onFrame),
        acceptCompletion: () => {
          if (!control.autoFinishPaused) return true;
          control.lastCompletionState = "ready-for-success";
          onFrame?.({ type: "status", status: "ready-for-success" });
          return false;
        },
      }).then((event) => ({ event, manual: false })),
      waitForManualSuccess(control, localAbort.signal).then((event) => ({ event, manual: true })),
    ]);
    localAbort.abort();
    return result;
  } finally {
    signal?.removeEventListener("abort", onAbort);
  }
}

async function waitForManualSuccessIfNeeded(
  sessionId: string,
  completion: AgentSessionEvent,
  alreadyManual: boolean,
  onFrame?: (frame: AgentTerminalFrame) => void,
  signal?: AbortSignal,
): Promise<{ event: AgentSessionEvent; manual: boolean }> {
  if (alreadyManual || completion.outcome !== "success") {
    return { event: completion, manual: alreadyManual };
  }
  const control = controls.get(sessionId);
  if (!control || control.autoSuccess) return { event: completion, manual: false };
  control.lastCompletionState = "ready-for-success";
  onFrame?.({ type: "status", status: "ready-for-success" });
  return { event: await waitForManualSuccess(control, signal), manual: true };
}

function waitForManualSuccess(
  control: AgentTerminalControl,
  signal?: AbortSignal,
): Promise<AgentSessionEvent> {
  if (control.manualSuccessRequested) {
    return Promise.resolve({ state: "completed", outcome: "success" });
  }
  if (signal?.aborted) {
    return Promise.resolve({
      state: "completed",
      outcome: "cancelled",
      error: "Agent run was stopped.",
    });
  }
  return new Promise((resolve) => {
    const succeed = () => finish({ state: "completed", outcome: "success" });
    const abort = () =>
      finish({ state: "completed", outcome: "cancelled", error: "Agent run was stopped." });
    const finish = (event: AgentSessionEvent) => {
      control.manualSuccessWaiters.delete(succeed);
      signal?.removeEventListener("abort", abort);
      resolve(event);
    };
    control.manualSuccessWaiters.add(succeed);
    signal?.addEventListener("abort", abort, { once: true });
  });
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
  const deadline = Date.now() + SESSION_DISCOVERY_TIMEOUT_MS;
  while (!opts.signal?.aborted && Date.now() < deadline) {
    const sessions = await listAgentSessions(baseline.app).catch(() => []);
    const selected = selectConversationSessionId(
      sessions,
      opts.workspace.path,
      baseline.ids,
      baseline.startedAt,
      expectedId,
    );
    if (selected) return selected;
    await sleep(SESSION_DISCOVERY_POLL_MS, opts.signal);
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
  if (expectedId && projectSessions.some((session) => session.id === expectedId)) return expectedId;
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
  conversationSessionId: string,
): Promise<string> {
  if (opts.kind !== "claude-cli") return "";
  let latest = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const conversation = await readClaudeSessionConversation(conversationSessionId);
    if (conversation && conversation === latest) return conversation;
    if (conversation) latest = conversation;
    if (attempt < 3) await sleep(75);
  }
  return latest;
}

async function structuredAgentFinalAnswer(
  opts: AgentTerminalOptions,
  conversationSessionId: string,
  structuredConversation: string,
): Promise<string> {
  if (opts.kind === "claude-cli") return extractLastStructuredClaudeAnswer(structuredConversation);
  let latest = "";
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const answer = await readCodexSessionFinalAnswer(conversationSessionId);
    if (answer && answer === latest) return answer;
    if (answer) latest = answer;
    if (attempt < 3) await sleep(75);
  }
  return latest;
}

export function setAgentTerminalAutoSuccess(
  sessionId: string,
  enabled: boolean,
): { autoSuccess: boolean } {
  const control = requireControl(sessionId);
  control.autoSuccess = enabled;
  return { autoSuccess: control.autoSuccess };
}

export function finishAgentTerminalSuccess(sessionId: string): void {
  const control = requireControl(sessionId);
  control.lastCompletionState = "ready-for-success";
  control.manualSuccessRequested = true;
  for (const wake of control.manualSuccessWaiters) wake();
  control.manualSuccessWaiters.clear();
}

export function createAgentTerminalControlForTest(
  sessionId: string,
  patch: Partial<AgentTerminalControl> = {},
): void {
  controls.set(sessionId, {
    autoSuccess: true,
    alwaysEnter: false,
    autoFinishPaused: false,
    manualSuccessRequested: false,
    manualSuccessWaiters: new Set(),
    ...patch,
  });
}

export async function waitForAgentTerminalManualSuccessForTest(
  sessionId: string,
): Promise<AgentSessionEvent> {
  return waitForManualSuccess(requireControl(sessionId));
}

export function pauseAgentTerminal(sessionId: string): void {
  const control = requireControl(sessionId);
  control.autoFinishPaused = true;
  writeRawInput(getSession(sessionId), "\x03");
}

function requireControl(sessionId: string): AgentTerminalControl {
  const control = controls.get(sessionId);
  if (!control) throw new Error("No pending prompt for this terminal session.");
  return control;
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
    prompt?: string;
    settingsPath?: string;
    codexPermissionHookConfig?: string;
  } = {},
): { command: string } {
  const base = kind === "codex-cli" ? "codex" : "claude";
  const args: string[] = [];
  let codexResumeSessionId = "";
  if (kind === "claude-cli") {
    args.push(
      "--permission-mode",
      options.mode === "plan"
        ? "plan"
        : normalizeClaudePermissionMode(options.claudePermissionMode),
    );
    if (options.resumeConversation && options.conversationSessionId) {
      args.push("--resume", quoteShell(options.conversationSessionId));
    } else {
      if (options.conversationSessionId) {
        args.push("--session-id", quoteShell(options.conversationSessionId));
      }
    }
    const effort = agentEffortCliValue(kind, options.effort);
    if (effort) args.push("--effort", effort);
    if (options.settingsPath) args.push("--settings", quoteShell(options.settingsPath));
  } else {
    if (options.resumeConversation && options.conversationSessionId) {
      args.push("resume");
      codexResumeSessionId = options.conversationSessionId;
    }
    args.push(...codexPermissionArgs(options.codexApproval, options.codexSandbox));
    if (options.codexPermissionHookConfig) {
      args.push("--dangerously-bypass-hook-trust");
      args.push("-c", quoteCodexHookConfig(options.codexPermissionHookConfig));
    }
    const effort = agentEffortCliValue(kind, options.effort);
    if (effort) args.push("-c", quoteCodexConfig(`model_reasoning_effort="${effort}"`));
  }
  if (model && model !== "default") args.push("--model", quoteShell(model));
  if (codexResumeSessionId) args.push(quoteShell(codexResumeSessionId));
  if (options.prompt) args.push(quoteShell(options.prompt));
  return { command: [base, ...args].join(" ") };
}

function normalizeClaudePermissionMode(mode: ClaudePermissionMode | undefined): string {
  return mode === "default" ? "manual" : (mode ?? "acceptEdits");
}

interface ClaudePermissionHookRuntime {
  directory: string;
  settingsPath: string;
  eventsPath: string;
  codexConfig?: undefined;
}

interface CodexPermissionHookRuntime {
  directory: string;
  eventsPath: string;
  codexConfig: string;
  windowsCommandPath?: string;
  settingsPath?: undefined;
}

const CLAUDE_PERMISSION_HOOK_SOURCE = `import { appendFile } from "node:fs/promises";

let input = "";
for await (const chunk of process.stdin) input += chunk;
try {
  const payload = JSON.parse(input);
  await appendFile(process.argv[2], JSON.stringify({
    osheep_event: "claude-permission-request",
    payload: {
      session_id: payload.session_id,
      hook_event_name: payload.hook_event_name,
      notification_type: payload.notification_type,
      tool_use_id: payload.tool_use_id ?? payload.toolUseId,
      tool_name: payload.tool_name ?? payload.toolName,
    },
  }) + "\\n", "utf8");
} catch {
  // A notification hook must never interfere with Claude Code.
}
`;

async function createClaudePermissionHookRuntime(): Promise<ClaudePermissionHookRuntime> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-claude-hook-"));
  const hookPath = path.join(directory, "permission-hook.mjs");
  const eventsPath = path.join(directory, "permission-events.jsonl");
  const settingsPath = path.join(directory, "settings.json");
  const command = [process.execPath, hookPath, eventsPath].map(quoteHookCommandArg).join(" ");
  const settings = {
    hooks: {
      PermissionRequest: [
        {
          hooks: [{ type: "command", command }],
        },
      ],
      Notification: [
        {
          matcher: "permission_prompt",
          hooks: [{ type: "command", command }],
        },
      ],
    },
  };
  await fs.writeFile(hookPath, CLAUDE_PERMISSION_HOOK_SOURCE, "utf8");
  await fs.writeFile(settingsPath, `${JSON.stringify(settings)}\n`, "utf8");
  return { directory, settingsPath, eventsPath };
}

export async function createClaudePermissionHookRuntimeForTest(): Promise<ClaudePermissionHookRuntime> {
  return createClaudePermissionHookRuntime();
}

const CODEX_PERMISSION_HOOK_SOURCE = `import { appendFile } from "node:fs/promises";

try {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const payload = JSON.parse(input);
  await appendFile(process.argv[2], JSON.stringify({
    osheep_event: "codex-permission-request",
    payload: {
      session_id: payload.session_id,
      turn_id: payload.turn_id,
      hook_event_name: payload.hook_event_name,
      tool_use_id: payload.tool_use_id ?? payload.toolUseId,
      tool_name: payload.tool_name ?? payload.toolName,
    },
  }) + "\\n", "utf8");
} catch {
  // A notification hook must never interfere with Codex.
}
`;

async function createCodexPermissionHookRuntime(): Promise<CodexPermissionHookRuntime> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-codex-hook-"));
  const hookPath = path.join(directory, "permission-hook.mjs");
  const eventsPath = path.join(directory, "permission-events.jsonl");
  const command = [process.execPath, hookPath, eventsPath].map(quoteHookCommandArg).join(" ");
  const tomlCommand = `'${command.replace(/'/g, "''")}'`;
  let windowsCommandPath: string | undefined;
  let windowsField = "";
  if (platform === "windows") {
    windowsCommandPath = path.join(directory, "permission-hook.cmd");
    const batch = `@echo off\r\n>>"%~dp0permission-events.jsonl" echo {"osheep_event":"codex-permission-request","payload":{"hook_event_name":"PermissionRequest"}}\r\nexit /b 0\r\n`;
    await fs.writeFile(windowsCommandPath, batch, "utf8");
    const commandWindows = `"${windowsCommandPath}"`;
    windowsField = `, commandWindows='${commandWindows.replace(/'/g, "''")}'`;
  }
  const codexConfig = `hooks.PermissionRequest=[{ hooks=[{ type="command", command=${tomlCommand}${windowsField} }] }]`;
  await fs.writeFile(hookPath, CODEX_PERMISSION_HOOK_SOURCE, "utf8");
  return { directory, eventsPath, codexConfig, windowsCommandPath };
}

export async function createCodexPermissionHookRuntimeForTest(): Promise<CodexPermissionHookRuntime> {
  return createCodexPermissionHookRuntime();
}

function quoteHookCommandArg(value: string): string {
  return `"${value.replace(/"/g, '\\"')}"`;
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
  return approval === "untrusted" || approval === "on-request" || approval === "never"
    ? approval
    : "on-request";
}

function agentEffortCliValue(
  kind: CliProviderKind,
  effort: AgentEffort | undefined,
): string | null {
  if (!effort || effort === "off") return null;
  if (kind === "claude-cli") {
    if (["low", "medium", "high", "xhigh", "max", "ultracode"].includes(effort)) return effort;
    return effort === "minimal" ? "low" : null;
  }
  return ["minimal", "low", "medium", "high", "xhigh", "max"].includes(effort) ? effort : null;
}

function quoteCodexConfig(value: string): string {
  return `'${value.replace(/'/g, platform === "windows" ? "''" : "'\\''")}'`;
}

function quoteCodexHookConfig(value: string): string {
  if (platform !== "windows") return quoteCodexConfig(value);
  const nativeArgument = value.replace(/"/g, '\\"');
  const encoded = Buffer.from(nativeArgument, "utf8").toString("base64");
  return `$([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${encoded}')))`;
}

function quoteShell(value: string): string {
  if (/^[A-Za-z0-9._:-]+$/.test(value)) return value;
  return platform === "windows"
    ? `'${value.replace(/'/g, "''")}'`
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
      { once: true },
    );
  });
}
