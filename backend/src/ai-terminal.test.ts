import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import test from "node:test";
import {
  type AgentEffort,
  buildAgentTerminalCommand,
  createAgentTerminalControlForTest,
  createClaudePermissionHookRuntimeForTest,
  createCodexPermissionHookRuntimeForTest,
  finishAgentTerminalSuccess,
  selectConversationSessionIdForTest,
  waitForAgentTerminalManualSuccessForTest,
} from "./ai-terminal.js";

test("Claude Code TUI command preserves permission, session, model, effort and prompt", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "gpt-5.4", {
      mode: "plan",
      effort: "high",
      conversationSessionId: id,
      prompt: "analyze this project",
    }).command,
    `claude --permission-mode plan --session-id ${id} --effort high --model gpt-5.4 'analyze this project'`,
  );
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", {
      conversationSessionId: id,
      resumeConversation: true,
      prompt: "continue",
    }).command,
    `claude --permission-mode acceptEdits --resume ${id} continue`,
  );
});

test("Claude Code TUI command maps all six UI permission modes", () => {
  const modes = [
    ["default", "manual"],
    ["acceptEdits", "acceptEdits"],
    ["auto", "auto"],
    ["dontAsk", "dontAsk"],
    ["bypassPermissions", "bypassPermissions"],
  ] as const;
  for (const [configured, cli] of modes) {
    assert.match(
      buildAgentTerminalCommand("claude-cli", "default", {
        claudePermissionMode: configured,
        settingsPath: "C:\\Temp\\osheep settings.json",
      }).command,
      new RegExp(`^claude --permission-mode ${cli} --settings `),
    );
  }
  assert.match(
    buildAgentTerminalCommand("claude-cli", "default", {
      mode: "plan",
      settingsPath: "/tmp/osheep settings.json",
    }).command,
    /^claude --permission-mode plan --settings /,
  );
});

test("Claude permission hook appends a structured sidecar event", async () => {
  const runtime = await createClaudePermissionHookRuntimeForTest();
  try {
    const settings = JSON.parse(await fs.readFile(runtime.settingsPath, "utf8"));
    const command = settings.hooks.PermissionRequest[0].hooks[0].command as string;
    const match = command.match(/^"([^"]+)" "([^"]+)" "([^"]+)"$/);
    assert.ok(match);
    assert.equal("matcher" in settings.hooks.PermissionRequest[0], false);
    assert.equal(settings.hooks.Notification[0].matcher, "permission_prompt");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(match[1], [match[2], match[3]], { stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`hook exit ${code}`)),
      );
      child.stdin.end(
        JSON.stringify({
          session_id: "session-1",
          hook_event_name: "PermissionRequest",
          tool_use_id: "skill-1",
          tool_name: "Skill",
        }),
      );
    });
    const event = JSON.parse(await fs.readFile(runtime.eventsPath, "utf8"));
    assert.equal(event.osheep_event, "claude-permission-request");
    assert.equal(event.payload.hook_event_name, "PermissionRequest");
    assert.equal(event.payload.tool_name, "Skill");
  } finally {
    await fs.rm(runtime.directory, { recursive: true, force: true });
  }
});

test("Codex TUI command preserves approval, sandbox, resume, effort and prompt", () => {
  const id = "123e4567-e89b-12d3-a456-426614174000";
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "gpt-5.4", {
      codexApproval: "never",
      codexSandbox: "workspace-write",
      effort: "xhigh",
      conversationSessionId: id,
      resumeConversation: true,
      prompt: "continue work",
    }).command,
    `codex resume --ask-for-approval never --sandbox workspace-write -c 'model_reasoning_effort="xhigh"' --model gpt-5.4 ${id} 'continue work'`,
  );
});

