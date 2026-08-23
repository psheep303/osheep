import assert from "node:assert/strict";
import test from "node:test";
import {
  agentRetryPromptForLanguage,
  appendAgentAttemptTranscriptForTest,
  buildAgentProviderPlan,
  canResumeWorkflowRun,
  classifyAgentTerminalResultFailure,
  createLiveAgentRunDetails,
  interruptWorkflowRunRecord,
  isAgentApiFailureMessage,
  multiplyCost,
  parseWorkflowUsage,
  planWorkflowRunNodeIds,
  resolveWorkflowTemplate,
  runWorkflowCodeForTest,
  scheduleWorkflowNodes,
  shouldRetryAgentTerminalFailure,
  type WorkflowRunDetailSnapshot,
  workflowRunCheckpoints,
  workflowStopDisposition,
} from "./workflow-runner.js";
import type { WorkflowNode, WorkflowRecord } from "./workflows.js";

test("agent retry prompt follows the resolved Osheep language", () => {
  assert.equal(agentRetryPromptForLanguage("zh-CN"), "继续");
  assert.equal(agentRetryPromptForLanguage("en"), "continue");
});

test("provider retry plans preserve round-robin order and sort lowest multipliers", () => {
  const providers = {
    expensive: {
      id: "expensive",
      name: "Expensive",
      settingsConfig: {},
      billingMultiplier: 2,
    },
    cheap: { id: "cheap", name: "Cheap", settingsConfig: {}, billingMultiplier: 0.5 },
    standard: { id: "standard", name: "Standard", settingsConfig: {} },
  };
  assert.deepEqual(
    buildAgentProviderPlan(
      "round-robin",
      ["standard", "expensive", "cheap"],
      providers,
      "expensive",
    ),
    [
      { id: "standard", multiplier: 1 },
      { id: "expensive", multiplier: 2 },
      { id: "cheap", multiplier: 0.5 },
    ],
  );
  assert.deepEqual(
    buildAgentProviderPlan(
      "lowest-multiplier",
      ["standard", "expensive", "cheap"],
      providers,
      "expensive",
    ),
    [
      { id: "cheap", multiplier: 0.5 },
      { id: "standard", multiplier: 1 },
      { id: "expensive", multiplier: 2 },
    ],
  );
});

test("provider billing multiplies model cost and preserves unavailable cost", () => {
  assert.ok(Math.abs((multiplyCost(0.0125, 1.8) ?? 0) - 0.0225) < 1e-12);
  assert.equal(multiplyCost(undefined, 2), undefined);
});

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

test("interrupted workflow keeps completed checkpoints and resets the active agent", () => {
  const completed = {
    ...workflowNode("node_completed", "set", "Completed"),
    status: "success" as const,
    rawOutput: JSON.stringify({ type: "set", value: 1 }),
    completedAt: 20,
  };
  const active = {
    ...workflowNode("node_active", "agent", "Codex"),
    status: "running" as const,
    rawOutput: "partial output",
    summary: "partial output",
    startedAt: 30,
    config: { runDetails: { status: "running" }, retries: 2 },
  };
  const record = workflowRecord([completed, active]);
  record.runs = [
    {
      id: "run_interrupted",
      status: "running",
      startedAt: 10,
      nodeIds: [completed.id, active.id],
      trace: [
        {
          nodeId: completed.id,
          title: completed.title,
          kind: "set",
          status: "success",
          startedAt: 10,
          completedAt: 20,
          output: { type: "set", value: 1 },
        },
        {
          nodeId: active.id,
          title: active.title,
          kind: "agent",
          status: "running",
          startedAt: 30,
        },
      ],
    },
  ];

  const interrupted = interruptWorkflowRunRecord(record, 50);
  const run = interrupted.runs[0]!;
  const resetAgent = interrupted.nodes.find((node) => node.id === active.id)!;

  assert.equal(run.status, "stopped");
  assert.equal(run.resumable, true);
  assert.match(run.resumeFingerprint ?? "", /^[a-f0-9]{64}$/);
  assert.equal(run.completedAt, 50);
  assert.equal(run.trace?.[0]?.status, "success");
  assert.equal(run.trace?.[1]?.status, "stopped");
  assert.equal(resetAgent.status, "idle");
  assert.equal(resetAgent.rawOutput, "");
  assert.deepEqual(resetAgent.config, { retries: 2 });
  assert.equal(interrupted.nodes[0]?.status, "success");
  assert.equal(canResumeWorkflowRun(interrupted, run, run.nodeIds), true);
  assert.equal(
    canResumeWorkflowRun(
      {
        ...interrupted,
        nodes: interrupted.nodes.map((node) =>
          node.id === active.id ? { ...node, prompt: "changed prompt" } : node,
        ),
      },
      run,
      run.nodeIds,
    ),
    false,
  );
});

