import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalReplayGuard, createTerminalWriteBatcher } from "./terminal-write-batcher";

test("terminal replay guard suppresses generated responses until replay finishes", () => {
  const writes: string[] = [];
  const completions: Array<() => void> = [];
  const replay = createTerminalReplayGuard((data, callback) => {
    writes.push(data);
    completions.push(callback);
  });

  replay.write("\u001b]10;?\u001b\\");
  assert.equal(replay.acceptsInput(), false);
  assert.deepEqual(writes, ["\u001b]10;?\u001b\\"]);

  completions[0]?.();
  assert.equal(replay.acceptsInput(), true);
});

test("terminal write batcher preserves chunk order in one write", () => {
  const writes: string[] = [];
  let pending: FrameRequestCallback | null = null;
  const batcher = createTerminalWriteBatcher(
    (data) => writes.push(data),
    (callback) => {
      pending = callback;
      return 1;
    },
    () => {
      pending = null;
    },
  );

  batcher.push("\u001b[32m");
  batcher.push("Done");
  batcher.push("\u001b[0m\r\n");
  assert.deepEqual(writes, []);

  const frame = pending;
  assert.ok(frame);
  frame(0);
  assert.deepEqual(writes, ["\u001b[32mDone\u001b[0m\r\n"]);
});

test("terminal write batcher flushes pending output before terminal status text", () => {
  const writes: string[] = [];
  const batcher = createTerminalWriteBatcher(
    (data) => writes.push(data),
    () => 1,
    () => {},
  );

  batcher.push("answer");
  batcher.flush();
  writes.push("exit");

  assert.deepEqual(writes, ["answer", "exit"]);
});
