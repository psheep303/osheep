import { FitAddon } from "@xterm/addon-fit";
import { Terminal as XTerm } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import {
  type CSSProperties,
  lazy,
  memo,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type PointerEvent as ReactPointerEvent,
  type WheelEvent as ReactWheelEvent,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import type { MessageKey } from "../i18n/messages";
import { useUiPreferences } from "../i18n/UiPreferences";
import {
  type AgentSessionApp,
  type AiTerminalClaudePermissionMode,
  type AiTerminalCodexApproval,
  type AiTerminalCodexSandbox,
  type AiTerminalEffort,
  type AiTerminalFrame,
  type AiTerminalMode,
  type AiTerminalResult,
  aiChatStream,
  aiChatTerminalStream,
  getWorkflow as apiGetWorkflow,
  runWorkflow as apiRunWorkflow,
  saveWorkflow as apiSaveWorkflow,
  stopWorkflow as apiStopWorkflow,
  type ClaudePluginSnapshot,
  type CodexPluginSnapshot,
  callRemoteMcp,
  discoverRemoteMcp,
  execRun,
  execRunStream,
  finishAiTerminalSuccess,
  getGitDiff,
  getGitStatus,
  getClaudePlugins,
  getCodexPlugins,
  listAgentSessions,
  openTerminalSocket,
  openWorkflowRuntimeSocket,
  pauseAiTerminal,
  type RemoteMcpTool,
  type RunResult,
  readFile,
  resolveWorkflowApproval,
  resolveWorkflowInput,
  setAiTerminalAutoSuccess,
  type WorkflowEdge,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowProviderKind,
  type WorkflowRecord,
  type WorkflowRun,
  type WorkflowRunStatus,
  type WorkflowRunTrace,
  type WorkflowRuntimeEvent,
  writeFile,
} from "./api";
import { ClaudeLogo, OpenAILogo } from "./BrandIcons";
import type { MultiDiffEntry } from "./MultiDiffPane";
import { evaluateConditionExpression } from "./condition-expression";
import { ContextMenu, type CtxMenuSection } from "./ContextMenu";
import { cleanAgentTerminalConversation } from "./terminal-conversation";
import {
  compactSupersededClaudeStartup,
  createTerminalReplayGuard,
  createTerminalWriteBatcher,
  stableClaudeStartupRedraw,
  type TerminalReplayResize,
  terminalReplayHasClaudeStartupRedraw,
  terminalReplaySegments,
} from "./terminal-write-batcher";
import { normalizeLightTerminalAnsi, workflowXtermTheme, xtermAnsiTheme } from "./theme";
import {
  blockOutputText,
  canApplyWorkflowRefresh,
  findMarkdownAutoPreviewNode,
  formatCompactTokenCount,
  formatWorkflowDuration,
  type WorkflowBlockOutput,
} from "./workflow-behavior";

const MarkdownPreview = lazy(() =>
  import("./MarkdownPreview").then((module) => ({ default: module.MarkdownPreview })),
);

interface WorkflowTabProps {
  workspaceId: string;
  workflowId: string;
  onWorkflowChanged: () => void;
  onFilesChanged: () => void;
  onResumeSession: (session: { app: AgentSessionApp; id: string; title: string }) => void;
  onTemplateBinding: (binding: WorkflowRecord["templateBinding"]) => void;
  onOpenDiff: (title: string, entries: MultiDiffEntry[]) => void;
}

interface CanvasPoint {
  x: number;
  y: number;
}

interface DraftEdge extends CanvasPoint {
  from: string;
  sourceHandle?: string;
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
  button: number;
  startX: number;
  startY: number;
  startPanX: number;
  startPanY: number;
  moved: boolean;
}

interface PanOffset {
  x: number;
  y: number;
}

interface ViewportSize {
  width: number;
  height: number;
}

type BlockCategoryId =
  | "triggers"
  | "input"
  | "logic"
  | "command"
  | "git"
  | "ai"
  | "network"
  | "file"
  | "output";
type WorkflowIconName =
  | "trigger"
  | "input"
  | "cron"
  | "webhook"
  | "command"
  | "ai"
  | "network"
  | "http"
  | "set"
  | "if"
  | "merge"
  | "code"
  | "wait"
  | "json"
  | "loop"
  | "file"
  | "output"
  | "claude"
  | "codex"
  | "web"
  | "read"
  | "write"
  | "markdown"
  | "mcp"
  | "git";

interface BlockCategory {
  id: BlockCategoryId;
  labelKey: MessageKey;
  icon: WorkflowIconName;
}

interface BlockTemplate {
  category: BlockCategoryId;
  nameKey: MessageKey;
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

const DEFAULT_MCP_HEADERS_JSON = JSON.stringify(
  {
    "MCP-Protocol-Version": "2025-03-26",
  },
  null,
  2,
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

interface HttpRequestNodeConfig {
  method: string;
  url: string;
  headers: string;
  body: string;
  responseType: string;
}

interface SetNodeConfig {
  data: string;
}

interface IfNodeConfig { expression: string }

interface MergeNodeConfig {
  mode: string;
}

interface CodeNodeConfig {
  code: string;
}

interface LoopItemsNodeConfig {
  source: string;
  batchSize: number;
  mode: string;
}

interface WaitNodeConfig {
  seconds: number;
}

interface JsonNodeConfig {
  source: string;
  path: string;
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
  terminalSessionId?: string;
  conversationSessionId?: string;
  terminalStatus?: string;
  autoSuccess?: boolean;
  paused?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
}

const NODE_W = 176;
const NODE_H = 42;
const CANVAS_PADDING = 220;
const CANVAS_MIN_W = 24000;
const CANVAS_MIN_H = 16000;
const CANVAS_ORIGIN_X = CANVAS_MIN_W / 2;
const CANVAS_ORIGIN_Y = CANVAS_MIN_H / 2;
const WORLD_MIN_X = -CANVAS_ORIGIN_X + CANVAS_PADDING;
const WORLD_MIN_Y = -CANVAS_ORIGIN_Y + CANVAS_PADDING;
const SAVE_DELAY_MS = 450;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 1.8;
const ZOOM_STEP = 0.1;
let workflowAlertAudioContext: AudioContext | null = null;

function prepareWorkflowAlertSound(): void {
  try {
    workflowAlertAudioContext ??= new AudioContext();
    if (workflowAlertAudioContext.state === "suspended") {
      void workflowAlertAudioContext.resume();
    }
  } catch {
    /* Web Audio may be unavailable or blocked by browser policy. */
  }
}

function playWorkflowWaitingSound(): void {
  prepareWorkflowAlertSound();
  const audio = workflowAlertAudioContext;
  if (audio?.state !== "running") return;
  const now = audio.currentTime;
  for (const [offset, frequency] of [
    [0, 660],
    [0.16, 880],
  ] as const) {
    const oscillator = audio.createOscillator();
    const gain = audio.createGain();
    oscillator.type = "sine";
    oscillator.frequency.setValueAtTime(frequency, now + offset);
    gain.gain.setValueAtTime(0.0001, now + offset);
    gain.gain.exponentialRampToValueAtTime(0.12, now + offset + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.13);
    oscillator.connect(gain);
    gain.connect(audio.destination);
    oscillator.start(now + offset);
    oscillator.stop(now + offset + 0.14);
  }
}
const CONFIGURED_LOCAL_KINDS = new Set<WorkflowNodeKind>([
  "input",
  "http-request",
  "set",
  "if",
  "diff-approval",
  "git-commit",
  "git-checkout",
  "git-delete-branch",
  "github-pr",
  "merge",
  "code",
  "loop-items",
  "wait",
  "json",
  "mcp",
  "file-write",
  "markdown",
  "cron",
  "manual-trigger",
  "webhook-trigger",
  "codex-plugin",
  "claude-plugin",
]);
const HTTP_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE"] as const;
const HTTP_RESPONSE_TYPES = ["auto", "json", "text"] as const;
type AgentModeIcon = "manual" | "edit" | "plan" | "auto";

interface AgentModeOption {
  value: string;
  title: string;
  description: string;
  icon: AgentModeIcon;
  danger?: boolean;
}

interface AgentEffortOption {
  value: AiTerminalEffort;
  title: string;
  description?: string;
  badge?: string;
}

// Claude Code: one menu that maps directly to --permission-mode values.
const CLAUDE_MODE_OPTIONS: AgentModeOption[] = [
  {
    value: "manual",
    title: "Manual",
    description: "--permission-mode default",
    icon: "manual",
  },
  {
    value: "acceptEdits",
    title: "Edit automatically",
    description: "--permission-mode acceptEdits",
    icon: "edit",
  },
  {
    value: "plan",
    title: "Plan mode",
    description: "--permission-mode plan",
    icon: "plan",
  },
  {
    value: "auto",
    title: "Auto mode",
    description: "--permission-mode auto",
    icon: "auto",
  },
  {
    value: "dontAsk",
    title: "Dont ask",
    description: "--permission-mode dontAsk",
    icon: "auto",
    danger: true,
  },
  {
    value: "bypassPermissions",
    title: "Bypass permissions",
    description: "--permission-mode bypassPermissions",
    icon: "auto",
    danger: true,
  },
];

// Codex: approval and sandbox are separate official CLI flags.
const CODEX_MODE_OPTIONS: AgentModeOption[] = [
  {
    value: "on-request",
    title: "On request",
    description: "--ask-for-approval on-request",
    icon: "edit",
  },
  {
    value: "untrusted",
    title: "Untrusted",
    description: "--ask-for-approval untrusted",
    icon: "manual",
  },
  {
    value: "never",
    title: "Never",
    description: "--ask-for-approval never",
    icon: "auto",
    danger: true,
  },
];

const CODEX_SANDBOX_OPTIONS: AgentModeOption[] = [
  {
    value: "workspace-write",
    title: "Workspace write",
    description: "--sandbox workspace-write",
    icon: "edit",
  },
  {
    value: "read-only",
    title: "Read only",
    description: "--sandbox read-only",
    icon: "manual",
  },
  {
    value: "danger-full-access",
    title: "Danger full access",
    description: "--sandbox danger-full-access",
    icon: "auto",
    danger: true,
  },
];

const CODEX_EFFORT_OPTIONS: AgentEffortOption[] = [
  { value: "low", title: "Low" },
  { value: "medium", title: "Medium" },
  { value: "high", title: "High" },
  { value: "xhigh", title: "XHigh" },
  { value: "max", title: "Max", badge: "GPT-5.6 only" },
];
const CLAUDE_EFFORT_OPTIONS: AgentEffortOption[] = [
  { value: "low", title: "Low" },
  { value: "medium", title: "Medium" },
  { value: "high", title: "High" },
  { value: "xhigh", title: "XHigh" },
  { value: "max", title: "Max" },
  { value: "ultracode", title: "Ultracode" },
];
const MERGE_MODES = ["object", "array"] as const;
const LOOP_MODES = ["items", "batches"] as const;
const BLOCK_CATEGORIES: BlockCategory[] = [
  { id: "triggers", labelKey: "workflow.blocks.category.triggers", icon: "trigger" },
  { id: "input", labelKey: "workflow.blocks.category.input", icon: "input" },
  { id: "logic", labelKey: "workflow.blocks.category.logic", icon: "if" },
  { id: "command", labelKey: "workflow.blocks.category.command", icon: "command" },
  { id: "git", labelKey: "workflow.blocks.category.git", icon: "git" },
  { id: "ai", labelKey: "workflow.blocks.category.ai", icon: "ai" },
  { id: "network", labelKey: "workflow.blocks.category.network", icon: "network" },
  { id: "file", labelKey: "workflow.blocks.category.file", icon: "file" },
  { id: "output", labelKey: "workflow.blocks.category.output", icon: "output" },
];
const BLOCK_TEMPLATES: BlockTemplate[] = [
  {
    category: "input",
    nameKey: "workflow.blocks.input",
    kind: "input",
    icon: "input",
    config: { inputTitle: "Input" },
  },
  {
    category: "triggers",
    nameKey: "workflow.blocks.workflowRun",
    kind: "trigger",
    icon: "trigger",
  },
  {
    category: "triggers",
    nameKey: "workflow.blocks.manualTrigger",
    kind: "manual-trigger",
    icon: "trigger",
  },
  {
    category: "triggers",
    nameKey: "workflow.blocks.cron",
    kind: "cron",
    icon: "cron",
    config: {
      cron: "0 9 * * 1-5",
      timezone: "local",
    },
  },
  {
    category: "triggers",
    nameKey: "workflow.blocks.webhookTrigger",
    kind: "webhook-trigger",
    icon: "webhook",
    config: {
      method: "POST",
      path: "/workflow-hook",
    },
  },
  {
    category: "command",
    nameKey: "workflow.blocks.runCommand",
    kind: "command",
    icon: "command",
  },
  {
    category: "ai",
    nameKey: "workflow.blocks.claudeCode",
    kind: "agent",
    providerKind: "claude-cli",
    model: "default",
    icon: "claude",
    config: {
      effort: "high",
      mode: "default",
      retries: 0,
      retryForever: false,
      alwaysEnter: false,
      autoSuccess: true,
      claudePermissionMode: "acceptEdits",
      claudeMode: "acceptEdits",
    },
  },
  {
    category: "ai",
    nameKey: "workflow.blocks.codex",
    kind: "agent",
    providerKind: "codex-cli",
    model: "default",
    icon: "codex",
    config: {
      effort: "medium",
      retries: 0,
      retryForever: false,
      alwaysEnter: false,
      autoSuccess: true,
      codexApproval: "on-request",
      codexSandbox: "workspace-write",
    },
  },
  {
    category: "ai",
    nameKey: "workflow.blocks.codexPlugins",
    kind: "codex-plugin",
    icon: "codex",
    config: { pluginSelectors: [] },
  },
  {
    category: "ai",
    nameKey: "workflow.blocks.claudePlugins",
    kind: "claude-plugin",
    icon: "claude",
    config: { pluginSelectors: [] },
  },
  {
    category: "network",
    nameKey: "workflow.blocks.fetchPageText",
    kind: "web",
    prompt: "https://example.com",
    icon: "web",
  },
  {
    category: "network",
    nameKey: "workflow.blocks.httpRequest",
    kind: "http-request",
    icon: "http",
    config: {
      method: "GET",
      url: "https://api.example.com",
      headers: '{\n  "accept": "application/json"\n}',
      body: "",
      responseType: "auto",
    },
  },
  {
    category: "logic",
    nameKey: "workflow.blocks.if",
    kind: "if",
    icon: "if",
    config: {
      expression: '{{blocks[1].status}} == "success"',
    },
  },
  {
    category: "git",
    nameKey: "workflow.blocks.diffApproval",
    kind: "diff-approval",
    icon: "git",
  },
  {
    category: "git",
    nameKey: "workflow.blocks.commit",
    kind: "git-commit",
    icon: "git",
    config: { message: "", stageAll: false },
  },
  {
    category: "git",
    nameKey: "workflow.blocks.checkout",
    kind: "git-checkout",
    icon: "git",
    config: { branch: "", createIfMissing: false },
  },
  {
    category: "git",
    nameKey: "workflow.blocks.deleteBranch",
    kind: "git-delete-branch",
    icon: "git",
    config: { branch: "", force: false, remote: false, remoteName: "origin" },
  },
  {
    category: "git",
    nameKey: "workflow.blocks.pullRequest",
    kind: "github-pr",
    icon: "git",
    config: { title: "", body: "", base: "", compare: "", draft: false, push: true },
  },
  {
    category: "logic",
    nameKey: "workflow.blocks.wait",
    kind: "wait",
    icon: "wait",
    config: { seconds: 1 },
  },
  {
    category: "output",
    nameKey: "workflow.blocks.setData",
    kind: "set",
    icon: "set",
    config: {
      data: '{\n  "text": "{{blocks[1].text}}"\n}',
    },
  },
  {
    category: "output",
    nameKey: "workflow.blocks.merge",
    kind: "merge",
    icon: "merge",
    config: { mode: "object" },
  },
  {
    category: "output",
    nameKey: "workflow.blocks.jsonExtract",
    kind: "json",
    icon: "json",
    config: {
      source: "{{blocks[1].text}}",
      path: "",
    },
  },
  {
    category: "command",
    nameKey: "workflow.blocks.javascript",
    kind: "code",
    icon: "code",
    config: {
      code: 'return {\n  text: input.text || input.content || input.stdout || "",\n  input\n};',
    },
  },
  {
    category: "logic",
    nameKey: "workflow.blocks.loopItems",
    kind: "loop-items",
    icon: "loop",
    config: {
      source: "{{blocks[1].data}}",
      batchSize: 1,
      mode: "items",
    },
  },
  {
    category: "file",
    nameKey: "workflow.blocks.readFile",
    kind: "file-read",
    icon: "read",
  },
  {
    category: "file",
    nameKey: "workflow.blocks.writeFile",
    kind: "file-write",
    icon: "write",
    config: { path: "", content: "" },
  },
  {
    category: "output",
    nameKey: "workflow.blocks.markdown",
    kind: "markdown",
    prompt: "## Result\n\n{{blocks[2].text}}",
    icon: "markdown",
  },
  {
    category: "output",
    nameKey: "workflow.blocks.mcp",
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
  onResumeSession,
  onTemplateBinding,
  onOpenDiff,
}: WorkflowTabProps) {
  const { t } = useUiPreferences();
  const [workflow, setWorkflow] = useState<WorkflowRecord | null>(null);
  const [runtimeReadyWorkflowKey, setRuntimeReadyWorkflowKey] = useState("");
  const workflowRef = useRef<WorkflowRecord | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState<PanOffset>({ x: 0, y: 0 });
  const panRef = useRef<PanOffset>({ x: 0, y: 0 });
  const zoomRef = useRef(1);
  const [wrapSize, setWrapSize] = useState<ViewportSize>({ width: 0, height: 0 });
  const [draftEdge, setDraftEdge] = useState<DraftEdge | null>(null);
  const draftEdgeRef = useRef<DraftEdge | null>(null);
  const [connectHoverId, setConnectHoverId] = useState<string | null>(null);
  const [draggingNodeId, setDraggingNodeId] = useState<string | null>(null);
  const [panningCanvas, setPanningCanvas] = useState(false);
  const [nodeMenu, setNodeMenu] = useState<NodeContextMenuState | null>(null);
  const [edgeMenu, setEdgeMenu] = useState<EdgeContextMenuState | null>(null);
  const [copiedNode, setCopiedNode] = useState<WorkflowNode | null>(null);
  const [blockPickerOpen, setBlockPickerOpen] = useState(false);
  const [blockPickerCategory, setBlockPickerCategory] = useState<BlockCategoryId>("triggers");
  const [detailNodeId, setDetailNodeId] = useState<string | null>(null);
  const [observabilityOpen, setObservabilityOpen] = useState(false);
  const [observabilityRunId, setObservabilityRunId] = useState<string | null>(null);
  const [mpeNodeId, setMpeNodeId] = useState<string | null>(null);
  const [titleMenu, setTitleMenu] = useState<{ x: number; y: number } | null>(null);
  const [titleRenaming, setTitleRenaming] = useState(false);
  const [readmeOpen, setReadmeOpen] = useState(false);
  const [readmeEditing, setReadmeEditing] = useState(false);
  const [renameSeq, setRenameSeq] = useState(0);
  const [renameTarget, setRenameTarget] = useState<string | null>(null);
  const localRevisionRef = useRef(0);
  const nodeDragRef = useRef<NodeDragState | null>(null);
  const runtimeLayoutRef = useRef<Map<string, CanvasPoint>>(new Map());
  const suppressNodeClickRef = useRef<string | null>(null);
  const canvasPanRef = useRef<CanvasPanState | null>(null);
  const suppressContextMenuRef = useRef(false);
  const canvasWrapRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLDivElement | null>(null);
  const saveTimerRef = useRef<number | null>(null);
  const pendingSaveRef = useRef<WorkflowRecord | null>(null);
  const saveInFlightRef = useRef(0);
  const saveQueueRef = useRef<Promise<void>>(Promise.resolve());
  const abortRef = useRef<AbortController | null>(null);
  const waitingAlertKeyRef = useRef("");
  const workflowRuntimeConnectedRef = useRef(false);
  const workflowRuntimeEventSeqRef = useRef(0);
  const onWorkflowChangedRef = useRef(onWorkflowChanged);
  const autoSeeRunStartedAtRef = useRef(0);
  const autoSeenMarkdownRef = useRef<Set<string>>(new Set());
  const undoStackRef = useRef<WorkflowRecord[]>([]);
  const redoStackRef = useRef<WorkflowRecord[]>([]);
  const [historyTick, setHistoryTick] = useState(0);
  onWorkflowChangedRef.current = onWorkflowChanged;

  const showCompletedMarkdown = useCallback(
    (previous: WorkflowRecord | null, next: WorkflowRecord) => {
      const completedMarkdown = findMarkdownAutoPreviewNode(
        previous?.nodes,
        next.nodes,
        autoSeenMarkdownRef.current,
        autoSeeRunStartedAtRef.current,
      );
      if (!completedMarkdown) return;
      autoSeenMarkdownRef.current.add(
        `${completedMarkdown.id}:${completedMarkdown.completedAt ?? 0}`,
      );
      setMpeNodeId(completedMarkdown.id);
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setRuntimeReadyWorkflowKey("");
    setSelectedId(null);
    setReadmeOpen(false);
    setReadmeEditing(false);
    runtimeLayoutRef.current.clear();
    void apiGetWorkflow(workspaceId, workflowId)
      .then((record) => {
        if (cancelled) return;
        undoStackRef.current = [];
        redoStackRef.current = [];
        setHistoryTick((tick) => tick + 1);
        localRevisionRef.current = 0;
        workflowRef.current = record;
        setWorkflow(record);
        setRuntimeReadyWorkflowKey(`${workspaceId}\0${workflowId}`);
        onTemplateBinding(record.templateBinding);
        setRunning(workflowIsRunning(record));
        window.requestAnimationFrame(() => {
          if (!cancelled) centerView(record);
        });
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

  useEffect(() => {
    if (runtimeReadyWorkflowKey !== `${workspaceId}\0${workflowId}`) return;
    let disposed = false;
    let socket: WebSocket | null = null;
    let retryTimer: number | null = null;

    const applyEvent = (event: WorkflowRuntimeEvent) => {
      workflowRuntimeEventSeqRef.current += 1;
      const current = workflowRef.current;
      if (!current || event.type === "ready") return;
      let next = current;
      if (event.type === "node") {
        const layout = runtimeLayoutRef.current.get(event.node.id);
        const node = layout ? { ...event.node, ...layout } : event.node;
        if (!current.nodes.some((item) => item.id === node.id)) return;
        next = {
          ...current,
          updatedAt: Math.max(current.updatedAt, event.updatedAt),
          nodes: current.nodes.map((item) => (item.id === node.id ? node : item)),
        };
      } else if (event.type === "run") {
        const exists = current.runs.some((item) => item.id === event.run.id);
        next = {
          ...current,
          updatedAt: Math.max(current.updatedAt, event.updatedAt),
          runs: exists
            ? current.runs.map((item) => (item.id === event.run.id ? event.run : item))
            : [...current.runs.slice(-49), event.run],
        };
      }
      workflowRef.current = next;
      setWorkflow(next);
      showCompletedMarkdown(current, next);
      const isRunning = workflowIsRunning(next);
      setRunning(isRunning);
      if (!isRunning && event.type === "run" && event.run.status !== "running") {
        onWorkflowChangedRef.current();
      }
    };

    const refreshIfBehind = (updatedAt: number) => {
      const current = workflowRef.current;
      if (
        !current ||
        current.updatedAt >= updatedAt ||
        nodeDragRef.current ||
        pendingSaveRef.current ||
        saveInFlightRef.current > 0
      ) {
        return;
      }
      const requestedRevision = localRevisionRef.current;
      void apiGetWorkflow(workspaceId, workflowId)
        .then((record) => {
          if (
            disposed ||
            !canApplyWorkflowRefresh({
              requestedRevision,
              currentRevision: localRevisionRef.current,
              dragging: nodeDragRef.current !== null,
              pendingSave: pendingSaveRef.current !== null || saveInFlightRef.current > 0,
            })
          ) {
            return;
          }
          const next = applyNodePositions(record, runtimeLayoutRef.current);
          showCompletedMarkdown(current, next);
          workflowRef.current = next;
          setWorkflow(next);
          setRunning(workflowIsRunning(next));
        })
        .catch(() => undefined);
    };

    const connect = () => {
      if (disposed) return;
      socket = openWorkflowRuntimeSocket(workspaceId, workflowId);
      socket.onmessage = (message) => {
        try {
          const event = JSON.parse(message.data) as
            | WorkflowRuntimeEvent
            | { type: "ping" }
            | { type: "error"; message?: string };
          if (event.type === "ping") {
            if (socket?.readyState === WebSocket.OPEN) {
              socket.send(JSON.stringify({ type: "pong" }));
            }
            return;
          }
          if (event.type === "ready") {
            workflowRuntimeConnectedRef.current = true;
            refreshIfBehind(event.updatedAt);
            return;
          }
          if (event.type === "node" || event.type === "run") applyEvent(event);
        } catch {
          /* ignore malformed runtime events */
        }
      };
      socket.onclose = () => {
        workflowRuntimeConnectedRef.current = false;
        if (!disposed) retryTimer = window.setTimeout(connect, 1_000);
      };
      socket.onerror = () => socket?.close();
    };

    connect();
    return () => {
      disposed = true;
      workflowRuntimeConnectedRef.current = false;
      if (retryTimer !== null) window.clearTimeout(retryTimer);
      socket?.close();
    };
  }, [workspaceId, workflowId, runtimeReadyWorkflowKey, showCompletedMarkdown]);

  useEffect(() => {
    if (!workflowId || !workspaceId) return;
    let cancelled = false;
    const refresh = async () => {
      if (nodeDragRef.current || pendingSaveRef.current || saveInFlightRef.current > 0) return;
      const requestedRevision = localRevisionRef.current;
      try {
        const record = await apiGetWorkflow(workspaceId, workflowId);
        if (
          cancelled ||
          !canApplyWorkflowRefresh({
            requestedRevision,
            currentRevision: localRevisionRef.current,
            dragging: nodeDragRef.current !== null,
            pendingSave: pendingSaveRef.current !== null || saveInFlightRef.current > 0,
          })
        ) {
          return;
        }
        const isRunning = workflowIsRunning(record);
        const previous = workflowRef.current;
        const next = applyNodePositions(record, runtimeLayoutRef.current);
        workflowRef.current = next;
        setWorkflow(next);
        setRuntimeReadyWorkflowKey(`${workspaceId}\0${workflowId}`);
        setRunning(isRunning);
        showCompletedMarkdown(previous, next);
        if (!isRunning) onWorkflowChanged();
      } catch {
        /* keep the current snapshot while the workspace is changing */
      }
    };
    const timer = window.setInterval(() => {
      if (workflowRuntimeConnectedRef.current) return;
      void refresh();
    }, 1500);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [workspaceId, workflowId, onWorkflowChanged, showCompletedMarkdown]);

  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);

  useEffect(() => {
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const measure = () => {
      const rect = wrap.getBoundingClientRect();
      setWrapSize({ width: rect.width, height: rect.height });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [loading]);

  const selectedNode = useMemo(
    () => workflow?.nodes.find((node) => node.id === selectedId) ?? null,
    [workflow, selectedId],
  );
  const observabilityRun = useMemo(() => {
    if (!workflow) return null;
    return (
      workflow.runs.find((run) => run.id === observabilityRunId) ??
      workflow.runs[workflow.runs.length - 1] ??
      null
    );
  }, [workflow, observabilityRunId]);

  const exportRunReport = useCallback(() => {
    if (!workflow || !observabilityRun) return;
    const report = {
      workflow: { id: workflow.id, title: workflow.title },
      run: observabilityRun,
      exportedAt: new Date().toISOString(),
    };
    const blob = new Blob([JSON.stringify(report, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${workflow.title || "workflow"}-${observabilityRun.id}-report.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [workflow, observabilityRun]);
  const waitingForChoiceNode = useMemo(
    () =>
      workflow?.nodes.find((node) => {
        const snapshot = runDetailsSnapshot(node);
        return snapshot?.status === "running" && snapshot.terminalStatus === "waiting-for-choice";
      }) ?? null,
    [workflow],
  );
  const waitingForChoiceSnapshot = waitingForChoiceNode
    ? runDetailsSnapshot(waitingForChoiceNode)
    : null;
  const waitingForDiffApprovalNode =
    workflow?.nodes.find(
      (node) =>
        node.kind === "diff-approval" &&
        node.status === "running" &&
        node.config?.waitingForApproval === true,
    ) ?? null;
  const waitingForInputNode =
    workflow?.nodes.find(
      (node) =>
        node.kind === "input" &&
        node.status === "running" &&
        node.config?.waitingForInput === true,
    ) ?? null;
  const waitingAlertKey = waitingForChoiceNode
    ? `${waitingForChoiceNode.id}:${waitingForChoiceSnapshot?.terminalSessionId ?? ""}`
    : "";

  useEffect(() => {
    if (waitingAlertKey && waitingAlertKeyRef.current !== waitingAlertKey) {
      playWorkflowWaitingSound();
    }
    waitingAlertKeyRef.current = waitingAlertKey;
  }, [waitingAlertKey]);

  const canvasSize = useMemo(() => {
    const nodes = workflow?.nodes ?? [];
    const maxX = Math.max(
      0,
      ...nodes.map((node) => worldToCanvasX(node.x) + NODE_W + CANVAS_PADDING),
    );
    const maxY = Math.max(
      0,
      ...nodes.map((node) => worldToCanvasY(node.y) + NODE_H + CANVAS_PADDING),
    );
    return {
      width: Math.max(CANVAS_MIN_W, maxX),
      height: Math.max(CANVAS_MIN_H, maxY),
    };
  }, [workflow]);

  const persist = async (record: WorkflowRecord) => {
    saveInFlightRef.current += 1;
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
    try {
      await request;
    } finally {
      saveInFlightRef.current -= 1;
    }
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

  useEffect(() => {
    if (running || runtimeLayoutRef.current.size === 0) return;
    const current = workflowRef.current;
    runtimeLayoutRef.current.clear();
    if (current) scheduleSave(current);
  }, [running]);

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
    recordHistory = false,
  ) => {
    const current = workflowRef.current;
    if (!current) return;
    const next = updater(current);
    if (next === current) return;
    if (recordHistory) pushHistory(current);
    localRevisionRef.current += 1;
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
    localRevisionRef.current += 1;
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
      const target = event.target as HTMLElement | null;
      if (target?.matches("input, textarea, select") || target?.isContentEditable) {
        return;
      }
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
    localRevisionRef.current += 1;
    workflowRef.current = record;
    setWorkflow(record);
    await persist(record);
  };

  const setLiveNodePatch = (nodeId: string, patch: Partial<WorkflowNode>) => {
    const current = workflowRef.current;
    if (!current) return;
    const next = patchNode(current, nodeId, patch);
    localRevisionRef.current += 1;
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
    try {
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
      const headers = parseJsonObject(config.headers) ?? {};
      const discovery = await discoverRemoteMcp(workspaceId, {
        remoteLink,
        postUrl: config.postUrl || undefined,
        headers: stringRecord(headers),
        apiKey: config.apiKey || undefined,
      });
      const currentNode = workflowRef.current?.nodes.find((item) => item.id === nodeId) ?? node;
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
        }),
        summary: stringifyBlockOutput({
          type: "mcp",
          status: "connected",
          remoteLink: redactUrl(discovery.remoteLink),
          postUrl: redactUrl(discovery.postUrl),
          tools: discovery.tools.map((tool) => tool.name),
          text: `Connected. Discovered ${discovery.tools.length} tool${discovery.tools.length === 1 ? "" : "s"}: ${discovery.tools.map((tool) => tool.name).join(", ") || "none"}.`,
        }),
      });
    } catch (e) {
      const currentNode = workflowRef.current?.nodes.find((item) => item.id === nodeId) ?? node;
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
    const position = {
      x: Math.max(WORLD_MIN_X, Math.round(x)),
      y: Math.max(WORLD_MIN_Y, Math.round(y)),
    };
    if (running) runtimeLayoutRef.current.set(nodeId, position);
    updateWorkflow((record) => patchNode(record, nodeId, position), false);
  };

  const addBlock = (template: BlockTemplate) => {
    if (running) return;
    const nodeId = makeId("node");
    updateWorkflow(
      (record) => {
        const last = record.nodes[record.nodes.length - 1];
        const x = last ? last.x + NODE_W + 96 : 0;
        const y = last ? last.y : 0;
        const node = nodeFromTemplate(
          template,
          nodeId,
          nextBlockId(record),
          x,
          y,
          t(template.nameKey),
        );
        return { ...record, nodes: [...record.nodes, node] };
      },
      true,
      true,
    );
    setSelectedId(null);
    setBlockPickerOpen(false);
  };

  const deleteNode = (nodeId: string) => {
    if (!workflow || workflow.nodes.length <= 1) return;
    updateWorkflow(
      (record) => {
        const nodes = record.nodes.filter((node) => node.id !== nodeId);
        const edges = record.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
        if (selectedId === nodeId) setSelectedId(null);
        return { ...record, nodes, edges };
      },
      true,
      true,
    );
  };

  const copyNode = (nodeId: string) => {
    const node = workflowRef.current?.nodes.find((item) => item.id === nodeId);
    if (!node) return;
    setCopiedNode(node);
  };

  const pasteNode = (anchorId: string) => {
    if (!copiedNode || running) return;
    const nodeId = makeId("node");
    updateWorkflow(
      (record) => {
        const anchor = record.nodes.find((item) => item.id === anchorId);
        const kind = nodeKind(copiedNode);
        const node: WorkflowNode = {
          ...copiedNode,
          id: nodeId,
          blockId: nextBlockId(record),
          kind,
          title: kind === "trigger" ? copiedNode.title : `${copiedNode.title} copy`,
          x: Math.max(WORLD_MIN_X, (anchor?.x ?? copiedNode.x) + 32),
          y: Math.max(WORLD_MIN_Y, (anchor?.y ?? copiedNode.y) + 32),
          status: "idle",
          summary: "",
          rawOutput: "",
          error: "",
          startedAt: undefined,
          completedAt: undefined,
        };
        return { ...record, nodes: [...record.nodes, node] };
      },
      true,
      true,
    );
    setSelectedId(nodeId);
  };

  const addEdgeWithHistory = (
    from: string,
    to: string,
    recordHistory: boolean,
    sourceHandle?: string,
  ) => {
    if (!from || !to || from === to) return;
    updateWorkflow(
      (record) => {
        if (
          record.edges.some(
            (edge) => edge.from === from && edge.to === to && edge.sourceHandle === sourceHandle,
          )
        ) {
          return record;
        }
        return {
          ...record,
          edges: [
            ...record.edges,
            { id: makeId("edge"), from, to, passSummary: true, sourceHandle },
          ],
        };
      },
      true,
      recordHistory,
    );
  };

  const updateEdge = (edgeId: string, patch: Partial<WorkflowEdge>) => {
    updateWorkflow(
      (record) => ({
        ...record,
        edges: record.edges.map((edge) => (edge.id === edgeId ? { ...edge, ...patch } : edge)),
      }),
      true,
      true,
    );
  };

  const deleteEdge = (edgeId: string) => {
    updateWorkflow(
      (record) => ({
        ...record,
        edges: record.edges.filter((edge) => edge.id !== edgeId),
      }),
      true,
      true,
    );
  };

  const clientToCanvas = useCallback((clientX: number, clientY: number): CanvasPoint => {
    const rect = canvasWrapRef.current?.getBoundingClientRect();
    if (!rect) return { x: 0, y: 0 };
    const z = zoomRef.current || 1;
    return {
      x: (clientX - rect.left - panRef.current.x) / z - CANVAS_ORIGIN_X,
      y: (clientY - rect.top - panRef.current.y) / z - CANVAS_ORIGIN_Y,
    };
  }, []);

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

  const startNodeDrag = (node: WorkflowNode, e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
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
      if (!running) scheduleCurrentSave();
    }
  };

  const startEdgeDrag = (
    from: string,
    e: ReactPointerEvent<HTMLButtonElement>,
    sourceHandle?: string,
  ) => {
    if (running || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const point = clientToCanvas(e.clientX, e.clientY);
    setDraftEdgeState({ from, sourceHandle, ...point });
    setConnectHoverId(null);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const startInputEdgeDrag = (to: string, e: ReactPointerEvent<HTMLButtonElement>) => {
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
    if (target) addEdgeWithHistory(current.from, target, true, current.sourceHandle);
  };

  const centerView = useCallback((record?: WorkflowRecord) => {
    const wf = record ?? workflowRef.current;
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const nextZoom = 1;
    let centerX = CANVAS_ORIGIN_X;
    let centerY = CANVAS_ORIGIN_Y;
    if (wf?.nodes.length) {
      let minX = Infinity;
      let minY = Infinity;
      let maxX = -Infinity;
      let maxY = -Infinity;
      for (const node of wf.nodes) {
        minX = Math.min(minX, node.x);
        minY = Math.min(minY, node.y);
        maxX = Math.max(maxX, node.x + NODE_W);
        maxY = Math.max(maxY, node.y + NODE_H);
      }
      centerX = worldToCanvasX((minX + maxX) / 2);
      centerY = worldToCanvasY((minY + maxY) / 2);
    }
    const nextPan = snapPan({
      x: rect.width / 2 - centerX * nextZoom,
      y: rect.height / 2 - centerY * nextZoom,
    });
    zoomRef.current = nextZoom;
    setZoom(nextZoom);
    panRef.current = nextPan;
    setPan(nextPan);
  }, []);

  const zoomAround = useCallback(
    (rawZoom: number, originClientX: number, originClientY: number) => {
      const wrap = canvasWrapRef.current;
      const next = clamp(Math.round(rawZoom * 100) / 100, MIN_ZOOM, MAX_ZOOM);
      if (!wrap) {
        zoomRef.current = next;
        setZoom(next);
        return;
      }
      const rect = wrap.getBoundingClientRect();
      const mx = originClientX - rect.left;
      const my = originClientY - rect.top;
      const old = zoomRef.current || 1;
      const cx = (mx - panRef.current.x) / old;
      const cy = (my - panRef.current.y) / old;
      const nextPan = snapPan({ x: mx - cx * next, y: my - cy * next });
      zoomRef.current = next;
      setZoom(next);
      panRef.current = nextPan;
      setPan(nextPan);
    },
    [],
  );

  const setZoomValue = (value: number) => {
    const rect = canvasWrapRef.current?.getBoundingClientRect();
    const cx = rect ? rect.left + rect.width / 2 : 0;
    const cy = rect ? rect.top + rect.height / 2 : 0;
    zoomAround(value, cx, cy);
  };

  const handleWheelZoom = (e: ReactWheelEvent<HTMLDivElement>) => {
    e.preventDefault();
    const delta = e.deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
    zoomAround(zoomRef.current + delta, e.clientX, e.clientY);
  };

  const fitView = useCallback((record?: WorkflowRecord) => {
    const wf = record ?? workflowRef.current;
    const wrap = canvasWrapRef.current;
    if (!wf || !wrap || wf.nodes.length === 0) return;
    const rect = wrap.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of wf.nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + NODE_W);
      maxY = Math.max(maxY, node.y + NODE_H);
    }
    const pad = 72;
    const contentW = maxX - minX + pad * 2;
    const contentH = maxY - minY + pad * 2;
    const fitZoom = clamp(
      Math.round(Math.min(rect.width / contentW, rect.height / contentH) * 100) / 100,
      MIN_ZOOM,
      1,
    );
    const centerX = worldToCanvasX((minX + maxX) / 2);
    const centerY = worldToCanvasY((minY + maxY) / 2);
    const nextPan = snapPan({
      x: rect.width / 2 - centerX * fitZoom,
      y: rect.height / 2 - centerY * fitZoom,
    });
    zoomRef.current = fitZoom;
    setZoom(fitZoom);
    panRef.current = nextPan;
    setPan(nextPan);
  }, []);

  const autoArrange = () => {
    const current = workflowRef.current;
    if (!current) return;
    const arranged = autoLayout(current);
    if (running) {
      for (const node of arranged.nodes) {
        runtimeLayoutRef.current.set(node.id, { x: node.x, y: node.y });
      }
    }
    updateWorkflow(() => arranged, !running, false);
    window.requestAnimationFrame(() => fitView(workflowRef.current ?? undefined));
  };

  const startCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 2) return;
    if (e.button === 0) {
      const el = e.target as HTMLElement;
      if (
        el.closest(".workflow-node") ||
        el.closest(".workflow-minimap") ||
        el.closest("[data-workflow-input-id]")
      ) {
        return;
      }
    }
    const wrap = canvasWrapRef.current;
    if (!wrap) return;
    if (e.button === 2) {
      e.preventDefault();
      e.stopPropagation();
    }
    setNodeMenu(null);
    setEdgeMenu(null);
    suppressContextMenuRef.current = false;
    canvasPanRef.current = {
      pointerId: e.pointerId,
      button: e.button,
      startX: e.clientX,
      startY: e.clientY,
      startPanX: panRef.current.x,
      startPanY: panRef.current.y,
      moved: false,
    };
    setPanningCanvas(true);
    e.currentTarget.setPointerCapture(e.pointerId);
  };

  const moveCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = canvasPanRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    const dx = e.clientX - state.startX;
    const dy = e.clientY - state.startY;
    if (Math.abs(dx) > 2 || Math.abs(dy) > 2) {
      state.moved = true;
      if (state.button === 2) suppressContextMenuRef.current = true;
    }
    const next = snapPan({ x: state.startPanX + dx, y: state.startPanY + dy });
    panRef.current = next;
    setPan(next);
  };

  const finishCanvasPan = (e: ReactPointerEvent<HTMLDivElement>) => {
    const state = canvasPanRef.current;
    if (!state || state.pointerId !== e.pointerId) return;
    e.preventDefault();
    e.stopPropagation();
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
    if (state.moved && state.button === 2) suppressContextMenuRef.current = true;
    canvasPanRef.current = null;
    setPanningCanvas(false);
  };

  const navigateToCanvasPoint = useCallback((canvasX: number, canvasY: number) => {
    const rect = canvasWrapRef.current?.getBoundingClientRect();
    const z = zoomRef.current || 1;
    const width = rect?.width ?? 0;
    const height = rect?.height ?? 0;
    const next = snapPan({
      x: width / 2 - worldToCanvasX(canvasX) * z,
      y: height / 2 - worldToCanvasY(canvasY) * z,
    });
    panRef.current = next;
    setPan(next);
  }, []);

  const handleCanvasContextMenu = (e: ReactMouseEvent<HTMLDivElement>) => {
    if (suppressContextMenuRef.current) {
      e.preventDefault();
      e.stopPropagation();
      suppressContextMenuRef.current = false;
    }
  };

  const stopRun = () => {
    abortRef.current?.abort();
    void stopBackendRun();
  };

  const runSelected = async () => {
    if (!selectedNode) return;
    prepareWorkflowAlertSound();
    await startBackendRun([selectedNode.id]);
  };

  const runWorkflow = async () => {
    if (!workflow) return;
    prepareWorkflowAlertSound();
    await startBackendRun();
  };

  const startBackendRun = async (nodeIds?: string[]) => {
    const current = workflowRef.current;
    if (!current || running) return;
    await flushPendingSave();
    autoSeeRunStartedAtRef.current = Date.now();
    autoSeenMarkdownRef.current.clear();
    setRunning(true);
    setBlockPickerOpen(false);
    setError(null);
    const runtimeEventSeq = workflowRuntimeEventSeqRef.current;
    try {
      const result = await apiRunWorkflow(workspaceId, current.id, nodeIds);
      if (workflowRuntimeEventSeqRef.current === runtimeEventSeq) {
        const next = applyNodePositions(result.workflow, runtimeLayoutRef.current);
        workflowRef.current = next;
        setWorkflow(next);
      }
      onWorkflowChanged();
    } catch (e) {
      setRunning(false);
      setError((e as Error).message);
    }
  };

  const stopBackendRun = async () => {
    if (!workflowRef.current) return;
    try {
      await apiStopWorkflow(workspaceId, workflowRef.current.id);
      onWorkflowChanged();
    } catch (e) {
      setError((e as Error).message);
    }
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
              config: clearRunDetails(node.config),
              startedAt: undefined,
              completedAt: undefined,
            }
          : node,
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
        if (isTriggerNodeKind(kind)) {
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
              },
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
        let lastDetailsAt = 0;
        const runLogs: Array<{ stream: "stdout" | "stderr"; content: string }> = [];
        let terminalSessionId = "";
        let conversationSessionId = "";
        let terminalStatus = "";
        const agentSessionApp: AgentSessionApp =
          node.providerKind === "claude-cli" ? "claude" : "codex";
        const requestedConversationSessionId =
          node.providerKind === "claude-cli" ? crypto.randomUUID() : undefined;
        const existingAgentSessionIds = await loadAgentSessionIds(workspaceId, agentSessionApp);
        const autoSuccess = agentAutoSuccess(node);
        const updateAgentDetails = (
          status: WorkflowRunDetailSnapshot["status"],
          completedAt?: number,
          paused?: boolean,
        ) => {
          setLiveNodePatch(nodeId, {
            config: {
              ...(node.config ?? {}),
              runDetails: agentRunSnapshot(
                node,
                status,
                startedAt,
                completedAt,
                runLogs,
                terminalSessionId || undefined,
                conversationSessionId || undefined,
                terminalStatus || undefined,
                autoSuccess,
                paused,
              ),
            },
          });
        };
        const appendLog = (entry: { stream: "stdout" | "stderr"; content: string }) => {
          runLogs.push(entry);
          const now = Date.now();
          if (now - lastDetailsAt > 220) {
            lastDetailsAt = now;
            updateAgentDetails("running");
          }
        };
        updateAgentDetails("running");
        const mcpTools = collectMcpToolsForAgent(current, node);
        const prompt = buildBlockPrompt(current, node, mcpTools);
        const terminalPrompt = buildTerminalPrompt(current, node);
        let result: Awaited<ReturnType<typeof runAiTerminalWithRetries>>;
        try {
          result = await runAiTerminalWithRetries(
            workspaceId,
            {
              model: node.model || "default",
              kind: node.providerKind,
              messages: [{ role: "user", content: prompt }],
              terminalPrompt,
              autoSuccess,
              claudePermissionMode: agentClaudePermissionMode(node),
              mode: agentMode(node),
              codexApproval: agentCodexApproval(node),
              codexSandbox: agentCodexSandbox(node),
              effort: agentEffort(node),
              alwaysEnter: agentAlwaysEnter(node),
              conversationSessionId: requestedConversationSessionId,
            },
            (frame) => {
              if (frame.type === "session" && frame.sessionId) {
                terminalSessionId = frame.sessionId;
                updateAgentDetails("running");
              } else if (frame.type === "conversation" && frame.sessionId) {
                conversationSessionId = frame.sessionId;
                updateAgentDetails("running");
              } else if (frame.type === "status" && frame.status) {
                terminalStatus = frame.status;
                updateAgentDetails("running");
              }
            },
            ac.signal,
            agentRetryCount(node),
            agentRetryForever(node),
            appendLog,
          );
        } catch (e) {
          conversationSessionId = await discoverAgentSessionId({
            workspaceId,
            app: agentSessionApp,
            existingIds: existingAgentSessionIds,
            startedAt,
            expectedId: requestedConversationSessionId,
          });
          updateAgentDetails("error", Date.now());
          throw e;
        }
        abortRef.current = null;
        conversationSessionId =
          result.result?.conversationSessionId ||
          conversationSessionId ||
          (await discoverAgentSessionId({
            workspaceId,
            app: agentSessionApp,
            existingIds: existingAgentSessionIds,
            startedAt,
            expectedId: requestedConversationSessionId,
          }));
        const fallbackRaw = `${node.providerKind === "codex-cli" ? "Codex CLI" : "Claude Code CLI"} completed without text output.`;
        const transcriptRaw = result.result?.transcript
          ? cleanAgentTerminalConversation(
              result.result.transcript,
              node.providerKind === "claude-cli" ? "claude-cli" : "codex-cli",
            )
          : "";
        let raw =
          result.result?.content && !/completed without text output/i.test(result.result.content)
            ? result.result.content
            : transcriptRaw || fallbackRaw;
        const toolRun = result.aborted
          ? null
          : await maybeRunAgentMcpToolCalls(
              workspaceId,
              current,
              node,
              mcpTools,
              raw,
              ac.signal,
              appendLog,
            );
        if (toolRun) {
          raw = toolRun.raw;
        }
        const output = agentOutput(node, raw);
        const outputText = stringifyBlockOutput(output);
        current = workflowRef.current ?? current;
        if (result.aborted) {
          const stoppedDetails = agentRunSnapshot(
            node,
            "stopped",
            startedAt,
            Date.now(),
            runLogs,
            terminalSessionId || result.result?.sessionId,
            conversationSessionId || undefined,
            terminalStatus || undefined,
            autoSuccess,
          );
          if (result.result?.transcript) stoppedDetails.transcript = result.result.transcript;
          if (result.result?.content) stoppedDetails.stdout = result.result.content;
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
              runDetails: stoppedDetails,
            },
            completedAt: Date.now(),
          });
          current = finishRun(current, run.id, "stopped", "Stopped");
          await commitNow(current);
          return;
        }
        const successDetails = agentRunSnapshot(
          node,
          "success",
          startedAt,
          Date.now(),
          runLogs,
          terminalSessionId || result.result?.sessionId,
          conversationSessionId || undefined,
          terminalStatus || undefined,
          autoSuccess,
        );
        if (result.result?.transcript) successDetails.transcript = result.result.transcript;
        if (result.result?.content) successDetails.stdout = result.result.content;
        if (result.result) {
          successDetails.exitCode = result.result.exitCode;
          successDetails.signal =
            typeof result.result.signal === "string" || result.result.signal === null
              ? result.result.signal
              : String(result.result.signal);
        }
        current = patchNode(current, nodeId, {
          status: "success",
          rawOutput: outputText,
          summary: outputText,
          error: "",
          config: {
            ...(node.config ?? {}),
            runDetails: successDetails,
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
  void runNodes;

  if (loading) return <div className="empty-hint">Loading workflow...</div>;
  if (!workflow) {
    return <div className="empty-hint">{error ?? "Workflow failed to load."}</div>;
  }

  const wrapGridStyle: CSSProperties = {
    backgroundSize: `${32 * zoom}px ${32 * zoom}px, ${32 * zoom}px ${32 * zoom}px`,
    backgroundPosition: `${Math.round(pan.x)}px ${Math.round(pan.y)}px, ${Math.round(
      pan.x,
    )}px ${Math.round(pan.y)}px`,
  };
  const canvasStyle: CSSProperties = {
    width: canvasSize.width,
    height: canvasSize.height,
    transform: `translate3d(${Math.round(pan.x)}px, ${Math.round(pan.y)}px, 0) scale(${zoom})`,
  };
  const draftFrom = draftEdge ? workflow.nodes.find((node) => node.id === draftEdge.from) : null;
  const menuNode = nodeMenu ? workflow.nodes.find((node) => node.id === nodeMenu.nodeId) : null;
  const menuEdge = edgeMenu ? workflow.edges.find((edge) => edge.id === edgeMenu.edgeId) : null;
  const canUndo = historyTick >= 0 && undoStackRef.current.length > 0;
  const canRedo = historyTick >= 0 && redoStackRef.current.length > 0;
  const toolbarStatus = saving ? "saving" : running ? "running" : "saved";
  const nodeMenuSections: CtxMenuSection[] = menuNode
    ? [
        {
          items: [
            {
              label: "Rename",
              onSelect: () => {
                setBlockPickerOpen(false);
                setSelectedId(menuNode.id);
                setRenameTarget(menuNode.id);
                setRenameSeq((seq) => seq + 1);
              },
            },
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
        <div className="workflow-toolbar__cluster workflow-toolbar__cluster--identity">
          <div
            className="workflow-toolbar__title-label"
            title="Right-click to rename"
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              setTitleMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            {workflow.title || "Untitled workflow"}
          </div>
          <button
            className={`workflow-toolbar__readme${readmeOpen ? " is-active" : ""}`}
            onClick={() => {
              setReadmeOpen((open) => !open);
              setReadmeEditing(false);
            }}
            title="Open workflow README"
          >
            README
          </button>
          <button
            className={`workflow-toolbar__readme workflow-toolbar__run-history${observabilityOpen ? " is-active" : ""}`}
            onClick={() => setObservabilityOpen((open) => !open)}
            title={t("workflow.runHistory")}
            aria-label={t("workflow.runHistory")}
          >
            {t("workflow.runHistory")}
          </button>
          {workflow.templateBinding && (
            <span className="workflow-toolbar__template-binding">
              {workflow.templateBinding.source} template
            </span>
          )}
          <div className={`workflow-toolbar__status is-${toolbarStatus}`}>
            {toolbarStatus === "saving"
              ? "Saving"
              : toolbarStatus === "running"
                ? "Running"
                : "Saved"}
          </div>
        </div>
        <span className="workflow-toolbar__spacer" />
        <div className="workflow-toolbar__cluster">
          <button
            className="workflow-toolbar__btn workflow-toolbar__btn--icon"
            onClick={() => {
              setSelectedId(null);
              setNodeMenu(null);
              setBlockPickerOpen(true);
            }}
            disabled={running}
            title={t("workflow.blocks.add")}
            aria-label={t("workflow.blocks.add")}
          >
            <IconAddBlock />
          </button>
          <button
            className="workflow-toolbar__btn workflow-toolbar__btn--icon"
            onClick={autoArrange}
            title="自动整理"
            aria-label="Auto arrange"
          >
            <IconArrange />
          </button>
          <button
            className="workflow-toolbar__btn workflow-toolbar__btn--icon"
            onClick={() => void fitView()}
            title="适应视图"
            aria-label="Fit view"
          >
            <IconFit />
          </button>
        </div>
        <div className="workflow-toolbar__cluster">
          <button
            className="workflow-toolbar__btn workflow-toolbar__btn--icon"
            onClick={undo}
            disabled={running || !canUndo}
            title="撤销 (Ctrl+Z)"
            aria-label="Undo"
          >
            <IconUndo />
          </button>
          <button
            className="workflow-toolbar__btn workflow-toolbar__btn--icon"
            onClick={redo}
            disabled={running || !canRedo}
            title="重做 (Ctrl+Shift+Z / Ctrl+Y)"
            aria-label="Redo"
          >
            <IconRedo />
          </button>
        </div>
        <div className="workflow-toolbar__cluster workflow-toolbar__cluster--zoom">
          <div className="workflow-toolbar__zoom">
            <button
              className="workflow-toolbar__btn workflow-toolbar__btn--icon"
              onClick={() => setZoomValue(zoom - ZOOM_STEP)}
              disabled={zoom <= MIN_ZOOM}
              title="缩小"
              aria-label="Zoom out"
            >
              <IconZoomOut />
            </button>
            <span>{Math.round(zoom * 100)}%</span>
            <button
              className="workflow-toolbar__btn workflow-toolbar__btn--icon"
              onClick={() => setZoomValue(zoom + ZOOM_STEP)}
              disabled={zoom >= MAX_ZOOM}
              title="放大"
              aria-label="Zoom in"
            >
              <IconZoomIn />
            </button>
          </div>
        </div>
        <div className="workflow-toolbar__cluster workflow-toolbar__cluster--run">
          <button
            className="workflow-toolbar__btn workflow-toolbar__btn--icon"
            onClick={() => void runSelected()}
            disabled={running || !selectedNode}
            title="Run selected block"
            aria-label="Run block"
          >
            <IconPlay />
          </button>
          {running ? (
            <button
              className="workflow-toolbar__btn workflow-toolbar__btn--icon is-danger"
              onClick={stopRun}
              title="停止"
              aria-label="Stop"
            >
              <IconStop />
            </button>
          ) : (
            <button
              className="workflow-toolbar__btn workflow-toolbar__btn--icon is-primary"
              onClick={() => void runWorkflow()}
              title="Run workflow"
              aria-label="Run workflow"
            >
              <IconPlay solid />
            </button>
          )}
        </div>
      </div>

      {waitingForChoiceNode && (
        <div className="workflow-waiting-choice" role="alert" aria-live="assertive">
          <span className="workflow-waiting-choice__signal" aria-hidden="true">
            !
          </span>
          <div className="workflow-waiting-choice__message">
            <strong>等待用户选择</strong>
            <span>{waitingForChoiceNode.title} 正在等待你在终端中选择后继续。</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setSelectedId(waitingForChoiceNode.id);
              setDetailNodeId(waitingForChoiceNode.id);
            }}
          >
            打开终端
          </button>
        </div>
      )}

      {waitingForDiffApprovalNode && (
        <div className="workflow-waiting-choice" role="alert" aria-live="assertive">
          <span className="workflow-waiting-choice__signal" aria-hidden="true">
            !
          </span>
          <div className="workflow-waiting-choice__message">
            <strong>等待 Diff 审批</strong>
            <span>{waitingForDiffApprovalNode.title} 需要批准或拒绝后才能继续。</span>
          </div>
          <button
            type="button"
            onClick={() => {
              setBlockPickerOpen(false);
              setSelectedId(waitingForDiffApprovalNode.id);
            }}
          >
            查看 Diff
          </button>
        </div>
      )}

      {waitingForInputNode && workflow && (
        <WorkflowInputDialog
          key={waitingForInputNode.id}
          title={workflowInputTitle(waitingForInputNode)}
          onSubmit={async (value) => {
            await resolveWorkflowInput(
              workspaceId,
              workflow.id,
              waitingForInputNode.id,
              value,
            );
          }}
          onError={(message) => setError(message)}
        />
      )}

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
          className={`workflow-canvas-wrap${panningCanvas ? " is-panning" : ""}`}
          style={wrapGridStyle}
          onWheel={handleWheelZoom}
          onPointerDown={startCanvasPan}
          onPointerMove={moveCanvasPan}
          onPointerUp={finishCanvasPan}
          onPointerCancel={finishCanvasPan}
          onContextMenu={handleCanvasContextMenu}
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
                const path = edgePath(from, to, edge.sourceHandle);
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
                      className={`workflow-edge${edge.passSummary ? "" : " is-muted"}`}
                      d={path}
                      markerEnd="url(#workflow-arrow)"
                    />
                  </g>
                );
              })}
              {draftEdge && draftFrom && (
                <path
                  className="workflow-edge is-draft"
                  d={edgePathToPoint(draftFrom, draftEdge, draftEdge.sourceHandle)}
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
                onStartEdgeDrag={(e, sourceHandle) => startEdgeDrag(node.id, e, sourceHandle)}
                onStartInputEdgeDrag={(e) => startInputEdgeDrag(node.id, e)}
                onMoveEdgeDrag={moveEdgeDrag}
                onFinishEdgeDrag={finishEdgeDrag}
              />
            ))}
          </div>
          <WorkflowMinimap
            nodes={workflow.nodes}
            pan={pan}
            zoom={zoom}
            wrapSize={wrapSize}
            selectedId={selectedId}
            onNavigate={navigateToCanvasPoint}
          />
        </div>

        {readmeOpen && (
          <section className="workflow-readme" aria-label="Workflow README">
            <div className="workflow-readme__bar">
              <span>README.md</span>
              <button
                className="workflow-readme__mode"
                onClick={() => setReadmeEditing((editing) => !editing)}
              >
                {readmeEditing ? "result" : "edit"}
              </button>
              <button
                className="workflow-readme__close"
                onClick={() => setReadmeOpen(false)}
                title="Close README"
                aria-label="Close README"
              >
                ×
              </button>
            </div>
            <div className="workflow-readme__content">
              {readmeEditing ? (
                <textarea
                  value={workflow.readme}
                  onChange={(event) =>
                    updateWorkflow((record) => ({
                      ...record,
                      readme: event.target.value,
                    }))
                  }
                  placeholder="# About this workflow\n\nDescribe what this workflow does and how to use it."
                  spellCheck={false}
                />
              ) : workflow.readme.trim() ? (
                <Suspense fallback={<div className="tab-loading-fallback" />}>
                  <MarkdownPreview source={workflow.readme} />
                </Suspense>
              ) : (
                <div className="workflow-readme__empty">
                  No README yet. Click <strong>edit</strong> to describe this workflow.
                </div>
              )}
            </div>
          </section>
        )}

        {selectedNode && !blockPickerOpen && (
          <div className="workflow-panel-shell">
            <WorkflowNodeInspector
              key={
                renameTarget === selectedNode.id
                  ? `insp-${selectedNode.id}-${renameSeq}`
                  : `insp-${selectedNode.id}`
              }
              node={selectedNode}
              workspaceId={workspaceId}
              autoFocusName={renameTarget === selectedNode.id}
              nodes={workflow.nodes}
              edges={workflow.edges}
              running={running}
              onUpdate={(patch) => updateNode(selectedNode.id, patch)}
              onConnectMcp={() => void connectMcpNode(selectedNode.id)}
              onShowDetails={() => setDetailNodeId(selectedNode.id)}
              onShowMpe={() => setMpeNodeId(selectedNode.id)}
              onResolveApproval={(approved) =>
                resolveWorkflowApproval(workspaceId, workflow.id, selectedNode.id, approved)
              }
              onOpenDiff={onOpenDiff}
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
        {titleRenaming && (
          <div className="workflow-panel-shell">
            <WorkflowRenamePanel
              value={workflow.title}
              onSubmit={(value) => {
                const next = value.trim();
                if (next) updateTitle(next);
                setTitleRenaming(false);
              }}
              onClose={() => setTitleRenaming(false)}
            />
          </div>
        )}
      </div>
      {titleMenu && (
        <ContextMenu
          x={titleMenu.x}
          y={titleMenu.y}
          sections={[
            {
              items: [
                {
                  label: "Rename",
                  onSelect: () => {
                    setBlockPickerOpen(false);
                    setSelectedId(null);
                    setTitleRenaming(true);
                  },
                },
              ],
            },
          ]}
          onClose={() => setTitleMenu(null)}
        />
      )}
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
            workspaceId={workspaceId}
            node={workflow.nodes.find((node) => node.id === detailNodeId)!}
            trace={latestWorkflowNodeTrace(workflow, detailNodeId)}
            onClose={() => setDetailNodeId(null)}
            onResumeSession={onResumeSession}
          />
        </div>
      )}
      {mpeNodeId && workflow.nodes.some((node) => node.id === mpeNodeId) && (
        <div className="workflow-panel-shell">
          <WorkflowMpePanel
            markdown={markdownResultText(
              workflow.nodes.find((node) => node.id === mpeNodeId)!,
              workflow,
            )}
            onClose={() => setMpeNodeId(null)}
          />
        </div>
      )}
      {observabilityOpen && (
        <div className="workflow-panel-shell workflow-observability-shell">
          <WorkflowObservabilityPanel
            workflow={workflow}
            run={observabilityRun}
            selectedRunId={observabilityRun?.id ?? null}
            onSelectRun={setObservabilityRunId}
            onExport={exportRunReport}
            onClose={() => setObservabilityOpen(false)}
            onSelectNode={(nodeId) => {
              setSelectedId(nodeId);
              setDetailNodeId(nodeId);
            }}
          />
        </div>
      )}
    </div>
  );
}

function WorkflowMinimap({
  nodes,
  pan,
  zoom,
  wrapSize,
  selectedId,
  onNavigate,
}: {
  nodes: WorkflowNode[];
  pan: PanOffset;
  zoom: number;
  wrapSize: ViewportSize;
  selectedId: string | null;
  onNavigate: (canvasX: number, canvasY: number) => void;
}) {
  const MM_W = 184;
  const MM_H = 124;
  const PAD = 60;

  const bounds = useMemo(() => {
    if (nodes.length === 0) {
      return {
        minX: -CANVAS_ORIGIN_X,
        minY: -CANVAS_ORIGIN_Y,
        maxX: CANVAS_ORIGIN_X,
        maxY: CANVAS_ORIGIN_Y,
      };
    }
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const node of nodes) {
      minX = Math.min(minX, node.x);
      minY = Math.min(minY, node.y);
      maxX = Math.max(maxX, node.x + NODE_W);
      maxY = Math.max(maxY, node.y + NODE_H);
    }
    // include the current viewport so the indicator stays visible when panned away
    if (wrapSize.width && wrapSize.height && zoom) {
      const viewMinX = -pan.x / zoom - CANVAS_ORIGIN_X;
      const viewMinY = -pan.y / zoom - CANVAS_ORIGIN_Y;
      minX = Math.min(minX, viewMinX);
      minY = Math.min(minY, viewMinY);
      maxX = Math.max(maxX, viewMinX + wrapSize.width / zoom);
      maxY = Math.max(maxY, viewMinY + wrapSize.height / zoom);
    }
    return {
      minX: minX - PAD,
      minY: minY - PAD,
      maxX: maxX + PAD,
      maxY: maxY + PAD,
    };
  }, [nodes, pan, zoom, wrapSize]);

  const contentW = Math.max(1, bounds.maxX - bounds.minX);
  const contentH = Math.max(1, bounds.maxY - bounds.minY);
  const scale = Math.min(MM_W / contentW, MM_H / contentH);
  const offsetX = (MM_W - contentW * scale) / 2;
  const offsetY = (MM_H - contentH * scale) / 2;

  const toMini = (cx: number, cy: number) => ({
    x: offsetX + (cx - bounds.minX) * scale,
    y: offsetY + (cy - bounds.minY) * scale,
  });
  const fromMini = (mx: number, my: number) => ({
    x: (mx - offsetX) / scale + bounds.minX,
    y: (my - offsetY) / scale + bounds.minY,
  });

  const viewRect =
    wrapSize.width && wrapSize.height && zoom
      ? (() => {
          const tl = toMini(-pan.x / zoom - CANVAS_ORIGIN_X, -pan.y / zoom - CANVAS_ORIGIN_Y);
          return {
            x: tl.x,
            y: tl.y,
            w: (wrapSize.width / zoom) * scale,
            h: (wrapSize.height / zoom) * scale,
          };
        })()
      : null;

  const handleNavigate = (e: ReactMouseEvent<SVGSVGElement>) => {
    e.preventDefault();
    e.stopPropagation();
    const rect = e.currentTarget.getBoundingClientRect();
    const point = fromMini(e.clientX - rect.left, e.clientY - rect.top);
    onNavigate(point.x, point.y);
  };

  return (
    <div className="workflow-minimap" onPointerDown={(e) => e.stopPropagation()}>
      <svg width={MM_W} height={MM_H} onClick={handleNavigate} role="presentation">
        {nodes.map((node) => {
          const p = toMini(node.x, node.y);
          return (
            <rect
              key={node.id}
              className={`workflow-minimap__node${node.id === selectedId ? " is-selected" : ""}`}
              x={p.x}
              y={p.y}
              width={Math.max(3, NODE_W * scale)}
              height={Math.max(2, NODE_H * scale)}
              rx={1.5}
            />
          );
        })}
        {viewRect && (
          <rect
            className="workflow-minimap__view"
            x={viewRect.x}
            y={viewRect.y}
            width={viewRect.w}
            height={viewRect.h}
          />
        )}
      </svg>
    </div>
  );
}

