import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerWorkflowRoutes } from "./routes/workflows.js";
import { startWorkflowRun } from "./workflow-runner.js";
import {
  createWorkflow,
  deleteWorkflow,
  findWorkflowByTemplateBinding,
  getAllProjectsWorkflowUsage,
  getWorkflow,
  getWorkflowUsageStatistics,
  listWorkflowIdsByTemplateBinding,
  listWorkflows,
  recordWorkflowUsageSnapshot,
  sanitizeWorkflowSettings,
  saveWorkflow,
  updateWorkflow,
} from "./workflows.js";
import { markWorkspaceOpened } from "./workspace.js";

test("workflow settings use safe defaults and disable cost limits when unbilled", () => {
  assert.deepEqual(sanitizeWorkflowSettings(undefined), {
    unbilled: false,
    maxRunCost: 0,
    maxRunDurationSeconds: 0,
    sounds: {
      nodeSuccess: false,
      nodeError: false,
      waitingForChoice: true,
      runCompleted: false,
    },
  });
  assert.deepEqual(
    sanitizeWorkflowSettings({
      unbilled: true,
      maxRunCost: 12,
      maxRunDurationSeconds: 30,
      sounds: { nodeError: true, waitingForChoice: false },
    }),
    {
      unbilled: true,
      maxRunCost: 0,
      maxRunDurationSeconds: 30,
      sounds: {
        nodeSuccess: false,
        nodeError: true,
        waitingForChoice: false,
        runCompleted: false,
      },
    },
  );
});

test("workflow duration limits fail the active block and the run", async () => {
  const workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-duration-limit-"));
  const workspaceRoot = path.join(workspacesRoot, "demo");
  const previousWorkspacesRoot = config.workspacesRoot;
  try {
    config.workspacesRoot = workspacesRoot;
    await fs.mkdir(workspaceRoot);
    const workflow = await createWorkflow(workspaceRoot, {
      title: "Limited run",
      settings: {
        ...sanitizeWorkflowSettings(undefined),
        maxRunDurationSeconds: 0.02,
      },
      nodes: [
        {
          id: "node_waiting",
          blockId: 1,
          kind: "wait",
          title: "Wait",
          providerKind: "codex-cli",
          model: "default",
          prompt: "",
          x: 0,
          y: 0,
          status: "idle",
          config: { seconds: 0.2 },
        },
      ],
      edges: [],
    });
    const started = await startWorkflowRun("demo", workflow.id, ["node_waiting"], "en");
    let completed = started.workflow;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      completed = await getWorkflow(workspaceRoot, workflow.id);
      if (completed.runs.find((run) => run.id === started.runId)?.status !== "running") break;
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }

    const run = completed.runs.find((item) => item.id === started.runId);
    assert.equal(run?.status, "error");
    assert.match(run?.error ?? "", /duration exceeded/i);
    assert.equal(completed.nodes[0]?.status, "error");
    assert.match(completed.nodes[0]?.error ?? "", /duration exceeded/i);
  } finally {
    config.workspacesRoot = previousWorkspacesRoot;
    await fs.rm(workspacesRoot, { recursive: true, force: true });
  }
});

