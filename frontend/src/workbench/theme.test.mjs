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
  normalizeLightTerminalAnsi,
  workflowXtermTheme,
  xtermAnsiTheme,
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
  "editorSuggestWidget.background": "#252526",
  "editorSuggestWidget.border": "#454545",
  "editorSuggestWidget.foreground": "#d4d4d4",
  "editorSuggestWidget.selectedBackground": "#094771",
  "editorSuggestWidget.selectedForeground": "#ffffff",
  "editorSuggestWidget.highlightForeground": "#4fc1ff",
  "editorSuggestWidget.focusHighlightForeground": "#9cdcfe",
  "editorSuggestWidgetStatus.foreground": "#b8b8b8",
  "list.foreground": "#d4d4d4",
  "list.focusForeground": "#ffffff",
  "list.activeSelectionForeground": "#ffffff",
  "list.inactiveSelectionForeground": "#d4d4d4",
  "list.highlightForeground": "#4fc1ff",
  "list.activeSelectionBackground": "#094771",
  "list.focusBackground": "#094771",
  "list.inactiveSelectionBackground": "#37373d",
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
  assert.equal(monacoEditorColors("light")["editorSuggestWidget.foreground"], "#26313d");
  assert.equal(monacoEditorColors("light")["editorSuggestWidget.selectedForeground"], "#17212b");
  assert.deepEqual(xtermTheme("light"), {
    background: "#ffffff",
    foreground: "#26313d",
    cursor: "#1f2933",
    selectionBackground: "#c5def5",
  });
  assert.equal(workflowXtermTheme("light").background, "#ffffff");
  assert.equal(xtermAnsiTheme("light").brightWhite, "#1f2933");
  assert.equal(xtermAnsiTheme("light").brightYellow, "#795e26");
});

test("light terminal output drops explicit background colors without changing dark output", () => {
  const data = "\u001b[38;2;255;255;255;48;2;30;30;30mhello\u001b[0m";
  assert.equal(normalizeLightTerminalAnsi(data, "light"), "\u001b[38;2;255;255;255mhello\u001b[0m");
  assert.equal(normalizeLightTerminalAnsi(data, "dark"), data);
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

test("workbench layout selectors do not collide with Monaco widget internals", async () => {
  const [editorCss, workbenchSource] = await Promise.all([
    readFile(new URL("./styles/editor.css", import.meta.url), "utf8"),
    readFile(new URL("./Workbench.tsx", import.meta.url), "utf8"),
  ]);
  assert.doesNotMatch(editorCss, /(^|})\s*\.main\s*\{/m);
  assert.match(editorCss, /\.workbench-main\s*\{/);
  assert.match(workbenchSource, /className="workbench-main"/);
});

test("theme-sensitive cards and terminal menus use component roles", async () => {
  const [tokens, agentCss, terminalCss, terminalSource, aiSettingsSource] = await Promise.all([
    readFile(new URL("../styles.css", import.meta.url), "utf8"),
    readFile(new URL("./styles/agent-settings.css", import.meta.url), "utf8"),
    readFile(new URL("./styles/terminal.css", import.meta.url), "utf8"),
    readFile(new URL("./Terminal.tsx", import.meta.url), "utf8"),
    readFile(new URL("./AiSettingsView.tsx", import.meta.url), "utf8"),
  ]);

  for (const role of [
    "--ui-surface-card",
    "--ui-surface-control",
    "--ui-surface-menu",
    "--ui-border-card",
    "--ui-success-bg",
    "--ui-danger-bg",
  ]) {
    assert.ok(tokens.includes(role), `missing component theme role ${role}`);
  }
  assert.match(tokens, /@media \(forced-colors: active\)/);
  assert.match(tokens, /:root\[data-theme="light"\][\s\S]*?--ui-surface-card:\s*#ffffff/);
  assert.match(agentCss, /background: var\(--ui-surface-card\)/);
  assert.match(agentCss, /var\(--provider-icon-color\)/);
  assert.doesNotMatch(agentCss, /#252526|#3e3e42|#569cd6/);
  assert.doesNotMatch(aiSettingsSource, /backgroundColor/);
  assert.match(aiSettingsSource, /--provider-icon-\$\{paletteIndex\}/);
  assert.match(terminalCss, /background: var\(--ui-surface-menu\)/);
  assert.doesNotMatch(terminalCss, /\.terminal__menu-item\.is-active::before/);
  assert.match(terminalSource, /codicon codicon-check/);
});
