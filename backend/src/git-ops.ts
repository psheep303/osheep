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
  ignoredPaths: string[];
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
      r.stderr.trim().slice(0, 1000) || `git ${args[0]} 失败 (exit ${r.code})`,
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

// True only when HEAD points to an existing commit. False for a freshly
// `git init`'d repo with no commits yet, or any state where `rev-parse HEAD`
// would emit "fatal: ambiguous argument 'HEAD'".
export async function hasHead(workspaceRoot: string): Promise<boolean> {
  const r = await runGit(workspaceRoot, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return r.code === 0;
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
    const r = await runGit(workspaceRoot, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
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
    return { isRepo: false, changes: [], ignoredPaths: [] };
  }

  const r = await runGit(workspaceRoot, [
    "status",
    "--porcelain=v1",
    "-z",
    "--untracked-files=all",
    "--ignored=matching",
  ]);
  if (r.code !== 0) {
    throw errors.gitFailed(r.stderr.trim() || "git status 失败");
  }

  const text = r.stdout.toString("utf-8");
  const changes: GitChange[] = [];
  const ignoredPaths: string[] = [];
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

    if (indexStatus === "!" && worktreeStatus === "!") {
      ignoredPaths.push(filePart.replace(/\/$/, ""));
      continue;
    }

    let renamedFrom: string | null = null;
    const filePath = filePart;
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

  return { ...info, changes, ignoredPaths };
}

export async function stagePaths(workspaceRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const validated = paths.map((p) =>
    path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, p)),
  );
  await runGitText(workspaceRoot, ["add", "--", ...validated]);
}

export async function unstagePaths(workspaceRoot: string, paths: string[]): Promise<void> {
  if (paths.length === 0) return;
  const validated = paths.map((p) =>
    path.relative(workspaceRoot, resolveWorkspacePath(workspaceRoot, p)),
  );
  // `git reset HEAD --` works even before the first commit fails; fall back to
  // `git rm --cached` for that case is not needed because the user has nothing
  // staged before the first commit either. We just let the error surface.
  const r = await runGit(workspaceRoot, ["reset", "HEAD", "--", ...validated]);
  if (r.code !== 0) {
    // Pre-initial-commit: use rm --cached
    const r2 = await runGit(workspaceRoot, ["rm", "--cached", "-r", "--", ...validated]);
    if (r2.code !== 0) {
      throw errors.gitFailed(r2.stderr.trim() || r.stderr.trim());
    }
  }
}

