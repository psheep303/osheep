import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateConditionExpression } from "./condition-expression.js";

test("condition expressions support comparisons, logic, parentheses, and templates", () => {
  const values = new Map<string, unknown>([
    ["{{blocks[1].status}}", "success"],
    ["{{blocks[2].count}}", 4],
  ]);
  const evaluate = (expression: string) =>
    evaluateConditionExpression(expression, (template) => values.get(template));

  assert.equal(evaluate('{{blocks[1].status}} == "success"'), true);
  assert.equal(evaluate("{{blocks[2].count}} >= 4 && (true || false)"), true);
  assert.equal(evaluate("{{blocks[2].count}} < 4 || {{blocks[1].status}} != success"), false);
});

test("condition expressions reject unsupported syntax", () => {
  assert.throws(() => evaluateConditionExpression("value === value", () => undefined));
  assert.throws(() => evaluateConditionExpression("(true", () => undefined));
});
