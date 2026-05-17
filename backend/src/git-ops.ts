import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { errors } from "./errors.js";
import { resolveWorkspacePath } from "./workspace.js";

export interface GitRepoInfo {
  isRepo: boolean;
  branch?: string;
  head?: string;
  ahead?: number;
  behind?: number;
  upstream?: string | null;
  detached?: boolean;
}

export interface GitChange {
  path: string;
  indexStatus: string;
  worktreeStatus: string;
  renamedFrom: string | null;
}

export interface GitStatus extends GitRepoInfo {
  changes: GitChange[];
}

export interface GitDiff {
  path: string;
  base: "HEAD" | "INDEX";
  head: "INDEX" | "WORKTREE";
  leftContent: string;
  rightContent: string;
  leftMissing: boolean;
  rightMissing: boolean;
  binary: boolean;
}

interface GitCmdResult {
  stdout: Buffer;
  stderr: string;
  code: number;
}

function runGit(cwd: string, args: string[]): Promise<GitCmdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => stdoutChunks.push(c));
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf-8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: Buffer.concat(stdoutChunks),
        stderr,
        code: code ?? -1,
      });
    });
  });
}

async function runGitText(cwd: string, args: string[]): Promise<string> {
  const r = await runGit(cwd, args);
  if (r.code !== 0) {
    throw errors.gitFailed(
      r.stderr.trim().slice(0, 1000) || `git ${args[0]} 失败 (exit ${r.code})`
    );
  }
  return r.stdout.toString("utf-8");
}

export async function isRepo(workspaceRoot: string): Promise<boolean> {
  try {
    const st = await fs.stat(path.join(workspaceRoot, ".git"));
    return st.isDirectory() || st.isFile(); // .git can be a file for worktrees
  } catch {
    return false;
  }
}

export async function getRepoInfo(workspaceRoot: string): Promise<GitRepoInfo> {
  if (!(await isRepo(workspaceRoot))) return { isRepo: false };

  let head = "";
  try {
    head = (await runGitText(workspaceRoot, ["rev-parse", "HEAD"])).trim();
  } catch {
    head = "";
  }

  let branch = "";
  let detached = false;
  try {
    const r = await runGit(workspaceRoot, [
      "symbolic-ref",
      "--quiet",
      "--short",
      "HEAD",
    ]);
    if (r.code === 0) {
      branch = r.stdout.toString("utf-8").trim();
    } else {
      detached = true;
      branch = head ? head.slice(0, 7) : "(detached)";
    }
  } catch {
    detached = true;
  }

  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  if (!detached && branch) {
    try {
      const up = await runGit(workspaceRoot, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "@{upstream}",
      ]);
      if (up.code === 0) {
        upstream = up.stdout.toString("utf-8").trim();
        const counts = await runGit(workspaceRoot, [
          "rev-list",
          "--left-right",
          "--count",
          `${upstream}...HEAD`,
        ]);
        if (counts.code === 0) {
          const [b, a] = counts.stdout
            .toString("utf-8")
            .trim()
            .split(/\s+/)
            .map((s) => Number.parseInt(s, 10) || 0);
          behind = b;
          ahead = a;
        }
      }
    } catch {
      /* ignore */
    }
  }

  return {
    isRepo: true,
    branch,
    head,
    ahead,
    behind,
    upstream,
    detached,
  };
}

export async function getStatus(workspaceRoot: string): Promise<GitStatus> {
  const info = await getRepoInfo(workspaceRoot);
  if (!info.isRepo) {
    return { isRepo: false, changes: [] };
  }

  const r = await runGit(workspaceRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
  ]);
  if (r.code !== 0) {
    throw errors.gitFailed(r.stderr.trim() || "git status 失败");
  }

  const text = r.stdout.toString("utf-8");
  const changes: GitChange[] = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\0") {
      i++;
      continue;
    }
    const indexStatus = text[i] ?? " ";
    const worktreeStatus = text[i + 1] ?? " ";
    // skip space after XY
    i += 3;
    // read path until NUL
    let j = i;
    while (j < text.length && text[j] !== "\0") j++;
    const filePart = text.slice(i, j);
    i = j + 1;

    let renamedFrom: string | null = null;
    let filePath = filePart;
    if (indexStatus === "R" || worktreeStatus === "R") {
      // For renames, porcelain -z places ORIG\0NEW; but git puts new path first
      // and old path second. We've already consumed "new", read "old".
      let k = i;
      while (k < text.length && text[k] !== "\0") k++;
      renamedFrom = text.slice(i, k);
      i = k + 1;
    }
    changes.push({
      path: filePath,
      indexStatus,
      worktreeStatus,
      renamedFrom,
    });
  }

  return { ...info, changes };
}

