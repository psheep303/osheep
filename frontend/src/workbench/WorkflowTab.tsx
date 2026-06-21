import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
import {
  aiChatStream,
  execRun,
  getWorkflow as apiGetWorkflow,
  readFile,
  saveWorkflow as apiSaveWorkflow,
  writeFile,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowProviderKind,
  type WorkflowRecord,
  type WorkflowRun,
  type WorkflowRunStatus,
} from "./api";

interface WorkflowTabProps {
  workspaceId: string;
  workflowId: string;
  onWorkflowChanged: () => void;
  onFilesChanged: () => void;
}

interface CanvasPoint {
  x: number;
  y: number;
}

interface DraftEdge extends CanvasPoint {
  from: string;
}

interface NodeDragState {
  nodeId: string;
  startX: number;
  startY: number;
  originX: number;
  originY: number;
  moved: boolean;
}

interface NodeContextMenuState {
  x: number;
  y: number;
  nodeId: string;
}

type BlockCategoryId = "condition" | "command" | "ai" | "network" | "file";

interface BlockCategory {
  id: BlockCategoryId;
  label: string;
}

interface BlockTemplate {
  category: BlockCategoryId;
  label: string;
  title: string;
  kind: WorkflowNodeKind;
  providerKind?: WorkflowProviderKind;
  model?: string;
  prompt?: string;
}

interface LocalNodeResult {
  raw: string;
  summary: string;
  changedFiles?: boolean;
  error?: string;
}

const NODE_W = 168;
const NODE_H = 46;
const CANVAS_PADDING = 180;
const SAVE_DELAY_MS = 450;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.8;
const ZOOM_STEP = 0.1;
const BLOCK_CATEGORIES: BlockCategory[] = [
  { id: "condition", label: "条件" },
  { id: "command", label: "命令" },
  { id: "ai", label: "AI" },
  { id: "network", label: "网络" },
  { id: "file", label: "文件操作" },
];
const BLOCK_TEMPLATES: BlockTemplate[] = [
  {
    category: "condition",
    label: "工作流运行时",
    title: "Workflow run",
    kind: "trigger",
  },
  {
    category: "command",
    label: "终端命令",
    title: "Run command",
    kind: "command",
  },
  {
    category: "ai",
    label: "Claude Code CLI",
    title: "Claude Code",
    kind: "agent",
    providerKind: "claude-cli",
    model: "default",
  },
  {
    category: "ai",
    label: "Codex CLI",
    title: "Codex",
    kind: "agent",
    providerKind: "codex-cli",
    model: "default",
  },
  {
    category: "network",
    label: "获取网页文本",
    title: "Fetch page text",
    kind: "web",
    prompt: "https://example.com",
  },
  {
    category: "file",
    label: "Read",
    title: "Read file",
    kind: "file-read",
  },
  {
    category: "file",
    label: "Write",
    title: "Write file",
    kind: "file-write",
  },
];

