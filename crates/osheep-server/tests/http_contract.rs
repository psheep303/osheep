use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use osheep_contract::{ShellProfile, TerminalSessionSummary};
use osheep_pty::{PtyError, PtyEvent, PtyRuntime, PtySession, ReplaySnapshot, SpawnRequest};
use osheep_server::{build_app, ServerConfig};
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex,
};
use tokio::sync::broadcast;
use tower::ServiceExt;
use uuid::Uuid;

struct ContractRuntime;

#[async_trait]
impl PtyRuntime for ContractRuntime {
    fn profiles(&self) -> Vec<ShellProfile> {
        vec![ShellProfile {
            id: "powershell".into(),
            label: "PowerShell".into(),
            executable: r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe".into(),
        }]
    }

    fn list(&self) -> Vec<TerminalSessionSummary> {
        Vec::new()
    }

    fn get(&self, _id: &str) -> Option<Arc<dyn PtySession>> {
        None
    }

    async fn spawn(&self, _request: SpawnRequest) -> Result<Arc<dyn PtySession>, PtyError> {
        Err(PtyError::Spawn("not used by contract test".into()))
    }

    async fn kill(&self, id: &str) -> Result<(), PtyError> {
        Err(PtyError::SessionNotFound(id.into()))
    }
}

struct ContractSession {
    summary: Mutex<TerminalSessionSummary>,
    events: broadcast::Sender<PtyEvent>,
    killed: AtomicBool,
}

#[async_trait]
impl PtySession for ContractSession {
    fn summary(&self) -> TerminalSessionSummary {
        self.summary.lock().unwrap().clone()
    }

    fn attach(&self) -> (ReplaySnapshot, broadcast::Receiver<PtyEvent>) {
        let summary = self.summary();
        (
            ReplaySnapshot {
                data: String::new(),
                truncated: false,
                initial_cols: summary.cols,
                initial_rows: summary.rows,
                resizes: Vec::new(),
            },
            self.events.subscribe(),
        )
    }

    async fn input(&self, _data: String) -> Result<(), PtyError> {
        Ok(())
    }

    async fn resize(&self, cols: u16, rows: u16, _compact_startup: bool) -> Result<(), PtyError> {
        let mut summary = self.summary.lock().unwrap();
        summary.cols = cols;
        summary.rows = rows;
        Ok(())
    }

    async fn kill(&self) -> Result<(), PtyError> {
        self.killed.store(true, Ordering::Release);
        Ok(())
    }

    fn kill_on_detach(&self) -> bool {
        true
    }
}

#[derive(Default)]
struct CrudRuntime {
    sessions: Mutex<HashMap<String, Arc<ContractSession>>>,
}

#[async_trait]
impl PtyRuntime for CrudRuntime {
    fn profiles(&self) -> Vec<ShellProfile> {
        ContractRuntime.profiles()
    }

    fn list(&self) -> Vec<TerminalSessionSummary> {
        self.sessions
            .lock()
            .unwrap()
            .values()
            .map(|session| session.summary())
            .collect()
    }

    fn get(&self, id: &str) -> Option<Arc<dyn PtySession>> {
        self.sessions
            .lock()
            .unwrap()
            .get(id)
            .cloned()
            .map(|session| session as Arc<dyn PtySession>)
    }

    async fn spawn(&self, request: SpawnRequest) -> Result<Arc<dyn PtySession>, PtyError> {
        assert!(request.cwd.starts_with(&request.workspaces_root));
        assert!(request.kill_on_detach);
        let (events, _) = broadcast::channel(4);
        let session = Arc::new(ContractSession {
            summary: Mutex::new(TerminalSessionSummary {
                id: "t_contract".into(),
                workspace_id: request.workspace_id,
                shell: request.shell,
                cols: request.cols,
                rows: request.rows,
                created_at: 123,
            }),
            events,
            killed: AtomicBool::new(false),
        });
        self.sessions
            .lock()
            .unwrap()
            .insert("t_contract".into(), session.clone());
        Ok(session as Arc<dyn PtySession>)
    }

    async fn kill(&self, id: &str) -> Result<(), PtyError> {
        let session = self
            .sessions
            .lock()
            .unwrap()
            .remove(id)
            .ok_or_else(|| PtyError::SessionNotFound(id.into()))?;
        session.kill().await
    }
}

fn test_config(root: PathBuf, frontend_root: Option<PathBuf>) -> ServerConfig {
    ServerConfig {
        host: "127.0.0.1".into(),
        port: 0,
        workspaces_root: root.clone(),
        data_root: root.join(".state"),
        frontend_root,
        cors_origins: Vec::new(),
        auth_token: None,
        max_terminal_sessions: 4,
        terminal_idle_timeout_ms: 0,
        allow_external_workspace_paths: true,
        max_file_size_bytes: 5 * 1024 * 1024,
    }
}

fn temp_path(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!("osheep-rust-{label}-{}", Uuid::new_v4()))
}

fn run_git(root: &std::path::Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .status()
        .expect("git must be installed for the Rust contract suite");
    assert!(status.success(), "git {args:?} failed");
}

fn run_git_output(root: &std::path::Path, args: &[&str]) -> String {
    let output = std::process::Command::new("git")
        .args(args)
        .current_dir(root)
        .output()
        .expect("git must be installed for the Rust contract suite");
    assert!(output.status.success(), "git {args:?} failed");
    String::from_utf8(output.stdout).unwrap().trim().to_owned()
}

