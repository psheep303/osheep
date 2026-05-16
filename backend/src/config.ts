import * as path from "node:path";
import * as os from "node:os";

export interface Config {
  host: string;
  port: number;
  workspacesRoot: string;
  maxFileSizeBytes: number;
  maxTerminalSessions: number;
  terminalIdleTimeoutMs: number;
  corsOrigin: string;
}

function readEnvInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveWorkspacesRoot(raw: string | undefined): string {
  if (raw && raw.trim()) return path.resolve(raw);
  return path.resolve(process.cwd(), "workspaces");
}

export const config: Config = {
  host: process.env.OSHEEP_HOST ?? "127.0.0.1",
  port: readEnvInt("OSHEEP_PORT", 4178),
  workspacesRoot: resolveWorkspacesRoot(process.env.WORKSPACES_ROOT),
  maxFileSizeBytes: readEnvInt("MAX_FILE_SIZE_BYTES", 5 * 1024 * 1024),
  maxTerminalSessions: readEnvInt("MAX_TERMINAL_SESSIONS", 16),
  terminalIdleTimeoutMs: readEnvInt("TERMINAL_IDLE_TIMEOUT_MS", 30 * 60 * 1000),
  corsOrigin: process.env.CORS_ORIGIN ?? "*",
};

export const platform: "windows" | "macos" | "linux" =
  os.platform() === "win32"
    ? "windows"
    : os.platform() === "darwin"
    ? "macos"
    : "linux";
