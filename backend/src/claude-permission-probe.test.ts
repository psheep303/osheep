import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";
import * as nodePty from "node-pty";
import {
  type AgentTerminalStatus,
  createClaudePermissionHookRuntimeForTest,
  runAgentTerminal,
} from "./ai-terminal.js";

test("real Claude TUI emits a PermissionRequest sidecar", {
  skip: process.env.OSHEEP_REAL_CLAUDE_PROBE !== "1",
  timeout: 90_000,
}, async () => {
  const runtime = await createClaudePermissionHookRuntimeForTest();
  const workspace = path.resolve("workspaces/demo");
  const debugPath = path.join(runtime.directory, "claude-debug.log");
  const sessionId = randomUUID();
  const settings = JSON.parse(await fs.readFile(runtime.settingsPath, "utf8"));
  settings.hooks.SessionStart = settings.hooks.PermissionRequest;
  await fs.writeFile(runtime.settingsPath, `${JSON.stringify(settings)}\n`, "utf8");
  const command = `claude --permission-mode manual --session-id ${sessionId} --settings '${runtime.settingsPath.replace(/'/g, "''")}' --debug hooks --debug-file '${debugPath.replace(/'/g, "''")}' 'Use Bash exactly once to append probe to .osheep-claude-permission-probe. Do nothing else.'`;
  const pty = nodePty.spawn("powershell.exe", ["-NoLogo", "-NoProfile", "-Command", command], {
    cwd: workspace,
    cols: 100,
    rows: 30,
    env: { ...process.env },
    useConptyDll: true,
  });
  let terminalTail = "";
  pty.onData((data) => {
    terminalTail = `${terminalTail}${data}`.slice(-8_000);
  });
  try {
    const deadline = Date.now() + 60_000;
    let events: Record<string, unknown>[] = [];
    while (Date.now() < deadline) {
      const content = await fs.readFile(runtime.eventsPath, "utf8").catch(() => "");
      if (content.trim()) {
        events = content
          .trim()
          .split(/\r?\n/)
          .map((line) => JSON.parse(line));
        const permission = events.find(
          (event) =>
            (event.payload as Record<string, unknown>)?.hook_event_name === "PermissionRequest",
        );
        if (permission) break;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    const sessionStart = events.find(
      (event) => (event.payload as Record<string, unknown>)?.hook_event_name === "SessionStart",
    );
    const event = events.find(
      (candidate) =>
        (candidate.payload as Record<string, unknown>)?.hook_event_name === "PermissionRequest",
    );
    if (!sessionStart || !event) {
      const debug = await fs.readFile(debugPath, "utf8").catch(() => "");
      assert.fail(
        `Claude did not emit both SessionStart and PermissionRequest file events\nRUNTIME: ${runtime.directory}\nEVENTS:\n${JSON.stringify(events, null, 2)}\nDEBUG:\n${debug.slice(-12_000)}\nTUI:\n${terminalTail}`,
      );
    }
    assert.equal(event.osheep_event, "claude-permission-request");
    const payload = event.payload as Record<string, unknown>;
    assert.equal(payload.hook_event_name, "PermissionRequest");
    assert.equal(payload.tool_name, "Bash");
  } finally {
    pty.kill();
    const hasEvents = await fs
      .stat(runtime.eventsPath)
      .then((stat) => stat.size > 0)
      .catch(() => false);
    if (hasEvents) await fs.rm(runtime.directory, { recursive: true, force: true });
  }
});

test("real Osheep agent terminal reports Claude PermissionRequest as waiting", {
  skip: process.env.OSHEEP_REAL_CLAUDE_PROBE !== "1",
  timeout: 90_000,
}, async () => {
  const workspacePath = path.resolve("workspaces/demo");
  const probeName = `.osheep-claude-permission-probe-${randomUUID()}`;
  const probePath = path.join(workspacePath, probeName);
  const abort = new AbortController();
  const statuses: AgentTerminalStatus[] = [];
  let waiting = false;

  try {
    await runAgentTerminal({
      workspace: { id: "demo", name: "demo", path: workspacePath },
      kind: "claude-cli",
      model: "default",
      prompt: `Use Bash exactly once to append probe to ${probeName}. Do nothing else.`,
      claudePermissionMode: "default",
      signal: abort.signal,
      onFrame: (frame) => {
        if (frame.type !== "status") return;
        statuses.push(frame.status);
        if (frame.status === "waiting-for-choice") {
          waiting = true;
          abort.abort();
        }
      },
    });
    assert.equal(waiting, true, `statuses: ${statuses.join(", ")}`);
  } finally {
    abort.abort();
    await fs.rm(probePath, { force: true });
  }
});
