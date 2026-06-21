import { spawn } from "node:child_process";
import { platform } from "./config.js";

export type CliProviderKind = "claude-cli" | "codex-cli";

export interface CliChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_call_id?: string;
}

export interface CliChatOptions {
  kind: CliProviderKind;
  workspaceRoot: string;
  model: string;
  messages: CliChatMessage[];
  signal?: AbortSignal;
  onDelta?: (chunk: string) => void;
}

export interface CliChatResult {
  content: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
}

const CLI_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_STDERR = 128 * 1024;

export function isCliProviderKind(kind: string): kind is CliProviderKind {
  return kind === "claude-cli" || kind === "codex-cli";
}

export function cliModelShortcuts(kind: CliProviderKind): string[] {
  if (kind === "claude-cli") return ["default", "sonnet", "opus"];
  return ["default", "gpt-5.1-codex", "gpt-5.1", "gpt-5"];
}

export async function runCliChat(opts: CliChatOptions): Promise<CliChatResult> {
  const invocation = normalizeInvocation(buildInvocation(opts.kind, opts.model));
  const prompt = buildPrompt(opts.kind, opts.messages);
  const parser = new CliOutputParser(opts.onDelta);

  return await new Promise<CliChatResult>((resolve, reject) => {
    const child = spawn(invocation.command, invocation.args, {
      cwd: opts.workspaceRoot,
      env: {
        ...process.env,
        CI: process.env.CI ?? "1",
        NO_COLOR: "1",
        FORCE_COLOR: "0",
      },
      windowsHide: true,
    });

    let stderr = "";
    let settled = false;
    let killedByAbort = false;

    const cleanup = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn();
    };

    const onAbort = () => {
      killedByAbort = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };

    const timer = setTimeout(() => {
      killedByAbort = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, CLI_TIMEOUT_MS);

    opts.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      parser.feed(chunk.toString("utf-8"));
    });

    child.stderr.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf-8");
      const room = MAX_STDERR - stderr.length;
      if (room <= 0) return;
      stderr += text.length > room ? text.slice(0, room) : text;
    });

    child.on("error", (e) => {
      settle(() => reject(e));
    });

    child.on("close", (code, sig) => {
      parser.finish();
      const parsedContent = parser.content();
      settle(() => {
        const content = parsedContent || stderr.trim();
        if (killedByAbort || opts.signal?.aborted) {
          resolve({ content, stderr, exitCode: null, signal: "SIGTERM" });
          return;
        }
        if (code !== 0) {
          const detail = stderr.trim() || content.trim() || `exit code ${code}`;
          reject(new Error(`${labelFor(opts.kind)} failed: ${detail}`));
          return;
        }
        resolve({ content, stderr, exitCode: code, signal: sig as NodeJS.Signals | null });
      });
    });

    child.stdin.on("error", () => {
      /* child may exit before it reads stdin */
    });
    child.stdin.end(prompt);
  });
}

function buildInvocation(
  kind: CliProviderKind,
  model: string
): { command: string; args: string[] } {
  const useModel = model && model !== "default";
  if (kind === "claude-cli") {
    const args = [
      "-p",
      "--output-format",
      "stream-json",
      "--include-partial-messages",
      "--permission-mode",
      "acceptEdits",
    ];
    if (useModel) args.push("--model", model);
    return { command: platform === "windows" ? "claude.exe" : "claude", args };
  }

  const args = [
    "exec",
    "--json",
    "--full-auto",
    "--skip-git-repo-check",
    "--color",
    "never",
  ];
  if (useModel) args.push("--model", model);
  args.push("-");
  return { command: platform === "windows" ? "codex.cmd" : "codex", args };
}

function normalizeInvocation(invocation: {
  command: string;
  args: string[];
}): { command: string; args: string[] } {
  if (
    platform === "windows" &&
    /\.(?:cmd|bat)$/i.test(invocation.command)
  ) {
    return {
      command: process.env.ComSpec ?? "cmd.exe",
      args: ["/d", "/s", "/c", invocation.command, ...invocation.args],
    };
  }
  return invocation;
}

