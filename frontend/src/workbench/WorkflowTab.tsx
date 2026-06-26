import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type WheelEvent as ReactWheelEvent,
} from "react";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
import {
  aiChatStream,
  callRemoteMcp,
  discoverRemoteMcp,
  execRun,
  execRunStream,
  getWorkflow as apiGetWorkflow,
  readFile,
  saveWorkflow as apiSaveWorkflow,
  writeFile,
  type RunResult,
  type RemoteMcpTool,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowProviderKind,
  type WorkflowRecord,
  type WorkflowRun,
  type WorkflowRunStatus,
} from "./api";
import { MarkdownPreview } from "./MarkdownPreview";

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

interface EdgeContextMenuState {
  x: number;
  y: number;
  edgeId: string;
}

interface CanvasPanState {
  pointerId: number;
  startX: number;
  startY: number;
  scrollLeft: number;
  scrollTop: number;
  moved: boolean;
}

type BlockCategoryId = "condition" | "command" | "ai" | "network" | "file" | "output";
type WorkflowIconName =
  | "trigger"
  | "command"
  | "ai"
  | "network"
  | "file"
  | "output"
  | "claude"
  | "codex"
  | "web"
  | "read"
  | "write"
  | "markdown"
  | "mcp";

interface BlockCategory {
  id: BlockCategoryId;
  label: string;
  icon: WorkflowIconName;
}

interface BlockTemplate {
  category: BlockCategoryId;
  label: string;
  title: string;
  kind: WorkflowNodeKind;
  providerKind?: WorkflowProviderKind;
  model?: string;
  prompt?: string;
  icon: WorkflowIconName;
  config?: Record<string, unknown>;
}

interface LocalNodeResult {
  output: WorkflowBlockOutput;
  changedFiles?: boolean;
  error?: string;
  nodePatch?: Partial<WorkflowNode>;
}

type WorkflowBlockOutput = Record<string, unknown>;

const DEFAULT_MCP_HEADERS_JSON = JSON.stringify(
  {
    "MCP-Protocol-Version": "2025-03-26",
  },
  null,
  2
);

interface McpNodeConfig {
  remoteLink: string;
  postUrl: string;
  headers: string;
  apiKey: string;
  toolName: string;
  arguments: string;
  tools: RemoteMcpTool[];
  connectedAt?: number;
  connectionStatus: string;
  connectionError: string;
}

interface McpRuntimeTool {
  node: WorkflowNode;
  config: McpNodeConfig;
  tool: RemoteMcpTool;
}

interface WorkflowRunDetailSnapshot {
  kind: "agent" | "command";
  title: string;
  status: "running" | "success" | "error" | "stopped";
  startedAt: number;
  completedAt?: number;
  commandLine: string;
  stdout: string;
  stderr: string;
  transcript: string;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
}

