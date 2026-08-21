import * as fs from "node:fs/promises";
import * as path from "node:path";
import { config } from "./config.js";
import { errors } from "./errors.js";

const WORKFLOW_ID_RE = /^wf_[a-z0-9]{8,32}$/;
const NODE_ID_RE = /^node_[a-z0-9]{6,32}$/;
const EDGE_ID_RE = /^edge_[a-z0-9]{6,32}$/;
const writeLocks = new Map<string, Promise<void>>();
const updateLocks = new Map<string, Promise<void>>();
let workflowUsageWrite = Promise.resolve();

export type WorkflowProviderKind = "codex-cli" | "claude-cli";
export type WorkflowNodeKind =
  | "agent"
  | "input"
  | "variable"
  | "trigger"
  | "manual-trigger"
  | "cron"
  | "webhook-trigger"
  | "command"
  | "web"
  | "http-request"
  | "set"
  | "if"
  | "diff-approval"
  | "git-commit"
  | "git-checkout"
  | "git-delete-branch"
  | "github-pr"
  | "merge"
  | "code"
  | "loop-items"
  | "wait"
  | "json"
  | "file-read"
  | "file-write"
  | "markdown"
  | "mcp"
  | "codex-plugin"
  | "claude-plugin";
export type WorkflowNodeStatus = "idle" | "running" | "success" | "error";
export type WorkflowRunStatus = "idle" | "running" | "success" | "error" | "stopped";

export interface WorkflowNode {
  id: string;
  blockId?: number;
  kind: WorkflowNodeKind;
  title: string;
  providerKind: WorkflowProviderKind;
  /** Stable OSheep adapter identifier; providerKind remains for old workflows. */
  adapterId?: "claude-code" | "codex" | string;
  model: string;
  prompt: string;
  x: number;
  y: number;
  status: WorkflowNodeStatus;
  summary?: string;
  rawOutput?: string;
  error?: string;
  config?: Record<string, unknown>;
  startedAt?: number;
  completedAt?: number;
}

export interface WorkflowEdge {
  id: string;
  from: string;
  to: string;
  passSummary: boolean;
  sourceHandle?: string;
}

export interface WorkflowRun {
  id: string;
  status: WorkflowRunStatus;
  startedAt: number;
  completedAt?: number;
  nodeIds: string[];
  error?: string;
  trace?: WorkflowRunTrace[];
  stats?: WorkflowRunStats;
  resumable?: boolean;
  resumeFingerprint?: string;
}

export interface WorkflowRunTrace {
  nodeId: string;
  title: string;
  kind: WorkflowNodeKind;
  model?: string;
  status: WorkflowNodeStatus | "stopped";
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  retryReasons?: string[];
  terminal?: {
    commandLine?: string;
    stdout?: string;
    stderr?: string;
    transcript?: string;
    exitCode?: number | null;
    signal?: string | null;
  };
  tokens?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    total?: number;
  };
  cost?: number;
  providerId?: string;
  billingMultiplier?: number;
}

export interface WorkflowRunStats {
  durationMs?: number;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  totalTokens?: number;
  cost?: number;
  nodeCount?: number;
  retryCount?: number;
}

export interface WorkflowRecord {
  id: string;
  title: string;
  readme?: string;
  templateBinding?: {
    source: "system" | "user";
    id: string;
  };
  createdAt: number;
  updatedAt: number;
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  runs: WorkflowRun[];
}

export interface WorkflowSummary {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  nodeCount: number;
  edgeCount: number;
  status: WorkflowRunStatus;
}

export type WorkflowUsageRange = "7d" | "30d" | "all";

