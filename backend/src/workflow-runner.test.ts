import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyAgentTerminalFailure,
  createLiveAgentRunDetails,
  nextAgentRetryPrompt,
  type WorkflowRunDetailSnapshot,
} from "./workflow-runner.js";
import type { WorkflowNode } from "./workflows.js";

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
    autoContinue: true,
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

test("codex transient service errors without model output retry the original prompt", () => {
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
  assert.equal(nextAgentRetryPrompt(prompt, failure), prompt);
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
