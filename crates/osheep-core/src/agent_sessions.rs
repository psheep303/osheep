use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::path::{Path, PathBuf};
use thiserror::Error;

const PREFIX_BYTES: usize = 512 * 1024;

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum AgentSessionApp {
    Claude,
    Codex,
}

impl AgentSessionApp {
    pub fn parse(value: &str) -> Result<Self, AgentSessionError> {
        match value {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            _ => Err(AgentSessionError::InvalidQuery(
                "app must be claude or codex".into(),
            )),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AgentSessionSummary {
    pub app: AgentSessionApp,
    pub id: String,
    pub title: String,
    pub cwd: String,
    pub created_at: f64,
    pub updated_at: f64,
    pub size: u64,
}

#[derive(Debug, Clone)]
pub struct AgentSessionRoots {
    pub claude_home: PathBuf,
    pub codex_home: PathBuf,
}

impl AgentSessionRoots {
    pub fn from_env() -> Self {
        let home = std::env::var_os("USERPROFILE")
            .or_else(|| std::env::var_os("HOME"))
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("."));
        let claude_native = home.join(".claude");
        let codex_native = home.join(".codex");
        let claude = std::env::var_os("CLAUDE_CONFIG_DIR")
            .or_else(|| std::env::var_os("OSHEEP_CLAUDE_CONFIG_DIR"))
            .map(PathBuf::from)
            .unwrap_or(claude_native);
        let codex = std::env::var_os("CODEX_HOME")
            .or_else(|| std::env::var_os("OSHEEP_CODEX_CONFIG_DIR"))
            .map(PathBuf::from)
            .unwrap_or(codex_native);
        Self {
            claude_home: claude,
            codex_home: codex,
        }
    }
}

#[derive(Debug, Error)]
pub enum AgentSessionError {
    #[error("{0}")]
    InvalidQuery(String),
    #[error("agent session not found in the current project")]
    NotFound,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
}

#[derive(Debug, Clone)]
pub struct AgentSessionService {
    roots: AgentSessionRoots,
}

impl Default for AgentSessionService {
    fn default() -> Self {
        Self::new()
    }
}
impl AgentSessionService {
    pub fn new() -> Self {
        Self {
            roots: AgentSessionRoots::from_env(),
        }
    }
    pub fn with_roots(roots: AgentSessionRoots) -> Self {
        Self { roots }
    }
    pub async fn list_in_project(
        &self,
        app: AgentSessionApp,
        project: &Path,
    ) -> Result<Vec<AgentSessionSummary>, AgentSessionError> {
        let all = self.list(app).await?;
        let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        Ok(all
            .into_iter()
            .filter(|s| within(&root, Path::new(&s.cwd)))
            .collect())
    }
    pub async fn list(
        &self,
        app: AgentSessionApp,
    ) -> Result<Vec<AgentSessionSummary>, AgentSessionError> {
        let mut records = match app {
            AgentSessionApp::Claude => self.list_claude().await?,
            AgentSessionApp::Codex => self.list_codex().await?,
        };
        records.sort_by(|a, b| {
            b.updated_at
                .total_cmp(&a.updated_at)
                .then_with(|| a.id.cmp(&b.id))
        });
        Ok(records)
    }
    pub async fn delete_in_project(
        &self,
        app: AgentSessionApp,
        id: &str,
        project: &Path,
    ) -> Result<AgentSessionSummary, AgentSessionError> {
        validate_id(id)?;
        let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        let record = self
            .find(app, id)
            .await?
            .filter(|s| within(&root, Path::new(&s.cwd)))
            .ok_or(AgentSessionError::NotFound)?;
        self.delete_file(app, &record).await?;
        Ok(record)
    }
    pub async fn get_in_project(
        &self,
        app: AgentSessionApp,
        id: &str,
        project: &Path,
    ) -> Result<AgentSessionSummary, AgentSessionError> {
        validate_id(id)?;
        let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        self.find(app, id)
            .await?
            .filter(|session| within(&root, Path::new(&session.cwd)))
            .ok_or(AgentSessionError::NotFound)
    }

    pub async fn read_in_project(
        &self,
        app: AgentSessionApp,
        id: &str,
        project: &Path,
    ) -> Result<Option<String>, AgentSessionError> {
        validate_id(id)?;
        let root = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
        let Some(record) = self
            .find(app, id)
            .await?
            .filter(|session| within(&root, Path::new(&session.cwd)))
        else {
            return Ok(None);
        };
        let Some(path) = locate_file(&self.roots, app, &record.id).await? else {
            return Ok(None);
        };
        Ok(Some(tokio::fs::read_to_string(path).await?))
    }

    pub async fn read_by_id(
        &self,
        app: AgentSessionApp,
        id: &str,
    ) -> Result<Option<String>, AgentSessionError> {
        validate_id(id)?;
        let Some(path) = locate_file(&self.roots, app, id).await? else {
            return Ok(None);
        };
        Ok(Some(tokio::fs::read_to_string(path).await?))
    }

    /// Reassign a newly-created Codex session to the user-requested UUID.
    /// Codex cannot accept an arbitrary id on its initial TUI invocation; the
    /// TypeScript implementation performs this rewrite after the first turn so
    /// subsequent retries can use `codex resume <requested-id>`.
    pub async fn reassign_codex_session_id(
        &self,
        current_id: &str,
        requested_id: &str,
    ) -> Result<(), AgentSessionError> {
        validate_id(current_id)?;
        validate_id(requested_id)?;
        if current_id == requested_id {
            return Ok(());
        }
        let Some(path) = locate_file(&self.roots, AgentSessionApp::Codex, current_id).await? else {
            return Err(AgentSessionError::NotFound);
        };
        let text = tokio::fs::read_to_string(&path).await?;
        let mut changed = false;
        let rewritten = text
            .lines()
            .map(|line| {
                let Ok(mut value) = serde_json::from_str::<Value>(line) else {
                    return line.to_owned();
                };
                if value["type"].as_str() != Some("session_meta") {
                    return line.to_owned();
                }
                let payload = &mut value["payload"];
                if payload["id"].as_str() == Some(current_id) {
                    payload["id"] = Value::String(requested_id.to_owned());
                    changed = true;
                }
                if payload["session_id"].as_str() == Some(current_id) {
                    payload["session_id"] = Value::String(requested_id.to_owned());
                    changed = true;
                }
                serde_json::to_string(&value).unwrap_or_else(|_| line.to_owned())
            })
            .collect::<Vec<_>>()
            .join("\n");
        if !changed {
            return Err(AgentSessionError::InvalidQuery(
                "Codex session has no session metadata".into(),
            ));
        }
        let next = path.with_file_name(
            path.file_name()
                .and_then(|name| name.to_str())
                .map(|name| name.replace(current_id, requested_id))
                .unwrap_or_else(|| format!("rollout-{requested_id}.jsonl")),
        );
        tokio::fs::write(&next, format!("{rewritten}\n")).await?;
        tokio::fs::remove_file(&path).await?;
        Ok(())
    }
    pub async fn batch_delete(
        &self,
        app: AgentSessionApp,
        ids: &[String],
        project: &Path,
    ) -> Result<(Vec<AgentSessionSummary>, Vec<(String, String)>), AgentSessionError> {
        if ids.is_empty() || ids.len() > 500 {
            return Err(AgentSessionError::InvalidQuery(
                "ids must contain 1 to 500 session ids".into(),
            ));
        }
        if ids.iter().any(|id| id.trim().is_empty()) {
            return Err(AgentSessionError::InvalidQuery(
                "ids contains an invalid session id".into(),
            ));
        }
        let mut deleted = Vec::new();
        let mut failed = Vec::new();
        let mut seen = std::collections::HashSet::new();
        for id in ids {
            if !seen.insert(id) {
                continue;
            }
            match self.delete_in_project(app, id, project).await {
                Ok(s) => deleted.push(s),
                Err(e) => failed.push((id.clone(), e.to_string())),
            }
        }
        Ok((deleted, failed))
    }
    async fn find(
        &self,
        app: AgentSessionApp,
        id: &str,
    ) -> Result<Option<AgentSessionSummary>, AgentSessionError> {
        Ok(self.list(app).await?.into_iter().find(|s| s.id == id))
    }
    async fn list_claude(&self) -> Result<Vec<AgentSessionSummary>, AgentSessionError> {
        let mut out = Vec::new();
        let root = self.roots.claude_home.join("projects");
        for dir in read_dirs(&root).await? {
            for file in read_files(&dir).await? {
                if file.extension().and_then(|x| x.to_str()) != Some("jsonl") {
                    continue;
                }
                let id = file.file_stem().and_then(|x| x.to_str()).unwrap_or("");
                if !valid_id(id) {
                    continue;
                }
                if let Some(s) = parse_session(AgentSessionApp::Claude, &file, id).await? {
                    out.push(s);
                }
            }
        }
        Ok(out)
    }
    async fn list_codex(&self) -> Result<Vec<AgentSessionSummary>, AgentSessionError> {
        let mut out = Vec::new();
        let titles =
            read_codex_title_index(&self.roots.codex_home.join("session_index.jsonl")).await;
        for file in collect_jsonl(&self.roots.codex_home.join("sessions")).await? {
            let id = session_id_from_filename(&file);
            if !valid_id(&id) {
                continue;
            }
            if let Some(s) = parse_session_with_title(
                AgentSessionApp::Codex,
                &file,
                &id,
                titles.get(&id).map(String::as_str),
            )
            .await?
            {
                out.push(s);
            }
        }
        Ok(out)
    }
    async fn delete_file(
        &self,
        app: AgentSessionApp,
        record: &AgentSessionSummary,
    ) -> Result<(), AgentSessionError> {
        let path = locate_file(&self.roots, app, &record.id)
            .await?
            .ok_or(AgentSessionError::NotFound)?;
        tokio::fs::remove_file(&path).await?;
        if app == AgentSessionApp::Claude {
            let _ = tokio::fs::remove_dir_all(path.with_extension("")).await;
            let index = path
                .parent()
                .unwrap_or(Path::new("."))
                .join("sessions-index.json");
            remove_index(&index, &record.id).await;
        } else {
            remove_index(
                &self.roots.codex_home.join("session_index.jsonl"),
                &record.id,
            )
            .await;
        }
        Ok(())
    }
}

async fn parse_session(
    app: AgentSessionApp,
    path: &Path,
    fallback: &str,
) -> Result<Option<AgentSessionSummary>, AgentSessionError> {
    parse_session_with_title(app, path, fallback, None).await
}

async fn parse_session_with_title(
    app: AgentSessionApp,
    path: &Path,
    fallback: &str,
    indexed_title: Option<&str>,
) -> Result<Option<AgentSessionSummary>, AgentSessionError> {
    let meta = tokio::fs::metadata(path).await?;
    let bytes = tokio::fs::read(path).await?;
    let text = String::from_utf8_lossy(&bytes[..bytes.len().min(PREFIX_BYTES)]);
    let mut id = fallback.to_string();
    let mut cwd = String::new();
    let mut title = String::new();
    let mut created = None;
    let mut updated = meta
        .modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_millis() as f64)
        .unwrap_or(0.0);
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        let ts = v.get("timestamp").and_then(timestamp);
        if let Some(t) = ts {
            if created.is_none() {
                created = Some(t)
            };
            if t > updated {
                updated = t;
            }
        }
        if app == AgentSessionApp::Claude {
            id = v
                .get("sessionId")
                .and_then(Value::as_str)
                .unwrap_or(&id)
                .to_string();
            cwd = v
                .get("cwd")
                .and_then(Value::as_str)
                .unwrap_or(&cwd)
                .to_string();
            title = title_or(title, v.get("customTitle").and_then(Value::as_str));
            title = title_or(title, v.get("summary").and_then(Value::as_str));
            if title.is_empty() && v.get("type").and_then(Value::as_str) == Some("user") {
                title = content_text(v.get("message").and_then(|x| x.get("content")));
            }
        } else {
            let typ = v.get("type").and_then(Value::as_str).unwrap_or("");
            let p = v.get("payload").unwrap_or(&Value::Null);
            if typ == "session_meta" {
                id = p
                    .get("id")
                    .or_else(|| p.get("session_id"))
                    .and_then(Value::as_str)
                    .unwrap_or(&id)
                    .to_string();
                cwd = p
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or(&cwd)
                    .to_string();
                if let Some(t) = p.get("timestamp").and_then(timestamp) {
                    created = Some(t);
                }
            }
            if title.is_empty()
                && typ == "event_msg"
                && p.get("type").and_then(Value::as_str) == Some("user_message")
            {
                title = p
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_string();
                title = clean_prompt_context(&title);
            }
            if title.is_empty()
                && typ == "response_item"
                && p.get("type").and_then(Value::as_str) == Some("message")
                && p.get("role").and_then(Value::as_str) == Some("user")
            {
                title = clean_prompt_context(&content_text(p.get("content")));
            }
            if cwd.is_empty() && typ == "turn_context" {
                cwd = p
                    .get("cwd")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
            }
        }
    }
    if !valid_id(&id) {
        return Ok(None);
    }
    if cwd.is_empty() {
        cwd = std::env::var("HOME")
            .or_else(|_| std::env::var("USERPROFILE"))
            .unwrap_or_else(|_| ".".into());
    }
    let prefix = if app == AgentSessionApp::Claude {
        "Claude session "
    } else {
        "Codex session "
    };
    if title.trim().is_empty() {
        title = format!("{}{}", prefix, &id[..id.len().min(8)]);
    }
    if app == AgentSessionApp::Codex {
        if let Some(indexed) = indexed_title.filter(|value| !value.trim().is_empty()) {
            title = indexed.trim().to_owned();
        }
    }
    Ok(Some(AgentSessionSummary {
        app,
        id,
        title: title.trim().chars().take(96).collect(),
        cwd,
        created_at: created.unwrap_or(updated),
        updated_at: updated,
        size: meta.len(),
    }))
}

