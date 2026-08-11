export const TERMINAL_REPLAY_CHAR_LIMIT = 256 * 1024;

export class TerminalReplayBuffer {
  private chunks: string[] = [];
  private head = 0;
  private length = 0;

  constructor(private readonly limit: number | null = TERMINAL_REPLAY_CHAR_LIMIT) {}

  append(data: string): void {
    if (!data) return;
    if (this.limit === null) {
      this.chunks.push(data);
      this.length += data.length;
      return;
    }
    if (this.limit <= 0) return;

    if (data.length >= this.limit) {
      const tail = data.slice(-this.limit);
      this.chunks = [tail];
      this.head = 0;
      this.length = tail.length;
      return;
    }

    this.chunks.push(data);
    this.length += data.length;

    let overflow = this.length - this.limit;
    while (overflow > 0) {
      const first = this.chunks[this.head];
      if (first.length <= overflow) {
        overflow -= first.length;
        this.length -= first.length;
        this.head += 1;
        continue;
      }

      this.chunks[this.head] = first.slice(overflow);
      this.length -= overflow;
      overflow = 0;
    }

    if (this.head > 1024 && this.head * 2 >= this.chunks.length) {
      this.chunks = this.chunks.slice(this.head);
      this.head = 0;
    }
  }

  value(): string {
    if (this.length === 0) return "";
    return this.chunks.slice(this.head).join("");
  }
}