export interface WorkflowUsageTotals {
  runs: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

export interface WorkflowUsageStatistics {
  generatedAt: number;
  range: WorkflowUsageRange;
  totals: WorkflowUsageTotals;
  daily: Array<{ date: string; runs: number; tokens: number; cost: number }>;
  workflows: Array<{
    workflowId: string;
    title: string;
    runs: number;
    tokens: number;
    cost: number;
  }>;
  models: Array<{ model: string; runs: number; tokens: number; cost: number }>;
  recentRuns: Array<{
    workflowId: string;
    workflowTitle: string;
    runId: string;
    status: WorkflowRunStatus;
    startedAt: number;
    completedAt?: number;
    tokens: number;
    cost: number;
  }>;
}

export interface AllProjectsWorkflowUsage {
  generatedAt: number;
  range: WorkflowUsageRange;
  projectCount: number;
  totals: WorkflowUsageTotals;
}

interface StoredWorkflowUsageEntry {
  key: string;
  projectPath: string;
  workflowId: string;
  workflowTitle: string;
  runId: string;
  runStatus: WorkflowRunStatus;
  runStartedAt: number;
  runCompletedAt?: number;
  traceStartedAt: number;
  model?: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  totalTokens: number;
  cost: number;
}

interface StoredWorkflowUsage {
  version: 1;
  updatedAt: number;
  entries: StoredWorkflowUsageEntry[];
}

function workflowDir(workspaceRoot: string): string {
  return path.join(workspaceRoot, ".osheep", "workflows");
}

function workflowFile(workspaceRoot: string, id: string): string {
  return path.join(workflowDir(workspaceRoot), `${id}.json`);
}

function validateWorkflowId(id: string): void {
  if (typeof id !== "string" || !WORKFLOW_ID_RE.test(id)) {
    throw errors.invalidPath("workflow id is invalid");
  }
}

function randomPart(length: number): string {
  let out = "";
  while (out.length < length) {
    out += Math.random().toString(36).slice(2);
  }
  return out.slice(0, length);
}

export function generateWorkflowId(): string {
  const t = Date.now().toString(36).slice(-4);
  return `wf_${randomPart(8)}${t}`;
}

export function generateWorkflowNodeId(): string {
  return `node_${randomPart(8)}`;
}

export function generateWorkflowEdgeId(): string {
  return `edge_${randomPart(8)}`;
}

async function ensureWorkflowDir(workspaceRoot: string): Promise<void> {
  await fs.mkdir(workflowDir(workspaceRoot), { recursive: true });
}

function asProviderKind(value: unknown): WorkflowProviderKind {
  return value === "claude-cli" ? "claude-cli" : "codex-cli";
}

function asNodeKind(value: unknown): WorkflowNodeKind {
  if (
    value === "input" ||
    value === "variable" ||
    value === "trigger" ||
    value === "manual-trigger" ||
    value === "cron" ||
    value === "webhook-trigger" ||
    value === "command" ||
    value === "web" ||
    value === "http-request" ||
    value === "set" ||
    value === "if" ||
    value === "diff-approval" ||
    value === "git-commit" ||
    value === "git-checkout" ||
    value === "git-delete-branch" ||
    value === "github-pr" ||
    value === "merge" ||
    value === "code" ||
    value === "loop-items" ||
    value === "wait" ||
    value === "json" ||
    value === "file-read" ||
    value === "file-write" ||
    value === "markdown" ||
    value === "mcp" ||
    value === "codex-plugin" ||
    value === "claude-plugin"
  ) {
    return value;
  }
  return "agent";
}

function asStatus(value: unknown): WorkflowNodeStatus {
  if (value === "running" || value === "success" || value === "error") return value;
  return "idle";
}

function asRunStatus(value: unknown): WorkflowRunStatus {
  if (value === "running" || value === "success" || value === "error" || value === "stopped") {
    return value;
  }
  return "idle";
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : undefined;
}

function sanitizeNode(raw: unknown, index: number): WorkflowNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WorkflowNode>;
  const id = typeof r.id === "string" && NODE_ID_RE.test(r.id) ? r.id : generateWorkflowNodeId();
  const providerKind = asProviderKind(r.providerKind);
  const node: WorkflowNode = {
    id,
    blockId: asPositiveInteger(r.blockId) ?? index + 1,
    kind: asNodeKind(r.kind),
    title:
      typeof r.title === "string" && r.title.trim()
        ? r.title
        : asNodeKind(r.kind) === "trigger"
          ? "Workflow run"
          : `Block ${index + 1}`,
    providerKind,
    adapterId:
      typeof r.adapterId === "string" && r.adapterId.trim()
        ? r.adapterId.trim()
        : providerKind === "claude-cli"
          ? "claude-code"
          : "codex",
    model: typeof r.model === "string" ? r.model : "default",
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    x: asFiniteNumber(r.x, 80 + index * 340),
    y: asFiniteNumber(r.y, 90),
    status: asStatus(r.status),
  };
  if (typeof r.summary === "string") node.summary = sanitizeBlockOutputText(r.summary);
  if (typeof r.rawOutput === "string") node.rawOutput = sanitizeBlockOutputText(r.rawOutput);
  if (typeof r.error === "string") node.error = r.error;
  if (r.config && typeof r.config === "object" && !Array.isArray(r.config)) {
    node.config = r.config as Record<string, unknown>;
  }
  if (typeof r.startedAt === "number") node.startedAt = r.startedAt;
  if (typeof r.completedAt === "number") node.completedAt = r.completedAt;
  return node;
}

