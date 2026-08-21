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
const CODEX_SILENT_EXEC_WAIT_MS = 5_000;
const CODEX_ABORT_SETTLE_MS = 250;

export class AgentSessionEventReducer {
  private readonly app: AgentSessionApp;
  private readonly pendingQuestions = new Set<string>();
  private readonly pendingClaudePermissionTools = new Set<string>();
  private readonly unresolvedClaudeTools = new Map<string, string>();
  private readonly unboundClaudePermissions: Array<{ key: string; toolName: string }> = [];
  private readonly pendingCodexSilentExecs = new Set<string>();
  private readonly unresolvedCodexCalls = new Map<string, string>();
  private readonly codexSilentExecDeadlines = new Map<string, number>();
  private pendingCodexAbort?: {
    turnId: string;
    error: string;
    deadline: number;
    userInterrupted: boolean;
  };
  private nextClaudePermissionKey = 1;
  private activeCodexTurnId = "";
  private claudeTurnUserRejected = false;
  private codexTurnUserRejected = false;
  private codexTurnUserInterrupted = false;

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
        outcome: this.codexTurnUserRejected
          ? "user-rejected"
          : this.pendingCodexAbort.userInterrupted
            ? "cancelled"
            : "error",
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
    const messageContent = message.content;
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
      const replacementInput =
        this.claudeTurnUserRejected &&
        ((typeof messageContent === "string" && messageContent.trim().length > 0) ||
          content.some((item) => {
            const block = objectValue(item);
            const text = stringValue(block.text);
            return (
              stringValue(block.type) === "text" &&
              !!text &&
              !/^\[Request interrupted by user(?: for tool use)?\]$/i.test(text)
            );
          }));
      if (replacementInput) {
        this.claudeTurnUserRejected = false;
        events.push({ state: "running" });
      }
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
      events.push(
        this.claudeTurnUserRejected
          ? { state: "waiting-for-choice" }
          : { state: "completed", outcome: "success" },
      );
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

    if (isCodexUserInterruptMarker(root, payload)) {
      this.codexTurnUserInterrupted = true;
      return [];
    }

    if (type === "task_started" || type === "turn_started") {
      const startsNewTurn = !!turnId && turnId !== this.activeCodexTurnId;
      const startsDifferentTurn = !!this.activeCodexTurnId && startsNewTurn;
      const previousAbort = startsNewTurn ? this.takePendingCodexAbort() : undefined;
      this.activeCodexTurnId = turnId;
      this.codexTurnUserInterrupted = false;
      if (startsDifferentTurn) {
        this.pendingCodexSilentExecs.clear();
        this.unresolvedCodexCalls.clear();
        this.codexSilentExecDeadlines.clear();
        this.pendingCodexAbort = undefined;
        this.codexTurnUserRejected = false;
      }
      const startEvents: AgentSessionEvent[] = previousAbort ? [previousAbort] : [];
      if (this.pendingCodexSilentExecs.size > 0) {
        return startEvents;
      }
      startEvents.push({ state: "running" });
      return startEvents;
    }
    if (this.activeCodexTurnId && turnId && turnId !== this.activeCodexTurnId) return [];

    if ((type === "function_call" || type === "custom_tool_call") && callId) {
      this.unresolvedCodexCalls.set(callId, toolName);
      if (type === "custom_tool_call" && toolName === "exec") {
        this.codexSilentExecDeadlines.set(callId, now + CODEX_SILENT_EXEC_WAIT_MS);
      }
      return [];
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (callId) {
        this.unresolvedCodexCalls.delete(callId);
        this.codexSilentExecDeadlines.delete(callId);
      }
      const resolvedSilentExec = callId
        ? this.pendingCodexSilentExecs.delete(callId)
        : this.deleteFirstCodexSilentExec();
      if (resolvedSilentExec && this.pendingCodexSilentExecs.size === 0) {
        return [{ state: "running" }];
      }
      return [];
    }

    if (type === "item_completed") {
      const item = objectValue(payload.item);
      if (stringValue(item.status) !== "declined") return [];
      this.codexTurnUserRejected = true;
      this.pendingCodexAbort = undefined;
      return [];
    }

