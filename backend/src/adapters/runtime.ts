import { createAdapterEvent } from "./events.js";
import { SequenceAllocator } from "./jsonl-decoder.js";
import type {
  AdapterEvent,
  AdapterEventListener,
  AdapterEventMapper,
  AgentTransport,
  EventMapperContext,
  TransportProcess,
  TransportResult,
} from "./types.js";

export class AdapterRuntime {
  private readonly sequence = new SequenceAllocator();
  private readonly listeners = new Set<AdapterEventListener>();
  private process?: TransportProcess;
  private started = false;

  constructor(
    private readonly adapterId: string,
    private readonly sessionId: string,
    private readonly transport: AgentTransport,
    private readonly mapper: AdapterEventMapper,
  ) {}

  async start(
    input: Parameters<AgentTransport["start"]>[0],
    resumeSessionId?: string,
  ): Promise<void> {
    if (this.started) return;
    this.started = true;
    this.process = resumeSessionId
      ? await this.transport.resume({ ...input, sessionId: resumeSessionId })
      : await this.transport.start(input);
    this.process.subscribe((chunk) => this.onChunk(chunk.stream, chunk.text));
  }

  async send(prompt: string): Promise<void> {
    if (!this.process) throw new Error("Adapter runtime has not started");
    await this.process.send(prompt);
  }
  async interrupt(reason?: string): Promise<void> {
    await this.process?.interrupt(reason);
  }
  async stop(reason?: string): Promise<void> {
    await this.process?.stop(reason);
  }
  async wait(): Promise<TransportResult> {
    if (!this.process) return { exitCode: null, error: "Adapter runtime has not started" };
    const result = await this.process.wait();
    this.flush();
    return result;
  }
  subscribe(listener: AdapterEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private onChunk(stream: "stdout" | "stderr", text: string): void {
    if (stream === "stderr") {
      this.emit(
        createAdapterEvent(
          { adapterId: this.adapterId, sessionId: this.sessionId },
          "adapter.diagnostic",
          { message: redactDiagnostic(text) },
          this.sequence.next(),
        ),
      );
      return;
    }
    let rawEvents: unknown[];
    try {
      rawEvents = this.mapper.parse(text);
    } catch (error) {
      this.emit(
        createAdapterEvent(
          { adapterId: this.adapterId, sessionId: this.sessionId },
          "adapter.diagnostic",
          { message: error instanceof Error ? error.message : String(error) },
          this.sequence.next(),
        ),
      );
      return;
    }
    for (const raw of rawEvents) {
      const context: EventMapperContext = {
        adapterId: this.adapterId,
        sessionId: this.sessionId,
        nextSequence: () => this.sequence.next(),
      };
      for (const event of this.mapper.map(raw, context)) this.emit(event);
    }
  }

  private flush(): void {
    const context: EventMapperContext = {
      adapterId: this.adapterId,
      sessionId: this.sessionId,
      nextSequence: () => this.sequence.next(),
    };
    for (const event of this.mapper.flush?.(context) ?? []) this.emit(event);
  }

  private emit(event: AdapterEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Event observers are isolated from the adapter runtime.
      }
    }
  }
}

function redactDiagnostic(value: string): string {
  return value
    .replace(/(authorization\s*[:=]\s*bearer\s+)[^\s]+/gi, "$1[REDACTED]")
    .replace(/(api[_-]?key|token|secret|password)(\s*[:=]\s*)[^\s,;]+/gi, "$1$2[REDACTED]")
    .replace(/[A-Za-z]:\\[^\r\n\s]+/g, "[PATH]")
    .replace(/(?:^|\s)\/[^\r\n\s]+/g, " [PATH]")
    .slice(0, 8_000);
}
