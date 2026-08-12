import "./monaco-setup";
import { DiffEditor } from "@monaco-editor/react";
import { useEffect, useRef } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { languageFromPath } from "./language";
import { monacoDiffColors } from "./theme";

interface DiffPaneProps {
  path: string;
  fontSize: number;
  leftContent: string;
  rightContent: string;
  leftLabel?: string;
  rightLabel?: string;
}

function defineMonacoTheme(monaco: typeof import("monaco-editor"), theme: "light" | "dark") {
  monaco.editor.defineTheme(`osheep-${theme}`, {
    base: theme === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: monacoDiffColors(theme),
  });
}

export function DiffPane({ path, fontSize, leftContent, rightContent }: DiffPaneProps) {
  const { resolvedTheme } = useUiPreferences();
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    defineMonacoTheme(monaco, resolvedTheme);
    monaco.editor.setTheme(`osheep-${resolvedTheme}`);
  }, [resolvedTheme]);
  const lang = languageFromPath(path);
  return (
    <DiffEditor
      height="100%"
      theme={`osheep-${resolvedTheme}`}
      original={leftContent}
      modified={rightContent}
      language={lang}
      beforeMount={(monaco) => {
        monacoRef.current = monaco;
        defineMonacoTheme(monaco, resolvedTheme);
      }}
      options={{
        fontSize,
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
        hideUnchangedRegions: {
          enabled: true,
          contextLineCount: 3,
          minimumLineCount: 3,
          revealLineCount: 20,
        },
      }}
    />
  );
}
