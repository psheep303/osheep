import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  createWorkflow,
  findWorkflowByTemplateBinding,
  getWorkflow,
  listWorkflowIdsByTemplateBinding,
  listWorkflows,
  saveWorkflow,
} from "./workflows.js";

test("workflow node model can be saved as an empty string", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-model-"));
  const created = await createWorkflow(root, {});
  const record = {
    ...created,
    nodes: created.nodes.map((node, index) => (index === 1 ? { ...node, model: "" } : node)),
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
      index === 1 ? { ...node, rawOutput: legacyOutput, summary: legacyOutput } : node,
    ),
  });
  const loaded = await getWorkflow(root, created.id);
  const output = JSON.parse(loaded.nodes[1]?.rawOutput ?? "{}") as Record<string, unknown>;

  assert.equal(output.text, "done");
  assert.equal("CHANGED_FILES" in output, false);
  assert.equal("VERIFICATION" in output, false);
});

test("workflow README is persisted inside the workflow JSON record", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-readme-"));
  const created = await createWorkflow(root, {
    title: "Documented workflow",
    readme: "# Purpose\n\nExplain this workflow.",
  });

  const loaded = await getWorkflow(root, created.id);

  assert.equal(loaded.readme, "# Purpose\n\nExplain this workflow.");
});

test("template editing workflows are reusable but hidden from the workflow menu", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-editor-"));
  const created = await createWorkflow(root, {
    title: "Template editor",
    templateBinding: { source: "user", id: "tpl_editorflow1" },
  });

  assert.deepEqual(await listWorkflows(root), []);
  assert.equal(
    (await findWorkflowByTemplateBinding(root, "user", "tpl_editorflow1"))?.id,
    created.id,
  );
  assert.deepEqual(await listWorkflowIdsByTemplateBinding(root, "user", "tpl_editorflow1"), [
    created.id,
  ]);
});
