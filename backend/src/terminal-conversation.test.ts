import assert from "node:assert/strict";
import test from "node:test";
import {
  AgentTerminalConversationCollector,
  cleanAgentTerminalConversation,
  extractAgentRunMetadata,
  extractLastClaudeAnswer,
  extractLastCodexAnswerFromJsonlForTest,
  extractLastStructuredClaudeAnswer,
  formatClaudeJsonlConversationForTest,
} from "./terminal-conversation.js";

test("Codex JSONL returns task_complete final answer instead of tool output", () => {
  const jsonl = [
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "我先检查 workflow 文件。" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        name: "exec_command",
        input: "Get-ChildItem .osheep\\workflows\\*.json",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "custom_tool_call_output",
        output: "Runs: 0",
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "task_complete",
        last_agent_message: "最终结论：workflow 输出不应从终端工具记录提取。",
      },
    },
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");

  assert.equal(
    extractLastCodexAnswerFromJsonlForTest(jsonl),
    "最终结论：workflow 输出不应从终端工具记录提取。",
  );
});

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
  assert.doesNotMatch(conversation, /Thought for|\/btw|auto mode on|Tell Claude|Notepad|Cooked/);
  assert.equal(
    extractLastClaudeAnswer(conversation),
    "已完成极简天气爬虫。\n  - 新增 weather_spider.py\n  - 验证结果：4 passed",
  );
});

test("Claude terminal fallback removes transcript write warnings from the final answer", () => {
  const raw = [
    "● 已在 test/claude/index.html 写好极简羊特效。",
    "直接用浏览器打开，移动鼠标时会生成向上飘散的羊。",
    "⚠Transcriptwritesarefailing(permissiondenied—EPERM) ·recentmessagesmayno…",
  ].join("\n");
  const conversation = cleanAgentTerminalConversation(raw, "", "claude-cli");

  assert.doesNotMatch(conversation, /Transcript writes|Transcriptwrites|EPERM/);
  assert.equal(
    extractLastClaudeAnswer(conversation),
    "已在 test/claude/index.html 写好极简羊特效。\n直接用浏览器打开，移动鼠标时会生成向上飘散的羊。",
  );
});

test("Codex conversation starts at the first real event and removes TUI redraw fragments", () => {
  const raw = [
    "PS D:\\demo> codex --model gpt-5.5",
    "Do you trust the contents of this directory?",
    "╭──────────────────────────────────────╮",
    "│ >_ OpenAI Codex (v0.144.4)          │",
    "│ model: loading                      │",
    "╰──────────────────────────────────────╯",
    "gpt-5.5 low · D:\\demo",
    "- echoed user prompt",
    "•Wor",
    "•Work",
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
    cleanAgentTerminalConversation(raw, "", "codex-cli"),
    [
      "• 我会直接新增极简 weather_spider.py。",
      "• Added weather_spider.py (+16 -0)",
      "  1 +import sys",
      "• 已新增 weather_spider.py。",
    ].join("\n"),
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
  ]
    .map((value) => JSON.stringify(value))
    .join("\n");

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
