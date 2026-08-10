import assert from "node:assert/strict";
import test from "node:test";
import {
  type AgentEffort,
  agentTerminalPromptEnterCount,
  agentTerminalPromptSubmitDelayMs,
  agentTerminalReadyForAutoFinishForTest,
  agentTerminalReadyForManualSuccessForTest,
  agentTerminalScreenSignatureForTest,
  agentTerminalStalledForTest,
  buildAgentTerminalCommand,
  buildAgentTerminalPromptWrites,
  classifyAgentTerminalContent,
  createAgentTerminalControlForTest,
  extractAgentTerminalContentForTest,
  finishAgentTerminalSuccess,
  hasAgentTerminalFailureForTest,
  resolveAgentTerminalContentStateForTest,
  selectConversationSessionIdForTest,
  shouldAutoEnterChoice,
  shouldFinishAgentTerminalWithErrorForTest,
  shouldExposeWaitingForChoice,
  shouldFollowUpPastedPromptSubmit,
} from "./ai-terminal.js";

test("agent stall timeout measures inactivity instead of total runtime", () => {
  const hour = 60 * 60 * 1000;
  const now = 5 * hour;
  const submittedAt = 0;
  const thirtyMinutes = 30 * 60 * 1000;

  assert.equal(agentTerminalStalledForTest(now, submittedAt, now - 60_000, thirtyMinutes), false);
  assert.equal(
    agentTerminalStalledForTest(now, submittedAt, now - thirtyMinutes, thirtyMinutes),
    true,
  );
  assert.equal(agentTerminalStalledForTest(now, submittedAt, 0, 0), false);
});

test("terminal failures are detected independently of auto success", () => {
  assert.equal(
    hasAgentTerminalFailureForTest(
      "● Please run /login · API Error: 403 Image generation is not enabled for this group\n❯",
    ),
    true,
  );
  assert.equal(hasAgentTerminalFailureForTest("● 已完成实现。\n验证结果：4 passed\n❯"), false);
  assert.equal(
    hasAgentTerminalFailureForTest(
      "● API Error: 529 Overloaded\n● Retrying… (3s)\n● 已恢复并继续执行",
    ),
    false,
  );
  assert.equal(
    hasAgentTerminalFailureForTest(
      "Reconnecting... 1/5 (6s \u2022 esc to interrupt)\n\u2514 Unexpected status 503 Service Unavailable: No available channel for model gpt-5.6-luna under group",
    ),
    false,
  );
});

test("a visible Codex error at the idle prompt completes as a terminal error", () => {
  const screen = [
    "OpenAI Codex (v0.147.0)",
    "model: gpt-5.6-luna medium /model to change",
    "directory: D:\\project\\osheep\\backend\\workspaces\\demo",
    "› 生成一个羊的特效，直接做，不要问我任何细节",
    "■ unexpected status 503 Service Unavailable: No available channel for model",
    "gpt-5.6-luna under group default_特价 (distributor)",
    "› Summarize recent commits",
    "gpt-5.6-luna medium · D:\\project\\osheep\\backend\\workspaces\\demo",
  ].join("\n");

  assert.equal(hasAgentTerminalFailureForTest(screen), true);
  assert.equal(shouldFinishAgentTerminalWithErrorForTest("codex-cli", screen), true);
});

test("all common terminal error forms finish as errors once Codex is idle", () => {
  const errors = [
    "Error: request could not be completed",
    "Failed to execute request",
    "Fatal exception while calling provider",
    "Traceback (most recent call last):",
    "npm ERR! command failed",
    "Request failed before completion",
    "Connection refused by provider",
    "No available channel for this model",
    "Something went wrong while sending the request",
    "■ permission denied while opening the workspace",
  ];

  for (const error of errors) {
    const screen = [error, "› Summarize recent commits", "gpt-5.6-luna medium · D:\\demo"].join(
      "\n",
    );
    assert.equal(hasAgentTerminalFailureForTest(screen), true, error);
    assert.equal(shouldFinishAgentTerminalWithErrorForTest("codex-cli", screen), true, error);
  }
});

test("a terminal error does not finish while Codex is still generating", () => {
  const screen = [
    "Error: provider request failed",
    "Working (8s • esc to interrupt)",
  ].join("\n");

  assert.equal(shouldFinishAgentTerminalWithErrorForTest("codex-cli", screen), false);
});

