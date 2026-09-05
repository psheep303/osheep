use crate::files::FileChangeCursor;
use crate::{BackgroundTaskQueue, FileService, GitService, TaskPriority};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use thiserror::Error;
use tokio::sync::{Mutex, Notify};

const MAX_TRACKED_FILES: usize = 50_000;
const SKIP_DIRS: &[&str] = &[
    ".git",
    "node_modules",
    ".venv",
    "venv",
    "dist",
    "build",
    "coverage",
    "target",
    "__pycache__",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum WorkspaceChangeMode {
    Git,
    Files,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorkspaceChangeBaseline {
    pub mode: WorkspaceChangeMode,
    pub fingerprints: HashMap<String, String>,
}

#[derive(Debug, Error)]
pub enum ChangeError {
    #[error("工作区变更扫描失败: {0}")]
    Scan(String),
    #[error("工作区变更任务失败: {0}")]
    Task(String),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkspaceChangeSnapshot {
    pub mode: WorkspaceChangeMode,
    pub changed_paths: Vec<String>,
    pub full_scan: bool,
    pub full_scans: usize,
    pub fingerprints: HashMap<String, String>,
}

#[derive(Debug)]
struct TrackedWorkspace {
    mode: WorkspaceChangeMode,
    fingerprints: HashMap<String, String>,
    cursor: FileChangeCursor,
    full_scans: usize,
    initialized: bool,
}

#[derive(Clone)]
pub struct WorkspaceChangeTracker {
    files: FileService,
    git: GitService,
    queue: BackgroundTaskQueue,
    workspaces: Arc<Mutex<HashMap<PathBuf, TrackedWorkspace>>>,
}

impl WorkspaceChangeTracker {
    pub fn new(files: FileService, git: GitService, queue: BackgroundTaskQueue) -> Self {
        Self {
            files,
            git,
            queue,
            workspaces: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn refresh(
        &self,
        workspace_root: &Path,
    ) -> Result<WorkspaceChangeSnapshot, ChangeError> {
        let root = fs::canonicalize(workspace_root)
            .map_err(|error| ChangeError::Scan(error.to_string()))?;
        self.files.watch_for_changes(&root, &root);
        let files = self.files.clone();
        let git = self.git.clone();
        let workspaces = self.workspaces.clone();
        let root_for_task = root.clone();
        let result = Arc::new(Mutex::new(None));
        let notify = Arc::new(Notify::new());
        let result_for_task = result.clone();
        let notify_for_task = notify.clone();
        self.queue
            .submit(TaskPriority::Background, move |_| async move {
                let computed = refresh_sync(&files, &git, &workspaces, &root_for_task).await;
                *result_for_task.lock().await = Some(computed);
                notify_for_task.notify_one();
                Ok(())
            })
            .await
            .map_err(|error| ChangeError::Task(error.to_string()))?;
        notify.notified().await;
        let computed = result
            .lock()
            .await
            .take()
            .expect("change tracker task did not publish result");
        computed
    }

    pub async fn baseline(
        &self,
        workspace_root: &Path,
    ) -> Result<WorkspaceChangeBaseline, ChangeError> {
        let snapshot = self.refresh(workspace_root).await?;
        Ok(WorkspaceChangeBaseline {
            mode: snapshot.mode,
            fingerprints: snapshot.fingerprints,
        })
    }

    pub async fn full_scans(&self, workspace_root: &Path) -> usize {
        let root = fs::canonicalize(workspace_root).unwrap_or_else(|_| workspace_root.to_owned());
        self.workspaces
            .lock()
            .await
            .get(&root)
            .map(|state| state.full_scans)
            .unwrap_or(0)
    }
}

async fn refresh_sync(
    files: &FileService,
    git: &GitService,
    workspaces: &Mutex<HashMap<PathBuf, TrackedWorkspace>>,
    root: &Path,
) -> Result<WorkspaceChangeSnapshot, ChangeError> {
    let status = git
        .status(root)
        .await
        .map_err(|error| ChangeError::Scan(error.to_string()))?;
    let mode = if status.repo.is_repo {
        WorkspaceChangeMode::Git
    } else {
        WorkspaceChangeMode::Files
    };
    let mut states = workspaces.lock().await;
    let state = states
        .entry(root.to_owned())
        .or_insert_with(|| TrackedWorkspace {
            mode,
            fingerprints: HashMap::new(),
            cursor: files.change_cursor(),
            full_scans: 0,
            initialized: false,
        });
    if state.mode != mode {
        state.mode = mode;
        state.fingerprints.clear();
        state.initialized = false;
    }
    let mut full_scan = false;
    let changed_paths;
    if mode == WorkspaceChangeMode::Git {
        let current = git_fingerprints(root, &status.changes);
        changed_paths = changed_fingerprint_keys(&state.fingerprints, &current);
        state.fingerprints = current;
        state.cursor = files.change_cursor();
    } else if !state.initialized {
        state.fingerprints = file_fingerprints(root);
        state.cursor = files.change_cursor();
        state.full_scans += 1;
        state.initialized = true;
        full_scan = true;
        changed_paths = {
            let mut paths = state.fingerprints.keys().cloned().collect::<Vec<_>>();
            paths.sort();
            paths
        };
    } else {
        let batch = files.changes_since(root, state.cursor);
        state.cursor = batch.cursor;
        if batch.overflow || batch.paths.iter().any(|path| path == root) {
            let before = state.fingerprints.clone();
            state.fingerprints = file_fingerprints(root);
            state.full_scans += 1;
            full_scan = true;
            changed_paths = changed_fingerprint_keys(&before, &state.fingerprints);
        } else {
            let mut affected = HashSet::new();
            for path in batch.paths {
                let relative = path
                    .strip_prefix(root)
                    .ok()
                    .map(|value| value.to_string_lossy().replace('\\', "/"));
                if let Some(relative) = relative {
                    affected.insert(relative);
                }
            }
            let before = state.fingerprints.clone();
            for relative in affected {
                remove_subtree(&mut state.fingerprints, &relative);
                let absolute = root.join(&relative);
                if absolute.is_dir() {
                    state
                        .fingerprints
                        .extend(file_fingerprints_from(&absolute, root));
                } else if absolute.is_file() {
                    if let Some(value) = file_stat_fingerprint(&absolute) {
                        state.fingerprints.insert(relative, value);
                    }
                }
            }
            changed_paths = changed_fingerprint_keys(&before, &state.fingerprints);
        }
    }
    Ok(WorkspaceChangeSnapshot {
        mode,
        changed_paths,
        full_scan,
        full_scans: state.full_scans,
        fingerprints: state.fingerprints.clone(),
    })
}

pub fn changed_fingerprint_keys(
    before: &HashMap<String, String>,
    after: &HashMap<String, String>,
) -> Vec<String> {
    let mut paths = before
        .keys()
        .chain(after.keys())
        .cloned()
        .collect::<HashSet<_>>()
        .into_iter()
        .collect::<Vec<_>>();
    paths.retain(|path| before.get(path) != after.get(path));
    paths.sort();
    paths
}

fn git_fingerprints(root: &Path, changes: &[crate::GitChange]) -> HashMap<String, String> {
    changes
        .iter()
        .map(|change| {
            let path = change.path.replace('\\', "/");
            let stat =
                file_stat_fingerprint(&root.join(&change.path)).unwrap_or_else(|| "missing".into());
            (
                path,
                format!(
                    "{}|{}|{}|{}",
                    change.index_status,
                    change.worktree_status,
                    change.renamed_from.as_deref().unwrap_or(""),
                    stat
                ),
            )
        })
        .collect()
}

fn file_fingerprints(root: &Path) -> HashMap<String, String> {
    file_fingerprints_from(root, root)
}

fn file_fingerprints_from(directory: &Path, root: &Path) -> HashMap<String, String> {
    let mut result = HashMap::new();
    let mut pending = vec![directory.to_owned()];
    while let Some(directory) = pending.pop() {
        let Ok(entries) = fs::read_dir(&directory) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            let Ok(file_type) = entry.file_type() else {
                continue;
            };
            if file_type.is_symlink() {
                continue;
            }
            if file_type.is_dir() {
                if !SKIP_DIRS.contains(&entry.file_name().to_string_lossy().as_ref()) {
                    pending.push(path);
                }
                continue;
            }
            if !file_type.is_file() {
                continue;
            }
            let relative = path
                .strip_prefix(root)
                .unwrap_or(&path)
                .to_string_lossy()
                .replace('\\', "/");
            if result.len() >= MAX_TRACKED_FILES {
                return result;
            }
            if let Some(value) = file_stat_fingerprint(&path) {
                result.insert(relative, value);
            }
        }
    }
    result
}

fn file_stat_fingerprint(path: &Path) -> Option<String> {
    let metadata = fs::metadata(path).ok()?;
    let modified = metadata
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs_f64()
        * 1000.0;
    Some(format!("{}|{}", metadata.len(), modified))
}

fn remove_subtree(fingerprints: &mut HashMap<String, String>, relative: &str) {
    let prefix = format!("{relative}/");
    fingerprints.retain(|path, _| path != relative && !path.starts_with(&prefix));
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{FileServiceConfig, GitServiceConfig};
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp_path(label: &str) -> PathBuf {
        let nonce = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        std::env::temp_dir().join(format!("osheep-changes-{label}-{nonce}"))
    }

    #[test]
    fn fingerprint_comparison_reports_added_modified_deleted() {
        let before = HashMap::from([
            ("modified.ts".into(), "1".into()),
            ("deleted.ts".into(), "1".into()),
        ]);
        let after = HashMap::from([
            ("modified.ts".into(), "2".into()),
            ("added.ts".into(), "1".into()),
        ]);
        assert_eq!(
            changed_fingerprint_keys(&before, &after),
            ["added.ts", "deleted.ts", "modified.ts"]
        );
    }

    #[tokio::test]
    async fn non_git_writes_use_incremental_refresh() {
        let root = temp_path("incremental");
        fs::create_dir_all(&root).unwrap();
        let files = FileService::new(FileServiceConfig::default());
        files
            .write_text(&root, "existing.txt", "before".into(), false)
            .await
            .unwrap();
        let tracker = WorkspaceChangeTracker::new(
            files.clone(),
            GitService::new(GitServiceConfig::default()),
            BackgroundTaskQueue::new(16, 1),
        );
        let first = tracker.refresh(&root).await.unwrap();
        assert!(first.full_scan);
        assert_eq!(first.full_scans, 1);
        files
            .write_text(&root, "existing.txt", "after-content".into(), false)
            .await
            .unwrap();
        files
            .write_text(&root, "added.txt", "new".into(), false)
            .await
            .unwrap();
        let second = tracker.refresh(&root).await.unwrap();
        assert!(!second.full_scan);
        assert_eq!(second.full_scans, 1);
        assert_eq!(second.changed_paths, ["added.txt", "existing.txt"]);
        fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn directory_move_refreshes_old_and_new_subtrees() {
        let root = temp_path("move");
        fs::create_dir_all(root.join("old")).unwrap();
        fs::write(root.join("old/item.txt"), "value").unwrap();
        let files = FileService::new(FileServiceConfig::default());
        let tracker = WorkspaceChangeTracker::new(
            files.clone(),
            GitService::new(GitServiceConfig::default()),
            BackgroundTaskQueue::new(16, 1),
        );
        tracker.refresh(&root).await.unwrap();
        files.move_entry(&root, "old", "new").await.unwrap();
        let snapshot = tracker.refresh(&root).await.unwrap();
        assert_eq!(snapshot.changed_paths, ["new/item.txt", "old/item.txt"]);
        fs::remove_dir_all(root).ok();
    }

    #[tokio::test]
    async fn journal_overflow_forces_full_rescan() {
        let root = temp_path("overflow");
        fs::create_dir_all(&root).unwrap();
        let files = FileService::new(FileServiceConfig {
            change_journal_capacity: 1,
            ..FileServiceConfig::default()
        });
        files
            .write_text(&root, "one.txt", "1".into(), false)
            .await
            .unwrap();
        let tracker = WorkspaceChangeTracker::new(
            files.clone(),
            GitService::new(GitServiceConfig::default()),
            BackgroundTaskQueue::new(16, 1),
        );
        tracker.refresh(&root).await.unwrap();
        files
            .write_text(&root, "one.txt", "2".into(), false)
            .await
            .unwrap();
        files
            .write_text(&root, "two.txt", "2".into(), false)
            .await
            .unwrap();
        let snapshot = tracker.refresh(&root).await.unwrap();
        assert!(snapshot.full_scan);
        assert_eq!(snapshot.full_scans, 2);
        fs::remove_dir_all(root).ok();
    }
}
