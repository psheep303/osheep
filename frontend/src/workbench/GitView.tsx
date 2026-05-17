import { useCallback, useEffect, useState } from "react";
import {
  addGitRemote,
  gitCommit,
  gitDiscard,
  gitInit,
  gitStage,
  gitUnstage,
  listGitRemotes,
  removeGitRemote,
  type GitChange,
  type GitRemote,
  type GitStatus,
} from "./api";
import { GitGraph } from "./GitGraph";

interface GitViewProps {
  workspaceId: string | null;
  status: GitStatus | null;
  onRefreshStatus: () => void;
  onOpenDiff: (path: string, base: "HEAD" | "INDEX", head: "INDEX" | "WORKTREE") => void;
}

export function GitView({
  workspaceId,
  status,
  onRefreshStatus,
  onOpenDiff,
}: GitViewProps) {
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [graphVersion, setGraphVersion] = useState(0);

  const isRepo = !!status?.isRepo;

  const refreshRemotes = useCallback(async () => {
    if (!workspaceId || !isRepo) {
      setRemotes([]);
      return;
    }
    try {
      const r = await listGitRemotes(workspaceId);
      setRemotes(r);
    } catch {
      setRemotes([]);
    }
  }, [workspaceId, isRepo]);

  useEffect(() => {
    void refreshRemotes();
  }, [refreshRemotes]);

  const refreshAll = useCallback(() => {
    onRefreshStatus();
    void refreshRemotes();
    setGraphVersion((v) => v + 1);
  }, [onRefreshStatus, refreshRemotes]);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
      refreshAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  if (!workspaceId) {
    return (
      <div className="side-view git-view">
        <div className="side-view__header">
          <span className="side-view__title">源代码管理</span>
        </div>
        <div className="side-view__body side-view__body--padded">
          <div className="muted">请先选择工作区</div>
        </div>
      </div>
    );
  }

  if (status && !status.isRepo) {
    return (
      <div className="side-view git-view">
        <div className="side-view__header">
          <span className="side-view__title">源代码管理</span>
          <button
            className="icon-btn"
            title="刷新"
            onClick={refreshAll}
          >
            <RefreshIcon />
          </button>
        </div>
        <div className="side-view__body side-view__body--padded">
          <div className="muted">当前工作区不是 Git 仓库</div>
          <button
            className="primary-btn"
            style={{ marginTop: 12 }}
            disabled={initializing}
            onClick={async () => {
              setInitializing(true);
              setError(null);
              try {
                await gitInit(workspaceId);
                refreshAll();
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setInitializing(false);
              }
            }}
          >
            {initializing ? "初始化中…" : "初始化仓库 (git init)"}
          </button>
          {error && (
            <div className="git-view__error" style={{ marginTop: 12 }}>
              {error}
            </div>
          )}
        </div>
      </div>
    );
  }

  const staged: GitChange[] = [];
  const unstaged: GitChange[] = [];
  if (status) {
    for (const c of status.changes) {
      const idx = c.indexStatus;
      const wt = c.worktreeStatus;
      if (idx !== " " && idx !== "?") staged.push(c);
      if (wt !== " " && wt !== "" && wt !== undefined) unstaged.push(c);
    }
  }

  const canCommit = staged.length > 0 && message.trim().length > 0 && !busy;

  return (
    <div className="side-view git-view">
      <div className="side-view__header git-view__header">
        <span className="side-view__title">源代码管理</span>
        <button className="icon-btn" title="刷新" onClick={refreshAll}>
          <RefreshIcon />
        </button>
      </div>

      {status?.branch && (
        <div className="git-view__branch">
          <BranchIcon />
          <span className="git-view__branch-name">{status.branch}</span>
          {status.ahead || status.behind ? (
            <span className="git-view__sync">
              {status.behind ? `↓${status.behind} ` : ""}
              {status.ahead ? `↑${status.ahead}` : ""}
            </span>
          ) : null}
        </div>
      )}

      <div className="git-view__commit">
        <textarea
          className="git-view__msg"
          placeholder="提交信息（必填）"
          value={message}
          onChange={(e) => setMessage(e.target.value)}
          rows={2}
          spellCheck={false}
        />
        <button
          className="primary-btn git-view__commit-btn"
          disabled={!canCommit}
          onClick={() =>
            void run(async () => {
              await gitCommit(workspaceId, message);
              setMessage("");
            })
          }
        >
          {busy ? "提交中…" : "✓ 提交"}
        </button>
      </div>

      {error && (
        <div className="git-view__error">
          {error}
          <button
            className="banner-error__close"
            onClick={() => setError(null)}
            title="关闭"
          >
            ×
          </button>
        </div>
      )}

      <div className="git-view__sections">
        {staged.length > 0 && (
          <GitSection
            title="暂存的更改"
            count={staged.length}
            changes={staged}
            kind="staged"
            onClickFile={(c) => onOpenDiff(c.path, "HEAD", "INDEX")}
            onAction={(c) => void run(() => gitUnstage(workspaceId, [c.path]))}
            onBulk={() =>
              void run(() => gitUnstage(workspaceId, staged.map((c) => c.path)))
            }
            busy={busy}
          />
        )}
        <GitSection
          title="更改"
          count={unstaged.length}
          changes={unstaged}
          kind="unstaged"
          onClickFile={(c) => onOpenDiff(c.path, "INDEX", "WORKTREE")}
          onAction={(c) => void run(() => gitStage(workspaceId, [c.path]))}
          onDiscard={async (c) => {
            const ok = window.confirm(`确定要撤销对 ${c.path} 的修改吗？此操作不可逆。`);
            if (!ok) return;
            await run(() => gitDiscard(workspaceId, [c.path]).then(() => undefined));
          }}
          onBulk={() =>
            void run(() => gitStage(workspaceId, unstaged.map((c) => c.path)))
          }
          busy={busy}
        />
        {staged.length === 0 && unstaged.length === 0 && (
          <div className="git-view__empty">没有变更</div>
        )}

        <RemotesSection
          workspaceId={workspaceId}
          remotes={remotes}
          busy={busy}
          onChanged={refreshAll}
        />

        <GraphSection workspaceId={workspaceId} refreshKey={graphVersion} />
      </div>
    </div>
  );
}

