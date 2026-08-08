import "./monaco-setup";
import Editor, { type OnMount } from "@monaco-editor/react";
import type * as Monaco from "monaco-editor";
import { useEffect, useRef } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { languageFromPath } from "./language";
import { monacoEditorColors } from "./theme";

export interface GotoTarget {
  line: number;
  column?: number;
  nonce: number;
}

export interface EditorCursorStatus {
  line: number;
  column: number;
  selectedCharacters: number;
}

interface EditorPaneProps {
  path: string;
  value: string;
  fontSize: number;
  tabSize: number;
  onChange: (value: string) => void;
  onSave: () => void;
  goto?: GotoTarget | null;
  onCursorStatus?: (status: EditorCursorStatus) => void;
}

function defineMonacoTheme(monaco: typeof import("monaco-editor"), theme: "light" | "dark") {
  monaco.editor.defineTheme(`osheep-${theme}`, {
    base: theme === "light" ? "vs" : "vs-dark",
    inherit: true,
    rules: [],
    colors: monacoEditorColors(theme),
  });
}

export function EditorPane({
  path,
  value,
  fontSize,
  tabSize,
  onChange,
  onSave,
  goto,
  onCursorStatus,
}: EditorPaneProps) {
  const { resolvedTheme } = useUiPreferences();
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorStatusRef = useRef(onCursorStatus);
  onCursorStatusRef.current = onCursorStatus;

  const editorRef = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import("monaco-editor") | null>(null);
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
    monacoRef.current = monaco;
    defineMonacoTheme(monaco, resolvedTheme);
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => onSaveRef.current());
    const reportCursor = () => {
      const position = editor.getPosition();
      const selection = editor.getSelection();
      if (!position) return;
      onCursorStatusRef.current?.({
        line: position.lineNumber,
        column: position.column,
        selectedCharacters:
          selection && !selection.isEmpty()
            ? (editor.getModel()?.getValueLengthInRange(selection) ?? 0)
            : 0,
      });
    };
    editor.onDidChangeCursorSelection(reportCursor);
    editor.onDidChangeModel(reportCursor);
    reportCursor();
    if (goto && appliedNonceRef.current !== goto.nonce) {
      // Defer until next tick so the model is fully attached.
      window.setTimeout(() => applyGoto(goto), 0);
    }
  };

  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    defineMonacoTheme(monaco, resolvedTheme);
    monaco.editor.setTheme(`osheep-${resolvedTheme}`);
  }, [resolvedTheme]);

  useEffect(() => {
    if (!goto) return;
    if (appliedNonceRef.current === goto.nonce) return;
    if (!editorRef.current) return;
    applyGoto(goto);
  }, [goto]);

  return (
    <Editor
      height="100%"
      theme={`osheep-${resolvedTheme}`}
      path={path}
      language={languageFromPath(path)}
      value={value}
      beforeMount={(monaco) => defineMonacoTheme(monaco, resolvedTheme)}
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
