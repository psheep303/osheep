import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useUiPreferences } from "../i18n/UiPreferences";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
import { isWindowsDesktopShell } from "./desktop-folder-picker";
import { FileIcon } from "./FileIcon";
import {
  copyEntryTo,
  createDirectory,
  createFile,
  DOCS_DIR,
  type FsNode,
  findFreeImageName,
  findFreeName,
  moveEntryTo,
  readDirShallow,
  readFileText,
  removeEntry,
  renameEntry,
  writeFileBase64,
  writeFileText,
} from "./fs";
import { useOsheepOverlay } from "./OsheepOverlay";

const EditorPane = lazy(() =>
  import("./EditorPane").then((module) => ({ default: module.EditorPane })),
);
const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })),
);

interface PlanViewProps {
  workspaceId: string | null;
  refreshSignal?: number;
  editorFontSize?: number;
  editorTabSize?: number;
  autoSave?: boolean;
  onDocsChanged?: () => void;
}

interface DocsClipboardEntry {
  path: string;
  name: string;
  kind: FsNode["kind"];
}

interface DocsClipboard {
  entries: DocsClipboardEntry[];
}

const DOCS_DRAG_MIME = "application/x-osheep-doc-path";
const DOCS_DRAG_KIND_MIME = "application/x-osheep-doc-kind";
const DOCS_DRAG_TEXT_PREFIX = "osheep-doc-path:";
const DOCS_DRAG_KIND_PREFIX = "osheep-doc-kind:";

function hasDocsDrag(event: React.DragEvent): boolean {
  return (
    event.dataTransfer.types.includes(DOCS_DRAG_MIME) ||
    event.dataTransfer.types.includes("text/plain")
  );
}

function encodeDocsDrag(entries: FsNode[]): string {
  return JSON.stringify(entries.map(({ path, name, kind }) => ({ path, name, kind })));
}

function decodeDocsDrag(value: string, kind = "file"): FsNode[] {
  if (!value) return [];
  try {
    const parsed: unknown = JSON.parse(value);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (entry): entry is FsNode =>
          !!entry &&
          typeof entry === "object" &&
          "path" in entry &&
          typeof entry.path === "string" &&
          "name" in entry &&
          typeof entry.name === "string" &&
          "kind" in entry &&
          (entry.kind === "file" || entry.kind === "directory"),
      );
    }
  } catch {
    // Accept drag data written by older single-path clients.
  }
  return [
    { path: value, name: basename(value), kind: kind === "directory" ? "directory" : "file" },
  ];
}

function readDocsDrag(event: React.DragEvent): FsNode[] {
  const text = event.dataTransfer.getData("text/plain");
  const uri = event.dataTransfer.getData("text/uri-list");
  const encoded =
    event.dataTransfer.getData(DOCS_DRAG_MIME) ||
    (text.startsWith(DOCS_DRAG_TEXT_PREFIX) ? text.slice(DOCS_DRAG_TEXT_PREFIX.length) : "");
  const kind =
    event.dataTransfer.getData(DOCS_DRAG_KIND_MIME) ||
    (uri.startsWith(DOCS_DRAG_KIND_PREFIX) ? uri.slice(DOCS_DRAG_KIND_PREFIX.length) : "");
  return decodeDocsDrag(encoded, kind);
}

interface DocsMenu {
  x: number;
  y: number;
  node: FsNode | null;
}

interface DocsPointerDragController {
  enabled: boolean;
  sourcePaths: ReadonlySet<string>;
  targetPath: string | null;
  entriesFor: (node: FsNode) => FsNode[];
  begin: (event: React.PointerEvent, node: FsNode) => void;
  consumeClick: () => boolean;
}

function isPathWithin(path: string, parent: string): boolean {
  return path === parent || path.startsWith(`${parent}/`);
}

function remapPath(path: string, oldPath: string, newPath: string): string {
  return path === oldPath ? newPath : `${newPath}${path.slice(oldPath.length)}`;
}

function markdownFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}

function docsEntries(entries: FsNode[]): FsNode[] {
  return entries
    .filter((entry) => entry.kind === "directory" || /\.md$/i.test(entry.name))
    .sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "directory" ? -1 : 1;
      return a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: "base" });
    });
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function parentOf(path: string): string {
  const index = path.lastIndexOf("/");
  return index >= 0 ? path.slice(0, index) : "";
}

function topLevelDocsEntries(entries: FsNode[]): FsNode[] {
  const unique = new Map(entries.map((entry) => [entry.path, entry]));
  return [...unique.values()].filter(
    (entry) =>
      ![...unique.keys()].some(
        (parent) => parent !== entry.path && isPathWithin(entry.path, parent),
      ),
  );
}

