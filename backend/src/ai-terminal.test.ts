import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentEffort,
  buildAgentTerminalCommand,
  createAgentTerminalControlForTest,
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
    `claude --resume ${id} continue`,
  );
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
