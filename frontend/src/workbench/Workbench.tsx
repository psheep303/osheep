import { useCallback, useEffect, useRef, useState } from "react";
import { ActivityBar, type ViewId } from "./ActivityBar";
import { BottomPanel } from "./BottomPanel";
import { EditorPane } from "./EditorPane";
import { FileTree } from "./FileTree";
import { GitView } from "./GitView";
import { Resizer } from "./Resizer";
import { SearchView } from "./SearchView";
import { SettingsView } from "./SettingsView";
import { DEFAULT_SETTINGS, type OsheepSettings } from "./settings";
import {
  type FsNode,
  ensurePermission,
  loadOsheepSettings,
  pickRootDirectory,
  readFileText,
  saveOsheepSettings,
  writeFileText,
} from "./fs";
import "./workbench.css";

interface FileTab {
  kind: "file";
  path: string;
  handle: FileSystemFileHandle;
  content: string;
  savedContent: string;
  dirty: boolean;
  deleted: boolean;
}

interface SettingsTab {
  kind: "settings";
  path: "__settings__";
}

type Tab = FileTab | SettingsTab;

const SETTINGS_PATH = "__settings__";

const DEFAULT_LEFT_WIDTH = 260;
const DEFAULT_RIGHT_WIDTH = 320;
const DEFAULT_BOTTOM_HEIGHT = 200;
const SIDE_THRESHOLD = 80;
const BOTTOM_THRESHOLD = 60;
const SIDE_MAX = 600;

