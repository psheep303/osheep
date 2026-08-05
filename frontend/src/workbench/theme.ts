import type { ITheme } from "@xterm/xterm";

export function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

const EDITOR_DECORATIVE_COLORS = {
  "editor.lineHighlightBackground": "#ffffff0a",
  "editor.lineHighlightBorder": "#00000000",
  "editorLineNumber.foreground": "#6e7681",
  "editorCursor.foreground": "#aeafad",
  "editorIndentGuide.background": "#404040",
  "editorIndentGuide.activeBackground": "#707070",
  "editor.selectionBackground": "#264f78",
  "editor.inactiveSelectionBackground": "#3a3d41",
  "editorWidget.background": "#202020",
  "editorWidget.border": "#454545",
  "scrollbarSlider.background": "#79797966",
  "scrollbarSlider.hoverBackground": "#646464b3",
  "scrollbarSlider.activeBackground": "#bfbfbf66",
} as const;

const DIFF_COLORS = {
  "diffEditor.insertedTextBackground": "#23863633",
  "diffEditor.removedTextBackground": "#cb242533",
  "diffEditorGutter.insertedLineBackground": "#23863622",
  "diffEditorGutter.removedLineBackground": "#cb242522",
} as const;

export function monacoThemeColors(): Record<string, string> {
  return {
    "editor.background": cssVar("--surface-2", "#1f1f1f"),
    "editor.foreground": cssVar("--fg-default", "#cccccc"),
    "editor.lineHighlightBackground": EDITOR_DECORATIVE_COLORS["editor.lineHighlightBackground"],
    "editor.lineHighlightBorder": EDITOR_DECORATIVE_COLORS["editor.lineHighlightBorder"],
    "editorLineNumber.foreground": EDITOR_DECORATIVE_COLORS["editorLineNumber.foreground"],
    "editorLineNumber.activeForeground": cssVar("--fg-default", "#cccccc"),
    "editorCursor.foreground": EDITOR_DECORATIVE_COLORS["editorCursor.foreground"],
    "editorGutter.background": cssVar("--surface-2", "#1f1f1f"),
    "editorIndentGuide.background": EDITOR_DECORATIVE_COLORS["editorIndentGuide.background"],
    "editorIndentGuide.activeBackground":
      EDITOR_DECORATIVE_COLORS["editorIndentGuide.activeBackground"],
    "editor.selectionBackground": EDITOR_DECORATIVE_COLORS["editor.selectionBackground"],
    "editor.inactiveSelectionBackground":
      EDITOR_DECORATIVE_COLORS["editor.inactiveSelectionBackground"],
    "editorWidget.background": EDITOR_DECORATIVE_COLORS["editorWidget.background"],
    "editorWidget.border": EDITOR_DECORATIVE_COLORS["editorWidget.border"],
    "scrollbarSlider.background": EDITOR_DECORATIVE_COLORS["scrollbarSlider.background"],
    "scrollbarSlider.hoverBackground": EDITOR_DECORATIVE_COLORS["scrollbarSlider.hoverBackground"],
    "scrollbarSlider.activeBackground":
      EDITOR_DECORATIVE_COLORS["scrollbarSlider.activeBackground"],
    ...DIFF_COLORS,
  };
}

export function monacoEditorColors(): Record<string, string> {
  return monacoThemeColors();
}

export function monacoDiffColors(): Record<string, string> {
  return monacoThemeColors();
}

type XtermTheme = Required<
  Pick<ITheme, "background" | "foreground" | "cursor" | "selectionBackground">
>;

export function xtermTheme(): XtermTheme {
  return {
    background: cssVar("--surface-2", "#1f1f1f"),
    foreground: cssVar("--fg-default", "#cccccc"),
    cursor: "#aeafad",
    selectionBackground: "#264f78",
  };
}

export function workflowXtermTheme(): XtermTheme {
  return {
    background: "#101010",
    foreground: "#d6d6d6",
    cursor: cssVar("--color-link-strong", "#d8eaff"),
    selectionBackground: "#264f78",
  };
}

const GIT_GRAPH_PALETTE = ["#ffb000", "#dc267f", "#994f00", "#40b0a6", "#b66dff"] as const;

export function gitGraphPalette(): string[] {
  return [...GIT_GRAPH_PALETTE];
}

export function gitGraphRefColors(): { ref: string; remoteRef: string } {
  return {
    ref: "#3794ff",
    remoteRef: "#b180d7",
  };
}