function WorkflowRenamePanel({
  value,
  onSubmit,
  onClose,
}: {
  value: string;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => onSubmit(draft);

  return (
    <aside className="workflow-inspector workflow-rename-panel">
      <div className="workflow-inspector__head">
        <div>
          <div className="workflow-inspector__eyebrow">重命名工作流</div>
        </div>
        <button
          type="button"
          className="workflow-inspector__close"
          onClick={onClose}
          aria-label="关闭"
          title="关闭"
        >
          x
        </button>
      </div>
      <label className="workflow-inspector__field">
        <span>鍚嶇О</span>
        <input
          ref={inputRef}
          className="workflow-rename-panel__input"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              submit();
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          spellCheck={false}
        />
      </label>
      <div className="workflow-rename-panel__actions">
        <button type="button" onClick={onClose}>
          鍙栨秷
        </button>
        <button type="button" className="is-primary" onClick={submit}>
          纭畾
        </button>
      </div>
    </aside>
  );
}

function IconAddBlock() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="3.5" y="3.5" width="17" height="17" rx="3.5" />
      <path d="M12 8.4v7.2M8.4 12h7.2" />
    </svg>
  );
}

function IconArrange() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <rect x="2.5" y="4" width="6" height="5.5" rx="1.4" />
      <rect x="2.5" y="14.5" width="6" height="5.5" rx="1.4" />
      <rect x="15.5" y="9.2" width="6" height="5.5" rx="1.4" />
      <path d="M8.5 6.75h3.5a2 2 0 0 1 2 2v3.2M8.5 17.25h3.5a2 2 0 0 0 2-2v-3.2" />
    </svg>
  );
}

