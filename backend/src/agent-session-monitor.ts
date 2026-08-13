import * as fs from "node:fs/promises";
import { type AgentSessionApp, findAgentSessionFilePath } from "./agent-sessions.js";

export type AgentSessionState = "running" | "waiting-for-choice" | "completed";
export type AgentSessionOutcome = "success" | "error" | "cancelled" | "user-rejected";

export interface AgentSessionEvent {
  state: AgentSessionState;
  outcome?: AgentSessionOutcome;
  error?: string;
}

const POLL_INTERVAL_MS = 120;
const CODEX_SILENT_EXEC_WAIT_MS = 1_500;
const CODEX_ABORT_SETTLE_MS = 250;

export class AgentSessionEventReducer {
  private readonly app: AgentSessionApp;
  private readonly pendingQuestions = new Set<string>();
  private readonly pendingClaudePermissionTools = new Set<string>();
  private readonly unresolvedClaudeTools = new Map<string, string>();
  private readonly unboundClaudePermissions: Array<{ key: string; toolName: string }> = [];
  private readonly pendingCodexQuestions = new Set<string>();
  private readonly pendingCodexPermissions = new Set<string>();
  private readonly pendingCodexSilentExecs = new Set<string>();
  private readonly unresolvedCodexCalls = new Map<string, string>();
  private readonly codexSilentExecDeadlines = new Map<string, number>();
  private readonly unboundCodexPermissions: string[] = [];
  private pendingCodexAbort?: { turnId: string; error: string; deadline: number };
  private nextCodexPermissionKey = 1;
  private nextClaudePermissionKey = 1;
  private activeCodexTurnId = "";
  private claudeTurnUserRejected = false;
  private codexTurnUserRejected = false;

  constructor(app: AgentSessionApp) {
    this.app = app;
  }

  push(value: unknown, now = Date.now()): AgentSessionEvent[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const root = value as Record<string, unknown>;
    return this.app === "claude" ? this.pushClaude(root) : this.pushCodex(root, now);
  }

