use serde::Serialize;
#[cfg(any(target_os = "linux", target_os = "windows"))]
use std::collections::HashSet;
use std::collections::{HashMap, VecDeque};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{Mutex, Semaphore};

const IGNORED_DIRECTORIES: &[&str] = &[
    "node_modules",
    ".git",
    "dist",
    "build",
    ".next",
    ".vite",
    ".cache",
];
static WRITE_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Clone)]
pub struct FileServiceConfig {
    pub max_file_size: u64,
    pub max_parallel_reads: usize,
    pub max_parallel_directories: usize,
    pub cache_max_entries: usize,
    pub cache_max_bytes: usize,
    pub cache_file_max_bytes: usize,
    pub change_journal_capacity: usize,
}

impl Default for FileServiceConfig {
    fn default() -> Self {
        Self {
            max_file_size: 5 * 1024 * 1024,
            max_parallel_reads: 32,
            max_parallel_directories: 8,
            cache_max_entries: 128,
            cache_max_bytes: 16 * 1024 * 1024,
            cache_file_max_bytes: 1024 * 1024,
            change_journal_capacity: 8192,
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub(crate) struct FileChangeCursor {
    sequence: u64,
}

#[derive(Debug)]
pub(crate) struct FileChangeBatch {
    pub paths: Vec<PathBuf>,
    pub overflow: bool,
    pub cursor: FileChangeCursor,
}

#[derive(Debug)]
struct FileChangeEvent {
    sequence: u64,
    root: PathBuf,
    path: PathBuf,
}

#[derive(Debug)]
struct FileChangeJournal {
    events: VecDeque<FileChangeEvent>,
    sequence: u64,
    capacity: usize,
}

impl FileChangeJournal {
    fn new(capacity: usize) -> Self {
        Self {
            events: VecDeque::new(),
            sequence: 0,
            capacity: capacity.max(1),
        }
    }

    fn record(&mut self, root: &Path, path: &Path) {
        self.sequence = self.sequence.wrapping_add(1).max(1);
        self.events.push_back(FileChangeEvent {
            sequence: self.sequence,
            root: root.to_owned(),
            path: path.to_owned(),
        });
        while self.events.len() > self.capacity {
            self.events.pop_front();
        }
    }

    fn cursor(&self) -> FileChangeCursor {
        FileChangeCursor {
            sequence: self.sequence,
        }
    }

    fn changes_since(&self, root: &Path, cursor: FileChangeCursor) -> FileChangeBatch {
        let overflow = self
            .events
            .front()
            .is_some_and(|event| cursor.sequence < event.sequence.saturating_sub(1));
        let paths = self
            .events
            .iter()
            .filter(|event| event.sequence > cursor.sequence && event.root == root)
            .map(|event| event.path.clone())
            .collect();
        FileChangeBatch {
            paths,
            overflow,
            cursor: self.cursor(),
        }
    }
}

#[derive(Debug, Error)]
pub enum FileError {
    #[error("{0}")]
    InvalidPath(String),
    #[error("路径越出工作区边界")]
    OutsideWorkspace,
    #[error("目标不存在")]
    NotFound,
    #[error("父目录不存在")]
    ParentNotFound,
    #[error("目标是目录")]
    IsDirectory,
    #[error("目标不是目录")]
    NotDirectory,
    #[error("同名条目已存在")]
    EntryExists,
    #[error("目录非空且未带 recursive")]
    DirectoryNotEmpty,
    #[error("文件超过上限 {0} 字节")]
    FileTooLarge(u64),
    #[error("文件不是标准 UTF-8 文本，暂不支持在编辑器中打开")]
    BinaryFile,
    #[error("文件 I/O 失败: {0}")]
    Io(#[from] io::Error),
    #[error("文件任务失败: {0}")]
    Join(String),
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum EntryKind {
    File,
    Directory,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FsEntry {
    pub name: String,
    pub path: String,
    pub kind: EntryKind,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub mtime: Option<f64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CacheStatus {
    Hit,
    Miss,
    Bypass,
}

impl CacheStatus {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hit => "hit",
            Self::Miss => "miss",
            Self::Bypass => "bypass",
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileRead {
    pub path: String,
    pub content: String,
    pub encoding: &'static str,
    pub size: u64,
    pub mtime: f64,
    #[serde(skip)]
    pub etag: String,
    #[serde(skip)]
    pub cache_status: CacheStatus,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FileWrite {
    pub path: String,
    pub size: u64,
    pub mtime: f64,
}

#[derive(Debug, Clone)]
pub struct BinaryRead {
    pub path: String,
    pub content: Vec<u8>,
    pub size: u64,
    pub mtime: f64,
    pub etag: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct FileFingerprint {
    size: u64,
    modified_nanos: u128,
}

#[derive(Debug, Clone)]
struct CacheEntry {
    fingerprint: FileFingerprint,
    content: String,
    mtime: f64,
    etag: String,
    bytes: usize,
}

#[derive(Debug)]
struct TextCache {
    entries: HashMap<PathBuf, CacheEntry>,
    order: VecDeque<PathBuf>,
    bytes: usize,
    max_entries: usize,
    max_bytes: usize,
    max_file_bytes: usize,
}

impl TextCache {
    fn new(config: &FileServiceConfig) -> Self {
        Self {
            entries: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            max_entries: config.cache_max_entries,
            max_bytes: config.cache_max_bytes,
            max_file_bytes: config.cache_file_max_bytes,
        }
    }

    fn get(&mut self, path: &Path, fingerprint: &FileFingerprint) -> Option<CacheEntry> {
        let entry = self.entries.get(path).cloned();
        match entry {
            Some(entry) if &entry.fingerprint == fingerprint => {
                self.touch(path);
                Some(entry)
            }
            Some(_) => {
                self.remove(path);
                None
            }
            None => None,
        }
    }

    fn insert(&mut self, path: PathBuf, entry: CacheEntry) -> bool {
        if self.max_entries == 0
            || self.max_bytes == 0
            || entry.bytes > self.max_file_bytes
            || entry.bytes > self.max_bytes
        {
            return false;
        }
        self.remove(&path);
        self.bytes += entry.bytes;
        self.order.push_back(path.clone());
        self.entries.insert(path, entry);
        while self.entries.len() > self.max_entries || self.bytes > self.max_bytes {
            let Some(oldest) = self.order.pop_front() else {
                break;
            };
            if let Some(entry) = self.entries.remove(&oldest) {
                self.bytes = self.bytes.saturating_sub(entry.bytes);
            }
        }
        true
    }

    fn invalidate(&mut self, path: &Path) {
        let paths = self
            .entries
            .keys()
            .filter(|cached| cached.as_path() == path || cached.starts_with(path))
            .cloned()
            .collect::<Vec<_>>();
        for path in paths {
            self.remove(&path);
        }
    }

    fn touch(&mut self, path: &Path) {
        self.order.retain(|candidate| candidate != path);
        self.order.push_back(path.to_owned());
    }

    fn remove(&mut self, path: &Path) {
        if let Some(entry) = self.entries.remove(path) {
            self.bytes = self.bytes.saturating_sub(entry.bytes);
        }
        self.order.retain(|candidate| candidate != path);
    }
}

#[derive(Debug, Clone)]
pub struct FileService {
    config: FileServiceConfig,
    reads: Arc<Semaphore>,
    directories: Arc<Semaphore>,
    mutations: Arc<Mutex<()>>,
    cache: Arc<Mutex<TextCache>>,
    changes: Arc<std::sync::Mutex<FileChangeJournal>>,
    #[cfg(target_os = "windows")]
    watched_roots: Arc<std::sync::Mutex<HashSet<PathBuf>>>,
    #[cfg(target_os = "linux")]
    linux_watcher: Option<Arc<LinuxWatcher>>,
    #[cfg(any(target_os = "linux", target_os = "windows"))]
    watcher_events: Arc<AtomicU64>,
}

impl FileService {
    pub fn new(config: FileServiceConfig) -> Self {
        let reads = config.max_parallel_reads.max(1);
        let directories = config.max_parallel_directories.max(1);
        let cache = Arc::new(Mutex::new(TextCache::new(&config)));
        let changes = Arc::new(std::sync::Mutex::new(FileChangeJournal::new(
            config.change_journal_capacity,
        )));
        #[cfg(any(target_os = "linux", target_os = "windows"))]
        let watcher_events = Arc::new(AtomicU64::new(0));
        #[cfg(target_os = "linux")]
        let linux_watcher =
            LinuxWatcher::start(cache.clone(), changes.clone(), watcher_events.clone());
        Self {
            cache,
            changes,
            config,
            reads: Arc::new(Semaphore::new(reads)),
            directories: Arc::new(Semaphore::new(directories)),
            mutations: Arc::new(Mutex::new(())),
            #[cfg(target_os = "windows")]
            watched_roots: Arc::new(std::sync::Mutex::new(HashSet::new())),
            #[cfg(target_os = "linux")]
            linux_watcher,
            #[cfg(any(target_os = "linux", target_os = "windows"))]
            watcher_events,
        }
    }

    pub(crate) fn watch_for_changes(&self, root: &Path, directory: &Path) {
        self.ensure_watched(root, directory);
    }

    pub(crate) fn change_cursor(&self) -> FileChangeCursor {
        self.changes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .cursor()
    }

    pub(crate) fn changes_since(&self, root: &Path, cursor: FileChangeCursor) -> FileChangeBatch {
        self.changes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .changes_since(root, cursor)
    }

    async fn record_change(&self, root: &Path, path: &Path) {
        self.invalidate_candidates(path).await;
        self.changes
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .record(root, path);
    }

    pub async fn list_tree(
        &self,
        workspace_root: &Path,
        relative: &str,
        include_hidden: bool,
        include_metadata: bool,
    ) -> Result<Vec<FsEntry>, FileError> {
        let _permit = self
            .directories
            .acquire()
            .await
            .map_err(|error| FileError::Io(io::Error::other(error)))?;
        let normalized = normalize_relative(relative)?;
        let (root, directory) = canonical_existing(workspace_root, &normalized).await?;
        self.ensure_watched(&root, &directory);
        let metadata = tokio::fs::metadata(&directory).await?;
        if !metadata.is_dir() {
            return Err(FileError::NotDirectory);
        }
        let mut reader = tokio::fs::read_dir(&directory).await?;
        let mut entries = Vec::new();
        while let Some(entry) = reader.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            let file_type = entry.file_type().await?;
            let is_directory = file_type.is_dir();
            if !include_hidden && is_directory && IGNORED_DIRECTORIES.contains(&name.as_str()) {
                continue;
            }
            let path = if normalized.is_empty() {
                name.clone()
            } else {
                format!("{normalized}/{name}")
            };
            let (size, mtime) = if include_metadata && !is_directory {
                match entry.metadata().await {
                    Ok(metadata) => (Some(metadata.len()), modified_millis(&metadata).ok()),
                    Err(_) => (None, None),
                }
            } else {
                (None, None)
            };
            entries.push(FsEntry {
                name,
                path,
                kind: if is_directory {
                    EntryKind::Directory
                } else {
                    EntryKind::File
                },
                size,
                mtime,
            });
        }
        entries.sort_by(|left, right| {
            let left_kind = matches!(left.kind, EntryKind::File);
            let right_kind = matches!(right.kind, EntryKind::File);
            left_kind
                .cmp(&right_kind)
                .then_with(|| left.name.cmp(&right.name))
        });
        Ok(entries)
    }

    pub async fn read_text(
        &self,
        workspace_root: &Path,
        relative: &str,
    ) -> Result<FileRead, FileError> {
        let _permit = self
            .reads
            .acquire()
            .await
            .map_err(|error| FileError::Io(io::Error::other(error)))?;
        let normalized = normalize_relative(relative)?;
        let (root, path) = canonical_existing(workspace_root, &normalized).await?;
        self.ensure_watched(&root, path.parent().unwrap_or(&root));
        for _ in 0..2 {
            let before = tokio::fs::metadata(&path).await?;
            if before.is_dir() {
                return Err(FileError::IsDirectory);
            }
            if before.len() > self.config.max_file_size {
                return Err(FileError::FileTooLarge(self.config.max_file_size));
            }
            let before_fingerprint = fingerprint(&before)?;
            if let Some(entry) = self.cache.lock().await.get(&path, &before_fingerprint) {
                return Ok(FileRead {
                    path: normalized,
                    content: entry.content,
                    encoding: "utf-8",
                    size: before_fingerprint.size,
                    mtime: entry.mtime,
                    etag: entry.etag,
                    cache_status: CacheStatus::Hit,
                });
            }
            let bytes = tokio::fs::read(&path).await?;
            let after = tokio::fs::metadata(&path).await?;
            let after_fingerprint = fingerprint(&after)?;
            if before_fingerprint != after_fingerprint || bytes.len() as u64 != after.len() {
                continue;
            }
            if bytes.contains(&0) {
                return Err(FileError::BinaryFile);
            }
            let content = String::from_utf8(bytes).map_err(|_| FileError::BinaryFile)?;
            let mtime = modified_millis(&after)?;
            let etag = etag(&after_fingerprint);
            let entry = CacheEntry {
                fingerprint: after_fingerprint.clone(),
                bytes: content.len(),
                content: content.clone(),
                mtime,
                etag: etag.clone(),
            };
            let cached = self.cache.lock().await.insert(path.clone(), entry);
            return Ok(FileRead {
                path: normalized,
                content,
                encoding: "utf-8",
                size: after_fingerprint.size,
                mtime,
                etag,
                cache_status: if cached {
                    CacheStatus::Miss
                } else {
                    CacheStatus::Bypass
                },
            });
        }
        Err(FileError::Io(io::Error::new(
            io::ErrorKind::Interrupted,
            "file changed repeatedly while it was being read",
        )))
    }

    pub async fn read_binary(
        &self,
        workspace_root: &Path,
        relative: &str,
    ) -> Result<BinaryRead, FileError> {
        let _permit = self
            .reads
            .acquire()
            .await
            .map_err(|error| FileError::Io(io::Error::other(error)))?;
        let normalized = normalize_relative(relative)?;
        let (_, path) = canonical_existing(workspace_root, &normalized).await?;
        let metadata = tokio::fs::metadata(&path).await?;
        if metadata.is_dir() {
            return Err(FileError::IsDirectory);
        }
        if metadata.len() > self.config.max_file_size {
            return Err(FileError::FileTooLarge(self.config.max_file_size));
        }
        let fingerprint = fingerprint(&metadata)?;
        let content = tokio::fs::read(path).await?;
        Ok(BinaryRead {
            path: normalized,
            content,
            size: fingerprint.size,
            mtime: modified_millis(&metadata)?,
            etag: etag(&fingerprint),
        })
    }

    pub async fn workspace_relative_external(
        &self,
        workspace_root: &Path,
        absolute: &Path,
    ) -> Result<String, FileError> {
        if !absolute.is_absolute() {
            return Err(FileError::InvalidPath("外部文件路径必须是绝对路径".into()));
        }
        let root = tokio::fs::canonicalize(workspace_root)
            .await
            .map_err(map_not_found)?;
        let path = tokio::fs::canonicalize(absolute)
            .await
            .map_err(map_not_found)?;
        ensure_within(&root, &path)?;
        if path == root {
            return Err(FileError::InvalidPath("只能打开当前工作区内的文件".into()));
        }
        let relative = path
            .strip_prefix(&root)
            .map_err(|_| FileError::OutsideWorkspace)?
            .to_string_lossy()
            .replace('\\', "/");
        self.read_text(&root, &relative).await?;
        Ok(relative)
    }

    pub async fn read_external(&self, absolute: &Path) -> Result<Vec<u8>, FileError> {
        if !absolute.is_absolute() {
            return Err(FileError::InvalidPath("外部文件路径必须是绝对路径".into()));
        }
        let _permit = self
            .reads
            .acquire()
            .await
            .map_err(|error| FileError::Io(io::Error::other(error)))?;
        let path = tokio::fs::canonicalize(absolute)
            .await
            .map_err(map_not_found)?;
        let metadata = tokio::fs::metadata(&path).await?;
        if !metadata.is_file() {
            return Err(FileError::NotFound);
        }
        if metadata.len() > self.config.max_file_size {
            return Err(FileError::FileTooLarge(self.config.max_file_size));
        }
        Ok(tokio::fs::read(path).await?)
    }

    pub async fn write_text(
        &self,
        workspace_root: &Path,
        relative: &str,
        content: String,
        create_parents: bool,
    ) -> Result<FileWrite, FileError> {
        self.write_bytes(
            workspace_root,
            relative,
            content.into_bytes(),
            create_parents,
        )
        .await
    }

    pub async fn write_bytes(
        &self,
        workspace_root: &Path,
        relative: &str,
        bytes: Vec<u8>,
        create_parents: bool,
    ) -> Result<FileWrite, FileError> {
        if bytes.len() as u64 > self.config.max_file_size {
            return Err(FileError::FileTooLarge(self.config.max_file_size));
        }
        let _guard = self.mutations.lock().await;
        let normalized = normalize_relative(relative)?;
        let (root, destination) =
            prepare_destination(workspace_root, &normalized, create_parents).await?;
        if destination == root {
            return Err(FileError::IsDirectory);
        }
        self.invalidate_candidates(&destination).await;
        atomic_write(destination.clone(), bytes).await?;
        let metadata = tokio::fs::metadata(&destination).await?;
        self.record_change(&root, &destination).await;
        Ok(FileWrite {
            path: normalized,
            size: metadata.len(),
            mtime: modified_millis(&metadata)?,
        })
    }

    pub async fn create_entry(
        &self,
        workspace_root: &Path,
        relative: &str,
        kind: EntryKind,
    ) -> Result<(), FileError> {
        let _guard = self.mutations.lock().await;
        let normalized = normalize_relative(relative)?;
        let (root, destination) = prepare_destination(workspace_root, &normalized, false).await?;
        if destination == root {
            return Err(FileError::EntryExists);
        }
        if tokio::fs::symlink_metadata(&destination).await.is_ok() {
            return Err(FileError::EntryExists);
        }
        match kind {
            EntryKind::Directory => tokio::fs::create_dir(&destination).await?,
            EntryKind::File => {
                tokio::fs::OpenOptions::new()
                    .create_new(true)
                    .write(true)
                    .open(&destination)
                    .await?;
            }
        }
        self.record_change(&root, &destination).await;
        Ok(())
    }

    pub async fn move_entry(
        &self,
        workspace_root: &Path,
        from: &str,
        to: &str,
    ) -> Result<(), FileError> {
        let _guard = self.mutations.lock().await;
        let from_normalized = normalize_relative(from)?;
        let to_normalized = normalize_relative(to)?;
        let (root, source) = canonical_existing(workspace_root, &from_normalized).await?;
        if source == root {
            return Err(FileError::InvalidPath("不能移动工作区根".into()));
        }
        let (_, destination) = prepare_destination(workspace_root, &to_normalized, true).await?;
        if tokio::fs::metadata(&source).await?.is_dir() && destination.starts_with(&source) {
            cleanup_created_parents(&destination, &source).await;
            return Err(FileError::InvalidPath("目录不能移动到自身内部".into()));
        }
        if tokio::fs::symlink_metadata(&destination).await.is_ok() {
            return Err(FileError::EntryExists);
        }
        self.invalidate_candidates(&source).await;
        self.invalidate_candidates(&destination).await;
        tokio::fs::rename(&source, &destination).await?;
        self.record_change(&root, &source).await;
        self.record_change(&root, &destination).await;
        Ok(())
    }

    pub async fn copy_entry(
        &self,
        workspace_root: &Path,
        from: &str,
        to: &str,
    ) -> Result<(), FileError> {
        let _guard = self.mutations.lock().await;
        let from_normalized = normalize_relative(from)?;
        let to_normalized = normalize_relative(to)?;
        let (root, source) = canonical_existing(workspace_root, &from_normalized).await?;
        let (_, destination) = prepare_destination(workspace_root, &to_normalized, true).await?;
        if tokio::fs::metadata(&source).await?.is_dir() && destination.starts_with(&source) {
            cleanup_created_parents(&destination, &source).await;
            return Err(FileError::InvalidPath("目录不能复制到自身内部".into()));
        }
        if tokio::fs::symlink_metadata(&destination).await.is_ok() {
            return Err(FileError::EntryExists);
        }
        if let Err(error) = copy_tree(&source, &destination).await {
            cleanup_partial_copy(&destination).await;
            return Err(error);
        }
        self.record_change(&root, &destination).await;
        Ok(())
    }

    pub async fn copy_external(
        &self,
        workspace_root: &Path,
        source: &Path,
        to: &str,
    ) -> Result<(), FileError> {
        if !source.is_absolute() {
            return Err(FileError::InvalidPath("外部文件路径必须是绝对路径".into()));
        }
        let _guard = self.mutations.lock().await;
        let source = tokio::fs::canonicalize(source)
            .await
            .map_err(map_not_found)?;
        let to_normalized = normalize_relative(to)?;
        let (root, destination) = prepare_destination(workspace_root, &to_normalized, true).await?;
        if tokio::fs::symlink_metadata(&destination).await.is_ok() {
            return Err(FileError::EntryExists);
        }
        if let Err(error) = copy_tree(&source, &destination).await {
            cleanup_partial_copy(&destination).await;
            return Err(error);
        }
        self.record_change(&root, &destination).await;
        Ok(())
    }

    pub async fn delete_entry(
        &self,
        workspace_root: &Path,
        relative: &str,
        recursive: bool,
    ) -> Result<(), FileError> {
        let _guard = self.mutations.lock().await;
        let normalized = normalize_relative(relative)?;
        let (root, path) = canonical_existing(workspace_root, &normalized).await?;
        if path == root {
            return Err(FileError::InvalidPath("不能删除工作区根".into()));
        }
        let metadata = tokio::fs::metadata(&path).await?;
        self.invalidate_candidates(&path).await;
        if metadata.is_dir() {
            if recursive {
                tokio::fs::remove_dir_all(&path).await?;
            } else {
                match tokio::fs::remove_dir(&path).await {
                    Ok(()) => {}
                    Err(error) if is_directory_not_empty(&error) => {
                        return Err(FileError::DirectoryNotEmpty);
                    }
                    Err(error) => return Err(error.into()),
                }
            }
        } else {
            tokio::fs::remove_file(&path).await?;
        }
        self.record_change(&root, &path).await;
        Ok(())
    }

    async fn invalidate_candidates(&self, path: &Path) {
        self.cache.lock().await.invalidate(path);
        let canonical = tokio::fs::canonicalize(path).await.ok();
        if let Some(canonical) = canonical {
            let mut cache = self.cache.lock().await;
            cache.invalidate(&canonical);
        }
    }

    #[cfg(target_os = "windows")]
    fn ensure_watched(&self, root: &Path, _directory: &Path) {
        let root = root.to_owned();
        {
            let mut roots = self
                .watched_roots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !roots.insert(root.clone()) {
                return;
            }
        }
        let cache = self.cache.clone();
        let changes = self.changes.clone();
        let events = self.watcher_events.clone();
        let watched_roots = self.watched_roots.clone();
        let cleanup_root = root.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        let spawn = std::thread::Builder::new()
            .name("osheep-file-watch".into())
            .spawn(move || {
                watch_windows_directory(&root, cache, changes, events, ready_tx);
                watched_roots
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .remove(&root);
            });
        if spawn.is_err()
            || !ready_rx
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap_or(false)
        {
            self.watched_roots
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&cleanup_root);
        }
    }

    #[cfg(target_os = "linux")]
    fn ensure_watched(&self, root: &Path, directory: &Path) {
        if let Some(watcher) = &self.linux_watcher {
            watcher.watch(root, directory);
        }
    }

    #[cfg(not(any(target_os = "linux", target_os = "windows")))]
    fn ensure_watched(&self, _root: &Path, _directory: &Path) {}
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct LinuxWatcher {
    registrations: std::sync::mpsc::SyncSender<LinuxWatchRequest>,
    watched_directories: Arc<std::sync::Mutex<HashSet<PathBuf>>>,
    wake: std::os::unix::net::UnixDatagram,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct LinuxWatchRequest {
    root: PathBuf,
    directory: PathBuf,
    ready: std::sync::mpsc::SyncSender<bool>,
}

#[cfg(target_os = "linux")]
#[derive(Debug)]
struct LinuxWatchedDirectory {
    root: PathBuf,
    directory: PathBuf,
}

#[cfg(target_os = "linux")]
impl LinuxWatcher {
    fn start(
        cache: Arc<Mutex<TextCache>>,
        changes: Arc<std::sync::Mutex<FileChangeJournal>>,
        events: Arc<AtomicU64>,
    ) -> Option<Arc<Self>> {
        let (wake, worker_wake) = std::os::unix::net::UnixDatagram::pair().ok()?;
        wake.set_nonblocking(true).ok()?;
        worker_wake.set_nonblocking(true).ok()?;
        let (registrations, receiver) = std::sync::mpsc::sync_channel(256);
        let watched_directories = Arc::new(std::sync::Mutex::new(HashSet::new()));
        let worker_directories = watched_directories.clone();
        let (ready_tx, ready_rx) = std::sync::mpsc::sync_channel(1);
        std::thread::Builder::new()
            .name("osheep-file-watch".into())
            .spawn(move || {
                watch_linux_directories(
                    cache,
                    changes,
                    events,
                    receiver,
                    worker_directories,
                    worker_wake,
                    ready_tx,
                );
            })
            .ok()?;
        if !ready_rx
            .recv_timeout(std::time::Duration::from_secs(1))
            .unwrap_or(false)
        {
            return None;
        }
        Some(Arc::new(Self {
            registrations,
            watched_directories,
            wake,
        }))
    }

    fn watch(&self, root: &Path, directory: &Path) {
        let directory = directory.to_owned();
        {
            let mut watched = self
                .watched_directories
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            if !watched.insert(directory.clone()) {
                return;
            }
        }
        let (ready, result) = std::sync::mpsc::sync_channel(1);
        let request = LinuxWatchRequest {
            root: root.to_owned(),
            directory: directory.clone(),
            ready,
        };
        let queued = self.registrations.send(request).is_ok();
        if queued {
            let _ = self.wake.send(&[1]);
        }
        let registered = queued
            && result
                .recv_timeout(std::time::Duration::from_secs(1))
                .unwrap_or(false);
        if !registered {
            self.watched_directories
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&directory);
        }
    }
}

#[cfg(target_os = "linux")]
fn watch_linux_directories(
    cache: Arc<Mutex<TextCache>>,
    changes: Arc<std::sync::Mutex<FileChangeJournal>>,
    events: Arc<AtomicU64>,
    registrations: std::sync::mpsc::Receiver<LinuxWatchRequest>,
    watched_directories: Arc<std::sync::Mutex<HashSet<PathBuf>>>,
    wake: std::os::unix::net::UnixDatagram,
    ready: std::sync::mpsc::SyncSender<bool>,
) {
    use std::ffi::{CString, OsStr};
    use std::os::fd::{AsRawFd, RawFd};
    use std::os::unix::ffi::OsStrExt;
    use std::sync::mpsc::TryRecvError;

    struct InotifyFileDescriptor(RawFd);
    impl Drop for InotifyFileDescriptor {
        fn drop(&mut self) {
            unsafe {
                libc::close(self.0);
            }
        }
    }

    let descriptor = unsafe { libc::inotify_init1(libc::IN_CLOEXEC | libc::IN_NONBLOCK) };
    if descriptor < 0 {
        let _ = ready.send(false);
        return;
    }
    let descriptor = InotifyFileDescriptor(descriptor);
    let _ = ready.send(true);
    let mut watches = HashMap::<i32, LinuxWatchedDirectory>::new();
    let mut buffer = vec![0_u8; 64 * 1024];
    let mask = libc::IN_ATTRIB
        | libc::IN_CLOSE_WRITE
        | libc::IN_CREATE
        | libc::IN_DELETE
        | libc::IN_DELETE_SELF
        | libc::IN_MODIFY
        | libc::IN_MOVE_SELF
        | libc::IN_MOVED_FROM
        | libc::IN_MOVED_TO;

    loop {
        loop {
            match registrations.try_recv() {
                Ok(request) => {
                    let path = CString::new(request.directory.as_os_str().as_bytes());
                    let watch = path.ok().map_or(-1, |path| unsafe {
                        libc::inotify_add_watch(descriptor.0, path.as_ptr(), mask)
                    });
                    if watch >= 0 {
                        watches.insert(
                            watch,
                            LinuxWatchedDirectory {
                                root: request.root,
                                directory: request.directory,
                            },
                        );
                        let _ = request.ready.send(true);
                    } else {
                        watched_directories
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner())
                            .remove(&request.directory);
                        let _ = request.ready.send(false);
                    }
                }
                Err(TryRecvError::Empty) => break,
                Err(TryRecvError::Disconnected) => return,
            }
        }

        let mut poll_descriptors = [
            libc::pollfd {
                fd: descriptor.0,
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: wake.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        let poll_result = unsafe {
            libc::poll(
                poll_descriptors.as_mut_ptr(),
                poll_descriptors.len() as libc::nfds_t,
                100,
            )
        };
        if poll_result < 0 {
            if std::io::Error::last_os_error().raw_os_error() == Some(libc::EINTR) {
                continue;
            }
            return;
        }
        if poll_descriptors
            .iter()
            .any(|descriptor| descriptor.revents & (libc::POLLERR | libc::POLLNVAL) != 0)
            || poll_descriptors[1].revents & libc::POLLHUP != 0
        {
            return;
        }
        if poll_descriptors[1].revents & libc::POLLIN != 0 {
            let mut wake_buffer = [0_u8; 64];
            while wake.recv(&mut wake_buffer).is_ok() {}
        }
        if poll_result == 0 || poll_descriptors[0].revents & libc::POLLIN == 0 {
            continue;
        }
        let read = unsafe { libc::read(descriptor.0, buffer.as_mut_ptr().cast(), buffer.len()) };
        if read < 0 {
            let error = std::io::Error::last_os_error().raw_os_error();
            if matches!(error, Some(libc::EAGAIN) | Some(libc::EINTR)) {
                continue;
            }
            return;
        }

        let mut offset = 0_usize;
        let read = read as usize;
        while offset + std::mem::size_of::<libc::inotify_event>() <= read {
            let event = unsafe {
                std::ptr::read_unaligned(buffer.as_ptr().add(offset).cast::<libc::inotify_event>())
            };
            let name_offset = offset + std::mem::size_of::<libc::inotify_event>();
            let record_end = name_offset.saturating_add(event.len as usize);
            if record_end > read {
                invalidate_linux_roots(&cache, &watches);
                record_linux_roots(&changes, &watches);
                events.fetch_add(1, Ordering::Relaxed);
                break;
            }
            if event.mask & libc::IN_Q_OVERFLOW != 0 {
                invalidate_linux_roots(&cache, &watches);
                record_linux_roots(&changes, &watches);
                events.fetch_add(1, Ordering::Relaxed);
                offset = record_end;
                continue;
            }
            if let Some(watched) = watches.get(&event.wd) {
                let name = buffer[name_offset..record_end]
                    .split(|byte| *byte == 0)
                    .next()
                    .unwrap_or_default();
                let path = if name.is_empty() {
                    watched.directory.clone()
                } else {
                    watched.directory.join(OsStr::from_bytes(name))
                };
                cache.blocking_lock().invalidate(&path);
                changes
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .record(&watched.root, &path);
                events.fetch_add(1, Ordering::Relaxed);
            }
            if event.mask & (libc::IN_DELETE_SELF | libc::IN_MOVE_SELF | libc::IN_IGNORED) != 0 {
                if event.mask & libc::IN_IGNORED == 0 {
                    unsafe {
                        libc::inotify_rm_watch(descriptor.0, event.wd);
                    }
                }
                if let Some(watched) = watches.remove(&event.wd) {
                    watched_directories
                        .lock()
                        .unwrap_or_else(|poisoned| poisoned.into_inner())
                        .remove(&watched.directory);
                }
            }
            offset = record_end;
        }
    }
}

#[cfg(target_os = "linux")]
fn invalidate_linux_roots(cache: &Mutex<TextCache>, watches: &HashMap<i32, LinuxWatchedDirectory>) {
    let roots = watches
        .values()
        .map(|watched| &watched.root)
        .collect::<HashSet<_>>();
    let mut cache = cache.blocking_lock();
    for root in roots {
        cache.invalidate(root);
    }
}

#[cfg(target_os = "linux")]
fn record_linux_roots(
    changes: &std::sync::Mutex<FileChangeJournal>,
    watches: &HashMap<i32, LinuxWatchedDirectory>,
) {
    let roots = watches
        .values()
        .map(|watched| &watched.root)
        .collect::<HashSet<_>>();
    let mut changes = changes
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    for root in roots {
        changes.record(root, root);
    }
}

#[cfg(target_os = "windows")]
fn watch_windows_directory(
    root: &Path,
    cache: Arc<Mutex<TextCache>>,
    changes: Arc<std::sync::Mutex<FileChangeJournal>>,
    events: Arc<AtomicU64>,
    ready: std::sync::mpsc::SyncSender<bool>,
) {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};
    use windows_sys::Win32::Foundation::{CloseHandle, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::Storage::FileSystem::{
        CreateFileW, ReadDirectoryChangesW, FILE_FLAG_BACKUP_SEMANTICS, FILE_LIST_DIRECTORY,
        FILE_NOTIFY_CHANGE_ATTRIBUTES, FILE_NOTIFY_CHANGE_CREATION, FILE_NOTIFY_CHANGE_DIR_NAME,
        FILE_NOTIFY_CHANGE_FILE_NAME, FILE_NOTIFY_CHANGE_LAST_WRITE, FILE_NOTIFY_CHANGE_SIZE,
        FILE_NOTIFY_INFORMATION, FILE_SHARE_DELETE, FILE_SHARE_READ, FILE_SHARE_WRITE,
        OPEN_EXISTING,
    };

    let wide = root
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let handle = unsafe {
        CreateFileW(
            wide.as_ptr(),
            FILE_LIST_DIRECTORY,
            FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
            std::ptr::null(),
            OPEN_EXISTING,
            FILE_FLAG_BACKUP_SEMANTICS,
            std::ptr::null_mut(),
        )
    };
    if handle == INVALID_HANDLE_VALUE {
        let _ = ready.send(false);
        return;
    }
    struct DirectoryHandle(windows_sys::Win32::Foundation::HANDLE);
    impl Drop for DirectoryHandle {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
    let handle = DirectoryHandle(handle);
    let _ = ready.send(true);
    let mut buffer = vec![0_u8; 64 * 1024];
    let filter = FILE_NOTIFY_CHANGE_FILE_NAME
        | FILE_NOTIFY_CHANGE_DIR_NAME
        | FILE_NOTIFY_CHANGE_ATTRIBUTES
        | FILE_NOTIFY_CHANGE_SIZE
        | FILE_NOTIFY_CHANGE_LAST_WRITE
        | FILE_NOTIFY_CHANGE_CREATION;
    loop {
        let mut returned = 0_u32;
        let result = unsafe {
            ReadDirectoryChangesW(
                handle.0,
                buffer.as_mut_ptr().cast(),
                buffer.len() as u32,
                1,
                filter,
                &mut returned,
                std::ptr::null_mut(),
                None,
            )
        };
        if result == 0 {
            break;
        }
        if returned == 0 {
            cache.blocking_lock().invalidate(root);
            changes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .record(root, root);
            events.fetch_add(1, Ordering::Relaxed);
            continue;
        }
        let mut offset = 0_usize;
        while offset + std::mem::size_of::<FILE_NOTIFY_INFORMATION>() <= returned as usize {
            let information = unsafe {
                std::ptr::read_unaligned(
                    buffer
                        .as_ptr()
                        .add(offset)
                        .cast::<FILE_NOTIFY_INFORMATION>(),
                )
            };
            let name_offset = offset + std::mem::offset_of!(FILE_NOTIFY_INFORMATION, FileName);
            let name_end = name_offset + information.FileNameLength as usize;
            if name_end > returned as usize || information.FileNameLength % 2 != 0 {
                cache.blocking_lock().invalidate(root);
                changes
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .record(root, root);
                events.fetch_add(1, Ordering::Relaxed);
                break;
            }
            let name = buffer[name_offset..name_end]
                .chunks_exact(2)
                .map(|bytes| u16::from_le_bytes([bytes[0], bytes[1]]))
                .collect::<Vec<_>>();
            let path = root.join(std::ffi::OsString::from_wide(&name));
            cache.blocking_lock().invalidate(&path);
            changes
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .record(root, &path);
            events.fetch_add(1, Ordering::Relaxed);
            if information.NextEntryOffset == 0 {
                break;
            }
            offset += information.NextEntryOffset as usize;
        }
    }
}

fn normalize_relative(relative: &str) -> Result<String, FileError> {
    if relative.contains('\0') {
        return Err(FileError::InvalidPath("路径包含 NUL".into()));
    }
    let unified = relative.replace('\\', "/");
    let unified = unified.trim();
    if unified.is_empty() || unified == "." {
        return Ok(String::new());
    }
    if unified.starts_with('/')
        || (unified.len() >= 2
            && unified.as_bytes()[0].is_ascii_alphabetic()
            && unified.as_bytes()[1] == b':')
    {
        return Err(FileError::InvalidPath("不允许绝对路径".into()));
    }
    let mut segments = Vec::new();
    for segment in unified.split('/').filter(|segment| !segment.is_empty()) {
        match segment {
            ".." => return Err(FileError::OutsideWorkspace),
            "." => {}
            value => segments.push(value),
        }
    }
    Ok(segments.join("/"))
}

async fn canonical_existing(
    workspace_root: &Path,
    relative: &str,
) -> Result<(PathBuf, PathBuf), FileError> {
    let root = tokio::fs::canonicalize(workspace_root)
        .await
        .map_err(map_not_found)?;
    let candidate = lexical_candidate(&root, relative);
    let path = tokio::fs::canonicalize(candidate)
        .await
        .map_err(map_not_found)?;
    ensure_within(&root, &path)?;
    Ok((root, path))
}

async fn prepare_destination(
    workspace_root: &Path,
    relative: &str,
    create_parents: bool,
) -> Result<(PathBuf, PathBuf), FileError> {
    let root = tokio::fs::canonicalize(workspace_root)
        .await
        .map_err(map_not_found)?;
    let destination = lexical_candidate(&root, relative);
    ensure_within(&root, &destination)?;
    if let Ok(canonical) = tokio::fs::canonicalize(&destination).await {
        ensure_within(&root, &canonical)?;
    }
    let parent = destination
        .parent()
        .ok_or_else(|| FileError::InvalidPath("目标路径没有父目录".into()))?;
    if create_parents {
        let ancestor = nearest_existing(parent).await?;
        let ancestor = tokio::fs::canonicalize(ancestor).await?;
        ensure_within(&root, &ancestor)?;
        tokio::fs::create_dir_all(parent).await?;
    }
    let parent_metadata = tokio::fs::metadata(parent).await.map_err(|error| {
        if error.kind() == io::ErrorKind::NotFound {
            FileError::ParentNotFound
        } else {
            FileError::Io(error)
        }
    })?;
    if !parent_metadata.is_dir() {
        return Err(FileError::ParentNotFound);
    }
    let canonical_parent = tokio::fs::canonicalize(parent).await?;
    ensure_within(&root, &canonical_parent)?;
    Ok((root, destination))
}

async fn nearest_existing(path: &Path) -> Result<PathBuf, FileError> {
    let mut candidate = path.to_owned();
    loop {
        match tokio::fs::symlink_metadata(&candidate).await {
            Ok(_) => return Ok(candidate),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !candidate.pop() {
                    return Err(FileError::ParentNotFound);
                }
            }
            Err(error) => return Err(error.into()),
        }
    }
}

fn lexical_candidate(root: &Path, relative: &str) -> PathBuf {
    relative
        .split('/')
        .filter(|segment| !segment.is_empty())
        .fold(root.to_owned(), |path, segment| path.join(segment))
}

fn ensure_within(root: &Path, path: &Path) -> Result<(), FileError> {
    if path == root || path.starts_with(root) {
        Ok(())
    } else {
        Err(FileError::OutsideWorkspace)
    }
}

fn map_not_found(error: io::Error) -> FileError {
    if error.kind() == io::ErrorKind::NotFound {
        FileError::NotFound
    } else {
        FileError::Io(error)
    }
}

fn fingerprint(metadata: &fs::Metadata) -> Result<FileFingerprint, FileError> {
    Ok(FileFingerprint {
        size: metadata.len(),
        modified_nanos: metadata
            .modified()?
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
    })
}

fn modified_millis(metadata: &fs::Metadata) -> Result<f64, FileError> {
    Ok(metadata
        .modified()?
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0)
}

fn etag(fingerprint: &FileFingerprint) -> String {
    format!(
        "W/\"{:x}-{:x}\"",
        fingerprint.size, fingerprint.modified_nanos
    )
}

async fn atomic_write(path: PathBuf, contents: Vec<u8>) -> Result<(), FileError> {
    tokio::task::spawn_blocking(move || atomic_write_blocking(&path, &contents))
        .await
        .map_err(|error| FileError::Join(error.to_string()))??;
    Ok(())
}

fn atomic_write_blocking(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "file path has no parent directory",
        )
    })?;
    let temporary = parent.join(format!(
        ".osheep-file-{}-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        WRITE_SEQUENCE.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        replace_file(&temporary, path)?;
        #[cfg(unix)]
        fs::File::open(parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

async fn copy_tree(source: &Path, destination: &Path) -> Result<(), FileError> {
    let metadata = tokio::fs::symlink_metadata(source).await?;
    if metadata.file_type().is_symlink() {
        return Err(FileError::InvalidPath("不支持复制符号链接".into()));
    }
    if metadata.is_file() {
        tokio::fs::copy(source, destination).await?;
        return Ok(());
    }
    tokio::fs::create_dir(destination).await?;
    let mut pending = VecDeque::from([(source.to_owned(), destination.to_owned())]);
    while let Some((source_dir, destination_dir)) = pending.pop_front() {
        let mut entries = tokio::fs::read_dir(source_dir).await?;
        while let Some(entry) = entries.next_entry().await? {
            let source_path = entry.path();
            let destination_path = destination_dir.join(entry.file_name());
            let metadata = tokio::fs::symlink_metadata(&source_path).await?;
            if metadata.file_type().is_symlink() {
                return Err(FileError::InvalidPath(
                    "不支持复制包含符号链接的目录".into(),
                ));
            }
            if metadata.is_dir() {
                tokio::fs::create_dir(&destination_path).await?;
                pending.push_back((source_path, destination_path));
            } else {
                tokio::fs::copy(source_path, destination_path).await?;
            }
        }
    }
    Ok(())
}

async fn cleanup_partial_copy(path: &Path) {
    let Ok(metadata) = tokio::fs::symlink_metadata(path).await else {
        return;
    };
    if metadata.is_dir() {
        let _ = tokio::fs::remove_dir_all(path).await;
    } else {
        let _ = tokio::fs::remove_file(path).await;
    }
}

async fn cleanup_created_parents(destination: &Path, stop_at: &Path) {
    let mut current = destination.parent();
    while let Some(path) = current {
        if path == stop_at {
            break;
        }
        match tokio::fs::remove_dir(path).await {
            Ok(()) => current = path.parent(),
            Err(_) => break,
        }
    }
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    if !destination.exists() {
        return fs::rename(source, destination);
    }
    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn is_directory_not_empty(error: &io::Error) -> bool {
    error.kind() == io::ErrorKind::DirectoryNotEmpty
        || matches!(error.raw_os_error(), Some(39 | 145))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "osheep-files-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time after Unix epoch")
                .as_nanos()
        ))
    }

    fn service(max_file_size: u64) -> FileService {
        FileService::new(FileServiceConfig {
            max_file_size,
            cache_max_entries: 2,
            cache_max_bytes: 128,
            cache_file_max_bytes: 64,
            ..FileServiceConfig::default()
        })
    }

    #[tokio::test]
    async fn shallow_tree_ignores_build_directories_and_metadata_is_opt_in() {
        let root = temp_root("tree");
        tokio::fs::create_dir_all(root.join("node_modules/nested"))
            .await
            .expect("create ignored directory");
        tokio::fs::create_dir_all(root.join("src/nested"))
            .await
            .expect("create source directory");
        tokio::fs::write(root.join("note.txt"), b"hello")
            .await
            .expect("write note");
        let files = service(1024);

        let basic = files
            .list_tree(&root, "", false, false)
            .await
            .expect("list basic tree");
        assert_eq!(basic.len(), 2);
        assert_eq!(basic[0].name, "src");
        assert!(basic[0].size.is_none());
        assert_eq!(basic[1].name, "note.txt");
        assert!(basic[1].size.is_none());

        let detailed = files
            .list_tree(&root, "", false, true)
            .await
            .expect("list detailed tree");
        assert_eq!(detailed[1].size, Some(5));
        assert!(detailed[1].mtime.is_some());
        assert!(!detailed.iter().any(|entry| entry.path.contains("nested")));
        tokio::fs::remove_dir_all(root).await.expect("remove root");
    }

    #[tokio::test]
    async fn text_cache_hits_and_mutations_invalidate_the_entry() {
        let root = temp_root("cache");
        tokio::fs::create_dir_all(&root).await.expect("create root");
        tokio::fs::write(root.join("note.txt"), b"first")
            .await
            .expect("write note");
        let files = service(1024);

        let first = files
            .read_text(&root, "note.txt")
            .await
            .expect("first read");
        let second = files
            .read_text(&root, "note.txt")
            .await
            .expect("second read");
        assert_eq!(first.cache_status, CacheStatus::Miss);
        assert_eq!(second.cache_status, CacheStatus::Hit);
        assert_eq!(first.etag, second.etag);

        files
            .write_text(&root, "note.txt", "second value".into(), false)
            .await
            .expect("replace note");
        let replaced = files
            .read_text(&root, "note.txt")
            .await
            .expect("read replacement");
        assert_eq!(replaced.content, "second value");
        assert_eq!(replaced.cache_status, CacheStatus::Miss);
        assert_ne!(replaced.etag, first.etag);
        tokio::fs::remove_dir_all(root).await.expect("remove root");
    }

    #[tokio::test]
    async fn text_reads_reject_binary_invalid_utf8_and_oversized_files() {
        let root = temp_root("text-boundaries");
        tokio::fs::create_dir_all(&root).await.expect("create root");
        tokio::fs::write(root.join("nul.bin"), [b'a', 0, b'b'])
            .await
            .expect("write NUL file");
        tokio::fs::write(root.join("invalid.txt"), [0xff, 0xfe])
            .await
            .expect("write invalid UTF-8");
        tokio::fs::write(root.join("large.txt"), b"12345")
            .await
            .expect("write large file");
        let files = service(4);

        assert!(matches!(
            files.read_text(&root, "nul.bin").await,
            Err(FileError::BinaryFile)
        ));
        assert!(matches!(
            files.read_text(&root, "invalid.txt").await,
            Err(FileError::BinaryFile)
        ));
        assert!(matches!(
            files.read_text(&root, "large.txt").await,
            Err(FileError::FileTooLarge(4))
        ));
        tokio::fs::remove_dir_all(root).await.expect("remove root");
    }

    #[tokio::test]
    async fn mutations_enforce_workspace_boundaries_and_root_protection() {
        let root = temp_root("boundaries");
        tokio::fs::create_dir_all(&root).await.expect("create root");
        tokio::fs::write(root.join("note.txt"), b"note")
            .await
            .expect("write note");
        let files = service(1024);

        assert!(matches!(
            files.read_text(&root, "../outside.txt").await,
            Err(FileError::OutsideWorkspace)
        ));
        assert!(matches!(
            files.delete_entry(&root, "", true).await,
            Err(FileError::InvalidPath(_))
        ));
        files
            .create_entry(&root, "folder", EntryKind::Directory)
            .await
            .expect("create folder");
        files
            .move_entry(&root, "note.txt", "folder/moved.txt")
            .await
            .expect("move note");
        files
            .copy_entry(&root, "folder/moved.txt", "copied.txt")
            .await
            .expect("copy note");
        assert_eq!(
            tokio::fs::read(root.join("copied.txt"))
                .await
                .expect("read copy"),
            b"note"
        );
        files
            .delete_entry(&root, "folder", true)
            .await
            .expect("delete folder");
        tokio::fs::remove_dir_all(root).await.expect("remove root");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_symlinks_cannot_escape_the_workspace() {
        use std::os::unix::fs::symlink;

        let root = temp_root("unix-symlink-root");
        let outside = temp_root("unix-symlink-outside");
        tokio::fs::create_dir_all(&root).await.expect("create root");
        tokio::fs::create_dir_all(&outside)
            .await
            .expect("create outside root");
        tokio::fs::write(outside.join("secret.txt"), b"secret")
            .await
            .expect("write outside file");
        symlink(outside.join("secret.txt"), root.join("outside-file")).expect("link outside file");
        symlink(&outside, root.join("outside-directory")).expect("link outside directory");
        let files = service(1024);

        assert!(matches!(
            files.read_text(&root, "outside-file").await,
            Err(FileError::OutsideWorkspace)
        ));
        assert!(matches!(
            files
                .write_text(&root, "outside-directory/new.txt", "blocked".into(), false,)
                .await,
            Err(FileError::OutsideWorkspace)
        ));

        tokio::fs::remove_dir_all(root).await.expect("remove root");
        tokio::fs::remove_dir_all(outside)
            .await
            .expect("remove outside root");
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn unix_workspace_paths_remain_case_sensitive() {
        let root = temp_root("unix-path-case");
        tokio::fs::create_dir_all(&root).await.expect("create root");
        tokio::fs::write(root.join("Note.txt"), b"note")
            .await
            .expect("write note");
        let files = service(1024);

        assert_eq!(
            files
                .read_text(&root, "Note.txt")
                .await
                .expect("read exact case")
                .content,
            "note"
        );
        assert!(matches!(
            files.read_text(&root, "note.txt").await,
            Err(FileError::NotFound)
        ));

        tokio::fs::remove_dir_all(root).await.expect("remove root");
    }

    #[tokio::test]
    async fn directory_copy_and_move_reject_targets_inside_the_source() {
        let root = temp_root("self-copy");
        tokio::fs::create_dir_all(root.join("folder"))
            .await
            .expect("create source directory");
        tokio::fs::write(root.join("folder/note.txt"), b"note")
            .await
            .expect("write source file");
        let files = service(1024);

        assert!(matches!(
            files.copy_entry(&root, "folder", "folder/copy").await,
            Err(FileError::InvalidPath(_))
        ));
        assert!(matches!(
            files.move_entry(&root, "folder", "folder/moved").await,
            Err(FileError::InvalidPath(_))
        ));
        assert!(!root.join("folder/copy").exists());
        assert!(!root.join("folder/moved").exists());
        tokio::fs::remove_dir_all(root).await.expect("remove root");
    }

    #[cfg(any(target_os = "linux", target_os = "windows"))]
    #[tokio::test]
    async fn platform_directory_events_actively_invalidate_cached_files() {
        let root = temp_root("watcher");
        tokio::fs::create_dir_all(root.join("nested"))
            .await
            .expect("create nested root");
        tokio::fs::write(root.join("nested/note.txt"), b"first")
            .await
            .expect("write initial file");
        let files = service(1024);
        files
            .read_text(&root, "nested/note.txt")
            .await
            .expect("prime cache");
        let before = files.watcher_events.load(Ordering::Acquire);

        tokio::fs::write(root.join("nested/note.txt"), b"other")
            .await
            .expect("modify file outside FileService");
        let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(2);
        while files.watcher_events.load(Ordering::Acquire) == before
            && tokio::time::Instant::now() < deadline
        {
            tokio::time::sleep(std::time::Duration::from_millis(10)).await;
        }
        assert!(files.watcher_events.load(Ordering::Acquire) > before);
        let changed = files
            .read_text(&root, "nested/note.txt")
            .await
            .expect("read externally changed file");
        assert_eq!(changed.content, "other");
        assert_eq!(changed.cache_status, CacheStatus::Miss);
        tokio::fs::remove_dir_all(root).await.expect("remove root");
    }
}
