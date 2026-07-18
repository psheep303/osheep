import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
import {
  createWorkflow as apiCreateWorkflow,
  deleteWorkflow as apiDeleteWorkflow,
  getWorkflow as apiGetWorkflow,
  listWorkflows as apiListWorkflows,
  saveWorkflow as apiSaveWorkflow,
  type WorkflowRecord,
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
  const [copiedWorkflow, setCopiedWorkflow] = useState<WorkflowRecord | null>(null);
  const [workflowMenu, setWorkflowMenu] = useState<{
    x: number;
    y: number;
    workflowId: string;
  } | null>(null);
  const [panelMenu, setPanelMenu] = useState<{ x: number; y: number } | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameDraft, setRenameDraft] = useState("");
  const renameCommitRef = useRef<string | null>(null);

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
    setCopiedWorkflow(null);
    setWorkflowMenu(null);
    setPanelMenu(null);
    setRenamingId(null);
  }, [workspaceId]);

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

  const handleCopy = async (id: string) => {
    if (!workspaceId) return;
    try {
      setCopiedWorkflow(await apiGetWorkflow(workspaceId, id));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const handlePaste = async () => {
    if (!workspaceId || !copiedWorkflow) return;
    try {
      const workflow = await apiCreateWorkflow(
        workspaceId,
        workflowCopy(copiedWorkflow, workflows)
      );
      await reload();
      onOpenWorkflow(workflow.id);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const beginRename = (workflow: WorkflowSummary) => {
    setRenamingId(workflow.id);
    setRenameDraft(workflow.title || "New workflow");
  };

  const commitRename = async (id: string) => {
    if (!workspaceId || renameCommitRef.current === id) return;
    const title = renameDraft.trim();
    const current = workflows.find((workflow) => workflow.id === id);
    setRenamingId(null);
    if (!title || title === current?.title) return;
    renameCommitRef.current = id;
    try {
      const workflow = await apiGetWorkflow(workspaceId, id);
      await apiSaveWorkflow(workspaceId, { ...workflow, title });
      await reload();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      renameCommitRef.current = null;
    }
  };

  const menuWorkflow = workflowMenu
    ? workflows.find((workflow) => workflow.id === workflowMenu.workflowId) ?? null
    : null;
  const workflowMenuSections: CtxMenuSection[] = menuWorkflow
    ? [
        {
          items: [
            {
              label: "复制",
              onSelect: () => void handleCopy(menuWorkflow.id),
            },
            {
              label: "重命名",
              disabled: menuWorkflow.status === "running",
              onSelect: () => beginRename(menuWorkflow),
            },
          ],
        },
        {
          items: [
            {
              label: "删除",
              danger: true,
              onSelect: () => void handleDelete(menuWorkflow.id, menuWorkflow.title),
            },
          ],
        },
      ]
    : [];
  const panelMenuSections: CtxMenuSection[] = [
    {
      items: [
        {
          label: "粘贴",
          disabled: !workspaceId || !copiedWorkflow,
          onSelect: () => void handlePaste(),
        },
      ],
    },
  ];

  return (
    <div
      className="ai-panel"
      onContextMenu={(event) => {
        const target = event.target as HTMLElement;
        if (target.closest(".ai-panel__item") || target.closest(".ctx-menu")) return;
        event.preventDefault();
        setWorkflowMenu(null);
        setPanelMenu({ x: event.clientX, y: event.clientY });
      }}
    >
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
            renaming={workflow.id === renamingId}
            renameDraft={renameDraft}
            onOpen={() => onOpenWorkflow(workflow.id)}
            onDelete={() => void handleDelete(workflow.id, workflow.title)}
            onContextMenu={(x, y) => {
              setPanelMenu(null);
              setWorkflowMenu({ x, y, workflowId: workflow.id });
            }}
            onRenameChange={setRenameDraft}
            onRenameCommit={() => void commitRename(workflow.id)}
            onRenameCancel={() => setRenamingId(null)}
          />
        ))}
      </div>

      {workflowMenu && menuWorkflow && (
        <ContextMenu
          x={workflowMenu.x}
          y={workflowMenu.y}
          sections={workflowMenuSections}
          onClose={() => setWorkflowMenu(null)}
        />
      )}
      {panelMenu && (
        <ContextMenu
          x={panelMenu.x}
          y={panelMenu.y}
          sections={panelMenuSections}
          onClose={() => setPanelMenu(null)}
        />
      )}
    </div>
  );
}

interface WorkflowItemProps {
  workflow: WorkflowSummary;
  active: boolean;
  running: boolean;
  renaming: boolean;
  renameDraft: string;
  onOpen: () => void;
  onDelete: () => void;
  onContextMenu: (x: number, y: number) => void;
  onRenameChange: (value: string) => void;
  onRenameCommit: () => void;
  onRenameCancel: () => void;
}

function WorkflowItem({
  workflow,
  active,
  running,
  renaming,
  renameDraft,
  onOpen,
  onDelete,
  onContextMenu,
  onRenameChange,
  onRenameCommit,
  onRenameCancel,
}: WorkflowItemProps) {
  return (
    <div
      className={"ai-panel__item" + (active ? " is-active" : "")}
      onClick={() => {
        if (!renaming) onOpen();
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onContextMenu(event.clientX, event.clientY);
      }}
      title={renaming ? undefined : running ? `${workflow.title} (running)` : workflow.title}
    >
      <span
        className={"ai-panel__item-status" + (running ? " is-running" : "")}
        aria-hidden
      />
      {renaming ? (
        <input
          className="ai-panel__item-rename"
          value={renameDraft}
          autoFocus
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => onRenameChange(event.target.value)}
          onBlur={onRenameCommit}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              event.currentTarget.blur();
            } else if (event.key === "Escape") {
              event.preventDefault();
              onRenameCancel();
            }
          }}
        />
      ) : (
        <span className="ai-panel__item-title">
          {workflow.title || "New workflow"}
        </span>
      )}
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

function workflowCopy(
  source: WorkflowRecord,
  workflows: WorkflowSummary[]
): Partial<WorkflowRecord> {
  const title = nextCopyTitle(source.title || "Workflow", workflows);
  return {
    title,
    nodes: source.nodes.map((node) => {
      const { runDetails: _runDetails, ...config } = node.config ?? {};
      return {
        ...node,
        status: "idle" as const,
        summary: "",
        rawOutput: "",
        error: "",
        startedAt: undefined,
        completedAt: undefined,
        config,
      };
    }),
    edges: source.edges.map((edge) => ({ ...edge })),
    runs: [],
  };
}

function nextCopyTitle(title: string, workflows: WorkflowSummary[]): string {
  const existing = new Set(workflows.map((workflow) => workflow.title));
  const base = `${title} copy`;
  if (!existing.has(base)) return base;
  let suffix = 2;
  while (existing.has(`${base} ${suffix}`)) suffix += 1;
  return `${base} ${suffix}`;
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
