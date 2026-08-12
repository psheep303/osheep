import assert from "node:assert/strict";
import test from "node:test";
import {
  appendAgentAttemptTranscriptForTest,
  classifyAgentTerminalFailure,
  classifyAgentTerminalResultFailure,
  createLiveAgentRunDetails,
  nextAgentRetryPrompt,
  parseWorkflowUsage,
  planWorkflowRunNodeIds,
  resolveWorkflowTemplate,
  scheduleWorkflowNodes,
  shouldRetryAgentTerminalFailure,
  type WorkflowRunDetailSnapshot,
} from "./workflow-runner.js";
import type { WorkflowNode, WorkflowRecord } from "./workflows.js";

test("workflow run planning excludes nodes that are not reachable from a trigger", () => {
  const record: WorkflowRecord = {
    id: "wf_testplan",
    title: "Planning",
    createdAt: 1,
    updatedAt: 1,
    runs: [],
    nodes: [
      workflowNode("node_trigger", "trigger", "Workflow run"),
      workflowNode("node_codex", "agent", "Codex"),
      workflowNode("node_claude", "agent", "Claude Code", "claude-cli"),
    ],
    edges: [
      {
        id: "edge_trigger_codex",
        from: "node_trigger",
        to: "node_codex",
        passSummary: true,
      },
    ],
  };

  assert.deepEqual(planWorkflowRunNodeIds(record).nodeIds, ["node_trigger", "node_codex"]);
});

test("workflow run planning includes input blocks reachable from a trigger", () => {
  const record: WorkflowRecord = {
    id: "wf_testinput",
    title: "Input planning",
    createdAt: 1,
    updatedAt: 1,
    runs: [],
    nodes: [
      workflowNode("node_trigger", "trigger", "Workflow run"),
      workflowNode("node_input", "input", "Input"),
      workflowNode("node_codex", "agent", "Codex"),
      workflowNode("node_unreachable_input", "input", "Unused input"),
    ],
    edges: [
      {
        id: "edge_trigger_input",
        from: "node_trigger",
        to: "node_input",
        passSummary: true,
      },
      {
        id: "edge_input_codex",
        from: "node_input",
        to: "node_codex",
        passSummary: true,
      },
    ],
  };

  assert.deepEqual(planWorkflowRunNodeIds(record).nodeIds, [
    "node_trigger",
    "node_input",
    "node_codex",
  ]);
});

test("workflow templates resolve existing block output values", () => {
  const source = {
    ...workflowNode("node_input", "input", "Input"),
    blockId: 2,
    rawOutput: JSON.stringify({
      type: "input",
      text: "hello",
      data: { items: ["first"] },
    }),
  };
  const record = workflowRecord([source]);

  assert.equal(resolveWorkflowTemplate("Say {{blocks[2].text}}", record), "Say hello");
  assert.equal(resolveWorkflowTemplate("{{blocks[2].data.items[0]}}", record), "first");
});

