export interface TerminalWriteBatcher {
  push: (data: string) => void;
  flush: () => void;
  dispose: () => void;
}

export interface TerminalReplayGuard {
  write: (data: string, onComplete?: () => void, settle?: boolean, settleDelayMs?: number) => void;
  acceptsInput: () => boolean;
}

export interface TerminalReplayResize {
  offset: number;
  cols: number;
  rows: number;
  compactStartup?: boolean;
}

export interface TerminalReplaySegment {
  data: string;
  cols: number;
  rows: number;
}

export function createTerminalReplayGuard(
  write: (data: string, callback: () => void) => void,
  settleMs = 50,
  schedule: (callback: () => void, delay: number) => ReturnType<typeof setTimeout> = setTimeout,
): TerminalReplayGuard {
  let pendingWrites = 0;
  return {
    write(data, onComplete, settle = true, settleDelayMs = settleMs) {
      pendingWrites += 1;
      const finish = () => {
        const complete = () => {
          pendingWrites = Math.max(0, pendingWrites - 1);
          onComplete?.();
        };
        if (settle && settleDelayMs > 0) schedule(complete, settleDelayMs);
        else complete();
      };
      if (data) write(data, finish);
      else finish();
    },
    acceptsInput() {
      return pendingWrites === 0;
    },
  };
}

export function terminalReplaySegments(
  data: string,
  fallbackCols: number,
  fallbackRows: number,
  initialCols: number | undefined,
  initialRows: number | undefined,
  resizes: TerminalReplayResize[] | undefined,
): TerminalReplaySegment[] {
  let cols = validTerminalSize(initialCols) ? initialCols : fallbackCols;
  let rows = validTerminalSize(initialRows) ? initialRows : fallbackRows;
  const segments: TerminalReplaySegment[] = [];
  let offset = 0;

  for (const resize of resizes ?? []) {
    if (
      !Number.isInteger(resize.offset) ||
      resize.offset < offset ||
      resize.offset > data.length ||
      !validTerminalSize(resize.cols) ||
      !validTerminalSize(resize.rows)
    ) {
      continue;
    }
    const segmentData = data.slice(offset, resize.offset);
    segments.push({
      data: resize.compactStartup ? compactSupersededClaudeStartup(segmentData) : segmentData,
      cols,
      rows,
    });
    offset = resize.offset;
    cols = resize.cols;
    rows = resize.rows;
  }
  segments.push({ data: data.slice(offset), cols, rows });
  return segments;
}

function validTerminalSize(value: number | undefined): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

export function compactSupersededClaudeStartup(data: string): string {
  const welcomeStart = data.lastIndexOf("╭───");
  if (welcomeStart < 0) return data;
  const heading = data.slice(welcomeStart, welcomeStart + 512);
  if (!heading.includes("Claude") || !heading.includes("Code") || !/v\d+\./.test(heading)) {
    return data;
  }
  const synchronizedUpdateStart = data.lastIndexOf("\x1b[?2026h", welcomeStart);
  return data.slice(0, synchronizedUpdateStart >= 0 ? synchronizedUpdateStart : welcomeStart);
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
