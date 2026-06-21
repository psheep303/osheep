import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
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
import { statusColor, type FileDecoration } from "./git-decorations";

type DraftKind = "file" | "folder";

interface ClipboardItem {
  kind: "copy" | "cut";
  path: string;
  name: string;
  entryKind: "file" | "directory";
}

interface TreeContextValue {
  workspaceId: string;
  treeVersion: number;
  bumpTree: () => void;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onOpenFile: (node: FsNode) => void;
  openMenu: (x: number, y: number, ctx: MenuCtx) => void;
  clipboard: ClipboardItem | null;
  setClipboard: (c: ClipboardItem | null) => void;
  onPathRenamed: (oldPath: string, newPath: string) => void;
  onPathDeleted: (path: string) => void;
  dropTarget: string | null;
  setDropTarget: (path: string | null) => void;
  onDropMove: (srcPath: string, destDir: string) => Promise<void>;
  decorations: Map<string, FileDecoration>;
}

const TreeCtx = createContext<TreeContextValue | null>(null);
const useTreeCtx = () => {
  const v = useContext(TreeCtx);
  if (!v) throw new Error("TreeCtx missing");
  return v;
};

const DRAG_MIME = "application/x-osheep-path";

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
  return parent + "/" + name;
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
  return (
    maybeAncestor === descendant ||
    descendant.startsWith(maybeAncestor + "/")
  );
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
  const [children, setChildren] = useState<FsNode[]>([]);
  const [draft, setDraft] = useState<DraftKind | null>(null);
  const [treeVersion, setTreeVersion] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [rootDropActive, setRootDropActive] = useState(false);

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
      window.alert((err as Error).message);
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

  const doRootPaste = async () => {
    if (!clipboard) return;
    try {
      const targetName = await findFreeName(
        workspaceId,
        "",
        clipboard.name,
        clipboard.entryKind
      );
      if (clipboard.kind === "cut") {
        if (parentOf(clipboard.path) === "") {
          setClipboard(null);
          return;
        }
        await moveEntryTo(workspaceId, clipboard.path, targetName);
        onPathRenamed(clipboard.path, targetName);
      } else {
        await copyEntryTo(workspaceId, clipboard.path, targetName);
      }
      setClipboard(null);
      bumpTree();
    } catch (err) {
      window.alert("粘贴失败：" + (err as Error).message);
    }
  };

  const onDropMove = async (srcPath: string, destDir: string) => {
    if (isAncestorOrSelf(srcPath, joinPath(destDir, basename(srcPath)))) {
      // Don't move a folder into itself / its descendant
      window.alert("不能把文件夹移动到它自己或其子目录里");
      return;
    }
    if (parentOf(srcPath) === destDir) return; // already there
    try {
      const targetName = basename(srcPath);
      const dest = joinPath(destDir, targetName);
      await moveEntryTo(workspaceId, srcPath, dest);
      onPathRenamed(srcPath, dest);
      bumpTree();
    } catch (err) {
      window.alert("移动失败：" + (err as Error).message);
    }
  };

  const onRootContextMenu = (e: React.MouseEvent) => {
    // Only fire if user right-clicked on the body itself, not a row.
    if (e.defaultPrevented) return;
    e.preventDefault();
    setMenu({
      x: e.clientX,
      y: e.clientY,
      ctx: {
        node: { name: workspaceName, path: "", kind: "directory" },
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
        doPaste: doRootPaste,
        startDraft: async (kind) => {
          setDraft(kind === "folder" ? "folder" : "file");
        },
        isRoot: true,
      },
    });
  };

  const onRootDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setRootDropActive(true);
  };

  const onRootDragLeave = (e: React.DragEvent) => {
    if (e.currentTarget === e.target) setRootDropActive(false);
  };

  const onRootDrop = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    e.preventDefault();
    setRootDropActive(false);
    setDropTarget(null);
    const src = e.dataTransfer.getData(DRAG_MIME);
    if (!src) return;
    void onDropMove(src, "");
  };

  const ctxValue: TreeContextValue = {
    workspaceId,
    treeVersion,
    bumpTree,
    selectedPath,
    onSelect,
    onOpenFile,
    openMenu: (x, y, ctx) => setMenu({ x, y, ctx }),
    clipboard,
    setClipboard,
    onPathRenamed,
    onPathDeleted,
    dropTarget,
    setDropTarget,
    onDropMove,
    decorations,
  };

  return (
    <TreeCtx.Provider value={ctxValue}>
      <div className="side-view" onClick={() => onSelect(null)}>
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
          className={
            "side-view__body file-tree" +
            (rootDropActive ? " is-drop-target-root" : "")
          }
          onClick={(e) => e.stopPropagation()}
          onContextMenu={onRootContextMenu}
          onDragOver={onRootDragOver}
          onDragLeave={onRootDragLeave}
          onDrop={onRootDrop}
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
      </div>
    </TreeCtx.Provider>
  );
}

interface MenuCtx {
  node: FsNode;
  startRename: () => void;
  doDelete: () => Promise<void>;
  doCut: () => void;
  doCopy: () => void;
  doPaste: () => Promise<void>;
  startDraft: (kind: DraftKind) => Promise<void>;
  isRoot?: boolean;
}

interface MenuState {
  x: number;
  y: number;
  ctx: MenuCtx;
}

