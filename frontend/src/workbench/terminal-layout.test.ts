import assert from "node:assert/strict";
import test from "node:test";
import {
  createTerminalUserInputGate,
  resizeTerminalPreservingViewport,
  WORKFLOW_AGENT_TERMINAL_SAFE_ROWS,
  workflowAgentTerminalDimensions,
} from "./terminal-layout";

function fakeTerminal(viewportY: number, baseY: number) {
  const calls: string[] = [];
  let active = { viewportY, baseY };
  return {
    terminal: {
      buffer: {
        get active() {
          return active;
        },
      },
      scrollToBottom() {
        calls.push("bottom");
      },
      scrollToLine(line: number) {
        calls.push(`line:${line}`);
      },
    },
    calls,
    setActive(next: { viewportY: number; baseY: number }) {
      active = next;
    },
  };
}

test("terminal resize keeps a scrolled-up viewport at its original line", () => {
  const fake = fakeTerminal(42, 100);
  resizeTerminalPreservingViewport(fake.terminal, () =>
    fake.setActive({ viewportY: 42, baseY: 120 }),
  );
  assert.deepEqual(fake.calls, ["line:42"]);
});

test("terminal resize keeps a bottom-pinned viewport at the bottom", () => {
  const fake = fakeTerminal(100, 100);
  resizeTerminalPreservingViewport(fake.terminal, () =>
    fake.setActive({ viewportY: 100, baseY: 80 }),
  );
  assert.deepEqual(fake.calls, ["bottom"]);
});

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
