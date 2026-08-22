import "./monaco-setup";
import Editor from "@monaco-editor/react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { monacoEditorColors } from "./theme";

interface WorkflowCodeEditorProps {
  nodeId: string;
  value: string;
  fontSize: number;
  tabSize: number;
  disabled?: boolean;
  ariaLabel: string;
  onChange: (value: string) => void;
}

export function WorkflowCodeEditor({
  nodeId,
  value,
  fontSize,
  tabSize,
  disabled,
  ariaLabel,
  onChange,
}: WorkflowCodeEditorProps) {
  const { resolvedTheme } = useUiPreferences();
  const themeName = `osheep-workflow-${resolvedTheme}`;

  return (
    <div className={`workflow-code-editor${disabled ? " is-disabled" : ""}`}>
      <Editor
        height="100%"
        path={`osheep-workflow-${nodeId}.js`}
        language="javascript"
        value={value}
        theme={themeName}
        beforeMount={(monaco) => {
          for (const theme of ["light", "dark"] as const) {
            monaco.editor.defineTheme(`osheep-workflow-${theme}`, {
              base: theme === "light" ? "vs" : "vs-dark",
              inherit: true,
              rules: [],
              colors: monacoEditorColors(theme),
            });
          }
        }}
        onChange={(nextValue) => onChange(nextValue ?? "")}
        options={{
          ariaLabel,
          automaticLayout: true,
          contextmenu: true,
          detectIndentation: false,
          domReadOnly: disabled,
          folding: true,
          fontFamily:
            "Geist Mono, SFMono-Regular, Cascadia Mono, Consolas, Courier New, monospace",
          fontLigatures: false,
          fontSize,
          glyphMargin: false,
          insertSpaces: true,
          lineNumbers: "on",
          minimap: { enabled: false },
          overviewRulerBorder: false,
          overviewRulerLanes: 0,
          padding: { top: 8, bottom: 8 },
          readOnly: disabled,
          renderLineHighlight: "line",
          renderValidationDecorations: "off",
          scrollBeyondLastLine: false,
          tabSize,
          wordWrap: "off",
          scrollBeyondLastColumn: 5,
        }}
      />
    </div>
  );
}
