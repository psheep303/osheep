import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityBar, type ViewId } from "./ActivityBar";
import { AgentView } from "./AgentView";
import { AiPanel } from "./AiPanel";
import { BottomPanel } from "./BottomPanel";
import { ChatTab } from "./ChatTab";
import { DiffPane } from "./DiffPane";
import { EditorPane, type GotoTarget } from "./EditorPane";
import { FileTree } from "./FileTree";
import { GitView } from "./GitView";
import { MarkdownPreview } from "./MarkdownPreview";
import { Resizer } from "./Resizer";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";
import { WorkspacePicker } from "./WorkspacePicker";
import { DEFAULT_SETTINGS, type OsheepSettings } from "./settings";
import {
  type FsNode,
  loadOsheepSettings,
  readFileText,
  saveOsheepSettings,
  writeFileText,
} from "./fs";
import { getGitDiff, getGitStatus, type GitStatus } from "./api";
import { buildDecorations } from "./git-decorations";
import "./workbench.css";

interface FileTab {
  kind: "file";
  path: string;
  content: string;
  savedContent: string;
  dirty: boolean;
  deleted: boolean;
  previewMode: boolean;
  goto?: GotoTarget | null;
}

interface SettingsTab {
  kind: "settings";
  path: "__settings__";
}

interface AgentTab {
  kind: "agent";
  path: "__agent__";
}

interface ChatTabState {
  kind: "chat";
  path: string; // __chat__:<sessionId>
  sessionId: string;
}

interface DiffTab {
  kind: "diff";
  path: string; // synthetic tab id
  filePath: string;
  base: "HEAD" | "INDEX";
  head: "INDEX" | "WORKTREE";
  leftContent: string;
  rightContent: string;
  binary: boolean;
}

type Tab = FileTab | SettingsTab | AgentTab | ChatTabState | DiffTab;

const SETTINGS_PATH = "__settings__";
const AGENT_PATH = "__agent__";
const CHAT_PREFIX = "__chat__:";
const chatPath = (sessionId: string) => CHAT_PREFIX + sessionId;

const DEFAULT_LEFT_WIDTH = 260;
const DEFAULT_RIGHT_WIDTH = 320;
const DEFAULT_BOTTOM_HEIGHT = 200;
const SIDE_THRESHOLD = 80;
const BOTTOM_THRESHOLD = 60;
const SIDE_MAX = 600;

