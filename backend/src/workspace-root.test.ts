import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { config } from "./config.js";
import { createWorkspace, listWorkspaces, setWorkspacesRoot } from "./workspace.js";

test("selected workspaces root persists and owns newly created workspaces", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "osheep-workspaces-"));
  const selectedRoot = path.join(sandbox, "selected-root");
  const configFile = path.join(sandbox, "workspace-root.json");
  const originalRoot = config.workspacesRoot;
  const originalConfigFile = config.workspaceRootConfigFile;

  try {
    await mkdir(selectedRoot);
    config.workspaceRootConfigFile = configFile;

    const resolvedRoot = await setWorkspacesRoot(selectedRoot);
    assert.equal(resolvedRoot, await realpath(selectedRoot));

    const workspace = await createWorkspace("project-a");
    assert.equal(workspace.path, path.join(resolvedRoot, "project-a"));
    assert.equal((await stat(workspace.path)).isDirectory(), true);
    assert.equal((await stat(path.join(workspace.path, ".osheep", "docs"))).isDirectory(), true);
    await assert.rejects(stat(path.join(workspace.path, ".osheep", "plan")), { code: "ENOENT" });
    assert.deepEqual(
      (await listWorkspaces()).map(({ id }) => id),
      ["project-a"],
    );

    const saved = JSON.parse(await readFile(configFile, "utf8")) as { root: string };
    assert.equal(saved.root, resolvedRoot);
  } finally {
    config.workspacesRoot = originalRoot;
    config.workspaceRootConfigFile = originalConfigFile;
    await rm(sandbox, { recursive: true, force: true });
  }
});
