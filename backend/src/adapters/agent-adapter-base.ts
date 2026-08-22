import { randomUUID } from "node:crypto";
import { type AgentTerminalResult, pauseAgentTerminal } from "../ai-terminal.js";
import { killSession } from "../pty.js";
import type { WorkspaceInfo } from "../workspace.js";
import { AdapterError } from "./errors.js";
import { createAdapterEvent } from "./events.js";
import { createOsheepSession, publishAdapterEvent, saveAdapterSession } from "./session-store.js";
import type {
  AdapterConfig,
  AdapterEventListener,
  AdapterSession,
  AdapterStartInput,
  AgentAdapter,
  AgentState,
  AgentStateSnapshot,
  OsheepSession,
} from "./types.js";

export abstract class TerminalAgentAdapter implements AgentAdapter {
  abstract readonly id: "claude-code" | "codex";
  abstract readonly name: string;
  readonly kind = "agent" as const;
  abstract getCapabilities(): ReturnType<AgentAdapter["getCapabilities"]>;
  abstract getConfigSchema(): ReturnType<AgentAdapter["getConfigSchema"]>;

  async start(input: AdapterStartInput): Promise<AdapterSession> {
    return this.create(input, false);
  }
  async resume(input: AdapterStartInput & { sessionId: string }): Promise<AdapterSession> {
    return this.create(input, true);
  }

  private async create(
    input: AdapterStartInput & { sessionId?: string },
    resume: boolean,
  ): Promise<AdapterSession> {
    const session = createOsheepSession(this.id, this.kind, {
      id: input.sessionId,
      nativeSessionId: input.sessionId,
      metadata: input.metadata,
    });
    const adapterSession = new TerminalAdapterSession(this, session, input, resume);
    saveAdapterSession(adapterSession);
    // Let callers subscribe immediately after start() before lifecycle events begin.
    queueMicrotask(() => {
      void adapterSession
        .send({ prompt: input.prompt, config: input.config, signal: input.signal })
        .catch(() => undefined);
    });
    return adapterSession;
  }

  abstract run(input: {
    workspace: WorkspaceInfo;
    prompt: string;
    config: AdapterConfig;
    nativeSessionId?: string;
    resume: boolean;
    signal: AbortSignal;
    onFrame: (frame: { type: string; sessionId?: string; status?: string }) => void;
  }): Promise<AgentTerminalResult>;
}

class TerminalAdapterSession implements AdapterSession {
  readonly session: OsheepSession;
  private readonly listeners = new Set<AdapterEventListener>();
  private sequence = 0;
  private controller = new AbortController();
  private terminalSessionId = "";
  private running?: Promise<void>;
  private state: AgentState = "starting";
  private error = "";
  constructor(
    private readonly adapter: TerminalAgentAdapter,
    session: OsheepSession,
    private readonly startInput: AdapterStartInput & { sessionId?: string },
    private readonly resume: boolean,
  ) {
    this.session = session;
  }

  async send(input: {
    prompt: string;
    config?: Record<string, unknown>;
    signal?: AbortSignal;
  }): Promise<void> {
    if (this.state === "closed" || this.state === "stopped")
      throw new AdapterError("SESSION_NOT_FOUND", "Session is closed", {
        adapterId: this.adapter.id,
        sessionId: this.session.id,
      });
    if (this.running) await this.running;
    const controller = new AbortController();
    this.controller = controller;
    if (input.signal) {
      if (input.signal.aborted) controller.abort();
      else input.signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const workspace = normalizeWorkspace(this.startInput.workspace);
    const config = { ...(this.startInput.config ?? {}), ...(input.config ?? {}) } as AdapterConfig;
    this.running = this.runTurn(workspace, input.prompt, config, controller.signal);
    await this.running;
  }

  private async runTurn(
    workspace: WorkspaceInfo,
    prompt: string,
    config: AdapterConfig,
    signal: AbortSignal,
  ): Promise<void> {
    this.setState(this.resume && this.session.nativeSessionId ? "running" : "starting");
    try {
      const result = await this.adapter.run({
        workspace,
        prompt,
        config,
        nativeSessionId: this.session.nativeSessionId,
        resume: this.resume || Boolean(this.session.nativeSessionId),
        signal,
        onFrame: (frame) => this.onFrame(frame),
      });
      if (result.conversationSessionId) this.session.nativeSessionId = result.conversationSessionId;
      if (result.outcome === "cancelled") this.setState("interrupted");
      else if (result.outcome === "error" || result.exitCode !== 0) {
        this.error = result.errorMessage ?? "Agent process failed";
        this.setState("failed");
      } else this.setState("completed");
    } catch (cause) {
      if (signal.aborted) {
        this.setState("interrupted");
        return;
      }
      this.error = cause instanceof Error ? cause.message : String(cause);
      this.setState("failed");
      throw new AdapterError("SEND_FAILED", this.error, {
        adapterId: this.adapter.id,
        sessionId: this.session.id,
        retryable: true,
        cause,
      });
    } finally {
      this.running = undefined;
    }
  }
  private onFrame(frame: { type: string; sessionId?: string; status?: string }): void {
    if (frame.type === "session" && frame.sessionId) this.terminalSessionId = frame.sessionId;
    if (frame.type === "conversation" && frame.sessionId)
      this.session.nativeSessionId = frame.sessionId;
    const event = createAdapterEvent(
      { sessionId: this.session.id, adapterId: this.adapter.id },
      "adapter.frame",
      {
        frameType: frame.type,
        frameStatus: frame.status,
        frameSessionId: frame.sessionId,
      },
      ++this.sequence,
    );
    publishAdapterEvent(event);
    for (const listener of this.listeners) listener(event);
    if (frame.type === "status" && frame.status === "waiting-for-choice")
      this.setState("waiting", "approval");
    else if (frame.type === "status" && frame.status !== "exited") this.setState("running");
  }
  private setState(
    state: AgentState,
    reason?: "approval" | "user-input" | "manual-success" | "unknown",
  ): void {
    this.state = state;
    this.session.state = state;
    this.session.updatedAt = Date.now();
    const eventType =
      state === "waiting"
        ? "agent.waiting"
        : state === "failed"
          ? "agent.failed"
          : state === "completed"
            ? "agent.completed"
            : state === "starting"
              ? "session.started"
              : state === "running" && this.resume && this.sequence === 0
                ? "session.resumed"
                : "assistant.message";
    const event = createAdapterEvent(
      { sessionId: this.session.id, adapterId: this.adapter.id },
      eventType,
      { state, reason, error: this.error },
      ++this.sequence,
    );
    publishAdapterEvent(event);
    for (const listener of this.listeners) listener(event);
  }
  async interrupt(reason = "interrupted"): Promise<void> {
    this.controller.abort();
    if (this.terminalSessionId) {
      try {
        pauseAgentTerminal(this.terminalSessionId);
      } catch {
        // The terminal may have exited before the interrupt reached it.
      }
    }
    this.setState("interrupted", "user-input");
    void reason;
  }
  async stop(reason = "stopped"): Promise<void> {
    this.controller.abort();
    if (this.terminalSessionId) killSession(this.terminalSessionId, reason);
    this.setState("stopped");
  }
  async getState(): Promise<AgentStateSnapshot> {
    return { state: this.state, error: this.error || undefined, updatedAt: this.session.updatedAt };
  }
  async getSession(): Promise<OsheepSession> {
    return this.session;
  }
  subscribeEvents(listener: AdapterEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}

function normalizeWorkspace(value: WorkspaceInfo | string): WorkspaceInfo {
  return typeof value === "string" ? { id: randomUUID(), name: value, path: value } : value;
}
