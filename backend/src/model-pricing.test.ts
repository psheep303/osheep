import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateModelCost,
  LITELLM_MODEL_PRICES_URL,
  LITELLM_MODEL_PRICES_GITHUB_FALLBACK_URL,
  LITELLM_MODEL_PRICES_MAIN_CDN_FALLBACK_URL,
  LITELLM_MODEL_PRICES_URLS,
  normalizeModelPriceRecords,
  normalizeStoredModelPrices,
  syncLiteLlmModelPrices,
} from "./model-pricing.js";

test("uses LiteLLM model keys and providers without text inference", () => {
  assert.deepEqual(
    normalizeModelPriceRecords({
      "bedrock_mantle/gpt-5.4": {
        model_name: "gpt-5.4",
        litellm_provider: "bedrock_mantle",
        input_cost_per_token: 0.00000275,
        output_cost_per_token: 0.000011,
      },
      "ai21.j2-mid-v1": {
        litellm_provider: "ai21",
        input_cost_per_token: 0.0000125,
        output_cost_per_token: 0.0000125,
      },
    }),
    [
      {
        model: "ai21.j2-mid-v1",
        provider: "ai21",
        billingMode: "dynamic",
        costPerRequest: undefined,
        inputCostPerMillion: 12.5,
        outputCostPerMillion: 12.5,
        cacheReadCostPerMillion: undefined,
        cacheWriteCostPerMillion: undefined,
        favorite: false,
        source: "litellm",
      },
      {
        model: "bedrock_mantle/gpt-5.4",
        provider: "bedrock_mantle",
        billingMode: "dynamic",
        costPerRequest: undefined,
        inputCostPerMillion: 2.75,
        outputCostPerMillion: 11,
        cacheReadCostPerMillion: undefined,
        cacheWriteCostPerMillion: undefined,
        favorite: false,
        source: "litellm",
      },
    ],
  );
});

test("does not infer missing stored providers or remove model prefixes", () => {
  assert.deepEqual(
    normalizeStoredModelPrices([
      { model: "gpt-4.1", inputCostPerMillion: 1, outputCostPerMillion: 2 },
      {
        model: "anthropic.claude-3-5-haiku",
        provider: "bedrock",
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
      },
    ]).map(({ model, provider }) => ({ model, provider })),
    [
      { model: "anthropic.claude-3-5-haiku", provider: "bedrock" },
      { model: "gpt-4.1", provider: "" },
    ],
  );
});

test("defaults favorites only for exact models from their LiteLLM provider", () => {
  const records = normalizeModelPriceRecords({
    "gpt-5.5": {
      litellm_provider: "openai",
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
    },
    "bedrock/gpt-5.5": {
      litellm_provider: "bedrock",
      input_cost_per_token: 0.000001,
      output_cost_per_token: 0.000002,
    },
    "claude-fable-5": {
      litellm_provider: "anthropic",
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
    },
  });
  assert.deepEqual(
    records.map(({ model, provider, favorite }) => ({ model, provider, favorite })),
    [
      { model: "bedrock/gpt-5.5", provider: "bedrock", favorite: false },
      { model: "claude-fable-5", provider: "anthropic", favorite: true },
      { model: "gpt-5.5", provider: "openai", favorite: true },
    ],
  );
});

test("marks every requested default model for the matching provider", () => {
  const models = [
    "gpt-5.6-sol",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
    "gpt-5.5",
    "gpt-5.4",
    "claude-fable-5",
    "claude-opus-4-7",
    "claude-opus-4-8",
    "claude-opus-5",
  ];
  const normalized = normalizeStoredModelPrices(
    models.map((model) => ({
      model,
      provider: model.startsWith("gpt-") ? "openai" : "anthropic",
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
    })),
  );
  assert.equal(normalized.every((record) => record.favorite === true), true);
});

test("respects an explicit favorite override", () => {
  assert.equal(
    normalizeStoredModelPrices([
      {
        model: "gpt-5.5",
        provider: "openai",
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        favorite: false,
        favoriteCustomized: true,
      },
    ])[0]?.favorite,
    false,
  );
});

test("calculates cost only for an exact model name", () => {
  const prices = normalizeStoredModelPrices([
    { model: "gpt-5", provider: "openai", inputCostPerMillion: 2, outputCostPerMillion: 8 },
  ]);
  assert.equal(calculateModelCost("gpt-5", { input: 10_000, output: 1_000 }, prices), 0.028);
  assert.equal(calculateModelCost("openai/gpt-5", { input: 10_000 }, prices), undefined);
});

test("calculates cache read and write costs separately", () => {
  const prices = normalizeStoredModelPrices([
    {
      model: "gpt-5",
      provider: "openai",
      inputCostPerMillion: 2,
      outputCostPerMillion: 8,
      cacheReadCostPerMillion: 0.2,
      cacheWriteCostPerMillion: 3,
    },
  ]);
  assert.equal(
    calculateModelCost(
      "gpt-5",
      { input: 10_000, output: 1_000, cacheRead: 4_000, cacheWrite: 1_000 },
      prices,
    ),
    0.0218,
  );
});

test("calculates per-request prices without token usage", () => {
  const prices = normalizeStoredModelPrices([
    {
      model: "image-model",
      provider: "provider",
      billingMode: "per-request",
      costPerRequest: 0.04,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
  ]);
  assert.equal(calculateModelCost("image-model", undefined, prices), 0.04);
});

test("configures staging CDN, main CDN, and GitHub LiteLLM sources", () => {
  assert.equal(
    LITELLM_MODEL_PRICES_URL,
    "https://cdn.jsdelivr.net/gh/BerriAI/litellm@litellm_internal_staging/model_prices_and_context_window.json",
  );
  assert.equal(
    LITELLM_MODEL_PRICES_MAIN_CDN_FALLBACK_URL,
    "https://cdn.jsdelivr.net/gh/BerriAI/litellm@main/model_prices_and_context_window.json",
  );
  assert.equal(
    LITELLM_MODEL_PRICES_GITHUB_FALLBACK_URL,
    "https://raw.githubusercontent.com/BerriAI/litellm/litellm_internal_staging/model_prices_and_context_window.json",
  );
  assert.deepEqual([...LITELLM_MODEL_PRICES_URLS], [
    LITELLM_MODEL_PRICES_URL,
    LITELLM_MODEL_PRICES_MAIN_CDN_FALLBACK_URL,
    LITELLM_MODEL_PRICES_GITHUB_FALLBACK_URL,
  ]);
});

test("rejects incomplete providers and falls back to GitHub staging", async () => {
  const requested: string[] = [];
  const models = await syncLiteLlmModelPrices(async (input) => {
    const url = String(input);
    requested.push(url);
    if (url === LITELLM_MODEL_PRICES_URL) return new Response("", { status: 503 });
    if (url === LITELLM_MODEL_PRICES_MAIN_CDN_FALLBACK_URL) {
      return new Response(
        JSON.stringify({ "ai21.j2-mid-v1": { input_cost_per_token: 0.0000125 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response(
      JSON.stringify({ "ai21.j2-mid-v1": { litellm_provider: "bedrock", input_cost_per_token: 0.0000125 } }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  });
  assert.deepEqual(requested, [
    LITELLM_MODEL_PRICES_URL,
    LITELLM_MODEL_PRICES_MAIN_CDN_FALLBACK_URL,
    LITELLM_MODEL_PRICES_GITHUB_FALLBACK_URL,
  ]);
  assert.equal(models[0]?.model, "ai21.j2-mid-v1");
  assert.equal(models[0]?.provider, "bedrock");
});
