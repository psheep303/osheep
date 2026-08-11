import assert from "node:assert/strict";
import test from "node:test";
import { TerminalReplayBuffer } from "./terminal-replay-buffer.js";

test("terminal replay buffer keeps the exact bounded output tail", () => {
  const replay = new TerminalReplayBuffer(12);

  replay.append("012345");
  replay.append("6789");
  replay.append("abcdef");

  assert.equal(replay.value(), "456789abcdef");
});

test("terminal replay buffer preserves ANSI choice-menu context exactly", () => {
  const replay = new TerminalReplayBuffer(1024);
  const initialScreen = "\x1b[2J\x1b[HClaude Code\r\n";
  const choiceMenu = "\x1b[4;1HChoose an action:\r\n\x1b[7m> 1. Allow\x1b[0m\r\n  2. Deny";

  replay.append(initialScreen);
  replay.append(choiceMenu);

  assert.equal(replay.value(), initialScreen + choiceMenu);
  assert.equal(replay.value(), initialScreen + choiceMenu);
});

test("terminal replay buffer handles a single chunk larger than its limit", () => {
  const replay = new TerminalReplayBuffer(5);

  replay.append("old");
  replay.append("0123456789");

  assert.equal(replay.value(), "56789");
});

test("unbounded terminal replay preserves the initial ANSI state across a long session", () => {
  const replay = new TerminalReplayBuffer(null);
  const initialState = "\x1b[?1049h\x1b[2J\x1b[HClaude Code";
  replay.append(initialState);
  for (let index = 0; index < 10_000; index += 1) {
    replay.append(`\x1b[${(index % 20) + 1};1Hframe-${index}`);
  }

  assert.equal(replay.value().startsWith(initialState), true);
  assert.equal(replay.value().endsWith("frame-9999"), true);
});
