import assert from "node:assert/strict";
import test from "node:test";
import { prepareTerminalReplay, TerminalReplayBuffer } from "./terminal-replay-buffer.js";

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

test("terminal replay limit counts UTF-8 bytes without splitting a code point", () => {
  const replay = new TerminalReplayBuffer(7);
  replay.append("ab羊羊c");

  assert.equal(replay.value(), "羊羊c");
  assert.deepEqual(replay.snapshot(), {
    data: "羊羊c",
    startOffset: 2,
    truncated: true,
  });
});

test("truncated replay starts from a complete synchronized update", () => {
  const replay = new TerminalReplayBuffer(64);
  replay.append("discarded partial line");
  replay.append(" still partial\x1b[?2026hcomplete frame\x1b[?2026lprompt");

  const prepared = prepareTerminalReplay(replay.snapshot());
  assert.equal(prepared.truncated, true);
  assert.equal(prepared.data.startsWith("\x1b[0m\x1b[?2026l\x1b[2J\x1b[H\x1b[?2026h"), true);
  assert.equal(prepared.data.includes("complete frame\x1b[?2026lprompt"), true);
});

test("truncated plain output drops its first incomplete line", () => {
  const replay = new TerminalReplayBuffer(18);
  replay.append("old line\r\npartial line\r\ncomplete\r\n");

  const prepared = prepareTerminalReplay(replay.snapshot());
  assert.equal(prepared.data.endsWith("complete\r\n"), true);
  assert.equal(prepared.data.includes("partial line"), false);
});
