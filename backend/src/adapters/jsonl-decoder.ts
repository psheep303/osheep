/** Incremental JSONL decoder. Incomplete lines stay buffered until the next chunk. */
export class JsonlDecoder<T = unknown> {
  private buffer = "";
  constructor(private readonly parse: (line: string) => T | undefined = defaultParse<T>) {}

  push(chunk: string): T[] {
    this.buffer += chunk;
    const lines = this.buffer.split(/\r?\n/);
    this.buffer = lines.pop() ?? "";
    return lines.flatMap((line) => this.decode(line));
  }

  flush(): T[] {
    if (!this.buffer.trim()) {
      this.buffer = "";
      return [];
    }
    const line = this.buffer;
    this.buffer = "";
    return this.decode(line);
  }

  reset(): void {
    this.buffer = "";
  }

  private decode(line: string): T[] {
    const value = line.trim();
    if (!value) return [];
    try {
      const parsed = this.parse(value);
      return parsed === undefined ? [] : [parsed];
    } catch {
      return [];
    }
  }
}

function defaultParse<T>(line: string): T | undefined {
  return JSON.parse(line) as T;
}

export class SequenceAllocator {
  private sequence = 0;
  next(): number {
    this.sequence += 1;
    return this.sequence;
  }
  current(): number {
    return this.sequence;
  }
  reset(value = 0): void {
    this.sequence = Number.isInteger(value) && value >= 0 ? value : 0;
  }
}
