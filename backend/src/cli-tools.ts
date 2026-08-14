import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { toWindowsCmdCommandLine } from "./codex-plugins.js";
import { platform as currentPlatform } from "./config.js";
import { ApiError } from "./errors.js";
import {
  type AiCliName,
  detectAiCli,
  findExecutable,
  type RuntimePlatform,
  type RuntimeTool,
} from "./runtime-tools.js";

const execFileAsync = promisify(execFile);

export type CliToolName = AiCliName;
export type CliToolAction = "install" | "update";

export interface CliToolStatus {
  name: CliToolName;
  installed: boolean;
  currentVersion: string | null;
  latestVersion: string | null;
  updateAvailable: boolean;
  platform: RuntimePlatform;
  error: string | null;
}

export interface CliToolCommandResult {
  stdout: string;
  stderr: string;
}

export type CliToolCommandRunner = (
  command: string,
  args: string[],
  timeoutMs: number,
) => Promise<CliToolCommandResult>;

interface CliToolManagerDependencies {
  platform: RuntimePlatform;
  detect: (name: CliToolName) => RuntimeTool;
  findExecutable: (command: string) => string | null;
  getLatestVersion: (packageName: string) => Promise<string>;
  run: CliToolCommandRunner;
}

const TOOL_PACKAGES: Record<CliToolName, string> = {
  claude: "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

const VERSION_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 5 * 60_000;

function errorMessage(error: unknown): string {
  if (error instanceof Error) {
    const commandError = error as Error & { stdout?: string; stderr?: string };
    const detail = commandError.stderr || commandError.stdout || commandError.message;
    return (
      detail
        .split(/\r?\n/)
        .map((line) => line.trim())
        .find(Boolean) ?? error.message
    );
  }
  return String(error);
}

export function parseCliVersion(output: string): string | null {
  return output.match(/\bv?(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/)?.[1] ?? null;
}

function numericVersion(version: string): number[] {
  return version
    .split("-", 1)[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
}

export function isNewerVersion(current: string | null, latest: string | null): boolean {
  if (!current || !latest) return false;
  const currentParts = numericVersion(current);
  const latestParts = numericVersion(latest);
  const length = Math.max(currentParts.length, latestParts.length);
  for (let index = 0; index < length; index += 1) {
    const currentPart = currentParts[index] ?? 0;
    const latestPart = latestParts[index] ?? 0;
    if (latestPart !== currentPart) return latestPart > currentPart;
  }
  return false;
}

async function defaultRun(
  command: string,
  args: string[],
  timeoutMs: number,
): Promise<CliToolCommandResult> {
  const isWindows = currentPlatform === "windows";
  const result = await execFileAsync(
    isWindows ? (process.env.ComSpec ?? "cmd.exe") : command,
    isWindows ? ["/d", "/s", "/c", toWindowsCmdCommandLine(command, args)] : args,
    {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: timeoutMs,
      windowsHide: true,
      windowsVerbatimArguments: isWindows,
    },
  );
  return { stdout: result.stdout, stderr: result.stderr };
}

async function getLatestNpmVersion(packageName: string): Promise<string> {
  const response = await fetch(
    `https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`,
    { signal: AbortSignal.timeout(20_000) },
  );
  if (!response.ok) throw new Error(`npm registry returned HTTP ${response.status}`);
  const body = (await response.json()) as { version?: unknown };
  if (typeof body.version !== "string" || !parseCliVersion(body.version)) {
    throw new Error("npm registry returned an invalid version");
  }
  return body.version;
}

export function createCliToolManager(dependencies: CliToolManagerDependencies) {
  const activeActions = new Set<CliToolName>();

  const npmCommand = (): string => {
    const command = dependencies.findExecutable("npm");
    if (!command) {
      throw new ApiError(409, "NPM_NOT_FOUND", "Node.js/npm is required to install CLI tools");
    }
    return command;
  };

  const getStatus = async (name: CliToolName): Promise<CliToolStatus> => {
    const runtime = dependencies.detect(name);
    let currentVersion: string | null = null;
    let latestVersion: string | null = null;
    const errors: string[] = [];

    if (runtime.installed) {
      try {
        const result = await dependencies.run(runtime.command, ["--version"], VERSION_TIMEOUT_MS);
        currentVersion = parseCliVersion(`${result.stdout}\n${result.stderr}`);
        if (!currentVersion) errors.push("Unable to read the installed version");
      } catch (error) {
        errors.push(`Installed CLI could not run: ${errorMessage(error)}`);
      }
    }

    try {
      latestVersion = parseCliVersion(await dependencies.getLatestVersion(TOOL_PACKAGES[name]));
    } catch (error) {
      errors.push(`Latest version check failed: ${errorMessage(error)}`);
    }

    return {
      name,
      installed: runtime.installed,
      currentVersion,
      latestVersion,
      updateAvailable: isNewerVersion(currentVersion, latestVersion),
      platform: dependencies.platform,
      error: errors.length > 0 ? errors.join("; ") : null,
    };
  };

  const runAction = async (name: CliToolName, action: CliToolAction): Promise<CliToolStatus> => {
    if (activeActions.size > 0) {
      throw new ApiError(
        409,
        "CLI_ACTION_IN_PROGRESS",
        "Another CLI installation is already running",
      );
    }
    activeActions.add(name);
    try {
      const runtime = dependencies.detect(name);
      if (action === "update" && name === "claude" && runtime.installed) {
        try {
          await dependencies.run(runtime.command, ["update"], ACTION_TIMEOUT_MS);
        } catch {
          await dependencies.run(
            npmCommand(),
            ["install", "--global", `${TOOL_PACKAGES[name]}@latest`],
            ACTION_TIMEOUT_MS,
          );
        }
      } else {
        await dependencies.run(
          npmCommand(),
          ["install", "--global", `${TOOL_PACKAGES[name]}@latest`],
          ACTION_TIMEOUT_MS,
        );
      }
      return await getStatus(name);
    } catch (error) {
      if (error instanceof ApiError) throw error;
      throw new ApiError(500, "CLI_ACTION_FAILED", errorMessage(error));
    } finally {
      activeActions.delete(name);
    }
  };

  return { getStatus, runAction };
}

export const cliToolManager = createCliToolManager({
  platform: currentPlatform,
  detect: detectAiCli,
  findExecutable,
  getLatestVersion: getLatestNpmVersion,
  run: defaultRun,
});