const NODE_W = 168;
const NODE_H = 46;
const CANVAS_PADDING = 180;
const SAVE_DELAY_MS = 450;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.8;
const ZOOM_STEP = 0.1;
const BLOCK_CATEGORIES: BlockCategory[] = [
  { id: "condition", label: "条件", icon: "trigger" },
  { id: "command", label: "命令", icon: "command" },
  { id: "ai", label: "AI", icon: "ai" },
  { id: "network", label: "网络", icon: "network" },
  { id: "file", label: "文件操作", icon: "file" },
  { id: "output", label: "输出", icon: "output" },
];
const BLOCK_TEMPLATES: BlockTemplate[] = [
  {
    category: "condition",
    label: "工作流运行时",
    title: "Workflow run",
    kind: "trigger",
    icon: "trigger",
  },
  {
    category: "command",
    label: "终端命令",
    title: "Run command",
    kind: "command",
    icon: "command",
  },
  {
    category: "ai",
    label: "Claude Code CLI",
    title: "Claude Code",
    kind: "agent",
    providerKind: "claude-cli",
    model: "default",
    icon: "claude",
  },
  {
    category: "ai",
    label: "Codex CLI",
    title: "Codex",
    kind: "agent",
    providerKind: "codex-cli",
    model: "default",
    icon: "codex",
  },
  {
    category: "network",
    label: "获取网页文本",
    title: "Fetch page text",
    kind: "web",
    prompt: "https://example.com",
    icon: "web",
  },
  {
    category: "file",
    label: "Read",
    title: "Read file",
    kind: "file-read",
    icon: "read",
  },
  {
    category: "file",
    label: "Write",
    title: "Write file",
    kind: "file-write",
    icon: "write",
    config: { path: "", content: "" },
  },
  {
    category: "output",
    label: "Markdown render",
    title: "Markdown",
    kind: "markdown",
    prompt: "## Result\n\n{{blocks[2].text}}",
    icon: "markdown",
  },
  {
    category: "output",
    label: "MCP tool",
    title: "MCP",
    kind: "mcp",
    icon: "mcp",
    config: {
      remoteLink: "",
      postUrl: "",
      headers: DEFAULT_MCP_HEADERS_JSON,
      apiKey: "",
      toolName: "",
      arguments: "{}",
      tools: [],
      connectionStatus: "",
      connectionError: "",
    },
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
  const [panningCanvas, setPanningCanvas] = useState(false);
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenuState | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<EdgeContextMenuState | null>(null);
  const [copiedNode, setCopiedNode] = useState<WorkflowNode | null>(null);
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);
  const [blockPickerCategory, setBlockPickerCategory] =
    useState<BlockCategoryId>("condition");
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const [mpeNodeId, setMpeNodeId] = useState<string | null>(null);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const suppressNodeClickRef = useRef<string | null>(null);
  const canvasPanRef = useRef<CanvasPanState | null>(null);
  const suppressContextMenuRef = useRef(false);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<WorkflowRecord | null>(null);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);
  const undoStackRef = useRef<WorkflowRecord[]>([]);
  const redoStackRef = useRef<WorkflowRecord[]>([]);
  const [historyTick, setHistoryTick] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setSelectedId(null);
    void apiGetWorkflow(workspaceId, workflowId)
      .then((record) => {
        if (cancelled) return;
        undoStackRef.current = [];
        redoStackRef.current = [];
        setHistoryTick((tick) => tick + 1);
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
    save = true,
    recordHistory = false
  ) => {
    const current = workflowRef.current;
    if (!current) return;
    const next = updater(current);
    if (next === current) return;
    if (recordHistory) pushHistory(current);
    workflowRef.current = next;
    setWorkflow(next);
    if (save) scheduleSave(next);
  };

  const pushHistory = (record: WorkflowRecord) => {
    undoStackRef.current = [...undoStackRef.current.slice(-99), cloneWorkflow(record)];
    redoStackRef.current = [];
    setHistoryTick((tick) => tick + 1);
  };

  const restoreHistory = (record: WorkflowRecord) => {
    const current = workflowRef.current;
    const next = current ? restoreTopologyOnly(record, current) : record;
    workflowRef.current = next;
    setWorkflow(next);
    if (selectedId && !next.nodes.some((node) => node.id === selectedId)) {
      setSelectedId(null);
    }
    scheduleSave(next);
    setHistoryTick((tick) => tick + 1);
  };

  const undo = useCallback(() => {
    if (running) return;
    const current = workflowRef.current;
    const previous = undoStackRef.current.pop();
    if (!current || !previous) return;
    redoStackRef.current = [...redoStackRef.current.slice(-99), cloneWorkflow(current)];
    restoreHistory(previous);
  }, [running]);

  const redo = useCallback(() => {
    if (running) return;
    const current = workflowRef.current;
    const next = redoStackRef.current.pop();
    if (!current || !next) return;
    undoStackRef.current = [...undoStackRef.current.slice(-99), cloneWorkflow(current)];
    restoreHistory(next);
  }, [running]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const mod = event.ctrlKey || event.metaKey;
      if (!mod) return;
      const key = event.key.toLowerCase();
      if (key === "z") {
        event.preventDefault();
        if (event.shiftKey) redo();
        else undo();
      } else if (key === "y") {
        event.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [redo, undo]);

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

  const connectMcpNode = async (nodeId: string) => {
    const record = workflowRef.current;
    const node = record?.nodes.find((item) => item.id === nodeId);
    if (!record || !node || running) return;
    const config = mcpNodeConfig(node);
    const remoteLink = resolveBlockTemplate(config.remoteLink, record).trim();
    if (!remoteLink) {
      updateNode(nodeId, {
        config: {
          ...(node.config ?? {}),
          connectionStatus: "error",
          connectionError: "Remote MCP Link is required.",
        },
      });
      return;
    }
    updateNode(nodeId, {
      config: {
        ...(node.config ?? {}),
        connectionStatus: "connecting",
        connectionError: "",
      },
    });
    try {
      const headers = parseJsonObject(config.headers) ?? {};
      const discovery = await discoverRemoteMcp(workspaceId, {
        remoteLink,
        postUrl: config.postUrl || undefined,
        headers: stringRecord(headers),
        apiKey: config.apiKey || undefined,
      });
      const currentNode =
        workflowRef.current?.nodes.find((item) => item.id === nodeId) ?? node;
      const firstTool = discovery.tools[0]?.name ?? "";
      const nextToolName = config.toolName || firstTool;
      const nextTool = discovery.tools.find((tool) => tool.name === nextToolName);
      updateNode(nodeId, {
        config: {
          ...(currentNode.config ?? {}),
          remoteLink: discovery.remoteLink,
          postUrl: discovery.postUrl,
          tools: discovery.tools,
          connectedAt: discovery.connectedAt,
          connectionStatus: "connected",
          connectionError: "",
          toolName: nextToolName,
          arguments: shouldReplaceMcpArguments(config.arguments)
            ? argumentsTemplateFromTool(nextTool)
            : config.arguments,
        },
        rawOutput: stringifyBlockOutput({
          type: "mcp",
          status: "connected",
          remoteLink: redactUrl(discovery.remoteLink),
          postUrl: redactUrl(discovery.postUrl),
          tools: discovery.tools.map((tool) => tool.name),
          text: `Connected. Discovered ${discovery.tools.length} tool${discovery.tools.length === 1 ? "" : "s"}.`,
          CHANGED_FILES: [],
        }),
        summary: stringifyBlockOutput({
          type: "mcp",
          status: "connected",
          remoteLink: redactUrl(discovery.remoteLink),
          postUrl: redactUrl(discovery.postUrl),
          tools: discovery.tools.map((tool) => tool.name),
          text: `Connected. Discovered ${discovery.tools.length} tool${discovery.tools.length === 1 ? "" : "s"}: ${discovery.tools.map((tool) => tool.name).join(", ") || "none"}.`,
          CHANGED_FILES: [],
        }),
      });
    } catch (e) {
      const currentNode =
        workflowRef.current?.nodes.find((item) => item.id === nodeId) ?? node;
      updateNode(nodeId, {
        config: {
          ...(currentNode.config ?? {}),
          connectionStatus: "error",
          connectionError: (e as Error).message,
        },
      });
    }
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
      const node = nodeFromTemplate(template, nodeId, nextBlockId(record), x, y);
      return { ...record, nodes: [...record.nodes, node] };
    }, true, true);
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
    }, true, true);
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
        blockId: nextBlockId(record),
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
    }, true, true);
    setSelectedId(nodeId);
  };

  const addEdgeWithHistory = (from: string, to: string, recordHistory: boolean) => {
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
    }, true, recordHistory);
  };

  const updateEdge = (edgeId: string, patch: Partial<WorkflowEdge>) => {
    updateWorkflow((record) => ({
      ...record,
      edges: record.edges.map((edge) =>
        edge.id === edgeId ? { ...edge, ...patch } : edge
      ),
    }), true, true);
  };

  const deleteEdge = (edgeId: string) => {
    updateWorkflow((record) => ({
      ...record,
      edges: record.edges.filter((edge) => edge.id !== edgeId),
    }), true, true);
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

  const startInputEdgeDrag = (
    to: string,
    e: ReactPointerEvent<HTMLButtonElement>
  ) => {
    e.preventDefault();
    e.stopPropagation();
    if (running || e.button !== 0) return;
    setConnectHoverId(to);
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
    if (target) addEdgeWithHistory(current.from, target, true);
  };

  const setZoomValue = (value: number) => {
    setZoom(clamp(Math.round(value * 10) / 10, MIN_ZOOM, MAX_ZOOM));
  };

  const handleWheelZoom = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    setZoom((current) =>
      clamp(Math.round((current + delta) * 10) / 10, MIN_ZOOM, MAX_ZOOM)
    );
  };

  const startCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (running || e.button !== 2) return;
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    e.preventDefault();
    e.stopPropagation();
    setNodeMenu(null);
    setEdgeMenu(null);
    setBlockPickerOpen(false);
    suppressContextMenuRef.current = false;
    canvasPanRef.current = {
      pointerId: e.pointerId,
      startX: e.clientX,
      startY: e.clientY,
      scrollLeft: wrap.scrollLeft,
      scrollTop: wrap.scrollTop,
      moved: false,
    };
    setPanningCanvas(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pan = canvasPanRef.current;
    const wrap = canvasWrapRef.current;
    if (!pan || !wrap || pan.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - pan.startX;
    const dy = e.clientY - pan.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      pan.moved = true;
      suppressContextMenuRef.current = true;
    }
    wrap.scrollLeft = pan.scrollLeft - dx;
    wrap.scrollTop = pan.scrollTop - dy;
  };

  const finishCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const pan = canvasPanRef.current;
    if (!pan || pan.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (pan.moved) suppressContextMenuRef.current = true;
    canvasPanRef.current = null;
    setPanningCanvas(false);
  };

  const handleCanvasContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressContextMenuRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressContextMenuRef.current = false;
    }
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
          const output = triggerOutput(node);
          const outputText = stringifyBlockOutput(output);
          current = patchNode(current, nodeId, {
            status: "success",
            rawOutput: outputText,
            summary: outputText,
            error: "",
            startedAt,
            completedAt: Date.now(),
          });
          await commitNow(current);
          continue;
        }
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
          if (kind === "command") {
            const commandRun = await executeCommandNodeStream(
              workspaceId,
              current,
              node,
              startedAt,
              nodeId,
              setLiveNodePatch,
              (controller) => {
                abortRef.current = controller;
              }
            );
            current = workflowRef.current ?? current;
            const outputText = stringifyBlockOutput(commandRun.output);
            if (commandRun.aborted) {
              current = patchNode(current, nodeId, {
                ...(commandRun.nodePatch ?? {}),
                status: "error",
                rawOutput: outputText,
                summary: outputText,
                error: "Stopped",
                completedAt: Date.now(),
              });
              current = finishRun(current, run.id, "stopped", "Stopped");
              await commitNow(current);
              return;
            }
            if (commandRun.error) {
              current = patchNode(current, nodeId, {
                ...(commandRun.nodePatch ?? {}),
                status: "error",
                rawOutput: outputText,
                summary: outputText,
                error: commandRun.error,
                completedAt: Date.now(),
              });
              await commitNow(current);
              throw new Error(commandRun.error);
            }
            current = patchNode(current, nodeId, {
              ...(commandRun.nodePatch ?? {}),
              status: "success",
              rawOutput: outputText,
              summary: outputText,
              error: "",
              completedAt: Date.now(),
            });
            await commitNow(current);
            if (commandRun.changedFiles) onFilesChanged();
            continue;
          }
          const local = await executeLocalNode(workspaceId, current, node, {
            allowMcpToolCall: nodeIds.length === 1,
          });
          current = workflowRef.current ?? current;
          const outputText = stringifyBlockOutput(local.output);
          if (local.error) {
            current = patchNode(current, nodeId, {
              ...(local.nodePatch ?? {}),
              status: "error",
              rawOutput: outputText,
              summary: outputText,
              error: local.error,
              completedAt: Date.now(),
            });
            await commitNow(current);
            throw new Error(local.error);
          }
          current = patchNode(current, nodeId, {
            ...(local.nodePatch ?? {}),
            status: "success",
            rawOutput: outputText,
            summary: outputText,
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
        let lastDetailsAt = 0;
        const runLogs: Array<{ stream: "stdout" | "stderr"; content: string }> = [];
        const appendLog = (entry: { stream: "stdout" | "stderr"; content: string }) => {
          runLogs.push(entry);
          const now = Date.now();
          if (now - lastDetailsAt > 220) {
            lastDetailsAt = now;
            setLiveNodePatch(nodeId, {
              config: {
                ...(node.config ?? {}),
                runDetails: agentRunSnapshot(node, "running", startedAt, undefined, runLogs),
              },
            });
          }
        };
        setLiveNodePatch(nodeId, {
          config: {
            ...(node.config ?? {}),
            runDetails: agentRunSnapshot(node, "running", startedAt, undefined, runLogs),
          },
        });
        const mcpTools = collectMcpToolsForAgent(current, node);
        const prompt = buildBlockPrompt(current, node, mcpTools);
        const result = await runAiChatStreamWithRetries(
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
          ac.signal,
          agentRetryCount(node),
          appendLog
        );
        abortRef.current = null;
        raw =
          result.content ||
          raw ||
          `${node.providerKind === "codex-cli" ? "Codex CLI" : "Claude Code CLI"} completed without text output.`;
        const toolRun = result.aborted
          ? null
          : await maybeRunAgentMcpToolCalls(
              workspaceId,
              current,
              node,
              mcpTools,
              raw,
              ac.signal,
              appendLog
            );
        if (toolRun) {
          raw = toolRun.raw;
        }
        const output = agentOutput(node, raw, current);
        const outputText = stringifyBlockOutput(output);
        current = workflowRef.current ?? current;
        if (result.aborted) {
          const stoppedOutput = {
            ...output,
            status: "stopped",
            text: textFromOutput(output) || raw.trim(),
          };
          const stoppedOutputText = stringifyBlockOutput(stoppedOutput);
          current = patchNode(current, nodeId, {
            status: "error",
            rawOutput: stoppedOutputText,
            summary: stoppedOutputText,
            error: "Stopped",
            config: {
              ...(node.config ?? {}),
              runDetails: agentRunSnapshot(node, "stopped", startedAt, Date.now(), runLogs),
            },
            completedAt: Date.now(),
          });
          current = finishRun(current, run.id, "stopped", "Stopped");
          await commitNow(current);
          return;
        }
        current = patchNode(current, nodeId, {
          status: "success",
          rawOutput: outputText,
          summary: outputText,
          error: "",
          config: {
            ...(node.config ?? {}),
            runDetails: agentRunSnapshot(node, "success", startedAt, Date.now(), runLogs),
          },
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
          const output = stringifyBlockOutput({
            type: nodeKind(activeNode),
            status: "failed",
            text: message,
            error: message,
            CHANGED_FILES: [],
          });
          current = patchNode(current, activeNode.id, {
            status: "error",
            rawOutput: activeNode.rawOutput || output,
            summary: activeNode.summary || output,
            error: message,
            config: finalizeRunDetailsOnError(activeNode, message),
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
  const menuEdge = edgeMenu
    ? workflow.edges.find((edge) => edge.id === edgeMenu.edgeId)
    : null;
  const canUndo = historyTick >= 0 && undoStackRef.current.length > 0;
  const canRedo = historyTick >= 0 && redoStackRef.current.length > 0;
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
  const edgeMenuSections: CtxMenuSection[] = menuEdge
    ? [
        {
          items: [
            {
              label: "Delete connection",
              danger: true,
              disabled: running,
              onSelect: () => {
                deleteEdge(menuEdge.id);
                setEdgeMenu(null);
              },
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
          className="workflow-toolbar__btn workflow-toolbar__btn--icon"
          onClick={undo}
          disabled={running || !canUndo}
          title="Undo (Ctrl+Z)"
          aria-label="Undo"
        >
          ↶
        </button>
        <button
          className="workflow-toolbar__btn workflow-toolbar__btn--icon"
          onClick={redo}
          disabled={running || !canRedo}
          title="Redo (Ctrl+Shift+Z / Ctrl+Y)"
          aria-label="Redo"
        >
          ↷
        </button>
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
          ref={canvasWrapRef}
          className="workflow-canvas-wrap"
          onWheel={handleWheelZoom}
          onPointerDown={startCanvasPan}
          onPointerMove={moveCanvasPan}
          onPointerUp={finishCanvasPan}
          onPointerCancel={finishCanvasPan}
          onContextMenu={handleCanvasContextMenu}
          style={{
            backgroundSize: `${32 * zoom}px ${32 * zoom}px, ${32 * zoom}px ${
              32 * zoom
            }px, auto`,
          }}
        >
          <div
            className={
              "workflow-canvas-viewport" + (panningCanvas ? " is-panning" : "")
            }
            style={scaledCanvasStyle}
          >
            <div
              ref={canvasRef}
              className="workflow-canvas"
              style={canvasStyle}
              onPointerDown={(e) => {
                setNodeMenu(null);
                setEdgeMenu(null);
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
                  const path = edgePath(from, to);
                  return (
                    <g key={edge.id} className="workflow-edge-group">
                      <path
                        className="workflow-edge-hit"
                        d={path}
                        onContextMenu={(e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          setNodeMenu(null);
                          setEdgeMenu({ x: e.clientX, y: e.clientY, edgeId: edge.id });
                        }}
                      />
                      <path
                        className={
                          "workflow-edge" + (edge.passSummary ? "" : " is-muted")
                        }
                        d={path}
                        markerEnd="url(#workflow-arrow)"
                      />
                    </g>
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
                    if (suppressContextMenuRef.current) {
                      e.preventDefault();
                      e.stopPropagation();
                      suppressContextMenuRef.current = false;
                      return;
                    }
                    e.preventDefault();
                    e.stopPropagation();
                    setBlockPickerOpen(false);
                    setEdgeMenu(null);
                    setNodeMenu({ x: e.clientX, y: e.clientY, nodeId: node.id });
                  }}
                  onNodePointerDown={(e) => startNodeDrag(node, e)}
                  onNodePointerMove={moveNodeDrag}
                  onNodePointerUp={finishNodeDrag}
                  onNodePointerCancel={finishNodeDrag}
                  onStartEdgeDrag={(e) => startEdgeDrag(node.id, e)}
                  onStartInputEdgeDrag={(e) => startInputEdgeDrag(node.id, e)}
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
              onConnectMcp={() => void connectMcpNode(selectedNode.id)}
              onShowDetails={() => setDetailNodeId(selectedNode.id)}
              onShowMpe={() => setMpeNodeId(selectedNode.id)}
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
      {edgeMenu && menuEdge && (
        <ContextMenu
          x={edgeMenu.x}
          y={edgeMenu.y}
          sections={edgeMenuSections}
          onClose={() => setEdgeMenu(null)}
        />
      )}
      {detailNodeId && workflow.nodes.some((node) => node.id === detailNodeId) && (
        <div className="workflow-panel-shell">
          <WorkflowDetailsPanel
            node={workflow.nodes.find((node) => node.id === detailNodeId)!}
            onClose={() => setDetailNodeId(null)}
          />
        </div>
      )}
      {mpeNodeId && workflow.nodes.some((node) => node.id === mpeNodeId) && (
        <div className="workflow-panel-shell">
          <WorkflowMpePanel
            markdown={resolveBlockTemplate(
              workflow.nodes.find((node) => node.id === mpeNodeId)!.prompt,
              workflow
            )}
            onClose={() => setMpeNodeId(null)}
          />
        </div>
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
              <span className="workflow-block-picker__icon">
                <WorkflowIcon name={item.icon} />
              </span>
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
              <span className="workflow-block-picker__item-icon">
                <WorkflowIcon name={template.icon} />
              </span>
              <span>{template.label}</span>
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
  onStartInputEdgeDrag,
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
  onStartInputEdgeDrag: (e: ReactPointerEvent<HTMLButtonElement>) => void;
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
  const hasInputHandle = nodeKind(node) !== "trigger";
  const hasOutputHandle = nodeKind(node) !== "markdown";

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
      {hasInputHandle && (
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
          onPointerDown={onStartInputEdgeDrag}
          onPointerMove={onMoveEdgeDrag}
          onPointerUp={onFinishEdgeDrag}
          onPointerCancel={onFinishEdgeDrag}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      )}
      <span className="workflow-node__id">{displayBlockId(node)}</span>
      <span className="workflow-node__icon">
        <WorkflowIcon name={nodeIconName(node)} />
      </span>
      <span className="workflow-node__name">{node.title}</span>
      {hasOutputHandle && (
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
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      )}
    </div>
  );
}

function WorkflowDetailsPanel({
  node,
  onClose,
}: {
  node: WorkflowNode;
  onClose: () => void;
}) {
  const snapshot = runDetailsSnapshot(node);
  const title = snapshot?.title || node.title;
  return (
    <aside className="workflow-inspector workflow-run-details">
      <div className="workflow-inspector__head">
        <div>
          <div className="workflow-inspector__eyebrow">Run details</div>
          <span className={`workflow-inspector__status is-${snapshot?.status ?? node.status}`}>
            {snapshot?.status ?? node.status}
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
      <div className="workflow-run-details__meta">
        <span>{title}</span>
        {snapshot?.durationMs !== undefined && <span>{snapshot.durationMs}ms</span>}
        {snapshot?.exitCode !== undefined && <span>exit {snapshot.exitCode ?? "signal"}</span>}
      </div>
      <div className="workflow-run-details__terminal">
        <div className="workflow-run-details__bar">
          <span />
          <span />
          <span />
          <strong>{snapshot?.commandLine || "No run captured"}</strong>
        </div>
        <pre>
          {snapshot?.transcript ||
            snapshot?.stdout ||
            snapshot?.stderr ||
            "Run this block to capture a terminal snapshot."}
        </pre>
      </div>
    </aside>
  );
}

function WorkflowMpePanel({
  markdown,
  onClose,
}: {
  markdown: string;
  onClose: () => void;
}) {
  return (
    <aside className="workflow-inspector workflow-mpe-panel">
      <div className="workflow-inspector__head">
        <div>
          <div className="workflow-inspector__eyebrow">MPE</div>
          <span className="workflow-inspector__status is-success">preview</span>
        </div>
        <button
          type="button"
          className="workflow-inspector__close"
          onClick={onClose}
          aria-label="Close MPE"
          title="Close"
        >
          x
        </button>
      </div>
      <div className="workflow-mpe-panel__body">
        <MarkdownPreview source={markdown} />
      </div>
    </aside>
  );
}

function WorkflowNodeInspector({
  node,
  nodes,
  edges,
  running,
  onUpdate,
  onConnectMcp,
  onShowDetails,
  onShowMpe,
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
  onConnectMcp: () => void;
  onShowDetails: () => void;
  onShowMpe: () => void;
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
  const isFileWrite = kind === "file-write";
  const isMcp = kind === "mcp";
  const isMarkdown = kind === "markdown";
  const writeConfig = fileWriteConfig(node);
  const mcpConfig = mcpNodeConfig(node);
  const showOutput = kind !== "markdown";
  const runDetails = runDetailsSnapshot(node);

  return (
    <aside className="workflow-inspector">
      <div className="workflow-inspector__head">
        <div>
          <div className="workflow-inspector__eyebrow">
            {blockEyebrow(kind)} #{displayBlockId(node)}
          </div>
          <span className={`workflow-inspector__status is-${node.status}`}>
            {node.status}
          </span>
        </div>
        <div className="workflow-inspector__head-actions">
          {(isAgent || kind === "command") && runDetails && (
            <button type="button" onClick={onShowDetails}>
              see details
            </button>
          )}
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
        <TemplateInput
          value={node.title}
          onChange={(value) => onUpdate({ title: value })}
          disabled={running}
        />
      </label>

      {isAgent && (
        <>
          <div className="workflow-inspector__provider-static">
            {node.providerKind === "codex-cli" ? "Codex" : "Claude Code"}
          </div>

          <label className="workflow-inspector__field">
            <span>Model</span>
            <TemplateInput
              value={node.model}
              onChange={(value) => onUpdate({ model: value || "default" })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Retries</span>
            <input
              type="number"
              min={0}
              max={5}
              value={agentRetryCount(node)}
              onChange={(e) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    retries: clamp(Number(e.target.value) || 0, 0, 5),
                  },
                })
              }
              disabled={running}
            />
          </label>
        </>
      )}

      {isFileWrite ? (
        <>
          <label className="workflow-inspector__field">
            <span>Path</span>
            <TemplateInput
              value={writeConfig.path}
              onChange={(value) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    path: value,
                  },
                })
              }
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Content</span>
            <TemplateTextarea
              value={writeConfig.content}
              onChange={(value) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    content: value,
                  },
                })
              }
              disabled={running}
            />
          </label>
        </>
      ) : isMcp ? (
        <>
          <label className="workflow-inspector__field">
            <span>Remote MCP Link</span>
            <TemplateInput
              value={mcpConfig.remoteLink}
              onChange={(value) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    remoteLink: value,
                    connectionStatus: "",
                    connectionError: "",
                  },
                })
              }
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Headers JSON</span>
            <TemplateTextarea
              value={mcpConfig.headers}
              onChange={(value) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    headers: value,
                    connectionStatus: "",
                    connectionError: "",
                  },
                })
              }
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>API Key</span>
            <TemplateInput
              value={mcpConfig.apiKey}
              onChange={(value) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    apiKey: value,
                    connectionStatus: "",
                    connectionError: "",
                  },
                })
              }
              disabled={running}
            />
          </label>
          <div className="workflow-inspector__mcp-actions">
            <button
              type="button"
              onClick={onConnectMcp}
              disabled={running || !mcpConfig.remoteLink.trim()}
            >
              {mcpConfig.connectionStatus === "connecting" ? "Connecting..." : "Connect"}
            </button>
            <span className={`workflow-inspector__mcp-state is-${mcpConfig.connectionStatus || "idle"}`}>
              {mcpConnectionLabel(mcpConfig)}
            </span>
          </div>
          {mcpConfig.connectionError && (
            <div className="workflow-inspector__mcp-error">
              {mcpConfig.connectionError}
            </div>
          )}
          {mcpConfig.tools.length > 0 && (
            <div className="workflow-inspector__section">
              <div className="workflow-inspector__section-title">Discovered tools</div>
              <div className="workflow-inspector__chips">
                {mcpConfig.tools.map((tool) => (
                  <button
                    key={tool.name}
                    type="button"
                    className={
                      "workflow-inspector__chip workflow-inspector__chip-button" +
                      (tool.name === mcpConfig.toolName ? " is-active" : "")
                    }
                    onClick={() =>
                      onUpdate({
                        config: {
                          ...(node.config ?? {}),
                          toolName: tool.name,
                          arguments: shouldReplaceMcpArguments(mcpConfig.arguments)
                            ? argumentsTemplateFromTool(tool)
                            : mcpConfig.arguments,
                        },
                      })
                    }
                    disabled={running}
                    title={tool.description || tool.name}
                  >
                    {tool.name}
                  </button>
                ))}
              </div>
            </div>
          )}
          <label className="workflow-inspector__field">
            <span>Tool</span>
            <TemplateInput
              value={mcpConfig.toolName}
              onChange={(value) => {
                const nextTool = mcpConfig.tools.find((tool) => tool.name === value);
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    toolName: value,
                    arguments:
                      nextTool && shouldReplaceMcpArguments(mcpConfig.arguments)
                        ? argumentsTemplateFromTool(nextTool)
                        : mcpConfig.arguments,
                  },
                });
              }}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Arguments JSON</span>
            <TemplateTextarea
              value={mcpConfig.arguments}
              onChange={(value) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    arguments: value,
                  },
                })
              }
              disabled={running}
            />
          </label>
        </>
      ) : !isTrigger && (
        <label className="workflow-inspector__field">
          <span>{inputLabelForKind(kind)}</span>
          <TemplateTextarea
            value={node.prompt}
            onChange={(value) => onUpdate({ prompt: value })}
            disabled={running}
          />
        </label>
      )}

      {isMarkdown && (
        <div className="workflow-inspector__mpe-link-row">
          <button type="button" onClick={onShowMpe}>
            see MPE
          </button>
        </div>
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

      {showOutput && (
        <div className="workflow-inspector__section workflow-inspector__section--grow">
          <div className="workflow-inspector__section-title">Output</div>
          <pre className="workflow-inspector__output">
            {bodyText || "No summary yet."}
          </pre>
        </div>
      )}

      <div className="workflow-inspector__foot">
        <button onClick={onDelete} disabled={running || nodes.length <= 1}>
          Delete
        </button>
      </div>
    </aside>
  );
}

