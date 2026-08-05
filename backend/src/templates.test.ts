import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  deleteWorkflowTemplate,
  getWorkflowTemplate,
  listWorkflowTemplates,
  saveWorkflowAsTemplate,
  updateTemplateFromWorkflow,
  updateWorkflowTemplateIcon,
} from "./templates.js";
import { createWorkflow } from "./workflows.js";

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
    "iVBORw0KGgo=",
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
    "utf8",
  );

  const library = await listWorkflowTemplates({
    root: userRoot,
    systemSourceRoot: systemRoot,
  });
  const loaded = await getWorkflowTemplate("system", record.id, {
    root: userRoot,
    systemSourceRoot: systemRoot,
  });

  assert.deepEqual(
    library.system.map((template) => template.id),
    [record.id],
  );
  assert.equal(loaded.title, "Developer template");
});

test("system template sync is skipped when source unchanged", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-cache-"));
  const systemSourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-source-"));
  const record = {
    id: "tpl_syncskip001",
    source: "system",
    title: "Cached sync template",
    description: "Loaded from the bundled source library.",
    readme: "# Cached sync template",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  await fs.mkdir(path.join(systemSourceRoot, record.id));
  await fs.writeFile(
    path.join(systemSourceRoot, record.id, "template.json"),
    JSON.stringify(record),
    "utf8",
  );
  const opts = { root, systemSourceRoot };

  await listWorkflowTemplates(opts);
  const marker = path.join(root, ".system-sync.json");
  const st1 = await fs.stat(path.join(root, "system"));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await listWorkflowTemplates(opts);
  const st2 = await fs.stat(path.join(root, "system"));

  assert.ok((await fs.stat(marker)).isFile());
  assert.equal(st1.birthtimeMs, st2.birthtimeMs);
});

test("system template sync detects same-size source changes with preserved mtime", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-bytes-"));
  const systemSourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "osheep-system-sync-bytes-source-"),
  );
  const id = "tpl_syncbytes01";
  const sourceFile = path.join(systemSourceRoot, id, "template.json");
  const record = {
    id,
    source: "system",
    title: "First version",
    description: "Same-size source replacement.",
    readme: "",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  await fs.mkdir(path.dirname(sourceFile));
  const firstContent = JSON.stringify(record);
  await fs.writeFile(sourceFile, firstContent, "utf8");
  const sourceStat = await fs.stat(sourceFile);
  const opts = { root, systemSourceRoot };
  await listWorkflowTemplates(opts);

  const nextContent = JSON.stringify({ ...record, title: "Other version" });
  assert.equal(Buffer.byteLength(nextContent), Buffer.byteLength(firstContent));
  await fs.writeFile(sourceFile, nextContent, "utf8");
  await fs.utimes(sourceFile, sourceStat.atime, sourceStat.mtime);

  const library = await listWorkflowTemplates(opts);

  assert.equal(library.system[0]?.title, "Other version");
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, "system", id, "template.json"), "utf8")).title,
    "Other version",
  );
});

test("concurrent system template reads share a consistent fresh sync", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-concurrent-"));
  const systemSourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "osheep-system-sync-concurrent-source-"),
  );
  const id = "tpl_syncparallel";
  const record = {
    id,
    source: "system",
    title: "Concurrent template",
    description: "Concurrent sync source.",
    readme: "",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  await fs.mkdir(path.join(systemSourceRoot, id));
  await fs.writeFile(
    path.join(systemSourceRoot, id, "template.json"),
    JSON.stringify(record),
    "utf8",
  );
  const opts = { root, systemSourceRoot };

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      index % 2 === 0 ? listWorkflowTemplates(opts) : getWorkflowTemplate("system", id, opts),
    ),
  );

  assert.equal(results.length, 20);
  for (const result of results) {
    if ("system" in result) {
      assert.deepEqual(
        result.system.map((template) => [template.id, template.title]),
        [[id, record.title]],
      );
    } else {
      assert.equal(result.id, id);
      assert.equal(result.title, record.title);
    }
  }
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, "system", id, "template.json"), "utf8")).title,
    record.title,
  );
  const marker = JSON.parse(await fs.readFile(path.join(root, ".system-sync.json"), "utf8"));
  assert.equal(typeof marker.signature, "string");
  assert.ok(marker.signature.length > 0);
});