  pushClaudePermission(value: unknown): AgentSessionEvent[] {
    if (this.app !== "claude" || !value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const root = value as Record<string, unknown>;
    if (stringValue(root.osheep_event) !== "claude-permission-request") return [];
    const payload = objectValue(root.payload);
    const sessionId = stringValue(payload.session_id);
    const expectedSessionId = stringValue(root.session_id);
    if (expectedSessionId && sessionId && sessionId !== expectedSessionId) return [];

    const toolUseId = stringValue(payload.tool_use_id ?? payload.toolUseId);
    const toolName = stringValue(payload.tool_name ?? payload.toolName);
    const candidate = toolUseId || this.latestUnresolvedClaudeTool(toolName);
    if (candidate) {
      if (this.pendingQuestions.has(candidate)) return [];
      const unboundPermission = this.takeUnboundClaudePermission(toolName);
      if (unboundPermission) this.pendingClaudePermissionTools.delete(unboundPermission.key);
      if (this.pendingClaudePermissionTools.has(candidate)) return [];
      this.pendingClaudePermissionTools.add(candidate);
    } else {
      if (
        this.unboundClaudePermissions.some(
          (permission) => !permission.toolName || !toolName || permission.toolName === toolName,
        )
      ) {
        return [];
      }
      const key = `permission-${this.nextClaudePermissionKey}`;
      this.nextClaudePermissionKey += 1;
      this.unboundClaudePermissions.push({ key, toolName });
      this.pendingClaudePermissionTools.add(key);
    }
    return [{ state: "waiting-for-choice" }];
  }

  pushCodexPermission(value: unknown): AgentSessionEvent[] {
    if (this.app !== "codex" || !value || typeof value !== "object" || Array.isArray(value)) {
      return [];
    }
    const root = value as Record<string, unknown>;
    if (stringValue(root.osheep_event) !== "codex-permission-request") return [];
    const payload = objectValue(root.payload);
    const callId =
      stringValue(payload.tool_use_id ?? payload.toolUseId) || this.latestUnresolvedCodexCall();
    const key = callId || `permission-${this.nextCodexPermissionKey++}`;
    if (this.pendingCodexPermissions.has(key)) return [];
    if (callId) this.codexSilentExecDeadlines.delete(callId);
    this.pendingCodexPermissions.add(key);
    if (!callId) this.unboundCodexPermissions.push(key);
    return [{ state: "waiting-for-choice" }];
  }

  poll(now = Date.now()): AgentSessionEvent[] {
    if (this.app !== "codex") return [];
    const events: AgentSessionEvent[] = [];
    let waiting = false;
    for (const [callId, deadline] of this.codexSilentExecDeadlines) {
      if (now < deadline) continue;
      this.codexSilentExecDeadlines.delete(callId);
      if (!this.unresolvedCodexCalls.has(callId)) continue;
      this.pendingCodexSilentExecs.add(callId);
      waiting = true;
    }
    if (waiting) events.push({ state: "waiting-for-choice" });
    if (this.pendingCodexAbort && now >= this.pendingCodexAbort.deadline) {
      events.push({
        state: "completed",
        outcome: this.codexTurnUserRejected ? "user-rejected" : "cancelled",
        error: this.codexTurnUserRejected ? undefined : this.pendingCodexAbort.error,
      });
      this.pendingCodexAbort = undefined;
    }
    return events;
  }

  private pushClaude(root: Record<string, unknown>): AgentSessionEvent[] {
    if (root.isSidechain === true || root.isMeta === true) return [];
    const events: AgentSessionEvent[] = [];
    const message = objectValue(root.message);
    const content = Array.isArray(message.content) ? message.content : [];
    const type = stringValue(root.type);
    if (type === "permission-mode") return [];

    if (stringValue(message.role) === "assistant") {
      let waiting = false;
      for (const item of content) {
        const block = objectValue(item);
        if (stringValue(block.type) !== "tool_use") continue;
        const id = stringValue(block.id);
        const name = stringValue(block.name);
        if (id) this.unresolvedClaudeTools.set(id, name);
        const unboundPermission = id ? this.takeUnboundClaudePermission(name) : undefined;
        if (id && unboundPermission) {
          this.pendingClaudePermissionTools.delete(unboundPermission.key);
          this.pendingClaudePermissionTools.add(id);
        }
        if (name === "AskUserQuestion") {
          if (id) this.pendingQuestions.add(id);
          if (id) this.pendingClaudePermissionTools.delete(id);
          waiting = true;
        }
      }
      if (waiting) events.push({ state: "waiting-for-choice" });
    }

    if (stringValue(message.role) === "user") {
      let resolved = false;
      let interrupted = false;
      const userRejected = claudeToolUseWasRejected(root);
      if (userRejected) this.claudeTurnUserRejected = true;
      for (const item of content) {
        const block = objectValue(item);
        if (
          stringValue(block.type) === "text" &&
          /^\[Request interrupted by user(?: for tool use)?\]$/i.test(stringValue(block.text))
        ) {
          interrupted = true;
        }
        if (stringValue(block.type) !== "tool_result") continue;
        const id = stringValue(block.tool_use_id);
        if (id) {
          this.unresolvedClaudeTools.delete(id);
          const resolvedQuestion = this.pendingQuestions.delete(id);
          const resolvedPermission = this.pendingClaudePermissionTools.delete(id);
          if (resolvedQuestion || resolvedPermission) resolved = true;
        }
      }
      if (interrupted) {
        this.pendingQuestions.clear();
        this.pendingClaudePermissionTools.clear();
        this.unresolvedClaudeTools.clear();
        this.unboundClaudePermissions.length = 0;
        if (!this.claudeTurnUserRejected) {
          events.push({
            state: "completed",
            outcome: "cancelled",
            error: "Claude Code turn was interrupted.",
          });
        }
      }
      if (
        resolved &&
        !userRejected &&
        this.pendingQuestions.size === 0 &&
        this.pendingClaudePermissionTools.size === 0
      ) {
        events.push({ state: "running" });
      }
    }

    const subtype = stringValue(root.subtype);
    const error = claudeErrorMessage(root, message);
    if (events.some((event) => event.state === "completed")) return events;
    if (
      !this.claudeTurnUserRejected &&
      (root.is_error === true ||
        root.isApiErrorMessage === true ||
        subtype === "error" ||
        subtype === "api_error" ||
        (type === "result" && subtype !== "success" && !!error))
    ) {
      events.push({ state: "completed", outcome: "error", error: error || "Claude Code failed." });
    } else if (
      type === "system" &&
      subtype === "turn_duration" &&
      this.pendingQuestions.size === 0 &&
      this.pendingClaudePermissionTools.size === 0
    ) {
      events.push({
        state: "completed",
        outcome: this.claudeTurnUserRejected ? "user-rejected" : "success",
      });
      this.claudeTurnUserRejected = false;
    }
    return events;
  }

  private latestUnresolvedClaudeTool(toolName: string): string {
    const entries = [...this.unresolvedClaudeTools.entries()];
    for (let index = entries.length - 1; index >= 0; index -= 1) {
      const [id, name] = entries[index];
      if (!toolName || name === toolName) return id;
    }
    return "";
  }

  private takeUnboundClaudePermission(
    toolName: string,
  ): { key: string; toolName: string } | undefined {
    const index = this.unboundClaudePermissions.findIndex(
      (permission) => !permission.toolName || permission.toolName === toolName,
    );
    if (index < 0) return undefined;
    return this.unboundClaudePermissions.splice(index, 1)[0];
  }

  private pushCodex(root: Record<string, unknown>, now: number): AgentSessionEvent[] {
    const payload = objectValue(root.payload);
    const type = stringValue(payload.type) || stringValue(root.type);
    // response_item metadata uses model-internal turn ids that differ from the
    // task_started/task_complete turn id. Only direct event turn ids identify
    // the task whose completion should be filtered.
    const turnId = stringValue(payload.turn_id ?? root.turn_id);
    const toolName = stringValue(payload.name ?? root.name);
    const callId = stringValue(payload.call_id ?? root.call_id);

    if (type === "task_started" || type === "turn_started") {
      const startsDifferentTurn =
        !!this.activeCodexTurnId && !!turnId && turnId !== this.activeCodexTurnId;
      const previousAbort = startsDifferentTurn ? this.takePendingCodexAbort() : undefined;
      this.activeCodexTurnId = turnId;
      if (startsDifferentTurn) {
        this.pendingCodexQuestions.clear();
        this.pendingCodexPermissions.clear();
        this.pendingCodexSilentExecs.clear();
        this.unresolvedCodexCalls.clear();
        this.codexSilentExecDeadlines.clear();
        this.unboundCodexPermissions.length = 0;
        this.pendingCodexAbort = undefined;
        this.codexTurnUserRejected = false;
      }
      const startEvents: AgentSessionEvent[] = previousAbort ? [previousAbort] : [];
      if (this.pendingCodexQuestions.size > 0 ||
        this.pendingCodexPermissions.size > 0 ||
        this.pendingCodexSilentExecs.size > 0) {
        return startEvents;
      }
      startEvents.push({ state: "running" });
      return startEvents;
    }
    if (this.activeCodexTurnId && turnId && turnId !== this.activeCodexTurnId) return [];

    if (
      (type === "function_call" || type === "custom_tool_call") &&
      toolName === "request_user_input"
    ) {
      if (callId) this.pendingCodexQuestions.add(callId);
      return [{ state: "waiting-for-choice" }];
    }
    if ((type === "function_call" || type === "custom_tool_call") && callId) {
      this.unresolvedCodexCalls.set(callId, toolName);
      const permissionKey = this.unboundCodexPermissions.shift();
      if (permissionKey) {
        this.pendingCodexPermissions.delete(permissionKey);
        this.pendingCodexPermissions.add(callId);
      } else if (type === "custom_tool_call" && toolName === "exec") {
        this.codexSilentExecDeadlines.set(callId, now + CODEX_SILENT_EXEC_WAIT_MS);
      }
      return [];
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (callId) {
        this.unresolvedCodexCalls.delete(callId);
        this.codexSilentExecDeadlines.delete(callId);
      }
      const resolvedPermission = callId
        ? this.pendingCodexPermissions.delete(callId)
        : this.deleteFirstCodexPermission();
      const resolvedSilentExec = callId
        ? this.pendingCodexSilentExecs.delete(callId)
        : this.deleteFirstCodexSilentExec();
      if (
        ((callId && this.pendingCodexQuestions.delete(callId)) ||
          resolvedPermission ||
          resolvedSilentExec) &&
        this.pendingCodexQuestions.size === 0 &&
        this.pendingCodexPermissions.size === 0 &&
        this.pendingCodexSilentExecs.size === 0
      ) {
        return [{ state: "running" }];
      }
      return [];
    }

    if (isCodexWaitingEvent(type, payload)) return [{ state: "waiting-for-choice" }];
    if (isCodexChoiceResolvedEvent(type, payload)) return [{ state: "running" }];

    if (type === "item_completed") {
      const item = objectValue(payload.item);
      if (stringValue(item.status) !== "declined") return [];
      this.codexTurnUserRejected = true;
      if (!this.pendingCodexAbort) return [];
      this.pendingCodexAbort = undefined;
      return [{ state: "completed", outcome: "user-rejected" }];
    }

    if (type === "turn_aborted" || type === "task_aborted") {
      if (this.codexTurnUserRejected) {
        return [{ state: "completed", outcome: "user-rejected" }];
      }
      this.pendingCodexAbort = {
        turnId,
        error: stringValue(payload.reason ?? root.reason) || "Codex turn was cancelled.",
        deadline: now + CODEX_ABORT_SETTLE_MS,
      };
      return [];
    }
    if (type === "task_complete" || type === "turn_complete" || type === "turn_completed") {
      if (this.codexTurnUserRejected) {
        this.pendingCodexAbort = undefined;
        return [{ state: "completed", outcome: "user-rejected" }];
      }
      const error = errorMessage(payload.error ?? root.error);
      return [
        error
          ? { state: "completed", outcome: "error", error }
          : { state: "completed", outcome: "success" },
      ];
    }
    return [];
  }

  private deleteFirstCodexPermission(): boolean {
    const key = this.pendingCodexPermissions.values().next().value;
    return typeof key === "string" && this.pendingCodexPermissions.delete(key);
  }

  private deleteFirstCodexSilentExec(): boolean {
    const callId = this.pendingCodexSilentExecs.values().next().value;
    return typeof callId === "string" && this.pendingCodexSilentExecs.delete(callId);
  }

  private latestUnresolvedCodexCall(): string {
    const calls = [...this.unresolvedCodexCalls.keys()];
    return calls.at(-1) ?? "";
  }

  private takePendingCodexAbort(): AgentSessionEvent | undefined {
    if (!this.pendingCodexAbort) return undefined;
    const event: AgentSessionEvent = this.codexTurnUserRejected
      ? { state: "completed", outcome: "user-rejected" }
      : {
          state: "completed",
          outcome: "cancelled",
          error: this.pendingCodexAbort.error,
        };
    this.pendingCodexAbort = undefined;
    return event;
  }
}

function claudeToolUseWasRejected(root: Record<string, unknown>): boolean {
  return stringValue(root.toolDenialKind ?? root.tool_denial_kind) === "user-rejected";
}

export async function watchAgentSession(input: {
  app: AgentSessionApp;
  sessionId: string;
  filePath?: string;
  startOffset?: number;
  permissionFilePath?: string;
  signal?: AbortSignal;
  onEvent: (event: AgentSessionEvent) => void;
  acceptCompletion?: (event: AgentSessionEvent) => boolean;
}): Promise<AgentSessionEvent> {
  const reducer = new AgentSessionEventReducer(input.app);
  let filePath: string | null = input.filePath ?? null;
  let offset = input.startOffset ?? 0;
  let remainder = Buffer.alloc(0);
  let permissionOffset = 0;
  let permissionRemainder: Buffer<ArrayBufferLike> = Buffer.alloc(0);

  while (!input.signal?.aborted) {
    filePath ??= await findAgentSessionFilePath(input.app, input.sessionId).catch(() => null);
    if (!filePath) {
      await delay(POLL_INTERVAL_MS, input.signal);
      continue;
    }

    try {
      const handle = await fs.open(filePath, "r");
      try {
        const stat = await handle.stat();
        if (stat.size < offset) {
          offset = 0;
          remainder = Buffer.alloc(0);
        }
        if (stat.size > offset) {
          const buffer = Buffer.alloc(stat.size - offset);
          const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
          offset += bytesRead;
          const combined = Buffer.concat([remainder, buffer.subarray(0, bytesRead)]);
          const lines: Buffer[] = [];
          let lineStart = 0;
          for (let index = 0; index < combined.length; index += 1) {
            if (combined[index] !== 0x0a) continue;
            lines.push(combined.subarray(lineStart, index));
            lineStart = index + 1;
          }
          remainder = combined.subarray(lineStart);
          if (remainder.length > 0) {
            try {
              JSON.parse(remainder.toString("utf8"));
              lines.push(remainder);
              remainder = Buffer.alloc(0);
            } catch {
              /* partial final line */
            }
          }
          for (const lineBuffer of lines) {
            const line = lineBuffer.toString("utf8").replace(/\r$/, "");
            if (!line.trim()) continue;
            let value: unknown;
            try {
              value = JSON.parse(line);
            } catch {
              continue;
            }
            for (const event of reducer.push(value)) {
              input.onEvent(event);
              if (event.state === "completed" && (input.acceptCompletion?.(event) ?? true)) {
                return event;
              }
            }
          }
        }
      } finally {
        await handle.close();
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      if (!input.filePath) filePath = null;
    }

    // Session events establish the active turn and unresolved tool calls. Read
    // them before the sidecar so a permission cannot be overwritten by replayed
    // task_started history on the watcher's first poll.
    if (input.permissionFilePath) {
      const read = await readJsonlIncrement(
        input.permissionFilePath,
        permissionOffset,
        permissionRemainder,
      );
      permissionOffset = read.offset;
      permissionRemainder = read.remainder;
      for (const value of read.values) {
        const events =
          input.app === "claude"
            ? reducer.pushClaudePermission(value)
            : reducer.pushCodexPermission(value);
        for (const event of events) input.onEvent(event);
      }
    }
    for (const event of reducer.poll()) {
      input.onEvent(event);
      if (event.state === "completed" && (input.acceptCompletion?.(event) ?? true)) {
        return event;
      }
    }
    await delay(POLL_INTERVAL_MS, input.signal);
  }
  return { state: "completed", outcome: "cancelled", error: "Agent run was stopped." };
}

async function readJsonlIncrement(
  filePath: string,
  offset: number,
  remainder: Buffer,
): Promise<{ offset: number; remainder: Buffer; values: unknown[] }> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      const stat = await handle.stat();
      if (stat.size < offset) {
        offset = 0;
        remainder = Buffer.alloc(0);
      }
      if (stat.size <= offset) return { offset, remainder, values: [] };
      const buffer = Buffer.alloc(stat.size - offset);
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, offset);
      const combined = Buffer.concat([remainder, buffer.subarray(0, bytesRead)]);
      const values: unknown[] = [];
      let lineStart = 0;
      for (let index = 0; index < combined.length; index += 1) {
        if (combined[index] !== 0x0a) continue;
        parseJsonlValue(combined.subarray(lineStart, index), values);
        lineStart = index + 1;
      }
      remainder = combined.subarray(lineStart);
      if (remainder.length > 0) {
        try {
          values.push(JSON.parse(remainder.toString("utf8")));
          remainder = Buffer.alloc(0);
        } catch {
          /* partial final line */
        }
      }
      return { offset: offset + bytesRead, remainder, values };
    } finally {
      await handle.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { offset, remainder, values: [] };
    }
    throw error;
  }
}

