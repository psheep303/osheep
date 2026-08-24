import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { TomlTable } from "smol-toml";
import { parse as parseToml, stringify as stringifyToml } from "smol-toml";
import { APP_SETTINGS_DIR } from "./app-settings.js";
import { errors } from "./errors.js";

export type AiSettingsApp = "claude" | "codex";

export interface AiProvider {
  id: string;
  name: string;
  settingsConfig: unknown;
  websiteUrl?: string;
  category?: string;
  createdAt?: number;
  sortIndex?: number;
  notes?: string;
  meta?: Record<string, unknown>;
  icon?: string;
  iconColor?: string;
  inFailoverQueue?: boolean;
  /** Osheep-only billing multiplier. Never serialized into the native CLI config. */
  billingMultiplier?: number;
}

export interface AiProviderManager {
  providers: Record<string, AiProvider>;
  current: string;
}

export interface AiSettingsState {
  version: 1;
  apps: Record<AiSettingsApp, AiProviderManager>;
}

export interface AiSettingsSnapshot {
  state: AiSettingsState;
  paths: {
    store: string;
    claude: { dir: string; settings: string; exists: boolean };
    codex: {
      dir: string;
      auth: string;
      config: string;
      authExists: boolean;
      configExists: boolean;
    };
  };
}

const RESERVED_CODEX_MODEL_PROVIDER_IDS = new Set([
  "amazon-bedrock",
  "openai",
  "ollama",
  "lmstudio",
  "oss",
  "ollama-chat",
]);

const INTERNAL_CLAUDE_KEYS = [
  "api_format",
  "apiFormat",
  "openrouter_compat_mode",
  "openrouterCompatMode",
];

function getStorePath(): string {
  return path.resolve(
    process.env.OSHEEP_AI_SETTINGS_STORE_PATH || path.join(APP_SETTINGS_DIR, "ai-settings.json"),
  );
}

function defaultState(): AiSettingsState {
  return {
    version: 1,
    apps: {
      claude: { providers: {}, current: "" },
      codex: { providers: {}, current: "" },
    },
  };
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function normalizeState(raw: unknown): AiSettingsState {
  const state = defaultState();
  const obj = asObject(raw);
  const apps = asObject(obj?.apps);
  for (const app of ["claude", "codex"] as const) {
    const manager = asObject(apps?.[app]);
    const providers = asObject(manager?.providers);
    const nextProviders: Record<string, AiProvider> = {};
    if (providers) {
      for (const [id, value] of Object.entries(providers)) {
        const provider = normalizeProvider(value, id);
        if (provider) nextProviders[provider.id] = provider;
      }
    }
    const current =
      typeof manager?.current === "string" && nextProviders[manager.current] ? manager.current : "";
    state.apps[app] = { providers: nextProviders, current };
  }
  return state;
}

function normalizeProvider(value: unknown, fallbackId?: string): AiProvider | null {
  const obj = asObject(value);
  if (!obj) return null;
  const rawId = typeof obj.id === "string" ? obj.id.trim() : fallbackId?.trim();
  if (!rawId) return null;
  const name = typeof obj.name === "string" && obj.name.trim() ? obj.name.trim() : rawId;
  const billingMultiplier = normalizeBillingMultiplier(obj.billingMultiplier);
  return {
    ...(obj as Omit<AiProvider, "id" | "name">),
    id: rawId,
    name,
    settingsConfig: obj.settingsConfig ?? {},
    billingMultiplier,
  };
}

export function normalizeBillingMultiplier(value: unknown): number | undefined {
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isFinite(parsed) || parsed <= 0) return undefined;
  return Math.min(parsed, 1_000_000);
}

export function providerBillingMultiplier(provider: AiProvider | undefined): number {
  return normalizeBillingMultiplier(provider?.billingMultiplier) ?? 1;
}

