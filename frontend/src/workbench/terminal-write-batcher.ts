export interface TerminalWriteBatcher {
  push: (data: string) => void;
  flush: () => void;
  dispose: () => void;
}

export interface TerminalReplayGuard {
  write: (data: string) => void;
  acceptsInput: () => boolean;
}

export function createTerminalReplayGuard(
  write: (data: string, callback: () => void) => void,
): TerminalReplayGuard {
  let pendingWrites = 0;
  return {
    write(data) {
      if (!data) return;
      pendingWrites += 1;
      write(data, () => {
        pendingWrites = Math.max(0, pendingWrites - 1);
      });
    },
    acceptsInput() {
      return pendingWrites === 0;
    },
  };
}

export function createTerminalWriteBatcher(
  write: (data: string) => void,
  schedule: (callback: FrameRequestCallback) => number = requestAnimationFrame,
  cancel: (handle: number) => void = cancelAnimationFrame,
): TerminalWriteBatcher {
  let chunks: string[] = [];
  let scheduled: number | null = null;

  const flush = () => {
    if (scheduled !== null) {
      cancel(scheduled);
      scheduled = null;
    }
    if (chunks.length === 0) return;
    const data = chunks.join("");
    chunks = [];
    write(data);
  };

  return {
    push(data) {
      if (!data) return;
      chunks.push(data);
      if (scheduled === null) {
        scheduled = schedule(() => {
          scheduled = null;
          if (chunks.length === 0) return;
          const data = chunks.join("");
          chunks = [];
          write(data);
        });
      }
    },
    flush,
    dispose() {
      if (scheduled !== null) cancel(scheduled);
      scheduled = null;
      chunks = [];
    },
  };
}
