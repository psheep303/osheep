import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, realpath, rm, stat } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import test from "node:test";
import { config } from "./config.js";
import {
  createWorkspace,
  listOpenedProjects,
  listWorkspaces,
  markWorkspaceOpened,
  setWorkspacesRoot,
} from "./workspace.js";

test("selected workspaces root persists and owns newly created workspaces", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "osheep-workspaces-"));
  const selectedRoot = path.join(sandbox, "selected-root");
  const configFile = path.join(sandbox, "workspace-root.json");
  const originalRoot = config.workspacesRoot;
  const originalConfigFile = config.workspaceRootConfigFile;
  const originalOpenedProjectsFile = config.openedProjectsFile;

  try {
    await mkdir(selectedRoot);
    config.workspaceRootConfigFile = configFile;
    config.openedProjectsFile = path.join(sandbox, "opened-projects.json");

    const resolvedRoot = await setWorkspacesRoot(selectedRoot);
    assert.equal(resolvedRoot, await realpath(selectedRoot));

    const workspace = await createWorkspace("project-a");
    await markWorkspaceOpened(workspace.id);
    assert.equal(workspace.path, path.join(resolvedRoot, "project-a"));
    assert.equal((await stat(workspace.path)).isDirectory(), true);
    assert.equal((await stat(path.join(workspace.path, ".osheep", "docs"))).isDirectory(), true);
    await assert.rejects(stat(path.join(workspace.path, ".osheep", "plan")), { code: "ENOENT" });
    assert.deepEqual(
      (await listWorkspaces()).map(({ id }) => id),
      ["project-a"],
    );
    assert.deepEqual(
      (await listOpenedProjects()).map((project) => project.path),
      [await realpath(workspace.path)],
    );

    const saved = JSON.parse(await readFile(configFile, "utf8")) as { root: string };
    assert.equal(saved.root, resolvedRoot);
  } finally {
    config.workspacesRoot = originalRoot;
    config.workspaceRootConfigFile = originalConfigFile;
    config.openedProjectsFile = originalOpenedProjectsFile;
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("opened project history remains available after switching workspace roots", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "osheep-project-history-"));
  const firstRoot = path.join(sandbox, "first-root");
  const secondRoot = path.join(sandbox, "second-root");
  const originalRoot = config.workspacesRoot;
  const originalConfigFile = config.workspaceRootConfigFile;
  const originalOpenedProjectsFile = config.openedProjectsFile;

  try {
    await mkdir(firstRoot);
    await mkdir(secondRoot);
    config.workspaceRootConfigFile = path.join(sandbox, "workspace-root.json");
    config.openedProjectsFile = path.join(sandbox, "opened-projects.json");

    await setWorkspacesRoot(firstRoot);
    const first = await createWorkspace("project-a");
    await markWorkspaceOpened(first.id);
    await setWorkspacesRoot(secondRoot);
    const second = await createWorkspace("project-b");
    await markWorkspaceOpened(second.id);

    assert.deepEqual(
      new Set((await listOpenedProjects()).map((project) => project.path)),
      new Set([await realpath(first.path), await realpath(second.path)]),
    );
  } finally {
    config.workspacesRoot = originalRoot;
    config.workspaceRootConfigFile = originalConfigFile;
    config.openedProjectsFile = originalOpenedProjectsFile;
    await rm(sandbox, { recursive: true, force: true });
  }
});
