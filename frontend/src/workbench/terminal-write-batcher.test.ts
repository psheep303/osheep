import assert from "node:assert/strict";
import test from "node:test";
import { createTerminalWriteBatcher } from "./terminal-write-batcher";

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
