import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import { getCommitDetails, getLog } from "./git-ops.js";
import { findExecutable } from "./runtime-tools.js";

const execFileAsync = promisify(execFile);

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
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});
