import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { parse as parseToml } from "smol-toml";
import { ApiError, errors } from "./errors.js";

const execFileAsync = promisify(execFile);
const UNSAFE_WINDOWS_SHELL_PATTERN = /[\r\n"&|<>%^!]/;

export interface CodexPluginRecord {
  name: string;
  marketplace?: string;
  selector: string;
  displayName: string;
  version?: string;
  description?: string;
  icon?: string;
  iconColor?: string;
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
    capabilities?: string[];
    composerIcon?: string;
    logo?: string;
    icon?: string;
    brandColor?: string;
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

function quoteWindowsCmdArg(value: string): string {
  if (UNSAFE_WINDOWS_SHELL_PATTERN.test(value)) {
    throw errors.invalidQuery("Invalid Codex CLI argument");
  }
  return `"${value}"`;
}

export function toWindowsCmdCommandLine(command: string, args: string[]): string {
  return ["call", quoteWindowsCmdArg(command), ...args.map(quoteWindowsCmdArg)].join(" ");
}

export function toCodexCliError(
  error: { code?: string | number; message: string; stdout?: string; stderr?: string }
): ApiError {
  if (error.code === "ENOENT") {
    return errors.codexCliNotFound();
  }
  const output = `${error.stdout ?? ""}${error.stderr ?? ""}`.trim();
  if (/codex(?:\.cmd)?['"]?\s+is not recognized/i.test(output)) {
    return errors.codexCliNotFound();
  }
  return new ApiError(502, "CODEX_CLI_FAILED", output || error.message);
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
    const result = await execFileAsync(
      process.platform === "win32" ? "cmd.exe" : bin,
      process.platform === "win32"
        ? ["/d", "/s", "/c", toWindowsCmdCommandLine(bin, args)]
        : args,
      {
      encoding: "utf8",
      windowsHide: true,
      windowsVerbatimArguments: process.platform === "win32",
      maxBuffer: 8 * 1024 * 1024,
      }
    );
    return result.stdout ?? "";
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    throw toCodexCliError(err);
  }
}

interface MergeRecord {
  name: string;
  marketplace?: string;
  selector?: string;
  displayName?: string;
  version?: string;
  description?: string;
  icon?: string;
  iconColor?: string;
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

const SAFE_SELECTOR_PATTERN = /^[a-z0-9._-]+(?:@[a-z0-9._-]+)?$/i;

function validatePluginSelector(selector: string): string {
  const normalized = selector.trim();
  if (!SAFE_SELECTOR_PATTERN.test(normalized)) {
    throw errors.invalidQuery("Invalid Codex plugin selector");
  }
  return normalized;
}

function validateMarketplaceSource(source: string): string {
  const normalized = source.trim();
  if (!normalized || UNSAFE_WINDOWS_SHELL_PATTERN.test(normalized)) {
    throw errors.invalidQuery("Invalid Codex marketplace source");
  }
  return normalized;
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
    icon: input.icon || prev?.icon,
    iconColor: input.iconColor || prev?.iconColor,
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

const MAX_PLUGIN_ICON_BYTES = 256 * 1024;

function browserSafeIconUrl(value: string): string | undefined {
  if (/^data:image\/(?:svg\+xml|png|jpe?g|gif|webp|x-icon);/i.test(value)) {
    return value;
  }
  if (/^https?:\/\//i.test(value)) {
    return value;
  }
  return undefined;
}

function iconMimeType(filePath: string): string | undefined {
  switch (path.extname(filePath).toLowerCase()) {
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".gif":
      return "image/gif";
    case ".webp":
      return "image/webp";
    case ".ico":
      return "image/x-icon";
    default:
      return undefined;
  }
}

function pathInside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function manifestIconCandidate(manifest: unknown): string {
  const obj = objectValue(manifest);
  const ui = objectValue(obj?.interface);
  return (
    stringValue(ui?.composerIcon) ||
    stringValue(ui?.logo) ||
    stringValue(ui?.icon) ||
    stringValue(obj?.composerIcon) ||
    stringValue(obj?.logo) ||
    stringValue(obj?.icon)
  );
}

async function loadManifestIcon(
  manifest: unknown,
  pluginRoot?: string
): Promise<string | undefined> {
  const candidate = manifestIconCandidate(manifest);
  if (!candidate) return undefined;

  const browserUrl = browserSafeIconUrl(candidate);
  if (browserUrl) return browserUrl;
  if (!pluginRoot) return undefined;

  const root = path.resolve(pluginRoot);
  const iconPath = path.resolve(root, candidate);
  if (!pathInside(root, iconPath)) return undefined;

  const mimeType = iconMimeType(iconPath);
  if (!mimeType) return undefined;

  try {
    const stat = await fs.stat(iconPath);
    if (!stat.isFile() || stat.size > MAX_PLUGIN_ICON_BYTES) return undefined;
    const data = await fs.readFile(iconPath);
    return `data:${mimeType};base64,${data.toString("base64")}`;
  } catch {
    return undefined;
  }
}

async function manifestMetadata(
  manifest: unknown,
  pluginRoot?: string
): Promise<Pick<
  MergeRecord,
  "displayName" | "version" | "description" | "icon" | "iconColor"
>> {
  const obj = objectValue(manifest);
  const ui = objectValue(obj?.interface);
  return {
    displayName: stringValue(ui?.displayName) || stringValue(obj?.name),
    version: stringValue(obj?.version) || undefined,
    description:
      stringValue(ui?.shortDescription) ||
      stringValue(obj?.description) ||
      undefined,
    icon: await loadManifestIcon(manifest, pluginRoot),
    iconColor:
      stringValue(ui?.brandColor) ||
      stringValue(obj?.brandColor) ||
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
    icon:
      stringValue(obj.icon) ||
      stringValue(obj.composerIcon) ||
      stringValue(obj.logo) ||
      undefined,
    iconColor:
      stringValue(obj.iconColor) ||
      stringValue(obj.brandColor) ||
      undefined,
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
        const metadata = await manifestMetadata(manifest, root);
        records.push({
          name: pluginName,
          marketplace,
          cached: true,
          installed: true,
          sourceKind: "cache",
          sourcePath: root,
          ...metadata,
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

function sameResolvedPath(left: string, right: string): boolean {
  if (process.platform === "win32") {
    return left.toLowerCase() === right.toLowerCase();
  }
  return left === right;
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
    const metadata = await manifestMetadata(manifest ?? { name }, absPath);
    records.push({
      name,
      marketplace: marketName,
      available: true,
      local: true,
      sourceKind: "personal",
      sourcePath: absPath,
      ...metadata,
    });
  }
  return records;
}

async function discoverPersonalPluginRoot(paths: CodexPluginPaths): Promise<MergeRecord[]> {
  const records: MergeRecord[] = [];
  let entries: string[];
  try {
    entries = await fs.readdir(paths.personalPluginRoot);
  } catch {
    return records;
  }

  for (const entry of entries) {
    const pluginRoot = path.join(paths.personalPluginRoot, entry);
    const manifest = await readJsonFile(
      path.join(pluginRoot, ".codex-plugin", "plugin.json")
    );
    const manifestObj = objectValue(manifest);
    const manifestName = stringValue(manifestObj?.name);
    const pluginName = manifestName ? normalizePluginName(manifestName) : normalizePluginName(entry);
    if (!manifestObj || !pluginName) continue;
    const metadata = await manifestMetadata(manifest, pluginRoot);
    records.push({
      name: pluginName,
      marketplace: "personal",
      available: true,
      local: true,
      sourceKind: "personal",
      sourcePath: pluginRoot,
      ...metadata,
    });
  }

  return records;
}

export interface CreateLocalCodexPluginInput {
  name: string;
  displayName?: string;
  description?: string;
}

export interface ImportLocalCodexPluginInput {
  path: string;
}

export function toMarketplaceSourcePath(
  marketplacePath: string,
  pluginRoot: string
): string {
  const relative = path.relative(path.dirname(marketplacePath), pluginRoot);
  if (path.isAbsolute(relative)) {
    return path.resolve(pluginRoot).replace(/\\/g, "/");
  }
  const normalized = relative.replace(/\\/g, "/");
  return normalized.startsWith(".") ? normalized : `./${normalized}`;
}

function marketplaceEntry(pluginName: string): Record<string, unknown> {
  return {
    name: pluginName,
    source: {
      source: "local",
      path: `./plugins/${pluginName}`,
    },
    policy: {
      installation: "AVAILABLE",
      authentication: "ON_INSTALL",
    },
    category: "Productivity",
  };
}

function defaultMarketplace(): Record<string, unknown> {
  return {
    name: "personal",
    interface: {
      displayName: "Personal",
    },
    plugins: [],
  };
}

async function readMarketplaceFile(filePath: string): Promise<Record<string, unknown>> {
  let text = "";
  try {
    text = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return defaultMarketplace();
    }
    throw error;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch (error) {
    throw errors.invalidQuery(
      `Personal marketplace parse failed: ${filePath}: ${(error as Error).message}`
    );
  }

  const existing = objectValue(parsed);
  if (!existing) {
    throw errors.invalidQuery(`Personal marketplace must be a JSON object: ${filePath}`);
  }
  if ("plugins" in existing && !Array.isArray(existing.plugins)) {
    throw errors.invalidQuery(
      `Personal marketplace plugins must be an array: ${filePath}`
    );
  }
  if ("name" in existing && typeof existing.name !== "string") {
    throw errors.invalidQuery(`Personal marketplace name must be a string: ${filePath}`);
  }
  if ("interface" in existing && !objectValue(existing.interface)) {
    throw errors.invalidQuery(
      `Personal marketplace interface must be an object: ${filePath}`
    );
  }
  const ui = objectValue(existing.interface);
  if (ui && "displayName" in ui && typeof ui.displayName !== "string") {
    throw errors.invalidQuery(
      `Personal marketplace displayName must be a string: ${filePath}`
    );
  }
  if (!Array.isArray(existing.plugins)) existing.plugins = [];
  if (!stringValue(existing.name)) existing.name = "personal";
  if (!ui) existing.interface = { displayName: "Personal" };
  return existing;
}

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  const temp = path.join(
    path.dirname(filePath),
    `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`
  );
  await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n", "utf8");
  await fs.rename(temp, filePath);
}

async function upsertPersonalMarketplaceEntry(
  paths: CodexPluginPaths,
  pluginName: string,
  sourcePath = `./plugins/${pluginName}`,
  marketplace?: Record<string, unknown>
): Promise<void> {
  const nextMarketplace = marketplace ?? (await readMarketplaceFile(paths.personalMarketplace));
  const plugins = Array.isArray(nextMarketplace.plugins) ? nextMarketplace.plugins : [];
  const nextEntry = {
    ...marketplaceEntry(pluginName),
    source: {
      source: "local",
      path: sourcePath,
    },
  };
  const index = plugins.findIndex((entry) => objectValue(entry)?.name === pluginName);
  if (index >= 0) plugins[index] = nextEntry;
  else plugins.push(nextEntry);
  nextMarketplace.plugins = plugins;
  await writeJsonAtomic(paths.personalMarketplace, nextMarketplace);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function defaultManifest(
  input: CreateLocalCodexPluginInput,
  pluginName: string
): CodexPluginManifest {
  const displayName = input.displayName?.trim() || input.name.trim() || pluginName;
  const description = input.description?.trim() || `Personal Codex plugin ${displayName}`;
  return {
    name: pluginName,
    version: "0.1.0",
    description,
    author: {
      name: "Personal",
    },
    license: "UNLICENSED",
    keywords: ["codex", "personal"],
    interface: {
      displayName,
      shortDescription: description,
      developerName: "Personal",
      category: "Productivity",
      capabilities: ["Interactive"],
    },
  };
}

export async function createLocalCodexPlugin(
  input: CreateLocalCodexPluginInput,
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  const marketplace = await readMarketplaceFile(paths.personalMarketplace);
  const pluginName = normalizePluginName(input.name);
  const pluginRoot = path.join(paths.personalPluginRoot, pluginName);
  const manifestPath = path.join(pluginRoot, ".codex-plugin", "plugin.json");
  if (await pathExists(manifestPath)) {
    throw errors.entryExists();
  }
  await writeJsonAtomic(manifestPath, defaultManifest(input, pluginName));
  await upsertPersonalMarketplaceEntry(paths, pluginName, undefined, marketplace);
  return await getCodexPluginSnapshot(options);
}

export async function importLocalCodexPlugin(
  input: ImportLocalCodexPluginInput,
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  const pluginRoot = path.resolve(input.path);
  const manifest = objectValue(
    await readJsonFile(path.join(pluginRoot, ".codex-plugin", "plugin.json"))
  );
  if (!manifest || !stringValue(manifest.name)) {
    throw errors.invalidQuery("Codex plugin manifest with a name is required");
  }
  const pluginName = normalizePluginName(stringValue(manifest.name));
  const sourcePath = toMarketplaceSourcePath(paths.personalMarketplace, pluginRoot);
  await upsertPersonalMarketplaceEntry(paths, pluginName, sourcePath);
  return await getCodexPluginSnapshot(options);
}

export async function removeLocalCodexPlugin(
  name: string,
  deleteSource: boolean,
  options: CodexPluginServiceOptions = {}
): Promise<CodexPluginSnapshot> {
  const paths = resolveCodexPluginPaths(options.paths);
  const pluginName = normalizePluginName(name);
  const marketplace = await readMarketplaceFile(paths.personalMarketplace);
  const plugins = Array.isArray(marketplace.plugins) ? marketplace.plugins : [];
  const entry = plugins.find((item) => objectValue(item)?.name === pluginName);
  if (!entry) {
    throw errors.notFound(`Personal Codex plugin not found: ${pluginName}`);
  }
  const entrySource = objectValue(objectValue(entry)?.source);
  const sourcePath = stringValue(entrySource?.path);

  if (deleteSource) {
    if (!sourcePath) {
      throw errors.invalidQuery("Refusing to delete source without a tracked personal path");
    }
    const finalPath = path.resolve(
      resolvePersonalMarketplaceSourcePath(paths, sourcePath)
    );
    const expected = path.resolve(path.join(paths.personalPluginRoot, pluginName));
    if (!sameResolvedPath(finalPath, expected)) {
      throw errors.invalidQuery("Refusing to delete source outside personal plugin root");
    }
    await fs.rm(finalPath, { recursive: true, force: true });
  }

  marketplace.plugins = plugins.filter((item) => objectValue(item)?.name !== pluginName);
  await writeJsonAtomic(paths.personalMarketplace, marketplace);

  return await getCodexPluginSnapshot(options);
}

export async function installCodexPlugin(
  selector: string,
  options: CodexPluginServiceOptions = {}
): Promise<unknown> {
  const runCli = options.runCli ?? runCodexPluginCli;
  return parseCliJson(
    await runCli(["plugin", "add", validatePluginSelector(selector), "--json"])
  );
}

export async function uninstallCodexPlugin(
  selector: string,
  options: CodexPluginServiceOptions = {}
): Promise<unknown> {
  const runCli = options.runCli ?? runCodexPluginCli;
  return parseCliJson(
    await runCli(["plugin", "remove", validatePluginSelector(selector), "--json"])
  );
}

export async function addCodexMarketplace(
  source: string,
  options: CodexPluginServiceOptions = {}
): Promise<unknown> {
  const runCli = options.runCli ?? runCodexPluginCli;
  return parseCliJson(
    await runCli([
      "plugin",
      "marketplace",
      "add",
      validateMarketplaceSource(source),
      "--json",
    ])
  );
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
  for (const record of await discoverPersonalPluginRoot(paths)) {
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