test("workflow templates reject malformed and missing variables", () => {
  const source = {
    ...workflowNode("node_input", "input", "Input"),
    blockId: 2,
    rawOutput: JSON.stringify({ type: "input", text: "hello" }),
  };
  const record = workflowRecord([source]);

  assert.throws(
    () => resolveWorkflowTemplate("{{blocks[id].(missing)}}", record),
    /Invalid workflow variable/,
  );
  assert.throws(() => resolveWorkflowTemplate("{{blocks[99].text}}", record), /missing block #99/);
  assert.throws(
    () => resolveWorkflowTemplate("{{blocks[2].missing}}", record),
    /value that does not exist/,
  );
});

function workflowRecord(nodes: WorkflowNode[]): WorkflowRecord {
  return {
    id: "wf_template1",
    title: "Template",
    createdAt: 1,
    updatedAt: 1,
    runs: [],
    nodes,
    edges: [],
  };
}

function workflowNode(
  id: string,
  kind: WorkflowNode["kind"],
  title: string,
  providerKind: WorkflowNode["providerKind"] = "codex-cli",
): WorkflowNode {
  return {
    id,
    kind,
    title,
    providerKind,
    model: "default",
    prompt: "",
    x: 0,
    y: 0,
    status: "idle",
  };
}

test("live agent run details capture terminal session and output frames", async () => {
  const node: WorkflowNode = {
    id: "node_livedetail",
    kind: "agent",
    title: "Codex",
    providerKind: "codex-cli",
    model: "default",
    prompt: "Do the work",
    x: 0,
    y: 0,
    status: "running",
  };
  const writes: WorkflowRunDetailSnapshot[] = [];
  const details = createLiveAgentRunDetails({
    node,
    startedAt: 1_000,
    autoSuccess: true,
    writeSnapshot: async (snapshot) => {
      writes.push(snapshot);
    },
  });

  await details.update("running");
  await details.handleFrame({ type: "session", sessionId: "t_live" });
  await details.handleFrame({ type: "conversation", sessionId: "conv_live" });
  await details.handleFrame({ type: "output", data: "first chunk\n" });
  await details.handleFrame({ type: "status", status: "ready" });

  assert.equal(writes.length, 4);
  assert.equal(writes[1]?.terminalSessionId, "t_live");
  assert.equal(writes[2]?.conversationSessionId, "conv_live");
  assert.equal(writes[3]?.terminalStatus, "ready");
  assert.equal(writes[3]?.status, "running");
  assert.equal(writes[3]?.stdout, "");
  assert.equal(details.snapshot("running").stdout, "first chunk\n");
});

test("workflow scheduler runs sibling branches in parallel and waits before a join", async () => {
  let siblingCount = 0;
  let notifySiblingsStarted!: () => void;
  const siblingsStarted = new Promise<void>((resolve) => {
    notifySiblingsStarted = resolve;
  });
  let releaseSiblings!: () => void;
  const siblingGate = new Promise<void>((resolve) => {
    releaseSiblings = resolve;
  });
  let joinStarted = false;

  const scheduled = scheduleWorkflowNodes(
    ["trigger", "codex", "claude", "join"],
    [
      { id: "edge_trigger_codex", from: "trigger", to: "codex", passSummary: true },
      { id: "edge_trigger_claude", from: "trigger", to: "claude", passSummary: true },
      { id: "edge_codex_join", from: "codex", to: "join", passSummary: true },
      { id: "edge_claude_join", from: "claude", to: "join", passSummary: true },
    ],
    2,
    async (nodeId) => {
      if (nodeId === "codex" || nodeId === "claude") {
        siblingCount += 1;
        if (siblingCount === 2) notifySiblingsStarted();
        await siblingGate;
      }
      if (nodeId === "join") joinStarted = true;
    },
  );

  await siblingsStarted;
  assert.equal(joinStarted, false);
  releaseSiblings();
  await scheduled;
  assert.equal(joinStarted, true);
});

test("workflow scheduler respects a per-run parallel limit", async () => {
  let active = 0;
  let peak = 0;
  await scheduleWorkflowNodes(["a", "b", "c", "d"], [], 1, async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 2));
    active -= 1;
  });
  assert.equal(peak, 1);
});

test("workflow scheduler follows only the matching conditional output", async () => {
  const executed: string[] = [];
  await scheduleWorkflowNodes(
    ["if", "true-node", "false-node"],
    [
      {
        id: "edge_if_true",
        from: "if",
        to: "true-node",
        passSummary: true,
        sourceHandle: "true",
      },
      {
        id: "edge_if_false",
        from: "if",
        to: "false-node",
        passSummary: true,
        sourceHandle: "false",
      },
    ],
    2,
    async (nodeId) => {
      executed.push(nodeId);
      return nodeId === "if" ? "false" : undefined;
    },
  );
  assert.deepEqual(executed, ["if", "false-node"]);
});