test("workflow checkpoints preserve every successful loop pass in order", () => {
  const run = {
    id: "run_loop",
    status: "stopped" as const,
    startedAt: 1,
    nodeIds: ["node_condition"],
    trace: [
      {
        nodeId: "node_condition",
        title: "Condition",
        kind: "if" as const,
        status: "success" as const,
        startedAt: 2,
        output: { result: true },
      },
      {
        nodeId: "node_condition",
        title: "Condition",
        kind: "if" as const,
        status: "success" as const,
        startedAt: 3,
        output: { result: false },
      },
      {
        nodeId: "node_condition",
        title: "Condition",
        kind: "if" as const,
        status: "stopped" as const,
        startedAt: 4,
      },
    ],
  };

  assert.deepEqual(
    workflowRunCheckpoints(run)
      .get("node_condition")
      ?.map((trace) => trace.output),
    [{ result: true }, { result: false }],
  );
});

test("pause remains resumable when an agent reports an abort error", () => {
  assert.deepEqual(workflowStopDisposition(true, true, true, "The operation was aborted."), {
    stopped: true,
    resumable: true,
  });
  assert.deepEqual(workflowStopDisposition(false, true, true, "The operation was aborted."), {
    stopped: true,
    resumable: true,
  });
  assert.deepEqual(workflowStopDisposition(false, false, true, "Node failed."), {
    stopped: true,
    resumable: true,
  });
  assert.deepEqual(workflowStopDisposition(false, true, false, "Stopped"), {
    stopped: true,
    resumable: false,
  });
});

test("workflow run planning allows a cycle that has an exit", () => {
  const record = workflowRecord([
    workflowNode("trigger", "trigger", "Workflow run"),
    workflowNode("body", "agent", "Codex"),
    workflowNode("condition", "if", "Condition"),
    workflowNode("exit", "set", "Exit"),
  ]);
  record.edges = [
    { id: "trigger-body", from: "trigger", to: "body", passSummary: true },
    { id: "body-condition", from: "body", to: "condition", passSummary: true },
    {
      id: "condition-loop",
      from: "condition",
      to: "body",
      sourceHandle: "true",
      passSummary: true,
    },
    {
      id: "condition-exit",
      from: "condition",
      to: "exit",
      sourceHandle: "false",
      passSummary: true,
    },
  ];

  assert.deepEqual(planWorkflowRunNodeIds(record), {
    nodeIds: ["trigger", "body", "condition", "exit"],
  });
});

test("workflow run planning rejects a cycle without an exit", () => {
  const record = workflowRecord([
    workflowNode("trigger", "trigger", "Workflow run"),
    workflowNode("first", "set", "First"),
    workflowNode("second", "set", "Second"),
  ]);
  record.edges = [
    { id: "trigger-first", from: "trigger", to: "first", passSummary: true },
    { id: "first-second", from: "first", to: "second", passSummary: true },
    { id: "second-first", from: "second", to: "first", passSummary: true },
  ];

  assert.deepEqual(planWorkflowRunNodeIds(record), {
    nodeIds: [],
    error: "Workflow has a cycle without an exit.",
  });
});

test("workflow templates resolve environment variables and JSON paths", () => {
  const variable = {
    ...workflowNode("node_variable", "variable", "Environment variable"),
    config: {
      variables: [
        { name: "name", value: '{"id": 42, "label": "hello"}' },
        { name: "enabled", value: "true" },
        { name: "literalJson", value: '{"id": 1}', type: "text" },
        { name: "typedJson", value: '{"id": 1}', type: "json" },
      ],
    },
  };
  const record = workflowRecord([variable]);

  assert.equal(resolveWorkflowTemplate("Value: {{vars[name].label}}", record), "Value: hello");
  assert.equal(resolveWorkflowTemplate("{{vars['name'].id}}", record), "42");
  assert.equal(resolveWorkflowTemplate("{{vars[name].id}}", record), "42");
  assert.equal(resolveWorkflowTemplate('{"id": {{vars["name"].id}}}', record), '{"id": 42}');
  assert.equal(resolveWorkflowTemplate("{{vars[name]}}", record), '{"id":42,"label":"hello"}');
  assert.equal(resolveWorkflowTemplate("{{vars[enabled]}}", record), "true");
  assert.equal(
    resolveWorkflowTemplate("{{vars[b]}}", {
      ...record,
      nodes: [
        {
          ...variable,
          config: { variables: [{ name: "b", value: "single", type: "text" }] },
        },
      ],
    }),
    "single",
  );
  assert.equal(resolveWorkflowTemplate("{{vars[literalJson]}}", record), '{"id": 1}');
  assert.equal(resolveWorkflowTemplate("{{vars[typedJson]}}", record), '{"id":1}');
});

