import { useCallback, useEffect, useRef, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import {
  addGitRemote,
  type GitBranch,
  type GitChange,
  type GitRemote,
  type GitStatus,
  gitCheckout,
  gitCommit,
  gitDiscard,
  gitFetch,
  gitInit,
  gitPull,
  gitPush,
  gitStage,
  gitUnstage,
  listGitBranches,
  listGitRemotes,
  removeGitRemote,
} from "./api";
import { GitGraph } from "./GitGraph";
import { Resizer } from "./Resizer";

interface GitViewProps {
  workspaceId: string | null;
  status: GitStatus | null;
  onRefreshStatus: () => void;
  onOpenDiff: (path: string, base: "HEAD" | "INDEX", head: "INDEX" | "WORKTREE") => void;
}

const DEFAULT_SPLIT = 0.55;
const MIN_SPLIT = 0;
const MAX_SPLIT = 1;

type CommitMode = "commit" | "commit-push" | "commit-sync";

export function GitView({ workspaceId, status, onRefreshStatus, onOpenDiff }: GitViewProps) {
  const { resolvedLanguage, t } = useUiPreferences();
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [busyLabel, setBusyLabel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [initializing, setInitializing] = useState(false);
  const [remotes, setRemotes] = useState<GitRemote[]>([]);
  const [graphVersion, setGraphVersion] = useState(0);
  const [remotesOpen, setRemotesOpen] = useState(false);
  const [branchOpen, setBranchOpen] = useState(false);
  const [commitMode, setCommitMode] = useState<CommitMode>("commit");
  const [repositoryOpen, setRepositoryOpen] = useState(true);

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

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(true);
    setBusyLabel(label);
    setError(null);
    try {
      await fn();
      refreshAll();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
      setBusyLabel(null);
    }
  };

  if (!workspaceId) {
    return (
      <div className="side-view git-view">
        <div className="side-view__header">
          <span className="side-view__title">{t("git.title")}</span>
        </div>
        <div className="side-view__body side-view__body--padded">
          <div className="muted">{t("git.openFirst")}</div>
        </div>
      </div>
    );
  }

  if (status && !status.isRepo) {
    return (
      <div className="side-view git-view">
        <div className="side-view__header">
          <span className="side-view__title">{t("git.title")}</span>
          <button className="icon-btn" title={t("git.refresh")} onClick={refreshAll}>
            <RefreshIcon />
          </button>
        </div>
        <div className="side-view__body side-view__body--padded">
          <div className="muted">{t("git.notRepo")}</div>
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
            {t(initializing ? "git.initializing" : "git.init")}
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
  const ahead = status?.ahead ?? 0;
  const behind = status?.behind ?? 0;
  const hasUpstream = !!status?.upstream;
  const hasRemotes = remotes.length > 0;
  const detached = !!status?.detached;

  const doCommit = (mode: CommitMode) =>
    void run(t("git.committing"), async () => {
      await gitCommit(workspaceId, message);
      setMessage("");
      if (mode === "commit-sync") {
        setBusyLabel(t("git.syncing"));
        if (behind > 0) await gitPull(workspaceId, {});
        await gitPush(workspaceId, hasUpstream ? {} : autoPushOpts(remotes, status));
      } else if (mode === "commit-push") {
        setBusyLabel(t("git.pushing"));
        await gitPush(workspaceId, hasUpstream ? {} : autoPushOpts(remotes, status));
      }
    });

  const doSync = () =>
    void run(t("git.syncing"), async () => {
      if (!hasUpstream) {
        await gitPush(workspaceId, autoPushOpts(remotes, status));
        return;
      }
      if (behind > 0) await gitPull(workspaceId, {});
      if (ahead > 0 || behind === 0) await gitPush(workspaceId, {});
    });

  const doFetch = () =>
    void run(t("git.pulling"), async () => {
      await gitFetch(workspaceId, null, false);
    });

  const doPull = () =>
    void run(t("git.pulling"), async () => {
      await gitPull(workspaceId, {});
    });

  const doPush = () =>
    void run(t("git.pushing"), async () => {
      await gitPush(workspaceId, hasUpstream ? {} : autoPushOpts(remotes, status));
    });

  const showSyncAction = staged.length === 0 && unstaged.length === 0 && (ahead > 0 || behind > 0);
  const commitPlaceholder = status?.branch
    ? resolvedLanguage === "zh-CN"
      ? `消息(Ctrl+Enter 在“${status.branch}”提交)`
      : `Message (Ctrl+Enter to commit on '${status.branch}')`
    : t("git.commitPlaceholder");

  return (
    <div className="side-view git-view">
      <div className="side-view__header git-view__header">
        <span className="side-view__title">{t("git.title")}</span>
        <RemotesButton
          open={remotesOpen}
          onToggle={() => {
            setRemotesOpen((v) => !v);
            setBranchOpen(false);
          }}
        />
      </div>

      <div
        className="git-view__repository-header"
        onClick={() => setRepositoryOpen((open) => !open)}
      >
        <span className="search-view__chevron">
          <ChevronIcon open={repositoryOpen} />
        </span>
        <span className="git-view__repository-title">{t("git.changes")}</span>
        <div className="git-view__repository-actions" onClick={(event) => event.stopPropagation()}>
          <button
            className="icon-btn"
            title={t("git.commitOnly")}
            disabled={!canCommit}
            onClick={() => doCommit("commit")}
          >
            <i className="codicon codicon-check" aria-hidden="true" />
          </button>
          <button
            className="icon-btn"
            title={t("git.refresh")}
            onClick={refreshAll}
            disabled={busy}
          >
            <RefreshIcon />
          </button>
          <button
            className={`icon-btn${branchOpen ? " is-active" : ""}`}
            title={t("git.switchBranch")}
            disabled={detached || busy}
            onClick={() => {
              setBranchOpen((open) => !open);
              setRemotesOpen(false);
            }}
          >
            <BranchIcon />
          </button>
        </div>
      </div>

      {remotesOpen && (
        <RemotesPopover
          workspaceId={workspaceId}
          remotes={remotes}
          busy={busy}
          onChanged={refreshAll}
          onClose={() => setRemotesOpen(false)}
        />
      )}

      {branchOpen && workspaceId && (
        <BranchPopover
          workspaceId={workspaceId}
          currentBranch={status?.branch ?? null}
          busy={busy}
          onClose={() => setBranchOpen(false)}
          onChanged={refreshAll}
        />
      )}

      {repositoryOpen && (
        <div className="git-view__commit">
          <textarea
            className="git-view__msg"
            placeholder={commitPlaceholder}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter" && event.ctrlKey && canCommit) {
                event.preventDefault();
                doCommit(commitMode);
              }
            }}
            rows={2}
            spellCheck={false}
          />
          {showSyncAction ? (
            <button className="primary-btn git-view__sync-primary" disabled={busy} onClick={doSync}>
              <SyncIcon />
              {resolvedLanguage === "zh-CN" ? "同步更改" : "Sync Changes"}
              {behind > 0 ? ` ${behind}↓` : ""}
              {ahead > 0 ? ` ${ahead}↑` : ""}
            </button>
          ) : (
            <CommitSplitButton
              mode={commitMode}
              disabled={!canCommit}
              hasRemotes={hasRemotes}
              busyLabel={busy ? busyLabel : null}
              onModeChange={(m) => setCommitMode(m)}
              onCommit={() => doCommit(commitMode)}
            />
          )}
        </div>
      )}

      {error && (
        <div className="git-view__error">
          {error}
          <button
            className="banner-error__close"
            onClick={() => setError(null)}
            title={t("common.close")}
          >
            ×
          </button>
        </div>
      )}

      <SplitSections
        changesNode={
          <>
            {repositoryOpen && staged.length > 0 && (
              <GitSection
                title={t("git.staged")}
                count={staged.length}
                changes={staged}
                kind="staged"
                onClickFile={(c) => onOpenDiff(c.path, "HEAD", "INDEX")}
                onAction={(c) =>
                  void run(t("git.processing"), () => gitUnstage(workspaceId, [c.path]))
                }
                onBulk={() =>
                  void run(t("git.processing"), () =>
                    gitUnstage(
                      workspaceId,
                      staged.map((c) => c.path),
                    ),
                  )
                }
                busy={busy}
              />
            )}
            {repositoryOpen && (
              <GitSection
                title={t("git.changes")}
                count={unstaged.length}
                changes={unstaged}
                kind="unstaged"
                onClickFile={(c) => onOpenDiff(c.path, "INDEX", "WORKTREE")}
                onAction={(c) =>
                  void run(t("git.processing"), () => gitStage(workspaceId, [c.path]))
                }
                onDiscard={async (c) => {
                  const ok = window.confirm(`确定要撤销对 ${c.path} 的修改吗？此操作不可逆。`);
                  if (!ok) return;
                  await run(t("git.discarding"), () =>
                    gitDiscard(workspaceId, [c.path]).then(() => undefined),
                  );
                }}
                onBulk={() =>
                  void run(t("git.processing"), () =>
                    gitStage(
                      workspaceId,
                      unstaged.map((c) => c.path),
                    ),
                  )
                }
                busy={busy}
              />
            )}
          </>
        }
        graphNode={
          <GraphSection
            workspaceId={workspaceId}
            refreshKey={graphVersion}
            status={status}
            remoteUrl={remotes.find((remote) => remote.name === "origin")?.url ?? remotes[0]?.url}
            busy={busy}
            onFetch={doFetch}
            onPull={doPull}
            onPush={doPush}
            onRefresh={refreshAll}
            onMore={() => setRemotesOpen(true)}
          />
        }
      />
    </div>
  );
}

