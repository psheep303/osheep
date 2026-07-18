import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { createWorkflow } from "./workflows.js";
import {
  getWorkflowTemplate,
  deleteWorkflowTemplate,
  listWorkflowTemplates,
  saveWorkflowAsTemplate,
  updateWorkflowTemplateIcon,
} from "./templates.js";

test("template library separates built-in and user templates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-templates-list-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-workflow-"));
  const workflow = await createWorkflow(workflowRoot, {
    title: "My reusable flow",
    readme: "# Reusable",
  });

  const saved = await saveWorkflowAsTemplate(workflow, root);
  const library = await listWorkflowTemplates(root);

  assert.ok(library.system.length >= 1);
  assert.equal(library.user.length, 1);
  assert.equal(library.user[0]?.id, saved.id);
  assert.equal(library.user[0]?.title, "My reusable flow");
});

test("saved templates keep README and remove workflow runtime state", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-templates-save-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-source-"));
  const workflow = await createWorkflow(workflowRoot, { readme: "# Template docs" });
  workflow.nodes[0] = {
    ...workflow.nodes[0]!,
    status: "success",
    summary: "runtime summary",
    config: { runDetails: { status: "success" }, keep: true },
  };

  const saved = await saveWorkflowAsTemplate(workflow, root);
  const loaded = await getWorkflowTemplate("user", saved.id, root);

  assert.equal(loaded.readme, "# Template docs");
  assert.equal(loaded.nodes[0]?.status, "idle");
  assert.equal(loaded.nodes[0]?.summary, "");
  assert.deepEqual(loaded.nodes[0]?.config, { keep: true });
});

test("user template icons are stored globally with the template", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-templates-icon-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-icon-source-"));
  const workflow = await createWorkflow(workflowRoot, {});
  const saved = await saveWorkflowAsTemplate(workflow, root);
  const icon = "data:image/png;base64,iVBORw0KGgo=";

  const updated = await updateWorkflowTemplateIcon(saved.id, icon, root);

  assert.equal(updated.icon, icon);
  assert.equal((await getWorkflowTemplate("user", saved.id, root)).icon, icon);
});

test("developers can replace system templates with editable JSON files", async () => {
  const userRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-user-"));
  const systemRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-json-"));
  const record = {
    id: "tpl_devmade001",
    source: "system",
    title: "Developer template",
    description: "Loaded from an editable JSON file.",
    readme: "# Developer template",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  await fs.writeFile(
    path.join(systemRoot, `${record.id}.json`),
    JSON.stringify(record),
    "utf8"
  );

  const library = await listWorkflowTemplates(userRoot, systemRoot);
  const loaded = await getWorkflowTemplate("system", record.id, userRoot, systemRoot);

  assert.deepEqual(library.system.map((template) => template.id), [record.id]);
  assert.equal(loaded.title, "Developer template");
});

test("user templates can be deleted without affecting system templates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-delete-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-delete-source-"));
  const workflow = await createWorkflow(workflowRoot, {});
  const saved = await saveWorkflowAsTemplate(workflow, root);

  await deleteWorkflowTemplate(saved.id, root);

  const library = await listWorkflowTemplates(root);
  assert.equal(library.user.length, 0);
  await assert.rejects(() => getWorkflowTemplate("user", saved.id, root));
  assert.ok(library.system.length > 0);
});