function sanitizeBlockOutputText(value: string): string {
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return value;
    const sanitized = { ...(parsed as Record<string, unknown>) };
    delete sanitized.CHANGED_FILES;
    delete sanitized.VERIFICATION;
    // Diff approval output is intentionally metadata-only. Older workflow
    // records may still contain the full diff, which can be several megabytes.
    if (sanitized.type === "diff-approval") delete sanitized.diff;
    return JSON.stringify(sanitized, null, 2);
  } catch {
    return value;
  }
}

function sanitizeEdge(raw: unknown, nodeIds: Set<string>): WorkflowEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WorkflowEdge>;
  if (typeof r.from !== "string" || typeof r.to !== "string") return null;
  if (!nodeIds.has(r.from) || !nodeIds.has(r.to) || r.from === r.to) return null;
  const id = typeof r.id === "string" && EDGE_ID_RE.test(r.id) ? r.id : generateWorkflowEdgeId();
  const edge: WorkflowEdge = {
    id,
    from: r.from,
    to: r.to,
    passSummary: r.passSummary !== false,
  };
  if (typeof r.sourceHandle === "string" && r.sourceHandle.trim()) {
    edge.sourceHandle = r.sourceHandle.trim().slice(0, 32);
  }
  return edge;
}

function sanitizeRun(raw: unknown): WorkflowRun | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WorkflowRun>;
  if (typeof r.id !== "string" || !r.id) return null;
  const run: WorkflowRun = {
    id: r.id,
    status: asRunStatus(r.status),
    startedAt: typeof r.startedAt === "number" ? r.startedAt : Date.now(),
    nodeIds: Array.isArray(r.nodeIds)
      ? r.nodeIds.filter((id): id is string => typeof id === "string")
      : [],
  };
  if (typeof r.completedAt === "number") run.completedAt = r.completedAt;
  if (typeof r.error === "string") run.error = r.error;
  if (Array.isArray((r as any).trace)) {
    run.trace = (r as any).trace
      .filter((item: any) => item && typeof item.nodeId === "string")
      .map((item: any) => {
        if (!item.output || typeof item.output !== "object" || Array.isArray(item.output)) {
          return item;
        }
        const output = { ...item.output } as Record<string, unknown>;
        if (item.kind === "diff-approval" || output.type === "diff-approval") {
          delete output.diff;
        }
        return { ...item, output };
      })
      .slice(-500);
  }
  if ((r as any).stats && typeof (r as any).stats === "object") run.stats = (r as any).stats;
  if ((r as any).resumable === true) run.resumable = true;
  if (typeof (r as any).resumeFingerprint === "string") {
    run.resumeFingerprint = (r as any).resumeFingerprint;
  }
  return run;
}

function defaultNodes(): WorkflowNode[] {
  return [
    {
      id: generateWorkflowNodeId(),
      blockId: 1,
      kind: "trigger",
      title: "Workflow run",
      providerKind: "codex-cli",
      model: "default",
      prompt: "",
      x: 80,
      y: 120,
      status: "idle",
    },
    {
      id: generateWorkflowNodeId(),
      blockId: 2,
      kind: "agent",
      title: "Codex",
      providerKind: "codex-cli",
      model: "default",
      prompt: "",
      x: 360,
      y: 120,
      status: "idle",
    },
  ];
}

