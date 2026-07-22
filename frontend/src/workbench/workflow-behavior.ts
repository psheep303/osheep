import type { WorkflowNode, WorkflowNodeKind } from "./api";

export type WorkflowBlockOutput = Record<string, unknown>;

export function formatWorkflowDuration(ms: number): string {
  const safeMs = Number.isFinite(ms) ? Math.max(0, ms) : 0;
  const totalSeconds = Math.floor(safeMs / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  return `${hours}h${minutes}m${seconds}s`;
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
  return (
    state.requestedRevision === state.currentRevision &&
    !state.dragging &&
    !state.pendingSave
  );
}
