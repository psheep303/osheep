import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import test from "node:test";
import {
  type AgentEffort,
  agentAutoFinishPausedAfterEventForTest,
  agentCompletionDecisionForTest,
  buildAgentTerminalCommand,
  createAgentTerminalControlForTest,
  createClaudePermissionHookRuntimeForTest,
  finishAgentTerminalSuccess,
  selectConversationSessionIdForTest,
  waitForAgentTerminalManualSuccessForTest,
} from "./ai-terminal.js";

test("JSONL completion policy only keeps user-interrupted turns running", () => {
  const enabled = { keepRunningOnInterrupt: true, autoFinishPaused: false };
  assert.equal(
    agentCompletionDecisionForTest({ state: "completed", outcome: "cancelled" }, enabled),
    "continue-interrupted",
  );
  assert.equal(
    agentCompletionDecisionForTest({ state: "completed", outcome: "success" }, enabled),
    "accept",
  );
  assert.equal(
    agentCompletionDecisionForTest({ state: "completed", outcome: "error" }, enabled),
    "accept",
  );
  assert.equal(
    agentCompletionDecisionForTest(
      { state: "completed", outcome: "cancelled" },
      { keepRunningOnInterrupt: false, autoFinishPaused: false },
    ),
    "accept",
  );
  assert.equal(
    agentCompletionDecisionForTest(
      { state: "completed", outcome: "cancelled" },
      { keepRunningOnInterrupt: true, autoFinishPaused: true },
    ),
    "continue-paused",
  );
  assert.equal(
    agentCompletionDecisionForTest(
      { state: "completed", outcome: "error", error: "unexpected status 401 Unauthorized" },
      { keepRunningOnInterrupt: true, autoFinishPaused: true },
    ),
    "accept",
  );
});

test("a new JSONL turn clears the ESC auto-finish pause", () => {
  assert.equal(agentAutoFinishPausedAfterEventForTest({ state: "running" }, true), false);
  assert.equal(agentAutoFinishPausedAfterEventForTest({ state: "waiting-for-choice" }, true), true);
  assert.equal(
    agentAutoFinishPausedAfterEventForTest(
      { state: "completed", outcome: "error", error: "401 Unauthorized" },
      true,
    ),
    true,
  );
});

test("manual success keeps monitoring later turns and still accepts errors", () => {
  const manual = {
    keepRunningOnInterrupt: true,
    autoFinishPaused: false,
    autoSuccess: false,
  };
  assert.equal(
    agentCompletionDecisionForTest({ state: "completed", outcome: "success" }, manual),
    "continue-paused",
  );
  assert.equal(
    agentCompletionDecisionForTest(
      { state: "completed", outcome: "error", error: "401 Unauthorized" },
      manual,
    ),
    "accept",
  );
});

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
