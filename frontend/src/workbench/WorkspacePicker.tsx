import { FormEvent, useCallback, useEffect, useState } from "react";
import {
  createWorkspace,
  getWorkspacesRoot,
  listWorkspaces,
  setWorkspacesRoot as setWorkspaceRootApi,
  type Workspace,
} from "./api";
import { isDesktopShell, pickWorkspaceFolder } from "./desktop-folder-picker";

interface Props {
  currentId: string | null;
  onChoose: (workspace: Workspace) => void;
  onCancel: () => void;
}

export function WorkspacePicker({ currentId, onChoose, onCancel }: Props) {
  const desktopShell = isDesktopShell();
  const [items, setItems] = useState<Workspace[] | null>(null);
  const [rootPath, setRootPath] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [opening, setOpening] = useState(false);
  const [creating, setCreating] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");

  const refreshWorkspaces = useCallback(async () => {
    setItems(await listWorkspaces());
  }, []);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const [root, list] = await Promise.all([
          getWorkspacesRoot(),
          listWorkspaces(),
        ]);
        if (!cancelled) {
          setRootPath(root);
          setItems(list);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const chooseRootFolder = async () => {
    setOpening(true);
    setError(null);
    try {
      const folder = await pickWorkspaceFolder(rootPath);
      if (!folder) return;
      const root = await setWorkspaceRootApi(folder);
      setRootPath(root);
      await refreshWorkspaces();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setOpening(false);
    }
  };

  const submitNewWorkspace = async (event: FormEvent) => {
    event.preventDefault();
    if (!rootPath || !newName.trim() || creating) return;
    setCreating(true);
    setError(null);
    try {
      const workspace = await createWorkspace(newName);
      onChoose(workspace);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setCreating(false);
    }
  };

  return (
    <div className="modal-backdrop" onMouseDown={onCancel}>
      <div
        className="modal workspace-picker"
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal__header">
          <span className="modal__title">选择工作区</span>
          <button
            type="button"
            className="tb-btn workspace-picker__add"
            onClick={() => {
              setCreateOpen(true);
              setNewName("");
              setError(null);
            }}
            disabled={!rootPath || opening || creating}
            title="在当前 workspaces 文件夹中新建工作区"
            aria-label="新建工作区"
          >
            +
          </button>
          {desktopShell && (
            <button
              type="button"
              className="tb-btn workspace-picker__open"
              onClick={() => void chooseRootFolder()}
              disabled={opening || creating}
            >
              {opening ? "打开中..." : "选择 workspaces 文件夹"}
            </button>
          )}
          <button className="icon-btn" onClick={onCancel} title="关闭">
            ×
          </button>
        </div>
        <div className="modal__body">
          <div className="workspace-picker__root">
            <span className="workspace-picker__root-label">工作区根目录</span>
            <code title={rootPath ?? ""}>{rootPath ?? "尚未选择"}</code>
          </div>
          {createOpen && (
            <form className="workspace-picker__create" onSubmit={submitNewWorkspace}>
              <input
                autoFocus
                value={newName}
                onChange={(event) => setNewName(event.target.value)}
                placeholder="新工作区名称"
                maxLength={64}
                disabled={creating}
              />
              <button type="submit" className="tb-btn" disabled={!newName.trim() || creating}>
                {creating ? "创建中..." : "创建"}
              </button>
              <button
                type="button"
                className="icon-btn"
                onClick={() => {
                  setCreateOpen(false);
                  setNewName("");
                }}
                disabled={creating}
                title="取消"
              >
                ×
              </button>
            </form>
          )}
          {error && <div className="modal__error">无法读取工作区：{error}</div>}
          {items === null && !error && <div className="muted">加载中...</div>}
          {items !== null && items.length === 0 && (
            <div className="muted workspace-picker__empty">
              当前 workspaces 文件夹下还没有工作区，点击左侧 + 创建一个。
            </div>
          )}
          {items !== null && items.length > 0 && (
            <div className="workspace-list">
              {items.map((workspace) => (
                <button
                  key={workspace.id}
                  type="button"
                  className={
                    "workspace-list__item" +
                    (workspace.id === currentId ? " is-active" : "")
                  }
                  onClick={() => onChoose(workspace)}
                >
                  <span className="workspace-list__name">{workspace.name}</span>
                  <span className="workspace-list__id">{workspace.id}</span>
                </button>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