interface TemplateControlProps {
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}

function TemplateInput({ value, onChange, disabled }: TemplateControlProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);

  return (
    <span
      className={
        "workflow-template-editor workflow-template-editor--input" +
        (disabled ? " is-disabled" : "")
      }
    >
      <span ref={mirrorRef} className="workflow-template-editor__mirror" aria-hidden>
        {renderTemplateHighlight(value)}
      </span>
      <input
        className="workflow-template-editor__control"
        value={value}
        onChange={(e) => onChange(normalizeTemplateSpacing(e.target.value))}
        onScroll={(e) => {
          if (mirrorRef.current) mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        disabled={disabled}
        spellCheck={false}
      />
    </span>
  );
}

function TemplateTextarea({ value, onChange, disabled }: TemplateControlProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);

  return (
    <span
      className={
        "workflow-template-editor workflow-template-editor--textarea" +
        (disabled ? " is-disabled" : "")
      }
    >
      <span ref={mirrorRef} className="workflow-template-editor__mirror" aria-hidden>
        {renderTemplateHighlight(value)}
      </span>
      <textarea
        className="workflow-template-editor__control"
        value={value}
        onChange={(e) => onChange(normalizeTemplateSpacing(e.target.value))}
        onScroll={(e) => {
          if (!mirrorRef.current) return;
          mirrorRef.current.scrollTop = e.currentTarget.scrollTop;
          mirrorRef.current.scrollLeft = e.currentTarget.scrollLeft;
        }}
        disabled={disabled}
        spellCheck={false}
      />
    </span>
  );
}

