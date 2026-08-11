import assert from "node:assert/strict";
import test from "node:test";
import {
  compactSupersededClaudeStartup,
  createTerminalReplayGuard,
  createTerminalWriteBatcher,
  stableClaudeStartupRedraw,
  terminalReplaySegments,
} from "./terminal-write-batcher";

test("terminal replay guard suppresses generated responses until replay finishes", () => {
  const writes: string[] = [];
  const completions: Array<() => void> = [];
  const settlements: Array<() => void> = [];
  const replay = createTerminalReplayGuard(
    (data, callback) => {
      writes.push(data);
      completions.push(callback);
    },
    50,
    (callback) => {
      settlements.push(callback);
      return 1;
    },
  );
  let completed = false;

  replay.write("\u001b]10;?\u001b\\", () => {
    completed = true;
  });
  assert.equal(replay.acceptsInput(), false);
  assert.deepEqual(writes, ["\u001b]10;?\u001b\\"]);

  completions[0]?.();
  assert.equal(replay.acceptsInput(), false);
  assert.equal(completed, false);
  settlements[0]?.();
  assert.equal(replay.acceptsInput(), true);
  assert.equal(completed, true);
});

test("terminal replay guard only settles the final layout segment", () => {
  const completions: Array<() => void> = [];
  const settlements: Array<() => void> = [];
  const replay = createTerminalReplayGuard(
    (_data, callback) => completions.push(callback),
    50,
    (callback) => {
      settlements.push(callback);
      return 1;
    },
  );

  replay.write("wide", undefined, false);
  completions[0]?.();
  assert.equal(replay.acceptsInput(), true);
  assert.equal(settlements.length, 0);

  replay.write("narrow");
  completions[1]?.();
  assert.equal(replay.acceptsInput(), false);
  settlements[0]?.();
  assert.equal(replay.acceptsInput(), true);
});

test("terminal replay segments preserve the dimensions used by the original output", () => {
  assert.deepEqual(
    terminalReplaySegments("wide-screennarrow-screen", 84, 28, 120, 34, [
      { offset: 11, cols: 84, rows: 28 },
    ]),
    [
      { data: "wide-screen", cols: 120, rows: 34 },
      { data: "narrow-screen", cols: 84, rows: 28 },
    ],
  );
});

test("terminal replay removes only a superseded Claude startup screen", () => {
  const prelude = "PS> claude\r\nmodel warning\r\n";
  const interrupted = "\x1b[?2026h\x1b[38;5;174m╭───\x1b[6GClaude\x1b[13GCode\x1b[18Gv2.1.226";
  const transition = "\x1b[?2026h\x1b[2;76Hfile\r\nwith\r\ninstructions\x1b[?2026l";
  const redrawn = "\x1b[?2026h╭─── Claude Code v2.1.226 ───╮\r\n╰───╯\x1b[?2026l";
  const prompt = "\r\n❯ retained prompt";
  const data = prelude + interrupted + transition + redrawn + prompt;

  assert.deepEqual(
    terminalReplaySegments(data, 84, 28, 120, 34, [
      {
        offset: prelude.length + interrupted.length,
        cols: 84,
        rows: 28,
        compactStartup: true,
      },
    ]),
    [
      { data: prelude, cols: 120, rows: 34 },
      { data: redrawn + prompt, cols: 84, rows: 28 },
    ],
  );
});

test("terminal replay repairs an unmarked resize transition around Claude startup", () => {
  const prelude = "PS> claude\r\n";
  const oldWelcome = "\x1b[?2026h╭─── Claude Code v2.1.226 ───╮\r\n╰───╯\x1b[?2026l";
  const transition = "\x1b[?2026h\x1b[2;76Hfile\r\nwith\r\ninstructions\x1b[?2026l";
  const newWelcome = "\x1b[?2026h╭─── Claude Code v2.1.226 ───╮\r\n╰───╯\x1b[?2026l";
  const data = prelude + oldWelcome + transition + newWelcome;
  const offset = (prelude + oldWelcome).length;

  assert.deepEqual(
    terminalReplaySegments(data, 84, 28, 120, 34, [{ offset, cols: 84, rows: 28 }]),
    [
      { data: prelude, cols: 120, rows: 34 },
      { data: newWelcome, cols: 84, rows: 28 },
    ],
  );
});

test("startup compaction preserves output after a completed welcome update", () => {
  const welcome = "\x1b[?2026h╭─── Claude Code v2.1.226 ───╮\r\n╰───╯\x1b[?2026l";
  const prompt = "\r\n❯ keep this prompt";

  assert.equal(
    compactSupersededClaudeStartup(`shell\r\n${welcome}${prompt}`),
    `shell\r\n${prompt}`,
  );
});

test("startup compaction ignores welcome text outside a synchronized terminal update", () => {
  const copiedText = "answer\r\n╭─── Claude Code v2.1.226 ───╮\r\n╰───╯\r\nmore context";

  assert.equal(compactSupersededClaudeStartup(copiedText), copiedText);
  assert.equal(stableClaudeStartupRedraw(copiedText), null);
});

test("startup redraw waits for a complete table before dropping transition bytes", () => {
  const transition = "\x1b[?2026h\x1b[2;76Hfile\r\nwith\r\ninstructions\x1b[?2026l";
  const partial = "\x1b[?2026h╭─── Claude Code v2.1.226 ───╮";
  const complete = `${partial}\r\n╰───╯\x1b[?2026l\r\n❯ prompt`;

  assert.equal(stableClaudeStartupRedraw(transition + partial), null);
  assert.equal(stableClaudeStartupRedraw(transition + complete), complete);
});

test("first attach keeps the shell prelude while preparing a clean startup resize", () => {
  const prelude = "PS> claude\r\nmodel warning\r\n";
  const interrupted = "\x1b[?2026h\x1b[38;5;174m╭───\x1b[6GClaude\x1b[13GCode\x1b[18Gv2.1.226";
  const data = prelude + interrupted;

  assert.deepEqual(
    terminalReplaySegments(data, 84, 28, 120, 34, [
      {
        offset: data.length,
        cols: 84,
        rows: 28,
        compactStartup: true,
      },
    ]),
    [
      { data: prelude, cols: 120, rows: 34 },
      { data: "", cols: 84, rows: 28 },
    ],
  );
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
