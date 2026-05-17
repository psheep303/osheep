import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  listSessions as apiListSessions,
  type SessionSummary,
} from "./api";

type AiPanelTab = "compose" | "maintain";

interface AiPanelProps {
  workspaceId: string | null;
  onClose: () => void;
  onOpenSession: (sessionId: string) => void;
  activeSessionId: string | null;
  /** bumped externally when a session was changed so the list re-fetches */
  refreshSignal: number;
}

export function AiPanel({
  workspaceId,
  onClose,
  onOpenSession,
  activeSessionId,
  refreshSignal,
}: AiPanelProps) {
  const [tab, setTab] = useState<AiPanelTab>("compose");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [searchOpen, setSearchOpen] = useState(false);
  const [searchText, setSearchText] = useState("");

  const reload = useCallback(async () => {
    if (!workspaceId) {
      setSessions([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await apiListSessions(workspaceId);
      setSessions(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshSignal]);

  const filtered = useMemo(() => {
    if (!searchText.trim()) return sessions;
    const q = searchText.trim().toLowerCase();
    return sessions.filter((s) => s.title.toLowerCase().includes(q));
  }, [sessions, searchText]);

  const handleNew = async () => {
    if (!workspaceId) return;
    try {
      const s = await apiCreateSession(workspaceId, {});
      await reload();
      onOpenSession(s.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!workspaceId) return;
    if (!window.confirm(`确定删除对话「${title}」？`)) return;
    try {
      await apiDeleteSession(workspaceId, id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="side-view ai-panel">
      <div className="side-view__header">
        <span className="side-view__title">AI 面板</span>
        <button className="icon-btn" title="关闭" onClick={onClose}>
          ×
        </button>
      </div>

      <div className="ai-panel__tabs">
        <button
          className={
            "ai-panel__tab" + (tab === "compose" ? " is-active" : "")
          }
          onClick={() => setTab("compose")}
        >
          编写
        </button>
        <button
          className={
            "ai-panel__tab" + (tab === "maintain" ? " is-active" : "")
          }
          onClick={() => setTab("maintain")}
        >
          维护
        </button>
      </div>

      {tab === "compose" ? (
        <div className="ai-panel__body">
          <div className="ai-panel__toolbar">
            <button
              className="ai-panel__btn primary-btn"
              disabled={!workspaceId}
              onClick={() => void handleNew()}
              title="新建对话"
            >
              + 新建
            </button>
            <button
              className={
                "ai-panel__btn" + (searchOpen ? " is-active" : "")
              }
              onClick={() => {
                setSearchOpen((v) => !v);
                if (searchOpen) setSearchText("");
              }}
              title="搜索"
            >
              搜索
            </button>
          </div>

          {searchOpen && (
            <div className="ai-panel__search">
              <input
                className="settings-view__input"
                value={searchText}
                placeholder="按标题搜索…"
                autoFocus
                onChange={(e) => setSearchText(e.target.value)}
              />
            </div>
          )}

          {error && (
            <div className="ai-panel__error">
              {error}
              <button
                className="provider-card__chip-remove"
                onClick={() => setError(null)}
              >
                ×
              </button>
            </div>
          )}

          {!workspaceId && (
            <div className="ai-panel__empty">请先打开工作区</div>
          )}

          {workspaceId && loading && (
            <div className="ai-panel__empty">加载中…</div>
          )}

          {workspaceId && !loading && filtered.length === 0 && (
            <div className="ai-panel__empty">
              {searchText ? "未匹配到对话" : "尚未创建任何对话"}
            </div>
          )}

          <div className="ai-panel__list">
            {filtered.map((s) => (
              <SessionItem
                key={s.id}
                session={s}
                active={s.id === activeSessionId}
                onOpen={() => onOpenSession(s.id)}
                onDelete={() => void handleDelete(s.id, s.title)}
              />
            ))}
          </div>
        </div>
      ) : (
        <div className="ai-panel__body">
          <div className="ai-panel__empty">
            维护页面（PR / Issue / 自动维护）将在后续阶段接入
          </div>
        </div>
      )}
    </div>
  );
}

interface SessionItemProps {
  session: SessionSummary;
  active: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

function SessionItem({ session, active, onOpen, onDelete }: SessionItemProps) {
  return (
    <div
      className={"ai-panel__item" + (active ? " is-active" : "")}
      onClick={onOpen}
      title={session.title}
    >
      <div className="ai-panel__item-title">{session.title || "新对话"}</div>
      <div className="ai-panel__item-meta">
        <span>{formatRelative(session.updatedAt)}</span>
        <button
          className="ai-panel__item-del"
          onClick={(e) => {
            e.stopPropagation();
            onDelete();
          }}
          title="删除"
        >
          🗑
        </button>
      </div>
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "刚刚";
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d`;
  const mo = Math.floor(d / 30);
  if (mo < 12) return `${mo}mo`;
  return `${Math.floor(mo / 12)}y`;
}