test("unbilled workflows keep usage but exclude current and historical costs", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-unbilled-workflow-"));
  const previousWorkflowUsageFile = config.workflowUsageFile;
  try {
    config.workflowUsageFile = path.join(root, "workflow-usage.json");
    const workflow = await createWorkflow(root, { title: "Internal automation" });
    const run = {
      id: "run_unbilled",
      status: "success" as const,
      startedAt: 100,
      completedAt: 200,
      nodeIds: ["node_usage"],
      stats: { totalTokens: 200, cost: 0.5 },
      trace: [
        {
          nodeId: "node_usage",
          title: "Usage",
          kind: "agent" as const,
          model: "test-model",
          status: "success" as const,
          startedAt: 100,
          completedAt: 200,
          tokens: { total: 200 },
          cost: 0.5,
        },
      ],
    };
    await recordWorkflowUsageSnapshot(root, workflow, run);
    await updateWorkflow(root, workflow.id, (current) => ({
      ...current,
      runs: [run],
      settings: { ...current.settings!, unbilled: true, maxRunCost: 0 },
    }));

    const unbilledWorkflow = await getWorkflow(root, workflow.id);
    assert.equal(unbilledWorkflow.runs[0]?.trace?.[0]?.cost, undefined);
    assert.equal(unbilledWorkflow.runs[0]?.stats?.cost, undefined);

    const usage = await getWorkflowUsageStatistics(root, { range: "all", now: 1_000 });
    assert.equal(usage.totals.runs, 1);
    assert.equal(usage.totals.totalTokens, 200);
    assert.equal(usage.totals.cost, 0);
    assert.equal(usage.workflows[0]?.cost, 0);
    assert.equal(usage.models[0]?.cost, 0);
    assert.equal(usage.recentRuns[0]?.cost, 0);
  } finally {
    config.workflowUsageFile = previousWorkflowUsageFile;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("all-project workflow usage sums opened project totals without exposing details", async () => {
  const sandbox = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-all-project-usage-"));
  const firstRoot = path.join(sandbox, "first");
  const secondRoot = path.join(sandbox, "second");
  const previousWorkflowUsageFile = config.workflowUsageFile;
  try {
    config.workflowUsageFile = path.join(sandbox, "workflow-usage.json");
    await fs.mkdir(firstRoot);
    await fs.mkdir(secondRoot);
    const first = await createWorkflow(firstRoot, {
      title: "First workflow",
      runs: [
        {
          id: "run_first",
          status: "success",
          startedAt: 100,
          nodeIds: [],
          stats: { totalTokens: 120, inputTokens: 80, outputTokens: 40, cost: 0.2 },
          trace: [
            {
              nodeId: "node_first",
              title: "First",
              kind: "agent",
              model: "model-a",
              status: "success",
              startedAt: 100,
              tokens: { total: 120, input: 80, output: 40 },
              cost: 0.2,
            },
          ],
        },
      ],
    });
    const second = await createWorkflow(secondRoot, {
      title: "Second workflow",
      runs: [
        {
          id: "run_second",
          status: "success",
          startedAt: 110,
          nodeIds: [],
          stats: { totalTokens: 300, inputTokens: 200, outputTokens: 100, cost: 0.7 },
          trace: [
            {
              nodeId: "node_second",
              title: "Second",
              kind: "agent",
              model: "model-b",
              status: "success",
              startedAt: 110,
              tokens: { total: 300, input: 200, output: 100 },
              cost: 0.7,
            },
          ],
        },
      ],
    });

    const beforeRecording = await getAllProjectsWorkflowUsage([firstRoot, secondRoot], {
      range: "all",
      now: 200,
    });
    assert.equal(beforeRecording.totals.totalTokens, 0);

    await recordWorkflowUsageSnapshot(firstRoot, first, first.runs[0]!);
    await recordWorkflowUsageSnapshot(secondRoot, second, second.runs[0]!);

    const usage = await getAllProjectsWorkflowUsage([firstRoot, secondRoot], {
      range: "all",
      now: 200,
    });

    assert.equal(usage.projectCount, 2);
    assert.equal(usage.totals.totalTokens, 420);
    assert.ok(Math.abs(usage.totals.cost - 0.9) < Number.EPSILON);
    assert.equal("workflows" in usage, false);
    assert.equal("recentRuns" in usage, false);
  } finally {
    config.workflowUsageFile = previousWorkflowUsageFile;
    await fs.rm(sandbox, { recursive: true, force: true });
  }
});

test("workflow usage statistics aggregate runs by date, workflow, and model", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-usage-"));
  const now = Date.UTC(2026, 7, 20, 12);
  const previousWorkflowUsageFile = config.workflowUsageFile;

  try {
    config.workflowUsageFile = path.join(root, "workflow-usage.json");
    const first = await createWorkflow(root, { title: "Daily report" });
    const second = await createWorkflow(root, { title: "Release notes" });
    const buildRun = (startedAt: number, model: string, cost: number) => ({
      id: "run_shared",
      status: "success" as const,
      startedAt,
      completedAt: startedAt + 1000,
      nodeIds: [first.nodes[0]!.id],
      stats: {
        inputTokens: 100,
        outputTokens: 40,
        cacheReadTokens: 20,
        cacheWriteTokens: 10,
        totalTokens: 140,
        cost,
      },
      trace: [
        {
          nodeId: first.nodes[0]!.id,
          title: "Agent",
          kind: "agent" as const,
          model,
          status: "success" as const,
          startedAt,
          completedAt: startedAt + 1000,
          tokens: { input: 100, output: 40, cacheRead: 20, cacheWrite: 10, total: 140 },
          cost,
        },
      ],
    });
    const savedFirst = await saveWorkflow(root, {
      ...first,
      runs: [
        buildRun(Date.UTC(2026, 7, 19, 3), "gpt-5", 0.25),
        { ...buildRun(Date.UTC(2026, 6, 1, 3), "old-model", 9), id: "run_old" },
      ],
    });
    const savedSecond = await saveWorkflow(root, {
      ...second,
      runs: [buildRun(Date.UTC(2026, 7, 20, 3), "gpt-5", 0.5)],
    });

    assert.equal(
      (await getWorkflowUsageStatistics(root, { range: "all", now })).totals.totalTokens,
      0,
    );
    await recordWorkflowUsageSnapshot(root, savedFirst, savedFirst.runs[0]!);
    await recordWorkflowUsageSnapshot(root, savedSecond, savedSecond.runs[0]!);
    await deleteWorkflow(root, savedFirst.id);

    const usage = await getWorkflowUsageStatistics(root, {
      range: "7d",
      timezoneOffsetMinutes: -480,
      now,
    });

    assert.deepEqual(usage.totals, {
      runs: 2,
      inputTokens: 200,
      outputTokens: 80,
      cacheReadTokens: 40,
      cacheWriteTokens: 20,
      totalTokens: 280,
      cost: 0.75,
    });
    assert.deepEqual(
      usage.daily.filter((day) => day.runs > 0).map((day) => [day.date, day.runs, day.tokens]),
      [
        ["2026-08-19", 1, 140],
        ["2026-08-20", 1, 140],
      ],
    );
    assert.equal(usage.workflows.length, 2);
    assert.equal(usage.models[0]?.model, "gpt-5");
    assert.equal(usage.models[0]?.runs, 2);
    assert.equal(usage.models[0]?.tokens, 280);
    assert.equal(usage.recentRuns[0]?.workflowTitle, "Release notes");
  } finally {
    config.workflowUsageFile = previousWorkflowUsageFile;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow usage snapshots are monotonic and idempotent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-usage-price-"));
  const previousWorkflowUsageFile = config.workflowUsageFile;
  try {
    config.workflowUsageFile = path.join(root, "workflow-usage.json");
    const workflow = await createWorkflow(root, { title: "Legacy usage" });
    const node = workflow.nodes[0]!;
    const saved = await saveWorkflow(root, {
      ...workflow,
      runs: [
        {
          id: "run_legacy",
          status: "success",
          startedAt: 100,
          nodeIds: [node.id],
          trace: [
            {
              nodeId: node.id,
              title: node.title,
              kind: "agent",
              model: "legacy-model",
              status: "success",
              startedAt: 100,
              tokens: { input: 1_000_000, output: 0, total: 1_000_000 },
              cost: 4,
            },
          ],
        },
      ],
    });
    await recordWorkflowUsageSnapshot(root, saved, saved.runs[0]!);
    await recordWorkflowUsageSnapshot(root, saved, saved.runs[0]!);
    const lowerSnapshot = structuredClone(saved);
    lowerSnapshot.runs[0]!.trace![0]!.tokens = { total: 500_000, input: 500_000 };
    lowerSnapshot.runs[0]!.trace![0]!.cost = 2;
    await recordWorkflowUsageSnapshot(root, lowerSnapshot, lowerSnapshot.runs[0]!);

    const usage = await getWorkflowUsageStatistics(root, { range: "all", now: 200 });
    assert.equal(usage.totals.totalTokens, 1_000_000);
    assert.equal(usage.totals.cost, 4);
    assert.equal(usage.models[0]?.cost, 4);
  } finally {
    config.workflowUsageFile = previousWorkflowUsageFile;
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("workflow GET routes support ETag revalidation", async () => {
  const workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-etag-"));
  const workspaceRoot = path.join(workspacesRoot, "demo");
  const unopenedWorkspaceRoot = path.join(workspacesRoot, "unopened");
  const startedAt = Date.now();
  const previousWorkspacesRoot = config.workspacesRoot;
  const previousOpenedProjectsFile = config.openedProjectsFile;
  const previousWorkflowUsageFile = config.workflowUsageFile;
  const app = Fastify();

  try {
    config.workspacesRoot = workspacesRoot;
    config.openedProjectsFile = path.join(workspacesRoot, "opened-projects.json");
    config.workflowUsageFile = path.join(workspacesRoot, "workflow-usage.json");
    await fs.mkdir(workspaceRoot);
    await fs.mkdir(unopenedWorkspaceRoot);
    const workflow = await createWorkflow(workspaceRoot, {
      title: "Cached workflow",
      runs: [
        {
          id: "run_opened",
          status: "success",
          startedAt,
          nodeIds: [],
          stats: { totalTokens: 100, cost: 0.1 },
          trace: [
            {
              nodeId: "node_opened",
              title: "Agent",
              kind: "agent",
              status: "success",
              startedAt,
              tokens: { total: 100 },
              cost: 0.1,
            },
          ],
        },
      ],
    });
    await createWorkflow(unopenedWorkspaceRoot, {
      title: "Never opened",
      runs: [
        {
          id: "run_unopened",
          status: "success",
          startedAt,
          nodeIds: [],
          stats: { totalTokens: 900, cost: 0.9 },
        },
      ],
    });
    await markWorkspaceOpened("demo");
    await recordWorkflowUsageSnapshot(workspaceRoot, workflow, workflow.runs[0]!);
    await registerWorkflowRoutes(app);

    for (const url of [
      "/api/workspaces/demo/workflows",
      "/api/workspaces/demo/workflows/usage?range=7d&timezoneOffset=0",
      "/api/workflow-usage?range=7d&timezoneOffset=0",
      `/api/workspaces/demo/workflows/${workflow.id}`,
    ]) {
      const first = await app.inject({ method: "GET", url });
      assert.equal(first.statusCode, 200);
      assert.match(first.headers["content-type"] ?? "", /^application\/json/);
      if (url.startsWith("/api/workflow-usage")) {
        const body = first.json();
        assert.equal(body.projectCount, 1);
        assert.equal(body.totals.totalTokens, 100);
        assert.equal(body.totals.cost, 0.1);
      }
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
    config.openedProjectsFile = previousOpenedProjectsFile;
    config.workflowUsageFile = previousWorkflowUsageFile;
    await app.close();
    await fs.rm(workspacesRoot, { recursive: true, force: true });
  }
});

test("workflow listing recovers a run left active by a terminated backend", async () => {
  const workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-resume-"));
  const workspaceRoot = path.join(workspacesRoot, "demo");
  const previousWorkspacesRoot = config.workspacesRoot;
  const previousWorkflowUsageFile = config.workflowUsageFile;
  const app = Fastify();

  try {
    config.workspacesRoot = workspacesRoot;
    config.workflowUsageFile = path.join(workspacesRoot, "workflow-usage.json");
    await fs.mkdir(workspaceRoot);
    const created = await createWorkflow(workspaceRoot, { title: "Interrupted workflow" });
    const [completed, active] = created.nodes;
    assert.ok(completed && active);
    await saveWorkflow(workspaceRoot, {
      ...created,
      nodes: [
        {
          ...completed,
          status: "success",
          rawOutput: JSON.stringify({ text: "checkpoint" }),
          completedAt: 20,
        },
        {
          ...active,
          status: "running",
          rawOutput: "partial agent output",
          startedAt: 30,
        },
      ],
      runs: [
        {
          id: "run_interrupted",
          status: "running",
          startedAt: 10,
          nodeIds: [completed.id, active.id],
          trace: [
            {
              nodeId: completed.id,
              title: completed.title,
              kind: completed.kind,
              status: "success",
              startedAt: 10,
              completedAt: 20,
              output: { text: "checkpoint" },
            },
            {
              nodeId: active.id,
              title: active.title,
              kind: active.kind,
              status: "running",
              startedAt: 30,
            },
          ],
        },
      ],
    });
    await registerWorkflowRoutes(app);

    const response = await app.inject({ method: "GET", url: "/api/workspaces/demo/workflows" });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().workflows[0]?.status, "stopped");

    const recovered = await getWorkflow(workspaceRoot, created.id);
    assert.equal(recovered.runs[0]?.resumable, true);
    assert.equal(recovered.nodes[0]?.status, "success");
    assert.equal(recovered.nodes[1]?.status, "idle");
    assert.equal(recovered.nodes[1]?.rawOutput, "");
    assert.equal(
      (await getWorkflowUsageStatistics(workspaceRoot, { range: "all" })).totals.totalTokens,
      0,
    );
  } finally {
    config.workspacesRoot = previousWorkspacesRoot;
    config.workflowUsageFile = previousWorkflowUsageFile;
    await app.close();
    await fs.rm(workspacesRoot, { recursive: true, force: true });
  }
});

test("workflow pause resumes the same run while stop clears the checkpoint", async () => {
  const workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-pause-"));
  const workspaceRoot = path.join(workspacesRoot, "demo");
  const previousWorkspacesRoot = config.workspacesRoot;
  const previousWorkflowUsageFile = config.workflowUsageFile;
  const app = Fastify();

  try {
    config.workspacesRoot = workspacesRoot;
    config.workflowUsageFile = path.join(workspacesRoot, "workflow-usage.json");
    await fs.mkdir(workspaceRoot);
    const created = await createWorkflow(workspaceRoot, { title: "Pause workflow" });
    const [trigger, second] = created.nodes;
    assert.ok(trigger && second);
    const waitNode = {
      ...second,
      kind: "wait" as const,
      title: "Wait",
      config: { seconds: 30 },
    };
    await saveWorkflow(workspaceRoot, {
      ...created,
      nodes: [trigger, waitNode],
      edges: [
        {
          id: "edge_pause01",
          from: trigger.id,
          to: waitNode.id,
          passSummary: true,
        },
      ],
    });
    await registerWorkflowRoutes(app);
    const runUrl = `/api/workspaces/demo/workflows/${created.id}/run`;

    const started = await app.inject({ method: "POST", url: runUrl, payload: {} });
    assert.equal(started.statusCode, 200);
    const firstRunId = started.json().runId as string;
    const paused = await app.inject({
      method: "POST",
      url: `/api/workspaces/demo/workflows/${created.id}/pause`,
    });
    assert.equal(paused.json().paused, true);
    let record = await waitForWorkflowRun(workspaceRoot, created.id, "stopped");
    assert.equal(record.runs.at(-1)?.id, firstRunId);
    assert.equal(record.runs.at(-1)?.resumable, true);

    const resumed = await app.inject({
      method: "POST",
      url: runUrl,
      payload: { resume: true },
    });
    assert.equal(resumed.statusCode, 200);
    assert.equal(resumed.json().runId, firstRunId);
    const stopped = await app.inject({
      method: "POST",
      url: `/api/workspaces/demo/workflows/${created.id}/stop`,
    });
    assert.equal(stopped.json().stopped, true);
    record = await waitForWorkflowRun(workspaceRoot, created.id, "stopped");
    assert.notEqual(record.runs.at(-1)?.resumable, true);

    const restarted = await app.inject({ method: "POST", url: runUrl, payload: {} });
    assert.equal(restarted.statusCode, 200);
    assert.notEqual(restarted.json().runId, firstRunId);
    await app.inject({
      method: "POST",
      url: `/api/workspaces/demo/workflows/${created.id}/stop`,
    });
    await waitForWorkflowRun(workspaceRoot, created.id, "stopped");
  } finally {
    config.workspacesRoot = previousWorkspacesRoot;
    config.workflowUsageFile = previousWorkflowUsageFile;
    await app.close();
    await fs.rm(workspacesRoot, { recursive: true, force: true });
  }
});

async function waitForWorkflowRun(
  workspaceRoot: string,
  workflowId: string,
  status: "success" | "error" | "stopped",
) {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    const record = await getWorkflow(workspaceRoot, workflowId);
    if (record.runs.at(-1)?.status === status) return record;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`workflow did not reach ${status}`);
}

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

test("workflow loading removes legacy diff approval payloads", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-diff-output-"));
  const created = await createWorkflow(root, {});
  const legacyOutput = JSON.stringify({
    type: "diff-approval",
    status: "waiting",
    approved: null,
    diff: `diff --git a/large-file b/large-file\n${"+line\n".repeat(1000)}`,
    text: "legacy diff",
  });

  await saveWorkflow(root, {
    ...created,
    nodes: created.nodes.map((node, index) =>
      index === 1 ? { ...node, rawOutput: legacyOutput, summary: legacyOutput } : node,
    ),
  });
  const loaded = await getWorkflow(root, created.id);
  const output = JSON.parse(loaded.nodes[1]?.rawOutput ?? "{}") as Record<string, unknown>;

  assert.equal(output.type, "diff-approval");
  assert.equal(output.text, "legacy diff");
  assert.equal("diff" in output, false);
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

test("workflow content saves preserve a concurrently renamed title", async () => {
  const workspacesRoot = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workflow-rename-"));
  const workspaceRoot = path.join(workspacesRoot, "demo");
  const previousWorkspacesRoot = config.workspacesRoot;
  const app = Fastify();

  try {
    config.workspacesRoot = workspacesRoot;
    await fs.mkdir(workspaceRoot);
    const created = await createWorkflow(workspaceRoot, {
      title: "Original title",
      readme: "Original readme",
    });
    await registerWorkflowRoutes(app);

    const renamed = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/demo/workflows/${created.id}/title`,
      payload: { title: "Renamed workflow" },
    });
    assert.equal(renamed.statusCode, 200);

    const contentSaved = await app.inject({
      method: "PATCH",
      url: `/api/workspaces/demo/workflows/${created.id}/content`,
      payload: { ...created, readme: "Edited after rename" },
    });
    assert.equal(contentSaved.statusCode, 200);

    const loaded = await getWorkflow(workspaceRoot, created.id);
    assert.equal(loaded.title, "Renamed workflow");
    assert.equal(loaded.readme, "Edited after rename");
  } finally {
    config.workspacesRoot = previousWorkspacesRoot;
    await app.close();
    await fs.rm(workspacesRoot, { recursive: true, force: true });
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
