import { useCallback, useEffect, useMemo, useState } from "react";
import {
  createWorkflow as apiCreateWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  listWorkflows as apiListWorkflows,
  type WorkflowSummary,
} from "./api";

interface AiPanelProps {
  workspaceId: string | null;
  onOpenWorkflow: (workflowId: string) => void;
  activeWorkflowId: string | null;
  refreshSignal: number;
}

export function AiPanel({
  workspaceId,
  onOpenWorkflow,
  activeWorkflowId,
  refreshSignal,
}: AiPanelProps) {
  const [workflows, setWorkflows] = useState<WorkflowSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchText, setSearchText] = useState("");

  const reload = useCallback(async () => {
    if (!workspaceId) {
      setWorkflows([]);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await apiListWorkflows(workspaceId);
      setWorkflows(list);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [workspaceId]);

  useEffect(() => {
    void reload();
  }, [reload, refreshSignal]);

  useEffect(() => {
    if (!workspaceId) return;
    const timer = window.setInterval(() => {
      void reload();
    }, 2500);
    return () => window.clearInterval(timer);
  }, [workspaceId, reload]);

  const filtered = useMemo(() => {
    if (!searchText.trim()) return workflows;
    const q = searchText.trim().toLowerCase();
    return workflows.filter((workflow) =>
      workflow.title.toLowerCase().includes(q)
    );
  }, [workflows, searchText]);

  const handleNew = async () => {
    if (!workspaceId) return;
    try {
      const workflow = await apiCreateWorkflow(workspaceId, {});
      await reload();
      onOpenWorkflow(workflow.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handleDelete = async (id: string, title: string) => {
    if (!workspaceId) return;
    if (!window.confirm(`Delete workflow "${title}"?`)) return;
    try {
      await apiDeleteWorkflow(workspaceId, id);
      await reload();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="ai-panel">
      <div className="ai-panel__brand">osheep workflows</div>

      <button
        className="ai-panel__new"
        disabled={!workspaceId}
        onClick={() => void handleNew()}
        title="New workflow"
      >
        <PlusIcon />
        <span>New workflow</span>
      </button>

      <div className="ai-panel__search">
        <SearchIcon />
        <input
          className="ai-panel__search-input"
          value={searchText}
          placeholder="Search workflows..."
          onChange={(e) => setSearchText(e.target.value)}
        />
      </div>

      {error && (
        <div className="ai-panel__error">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Close error">
            x
          </button>
        </div>
      )}

      {!workspaceId && (
        <div className="ai-panel__empty">Open a workspace first</div>
      )}

      {workspaceId && loading && workflows.length === 0 && (
        <div className="ai-panel__empty">Loading...</div>
      )}

      {workspaceId && !loading && filtered.length === 0 && (
        <div className="ai-panel__empty">
          {searchText ? "No matching workflows" : "No workflows yet"}
        </div>
      )}

      <div className="ai-panel__list">
        {filtered.map((workflow) => (
          <WorkflowItem
            key={workflow.id}
            workflow={workflow}
            active={workflow.id === activeWorkflowId}
            running={workflow.status === "running"}
            onOpen={() => onOpenWorkflow(workflow.id)}
            onDelete={() => void handleDelete(workflow.id, workflow.title)}
          />
        ))}
      </div>
    </div>
  );
}

interface WorkflowItemProps {
  workflow: WorkflowSummary;
  active: boolean;
  running: boolean;
  onOpen: () => void;
  onDelete: () => void;
}

function WorkflowItem({
  workflow,
  active,
  running,
  onOpen,
  onDelete,
}: WorkflowItemProps) {
  return (
    <div
      className={"ai-panel__item" + (active ? " is-active" : "")}
      onClick={onOpen}
      title={running ? `${workflow.title} (running)` : workflow.title}
    >
      <span
        className={"ai-panel__item-status" + (running ? " is-running" : "")}
        aria-hidden
      />
      <span className="ai-panel__item-title">
        {workflow.title || "New workflow"}
      </span>
      <span className="ai-panel__item-time">
        {running ? "RUNNING" : formatRelative(workflow.updatedAt)}
      </span>
      <button
        className="ai-panel__item-del"
        onClick={(e) => {
          e.stopPropagation();
          onDelete();
        }}
        title="Delete"
      >
        <TrashIcon />
      </button>
    </div>
  );
}

function formatRelative(ts: number): string {
  const diff = Math.max(0, Date.now() - ts);
  const m = Math.floor(diff / 60_000);
  if (m < 1) return "now";
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
