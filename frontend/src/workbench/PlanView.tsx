import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import {
  copyEntryTo,
  createFile,
  DOCS_DIR,
  type FsNode,
  findFreeName,
  readDirShallow,
  readFileText,
  removeEntry,
  renameEntry,
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

interface DocsClipboard {
  path: string;
  name: string;
  kind: FsNode["kind"];
}

interface DocsMenu {
  x: number;
  y: number;
  node: FsNode | null;
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
  const [content, setContent] = useState("");
  const [savedContent, setSavedContent] = useState("");
  const [previewMode, setPreviewMode] = useState(true);
  const [creating, setCreating] = useState(false);
  const [renamingPath, setRenamingPath] = useState<string | null>(null);
  const [clipboard, setClipboard] = useState<DocsClipboard | null>(null);
  const [menu, setMenu] = useState<DocsMenu | null>(null);
  const [refreshVersion, setRefreshVersion] = useState(0);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = content !== savedContent;

  useEffect(() => {
    setEntriesByDir({});
    setExpandedPaths(new Set());
    setSelectedPath(null);
    setContent("");
    setSavedContent("");
    setMenu(null);
    setRenamingPath(null);
  }, [workspaceId]);

  const refreshDocs = useCallback(() => {
    setRefreshVersion((version) => version + 1);
    onDocsChanged?.();
  }, [onDocsChanged]);

  useEffect(() => {
    if (!workspaceId) {
      setEntriesByDir({});
      setExpandedPaths(new Set());
      setSelectedPath(null);
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

  const createDocument = async (rawName: string) => {
    setCreating(false);
    if (!workspaceId) return;
    const requestedName = markdownFileName(rawName);
    if (!requestedName) return;
    try {
      if (dirty) await saveDocument();
      const name = await findFreeName(workspaceId, DOCS_DIR, requestedName, "file");
      const path = `${DOCS_DIR}/${name}`;
      await createFile(workspaceId, path);
      setPreviewMode(false);
      setSelectedPath(path);
      refreshDocs();
    } catch (reason) {
      notify.error((reason as Error).message);
    }
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
      if (clipboard && isPathWithin(clipboard.path, node.path)) {
        setClipboard({
          ...clipboard,
          path: remapPath(clipboard.path, node.path, newPath),
          name: clipboard.path === node.path ? name : clipboard.name,
        });
      }
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

  const deleteDocument = async (node: FsNode) => {
    if (!workspaceId) return;
    const accepted = await confirm({
      message: t("confirm.deleteFile", { name: node.name }),
      confirmLabel: t("confirm.delete"),
      reminderKey: "delete-doc-file",
    });
    if (!accepted) return;
    try {
      await removeEntry(workspaceId, node.path);
      if (selectedPath && isPathWithin(selectedPath, node.path)) setSelectedPath(null);
      if (clipboard && isPathWithin(clipboard.path, node.path)) setClipboard(null);
      setExpandedPaths(
        (current) => new Set([...current].filter((path) => !isPathWithin(path, node.path))),
      );
      setEntriesByDir({});
      refreshDocs();
    } catch (reason) {
      notify.error((reason as Error).message);
    }
  };

  const pasteDocument = async (targetDir = DOCS_DIR) => {
    if (!workspaceId || !clipboard) return;
    try {
      if (dirty) await saveDocument();
      const name = await findFreeName(workspaceId, targetDir, clipboard.name, clipboard.kind);
      const path = `${targetDir}/${name}`;
      await copyEntryTo(workspaceId, clipboard.path, path);
      if (clipboard.kind === "file") {
        setSelectedPath(path);
        setPreviewMode(true);
      }
      refreshDocs();
    } catch (reason) {
      notify.error(t("notification.pasteFailed", { detail: (reason as Error).message }));
    }
  };

  const openFileMenu = (event: React.MouseEvent, node: FsNode) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, node });
  };

  const copyDocument = async (node: FsNode) => {
    if (selectedPath && isPathWithin(selectedPath, node.path) && dirty) {
      try {
        await saveDocument();
      } catch {
        return;
      }
    }
    setClipboard({ path: node.path, name: node.name, kind: node.kind });
  };

  const openBlankMenu = (event: React.MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
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

  const menuSections: CtxMenuSection[] = menu?.node
    ? [
        {
          items: [
            {
              label: t("docs.copy"),
              shortcut: "Ctrl+C",
              onSelect: () => void copyDocument(menu.node!),
            },
            {
              label: t("docs.rename"),
              shortcut: "F2",
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
              onSelect: () => void deleteDocument(menu.node!),
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
          <button
            type="button"
            className="plan-view__new"
            onClick={() => setCreating(true)}
            title={t("docs.new")}
            aria-label={t("docs.new")}
          >
            <i className="codicon codicon-add" aria-hidden="true" />
          </button>
        </div>
        <div className="plan-view__list" onContextMenu={openBlankMenu}>
          {creating && (
            <DocumentNameInput
              initial=""
              placeholder={t("docs.newPlaceholder")}
              onSubmit={(name) => void createDocument(name)}
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
                selectedPath={selectedPath}
                expandedPaths={expandedPaths}
                entriesByDir={entriesByDir}
                loadingDirs={loadingDirs}
                renamingPath={renamingPath}
                onSelectDocument={selectDocument}
                onToggleDirectory={toggleDirectory}
                onOpenMenu={openFileMenu}
                onRename={renameDocument}
                onCancelRename={() => setRenamingPath(null)}
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
                  <MarkdownPreview source={content} />
                ) : (
                  <EditorPane
                    key={selectedPath}
                    path={selectedPath ?? selectedFile.path}
                    value={content}
                    fontSize={editorFontSize}
                    tabSize={editorTabSize}
                    onChange={setContent}
                    onSave={() => void saveDocument()}
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

function DocsTreeEntry({
  node,
  depth,
  selectedPath,
  expandedPaths,
  entriesByDir,
  loadingDirs,
  renamingPath,
  onSelectDocument,
  onToggleDirectory,
  onOpenMenu,
  onRename,
  onCancelRename,
}: {
  node: FsNode;
  depth: number;
  selectedPath: string | null;
  expandedPaths: Set<string>;
  entriesByDir: Record<string, FsNode[]>;
  loadingDirs: Set<string>;
  renamingPath: string | null;
  onSelectDocument: (path: string) => Promise<void>;
  onToggleDirectory: (path: string) => void;
  onOpenMenu: (event: React.MouseEvent, node: FsNode) => void;
  onRename: (node: FsNode, name: string) => Promise<void>;
  onCancelRename: () => void;
}) {
  const expanded = node.kind === "directory" && expandedPaths.has(node.path);
  const children = docsEntries(entriesByDir[node.path] ?? []);

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
        className={`plan-view__item${node.path === selectedPath ? " is-active" : ""}`}
        style={{ paddingLeft: 8 + depth * 14 }}
        onClick={() => {
          if (node.kind === "directory") onToggleDirectory(node.path);
          else void onSelectDocument(node.path);
        }}
        onContextMenu={(event) => onOpenMenu(event, node)}
        title={node.name}
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
                selectedPath={selectedPath}
                expandedPaths={expandedPaths}
                entriesByDir={entriesByDir}
                loadingDirs={loadingDirs}
                renamingPath={renamingPath}
                onSelectDocument={onSelectDocument}
                onToggleDirectory={onToggleDirectory}
                onOpenMenu={onOpenMenu}
                onRename={onRename}
                onCancelRename={onCancelRename}
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
