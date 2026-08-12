import assert from "node:assert/strict";
import test from "node:test";
import {
  extractAgentRunMetadata,
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
