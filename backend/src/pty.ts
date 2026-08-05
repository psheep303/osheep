import { randomBytes } from "node:crypto";
import * as path from "node:path";
import * as nodePty from "node-pty";
import { config, platform } from "./config.js";
import { errors } from "./errors.js";
import { buildBashGuard, buildCmdGuard, buildPowerShellGuard } from "./pty-guard.js";
import { findExecutable } from "./runtime-tools.js";
import type { WorkspaceInfo } from "./workspace.js";

export interface ShellProfile {
  id: string;
  label: string;
  executable: string;
  args: string[];
}

export interface TerminalSession {
  id: string;
  workspaceId: string;
  shell: string;
  cols: number;
  rows: number;
  createdAt: number;
  pty: nodePty.IPty;
  lastActivity: number;
  // Buffered output that arrived before any WS attached or between attaches.
  scrollback: string;
  // Currently attached WS sink (single attach per session for MVP).
  sink: ((frame: string) => void) | null;
  taps: Set<(frame: string) => void>;
  idleTimer: NodeJS.Timeout | null;
  // Logical cwd inside the workspaces root, updated when we recognize a `cd`.
  // Best-effort: covers plain `cd <path>` / `chdir` / `Set-Location` / `pushd`.
  logicalCwd: string;
  workspacesRoot: string;
  // Buffer of printable chars typed since the last newline. Used to peek the
  // command line before it's sent to the PTY.
  inputBuffer: string;
  // True if any control sequence (arrow keys, tab, ESC...) appeared in this
  // line — at that point we can't trust the buffer matches the visible line,
  // so we skip the boundary check for this Enter.
  bufferDirty: boolean;
  // Tear down per-session shell-init temp files when the session ends.
  guardCleanup: (() => void) | null;
  killOnDetach: boolean;
}

const sessions = new Map<string, TerminalSession>();
let cachedProfiles: ShellProfile[] | null = null;

export function detectProfiles(): ShellProfile[] {
  const profiles: ShellProfile[] = [];
  if (platform === "windows") {
    const pwsh = findExecutable("powershell");
    if (pwsh) {
      profiles.push({
        id: "powershell",
        label: "PowerShell",
        executable: pwsh,
        args: ["-NoLogo"],
      });
    }
    const cmd = findExecutable("cmd");
    if (cmd) {
      profiles.push({ id: "cmd", label: "Command Prompt", executable: cmd, args: [] });
    }
    const gitBashCandidates = [
      "C:\\Program Files\\Git\\bin\\bash.exe",
      "C:\\Program Files (x86)\\Git\\bin\\bash.exe",
    ];
    const gitBash = gitBashCandidates.find((candidate) => findExecutable(candidate));
    if (gitBash) {
      profiles.push({
        id: "bash",
        label: "Git Bash",
        executable: gitBash,
        args: ["--login", "-i"],
      });
    }
  } else {
    const bash = findExecutable("bash");
    if (bash) profiles.push({ id: "bash", label: "bash", executable: bash, args: [] });
    const zsh = findExecutable("zsh");
    if (zsh) profiles.push({ id: "zsh", label: "zsh", executable: zsh, args: [] });
  }
  return profiles;
}

export function getProfiles(): ShellProfile[] {
  if (!cachedProfiles) cachedProfiles = detectProfiles();
  return cachedProfiles;
}

export function findProfile(id: string): ShellProfile | null {
  return getProfiles().find((p) => p.id === id) ?? null;
}

function newSessionId(): string {
  return `t_${randomBytes(4).toString("hex")}`;
}

function clampSize(n: unknown, fallback: number): number {
  const v = typeof n === "number" ? n : Number.parseInt(String(n ?? ""), 10);
  if (!Number.isFinite(v)) return fallback;
  if (v < 1 || v > 1000) throw errors.invalidSize();
  return Math.floor(v);
}

function bumpActivity(s: TerminalSession) {
  s.lastActivity = Date.now();
  if (s.idleTimer) clearTimeout(s.idleTimer);
  if (config.terminalIdleTimeoutMs > 0) {
    s.idleTimer = setTimeout(() => {
      killSession(s.id, "idle-timeout");
    }, config.terminalIdleTimeoutMs);
  }
}

export interface CreateSessionInput {
  workspace: WorkspaceInfo;
  shell: string;
  cols: number;
  rows: number;
  killOnDetach?: boolean;
  guardRoot?: string;
}