export async function stagePaths(
  workspaceRoot: string,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return;
  const validated = paths.map((p) =>
    path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, p))
  );
  await runGitText(workspaceRoot, ["add", "--", ...validated]);
}

export async function unstagePaths(
  workspaceRoot: string,
  paths: string[]
): Promise<void> {
  if (paths.length === 0) return;
  const validated = paths.map((p) =>
    path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, p))
  );
  // `git reset HEAD --` works even before the first commit fails; fall back to
  // `git rm --cached` for that case is not needed because the user has nothing
  // staged before the first commit either. We just let the error surface.
  const r = await runGit(workspaceRoot, ["reset", "HEAD", "--", ...validated]);
  if (r.code !== 0) {
    // Pre-initial-commit: use rm --cached
    const r2 = await runGit(workspaceRoot, [
      "rm",
      "--cached",
      "-r",
      "--",
      ...validated,
    ]);
    if (r2.code !== 0) {
      throw errors.gitFailed(r2.stderr.trim() || r.stderr.trim());
    }
  }
}

export async function discardPaths(
  workspaceRoot: string,
  paths: string[]
): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolveWorkspacePath(workspaceRoot, p);
    const rel = path.relative(workspaceRoot, abs);
    // Check whether file is tracked
    const tracked = await runGit(workspaceRoot, [
      "ls-files",
      "--error-unmatch",
      "--",
      rel,
    ]);
    if (tracked.code === 0) {
      await runGitText(workspaceRoot, ["checkout", "--", rel]);
    } else {
      try {
        const st = await fs.stat(abs);
        if (st.isDirectory()) {
          await fs.rm(abs, { recursive: true, force: false });
        } else {
          await fs.unlink(abs);
        }
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "ENOENT") {
          throw errors.ioError((e as Error).message);
        }
      }
    }
    out.push(rel.replace(/\\/g, "/"));
  }
  return out;
}

export async function commit(
  workspaceRoot: string,
  message: string
): Promise<string> {
  const msg = message.trim();
  if (!msg) throw errors.emptyCommitMessage();
  await runGitText(workspaceRoot, ["commit", "-m", message]);
  const head = (
    await runGitText(workspaceRoot, ["rev-parse", "HEAD"])
  ).trim();
  return head;
}

export async function gitInit(workspaceRoot: string): Promise<void> {
  await runGitText(workspaceRoot, ["init"]);
}

// ─── Remotes ───

export interface GitRemote {
  name: string;
  url: string;
}

const REMOTE_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

export async function listRemotes(workspaceRoot: string): Promise<GitRemote[]> {
  const text = await runGitText(workspaceRoot, ["remote", "-v"]);
  const seen = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    if (m[3] === "fetch") seen.set(m[1], m[2]);
  }
  // also pick up push-only remotes
  for (const line of text.split(/\r?\n/)) {
    if (!line) continue;
    const m = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/);
    if (!m) continue;
    if (!seen.has(m[1])) seen.set(m[1], m[2]);
  }
  return Array.from(seen, ([name, url]) => ({ name, url })).sort((a, b) =>
    a.name.localeCompare(b.name)
  );
}

export async function addRemote(
  workspaceRoot: string,
  name: string,
  url: string
): Promise<void> {
  if (!REMOTE_NAME_RE.test(name)) {
    throw errors.invalidPath("远程名称非法");
  }
  if (typeof url !== "string" || !url.trim() || url.length > 1000) {
    throw errors.invalidPath("URL 非法");
  }
  // Check duplicate up-front for a friendlier error.
  const existing = await listRemotes(workspaceRoot);
  if (existing.some((r) => r.name === name)) throw errors.entryExists();
  await runGitText(workspaceRoot, ["remote", "add", name, url]);
}

export async function removeRemote(
  workspaceRoot: string,
  name: string
): Promise<void> {
  if (!REMOTE_NAME_RE.test(name)) throw errors.invalidPath("远程名称非法");
  await runGitText(workspaceRoot, ["remote", "remove", name]);
}

