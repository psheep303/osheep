import { randomUUID } from "node:crypto";
import { AdapterError } from "./errors.js";
import { createAdapterEvent } from "./events.js";
import { AdapterRuntime } from "./runtime.js";
import { createOsheepSession, publishAdapterEvent, saveAdapterSession } from "./session-store.js";
import type {
  AdapterConfig,
  AdapterEvent,
  AdapterEventListener,
  AdapterEventMapper,
  AdapterSession,
  AdapterStartInput,
  AgentAdapter,
  AgentState,
  AgentStateSnapshot,
  AgentTransport,
  OsheepSession,
  TransportStartInput,
} from "./types.js";

export abstract class JsonlAgentAdapter implements AgentAdapter {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly version: string;
  readonly kind = "agent" as const;
  abstract readonly transport: AgentTransport;
  abstract readonly mapper: AdapterEventMapper;
  abstract getCapabilities(): ReturnType<AgentAdapter["getCapabilities"]>;
  abstract getConfigSchema(): ReturnType<AgentAdapter["getConfigSchema"]>;
  transportInput(input: AdapterStartInput, config: AdapterConfig): TransportStartInput {
    const workspace = typeof input.workspace === "string" ? input.workspace : input.workspace.path;
    return { cwd: config.workingDirectory ?? workspace, env: {} };
  }
  async start(input: AdapterStartInput): Promise<AdapterSession> {
    return this.create(input, false);
  }
  async resume(input: AdapterStartInput & { sessionId: string }): Promise<AdapterSession> {
    if (!this.getCapabilities().resume) {
      throw new AdapterError("UNSUPPORTED", "This adapter does not support resume", {
        adapterId: this.id,
        sessionId: input.sessionId,
      });
    }
    return this.create(input, true);
  }

  private async create(
    input: AdapterStartInput & { sessionId?: string },
    resume: boolean,
  ): Promise<AdapterSession> {
    const session = createOsheepSession(this.id, this.kind, {
      id: input.sessionId ?? randomUUID(),
      nativeSessionId: input.sessionId,
      metadata: input.metadata,
    });
    const adapterSession = new JsonlAdapterSession(this, session, input, resume);
    saveAdapterSession(adapterSession);
    queueMicrotask(
      () =>
        void adapterSession
          .send({ prompt: input.prompt, config: input.config, signal: input.signal })
          .catch(() => undefined),
    );
    return adapterSession;
  }
}

class JsonlAdapterSession implements AdapterSession {
  readonly session: OsheepSession;
  private readonly listeners = new Set<AdapterEventListener>();
  private readonly runtime: AdapterRuntime;
  private state: AgentState = "starting";
  private error?: string;
  private running?: Promise<void>;
  private started = false;
  private sequence = 0;

  constructor(
    private readonly adapter: JsonlAgentAdapter,
    session: OsheepSession,
    private readonly input: AdapterStartInput & { sessionId?: string },
    private readonly resume: boolean,
  ) {
    this.session = session;
    this.runtime = new AdapterRuntime(adapter.id, session.id, adapter.transport, adapter.mapper);
    this.runtime.subscribe((event) => this.onEvent(event));
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
    const config = { ...(this.input.config ?? {}), ...(input.config ?? {}) } as AdapterConfig;
    this.running = this.run(config, input.prompt, input.signal);
    await this.running;
  }
  private async run(config: AdapterConfig, prompt: string, signal?: AbortSignal): Promise<void> {
    try {
      if (!this.started) {
        await this.runtime.start(
          this.adapter.transportInput(this.input, config),
          this.resume ? this.session.nativeSessionId : undefined,
        );
        this.started = true;
      }
      if (signal?.aborted)
        throw new AdapterError("INTERRUPTED", "Adapter request was interrupted", {
          adapterId: this.adapter.id,
          sessionId: this.session.id,
        });
      this.setState(this.resume && this.session.nativeSessionId ? "running" : "starting");
      await this.runtime.send(prompt);
      const result = await this.runtime.wait();
      if (result.exitCode === 0) {
        if (this.state !== "completed") this.setState("completed");
      } else if (this.state !== "failed") {
        this.error = result.error ?? "Adapter process failed";
        this.setState("failed");
      }
    } catch (cause) {
      this.error = cause instanceof Error ? cause.message : String(cause);
      this.setState(signal?.aborted ? "interrupted" : "failed");
      if (cause instanceof AdapterError) throw cause;
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
  private onEvent(event: AdapterEvent): void {
    this.session.updatedAt = Date.now();
    if (event.state) this.state = event.state;
    if (event.error) this.error = event.error;
    publishAdapterEvent(event);
    for (const listener of this.listeners) listener(event);
  }
  private setState(state: AgentState): void {
    this.state = state;
    this.session.state = state;
    this.session.updatedAt = Date.now();
    const type =
      state === "completed"
        ? "agent.completed"
        : state === "failed"
          ? "agent.failed"
          : state === "interrupted"
            ? "session.interrupted"
            : state === "stopped"
              ? "session.stopped"
              : state === "starting"
                ? "session.started"
                : state === "running" && this.resume
                  ? "session.resumed"
                  : "assistant.message";
    const event = createAdapterEvent(
      { adapterId: this.adapter.id, sessionId: this.session.id },
      type,
      { state, error: this.error },
      ++this.sequence,
    );
    this.onEvent(event);
  }
  async interrupt(reason = "interrupted"): Promise<void> {
    if (this.state === "closed" || this.state === "stopped") return;
    await this.runtime.interrupt(reason);
    this.setState("interrupted");
  }
  async stop(reason = "stopped"): Promise<void> {
    if (this.state === "closed") return;
    await this.runtime.stop(reason);
    this.setState("stopped");
    this.setState("closed");
  }
  async wait(): Promise<AgentStateSnapshot> {
    if (this.running) await this.running.catch(() => undefined);
    return this.getState();
  }
  async getState(): Promise<AgentStateSnapshot> {
    return { state: this.state, error: this.error, updatedAt: this.session.updatedAt };
  }
  async getSession(): Promise<OsheepSession> {
    return this.session;
  }
  subscribeEvents(listener: AdapterEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
}
