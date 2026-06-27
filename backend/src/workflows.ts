import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errors } from "./errors.js";

const WORKFLOW_ID_RE = /^wf_[a-z0-9]{8,32}$/;
const NODE_ID_RE = /^node_[a-z0-9]{6,32}$/;
const EDGE_ID_RE = /^edge_[a-z0-9]{6,32}$/;
const writeLocks = new Map<string, Promise<void>>();

export type WorkflowProviderKind = "codex-cli" | "claude-cli";
export type WorkflowNodeKind =
  | "agent"
  | "trigger"
  | "manual-trigger"
  | "cron"
  | "webhook-trigger"
  | "command"
  | "web"
  | "http-request"
  | "set"
  | "if"
  | "merge"
  | "code"
  | "loop-items"
  | "wait"
  | "json"
  | "file-read"
  | "file-write"
  | "markdown"
  | "mcp";
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
}

export interface WorkflowRun {
  id: string;
  status: WorkflowRunStatus;
  startedAt: number;
  completedAt?: number;
  nodeIds: string[];
  error?: string;
}

export interface WorkflowRecord {
  id: string;
  title: string;
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
    value === "trigger" ||
    value === "manual-trigger" ||
    value === "cron" ||
    value === "webhook-trigger" ||
    value === "command" ||
    value === "web" ||
    value === "http-request" ||
    value === "set" ||
    value === "if" ||
    value === "merge" ||
    value === "code" ||
    value === "loop-items" ||
    value === "wait" ||
    value === "json" ||
    value === "file-read" ||
    value === "file-write" ||
    value === "markdown" ||
    value === "mcp"
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
  if (
    value === "running" ||
    value === "success" ||
    value === "error" ||
    value === "stopped"
  ) {
    return value;
  }
  return "idle";
}

function asFiniteNumber(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function asPositiveInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : undefined;
}

function sanitizeNode(raw: unknown, index: number): WorkflowNode | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WorkflowNode>;
  const id =
    typeof r.id === "string" && NODE_ID_RE.test(r.id)
      ? r.id
      : generateWorkflowNodeId();
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
    model: typeof r.model === "string" && r.model ? r.model : "default",
    prompt: typeof r.prompt === "string" ? r.prompt : "",
    x: asFiniteNumber(r.x, 80 + index * 340),
    y: asFiniteNumber(r.y, 90),
    status: asStatus(r.status),
  };
  if (typeof r.summary === "string") node.summary = r.summary;
  if (typeof r.rawOutput === "string") node.rawOutput = r.rawOutput;
  if (typeof r.error === "string") node.error = r.error;
  if (r.config && typeof r.config === "object" && !Array.isArray(r.config)) {
    node.config = r.config as Record<string, unknown>;
  }
  if (typeof r.startedAt === "number") node.startedAt = r.startedAt;
  if (typeof r.completedAt === "number") node.completedAt = r.completedAt;
  return node;
}

function sanitizeEdge(raw: unknown, nodeIds: Set<string>): WorkflowEdge | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Partial<WorkflowEdge>;
  if (typeof r.from !== "string" || typeof r.to !== "string") return null;
  if (!nodeIds.has(r.from) || !nodeIds.has(r.to) || r.from === r.to) return null;
  const id =
    typeof r.id === "string" && EDGE_ID_RE.test(r.id)
      ? r.id
      : generateWorkflowEdgeId();
  return {
    id,
    from: r.from,
    to: r.to,
    passSummary: r.passSummary !== false,
  };
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
  const id =
    typeof r.id === "string" && WORKFLOW_ID_RE.test(r.id) ? r.id : fallbackId;
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
  return {
    id,
    title:
      typeof r.title === "string" && r.title.trim() ? r.title : "New workflow",
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

export async function listWorkflows(
  workspaceRoot: string
): Promise<WorkflowSummary[]> {
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

export async function getWorkflow(
  workspaceRoot: string,
  id: string
): Promise<WorkflowRecord> {
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
  partial: Partial<WorkflowRecord>
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
    id
  );
  await writeWorkflowFile(workspaceRoot, record);
  return record;
}

export async function saveWorkflow(
  workspaceRoot: string,
  record: WorkflowRecord
): Promise<WorkflowRecord> {
  validateWorkflowId(record.id);
  await ensureWorkflowDir(workspaceRoot);
  const next = sanitize(record, record.id);
  next.updatedAt = Date.now();
  await writeWorkflowFile(workspaceRoot, next);
  return next;
}

export async function updateWorkflow(
  workspaceRoot: string,
  id: string,
  updater: (record: WorkflowRecord) => WorkflowRecord | Promise<WorkflowRecord>
): Promise<WorkflowRecord> {
  validateWorkflowId(id);
  const current = await getWorkflow(workspaceRoot, id);
  const updated = await updater(current);
  if (!updated || updated.id !== id) {
    throw errors.invalidPath("workflow id does not match URL");
  }
  return await saveWorkflow(workspaceRoot, updated);
}

export async function deleteWorkflow(
  workspaceRoot: string,
  id: string
): Promise<void> {
  validateWorkflowId(id);
  try {
    await fs.unlink(workflowFile(workspaceRoot, id));
  } catch {
    throw errors.notFound(`workflow not found: ${id}`);
  }
}

async function writeWorkflowFile(
  workspaceRoot: string,
  record: WorkflowRecord
): Promise<void> {
  const abs = workflowFile(workspaceRoot, record.id);
  const data = JSON.stringify(record, null, 2);
  const previous = writeLocks.get(abs) ?? Promise.resolve();
  const next = previous
    .catch(() => undefined)
    .then(() => writeWorkflowFileLocked(abs, data));
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
