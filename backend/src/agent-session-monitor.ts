import * as fs from "node:fs/promises";
import { type AgentSessionApp, findAgentSessionFilePath } from "./agent-sessions.js";

export type AgentSessionState = "running" | "waiting-for-choice" | "completed";
export type AgentSessionOutcome = "success" | "error" | "cancelled";

export interface AgentSessionEvent {
  state: AgentSessionState;
  outcome?: AgentSessionOutcome;
  error?: string;
}

const POLL_INTERVAL_MS = 120;

export class AgentSessionEventReducer {
  private readonly app: AgentSessionApp;
  private readonly pendingQuestions = new Set<string>();
  private readonly pendingCodexQuestions = new Set<string>();
  private activeCodexTurnId = "";

  constructor(app: AgentSessionApp) {
    this.app = app;
  }

  push(value: unknown): AgentSessionEvent[] {
    if (!value || typeof value !== "object" || Array.isArray(value)) return [];
    const root = value as Record<string, unknown>;
    return this.app === "claude" ? this.pushClaude(root) : this.pushCodex(root);
  }

  private pushClaude(root: Record<string, unknown>): AgentSessionEvent[] {
    if (root.isSidechain === true || root.isMeta === true) return [];
    const events: AgentSessionEvent[] = [];
    const message = objectValue(root.message);
    const content = Array.isArray(message.content) ? message.content : [];

    if (stringValue(message.role) === "assistant") {
      for (const item of content) {
        const block = objectValue(item);
        if (
          stringValue(block.type) !== "tool_use" ||
          stringValue(block.name) !== "AskUserQuestion"
        ) {
          continue;
        }
        const id = stringValue(block.id);
        if (id) this.pendingQuestions.add(id);
      }
      if (this.pendingQuestions.size > 0) events.push({ state: "waiting-for-choice" });
    }

    if (stringValue(message.role) === "user") {
      let resolved = false;
      let interrupted = false;
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
        if (id && this.pendingQuestions.delete(id)) resolved = true;
      }
      if (interrupted) {
        this.pendingQuestions.clear();
        events.push({
          state: "completed",
          outcome: "cancelled",
          error: "Claude Code turn was interrupted.",
        });
      }
      if (resolved && this.pendingQuestions.size === 0) events.push({ state: "running" });
    }

    const type = stringValue(root.type);
    const subtype = stringValue(root.subtype);
    const error = claudeErrorMessage(root, message);
    if (events.some((event) => event.state === "completed")) return events;
    if (
      root.is_error === true ||
      root.isApiErrorMessage === true ||
      subtype === "error" ||
      subtype === "api_error" ||
      (type === "result" && subtype !== "success" && !!error)
    ) {
      events.push({ state: "completed", outcome: "error", error: error || "Claude Code failed." });
    } else if (
      type === "system" &&
      subtype === "turn_duration" &&
      this.pendingQuestions.size === 0
    ) {
      events.push({ state: "completed", outcome: "success" });
    }
    return events;
  }

  private pushCodex(root: Record<string, unknown>): AgentSessionEvent[] {
    const payload = objectValue(root.payload);
    const metadata = objectValue(payload.internal_chat_message_metadata_passthrough);
    const type = stringValue(payload.type) || stringValue(root.type);
    const turnId = stringValue(payload.turn_id ?? root.turn_id ?? metadata.turn_id);
    const toolName = stringValue(payload.name ?? root.name);
    const callId = stringValue(payload.call_id ?? root.call_id);

    if (type === "task_started" || type === "turn_started") {
      this.activeCodexTurnId = turnId;
      this.pendingCodexQuestions.clear();
      return [{ state: "running" }];
    }
    if (this.activeCodexTurnId && turnId && turnId !== this.activeCodexTurnId) return [];

    if (
      (type === "function_call" || type === "custom_tool_call") &&
      toolName === "request_user_input"
    ) {
      if (callId) this.pendingCodexQuestions.add(callId);
      return [{ state: "waiting-for-choice" }];
    }
    if (type === "function_call_output" || type === "custom_tool_call_output") {
      if (
        callId &&
        this.pendingCodexQuestions.delete(callId) &&
        this.pendingCodexQuestions.size === 0
      ) {
        return [{ state: "running" }];
      }
      return [];
    }

    if (isCodexWaitingEvent(type, payload)) return [{ state: "waiting-for-choice" }];
    if (isCodexChoiceResolvedEvent(type, payload)) return [{ state: "running" }];

    if (type === "turn_aborted" || type === "task_aborted") {
      return [
        {
          state: "completed",
          outcome: "cancelled",
          error: stringValue(payload.reason ?? root.reason) || "Codex turn was cancelled.",
        },
      ];
    }
    if (type === "task_complete" || type === "turn_complete" || type === "turn_completed") {
      const error = errorMessage(payload.error ?? root.error);
      return [
        error
          ? { state: "completed", outcome: "error", error }
          : { state: "completed", outcome: "success" },
      ];
    }
    return [];
  }
}

export async function watchAgentSession(input: {
  app: AgentSessionApp;
  sessionId: string;
  filePath?: string;
  startOffset?: number;
  signal?: AbortSignal;
  onEvent: (event: AgentSessionEvent) => void;
  acceptCompletion?: (event: AgentSessionEvent) => boolean;
}): Promise<AgentSessionEvent> {
  const reducer = new AgentSessionEventReducer(input.app);
  let filePath: string | null = input.filePath ?? null;
  let offset = input.startOffset ?? 0;
  let remainder = Buffer.alloc(0);

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
    await delay(POLL_INTERVAL_MS, input.signal);
  }
  return { state: "completed", outcome: "cancelled", error: "Agent run was stopped." };
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