function buildMenuSections(
  ctx: MenuCtx,
  clipboard: ClipboardItem | null
): CtxMenuSection[] {
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
        { label: "重命名", shortcut: "F2", onSelect: ctx.startRename },
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
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsNode[] | undefined>();
  const [draft, setDraft] = useState<DraftKind | null>(null);
  const [renaming, setRenaming] = useState(false);

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
    ctx.onSelect(node.path);
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
      window.alert((err as Error).message);
    } finally {
      setDraft(null);
      await reload();
    }
  };

  const doDelete = async () => {
    const ok = window.confirm(
      `确定要删除 "${node.name}" 吗？此操作不可撤销。`
    );
    if (!ok) return;
    try {
      await removeEntry(ctx.workspaceId, node.path);
      ctx.onPathDeleted(node.path);
      ctx.bumpTree();
    } catch (err) {
      window.alert((err as Error).message);
    }
  };

  const doCut = () => {
    ctx.setClipboard({
      kind: "cut",
      path: node.path,
      name: node.name,
      entryKind: node.kind,
    });
  };

  const doCopy = () => {
    ctx.setClipboard({
      kind: "copy",
      path: node.path,
      name: node.name,
      entryKind: node.kind,
    });
  };

  const doPaste = async () => {
    const cb = ctx.clipboard;
    if (!cb) return;
    const targetDir =
      node.kind === "directory" ? node.path : parentOf(node.path);
    if (cb.kind === "cut" && parentOf(cb.path) === targetDir) {
      ctx.setClipboard(null);
      return;
    }
    try {
      const targetName = await findFreeName(
        ctx.workspaceId,
        targetDir,
        cb.name,
        cb.entryKind
      );
      const destPath = joinPath(targetDir, targetName);
      if (cb.kind === "cut") {
        await moveEntryTo(ctx.workspaceId, cb.path, destPath);
        ctx.onPathRenamed(cb.path, destPath);
      } else {
        await copyEntryTo(ctx.workspaceId, cb.path, destPath);
      }
      ctx.setClipboard(null);
      ctx.bumpTree();
    } catch (err) {
      window.alert("粘贴失败：" + (err as Error).message);
    }
  };

  const onContextMenu = (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    ctx.onSelect(node.path);
    ctx.openMenu(e.clientX, e.clientY, {
      node,
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
      window.alert((err as Error).message);
    } finally {
      setRenaming(false);
    }
  };

  // ─── Drag & drop ───

  const onDragStart = (e: React.DragEvent) => {
    e.stopPropagation();
    e.dataTransfer.setData(DRAG_MIME, node.path);
    e.dataTransfer.setData("text/plain", node.path);
    e.dataTransfer.effectAllowed = "move";
  };

  const onDragOver = (e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
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
    if (!e.dataTransfer.types.includes(DRAG_MIME)) return;
    if (node.kind !== "directory") return;
    e.preventDefault();
    e.stopPropagation();
    const src = e.dataTransfer.getData(DRAG_MIME);
    ctx.setDropTarget(null);
    if (!src) return;
    void ctx.onDropMove(src, node.path);
  };

  const isSelected = ctx.selectedPath === node.path;
  const isCut = ctx.clipboard?.kind === "cut" && ctx.clipboard.path === node.path;
  const isDropTarget = ctx.dropTarget === node.path;

  const deco = ctx.decorations.get(node.path);
  const nameColor =
    node.kind === "file" && deco?.selfStatus
      ? statusColor(deco.selfStatus)
      : undefined;
  const dotColor =
    node.kind === "directory" && deco?.childStatus
      ? statusColor(deco.childStatus)
      : undefined;
  const badgeLetter =
    node.kind === "file" && deco?.selfStatus ? deco.selfStatus : null;

  return (
    <div>
      <div
        className={
          "tree-row" +
          (isSelected ? " is-selected" : "") +
          (isCut ? " is-cut" : "") +
          (isDropTarget ? " is-drop-target" : "")
        }
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={onRowClick}
        onContextMenu={onContextMenu}
        draggable={!renaming}
        onDragStart={onDragStart}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <span
          className={
            "tree-row__icon" +
            (node.kind === "directory" ? " is-chevron" : "") +
            (expanded ? " is-open" : "")
          }
        >
          {node.kind === "directory" ? (
            <ChevronIcon />
          ) : (
            <FileIcon name={node.name} />
          )}
        </span>
        {renaming ? (
          <RenameInput initial={node.name} onSubmit={submitRename} />
        ) : (
          <span
            className="tree-row__name"
            style={nameColor ? { color: nameColor } : undefined}
          >
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
            title={
              badgeLetter
                ? `Git: ${badgeLetter}`
                : `Git 变更: ${deco?.childStatus}`
            }
          >
            {badgeLetter ?? "●"}
          </span>
        )}
      </div>
      {expanded && (
        <div
          className="tree-children"
          style={
            { "--guide-x": `${8 + depth * 12 + 8}px` } as CSSProperties
          }
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

function RenameInput({
  initial,
  onSubmit,
}: {
  initial: string;
  onSubmit: (name: string) => void;
}) {
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
    <div
      className="tree-row tree-row--draft"
      style={{ paddingLeft: 8 + depth * 12 }}
    >
      <span
        className={
          "tree-row__icon" + (kind === "folder" ? " is-chevron" : "")
        }
      >
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
    <svg
      viewBox="0 0 16 16"
      width="14"
      height="14"
      fill="currentColor"
      aria-hidden="true"
    >
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
