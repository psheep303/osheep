import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { ApiError, errors } from "./errors.js";

const execFileAsync = promisify(execFile);

export interface CodexPluginRecord {
  name: string;
  marketplace?: string;
  selector: string;
  displayName: string;
  version?: string;
  description?: string;
  status: {
    installed: boolean;
    available: boolean;
    enabled: boolean;
    cached: boolean;
    local: boolean;
  };
  source: {
    kind: "marketplace" | "personal" | "cache" | "config";
    path?: string;
  };
}

export interface CodexMarketplaceRecord {
  name: string;
  source?: string;
  path?: string;
}

export interface CodexPluginSnapshot {
  plugins: CodexPluginRecord[];
  marketplaces: CodexMarketplaceRecord[];
  warnings: string[];
  paths: {
    codexDir: string;
    codexConfig: string;
    codexPluginCache: string;
    personalMarketplace: string;
    personalPluginRoot: string;
  };
}

export interface CodexPluginManifest {
  name: string;
  version?: string;
  description?: string;
  interface?: {
    displayName?: string;
    shortDescription?: string;
    category?: string;
    developerName?: string;
  };
  [key: string]: unknown;
}

export interface CodexPluginPaths {
  codexDir: string;
  codexConfig: string;
  codexPluginCache: string;
  personalMarketplace: string;
  personalPluginRoot: string;
}

export interface CodexPluginServiceOptions {
  paths?: Partial<CodexPluginPaths>;
  runCli?: (args: string[]) => Promise<string>;
}

export function normalizePluginName(value: string): string {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9.-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return normalized || "plugin";
}

export function parseCliJson(text: string): unknown {
  const startObj = text.indexOf("{");
  const startArr = text.indexOf("[");
  let start = -1;
  if (startObj >= 0 && startArr >= 0) {
    start = Math.min(startObj, startArr);
  } else {
    start = Math.max(startObj, startArr);
  }
  if (start < 0) {
    throw new Error("Codex CLI did not return JSON");
  }
  try {
    return JSON.parse(text.slice(start));
  } catch (error) {
    throw new Error(`Codex CLI JSON parse failed: ${(error as Error).message}`);
  }
}

export function defaultCodexPluginPaths(): CodexPluginPaths {
  const home = os.homedir() || ".";
  const codexDir = path.resolve(
    process.env.OSHEEP_CODEX_CONFIG_DIR || path.join(home, ".codex")
  );
  const personalMarketplace = path.resolve(
    process.env.OSHEEP_CODEX_PERSONAL_MARKETPLACE ||
      path.join(home, ".agents", "plugins", "marketplace.json")
  );
  const personalPluginRoot = path.resolve(
    process.env.OSHEEP_CODEX_PERSONAL_PLUGIN_ROOT || path.join(home, "plugins")
  );
  return {
    codexDir,
    codexConfig: path.join(codexDir, "config.toml"),
    codexPluginCache: path.join(codexDir, "plugins", "cache"),
    personalMarketplace,
    personalPluginRoot,
  };
}

export function resolveCodexPluginPaths(
  overrides: Partial<CodexPluginPaths> = {}
): CodexPluginPaths {
  return { ...defaultCodexPluginPaths(), ...overrides };
}

export async function runCodexPluginCli(args: string[]): Promise<string> {
  const bin = process.platform === "win32" ? "codex.cmd" : "codex";
  try {
    const result = await execFileAsync(bin, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === "ENOENT") {
      throw errors.codexCliNotFound();
    }
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new ApiError(502, "CODEX_CLI_FAILED", output || err.message);
  }
}

export async function getCodexPluginSnapshot(
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  return {
    plugins: [],
    marketplaces: [],
    warnings: [],
    paths,
  };
}

void fs;
void parseToml;