function renderTemplateHighlight(value: string): ReactNode {
  if (!value) return "\u00a0";
  const parts: ReactNode[] = [];
  const re = /\{\{[\s\S]*?\}\}/g;
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    if (match.index > index) {
      parts.push(value.slice(index, match.index));
    }
    parts.push(
      <span key={`${match.index}:${match[0]}`} className="workflow-template-token">
        {formatTemplateToken(match[0])}
      </span>
    );
    index = match.index + match[0].length;
  }
  if (index < value.length) parts.push(value.slice(index));
  if (value.endsWith("\n")) parts.push("\u00a0");
  return parts;
}

function normalizeTemplateSpacing(value: string): string {
  const re = /\{\{[\s\S]*?\}\}/g;
  let output = "";
  let index = 0;
  let match: RegExpExecArray | null;
  while ((match = re.exec(value)) !== null) {
    output += value.slice(index, match.index);
    if (output && !/\s$/.test(output)) output += " ";
    output += formatTemplateToken(match[0]);
    index = match.index + match[0].length;
    if (value[index] && !/\s/.test(value[index])) output += " ";
  }
  output += value.slice(index);
  return output;
}

function formatTemplateToken(token: string): string {
  const inner = token.slice(2, -2).trim();
  return `{{ ${inner} }}`;
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
  record: WorkflowRecord,
  node: WorkflowNode,
  options: { allowMcpToolCall?: boolean } = {}
): Promise<LocalNodeResult> {
  const input = resolveBlockTemplate(node.prompt, record).trim();
  const kind = nodeKind(node);
  if (!input && kind !== "mcp" && kind !== "file-write" && kind !== "markdown") {
    throw new Error(`${node.title} has no input.`);
  }

  if (kind === "web") {
    const result = await execRun(workspaceId, {
      command: buildFetchCommand(input),
      shell: "cmd",
      timeoutMs: 120_000,
    });
    const failed = result.exitCode !== 0;
    return {
      output: {
        type: "web",
        status: failed ? "failed" : "success",
        url: input,
        text: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        truncated: result.truncated,
        CHANGED_FILES: [],
      },
      error: failed ? `Failed to fetch ${input}.` : undefined,
    };
  }

  if (kind === "file-read") {
    const file = await readFile(workspaceId, input);
    return {
      output: {
        type: "file-read",
        status: "success",
        path: input,
        content: file.content,
        size: file.size,
        mtime: file.mtime,
        CHANGED_FILES: [],
      },
    };
  }

  if (kind === "file-write") {
    const config = fileWriteConfig(node);
    const parsed = {
      path: resolveBlockTemplate(config.path, record).trim(),
      content: resolveBlockTemplate(config.content, record),
    };
    if (!parsed.path) throw new Error(`${node.title} has no path.`);
    await writeFile(workspaceId, parsed.path, parsed.content, true);
    return {
      output: {
        type: "file-write",
        status: "success",
        path: parsed.path,
        bytes: new Blob([parsed.content]).size,
        content: parsed.content,
        CHANGED_FILES: [parsed.path],
      },
      changedFiles: true,
    };
  }

  if (kind === "markdown") {
    const markdown = resolveBlockTemplate(node.prompt, record);
    return {
      output: {
        type: "markdown",
        status: "success",
        markdown,
        text: markdown,
        CHANGED_FILES: [],
      },
    };
  }

  if (kind === "mcp") {
    const config = mcpNodeConfig(node);
    const remoteLink = resolveBlockTemplate(config.remoteLink, record).trim();
    const toolName = resolveBlockTemplate(config.toolName, record).trim();
    const resolvedArgs = resolveBlockTemplate(config.arguments, record);
    const args = parseJsonObject(resolvedArgs) ?? {};
    if (!remoteLink) throw new Error(`${node.title} has no Remote MCP Link.`);
    if (!options.allowMcpToolCall) {
      if (config.tools.length > 0) {
        return {
          output: {
            type: "mcp",
            status: "connected",
            remoteLink: redactUrl(remoteLink),
            postUrl: redactUrl(config.postUrl),
            tools: config.tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? "",
              inputSchema: tool.inputSchema,
            })),
            text: `Ready. Discovered ${config.tools.length} tool${config.tools.length === 1 ? "" : "s"}: ${config.tools.map((tool) => tool.name).join(", ")}.`,
            CHANGED_FILES: [],
          },
        };
      }
      const headers = parseJsonObject(resolveBlockTemplate(config.headers, record)) ?? {};
      const discovery = await discoverRemoteMcp(workspaceId, {
        remoteLink,
        postUrl: config.postUrl || undefined,
        headers: stringRecord(headers),
        apiKey: config.apiKey || undefined,
      });
      const firstTool = discovery.tools[0]?.name ?? "";
      const nextToolName = config.toolName || firstTool;
      const nextTool = discovery.tools.find((tool) => tool.name === nextToolName);
      return {
        output: {
          type: "mcp",
          status: "connected",
          remoteLink: redactUrl(discovery.remoteLink),
          postUrl: redactUrl(discovery.postUrl),
          tools: discovery.tools.map((tool) => ({
            name: tool.name,
            description: tool.description ?? "",
            inputSchema: tool.inputSchema,
          })),
          text: `Ready. Discovered ${discovery.tools.length} tool${discovery.tools.length === 1 ? "" : "s"}: ${discovery.tools.map((tool) => tool.name).join(", ") || "none"}.`,
          CHANGED_FILES: [],
        },
        nodePatch: {
          config: {
            ...(node.config ?? {}),
            remoteLink: discovery.remoteLink,
            postUrl: discovery.postUrl,
            tools: discovery.tools,
            connectedAt: discovery.connectedAt,
            connectionStatus: "connected",
            connectionError: "",
            toolName: nextToolName,
            arguments: shouldReplaceMcpArguments(config.arguments)
              ? argumentsTemplateFromTool(nextTool)
              : config.arguments,
          },
        },
      };
    }
    if (!toolName) throw new Error(`${node.title} has no tool selected.`);
    const headers = parseJsonObject(resolveBlockTemplate(config.headers, record)) ?? {};
    const result = await callRemoteMcp(workspaceId, {
      remoteLink,
      postUrl: config.postUrl || undefined,
      headers: stringRecord(headers),
      apiKey: config.apiKey || undefined,
      name: toolName,
      arguments: args,
    });
    const output = {
      type: "mcp",
      status: result.ok ? "success" : "failed",
      remoteLink: redactUrl(result.remoteLink),
      postUrl: redactUrl(result.postUrl),
      tool: toolName,
      arguments: args,
      result: result.result,
      error: result.error,
      response: result.response,
      text: mcpResultText(result.result, result.error),
      CHANGED_FILES: [],
    };
    return {
      output,
      nodePatch: {
        config: {
          ...(node.config ?? {}),
          remoteLink: result.remoteLink,
          postUrl: result.postUrl,
          connectionStatus: result.ok ? "connected" : "error",
          connectionError: result.ok ? "" : stringifyTemplateValue(result.error),
        },
      },
      error: result.ok ? undefined : `MCP tool ${toolName} failed.`,
    };
  }

  throw new Error(`${node.title} cannot run as a local block.`);
}

