import { execRun } from "./ai-exec.js";
import {
  buildAgentTerminalCommand,
  runAgentTerminal,
  type AgentEffort,
  type AgentMode,
  type AgentTerminalFrame,
  type ClaudePermissionMode,
  type CodexApproval,
  type CodexSandbox,
} from "./ai-terminal.js";
import { callRemoteMcp, discoverRemoteMcp, type RemoteMcpTool } from "./remote-mcp.js";
import { readFileText, writeFileText } from "./fs-ops.js";
import { resolveWorkspace, type WorkspaceInfo } from "./workspace.js";
import {
  getWorkflow,
  updateWorkflow,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowRecord,
  type WorkflowRun,
} from "./workflows.js";

type WorkflowBlockOutput = Record<string, unknown>;

interface LocalNodeResult {
  output: WorkflowBlockOutput;
  changedFiles?: boolean;
  error?: string;
  nodePatch?: Partial<WorkflowNode>;
}

interface McpNodeConfig {
  remoteLink: string;
  postUrl: string;
  headers: string;
  apiKey: string;
  toolName: string;
  arguments: string;
  tools: RemoteMcpTool[];
}

interface McpRuntimeTool {
  node: WorkflowNode;
  config: McpNodeConfig;
  tool: RemoteMcpTool;
}

interface WorkflowRunState {
  workspaceId: string;
  workflowId: string;
  runId: string;
  abort: AbortController;
}

export interface WorkflowRunDetailSnapshot {
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
  terminalStatus?: string;
  autoSuccess?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
}

interface LiveAgentRunDetailsOptions {
  node: WorkflowNode;
  startedAt: number;
  autoSuccess: boolean;
  writeSnapshot: (snapshot: WorkflowRunDetailSnapshot) => Promise<void>;
  logs?: Array<{ stream: "stdout" | "stderr"; content: string }>;
  minUpdateIntervalMs?: number;
}

export interface LiveAgentRunDetails {
  handleFrame: (frame: AgentTerminalFrame) => Promise<void>;
  update: (
    status: WorkflowRunDetailSnapshot["status"],
    completedAt?: number,
    force?: boolean
  ) => Promise<void>;
  snapshot: (
    status: WorkflowRunDetailSnapshot["status"],
    completedAt?: number
  ) => WorkflowRunDetailSnapshot;
  drain: () => Promise<void>;
}

export interface AgentTerminalFailure {
  retryable: boolean;
  hasModelOutput: boolean;
  message: string;
  modelOutput: string;
}

const activeRuns = new Map<string, WorkflowRunState>();
const CONFIGURED_LOCAL_KINDS = new Set<WorkflowNodeKind>([
  "http-request",
  "set",
  "if",
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
]);

const DEFAULT_MCP_HEADERS_JSON = JSON.stringify(
  {
    "MCP-Protocol-Version": "2025-03-26",
  },
  null,
  2
);

export function createLiveAgentRunDetails(
  options: LiveAgentRunDetailsOptions
): LiveAgentRunDetails {
  const logs = options.logs ?? [];
  const minUpdateIntervalMs = Math.max(0, options.minUpdateIntervalMs ?? 250);
  let terminalSessionId = "";
  let terminalStatus = "";
  let lastUpdateAt = 0;
  let queue = Promise.resolve();

  const snapshot = (
    status: WorkflowRunDetailSnapshot["status"],
    completedAt?: number
  ) =>
    agentRunSnapshot(
      options.node,
      status,
      options.startedAt,
      completedAt,
      logs,
      terminalSessionId || undefined,
      terminalStatus || undefined,
      options.autoSuccess
    );

  const enqueue = (next: WorkflowRunDetailSnapshot) => {
    queue = queue.then(() => options.writeSnapshot(next));
    return queue;
  };

  const update = (
    status: WorkflowRunDetailSnapshot["status"],
    completedAt?: number,
    force = true
  ) => {
    const now = Date.now();
    if (!force && minUpdateIntervalMs > 0 && now - lastUpdateAt < minUpdateIntervalMs) {
      return queue;
    }
    lastUpdateAt = now;
    return enqueue(snapshot(status, completedAt));
  };

  const handleFrame = (frame: AgentTerminalFrame) => {
    if (frame.type === "session") {
      terminalSessionId = frame.sessionId;
      return update("running");
    }
    if (frame.type === "output") {
      logs.push({ stream: "stdout", content: frame.data });
      return update("running", undefined, false);
    }
    if (frame.type === "status") {
      terminalStatus = frame.status;
      return update("running");
    }
    return queue;
  };

  return {
    handleFrame,
    update,
    snapshot,
    drain: () => queue,
  };
}

export function classifyAgentTerminalFailure(
  raw: string,
  prompt: string
): AgentTerminalFailure {
  const text = stripAnsi(raw).replace(/\r/g, "\n");
  const match = text.match(
    /\b(?:unexpected status\s+(?:408|429|5\d\d)\b[^\n]*|(?:service unavailable|auth_unavailable|rate limit|temporarily unavailable|overloaded|econnreset|etimedout)[^\n]*)/i
  );
  if (!match || match.index === undefined) {
    return { retryable: false, hasModelOutput: false, message: "", modelOutput: "" };
  }
  const modelOutput = terminalModelOutputBeforeError(text.slice(0, match.index), prompt);
  return {
    retryable: true,
    hasModelOutput: modelOutput.length > 0,
    message: match[0].trim(),
    modelOutput,
  };
}

export function nextAgentRetryPrompt(
  originalPrompt: string,
  failure: AgentTerminalFailure
): string {
  void originalPrompt;
  void failure;
  return "继续";
}

