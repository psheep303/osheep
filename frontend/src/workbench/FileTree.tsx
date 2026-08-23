import {
  type CSSProperties,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { useUiPreferences } from "../i18n/UiPreferences";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
import { isWindowsDesktopShell } from "./desktop-folder-picker";
import { FileIcon } from "./FileIcon";
import type { FsNode } from "./fs";
import {
  copyEntryTo,
  createDirectory,
  createFile,
  findFreeName,
  moveEntryTo,
  readDirShallow,
  removeEntry,
  renameEntry,
} from "./fs";
import { type FileDecoration, isIgnoredPath, statusColor } from "./git-decorations";
import { useOsheepOverlay } from "./OsheepOverlay";

type DraftKind = "file" | "folder";

interface ClipboardEntry {
  path: string;
  name: string;
  entryKind: "file" | "directory";
}

interface ClipboardState {
  kind: "copy" | "cut";
  entries: ClipboardEntry[];
}

interface TreeContextValue {
  workspaceId: string;
  treeVersion: number;
  bumpTree: () => void;
  selectedPaths: ReadonlySet<string>;
  selectNode: (node: FsNode, additive: boolean) => void;
  registerNode: (node: FsNode) => void;
  actionNodesFor: (node: FsNode) => FsNode[];
  onOpenFile: (node: FsNode) => void;
  openMenu: (x: number, y: number, ctx: MenuCtx) => void;
  clipboard: ClipboardState | null;
  deleteEntries: (entries: FsNode[]) => Promise<void>;
  storeEntries: (kind: ClipboardState["kind"], entries: FsNode[]) => void;
  pasteEntries: (targetDir: string) => Promise<void>;
  onPathRenamed: (oldPath: string, newPath: string) => void;
  dropTarget: string | null;
  setDropTarget: (path: string | null) => void;
  onDropMove: (srcPaths: string[], destDir: string) => Promise<void>;
  pointerDragFallback: boolean;
  pointerDragPaths: ReadonlySet<string>;
  beginPointerDrag: (node: FsNode, event: React.PointerEvent) => void;
  consumePointerClick: () => boolean;
  decorations: Map<string, FileDecoration>;
}

const TreeCtx = createContext<TreeContextValue | null>(null);
const useTreeCtx = () => {
  const v = useContext(TreeCtx);
  if (!v) throw new Error("TreeCtx missing");
  return v;
};

const DRAG_MIME = "application/x-osheep-path";
const DRAG_TEXT_PREFIX = "osheep-path:";
const DRAG_URI_PREFIX = "osheep-path-uri:";

function hasTreeDrag(e: React.DragEvent): boolean {
  return (
    e.dataTransfer.types.includes(DRAG_MIME) ||
    e.dataTransfer.types.includes("text/plain") ||
    e.dataTransfer.types.includes("text/uri-list")
  );
}

function encodeTreeDragPaths(paths: string[]): string {
  return JSON.stringify(paths);
}

function decodeTreeDragPaths(value: string): string[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter((path): path is string => typeof path === "string" && path.length > 0);
    }
  } catch {
    // Accept drag data written by older single-path clients.
  }
  return [value];
}

function readTreeDragPaths(e: React.DragEvent): string[] {
  const custom = e.dataTransfer.getData(DRAG_MIME);
  if (custom) return decodeTreeDragPaths(custom);
  const text = e.dataTransfer.getData("text/plain");
  if (text.startsWith(DRAG_TEXT_PREFIX)) {
    return decodeTreeDragPaths(text.slice(DRAG_TEXT_PREFIX.length));
  }
  const uri = e.dataTransfer.getData("text/uri-list");
  return uri.startsWith(DRAG_URI_PREFIX)
    ? decodeTreeDragPaths(uri.slice(DRAG_URI_PREFIX.length))
    : [];
}

interface FileTreeProps {
  workspaceId: string;
  workspaceName: string;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onOpenFile: (node: FsNode) => void;
  onPathRenamed: (oldPath: string, newPath: string) => void;
  onPathDeleted: (path: string) => void;
  decorations: Map<string, FileDecoration>;
  onFsChange?: () => void;
  /**
   * Bumped by the workbench to force a tree reload (e.g. after osheep code
   * mutates files). A change in this number reloads the root and every
   * expanded directory, preserving expansion state.
   */
  refreshSignal?: number;
}

