use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::fs::{self, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::Mutex;

static TEMP_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum StateError {
    #[error("state I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("state JSON encoding failed: {0}")]
    Json(#[from] serde_json::Error),
    #[error("state write task failed: {0}")]
    Join(String),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct OpenedProject {
    pub name: String,
    pub path: PathBuf,
    pub opened_at: u64,
}

#[derive(Debug, Clone)]
pub struct StateStore {
    root: PathBuf,
    writes: Arc<Mutex<()>>,
}

impl StateStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self {
            root: root.into(),
            writes: Arc::new(Mutex::new(())),
        }
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn templates_root(&self) -> PathBuf {
        self.root.join("templates")
    }

    pub async fn initialize(&self) -> Result<(), StateError> {
        tokio::fs::create_dir_all(self.templates_root()).await?;
        Ok(())
    }

    pub async fn settings(&self, fallback: Value) -> Result<Value, StateError> {
        read_json_or(&self.root.join("settings.json"), fallback).await
    }

    pub async fn merge_settings(&self, patch: &Value) -> Result<(), StateError> {
        let _guard = self.writes.lock().await;
        let path = self.root.join("settings.json");
        let mut settings = read_json_or(&path, Value::Object(Map::new())).await?;
        if !settings.is_object() {
            settings = Value::Object(Map::new());
        }
        if let Some(patch) = patch.as_object() {
            settings
                .as_object_mut()
                .expect("settings normalized to object")
                .extend(patch.clone());
        }
        atomic_write_json(path, settings).await
    }

    pub async fn ui_preferences(&self, fallback: Value) -> Result<Value, StateError> {
        let settings = self.settings(Value::Object(Map::new())).await?;
        Ok(settings
            .get("ui")
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or(fallback))
    }

    pub async fn set_ui_preferences(&self, value: Value) -> Result<(), StateError> {
        let mut patch = Map::new();
        patch.insert("ui".into(), value);
        self.merge_settings(&Value::Object(patch)).await
    }

    pub async fn dismissed_confirmations(&self) -> Result<Vec<String>, StateError> {
        let settings = self.settings(Value::Object(Map::new())).await?;
        Ok(settings
            .get("uiState")
            .and_then(Value::as_object)
            .and_then(|state| state.get("dismissedConfirmations"))
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect())
    }

    pub async fn set_dismissed_confirmations(&self, values: Vec<String>) -> Result<(), StateError> {
        let _guard = self.writes.lock().await;
        let path = self.root.join("settings.json");
        let mut settings = read_json_or(&path, Value::Object(Map::new())).await?;
        if !settings.is_object() {
            settings = Value::Object(Map::new());
        }
        let settings = settings
            .as_object_mut()
            .expect("settings normalized to object");
        let ui_state = settings
            .entry("uiState")
            .or_insert_with(|| Value::Object(Map::new()));
        if !ui_state.is_object() {
            *ui_state = Value::Object(Map::new());
        }
        ui_state
            .as_object_mut()
            .expect("uiState normalized to object")
            .insert(
                "dismissedConfirmations".into(),
                Value::Array(values.into_iter().map(Value::String).collect()),
            );
        atomic_write_json(path, Value::Object(settings.clone())).await
    }

    pub async fn write_workspace_root(&self, root: &Path) -> Result<(), StateError> {
        let _guard = self.writes.lock().await;
        atomic_write_json(
            self.root.join("workspace-root.json"),
            serde_json::json!({ "root": root }),
        )
        .await
    }

    pub async fn record_opened_project(
        &self,
        name: &str,
        project_path: &Path,
    ) -> Result<(), StateError> {
        let _guard = self.writes.lock().await;
        let path = self.root.join("opened-projects.json");
        let mut projects = parse_opened_projects(read_json_or(&path, Value::Null).await?);
        let key = path_key(project_path);
        if projects
            .iter()
            .any(|project| path_key(&project.path) == key)
        {
            return Ok(());
        }
        projects.push(OpenedProject {
            name: name.to_owned(),
            path: project_path.to_owned(),
            opened_at: SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64,
        });
        atomic_write_json(path, serde_json::json!({ "projects": projects })).await
    }
}

fn parse_opened_projects(value: Value) -> Vec<OpenedProject> {
    let mut projects = Vec::new();
    let Some(values) = value.get("projects").and_then(Value::as_array) else {
        return projects;
    };
    for value in values {
        let Some(path) = value.get("path").and_then(Value::as_str).map(PathBuf::from) else {
            continue;
        };
        if !path.is_absolute() {
            continue;
        }
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|name| !name.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                path.file_name()
                    .map(|name| name.to_string_lossy().into_owned())
            })
            .unwrap_or_default();
        let opened_at = value
            .get("openedAt")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let project = OpenedProject {
            name,
            path,
            opened_at,
        };
        if let Some(index) = projects.iter().position(|existing: &OpenedProject| {
            path_key(&existing.path) == path_key(&project.path)
        }) {
            projects[index] = project;
        } else {
            projects.push(project);
        }
    }
    projects.sort_by_key(|project| std::cmp::Reverse(project.opened_at));
    projects
}

