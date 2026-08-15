import assert from "node:assert/strict";
import test from "node:test";
import type { Terminal } from "@xterm/xterm";
import { createShiftEnterInput } from "./terminal-keyboard";

function makeTerminal() {
  const handlers = new Map<string, (params: number[]) => boolean>();
  const inputs: string[] = [];
  const terminal = {
    parser: {
      registerCsiHandler: (
        sequence: { prefix?: string; final: string },
        handler: (params: number[]) => boolean,
      ) => {
        handlers.set(`${sequence.prefix ?? ""}${sequence.final}`, handler);
        return { dispose: () => undefined };
      },
    },
    input: (data: string) => inputs.push(data),
  } as unknown as Terminal;
  return { handlers, inputs, terminal };
}

function send(helper: ReturnType<typeof createShiftEnterInput>) {
  helper.send({
    preventDefault: () => undefined,
    stopPropagation: () => undefined,
  } as KeyboardEvent);
}

test("Shift+Enter stays Enter in an ordinary terminal", () => {
  const { inputs, terminal } = makeTerminal();
  const helper = createShiftEnterInput(terminal);

  send(helper);
  assert.deepEqual(inputs, ["\r"]);
  helper.dispose();
});

test("Shift+Enter uses Alt+Enter in Codex mode", () => {
  const { inputs, terminal } = makeTerminal();
  const helper = createShiftEnterInput(terminal, { mode: "codex" });

  send(helper);
  assert.deepEqual(inputs, ["\x1b\r"]);
  helper.dispose();
});

test("Codex banner enables Alt+Enter", () => {
  const { inputs, terminal } = makeTerminal();
  const helper = createShiftEnterInput(terminal);

  helper.observeOutput("OpenAI Codex (v0.147.0)");
  send(helper);
  assert.deepEqual(inputs, ["\x1b\r"]);
  helper.dispose();
});

test("ordinary terminal output does not activate Codex mode", () => {
  const { inputs, terminal } = makeTerminal();
  const helper = createShiftEnterInput(terminal);

  helper.observeOutput("codex --help");
  send(helper);
  assert.deepEqual(inputs, ["\r"]);
  helper.dispose();
});

test("Claude mode uses Kitty CSI-u even without negotiation", () => {
  const { inputs, terminal } = makeTerminal();
  const helper = createShiftEnterInput(terminal, { mode: "kitty" });

  send(helper);
  assert.deepEqual(inputs, ["\x1b[13;2u"]);
  helper.dispose();
});

test("modifyOtherKeys negotiation remains available for non-forced terminals", () => {
  const { handlers, inputs, terminal } = makeTerminal();
  const helper = createShiftEnterInput(terminal);

  handlers.get(">m")?.([4, 2]);
  send(helper);
  assert.deepEqual(inputs, ["\x1b[27;2;13~"]);

  handlers.get(">m")?.([4, 0]);
  send(helper);
  assert.deepEqual(inputs, ["\x1b[27;2;13~", "\r"]);
  helper.dispose();
});

test("Shift+Enter prefers Kitty CSI-u when both modes are enabled", () => {
  const { handlers, inputs, terminal } = makeTerminal();
  const helper = createShiftEnterInput(terminal);

  handlers.get(">u")?.([1]);
  send(helper);
  assert.deepEqual(inputs, ["\x1b[13;2u"]);

  handlers.get("<u")?.([]);
  send(helper);
  assert.deepEqual(inputs, ["\x1b[13;2u", "\r"]);
  helper.dispose();
});