test("JavaScript workflow code receives typed variable and block template values", async () => {
  const record: WorkflowRecord = {
    id: "wf_code_template",
    title: "Code template",
    createdAt: 1,
    updatedAt: 1,
    runs: [],
    edges: [],
    nodes: [
      {
        ...workflowNode("node_variable", "variable", "Environment"),
        blockId: 1,
        config: {
          variables: [
            { name: "name", value: "Osheep", type: "text" },
            { name: "options", value: '{"enabled":true}', type: "json" },
          ],
        },
      },
      {
        ...workflowNode("node_source", "set", "Source"),
        blockId: 2,
        rawOutput: JSON.stringify({ status: "success", data: { count: 3 } }),
      },
    ],
  };

  assert.deepEqual(
    await runWorkflowCodeForTest(
      "return { name: {{vars[name]}}, enabled: {{vars[options].enabled}}, count: {{blocks[2].data.count}} };",
      record,
    ),
    { name: "Osheep", enabled: true, count: 3 },
  );
});

test("workflow variable types validate configured values", () => {
  const record = workflowRecord([
    {
      ...workflowNode("node_typed_variable", "variable", "Typed variables"),
      config: {
        variables: [
          { name: "badJson", value: "{", type: "json" },
          { name: "badNumber", value: "NaN", type: "number" },
          { name: "badBoolean", value: "yes", type: "boolean" },
        ],
      },
    },
  ]);

  assert.throws(() => resolveWorkflowTemplate("{{vars[badJson]}}", record), /invalid JSON/);
  assert.throws(() => resolveWorkflowTemplate("{{vars[badNumber]}}", record), /finite number/);
  assert.throws(() => resolveWorkflowTemplate("{{vars[badBoolean]}}", record), /true or false/);
});

test("workflow templates resolve empty and string environment variables", () => {
  const record = workflowRecord([
    {
      ...workflowNode("node_empty", "variable", "Empty"),
      config: { name: "empty", value: "" },
    },
    {
      ...workflowNode("node_string", "variable", "String"),
      config: { name: "plain", value: "not-json" },
    },
  ]);

  assert.equal(resolveWorkflowTemplate("empty={{vars[empty]}}", record), "empty=");
  assert.equal(resolveWorkflowTemplate("plain={{vars[plain]}}", record), "plain=not-json");
  assert.throws(() => resolveWorkflowTemplate("{{vars[missing]}}", record), /missing variable/);
});

test("later environment variable blocks overwrite existing names", () => {
  const first = {
    ...workflowNode("node_first_variable", "variable", "First variables"),
    config: { variables: [{ name: "shared", value: "first", type: "text" }] },
  };
  const second = {
    ...workflowNode("node_second_variable", "variable", "Second variables"),
    config: {
      variables: [
        { name: "shared", value: "second", type: "text" },
        { name: "added", value: "new", type: "text" },
      ],
    },
  };
  const record = workflowRecord([first, second]);

  assert.equal(resolveWorkflowTemplate("{{vars[shared]}}", record), "second");
  assert.equal(resolveWorkflowTemplate("{{vars[added]}}", record), "new");
});

