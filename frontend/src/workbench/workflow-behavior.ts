import type {
  WorkflowEdge,
  WorkflowNode,
  WorkflowNodeKind,
  WorkflowRecord,
} from "./api";

export type WorkflowBlockOutput = Record<string, unknown>;

export const WORKFLOW_SESSION_ID_PATTERN =
  "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}";

const WORKFLOW_SESSION_ID_RE = new RegExp(`^${WORKFLOW_SESSION_ID_PATTERN}$`);

export function workflowSessionId(node: WorkflowNode): string {
  const value = node.config?.sessionId;
  return typeof value === "string" ? value.trim() : "";
}

export function isWorkflowSessionId(value: string): boolean {
  return WORKFLOW_SESSION_ID_RE.test(value.trim());
}

export function findWorkflowBackEdgeIds(edges: readonly WorkflowEdge[]): Set<string> {
  const forward = new Map<string, string[]>();
  const backEdgeIds = new Set<string>();

  for (const edge of edges) {
    if (edge.from === edge.to || canReach(edge.to, edge.from, forward)) {
      backEdgeIds.add(edge.id);
      continue;
    }
    const targets = forward.get(edge.from) ?? [];
    targets.push(edge.to);
    forward.set(edge.from, targets);
  }
  return backEdgeIds;
}

export function workflowLayoutDepths(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): Map<string, number> {
  const forwardEdges = workflowForwardEdges(nodes, edges);
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const indegree = new Map<string, number>();

  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
    indegree.set(node.id, 0);
  }
  for (const edge of forwardEdges) {
    incoming.get(edge.to)!.push(edge.from);
    outgoing.get(edge.from)!.push(edge.to);
    indegree.set(edge.to, indegree.get(edge.to)! + 1);
  }

  const queue = nodes
    .filter((node) => indegree.get(node.id) === 0)
    .map((node) => node.id);
  const depths = new Map<string, number>();
  while (queue.length > 0) {
    const id = queue.shift()!;
    const predecessors = incoming.get(id)!;
    depths.set(
      id,
      predecessors.length > 0
        ? Math.max(...predecessors.map((predecessor) => (depths.get(predecessor) ?? 0) + 1))
        : 0,
    );
    for (const target of outgoing.get(id)!) {
      const nextIndegree = indegree.get(target)! - 1;
      indegree.set(target, nextIndegree);
      if (nextIndegree === 0) queue.push(target);
    }
  }

  // Removing the feedback edges makes the graph acyclic. Keep malformed or
  // otherwise unresolved nodes visible in the first column as a final guard.
  for (const node of nodes) {
    if (!depths.has(node.id)) depths.set(node.id, 0);
  }
  return depths;
}

export function workflowLayoutColumns(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): string[][] {
  if (nodes.length === 0) return [];
  const depths = workflowLayoutDepths(nodes, edges);
  const maxDepth = Math.max(...depths.values());
  let columns = Array.from({ length: maxDepth + 1 }, () => [] as string[]);
  for (const node of nodes) columns[depths.get(node.id) ?? 0]!.push(node.id);

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  for (const node of nodes) {
    incoming.set(node.id, []);
    outgoing.set(node.id, []);
  }
  for (const edge of workflowForwardEdges(nodes, edges)) {
    incoming.get(edge.to)!.push(edge.from);
    outgoing.get(edge.from)!.push(edge.to);
  }

  // Alternating barycenter sweeps reduce avoidable crossings while keeping the
  // result deterministic for nodes with equal or missing neighbor positions.
  for (let pass = 0; pass < 4; pass += 1) {
    const before = JSON.stringify(columns);
    for (let depth = 1; depth < columns.length; depth += 1) {
      columns[depth] = sortLayoutColumn(columns[depth]!, incoming, columns);
    }
    for (let depth = columns.length - 2; depth >= 0; depth -= 1) {
      columns[depth] = sortLayoutColumn(columns[depth]!, outgoing, columns);
    }
    const after = JSON.stringify(columns);
    if (after === before) break;
  }
  return columns;
}

function workflowForwardEdges(
  nodes: readonly WorkflowNode[],
  edges: readonly WorkflowEdge[],
): WorkflowEdge[] {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const validEdges = edges.filter(
    (edge) => nodeIds.has(edge.from) && nodeIds.has(edge.to) && edge.from !== edge.to,
  );
  const backEdgeIds = findWorkflowBackEdgeIds(validEdges);
  return validEdges.filter((edge) => !backEdgeIds.has(edge.id));
}

