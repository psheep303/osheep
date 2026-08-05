import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_UI_PREFERENCES,
  parseUiPreferences,
  resolveSystemLanguage,
  resolveSystemTheme,
} from "./UiPreferences";

test("UI preferences default to following the operating system", () => {
  assert.deepEqual(parseUiPreferences(null), DEFAULT_UI_PREFERENCES);
  assert.deepEqual(parseUiPreferences("not json"), DEFAULT_UI_PREFERENCES);
});

test("UI preferences discard unsupported stored values independently", () => {
  assert.deepEqual(parseUiPreferences('{"language":"fr","theme":"light"}'), {
    language: "system",
    theme: "light",
  });
});

test("system language maps Chinese variants to zh-CN and otherwise uses English", () => {
  assert.equal(resolveSystemLanguage(["zh-Hant-TW", "en-US"]), "zh-CN");
  assert.equal(resolveSystemLanguage(["en-US", "zh-CN"]), "zh-CN");
  assert.equal(resolveSystemLanguage(["ja-JP", "en-US"]), "en");
});

test("system color scheme resolves to a supported theme", () => {
  assert.equal(resolveSystemTheme(true), "dark");
  assert.equal(resolveSystemTheme(false), "light");
});
