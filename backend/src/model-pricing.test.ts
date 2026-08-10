import assert from "node:assert/strict";
import test from "node:test";
import {
  calculateModelCost,
  normalizeModelPriceRecords,
  normalizeStoredModelPrices,
} from "./model-pricing.js";

test("normalizes LiteLLM per-token prices to per-million prices", () => {
  assert.deepEqual(
    normalizeModelPriceRecords({
      "openai/gpt-test": {
        model_name: "gpt-test",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000002,
      },
    }),
    [
      {
        model: "gpt-test",
        provider: "openai",
        billingMode: "dynamic",
        costPerRequest: undefined,
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        cacheReadCostPerMillion: undefined,
        cacheWriteCostPerMillion: undefined,
        favorite: false,
        source: "litellm",
      },
    ],
  );
});

test("normalizes dotted Anthropic model names to their true provider", () => {
  assert.deepEqual(
    normalizeModelPriceRecords({
      "anthropic.claude-3-5-haiku-20241022-v1:0": {
        litellm_provider: "bedrock",
        input_cost_per_token: 0.000001,
        output_cost_per_token: 0.000004,
      },
    }),
    [
      {
        model: "claude-3-5-haiku-20241022-v1:0",
        provider: "anthropic",
        billingMode: "dynamic",
        costPerRequest: undefined,
        inputCostPerMillion: 1,
        outputCostPerMillion: 4,
        cacheReadCostPerMillion: undefined,
        cacheWriteCostPerMillion: undefined,
        favorite: false,
        source: "litellm",
      },
    ],
  );
});

test("infers OpenAI and applies the requested default favorites", () => {
  const records = normalizeModelPriceRecords({
    "gpt-5.5": { input_cost_per_token: 0.000001, output_cost_per_token: 0.000002 },
    "anthropic.claude-fable-5": {
      input_cost_per_token: 0.000003,
      output_cost_per_token: 0.000015,
    },
  });
  assert.deepEqual(
    records.map(({ model, provider, favorite }) => ({ model, provider, favorite })),
    [
      { model: "claude-fable-5", provider: "anthropic", favorite: true },
      { model: "gpt-5.5", provider: "openai", favorite: true },
    ],
  );
});

test("respects an explicit favorite override for a default model", () => {
  assert.equal(
    normalizeStoredModelPrices([
      {
        model: "openai/gpt-5.5",
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        favorite: false,
        favoriteCustomized: true,
      },
    ])[0]?.favorite,
    false,
  );
});

test("marks every requested default model as a favorite", () => {
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
    models.map((model) => ({ model, inputCostPerMillion: 1, outputCostPerMillion: 2 })),
  );
  assert.deepEqual(
    normalized.map(({ model, favorite }) => ({ model, favorite })),
    [...models]
      .sort((a, b) => a.localeCompare(b))
      .map((model) => ({ model, favorite: true })),
  );
});

test("fills OpenAI for the GPT family while preserving an existing provider", () => {
  const normalized = normalizeStoredModelPrices([
    { model: "gpt-4.1", inputCostPerMillion: 1, outputCostPerMillion: 2 },
    {
      model: "gpt-4.1-mini",
      provider: "azure",
      inputCostPerMillion: 1,
      outputCostPerMillion: 2,
    },
  ]);
  assert.deepEqual(
    normalized.map(({ model, provider }) => ({ model, provider })),
    [
      { model: "gpt-4.1", provider: "openai" },
      { model: "gpt-4.1-mini", provider: "azure" },
    ],
  );
});

test("calculates observable run cost from configured model prices", () => {
  const prices = normalizeStoredModelPrices([
    { model: "gpt-5", inputCostPerMillion: 2, outputCostPerMillion: 8 },
  ]);
  assert.equal(calculateModelCost("openai/gpt-5", { input: 10_000, output: 1_000 }, prices), 0.028);
});

test("matches Claude workflow aliases to canonical Anthropic prices", () => {
  const prices = normalizeStoredModelPrices([
    {
      model: "anthropic.claude-fable-5",
      inputCostPerMillion: 3,
      outputCostPerMillion: 15,
    },
  ]);
  assert.equal(calculateModelCost("fable 5", { input: 1_000_000 }, prices), 3);
  assert.equal(calculateModelCost("claude-fable-5", { output: 1_000_000 }, prices), 15);
});

test("calculates cache read and write costs separately", () => {
  const prices = normalizeStoredModelPrices([
    {
      model: "gpt-5",
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
      billingMode: "per-request",
      costPerRequest: 0.04,
      inputCostPerMillion: 0,
      outputCostPerMillion: 0,
    },
  ]);
  assert.equal(calculateModelCost("image-model", undefined, prices), 0.04);
});
