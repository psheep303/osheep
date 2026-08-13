import assert from "node:assert/strict";
import test from "node:test";
import { attachSink, publishPtyOutputForTest, resizeSession, type TerminalSession } from "./pty.js";
import { TerminalReplayBuffer } from "./terminal-replay-buffer.js";

function createReplaySession(): TerminalSession {
  return {
    replayBuffer: new TerminalReplayBuffer(1024),
    replayLength: 0,
    replayInitialCols: 120,
    replayInitialRows: 34,
    replayResizes: [],
    cols: 120,
    rows: 34,
    killOnDetach: false,
    pty: { resize: () => undefined },
    sink: null,
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

test("persistent terminal replay records the dimensions used by each output range", () => {
  const session = createReplaySession();
  publishPtyOutputForTest(session, "wide-screen");
  resizeSession(session, 84, 28);
  publishPtyOutputForTest(session, "narrow-screen");

  const replay = attachSink(session, () => undefined);
  assert.equal(replay.replayed, "wide-screennarrow-screen");
  assert.equal(replay.replayInitialCols, 120);
  assert.equal(replay.replayInitialRows, 34);
  assert.deepEqual(replay.replayResizes, [{ offset: 11, cols: 84, rows: 28 }]);
  replay.detach();
});

test("replay layout coalesces resizes that have no output between them", () => {
  const session = createReplaySession();
  resizeSession(session, 100, 30, { compactStartup: true });
  resizeSession(session, 84, 28, { compactStartup: true });
  resizeSession(session, 84, 28);

  const replay = attachSink(session, () => undefined);
  assert.deepEqual(replay.replayResizes, [{ offset: 0, cols: 84, rows: 28, compactStartup: true }]);
  replay.detach();
});

test("truncated replay rebases dimensions and resize offsets", () => {
  const session = createReplaySession();
  session.replayBuffer = new TerminalReplayBuffer(36);
  publishPtyOutputForTest(session, "old output before resize\r\n");
  resizeSession(session, 100, 30);
  publishPtyOutputForTest(session, "partial discarded\r\n");
  resizeSession(session, 84, 28);
  publishPtyOutputForTest(session, "complete retained line\r\n");

  const replay = attachSink(session, () => undefined);
  assert.equal(replay.replayTruncated, true);
  assert.equal(replay.replayInitialCols, 84);
  assert.equal(replay.replayInitialRows, 28);
  assert.equal(replay.replayed.endsWith("complete retained line\r\n"), true);
  assert.deepEqual(replay.replayResizes, []);
  replay.detach();
});
