import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errors } from "./errors.js";
import { calculateModelCost, type ModelPriceRecord } from "./model-pricing.js";

const WORKFLOW_ID_RE = /^wf_[a-z0-9]{8,32}$/;
const NODE_ID_RE = /^node_[a-z0-9]{6,32}$/;
const EDGE_ID_RE = /^edge_[a-z0-9]{6,32}$/;
const writeLocks = new Map<string, Promise<void>>();
const updateLocks = new Map<string, Promise<void>>();

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
    providerKind: asProviderKind(r.providerKind),
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
    prices?: ModelPriceRecord[];
  } = {},
): Promise<WorkflowUsageStatistics> {
  const range = options.range ?? "30d";
  const now = options.now ?? Date.now();
  const timezoneOffsetMinutes = Number.isFinite(options.timezoneOffsetMinutes)
    ? Math.max(-840, Math.min(840, options.timezoneOffsetMinutes!))
    : 0;
  const startAt = usageRangeStart(range, now, timezoneOffsetMinutes);
  const summaries = await listWorkflows(workspaceRoot);
  const records = await Promise.all(
    summaries.map((summary) => getWorkflow(workspaceRoot, summary.id).catch(() => null)),
  );
  const generatedAt = records.reduce(
    (latest, record) => Math.max(latest, record?.updatedAt ?? 0),
    0,
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
  const daily = new Map<string, WorkflowUsageStatistics["daily"][number]>();
  const workflows = new Map<string, WorkflowUsageStatistics["workflows"][number]>();
  const models = new Map<
    string,
    WorkflowUsageStatistics["models"][number] & { runIds: Set<string> }
  >();
  const recentRuns: WorkflowUsageStatistics["recentRuns"] = [];

  for (const record of records) {
    if (!record) continue;
    for (const run of record.runs) {
      if (run.startedAt < startAt || run.startedAt > now) continue;
      const usage = workflowRunUsage(run, record, options.prices ?? []);
      totals.runs += 1;
      totals.inputTokens += usage.inputTokens;
      totals.outputTokens += usage.outputTokens;
      totals.cacheReadTokens += usage.cacheReadTokens;
      totals.cacheWriteTokens += usage.cacheWriteTokens;
      totals.totalTokens += usage.totalTokens;
      totals.cost += usage.cost;

      const date = usageDateKey(run.startedAt, timezoneOffsetMinutes);
      const day = daily.get(date) ?? { date, runs: 0, tokens: 0, cost: 0 };
      day.runs += 1;
      day.tokens += usage.totalTokens;
      day.cost += usage.cost;
      daily.set(date, day);

      const workflow = workflows.get(record.id) ?? {
        workflowId: record.id,
        title: record.title,
        runs: 0,
        tokens: 0,
        cost: 0,
      };
      workflow.runs += 1;
      workflow.tokens += usage.totalTokens;
      workflow.cost += usage.cost;
      workflows.set(record.id, workflow);

      for (const trace of run.trace ?? []) {
        const modelName = trace.model?.trim();
        if (!modelName) continue;
        const model = models.get(modelName) ?? {
          model: modelName,
          runs: 0,
          tokens: 0,
          cost: 0,
          runIds: new Set<string>(),
        };
        const scopedRunId = `${record.id}:${run.id}`;
        if (!model.runIds.has(scopedRunId)) {
          model.runIds.add(scopedRunId);
          model.runs += 1;
        }
        model.tokens += traceTotalTokens(trace);
        model.cost += workflowTraceCost(trace, record, options.prices ?? []);
        models.set(modelName, model);
      }

      recentRuns.push({
        workflowId: record.id,
        workflowTitle: record.title,
        runId: run.id,
        status: run.status,
        startedAt: run.startedAt,
        completedAt: run.completedAt,
        tokens: usage.totalTokens,
        cost: usage.cost,
      });
    }
  }

  if (range !== "all") {
    const dayCount = range === "7d" ? 7 : 30;
    for (let index = 0; index < dayCount; index += 1) {
      const date = usageDateKey(startAt + index * 86_400_000, timezoneOffsetMinutes);
      if (!daily.has(date)) daily.set(date, { date, runs: 0, tokens: 0, cost: 0 });
    }
  }

  return {
    generatedAt,
    range,
    totals,
    daily: [...daily.values()].sort((a, b) => a.date.localeCompare(b.date)),
    workflows: [...workflows.values()].sort(
      (a, b) => b.cost - a.cost || b.tokens - a.tokens || a.title.localeCompare(b.title),
    ),
    models: [...models.values()]
      .map(({ runIds: _runIds, ...model }) => model)
      .sort((a, b) => b.cost - a.cost || b.tokens - a.tokens || a.model.localeCompare(b.model)),
    recentRuns: recentRuns.sort((a, b) => b.startedAt - a.startedAt).slice(0, 20),
  };
}

export async function getAllProjectsWorkflowUsage(
  projectPaths: string[],
  options: {
    range?: WorkflowUsageRange;
    timezoneOffsetMinutes?: number;
    now?: number;
    prices?: ModelPriceRecord[];
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

function workflowTraceCost(
  trace: WorkflowRunTrace,
  workflow: WorkflowRecord,
  prices: ModelPriceRecord[],
): number {
  const storedCost = finiteUsageNumber(trace.cost);
  if (storedCost > 0 || trace.cost === 0) return storedCost;
  const model = trace.model?.trim();
  if (!model) return 0;
  const node = workflow.nodes.find((item) => item.id === trace.nodeId);
  const calculated = calculateModelCost(model, trace.tokens, prices, {
    inputIncludesCache: node?.providerKind !== "claude-cli",
  });
  const multiplier = finiteUsageNumber(trace.billingMultiplier) || 1;
  return finiteUsageNumber(calculated) * multiplier;
}

function workflowRunUsage(
  run: WorkflowRun,
  workflow: WorkflowRecord,
  prices: ModelPriceRecord[],
): Omit<WorkflowUsageStatistics["totals"], "runs"> {
  const trace = run.trace ?? [];
  const traceUsage = {
    inputTokens: trace.reduce((sum, item) => sum + finiteUsageNumber(item.tokens?.input), 0),
    outputTokens: trace.reduce((sum, item) => sum + finiteUsageNumber(item.tokens?.output), 0),
    cacheReadTokens: trace.reduce(
      (sum, item) => sum + finiteUsageNumber(item.tokens?.cacheRead),
      0,
    ),
    cacheWriteTokens: trace.reduce(
      (sum, item) => sum + finiteUsageNumber(item.tokens?.cacheWrite),
      0,
    ),
    totalTokens: trace.reduce((sum, item) => sum + traceTotalTokens(item), 0),
    cost: trace.reduce((sum, item) => sum + workflowTraceCost(item, workflow, prices), 0),
  };
  return {
    inputTokens: finiteUsageNumber(run.stats?.inputTokens) || traceUsage.inputTokens,
    outputTokens: finiteUsageNumber(run.stats?.outputTokens) || traceUsage.outputTokens,
    cacheReadTokens: finiteUsageNumber(run.stats?.cacheReadTokens) || traceUsage.cacheReadTokens,
    cacheWriteTokens: finiteUsageNumber(run.stats?.cacheWriteTokens) || traceUsage.cacheWriteTokens,
    totalTokens: finiteUsageNumber(run.stats?.totalTokens) || traceUsage.totalTokens,
    cost: finiteUsageNumber(run.stats?.cost) || traceUsage.cost,
  };
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