test("Codex reconnecting always remains running even when a prompt is visible", () => {
  const screen = [
    "Error: provider request failed",
    "Reconnecting... 5/5 (6s • esc to interrupt)",
    "› Summarize recent commits",
    "gpt-5.6-luna medium · D:\\demo",
  ].join("\n");

  assert.equal(hasAgentTerminalFailureForTest(screen), false);
  assert.equal(shouldFinishAgentTerminalWithErrorForTest("codex-cli", screen), false);
  assert.equal(
    agentTerminalReadyForAutoFinishForTest("codex-cli", screen, "ready-for-success"),
    false,
  );
});

test("Claude Code terminal command uses acceptEdits by default", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", {}).command,
    "claude --permission-mode acceptEdits",
  );
});

test("Claude Code terminal command can bypass permissions explicitly", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "sonnet", {
      claudePermissionMode: "bypassPermissions",
    }).command,
    "claude --permission-mode bypassPermissions --model sonnet",
  );
});

test("Claude Code terminal command maps auto permission mode literally", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", {
      claudePermissionMode: "auto",
    }).command,
    "claude --permission-mode auto",
  );
});

test("Codex terminal command does not receive Claude permission flags", () => {
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "gpt-5.1-codex", {
      claudePermissionMode: "bypassPermissions",
    }).command,
    "codex --ask-for-approval on-request --sandbox workspace-write --model gpt-5.1-codex",
  );
});

test("Claude terminal command can start with the default (manual) permission mode", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", {
      claudePermissionMode: "default",
    }).command,
    "claude --permission-mode default",
  );
});

test("Codex approval modes map to the official startup flags", () => {
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "default", {
      codexApproval: "on-request",
    }).command,
    "codex --ask-for-approval on-request --sandbox workspace-write",
  );
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "default", {
      codexApproval: "untrusted",
      codexSandbox: "read-only",
    }).command,
    "codex --ask-for-approval untrusted --sandbox read-only",
  );
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "gpt-5.1-codex", {
      codexApproval: "never",
      codexSandbox: "danger-full-access",
      effort: "high",
    }).command,
    "codex --ask-for-approval never --sandbox danger-full-access -c 'model_reasoning_effort=\"high\"' --model gpt-5.1-codex",
  );
});

test("Claude terminal command can start in plan mode with effort", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", {
      mode: "plan",
      effort: "high",
    }).command,
    "claude --permission-mode plan --effort high",
  );
});

test("Claude retry resumes the exact conversation session", () => {
  const sessionId = "123e4567-e89b-12d3-a456-426614174000";

  assert.equal(
    buildAgentTerminalCommand("claude-cli", "gpt-5.4", {
      mode: "plan",
      effort: "low",
      conversationSessionId: sessionId,
    }).command,
    `claude --permission-mode plan --session-id ${sessionId} --effort low --model gpt-5.4`,
  );
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "gpt-5.4", {
      mode: "plan",
      effort: "low",
      conversationSessionId: sessionId,
      resumeConversation: true,
    }).command,
    `claude --resume ${sessionId} --effort low --model gpt-5.4`,
  );
});

test("conversation session selection prefers the expected id and newest new Codex session", () => {
  const project = "D:\\project\\demo";
  const sessions = [
    {
      app: "codex" as const,
      id: "session-old",
      title: "Old",
      cwd: project,
      createdAt: 1_000,
      updatedAt: 1_000,
      size: 10,
    },
    {
      app: "codex" as const,
      id: "session-new",
      title: "New",
      cwd: project,
      createdAt: 3_000,
      updatedAt: 3_200,
      size: 20,
    },
    {
      app: "codex" as const,
      id: "session-sibling",
      title: "Sibling",
      cwd: "D:\\project\\other",
      createdAt: 4_000,
      updatedAt: 4_000,
      size: 30,
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

test("Claude terminal command passes ultracode effort through", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", {
      effort: "ultracode" as AgentEffort,
    }).command,
    "claude --permission-mode acceptEdits --effort ultracode",
  );
});

test("Codex terminal command applies reasoning effort without an approval preset", () => {
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "gpt-5.1-codex", {
      effort: "high",
    }).command,
    "codex --ask-for-approval on-request --sandbox workspace-write -c 'model_reasoning_effort=\"high\"' --model gpt-5.1-codex",
  );
});