export async function startWorkflowRun(
  workspaceId: string,
  workflowId: string,
  requestedNodeIds?: string[]
): Promise<{ runId: string; workflow: WorkflowRecord }> {
  const key = runKey(workspaceId, workflowId);
  if (activeRuns.has(key)) throw new Error("Workflow is already running.");
  const workspace = await resolveWorkspace(workspaceId);
  let record = await getWorkflow(workspace.path, workflowId);
  const plan = requestedNodeIds?.length
    ? { nodeIds: requestedNodeIds }
    : planWorkflowRunNodeIds(record);
  if (plan.error) throw new Error(plan.error);
  const ordered = plan.nodeIds;
  if (ordered.length === 0) throw new Error("Workflow has no runnable blocks.");

  const run: WorkflowRun = {
    id: makeId("run"),
    status: "running",
    startedAt: Date.now(),
    nodeIds: ordered,
  };
  const resetIds = new Set(
    requestedNodeIds?.length ? ordered : record.nodes.map((node) => node.id)
  );
  record = await updateWorkflow(workspace.path, workflowId, (current) => ({
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
        : node
    ),
    runs: [...current.runs.slice(-49), run],
  }));

  const abort = new AbortController();
  activeRuns.set(key, { workspaceId, workflowId, runId: run.id, abort });
  void runWorkflowInBackground(workspace, workflowId, run, ordered, abort).finally(
    () => {
      const state = activeRuns.get(key);
      if (state?.runId === run.id) activeRuns.delete(key);
    }
  );
  return { runId: run.id, workflow: record };
}

export function stopWorkflowRun(workspaceId: string, workflowId: string): boolean {
  const state = activeRuns.get(runKey(workspaceId, workflowId));
  if (!state) return false;
  state.abort.abort();
  return true;
}

export function isWorkflowRunActive(workspaceId: string, workflowId: string): boolean {
  return activeRuns.has(runKey(workspaceId, workflowId));
}

async function runWorkflowInBackground(
  workspace: WorkspaceInfo,
  workflowId: string,
  run: WorkflowRun,
  nodeIds: string[],
  abort: AbortController
): Promise<void> {
  try {
    for (const nodeId of nodeIds) {
      if (abort.signal.aborted) throw new Error("Stopped");
      let record = await getWorkflow(workspace.path, workflowId);
      const node = record.nodes.find((item) => item.id === nodeId);
      if (!node) continue;
      const startedAt = Date.now();
      const kind = nodeKind(node);

      if (isTriggerKind(kind)) {
        const output = triggerOutput(node, kind);
        const outputText = stringifyBlockOutput(output);
        await patchWorkflowNode(workspace.path, workflowId, nodeId, {
          status: "success",
          rawOutput: outputText,
          summary: outputText,
          error: "",
          startedAt,
          completedAt: Date.now(),
        });
        continue;
      }

      await patchWorkflowNode(workspace.path, workflowId, nodeId, {
        status: "running",
        rawOutput: "",
        summary: "",
        error: "",
        startedAt,
        completedAt: undefined,
      });

      record = await getWorkflow(workspace.path, workflowId);
      const currentNode = record.nodes.find((item) => item.id === nodeId) ?? node;
      const result =
        kind === "agent"
          ? await executeAgentNode(workspace, record, currentNode, startedAt, abort)
          : kind === "command"
            ? await executeCommandNode(workspace.path, record, currentNode, startedAt, abort)
            : await executeLocalNode(workspace.path, record, currentNode, {
                allowMcpToolCall: nodeIds.length === 1,
                signal: abort.signal,
              });
      const outputText = stringifyBlockOutput(result.output);
      await patchWorkflowNode(workspace.path, workflowId, nodeId, {
        ...(result.nodePatch ?? {}),
        status: result.error ? "error" : "success",
        rawOutput: outputText,
        summary: outputText,
        error: result.error ?? "",
        completedAt: Date.now(),
      });
      if (result.error) throw new Error(result.error);
    }
    await finishRun(workspace.path, workflowId, run.id, "success");
  } catch (e) {
    const message = (e as Error).message || "Workflow failed.";
    const stopped = abort.signal.aborted || message === "Stopped";
    await updateWorkflow(workspace.path, workflowId, (record) => {
      const activeNode = record.nodes.find((node) => node.status === "running");
      const nodes = activeNode
        ? record.nodes.map((node) =>
            node.id === activeNode.id
              ? {
                  ...node,
                  status: "error" as const,
                  error: message,
                  completedAt: Date.now(),
                  config: finalizeRunDetailsOnError(node, message),
                }
              : node
          )
        : record.nodes;
      return finishRunRecord(
        { ...record, nodes },
        run.id,
        stopped ? "stopped" : "error",
        message
      );
    });
  }
}

