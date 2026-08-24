import assert from "node:assert/strict";
import test from "node:test";

import {
  cleanAgentTerminalConversation,
  lastAgentMessageFromSnapshot,
} from "./terminal-conversation.ts";

test("Codex snapshot removes startup, redraw, and progress noise", () => {
  const raw = [
    "Do you trust the contents of this directory?",
    "╭──────────────────────────────────────╮",
    "│ >_ OpenAI Codex (v0.144.4)          │",
    "╰──────────────────────────────────────╯",
    "gpt-5.5 low · D:\\demo",
    "- echoed prompt",
    "•Wor",
    "•Working",
    "• 我会直接新增极简 weather_spider.py。",
    "•orking",
    "• Added weather_spider.py (+16 -0)",
    "  1 +import sys",
    "10s • esc to interupt)",
    "• 已新增 weather_spider.py。",
    "──────────────────────────────────────",
  ].join("\r\n");

  assert.equal(
    cleanAgentTerminalConversation(raw, "codex-cli"),
    [
      "• 我会直接新增极简 weather_spider.py。",
      "• Added weather_spider.py (+16 -0)",
      "  1 +import sys",
      "• 已新增 weather_spider.py。",
    ].join("\n"),
  );
});

test("Claude snapshot removes transcript write warnings", () => {
  const raw = [
    "● 最后一条 Claude 消息",
    "⚠ Transcript writes are failing (permission denied—EPERM) · recent messages may no…",
  ].join("\n");

  assert.equal(cleanAgentTerminalConversation(raw, "claude-cli"), "● 最后一条 Claude 消息");
});

test("terminal fallback preserves short, repeated, and numeric answer lines", () => {
  const raw = ["1", "2", "3", "3", "4", "5", "ok"].join("\r\n");

  assert.equal(cleanAgentTerminalConversation(raw, "claude-cli"), raw.replace(/\r/g, ""));
});

test("details preserve an unparsed JSON final message from the agent snapshot", () => {
  const finalMessage = JSON.stringify(
    { summary: "README exists", exists: true, details: { path: "README.md" } },
    null,
    2,
  );

  assert.equal(
    lastAgentMessageFromSnapshot({
      status: "success",
      commandLine: "codex --model gpt-5",
      stdout: "",
      stderr: "",
      transcript: finalMessage,
    }),
    finalMessage,
  );
});

test("details show only the last structured assistant message", () => {
  assert.equal(
    lastAgentMessageFromSnapshot({
      status: "success",
      commandLine: "claude --permission-mode acceptEdits",
      stdout: "",
      stderr: "",
      transcript: ["User:\nquestion", "Claude:\nfirst", "Tool result:\nok", "Claude:\nlast"].join(
        "\n\n",
      ),
    }),
    "last",
  );
});

test("details preserve every line of a structured Claude final message", () => {
  const finalMessage = JSON.stringify(
    {
      id: "test-001",
      status: "completed",
      result: { summary: "README exists", exists: true },
    },
    null,
    2,
  );

  assert.equal(
    lastAgentMessageFromSnapshot({
      status: "success",
      commandLine: "claude --permission-mode acceptEdits",
      stdout: "",
      stderr: "",
      transcript: [
        "User:\ninspect README",
        "Tool · Read:\nREADME.md",
        "Tool result:\n# Osheep",
        `Claude:\n${finalMessage}`,
      ].join("\n\n"),
    }),
    finalMessage,
  );
});