export function Workbench() {
  const [rootHandle, setRootHandle] = useState<FileSystemDirectoryHandle | null>(
    null
  );
  const [tabs, setTabs] = useState<Tab[]>([]);
  const [activePath, setActivePath] = useState<string | null>(null);
  const [selectedTreePath, setSelectedTreePath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<OsheepSettings>(DEFAULT_SETTINGS);

  const [activeView, setActiveView] = useState<ViewId>("explorer");

  // Width / height of 0 means collapsed. Non-zero is the rendered size.
  const [leftWidth, setLeftWidth] = useState(DEFAULT_LEFT_WIDTH);
  const [rightWidth, setRightWidth] = useState(0);
  const [bottomHeight, setBottomHeight] = useState(0);

  // Last non-zero size, so toggle-buttons can restore the user's preferred size.
  const lastLeftWidthRef = useRef(DEFAULT_LEFT_WIDTH);
  const lastRightWidthRef = useRef(DEFAULT_RIGHT_WIDTH);
  const lastBottomHeightRef = useRef(DEFAULT_BOTTOM_HEIGHT);

  // Cumulative drag progress (in pixels). Lets the user drag a collapsed
  // panel back out from its edge without each delta being snapped to 0.
  const leftProgressRef = useRef(0);
  const rightProgressRef = useRef(0);
  const bottomProgressRef = useRef(0);

  const leftCollapsed = leftWidth === 0;
  const rightCollapsed = rightWidth === 0;
  const bottomCollapsed = bottomHeight === 0;

  useEffect(() => {
    if (!rootHandle) return;
    let cancelled = false;
    void loadOsheepSettings(rootHandle).then((s) => {
      if (!cancelled) setSettings(s);
    });
    return () => {
      cancelled = true;
    };
  }, [rootHandle]);

  const updateSettings = useCallback(
    (next: OsheepSettings) => {
      setSettings(next);
      if (rootHandle) void saveOsheepSettings(rootHandle, next);
    },
    [rootHandle]
  );

  const openProject = useCallback(async () => {
    setError(null);
    try {
      const handle = await pickRootDirectory();
      await ensurePermission(handle, "readwrite");
      setRootHandle(handle);
      if (leftCollapsed) {
        setLeftWidth(lastLeftWidthRef.current);
      }
    } catch (e) {
      if ((e as Error).name === "AbortError") return;
      setError((e as Error).message);
    }
  }, [leftCollapsed]);

  const openFile = useCallback(
    async (node: FsNode) => {
      if (node.kind !== "file") return;
      const existing = tabs.find(
        (t) => t.kind === "file" && t.path === node.path
      );
      if (existing) {
        setActivePath(node.path);
        return;
      }
      const fileHandle = node.handle as FileSystemFileHandle;
      const text = await readFileText(fileHandle);
      setTabs((prev) => [
        ...prev,
        {
          kind: "file",
          path: node.path,
          handle: fileHandle,
          content: text,
          savedContent: text,
          dirty: false,
          deleted: false,
        },
      ]);
      setActivePath(node.path);
    },
    [tabs]
  );

  const openSettingsTab = useCallback(() => {
    setTabs((prev) => {
      if (prev.some((t) => t.kind === "settings")) return prev;
      return [...prev, { kind: "settings", path: SETTINGS_PATH }];
    });
    setActivePath(SETTINGS_PATH);
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
    if (!activePath) return;
    const tab = tabs.find((t) => t.path === activePath);
    if (!tab || tab.kind !== "file" || tab.deleted) return;
    await writeFileText(tab.handle, tab.content);
    setTabs((prev) =>
      prev.map((t) =>
        t.kind === "file" && t.path === activePath
          ? { ...t, savedContent: t.content, dirty: false }
          : t
      )
    );
  }, [activePath, tabs]);

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
    // Dragging left (negative delta x) grows the right panel.
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
    // Dragging up (negative delta y) grows the bottom panel.
    bottomProgressRef.current -= delta;
    const p = bottomProgressRef.current;
    if (p < BOTTOM_THRESHOLD) {
      setBottomHeight(0);
    } else {
      const h = Math.min(p, SIDE_MAX);
      setBottomHeight(h);
      lastBottomHeightRef.current = h;
    }
  }, []);

  const toggleRight = () => {
    if (rightCollapsed) setRightWidth(lastRightWidthRef.current);
    else {
      lastRightWidthRef.current = rightWidth;
      setRightWidth(0);
    }
  };
  const toggleBottom = () => {
    if (bottomCollapsed) setBottomHeight(lastBottomHeightRef.current);
    else {
      lastBottomHeightRef.current = bottomHeight;
      setBottomHeight(0);
    }
  };

  const activeTab = tabs.find((t) => t.path === activePath) ?? null;
  const activeFileTab = activeTab?.kind === "file" ? activeTab : null;

  return (
    <div className="workbench">
      <div className="titlebar">
        <span className="titlebar__brand">osheep</span>
        <span className="titlebar__sep">·</span>
        <span className="titlebar__project">
          {rootHandle ? rootHandle.name : "未打开项目"}
        </span>
        <div className="titlebar__actions">
          <button className="tb-btn" onClick={openProject}>
            打开项目…
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

      {error && <div className="banner-error">{error}</div>}

      <div className="body">
        <ActivityBar
          activeView={activeView}
          collapsed={leftCollapsed}
          onSelect={onSelectView}
          onOpenSettings={openSettingsTab}
        />

        {!leftCollapsed && (
          <div className="side" style={{ width: leftWidth }}>
            {activeView === "explorer" &&
              (rootHandle ? (
                <FileTree
                  rootHandle={rootHandle}
                  selectedPath={selectedTreePath}
                  onSelect={setSelectedTreePath}
                  onOpenFile={openFile}
                  onPathRenamed={onPathRenamed}
                  onPathDeleted={onPathDeleted}
                />
              ) : (
                <div className="side-view">
                  <div className="side-view__header">
                    <span className="side-view__title">资源管理器</span>
                  </div>
                  <div className="side-view__body side-view__body--padded">
                    <button className="primary-btn" onClick={openProject}>
                      打开项目
                    </button>
                    <div className="muted" style={{ marginTop: 12 }}>
                      请选择本地文件夹作为工作区
                    </div>
                  </div>
                </div>
              ))}
            {activeView === "search" && <SearchView />}
            {activeView === "git" && <GitView />}
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
              {tabs.map((t) => {
                const isDeleted = t.kind === "file" && t.deleted;
                return (
                  <div
                    key={t.path}
                    className={
                      "tab" +
                      (t.path === activePath ? " is-active" : "") +
                      (isDeleted ? " is-deleted" : "")
                    }
                    onClick={() => setActivePath(t.path)}
                    title={
                      t.kind === "file"
                        ? isDeleted
                          ? `${t.path}（已被删除）`
                          : t.path
                        : "设置"
                    }
                  >
                    <span className="tab__name">
                      {t.kind === "settings"
                        ? "设置"
                        : t.path.split("/").pop()}
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
            <div className="editor-host">
              {activeFileTab ? (
                <EditorPane
                  path={activeFileTab.path}
                  value={activeFileTab.content}
                  fontSize={settings.editor.fontSize}
                  onChange={updateActive}
                  onSave={saveActive}
                />
              ) : activeTab?.kind === "settings" ? (
                <SettingsView
                  settings={settings}
                  onChange={updateSettings}
                  hasProject={!!rootHandle}
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
          {!bottomCollapsed && (
            <div className="bottom" style={{ height: bottomHeight }}>
              <BottomPanel onClose={toggleBottom} />
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
            <div className="side-view">
              <div className="side-view__header">
                <span className="side-view__title">AI 面板</span>
                <button className="icon-btn" title="关闭" onClick={toggleRight}>
                  ×
                </button>
              </div>
              <div className="side-view__body side-view__body--padded">
                <div className="muted">
                  后续阶段接入：需求输入、文档生成、Todo 生成、执行控制
                </div>
              </div>
            </div>
          </div>
        )}
      </div>
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