function autoPushOpts(
  remotes: GitRemote[],
  status: GitStatus | null,
): { remote: string; branch: string; setUpstream: true } | Record<string, never> {
  if (!status?.branch || remotes.length === 0) return {};
  const remote = remotes.find((r) => r.name === "origin")?.name ?? remotes[0].name;
  return { remote, branch: status.branch, setUpstream: true };
}

function CommitSplitButton({
  mode,
  disabled,
  hasRemotes,
  busyLabel,
  onModeChange,
  onCommit,
}: {
  mode: CommitMode;
  disabled: boolean;
  hasRemotes: boolean;
  busyLabel: string | null;
  onModeChange: (m: CommitMode) => void;
  onCommit: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [menuOpen]);

  const label = busyLabel ?? labelOf(mode);
  const isBusy = !!busyLabel;

  return (
    <div className="git-view__commit-split" ref={rootRef}>
      <button
        className="primary-btn git-view__commit-btn"
        disabled={disabled || isBusy}
        onClick={onCommit}
      >
        {label}
      </button>
      <button
        className="primary-btn git-view__commit-more"
        disabled={isBusy}
        onClick={() => setMenuOpen((v) => !v)}
        title="提交选项"
      >
        ▾
      </button>
      {menuOpen && (
        <div className="git-view__commit-menu">
          <button
            className={`git-view__commit-menu-item${mode === "commit" ? " is-active" : ""}`}
            onClick={() => {
              onModeChange("commit");
              setMenuOpen(false);
            }}
          >
            ✓ 仅提交
          </button>
          <button
            className={
              "git-view__commit-menu-item" +
              (mode === "commit-push" ? " is-active" : "") +
              (!hasRemotes ? " is-disabled" : "")
            }
            disabled={!hasRemotes}
            onClick={() => {
              onModeChange("commit-push");
              setMenuOpen(false);
            }}
          >
            ✓ 提交并推送
          </button>
          <button
            className={
              "git-view__commit-menu-item" +
              (mode === "commit-sync" ? " is-active" : "") +
              (!hasRemotes ? " is-disabled" : "")
            }
            disabled={!hasRemotes}
            onClick={() => {
              onModeChange("commit-sync");
              setMenuOpen(false);
            }}
          >
            ✓ 提交并同步
          </button>
        </div>
      )}
    </div>
  );
}