function sanitize(raw: unknown, fallbackId: string): WorkflowRecord {
  const r = (raw ?? {}) as Partial<WorkflowRecord>;
  const id = typeof r.id === "string" && WORKFLOW_ID_RE.test(r.id) ? r.id : fallbackId;
  const nodes = Array.isArray(r.nodes)
    ? r.nodes
        .map((node, index) => sanitizeNode(node, index))
        .filter((node): node is WorkflowNode => node !== null)
    : [];
  const safeNodes = nodes.length ? nodes : defaultNodes();
  const nodeIds = new Set(safeNodes.map((node) => node.id));
  const edges = Array.isArray(r.edges)
    ? r.edges
        .map((edge) => sanitizeEdge(edge, nodeIds))
        .filter((edge): edge is WorkflowEdge => edge !== null)
    : [];
  const createdAt = typeof r.createdAt === "number" ? r.createdAt : Date.now();
  const runs = Array.isArray(r.runs)
    ? r.runs
        .map(sanitizeRun)
        .filter((run): run is WorkflowRun => run !== null)
        .slice(-50)
    : [];
  const templateBinding =
    r.templateBinding &&
    typeof r.templateBinding === "object" &&
    (r.templateBinding.source === "system" || r.templateBinding.source === "user") &&
    typeof r.templateBinding.id === "string" &&
    /^tpl_[a-z0-9]{8,32}$/.test(r.templateBinding.id)
      ? {
          source: r.templateBinding.source,
          id: r.templateBinding.id,
        }
      : undefined;
  return {
    id,
    title: typeof r.title === "string" && r.title.trim() ? r.title : "New workflow",
    readme: typeof r.readme === "string" ? r.readme : "",
    templateBinding,
    createdAt,
    updatedAt: typeof r.updatedAt === "number" ? r.updatedAt : createdAt,
    nodes: safeNodes,
    edges,
    runs,
  };
}

function workflowStatus(record: WorkflowRecord): WorkflowRunStatus {
  if (record.runs.some((run) => run.status === "running")) return "running";
  if (record.nodes.some((node) => node.status === "running")) return "running";
  const latest = record.runs[record.runs.length - 1];
  return latest?.status ?? "idle";
}

export async function listWorkflows(workspaceRoot: string): Promise<WorkflowSummary[]> {
  await ensureWorkflowDir(workspaceRoot);
  let entries: string[];
  try {
    entries = await fs.readdir(workflowDir(workspaceRoot));
  } catch {
    return [];
  }
  const out: WorkflowSummary[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    if (!WORKFLOW_ID_RE.test(id)) continue;
    try {
      const text = await fs.readFile(path.join(workflowDir(workspaceRoot), entry), "utf-8");
      const record = sanitize(JSON.parse(text), id);
      if (record.templateBinding) continue;
      out.push({
        id: record.id,
        title: record.title,
        createdAt: record.createdAt,
        updatedAt: record.updatedAt,
        nodeCount: record.nodes.length,
        edgeCount: record.edges.length,
        status: workflowStatus(record),
      });
    } catch {
      /* skip invalid workflow files */
    }
  }
  out.sort((a, b) => b.updatedAt - a.updatedAt);
  return out;
}

