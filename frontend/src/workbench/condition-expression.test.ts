import assert from "node:assert/strict";
import { test } from "node:test";
import { evaluateConditionExpression } from "./condition-expression";

test("condition expressions support program-style operators", () => {
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