function IconFit() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M4 8.5V5.5A1.5 1.5 0 0 1 5.5 4h3M15.5 4h3A1.5 1.5 0 0 1 20 5.5v3M20 15.5v3a1.5 1.5 0 0 1-1.5 1.5h-3M8.5 20h-3A1.5 1.5 0 0 1 4 18.5v-3" />
    </svg>
  );
}

function IconUndo() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M9 7 5 11l4 4" />
      <path d="M6 11h7.5a5 5 0 1 1 0 10H11" />
    </svg>
  );
}

function IconRedo() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m15 7 4 4-4 4" />
      <path d="M18 11h-7.5a5 5 0 1 0 0 10H13" />
    </svg>
  );
}

function IconZoomOut() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6.5 12h11" />
    </svg>
  );
}

function IconZoomIn() {
  return (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="M6.5 12h11" />
      <path d="M12 6.5v11" />
    </svg>
  );
}

function IconPlay({ solid = false }: { solid?: boolean }) {
  return solid ? (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
      <path d="m9 7.2 8 4.8-8 4.8V7.2z" />
    </svg>
  ) : (
    <svg
      viewBox="0 0 24 24"
      width="18"
      height="18"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <path d="m9 7.2 8 4.8-8 4.8V7.2z" />
    </svg>
  );
}