function parseJsonlValue(lineBuffer: Buffer, values: unknown[]): void {
  const line = lineBuffer.toString("utf8").replace(/\r$/, "");
  if (!line.trim()) return;
  try {
    values.push(JSON.parse(line));
  } catch {
    /* malformed lines do not stop the live watcher */
  }
}

function isCodexWaitingEvent(type: string, payload: Record<string, unknown>): boolean {
  if (/request_user_input|approval_request|request_permission/i.test(type)) return true;
  const item = objectValue(payload.item);
  return /request_user_input|approval_request|request_permission/i.test(stringValue(item.type));
}

function isCodexChoiceResolvedEvent(type: string, payload: Record<string, unknown>): boolean {
  if (/user_input|approval_response|permission_response/i.test(type)) return true;
  const item = objectValue(payload.item);
  return /user_input|approval_response|permission_response/i.test(stringValue(item.type));
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function errorMessage(value: unknown): string {
  if (typeof value === "string") return value;
  const object = objectValue(value);
  return stringValue(object.message ?? object.error ?? object.reason);
}

function claudeErrorMessage(
  root: Record<string, unknown>,
  message: Record<string, unknown>,
): string {
  const content = Array.isArray(message.content) ? message.content : [];
  const contentError = content
    .map((item) => stringValue(objectValue(item).text))
    .find((text) => /^API Error\s*:/i.test(text));
  return (
    contentError ||
    errorMessage(root.error) ||
    errorMessage(root.result) ||
    (typeof root.message === "string" ? root.message : "")
  );
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
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
