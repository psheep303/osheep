import * as fs from "node:fs";
import * as path from "node:path";
import { platform as currentPlatform } from "./config.js";

export type RuntimePlatform = "windows" | "macos" | "linux";

export interface RuntimeTool {
  command: string;
  path: string | null;
  installed: boolean;
}

interface ToolLookupOptions {
  platform?: RuntimePlatform;
  env?: NodeJS.ProcessEnv;
}

function isExecutableFile(filePath: string, platform: RuntimePlatform): boolean {
  try {
    if (!fs.statSync(filePath).isFile()) return false;
    if (platform !== "windows") fs.accessSync(filePath, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function pathExtensions(env: NodeJS.ProcessEnv): string[] {
  const configured = env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD";
  return configured
    .split(";")
    .map((extension) => extension.trim())
    .filter(Boolean);
}

export function findExecutable(command: string, options: ToolLookupOptions = {}): string | null {
  const runtimePlatform = options.platform ?? currentPlatform;
  const env = options.env ?? process.env;
  const hasPathSeparator = command.includes("/") || command.includes("\\");
  const extensions = runtimePlatform === "windows" ? ["", ...pathExtensions(env)] : [""];

  if (hasPathSeparator || path.isAbsolute(command)) {
    for (const extension of extensions) {
      const candidate = path.resolve(`${command}${extension}`);
      if (isExecutableFile(candidate, runtimePlatform)) return candidate;
    }
    return null;
  }

  const separator = runtimePlatform === "windows" ? ";" : ":";
  for (const directory of (env.PATH ?? "").split(separator)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension}`);
      if (isExecutableFile(candidate, runtimePlatform)) return candidate;
    }
  }
  return null;
}

export type AiCliName = "claude" | "codex";

export function defaultAiCliCommand(
  name: AiCliName,
  runtimePlatform: RuntimePlatform = currentPlatform,
): string {
  if (runtimePlatform !== "windows") return name;
  return name === "codex" ? "codex.cmd" : "claude.exe";
}

function aiCliCandidates(name: AiCliName, runtimePlatform: RuntimePlatform): string[] {
  if (runtimePlatform !== "windows") return [name];
  return name === "codex"
    ? ["codex.cmd", "codex.exe", "codex"]
    : ["claude.exe", "claude.cmd", "claude"];
}

export function detectAiCli(name: AiCliName, options: ToolLookupOptions = {}): RuntimeTool {
  const runtimePlatform = options.platform ?? currentPlatform;
  const command = defaultAiCliCommand(name, runtimePlatform);
  for (const candidate of aiCliCandidates(name, runtimePlatform)) {
    const resolved = findExecutable(candidate, { ...options, platform: runtimePlatform });
    if (resolved) return { command: resolved, path: resolved, installed: true };
  }
  return { command, path: null, installed: false };
}

export function detectRuntimeTools(options: ToolLookupOptions = {}): {
  bash: RuntimeTool;
  git: RuntimeTool;
  claude: RuntimeTool;
  codex: RuntimeTool;
} {
  const runtimePlatform = options.platform ?? currentPlatform;
  const detect = (command: string): RuntimeTool => {
    const resolved = findExecutable(command, { ...options, platform: runtimePlatform });
    return { command: resolved ?? command, path: resolved, installed: resolved !== null };
  };
  return {
    bash: detect(runtimePlatform === "windows" ? "bash.exe" : "bash"),
    git: detect(runtimePlatform === "windows" ? "git.exe" : "git"),
    claude: detectAiCli("claude", { ...options, platform: runtimePlatform }),
    codex: detectAiCli("codex", { ...options, platform: runtimePlatform }),
  };
}