test("Codex terminal command can explicitly pin the default medium effort", () => {
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "default", { effort: "medium" }).command,
    "codex --ask-for-approval on-request --sandbox workspace-write -c 'model_reasoning_effort=\"medium\"'",
  );
});

test("Codex terminal command preserves xhigh reasoning effort", () => {
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "gpt-5.1-codex", {
      effort: "xhigh",
    }).command,
    "codex --ask-for-approval on-request --sandbox workspace-write -c 'model_reasoning_effort=\"xhigh\"' --model gpt-5.1-codex",
  );
});

test("Codex legacy on-failure approval is migrated to on-request", () => {
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "default", {
      codexApproval: "on-failure" as never,
    }).command,
    "codex --ask-for-approval on-request --sandbox workspace-write",
  );
});

test("always enter only presses choice prompts after cooldown", () => {
  assert.equal(
    shouldAutoEnterChoice({
      alwaysEnter: true,
      state: "waiting-for-choice",
      now: 2_000,
    }),
    true,
  );
  assert.equal(
    shouldAutoEnterChoice({
      alwaysEnter: true,
      state: "waiting-for-choice",
      now: 2_000,
      lastEnterAt: 1_400,
    }),
    false,
  );
  assert.equal(
    shouldAutoEnterChoice({
      alwaysEnter: true,
      state: "ready-for-success",
      now: 2_000,
    }),
    false,
  );
  assert.equal(shouldExposeWaitingForChoice(true, "waiting-for-choice"), false);
  assert.equal(shouldExposeWaitingForChoice(false, "waiting-for-choice"), true);
});

test("terminal choice prompts are classified as waiting for user input", () => {
  const content = [
    "你希望这次“整理项目”的力度到哪一级？",
    "❯01.a轻量清理（推荐）",
    "  2. 标准重组",
    "  3. 正式包化",
    "Enter to select · Tab/Arrow keys to navigate · Esc to cancel",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "waiting-for-choice");
});

test("ordinary numbered suggestions are not an interactive choice", () => {
  const content = [
    "一句话结论：已经能用了。",
    "如果你要，我下一步可以直接继续做其中一个：",
    "1. 再帮你把它压到更短",
    "2. 改成抓你指定城市",
    "3. 改输出字段格式",
    "4. 改成别的天气源",
    "* Crunched for 8m 46s",
    "\u276f",
    "auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", content, "ready-for-success"),
    true,
  );
});

test("choice-like text without an enter interaction cue is not waiting", () => {
  const content = ["\u276f 1. 推荐方案", "  2. 备选方案", "  3. 其他方案"].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
});

test("Claude plan mode approval prompts are classified as waiting for user input", () => {
  const content = [
    "Ready to code?",
    "Here is Claude's plan:",
    "项目低风险整理计划",
    "❯ 1. Yes, and bypass permissions",
    "  2. Yes, manually approve edits",
    "  3. Tell Claude what to change",
    "shift+tab to approve with this feedback",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "waiting-for-choice");
});

test("Claude auto-mode approval menu with edit chrome waits for user input", () => {
  const content = [
    "Weather spider implementation plan",
    "\u276f 1. Yes, and use auto mode",
    "  2. Yes, manually approve edits",
    "  3. Tell Claude what to change",
    "shift+tab to approve with this feedback",
    "ctrl+g to edit in Notepad.exe - C:\\Users\\tzx sheep\\.claude\\plans\\dazzling-swinging-marble.md",
    "\u25cb explore_weather_combined read-only exploration 7s",
    "Recommended implementation",
    "1. Update scripts/spiders/weather_spider.py",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "waiting-for-choice");
});

test("Claude raw screen restores a plan choice removed from extracted content", () => {
  const screen = [
    "Claude has written up a plan and is ready to execute. Would you like to proceed?",
    "",
    "\u276f 1. Yes, and use auto mode",
    "  2. Yes, manually approve edits",
    "  3. Tell Claude what to change",
    "     shift+tab to approve with this feedback",
  ].join("\n");
  const content = extractAgentTerminalContentForTest(screen, "", "claude-cli");
  const state = resolveAgentTerminalContentStateForTest("claude-cli", screen, content);

  assert.doesNotMatch(content, /\u276f 1\. Yes/);
  assert.equal(classifyAgentTerminalContent(content), "empty");
  assert.equal(state, "waiting-for-choice");
  assert.equal(shouldAutoEnterChoice({ alwaysEnter: true, state, now: 2_000 }), true);
  assert.equal(shouldExposeWaitingForChoice(true, state), false);
});

