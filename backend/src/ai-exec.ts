// Short-lived command execution and file-tool implementations used by
// osheep code (the AI agent). These are intentionally separate from the
// long-running PTY sessions in `pty.ts`: AI tool calls always finish or
// time out, never linger.

import { spawn } from "node:child_process";
import { platform } from "./config.js";
import { resolveWorkspacePath } from "./workspace.js";
import { errors } from "./errors.js";

export interface RunResult {
  command: string;
  cwd: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  truncated: boolean;
}

const MAX_OUTPUT = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_TIMEOUT_MS = 600_000;

function pickShell(requested?: string): { cmd: string; args: (script: string) => string[] } {
  if (platform === "windows") {
    if (requested === "cmd") {
      return {
        cmd: process.env.ComSpec ?? "cmd.exe",
        args: (s) => ["/d", "/s", "/c", s],
      };
    }
    return {
      cmd: "powershell.exe",
      args: (s) => ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", s],
    };
  }
  return { cmd: "/bin/bash", args: (s) => ["-lc", s] };
}

export async function execRun(
  workspaceRoot: string,
  command: string,
  cwdRel: string,
  timeoutMs: number,
  shellId?: string
): Promise<RunResult> {
  if (typeof command !== "string" || !command.trim()) {
    throw errors.invalidQuery("command 不能为空");
  }
  const absCwd = resolveWorkspacePath(workspaceRoot, cwdRel || "");
  const timeout = Math.min(
    Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
    MAX_TIMEOUT_MS
  );
  const { cmd, args } = pickShell(shellId);
  const start = Date.now();
  return await new Promise<RunResult>((resolve) => {
    const child = spawn(cmd, args(command), {
      cwd: absCwd,
      env: { ...process.env },
      windowsHide: true,
    });
    let stdout = "";
    let stderr = "";
    let truncated = false;
    let killed = false;
    let signal: NodeJS.Signals | null = null;

    const timer = setTimeout(() => {
      killed = true;
      signal = "SIGTERM";
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }, timeout);

    const cap = (chunk: Buffer, into: (s: string) => void, current: string) => {
      const text = chunk.toString("utf-8");
      const room = MAX_OUTPUT - current.length;
      if (room <= 0) {
        truncated = true;
        return;
      }
      if (text.length > room) {
        into(current + text.slice(0, room));
        truncated = true;
      } else {
        into(current + text);
      }
    };

    child.stdout.on("data", (b: Buffer) => cap(b, (s) => (stdout = s), stdout));
    child.stderr.on("data", (b: Buffer) => cap(b, (s) => (stderr = s), stderr));

    child.on("close", (code, sig) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: cwdRel || "",
        exitCode: killed ? null : code,
        signal: killed ? signal : (sig as NodeJS.Signals | null),
        durationMs: Date.now() - start,
        stdout,
        stderr,
        truncated,
      });
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      resolve({
        command,
        cwd: cwdRel || "",
        exitCode: null,
        signal: null,
        durationMs: Date.now() - start,
        stdout,
        stderr: stderr + (stderr ? "\n" : "") + `[spawn error] ${e.message}`,
        truncated,
      });
    });
  });
}
