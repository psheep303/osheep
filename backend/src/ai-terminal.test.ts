import test from "node:test";
import assert from "node:assert/strict";
import {
  buildAgentTerminalCommand,
  classifyAgentTerminalContent,
  createAgentTerminalControlForTest,
  finishAgentTerminalSuccess,
  shouldAutoEnterChoice,
} from "./ai-terminal.js";

test("Claude Code terminal command uses acceptEdits by default", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", {}).command,
    "claude --permission-mode acceptEdits"
  );
});

test("Claude Code terminal command can bypass permissions explicitly", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "sonnet", {
      claudePermissionMode: "bypassPermissions",
    }).command,
    "claude --permission-mode bypassPermissions --model sonnet"
  );
});

test("Codex terminal command does not receive Claude permission flags", () => {
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "gpt-5.1-codex", {
      claudePermissionMode: "bypassPermissions",
    }).command,
    "codex --model gpt-5.1-codex"
  );
});

test("Claude terminal command can start in plan mode with effort", () => {
  assert.equal(
    buildAgentTerminalCommand("claude-cli", "default", {
      mode: "plan",
      effort: "high",
    }).command,
    "claude --permission-mode plan --effort high"
  );
});

test("Codex terminal command can enable goal mode with reasoning effort", () => {
  assert.equal(
    buildAgentTerminalCommand("codex-cli", "gpt-5.1-codex", {
      mode: "goal",
      effort: "high",
    }).command,
    "codex --enable goals -c 'model_reasoning_effort=\"high\"' --model gpt-5.1-codex"
  );
});

test("always enter only presses choice prompts after cooldown", () => {
  assert.equal(
    shouldAutoEnterChoice({
      alwaysEnter: true,
      state: "waiting-for-choice",
      now: 2_000,
    }),
    true
  );
  assert.equal(
    shouldAutoEnterChoice({
      alwaysEnter: true,
      state: "waiting-for-choice",
      now: 2_000,
      lastEnterAt: 1_400,
    }),
    false
  );
  assert.equal(
    shouldAutoEnterChoice({
      alwaysEnter: true,
      state: "ready-for-success",
      now: 2_000,
    }),
    false
  );
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

test("manual success is allowed even when the previous terminal state was stale waiting", () => {
  createAgentTerminalControlForTest("session_stale_waiting", {
    lastCompletionState: "waiting-for-choice",
  });

  assert.doesNotThrow(() => finishAgentTerminalSuccess("session_stale_waiting"));
});

test("completed-looking assistant output is classified as ready for success", () => {
  const content = [
    "已完成。",
    "验证：npm test 通过。",
    "下一步：无。",
  ].join("\n");

  assert.equal(classifyAgentTerminalContent(content), "ready-for-success");
});
