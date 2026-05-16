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
  copyHandleInto,
  createDirectory,
  createFile,
  findFreeName,
  moveHandleInto,
  readDirShallow,
  removeEntry,
  renameEntry,
} from "./fs";

type DraftKind = "file" | "folder";

interface ClipboardItem {
  kind: "copy" | "cut";
  parentDir: FileSystemDirectoryHandle;
  handle: FileSystemHandle;
  name: string;
  path: string;
}

interface TreeContextValue {
  treeVersion: number;
  bumpTree: () => void;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onOpenFile: (node: FsNode, parentDir: FileSystemDirectoryHandle) => void;
  openMenu: (x: number, y: number, ctx: MenuCtx) => void;
  clipboard: ClipboardItem | null;
  setClipboard: (c: ClipboardItem | null) => void;
  onPathRenamed: (oldPath: string, newPath: string) => void;
  onPathDeleted: (path: string) => void;
}

const TreeCtx = createContext<TreeContextValue | null>(null);
const useTreeCtx = () => {
  const v = useContext(TreeCtx);
  if (!v) throw new Error("TreeCtx missing");
  return v;
};

interface FileTreeProps {
  rootHandle: FileSystemDirectoryHandle;
  selectedPath: string | null;
  onSelect: (path: string | null) => void;
  onOpenFile: (node: FsNode, parentDir: FileSystemDirectoryHandle) => void;
  onPathRenamed: (oldPath: string, newPath: string) => void;
  onPathDeleted: (path: string) => void;
}

export function FileTree({
  rootHandle,
  selectedPath,
  onSelect,
  onOpenFile,
  onPathRenamed,
  onPathDeleted,
}: FileTreeProps) {
  const [children, setChildren] = useState<FsNode[]>([]);
  const [draft, setDraft] = useState<DraftKind | null>(null);
  const [treeVersion, setTreeVersion] = useState(0);
  const [menu, setMenu] = useState<MenuState | null>(null);
  const [clipboard, setClipboard] = useState<ClipboardItem | null>(null);

  const reload = async () => {
    const kids = await readDirShallow(rootHandle, "");
    setChildren(kids);
  };

  useEffect(() => {
    void reload();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootHandle, treeVersion]);

  const bumpTree = () => setTreeVersion((v) => v + 1);

  const onSubmitRootDraft = async (name: string) => {
    const trimmed = name.trim();
    if (!trimmed || !draft) {
      setDraft(null);
      return;
    }
    try {
      if (draft === "file") await createFile(rootHandle, trimmed);
      else await createDirectory(rootHandle, trimmed);
    } finally {
      setDraft(null);
      bumpTree();
    }
  };

  const ctxValue: TreeContextValue = {
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
  };

  return (
    <TreeCtx.Provider value={ctxValue}>
      <div className="side-view" onClick={() => onSelect(null)}>
        <div className="side-view__header">
          <span className="side-view__title">{rootHandle.name}</span>
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
          className="side-view__body file-tree"
          onClick={(e) => e.stopPropagation()}
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
            <TreeNode
              key={n.path}
              node={n}
              parentDir={rootHandle}
              depth={0}
            />
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
  parentDir: FileSystemDirectoryHandle;
  startRename: () => void;
  doDelete: () => Promise<void>;
  doCut: () => void;
  doCopy: () => void;
  doPaste: () => Promise<void>;
  startDraft: (kind: DraftKind) => Promise<void>;
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
      { label: "剪切", shortcut: "Ctrl+X", onSelect: ctx.doCut },
      { label: "复制", shortcut: "Ctrl+C", onSelect: ctx.doCopy },
      {
        label: "粘贴",
        shortcut: "Ctrl+V",
        disabled: !clipboard,
        onSelect: () => void ctx.doPaste(),
      },
    ],
  });

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

  return sections;
}

interface TreeNodeProps {
  node: FsNode;
  parentDir: FileSystemDirectoryHandle;
  depth: number;
}

