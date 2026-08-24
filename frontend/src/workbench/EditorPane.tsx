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
  readOnly?: boolean;
  goto?: GotoTarget | null;
  onCursorStatus?: (status: EditorCursorStatus) => void;
  onPasteImage?: (file: File) => Promise<string | null>;
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
  readOnly = false,
  goto,
  onCursorStatus,
  onPasteImage,
}: EditorPaneProps) {
  const { resolvedTheme } = useUiPreferences();
  const onSaveRef = useRef(onSave);
  onSaveRef.current = onSave;
  const onCursorStatusRef = useRef(onCursorStatus);
  onCursorStatusRef.current = onCursorStatus;
  const onPasteImageRef = useRef(onPasteImage);
  onPasteImageRef.current = onPasteImage;

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
    const domNode = editor.getDomNode();
    const handlePaste = (event: ClipboardEvent) => {
      if (!onPasteImageRef.current) return;
      if (!domNode?.contains(document.activeElement)) return;
      const items = Array.from(event.clipboardData?.items ?? []);
      const clipboardTypes = Array.from(event.clipboardData?.types ?? []);
      const file =
        items.find((item) => item.kind === "file" && item.type.startsWith("image/"))?.getAsFile() ??
        Array.from(event.clipboardData?.files ?? []).find((candidate) =>
          candidate.type.startsWith("image/"),
        );
      const hasImageType =
        items.some((item) => item.type.startsWith("image/")) ||
        clipboardTypes.some((type) => type.startsWith("image/"));
      const insertImage = (image: File) => {
        event.preventDefault();
        event.stopPropagation();
        void onPasteImageRef.current?.(image).then((text) => {
          if (!text) return;
          const selection = editor.getSelection();
          if (!selection) return;
          editor.executeEdits("paste-image", [{ range: selection, text, forceMoveMarkers: true }]);
          editor.focus();
        });
      };
      if (file) {
        insertImage(file);
        return;
      }
      if (!hasImageType || !navigator.clipboard?.read) return;
      // Some screenshot tools expose only text/html or Files in the paste
      // event and reveal the actual image only through the async Clipboard API.
      // Leave ordinary text paste untouched; insert the image if one is found.
      event.preventDefault();
      event.stopPropagation();
      void navigator.clipboard
        .read()
        .then(async (clipboardItems) => {
          for (const item of clipboardItems) {
            const type = item.types.find((value) => value.startsWith("image/"));
            if (!type) continue;
            const blob = await item.getType(type);
            insertImage(new File([blob], `pasted-image.${type.split("/")[1] ?? "png"}`, { type }));
            return;
          }
        })
        .catch(() => undefined);
    };
    document.addEventListener("paste", handlePaste, true);
    reportCursor();
    if (goto && appliedNonceRef.current !== goto.nonce) {
      // Defer until next tick so the model is fully attached.
      window.setTimeout(() => applyGoto(goto), 0);
    }
    return () => document.removeEventListener("paste", handlePaste, true);
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
        // Avoid compositor layer snapping during IME composition. On some
        // Chromium/Windows combinations it paints a duplicate glyph near the
        // editor edge and makes CJK input appear bold.
        disableLayerHinting: true,
        disableMonospaceOptimizations: true,
        fontLigatures: false,
        minimap: { enabled: true },
        automaticLayout: true,
        readOnly,
        scrollBeyondLastLine: false,
        wordWrap: "off",
        scrollBeyondLastColumn: 5,
        renderLineHighlight: "line",
      }}
    />
  );
}