function buildPrompt(kind: CliProviderKind, messages: CliChatMessage[]): string {
  const head = [
    `You are being invoked by osheep through ${labelFor(kind)}.`,
    "The current working directory is the project root.",
    "Use the CLI's native file, shell, and reasoning capabilities directly.",
    "Do not emit osheep XML tool tags such as <tasks>, <thought>, <tool>, <ask>, or <verify>.",
    "Reply in the user's language. Keep the final response concise and include verification results when available.",
  ].join("\n");
  const transcript = messages
    .map((m) => {
      const role = m.role === "tool" ? `tool:${m.tool_call_id ?? "result"}` : m.role;
      return `### ${role}\n${m.content}`;
    })
    .join("\n\n");
  return `${head}\n\n${transcript}\n`;
}

function labelFor(kind: CliProviderKind): string {
  return kind === "claude-cli" ? "Claude Code CLI" : "Codex CLI";
}

class CliOutputParser {
  private lineBuffer = "";
  private acc = "";
  private plain = "";
  private lastAssistant = "";
  private finalText = "";
  private fallbackText = "";
  private emittedStructured = false;

  constructor(private readonly onDelta?: (chunk: string) => void) {}

  feed(chunk: string): void {
    this.lineBuffer += chunk;
    let nl: number;
    while ((nl = this.lineBuffer.indexOf("\n")) !== -1) {
      const line = this.lineBuffer.slice(0, nl).replace(/\r$/, "");
      this.lineBuffer = this.lineBuffer.slice(nl + 1);
      this.handleLine(line);
    }
  }

  finish(): void {
    const rest = this.lineBuffer.trim();
    if (rest) this.handleLine(rest);
    this.lineBuffer = "";
    if (!this.acc && this.finalText) {
      this.emit(this.finalText);
    } else if (!this.acc && this.fallbackText.trim()) {
      this.emit(this.fallbackText.trim());
    } else if (!this.acc && this.plain.trim()) {
      this.emit(this.plain.trim());
    }
  }

  content(): string {
    return this.acc;
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      this.emittedStructured = true;
      const obj = objectValue(parsed);
      if (!obj) {
        const text = textFromUnknown(parsed);
        if (text) this.rememberFallback(text);
        return;
      }
      this.handleObject(obj);
    } catch {
      if (!this.emittedStructured) {
        this.plain += (this.plain ? "\n" : "") + line;
      }
    }
  }

  private handleObject(obj: Record<string, unknown>): void {
    const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
    const delta = deltaText(obj, type);
    if (delta) {
      this.emit(delta);
      return;
    }

    const assistant = assistantText(obj, type);
    if (assistant) {
      this.emitAssistantSuffix(assistant);
    }

    const final = finalResultText(obj, type);
    if (final) {
      this.finalText = final;
    }

    const fallback = looseOutputText(obj, type);
    if (fallback) {
      if (isAssistantMessageEvent(type)) {
        this.emitAssistantSuffix(fallback);
      } else {
        this.rememberFallback(fallback);
      }
    }
  }

  private emitAssistantSuffix(text: string): void {
    if (!text) return;
    if (text.startsWith(this.lastAssistant)) {
      this.emit(text.slice(this.lastAssistant.length));
    } else if (!this.lastAssistant.endsWith(text)) {
      this.emit(text);
    }
    this.lastAssistant = text;
  }

  private emit(chunk: string): void {
    if (!chunk) return;
    this.acc += chunk;
    this.onDelta?.(chunk);
  }

  private rememberFallback(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (!this.fallbackText) {
      this.fallbackText = trimmed;
    } else if (!this.fallbackText.includes(trimmed)) {
      this.fallbackText += "\n" + trimmed;
    }
  }
}

function deltaText(obj: Record<string, unknown>, type: string): string {
  if (!type.includes("delta")) return "";
  return textFromUnknown(obj.delta) || textFromUnknown(obj.message) || textFromUnknown(obj);
}