export function WorkflowTab({
  workspaceId,
  workflowId,
  onWorkflowChanged,
  onFilesChanged,
}: WorkflowTabProps) {
  const [workflow, setWorkflow] = useState<WorkflowRecord | null>(null);
  const workflowRef = useRef<WorkflowRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [draftEdge, setDraftEdge] = useState<DraftEdge | null>(null);
  const draftEdgeRef = useRef<DraftEdge | null>(null);
  const [connectHoverId, setConnectHoverId] = useState<string | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenuState | null>(null);
  const [copiedNode, setCopiedNode] = useState<WorkflowNode | null>(null);
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);
  const [blockPickerCategory, setBlockPickerCategory] =
    useState<BlockCategoryId>("condition");
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const suppressNodeClickRef = useRef<string | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<WorkflowRecord | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    void apiGetWorkflow(workspaceId, workflowId)
      .then((record) => {
        if (cancelled) return;
        workflowRef.current = record;
        setWorkflow(record);
      })
      .catch((e) => {
        if (!cancelled) setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
      if (saveTimerRef.current !== null) {
        window.clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      abortRef.current?.abort();
    };
  }, [workspaceId, workflowId]);

  const selectedNode = useMemo(
    () => workflow?.nodes.find((node) => node.id === selectedId) ?? null,
    [workflow, selectedId]
  );

  const canvasSize = useMemo(() => {
    const nodes = workflow?.nodes ?? [];
    const maxX = Math.max(
      0,
      ...nodes.map((node) => node.x + NODE_W + CANVAS_PADDING)
    );
    const maxY = Math.max(
      0,
      ...nodes.map((node) => node.y + NODE_H + CANVAS_PADDING)
    );
    return {
      width: Math.max(980, maxX),
      height: Math.max(620, maxY),
    };
  }, [workflow]);

  const persist = async (record: WorkflowRecord) => {
    const request = saveQueueRef.current
      .catch(() => undefined)
      .then(async () => {
        setSaving(true);
        try {
          await apiSaveWorkflow(workspaceId, record);
          onWorkflowChanged();
        } catch (e) {
          setError((e as Error).message);
        } finally {
          setSaving(false);
        }
      });
    saveQueueRef.current = request;
    await request;
  };

  const scheduleSave = (record: WorkflowRecord) => {
    pendingSaveRef.current = record;
    if (saveTimerRef.current !== null) window.clearTimeout(saveTimerRef.current);
    saveTimerRef.current = window.setTimeout(() => {
      saveTimerRef.current = null;
      const next = pendingSaveRef.current;
      pendingSaveRef.current = null;
      if (next) void persist(next);
    }, SAVE_DELAY_MS);
  };

  const flushPendingSave = async () => {
    if (saveTimerRef.current !== null) {
      window.clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    const next = pendingSaveRef.current;
    pendingSaveRef.current = null;
    if (next) await persist(next);
  };

  const updateWorkflow = (
    updater: (record: WorkflowRecord) => WorkflowRecord,
    save = true
  ) => {
    const current = workflowRef.current;
    if (!current) return;
    const next = updater(current);
    workflowRef.current = next;
    setWorkflow(next);
    if (save) scheduleSave(next);
  };

  const commitNow = async (record: WorkflowRecord) => {
    workflowRef.current = record;
    setWorkflow(record);
    await persist(record);
  };

  const setLiveNodePatch = (nodeId: string, patch: Partial<WorkflowNode>) => {
    const current = workflowRef.current;
    if (!current) return;
    const next = patchNode(current, nodeId, patch);
    workflowRef.current = next;
    setWorkflow(next);
  };

  const scheduleCurrentSave = () => {
    const current = workflowRef.current;
    if (current) scheduleSave(current);
  };

  const updateTitle = (title: string) => {
    updateWorkflow((record) => ({ ...record, title }));
  };

  const updateNode = (nodeId: string, patch: Partial<WorkflowNode>) => {
    updateWorkflow((record) => patchNode(record, nodeId, patch));
  };

  const moveNodeLive = (nodeId: string, x: number, y: number) => {
    updateWorkflow(
      (record) =>
        patchNode(record, nodeId, {
          x: Math.max(20, Math.round(x)),
          y: Math.max(20, Math.round(y)),
        }),
      false
    );
  };

  const addBlock = (template: BlockTemplate) => {
    const nodeId = makeId("node");
    updateWorkflow((record) => {
      const last = record.nodes[record.nodes.length - 1];
      const x = last ? last.x + NODE_W + 120 : 80;
      const y = last ? last.y : 120;
      const node = nodeFromTemplate(template, nodeId, x, y);
      return { ...record, nodes: [...record.nodes, node] };
    });
    setSelectedId(null);
    setBlockPickerOpen(false);
  };

  const deleteNode = (nodeId: string) => {
    if (!workflow || workflow.nodes.length <= 1) return;
    updateWorkflow((record) => {
      const nodes = record.nodes.filter((node) => node.id !== nodeId);
      const edges = record.edges.filter(
        (edge) => edge.from !== nodeId && edge.to !== nodeId
      );
      if (selectedId === nodeId) setSelectedId(null);
      return { ...record, nodes, edges };
    });
  };

  const copyNode = (nodeId: string) => {
    const node = workflowRef.current?.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    setCopiedNode(node);
  };

  const pasteNode = (anchorId: string) => {
    if (!copiedNode || running) return;
    const nodeId = makeId("node");
    updateWorkflow((record) => {
      const anchor = record.nodes.find((item) => item.id === anchorId);
      const kind = nodeKind(copiedNode);
      const node: WorkflowNode = {
        ...copiedNode,
        id: nodeId,
        kind,
        title:
          kind === "trigger" ? copiedNode.title : `${copiedNode.title} copy`,
        x: Math.max(20, (anchor?.x ?? copiedNode.x) + 40),
        y: Math.max(20, (anchor?.y ?? copiedNode.y) + 40),
        status: "idle",
        summary: "",
        rawOutput: "",
        error: "",
        startedAt: undefined,
        completedAt: undefined,
      };
      return { ...record, nodes: [...record.nodes, node] };
    });
    setSelectedId(nodeId);
  };

  const addEdge = (from: string, to: string) => {
    if (!from || !to || from === to) return;
    updateWorkflow((record) => {
      if (record.edges.some((edge) => edge.from === from && edge.to === to)) {
        return record;
      }
      return {
        ...record,
        edges: [
          ...record.edges,
          { id: makeId("edge"), from, to, passSummary: true },
        ],
      };
    });
  };

  const updateEdge = (edgeId: string, patch: Partial<WorkflowEdge>) => {
    updateWorkflow((record) => ({
      ...record,
      edges: record.edges.map((edge) =>
        edge.id === edgeId ? { ...edge, ...patch } : edge
      ),
    }));
  };

  const deleteEdge = (edgeId: string) => {
    updateWorkflow((record) => ({
      ...record,
      edges: record.edges.filter((edge) => edge.id !== edgeId),
    }));
  };

  const clientToCanvas = useCallback(
    (clientX: number, clientY: number): CanvasPoint => {
      const rect = canvasRef.current?.getBoundingClientRect();
      if (!rect) return { x: 0, y: 0 };
      return {
        x: (clientX - rect.left) / zoom,
        y: (clientY - rect.top) / zoom,
      };
    },
    [zoom]
  );

  const setDraftEdgeState = useCallback((next: DraftEdge | null) => {
    draftEdgeRef.current = next;
    setDraftEdge(next);
  }, []);

  const selectNodeFromClick = (nodeId: string) => {
    if (suppressNodeClickRef.current === nodeId) {
      suppressNodeClickRef.current = null;
      return;
    }
    setBlockPickerOpen(false);
    setSelectedId(nodeId);
  };

  const startNodeDrag = (
    node: WorkflowNode,
    e: ReactPointerEvent<HTMLDivElement>
  ) => {
    if (running || e.button !== 0) return;
    if ((e.target as HTMLElement).closest(".workflow-node__handle")) return;
    e.preventDefault();
    e.stopPropagation();
    setNodeMenu(null);
    const point = clientToCanvas(e.clientX, e.clientY);
    nodeDragRef.current = {
      nodeId: node.id,
      startX: point.x,
      startY: point.y,
      originX: node.x,
      originY: node.y,
      moved: false,
    };
    setDraggingNodeId(node.id);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveNodeDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = nodeDragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    const point = clientToCanvas(e.clientX, e.clientY);
    const dx = point.x - drag.startX;
    const dy = point.y - drag.startY;
    if (Math.abs(dx) > 1 || Math.abs(dy) > 1) drag.moved = true;
    moveNodeLive(drag.nodeId, drag.originX + dx, drag.originY + dy);
  };

  const finishNodeDrag = (e: ReactPointerEvent<HTMLDivElement>) => {
    const drag = nodeDragRef.current;
    if (!drag) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    nodeDragRef.current = null;
    setDraggingNodeId(null);
    if (drag.moved) {
      suppressNodeClickRef.current = drag.nodeId;
      scheduleCurrentSave();
    }
  };

  const startEdgeDrag = (
    from: string,
    e: ReactPointerEvent<HTMLButtonElement>
  ) => {
    if (running || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const point = clientToCanvas(e.clientX, e.clientY);
    setDraftEdgeState({ from, ...point });
    setConnectHoverId(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveEdgeDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const current = draftEdgeRef.current;
    if (!current) return;
    e.preventDefault();
    e.stopPropagation();
    const point = clientToCanvas(e.clientX, e.clientY);
    const hovering = findInputNodeFromPoint(e.clientX, e.clientY);
    setDraftEdgeState({ ...current, ...point });
    setConnectHoverId(hovering && hovering !== current.from ? hovering : null);
  };

  const finishEdgeDrag = (e: ReactPointerEvent<HTMLButtonElement>) => {
    const current = draftEdgeRef.current;
    if (!current) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    const hovering = findInputNodeFromPoint(e.clientX, e.clientY);
    const target = hovering && hovering !== current.from ? hovering : null;
    setDraftEdgeState(null);
    setConnectHoverId(null);
    if (target) addEdge(current.from, target);
  };

  const setZoomValue = (value: number) => {
    setZoom(clamp(Math.round(value * 10) / 10, MIN_ZOOM, MAX_ZOOM));
  };

  const handleWheelZoom = (e: ReactWheelEvent<HTMLDivElement>) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((current) =>
      clamp(Math.round((current + delta) * 10) / 10, MIN_ZOOM, MAX_ZOOM)
    );
  };

  const stopRun = () => {
    abortRef.current?.abort();
  };

  const runSelected = async () => {
    if (!selectedNode) return;
    await runNodes([selectedNode.id]);
  };

  const runWorkflow = async () => {
    if (!workflow) return;
    const ordered = topoOrder(workflow);
    if (ordered.error) {
      setError(ordered.error);
      return;
    }
    await runNodes(ordered.nodeIds);
  };

  const runNodes = async (nodeIds: string[]) => {
    let current = workflowRef.current;
    if (!current || running) return;
    await flushPendingSave();
    current = workflowRef.current;
    if (!current) return;
    const run: WorkflowRun = {
      id: makeId("run"),
      status: "running",
      startedAt: Date.now(),
      nodeIds,
    };
    const resetIds = new Set(nodeIds);
    current = {
      ...current,
      nodes: current.nodes.map((node) =>
        resetIds.has(node.id)
          ? {
              ...node,
              status: "idle",
              summary: "",
              rawOutput: "",
              error: "",
              startedAt: undefined,
              completedAt: undefined,
            }
          : node
      ),
      runs: [...current.runs.slice(-49), run],
    };
    setRunning(true);
    setError(null);
    await commitNow(current);

    try {
      for (const nodeId of nodeIds) {
        current = workflowRef.current;
        const node = current?.nodes.find((item) => item.id === nodeId);
        if (!current || !node) continue;
        const startedAt = Date.now();
        const kind = nodeKind(node);
        if (kind === "trigger") {
          current = patchNode(current, nodeId, {
            status: "success",
            rawOutput: "Workflow run trigger fired.",
            summary: "STATUS: success\nSUMMARY:\n- Workflow run trigger fired.",
            error: "",
            startedAt,
            completedAt: Date.now(),
          });
          await commitNow(current);
          continue;
        }
        setBlockPickerOpen(false);
        setSelectedId(nodeId);
        current = patchNode(current, nodeId, {
          status: "running",
          rawOutput: "",
          summary: "",
          error: "",
          startedAt,
          completedAt: undefined,
        });
        await commitNow(current);

        if (kind !== "agent") {
          const local = await executeLocalNode(workspaceId, node);
          current = workflowRef.current ?? current;
          if (local.error) {
            current = patchNode(current, nodeId, {
              status: "error",
              rawOutput: local.raw,
              summary: local.summary,
              error: local.error,
              completedAt: Date.now(),
            });
            await commitNow(current);
            throw new Error(local.error);
          }
          current = patchNode(current, nodeId, {
            status: "success",
            rawOutput: local.raw,
            summary: local.summary,
            error: "",
            completedAt: Date.now(),
          });
          await commitNow(current);
          if (local.changedFiles) onFilesChanged();
          continue;
        }

        if (!node.prompt.trim()) {
          throw new Error(`${node.title} has no prompt.`);
        }
        const ac = new AbortController();
        abortRef.current = ac;
        let raw = "";
        let lastUiAt = 0;
        const prompt = buildBlockPrompt(current, node);
        const result = await aiChatStream(
          workspaceId,
          {
            model: node.model || "default",
            kind: node.providerKind,
            messages: [{ role: "user", content: prompt }],
          },
          (chunk) => {
            raw += chunk;
            const now = Date.now();
            if (now - lastUiAt > 160) {
              lastUiAt = now;
              setLiveNodePatch(nodeId, { rawOutput: raw });
            }
          },
          ac.signal
        );
        abortRef.current = null;
        raw =
          result.content ||
          raw ||
          `${node.providerKind === "codex-cli" ? "Codex CLI" : "Claude Code CLI"} completed without text output.`;
        current = workflowRef.current ?? current;
        if (result.aborted) {
          current = patchNode(current, nodeId, {
            status: "error",
            rawOutput: raw,
            error: "Stopped",
            completedAt: Date.now(),
          });
          current = finishRun(current, run.id, "stopped", "Stopped");
          await commitNow(current);
          return;
        }
        current = patchNode(current, nodeId, {
          status: "success",
          rawOutput: raw,
          summary: extractSummary(raw),
          error: "",
          completedAt: Date.now(),
        });
        await commitNow(current);
        onFilesChanged();
      }
      current = workflowRef.current;
      if (current) {
        current = finishRun(current, run.id, "success");
        await commitNow(current);
      }
    } catch (e) {
      const message = (e as Error).message;
      current = workflowRef.current;
      if (current) {
        const activeNode = current.nodes.find((node) => node.status === "running");
        if (activeNode) {
          current = patchNode(current, activeNode.id, {
            status: "error",
            error: message,
            completedAt: Date.now(),
          });
        }
        current = finishRun(current, run.id, "error", message);
        await commitNow(current);
      }
      setError(message);
    } finally {
      abortRef.current = null;
      setRunning(false);
    }
  };

  if (loading) return <div className="empty-hint">Loading workflow...</div>;
  if (!workflow) {
    return <div className="empty-hint">{error ?? "Workflow failed to load."}</div>;
  }

  const scaledCanvasStyle: CSSProperties = {
    width: canvasSize.width * zoom,
    height: canvasSize.height * zoom,
  };
  const canvasStyle: CSSProperties = {
    width: canvasSize.width,
    height: canvasSize.height,
    transform: `scale(${zoom})`,
  };
  const draftFrom = draftEdge
    ? workflow.nodes.find((node) => node.id === draftEdge.from)
    : null;
  const menuNode = nodeMenu
    ? workflow.nodes.find((node) => node.id === nodeMenu.nodeId)
    : null;
  const nodeMenuSections: CtxMenuSection[] = menuNode
    ? [
        {
          items: [
            {
              label: "Copy block",
              shortcut: "Ctrl+C",
              onSelect: () => copyNode(menuNode.id),
            },
            {
              label: "Paste block",
              shortcut: "Ctrl+V",
              disabled: running || !copiedNode,
              onSelect: () => pasteNode(menuNode.id),
            },
          ],
        },
        {
          items: [
            {
              label: "Delete block",
              shortcut: "Del",
              danger: true,
              disabled: running || workflow.nodes.length <= 1,
              onSelect: () => deleteNode(menuNode.id),
            },
          ],
        },
      ]
    : [];

  return (
    <div className="workflow-tab">
      <div className="workflow-toolbar">
        <input
          className="workflow-toolbar__title"
          value={workflow.title}
          onChange={(e) => updateTitle(e.target.value)}
          title="Workflow title"
        />
        <div className="workflow-toolbar__status">
          {saving ? "Saving" : running ? "Running" : "Saved"}
        </div>
        <button
          className="workflow-toolbar__btn"
          onClick={() => {
            setSelectedId(null);
            setNodeMenu(null);
            setBlockPickerOpen(true);
          }}
        >
          Add block
        </button>
        <div className="workflow-toolbar__zoom">
          <button
            className="workflow-toolbar__btn"
            onClick={() => setZoomValue(zoom - ZOOM_STEP)}
            disabled={zoom <= MIN_ZOOM}
            title="Zoom out"
          >
            -
          </button>
          <input
            type="range"
            min={MIN_ZOOM}
            max={MAX_ZOOM}
            step={ZOOM_STEP}
            value={zoom}
            onChange={(e) => setZoomValue(Number(e.target.value))}
            aria-label="Zoom"
          />
          <span>{Math.round(zoom * 100)}%</span>
          <button
            className="workflow-toolbar__btn"
            onClick={() => setZoomValue(zoom + ZOOM_STEP)}
            disabled={zoom >= MAX_ZOOM}
            title="Zoom in"
          >
            +
          </button>
        </div>
        <span className="workflow-toolbar__spacer" />
        <button
          className="workflow-toolbar__btn"
          onClick={() => void runSelected()}
          disabled={running || !selectedNode}
        >
          Run block
        </button>
        {running ? (
          <button className="workflow-toolbar__btn is-danger" onClick={stopRun}>
            Stop
          </button>
        ) : (
          <button
            className="workflow-toolbar__btn is-primary"
            onClick={() => void runWorkflow()}
          >
            Run workflow
          </button>
        )}
      </div>

      {error && (
        <div className="workflow-error">
          <span>{error}</span>
          <button onClick={() => setError(null)} aria-label="Close error">
            x
          </button>
        </div>
      )}

      <div className="workflow-body">
        <div
          className="workflow-canvas-wrap"
          onWheel={handleWheelZoom}
          style={{
            backgroundSize: `${32 * zoom}px ${32 * zoom}px, ${32 * zoom}px ${
              32 * zoom
            }px, auto`,
          }}
        >
          <div className="workflow-canvas-viewport" style={scaledCanvasStyle}>
            <div
              ref={canvasRef}
              className="workflow-canvas"
              style={canvasStyle}
              onPointerDown={(e) => {
                setNodeMenu(null);
                if (e.target === e.currentTarget) setSelectedId(null);
              }}
            >
              <svg
                className="workflow-edges"
                width={canvasSize.width}
                height={canvasSize.height}
                aria-hidden
              >
                <defs>
                  <marker
                    id="workflow-arrow"
                    viewBox="0 0 10 10"
                    refX="9"
                    refY="5"
                    markerWidth="6"
                    markerHeight="6"
                    orient="auto-start-reverse"
                  >
                    <path d="M 0 0 L 10 5 L 0 10 z" />
                  </marker>
                </defs>
                {workflow.edges.map((edge) => {
                  const from = workflow.nodes.find((node) => node.id === edge.from);
                  const to = workflow.nodes.find((node) => node.id === edge.to);
                  if (!from || !to) return null;
                  return (
                    <path
                      key={edge.id}
                      className={
                        "workflow-edge" + (edge.passSummary ? "" : " is-muted")
                      }
                      d={edgePath(from, to)}
                      markerEnd="url(#workflow-arrow)"
                    />
                  );
                })}
                {draftEdge && draftFrom && (
                  <path
                    className="workflow-edge is-draft"
                    d={edgePathToPoint(draftFrom, draftEdge)}
                    markerEnd="url(#workflow-arrow)"
                  />
                )}
              </svg>

              {workflow.nodes.map((node) => (
                <WorkflowNodeBlock
                  key={node.id}
                  node={node}
                  selected={node.id === selectedId}
                  running={running}
                  dragging={node.id === draggingNodeId}
                  connectHover={node.id === connectHoverId}
                  onSelect={() => selectNodeFromClick(node.id)}
                  onContextMenu={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    setBlockPickerOpen(false);
                    setNodeMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
                  }}
                  onNodePointerDown={(e) => startNodeDrag(node, e)}
                  onNodePointerMove={moveNodeDrag}
                  onNodePointerUp={finishNodeDrag}
                  onNodePointerCancel={finishNodeDrag}
                  onStartEdgeDrag={(e) => startEdgeDrag(node.id, e)}
                  onMoveEdgeDrag={moveEdgeDrag}
                  onFinishEdgeDrag={finishEdgeDrag}
                />
              ))}
            </div>
          </div>
        </div>

        {selectedNode && !blockPickerOpen && (
          <div className="workflow-panel-shell">
            <WorkflowNodeInspector
              node={selectedNode}
              nodes={workflow.nodes}
              edges={workflow.edges}
              running={running}
              onUpdate={(patch) => updateNode(selectedNode.id, patch)}
              onClose={() => setSelectedId(null)}
              onDelete={() => deleteNode(selectedNode.id)}
              onUpdateEdge={updateEdge}
              onDeleteEdge={deleteEdge}
            />
          </div>
        )}
        {blockPickerOpen && (
          <div className="workflow-panel-shell">
            <WorkflowBlockPicker
              category={blockPickerCategory}
              onCategoryChange={setBlockPickerCategory}
              onAdd={addBlock}
              onClose={() => setBlockPickerOpen(false)}
            />
          </div>
        )}
      </div>
      {nodeMenu && menuNode && (
        <ContextMenu
          x={nodeMenu.x}
          y={nodeMenu.y}
          sections={nodeMenuSections}
          onClose={() => setNodeMenu(null)}
        />
      )}
    </div>
  );
}

