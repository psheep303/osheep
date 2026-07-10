import type { WorkflowNode, WorkflowNodeKind } from "./api";

export type WorkflowBlockOutput = Record<string, unknown>;

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
    case "agent":
      return {
        type: node.providerKind === "claude-cli" ? "claude" : "codex",
        status: "",
        text: "",
        CHANGED_FILES: [],
        VERIFICATION: [],
      };
    case "trigger":
    case "manual-trigger":
      return { type: kind, status: "", id: blockId(node), text: "", CHANGED_FILES: [] };
    case "cron":
      return {
        type: kind,
        status: "",
        id: blockId(node),
        schedule: configString(node, "cron"),
        text: "",
        CHANGED_FILES: [],
      };
    case "webhook-trigger":
      return {
        type: kind,
        status: "",
        id: blockId(node),
        webhookPath: configString(node, "path"),
        text: "",
        CHANGED_FILES: [],
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
        CHANGED_FILES: [],
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
        CHANGED_FILES: [],
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
        CHANGED_FILES: [],
      };
    case "set":
      return { type: kind, status: "", data: null, text: "", CHANGED_FILES: [] };
    case "if":
      return {
        type: kind,
        status: "",
        result: null,
        operator: configString(node, "operator", "equals"),
        left: null,
        right: null,
        text: "",
        CHANGED_FILES: [],
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
        CHANGED_FILES: [],
      };
    }
    case "code":
      return { type: kind, status: "", data: null, text: "", CHANGED_FILES: [] };
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
        CHANGED_FILES: [],
      };
    }
    case "wait":
      return {
        type: kind,
        status: "",
        seconds: configNumber(node, "seconds", 1),
        durationMs: null,
        text: "",
        CHANGED_FILES: [],
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
        CHANGED_FILES: [],
      };
    case "file-read":
      return {
        type: kind,
        status: "",
        path: "",
        content: "",
        size: null,
        mtime: null,
        CHANGED_FILES: [],
      };
    case "file-write":
      return {
        type: kind,
        status: "",
        path: "",
        bytes: null,
        content: "",
        CHANGED_FILES: [],
      };
    case "markdown":
      return { type: kind, status: "", markdown: "", text: "", CHANGED_FILES: [] };
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
        CHANGED_FILES: [],
      };
  }
}

export function blockOutputText(node: WorkflowNode): string {
  return (
    node.rawOutput ||
    node.summary ||
    node.error ||
    JSON.stringify(emptyBlockOutput(node), null, 2)
  );
}
