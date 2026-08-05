import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { after, before, test } from "node:test";
import { platform } from "./config.js";
import {
  defaultAiCliCommand,
  detectAiCli,
  detectRuntimeTools,
  findExecutable,
} from "./runtime-tools.js";

let fixtureDir = "";

before(async () => {
  fixtureDir = await fs.mkdtemp(path.join(os.tmpdir(), "osheep-runtime-tools-"));
});

after(async () => {
  if (fixtureDir) await fs.rm(fixtureDir, { recursive: true, force: true });
});

async function fakeExecutable(name: string): Promise<string> {
  const file = path.join(fixtureDir, name);
  await fs.writeFile(
    file,
    platform === "windows" ? "@echo off\r\n" : "#!/usr/bin/env sh\n",
    "utf8",
  );
  if (platform !== "windows") await fs.chmod(file, 0o755);
  return file;
}

test("findExecutable resolves commands from the current platform PATH", async () => {
  const filename = platform === "windows" ? "osheep-tool.CMD" : "osheep-tool";
  const expected = await fakeExecutable(filename);
  const resolved = findExecutable("osheep-tool", {
    platform,
    env: { PATH: fixtureDir, PATHEXT: ".CMD;.EXE" },
  });
  assert.equal(resolved, expected);
});

test("findExecutable rejects non-executable files on POSIX", async (context) => {
  if (platform === "windows")
    return context.skip("POSIX execute permissions do not apply on Windows");
  const file = path.join(fixtureDir, "not-executable");
  await fs.writeFile(file, "plain text", "utf8");
  await fs.chmod(file, 0o644);
  assert.equal(findExecutable("not-executable", { platform, env: { PATH: fixtureDir } }), null);
});

test("AI CLI detection reports installed and missing commands", async () => {
  const suffix = platform === "windows" ? ".cmd" : "";
  const codexPath = await fakeExecutable(`codex${suffix}`);
  const env = { PATH: fixtureDir, PATHEXT: ".CMD;.EXE" };

  assert.deepEqual(detectAiCli("codex", { platform, env }), {
    command: codexPath,
    path: codexPath,
    installed: true,
  });
  assert.deepEqual(detectAiCli("claude", { platform, env: { PATH: "" } }), {
    command: defaultAiCliCommand("claude", platform),
    path: null,
    installed: false,
  });
});

test("runtime tool detection uses one cross-platform result shape", () => {
  const tools = detectRuntimeTools({ platform, env: { PATH: "" } });
  for (const tool of Object.values(tools)) {
    assert.equal(tool.installed, false);
    assert.equal(tool.path, null);
    assert.ok(tool.command.length > 0);
  }
});
