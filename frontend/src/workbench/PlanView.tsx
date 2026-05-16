import { useEffect, useState } from "react";
import { MarkdownPreview } from "./MarkdownPreview";
import { PLAN_DIR, readDirShallow, readFileText, type FsNode } from "./fs";

interface PlanViewProps {
  workspaceId: string | null;
}

export function PlanView({ workspaceId }: PlanViewProps) {
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
        const entries = (await readDirShallow(workspaceId, PLAN_DIR)).filter(
          (n) => n.kind === "file"
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
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspaceId]);

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
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [workspaceId, selectedPath]);

  if (!workspaceId) {
    return (
      <div className="plan-view plan-view--empty muted">请先选择工作区</div>
    );
  }

  return (
    <div className="plan-view">
      <div className="plan-view__sidebar">
        <div className="plan-view__sidebar-header">.osheep / plan</div>
        {files.length === 0 ? (
          <div className="plan-view__empty muted">暂无计划</div>
        ) : (
          files.map((f) => (
            <div
              key={f.path}
              className={
                "plan-view__item" +
                (f.path === selectedPath ? " is-active" : "")
              }
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
          <MarkdownPreview source={content} />
        ) : (
          <div className="muted plan-view__placeholder">从左侧选择一份计划</div>
        )}
      </div>
    </div>
  );
}