async function executeCommandNodeStream(
  workspaceId: string,
  record: WorkflowRecord,
  node: WorkflowNode,
  startedAt: number,
  nodeId: string,
  setLiveNodePatch: (nodeId: string, patch: Partial<WorkflowNode>) => void,
  setAbortController: (controller: AbortController | null) => void
): Promise<LocalNodeResult & { aborted?: boolean }> {
  const commandLine = resolveBlockTemplate(node.prompt, record).trim();
  if (!commandLine) throw new Error(`${node.title} has no input.`);

  const ac = new AbortController();
  setAbortController(ac);
  const logs: Array<{ stream: "stdout" | "stderr"; content: string }> = [
    { stream: "stdout", content: `$ ${commandLine}\n` },
  ];
  let lastDetailsAt = 0;
  const updateSnapshot = (status: WorkflowRunDetailSnapshot["status"]) => {
    setLiveNodePatch(nodeId, {
      config: {
        ...(node.config ?? {}),
        runDetails: commandRunSnapshot(
          node,
          status,
          startedAt,
          undefined,
          commandLine,
          logs
        ),
      },
    });
  };
  updateSnapshot("running");

  let streamed: { result: RunResult | null; aborted: boolean };
  try {
    streamed = await execRunStream(
      workspaceId,
      {
        command: commandLine,
        timeoutMs: 600_000,
      },
      {
        signal: ac.signal,
        onLog: (entry) => {
          logs.push({ stream: entry.stream, content: entry.content });
          const now = Date.now();
          if (now - lastDetailsAt > 180) {
            lastDetailsAt = now;
            updateSnapshot("running");
          }
        },
      }
    );
  } finally {
    setAbortController(null);
  }

  if (streamed.aborted || !streamed.result) {
    logs.push({ stream: "stderr", content: "\n[osheep] stopped\n" });
    const snapshot = commandRunSnapshot(
      node,
      "stopped",
      startedAt,
      Date.now(),
      commandLine,
      logs
    );
    return {
      output: {
        type: "command",
        status: "stopped",
        command: commandLine,
        stdout: snapshot.stdout,
        stderr: snapshot.stderr,
        CHANGED_FILES: [],
      },
      nodePatch: {
        config: {
          ...(node.config ?? {}),
          runDetails: snapshot,
        },
      },
      aborted: true,
      changedFiles: false,
      error: "Stopped",
    };
  }

  const result = streamed.result;
  const failed = result.exitCode !== 0;
  const snapshot = commandRunSnapshot(
    node,
    failed ? "error" : "success",
    startedAt,
    Date.now(),
    result.command,
    logs,
    result
  );
  return {
    output: {
      type: "command",
      status: failed ? "failed" : "success",
      command: result.command,
      shell: result.shell ?? "auto",
      exitCode: result.exitCode,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      truncated: result.truncated,
      CHANGED_FILES: [],
    },
    nodePatch: {
      config: {
        ...(node.config ?? {}),
        runDetails: snapshot,
      },
    },
    changedFiles: !failed,
    error: failed ? `${node.title} exited with ${result.exitCode ?? "signal"}.` : undefined,
  };
}

function buildBlockPrompt(
  record: WorkflowRecord,
  node: WorkflowNode,
  mcpTools: McpRuntimeTool[] = []
): string {
  const incoming = record.edges
    .filter((edge) => edge.to === node.id && edge.passSummary)
    .map((edge) => record.nodes.find((item) => item.id === edge.from))
    .filter((item): item is WorkflowNode => !!item)
    .map((source) => {
      const summary = source.summary?.trim() || "No summary was produced.";
      return `### ${source.title}\n${summary}`;
    });

  const mcpToolSpecs = mcpTools.map(({ node: sourceNode, tool }) => ({
    type: "function",
    function: {
      name: tool.name,
      description: tool.description ?? "",
      parameters:
        tool.inputSchema && typeof tool.inputSchema === "object"
          ? tool.inputSchema
          : { type: "object", properties: {} },
    },
    sourceBlock: displayBlockId(sourceNode),
  }));
  const mcpInstructions = mcpToolSpecs.length
    ? [
        "",
        "Remote MCP tools are available. If you need one before producing the final answer, return JSON with a tool_calls array and keep text brief.",
        "Each tool call must be: {\"name\":\"tool_name\",\"arguments\":{...}}.",
        "Available tools in OpenAI-compatible function shape:",
        JSON.stringify(mcpToolSpecs, null, 2),
        "After osheep executes the tool calls, it will run you again with the results. Do not invent tool results.",
      ]
    : [];

  return [
    `You are executing osheep workflow block "${node.title}".`,
    "Return exactly one JSON object and no markdown fences.",
    "The JSON object must include: text, status, CHANGED_FILES, VERIFICATION, NEXT.",
    "Put the user-facing answer in text. CHANGED_FILES and VERIFICATION must be arrays.",
    "If the prompt asks for project work, use your native CLI capabilities to inspect, edit, and verify files in the current project root.",
    "If the prompt is conversational, answer naturally inside text and keep CHANGED_FILES empty.",
    ...mcpInstructions,
    "",
    "Incoming summaries:",
    incoming.length ? incoming.join("\n\n") : "None.",
    "",
    "Block prompt:",
    resolveBlockTemplate(node.prompt, record),
  ].join("\n");
}

