import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAgentTerminalFailure,
  createLiveAgentRunDetails,
  nextAgentRetryPrompt,
  planWorkflowRunNodeIds,
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

  assert.deepEqual(planWorkflowRunNodeIds(record).nodeIds, [
    "node_trigger",
    "node_codex",
  ]);
});

function workflowNode(
  id: string,
  kind: WorkflowNode["kind"],
  title: string,
  providerKind: WorkflowNode["providerKind"] = "codex-cli"
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
    minUpdateIntervalMs: 0,
    writeSnapshot: async (snapshot) => {
      writes.push(snapshot);
    },
  });

  await details.update("running");
  await details.handleFrame({ type: "session", sessionId: "t_live" });
  await details.handleFrame({ type: "output", data: "first chunk\n" });
  await details.handleFrame({ type: "status", status: "ready" });

  assert.equal(writes.length, 4);
  assert.equal(writes[1]?.terminalSessionId, "t_live");
  assert.equal(writes[2]?.stdout, "first chunk\n");
  assert.match(writes[2]?.transcript ?? "", /\[stdout\] first chunk/);
  assert.equal(writes[3]?.terminalStatus, "ready");
  assert.equal(writes[3]?.status, "running");
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
    prompt
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
    prompt
  );

  assert.equal(failure.retryable, true);
  assert.equal(failure.hasModelOutput, true);
  assert.equal(nextAgentRetryPrompt(prompt, failure), "继续");
});
