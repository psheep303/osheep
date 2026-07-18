import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflow, getWorkflow, saveWorkflow } from "./workflows.js";

test("workflow node model can be saved as an empty string", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-model-"));
  const created = await createWorkflow(root, {});
  const record = {
    ...created,
    nodes: created.nodes.map((node, index) =>
      index === 1 ? { ...node, model: "" } : node
    ),
  };

  await saveWorkflow(root, record);
  const loaded = await getWorkflow(root, created.id);

  assert.equal(loaded.nodes[1]?.model, "");
});

test("workflow preserves input node kinds", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-input-"));
  const created = await createWorkflow(root, {});
  const inputNode = {
    ...created.nodes[0]!,
    id: "node_input01",
    kind: "input" as const,
    title: "Input",
    prompt: "hello",
  };

  await saveWorkflow(root, { ...created, nodes: [inputNode] });
  const loaded = await getWorkflow(root, created.id);

  assert.equal(loaded.nodes[0]?.kind, "input");
  assert.equal(loaded.nodes[0]?.prompt, "hello");
});

test("workflow loading removes legacy changed-file and verification output fields", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-output-"));
  const created = await createWorkflow(root, {});
  const legacyOutput = JSON.stringify({
    type: "codex",
    status: "success",
    text: "done",
    CHANGED_FILES: ["weather.py"],
    VERIFICATION: [],
  });

  await saveWorkflow(root, {
    ...created,
    nodes: created.nodes.map((node, index) =>
      index === 1 ? { ...node, rawOutput: legacyOutput, summary: legacyOutput } : node
    ),
  });
  const loaded = await getWorkflow(root, created.id);
  const output = JSON.parse(loaded.nodes[1]?.rawOutput ?? "{}") as Record<string, unknown>;

  assert.equal(output.text, "done");
  assert.equal("CHANGED_FILES" in output, false);
  assert.equal("VERIFICATION" in output, false);
});
