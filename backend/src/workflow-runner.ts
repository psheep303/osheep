import { randomUUID } from "node:crypto";
import { execRun } from "./ai-exec.js";
import {
  type AgentEffort,
  type AgentMode,
  type AgentTerminalFrame,
  buildAgentTerminalCommand,
  type ClaudePermissionMode,
  type CodexApproval,
  type CodexSandbox,
  extractAgentTerminalContent,
  hasAgentTerminalFailure,
  runAgentTerminal,
} from "./ai-terminal.js";
import { applyClaudePluginSelection } from "./claude-plugins.js";
import { applyCodexPluginSelection } from "./codex-plugins.js";
import { readAgentSessionUsage } from "./agent-sessions.js";
import { readFileText, writeFileText } from "./fs-ops.js";
import { callRemoteMcp, discoverRemoteMcp, type RemoteMcpTool } from "./remote-mcp.js";
import {
  getWorkflow,
  updateWorkflow,
  type WorkflowNode,
  type WorkflowNodeKind,
  type WorkflowRecord,
  type WorkflowRun,
  type WorkflowRunTrace,
} from "./workflows.js";
import { resolveWorkspace, type WorkspaceInfo } from "./workspace.js";

type WorkflowBlockOutput = Record<string, unknown>;
type RunLogEntry = { stream: "stdout" | "stderr"; content: string };

interface LocalNodeResult {
  output: WorkflowBlockOutput;
  changedFiles?: boolean;
  error?: string;
  nodePatch?: Partial<WorkflowNode>;
  conversationSessionId?: string;
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
  done: Promise<void>;
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
  conversationSessionId?: string;
  terminalStatus?: string;
  autoSuccess?: boolean;
  exitCode?: number | null;
  signal?: string | null;
  durationMs?: number;
  retryReasons?: string[];
}

interface LiveAgentRunDetailsOptions {
  node: WorkflowNode;
  startedAt: number;
  autoSuccess: boolean;
  writeSnapshot: (snapshot: WorkflowRunDetailSnapshot) => Promise<void>;
  logs?: RunLogEntry[];
  minUpdateIntervalMs?: number;
}

export interface LiveAgentRunDetails {
  handleFrame: (frame: AgentTerminalFrame) => Promise<void>;
  update: (
    status: WorkflowRunDetailSnapshot["status"],
    completedAt?: number,
    force?: boolean,
  ) => Promise<void>;
  snapshot: (
    status: WorkflowRunDetailSnapshot["status"],
    completedAt?: number,
  ) => WorkflowRunDetailSnapshot;
  drain: () => Promise<void>;
}

export interface AgentTerminalFailure {
  failed: boolean;
  retryable: boolean;
  hasModelOutput: boolean;
  message: string;
  modelOutput: string;
}

interface AgentTerminalProcessResult {
  content: string;
  transcript: string;
  rawTranscript?: string;
  exitCode: number | null;
  signal: number | string | null;
}

const activeRuns = new Map<string, WorkflowRunState>();
const RUN_LOG_CHAR_LIMIT = 256 * 1024;
const RUN_LOG_TRUNCATION_TEXT =
  "[osheep] run detail output exceeded 256 KiB; keeping the latest output only.";
const AGENT_RETAINED_OUTPUT_CHAR_LIMIT = 512 * 1024;
const AGENT_RETAINED_OUTPUT_TRUNCATION_TEXT =
  "[osheep] retained retry output exceeded 512 KiB; keeping the latest output only.";
const CONFIGURED_LOCAL_KINDS = new Set<WorkflowNodeKind>([
  "input",
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
  "codex-plugin",
  "claude-plugin",
]);

const DEFAULT_MCP_HEADERS_JSON = JSON.stringify(
  {
    "MCP-Protocol-Version": "2025-03-26",
  },
  null,
  2,
);

