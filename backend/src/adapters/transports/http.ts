import { AdapterError } from "../errors.js";
import type {
  AgentTransport,
  TransportChunk,
  TransportProcess,
  TransportResult,
  TransportResumeInput,
  TransportStartInput,
} from "../types.js";

export interface HttpTransportOptions {
  url: string | ((input: TransportStartInput | TransportResumeInput) => string);
  headers?: Record<string, string>;
  method?: string;
  body?: (
    input: TransportStartInput | TransportResumeInput,
    prompt?: string,
  ) => string | Uint8Array | undefined;
  fetch?: typeof globalThis.fetch;
}

export class HttpTransport implements AgentTransport {
  constructor(private readonly options: HttpTransportOptions) {}
  start(input: TransportStartInput): Promise<TransportProcess> {
    return this.open(input);
  }
  resume(input: TransportResumeInput): Promise<TransportProcess> {
    return this.open(input);
  }

  private async open(input: TransportStartInput | TransportResumeInput): Promise<TransportProcess> {
    const request = this.options.fetch ?? globalThis.fetch;
    const url = typeof this.options.url === "function" ? this.options.url(input) : this.options.url;
    const response = await request(url, {
      method: this.options.method ?? "POST",
      headers: { accept: "text/event-stream, application/jsonl", ...this.options.headers },
      body: this.options.body?.(input),
      signal: input.signal,
    });
    if (!response.ok) throw new Error(`HTTP transport failed: ${response.status}`);
    return new HttpProcess(response);
  }
}

class HttpProcess implements TransportProcess {
  private readonly listeners = new Set<(chunk: TransportChunk) => void>();
  private readonly completion: Promise<TransportResult>;
  constructor(private readonly response: Response) {
    this.completion = this.read();
  }
  async send(): Promise<void> {
    throw new AdapterError("UNSUPPORTED", "HTTP streaming transport does not support in-band send");
  }
  async interrupt(): Promise<void> {
    await this.stop("interrupted");
  }
  async stop(_reason?: string): Promise<void> {
    await this.response.body?.cancel();
  }
  subscribe(listener: (chunk: TransportChunk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  wait(): Promise<TransportResult> {
    return this.completion;
  }
  private async read(): Promise<TransportResult> {
    if (!this.response.body) return { exitCode: 0 };
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        const text = decoder.decode(next.value, { stream: true });
        const chunk = { stream: "stdout" as const, text, timestamp: Date.now() };
        for (const listener of this.listeners) listener(chunk);
      }
      return { exitCode: 0 };
    } catch (error) {
      return { exitCode: null, error: error instanceof Error ? error.message : String(error) };
    }
  }
}