async function maybeRunAgentMcpToolCalls(
  workspaceId: string,
  record: WorkflowRecord,
  node: WorkflowNode,
  mcpTools: McpRuntimeTool[],
  raw: string,
  signal: AbortSignal,
  onLog?: (entry: { stream: "stdout" | "stderr"; content: string }) => void
): Promise<{ raw: string } | null> {
  if (mcpTools.length === 0) return null;
  const calls = extractMcpToolCalls(raw);
  if (calls.length === 0) return null;

  const byName = new Map<string, McpRuntimeTool>();
  for (const runtimeTool of mcpTools) {
    if (!byName.has(runtimeTool.tool.name)) byName.set(runtimeTool.tool.name, runtimeTool);
  }

  const results: WorkflowBlockOutput[] = [];
  for (let i = 0; i < calls.length; i += 1) {
    const call = calls[i]!;
    const runtimeTool = byName.get(call.name);
    if (!runtimeTool) {
      results.push({
        type: "mcp",
        status: "failed",
        tool: call.name,
        arguments: call.arguments,
        error: `No connected MCP node provides ${call.name}.`,
      });
      continue;
    }
    const resolvedRemoteLink = resolveBlockTemplate(
      runtimeTool.config.remoteLink,
      record
    ).trim();
    const headers =
      parseJsonObject(resolveBlockTemplate(runtimeTool.config.headers, record)) ?? {};
    const result = await callRemoteMcp(workspaceId, {
      remoteLink: resolvedRemoteLink,
      postUrl: runtimeTool.config.postUrl || undefined,
      headers: stringRecord(headers),
      apiKey: runtimeTool.config.apiKey || undefined,
      name: call.name,
      arguments: call.arguments,
    });
    results.push({
      type: "mcp",
      status: result.ok ? "success" : "failed",
      sourceBlock: displayBlockId(runtimeTool.node),
      remoteLink: redactUrl(result.remoteLink),
      postUrl: redactUrl(result.postUrl),
      tool: call.name,
      arguments: call.arguments,
      result: result.result,
      error: result.error,
      response: result.response,
      text: mcpResultText(result.result, result.error),
    });
  }

  const followup = buildMcpFollowupPrompt(record, node, raw, results);
  let acc = "";
  const response = await aiChatStream(
    workspaceId,
    {
      model: node.model || "default",
      kind: node.providerKind,
      messages: [{ role: "user", content: followup }],
    },
    (chunk) => {
      acc += chunk;
    },
    signal,
    undefined,
    onLog
  );
  return {
    raw: response.content || acc || raw,
  };
}

async function runAiChatStreamWithRetries(
  workspaceId: string,
  input: {
    model: string;
    messages: Array<{ role: "user"; content: string }>;
    kind?: "claude-cli" | "codex-cli";
  },
  onDelta: (chunk: string) => void,
  signal: AbortSignal,
  retries: number,
  onLog: (entry: { stream: "stdout" | "stderr"; content: string }) => void
): Promise<{ content: string; aborted: boolean }> {
  let lastError: unknown = null;
  const attempts = Math.max(1, retries + 1);
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      if (attempt > 1) {
        onLog({ stream: "stderr", content: `\n[osheep] retry ${attempt - 1}/${retries}\n` });
      }
      return await aiChatStream(
        workspaceId,
        input,
        onDelta,
        signal,
        undefined,
        onLog
      );
    } catch (e) {
      lastError = e;
      if (signal.aborted || attempt >= attempts) throw e;
      onLog({
        stream: "stderr",
        content: `\n[osheep] attempt ${attempt} failed: ${(e as Error).message}\n`,
      });
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function agentRetryCount(node: WorkflowNode): number {
  const value = node.config?.retries;
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  return clamp(value, 0, 5);
}

function agentRunSnapshot(
  node: WorkflowNode,
  status: WorkflowRunDetailSnapshot["status"],
  startedAt: number,
  completedAt: number | undefined,
  logs: Array<{ stream: "stdout" | "stderr"; content: string }>
): WorkflowRunDetailSnapshot {
  const snapshot: WorkflowRunDetailSnapshot = {
    kind: "agent",
    title: node.title,
    status,
    startedAt,
    commandLine: `${node.providerKind === "codex-cli" ? "codex" : "claude"} ${node.model || "default"}`,
    stdout: logs.filter((log) => log.stream === "stdout").map((log) => log.content).join(""),
    stderr: logs.filter((log) => log.stream === "stderr").map((log) => log.content).join(""),
    transcript: formatTerminalTranscript(logs),
  };
  if (completedAt !== undefined) snapshot.completedAt = completedAt;
  return snapshot;
}

function commandRunSnapshot(
  node: WorkflowNode,
  status: WorkflowRunDetailSnapshot["status"],
  startedAt: number,
  completedAt: number | undefined,
  commandLine: string,
  logs: Array<{ stream: "stdout" | "stderr"; content: string }>,
  result?: RunResult
): WorkflowRunDetailSnapshot {
  const snapshot: WorkflowRunDetailSnapshot = {
    kind: "command",
    title: node.title,
    status,
    startedAt,
    commandLine,
    stdout:
      result?.stdout ??
      logs.filter((log) => log.stream === "stdout").map((log) => log.content).join(""),
    stderr:
      result?.stderr ??
      logs.filter((log) => log.stream === "stderr").map((log) => log.content).join(""),
    transcript: formatTerminalTranscript(logs),
  };
  if (completedAt !== undefined) snapshot.completedAt = completedAt;
  if (result) {
    snapshot.exitCode = result.exitCode;
    snapshot.signal = result.signal;
    snapshot.durationMs = result.durationMs;
  }
  return snapshot;
}

function finalizeRunDetailsOnError(
  node: WorkflowNode,
  message: string
): Record<string, unknown> | undefined {
  const snapshot = runDetailsSnapshot(node);
  if (!snapshot) return node.config;
  return {
    ...(node.config ?? {}),
    runDetails: {
      ...snapshot,
      status: "error",
      completedAt: Date.now(),
      stderr: [snapshot.stderr, message].filter(Boolean).join("\n"),
      transcript: [snapshot.transcript, `[stderr] ${message}`].filter(Boolean).join("\n"),
    },
  };
}

function formatTerminalTranscript(
  logs: Array<{ stream: "stdout" | "stderr"; content: string }>
): string {
  return logs
    .filter((log) => log.content)
    .map((log) => `[${log.stream}] ${log.content.replace(/\s+$/g, "")}`)
    .join("\n");
}

function buildMcpFollowupPrompt(
  record: WorkflowRecord,
  node: WorkflowNode,
  firstResponse: string,
  toolResults: WorkflowBlockOutput[]
): string {
  return [
    `You are continuing osheep workflow block "${node.title}".`,
    "You asked to call Remote MCP tools. The tool results are below.",
    "Now return exactly one final JSON object and no markdown fences.",
    "The JSON object must include: text, status, CHANGED_FILES, VERIFICATION, NEXT.",
    "Do not include tool_calls in the final JSON unless another tool call is strictly required.",
    "",
    "Original block prompt:",
    resolveBlockTemplate(node.prompt, record),
    "",
    "Your previous JSON:",
    firstResponse.trim(),
    "",
    "MCP tool results:",
    JSON.stringify(toolResults, null, 2),
  ].join("\n");
}

function collectMcpToolsForAgent(
  record: WorkflowRecord,
  node: WorkflowNode
): McpRuntimeTool[] {
  const visited = new Set<string>();
  const queue = record.edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => edge.from);
  const out: McpRuntimeTool[] = [];
  while (queue.length) {
    const id = queue.shift()!;
    if (visited.has(id)) continue;
    visited.add(id);
    const source = record.nodes.find((item) => item.id === id);
    if (!source) continue;
    if (nodeKind(source) === "mcp") {
      const config = mcpNodeConfig(source);
      for (const tool of config.tools) {
        if (tool.name) out.push({ node: source, config, tool });
      }
    }
    for (const edge of record.edges) {
      if (edge.to === id) queue.push(edge.from);
    }
  }
  return out;
}