function IconStop() {
  return (
    <svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" aria-hidden>
      <rect x="7.5" y="7.5" width="9" height="9" rx="1.5" />
    </svg>
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
  const { t } = useUiPreferences();
  const templates = BLOCK_TEMPLATES.filter((item) => item.category === category);

  return (
    <section className="workflow-block-picker">
      <div className="workflow-panel__head">
        <div className="workflow-inspector__eyebrow">{t("workflow.blocks.title")}</div>
        <button
          type="button"
          className="workflow-inspector__close"
          onClick={onClose}
          aria-label={t("workflow.blocks.close")}
          title={t("common.close")}
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
              {t(item.labelKey)}
            </button>
          ))}
        </nav>
        <div className="workflow-block-picker__items">
          {templates.map((template) => (
            <button
              key={`${template.category}:${template.nameKey}`}
              type="button"
              onClick={() => onAdd(template)}
            >
              <span className="workflow-block-picker__item-icon">
                <WorkflowIcon name={template.icon} />
              </span>
              <span>{t(template.nameKey)}</span>
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
  onStartEdgeDrag: (e: ReactPointerEvent<HTMLButtonElement>, sourceHandle?: string) => void;
  onStartInputEdgeDrag: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onMoveEdgeDrag: (e: ReactPointerEvent<HTMLButtonElement>) => void;
  onFinishEdgeDrag: (e: ReactPointerEvent<HTMLButtonElement>) => void;
}) {
  const nodeStyle: CSSProperties = {
    left: worldToCanvasX(node.x),
    top: worldToCanvasY(node.y),
    width: NODE_W,
    height: NODE_H,
  };
  const className =
    "workflow-node" +
    (selected ? " is-selected" : "") +
    (dragging ? " is-dragging" : "") +
    ` is-${nodeKind(node)}` +
    ` is-${node.status}`;
  const hasInputHandle = !isTriggerNodeKind(nodeKind(node));
  const hasOutputHandle = nodeKind(node) !== "markdown";
  const outputHandles = workflowOutputHandles(nodeKind(node));

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
      {hasOutputHandle && outputHandles.length === 0 && (
        <button
          type="button"
          className="workflow-node__handle workflow-node__handle--out"
          aria-label="Output connector"
          title="Output"
          disabled={running}
          onPointerDown={(event) => onStartEdgeDrag(event)}
          onPointerMove={onMoveEdgeDrag}
          onPointerUp={onFinishEdgeDrag}
          onPointerCancel={onFinishEdgeDrag}
          onClick={(e) => {
            e.preventDefault();
            e.stopPropagation();
          }}
        />
      )}

      {outputHandles.map((handle, index) => (
        <button
          key={handle}
          type="button"
          className={`workflow-node__handle workflow-node__handle--out workflow-node__handle--branch is-${handle}`}
          style={{ top: `${((index + 1) / (outputHandles.length + 1)) * 100}%` }}
          aria-label={`${handle} output connector`}
          title={handle}
          disabled={running}
          onPointerDown={(event) => onStartEdgeDrag(event, handle)}
          onPointerMove={onMoveEdgeDrag}
          onPointerUp={onFinishEdgeDrag}
          onPointerCancel={onFinishEdgeDrag}
          onClick={(event) => {
            event.preventDefault();
            event.stopPropagation();
          }}
        />
      ))}
    </div>
  );
}

function WorkflowDetailsPanel({
  workspaceId,
  node,
  trace,
  onClose,
  onResumeSession,
}: {
  workspaceId: string;
  node: WorkflowNode;
  trace?: WorkflowRunTrace;
  onClose: () => void;
  onResumeSession: (session: { app: AgentSessionApp; id: string; title: string }) => void;
}) {
  const snapshot = runDetailsSnapshot(node);
  const title = snapshot?.title || node.title;
  const status = snapshot?.status ?? node.status;
  const displayedStatus =
    status === "running" && snapshot?.terminalStatus === "waiting-for-choice"
      ? "waiting for choice"
      : status;
  const openAgentSession = async () => {
    if (snapshot?.kind !== "agent") return;
    const app: AgentSessionApp = node.providerKind === "claude-cli" ? "claude" : "codex";
    let sessionId = snapshot.conversationSessionId;
    if (!sessionId) {
      try {
        const sessions = await listAgentSessions(app, workspaceId);
        const recent = sessions
          .filter((session) => session.updatedAt >= snapshot.startedAt - 10 * 60 * 1000)
          .sort((a, b) => b.updatedAt - a.updatedAt);
        sessionId = (recent[0] ?? sessions.sort((a, b) => b.updatedAt - a.updatedAt)[0])?.id;
      } catch {
        return;
      }
    }
    if (sessionId) onResumeSession({ app, id: sessionId, title });
  };
  return (
    <aside className="workflow-inspector workflow-run-details">
      <div className="workflow-inspector__head">
        <div>
          <div className="workflow-inspector__eyebrow">Run details</div>
          <span className={`workflow-inspector__status is-${status}`}>{displayedStatus}</span>
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
        {snapshot?.durationMs !== undefined && (
          <span>
            {snapshot.kind === "agent"
              ? formatWorkflowDuration(snapshot.durationMs)
              : `${snapshot.durationMs}ms`}
          </span>
        )}
        {snapshot?.exitCode !== undefined && <span>exit {snapshot.exitCode ?? "signal"}</span>}
        {snapshot?.kind === "agent" && snapshot.status !== "running" && (
          <button
            type="button"
            className="workflow-run-details__open-session"
            onClick={() => void openAgentSession()}
          >
            Open in {node.providerKind === "claude-cli" ? "Claude Code" : "Codex"}
          </button>
        )}
      </div>
      {snapshot?.kind === "agent" && (
        <WorkflowTraceUsageStats trace={trace} className="workflow-run-details__usage" />
      )}
      {snapshot?.kind === "agent" &&
        snapshot.conversationSessionId &&
        snapshot.status === "running" && (
          <div className="workflow-run-details__session">
            <span>Session</span>
            <code>{snapshot.conversationSessionId}</code>
          </div>
        )}
      <div className="workflow-run-details__terminal">
        <div className="workflow-run-details__bar">
          <span />
          <span />
          <span />
          <strong>{snapshot?.commandLine || "No run captured"}</strong>
        </div>
        {snapshot?.kind === "agent" &&
        snapshot.terminalSessionId &&
        snapshot.status === "running" ? (
          <WorkflowAgentTerminal
            workspaceId={workspaceId}
            sessionId={snapshot.terminalSessionId}
            terminalStatus={snapshot.terminalStatus}
            initialAutoSuccess={snapshot.autoSuccess ?? true}
          />
        ) : (
          <WorkflowFinishedRunResult node={node} snapshot={snapshot} />
        )}
      </div>
    </aside>
  );
}

function WorkflowObservabilityPanel({
  workflow,
  run,
  selectedRunId,
  onSelectRun,
  onExport,
  onClose,
  onSelectNode,
}: {
  workflow: WorkflowRecord;
  run: WorkflowRun | null;
  selectedRunId: string | null;
  onSelectRun: (id: string) => void;
  onExport: () => void;
  onClose: () => void;
  onSelectNode: (id: string) => void;
}) {
  const { resolvedLanguage, t } = useUiPreferences();
  const traces = run?.trace ?? [];
  const stats = run?.stats;
  const traceTokenStats = summarizeWorkflowTraceTokens(traces);
  const inputTokens = stats?.inputTokens ?? traceTokenStats.input;
  const outputTokens = stats?.outputTokens ?? traceTokenStats.output;
  const cacheReadTokens = stats?.cacheReadTokens ?? traceTokenStats.cacheRead;
  const cacheWriteTokens = stats?.cacheWriteTokens ?? traceTokenStats.cacheWrite;
  const totalTokens =
    stats?.totalTokens ??
    traceTokenStats.total ??
    (inputTokens !== undefined || outputTokens !== undefined
      ? (inputTokens ?? 0) + (outputTokens ?? 0)
      : undefined);
  const [selectedTraceKey, setSelectedTraceKey] = useState("");
  const selectedTrace: WorkflowRunTrace | null =
    traces.find((trace) => `${trace.nodeId}:${trace.startedAt}` === selectedTraceKey) ??
    traces[0] ??
    null;
  return (
    <aside className="workflow-inspector workflow-observability">
      <div className="workflow-inspector__head">
        <div>
          <div className="workflow-inspector__eyebrow">{t("workflow.observability.title")}</div>
          <strong>{workflow.title}</strong>
        </div>
        <div className="workflow-inspector__head-actions">
          <button
            type="button"
            onClick={onExport}
            disabled={!run}
            title={t("workflow.observability.exportTitle")}
          >
            {t("workflow.observability.export")}
          </button>
          <button
            type="button"
            className="workflow-inspector__close"
            onClick={onClose}
            aria-label={t("common.close")}
          >
            x
          </button>
        </div>
      </div>
      <label className="workflow-observability__run-select">
        <span>{t("workflow.runHistory")}</span>
        <select value={selectedRunId ?? ""} onChange={(e) => onSelectRun(e.target.value)}>
          {workflow.runs.length === 0 && (
            <option value="">{t("workflow.observability.noRuns")}</option>
          )}
          {workflow.runs
            .slice()
            .reverse()
            .map((item) => (
              <option key={item.id} value={item.id}>
                {item.id} · {workflowRunStatusLabel(item.status, t)}
              </option>
            ))}
        </select>
      </label>
      {run && (
        <>
          <div className="workflow-observability__summary">
            <WorkflowObservabilityStat label={t("workflow.observability.status")}>
              <strong className={`is-${run.status}`}>
                {workflowRunStatusLabel(run.status, t)}
              </strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.duration")}>
              <strong>
                {formatWorkflowDuration(
                  stats?.durationMs ?? (run.completedAt ? run.completedAt - run.startedAt : 0),
                )}
              </strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.nodes")}>
              <strong>{stats?.nodeCount ?? traces.length}</strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.retries")}>
              <strong>{stats?.retryCount ?? 0}</strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.inputTokens")}>
              <strong>{formatWorkflowTokenCount(inputTokens, resolvedLanguage, t)}</strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.outputTokens")}>
              <strong>{formatWorkflowTokenCount(outputTokens, resolvedLanguage, t)}</strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.cacheReadTokens")}>
              <strong>{formatWorkflowTokenCount(cacheReadTokens, resolvedLanguage, t)}</strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.cacheWriteTokens")}>
              <strong>{formatWorkflowTokenCount(cacheWriteTokens, resolvedLanguage, t)}</strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.totalTokens")}>
              <strong>{formatWorkflowTokenCount(totalTokens, resolvedLanguage, t)}</strong>
            </WorkflowObservabilityStat>
            <WorkflowObservabilityStat label={t("workflow.observability.cost")}>
              <strong>{formatWorkflowCost(stats?.cost, t)}</strong>
            </WorkflowObservabilityStat>
          </div>
          <div className="workflow-observability__timeline">
            {traces.length === 0 ? (
              <div className="workflow-inspector__muted">{t("workflow.observability.noTrace")}</div>
            ) : (
              traces.map((trace) => (
                <button
                  type="button"
                  className={`workflow-observability__event${selectedTrace === trace ? " is-selected" : ""}`}
                  key={`${trace.nodeId}:${trace.startedAt}`}
                  onClick={() => setSelectedTraceKey(`${trace.nodeId}:${trace.startedAt}`)}
                  onDoubleClick={() => onSelectNode(trace.nodeId)}
                >
                  <span className={`workflow-observability__dot is-${trace.status}`} />
                  <span className="workflow-observability__event-main">
                    <strong>{trace.title}</strong>
                    <small>
                      {trace.kind} · {workflowRunStatusLabel(trace.status, t)}
                    </small>
                  </span>
                  <span className="workflow-observability__event-cost">
                    {trace.kind === "agent"
                      ? trace.cost !== undefined
                        ? formatWorkflowCost(trace.cost, t)
                        : "—"
                      : ""}
                  </span>
                  <span className="workflow-observability__event-time">
                    {trace.durationMs !== undefined
                      ? formatWorkflowDuration(trace.durationMs)
                      : "..."}
                  </span>
                  {trace.retryReasons?.length ? (
                    <span className="workflow-observability__retry">
                      {t("workflow.observability.retryCount", { count: trace.retryReasons.length })}
                    </span>
                  ) : null}
                </button>
              ))
            )}
          </div>
          {selectedTrace && (
            <div className="workflow-observability__detail">
              <div className="workflow-observability__detail-head">
                <strong>{selectedTrace.title}</strong>
                <button type="button" onClick={() => onSelectNode(selectedTrace.nodeId)}>
                  {t("workflow.observability.openNode")}
                </button>
              </div>
              {selectedTrace.kind === "agent" && (
                <WorkflowTraceUsageStats
                  trace={selectedTrace}
                  className="workflow-observability__detail-usage"
                />
              )}
              <details open>
                <summary>{t("workflow.observability.input")}</summary>
                <pre>{formatTraceValue(selectedTrace.input, t)}</pre>
              </details>
              <details open>
                <summary>{t("workflow.observability.output")}</summary>
                <pre>{formatTraceValue(selectedTrace.output, t)}</pre>
              </details>
              {selectedTrace.retryReasons?.length ? (
                <details>
                  <summary>{t("workflow.observability.retryReasons")}</summary>
                  <pre>{selectedTrace.retryReasons.join("\n")}</pre>
                </details>
              ) : null}
              {selectedTrace.terminal ? (
                <details>
                  <summary>{t("workflow.observability.terminalLog")}</summary>
                  <pre>
                    {selectedTrace.terminal.transcript ||
                      selectedTrace.terminal.stdout ||
                      selectedTrace.terminal.stderr ||
                      selectedTrace.terminal.commandLine ||
                      t("workflow.observability.noTerminalOutput")}
                  </pre>
                </details>
              ) : null}
            </div>
          )}
          {run.error && <div className="workflow-inspector__notice is-error">{run.error}</div>}
        </>
      )}
    </aside>
  );
}

type WorkflowTranslate = ReturnType<typeof useUiPreferences>["t"];

function WorkflowObservabilityStat({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <span>{label}</span>
      {children}
    </div>
  );
}

function WorkflowTraceUsageStats({
  trace,
  className,
}: {
  trace?: WorkflowRunTrace;
  className?: string;
}) {
  const { resolvedLanguage, t } = useUiPreferences();
  const tokens = trace?.tokens;
  const total =
    tokens?.total ??
    (tokens?.input !== undefined || tokens?.output !== undefined
      ? (tokens.input ?? 0) +
        (tokens.output ?? 0) +
        (tokens.cacheRead ?? 0) +
        (tokens.cacheWrite ?? 0)
      : undefined);
  const stats = [
    [
      t("workflow.observability.inputTokens"),
      formatWorkflowTokenCount(tokens?.input, resolvedLanguage, t),
    ],
    [
      t("workflow.observability.outputTokens"),
      formatWorkflowTokenCount(tokens?.output, resolvedLanguage, t),
    ],
    [
      t("workflow.observability.cacheReadTokens"),
      formatWorkflowTokenCount(tokens?.cacheRead, resolvedLanguage, t),
    ],
    [
      t("workflow.observability.cacheWriteTokens"),
      formatWorkflowTokenCount(tokens?.cacheWrite, resolvedLanguage, t),
    ],
    [t("workflow.observability.totalTokens"), formatWorkflowTokenCount(total, resolvedLanguage, t)],
    [t("workflow.observability.cost"), formatWorkflowCost(trace?.cost, t)],
  ];

  return (
    <div className={`workflow-usage-stats${className ? ` ${className}` : ""}`}>
      {stats.map(([label, value]) => (
        <div key={label}>
          <span>{label}</span>
          <strong>{value}</strong>
        </div>
      ))}
    </div>
  );
}

function workflowRunStatusLabel(status: WorkflowRunStatus, t: WorkflowTranslate): string {
  return t(`workflow.status.${status}`);
}

function latestWorkflowNodeTrace(
  workflow: WorkflowRecord,
  nodeId: string,
): WorkflowRunTrace | undefined {
  for (let runIndex = workflow.runs.length - 1; runIndex >= 0; runIndex -= 1) {
    const traces = workflow.runs[runIndex]?.trace ?? [];
    for (let traceIndex = traces.length - 1; traceIndex >= 0; traceIndex -= 1) {
      if (traces[traceIndex]?.nodeId === nodeId) return traces[traceIndex];
    }
  }
  return undefined;
}

function summarizeWorkflowTraceTokens(traces: WorkflowRunTrace[]): {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  total?: number;
} {
  let hasInput = false;
  let hasOutput = false;
  let hasCacheRead = false;
  let hasCacheWrite = false;
  let hasTotal = false;
  let input = 0;
  let output = 0;
  let cacheRead = 0;
  let cacheWrite = 0;
  let total = 0;
  for (const trace of traces) {
    if (trace.tokens?.input !== undefined) {
      hasInput = true;
      input += trace.tokens.input;
    }
    if (trace.tokens?.output !== undefined) {
      hasOutput = true;
      output += trace.tokens.output;
    }
    if (trace.tokens?.cacheRead !== undefined) {
      hasCacheRead = true;
      cacheRead += trace.tokens.cacheRead;
    }
    if (trace.tokens?.cacheWrite !== undefined) {
      hasCacheWrite = true;
      cacheWrite += trace.tokens.cacheWrite;
    }
    const traceTotal =
      trace.tokens?.total ??
      (trace.tokens?.input !== undefined || trace.tokens?.output !== undefined
        ? (trace.tokens.input ?? 0) + (trace.tokens.output ?? 0)
        : undefined);
    if (traceTotal !== undefined) {
      hasTotal = true;
      total += traceTotal;
    }
  }
  return {
    input: hasInput ? input : undefined,
    output: hasOutput ? output : undefined,
    cacheRead: hasCacheRead ? cacheRead : undefined,
    cacheWrite: hasCacheWrite ? cacheWrite : undefined,
    total: hasTotal ? total : undefined,
  };
}

function formatWorkflowTokenCount(
  count: number | undefined,
  language: string,
  t: WorkflowTranslate,
): string {
  return count === undefined
    ? t("workflow.observability.unavailable")
    : formatCompactTokenCount(count, language);
}

function formatWorkflowCost(cost: number | undefined, t: WorkflowTranslate): string {
  if (cost === undefined) return t("workflow.observability.unavailable");
  if (cost === 0) return "$0.0000";
  return `$${cost.toFixed(cost < 0.0001 ? 8 : 4)}`;
}

function markdownAutoSeeResult(node: WorkflowNode): boolean {
  return node.config?.autoSeeResult === true;
}

function markdownResultText(node: WorkflowNode, workflow: WorkflowRecord): string {
  if (node.rawOutput) {
    try {
      const parsed = JSON.parse(node.rawOutput) as { markdown?: unknown; text?: unknown };
      if (typeof parsed.markdown === "string") return parsed.markdown;
      if (typeof parsed.text === "string") return parsed.text;
    } catch {
      /* fall back to the configured markdown template */
    }
  }
  return resolveBlockTemplatePreview(node.prompt, workflow);
}

