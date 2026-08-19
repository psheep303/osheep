import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { ActivityBar, type ViewId } from "./ActivityBar";
import { ClaudeCodeAgentView, CodexAgentView } from "./AgentSettingsView";
import { AiPanel } from "./AiPanel";
import {
  type AgentSessionSummary,
  type GitChange,
  type GitStatus,
  getGitCommitDiff,
  getGitDiff,
  getGitStatus,
  getTemplateCapabilities,
} from "./api";
import { DesktopWindowControls } from "./DesktopWindowControls";
import { isWindowsDesktopShell } from "./desktop-folder-picker";
import type { EditorCursorStatus, GotoTarget } from "./EditorPane";
import {
  type FsNode,
  loadGlobalOsheepSettings,
  readFileText,
  saveGlobalOsheepSettings,
  writeFileText,
} from "./fs";
import { buildDecorations } from "./git-decorations";
import { useOsheepOverlay } from "./OsheepOverlay";
import { Resizer } from "./Resizer";
import { SettingsView } from "./SettingsView";
import { StatusBar } from "./StatusBar";
import { DEFAULT_SETTINGS, type OsheepSettings } from "./settings";
import type { AgentTerminalLaunchRequest } from "./Terminal";
import { WorkspacePicker } from "./WorkspacePicker";
import "./workbench.css";

const BottomPanel = lazy(() =>
  import("./BottomPanel").then((module) => ({ default: module.BottomPanel })),
);
const DiffPane = lazy(() => import("./DiffPane").then((module) => ({ default: module.DiffPane })));
const MultiDiffPane = lazy(() =>
  import("./MultiDiffPane").then((module) => ({ default: module.MultiDiffPane })),
);
const EditorPane = lazy(() =>
  import("./EditorPane").then((module) => ({ default: module.EditorPane })),
);
const FileTree = lazy(() => import("./FileTree").then((module) => ({ default: module.FileTree })));
const GitView = lazy(() => import("./GitView").then((module) => ({ default: module.GitView })));
const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })),
);
const SearchView = lazy(() =>
  import("./SearchView").then((module) => ({ default: module.SearchView })),
);
const TemplateDetail = lazy(() =>
  import("./TemplateView").then((module) => ({ default: module.TemplateDetail })),
);
const TemplateView = lazy(() =>
  import("./TemplateView").then((module) => ({ default: module.TemplateView })),
);
const WorkflowTab = lazy(() =>
  import("./WorkflowTab").then((module) => ({ default: module.WorkflowTab })),
);
const WorkflowRunDetailsPage = lazy(() =>
  import("./WorkflowTab").then((module) => ({ default: module.WorkflowRunDetailsPage })),
);

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

