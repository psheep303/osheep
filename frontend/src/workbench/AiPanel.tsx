import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createSession as apiCreateSession,
  deleteSession as apiDeleteSession,
  listSessions as apiListSessions,
  type SessionSummary,
} from "./api";
import { useActiveSessions } from "./chat-runtime";

interface AiPanelProps {
  workspaceId: string | null;
  onOpenSession: (sessionId: string) => void;
  activeSessionId: string | null;
  /** bumped externally when a session was changed so the list re-fetches */
  refreshSignal: number;
}

type PanelTab = "osheepcode" | "maintain";

export function AiPanel({
  workspaceId,
  onOpenSession,
  activeSessionId,
  refreshSignal,
}: AiPanelProps) {
  const [activeTab, setActiveTab] = useState<PanelTab>("osheepcode");
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");

  const activeRuntimeSessions = useActiveSessions();

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
    <div className="ai-panel">
      <div className="ai-panel__brand">osheep</div>

      <div className="ai-panel__tabs">
        <button
          className={
            "ai-panel__tab" + (activeTab === "osheepcode" ? " is-active" : "")
          }
          onClick={() => setActiveTab("osheepcode")}
        >
          osheep code
        </button>
        <button
          className={
            "ai-panel__tab" + (activeTab === "maintain" ? " is-active" : "")
          }
          onClick={() => setActiveTab("maintain")}
        >
          维护
        </button>
      </div>

      {activeTab === "maintain" ? (
        <div className="ai-panel__maintain">
          <div className="ai-panel__maintain-title">维护功能正在筹备中</div>
          <div className="ai-panel__maintain-hint">未来阶段将提供：</div>
          <ul className="ai-panel__maintain-list">
            <li>长期会话与记忆库</li>
            <li>规则 / 工作流模板</li>
            <li>自动化任务（计划运行）</li>
          </ul>
        </div>
      ) : (
        <>
          <button
            className="ai-panel__new"
            disabled={!workspaceId}
            onClick={() => void handleNew()}
            title="新建对话"
          >
            <PlusIcon />
            <span>New session</span>
          </button>

          <div className="ai-panel__search">
            <SearchIcon />
            <input
              className="ai-panel__search-input"
              value={searchText}
              placeholder="Search sessions…"
              onChange={(e) => setSearchText(e.target.value)}
            />
          </div>

          {error && (
            <div className="ai-panel__error">
              <span>{error}</span>
              <button onClick={() => setError(null)} aria-label="关闭错误提示">
                ×
              </button>
            </div>
          )}

          {!workspaceId && (
            <div className="ai-panel__empty">请先打开工作区</div>
          )}

          {workspaceId && loading && sessions.length === 0 && (
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
                running={activeRuntimeSessions.has(s.id)}
                onOpen={() => onOpenSession(s.id)}
                onDelete={() => void handleDelete(s.id, s.title)}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

interface SessionItemProps {
  session: SessionSummary;
  active: boolean;
  running: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

function SessionItem({ session, active, running, onOpen, onDelete }: SessionItemProps) {
  return (
    <div
      className={"ai-panel__item" + (active ? " is-active" : "")}
      onClick={onOpen}
      title={
        running
          ? `${session.title}（后台运行中）`
          : session.title
      }
    >
      <span
        className={"ai-panel__item-status" + (running ? " is-running" : "")}
        aria-hidden
      />
      <span className="ai-panel__item-title">
        {session.title || "新对话"}
      </span>
      <span className="ai-panel__item-time">
        {formatRelative(session.updatedAt)}
      </span>
      <button
        className="ai-panel__item-del"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="删除"
      >
        <TrashIcon />
      </button>
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

function PlusIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <path
        d="M8 3v10M3 8h10"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" aria-hidden>
      <circle
        cx="7"
        cy="7"
        r="4.5"
        stroke="currentColor"
        strokeWidth="1.4"
        fill="none"
      />
      <path
        d="M10.5 10.5L14 14"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="12" height="12" aria-hidden>
      <path
        d="M3 5h10M6 5V3.5h4V5M5 5l.7 8.2c0 .4.3.8.8.8h3c.5 0 .8-.4.8-.8L11 5"
        stroke="currentColor"
        strokeWidth="1.2"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
    </svg>
  );
}