function formatTraceValue(value: unknown, t: WorkflowTranslate): string {
  if (value === undefined) return t("workflow.observability.notRecorded");
  if (typeof value === "string") return value || t("workflow.observability.empty");
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function WorkflowFinishedRunResult({
  node,
  snapshot,
}: {
  node: WorkflowNode;
  snapshot: WorkflowRunDetailSnapshot | null;
}) {
  if (!snapshot) {
    return <pre>Run this block to capture a terminal snapshot.</pre>;
  }
  if (snapshot.kind === "command") {
    return <pre>{snapshot.transcript || snapshot.stdout || snapshot.stderr}</pre>;
  }
  const message = workflowAgentLastMessage(node, snapshot);
  return (
    <div className="workflow-run-details__answer">
      <Suspense fallback={<div className="tab-loading-fallback" />}>
        <MarkdownPreview source={message || snapshot.stderr || "No final message was captured."} />
      </Suspense>
    </div>
  );
}

function workflowAgentLastMessage(node: WorkflowNode, snapshot: WorkflowRunDetailSnapshot): string {
  const output = parseJsonObject(node.rawOutput || node.summary || "");
  const outputText = output ? textFromOutput(output) : "";
  if (outputText && !/completed without text output/i.test(outputText)) return outputText;

  const conversation = readableAgentConversation(snapshot);
  const structured = [
    ...conversation.matchAll(
      /^(?:Claude|Assistant):\n([\s\S]*?)(?=^(?:User|Claude|Assistant|Tool(?: · \S+)?|Tool result|Tool error):\n|$)/gm,
    ),
  ];
  const lastStructured =
    structured.length > 0 ? structured[structured.length - 1]?.[1]?.trim() : "";
  return lastStructured || conversation.trim();
}

function readableAgentConversation(snapshot: WorkflowRunDetailSnapshot): string {
  const structured = /^(?:User|Claude|Tool(?: · \S+)?|Tool result|Tool error):/m.test(
    snapshot.transcript,
  );
  if (structured) return snapshot.transcript.trim();
  const rawTerminal = /\x1b|\r/.test(snapshot.stdout) ? snapshot.stdout : "";
  const source = rawTerminal || snapshot.transcript || snapshot.stdout;
  const kind = /^\s*codex(?:\.exe)?\b/i.test(snapshot.commandLine) ? "codex-cli" : "claude-cli";
  const cleaned = cleanAgentTerminalConversation(source, kind);
  if (snapshot.status !== "error" || !snapshot.stderr.trim()) return cleaned;
  if (cleaned.includes(snapshot.stderr.trim())) return cleaned;
  return [cleaned, `[error] ${snapshot.stderr.trim()}`].filter(Boolean).join("\n");
}

function WorkflowAgentTerminalInner({
  workspaceId,
  sessionId,
  terminalStatus,
  initialAutoSuccess,
}: {
  workspaceId: string;
  sessionId: string;
  terminalStatus?: string;
  initialAutoSuccess: boolean;
}) {
  const { resolvedTheme } = useUiPreferences();
  const hostRef = useRef<HTMLDivElement | null>(null);
  const termRef = useRef<XTerm | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const resolvedThemeRef = useRef(resolvedTheme);
  const [paused, setPaused] = useState(false);
  const [autoSuccess, setAutoSuccess] = useState(initialAutoSuccess);
  const canMarkSuccess = canManuallyMarkAgentSuccess(terminalStatus);
  resolvedThemeRef.current = resolvedTheme;

  useEffect(() => {
    setAutoSuccess(initialAutoSuccess);
  }, [initialAutoSuccess, sessionId]);

  useEffect(() => {
    if (!hostRef.current) return;
    const term = new XTerm({
      convertEol: false,
      cursorBlink: true,
      fontFamily: "Geist Mono, SFMono-Regular, Cascadia Mono, Consolas, Courier New, monospace",
      fontSize: 12.5,
      minimumContrastRatio: resolvedTheme === "light" ? 4.5 : 1,
      scrollback: 8000,
      theme: { ...workflowXtermTheme(resolvedTheme), ...xtermAnsiTheme(resolvedTheme) },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(hostRef.current);
    termRef.current = term;
    fitRef.current = fit;
    const fitToUsableDimensions = () => {
      const dimensions = fit.proposeDimensions();
      if (!dimensions || dimensions.cols < 20 || dimensions.rows < 4) return null;
      if (term.cols !== dimensions.cols || term.rows !== dimensions.rows) {
        term.resize(dimensions.cols, dimensions.rows);
      }
      return dimensions;
    };
    try {
      fitToUsableDimensions();
    } catch {
      /* layout race */
    }
    const fittedCols = term.cols;
    const fittedRows = term.rows;

    const ws = openTerminalSocket(`/api/terminals/${encodeURIComponent(sessionId)}/io`);
    wsRef.current = ws;
    let replayReady = false;
    let replayOutput: string[] = [];
    let suppressStartupOutput = false;
    let suppressedStartupOutputVersion = 0;
    let awaitingStartupRedraw = false;
    let startupPreResizeOutput = "";
    let startupRedrawFallbackTimer: ReturnType<typeof setTimeout> | null = null;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;
    const outputWriter = createTerminalWriteBatcher((data) => term.write(data));
    const replayGuard = createTerminalReplayGuard((data, callback) => term.write(data, callback));
    const drainReplayOutput = (initial: string, onDrained: () => void) => {
      const pending = initial + replayOutput.join("");
      replayOutput = [];
      replayGuard.write(pending, () => {
        if (replayOutput.length > 0) {
          drainReplayOutput("", onDrained);
          return;
        }
        onDrained();
      });
    };
    const finishStartupRedraw = (preserveTransition: boolean) => {
      if (!awaitingStartupRedraw) return false;
      const postResizeOutput = replayOutput.join("");
      const stableRedraw = stableClaudeStartupRedraw(postResizeOutput);
      if (!preserveTransition && stableRedraw === null) return false;
      if (startupRedrawFallbackTimer) clearTimeout(startupRedrawFallbackTimer);
      startupRedrawFallbackTimer = null;
      awaitingStartupRedraw = false;
      replayOutput = [];
      const pending = stableRedraw ?? startupPreResizeOutput + postResizeOutput;
      startupPreResizeOutput = "";
      drainReplayOutput(pending, () => {
        replayReady = true;
      });
      return true;
    };
    ws.onopen = () => {
      term.focus();
    };
    ws.onmessage = (ev) => {
      try {
        const msg = JSON.parse(ev.data) as {
          type?: string;
          data?: string;
          cols?: number;
          rows?: number;
          initialCols?: number;
          initialRows?: number;
          resizes?: TerminalReplayResize[];
          compactStartup?: boolean;
          code?: number | null;
          signal?: number | string | null;
        };
        if (msg.type === "replay" && typeof msg.data === "string") {
          outputWriter.flush();
          const replayResizes = [...(msg.resizes ?? [])];
          const hasHistoricalStartupRedraw = terminalReplayHasClaudeStartupRedraw(
            msg.data,
            replayResizes,
          );
          const hasStartupWelcome =
            replayResizes.length === 0 &&
            compactSupersededClaudeStartup(msg.data).length < msg.data.length;
          const compactOpeningStartup =
            (msg.compactStartup === true || hasHistoricalStartupRedraw || hasStartupWelcome) &&
            (msg.cols !== fittedCols || msg.rows !== fittedRows) &&
            compactSupersededClaudeStartup(msg.data).length < msg.data.length;
          if (compactOpeningStartup) {
            replayResizes.push({
              offset: msg.data.length,
              cols: fittedCols,
              rows: fittedRows,
              compactStartup: true,
            });
            suppressStartupOutput = true;
          }
          const segments = terminalReplaySegments(
            msg.data,
            msg.cols ?? term.cols,
            msg.rows ?? term.rows,
            msg.initialCols,
            msg.initialRows,
            replayResizes,
          );
          const finishReplay = () => {
            if (suppressStartupOutput) {
              const outputVersion = suppressedStartupOutputVersion;
              replayGuard.write(
                "",
                () => {
                  if (outputVersion !== suppressedStartupOutputVersion) {
                    finishReplay();
                    return;
                  }
                  suppressStartupOutput = false;
                  startupPreResizeOutput = replayOutput.join("");
                  replayOutput = [];
                  awaitingStartupRedraw = true;
                  try {
                    fitToUsableDimensions();
                    if (ws.readyState === WebSocket.OPEN) {
                      ws.send(
                        JSON.stringify({
                          type: "resize",
                          cols: term.cols,
                          rows: term.rows,
                          compactStartup: true,
                        }),
                      );
                    }
                  } catch {
                    /* layout race */
                  }
                  startupRedrawFallbackTimer = setTimeout(() => {
                    finishStartupRedraw(true);
                  }, 700);
                },
                true,
                300,
              );
              return;
            }
            const pending = replayOutput.join("");
            replayOutput = [];
            replayGuard.write(pending, () => {
              if (replayOutput.length > 0) {
                finishReplay();
                return;
              }
              replayReady = true;
              try {
                fitToUsableDimensions();
                if (ws.readyState === WebSocket.OPEN) {
                  ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
                }
              } catch {
                /* layout race */
              }
            });
          };
          const writeSegment = (index: number) => {
            const segment = segments[index];
            if (!segment) {
              finishReplay();
              return;
            }
            if (term.cols !== segment.cols || term.rows !== segment.rows) {
              term.resize(segment.cols, segment.rows);
            }
            replayGuard.write(
              normalizeLightTerminalAnsi(segment.data, resolvedThemeRef.current),
              () => writeSegment(index + 1),
              false,
            );
          };
          writeSegment(0);
        } else if (msg.type === "output" && typeof msg.data === "string") {
          const data = normalizeLightTerminalAnsi(msg.data, resolvedThemeRef.current);
          if (replayReady) outputWriter.push(data);
          else {
            replayOutput.push(data);
            if (suppressStartupOutput) suppressedStartupOutputVersion += 1;
            else if (awaitingStartupRedraw) finishStartupRedraw(false);
          }
        } else if (msg.type === "exit") {
          outputWriter.flush();
          term.writeln(
            `\r\n\x1b[2m[osheep] terminal exited code=${msg.code ?? "null"} signal=${
              msg.signal ?? "null"
            }\x1b[0m`,
          );
        } else if (msg.type === "ping") {
          ws.send(JSON.stringify({ type: "pong" }));
        } else if (msg.type === "error") {
          outputWriter.flush();
          term.writeln(`\r\n\x1b[31m[osheep] terminal session is no longer available\x1b[0m`);
        }
      } catch {
        /* ignore */
      }
    };

    const inputSub = term.onData((data) => {
      if (replayReady && replayGuard.acceptsInput() && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "input", data }));
      }
    });
    const resizeObs = new ResizeObserver(() => {
      if (!replayReady) return;
      if (resizeTimer) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        try {
          const previousCols = term.cols;
          const previousRows = term.rows;
          const dimensions = fitToUsableDimensions();
          if (
            dimensions &&
            (previousCols !== dimensions.cols || previousRows !== dimensions.rows) &&
            ws.readyState === WebSocket.OPEN
          ) {
            ws.send(JSON.stringify({ type: "resize", cols: term.cols, rows: term.rows }));
          }
        } catch {
          /* layout race */
        }
      }, 120);
    });
    resizeObs.observe(hostRef.current);

    return () => {
      resizeObs.disconnect();
      if (resizeTimer) clearTimeout(resizeTimer);
      if (startupRedrawFallbackTimer) clearTimeout(startupRedrawFallbackTimer);
      inputSub.dispose();
      outputWriter.dispose();
      ws.close();
      term.dispose();
      wsRef.current = null;
      termRef.current = null;
      fitRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    const term = termRef.current;
    if (term) {
      term.options.theme = {
        ...workflowXtermTheme(resolvedTheme),
        ...xtermAnsiTheme(resolvedTheme),
      };
      term.options.minimumContrastRatio = resolvedTheme === "light" ? 4.5 : 1;
      term.refresh(0, term.rows - 1);
    }
  }, [resolvedTheme]);

  const updateAutoSuccess = async (enabled: boolean) => {
    setAutoSuccess(enabled);
    try {
      await setAiTerminalAutoSuccess(workspaceId, sessionId, enabled);
      termRef.current?.focus();
    } catch (e) {
      setAutoSuccess(!enabled);
      termRef.current?.writeln(
        `\r\n\x1b[31m[osheep] auto success update failed: ${(e as Error).message}\x1b[0m`,
      );
    }
  };

  const pauseSession = async () => {
    setPaused(true);
    try {
      await pauseAiTerminal(workspaceId, sessionId);
      termRef.current?.focus();
    } catch (e) {
      setPaused(false);
      termRef.current?.writeln(`\r\n\x1b[31m[osheep] pause failed: ${(e as Error).message}\x1b[0m`);
    }
  };

  const markSuccess = async () => {
    try {
      await finishAiTerminalSuccess(workspaceId, sessionId);
      termRef.current?.focus();
    } catch (e) {
      termRef.current?.writeln(
        `\r\n\x1b[31m[osheep] success failed: ${(e as Error).message}\x1b[0m`,
      );
    }
  };

  return (
    <div className="workflow-run-details__xterm">
      <div className="workflow-run-details__controls">
        <button
          type="button"
          className={paused ? "is-active" : ""}
          onClick={() => void pauseSession()}
        >
          pause
        </button>
        <button type="button" onClick={() => void markSuccess()} disabled={!canMarkSuccess}>
          success
        </button>
        <label className="workflow-run-details__toggle">
          <input
            type="checkbox"
            checked={autoSuccess}
            onChange={(e) => void updateAutoSuccess(e.target.checked)}
          />
          <span>auto success</span>
        </label>
        <span>
          {paused
            ? "manual input enabled"
            : terminalStatus === "ready-for-success"
              ? "ready to mark success"
              : terminalStatus === "waiting-for-choice"
                ? "waiting for your choice"
                : terminalStatus === "prompt-sent"
                  ? "prompt injected"
                  : terminalStatus === "auto-finished"
                    ? "answer captured"
                    : "live terminal"}
        </span>
      </div>
      <div className="workflow-run-details__xterm-host" ref={hostRef} />
    </div>
  );
}

const WorkflowAgentTerminal = memo(WorkflowAgentTerminalInner);

function WorkflowMpePanel({ markdown, onClose }: { markdown: string; onClose: () => void }) {
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
        <Suspense fallback={<div className="tab-loading-fallback" />}>
          <MarkdownPreview source={markdown} />
        </Suspense>
      </div>
    </aside>
  );
}

