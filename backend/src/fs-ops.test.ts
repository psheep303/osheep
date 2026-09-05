import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { listTree } from "./fs-ops.js";

test("listTree omits per-file metadata unless explicitly requested", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-tree-metadata-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  await fs.mkdir(path.join(root, "folder"));
  await fs.writeFile(path.join(root, "note.txt"), "hello", "utf8");

  const basic = await listTree(root, "", false);
  assert.deepEqual(basic, [
    { name: "folder", path: "folder", kind: "directory" },
    { name: "note.txt", path: "note.txt", kind: "file" },
  ]);

  const detailed = await listTree(root, "", false, true);
  assert.equal(detailed[0]?.kind, "directory");
  assert.equal(detailed[0]?.size, undefined);
  assert.equal(detailed[1]?.size, 5);
  assert.equal(typeof detailed[1]?.mtime, "number");
});