function joinPath(parent: string, name: string): string {
  if (!parent) return name;
  return `${parent}/${name}`;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

function basename(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(i + 1) : p;
}

function isAncestorOrSelf(maybeAncestor: string, descendant: string): boolean {
  return maybeAncestor === descendant || descendant.startsWith(`${maybeAncestor}/`);
}

function topLevelPaths(paths: Iterable<string>): string[] {
  const unique = [...new Set(paths)].sort((a, b) => a.length - b.length || a.localeCompare(b));
  return unique.filter(
    (path, index) => !unique.slice(0, index).some((parent) => isAncestorOrSelf(parent, path)),
  );
}

function topLevelEntries(entries: FsNode[]): FsNode[] {
  const byPath = new Map(entries.map((entry) => [entry.path, entry]));
  return topLevelPaths(byPath.keys())
    .map((path) => byPath.get(path))
    .filter((entry): entry is FsNode => !!entry);
}

export function FileTree({
  workspaceId,
  workspaceName,
  selectedPath,
  onSelect,
  onOpenFile,
  onPathRenamed,
  onPathDeleted,
  decorations,
  onFsChange,
  refreshSignal,
}: FileTreeProps) {
  const { t } = useUiPreferences();
  const { confirm, notify } = useOsheepOverlay();
  const [children, setChildren] = useState<FsNode[]>([]);
  const [draft, setDraft] = useState<DraftKind | null>(null);
  const [treeVersion, setTreeVersion] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());
  const nodesByPathRef = useRef(new Map<string, FsNode>());
  const treeRootRef = useRef<HTMLDivElement>(null);
  const treeKeyboardActiveRef = useRef(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);
  const pointerDragFallback = isWindowsDesktopShell();
  const pointerDragRef = useRef<{
    entries: FsNode[];
    pointerId: number;
    captureElement: HTMLElement;
    startX: number;
    startY: number;
    active: boolean;
  } | null>(null);
  const [pointerDragPaths, setPointerDragPaths] = useState<Set<string>>(new Set());
  const [pointerDragActive, setPointerDragActive] = useState(false);
  const [pointerDragPreview, setPointerDragPreview] = useState<{
    x: number;
    y: number;
    entries: FsNode[];
  } | null>(null);
  const suppressClickRef = useRef(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const kids = await readDirShallow(workspaceId, "");
      if (!cancelled) setChildren(kids);
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, treeVersion]);

  useEffect(() => {
    setSelectedPaths(new Set());
    setClipboard(null);
    nodesByPathRef.current.clear();
  }, [workspaceId]);

  useEffect(() => {
    setSelectedPaths((current) => {
      if (!selectedPath) return current.size === 0 ? current : new Set();
      if (current.has(selectedPath)) return current;
      return new Set([selectedPath]);
    });
  }, [selectedPath]);

  const registerNode = useCallback((node: FsNode) => {
    nodesByPathRef.current.set(node.path, node);
  }, []);
  const actionNodesFor = (node: FsNode): FsNode[] => {
    const paths = selectedPaths.has(node.path) ? topLevelPaths(selectedPaths) : [node.path];
    return paths
      .map((path) => (path === node.path ? node : nodesByPathRef.current.get(path)))
      .filter((entry): entry is FsNode => !!entry);
  };
  const selectNode = (node: FsNode, additive: boolean) => {
    registerNode(node);
    if (!additive) {
      setSelectedPaths(new Set([node.path]));
      onSelect(node.path);
      return;
    }
    const next = new Set(selectedPaths);
    if (next.has(node.path)) next.delete(node.path);
    else next.add(node.path);
    setSelectedPaths(next);
    const nextPrimary = next.has(node.path) ? node.path : (next.values().next().value ?? null);
    if (selectedPath === node.path || next.has(node.path)) onSelect(nextPrimary);
  };
  const clearSelection = () => {
    setSelectedPaths(new Set());
    onSelect(null);
  };

  const updatePointerTarget = (path: string | null) => {
    setDropTarget((current) => (current === path ? current : path));
  };
  const beginPointerDrag = (node: FsNode, event: React.PointerEvent) => {
    if (
      !pointerDragFallback ||
      event.button !== 0 ||
      (event.target as HTMLElement).closest("button, input, textarea, select, a, [contenteditable]")
    )
      return;
    const captureElement = event.currentTarget as HTMLElement;
    captureElement.setPointerCapture(event.pointerId);
    pointerDragRef.current = {
      entries: actionNodesFor(node),
      pointerId: event.pointerId,
      captureElement,
      startX: event.clientX,
      startY: event.clientY,
      active: false,
    };
  };
  const consumePointerClick = () => {
    if (!suppressClickRef.current) return false;
    suppressClickRef.current = false;
    return true;
  };

  const bumpTree = () => {
    setTreeVersion((v) => v + 1);
    onFsChange?.();
  };

  // External refresh trigger (osheep code mutated files). Skip the mount pass
  // and only react to real changes, then bump treeVersion so the root and
  // every expanded directory reload — the same path as the 刷新 button.
  const prevSignalRef = useRef(refreshSignal);
  useEffect(() => {
    if (prevSignalRef.current === refreshSignal) return;
    prevSignalRef.current = refreshSignal;
    setTreeVersion((v) => v + 1);
  }, [refreshSignal]);

  const submitDraftAt = async (dir: string, kind: DraftKind, name: string) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const target = joinPath(dir, trimmed);
    try {
      if (kind === "file") await createFile(workspaceId, target);
      else await createDirectory(workspaceId, target);
    } catch (err) {
      notify.error((err as Error).message);
    }
  };

  const onSubmitRootDraft = async (name: string) => {
    if (!draft) {
      setDraft(null);
      return;
    }
    try {
      await submitDraftAt("", draft, name);
    } finally {
      setDraft(null);
      bumpTree();
    }
  };

  const deleteEntries = async (entries: FsNode[]) => {
    const targets = topLevelEntries(entries);
    if (targets.length === 0) return;
    const ok = await confirm({
      message:
        targets.length === 1
          ? t("confirm.deleteFile", { name: targets[0].name })
          : t("confirm.deleteItems", { count: targets.length }),
      confirmLabel: t("confirm.delete"),
      reminderKey: "delete-file-or-folder",
    });
    if (!ok) return;
    let changed = false;
    let firstError: Error | null = null;
    const failedEntries: FsNode[] = [];
    for (const entry of targets) {
      try {
        await removeEntry(workspaceId, entry.path);
        onPathDeleted(entry.path);
        changed = true;
      } catch (error) {
        firstError ??= error as Error;
        failedEntries.push(entry);
      }
    }
    setSelectedPaths(new Set(failedEntries.map((entry) => entry.path)));
    onSelect(failedEntries[0]?.path ?? null);
    if (changed) bumpTree();
    if (firstError) notify.error(firstError.message);
  };

  const storeEntries = (kind: ClipboardState["kind"], entries: FsNode[]) => {
    const targets = topLevelEntries(entries);
    if (targets.length === 0) return;
    setClipboard({
      kind,
      entries: targets.map((entry) => ({
        path: entry.path,
        name: entry.name,
        entryKind: entry.kind,
      })),
    });
  };

  const pasteEntries = async (targetDir: string) => {
    if (!clipboard) return;
    if (
      clipboard.entries.some(
        (entry) =>
          entry.entryKind === "directory" && isAncestorOrSelf(entry.path, targetDir),
      )
    ) {
      notify.error(t("notification.invalidMove"));
      return;
    }
    let changed = false;
    let firstError: Error | null = null;
    const failedCutEntries: ClipboardEntry[] = [];
    const nextSelection: string[] = [];
    for (const entry of clipboard.entries) {
      if (clipboard.kind === "cut" && parentOf(entry.path) === targetDir) {
        nextSelection.push(entry.path);
        continue;
      }
      try {
        const targetName = await findFreeName(workspaceId, targetDir, entry.name, entry.entryKind);
        const destPath = joinPath(targetDir, targetName);
        if (clipboard.kind === "cut") {
          await moveEntryTo(workspaceId, entry.path, destPath);
          onPathRenamed(entry.path, destPath);
        } else {
          await copyEntryTo(workspaceId, entry.path, destPath);
        }
        nextSelection.push(destPath);
        changed = true;
      } catch (error) {
        firstError ??= error as Error;
        nextSelection.push(entry.path);
        if (clipboard.kind === "cut") failedCutEntries.push(entry);
      }
    }
    setSelectedPaths(new Set(nextSelection));
    onSelect(nextSelection[0] ?? null);
    if (clipboard.kind === "cut") {
      setClipboard(
        failedCutEntries.length > 0 ? { kind: "cut", entries: failedCutEntries } : null,
      );
    }
    if (changed) bumpTree();
    if (firstError) {
      notify.error(t("notification.pasteFailed", { detail: firstError.message }));
    }
  };

  const onDropMove = async (srcPaths: string[], destDir: string) => {
    const sources = topLevelPaths(srcPaths);
    if (sources.some((srcPath) => isAncestorOrSelf(srcPath, destDir))) {
      notify.error(t("notification.invalidMove"));
      return;
    }
    let changed = false;
    let firstError: Error | null = null;
    const nextSelection: string[] = [];
    for (const srcPath of sources) {
      if (parentOf(srcPath) === destDir) {
        nextSelection.push(srcPath);
        continue;
      }
      const dest = joinPath(destDir, basename(srcPath));
      try {
        await moveEntryTo(workspaceId, srcPath, dest);
        onPathRenamed(srcPath, dest);
        nextSelection.push(dest);
        changed = true;
      } catch (error) {
        firstError ??= error as Error;
        nextSelection.push(srcPath);
      }
    }
    setSelectedPaths(new Set(nextSelection));
    if (nextSelection[0]) onSelect(nextSelection[0]);
    if (changed) bumpTree();
    if (firstError) {
      notify.error(t("notification.moveFailed", { detail: firstError.message }));
    }
  };

  const onDropMoveRef = useRef(onDropMove);
  onDropMoveRef.current = onDropMove;

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      treeKeyboardActiveRef.current = !!treeRootRef.current?.contains(event.target as Node);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!treeKeyboardActiveRef.current) return;
      if (!(event.target instanceof HTMLElement)) return;
      if (
        event.target !== document.body &&
        !treeRootRef.current?.contains(event.target)
      )
        return;
      if (event.target.closest("input, textarea, select, [contenteditable]")) return;
      const entries = topLevelPaths(selectedPaths)
        .map((path) => nodesByPathRef.current.get(path))
        .filter((entry): entry is FsNode => !!entry);
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "c" && entries.length > 0) {
        event.preventDefault();
        storeEntries("copy", entries);
      } else if (modifier && event.key.toLowerCase() === "x" && entries.length > 0) {
        event.preventDefault();
        storeEntries("cut", entries);
      } else if (modifier && event.key.toLowerCase() === "v" && clipboard) {
        event.preventDefault();
        const primary = selectedPath ? nodesByPathRef.current.get(selectedPath) : null;
        const targetDir = primary
          ? primary.kind === "directory"
            ? primary.path
            : parentOf(primary.path)
          : "";
        void pasteEntries(targetDir);
      } else if (event.key === "Delete" && entries.length > 0) {
        event.preventDefault();
        void deleteEntries(entries);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clipboard, selectedPath, selectedPaths]);

  useEffect(() => {
    if (!pointerDragFallback) return;

    const targetAtPoint = (x: number, y: number): string | null => {
      const element = document.elementFromPoint(x, y);
      if (!(element instanceof Element)) return null;
      const row = element.closest<HTMLElement>("[data-file-tree-node-kind]");
      if (row) {
        return row.dataset.fileTreeNodeKind === "directory"
          ? (row.dataset.fileTreeDropPath ?? null)
          : null;
      }
      return element.closest("[data-file-tree-root]") ? "" : null;
    };
    const resetPointerDrag = () => {
      const drag = pointerDragRef.current;
      if (drag?.captureElement.hasPointerCapture(drag.pointerId)) {
        drag.captureElement.releasePointerCapture(drag.pointerId);
      }
      pointerDragRef.current = null;
      setPointerDragActive(false);
      setPointerDragPaths(new Set());
      setPointerDragPreview(null);
      updatePointerTarget(null);
    };
    const finishPointerDrag = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (drag && event.pointerId !== drag.pointerId) return;
      if (!drag?.active) {
        resetPointerDrag();
        return;
      }
      const target = targetAtPoint(event.clientX, event.clientY);
      resetPointerDrag();
      if (target !== null) {
        void onDropMoveRef.current(
          drag.entries.map((entry) => entry.path),
          target,
        );
      }
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
        drag.active = true;
        suppressClickRef.current = true;
        setPointerDragActive(true);
        setPointerDragPaths(new Set(drag.entries.map((entry) => entry.path)));
        setSelectedPaths(new Set(drag.entries.map((entry) => entry.path)));
        onSelect(drag.entries[0]?.path ?? null);
      }
      event.preventDefault();
      setPointerDragPreview({ x: event.clientX, y: event.clientY, entries: drag.entries });
      updatePointerTarget(targetAtPoint(event.clientX, event.clientY));
    };
    const cancelPointerDrag = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      suppressClickRef.current = false;
      resetPointerDrag();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", finishPointerDrag);
    window.addEventListener("pointercancel", cancelPointerDrag);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", finishPointerDrag);
      window.removeEventListener("pointercancel", cancelPointerDrag);
    };
  }, [pointerDragFallback]);

  const onRootContextMenu = (e: React.MouseEvent) => {
    // Only fire if user right-clicked on the body itself, not a row.
    if (e.defaultPrevented) return;
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      ctx: {
        node: { name: workspaceName, path: "", kind: "directory" },
        selectionCount: 0,
        startRename: () => {
          /* root not renameable */
        },
        doDelete: async () => {
          /* root not deletable */
        },
        doCut: () => {
          /* root not cuttable */
        },
        doCopy: () => {
          /* root not copyable */
        },
        doPaste: () => pasteEntries(""),
        startDraft: async (kind) => {
          setDraft(kind === "folder" ? "folder" : "file");
        },
        isRoot: true,
      },
    });
  };

  const onRootDragOver = (e: React.DragEvent) => {
    if (!hasTreeDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setRootDropActive(true);
  };

  const onRootDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setRootDropActive(false);
  };

  const onRootDrop = (e: React.DragEvent) => {
    if (!hasTreeDrag(e)) return;
    e.preventDefault();
    setRootDropActive(false);
    setDropTarget(null);
    const sources = readTreeDragPaths(e);
    if (sources.length === 0) return;
    void onDropMove(sources, "");
  };

  const ctxValue: TreeContextValue = {
    workspaceId,
    treeVersion,
    bumpTree,
    selectedPaths,
    selectNode,
    registerNode,
    actionNodesFor,
    onOpenFile,
    openMenu: (x, y, ctx) => setMenu({ x, y, ctx }),
    clipboard,
    deleteEntries,
    storeEntries,
    pasteEntries,
    onPathRenamed,
    dropTarget,
    setDropTarget,
    onDropMove,
    pointerDragFallback,
    pointerDragPaths,
    beginPointerDrag,
    consumePointerClick,
    decorations,
  };

  return (
    <TreeCtx.Provider value={ctxValue}>
      <div className="side-view" onClick={clearSelection}>
        <div className="side-view__header">
          <span className="side-view__title">{workspaceName}</span>
          <span className="side-view__actions">
            <IconBtn title="新建文件" onClick={() => setDraft("file")}>
              <NewFileIcon />
            </IconBtn>
            <IconBtn title="新建文件夹" onClick={() => setDraft("folder")}>
              <NewFolderIcon />
            </IconBtn>
            <IconBtn title="刷新" onClick={bumpTree}>
              <RefreshIcon />
            </IconBtn>
          </span>
        </div>
        <div
          ref={treeRootRef}
          className={`side-view__body file-tree${rootDropActive || (pointerDragActive && dropTarget === "") ? " is-drop-target-root" : ""}${pointerDragActive ? " is-pointer-dragging" : ""}`}
          data-file-tree-root
          role="tree"
          aria-multiselectable="true"
          onClick={(event) => {
            event.stopPropagation();
            if (!(event.target as Element).closest(".tree-row")) clearSelection();
          }}
          onContextMenu={onRootContextMenu}
          onDragOver={onRootDragOver}
          onDragLeave={onRootDragLeave}
          onDrop={onRootDrop}
          onDragEnd={() => {
            setRootDropActive(false);
            setDropTarget(null);
          }}
        >
          {draft && (
            <DraftRow
              depth={0}
              kind={draft}
              onSubmit={onSubmitRootDraft}
              onCancel={() => setDraft(null)}
            />
          )}
          {children.map((n) => (
            <TreeNode key={n.path} node={n} depth={0} />
          ))}
        </div>
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            sections={buildMenuSections(menu.ctx, clipboard)}
            onClose={() => setMenu(null)}
          />
        )}
        {pointerDragPreview &&
          createPortal(
            <FileTreeDragPreview {...pointerDragPreview} />,
            document.body,
          )}
      </div>
    </TreeCtx.Provider>
  );
}

