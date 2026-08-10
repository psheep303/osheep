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
        inputCostPerMillion: 1,
        outputCostPerMillion: 2,
        cacheReadCostPerMillion: undefined,
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
