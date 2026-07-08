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