export async function discardPaths(workspaceRoot: string, paths: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const p of paths) {
    const abs = resolveWorkspacePath(workspaceRoot, p);
    const rel = path.relative(workspaceRoot, abs);
    // Check whether file is tracked
    const tracked = await runGit(workspaceRoot, ["ls-files", "--error-unmatch", "--", rel]);
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

export async function commit(workspaceRoot: string, message: string): Promise<string> {
  const msg = message.trim();
  if (!msg) throw errors.emptyCommitMessage();
  await runGitText(workspaceRoot, ["commit", "-m", message]);
  const head = (await runGitText(workspaceRoot, ["rev-parse", "HEAD"])).trim();
  return head;
}

export async function stageAllChanges(workspaceRoot: string): Promise<void> {
  await runGitText(workspaceRoot, ["add", "-A"]);
}

export async function getWorkflowDiff(workspaceRoot: string): Promise<string> {
  const repoStatus = await getStatus(workspaceRoot);
  const status = repoStatus.changes
    .map((change) => `${change.indexStatus}${change.worktreeStatus} ${change.path}`)
    .join("\n");
  const hasExistingHead = await hasHead(workspaceRoot);
  const args = hasExistingHead
    ? ["diff", "--no-ext-diff", "--binary", "HEAD"]
    : ["diff", "--no-ext-diff", "--binary", "--cached"];
  const diff = await runGitText(workspaceRoot, args);
  const unstaged = hasExistingHead
    ? ""
    : await runGitText(workspaceRoot, ["diff", "--no-ext-diff", "--binary"]);
  const untrackedDiffs: string[] = [];
  for (const change of repoStatus.changes) {
    if (change.indexStatus !== "?" || change.worktreeStatus !== "?") continue;
    const result = await runGit(workspaceRoot, [
      "diff",
      "--no-index",
      "--binary",
      "--",
      "/dev/null",
      change.path,
    ]);
    if (result.code === 0 || result.code === 1) {
      untrackedDiffs.push(result.stdout.toString("utf-8"));
    }
  }
  return [
    `# git status --short\n${status}`,
    `# git diff\n${diff}${unstaged}${untrackedDiffs.join("\n")}`,
  ]
    .filter((part) => part.trim())
    .join("\n");
}

export interface PullRequestResult {
  url: string;
  number: number | null;
}

export async function createPullRequest(
  workspaceRoot: string,
  options: { title: string; body: string; base?: string; head?: string; draft?: boolean },
): Promise<PullRequestResult> {
  const title = options.title.trim();
  if (!title) throw errors.gitFailed("Pull request title is required.");
  const args = ["pr", "create", "--title", title, "--body", options.body];
  if (options.base?.trim()) args.push("--base", options.base.trim());
  if (options.head?.trim()) args.push("--head", options.head.trim());
  if (options.draft) args.push("--draft");
  const result = await runProcess(workspaceRoot, "gh", args);
  if (result.code !== 0) {
    throw errors.gitFailed(result.stderr.trim() || "GitHub CLI failed to create the pull request.");
  }
  const url = result.stdout.toString("utf-8").trim().split(/\r?\n/).at(-1) ?? "";
  const match = url.match(/\/pull\/(\d+)(?:\/?$)/);
  return { url, number: match ? Number(match[1]) : null };
}

function runProcess(cwd: string, command: string, args: string[]): Promise<GitCmdResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" },
      windowsHide: true,
    });
    const stdoutChunks: Buffer[] = [];
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk));
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf-8");
    });
    child.on("error", (error) => {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        resolve({ stdout: Buffer.alloc(0), stderr: `${command} is not installed.`, code: -1 });
      } else {
        reject(error);
      }
    });
    child.on("close", (code) => {
      resolve({ stdout: Buffer.concat(stdoutChunks), stderr, code: code ?? -1 });
    });
  });
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
    a.name.localeCompare(b.name),
  );
}

