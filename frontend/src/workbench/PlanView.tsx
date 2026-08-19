import { lazy, Suspense, useCallback, useEffect, useRef, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
import { FileIcon } from "./FileIcon";
import {
  copyEntryTo,
  createFile,
  DOCS_DIR,
  findFreeName,
  type FsNode,
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
}

interface DocsMenu {
  x: number;
  y: number;
  file: FsNode | null;
}

function markdownFileName(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  return /\.md$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
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
  const [files, setFiles] = useState<FsNode[]>([]);
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

  const refreshDocs = useCallback(() => {
    setRefreshVersion((version) => version + 1);
    onDocsChanged?.();
  }, [onDocsChanged]);

  useEffect(() => {
    if (!workspaceId) {
      setFiles([]);
      setSelectedPath(null);
      setContent("");
      setSavedContent("");
      return;
    }
    let cancelled = false;
    void readDirShallow(workspaceId, DOCS_DIR)
      .then((entries) => {
        if (cancelled) return;
        const markdownFiles = entries.filter(
          (entry) => entry.kind === "file" && /\.md$/i.test(entry.name),
        );
        setFiles(markdownFiles);
        setSelectedPath((current) => {
          if (current && markdownFiles.some((entry) => entry.path === current)) return current;
          return markdownFiles[0]?.path ?? null;
        });
        setError(null);
      })
      .catch((reason) => {
        if (!cancelled) setError(t("error.loadDocs", { detail: (reason as Error).message }));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshSignal, refreshVersion, t]);

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
        if (!cancelled) setError(t("error.loadDocs", { detail: (reason as Error).message }));
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selectedPath, t]);

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

  const renameDocument = async (file: FsNode, rawName: string) => {
    setRenamingPath(null);
    if (!workspaceId) return;
    const name = markdownFileName(rawName);
    if (!name || name === file.name) return;
    try {
      if (selectedPath === file.path && dirty) await saveDocument();
      const newPath = await renameEntry(workspaceId, file.path, name);
      if (selectedPath === file.path) setSelectedPath(newPath);
      if (clipboard?.path === file.path) setClipboard({ path: newPath, name });
      refreshDocs();
    } catch (reason) {
      notify.error((reason as Error).message);
    }
  };

  const deleteDocument = async (file: FsNode) => {
    if (!workspaceId) return;
    const accepted = await confirm({
      message: t("confirm.deleteFile", { name: file.name }),
      confirmLabel: t("confirm.delete"),
      reminderKey: "delete-doc-file",
    });
    if (!accepted) return;
    try {
      await removeEntry(workspaceId, file.path);
      if (selectedPath === file.path) setSelectedPath(null);
      if (clipboard?.path === file.path) setClipboard(null);
      refreshDocs();
    } catch (reason) {
      notify.error((reason as Error).message);
    }
  };

  const pasteDocument = async () => {
    if (!workspaceId || !clipboard) return;
    try {
      if (dirty) await saveDocument();
      const name = await findFreeName(workspaceId, DOCS_DIR, clipboard.name, "file");
      const path = `${DOCS_DIR}/${name}`;
      await copyEntryTo(workspaceId, clipboard.path, path);
      setSelectedPath(path);
      setPreviewMode(true);
      refreshDocs();
    } catch (reason) {
      notify.error(t("notification.pasteFailed", { detail: (reason as Error).message }));
    }
  };

  const openFileMenu = (event: React.MouseEvent, file: FsNode) => {
    event.preventDefault();
    event.stopPropagation();
    setMenu({ x: event.clientX, y: event.clientY, file });
  };

  const copyDocument = async (file: FsNode) => {
    if (selectedPath === file.path && dirty) {
      try {
        await saveDocument();
      } catch {
        return;
      }
    }
    setClipboard({ path: file.path, name: file.name });
  };

  const openBlankMenu = (event: React.MouseEvent) => {
    if (event.defaultPrevented) return;
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, file: null });
  };

  const menuSections: CtxMenuSection[] = menu?.file
    ? [
        {
          items: [
            {
              label: t("docs.copy"),
              shortcut: "Ctrl+C",
              onSelect: () => void copyDocument(menu.file!),
            },
            {
              label: t("docs.rename"),
              shortcut: "F2",
              onSelect: () => setRenamingPath(menu.file!.path),
            },
          ],
        },
        {
          items: [
            {
              label: t("docs.delete"),
              shortcut: "Delete",
              danger: true,
              onSelect: () => void deleteDocument(menu.file!),
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

  const selectedFile = files.find((file) => file.path === selectedPath) ?? null;

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
          {files.length === 0 && !creating ? (
            <div className="plan-view__empty muted">{t("docs.empty")}</div>
          ) : (
            files.map((file) =>
              renamingPath === file.path ? (
                <DocumentNameInput
                  key={file.path}
                  initial={file.name}
                  onSubmit={(name) => void renameDocument(file, name)}
                  onCancel={() => setRenamingPath(null)}
                />
              ) : (
                <button
                  type="button"
                  key={file.path}
                  className={`plan-view__item${file.path === selectedPath ? " is-active" : ""}`}
                  onClick={() => void selectDocument(file.path)}
                  onContextMenu={(event) => openFileMenu(event, file)}
                  title={file.name}
                >
                  <FileIcon name={file.name} />
                  <span>{file.name}</span>
                </button>
              ),
            )
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

function DocumentNameInput({
  initial,
  placeholder,
  onSubmit,
  onCancel,
}: {
  initial: string;
  placeholder?: string;
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
    const dot = initial.lastIndexOf(".");
    if (dot > 0) input.setSelectionRange(0, dot);
    else input.select();
  }, [initial]);

  const submit = () => {
    if (submittedRef.current) return;
    submittedRef.current = true;
    onSubmit(value);
  };

  return (
    <div className="plan-view__name-input">
      <FileIcon name={value || "document.md"} />
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
