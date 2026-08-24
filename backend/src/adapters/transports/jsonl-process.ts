import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { AdapterError } from "../errors.js";
import type {
  AgentTransport,
  TransportChunk,
  TransportProcess,
  TransportResult,
  TransportResumeInput,
  TransportStartInput,
} from "../types.js";

export interface ProcessTransportOptions {
  command: string;
  args?: string[];
  env?: Record<string, string | undefined>;
  shell?: boolean;
  resumeArgs?: (sessionId: string) => string[];
}

export class JsonlProcessTransport implements AgentTransport {
  constructor(private readonly options: ProcessTransportOptions) {}

  start(input: TransportStartInput = {}): Promise<TransportProcess> {
    return Promise.resolve(this.spawnProcess(input));
  }

  resume(input: TransportResumeInput): Promise<TransportProcess> {
    const extra = this.options.resumeArgs?.(input.sessionId) ?? [];
    return Promise.resolve(this.spawnProcess(input, extra));
  }

  private spawnProcess(input: TransportStartInput, extraArgs: string[] = []): TransportProcess {
    const child = spawn(
      input.command ?? this.options.command,
      [...(this.options.args ?? []), ...(input.args ?? []), ...extraArgs],
      {
        cwd: input.cwd,
        env: { ...process.env, ...this.options.env, ...input.env },
        shell: input.command ? this.options.shell : false,
        stdio: "pipe",
      },
    );
    return new ChildProcessTransport(child);
  }
}

class ChildProcessTransport implements TransportProcess {
  private readonly listeners = new Set<(chunk: TransportChunk) => void>();
  private readonly completion: Promise<TransportResult>;
  private settled = false;

  constructor(private readonly child: ChildProcessWithoutNullStreams) {
    child.stdout.on("data", (data: Buffer | string) => this.emit("stdout", data.toString()));
    child.stderr.on("data", (data: Buffer | string) => this.emit("stderr", data.toString()));
    this.completion = new Promise((resolve) => {
      child.once("error", (error) => {
        this.settled = true;
        resolve({ exitCode: null, error: error.message });
      });
      child.once("close", (exitCode, signal) => {
        this.settled = true;
        resolve({ exitCode, signal: signal ?? undefined });
      });
    });
  }

  async send(input: string): Promise<void> {
    if (this.settled || !this.child.stdin.writable) {
      throw new AdapterError("SEND_FAILED", "Transport process is not writable", {
        retryable: false,
      });
    }
    await new Promise<void>((resolve, reject) => {
      this.child.stdin.write(input.endsWith("\n") ? input : `${input}\n`, (error) =>
        error ? reject(error) : resolve(),
      );
    });
  }

  async interrupt(): Promise<void> {
    if (!this.settled) this.child.kill("SIGINT");
  }

  async stop(): Promise<void> {
    if (!this.settled) this.child.kill();
  }

  subscribe(listener: (chunk: TransportChunk) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  wait(): Promise<TransportResult> {
    return this.completion;
  }

  private emit(stream: TransportChunk["stream"], text: string): void {
    const chunk = { stream, text, timestamp: Date.now() } satisfies TransportChunk;
    for (const listener of this.listeners) {
      try {
        listener(chunk);
      } catch {
        // A diagnostic observer must not break the process transport.
      }
    }
  }
}
