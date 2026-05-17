import { useEffect, useMemo, useState } from "react";
import { getGitLog, type GitCommit } from "./api";

interface GitGraphProps {
  workspaceId: string;
  /** Bumped externally to force a refetch. */
  refreshKey: number;
}

interface LaneRow {
  commit: GitCommit;
  // Index of the lane the dot lives in for this row.
  laneIndex: number;
  // Lanes occupied entering this row, with their expected SHA.
  // Used to render vertical lines that pass through.
  incomingLanes: (string | null)[];
  // Lanes occupied leaving this row.
  outgoingLanes: (string | null)[];
}

const ROW_HEIGHT = 22;
const LANE_WIDTH = 14;
const DOT_RADIUS = 3.5;
const MAX_LANES = 8;

const LANE_COLORS = [
  "#3a9eff",
  "#e2c08d",
  "#73c991",
  "#c586c0",
  "#f48771",
  "#69a4ff",
  "#a3a3a3",
  "#d29922",
];

export function GitGraph({ workspaceId, refreshKey }: GitGraphProps) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [head, setHead] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getGitLog(workspaceId, 200, 0, "HEAD")
      .then((r) => {
        if (cancelled) return;
        setCommits(r.commits);
        setHead(r.head);
      })
      .catch((e) => {
        if (cancelled) return;
        setError((e as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, refreshKey]);

  const rows = useMemo(() => buildLanes(commits), [commits]);

  if (!workspaceId) return null;

  return (
    <div className="git-graph">
      {loading && <div className="git-graph__hint muted">加载提交历史…</div>}
      {error && <div className="git-graph__error">{error}</div>}
      {!loading && !error && commits.length === 0 && (
        <div className="git-graph__hint muted">没有提交</div>
      )}
      {rows.map((row) => (
        <GraphRow key={row.commit.sha} row={row} isHead={row.commit.sha === head} />
      ))}
    </div>
  );
}

function GraphRow({ row, isHead }: { row: LaneRow; isHead: boolean }) {
  const width = Math.max(row.incomingLanes.length, row.outgoingLanes.length) * LANE_WIDTH + 8;
  return (
    <div className="git-graph__row" title={row.commit.sha}>
      <svg
        className="git-graph__svg"
        width={Math.max(width, LANE_WIDTH * 2)}
        height={ROW_HEIGHT}
        viewBox={`0 0 ${Math.max(width, LANE_WIDTH * 2)} ${ROW_HEIGHT}`}
      >
        {renderRowLines(row)}
        <circle
          cx={row.laneIndex * LANE_WIDTH + LANE_WIDTH / 2}
          cy={ROW_HEIGHT / 2}
          r={DOT_RADIUS}
          fill={LANE_COLORS[row.laneIndex % LANE_COLORS.length]}
          stroke="#1f1f1f"
          strokeWidth={1}
        />
      </svg>
      <div className="git-graph__body">
        <span className="git-graph__subject" title={row.commit.subject}>
          {row.commit.subject}
        </span>
        {row.commit.refs.length > 0 && (
          <span className="git-graph__refs">
            {row.commit.refs
              .filter((r) => r !== "HEAD")
              .map((r) => (
                <span
                  key={r}
                  className={
                    "git-graph__ref" +
                    (isHead && r === "HEAD" ? " is-head" : "") +
                    (row.commit.refs.includes("HEAD") && isRefLocalBranch(r)
                      ? " is-head"
                      : "")
                  }
                  title={r}
                >
                  {shortRef(r)}
                </span>
              ))}
          </span>
        )}
        <span className="git-graph__meta">
          <span className="git-graph__sha">{row.commit.shortSha}</span>
          <span className="git-graph__author">{row.commit.author}</span>
        </span>
      </div>
    </div>
  );
}

function renderRowLines(row: LaneRow) {
  const segments: React.ReactNode[] = [];
  const maxLanes = Math.max(row.incomingLanes.length, row.outgoingLanes.length);
  // Vertical line passing top→middle for each incoming lane that continues
  for (let i = 0; i < maxLanes; i++) {
    const inSha = row.incomingLanes[i];
    if (!inSha) continue;
    const x = i * LANE_WIDTH + LANE_WIDTH / 2;
    const color = LANE_COLORS[i % LANE_COLORS.length];
    if (inSha === row.commit.sha) {
      // dot lane: line stops at center (drawn by circle)
      segments.push(
        <line
          key={`top-${i}`}
          x1={x}
          y1={0}
          x2={x}
          y2={ROW_HEIGHT / 2}
          stroke={color}
          strokeWidth={1.2}
        />
      );
    } else {
      // pass-through
      segments.push(
        <line
          key={`thru-${i}`}
          x1={x}
          y1={0}
          x2={x}
          y2={ROW_HEIGHT}
          stroke={color}
          strokeWidth={1.2}
        />
      );
    }
  }
  // Outgoing lanes from middle→bottom: any lane where outgoingLanes[i] exists.
  for (let i = 0; i < maxLanes; i++) {
    const outSha = row.outgoingLanes[i];
    if (!outSha) continue;
    const x = i * LANE_WIDTH + LANE_WIDTH / 2;
    const color = LANE_COLORS[i % LANE_COLORS.length];
    const dotX = row.laneIndex * LANE_WIDTH + LANE_WIDTH / 2;
    if (i === row.laneIndex) {
      // straight down from dot
      segments.push(
        <line
          key={`bot-${i}`}
          x1={x}
          y1={ROW_HEIGHT / 2}
          x2={x}
          y2={ROW_HEIGHT}
          stroke={color}
          strokeWidth={1.2}
        />
      );
    } else {
      // diagonal from dot to outgoing lane (merge fork)
      segments.push(
        <line
          key={`fork-${i}`}
          x1={dotX}
          y1={ROW_HEIGHT / 2}
          x2={x}
          y2={ROW_HEIGHT}
          stroke={color}
          strokeWidth={1.2}
        />
      );
    }
  }
  return segments;
}

/**
 * Allocate lanes for each commit in linear-newest-first order.
 *
 * Strategy:
 * - Maintain `lanes: (sha|null)[]` = expected SHA at each column.
 * - For each commit in order:
 *   - Find its lane (first index where lanes[i] === commit.sha).
 *   - If not present, allocate a new lane.
 *   - Compute outgoing lanes: replace its lane with first parent;
 *     additional parents land in the first lane that's null OR matches
 *     that parent (so existing branches reconverge).
 *   - If no parents, lane becomes null (terminates).
 */
function buildLanes(commits: GitCommit[]): LaneRow[] {
  const rows: LaneRow[] = [];
  let lanes: (string | null)[] = [];

  for (const c of commits) {
    let laneIndex = lanes.findIndex((x) => x === c.sha);
    if (laneIndex < 0) {
      // Allocate: first null slot, else append
      laneIndex = lanes.findIndex((x) => x === null);
      if (laneIndex < 0) {
        if (lanes.length >= MAX_LANES) {
          laneIndex = lanes.length - 1; // overflow: reuse last lane
        } else {
          laneIndex = lanes.length;
          lanes.push(null);
        }
      }
      lanes[laneIndex] = c.sha;
    }

    const incomingLanes = lanes.slice();

    // outgoing = incoming with this slot replaced by first parent, additional
    // parents allocated.
    const outgoing = lanes.slice();
    const parents = c.parents;
    if (parents.length === 0) {
      outgoing[laneIndex] = null;
    } else {
      outgoing[laneIndex] = parents[0];
      for (let p = 1; p < parents.length; p++) {
        const parent = parents[p];
        let target = outgoing.findIndex((x) => x === parent);
        if (target < 0) {
          target = outgoing.findIndex((x) => x === null);
          if (target < 0) {
            if (outgoing.length >= MAX_LANES) {
              continue;
            }
            target = outgoing.length;
            outgoing.push(null);
          }
          outgoing[target] = parent;
        }
      }
    }

    // Trim trailing null lanes to keep width tidy
    while (outgoing.length > 0 && outgoing[outgoing.length - 1] === null) {
      outgoing.pop();
    }

    rows.push({
      commit: c,
      laneIndex,
      incomingLanes,
      outgoingLanes: outgoing,
    });

    lanes = outgoing;
  }
  return rows;
}

function shortRef(ref: string): string {
  // refs/heads/main → main; refs/remotes/origin/main → origin/main; tag refs already cleaned
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return "tag: " + ref.slice("refs/tags/".length);
  return ref;
}

function isRefLocalBranch(ref: string): boolean {
  return ref.startsWith("refs/heads/");
}