test("Claude workflow output contains only the last formal answer", () => {
  const transcript = [
    "Thought for 7s (ctrl+o to expand)",
    "● Bash(pytest tests/test_weather_spider.py)",
    "  ⎿ 4 passed",
    "Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    "● 已完成极简天气爬虫。",
    "  - 新增 weather_spider.py",
    "  - 验证结果：4 passed",
    "✻ Cooked for 16m 11s",
    "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\r\n");

  assert.equal(
    extractAgentTerminalContentForTest(transcript, "", "claude-cli"),
    "已完成极简天气爬虫。\n  - 新增 weather_spider.py\n  - 验证结果：4 passed",
  );
});

test("Claude auto finish waits until current work is idle", () => {
  const running = [
    "Completed weather spider implementation and verification.",
    "* Seasoning (15m 29s - 35.2k tokens)",
    "Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    "auto mode on (shift+tab to cycle) - <- for agents",
  ].join("\n");
  const idle = [
    "Completed weather spider implementation and verification.",
    "* Cooked for 15m 29s",
    "\u203a weather-spider-plan",
    "auto mode on (shift+tab to cycle) - <- for agents",
  ].join("\n");

  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", running, "ready-for-success"),
    false,
  );
  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", idle, "ready-for-success"),
    true,
  );
});

test("Claude plan approval followed by auto mode and final idle output auto finishes", () => {
  const screen = [
    "Claude Code v2.1.204",
    "Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    "Ready to code?",
    "Here is Claude's plan:",
    "\u276f 1. Yes, and use auto mode",
    "  2. Yes, manually approve edits",
    "shift+tab to approve with this feedback",
    "Thinking for 6s (ctrl+o to expand)",
    "Teammate @plan-weather finished",
    "收到队友会话的消息了。",
    "当前代码已经完成并验证通过，和你批准的方案一致：",
    "- 极简城市入口在 scripts/spiders/weather_spider.py",
    "- 测试已收敛在 tests/test_weather_spider.py",
    "- 文档已同步在 docs/weather.md 和 README.md",
    "验证状态不变：",
    "- python -m unittest discover -s tests -p 'test_weather_spider.py' 通过",
    "如果你要把它进一步压成更小版本，我可以继续再收一刀。",
    "* Cogitated for 12m 40s",
    "\u276f simplify-weather-spider",
    "auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(screen), "ready-for-success");
  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", screen, "ready-for-success"),
    true,
  );
});

test("Claude active work in the current terminal tail still blocks auto finish", () => {
  const screen = [
    "Implementation is nearly complete.",
    "Working (press Esc to interrupt)",
    "auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("\n");

  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", screen, "ready-for-success"),
    false,
  );
});

test("Claude parenthesized activity blocks auto finish without relying on a footer", () => {
  const screen = [
    "方案已经写入计划文件。",
    "\u2722 Garnishing\u2026 (47s \u00b7 \u2193 1.4k tokens)",
    "\u276f minimal-weather-spider",
    "auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("\n");

  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", screen, "ready-for-success"),
    false,
  );
});

test("Claude stable idle final output succeeds without a word-for-duration footer", () => {
  const screen = [
    "测试和实际运行均已通过。",
    "所以这次最省事、最快的做法已经完成了。",
    "如果你现在要我继续，我可以立即开始下一项工作。",
    "\u276f minimal-weather-spider",
    "auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(screen), "ready-for-success");
  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", screen, "ready-for-success"),
    true,
  );
  assert.equal(
    agentTerminalReadyForManualSuccessForTest("claude-cli", screen, "ready-for-success"),
    true,
  );
});

test("Claude update warning after a completion footer still finishes successfully", () => {
  const screen = [
    "任务已完成。",
    "✻ Sautéed for 33s",
    "❯",
    "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
    "✗ Auto-update failed · Run claude doctor",
  ].join("\n");
  const content = extractAgentTerminalContentForTest(screen, "", "claude-cli");
  const state = classifyAgentTerminalContent(content);

  assert.equal(content, "");
  assert.equal(state, "empty");
  assert.equal(hasAgentTerminalFailureForTest(screen), false);
  assert.equal(shouldFinishAgentTerminalWithErrorForTest("claude-cli", screen), false);
  assert.equal(agentTerminalReadyForAutoFinishForTest("claude-cli", screen, state), true);
});