test("workflow scheduler rejoins after an unselected branch without duplicating the join", async () => {
  const executed: string[] = [];
  await scheduleWorkflowNodes(
    ["approval", "success-node", "failure-node", "join"],
    [
      {
        id: "edge_approval_success",
        from: "approval",
        to: "success-node",
        passSummary: true,
        sourceHandle: "success",
      },
      {
        id: "edge_approval_failure",
        from: "approval",
        to: "failure-node",
        passSummary: true,
        sourceHandle: "failure",
      },
      { id: "edge_success_join", from: "success-node", to: "join", passSummary: true },
      { id: "edge_failure_join", from: "failure-node", to: "join", passSummary: true },
    ],
    2,
    async (nodeId) => {
      executed.push(nodeId);
      return nodeId === "approval" ? "success" : undefined;
    },
  );
  assert.deepEqual(executed, ["approval", "success-node", "join"]);
});

test("separate workflow schedules do not share their parallel limit", async () => {
  let active = 0;
  let peak = 0;
  const execute = async () => {
    active += 1;
    peak = Math.max(peak, active);
    await new Promise<void>((resolve) => setTimeout(resolve, 5));
    active -= 1;
  };

  await Promise.all([
    scheduleWorkflowNodes(["first"], [], 1, execute),
    scheduleWorkflowNodes(["second"], [], 1, execute),
  ]);
  assert.equal(peak, 2);
});

test("workflow usage captures Codex input, output, and total tokens", () => {
  assert.deepEqual(
    parseWorkflowUsage(
      "Token usage: total=17,946 input=15,801 (+ 10,240 cached) output=2,145 (reasoning 757)",
    ),
    {
      tokens: {
        input: 15_801,
        output: 2_145,
        cacheRead: 10_240,
        cacheWrite: undefined,
        total: 17_946,
      },
      cost: undefined,
    },
  );
});

test("workflow usage derives total tokens and captures Claude cost output", () => {
  assert.deepEqual(
    parseWorkflowUsage("input_tokens: 1.2k\noutput_tokens: 345\ntotal_cost_usd: 0.0421"),
    {
      tokens: {
        input: 1_200,
        output: 345,
        cacheRead: undefined,
        cacheWrite: undefined,
        total: 1_545,
      },
      cost: 0.0421,
    },
  );
});

test("workflow usage retains generic terminal token totals as a fallback", () => {
  assert.deepEqual(parseWorkflowUsage("Cooked for 3m · 35.2k tokens"), {
    tokens: {
      input: undefined,
      output: undefined,
      cacheRead: undefined,
      cacheWrite: undefined,
      total: 35_200,
    },
    cost: undefined,
  });
});

test("workflow usage captures Claude cache read and write tokens", () => {
  assert.deepEqual(
    parseWorkflowUsage(
      "input_tokens: 12\ncache_read_input_tokens: 3.5k\ncache_creation_input_tokens: 800\noutput_tokens: 90",
    ),
    {
      tokens: {
        input: 12,
        output: 90,
        cacheRead: 3_500,
        cacheWrite: 800,
        total: 4_402,
      },
      cost: undefined,
    },
  );
});

test("Codex workflow blocks without an effort setting use medium reasoning", () => {
  const node = workflowNode("node_default_effort", "agent", "Codex");
  const details = createLiveAgentRunDetails({
    node,
    startedAt: 1_000,
    autoSuccess: true,
    writeSnapshot: async () => {},
  });

  assert.match(details.snapshot("running").commandLine, /model_reasoning_effort="medium"/);
});

test("live agent run details bound stored terminal output", async () => {
  const node: WorkflowNode = {
    id: "node_livelimit",
    kind: "agent",
    title: "Codex",
    providerKind: "codex-cli",
    model: "default",
    prompt: "Generate lots of output",
    x: 0,
    y: 0,
    status: "running",
  };
  const writes: WorkflowRunDetailSnapshot[] = [];
  const details = createLiveAgentRunDetails({
    node,
    startedAt: 1_000,
    autoSuccess: true,
    writeSnapshot: async (snapshot) => {
      writes.push(snapshot);
    },
  });
  const chunk = "x".repeat(80_000);

  for (let i = 0; i < 8; i += 1) {
    await details.handleFrame({ type: "output", data: chunk });
  }

  assert.equal(writes.length, 0);
  const last = details.snapshot("running");
  assert.ok(last.stdout.length < 300_000);
  assert.match(last.stderr, /run detail output exceeded 256 KiB/);
  assert.match(last.transcript, /run detail output exceeded 256 KiB/);
});

