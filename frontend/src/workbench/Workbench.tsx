import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ActivityBar, type ViewId } from "./ActivityBar";
import { ClaudeCodeAgentView, CodexAgentView } from "./AgentSettingsView";
import { AiPanel } from "./AiPanel";
import { BottomPanel } from "./BottomPanel";
import { DiffPane } from "./DiffPane";
import { EditorPane, type GotoTarget } from "./EditorPane";
import { FileTree } from "./FileTree";
import { GitView } from "./GitView";
import { MarkdownPreview } from "./MarkdownPreview";
import { Resizer } from "./Resizer";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";
import { WorkflowTab } from "./WorkflowTab";
import { TemplateDetail, TemplateView } from "./TemplateView";
import { WorkspacePicker } from "./WorkspacePicker";
import { DEFAULT_SETTINGS, type OsheepSettings } from "./settings";
import {
  type FsNode,
  loadOsheepSettings,
  readFileText,
  saveOsheepSettings,
  writeFileText,
} from "./fs";
import {
  getGitDiff,
  getGitStatus,
  getTemplateCapabilities,
  type AgentSessionSummary,
  type GitStatus,
} from "./api";
import type { AgentTerminalLaunchRequest } from "./Terminal";
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

interface WorkflowTabState {
  kind: "workflow";
  path: string; // __workflow__:<workflowId>
  workflowId: string;
  templateBinding?: {
    source: "system" | "user";
    id: string;
  };
}

