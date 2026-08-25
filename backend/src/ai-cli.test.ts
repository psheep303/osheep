import assert from "node:assert/strict";
import test from "node:test";
import { normalizeInvocation } from "./ai-cli.js";
import { platform } from "./config.js";

test("AI CLI invocation protects Windows cmd files from command injection", () => {
  const input = { command: "codex.cmd", args: ["exec", "--model", "safe & whoami"] };
  if (platform === "windows") {
    assert.throws(
      () => normalizeInvocation(input),
      (error: unknown) =>
        error instanceof Error && "code" in error && error.code === "INVALID_QUERY",
    );
    return;
  }

  assert.deepEqual(normalizeInvocation(input), {
    ...input,
    windowsVerbatimArguments: false,
  });
});

test("AI CLI invocation uses one quoted command line for Windows cmd files", () => {
  const input = { command: "C:/Program Files/node/codex.cmd", args: ["exec", "--json"] };
  const invocation = normalizeInvocation(input);
  if (platform === "windows") {
    assert.deepEqual(invocation, {
      command: "cmd.exe",
      args: ["/d", "/s", "/c", 'call "C:/Program Files/node/codex.cmd" "exec" "--json"'],
      windowsVerbatimArguments: true,
    });
    return;
  }

  assert.deepEqual(invocation, {
    ...input,
    windowsVerbatimArguments: false,
  });
});
