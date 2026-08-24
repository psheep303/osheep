import type { GitStatus } from "./api";

export type GitPrimaryAction = "commit" | "publish" | "sync";

export function getGitPrimaryAction(
  status: GitStatus | null,
  stagedCount: number,
  unstagedCount: number,
  hasRemotes: boolean,
): GitPrimaryAction {
  const worktreeIsClean = stagedCount === 0 && unstagedCount === 0;
  if (!worktreeIsClean) return "commit";

  if (hasRemotes && status?.head && status.branch && !status.detached && !status.upstream) {
    return "publish";
  }

  if ((status?.ahead ?? 0) > 0 || (status?.behind ?? 0) > 0) {
    return "sync";
  }

  return "commit";
}
