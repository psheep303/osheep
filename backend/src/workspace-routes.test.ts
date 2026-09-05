import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import Fastify from "fastify";
import { config } from "./config.js";
import { registerWorkspaceRoutes } from "./routes/workspaces.js";

test("workspace file routes expose optional metadata and file-open timing", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-workspace-routes-"));
  const originalRoot = config.workspacesRoot;
  config.workspacesRoot = root;
  const app = Fastify({ logger: false });
  t.after(async () => {
    config.workspacesRoot = originalRoot;
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  });
  await fs.mkdir(path.join(root, "demo"));
  await fs.writeFile(path.join(root, "demo", "note.txt"), "hello", "utf8");
  await registerWorkspaceRoutes(app);

  const basicTree = await app.inject({
    method: "GET",
    url: "/api/workspaces/demo/fs/tree?path=",
  });
  assert.equal(basicTree.statusCode, 200);
  const basicEntry = basicTree
    .json<{ entries: Array<Record<string, unknown>> }>()
    .entries.find((entry) => entry.name === "note.txt");
  assert.deepEqual(basicEntry, { name: "note.txt", path: "note.txt", kind: "file" });

  const metadataTree = await app.inject({
    method: "GET",
    url: "/api/workspaces/demo/fs/tree?path=&metadata=true",
  });
  const metadataEntry = metadataTree
    .json<{ entries: Array<Record<string, unknown>> }>()
    .entries.find((entry) => entry.name === "note.txt");
  assert.equal(metadataEntry?.size, 5);
  assert.equal(typeof metadataEntry?.mtime, "number");

  const file = await app.inject({
    method: "GET",
    url: "/api/workspaces/demo/fs/file?path=note.txt",
    headers: { "x-osheep-file-open-id": "trace-route-test" },
  });
  assert.equal(file.statusCode, 200);
  assert.equal(file.headers["x-osheep-file-open-id"], "trace-route-test");
  assert.equal(file.headers["x-osheep-file-cache"], "miss");
  assert.match(String(file.headers["server-timing"]), /^osheep-file-read;dur=[0-9.]+$/);
});