function extractMcpToolCalls(raw: string): Array<{
  name: string;
  arguments: Record<string, unknown>;
}> {
  const parsed = parseJsonObject(raw);
  const value = parsed?.tool_calls ?? parsed?.toolCalls ?? parsed?.tools;
  if (!Array.isArray(value)) return [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const item of value) {
    const obj = item && typeof item === "object" && !Array.isArray(item)
      ? (item as Record<string, unknown>)
      : null;
    if (!obj) continue;
    const nested = obj.function && typeof obj.function === "object"
      ? (obj.function as Record<string, unknown>)
      : null;
    const name =
      typeof obj.name === "string"
        ? obj.name
        : typeof nested?.name === "string"
          ? nested.name
          : "";
    if (!name.trim()) continue;
    let argsValue = obj.arguments ?? nested?.arguments ?? {};
    if (typeof argsValue === "string") {
      argsValue = parseJsonObject(argsValue) ?? {};
    }
    calls.push({
      name: name.trim(),
      arguments:
        argsValue && typeof argsValue === "object" && !Array.isArray(argsValue)
          ? (argsValue as Record<string, unknown>)
          : {},
    });
  }
  return calls;
}

function triggerOutput(node: WorkflowNode): WorkflowBlockOutput {
  return {
    type: "trigger",
    status: "success",
    id: displayBlockId(node),
    text: "Workflow run trigger fired.",
    CHANGED_FILES: [],
  };
}

function agentOutput(
  node: WorkflowNode,
  raw: string,
  record: WorkflowRecord
): WorkflowBlockOutput {
  const parsed = parseJsonObject(raw);
  if (parsed) {
    return normalizeOutputObject(parsed, {
      type: node.providerKind === "claude-cli" ? "claude" : "codex",
      status: "success",
      text: textFromOutput(parsed) || raw.trim(),
      CHANGED_FILES: [],
    });
  }

  return {
    type: node.providerKind === "claude-cli" ? "claude" : "codex",
    status: "success",
    text: raw.trim(),
    CHANGED_FILES: inferChangedFiles(record),
    VERIFICATION: [],
  };
}

function normalizeOutputObject(
  value: WorkflowBlockOutput,
  defaults: WorkflowBlockOutput
): WorkflowBlockOutput {
  return {
    ...defaults,
    ...value,
    CHANGED_FILES: Array.isArray(value.CHANGED_FILES)
      ? value.CHANGED_FILES
      : defaults.CHANGED_FILES,
  };
}

function stringifyBlockOutput(output: WorkflowBlockOutput): string {
  return JSON.stringify(output, null, 2);
}

function parseBlockOutput(node: WorkflowNode): WorkflowBlockOutput | null {
  return parseJsonObject(node.rawOutput || node.summary || "");
}

function parseJsonObject(text: string): WorkflowBlockOutput | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as WorkflowBlockOutput)
      : null;
  } catch {
    return null;
  }
}

function textFromOutput(output: WorkflowBlockOutput): string {
  const text = output.text ?? output.summary ?? output.content ?? output.stdout;
  return typeof text === "string" ? text : "";
}

function inferChangedFiles(record: WorkflowRecord): string[] {
  const changed = new Set<string>();
  for (const node of record.nodes) {
    const output = parseBlockOutput(node);
    const files = output?.CHANGED_FILES;
    if (!Array.isArray(files)) continue;
    for (const file of files) {
      if (typeof file === "string" && file.trim()) changed.add(file.trim());
    }
  }
  return [...changed];
}

function resolveBlockTemplate(input: string, record: WorkflowRecord): string {
  return input.replace(/\{\{\s*blocks\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\s*\}\}/g, (
    _match,
    idText: string,
    pathText: string
  ) => {
    const blockId = Number(idText);
    const node = record.nodes.find((item) => displayBlockId(item) === blockId);
    const output = node ? parseBlockOutput(node) : null;
    if (!output) return "";
    const value = getPathValue(output, pathText);
    return stringifyTemplateValue(value);
  });
}

function getPathValue(value: unknown, pathText: string): unknown {
  let current = value;
  const re = /\.([A-Za-z_$][\w$]*)|\[("([^"]+)"|'([^']+)'|(\d+))\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pathText)) !== null) {
    const key = match[1] ?? match[3] ?? match[4] ?? match[5] ?? "";
    if (!key) return undefined;
    if (Array.isArray(current)) {
      const index = Number(key);
      current = Number.isInteger(index) ? current[index] : undefined;
    } else if (current && typeof current === "object") {
      current = (current as Record<string, unknown>)[key];
    } else {
      return undefined;
    }
  }
  return current;
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function shouldReplaceMcpArguments(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "{}") return true;
  const parsed = parseJsonObject(trimmed);
  return !!parsed && Object.keys(parsed).length === 0;
}

function argumentsTemplateFromTool(tool: RemoteMcpTool | undefined): string {
  const schema = objectValue(tool?.inputSchema);
  const value = valueFromJsonSchema(schema, true);
  const obj =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  return JSON.stringify(obj, null, 2);
}

function valueFromJsonSchema(
  schema: Record<string, unknown> | null,
  root = false
): unknown {
  if (!schema) return root ? {} : null;
  const examples = Array.isArray(schema.examples) ? schema.examples : [];
  if (examples.length > 0) return examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];

  const type = schemaType(schema);
  if (type === "object" || root) {
    const properties = objectValue(schema.properties) ?? {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : []
    );
    const keys = Object.keys(properties).filter(
      (key) => required.size === 0 || required.has(key)
    );
    const out: Record<string, unknown> = {};
    for (const key of keys) {
      out[key] = valueFromJsonSchema(objectValue(properties[key]));
    }
    return out;
  }
  if (type === "array") {
    return [valueFromJsonSchema(objectValue(schema.items))];
  }
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  return "";
}

function schemaType(schema: Record<string, unknown>): string {
  if (typeof schema.type === "string") return schema.type;
  if (Array.isArray(schema.type)) {
    const first = schema.type.find((item): item is string => typeof item === "string");
    if (first) return first;
  }
  if (schema.properties) return "object";
  if (schema.items) return "array";
  return "string";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  if (kind === "trigger") return "Trigger";
  if (kind === "command") return "Command";
  if (kind === "web") return "Network";
  if (kind === "file-read" || kind === "file-write") return "File";
  if (kind === "markdown") return "Output";
  if (kind === "mcp") return "MCP";
  return "AI";
}

function inputLabelForKind(kind: WorkflowNodeKind): string {
  if (kind === "command") return "Command";
  if (kind === "web") return "URL";
  if (kind === "file-read") return "Path";
  if (kind === "file-write") return "Path / content";
  if (kind === "markdown") return "Markdown";
  if (kind === "mcp") return "MCP";
  return "Prompt";
}

function nodeKind(node: WorkflowNode): WorkflowNodeKind {
  if (
    node.kind === "trigger" ||
    node.kind === "command" ||
    node.kind === "web" ||
    node.kind === "file-read" ||
    node.kind === "file-write" ||
    node.kind === "markdown" ||
    node.kind === "mcp"
  ) {
    return node.kind;
  }
  return "agent";
}

function nodeFromTemplate(
  template: BlockTemplate,
  id: string,
  blockId: number,
  x: number,
  y: number
): WorkflowNode {
  return {
    id,
    blockId,
    kind: template.kind,
    title: template.title,
    providerKind: template.providerKind ?? "codex-cli",
    model: template.model ?? "default",
    prompt: template.prompt ?? "",
    config: { ...(template.config ?? {}), icon: template.icon },
    x,
    y,
    status: "idle",
  };
}

function nodeIconName(node: WorkflowNode): WorkflowIconName {
  const icon = toWorkflowIconName(node.config?.icon);
  if (icon) return icon;
  const kind = nodeKind(node);
  if (kind === "trigger") return "trigger";
  if (kind === "command") return "command";
  if (kind === "web") return "web";
  if (kind === "file-read") return "read";
  if (kind === "file-write") return "write";
  if (kind === "markdown") return "markdown";
  if (kind === "mcp") return "mcp";
  return node.providerKind === "claude-cli" ? "claude" : "codex";
}

function toWorkflowIconName(value: unknown): WorkflowIconName | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  const current = new Set<WorkflowIconName>([
    "trigger",
    "command",
    "ai",
    "network",
    "file",
    "output",
    "claude",
    "codex",
    "web",
    "read",
    "write",
    "markdown",
    "mcp",
  ]);
  if (current.has(icon as WorkflowIconName)) return icon as WorkflowIconName;
  const legacy: Record<string, WorkflowIconName> = {
    "◇": "trigger",
    "⌁": "command",
    "✦": "ai",
    "↗": "web",
    "▣": "file",
    "◫": "output",
    C: "claude",
    X: "codex",
    R: "read",
    W: "write",
    M: "markdown",
    P: "mcp",
  };
  return legacy[icon] ?? null;
}