function WorkflowInputDialog({
  title,
  onSubmit,
  onError,
}: {
  title: string;
  onSubmit: (value: string) => Promise<void>;
  onError: (message: string) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [value, setValue] = useState("");
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  return (
    <div
      className="workflow-input-dialog"
      role="dialog"
      aria-modal="true"
      aria-labelledby="workflow-input-dialog-title"
    >
      <form
        className="workflow-input-dialog__panel"
        onSubmit={(event) => {
          event.preventDefault();
          if (submitting) return;
          setSubmitting(true);
          void onSubmit(value).catch((error) => {
            setSubmitting(false);
            onError((error as Error).message);
            inputRef.current?.focus();
          });
        }}
      >
        <label id="workflow-input-dialog-title" htmlFor="workflow-runtime-input">
          {title}
        </label>
        <div className="workflow-input-dialog__control">
          <input
            ref={inputRef}
            id="workflow-runtime-input"
            value={value}
            onChange={(event) => setValue(event.target.value)}
            disabled={submitting}
            autoComplete="off"
            spellCheck={false}
          />
          <button type="submit" disabled={submitting}>
            Submit
          </button>
        </div>
      </form>
    </div>
  );
}

function WorkflowNodeInspector({
  workspaceId,
  node,
  autoFocusName,
  nodes,
  edges,
  running,
  onUpdate,
  onConnectMcp,
  onShowDetails,
  onShowMpe,
  onResolveApproval,
  onOpenDiff,
  onClose,
  onDelete,
  onUpdateEdge,
  onDeleteEdge,
}: {
  workspaceId: string;
  node: WorkflowNode;
  autoFocusName?: boolean;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  running: boolean;
  onUpdate: (patch: Partial<WorkflowNode>) => void;
  onConnectMcp: () => void;
  onShowDetails: () => void;
  onShowMpe: () => void;
  onResolveApproval: (approved: boolean) => Promise<unknown>;
  onOpenDiff: (title: string, entries: MultiDiffEntry[]) => void;
  onClose: () => void;
  onDelete: () => void;
  onUpdateEdge: (edgeId: string, patch: Partial<WorkflowEdge>) => void;
  onDeleteEdge: (edgeId: string) => void;
}) {
  const { t } = useUiPreferences();
  const outgoing = edges.filter((edge) => edge.from === node.id);
  const incoming = edges.filter((edge) => edge.to === node.id);
  const bodyText = blockOutputText(node);
  const kind = nodeKind(node);
  const isTrigger = kind === "trigger";
  const isManualTrigger = kind === "manual-trigger";
  const isCron = kind === "cron";
  const isWebhookTrigger = kind === "webhook-trigger";
  const isAgent = kind === "agent";
  const isInput = kind === "input";
  const isCodexPlugin = kind === "codex-plugin";
  const isClaudePlugin = kind === "claude-plugin";
  const isFileWrite = kind === "file-write";
  const isMcp = kind === "mcp";
  const isMarkdown = kind === "markdown";
  const isHttpRequest = kind === "http-request";
  const isSet = kind === "set";
  const isIf = kind === "if";
  const isDiffApproval = kind === "diff-approval";
  const isGitCommit = kind === "git-commit";
  const isGitCheckout = kind === "git-checkout";
  const isGitDeleteBranch = kind === "git-delete-branch";
  const isGithubPr = kind === "github-pr";
  const isMerge = kind === "merge";
  const isCode = kind === "code";
  const isLoopItems = kind === "loop-items";
  const isWait = kind === "wait";
  const isJson = kind === "json";
  const writeConfig = fileWriteConfig(node);
  const mcpConfig = mcpNodeConfig(node);
  const httpConfig = httpRequestConfig(node);
  const setConfig = setNodeConfig(node);
  const ifConfig = ifNodeConfig(node);
  const mergeConfig = mergeNodeConfig(node);
  const codeConfig = codeNodeConfig(node);
  const loopConfig = loopItemsConfig(node);
  const waitConfig = waitNodeConfig(node);
  const jsonConfig = jsonNodeConfig(node);
  const [pluginSnapshot, setPluginSnapshot] = useState<
    CodexPluginSnapshot | ClaudePluginSnapshot | null
  >(null);
  const [pluginSearch, setPluginSearch] = useState("");
  const showOutput = kind !== "markdown";
  const runDetails = runDetailsSnapshot(node);
  const waitingForChoice =
    isAgent && node.status === "running" && runDetails?.terminalStatus === "waiting-for-choice";
  const waitingAgentLabel = node.providerKind === "claude-cli" ? "Claude Code" : "Codex";
  const updateConfig = (patch: Record<string, unknown>) =>
    onUpdate({ config: { ...(node.config ?? {}), ...patch } });

  useEffect(() => {
    let active = true;
    if (!isCodexPlugin && !isClaudePlugin) {
      setPluginSnapshot(null);
      setPluginSearch("");
      return () => {
        active = false;
      };
    }
    setPluginSnapshot(null);
    setPluginSearch("");
    void (isCodexPlugin ? getCodexPlugins() : getClaudePlugins())
      .then((snapshot) => {
        if (active) setPluginSnapshot(snapshot);
      })
      .catch(() => {
        if (active) setPluginSnapshot(null);
      });
    return () => {
      active = false;
    };
  }, [isCodexPlugin, isClaudePlugin]);

  const selectedPluginSelectors = pluginSelectorsForNode(node);
  const pluginOptions =
    pluginSnapshot?.plugins.filter((plugin) => isCodexPlugin || plugin.status.installed) ?? [];
  const normalizedPluginSearch = pluginSearch.trim().toLowerCase();
  const visiblePluginOptions = normalizedPluginSearch
    ? pluginOptions.filter((plugin) =>
        `${plugin.displayName} ${plugin.selector} ${plugin.description ?? ""}`
          .toLowerCase()
          .includes(normalizedPluginSearch),
      )
    : pluginOptions;

  return (
    <aside className="workflow-inspector">
      <div className="workflow-inspector__head">
        <div>
          <div className="workflow-inspector__eyebrow">
            {blockEyebrow(kind)} #{displayBlockId(node)}
          </div>
          <span className={`workflow-inspector__status is-${node.status}`}>{node.status}</span>
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

      {waitingForChoice && (
        <div className="workflow-inspector__notice">
          <span>{waitingAgentLabel} 正在等待用户选择</span>
          <button type="button" onClick={onShowDetails}>
            see details
          </button>
        </div>
      )}

      {isDiffApproval && node.status === "running" && node.config?.waitingForApproval === true && (
        <div className="workflow-inspector__approval">
          <div className="workflow-inspector__section-title">Diff waiting for approval</div>
          <DiffApprovalView workspaceId={workspaceId} onOpenDiff={onOpenDiff} />
          <div className="workflow-inspector__approval-actions">
            <button type="button" className="is-primary" onClick={() => void onResolveApproval(true)}>
              Approve
            </button>
            <button type="button" className="is-danger" onClick={() => void onResolveApproval(false)}>
              Reject
            </button>
          </div>
        </div>
      )}

      <label className="workflow-inspector__field">
        <span>Name</span>
        <TemplateInput
          value={node.title}
          onChange={(value) => onUpdate({ title: value })}
          disabled={running}
          autoFocus={autoFocusName}
        />
      </label>

      {supportsFailover(kind) && (
        <label className="workflow-inspector__check workflow-inspector__check--danger">
          <input
            type="checkbox"
            checked={nodeFailover(node)}
            onChange={(event) => updateConfig({ failover: event.target.checked })}
            disabled={running}
          />
          <span>Failover</span>
          <small>Warning</small>
        </label>
      )}

      {isAgent && (
        <>
          <label className="workflow-inspector__field">
            <span>Model</span>
            <TemplateInput
              value={node.model ?? ""}
              onChange={(value) => onUpdate({ model: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Effort ({formatAgentOption(agentEffort(node))})</span>
            <EffortMenu
              value={agentEffort(node)}
              options={agentEffortMenuOptions(node)}
              onChange={(value) => updateConfig({ effort: value })}
              disabled={running}
            />
          </label>
          {node.providerKind === "claude-cli" ? (
            <div className="workflow-inspector__field">
              <span>Mode</span>
              <ModeMenu
                value={agentClaudeMode(node)}
                options={CLAUDE_MODE_OPTIONS}
                onChange={(value) => updateConfig({ claudeMode: value })}
                disabled={running}
              />
            </div>
          ) : (
            <>
              <div className="workflow-inspector__field">
                <span>Approval</span>
                <ModeMenu
                  value={agentCodexApproval(node)}
                  options={CODEX_MODE_OPTIONS}
                  onChange={(value) => updateConfig({ codexApproval: value })}
                  disabled={running}
                />
              </div>
              <div className="workflow-inspector__field">
                <span>Sandbox</span>
                <ModeMenu
                  value={agentCodexSandbox(node)}
                  options={CODEX_SANDBOX_OPTIONS}
                  onChange={(value) => updateConfig({ codexSandbox: value })}
                  disabled={running}
                />
              </div>
            </>
          )}
          <label className="workflow-inspector__field">
            <span>Retries</span>
            <BlurNumberInput
              value={agentRetryCount(node)}
              min={0}
              max={5}
              onCommit={(value) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    retries: value,
                  },
                })
              }
              disabled={running || agentRetryForever(node)}
            />
          </label>
          <label className="workflow-inspector__check workflow-inspector__check--danger">
            <input
              type="checkbox"
              checked={agentRetryForever(node)}
              onChange={(e) => updateConfig({ retryForever: e.target.checked })}
              disabled={running}
            />
            <span>Infinite retry</span>
            <small>Warning</small>
          </label>
          <label className="workflow-inspector__check">
            <input
              type="checkbox"
              checked={agentAutoSuccess(node)}
              onChange={(e) =>
                onUpdate({
                  config: {
                    ...(node.config ?? {}),
                    autoSuccess: e.target.checked,
                  },
                })
              }
              disabled={running}
            />
            <span>Auto success</span>
          </label>
          <label className="workflow-inspector__check workflow-inspector__check--danger">
            <input
              type="checkbox"
              checked={agentAlwaysEnter(node)}
              onChange={(e) => updateConfig({ alwaysEnter: e.target.checked })}
              disabled={running}
            />
            <span>Always enter</span>
            <small>Warning</small>
          </label>
        </>
      )}

      {(isCodexPlugin || isClaudePlugin) && (
        <div className="workflow-inspector__section">
          <div className="workflow-inspector__section-title">
            {isCodexPlugin ? "Codex plugins to enable" : "Installed Claude plugins to enable"}
          </div>
          <input
            className="workflow-inspector__plugin-search"
            type="search"
            value={pluginSearch}
            onChange={(event) => setPluginSearch(event.target.value)}
            placeholder="Search plugins"
            aria-label="Search plugins"
            disabled={!pluginSnapshot}
          />
          <div className="workflow-inspector__plugin-list">
            {!pluginSnapshot && <div className="workflow-inspector__muted">Loading plugins...</div>}
            {pluginSnapshot && pluginOptions.length === 0 && (
              <div className="workflow-inspector__muted">
                {isCodexPlugin ? "No Codex plugins found." : "No installed Claude plugins found."}
              </div>
            )}
            {pluginSnapshot && pluginOptions.length > 0 && visiblePluginOptions.length === 0 && (
              <div className="workflow-inspector__muted">No matching plugins.</div>
            )}
            {visiblePluginOptions.map((plugin) => {
              const checked = selectedPluginSelectors.includes(plugin.selector);
              return (
                <label
                  key={plugin.selector}
                  className="workflow-inspector__check"
                  title={plugin.selector}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    onChange={(event) => {
                      const next = new Set(selectedPluginSelectors);
                      if (event.target.checked) next.add(plugin.selector);
                      else next.delete(plugin.selector);
                      updateConfig({ pluginSelectors: [...next] });
                    }}
                    disabled={running}
                  />
                  <span>{plugin.displayName}</span>
                </label>
              );
            })}
          </div>
          <div className="workflow-inspector__section-title">
            {isCodexPlugin
              ? "Selected plugins are enabled; all other discovered Codex plugins are disabled."
              : "Selected installed plugins are enabled; other installed plugins are disabled."}
          </div>
        </div>
      )}

      {isManualTrigger ? (
        <div className="workflow-inspector__section-title">Runs when started manually.</div>
      ) : isCron ? (
        <>
          <label className="workflow-inspector__field">
            <span>Cron Expression</span>
            <TemplateInput
              value={typeof node.config?.cron === "string" ? node.config.cron : "0 9 * * 1-5"}
              onChange={(value) => updateConfig({ cron: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Timezone</span>
            <TemplateInput
              value={typeof node.config?.timezone === "string" ? node.config.timezone : "local"}
              onChange={(value) => updateConfig({ timezone: value })}
              disabled={running}
            />
          </label>
        </>
      ) : isWebhookTrigger ? (
        <>
          <label className="workflow-inspector__field">
            <span>Method</span>
            <SegmentedControl
              value={typeof node.config?.method === "string" ? node.config.method : "POST"}
              options={HTTP_METHODS}
              onChange={(value) => updateConfig({ method: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Path</span>
            <TemplateInput
              value={typeof node.config?.path === "string" ? node.config.path : "/workflow-hook"}
              onChange={(value) => updateConfig({ path: value })}
              disabled={running}
            />
          </label>
        </>
      ) : isFileWrite ? (
        <>
          <label className="workflow-inspector__field">
            <span>Path</span>
            <TemplateInput
              value={writeConfig.path}
              onChange={(value) => updateConfig({ path: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Content</span>
            <TemplateTextarea
              value={writeConfig.content}
              onChange={(value) => updateConfig({ content: value })}
              disabled={running}
            />
          </label>
        </>
      ) : isHttpRequest ? (
        <>
          <label className="workflow-inspector__field">
            <span>Method</span>
            <SegmentedControl
              value={httpConfig.method}
              options={HTTP_METHODS}
              onChange={(value) => updateConfig({ method: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>URL</span>
            <TemplateInput
              value={httpConfig.url}
              onChange={(value) => updateConfig({ url: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Headers JSON</span>
            <TemplateTextarea
              value={httpConfig.headers}
              onChange={(value) => updateConfig({ headers: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Body</span>
            <TemplateTextarea
              value={httpConfig.body}
              onChange={(value) => updateConfig({ body: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Response</span>
            <SegmentedControl
              value={httpConfig.responseType}
              options={HTTP_RESPONSE_TYPES}
              onChange={(value) => updateConfig({ responseType: value })}
              disabled={running}
            />
          </label>
        </>
      ) : isSet ? (
        <label className="workflow-inspector__field">
          <span>Data JSON</span>
          <TemplateTextarea
            value={setConfig.data}
            onChange={(value) => updateConfig({ data: value })}
            disabled={running}
          />
        </label>
      ) : isIf ? (
        <label className="workflow-inspector__field">
          <span>Condition</span>
          <input
            className="workflow-inspector__condition-input"
            value={ifConfig.expression}
            onChange={(event) => updateConfig({ expression: event.target.value })}
            disabled={running}
            spellCheck={false}
          />
        </label>
      ) : isDiffApproval ? (
        <div className="workflow-inspector__section-title">
          Pauses the workflow for review. Approved runs the success output; rejected runs failure.
        </div>
      ) : isGitCommit ? (
        <>
          <label className="workflow-inspector__field">
            <span>Commit message</span>
            <TemplateTextarea
              value={typeof node.config?.message === "string" ? node.config.message : ""}
              onChange={(value) => updateConfig({ message: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__check">
            <input
              type="checkbox"
              checked={node.config?.stageAll === true}
              onChange={(event) => updateConfig({ stageAll: event.target.checked })}
              disabled={running}
            />
            <span>Stage all changes</span>
          </label>
        </>
      ) : isGitCheckout ? (
        <>
          <label className="workflow-inspector__field">
            <span>Branch</span>
            <TemplateInput
              value={typeof node.config?.branch === "string" ? node.config.branch : ""}
              onChange={(value) => updateConfig({ branch: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__check">
            <input
              type="checkbox"
              checked={node.config?.createIfMissing === true}
              onChange={(event) => updateConfig({ createIfMissing: event.target.checked })}
              disabled={running}
            />
            <span>Create branch if it does not exist</span>
          </label>
        </>
      ) : isGitDeleteBranch ? (
        <>
          <label className="workflow-inspector__field">
            <span>Branch</span>
            <TemplateInput
              value={typeof node.config?.branch === "string" ? node.config.branch : ""}
              onChange={(value) => updateConfig({ branch: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__check workflow-inspector__check--danger">
            <input
              type="checkbox"
              checked={node.config?.force === true}
              onChange={(event) => updateConfig({ force: event.target.checked })}
              disabled={running}
            />
            <span>Force delete</span>
            <small>Warning</small>
          </label>
          <label className="workflow-inspector__check">
            <input
              type="checkbox"
              checked={node.config?.remote === true}
              onChange={(event) => updateConfig({ remote: event.target.checked })}
              disabled={running}
            />
            <span>Delete remote branch</span>
          </label>
          {node.config?.remote === true && (
            <label className="workflow-inspector__field">
              <span>Remote</span>
              <TemplateInput
                value={typeof node.config?.remoteName === "string" ? node.config.remoteName : "origin"}
                onChange={(value) => updateConfig({ remoteName: value })}
                disabled={running}
              />
            </label>
          )}
        </>
      ) : isGithubPr ? (
        <>
          <label className="workflow-inspector__field">
            <span>Title</span>
            <TemplateInput
              value={typeof node.config?.title === "string" ? node.config.title : ""}
              onChange={(value) => updateConfig({ title: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Body</span>
            <TemplateTextarea
              value={typeof node.config?.body === "string" ? node.config.body : ""}
              onChange={(value) => updateConfig({ body: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Base branch (optional)</span>
            <TemplateInput
              value={typeof node.config?.base === "string" ? node.config.base : ""}
              onChange={(value) => updateConfig({ base: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Compare branch (optional)</span>
            <TemplateInput
              value={typeof node.config?.compare === "string" ? node.config.compare : ""}
              onChange={(value) => updateConfig({ compare: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__check">
            <input
              type="checkbox"
              checked={node.config?.push !== false}
              onChange={(event) => updateConfig({ push: event.target.checked })}
              disabled={running}
            />
            <span>Push branch before creating PR</span>
          </label>
          <label className="workflow-inspector__check">
            <input
              type="checkbox"
              checked={node.config?.draft === true}
              onChange={(event) => updateConfig({ draft: event.target.checked })}
              disabled={running}
            />
            <span>Create as draft</span>
          </label>
        </>
      ) : isMerge ? (
        <label className="workflow-inspector__field">
          <span>Mode</span>
          <SegmentedControl
            value={mergeConfig.mode}
            options={MERGE_MODES}
            onChange={(value) => updateConfig({ mode: value })}
            disabled={running}
          />
        </label>
      ) : isCode ? (
        <label className="workflow-inspector__field">
          <span>JavaScript</span>
          <TemplateTextarea
            value={codeConfig.code}
            onChange={(value) => updateConfig({ code: value })}
            disabled={running}
          />
        </label>
      ) : isLoopItems ? (
        <>
          <label className="workflow-inspector__field">
            <span>Items Source</span>
            <TemplateTextarea
              value={loopConfig.source}
              onChange={(value) => updateConfig({ source: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Mode</span>
            <SegmentedControl
              value={loopConfig.mode}
              options={LOOP_MODES}
              onChange={(value) => updateConfig({ mode: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Batch Size</span>
            <BlurNumberInput
              value={loopConfig.batchSize}
              min={1}
              step={1}
              onCommit={(value) => updateConfig({ batchSize: value })}
              disabled={running}
            />
          </label>
        </>
      ) : isWait ? (
        <label className="workflow-inspector__field">
          <span>Seconds</span>
          <BlurNumberInput
            value={waitConfig.seconds}
            min={0}
            step={0.1}
            onCommit={(value) => updateConfig({ seconds: value })}
            disabled={running}
          />
        </label>
      ) : isJson ? (
        <>
          <label className="workflow-inspector__field">
            <span>Source JSON</span>
            <TemplateTextarea
              value={jsonConfig.source}
              onChange={(value) => updateConfig({ source: value })}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Path</span>
            <TemplateInput
              value={jsonConfig.path}
              onChange={(value) => updateConfig({ path: value })}
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
                updateConfig({
                  remoteLink: value,
                  connectionStatus: "",
                  connectionError: "",
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
                updateConfig({
                  headers: value,
                  connectionStatus: "",
                  connectionError: "",
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
                updateConfig({
                  apiKey: value,
                  connectionStatus: "",
                  connectionError: "",
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
            <span
              className={`workflow-inspector__mcp-state is-${mcpConfig.connectionStatus || "idle"}`}
            >
              {mcpConnectionLabel(mcpConfig)}
            </span>
          </div>
          {mcpConfig.connectionError && (
            <div className="workflow-inspector__mcp-error">{mcpConfig.connectionError}</div>
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
                      updateConfig({
                        toolName: tool.name,
                        arguments: shouldReplaceMcpArguments(mcpConfig.arguments)
                          ? argumentsTemplateFromTool(tool)
                          : mcpConfig.arguments,
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
                updateConfig({
                  toolName: value,
                  arguments:
                    nextTool && shouldReplaceMcpArguments(mcpConfig.arguments)
                      ? argumentsTemplateFromTool(nextTool)
                      : mcpConfig.arguments,
                });
              }}
              disabled={running}
            />
          </label>
          <label className="workflow-inspector__field">
            <span>Arguments JSON</span>
            <TemplateTextarea
              value={mcpConfig.arguments}
              onChange={(value) => updateConfig({ arguments: value })}
              disabled={running}
            />
          </label>
        </>
      ) : isInput ? (
        <label className="workflow-inspector__field">
          <span>Input title</span>
          <input
            value={workflowInputTitle(node)}
            onChange={(event) => updateConfig({ inputTitle: event.target.value })}
            disabled={running}
            spellCheck={false}
          />
        </label>
      ) : (
        !isTrigger &&
        !isCodexPlugin &&
        !isClaudePlugin && (
          <label className="workflow-inspector__field">
            <span>{inputLabelForKind(kind)}</span>
            <TemplateTextarea
              value={node.prompt}
              onChange={(value) => onUpdate({ prompt: value })}
              disabled={running}
            />
          </label>
        )
      )}

      {isMarkdown && (
        <div className="workflow-inspector__mpe-link-row">
          <label className="workflow-inspector__check">
            <input
              type="checkbox"
              checked={markdownAutoSeeResult(node)}
              onChange={(event) => updateConfig({ autoSeeResult: event.target.checked })}
              disabled={running}
            />
            <span>{t("workflow.markdown.autoSeeResult")}</span>
          </label>
          <button type="button" onClick={onShowMpe}>
            {t("workflow.markdown.seeResult")}
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
                    onClick={() => onUpdateEdge(edge.id, { passSummary: !edge.passSummary })}
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
          <pre className="workflow-inspector__output">{bodyText}</pre>
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
  autoFocus?: boolean;
}

function TemplateInput({ value, onChange, disabled, autoFocus }: TemplateControlProps) {
  const mirrorRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (autoFocus && inputRef.current) {
      inputRef.current.focus();
      inputRef.current.select();
    }
  }, [autoFocus]);

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
        ref={inputRef}
        className="workflow-template-editor__control"
        value={value}
        onChange={(e) => onChange(e.target.value)}
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
        onChange={(e) => onChange(e.target.value)}
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

function SegmentedControl<T extends string>({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: readonly T[];
  onChange: (value: T) => void;
  disabled?: boolean;
}) {
  return (
    <div className="workflow-inspector__segmented workflow-inspector__segmented--wrap">
      {options.map((option) => (
        <button
          key={option}
          type="button"
          className={value === option ? "is-active" : ""}
          onClick={() => onChange(option)}
          disabled={disabled}
        >
          {option}
        </button>
      ))}
    </div>
  );
}

function EffortMenu({
  value,
  options,
  onChange,
  disabled,
}: {
  value: AiTerminalEffort;
  options: readonly AgentEffortOption[];
  onChange: (value: AiTerminalEffort) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="workflow-mode-menu workflow-effort-menu" ref={rootRef}>
      <button
        type="button"
        className={`workflow-mode-menu__trigger${open ? " is-open" : ""}`}
        onClick={() => !disabled && setOpen((v) => !v)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="workflow-mode-menu__trigger-label">{current?.title ?? "Effort"}</span>
        <span className="workflow-mode-menu__chevron" aria-hidden>
          v
        </span>
      </button>
      {open && (
        <div className="workflow-mode-menu__list" role="listbox">
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={`workflow-mode-menu__item${active ? " is-active" : ""}`}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="workflow-mode-menu__item-text">
                  <span className="workflow-mode-menu__item-title">{option.title}</span>
                  {option.description ? (
                    <span className="workflow-mode-menu__item-desc">{option.description}</span>
                  ) : null}
                </span>
                <span className="workflow-effort-menu__trailing">
                  {option.badge ? (
                    <small className="workflow-effort-menu__badge">{option.badge}</small>
                  ) : null}
                  <span className="workflow-effort-menu__check" aria-hidden />
                </span>
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModeMenu({
  value,
  options,
  onChange,
  disabled,
}: {
  value: string;
  options: AgentModeOption[];
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const current = options.find((option) => option.value === value) ?? options[0];

  useEffect(() => {
    if (!open) return;
    const onDocPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    window.addEventListener("pointerdown", onDocPointerDown, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("pointerdown", onDocPointerDown, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="workflow-mode-menu" ref={rootRef}>
      <button
        type="button"
        className={`workflow-mode-menu__trigger${open ? " is-open" : ""}`}
        onClick={() => setOpen((prev) => !prev)}
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="workflow-mode-menu__trigger-icon">
          <ModeIcon name={current?.icon ?? "edit"} />
        </span>
        <span className="workflow-mode-menu__trigger-label">{current?.title ?? "Mode"}</span>
        <span className="workflow-mode-menu__chevron" aria-hidden>
          <svg
            viewBox="0 0 24 24"
            width="14"
            height="14"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m6 9 6 6 6-6" />
          </svg>
        </span>
      </button>
      {open && (
        <div className="workflow-mode-menu__list" role="listbox">
          {options.map((option) => {
            const active = option.value === value;
            return (
              <button
                key={option.value}
                type="button"
                role="option"
                aria-selected={active}
                className={
                  "workflow-mode-menu__item" +
                  (active ? " is-active" : "") +
                  (option.danger ? " is-danger" : "")
                }
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                }}
              >
                <span className="workflow-mode-menu__item-icon">
                  <ModeIcon name={option.icon} />
                </span>
                <span className="workflow-mode-menu__item-text">
                  <span className="workflow-mode-menu__item-title">{option.title}</span>
                  <span className="workflow-mode-menu__item-desc">{option.description}</span>
                </span>
                <span className="workflow-mode-menu__check" aria-hidden />
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}

function ModeIcon({ name }: { name: AgentModeIcon }) {
  const common = {
    viewBox: "0 0 24 24",
    width: 17,
    height: 17,
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.6,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "manual":
      return (
        <svg {...common}>
          <path d="M8 11V5.5a1.5 1.5 0 0 1 3 0V11" />
          <path d="M11 10.5V4.5a1.5 1.5 0 0 1 3 0V11" />
          <path d="M14 11V6a1.5 1.5 0 0 1 3 0v7.5a6 6 0 0 1-6 6h-1.2a4 4 0 0 1-2.9-1.25L4.5 15" />
          <path d="M8 11V9a1.5 1.5 0 0 0-3 0v3" />
        </svg>
      );
    case "plan":
      return (
        <svg {...common}>
          <rect x="5" y="3.5" width="14" height="17" rx="2" />
          <path d="M8.5 8h7M8.5 12h7M8.5 16h4" />
        </svg>
      );
    case "auto":
      return (
        <svg {...common}>
          <path d="M13 2.5 4.5 13.5H11l-1 8L19.5 10H13z" />
        </svg>
      );
    default:
      return (
        <svg {...common}>
          <path d="m8 7-4 5 4 5M16 7l4 5-4 5" />
        </svg>
      );
  }
}

function formatAgentOption(value: string): string {
  if (value === "xhigh") return "XHigh";
  if (value === "ultracode") return "Ultracode";
  return value ? value[0]!.toUpperCase() + value.slice(1) : value;
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
        {match[0]}
      </span>,
    );
    index = match.index + match[0].length;
  }
  if (index < value.length) parts.push(value.slice(index));
  if (value.endsWith("\n")) parts.push("\u00a0");
  return parts;
}

function patchNode(
  record: WorkflowRecord,
  nodeId: string,
  patch: Partial<WorkflowNode>,
): WorkflowRecord {
  return {
    ...record,
    nodes: record.nodes.map((node) => (node.id === nodeId ? { ...node, ...patch } : node)),
  };
}

function finishRun(
  record: WorkflowRecord,
  runId: string,
  status: WorkflowRunStatus,
  error?: string,
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
        : run,
    ),
  };
}

const LAYOUT_MARGIN_X = 80;
const LAYOUT_MARGIN_Y = 80;
const LAYOUT_GAP_X = 96;
const LAYOUT_GAP_Y = 34;

/**
 * Layered left-to-right auto layout. Columns follow the longest-path depth from
 * trigger / indegree-0 nodes; nodes in a column stack vertically in declared
 * order. Falls back to the existing order when the graph has a cycle so we never
 * throw or lose nodes.
 */
function autoLayout(record: WorkflowRecord): WorkflowRecord {
  const nodes = record.nodes;
  if (nodes.length === 0) return record;
  const ids = new Set(nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  const indegree = new Map<string, number>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of record.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to) || edge.from === edge.to) continue;
    incoming.get(edge.to)?.push(edge.from);
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
  }

  const order = topoOrder(record);
  const depth = new Map<string, number>();
  if (order.error) {
    // cycle: keep declared order, single column fallback
    nodes.forEach((node, index) => {
      depth.set(node.id, index === 0 ? 0 : 1);
    });
  } else {
    for (const id of order.nodeIds) {
      const preds = incoming.get(id) ?? [];
      const d = preds.length ? Math.max(...preds.map((p) => (depth.get(p) ?? 0) + 1)) : 0;
      depth.set(id, d);
    }
  }

  const columns = new Map<number, string[]>();
  for (const node of nodes) {
    const d = depth.get(node.id) ?? 0;
    if (!columns.has(d)) columns.set(d, []);
    columns.get(d)!.push(node.id);
  }

  const position = new Map<string, { x: number; y: number }>();
  for (const [d, columnIds] of columns) {
    columnIds.forEach((id, row) => {
      position.set(id, {
        x: LAYOUT_MARGIN_X + d * (NODE_W + LAYOUT_GAP_X),
        y: LAYOUT_MARGIN_Y + row * (NODE_H + LAYOUT_GAP_Y),
      });
    });
  }

  let changed = false;
  const nextNodes = nodes.map((node) => {
    const pos = position.get(node.id);
    if (!pos || (pos.x === node.x && pos.y === node.y)) return node;
    changed = true;
    return { ...node, x: pos.x, y: pos.y };
  });
  if (!changed) return record;
  return { ...record, nodes: nextNodes };
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
  options: { allowMcpToolCall?: boolean } = {},
): Promise<LocalNodeResult> {
  const input = resolveBlockTemplate(node.prompt, record).trim();
  const kind = nodeKind(node);
  if (kind === "input") {
    const value = resolveBlockTemplate(node.prompt, record);
    return {
      output: {
        type: "input",
        status: "success",
        value,
        data: value,
        text: value,
      },
    };
  }
  if (!input && !CONFIGURED_LOCAL_KINDS.has(kind)) {
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
      },
      error: failed ? `Failed to fetch ${input}.` : undefined,
    };
  }

  if (kind === "http-request") {
    const config = httpRequestConfig(node);
    const method = resolveBlockTemplate(config.method, record).trim().toUpperCase() || "GET";
    const url = resolveBlockTemplate(config.url, record).trim();
    const body = resolveBlockTemplate(config.body, record);
    const responseType = HTTP_RESPONSE_TYPES.includes(
      config.responseType as (typeof HTTP_RESPONSE_TYPES)[number],
    )
      ? config.responseType
      : "auto";
    if (!url) throw new Error(`${node.title} has no URL.`);
    const headersParsed = parseTemplatedJsonValue(config.headers, record);
    if (!headersParsed.ok) {
      throw new Error(`${node.title} headers JSON is invalid: ${headersParsed.error}`);
    }
    const headersObject = objectValue(headersParsed.value);
    if (!headersObject) throw new Error(`${node.title} headers must be a JSON object.`);

    const result = await execRun(workspaceId, {
      command: buildHttpRequestCommand({
        method,
        url,
        headers: stringRecord(headersObject),
        body,
        responseType,
      }),
      shell: "cmd",
      timeoutMs: 120_000,
    });
    const parsed = parseJsonObject(result.stdout);
    if (result.exitCode !== 0 || !parsed) {
      return {
        output: {
          type: "http-request",
          status: "failed",
          method,
          url,
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          truncated: result.truncated,
          text: result.stderr || result.stdout,
        },
        error: `${node.title} request failed.`,
      };
    }
    const ok = parsed.ok === true;
    return {
      output: {
        ...parsed,
        type: "http-request",
        status: ok ? "success" : "http-error",
        method,
        requestedUrl: url,
        text:
          typeof parsed.text === "string"
            ? parsed.text
            : parsed.body !== undefined
              ? stringifyTemplateValue(parsed.body)
              : result.stdout,
      },
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
      },
      changedFiles: true,
    };
  }

  if (kind === "set") {
    const config = setNodeConfig(node);
    const parsed = parseTemplatedJsonValue(config.data, record);
    if (!parsed.ok) throw new Error(`${node.title} data JSON is invalid: ${parsed.error}`);
    const obj = objectValue(parsed.value);
    return {
      output: {
        ...(obj ?? {}),
        type: "set",
        status: "success",
        data: parsed.value,
        text: textFromAny(parsed.value),
      },
    };
  }

  if (kind === "if") {
    const config = ifNodeConfig(node);
    const result = evaluateConditionExpression(config.expression, (template) =>
      resolveTemplateValue(template, record),
    );
    return {
      output: {
        type: "if",
        status: "success",
        result,
        expression: config.expression,
        text: result ? "true" : "false",
      },
    };
  }

  if (kind === "merge") {
    const config = mergeNodeConfig(node);
    const items = incomingOutputs(record, node);
    const mode = config.mode === "array" ? "array" : "object";
    const data =
      mode === "array"
        ? items.map((item) => item.data ?? item)
        : Object.assign({}, ...items.map((item) => objectValue(item.data) ?? item));
    return {
      output: {
        type: "merge",
        status: "success",
        mode,
        data,
        items,
        text: jsonPreview(data),
      },
    };
  }

  if (kind === "code") {
    const config = codeNodeConfig(node);
    const items = incomingOutputs(record, node);
    const inputValue = items[0] ?? {};
    const value = await runCodeBlock(config.code, inputValue, items);
    return {
      output: outputFromValue("code", value),
    };
  }

  if (kind === "loop-items") {
    const config = loopItemsConfig(node);
    const source = config.source.trim()
      ? resolveTemplateValue(config.source, record)
      : (incomingOutputs(record, node)[0]?.data ?? incomingOutputs(record, node)[0] ?? []);
    const items = Array.isArray(source) ? source : [source].filter((item) => item !== undefined);
    const batches = chunk(items, Math.max(1, config.batchSize));
    const data = config.mode === "batches" ? batches : items;
    return {
      output: {
        type: "loop-items",
        status: "success",
        mode: config.mode,
        batchSize: config.batchSize,
        items,
        batches,
        data,
        count: items.length,
        text: jsonPreview(data),
      },
    };
  }

  if (kind === "wait") {
    const config = waitNodeConfig(node);
    const seconds = Math.max(0, config.seconds);
    const startedAt = Date.now();
    await waitMs(seconds * 1000);
    const durationMs = Date.now() - startedAt;
    return {
      output: {
        type: "wait",
        status: "success",
        seconds,
        durationMs,
        text: `Waited ${(durationMs / 1000).toFixed(1)}s.`,
      },
    };
  }

  if (kind === "json") {
    const config = jsonNodeConfig(node);
    const incoming = incomingOutputs(record, node);
    const source = config.source.trim()
      ? resolveTemplateValue(config.source, record)
      : (incoming[0] ?? "");
    const parsedSource = parseMaybeJson(source);
    const value = config.path.trim() ? getLoosePathValue(parsedSource, config.path) : parsedSource;
    return {
      output: {
        type: "json",
        status: "success",
        path: config.path,
        source: parsedSource,
        value,
        data: value,
        text: textFromAny(value),
      },
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
  setAbortController: (controller: AbortController | null) => void,
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
        runDetails: commandRunSnapshot(node, status, startedAt, undefined, commandLine, logs),
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
      },
    );
  } finally {
    setAbortController(null);
  }

  if (streamed.aborted || !streamed.result) {
    logs.push({ stream: "stderr", content: "\n[osheep] stopped\n" });
    const snapshot = commandRunSnapshot(node, "stopped", startedAt, Date.now(), commandLine, logs);
    return {
      output: {
        type: "command",
        status: "stopped",
        command: commandLine,
        stdout: snapshot.stdout,
        stderr: snapshot.stderr,
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
    result,
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
  mcpTools: McpRuntimeTool[] = [],
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
        'Each tool call must be: {"name":"tool_name","arguments":{...}}.',
        "Available tools in OpenAI-compatible function shape:",
        JSON.stringify(mcpToolSpecs, null, 2),
        "After osheep executes the tool calls, it will run you again with the results. Do not invent tool results.",
      ]
    : [];

  return [
    `You are executing osheep workflow block "${node.title}".`,
    "Return exactly one JSON object and no markdown fences.",
    "The JSON object must include: text, status, NEXT.",
    "Put the user-facing answer in text.",
    "If the prompt asks for project work, use your native CLI capabilities to inspect, edit, and verify files in the current project root.",
    "If the prompt is conversational, answer naturally inside text.",
    ...mcpInstructions,
    "",
    "Incoming summaries:",
    incoming.length ? incoming.join("\n\n") : "None.",
    "",
    "Block prompt:",
    resolveBlockTemplate(node.prompt, record),
  ].join("\n");
}

function buildTerminalPrompt(record: WorkflowRecord, node: WorkflowNode): string {
  return resolveBlockTemplate(node.prompt, record).trim();
}

async function maybeRunAgentMcpToolCalls(
  workspaceId: string,
  record: WorkflowRecord,
  node: WorkflowNode,
  mcpTools: McpRuntimeTool[],
  raw: string,
  signal: AbortSignal,
  onLog?: (entry: { stream: "stdout" | "stderr"; content: string }) => void,
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
    const resolvedRemoteLink = resolveBlockTemplate(runtimeTool.config.remoteLink, record).trim();
    const headers = parseJsonObject(resolveBlockTemplate(runtimeTool.config.headers, record)) ?? {};
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
    onLog,
  );
  return {
    raw: response.content || acc || raw,
  };
}

async function runAiTerminalWithRetries(
  workspaceId: string,
  input: {
    model: string;
    messages: Array<{ role: "user"; content: string }>;
    kind?: "claude-cli" | "codex-cli";
    terminalPrompt?: string;
    autoSuccess?: boolean;
    claudePermissionMode?: AiTerminalClaudePermissionMode;
    mode?: AiTerminalMode;
    codexApproval?: AiTerminalCodexApproval;
    codexSandbox?: AiTerminalCodexSandbox;
    effort?: AiTerminalEffort;
    alwaysEnter?: boolean;
    conversationSessionId?: string;
    resumeConversation?: boolean;
  },
  onFrame: (frame: AiTerminalFrame) => void,
  signal: AbortSignal,
  retries: number,
  retryForever: boolean,
  onLog: (entry: { stream: "stdout" | "stderr"; content: string }) => void,
): Promise<{ result: AiTerminalResult | null; aborted: boolean }> {
  let lastError: unknown = null;
  const attempts = Math.max(1, retries + 1);
  let conversationSessionId =
    input.conversationSessionId || (input.kind === "claude-cli" ? crypto.randomUUID() : undefined);
  const handleFrame = (frame: AiTerminalFrame) => {
    if (frame.type === "conversation" && frame.sessionId) {
      conversationSessionId = frame.sessionId;
    }
    onFrame(frame);
  };
  let attempt = 1;
  while (true) {
    try {
      if (attempt > 1) {
        onLog({
          stream: "stderr",
          content: `\n[osheep] retry ${attempt - 1}/${retryForever ? "infinity" : retries}\n`,
        });
      }
      return await aiChatTerminalStream(
        workspaceId,
        {
          ...(attempt > 1 ? continueOnlyTerminalInput(input) : input),
          conversationSessionId,
          resumeConversation: attempt > 1,
        },
        handleFrame,
        signal,
      );
    } catch (e) {
      lastError = e;
      if (signal.aborted || (!retryForever && attempt >= attempts)) throw e;
      onLog({
        stream: "stderr",
        content: `\n[osheep] attempt ${attempt} failed: ${(e as Error).message}\n`,
      });
      attempt += 1;
      await waitMs(1_000);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

async function loadAgentSessionIds(
  workspaceId: string,
  app: AgentSessionApp,
): Promise<Set<string>> {
  const sessions = await listAgentSessions(app, workspaceId).catch(() => []);
  return new Set(sessions.map((session) => session.id));
}

async function discoverAgentSessionId(input: {
  workspaceId: string;
  app: AgentSessionApp;
  existingIds: Set<string>;
  startedAt: number;
  expectedId?: string;
}): Promise<string> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    const sessions = await listAgentSessions(input.app, input.workspaceId).catch(() => []);
    if (input.expectedId && sessions.some((session) => session.id === input.expectedId)) {
      return input.expectedId;
    }
    const created = sessions
      .filter(
        (session) =>
          !input.existingIds.has(session.id) && session.updatedAt >= input.startedAt - 2_000,
      )
      .sort((a, b) => b.updatedAt - a.updatedAt);
    if (created[0]) return created[0].id;
    if (attempt < 5) await waitMs(100);
  }
  return "";
}

function continueOnlyTerminalInput<
  T extends {
    messages: Array<{ role: "user"; content: string }>;
    terminalPrompt?: string;
  },
>(input: T): T {
  return {
    ...input,
    messages: [{ role: "user", content: "继续" }],
    terminalPrompt: "继续",
  };
}

function agentRetryCount(node: WorkflowNode): number {
  const value = node.config?.retries;
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  return clamp(value, 0, 5);
}

function nodeFailover(node: WorkflowNode): boolean {
  return supportsFailover(nodeKind(node)) && node.config?.failover === true;
}

function supportsFailover(kind: WorkflowNodeKind): boolean {
  return (
    kind === "agent" ||
    kind === "command" ||
    kind === "code" ||
    kind === "web" ||
    kind === "http-request" ||
    kind === "file-read" ||
    kind === "file-write" ||
    kind === "mcp" ||
    kind === "codex-plugin" ||
    kind === "claude-plugin"
  );
}

function agentRetryForever(node: WorkflowNode): boolean {
  return node.config?.retryForever === true;
}

function agentAlwaysEnter(node: WorkflowNode): boolean {
  return node.config?.alwaysEnter === true;
}

/** Claude's unified mode choice: manual | acceptEdits | plan | auto. */
function agentClaudeMode(node: WorkflowNode): string {
  const value = node.config?.claudeMode;
  if (
    value === "manual" ||
    value === "acceptEdits" ||
    value === "plan" ||
    value === "auto" ||
    value === "dontAsk" ||
    value === "bypassPermissions"
  ) {
    return value;
  }
  // Migrate legacy configs that split mode + claudePermissionMode.
  if (node.config?.mode === "plan") return "plan";
  if (node.config?.claudePermissionMode === "bypassPermissions") return "auto";
  return "acceptEdits";
}

function agentMode(node: WorkflowNode): AiTerminalMode {
  if (node.providerKind === "claude-cli" && agentClaudeMode(node) === "plan") return "plan";
  return "default";
}

function agentEffort(node: WorkflowNode): AiTerminalEffort {
  const value = node.config?.effort;
  if (node.providerKind === "claude-cli") {
    if (
      value === "low" ||
      value === "medium" ||
      value === "high" ||
      value === "xhigh" ||
      value === "max" ||
      value === "ultracode"
    ) {
      return value;
    }
    if (value === "off" || value === "minimal") return "low";
  } else {
    if (
      value === "low" ||
      value === "medium" ||
      value === "high" ||
      value === "xhigh" ||
      value === "max"
    ) {
      return value;
    }
    if (value === "off" || value === "minimal" || value === "ultracode") {
      return "high";
    }
  }
  return node.providerKind === "claude-cli" ? "high" : "medium";
}

function agentEffortMenuOptions(node: WorkflowNode): readonly AgentEffortOption[] {
  return node.providerKind === "claude-cli" ? CLAUDE_EFFORT_OPTIONS : CODEX_EFFORT_OPTIONS;
}

function canManuallyMarkAgentSuccess(status: string | undefined): boolean {
  return status === "ready-for-success";
}

function agentAutoSuccess(node: WorkflowNode): boolean {
  return node.config?.autoSuccess !== false;
}

function agentClaudePermissionMode(node: WorkflowNode): AiTerminalClaudePermissionMode {
  switch (agentClaudeMode(node)) {
    case "manual":
      return "default";
    case "auto":
      return "auto";
    case "dontAsk":
      return "dontAsk";
    case "bypassPermissions":
      return "bypassPermissions";
    default:
      // "acceptEdits" and "plan" both submit acceptEdits; plan is carried by mode.
      return "acceptEdits";
  }
}

function agentCodexApproval(node: WorkflowNode): AiTerminalCodexApproval {
  const value = node.config?.codexApproval;
  if (value === "untrusted" || value === "on-request" || value === "never") {
    return value;
  }
  if (value === "auto" || value === "on-failure") return "on-request";
  if (value === "full-access") return "never";
  return "on-request";
}

function agentCodexSandbox(node: WorkflowNode): AiTerminalCodexSandbox {
  const value = node.config?.codexSandbox;
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  if (node.config?.codexApproval === "full-access") return "danger-full-access";
  return "workspace-write";
}

function agentRunSnapshot(
  node: WorkflowNode,
  status: WorkflowRunDetailSnapshot["status"],
  startedAt: number,
  completedAt: number | undefined,
  logs: Array<{ stream: "stdout" | "stderr"; content: string }>,
  terminalSessionId?: string,
  conversationSessionId?: string,
  terminalStatus?: string,
  autoSuccess?: boolean,
  paused?: boolean,
): WorkflowRunDetailSnapshot {
  const snapshot: WorkflowRunDetailSnapshot = {
    kind: "agent",
    title: node.title,
    status,
    startedAt,
    commandLine: agentTerminalCommandLine(node),
    stdout: logs
      .filter((log) => log.stream === "stdout")
      .map((log) => log.content)
      .join(""),
    stderr: logs
      .filter((log) => log.stream === "stderr")
      .map((log) => log.content)
      .join(""),
    transcript: formatTerminalTranscript(logs),
  };
  if (completedAt !== undefined) snapshot.completedAt = completedAt;
  if (terminalSessionId) snapshot.terminalSessionId = terminalSessionId;
  if (conversationSessionId) snapshot.conversationSessionId = conversationSessionId;
  if (terminalStatus) snapshot.terminalStatus = terminalStatus;
  if (autoSuccess !== undefined) snapshot.autoSuccess = autoSuccess;
  if (paused !== undefined) snapshot.paused = paused;
  return snapshot;
}

function agentTerminalCommandLine(node: WorkflowNode): string {
  const base = node.providerKind === "codex-cli" ? "codex" : "claude";
  const parts = [base];
  const mode = agentMode(node);
  const effort = agentEffortCliValue(node.providerKind, agentEffort(node));
  if (node.providerKind === "claude-cli") {
    parts.push("--permission-mode", mode === "plan" ? "plan" : agentClaudePermissionMode(node));
    if (effort) parts.push("--effort", effort);
  } else {
    parts.push("--ask-for-approval", agentCodexApproval(node));
    parts.push("--sandbox", agentCodexSandbox(node));
    if (mode === "goal") parts.push("--enable", "goals");
    if (effort) parts.push("-c", `model_reasoning_effort="${effort}"`);
  }
  if (node.model && node.model !== "default") parts.push("--model", node.model);
  return parts.join(" ");
}

function agentEffortCliValue(
  providerKind: WorkflowProviderKind,
  effort: AiTerminalEffort,
): string | null {
  if (providerKind === "claude-cli") {
    if (
      effort === "low" ||
      effort === "medium" ||
      effort === "high" ||
      effort === "xhigh" ||
      effort === "max" ||
      effort === "ultracode"
    ) {
      return effort;
    }
    return effort === "minimal" ? "low" : null;
  }
  if (
    effort === "low" ||
    effort === "medium" ||
    effort === "high" ||
    effort === "xhigh" ||
    effort === "max"
  ) {
    return effort;
  }
  return effort === "off" || effort === "minimal" ? null : "high";
}

function commandRunSnapshot(
  node: WorkflowNode,
  status: WorkflowRunDetailSnapshot["status"],
  startedAt: number,
  completedAt: number | undefined,
  commandLine: string,
  logs: Array<{ stream: "stdout" | "stderr"; content: string }>,
  result?: RunResult,
): WorkflowRunDetailSnapshot {
  const snapshot: WorkflowRunDetailSnapshot = {
    kind: "command",
    title: node.title,
    status,
    startedAt,
    commandLine,
    stdout:
      result?.stdout ??
      logs
        .filter((log) => log.stream === "stdout")
        .map((log) => log.content)
        .join(""),
    stderr:
      result?.stderr ??
      logs
        .filter((log) => log.stream === "stderr")
        .map((log) => log.content)
        .join(""),
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
  message: string,
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
  logs: Array<{ stream: "stdout" | "stderr"; content: string }>,
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
  toolResults: WorkflowBlockOutput[],
): string {
  return [
    `You are continuing osheep workflow block "${node.title}".`,
    "You asked to call Remote MCP tools. The tool results are below.",
    "Now return exactly one final JSON object and no markdown fences.",
    "The JSON object must include: text, status, NEXT.",
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

function collectMcpToolsForAgent(record: WorkflowRecord, node: WorkflowNode): McpRuntimeTool[] {
  const visited = new Set<string>();
  const queue = record.edges.filter((edge) => edge.to === node.id).map((edge) => edge.from);
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
    const obj =
      item && typeof item === "object" && !Array.isArray(item)
        ? (item as Record<string, unknown>)
        : null;
    if (!obj) continue;
    const nested =
      obj.function && typeof obj.function === "object"
        ? (obj.function as Record<string, unknown>)
        : null;
    const name =
      typeof obj.name === "string" ? obj.name : typeof nested?.name === "string" ? nested.name : "";
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
  const kind = nodeKind(node);
  const config = node.config ?? {};
  return {
    type: kind,
    status: "success",
    id: displayBlockId(node),
    schedule: typeof config.cron === "string" ? config.cron : undefined,
    webhookPath: typeof config.path === "string" ? config.path : undefined,
    text:
      kind === "cron"
        ? "Cron trigger evaluated for manual run."
        : kind === "webhook-trigger"
          ? "Webhook trigger evaluated for manual run."
          : "Workflow run trigger fired.",
  };
}

function agentOutput(node: WorkflowNode, raw: string): WorkflowBlockOutput {
  const parsed = parseJsonObject(raw);
  if (parsed) {
    return normalizeOutputObject(parsed, {
      type: node.providerKind === "claude-cli" ? "claude" : "codex",
      status: "success",
      text: textFromOutput(parsed) || raw.trim(),
    });
  }

  return {
    type: node.providerKind === "claude-cli" ? "claude" : "codex",
    status: "success",
    text: raw.trim(),
  };
}

function normalizeOutputObject(
  value: WorkflowBlockOutput,
  defaults: WorkflowBlockOutput,
): WorkflowBlockOutput {
  return {
    ...sanitizeBlockOutput(defaults),
    ...sanitizeBlockOutput(value),
  };
}

function sanitizeBlockOutput(output: WorkflowBlockOutput): WorkflowBlockOutput {
  const sanitized = { ...output };
  delete sanitized.CHANGED_FILES;
  delete sanitized.VERIFICATION;
  return sanitized;
}

function stringifyBlockOutput(output: WorkflowBlockOutput): string {
  return JSON.stringify(sanitizeBlockOutput(output), null, 2);
}

function parseBlockOutput(node: WorkflowNode): WorkflowBlockOutput | null {
  const output = parseJsonObject(node.rawOutput || node.summary || "");
  return output ? sanitizeBlockOutput(output) : null;
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

function parseJsonValue(text: string): unknown {
  const trimmed = text.trim();
  if (!trimmed) return undefined;
  return JSON.parse(trimmed) as unknown;
}

function parseTemplatedJsonValue(
  input: string,
  record: WorkflowRecord,
): { ok: true; value: unknown } | { ok: false; error: string } {
  const resolved = resolveJsonTemplate(input, record).trim();
  if (!resolved) return { ok: true, value: {} };
  try {
    return { ok: true, value: parseJsonValue(resolved) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

function parseMaybeJson(value: unknown): unknown {
  if (typeof value !== "string") return value;
  const trimmed = value.trim();
  if (!trimmed) return "";
  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return value;
  }
}

function textFromOutput(output: WorkflowBlockOutput): string {
  const text = output.text ?? output.summary ?? output.content ?? output.stdout;
  return typeof text === "string" ? text : "";
}

function textFromAny(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return jsonPreview(value);
}

function resolveBlockTemplate(input: string, record: WorkflowRecord): string {
  assertValidBlockTemplates(input);
  return input.replace(
    /\{\{\s*blocks\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[(?:"[^"]+"|'[^']+'|\d+)\])*)\s*\}\}/g,
    (_match, idText: string, pathText: string) => {
      return stringifyTemplateValue(resolveBlockReference(record, idText, pathText));
    },
  );
}

function resolveTemplateValue(input: string, record: WorkflowRecord): unknown {
  assertValidBlockTemplates(input);
  const trimmed = input.trim();
  const whole = trimmed.match(
    /^\{\{\s*blocks\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[(?:"[^"]+"|'[^']+'|\d+)\])*)\s*\}\}$/,
  );
  if (whole) {
    return resolveBlockReference(record, whole[1], whole[2] ?? "");
  }
  return parseMaybeJson(resolveBlockTemplate(input, record));
}

function resolveJsonTemplate(input: string, record: WorkflowRecord): string {
  assertValidBlockTemplates(input);
  const re = /\{\{\s*blocks\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[(?:"[^"]+"|'[^']+'|\d+)\])*)\s*\}\}/g;
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  let match: RegExpExecArray | null;
  const updateState = (chunk: string) => {
    for (const ch of chunk) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = !inString;
      }
    }
  };

  while ((match = re.exec(input)) !== null) {
    const before = input.slice(index, match.index);
    output += before;
    updateState(before);
    const value = resolveBlockReference(record, match[1] ?? "", match[2] ?? "");
    output += inString
      ? escapeJsonStringContent(stringifyTemplateValue(value))
      : JSON.stringify(value ?? null);
    index = match.index + match[0].length;
  }
  const rest = input.slice(index);
  output += rest;
  return output;
}

function resolveBlockReference(record: WorkflowRecord, idText: string, pathText: string): unknown {
  const blockId = Number(idText);
  const node = record.nodes.find((item) => displayBlockId(item) === blockId);
  const reference = `{{blocks[${idText}]${pathText}}}`;
  if (!node) {
    throw new Error(`Workflow variable ${reference} references missing block #${idText}.`);
  }
  const output = parseBlockOutput(node);
  if (!output) {
    throw new Error(
      `Workflow variable ${reference} references block #${idText}, which has no output yet.`,
    );
  }
  const result = getPathResult(output, pathText);
  if (!result.found) {
    throw new Error(`Workflow variable ${reference} references a value that does not exist.`);
  }
  return result.value;
}

function resolveBlockTemplatePreview(input: string, record: WorkflowRecord): string {
  try {
    return resolveBlockTemplate(input, record);
  } catch (error) {
    return `Template error: ${(error as Error).message}`;
  }
}

function assertValidBlockTemplates(input: string): void {
  const expressionRe = /\{\{[\s\S]*?\}\}/g;
  const validRe =
    /^\{\{\s*blocks\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[(?:"[^"]+"|'[^']+'|\d+)\])*)\s*\}\}$/;
  const expressions = input.match(expressionRe) ?? [];
  for (const expression of expressions) {
    if (!validRe.test(expression)) throw invalidWorkflowVariable(expression);
  }
  const remainder = input.replace(expressionRe, "");
  if (remainder.includes("{{") || remainder.includes("}}")) {
    throw invalidWorkflowVariable(remainder.trim() || input.trim());
  }
}

function invalidWorkflowVariable(expression: string): Error {
  const preview = expression.length > 120 ? `${expression.slice(0, 117)}...` : expression;
  return new Error(
    `Invalid workflow variable ${JSON.stringify(preview)}. Expected syntax: {{blocks[2].text}}.`,
  );
}

function escapeJsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

function getPathValue(value: unknown, pathText: string): unknown {
  return getPathResult(value, pathText).value;
}

function getPathResult(value: unknown, pathText: string): { found: boolean; value: unknown } {
  let current = value;
  const re = /\.([A-Za-z_$][\w$]*)|\[("([^"]+)"|'([^']+)'|(\d+))\]/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(pathText)) !== null) {
    const key = match[1] ?? match[3] ?? match[4] ?? match[5] ?? "";
    if (!key) return { found: false, value: undefined };
    if (Array.isArray(current)) {
      const index = Number(key);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) {
        return { found: false, value: undefined };
      }
      current = current[index];
    } else if (current && typeof current === "object") {
      if (!Object.prototype.hasOwnProperty.call(current, key)) {
        return { found: false, value: undefined };
      }
      current = (current as Record<string, unknown>)[key];
    } else {
      return { found: false, value: undefined };
    }
  }
  return { found: true, value: current };
}

function getLoosePathValue(value: unknown, pathText: string): unknown {
  const trimmed = pathText.trim();
  if (!trimmed) return value;
  const normalized = trimmed.startsWith(".") || trimmed.startsWith("[") ? trimmed : `.${trimmed}`;
  return getPathValue(value, normalized);
}

function stringifyTemplateValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function incomingOutputs(record: WorkflowRecord, node: WorkflowNode): WorkflowBlockOutput[] {
  return record.edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => record.nodes.find((item) => item.id === edge.from))
    .filter((item): item is WorkflowNode => !!item)
    .map(parseBlockOutput)
    .filter((item): item is WorkflowBlockOutput => !!item);
}

async function runCodeBlock(
  code: string,
  input: WorkflowBlockOutput,
  items: WorkflowBlockOutput[],
): Promise<unknown> {
  const helpers = {
    jsonPreview,
    textFromAny,
  };
  const fn = new Function(
    "input",
    "items",
    "helpers",
    `"use strict";\nreturn (async () => {\n${code}\n})();`,
  ) as (
    input: WorkflowBlockOutput,
    items: WorkflowBlockOutput[],
    helpers: Record<string, unknown>,
  ) => Promise<unknown>;
  return await fn(input, items, helpers);
}

function outputFromValue(type: string, value: unknown): WorkflowBlockOutput {
  const obj = objectValue(value);
  if (obj) {
    return normalizeOutputObject(obj, {
      type,
      status: "success",
      data: value,
      text: textFromAny(obj.text ?? obj.data ?? value),
    });
  }
  return {
    type,
    status: "success",
    data: value,
    text: textFromAny(value),
  };
}

function waitMs(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
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

function valueFromJsonSchema(schema: Record<string, unknown> | null, root = false): unknown {
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
        : [],
    );
    const keys = Object.keys(properties).filter((key) => required.size === 0 || required.has(key));
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

function buildHttpRequestCommand(input: {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string;
  responseType: string;
}): string {
  const script = [
    "const payload=JSON.parse(process.argv[1]);",
    "const method=String(payload.method||'GET').toUpperCase();",
    "const headers=payload.headers&&typeof payload.headers==='object'?payload.headers:{};",
    "const init={method,headers};",
    "if(!['GET','HEAD'].includes(method)&&payload.body!=='')init.body=String(payload.body??'');",
    "const limit=200000;",
    "fetch(payload.url,init).then(async res=>{",
    "const raw=await res.text();",
    "const clipped=raw.length>limit;",
    "const text=clipped?raw.slice(0,limit):raw;",
    "const contentType=res.headers.get('content-type')||'';",
    "const outHeaders={};",
    "res.headers.forEach((value,key)=>{outHeaders[key]=value;});",
    "let body=text;",
    "const wantsJson=payload.responseType==='json'||(payload.responseType==='auto'&&/json/i.test(contentType));",
    "if(wantsJson){",
    "try{",
    "const parsed=raw?JSON.parse(raw):null;",
    "const serialized=JSON.stringify(parsed);",
    "body=serialized&&serialized.length>limit?{truncated:true,preview:text}:parsed;",
    "}catch(e){if(payload.responseType==='json')throw e;}",
    "}",
    "console.log(JSON.stringify({ok:res.ok,statusCode:res.status,statusText:res.statusText,url:res.url,headers:outHeaders,body,text,truncated:clipped}));",
    "}).catch(err=>{console.error(err&&err.stack?err.stack:String(err&&err.message?err.message:err));process.exit(1);});",
  ].join("");
  return `node -e "${cmdArg(script)}" "${cmdArg(JSON.stringify(input))}"`;
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

function edgePath(from: WorkflowNode, to: WorkflowNode, sourceHandle?: string): string {
  return bezierPath(outputPoint(from, sourceHandle), inputPoint(to));
}

function edgePathToPoint(
  from: WorkflowNode,
  point: CanvasPoint,
  sourceHandle?: string,
): string {
  return bezierPath(outputPoint(from, sourceHandle), worldPointToCanvas(point));
}

function inputPoint(node: WorkflowNode): CanvasPoint {
  return {
    x: worldToCanvasX(node.x),
    y: worldToCanvasY(node.y + NODE_H / 2),
  };
}

function outputPoint(node: WorkflowNode, sourceHandle?: string): CanvasPoint {
  const handles = workflowOutputHandles(nodeKind(node));
  const index = sourceHandle ? handles.indexOf(sourceHandle) : -1;
  const ratio = index >= 0 ? (index + 1) / (handles.length + 1) : 0.5;
  return {
    x: worldToCanvasX(node.x + NODE_W),
    y: worldToCanvasY(node.y + NODE_H * ratio),
  };
}

function workflowOutputHandles(kind: WorkflowNodeKind): string[] {
  if (kind === "if") return ["true", "false"];
  if (kind === "diff-approval") return ["success", "failure"];
  return [];
}

function worldToCanvasX(value: number): number {
  return value + CANVAS_ORIGIN_X;
}

function worldToCanvasY(value: number): number {
  return value + CANVAS_ORIGIN_Y;
}

function worldPointToCanvas(point: CanvasPoint): CanvasPoint {
  return {
    x: worldToCanvasX(point.x),
    y: worldToCanvasY(point.y),
  };
}

function snapPan(pan: PanOffset): PanOffset {
  return {
    x: Math.round(pan.x),
    y: Math.round(pan.y),
  };
}

function applyNodePositions(
  record: WorkflowRecord,
  positions: ReadonlyMap<string, CanvasPoint>,
): WorkflowRecord {
  if (positions.size === 0) return record;
  let changed = false;
  const nodes = record.nodes.map((node) => {
    const position = positions.get(node.id);
    if (!position || (node.x === position.x && node.y === position.y)) return node;
    changed = true;
    return { ...node, ...position };
  });
  return changed ? { ...record, nodes } : record;
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
  if (kind === "input") return "Input";
  if (
    kind === "trigger" ||
    kind === "manual-trigger" ||
    kind === "cron" ||
    kind === "webhook-trigger"
  )
    return "Trigger";
  if (kind === "command") return "Command";
  if (kind === "git-commit" || kind === "git-checkout" || kind === "git-delete-branch" || kind === "github-pr") return "Git";
  if (kind === "web" || kind === "http-request") return "Network";
  if (
    kind === "if" ||
    kind === "diff-approval" ||
    kind === "wait" ||
    kind === "loop-items"
  )
    return "Logic";
  if (kind === "code") return "Code";
  if (kind === "file-read" || kind === "file-write") return "File";
  if (kind === "markdown" || kind === "set" || kind === "merge" || kind === "json") return "Data";
  if (kind === "mcp") return "MCP";
  if (kind === "codex-plugin" || kind === "claude-plugin") return "Plugins";
  return "AI";
}

function inputLabelForKind(kind: WorkflowNodeKind): string {
  if (kind === "input") return "Input";
  if (kind === "command") return "Command";
  if (kind === "web") return "URL";
  if (kind === "http-request") return "Request";
  if (kind === "set") return "Data JSON";
  if (kind === "if") return "Condition";
  if (kind === "diff-approval") return "Diff";
  if (kind === "git-commit") return "Commit";
  if (kind === "git-checkout") return "Switch branch";
  if (kind === "git-delete-branch") return "Delete branch";
  if (kind === "github-pr") return "Pull request";
  if (kind === "merge") return "Merge";
  if (kind === "code") return "JavaScript";
  if (kind === "loop-items") return "Items";
  if (kind === "wait") return "Seconds";
  if (kind === "json") return "JSON";
  if (kind === "file-read") return "Path";
  if (kind === "file-write") return "Path / content";
  if (kind === "markdown") return "Markdown";
  if (kind === "mcp") return "MCP";
  if (kind === "codex-plugin" || kind === "claude-plugin") return "Plugins";
  return "Prompt";
}

function nodeKind(node: WorkflowNode): WorkflowNodeKind {
  if (
    node.kind === "input" ||
    node.kind === "trigger" ||
    node.kind === "manual-trigger" ||
    node.kind === "cron" ||
    node.kind === "webhook-trigger" ||
    node.kind === "command" ||
    node.kind === "web" ||
    node.kind === "http-request" ||
    node.kind === "set" ||
    node.kind === "if" ||
    node.kind === "diff-approval" ||
    node.kind === "git-commit" ||
    node.kind === "git-checkout" ||
    node.kind === "git-delete-branch" ||
    node.kind === "github-pr" ||
    node.kind === "merge" ||
    node.kind === "code" ||
    node.kind === "loop-items" ||
    node.kind === "wait" ||
    node.kind === "json" ||
    node.kind === "file-read" ||
    node.kind === "file-write" ||
    node.kind === "markdown" ||
    node.kind === "mcp" ||
    node.kind === "codex-plugin" ||
    node.kind === "claude-plugin"
  ) {
    return node.kind;
  }
  return "agent";
}

function isTriggerNodeKind(kind: WorkflowNodeKind): boolean {
  return (
    kind === "trigger" || kind === "manual-trigger" || kind === "cron" || kind === "webhook-trigger"
  );
}

function nodeFromTemplate(
  template: BlockTemplate,
  id: string,
  blockId: number,
  x: number,
  y: number,
  title: string,
): WorkflowNode {
  return {
    id,
    blockId,
    kind: template.kind,
    title,
    providerKind: template.providerKind ?? "codex-cli",
    model: template.model ?? "default",
    prompt: template.prompt ?? "",
    config: {
      ...(supportsFailover(template.kind) ? { failover: false } : {}),
      ...(template.config ?? {}),
      icon: template.icon,
    },
    x,
    y,
    status: "idle",
  };
}

function nodeIconName(node: WorkflowNode): WorkflowIconName {
  const icon = toWorkflowIconName(node.config?.icon);
  if (icon) return icon;
  const kind = nodeKind(node);
  if (kind === "input") return "input";
  if (kind === "trigger") return "trigger";
  if (kind === "manual-trigger") return "trigger";
  if (kind === "cron") return "cron";
  if (kind === "webhook-trigger") return "webhook";
  if (kind === "command") return "command";
  if (kind === "web") return "web";
  if (kind === "http-request") return "http";
  if (kind === "set") return "set";
  if (kind === "if") return "if";
  if (kind === "diff-approval" || kind === "git-commit" || kind === "git-checkout" || kind === "git-delete-branch" || kind === "github-pr") return "git";
  if (kind === "merge") return "merge";
  if (kind === "code") return "code";
  if (kind === "loop-items") return "loop";
  if (kind === "wait") return "wait";
  if (kind === "json") return "json";
  if (kind === "file-read") return "read";
  if (kind === "file-write") return "write";
  if (kind === "markdown") return "markdown";
  if (kind === "mcp") return "mcp";
  if (kind === "codex-plugin") return "codex";
  if (kind === "claude-plugin") return "claude";
  return node.providerKind === "claude-cli" ? "claude" : "codex";
}

function toWorkflowIconName(value: unknown): WorkflowIconName | null {
  if (typeof value !== "string") return null;
  const icon = value.trim();
  const current = new Set<WorkflowIconName>([
    "trigger",
    "input",
    "cron",
    "webhook",
    "command",
    "ai",
    "network",
    "file",
    "output",
    "claude",
    "codex",
    "web",
    "http",
    "set",
    "if",
    "merge",
    "code",
    "wait",
    "json",
    "loop",
    "read",
    "write",
    "markdown",
    "mcp",
    "git",
  ]);
  if (current.has(icon as WorkflowIconName)) return icon as WorkflowIconName;
  const legacy: Record<string, WorkflowIconName> = {
    "legacy-trigger": "trigger",
    "legacy-command": "command",
    "legacy-ai": "ai",
    "legacy-web": "web",
    "legacy-file": "file",
    "legacy-output": "output",
    C: "claude",
    X: "codex",
    R: "read",
    W: "write",
    M: "markdown",
    P: "mcp",
  };
  return legacy[icon] ?? null;
}

const WORKFLOW_CODICONS: Partial<Record<WorkflowIconName, string>> = {
  trigger: "debug-start",
  input: "symbol-string",
  cron: "clock",
  webhook: "radio-tower",
  command: "terminal",
  ai: "sparkle",
  network: "globe",
  web: "globe",
  http: "cloud",
  set: "symbol-key",
  if: "git-branch",
  merge: "git-merge",
  code: "code",
  wait: "clock",
  json: "json",
  loop: "sync",
  file: "file",
  read: "file",
  write: "edit",
  output: "output",
  markdown: "markdown",
  mcp: "plug",
};

function WorkflowIcon({ name }: { name: WorkflowIconName }) {
  if (name === "claude") return <ClaudeLogo />;
  if (name === "codex") return <OpenAILogo />;
  const codicon = WORKFLOW_CODICONS[name];
  if (codicon) return <i className={`codicon codicon-${codicon}`} aria-hidden />;

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
    case "cron":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <path d="M12 7.5V12l3.2 2" />
          <path d="M7 3.8V2.5" />
          <path d="M17 3.8V2.5" />
        </svg>
      );
    case "webhook":
      return (
        <svg {...common}>
          <path d="M7.5 8.5a3 3 0 1 1 2.6-1.5l-2.4 4.1" />
          <path d="M16.5 8.5a3 3 0 1 0-2.6-1.5l2.4 4.1" />
          <path d="M12 19a3 3 0 1 0 0-6 3 3 0 0 0 0 6z" />
          <path d="M10.4 13.6 7.7 11" />
          <path d="m13.6 13.6 2.7-2.6" />
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
    case "http":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <path d="M4.8 12h14.4" />
          <path d="M12 4.5c2 2.1 3 4.6 3 7.5s-1 5.4-3 7.5" />
          <path d="M12 4.5c-2 2.1-3 4.6-3 7.5s1 5.4 3 7.5" />
        </svg>
      );
    case "set":
      return (
        <svg {...common}>
          <path d="M5 6.5h14" />
          <path d="M5 12h14" />
          <path d="M5 17.5h9" />
          <path d="M8 4.5v15" />
        </svg>
      );
    case "if":
      return (
        <svg {...common}>
          <path d="M6 5.5h6a4 4 0 0 1 4 4v9" />
          <path d="M6 18.5h6a4 4 0 0 0 4-4v-5" />
          <path d="m18.5 16-2.5 2.5-2.5-2.5" />
        </svg>
      );
    case "merge":
      return (
        <svg {...common}>
          <path d="M5 5.5h3a4 4 0 0 1 4 4v9" />
          <path d="M19 5.5h-3a4 4 0 0 0-4 4" />
          <path d="m14.5 16-2.5 2.5L9.5 16" />
        </svg>
      );
    case "code":
      return (
        <svg {...common}>
          <path d="m8.3 8.2-3.2 3.8 3.2 3.8" />
          <path d="m15.7 8.2 3.2 3.8-3.2 3.8" />
          <path d="M13.2 6.8 10.8 17.2" />
        </svg>
      );
    case "wait":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="7.5" />
          <path d="M12 7.5V12l3 2" />
        </svg>
      );
    case "json":
      return (
        <svg {...common}>
          <path d="M8 5.5H6.5A2.5 2.5 0 0 0 4 8v1.2A2.8 2.8 0 0 1 2.8 12 2.8 2.8 0 0 1 4 14.8V16a2.5 2.5 0 0 0 2.5 2.5H8" />
          <path d="M16 5.5h1.5A2.5 2.5 0 0 1 20 8v1.2a2.8 2.8 0 0 0 1.2 2.8A2.8 2.8 0 0 0 20 14.8V16a2.5 2.5 0 0 1-2.5 2.5H16" />
        </svg>
      );
    case "loop":
      return (
        <svg {...common}>
          <path d="M17 7.5H8.5a4 4 0 0 0 0 8H10" />
          <path d="m14.5 5 2.5 2.5-2.5 2.5" />
          <path d="M7 16.5h8.5a4 4 0 0 0 0-8H14" />
          <path d="m9.5 19-2.5-2.5L9.5 14" />
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

function httpRequestConfig(node: WorkflowNode): HttpRequestNodeConfig {
  const config = node.config ?? {};
  const rawMethod = typeof config.method === "string" ? config.method.toUpperCase() : "GET";
  const rawResponseType = typeof config.responseType === "string" ? config.responseType : "auto";
  return {
    method: HTTP_METHODS.includes(rawMethod as (typeof HTTP_METHODS)[number]) ? rawMethod : "GET",
    url: typeof config.url === "string" ? config.url : node.prompt,
    headers:
      typeof config.headers === "string" && config.headers.trim()
        ? config.headers
        : '{\n  "accept": "application/json"\n}',
    body: typeof config.body === "string" ? config.body : "",
    responseType: HTTP_RESPONSE_TYPES.includes(
      rawResponseType as (typeof HTTP_RESPONSE_TYPES)[number],
    )
      ? rawResponseType
      : "auto",
  };
}

function setNodeConfig(node: WorkflowNode): SetNodeConfig {
  const config = node.config ?? {};
  return {
    data: typeof config.data === "string" ? config.data : '{\n  "text": ""\n}',
  };
}

function ifNodeConfig(node: WorkflowNode): IfNodeConfig {
  const config = node.config ?? {};
  if (typeof config.expression === "string") return { expression: config.expression };
  const left = typeof config.left === "string" ? config.left : "";
  const right = typeof config.right === "string" ? config.right : "";
  const operator = typeof config.operator === "string" ? config.operator : "equals";
  const symbol =
    operator === "equals"
      ? "=="
      : operator === "notEquals"
        ? "!="
        : operator === "greaterThan"
          ? ">"
          : operator === "lessThan"
            ? "<"
            : "==";
  return {
    expression:
      operator === "exists"
        ? `${left} != null`
        : operator === "isEmpty"
          ? `${left} == ""`
          : `${left} ${symbol} ${right}`,
  };
}

function workflowInputTitle(node: WorkflowNode): string {
  const configured = node.config?.inputTitle;
  if (Object.prototype.hasOwnProperty.call(node.config ?? {}, "inputTitle")) {
    return typeof configured === "string" ? configured : "";
  }
  if (node.prompt.trim()) return node.prompt.trim();
  return node.title || "Input";
}

function mergeNodeConfig(node: WorkflowNode): MergeNodeConfig {
  const config = node.config ?? {};
  const mode = typeof config.mode === "string" ? config.mode : "object";
  return {
    mode: MERGE_MODES.includes(mode as (typeof MERGE_MODES)[number]) ? mode : "object",
  };
}

function codeNodeConfig(node: WorkflowNode): CodeNodeConfig {
  const config = node.config ?? {};
  return {
    code:
      typeof config.code === "string"
        ? config.code
        : 'return {\n  text: input.text || input.content || input.stdout || "",\n  input\n};',
  };
}

function waitNodeConfig(node: WorkflowNode): WaitNodeConfig {
  const config = node.config ?? {};
  const seconds = Number(config.seconds);
  return {
    seconds: Number.isFinite(seconds) ? clamp(seconds, 0, 86_400) : 1,
  };
}

function loopItemsConfig(node: WorkflowNode): LoopItemsNodeConfig {
  const config = node.config ?? {};
  const batchSize = Number(config.batchSize);
  const mode = typeof config.mode === "string" ? config.mode : "items";
  return {
    source: typeof config.source === "string" ? config.source : "",
    batchSize: Number.isFinite(batchSize) ? clamp(batchSize, 1, 1000) : 1,
    mode: LOOP_MODES.includes(mode as (typeof LOOP_MODES)[number]) ? mode : "items",
  };
}

function jsonNodeConfig(node: WorkflowNode): JsonNodeConfig {
  const config = node.config ?? {};
  return {
    source: typeof config.source === "string" ? config.source : "",
    path: typeof config.path === "string" ? config.path : "",
  };
}

function pluginSelectorsForNode(node: WorkflowNode): string[] {
  const value = node.config?.pluginSelectors;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function mcpNodeConfig(node: WorkflowNode): McpNodeConfig {
  const config = node.config ?? {};
  const legacyServer = typeof config.server === "string" ? config.server : "";
  const legacyTool = typeof config.tool === "string" ? config.tool : "";
  const tools = Array.isArray(config.tools) ? config.tools.filter(isRemoteMcpTool) : [];
  return {
    remoteLink: typeof config.remoteLink === "string" ? config.remoteLink : legacyServer,
    postUrl: typeof config.postUrl === "string" ? config.postUrl : "",
    headers:
      typeof config.headers === "string" && config.headers.trim()
        ? config.headers
        : DEFAULT_MCP_HEADERS_JSON,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    toolName: typeof config.toolName === "string" ? config.toolName : legacyTool,
    arguments: typeof config.arguments === "string" ? config.arguments : "{}",
    tools,
    connectedAt: typeof config.connectedAt === "number" ? config.connectedAt : undefined,
    connectionStatus: typeof config.connectionStatus === "string" ? config.connectionStatus : "",
    connectionError: typeof config.connectionError === "string" ? config.connectionError : "",
  };
}

function runDetailsSnapshot(node: WorkflowNode): WorkflowRunDetailSnapshot | null {
  const value = node.config?.runDetails;
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const raw = value as Partial<WorkflowRunDetailSnapshot>;
  const legacyAutoContinue = (raw as { autoContinue?: unknown }).autoContinue;
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
    startedAt: typeof raw.startedAt === "number" ? raw.startedAt : (node.startedAt ?? Date.now()),
    completedAt: typeof raw.completedAt === "number" ? raw.completedAt : undefined,
    commandLine: typeof raw.commandLine === "string" ? raw.commandLine : "",
    stdout: typeof raw.stdout === "string" ? raw.stdout : "",
    stderr: typeof raw.stderr === "string" ? raw.stderr : "",
    transcript: typeof raw.transcript === "string" ? raw.transcript : "",
    terminalSessionId:
      typeof raw.terminalSessionId === "string" ? raw.terminalSessionId : undefined,
    conversationSessionId:
      typeof raw.conversationSessionId === "string" ? raw.conversationSessionId : undefined,
    terminalStatus: typeof raw.terminalStatus === "string" ? raw.terminalStatus : undefined,
    autoSuccess:
      typeof raw.autoSuccess === "boolean"
        ? raw.autoSuccess
        : typeof legacyAutoContinue === "boolean"
          ? legacyAutoContinue
          : undefined,
    paused: typeof raw.paused === "boolean" ? raw.paused : undefined,
    exitCode: typeof raw.exitCode === "number" || raw.exitCode === null ? raw.exitCode : undefined,
    signal: typeof raw.signal === "string" || raw.signal === null ? raw.signal : undefined,
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

function DiffApprovalView({
  workspaceId,
  onOpenDiff,
}: {
  workspaceId: string;
  onOpenDiff: (title: string, entries: MultiDiffEntry[]) => void;
}) {
  const { resolvedLanguage } = useUiPreferences();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const openDiff = async () => {
    setLoading(true);
    setError(null);
    try {
      const status = await getGitStatus(workspaceId);
      const changes = status.changes.filter(
        (change) => change.indexStatus !== " " || change.worktreeStatus !== " ",
      );
      const entries = await Promise.all(
        changes.map(async (change) => {
          const staged = change.indexStatus !== " " && change.indexStatus !== "?";
          const diff = await getGitDiff(
            workspaceId,
            change.path,
            staged ? "HEAD" : "INDEX",
            staged ? "INDEX" : "WORKTREE",
          );
          return {
            path: diff.path,
            leftContent: diff.leftContent,
            rightContent: diff.rightContent,
            leftMissing: diff.leftMissing,
            rightMissing: diff.rightMissing,
            binary: diff.binary,
          } satisfies MultiDiffEntry;
        }),
      );
      if (entries.length === 0) {
        setError(resolvedLanguage === "zh-CN" ? "当前没有可审批的改动" : "No changes to review.");
        return;
      }
      onOpenDiff(resolvedLanguage === "zh-CN" ? "待审批的 Diff" : "Diff for approval", entries);
    } catch (reason) {
      setError((reason as Error).message);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="workflow-inspector__approval-open">
      <button type="button" disabled={loading} onClick={() => void openDiff()}>
        <i className="codicon codicon-diff-multiple" aria-hidden="true" />
        {loading
          ? resolvedLanguage === "zh-CN"
            ? "正在打开..."
            : "Opening..."
          : resolvedLanguage === "zh-CN"
            ? "打开 Diff"
            : "Open Diff"}
      </button>
      {error && <div className="workflow-inspector__mcp-error">{error}</div>}
    </div>
  );
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
      "$1redacted",
    );
  }
}

function isSensitiveParam(key: string): boolean {
  return /^(api[_-]?key|key|token|access[_-]?token|auth|authorization)$/i.test(key);
}

function cloneWorkflow(record: WorkflowRecord): WorkflowRecord {
  return JSON.parse(JSON.stringify(record)) as WorkflowRecord;
}

function clearRunDetails(config: WorkflowNode["config"]): WorkflowNode["config"] | undefined {
  if (!config) return config;
  const {
    runDetails: _runDetails,
    waitingForInput: _waitingForInput,
    waitingForApproval: _waitingForApproval,
    ...rest
  } = config;
  void _runDetails;
  void _waitingForInput;
  void _waitingForApproval;
  return rest;
}

function restoreTopologyOnly(
  historyRecord: WorkflowRecord,
  currentRecord: WorkflowRecord,
): WorkflowRecord {
  const currentById = new Map(currentRecord.nodes.map((node) => [node.id, node]));
  const nodes = historyRecord.nodes.map((historyNode) => {
    const current = currentById.get(historyNode.id);
    return current ?? historyNode;
  });
  const nodeIds = new Set(nodes.map((node) => node.id));
  const edges = historyRecord.edges.filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to),
  );
  return {
    ...currentRecord,
    nodes,
    edges,
  };
}

function workflowIsRunning(record: WorkflowRecord): boolean {
  return (
    record.nodes.some((node) => node.status === "running") ||
    record.runs.some((run) => run.status === "running")
  );
}

function displayBlockId(node: WorkflowNode): number {
  return typeof node.blockId === "number" && Number.isInteger(node.blockId) && node.blockId > 0
    ? node.blockId
    : 0;
}

function nextBlockId(record: WorkflowRecord): number {
  return Math.max(0, ...record.nodes.map(displayBlockId)) + 1;
}

function BlurNumberInput({
  value,
  min,
  max,
  step,
  disabled = false,
  onCommit,
}: {
  value: number;
  min?: number;
  max?: number;
  step?: number;
  disabled?: boolean;
  onCommit: (value: number) => void;
}) {
  const [draft, setDraft] = useState(String(value));
  const focused = useRef(false);
  const cancelled = useRef(false);

  useEffect(() => {
    if (!focused.current) setDraft(String(value));
  }, [value]);

  const commit = () => {
    const parsed = Number(draft);
    if (!draft.trim() || !Number.isFinite(parsed)) {
      setDraft(String(value));
      return;
    }
    const next = clamp(parsed, min ?? -Infinity, max ?? Infinity);
    setDraft(String(next));
    if (next !== value) onCommit(next);
  };

  return (
    <input
      type="number"
      min={min}
      max={max}
      step={step}
      value={draft}
      disabled={disabled}
      onFocus={() => {
        focused.current = true;
        cancelled.current = false;
      }}
      onChange={(event) => setDraft(event.target.value)}
      onBlur={() => {
        focused.current = false;
        if (cancelled.current) {
          cancelled.current = false;
          setDraft(String(value));
          return;
        }
        commit();
      }}
      onKeyDown={(event) => {
        if (event.key === "Enter") event.currentTarget.blur();
        if (event.key === "Escape") {
          cancelled.current = true;
          setDraft(String(value));
          event.currentTarget.blur();
        }
      }}
    />
  );
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}
