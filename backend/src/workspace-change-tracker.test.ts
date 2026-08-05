import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import {
  captureWorkspaceChanges,
  changedFingerprintKeys,
  changedWorkspaceFiles,
} from "./workspace-change-tracker.js";

test("fingerprint comparison reports added, modified, and deleted files", () => {
  const before = new Map([
    ["modified.ts", "1"],
    ["deleted.ts", "1"],
  ]);
  const after = new Map([
    ["modified.ts", "2"],
    ["added.ts", "1"],
  ]);
  assert.deepEqual(changedFingerprintKeys(before, after), [
    "added.ts",
    "deleted.ts",
    "modified.ts",
  ]);
});

test("non-git workspace tracking detects file writes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-change-tracker-"));
  try {
    await fs.writeFile(path.join(root, "existing.txt"), "before", "utf8");
    const baseline = await captureWorkspaceChanges(root);
    await fs.writeFile(path.join(root, "existing.txt"), "after-content", "utf8");
    await fs.writeFile(path.join(root, "added.txt"), "new", "utf8");
    assert.deepEqual(await changedWorkspaceFiles(root, baseline), ["added.txt", "existing.txt"]);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
