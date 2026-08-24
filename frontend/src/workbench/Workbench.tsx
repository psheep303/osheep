import {
  lazy,
  Suspense,
  type DragEvent,
  type PointerEvent as ReactPointerEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
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
  getWorkflow,
  getTemplateCapabilities,
  getWorkspace,
  readExternalFile,
  resolveExternalFilePath,
  workspaceImageUrl,
} from "./api";
import { DesktopWindowControls } from "./DesktopWindowControls";
import { isWindowsDesktopShell } from "./desktop-folder-picker";
import type { EditorCursorStatus, GotoTarget } from "./EditorPane";
import { FileIcon } from "./FileIcon";
import {
  FILE_TREE_DRAG_MIME,
  hasFileTreeDrag,
  readFileTreeDragFiles,
  readFileTreeDragPaths,
} from "./file-tree-dnd";
import { elementsAtDesktopDropPosition, listenDesktopFileDrop } from "./desktop-dnd";
import {
  type FsNode,
  loadGlobalOsheepSettings,
  readFileText,
  findFreeImageName,
  saveGlobalOsheepSettings,
  writeFileBase64,
  writeFileText,
} from "./fs";
import { buildDecorations } from "./git-decorations";
import { useOsheepOverlay } from "./OsheepOverlay";
import { Resizer } from "./Resizer";
import { SettingsView } from "./SettingsView";
import { StatusBar } from "./StatusBar";
import { playWorkflowAlertSound } from "./workflow-alert-sound";
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
  image?: boolean;
  externalName?: string;
  imageDataUrl?: string;
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
  title?: string;
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
const TAB_DRAG_MIME = "application/x-osheep-tab-path";

const DEFAULT_LEFT_WIDTH = 250;
const SIDE_THRESHOLD = 80;
const BOTTOM_THRESHOLD = 60;
const SIDE_MAX = 600;
const SIDEBAR_WIDTH_STORAGE_KEY = "osheep.sidebarWidth.v1";

function readLegacySidebarWidth(): number | null {
  try {
    const raw = window.localStorage.getItem(SIDEBAR_WIDTH_STORAGE_KEY);
    const value = raw ? Number(raw) : NaN;
    return Number.isFinite(value) && value >= 180 && value <= SIDE_MAX ? Math.round(value) : null;
  } catch {
    return null;
  }
}