async function executeAgentNode(
  workspace: WorkspaceInfo,
  record: WorkflowRecord,
  node: WorkflowNode,
  startedAt: number,
  abort: AbortController
): Promise<LocalNodeResult> {
  if (!node.prompt.trim()) throw new Error(`${node.title} has no prompt.`);
  const logs: Array<{ stream: "stdout" | "stderr"; content: string }> = [];
  const autoSuccess = agentAutoSuccess(node);
  const details = createLiveAgentRunDetails({
    node,
    startedAt,
    autoSuccess,
    logs,
    writeSnapshot: async (snapshot) => {
      await patchWorkflowNode(workspace.path, record.id, node.id, {
        config: {
          ...(node.config ?? {}),
          runDetails: snapshot,
        },
      });
    },
  });
  const onFrame = (frame: AgentTerminalFrame) => {
    void details.handleFrame(frame).catch(() => undefined);
  };
  await details.update("running");
  const mcpTools = collectMcpToolsForAgent(record, node);
  const prompt = buildBlockPrompt(record, node, mcpTools);
  const terminalPrompt = resolveBlockTemplate(node.prompt, record).trim();
  const originalTerminalPrompt = terminalPrompt || prompt;
  let currentPrompt = originalTerminalPrompt;
  let result = null as Awaited<ReturnType<typeof runAgentTerminal>> | null;
  let raw = "";
  let terminalFailure: AgentTerminalFailure | null = null;
  let retainedOutput = "";
  const retries = agentRetryCount(node);
  const retryForever = agentRetryForever(node);
  let attempt = 0;
  while (true) {
    if (attempt > 0) {
      logs.push({
        stream: "stderr",
        content: `\n[osheep] retry ${attempt}/${
          retryForever ? "infinity" : retries
        }: ${currentPrompt === "继续" ? "continue" : "resubmit"}\n`,
      });
      await details.update("running");
    }
    result = await runAgentTerminal({
      workspace,
      kind: node.providerKind,
      model: node.model || "default",
      prompt: currentPrompt,
      autoSuccess,
      claudePermissionMode: agentClaudePermissionMode(node),
      mode: agentMode(node),
      codexApproval: agentCodexApproval(node),
      codexSandbox: agentCodexSandbox(node),
      effort: agentEffort(node),
      alwaysEnter: agentAlwaysEnter(node),
      signal: abort.signal,
      onFrame,
    });
    await details.drain();
    raw =
      result.content ||
      `${node.providerKind === "codex-cli" ? "Codex CLI" : "Claude Code CLI"} completed without text output.`;
    terminalFailure = classifyAgentTerminalFailure(
      result.content || result.transcript || raw,
      currentPrompt
    );
    if (!terminalFailure.retryable) break;
    if (terminalFailure.modelOutput) {
      retainedOutput = [retainedOutput, terminalFailure.modelOutput].filter(Boolean).join("\n");
    }
    if (!retryForever && attempt >= retries) break;
    attempt += 1;
    currentPrompt = nextAgentRetryPrompt(originalTerminalPrompt, terminalFailure);
    await sleep(1_000, abort.signal);
  }
  if (!result) throw new Error(`${node.title} did not start.`);
  if (terminalFailure?.retryable) {
    const errorMessage = `${node.providerKind === "codex-cli" ? "Codex CLI" : "Claude Code CLI"} failed after ${
      attempt + 1
    } attempt${attempt === 0 ? "" : "s"}: ${terminalFailure.message}`;
    const errorDetails = details.snapshot("error", Date.now());
    errorDetails.terminalSessionId = errorDetails.terminalSessionId ?? result.sessionId;
    errorDetails.transcript = result.transcript;
    errorDetails.stdout = result.content;
    errorDetails.stderr = [errorDetails.stderr, errorMessage].filter(Boolean).join("\n");
    errorDetails.exitCode = result.exitCode;
    errorDetails.signal =
      typeof result.signal === "string" || result.signal === null
        ? result.signal
        : String(result.signal);
    return {
      output: {
        type: node.providerKind === "claude-cli" ? "claude" : "codex",
        status: "failed",
        text: raw.trim(),
        error: errorMessage,
        CHANGED_FILES: [],
        VERIFICATION: [],
      },
      changedFiles: false,
      error: errorMessage,
      nodePatch: {
        config: {
          ...(node.config ?? {}),
          runDetails: errorDetails,
        },
      },
    };
  }
  if (retainedOutput) raw = [retainedOutput, raw].filter(Boolean).join("\n");
  const toolRun = await maybeRunAgentMcpToolCalls(
    record,
    node,
    mcpTools,
    raw,
    abort.signal,
    (entry) => logs.push(entry)
  );
  if (toolRun) raw = toolRun.raw;
  const output = agentOutput(node, raw, record);
  const finalDetails = details.snapshot("success", Date.now());
  finalDetails.terminalSessionId = finalDetails.terminalSessionId ?? result.sessionId;
  finalDetails.transcript = result.transcript;
  finalDetails.stdout = result.content;
  finalDetails.exitCode = result.exitCode;
  finalDetails.signal =
    typeof result.signal === "string" || result.signal === null
      ? result.signal
      : String(result.signal);
  return {
    output,
    changedFiles: true,
    nodePatch: {
      config: {
        ...(node.config ?? {}),
        runDetails: finalDetails,
      },
    },
  };
}

async function executeCommandNode(
  workspaceRoot: string,
  record: WorkflowRecord,
  node: WorkflowNode,
  startedAt: number,
  abort: AbortController
): Promise<LocalNodeResult> {
  const commandLine = resolveBlockTemplate(node.prompt, record).trim();
  if (!commandLine) throw new Error(`${node.title} has no input.`);
  const logs: Array<{ stream: "stdout" | "stderr"; content: string }> = [
    { stream: "stdout", content: `$ ${commandLine}\n` },
  ];
  const result = await execRun(workspaceRoot, commandLine, "", 600_000, undefined, {
    signal: abort.signal,
    onLog: (entry) => logs.push({ stream: entry.stream, content: entry.content }),
  });
  const failed = result.exitCode !== 0;
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
        runDetails: commandRunSnapshot(
          node,
          failed ? "error" : "success",
          startedAt,
          Date.now(),
          result.command,
          logs,
          result
        ),
      },
    },
    changedFiles: !failed,
    error: failed ? `${node.title} exited with ${result.exitCode ?? "signal"}.` : undefined,
  };
}

