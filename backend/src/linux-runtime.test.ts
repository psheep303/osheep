import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";
import * as nodePty from "node-pty";
import { getRepoInfo } from "./git-ops.js";
import { detectProfiles } from "./pty.js";
import { detectAiCli, findExecutable } from "./runtime-tools.js";
import { resolveWorkspacePath } from "./workspace.js";

const execFileAsync = promisify(execFile);
const onLinux = process.platform === "linux";

test("Linux resolves Bash and workspace paths with spaces", { skip: !onLinux }, async () => {
  const bash = findExecutable("bash");
  assert.ok(bash, "bash must be available on Ubuntu");
  assert.ok(
    detectProfiles().some((profile) => profile.id === "bash" && profile.executable === bash),
  );

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep path test "));
  try {
    assert.equal(resolveWorkspacePath(root, "src/main.ts"), path.join(root, "src", "main.ts"));
    assert.equal(resolveWorkspacePath(root, "src\\main.ts"), path.join(root, "src", "main.ts"));
    assert.throws(() => resolveWorkspacePath(root, "../outside"));
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Linux node-pty starts Bash and captures output", {
  skip: !onLinux,
  timeout: 5000,
}, async () => {
  const bash = findExecutable("bash");
  assert.ok(bash, "bash must be available on Ubuntu");

  const output = await new Promise<string>((resolve, reject) => {
    const terminal = nodePty.spawn(bash, ["--noprofile", "--norc", "-c", "printf osheep-pty-ok"], {
      name: "xterm-256color",
      cols: 80,
      rows: 24,
      cwd: process.cwd(),
      env: { ...process.env },
    });
    let captured = "";
    terminal.onData((data) => {
      captured += data;
    });
    terminal.onExit(({ exitCode }) => {
      if (exitCode !== 0) reject(new Error(`bash PTY exited with ${exitCode}`));
      else resolve(captured);
    });
  });
  assert.match(output, /osheep-pty-ok/);
});

test("Linux Git operations work in a clean temporary repository", { skip: !onLinux }, async () => {
  const git = findExecutable("git");
  assert.ok(git, "git must be available on Ubuntu");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-git-test-"));
  try {
    await execFileAsync(git, ["init", "-b", "main"], { cwd: root });
    await execFileAsync(git, ["config", "user.name", "Osheep CI"], { cwd: root });
    await execFileAsync(git, ["config", "user.email", "ci@osheep.invalid"], { cwd: root });
    await fs.writeFile(path.join(root, "README.md"), "linux git test\n", "utf8");
    await execFileAsync(git, ["add", "README.md"], { cwd: root });
    await execFileAsync(git, ["commit", "-m", "initial"], { cwd: root });

    const info = await getRepoInfo(root);
    assert.equal(info.isRepo, true);
    assert.equal(info.branch, "main");
    assert.match(info.head ?? "", /^[0-9a-f]{40}$/);
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Linux detects AI CLIs from PATH without requiring real installations", {
  skip: !onLinux,
}, async () => {
  const binDir = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-ai-cli-test-"));
  try {
    for (const name of ["codex", "claude"]) {
      const file = path.join(binDir, name);
      await fs.writeFile(file, "#!/usr/bin/env bash\nprintf '%s\\n' osheep-cli-ok\n", "utf8");
      await fs.chmod(file, 0o755);
    }
    const env = { PATH: binDir };
    assert.equal(detectAiCli("codex", { platform: "linux", env }).installed, true);
    assert.equal(detectAiCli("claude", { platform: "linux", env }).installed, true);
    assert.equal(detectAiCli("codex", { platform: "linux", env: { PATH: "" } }).installed, false);
  } finally {
    await fs.rm(binDir, { recursive: true, force: true });
  }
});
