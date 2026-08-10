export interface TerminalWriteBatcher {
  push: (data: string) => void;
  flush: () => void;
  dispose: () => void;
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
