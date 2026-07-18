// Short-lived command execution used by osheep code. These calls are
// intentionally separate from long-running PTY sessions: AI run tools always
// finish or time out, never linger.

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { platform } from "./config.js";
import { resolveWorkspacePath } from "./workspace.js";
import { errors } from "./errors.js";

type ShellId = "powershell" | "pwsh" | "cmd" | "bash";

interface ShellSpec {
  id: ShellId;
  cmd: string;
  args: (script: string) => string[];
}

export interface RunAttempt {
  shell: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface RunResult {
  command: string;
  cwd: string;
  shell: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
  attempts: RunAttempt[];
}

export interface RunLogEntry {
  stream: "stdout" | "stderr";
  content: string;
  shell: string;
}

export interface ExecRunOptions {
  signal?: AbortSignal;
  onLog?: (entry: RunLogEntry) => void;
}

const MAX_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

const POSIX_HINT_RE =
  /(^|\s)(grep|sed|awk|head|tail|xargs|printf)\b|(^|\s)find\s+\./i;
const SAFE_FALLBACK_HEADS = new Set([
  "cat",
  "dir",
  "echo",
  "find",
  "findstr",
  "grep",
  "head",
  "ls",
  "pwd",
  "rg",
  "tail",
  "type",
  "where",
]);

const SAFE_GIT_SUBCOMMANDS = new Set([
  "branch",
  "diff",
  "grep",
  "log",
  "remote",
  "rev-parse",
  "show",
  "status",
]);

function pathEntries(): string[] {
  return (process.env.PATH ?? "")
    .split(path.delimiter)
    .map((p) => p.trim())
    .filter(Boolean);
}

function findOnPath(names: string[]): string | null {
  const dirs = pathEntries();
  for (const dir of dirs) {
    for (const name of names) {
      const full = path.join(dir, name);
      try {
        if (fs.existsSync(full)) return full;
      } catch {
        /* ignore */
      }
    }
  }
  return null;
}

function findBash(): string | null {
  if (platform !== "windows") return "/bin/bash";
  return (
    findOnPath(["bash.exe", "bash"]) ??
    firstExisting([
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files\\Git\\usr\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe",
    ])
  );
}

function firstExisting(paths: string[]): string | null {
  for (const p of paths) {
    try {
      if (fs.existsSync(p)) return p;
    } catch {
      /* ignore */
    }
  }
  return null;
}

function shellSpec(id: ShellId): ShellSpec | null {
  if (platform !== "windows") {
    return {
      id: "bash",
      cmd: "/bin/bash",
      args: (s) => ["-lc", s],
    };
  }

  if (id === "cmd") {
    return {
      id,
      cmd: process.env.ComSpec ?? "cmd.exe",
      args: (s) => ["/d", "/s", "/c", `chcp 65001 >NUL & ${s}`],
    };
  }

  if (id === "bash") {
    const bash = findBash();
    if (!bash) return null;
    return {
      id,
      cmd: bash,
      args: (s) => ["-lc", s],
    };
  }

  const exe = id === "pwsh" ? "pwsh.exe" : "powershell.exe";
  return {
    id,
    cmd: exe,
    args: (s) => [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-ExecutionPolicy",
      "Bypass",
      "-Command",
      `[Console]::OutputEncoding=[System.Text.UTF8Encoding]::new(); $OutputEncoding=[System.Text.UTF8Encoding]::new(); ${s}`,
    ],
  };
}

function normalizeRequestedShell(requested?: string): ShellId | "auto" {
  const s = (requested ?? "auto").toLowerCase();
  if (s === "cmd" || s === "cmd.exe") return "cmd";
  if (s === "bash" || s === "git-bash" || s === "sh") return "bash";
  if (s === "pwsh" || s === "pwsh.exe") return "pwsh";
  if (s === "powershell" || s === "powershell.exe") return "powershell";
  return "auto";
}

function shellCandidates(command: string, requested?: string): ShellSpec[] {
  const wanted = normalizeRequestedShell(requested);
  if (wanted !== "auto") {
    const spec = shellSpec(wanted);
    return spec ? [spec] : [];
  }

  if (platform !== "windows") {
    const spec = shellSpec("bash");
    return spec ? [spec] : [];
  }

  const out: ShellSpec[] = [];
  const posixish = looksPosix(command);
  const bash = shellSpec("bash");
  const ps = shellSpec("powershell");
  const pwsh = shellSpec("pwsh");
  const cmd = shellSpec("cmd");

  if (posixish && bash) out.push(bash);
  if (ps) out.push(ps);
  if (pwsh) out.push(pwsh);
  if (cmd) out.push(cmd);
  if (!posixish && bash) out.push(bash);

  const seen = new Set<string>();
  return out.filter((s) => {
    const key = `${s.id}:${s.cmd}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function looksPosix(command: string): boolean {
  const trimmed = command.trim();
  return POSIX_HINT_RE.test(trimmed) || /^ls\s+-[a-z]*[al][a-z]*/i.test(trimmed);
}

function splitCommand(command: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: "'" | '"' | null = null;
  let escape = false;
  for (const ch of command.trim()) {
    if (escape) {
      cur += ch;
      escape = false;
      continue;
    }
    if (ch === "\\") {
      escape = true;
      cur += ch;
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      cur += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      cur += ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (cur) {
        out.push(cur);
        cur = "";
      }
      continue;
    }
    cur += ch;
  }
  if (cur) out.push(cur);
  return out;
}

function isSafeToFallback(command: string): boolean {
  const parts = splitCommand(command);
  const head = (parts[0] ?? "").toLowerCase();
  if (!head) return false;
  if (SAFE_FALLBACK_HEADS.has(head)) return true;
  if (head === "git") {
    const sub = (parts[1] ?? "").toLowerCase();
    if (sub === "remote" && parts[2] === "-v") return true;
    return SAFE_GIT_SUBCOMMANDS.has(sub);
  }
  return false;
}

function shouldTryNextShell(
  command: string,
  result: RunResult,
  attempted: number
): boolean {
  if (result.exitCode === 0) return false;
  if (attempted <= 0) return false;
  if (!isSafeToFallback(command)) return false;
  if (looksPosix(command)) return true;
  const text = `${result.stderr}\n${result.stdout}`.toLowerCase();
  return (
    text.includes("is not recognized") ||
    text.includes("not recognized as") ||
    text.includes("command not found") ||
    text.includes("parameter cannot be found") ||
    text.includes("missing an argument")
  );
}

async function runOnce(
  spec: ShellSpec,
  workspaceRoot: string,
  command: string,
  cwdRel: string,
  timeout: number,
  options: ExecRunOptions = {}
): Promise<RunResult> {
  const absCwd = resolveWorkspacePath(workspaceRoot, cwdRel || "");
  const start = Date.now();
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(spec.cmd, spec.args(command), {
      cwd: absCwd,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let killed = false;
    let signal: NodeJS.Signals | null = null;
    let settled = false;

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(result);
    };

    const timer = setTimeout(() => {
      killed = true;
      signal = "SIGTERM";
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeout);

    const onAbort = () => {
      killed = true;
      signal = "SIGTERM";
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    };

    if (options.signal?.aborted) {
      onAbort();
    } else {
      options.signal?.addEventListener("abort", onAbort, { once: true });
    }

    const cap = (chunk: Buffer, stream: "stdout" | "stderr") => {
      const text = chunk.toString("utf-8");
      const current = stream === "stdout" ? stdout : stderr;
      const room = MAX_OUTPUT - current.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      const captured = text.length > room ? text.slice(0, room) : text;
      if (stream === "stdout") {
        stdout = current + captured;
      } else {
        stderr = current + captured;
      }
      if (captured) {
        options.onLog?.({ stream, content: captured, shell: spec.id });
      }
      if (text.length > room) {
        truncated = true;
      }
    };

    child.stdout.on("data", (b: Buffer) => cap(b, "stdout"));
    child.stderr.on("data", (b: Buffer) => cap(b, "stderr"));

    child.on("close", (code, sig) => {
      finish({
        command,
        cwd: cwdRel || "",
        shell: spec.id,
        exitCode: killed ? null : code,
        signal: killed ? signal : (sig as NodeJS.Signals | null),
        durationMs: Date.now() - start,
        stdout,
        stderr,
        truncated,
        attempts: [],
      });
    });
    child.on("error", (e) => {
      const message = `[spawn error] ${e.message}`;
      stderr = stderr + (stderr ? "\n" : "") + message;
      options.onLog?.({ stream: "stderr", content: message, shell: spec.id });
      finish({
        command,
        cwd: cwdRel || "",
        shell: spec.id,
        exitCode: null,
        signal: null,
        durationMs: Date.now() - start,
        stdout,
        stderr,
        truncated,
        attempts: [],
      });
    });
  });
}

export async function execRun(
  workspaceRoot: string,
  command: string,
  cwdRel: string,
  timeoutMs: number,
  shellId?: string,
  options: ExecRunOptions = {}
): Promise<RunResult> {
  if (typeof command !== "string" || !command.trim()) {
    throw errors.invalidQuery("command cannot be empty");
  }
  // Validate cwd before spawning anything.
  resolveWorkspacePath(workspaceRoot, cwdRel || "");
  const timeout = Math.min(
    Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS
  );

  const candidates = shellCandidates(command, shellId);
  if (candidates.length === 0) {
    throw errors.invalidQuery(`requested shell is not available: ${shellId ?? "auto"}`);
  }

  const attempts: RunAttempt[] = [];
  let last: RunResult | null = null;
  for (let i = 0; i < candidates.length; i += 1) {
    const result = await runOnce(
      candidates[i]!,
      workspaceRoot,
      command,
      cwdRel,
      timeout,
      options
    );
    attempts.push({
      shell: result.shell,
      exitCode: result.exitCode,
      signal: result.signal,
      durationMs: result.durationMs,
    });
    last = { ...result, attempts: attempts.slice() };
    if (!shouldTryNextShell(command, result, candidates.length - i - 1)) {
      return last;
    }
  }
  return last!;
}