async fn read_codex_title_index(path: &Path) -> std::collections::HashMap<String, String> {
    let Ok(text) = tokio::fs::read_to_string(path).await else {
        return std::collections::HashMap::new();
    };
    text.lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter_map(|value| {
            let id = value.get("id").and_then(Value::as_str)?.trim();
            let title = value.get("thread_name").and_then(Value::as_str)?.trim();
            (!id.is_empty() && !title.is_empty()).then(|| (id.to_owned(), title.to_owned()))
        })
        .collect()
}
fn title_or(current: String, next: Option<&str>) -> String {
    if current.trim().is_empty() {
        next.unwrap_or("").trim().to_string()
    } else {
        current
    }
}

fn clean_prompt_context(value: &str) -> String {
    let mut cleaned = value.to_owned();
    for marker in ["<environment_context>", "<permissions instructions>"] {
        if let Some(start) = cleaned.to_ascii_lowercase().find(marker) {
            let close = marker.replace('<', "</");
            if let Some(end) = cleaned[start..].to_ascii_lowercase().find(&close) {
                cleaned.replace_range(start..start + end + close.len(), " ");
            }
        }
    }
    if let Some(start) = cleaned.to_ascii_lowercase().find("# agents.md") {
        if let Some(end) = cleaned[start..].find("\n\n") {
            cleaned.replace_range(start..start + end, " ");
        }
    }
    cleaned.split_whitespace().collect::<Vec<_>>().join(" ")
}
fn content_text(v: Option<&Value>) -> String {
    match v {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a
            .iter()
            .filter_map(|x| {
                x.get("text")
                    .or_else(|| x.get("content"))
                    .and_then(Value::as_str)
            })
            .collect::<Vec<_>>()
            .join(" "),
        _ => String::new(),
    }
}
fn timestamp(v: &Value) -> Option<f64> {
    v.as_f64()
}
fn valid_id(id: &str) -> bool {
    id.len() >= 8
        && id.len() <= 128
        && id
            .as_bytes()
            .first()
            .is_some_and(|b| b.is_ascii_alphanumeric())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn validate_id(id: &str) -> Result<(), AgentSessionError> {
    if valid_id(id) {
        Ok(())
    } else {
        Err(AgentSessionError::InvalidQuery(
            "session id is invalid".into(),
        ))
    }
}
fn session_id_from_filename(p: &Path) -> String {
    let name = p.file_stem().and_then(|x| x.to_str()).unwrap_or("");
    if name.len() >= 36 {
        let candidate = &name[name.len() - 36..];
        if candidate.as_bytes().get(8) == Some(&b'-')
            && candidate.as_bytes().get(13) == Some(&b'-')
            && candidate.as_bytes().get(18) == Some(&b'-')
            && candidate.as_bytes().get(23) == Some(&b'-')
        {
            return candidate.to_string();
        }
    }
    String::new()
}
fn within(root: &Path, path: &Path) -> bool {
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    p == root || p.strip_prefix(root).is_ok()
}
async fn read_dirs(root: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut o = Vec::new();
    let mut rd = match tokio::fs::read_dir(root).await {
        Ok(x) => x,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(o),
        Err(e) => return Err(e),
    };
    while let Some(e) = rd.next_entry().await? {
        if e.file_type().await?.is_dir() {
            o.push(e.path())
        }
    }
    Ok(o)
}
async fn read_files(root: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut o = Vec::new();
    let mut rd = match tokio::fs::read_dir(root).await {
        Ok(x) => x,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(o),
        Err(e) => return Err(e),
    };
    while let Some(e) = rd.next_entry().await? {
        if e.file_type().await?.is_file() {
            o.push(e.path())
        }
    }
    Ok(o)
}
async fn collect_jsonl(root: &Path) -> Result<Vec<PathBuf>, std::io::Error> {
    let mut o = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(dir) = stack.pop() {
        let mut rd = match tokio::fs::read_dir(&dir).await {
            Ok(x) => x,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => continue,
            Err(e) => return Err(e),
        };
        while let Some(e) = rd.next_entry().await? {
            let ft = e.file_type().await?;
            if ft.is_dir() {
                stack.push(e.path())
            } else if ft.is_file() && e.path().extension().and_then(|x| x.to_str()) == Some("jsonl")
            {
                o.push(e.path())
            }
        }
    }
    Ok(o)
}
async fn locate_file(
    roots: &AgentSessionRoots,
    app: AgentSessionApp,
    id: &str,
) -> Result<Option<PathBuf>, AgentSessionError> {
    let files = if app == AgentSessionApp::Claude {
        read_dirs(&roots.claude_home.join("projects"))
            .await?
            .into_iter()
            .flat_map(|d| std::iter::once(d.join(format!("{id}.jsonl"))))
            .collect()
    } else {
        collect_jsonl(&roots.codex_home.join("sessions")).await?
    };
    for p in files {
        if p.is_file() && (app == AgentSessionApp::Claude || session_id_from_filename(&p) == id) {
            return Ok(Some(p));
        }
    }
    Ok(None)
}
async fn remove_index(path: &Path, id: &str) {
    let Ok(bytes) = tokio::fs::read(path).await else {
        return;
    };
    if path.extension().and_then(|x| x.to_str()) == Some("jsonl") {
        let text = String::from_utf8_lossy(&bytes);
        let lines: Vec<&str> = text
            .lines()
            .filter(|line| {
                serde_json::from_str::<Value>(line).ok().is_none_or(|v| {
                    v.get("id").and_then(Value::as_str) != Some(id)
                        && v.get("sessionId").and_then(Value::as_str) != Some(id)
                })
            })
            .collect();
        let _ = tokio::fs::write(path, format!("{}\n", lines.join("\n"))).await;
        return;
    }
    let Ok(mut v) = serde_json::from_slice::<Value>(&bytes) else {
        return;
    };
    fn filter(v: &mut Value, id: &str) {
        if let Some(a) = v.as_array_mut() {
            a.retain(|x| {
                x.get("sessionId").and_then(Value::as_str) != Some(id)
                    && x.get("id").and_then(Value::as_str) != Some(id)
            });
            for x in a {
                filter(x, id)
            }
        } else if let Some(o) = v.as_object_mut() {
            for x in o.values_mut() {
                filter(x, id)
            }
        }
    }
    filter(&mut v, id);
    let _ = tokio::fs::write(path, serde_json::to_vec_pretty(&v).unwrap_or_default()).await;
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temp(name: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "osheep-agent-{name}-{}",
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ))
    }

    #[tokio::test]
    async fn lists_and_filters_claude_sessions_and_deletes() {
        let root = temp("claude");
        let project = root.join("projects/p");
        let workspace = temp("workspace");
        tokio::fs::create_dir_all(&project).await.unwrap();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let id = "abcdef12-3456-7890-abcd-ef1234567890";
        let path = project.join(format!("{id}.jsonl"));
        let fixture = serde_json::json!({"sessionId": id, "cwd": workspace.to_string_lossy(), "timestamp": 1000, "type": "user", "message": {"role": "user", "content": "hello"}});
        tokio::fs::write(&path, format!("{}\n", fixture))
            .await
            .unwrap();
        let service = AgentSessionService::with_roots(AgentSessionRoots {
            claude_home: root.clone(),
            codex_home: temp("codex-unused"),
        });
        let listed = service
            .list_in_project(AgentSessionApp::Claude, &workspace)
            .await
            .unwrap();
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].title, "hello");
        service
            .delete_in_project(AgentSessionApp::Claude, id, &workspace)
            .await
            .unwrap();
        assert!(!path.exists());
        let _ = tokio::fs::remove_dir_all(root).await;
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn reads_claude_session_by_id_without_requiring_project_metadata() {
        let root = temp("claude-direct-read");
        let project = root.join("projects/p");
        tokio::fs::create_dir_all(&project).await.unwrap();
        let id = "abcdef12-3456-7890-abcd-ef1234567890";
        let path = project.join(format!("{id}.jsonl"));
        let event = serde_json::json!({"sessionId":id,"type":"assistant"});
        tokio::fs::write(&path, format!("{event}\n")).await.unwrap();
        let service = AgentSessionService::with_roots(AgentSessionRoots {
            claude_home: root.clone(),
            codex_home: temp("codex-unused-direct-read"),
        });

        assert_eq!(
            service
                .read_by_id(AgentSessionApp::Claude, id)
                .await
                .unwrap(),
            Some(format!("{event}\n"))
        );

        let _ = tokio::fs::remove_dir_all(root).await;
    }

    #[tokio::test]
    async fn batch_delete_reports_missing_ids() {
        let root = temp("codex");
        let workspace = temp("workspace");
        let sessions = root.join("sessions/2026/08");
        tokio::fs::create_dir_all(&sessions).await.unwrap();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let id = "12345678-1234-1234-1234-123456789012";
        let path = sessions.join(format!("rollout-2026-{id}.jsonl"));
        let fixture = serde_json::json!({"type": "session_meta", "payload": {"id": id, "cwd": workspace.to_string_lossy(), "timestamp": 2000}});
        tokio::fs::write(&path, format!("{}\n", fixture))
            .await
            .unwrap();
        let service = AgentSessionService::with_roots(AgentSessionRoots {
            claude_home: temp("claude-unused"),
            codex_home: root.clone(),
        });
        let (deleted, failed) = service
            .batch_delete(
                AgentSessionApp::Codex,
                &[id.into(), "missing1x".into()],
                &workspace,
            )
            .await
            .unwrap();
        assert_eq!(deleted.len(), 1);
        assert_eq!(failed.len(), 1);
        let _ = tokio::fs::remove_dir_all(root).await;
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn codex_sessions_prefer_session_index_thread_name() {
        let root = temp("codex-title");
        let workspace = temp("codex-title-workspace");
        let sessions = root.join("sessions/2026/09/13");
        tokio::fs::create_dir_all(&sessions).await.unwrap();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let id = "01abcdef-2345-6789-abcd-ef0123456789";
        let path = sessions.join(format!("rollout-2026-09-13T00-00-00-{id}.jsonl"));
        let session_meta = serde_json::json!({
            "type":"session_meta",
            "payload":{"id":id,"cwd":workspace.to_string_lossy()}
        });
        tokio::fs::write(&path, format!("{}\n", session_meta))
            .await
            .unwrap();
        tokio::fs::write(
            root.join("session_index.jsonl"),
            format!(
                "{}\n",
                serde_json::json!({"id":id,"thread_name":"总结后的 Codex 任务"})
            ),
        )
        .await
        .unwrap();
        let service = AgentSessionService::with_roots(AgentSessionRoots {
            claude_home: temp("claude-unused"),
            codex_home: root.clone(),
        });
        let listed = service
            .list_in_project(AgentSessionApp::Codex, &workspace)
            .await
            .unwrap();
        assert_eq!(listed[0].title, "总结后的 Codex 任务");
        let _ = tokio::fs::remove_dir_all(root).await;
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn codex_sessions_fallback_to_first_user_message_summary() {
        let root = temp("codex-response-title");
        let workspace = temp("codex-response-title-workspace");
        let sessions = root.join("sessions/2026/09/13");
        tokio::fs::create_dir_all(&sessions).await.unwrap();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let id = "01abcdef-2345-6789-abcd-ef0123456790";
        let path = sessions.join(format!("rollout-2026-09-13T00-00-00-{id}.jsonl"));
        let lines = [
            serde_json::json!({"type":"session_meta","payload":{"id":id,"cwd":workspace.to_string_lossy()}}),
            serde_json::json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>hidden</environment_context>\n总结这个任务"}]}}),
        ];
        tokio::fs::write(
            &path,
            lines
                .iter()
                .map(Value::to_string)
                .collect::<Vec<_>>()
                .join("\n"),
        )
        .await
        .unwrap();
        let service = AgentSessionService::with_roots(AgentSessionRoots {
            claude_home: temp("claude-unused-response-title"),
            codex_home: root.clone(),
        });
        let listed = service
            .list_in_project(AgentSessionApp::Codex, &workspace)
            .await
            .unwrap();
        assert_eq!(listed[0].title, "总结这个任务");
        let _ = tokio::fs::remove_dir_all(root).await;
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }

    #[tokio::test]
    async fn codex_session_id_can_be_reassigned_for_resume() {
        let root = temp("codex-reassign");
        let workspace = temp("codex-reassign-workspace");
        let sessions = root.join("sessions/2026/09/13");
        tokio::fs::create_dir_all(&sessions).await.unwrap();
        tokio::fs::create_dir_all(&workspace).await.unwrap();
        let current = "01abcdef-2345-6789-abcd-ef0123456791";
        let requested = "01abcdef-2345-6789-abcd-ef0123456792";
        let path = sessions.join(format!("rollout-2026-09-13T00-00-00-{current}.jsonl"));
        tokio::fs::write(
            &path,
            serde_json::json!({"type":"session_meta","payload":{"id":current,"cwd":workspace.to_string_lossy()}}).to_string(),
        )
        .await
        .unwrap();
        let service = AgentSessionService::with_roots(AgentSessionRoots {
            claude_home: temp("claude-unused-reassign"),
            codex_home: root.clone(),
        });
        service
            .reassign_codex_session_id(current, requested)
            .await
            .unwrap();
        assert!(service
            .read_in_project(AgentSessionApp::Codex, requested, &workspace)
            .await
            .unwrap()
            .is_some());
        assert!(service
            .read_in_project(AgentSessionApp::Codex, current, &workspace)
            .await
            .unwrap()
            .is_none());
        let _ = tokio::fs::remove_dir_all(root).await;
        let _ = tokio::fs::remove_dir_all(workspace).await;
    }
}
