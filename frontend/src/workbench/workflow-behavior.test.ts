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
  });
});

test("workflow agent durations use hours minutes and seconds", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.equal(behavior.formatWorkflowDuration(0), "0h0m0s");
  assert.equal(behavior.formatWorkflowDuration(1_211_156), "0h20m11s");
  assert.equal(behavior.formatWorkflowDuration(3_661_000), "1h1m1s");
});

test("workflow token counts use compact k, m, and b suffixes", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.equal(behavior.formatCompactTokenCount(620), "620");
  assert.equal(behavior.formatCompactTokenCount(44_132), "44.1k");
  assert.equal(behavior.formatCompactTokenCount(2_450_000), "2.45m");
  assert.equal(behavior.formatCompactTokenCount(1_200_000_000), "1.2b");
});

test("every workflow kind has a standard empty output", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const expectedTypes = new Map([
    ["agent", "codex"],
    ["input", "input"],
    ["variable", "variable"],
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
    ["codex-plugin", "codex-plugin"],
    ["claude-plugin", "claude-plugin"],
    ["codex-skill", "codex-skill"],
    ["claude-skill", "claude-skill"],
  ]);

  for (const [kind, type] of expectedTypes) {
    const output = behavior.emptyBlockOutput(node(kind) as never);
    assert.equal(output.type, type, `${kind} should expose its concrete output type`);
    assert.equal(output.status, "", `${kind} should have an empty runtime status`);
    assert.equal("CHANGED_FILES" in output, false, `${kind} should omit CHANGED_FILES`);
    assert.equal("VERIFICATION" in output, false, `${kind} should omit VERIFICATION`);
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

test("environment variable output exposes every configured variable", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const output = behavior.emptyBlockOutput(
    node("variable", "codex-cli", {
      variables: [
        { name: "first", value: "one", type: "text" },
        { name: "second", value: "", type: "json" },
      ],
    }) as never,
  );

  assert.equal(output.name, "first");
  assert.deepEqual(output.variables, { first: "", second: "" });
  assert.deepEqual(output.variableTypes, { first: "text", second: "json" });
  assert.deepEqual(output.data, { first: "", second: "" });
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
    JSON.stringify(behavior.emptyBlockOutput(base as never), null, 2),
  );
});

test("inspector removes legacy changed-file and verification metadata", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const base = node("agent", "codex-cli");
  assert.equal(
    behavior.blockOutputText({
      ...base,
      rawOutput: JSON.stringify({
        type: "codex",
        status: "success",
        text: "done",
        CHANGED_FILES: ["weather.py"],
        VERIFICATION: [],
      }),
    } as never),
    JSON.stringify({ type: "codex", status: "success", text: "done" }, null, 2),
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
    true,
  );
  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 5,
      dragging: false,
      pendingSave: false,
    }),
    false,
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
    false,
  );
  assert.equal(
    behavior.canApplyWorkflowRefresh({
      requestedRevision: 4,
      currentRevision: 4,
      dragging: false,
      pendingSave: true,
    }),
    false,
  );
});

test("completed markdown auto preview works for runtime events and opens once", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const running = {
    ...node("markdown", "codex-cli", { autoSeeResult: true }),
    status: "running",
  };
  const completed = { ...running, status: "success", completedAt: 2_000 };
  const seen = new Set<string>();

  assert.equal(
    behavior.findMarkdownAutoPreviewNode([running] as never, [completed] as never, seen, 1_000)?.id,
    completed.id,
  );
  seen.add(`${completed.id}:${completed.completedAt}`);
  assert.equal(
    behavior.findMarkdownAutoPreviewNode([running] as never, [completed] as never, seen, 1_000),
    undefined,
  );
});

test("workflow session ids use the UUID format shared by Claude and Codex", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  assert.equal(behavior.isWorkflowSessionId("550e8400-e29b-41d4-a716-446655440000"), true);
  assert.equal(behavior.isWorkflowSessionId("not-a-session"), false);
  assert.equal(
    behavior.workflowSessionId(
      node("agent", "codex-cli", { sessionId: " 550e8400-e29b-41d4-a716-446655440000 " }) as never,
    ),
    "550e8400-e29b-41d4-a716-446655440000",
  );
});

test("external workflow renames replace stale titles without changing editor content", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const record = {
    id: "wf_title01",
    title: "Old title",
    readme: "edited locally",
    createdAt: 1,
    updatedAt: 2,
    nodes: [node("command")],
    edges: [],
    runs: [],
  };

  const renamed = behavior.withWorkflowTitle(record as never, "New title");
  assert.equal(renamed.title, "New title");
  assert.equal(renamed.readme, "edited locally");
  assert.equal(renamed.nodes, record.nodes);
});

test("workflow back edges are the edges that close a directed cycle", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const edges = [
    { id: "ab", from: "a", to: "b", passSummary: true },
    { id: "bc", from: "b", to: "c", passSummary: true },
    { id: "ca", from: "c", to: "a", passSummary: true },
    { id: "cd", from: "c", to: "d", passSummary: true },
    { id: "self", from: "d", to: "d", passSummary: true },
  ];
  assert.deepEqual([...behavior.findWorkflowBackEdgeIds(edges as never)], ["ca", "self"]);
});

test("workflow back edge detection follows graph roots instead of persisted edge order", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const edges = [
    { id: "condition-loop", from: "condition", to: "body", passSummary: true },
    { id: "condition-exit", from: "condition", to: "exit", passSummary: true },
    { id: "body-condition", from: "body", to: "condition", passSummary: true },
    { id: "trigger-body", from: "trigger", to: "body", passSummary: true },
  ];

  assert.deepEqual([...behavior.findWorkflowBackEdgeIds(edges as never)], ["condition-loop"]);
});

test("workflow layout ranks cyclic graphs after removing their back edges", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const nodes = ["a", "b", "c", "d", "detached"].map((id) => ({
    ...node("command"),
    id,
  }));
  const edges = [
    { id: "ab", from: "a", to: "b", passSummary: true },
    { id: "bc", from: "b", to: "c", passSummary: true },
    { id: "ca", from: "c", to: "a", passSummary: true },
    { id: "cd", from: "c", to: "d", passSummary: true },
    { id: "self", from: "d", to: "d", passSummary: true },
  ];

  assert.deepEqual(
    Object.fromEntries(behavior.workflowLayoutDepths(nodes as never, edges as never)),
    { a: 0, detached: 0, b: 1, c: 2, d: 3 },
  );
});

test("workflow layout reorders branches to remove avoidable crossings", async () => {
  const behavior = await loadBehavior();
  assert.ok(behavior, "workflow behavior module should exist");
  const nodes = ["left-top", "left-bottom", "right-top", "right-bottom"].map((id) => ({
    ...node("command"),
    id,
  }));
  const edges = [
    { id: "down", from: "left-top", to: "right-bottom", passSummary: true },
    { id: "up", from: "left-bottom", to: "right-top", passSummary: true },
  ];

  assert.deepEqual(behavior.workflowLayoutColumns(nodes as never, edges as never), [
    ["left-top", "left-bottom"],
    ["right-bottom", "right-top"],
  ]);
});
