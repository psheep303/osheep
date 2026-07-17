import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const CURSOR_OR_CLEAR_SEQUENCE = /\x1b\[[0-?]*[ -/]*[HfJ]/g;
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const CONVERSATION_WINDOW_CHARS = 96 * 1024;
const CONVERSATION_OVERLAP_CHARS = 16 * 1024;
const CONVERSATION_MAX_CHARS = 512 * 1024;

export class AgentTerminalConversationCollector {
  private readonly prompt: string;
  private readonly seen = new Set<string>();
  private readonly lines: string[] = [];
  private rawWindow = "";
  private lastFlushAt = 0;

  constructor(prompt = "") {
    this.prompt = prompt;
  }

  push(raw: string): void {
    if (!raw) return;
    this.rawWindow = (this.rawWindow + raw).slice(-CONVERSATION_WINDOW_CHARS);
    const now = Date.now();
    if (
      this.rawWindow.length >= CONVERSATION_WINDOW_CHARS ||
      now - this.lastFlushAt >= 400
    ) {
      this.flush();
    }
  }

  value(): string {
    this.flush(true);
    const joined = this.lines.join("\n").trim();
    return joined.length <= CONVERSATION_MAX_CHARS
      ? joined
      : joined.slice(-CONVERSATION_MAX_CHARS);
  }

  private flush(final = false): void {
    if (!this.rawWindow) return;
    for (const line of cleanAgentTerminalConversation(this.rawWindow, this.prompt).split("\n")) {
      const key = lineKey(line);
      if (!key || this.seen.has(key)) continue;
      this.seen.add(key);
      this.lines.push(line);
    }
    this.lastFlushAt = Date.now();
    this.rawWindow = final ? "" : this.rawWindow.slice(-CONVERSATION_OVERLAP_CHARS);
  }
}

export function cleanAgentTerminalConversation(raw: string, prompt = ""): string {
  if (!raw.trim()) return "";
  const promptLines = new Set(
    plainText(prompt)
      .split("\n")
      .map(lineKey)
      .filter(Boolean)
  );
  const seen = new Set<string>();
  const output: string[] = [];

  for (const sourceLine of plainText(raw).split("\n")) {
    const line = normalizeLine(sourceLine);
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = lineKey(trimmed);
    if (!key || promptLines.has(key) || isTerminalChrome(trimmed)) continue;
    if (isCursorFragment(trimmed) || seen.has(key)) continue;
    seen.add(key);
    output.push(line);
  }
  return output.join("\n").trim();
}

export function extractLastClaudeAnswer(conversation: string): string {
  const lines = conversation.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const trimmed = lines[index]!.trim();
    const match = trimmed.match(/^●\s*(.+)$/);
    if (!match || isClaudeToolHeading(match[1]!)) continue;
    const answer = [match[1]!, ...lines.slice(index + 1)]
      .filter((line) => !isTerminalChrome(line.trim()))
      .join("\n")
      .trim();
    if (answer) return answer;
  }
  return "";
}

export function extractLastStructuredClaudeAnswer(conversation: string): string {
  const blocks = structuredConversationBlocks(conversation);
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (blocks[index]!.label === "Claude") return blocks[index]!.content;
  }
  return "";
}

export function extractAgentRunMetadata(
  conversation: string,
  workspaceRoot: string
): { changedFiles: string[]; verification: string[] } {
  const changedFiles = new Set<string>();
  const verification = new Set<string>();
  const blocks = structuredConversationBlocks(conversation);

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (/^Tool · (?:Write|Edit|NotebookEdit)$/i.test(block.label)) {
      addChangedFile(changedFiles, block.content.split("\n")[0] ?? "", workspaceRoot);
    }
    if (/^Tool · Bash$/i.test(block.label) && isVerificationCommand(block.content)) {
      const result = blocks[index + 1];
      const resultText = result && /^Tool (?:result|error)$/.test(result.label)
        ? verificationResultSummary(result.content)
        : "";
      verification.add([block.content.trim(), resultText].filter(Boolean).join(" — "));
    }
  }

  for (const match of conversation.matchAll(/\]\(([^)\n]+)\)/g)) {
    addChangedFile(changedFiles, match[1] ?? "", workspaceRoot);
  }
  for (const match of conversation.matchAll(/`([^`\n]+[\\/][^`\n]+\.[A-Za-z0-9]{1,10})`/g)) {
    addChangedFile(changedFiles, match[1] ?? "", workspaceRoot);
  }

  const verificationSection = conversation.match(/(?:验证结果|Verification)\s*[:：]\s*([\s\S]+)$/i)?.[1];
  if (verificationSection) {
    for (const line of verificationSection.split("\n")) {
      const item = line.trim().replace(/^[-*]\s*/, "");
      if (item && /(?:passed|通过|成功|build|test|pytest|lint|typecheck)/i.test(item)) {
        verification.add(item);
      }
    }
  }

  return { changedFiles: [...changedFiles], verification: [...verification] };
}

