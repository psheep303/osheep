import assert from "node:assert/strict";
import test from "node:test";

async function loadBehavior() {
  return import("./workflow-behavior.ts").catch(() => null);
}

function node(kind: string, providerKind = "codex-cli", config: Record<string, unknown> = {}) {
  return {
    id: `node-${kind}`,
    blockId: 7,
    kind,
    title: kind,
    providerKind,
    model: "default",
    prompt: "",
    config,
    x: 0,
    y: 0,
    status: "idle",
  };
}

test("unrun Claude output keeps known values and typed empty values", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.deepEqual(behavior.emptyBlockOutput(node("agent", "claude-cli") as never), {
    type: "claude",
    status: "",
    text: "",
    CHANGED_FILES: [],
    VERIFICATION: [],
  });
});

test("every workflow kind has a standard empty output", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const expectedTypes = new Map([
    ["agent", "codex"],
    ["input", "input"],
    ["trigger", "trigger"],
    ["manual-trigger", "manual-trigger"],
    ["cron", "cron"],
    ["webhook-trigger", "webhook-trigger"],
    ["command", "command"],
    ["web", "web"],
    ["http-request", "http-request"],
    ["set", "set"],
    ["if", "if"],
    ["merge", "merge"],
    ["code", "code"],
    ["loop-items", "loop-items"],
    ["wait", "wait"],
    ["json", "json"],
    ["file-read", "file-read"],
    ["file-write", "file-write"],
    ["markdown", "markdown"],
    ["mcp", "mcp"],
  ]);

  for (const [kind, type] of expectedTypes) {
    const output = behavior.emptyBlockOutput(node(kind) as never);
    assert.equal(output.type, type, `${kind} should expose its concrete output type`);
    assert.equal(output.status, "", `${kind} should have an empty runtime status`);
    assert.deepEqual(output.CHANGED_FILES, [], `${kind} should have an empty file list`);
  }
});

test("empty output values preserve their JSON types", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const command = behavior.emptyBlockOutput(node("command") as never);
  const http = behavior.emptyBlockOutput(node("http-request") as never);
  const input = behavior.emptyBlockOutput(node("input") as never);
  const merge = behavior.emptyBlockOutput(node("merge", "codex-cli", { mode: "object" }) as never);

  assert.equal(input.value, "");
  assert.equal(input.data, "");
  assert.equal(input.text, "");
  assert.equal(command.stdout, "");
  assert.equal(command.exitCode, null);
  assert.equal(command.truncated, null);
  assert.deepEqual(http.headers, {});
  assert.equal(http.ok, null);
  assert.deepEqual(merge.data, {});
  assert.deepEqual(merge.items, []);
});

test("inspector output prefers real node state before the empty schema", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const base = node("agent", "claude-cli");

  assert.equal(behavior.blockOutputText({ ...base, rawOutput: "raw" } as never), "raw");
  assert.equal(behavior.blockOutputText({ ...base, summary: "summary" } as never), "summary");
  assert.equal(behavior.blockOutputText({ ...base, error: "error" } as never), "error");
  assert.equal(
    behavior.blockOutputText(base as never),
    JSON.stringify(behavior.emptyBlockOutput(base as never), null, 2)
  );
});

test("workflow refresh applies only when its local revision is still current", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.equal(typeof behavior.canApplyWorkflowRefresh, "function");

  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 4,
      dragging: false,
      pendingSave: false,
    }),
    true
  );
  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 5,
      dragging: false,
      pendingSave: false,
    }),
    false
  );
});

test("workflow refresh is rejected during a drag or pending save", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.equal(typeof behavior.canApplyWorkflowRefresh, "function");

  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 4,
      dragging: true,
      pendingSave: false,
    }),
    false
  );
  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 4,
      dragging: false,
      pendingSave: true,
    }),
    false
  );
});
