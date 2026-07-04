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
      shell: process.platform === "win32",
    });
    return result.stdout ?? "";
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === "ENOENT") {
      throw errors.codexCliNotFound();
    }
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new ApiError(502, "CODEX_CLI_FAILED", output || err.message);
  }
}

interface MergeRecord {
  name: string;
  marketplace?: string;
  selector?: string;
  displayName?: string;
  version?: string;
  description?: string;
  installed?: boolean;
  available?: boolean;
  enabled?: boolean;
  cached?: boolean;
  local?: boolean;
  sourceKind: CodexPluginRecord["source"]["kind"];
  sourcePath?: string;
}

interface PersonalMarketplaceFile {
  name?: unknown;
  interface?: { displayName?: unknown };
  plugins?: unknown;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function selectorFor(name: string, marketplace?: string): string {
  return marketplace ? `${name}@${marketplace}` : name;
}

function splitSelector(selector: string): { name: string; marketplace?: string } {
  const at = selector.lastIndexOf("@");
  if (at <= 0 || at === selector.length - 1) return { name: selector };
  return { name: selector.slice(0, at), marketplace: selector.slice(at + 1) };
}

function emptyStatus(): CodexPluginRecord["status"] {
  return {
    installed: false,
    available: false,
    enabled: false,
    cached: false,
    local: false,
  };
}

function mergePlugin(map: Map<string, CodexPluginRecord>, input: MergeRecord): void {
  const rawSelector = input.selector || selectorFor(input.name, input.marketplace);
  const split = splitSelector(rawSelector);
  const name = input.name || split.name;
  const marketplace = input.marketplace || split.marketplace;
  const selector = selectorFor(name, marketplace);
  const prev = map.get(selector);
  const status = { ...(prev?.status ?? emptyStatus()) };
  status.installed = status.installed || !!input.installed || !!input.enabled || !!input.cached;
  status.available = status.available || !!input.available;
  status.enabled = status.enabled || !!input.enabled;
  status.cached = status.cached || !!input.cached;
  status.local = status.local || !!input.local;
  map.set(selector, {
    name,
    marketplace,
    selector,
    displayName: input.displayName || prev?.displayName || name,
    version: input.version || prev?.version,
    description: input.description || prev?.description,
    status,
    source: {
      kind: input.sourceKind || prev?.source.kind || "config",
      path: input.sourcePath || prev?.source.path,
    },
  });
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

async function readPersonalMarketplaceFile(
  filePath: string,
  warnings: string[]
): Promise<unknown | null> {
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    warnings.push(`Personal marketplace parse failed: ${filePath}: ${(e as Error).message}`);
    return null;
  }
}

function manifestMetadata(manifest: unknown): Pick<
  MergeRecord,
  "displayName" | "version" | "description"
> {
  const obj = objectValue(manifest);
  const ui = objectValue(obj?.interface);
  return {
    displayName: stringValue(ui?.displayName) || stringValue(obj?.name),
    version: stringValue(obj?.version) || undefined,
    description:
      stringValue(ui?.shortDescription) ||
      stringValue(obj?.description) ||
      undefined,
  };
}

function normalizeCliPlugin(value: unknown, fallbackStatus: "installed" | "available"): MergeRecord | null {
  const obj = objectValue(value);
  if (!obj) return null;
  const selector = stringValue(obj.selector);
  const split = selector ? splitSelector(selector) : null;
  const name = stringValue(obj.name) || split?.name || "";
  if (!name) return null;
  const marketplace =
    stringValue(obj.marketplace) ||
    stringValue(obj.marketplaceName) ||
    split?.marketplace ||
    undefined;
  return {
    name,
    marketplace,
    selector: selector || undefined,
    displayName: stringValue(obj.displayName) || stringValue(obj.title) || name,
    version: stringValue(obj.version) || undefined,
    description: stringValue(obj.description) || undefined,
    installed: fallbackStatus === "installed" || obj.installed === true,
    available: fallbackStatus === "available" || obj.available === true,
    enabled: obj.enabled === true,
    sourceKind: "marketplace",
  };
}

async function discoverCliPlugins(
  runCli: (args: string[]) => Promise<string>,
  warnings: string[]
): Promise<{ records: MergeRecord[]; marketplaces: CodexMarketplaceRecord[] }> {
  const records: MergeRecord[] = [];
  const marketplaces: CodexMarketplaceRecord[] = [];
  try {
    const parsed = objectValue(parseCliJson(await runCli(["plugin", "list", "--available", "--json"])));
    for (const item of Array.isArray(parsed?.installed) ? parsed.installed : []) {
      const record = normalizeCliPlugin(item, "installed");
      if (record) records.push(record);
    }
    for (const item of Array.isArray(parsed?.available) ? parsed.available : []) {
      const record = normalizeCliPlugin(item, "available");
      if (record) records.push(record);
    }
  } catch (e) {
    warnings.push(`Codex plugin list failed: ${(e as Error).message}`);
  }

  try {
    const parsed = objectValue(parseCliJson(await runCli(["plugin", "marketplace", "list", "--json"])));
    for (const item of Array.isArray(parsed?.marketplaces) ? parsed.marketplaces : []) {
      const obj = objectValue(item);
      const name = stringValue(obj?.name);
      if (!name) continue;
      marketplaces.push({
        name,
        source: stringValue(obj?.source) || undefined,
        path: stringValue(obj?.path) || undefined,
      });
    }
  } catch (e) {
    warnings.push(`Codex marketplace list failed: ${(e as Error).message}`);
  }
  return { records, marketplaces };
}

async function discoverConfigPlugins(configPath: string, warnings: string[]): Promise<MergeRecord[]> {
  let text = "";
  try {
    text = await fs.readFile(configPath, "utf8");
  } catch {
    return [];
  }
  try {
    const parsed = parseToml(text) as Record<string, unknown>;
    const plugins = objectValue(parsed.plugins);
    const out: MergeRecord[] = [];
    for (const [selector, value] of Object.entries(plugins ?? {})) {
      const pluginConfig = objectValue(value);
      const split = splitSelector(selector);
      out.push({
        name: split.name,
        marketplace: split.marketplace,
        selector,
        enabled: pluginConfig?.enabled !== false,
        installed: true,
        sourceKind: "config",
        sourcePath: configPath,
      });
    }
    return out;
  } catch (e) {
    warnings.push(`Codex config parse failed: ${(e as Error).message}`);
    return [];
  }
}

async function discoverCachePlugins(cacheRoot: string): Promise<MergeRecord[]> {
  const records: MergeRecord[] = [];
  let marketplaces: string[];
  try {
    marketplaces = await fs.readdir(cacheRoot);
  } catch {
    return records;
  }
  for (const marketplace of marketplaces) {
    const marketplaceDir = path.join(cacheRoot, marketplace);
    const pluginNames = await fs.readdir(marketplaceDir).catch(() => []);
    for (const pluginName of pluginNames) {
      const pluginDir = path.join(marketplaceDir, pluginName);
      const versions = await fs.readdir(pluginDir).catch(() => []);
      for (const versionDir of versions) {
        const root = path.join(pluginDir, versionDir);
        const manifestPath = path.join(root, ".codex-plugin", "plugin.json");
        const manifest = await readJsonFile(manifestPath);
        if (!manifest) continue;
        records.push({
          name: pluginName,
          marketplace,
          cached: true,
          installed: true,
          sourceKind: "cache",
          sourcePath: root,
          ...manifestMetadata(manifest),
        });
      }
    }
  }
  return records;
}

function resolvePersonalMarketplaceSourcePath(paths: CodexPluginPaths, sourcePath: string): string {
  if (path.isAbsolute(sourcePath)) return path.resolve(sourcePath);
  const normalized = path.normalize(sourcePath);
  const segments = normalized.split(/[\\/]+/).filter((segment) => segment && segment !== ".");
  if (segments[0] === "plugins" && segments.length > 1) {
    return path.resolve(paths.personalPluginRoot, ...segments.slice(1));
  }
  return path.resolve(path.dirname(paths.personalMarketplace), normalized);
}

async function discoverPersonalMarketplacePlugins(
  paths: CodexPluginPaths,
  warnings: string[]
): Promise<MergeRecord[]> {
  const parsed = objectValue(
    await readPersonalMarketplaceFile(paths.personalMarketplace, warnings)
  ) as PersonalMarketplaceFile | null;
  if (!parsed || !Array.isArray(parsed.plugins)) return [];
  const marketName = stringValue(parsed.name) || "personal";
  const records: MergeRecord[] = [];
  for (const entry of parsed.plugins) {
    const obj = objectValue(entry);
    const name = stringValue(obj?.name);
    const source = objectValue(obj?.source);
    const sourcePath = stringValue(source?.path);
    if (!name || !sourcePath) continue;
    const absPath = resolvePersonalMarketplaceSourcePath(paths, sourcePath);
    const manifest = await readJsonFile(path.join(absPath, ".codex-plugin", "plugin.json"));
    records.push({
      name,
      marketplace: marketName,
      available: true,
      local: true,
      sourceKind: "personal",
      sourcePath: absPath,
      ...manifestMetadata(manifest ?? { name }),
    });
  }
  return records;
}

export async function getCodexPluginSnapshot(
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  const runCli = options.runCli ?? runCodexPluginCli;
  const warnings: string[] = [];
  const map = new Map<string, CodexPluginRecord>();

  const cli = await discoverCliPlugins(runCli, warnings);
  for (const record of cli.records) mergePlugin(map, record);
  for (const record of await discoverConfigPlugins(paths.codexConfig, warnings)) mergePlugin(map, record);
  for (const record of await discoverCachePlugins(paths.codexPluginCache)) mergePlugin(map, record);
  for (const record of await discoverPersonalMarketplacePlugins(paths, warnings)) {
    mergePlugin(map, record);
  }

  const plugins = [...map.values()].sort((a, b) => {
    const groupA = a.status.installed ? 0 : a.status.local ? 1 : 2;
    const groupB = b.status.installed ? 0 : b.status.local ? 1 : 2;
    if (groupA !== groupB) return groupA - groupB;
    return a.displayName.localeCompare(b.displayName);
  });

  return {
    plugins,
    marketplaces: cli.marketplaces.sort((a, b) => a.name.localeCompare(b.name)),
    warnings,
    paths,
  };
}