export function PlanView({
  workspaceId,
  refreshSignal = 0,
  editorFontSize = 14,
  editorTabSize = 2,
  autoSave = false,
  onDocsChanged,
}: PlanViewProps) {
  const { t } = useUiPreferences();
  const { confirm, notify } = useOsheepOverlay();
  const [entriesByDir, setEntriesByDir] = useState<Record<string, FsNode[]>>({});
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());
  const [loadingDirs, setLoadingDirs] = useState<Set<string>>(new Set());
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [selectedDirectory, setSelectedDirectory] = useState<string | null>(null);
  const [selectedTreePaths, setSelectedTreePaths] = useState<Set<string>>(new Set());
  const docsNodesRef = useRef(new Map<string, FsNode>());
  const docsTreeRef = useRef<HTMLDivElement>(null);
  const docsKeyboardActiveRef = useRef(false);
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [previewMode, setPreviewMode] = useState(true);
  const [creating, setCreating] = useState(false);
  const [creatingKind, setCreatingKind] = useState<"file" | "directory">("file");
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<DocsClipboard | null>(null);
  const [menu, setMenu] = useState<DocsMenu | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
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
  const [pointerDropTarget, setPointerDropTarget] = useState<string | null>(null);
  const [pointerDragPreview, setPointerDragPreview] = useState<{
    x: number;
    y: number;
    entries: FsNode[];
  } | null>(null);
  const suppressPointerClickRef = useRef(false);
  const dirty = content !== savedContent;
  const startCreating = (kind: "file" | "directory") => {
    setCreatingKind(kind);
    setCreating(true);
  };

  useEffect(() => {
    setEntriesByDir({});
    setExpandedPaths(new Set());
    setSelectedPath(null);
    setSelectedDirectory(null);
    setSelectedTreePaths(new Set());
    docsNodesRef.current.clear();
    setContent("");
    setSavedContent("");
    setMenu(null);
    setRenamingPath(null);
  }, [workspaceId]);

  useEffect(() => {
    if (!selectedPath) return;
    setSelectedTreePaths((current) => (current.size === 0 ? new Set([selectedPath]) : current));
  }, [selectedPath]);

  const refreshDocs = useCallback(() => {
    setRefreshVersion((version) => version + 1);
    onDocsChanged?.();
  }, [onDocsChanged]);

  useEffect(() => {
    if (!workspaceId) {
      setEntriesByDir({});
      setExpandedPaths(new Set());
      setSelectedPath(null);
      setSelectedDirectory(null);
      setContent("");
      setSavedContent("");
      return;
    }
    let cancelled = false;
    const directories = [DOCS_DIR, ...expandedPaths];
    setLoadingDirs(new Set(directories));
    void Promise.all(
      directories.map(async (dir) => [dir, await readDirShallow(workspaceId, dir)] as const),
    )
      .then((loaded) => {
        if (cancelled) return;
        setEntriesByDir((current) => {
          const next = { ...current };
          for (const [dir, entries] of loaded) next[dir] = entries;
          return next;
        });
        setSelectedPath((current) => {
          if (current) return current;
          const firstRootDocument = docsEntries(
            loaded.find(([dir]) => dir === DOCS_DIR)?.[1] ?? [],
          ).find((entry) => entry.kind === "file");
          return firstRootDocument?.path ?? null;
        });
        setLoadingDirs(new Set());
        setError(null);
      })
      .catch((reason) => {
        if (!cancelled) {
          setLoadingDirs(new Set());
          const message = t("error.loadDocs", { detail: (reason as Error).message });
          setError(null);
          notify.error(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [expandedPaths, notify, refreshSignal, refreshVersion, t, workspaceId]);

  useEffect(() => {
    if (!workspaceId || !selectedPath) {
      setContent("");
      setSavedContent("");
      return;
    }
    let cancelled = false;
    void readFileText(workspaceId, selectedPath)
      .then((text) => {
        if (cancelled) return;
        setContent(text);
        setSavedContent(text);
        setError(null);
      })
      .catch((reason) => {
        if (!cancelled) {
          const message = t("error.loadDocs", { detail: (reason as Error).message });
          setError(null);
          notify.error(message);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [notify, workspaceId, selectedPath, t]);

  const saveDocument = useCallback(async () => {
    if (!workspaceId || !selectedPath || content === savedContent) return;
    setSaving(true);
    try {
      await writeFileText(workspaceId, selectedPath, content);
      setSavedContent(content);
      setError(null);
      onDocsChanged?.();
    } catch (reason) {
      const message = t("error.writeFile", { detail: (reason as Error).message });
      setError(message);
      notify.error(message);
      throw reason;
    } finally {
      setSaving(false);
    }
  }, [content, notify, onDocsChanged, savedContent, selectedPath, t, workspaceId]);

  useEffect(() => {
    if (!autoSave || !dirty) return;
    const timer = window.setTimeout(() => void saveDocument().catch(() => undefined), 450);
    return () => window.clearTimeout(timer);
  }, [autoSave, dirty, saveDocument]);

  const selectDocument = async (path: string) => {
    if (path === selectedPath) return;
    if (dirty) {
      try {
        await saveDocument();
      } catch {
        return;
      }
    }
    setPreviewMode(true);
    setSelectedPath(path);
  };

  const registerDocsNode = useCallback((node: FsNode) => {
    docsNodesRef.current.set(node.path, node);
  }, []);
  const selectedEntriesFor = (node: FsNode): FsNode[] => {
    if (!selectedTreePaths.has(node.path)) return [node];
    return topLevelDocsEntries(
      [...selectedTreePaths]
        .map((path) => docsNodesRef.current.get(path))
        .filter((entry): entry is FsNode => !!entry),
    );
  };
  const currentSelectedEntries = (): FsNode[] =>
    topLevelDocsEntries(
      [...selectedTreePaths]
        .map((path) => docsNodesRef.current.get(path))
        .filter((entry): entry is FsNode => !!entry),
    );
  const selectTreeNode = (node: FsNode, additive: boolean) => {
    registerDocsNode(node);
    if (additive) {
      const next = new Set(selectedTreePaths);
      if (next.has(node.path)) next.delete(node.path);
      else next.add(node.path);
      setSelectedTreePaths(next);
      return;
    }
    setSelectedTreePaths(new Set([node.path]));
    if (node.kind === "directory") {
      setSelectedDirectory(node.path);
      toggleDirectory(node.path);
    } else {
      setSelectedDirectory(parentOf(node.path));
      void selectDocument(node.path);
    }
  };

  const togglePreview = async () => {
    if (!previewMode && dirty) {
      try {
        await saveDocument();
      } catch {
        return;
      }
    }
    setPreviewMode((current) => !current);
  };

  const pasteImageIntoDocument = useCallback(
    async (file: File): Promise<string | null> => {
      try {
        if (!workspaceId || !selectedPath) return null;
        const slash = selectedPath.lastIndexOf("/");
        const dir = slash >= 0 ? selectedPath.slice(0, slash) : "";
        const subtype = file.type.split("/")[1]?.toLowerCase() ?? "png";
        const extension =
          ({ jpeg: "jpg", "svg+xml": "svg", "x-icon": "ico" } as Record<string, string>)[subtype] ??
          subtype;
        const name = await findFreeImageName(workspaceId, dir, extension);
        const bytes = new Uint8Array(await file.arrayBuffer());
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await writeFileBase64(workspaceId, dir ? `${dir}/${name}` : name, btoa(binary));
        refreshDocs();
        return `\n\n![alt text](${name})`;
      } catch (reason) {
        notify.error(t("error.writeFile", { detail: (reason as Error).message }));
        return null;
      }
    },
    [notify, refreshDocs, selectedPath, t, workspaceId],
  );

  const createDocument = async (rawName: string, targetDir = selectedDirectory ?? DOCS_DIR) => {
    setCreating(false);
    if (!workspaceId) return;
    const requestedName = markdownFileName(rawName);
    if (!requestedName) return;
    try {
      if (dirty) await saveDocument();
      const name = await findFreeName(workspaceId, targetDir, requestedName, "file");
      const path = `${targetDir}/${name}`;
      await createFile(workspaceId, path);
      setPreviewMode(false);
      setSelectedPath(path);
      setSelectedTreePaths(new Set([path]));
      refreshDocs();
    } catch (reason) {
      notify.error((reason as Error).message);
    }
  };

  const createFolder = async (rawName: string, targetDir = selectedDirectory ?? DOCS_DIR) => {
    setCreating(false);
    if (!workspaceId) return;
    const name = rawName.trim();
    if (!name) return;
    try {
      const freeName = await findFreeName(workspaceId, targetDir, name, "directory");
      await createDirectory(workspaceId, `${targetDir}/${freeName}`);
      setExpandedPaths((current) => new Set(current).add(targetDir));
      refreshDocs();
    } catch (reason) {
      notify.error((reason as Error).message);
    }
  };

  const moveDocuments = async (sourceEntries: FsNode[], targetDir: string) => {
    if (!workspaceId) return;
    const entries = topLevelDocsEntries(sourceEntries);
    if (
      entries.some(
        (entry) =>
          entry.kind === "directory" &&
          (entry.path === targetDir || targetDir.startsWith(`${entry.path}/`)),
      )
    ) {
      notify.error(t("notification.invalidMove"));
      return;
    }
    if (dirty && selectedPath && entries.some((entry) => isPathWithin(selectedPath, entry.path))) {
      try {
        await saveDocument();
      } catch {
        return;
      }
    }
    const moved: Array<{ oldPath: string; newPath: string }> = [];
    const nextSelection: string[] = [];
    let firstError: Error | null = null;
    for (const entry of entries) {
      if (parentOf(entry.path) === targetDir) {
        nextSelection.push(entry.path);
        continue;
      }
      try {
        const name = await findFreeName(workspaceId, targetDir, entry.name, entry.kind);
        const nextPath = `${targetDir}/${name}`;
        await moveEntryTo(workspaceId, entry.path, nextPath);
        moved.push({ oldPath: entry.path, newPath: nextPath });
        nextSelection.push(nextPath);
      } catch (reason) {
        firstError ??= reason as Error;
        nextSelection.push(entry.path);
      }
    }
    if (moved.length > 0) {
      const remapMovedPath = (path: string): string => {
        const match = moved.find(({ oldPath }) => isPathWithin(path, oldPath));
        return match ? remapPath(path, match.oldPath, match.newPath) : path;
      };
      setSelectedPath((current) => (current ? remapMovedPath(current) : null));
      setSelectedDirectory((current) => (current ? remapMovedPath(current) : null));
      if (clipboard) {
        setClipboard({
          entries: clipboard.entries.map((entry) => ({
            ...entry,
            path: remapMovedPath(entry.path),
            name: basename(remapMovedPath(entry.path)),
          })),
        });
      }
      setExpandedPaths((current) => {
        const next = new Set<string>([targetDir]);
        for (const path of current) next.add(remapMovedPath(path));
        next.add(targetDir);
        return next;
      });
      setEntriesByDir({});
      refreshDocs();
    }
    setSelectedTreePaths(new Set(nextSelection));
    if (firstError) notify.error(t("notification.moveFailed", { detail: firstError.message }));
  };

  const moveDocumentsRef = useRef(moveDocuments);
  moveDocumentsRef.current = moveDocuments;

  useEffect(() => {
    if (!pointerDragFallback) return;

    const targetAtPoint = (x: number, y: number): string | null => {
      const element = document.elementFromPoint(x, y);
      if (!(element instanceof Element)) return null;
      const row = element.closest<HTMLElement>("[data-docs-node-kind]");
      if (row) {
        return row.dataset.docsNodeKind === "directory" ? (row.dataset.docsDropPath ?? null) : null;
      }
      return element.closest("[data-docs-tree-root]") ? DOCS_DIR : null;
    };
    const reset = () => {
      const drag = pointerDragRef.current;
      if (drag?.captureElement.hasPointerCapture(drag.pointerId)) {
        drag.captureElement.releasePointerCapture(drag.pointerId);
      }
      if (drag?.active && document.activeElement === drag.captureElement) {
        drag.captureElement.blur();
      }
      pointerDragRef.current = null;
      setPointerDragPaths(new Set());
      setPointerDropTarget(null);
      setPointerDragPreview(null);
    };
    const onPointerMove = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 6) return;
        drag.active = true;
        suppressPointerClickRef.current = true;
        setPointerDragPaths(new Set(drag.entries.map((entry) => entry.path)));
        setSelectedTreePaths(new Set(drag.entries.map((entry) => entry.path)));
      }
      event.preventDefault();
      setPointerDragPreview({
        x: event.clientX,
        y: event.clientY,
        entries: drag.entries,
      });
      const target = targetAtPoint(event.clientX, event.clientY);
      setPointerDropTarget((current) => (current === target ? current : target));
    };
    const onPointerUp = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.active) {
        reset();
        return;
      }
      const target = targetAtPoint(event.clientX, event.clientY);
      reset();
      if (target !== null) void moveDocumentsRef.current(drag.entries, target);
      window.setTimeout(() => {
        suppressPointerClickRef.current = false;
      }, 0);
    };
    const onPointerCancel = (event: PointerEvent) => {
      const drag = pointerDragRef.current;
      if (!drag || event.pointerId !== drag.pointerId) return;
      suppressPointerClickRef.current = false;
      reset();
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
    window.addEventListener("pointercancel", onPointerCancel);
    return () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
      window.removeEventListener("pointercancel", onPointerCancel);
    };
  }, [pointerDragFallback]);

  const docsPointerDrag: DocsPointerDragController = {
    enabled: pointerDragFallback,
    sourcePaths: pointerDragPaths,
    targetPath: pointerDropTarget,
    entriesFor: selectedEntriesFor,
    begin: (event, node) => {
      if (!pointerDragFallback || event.button !== 0) return;
      const captureElement = event.currentTarget as HTMLElement;
      captureElement.setPointerCapture(event.pointerId);
      pointerDragRef.current = {
        entries: selectedEntriesFor(node),
        pointerId: event.pointerId,
        captureElement,
        startX: event.clientX,
        startY: event.clientY,
        active: false,
      };
    },
    consumeClick: () => {
      if (!suppressPointerClickRef.current) return false;
      suppressPointerClickRef.current = false;
      return true;
    },
  };

  const renameDocument = async (node: FsNode, rawName: string) => {
    setRenamingPath(null);
    if (!workspaceId) return;
    const name = node.kind === "file" ? markdownFileName(rawName) : rawName.trim();
    if (!name || name === node.name) return;
    try {
      if (selectedPath && isPathWithin(selectedPath, node.path) && dirty) await saveDocument();
      const newPath = await renameEntry(workspaceId, node.path, name);
      if (selectedPath && isPathWithin(selectedPath, node.path)) {
        setSelectedPath(remapPath(selectedPath, node.path, newPath));
      }
      if (selectedDirectory && isPathWithin(selectedDirectory, node.path)) {
        setSelectedDirectory(remapPath(selectedDirectory, node.path, newPath));
      }
      if (clipboard) {
        setClipboard({
          entries: clipboard.entries.map((entry) =>
            isPathWithin(entry.path, node.path)
              ? {
                  ...entry,
                  path: remapPath(entry.path, node.path, newPath),
                  name: entry.path === node.path ? name : entry.name,
                }
              : entry,
          ),
        });
      }
      setSelectedTreePaths((current) => {
        const next = new Set<string>();
        for (const path of current) {
          next.add(isPathWithin(path, node.path) ? remapPath(path, node.path, newPath) : path);
        }
        return next;
      });
      setExpandedPaths((current) => {
        const next = new Set<string>();
        for (const path of current) {
          next.add(isPathWithin(path, node.path) ? remapPath(path, node.path, newPath) : path);
        }
        return next;
      });
      setEntriesByDir({});
      refreshDocs();
    } catch (reason) {
      notify.error((reason as Error).message);
    }
  };

  const deleteDocuments = async (nodes: FsNode[]) => {
    if (!workspaceId) return;
    const entries = topLevelDocsEntries(nodes);
    if (entries.length === 0) return;
    const accepted = await confirm({
      message:
        entries.length === 1
          ? t("confirm.deleteFile", { name: entries[0].name })
          : t("confirm.deleteItems", { count: entries.length }),
      confirmLabel: t("confirm.delete"),
      reminderKey: "delete-doc-file",
    });
    if (!accepted) return;
    if (dirty && selectedPath && entries.some((entry) => isPathWithin(selectedPath, entry.path))) {
      try {
        await saveDocument();
      } catch {
        return;
      }
    }
    const removed: string[] = [];
    const failed: FsNode[] = [];
    let firstError: Error | null = null;
    for (const entry of entries) {
      try {
        await removeEntry(workspaceId, entry.path);
        removed.push(entry.path);
      } catch (reason) {
        firstError ??= reason as Error;
        failed.push(entry);
      }
    }
    if (removed.length > 0) {
      const wasRemoved = (path: string) => removed.some((entry) => isPathWithin(path, entry));
      if (selectedPath && wasRemoved(selectedPath)) setSelectedPath(null);
      if (selectedDirectory && wasRemoved(selectedDirectory)) setSelectedDirectory(null);
      if (clipboard) {
        const remaining = clipboard.entries.filter((entry) => !wasRemoved(entry.path));
        setClipboard(remaining.length > 0 ? { entries: remaining } : null);
      }
      setExpandedPaths((current) => new Set([...current].filter((path) => !wasRemoved(path))));
      setEntriesByDir({});
      refreshDocs();
    }
    setSelectedTreePaths(new Set(failed.map((entry) => entry.path)));
    if (firstError) notify.error(firstError.message);
  };

  const pasteDocument = async (targetDir = DOCS_DIR) => {
    if (!workspaceId || !clipboard) return;
    if (
      clipboard.entries.some(
        (entry) => entry.kind === "directory" && isPathWithin(targetDir, entry.path),
      )
    ) {
      notify.error(t("notification.invalidMove"));
      return;
    }
    if (dirty) {
      try {
        await saveDocument();
      } catch {
        return;
      }
    }
    const pasted: FsNode[] = [];
    let firstError: Error | null = null;
    for (const entry of clipboard.entries) {
      try {
        const name = await findFreeName(workspaceId, targetDir, entry.name, entry.kind);
        const path = `${targetDir}/${name}`;
        await copyEntryTo(workspaceId, entry.path, path);
        pasted.push({ path, name, kind: entry.kind });
      } catch (reason) {
        firstError ??= reason as Error;
      }
    }
    if (pasted.length > 0) {
      setSelectedTreePaths(new Set(pasted.map((entry) => entry.path)));
      const firstFile = pasted.find((entry) => entry.kind === "file");
      if (firstFile) {
        setSelectedPath(firstFile.path);
        setPreviewMode(true);
      }
      refreshDocs();
    }
    if (firstError) notify.error(t("notification.pasteFailed", { detail: firstError.message }));
  };

  const openFileMenu = (event: React.MouseEvent, node: FsNode) => {
    event.preventDefault();
    event.stopPropagation();
    if (!selectedTreePaths.has(node.path)) {
      setSelectedTreePaths(new Set([node.path]));
    }
    setSelectedDirectory(node.kind === "directory" ? node.path : parentOf(node.path));
    setMenu({ x: event.clientX, y: event.clientY, node });
  };

  const copyDocuments = async (nodes: FsNode[]) => {
    const entries = topLevelDocsEntries(nodes);
    if (selectedPath && entries.some((entry) => isPathWithin(selectedPath, entry.path)) && dirty) {
      try {
        await saveDocument();
      } catch {
        return;
      }
    }
    setClipboard({ entries: entries.map(({ path, name, kind }) => ({ path, name, kind })) });
  };

  const openBlankMenu = (event: React.MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    setSelectedTreePaths(new Set());
    setSelectedDirectory(null);
    setMenu({ x: event.clientX, y: event.clientY, node: null });
  };

  const toggleDirectory = (path: string) => {
    setExpandedPaths((current) => {
      if (current.has(path)) {
        return new Set([...current].filter((entry) => !isPathWithin(entry, path)));
      }
      const next = new Set(current);
      next.add(path);
      return next;
    });
  };

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      docsKeyboardActiveRef.current = !!docsTreeRef.current?.contains(event.target as Node);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (!docsKeyboardActiveRef.current || !(event.target instanceof HTMLElement)) return;
      if (event.target !== document.body && !docsTreeRef.current?.contains(event.target)) return;
      if (event.target.closest("input, textarea, select, [contenteditable]")) return;
      const entries = currentSelectedEntries();
      const modifier = event.ctrlKey || event.metaKey;
      if (modifier && event.key.toLowerCase() === "c" && entries.length > 0) {
        event.preventDefault();
        void copyDocuments(entries);
      } else if (modifier && event.key.toLowerCase() === "v" && clipboard) {
        event.preventDefault();
        const target =
          entries.length === 1
            ? entries[0].kind === "directory"
              ? entries[0].path
              : parentOf(entries[0].path)
            : DOCS_DIR;
        void pasteDocument(target);
      } else if (event.key === "Delete" && entries.length > 0) {
        event.preventDefault();
        void deleteDocuments(entries);
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [clipboard, saveDocument, selectedTreePaths]);

  const menuEntries = menu?.node ? selectedEntriesFor(menu.node) : [];
  const menuSelectionCount =
    menu?.node && selectedTreePaths.has(menu.node.path)
      ? selectedTreePaths.size
      : menu?.node
        ? 1
        : 0;

  const menuSections: CtxMenuSection[] = menu?.node
    ? [
        {
          items: [
            {
              label: t("docs.copy"),
              shortcut: "Ctrl+C",
              onSelect: () => void copyDocuments(menuEntries),
            },
            {
              label: t("docs.rename"),
              shortcut: "F2",
              disabled: menuSelectionCount > 1,
              onSelect: () => setRenamingPath(menu.node!.path),
            },
            ...(menu.node.kind === "directory"
              ? [
                  {
                    label: t("docs.paste"),
                    shortcut: "Ctrl+V",
                    disabled: !clipboard,
                    onSelect: () => void pasteDocument(menu.node!.path),
                  },
                ]
              : []),
          ],
        },
        {
          items: [
            {
              label: t("docs.delete"),
              shortcut: "Delete",
              danger: true,
              onSelect: () => void deleteDocuments(menuEntries),
            },
            {
              label: t("docs.newFolder"),
              onSelect: () => startCreating("directory"),
            },
          ],
        },
      ]
    : [
        {
          items: [
            {
              label: t("docs.paste"),
              shortcut: "Ctrl+V",
              disabled: !clipboard,
              onSelect: () => void pasteDocument(),
            },
          ],
        },
      ];

  if (!workspaceId) {
    return <div className="plan-view plan-view--empty muted">{t("docs.openFirst")}</div>;
  }

  const rootEntries = docsEntries(entriesByDir[DOCS_DIR] ?? []);
  const selectedFile: FsNode | null = selectedPath
    ? { name: basename(selectedPath), path: selectedPath, kind: "file" }
    : null;

  return (
    <div className="plan-view">
      <div className="plan-view__sidebar">
        <div className="plan-view__sidebar-header">
          <span>.osheep / docs</span>
          <span className="plan-view__actions">
            <button
              type="button"
              className="plan-view__new"
              onClick={() => startCreating("file")}
              title={t("docs.new")}
              aria-label={t("docs.new")}
            >
              <i className="codicon codicon-add" aria-hidden="true" />
            </button>
            <button
              type="button"
              className="plan-view__new"
              onClick={() => startCreating("directory")}
              title={t("docs.newFolder")}
              aria-label={t("docs.newFolder")}
            >
              <i className="codicon codicon-new-folder" aria-hidden="true" />
            </button>
          </span>
        </div>
        <div
          ref={docsTreeRef}
          className={`plan-view__list${pointerDragPaths.size > 0 ? " is-pointer-dragging" : ""}${pointerDropTarget === DOCS_DIR ? " is-pointer-drop-target" : ""}`}
          data-docs-tree-root
          role="tree"
          aria-multiselectable="true"
          onClick={(event) => {
            if (
              event.target === event.currentTarget ||
              (event.target as Element).closest(".plan-view__empty")
            ) {
              setSelectedTreePaths(new Set());
              setSelectedDirectory(null);
            }
          }}
          onContextMenu={openBlankMenu}
          onDragOver={(event) => {
            if (!hasDocsDrag(event)) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = "move";
          }}
          onDrop={(event) => {
            if (!hasDocsDrag(event)) return;
            event.preventDefault();
            const entries = readDocsDrag(event);
            if (entries.length > 0) void moveDocuments(entries, DOCS_DIR);
          }}
        >
          {creating && (
            <DocumentNameInput
              initial=""
              placeholder={t("docs.newPlaceholder")}
              kind={creatingKind}
              onSubmit={(name) =>
                void (creatingKind === "directory" ? createFolder(name) : createDocument(name))
              }
              onCancel={() => setCreating(false)}
            />
          )}
          {rootEntries.length === 0 && !creating && !loadingDirs.has(DOCS_DIR) ? (
            <div className="plan-view__empty muted">{t("docs.empty")}</div>
          ) : (
            rootEntries.map((node) => (
              <DocsTreeEntry
                key={node.path}
                node={node}
                depth={0}
                selectedPaths={selectedTreePaths}
                expandedPaths={expandedPaths}
                entriesByDir={entriesByDir}
                loadingDirs={loadingDirs}
                renamingPath={renamingPath}
                onSelectNode={selectTreeNode}
                onRegisterNode={registerDocsNode}
                onOpenMenu={openFileMenu}
                onRename={renameDocument}
                onCancelRename={() => setRenamingPath(null)}
                onDropMove={moveDocuments}
                pointerDrag={docsPointerDrag}
              />
            ))
          )}
        </div>
        {menu && (
          <ContextMenu
            x={menu.x}
            y={menu.y}
            sections={menuSections}
            onClose={() => setMenu(null)}
          />
        )}
        {pointerDragPreview &&
          createPortal(<DocsDragPreview {...pointerDragPreview} />, document.body)}
      </div>
      <div className="plan-view__main">
        {error ? <div className="plan-view__error">{error}</div> : null}
        {selectedFile ? (
          <>
            <div className="plan-view__toolbar">
              <span className="plan-view__current" title={selectedFile.name}>
                {selectedFile.name}
                {dirty ? " *" : ""}
              </span>
              {!previewMode && (
                <button
                  type="button"
                  className="preview-toggle"
                  onClick={() => void saveDocument()}
                  disabled={!dirty || saving}
                  title={t("common.save")}
                  aria-label={t("common.save")}
                >
                  <i className="codicon codicon-save" aria-hidden="true" />
                </button>
              )}
              <button
                type="button"
                className="preview-toggle"
                onClick={() => void togglePreview()}
                title={t(previewMode ? "editor.preview.source" : "editor.preview.open")}
                aria-label={t(previewMode ? "editor.preview.source" : "editor.preview.open")}
              >
                <i
                  className={`codicon ${previewMode ? "codicon-code" : "codicon-preview"}`}
                  aria-hidden="true"
                />
              </button>
            </div>
            <div className="plan-view__document">
              <Suspense fallback={<div className="tab-loading-fallback" />}>
                {previewMode ? (
                  <MarkdownPreview
                    source={content}
                    workspaceId={workspaceId}
                    filePath={selectedPath ?? undefined}
                  />
                ) : (
                  <EditorPane
                    key={selectedPath}
                    path={selectedPath ?? selectedFile.path}
                    value={content}
                    fontSize={editorFontSize}
                    tabSize={editorTabSize}
                    onChange={setContent}
                    onSave={() => void saveDocument()}
                    onPasteImage={pasteImageIntoDocument}
                  />
                )}
              </Suspense>
            </div>
          </>
        ) : (
          <div className="muted plan-view__placeholder">{t("docs.select")}</div>
        )}
      </div>
    </div>
  );
}

function DocsDragPreview({ x, y, entries }: { x: number; y: number; entries: FsNode[] }) {
  const width = 240;
  const left = Math.max(8, Math.min(x + 14, window.innerWidth - width - 8));
  const visibleEntries = entries.slice(0, 3);
  const height = visibleEntries.length * 22 + 10;
  const top = Math.max(8, Math.min(y + 16, window.innerHeight - height - 8));
  return (
    <div
      className="file-tree-drag-preview"
      style={{ transform: `translate3d(${left}px, ${top}px, 0)` }}
      aria-hidden="true"
    >
      {visibleEntries.map((node) => (
        <div className="file-tree-drag-preview__item" key={node.path}>
          {node.kind === "directory" ? (
            <i className="codicon codicon-folder" />
          ) : (
            <FileIcon name={node.name} />
          )}
          <span>{node.name}</span>
        </div>
      ))}
      {entries.length > 1 && (
        <span className="file-tree-drag-preview__count">{entries.length}</span>
      )}
    </div>
  );
}

function DocsTreeEntry({
  node,
  depth,
  selectedPaths,
  expandedPaths,
  entriesByDir,
  loadingDirs,
  renamingPath,
  onSelectNode,
  onRegisterNode,
  onOpenMenu,
  onRename,
  onCancelRename,
  onDropMove,
  pointerDrag,
}: {
  node: FsNode;
  depth: number;
  selectedPaths: ReadonlySet<string>;
  expandedPaths: Set<string>;
  entriesByDir: Record<string, FsNode[]>;
  loadingDirs: Set<string>;
  renamingPath: string | null;
  onSelectNode: (node: FsNode, additive: boolean) => void;
  onRegisterNode: (node: FsNode) => void;
  onOpenMenu: (event: React.MouseEvent, node: FsNode) => void;
  onRename: (node: FsNode, name: string) => Promise<void>;
  onCancelRename: () => void;
  onDropMove: (entries: FsNode[], targetDir: string) => Promise<void>;
  pointerDrag: DocsPointerDragController;
}) {
  const expanded = node.kind === "directory" && expandedPaths.has(node.path);
  const children = docsEntries(entriesByDir[node.path] ?? []);

  useEffect(() => {
    onRegisterNode(node);
  }, [node, onRegisterNode]);

  if (renamingPath === node.path) {
    return (
      <DocumentNameInput
        initial={node.name}
        kind={node.kind}
        depth={depth}
        onSubmit={(name) => void onRename(node, name)}
        onCancel={onCancelRename}
      />
    );
  }

  return (
    <div className="plan-view__tree-entry">
      <button
        type="button"
        className={`plan-view__item${selectedPaths.has(node.path) ? " is-active" : ""}${pointerDrag.sourcePaths.has(node.path) ? " is-pointer-dragging" : ""}${pointerDrag.targetPath === node.path ? " is-pointer-drop-target" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        data-docs-node-kind={node.kind}
        data-docs-drop-path={node.kind === "directory" ? node.path : undefined}
        onClick={(event) => {
          if (pointerDrag.consumeClick()) return;
          onSelectNode(node, event.ctrlKey || event.metaKey);
        }}
        onPointerDown={(event) => pointerDrag.begin(event, node)}
        draggable={!pointerDrag.enabled}
        onDragStart={(event) => {
          const entries = pointerDrag.entriesFor(node);
          const encoded = encodeDocsDrag(entries);
          event.dataTransfer.setData(DOCS_DRAG_MIME, encoded);
          event.dataTransfer.setData("text/plain", `${DOCS_DRAG_TEXT_PREFIX}${encoded}`);
          event.dataTransfer.effectAllowed = "move";
        }}
        onDragOver={(event) => {
          if (node.kind !== "directory" || !hasDocsDrag(event)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }}
        onDrop={(event) => {
          if (node.kind !== "directory" || !hasDocsDrag(event)) return;
          event.preventDefault();
          event.stopPropagation();
          const entries = readDocsDrag(event);
          if (entries.length > 0) void onDropMove(entries, node.path);
        }}
        onContextMenu={(event) => onOpenMenu(event, node)}
        title={node.name}
        role="treeitem"
        aria-selected={selectedPaths.has(node.path)}
        aria-expanded={node.kind === "directory" ? expanded : undefined}
      >
        <span
          className={`plan-view__chevron${node.kind === "directory" ? "" : " is-placeholder"}`}
          aria-hidden="true"
        >
          {node.kind === "directory" && (
            <i className={`codicon codicon-chevron-${expanded ? "down" : "right"}`} />
          )}
        </span>
        {node.kind === "directory" ? (
          <i
            className={`plan-view__folder codicon codicon-folder${expanded ? "-opened" : ""}`}
            aria-hidden="true"
          />
        ) : (
          <FileIcon name={node.name} />
        )}
        <span>{node.name}</span>
      </button>
      {expanded && (
        <div className="plan-view__children">
          {loadingDirs.has(node.path) && children.length === 0 ? (
            <div className="plan-view__loading muted" style={{ paddingLeft: 36 + depth * 14 }}>
              ...
            </div>
          ) : (
            children.map((child) => (
              <DocsTreeEntry
                key={child.path}
                node={child}
                depth={depth + 1}
                selectedPaths={selectedPaths}
                expandedPaths={expandedPaths}
                entriesByDir={entriesByDir}
                loadingDirs={loadingDirs}
                renamingPath={renamingPath}
                onSelectNode={onSelectNode}
                onRegisterNode={onRegisterNode}
                onOpenMenu={onOpenMenu}
                onRename={onRename}
                onCancelRename={onCancelRename}
                onDropMove={onDropMove}
                pointerDrag={pointerDrag}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}

function DocumentNameInput({
  initial,
  placeholder,
  kind = "file",
  depth = 0,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
  kind?: FsNode["kind"];
  depth?: number;
  onSubmit: (name: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const inputRef = useRef<HTMLInputElement>(null);
  const submittedRef = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    const dot = kind === "file" ? initial.lastIndexOf(".") : -1;
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initial, kind]);

  const submit = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(value);
  };

  return (
    <div className="plan-view__name-input" style={{ paddingLeft: 28 + depth * 14 }}>
      {kind === "directory" ? (
        <i className="plan-view__folder codicon codicon-folder" aria-hidden="true" />
      ) : (
        <FileIcon name={value || "document.md"} />
      )}
      <input
        ref={inputRef}
        value={value}
        placeholder={placeholder}
        onChange={(event) => setValue(event.target.value)}
        onContextMenu={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Enter") submit();
          else if (event.key === "Escape") {
            submittedRef.current = true;
            onCancel();
          }
        }}
        onBlur={submit}
      />
    </div>
  );
}
