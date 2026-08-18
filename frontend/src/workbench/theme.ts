import type { ITheme } from "@xterm/xterm";

export function cssVar(name: string, fallback: string): string {
  if (typeof document === "undefined" || typeof getComputedStyle === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

export type UiColorTheme = "light" | "dark";

const THEME_FALLBACKS: Record<UiColorTheme, Record<string, string>> = {
  dark: {
    "--surface-2": "#1f1f1f",
    "--fg-default": "#cccccc",
    "--fg-strong": "#ffffff",
    "--color-link-strong": "#d8eaff",
    "--editor-line": "#ffffff0a",
    "--editor-number": "#6e7681",
    "--editor-cursor": "#aeafad",
    "--editor-guide": "#404040",
    "--editor-guide-active": "#707070",
    "--editor-selection": "#264f78",
    "--editor-selection-inactive": "#3a3d41",
    "--editor-widget": "#202020",
    "--editor-widget-border": "#454545",
  },
  light: {
    "--surface-2": "#ffffff",
    "--fg-default": "#26313d",
    "--fg-strong": "#17212b",
    "--color-link-strong": "#07549b",
    "--editor-line": "#0000000a",
    "--editor-number": "#87919d",
    "--editor-cursor": "#1f2933",
    "--editor-guide": "#d7dde3",
    "--editor-guide-active": "#aeb9c4",
    "--editor-selection": "#c5def5",
    "--editor-selection-inactive": "#e0e8f0",
    "--editor-widget": "#ffffff",
    "--editor-widget-border": "#cbd2d9",
  },
};

function token(name: string, theme: UiColorTheme): string {
  return cssVar(name, THEME_FALLBACKS[theme][name] ?? "");
}

const DIFF_COLORS = {
  "diffEditor.insertedTextBackground": "#23863633",
  "diffEditor.removedTextBackground": "#cb242533",
  "diffEditorGutter.insertedLineBackground": "#23863622",
  "diffEditorGutter.removedLineBackground": "#cb242522",
} as const;

export function monacoThemeColors(theme: UiColorTheme = "dark"): Record<string, string> {
  return {
    "editor.background": token("--surface-2", theme),
    "editor.foreground": token("--fg-default", theme),
    "editor.lineHighlightBackground": token("--editor-line", theme),
    "editor.lineHighlightBorder": "#00000000",
    "editorLineNumber.foreground": token("--editor-number", theme),
    "editorLineNumber.activeForeground": token("--fg-default", theme),
    "editorCursor.foreground": token("--editor-cursor", theme),
    "editorGutter.background": token("--surface-2", theme),
    "editorIndentGuide.background": token("--editor-guide", theme),
    "editorIndentGuide.activeBackground": token("--editor-guide-active", theme),
    "editor.selectionBackground": token("--editor-selection", theme),
    "editor.inactiveSelectionBackground": token("--editor-selection-inactive", theme),
    "editorWidget.background": token("--editor-widget", theme),
    "editorWidget.border": token("--editor-widget-border", theme),
    "editorSuggestWidget.background": theme === "light" ? "#ffffff" : "#252526",
    "editorSuggestWidget.border": theme === "light" ? "#c5cbd3" : "#454545",
    "editorSuggestWidget.foreground": theme === "light" ? "#26313d" : "#d4d4d4",
    "editorSuggestWidget.selectedBackground": theme === "light" ? "#cbe7ff" : "#094771",
    "editorSuggestWidget.selectedForeground": theme === "light" ? "#17212b" : "#ffffff",
    "editorSuggestWidget.highlightForeground": theme === "light" ? "#07549b" : "#4fc1ff",
    "editorSuggestWidget.focusHighlightForeground":
      theme === "light" ? "#003f7d" : "#9cdcfe",
    "editorSuggestWidgetStatus.foreground": theme === "light" ? "#536273" : "#b8b8b8",
    "list.foreground": theme === "light" ? "#26313d" : "#d4d4d4",
    "list.focusForeground": theme === "light" ? "#17212b" : "#ffffff",
    "list.activeSelectionForeground": theme === "light" ? "#17212b" : "#ffffff",
    "list.inactiveSelectionForeground": theme === "light" ? "#26313d" : "#d4d4d4",
    "list.highlightForeground": theme === "light" ? "#07549b" : "#4fc1ff",
    "list.activeSelectionBackground": theme === "light" ? "#cbe7ff" : "#094771",
    "list.focusBackground": theme === "light" ? "#cbe7ff" : "#094771",
    "list.inactiveSelectionBackground": theme === "light" ? "#e6f3ff" : "#37373d",
    "scrollbarSlider.background": theme === "light" ? "#6b778566" : "#79797966",
    "scrollbarSlider.hoverBackground": theme === "light" ? "#536273b3" : "#646464b3",
    "scrollbarSlider.activeBackground": theme === "light" ? "#36445466" : "#bfbfbf66",
    ...DIFF_COLORS,
  };
}

export function monacoEditorColors(theme: UiColorTheme = "dark"): Record<string, string> {
  return monacoThemeColors(theme);
}

export function monacoDiffColors(theme: UiColorTheme = "dark"): Record<string, string> {
  return monacoThemeColors(theme);
}

type XtermTheme = Required<
  Pick<ITheme, "background" | "foreground" | "cursor" | "selectionBackground">
>;

export type XtermAnsiTheme = Pick<
  ITheme,
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite"
  | "selectionForeground"
>;

const DARK_ANSI: XtermAnsiTheme = {
  black: "#000000",
  red: "#cd3131",
  green: "#0dbc79",
  yellow: "#e5e510",
  blue: "#2472c8",
  magenta: "#bc3fbc",
  cyan: "#11a8cd",
  white: "#e5e5e5",
  brightBlack: "#666666",
  brightRed: "#cd3131",
  brightGreen: "#14ce14",
  brightYellow: "#e5e510",
  brightBlue: "#5cb2ff",
  brightMagenta: "#bc3fbc",
  brightCyan: "#29b8db",
  brightWhite: "#e5e5e5",
  selectionForeground: "#ffffff",
};

const LIGHT_ANSI: XtermAnsiTheme = {
  black: "#1f2933",
  red: "#cd3131",
  green: "#107c10",
  yellow: "#795e26",
  blue: "#0451a5",
  magenta: "#af00db",
  cyan: "#0598bc",
  white: "#555555",
  brightBlack: "#616161",
  brightRed: "#a31515",
  brightGreen: "#0b6a0b",
  brightYellow: "#795e26",
  brightBlue: "#003f8f",
  brightMagenta: "#7a00a3",
  brightCyan: "#047f9b",
  brightWhite: "#1f2933",
  selectionForeground: "#17212b",
};

export function xtermTheme(theme: UiColorTheme = "dark"): XtermTheme {
  return {
    background: token("--surface-2", theme),
    foreground: token("--fg-default", theme),
    cursor: theme === "light" ? "#1f2933" : "#aeafad",
    selectionBackground: theme === "light" ? "#c5def5" : "#264f78",
  };
}

export function workflowXtermTheme(theme: UiColorTheme = "dark"): XtermTheme {
  return {
    background: theme === "light" ? "#ffffff" : "#101010",
    foreground: theme === "light" ? "#26313d" : "#d6d6d6",
    cursor: token("--color-link-strong", theme),
    selectionBackground: theme === "light" ? "#c5def5" : "#264f78",
  };
}

export function xtermAnsiTheme(theme: UiColorTheme = "dark"): XtermAnsiTheme {
  return theme === "light" ? { ...LIGHT_ANSI } : { ...DARK_ANSI };
}

/** Remove explicit terminal background colors so light mode keeps a light canvas. */
export function normalizeLightTerminalAnsi(data: string, theme: UiColorTheme = "dark"): string {
  if (theme !== "light" || !data.includes("\x1b[")) return data;
  return data.replace(/\x1b\[([0-9;]*)m/g, (_sequence, rawParams: string) => {
    const params = rawParams === "" ? [0] : rawParams.split(";").map((value) => Number(value));
    const kept: number[] = [];
    for (let index = 0; index < params.length; index += 1) {
      const param = params[index];
      if ((param >= 40 && param <= 47) || (param >= 100 && param <= 107) || param === 49) {
        continue;
      }
      if (param === 48) {
        const mode = params[index + 1];
        index += mode === 5 ? 2 : mode === 2 ? 4 : 1;
        continue;
      }
      kept.push(param);
    }
    return kept.length ? `\x1b[${kept.join(";")}m` : "";
  });
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