function labelOf(mode: CommitMode): string {
  if (mode === "commit-push") return "✓ 提交并推送";
  if (mode === "commit-sync") return "✓ 提交并同步";
  return "✓ 提交";
}

function BranchPopover({
  workspaceId,
  currentBranch,
  busy,
  onClose,
  onChanged,
}: {
  workspaceId: string;
  currentBranch: string | null;
  busy: boolean;
  onClose: () => void;
  onChanged: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [branches, setBranches] = useState<GitBranch[]>([]);
  const [loading, setLoading] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [localBusy, setLocalBusy] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    void listGitBranches(workspaceId)
      .then((r) => {
        if (!cancelled) setBranches(r.branches);
      })
      .catch((e) => {
        if (!cancelled) setErr((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (!rootRef.current) return;
      const t = e.target as HTMLElement | null;
      if (t && rootRef.current.contains(t)) return;
      if (t?.closest?.(".git-view__branch-btn")) return;
      onClose();
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [onClose]);

  const filterLower = filter.trim().toLowerCase();
  const filtered = filterLower
    ? branches.filter((b) => b.name.toLowerCase().includes(filterLower))
    : branches;
  const locals = filtered.filter((b) => b.kind === "local");
  const remotes = filtered.filter((b) => b.kind === "remote");

  const canCreate = filter.trim().length > 0 && !branches.some((b) => b.name === filter.trim());

  const doCheckout = async (ref: string, opts: { create?: boolean; fromRef?: string } = {}) => {
    setLocalBusy(true);
    setErr(null);
    try {
      await gitCheckout(workspaceId, ref, opts);
      onChanged();
      onClose();
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setLocalBusy(false);
    }
  };

  return (
    <div className="git-view__branch-popover" ref={rootRef}>
      <div className="git-view__remotes-popover-header">
        <span>切换分支</span>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="git-view__branch-search">
        <input
          className="git-view__input"
          type="text"
          placeholder="过滤 / 新分支名…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          spellCheck={false}
        />
      </div>
      {filter.trim() && canCreate && (
        <button
          className="git-view__branch-create"
          disabled={busy || localBusy}
          onClick={() => void doCheckout(filter.trim(), { create: true })}
        >
          + 创建新分支 "{filter.trim()}"
        </button>
      )}
      {err && <div className="git-view__error">{err}</div>}
      <div className="git-view__branch-list">
        {loading && <div className="git-view__remotes-empty">加载中…</div>}
        {!loading && filtered.length === 0 && (
          <div className="git-view__remotes-empty">没有匹配的分支</div>
        )}
        {locals.length > 0 && <div className="git-view__branch-group">本地</div>}
        {locals.map((b) => (
          <button
            key={`local:${b.name}`}
            className={`git-view__branch-item${b.isCurrent ? " is-current" : ""}`}
            disabled={b.isCurrent || busy || localBusy}
            onClick={() => void doCheckout(b.name)}
            title={b.upstream ? `tracking ${b.upstream}` : undefined}
          >
            <span className="git-view__branch-mark">{b.isCurrent ? "★" : ""}</span>
            <span className="git-view__branch-item-name">{b.name}</span>
            {b.upstream && <span className="git-view__branch-upstream">{b.upstream}</span>}
          </button>
        ))}
        {remotes.length > 0 && <div className="git-view__branch-group">远程</div>}
        {remotes.map((b) => {
          const localName = b.name.replace(/^[^/]+\//, "");
          const hasLocal = branches.some((x) => x.kind === "local" && x.name === localName);
          return (
            <button
              key={`remote:${b.name}`}
              className="git-view__branch-item git-view__branch-item--remote"
              disabled={busy || localBusy}
              onClick={() =>
                void doCheckout(
                  hasLocal ? localName : localName,
                  hasLocal ? {} : { create: true, fromRef: b.name },
                )
              }
              title={
                hasLocal
                  ? `切换到本地分支 ${localName}`
                  : `基于 ${b.name} 创建本地跟踪分支 ${localName}`
              }
            >
              <span className="git-view__branch-mark" />
              <span className="git-view__branch-item-name">{b.name}</span>
            </button>
          );
        })}
      </div>
      {currentBranch && (
        <div className="git-view__branch-foot">
          当前：<strong>{currentBranch}</strong>
        </div>
      )}
    </div>
  );
}

function SplitSections({
  changesNode,
  graphNode,
}: {
  changesNode: React.ReactNode;
  graphNode: React.ReactNode;
}) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [split, setSplit] = useState(DEFAULT_SPLIT);
  const dragStartRef = useRef({ height: 0, split: DEFAULT_SPLIT });

  const onStart = () => {
    const el = containerRef.current;
    dragStartRef.current = {
      height: el ? el.getBoundingClientRect().height : 0,
      split,
    };
  };
  const onResize = (delta: number) => {
    const h = dragStartRef.current.height;
    if (h <= 0) return;
    const next = clamp(dragStartRef.current.split + delta / h, MIN_SPLIT, MAX_SPLIT);
    dragStartRef.current.split = next;
    setSplit(next);
  };

  const topFlex = split;
  const bottomFlex = 1 - split;

  return (
    <div className="git-view__split" ref={containerRef}>
      <div
        className="git-view__split-pane git-view__split-pane--scroll"
        style={{ flexGrow: topFlex, flexBasis: 0 }}
      >
        {changesNode}
      </div>
      <Resizer axis="y" onResizeStart={onStart} onResize={onResize} />
      <div
        className="git-view__split-pane git-view__split-pane--scroll"
        style={{ flexGrow: bottomFlex, flexBasis: 0 }}
      >
        {graphNode}
      </div>
    </div>
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function RemotesButton({ open, onToggle }: { open: boolean; onToggle: () => void }) {
  return (
    <button
      className={`icon-btn git-view__remotes-btn${open ? " is-active" : ""}`}
      title="管理远程"
      onClick={onToggle}
    >
      <RemoteIcon />
    </button>
  );
}

function RemotesPopover({
  workspaceId,
  remotes,
  busy,
  onChanged,
  onClose,
}: {
  workspaceId: string;
  remotes: GitRemote[];
  busy: boolean;
  onChanged: () => void;
  onClose: () => void;
}) {
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [localBusy, setLocalBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onDocClick = (e: MouseEvent) => {
      if (!rootRef.current) return;
      const target = e.target as Node | null;
      if (target && !rootRef.current.contains(target)) {
        const el = target as HTMLElement;
        if (el.closest?.(".git-view__remotes-btn")) return;
        onClose();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    return () => document.removeEventListener("mousedown", onDocClick);
  }, [onClose]);

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
    <div className="git-view__remotes-popover" ref={rootRef}>
      <div className="git-view__remotes-popover-header">
        <span>远程</span>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="git-view__remotes-list">
        {remotes.length === 0 && !adding && (
          <div className="git-view__remotes-empty">尚未配置任何远程</div>
        )}
        {remotes.map((r) => (
          <div key={r.name} className="git-view__remote-row" title={r.url}>
            <span className="git-view__remote-name">{r.name}</span>
            <span className="git-view__remote-url">{r.url}</span>
            <button
              className="git-view__act"
              title="删除远程"
              disabled={busy || localBusy}
              onClick={() => void submitRemove(r.name)}
            >
              ×
            </button>
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
    </div>
  );
}

function GraphSection({
  workspaceId,
  refreshKey,
  status,
  remoteUrl,
  busy,
  onFetch,
  onPull,
  onPush,
  onRefresh,
  onMore,
}: {
  workspaceId: string;
  refreshKey: number;
  status: GitStatus | null;
  remoteUrl?: string | null;
  busy: boolean;
  onFetch: () => void;
  onPull: () => void;
  onPush: () => void;
  onRefresh: () => void;
  onMore: () => void;
}) {
  const [open, setOpen] = useState(true);
  const [scope, setScope] = useState<"auto" | "all">("auto");
  return (
    <div className="git-view__section git-view__section--graph">
      <div className="git-view__section-header" onClick={() => setOpen((v) => !v)}>
        <span className="search-view__chevron">
          <ChevronIcon open={open} />
        </span>
        <span className="git-view__section-title">图形</span>
        <div className="git-view__graph-actions" onClick={(event) => event.stopPropagation()}>
          <button
            type="button"
            className="git-view__graph-scope"
            title={scope === "auto" ? "自动选择当前分支和上游" : "显示所有分支"}
            onClick={() => setScope((value) => (value === "auto" ? "all" : "auto"))}
          >
            <i className="codicon codicon-git-branch" aria-hidden="true" />
            {scope === "auto" ? "自动" : "所有"}
          </button>
          <button
            type="button"
            className="icon-btn"
            title="转到当前分支"
            onClick={() =>
              document.querySelector<HTMLElement>(".git-graph__row.is-head")?.scrollIntoView({
                block: "center",
              })
            }
          >
            <i className="codicon codicon-target" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="拉取"
            disabled={busy || !status?.upstream}
            onClick={onPull}
          >
            <i className="codicon codicon-cloud-download" aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" title="推送" disabled={busy} onClick={onPush}>
            <i className="codicon codicon-cloud-upload" aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" title="提取" disabled={busy} onClick={onFetch}>
            <i className="codicon codicon-repo-fetch" aria-hidden="true" />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="刷新"
            disabled={busy}
            onClick={onRefresh}
          >
            <i className="codicon codicon-refresh" aria-hidden="true" />
          </button>
          <button type="button" className="icon-btn" title="更多操作" onClick={onMore}>
            <i className="codicon codicon-ellipsis" aria-hidden="true" />
          </button>
        </div>
      </div>
      {open && (
        <GitGraph
          workspaceId={workspaceId}
          refreshKey={refreshKey}
          scope={scope}
          remoteUrl={remoteUrl}
        />
      )}
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
      <div className="git-view__section-header" onClick={() => setOpen((v) => !v)}>
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
                key={`${kind}:${c.path}`}
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
                  className={`git-view__badge git-view__badge--${status.cls}`}
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
  kind: "staged" | "unstaged",
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
  return <i className="codicon codicon-refresh" aria-hidden="true" />;
}

function SyncIcon() {
  return <i className="codicon codicon-sync" aria-hidden="true" />;
}

function RemoteIcon() {
  return <i className="codicon codicon-ellipsis" aria-hidden="true" />;
}

function BranchIcon() {
  return <i className="codicon codicon-git-branch" aria-hidden="true" />;
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function dirname(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}