#[tokio::test]
async fn health_auth_and_terminal_profiles_match_node_contract() {
    let root = temp_path("http-contract");
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();

    let health = app
        .clone()
        .oneshot(Request::get("/api/health").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(health.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(health.into_body(), usize::MAX).await.unwrap(),
        r#"{"ok":true}"#
    );

    let denied = app
        .clone()
        .oneshot(
            Request::get("/api/terminals/profiles")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(denied.status(), StatusCode::UNAUTHORIZED);
    let denied_body = to_bytes(denied.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&denied_body).unwrap()["error"]["code"],
        "AUTH_REQUIRED"
    );

    let session = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(session.status(), StatusCode::OK);
    let cookie = session
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let profiles = app
        .oneshot(
            Request::get("/api/terminals/profiles")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(profiles.status(), StatusCode::OK);
    let profiles = to_bytes(profiles.into_body(), usize::MAX).await.unwrap();
    let profiles: serde_json::Value = serde_json::from_slice(&profiles).unwrap();
    assert_eq!(
        profiles["os"],
        if cfg!(windows) { "windows" } else { "linux" }
    );
    assert_eq!(profiles["profiles"][0]["id"], "powershell");
    assert_eq!(profiles["profiles"][0]["label"], "PowerShell");

    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn session_routes_preserve_persistence_and_validation_contract() {
    let root = temp_path("session-contract");
    std::fs::create_dir_all(root.join("demo")).unwrap();
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let created = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/sessions")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"title":"契约会话","agentName":"codex"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value =
        serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap()).unwrap();
    let id = created["id"].as_str().unwrap().to_owned();
    assert!(id.starts_with("ses_"));
    assert_eq!(created["title"], "契约会话");

    let updated = app
        .clone()
        .oneshot(
            Request::put(format!("/api/workspaces/demo/sessions/{id}"))
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(format!(
                    r#"{{"id":"{id}","title":"updated","agentName":"codex","createdAt":1,"updatedAt":1,"messages":[{{"role":"user","content":"hi","timestamp":1}}]}}"#
                )))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(updated.status(), StatusCode::OK);
    let listed = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/sessions")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let listed: serde_json::Value =
        serde_json::from_slice(&to_bytes(listed.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(listed["sessions"][0]["messageCount"], 1);

    let mismatch = app
        .clone()
        .oneshot(
            Request::put(format!("/api/workspaces/demo/sessions/{id}"))
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"id":"ses_wrong123","messages":[]}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(mismatch.status(), StatusCode::BAD_REQUEST);

    let deleted = app
        .oneshot(
            Request::delete(format!("/api/workspaces/demo/sessions/{id}"))
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn shared_state_routes_match_settings_and_workspace_contracts() {
    let root = temp_path("state-contract");
    let next_root = temp_path("state-contract-next");
    std::fs::create_dir_all(root.join("demo")).unwrap();
    std::fs::create_dir_all(next_root.join("zeta")).unwrap();
    std::fs::create_dir_all(next_root.join("alpha")).unwrap();
    let data_root = root.join(".state");
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let defaults = app
        .clone()
        .oneshot(
            Request::get("/api/settings")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let defaults: serde_json::Value =
        serde_json::from_slice(&to_bytes(defaults.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(defaults["ui"]["theme"], "dark");
    assert_eq!(defaults["workflow"]["maxParallelNodes"], 4);

    for patch in [
        serde_json::json!({ "editor": { "fontSize": 18 } }),
        serde_json::json!({ "custom": { "enabled": true } }),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::put("/api/settings")
                    .header(header::COOKIE, &cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(serde_json::to_vec(&patch).unwrap()))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::OK);
    }
    let ui = app
        .clone()
        .oneshot(
            Request::put("/api/ui-preferences")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"language":"zh-CN","theme":"light"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(ui.status(), StatusCode::OK);
    let dismissed = app
        .clone()
        .oneshot(
            Request::put("/api/dismissed-confirmations")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"values":[" first ","first",3,"second"]}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(dismissed.status(), StatusCode::OK);

    let ui = app
        .clone()
        .oneshot(
            Request::get("/api/ui-preferences")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let ui: serde_json::Value =
        serde_json::from_slice(&to_bytes(ui.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(
        ui,
        serde_json::json!({ "language": "zh-CN", "theme": "light" })
    );
    let dismissed = app
        .clone()
        .oneshot(
            Request::get("/api/dismissed-confirmations")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let dismissed: serde_json::Value =
        serde_json::from_slice(&to_bytes(dismissed.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(
        dismissed,
        serde_json::json!({ "values": ["first", "second"] })
    );

    let settings: serde_json::Value = serde_json::from_slice(
        &std::fs::read(data_root.join("settings.json")).expect("persisted settings"),
    )
    .expect("valid settings JSON");
    assert_eq!(settings["editor"]["fontSize"], 18);
    assert_eq!(settings["custom"]["enabled"], true);
    assert_eq!(settings["ui"]["language"], "zh-CN");
    assert_eq!(
        settings["uiState"]["dismissedConfirmations"],
        serde_json::json!(["first", "second"])
    );

    let workspaces = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let workspaces: serde_json::Value =
        serde_json::from_slice(&to_bytes(workspaces.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(workspaces["workspaces"][0]["id"], "demo");
    let workspace_root = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/root")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let workspace_root: serde_json::Value = serde_json::from_slice(
        &to_bytes(workspace_root.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(
        workspace_root["path"],
        root.to_string_lossy().as_ref(),
        "the configured workspace path must not expose canonicalization internals"
    );
    let opened = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(opened.status(), StatusCode::OK);
    let opened_projects: serde_json::Value = serde_json::from_slice(
        &std::fs::read(data_root.join("opened-projects.json")).expect("opened projects"),
    )
    .expect("valid opened projects JSON");
    assert_eq!(opened_projects["projects"][0]["name"], "demo");

    let switched = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/root")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({ "path": next_root })).unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(switched.status(), StatusCode::OK);
    let switched_workspaces = app
        .oneshot(
            Request::get("/api/workspaces")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let switched_workspaces: serde_json::Value = serde_json::from_slice(
        &to_bytes(switched_workspaces.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(switched_workspaces["workspaces"][0]["id"], "alpha");
    assert_eq!(switched_workspaces["workspaces"][1]["id"], "zeta");
    let workspace_root: serde_json::Value = serde_json::from_slice(
        &std::fs::read(data_root.join("workspace-root.json")).expect("workspace root config"),
    )
    .expect("valid workspace root JSON");
    assert_eq!(
        PathBuf::from(workspace_root["root"].as_str().unwrap()),
        std::fs::canonicalize(&next_root).unwrap()
    );

    std::fs::remove_dir_all(root).ok();
    std::fs::remove_dir_all(next_root).ok();
}

#[tokio::test]
async fn workspace_file_routes_preserve_crud_errors_cache_and_etag_contracts() {
    let root = temp_path("file-contract");
    std::fs::create_dir_all(root.join("demo/node_modules/package")).unwrap();
    std::fs::create_dir_all(root.join("demo/src")).unwrap();
    std::fs::write(root.join("demo/note.txt"), "hello").unwrap();
    std::fs::write(root.join("demo/binary.bin"), [b'a', 0, b'b']).unwrap();
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let tree = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/fs/tree?path=")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(tree.status(), StatusCode::OK);
    let tree: serde_json::Value =
        serde_json::from_slice(&to_bytes(tree.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(!tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .any(|entry| entry["name"] == "node_modules"));
    let note = tree["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "note.txt")
        .unwrap();
    assert!(note.get("size").is_none());

    let detailed = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/fs/tree?path=&metadata=true")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let detailed: serde_json::Value =
        serde_json::from_slice(&to_bytes(detailed.into_body(), usize::MAX).await.unwrap()).unwrap();
    let note = detailed["entries"]
        .as_array()
        .unwrap()
        .iter()
        .find(|entry| entry["name"] == "note.txt")
        .unwrap();
    assert_eq!(note["size"], 5);
    assert!(note["mtime"].is_number());

    let first = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/fs/file?path=note.txt")
                .header(header::COOKIE, &cookie)
                .header("x-osheep-file-open-id", "trace-rust-file")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(first.status(), StatusCode::OK);
    assert_eq!(first.headers()["x-osheep-file-open-id"], "trace-rust-file");
    assert_eq!(first.headers()["x-osheep-file-cache"], "miss");
    assert_eq!(first.headers()["x-osheep-file-io-diagnostic"], "normal");
    assert!(first.headers()["server-timing"]
        .to_str()
        .unwrap()
        .starts_with("osheep-file-read;dur="));
    let etag = first.headers()[header::ETAG].to_str().unwrap().to_owned();
    let first_body: serde_json::Value =
        serde_json::from_slice(&to_bytes(first.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(first_body["content"], "hello");

    let revalidated = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/fs/file?path=note.txt")
                .header(header::COOKIE, &cookie)
                .header(header::IF_NONE_MATCH, &etag)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(revalidated.status(), StatusCode::NOT_MODIFIED);
    assert_eq!(revalidated.headers()["x-osheep-file-cache"], "hit");

    let written = app
        .clone()
        .oneshot(
            Request::put("/api/workspaces/demo/fs/file")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"path":"note.txt","content":"updated"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(written.status(), StatusCode::OK);
    let after_write = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/fs/file?path=note.txt")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(after_write.headers()["x-osheep-file-cache"], "miss");
    assert_ne!(after_write.headers()[header::ETAG], etag.as_str());

    let large_content = "x".repeat(3 * 1024 * 1024);
    let large_body = serde_json::to_vec(&serde_json::json!({
        "path": "large.txt",
        "content": large_content
    }))
    .unwrap();
    let large_write = app
        .clone()
        .oneshot(
            Request::put("/api/workspaces/demo/fs/file")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(large_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(large_write.status(), StatusCode::OK);
    assert_eq!(
        std::fs::metadata(root.join("demo/large.txt"))
            .unwrap()
            .len(),
        3 * 1024 * 1024
    );

    let binary = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/fs/file?path=binary.bin")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(binary.status(), StatusCode::UNSUPPORTED_MEDIA_TYPE);
    let binary: serde_json::Value =
        serde_json::from_slice(&to_bytes(binary.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(binary["error"]["code"], "BINARY_FILE");

    let outside = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/fs/file?path=..%2Foutside.txt")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(outside.status(), StatusCode::FORBIDDEN);

    let created = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/fs/entry")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"path":"docs","kind":"directory"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let moved = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/fs/move")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"from":"note.txt","to":"docs/note.txt"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(moved.status(), StatusCode::OK);
    let copied = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/fs/copy")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"from":"docs/note.txt","to":"copied.txt"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(copied.status(), StatusCode::OK);

    let workspace_created = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"name":"created-workspace"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(workspace_created.status(), StatusCode::OK);
    assert!(root.join("created-workspace/.osheep/docs").is_dir());
    assert!(root
        .join("created-workspace/.osheep/settings.json")
        .is_file());

    let settings_put = app
        .clone()
        .oneshot(
            Request::put("/api/workspaces/demo/settings")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"editor":{"fontSize":20,"tabSize":4}}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(settings_put.status(), StatusCode::OK);
    let settings_get = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/settings")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let settings: serde_json::Value = serde_json::from_slice(
        &to_bytes(settings_get.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(settings["editor"]["fontSize"], 20);

    let image_written = app
        .clone()
        .oneshot(
            Request::put("/api/workspaces/demo/fs/file")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"path":"pixel.png","contentBase64":"iVBORw0KGgo="}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(image_written.status(), StatusCode::OK);
    let image = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/fs/image?path=pixel.png")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(image.status(), StatusCode::OK);
    assert_eq!(image.headers()[header::CONTENT_TYPE], "image/png");
    assert_eq!(
        to_bytes(image.into_body(), usize::MAX).await.unwrap(),
        &[0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a][..]
    );

    let external = root.with_file_name(format!(
        "{}-external.txt",
        root.file_name().unwrap().to_string_lossy()
    ));
    std::fs::write(&external, "external text").unwrap();
    let external_body = serde_json::to_vec(&serde_json::json!({ "path": external })).unwrap();
    let external_read = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/fs/external-read")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(external_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(external_read.status(), StatusCode::OK);
    let external_read: serde_json::Value = serde_json::from_slice(
        &to_bytes(external_read.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(external_read["content"], "external text");
    let copy_external_body = serde_json::to_vec(&serde_json::json!({
        "sourcePath": external,
        "targetPath": "external-copy.txt"
    }))
    .unwrap();
    let external_copy = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/fs/copy-external")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(copy_external_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(external_copy.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(root.join("demo/external-copy.txt")).unwrap(),
        "external text"
    );

    let deleted = app
        .oneshot(
            Request::delete("/api/workspaces/demo/fs/entry?path=docs&recursive=true")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(root.join("demo/copied.txt")).unwrap(),
        "updated"
    );
    std::fs::remove_file(external).ok();
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn workspace_search_route_preserves_filters_limits_and_error_contracts() {
    let root = temp_path("search-contract");
    std::fs::create_dir_all(root.join("demo/src/skip")).unwrap();
    std::fs::write(
        root.join("demo/src/main.ts"),
        "Alpha alphabet\nemoji \u{1f600} alpha alpha",
    )
    .unwrap();
    std::fs::write(root.join("demo/src/skip/ignored.ts"), "alpha").unwrap();
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let searched = app
        .clone()
        .oneshot(
            Request::get(
                "/api/workspaces/demo/search?query=alpha&wholeWord=1&include=src%2F**%2F*.ts&exclude=src%2Fskip%2F**&maxMatchesPerFile=1suffix",
            )
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(searched.status(), StatusCode::OK);
    let searched: serde_json::Value =
        serde_json::from_slice(&to_bytes(searched.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(searched["filesScanned"], 1);
    assert_eq!(searched["truncated"], true);
    assert_eq!(searched["matches"][0]["path"], "src/main.ts");
    assert_eq!(searched["matches"][0]["lines"].as_array().unwrap().len(), 1);
    assert_eq!(searched["matches"][0]["lines"][0]["line"], 1);
    assert_eq!(searched["matches"][0]["lines"][0]["column"], 1);

    let unicode = app
        .clone()
        .oneshot(
            Request::get(
                "/api/workspaces/demo/search?query=alpha&wholeWord=true&include=src%2Fmain.ts",
            )
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    let unicode: serde_json::Value =
        serde_json::from_slice(&to_bytes(unicode.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(unicode["matches"][0]["lines"][1]["column"], 10);

    let missing_query = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/search")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_query.status(), StatusCode::BAD_REQUEST);
    let missing_query: serde_json::Value = serde_json::from_slice(
        &to_bytes(missing_query.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(missing_query["error"]["code"], "INVALID_QUERY");

    let invalid = app
        .oneshot(
            Request::get("/api/workspaces/demo/search?query=%5B&regex=1")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let invalid: serde_json::Value =
        serde_json::from_slice(&to_bytes(invalid.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(invalid["error"]["code"], "INVALID_QUERY");
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn git_read_routes_match_repo_status_and_content_contracts() {
    let root = temp_path("git-contract");
    let repo = root.join("demo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(root.join("plain")).unwrap();
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "Osheep Test"]);
    run_git(&repo, &["config", "user.email", "git-test@osheep.invalid"]);
    run_git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("tracked.txt"), "base\n").unwrap();
    std::fs::write(repo.join(".gitignore"), "dist/\n").unwrap();
    run_git(&repo, &["add", "tracked.txt", ".gitignore"]);
    run_git(&repo, &["commit", "-m", "initial"]);
    std::fs::write(repo.join("tracked.txt"), "index\n").unwrap();
    run_git(&repo, &["add", "tracked.txt"]);
    std::fs::write(repo.join("tracked.txt"), "worktree\n").unwrap();
    std::fs::create_dir_all(repo.join("dist")).unwrap();
    std::fs::write(repo.join("dist/bundle.js"), "ignored\n").unwrap();
    std::fs::write(repo.join("untracked.txt"), "new\n").unwrap();

    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let repo_info = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/repo")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(repo_info.status(), StatusCode::OK);
    let repo_info: serde_json::Value =
        serde_json::from_slice(&to_bytes(repo_info.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(repo_info["isRepo"], true);
    assert_eq!(repo_info["branch"], "main");
    assert_eq!(repo_info["detached"], false);
    assert_eq!(repo_info["ahead"], 0);
    assert_eq!(repo_info["behind"], 0);
    assert!(repo_info["head"].as_str().unwrap().len() >= 40);
    assert!(repo_info["upstream"].is_null());

    let status = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/status")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(status.status(), StatusCode::OK);
    let status: serde_json::Value =
        serde_json::from_slice(&to_bytes(status.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(status["ignoredPaths"]
        .as_array()
        .unwrap()
        .iter()
        .any(|path| path == "dist"));
    let tracked = status["changes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|change| change["path"] == "tracked.txt")
        .unwrap();
    assert_eq!(tracked["indexStatus"], "M");
    assert_eq!(tracked["worktreeStatus"], "M");
    assert!(tracked["renamedFrom"].is_null());

    let diff = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/diff?path=tracked.txt")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let diff: serde_json::Value =
        serde_json::from_slice(&to_bytes(diff.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(diff["base"], "HEAD");
    assert_eq!(diff["head"], "WORKTREE");
    assert_eq!(diff["leftContent"], "base\n");
    assert_eq!(diff["rightContent"], "worktree\n");
    assert_eq!(diff["leftMissing"], false);
    assert_eq!(diff["rightMissing"], false);
    assert_eq!(diff["binary"], false);

    let staged = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/diff?path=tracked.txt&base=INDEX&head=WORKTREE")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let staged: serde_json::Value =
        serde_json::from_slice(&to_bytes(staged.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(staged["leftContent"], "index\n");

    let invalid_ref = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/diff?path=tracked.txt&base=main")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid_ref.status(), StatusCode::BAD_REQUEST);
    let invalid_ref: serde_json::Value =
        serde_json::from_slice(&to_bytes(invalid_ref.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(invalid_ref["error"]["code"], "INVALID_REF");

    let outside = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/diff?path=..%2Foutside.txt")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(outside.status(), StatusCode::BAD_REQUEST);
    let outside: serde_json::Value =
        serde_json::from_slice(&to_bytes(outside.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(outside["error"]["code"], "INVALID_PATH");

    let plain_repo = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/plain/git/repo")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let plain_repo: serde_json::Value =
        serde_json::from_slice(&to_bytes(plain_repo.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(plain_repo, serde_json::json!({ "isRepo": false }));

    let plain_status = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/plain/git/status")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let plain_status: serde_json::Value = serde_json::from_slice(
        &to_bytes(plain_status.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(plain_status["isRepo"], false);
    assert_eq!(plain_status["changes"], serde_json::json!([]));
    assert_eq!(plain_status["ignoredPaths"], serde_json::json!([]));

    let plain_diff = app
        .oneshot(
            Request::get("/api/workspaces/plain/git/diff?path=file.txt")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(plain_diff.status(), StatusCode::CONFLICT);
    let plain_diff: serde_json::Value =
        serde_json::from_slice(&to_bytes(plain_diff.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(plain_diff["error"]["code"], "NOT_A_REPO");

    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn git_metadata_and_history_routes_match_node_contracts() {
    let root = temp_path("git-history-contract");
    let repo = root.join("demo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(root.join("plain")).unwrap();
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "Osheep Test"]);
    run_git(&repo, &["config", "user.email", "git-test@osheep.invalid"]);
    run_git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("README.md"), "first\n").unwrap();
    run_git(&repo, &["add", "README.md"]);
    run_git(&repo, &["commit", "-m", "initial"]);
    let first = run_git_output(&repo, &["rev-parse", "HEAD"]);
    run_git(&repo, &["branch", "feature"]);
    run_git(
        &repo,
        &["remote", "add", "zeta", "https://example.invalid/zeta.git"],
    );
    run_git(
        &repo,
        &[
            "remote",
            "add",
            "origin",
            "https://example.invalid/origin.git",
        ],
    );
    std::fs::write(repo.join("README.md"), "first\nsecond\n").unwrap();
    std::fs::write(repo.join("binary.dat"), [0_u8, 1, 2, 3]).unwrap();
    run_git(&repo, &["add", "README.md", "binary.dat"]);
    run_git(
        &repo,
        &["commit", "-m", "show details", "-m", "Commit body"],
    );
    let second = run_git_output(&repo, &["rev-parse", "HEAD"]);
    run_git(&repo, &["update-ref", "refs/remotes/origin/main", &second]);
    run_git(&repo, &["branch", "--set-upstream-to=origin/main", "main"]);

    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let remotes = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/remotes")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(remotes.status(), StatusCode::OK);
    let remotes: serde_json::Value =
        serde_json::from_slice(&to_bytes(remotes.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(remotes["remotes"][0]["name"], "origin");
    assert_eq!(remotes["remotes"][1]["name"], "zeta");
    assert_eq!(
        remotes["remotes"][0]["url"],
        "https://example.invalid/origin.git"
    );

    let branches = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/branches")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(branches.status(), StatusCode::OK);
    let branches: serde_json::Value =
        serde_json::from_slice(&to_bytes(branches.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(branches["current"], "main");
    assert_eq!(branches["detached"], false);
    let main = branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .find(|branch| branch["name"] == "main")
        .unwrap();
    assert_eq!(main["isCurrent"], true);
    assert_eq!(main["kind"], "local");
    assert_eq!(main["upstream"], "origin/main");
    assert!(branches["branches"]
        .as_array()
        .unwrap()
        .iter()
        .any(|branch| branch["name"] == "origin/main" && branch["kind"] == "remote"));

    let log = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/log?limit=1suffix&offset=1suffix&ref=HEAD")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(log.status(), StatusCode::OK);
    let log: serde_json::Value =
        serde_json::from_slice(&to_bytes(log.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(log["commits"].as_array().unwrap().len(), 1);
    assert_eq!(log["commits"][0]["sha"], first);
    assert_eq!(log["commits"][0]["shortSha"], &first[..7]);
    assert_eq!(log["head"], second);
    assert_eq!(log["currentRef"], "refs/heads/main");
    assert_eq!(log["currentRemoteRef"], "refs/remotes/origin/main");

    let option_like_ref = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/log?ref=--pretty%3Dformat%3Auntrusted")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(option_like_ref.status(), StatusCode::BAD_REQUEST);
    let option_like_ref: serde_json::Value = serde_json::from_slice(
        &to_bytes(option_like_ref.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(option_like_ref["error"]["code"], "INVALID_REF");

    let details = app
        .clone()
        .oneshot(
            Request::get(format!("/api/workspaces/demo/git/commits/{second}"))
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(details.status(), StatusCode::OK);
    let details: serde_json::Value =
        serde_json::from_slice(&to_bytes(details.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(details["author"], "Osheep Test");
    assert_eq!(details["authorEmail"], "git-test@osheep.invalid");
    assert_eq!(details["message"], "show details\n\nCommit body");
    assert_eq!(details["filesChanged"], 2);
    assert_eq!(details["insertions"], 1);
    let binary = details["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|file| file["path"] == "binary.dat")
        .unwrap();
    assert_eq!(binary["binary"], true);
    assert!(binary["insertions"].is_null());

    let diff = app
        .clone()
        .oneshot(
            Request::get(format!(
                "/api/workspaces/demo/git/commits/{second}/diff?path=README.md"
            ))
            .header(header::COOKIE, &cookie)
            .body(Body::empty())
            .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(diff.status(), StatusCode::OK);
    let diff: serde_json::Value =
        serde_json::from_slice(&to_bytes(diff.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(diff["base"], first);
    assert_eq!(diff["head"], second);
    assert_eq!(diff["leftContent"], "first\n");
    assert_eq!(diff["rightContent"], "first\nsecond\n");

    let invalid = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/demo/git/commits/not-a-sha")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let invalid: serde_json::Value =
        serde_json::from_slice(&to_bytes(invalid.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(invalid["error"]["code"], "INVALID_REF");

    let plain_log = app
        .clone()
        .oneshot(
            Request::get("/api/workspaces/plain/git/log")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(plain_log.status(), StatusCode::OK);
    let plain_log: serde_json::Value =
        serde_json::from_slice(&to_bytes(plain_log.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(
        plain_log,
        serde_json::json!({ "commits": [], "head": null })
    );

    let plain_missing_path = app
        .oneshot(
            Request::get("/api/workspaces/plain/git/commits/not-a-sha/diff")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(plain_missing_path.status(), StatusCode::CONFLICT);
    let plain_missing_path: serde_json::Value = serde_json::from_slice(
        &to_bytes(plain_missing_path.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(plain_missing_path["error"]["code"], "NOT_A_REPO");

    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn git_write_routes_match_node_mutation_contracts() {
    let root = temp_path("git-write-contract");
    let repo = root.join("demo");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(root.join("plain")).unwrap();
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let init = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/init")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(init.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &to_bytes(init.into_body(), usize::MAX).await.unwrap()
        )
        .unwrap(),
        serde_json::json!({"ok": true})
    );

    run_git(&repo, &["config", "user.name", "Osheep Test"]);
    run_git(&repo, &["config", "user.email", "git-test@osheep.invalid"]);
    run_git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("tracked.txt"), "base\n").unwrap();
    let stage_body = serde_json::to_vec(&serde_json::json!({"paths": ["tracked.txt"]})).unwrap();
    let stage = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/stage")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(stage_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stage.status(), StatusCode::OK);
    let commit_body = serde_json::to_vec(&serde_json::json!({"message": "initial"})).unwrap();
    let commit = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/commit")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(commit_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(commit.status(), StatusCode::OK);
    let commit: serde_json::Value =
        serde_json::from_slice(&to_bytes(commit.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(commit["ok"], true);
    let head = commit["head"].as_str().unwrap().to_owned();
    assert_eq!(head.len(), 40);

    std::fs::write(repo.join("tracked.txt"), "changed\n").unwrap();
    let stage_body = serde_json::to_vec(&serde_json::json!({"paths": ["tracked.txt"]})).unwrap();
    let stage = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/stage")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(stage_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(stage.status(), StatusCode::OK);
    let unstage_body = serde_json::to_vec(&serde_json::json!({"paths": ["tracked.txt"]})).unwrap();
    let unstage = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/unstage")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(unstage_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(unstage.status(), StatusCode::OK);

    std::fs::write(repo.join("untracked.txt"), "remove\n").unwrap();
    let discard_body =
        serde_json::to_vec(&serde_json::json!({"paths": ["tracked.txt", "untracked.txt"]}))
            .unwrap();
    let discard = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/discard")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(discard_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(discard.status(), StatusCode::OK);
    let discard: serde_json::Value =
        serde_json::from_slice(&to_bytes(discard.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(
        discard["discarded"],
        serde_json::json!(["tracked.txt", "untracked.txt"])
    );
    assert_eq!(
        std::fs::read_to_string(repo.join("tracked.txt")).unwrap(),
        "base\n"
    );
    assert!(!repo.join("untracked.txt").exists());

    let remote_body = serde_json::to_vec(
        &serde_json::json!({"name": "origin", "url": "https://example.invalid/repo.git"}),
    )
    .unwrap();
    let remote = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/remotes")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(remote_body.clone()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(remote.status(), StatusCode::OK);
    let duplicate = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/remotes")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(remote_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(duplicate.status(), StatusCode::CONFLICT);
    let duplicate: serde_json::Value =
        serde_json::from_slice(&to_bytes(duplicate.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(duplicate["error"]["code"], "ENTRY_EXISTS");
    let removed = app
        .clone()
        .oneshot(
            Request::delete("/api/workspaces/demo/git/remotes/origin")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(removed.status(), StatusCode::OK);

    let invalid_paths = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/stage")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"paths":[42]}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid_paths.status(), StatusCode::BAD_REQUEST);
    let invalid_paths: serde_json::Value = serde_json::from_slice(
        &to_bytes(invalid_paths.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(invalid_paths["error"]["code"], "INVALID_PATH");

    let invalid_message = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/commit")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"message":42}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid_message.status(), StatusCode::BAD_REQUEST);
    let invalid_message: serde_json::Value = serde_json::from_slice(
        &to_bytes(invalid_message.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(invalid_message["error"]["code"], "EMPTY_COMMIT_MESSAGE");

    let initial_branch = run_git_output(&repo, &["symbolic-ref", "--short", "HEAD"]);
    let checkout_body =
        serde_json::to_vec(&serde_json::json!({"ref": "feature", "create": true})).unwrap();
    let checkout = app
        .clone()
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/checkout")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(checkout_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(checkout.status(), StatusCode::OK);
    assert_eq!(
        run_git_output(&repo, &["symbolic-ref", "--short", "HEAD"]),
        "feature"
    );
    let checkout_body = serde_json::to_vec(&serde_json::json!({"ref": initial_branch})).unwrap();
    let checkout = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/checkout")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(checkout_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(checkout.status(), StatusCode::OK);

    let plain_stage_body = serde_json::to_vec(&serde_json::json!({"paths": ["x.txt"]})).unwrap();
    let plain_stage = app
        .oneshot(
            Request::post("/api/workspaces/plain/git/stage")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(plain_stage_body))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(plain_stage.status(), StatusCode::CONFLICT);
    let plain_stage: serde_json::Value =
        serde_json::from_slice(&to_bytes(plain_stage.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(plain_stage["error"]["code"], "NOT_A_REPO");

    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn git_network_routes_match_node_contracts() {
    let root = temp_path("git-network-http");
    let repo = root.join("demo");
    let plain = root.join("plain");
    let remote = temp_path("git-network-remote");
    let clone = temp_path("git-network-clone");
    std::fs::create_dir_all(&repo).unwrap();
    std::fs::create_dir_all(&plain).unwrap();
    std::fs::create_dir_all(&remote).unwrap();
    std::fs::create_dir_all(&clone).unwrap();
    run_git(&remote, &["init", "--bare"]);
    run_git(&repo, &["init", "-b", "main"]);
    run_git(&repo, &["config", "user.name", "Osheep Test"]);
    run_git(&repo, &["config", "user.email", "git-test@osheep.invalid"]);
    run_git(&repo, &["config", "core.autocrlf", "false"]);
    std::fs::write(repo.join("README.md"), "first\n").unwrap();
    run_git(&repo, &["add", "README.md"]);
    run_git(&repo, &["commit", "-m", "initial"]);
    run_git(
        &repo,
        &["remote", "add", "origin", remote.to_str().unwrap()],
    );

    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth.headers()[header::SET_COOKIE]
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let push = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/push")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    serde_json::to_vec(&serde_json::json!({
                        "remote": "origin",
                        "branch": "main",
                        "setUpstream": true
                    }))
                    .unwrap(),
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(push.status(), StatusCode::OK);
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(
            &to_bytes(push.into_body(), usize::MAX).await.unwrap(),
        )
        .unwrap(),
        serde_json::json!({"ok": true})
    );
    run_git(&remote, &["symbolic-ref", "HEAD", "refs/heads/main"]);

    run_git(&clone, &["clone", remote.to_str().unwrap(), "."]);
    run_git(&clone, &["config", "user.name", "Clone Test"]);
    run_git(&clone, &["config", "user.email", "clone@osheep.invalid"]);
    std::fs::write(clone.join("README.md"), "first\nsecond\n").unwrap();
    run_git(&clone, &["add", "README.md"]);
    run_git(&clone, &["commit", "-m", "remote update"]);
    run_git(&clone, &["push", "origin", "main"]);

    let fetch = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/fetch")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"remote":"origin","prune":true}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(fetch.status(), StatusCode::OK);
    let pull = app
        .clone()
        .oneshot(
            Request::post("/api/workspaces/demo/git/pull")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"remote":"origin","branch":"main"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(pull.status(), StatusCode::OK);
    assert_eq!(
        std::fs::read_to_string(repo.join("README.md")).unwrap(),
        "first\nsecond\n"
    );

    for (path, body, code) in [
        (
            "/api/workspaces/demo/git/fetch",
            r#"{"remote":"--bad"}"#,
            "INVALID_PATH",
        ),
        (
            "/api/workspaces/demo/git/pull",
            r#"{"remote":"origin","branch":"../bad"}"#,
            "INVALID_REF",
        ),
        (
            "/api/workspaces/demo/git/push",
            r#"{"setUpstream":true}"#,
            "INVALID_PATH",
        ),
    ] {
        let response = app
            .clone()
            .oneshot(
                Request::post(path)
                    .header(header::COOKIE, &cookie)
                    .header(header::CONTENT_TYPE, "application/json")
                    .body(Body::from(body))
                    .unwrap(),
            )
            .await
            .unwrap();
        assert_eq!(response.status(), StatusCode::BAD_REQUEST);
        let payload: serde_json::Value =
            serde_json::from_slice(&to_bytes(response.into_body(), usize::MAX).await.unwrap())
                .unwrap();
        assert_eq!(payload["error"]["code"], code);
    }

    let plain_push = app
        .oneshot(
            Request::post("/api/workspaces/plain/git/push")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"remote":"origin"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(plain_push.status(), StatusCode::CONFLICT);
    let payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(plain_push.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(payload["error"]["code"], "NOT_A_REPO");

    std::fs::remove_dir_all(root).ok();
    std::fs::remove_dir_all(remote).ok();
    std::fs::remove_dir_all(clone).ok();
}

#[tokio::test]
async fn cross_site_requests_and_unknown_api_routes_are_rejected() {
    let root = temp_path("origin-contract");
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let cross_site = app
        .clone()
        .oneshot(
            Request::get("/api/health")
                .header(header::ORIGIN, "https://example.com")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(cross_site.status(), StatusCode::FORBIDDEN);

    let missing = app
        .oneshot(Request::get("/api/missing").body(Body::empty()).unwrap())
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    let missing = to_bytes(missing.into_body(), usize::MAX).await.unwrap();
    assert_eq!(
        serde_json::from_slice::<serde_json::Value>(&missing).unwrap()["error"]["code"],
        "NOT_FOUND"
    );
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn static_site_keeps_spa_and_asset_miss_behavior() {
    let root = temp_path("static-workspaces");
    let frontend = temp_path("static-frontend");
    std::fs::create_dir_all(frontend.join("assets")).unwrap();
    std::fs::write(frontend.join("index.html"), "<main>osheep</main>").unwrap();
    std::fs::write(frontend.join("assets/app.js"), "console.log('osheep')").unwrap();
    let app = build_app(
        test_config(root.clone(), Some(frontend.clone())),
        Arc::new(ContractRuntime),
    )
    .await
    .unwrap();

    let spa = app
        .clone()
        .oneshot(
            Request::get("/workspaces/demo")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(spa.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(spa.into_body(), usize::MAX).await.unwrap(),
        "<main>osheep</main>"
    );

    let asset_miss = app
        .oneshot(
            Request::get("/assets/missing.js")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(asset_miss.status(), StatusCode::NOT_FOUND);

    std::fs::remove_dir_all(root).ok();
    std::fs::remove_dir_all(frontend).ok();
}

#[tokio::test]
async fn terminal_create_list_and_delete_match_node_contract() {
    let root = temp_path("terminal-crud");
    std::fs::create_dir_all(root.join("demo")).unwrap();
    let app = build_app(
        test_config(root.clone(), None),
        Arc::new(CrudRuntime::default()),
    )
    .await
    .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let created = app
        .clone()
        .oneshot(
            Request::post("/api/terminals")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(
                    r#"{"workspaceId":"demo","shell":"powershell","cols":100,"rows":30}"#,
                ))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(created.status(), StatusCode::OK);
    let created: serde_json::Value =
        serde_json::from_slice(&to_bytes(created.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(created["id"], "t_contract");
    assert_eq!(created["wsUrl"], "/api/terminals/t_contract/io");
    assert_eq!(created["cols"], 100);

    let listed = app
        .clone()
        .oneshot(
            Request::get("/api/terminals")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let listed: serde_json::Value =
        serde_json::from_slice(&to_bytes(listed.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(listed["sessions"][0]["workspaceId"], "demo");
    assert_eq!(listed["sessions"][0]["createdAt"], 123);

    let deleted = app
        .clone()
        .oneshot(
            Request::delete("/api/terminals/t_contract")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(deleted.status(), StatusCode::OK);
    assert_eq!(
        to_bytes(deleted.into_body(), usize::MAX).await.unwrap(),
        r#"{"id":"t_contract"}"#
    );

    let missing = app
        .oneshot(
            Request::delete("/api/terminals/t_contract")
                .header(header::COOKIE, cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn agent_session_routes_validate_app_and_workspace_query() {
    let root = temp_path("agent-session-query");
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let invalid_app = app
        .clone()
        .oneshot(
            Request::get("/api/agent-sessions?app=other&workspaceId=demo")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid_app.status(), StatusCode::BAD_REQUEST);
    let payload: serde_json::Value =
        serde_json::from_slice(&to_bytes(invalid_app.into_body(), usize::MAX).await.unwrap())
            .unwrap();
    assert_eq!(payload["error"]["code"], "INVALID_QUERY");

    let missing_workspace = app
        .oneshot(
            Request::get("/api/agent-sessions?app=claude")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(missing_workspace.status(), StatusCode::BAD_REQUEST);
    let payload: serde_json::Value = serde_json::from_slice(
        &to_bytes(missing_workspace.into_body(), usize::MAX)
            .await
            .unwrap(),
    )
    .unwrap();
    assert_eq!(payload["error"]["code"], "INVALID_QUERY");
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn claude_onboarding_route_matches_node_validation_contract() {
    let root = temp_path("claude-onboarding-contract");
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let invalid = app
        .clone()
        .oneshot(
            Request::put("/api/claude/onboarding-skip")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"enabled":"yes"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(invalid.status(), StatusCode::BAD_REQUEST);
    let body: serde_json::Value =
        serde_json::from_slice(&to_bytes(invalid.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(body["error"]["code"], "INVALID_QUERY");
    std::fs::remove_dir_all(root).ok();
}

#[tokio::test]
async fn ai_settings_routes_preserve_rendering_and_provider_contracts() {
    let root = temp_path("ai-settings-contract");
    let app = build_app(test_config(root.clone(), None), Arc::new(ContractRuntime))
        .await
        .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    let snapshot = app
        .clone()
        .oneshot(
            Request::get("/api/ai-settings")
                .header(header::COOKIE, &cookie)
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(snapshot.status(), StatusCode::OK);
    let snapshot: serde_json::Value =
        serde_json::from_slice(&to_bytes(snapshot.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert!(snapshot["paths"]["claude"]["settings"].is_string());
    assert!(snapshot["paths"]["codex"]["config"].is_string());
    assert!(snapshot["state"]["apps"]["claude"]["providers"].is_object());

    let provider = serde_json::json!({
        "app": "codex",
        "provider": {
            "id": "contract-provider",
            "name": "Contract provider",
            "settingsConfig": {"auth": {}, "config": ""}
        }
    });
    let saved = app
        .clone()
        .oneshot(
            Request::post("/api/ai-settings/providers")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(serde_json::to_vec(&provider).unwrap()))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(saved.status(), StatusCode::OK);
    let saved: serde_json::Value =
        serde_json::from_slice(&to_bytes(saved.into_body(), usize::MAX).await.unwrap()).unwrap();
    assert_eq!(
        saved["state"]["apps"]["codex"]["current"],
        "contract-provider"
    );

    let switched = app
        .clone()
        .oneshot(
            Request::post("/api/ai-settings/switch")
                .header(header::COOKIE, &cookie)
                .header(header::CONTENT_TYPE, "application/json")
                .body(Body::from(r#"{"app":"codex","id":"contract-provider"}"#))
                .unwrap(),
        )
        .await
        .unwrap();
    assert_eq!(switched.status(), StatusCode::OK);
    let persisted: serde_json::Value = serde_json::from_slice(
        &std::fs::read(root.join(".state/ai-settings.json")).expect("persisted AI settings"),
    )
    .unwrap();
    assert_eq!(persisted["apps"]["codex"]["current"], "contract-provider");
    std::fs::remove_dir_all(root).ok();
}