export async function readAiSettings(): Promise<AiSettingsState> {
  try {
    const text = await fs.readFile(getStorePath(), "utf8");
    return normalizeState(JSON.parse(text));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return defaultState();
    if (e instanceof SyntaxError) {
      throw errors.invalidQuery(`AI settings JSON is invalid: ${e.message}`);
    }
    throw e;
  }
}

export async function writeAiSettings(state: AiSettingsState): Promise<void> {
  const normalized = normalizeState(state);
  await atomicWriteText(getStorePath(), `${JSON.stringify(normalized, null, 2)}\n`);
}

export async function snapshotAiSettings(): Promise<AiSettingsSnapshot> {
  const state = await readAiSettings();
  return {
    state,
    paths: {
      store: getStorePath(),
      claude: {
        dir: getClaudeConfigDir(),
        settings: getClaudeSettingsPath(),
        exists: await exists(getClaudeSettingsPath()),
      },
      codex: {
        dir: getCodexConfigDir(),
        auth: getCodexAuthPath(),
        config: getCodexConfigPath(),
        authExists: await exists(getCodexAuthPath()),
        configExists: await exists(getCodexConfigPath()),
      },
    },
  };
}

export async function upsertAiProvider(
  app: AiSettingsApp,
  provider: AiProvider,
  originalId?: string,
  apply = false,
): Promise<AiSettingsSnapshot> {
  const state = await readAiSettings();
  const normalized = normalizeProvider(provider);
  if (!normalized) throw errors.invalidQuery("Provider id is required");
  validateProvider(app, normalized);

  const manager = state.apps[app];
  const previousId = originalId && originalId !== normalized.id ? originalId : null;
  if (previousId) delete manager.providers[previousId];
  manager.providers[normalized.id] = normalized;
  if (!manager.current || apply || manager.current === previousId) {
    manager.current = normalized.id;
  }

  const shouldApply = apply || manager.current === normalized.id;
  const liveSnapshot = shouldApply ? await captureLiveSnapshot(app) : null;
  if (shouldApply) await writeProviderToLive(app, normalized);
  try {
    await writeAiSettings(state);
  } catch (error) {
    if (liveSnapshot) await restoreLiveSnapshot(app, liveSnapshot).catch(() => undefined);
    throw error;
  }
  return snapshotAiSettings();
}

export async function deleteAiProvider(
  app: AiSettingsApp,
  id: string,
): Promise<AiSettingsSnapshot> {
  const state = await readAiSettings();
  const manager = state.apps[app];
  if (manager.current === id) {
    throw errors.invalidQuery("Cannot delete the active provider");
  }
  delete manager.providers[id];
  await writeAiSettings(state);
  return snapshotAiSettings();
}

export async function switchAiProvider(
  app: AiSettingsApp,
  id: string,
): Promise<AiSettingsSnapshot> {
  const state = await readAiSettings();
  const manager = state.apps[app];
  const provider = manager.providers[id];
  if (!provider) throw errors.notFound(`Provider not found: ${id}`);
  validateProvider(app, provider);

  if (manager.current && manager.current !== id) {
    await backfillCurrentProviderFromLive(state, app, manager.current);
  }

  const liveSnapshot = await captureLiveSnapshot(app);
  await writeProviderToLive(app, provider);
  manager.current = id;
  try {
    await writeAiSettings(state);
  } catch (error) {
    await restoreLiveSnapshot(app, liveSnapshot).catch(() => undefined);
    throw error;
  }
  return snapshotAiSettings();
}

export async function importLiveProvider(
  app: AiSettingsApp,
  id = "default",
  name = app === "claude" ? "Claude live" : "Codex live",
): Promise<AiSettingsSnapshot> {
  const state = await readAiSettings();
  const settingsConfig = normalizeImportedLiveSettings(app, await readLiveSettings(app));
  const providerId = nextAvailableProviderId(state.apps[app].providers, id);
  const provider: AiProvider = {
    id: providerId,
    name,
    settingsConfig,
    category: detectImportedProviderCategory(app, settingsConfig),
    createdAt: Date.now(),
  };

  // Import is intentionally separate from the normal save/apply flow. The live
  // files are the source of truth here: they may have been edited outside
  // Osheep, so importing must only persist/select the new provider and never
  // serialize the stored current provider back over those source files.
  validateProvider(app, provider);
  const manager = state.apps[app];
  manager.providers[provider.id] = provider;
  manager.current = provider.id;
  await writeAiSettings(state);
  return snapshotAiSettings();
}

