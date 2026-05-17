import { DiffEditor, type BeforeMount } from "@monaco-editor/react";
import { languageFromPath } from "./language";

interface DiffPaneProps {
  path: string;
  fontSize: number;
  leftContent: string;
  rightContent: string;
  leftLabel?: string;
  rightLabel?: string;
}

const beforeMount: BeforeMount = (monaco) => {
  // Reuse the dark theme registered by EditorPane (idempotent define is safe).
  monaco.editor.defineTheme("osheep-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
      "editor.background": "#1f1f1f",
      "editor.foreground": "#cccccc",
      "diffEditor.insertedTextBackground": "#23863633",
      "diffEditor.removedTextBackground": "#cb242533",
      "diffEditorGutter.insertedLineBackground": "#23863622",
      "diffEditorGutter.removedLineBackground": "#cb242522",
    },
  });
};

export function DiffPane({
  path,
  fontSize,
  leftContent,
  rightContent,
}: DiffPaneProps) {
  const lang = languageFromPath(path);
  return (
    <DiffEditor
      height="100%"
      theme="osheep-dark"
      original={leftContent}
      modified={rightContent}
      language={lang}
      beforeMount={beforeMount}
      options={{
        fontSize,
        readOnly: true,
        renderSideBySide: true,
        automaticLayout: true,
        minimap: { enabled: false },
        scrollBeyondLastLine: false,
        wordWrap: "on",
      }}
    />
  );
}
