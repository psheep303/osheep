import { useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { DiffPane } from "./DiffPane";
import { FileIcon } from "./FileIcon";

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
}

export function MultiDiffPane({ entries, fontSize, title }: MultiDiffPaneProps) {
  const { resolvedLanguage } = useUiPreferences();
  const [collapsedPaths, setCollapsedPaths] = useState<Set<string>>(() => new Set());

  if (entries.length === 0) {
    return (
      <div className="empty-hint">
        {resolvedLanguage === "zh-CN" ? "没有可显示的更改" : "No changes to display"}
      </div>
    );
  }

  return (
    <div className="multi-diff-pane" aria-label={title}>
      {entries.map((entry) => {
        const collapsed = collapsedPaths.has(entry.path);
        const { name, parent } = splitFilePath(entry.path);
        return (
          <section
            key={entry.path}
            className={`multi-diff-pane__item${collapsed ? " is-collapsed" : ""}`}
          >
            <button
              type="button"
              className="multi-diff-pane__item-header"
              aria-expanded={!collapsed}
              title={entry.path}
              onClick={() =>
                setCollapsedPaths((current) => {
                  const next = new Set(current);
                  if (next.has(entry.path)) next.delete(entry.path);
                  else next.add(entry.path);
                  return next;
                })
              }
            >
              <i
                className={`codicon codicon-chevron-${collapsed ? "right" : "down"}`}
                aria-hidden="true"
              />
              <span className="multi-diff-pane__item-icon" aria-hidden="true">
                <FileIcon name={entry.path} />
              </span>
              <span className="multi-diff-pane__item-name">{name}</span>
              {parent && <span className="multi-diff-pane__item-parent">{parent}</span>}
            </button>
            {!collapsed && (
              <div className="multi-diff-pane__item-editor">
                {entry.binary ? (
                  <div className="empty-hint">
                    {resolvedLanguage === "zh-CN"
                      ? "二进制文件无法显示文本 Diff"
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
            )}
          </section>
        );
      })}
    </div>
  );
}

function splitFilePath(path: string): { name: string; parent: string } {
  const normalized = path.replace(/\\/g, "/");
  const separator = normalized.lastIndexOf("/");
  if (separator < 0) return { name: normalized, parent: "" };
  return { name: normalized.slice(separator + 1), parent: normalized.slice(0, separator) };
}
