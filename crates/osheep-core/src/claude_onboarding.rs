use serde_json::{Map, Value};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone, serde::Serialize, serde::Deserialize, PartialEq, Eq)]
pub struct ClaudeOnboardingStatus {
    pub enabled: bool,
    pub path: PathBuf,
}

#[derive(Debug, Error)]
pub enum ClaudeOnboardingError {
    #[error("onboarding config I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("onboarding config JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone)]
pub struct ClaudeOnboardingService {
    path: PathBuf,
}

impl Default for ClaudeOnboardingService {
    fn default() -> Self {
        Self::new()
    }
}

impl ClaudeOnboardingService {
    pub fn new() -> Self {
        Self {
            path: resolve_path(),
        }
    }
    pub fn with_path(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
    pub fn path(&self) -> &Path {
        &self.path
    }

    pub async fn get(&self) -> Result<ClaudeOnboardingStatus, ClaudeOnboardingError> {
        let root = read_root(&self.path).await?;
        Ok(ClaudeOnboardingStatus {
            enabled: root
                .as_ref()
                .and_then(|v| v.get("hasCompletedOnboarding"))
                .and_then(Value::as_bool)
                .unwrap_or(false),
            path: self.path.clone(),
        })
    }

    pub async fn set(
        &self,
        enabled: bool,
    ) -> Result<ClaudeOnboardingStatus, ClaudeOnboardingError> {
        let mut root = read_root(&self.path)
            .await?
            .unwrap_or_else(|| Value::Object(Map::new()));
        if !root.is_object() {
            root = Value::Object(Map::new());
        }
        let object = root.as_object_mut().expect("normalized object");
        if enabled {
            object.insert("hasCompletedOnboarding".into(), Value::Bool(true));
        } else {
            object.remove("hasCompletedOnboarding");
        }
        atomic_write(&self.path, &root).await?;
        Ok(ClaudeOnboardingStatus {
            enabled,
            path: self.path.clone(),
        })
    }
}

fn resolve_path() -> PathBuf {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."));
    let configured = std::env::var_os("CLAUDE_CONFIG_DIR")
        .or_else(|| std::env::var_os("OSHEEP_CLAUDE_CONFIG_DIR"));
    match configured {
        None => home.join(".claude.json"),
        Some(value) => {
            let dir = PathBuf::from(value);
            let dir = if dir.is_absolute() {
                dir
            } else {
                std::env::current_dir().unwrap_or_default().join(dir)
            };
            let name = dir.file_name().unwrap_or_default();
            dir.parent()
                .unwrap_or(Path::new("."))
                .join(format!("{}.json", name.to_string_lossy()))
        }
    }
}

async fn read_root(path: &Path) -> Result<Option<Value>, ClaudeOnboardingError> {
    match tokio::fs::read(path).await {
        Ok(bytes) => Ok(Some(serde_json::from_slice(&bytes)?)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.into()),
    }
}

async fn atomic_write(path: &Path, value: &Value) -> Result<(), ClaudeOnboardingError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let temp = path.with_file_name(format!(
        ".{}.{}.tmp",
        path.file_name().unwrap_or_default().to_string_lossy(),
        std::process::id()
    ));
    tokio::fs::write(&temp, format!("{}\n", serde_json::to_string_pretty(value)?)).await?;
    if let Err(error) = tokio::fs::rename(&temp, path).await {
        let _ = tokio::fs::remove_file(&temp).await;
        return Err(error.into());
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[tokio::test]
    async fn onboarding_flag_round_trips_and_preserves_other_fields() {
        let path = std::env::temp_dir().join(format!(
            "osheep-onboarding-{}.json",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        tokio::fs::write(
            &path,
            br#"{"other":true}
"#,
        )
        .await
        .unwrap();
        let service = ClaudeOnboardingService::with_path(&path);
        assert!(!service.get().await.unwrap().enabled);
        assert!(service.set(true).await.unwrap().enabled);
        let value: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert_eq!(value["other"], true);
        assert_eq!(value["hasCompletedOnboarding"], true);
        assert!(!service.set(false).await.unwrap().enabled);
        let value: Value = serde_json::from_slice(&tokio::fs::read(&path).await.unwrap()).unwrap();
        assert!(value.get("hasCompletedOnboarding").is_none());
        let _ = tokio::fs::remove_file(path).await;
    }
}