async function executeLocalNode(
  workspaceRoot: string,
  record: WorkflowRecord,
  node: WorkflowNode,
  options: { allowMcpToolCall?: boolean; signal?: AbortSignal } = {}
): Promise<LocalNodeResult> {
  const input = resolveBlockTemplate(node.prompt, record).trim();
  const kind = nodeKind(node);
  if (!input && !CONFIGURED_LOCAL_KINDS.has(kind)) {
    throw new Error(`${node.title} has no input.`);
  }

  if (kind === "web") {
    const result = await execRun(workspaceRoot, buildFetchCommand(input), "", 120_000, "cmd", {
      signal: options.signal,
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

  if (kind === "http-request") {
    const config = httpRequestConfig(node);
    const method = resolveBlockTemplate(config.method, record).trim().toUpperCase() || "GET";
    const url = resolveBlockTemplate(config.url, record).trim();
    const body = resolveBlockTemplate(config.body, record);
    if (!url) throw new Error(`${node.title} has no URL.`);
    const headersParsed = parseTemplatedJsonValue(config.headers, record);
    if (!headersParsed.ok) throw new Error(`${node.title} headers JSON is invalid: ${headersParsed.error}`);
    const headersObject = objectValue(headersParsed.value);
    if (!headersObject) throw new Error(`${node.title} headers must be a JSON object.`);
    const result = await execRun(
      workspaceRoot,
      buildHttpRequestCommand({
        method,
        url,
        headers: stringRecord(headersObject),
        body,
        responseType: config.responseType,
      }),
      "",
      120_000,
      "cmd",
      { signal: options.signal }
    );
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
          CHANGED_FILES: [],
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
        CHANGED_FILES: [],
      },
    };
  }

  if (kind === "file-read") {
    const file = await readFileText(workspaceRoot, input);
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
    const path = resolveBlockTemplate(config.path, record).trim();
    const content = resolveBlockTemplate(config.content, record);
    if (!path) throw new Error(`${node.title} has no path.`);
    await writeFileText(workspaceRoot, path, content, true);
    return {
      output: {
        type: "file-write",
        status: "success",
        path,
        bytes: Buffer.byteLength(content, "utf-8"),
        content,
        CHANGED_FILES: [path],
      },
      changedFiles: true,
    };
  }

  if (kind === "set") {
    const parsed = parseTemplatedJsonValue(setNodeConfig(node).data, record);
    if (!parsed.ok) throw new Error(`${node.title} data JSON is invalid: ${parsed.error}`);
    const obj = objectValue(parsed.value);
    return {
      output: {
        ...(obj ?? {}),
        type: "set",
        status: "success",
        data: parsed.value,
        text: textFromAny(parsed.value),
        CHANGED_FILES: [],
      },
    };
  }

  if (kind === "if") {
    const config = ifNodeConfig(node);
    const left = resolveTemplateValue(config.left, record);
    const right = resolveTemplateValue(config.right, record);
    const result = compareValues(left, config.operator, right);
    return {
      output: {
        type: "if",
        status: "success",
        result,
        operator: config.operator,
        left,
        right,
        text: result ? "true" : "false",
        CHANGED_FILES: [],
      },
    };
  }

  if (kind === "merge") {
    const mode = mergeNodeConfig(node).mode === "array" ? "array" : "object";
    const items = incomingOutputs(record, node);
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
        CHANGED_FILES: [],
      },
    };
  }

  if (kind === "code") {
    const config = codeNodeConfig(node);
    const items = incomingOutputs(record, node);
    const value = await runCodeBlock(config.code, items[0] ?? {}, items);
    return { output: outputFromValue("code", value) };
  }

  if (kind === "loop-items") {
    const config = loopItemsConfig(node);
    const source = config.source.trim()
      ? resolveTemplateValue(config.source, record)
      : incomingOutputs(record, node)[0]?.data ?? incomingOutputs(record, node)[0] ?? [];
    const items = Array.isArray(source) ? source : [source].filter((item) => item !== undefined);
    const batches = chunk(items, Math.max(1, config.batchSize));
    return {
      output: {
        type: "loop-items",
        status: "success",
        mode: config.mode,
        batchSize: config.batchSize,
        items,
        batches,
        data: config.mode === "batches" ? batches : items,
        count: items.length,
        text: jsonPreview(config.mode === "batches" ? batches : items),
        CHANGED_FILES: [],
      },
    };
  }

  if (kind === "wait") {
    const seconds = Math.max(0, waitNodeConfig(node).seconds);
    const startedAt = Date.now();
    await sleep(seconds * 1000, options.signal);
    const durationMs = Date.now() - startedAt;
    return {
      output: {
        type: "wait",
        status: "success",
        seconds,
        durationMs,
        text: `Waited ${(durationMs / 1000).toFixed(1)}s.`,
        CHANGED_FILES: [],
      },
    };
  }

  if (kind === "json") {
    const config = jsonNodeConfig(node);
    const incoming = incomingOutputs(record, node);
    const source = config.source.trim()
      ? resolveTemplateValue(config.source, record)
      : incoming[0] ?? "";
    const parsedSource = parseMaybeJson(source);
    const value = config.path.trim()
      ? getLoosePathValue(parsedSource, config.path)
      : parsedSource;
    return {
      output: {
        type: "json",
        status: "success",
        path: config.path,
        source: parsedSource,
        value,
        data: value,
        text: textFromAny(value),
        CHANGED_FILES: [],
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
    const headers = parseJsonObject(resolveBlockTemplate(config.headers, record)) ?? {};
    if (!options.allowMcpToolCall) {
      const discovery = await discoverRemoteMcp({
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
    const result = await callRemoteMcp({
      remoteLink,
      postUrl: config.postUrl || undefined,
      headers: stringRecord(headers),
      apiKey: config.apiKey || undefined,
      name: toolName,
      arguments: args,
    });
    return {
      output: {
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
      },
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

export function planWorkflowRunNodeIds(
  record: WorkflowRecord
): { nodeIds: string[]; error?: string } {
  const allNodeIds = new Set(record.nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  for (const node of record.nodes) outgoing.set(node.id, []);
  for (const edge of record.edges) {
    if (!allNodeIds.has(edge.from) || !allNodeIds.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
  }

  const roots = record.nodes
    .filter((node) => isTriggerKind(nodeKind(node)))
    .map((node) => node.id);
  const reachable = new Set<string>();
  const queue = [...roots];
  while (queue.length) {
    const id = queue.shift()!;
    if (reachable.has(id)) continue;
    reachable.add(id);
    for (const to of outgoing.get(id) ?? []) queue.push(to);
  }

  return topoOrder(record, reachable);
}

function topoOrder(
  record: WorkflowRecord,
  onlyNodeIds?: Set<string>
): { nodeIds: string[]; error?: string } {
  const nodeIds = new Set(
    record.nodes
      .filter((node) => !onlyNodeIds || onlyNodeIds.has(node.id))
      .map((node) => node.id)
  );
  const indegree = new Map<string, number>();
  const outgoing = new Map<string, string[]>();
  for (const node of record.nodes) {
    if (!nodeIds.has(node.id)) continue;
    indegree.set(node.id, 0);
    outgoing.set(node.id, []);
  }
  for (const edge of record.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    indegree.set(edge.to, (indegree.get(edge.to) ?? 0) + 1);
    outgoing.get(edge.from)?.push(edge.to);
  }
  const queue = record.nodes
    .filter((node) => nodeIds.has(node.id) && (indegree.get(node.id) ?? 0) === 0)
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
  if (ordered.length !== nodeIds.size) {
    return { nodeIds: [], error: "Workflow has a cycle." };
  }
  return { nodeIds: ordered };
}

function patchWorkflowNode(
  workspaceRoot: string,
  workflowId: string,
  nodeId: string,
  patch: Partial<WorkflowNode>
): Promise<WorkflowRecord> {
  return updateWorkflow(workspaceRoot, workflowId, (record) =>
    patchNode(record, nodeId, patch)
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
      node.id === nodeId
        ? {
            ...node,
            ...patch,
            config:
              patch.config && node.config
                ? { ...node.config, ...patch.config }
                : patch.config ?? node.config,
          }
        : node
    ),
  };
}

async function finishRun(
  workspaceRoot: string,
  workflowId: string,
  runId: string,
  status: WorkflowRun["status"],
  error?: string
): Promise<WorkflowRecord> {
  return await updateWorkflow(workspaceRoot, workflowId, (record) =>
    finishRunRecord(record, runId, status, error)
  );
}

function finishRunRecord(
  record: WorkflowRecord,
  runId: string,
  status: WorkflowRun["status"],
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
            error: error ?? run.error,
          }
        : run
    ),
  };
}

function isTriggerKind(kind: WorkflowNodeKind): boolean {
  return kind === "trigger" || kind === "manual-trigger" || kind === "cron" || kind === "webhook-trigger";
}

function triggerOutput(node: WorkflowNode, kind: WorkflowNodeKind): WorkflowBlockOutput {
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
    CHANGED_FILES: [],
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
  record: WorkflowRecord,
  node: WorkflowNode,
  mcpTools: McpRuntimeTool[],
  raw: string,
  signal: AbortSignal,
  onLog?: (entry: { stream: "stdout" | "stderr"; content: string }) => void
): Promise<{ raw: string } | null> {
  if (mcpTools.length === 0 || signal.aborted) return null;
  const calls = extractMcpToolCalls(raw);
  if (calls.length === 0) return null;
  const byName = new Map<string, McpRuntimeTool>();
  for (const runtimeTool of mcpTools) {
    if (!byName.has(runtimeTool.tool.name)) byName.set(runtimeTool.tool.name, runtimeTool);
  }
  const results: WorkflowBlockOutput[] = [];
  for (const call of calls) {
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
    const result = await callRemoteMcp({
      remoteLink: resolveBlockTemplate(runtimeTool.config.remoteLink, record).trim(),
      postUrl: runtimeTool.config.postUrl || undefined,
      headers: stringRecord(
        parseJsonObject(resolveBlockTemplate(runtimeTool.config.headers, record)) ?? {}
      ),
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
  onLog?.({ stream: "stdout", content: `\n[osheep] MCP tool results: ${jsonPreview(results)}\n` });
  return {
    raw: JSON.stringify(
      {
        text: textFromOutput(agentOutput(node, raw, record)),
        status: "success",
        tool_results: results,
        CHANGED_FILES: [],
        VERIFICATION: [],
        NEXT: [],
      },
      null,
      2
    ),
  };
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

function extractMcpToolCalls(raw: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const parsed = parseJsonObject(raw);
  const value = parsed?.tool_calls ?? parsed?.toolCalls ?? parsed?.tools;
  if (!Array.isArray(value)) return [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const item of value) {
    const obj = objectValue(item);
    if (!obj) continue;
    const nested = objectValue(obj.function);
    const name = typeof obj.name === "string" ? obj.name : typeof nested?.name === "string" ? nested.name : "";
    if (!name.trim()) continue;
    let argsValue = obj.arguments ?? nested?.arguments ?? {};
    if (typeof argsValue === "string") argsValue = parseJsonObject(argsValue) ?? {};
    calls.push({
      name: name.trim(),
      arguments: objectValue(argsValue) ?? {},
    });
  }
  return calls;
}

function agentOutput(node: WorkflowNode, raw: string, record: WorkflowRecord): WorkflowBlockOutput {
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
    return objectValue(parsed);
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
  record: WorkflowRecord
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
  ) => stringifyTemplateValue(resolveBlockReference(record, idText, pathText)));
}

function resolveTemplateValue(input: string, record: WorkflowRecord): unknown {
  const trimmed = input.trim();
  const whole = trimmed.match(
    /^\{\{\s*blocks\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\s*\}\}$/
  );
  if (whole) return resolveBlockReference(record, whole[1] ?? "", whole[2] ?? "");
  return parseMaybeJson(resolveBlockTemplate(input, record));
}

function resolveJsonTemplate(input: string, record: WorkflowRecord): string {
  const re = /\{\{\s*blocks\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[[^\]]+\])*)\s*\}\}/g;
  let output = "";
  let index = 0;
  let inString = false;
  let escaped = false;
  let match: RegExpExecArray | null;
  const updateState = (chunk: string) => {
    for (const ch of chunk) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = !inString;
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
  return output + input.slice(index);
}

function resolveBlockReference(record: WorkflowRecord, idText: string, pathText: string): unknown {
  const blockId = Number(idText);
  const node = record.nodes.find((item) => displayBlockId(item) === blockId);
  const output = node ? parseBlockOutput(node) : null;
  if (!output) return undefined;
  return getPathValue(output, pathText);
}

function escapeJsonStringContent(value: string): string {
  return JSON.stringify(value).slice(1, -1);
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

function getLoosePathValue(value: unknown, pathText: string): unknown {
  const trimmed = pathText.trim();
  if (!trimmed) return value;
  return getPathValue(value, trimmed.startsWith(".") || trimmed.startsWith("[") ? trimmed : `.${trimmed}`);
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

function compareValues(left: unknown, operator: string, right: unknown): boolean {
  const lhs = parseMaybeJson(left);
  const rhs = parseMaybeJson(right);
  if (operator === "exists") return lhs !== undefined && lhs !== null && lhs !== "";
  if (operator === "isEmpty") {
    if (lhs === undefined || lhs === null || lhs === "") return true;
    if (Array.isArray(lhs)) return lhs.length === 0;
    if (typeof lhs === "object") return Object.keys(lhs).length === 0;
    return false;
  }
  if (operator === "contains") {
    if (typeof lhs === "string") return lhs.includes(String(rhs ?? ""));
    if (Array.isArray(lhs)) return lhs.some((item) => valuesEqual(item, rhs));
    if (lhs && typeof lhs === "object") return Object.prototype.hasOwnProperty.call(lhs, String(rhs));
    return false;
  }
  if (operator === "greaterThan" || operator === "lessThan") {
    const leftNumber = Number(lhs);
    const rightNumber = Number(rhs);
    if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) {
      return operator === "greaterThan" ? leftNumber > rightNumber : leftNumber < rightNumber;
    }
    const leftText = String(lhs ?? "");
    const rightText = String(rhs ?? "");
    return operator === "greaterThan" ? leftText > rightText : leftText < rightText;
  }
  const equal = valuesEqual(lhs, rhs);
  return operator === "notEquals" ? !equal : equal;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (
    (typeof left === "number" || typeof left === "string") &&
    (typeof right === "number" || typeof right === "string")
  ) {
    const leftNumber = Number(left);
    const rightNumber = Number(right);
    if (!Number.isNaN(leftNumber) && !Number.isNaN(rightNumber)) return leftNumber === rightNumber;
  }
  return jsonPreview(left) === jsonPreview(right);
}

async function runCodeBlock(code: string, input: WorkflowBlockOutput, items: WorkflowBlockOutput[]): Promise<unknown> {
  const helpers = { jsonPreview, textFromAny };
  const fn = new Function(
    "input",
    "items",
    "helpers",
    `"use strict";\nreturn (async () => {\n${code}\n})();`
  ) as (input: WorkflowBlockOutput, items: WorkflowBlockOutput[], helpers: Record<string, unknown>) => Promise<unknown>;
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
      CHANGED_FILES: [],
    });
  }
  return {
    type,
    status: "success",
    data: value,
    text: textFromAny(value),
    CHANGED_FILES: [],
  };
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
    "if(wantsJson){try{const parsed=raw?JSON.parse(raw):null;const serialized=JSON.stringify(parsed);body=serialized&&serialized.length>limit?{truncated:true,preview:text}:parsed;}catch(e){if(payload.responseType==='json')throw e;}}",
    "console.log(JSON.stringify({ok:res.ok,statusCode:res.status,statusText:res.statusText,url:res.url,headers:outHeaders,body,text,truncated:clipped}));",
    "}).catch(err=>{console.error(err&&err.stack?err.stack:String(err&&err.message?err.message:err));process.exit(1);});",
  ].join("");
  return `node -e "${cmdArg(script)}" "${cmdArg(JSON.stringify(input))}"`;
}

function cmdArg(value: string): string {
  return value.replace(/"/g, '\\"');
}

function fileWriteConfig(node: WorkflowNode): { path: string; content: string } {
  const config = node.config ?? {};
  return {
    path: typeof config.path === "string" ? config.path : "",
    content: typeof config.content === "string" ? config.content : node.prompt,
  };
}

function httpRequestConfig(node: WorkflowNode) {
  const config = node.config ?? {};
  return {
    method: typeof config.method === "string" ? config.method.toUpperCase() : "GET",
    url: typeof config.url === "string" ? config.url : node.prompt,
    headers:
      typeof config.headers === "string" && config.headers.trim()
        ? config.headers
        : "{\n  \"accept\": \"application/json\"\n}",
    body: typeof config.body === "string" ? config.body : "",
    responseType: typeof config.responseType === "string" ? config.responseType : "auto",
  };
}

function setNodeConfig(node: WorkflowNode): { data: string } {
  const config = node.config ?? {};
  return { data: typeof config.data === "string" ? config.data : "{\n  \"text\": \"\"\n}" };
}

function ifNodeConfig(node: WorkflowNode): { left: string; operator: string; right: string } {
  const config = node.config ?? {};
  return {
    left: typeof config.left === "string" ? config.left : "",
    operator: typeof config.operator === "string" ? config.operator : "equals",
    right: typeof config.right === "string" ? config.right : "",
  };
}

function mergeNodeConfig(node: WorkflowNode): { mode: string } {
  const config = node.config ?? {};
  return { mode: typeof config.mode === "string" ? config.mode : "object" };
}

function codeNodeConfig(node: WorkflowNode): { code: string } {
  const config = node.config ?? {};
  return {
    code:
      typeof config.code === "string"
        ? config.code
        : "return {\n  text: input.text || input.content || input.stdout || \"\",\n  input\n};",
  };
}

function loopItemsConfig(node: WorkflowNode): { source: string; batchSize: number; mode: string } {
  const config = node.config ?? {};
  const batchSize = Number(config.batchSize);
  return {
    source: typeof config.source === "string" ? config.source : "",
    batchSize: Number.isFinite(batchSize) ? clamp(batchSize, 1, 1000) : 1,
    mode: typeof config.mode === "string" ? config.mode : "items",
  };
}

function waitNodeConfig(node: WorkflowNode): { seconds: number } {
  const config = node.config ?? {};
  const seconds = Number(config.seconds);
  return { seconds: Number.isFinite(seconds) ? clamp(seconds, 0, 86_400) : 1 };
}

function jsonNodeConfig(node: WorkflowNode): { source: string; path: string } {
  const config = node.config ?? {};
  return {
    source: typeof config.source === "string" ? config.source : "",
    path: typeof config.path === "string" ? config.path : "",
  };
}

function mcpNodeConfig(node: WorkflowNode): McpNodeConfig {
  const config = node.config ?? {};
  const tools = Array.isArray(config.tools)
    ? config.tools.filter((tool): tool is RemoteMcpTool => !!objectValue(tool)?.name)
    : [];
  return {
    remoteLink: typeof config.remoteLink === "string" ? config.remoteLink : "",
    postUrl: typeof config.postUrl === "string" ? config.postUrl : "",
    headers:
      typeof config.headers === "string" && config.headers.trim()
        ? config.headers
        : DEFAULT_MCP_HEADERS_JSON,
    apiKey: typeof config.apiKey === "string" ? config.apiKey : "",
    toolName: typeof config.toolName === "string" ? config.toolName : "",
    arguments: typeof config.arguments === "string" ? config.arguments : "{}",
    tools,
  };
}

function agentAutoSuccess(node: WorkflowNode): boolean {
  return node.config?.autoSuccess !== false;
}

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

function agentClaudePermissionMode(node: WorkflowNode): ClaudePermissionMode {
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
      return "acceptEdits";
  }
}

function agentCodexApproval(node: WorkflowNode): CodexApproval {
  const value = node.config?.codexApproval;
  if (value === "untrusted" || value === "on-failure" || value === "on-request" || value === "never") {
    return value;
  }
  if (value === "auto") return "on-failure";
  if (value === "full-access") return "never";
  return "on-failure";
}

function agentCodexSandbox(node: WorkflowNode): CodexSandbox {
  const value = node.config?.codexSandbox;
  if (value === "read-only" || value === "workspace-write" || value === "danger-full-access") {
    return value;
  }
  if (node.config?.codexApproval === "full-access") return "danger-full-access";
  return "workspace-write";
}

function agentRetryCount(node: WorkflowNode): number {
  const value = node.config?.retries;
  if (typeof value !== "number" || !Number.isInteger(value)) return 0;
  return clamp(value, 0, 5);
}

function agentRetryForever(node: WorkflowNode): boolean {
  return node.config?.retryForever === true;
}

function agentAlwaysEnter(node: WorkflowNode): boolean {
  return node.config?.alwaysEnter === true;
}

function agentMode(node: WorkflowNode): AgentMode {
  if (node.providerKind === "claude-cli" && agentClaudeMode(node) === "plan") return "plan";
  return "default";
}

function agentEffort(node: WorkflowNode): AgentEffort | undefined {
  const value = node.config?.effort;
  if (
    value === "off" ||
    value === "minimal" ||
    value === "low" ||
    value === "medium" ||
    value === "high" ||
    value === "xhigh" ||
    value === "max" ||
    value === "ultracode"
  ) {
    return value;
  }
  return undefined;
}

function terminalModelOutputBeforeError(text: string, prompt: string): string {
  const promptLines = new Set(
    stripAnsi(prompt)
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
  );
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => keepTerminalModelLine(line, promptLines))
    .join("\n")
    .trim();
}

function keepTerminalModelLine(line: string, promptLines: Set<string>): boolean {
  if (!line) return false;
  const unprompted = line.replace(/^[›>]\s*/, "").trim();
  if (!unprompted) return false;
  if (promptLines.has(unprompted) || promptLines.has(line)) return false;
  if (/^(?:OpenAI Codex|Claude Code)\b/i.test(unprompted)) return false;
  if (/^(?:model|directory|cwd)\s*:/i.test(unprompted)) return false;
  if (/^(?:Tip|Run npm|See full release notes|Update available)\b/i.test(unprompted)) {
    return false;
  }
  if (/^\(?providers=/i.test(unprompted)) return false;
  if (/^[\u2500-\u257f\s]+$/.test(unprompted)) return false;
  return true;
}

function stripAnsi(text: string): string {
  return text
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b[P^_][\s\S]*?(?:\x1b\\|\x07)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][A-Za-z0-9]/g, "");
}

