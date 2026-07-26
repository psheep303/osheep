// Lightweight line-level diff used by the chat timeline's tool steps to render
// a single, whole-file thumbnail diff for `edit_file` / `multi_edit` — one
// card per changed file (with real line numbers and context), instead of a
// stack of per-edit -/+ snippets. The full, precise diff still lives in the
// Monaco "完整 diff →" tab; this is only the compact preview.
//
// Dependency-free and bounded: we trim the common prefix/suffix first (an edit
// is almost always local), then run an LCS only on the differing middle. If
// that middle is still huge we fall back to a plain delete-block + add-block,
// and every result is clipped to `maxRows` so a thumbnail never explodes.

export type DiffRowType = "ctx" | "add" | "del" | "gap";

export interface DiffRow {
  type: DiffRowType;
  /**
   * 1-based gutter line number. New-file number for `ctx` / `add`, old-file
   * number for `del`. Absent on `gap` separators.
   */
  num?: number;
  /** Row text. For `gap` rows this is a label like "⋯ 12 行未改动". */
  text: string;
}

export interface UnifiedDiff {
  rows: DiffRow[];
  added: number;
  removed: number;
  /** True when rows were clipped because the change was larger than the cap. */
  truncated: boolean;
}

interface Op {
  t: "ctx" | "add" | "del";
  line: string;
}

const LCS_CELL_CAP = 250_000; // ~500×500 — above this we use the block fallback

/** Split into lines, dropping the single trailing "" produced by a final \n. */
function toLines(s: string): string[] {
  const lines = s.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Myers-free LCS via DP backtrack. Bounded by the caller; O(n·m). */
function lcsOps(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  if (n === 0) return b.map((line) => ({ t: "add" as const, line }));
  if (m === 0) return a.map((line) => ({ t: "del" as const, line }));

  // dp[i][j] = LCS length of a[i:] and b[j:]
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i -= 1) {
    for (let j = m - 1; j >= 0; j -= 1) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }

  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ t: "ctx", line: a[i]! });
      i += 1;
      j += 1;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      ops.push({ t: "del", line: a[i]! });
      i += 1;
    } else {
      ops.push({ t: "add", line: b[j]! });
      j += 1;
    }
  }
  while (i < n) ops.push({ t: "del", line: a[i++]! });
  while (j < m) ops.push({ t: "add", line: b[j++]! });
  return ops;
}

export function buildUnifiedDiff(
  before: string,
  after: string,
  opts?: { context?: number; maxRows?: number },
): UnifiedDiff {
  const context = Math.max(0, opts?.context ?? 3);
  const maxRows = Math.max(8, opts?.maxRows ?? 60);

  const a = toLines(before);
  const b = toLines(after);

  // Trim common prefix.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre += 1;
  // Trim common suffix (not overlapping the prefix).
  let suf = 0;
  while (
    suf < a.length - pre &&
    suf < b.length - pre &&
    a[a.length - 1 - suf] === b[b.length - 1 - suf]
  ) {
    suf += 1;
  }

  const aMid = a.slice(pre, a.length - suf);
  const bMid = b.slice(pre, b.length - suf);

  let midOps: Op[];
  if (aMid.length * bMid.length > LCS_CELL_CAP) {
    // Too large to diff precisely for a thumbnail — show the changed region as
    // a delete block followed by an add block. The Monaco tab has the exact diff.
    midOps = [
      ...aMid.map((line) => ({ t: "del" as const, line })),
      ...bMid.map((line) => ({ t: "add" as const, line })),
    ];
  } else {
    midOps = lcsOps(aMid, bMid);
  }

  const added = midOps.filter((o) => o.t === "add").length;
  const removed = midOps.filter((o) => o.t === "del").length;

  // Assemble the full op list: common prefix (ctx) + middle + common suffix (ctx).
  const ops: Op[] = [
    ...a.slice(0, pre).map((line) => ({ t: "ctx" as const, line })),
    ...midOps,
    ...a.slice(a.length - suf).map((line) => ({ t: "ctx" as const, line })),
  ];

  // Number every row up front, before collapsing, so gutters stay correct.
  const numbered: DiffRow[] = [];
  let oldNo = 1;
  let newNo = 1;
  for (const op of ops) {
    if (op.t === "ctx") {
      numbered.push({ type: "ctx", num: newNo, text: op.line });
      oldNo += 1;
      newNo += 1;
    } else if (op.t === "del") {
      numbered.push({ type: "del", num: oldNo, text: op.line });
      oldNo += 1;
    } else {
      numbered.push({ type: "add", num: newNo, text: op.line });
      newNo += 1;
    }
  }

  const changeIdx: number[] = [];
  numbered.forEach((r, idx) => {
    if (r.type !== "ctx") changeIdx.push(idx);
  });
  if (changeIdx.length === 0) {
    return { rows: [], added: 0, removed: 0, truncated: false };
  }

  // Keep changes and `context` ctx rows around each; collapse the rest to gaps.
  const keep = new Array<boolean>(numbered.length).fill(false);
  for (const idx of changeIdx) {
    for (
      let k = Math.max(0, idx - context);
      k <= Math.min(numbered.length - 1, idx + context);
      k += 1
    ) {
      keep[k] = true;
    }
  }

  const collapsed: DiffRow[] = [];
  let dropped = 0;
  for (let idx = 0; idx < numbered.length; idx += 1) {
    if (keep[idx]) {
      if (dropped > 0) {
        collapsed.push({ type: "gap", text: `⋯ ${dropped} 行未改动` });
        dropped = 0;
      }
      collapsed.push(numbered[idx]!);
    } else {
      dropped += 1;
    }
  }
  if (dropped > 0) collapsed.push({ type: "gap", text: `⋯ ${dropped} 行未改动` });

  let truncated = false;
  let rows = collapsed;
  if (rows.length > maxRows) {
    rows = rows.slice(0, maxRows);
    truncated = true;
  }

  return { rows, added, removed, truncated };
}
