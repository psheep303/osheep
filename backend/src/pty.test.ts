import assert from "node:assert/strict";
import test from "node:test";
import { attachSink, publishPtyOutputForTest, type TerminalSession } from "./pty.js";
import { TerminalReplayBuffer } from "./terminal-replay-buffer.js";

function createReplaySession(): TerminalSession {
  return {
    replayBuffer: new TerminalReplayBuffer(1024),
    sink: null,
    taps: new Set(),
  } as unknown as TerminalSession;
}

test("reattaching a terminal replays context retained during live and detached output", () => {
  const session = createReplaySession();
  const initialScreen = "\x1b[2J\x1b[HClaude Code\r\n";
  const liveOutput = "Working...\r\n";
  const choiceMenu = "\x1b[4;1HChoose:\r\n\x1b[7m> 1. Allow\x1b[0m\r\n  2. Deny";
  publishPtyOutputForTest(session, initialScreen);

  const firstFrames: string[] = [];
  const first = attachSink(session, (frame) => firstFrames.push(frame));
  assert.equal(first.replayed, initialScreen);

  publishPtyOutputForTest(session, liveOutput);
  assert.deepEqual(firstFrames, [JSON.stringify({ type: "output", data: liveOutput })]);

  first.detach();
  publishPtyOutputForTest(session, choiceMenu);
  assert.equal(firstFrames.length, 1);

  const secondFrames: string[] = [];
  const second = attachSink(session, (frame) => secondFrames.push(frame));
  assert.equal(second.replayed, initialScreen + liveOutput + choiceMenu);
  assert.deepEqual(secondFrames, []);
  second.detach();
});
