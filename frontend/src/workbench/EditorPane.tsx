import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import { useRef } from "react";
import { languageFromPath } from "./language";

interface EditorPaneProps {
  path: string;
  value: string;
  fontSize: number;
  tabSize: number;
  onChange: (value: string) => void;
  onSave: () => void;
}

const beforeMount: BeforeMount = (monaco) => {
  monaco.editor.defineTheme("osheep-dark", {
    base: "vs-dark",
    inherit: true,
    rules: [],
    colors: {
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
    },
  });
};

export function EditorPane({
  path,
  value,
  fontSize,
  tabSize,
  onChange,
  onSave,
}: EditorPaneProps) {
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(
      monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS,
      () => onSaveRef.current()
    );
  };

  return (
    <Editor
      height="100%"
      theme="osheep-dark"
      path={path}
      language={languageFromPath(path)}
      value={value}
      beforeMount={beforeMount}
      onChange={(v) => onChange(v ?? "")}
      onMount={handleMount}
      options={{
        fontSize,
        tabSize,
        insertSpaces: true,
        detectIndentation: false,
        minimap: { enabled: true },
        automaticLayout: true,
        scrollBeyondLastLine: false,
        wordWrap: "on",
        renderLineHighlight: "line",
      }}
    />
  );
}
