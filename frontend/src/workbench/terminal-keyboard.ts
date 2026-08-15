import type { Terminal } from "@xterm/xterm";

export type ShiftEnterMode = "codex" | "kitty";

export interface ShiftEnterInputOptions {
  /** Force the input protocol for a known TUI session. */
  mode?: ShiftEnterMode;
  /** Send bytes directly when the transport must not pass through xterm again. */
  sendInput?: (data: string) => void;
}

export function isShiftEnterEvent(event: KeyboardEvent): boolean {
  return (
    event.key === "Enter" && event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey
  );
}

/**
 * Keep Shift+Enter compatible with shells and terminal TUI keyboard modes.
 *
 * Codex's Windows TUI treats Alt+Enter as insert_newline through ConPTY.
 * Ordinary shells keep receiving CR, while Claude continues to use Kitty
 * CSI-u.
 */
export function createShiftEnterInput(
  term: Terminal,
  options: ShiftEnterInputOptions = {},
): {
  send: (event: KeyboardEvent) => void;
  observeOutput: (data: string) => void;
  dispose: () => void;
} {
  let kittyKeyboardEnabled = false;
  let modifyOtherKeysEnabled = false;
  let codexDetected = options.mode === "codex";
  let outputProbe = "";
  const mode = term.parser.registerCsiHandler({ prefix: ">", final: "u" }, (params) => {
    const first = params[0];
    const flags = typeof first === "number" ? first : (first?.[0] ?? 0);
    kittyKeyboardEnabled = flags > 0;
    return true;
  });
  const popMode = term.parser.registerCsiHandler({ prefix: "<", final: "u" }, () => {
    kittyKeyboardEnabled = false;
    return true;
  });
  const modifyOtherKeys = term.parser.registerCsiHandler({ prefix: ">", final: "m" }, (params) => {
    const mode = params[0];
    const level = params[1];
    if (mode === 4) modifyOtherKeysEnabled = level === 2;
    return true;
  });
  const observeOutput = (data: string) => {
    if (options.mode || codexDetected) return;
    outputProbe = `${outputProbe}${stripTerminalControls(data)}`.slice(-4096);
    if (/openai\s+codex|welcome\s+to\s+codex/i.test(outputProbe)) {
      codexDetected = true;
    }
  };

  return {
    send: (event) => {
      // Codex 0.147 ignores CSI-u and modifyOtherKeys through ConPTY, but its
      // editor handles Alt+Enter (ESC + CR) as insert_newline.
      const input =
        options.mode === "codex" || codexDetected
          ? "\x1b\r"
          : options.mode === "kitty" || kittyKeyboardEnabled
            ? "\x1b[13;2u"
            : modifyOtherKeysEnabled
              ? "\x1b[27;2;13~"
              : "\r";
      if (options.sendInput) options.sendInput(input);
      else term.input(input);
      event.preventDefault();
      event.stopPropagation();
    },
    observeOutput,
    dispose: () => {
      mode.dispose();
      popMode.dispose();
      modifyOtherKeys.dispose();
    },
  };
}

function stripTerminalControls(data: string): string {
  return data
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[()][0-2A-Z]/g, "")
    .replace(/[\r\n]+/g, " ");
}