test("Claude task errors using the ballot-x marker finish as terminal errors", () => {
  const screen = [
    "✗ Error: request failed while calling the provider",
    "❯",
    "⏵⏵ accept edits on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  assert.equal(hasAgentTerminalFailureForTest(screen), true);
  assert.equal(shouldFinishAgentTerminalWithErrorForTest("claude-cli", screen), true);
});

test("Claude resumed manual-mode footer is recognized as idle", () => {
  const screen = [
    "\u276f \u7ee7\u7eed",
    "\u25cf API Error: 503 auth_unavailable: no auth available (providers=codex, model=gpt-5.4).",
    "\u273b Brewed for 3m 8s",
    "\u276f",
    "\u23f8 manual mode on \u00b7 \u2190 for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(screen), "ready-for-success");
  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", screen, "ready-for-success"),
    true,
  );
});

test("Claude current viewport drops stale activity without requiring a duration footer", () => {
  const transcript = [
    "\x1b[10;1H\u2736 Wrangling\u2026 (34s \u00b7 \u2193 930 tokens)\r",
    ...Array.from({ length: 34 }, (_, index) => `final output ${index}\n`),
    "\u276f\r",
    "\u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("");

  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", transcript, "ready-for-success"),
    true,
  );
});

test("Claude cannot succeed while a background agent is still running", () => {
  const screen = [
    "\u25cf \u5df2\u5b8c\u6210\u9a8c\u8bc1\uff0c\u53ef\u76f4\u63a5\u4f7f\u7528\u3002",
    "\u273b Waiting for 1 background agent to finish",
    "\u276f",
    "\u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
    "\u25cf main",
    "\u25cb Explore  Explore weather spider  1m 6s",
  ].join("\n");

  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", screen, "ready-for-success"),
    false,
  );
  assert.equal(
    agentTerminalReadyForManualSuccessForTest("claude-cli", screen, "ready-for-success"),
    false,
  );
});

test("Claude can succeed after every background agent becomes idle", () => {
  const screen = [
    "\u25cf \u5df2\u5b8c\u6210\u9a8c\u8bc1\uff0c\u53ef\u76f4\u63a5\u4f7f\u7528\u3002",
    "\u276f",
    "\u23f5\u23f5 auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
    "\u25cf main",
    "\u25cb Explore  Explore weather spider  idle",
  ].join("\n");

  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", screen, "ready-for-success"),
    true,
  );
});

test("Claude parenthesized activity remains busy after the idle prompt is redrawn", () => {
  const screen = [
    "Recombobulating (7m 46s \u00b7 \u2193 3.1k tokens)",
    "Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
    "\u276f",
    "plan mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("\n");

  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", screen, "ready-for-success"),
    false,
  );
  assert.equal(
    agentTerminalReadyForManualSuccessForTest("claude-cli", screen, "ready-for-success"),
    false,
  );
});