interface MenuCtx {
  node: FsNode;
  selectionCount: number;
  startRename: () => void;
  doDelete: () => Promise<void>;
  doCut: () => void;
  doCopy: () => void;
  doPaste: () => Promise<void>;
  startDraft: (kind: DraftKind) => Promise<void>;
  isRoot?: boolean;
}

function FileTreeDragPreview({ x, y, entries }: { x: number; y: number; entries: FsNode[] }) {
  const visibleEntries = entries.slice(0, 3);
  const previewWidth = 240;
  const previewHeight = visibleEntries.length * 22 + 10;
  const left = Math.max(8, Math.min(x + 14, window.innerWidth - previewWidth - 8));
  const top = Math.max(8, Math.min(y + 16, window.innerHeight - previewHeight - 8));
  return (
    <div
      className="file-tree-drag-preview"
      style={{ transform: `translate3d(${left}px, ${top}px, 0)` }}
      aria-hidden="true"
    >
      {visibleEntries.map((entry) => (
        <div className="file-tree-drag-preview__item" key={entry.path}>
          {entry.kind === "directory" ? (
            <i className="codicon codicon-folder" />
          ) : (
            <FileIcon name={entry.name} />
          )}
          <span>{entry.name}</span>
        </div>
      ))}
      {entries.length > 1 && <span className="file-tree-drag-preview__count">{entries.length}</span>}
    </div>
  );
}

