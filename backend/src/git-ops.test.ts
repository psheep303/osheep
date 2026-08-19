import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { deleteBranch, getCommitDetails, getCommitDiff, getLog, getStatus } from "./git-ops.js";
import { findExecutable } from "./runtime-tools.js";

const execFileAsync = promisify(execFile);

test("Git status reports ignored paths separately from changes", async (context) => {
  const git = findExecutable("git");
  if (!git) {
    context.skip("git is not installed");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep ignored status "));
  try {
    await execFileAsync(git, ["init"], { cwd: root });
    await fs.writeFile(path.join(root, ".gitignore"), "dist/\n*.local\n", "utf8");
    await fs.mkdir(path.join(root, "dist"));
    await fs.writeFile(path.join(root, "dist", "bundle.js"), "ignored\n", "utf8");
    await fs.writeFile(path.join(root, "settings.local"), "ignored\n", "utf8");
    await fs.writeFile(path.join(root, "visible.txt"), "visible\n", "utf8");

    const status = await getStatus(root);

    assert.deepEqual(status.ignoredPaths.sort(), ["dist", "settings.local"]);
    assert.equal(
      status.changes.some((change) => change.path === "visible.txt"),
      true,
    );
    assert.equal(
      status.changes.some((change) => change.path.startsWith("dist")),
      false,
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Git history returns VS Code graph data and full commit details", async (context) => {
  const git = findExecutable("git");
  if (!git) {
    context.skip("git is not installed");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep git details "));
  try {
    await execFileAsync(git, ["init", "-b", "main"], { cwd: root });
    await execFileAsync(git, ["config", "user.name", "Osheep Test"], { cwd: root });
    await execFileAsync(git, ["config", "user.email", "git-test@osheep.invalid"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "first\n", "utf8");
    await execFileAsync(git, ["add", "README.md"], { cwd: root });
    await execFileAsync(git, ["commit", "-m", "initial"], { cwd: root });

    await fs.writeFile(path.join(root, "README.md"), "first\nsecond\n", "utf8");
    await execFileAsync(git, ["add", "README.md"], { cwd: root });
    await execFileAsync(git, ["commit", "-m", "show details", "-m", "Commit body"], { cwd: root });

    const history = await getLog(root, 200, 0, "--all");
    assert.equal(history.commits.length, 2);
    assert.equal(history.commits[0].subject, "show details");
    assert.equal(history.currentRef, "refs/heads/main");

    const details = await getCommitDetails(root, history.commits[0].sha);
    assert.equal(details.author, "Osheep Test");
    assert.equal(details.authorEmail, "git-test@osheep.invalid");
    assert.equal(details.message, "show details\n\nCommit body");
    assert.equal(details.filesChanged, 1);
    assert.equal(details.insertions, 1);
    assert.equal(details.deletions, 0);
    assert.deepEqual(details.files, [
      { path: "README.md", status: "M", insertions: 1, deletions: 0, binary: false },
    ]);

    const diff = await getCommitDiff(root, details.sha, "README.md");
    assert.equal(diff.leftContent, "first\n");
    assert.equal(diff.rightContent, "first\nsecond\n");
    assert.equal(diff.leftMissing, false);
    assert.equal(diff.rightMissing, false);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("branch deletion supports local, forced, and remote branches", async (context) => {
  const git = findExecutable("git");
  if (!git) {
    context.skip("git is not installed");
    return;
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep delete branch "));
  const remote = await fs.mkdtemp(path.join(os.tmpdir(), "osheep delete branch remote "));
  try {
    await execFileAsync(git, ["init", "--bare"], { cwd: remote });
    await execFileAsync(git, ["init", "-b", "main"], { cwd: root });
    await execFileAsync(git, ["config", "user.name", "Osheep Test"], { cwd: root });
    await execFileAsync(git, ["config", "user.email", "git-test@osheep.invalid"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "main\n", "utf8");
    await execFileAsync(git, ["add", "README.md"], { cwd: root });
    await execFileAsync(git, ["commit", "-m", "initial"], { cwd: root });

    await execFileAsync(git, ["branch", "merged"], { cwd: root });
    await deleteBranch(root, "merged");
    await assert.rejects(
      execFileAsync(git, ["rev-parse", "--verify", "refs/heads/merged"], { cwd: root }),
    );

    await execFileAsync(git, ["checkout", "-b", "unmerged"], { cwd: root });
    await fs.writeFile(path.join(root, "feature.txt"), "feature\n", "utf8");
    await execFileAsync(git, ["add", "feature.txt"], { cwd: root });
    await execFileAsync(git, ["commit", "-m", "feature"], { cwd: root });
    await execFileAsync(git, ["checkout", "main"], { cwd: root });
    await assert.rejects(deleteBranch(root, "unmerged"));
    await deleteBranch(root, "unmerged", { force: true });

    await execFileAsync(git, ["remote", "add", "origin", remote], { cwd: root });
    await execFileAsync(git, ["push", "origin", "main:remote-feature"], { cwd: root });
    await deleteBranch(root, "remote-feature", { remote: "origin" });
    await assert.rejects(
      execFileAsync(git, [
        "--git-dir",
        remote,
        "rev-parse",
        "--verify",
        "refs/heads/remote-feature",
      ]),
    );
  } finally {
    await fs.rm(root, { recursive: true, force: true });
    await fs.rm(remote, { recursive: true, force: true });
  }
});