function sortLayoutColumn(
  column: readonly string[],
  neighborsByNode: ReadonlyMap<string, string[]>,
  columns: readonly string[][],
): string[] {
  const currentRows = new Map(column.map((id, row) => [id, row]));
  const rows = new Map<string, number>();
  for (const ids of columns) {
    ids.forEach((id, row) => rows.set(id, row));
  }
  const barycenter = (id: string): number => {
    const neighborRows = (neighborsByNode.get(id) ?? [])
      .map((neighbor) => rows.get(neighbor))
      .filter((row): row is number => row !== undefined);
    if (neighborRows.length === 0) return currentRows.get(id) ?? 0;
    return neighborRows.reduce((sum, row) => sum + row, 0) / neighborRows.length;
  };
  return [...column].sort((left, right) => {
    const difference = barycenter(left) - barycenter(right);
    return difference || currentRows.get(left)! - currentRows.get(right)!;
  });
}

function canReach(from: string, target: string, adjacency: ReadonlyMap<string, string[]>): boolean {
  const pending = [from];
  const seen = new Set<string>();
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (current === target) return true;
    if (seen.has(current)) continue;
    seen.add(current);
    pending.push(...(adjacency.get(current) ?? []));
  }
  return false;
}

export function formatWorkflowDuration(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h${minutes}m${seconds}s`;
}

export function formatCompactTokenCount(count: number, language = "en"): string {
  const absolute = Math.abs(count);
  if (absolute < 1_000) return count.toLocaleString(language);
  let value = count;
  let unit = "";
  for (const candidate of ["k", "m", "b"]) {
    if (Math.abs(value) < 1_000) break;
    value /= 1_000;
    unit = candidate;
  }
  const digits = Math.abs(value) >= 100 ? 0 : Math.abs(value) >= 10 ? 1 : 2;
  return `${value.toFixed(digits).replace(/\.0+$|(?<=\.\d)0+$/g, "")}${unit}`;
}

function blockId(node: WorkflowNode): number | null {
  return typeof node.blockId === "number" && Number.isInteger(node.blockId) && node.blockId > 0
    ? node.blockId
    : null;
}

function configString(node: WorkflowNode, key: string, fallback = ""): string {
  const value = node.config?.[key];
  return typeof value === "string" ? value : fallback;
}

function configNumber(node: WorkflowNode, key: string, fallback: number): number {
  const value = Number(node.config?.[key]);
  return Number.isFinite(value) ? value : fallback;
}

function configuredVariables(
  node: WorkflowNode,
): Array<{ name: string; value: string; type: string }> {
  const variables = node.config?.variables;
  if (Array.isArray(variables)) {
    return variables.map((entry) => {
      const item = entry && typeof entry === "object" ? (entry as Record<string, unknown>) : {};
      return {
        name: typeof item.name === "string" ? item.name : "",
        value: typeof item.value === "string" ? item.value : "",
        type: typeof item.type === "string" ? item.type : "auto",
      };
    });
  }
  return [
    {
      name: configString(node, "name"),
      value: configString(node, "value"),
      type: "auto",
    },
  ];
}

export function emptyBlockOutput(node: WorkflowNode): WorkflowBlockOutput {
  const kind: WorkflowNodeKind = node.kind ?? "agent";
  switch (kind) {
    case "input":
      return {
        type: kind,
        status: "",
        value: "",
        data: "",
        text: "",
      };
    case "variable": {
      const variables = Object.fromEntries(
        configuredVariables(node)
          .filter((entry) => entry.name.trim())
          .map((entry) => [entry.name.trim(), ""]),
      );
      const variableTypes = Object.fromEntries(
        configuredVariables(node)
          .filter((entry) => entry.name.trim())
          .map((entry) => [entry.name.trim(), entry.type]),
      );
      return {
        type: kind,
        status: "",
        name: configuredVariables(node)[0]?.name ?? "",
        value: "",
        variables,
        variableTypes,
        data: variables,
        text: "",
      };
    }
    case "agent":
      return {
        type: node.providerKind === "claude-cli" ? "claude" : "codex",
        status: "",
        text: "",
      };
    case "trigger":
    case "manual-trigger":
      return { type: kind, status: "", id: blockId(node), text: "" };
    case "cron":
      return {
        type: kind,
        status: "",
        id: blockId(node),
        schedule: configString(node, "cron"),
        text: "",
      };
    case "webhook-trigger":
      return {
        type: kind,
        status: "",
        id: blockId(node),
        webhookPath: configString(node, "path"),
        text: "",
      };
    case "command":
      return {
        type: kind,
        status: "",
        command: "",
        shell: "",
        exitCode: null,
        signal: null,
        stdout: "",
        stderr: "",
        truncated: null,
      };
    case "web":
      return {
        type: kind,
        status: "",
        url: "",
        text: "",
        stderr: "",
        exitCode: null,
        truncated: null,
      };
    case "http-request":
      return {
        type: kind,
        status: "",
        ok: null,
        method: configString(node, "method", "GET").toUpperCase(),
        requestedUrl: "",
        statusCode: null,
        statusText: "",
        url: "",
        headers: {},
        body: null,
        text: "",
        truncated: null,
      };
    case "set":
      return { type: kind, status: "", data: null, text: "" };
    case "if":
      return {
        type: kind,
        status: "",
        result: null,
        operator: configString(node, "operator", "equals"),
        left: null,
        right: null,
        text: "",
      };
    case "diff-approval":
      return { type: kind, status: "", approved: null, diff: "", text: "" };
    case "git-commit":
      return { type: kind, status: "", head: "", message: "", text: "" };
    case "git-checkout":
      return { type: kind, status: "", branch: "", created: false, text: "" };
    case "git-delete-branch":
      return { type: kind, status: "", branch: "", remote: null, force: false, text: "" };
    case "github-pr":
      return { type: kind, status: "", url: "", number: null, text: "" };
    case "merge": {
      const mode = configString(node, "mode", "object") === "array" ? "array" : "object";
      return {
        type: kind,
        status: "",
        mode,
        data: mode === "array" ? [] : {},
        items: [],
        text: "",
      };
    }
    case "code":
      return { type: kind, status: "", data: null, text: "" };
    case "loop-items": {
      const mode = configString(node, "mode", "items") === "batches" ? "batches" : "items";
      return {
        type: kind,
        status: "",
        mode,
        batchSize: configNumber(node, "batchSize", 1),
        items: [],
        batches: [],
        data: [],
        count: null,
        text: "",
      };
    }
    case "wait":
      return {
        type: kind,
        status: "",
        seconds: configNumber(node, "seconds", 1),
        durationMs: null,
        text: "",
      };
    case "json":
      return {
        type: kind,
        status: "",
        path: configString(node, "path"),
        source: null,
        value: null,
        data: null,
        text: "",
      };
    case "file-read":
      return {
        type: kind,
        status: "",
        path: "",
        content: "",
        size: null,
        mtime: null,
      };
    case "file-write":
      return {
        type: kind,
        status: "",
        path: "",
        bytes: null,
        content: "",
      };
    case "markdown":
      return { type: kind, status: "", markdown: "", text: "" };
    case "mcp":
      return {
        type: kind,
        status: "",
        remoteLink: "",
        postUrl: "",
        tool: "",
        arguments: {},
        result: {},
        error: {},
        response: {},
        text: "",
      };
    case "codex-plugin":
    case "claude-plugin":
      return {
        type: kind,
        status: "",
        selected: [],
        enabled: [],
        text: "",
      };
  }
}

export function blockOutputText(node: WorkflowNode): string {
  const output = node.rawOutput || node.summary;
  if (output) {
    try {
      const parsed = JSON.parse(output) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const sanitized = { ...(parsed as Record<string, unknown>) };
        delete sanitized.CHANGED_FILES;
        delete sanitized.VERIFICATION;
        return JSON.stringify(sanitized, null, 2);
      }
    } catch {
      return output;
    }
  }
  return node.error || JSON.stringify(emptyBlockOutput(node), null, 2);
}

interface WorkflowRefreshState {
  requestedRevision: number;
  currentRevision: number;
  dragging: boolean;
  pendingSave: boolean;
}

export function canApplyWorkflowRefresh(state: WorkflowRefreshState): boolean {
  return state.requestedRevision === state.currentRevision && !state.dragging && !state.pendingSave;
}

export function withWorkflowTitle(record: WorkflowRecord, title: string): WorkflowRecord {
  return record.title === title ? record : { ...record, title };
}

export function findMarkdownAutoPreviewNode(
  previous: WorkflowNode[] | undefined,
  next: WorkflowNode[],
  seen: ReadonlySet<string>,
  runStartedAt: number,
): WorkflowNode | undefined {
  return next.find((node) => {
    if (
      node.kind !== "markdown" ||
      node.status !== "success" ||
      node.config?.autoSeeResult !== true
    ) {
      return false;
    }
    if (seen.has(`${node.id}:${node.completedAt ?? 0}`)) return false;
    return (
      previous?.find((item) => item.id === node.id)?.status === "running" ||
      (runStartedAt > 0 && (node.completedAt ?? 0) >= runStartedAt)
    );
  });
}