interface MenuState {
  x: number;
  y: number;
  ctx: MenuCtx;
}

function buildMenuSections(ctx: MenuCtx, clipboard: ClipboardState | null): CtxMenuSection[] {
  const sections: CtxMenuSection[] = [];

  if (ctx.node.kind === "directory") {
    sections.push({
      items: [
        { label: "新建文件", onSelect: () => void ctx.startDraft("file") },
        { label: "新建文件夹", onSelect: () => void ctx.startDraft("folder") },
      ],
    });
  }

  sections.push({
    items: [
      {
        label: "剪切",
        shortcut: "Ctrl+X",
        disabled: !!ctx.isRoot,
        onSelect: ctx.doCut,
      },
      {
        label: "复制",
        shortcut: "Ctrl+C",
        disabled: !!ctx.isRoot,
        onSelect: ctx.doCopy,
      },
      {
        label: "粘贴",
        shortcut: "Ctrl+V",
        disabled: !clipboard,
        onSelect: () => void ctx.doPaste(),
      },
    ],
  });

  if (!ctx.isRoot) {
    sections.push({
      items: [
        {
          label: "重命名",
          shortcut: "F2",
          disabled: ctx.selectionCount > 1,
          onSelect: ctx.startRename,
        },
        {
          label: "删除",
          shortcut: "Delete",
          danger: true,
          onSelect: () => void ctx.doDelete(),
        },
      ],
    });
  }

  return sections;
}

