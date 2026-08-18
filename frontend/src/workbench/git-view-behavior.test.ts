import assert from "node:assert/strict";
import test from "node:test";
import type { GitStatus } from "./api";
import { getGitPrimaryAction } from "./git-view-behavior";

const cleanLocalBranch: GitStatus = {
  isRepo: true,
  branch: "feature/local-only",
  head: "0123456789abcdef",
  upstream: null,
  detached: false,
  ahead: 0,
  behind: 0,
  changes: [],
};

test("a clean local branch without an upstream offers publish", () => {
  assert.equal(getGitPrimaryAction(cleanLocalBranch, 0, 0, true), "publish");
});

test("a local branch without any remotes keeps the commit action", () => {
  assert.equal(getGitPrimaryAction(cleanLocalBranch, 0, 0, false), "commit");
});

test("uncommitted changes keep commit as the primary action", () => {
  assert.equal(getGitPrimaryAction(cleanLocalBranch, 0, 1, true), "commit");
});

test("an unborn or detached branch is not publishable", () => {
  assert.equal(getGitPrimaryAction({ ...cleanLocalBranch, head: undefined }, 0, 0, true), "commit");
  assert.equal(getGitPrimaryAction({ ...cleanLocalBranch, detached: true }, 0, 0, true), "commit");
});

test("a clean tracked branch with divergence offers sync", () => {
  assert.equal(
    getGitPrimaryAction({ ...cleanLocalBranch, upstream: "origin/main", ahead: 1 }, 0, 0, true),
    "sync",
  );
});
