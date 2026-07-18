import { useEffect, useState } from "react";
import { listWorkspaces, registerWorkspacePath, type Workspace } from "./api";
import { isDesktopShell, pickWorkspaceFolder } from "./desktop-folder-picker";

interface Props {
  currentId: string | null;
  onChoose: (workspace: Workspace) => void;
  onCancel: () => void;
}

export function WorkspacePicker({ currentId, onChoose, onCancel }: Props) {
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);

  const openFolder = async () => {
    if (!isDesktopShell()) {
      setError("打开任意文件夹需要使用 osheep 桌面版");
      return;
    }
    setOpening(true);
    setError(null);
    try {
      const folder = await pickWorkspaceFolder();
      if (!folder) return;
      const workspace = await registerWorkspacePath(folder);
      onChoose(workspace);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

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
          <button
            type="button"
            className="tb-btn workspace-picker__open"
            onClick={() => void openFolder()}
            disabled={opening}
          >
            {opening ? "打开中..." : "打开文件夹"}
          </button>
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
                  onClick={() => onChoose(w)}
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