test("Claude API 403 output is a non-retryable terminal failure", () => {
  const prompt = "Build a weather crawler";
  const failure = classifyAgentTerminalFailure(
    [
      `\u276f ${prompt}`,
      "\u25cf Please run /login \u00b7 API Error: 403 Image generation is not enabled for this",
      "  group",
      "\u273b Saut\u00e9ed for 5s",
    ].join("\n"),
    prompt,
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, false);
  assert.equal(failure.hasModelOutput, false);
  assert.match(failure.message, /Please run \/login.*API Error: 403/i);
});

test("configured retries are honored for permanent terminal failures", () => {
  const failure = classifyAgentTerminalFailure(
    "\u25cf Please run /login \u00b7 API Error: 403 Image generation is not enabled for this group",
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, false);
  assert.equal(shouldRetryAgentTerminalFailure(failure, 0, 2, false), true);
  assert.equal(shouldRetryAgentTerminalFailure(failure, 1, 2, false), true);
  assert.equal(shouldRetryAgentTerminalFailure(failure, 2, 2, false), false);
  assert.equal(shouldRetryAgentTerminalFailure(failure, 2, 0, true), true);
});

test("run details retain every terminal retry attempt", () => {
  const first = appendAgentAttemptTranscriptForTest(
    "",
    "API Error: 403 Image generation is not enabled for this group",
    0,
    2,
  );
  const second = appendAgentAttemptTranscriptForTest(
    first,
    "API Error: 403 Image generation is not enabled for this group",
    1,
    2,
  );

  assert.match(second, /API Error: 403[\s\S]*\[osheep\] retry 1\/2[\s\S]*API Error: 403/);
});

test("Claude API errors without an HTTP status are terminal failures", () => {
  const failure = classifyAgentTerminalFailure(
    [
      "Thought for 7s (ctrl+o to expand)",
      "\u25cf API Error: Content block not found",
      "\u273b Churned for 3m 14s",
    ].join("\n"),
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, false);
  assert.match(failure.message, /API Error: Content block not found/i);
});

test("Claude API error followed by a new activity cycle is superseded", () => {
  const failure = classifyAgentTerminalFailure(
    [
      "Thought for 9s (ctrl+o to expand)",
      "\u25cf API Error: Content block not found",
      "Thought for 4s (ctrl+o to expand)",
      "继续完成必要修改并运行验证。",
      "验证结果：4 个测试全部成功。",
      "* Cogitated for 12m 40s",
      "\u276f",
      "auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
    ].join("\n"),
    "Build a weather crawler",
  );

  assert.equal(failure.failed, false);
});

test("Claude duration footer alone does not supersede a later API error", () => {
  const failure = classifyAgentTerminalFailure(
    ["* Cogitated for 12m 40s", "\u25cf API Error: Content block not found"].join("\n"),
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, false);
});

test("Claude API errors use status and transient text only for retry policy", () => {
  const overloaded = classifyAgentTerminalFailure(
    "\u25cf API Error: 529 Overloaded",
    "Build a weather crawler",
  );
  const rateLimited = classifyAgentTerminalFailure(
    "\u25cf API Error: Rate limit exceeded",
    "Build a weather crawler",
  );

  assert.equal(overloaded.failed, true);
  assert.equal(overloaded.retryable, true);
  assert.equal(rateLimited.failed, true);
  assert.equal(rateLimited.retryable, true);
});

test("agent result scans the terminal transcript when extracted content misses the error", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "Thought for 7s\n\u25cf API Error: Content block not found\nplan mode on",
      exitCode: 0,
      signal: "auto-finished",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, false);
});