test("terminal prompt-only content is classified as empty", () => {
  const content = [
    "› write a one-line summary",
    "auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "empty");
});

test("long single-line prompt uses bracketed paste and two enters", () => {
  const prompt = `context=${"x".repeat(1138)}`;
  const writes = buildAgentTerminalPromptWrites(prompt, true);

  assert.equal(writes[0], "\x1b[200~");
  assert.equal(writes.at(-2), "\x1b[201~");
  assert.equal(writes.join("").endsWith("\r"), true);
  assert.equal(agentTerminalPromptEnterCount(prompt), 2);
  assert.ok(agentTerminalPromptSubmitDelayMs(prompt) > 80);
});

test("7170-character single-line paste follows the Codex paste submit path", () => {
  const prompt = `请按照以下要求编写程序：${"x".repeat(7_170)}`;

  assert.equal(agentTerminalPromptEnterCount(prompt), 2);
  assert.ok(agentTerminalPromptSubmitDelayMs(prompt) >= 800);
  assert.equal(buildAgentTerminalPromptWrites(prompt, true)[0], "\x1b[200~");
});

test("large multiline Codex paste waits for the TUI before pressing enter", () => {
  const prompt = `instructions\n${"x".repeat(6_601)}`;
  const writes = buildAgentTerminalPromptWrites(prompt, true);

  assert.equal(writes[0], "\x1b[200~");
  assert.equal(writes.at(-2), "\x1b[201~");
  assert.equal(writes.at(-1), "\r");
  assert.ok(agentTerminalPromptSubmitDelayMs(prompt) >= 800);
  assert.ok(
    agentTerminalPromptSubmitDelayMs(prompt) >
      agentTerminalPromptSubmitDelayMs("short single-line prompt"),
  );
  assert.equal(agentTerminalPromptEnterCount(prompt), 2);
  assert.equal(agentTerminalPromptEnterCount("short single-line prompt"), 1);
});

test("pasted prompt follow-up enter only fires while paste is still waiting", () => {
  const prompt = `context=${"x".repeat(1_200)}`;
  const rawTranscript = "› [Pasted Content 1208 chars]\n";

  assert.equal(
    shouldFollowUpPastedPromptSubmit({
      prompt,
      rawTranscript,
      state: "empty",
      now: 2_500,
      promptSubmittedAt: 1_000,
      enterCount: 0,
    }),
    true,
  );
  assert.equal(
    shouldFollowUpPastedPromptSubmit({
      prompt,
      rawTranscript: `${rawTranscript}Working`,
      state: "empty",
      now: 2_500,
      promptSubmittedAt: 1_000,
      enterCount: 0,
    }),
    false,
  );
  assert.equal(
    shouldFollowUpPastedPromptSubmit({
      prompt: "short prompt",
      rawTranscript,
      state: "empty",
      now: 2_500,
      promptSubmittedAt: 1_000,
      enterCount: 0,
    }),
    false,
  );
  assert.equal(
    shouldFollowUpPastedPromptSubmit({
      prompt,
      rawTranscript,
      state: "ready-for-success",
      now: 2_500,
      promptSubmittedAt: 1_000,
      enterCount: 0,
    }),
    false,
  );
});

test("Codex wrapped prompt echo is not extracted as model output", () => {
  const prompt = `context=${"x".repeat(180)}`;
  const transcript = [
    `› ${prompt.slice(0, 80)}`,
    prompt.slice(80, 140),
    prompt.slice(140),
    "auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  assert.equal(extractAgentTerminalContentForTest(transcript, prompt, "codex-cli"), "");
});

test("Claude plan mode stops waiting after later completion output", () => {
  const content = [
    "Ready to code?",
    "Here is Claude's plan:",
    "❯ 1. Yes, and bypass permissions",
    "  2. Yes, manually approve edits",
    "shift+tab to approve with this feedback",
    "● Update(README.md)",
    "  ⎿  Done",
    "● Bash(git diff --check)",
    "  ⎿  Done",
    "整理完成，已更新 README 和 .gitignore。",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
});

test("Claude idle prompt after Chinese validation summary is ready for success", () => {
  const content = [
    "Ready to code?",
    "❯ 1. Yes, and bypass permissions",
    "shift+tab to approve with this feedback",
    "我做了这些无副作用验证：",
    "- 检查 Markdown 中旧命令 / 旧路径引用：未发现残留。",
    "- 对移动后的 Python 文件做了 AST 语法解析：全部通过。",
    "- 验证 python scripts/auto_checkin.py -- --help：通过。",
    "通过。",
    "如果你想，我下一步可以继续帮你做一次“清理 Git 跟踪中的运行产物，但保留本地文件”。",
    "* Sautéed for 15m 26s",
    "› organize-project-structure",
    "bypass permissions on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
});

test("Claude idle prompt after a completed plan releases a stale choice prompt", () => {
  const content = [
    "Ready to code?",
    "Here is Claude's plan:",
    "❯ 1. Yes, and bypass permissions",
    "  2. Yes, manually approve edits",
    "shift+tab to approve with this feedback",
    "8. 验证方式",
    "后续实现后，从项目根目录验证：",
    "python -m py_compile scripts/spiders/nba_spider.py",
    "注意：当前日期是 2026-07-10，可能处于 NBA 休赛期。",
    "* Baked for 9m 50s",
    "❯",
    "auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
});

test("Claude cooked footer after a completed plan releases a stale choice prompt", () => {
  const content = [
    "Ready to code?",
    "Here is Claude's plan:",
    "❯ 1. Yes, and bypass permissions",
    "  2. Yes, manually approve edits",
    "shift+tab to approve with this feedback",
    "推荐先做“稳定今日比赛 + 排名 + 明确错误信息”的小步增强。",
    "• NBA 爬虫方案撰写，未编辑项目代码。",
    "方案已保存到:",
    "C:\\Users\\tzx sheep\\.claude\\plans\\nba-wild-ripple.md",
    "* Cooked for 6m 32s",
    "❯  nba-spider-plan",
    "auto mode on (shift+tab to cycle) · ← for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
});

test("Claude generic word-for-duration footer releases a stale choice prompt", () => {
  const content = [
    "Ready to code?",
    "Here is Claude's plan:",
    "\u276f 1. Yes, and use auto mode",
    "  2. Yes, manually approve edits",
    "shift+tab to approve with this feedback",
    "验证结果：4 个测试全部成功。",
    "* Cogitated for 12m 40s",
    "\u276f",
    "auto mode on (shift+tab to cycle) \u00b7 \u2190 for agents",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
  assert.equal(
    agentTerminalReadyForAutoFinishForTest("claude-cli", content, "ready-for-success"),
    true,
  );
});

test("manual success is allowed even when the previous terminal state was stale waiting", () => {
  createAgentTerminalControlForTest("session_stale_waiting", {
    lastCompletionState: "waiting-for-choice",
  });

  assert.doesNotThrow(() => finishAgentTerminalSuccess("session_stale_waiting"));
});

test("completed-looking assistant output is classified as ready for success", () => {
  const content = ["已完成。", "验证：npm test 通过。", "下一步：无。"].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
});

test("Codex completion remains visible when the idle prompt returns", () => {
  const prompt = "Implement {feature}";
  const transcript = [
    "• 已按方案实现天气爬虫增强，修改文件：scripts/spiders/weather_spider.py。",
    "",
    "主要完成：",
    "- 支持中文城市名和 9 位城市代码",
    "- 请求异常会给出清晰提示",
    "",
    "已验证：python -m py_compile scripts/spiders/weather_spider.py 通过",
    "",
    "─ Worked for 2m 15s ─",
    `› ${prompt}`,
    "gpt-5.5 low · D:\\project\\osheep\\backend\\workspaces\\demo",
  ].join("\n");

  const content = extractAgentTerminalContentForTest(transcript, prompt, "codex-cli");
  assert.match(content, /已按方案实现天气爬虫增强/);
  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
});

test("Codex final answer removes the terminal footer separator", () => {
  const transcript = [
    "• 已新增 weather_spider.py。",
    "  用法：python weather_spider.py Beijing",
    "────────────────────────────────────────────────────────",
    "› Implement the weather spider",
    "gpt-5.5 low · D:\\demo",
  ].join("\n");

  assert.equal(
    extractAgentTerminalContentForTest(transcript, "Implement the weather spider", "codex-cli"),
    "已新增 weather_spider.py。\n用法：python weather_spider.py Beijing",
  );
});

test("Codex tool output is never mistaken for the final answer", () => {
  const prompt = "Inspect the workflow storage problem";
  const transcript = [
    "• Ran Get-ChildItem .osheep\\workflows\\*.json | ForEach-Object { $j=Get-Content",
    "│ $_.FullName -Raw | ConvertFrom-Json;",
    "│ [pscustomobject]@{File=$_.Name;Bytes=$_.Length;Id=$j.id;Title=$j.title}",
    "│ … +9 lines",
    "… +6 lines (ctrl + t to view transcript)",
    "Runs  : 0",
    "─ Worked for 2m 33s ─",
    `› ${prompt}`,
    "gpt-5.5 low · D:\\demo",
  ].join("\n");

  assert.equal(extractAgentTerminalContentForTest(transcript, prompt, "codex-cli"), "");
  assert.equal(agentTerminalReadyForAutoFinishForTest("codex-cli", transcript, "empty"), true);
});

test("terminal screen signature ignores cursor-only Codex redraws", () => {
  const screen = ["• 已完成实现和验证。", "─ Worked for 2m 15s ─", "› Implement {feature}"].join(
    "\n",
  );

  assert.equal(
    agentTerminalScreenSignatureForTest(`${screen}\x1b[?25l\x1b[?25h`),
    agentTerminalScreenSignatureForTest(screen),
  );
  assert.notEqual(
    agentTerminalScreenSignatureForTest(`${screen}\nnew output`),
    agentTerminalScreenSignatureForTest(screen),
  );
});
