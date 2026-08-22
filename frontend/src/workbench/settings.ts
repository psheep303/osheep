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
  layout: {
    sidebarWidth: number;
  };
  editor: {
    fontSize: number;
    tabSize: TabSize;
    autoSave: boolean;
  };
  ai: {
    autoAllow: AiAutoAllow;
  };
  workflow: {
    maxParallelNodes: number;
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
  layout: { sidebarWidth: 250 },
  editor: { fontSize: 14, tabSize: 2, autoSave: false },
  ai: {
    autoAllow: { ...DEFAULT_AUTO_ALLOW },
  },
  workflow: { maxParallelNodes: 4 },
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
    layout?: { sidebarWidth?: unknown };
    editor?: { fontSize?: unknown; tabSize?: unknown; autoSave?: unknown };
    ai?: {
      autoAllow?: unknown;
    };
    workflow?: { maxParallelNodes?: unknown };
    pricing?: { models?: unknown };
  };
  const sidebarWidth =
    typeof p.layout?.sidebarWidth === "number" &&
    Number.isFinite(p.layout.sidebarWidth) &&
    p.layout.sidebarWidth >= 180 &&
    p.layout.sidebarWidth <= 600
      ? Math.round(p.layout.sidebarWidth)
      : DEFAULT_SETTINGS.layout.sidebarWidth;
  const fontSize =
    typeof p.editor?.fontSize === "number" && p.editor.fontSize >= 8 && p.editor.fontSize <= 64
      ? p.editor.fontSize
      : DEFAULT_SETTINGS.editor.fontSize;
  const tabSize: TabSize = p.editor?.tabSize === 4 ? 4 : 2;
  const autoSave =
    typeof p.editor?.autoSave === "boolean" ? p.editor.autoSave : DEFAULT_SETTINGS.editor.autoSave;
  const autoAllow = sanitizeAutoAllow(p.ai?.autoAllow);
  const maxParallelNodes =
    typeof p.workflow?.maxParallelNodes === "number" &&
    Number.isInteger(p.workflow.maxParallelNodes) &&
    p.workflow.maxParallelNodes >= 1 &&
    p.workflow.maxParallelNodes <= 32
      ? p.workflow.maxParallelNodes
      : DEFAULT_SETTINGS.workflow.maxParallelNodes;
  const parsedModels = Array.isArray(p.pricing?.models)
    ? p.pricing.models.flatMap((item): ModelPrice[] => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const value = item as Record<string, unknown>;
        const model = typeof value.model === "string" ? value.model.trim() : "";
        const provider = typeof value.provider === "string" ? value.provider.trim() : "";
        const input =
          typeof value.inputCostPerMillion === "number" ? value.inputCostPerMillion : NaN;
        const output =
          typeof value.outputCostPerMillion === "number" ? value.outputCostPerMillion : NaN;
        if (!model || !Number.isFinite(input) || !Number.isFinite(output)) return [];
        return [
          {
            model,
            provider,
            billingMode: value.billingMode === "per-request" ? "per-request" : "dynamic",
            costPerRequest:
              typeof value.costPerRequest === "number" && Number.isFinite(value.costPerRequest)
                ? Math.max(0, value.costPerRequest)
                : undefined,
            inputCostPerMillion: Math.max(0, input),
            outputCostPerMillion: Math.max(0, output),
            cacheReadCostPerMillion:
              typeof value.cacheReadCostPerMillion === "number" &&
              Number.isFinite(value.cacheReadCostPerMillion)
                ? Math.max(0, value.cacheReadCostPerMillion)
                : undefined,
            cacheWriteCostPerMillion:
              typeof value.cacheWriteCostPerMillion === "number" &&
              Number.isFinite(value.cacheWriteCostPerMillion)
                ? Math.max(0, value.cacheWriteCostPerMillion)
                : undefined,
            favorite:
              value.favoriteCustomized === true
                ? value.favorite === true
                : value.favorite === true || isDefaultFavoritePriceModel(model, provider),
            favoriteCustomized: value.favoriteCustomized === true,
            source: value.source === "litellm" ? "litellm" : "manual",
            updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : undefined,
          },
        ];
      })
    : [];
  const models = [
    ...new Map(
      parsedModels.map((model) => [model.model.trim().toLowerCase(), model] as const),
    ).values(),
  ];
  return {
    layout: { sidebarWidth },
    editor: { fontSize, tabSize, autoSave },
    ai: {
      autoAllow,
    },
    workflow: { maxParallelNodes },
    pricing: { models },
  };
}

const DEFAULT_FAVORITE_PRICE_PROVIDERS = new Map([
  ["gpt-5.6-sol", "openai"],
  ["gpt-5.6-terra", "openai"],
  ["gpt-5.6-luna", "openai"],
  ["gpt-5.5", "openai"],
  ["gpt-5.4", "openai"],
  ["claude-fable-5", "anthropic"],
  ["claude-opus-4-7", "anthropic"],
  ["claude-opus-4-8", "anthropic"],
  ["claude-opus-5", "anthropic"],
]);

function isDefaultFavoritePriceModel(model: string, provider: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return DEFAULT_FAVORITE_PRICE_PROVIDERS.get(normalizedModel) === provider.trim().toLowerCase();
}

export type ReasoningKind = "cli";

export function detectReasoningKind(_kind: AiProviderKind, _model: string): ReasoningKind | null {
  return null;
}

export function effortLevels(_rk: ReasoningKind): ReasoningEffort[] {
  return ["off", "low", "medium", "high"];
}
