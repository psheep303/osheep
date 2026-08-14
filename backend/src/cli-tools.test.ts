import assert from "node:assert/strict";
import test from "node:test";
import {
  type CliToolCommandRunner,
  createCliToolManager,
  isNewerVersion,
  parseCliVersion,
} from "./cli-tools.js";

test("parseCliVersion accepts Claude and Codex version output", () => {
  assert.equal(parseCliVersion("2.1.232 (Claude Code)"), "2.1.232");
  assert.equal(parseCliVersion("codex-cli 0.147.0"), "0.147.0");
  assert.equal(parseCliVersion("v1.2.3-beta.1"), "1.2.3-beta.1");
  assert.equal(parseCliVersion("not a version"), null);
});

test("isNewerVersion compares numeric version segments", () => {
  assert.equal(isNewerVersion("0.147.0", "0.148.0"), true);
  assert.equal(isNewerVersion("2.1.232", "2.1.232"), false);
  assert.equal(isNewerVersion("2.2.0", "2.1.999"), false);
  assert.equal(isNewerVersion(null, "1.0.0"), false);
});

test("tool status combines the installed and npm registry versions", async () => {
  const run: CliToolCommandRunner = async (command, args) => {
    if (command === "C:/bin/claude.exe") return { stdout: "2.1.226 (Claude Code)", stderr: "" };
    assert.fail(`Unexpected command: ${command} ${args.join(" ")}`);
  };
  const manager = createCliToolManager({
    platform: "windows",
    detect: () => ({ command: "C:/bin/claude.exe", path: "C:/bin/claude.exe", installed: true }),
    findExecutable: () => "C:/node/npm.cmd",
    getLatestVersion: async (packageName) => {
      assert.equal(packageName, "@anthropic-ai/claude-code");
      return "2.1.232";
    },
    run,
  });

  assert.deepEqual(await manager.getStatus("claude"), {
    name: "claude",
    activeAction: null,
    installed: true,
    currentVersion: "2.1.226",
    latestVersion: "2.1.232",
    updateAvailable: true,
    platform: "windows",
    error: null,
  });
});

test("Codex installation uses the fixed allowlisted npm package", async () => {
  const calls: Array<{ command: string; args: string[] }> = [];
  let installed = false;
  const manager = createCliToolManager({
    platform: "linux",
    detect: () =>
      installed
        ? { command: "/bin/codex", path: "/bin/codex", installed: true }
        : { command: "codex", path: null, installed: false },
    findExecutable: () => "/bin/npm",
    getLatestVersion: async () => "0.148.0",
    run: async (command, args) => {
      calls.push({ command, args });
      if (args[0] === "install") {
        installed = true;
        return { stdout: "installed", stderr: "" };
      }
      if (args[0] === "--version") return { stdout: "codex-cli 0.148.0", stderr: "" };
      return { stdout: "", stderr: "" };
    },
  });

  const status = await manager.runAction("codex", "install");
  assert.deepEqual(calls[0], {
    command: "/bin/npm",
    args: ["install", "--global", "@openai/codex@latest"],
  });
  assert.equal(status.currentVersion, "0.148.0");
  assert.equal(status.activeAction, null);
});

test("tool status exposes an update that is still running", async () => {
  let releaseUpdate: (() => void) | undefined;
  let updateStarted: (() => void) | undefined;
  const started = new Promise<void>((resolve) => {
    updateStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releaseUpdate = resolve;
  });
  const manager = createCliToolManager({
    platform: "linux",
    detect: () => ({ command: "/bin/claude", path: "/bin/claude", installed: true }),
    findExecutable: () => "/bin/npm",
    getLatestVersion: async () => "2.1.232",
    run: async (_command, args) => {
      if (args[0] === "update") {
        updateStarted?.();
        await release;
        return { stdout: "updated", stderr: "" };
      }
      return { stdout: "2.1.226 (Claude Code)", stderr: "" };
    },
  });

  const action = manager.runAction("claude", "update");
  await started;
  const status = await manager.getStatus("claude");
  assert.equal(status.activeAction, "update");
  releaseUpdate?.();
  assert.equal((await action).activeAction, null);
});

test("Claude update falls back to npm when its self-updater fails", async () => {
  const calls: string[] = [];
  const manager = createCliToolManager({
    platform: "linux",
    detect: () => ({ command: "/bin/claude", path: "/bin/claude", installed: true }),
    findExecutable: () => "/bin/npm",
    getLatestVersion: async () => "2.1.232",
    run: async (command, args) => {
      calls.push(`${command} ${args.join(" ")}`);
      if (args[0] === "update") throw new Error("self update unavailable");
      if (args[0] === "--version") return { stdout: "2.1.232 (Claude Code)", stderr: "" };
      return { stdout: "updated", stderr: "" };
    },
  });

  await manager.runAction("claude", "update");
  assert.deepEqual(calls.slice(0, 2), [
    "/bin/claude update",
    "/bin/npm install --global @anthropic-ai/claude-code@latest",
  ]);
});
