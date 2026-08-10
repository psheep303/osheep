import { readAppSettings } from "./app-settings.js";

export const LITELLM_MODEL_PRICES_URL =
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@litellm_internal_staging/model_prices_and_context_window.json";
export const LITELLM_MODEL_PRICES_MAIN_CDN_FALLBACK_URL =
  "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json";
export const LITELLM_MODEL_PRICES_GITHUB_FALLBACK_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/litellm_internal_staging/model_prices_and_context_window.json";
export const LITELLM_MODEL_PRICES_URLS = [
  LITELLM_MODEL_PRICES_URL,
  LITELLM_MODEL_PRICES_MAIN_CDN_FALLBACK_URL,
  LITELLM_MODEL_PRICES_GITHUB_FALLBACK_URL,
] as const;

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

export interface ModelCostOptions {
  inputIncludesCache?: boolean;
}

const DEFAULT_FAVORITE_PROVIDERS = new Map([
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
    if (!key.trim() || (input === undefined && output === undefined && perRequest === undefined))
      continue;
    const model = key.trim();
    const provider = stringValue(item.litellm_provider);
    records.push({
      model,
      provider,
      billingMode: perRequest !== undefined ? "per-request" : "dynamic",
      costPerRequest: perRequest,
      inputCostPerMillion: Math.max(0, (input ?? 0) * 1_000_000),
      outputCostPerMillion: Math.max(0, (output ?? 0) * 1_000_000),
      cacheReadCostPerMillion: optionalMillion(item.cache_read_input_token_cost),
      cacheWriteCostPerMillion: optionalMillion(item.cache_creation_input_token_cost),
      favorite: isDefaultFavoriteModel(model, provider),
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
      const model = stringValue(item.model);
      const provider = stringValue(item.provider);
      const input = finiteNumber(item.inputCostPerMillion);
      const output = finiteNumber(item.outputCostPerMillion);
      if (!model || input === undefined || output === undefined) return [];
      return [
        {
          model,
          provider,
          billingMode: item.billingMode === "per-request" ? "per-request" : "dynamic",
          costPerRequest: optionalNumber(item.costPerRequest),
          inputCostPerMillion: Math.max(0, input),
          outputCostPerMillion: Math.max(0, output),
          cacheReadCostPerMillion: optionalNumber(item.cacheReadCostPerMillion),
          cacheWriteCostPerMillion: optionalNumber(item.cacheWriteCostPerMillion),
          favorite:
            item.favoriteCustomized === true
              ? item.favorite === true
              : item.favorite === true || isDefaultFavoriteModel(model, provider),
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
  let lastError = "LiteLLM returned no model prices";
  for (const url of LITELLM_MODEL_PRICES_URLS) {
    try {
      const response = await fetcher(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) {
        lastError = `LiteLLM price sync failed (${response.status})`;
        continue;
      }
      const records = normalizeModelPriceRecords(await response.json());
      if (records.length === 0) {
        lastError = "LiteLLM returned no model prices";
        continue;
      }
      if (records.some((record) => !record.provider)) {
        lastError = "LiteLLM returned model prices without providers";
        continue;
      }
      return records.map((record) => ({ ...record, updatedAt: Date.now() }));
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : String(cause);
    }
  }
  throw new Error(lastError);
}

export async function readStoredModelPrices(): Promise<ModelPriceRecord[]> {
  const settings = await readAppSettings<{ pricing?: { models?: unknown } }>({});
  return normalizeStoredModelPrices(settings.pricing?.models);
}

export function calculateModelCost(
  model: string,
  tokens: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number } | undefined,
  prices: ModelPriceRecord[],
  options: ModelCostOptions = {},
): number | undefined {
  const price = findModelPrice(model, prices);
  if (!price) return undefined;
  if (price.billingMode === "per-request") return price.costPerRequest;
  if (!tokens) return undefined;
  const cacheRead = tokens.cacheRead ?? 0;
  const cacheWrite = tokens.cacheWrite ?? 0;
  const rawInput = tokens.input ?? 0;
  const uncachedInput =
    options.inputIncludesCache === false
      ? rawInput
      : rawInput >= cacheRead + cacheWrite
        ? rawInput - cacheRead - cacheWrite
        : rawInput;
  const cost =
    (uncachedInput * price.inputCostPerMillion +
      (tokens.output ?? 0) * price.outputCostPerMillion +
      cacheRead * (price.cacheReadCostPerMillion ?? price.inputCostPerMillion) +
      cacheWrite * (price.cacheWriteCostPerMillion ?? price.inputCostPerMillion)) /
    1_000_000;
  return Number.isFinite(cost) ? cost : undefined;
}

function findModelPrice(model: string, prices: ModelPriceRecord[]): ModelPriceRecord | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;
  return prices.find((price) => price.model.trim().toLowerCase() === normalized);
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

function isDefaultFavoriteModel(model: string, provider: string): boolean {
  const normalizedModel = model.trim().toLowerCase();
  return DEFAULT_FAVORITE_PROVIDERS.get(normalizedModel) === provider.trim().toLowerCase();
}

function sumDefined(...values: Array<number | undefined>): number | undefined {
  const present = values.filter((value): value is number => value !== undefined);
  return present.length > 0 ? present.reduce((sum, value) => sum + value, 0) : undefined;
}