export function createSession(input: CreateSessionInput): TerminalSession {
  if (sessions.size >= config.maxTerminalSessions) {
    throw errors.tooManySessions(config.maxTerminalSessions);
  }
  const profile = findProfile(input.shell);
  if (!profile) throw errors.unsupportedShell(input.shell);

  const cols = clampSize(input.cols, 80);
  const rows = clampSize(input.rows, 24);

  // Build shell-level guard if supported. The guard returns args to spawn with
  // and a cleanup to call when the session ends.
  const workspacesRootAbs = path.resolve(input.guardRoot ?? config.workspacesRoot);
  const initialCwd = path.resolve(input.workspace.path);
  let spawnArgs = profile.args;
  let guardCleanup: (() => void) | null = null;
  try {
    if (profile.id === "powershell") {
      const g = buildPowerShellGuard(profile.args, workspacesRootAbs, initialCwd);
      spawnArgs = g.args;
      guardCleanup = g.cleanup;
    } else if (profile.id === "cmd") {
      const g = buildCmdGuard(profile.args, workspacesRootAbs, initialCwd);
      spawnArgs = g.args;
      guardCleanup = g.cleanup;
    } else if (profile.id === "bash" || profile.id === "zsh") {
      const g = buildBashGuard(profile.args, workspacesRootAbs, initialCwd);
      spawnArgs = g.args;
      guardCleanup = g.cleanup;
    }
    // No shell-level guard available beyond the three above; the input-buffer
    // heuristic in handleInputData remains as fallback.
  } catch {
    // If guard generation fails (e.g., tmp write), fall back silently.
    spawnArgs = profile.args;
    guardCleanup = null;
  }

  let pty: nodePty.IPty;
  try {
    pty = nodePty.spawn(profile.executable, spawnArgs, {
      name: "xterm-256color",
      cols,
      rows,
      cwd: input.workspace.path,
      env: { ...process.env },
    });
  } catch (e) {
    if (guardCleanup) guardCleanup();
    throw errors.ptySpawnFailed((e as Error).message);
  }

  const session: TerminalSession = {
    id: newSessionId(),
    workspaceId: input.workspace.id,
    shell: input.shell,
    cols,
    rows,
    createdAt: Date.now(),
    pty,
    lastActivity: Date.now(),
    scrollback: "",
    sink: null,
    taps: new Set(),
    idleTimer: null,
    logicalCwd: initialCwd,
    workspacesRoot: workspacesRootAbs,
    inputBuffer: "",
    bufferDirty: false,
    guardCleanup,
    killOnDetach: input.killOnDetach !== false,
  };
  sessions.set(session.id, session);
  bumpActivity(session);

  pty.onData((data) => {
    bumpActivity(session);
    const frame = JSON.stringify({ type: "output", data });
    for (const tap of session.taps) tap(frame);
    if (session.sink) {
      session.sink(frame);
    } else {
      // Keep a bounded buffer so a slightly-delayed WS still sees the prompt.
      const MAX = 64 * 1024;
      session.scrollback = (session.scrollback + data).slice(-MAX);
    }
  });
  pty.onExit(({ exitCode, signal }) => {
    const frame = JSON.stringify({ type: "exit", code: exitCode, signal: signal ?? null });
    for (const tap of session.taps) tap(frame);
    if (session.sink) session.sink(frame);
    cleanupSession(session, "pty-exit");
  });
  return session;
}

export function getSession(id: string): TerminalSession {
  const s = sessions.get(id);
  if (!s) throw errors.sessionNotFound(id);
  return s;
}

export function listSessions(): Pick<
  TerminalSession,
  "id" | "workspaceId" | "shell" | "cols" | "rows" | "createdAt"
>[] {
  return Array.from(sessions.values()).map((s) => ({
    id: s.id,
    workspaceId: s.workspaceId,
    shell: s.shell,
    cols: s.cols,
    rows: s.rows,
    createdAt: s.createdAt,
  }));
}

export function killSession(id: string, reason: string): void {
  const s = sessions.get(id);
  if (!s) return;
  try {
    if (s.sink) {
      s.sink(JSON.stringify({ type: "error", message: `session killed: ${reason}` }));
    }
    s.pty.kill();
  } catch {
    /* ignore */
  }
  cleanupSession(s, reason);
}

function cleanupSession(s: TerminalSession, _reason: string): void {
  if (s.idleTimer) clearTimeout(s.idleTimer);
  s.idleTimer = null;
  if (s.sink) {
    // The caller of the sink is expected to close their WS after `exit` or `error`.
    s.sink = null;
  }
  if (s.guardCleanup) {
    try {
      s.guardCleanup();
    } catch {
      /* ignore */
    }
    s.guardCleanup = null;
  }
  sessions.delete(s.id);
}

