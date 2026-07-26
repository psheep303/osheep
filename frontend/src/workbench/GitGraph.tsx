import { type ReactNode, useEffect, useMemo, useState } from "react";
import { type GitCommit, getGitLog } from "./api";

interface GitGraphProps {
  workspaceId: string;
  /** Bumped externally to force a refetch. */
  refreshKey: number;
}

interface GraphNode {
  id: string;
  color: string;
}

interface HistoryRow {
  commit: GitCommit;
  kind: "HEAD" | "node";
  inputSwimlanes: GraphNode[];
  outputSwimlanes: GraphNode[];
}

interface ReferenceBadge {
  refName: string;
  icon: "target" | "cloud";
  color: string;
  showDescription: boolean;
}

// Ported from VS Code's SCM graph renderer:
// src/vs/workbench/contrib/scm/browser/scmHistory.ts
const SWIMLANE_HEIGHT = 22;
const SWIMLANE_WIDTH = 11;
const SWIMLANE_CURVE_RADIUS = 5;
const CIRCLE_RADIUS = 4;
const CIRCLE_STROKE_WIDTH = 2;

const HISTORY_ITEM_REF_COLOR = "#3794ff";
const HISTORY_ITEM_REMOTE_REF_COLOR = "#b180d7";
const GRAPH_COLORS = ["#ffb000", "#dc267f", "#994f00", "#40b0a6", "#b66dff"];