function RemotesSection({
  workspaceId,
  remotes,
  busy,
  onChanged,
}: {
  workspaceId: string;
  remotes: GitRemote[];
  busy: boolean;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const submitAdd = async () => {
    if (!name.trim() || !url.trim()) return;
    setLocalBusy(true);
    setErr(null);
    try {
      await addGitRemote(workspaceId, name.trim(), url.trim());
      setName("");
      setUrl("");
      setAdding(false);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLocalBusy(false);
    }
  };

  const submitRemove = async (n: string) => {
    if (!window.confirm(`删除远程 "${n}" 吗？`)) return;
    setLocalBusy(true);
    setErr(null);
    try {
      await removeGitRemote(workspaceId, n);
      onChanged();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <div className="git-view__section">
      <div
        className="git-view__section-header"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="search-view__chevron">
          <ChevronIcon open={open} />
        </span>
        <span className="git-view__section-title">远程</span>
        <span className="git-view__section-count">{remotes.length}</span>
      </div>
      {open && (
        <div className="git-view__rows">
          {remotes.map((r) => (
            <div key={r.name} className="git-view__row git-view__remote-row" title={r.url}>
              <span className="git-view__remote-name">{r.name}</span>
              <span className="git-view__remote-url">{r.url}</span>
              <span className="git-view__actions">
                <button
                  className="git-view__act"
                  title="删除远程"
                  disabled={busy || localBusy}
                  onClick={(e) => {
                    e.stopPropagation();
                    void submitRemove(r.name);
                  }}
                >
                  ×
                </button>
              </span>
            </div>
          ))}
          {!adding && (
            <button
              className="git-view__add-remote"
              disabled={busy || localBusy}
              onClick={() => {
                setAdding(true);
                setErr(null);
              }}
            >
              + 添加远程
            </button>
          )}
          {adding && (
            <div className="git-view__remote-form">
              <input
                className="git-view__input"
                type="text"
                placeholder="名称 (如 origin)"
                value={name}
                onChange={(e) => setName(e.target.value)}
                spellCheck={false}
                disabled={localBusy}
              />
              <input
                className="git-view__input"
                type="text"
                placeholder="URL"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                spellCheck={false}
                disabled={localBusy}
              />
              <div className="git-view__remote-actions">
                <button
                  className="primary-btn"
                  disabled={!name.trim() || !url.trim() || localBusy}
                  onClick={() => void submitAdd()}
                >
                  {localBusy ? "添加中…" : "添加"}
                </button>
                <button
                  className="tb-btn"
                  disabled={localBusy}
                  onClick={() => {
                    setAdding(false);
                    setName("");
                    setUrl("");
                    setErr(null);
                  }}
                >
                  取消
                </button>
              </div>
              {err && <div className="git-view__error">{err}</div>}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function GraphSection({
  workspaceId,
  refreshKey,
}: {
  workspaceId: string;
  refreshKey: number;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="git-view__section git-view__section--graph">
      <div
        className="git-view__section-header"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="search-view__chevron">
          <ChevronIcon open={open} />
        </span>
        <span className="git-view__section-title">图形</span>
      </div>
      {open && <GitGraph workspaceId={workspaceId} refreshKey={refreshKey} />}
    </div>
  );
}

function GitSection({
  title,
  count,
  changes,
  kind,
  onClickFile,
  onAction,
  onDiscard,
  onBulk,
  busy,
}: {
  title: string;
  count: number;
  changes: GitChange[];
  kind: "staged" | "unstaged";
  onClickFile: (c: GitChange) => void;
  onAction: (c: GitChange) => void;
  onDiscard?: (c: GitChange) => void;
  onBulk: () => void;
  busy: boolean;
}) {
  const [open, setOpen] = useState(true);
  return (
    <div className="git-view__section">
      <div
        className="git-view__section-header"
        onClick={() => setOpen((v) => !v)}
      >
        <span className="search-view__chevron">
          <ChevronIcon open={open} />
        </span>
        <span className="git-view__section-title">{title}</span>
        <span className="git-view__section-count">{count}</span>
        {count > 0 && (
          <button
            className="git-view__bulk"
            disabled={busy}
            title={kind === "staged" ? "全部取消暂存" : "全部暂存"}
            onClick={(e) => {
              e.stopPropagation();
              onBulk();
            }}
          >
            {kind === "staged" ? "−" : "+"}
          </button>
        )}
      </div>
      {open && (
        <div className="git-view__rows">
          {changes.map((c) => {
            const status = displayStatus(c, kind);
            return (
              <div
                key={kind + ":" + c.path}
                className="git-view__row"
                onClick={() => onClickFile(c)}
                title={c.path}
              >
                <span className="git-view__name">{basename(c.path)}</span>
                <span className="git-view__path">{dirname(c.path)}</span>
                <span className="git-view__actions">
                  {onDiscard && (
                    <button
                      className="git-view__act"
                      title="撤销变更"
                      disabled={busy}
                      onClick={(e) => {
                        e.stopPropagation();
                        void onDiscard(c);
                      }}
                    >
                      ↺
                    </button>
                  )}
                  <button
                    className="git-view__act"
                    title={kind === "staged" ? "取消暂存" : "暂存"}
                    disabled={busy}
                    onClick={(e) => {
                      e.stopPropagation();
                      onAction(c);
                    }}
                  >
                    {kind === "staged" ? "−" : "+"}
                  </button>
                </span>
                <span
                  className={"git-view__badge git-view__badge--" + status.cls}
                  title={status.label}
                >
                  {status.letter}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function displayStatus(
  c: GitChange,
  kind: "staged" | "unstaged"
): { letter: string; cls: string; label: string } {
  const s = kind === "staged" ? c.indexStatus : c.worktreeStatus;
  if (s === "M") return { letter: "M", cls: "M", label: "Modified" };
  if (s === "A") return { letter: "A", cls: "A", label: "Added" };
  if (s === "D") return { letter: "D", cls: "D", label: "Deleted" };
  if (s === "R") return { letter: "R", cls: "R", label: "Renamed" };
  if (s === "C") return { letter: "C", cls: "C", label: "Conflict" };
  if (s === "?") return { letter: "U", cls: "U", label: "Untracked" };
  return { letter: s || "·", cls: "X", label: s };
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="12"
      height="12"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      style={{
        transform: open ? "rotate(90deg)" : "rotate(0deg)",
        transition: "transform 0.12s",
      }}
    >
      <path d="M5 3 11 8 5 13" />
    </svg>
  );
}

function RefreshIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
    >
      <path d="M2 8a6 6 0 0 1 10.3-4.2L14 5" />
      <path d="M14 2v3h-3" />
      <path d="M14 8a6 6 0 0 1-10.3 4.2L2 11" />
      <path d="M2 14v-3h3" />
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="13"
      height="13"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
    >
      <circle cx="4" cy="3" r="1.5" />
      <circle cx="4" cy="13" r="1.5" />
      <circle cx="12" cy="8" r="1.5" />
      <path d="M4 4.5v7" />
      <path d="M5 3h4a3 3 0 0 1 3 3v1" />
    </svg>
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}