function agentRunSnapshot(
  node: WorkflowNode,
  status: WorkflowRunDetailSnapshot["status"],
  startedAt: number,
  completedAt: number | undefined,
  logs: Array<{ stream: "stdout" | "stderr"; content: string }>,
  terminalSessionId?: string,
  terminalStatus?: string,
  autoSuccess?: boolean
): WorkflowRunDetailSnapshot {
  const snapshot: WorkflowRunDetailSnapshot = {
    kind: "agent",
    title: node.title,
    status,
    startedAt,
    completedAt,
    commandLine: buildAgentTerminalCommand(node.providerKind, node.model || "default", {
      claudePermissionMode: agentClaudePermissionMode(node),
      mode: agentMode(node),
      codexApproval: agentCodexApproval(node),
      codexSandbox: agentCodexSandbox(node),
      effort: agentEffort(node),
    }).command,
    stdout: logs.filter((log) => log.stream === "stdout").map((log) => log.content).join(""),
    stderr: logs.filter((log) => log.stream === "stderr").map((log) => log.content).join(""),
    transcript: logs.map((log) => `[${log.stream}] ${log.content}`).join(""),
  };
  if (completedAt !== undefined) snapshot.durationMs = Math.max(0, completedAt - startedAt);
  if (terminalSessionId) snapshot.terminalSessionId = terminalSessionId;
  if (terminalStatus) snapshot.terminalStatus = terminalStatus;
  if (autoSuccess !== undefined) snapshot.autoSuccess = autoSuccess;
  return snapshot;
}

