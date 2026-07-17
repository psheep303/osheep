import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getStatus } from "./git-ops.js";

export interface WorkspaceChangeBaseline {
  mode: "git" | "files";
  fingerprints: Map<string, string>;
}

const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  ".venv",
  "venv",
  "dist",
  "build",
  "coverage",
  "target",
  "__pycache__",
]);
const MAX_TRACKED_FILES = 50_000;

export async function captureWorkspaceChanges(
  workspaceRoot: string
): Promise<WorkspaceChangeBaseline> {
  const status = await getStatus(workspaceRoot);
  if (status.isRepo) {
    return {
      mode: "git",
      fingerprints: await gitChangeFingerprints(workspaceRoot, status.changes),
    };
  }
  return { mode: "files", fingerprints: await fileFingerprints(workspaceRoot) };
}

export async function changedWorkspaceFiles(
  workspaceRoot: string,
  baseline: WorkspaceChangeBaseline
): Promise<string[]> {
  const current = baseline.mode === "git"
    ? await gitChangeFingerprints(workspaceRoot, (await getStatus(workspaceRoot)).changes)
    : await fileFingerprints(workspaceRoot);
  return changedFingerprintKeys(baseline.fingerprints, current);
}

export function changedFingerprintKeys(
  before: Map<string, string>,
  after: Map<string, string>
): string[] {
  const paths = new Set([...before.keys(), ...after.keys()]);
  return [...paths]
    .filter((filePath) => before.get(filePath) !== after.get(filePath))
    .sort((a, b) => a.localeCompare(b));
}

async function gitChangeFingerprints(
  workspaceRoot: string,
  changes: Array<{
    path: string;
    indexStatus: string;
    worktreeStatus: string;
    renamedFrom: string | null;
  }>
): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  for (const change of changes) {
    const filePath = change.path.replace(/\\/g, "/");
    const stat = await fileStatFingerprint(path.join(workspaceRoot, change.path));
    result.set(
      filePath,
      `${change.indexStatus}|${change.worktreeStatus}|${change.renamedFrom ?? ""}|${stat}`
    );
  }
  return result;
}

async function fileFingerprints(workspaceRoot: string): Promise<Map<string, string>> {
  const result = new Map<string, string>();
  const pending = [workspaceRoot];
  while (pending.length > 0 && result.size < MAX_TRACKED_FILES) {
    const directory = pending.pop();
    if (!directory) break;
    let entries;
    try {
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) pending.push(absolute);
        continue;
      }
      if (!entry.isFile()) continue;
      const relative = path.relative(workspaceRoot, absolute).replace(/\\/g, "/");
      result.set(relative, await fileStatFingerprint(absolute));
      if (result.size >= MAX_TRACKED_FILES) break;
    }
  }
  return result;
}

async function fileStatFingerprint(filePath: string): Promise<string> {
  try {
    const stat = await fs.stat(filePath);
    return `${stat.size}|${stat.mtimeMs}`;
  } catch {
    return "missing";
  }
}
