import { lazy, Suspense, useEffect, useState } from "react";
import { useUiPreferences } from "../i18n/UiPreferences";
import { type FsNode, DOCS_DIR, readDirShallow, readFileText } from "./fs";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })),
);

interface PlanViewProps {
  workspaceId: string | null;
  refreshSignal?: number;
}

export function PlanView({ workspaceId, refreshSignal = 0 }: PlanViewProps) {
  const { t } = useUiPreferences();
  const [files, setFiles] = useState<FsNode[]>([]);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [content, setContent] = useState<string>("");
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) {
      setFiles([]);
      setSelectedPath(null);
      setContent("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const entries = (await readDirShallow(workspaceId, DOCS_DIR)).filter(
          (n) => n.kind === "file",
        );
        if (cancelled) return;
        setFiles(entries);
        if (entries.length > 0 && !entries.find((e) => e.path === selectedPath)) {
          setSelectedPath(entries[0].path);
        } else if (entries.length === 0) {
          setSelectedPath(null);
          setContent("");
        }
      } catch (e) {
        if (!cancelled) setError(t("error.loadDocs", { detail: (e as Error).message }));
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId, refreshSignal, t]);

  useEffect(() => {
    if (!workspaceId || !selectedPath) {
      setContent("");
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const text = await readFileText(workspaceId, selectedPath);
        if (!cancelled) setContent(text);
      } catch (e) {
        if (!cancelled) setError(t("error.loadDocs", { detail: (e as Error).message }));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selectedPath, t]);

  if (!workspaceId) {
    return <div className="plan-view plan-view--empty muted">{t("docs.openFirst")}</div>;
  }

  return (
    <div className="plan-view">
      <div className="plan-view__sidebar">
        <div className="plan-view__sidebar-header">.osheep / docs</div>
        {files.length === 0 ? (
          <div className="plan-view__empty muted">{t("docs.empty")}</div>
        ) : (
          files.map((f) => (
            <div
              key={f.path}
              className={`plan-view__item${f.path === selectedPath ? " is-active" : ""}`}
              onClick={() => setSelectedPath(f.path)}
              title={f.name}
            >
              {f.name}
            </div>
          ))
        )}
      </div>
      <div className="plan-view__main">
        {error ? (
          <div className="plan-view__error">{error}</div>
        ) : selectedPath ? (
          <Suspense fallback={<div className="tab-loading-fallback" />}>
            <MarkdownPreview source={content} />
          </Suspense>
        ) : (
          <div className="muted plan-view__placeholder">{t("docs.select")}</div>
        )}
      </div>
    </div>
  );
}
