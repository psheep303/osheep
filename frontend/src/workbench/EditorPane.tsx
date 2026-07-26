import Editor, { type BeforeMount, type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { languageFromPath } from "./language";

export interface GotoTarget {
  line: number;
  column?: number;
  nonce: number;
}

interface EditorPaneProps {
  path: string;
  value: string;
  fontSize: number;
  tabSize: number;
  onChange: (value: string) => void;
  onSave: () => void;
  goto?: GotoTarget | null;
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
  goto,
}: EditorPaneProps) {
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const appliedNonceRef = useRef<number | null>(null);

  const applyGoto = (target: GotoTarget) => {
    const editor = editorRef.current;
    if (!editor) return;
    const line = Math.max(1, target.line);
    const column = Math.max(1, target.column ?? 1);
    editor.revealLineInCenter(line);
    editor.setPosition({ lineNumber: line, column });
    editor.focus();
    appliedNonceRef.current = target.nonce;
  };

  const handleMount: OnMount = (editor, monaco) => {
    editorRef.current = editor;
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    if (goto && appliedNonceRef.current !== goto.nonce) {
      // Defer until next tick so the model is fully attached.
      window.setTimeout(() => applyGoto(goto), 0);
    }
  };

  useEffect(() => {
    if (!goto) return;
    if (appliedNonceRef.current === goto.nonce) return;
    if (!editorRef.current) return;
    applyGoto(goto);
  }, [goto, applyGoto]);

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