test("different system sources serialize writes to one runtime root", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-sources-runtime-"));
  const sourceA = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-source-a-"));
  const sourceB = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-source-b-"));
  const id = "tpl_syncsources1";
  const recordA = {
    id,
    source: "system",
    title: "Source A template",
    description: "Serialized source template.",
    readme: "Source A data",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  const recordB = {
    ...recordA,
    title: "Source B template",
    readme: "Source B data",
  };
  for (const [source, record] of [
    [sourceA, recordA],
    [sourceB, recordB],
  ] as const) {
    await fs.mkdir(path.join(source, id));
    await fs.writeFile(path.join(source, id, "template.json"), JSON.stringify(record), "utf8");
  }

  const pendingA = getWorkflowTemplate("system", id, { root, systemSourceRoot: sourceA });
  const pendingB = getWorkflowTemplate("system", id, { root, systemSourceRoot: sourceB });
  const [templateA, templateB] = await Promise.all([pendingA, pendingB]);

  assert.equal(templateA.title, recordA.title);
  assert.equal(templateA.readme, recordA.readme);
  assert.equal(templateB.title, recordB.title);
  assert.equal(templateB.readme, recordB.readme);
  const runtimeTitle = JSON.parse(
    await fs.readFile(path.join(root, "system", id, "template.json"), "utf8"),
  ).title;
  assert.ok(["Source A template", "Source B template"].includes(runtimeTitle));
  const finalSource = runtimeTitle === "Source A template" ? sourceA : sourceB;
  const markerFile = path.join(root, ".system-sync.json");
  const markerBefore = await fs.readFile(markerFile, "utf8");
  const repeated = await listWorkflowTemplates({ root, systemSourceRoot: finalSource });
  assert.equal(repeated.system[0]?.title, runtimeTitle);
  assert.equal(await fs.readFile(markerFile, "utf8"), markerBefore);
});

test("system sync serializes real and linked source path aliases", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-alias-runtime-"));
  const sourceParent = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-alias-source-"));
  const systemSourceRoot = path.join(sourceParent, "actual");
  const sourceAlias = path.join(sourceParent, "alias");
  const id = "tpl_syncpathalias";
  const record = {
    id,
    source: "system",
    title: "Aliased source template",
    description: "Path alias sync source.",
    readme: "",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  await fs.mkdir(path.join(systemSourceRoot, id), { recursive: true });
  await fs.writeFile(
    path.join(systemSourceRoot, id, "template.json"),
    JSON.stringify(record),
    "utf8",
  );
  try {
    await fs.symlink(
      systemSourceRoot,
      sourceAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(code ?? "")) {
      t.skip(`directory links are unavailable: ${code}`);
      return;
    }
    throw error;
  }

  const results = await Promise.all(
    Array.from({ length: 20 }, (_, index) =>
      listWorkflowTemplates({
        root,
        systemSourceRoot: index % 2 === 0 ? systemSourceRoot : sourceAlias,
      }),
    ),
  );

  for (const result of results) {
    assert.deepEqual(
      result.system.map((template) => [template.id, template.title]),
      [[id, record.title]],
    );
  }
  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, "system", id, "template.json"), "utf8")).title,
    record.title,
  );
  const marker = JSON.parse(await fs.readFile(path.join(root, ".system-sync.json"), "utf8"));
  assert.equal(typeof marker.signature, "string");
});