export function GitGraph({ workspaceId, refreshKey: _refreshKey }: GitGraphProps) {
  const [commits, setCommits] = useState<GitCommit[]>([]);
  const [head, setHead] = useState<string | null>(null);
  const [currentRef, setCurrentRef] = useState<string | null>(null);
  const [currentRemoteRef, setCurrentRemoteRef] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!workspaceId) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    void getGitLog(workspaceId, 200, 0, "HEAD")
      .then((result) => {
        if (cancelled) return;
        setCommits(result.commits);
        setHead(result.head);
        setCurrentRef(result.currentRef);
        setCurrentRemoteRef(result.currentRemoteRef);
      })
      .catch((reason) => {
        if (cancelled) return;
        setError((reason as Error).message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  const rows = useMemo(
    () => toHistoryRows(commits, head, currentRef, currentRemoteRef),
    [commits, head, currentRef, currentRemoteRef],
  );

  if (!workspaceId) return null;

  return (
    <div className="git-graph">
      {loading && <div className="git-graph__hint muted">加载提交历史…</div>}
      {error && <div className="git-graph__error">{error}</div>}
      {!loading && !error && commits.length === 0 && (
        <div className="git-graph__hint muted">没有提交</div>
      )}
      {rows.map((row) => (
        <GraphRow
          key={row.commit.sha}
          row={row}
          currentRef={currentRef}
          currentRemoteRef={currentRemoteRef}
        />
      ))}
    </div>
  );
}

function GraphRow({
  row,
  currentRef,
  currentRemoteRef,
}: {
  row: HistoryRow;
  currentRef: string | null;
  currentRemoteRef: string | null;
}) {
  const badges = getReferenceBadges(row.commit, currentRef, currentRemoteRef);
  const isHead = row.kind === "HEAD";

  return (
    <div
      className={`git-graph__row${isHead ? " is-head" : ""}`}
      title={`${row.commit.subject}\n${row.commit.shortSha} · ${row.commit.author}`}
    >
      <span className={`git-graph__graph-container${isHead ? " is-current" : ""}`}>
        <HistoryGraph row={row} />
      </span>
      <span className="git-graph__text">
        <span className="git-graph__subject" title={row.commit.subject}>
          {row.commit.subject}
        </span>
        <span className="git-graph__author">{row.commit.author}</span>
      </span>
      {badges.length > 0 && (
        <span className="git-graph__refs">
          {badges.map((badge) => (
            <RefBadge key={badge.refName} badge={badge} />
          ))}
        </span>
      )}
    </div>
  );
}

function RefBadge({ badge }: { badge: ReferenceBadge }) {
  return (
    <span
      className={`git-graph__ref${badge.showDescription ? "" : " is-icon-only"}`}
      style={{ backgroundColor: badge.color }}
      title={shortRef(badge.refName)}
    >
      <i className={`codicon codicon-${badge.icon}`} aria-hidden="true" />
      {badge.showDescription && (
        <span className="git-graph__ref-description">{shortRef(badge.refName)}</span>
      )}
    </span>
  );
}

function HistoryGraph({ row }: { row: HistoryRow }) {
  const elements: ReactNode[] = [];
  const { commit, inputSwimlanes, outputSwimlanes } = row;

  const inputIndex = inputSwimlanes.findIndex((node) => node.id === commit.sha);
  const circleIndex = inputIndex !== -1 ? inputIndex : inputSwimlanes.length;
  const circleColor =
    outputSwimlanes[circleIndex]?.color ??
    inputSwimlanes[circleIndex]?.color ??
    HISTORY_ITEM_REF_COLOR;

  let outputSwimlaneIndex = 0;
  for (let index = 0; index < inputSwimlanes.length; index++) {
    const inputNode = inputSwimlanes[index];

    if (inputNode.id === commit.sha) {
      if (index !== circleIndex) {
        const d = [
          `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
          `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${SWIMLANE_WIDTH * index} ${
            SWIMLANE_HEIGHT / 2
          }`,
          `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
        ].join(" ");
        elements.push(graphPath(`base-${index}`, d, inputNode.color));
      } else {
        outputSwimlaneIndex++;
      }
    } else if (
      outputSwimlaneIndex < outputSwimlanes.length &&
      inputNode.id === outputSwimlanes[outputSwimlaneIndex].id
    ) {
      if (index === outputSwimlaneIndex) {
        elements.push(
          graphPath(
            `vertical-${index}`,
            `M ${SWIMLANE_WIDTH * (index + 1)} 0 V ${SWIMLANE_HEIGHT}`,
            inputNode.color,
          ),
        );
      } else {
        const d = [
          `M ${SWIMLANE_WIDTH * (index + 1)} 0`,
          "V 6",
          `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 1 ${
            SWIMLANE_WIDTH * (index + 1) - SWIMLANE_CURVE_RADIUS
          } ${SWIMLANE_HEIGHT / 2}`,
          `H ${SWIMLANE_WIDTH * (outputSwimlaneIndex + 1) + SWIMLANE_CURVE_RADIUS}`,
          `A ${SWIMLANE_CURVE_RADIUS} ${SWIMLANE_CURVE_RADIUS} 0 0 0 ${
            SWIMLANE_WIDTH * (outputSwimlaneIndex + 1)
          } ${SWIMLANE_HEIGHT / 2 + SWIMLANE_CURVE_RADIUS}`,
          `V ${SWIMLANE_HEIGHT}`,
        ].join(" ");
        elements.push(graphPath(`shift-${index}`, d, inputNode.color));
      }
      outputSwimlaneIndex++;
    }
  }

  for (let index = 1; index < commit.parents.length; index++) {
    const parentOutputIndex = findLastIndex(outputSwimlanes, commit.parents[index]);
    if (parentOutputIndex === -1) continue;

    const d = [
      `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
      `A ${SWIMLANE_WIDTH} ${SWIMLANE_WIDTH} 0 0 1 ${
        SWIMLANE_WIDTH * (parentOutputIndex + 1)
      } ${SWIMLANE_HEIGHT}`,
      `M ${SWIMLANE_WIDTH * parentOutputIndex} ${SWIMLANE_HEIGHT / 2}`,
      `H ${SWIMLANE_WIDTH * (circleIndex + 1)}`,
    ].join(" ");
    elements.push(graphPath(`parent-${index}`, d, outputSwimlanes[parentOutputIndex].color));
  }

  if (inputIndex !== -1) {
    elements.push(
      graphPath(
        "to-node",
        `M ${SWIMLANE_WIDTH * (circleIndex + 1)} 0 V ${SWIMLANE_HEIGHT / 2}`,
        inputSwimlanes[inputIndex].color,
      ),
    );
  }

  if (commit.parents.length > 0) {
    elements.push(
      graphPath(
        "from-node",
        `M ${SWIMLANE_WIDTH * (circleIndex + 1)} ${SWIMLANE_HEIGHT / 2} V ${SWIMLANE_HEIGHT}`,
        circleColor,
      ),
    );
  }

  const circleX = SWIMLANE_WIDTH * (circleIndex + 1);
  if (row.kind === "HEAD") {
    elements.push(graphCircle("head-outer", circleX, CIRCLE_RADIUS + 3, 2, circleColor));
    elements.push(graphCircle("head-inner", circleX, CIRCLE_STROKE_WIDTH, CIRCLE_RADIUS));
  } else if (commit.parents.length > 1) {
    elements.push(graphCircle("merge-outer", circleX, CIRCLE_RADIUS + 2, 2, circleColor));
    elements.push(graphCircle("merge-inner", circleX, CIRCLE_RADIUS - 1, 2, circleColor));
  } else {
    elements.push(graphCircle("node", circleX, CIRCLE_RADIUS + 1, 2, circleColor));
  }

  const width = SWIMLANE_WIDTH * (Math.max(inputSwimlanes.length, outputSwimlanes.length, 1) + 1);

  return (
    <svg
      className="git-graph__svg"
      width={width}
      height={SWIMLANE_HEIGHT}
      viewBox={`0 0 ${width} ${SWIMLANE_HEIGHT}`}
      aria-hidden="true"
    >
      {elements}
    </svg>
  );
}

function graphPath(key: string, d: string, color: string, strokeWidth = 1): ReactNode {
  return (
    <path
      key={key}
      d={d}
      fill="none"
      stroke={color}
      strokeWidth={strokeWidth}
      strokeLinecap="round"
      vectorEffect="non-scaling-stroke"
    />
  );
}

function graphCircle(
  key: string,
  cx: number,
  radius: number,
  strokeWidth: number,
  color?: string,
): ReactNode {
  return (
    <circle
      key={key}
      cx={cx}
      cy={SWIMLANE_WIDTH}
      r={radius}
      fill={color}
      strokeWidth={strokeWidth}
      vectorEffect="non-scaling-stroke"
    />
  );
}

function toHistoryRows(
  commits: GitCommit[],
  head: string | null,
  currentRef: string | null,
  currentRemoteRef: string | null,
): HistoryRow[] {
  const colorMap = new Map<string, string>();
  if (currentRef) colorMap.set(currentRef, HISTORY_ITEM_REF_COLOR);
  if (currentRemoteRef) colorMap.set(currentRemoteRef, HISTORY_ITEM_REMOTE_REF_COLOR);

  let colorIndex = -1;
  const rows: HistoryRow[] = [];

  for (const commit of commits) {
    const previousRow = rows.length > 0 ? rows[rows.length - 1] : undefined;
    const inputSwimlanes = (previousRow?.outputSwimlanes ?? []).map((node) => ({
      ...node,
    }));
    const outputSwimlanes: GraphNode[] = [];
    let firstParentAdded = false;

    if (commit.parents.length > 0) {
      for (const node of inputSwimlanes) {
        if (node.id === commit.sha) {
          if (!firstParentAdded) {
            outputSwimlanes.push({
              id: commit.parents[0],
              color: getLabelColor(commit, colorMap) ?? node.color,
            });
            firstParentAdded = true;
          }
          continue;
        }
        outputSwimlanes.push({ ...node });
      }
    }

    for (let index = firstParentAdded ? 1 : 0; index < commit.parents.length; index++) {
      let color: string | undefined;
      if (index === 0) {
        color = getLabelColor(commit, colorMap);
      } else {
        const parent = commits.find((candidate) => candidate.sha === commit.parents[index]);
        color = parent ? getLabelColor(parent, colorMap) : undefined;
      }

      if (!color) {
        colorIndex = (colorIndex + 1) % GRAPH_COLORS.length;
        color = GRAPH_COLORS[colorIndex];
      }

      outputSwimlanes.push({ id: commit.parents[index], color });
    }

    rows.push({
      commit,
      kind: commit.sha === head ? "HEAD" : "node",
      inputSwimlanes,
      outputSwimlanes,
    });
  }

  return rows;
}

function getLabelColor(commit: GitCommit, colorMap: Map<string, string>): string | undefined {
  for (const ref of commit.refs) {
    const color = colorMap.get(ref);
    if (color) return color;
  }
  return undefined;
}

function getReferenceBadges(
  commit: GitCommit,
  currentRef: string | null,
  currentRemoteRef: string | null,
): ReferenceBadge[] {
  const badges: ReferenceBadge[] = [];
  if (currentRef && commit.refs.includes(currentRef)) {
    badges.push({
      refName: currentRef,
      icon: "target",
      color: HISTORY_ITEM_REF_COLOR,
      showDescription: true,
    });
  }
  if (currentRemoteRef && commit.refs.includes(currentRemoteRef)) {
    badges.push({
      refName: currentRemoteRef,
      icon: "cloud",
      color: HISTORY_ITEM_REMOTE_REF_COLOR,
      showDescription: false,
    });
  }
  return badges;
}

function findLastIndex(nodes: GraphNode[], id: string): number {
  for (let index = nodes.length - 1; index >= 0; index--) {
    if (nodes[index].id === id) return index;
  }
  return -1;
}

function shortRef(ref: string): string {
  if (ref.startsWith("refs/heads/")) return ref.slice("refs/heads/".length);
  if (ref.startsWith("refs/remotes/")) return ref.slice("refs/remotes/".length);
  if (ref.startsWith("refs/tags/")) return ref.slice("refs/tags/".length);
  return ref;
}
