export const TERMINAL_REPLAY_BYTE_LIMIT = 256 * 1024;
export const AGENT_TERMINAL_REPLAY_BYTE_LIMIT = 4 * 1024 * 1024;

const SAFE_ANCHOR_SEARCH_CHARS = 64 * 1024;
const REPLAY_RESET = "\x1b[0m\x1b[?2026l\x1b[2J\x1b[H";

interface ReplayChunk {
  data: string;
  bytes: number;
}

export interface TerminalReplaySnapshot {
  data: string;
  startOffset: number;
  truncated: boolean;
}

export class TerminalReplayBuffer {
  private chunks: ReplayChunk[] = [];
  private head = 0;
  private bytes = 0;
  private droppedChars = 0;

  constructor(private readonly limit: number | null = TERMINAL_REPLAY_BYTE_LIMIT) {}

  append(data: string): void {
    if (!data) return;
    const dataBytes = Buffer.byteLength(data);
    if (this.limit === null) {
      this.chunks.push({ data, bytes: dataBytes });
      this.bytes += dataBytes;
      return;
    }
    if (this.limit <= 0) {
      this.droppedChars += data.length;
      return;
    }

    this.chunks.push({ data, bytes: dataBytes });
    this.bytes += dataBytes;
    this.trimToLimit();

    if (this.head > 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  value(): string {
    if (this.bytes === 0) return "";
    return this.chunks
      .slice(this.head)
      .map((chunk) => chunk.data)
      .join("");
  }

  snapshot(): TerminalReplaySnapshot {
    return {
      data: this.value(),
      startOffset: this.droppedChars,
      truncated: this.droppedChars > 0,
    };
  }

  private trimToLimit(): void {
    if (this.limit === null) return;
    let overflow = this.bytes - this.limit;
    while (overflow > 0) {
      const first = this.chunks[this.head];
      if (!first) return;
      if (first.bytes <= overflow) {
        overflow -= first.bytes;
        this.bytes -= first.bytes;
        this.droppedChars += first.data.length;
        this.head += 1;
        continue;
      }

      const encoded = Buffer.from(first.data);
      let byteOffset = overflow;
      while (byteOffset < encoded.length && (encoded[byteOffset]! & 0xc0) === 0x80) {
        byteOffset += 1;
      }
      const tail = encoded.subarray(byteOffset).toString("utf8");
      this.droppedChars += first.data.length - tail.length;
      this.bytes -= first.bytes;
      this.chunks[this.head] = { data: tail, bytes: encoded.length - byteOffset };
      this.bytes += encoded.length - byteOffset;
      overflow = 0;
    }
  }
}

export function prepareTerminalReplay(snapshot: TerminalReplaySnapshot): TerminalReplaySnapshot {
  if (!snapshot.truncated || !snapshot.data) return snapshot;
  const safeStart = findSafeReplayStart(snapshot.data);
  return {
    data: REPLAY_RESET + snapshot.data.slice(safeStart),
    startOffset: snapshot.startOffset + safeStart,
    truncated: true,
  };
}

function findSafeReplayStart(data: string): number {
  const searchEnd = Math.min(data.length, SAFE_ANCHOR_SEARCH_CHARS);
  const search = data.slice(0, searchEnd);

  const strongAnchors = [
    search.indexOf("\x1b[?1049h"),
    search.indexOf("\x1b[2J"),
    search.indexOf("\x1b[3J"),
  ].filter((offset) => offset >= 0);
  if (strongAnchors.length > 0) return Math.min(...strongAnchors);

  let synchronizedStart = search.indexOf("\x1b[?2026h");
  while (synchronizedStart >= 0) {
    if (data.indexOf("\x1b[?2026l", synchronizedStart + 8) >= 0) return synchronizedStart;
    synchronizedStart = search.indexOf("\x1b[?2026h", synchronizedStart + 1);
  }

  const lineBreak = search.search(/\r\n|[\r\n]/);
  if (lineBreak >= 0) {
    return lineBreak + (search.startsWith("\r\n", lineBreak) ? 2 : 1);
  }

  const escapeOffset = search.indexOf("\x1b", 1);
  return escapeOffset >= 0 ? escapeOffset : 0;
}