interface TreeNodeProps {
  node: FsNode;
  depth: number;
}

function TreeNode({ node, depth }: TreeNodeProps) {
  const ctx = useTreeCtx();
  const { notify } = useOsheepOverlay();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsNode[] | undefined>();
  const [draft, setDraft] = useState<DraftKind | null>(null);
  const [renaming, setRenaming] = useState(false);

  useEffect(() => {
    ctx.registerNode(node);
  }, [ctx.registerNode, node]);

  const reload = async () => {
    if (node.kind !== "directory") return;
    const kids = await readDirShallow(ctx.workspaceId, node.path);
    setChildren(kids);
  };

  useEffect(() => {
    if (expanded) void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ctx.treeVersion]);

  const expand = async () => {
    if (node.kind !== "directory") return;
    if (!expanded) {
      setExpanded(true);
      if (!children) await reload();
    }
  };

  const onRowClick = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (ctx.consumePointerClick()) return;
    const additive = e.ctrlKey || e.metaKey;
    ctx.selectNode(node, additive);
    if (additive) return;
    if (node.kind === "file") {
      ctx.onOpenFile(node);
      return;
    }
    if (expanded) setExpanded(false);
    else await expand();
  };

  const startDraft = async (kind: DraftKind) => {
    if (node.kind !== "directory") return;
    await expand();
    setDraft(kind);
  };

  const onSubmitDraft = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || !draft) {
      setDraft(null);
      return;
    }
    const childPath = joinPath(node.path, trimmed);
    try {
      if (draft === "file") await createFile(ctx.workspaceId, childPath);
      else await createDirectory(ctx.workspaceId, childPath);
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setDraft(null);
      await reload();
    }
  };

  const actionNodes = () => ctx.actionNodesFor(node);
  const doDelete = async () => ctx.deleteEntries(actionNodes());

  const doCut = () => {
    ctx.storeEntries("cut", actionNodes());
  };

  const doCopy = () => {
    ctx.storeEntries("copy", actionNodes());
  };

  const doPaste = async () => {
    const targetDir = node.kind === "directory" ? node.path : parentOf(node.path);
    await ctx.pasteEntries(targetDir);
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (!ctx.selectedPaths.has(node.path)) ctx.selectNode(node, false);
    const selectionCount = ctx.selectedPaths.has(node.path) ? ctx.selectedPaths.size : 1;
    ctx.openMenu(e.clientX, e.clientY, {
      node,
      selectionCount,
      startRename: () => setRenaming(true),
      doDelete,
      doCut,
      doCopy,
      doPaste,
      startDraft,
    });
  };

  const submitRename = async (newName: string) => {
    const trimmed = newName.trim();
    if (!trimmed || trimmed === node.name) {
      setRenaming(false);
      return;
    }
    try {
      const newPath = await renameEntry(ctx.workspaceId, node.path, trimmed);
      ctx.onPathRenamed(node.path, newPath);
      ctx.bumpTree();
    } catch (err) {
      notify.error((err as Error).message);
    } finally {
      setRenaming(false);
    }
  };

  // ─── Drag & drop ───

  const onDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    const paths = actionNodes().map((entry) => entry.path);
    const encoded = encodeTreeDragPaths(paths);
    e.dataTransfer.setData(DRAG_MIME, encoded);
    e.dataTransfer.setData("text/plain", `${DRAG_TEXT_PREFIX}${encoded}`);
    e.dataTransfer.setData("text/uri-list", `${DRAG_URI_PREFIX}${encoded}`);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!hasTreeDrag(e)) return;
    if (node.kind !== "directory") return;
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = "move";
    if (ctx.dropTarget !== node.path) ctx.setDropTarget(node.path);
  };

  const onDragLeave = (e: React.DragEvent) => {
    e.stopPropagation();
    if (ctx.dropTarget === node.path) ctx.setDropTarget(null);
  };

  const onDrop = (e: React.DragEvent) => {
    if (!hasTreeDrag(e)) return;
    if (node.kind !== "directory") return;
    e.preventDefault();
    e.stopPropagation();
    const sources = readTreeDragPaths(e);
    ctx.setDropTarget(null);
    if (sources.length === 0) return;
    void ctx.onDropMove(sources, node.path);
  };

  const onPointerDown = (event: React.PointerEvent) => {
    ctx.beginPointerDrag(node, event);
  };

  const isSelected = ctx.selectedPaths.has(node.path);
  const isCut =
    ctx.clipboard?.kind === "cut" &&
    ctx.clipboard.entries.some((entry) => entry.path === node.path);
  const isPointerDragging = ctx.pointerDragPaths.has(node.path);
  const isDropTarget = ctx.dropTarget === node.path;
  const isIgnored = isIgnoredPath(ctx.decorations, node.path);

  const deco = ctx.decorations.get(node.path);
  const nameColor =
    node.kind === "file" && deco?.selfStatus ? statusColor(deco.selfStatus) : undefined;
  const dotColor =
    node.kind === "directory" && deco?.childStatus ? statusColor(deco.childStatus) : undefined;
  const badgeLetter = node.kind === "file" && deco?.selfStatus ? deco.selfStatus : null;

  return (
    <div>
      <div
        className={
          "tree-row" +
          (isSelected ? " is-selected" : "") +
          (isCut ? " is-cut" : "") +
          (isPointerDragging ? " is-pointer-dragging" : "") +
          (isIgnored ? " is-ignored" : "") +
          (isDropTarget ? " is-drop-target" : "")
        }
        style={{ paddingLeft: 8 + depth * 12 }}
        data-file-tree-node-kind={node.kind}
        data-file-tree-drop-path={node.kind === "directory" ? node.path : undefined}
        role="treeitem"
        aria-selected={isSelected}
        aria-expanded={node.kind === "directory" ? expanded : undefined}
        onClick={onRowClick}
        onPointerDown={onPointerDown}
        onContextMenu={onContextMenu}
        draggable={!renaming && !ctx.pointerDragFallback}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        onDragEnd={() => ctx.setDropTarget(null)}
      >
        <span
          className={
            "tree-row__icon" +
            (node.kind === "directory" ? " is-chevron" : "") +
            (expanded ? " is-open" : "")
          }
        >
          {node.kind === "directory" ? <ChevronIcon /> : <FileIcon name={node.name} />}
        </span>
        {renaming ? (
          <RenameInput initial={node.name} onSubmit={submitRename} />
        ) : (
          <span className="tree-row__name" style={nameColor ? { color: nameColor } : undefined}>
            {node.name}
          </span>
        )}
        {!renaming && node.kind === "directory" && (
          <span className="tree-row__actions">
            <IconBtn
              title="在此新建文件"
              onClick={(e) => {
                e.stopPropagation();
                void startDraft("file");
              }}
            >
              <NewFileIcon />
            </IconBtn>
            <IconBtn
              title="在此新建文件夹"
              onClick={(e) => {
                e.stopPropagation();
                void startDraft("folder");
              }}
            >
              <NewFolderIcon />
            </IconBtn>
          </span>
        )}
        {!renaming && (badgeLetter || dotColor) && (
          <span
            className={
              "tree-row__badge" +
              (badgeLetter ? " tree-row__badge--letter" : " tree-row__badge--dot")
            }
            style={{ color: nameColor ?? dotColor }}
            title={badgeLetter ? `Git: ${badgeLetter}` : `Git 变更: ${deco?.childStatus}`}
          >
            {badgeLetter ?? "●"}
          </span>
        )}
      </div>
      {expanded && (
        <div
          className="tree-children"
          style={{ "--guide-x": `${8 + depth * 12 + 8}px` } as CSSProperties}
        >
          {draft && (
            <DraftRow
              depth={depth + 1}
              kind={draft}
              onSubmit={onSubmitDraft}
              onCancel={() => setDraft(null)}
            />
          )}
          {children?.map((c) => (
            <TreeNode key={c.path} node={c} depth={depth + 1} />
          ))}
        </div>
      )}
    </div>
  );
}

