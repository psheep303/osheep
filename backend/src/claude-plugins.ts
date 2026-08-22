import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { ApiError, errors } from "./errors.js";
import { detectAiCli } from "./runtime-tools.js";

const execFileAsync = promisify(execFile);
const UNSAFE_ARGUMENT_PATTERN = /[\r\n"&|<>%^!]/;
const SAFE_SELECTOR_PATTERN = /^[a-z0-9._-]+(?:@[a-z0-9._-]+)?$/i;
const CLAUDE_PLUGIN_SCOPES = ["user", "project", "local"] as const;

export interface ClaudePluginRecord {
  name: string;
  marketplace?: string;
  selector: string;
  displayName: string;
  version?: string;
  description?: string;
  icon?: string;
  iconColor?: string;
  scope?: string;
  installCount?: number;
  status: {
    installed: boolean;
    available: boolean;
    enabled: boolean;
    cached: boolean;
    local: boolean;
  };
  source: {
    kind: "marketplace" | "cache" | "settings";
    path?: string;
  };
}

export interface ClaudeMarketplaceRecord {
  name: string;
  source?: string;
  repo?: string;
  url?: string;
  path?: string;
}

export interface ClaudePluginSnapshot {
  plugins: ClaudePluginRecord[];
  marketplaces: ClaudeMarketplaceRecord[];
  warnings: string[];
  paths: {
    claudeDir: string;
    settings: string;
    localSettings: string;
    pluginCache: string;
    marketplaces: string;
    skills: string;
  };
}

export interface ClaudePluginPaths {
  claudeDir: string;
  settings: string;
  localSettings: string;
  pluginCache: string;
  marketplaces: string;
  skills: string;
}

export interface ClaudePluginServiceOptions {
  paths?: Partial<ClaudePluginPaths>;
  runCli?: (args: string[]) => Promise<string>;
  scope?: string;
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
  scope?: string;
  installCount?: number;
  homepage?: string;
  authorName?: string;
  sourceUrl?: string;
  installed?: boolean;
  available?: boolean;
  enabled?: boolean;
  cached?: boolean;
  local?: boolean;
  sourceKind: ClaudePluginRecord["source"]["kind"];
  sourcePath?: string;
}

export function defaultClaudePluginPaths(): ClaudePluginPaths {
  const home = os.homedir() || ".";
  const claudeDir = path.resolve(
    process.env.OSHEEP_CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
  );
  return {
    claudeDir,
    settings: path.join(claudeDir, "settings.json"),
    localSettings: path.join(claudeDir, "settings.local.json"),
    pluginCache: path.join(claudeDir, "plugins", "cache"),
    marketplaces: path.join(claudeDir, "plugins", "marketplaces"),
    skills: path.join(claudeDir, "skills"),
  };
}

export function resolveClaudePluginPaths(
  overrides: Partial<ClaudePluginPaths> = {},
): ClaudePluginPaths {
  return { ...defaultClaudePluginPaths(), ...overrides };
}

export function parseClaudeCliJson(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return null;
  const startObj = trimmed.indexOf("{");
  const startArr = trimmed.indexOf("[");
  let start = -1;
  if (startObj >= 0 && startArr >= 0) start = Math.min(startObj, startArr);
  else start = Math.max(startObj, startArr);
  if (start < 0) throw new Error("Claude CLI did not return JSON");
  return JSON.parse(trimmed.slice(start)) as unknown;
}

export async function runClaudePluginCli(args: string[]): Promise<string> {
  const bin = detectAiCli("claude").command;
  try {
    const result = await execFileAsync(bin, args, {
      encoding: "utf8",
      windowsHide: true,
      maxBuffer: 12 * 1024 * 1024,
    });
    return result.stdout ?? "";
  } catch (error) {
    const err = error as NodeJS.ErrnoException & { stdout?: string; stderr?: string };
    if (err.code === "ENOENT") {
      throw new ApiError(500, "CLAUDE_CLI_NOT_FOUND", "Claude CLI was not found");
    }
    const output = `${err.stdout ?? ""}${err.stderr ?? ""}`.trim();
    throw new ApiError(502, "CLAUDE_CLI_FAILED", output || err.message);
  }
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function numberValue(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function svgDataUrl(svg: string): string {
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

const FALLBACK_ICON_COLORS = [
  "#2563EB",
  "#059669",
  "#7C3AED",
  "#DC2626",
  "#0891B2",
  "#C2410C",
  "#4F46E5",
  "#0F766E",
];

function colorForPlugin(name: string): string {
  let hash = 0;
  for (const char of name) {
    hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  }
  return FALLBACK_ICON_COLORS[hash % FALLBACK_ICON_COLORS.length]!;
}

function fallbackPluginIcon(name: string): string {
  const color = colorForPlugin(name);
  return svgDataUrl(
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64">` +
      `<rect width="64" height="64" rx="14" fill="${color}"/>` +
      `<g fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" stroke-linejoin="round">` +
      `<path d="M24 18h16a6 6 0 0 1 6 6v16a6 6 0 0 1-6 6H24a6 6 0 0 1-6-6V24a6 6 0 0 1 6-6Z"/>` +
      `<path d="M28 18v-5M36 18v-5M28 51v-5M36 51v-5M18 28h-5M18 36h-5M51 28h-5M51 36h-5"/>` +
      `<path d="M28 29h8v8h-8z"/>` +
      `</g></svg>`,
  );
}

const KNOWN_AUTHOR_GITHUB_OWNERS: Record<string, string> = {
  adobe: "adobe",
  anthropic: "anthropics",
  github: "github",
  google: "google",
  microsoft: "microsoft",
  openai: "openai",
};

function githubOwnerIconUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    if (host !== "github.com" && host !== "www.github.com") return undefined;
    const owner = url.pathname.split("/").filter(Boolean)[0];
    if (!owner) return undefined;
    return `https://github.com/${owner}.png?size=64`;
  } catch {
    return undefined;
  }
}

function homepageFaviconUrl(value?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(url.hostname)}&sz=64`;
  } catch {
    return undefined;
  }
}

function authorIconUrl(authorName?: string): string | undefined {
  if (!authorName) return undefined;
  const normalized = authorName.trim().toLowerCase();
  const owner = KNOWN_AUTHOR_GITHUB_OWNERS[normalized];
  return owner ? `https://github.com/${owner}.png?size=64` : undefined;
}

function derivedBrandIcon(record: MergeRecord): string | undefined {
  return (
    githubOwnerIconUrl(record.sourceUrl) ||
    authorIconUrl(record.authorName) ||
    githubOwnerIconUrl(record.homepage) ||
    homepageFaviconUrl(record.homepage)
  );
}

function validatePluginSelector(selector: string): string {
  const normalized = selector.trim();
  if (!SAFE_SELECTOR_PATTERN.test(normalized)) {
    throw errors.invalidQuery("Invalid Claude plugin selector");
  }
  return normalized;
}

function validateMarketplaceSource(source: string): string {
  const normalized = source.trim();
  if (!normalized || UNSAFE_ARGUMENT_PATTERN.test(normalized)) {
    throw errors.invalidQuery("Invalid Claude marketplace source");
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

function emptyStatus(): ClaudePluginRecord["status"] {
  return {
    installed: false,
    available: false,
    enabled: false,
    cached: false,
    local: false,
  };
}

function mergePlugin(map: Map<string, ClaudePluginRecord>, input: MergeRecord): void {
  const rawSelector = input.selector || selectorFor(input.name, input.marketplace);
  const split = splitSelector(rawSelector);
  const name = input.name || split.name;
  const marketplace = input.marketplace || split.marketplace;
  const selector = selectorFor(name, marketplace);
  const prev = map.get(selector);
  const status = { ...(prev?.status ?? emptyStatus()) };
  const availableForInstalled = !!prev?.status.installed && !!input.available && !input.installed;
  status.installed = status.installed || !!input.installed;
  status.available = status.available || !!input.available;
  status.enabled = input.enabled ?? status.enabled;
  status.cached = status.cached || !!input.cached;
  status.local = status.local || !!input.local;

  map.set(selector, {
    name,
    marketplace,
    selector,
    displayName: availableForInstalled
      ? prev?.displayName || input.displayName || name
      : input.displayName || prev?.displayName || name,
    version: availableForInstalled
      ? prev?.version || input.version
      : input.version || prev?.version,
    description: availableForInstalled
      ? prev?.description || input.description
      : input.description || prev?.description,
    icon: availableForInstalled ? prev?.icon || input.icon : input.icon || prev?.icon,
    iconColor: availableForInstalled
      ? prev?.iconColor || input.iconColor
      : input.iconColor || prev?.iconColor,
    scope: availableForInstalled ? prev?.scope || input.scope : input.scope || prev?.scope,
    installCount: input.installCount ?? prev?.installCount,
    status,
    source: {
      kind: availableForInstalled
        ? prev?.source.kind || input.sourceKind || "settings"
        : input.sourceKind || prev?.source.kind || "settings",
      path: availableForInstalled
        ? prev?.source.path || input.sourcePath
        : input.sourcePath || prev?.source.path,
    },
  });
}

function normalizeInstalledPlugin(value: unknown): MergeRecord | null {
  const obj = objectValue(value);
  if (!obj) return null;
  const id = stringValue(obj.id) || stringValue(obj.pluginId);
  if (!id) return null;
  const split = splitSelector(id);
  return {
    name: split.name,
    marketplace: split.marketplace,
    selector: id,
    version: stringValue(obj.version) || undefined,
    scope: stringValue(obj.scope) || undefined,
    installed: true,
    enabled: obj.enabled !== false,
    cached: !!stringValue(obj.installPath),
    sourceKind: "cache",
    sourcePath: stringValue(obj.installPath) || undefined,
  };
}

function normalizeAvailablePlugin(value: unknown): MergeRecord | null {
  const obj = objectValue(value);
  if (!obj) return null;
  const selector = stringValue(obj.pluginId) || stringValue(obj.id);
  const split = selector ? splitSelector(selector) : null;
  const name = stringValue(obj.name) || split?.name || "";
  if (!name) return null;
  const marketplace =
    stringValue(obj.marketplaceName) ||
    stringValue(obj.marketplace) ||
    split?.marketplace ||
    undefined;
  const source = obj.source;
  const sourcePath =
    typeof source === "string"
      ? source
      : stringValue(objectValue(source)?.path) ||
        stringValue(objectValue(source)?.url) ||
        undefined;
  const sourceUrl =
    typeof source === "string" && /^https?:\/\//i.test(source)
      ? source
      : stringValue(objectValue(source)?.url) || undefined;
  const icon = stringValue(obj.icon) || stringValue(obj.composerIcon) || stringValue(obj.logo);
  const author = objectValue(obj.author);
  return {
    name,
    marketplace,
    selector: selector || undefined,
    displayName: name,
    version: stringValue(obj.version) || undefined,
    description: stringValue(obj.description) || undefined,
    icon: icon ? browserSafeIconUrl(icon) : undefined,
    iconColor: stringValue(obj.iconColor) || stringValue(obj.brandColor) || undefined,
    homepage: stringValue(obj.homepage) || undefined,
    authorName: stringValue(author?.name) || stringValue(obj.author) || undefined,
    sourceUrl,
    installCount: numberValue(obj.installCount),
    available: true,
    sourceKind: "marketplace",
    sourcePath,
  };
}

function normalizeMarketplace(value: unknown): ClaudeMarketplaceRecord | null {
  const obj = objectValue(value);
  if (!obj) return null;
  const name = stringValue(obj.name);
  if (!name) return null;
  return {
    name,
    source: stringValue(obj.source) || undefined,
    repo: stringValue(obj.repo) || undefined,
    url: stringValue(obj.url) || undefined,
    path: stringValue(obj.installLocation) || stringValue(obj.path) || undefined,
  };
}

async function readJsonFile(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8")) as unknown;
  } catch {
    return null;
  }
}

const MAX_PLUGIN_ICON_BYTES = 256 * 1024;

function browserSafeIconUrl(value: string): string | undefined {
  if (/^data:image\/(?:svg\+xml|png|jpe?g|gif|webp|x-icon);/i.test(value)) {
    return value;
  }
  if (/^https?:\/\//i.test(value)) return value;
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
  manifests: unknown[],
  pluginRoot: string,
): Promise<string | undefined> {
  const candidate = manifests.map(manifestIconCandidate).find(Boolean);
  if (!candidate) return undefined;

  const browserUrl = browserSafeIconUrl(candidate);
  if (browserUrl) return browserUrl;

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
  pluginRoot: string,
): Promise<
  Pick<
    MergeRecord,
    "displayName" | "version" | "description" | "icon" | "iconColor" | "homepage" | "authorName"
  >
> {
  const manifests = (
    await Promise.all([
      readJsonFile(path.join(pluginRoot, ".claude-plugin", "plugin.json")),
      readJsonFile(path.join(pluginRoot, ".codex-plugin", "plugin.json")),
    ])
  ).filter((manifest): manifest is Record<string, unknown> => !!objectValue(manifest));

  const values = manifests.map((manifest) => {
    const obj = objectValue(manifest);
    const ui = objectValue(obj?.interface);
    const author = objectValue(obj?.author);
    return {
      displayName: stringValue(ui?.displayName) || stringValue(obj?.displayName),
      name: stringValue(obj?.name),
      version: stringValue(obj?.version),
      shortDescription: stringValue(ui?.shortDescription),
      description: stringValue(obj?.description),
      homepage: stringValue(obj?.homepage),
      authorName: stringValue(author?.name) || stringValue(obj?.author),
      iconColor: stringValue(ui?.brandColor) || stringValue(obj?.brandColor),
    };
  });

  return {
    displayName:
      values.map((value) => value.displayName).find(Boolean) ||
      values.map((value) => value.name).find(Boolean),
    version: values.map((value) => value.version).find(Boolean),
    description:
      values.map((value) => value.shortDescription).find(Boolean) ||
      values.map((value) => value.description).find(Boolean),
    icon: await loadManifestIcon(manifests, pluginRoot),
    iconColor: values.map((value) => value.iconColor).find(Boolean),
    homepage: values.map((value) => value.homepage).find(Boolean),
    authorName: values.map((value) => value.authorName).find(Boolean),
  };
}

async function enrichInstalledRecord(record: MergeRecord): Promise<MergeRecord> {
  if (!record.sourcePath) return record;
  const metadata = await manifestMetadata(record.sourcePath);
  return {
    ...record,
    displayName: metadata.displayName || record.displayName,
    version: metadata.version || record.version,
    description: metadata.description || record.description,
    icon: metadata.icon || record.icon,
    iconColor: metadata.iconColor || record.iconColor,
    homepage: metadata.homepage || record.homepage,
    authorName: metadata.authorName || record.authorName,
  };
}

function marketplaceRootMap(marketplaces: ClaudeMarketplaceRecord[]): Map<string, string> {
  const roots = new Map<string, string>();
  for (const marketplace of marketplaces) {
    if (marketplace.path) {
      roots.set(marketplace.name, path.resolve(marketplace.path));
    }
  }
  return roots;
}

function sourceFields(value: unknown): Pick<MergeRecord, "sourcePath" | "sourceUrl"> {
  if (typeof value === "string") {
    return {
      sourcePath: value,
      sourceUrl: /^https?:\/\//i.test(value) ? value : undefined,
    };
  }
  const obj = objectValue(value);
  if (!obj) return {};
  return {
    sourcePath: stringValue(obj.path) || stringValue(obj.url) || undefined,
    sourceUrl: stringValue(obj.url) || undefined,
  };
}

function marketplaceEntryMetadata(entry: unknown, marketplaceName: string): MergeRecord | null {
  const obj = objectValue(entry);
  if (!obj) return null;
  const name = stringValue(obj.name);
  if (!name) return null;
  const ui = objectValue(obj.interface);
  const author = objectValue(obj.author);
  const source = sourceFields(obj.source);
  const icon =
    stringValue(ui?.composerIcon) ||
    stringValue(ui?.logo) ||
    stringValue(ui?.icon) ||
    stringValue(obj.composerIcon) ||
    stringValue(obj.logo) ||
    stringValue(obj.icon);
  return {
    name,
    marketplace: marketplaceName,
    selector: selectorFor(name, marketplaceName),
    displayName: stringValue(ui?.displayName) || stringValue(obj.displayName) || undefined,
    description: stringValue(ui?.shortDescription) || stringValue(obj.description) || undefined,
    icon: icon ? browserSafeIconUrl(icon) : undefined,
    iconColor: stringValue(ui?.brandColor) || stringValue(obj.brandColor) || undefined,
    homepage: stringValue(obj.homepage) || undefined,
    authorName: stringValue(author?.name) || stringValue(obj.author) || undefined,
    sourceUrl: source.sourceUrl,
    available: true,
    sourceKind: "marketplace",
    sourcePath: source.sourcePath,
  };
}

async function marketplacePluginMetadata(
  marketplaces: ClaudeMarketplaceRecord[],
): Promise<Map<string, MergeRecord>> {
  const out = new Map<string, MergeRecord>();
  for (const marketplace of marketplaces) {
    if (!marketplace.path) continue;
    const parsed = objectValue(
      await readJsonFile(path.join(marketplace.path, ".claude-plugin", "marketplace.json")),
    );
    const entries = Array.isArray(parsed?.plugins) ? parsed.plugins : [];
    for (const entry of entries) {
      const record = marketplaceEntryMetadata(entry, marketplace.name);
      if (record) out.set(record.selector || selectorFor(record.name, record.marketplace), record);
    }
  }
  return out;
}

function mergeAvailableMetadata(record: MergeRecord, metadata?: MergeRecord): MergeRecord {
  if (!metadata) return record;
  return {
    ...record,
    displayName: metadata.displayName || record.displayName,
    version: metadata.version || record.version,
    description: metadata.description || record.description,
    icon: metadata.icon || record.icon,
    iconColor: metadata.iconColor || record.iconColor,
    homepage: record.homepage || metadata.homepage,
    authorName: record.authorName || metadata.authorName,
    sourceUrl: record.sourceUrl || metadata.sourceUrl,
    sourcePath: record.sourcePath || metadata.sourcePath,
  };
}

function resolveAvailablePluginRoot(
  record: MergeRecord,
  marketplaceRoots: Map<string, string>,
): string | undefined {
  if (!record.marketplace || !record.sourcePath) return undefined;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(record.sourcePath)) return undefined;

  const marketplaceRoot = marketplaceRoots.get(record.marketplace);
  if (!marketplaceRoot) return undefined;

  const pluginRoot = path.isAbsolute(record.sourcePath)
    ? path.resolve(record.sourcePath)
    : path.resolve(marketplaceRoot, path.normalize(record.sourcePath));
  if (!pathInside(marketplaceRoot, pluginRoot)) return undefined;
  return pluginRoot;
}

async function enrichAvailableRecord(
  record: MergeRecord,
  marketplaceRoots: Map<string, string>,
): Promise<MergeRecord> {
  const pluginRoot = resolveAvailablePluginRoot(record, marketplaceRoots);
  if (!pluginRoot) {
    return {
      ...record,
      icon: record.icon || derivedBrandIcon(record),
    };
  }

  const metadata = await manifestMetadata(pluginRoot);
  const enriched = {
    ...record,
    displayName: metadata.displayName || record.displayName,
    version: metadata.version || record.version,
    description: metadata.description || record.description,
    icon: metadata.icon || record.icon,
    iconColor: metadata.iconColor || record.iconColor,
    homepage: metadata.homepage || record.homepage,
    authorName: metadata.authorName || record.authorName,
  };
  return {
    ...enriched,
    icon: enriched.icon || derivedBrandIcon(enriched),
  };
}

async function enrichInstalledPluginsFromMarketplace(
  plugins: Map<string, ClaudePluginRecord>,
  metadataBySelector: Map<string, MergeRecord>,
  marketplaceRoots: Map<string, string>,
): Promise<void> {
  for (const [selector, plugin] of plugins) {
    if (!plugin.status.installed || plugin.icon) continue;
    const metadata = metadataBySelector.get(selector);
    if (!metadata) continue;
    const enriched = await enrichAvailableRecord(metadata, marketplaceRoots);
    plugins.set(selector, {
      ...plugin,
      displayName:
        plugin.displayName === plugin.name
          ? enriched.displayName || plugin.displayName
          : plugin.displayName,
      description: plugin.description || enriched.description,
      icon: enriched.icon,
      iconColor: plugin.iconColor || enriched.iconColor,
      installCount: plugin.installCount ?? enriched.installCount,
    });
  }
}

export async function getClaudePluginSnapshot(
  options: ClaudePluginServiceOptions = {},
): Promise<ClaudePluginSnapshot> {
  const paths = resolveClaudePluginPaths(options.paths);
  const runCli = options.runCli ?? runClaudePluginCli;
  const warnings: string[] = [];
  const map = new Map<string, ClaudePluginRecord>();
  const marketplaces: ClaudeMarketplaceRecord[] = [];
  const availableRecords: MergeRecord[] = [];

  try {
    const parsed = objectValue(
      parseClaudeCliJson(await runCli(["plugin", "list", "--available", "--json"])),
    );
    for (const item of Array.isArray(parsed?.installed) ? parsed.installed : []) {
      const record = normalizeInstalledPlugin(item);
      if (record) mergePlugin(map, await enrichInstalledRecord(record));
    }
    for (const item of Array.isArray(parsed?.available) ? parsed.available : []) {
      const record = normalizeAvailablePlugin(item);
      if (record) availableRecords.push(record);
    }
  } catch (error) {
    warnings.push(`Claude plugin list failed: ${(error as Error).message}`);
  }

  try {
    const parsed = parseClaudeCliJson(await runCli(["plugin", "marketplace", "list", "--json"]));
    const parsedObject = objectValue(parsed);
    const marketplaceItems: unknown[] = Array.isArray(parsed)
      ? parsed
      : Array.isArray(parsedObject?.marketplaces)
        ? parsedObject.marketplaces
        : [];
    for (const item of marketplaceItems) {
      const marketplace = normalizeMarketplace(item);
      if (marketplace) marketplaces.push(marketplace);
    }
  } catch (error) {
    warnings.push(`Claude marketplace list failed: ${(error as Error).message}`);
  }

  const marketplaceRoots = marketplaceRootMap(marketplaces);
  const availableMetadata = await marketplacePluginMetadata(marketplaces);
  await enrichInstalledPluginsFromMarketplace(map, availableMetadata, marketplaceRoots);
  for (const record of availableRecords) {
    const withMetadata = mergeAvailableMetadata(
      record,
      availableMetadata.get(selectorFor(record.name, record.marketplace)),
    );
    mergePlugin(map, await enrichAvailableRecord(withMetadata, marketplaceRoots));
  }
  for (const metadata of availableMetadata.values()) {
    const selector = selectorFor(metadata.name, metadata.marketplace);
    if (map.has(selector)) continue;
    mergePlugin(map, await enrichAvailableRecord(metadata, marketplaceRoots));
  }

  const plugins = [...map.values()]
    .map((plugin) => ({
      ...plugin,
      icon: plugin.icon || fallbackPluginIcon(plugin.name),
    }))
    .sort((a, b) => {
      const groupA = a.status.installed ? 0 : 1;
      const groupB = b.status.installed ? 0 : 1;
      if (groupA !== groupB) return groupA - groupB;
      return a.displayName.localeCompare(b.displayName);
    });

  return { plugins, marketplaces, warnings, paths };
}

export async function installClaudePlugin(
  selector: string,
  options: ClaudePluginServiceOptions = {},
): Promise<unknown> {
  const runCli = options.runCli ?? runClaudePluginCli;
  const output = await runCli(["plugin", "install", validatePluginSelector(selector)]);
  return { output };
}

export async function uninstallClaudePlugin(
  selector: string,
  options: ClaudePluginServiceOptions = {},
): Promise<unknown> {
  const runCli = options.runCli ?? runClaudePluginCli;
  const pluginSelector = validatePluginSelector(selector);
  const requestedScope = options.scope?.trim();
  if (requestedScope && !/^[a-z0-9_-]+$/i.test(requestedScope)) {
    throw errors.invalidQuery("Invalid Claude plugin scope");
  }

  const scopes = requestedScope
    ? [requestedScope, ...CLAUDE_PLUGIN_SCOPES.filter((scope) => scope !== requestedScope)]
    : [undefined, ...CLAUDE_PLUGIN_SCOPES];
  let lastError: unknown;
  for (let index = 0; index < scopes.length; index += 1) {
    const scope = scopes[index];
    const args = ["plugin", "uninstall", pluginSelector, "--yes"];
    if (scope) args.push("--scope", scope);
    try {
      return { output: await runCli(args) };
    } catch (error) {
      lastError = error;
      const message = error instanceof Error ? error.message : String(error);
      const canTryAnotherScope =
        index < scopes.length - 1 && /not installed in .*scope|use\s+--scope\b/i.test(message);
      if (!canTryAnotherScope) throw error;
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

export async function enableClaudePlugin(
  selector: string,
  options: ClaudePluginServiceOptions = {},
): Promise<unknown> {
  const runCli = options.runCli ?? runClaudePluginCli;
  const output = await runCli(["plugin", "enable", validatePluginSelector(selector)]);
  return { output };
}

export async function disableClaudePlugin(
  selector: string,
  options: ClaudePluginServiceOptions = {},
): Promise<unknown> {
  const runCli = options.runCli ?? runClaudePluginCli;
  const output = await runCli(["plugin", "disable", validatePluginSelector(selector)]);
  return { output };
}

/**
 * Apply a workflow block's enabled set without installing or uninstalling
 * anything. Only plugins reported as installed by Claude Code are eligible.
 */
export async function applyClaudePluginSelection(
  selectedSelectors: string[],
  options: ClaudePluginServiceOptions = {},
): Promise<ClaudePluginSnapshot> {
  const snapshot = await getClaudePluginSnapshot(options);
  const selected = new Set(
    selectedSelectors
      .filter((selector): selector is string => typeof selector === "string")
      .map(validatePluginSelector),
  );
  for (const plugin of snapshot.plugins) {
    if (!plugin.status.installed) continue;
    const shouldEnable = selected.has(plugin.selector);
    if (plugin.status.enabled === shouldEnable) continue;
    if (shouldEnable) await enableClaudePlugin(plugin.selector, options);
    else await disableClaudePlugin(plugin.selector, options);
  }
  return await getClaudePluginSnapshot(options);
}

export async function addClaudeMarketplace(
  source: string,
  options: ClaudePluginServiceOptions = {},
): Promise<unknown> {
  const runCli = options.runCli ?? runClaudePluginCli;
  const output = await runCli(["plugin", "marketplace", "add", validateMarketplaceSource(source)]);
  return { output };
}