export async function getWorkflowUsageStatistics(
  workspaceRoot: string,
  options: {
    range?: WorkflowUsageRange;
    timezoneOffsetMinutes?: number;
    now?: number;
  } = {},
): Promise<WorkflowUsageStatistics> {
  const range = options.range ?? "30d";
  const now = options.now ?? Date.now();
  const timezoneOffsetMinutes = Number.isFinite(options.timezoneOffsetMinutes)
    ? Math.max(-840, Math.min(840, options.timezoneOffsetMinutes!))
    : 0;
  const startAt = usageRangeStart(range, now, timezoneOffsetMinutes);
  const projectPath = await fs.realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot));
  await workflowUsageWrite.catch(() => undefined);
  const stored = await readStoredWorkflowUsage();
  const entries = stored.entries.filter(
    (entry) =>
      openedProjectKey(entry.projectPath) === openedProjectKey(projectPath) &&
      entry.runStartedAt >= startAt &&
      entry.runStartedAt <= now,
  );
  const totals: WorkflowUsageStatistics["totals"] = {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
  const runIds = new Set<string>();
  const daily = new Map<
    string,
    WorkflowUsageStatistics["daily"][number] & { runIds: Set<string> }
  >();
  const workflows = new Map<
    string,
    WorkflowUsageStatistics["workflows"][number] & { runIds: Set<string> }
  >();
  const models = new Map<
    string,
    WorkflowUsageStatistics["models"][number] & { runIds: Set<string> }
  >();
  const recentRuns = new Map<string, WorkflowUsageStatistics["recentRuns"][number]>();

  for (const entry of entries) {
    const scopedRunId = `${entry.workflowId}:${entry.runId}`;
    runIds.add(scopedRunId);
    totals.inputTokens += entry.inputTokens;
    totals.outputTokens += entry.outputTokens;
    totals.cacheReadTokens += entry.cacheReadTokens;
    totals.cacheWriteTokens += entry.cacheWriteTokens;
    totals.totalTokens += entry.totalTokens;
    totals.cost += entry.cost;

    const date = usageDateKey(entry.runStartedAt, timezoneOffsetMinutes);
    const day = daily.get(date) ?? {
      date,
      runs: 0,
      tokens: 0,
      cost: 0,
      runIds: new Set<string>(),
    };
    day.runIds.add(scopedRunId);
    day.runs = day.runIds.size;
    day.tokens += entry.totalTokens;
    day.cost += entry.cost;
    daily.set(date, day);

    const workflow = workflows.get(entry.workflowId) ?? {
      workflowId: entry.workflowId,
      title: entry.workflowTitle,
      runs: 0,
      tokens: 0,
      cost: 0,
      runIds: new Set<string>(),
    };
    workflow.title = entry.workflowTitle;
    workflow.runIds.add(scopedRunId);
    workflow.runs = workflow.runIds.size;
    workflow.tokens += entry.totalTokens;
    workflow.cost += entry.cost;
    workflows.set(entry.workflowId, workflow);

    if (entry.model) {
      const model = models.get(entry.model) ?? {
        model: entry.model,
        runs: 0,
        tokens: 0,
        cost: 0,
        runIds: new Set<string>(),
      };
      model.runIds.add(scopedRunId);
      model.runs = model.runIds.size;
      model.tokens += entry.totalTokens;
      model.cost += entry.cost;
      models.set(entry.model, model);
    }

    const recent = recentRuns.get(scopedRunId) ?? {
      workflowId: entry.workflowId,
      workflowTitle: entry.workflowTitle,
      runId: entry.runId,
      status: entry.runStatus,
      startedAt: entry.runStartedAt,
      completedAt: entry.runCompletedAt,
      tokens: 0,
      cost: 0,
    };
    recent.workflowTitle = entry.workflowTitle;
    recent.status = entry.runStatus;
    recent.completedAt = entry.runCompletedAt;
    recent.tokens += entry.totalTokens;
    recent.cost += entry.cost;
    recentRuns.set(scopedRunId, recent);
  }
  totals.runs = runIds.size;

  if (range !== "all") {
    const dayCount = range === "7d" ? 7 : 30;
    for (let index = 0; index < dayCount; index += 1) {
      const date = usageDateKey(startAt + index * 86_400_000, timezoneOffsetMinutes);
      if (!daily.has(date)) {
        daily.set(date, { date, runs: 0, tokens: 0, cost: 0, runIds: new Set<string>() });
      }
    }
  }

  return {
    generatedAt: stored.updatedAt,
    range,
    totals,
    daily: [...daily.values()]
      .map(({ runIds: _runIds, ...day }) => day)
      .sort((a, b) => a.date.localeCompare(b.date)),
    workflows: [...workflows.values()]
      .map(({ runIds: _runIds, ...workflow }) => workflow)
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.title.localeCompare(b.title)),
    models: [...models.values()]
      .map(({ runIds: _runIds, ...model }) => model)
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model)),
    recentRuns: [...recentRuns.values()].sort((a, b) => b.startedAt - a.startedAt).slice(0, 20),
  };
}

export async function getAllProjectsWorkflowUsage(
  projectPaths: string[],
  options: {
    range?: WorkflowUsageRange;
    timezoneOffsetMinutes?: number;
    now?: number;
  } = {},
): Promise<AllProjectsWorkflowUsage> {
  const statistics = await Promise.all(
    projectPaths.map((projectPath) => getWorkflowUsageStatistics(projectPath, options)),
  );
  const totals: WorkflowUsageTotals = {
    runs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    totalTokens: 0,
    cost: 0,
  };
  let generatedAt = 0;
  for (const usage of statistics) {
    generatedAt = Math.max(generatedAt, usage.generatedAt);
    totals.runs += usage.totals.runs;
    totals.inputTokens += usage.totals.inputTokens;
    totals.outputTokens += usage.totals.outputTokens;
    totals.cacheReadTokens += usage.totals.cacheReadTokens;
    totals.cacheWriteTokens += usage.totals.cacheWriteTokens;
    totals.totalTokens += usage.totals.totalTokens;
    totals.cost += usage.totals.cost;
  }
  return {
    generatedAt,
    range: options.range ?? "30d",
    projectCount: projectPaths.length,
    totals,
  };
}