// ─── Log ───

export interface GitCommit {
  sha: string;
  shortSha: string;
  parents: string[];
  author: string;
  date: number;
  subject: string;
  refs: string[];
}

export interface GitLog {
  commits: GitCommit[];
  head: string | null;
}

export async function getLog(
  workspaceRoot: string,
  limit: number,
  offset: number,
  ref: string
): Promise<GitLog> {
  const args = [
    "log",
    `--pretty=format:%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e`,
    `-n`,
    String(limit),
  ];
  if (offset > 0) args.push(`--skip=${offset}`);
  // ref may be `HEAD`, `--all`, `main`, etc. We pass it as-is at the end.
  if (ref === "--all") args.push("--all");
  else args.push(ref);

  const r = await runGit(workspaceRoot, args);
  if (r.code !== 0) {
    const err = (r.stderr || "").toLowerCase();
    if (err.includes("does not have any commits") || err.includes("bad revision")) {
      return { commits: [], head: null };
    }
    throw errors.gitFailed(r.stderr.trim() || "git log 失败");
  }
  const text = r.stdout.toString("utf-8");
  const commits: GitCommit[] = [];
  for (const rec of text.split("\x1e")) {
    if (!rec.trim()) continue;
    const cleaned = rec.replace(/^\s+/, "");
    const parts = cleaned.split("\0");
    if (parts.length < 6) continue;
    const [sha, parentsRaw, author, atStr, decoRaw, subject] = parts;
    const parents = parentsRaw ? parentsRaw.split(" ").filter(Boolean) : [];
    const refs = decoRaw
      ? decoRaw
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => s.replace(/^HEAD -> /, "").replace(/^tag:\s*/, ""))
      : [];
    if (decoRaw && decoRaw.includes("HEAD")) {
      // mark HEAD via convention: keep the literal "HEAD" entry too
      if (!refs.includes("HEAD")) refs.push("HEAD");
    }
    commits.push({
      sha,
      shortSha: sha.slice(0, 7),
      parents,
      author,
      date: Number.parseInt(atStr, 10) || 0,
      subject,
      refs,
    });
  }
  let head: string | null = null;
  try {
    head = (await runGitText(workspaceRoot, ["rev-parse", "HEAD"])).trim();
  } catch {
    head = null;
  }
  return { commits, head };
}

export async function getDiff(
  workspaceRoot: string,
  filePath: string,
  base: "HEAD" | "INDEX",
  head: "INDEX" | "WORKTREE"
): Promise<GitDiff> {
  const abs = resolveWorkspacePath(workspaceRoot, filePath);
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");

  async function readRef(
    ref: "HEAD" | "INDEX" | "WORKTREE"
  ): Promise<{ content: string; missing: boolean; binary: boolean }> {
    if (ref === "WORKTREE") {
      try {
        const buf = await fs.readFile(abs);
        if (looksBinary(buf)) return { content: "", missing: false, binary: true };
        return { content: buf.toString("utf-8"), missing: false, binary: false };
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return { content: "", missing: true, binary: false };
        }
        throw e;
      }
    }
    const target = ref === "HEAD" ? `HEAD:${rel}` : `:${rel}`;
    const r = await runGit(workspaceRoot, ["show", target]);
    if (r.code !== 0) {
      const err = r.stderr.toLowerCase();
      if (err.includes("does not exist") || err.includes("exists on disk")) {
        return { content: "", missing: true, binary: false };
      }
      throw errors.gitFailed(r.stderr.trim() || "git show 失败");
    }
    if (looksBinary(r.stdout)) {
      return { content: "", missing: false, binary: true };
    }
    return { content: r.stdout.toString("utf-8"), missing: false, binary: false };
  }

  const left = await readRef(base);
  const right = await readRef(head);
  return {
    path: rel,
    base,
    head,
    leftContent: left.content,
    rightContent: right.content,
    leftMissing: left.missing,
    rightMissing: right.missing,
    binary: left.binary || right.binary,
  };
}

function looksBinary(buf: Buffer): boolean {
  const len = Math.min(buf.length, 8 * 1024);
  for (let i = 0; i < len; i++) {
    if (buf[i] === 0) return true;
  }
  return false;
}
