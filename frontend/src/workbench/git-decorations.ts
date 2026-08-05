import type { GitChange, GitStatus } from "./api";

export type GitFileStatus = "M" | "A" | "D" | "R" | "U" | "C";

export interface FileDecoration {
  /**
   * Status that applies to this exact path (only for files).
   */
  selfStatus?: GitFileStatus;
  /**
   * Highest-priority status among descendants (only for folders).
   */
  childStatus?: GitFileStatus;
}

export function statusColor(s: GitFileStatus): string {
  switch (s) {
    case "M":
      return "#e2c08d";
    case "A":
      return "#81b88b";
    case "D":
      return "#c74e39";
    case "R":
      return "#69a4ff";
    case "U":
      return "#73c991";
    case "C":
      return "#f48771";
  }
}

function priority(s: GitFileStatus): number {
  switch (s) {
    case "C":
      return 5;
    case "D":
      return 4;
    case "M":
      return 3;
    case "R":
      return 2;
    case "A":
      return 1;
    case "U":
      return 0;
  }
}

function letterToStatus(letter: string): GitFileStatus | null {
  if (letter === "M" || letter === "A" || letter === "D" || letter === "R" || letter === "C")
    return letter;
  if (letter === "?") return "U";
  return null;
}

function effectiveStatus(c: GitChange): GitFileStatus | null {
  const idx = letterToStatus(c.indexStatus);
  const wt = letterToStatus(c.worktreeStatus);
  if (!idx && !wt) return null;
  if (!idx) return wt;
  if (!wt) return idx;
  return priority(idx) >= priority(wt) ? idx : wt;
}

function parentOf(p: string): string {
  const i = p.lastIndexOf("/");
  return i >= 0 ? p.slice(0, i) : "";
}

/**
 * Build a map of path → decoration from a git status. For each change, the
 * decoration is placed on the exact file path; the same status is propagated
 * up the directory chain (max-priority wins) so folders can render a dot.
 *
 * Returns an empty map if status is null or not a repo.
 */
export function buildDecorations(status: GitStatus | null): Map<string, FileDecoration> {
  const map = new Map<string, FileDecoration>();
  if (!status?.isRepo) return map;

  for (const c of status.changes) {
    const s = effectiveStatus(c);
    if (!s) continue;
    const existing = map.get(c.path) ?? {};
    map.set(c.path, { ...existing, selfStatus: s });

    let parent = parentOf(c.path);
    // walk up to (and including) root ""
    // Use a sentinel: when parent becomes "" we set root once and break.
    // We do propagate one final time after the loop.
    while (parent !== "") {
      const ex = map.get(parent) ?? {};
      if (!ex.childStatus || priority(s) > priority(ex.childStatus)) {
        map.set(parent, { ...ex, childStatus: s });
      }
      parent = parentOf(parent);
    }
    const rootEx = map.get("") ?? {};
    if (!rootEx.childStatus || priority(s) > priority(rootEx.childStatus)) {
      map.set("", { ...rootEx, childStatus: s });
    }
  }

  return map;
}
