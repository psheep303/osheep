export type TabSize = 2 | 4;

export interface ModelPrice {
  model: string;
  provider: string;
  billingMode: "dynamic" | "per-request";
  costPerRequest?: number;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  cacheWriteCostPerMillion?: number;
  favorite?: boolean;
  favoriteCustomized?: boolean;
  source?: "litellm" | "manual";
  updatedAt?: number;
}

export type AiProviderKind = "codex-cli" | "claude-cli";

export interface AiProvider {
  id: string;
  name: string;
  kind: AiProviderKind;
  models: string[];
}

export const DEFAULT_CLI_PROVIDER: AiProvider = {
  id: "cli",
  name: "CLI",
  kind: "codex-cli",
  models: ["default"],
};

/**
 * Granular auto-allow categories. `run` got split into network / install /
 * git / test / other so the confirmation prompt can be much less spammy for
 * benign command classes while still gating dangerous ones.
 */
export interface AiAutoAllow {
  read: boolean;
  write: boolean;
  runNetwork: boolean;
  runInstall: boolean;
  runGit: boolean;
  runTest: boolean;
  runOther: boolean;
}

export type ReasoningEffort = "off" | "minimal" | "low" | "medium" | "high";

export interface OsheepSettings {
  editor: {
    fontSize: number;
    tabSize: TabSize;
    autoSave: boolean;
  };
  ai: {
    autoAllow: AiAutoAllow;
  };
  pricing: {
    models: ModelPrice[];
  };
}

export const DEFAULT_AUTO_ALLOW: AiAutoAllow = {
  read: true,
  write: false,
  runNetwork: true,
  runInstall: true,
  runGit: true,
  runTest: true,
  runOther: true,
};

export const DEFAULT_SETTINGS: OsheepSettings = {
  editor: { fontSize: 14, tabSize: 2, autoSave: false },
  ai: {
    autoAllow: { ...DEFAULT_AUTO_ALLOW },
  },
  pricing: { models: [] },
};

export function isCliProviderKind(kind: unknown): kind is AiProviderKind {
  return kind === "codex-cli" || kind === "claude-cli";
}

function sanitizeAutoAllow(raw: unknown): AiAutoAllow {
  const r = (raw ?? {}) as Partial<AiAutoAllow> & { run?: unknown };
  // Back-compat: an old setting with `run: true` should expand to all run-*
  // categories being true. `run: false` (or absent) keeps the new defaults.
  const legacyRun = typeof r.run === "boolean" ? r.run : null;
  const pick = (key: keyof AiAutoAllow, fallback: boolean, legacy: boolean | null) =>
    typeof r[key] === "boolean" ? (r[key] as boolean) : (legacy ?? fallback);
  return {
    read: pick("read", DEFAULT_AUTO_ALLOW.read, null),
    write: pick("write", DEFAULT_AUTO_ALLOW.write, null),
    runNetwork: pick("runNetwork", DEFAULT_AUTO_ALLOW.runNetwork, legacyRun),
    runInstall: pick("runInstall", DEFAULT_AUTO_ALLOW.runInstall, legacyRun),
    runGit: pick("runGit", DEFAULT_AUTO_ALLOW.runGit, legacyRun),
    runTest: pick("runTest", DEFAULT_AUTO_ALLOW.runTest, legacyRun),
    runOther: pick("runOther", DEFAULT_AUTO_ALLOW.runOther, legacyRun),
  };
}

