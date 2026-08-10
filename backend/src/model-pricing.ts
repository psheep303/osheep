import { readAppSettings } from "./app-settings.js";

export const LITELLM_MODEL_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface ModelPriceRecord {
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

export interface ModelPricingSettings {
  models: ModelPriceRecord[];
}

const DEFAULT_FAVORITE_MODELS = new Set([
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

const ORIGIN_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "google",
  "meta",
  "mistral",
  "cohere",
  "xai",
  "deepseek",
  "qwen",
]);

export function normalizeModelPriceRecords(raw: unknown): ModelPriceRecord[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const records: ModelPriceRecord[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const input = finiteNumber(item.input_cost_per_token);
    const output = finiteNumber(item.output_cost_per_token);
    const perRequest = sumDefined(
      finiteNumber(item.input_cost_per_request),
      finiteNumber(item.output_cost_per_request),
    );
    if (!key.trim() || (input === undefined && output === undefined && perRequest === undefined)) continue;
    const sourceModel = stringValue(item.model_name) || key;
    const model = canonicalModelName(sourceModel);
    records.push({
      model,
      provider:
        originProviderFromModel(key) ||
        originProviderFromModel(sourceModel) ||
        stringValue(item.litellm_provider) ||
        providerFromModel(key),
      billingMode: perRequest !== undefined ? "per-request" : "dynamic",
      costPerRequest: perRequest,
      inputCostPerMillion: Math.max(0, (input ?? 0) * 1_000_000),
      outputCostPerMillion: Math.max(0, (output ?? 0) * 1_000_000),
      cacheReadCostPerMillion: optionalMillion(item.cache_read_input_token_cost),
      cacheWriteCostPerMillion: optionalMillion(item.cache_creation_input_token_cost),
      favorite: isDefaultFavoriteModel(model),
      source: "litellm",
    });
  }
  return dedupeModelPrices(records);
}

export function normalizeStoredModelPrices(raw: unknown): ModelPriceRecord[] {
  if (!Array.isArray(raw)) return [];
  return dedupeModelPrices(
    raw.flatMap((value) => {
      if (!value || typeof value !== "object" || Array.isArray(value)) return [];
      const item = value as Record<string, unknown>;
      const rawModel = stringValue(item.model);
      const model = canonicalModelName(rawModel);
      const input = finiteNumber(item.inputCostPerMillion);
      const output = finiteNumber(item.outputCostPerMillion);
      if (!model || input === undefined || output === undefined) return [];
      return [
        {
          model,
          provider:
            stringValue(item.provider) ||
            originProviderFromModel(rawModel) ||
            originProviderFromModel(model) ||
            providerFromModel(rawModel),
          billingMode: item.billingMode === "per-request" ? "per-request" : "dynamic",
          costPerRequest: optionalNumber(item.costPerRequest),
          inputCostPerMillion: Math.max(0, input),
          outputCostPerMillion: Math.max(0, output),
          cacheReadCostPerMillion: optionalNumber(item.cacheReadCostPerMillion),
          cacheWriteCostPerMillion: optionalNumber(item.cacheWriteCostPerMillion),
          favorite:
            item.favoriteCustomized === true
              ? item.favorite === true
              : item.favorite === true || isDefaultFavoriteModel(model),
          favoriteCustomized: item.favoriteCustomized === true,
          source: item.source === "litellm" ? "litellm" : "manual",
          updatedAt: optionalNumber(item.updatedAt),
        } satisfies ModelPriceRecord,
      ];
    }),
  );
}

export async function syncLiteLlmModelPrices(
  fetcher: typeof fetch = fetch,
): Promise<ModelPriceRecord[]> {
  const response = await fetcher(LITELLM_MODEL_PRICES_URL, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`LiteLLM price sync failed (${response.status})`);
  const records = normalizeModelPriceRecords(await response.json());
  if (records.length === 0) throw new Error("LiteLLM returned no model prices");
  return records.map((record) => ({ ...record, updatedAt: Date.now() }));
}

export async function readStoredModelPrices(): Promise<ModelPriceRecord[]> {
  const settings = await readAppSettings<{ pricing?: { models?: unknown } }>({});
  return normalizeStoredModelPrices(settings.pricing?.models);
}

export function calculateModelCost(
  model: string,
  tokens:
    | { input?: number; output?: number; cacheRead?: number; cacheWrite?: number }
    | undefined,
  prices: ModelPriceRecord[],
): number | undefined {
  const price = findModelPrice(model, prices);
  if (!price) return undefined;
  if (price.billingMode === "per-request") return price.costPerRequest;
  if (!tokens) return undefined;
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const rawInput = tokens.input ?? 0;
  const uncachedInput = rawInput >= cacheRead + cacheWrite ? rawInput - cacheRead - cacheWrite : rawInput;
  const cost =
    (uncachedInput * price.inputCostPerMillion +
      (tokens.output ?? 0) * price.outputCostPerMillion +
      cacheRead * (price.cacheReadCostPerMillion ?? price.inputCostPerMillion) +
      cacheWrite * (price.cacheWriteCostPerMillion ?? price.inputCostPerMillion)) /
    1_000_000;
  return Number.isFinite(cost) ? cost : undefined;
}

function findModelPrice(model: string, prices: ModelPriceRecord[]): ModelPriceRecord | undefined {
  const aliases = modelAliases(model);
  if (aliases.size === 0) return undefined;
  return prices.find((price) => {
    for (const alias of modelAliases(price.model)) {
      if (aliases.has(alias)) return true;
    }
    return false;
  });
}

function dedupeModelPrices(records: ModelPriceRecord[]): ModelPriceRecord[] {
  const map = new Map<string, ModelPriceRecord>();
  for (const record of records) {
    const key = record.model.trim().toLowerCase();
    if (key) map.set(key, record);
  }
  return [...map.values()].sort((a, b) => a.model.localeCompare(b.model));
}

function optionalMillion(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.max(0, number * 1_000_000);
}

function optionalNumber(value: unknown): number | undefined {
  const number = finiteNumber(value);
  return number === undefined ? undefined : Math.max(0, number);
}

function finiteNumber(value: unknown): number | undefined {
  const number =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(number) ? number : undefined;
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function providerFromModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  const slash = normalized.indexOf("/");
  if (slash > 0) return normalized.slice(0, slash);
  const dot = normalized.indexOf(".");
  const prefix = dot > 0 ? normalized.slice(0, dot) : "";
  return ORIGIN_PROVIDERS.has(prefix) ? prefix : "";
}

function canonicalModelName(model: string): string {
  const trimmed = model.trim();
  const provider = originProviderFromModel(trimmed);
  if (!provider) return trimmed;
  const providerPrefix = new RegExp(`(?:^|[/.])${provider}[/.](.+)$`, "i");
  return trimmed.match(providerPrefix)?.[1]?.trim() || trimmed;
}

function originProviderFromModel(model: string): string {
  const normalized = model.trim().toLowerCase();
  const namespaced = normalized.match(/(?:^|[/.])(anthropic|openai|google|meta|mistral|cohere|xai|deepseek|qwen)[/.]/);
  if (namespaced?.[1]) return namespaced[1];
  const canonical = normalized.replace(/^.*\//, "");
  if (canonical.startsWith("claude-")) return "anthropic";
  if (/^(?:gpt(?:-|$)|chatgpt-|o[134](?:-|$))/.test(canonical)) return "openai";
  return "";
}

function isDefaultFavoriteModel(model: string): boolean {
  return DEFAULT_FAVORITE_MODELS.has(canonicalModelName(model).toLowerCase());
}

function modelAliases(model: string): Set<string> {
  const canonical = canonicalModelName(model)
    .toLowerCase()
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-");
  if (!canonical) return new Set();
  const aliases = new Set([canonical]);
  if (canonical.startsWith("claude-") && canonical.length > "claude-".length) {
    aliases.add(canonical.slice("claude-".length));
  }
  return aliases;
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}