function TreeNode({ node, parentDir, depth }: TreeNodeProps) {
  const ctx = useTreeCtx();
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<FsNode[] | undefined>();
  const [draft, setDraft] = useState<DraftKind | null>(null);
  const [renaming, setRenaming] = useState(false);

  const reload = async () => {
    if (node.kind !== "directory") return;
    const kids = await readDirShallow(
      node.handle as FileSystemDirectoryHandle,
      node.path
    );
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
      ctx.onOpenFile(node, parentDir);
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
    const dir = node.handle as FileSystemDirectoryHandle;
    try {
      if (draft === "file") await createFile(dir, trimmed);
      else await createDirectory(dir, trimmed);
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
    await removeEntry(parentDir, node.name);
    ctx.onPathDeleted(node.path);
    ctx.bumpTree();
  };

  const doCut = () => {
    ctx.setClipboard({
      kind: "cut",
      parentDir,
      handle: node.handle,
      name: node.name,
      path: node.path,
    });
  };

  const doCopy = () => {
    ctx.setClipboard({
      kind: "copy",
      parentDir,
      handle: node.handle,
      name: node.name,
      path: node.path,
    });
  };

  const doPaste = async () => {
    const cb = ctx.clipboard;
    if (!cb) return;
    const targetDir =
      node.kind === "directory"
        ? (node.handle as FileSystemDirectoryHandle)
        : parentDir;
    const targetDirPath =
      node.kind === "directory"
        ? node.path
        : node.path.includes("/")
        ? node.path.slice(0, node.path.lastIndexOf("/"))
        : "";
    if (cb.kind === "cut" && cb.parentDir === targetDir) {
      ctx.setClipboard(null);
      return;
    }
    try {
      const targetName = await findFreeName(
        targetDir,
        cb.name,
        cb.handle.kind as "file" | "directory"
      );
      if (cb.kind === "cut") {
        await moveHandleInto(
          cb.handle,
          cb.parentDir,
          cb.name,
          targetDir,
          targetName
        );
        const destPath = targetDirPath
          ? `${targetDirPath}/${targetName}`
          : targetName;
        ctx.onPathRenamed(cb.path, destPath);
      } else {
        await copyHandleInto(cb.handle, targetDir, targetName);
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
      parentDir,
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
      await renameEntry(parentDir, node.handle, node.name, trimmed);
      const lastSlash = node.path.lastIndexOf("/");
      const parentPath = lastSlash >= 0 ? node.path.slice(0, lastSlash) : "";
      const newPath = parentPath ? `${parentPath}/${trimmed}` : trimmed;
      ctx.onPathRenamed(node.path, newPath);
      ctx.bumpTree();
    } catch (err) {
      window.alert((err as Error).message);
    } finally {
      setRenaming(false);
    }
  };

  const isSelected = ctx.selectedPath === node.path;
  const isCut = ctx.clipboard?.kind === "cut" && ctx.clipboard.path === node.path;

  return (
    <div>
      <div
        className={
          "tree-row" +
          (isSelected ? " is-selected" : "") +
          (isCut ? " is-cut" : "")
        }
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={onRowClick}
        onContextMenu={onContextMenu}
      >
        <span className={"tree-row__chevron" + (expanded ? " is-open" : "")}>
          {node.kind === "directory" ? <ChevronIcon /> : null}
        </span>
        {node.kind === "file" && (
          <span className="tree-row__type-icon">
            <FileIcon name={node.name} />
          </span>
        )}
        {renaming ? (
          <RenameInput initial={node.name} onSubmit={submitRename} />
        ) : (
          <span className="tree-row__name">{node.name}</span>
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
      </div>
      {expanded && (
        <div
          className="tree-children"
          style={
            { "--guide-x": `${8 + depth * 12 + 7}px` } as CSSProperties
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
            <TreeNode
              key={c.path}
              node={c}
              parentDir={node.handle as FileSystemDirectoryHandle}
              depth={depth + 1}
            />
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
      <span className="tree-row__chevron">
        {kind === "folder" ? <ChevronIcon /> : null}
      </span>
      {kind === "file" && (
        <span className="tree-row__type-icon">
          <FileIcon name={value || "new"} />
        </span>
      )}
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
