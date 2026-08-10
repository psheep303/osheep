import { readAppSettings } from "./app-settings.js";

export const LITELLM_MODEL_PRICES_URL =
  "https://raw.githubusercontent.com/BerriAI/litellm/main/model_prices_and_context_window.json";

export interface ModelPriceRecord {
  model: string;
  inputCostPerMillion: number;
  outputCostPerMillion: number;
  cacheReadCostPerMillion?: number;
  source?: "litellm" | "manual";
  updatedAt?: number;
}

export interface ModelPricingSettings {
  models: ModelPriceRecord[];
}

export function normalizeModelPriceRecords(raw: unknown): ModelPriceRecord[] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
  const records: ModelPriceRecord[] = [];
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    const item = value as Record<string, unknown>;
    const input = finiteNumber(item.input_cost_per_token);
    const output = finiteNumber(item.output_cost_per_token);
    if (!key.trim() || (input === undefined && output === undefined)) continue;
    records.push({
      model: stringValue(item.model_name) || key,
      inputCostPerMillion: Math.max(0, (input ?? 0) * 1_000_000),
      outputCostPerMillion: Math.max(0, (output ?? 0) * 1_000_000),
      cacheReadCostPerMillion: optionalMillion(item.cache_read_input_token_cost),
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
      const input = finiteNumber(item.inputCostPerMillion);
      const output = finiteNumber(item.outputCostPerMillion);
      if (!model || input === undefined || output === undefined) return [];
      return [
        {
          model,
          inputCostPerMillion: Math.max(0, input),
          outputCostPerMillion: Math.max(0, output),
          cacheReadCostPerMillion: optionalNumber(item.cacheReadCostPerMillion),
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
  tokens: { input?: number; output?: number } | undefined,
  prices: ModelPriceRecord[],
): number | undefined {
  if (!tokens) return undefined;
  const price = findModelPrice(model, prices);
  if (!price) return undefined;
  const cost =
    ((tokens.input ?? 0) * price.inputCostPerMillion +
      (tokens.output ?? 0) * price.outputCostPerMillion) /
    1_000_000;
  return Number.isFinite(cost) ? cost : undefined;
}

function findModelPrice(model: string, prices: ModelPriceRecord[]): ModelPriceRecord | undefined {
  const normalized = model.trim().toLowerCase();
  if (!normalized) return undefined;
  return (
    prices.find((price) => price.model.trim().toLowerCase() === normalized) ??
    prices.find((price) => {
      const candidate = price.model.trim().toLowerCase();
      return normalized.endsWith(`/${candidate}`) || candidate.endsWith(`/${normalized}`);
    })
  );
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
