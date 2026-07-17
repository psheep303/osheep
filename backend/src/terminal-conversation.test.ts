import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTerminalConversationCollector,
  cleanAgentTerminalConversation,
  extractAgentRunMetadata,
  extractLastClaudeAnswer,
  extractLastStructuredClaudeAnswer,
  formatClaudeJsonlConversationForTest,
} from "./terminal-conversation.js";

const CLAUDE_CHROME = [
  "Tip: Use /btw to ask a quick side question without interrupting Claude's current work",
  "❯",
  "⏵⏵ auto mode on (shift+tab to cycle) · ← for agents ○ low · /effort",
  "3. Tell Claude what to change",
  "shift+tab to approve with this feedback",
  "ctrl+g to edit in Notepad.exe · C:\\Users\\demo\\.claude\\plans\\plan.md",
];

test("clean conversation keeps agent history and removes Claude terminal chrome", () => {
  const raw = [
    "Thought for 7s (ctrl+o to expand)",
    "● Bash(pytest tests/test_weather_spider.py)",
    "  ⎿ 4 passed",
    ...CLAUDE_CHROME,
    "● 已完成极简天气爬虫。",
    "  - 新增 weather_spider.py",
    "  - 验证结果：4 passed",
    "✻ Cooked for 16m 11s",
  ].join("\r\n");

  const conversation = cleanAgentTerminalConversation(raw);
  assert.match(conversation, /Bash\(pytest/);
  assert.match(conversation, /4 passed/);
  assert.match(conversation, /已完成极简天气爬虫/);
  assert.doesNotMatch(
    conversation,
    /Thought for|\/btw|auto mode on|Tell Claude|Notepad|Cooked/
  );
  assert.equal(
    extractLastClaudeAnswer(conversation),
    "已完成极简天气爬虫。\n  - 新增 weather_spider.py\n  - 验证结果：4 passed"
  );
});

test("conversation collector retains early and late dialogue across chunks", () => {
  const collector = new AgentTerminalConversationCollector();
  collector.push("● 先检查项目文件。\r\n● Read 1 file\r\n");
  collector.push(`${CLAUDE_CHROME.join("\r\n")}\r\n`);
  collector.push("● 已完成。\r\n  - pytest: 4 passed\r\n");
  const conversation = collector.value();

  assert.match(conversation, /先检查项目文件/);
  assert.match(conversation, /Read 1 file/);
  assert.match(conversation, /已完成/);
  assert.doesNotMatch(conversation, /shift\+tab|Notepad/);
});

test("Claude JSONL produces a complete structured conversation without thinking chrome", () => {
  const jsonl = [
    {
      type: "user",
      message: { role: "user", content: "实现天气爬虫" },
    },
    {
      type: "assistant",
      message: { role: "assistant", content: [{ type: "thinking", thinking: "hidden" }] },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "我先运行测试。" }],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Write", input: { file_path: "src/weather.py" } }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "4 passed" }],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", name: "Bash", input: { command: "pytest test.py" } }],
      },
    },
    {
      type: "user",
      message: {
        role: "user",
        content: [{ type: "tool_result", content: "4 passed" }],
      },
    },
    {
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "已完成，4 个测试通过。" }],
      },
    },
  ].map((value) => JSON.stringify(value)).join("\n");

  const conversation = formatClaudeJsonlConversationForTest(jsonl);
  assert.match(conversation, /User:\n实现天气爬虫/);
  assert.match(conversation, /Claude:\n我先运行测试/);
  assert.match(conversation, /Tool · Write:\nsrc\/weather\.py/);
  assert.match(conversation, /Tool · Bash:\n\$ pytest test\.py/);
  assert.match(conversation, /Tool result:\n4 passed/);
  assert.match(conversation, /Claude:\n已完成，4 个测试通过/);
  assert.doesNotMatch(conversation, /hidden|thinking/);
  assert.equal(extractLastStructuredClaudeAnswer(conversation), "已完成，4 个测试通过。");
  assert.deepEqual(extractAgentRunMetadata(conversation, "D:/workspace"), {
    changedFiles: ["src/weather.py"],
    verification: ["$ pytest test.py — 4 passed"],
  });
});
