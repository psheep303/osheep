const CURSOR_OR_CLEAR_SEQUENCE = /\x1b\[[0-?]*[ -/]*[HfJ]/g;
const ANSI_SEQUENCE = /\x1b\[[0-?]*[ -/]*[@-~]/g;

export function cleanAgentTerminalConversation(raw: string): string {
  if (!raw.trim()) return "";
  const seen = new Set<string>();
  const output: string[] = [];

  for (const sourceLine of plainText(raw).split("\n")) {
    const line = normalizeLine(sourceLine);
    const trimmed = line.trim();
    if (!trimmed) continue;
    const key = lineKey(trimmed);
    if (!key || isTerminalChrome(trimmed) || isCursorFragment(trimmed) || seen.has(key)) {
      continue;
    }
    seen.add(key);
    output.push(line);
  }
  return output.join("\n").trim();
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