test("system sync serializes missing destination path aliases", async (t) => {
  const destinationParent = await fs.mkdtemp(
    path.join(os.tmpdir(), "osheep-system-sync-destination-alias-"),
  );
  const destinationRoot = path.join(destinationParent, "actual");
  const destinationAlias = path.join(destinationParent, "alias");
  const sourceA = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-destination-a-"));
  const sourceB = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-destination-b-"));
  const id = "tpl_syncdestalias";
  const recordA = {
    id,
    source: "system",
    title: "Destination source A",
    description: "Missing destination alias source.",
    readme: "Destination source A data",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  const recordB = {
    ...recordA,
    title: "Destination source B",
    readme: "Destination source B data",
  };
  for (const [source, record] of [
    [sourceA, recordA],
    [sourceB, recordB],
  ] as const) {
    await fs.mkdir(path.join(source, id));
    await fs.writeFile(path.join(source, id, "template.json"), JSON.stringify(record), "utf8");
  }
  await fs.mkdir(destinationRoot);
  try {
    await fs.symlink(
      destinationRoot,
      destinationAlias,
      process.platform === "win32" ? "junction" : "dir",
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (["EACCES", "EPERM", "ENOSYS", "UNKNOWN"].includes(code ?? "")) {
      t.skip(`directory links are unavailable: ${code}`);
      return;
    }
    throw error;
  }

  const operations = Array.from({ length: 20 }, (_, index) => {
    const useA = index % 2 === 0;
    return getWorkflowTemplate("system", id, {
      root: path.join(useA ? destinationRoot : destinationAlias, "run-1"),
      systemSourceRoot: useA ? sourceA : sourceB,
    }).then((template) => ({ template, expected: useA ? recordA : recordB }));
  });
  const results = await Promise.all(operations);

  for (const { template, expected } of results) {
    assert.equal(template.title, expected.title);
    assert.equal(template.readme, expected.readme);
  }
  const runtimeTemplate = JSON.parse(
    await fs.readFile(path.join(destinationRoot, "run-1", "system", id, "template.json"), "utf8"),
  );
  assert.ok([recordA.title, recordB.title].includes(runtimeTemplate.title));
  assert.equal(
    runtimeTemplate.readme,
    runtimeTemplate.title === recordA.title ? recordA.readme : recordB.readme,
  );
});

test("system sync normalizes missing Windows destination casing", async (t) => {
  if (process.platform !== "win32") {
    t.skip("Windows paths are required");
    return;
  }

  const destinationParent = await fs.mkdtemp(
    path.join(os.tmpdir(), "osheep-system-sync-destination-case-"),
  );
  const sourceA = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-case-a-"));
  const sourceB = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-case-b-"));
  const id = "tpl_syncdestcase";
  const recordA = {
    id,
    source: "system",
    title: "Case source A",
    description: "Missing destination case source.",
    readme: "Case source A data",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  const recordB = {
    ...recordA,
    title: "Case source B",
    readme: "Case source B data",
  };
  for (const [source, record] of [
    [sourceA, recordA],
    [sourceB, recordB],
  ] as const) {
    await fs.mkdir(path.join(source, id));
    await fs.writeFile(path.join(source, id, "template.json"), JSON.stringify(record), "utf8");
  }

  const operations = Array.from({ length: 20 }, (_, index) => {
    const useA = index % 2 === 0;
    return getWorkflowTemplate("system", id, {
      root: path.join(destinationParent, useA ? "RUN-CASE" : "run-case"),
      systemSourceRoot: useA ? sourceA : sourceB,
    }).then((template) => ({ template, expected: useA ? recordA : recordB }));
  });
  const results = await Promise.all(operations);

  for (const { template, expected } of results) {
    assert.equal(template.title, expected.title);
    assert.equal(template.readme, expected.readme);
  }
  const runtimeTemplate = JSON.parse(
    await fs.readFile(
      path.join(destinationParent, "run-case", "system", id, "template.json"),
      "utf8",
    ),
  );
  assert.ok([recordA.title, recordB.title].includes(runtimeTemplate.title));
  assert.equal(
    runtimeTemplate.readme,
    runtimeTemplate.title === recordA.title ? recordA.readme : recordB.readme,
  );
});

test("invalid system sync marker triggers a full recovery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-sync-recovery-"));
  const systemSourceRoot = await fs.mkdtemp(
    path.join(os.tmpdir(), "osheep-system-sync-recovery-source-"),
  );
  const id = "tpl_syncrecover";
  const record = {
    id,
    source: "system",
    title: "Recovered template",
    description: "Recovery source.",
    readme: "",
    createdAt: 1,
    updatedAt: 1,
    nodes: [],
    edges: [],
  };
  await fs.mkdir(path.join(systemSourceRoot, id));
  await fs.writeFile(
    path.join(systemSourceRoot, id, "template.json"),
    JSON.stringify(record),
    "utf8",
  );
  const opts = { root, systemSourceRoot };
  await listWorkflowTemplates(opts);
  await fs.writeFile(path.join(root, ".system-sync.json"), "not json", "utf8");
  await fs.writeFile(
    path.join(root, "system", id, "template.json"),
    JSON.stringify({ ...record, title: "Stale runtime" }),
    "utf8",
  );

  const library = await listWorkflowTemplates(opts);

  assert.equal(library.system[0]?.title, record.title);
  const marker = JSON.parse(await fs.readFile(path.join(root, ".system-sync.json"), "utf8"));
  assert.equal(typeof marker.signature, "string");
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
  const systemSourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-built-in-source-"));
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
    }),
  );
  const saved = await saveWorkflowAsTemplate(workflow, "system", {
    root,
    systemSourceRoot,
    developerMode: true,
  });

  assert.equal(
    JSON.parse(await fs.readFile(path.join(root, "system", saved.id, "template.json"), "utf8"))
      .title,
    "Open source built-in",
  );
  assert.equal(
    JSON.parse(await fs.readFile(path.join(systemSourceRoot, saved.id, "template.json"), "utf8"))
      .readme,
    "# Built in",
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
  const systemSourceRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-icon-source-"));
  const workflowRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-system-icon-flow-"));
  const workflow = await createWorkflow(workflowRoot, {});
  const opts = { root, systemSourceRoot, developerMode: true };
  const template = await saveWorkflowAsTemplate(workflow, "system", opts);

  await updateWorkflowTemplateIcon(
    "system",
    template.id,
    "data:image/png;base64,iVBORw0KGgo=",
    opts,
  );

  assert.equal(
    await fs.readFile(path.join(systemSourceRoot, template.id, "icon.png"), "base64"),
    "iVBORw0KGgo=",
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
    "utf8",
  );

  const library = await listWorkflowTemplates({ root });

  assert.equal(library.user[0]?.id, id);
  assert.equal(
    await fs.readFile(path.join(root, "user", id, "icon.png"), "base64"),
    "iVBORw0KGgo=",
  );
  await assert.rejects(() => fs.access(path.join(root, `${id}.json`)));
});
