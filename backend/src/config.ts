import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface Config {
  host: string;
  port: number;
  workspacesRoot: string;
  maxFileSizeBytes: number;
  maxTerminalSessions: number;
  terminalIdleTimeoutMs: number;
  agentStallTimeoutMs: number;
  corsOrigins: string[];
  authToken?: string;
  templatesRoot: string;
  systemTemplatesRoot: string;
  developerMode: boolean;
  frontendRoot?: string;
  allowExternalWorkspacePaths: boolean;
  workspaceRootConfigFile?: string;
  openedProjectsFile: string;
}

function readEnvList(key: string): string[] {
  return (process.env[key] ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
}

function readEnvInt(key: string, fallback: number): number {
  const v = process.env[key];
  if (!v) return fallback;
  const n = Number.parseInt(v, 10);
  return Number.isFinite(n) ? n : fallback;
}

function resolveWorkspacesRoot(raw: string | undefined): string {
  const configFile = process.env.OSHEEP_WORKSPACE_ROOT_CONFIG;
  if (configFile) {
    try {
      const parsed = JSON.parse(fs.readFileSync(configFile, "utf8")) as { root?: unknown };
      if (typeof parsed.root === "string" && parsed.root.trim()) {
        return path.resolve(parsed.root);
      }
    } catch {
      // Fall back to the default when the first-run settings file is absent.
    }
  }
  if (raw?.trim()) return path.resolve(raw);
  return path.resolve(process.cwd(), "workspaces");
}

export const config: Config = {
  host: process.env.OSHEEP_HOST ?? "127.0.0.1",
  port: readEnvInt("OSHEEP_PORT", 4178),
  workspacesRoot: resolveWorkspacesRoot(process.env.WORKSPACES_ROOT),
  maxFileSizeBytes: readEnvInt("MAX_FILE_SIZE_BYTES", 5 * 1024 * 1024),
  maxTerminalSessions: readEnvInt("MAX_TERMINAL_SESSIONS", 16),
  terminalIdleTimeoutMs: readEnvInt("TERMINAL_IDLE_TIMEOUT_MS", 0),
  agentStallTimeoutMs: readEnvInt("AGENT_STALL_TIMEOUT_MS", 30 * 60 * 1000),
  corsOrigins: readEnvList("CORS_ORIGIN"),
  authToken: process.env.OSHEEP_AUTH_TOKEN?.trim() || undefined,
  templatesRoot: path.resolve(
    process.env.OSHEEP_TEMPLATES_ROOT ?? path.join(os.homedir(), ".osheep", "templates"),
  ),
  systemTemplatesRoot: path.resolve(
    process.env.OSHEEP_SYSTEM_TEMPLATES_ROOT ??
      path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "template-library", "system"),
  ),
  developerMode: /^(1|true|yes)$/i.test(process.env.OSHEEP_DEVELOPER_MODE ?? ""),
  frontendRoot: process.env.OSHEEP_FRONTEND_ROOT?.trim()
    ? path.resolve(process.env.OSHEEP_FRONTEND_ROOT)
    : undefined,
  allowExternalWorkspacePaths: /^(1|true|yes)$/i.test(
    process.env.OSHEEP_ALLOW_EXTERNAL_WORKSPACE_PATHS ?? "",
  ),
  workspaceRootConfigFile: process.env.OSHEEP_WORKSPACE_ROOT_CONFIG
    ? path.resolve(process.env.OSHEEP_WORKSPACE_ROOT_CONFIG)
    : undefined,
  openedProjectsFile: path.resolve(
    process.env.OSHEEP_OPENED_PROJECTS_FILE ??
      path.join(
        path.dirname(fileURLToPath(import.meta.url)),
        "..",
        ".osheep",
        "opened-projects.json",
      ),
  ),
};

// These Osheep aliases must also be visible to the CLIs spawned by this process.
if (process.env.OSHEEP_CLAUDE_CONFIG_DIR && !process.env.CLAUDE_CONFIG_DIR) {
  process.env.CLAUDE_CONFIG_DIR = process.env.OSHEEP_CLAUDE_CONFIG_DIR;
}
if (process.env.OSHEEP_CODEX_CONFIG_DIR && !process.env.CODEX_HOME) {
  process.env.CODEX_HOME = process.env.OSHEEP_CODEX_CONFIG_DIR;
}

export const platform: "windows" | "macos" | "linux" =
  os.platform() === "win32" ? "windows" : os.platform() === "darwin" ? "macos" : "linux";
