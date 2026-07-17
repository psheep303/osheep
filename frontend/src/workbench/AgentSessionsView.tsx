import { useCallback, useEffect, useState } from "react";
import {
  batchDeleteAgentSessions,
  deleteAgentSession,
  listAgentSessions,
  type AgentSessionApp,
  type AgentSessionSummary,
} from "./api";

interface AgentSessionsViewProps {
  app: AgentSessionApp;
  workspaceId: string | null;
  onResume: (session: AgentSessionSummary) => void;
}

export function AgentSessionsView({
  app,
  workspaceId,
  onResume,
}: AgentSessionsViewProps) {
  const [sessions, setSessions] = useState<AgentSessionSummary[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => new Set());
  const [deletingIds, setDeletingIds] = useState<Set<string>>(() => new Set());
  const [loading, setLoading] = useState(!!workspaceId);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) {
      setSessions([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const next = await listAgentSessions(app, workspaceId);
      setSessions(next);
      const available = new Set(next.map((session) => session.id));
      setSelectedIds((current) =>
        new Set([...current].filter((id) => available.has(id)))
      );
    } catch (loadError) {
      setError((loadError as Error).message);
    } finally {
      setLoading(false);
    }
  }, [app, workspaceId]);

  useEffect(() => {
    setSessions([]);
    setSelectedIds(new Set());
    void load();
  }, [load]);

  const remove = async (session: AgentSessionSummary) => {
    if (!workspaceId) return;
    if (!confirm(`Delete session "${session.title}"? This cannot be undone.`)) return;
    setDeletingIds(new Set([session.id]));
    setError(null);
    try {
      await deleteAgentSession(app, session.id, workspaceId);
      setSessions((current) => current.filter((item) => item.id !== session.id));
      setSelectedIds((current) => withoutIds(current, new Set([session.id])));
    } catch (deleteError) {
      setError((deleteError as Error).message);
    } finally {
      setDeletingIds(new Set());
    }
  };

  const removeSelected = async () => {
    if (!workspaceId || selectedIds.size === 0) return;
    const ids = sessions
      .filter((session) => selectedIds.has(session.id))
      .map((session) => session.id);
    if (ids.length === 0) return;
    if (!confirm(`Delete ${ids.length} selected sessions? This cannot be undone.`)) return;

    setDeletingIds(new Set(ids));
    setError(null);
    try {
      const result = await batchDeleteAgentSessions(app, ids, workspaceId);
      const deleted = new Set(result.deleted.map((session) => session.id));
      setSessions((current) => current.filter((session) => !deleted.has(session.id)));
      setSelectedIds((current) => withoutIds(current, deleted));
      if (result.failed.length > 0) {
        setError(
          `${result.failed.length} sessions could not be deleted: ${result.failed[0].message}`
        );
      }
    } catch (deleteError) {
      setError((deleteError as Error).message);
    } finally {
      setDeletingIds(new Set());
    }
  };

  const allSelected =
    sessions.length > 0 && sessions.every((session) => selectedIds.has(session.id));
  const deleting = deletingIds.size > 0;

  return (
    <div className="agent-sessions">
      <div className="agent-sessions__header">
        <div>
          <strong>Sessions</strong>
          <span>{sessions.length}</span>
        </div>
        <button
          type="button"
          className="icon-btn"
          title="Refresh sessions"
          aria-label="Refresh sessions"
          onClick={() => void load()}
          disabled={loading || !workspaceId}
        >
          <RefreshIcon />
        </button>
      </div>

      {workspaceId && sessions.length > 0 && (
        <div className="agent-sessions__bulk">
          <label>
            <input
              type="checkbox"
              checked={allSelected}
              disabled={deleting}
              onChange={() =>
                setSelectedIds(
                  allSelected ? new Set() : new Set(sessions.map((session) => session.id))
                )
              }
            />
            <span>{selectedIds.size > 0 ? `${selectedIds.size} selected` : "Select all"}</span>
          </label>
          <button
            type="button"
            className="agent-sessions__batch-delete"
            disabled={selectedIds.size === 0 || deleting}
            onClick={() => void removeSelected()}
          >
            <TrashIcon />
            <span>Delete selected</span>
          </button>
        </div>
      )}

      {error && <div className="agent-sessions__error">{error}</div>}
      <div className="agent-sessions__list">
        {!workspaceId ? (
          <div className="agent-sessions__empty">
            Open a project to manage its sessions.
          </div>
        ) : loading && sessions.length === 0 ? (
          <div className="agent-sessions__empty">Loading sessions...</div>
        ) : sessions.length === 0 ? (
          <div className="agent-sessions__empty">No sessions for this project</div>
        ) : (
          sessions.map((session) => (
            <div
              className={
                "agent-sessions__item" +
                (selectedIds.has(session.id) ? " is-selected" : "")
              }
              key={session.id}
            >
              <label className="agent-sessions__select">
                <input
                  type="checkbox"
                  checked={selectedIds.has(session.id)}
                  disabled={deleting}
                  aria-label={`Select ${session.title}`}
                  onChange={(event) =>
                    setSelectedIds((current) =>
                      toggleId(current, session.id, event.target.checked)
                    )
                  }
                />
              </label>
              <button
                type="button"
                className="agent-sessions__resume"
                title={`Resume ${session.title}\n${session.cwd}`}
                onClick={() => onResume(session)}
              >
                <span className="agent-sessions__title">{session.title}</span>
                <span className="agent-sessions__cwd">{session.cwd}</span>
                <span className="agent-sessions__time">
                  {formatSessionTime(session.updatedAt)}
                </span>
              </button>
              <button
                type="button"
                className="agent-sessions__delete"
                title="Delete session"
                aria-label={`Delete ${session.title}`}
                disabled={deleting}
                onClick={() => void remove(session)}
              >
                <TrashIcon />
              </button>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

function toggleId(current: Set<string>, id: string, selected: boolean): Set<string> {
  const next = new Set(current);
  if (selected) next.add(id);
  else next.delete(id);
  return next;
}

function withoutIds(current: Set<string>, removed: Set<string>): Set<string> {
  return new Set([...current].filter((id) => !removed.has(id)));
}

function formatSessionTime(timestamp: number): string {
  const date = new Date(timestamp);
  if (!Number.isFinite(date.getTime())) return "";
  const now = new Date();
  const sameDay = date.toDateString() === now.toDateString();
  return new Intl.DateTimeFormat(
    undefined,
    sameDay
      ? { hour: "2-digit", minute: "2-digit" }
      : { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }
  ).format(date);
}

function RefreshIcon() {
  return (
    <svg viewBox="0 0 16 16" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
      <path d="M13 5V2l-1.4 1.4A5.5 5.5 0 1 0 13.2 9" />
    </svg>
  );
}

function TrashIcon() {
  return (
    <svg viewBox="0 0 16 16" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="1.35" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3.5 4.5h9M6 4.5V3h4v1.5M5 6.5l.5 6h5l.5-6" />
    </svg>
  );
}
