import assert from "node:assert/strict";
import * as fs from "node:fs";
import test from "node:test";
import { buildBashGuard, buildPowerShellGuard } from "./pty-guard.js";

function generatedScriptPath(args: string[]): string {
  const joined = args.join(" ");
  const match = joined.match(/[&']\s*'([^']+\.(?:ps1|rc))'/i) ?? joined.match(/--rcfile\s+(\S+)/i);
  assert.ok(match?.[1], `generated startup script missing from: ${joined}`);
  return match[1];
}

test("PowerShell startup runs the agent command once after selecting the workspace", () => {
  const command = "claude --model 'gpt-5.6-sol(low)' '写一个猫的特效 随便写'";
  const guard = buildPowerShellGuard(
    [],
    "D:\\project\\osheep",
    "D:\\project\\osheep\\demo",
    command,
  );
  try {
    assert.deepEqual(guard.args.slice(0, 2), ["-ExecutionPolicy", "Bypass"]);
    const script = fs.readFileSync(generatedScriptPath(guard.args), "utf8");
    const cwdAt = script.lastIndexOf("Set-Location -LiteralPath");
    const commandAt = script.indexOf(command);
    assert.ok(cwdAt >= 0 && commandAt > cwdAt);
    assert.equal(script.split(command).length - 1, 1);
  } finally {
    guard.cleanup();
  }
});

test("Bash startup runs the agent command once after selecting the workspace", () => {
  const command = "codex --sandbox workspace-write 'analyze this project'";
  const guard = buildBashGuard([], "/project/osheep", "/project/osheep/demo", command);
  try {
    const script = fs.readFileSync(generatedScriptPath(guard.args), "utf8");
    const cwdAt = script.lastIndexOf("builtin cd --");
    const commandAt = script.indexOf(command);
    assert.ok(cwdAt >= 0 && commandAt > cwdAt);
    assert.equal(script.split(command).length - 1, 1);
  } finally {
    guard.cleanup();
  }
});