function commandRunSnapshot(
  node: WorkflowNode,
  status: WorkflowRunDetailSnapshot["status"],
  startedAt: number,
  completedAt: number | undefined,
  commandLine: string,
  logs: Array<{ stream: "stdout" | "stderr"; content: string }>,
  result?: { exitCode: number | null; signal: string | null; durationMs?: number }
): WorkflowRunDetailSnapshot {
  return {
    kind: "command",
    title: node.title,
    status,
    startedAt,
    completedAt,
    commandLine,
    stdout: logs.filter((log) => log.stream === "stdout").map((log) => log.content).join(""),
    stderr: logs.filter((log) => log.stream === "stderr").map((log) => log.content).join(""),
    transcript: logs.map((log) => `[${log.stream}] ${log.content}`).join(""),
    exitCode: result?.exitCode,
    signal: result?.signal,
    durationMs: result?.durationMs ?? (completedAt ? Math.max(0, completedAt - startedAt) : undefined),
  };
}

function finalizeRunDetailsOnError(node: WorkflowNode, message: string): Record<string, unknown> {
  const config = node.config ?? {};
  const raw = objectValue(config.runDetails);
  if (!raw || (raw.kind !== "agent" && raw.kind !== "command")) return config;
  return {
    ...config,
    runDetails: {
      ...raw,
      status: "error",
      completedAt: Date.now(),
      stderr: `${typeof raw.stderr === "string" ? raw.stderr : ""}\n${message}`,
    },
  };
}

