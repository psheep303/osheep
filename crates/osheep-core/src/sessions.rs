use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

static SESSION_SEQUENCE: AtomicU64 = AtomicU64::new(0);

#[derive(Debug, Error)]
pub enum SessionError {
    #[error("session id 非法")]
    InvalidId,
    #[error("session 不存在: {0}")]
    NotFound(String),
    #[error("session 文件解析失败")]
    InvalidJson,
    #[error("session I/O 失败: {0}")]
    Io(#[from] std::io::Error),
    #[error("session JSON 编码失败: {0}")]
    Json(#[from] serde_json::Error),
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChatMessage {
    pub role: ChatRole,
    pub content: String,
    pub timestamp: f64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub steps: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub tool_call_id: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ChatRole {
    User,
    Assistant,
    Tool,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionRecord {
    pub id: String,
    pub title: String,
    pub agent_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub created_at: f64,
    pub updated_at: f64,
    pub messages: Vec<ChatMessage>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SessionSummary {
    pub id: String,
    pub title: String,
    pub agent_name: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub provider_id: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    pub created_at: f64,
    pub updated_at: f64,
    pub message_count: usize,
}

#[derive(Debug, Clone)]
pub struct SessionService;

impl SessionService {
    pub fn new() -> Self {
        Self
    }

    pub async fn list(&self, workspace_root: &Path) -> Result<Vec<SessionSummary>, SessionError> {
        let directory = session_dir(workspace_root);
        tokio::fs::create_dir_all(&directory).await?;
        let mut entries = tokio::fs::read_dir(directory).await?;
        let mut result = Vec::new();
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".json") {
                continue;
            }
            let id = name.trim_end_matches(".json");
            if !valid_id(id) {
                continue;
            }
            let Ok(bytes) = tokio::fs::read(entry.path()).await else {
                continue;
            };
            let Ok(value) = serde_json::from_slice::<Value>(&bytes) else {
                continue;
            };
            let Ok(record) = sanitize(value, id) else {
                continue;
            };
            result.push(summary(&record));
        }
        result.sort_by(|left, right| right.updated_at.total_cmp(&left.updated_at));
        Ok(result)
    }

    pub async fn get(
        &self,
        workspace_root: &Path,
        id: &str,
    ) -> Result<SessionRecord, SessionError> {
        validate_id(id)?;
        let path = session_file(workspace_root, id);
        let bytes = tokio::fs::read(path).await.map_err(|error| {
            if error.kind() == std::io::ErrorKind::NotFound {
                SessionError::NotFound(id.to_owned())
            } else {
                SessionError::Io(error)
            }
        })?;
        let value =
            serde_json::from_slice::<Value>(&bytes).map_err(|_| SessionError::InvalidJson)?;
        sanitize(value, id)
    }

    pub async fn create(
        &self,
        workspace_root: &Path,
        title: Option<String>,
        agent_name: Option<String>,
    ) -> Result<SessionRecord, SessionError> {
        let now = now_millis();
        let record = SessionRecord {
            id: generate_id(),
            title: title
                .filter(|value| !value.is_empty())
                .unwrap_or_else(|| "新对话".into()),
            agent_name: agent_name.unwrap_or_default(),
            provider_id: None,
            model: None,
            created_at: now,
            updated_at: now,
            messages: Vec::new(),
        };
        self.write(workspace_root, &record).await?;
        Ok(record)
    }

    pub async fn save(
        &self,
        workspace_root: &Path,
        record: SessionRecord,
    ) -> Result<SessionRecord, SessionError> {
        validate_id(&record.id)?;
        let mut next = sanitize(serde_json::to_value(record)?, "")?;
        next.updated_at = now_millis();
        self.write(workspace_root, &next).await?;
        Ok(next)
    }

    pub async fn delete(&self, workspace_root: &Path, id: &str) -> Result<(), SessionError> {
        validate_id(id)?;
        tokio::fs::remove_file(session_file(workspace_root, id))
            .await
            .map_err(|error| {
                if error.kind() == std::io::ErrorKind::NotFound {
                    SessionError::NotFound(id.to_owned())
                } else {
                    SessionError::Io(error)
                }
            })
    }

    async fn write(
        &self,
        workspace_root: &Path,
        record: &SessionRecord,
    ) -> Result<(), SessionError> {
        let directory = session_dir(workspace_root);
        tokio::fs::create_dir_all(&directory).await?;
        let path = session_file(workspace_root, &record.id);
        let mut bytes = serde_json::to_vec_pretty(record)?;
        bytes.push(b'\n');
        let temporary = directory.join(format!(
            ".{}.tmp.{}",
            record.id,
            SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        tokio::fs::write(&temporary, bytes).await?;
        if let Err(error) = tokio::fs::rename(&temporary, &path).await {
            let _ = tokio::fs::remove_file(&temporary).await;
            return Err(error.into());
        }
        Ok(())
    }
}

impl Default for SessionService {
    fn default() -> Self {
        Self::new()
    }
}

fn session_dir(root: &Path) -> PathBuf {
    root.join(".osheep").join("session")
}
fn session_file(root: &Path, id: &str) -> PathBuf {
    session_dir(root).join(format!("{id}.json"))
}
fn valid_id(id: &str) -> bool {
    let suffix = id.strip_prefix("ses_").unwrap_or_default();
    (8..=32).contains(&suffix.len())
        && suffix
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}
fn validate_id(id: &str) -> Result<(), SessionError> {
    valid_id(id).then_some(()).ok_or(SessionError::InvalidId)
}
fn now_millis() -> f64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.0
}
fn generate_id() -> String {
    let sequence = SESSION_SEQUENCE.fetch_add(1, Ordering::Relaxed);
    format!("ses_{:x}{:x}", now_millis() as u64, sequence)
}

fn sanitize(value: Value, fallback_id: &str) -> Result<SessionRecord, SessionError> {
    let object = value.as_object().ok_or(SessionError::InvalidJson)?;
    let id = object
        .get("id")
        .and_then(Value::as_str)
        .filter(|id| valid_id(id))
        .unwrap_or(fallback_id)
        .to_owned();
    validate_id(&id)?;
    let title = object
        .get("title")
        .and_then(Value::as_str)
        .unwrap_or("新对话")
        .to_owned();
    let agent_name = object
        .get("agentName")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned();
    let provider_id = object
        .get("providerId")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let model = object
        .get("model")
        .and_then(Value::as_str)
        .map(str::to_owned);
    let created_at = object
        .get("createdAt")
        .and_then(Value::as_f64)
        .unwrap_or_else(now_millis);
    let updated_at = object
        .get("updatedAt")
        .and_then(Value::as_f64)
        .unwrap_or(created_at);
    let messages = object
        .get("messages")
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(sanitize_message).collect())
        .unwrap_or_default();
    Ok(SessionRecord {
        id,
        title,
        agent_name,
        provider_id,
        model,
        created_at,
        updated_at,
        messages,
    })
}

fn sanitize_message(value: &Value) -> Option<ChatMessage> {
    let object = value.as_object()?;
    let role = match object.get("role")?.as_str()? {
        "user" => ChatRole::User,
        "assistant" => ChatRole::Assistant,
        "tool" => ChatRole::Tool,
        _ => return None,
    };
    let content = object.get("content")?.as_str()?.to_owned();
    let timestamp = object
        .get("timestamp")
        .and_then(Value::as_f64)
        .unwrap_or_else(now_millis);
    let steps = (role == ChatRole::Assistant)
        .then(|| object.get("steps").cloned())
        .flatten();
    let tool_call_id = (role == ChatRole::Tool)
        .then(|| {
            object
                .get("toolCallId")
                .or_else(|| object.get("tool_call_id"))
                .and_then(Value::as_str)
                .map(str::to_owned)
        })
        .flatten();
    Some(ChatMessage {
        role,
        content,
        timestamp,
        steps,
        tool_call_id,
    })
}

fn summary(record: &SessionRecord) -> SessionSummary {
    SessionSummary {
        id: record.id.clone(),
        title: record.title.clone(),
        agent_name: record.agent_name.clone(),
        provider_id: record.provider_id.clone(),
        model: record.model.clone(),
        created_at: record.created_at,
        updated_at: record.updated_at,
        message_count: record.messages.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_path() -> PathBuf {
        std::env::temp_dir().join(format!("osheep-session-{}", generate_id()))
    }

    #[tokio::test]
    async fn session_round_trip_lists_summaries_and_deletes() {
        let root = temp_path();
        tokio::fs::create_dir_all(&root).await.unwrap();
        let service = SessionService::new();
        let created = service
            .create(&root, Some("Test".into()), Some("codex".into()))
            .await
            .unwrap();
        assert!(created.id.starts_with("ses_"));
        let mut saved = created.clone();
        saved.messages.push(ChatMessage {
            role: ChatRole::User,
            content: "hello".into(),
            timestamp: 1.0,
            steps: None,
            tool_call_id: None,
        });
        let saved = service.save(&root, saved).await.unwrap();
        let loaded = service.get(&root, &saved.id).await.unwrap();
        assert_eq!(loaded.messages.len(), 1);
        let listed = service.list(&root).await.unwrap();
        assert_eq!(listed[0].message_count, 1);
        service.delete(&root, &saved.id).await.unwrap();
        assert!(matches!(
            service.get(&root, &saved.id).await,
            Err(SessionError::NotFound(_))
        ));
        tokio::fs::remove_dir_all(root).await.ok();
    }
}