function WorkflowBlockPicker({
  category,
  onCategoryChange,
  onAdd,
  onClose,
}: {
  category: BlockCategoryId;
  onCategoryChange: (category: BlockCategoryId) => void;
  onAdd: (template: BlockTemplate) => void;
  onClose: () => void;
}) {
  const templates = BLOCK_TEMPLATES.filter((item) => item.category === category);

  return (
    <section className="workflow-block-picker">
      <div className="workflow-panel__head">
        <div className="workflow-inspector__eyebrow">Blocks</div>
        <button
          type="button"
          className="workflow-inspector__close"
          onClick={onClose}
          aria-label="Close blocks"
          title="Close"
        >
          x
        </button>
      </div>
      <div className="workflow-block-picker__body">
        <nav className="workflow-block-picker__categories">
          {BLOCK_CATEGORIES.map((item) => (
            <button
              key={item.id}
              type="button"
              className={item.id === category ? "is-active" : ""}
              onClick={() => onCategoryChange(item.id)}
            >
              {item.label}
            </button>
          ))}
        </nav>
        <div className="workflow-block-picker__items">
          {templates.map((template) => (
            <button
              key={`${template.category}:${template.label}`}
              type="button"
              onClick={() => onAdd(template)}
            >
              {template.label}
            </button>
          ))}
        </div>
      </div>
    </section>
  );
}

