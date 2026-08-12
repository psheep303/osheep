import { useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { DiffPane } from "./DiffPane";

export interface MultiDiffEntry {
  path: string;
  leftContent: string;
  rightContent: string;
  leftMissing: boolean;
  rightMissing: boolean;
  binary: boolean;
}

interface MultiDiffPaneProps {
  entries: MultiDiffEntry[];
  fontSize: number;
  title: string;
  /** Hide the SCM-style file tree and use the full editor surface. */
  showFileList?: boolean;
}

export function MultiDiffPane({ entries, fontSize, title, showFileList = true }: MultiDiffPaneProps) {
  const { resolvedLanguage } = useUiPreferences();
  const [selectedPath, setSelectedPath] = useState(entries[0]?.path ?? null);
  const selected = entries.find((entry) => entry.path === selectedPath) ?? entries[0] ?? null;

  if (!selected) {
    return (
      <div className="empty-hint">
        {resolvedLanguage === "zh-CN" ? "没有可显示的更改" : "No changes to display"}
      </div>
    );
  }

  if (!showFileList) {
    return (
      <div className="multi-diff-pane multi-diff-pane--stacked">
        {entries.map((entry) => (
          <div key={entry.path} className="multi-diff-pane__stacked-editor">
            {entry.binary ? (
              <div className="empty-hint">
                {resolvedLanguage === "zh-CN"
                  ? "浜岃繘鍒舵枃浠舵棤娉曟樉绀烘枃鏈?Diff"
                  : "Binary files cannot display a text diff"}
              </div>
            ) : (
              <DiffPane
                path={entry.path}
                fontSize={fontSize}
                leftContent={entry.leftContent}
                rightContent={entry.rightContent}
              />
            )}
          </div>
        ))}
      </div>
    );
  }

  return (
    <div className="multi-diff-pane">
      <aside className="multi-diff-pane__files" aria-label={title}>
        <div className="multi-diff-pane__header">
          <span>{title}</span>
          <span className="multi-diff-pane__count">{entries.length}</span>
        </div>
        <div className="multi-diff-pane__list">
          {entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className={`multi-diff-pane__file${entry.path === selected.path ? " is-active" : ""}`}
              onClick={() => setSelectedPath(entry.path)}
              title={entry.path}
            >
              <i
                className={`codicon codicon-${entry.binary ? "file-binary" : "diff-modified"}`}
                aria-hidden="true"
              />
              <span className="multi-diff-pane__file-name">{entry.path}</span>
            </button>
          ))}
        </div>
      </aside>
      <div className="multi-diff-pane__editor">
        {selected.binary ? (
          <div className="empty-hint">
            {resolvedLanguage === "zh-CN"
              ? "二进制文件无法显示文本 Diff"
              : "Binary files cannot display a text diff"}
          </div>
        ) : (
          <DiffPane
            key={selected.path}
            path={selected.path}
            fontSize={fontSize}
            leftContent={selected.leftContent}
            rightContent={selected.rightContent}
          />
        )}
      </div>
    </div>
  );
}
