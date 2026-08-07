import { useUiPreferences } from "../i18n/UiPreferences";
import type { GitStatus } from "./api";
import type { EditorCursorStatus } from "./EditorPane";
import { languageLabelFromPath } from "./language";

interface StatusBarProps {
  status: GitStatus | null;
  activeFilePath: string | null;
  cursor: EditorCursorStatus | null;
  onOpenGit: () => void;
}

export function StatusBar({ status, activeFilePath, cursor, onOpenGit }: StatusBarProps) {
  const { resolvedLanguage } = useUiPreferences();
  const isChinese = resolvedLanguage === "zh-CN";
  const stagedCount =
    status?.changes.filter((change) => change.indexStatus !== " " && change.indexStatus !== "?")
      .length ?? 0;
  const workingCount =
    status?.changes.filter(
      (change) => change.worktreeStatus !== " " && change.worktreeStatus !== "",
    ).length ?? 0;
  const hasChanges = stagedCount > 0 || workingCount > 0;
  const branchIcon =
    stagedCount > 0
      ? "git-branch-staged-changes"
      : hasChanges
        ? "git-branch-changes"
        : "git-branch";
  const fileOpen = !!activeFilePath;

  return (
    <footer className="statusbar" role="status">
      <div className="statusbar__left">
        <button
          className="statusbar__item statusbar__git"
          onClick={onOpenGit}
          title={
            status?.branch
              ? isChinese
                ? `${status.branch}，打开源代码管理`
                : `${status.branch}, open Source Control`
              : isChinese
                ? "打开源代码管理"
                : "Open Source Control"
          }
        >
          <i className={`codicon codicon-${branchIcon}`} aria-hidden="true" />
          <span>{status?.branch ?? (isChinese ? "源代码管理" : "Source Control")}</span>
          {status?.ahead ? <span className="statusbar__sync-count">↑{status.ahead}</span> : null}
          {status?.behind ? <span className="statusbar__sync-count">↓{status.behind}</span> : null}
        </button>
      </div>
      <div className="statusbar__right">
        {fileOpen && cursor && (
          <span className="statusbar__item statusbar__cursor">
            <span>
              {isChinese ? "行" : "Ln"} {cursor.line}, {isChinese ? "列" : "Col"} {cursor.column}
            </span>
            {cursor.selectedCharacters > 0 && (
              <span>
                {isChinese
                  ? ` (已选择 ${cursor.selectedCharacters})`
                  : ` (${cursor.selectedCharacters} selected)`}
              </span>
            )}
          </span>
        )}
        {fileOpen && activeFilePath && (
          <span className="statusbar__item">{languageLabelFromPath(activeFilePath)}</span>
        )}
        {fileOpen && <span className="statusbar__item">UTF-8</span>}
      </div>
    </footer>
  );
}