function WorkflowNodeBlock({
  node,
  selected,
  running,
  dragging,
  connectHover,
  onSelect,
  onContextMenu,
  onNodePointerDown,
  onNodePointerMove,
  onNodePointerUp,
  onNodePointerCancel,
  onStartEdgeDrag,
  onMoveEdgeDrag,
  onFinishEdgeDrag,
}: {
  node: WorkflowNode;
  selected: boolean;
  running: boolean;
  dragging: boolean;
  connectHover: boolean;
  onSelect: () => void;
  onContextMenu: (e: ReactMouseEvent<HTMLDivElement>) => void;
  onNodePointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onNodePointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onNodePointerUp: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onNodePointerCancel: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onStartEdgeDrag: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onMoveEdgeDrag: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onFinishEdgeDrag: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const nodeStyle: CSSProperties = {
    left: node.x,
    top: node.y,
    width: NODE_W,
    height: NODE_H,
  };
  const className =
    "workflow-node" +
    (selected ? " is-selected" : "") +
    (dragging ? " is-dragging" : "") +
    ` is-${nodeKind(node)}` +
    ` is-${node.status}`;

  return (
    <div
      className={className}
      style={nodeStyle}
      title={`${node.title} (${node.status})`}
      onClick={onSelect}
      onContextMenu={onContextMenu}
      onPointerDown={onNodePointerDown}
      onPointerMove={onNodePointerMove}
      onPointerUp={onNodePointerUp}
      onPointerCancel={onNodePointerCancel}
    >
      <button
        type="button"
        className={
          "workflow-node__handle workflow-node__handle--in" +
          (connectHover ? " is-connect-hover" : "")
        }
        data-workflow-input-id={node.id}
        aria-label="Input connector"
        title="Input"
        disabled={running}
        onPointerDown={(e) => e.stopPropagation()}
      />
      <span className="workflow-node__name">{node.title}</span>
      <button
        type="button"
        className="workflow-node__handle workflow-node__handle--out"
        aria-label="Output connector"
        title="Output"
        disabled={running}
        onPointerDown={onStartEdgeDrag}
        onPointerMove={onMoveEdgeDrag}
        onPointerUp={onFinishEdgeDrag}
        onPointerCancel={onFinishEdgeDrag}
      />
    </div>
  );
}

function WorkflowNodeInspector({
  node,
  nodes,
  edges,
  running,
  onUpdate,
  onClose,
  onDelete,
  onUpdateEdge,
  onDeleteEdge,
}: {
  node: WorkflowNode;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  running: boolean;
  onUpdate: (patch: Partial<WorkflowNode>) => void;
  onClose: () => void;
  onDelete: () => void;
  onUpdateEdge: (edgeId: string, patch: Partial<WorkflowEdge>) => void;
  onDeleteEdge: (edgeId: string) => void;
}) {
  const outgoing = edges.filter((edge) => edge.from === node.id);
  const incoming = edges.filter((edge) => edge.to === node.id);
  const bodyText = node.rawOutput || node.summary || node.error || "";
  const kind = nodeKind(node);
  const isTrigger = kind === "trigger";
  const isAgent = kind === "agent";

  return (
    <aside className="workflow-inspector">
      <div className="workflow-inspector__head">
        <div>
          <div className="workflow-inspector__eyebrow">
            {blockEyebrow(kind)}
          </div>
          <span className={`workflow-inspector__status is-${node.status}`}>
            {node.status}
          </span>
        </div>
        <button
          type="button"
          className="workflow-inspector__close"
          onClick={onClose}
          aria-label="Close details"
          title="Close"
        >
          x
        </button>
      </div>

      <label className="workflow-inspector__field">
        <span>Name</span>
        <input
          value={node.title}
          onChange={(e) => onUpdate({ title: e.target.value })}
          disabled={running}
        />
      </label>

      {isAgent && (
        <>
          <div className="workflow-inspector__segmented">
            <button
              className={node.providerKind === "codex-cli" ? "is-active" : ""}
              onClick={() =>
                onUpdate({ providerKind: "codex-cli", model: "default" })
              }
              disabled={running}
            >
              Codex
            </button>
            <button
              className={node.providerKind === "claude-cli" ? "is-active" : ""}
              onClick={() =>
                onUpdate({ providerKind: "claude-cli", model: "default" })
              }
              disabled={running}
            >
              Claude
            </button>
          </div>

          <label className="workflow-inspector__field">
            <span>Model</span>
            <input
              value={node.model}
              onChange={(e) => onUpdate({ model: e.target.value || "default" })}
              disabled={running}
            />
          </label>
        </>
      )}

      {!isTrigger && (
        <label className="workflow-inspector__field">
          <span>{inputLabelForKind(kind)}</span>
          <textarea
            value={node.prompt}
            onChange={(e) => onUpdate({ prompt: e.target.value })}
            disabled={running}
          />
        </label>
      )}

      {incoming.length > 0 && (
        <div className="workflow-inspector__section">
          <div className="workflow-inspector__section-title">Incoming</div>
          <div className="workflow-inspector__chips">
            {incoming.map((edge) => {
              const source = nodes.find((item) => item.id === edge.from);
              return (
                <span key={edge.id} className="workflow-inspector__chip">
                  {source?.title ?? edge.from}
                </span>
              );
            })}
          </div>
        </div>
      )}

      {outgoing.length > 0 && (
        <div className="workflow-inspector__section">
          <div className="workflow-inspector__section-title">Outgoing</div>
          <div className="workflow-inspector__edges">
            {outgoing.map((edge) => {
              const target = nodes.find((item) => item.id === edge.to);
              return (
                <div key={edge.id} className="workflow-inspector__edge">
                  <span>{target?.title ?? edge.to}</span>
                  <button
                    className={edge.passSummary ? "is-active" : ""}
                    onClick={() =>
                      onUpdateEdge(edge.id, { passSummary: !edge.passSummary })
                    }
                    disabled={running}
                    title="Toggle summary passing"
                  >
                    summary
                  </button>
                  <button
                    onClick={() => onDeleteEdge(edge.id)}
                    disabled={running}
                    title="Delete edge"
                  >
                    x
                  </button>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="workflow-inspector__section workflow-inspector__section--grow">
        <div className="workflow-inspector__section-title">Output</div>
        <pre className="workflow-inspector__output">
          {bodyText || "No summary yet."}
        </pre>
      </div>

      <div className="workflow-inspector__foot">
        <button onClick={onDelete} disabled={running || nodes.length <= 1}>
          Delete
        </button>
      </div>
    </aside>
  );
}

function patchNode(
  record: WorkflowRecord,
  nodeId: string,
  patch: Partial<WorkflowNode>
): WorkflowRecord {
  return {
    ...record,
    nodes: record.nodes.map((node) =>
      node.id === nodeId ? { ...node, ...patch } : node
    ),
  };
}

function finishRun(
  record: WorkflowRecord,
  runId: string,
  status: WorkflowRunStatus,
  error?: string
): WorkflowRecord {
  return {
    ...record,
    runs: record.runs.map((run) =>
      run.id === runId
        ? {
            ...run,
            status,
            completedAt: Date.now(),
            error,
          }
        : run
    ),
  };
}

function topoOrder(record: WorkflowRecord): { nodeIds: string[]; error?: string } {
  const nodeIds = new Set(record.nodes.map((node) => node.id));
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of record.nodes) {
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of record.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = record.nodes
    .filter((node) => (indegree.get(node.id) ?? 0) === 0)
    .map((node) => node.id);
  const ordered: string[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    ordered.push(id);
    for (const to of outgoing.get(id) ?? []) {
      const next = (indegree.get(to) ?? 0) - 1;
      indegree.set(to, next);
      if (next === 0) queue.push(to);
    }
  }
  if (ordered.length !== record.nodes.length) {
    return { nodeIds: [], error: "Workflow has a cycle." };
  }
  return { nodeIds: ordered };
}

async function executeLocalNode(
  workspaceId: string,
  node: WorkflowNode
): Promise<LocalNodeResult> {
  const input = node.prompt.trim();
  const kind = nodeKind(node);
  if (!input) throw new Error(`${node.title} has no input.`);

  if (kind === "command") {
    const result = await execRun(workspaceId, {
      command: input,
      timeoutMs: 600_000,
    });
    const raw = formatRunResult(result);
    const failed = result.exitCode !== 0;
    return {
      raw,
      summary: localSummary(failed ? "failed" : "success", raw),
      changedFiles: !failed,
      error: failed ? `${node.title} exited with ${result.exitCode ?? "signal"}.` : undefined,
    };
  }

  if (kind === "web") {
    const result = await execRun(workspaceId, {
      command: buildFetchCommand(input),
      shell: "cmd",
      timeoutMs: 120_000,
    });
    const raw = formatRunResult(result);
    const failed = result.exitCode !== 0;
    return {
      raw,
      summary: localSummary(failed ? "failed" : "success", result.stdout || raw),
      error: failed ? `Failed to fetch ${input}.` : undefined,
    };
  }

  if (kind === "file-read") {
    const file = await readFile(workspaceId, input);
    return {
      raw: file.content,
      summary: localSummary("success", `Read ${input}\n${file.content}`),
    };
  }

  if (kind === "file-write") {
    const parsed = parseFileWriteInput(node.prompt);
    if (!parsed.path) throw new Error(`${node.title} has no path.`);
    await writeFile(workspaceId, parsed.path, parsed.content, true);
    return {
      raw: `Wrote ${parsed.path}\n${parsed.content}`,
      summary: localSummary("success", `Wrote ${parsed.path}`),
      changedFiles: true,
    };
  }

  throw new Error(`${node.title} cannot run as a local block.`);
}

function buildBlockPrompt(record: WorkflowRecord, node: WorkflowNode): string {
  const incoming = record.edges
    .filter((edge) => edge.to === node.id && edge.passSummary)
    .map((edge) => record.nodes.find((item) => item.id === edge.from))
    .filter((item): item is WorkflowNode => !!item)
    .map((source) => {
      const summary = source.summary?.trim() || "No summary was produced.";
      return `### ${source.title}\n${summary}`;
    });

  return [
    `You are executing osheep workflow block "${node.title}".`,
    "Run as a local coding agent in the current project root.",
    "Inspect, edit, and verify files directly with your native CLI capabilities.",
    "Do not ask the host for chat-style clarification unless the task is impossible.",
    "",
    "Incoming summaries:",
    incoming.length ? incoming.join("\n\n") : "None.",
    "",
    "Block prompt:",
    node.prompt,
    "",
    "When finished, print this exact summary envelope and nothing after it:",
    "<osheep-summary>",
    "STATUS: success|blocked|failed",
    "CHANGED_FILES:",
    "- path or none",
    "VERIFICATION:",
    "- command/result or not run",
    "SUMMARY:",
    "- concise result",
    "NEXT:",
    "- useful handoff for downstream blocks or none",
    "</osheep-summary>",
  ].join("\n");
}

function extractSummary(raw: string): string {
  const startTag = "<osheep-summary>";
  const endTag = "</osheep-summary>";
  const start = raw.indexOf(startTag);
  const end = raw.indexOf(endTag);
  if (start >= 0 && end > start) {
    return raw.slice(start + startTag.length, end).trim();
  }
  const trimmed = raw.trim();
  return trimmed || "No summary returned.";
}

function localSummary(status: "success" | "failed", raw: string): string {
  const text = raw.trim().slice(0, 2400) || "No output.";
  return [
    `STATUS: ${status}`,
    "CHANGED_FILES:",
    "- unknown",
    "VERIFICATION:",
    "- workflow local block executed",
    "SUMMARY:",
    text,
    "NEXT:",
    "- none",
  ].join("\n");
}

function formatRunResult(result: Awaited<ReturnType<typeof execRun>>): string {
  return [
    `$ ${result.command}`,
    `shell: ${result.shell ?? "auto"}`,
    `exit: ${result.exitCode ?? result.signal ?? "unknown"}`,
    result.stdout ? `\nstdout:\n${result.stdout}` : "",
    result.stderr ? `\nstderr:\n${result.stderr}` : "",
    result.truncated ? "\n[output truncated]" : "",
  ]
    .filter(Boolean)
    .join("\n");
}

function buildFetchCommand(url: string): string {
  const script = [
    "const url=process.argv[1];",
    "fetch(url).then(async res=>{",
    "const html=await res.text();",
    "const text=html",
    ".replace(/<script[\\s\\S]*?<\\/script>/gi,' ')",
    ".replace(/<style[\\s\\S]*?<\\/style>/gi,' ')",
    ".replace(/<[^>]+>/g,' ')",
    ".replace(/\\s+/g,' ')",
    ".trim();",
    "console.log(text.slice(0,20000));",
    "}).catch(err=>{console.error(err.message);process.exit(1);});",
  ].join("");
  return `node -e "${cmdArg(script)}" "${cmdArg(url)}"`;
}

function cmdArg(value: string): string {
  return value.replace(/"/g, '\\"');
}

function parseFileWriteInput(raw: string): { path: string; content: string } {
  const normalized = raw.replace(/\r\n/g, "\n");
  const nl = normalized.indexOf("\n");
  if (nl === -1) return { path: normalized.trim(), content: "" };
  return {
    path: normalized.slice(0, nl).trim(),
    content: normalized.slice(nl + 1),
  };
}

function edgePath(from: WorkflowNode, to: WorkflowNode): string {
  return bezierPath(outputPoint(from), inputPoint(to));
}

function edgePathToPoint(from: WorkflowNode, point: CanvasPoint): string {
  return bezierPath(outputPoint(from), point);
}

function inputPoint(node: WorkflowNode): CanvasPoint {
  return { x: node.x, y: node.y + NODE_H / 2 };
}

function outputPoint(node: WorkflowNode): CanvasPoint {
  return { x: node.x + NODE_W, y: node.y + NODE_H / 2 };
}

function bezierPath(start: CanvasPoint, end: CanvasPoint): string {
  const bend = Math.max(56, Math.abs(end.x - start.x) / 2);
  return `M ${start.x} ${start.y} C ${start.x + bend} ${start.y}, ${
    end.x - bend
  } ${end.y}, ${end.x} ${end.y}`;
}

function findInputNodeFromPoint(clientX: number, clientY: number): string | null {
  const element = document.elementFromPoint(clientX, clientY);
  const handle = element?.closest("[data-workflow-input-id]") as HTMLElement | null;
  return handle?.dataset.workflowInputId ?? null;
}

function blockEyebrow(kind: WorkflowNodeKind): string {
  if (kind === "trigger") return "Condition";
  if (kind === "command") return "Command";
  if (kind === "web") return "Network";
  if (kind === "file-read" || kind === "file-write") return "File";
  return "AI";
}

function inputLabelForKind(kind: WorkflowNodeKind): string {
  if (kind === "command") return "Command";
  if (kind === "web") return "URL";
  if (kind === "file-read") return "Path";
  if (kind === "file-write") return "Path / content";
  return "Prompt";
}

function nodeKind(node: WorkflowNode): WorkflowNodeKind {
  if (
    node.kind === "trigger" ||
    node.kind === "command" ||
    node.kind === "web" ||
    node.kind === "file-read" ||
    node.kind === "file-write"
  ) {
    return node.kind;
  }
  return "agent";
}

function nodeFromTemplate(
  template: BlockTemplate,
  id: string,
  x: number,
  y: number
): WorkflowNode {
  return {
    id,
    kind: template.kind,
    title: template.title,
    providerKind: template.providerKind ?? "codex-cli",
    model: template.model ?? "default",
    prompt: template.prompt ?? "",
    x,
    y,
    status: "idle",
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