export async function recordWorkflowUsageSnapshot(
  workspaceRoot: string,
  workflow: WorkflowRecord,
  run: WorkflowRun,
): Promise<void> {
  const usageFile = config.workflowUsageFile;
  const projectPath = await fs.realpath(workspaceRoot).catch(() => path.resolve(workspaceRoot));
  const candidates = (run.trace ?? []).map((trace) =>
    storedUsageEntry(projectPath, workflow, run, trace),
  );
  if (candidates.length === 0) return;

  const previous = workflowUsageWrite;
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const stored = await readStoredWorkflowUsage(usageFile);
      const entries = new Map(stored.entries.map((entry) => [entry.key, entry]));
      for (const candidate of candidates) {
        const existing = entries.get(candidate.key);
        entries.set(candidate.key, existing ? mergeUsageEntry(existing, candidate) : candidate);
      }
      for (const [key, entry] of entries) {
        if (
          openedProjectKey(entry.projectPath) === openedProjectKey(projectPath) &&
          entry.workflowId === workflow.id &&
          entry.runId === run.id
        ) {
          entries.set(key, {
            ...entry,
            workflowTitle: workflow.title,
            runStatus: run.status,
            runCompletedAt: run.completedAt,
          });
        }
      }
      await writeStoredWorkflowUsage(
        { version: 1, updatedAt: Date.now(), entries: [...entries.values()] },
        usageFile,
      );
    });
  workflowUsageWrite = current;
  await current;
}

function usageRangeStart(
  range: WorkflowUsageRange,
  now: number,
  timezoneOffsetMinutes: number,
): number {
  if (range === "all") return Number.NEGATIVE_INFINITY;
  const days = range === "7d" ? 7 : 30;
  const shifted = new Date(now - timezoneOffsetMinutes * 60_000);
  shifted.setUTCHours(0, 0, 0, 0);
  return shifted.getTime() + timezoneOffsetMinutes * 60_000 - (days - 1) * 86_400_000;
}

function usageDateKey(timestamp: number, timezoneOffsetMinutes: number): string {
  return new Date(timestamp - timezoneOffsetMinutes * 60_000).toISOString().slice(0, 10);
}

function finiteUsageNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function traceTotalTokens(trace: WorkflowRunTrace): number {
  return finiteUsageNumber(
    trace.tokens?.total ??
      (trace.tokens?.input !== undefined || trace.tokens?.output !== undefined
        ? finiteUsageNumber(trace.tokens.input) + finiteUsageNumber(trace.tokens.output)
        : 0),
  );
}

function storedUsageEntry(
  projectPath: string,
  workflow: WorkflowRecord,
  run: WorkflowRun,
  trace: WorkflowRunTrace,
): StoredWorkflowUsageEntry {
  return {
    key: JSON.stringify([
      openedProjectKey(projectPath),
      workflow.id,
      run.id,
      trace.nodeId,
      trace.startedAt,
    ]),
    projectPath,
    workflowId: workflow.id,
    workflowTitle: workflow.title,
    runId: run.id,
    runStatus: run.status,
    runStartedAt: run.startedAt,
    runCompletedAt: run.completedAt,
    traceStartedAt: trace.startedAt,
    model: trace.model?.trim() || undefined,
    inputTokens: finiteUsageNumber(trace.tokens?.input),
    outputTokens: finiteUsageNumber(trace.tokens?.output),
    cacheReadTokens: finiteUsageNumber(trace.tokens?.cacheRead),
    cacheWriteTokens: finiteUsageNumber(trace.tokens?.cacheWrite),
    totalTokens: traceTotalTokens(trace),
    cost: finiteUsageNumber(trace.cost),
  };
}

