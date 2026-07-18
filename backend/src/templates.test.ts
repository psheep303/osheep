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
  updateTemplateFromWorkflow,
  updateWorkflowTemplateIcon,
} from "./templates.js";

test("template library separates built-in and user templates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-templates-list-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-workflow-"));
  const workflow = await createWorkflow(workflowRoot, {
    title: "My reusable flow",
    readme: "# Reusable",
  });

  const saved = await saveWorkflowAsTemplate(workflow, "user", { root });
  const library = await listWorkflowTemplates({ root });

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

  const saved = await saveWorkflowAsTemplate(workflow, "user", { root });
  const loaded = await getWorkflowTemplate("user", saved.id, { root });

  assert.equal(loaded.readme, "# Template docs");
  assert.equal(loaded.nodes[0]?.status, "idle");
  assert.equal(loaded.nodes[0]?.summary, "");
  assert.deepEqual(loaded.nodes[0]?.config, { keep: true });
});

test("user template icons are stored globally with the template", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-templates-icon-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-icon-source-"));
  const workflow = await createWorkflow(workflowRoot, {});
  const saved = await saveWorkflowAsTemplate(workflow, "user", { root });
  const icon = "data:image/png;base64,iVBORw0KGgo=";

  const updated = await updateWorkflowTemplateIcon("user", saved.id, icon, { root });

  assert.match(updated.icon ?? "", new RegExp(`/api/templates/user/${saved.id}/icon`));
  assert.equal(
    await fs.readFile(path.join(root, "user", saved.id, "icon.png"), "base64"),
    "iVBORw0KGgo="
  );
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
  await fs.mkdir(path.join(systemRoot, record.id));
  await fs.writeFile(
    path.join(systemRoot, record.id, "template.json"),
    JSON.stringify(record),
    "utf8"
  );

  const library = await listWorkflowTemplates({
    root: userRoot,
    systemSourceRoot: systemRoot,
  });
  const loaded = await getWorkflowTemplate("system", record.id, {
    root: userRoot,
    systemSourceRoot: systemRoot,
  });

  assert.deepEqual(library.system.map((template) => template.id), [record.id]);
  assert.equal(loaded.title, "Developer template");
});

test("user templates can be deleted without affecting system templates", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-delete-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-delete-source-"));
  const workflow = await createWorkflow(workflowRoot, {});
  const saved = await saveWorkflowAsTemplate(workflow, "user", { root });

  await deleteWorkflowTemplate("user", saved.id, { root });

  const library = await listWorkflowTemplates({ root });
  assert.equal(library.user.length, 0);
  await assert.rejects(() => getWorkflowTemplate("user", saved.id, { root }));
  assert.ok(library.system.length > 0);
});

test("developer mode saves built-in templates to runtime and source libraries", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-built-in-runtime-"));
  const systemSourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "osheep-built-in-source-")
  );
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-built-in-flow-"));
  const workflow = await createWorkflow(workflowRoot, {
    title: "Open source built-in",
    readme: "# Built in",
  });

  await assert.rejects(() =>
    saveWorkflowAsTemplate(workflow, "system", {
      root,
      systemSourceRoot,
      developerMode: false,
    })
  );
  const saved = await saveWorkflowAsTemplate(workflow, "system", {
    root,
    systemSourceRoot,
    developerMode: true,
  });

  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(root, "system", saved.id, "template.json"),
        "utf8"
      )
    ).title,
    "Open source built-in"
  );
  assert.equal(
    JSON.parse(
      await fs.readFile(
        path.join(systemSourceRoot, saved.id, "template.json"),
        "utf8"
      )
    ).readme,
    "# Built in"
  );
});

test("bound workflow edits are written back to their template", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-binding-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-binding-flow-"));
  const workflow = await createWorkflow(workflowRoot, { title: "Original" });
  const template = await saveWorkflowAsTemplate(workflow, "user", { root });
  const bound = {
    ...workflow,
    title: "Edited template",
    readme: "# Edited README",
    templateBinding: { source: "user" as const, id: template.id },
  };

  await updateTemplateFromWorkflow(bound, { root });
  const updated = await getWorkflowTemplate("user", template.id, { root });

  assert.equal(updated.title, "Edited template");
  assert.equal(updated.readme, "# Edited README");
});

test("system template icons are copied into the open-source source library", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-icon-runtime-"));
  const systemSourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "osheep-system-icon-source-")
  );
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-icon-flow-"));
  const workflow = await createWorkflow(workflowRoot, {});
  const opts = { root, systemSourceRoot, developerMode: true };
  const template = await saveWorkflowAsTemplate(workflow, "system", opts);

  await updateWorkflowTemplateIcon(
    "system",
    template.id,
    "data:image/png;base64,iVBORw0KGgo=",
    opts
  );

  assert.equal(
    await fs.readFile(path.join(systemSourceRoot, template.id, "icon.png"), "base64"),
    "iVBORw0KGgo="
  );
});

test("legacy flat user templates and embedded icons migrate into template folders", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-template-migrate-"));
  const id = "tpl_legacyicon1";
  await fs.writeFile(
    path.join(root, `${id}.json`),
    JSON.stringify({
      id,
      title: "Legacy template",
      readme: "# Legacy",
      icon: "data:image/png;base64,iVBORw0KGgo=",
      nodes: [],
      edges: [],
    }),
    "utf8"
  );

  const library = await listWorkflowTemplates({ root });

  assert.equal(library.user[0]?.id, id);
  assert.equal(
    await fs.readFile(path.join(root, "user", id, "icon.png"), "base64"),
    "iVBORw0KGgo="
  );
  await assert.rejects(() => fs.access(path.join(root, `${id}.json`)));
});
