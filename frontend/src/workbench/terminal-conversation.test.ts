import assert from "node:assert/strict";
import test from "node:test";

import { cleanAgentTerminalConversation } from "./terminal-conversation.ts";

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