function WorkflowIcon({ name }: { name: WorkflowIconName }) {
  const common = {
    viewBox: "0 0 24 24",
    width: "22",
    height: "22",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: "1.5",
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };

  switch (name) {
    case "trigger":
      return (
        <svg {...common}>
          <path d="M12 3.5 20.5 12 12 20.5 3.5 12 12 3.5z" />
          <path d="m10.5 8.7 4.2 3.3-4.2 3.3V8.7z" />
        </svg>
      );
    case "command":
      return (
        <svg {...common}>
          <path d="M4.5 6.5h15v11h-15z" />
          <path d="m8 10 2.2 2L8 14" />
          <path d="M12.5 14h3.5" />
        </svg>
      );
    case "ai":
      return (
        <svg {...common}>
          <path d="M12 3.5 13.6 8 18 9.6l-4.4 1.6L12 15.5l-1.6-4.3L6 9.6 10.4 8 12 3.5z" />
          <path d="M5.7 15.2 6.5 17l1.8.8-1.8.7-.8 1.9-.7-1.9-1.8-.7L5 17l.7-1.8z" />
          <path d="m18.2 14.2.7 1.9 1.9.7-1.9.8-.7 1.9-.8-1.9-1.9-.8 1.9-.7.8-1.9z" />
        </svg>
      );
    case "network":
    case "web":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <path d="M4.8 12h14.4" />
          <path d="M12 4.5c2 2.1 3 4.6 3 7.5s-1 5.4-3 7.5" />
          <path d="M12 4.5c-2 2.1-3 4.6-3 7.5s1 5.4 3 7.5" />
        </svg>
      );
    case "file":
    case "read":
      return (
        <svg {...common}>
          <path d="M7 3.8h6.6L18 8.2v12H7z" />
          <path d="M13.5 4v4.5H18" />
          <path d="M9.5 12h5" />
          <path d="M9.5 15.5h5" />
        </svg>
      );
    case "write":
      return (
        <svg {...common}>
          <path d="M6.5 4h7L18 8.5V20H6.5z" />
          <path d="M13.5 4.2v4.5H18" />
          <path d="m10 16.4 5.4-5.4 1.6 1.6-5.4 5.4H10v-1.6z" />
        </svg>
      );
    case "output":
      return (
        <svg {...common}>
          <path d="M5 6.5h14v11H5z" />
          <path d="M8 10h8" />
          <path d="M8 13.5h5" />
          <path d="M16.5 13.5 19 16l-2.5 2.5" />
        </svg>
      );
    case "markdown":
      return (
        <svg {...common}>
          <path d="M4.5 7.5v9" />
          <path d="m4.5 7.5 4 5 4-5v9" />
          <path d="M16 7.5v9" />
          <path d="m13.8 14.3 2.2 2.2 2.2-2.2" />
        </svg>
      );
    case "mcp":
      return (
        <svg {...common}>
          <circle cx="7" cy="7" r="2.4" />
          <circle cx="17" cy="7" r="2.4" />
          <circle cx="12" cy="17" r="2.4" />
          <path d="M9.2 8.7 11 12" />
          <path d="m14.8 8.7-1.8 3.3" />
          <path d="M9.3 7h5.4" />
        </svg>
      );
    case "claude":
      return (
        <svg {...common}>
          <path d="M12 4.2 14.2 9l5 .8-3.6 3.5.9 5-4.5-2.4-4.5 2.4.9-5-3.6-3.5 5-.8L12 4.2z" />
          <path d="M12 8.5v6.8" />
          <path d="M8.7 12h6.6" />
        </svg>
      );
    case "codex":
      return (
        <svg {...common}>
          <path d="m8.3 8.2-3.2 3.8 3.2 3.8" />
          <path d="m15.7 8.2 3.2 3.8-3.2 3.8" />
          <path d="M13.2 6.8 10.8 17.2" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="M5 6.5h14v11H5z" />
          <path d="M8 10h8" />
          <path d="M8 13.5h5" />
        </svg>
      );
  }
}

function fileWriteConfig(node: WorkflowNode): { path: string; content: string } {
  const config = node.config ?? {};
  const legacy = parseFileWriteInput(node.prompt);
  return {
    path: typeof config.path === "string" ? config.path : legacy.path,
    content: typeof config.content === "string" ? config.content : legacy.content,
  };
}

function mcpNodeConfig(node: WorkflowNode): McpNodeConfig {
  const config = node.config ?? {};
  const legacyServer = typeof config.server === "string" ? config.server : "";
  const legacyTool = typeof config.tool === "string" ? config.tool : "";
  const tools = Array.isArray(config.tools)
    ? config.tools.filter(isRemoteMcpTool)
    : [];
  return {
    remoteLink:
      typeof config.remoteLink === "string" ? config.remoteLink : legacyServer,
    postUrl: typeof config.postUrl === "string" ? config.postUrl : "",
    headers:
      typeof config.headers === "string" && config.headers.trim()
        ? config.headers
        : DEFAULT_MCP_HEADERS_JSON,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    toolName:
      typeof config.toolName === "string" ? config.toolName : legacyTool,
    arguments: typeof config.arguments === "string" ? config.arguments : "{}",
    tools,
    connectedAt:
      typeof config.connectedAt === "number" ? config.connectedAt : undefined,
    connectionStatus:
      typeof config.connectionStatus === "string" ? config.connectionStatus : "",
    connectionError:
      typeof config.connectionError === "string" ? config.connectionError : "",
  };
}

function runDetailsSnapshot(node: WorkflowNode): WorkflowRunDetailSnapshot | null {
  const value = node.config?.runDetails;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<WorkflowRunDetailSnapshot>;
  if (raw.kind !== "agent" && raw.kind !== "command") return null;
  return {
    kind: raw.kind,
    title: typeof raw.title === "string" ? raw.title : node.title,
    status:
      raw.status === "running" ||
      raw.status === "success" ||
      raw.status === "error" ||
      raw.status === "stopped"
        ? raw.status
        : node.status === "running"
          ? "running"
          : node.status === "error"
            ? "error"
            : "success",
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : node.startedAt ?? Date.now(),
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : undefined,
    commandLine: typeof raw.commandLine === "string" ? raw.commandLine : "",
    stdout: typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: typeof raw.stderr === "string" ? raw.stderr : "",
    transcript: typeof raw.transcript === "string" ? raw.transcript : "",
    exitCode:
      typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined,
    signal:
      typeof raw.signal === "string" || raw.signal === null ? raw.signal : undefined,
    durationMs: typeof raw.durationMs === "number" ? raw.durationMs : undefined,
  };
}

function isRemoteMcpTool(value: unknown): value is RemoteMcpTool {
  return (
    !!value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    typeof (value as { name?: unknown }).name === "string" &&
    !!(value as { name: string }).name.trim()
  );
}

function stringRecord(value: WorkflowBlockOutput): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, raw] of Object.entries(value)) {
    if (typeof raw === "string") out[key] = raw;
    else if (typeof raw === "number" || typeof raw === "boolean") out[key] = String(raw);
  }
  return out;
}

function mcpResultText(result: unknown, error: unknown): string {
  if (error !== undefined && error !== null) return `MCP error: ${jsonPreview(error)}`;
  const text = textFromMcpContent(result);
  return text || jsonPreview(result);
}

function textFromMcpContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(textFromMcpContent).filter(Boolean).join("\n");
  if (!value || typeof value !== "object") return "";
  const obj = value as Record<string, unknown>;
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) {
    return obj.content.map(textFromMcpContent).filter(Boolean).join("\n");
  }
  if (obj.result !== undefined) return textFromMcpContent(obj.result);
  return "";
}

function jsonPreview(value: unknown): string {
  if (value === undefined) return "";
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function mcpConnectionLabel(config: McpNodeConfig): string {
  if (config.connectionStatus === "connecting") return "Connecting";
  if (config.connectionStatus === "error") return "Connection failed";
  if (config.connectionStatus === "connected") {
    return `Connected. ${config.tools.length} tool${config.tools.length === 1 ? "" : "s"}`;
  }
  if (config.tools.length > 0) {
    return `Discovered ${config.tools.length} tool${config.tools.length === 1 ? "" : "s"}`;
  }
  return "Not connected";
}

function redactUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveParam(key)) url.searchParams.set(key, "redacted");
    }
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    return url.toString();
  } catch {
    return value.replace(
      /([?&](?:api[_-]?key|key|token|access[_-]?token|auth|authorization)=)[^&#]+/gi,
      "$1redacted"
    );
  }
}

function isSensitiveParam(key: string): boolean {
  return /^(api[_-]?key|key|token|access[_-]?token|auth|authorization)$/i.test(key);
}

function cloneWorkflow(record: WorkflowRecord): WorkflowRecord {
  return JSON.parse(JSON.stringify(record)) as WorkflowRecord;
}

function restoreTopologyOnly(
  historyRecord: WorkflowRecord,
  currentRecord: WorkflowRecord
): WorkflowRecord {
  const currentById = new Map(currentRecord.nodes.map((node) => [node.id, node]));
  const nodes = historyRecord.nodes.map((historyNode) => {
    const current = currentById.get(historyNode.id);
    return current ?? historyNode;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = historyRecord.edges.filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to)
  );
  return {
    ...currentRecord,
    nodes,
    edges,
  };
}

function displayBlockId(node: WorkflowNode): number {
  return typeof node.blockId === "number" && Number.isInteger(node.blockId) && node.blockId > 0
    ? node.blockId
    : 0;
}

function nextBlockId(record: WorkflowRecord): number {
  return Math.max(0, ...record.nodes.map(displayBlockId)) + 1;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