function mergeUsageEntry(
  existing: StoredWorkflowUsageEntry,
  next: StoredWorkflowUsageEntry,
): StoredWorkflowUsageEntry {
  return {
    ...existing,
    ...next,
    model: next.model ?? existing.model,
    runCompletedAt: next.runCompletedAt ?? existing.runCompletedAt,
    inputTokens: Math.max(existing.inputTokens, next.inputTokens),
    outputTokens: Math.max(existing.outputTokens, next.outputTokens),
    cacheReadTokens: Math.max(existing.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: Math.max(existing.cacheWriteTokens, next.cacheWriteTokens),
    totalTokens: Math.max(existing.totalTokens, next.totalTokens),
    cost: Math.max(existing.cost, next.cost),
  };
}

async function readStoredWorkflowUsage(
  usageFile = config.workflowUsageFile,
): Promise<StoredWorkflowUsage> {
  try {
    const parsed = JSON.parse(await fs.readFile(usageFile, "utf8")) as Partial<StoredWorkflowUsage>;
    const entries = Array.isArray(parsed.entries)
      ? parsed.entries.map(sanitizeStoredUsageEntry).filter((entry) => entry !== null)
      : [];
    return {
      version: 1,
      updatedAt: finiteTimestamp(parsed.updatedAt),
      entries,
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof SyntaxError) {
      return { version: 1, updatedAt: 0, entries: [] };
    }
    throw error;
  }
}

function sanitizeStoredUsageEntry(value: unknown): StoredWorkflowUsageEntry | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const entry = value as Partial<StoredWorkflowUsageEntry>;
  if (
    typeof entry.key !== "string" ||
    typeof entry.projectPath !== "string" ||
    !path.isAbsolute(entry.projectPath) ||
    typeof entry.workflowId !== "string" ||
    typeof entry.workflowTitle !== "string" ||
    typeof entry.runId !== "string" ||
    !isWorkflowRunStatus(entry.runStatus) ||
    !finiteTimestamp(entry.runStartedAt) ||
    !finiteTimestamp(entry.traceStartedAt)
  ) {
    return null;
  }
  return {
    key: entry.key,
    projectPath: path.resolve(entry.projectPath),
    workflowId: entry.workflowId,
    workflowTitle: entry.workflowTitle,
    runId: entry.runId,
    runStatus: entry.runStatus,
    runStartedAt: finiteTimestamp(entry.runStartedAt),
    runCompletedAt: finiteTimestamp(entry.runCompletedAt) || undefined,
    traceStartedAt: finiteTimestamp(entry.traceStartedAt),
    model: typeof entry.model === "string" && entry.model.trim() ? entry.model.trim() : undefined,
    inputTokens: finiteUsageNumber(entry.inputTokens),
    outputTokens: finiteUsageNumber(entry.outputTokens),
    cacheReadTokens: finiteUsageNumber(entry.cacheReadTokens),
    cacheWriteTokens: finiteUsageNumber(entry.cacheWriteTokens),
    totalTokens: finiteUsageNumber(entry.totalTokens),
    cost: finiteUsageNumber(entry.cost),
  };
}