function assistantText(obj: Record<string, unknown>, type: string): string {
  const role = typeof obj.role === "string" ? obj.role : "";
  if (role === "assistant") return textFromUnknown(obj.content) || textFromUnknown(obj);
  if (isAssistantMessageEvent(type)) {
    return (
      textFromUnknown(obj.message) ||
      textFromUnknown(obj.text) ||
      textFromUnknown(obj.content) ||
      textFromUnknown(obj.item) ||
      textFromUnknown(obj)
    );
  }
  if (type.includes("assistant")) {
    return textFromUnknown(obj.message) || textFromUnknown(obj.item) || textFromUnknown(obj);
  }
  const message = objectValue(obj.message);
  if (message && message.role === "assistant") {
    return textFromUnknown(message.content) || textFromUnknown(message);
  }
  const item = objectValue(obj.item);
  if (item && item.role === "assistant") {
    return textFromUnknown(item.content) || textFromUnknown(item);
  }
  return "";
}

function isAssistantMessageEvent(type: string): boolean {
  return (
    type === "agent_message" ||
    type === "assistant_message" ||
    type.endsWith(".agent_message") ||
    type.endsWith(".assistant_message") ||
    type.includes("message.delta") ||
    type.includes("message.completed")
  );
}

function finalResultText(obj: Record<string, unknown>, type: string): string {
  if (
    !(
      type.includes("result") ||
      type.includes("final") ||
      type.includes("completed") ||
      type.includes("turn.end")
    )
  ) {
    return "";
  }
  return (
    textFromUnknown(obj.result) ||
    textFromUnknown(obj.final_response) ||
    textFromUnknown(obj.last_agent_message) ||
    textFromUnknown(obj.last_assistant_message) ||
    textFromUnknown(obj.last_message) ||
    textFromUnknown(obj.output) ||
    textFromUnknown(obj.message) ||
    textFromUnknown(obj.content)
  );
}

function looseOutputText(obj: Record<string, unknown>, type: string): string {
  if (type.includes("reasoning")) return "";
  const direct =
    textFromUnknown(obj.last_agent_message) ||
    textFromUnknown(obj.last_assistant_message) ||
    textFromUnknown(obj.final_response) ||
    textFromUnknown(obj.response) ||
    textFromUnknown(obj.output) ||
    textFromUnknown(obj.message) ||
    textFromUnknown(obj.content) ||
    textFromUnknown(obj.text);
  if (direct) return direct;

  const item = objectValue(obj.item);
  if (item && isAssistantLike(item)) {
    return textFromUnknown(item.content) || textFromUnknown(item.message) || textFromUnknown(item);
  }
  const payload = objectValue(obj.payload);
  if (payload && isAssistantLike(payload)) {
    return (
      textFromUnknown(payload.content) ||
      textFromUnknown(payload.message) ||
      textFromUnknown(payload)
    );
  }
  return "";
}

function isAssistantLike(obj: Record<string, unknown>): boolean {
  const role = typeof obj.role === "string" ? obj.role.toLowerCase() : "";
  const type = typeof obj.type === "string" ? obj.type.toLowerCase() : "";
  return role === "assistant" || type === "message" || type.includes("assistant");
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function textFromUnknown(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value.map(textFromUnknown).filter(Boolean).join("");
  }
  const obj = objectValue(value);
  if (!obj) return "";

  const type = typeof obj.type === "string" ? obj.type : "";
  if (
    (type === "text" || type === "output_text" || type === "input_text") &&
    typeof obj.text === "string"
  ) {
    return obj.text;
  }
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) return textFromUnknown(obj.content);
  if (obj.content !== undefined) return textFromUnknown(obj.content);
  if (obj.message !== undefined) return textFromUnknown(obj.message);
  if (obj.msg !== undefined) return textFromUnknown(obj.msg);
  if (typeof obj.delta === "string") return obj.delta;
  if (typeof obj.result === "string") return obj.result;
  if (obj.output !== undefined) return textFromUnknown(obj.output);
  if (obj.response !== undefined) return textFromUnknown(obj.response);
  if (obj.last_agent_message !== undefined) {
    return textFromUnknown(obj.last_agent_message);
  }
  if (obj.last_assistant_message !== undefined) {
    return textFromUnknown(obj.last_assistant_message);
  }
  return "";
}