export function Workbench() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<OsheepSettings>(DEFAULT_SETTINGS);

  const [activeView, setActiveView] = useState<ViewId>("explorer");

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const decorations = useMemo(() => buildDecorations(gitStatus), [gitStatus]);
  const [statusVersion, setStatusVersion] = useState(0);
  const refreshGitStatus = useCallback(() => {
    setStatusVersion((v) => v + 1);
  }, []);

  useEffect(() => {
    if (!workspaceId) {
      setGitStatus(null);
      return;
    }
    let cancelled = false;
    void getGitStatus(workspaceId)
      .then((s) => {
        if (!cancelled) setGitStatus(s);
      })
      .catch(() => {
        if (!cancelled) setGitStatus(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, statusVersion]);

  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  const [rightWidth, setRightWidth] = useState(DEFAULT_RIGHT_WIDTH);
  const [bottomHeight, setBottomHeight] = useState(0);
  // BottomPanel keeps mounting across collapse so terminals survive.
  // Toggling visibility or drag-collapse leaves this true; only an explicit
  // close (× in BottomPanel header) flips it back to false, which unmounts
  // the panel and kills its terminal sessions.
  const [bottomActivated, setBottomActivated] = useState(false);

  const lastLeftWidthRef = useRef(DEFAULT_LEFT_WIDTH);
  const lastRightWidthRef = useRef(DEFAULT_RIGHT_WIDTH);
  const lastBottomHeightRef = useRef(DEFAULT_BOTTOM_HEIGHT);

  const leftProgressRef = useRef(0);
  const rightProgressRef = useRef(0);
  const bottomProgressRef = useRef(0);

  const leftCollapsed = leftWidth === 0;
  const rightCollapsed = rightWidth === 0;
  const bottomCollapsed = bottomHeight === 0;

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    void loadOsheepSettings(workspaceId).then((s) => {
      if (!cancelled) setSettings(s);
    });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const updateSettings = useCallback(
    (next: OsheepSettings) => {
      setSettings(next);
      if (workspaceId) void saveOsheepSettings(workspaceId, next);
    },
    [workspaceId]
  );

  const onChooseWorkspace = useCallback((id: string) => {
    setError(null);
    setWorkspaceId(id);
    setTabs([]);
    setActivePath(null);
    setSelectedTreePath(null);
    setPicking(false);
    if (leftWidth === 0) setLeftWidth(lastLeftWidthRef.current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [leftWidth]);

  const openFile = useCallback(
    async (node: FsNode) => {
      if (node.kind !== "file" || !workspaceId) return;
      const existing = tabs.find(
        (t) => t.kind === "file" && t.path === node.path
      );
      if (existing) {
        setActivePath(node.path);
        return;
      }
      let text: string;
      try {
        text = await readFileText(workspaceId, node.path);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      setTabs((prev) => [
        ...prev,
        {
          kind: "file",
          path: node.path,
          content: text,
          savedContent: text,
          dirty: false,
          deleted: false,
          previewMode: false,
        },
      ]);
      setActivePath(node.path);
    },
    [tabs, workspaceId]
  );

  const openFileAt = useCallback(
    async (filePath: string, line: number, column: number) => {
      if (!workspaceId) return;
      const target: GotoTarget = {
        line,
        column,
        nonce: Date.now() + Math.random(),
      };
      const existing = tabs.find(
        (t) => t.kind === "file" && t.path === filePath
      );
      if (existing) {
        setTabs((prev) =>
          prev.map((t) =>
            t.kind === "file" && t.path === filePath ? { ...t, goto: target } : t
          )
        );
        setActivePath(filePath);
        return;
      }
      let text: string;
      try {
        text = await readFileText(workspaceId, filePath);
      } catch (e) {
        setError((e as Error).message);
        return;
      }
      setTabs((prev) => [
        ...prev,
        {
          kind: "file",
          path: filePath,
          content: text,
          savedContent: text,
          dirty: false,
          deleted: false,
          previewMode: false,
          goto: target,
        },
      ]);
      setActivePath(filePath);
    },
    [tabs, workspaceId]
  );

  const openDiffTab = useCallback(
    async (
      filePath: string,
      base: "HEAD" | "INDEX",
      head: "INDEX" | "WORKTREE"
    ) => {
      if (!workspaceId) return;
      const diffId = `__diff__:${base}:${head}:${filePath}`;
      const existing = tabs.find((t) => t.path === diffId);
      if (existing) {
        setActivePath(diffId);
        return;
      }
      try {
        const d = await getGitDiff(workspaceId, filePath, base, head);
        setTabs((prev) => [
          ...prev,
          {
            kind: "diff",
            path: diffId,
            filePath,
            base,
            head,
            leftContent: d.leftContent,
            rightContent: d.rightContent,
            binary: d.binary,
          },
        ]);
        setActivePath(diffId);
      } catch (e) {
        setError((e as Error).message);
      }
    },
    [tabs, workspaceId]
  );

  const openSettingsTab = useCallback(() => {
    setTabs((prev) => {
      if (prev.some((t) => t.kind === "settings")) return prev;
      return [...prev, { kind: "settings", path: SETTINGS_PATH }];
    });
    setActivePath(SETTINGS_PATH);
  }, []);

  const openAgentTab = useCallback(() => {
    setTabs((prev) => {
      if (prev.some((t) => t.kind === "agent")) return prev;
      return [...prev, { kind: "agent", path: AGENT_PATH }];
    });
    setActivePath(AGENT_PATH);
  }, []);

  const [aiRefreshSignal, setAiRefreshSignal] = useState(0);
  const bumpAiRefresh = useCallback(() => {
    setAiRefreshSignal((v) => v + 1);
  }, []);

  const openChatTab = useCallback((sessionId: string) => {
    const path = chatPath(sessionId);
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) return prev;
      return [...prev, { kind: "chat", path, sessionId }];
    });
    setActivePath(path);
  }, []);

  const onPathRenamed = useCallback(
    (oldPath: string, newPath: string) => {
      const matches = (p: string) => p === oldPath || p.startsWith(oldPath + "/");
      const remap = (p: string) =>
        p === oldPath ? newPath : newPath + p.slice(oldPath.length);
      setTabs((prev) =>
        prev.map((t) =>
          t.kind === "file" && matches(t.path)
            ? { ...t, path: remap(t.path) }
            : t
        )
      );
      if (activePath && matches(activePath)) setActivePath(remap(activePath));
    },
    [activePath]
  );

  const onPathDeleted = useCallback((path: string) => {
    const matches = (p: string) => p === path || p.startsWith(path + "/");
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "file" && matches(t.path) ? { ...t, deleted: true, dirty: false } : t
      )
    );
  }, []);

  const togglePreview = useCallback((path: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "file" && t.path === path
          ? { ...t, previewMode: !t.previewMode }
          : t
      )
    );
  }, []);

  const updateActive = useCallback(
    (value: string) => {
      if (!activePath) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.kind === "file" && t.path === activePath && !t.deleted
            ? { ...t, content: value, dirty: value !== t.savedContent }
            : t
        )
      );
    },
    [activePath]
  );

  const saveActive = useCallback(async () => {
    if (!activePath || !workspaceId) return;
    const tab = tabs.find((t) => t.path === activePath);
    if (!tab || tab.kind !== "file" || tab.deleted) return;
    try {
      await writeFileText(workspaceId, tab.path, tab.content);
    } catch (e) {
      setError((e as Error).message);
      return;
    }
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "file" && t.path === activePath
          ? { ...t, savedContent: t.content, dirty: false }
          : t
      )
    );
    refreshGitStatus();
  }, [activePath, tabs, workspaceId, refreshGitStatus]);

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        const next = prev.filter((t) => t.path !== path);
        if (activePath === path) {
          const fallback =
            next[idx] ?? next[idx - 1] ?? next[next.length - 1] ?? null;
          setActivePath(fallback ? fallback.path : null);
        }
        return next;
      });
    },
    [activePath]
  );

  const onSelectView = (id: ViewId) => {
    if (id === activeView && !leftCollapsed) {
      lastLeftWidthRef.current = leftWidth;
      setLeftWidth(0);
    } else {
      if (leftCollapsed) setLeftWidth(lastLeftWidthRef.current);
      setActiveView(id);
    }
  };

  // ─────────── Resize handlers ───────────

  const onLeftStart = () => {
    leftProgressRef.current = leftWidth;
  };
  const onLeftResize = useCallback((delta: number) => {
    leftProgressRef.current += delta;
    const p = leftProgressRef.current;
    if (p < SIDE_THRESHOLD) {
      setLeftWidth(0);
    } else {
      const w = Math.min(p, SIDE_MAX);
      setLeftWidth(w);
      lastLeftWidthRef.current = w;
    }
  }, []);

  const onRightStart = () => {
    rightProgressRef.current = rightWidth;
  };
  const onRightResize = useCallback((delta: number) => {
    rightProgressRef.current -= delta;
    const p = rightProgressRef.current;
    if (p < SIDE_THRESHOLD) {
      setRightWidth(0);
    } else {
      const w = Math.min(p, SIDE_MAX);
      setRightWidth(w);
      lastRightWidthRef.current = w;
    }
  }, []);

  const onBottomStart = () => {
    bottomProgressRef.current = bottomHeight;
  };
  const onBottomResize = useCallback((delta: number) => {
    bottomProgressRef.current -= delta;
    const p = bottomProgressRef.current;
    if (p < BOTTOM_THRESHOLD) {
      setBottomHeight(0);
    } else {
      const h = Math.min(p, SIDE_MAX);
      setBottomHeight(h);
      lastBottomHeightRef.current = h;
      // Drag-expanding from a hidden state re-activates the panel
      setBottomActivated(true);
    }
  }, []);

  const toggleRight = () => {
    if (rightCollapsed) setRightWidth(lastRightWidthRef.current);
    else {
      lastRightWidthRef.current = rightWidth;
      setRightWidth(0);
    }
  };
  // Soft toggle: only flips visibility. BottomPanel stays mounted so its
  // terminal sessions and any state are preserved across collapse/restore.
  const toggleBottom = () => {
    if (bottomCollapsed) {
      setBottomActivated(true);
      setBottomHeight(lastBottomHeightRef.current);
    } else {
      lastBottomHeightRef.current = bottomHeight;
      setBottomHeight(0);
    }
  };
  // Hard close: invoked by the × button inside the BottomPanel header.
  // Unmounts the panel, which tears down its terminal sessions.
  const hardCloseBottom = () => {
    setBottomActivated(false);
    setBottomHeight(0);
  };

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const activeFileTab = activeTab?.kind === "file" ? activeTab : null;
  const activeDiffTab = activeTab?.kind === "diff" ? activeTab : null;

  return (
    <div className="workbench">
      <div className="titlebar">
        <span className="titlebar__brand">osheep</span>
        <span className="titlebar__sep">·</span>
        <span className="titlebar__project">
          {workspaceId ?? "未选择工作区"}
        </span>
        <div className="titlebar__actions">
          <button className="tb-btn" onClick={() => setPicking(true)}>
            选择工作区…
          </button>
          <button
            className="tb-btn"
            onClick={saveActive}
            disabled={!activeFileTab?.dirty || activeFileTab?.deleted}
          >
            保存
          </button>
          <span className="titlebar__spacer" />
          <LayoutToggle
            active={!bottomCollapsed}
            title="切换底部面板"
            onClick={toggleBottom}
            icon={<PanelBottomIcon />}
          />
          <LayoutToggle
            active={!rightCollapsed}
            title="切换右侧栏"
            onClick={toggleRight}
            icon={<PanelRightIcon />}
          />
        </div>
      </div>

      {error && (
        <div className="banner-error">
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

      <div className="body">
        <ActivityBar
          activeView={activeView}
          collapsed={leftCollapsed}
          onSelect={onSelectView}
          onOpenSettings={openSettingsTab}
          onOpenAgent={openAgentTab}
        />

        {!leftCollapsed && (
          <div className="side" style={{ width: leftWidth }}>
            {activeView === "explorer" &&
              (workspaceId ? (
                <FileTree
                  workspaceId={workspaceId}
                  workspaceName={workspaceId}
                  selectedPath={selectedTreePath}
                  onSelect={setSelectedTreePath}
                  onOpenFile={openFile}
                  onPathRenamed={onPathRenamed}
                  onPathDeleted={onPathDeleted}
                  decorations={decorations}
                  onFsChange={refreshGitStatus}
                />
              ) : (
                <div className="side-view">
                  <div className="side-view__header">
                    <span className="side-view__title">资源管理器</span>
                  </div>
                  <div className="side-view__body side-view__body--padded">
                    <button
                      className="primary-btn"
                      onClick={() => setPicking(true)}
                    >
                      选择工作区
                    </button>
                    <div className="muted" style={{ marginTop: 12 }}>
                      所有文件由后端 osheep-backend 提供
                    </div>
                  </div>
                </div>
              ))}
            {activeView === "search" && (
              <SearchView
                workspaceId={workspaceId}
                onOpenMatch={(p, line, col) => void openFileAt(p, line, col)}
              />
            )}
            {activeView === "git" && (
              <GitView
                workspaceId={workspaceId}
                status={gitStatus}
                onRefreshStatus={refreshGitStatus}
                onOpenDiff={(p, base, head) => void openDiffTab(p, base, head)}
              />
            )}
          </div>
        )}
        <Resizer
          axis="x"
          onResizeStart={onLeftStart}
          onResize={onLeftResize}
        />

        <div className="main">
          <div className="editor-area">
            <div className="tabs">
              <div className="tabs__list">
                {tabs.map((t) => {
                  const isDeleted = t.kind === "file" && t.deleted;
                  const label =
                    t.kind === "settings"
                      ? "设置"
                      : t.kind === "agent"
                      ? "Agent"
                      : t.kind === "chat"
                      ? "对话"
                      : t.kind === "diff"
                      ? `${basename(t.filePath)} (${diffLabel(t)})`
                      : t.path.split("/").pop();
                  const tabTitle =
                    t.kind === "file"
                      ? isDeleted
                        ? `${t.path}（已被删除）`
                        : t.path
                      : t.kind === "diff"
                      ? `${t.filePath} · ${diffLabel(t)}`
                      : t.kind === "agent"
                      ? "Agent"
                      : t.kind === "chat"
                      ? `对话 ${t.sessionId}`
                      : "设置";
                  return (
                    <div
                      key={t.path}
                      className={
                        "tab" +
                        (t.path === activePath ? " is-active" : "") +
                        (isDeleted ? " is-deleted" : "") +
                        (t.kind === "diff" ? " is-diff" : "")
                      }
                      onClick={() => setActivePath(t.path)}
                      title={tabTitle}
                    >
                      <span className="tab__name">
                        {label}
                        {t.kind === "file" && t.dirty ? " ●" : ""}
                      </span>
                      <span
                        className="tab__close"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(t.path);
                        }}
                      >
                        ×
                      </span>
                    </div>
                  );
                })}
              </div>
              {activeFileTab && isMarkdownPath(activeFileTab.path) && (
                <div className="tabs__trailing">
                  <PreviewToggle
                    previewMode={activeFileTab.previewMode}
                    onToggle={() => togglePreview(activeFileTab.path)}
                  />
                </div>
              )}
            </div>
            <div className="editor-host">
              {activeFileTab ? (
                isMarkdownPath(activeFileTab.path) && activeFileTab.previewMode ? (
                  <div className="editor-host__preview">
                    <MarkdownPreview source={activeFileTab.content} />
                  </div>
                ) : (
                  <div className="editor-host__source">
                    <EditorPane
                      path={activeFileTab.path}
                      value={activeFileTab.content}
                      fontSize={settings.editor.fontSize}
                      tabSize={settings.editor.tabSize}
                      onChange={updateActive}
                      onSave={saveActive}
                      goto={activeFileTab.goto ?? null}
                    />
                  </div>
                )
              ) : activeDiffTab ? (
                <div className="editor-host__source">
                  {activeDiffTab.binary ? (
                    <div className="empty-hint">该文件为二进制，无法显示 diff</div>
                  ) : (
                    <DiffPane
                      path={activeDiffTab.filePath}
                      fontSize={settings.editor.fontSize}
                      leftContent={activeDiffTab.leftContent}
                      rightContent={activeDiffTab.rightContent}
                    />
                  )}
                </div>
              ) : activeTab?.kind === "settings" ? (
                <SettingsView
                  settings={settings}
                  onChange={updateSettings}
                  hasProject={!!workspaceId}
                  workspaceId={workspaceId}
                />
              ) : activeTab?.kind === "agent" ? (
                <AgentView
                  workspaceId={workspaceId}
                  settings={settings}
                />
              ) : activeTab?.kind === "chat" ? (
                workspaceId ? (
                  <ChatTab
                    workspaceId={workspaceId}
                    sessionId={activeTab.sessionId}
                    settings={settings}
                    onSessionChanged={bumpAiRefresh}
                  />
                ) : (
                  <div className="empty-hint">请先打开工作区</div>
                )
              ) : (
                <div className="empty-hint">在左侧选择文件以开始编辑</div>
              )}
            </div>
          </div>

          <Resizer
            axis="y"
            onResizeStart={onBottomStart}
            onResize={onBottomResize}
          />
          {bottomActivated && (
            <div
              className={"bottom" + (bottomCollapsed ? " is-hidden" : "")}
              style={{
                height: bottomCollapsed ? 0 : bottomHeight,
              }}
            >
              <BottomPanel
                workspaceId={workspaceId}
                onClose={hardCloseBottom}
              />
            </div>
          )}
        </div>

        <Resizer
          axis="x"
          onResizeStart={onRightStart}
          onResize={onRightResize}
        />
        {!rightCollapsed && (
          <div className="side side--right" style={{ width: rightWidth }}>
            <AiPanel
              workspaceId={workspaceId}
              onClose={toggleRight}
              onOpenSession={openChatTab}
              activeSessionId={
                activeTab?.kind === "chat" ? activeTab.sessionId : null
              }
              refreshSignal={aiRefreshSignal}
            />
          </div>
        )}
      </div>

      {picking && (
        <WorkspacePicker
          currentId={workspaceId}
          onCancel={() => setPicking(false)}
          onChoose={onChooseWorkspace}
        />
      )}
    </div>
  );
}