async function writeStoredWorkflowUsage(
  usage: StoredWorkflowUsage,
  usageFile: string,
): Promise<void> {
  await fs.mkdir(path.dirname(usageFile), { recursive: true });
  const tempPath = `${usageFile}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, `${JSON.stringify(usage, null, 2)}\n`, "utf8");
  await fs.rename(tempPath, usageFile);
}

function finiteTimestamp(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}

function isWorkflowRunStatus(value: unknown): value is WorkflowRunStatus {
  return (
    value === "idle" ||
    value === "running" ||
    value === "success" ||
    value === "error" ||
    value === "stopped"
  );
}

function openedProjectKey(projectPath: string): string {
  const resolved = path.resolve(projectPath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

export async function findWorkflowByTemplateBinding(
  workspaceRoot: string,
  source: "system" | "user",
  templateId: string,
): Promise<WorkflowRecord | null> {
  await ensureWorkflowDir(workspaceRoot);
  const entries = await fs.readdir(workflowDir(workspaceRoot));
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    if (!WORKFLOW_ID_RE.test(id)) continue;
    try {
      const record = sanitize(
        JSON.parse(await fs.readFile(path.join(workflowDir(workspaceRoot), entry), "utf8")),
        id,
      );
      if (record.templateBinding?.source === source && record.templateBinding.id === templateId) {
        return record;
      }
    } catch {
      // Ignore unrelated invalid workflow files.
    }
  }
  return null;
}

export async function listWorkflowIdsByTemplateBinding(
  workspaceRoot: string,
  source: "system" | "user",
  templateId: string,
): Promise<string[]> {
  const ids: string[] = [];
  await ensureWorkflowDir(workspaceRoot);
  const entries = await fs.readdir(workflowDir(workspaceRoot));
  for (const entry of entries) {
    if (!entry.endsWith(".json")) continue;
    const id = entry.slice(0, -5);
    if (!WORKFLOW_ID_RE.test(id)) continue;
    try {
      const record = sanitize(
        JSON.parse(await fs.readFile(path.join(workflowDir(workspaceRoot), entry), "utf8")),
        id,
      );
      if (record.templateBinding?.source === source && record.templateBinding.id === templateId) {
        ids.push(record.id);
      }
    } catch {
      // Ignore unrelated invalid workflow files.
    }
  }
  return ids;
}

export async function getWorkflow(workspaceRoot: string, id: string): Promise<WorkflowRecord> {
  validateWorkflowId(id);
  let text: string;
  try {
    text = await fs.readFile(workflowFile(workspaceRoot, id), "utf-8");
  } catch {
    throw errors.notFound(`workflow not found: ${id}`);
  }
  try {
    return sanitize(JSON.parse(text), id);
  } catch {
    throw errors.ioError("workflow file parse failed");
  }
}

export async function createWorkflow(
  workspaceRoot: string,
  partial: Partial<WorkflowRecord>,
): Promise<WorkflowRecord> {
  await ensureWorkflowDir(workspaceRoot);
  const now = Date.now();
  const id = generateWorkflowId();
  const record = sanitize(
    {
      ...partial,
      id,
      createdAt: now,
      updatedAt: now,
      nodes: Array.isArray(partial.nodes) ? partial.nodes : defaultNodes(),
      edges: Array.isArray(partial.edges) ? partial.edges : [],
      runs: Array.isArray(partial.runs) ? partial.runs : [],
    },
    id,
  );
  await writeWorkflowFile(workspaceRoot, record);
  return record;
}

export async function saveWorkflow(
  workspaceRoot: string,
  record: WorkflowRecord,
): Promise<WorkflowRecord> {
  validateWorkflowId(record.id);
  await ensureWorkflowDir(workspaceRoot);
  const next = sanitize(record, record.id);
  next.updatedAt = Date.now();
  const abs = workflowFile(workspaceRoot, record.id);
  const previous = updateLocks.get(abs) ?? Promise.resolve();
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      await writeWorkflowFile(workspaceRoot, next);
    });
  updateLocks.set(abs, current);
  try {
    await current;
    return next;
  } finally {
    if (updateLocks.get(abs) === current) updateLocks.delete(abs);
  }
}

export async function updateWorkflow(
  workspaceRoot: string,
  id: string,
  updater: (record: WorkflowRecord) => WorkflowRecord | Promise<WorkflowRecord>,
): Promise<WorkflowRecord> {
  validateWorkflowId(id);
  const abs = workflowFile(workspaceRoot, id);
  const previous = updateLocks.get(abs) ?? Promise.resolve();
  let result: WorkflowRecord | undefined;
  const current = previous
    .catch(() => undefined)
    .then(async () => {
      const record = await getWorkflow(workspaceRoot, id);
      const updated = await updater(record);
      if (!updated || updated.id !== id) {
        throw errors.invalidPath("workflow id does not match URL");
      }
      const next = sanitize(updated, id);
      next.updatedAt = Date.now();
      await writeWorkflowFile(workspaceRoot, next);
      result = next;
    });
  updateLocks.set(abs, current);
  try {
    await current;
    return result!;
  } finally {
    if (updateLocks.get(abs) === current) updateLocks.delete(abs);
  }
}

export async function deleteWorkflow(workspaceRoot: string, id: string): Promise<void> {
  validateWorkflowId(id);
  try {
    await fs.unlink(workflowFile(workspaceRoot, id));
  } catch {
    throw errors.notFound(`workflow not found: ${id}`);
  }
}

async function writeWorkflowFile(workspaceRoot: string, record: WorkflowRecord): Promise<void> {
  const abs = workflowFile(workspaceRoot, record.id);
  const data = JSON.stringify(record, null, 2);
  const previous = writeLocks.get(abs) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(() => writeWorkflowFileLocked(abs, data));
  writeLocks.set(abs, next);
  try {
    await next;
  } finally {
    if (writeLocks.get(abs) === next) writeLocks.delete(abs);
  }
}

async function writeWorkflowFileLocked(abs: string, data: string): Promise<void> {
  const tmp = `${abs}.osheep.tmp.${process.pid}.${Date.now()}.${randomPart(6)}`;
  await fs.writeFile(tmp, data, "utf-8");
  try {
    await renameWithRetry(tmp, abs);
  } catch (e) {
    try {
      await fs.writeFile(abs, data, "utf-8");
      await fs.unlink(tmp).catch(() => undefined);
      return;
    } catch {
      await fs.unlink(tmp).catch(() => undefined);
      throw errors.ioError((e as Error).message);
    }
  }
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  for (let attempt = 0; attempt < 6; attempt += 1) {
    try {
      await fs.rename(from, to);
      return;
    } catch (e) {
      if (!isRetryableFsError(e) || attempt === 5) throw e;
      await delay(25 * (attempt + 1));
    }
  }
}

function isRetryableFsError(e: unknown): boolean {
  const code = (e as NodeJS.ErrnoException)?.code;
  return code === "EPERM" || code === "EBUSY" || code === "EACCES";
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
