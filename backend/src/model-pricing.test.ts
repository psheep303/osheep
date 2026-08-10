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
        source: "litellm",
      },
    ],
  );
});

test("calculates observable run cost from configured model prices", () => {
  const prices = normalizeStoredModelPrices([
    { model: "gpt-5", inputCostPerMillion: 2, outputCostPerMillion: 8 },
  ]);
  assert.equal(calculateModelCost("openai/gpt-5", { input: 10_000, output: 1_000 }, prices), 0.028);
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