test("a running workflow only resolves environment variable blocks that already ran", () => {
  const upstream = {
    ...workflowNode("node_upstream_variable", "variable", "Upstream variables"),
    blockId: 3,
    status: "success" as const,
    completedAt: 100,
    rawOutput: JSON.stringify({
      type: "variable",
      status: "success",
      variables: { instruction: "from block 3" },
    }),
    config: {
      variables: [{ name: "instruction", value: "from block 3", type: "text" }],
    },
  };
  const downstream = {
    ...workflowNode("node_downstream_variable", "variable", "Downstream variables"),
    blockId: 13,
    config: {
      variables: [{ name: "instruction", value: "from block 13", type: "text" }],
    },
  };
  const record = workflowRecord([upstream, downstream]);
  record.runs = [{ id: "run_active", status: "running", startedAt: 1, nodeIds: [] }];

  assert.equal(resolveWorkflowTemplate("{{vars[instruction]}}", record), "from block 3");

  upstream.completedAt = 100;
  downstream.status = "success";
  downstream.completedAt = 90;
  downstream.rawOutput = JSON.stringify({
    type: "variable",
    status: "success",
    variables: { instruction: "stale block 13 output" },
  });
  record.runs[0]!.startedAt = 95;
  assert.equal(resolveWorkflowTemplate("{{vars[instruction]}}", record), "from block 3");
});

test("workflow variable names support non-ASCII names", () => {
  const record = workflowRecord([
    {
      ...workflowNode("node_cn_variable", "variable", "中文变量"),
      config: { name: "服务地址", value: "https://example.test" },
    },
  ]);
  assert.equal(resolveWorkflowTemplate("{{vars[服务地址]}}", record), "https://example.test");
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

test("live agent run details capture terminal and JSONL status metadata", async () => {
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
  await details.handleFrame({ type: "status", status: "prompt-sent" });
  await details.handleFrame({ type: "status", status: "waiting-for-choice" });

  assert.equal(writes.length, 5);
  assert.equal(writes[1]?.terminalSessionId, "t_live");
  assert.equal(writes[2]?.conversationSessionId, "conv_live");
  assert.equal(writes[3]?.terminalStatus, "prompt-sent");
  assert.equal(writes[3]?.status, "running");
  assert.equal(writes[3]?.stdout, "");
  assert.equal(writes[4]?.terminalStatus, "waiting-for-choice");
  assert.equal(details.snapshot("running").stdout, "");

  await details.setRetryWait({
    retryAt: 9_000,
    retryAttempt: 1,
    retryReason: "temporary API failure",
  });
  assert.equal(writes.at(-1)?.retryAt, 9_000);
  assert.equal(writes.at(-1)?.retryAttempt, 1);
  assert.equal(writes.at(-1)?.retryReason, "temporary API failure");

  await details.setRetryWait();
  assert.equal(writes.at(-1)?.retryAt, undefined);
  assert.equal(writes.at(-1)?.retryAttempt, undefined);
  assert.equal(writes.at(-1)?.retryReason, undefined);
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

test("workflow scheduler repeats a loop body until its exit is selected", async () => {
  const executed: string[] = [];
  let conditionRuns = 0;
  await scheduleWorkflowNodes(
    ["trigger", "body", "condition", "exit"],
    [
      { id: "trigger-body", from: "trigger", to: "body", passSummary: true },
      { id: "body-condition", from: "body", to: "condition", passSummary: true },
      {
        id: "condition-loop",
        from: "condition",
        to: "body",
        sourceHandle: "true",
        passSummary: true,
      },
      {
        id: "condition-exit",
        from: "condition",
        to: "exit",
        sourceHandle: "false",
        passSummary: true,
      },
    ],
    2,
    async (nodeId) => {
      executed.push(nodeId);
      if (nodeId !== "condition") return undefined;
      conditionRuns += 1;
      return conditionRuns < 3 ? "true" : "false";
    },
  );

  assert.deepEqual(executed, [
    "trigger",
    "body",
    "condition",
    "body",
    "condition",
    "body",
    "condition",
    "exit",
  ]);
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

test("live agent run details do not receive PTY output frames", async () => {
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
  assert.equal(writes.length, 0);
  const last = details.snapshot("running");
  assert.equal(last.stdout, "");
  assert.equal(last.stderr, "");
  assert.equal(last.transcript, "");
});

test("configured retries are honored for structured permanent failures", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "",
      exitCode: 1,
      signal: "error",
      outcome: "error",
      errorMessage: "API Error: 403 Image generation is not enabled for this group",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, false);
  assert.equal(failure.apiFailure, true);
  assert.equal(shouldRetryAgentTerminalFailure(failure, 0, 2, false), true);
  assert.equal(shouldRetryAgentTerminalFailure(failure, 1, 2, false), true);
  assert.equal(shouldRetryAgentTerminalFailure(failure, 2, 2, false), false);
  assert.equal(shouldRetryAgentTerminalFailure(failure, 2, 0, true), true);
});

test("all API status and network failures are eligible for provider rotation", () => {
  const unauthorized = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "",
      exitCode: 1,
      signal: "error",
      outcome: "error",
      errorMessage:
        'unexpected status 401 Unauthorized: {"code":"INVALID_API_KEY","message":"Invalid API key"}',
    },
    "Continue",
  );
  assert.equal(unauthorized.retryable, false);
  assert.equal(unauthorized.apiFailure, true);
  const exhausted = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "",
      exitCode: 1,
      signal: "error",
      outcome: "error",
      errorMessage:
        "exceeded retry limit, last status: 429 Too Many Requests, request id: request_1",
    },
    "Continue",
  );
  assert.equal(exhausted.failed, true);
  assert.equal(exhausted.retryable, true);
  assert.equal(exhausted.apiFailure, true);
  assert.equal(shouldRetryAgentTerminalFailure(exhausted, 0, 2, false), true);
  assert.equal(isAgentApiFailureMessage("API Error: Content block not found"), true);
  assert.equal(isAgentApiFailureMessage("API request failed: upstream disconnected"), true);
  assert.equal(isAgentApiFailureMessage("Request failed with status code 401"), true);
  assert.equal(isAgentApiFailureMessage("Response status: 403 Forbidden"), true);
  assert.equal(isAgentApiFailureMessage("Unable to connect to the API"), true);
  assert.equal(isAgentApiFailureMessage("Failed to connect to api.example.test"), true);
  assert.equal(isAgentApiFailureMessage("error sending request for url"), true);
  assert.equal(
    isAgentApiFailureMessage("fetch failed: getaddrinfo ENOTFOUND api.example.test"),
    true,
  );
  assert.equal(isAgentApiFailureMessage("Tool output could not be parsed"), false);
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

test("agent result uses the structured JSONL error outcome", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "",
      exitCode: 1,
      signal: "error",
      outcome: "error",
      errorMessage: "API Error: Content block not found",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, false);
  assert.equal(failure.apiFailure, true);
});