test("Codex permission hook appends a structured sidecar event", async () => {
  const runtime = await createCodexPermissionHookRuntimeForTest();
  try {
    assert.match(runtime.codexConfig, /^hooks\.PermissionRequest=/);
    const commandMatch = runtime.codexConfig.match(/command='([^']+)'/);
    assert.ok(commandMatch);
    const command = commandMatch[1];
    if (process.platform === "win32") {
      assert.ok(runtime.windowsCommandPath);
      assert.match(
        runtime.codexConfig,
        new RegExp(`commandWindows='"${escapeRegExp(runtime.windowsCommandPath)}"'`),
      );
    }
    const args = command.match(/^"([^"]+)" "([^"]+)" "([^"]+)"$/);
    assert.ok(args);
    await new Promise<void>((resolve, reject) => {
      const child = spawn(args[1], [args[2], args[3]], { stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`hook exit ${code}`)),
      );
      child.stdin.end(
        JSON.stringify({
          hook_event_name: "PermissionRequest",
          tool_use_id: "call-1",
          tool_name: "exec",
        }),
      );
    });
    const event = JSON.parse(await fs.readFile(runtime.eventsPath, "utf8"));
    assert.equal(event.osheep_event, "codex-permission-request");
    assert.equal(event.payload.hook_event_name, "PermissionRequest");
    assert.equal(event.payload.tool_use_id, "call-1");

    if (runtime.windowsCommandPath) {
      await fs.rm(runtime.eventsPath, { force: true });
      await new Promise<void>((resolve, reject) => {
        const child = spawn(runtime.windowsCommandPath!, [], {
          shell: true,
          stdio: ["pipe", "ignore", "pipe"],
        });
        let stderr = "";
        child.stderr.on("data", (chunk) => (stderr += chunk));
        child.once("error", reject);
        child.once("exit", (code) =>
          code === 0 ? resolve() : reject(new Error(stderr || `hook exit ${code}`)),
        );
        child.stdin.end(
          JSON.stringify({
            session_id: "session-2",
            turn_id: "turn-2",
            hook_event_name: "PermissionRequest",
            tool_name: "exec",
          }),
        );
      });
      const windowsEvent = JSON.parse(await fs.readFile(runtime.eventsPath, "utf8"));
      assert.equal(windowsEvent.osheep_event, "codex-permission-request");
      assert.equal(windowsEvent.payload.hook_event_name, "PermissionRequest");
    }
  } finally {
    await fs.rm(runtime.directory, { recursive: true, force: true });
  }
});

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

test("Codex TUI command injects its permission hook for this invocation", () => {
  const command = buildAgentTerminalCommand("codex-cli", "default", {
    codexPermissionHookConfig:
      'hooks.PermissionRequest=[{ hooks=[{ type="command", command="node hook.mjs" }] }]',
  }).command;
  assert.match(command, /--dangerously-bypass-hook-trust -c /);
  if (process.platform === "win32") {
    assert.match(command, /FromBase64String/);
  } else {
    assert.match(command, /hooks\.PermissionRequest/);
  }
});

test("Codex permission hook TOML survives PowerShell argument parsing", async () => {
  if (process.platform !== "win32") return;
  const runtime = await createCodexPermissionHookRuntimeForTest();
  try {
    const command = buildAgentTerminalCommand("codex-cli", "default", {
      codexPermissionHookConfig: runtime.codexConfig,
    }).command;
    const configArgument = command.match(/ -c (\$\(.+\))$/)?.[1];
    assert.ok(configArgument);
    const output = await new Promise<string>((resolve, reject) => {
      const executable = `'${process.execPath.replace(/'/g, "''")}'`;
      const child = spawn(
        "powershell.exe",
        [
          "-NoProfile",
          "-Command",
          `& ${executable} -e 'process.stdout.write(process.argv[1])' -- ${configArgument}`,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => (stdout += chunk));
      child.stderr.on("data", (chunk) => (stderr += chunk));
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0 ? resolve(stdout) : reject(new Error(stderr || `PowerShell exit ${code}`)),
      );
    });
    assert.equal(output, runtime.codexConfig);
  } finally {
    await fs.rm(runtime.directory, { recursive: true, force: true });
  }
});

test("unsupported effort values are normalized per provider", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", { effort: "minimal" as AgentEffort })
      .command,
    "claude --permission-mode acceptEdits --effort low",
  );
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "default", { effort: "ultracode" }).command,
    "codex --ask-for-approval on-request --sandbox workspace-write",
  );
});

test("conversation selection prefers an expected session and otherwise the newest new session", () => {
  const project = "D:\\project\\demo";
  const sessions = [
    {
      app: "codex" as const,
      id: "session-old",
      title: "Old",
      cwd: project,
      createdAt: 1,
      updatedAt: 1,
      size: 1,
    },
    {
      app: "codex" as const,
      id: "session-new",
      title: "New",
      cwd: project,
      createdAt: 3,
      updatedAt: 3_200,
      size: 1,
    },
  ];
  assert.equal(
    selectConversationSessionIdForTest(sessions, project, ["session-old"], 2_500),
    "session-new",
  );
  assert.equal(
    selectConversationSessionIdForTest(
      sessions,
      project,
      ["session-old", "session-new"],
      2_500,
      "session-old",
    ),
    "session-old",
  );
});

test("manual success remains accepted for a JSONL-completed session", () => {
  createAgentTerminalControlForTest("session", { lastCompletionState: "waiting-for-choice" });
  assert.doesNotThrow(() => finishAgentTerminalSuccess("session"));
});

test("manual success immediately wakes a pending JSONL completion wait", async () => {
  createAgentTerminalControlForTest("manual-session");
  const completion = waitForAgentTerminalManualSuccessForTest("manual-session");
  finishAgentTerminalSuccess("manual-session");
  assert.deepEqual(await completion, { state: "completed", outcome: "success" });
});
