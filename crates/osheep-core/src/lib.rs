mod agent_sessions;
mod agents;
mod changes;
mod claude_onboarding;
mod files;
mod git;
mod search;
mod sessions;
mod state;
mod tasks;

pub use agent_sessions::{
    AgentSessionApp, AgentSessionError, AgentSessionRoots, AgentSessionService, AgentSessionSummary,
};
pub use agents::{AgentError, AgentRecord, AgentService};
pub use changes::{
    changed_fingerprint_keys, ChangeError, WorkspaceChangeBaseline, WorkspaceChangeMode,
    WorkspaceChangeSnapshot, WorkspaceChangeTracker,
};
pub use claude_onboarding::{
    ClaudeOnboardingError, ClaudeOnboardingService, ClaudeOnboardingStatus,
};
pub use files::{
    BinaryRead, CacheStatus, EntryKind, FileError, FileRead, FileService, FileServiceConfig,
    FileWrite, FsEntry,
};
pub use git::{
    GitBranch, GitBranchKind, GitBranches, GitChange, GitCommit, GitCommitDetails, GitCommitDiff,
    GitCommitFile, GitDiff, GitError, GitLog, GitRemote, GitRepoInfo, GitService, GitServiceConfig,
    GitStatus,
};
pub use search::{
    SearchError, SearchFileMatch, SearchMatchLine, SearchOptions, SearchResult, SearchService,
    SearchServiceConfig,
};
pub use sessions::{
    ChatMessage, ChatRole, SessionError, SessionRecord, SessionService, SessionSummary,
};
pub use state::{OpenedProject, StateError, StateStore};
pub use tasks::{
    BackgroundTaskQueue, TaskCancellation, TaskId, TaskPriority, TaskQueueError, TaskState,
};

use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{Mutex, RwLock};

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Workspace {
    pub id: String,
    pub name: String,
    pub path: PathBuf,
}

#[derive(Debug, Error)]
pub enum WorkspaceError {
    #[error("工作区不存在: {0}")]
    NotFound(String),
    #[error("工作区路径越出配置根目录")]
    OutsideRoot,
    #[error("{0}")]
    InvalidRoot(String),
    #[error("{0}")]
    InvalidName(String),
    #[error("同名条目已存在")]
    EntryExists,
    #[error("工作区 I/O 失败: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct WorkspaceResolver {
    root: Arc<RwLock<PathBuf>>,
    mutations: Arc<Mutex<()>>,
}

impl WorkspaceResolver {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: Arc::new(RwLock::new(root.into())),
            mutations: Arc::new(Mutex::new(())),
        }
    }

    pub async fn root(&self) -> PathBuf {
        self.root.read().await.clone()
    }

    pub async fn ensure_root(&self) -> Result<(), WorkspaceError> {
        tokio::fs::create_dir_all(self.root().await).await?;
        Ok(())
    }

    pub async fn canonical_root(&self) -> Result<PathBuf, WorkspaceError> {
        Ok(tokio::fs::canonicalize(self.root().await).await?)
    }

    pub async fn validate_root(&self, root: &Path) -> Result<PathBuf, WorkspaceError> {
        if !root.is_absolute() {
            return Err(WorkspaceError::InvalidRoot(
                "workspaces 根目录必须是绝对路径".into(),
            ));
        }
        let metadata = tokio::fs::metadata(root).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                WorkspaceError::InvalidRoot("workspaces 根目录不存在".into())
            } else {
                WorkspaceError::Io(error)
            }
        })?;
        if !metadata.is_dir() {
            return Err(WorkspaceError::InvalidRoot(
                "workspaces 根目录不是目录".into(),
            ));
        }
        Ok(tokio::fs::canonicalize(root).await?)
    }

    pub async fn set_root(&self, root: PathBuf) {
        *self.root.write().await = root;
    }

    pub async fn list(&self) -> Result<Vec<Workspace>, WorkspaceError> {
        self.ensure_root().await?;
        let root = self.root().await;
        let mut entries = tokio::fs::read_dir(root).await?;
        let mut workspaces = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if valid_workspace_id(&name) && entry.file_type().await?.is_dir() {
                workspaces.push(Workspace {
                    id: name.clone(),
                    name,
                    path: entry.path(),
                });
            }
        }
        workspaces.sort_by(|left, right| left.id.cmp(&right.id));
        Ok(workspaces)
    }

    pub async fn create(&self, name: &str) -> Result<Workspace, WorkspaceError> {
        let id = name.trim();
        if !valid_workspace_id(id) {
            return Err(WorkspaceError::InvalidName(
                "工作区名称只能包含字母、数字、点、下划线和短横线".into(),
            ));
        }
        let _guard = self.mutations.lock().await;
        self.ensure_root().await?;
        let root = self.root().await;
        let path = root.join(id);
        match tokio::fs::create_dir(&path).await {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
                return Err(WorkspaceError::EntryExists);
            }
            Err(error) => return Err(error.into()),
        }
        if let Err(error) = ensure_workspace_layout(&path).await {
            let _ = tokio::fs::remove_dir_all(&path).await;
            return Err(error);
        }
        let path = tokio::fs::canonicalize(path).await?;
        Ok(Workspace {
            id: id.to_owned(),
            name: id.to_owned(),
            path,
        })
    }

    pub async fn resolve(&self, id: &str) -> Result<Workspace, WorkspaceError> {
        if !valid_workspace_id(id) {
            return Err(WorkspaceError::NotFound(id.to_owned()));
        }
        let configured_root = self.root().await;
        let root = tokio::fs::canonicalize(&configured_root).await?;
        let candidate = configured_root.join(id);
        let metadata = tokio::fs::metadata(&candidate)
            .await
            .map_err(|_| WorkspaceError::NotFound(id.to_owned()))?;
        if !metadata.is_dir() {
            return Err(WorkspaceError::NotFound(id.to_owned()));
        }
        let resolved = tokio::fs::canonicalize(candidate).await?;
        if !resolved.starts_with(&root) {
            return Err(WorkspaceError::OutsideRoot);
        }
        Ok(Workspace {
            id: id.to_owned(),
            name: id.to_owned(),
            path: resolved,
        })
    }
}

pub async fn ensure_workspace_layout(root: &Path) -> Result<(), WorkspaceError> {
    let osheep = root.join(".osheep");
    tokio::fs::create_dir_all(osheep.join("docs")).await?;
    let settings = osheep.join("settings.json");
    match tokio::fs::OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&settings)
        .await
    {
        Ok(mut file) => {
            use tokio::io::AsyncWriteExt;
            file.write_all(
                b"{\n  \"editor\": {\n    \"fontSize\": 14,\n    \"tabSize\": 2\n  }\n}\n",
            )
            .await?;
            file.flush().await?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}

fn valid_workspace_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 64
        && !id.starts_with('.')
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_ids_match_the_node_contract() {
        assert!(valid_workspace_id("demo-1.test"));
        assert!(!valid_workspace_id(".hidden"));
        assert!(!valid_workspace_id("../escape"));
        assert!(!valid_workspace_id("含中文"));
    }
}
