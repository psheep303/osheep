import type { Terminal } from "@xterm/xterm";

export function isShiftEnterEvent(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" &&
    event.shiftKey &&
    !event.ctrlKey &&
    !event.altKey &&
    !event.metaKey
  );
}

/** Keep Shift+Enter compatible with shells and Kitty-keyboard TUI clients. */
export function createShiftEnterInput(term: Terminal): {
  send: (event: KeyboardEvent) => void;
  dispose: () => void;
} {
  let keyboardEnhancementEnabled = false;

  const mode = term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
    const first = params[0];
    const flags = typeof first === "number" ? first : first?.[0] ?? 0;
    keyboardEnhancementEnabled = flags > 0;
    return true;
  });
  const popMode = term.parser.registerCsiHandler({ prefix: "<", final: "u" }, () => {
    keyboardEnhancementEnabled = false;
    return true;
  });
  // Some clients (including versions of Codex) use xterm's
  // modifyOtherKeys compatibility mode instead of Kitty's CSI-u mode.
  // Both modes encode modified keys with CSI-u input sequences.
  const modifyOtherKeys = term.parser.registerCsiHandler(
    { prefix: ">", final: "m" },
    (params) => {
      const mode = params[0];
      const level = params[1];
      if (mode === 4) keyboardEnhancementEnabled = level === 2;
      return true;
    },
  );

  return {
    send: (event) => {
      // CSI-u is valid only after the application enables keyboard enhancement.
      // Otherwise Shift+Enter must remain indistinguishable from Enter.
      term.input(keyboardEnhancementEnabled ? "\x1b[13;2u" : "\r");
      event.preventDefault();
      event.stopPropagation();
    },
    dispose: () => {
      mode.dispose();
      popMode.dispose();
      modifyOtherKeys.dispose();
    },
  };
}