test("agent result scans the raw terminal stream for Codex 503 errors", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "Use /skills to list available skills",
      rawTranscript: [
        "Reconnecting... 1/5 (6s • esc to interrupt)",
        "└ Unexpected status 503 Service Unavailable: No available channel for model",
        "gpt-5.6-luna under group default",
        "› Use /skills to list available skills",
      ].join("\n"),
      exitCode: 0,
      signal: "auto-finished",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, true);
  assert.match(failure.message, /unexpected status 503/i);
});

test("agent result treats generic raw terminal errors as failures", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "",
      rawTranscript: [
        "Fatal exception while calling provider",
        "› Summarize recent commits",
        "gpt-5.6-luna medium · D:\\demo",
      ].join("\n"),
      exitCode: 0,
      signal: "auto-finished",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.match(failure.message, /reported an error/i);
});

test("Codex reconnect activity does not supersede a preceding 503 error", () => {
  const failure = classifyAgentTerminalFailure(
    [
      "unexpected status 503 Service Unavailable: No available channel for model",
      "Reconnecting... 2/5 (6s • esc to interrupt)",
    ].join("\n"),
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, true);
});

test("agent result never treats abnormal process completion as success", () => {
  const nonzero = classifyAgentTerminalResultFailure(
    { content: "", transcript: "", exitCode: 1, signal: null },
    "Build a weather crawler",
  );
  const missingExit = classifyAgentTerminalResultFailure(
    { content: "", transcript: "", exitCode: null, signal: "SIGTERM" },
    "Build a weather crawler",
  );
  const stalled = classifyAgentTerminalResultFailure(
    {
      content: "Partial work",
      transcript: "Partial work",
      exitCode: 0,
      signal: "agent-stalled",
    },
    "Build a weather crawler",
  );
  assert.equal(nonzero.failed, true);
  assert.match(nonzero.message, /code 1/);
  assert.equal(missingExit.failed, true);
  assert.match(missingExit.message, /SIGTERM/);
  assert.equal(stalled.failed, true);
  assert.equal(stalled.retryable, true);
  assert.match(stalled.message, /stalled without output activity/);
});

test("normal auto-finished agent result remains successful", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "The weather crawler is complete.",
      transcript: "The weather crawler is complete.",
      exitCode: 0,
      signal: "auto-finished",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, false);
});

test("ordinary Claude output is not classified as a terminal failure", () => {
  const failure = classifyAgentTerminalFailure(
    "The weather crawler is complete.",
    "Build a weather crawler",
  );

  assert.equal(failure.failed, false);
  assert.equal(failure.retryable, false);
  assert.equal(failure.message, "");
});

test("codex transient service errors without model output retry with continue prompt", () => {
  const prompt = "Implement {feature}";
  const failure = classifyAgentTerminalFailure(
    [
      "OpenAI Codex (v0.142.5)",
      "model: gpt-5.3-codex medium",
      "directory: D:\\project\\osheep\\backend\\workspaces\\demo",
      "unexpected status 503 Service Unavailable: auth_unavailable: no auth available",
      "(providers=codex, model=gpt-5.3-codex)",
      prompt,
    ].join("\n"),
    prompt,
  );

  assert.equal(failure.retryable, true);
  assert.equal(failure.hasModelOutput, false);
  assert.equal(nextAgentRetryPrompt(prompt, failure), "继续");
});

test("codex transient service errors after model output retry with continue prompt", () => {
  const prompt = "Write a migration plan";
  const failure = classifyAgentTerminalFailure(
    [
      "Here is the first half of the migration plan:",
      "1. Inventory the current API consumers.",
      "unexpected status 503 Service Unavailable: auth_unavailable: no auth available",
    ].join("\n"),
    prompt,
  );

  assert.equal(failure.retryable, true);
  assert.equal(failure.hasModelOutput, true);
  assert.equal(nextAgentRetryPrompt(prompt, failure), "继续");
});