interface StructuredConversationBlock {
  label: string;
  content: string;
}

function structuredConversationBlocks(conversation: string): StructuredConversationBlock[] {
  const headings = [
    ...conversation.matchAll(/^(User|Claude|Tool result|Tool error|Tool(?: · \S+)?):\n/gm),
  ];
  return headings.flatMap((heading, index) => {
    if (heading.index === undefined) return [];
    const start = heading.index + heading[0].length;
    const end = headings[index + 1]?.index ?? conversation.length;
    return [{ label: heading[1]!, content: conversation.slice(start, end).trim() }];
  });
}

function addChangedFile(target: Set<string>, rawPath: string, workspaceRoot: string): void {
  let value = rawPath.trim().replace(/^['"]|['"]$/g, "").replace(/:\d+(?::\d+)?$/, "");
  if (!value || /^https?:\/\//i.test(value)) return;
  value = value.replace(/\\/g, "/");
  const root = path.resolve(workspaceRoot);
  const absolute = path.isAbsolute(value) ? path.resolve(value) : path.resolve(root, value);
  const relative = path.relative(root, absolute).replace(/\\/g, "/");
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
  target.add(relative);
}

function isVerificationCommand(command: string): boolean {
  return /(?:^|\s)(?:pytest|py\.test|npm\s+(?:test|run\s+(?:test|build|lint|typecheck|check))|pnpm\s+(?:test|build|lint|typecheck)|yarn\s+(?:test|build|lint|typecheck)|cargo\s+(?:test|check)|go\s+test|dotnet\s+test|mvn\s+test|gradle\s+test|python\s+-m\s+(?:pytest|compileall)|tsc\b|eslint\b)/i.test(
    command
  );
}

function verificationResultSummary(result: string): string {
  const lines = result.split("\n").map((line) => line.trim()).filter(Boolean);
  return (
    lines.find((line) => /(?:\d+\s+passed|PASS|FAILED|error|success|built|exit code)/i.test(line)) ||
    lines.at(-1) ||
    ""
  ).slice(0, 240);
}

export async function readClaudeSessionConversation(sessionId: string): Promise<string> {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) return "";
  const home = os.homedir() || ".";
  const claudeHome = path.resolve(
    process.env.OSHEEP_CLAUDE_CONFIG_DIR ||
      process.env.CLAUDE_CONFIG_DIR ||
      path.join(home, ".claude")
  );
  const projectsRoot = path.join(claudeHome, "projects");
  let projectDirs;
  try {
    projectDirs = await fs.readdir(projectsRoot, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
  for (const projectDir of projectDirs) {
    if (!projectDir.isDirectory()) continue;
    const filePath = path.join(projectsRoot, projectDir.name, `${sessionId}.jsonl`);
    try {
      return formatClaudeJsonlConversation(await fs.readFile(filePath, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return "";
}

function formatClaudeJsonlConversation(jsonl: string): string {
  const blocks: string[] = [];
  for (const line of jsonl.split(/\r?\n/)) {
    if (!line.trim()) continue;
    let value: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      value = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    if (value.isMeta === true) continue;
    const message = objectValue(value.message);
    const role = stringValue(message.role);
    const content = message.content;
    const next = role === "assistant"
      ? formatClaudeAssistantContent(content)
      : role === "user"
        ? formatClaudeUserContent(content)
        : [];
    for (const block of next) {
      const normalized = block.trim();
      if (!normalized) continue;
      blocks.push(normalized);
    }
  }
  return blocks.join("\n\n").trim();
}

export function formatClaudeJsonlConversationForTest(jsonl: string): string {
  return formatClaudeJsonlConversation(jsonl);
}

function formatClaudeAssistantContent(content: unknown): string[] {
  if (typeof content === "string") return [`Claude:\n${cleanStructuredText(content)}`];
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const item of content) {
    const part = objectValue(item);
    const type = stringValue(part.type);
    if (type === "text") {
      const text = cleanStructuredText(stringValue(part.text));
      if (text) blocks.push(`Claude:\n${text}`);
    } else if (type === "tool_use") {
      const name = stringValue(part.name) || "tool";
      blocks.push(`Tool · ${name}:\n${formatToolInput(name, part.input)}`);
    }
  }
  return blocks;
}

function formatClaudeUserContent(content: unknown): string[] {
  if (typeof content === "string") {
    const text = cleanStructuredText(content);
    return text ? [`User:\n${text}`] : [];
  }
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const item of content) {
    const part = objectValue(item);
    if (stringValue(part.type) !== "tool_result") continue;
    const text = contentText(part.content);
    if (text) blocks.push(`${part.is_error === true ? "Tool error" : "Tool result"}:\n${text}`);
  }
  return blocks;
}

function formatToolInput(name: string, input: unknown): string {
  const value = objectValue(input);
  if (/^Bash$/i.test(name) && typeof value.command === "string") {
    return `$ ${value.command}`;
  }
  if (/^(?:Read|Write|Edit)$/i.test(name)) {
    const filePath = stringValue(value.file_path) || stringValue(value.path);
    if (filePath) return filePath;
  }
  try {
    return JSON.stringify(input ?? {}, null, 2);
  } catch {
    return String(input ?? "");
  }
}

function contentText(content: unknown): string {
  if (typeof content === "string") return cleanStructuredText(content);
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const part = objectValue(item);
      return cleanStructuredText(stringValue(part.text) || stringValue(part.content));
    })
    .filter(Boolean)
    .join("\n");
}

function cleanStructuredText(value: string): string {
  return value
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gi, "")
    .replace(/<environment_context>[\s\S]*?<\/environment_context>/gi, "")
    .replace(/\r/g, "")
    .trim();
}

function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function plainText(value: string): string {
  return value
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(CURSOR_OR_CLEAR_SEQUENCE, "\n")
    .replace(ANSI_SEQUENCE, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "")
    .replace(/\r/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, "");
}

function normalizeLine(value: string): string {
  const line = value.replace(/\s+$/g, "");
  const leading = line.match(/^\s*/)?.[0].length ?? 0;
  return `${" ".repeat(Math.min(leading, 6))}${line.trimStart()}`;
}

function lineKey(value: string): string {
  return value.trim().replace(/\s+/g, " ");
}

function isClaudeToolHeading(value: string): boolean {
  return /^(?:Bash|Read|Write|Edit|Glob|Grep|Plan|Task|WebFetch|WebSearch|Skill|Agent)\b(?:\(|$)/i.test(
    value.trim()
  );
}

function isTerminalChrome(line: string): boolean {
  if (/^[─━═_\-\s]{8,}$/.test(line)) return true;
  if (/^[❯›]\s*(?:\S.*)?$/.test(line)) return true;
  if (/\b(?:auto|plan) mode on\b/i.test(line)) return true;
  if (/shift\+tab to cycle|←\s*for agents|\/effort\b/i.test(line)) return true;
  if (/^Tip:\s|\/btw\b|interrupting Claude(?:'s|’s) current/i.test(line)) return true;
  if (/^work$/i.test(line)) return true;
  if (/Tell Claude what to change/i.test(line)) return true;
  if (/shift\+tab to approve with this feedback/i.test(line)) return true;
  if (/ctrl\+g to edit|Notepad\.exe|\.claude[\\/]plans[\\/]/i.test(line)) return true;
  if (/ctrl\+b to run in background/i.test(line)) return true;
  if (/Allowed by auto mode classifier/i.test(line)) return true;
  if (/(?:Thought|Thinking) for \d+s/i.test(line)) return true;
  if (/\bthinking with (?:low|medium|high) effort\b/i.test(line)) return true;
  if (/^(?:Inspecting|Evaluating|Considering|Preparing|Deciding|Confirming)\b/i.test(line)) {
    return true;
  }
  if (/^(?:OpenAI Codex|Claude Code)\b/i.test(line)) return true;
  if (/^(?:cwd|directory|model)\s*:/i.test(line)) return true;
  if (/^\s*[◯◼✔]\s+/i.test(line)) return true;
  if (/^\s*●\s+(?:main|Plan)\b/i.test(line)) return true;
  if (/Initializing…|esc to interrupt/i.test(line)) return true;
  if (/^[✻✶✽✢·*]\s*/.test(line)) return true;
  if (/\b(?:Flambéing|Cooked)\b.*(?:tokens|\d+[ms])/i.test(line)) return true;
  if (/^\(?thinking with (?:low|medium|high) effort\)?$/i.test(line)) return true;
  return false;
}

function isCursorFragment(line: string): boolean {
  if (line.length <= 3) return true;
  if (/^[\d\s).·…↓↑]+$/.test(line)) return true;
  if (/^[,)]/.test(line)) return true;
  if (/^\d*(?:ought|hinking)\b/i.test(line)) return true;
  if (/^(?:mbé|lambé|inking|frming)\b/i.test(line)) return true;
  return /^[A-Za-zÀ-ÿ]{1,12}$/.test(line);
}
