import { useEffect, useState } from "react";
import { listWorkspaces, type Workspace } from "./api";

interface Props {
  currentId: string | null;
  onChoose: (id: string) => void;
  onCancel: () => void;
}

export function WorkspacePicker({ currentId, onChoose, onCancel }: Props) {
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const list = await listWorkspaces();
        if (!cancelled) setItems(list);
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <span className="modal__title">选择工作区</span>
          <button className="icon-btn" onClick={onCancel} title="关闭">
            ×
          </button>
        </div>
        <div className="modal__body">
          {error && <div className="modal__error">无法读取工作区：{error}</div>}
          {items === null && !error && (
            <div className="muted">加载中…</div>
          )}
          {items !== null && items.length === 0 && (
            <div className="muted">
              后端 <code>WORKSPACES_ROOT</code> 下还没有工作区。
              在该目录下创建一个一级子目录（命名只包含字母 / 数字 / <code>.-_</code>）即可。
            </div>
          )}
          {items !== null && items.length > 0 && (
            <div className="workspace-list">
              {items.map((w) => (
                <button
                  key={w.id}
                  type="button"
                  className={
                    "workspace-list__item" +
                    (w.id === currentId ? " is-active" : "")
                  }
                  onClick={() => onChoose(w.id)}
                >
                  <span className="workspace-list__name">{w.name}</span>
                  <span className="workspace-list__id">{w.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
