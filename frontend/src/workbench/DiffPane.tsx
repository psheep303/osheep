import "./monaco-setup";
import { type BeforeMount, DiffEditor } from "@monaco-editor/react";
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

const beforeMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme("osheep-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: monacoDiffColors(),
  });
};

export function DiffPane({ path, fontSize, leftContent, rightContent }: DiffPaneProps) {
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
