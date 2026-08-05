import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import ts from "typescript";

async function loadTheme() {
  const source = await readFile(new URL("./theme.ts", import.meta.url), "utf8");
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
  });
  return import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
}

const {
  cssVar,
  gitGraphPalette,
  gitGraphRefColors,
  monacoDiffColors,
  monacoEditorColors,
  workflowXtermTheme,
  xtermTheme,
} = await loadTheme();

const EXPECTED_MONACO_COLORS = {
  "editor.background": "#1f1f1f",
  "editor.foreground": "#cccccc",
  "editor.lineHighlightBackground": "#ffffff0a",
  "editor.lineHighlightBorder": "#00000000",
  "editorLineNumber.foreground": "#6e7681",
  "editorLineNumber.activeForeground": "#cccccc",
  "editorCursor.foreground": "#aeafad",
  "editorGutter.background": "#1f1f1f",
  "editorIndentGuide.background": "#404040",
  "editorIndentGuide.activeBackground": "#707070",
  "editor.selectionBackground": "#264f78",
  "editor.inactiveSelectionBackground": "#3a3d41",
  "editorWidget.background": "#202020",
  "editorWidget.border": "#454545",
  "scrollbarSlider.background": "#79797966",
  "scrollbarSlider.hoverBackground": "#646464b3",
  "scrollbarSlider.activeBackground": "#bfbfbf66",
  "diffEditor.insertedTextBackground": "#23863633",
  "diffEditor.removedTextBackground": "#cb242533",
  "diffEditorGutter.insertedLineBackground": "#23863622",
  "diffEditorGutter.removedLineBackground": "#cb242522",
};

function withMockDom(values, run) {
  const previousDocument = globalThis.document;
  const previousGetComputedStyle = globalThis.getComputedStyle;
  globalThis.document = { documentElement: {} };
  globalThis.getComputedStyle = () => ({
    getPropertyValue: (name) => values[name] ?? "",
  });
  try {
    run();
  } finally {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousGetComputedStyle === undefined) delete globalThis.getComputedStyle;
    else globalThis.getComputedStyle = previousGetComputedStyle;
  }
}

test("theme helpers preserve exact fallbacks without a DOM", () => {
  assert.equal(cssVar("--missing", "#fallback"), "#fallback");
  assert.deepEqual(monacoEditorColors(), EXPECTED_MONACO_COLORS);
  assert.deepEqual(monacoDiffColors(), EXPECTED_MONACO_COLORS);
  assert.deepEqual(xtermTheme(), {
    background: "#1f1f1f",
    foreground: "#cccccc",
    cursor: "#aeafad",
    selectionBackground: "#264f78",
  });
  assert.deepEqual(workflowXtermTheme(), {
    background: "#101010",
    foreground: "#d6d6d6",
    cursor: "#d8eaff",
    selectionBackground: "#264f78",
  });
  assert.deepEqual(gitGraphRefColors(), { ref: "#3794ff", remoteRef: "#b180d7" });
});

test("explicit light palettes stay readable without a DOM", () => {
  assert.equal(monacoEditorColors("light")["editor.background"], "#ffffff");
  assert.equal(monacoEditorColors("light")["editor.foreground"], "#26313d");
  assert.deepEqual(xtermTheme("light"), {
    background: "#ffffff",
    foreground: "#26313d",
    cursor: "#1f2933",
    selectionBackground: "#c5def5",
  });
  assert.equal(workflowXtermTheme("light").background, "#ffffff");
});

test("cssVar trims DOM values and falls back for empty tokens", () => {
  withMockDom({ "--rgb": "  rgb(1, 2, 3)  ", "--empty": "  " }, () => {
    assert.equal(cssVar("--rgb", "#fallback"), "rgb(1, 2, 3)");
    assert.equal(cssVar("--empty", "#fallback"), "#fallback");
  });
});

test("Monaco and xterm resolve semantic CSS tokens after the DOM exists", () => {
  withMockDom(
    {
      "--surface-2": "rgb(31, 31, 31)",
      "--fg-default": "#abcdef",
      "--color-link-strong": "rgb(216, 234, 255)",
    },
    () => {
      const editor = monacoEditorColors();
      const diff = monacoDiffColors();
      assert.deepEqual(editor, diff);
      assert.equal(editor["editor.background"], "rgb(31, 31, 31)");
      assert.equal(editor["editor.foreground"], "#abcdef");
      assert.equal(editor["editorGutter.background"], "rgb(31, 31, 31)");
      assert.deepEqual(xtermTheme(), {
        background: "rgb(31, 31, 31)",
        foreground: "#abcdef",
        cursor: "#aeafad",
        selectionBackground: "#264f78",
      });
      assert.equal(workflowXtermTheme().cursor, "rgb(216, 234, 255)");
    },
  );
});

test("GitGraph palette calls return stable fresh arrays", () => {
  const first = gitGraphPalette();
  const second = gitGraphPalette();
  assert.notStrictEqual(first, second);
  assert.deepEqual(first, ["#ffb000", "#dc267f", "#994f00", "#40b0a6", "#b66dff"]);
  first[0] = "#000000";
  assert.deepEqual(second, ["#ffb000", "#dc267f", "#994f00", "#40b0a6", "#b66dff"]);
  assert.deepEqual(gitGraphPalette(), second);
});