    if (type === "turn_aborted" || type === "task_aborted") {
      if (this.codexTurnUserRejected) {
        return [];
      }
      const abortError =
        errorMessage(payload.reason ?? root.reason) ||
        errorMessage(payload.error ?? root.error) ||
        stringValue(payload.message ?? root.message);
      if (isCodexApiErrorMessage(abortError)) {
        return [{ state: "completed", outcome: "error", error: abortError }];
      }
      this.pendingCodexAbort = {
        turnId,
        error: abortError || "Codex turn was cancelled.",
        deadline: now + CODEX_ABORT_SETTLE_MS,
        userInterrupted: this.codexTurnUserInterrupted,
      };
      this.codexTurnUserInterrupted = false;
      return [];
    }
    const terminalStreamError = codexTerminalStreamError(type, payload, root);
    if (terminalStreamError) {
      return [{ state: "completed", outcome: "error", error: terminalStreamError }];
    }
    const eventError = codexEventApiError(type, payload, root);
    if (eventError) {
      return [{ state: "completed", outcome: "error", error: eventError }];
    }
    if (type === "task_complete" || type === "turn_complete" || type === "turn_completed") {
      if (this.codexTurnUserRejected) {
        this.pendingCodexAbort = undefined;
        return [];
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

  private deleteFirstCodexSilentExec(): boolean {
    const callId = this.pendingCodexSilentExecs.values().next().value;
    return typeof callId === "string" && this.pendingCodexSilentExecs.delete(callId);
  }

  private takePendingCodexAbort(): AgentSessionEvent | undefined {
    if (!this.pendingCodexAbort) return undefined;
    const event: AgentSessionEvent = this.codexTurnUserRejected
      ? { state: "completed", outcome: "user-rejected" }
      : this.pendingCodexAbort.userInterrupted
        ? {
            state: "completed",
            outcome: "cancelled",
            error: this.pendingCodexAbort.error,
          }
        : {
            state: "completed",
            outcome: "error",
            error: this.pendingCodexAbort.error,
          };
    this.pendingCodexAbort = undefined;
    return event;
  }
}

function isCodexUserInterruptMarker(
  root: Record<string, unknown>,
  payload: Record<string, unknown>,
): boolean {
  if (stringValue(root.type) !== "response_item" || stringValue(payload.type) !== "message") {
    return false;
  }
  if (stringValue(payload.role) !== "developer") return false;
  const content = Array.isArray(payload.content) ? payload.content : [];
  return content.some((value) => {
    const item = objectValue(value);
    const text = stringValue(item.text);
    return (
      stringValue(item.type) === "input_text" &&
      /<turn_aborted>[\s\S]*previous turn was interrupted on purpose[\s\S]*<\/turn_aborted>/i.test(
        text,
      )
    );
  });
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

    // Session events establish the active turn and unresolved tool calls. For
    // Claude, read the permission sidecar after the session so replayed history
    // cannot overwrite a permission wait on the watcher's first poll.
    if (input.app === "claude" && input.permissionFilePath) {
      const read = await readJsonlIncrement(
        input.permissionFilePath,
        permissionOffset,
        permissionRemainder,
      );
      permissionOffset = read.offset;
      permissionRemainder = read.remainder;
      for (const value of read.values) {
        const events = reducer.pushClaudePermission(value);
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

function codexTerminalStreamError(
  type: string,
  payload: Record<string, unknown>,
  root: Record<string, unknown>,
): string {
  if (type !== "stream_error") return "";
  const message =
    errorMessage(payload.error ?? root.error) ||
    stringValue(payload.message ?? root.message ?? payload.reason ?? root.reason);
  return /\b(?:exceeded|reached) (?:the )?retry limit\b/i.test(message) ? message : "";
}

function codexEventApiError(
  type: string,
  payload: Record<string, unknown>,
  root: Record<string, unknown>,
): string {
  if (!/(?:^|_)(?:error|failed|failure)(?:$|_)/i.test(type)) return "";
  const message =
    errorMessage(payload.error ?? root.error) ||
    stringValue(payload.message ?? root.message ?? payload.reason ?? root.reason);
  return isCodexApiErrorMessage(message) ? message : "";
}

function isCodexApiErrorMessage(message: string): boolean {
  return /\b(?:unexpected status|last status|HTTP(?: status)?|response status|status code|status)\s*(?:code\s*)?[:=]?\s*[1-5]\d{2}\b|\b(?:API Error|API request|api_error|INVALID_API_KEY|API_KEY_DISABLED|rate[_ ]limit|overloaded|service unavailable|fetch failed|network error|connection (?:reset|refused|timed out)|econnreset|econnrefused|etimedout|enotfound|dns|tls)\b/i.test(
    message,
  );
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