export async function addRemote(workspaceRoot: string, name: string, url: string): Promise<void> {
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

export async function removeRemote(workspaceRoot: string, name: string): Promise<void> {
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
  currentRef: string | null;
  currentRemoteRef: string | null;
}

export interface GitCommitDetails {
  sha: string;
  shortSha: string;
  author: string;
  authorEmail: string;
  date: number;
  message: string;
  filesChanged: number;
  insertions: number;
  deletions: number;
  files: GitCommitFile[];
}

export interface GitCommitFile {
  path: string;
  status: string;
  insertions: number | null;
  deletions: number | null;
  binary: boolean;
}

export interface GitCommitDiff {
  path: string;
  base: string | null;
  head: string;
  leftContent: string;
  rightContent: string;
  leftMissing: boolean;
  rightMissing: boolean;
  binary: boolean;
}

export async function getLog(
  workspaceRoot: string,
  limit: number,
  offset: number,
  ref: string,
): Promise<GitLog> {
  const args = [
    "log",
    "--decorate=full",
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
    if (
      err.includes("does not have any commits") ||
      err.includes("bad revision") ||
      err.includes("ambiguous argument") ||
      err.includes("unknown revision")
    ) {
      return { commits: [], head: null, currentRef: null, currentRemoteRef: null };
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
    if (decoRaw?.includes("HEAD")) {
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
  let currentRef: string | null = null;
  let currentRemoteRef: string | null = null;
  try {
    head = (await runGitText(workspaceRoot, ["rev-parse", "HEAD"])).trim();
  } catch {
    head = null;
  }
  try {
    currentRef = (await runGitText(workspaceRoot, ["symbolic-ref", "-q", "HEAD"])).trim();
  } catch {
    currentRef = null;
  }
  try {
    currentRemoteRef = (
      await runGitText(workspaceRoot, ["rev-parse", "--symbolic-full-name", "@{upstream}"])
    ).trim();
  } catch {
    currentRemoteRef = null;
  }
  return { commits, head, currentRef, currentRemoteRef };
}

export async function getCommitDetails(
  workspaceRoot: string,
  sha: string,
): Promise<GitCommitDetails> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw errors.invalidRef("commit SHA 格式非法");
  const r = await runGit(workspaceRoot, [
    "-c",
    "core.quotepath=false",
    "show",
    "--no-renames",
    "--numstat",
    "--format=%H%x00%an%x00%ae%x00%at%x00%B%x1e",
    "-1",
    sha,
  ]);
  if (r.code !== 0) throw errors.gitFailed(r.stderr.trim() || "git show 失败");

  const statusResult = await runGit(workspaceRoot, [
    "-c",
    "core.quotepath=false",
    "diff-tree",
    "--root",
    "--no-commit-id",
    "--no-renames",
    "--name-status",
    "-r",
    sha,
  ]);
  if (statusResult.code !== 0) {
    throw errors.gitFailed(statusResult.stderr.trim() || "git diff-tree 失败");
  }
  const fileStatuses = new Map<string, string>();
  for (const line of statusResult.stdout.toString("utf-8").trim().split(/\r?\n/)) {
    if (!line) continue;
    const [status = "M", filePath = ""] = line.split("\t", 2);
    if (filePath) fileStatuses.set(filePath, status.slice(0, 1));
  }

  const text = r.stdout.toString("utf-8");
  const separator = text.indexOf("\x1e");
  if (separator < 0) throw errors.gitFailed("无法解析 commit 详情");
  const [fullSha = sha, author = "", authorEmail = "", at = "0", ...messageParts] = text
    .slice(0, separator)
    .split("\0");
  let filesChanged = 0;
  let insertions = 0;
  let deletions = 0;
  const files: GitCommitFile[] = [];
  for (const line of text
    .slice(separator + 1)
    .trim()
    .split(/\r?\n/)) {
    if (!line) continue;
    const [added, removed, filePath = ""] = line.split("\t", 3);
    if (!filePath) continue;
    filesChanged += 1;
    if (/^\d+$/.test(added)) insertions += Number.parseInt(added, 10);
    if (/^\d+$/.test(removed)) deletions += Number.parseInt(removed, 10);
    files.push({
      path: filePath,
      status: fileStatuses.get(filePath) ?? "M",
      insertions: /^\d+$/.test(added) ? Number.parseInt(added, 10) : null,
      deletions: /^\d+$/.test(removed) ? Number.parseInt(removed, 10) : null,
      binary: added === "-" || removed === "-",
    });
  }
  return {
    sha: fullSha,
    shortSha: fullSha.slice(0, 7),
    author,
    authorEmail,
    date: Number.parseInt(at, 10) || 0,
    message: messageParts.join("\0").trim(),
    filesChanged,
    insertions,
    deletions,
    files,
  };
}

export async function getCommitDiff(
  workspaceRoot: string,
  sha: string,
  filePath: string,
): Promise<GitCommitDiff> {
  if (!/^[0-9a-f]{7,64}$/i.test(sha)) throw errors.invalidRef("commit SHA 格式非法");
  const abs = resolveWorkspacePath(workspaceRoot, filePath);
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");

  const commitResult = await runGit(workspaceRoot, ["rev-parse", "--verify", `${sha}^{commit}`]);
  if (commitResult.code !== 0) {
    throw errors.invalidRef(commitResult.stderr.trim() || "commit 不存在");
  }
  const head = commitResult.stdout.toString("utf-8").trim();
  const parentResult = await runGit(workspaceRoot, ["rev-parse", "--verify", `${head}^`]);
  const base = parentResult.code === 0 ? parentResult.stdout.toString("utf-8").trim() : null;

  async function readCommitFile(
    ref: string | null,
  ): Promise<{ content: string; missing: boolean; binary: boolean }> {
    if (!ref) return { content: "", missing: true, binary: false };
    const result = await runGit(workspaceRoot, ["show", `${ref}:${rel}`]);
    if (result.code !== 0) {
      const message = result.stderr.toLowerCase();
      if (
        message.includes("does not exist") ||
        message.includes("exists on disk") ||
        message.includes("path '")
      ) {
        return { content: "", missing: true, binary: false };
      }
      throw errors.gitFailed(result.stderr.trim() || "git show 失败");
    }
    if (looksBinary(result.stdout)) return { content: "", missing: false, binary: true };
    return { content: result.stdout.toString("utf-8"), missing: false, binary: false };
  }

  const [left, right] = await Promise.all([readCommitFile(base), readCommitFile(head)]);
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

export async function getDiff(
  workspaceRoot: string,
  filePath: string,
  base: "HEAD" | "INDEX",
  head: "INDEX" | "WORKTREE",
): Promise<GitDiff> {
  const abs = resolveWorkspacePath(workspaceRoot, filePath);
  const rel = path.relative(workspaceRoot, abs).replace(/\\/g, "/");

  async function readRef(
    ref: "HEAD" | "INDEX" | "WORKTREE",
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
      // Repo with no commits yet → HEAD can't be resolved. Treat as missing
      // so the diff view shows the file as newly added rather than erroring.
      if (
        ref === "HEAD" &&
        (err.includes("ambiguous argument") ||
          err.includes("unknown revision") ||
          err.includes("bad revision") ||
          err.includes("does not have any commits"))
      ) {
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

// ─── Branches ───

export interface GitBranch {
  name: string;
  isCurrent: boolean;
  kind: "local" | "remote";
  upstream?: string | null;
  ahead?: number;
  behind?: number;
}

const BRANCH_NAME_RE = /^(?!-)[A-Za-z0-9._/-]{1,200}$/;

function validateBranchName(name: string): void {
  if (typeof name !== "string" || !BRANCH_NAME_RE.test(name) || name.includes("..")) {
    throw errors.invalidRef("分支名格式非法");
  }
}

export async function listBranches(
  workspaceRoot: string,
): Promise<{ current: string | null; detached: boolean; branches: GitBranch[] }> {
  const info = await getRepoInfo(workspaceRoot);
  const current = info.detached ? null : (info.branch ?? null);
  const detached = !!info.detached;

  const fmt = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)";
  const out = await runGit(workspaceRoot, [
    "for-each-ref",
    `--format=${fmt}`,
    "refs/heads",
    "refs/remotes",
  ]);
  if (out.code !== 0) {
    const err = (out.stderr || "").toLowerCase();
    if (err.includes("does not have any commits")) {
      return { current, detached, branches: [] };
    }
    throw errors.gitFailed(out.stderr.trim() || "git for-each-ref 失败");
  }

  const branches: GitBranch[] = [];
  for (const line of out.stdout.toString("utf-8").split("\n")) {
    if (!line) continue;
    const [fullref, short, upstream, track] = line.split("\0");
    if (!fullref) continue;
    const kind: "local" | "remote" = fullref.startsWith("refs/remotes/") ? "remote" : "local";
    if (kind === "remote" && short.endsWith("/HEAD")) continue;
    if (kind === "remote") {
      branches.push({ name: short, isCurrent: false, kind: "remote" });
      continue;
    }
    let ahead: number | undefined;
    let behind: number | undefined;
    if (track) {
      const a = track.match(/ahead (\d+)/);
      const b = track.match(/behind (\d+)/);
      if (a) ahead = Number.parseInt(a[1], 10);
      if (b) behind = Number.parseInt(b[1], 10);
    }
    branches.push({
      name: short,
      isCurrent: short === current,
      kind: "local",
      upstream: upstream || null,
      ahead,
      behind,
    });
  }
  branches.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === "local" ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
  return { current, detached, branches };
}

function classifyGitError(stderr: string): Error {
  const s = stderr.toLowerCase();
  if (
    s.includes("would be overwritten") ||
    s.includes("local changes") ||
    s.includes("unmerged paths")
  ) {
    return errors.dirtyWorktree(stderr.trim().slice(0, 500));
  }
  if (s.includes("already exists")) {
    return errors.branchExists(stderr.trim().slice(0, 500));
  }
  if (s.includes("no upstream") || s.includes("no tracking information")) {
    return errors.noUpstream(stderr.trim().slice(0, 500));
  }
  if (s.includes("non-fast-forward") || s.includes("non fast-forward")) {
    return errors.nonFastForward(stderr.trim().slice(0, 500));
  }
  if (
    s.includes("could not read username") ||
    s.includes("authentication failed") ||
    s.includes("permission denied") ||
    s.includes("rejected")
  ) {
    return errors.rejected(stderr.trim().slice(0, 500));
  }
  return errors.gitFailed(stderr.trim().slice(0, 1000) || "git 操作失败");
}

export async function checkoutBranch(
  workspaceRoot: string,
  ref: string,
  opts: { create?: boolean; fromRef?: string | null } = {},
): Promise<void> {
  validateBranchName(ref);
  const args: string[] = ["checkout"];
  if (opts.create) {
    args.push("-b", ref);
    if (opts.fromRef) {
      validateBranchName(opts.fromRef.replace(/^refs\/(heads|remotes)\//, ""));
      args.push(opts.fromRef);
    }
  } else {
    args.push(ref);
  }
  const r = await runGit(workspaceRoot, args);
  if (r.code !== 0) throw classifyGitError(r.stderr);
}

export async function deleteBranch(
  workspaceRoot: string,
  branch: string,
  opts: { force?: boolean; remote?: string | null } = {},
): Promise<void> {
  validateBranchName(branch);
  if (opts.remote) {
    validateRemoteName(opts.remote);
    const r = await runGit(workspaceRoot, ["push", opts.remote, "--delete", branch]);
    if (r.code !== 0) throw classifyGitError(r.stderr);
    return;
  }
  const r = await runGit(workspaceRoot, ["branch", opts.force ? "-D" : "-d", "--", branch]);
  if (r.code !== 0) throw classifyGitError(r.stderr);
}

// ─── Remote ops: fetch / pull / push ───

const REMOTE_TOKEN_RE = /^[A-Za-z0-9._-]{1,64}$/;

function validateRemoteName(name: string): void {
  if (name === "--all") return;
  if (!REMOTE_TOKEN_RE.test(name)) {
    throw errors.invalidPath("远程名称非法");
  }
}

export async function fetchRemote(
  workspaceRoot: string,
  remote: string | null,
  prune: boolean,
): Promise<void> {
  const args = ["fetch"];
  if (prune) args.push("--prune");
  if (remote) {
    validateRemoteName(remote);
    if (remote === "--all") args.push("--all");
    else args.push(remote);
  }
  const r = await runGit(workspaceRoot, args);
  if (r.code !== 0) throw classifyGitError(r.stderr);
}

export async function pullCurrent(
  workspaceRoot: string,
  opts: { remote?: string | null; branch?: string | null; ffOnly?: boolean },
): Promise<void> {
  const args = ["pull"];
  if (opts.ffOnly !== false) args.push("--ff-only");
  if (opts.remote && opts.branch) {
    validateRemoteName(opts.remote);
    validateBranchName(opts.branch);
    args.push(opts.remote, opts.branch);
  }
  const r = await runGit(workspaceRoot, args);
  if (r.code !== 0) throw classifyGitError(r.stderr);
}

export async function pushCurrent(
  workspaceRoot: string,
  opts: {
    remote?: string | null;
    branch?: string | null;
    setUpstream?: boolean;
    force?: boolean;
  },
): Promise<void> {
  const args = ["push"];
  if (opts.force) args.push("--force-with-lease");
  if (opts.setUpstream) args.push("-u");
  if (opts.remote) {
    validateRemoteName(opts.remote);
    args.push(opts.remote);
    if (opts.branch) {
      validateBranchName(opts.branch);
      args.push(opts.branch);
    }
  } else if (opts.setUpstream) {
    // -u requires explicit remote+branch.
    throw errors.invalidPath("setUpstream 需要同时提供 remote 与 branch");
  }
  const r = await runGit(workspaceRoot, args);
  if (r.code !== 0) throw classifyGitError(r.stderr);
}