fn path_key(path: &Path) -> String {
    let key = path.to_string_lossy().into_owned();
    if cfg!(windows) {
        key.to_lowercase()
    } else {
        key
    }
}

async fn read_json_or(path: &Path, fallback: Value) -> Result<Value, StateError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes).unwrap_or(fallback)),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(fallback),
        Err(error) => Err(error.into()),
    }
}

async fn atomic_write_json(path: PathBuf, value: Value) -> Result<(), StateError> {
    let mut bytes = serde_json::to_vec_pretty(&value)?;
    bytes.push(b'\n');
    tokio::task::spawn_blocking(move || atomic_write(&path, &bytes))
        .await
        .map_err(|error| StateError::Join(error.to_string()))??;
    Ok(())
}

fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "state file has no parent directory",
        )
    })?;
    fs::create_dir_all(parent)?;
    let sequence = TEMP_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    let temporary = parent.join(format!(
        ".osheep-state-{}-{}-{}.tmp",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos(),
        sequence
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
        let _ = fs::remove_file(&temporary);
    }
    result
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

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_root(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "osheep-core-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time after Unix epoch")
                .as_nanos()
        ))
    }

    #[tokio::test]
    async fn concurrent_setting_updates_are_serialized_and_atomic() {
        let root = temp_root("settings");
        let store = StateStore::new(&root);
        let mut updates = Vec::new();
        for index in 0..24 {
            let store = store.clone();
            updates.push(tokio::spawn(async move {
                store
                    .merge_settings(&serde_json::json!({ format!("key{index}"): index }))
                    .await
                    .expect("merge setting");
            }));
        }
        for update in updates {
            update.await.expect("join setting update");
        }

        let settings: Value = serde_json::from_slice(
            &tokio::fs::read(root.join("settings.json"))
                .await
                .expect("read settings"),
        )
        .expect("valid settings JSON");
        for index in 0..24 {
            assert_eq!(settings[format!("key{index}")], index);
        }
        let entries = fs::read_dir(&root)
            .expect("read state root")
            .collect::<Result<Vec<_>, _>>()
            .expect("valid state entries");
        assert!(entries
            .iter()
            .all(|entry| !entry.file_name().to_string_lossy().contains(".tmp")));
        fs::remove_dir_all(root).expect("remove test root");
    }

    #[tokio::test]
    async fn opened_projects_are_deduplicated_in_the_shared_store() {
        let root = temp_root("opened-projects");
        let project = root.join("workspaces/demo");
        let store = StateStore::new(&root);
        store
            .record_opened_project("demo", &project)
            .await
            .expect("record project");
        store
            .record_opened_project("renamed", &project)
            .await
            .expect("record duplicate project");

        let value: Value = serde_json::from_slice(
            &tokio::fs::read(root.join("opened-projects.json"))
                .await
                .expect("read opened projects"),
        )
        .expect("valid opened projects JSON");
        assert_eq!(value["projects"].as_array().unwrap().len(), 1);
        assert_eq!(value["projects"][0]["name"], "demo");
        fs::remove_dir_all(root).expect("remove test root");
    }
}