export function attachSink(
  s: TerminalSession,
  sink: (frame: string) => void,
): { detach: () => void; replayed: string } {
  s.sink = sink;
  const replayed = s.scrollback;
  s.scrollback = "";
  return {
    detach: () => {
      if (s.sink === sink) s.sink = null;
    },
    replayed,
  };
}

export function addTap(
  s: TerminalSession,
  tap: (frame: string) => void,
): { detach: () => void; replayed: string } {
  s.taps.add(tap);
  const replayed = s.scrollback;
  return {
    detach: () => {
      s.taps.delete(tap);
    },
    replayed,
  };
}

export function writeInput(s: TerminalSession, data: string): void {
  bumpActivity(s);
  handleInputData(s, data);
}

export function writeRawInput(s: TerminalSession, data: string): void {
  bumpActivity(s);
  s.pty.write(data);
}

// ─── Workspace boundary enforcement for `cd` ───

const CD_RE = /^(?:cd|chdir|sl|set-location|pushd)\b(?:\s+\/d)?\s+([^;|&`$\n]+?)\s*$/i;

function parseCdTarget(line: string): string | null {
  const stripped = line.replace(/^\s+/, "");
  if (!stripped) return null;
  const m = stripped.match(CD_RE);
  if (!m) return null;
  let target = m[1].trim();
  if (
    (target.startsWith('"') && target.endsWith('"')) ||
    (target.startsWith("'") && target.endsWith("'"))
  ) {
    target = target.slice(1, -1);
  }
  if (!target) return null;
  return target;
}

function isWithinWorkspacesRoot(p: string, root: string): boolean {
  const np = path.resolve(p);
  const nr = path.resolve(root);
  if (process.platform === "win32") {
    // Case-insensitive on Windows
    const lp = np.toLowerCase();
    const lr = nr.toLowerCase();
    if (lp === lr) return true;
    return lp.startsWith(lr + path.sep);
  }
  if (np === nr) return true;
  return np.startsWith(nr + path.sep);
}

function sendWarningFrame(s: TerminalSession, text: string): void {
  if (s.sink) {
    s.sink(
      JSON.stringify({
        type: "output",
        data: `\r\n\x1b[33m${text}\x1b[0m\r\n`,
      }),
    );
  }
}

function handleInputData(s: TerminalSession, data: string): void {
  // Walk one char at a time. Printable chars and backspace are mirrored to
  // s.inputBuffer; on Enter we peek the buffer to decide whether to forward
  // the Enter or replace it with Ctrl-C + a warning.
  let pending = "";
  const flush = () => {
    if (pending) {
      s.pty.write(pending);
      pending = "";
    }
  };

  for (const ch of data) {
    if (ch === "\r" || ch === "\n") {
      flush();
      const dirty = s.bufferDirty;
      const line = s.inputBuffer;
      s.inputBuffer = "";
      s.bufferDirty = false;

      if (!dirty) {
        const target = parseCdTarget(line);
        if (target !== null) {
          const newCwd = path.resolve(s.logicalCwd, target);
          if (!isWithinWorkspacesRoot(newCwd, s.workspacesRoot)) {
            // Block: cancel the typed line in PTY, surface a warning frame
            s.pty.write("\x03");
            sendWarningFrame(s, `警告：超出 workspaces (${s.workspacesRoot})，已忽略 "${target}"`);
            continue; // do not forward the Enter
          }
          // Inside boundary — accept and remember
          s.logicalCwd = newCwd;
        }
      }
      // Either non-cd, allowed cd, or dirty-buffer-skip → forward Enter
      s.pty.write(ch);
      continue;
    }

    if (ch === "\b" || ch === "\x7f") {
      s.inputBuffer = s.inputBuffer.slice(0, -1);
      pending += ch;
      continue;
    }

    const code = ch.charCodeAt(0);
    if (code < 0x20 && ch !== "\t") {
      // Control char (ESC, Ctrl-...) — we can't reliably mirror its effect
      // on the visible line, so skip the boundary check for this line.
      s.bufferDirty = true;
      pending += ch;
      continue;
    }
    if (ch === "\t") {
      // Tab completion can rewrite the line via PTY echo — give up tracking.
      s.bufferDirty = true;
      pending += ch;
      continue;
    }

    // Printable
    s.inputBuffer += ch;
    if (s.inputBuffer.length > 4096) {
      s.inputBuffer = s.inputBuffer.slice(-4096);
    }
    pending += ch;
  }
  flush();
}

export function resizeSession(s: TerminalSession, cols: number, rows: number): void {
  const c = clampSize(cols, s.cols);
  const r = clampSize(rows, s.rows);
  s.cols = c;
  s.rows = r;
  try {
    s.pty.resize(c, r);
  } catch (e) {
    throw errors.ioError((e as Error).message);
  }
}
