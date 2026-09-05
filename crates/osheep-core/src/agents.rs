use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use thiserror::Error;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct AgentRecord {
    pub name: String,
    pub prompt: String,
    pub provider_id: String,
    pub model: String,
}

#[derive(Debug, Error)]
pub enum AgentError {
    #[error("agent name is invalid")]
    InvalidName,
    #[error("agent not found: {0}")]
    NotFound(String),
    #[error("agent already exists")]
    Exists,
    #[error("agent I/O failed: {0}")]
    Io(#[from] std::io::Error),
    #[error("agent JSON failed: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Default)]
pub struct AgentService;

impl AgentService {
    pub fn new() -> Self {
        Self
    }
    pub async fn list(&self, root: &Path) -> Result<Vec<AgentRecord>, AgentError> {
        let dir = root.join(".osheep/agent");
        tokio::fs::create_dir_all(&dir).await?;
        let mut rd = tokio::fs::read_dir(dir).await?;
        let mut out = Vec::new();
        while let Some(e) = rd.next_entry().await? {
            if e.path().extension().and_then(|x| x.to_str()) != Some("json") {
                continue;
            }
            let bytes = match tokio::fs::read(e.path()).await {
                Ok(b) => b,
                Err(_) => continue,
            };
            let value = match serde_json::from_slice::<serde_json::Value>(&bytes) {
                Ok(v) => v,
                Err(_) => continue,
            };
            let name = value
                .get("name")
                .and_then(|v| v.as_str())
                .map(str::to_owned)
                .unwrap_or_else(|| {
                    e.file_name()
                        .to_string_lossy()
                        .trim_end_matches(".json")
                        .to_owned()
                });
            if !valid_name(&name) {
                continue;
            }
            out.push(AgentRecord {
                name,
                prompt: string(&value, "prompt"),
                provider_id: string(&value, "providerId"),
                model: string(&value, "model"),
            });
        }
        out.sort_by(|a, b| a.name.cmp(&b.name));
        Ok(out)
    }
    pub async fn get(&self, root: &Path, name: &str) -> Result<AgentRecord, AgentError> {
        validate_name(name)?;
        let p = file(root, name);
        let bytes = tokio::fs::read(&p).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AgentError::NotFound(name.into())
            } else {
                AgentError::Io(e)
            }
        })?;
        let v = serde_json::from_slice::<serde_json::Value>(&bytes).unwrap_or_default();
        Ok(AgentRecord {
            name: name.into(),
            prompt: string(&v, "prompt"),
            provider_id: string(&v, "providerId"),
            model: string(&v, "model"),
        })
    }
    pub async fn save(&self, root: &Path, agent: AgentRecord) -> Result<(), AgentError> {
        validate_name(&agent.name)?;
        let dir = root.join(".osheep/agent");
        tokio::fs::create_dir_all(&dir).await?;
        let p = file(root, &agent.name);
        let tmp = p.with_extension(format!("json.{}.tmp", std::process::id()));
        tokio::fs::write(&tmp, format!("{}\n", serde_json::to_string_pretty(&agent)?)).await?;
        if let Err(e) = tokio::fs::rename(&tmp, &p).await {
            let _ = tokio::fs::remove_file(tmp).await;
            return Err(e.into());
        }
        Ok(())
    }
    pub async fn rename(&self, root: &Path, old: &str, new: &str) -> Result<(), AgentError> {
        validate_name(old)?;
        validate_name(new)?;
        if old == new {
            return Ok(());
        }
        let from = file(root, old);
        let to = file(root, new);
        if tokio::fs::try_exists(&to).await.unwrap_or(false) {
            return Err(AgentError::Exists);
        }
        tokio::fs::rename(&from, &to).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AgentError::NotFound(old.into())
            } else {
                AgentError::Io(e)
            }
        })?;
        let current = self.get(root, new).await.unwrap_or(AgentRecord {
            name: new.into(),
            prompt: String::new(),
            provider_id: String::new(),
            model: String::new(),
        });
        self.save(
            root,
            AgentRecord {
                name: new.into(),
                ..current
            },
        )
        .await
    }
    pub async fn delete(&self, root: &Path, name: &str) -> Result<(), AgentError> {
        validate_name(name)?;
        tokio::fs::remove_file(file(root, name)).await.map_err(|e| {
            if e.kind() == std::io::ErrorKind::NotFound {
                AgentError::NotFound(name.into())
            } else {
                AgentError::Io(e)
            }
        })
    }
}
fn file(root: &Path, name: &str) -> PathBuf {
    root.join(".osheep/agent").join(format!("{name}.json"))
}
fn string(v: &serde_json::Value, key: &str) -> String {
    v.get(key).and_then(|v| v.as_str()).unwrap_or("").into()
}
fn valid_name(s: &str) -> bool {
    let n = s.chars().count();
    (1..=64).contains(&n)
        && s.chars().all(|c| {
            c.is_ascii_alphanumeric()
                || c == ' '
                || c == '_'
                || c == '-'
                || ('\u{4e00}'..='\u{9fff}').contains(&c)
        })
}
fn validate_name(s: &str) -> Result<(), AgentError> {
    if valid_name(s) {
        Ok(())
    } else {
        Err(AgentError::InvalidName)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    #[tokio::test]
    async fn agent_crud_round_trip() {
        let root = std::env::temp_dir().join(format!(
            "osheep-agents-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let service = AgentService::new();
        service
            .save(
                &root,
                AgentRecord {
                    name: "Builder".into(),
                    prompt: "do it".into(),
                    provider_id: "p".into(),
                    model: "m".into(),
                },
            )
            .await
            .unwrap();
        assert_eq!(service.list(&root).await.unwrap()[0].prompt, "do it");
        service.rename(&root, "Builder", "Builder 2").await.unwrap();
        assert_eq!(
            service.get(&root, "Builder 2").await.unwrap().name,
            "Builder 2"
        );
        service.delete(&root, "Builder 2").await.unwrap();
        assert!(matches!(
            service.get(&root, "Builder 2").await,
            Err(AgentError::NotFound(_))
        ));
        let _ = tokio::fs::remove_dir_all(root).await;
    }
}