interface FileSaveSnapshot {
  path: string;
  content: string;
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

interface WorkflowDetailsTabState {
  kind: "workflow-details";
  path: string;
  workspaceId: string;
  workflowId: string;
  nodeId: string;
  title: string;
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

interface MultiDiffTab {
  kind: "multi-diff";
  path: string;
  title: string;
  entries: Array<{
    path: string;
    leftContent: string;
    rightContent: string;
    leftMissing: boolean;
    rightMissing: boolean;
    binary: boolean;
  }>;
}

type Tab =
  | FileTab
  | SettingsTab
  | WorkflowTabState
  | WorkflowDetailsTabState
  | TemplateTabState
  | DiffTab
  | MultiDiffTab;

const SETTINGS_PATH = "__settings__";
const WORKFLOW_PREFIX = "__workflow__:";
const workflowPath = (workflowId: string) => WORKFLOW_PREFIX + workflowId;
const WORKFLOW_DETAILS_PREFIX = "__workflow-details__:";
const workflowDetailsPath = (workflowId: string, nodeId: string) =>
  `${WORKFLOW_DETAILS_PREFIX}${encodeURIComponent(workflowId)}/${encodeURIComponent(nodeId)}`;
const TEMPLATE_PREFIX = "__template__:";
const templatePath = (source: "system" | "user", templateId: string) =>
  `${TEMPLATE_PREFIX}${source}:${templateId}`;

const DEFAULT_LEFT_WIDTH = 230;
const SIDE_THRESHOLD = 80;
const BOTTOM_THRESHOLD = 60;
const SIDE_MAX = 600;

export function Workbench() {
  const { t } = useUiPreferences();
  const { notify } = useOsheepOverlay();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [cursorStatus, setCursorStatus] = useState<EditorCursorStatus | null>(null);
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
  const lastGitStatusErrorRef = useRef<string | null>(null);
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
        if (!cancelled) {
          lastGitStatusErrorRef.current = null;
          setGitStatus(s);
        }
      })
      .catch((reason) => {
        if (!cancelled) {
          setGitStatus(null);
          const message = (reason as Error).message;
          if (activeView === "git" && lastGitStatusErrorRef.current !== message) {
            lastGitStatusErrorRef.current = message;
            notify.error(message);
          }
        }
      });
    return () => {
      cancelled = true;
    };
  }, [activeView, notify, workspaceId, statusVersion]);

  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  const [bottomHeight, setBottomHeight] = useState(0);
  // BottomPanel keeps mounting across collapse so terminals survive.
  // Toggling visibility or drag-collapse leaves this true; only an explicit
  // close (× in BottomPanel header) flips it back to false, which unmounts
  // the panel and kills its terminal sessions.
  const [bottomActivated, setBottomActivated] = useState(false);
  const [terminalLaunchRequest, setTerminalLaunchRequest] =
    useState<AgentTerminalLaunchRequest | null>(null);
  const [openTerminalSignal, setOpenTerminalSignal] = useState(0);

  const lastLeftWidthRef = useRef(DEFAULT_LEFT_WIDTH);
  const leftProgressRef = useRef(0);
  const bottomProgressRef = useRef(0);

  const leftCollapsed = leftWidth === 0;
  const bottomCollapsed = bottomHeight === 0;

  useEffect(() => {
    let cancelled = false;
    void loadGlobalOsheepSettings().then((s) => {
      if (!cancelled) setSettings(s);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = useCallback((next: OsheepSettings) => {
    setSettings(next);
    void saveGlobalOsheepSettings(next);
  }, []);

  const onChooseWorkspace = useCallback(
    (workspace: { id: string; name: string }) => {
      setError(null);
      setWorkspaceId(workspace.id);
      setWorkspaceName(workspace.name);
      setTabs([]);
      setActivePath(null);
      setSelectedTreePath(null);
      setPicking(false);
      if (leftWidth === 0) setLeftWidth(lastLeftWidthRef.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [leftWidth],
  );

  const openFile = useCallback(
    async (node: FsNode) => {
      if (node.kind !== "file" || !workspaceId) return;
      const existing = tabs.find((t) => t.kind === "file" && t.path === node.path);
      if (existing) {
        setActivePath(node.path);
        return;
      }
      let text: string;
      try {
        text = await readFileText(workspaceId, node.path);
      } catch (e) {
        setError(t("error.readFile", { detail: (e as Error).message }));
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
    [tabs, workspaceId, t],
  );

  const openFileAt = useCallback(
    async (filePath: string, line: number, column: number) => {
      if (!workspaceId) return;
      const target: GotoTarget = {
        line,
        column,
        nonce: Date.now() + Math.random(),
      };
      const existing = tabs.find((t) => t.kind === "file" && t.path === filePath);
      if (existing) {
        setTabs((prev) =>
          prev.map((t) => (t.kind === "file" && t.path === filePath ? { ...t, goto: target } : t)),
        );
        setActivePath(filePath);
        return;
      }
      let text: string;
      try {
        text = await readFileText(workspaceId, filePath);
      } catch (e) {
        setError(t("error.readFile", { detail: (e as Error).message }));
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
    [tabs, workspaceId, t],
  );

  const openDiffTab = useCallback(
    async (filePath: string, base: "HEAD" | "INDEX", head: "INDEX" | "WORKTREE") => {
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
        setError(t("error.loadDiff", { detail: (e as Error).message }));
      }
    },
    [tabs, workspaceId, t],
  );

  const openMultiDiffTab = useCallback(
    async (
      changes: GitChange[],
      base: "HEAD" | "INDEX",
      head: "INDEX" | "WORKTREE",
      title: string,
    ) => {
      if (!workspaceId || changes.length === 0) return;
      const paths = changes.map((change) => change.path);
      const diffId = `__multi-diff__:${base}:${head}:${paths
        .map((path) => encodeURIComponent(path))
        .join("|")}`;
      const existing = tabs.find((tab) => tab.path === diffId);
      if (existing) {
        setActivePath(diffId);
        return;
      }
      try {
        const entries = await Promise.all(
          changes.map(async (change) => {
            const diff = await getGitDiff(workspaceId, change.path, base, head);
            return {
              path: change.path,
              leftContent: diff.leftContent,
              rightContent: diff.rightContent,
              leftMissing: diff.leftMissing,
              rightMissing: diff.rightMissing,
              binary: diff.binary,
            };
          }),
        );
        setTabs((prev) => [...prev, { kind: "multi-diff", path: diffId, title, entries }]);
        setActivePath(diffId);
      } catch (e) {
        setError(t("error.loadDiff", { detail: (e as Error).message }));
      }
    },
    [tabs, workspaceId, t],
  );

  const openCommitDiffTab = useCallback(
    async (sha: string, title: string, paths: string[]) => {
      if (!workspaceId || paths.length === 0) return;
      const diffId = `__commit-diff__:${sha}:${paths
        .map((path) => encodeURIComponent(path))
        .join("|")}`;
      const existing = tabs.find((tab) => tab.path === diffId);
      if (existing) {
        setActivePath(diffId);
        return;
      }
      try {
        const entries = await Promise.all(
          paths.map(async (path) => {
            const diff = await getGitCommitDiff(workspaceId, sha, path);
            return {
              path: diff.path,
              leftContent: diff.leftContent,
              rightContent: diff.rightContent,
              leftMissing: diff.leftMissing,
              rightMissing: diff.rightMissing,
              binary: diff.binary,
            };
          }),
        );
        setTabs((prev) => [...prev, { kind: "multi-diff", path: diffId, title, entries }]);
        setActivePath(diffId);
      } catch (e) {
        setError(t("error.loadDiff", { detail: (e as Error).message }));
      }
    },
    [tabs, workspaceId, t],
  );

  const openPreparedMultiDiffTab = useCallback(
    (title: string, entries: MultiDiffTab["entries"]) => {
      if (entries.length === 0) return;
      const diffId = `__workflow-diff__:${entries
        .map((entry) => encodeURIComponent(entry.path))
        .join("|")}`;
      setTabs((current) => {
        const nextTab: MultiDiffTab = { kind: "multi-diff", path: diffId, title, entries };
        const existingIndex = current.findIndex((tab) => tab.path === diffId);
        if (existingIndex < 0) return [...current, nextTab];
        return current.map((tab, index) => (index === existingIndex ? nextTab : tab));
      });
      setActivePath(diffId);
    },
    [],
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

  const openWorkflowTab = useCallback(
    (workflowId: string, templateBinding?: WorkflowTabState["templateBinding"]) => {
      const path = workflowPath(workflowId);
      setTabs((prev) => {
        if (prev.some((t) => t.path === path)) {
          return templateBinding
            ? prev.map((tab) =>
                tab.path === path && tab.kind === "workflow" ? { ...tab, templateBinding } : tab,
              )
            : prev;
        }
        return [...prev, { kind: "workflow", path, workflowId, templateBinding }];
      });
      setActivePath(path);
    },
    [],
  );

  const openWorkflowDetailsTab = useCallback(
    (details: Omit<WorkflowDetailsTabState, "kind" | "path">) => {
      const path = workflowDetailsPath(details.workflowId, details.nodeId);
      setTabs((prev) => {
        const existing = prev.find((tab) => tab.path === path);
        if (existing) {
          return prev.map((tab) =>
            tab.path === path && tab.kind === "workflow-details"
              ? { ...tab, ...details }
              : tab,
          );
        }
        return [...prev, { kind: "workflow-details", path, ...details }];
      });
      setActivePath(path);
    },
    [],
  );

  const openTemplateTab = useCallback((source: "system" | "user", templateId: string) => {
    const path = templatePath(source, templateId);
    setTabs((prev) => {
      if (prev.some((tab) => tab.path === path)) return prev;
      return [...prev, { kind: "template", path, source, templateId }];
    });
    setActivePath(path);
  }, []);

  const onPathRenamed = useCallback(
    (oldPath: string, newPath: string) => {
      const matches = (p: string) => p === oldPath || p.startsWith(`${oldPath}/`);
      const remap = (p: string) => (p === oldPath ? newPath : newPath + p.slice(oldPath.length));
      setTabs((prev) =>
        prev.map((t) => (t.kind === "file" && matches(t.path) ? { ...t, path: remap(t.path) } : t)),
      );
      if (activePath && matches(activePath)) setActivePath(remap(activePath));
    },
    [activePath],
  );

  const onPathDeleted = useCallback(
    (path: string) => {
      const matches = (candidate: string) => candidate === path || candidate.startsWith(`${path}/`);
      const tabMatches = (tab: Tab) =>
        (tab.kind === "file" && matches(tab.path)) ||
        (tab.kind === "diff" && matches(tab.filePath));
      setTabs((prev) => {
        const firstRemovedIndex = prev.findIndex(tabMatches);
        const activeRemoved = prev.some((tab) => tab.path === activePath && tabMatches(tab));
        const next = prev.filter((tab) => !tabMatches(tab));
        if (activeRemoved) {
          const fallback =
            next[firstRemovedIndex] ?? next[firstRemovedIndex - 1] ?? next[next.length - 1] ?? null;
          setActivePath(fallback?.path ?? null);
        }
        return next;
      });
      setSelectedTreePath((selected) => (selected && matches(selected) ? null : selected));
    },
    [activePath],
  );

  const togglePreview = useCallback((path: string) => {
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "file" && t.path === path ? { ...t, previewMode: !t.previewMode } : t,
      ),
    );
  }, []);

  const updateActive = useCallback(
    (value: string) => {
      if (!activePath) return;
      setTabs((prev) =>
        prev.map((t) =>
          t.kind === "file" && t.path === activePath && !t.deleted
            ? { ...t, content: value, dirty: value !== t.savedContent }
            : t,
        ),
      );
    },
    [activePath],
  );

  const saveFiles = useCallback(
    async (files: FileSaveSnapshot[]) => {
      if (!workspaceId || files.length === 0) return;
      const results = await Promise.allSettled(
        files.map((file) => writeFileText(workspaceId, file.path, file.content)),
      );
      const saved = new Map(
        files
          .filter((_, index) => results[index].status === "fulfilled")
          .map((file) => [file.path, file.content]),
      );
      if (saved.size > 0) {
        setTabs((current) =>
          current.map((tab) => {
            if (tab.kind !== "file") return tab;
            const savedContent = saved.get(tab.path);
            return savedContent === undefined
              ? tab
              : { ...tab, savedContent, dirty: tab.content !== savedContent };
          }),
        );
        refreshGitStatus();
      }
      const failure = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected",
      );
      if (failure) {
        const detail =
          failure.reason instanceof Error ? failure.reason.message : String(failure.reason);
        setError(t("error.writeFile", { detail }));
      }
    },
    [refreshGitStatus, t, workspaceId],
  );

  const saveActive = useCallback(async () => {
    if (!activePath) return;
    const tab = tabs.find((candidate) => candidate.path === activePath);
    if (tab?.kind !== "file" || tab.deleted) return;
    await saveFiles([{ path: tab.path, content: tab.content }]);
  }, [activePath, saveFiles, tabs]);

  const saveAll = useCallback(async () => {
    const files = tabs
      .filter((tab): tab is FileTab => tab.kind === "file" && tab.dirty && !tab.deleted)
      .map(({ path, content }) => ({ path, content }));
    await saveFiles(files);
  }, [saveFiles, tabs]);

  useEffect(() => {
    if (!settings.editor.autoSave) return;
    const files = tabs
      .filter((tab): tab is FileTab => tab.kind === "file" && tab.dirty && !tab.deleted)
      .map(({ path, content }) => ({ path, content }));
    if (files.length === 0) return;
    const timer = window.setTimeout(() => void saveFiles(files), 750);
    return () => window.clearTimeout(timer);
  }, [saveFiles, settings.editor.autoSave, tabs]);

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        const next = prev.filter((t) => t.path !== path);
        if (activePath === path) {
          const fallback = next[idx] ?? next[idx - 1] ?? next[next.length - 1] ?? null;
          setActivePath(fallback ? fallback.path : null);
        }
        return next;
      });
    },
    [activePath],
  );

  const closeWorkflowArtifacts = useCallback(
    (workflowId: string) => {
      const matches = (tab: Tab) =>
        (tab.kind === "workflow" || tab.kind === "workflow-details") &&
        tab.workflowId === workflowId;
      setTabs((prev) => {
        const firstRemovedIndex = prev.findIndex(matches);
        const activeRemoved = prev.some((tab) => tab.path === activePath && matches(tab));
        const next = prev.filter((tab) => !matches(tab));
        if (activeRemoved) {
          const fallback =
            next[firstRemovedIndex] ?? next[firstRemovedIndex - 1] ?? next[next.length - 1] ?? null;
          setActivePath(fallback?.path ?? null);
        }
        return next;
      });
    },
    [activePath],
  );

  const closeTemplateArtifacts = useCallback(
    (source: "system" | "user", templateId: string) => {
      const matches = (tab: Tab) =>
        (tab.kind === "template" && tab.source === source && tab.templateId === templateId) ||
        (tab.kind === "workflow" &&
          tab.templateBinding?.source === source &&
          tab.templateBinding.id === templateId);
      setTabs((prev) => {
        const firstRemovedIndex = prev.findIndex(matches);
        const activeRemoved = prev.some((tab) => tab.path === activePath && matches(tab));
        const next = prev.filter((tab) => !matches(tab));
        if (activeRemoved) {
          const fallback =
            next[firstRemovedIndex] ?? next[firstRemovedIndex - 1] ?? next[next.length - 1] ?? null;
          setActivePath(fallback?.path ?? null);
        }
        return next;
      });
    },
    [activePath],
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

  const openGitView = useCallback(() => {
    setActiveView("git");
    if (leftCollapsed) setLeftWidth(lastLeftWidthRef.current);
  }, [leftCollapsed]);

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

  const openTerminal = useCallback(() => {
    setBottomActivated(true);
    setBottomHeight((height) => height || 300);
    setOpenTerminalSignal((signal) => signal + 1);
  }, []);

  const resumeAgentSession = useCallback(
    (session: Pick<AgentSessionSummary, "app" | "id" | "title">) => {
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
    },
    [workspaceId],
  );

  const handleTerminalLaunch = useCallback((key: number) => {
    setTerminalLaunchRequest((current) => (current?.key === key ? null : current));
  }, []);

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const activeFileTab = activeTab?.kind === "file" ? activeTab : null;
  const activeDiffTab = activeTab?.kind === "diff" ? activeTab : null;
  const activeMultiDiffTab = activeTab?.kind === "multi-diff" ? activeTab : null;
  const activeWorkflowDetailsTab =
    activeTab?.kind === "workflow-details" ? activeTab : null;
  const hasDirtyFiles = tabs.some((tab) => tab.kind === "file" && tab.dirty && !tab.deleted);
  const windowsDesktopShell = isWindowsDesktopShell();

  useEffect(() => {
    setCursorStatus(activeFileTab ? { line: 1, column: 1, selectedCharacters: 0 } : null);
  }, [activeFileTab?.path]);

  return (
    <div className="workbench">
      <div
        className={`titlebar${windowsDesktopShell ? " titlebar--desktop" : ""}`}
        data-tauri-drag-region={windowsDesktopShell ? true : undefined}
      >
        <img className="titlebar__logo" src="/osheep-icon.png" alt="" draggable={false} />
        <span className="titlebar__brand">Osheep</span>
        {developerMode && <span className="titlebar__dev-badge">DEVELOPER</span>}
        <span className="titlebar__sep">·</span>
        <button
          className="titlebar__project-btn"
          onClick={() => setPicking(true)}
          title={t(workspaceId ? "workspace.switch" : "workspace.select")}
        >
          {workspaceName ?? t("workspace.select")}
        </button>
        <button className="tb-btn" onClick={() => void saveAll()} disabled={!hasDirtyFiles}>
          {t("workspace.saveAll")}
        </button>
        <button
          type="button"
          className="tb-btn tb-btn--icon"
          onClick={openTerminal}
          title={t("terminal.open")}
          aria-label={t("terminal.open")}
        >
          <i className="codicon codicon-terminal" aria-hidden="true" />
        </button>
        <span className="titlebar__drag-region" data-tauri-drag-region />
        {windowsDesktopShell && <DesktopWindowControls />}
      </div>

      {error && (
        <div className="banner-error">
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

      <div className="body">
        <ActivityBar
          activeView={activeView}
          collapsed={leftCollapsed}
          onSelect={onSelectView}
          onOpenSettings={openSettingsTab}
        />

        {!leftCollapsed && (
          <div className="side" style={{ width: leftWidth }}>
            <Suspense fallback={<div className="tab-loading-fallback" />}>
              {activeView === "workflow" && (
                <AiPanel
                  workspaceId={workspaceId}
                  onOpenWorkflow={openWorkflowTab}
                  activeWorkflowId={activeTab?.kind === "workflow" ? activeTab.workflowId : null}
                  refreshSignal={aiRefreshSignal}
                  onWorkflowDeleted={closeWorkflowArtifacts}
                  developerMode={developerMode}
                  onTemplatesChanged={() => setTemplateRefreshSignal((signal) => signal + 1)}
                />
              )}
              {activeView === "template" && (
                <TemplateView
                  activeTemplateId={activeTab?.kind === "template" ? activeTab.templateId : null}
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
                      <span className="side-view__title">{t("nav.explorer")}</span>
                    </div>
                    <div className="side-view__body side-view__body--padded">
                      <div className="muted">{t("workspace.explorerHint")}</div>
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
                  onOpenMultiDiff={(changes, base, head, title) =>
                    void openMultiDiffTab(changes, base, head, title)
                  }
                  onOpenFile={(p) => void openFileAt(p, 1, 1)}
                  onOpenCommitDiff={(sha, title, paths) =>
                    void openCommitDiffTab(sha, title, paths)
                  }
                />
              )}
              {activeView === "claude-code" && (
                <ClaudeCodeAgentView
                  workspaceId={workspaceId}
                  onResumeSession={resumeAgentSession}
                />
              )}
              {activeView === "codex" && (
                <CodexAgentView workspaceId={workspaceId} onResumeSession={resumeAgentSession} />
              )}
            </Suspense>
          </div>
        )}
        <Resizer axis="x" onResizeStart={onLeftStart} onResize={onLeftResize} />

        <div className="workbench-main">
          <div className="editor-area">
            <div className="tabs">
              <div className="tabs__list">
                {tabs.map((tab) => {
                  const isDeleted = tab.kind === "file" && tab.deleted;
                  const label =
                    tab.kind === "settings"
                      ? t("common.settings")
                      : tab.kind === "workflow"
                        ? t("nav.workflow")
                        : tab.kind === "workflow-details"
                          ? tab.title
                        : tab.kind === "template"
                          ? t("nav.templates")
                          : tab.kind === "multi-diff"
                            ? tab.title
                            : tab.kind === "diff"
                              ? `${basename(tab.filePath)} (${diffLabel(tab)})`
                              : tab.path.split("/").pop();
                  const tabTitle =
                    tab.kind === "file"
                      ? isDeleted
                        ? `${tab.path}${t("editor.deleted")}`
                        : tab.path
                      : tab.kind === "diff"
                        ? `${tab.filePath} · ${diffLabel(tab)}`
                        : tab.kind === "multi-diff"
                          ? tab.title
                          : tab.kind === "workflow"
                            ? `${t("nav.workflow")} ${tab.workflowId}`
                            : tab.kind === "workflow-details"
                              ? `${tab.title} - ${t("workflow.details.title")}`
                            : tab.kind === "template"
                              ? `${t("nav.templates")} ${tab.templateId}`
                              : t("common.settings");
                  return (
                    <div
                      key={tab.path}
                      className={
                        "tab" +
                        (tab.path === activePath ? " is-active" : "") +
                        (isDeleted ? " is-deleted" : "") +
                        (tab.kind === "diff" || tab.kind === "multi-diff" ? " is-diff" : "")
                      }
                      onClick={() => setActivePath(tab.path)}
                      title={tabTitle}
                    >
                      <span className="tab__name">
                        {label}
                        {tab.kind === "file" && tab.dirty ? " *" : ""}
                      </span>
                      <span
                        className="tab__close"
                        onClick={(e) => {
                          e.stopPropagation();
                          closeTab(tab.path);
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
              <Suspense fallback={<div className="tab-loading-fallback" />}>
                {activeFileTab ? (
                  isMarkdownPath(activeFileTab.path) && activeFileTab.previewMode ? (
                    <div className="editor-host__preview">
                      <MarkdownPreview source={activeFileTab.content} />
                    </div>
                  ) : (
                    <div className="editor-host__source">
                      <EditorPane
                        key={activeFileTab.path}
                        path={activeFileTab.path}
                        value={activeFileTab.content}
                        fontSize={settings.editor.fontSize}
                        tabSize={settings.editor.tabSize}
                        onChange={updateActive}
                        onSave={saveActive}
                        goto={activeFileTab.goto ?? null}
                        onCursorStatus={setCursorStatus}
                      />
                    </div>
                  )
                ) : activeDiffTab ? (
                  <div className="editor-host__source">
                    {activeDiffTab.binary ? (
                      <div className="empty-hint">{t("editor.binaryDiff")}</div>
                    ) : (
                      <DiffPane
                        path={activeDiffTab.filePath}
                        fontSize={settings.editor.fontSize}
                        leftContent={activeDiffTab.leftContent}
                        rightContent={activeDiffTab.rightContent}
                      />
                    )}
                  </div>
                ) : activeMultiDiffTab ? (
                  <div className="editor-host__source">
                    <MultiDiffPane
                      entries={activeMultiDiffTab.entries}
                      fontSize={settings.editor.fontSize}
                      title={activeMultiDiffTab.title}
                    />
                  </div>
                ) : activeWorkflowDetailsTab ? (
                  <WorkflowRunDetailsPage
                    workspaceId={activeWorkflowDetailsTab.workspaceId}
                    workflowId={activeWorkflowDetailsTab.workflowId}
                    nodeId={activeWorkflowDetailsTab.nodeId}
                    onClose={() => closeTab(activeWorkflowDetailsTab.path)}
                    onResumeSession={resumeAgentSession}
                  />
                ) : activeTab?.kind === "settings" ? (
                  <SettingsView settings={settings} onChange={updateSettings} />
                ) : activeTab?.kind === "workflow" ? (
                  workspaceId ? (
                    <WorkflowTab
                      workspaceId={workspaceId}
                      workflowId={activeTab.workflowId}
                      editorFontSize={settings.editor.fontSize}
                      editorTabSize={settings.editor.tabSize}
                      onOpenDiff={openPreparedMultiDiffTab}
                      onWorkflowChanged={bumpAiRefresh}
                      onFilesChanged={bumpFileTree}
                      onResumeSession={resumeAgentSession}
                      onOpenDetails={openWorkflowDetailsTab}
                      onTemplateBinding={(templateBinding) =>
                        setTabs((current) =>
                          current.map((tab) =>
                            tab.kind === "workflow" && tab.workflowId === activeTab.workflowId
                              ? { ...tab, templateBinding }
                              : tab,
                          ),
                        )
                      }
                    />
                  ) : (
                    <div className="empty-hint">{t("workspace.openFirst")}</div>
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
                    onTemplateChanged={() => setTemplateRefreshSignal((signal) => signal + 1)}
                  />
                ) : (
                  <div className="empty-hint">{t("editor.selectFile")}</div>
                )}
              </Suspense>
            </div>
          </div>

          <Resizer axis="y" onResizeStart={onBottomStart} onResize={onBottomResize} />
          {bottomActivated && (
            <div
              className={`bottom${bottomCollapsed ? " is-hidden" : ""}`}
              style={{
                height: bottomCollapsed ? 0 : bottomHeight,
              }}
            >
              <Suspense fallback={<div className="tab-loading-fallback" />}>
                <BottomPanel
                  workspaceId={workspaceId}
                  docsRefreshSignal={fileTreeVersion}
                  onClose={hardCloseBottom}
                  terminalLaunchRequest={terminalLaunchRequest}
                  onTerminalLaunchHandled={handleTerminalLaunch}
                  openTerminalSignal={openTerminalSignal}
                />
              </Suspense>
            </div>
          )}
        </div>
      </div>

      <StatusBar
        status={gitStatus}
        activeFilePath={activeFileTab?.path ?? null}
        cursor={cursorStatus}
        onOpenGit={openGitView}
      />

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
  return lower.endsWith(".md") || lower.endsWith(".markdown") || lower.endsWith(".mdx");
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

function PreviewToggle({ previewMode, onToggle }: { previewMode: boolean; onToggle: () => void }) {
  const { t } = useUiPreferences();
  return (
    <button
      className="preview-toggle"
      title={t(previewMode ? "editor.preview.source" : "editor.preview.open")}
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