export function mergeSettings(partial: unknown): OsheepSettings {
  const p = (partial ?? {}) as {
    editor?: { fontSize?: unknown; tabSize?: unknown; autoSave?: unknown };
    ai?: {
      autoAllow?: unknown;
    };
    pricing?: { models?: unknown };
  };
  const fontSize =
    typeof p.editor?.fontSize === "number" && p.editor.fontSize >= 8 && p.editor.fontSize <= 64
      ? p.editor.fontSize
      : DEFAULT_SETTINGS.editor.fontSize;
  const tabSize: TabSize = p.editor?.tabSize === 4 ? 4 : 2;
  const autoSave =
    typeof p.editor?.autoSave === "boolean" ? p.editor.autoSave : DEFAULT_SETTINGS.editor.autoSave;
  const autoAllow = sanitizeAutoAllow(p.ai?.autoAllow);
  const models = Array.isArray(p.pricing?.models)
    ? p.pricing.models.flatMap((item): ModelPrice[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const value = item as Record<string, unknown>;
        const rawModel = typeof value.model === "string" ? value.model.trim() : "";
        const model = canonicalPriceModelName(rawModel);
        const input = typeof value.inputCostPerMillion === "number" ? value.inputCostPerMillion : NaN;
        const output = typeof value.outputCostPerMillion === "number" ? value.outputCostPerMillion : NaN;
        if (!model || !Number.isFinite(input) || !Number.isFinite(output)) return [];
        return [{
          model,
          provider:
            (typeof value.provider === "string" ? value.provider.trim() : "") ||
            inferModelOriginProvider(rawModel),
          billingMode: value.billingMode === "per-request" ? "per-request" : "dynamic",
          costPerRequest:
            typeof value.costPerRequest === "number" && Number.isFinite(value.costPerRequest)
              ? Math.max(0, value.costPerRequest)
              : undefined,
          inputCostPerMillion: Math.max(0, input),
          outputCostPerMillion: Math.max(0, output),
          cacheReadCostPerMillion:
            typeof value.cacheReadCostPerMillion === "number" && Number.isFinite(value.cacheReadCostPerMillion)
              ? Math.max(0, value.cacheReadCostPerMillion)
              : undefined,
          cacheWriteCostPerMillion:
            typeof value.cacheWriteCostPerMillion === "number" && Number.isFinite(value.cacheWriteCostPerMillion)
              ? Math.max(0, value.cacheWriteCostPerMillion)
              : undefined,
          favorite:
            value.favoriteCustomized === true
              ? value.favorite === true
              : value.favorite === true || isDefaultFavoritePriceModel(model),
          favoriteCustomized: value.favoriteCustomized === true,
          source: value.source === "litellm" ? "litellm" : "manual",
          updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : undefined,
        }];
      })
    : [];
  return {
    editor: { fontSize, tabSize, autoSave },
    ai: {
      autoAllow,
    },
    pricing: { models },
  };
}

const DEFAULT_FAVORITE_PRICE_MODELS = new Set([
  "gpt-5.6-sol",
  "gpt-5.6-terra",
  "gpt-5.6-luna",
  "gpt-5.5",
  "gpt-5.4",
  "claude-fable-5",
  "claude-opus-4-7",
  "claude-opus-4-8",
  "claude-opus-5",
]);

export function inferModelOriginProvider(model: string): string {
  const normalized = model.trim().toLowerCase();
  const namespaced = normalized.match(/(?:^|[/.])(anthropic|openai|google|meta|mistral|cohere|xai|deepseek|qwen)[/.]/);
  if (namespaced?.[1]) return namespaced[1];
  const canonical = normalized.replace(/^.*\//, "");
  if (canonical.startsWith("claude-")) return "anthropic";
  if (/^(?:gpt(?:-|$)|chatgpt-|o[134](?:-|$))/.test(canonical)) return "openai";
  return "";
}

export function canonicalPriceModelName(model: string): string {
  const trimmed = model.trim();
  const provider = inferModelOriginProvider(trimmed);
  if (!provider) return trimmed;
  return trimmed.match(new RegExp(`(?:^|[/.])${provider}[/.](.+)$`, "i"))?.[1]?.trim() || trimmed;
}

function isDefaultFavoritePriceModel(model: string): boolean {
  return DEFAULT_FAVORITE_PRICE_MODELS.has(canonicalPriceModelName(model).toLowerCase());
}

export type ReasoningKind = "cli";

export function detectReasoningKind(_kind: AiProviderKind, _model: string): ReasoningKind | null {
  return null;
}

export function effortLevels(_rk: ReasoningKind): ReasoningEffort[] {
  return ["off", "low", "medium", "high"];
}