function LayoutToggle({
  active,
  title,
  icon,
  onClick,
}: {
  active: boolean;
  title: string;
  icon: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      className={"icon-btn icon-btn--lg" + (active ? " is-active" : "")}
      title={title}
      onClick={onClick}
    >
      {icon}
    </button>
  );
}

function PanelBottomIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M3 15h18" />
    </svg>
  );
}

function PanelRightIcon() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinejoin="round"
    >
      <rect x="3" y="4" width="18" height="16" rx="1" />
      <path d="M15 4v16" />
    </svg>
  );
}

function isMarkdownPath(path: string): boolean {
  const lower = path.toLowerCase();
  return (
    lower.endsWith(".md") ||
    lower.endsWith(".markdown") ||
    lower.endsWith(".mdx")
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function diffLabel(t: DiffTab): string {
  if (t.base === "HEAD" && t.head === "INDEX") return "Staged";
  if (t.base === "INDEX" && t.head === "WORKTREE") return "Working Tree";
  return `${t.base} → ${t.head}`;
}

function PreviewToggle({
  previewMode,
  onToggle,
}: {
  previewMode: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      className="preview-toggle"
      title={previewMode ? "切换到源码" : "打开预览"}
      onClick={onToggle}
    >
      {previewMode ? (
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M3 4h10M3 8h10M3 12h6" />
        </svg>
      ) : (
        <svg
          viewBox="0 0 16 16"
          width="14"
          height="14"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.4"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M2 8s2.5-4 6-4 6 4 6 4-2.5 4-6 4-6-4-6-4z" />
          <circle cx="8" cy="8" r="1.6" />
        </svg>
      )}
    </button>
  );
}
