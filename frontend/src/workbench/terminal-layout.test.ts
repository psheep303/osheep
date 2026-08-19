import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalUserInputGate,
  WORKFLOW_AGENT_TERMINAL_SAFE_ROWS,
  workflowAgentTerminalDimensions,
} from "./terminal-layout";

test("workflow agent terminals reserve a row below full-screen TUI input", () => {
  assert.equal(WORKFLOW_AGENT_TERMINAL_SAFE_ROWS, 1);
  assert.deepEqual(workflowAgentTerminalDimensions({ cols: 100, rows: 30 }), {
    cols: 100,
    rows: 29,
  });
});

test("workflow agent terminal dimensions reject unusable layouts", () => {
  assert.equal(workflowAgentTerminalDimensions(undefined), null);
  assert.equal(workflowAgentTerminalDimensions({ cols: 19, rows: 30 }), null);
  assert.equal(workflowAgentTerminalDimensions({ cols: 80, rows: 3 }), null);
  assert.deepEqual(workflowAgentTerminalDimensions({ cols: 80, rows: 4 }), {
    cols: 80,
    rows: 3,
  });
});

test("workflow terminal input gate distinguishes user keys from replay responses", () => {
  const gate = createTerminalUserInputGate();
  assert.equal(gate.accept("\u001b[1;1R"), false);

  gate.markKey("a");
  assert.equal(gate.accept("a"), true);
  assert.equal(gate.accept("a"), false);

  gate.markNextData();
  assert.equal(gate.accept("pasted text"), true);
  assert.equal(gate.accept("pasted text"), false);
});