export function Workbench() {
  const { t } = useUiPreferences();
  const { notify } = useOsheepOverlay();
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [workspaceName, setWorkspaceName] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const tabsListRef = useRef<HTMLDivElement>(null);
  const tabScrollDragRef = useRef<{
    startX: number;
    startScrollLeft: number;
    travel: number;
    maxScroll: number;
  } | null>(null);
  const [tabScroll, setTabScroll] = useState({ thumbPercent: 100, offsetPercent: 0 });
  const [cursorStatus, setCursorStatus] = useState<EditorCursorStatus | null>(null);
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [settings, setSettings] = useState<OsheepSettings>(DEFAULT_SETTINGS);
  const settingsLoadedRef = useRef(false);

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

  const lastLeftWidthRef = useRef(leftWidth);
  const leftProgressRef = useRef(0);
  const bottomProgressRef = useRef(0);

  const leftCollapsed = leftWidth === 0;
  const bottomCollapsed = bottomHeight === 0;

  useEffect(() => {
    let cancelled = false;
    void loadGlobalOsheepSettings().then(async (s) => {
      if (!cancelled) {
        const legacyWidth = readLegacySidebarWidth();
        const width = legacyWidth ?? s.layout.sidebarWidth;
        const migrated =
          legacyWidth === null ? s : { ...s, layout: { ...s.layout, sidebarWidth: legacyWidth } };
        setSettings(migrated);
        setLeftWidth(width);
        lastLeftWidthRef.current = width;
        settingsLoadedRef.current = true;
        if (legacyWidth !== null) {
          try {
            await saveGlobalOsheepSettings(migrated);
            window.localStorage.removeItem(SIDEBAR_WIDTH_STORAGE_KEY);
          } catch {
            // Retry migration on the next launch when the backend is unavailable.
          }
        }
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  const updateSettings = useCallback((next: OsheepSettings) => {
    setSettings(next);
    void saveGlobalOsheepSettings(next);
  }, []);

  useEffect(() => {
    if (!settingsLoadedRef.current || leftWidth <= 0) return;
    const width = Math.max(180, Math.min(SIDE_MAX, Math.round(leftWidth)));
    if (settings.layout.sidebarWidth === width) return;
    const next = { ...settings, layout: { ...settings.layout, sidebarWidth: width } };
    setSettings(next);
    const timer = window.setTimeout(() => void saveGlobalOsheepSettings(next), 250);
    return () => window.clearTimeout(timer);
  }, [leftWidth, settings]);

  // Keep waiting-for-choice notifications alive even when the workflow tab is
  // no longer the active tab (inactive tabs are intentionally unmounted).
  const waitingNotificationKeysRef = useRef(new Set<string>());
  const waitingSoundKnownWorkflowsRef = useRef(new Set<string>());
  const workflowSoundKeysRef = useRef(new Set<string>());
  useEffect(() => {
    if (!workspaceId) return;
    const workflowIds = tabs
      .filter((tab): tab is WorkflowTabState => tab.kind === "workflow")
      .map((tab) => tab.workflowId);
    if (workflowIds.length === 0) return;
    let cancelled = false;
    const check = async () => {
      const observedWaitingKeys = new Set<string>();
      const observedSoundKeys = new Set<string>();
      await Promise.all(
        workflowIds.map(async (workflowId) => {
          try {
            const workflow = await getWorkflow(workspaceId, workflowId);
            const workflowKey = `${workspaceId}:${workflowId}`;
            const firstObservation = !waitingSoundKnownWorkflowsRef.current.has(workflowKey);
            waitingSoundKnownWorkflowsRef.current.add(workflowKey);
            const sounds = workflow.settings?.sounds;
            for (const node of workflow.nodes) {
              const details = node.config?.runDetails;
              const terminalStatus =
                details && typeof details === "object"
                  ? (details as { terminalStatus?: unknown }).terminalStatus
                  : undefined;
              const waiting =
                node.status === "running" &&
                (terminalStatus === "waiting-for-choice" ||
                  node.config?.waitingForChoice === true ||
                  (node.kind === "diff-approval" && node.config?.waitingForApproval === true) ||
                  (node.kind === "markdown" &&
                    (node.config?.waitingForApproval === true ||
                      node.config?.waitingForInput === true)));
              const key = `${workflowKey}:${node.id}:${node.completedAt ?? node.startedAt ?? 0}`;
              if (waiting) observedWaitingKeys.add(key);
              if (waiting && !waitingNotificationKeysRef.current.has(key)) {
                waitingNotificationKeysRef.current.add(key);
                if (!firstObservation && sounds?.waitingForChoice !== false) {
                  playWorkflowAlertSound("waiting");
                }
                notify.warning(t("notification.waitingForChoice", { name: node.title }), {
                  title: t("workflow.details.waitingForChoice"),
                });
              }
              if ((node.status === "success" || node.status === "error") && node.completedAt) {
                const soundKey = `${workflowKey}:node:${node.id}:${node.status}:${node.completedAt}`;
                observedSoundKeys.add(soundKey);
                if (!firstObservation && !workflowSoundKeysRef.current.has(soundKey)) {
                  if (node.status === "success" && sounds?.nodeSuccess === true) {
                    playWorkflowAlertSound("node-success");
                  } else if (node.status === "error" && sounds?.nodeError === true) {
                    playWorkflowAlertSound("node-error");
                  }
                }
              }
            }
            for (const run of workflow.runs) {
              if (run.status === "running" || run.status === "idle" || !run.completedAt) continue;
              const soundKey = `${workflowKey}:run:${run.id}:${run.status}:${run.completedAt}`;
              observedSoundKeys.add(soundKey);
              if (
                !firstObservation &&
                !workflowSoundKeysRef.current.has(soundKey) &&
                sounds?.runCompleted === true
              ) {
                playWorkflowAlertSound("run-completed");
              }
            }
          } catch {
            // The active workflow tab owns its detailed error handling.
          }
        }),
      );
      if (!cancelled) {
        waitingNotificationKeysRef.current = observedWaitingKeys;
        workflowSoundKeysRef.current = observedSoundKeys;
      }
    };
    void check();
    const timer = window.setInterval(() => void check(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [notify, tabs, t, workspaceId]);

  const onChooseWorkspace = useCallback(
    async (workspace: { id: string; name: string }) => {
      let openedWorkspace: { id: string; name: string };
      try {
        openedWorkspace = await getWorkspace(workspace.id);
      } catch (reason) {
        notify.error((reason as Error).message);
        return;
      }
      setWorkspaceId(openedWorkspace.id);
      setWorkspaceName(openedWorkspace.name);
      setTabs([]);
      setActivePath(null);
      setSelectedTreePath(null);
      setPicking(false);
      if (leftWidth === 0) setLeftWidth(lastLeftWidthRef.current);
      // eslint-disable-next-line react-hooks/exhaustive-deps
    },
    [leftWidth, notify],
  );

  const openFilePath = useCallback(
    async (filePath: string, goto?: GotoTarget, insertionIndex?: number) => {
      if (!workspaceId) return;
      const existing = tabs.find((tab) => tab.kind === "file" && tab.path === filePath);
      if (existing) {
        if (goto) {
          setTabs((prev) =>
            prev.map((tab) =>
              tab.kind === "file" && tab.path === filePath ? { ...tab, goto } : tab,
            ),
          );
        }
        setActivePath(filePath);
        return;
      }
      let nextTab: FileTab;
      if (isImagePath(filePath)) {
        nextTab = {
          kind: "file",
          path: filePath,
          content: "",
          savedContent: "",
          dirty: false,
          deleted: false,
          previewMode: true,
          image: true,
          goto,
        };
      } else {
        let text: string;
        try {
          text = await readFileText(workspaceId, filePath);
        } catch (e) {
          notify.error(t("error.readFile", { detail: (e as Error).message }));
          return;
        }
        nextTab = {
          kind: "file",
          path: filePath,
          content: text,
          savedContent: text,
          dirty: false,
          deleted: false,
          previewMode: false,
          goto,
        };
      }
      setTabs((prev) => {
        if (prev.some((tab) => tab.path === filePath)) return prev;
        if (insertionIndex === undefined) return [...prev, nextTab];
        const next = [...prev];
        next.splice(Math.max(0, Math.min(insertionIndex, next.length)), 0, nextTab);
        return next;
      });
      setActivePath(filePath);
    },
    [notify, tabs, workspaceId, t],
  );

  const openFile = useCallback(
    (node: FsNode) => {
      if (node.kind === "file") void openFilePath(node.path);
    },
    [openFilePath],
  );

  const pasteImageIntoMarkdown = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        const current = tabs.find((tab) => tab.kind === "file" && tab.path === activePath);
        if (!workspaceId || current?.kind !== "file" || !isMarkdownPath(current.path)) return null;
        const slash = current.path.lastIndexOf("/");
        const dir = slash >= 0 ? current.path.slice(0, slash) : "";
        const extension = imageExtension(file.type);
        const name = await findFreeImageName(workspaceId, dir, extension);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await writeFileBase64(workspaceId, dir ? `${dir}/${name}` : name, btoa(binary));
        bumpFileTree();
        return `\n\n![alt text](${name})`;
      } catch (reason) {
        notify.error(t("error.writeFile", { detail: (reason as Error).message }));
        return null;
      }
    },
    [activePath, bumpFileTree, notify, t, tabs, workspaceId],
  );

  const openFileAt = useCallback(
    (filePath: string, line: number, column: number) => {
      const target: GotoTarget = {
        line,
        column,
        nonce: Date.now() + Math.random(),
      };
      void openFilePath(filePath, target);
    },
    [openFilePath],
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
        notify.error(t("error.loadDiff", { detail: (e as Error).message }));
      }
    },
    [notify, tabs, workspaceId, t],
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
        notify.error(t("error.loadDiff", { detail: (e as Error).message }));
      }
    },
    [notify, tabs, workspaceId, t],
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
        notify.error(t("error.loadDiff", { detail: (e as Error).message }));
      }
    },
    [notify, tabs, workspaceId, t],
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
  const [workflowTitleUpdate, setWorkflowTitleUpdate] = useState<{
    workflowId: string;
    title: string;
    revision: number;
  } | null>(null);
  const bumpAiRefresh = useCallback(() => {
    setAiRefreshSignal((v) => v + 1);
  }, []);
  const handleWorkflowRenamed = useCallback((workflowId: string, title: string) => {
    setWorkflowTitleUpdate((current) => ({
      workflowId,
      title,
      revision: (current?.revision ?? 0) + 1,
    }));
    setTabs((current) =>
      current.map((tab) =>
        tab.kind === "workflow" && tab.workflowId === workflowId ? { ...tab, title } : tab,
      ),
    );
    setAiRefreshSignal((value) => value + 1);
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
        return [...prev, { kind: "workflow", path, workflowId, templateBinding, title: workflowId }];
      });
      setActivePath(path);
      if (workspaceId) {
        void getWorkflow(workspaceId, workflowId)
          .then((workflow) => {
            setTabs((current) =>
              current.map((tab) =>
                tab.kind === "workflow" && tab.workflowId === workflowId
                  ? { ...tab, title: workflow.title }
                  : tab,
              ),
            );
          })
          .catch(() => undefined);
      }
    },
    [workspaceId],
  );

  const openWorkflowDetailsTab = useCallback(
    (details: Omit<WorkflowDetailsTabState, "kind" | "path">) => {
      const path = workflowDetailsPath(details.workflowId, details.nodeId);
      setTabs((prev) => {
        const existing = prev.find((tab) => tab.path === path);
        if (existing) {
          return prev.map((tab) =>
            tab.path === path && tab.kind === "workflow-details" ? { ...tab, ...details } : tab,
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
        notify.error(t("error.writeFile", { detail }));
      }
    },
    [notify, refreshGitStatus, t, workspaceId],
  );

  const saveActive = useCallback(async () => {
    if (!activePath) return;
    const tab = tabs.find((candidate) => candidate.path === activePath);
    if (tab?.kind !== "file" || tab.deleted || tab.externalName) return;
    await saveFiles([{ path: tab.path, content: tab.content }]);
  }, [activePath, saveFiles, tabs]);

  const saveAll = useCallback(async () => {
    const files = tabs
      .filter(
        (tab): tab is FileTab =>
          tab.kind === "file" && tab.dirty && !tab.deleted && !tab.externalName,
      )
      .map(({ path, content }) => ({ path, content }));
    await saveFiles(files);
  }, [saveFiles, tabs]);

  useEffect(() => {
    if (!settings.editor.autoSave) return;
    const files = tabs
      .filter(
        (tab): tab is FileTab =>
          tab.kind === "file" && tab.dirty && !tab.deleted && !tab.externalName,
      )
      .map(({ path, content }) => ({ path, content }));
    if (files.length === 0) return;
    const timer = window.setTimeout(() => void saveFiles(files), 750);
    return () => window.clearTimeout(timer);
  }, [saveFiles, settings.editor.autoSave, tabs]);

  const closeTab = useCallback(
    (path: string) => {
      setTabs((prev) => {
        const idx = prev.findIndex((t) => t.path === path);
        const removed = idx >= 0 ? prev[idx] : undefined;
        const next = prev.filter((t) => t.path !== path);
        if (activePath === path) {
          const owner =
            removed?.kind === "workflow-details"
              ? next.find((tab) => tab.kind === "workflow" && tab.workflowId === removed.workflowId)
              : undefined;
          const fallback = owner ?? next[idx] ?? next[idx - 1] ?? next[next.length - 1] ?? null;
          setActivePath(fallback ? fallback.path : null);
        }
        return next;
      });
    },
    [activePath],
  );

  const reorderTabs = useCallback((fromPath: string, toPath: string) => {
    setTabs((current) => {
      const from = current.findIndex((tab) => tab.path === fromPath);
      const to = current.findIndex((tab) => tab.path === toPath);
      if (from < 0 || to < 0 || from === to) return current;
      const next = [...current];
      const [moved] = next.splice(from, 1);
      if (!moved) return current;
      next.splice(from < to ? to - 1 : to, 0, moved);
      return next;
    });
  }, []);

  const moveTabToEnd = useCallback((path: string) => {
    setTabs((current) => {
      const index = current.findIndex((tab) => tab.path === path);
      if (index < 0 || index === current.length - 1) return current;
      const next = [...current];
      const [moved] = next.splice(index, 1);
      if (moved) next.push(moved);
      return next;
    });
  }, []);

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
  const activeWorkflowDetailsTab = activeTab?.kind === "workflow-details" ? activeTab : null;
  const hasDirtyFiles = tabs.some((tab) => tab.kind === "file" && tab.dirty && !tab.deleted);
  const windowsDesktopShell = isWindowsDesktopShell();

  const updateTabScroll = useCallback(() => {
    const list = tabsListRef.current;
    if (!list) return;
    const maxScroll = Math.max(0, list.scrollWidth - list.clientWidth);
    if (maxScroll <= 0) {
      setTabScroll((current) =>
        current.thumbPercent === 100 && current.offsetPercent === 0
          ? current
          : { thumbPercent: 100, offsetPercent: 0 },
      );
      return;
    }
    const thumbPercent = Math.max(12, Math.min(100, (list.clientWidth / list.scrollWidth) * 100));
    const offsetPercent = (list.scrollLeft / maxScroll) * (100 - thumbPercent);
    setTabScroll({ thumbPercent, offsetPercent });
  }, []);

  useEffect(() => {
    const list = tabsListRef.current;
    if (!list) return;
    updateTabScroll();
    list.addEventListener("scroll", updateTabScroll, { passive: true });
    const resizeObserver =
      typeof ResizeObserver === "undefined" ? null : new ResizeObserver(updateTabScroll);
    resizeObserver?.observe(list);
    const mutationObserver =
      typeof MutationObserver === "undefined" ? null : new MutationObserver(updateTabScroll);
    mutationObserver?.observe(list, { childList: true, subtree: true, characterData: true });
    return () => {
      list.removeEventListener("scroll", updateTabScroll);
      resizeObserver?.disconnect();
      mutationObserver?.disconnect();
    };
  }, [tabs, updateTabScroll]);

  const onTabScrollbarPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const list = tabsListRef.current;
      const track = event.currentTarget;
      if (!list || list.scrollWidth <= list.clientWidth) return;
      const rect = track.getBoundingClientRect();
      const thumbWidth = (track.clientWidth * tabScroll.thumbPercent) / 100;
      const travel = Math.max(1, track.clientWidth - thumbWidth);
      const maxScroll = list.scrollWidth - list.clientWidth;
      const target = event.target as HTMLElement;
      if (!target.closest("[data-tab-scroll-thumb]")) {
        const targetLeft = Math.max(
          0,
          Math.min(travel, event.clientX - rect.left - thumbWidth / 2),
        );
        list.scrollLeft = (targetLeft / travel) * maxScroll;
        updateTabScroll();
      } else {
        tabScrollDragRef.current = {
          startX: event.clientX,
          startScrollLeft: list.scrollLeft,
          travel,
          maxScroll,
        };
        track.setPointerCapture(event.pointerId);
      }
      event.preventDefault();
    },
    [tabScroll.thumbPercent, updateTabScroll],
  );

  const onTabScrollbarPointerMove = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      const drag = tabScrollDragRef.current;
      const list = tabsListRef.current;
      if (!drag || !list) return;
      list.scrollLeft =
        drag.startScrollLeft + ((event.clientX - drag.startX) / drag.travel) * drag.maxScroll;
      updateTabScroll();
    },
    [updateTabScroll],
  );

  const stopTabScrollbarDrag = useCallback((event: ReactPointerEvent<HTMLDivElement>) => {
    tabScrollDragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  }, []);

  const openDroppedBrowserFile = useCallback(
    async (file: File, insertionIndex: number) => {
      const name = file.name.trim() || "dropped-file";
      const safeName = name.replace(/[\\/]/g, "_");
      const path = `__external__:${Date.now()}-${Math.random().toString(36).slice(2)}:${safeName}`;
      const bytes = new Uint8Array(await file.arrayBuffer());
      const image = isImagePath(name);
      let content = "";
      let imageDataUrl: string | undefined;
      if (image) {
        imageDataUrl = fileDataUrl(file, bytes);
      } else {
        try {
          content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
        } catch {
          notify.error(t("error.readFile", { detail: "binary file" }));
          return;
        }
      }
      const nextTab: FileTab = {
        kind: "file",
        path,
        content,
        savedContent: content,
        dirty: false,
        deleted: false,
        previewMode: false,
        image,
        externalName: name,
        imageDataUrl,
      };
      setTabs((current) => {
        const next = [...current];
        next.splice(Math.max(0, Math.min(insertionIndex, next.length)), 0, nextTab);
        return next;
      });
      setActivePath(path);
    },
    [notify, t],
  );

  const openDroppedDesktopFile = useCallback(
    async (externalPath: string, insertionIndex: number) => {
      if (!workspaceId) return;
      try {
        const result = await readExternalFile(workspaceId, externalPath);
        const image = Boolean(result.contentBase64);
        const path = `__external__:${Date.now()}-${Math.random().toString(36).slice(2)}:${result.name}`;
        const nextTab: FileTab = {
          kind: "file",
          path,
          content: result.content ?? "",
          savedContent: result.content ?? "",
          dirty: false,
          deleted: false,
          previewMode: false,
          image,
          externalName: result.name,
          imageDataUrl: image
            ? `data:${result.mime ?? "application/octet-stream"};base64,${result.contentBase64}`
            : undefined,
        };
        setTabs((current) => {
          const next = [...current];
          next.splice(Math.max(0, Math.min(insertionIndex, next.length)), 0, nextTab);
          return next;
        });
        setActivePath(path);
      } catch (error) {
        notify.error((error as Error).message);
      }
    },
    [notify, workspaceId],
  );

  useEffect(() => {
    let unlisten: (() => void) | null = null;
    void listenDesktopFileDrop((payload) => {
      const elements = elementsAtDesktopDropPosition(payload.position);
      // Coordinate payloads can be reported in physical pixels or window
      // coordinates. Prefer the explorer whenever any candidate lands there,
      // otherwise an external file may be opened as a temporary tab instead
      // of being copied into the dropped directory.
      if (elements.some((candidate) => candidate.closest("[data-file-tree-root]"))) return;
      const element = elements.find(
        (candidate) =>
          candidate.closest("[data-workbench-tab-index]") ||
          candidate.closest("[data-workbench-editor-drop]") ||
          candidate.closest("[data-workbench-tabs-drop]"),
      );
      if (!element) return;
      const tab = element?.closest<HTMLElement>("[data-workbench-tab-index]");
      const editor = element?.closest<HTMLElement>("[data-workbench-editor-drop]");
      const tabStrip = element?.closest<HTMLElement>("[data-workbench-tabs-drop]");
      if (!tab && !editor && !tabStrip) return;
      const index = Number(
        tab?.dataset.workbenchTabIndex ??
          editor?.dataset.workbenchDropIndex ??
          tabStrip?.dataset.workbenchDropIndex,
      );
      const source = payload.paths[0];
      if (source && Number.isInteger(index)) void openDroppedDesktopFile(source, index);
    }).then((cleanup) => {
      unlisten = cleanup;
    });
    return () => unlisten?.();
  }, [openDroppedDesktopFile, tabs.length]);

  const openDroppedFile = useCallback(
    async (filePath: string, insertionIndex: number) => {
      let workspacePath = filePath;
      if (isExternalAbsolutePath(filePath)) {
        if (!workspaceId) return;
        try {
          workspacePath = await resolveExternalFilePath(workspaceId, filePath);
        } catch (error) {
          notify.error((error as Error).message);
          return;
        }
      }
      await openFilePath(workspacePath, undefined, insertionIndex);
    },
    [notify, openFilePath, workspaceId],
  );

  const onTabDragStart = useCallback((event: DragEvent, path: string) => {
    event.stopPropagation();
    event.currentTarget.classList.add("is-dragging");
    event.dataTransfer.setData(TAB_DRAG_MIME, path);
    event.dataTransfer.effectAllowed = "move";
  }, []);

  const onTabDragOver = useCallback((event: DragEvent) => {
    const isTabDrag = event.dataTransfer.types.includes(TAB_DRAG_MIME);
    const isFileDrag = hasFileTreeDrag(event.dataTransfer.types);
    if (!isTabDrag && !isFileDrag) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = isTabDrag ? "move" : "copy";
  }, []);

  const onTabDrop = useCallback(
    (event: DragEvent, targetPath: string, targetIndex: number) => {
      const tabPath = event.dataTransfer.getData(TAB_DRAG_MIME);
      if (tabPath) {
        event.preventDefault();
        event.stopPropagation();
        reorderTabs(tabPath, targetPath);
        return;
      }
      if (!hasFileTreeDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();
      const filePath = readFileTreeDragPaths(event.dataTransfer)[0];
      const file = readFileTreeDragFiles(event.dataTransfer)[0];
      if (!event.dataTransfer.getData(FILE_TREE_DRAG_MIME) && file) {
        void openDroppedBrowserFile(file, targetIndex);
      } else if (filePath) openDroppedFile(filePath, targetIndex);
    },
    [openDroppedBrowserFile, openDroppedFile, reorderTabs],
  );

  const onTabStripDrop = useCallback(
    (event: DragEvent) => {
      const tabPath = event.dataTransfer.getData(TAB_DRAG_MIME);
      if (tabPath) {
        event.preventDefault();
        event.stopPropagation();
        moveTabToEnd(tabPath);
        return;
      }
      if (!hasFileTreeDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();
      const filePath = readFileTreeDragPaths(event.dataTransfer)[0];
      const file = readFileTreeDragFiles(event.dataTransfer)[0];
      if (!event.dataTransfer.getData(FILE_TREE_DRAG_MIME) && file) {
        void openDroppedBrowserFile(file, tabs.length);
      } else if (filePath) openDroppedFile(filePath, tabs.length);
    },
    [moveTabToEnd, openDroppedBrowserFile, openDroppedFile, tabs],
  );

  const onTabsDropCapture = useCallback(
    (event: DragEvent) => {
      if (event.isPropagationStopped()) return;
      const target = event.target instanceof Element
        ? event.target.closest<HTMLElement>("[data-workbench-tab-index]")
        : null;
      const index = target ? Number(target.dataset.workbenchTabIndex) : -1;
      const tab = Number.isInteger(index) && index >= 0 ? tabs[index] : null;
      if (tab) onTabDrop(event, tab.path, index);
      else onTabStripDrop(event);
    },
    [onTabDrop, onTabStripDrop, tabs],
  );

  const onWorkspaceDragOver = useCallback((event: DragEvent) => {
    if (event.isPropagationStopped()) return;
    if (!hasFileTreeDrag(event.dataTransfer.types)) return;
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const onWorkspaceDrop = useCallback(
    (event: DragEvent) => {
      if (event.isPropagationStopped()) return;
      if (!hasFileTreeDrag(event.dataTransfer.types)) return;
      event.preventDefault();
      event.stopPropagation();
      const filePath = readFileTreeDragPaths(event.dataTransfer)[0];
      const file = readFileTreeDragFiles(event.dataTransfer)[0];
      const activeIndex = activePath ? tabs.findIndex((tab) => tab.path === activePath) : -1;
      const insertionIndex = activeIndex >= 0 ? activeIndex : tabs.length;
      if (!event.dataTransfer.getData(FILE_TREE_DRAG_MIME) && file) {
        void openDroppedBrowserFile(file, insertionIndex);
      } else if (filePath) openDroppedFile(filePath, insertionIndex);
    },
    [activePath, openDroppedBrowserFile, openDroppedFile, tabs],
  );

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
                  onWorkflowRenamed={handleWorkflowRenamed}
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
                    onDropFileToTab={openDroppedFile}
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
            <div
              className="tabs"
              data-workbench-tabs-drop="true"
              data-workbench-drop-index={tabs.length}
              onDragOverCapture={onTabDragOver}
              onDropCapture={onTabsDropCapture}
            >
              <div className="tabs__viewport">
                <div
                  ref={tabsListRef}
                  className="tabs__list"
                  onDragOver={onTabDragOver}
                  onDrop={onTabStripDrop}
                >
                {tabs.map((tab) => {
                  const isDeleted = tab.kind === "file" && tab.deleted;
                  const label =
                    tab.kind === "settings"
                      ? t("common.settings")
                      : tab.kind === "workflow"
                        ? tab.title ?? tab.workflowId
                        : tab.kind === "workflow-details"
                          ? tab.title
                          : tab.kind === "template"
                            ? t("nav.templates")
                            : tab.kind === "multi-diff"
                              ? tab.title
                              : tab.kind === "diff"
                                ? `${basename(tab.filePath)} (${diffLabel(tab)})`
                                : tab.externalName ?? tab.path.split("/").pop();
                  const tabTitle =
                    tab.kind === "file"
                      ? isDeleted
                        ? `${tab.path}${t("editor.deleted")}`
                        : tab.externalName ?? tab.path
                      : tab.kind === "diff"
                        ? `${tab.filePath} · ${diffLabel(tab)}`
                        : tab.kind === "multi-diff"
                          ? tab.title
                          : tab.kind === "workflow"
                            ? tab.title ?? tab.workflowId
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
                      draggable
                      data-workbench-tab-index={tabs.indexOf(tab)}
                      data-workbench-tab-file={tab.kind === "file" ? "true" : undefined}
                      onClick={() => setActivePath(tab.path)}
                      onDragStart={(event) => onTabDragStart(event, tab.path)}
                      onDragOver={onTabDragOver}
                      onDrop={(event) => onTabDrop(event, tab.path, tabs.indexOf(tab))}
                      onDragEnd={(event) => event.currentTarget.classList.remove("is-dragging")}
                      title={tabTitle}
                    >
                      <span className="tab__icon" aria-hidden="true">
                        <TabIcon tab={tab} />
                      </span>
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
                <div
                  className={"tabs__scrollbar" + (tabScroll.thumbPercent < 100 ? " is-visible" : "")}
                  role="scrollbar"
                  aria-orientation="horizontal"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(
                    (tabScroll.offsetPercent / Math.max(1, 100 - tabScroll.thumbPercent)) * 100,
                  )}
                  onPointerDown={onTabScrollbarPointerDown}
                  onPointerMove={onTabScrollbarPointerMove}
                  onPointerUp={stopTabScrollbarDrag}
                  onPointerCancel={stopTabScrollbarDrag}
                >
                  <div
                    className="tabs__scrollbar-thumb"
                    data-tab-scroll-thumb="true"
                    style={{
                      width: `${tabScroll.thumbPercent}%`,
                      left: `${tabScroll.offsetPercent}%`,
                    }}
                  />
                </div>
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
            <div
              className="editor-host"
              data-workbench-editor-drop="true"
              data-workbench-drop-index={
                activePath ? Math.max(0, tabs.findIndex((tab) => tab.path === activePath)) : tabs.length
              }
              onDragOver={onWorkspaceDragOver}
              onDragOverCapture={onWorkspaceDragOver}
              onDrop={onWorkspaceDrop}
              onDropCapture={onWorkspaceDrop}
            >
              <Suspense fallback={<div className="tab-loading-fallback" />}>
                {activeFileTab ? (
                  activeFileTab.image ? (
                    <div className="image-preview">
                      <img
                        src={
                          activeFileTab.imageDataUrl ??
                          workspaceImageUrl(workspaceId ?? "", activeFileTab.path)
                        }
                        alt={activeFileTab.externalName ?? activeFileTab.path}
                      />
                    </div>
                  ) : isMarkdownPath(activeFileTab.path) && activeFileTab.previewMode ? (
                    <div className="editor-host__preview">
                      <MarkdownPreview
                        source={activeFileTab.content}
                        workspaceId={workspaceId}
                        filePath={activeFileTab.path}
                      />
                    </div>
                  ) : (
                    <div className="editor-host__source">
                      <EditorPane
                        key={activeFileTab.path}
                        path={activeFileTab.path}
                        value={activeFileTab.content}
                        readOnly={Boolean(activeFileTab.externalName)}
                        fontSize={settings.editor.fontSize}
                        tabSize={settings.editor.tabSize}
                        onChange={updateActive}
                        onSave={saveActive}
                        onPasteImage={pasteImageIntoMarkdown}
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
                  <SettingsView
                    settings={settings}
                    onChange={updateSettings}
                    workspaceId={workspaceId}
                  />
                ) : activeTab?.kind === "workflow" ? (
                  workspaceId ? (
                    <WorkflowTab
                      workspaceId={workspaceId}
                      workflowId={activeTab.workflowId}
                      editorFontSize={settings.editor.fontSize}
                      editorTabSize={settings.editor.tabSize}
                      onOpenDiff={openPreparedMultiDiffTab}
                      onWorkflowChanged={bumpAiRefresh}
                      onWorkflowRenamed={handleWorkflowRenamed}
                      externalTitleUpdate={
                        workflowTitleUpdate?.workflowId === activeTab.workflowId
                          ? workflowTitleUpdate
                          : undefined
                      }
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
                  editorFontSize={settings.editor.fontSize}
                  editorTabSize={settings.editor.tabSize}
                  editorAutoSave={settings.editor.autoSave}
                  onDocsChanged={bumpFileTree}
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

function isImagePath(path: string): boolean {
  return /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i.test(path);
}

function fileDataUrl(file: File, bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${file.type || "application/octet-stream"};base64,${btoa(binary)}`;
}

function imageExtension(mimeType: string): string {
  const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "png";
  return (
    ({ jpeg: "jpg", "svg+xml": "svg", "x-icon": "ico" } as Record<string, string>)[subtype] ??
    subtype
  );
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function isExternalAbsolutePath(value: string): boolean {
  return /^[a-zA-Z]:[\\/]/.test(value) || value.startsWith("\\\\") || value.startsWith("/");
}

function diffLabel(t: DiffTab): string {
  if (t.base === "HEAD" && t.head === "INDEX") return "Staged";
  if (t.base === "INDEX" && t.head === "WORKTREE") return "Working Tree";
  return `${t.base} → ${t.head}`;
}

function TabIcon({ tab }: { tab: Tab }) {
  if (tab.kind === "file") return <FileIcon name={tab.path} />;
  if (tab.kind === "workflow") {
    return (
      <svg
        viewBox="0 0 16 16"
        width="16"
        height="16"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.15"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <circle cx="4" cy="4.7" r="1.45" />
        <circle cx="12" cy="4.7" r="1.45" />
        <circle cx="8" cy="11.5" r="1.45" />
        <path d="M5.35 5.5 7.15 10.2M10.65 5.5 8.85 10.2M5.6 4.7h4.8" />
      </svg>
    );
  }
  const paths =
    tab.kind === "workflow-details"
        ? "M3 2.5h7l3 3V13.5H3zM10 2.5v3h3M5 8h6M5 10.5h4"
        : tab.kind === "template"
          ? "M3 3h8.5v10H3zM5 5.5h4.5M5 8h4.5M5 10.5h3"
          : tab.kind === "diff" || tab.kind === "multi-diff"
            ? "M3 3h4v4H3zM9 9h4v4H9zM7 5h2v6M9 7h2"
            : "M8 2.5a2 2 0 0 1 2 2v.5h.5a2 2 0 0 1 2 2v.5a2 2 0 0 1 0 4v.5a2 2 0 0 1-2 2H5.5a2 2 0 0 1-2-2v-.5a2 2 0 0 1 0-4v-.5a2 2 0 0 1 2-2H6v-.5a2 2 0 0 1 2-2zM6 8h4M8 6v4";
  return (
    <svg viewBox="0 0 16 16" width="16" height="16" fill="none" aria-hidden="true">
      <path d={paths} stroke="currentColor" strokeWidth="1.15" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
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
