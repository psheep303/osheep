use serde::Serialize;
use std::collections::HashMap;
use std::io;
use std::path::{Path, PathBuf};
use std::process::{ExitStatus, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use std::time::Duration;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt};
use tokio::process::Command;
use tokio::sync::{oneshot, Notify, OwnedSemaphorePermit, Semaphore};

const BINARY_SNIFF_BYTES: usize = 8 * 1024;

#[derive(Debug, Clone)]
pub struct GitServiceConfig {
    pub max_parallel_commands: usize,
    pub command_timeout: Duration,
    pub network_timeout: Duration,
    pub max_output_bytes: usize,
}

impl Default for GitServiceConfig {
    fn default() -> Self {
        Self {
            max_parallel_commands: 2,
            command_timeout: Duration::from_secs(15),
            network_timeout: Duration::from_secs(120),
            max_output_bytes: 8 * 1024 * 1024,
        }
    }
}

#[derive(Debug, Error)]
pub enum GitError {
    #[error("当前工作区不是 Git 仓库")]
    NotARepo,
    #[error("{0}")]
    InvalidPath(String),
    #[error("{0}")]
    InvalidRef(String),
    #[error("commit 消息不能为空")]
    EmptyCommitMessage,
    #[error("工作区有未提交的更改，无法切换分支: {0}")]
    DirtyWorktree(String),
    #[error("分支已存在: {0}")]
    BranchExists(String),
    #[error("同名远程已存在: {0}")]
    EntryExists(String),
    #[error("当前分支未设置 upstream: {0}")]
    NoUpstream(String),
    #[error("推送被拒绝：non-fast-forward: {0}")]
    NonFastForward(String),
    #[error("远端拒绝: {0}")]
    Rejected(String),
    #[error("Git 命令失败: {0}")]
    CommandFailed(String),
    #[error("Git 命令执行超时")]
    Timeout,
    #[error("Git 命令输出超过限制")]
    OutputTooLarge,
    #[error("Git 命令已取消")]
    Cancelled,
    #[error("Git I/O 失败: {0}")]
    Io(#[from] io::Error),
    #[error("Git 后台任务失败: {0}")]
    Join(String),
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitRepoInfo {
    pub is_repo: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub branch: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub detached: Option<bool>,
}

impl GitRepoInfo {
    fn not_repo() -> Self {
        Self {
            is_repo: false,
            branch: None,
            head: None,
            ahead: None,
            behind: None,
            upstream: None,
            detached: None,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitChange {
    pub path: String,
    pub index_status: String,
    pub worktree_status: String,
    pub renamed_from: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitStatus {
    #[serde(flatten)]
    pub repo: GitRepoInfo,
    pub changes: Vec<GitChange>,
    pub ignored_paths: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitDiff {
    pub path: String,
    pub base: String,
    pub head: String,
    pub left_content: String,
    pub right_content: String,
    pub left_missing: bool,
    pub right_missing: bool,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitRemote {
    pub name: String,
    pub url: String,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GitBranchKind {
    Local,
    Remote,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitBranch {
    pub name: String,
    pub is_current: bool,
    pub kind: GitBranchKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub upstream: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ahead: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub behind: Option<u64>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
pub struct GitBranches {
    pub current: Option<String>,
    pub detached: bool,
    pub branches: Vec<GitBranch>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommit {
    pub sha: String,
    pub short_sha: String,
    pub parents: Vec<String>,
    pub author: String,
    pub date: i64,
    pub subject: String,
    pub refs: Vec<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitLog {
    pub commits: Vec<GitCommit>,
    pub head: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_ref: Option<Option<String>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub current_remote_ref: Option<Option<String>>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitFile {
    pub path: String,
    pub status: String,
    pub insertions: Option<u64>,
    pub deletions: Option<u64>,
    pub binary: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDetails {
    pub sha: String,
    pub short_sha: String,
    pub author: String,
    pub author_email: String,
    pub date: i64,
    pub message: String,
    pub files_changed: usize,
    pub insertions: u64,
    pub deletions: u64,
    pub files: Vec<GitCommitFile>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct GitCommitDiff {
    pub path: String,
    pub base: Option<String>,
    pub head: String,
    pub left_content: String,
    pub right_content: String,
    pub left_missing: bool,
    pub right_missing: bool,
    pub binary: bool,
}

#[derive(Debug)]
struct GitCommandOutput {
    status: ExitStatus,
    stdout: Vec<u8>,
    stderr: Vec<u8>,
}

#[derive(Debug)]
struct RefContent {
    content: String,
    missing: bool,
    binary: bool,
}

#[derive(Debug, Clone)]
pub struct GitService {
    config: GitServiceConfig,
    commands: Arc<Semaphore>,
}

impl GitService {
    pub fn new(config: GitServiceConfig) -> Self {
        let commands = config.max_parallel_commands.max(1);
        Self {
            config,
            commands: Arc::new(Semaphore::new(commands)),
        }
    }

    pub async fn ensure_repo(&self, workspace_root: &Path) -> Result<(), GitError> {
        if is_repo(workspace_root).await {
            Ok(())
        } else {
            Err(GitError::NotARepo)
        }
    }

    pub async fn init(&self, workspace_root: &Path) -> Result<(), GitError> {
        let output = self.run(workspace_root, &["init"]).await?;
        if output.success() {
            Ok(())
        } else {
            Err(command_failed(&output, "git init 失败"))
        }
    }

    pub async fn stage(&self, workspace_root: &Path, paths: &[String]) -> Result<(), GitError> {
        self.ensure_repo(workspace_root).await?;
        let paths = normalize_paths(workspace_root, paths).await?;
        if paths.is_empty() {
            return Ok(());
        }
        let mut args = vec!["add".to_owned(), "--".to_owned()];
        args.extend(paths);
        let output = self.run_owned(workspace_root, args).await?;
        if output.success() {
            Ok(())
        } else {
            Err(command_failed(&output, "git add 失败"))
        }
    }

    pub async fn unstage(&self, workspace_root: &Path, paths: &[String]) -> Result<(), GitError> {
        self.ensure_repo(workspace_root).await?;
        let paths = normalize_paths(workspace_root, paths).await?;
        if paths.is_empty() {
            return Ok(());
        }
        let mut args = vec!["reset".to_owned(), "HEAD".to_owned(), "--".to_owned()];
        args.extend(paths.clone());
        let output = self.run_owned(workspace_root, args).await?;
        if output.success() {
            return Ok(());
        }
        let mut fallback = vec![
            "rm".to_owned(),
            "--cached".to_owned(),
            "-r".to_owned(),
            "--".to_owned(),
        ];
        fallback.extend(paths);
        let fallback_output = self.run_owned(workspace_root, fallback).await?;
        if fallback_output.success() {
            Ok(())
        } else {
            Err(command_failed(&fallback_output, "git unstage 失败"))
        }
    }

    pub async fn discard(
        &self,
        workspace_root: &Path,
        paths: &[String],
    ) -> Result<Vec<String>, GitError> {
        self.ensure_repo(workspace_root).await?;
        let paths = normalize_paths(workspace_root, paths).await?;
        let mut discarded = Vec::new();
        for relative in paths {
            let tracked = self
                .run_owned(
                    workspace_root,
                    vec![
                        "ls-files".to_owned(),
                        "--error-unmatch".to_owned(),
                        "--".to_owned(),
                        relative.clone(),
                    ],
                )
                .await?;
            if tracked.success() {
                let output = self
                    .run_owned(
                        workspace_root,
                        vec!["checkout".to_owned(), "--".to_owned(), relative.clone()],
                    )
                    .await?;
                if !output.success() {
                    return Err(command_failed(&output, "git checkout 失败"));
                }
            } else {
                remove_workspace_entry(workspace_root, &relative).await?;
            }
            discarded.push(relative);
        }
        Ok(discarded)
    }

    pub async fn commit(&self, workspace_root: &Path, message: &str) -> Result<String, GitError> {
        self.ensure_repo(workspace_root).await?;
        if message.trim().is_empty() {
            return Err(GitError::EmptyCommitMessage);
        }
        let output = self
            .run_owned(
                workspace_root,
                vec!["commit".to_owned(), "-m".to_owned(), message.to_owned()],
            )
            .await?;
        if !output.success() {
            return Err(command_failed(&output, "git commit 失败"));
        }
        let head = self.run(workspace_root, &["rev-parse", "HEAD"]).await?;
        if !head.success() {
            return Err(command_failed(&head, "读取 commit HEAD 失败"));
        }
        Ok(head.stdout_text().trim().to_owned())
    }

    pub async fn add_remote(
        &self,
        workspace_root: &Path,
        name: &str,
        url: &str,
    ) -> Result<(), GitError> {
        self.ensure_repo(workspace_root).await?;
        validate_remote_name(name, false)?;
        if url.trim().is_empty() || url.len() > 1000 {
            return Err(GitError::InvalidPath("URL 非法".into()));
        }
        let existing = self.remotes(workspace_root).await?;
        if existing.iter().any(|remote| remote.name == name) {
            return Err(GitError::EntryExists(name.to_owned()));
        }
        let output = self
            .run_owned(
                workspace_root,
                vec![
                    "remote".to_owned(),
                    "add".to_owned(),
                    name.to_owned(),
                    url.to_owned(),
                ],
            )
            .await?;
        if output.success() {
            Ok(())
        } else {
            Err(command_failed(&output, "git remote add 失败"))
        }
    }

    pub async fn remove_remote(&self, workspace_root: &Path, name: &str) -> Result<(), GitError> {
        self.ensure_repo(workspace_root).await?;
        validate_remote_name(name, false)?;
        let output = self
            .run_owned(
                workspace_root,
                vec!["remote".to_owned(), "remove".to_owned(), name.to_owned()],
            )
            .await?;
        if output.success() {
            Ok(())
        } else {
            Err(command_failed(&output, "git remote remove 失败"))
        }
    }

    pub async fn checkout(
        &self,
        workspace_root: &Path,
        reference: &str,
        create: bool,
        from_ref: Option<&str>,
    ) -> Result<(), GitError> {
        self.ensure_repo(workspace_root).await?;
        validate_branch_name(reference)?;
        let mut args = vec!["checkout".to_owned()];
        if create {
            args.push("-b".to_owned());
            args.push(reference.to_owned());
            if let Some(from_ref) = from_ref {
                validate_branch_name(
                    &from_ref
                        .replace("refs/heads/", "")
                        .replace("refs/remotes/", ""),
                )?;
                args.push(from_ref.to_owned());
            }
        } else {
            args.push(reference.to_owned());
        }
        let output = self.run_owned(workspace_root, args).await?;
        if output.success() {
            Ok(())
        } else {
            Err(command_failed(&output, "git checkout 失败"))
        }
    }

    pub async fn fetch(
        &self,
        workspace_root: &Path,
        remote: Option<&str>,
        prune: bool,
    ) -> Result<(), GitError> {
        self.ensure_repo(workspace_root).await?;
        let mut args = vec!["fetch".to_owned()];
        if prune {
            args.push("--prune".to_owned());
        }
        if let Some(remote) = remote {
            validate_remote_name(remote, true)?;
            args.push(remote.to_owned());
        }
        let output = self
            .run_owned_timeout(workspace_root, args, self.config.network_timeout)
            .await?;
        if output.success() {
            Ok(())
        } else {
            Err(command_failed(&output, "git fetch 失败"))
        }
    }

    pub async fn pull(
        &self,
        workspace_root: &Path,
        remote: Option<&str>,
        branch: Option<&str>,
        ff_only: bool,
    ) -> Result<(), GitError> {
        self.ensure_repo(workspace_root).await?;
        let mut args = vec!["pull".to_owned()];
        if ff_only {
            args.push("--ff-only".to_owned());
        }
        if let (Some(remote), Some(branch)) = (remote, branch) {
            validate_remote_name(remote, false)?;
            validate_branch_name(branch)?;
            args.push(remote.to_owned());
            args.push(branch.to_owned());
        }
        let output = self
            .run_owned_timeout(workspace_root, args, self.config.network_timeout)
            .await?;
        if output.success() {
            Ok(())
        } else {
            Err(command_failed(&output, "git pull 失败"))
        }
    }

    pub async fn push(
        &self,
        workspace_root: &Path,
        remote: Option<&str>,
        branch: Option<&str>,
        set_upstream: bool,
        force: bool,
    ) -> Result<(), GitError> {
        self.ensure_repo(workspace_root).await?;
        if set_upstream && (remote.is_none() || branch.is_none()) {
            return Err(GitError::InvalidPath(
                "setUpstream 需要同时提供 remote 与 branch".into(),
            ));
        }
        let mut args = vec!["push".to_owned()];
        if force {
            args.push("--force-with-lease".to_owned());
        }
        if set_upstream {
            args.push("-u".to_owned());
        }
        if let Some(remote) = remote {
            validate_remote_name(remote, false)?;
            args.push(remote.to_owned());
            if let Some(branch) = branch {
                validate_branch_name(branch)?;
                args.push(branch.to_owned());
            }
        }
        let output = self
            .run_owned_timeout(workspace_root, args, self.config.network_timeout)
            .await?;
        if output.success() {
            Ok(())
        } else {
            Err(command_failed(&output, "git push 失败"))
        }
    }

    pub async fn repo_info(&self, workspace_root: &Path) -> Result<GitRepoInfo, GitError> {
        if !is_repo(workspace_root).await {
            return Ok(GitRepoInfo::not_repo());
        }

        let head = self
            .run(workspace_root, &["rev-parse", "HEAD"])
            .await
            .ok()
            .filter(GitCommandOutput::success)
            .map(|output| output.stdout_text().trim().to_owned())
            .unwrap_or_default();

        let symbolic = self
            .run(
                workspace_root,
                &["symbolic-ref", "--quiet", "--short", "HEAD"],
            )
            .await;
        let (branch, detached) = match symbolic {
            Ok(output) if output.success() => (output.stdout_text().trim().to_owned(), false),
            _ => (
                if head.is_empty() {
                    "(detached)".to_owned()
                } else {
                    head.chars().take(7).collect()
                },
                true,
            ),
        };

        let mut upstream = None;
        let mut ahead = 0;
        let mut behind = 0;
        if !detached && !branch.is_empty() {
            if let Ok(output) = self
                .run(
                    workspace_root,
                    &[
                        "rev-parse",
                        "--abbrev-ref",
                        "--symbolic-full-name",
                        "@{upstream}",
                    ],
                )
                .await
            {
                if output.success() {
                    let value = output.stdout_text().trim().to_owned();
                    if !value.is_empty() {
                        if let Ok(counts) = self
                            .run(
                                workspace_root,
                                &[
                                    "rev-list",
                                    "--left-right",
                                    "--count",
                                    &format!("{value}...HEAD"),
                                ],
                            )
                            .await
                        {
                            if counts.success() {
                                let counts_text = counts.stdout_text();
                                let mut fields = counts_text.split_whitespace();
                                behind = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                                ahead = fields.next().and_then(|v| v.parse().ok()).unwrap_or(0);
                            }
                        }
                        upstream = Some(value);
                    }
                }
            }
        }

        Ok(GitRepoInfo {
            is_repo: true,
            branch: Some(branch),
            head: Some(head),
            ahead: Some(ahead),
            behind: Some(behind),
            upstream: Some(upstream),
            detached: Some(detached),
        })
    }

    pub async fn status(&self, workspace_root: &Path) -> Result<GitStatus, GitError> {
        let repo = self.repo_info(workspace_root).await?;
        if !repo.is_repo {
            return Ok(GitStatus {
                repo,
                changes: Vec::new(),
                ignored_paths: Vec::new(),
            });
        }
        let output = self
            .run(
                workspace_root,
                &[
                    "status",
                    "--porcelain=v1",
                    "-z",
                    "--untracked-files=all",
                    "--ignored=matching",
                ],
            )
            .await?;
        if !output.success() {
            return Err(command_failed(&output, "git status 失败"));
        }
        let (changes, ignored_paths) = parse_status(&output.stdout);
        Ok(GitStatus {
            repo,
            changes,
            ignored_paths,
        })
    }

    pub async fn remotes(&self, workspace_root: &Path) -> Result<Vec<GitRemote>, GitError> {
        if !is_repo(workspace_root).await {
            return Err(GitError::NotARepo);
        }
        let output = self.run(workspace_root, &["remote", "-v"]).await?;
        if !output.success() {
            return Err(command_failed(&output, "git remote 失败"));
        }
        Ok(parse_remotes(&output.stdout_text()))
    }

    pub async fn branches(&self, workspace_root: &Path) -> Result<GitBranches, GitError> {
        if !is_repo(workspace_root).await {
            return Err(GitError::NotARepo);
        }
        let info = self.repo_info(workspace_root).await?;
        let detached = info.detached.unwrap_or(false);
        let current = if detached { None } else { info.branch };
        let format = "%(refname)%00%(refname:short)%00%(upstream:short)%00%(upstream:track)";
        let output = self
            .run(
                workspace_root,
                &[
                    "for-each-ref",
                    &format!("--format={format}"),
                    "refs/heads",
                    "refs/remotes",
                ],
            )
            .await?;
        if !output.success() {
            if output
                .stderr_text()
                .to_lowercase()
                .contains("does not have any commits")
            {
                return Ok(GitBranches {
                    current,
                    detached,
                    branches: Vec::new(),
                });
            }
            return Err(command_failed(&output, "git for-each-ref 失败"));
        }
        Ok(GitBranches {
            branches: parse_branches(&output.stdout_text(), current.as_deref()),
            current,
            detached,
        })
    }

    pub async fn log(
        &self,
        workspace_root: &Path,
        limit: usize,
        offset: usize,
        reference: &str,
    ) -> Result<GitLog, GitError> {
        if !is_repo(workspace_root).await {
            return Ok(GitLog {
                commits: Vec::new(),
                head: None,
                current_ref: None,
                current_remote_ref: None,
            });
        }
        if reference.starts_with('-') && reference != "--all" {
            return Err(GitError::InvalidRef("ref 取值不合法".into()));
        }
        let mut args = vec![
            "log".to_owned(),
            "--decorate=full".to_owned(),
            "--pretty=format:%H%x00%P%x00%an%x00%at%x00%D%x00%s%x1e".to_owned(),
            "-n".to_owned(),
            limit.to_string(),
        ];
        if offset > 0 {
            args.push(format!("--skip={offset}"));
        }
        if reference == "--all" {
            args.push("--all".to_owned());
        } else {
            args.push("--end-of-options".to_owned());
            args.push(reference.to_owned());
        }
        let output = self.run_owned(workspace_root, args).await?;
        if !output.success() {
            let stderr = output.stderr_text().to_lowercase();
            if [
                "does not have any commits",
                "bad revision",
                "ambiguous argument",
                "unknown revision",
            ]
            .iter()
            .any(|message| stderr.contains(message))
            {
                return Ok(GitLog {
                    commits: Vec::new(),
                    head: None,
                    current_ref: Some(None),
                    current_remote_ref: Some(None),
                });
            }
            return Err(command_failed(&output, "git log 失败"));
        }
        let commits = parse_log(&output.stdout_text());
        let head = self
            .successful_text(workspace_root, &["rev-parse", "HEAD"])
            .await;
        let current_ref = self
            .successful_text(workspace_root, &["symbolic-ref", "-q", "HEAD"])
            .await;
        let current_remote_ref = self
            .successful_text(
                workspace_root,
                &["rev-parse", "--symbolic-full-name", "@{upstream}"],
            )
            .await;
        Ok(GitLog {
            commits,
            head,
            current_ref: Some(current_ref),
            current_remote_ref: Some(current_remote_ref),
        })
    }

    pub async fn commit_details(
        &self,
        workspace_root: &Path,
        sha: &str,
    ) -> Result<GitCommitDetails, GitError> {
        if !is_repo(workspace_root).await {
            return Err(GitError::NotARepo);
        }
        validate_commit_sha(sha)?;
        let output = self
            .run(
                workspace_root,
                &[
                    "-c",
                    "core.quotepath=false",
                    "show",
                    "--no-renames",
                    "--numstat",
                    "--format=%H%x00%an%x00%ae%x00%at%x00%B%x1e",
                    "-1",
                    sha,
                ],
            )
            .await?;
        if !output.success() {
            return Err(command_failed(&output, "git show 失败"));
        }
        let statuses = self
            .run(
                workspace_root,
                &[
                    "-c",
                    "core.quotepath=false",
                    "diff-tree",
                    "--root",
                    "--no-commit-id",
                    "--no-renames",
                    "--name-status",
                    "-r",
                    sha,
                ],
            )
            .await?;
        if !statuses.success() {
            return Err(command_failed(&statuses, "git diff-tree 失败"));
        }
        parse_commit_details(sha, &output.stdout_text(), &statuses.stdout_text())
    }

    pub async fn commit_diff(
        &self,
        workspace_root: &Path,
        sha: &str,
        file_path: &str,
    ) -> Result<GitCommitDiff, GitError> {
        if !is_repo(workspace_root).await {
            return Err(GitError::NotARepo);
        }
        validate_commit_sha(sha)?;
        let relative = normalize_relative(file_path)?;
        let commit = self
            .run(
                workspace_root,
                &["rev-parse", "--verify", &format!("{sha}^{{commit}}")],
            )
            .await?;
        if !commit.success() {
            let message = commit.stderr_text();
            return Err(GitError::InvalidRef(if message.trim().is_empty() {
                "commit 不存在".into()
            } else {
                message.trim().chars().take(1000).collect()
            }));
        }
        let head = commit.stdout_text().trim().to_owned();
        let parent = self
            .run(
                workspace_root,
                &["rev-parse", "--verify", &format!("{head}^")],
            )
            .await?;
        let base = parent
            .success()
            .then(|| parent.stdout_text().trim().to_owned());
        let (left, right) = tokio::try_join!(
            self.read_commit_ref(workspace_root, base.as_deref(), &relative),
            self.read_commit_ref(workspace_root, Some(&head), &relative)
        )?;
        Ok(GitCommitDiff {
            path: relative,
            base,
            head,
            left_content: left.content,
            right_content: right.content,
            left_missing: left.missing,
            right_missing: right.missing,
            binary: left.binary || right.binary,
        })
    }

    pub async fn diff(
        &self,
        workspace_root: &Path,
        file_path: &str,
        base: &str,
        head: &str,
    ) -> Result<GitDiff, GitError> {
        if !is_repo(workspace_root).await {
            return Err(GitError::NotARepo);
        }
        let relative = normalize_relative(file_path)?;
        let left = self.read_ref(workspace_root, &relative, base).await?;
        let right = self.read_ref(workspace_root, &relative, head).await?;
        Ok(GitDiff {
            path: relative,
            base: base.to_owned(),
            head: head.to_owned(),
            left_content: left.content,
            right_content: right.content,
            left_missing: left.missing,
            right_missing: right.missing,
            binary: left.binary || right.binary,
        })
    }

    async fn read_ref(
        &self,
        workspace_root: &Path,
        relative: &str,
        reference: &str,
    ) -> Result<RefContent, GitError> {
        if reference == "WORKTREE" {
            return read_worktree(workspace_root, relative, self.config.max_output_bytes).await;
        }
        let target = if reference == "HEAD" {
            format!("HEAD:{relative}")
        } else {
            format!(":{relative}")
        };
        let output = self.run(workspace_root, &["show", &target]).await?;
        if !output.success() {
            let stderr = output.stderr_text();
            let lower = stderr.to_lowercase();
            let missing = lower.contains("does not exist")
                || lower.contains("exists on disk")
                || (reference == "HEAD"
                    && (lower.contains("ambiguous argument")
                        || lower.contains("unknown revision")
                        || lower.contains("bad revision")
                        || lower.contains("does not have any commits")));
            if missing {
                return Ok(RefContent {
                    content: String::new(),
                    missing: true,
                    binary: false,
                });
            }
            return Err(command_failed(&output, "git show 失败"));
        }
        Ok(ref_content(output.stdout))
    }

    async fn read_commit_ref(
        &self,
        workspace_root: &Path,
        reference: Option<&str>,
        relative: &str,
    ) -> Result<RefContent, GitError> {
        let Some(reference) = reference else {
            return Ok(RefContent {
                content: String::new(),
                missing: true,
                binary: false,
            });
        };
        let output = self
            .run(
                workspace_root,
                &["show", &format!("{reference}:{relative}")],
            )
            .await?;
        if !output.success() {
            let stderr = output.stderr_text().to_lowercase();
            if stderr.contains("does not exist")
                || stderr.contains("exists on disk")
                || stderr.contains("path '")
            {
                return Ok(RefContent {
                    content: String::new(),
                    missing: true,
                    binary: false,
                });
            }
            return Err(command_failed(&output, "git show 失败"));
        }
        Ok(ref_content(output.stdout))
    }

    async fn successful_text(&self, cwd: &Path, args: &[&str]) -> Option<String> {
        self.run(cwd, args)
            .await
            .ok()
            .filter(GitCommandOutput::success)
            .map(|output| output.stdout_text().trim().to_owned())
    }

    async fn run(&self, cwd: &Path, args: &[&str]) -> Result<GitCommandOutput, GitError> {
        self.run_owned(cwd, args.iter().map(|value| (*value).to_owned()).collect())
            .await
    }

    async fn run_owned(&self, cwd: &Path, args: Vec<String>) -> Result<GitCommandOutput, GitError> {
        self.run_owned_timeout(cwd, args, self.config.command_timeout)
            .await
    }

    async fn run_owned_timeout(
        &self,
        cwd: &Path,
        args: Vec<String>,
        timeout: Duration,
    ) -> Result<GitCommandOutput, GitError> {
        let permit = self
            .commands
            .clone()
            .acquire_owned()
            .await
            .map_err(|error| GitError::Join(error.to_string()))?;
        let cwd = cwd.to_owned();
        let cancel = Arc::new(Notify::new());
        let mut guard = CancellationGuard::new(cancel.clone());
        let (sender, receiver) = oneshot::channel();
        let output_limit = self.config.max_output_bytes;
        tokio::spawn(async move {
            let result = run_process(
                "git".to_owned(),
                cwd,
                args,
                timeout,
                output_limit,
                cancel,
                permit,
            )
            .await;
            let _ = sender.send(result);
        });
        let result = receiver
            .await
            .map_err(|error| GitError::Join(error.to_string()))?;
        guard.disarm();
        result
    }

    #[cfg(test)]
    fn available_permits(&self) -> usize {
        self.commands.available_permits()
    }
}

impl GitCommandOutput {
    fn success(&self) -> bool {
        self.status.success()
    }

    fn stdout_text(&self) -> String {
        String::from_utf8_lossy(&self.stdout).into_owned()
    }

    fn stderr_text(&self) -> String {
        String::from_utf8_lossy(&self.stderr).into_owned()
    }
}

struct CancellationGuard {
    cancel: Arc<Notify>,
    armed: bool,
}

impl CancellationGuard {
    fn new(cancel: Arc<Notify>) -> Self {
        Self {
            cancel,
            armed: true,
        }
    }

    fn disarm(&mut self) {
        self.armed = false;
    }
}

impl Drop for CancellationGuard {
    fn drop(&mut self) {
        if self.armed {
            self.cancel.notify_one();
        }
    }
}

enum ProcessOutcome {
    Exited(Result<ExitStatus, io::Error>),
    Cancelled,
    TimedOut,
    OutputTooLarge,
}

async fn run_process(
    program: String,
    cwd: PathBuf,
    args: Vec<String>,
    timeout: Duration,
    output_limit: usize,
    cancel: Arc<Notify>,
    _permit: OwnedSemaphorePermit,
) -> Result<GitCommandOutput, GitError> {
    let mut child = Command::new(program)
        .args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true)
        .spawn()?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| io::Error::other("git stdout pipe unavailable"))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| io::Error::other("git stderr pipe unavailable"))?;
    let limit_hit = Arc::new(Notify::new());
    let output_size = Arc::new(AtomicUsize::new(0));
    let stdout_task = tokio::spawn(read_limited(
        stdout,
        output_limit,
        output_size.clone(),
        limit_hit.clone(),
    ));
    let stderr_task = tokio::spawn(read_limited(
        stderr,
        output_limit,
        output_size,
        limit_hit.clone(),
    ));

    let outcome = tokio::select! {
        status = child.wait() => ProcessOutcome::Exited(status),
        _ = cancel.notified() => ProcessOutcome::Cancelled,
        _ = tokio::time::sleep(timeout) => ProcessOutcome::TimedOut,
        _ = limit_hit.notified() => ProcessOutcome::OutputTooLarge,
    };
    let status = match outcome {
        ProcessOutcome::Exited(status) => status?,
        ProcessOutcome::Cancelled => {
            terminate(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(GitError::Cancelled);
        }
        ProcessOutcome::TimedOut => {
            terminate(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(GitError::Timeout);
        }
        ProcessOutcome::OutputTooLarge => {
            terminate(&mut child).await;
            stdout_task.abort();
            stderr_task.abort();
            return Err(GitError::OutputTooLarge);
        }
    };
    let stdout = stdout_task
        .await
        .map_err(|error| GitError::Join(error.to_string()))??;
    let stderr = stderr_task
        .await
        .map_err(|error| GitError::Join(error.to_string()))??;
    if stdout.exceeded || stderr.exceeded {
        return Err(GitError::OutputTooLarge);
    }
    Ok(GitCommandOutput {
        status,
        stdout: stdout.bytes,
        stderr: stderr.bytes,
    })
}

async fn terminate(child: &mut tokio::process::Child) {
    let _ = child.start_kill();
    let _ = child.wait().await;
}

struct LimitedRead {
    bytes: Vec<u8>,
    exceeded: bool,
}

async fn read_limited(
    mut reader: impl AsyncRead + Unpin,
    limit: usize,
    output_size: Arc<AtomicUsize>,
    limit_hit: Arc<Notify>,
) -> Result<LimitedRead, io::Error> {
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    let mut buffer = [0_u8; 16 * 1024];
    let mut exceeded = false;
    loop {
        let read = reader.read(&mut buffer).await?;
        if read == 0 {
            break;
        }
        let previous = output_size.fetch_add(read, Ordering::Relaxed);
        let remaining = limit.saturating_sub(previous);
        bytes.extend_from_slice(&buffer[..read.min(remaining)]);
        if previous.saturating_add(read) > limit && !exceeded {
            exceeded = true;
            limit_hit.notify_one();
        }
    }
    Ok(LimitedRead { bytes, exceeded })
}

async fn is_repo(workspace_root: &Path) -> bool {
    tokio::fs::metadata(workspace_root.join(".git"))
        .await
        .is_ok_and(|metadata| metadata.is_dir() || metadata.is_file())
}

async fn read_worktree(
    workspace_root: &Path,
    relative: &str,
    limit: usize,
) -> Result<RefContent, GitError> {
    let root = tokio::fs::canonicalize(workspace_root).await?;
    let candidate = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    let path = match tokio::fs::canonicalize(&candidate).await {
        Ok(path) => path,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            return Ok(RefContent {
                content: String::new(),
                missing: true,
                binary: false,
            });
        }
        Err(error) => return Err(error.into()),
    };
    if !path.starts_with(&root) {
        return Err(GitError::InvalidPath("文件路径越出工作区根目录".into()));
    }
    let file = tokio::fs::File::open(path).await?;
    let mut bytes = Vec::with_capacity(limit.min(64 * 1024));
    file.take(limit.saturating_add(1) as u64)
        .read_to_end(&mut bytes)
        .await?;
    if bytes.len() > limit {
        return Err(GitError::OutputTooLarge);
    }
    Ok(ref_content(bytes))
}

fn ref_content(bytes: Vec<u8>) -> RefContent {
    let binary = bytes.iter().take(BINARY_SNIFF_BYTES).any(|byte| *byte == 0);
    RefContent {
        content: if binary {
            String::new()
        } else {
            String::from_utf8_lossy(&bytes).into_owned()
        },
        missing: false,
        binary,
    }
}

fn normalize_relative(relative: &str) -> Result<String, GitError> {
    if relative.contains('\0') {
        return Err(GitError::InvalidPath("路径包含 NUL".into()));
    }
    let unified = relative.replace('\\', "/");
    let unified = unified.trim();
    if unified.starts_with('/')
        || (unified.len() >= 2
            && unified.as_bytes()[0].is_ascii_alphabetic()
            && unified.as_bytes()[1] == b':')
    {
        return Err(GitError::InvalidPath("不允许绝对路径".into()));
    }
    let mut segments = Vec::new();
    for segment in unified.split('/').filter(|segment| !segment.is_empty()) {
        match segment {
            "." => {}
            ".." => return Err(GitError::InvalidPath("文件路径越出工作区根目录".into())),
            value => segments.push(value),
        }
    }
    Ok(segments.join("/"))
}

async fn normalize_paths(workspace_root: &Path, paths: &[String]) -> Result<Vec<String>, GitError> {
    let mut normalized = Vec::with_capacity(paths.len());
    for path in paths {
        let relative = normalize_relative(path)?;
        if relative.is_empty() {
            return Err(GitError::InvalidPath("不允许操作工作区根目录".into()));
        }
        let _ = workspace_candidate(workspace_root, &relative).await?;
        normalized.push(relative);
    }
    Ok(normalized)
}

async fn workspace_candidate(workspace_root: &Path, relative: &str) -> Result<PathBuf, GitError> {
    let root = tokio::fs::canonicalize(workspace_root).await?;
    let candidate = root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
    if let Ok(canonical) = tokio::fs::canonicalize(&candidate).await {
        if !canonical.starts_with(&root) {
            return Err(GitError::InvalidPath("文件路径越出工作区根目录".into()));
        }
    } else if !candidate.starts_with(&root) {
        return Err(GitError::InvalidPath("文件路径越出工作区根目录".into()));
    }
    Ok(candidate)
}

async fn remove_workspace_entry(workspace_root: &Path, relative: &str) -> Result<(), GitError> {
    let candidate = workspace_candidate(workspace_root, relative).await?;
    match tokio::fs::symlink_metadata(&candidate).await {
        Ok(metadata) if metadata.is_dir() => tokio::fs::remove_dir_all(candidate).await?,
        Ok(_) => tokio::fs::remove_file(candidate).await?,
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn validate_remote_name(name: &str, allow_all: bool) -> Result<(), GitError> {
    if (allow_all && name == "--all")
        || (name.len() <= 64
            && !name.is_empty()
            && !name.starts_with('-')
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')))
    {
        Ok(())
    } else {
        Err(GitError::InvalidPath("远程名称非法".into()))
    }
}

fn validate_branch_name(name: &str) -> Result<(), GitError> {
    if !name.is_empty()
        && name.len() <= 200
        && !name.starts_with('-')
        && !name.contains("..")
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'/' | b'-'))
    {
        Ok(())
    } else {
        Err(GitError::InvalidRef("分支名格式非法".into()))
    }
}

fn command_failed(output: &GitCommandOutput, fallback: &str) -> GitError {
    let stderr = output.stderr_text();
    let message = stderr.trim();
    let message = if message.is_empty() {
        fallback.to_owned()
    } else {
        message.chars().take(1000).collect()
    };
    let lower = message.to_lowercase();
    if lower.contains("would be overwritten")
        || lower.contains("local changes")
        || lower.contains("unmerged paths")
    {
        return GitError::DirtyWorktree(message);
    }
    if lower.contains("already exists") {
        return GitError::BranchExists(message);
    }
    if lower.contains("no upstream") || lower.contains("no tracking information") {
        return GitError::NoUpstream(message);
    }
    if lower.contains("non-fast-forward") || lower.contains("non fast-forward") {
        return GitError::NonFastForward(message);
    }
    if lower.contains("could not read username")
        || lower.contains("authentication failed")
        || lower.contains("permission denied")
        || lower.contains("rejected")
    {
        return GitError::Rejected(message);
    }
    GitError::CommandFailed(message)
}

fn validate_commit_sha(sha: &str) -> Result<(), GitError> {
    if (7..=64).contains(&sha.len()) && sha.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        Ok(())
    } else {
        Err(GitError::InvalidRef("commit SHA 格式非法".into()))
    }
}

fn parse_remotes(text: &str) -> Vec<GitRemote> {
    let mut remotes = HashMap::new();
    for line in text.lines() {
        let mut fields = line.split_whitespace();
        let (Some(name), Some(url), Some(kind)) = (fields.next(), fields.next(), fields.next())
        else {
            continue;
        };
        match kind {
            "(fetch)" => {
                remotes.insert(name.to_owned(), url.to_owned());
            }
            "(push)" => {
                remotes
                    .entry(name.to_owned())
                    .or_insert_with(|| url.to_owned());
            }
            _ => {}
        }
    }
    let mut remotes = remotes
        .into_iter()
        .map(|(name, url)| GitRemote { name, url })
        .collect::<Vec<_>>();
    remotes.sort_by(|left, right| left.name.cmp(&right.name));
    remotes
}

fn parse_branches(text: &str, current: Option<&str>) -> Vec<GitBranch> {
    let mut branches = Vec::new();
    for line in text.lines().filter(|line| !line.is_empty()) {
        let mut fields = line.split('\0');
        let full_ref = fields.next().unwrap_or_default();
        let short = fields.next().unwrap_or_default();
        let upstream = fields.next().unwrap_or_default();
        let track = fields.next().unwrap_or_default();
        if full_ref.is_empty() {
            continue;
        }
        let kind = if full_ref.starts_with("refs/remotes/") {
            GitBranchKind::Remote
        } else {
            GitBranchKind::Local
        };
        if kind == GitBranchKind::Remote && short.ends_with("/HEAD") {
            continue;
        }
        if kind == GitBranchKind::Remote {
            branches.push(GitBranch {
                name: short.to_owned(),
                is_current: false,
                kind,
                upstream: None,
                ahead: None,
                behind: None,
            });
            continue;
        }
        branches.push(GitBranch {
            name: short.to_owned(),
            is_current: current == Some(short),
            kind,
            upstream: Some((!upstream.is_empty()).then(|| upstream.to_owned())),
            ahead: parse_track_count(track, "ahead "),
            behind: parse_track_count(track, "behind "),
        });
    }
    branches.sort_by(|left, right| match (left.kind, right.kind) {
        (GitBranchKind::Local, GitBranchKind::Remote) => std::cmp::Ordering::Less,
        (GitBranchKind::Remote, GitBranchKind::Local) => std::cmp::Ordering::Greater,
        _ => left.name.cmp(&right.name),
    });
    branches
}

fn parse_track_count(track: &str, marker: &str) -> Option<u64> {
    let offset = track.find(marker)? + marker.len();
    let digits = track[offset..]
        .bytes()
        .take_while(u8::is_ascii_digit)
        .count();
    (digits > 0)
        .then(|| track[offset..offset + digits].parse().ok())
        .flatten()
}

fn parse_log(text: &str) -> Vec<GitCommit> {
    let mut commits = Vec::new();
    for record in text.split('\x1e') {
        let cleaned = record.trim_start();
        if cleaned.is_empty() {
            continue;
        }
        let fields = cleaned.split('\0').collect::<Vec<_>>();
        if fields.len() < 6 {
            continue;
        }
        let sha = fields[0].to_owned();
        let decorations = fields[4];
        let mut refs = decorations
            .split(',')
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| {
                let value = value.strip_prefix("HEAD -> ").unwrap_or(value);
                value
                    .strip_prefix("tag:")
                    .map(str::trim_start)
                    .unwrap_or(value)
                    .to_owned()
            })
            .collect::<Vec<_>>();
        if decorations.contains("HEAD") && !refs.iter().any(|value| value == "HEAD") {
            refs.push("HEAD".to_owned());
        }
        commits.push(GitCommit {
            short_sha: sha.chars().take(7).collect(),
            sha,
            parents: fields[1]
                .split(' ')
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect(),
            author: fields[2].to_owned(),
            date: fields[3].parse().unwrap_or(0),
            subject: fields[5].to_owned(),
            refs,
        });
    }
    commits
}

fn parse_commit_details(
    requested_sha: &str,
    details: &str,
    status_text: &str,
) -> Result<GitCommitDetails, GitError> {
    let separator = details
        .find('\x1e')
        .ok_or_else(|| GitError::CommandFailed("无法解析 commit 详情".into()))?;
    let metadata = details[..separator].split('\0').collect::<Vec<_>>();
    let full_sha = metadata
        .first()
        .copied()
        .unwrap_or(requested_sha)
        .to_owned();
    let author = metadata.get(1).copied().unwrap_or_default().to_owned();
    let author_email = metadata.get(2).copied().unwrap_or_default().to_owned();
    let date = metadata
        .get(3)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0);
    let message = metadata
        .get(4..)
        .unwrap_or_default()
        .join("\0")
        .trim()
        .to_owned();

    let mut statuses = HashMap::new();
    for line in status_text.trim().lines().filter(|line| !line.is_empty()) {
        let mut fields = line.splitn(2, '\t');
        let status = fields.next().unwrap_or("M");
        let path = fields.next().unwrap_or_default();
        if !path.is_empty() {
            statuses.insert(
                path.to_owned(),
                status.chars().next().unwrap_or('M').to_string(),
            );
        }
    }

    let mut insertions = 0_u64;
    let mut deletions = 0_u64;
    let mut files = Vec::new();
    for line in details[separator + 1..]
        .trim()
        .lines()
        .filter(|line| !line.is_empty())
    {
        let mut fields = line.splitn(3, '\t');
        let added = fields.next().unwrap_or_default();
        let removed = fields.next().unwrap_or_default();
        let path = fields.next().unwrap_or_default();
        if path.is_empty() {
            continue;
        }
        let added_count = parse_decimal(added);
        let removed_count = parse_decimal(removed);
        insertions = insertions.saturating_add(added_count.unwrap_or(0));
        deletions = deletions.saturating_add(removed_count.unwrap_or(0));
        files.push(GitCommitFile {
            path: path.to_owned(),
            status: statuses.get(path).cloned().unwrap_or_else(|| "M".into()),
            insertions: added_count,
            deletions: removed_count,
            binary: added == "-" || removed == "-",
        });
    }
    Ok(GitCommitDetails {
        short_sha: full_sha.chars().take(7).collect(),
        sha: full_sha,
        author,
        author_email,
        date,
        message,
        files_changed: files.len(),
        insertions,
        deletions,
        files,
    })
}

fn parse_decimal(value: &str) -> Option<u64> {
    (!value.is_empty() && value.bytes().all(|byte| byte.is_ascii_digit()))
        .then(|| value.parse().ok())
        .flatten()
}

fn parse_status(bytes: &[u8]) -> (Vec<GitChange>, Vec<String>) {
    let mut changes = Vec::new();
    let mut ignored_paths = Vec::new();
    let mut fields = bytes.split(|byte| *byte == 0);
    while let Some(record) = fields.next() {
        if record.is_empty() || record.len() < 3 {
            continue;
        }
        let index = record[0] as char;
        let worktree = record[1] as char;
        let path = String::from_utf8_lossy(&record[3..]).into_owned();
        if index == '!' && worktree == '!' {
            ignored_paths.push(path.strip_suffix('/').unwrap_or(&path).to_owned());
            continue;
        }
        let renamed_from = if index == 'R' || worktree == 'R' {
            fields
                .next()
                .map(|value| String::from_utf8_lossy(value).into_owned())
        } else {
            None
        };
        changes.push(GitChange {
            path,
            index_status: index.to_string(),
            worktree_status: worktree.to_string(),
            renamed_from,
        });
    }
    (changes, ignored_paths)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command as StdCommand;
    use std::sync::atomic::{AtomicU64, Ordering};

    fn temp_path(label: &str) -> PathBuf {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        std::env::temp_dir().join(format!(
            "osheep-git-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ))
    }

    fn git(root: &Path, args: &[&str]) {
        let status = StdCommand::new("git")
            .args(args)
            .current_dir(root)
            .status()
            .expect("git must be installed for the Rust test suite");
        assert!(status.success(), "git {args:?} failed");
    }

    fn git_output(root: &Path, args: &[&str]) -> String {
        let output = StdCommand::new("git")
            .args(args)
            .current_dir(root)
            .output()
            .expect("git must be installed for the Rust test suite");
        assert!(output.status.success(), "git {args:?} failed");
        String::from_utf8(output.stdout).unwrap().trim().to_owned()
    }

    #[test]
    fn parses_ignored_and_rename_porcelain_records() {
        let input = b"R  new.txt\0old.txt\0!! dist/\0?? visible.txt\0";
        let (changes, ignored) = parse_status(input);
        assert_eq!(ignored, vec!["dist"]);
        assert_eq!(changes[0].path, "new.txt");
        assert_eq!(changes[0].renamed_from.as_deref(), Some("old.txt"));
        assert_eq!(changes[1].index_status, "?");
    }

    #[tokio::test]
    async fn reports_repo_status_and_three_way_content() {
        let root = temp_path("contract");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Osheep Test"]);
        git(&root, &["config", "user.email", "git-test@osheep.invalid"]);
        std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
        git(&root, &["add", "tracked.txt"]);
        git(&root, &["commit", "-m", "initial"]);
        std::fs::write(root.join("tracked.txt"), "index\n").unwrap();
        git(&root, &["add", "tracked.txt"]);
        std::fs::write(root.join("tracked.txt"), "worktree\n").unwrap();

        let service = GitService::new(GitServiceConfig::default());
        let status = service.status(&root).await.unwrap();
        assert!(status.repo.is_repo);
        assert_eq!(status.repo.branch.as_deref(), Some("main"));
        assert!(status
            .changes
            .iter()
            .any(|change| change.path == "tracked.txt" && change.index_status == "M"));

        let diff = service
            .diff(&root, "tracked.txt", "HEAD", "WORKTREE")
            .await
            .unwrap();
        assert_eq!(diff.left_content, "base\n");
        assert_eq!(diff.right_content, "worktree\n");
        assert!(!diff.binary);
        let staged = service
            .diff(&root, "tracked.txt", "INDEX", "WORKTREE")
            .await
            .unwrap();
        assert_eq!(staged.left_content, "index\n");

        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn reports_remotes_branches_history_details_and_commit_diff() {
        let root = temp_path("history");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Osheep Test"]);
        git(&root, &["config", "user.email", "git-test@osheep.invalid"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("README.md"), "first\n").unwrap();
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-m", "initial"]);
        let first = git_output(&root, &["rev-parse", "HEAD"]);
        git(&root, &["branch", "feature"]);
        git(
            &root,
            &["remote", "add", "zeta", "https://example.invalid/zeta.git"],
        );
        git(
            &root,
            &[
                "remote",
                "add",
                "alpha",
                "https://example.invalid/alpha.git",
            ],
        );
        git(
            &root,
            &[
                "remote",
                "add",
                "origin",
                "https://example.invalid/origin.git",
            ],
        );

        std::fs::write(root.join("README.md"), "first\nsecond\n").unwrap();
        std::fs::write(root.join("binary.dat"), [0_u8, 1, 2, 3]).unwrap();
        git(&root, &["add", "README.md", "binary.dat"]);
        git(
            &root,
            &["commit", "-m", "show details", "-m", "Commit body"],
        );
        let second = git_output(&root, &["rev-parse", "HEAD"]);
        git(&root, &["update-ref", "refs/remotes/origin/main", &second]);
        git(&root, &["branch", "--set-upstream-to=origin/main", "main"]);

        let service = GitService::new(GitServiceConfig::default());
        let remotes = service.remotes(&root).await.unwrap();
        assert_eq!(
            remotes
                .iter()
                .map(|remote| remote.name.as_str())
                .collect::<Vec<_>>(),
            ["alpha", "origin", "zeta"]
        );
        assert_eq!(remotes[0].url, "https://example.invalid/alpha.git");

        let branches = service.branches(&root).await.unwrap();
        assert_eq!(branches.current.as_deref(), Some("main"));
        assert!(!branches.detached);
        let main = branches
            .branches
            .iter()
            .find(|branch| branch.name == "main")
            .unwrap();
        assert!(main.is_current);
        assert_eq!(main.kind, GitBranchKind::Local);
        assert_eq!(main.upstream, Some(Some("origin/main".into())));
        assert!(branches
            .branches
            .iter()
            .any(|branch| branch.name == "origin/main" && branch.kind == GitBranchKind::Remote));

        let log = service.log(&root, 1, 0, "HEAD").await.unwrap();
        assert_eq!(log.commits.len(), 1);
        assert_eq!(log.commits[0].sha, second);
        assert_eq!(log.commits[0].subject, "show details");
        assert!(log.commits[0].refs.iter().any(|value| value == "HEAD"));
        assert_eq!(log.head.as_deref(), Some(second.as_str()));
        assert_eq!(log.current_ref, Some(Some("refs/heads/main".into())));
        assert_eq!(
            log.current_remote_ref,
            Some(Some("refs/remotes/origin/main".into()))
        );
        let paged = service.log(&root, 1, 1, "HEAD").await.unwrap();
        assert_eq!(paged.commits.len(), 1);
        assert_eq!(paged.commits[0].sha, first);
        let all = service.log(&root, 10, 0, "--all").await.unwrap();
        assert!(all.commits.iter().any(|commit| commit.sha == second));
        assert!(all.commits.iter().any(|commit| commit.sha == first));
        let option_like_ref = service.log(&root, 10, 0, "--pretty=format:untrusted").await;
        assert!(matches!(option_like_ref, Err(GitError::InvalidRef(_))));

        let details = service.commit_details(&root, &second).await.unwrap();
        assert_eq!(details.author, "Osheep Test");
        assert_eq!(details.author_email, "git-test@osheep.invalid");
        assert_eq!(details.message, "show details\n\nCommit body");
        assert_eq!(details.files_changed, 2);
        assert_eq!(details.insertions, 1);
        assert_eq!(details.deletions, 0);
        let binary = details
            .files
            .iter()
            .find(|file| file.path == "binary.dat")
            .unwrap();
        assert_eq!(binary.status, "A");
        assert!(binary.binary);
        assert_eq!(binary.insertions, None);

        let diff = service
            .commit_diff(&root, &second, "README.md")
            .await
            .unwrap();
        assert_eq!(diff.base.as_deref(), Some(first.as_str()));
        assert_eq!(diff.left_content, "first\n");
        assert_eq!(diff.right_content, "first\nsecond\n");
        let root_diff = service
            .commit_diff(&root, &first, "README.md")
            .await
            .unwrap();
        assert_eq!(root_diff.base, None);
        assert!(root_diff.left_missing);
        assert_eq!(root_diff.right_content, "first\n");
        assert!(matches!(
            service.commit_details(&root, "not-a-sha").await,
            Err(GitError::InvalidRef(_))
        ));

        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn mutates_local_git_state_with_path_and_error_contracts() {
        let root = temp_path("writes");
        std::fs::create_dir_all(&root).unwrap();
        let service = GitService::new(GitServiceConfig::default());
        service.init(&root).await.unwrap();
        git(&root, &["config", "user.name", "Osheep Test"]);
        git(&root, &["config", "user.email", "git-test@osheep.invalid"]);
        git(&root, &["config", "core.autocrlf", "false"]);

        std::fs::write(root.join("tracked.txt"), "base\n").unwrap();
        service
            .stage(&root, &["tracked.txt".to_owned()])
            .await
            .unwrap();
        let first = service.commit(&root, "initial").await.unwrap();
        assert_eq!(first.len(), 40);
        let initial_branch = service.repo_info(&root).await.unwrap().branch.unwrap();

        std::fs::write(root.join("tracked.txt"), "changed\n").unwrap();
        std::fs::write(root.join("untracked.txt"), "remove me\n").unwrap();
        service
            .stage(&root, &["tracked.txt".to_owned()])
            .await
            .unwrap();
        service
            .unstage(&root, &["tracked.txt".to_owned()])
            .await
            .unwrap();
        let status = service.status(&root).await.unwrap();
        let tracked = status
            .changes
            .iter()
            .find(|change| change.path == "tracked.txt")
            .unwrap();
        assert_eq!(tracked.index_status, " ");
        assert_eq!(tracked.worktree_status, "M");

        let discarded = service
            .discard(
                &root,
                &["tracked.txt".to_owned(), "untracked.txt".to_owned()],
            )
            .await
            .unwrap();
        assert_eq!(discarded, ["tracked.txt", "untracked.txt"]);
        assert_eq!(
            std::fs::read_to_string(root.join("tracked.txt")).unwrap(),
            "base\n"
        );
        assert!(!root.join("untracked.txt").exists());

        service
            .add_remote(&root, "origin", "https://example.invalid/repo.git")
            .await
            .unwrap();
        assert!(matches!(
            service
                .add_remote(&root, "origin", "https://example.invalid/other.git")
                .await,
            Err(GitError::EntryExists(_))
        ));
        service.remove_remote(&root, "origin").await.unwrap();
        assert!(service.remotes(&root).await.unwrap().is_empty());

        service
            .checkout(&root, "feature", true, None)
            .await
            .unwrap();
        assert_eq!(
            service.repo_info(&root).await.unwrap().branch.as_deref(),
            Some("feature")
        );
        service
            .checkout(&root, &initial_branch, false, None)
            .await
            .unwrap();
        assert_eq!(
            service.repo_info(&root).await.unwrap().branch.as_deref(),
            Some(initial_branch.as_str())
        );
        assert!(matches!(
            service.commit(&root, "  ").await,
            Err(GitError::EmptyCommitMessage)
        ));
        assert!(matches!(
            service.checkout(&root, "../escape", false, None).await,
            Err(GitError::InvalidRef(_))
        ));

        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn fetch_pull_push_preserve_remote_and_fast_forward_contracts() {
        let root = temp_path("network-local");
        let remote = temp_path("network-remote");
        let clone = temp_path("network-clone");
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&remote).unwrap();
        std::fs::create_dir_all(&clone).unwrap();
        git(&remote, &["init", "--bare"]);
        git(&root, &["init", "-b", "main"]);
        git(&root, &["config", "user.name", "Osheep Test"]);
        git(&root, &["config", "user.email", "git-test@osheep.invalid"]);
        git(&root, &["config", "core.autocrlf", "false"]);
        std::fs::write(root.join("README.md"), "first\n").unwrap();
        git(&root, &["add", "README.md"]);
        git(&root, &["commit", "-m", "initial"]);
        git(
            &root,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );

        let service = GitService::new(GitServiceConfig::default());
        assert!(matches!(
            service.push(&root, None, None, true, false).await,
            Err(GitError::InvalidPath(_))
        ));
        service
            .push(&root, Some("origin"), Some("main"), true, false)
            .await
            .unwrap();
        git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);

        git(&clone, &["clone", remote.to_str().unwrap(), "."]);
        git(&clone, &["config", "user.name", "Clone Test"]);
        git(&clone, &["config", "user.email", "clone@osheep.invalid"]);
        std::fs::write(clone.join("README.md"), "first\nsecond\n").unwrap();
        git(&clone, &["add", "README.md"]);
        git(&clone, &["commit", "-m", "remote update"]);
        let clone_service = GitService::new(GitServiceConfig::default());
        clone_service
            .push(&clone, Some("origin"), Some("main"), false, false)
            .await
            .unwrap();

        service.fetch(&root, Some("origin"), true).await.unwrap();
        service
            .pull(&root, Some("origin"), Some("main"), true)
            .await
            .unwrap();
        assert_eq!(
            std::fs::read_to_string(root.join("README.md")).unwrap(),
            "first\nsecond\n"
        );
        assert!(matches!(
            service.fetch(&root, Some("--bad"), false).await,
            Err(GitError::InvalidPath(_))
        ));
        assert!(matches!(
            service
                .pull(&root, Some("origin"), Some("../bad"), true)
                .await,
            Err(GitError::InvalidRef(_))
        ));

        std::fs::remove_dir_all(root).ok();
        std::fs::remove_dir_all(remote).ok();
        std::fs::remove_dir_all(clone).ok();
    }

    #[tokio::test]
    async fn output_limit_releases_the_command_permit() {
        let root = temp_path("limit");
        std::fs::create_dir_all(&root).unwrap();
        git(&root, &["init"]);
        std::fs::write(root.join("large.txt"), vec![b'x'; 4096]).unwrap();
        git(&root, &["add", "large.txt"]);
        let service = GitService::new(GitServiceConfig {
            max_parallel_commands: 1,
            max_output_bytes: 128,
            ..GitServiceConfig::default()
        });
        let error = service
            .diff(&root, "large.txt", "INDEX", "WORKTREE")
            .await
            .unwrap_err();
        assert!(matches!(error, GitError::OutputTooLarge));
        assert_eq!(service.available_permits(), 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn cancellation_and_timeout_release_permits_after_process_exit() {
        let root = temp_path("cancel");
        std::fs::create_dir_all(&root).unwrap();
        let commands = Arc::new(Semaphore::new(1));

        let cancel = Arc::new(Notify::new());
        let worker = tokio::spawn(run_process(
            sleep_program().to_owned(),
            root.clone(),
            sleep_args(),
            Duration::from_secs(30),
            1024,
            cancel.clone(),
            commands.clone().acquire_owned().await.unwrap(),
        ));
        tokio::task::yield_now().await;
        assert_eq!(commands.available_permits(), 0);
        cancel.notify_one();
        let error = tokio::time::timeout(Duration::from_secs(5), worker)
            .await
            .expect("cancelled process did not exit")
            .unwrap()
            .unwrap_err();
        assert!(matches!(error, GitError::Cancelled));
        assert_eq!(commands.available_permits(), 1);

        let error = run_process(
            sleep_program().to_owned(),
            root.clone(),
            sleep_args(),
            Duration::from_millis(25),
            1024,
            Arc::new(Notify::new()),
            commands.clone().acquire_owned().await.unwrap(),
        )
        .await
        .unwrap_err();
        assert!(matches!(error, GitError::Timeout));
        assert_eq!(commands.available_permits(), 1);
        std::fs::remove_dir_all(root).ok();
    }

    #[cfg(windows)]
    fn sleep_program() -> &'static str {
        "powershell.exe"
    }

    #[cfg(windows)]
    fn sleep_args() -> Vec<String> {
        ["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]
            .into_iter()
            .map(str::to_owned)
            .collect()
    }

    #[cfg(unix)]
    fn sleep_program() -> &'static str {
        "sleep"
    }

    #[cfg(unix)]
    fn sleep_args() -> Vec<String> {
        vec!["30".to_owned()]
    }
}