test("agent result derives retryability from the JSONL error message", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "",
      /* legacy terminal sample retained only as the structured error text */
      errorMessage: [
        "Reconnecting... 1/5 (6s • esc to interrupt)",
        "└ Unexpected status 503 Service Unavailable: No available channel for model",
        "gpt-5.6-luna under group default",
        "› Use /skills to list available skills",
      ].join("\n"),
      exitCode: 1,
      signal: "error",
      outcome: "error",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, true);
  assert.equal(failure.apiFailure, true);
  assert.match(failure.message, /unexpected status 503/i);
});

test("agent result treats a generic JSONL error as non-retryable", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "",
      errorMessage: [
        "Fatal exception while calling provider",
        "› Summarize recent commits",
        "gpt-5.6-luna medium · D:\\demo",
      ].join("\n"),
      exitCode: 1,
      signal: "error",
      outcome: "error",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, true);
  assert.equal(failure.retryable, false);
  assert.equal(failure.apiFailure, false);
  assert.match(failure.message, /Fatal exception/i);
});

test("agent result uses the structured cancelled outcome", () => {
  const cancelled = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "",
      exitCode: 1,
      signal: "cancelled",
      outcome: "cancelled",
      errorMessage: "interrupted",
    },
    "Build a weather crawler",
  );
  assert.equal(cancelled.failed, true);
  assert.equal(cancelled.retryable, false);
  assert.match(cancelled.message, /interrupted/);
});

test("agent result treats a user-rejected tool as a non-failure", () => {
  const rejected = classifyAgentTerminalResultFailure(
    {
      content: "",
      transcript: "Tool error:\nThe user doesn't want to proceed with this tool use.",
      exitCode: 0,
      signal: "user-rejected",
      outcome: "user-rejected",
    },
    "Run an optional tool",
  );
  assert.equal(rejected.failed, false);
  assert.equal(rejected.retryable, false);
});

test("normal auto-finished agent result remains successful", () => {
  const failure = classifyAgentTerminalResultFailure(
    {
      content: "The weather crawler is complete.",
      transcript: "The weather crawler is complete.",
      exitCode: 0,
      signal: "auto-finished",
      outcome: "success",
    },
    "Build a weather crawler",
  );

  assert.equal(failure.failed, false);
});