export function createLiveAgentRunDetails(
  options: LiveAgentRunDetailsOptions,
): LiveAgentRunDetails {
  const logs = options.logs ?? [];
  const minUpdateIntervalMs = Math.max(0, options.minUpdateIntervalMs ?? 250);
  let terminalSessionId = "";
  let conversationSessionId = "";
  let terminalStatus = "";
  let lastUpdateAt = 0;
  let queue = Promise.resolve();

  const snapshot = (status: WorkflowRunDetailSnapshot["status"], completedAt?: number) =>
    agentRunSnapshot(
      options.node,
      status,
      options.startedAt,
      completedAt,
      logs,
      terminalSessionId || undefined,
      conversationSessionId || undefined,
      terminalStatus || undefined,
      options.autoSuccess,
    );

  const enqueue = (next: WorkflowRunDetailSnapshot) => {
    queue = queue.then(() => options.writeSnapshot(next));
    return queue;
  };

  const update = (
    status: WorkflowRunDetailSnapshot["status"],
    completedAt?: number,
    force = true,
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
    if (frame.type === "conversation") {
      conversationSessionId = frame.sessionId;
      return update("running");
    }
    if (frame.type === "output") {
      appendRunLog(logs, { stream: "stdout", content: frame.data });
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

export function classifyAgentTerminalFailure(raw: string, prompt: string): AgentTerminalFailure {
  const text = stripAnsi(raw).replace(/\r/g, "\n");
  const apiError = lastRegexMatch(
    text,
    /^[ \t]*(?:[●•*✖×!]\s*)?(?:Please run\s+\/login\s*(?:[·•-]\s*)?)?API Error\s*:\s*\S[^\n]*/im,
  );
  if (apiError?.index !== undefined) {
    if (!isAgentErrorSuperseded(text, apiError.index)) {
      return agentTerminalFailure(
        text,
        prompt,
        apiError,
        isRetryableAgentTerminalMessage(apiError[0]),
      );
    }
  }

  const transient = lastRegexMatch(
    text,
    /\b(?:unexpected status\s+(?:408|429|5\d\d)\b[^\n]*|(?:service unavailable|auth_unavailable|rate limit|temporarily unavailable|overloaded|econnreset|etimedout)[^\n]*)/i,
  );
  if (transient?.index !== undefined && !isAgentErrorSuperseded(text, transient.index)) {
    return agentTerminalFailure(text, prompt, transient, true);
  }

  const permanent = lastRegexMatch(
    text,
    /^[ \t]*(?:[●•*✖×!]\s*)?(?:Please run\s+\/login\b[^\n]*|Image generation is not enabled for this (?:group|organization|account)\b[^\n]*|(?:authentication|authorization) (?:failed|required)\b[^\n]*)/im,
  );
  if (permanent?.index !== undefined && !isAgentErrorSuperseded(text, permanent.index)) {
    return agentTerminalFailure(text, prompt, permanent, false);
  }

  const decoratedError = lastRegexMatch(
    text,
    /^[ \t]*[●•✖×!]\s*(?:(?:fatal|authentication|authorization|request)\s+)?error\s*:\s*\S[^\n]*/im,
  );
  if (decoratedError?.index !== undefined && !isAgentErrorSuperseded(text, decoratedError.index)) {
    return agentTerminalFailure(
      text,
      prompt,
      decoratedError,
      isRetryableAgentTerminalMessage(decoratedError[0]),
    );
  }

  return noAgentTerminalFailure();
}

export function classifyAgentTerminalResultFailure(
  result: AgentTerminalProcessResult,
  prompt: string,
): AgentTerminalFailure {
  const contentFailure = classifyAgentTerminalFailure(result.content, prompt);
  if (contentFailure.failed) return contentFailure;

  const transcriptFailure = classifyAgentTerminalFailure(
    terminalTail(result.transcript, 80),
    prompt,
  );
  if (transcriptFailure.failed) return transcriptFailure;

  const modelOutput = terminalModelOutputBeforeError(result.content || result.transcript, prompt);

  // The cleaned conversation intentionally removes terminal chrome. Keep the
  // raw screen as a fallback so provider errors such as Codex 503 responses
  // cannot disappear when the conversation has no assistant answer.
  if (result.rawTranscript) {
    const rawTranscriptFailure = classifyAgentTerminalFailure(
      terminalTail(result.rawTranscript, 120),
      prompt,
    );
    if (rawTranscriptFailure.failed) return rawTranscriptFailure;
    if (hasAgentTerminalFailure(result.rawTranscript)) {
      return agentTerminalLifecycleFailure(
        "Agent terminal reported an error.",
        false,
        modelOutput,
      );
    }
  }

  if (result.signal === "agent-stalled") {
    return agentTerminalLifecycleFailure(
      "Agent terminal stalled without output activity.",
      true,
      modelOutput,
    );
  }
  if (result.exitCode === null) {
    const suffix = result.signal === null ? "without an exit code" : `with signal ${result.signal}`;
    return agentTerminalLifecycleFailure(`Agent terminal exited ${suffix}.`, false, modelOutput);
  }
  if (result.exitCode !== 0) {
    return agentTerminalLifecycleFailure(
      `Agent terminal exited with code ${result.exitCode}.`,
      false,
      modelOutput,
    );
  }
  if (
    result.signal !== null &&
    result.signal !== "auto-finished" &&
    result.signal !== "manual-success"
  ) {
    return agentTerminalLifecycleFailure(
      `Agent terminal completed with unexpected signal ${result.signal}.`,
      false,
      modelOutput,
    );
  }
  return noAgentTerminalFailure();
}

function agentTerminalFailure(
  text: string,
  prompt: string,
  match: RegExpMatchArray,
  retryable: boolean,
): AgentTerminalFailure {
  const matchIndex = match.index ?? 0;
  const modelOutput = terminalModelOutputBeforeError(text.slice(0, matchIndex), prompt);
  return {
    failed: true,
    retryable,
    hasModelOutput: modelOutput.length > 0,
    message: match[0].trim().replace(/^[●•*✖×!]\s*/, ""),
    modelOutput,
  };
}

function agentTerminalLifecycleFailure(
  message: string,
  retryable: boolean,
  modelOutput: string,
): AgentTerminalFailure {
  return {
    failed: true,
    retryable,
    hasModelOutput: modelOutput.length > 0,
    message,
    modelOutput,
  };
}

function noAgentTerminalFailure(): AgentTerminalFailure {
  return {
    failed: false,
    retryable: false,
    hasModelOutput: false,
    message: "",
    modelOutput: "",
  };
}

function isRetryableAgentTerminalMessage(message: string): boolean {
  const status = message.match(/(?:API Error\s*:\s*|unexpected status\s+)(\d{3})\b/i);
  if (status) {
    const code = Number(status[1]);
    return code === 408 || code === 409 || code === 425 || code === 429 || code >= 500;
  }
  return /\b(?:service unavailable|auth_unavailable|rate limit|temporarily unavailable|overloaded|econnreset|etimedout|connection reset|network error|gateway timeout|internal server error)\b/i.test(
    message,
  );
}

function isAgentErrorSuperseded(text: string, errorAt: number): boolean {
  const recovery = text
    .slice(errorAt)
    .replace(/(?:^|\n)\s*(?:Reconnecting|Retrying)\b[^\n]*/gi, "\n");
  return /(?:^|\n)\s*(?:[\p{S}\p{P}]\s*)?(?:Thought\s+for\s+\d|\p{L}[\p{L}'’-]*(?:…|\.\.\.)?\s*\(\s*\d+(?:\.\d+)?(?:ms|s|m|h)\b)/imu.test(
    recovery,
  );
}

function lastRegexMatch(text: string, pattern: RegExp): RegExpMatchArray | null {
  const flags = pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`;
  const regex = new RegExp(pattern.source, flags);
  let last: RegExpMatchArray | null = null;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    last = match;
    if (!match[0]) regex.lastIndex += 1;
  }
  return last;
}

function terminalTail(text: string, lineCount: number): string {
  return text.split("\n").slice(-lineCount).join("\n");
}

export function nextAgentRetryPrompt(
  originalPrompt: string,
  failure: AgentTerminalFailure,
): string {
  void originalPrompt;
  void failure;
  return "继续";
}

export function shouldRetryAgentTerminalFailure(
  failure: AgentTerminalFailure,
  attempt: number,
  retries: number,
  retryForever: boolean,
): boolean {
  return failure.failed && (retryForever || attempt < retries);
}

export async function startWorkflowRun(
  workspaceId: string,
  workflowId: string,
  requestedNodeIds?: string[],
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
    requestedNodeIds?.length ? ordered : record.nodes.map((node) => node.id),
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
        : node,
    ),
    runs: [...current.runs.slice(-49), run],
  }));

  const abort = new AbortController();
  const done = runWorkflowInBackground(workspace, workflowId, run, ordered, abort).catch(
    () => undefined,
  );
  activeRuns.set(key, { workspaceId, workflowId, runId: run.id, abort, done });
  void done.finally(() => {
    const state = activeRuns.get(key);
    if (state?.runId === run.id) activeRuns.delete(key);
  });
  return { runId: run.id, workflow: record };
}

export function stopWorkflowRun(workspaceId: string, workflowId: string): boolean {
  const state = activeRuns.get(runKey(workspaceId, workflowId));
  if (!state) return false;
  state.abort.abort();
  return true;
}

export async function stopWorkflowRunAndWait(
  workspaceId: string,
  workflowId: string,
): Promise<boolean> {
  const key = runKey(workspaceId, workflowId);
  const state = activeRuns.get(key);
  if (!state) return false;
  state.abort.abort();
  await state.done;
  if (activeRuns.get(key) === state) activeRuns.delete(key);
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
  abort: AbortController,
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
        const completedAt = Date.now();
        await patchWorkflowNode(workspace.path, workflowId, nodeId, {
          status: "success",
          rawOutput: outputText,
          summary: outputText,
          error: "",
          startedAt,
          completedAt,
        });
        await patchWorkflowRun(workspace.path, workflowId, run.id, (current) =>
          appendRunTrace(current, {
            nodeId,
            title: node.title,
            kind,
            status: "success",
            startedAt,
            completedAt,
            durationMs: completedAt - startedAt,
            input: workflowNodeInput(record, node),
            output,
          }),
        );
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
      await patchWorkflowRun(workspace.path, workflowId, run.id, (current) =>
        appendRunTrace(current, {
          nodeId,
          title: currentNode.title,
          kind,
          status: "running",
          startedAt,
          input: workflowNodeInput(record, currentNode),
        }),
      );
      let result: LocalNodeResult;
      try {
        result =
          kind === "agent"
            ? await executeAgentNode(workspace, record, currentNode, startedAt, abort)
            : kind === "command"
              ? await executeCommandNode(workspace.path, record, currentNode, startedAt, abort)
              : await executeLocalNode(workspace.path, record, currentNode, {
                  allowMcpToolCall: nodeIds.length === 1,
                  signal: abort.signal,
                });
      } catch (error) {
        const message = (error as Error).message || `${currentNode.title} failed.`;
        if (abort.signal.aborted || message === "Stopped" || !nodeFailover(currentNode)) {
          throw error;
        }
        const outputText = stringifyBlockOutput({
          type: kind,
          status: "failed",
          error: message,
          failover: true,
          text: message,
        });
        await patchWorkflowNode(workspace.path, workflowId, nodeId, {
          status: "error",
          rawOutput: outputText,
          summary: outputText,
          error: message,
          completedAt: Date.now(),
          config: finalizeRunDetailsOnError(currentNode, message),
        });
        await patchWorkflowRun(workspace.path, workflowId, run.id, (current) =>
          completeRunTrace(current, nodeId, {
            status: "error",
            completedAt: Date.now(),
            durationMs: Date.now() - startedAt,
            output: parseJsonObject(outputText) ?? outputText,
            error: message,
            retryReasons: [message],
          }),
        );
        continue;
      }
      const outputText = stringifyBlockOutput(result.output);
      const completedAt = Date.now();
      await patchWorkflowNode(workspace.path, workflowId, nodeId, {
        ...(result.nodePatch ?? {}),
        status: result.error ? "error" : "success",
        rawOutput: outputText,
        summary: outputText,
        error: result.error ?? "",
        completedAt,
      });
      const detailsConfig = result.nodePatch?.config ?? currentNode.config;
      const terminal = terminalFromConfig(detailsConfig);
      const runDetails =
        detailsConfig && typeof detailsConfig.runDetails === "object"
          ? (detailsConfig.runDetails as Record<string, unknown>)
          : undefined;
      const conversationSessionId =
        result.conversationSessionId ??
        (typeof runDetails?.conversationSessionId === "string"
          ? runDetails.conversationSessionId
          : undefined);
      const terminalUsage = usageFromTerminal(terminal);
      const sessionUsage =
        conversationSessionId && kind === "agent"
          ? await readAgentSessionUsage(
              currentNode.providerKind === "claude-cli" ? "claude" : "codex",
              conversationSessionId,
            ).catch(() => ({}))
          : {};
      const usage = mergeUsage(terminalUsage, sessionUsage);
      await patchWorkflowRun(workspace.path, workflowId, run.id, (current) =>
        completeRunTrace(current, nodeId, {
          status: result.error ? "error" : "success",
          completedAt,
          durationMs: completedAt - startedAt,
          output: result.output,
          error: result.error,
          terminal,
          retryReasons: retryReasonsFromConfig(detailsConfig),
          tokens: usage.tokens,
          cost: usage.cost,
        }),
      );
      if (result.error && !nodeFailover(currentNode)) throw new Error(result.error);
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
              : node,
          )
        : record.nodes;
      return finishRunRecord({ ...record, nodes }, run.id, stopped ? "stopped" : "error", message);
    });
  }
}

async function executeAgentNode(
  workspace: WorkspaceInfo,
  record: WorkflowRecord,
  node: WorkflowNode,
  startedAt: number,
  abort: AbortController,
): Promise<LocalNodeResult> {
  if (!node.prompt.trim()) throw new Error(`${node.title} has no prompt.`);
  const logs: RunLogEntry[] = [];
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
  const retryReasons: string[] = [];
  let terminalTranscript = "";
  const retries = agentRetryCount(node);
  const retryForever = agentRetryForever(node);
  const conversationSessionId = node.providerKind === "claude-cli" ? randomUUID() : undefined;
  let attempt = 0;
  while (true) {
    if (attempt > 0) {
      appendRunLog(logs, {
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
      retainRawTranscript: true,
      alwaysEnter: agentAlwaysEnter(node),
      conversationSessionId,
      resumeConversation: attempt > 0,
      signal: abort.signal,
      onFrame,
    });
    await details.drain();
    if (abort.signal.aborted) throw new Error("Stopped");
    terminalTranscript = appendAgentAttemptTranscript(
      terminalTranscript,
      result.transcript || result.content,
      attempt,
      retries,
      retryForever,
    );
    const terminalContent = extractAgentTerminalContent(
      result.transcript || result.content,
      currentPrompt,
      node.providerKind,
    );
    raw =
      result.content && !/completed without text output/i.test(result.content)
        ? result.content
        : terminalContent ||
          `${node.providerKind === "codex-cli" ? "Codex CLI" : "Claude Code CLI"} completed without text output.`;
    terminalFailure = classifyAgentTerminalResultFailure(result, currentPrompt);
    if (!terminalFailure.failed) break;
    if (!shouldRetryAgentTerminalFailure(terminalFailure, attempt, retries, retryForever)) break;
    retryReasons.push(terminalFailure.message);
    attempt += 1;
    currentPrompt = nextAgentRetryPrompt(originalTerminalPrompt, terminalFailure);
    await sleep(1_000, abort.signal);
  }
  if (!result) throw new Error(`${node.title} did not start.`);
  if (terminalFailure?.failed) {
    const agentLabel = node.providerKind === "codex-cli" ? "Codex CLI" : "Claude Code CLI";
    const errorMessage =
      attempt > 0
        ? `${agentLabel} failed after ${attempt + 1} attempt${attempt === 0 ? "" : "s"}: ${terminalFailure.message}`
        : `${agentLabel} failed: ${terminalFailure.message}`;
    const errorDetails = details.snapshot("error", Date.now());
    errorDetails.terminalSessionId = errorDetails.terminalSessionId ?? result.sessionId;
    errorDetails.conversationSessionId =
      errorDetails.conversationSessionId ?? result.conversationSessionId;
    if (terminalTranscript) errorDetails.transcript = terminalTranscript;
    errorDetails.stderr = [errorDetails.stderr, errorMessage].filter(Boolean).join("\n");
    errorDetails.exitCode = result.exitCode;
    errorDetails.signal =
      typeof result.signal === "string" || result.signal === null
        ? result.signal
        : String(result.signal);
    if (retryReasons.length) errorDetails.retryReasons = retryReasons;
    return {
      output: {
        type: node.providerKind === "claude-cli" ? "claude" : "codex",
        status: "failed",
        text: raw.trim(),
        error: errorMessage,
      },
      changedFiles: false,
      error: errorMessage,
      nodePatch: {
        config: {
          ...(node.config ?? {}),
          runDetails: errorDetails,
        },
      },
      conversationSessionId: result.conversationSessionId,
    };
  }
  const toolRun = await maybeRunAgentMcpToolCalls(
    record,
    node,
    mcpTools,
    raw,
    abort.signal,
    (entry) => appendRunLog(logs, entry),
  );
  if (toolRun) raw = toolRun.raw;
  const output = agentOutput(node, raw);
  const finalDetails = details.snapshot("success", Date.now());
  finalDetails.terminalSessionId = finalDetails.terminalSessionId ?? result.sessionId;
  finalDetails.conversationSessionId =
    finalDetails.conversationSessionId ?? result.conversationSessionId;
  if (terminalTranscript) finalDetails.transcript = terminalTranscript;
  finalDetails.exitCode = result.exitCode;
  finalDetails.signal =
    typeof result.signal === "string" || result.signal === null
      ? result.signal
      : String(result.signal);
  if (retryReasons.length) finalDetails.retryReasons = retryReasons;
  return {
    output,
    changedFiles: true,
    nodePatch: {
      config: {
        ...(node.config ?? {}),
        runDetails: finalDetails,
      },
    },
    conversationSessionId: result.conversationSessionId,
  };
}

function appendAgentAttemptTranscript(
  transcript: string,
  attemptTranscript: string,
  attempt: number,
  retries: number,
  retryForever: boolean,
): string {
  const marker =
    attempt > 0 ? `[osheep] retry ${attempt}/${retryForever ? "infinity" : retries}` : "";
  return appendBoundedJoinedText(
    transcript,
    [marker, attemptTranscript.trim()].filter(Boolean).join("\n"),
    AGENT_RETAINED_OUTPUT_CHAR_LIMIT,
    AGENT_RETAINED_OUTPUT_TRUNCATION_TEXT,
  );
}

export function appendAgentAttemptTranscriptForTest(
  transcript: string,
  attemptTranscript: string,
  attempt: number,
  retries: number,
  retryForever = false,
): string {
  return appendAgentAttemptTranscript(
    transcript,
    attemptTranscript,
    attempt,
    retries,
    retryForever,
  );
}

async function executeCommandNode(
  workspaceRoot: string,
  record: WorkflowRecord,
  node: WorkflowNode,
  startedAt: number,
  abort: AbortController,
): Promise<LocalNodeResult> {
  const commandLine = resolveBlockTemplate(node.prompt, record).trim();
  if (!commandLine) throw new Error(`${node.title} has no input.`);
  const logs: RunLogEntry[] = [];
  appendRunLog(logs, { stream: "stdout", content: `$ ${commandLine}\n` });
  const result = await execRun(workspaceRoot, commandLine, "", 600_000, undefined, {
    signal: abort.signal,
    onLog: (entry) => appendRunLog(logs, { stream: entry.stream, content: entry.content }),
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
          result,
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
  options: { allowMcpToolCall?: boolean; signal?: AbortSignal } = {},
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
    if (!headersParsed.ok)
      throw new Error(`${node.title} headers JSON is invalid: ${headersParsed.error}`);
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
      { signal: options.signal },
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
    const file = await readFileText(workspaceRoot, input);
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
      : (incomingOutputs(record, node)[0]?.data ?? incomingOutputs(record, node)[0] ?? []);
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

  if (kind === "codex-plugin") {
    const selected = pluginSelectors(node);
    const snapshot = await applyCodexPluginSelection(selected);
    const enabled = snapshot.plugins
      .filter((plugin) => plugin.status.enabled)
      .map((plugin) => plugin.selector);
    return {
      output: {
        type: "codex-plugin",
        status: "success",
        selected,
        enabled,
        text: `Codex plugins updated: ${enabled.length} enabled.`,
      },
    };
  }

  if (kind === "claude-plugin") {
    const selected = pluginSelectors(node);
    const snapshot = await applyClaudePluginSelection(selected);
    const enabled = snapshot.plugins
      .filter((plugin) => plugin.status.installed && plugin.status.enabled)
      .map((plugin) => plugin.selector);
    return {
      output: {
        type: "claude-plugin",
        status: "success",
        selected,
        enabled,
        text: `Claude plugins updated: ${enabled.length} enabled.`,
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

export function planWorkflowRunNodeIds(record: WorkflowRecord): {
  nodeIds: string[];
  error?: string;
} {
  const allNodeIds = new Set(record.nodes.map((node) => node.id));
  const outgoing = new Map<string, string[]>();
  for (const node of record.nodes) outgoing.set(node.id, []);
  for (const edge of record.edges) {
    if (!allNodeIds.has(edge.from) || !allNodeIds.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
  }

  const roots = record.nodes.filter((node) => isTriggerKind(nodeKind(node))).map((node) => node.id);
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
  onlyNodeIds?: Set<string>,
): { nodeIds: string[]; error?: string } {
  const nodeIds = new Set(
    record.nodes.filter((node) => !onlyNodeIds || onlyNodeIds.has(node.id)).map((node) => node.id),
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
  patch: Partial<WorkflowNode>,
): Promise<WorkflowRecord> {
  return updateWorkflow(workspaceRoot, workflowId, (record) => patchNode(record, nodeId, patch));
}

function patchWorkflowRun(
  workspaceRoot: string,
  workflowId: string,
  runId: string,
  updater: (run: WorkflowRun) => WorkflowRun,
): Promise<WorkflowRecord> {
  return updateWorkflow(workspaceRoot, workflowId, (record) => ({
    ...record,
    runs: record.runs.map((run) => (run.id === runId ? updater(run) : run)),
  }));
}

function appendRunTrace(run: WorkflowRun, trace: WorkflowRunTrace): WorkflowRun {
  const traces = [...(run.trace ?? []), trace].slice(-500);
  return { ...run, trace: traces };
}

function completeRunTrace(
  run: WorkflowRun,
  nodeId: string,
  patch: Partial<WorkflowRunTrace>,
): WorkflowRun {
  const trace = [...(run.trace ?? [])];
  let index = -1;
  for (let i = trace.length - 1; i >= 0; i -= 1) {
    if (trace[i]?.nodeId === nodeId && trace[i]?.status === "running") {
      index = i;
      break;
    }
  }
  if (index < 0) return run;
  trace[index] = { ...trace[index], ...patch };
  return { ...run, trace };
}

function workflowNodeInput(record: WorkflowRecord, node: WorkflowNode): unknown {
  const incoming = record.edges
    .filter((edge) => edge.to === node.id)
    .map((edge) => record.nodes.find((item) => item.id === edge.from))
    .filter((item): item is WorkflowNode => !!item)
    .map(parseBlockOutput);
  return incoming.length ? incoming : resolveBlockTemplate(node.prompt, record);
}

function terminalFromConfig(config: WorkflowNode["config"]): WorkflowRunTrace["terminal"] {
  const details = config && typeof config.runDetails === "object" ? config.runDetails as Record<string, unknown> : null;
  if (!details) return undefined;
  return {
    commandLine: typeof details.commandLine === "string" ? details.commandLine : undefined,
    stdout: typeof details.stdout === "string" ? details.stdout : undefined,
    stderr: typeof details.stderr === "string" ? details.stderr : undefined,
    transcript: typeof details.transcript === "string" ? details.transcript : undefined,
    exitCode: typeof details.exitCode === "number" || details.exitCode === null ? details.exitCode : undefined,
    signal: typeof details.signal === "string" || details.signal === null ? details.signal : undefined,
  };
}

function retryReasonsFromConfig(config: WorkflowNode["config"]): string[] | undefined {
  const details = config && typeof config.runDetails === "object" ? config.runDetails as Record<string, unknown> : null;
  const captured = Array.isArray(details?.retryReasons)
    ? details.retryReasons.filter((item): item is string => typeof item === "string")
    : [];
  if (captured.length) return captured;
  const terminal = terminalFromConfig(config);
  const text = `${terminal?.stderr ?? ""}\n${terminal?.transcript ?? ""}`;
  const reasons = text.split(/\n+/).filter((line) => /retry/i.test(line));
  return reasons.length ? reasons.slice(-20) : undefined;
}

function usageFromTerminal(terminal: WorkflowRunTrace["terminal"]): {
  tokens?: WorkflowRunTrace["tokens"];
  cost?: number;
} {
  const text = `${terminal?.transcript ?? ""}\n${terminal?.stdout ?? ""}`;
  return parseWorkflowUsage(text);
}

function mergeUsage(
  terminal: { tokens?: WorkflowRunTrace["tokens"]; cost?: number },
  session: { tokens?: WorkflowRunTrace["tokens"]; cost?: number },
): { tokens?: WorkflowRunTrace["tokens"]; cost?: number } {
  const tokens = session.tokens ?? terminal.tokens;
  return {
    tokens,
    cost: session.cost ?? terminal.cost,
  };
}

export function parseWorkflowUsage(text: string): {
  tokens?: WorkflowRunTrace["tokens"];
  cost?: number;
} {
  const plain = text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
  const input = lastLabeledTokenCount(
    plain,
    /(?:\binput(?:\s+tokens?)?|\binput_tokens)[\s"']*[:=][\s"']*/gi,
  );
  const output = lastLabeledTokenCount(
    plain,
    /(?:\boutput(?:\s+tokens?)?|\boutput_tokens)[\s"']*[:=][\s"']*/gi,
  );
  const explicitTotal = lastLabeledTokenCount(
    plain,
    /(?:\btotal(?:\s+tokens?)?|\btotal_tokens)[\s"']*[:=][\s"']*/gi,
  );
  let genericTotal: number | undefined;
  if (input === undefined && output === undefined && explicitTotal === undefined) {
    for (const match of plain.matchAll(/([\d,.]+)\s*([km])?\s+tokens?\b/gi)) {
      const count = tokenCount(match[1], match[2]);
      if (count !== undefined) genericTotal = Math.max(genericTotal ?? 0, count);
    }
  }
  const total =
    explicitTotal ??
    (input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : genericTotal);
  const costMatch = [
    ...plain.matchAll(
      /(?:\btotal[ _-]?cost(?:_usd)?|\bcost)[\s"']*[:=][\s"']*\$?([\d.]+)/gi,
    ),
  ].at(-1);
  const cost = costMatch ? Number(costMatch[1]) : undefined;
  return {
    tokens:
      input !== undefined || output !== undefined || total !== undefined
        ? { input, output, total }
        : undefined,
    cost: cost !== undefined && Number.isFinite(cost) ? cost : undefined,
  };
}

function lastLabeledTokenCount(text: string, label: RegExp): number | undefined {
  let count: number | undefined;
  const pattern = new RegExp(`${label.source}([\\d,.]+)\\s*([km])?`, label.flags);
  for (const match of text.matchAll(pattern)) {
    count = tokenCount(match[1], match[2]) ?? count;
  }
  return count;
}

function tokenCount(value: string | undefined, suffix: string | undefined): number | undefined {
  const base = Number(value?.replace(/,/g, ""));
  if (!Number.isFinite(base)) return undefined;
  const multiplier =
    suffix?.toLowerCase() === "k" ? 1_000 : suffix?.toLowerCase() === "m" ? 1_000_000 : 1;
  return Math.round(base * multiplier);
}

function patchNode(
  record: WorkflowRecord,
  nodeId: string,
  patch: Partial<WorkflowNode>,
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
                : (patch.config ?? node.config),
          }
        : node,
    ),
  };
}

async function finishRun(
  workspaceRoot: string,
  workflowId: string,
  runId: string,
  status: WorkflowRun["status"],
  error?: string,
): Promise<WorkflowRecord> {
  return await updateWorkflow(workspaceRoot, workflowId, (record) =>
    finishRunRecord(record, runId, status, error),
  );
}

function finishRunRecord(
  record: WorkflowRecord,
  runId: string,
  status: WorkflowRun["status"],
  error?: string,
): WorkflowRecord {
  const completedAt = Date.now();
  return {
    ...record,
    runs: record.runs.map((run) =>
      run.id === runId
        ? (() => {
            const trace = run.trace?.map((item) =>
              item.status === "running"
                ? {
                    ...item,
                    status: status === "stopped" ? "stopped" as const : "error" as const,
                    completedAt,
                    durationMs: Math.max(0, completedAt - item.startedAt),
                    error: error ?? item.error,
                  }
                : item,
            );
            const finalized = { ...run, trace };
            return {
            ...run,
            status,
            completedAt,
            error: error ?? run.error,
            trace,
            stats: runStats(finalized, completedAt),
          };
          })()
        : run,
    ),
  };
}

function runStats(run: WorkflowRun, completedAt: number): WorkflowRun["stats"] {
  const trace = run.trace ?? [];
  const retryCount = trace.reduce((sum, item) => sum + (item.retryReasons?.length ?? 0), 0);
  const totalTokens = trace.reduce(
    (sum, item) =>
      sum +
      (item.tokens?.total ??
        (item.tokens?.input !== undefined || item.tokens?.output !== undefined
          ? (item.tokens.input ?? 0) + (item.tokens.output ?? 0)
          : 0)),
    0,
  );
  return {
    durationMs: Math.max(0, completedAt - run.startedAt),
    totalTokens: totalTokens || undefined,
    inputTokens: trace.reduce((sum, item) => sum + (item.tokens?.input ?? 0), 0) || undefined,
    outputTokens: trace.reduce((sum, item) => sum + (item.tokens?.output ?? 0), 0) || undefined,
    cost: trace.reduce((sum, item) => sum + (item.cost ?? 0), 0) || undefined,
    nodeCount: trace.length,
    retryCount: retryCount || undefined,
  };
}

function isTriggerKind(kind: WorkflowNodeKind): boolean {
  return (
    kind === "trigger" || kind === "manual-trigger" || kind === "cron" || kind === "webhook-trigger"
  );
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

async function maybeRunAgentMcpToolCalls(
  record: WorkflowRecord,
  node: WorkflowNode,
  mcpTools: McpRuntimeTool[],
  raw: string,
  signal: AbortSignal,
  onLog?: (entry: { stream: "stdout" | "stderr"; content: string }) => void,
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
        parseJsonObject(resolveBlockTemplate(runtimeTool.config.headers, record)) ?? {},
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
        text: textFromOutput(agentOutput(node, raw)),
        status: "success",
        tool_results: results,
        NEXT: [],
      },
      null,
      2,
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

function extractMcpToolCalls(
  raw: string,
): Array<{ name: string; arguments: Record<string, unknown> }> {
  const parsed = parseJsonObject(raw);
  const value = parsed?.tool_calls ?? parsed?.toolCalls ?? parsed?.tools;
  if (!Array.isArray(value)) return [];
  const calls: Array<{ name: string; arguments: Record<string, unknown> }> = [];
  for (const item of value) {
    const obj = objectValue(item);
    if (!obj) continue;
    const nested = objectValue(obj.function);
    const name =
      typeof obj.name === "string" ? obj.name : typeof nested?.name === "string" ? nested.name : "";
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
    (_match, idText: string, pathText: string) =>
      stringifyTemplateValue(resolveBlockReference(record, idText, pathText)),
  );
}

function resolveTemplateValue(input: string, record: WorkflowRecord): unknown {
  assertValidBlockTemplates(input);
  const trimmed = input.trim();
  const whole = trimmed.match(
    /^\{\{\s*blocks\[(\d+)\]((?:\.[A-Za-z_$][\w$]*|\[(?:"[^"]+"|'[^']+'|\d+)\])*)\s*\}\}$/,
  );
  if (whole) return resolveBlockReference(record, whole[1] ?? "", whole[2] ?? "");
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
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = !inString;
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

export function resolveWorkflowTemplate(input: string, record: WorkflowRecord): string {
  return resolveBlockTemplate(input, record);
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
      if (!Object.hasOwn(current, key)) {
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
  return getPathValue(
    value,
    trimmed.startsWith(".") || trimmed.startsWith("[") ? trimmed : `.${trimmed}`,
  );
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
    if (lhs && typeof lhs === "object") return Object.hasOwn(lhs, String(rhs));
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

async function runCodeBlock(
  code: string,
  input: WorkflowBlockOutput,
  items: WorkflowBlockOutput[],
): Promise<unknown> {
  const helpers = { jsonPreview, textFromAny };
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
        : '{\n  "accept": "application/json"\n}',
    body: typeof config.body === "string" ? config.body : "",
    responseType: typeof config.responseType === "string" ? config.responseType : "auto",
  };
}

function setNodeConfig(node: WorkflowNode): { data: string } {
  const config = node.config ?? {};
  return { data: typeof config.data === "string" ? config.data : '{\n  "text": ""\n}' };
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
        : 'return {\n  text: input.text || input.content || input.stdout || "",\n  input\n};',
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

function pluginSelectors(node: WorkflowNode): string[] {
  const value = node.config?.pluginSelectors;
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
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
  if (value === "untrusted" || value === "on-request" || value === "never") {
    return value;
  }
  if (value === "auto" || value === "on-failure") return "on-request";
  if (value === "full-access") return "never";
  return "on-request";
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
  return node.providerKind === "claude-cli" ? "high" : "medium";
}

function terminalModelOutputBeforeError(text: string, prompt: string): string {
  const promptLines = new Set(
    stripAnsi(prompt)
      .replace(/\r/g, "\n")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean),
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
  const unprompted = line.replace(/^[\u276f\u203a>]\s*/, "").trim();
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

function appendRunLog(logs: RunLogEntry[], entry: RunLogEntry): void {
  if (!entry.content) return;
  logs.push(entry);
  trimRunLogs(logs);
}

function appendBoundedJoinedText(
  current: string,
  next: string,
  maxChars: number,
  markerText: string,
): string {
  if (!next) return current;
  const joined = current ? `${current}\n${next}` : next;
  if (joined.length <= maxChars) return joined;
  const marker = `\n${markerText}\n`;
  const tailLength = Math.max(0, maxChars - marker.length);
  return marker + joined.slice(-tailLength);
}

function trimRunLogs(logs: RunLogEntry[]): void {
  const source = logs.filter((log) => !isRunLogTruncationMarker(log));
  const hadMarker = source.length !== logs.length;
  const total = source.reduce((sum, log) => sum + log.content.length, 0);
  if (total <= RUN_LOG_CHAR_LIMIT) {
    if (hadMarker) logs.splice(0, logs.length, runLogTruncationMarker(), ...source);
    return;
  }

  const marker = runLogTruncationMarker();
  const target = Math.max(0, RUN_LOG_CHAR_LIMIT - marker.content.length);
  const kept: RunLogEntry[] = [];
  let remaining = target;
  for (let i = source.length - 1; i >= 0 && remaining > 0; i -= 1) {
    const log = source[i]!;
    if (log.content.length <= remaining) {
      kept.push(log);
      remaining -= log.content.length;
    } else {
      kept.push({ ...log, content: log.content.slice(-remaining) });
      remaining = 0;
    }
  }
  kept.reverse();
  logs.splice(0, logs.length, marker, ...kept);
}

function isRunLogTruncationMarker(log: RunLogEntry): boolean {
  return log.stream === "stderr" && log.content.includes(RUN_LOG_TRUNCATION_TEXT);
}

function runLogTruncationMarker(): RunLogEntry {
  return { stream: "stderr", content: `\n${RUN_LOG_TRUNCATION_TEXT}\n` };
}

function runLogStreamText(logs: RunLogEntry[], stream: RunLogEntry["stream"]): string {
  return logs
    .filter((log) => log.stream === stream)
    .map((log) => log.content)
    .join("");
}

function formatRunTranscript(logs: RunLogEntry[]): string {
  return logs.map((log) => `[${log.stream}] ${log.content}`).join("");
}

function agentRunSnapshot(
  node: WorkflowNode,
  status: WorkflowRunDetailSnapshot["status"],
  startedAt: number,
  completedAt: number | undefined,
  logs: RunLogEntry[],
  terminalSessionId?: string,
  conversationSessionId?: string,
  terminalStatus?: string,
  autoSuccess?: boolean,
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
    stdout: runLogStreamText(logs, "stdout"),
    stderr: runLogStreamText(logs, "stderr"),
    transcript: formatRunTranscript(logs),
  };
  if (completedAt !== undefined) snapshot.durationMs = Math.max(0, completedAt - startedAt);
  if (terminalSessionId) snapshot.terminalSessionId = terminalSessionId;
  if (conversationSessionId) snapshot.conversationSessionId = conversationSessionId;
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
  logs: RunLogEntry[],
  result?: { exitCode: number | null; signal: string | null; durationMs?: number },
): WorkflowRunDetailSnapshot {
  return {
    kind: "command",
    title: node.title,
    status,
    startedAt,
    completedAt,
    commandLine,
    stdout: runLogStreamText(logs, "stdout"),
    stderr: runLogStreamText(logs, "stderr"),
    transcript: formatRunTranscript(logs),
    exitCode: result?.exitCode,
    signal: result?.signal,
    durationMs:
      result?.durationMs ?? (completedAt ? Math.max(0, completedAt - startedAt) : undefined),
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

function clearRunDetails(config: WorkflowNode["config"]): WorkflowNode["config"] | undefined {
  if (!config || !Object.hasOwn(config, "runDetails")) return config;
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
  const type =
    typeof schema.type === "string" ? schema.type : root || schema.properties ? "object" : "string";
  if (type === "object" || root) {
    const properties = objectValue(schema.properties) ?? {};
    const required = new Set(
      Array.isArray(schema.required)
        ? schema.required.filter((item): item is string => typeof item === "string")
        : [],
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
  if (Array.isArray(obj.content))
    return obj.content.map(textFromMcpContent).filter(Boolean).join("\n");
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
    return value.replace(
      /([?&](?:api[_-]?key|key|token|access[_-]?token|auth|authorization)=)[^&#]+/gi,
      "$1redacted",
    );
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
      { once: true },
    );
  });
}

function makeId(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 10)}`;
}

function runKey(workspaceId: string, workflowId: string): string {
  return `${workspaceId}:${workflowId}`;
}
