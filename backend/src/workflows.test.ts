import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import {
  createWorkflow,
  findWorkflowByTemplateBinding,
  getWorkflow,
  listWorkflowIdsByTemplateBinding,
  listWorkflows,
  saveWorkflow,
  updateWorkflow,
} from "./workflows.js";

test("workflow GET routes support ETag revalidation", async () => {
  const workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-etag-"));
  const workspaceRoot = path.join(workspacesRoot, "demo");
  const previousWorkspacesRoot = config.workspacesRoot;
  const app = Fastify();

  try {
    config.workspacesRoot = workspacesRoot;
    await fs.mkdir(workspaceRoot);
    const workflow = await createWorkflow(workspaceRoot, { title: "Cached workflow" });
    await registerWorkflowRoutes(app);

    for (const url of [
      "/api/workspaces/demo/workflows",
      `/api/workspaces/demo/workflows/${workflow.id}`,
    ]) {
      const first = await app.inject({ method: "GET", url });
      assert.equal(first.statusCode, 200);
      assert.match(first.headers["content-type"] ?? "", /^application\/json/);
      const etag = first.headers.etag;
      assert.ok(etag);

      const second = await app.inject({
        method: "GET",
        url,
        headers: { "if-none-match": etag },
      });

      assert.equal(second.statusCode, 304);
      assert.equal(second.body, "");
      assert.equal(second.headers.etag, etag);
    }
  } finally {
    config.workspacesRoot = previousWorkspacesRoot;
    await app.close();
    await fs.rm(workspacesRoot, { recursive: true, force: true });
  }
});

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

test("workflow run observability trace is persisted", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-trace-"));
  const created = await createWorkflow(root, {});
  const node = created.nodes[0]!;
  await saveWorkflow(root, {
    ...created,
    runs: [
      {
        id: "run_trace01",
        status: "success",
        startedAt: 100,
        completedAt: 220,
        nodeIds: [node.id],
        trace: [
          {
            nodeId: node.id,
            title: node.title,
            kind: node.kind,
            status: "success",
            startedAt: 100,
            completedAt: 220,
            durationMs: 120,
            input: { value: "hello" },
            output: { text: "done" },
            retryReasons: ["rate limited"],
            tokens: { total: 42 },
            cost: 0.001,
          },
        ],
        stats: { durationMs: 120, totalTokens: 42, cost: 0.001, retryCount: 1 },
      },
    ],
  });

  const loaded = await getWorkflow(root, created.id);
  assert.equal(
    loaded.runs[0]?.trace?.[0]?.output &&
      (loaded.runs[0]!.trace![0]!.output as { text: string }).text,
    "done",
  );
  assert.equal(loaded.runs[0]?.stats?.totalTokens, 42);
});

test("concurrent workflow updates preserve both node-runner patches", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-updates-"));
  try {
    const created = await createWorkflow(root, { title: "Initial", readme: "Initial" });
    await Promise.all([
      updateWorkflow(root, created.id, async (record) => {
        await new Promise<void>((resolve) => setTimeout(resolve, 5));
        return { ...record, title: "Updated title" };
      }),
      updateWorkflow(root, created.id, (record) => ({ ...record, readme: "Updated readme" })),
    ]);

    const loaded = await getWorkflow(root, created.id);
    assert.equal(loaded.title, "Updated title");
    assert.equal(loaded.readme, "Updated readme");
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
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
