import test from "node:test";
import assert from "node:assert/strict";
import {
  normalizePluginName,
  parseCliJson,
} from "./codex-plugins.js";

test("normalizePluginName creates lower-case kebab-case names", () => {
  assert.equal(normalizePluginName(" My Super_Plugin!! "), "my-super-plugin");
  assert.equal(normalizePluginName("A".repeat(80)), "a".repeat(64));
});

test("normalizePluginName falls back to plugin for empty input", () => {
  assert.equal(normalizePluginName("!!!"), "plugin");
});

test("parseCliJson skips Windows code-page banner before JSON", () => {
  const parsed = parseCliJson('Active code page: 65001\n{"installed":[],"available":[]}');
  assert.deepEqual(parsed, { installed: [], available: [] });
});

test("parseCliJson reports a useful error when stdout has no JSON", () => {
  assert.throws(
    () => parseCliJson("Active code page: 65001\nnot json"),
    /Codex CLI did not return JSON/
  );
});