export async function readLiveSettings(app: AiSettingsApp): Promise<unknown> {
  if (app === "claude") {
    const settingsPath = getClaudeSettingsPath();
    if (!(await exists(settingsPath))) {
      throw errors.notFound("Claude settings.json was not found");
    }
    return readJson(settingsPath);
  }

  const authPath = getCodexAuthPath();
  const configPath = getCodexConfigPath();
  const authPresent = await exists(authPath);
  const configPresent = await exists(configPath);
  const auth = authPresent ? await readJson(authPath) : {};
  const config = configPresent ? await fs.readFile(configPath, "utf8") : "";
  validateTomlText(config, "Codex config.toml");
  if (!authPresent && !config.trim()) {
    throw errors.notFound("Codex auth.json/config.toml was not found");
  }
  return { auth, config };
}

async function writeProviderToLive(app: AiSettingsApp, provider: AiProvider): Promise<void> {
  validateProvider(app, provider);
  if (app === "claude") {
    await writeClaudeLive(provider.settingsConfig);
    return;
  }
  await writeCodexLive(provider);
}

async function backfillCurrentProviderFromLive(
  state: AiSettingsState,
  app: AiSettingsApp,
  currentId: string,
): Promise<void> {
  const currentProvider = state.apps[app].providers[currentId];
  if (!currentProvider) return;

  try {
    const liveSettings = normalizeBackfilledLiveSettings(
      app,
      await readLiveSettings(app),
      currentProvider,
    );
    currentProvider.settingsConfig = liveSettings;
  } catch {
    // Match cc-switch behavior: switching should continue even if live backfill is unavailable.
  }
}

function normalizeImportedLiveSettings(app: AiSettingsApp, settingsConfig: unknown): unknown {
  if (app !== "claude") return settingsConfig;
  const settings = structuredClone(asObject(settingsConfig) ?? {});
  normalizeClaudeModelKeys(settings);
  return settings;
}

function normalizeBackfilledLiveSettings(
  app: AiSettingsApp,
  liveSettings: unknown,
  templateProvider: AiProvider,
): unknown {
  if (app === "claude") return normalizeImportedLiveSettings(app, liveSettings);
  return restoreCodexSettingsForBackfill(liveSettings, templateProvider);
}

function detectImportedProviderCategory(app: AiSettingsApp, settingsConfig: unknown): string {
  if (app !== "codex") return "custom";

  const settings = asObject(settingsConfig);
  const auth = asObject(settings?.auth);
  const configText = typeof settings?.config === "string" ? settings.config : "";
  const hasProviderKey = !!extractCodexApiKey(auth, configText);
  const hasLoginMaterial = !!auth && codexAuthHasLoginMaterial(auth);
  return hasLoginMaterial && !hasProviderKey ? "official" : "custom";
}

function validateProvider(app: AiSettingsApp, provider: AiProvider): void {
  if (!provider.id.trim()) throw errors.invalidQuery("Provider id is required");
  const settings = asObject(provider.settingsConfig);
  if (!settings) throw errors.invalidQuery("settingsConfig must be a JSON object");

  if (app === "codex") {
    const auth = settings.auth;
    if (!asObject(auth)) throw errors.invalidQuery("Codex settingsConfig.auth must be an object");
    const config = settings.config;
    if (config !== undefined && config !== null && typeof config !== "string") {
      throw errors.invalidQuery("Codex settingsConfig.config must be a string or null");
    }
    validateTomlText(typeof config === "string" ? config : "", "Codex config.toml");
  }
}

