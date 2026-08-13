import assert from "node:assert/strict";
import test from "node:test";
import { terminalReplayChunks } from "./routes/terminals.js";

test("terminal replay chunks preserve empty and multi-frame output", () => {
  assert.deepEqual(terminalReplayChunks(""), []);

  const replay = "x".repeat(4 * 1024 * 1024);
  const chunks = terminalReplayChunks(replay);
  assert.equal(chunks.length, 64);
  assert.equal(chunks.join(""), replay);
});

test("terminal replay chunks do not split a UTF-16 surrogate pair", () => {
  const replay = `${"x".repeat(64 * 1024 - 1)}\u{1f642}tail`;
  const chunks = terminalReplayChunks(replay);

  assert.equal(chunks.join(""), replay);
  assert.equal(chunks[0]?.endsWith("\ud83d"), false);
  assert.equal(chunks[1]?.startsWith("\ude42"), false);
});