interface TemplateTabState {
  kind: "template";
  path: string;
  templateId: string;
  source: "system" | "user";
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

type Tab = FileTab | SettingsTab | WorkflowTabState | TemplateTabState | DiffTab;

const SETTINGS_PATH = "__settings__";
const WORKFLOW_PREFIX = "__workflow__:";
const workflowPath = (workflowId: string) => WORKFLOW_PREFIX + workflowId;
const TEMPLATE_PREFIX = "__template__:";
const templatePath = (source: "system" | "user", templateId: string) =>
  `${TEMPLATE_PREFIX}${source}:${templateId}`;

const DEFAULT_LEFT_WIDTH = 230;
const SIDE_THRESHOLD = 80;
const BOTTOM_THRESHOLD = 60;
const SIDE_MAX = 600;

export function Workbench() {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<OsheepSettings>(DEFAULT_SETTINGS);

  const [activeView, setActiveView] = useState<ViewId>("workflow");
  const [developerMode, setDeveloperMode] = useState(false);
  const [templateRefreshSignal, setTemplateRefreshSignal] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void getTemplateCapabilities()
      .then((capabilities) => {
        if (!cancelled) setDeveloperMode(capabilities.developerMode);
      })
      .catch(() => {
        if (!cancelled) setDeveloperMode(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [gitStatus, setGitStatus] = useState<GitStatus | null>(null);
  const decorations = useMemo(() => buildDecorations(gitStatus), [gitStatus]);
  const [statusVersion, setStatusVersion] = useState(0);
  const refreshGitStatus = useCallback(() => {
    setStatusVersion((v) => v + 1);
  }, []);

  // Bumped to force the file explorer (FileTree) to reload its tree. Driven by
  // osheep code file mutations so the explorer refreshes without a manual
  // click; also refreshes git decorations.
  const [fileTreeVersion, setFileTreeVersion] = useState(0);
  const bumpFileTree = useCallback(() => {
    setFileTreeVersion((v) => v + 1);
    refreshGitStatus();
  }, [refreshGitStatus]);

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
  const [bottomHeight, setBottomHeight] = useState(0);
  // BottomPanel keeps mounting across collapse so terminals survive.
  // Toggling visibility or drag-collapse leaves this true; only an explicit
  // close (× in BottomPanel header) flips it back to false, which unmounts
  // the panel and kills its terminal sessions.
  const [bottomActivated, setBottomActivated] = useState(false);
  const [terminalLaunchRequest, setTerminalLaunchRequest] =
    useState<AgentTerminalLaunchRequest | null>(null);

  const lastLeftWidthRef = useRef(DEFAULT_LEFT_WIDTH);
  const leftProgressRef = useRef(0);
  const bottomProgressRef = useRef(0);

  const leftCollapsed = leftWidth === 0;
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

  const onChooseWorkspace = useCallback((workspace: { id: string; name: string }) => {
    setError(null);
    setWorkspaceId(workspace.id);
    setWorkspaceName(workspace.name);
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

  const [aiRefreshSignal, setAiRefreshSignal] = useState(0);
  const bumpAiRefresh = useCallback(() => {
    setAiRefreshSignal((v) => v + 1);
  }, []);

  const openWorkflowTab = useCallback((
    workflowId: string,
    templateBinding?: WorkflowTabState["templateBinding"]
  ) => {
    const path = workflowPath(workflowId);
    setTabs((prev) => {
      if (prev.some((t) => t.path === path)) {
        return templateBinding
          ? prev.map((tab) =>
              tab.path === path && tab.kind === "workflow"
                ? { ...tab, templateBinding }
                : tab
            )
          : prev;
      }
      return [...prev, { kind: "workflow", path, workflowId, templateBinding }];
    });
    setActivePath(path);
  }, []);

  const openTemplateTab = useCallback(
    (source: "system" | "user", templateId: string) => {
      const path = templatePath(source, templateId);
      setTabs((prev) => {
        if (prev.some((tab) => tab.path === path)) return prev;
        return [...prev, { kind: "template", path, source, templateId }];
      });
      setActivePath(path);
    },
    []
  );

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

  const onPathDeleted = useCallback(
    (path: string) => {
      const matches = (candidate: string) =>
        candidate === path || candidate.startsWith(path + "/");
      const tabMatches = (tab: Tab) =>
        (tab.kind === "file" && matches(tab.path)) ||
        (tab.kind === "diff" && matches(tab.filePath));
      setTabs((prev) => {
        const firstRemovedIndex = prev.findIndex(tabMatches);
        const activeRemoved = prev.some(
          (tab) => tab.path === activePath && tabMatches(tab)
        );
        const next = prev.filter((tab) => !tabMatches(tab));
        if (activeRemoved) {
          const fallback =
            next[firstRemovedIndex] ??
            next[firstRemovedIndex - 1] ??
            next[next.length - 1] ??
            null;
          setActivePath(fallback?.path ?? null);
        }
        return next;
      });
      setSelectedTreePath((selected) =>
        selected && matches(selected) ? null : selected
      );
    },
    [activePath]
  );

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

  const closeTemplateArtifacts = useCallback(
    (source: "system" | "user", templateId: string) => {
      const matches = (tab: Tab) =>
        (tab.kind === "template" &&
          tab.source === source &&
          tab.templateId === templateId) ||
        (tab.kind === "workflow" &&
          tab.templateBinding?.source === source &&
          tab.templateBinding.id === templateId);
      setTabs((prev) => {
        const firstRemovedIndex = prev.findIndex(matches);
        const activeRemoved = prev.some(
          (tab) => tab.path === activePath && matches(tab)
        );
        const next = prev.filter((tab) => !matches(tab));
        if (activeRemoved) {
          const fallback =
            next[firstRemovedIndex] ??
            next[firstRemovedIndex - 1] ??
            next[next.length - 1] ??
            null;
          setActivePath(fallback?.path ?? null);
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
      // Drag-expanding from a hidden state re-activates the panel
      setBottomActivated(true);
    }
  }, []);

  // Hard close: invoked by the × button inside the BottomPanel header.
  // Unmounts the panel, which tears down its terminal sessions.
  const hardCloseBottom = () => {
    setBottomActivated(false);
    setBottomHeight(0);
    setTerminalLaunchRequest(null);
  };

  const resumeAgentSession = useCallback((session: Pick<AgentSessionSummary, "app" | "id" | "title">) => {
    if (!workspaceId) return;
    setTerminalLaunchRequest({
      key: Date.now() + Math.random(),
      app: session.app,
      sessionId: session.id,
      title: session.title,
      workspaceId,
    });
    setBottomActivated(true);
    setBottomHeight((height) => height || 300);
  }, [workspaceId]);

  const handleTerminalLaunch = useCallback((key: number) => {
    setTerminalLaunchRequest((current) =>
      current?.key === key ? null : current
    );
  }, []);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const activeFileTab = activeTab?.kind === "file" ? activeTab : null;
  const activeDiffTab = activeTab?.kind === "diff" ? activeTab : null;

  return (
    <div className="workbench">
      <div className="titlebar">
        <span className="titlebar__brand">osheep</span>
        {developerMode && <span className="titlebar__dev-badge">DEVELOPER</span>}
        <span className="titlebar__sep">·</span>
        <button
          className="titlebar__project-btn"
          onClick={() => setPicking(true)}
          title={workspaceId ? "切换工作区" : "选择工作区"}
        >
          {workspaceName ?? "选择工作区"}
        </button>
        <div className="titlebar__actions">
          <button
            className="tb-btn"
            onClick={saveActive}
            disabled={!activeFileTab?.dirty || activeFileTab?.deleted}
          >
            保存
          </button>
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
        />

        {!leftCollapsed && (
          <div className="side" style={{ width: leftWidth }}>
            {activeView === "workflow" && (
              <AiPanel
                workspaceId={workspaceId}
                onOpenWorkflow={openWorkflowTab}
                activeWorkflowId={
                  activeTab?.kind === "workflow" ? activeTab.workflowId : null
                }
                refreshSignal={aiRefreshSignal}
                onWorkflowDeleted={(workflowId) =>
                  closeTab(workflowPath(workflowId))
                }
                developerMode={developerMode}
                onTemplatesChanged={() =>
                  setTemplateRefreshSignal((signal) => signal + 1)
                }
              />
            )}
            {activeView === "template" && (
              <TemplateView
                activeTemplateId={
                  activeTab?.kind === "template" ? activeTab.templateId : null
                }
                onOpenTemplate={openTemplateTab}
                onTemplateDeleted={(source, templateId) =>
                  closeTemplateArtifacts(source, templateId)
                }
                developerMode={developerMode}
                refreshSignal={templateRefreshSignal}
              />
            )}
            {activeView === "explorer" &&
              (workspaceId ? (
                <FileTree
                  workspaceId={workspaceId}
                  workspaceName={workspaceName ?? workspaceId}
                  selectedPath={selectedTreePath}
                  onSelect={setSelectedTreePath}
                  onOpenFile={openFile}
                  onPathRenamed={onPathRenamed}
                  onPathDeleted={onPathDeleted}
                  decorations={decorations}
                  onFsChange={refreshGitStatus}
                  refreshSignal={fileTreeVersion}
                />
              ) : (
                <div className="side-view">
                  <div className="side-view__header">
                    <span className="side-view__title">资源管理器</span>
                  </div>
                  <div className="side-view__body side-view__body--padded">
                    <div className="muted">
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
            {activeView === "claude-code" && (
              <ClaudeCodeAgentView
                workspaceId={workspaceId}
                onResumeSession={resumeAgentSession}
              />
            )}
            {activeView === "codex" && (
              <CodexAgentView
                workspaceId={workspaceId}
                onResumeSession={resumeAgentSession}
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
                      : t.kind === "workflow"
                      ? "Workflow"
                      : t.kind === "template"
                      ? "Template"
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
                      : t.kind === "workflow"
                      ? `Workflow ${t.workflowId}`
                      : t.kind === "template"
                      ? `Template ${t.templateId}`
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
                />
              ) : activeTab?.kind === "workflow" ? (
                workspaceId ? (
                  <WorkflowTab
                    workspaceId={workspaceId}
                    workflowId={activeTab.workflowId}
                    onWorkflowChanged={bumpAiRefresh}
                    onFilesChanged={bumpFileTree}
                    onResumeSession={resumeAgentSession}
                    onTemplateBinding={(templateBinding) =>
                      setTabs((current) =>
                        current.map((tab) =>
                          tab.kind === "workflow" &&
                          tab.workflowId === activeTab.workflowId
                            ? { ...tab, templateBinding }
                            : tab
                        )
                      )
                    }
                  />
                ) : (
                  <div className="empty-hint">请先打开工作区</div>
                )
              ) : activeTab?.kind === "template" ? (
                <TemplateDetail
                  workspaceId={workspaceId}
                  source={activeTab.source}
                  templateId={activeTab.templateId}
                  onOpenWorkflow={(workflowId, templateBinding) => {
                    openWorkflowTab(workflowId, templateBinding);
                    setActiveView("workflow");
                  }}
                  onWorkflowCreated={bumpAiRefresh}
                  developerMode={developerMode}
                  onTemplateChanged={() =>
                    setTemplateRefreshSignal((signal) => signal + 1)
                  }
                />
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
                terminalLaunchRequest={terminalLaunchRequest}
                onTerminalLaunchHandled={handleTerminalLaunch}
              />
            </div>
          )}
        </div>

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