async function writeClaudeLive(settingsConfig: unknown): Promise<void> {
  const settings = structuredClone(asObject(settingsConfig) ?? {});
  for (const key of INTERNAL_CLAUDE_KEYS) delete settings[key];
  await writeJson(getClaudeSettingsPath(), settings);
}

async function writeCodexLive(provider: AiProvider): Promise<void> {
  const settings = asObject(provider.settingsConfig);
  if (!settings) throw errors.invalidQuery("Codex settingsConfig must be an object");

  const auth = asObject(settings.auth);
  if (!auth) throw errors.invalidQuery("Codex settingsConfig.auth must be an object");
  const rawConfig = typeof settings.config === "string" ? settings.config : "";
  validateTomlText(rawConfig, "Codex config.toml");

  if (provider.category !== "official" || codexAuthHasLoginMaterial(auth)) {
    await writeCodexLiveAtomic(auth, rawConfig);
    return;
  }

  const liveConfig = prepareCodexProviderLiveConfig(auth, rawConfig);
  await atomicWriteText(getCodexConfigPath(), liveConfig);
}

interface FileSnapshot {
  exists: boolean;
  contents?: Buffer;
}

interface LiveSnapshot {
  claude?: FileSnapshot;
  codexAuth?: FileSnapshot;
  codexConfig?: FileSnapshot;
}

async function captureFile(filePath: string): Promise<FileSnapshot> {
  try {
    return { exists: true, contents: await fs.readFile(filePath) };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { exists: false };
    throw error;
  }
}

async function restoreFile(filePath: string, snapshot: FileSnapshot): Promise<void> {
  if (!snapshot.exists) {
    await fs.rm(filePath, { force: true });
    return;
  }
  await atomicWrite(filePath, snapshot.contents ?? Buffer.alloc(0));
}

async function captureLiveSnapshot(app: AiSettingsApp): Promise<LiveSnapshot> {
  if (app === "claude") return { claude: await captureFile(getClaudeSettingsPath()) };
  return {
    codexAuth: await captureFile(getCodexAuthPath()),
    codexConfig: await captureFile(getCodexConfigPath()),
  };
}

async function restoreLiveSnapshot(app: AiSettingsApp, snapshot: LiveSnapshot): Promise<void> {
  if (app === "claude" && snapshot.claude) {
    await restoreFile(getClaudeSettingsPath(), snapshot.claude);
    return;
  }
  if (app === "codex" && snapshot.codexAuth && snapshot.codexConfig) {
    await restoreFile(getCodexAuthPath(), snapshot.codexAuth);
    await restoreFile(getCodexConfigPath(), snapshot.codexConfig);
  }
}

async function writeCodexLiveAtomic(
  auth: Record<string, unknown>,
  configText: string,
): Promise<void> {
  const authPath = getCodexAuthPath();
  const authSnapshot = await captureFile(authPath);
  await writeJson(authPath, auth);
  try {
    await atomicWriteText(getCodexConfigPath(), configText);
  } catch (error) {
    await restoreFile(authPath, authSnapshot).catch(() => undefined);
    throw error;
  }
}

function prepareCodexProviderLiveConfig(auth: Record<string, unknown>, configText: string): string {
  const authToken = stringValue(auth.OPENAI_API_KEY);
  const token = authToken || extractCodexExperimentalBearerToken(configText);
  if (!token) return configText;
  if (!configText.trim()) {
    throw errors.invalidQuery(
      "Codex third-party provider needs config.toml before an API key can be projected",
    );
  }
  return setCodexExperimentalBearerToken(configText, token);
}

function restoreCodexSettingsForBackfill(
  liveSettings: unknown,
  templateProvider: AiProvider,
): unknown {
  const settings = structuredClone(asObject(liveSettings) ?? {});
  const configText = typeof settings.config === "string" ? settings.config : "";
  const token = extractCodexExperimentalBearerToken(configText);
  if (!token || !shouldRestoreCodexProviderTokenForBackfill(templateProvider)) return settings;

  settings.config = removeCodexExperimentalBearerToken(configText);
  const templateSettings = asObject(templateProvider.settingsConfig);
  const templateAuth = asObject(templateSettings?.auth);
  const auth = structuredClone(templateAuth ?? {});
  auth.OPENAI_API_KEY = token;
  settings.auth = auth;
  return settings;
}