function RenameInput({ initial, onSubmit }: { initial: string; onSubmit: (name: string) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.focus();
    const dot = initial.lastIndexOf(".");
    if (dot > 0) el.setSelectionRange(0, dot);
    else el.select();
  }, [initial]);

  return (
    <input
      ref={ref}
      className="tree-row__input"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === "Enter") onSubmit(value);
        else if (e.key === "Escape") onSubmit(initial);
      }}
      onBlur={() => onSubmit(value)}
    />
  );
}

function DraftRow({
  depth,
  kind,
  onSubmit,
  onCancel,
}: {
  depth: number;
  kind: DraftKind;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div className="tree-row tree-row--draft" style={{ paddingLeft: 8 + depth * 12 }}>
      <span className={`tree-row__icon${kind === "folder" ? " is-chevron" : ""}`}>
        {kind === "folder" ? <ChevronIcon /> : <FileIcon name={value || "new"} />}
      </span>
      <input
        ref={inputRef}
        className="tree-row__input"
        value={value}
        placeholder={kind === "folder" ? "新建文件夹" : "新建文件"}
        onChange={(e) => setValue(e.target.value)}
        onClick={(e) => e.stopPropagation()}
        onKeyDown={(e) => {
          if (e.key === "Enter") onSubmit(value);
          else if (e.key === "Escape") onCancel();
        }}
        onBlur={() => onSubmit(value)}
      />
    </div>
  );
}