function clearRunDetails(
  config: WorkflowNode["config"]
): WorkflowNode["config"] | undefined {
  if (!config || !Object.prototype.hasOwnProperty.call(config, "runDetails")) return config;
  const { runDetails: _runDetails, ...rest } = config;
  void _runDetails;
  return rest;
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
  const obj = objectValue(value) ?? {};
  return JSON.stringify(obj, null, 2);
}

function valueFromJsonSchema(schema: Record<string, unknown> | null, root = false): unknown {
  if (!schema) return root ? {} : null;
  const examples = Array.isArray(schema.examples) ? schema.examples : [];
  if (examples.length > 0) return examples[0];
  if (schema.default !== undefined) return schema.default;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  const type = typeof schema.type === "string" ? schema.type : root || schema.properties ? "object" : "string";
  if (type === "object" || root) {
    const properties = objectValue(schema.properties) ?? {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : []
    );
    const keys = Object.keys(properties).filter((key) => required.size === 0 || required.has(key));
    const out: Record<string, unknown> = {};
    for (const key of keys) out[key] = valueFromJsonSchema(objectValue(properties[key]));
    return out;
  }
  if (type === "array") return [valueFromJsonSchema(objectValue(schema.items))];
  if (type === "integer" || type === "number") return 0;
  if (type === "boolean") return false;
  if (type === "null") return null;
  return "";
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
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
  const obj = objectValue(value);
  if (!obj) return "";
  if (typeof obj.text === "string") return obj.text;
  if (typeof obj.content === "string") return obj.content;
  if (Array.isArray(obj.content)) return obj.content.map(textFromMcpContent).filter(Boolean).join("\n");
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

function redactUrl(value: string): string {
  if (!value) return "";
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (/^(api[_-]?key|key|token|access[_-]?token|auth|authorization)$/i.test(key)) {
        url.searchParams.set(key, "redacted");
      }
    }
    if (url.username) url.username = "redacted";
    if (url.password) url.password = "redacted";
    return url.toString();
  } catch {
    return value.replace(/([?&](?:api[_-]?key|key|token|access[_-]?token|auth|authorization)=)[^&#]+/gi, "$1redacted");
  }
}

function displayBlockId(node: WorkflowNode): number {
  return typeof node.blockId === "number" && Number.isInteger(node.blockId) && node.blockId > 0
    ? node.blockId
    : 0;
}

function nodeKind(node: WorkflowNode): WorkflowNodeKind {
  return node.kind ?? "agent";
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Stopped"));
      return;
    }
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener(
      "abort",
      () => {
        clearTimeout(timer);
        reject(new Error("Stopped"));
      },
      { once: true }
    );
  });
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function runKey(workspaceId: string, workflowId: string): string {
  return `${workspaceId}:${workflowId}`;
}