function shouldRestoreCodexProviderTokenForBackfill(provider: AiProvider): boolean {
  if (provider.category === "official") return false;

  const settings = asObject(provider.settingsConfig);
  const auth = asObject(settings?.auth);
  if (!auth) return true;

  const hasProviderApiKey = !!stringValue(auth.OPENAI_API_KEY);
  const hasOauthLogin = codexAuthHasOauthLoginMaterial(auth);
  return !hasOauthLogin || hasProviderApiKey;
}

function extractCodexApiKey(
  auth: Record<string, unknown> | null | undefined,
  configText: string,
): string {
  return stringValue(auth?.OPENAI_API_KEY) || extractCodexExperimentalBearerToken(configText);
}

function extractCodexExperimentalBearerToken(configText: string): string {
  const parsed = safeParseToml(configText);
  const providerId = stringValue(parsed?.model_provider);
  if (providerId && isCustomCodexProviderId(providerId)) {
    const modelProviders = asObject(parsed?.model_providers);
    const provider = asObject(modelProviders?.[providerId]);
    const providerToken = stringValue(provider?.experimental_bearer_token);
    if (providerToken) return providerToken;
  }
  return stringValue(parsed?.experimental_bearer_token);
}

function setCodexExperimentalBearerToken(configText: string, token: string): string {
  try {
    const parsed = parseToml(configText);
    const providerId = stringValue(parsed?.model_provider);

    if (providerId && isCustomCodexProviderId(providerId)) {
      // Set token in custom provider section
      const modelProviders = (asObject(parsed.model_providers) ?? {}) as TomlTable;
      parsed.model_providers = modelProviders;
      const providerConfig = (asObject(modelProviders[providerId]) ?? {}) as TomlTable;
      modelProviders[providerId] = providerConfig;
      providerConfig.experimental_bearer_token = token;
    } else {
      // Set token at top level
      parsed.experimental_bearer_token = token;
    }

    return stringifyToml(parsed);
  } catch (_e) {
    // If parsing fails, append token at the end
    return `${configText}\nexperimental_bearer_token = "${token}"\n`;
  }
}

function removeCodexExperimentalBearerToken(configText: string): string {
  if (!configText.trim() || !configText.includes("experimental_bearer_token")) return configText;
  const parsed = parseToml(configText);
  const providerId = stringValue(parsed?.model_provider);

  if (providerId && isCustomCodexProviderId(providerId)) {
    const modelProviders = asObject(parsed.model_providers);
    const providerConfig = asObject(modelProviders?.[providerId]);
    if (providerConfig) delete providerConfig.experimental_bearer_token;
  }
  delete parsed.experimental_bearer_token;

  return stringifyToml(parsed);
}

function isCustomCodexProviderId(id: string): boolean {
  const normalized = id.trim().toLowerCase();
  return !!normalized && !RESERVED_CODEX_MODEL_PROVIDER_IDS.has(normalized);
}