function IconBtn({
  title,
  onClick,
  children,
}: {
  title: string;
  onClick: (e: React.MouseEvent) => void;
  children: React.ReactNode;
}) {
  return (
    <button className="icon-btn" title={title} onClick={onClick} type="button">
      {children}
    </button>
  );
}

function ChevronIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="currentColor" aria-hidden="true">
      <path d="M6 3.5l5 4.5-5 4.5V3.5z" />
    </svg>
  );
}

function NewFileIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    >
      <path d="M9 1.5H4a1 1 0 0 0-1 1v11a1 1 0 0 0 1 1h8a1 1 0 0 0 1-1V5.5L9 1.5z" />
      <path d="M9 1.5V5.5h4" />
      <path d="M8 8v4M6 10h4" strokeLinecap="round" />
    </svg>
  );
}

function NewFolderIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.2"
      strokeLinejoin="round"
    >
      <path d="M1.5 3.5a1 1 0 0 1 1-1H6l2 2h5.5a1 1 0 0 1 1 1V12a1 1 0 0 1-1 1h-11a1 1 0 0 1-1-1V3.5z" />
      <path d="M8 6.5v4M6 8.5h4" strokeLinecap="round" />
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
      strokeWidth="1.3"
      strokeLinecap="round"
    >
      <path d="M3 8a5 5 0 0 1 9-3" />
      <path d="M13 8a5 5 0 0 1-9 3" />
      <path d="M12 2v3h-3M4 14v-3h3" strokeLinejoin="round" />
    </svg>
  );
}
