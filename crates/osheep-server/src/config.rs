use std::env;
use std::path::PathBuf;
use thiserror::Error;

#[derive(Debug, Clone)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub workspaces_root: PathBuf,
    pub data_root: PathBuf,
    pub frontend_root: Option<PathBuf>,
    pub cors_origins: Vec<String>,
    pub auth_token: Option<String>,
    pub max_terminal_sessions: usize,
    pub terminal_idle_timeout_ms: u64,
    pub allow_external_workspace_paths: bool,
    pub max_file_size_bytes: u64,
}

#[derive(Debug, Error)]
pub enum ConfigError {
    #[error("invalid integer in {key}: {value}")]
    InvalidInteger { key: &'static str, value: String },
    #[error("unable to determine current directory: {0}")]
    CurrentDirectory(#[from] std::io::Error),
}

impl ServerConfig {
    pub fn from_env() -> Result<Self, ConfigError> {
        let current_dir = env::current_dir()?;
        let data_root = env::var_os("OSHEEP_DATA_ROOT")
            .map(PathBuf::from)
            .unwrap_or_else(|| current_dir.join(".osheep"));
        let workspaces_root = resolve_workspaces_root(
            &data_root,
            env::var_os("WORKSPACES_ROOT").map(PathBuf::from),
        );
        Ok(Self {
            host: env::var("OSHEEP_HOST").unwrap_or_else(|_| "127.0.0.1".into()),
            port: env_number("OSHEEP_PORT", 4178)?,
            workspaces_root,
            data_root,
            frontend_root: env::var_os("OSHEEP_FRONTEND_ROOT").map(PathBuf::from),
            cors_origins: env::var("CORS_ORIGIN")
                .unwrap_or_default()
                .split(',')
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .collect(),
            auth_token: env::var("OSHEEP_AUTH_TOKEN")
                .ok()
                .map(|value| value.trim().to_owned())
                .filter(|value| !value.is_empty()),
            max_terminal_sessions: env_number("MAX_TERMINAL_SESSIONS", 16)?,
            terminal_idle_timeout_ms: env_number("TERMINAL_IDLE_TIMEOUT_MS", 0)?,
            allow_external_workspace_paths: env_flag("OSHEEP_ALLOW_EXTERNAL_WORKSPACE_PATHS"),
            max_file_size_bytes: env_number("MAX_FILE_SIZE_BYTES", 5 * 1024 * 1024)?,
        })
    }
}

fn resolve_workspaces_root(data_root: &std::path::Path, configured: Option<PathBuf>) -> PathBuf {
    let stored = std::fs::read(data_root.join("workspace-root.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok())
        .and_then(|value| value.get("root")?.as_str().map(PathBuf::from))
        .filter(|root| root.is_absolute());
    stored
        .or(configured)
        .unwrap_or_else(|| data_root.join("workspaces"))
}

fn env_flag(key: &'static str) -> bool {
    env::var(key).ok().is_some_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "1" | "true" | "yes"
        )
    })
}

fn env_number<T>(key: &'static str, fallback: T) -> Result<T, ConfigError>
where
    T: std::str::FromStr,
{
    let Ok(value) = env::var(key) else {
        return Ok(fallback);
    };
    value
        .parse()
        .map_err(|_| ConfigError::InvalidInteger { key, value })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[test]
    fn persisted_workspace_root_takes_precedence_over_startup_default() {
        let data_root = std::env::temp_dir().join(format!(
            "osheep-config-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("system time after Unix epoch")
                .as_nanos()
        ));
        let persisted = data_root.join("external-workspaces");
        std::fs::create_dir_all(&data_root).expect("create data root");
        std::fs::write(
            data_root.join("workspace-root.json"),
            serde_json::to_vec(&serde_json::json!({ "root": persisted })).unwrap(),
        )
        .expect("write workspace root config");

        assert_eq!(
            resolve_workspaces_root(&data_root, Some(data_root.join("default-workspaces"))),
            persisted
        );
        std::fs::remove_dir_all(data_root).expect("remove test root");
    }
}