function safeParseToml(text: string): Record<string, unknown> | null {
  if (!text.trim()) return {};
  try {
    return parseToml(text) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function normalizeClaudeModelKeys(settings: Record<string, unknown>): void {
  const env = asObject(settings.env);
  if (!env) return;
  const model = stringValue(env.ANTHROPIC_MODEL);
  const smallFast = stringValue(env.ANTHROPIC_SMALL_FAST_MODEL);
  if (env.ANTHROPIC_DEFAULT_HAIKU_MODEL === undefined) {
    const value = smallFast || model;
    if (value) env.ANTHROPIC_DEFAULT_HAIKU_MODEL = value;
  }
  if (env.ANTHROPIC_DEFAULT_SONNET_MODEL === undefined) {
    const value = model || smallFast;
    if (value) env.ANTHROPIC_DEFAULT_SONNET_MODEL = value;
  }
  if (env.ANTHROPIC_DEFAULT_OPUS_MODEL === undefined) {
    const value = model || smallFast;
    if (value) env.ANTHROPIC_DEFAULT_OPUS_MODEL = value;
  }
  delete env.ANTHROPIC_SMALL_FAST_MODEL;
}

function codexAuthHasLoginMaterial(auth: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(auth)) {
    if (key === "auth_mode") continue;
    if (key === "OPENAI_API_KEY") {
      if (stringValue(value)) return true;
      continue;
    }
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (asObject(value) && Object.keys(value as Record<string, unknown>).length === 0) continue;
    return true;
  }
  return false;
}

function codexAuthHasOauthLoginMaterial(auth: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(auth)) {
    if (key === "auth_mode" || key === "OPENAI_API_KEY") continue;
    if (value === null || value === undefined) continue;
    if (typeof value === "string" && !value.trim()) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    if (asObject(value) && Object.keys(value as Record<string, unknown>).length === 0) continue;
    return true;
  }
  return false;
}

function validateTomlText(text: string, label: string): void {
  if (!text.trim()) return;
  try {
    parseToml(text);
  } catch (e) {
    throw errors.invalidQuery(`${label} is invalid: ${(e as Error).message}`);
  }
}

function getClaudeConfigDir(): string {
  return path.resolve(
    process.env.CLAUDE_CONFIG_DIR ||
      process.env.OSHEEP_CLAUDE_CONFIG_DIR ||
      path.join(os.homedir() || ".", ".claude"),
  );
}

function getClaudeSettingsPath(): string {
  const dir = getClaudeConfigDir();
  const settings = path.join(dir, "settings.json");
  const legacy = path.join(dir, "claude.json");
  return existsSync(settings) || !existsSync(legacy) ? settings : legacy;
}

function getCodexConfigDir(): string {
  return path.resolve(
    process.env.CODEX_HOME ||
      process.env.OSHEEP_CODEX_CONFIG_DIR ||
      path.join(os.homedir() || ".", ".codex"),
  );
}

function getCodexAuthPath(): string {
  return path.join(getCodexConfigDir(), "auth.json");
}

function getCodexConfigPath(): string {
  return path.join(getCodexConfigDir(), "config.toml");
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath: string): Promise<unknown> {
  const text = await fs.readFile(filePath, "utf8");
  try {
    return JSON.parse(text) as unknown;
  } catch (e) {
    throw errors.invalidQuery(`${filePath} is invalid JSON: ${(e as Error).message}`);
  }
}

async function writeJson(filePath: string, value: unknown): Promise<void> {
  await atomicWriteText(filePath, `${JSON.stringify(sortJson(value), null, 2)}\n`);
}

async function atomicWriteText(filePath: string, text: string): Promise<void> {
  await atomicWrite(filePath, Buffer.from(text, "utf8"));
}

async function atomicWrite(filePath: string, contents: Uint8Array): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const temp = path.join(dir, `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  try {
    await fs.writeFile(temp, contents);
    await fs.rename(temp, filePath);
  } catch (error) {
    await fs.rm(temp, { force: true }).catch(() => undefined);
    throw error;
  }
}

function sortJson(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortJson);
  const obj = asObject(value);
  if (!obj) return value;
  return Object.fromEntries(
    Object.keys(obj)
      .sort()
      .map((key) => [key, sortJson(obj[key])]),
  );
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function uniqueProviderId(seed: string): string {
  return (
    seed
      .trim()
      .replace(/[^A-Za-z0-9_.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .toLowerCase() || "default"
  );
}

function nextAvailableProviderId(providers: Record<string, AiProvider>, seed: string): string {
  const base = uniqueProviderId(seed);
  if (!providers[base]) return base;

  for (let index = 2; ; index += 1) {
    const candidate = `${base}-${index}`;
    if (!providers[candidate]) return candidate;
  }
}
