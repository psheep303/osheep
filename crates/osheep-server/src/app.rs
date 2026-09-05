use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::runtime::{RuntimeClientError, RuntimeControl};
use crate::security::{require_origin, require_session, Security, SecurityError};
use crate::static_site;
use axum::extract::ws::{Message, WebSocket};
use axum::extract::{DefaultBodyLimit, Path as AxumPath, Query, State, WebSocketUpgrade};
use axum::http::{header, HeaderMap, HeaderName, HeaderValue, Method, StatusCode, Uri};
use axum::middleware;
use axum::response::{IntoResponse, Response};
use axum::routing::{delete, get, patch, post, put};
use axum::{Json, Router};
use futures_util::{SinkExt, StreamExt};
use osheep_contract::{
    CreateTerminalRequest, CreateTerminalResponse, DeleteTerminalResponse, HealthResponse,
    RuntimeClientRequest, RuntimeClientResponse, RuntimeHealthResponse, ServerTerminalFrame,
    ShellProfilesResponse, TerminalSessionsResponse,
};
use osheep_core::{
    ensure_workspace_layout, AgentRecord, AgentService, AgentSessionApp, AgentSessionService,
    ClaudeOnboardingService, EntryKind, FileService, FileServiceConfig, GitBranches,
    GitCommitDetails, GitCommitDiff, GitDiff, GitLog, GitRepoInfo, GitService, GitServiceConfig,
    GitStatus, SearchOptions, SearchService, SearchServiceConfig, SessionRecord, SessionService,
    StateStore, WorkspaceResolver,
};
use osheep_pty::{PtyEvent, PtyRuntime, PtySession, SpawnRequest};
use serde::Deserialize;
use serde_json::Value;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::{broadcast, Mutex};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

const TERMINAL_REPLAY_CHUNK_BYTES: usize = 64 * 1024;

#[derive(Clone)]
pub struct AppState {
    security: Arc<Security>,
    workspaces: Arc<WorkspaceResolver>,
    store: Arc<StateStore>,
    workspace_root_updates: Arc<Mutex<()>>,
    allow_external_workspace_paths: bool,
    files: Arc<FileService>,
    search: Arc<SearchService>,
    git: Arc<GitService>,
    sessions: Arc<SessionService>,
    agent_sessions: Arc<AgentSessionService>,
    agents: Arc<AgentService>,
    claude_onboarding: Arc<ClaudeOnboardingService>,
    sync_roots: Arc<Vec<PathBuf>>,
    pty: Arc<dyn PtyRuntime>,
    frontend_root: Option<PathBuf>,
    runtime: Option<Arc<RuntimeControl>>,
    p6_state: Arc<Mutex<Value>>,
}

#[derive(Debug, thiserror::Error)]
pub enum AppBuildError {
    #[error(transparent)]
    Security(#[from] SecurityError),
    #[error(transparent)]
    Workspace(#[from] osheep_core::WorkspaceError),
    #[error(transparent)]
    State(#[from] osheep_core::StateError),
}

pub async fn build_app(
    config: ServerConfig,
    pty: Arc<dyn PtyRuntime>,
) -> Result<Router, AppBuildError> {
    build_app_with_runtime(config, pty, None).await
}

pub async fn build_app_with_runtime(
    config: ServerConfig,
    pty: Arc<dyn PtyRuntime>,
    runtime: Option<Arc<RuntimeControl>>,
) -> Result<Router, AppBuildError> {
    let security = Arc::new(Security::new(
        &config.host,
        &config.cors_origins,
        config.auth_token,
    )?);
    let workspaces = Arc::new(WorkspaceResolver::new(config.workspaces_root));
    workspaces.ensure_root().await?;
    let store = Arc::new(StateStore::new(config.data_root));
    store.initialize().await?;
    let files = Arc::new(FileService::new(FileServiceConfig {
        max_file_size: config.max_file_size_bytes,
        ..FileServiceConfig::default()
    }));
    let search = Arc::new(SearchService::new(SearchServiceConfig::default()));
    let git = Arc::new(GitService::new(GitServiceConfig::default()));
    let sessions = Arc::new(SessionService::new());
    let agent_sessions = Arc::new(AgentSessionService::new());
    let agents = Arc::new(AgentService::new());
    let claude_onboarding = Arc::new(ClaudeOnboardingService::new());
    let state = AppState {
        security: security.clone(),
        workspaces,
        store,
        workspace_root_updates: Arc::new(Mutex::new(())),
        allow_external_workspace_paths: config.allow_external_workspace_paths,
        files,
        search,
        git,
        sessions,
        agent_sessions,
        agents,
        claude_onboarding,
        sync_roots: Arc::new(known_sync_roots()),
        pty,
        frontend_root: config.frontend_root,
        runtime,
        p6_state: Arc::new(Mutex::new(serde_json::json!({
            "aiSettings": {"state": {"version": 1, "apps": {"claude": {"providers": {}, "current": ""}, "codex": {"providers": {}, "current": ""}}}, "paths": {}},
            "skills": {"enabled": [], "user": [], "paths": {"claude": [], "codex": []}},
            "claudePlugins": {"plugins": [], "marketplaces": [], "warnings": [], "paths": {}},
            "codexPlugins": {"plugins": [], "marketplaces": [], "warnings": [], "paths": {}},
            "workflows": {}
        }))),
    };

    let protected = Router::new()
        .route("/api/settings", get(settings).put(update_settings))
        .route(
            "/api/ui-preferences",
            get(ui_preferences).put(update_ui_preferences),
        )
        .route(
            "/api/dismissed-confirmations",
            get(dismissed_confirmations).put(update_dismissed_confirmations),
        )
        .route(
            "/api/workspaces",
            get(list_workspaces).post(create_workspace),
        )
        .route(
            "/api/workspaces/root",
            get(workspaces_root).post(update_workspaces_root),
        )
        .route("/api/workspaces/{id}", get(open_workspace))
        .route(
            "/api/workspaces/{id}/sessions",
            get(list_workspace_sessions).post(create_workspace_session),
        )
        .route(
            "/api/workspaces/{id}/sessions/{sid}",
            get(get_workspace_session)
                .put(update_workspace_session)
                .delete(delete_workspace_session),
        )
        .route("/api/workspaces/{id}/fs/tree", get(list_workspace_tree))
        .route("/api/workspaces/{id}/search", get(search_workspace))
        .route("/api/workspaces/{id}/git/repo", get(git_repo))
        .route("/api/workspaces/{id}/git/status", get(git_status))
        .route("/api/workspaces/{id}/git/diff", get(git_diff))
        .route(
            "/api/workspaces/{id}/git/remotes",
            get(git_remotes).post(git_add_remote),
        )
        .route(
            "/api/workspaces/{id}/git/remotes/{name}",
            delete(git_remove_remote),
        )
        .route("/api/workspaces/{id}/git/branches", get(git_branches))
        .route("/api/workspaces/{id}/git/checkout", post(git_checkout))
        .route("/api/workspaces/{id}/git/log", get(git_log))
        .route(
            "/api/workspaces/{id}/git/commits/{sha}",
            get(git_commit_details),
        )
        .route(
            "/api/workspaces/{id}/git/commits/{sha}/diff",
            get(git_commit_diff),
        )
        .route("/api/workspaces/{id}/git/init", post(git_init))
        .route("/api/workspaces/{id}/git/stage", post(git_stage))
        .route("/api/workspaces/{id}/git/unstage", post(git_unstage))
        .route("/api/workspaces/{id}/git/discard", post(git_discard))
        .route("/api/workspaces/{id}/git/commit", post(git_commit))
        .route("/api/workspaces/{id}/git/fetch", post(git_fetch))
        .route("/api/workspaces/{id}/git/pull", post(git_pull))
        .route("/api/workspaces/{id}/git/push", post(git_push))
        .route(
            "/api/workspaces/{id}/fs/file",
            get(read_workspace_file).put(write_workspace_file),
        )
        .route(
            "/api/workspaces/{id}/fs/external",
            post(resolve_external_file),
        )
        .route(
            "/api/workspaces/{id}/fs/external-read",
            post(read_external_file),
        )
        .route("/api/workspaces/{id}/fs/image", get(read_workspace_image))
        .route(
            "/api/workspaces/{id}/fs/entry",
            post(create_workspace_entry).delete(delete_workspace_entry),
        )
        .route("/api/workspaces/{id}/fs/move", post(move_workspace_entry))
        .route("/api/workspaces/{id}/fs/copy", post(copy_workspace_entry))
        .route(
            "/api/workspaces/{id}/fs/copy-external",
            post(copy_external_entry),
        )
        .route(
            "/api/workspaces/{id}/settings",
            get(workspace_settings).put(update_workspace_settings),
        )
        .route("/api/terminals/profiles", get(terminal_profiles))
        .route("/api/terminals", get(list_terminals).post(create_terminal))
        .route("/api/terminals/{id}", delete(delete_terminal))
        .route("/api/terminals/{id}/io", get(terminal_io))
        .route("/api/agent-sessions", get(list_agent_sessions))
        .route(
            "/api/agent-sessions/{app}/{id}",
            delete(delete_agent_session),
        )
        .route(
            "/api/agent-sessions/{app}/batch-delete",
            post(batch_delete_agent_sessions),
        )
        .route(
            "/api/claude/onboarding-skip",
            get(claude_onboarding_status).put(update_claude_onboarding),
        )
        .route(
            "/api/workspaces/{id}/agents",
            get(list_agents).post(create_agent),
        )
        .route(
            "/api/workspaces/{id}/agents/{name}",
            get(get_agent).put(update_agent).delete(delete_agent),
        )
        .route("/api/model-prices/sync", post(p6_ok))
        .route("/api/ai-settings", get(ai_settings).put(update_ai_settings))
        .route("/api/ai-settings/live/{app}", get(ai_live_settings))
        .route("/api/ai-settings/import-live", post(p6_ok))
        .route("/api/ai-settings/providers", post(upsert_ai_provider))
        .route(
            "/api/ai-settings/providers/{id}",
            put(upsert_ai_provider).delete(delete_ai_provider),
        )
        .route("/api/ai-settings/switch", post(p6_ok))
        .route("/api/ai/cli-status", get(ai_cli_status))
        .route("/api/ai/cli-tools", get(ai_cli_tools))
        .route("/api/ai/cli-tools/{name}/action", post(p6_ok))
        .route("/api/workspaces/{id}/ai/models", post(p6_ok))
        .route("/api/workspaces/{id}/ai/chat/terminal", post(p6_ok))
        .route(
            "/api/workspaces/{id}/ai/chat/terminal/{sessionId}/auto-success",
            post(p6_ok),
        )
        .route(
            "/api/workspaces/{id}/ai/chat/terminal/{sessionId}/pause",
            post(p6_ok),
        )
        .route(
            "/api/workspaces/{id}/ai/chat/terminal/{sessionId}/success",
            post(p6_ok),
        )
        .route("/api/workspaces/{id}/ai/chat", post(p6_ok))
        .route("/api/workspaces/{id}/ai/chat/stream", post(p6_ok))
        .route("/api/workspaces/{id}/ai/exec/read", post(p6_ok))
        .route("/api/workspaces/{id}/ai/exec/write", post(p6_ok))
        .route("/api/workspaces/{id}/ai/exec/run", post(p6_ok))
        .route("/api/workspaces/{id}/ai/exec/run/stream", post(p6_ok))
        .route("/api/workspaces/{id}/mcp/discover", post(p6_ok))
        .route("/api/workspaces/{id}/mcp/call", post(p6_ok))
        .route("/api/adapters", get(adapters))
        .route("/api/adapter-events", get(adapter_events))
        .route("/api/skills", get(skills).post(p6_ok))
        .route("/api/skills/library", get(skills_library))
        .route("/api/skills/install", post(skill_mutation))
        .route("/api/skills/import", post(skill_mutation))
        .route("/api/skills/enable", post(skill_mutation))
        .route("/api/skills/disable", post(skill_mutation))
        .route("/api/skills/apply", post(skill_mutation))
        .route("/api/skills/delete", post(skill_mutation))
        .route("/api/claude-plugins", get(claude_plugins))
        .route("/api/claude-plugins/install", post(plugin_mutation))
        .route("/api/claude-plugins/uninstall", post(plugin_mutation))
        .route("/api/claude-plugins/enable", post(plugin_mutation))
        .route("/api/claude-plugins/disable", post(plugin_mutation))
        .route("/api/claude-plugins/marketplaces", post(plugin_mutation))
        .route("/api/codex-plugins", get(codex_plugins))
        .route("/api/codex-plugins/install", post(plugin_mutation))
        .route("/api/codex-plugins/uninstall", post(plugin_mutation))
        .route("/api/codex-plugins/local", post(plugin_mutation))
        .route("/api/codex-plugins/import-local", post(plugin_mutation))
        .route("/api/codex-plugins/local/{name}", delete(plugin_mutation))
        .route("/api/codex-plugins/marketplaces", post(plugin_mutation))
        .route("/api/templates/capabilities", get(template_capabilities))
        .route("/api/templates", get(templates).post(p6_ok))
        .route("/api/templates/local", get(templates))
        .route("/api/templates/marketspace", get(template_marketspace))
        .route("/api/templates/marketspace/{id}/install", post(p6_ok))
        .route(
            "/api/templates/{source}/{tid}",
            get(template_get).delete(p6_ok),
        )
        .route(
            "/api/templates/{source}/{tid}/icon",
            get(template_icon).put(p6_ok),
        )
        .route("/api/workflow-usage", get(workflow_usage))
        .route(
            "/api/workspaces/{id}/workflows",
            get(workflows).post(workflow_create),
        )
        .route("/api/workspaces/{id}/workflows/usage", get(workflow_usage))
        .route(
            "/api/workspaces/{id}/workflows/{wid}",
            get(workflow_get).put(workflow_save).delete(p6_ok),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/content",
            patch(workflow_save),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/title",
            patch(workflow_save),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/run",
            post(workflow_run),
        )
        .route("/api/workspaces/{id}/workflows/{wid}/pause", post(p6_ok))
        .route("/api/workspaces/{id}/workflows/{wid}/stop", post(p6_ok))
        .route(
            "/api/workspaces/{id}/workflows/{wid}/events",
            get(workflow_events),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/nodes/{nodeId}/approval",
            post(p6_ok),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/nodes/{nodeId}/input",
            post(p6_ok),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/nodes/{nodeId}/retry-now",
            post(p6_ok),
        )
        .route("/api/workspaces/{id}/workflows/{wid}/template", post(p6_ok))
        .route(
            "/api/workspaces/{id}/workflows/{wid}/system-template",
            post(p6_ok),
        )
        .route(
            "/api/workspaces/{id}/templates/{source}/{tid}/edit",
            post(p6_ok),
        )
        .route_layer(middleware::from_fn_with_state(
            security.clone(),
            require_session,
        ));
    let api = Router::new()
        .route("/api/health", get(health))
        .route("/api/auth/session", post(create_session))
        .route("/api/runtime/health", get(runtime_health))
        .route("/api/runtime/clients", post(attach_runtime_client))
        .route("/api/runtime/clients/{id}", delete(detach_runtime_client))
        .merge(protected)
        .route_layer(middleware::from_fn_with_state(
            security.clone(),
            require_origin,
        ));

    let cors_security = security.clone();
    let cors = CorsLayer::new()
        .allow_credentials(true)
        .allow_methods([
            Method::GET,
            Method::POST,
            Method::PUT,
            Method::DELETE,
            Method::OPTIONS,
        ])
        .allow_headers([
            header::AUTHORIZATION,
            header::CONTENT_TYPE,
            header::IF_NONE_MATCH,
            HeaderName::from_static("x-osheep-file-open-id"),
        ])
        .expose_headers([
            header::SERVER,
            header::ETAG,
            HeaderName::from_static("server-timing"),
            HeaderName::from_static("x-osheep-file-open-id"),
            HeaderName::from_static("x-osheep-file-cache"),
            HeaderName::from_static("x-osheep-file-io-diagnostic"),
        ])
        .allow_origin(AllowOrigin::predicate(move |origin, _| {
            origin
                .to_str()
                .is_ok_and(|value| cors_security.is_trusted_origin(value))
        }));

    Ok(api
        .fallback(static_fallback)
        .with_state(state)
        .layer(DefaultBodyLimit::max(16 * 1024 * 1024))
        .layer(cors)
        .layer(TraceLayer::new_for_http()))
}

fn default_settings() -> Value {
    serde_json::json!({
        "ui": { "language": "system", "theme": "dark" },
        "editor": { "fontSize": 14, "tabSize": 2, "autoSave": false },
        "ai": { "autoAllow": {} },
        "workflow": { "maxParallelNodes": 4 }
    })
}

async fn settings(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state
        .store
        .settings(default_settings())
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn update_settings(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    state.store.merge_settings(&body).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn ui_preferences(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    state
        .store
        .ui_preferences(serde_json::json!({ "language": "system", "theme": "dark" }))
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn update_ui_preferences(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    state.store.set_ui_preferences(body).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn dismissed_confirmations(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let values = state.store.dismissed_confirmations().await?;
    Ok(Json(serde_json::json!({ "values": values })))
}

async fn update_dismissed_confirmations(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let mut values = Vec::new();
    if let Some(input) = body.get("values").and_then(Value::as_array) {
        for value in input.iter().filter_map(Value::as_str) {
            let value = value.trim();
            if !value.is_empty() && !values.iter().any(|current| current == value) {
                values.push(value.to_owned());
                if values.len() == 200 {
                    break;
                }
            }
        }
    }
    state.store.set_dismissed_confirmations(values).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn list_workspaces(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let workspaces = state.workspaces.list().await?;
    Ok(Json(serde_json::json!({
        "workspaces": workspaces.into_iter().map(|workspace| serde_json::json!({
            "id": workspace.id,
            "name": workspace.name
        })).collect::<Vec<_>>()
    })))
}

async fn create_workspace(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|name| !name.is_empty())
        .ok_or_else(|| ApiError::invalid_path("缺少工作区名称"))?;
    let workspace = state.workspaces.create(name).await?;
    Ok(Json(serde_json::json!({
        "id": workspace.id,
        "name": workspace.name
    })))
}

async fn workspaces_root(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(serde_json::json!({
        "path": state.workspaces.canonical_root().await?
    })))
}

async fn update_workspaces_root(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if !state.allow_external_workspace_paths {
        return Err(ApiError::invalid_path("当前服务未启用外部工作区"));
    }
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| ApiError::invalid_path("缺少工作区路径"))?;
    let _guard = state.workspace_root_updates.lock().await;
    let root = state.workspaces.validate_root(&PathBuf::from(path)).await?;
    state.store.write_workspace_root(&root).await?;
    state.workspaces.set_root(root.clone()).await;
    Ok(Json(serde_json::json!({ "path": root })))
}

async fn open_workspace(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    ensure_workspace_layout(&workspace.path).await?;
    let _ = state
        .store
        .record_opened_project(&workspace.name, &workspace.path)
        .await;
    Ok(Json(serde_json::json!({
        "id": workspace.id,
        "name": workspace.name
    })))
}

async fn resolve_workspace_path(state: &AppState, id: &str) -> Result<PathBuf, ApiError> {
    Ok(state.workspaces.resolve(id).await?.path)
}

async fn list_workspace_sessions(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let sessions = state.sessions.list(&root).await?;
    Ok(Json(serde_json::json!({ "sessions": sessions })))
}

async fn get_workspace_session(
    State(state): State<AppState>,
    AxumPath((id, sid)): AxumPath<(String, String)>,
) -> Result<Json<SessionRecord>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    Ok(Json(state.sessions.get(&root, &sid).await?))
}

async fn create_workspace_session(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<SessionRecord>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let title = body.get("title").and_then(Value::as_str).map(str::to_owned);
    let agent_name = body
        .get("agentName")
        .and_then(Value::as_str)
        .map(str::to_owned);
    Ok(Json(state.sessions.create(&root, title, agent_name).await?))
}

async fn update_workspace_session(
    State(state): State<AppState>,
    AxumPath((id, sid)): AxumPath<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<SessionRecord>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    if body.get("id").and_then(Value::as_str) != Some(sid.as_str()) {
        return Err(ApiError::invalid_path("session id 与 URL 不一致"));
    }
    let record: SessionRecord = serde_json::from_value(body)
        .map_err(|error| ApiError::invalid_path(format!("session 数据无效: {error}")))?;
    Ok(Json(state.sessions.save(&root, record).await?))
}

async fn delete_workspace_session(
    State(state): State<AppState>,
    AxumPath((id, sid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    state.sessions.delete(&root, &sid).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn list_agents(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    Ok(Json(
        serde_json::json!({ "agents": state.agents.list(&root).await? }),
    ))
}

async fn get_agent(
    State(state): State<AppState>,
    AxumPath((id, name)): AxumPath<(String, String)>,
) -> Result<Json<AgentRecord>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    Ok(Json(state.agents.get(&root, &name).await?))
}

async fn create_agent(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let agent = parse_agent_body(body)?;
    state.agents.save(&root, agent).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn update_agent(
    State(state): State<AppState>,
    AxumPath((id, name)): AxumPath<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let agent = parse_agent_body(body)?;
    if agent.name != name {
        state.agents.rename(&root, &name, &agent.name).await?;
    }
    state.agents.save(&root, agent).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn delete_agent(
    State(state): State<AppState>,
    AxumPath((id, name)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    state.agents.delete(&root, &name).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn parse_agent_body(body: Value) -> Result<AgentRecord, ApiError> {
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| ApiError::invalid_path("missing name"))?;
    Ok(AgentRecord {
        name: name.to_owned(),
        prompt: body
            .get("prompt")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        provider_id: body
            .get("providerId")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
        model: body
            .get("model")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    })
}

#[derive(Debug, Deserialize)]
struct AgentSessionsQuery {
    app: Option<String>,
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
}

async fn list_agent_sessions(
    State(state): State<AppState>,
    Query(query): Query<AgentSessionsQuery>,
) -> Result<Json<Value>, ApiError> {
    let app = AgentSessionApp::parse(query.app.as_deref().unwrap_or(""))?;
    let workspace_id = query
        .workspace_id
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "workspaceId is required",
            )
        })?;
    let root = resolve_workspace_path(&state, &workspace_id).await?;
    Ok(Json(
        serde_json::json!({"sessions": state.agent_sessions.list_in_project(app, &root).await?}),
    ))
}

async fn delete_agent_session(
    State(state): State<AppState>,
    AxumPath((app, id)): AxumPath<(String, String)>,
    Query(query): Query<AgentSessionsQuery>,
) -> Result<Json<Value>, ApiError> {
    let app = AgentSessionApp::parse(&app)?;
    let workspace_id = query
        .workspace_id
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "workspaceId is required",
            )
        })?;
    let root = resolve_workspace_path(&state, &workspace_id).await?;
    let session = state
        .agent_sessions
        .delete_in_project(app, &id, &root)
        .await?;
    Ok(Json(serde_json::json!({"session": session})))
}

#[derive(Debug, Deserialize)]
struct AgentBatchDeleteBody {
    #[serde(rename = "workspaceId")]
    workspace_id: Option<String>,
    ids: Option<Value>,
}

async fn batch_delete_agent_sessions(
    State(state): State<AppState>,
    AxumPath(app): AxumPath<String>,
    Json(body): Json<AgentBatchDeleteBody>,
) -> Result<Json<Value>, ApiError> {
    let app = AgentSessionApp::parse(&app)?;
    let workspace_id = body
        .workspace_id
        .filter(|v| !v.trim().is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "workspaceId is required",
            )
        })?;
    let ids_value = body.ids.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "ids must contain 1 to 500 session ids",
        )
    })?;
    let ids = ids_value
        .as_array()
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "ids must contain 1 to 500 session ids",
            )
        })?
        .iter()
        .map(|v| {
            v.as_str().map(str::to_owned).ok_or_else(|| {
                ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "INVALID_QUERY",
                    "ids contains an invalid session id",
                )
            })
        })
        .collect::<Result<Vec<_>, _>>()?;
    let root = resolve_workspace_path(&state, &workspace_id).await?;
    let (deleted, failed) = state.agent_sessions.batch_delete(app, &ids, &root).await?;
    Ok(Json(
        serde_json::json!({"deleted": deleted, "failed": failed.into_iter().map(|(id,message)| serde_json::json!({"id":id,"message":message})).collect::<Vec<_>>() }),
    ))
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct TreeQuery {
    #[serde(default)]
    path: String,
    #[serde(default, deserialize_with = "deserialize_query_bool")]
    include_hidden: bool,
    #[serde(default, deserialize_with = "deserialize_query_bool")]
    metadata: bool,
}

#[derive(Debug, serde::Deserialize)]
struct FileQuery {
    path: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct DeleteEntryQuery {
    path: Option<String>,
    #[serde(default, deserialize_with = "deserialize_query_bool")]
    recursive: bool,
}

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct SearchQuery {
    query: Option<String>,
    case_sensitive: Option<String>,
    whole_word: Option<String>,
    regex: Option<String>,
    include: Option<String>,
    exclude: Option<String>,
    max_files: Option<String>,
    max_matches_per_file: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GitDiffQuery {
    path: Option<String>,
    base: Option<String>,
    head: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct GitLogQuery {
    limit: Option<String>,
    offset: Option<String>,
    #[serde(rename = "ref")]
    reference: Option<String>,
}

fn deserialize_query_bool<'de, D>(deserializer: D) -> Result<bool, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    Ok(value == "true")
}

fn search_query_bool(value: Option<&str>) -> bool {
    matches!(value, Some("true" | "1"))
}

fn search_query_list(value: Option<&str>) -> Vec<String> {
    value
        .unwrap_or_default()
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect()
}

fn search_query_limit(value: Option<&str>, fallback: usize, maximum: usize) -> usize {
    let Some(value) = value else { return fallback };
    let value = value.trim_start();
    let value = value.strip_prefix('+').unwrap_or(value);
    if value.starts_with('-') {
        return fallback;
    }
    let digit_count = value.bytes().take_while(u8::is_ascii_digit).count();
    if digit_count == 0 {
        return fallback;
    }
    let parsed = value[..digit_count].parse::<f64>().unwrap_or(f64::INFINITY);
    if !parsed.is_finite() || parsed <= 0.0 {
        fallback
    } else {
        parsed.min(maximum as f64) as usize
    }
}

fn parse_javascript_integer(value: &str) -> Option<i128> {
    let value = value.trim_start();
    let (negative, value) = if let Some(value) = value.strip_prefix('-') {
        (true, value)
    } else {
        (false, value.strip_prefix('+').unwrap_or(value))
    };
    let digits = value.bytes().take_while(u8::is_ascii_digit).count();
    if digits == 0 {
        return None;
    }
    let magnitude = value[..digits].parse::<i128>().unwrap_or(i128::MAX);
    Some(if negative {
        magnitude.saturating_neg()
    } else {
        magnitude
    })
}

fn git_log_limit(value: Option<&str>) -> usize {
    let parsed = value.and_then(parse_javascript_integer).unwrap_or(200);
    let parsed = if parsed == 0 { 200 } else { parsed };
    parsed.clamp(1, 100_000) as usize
}

fn git_log_offset(value: Option<&str>) -> usize {
    value
        .and_then(parse_javascript_integer)
        .unwrap_or(0)
        .clamp(0, usize::MAX as i128) as usize
}

async fn list_workspace_tree(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<TreeQuery>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    ensure_workspace_layout(&workspace.path).await?;
    let entries = state
        .files
        .list_tree(
            &workspace.path,
            &query.path,
            query.include_hidden,
            query.metadata,
        )
        .await?;
    Ok(Json(serde_json::json!({ "entries": entries })))
}

async fn search_workspace(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<osheep_core::SearchResult>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let search = query
        .query
        .filter(|query| !query.is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "INVALID_QUERY", "query 不能为空"))?;
    let options = SearchOptions {
        query: search,
        case_sensitive: search_query_bool(query.case_sensitive.as_deref()),
        whole_word: search_query_bool(query.whole_word.as_deref()),
        regex: search_query_bool(query.regex.as_deref()),
        include: search_query_list(query.include.as_deref()),
        exclude: search_query_list(query.exclude.as_deref()),
        max_files: search_query_limit(query.max_files.as_deref(), 5000, 50000),
        max_matches_per_file: search_query_limit(query.max_matches_per_file.as_deref(), 100, 1000),
    };
    state
        .search
        .search(&workspace.path, options)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn git_repo(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<GitRepoInfo>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state
        .git
        .repo_info(&workspace.path)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn git_status(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<GitStatus>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state
        .git
        .status(&workspace.path)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn git_diff(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<GitDiffQuery>,
) -> Result<Json<GitDiff>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.ensure_repo(&workspace.path).await?;
    let path = query
        .path
        .ok_or_else(|| ApiError::invalid_path("缺少 path 参数"))?;
    let base = query.base.as_deref().unwrap_or("HEAD");
    let head = query.head.as_deref().unwrap_or("WORKTREE");
    if !matches!(base, "HEAD" | "INDEX") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_REF",
            "base",
        ));
    }
    if !matches!(head, "INDEX" | "WORKTREE") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_REF",
            "head",
        ));
    }
    state
        .git
        .diff(&workspace.path, &path, base, head)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn git_remotes(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let remotes = state.git.remotes(&workspace.path).await?;
    Ok(Json(serde_json::json!({ "remotes": remotes })))
}

async fn git_add_remote(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.ensure_repo(&workspace.path).await?;
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少 name"))?;
    let url = body
        .get("url")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少 url"))?;
    state.git.add_remote(&workspace.path, name, url).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_remove_remote(
    State(state): State<AppState>,
    AxumPath((id, name)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.remove_remote(&workspace.path, &name).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_branches(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<GitBranches>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state
        .git
        .branches(&workspace.path)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn git_checkout(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.ensure_repo(&workspace.path).await?;
    let reference = body
        .get("ref")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ApiError::new(StatusCode::BAD_REQUEST, "INVALID_REF", "缺少 ref"))?;
    let create = body.get("create").and_then(Value::as_bool).unwrap_or(false);
    let from_ref = body.get("fromRef").and_then(Value::as_str);
    state
        .git
        .checkout(&workspace.path, reference, create, from_ref)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true, "branch": reference })))
}

async fn git_log(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<GitLogQuery>,
) -> Result<Json<GitLog>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let reference = query
        .reference
        .as_deref()
        .filter(|reference| !reference.is_empty())
        .unwrap_or("HEAD");
    state
        .git
        .log(
            &workspace.path,
            git_log_limit(query.limit.as_deref()),
            git_log_offset(query.offset.as_deref()),
            reference,
        )
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn git_commit_details(
    State(state): State<AppState>,
    AxumPath((id, sha)): AxumPath<(String, String)>,
) -> Result<Json<GitCommitDetails>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state
        .git
        .commit_details(&workspace.path, &sha)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn git_commit_diff(
    State(state): State<AppState>,
    AxumPath((id, sha)): AxumPath<(String, String)>,
    Query(query): Query<FileQuery>,
) -> Result<Json<GitCommitDiff>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.ensure_repo(&workspace.path).await?;
    let path = query
        .path
        .ok_or_else(|| ApiError::invalid_path("缺少 path 参数"))?;
    state
        .git
        .commit_diff(&workspace.path, &sha, &path)
        .await
        .map(Json)
        .map_err(Into::into)
}

async fn git_init(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.init(&workspace.path).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_stage(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.ensure_repo(&workspace.path).await?;
    let paths = parse_git_paths(&body)?;
    state.git.stage(&workspace.path, &paths).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_unstage(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.ensure_repo(&workspace.path).await?;
    let paths = parse_git_paths(&body)?;
    state.git.unstage(&workspace.path, &paths).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_discard(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.ensure_repo(&workspace.path).await?;
    let paths = parse_git_paths(&body)?;
    let discarded = state.git.discard(&workspace.path, &paths).await?;
    Ok(Json(
        serde_json::json!({ "ok": true, "discarded": discarded }),
    ))
}

async fn git_commit(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    state.git.ensure_repo(&workspace.path).await?;
    let message = body
        .get("message")
        .and_then(Value::as_str)
        .ok_or(osheep_core::GitError::EmptyCommitMessage)?;
    let head = state.git.commit(&workspace.path, message).await?;
    Ok(Json(serde_json::json!({ "ok": true, "head": head })))
}

fn parse_git_paths(body: &Value) -> Result<Vec<String>, ApiError> {
    let paths = body
        .get("paths")
        .and_then(Value::as_array)
        .ok_or_else(|| ApiError::invalid_path("paths 必须是字符串数组"))?;
    paths
        .iter()
        .map(|path| {
            path.as_str()
                .map(str::to_owned)
                .ok_or_else(|| ApiError::invalid_path("paths 元素必须是字符串"))
        })
        .collect()
}

async fn git_fetch(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let remote = body.get("remote").and_then(Value::as_str);
    let prune = body.get("prune").and_then(Value::as_bool).unwrap_or(false);
    state.git.fetch(&workspace.path, remote, prune).await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_pull(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let remote = body.get("remote").and_then(Value::as_str);
    let branch = body.get("branch").and_then(Value::as_str);
    let ff_only = body.get("ffOnly").and_then(Value::as_bool).unwrap_or(true);
    state
        .git
        .pull(&workspace.path, remote, branch, ff_only)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn git_push(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let remote = body.get("remote").and_then(Value::as_str);
    let branch = body.get("branch").and_then(Value::as_str);
    let set_upstream = body
        .get("setUpstream")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    state
        .git
        .push(&workspace.path, remote, branch, set_upstream, force)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

async fn read_workspace_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let started = Instant::now();
    let path = query
        .path
        .ok_or_else(|| ApiError::invalid_path("缺少 path 参数"))?;
    let workspace = state.workspaces.resolve(&id).await?;
    let file = state.files.read_text(&workspace.path, &path).await?;
    let elapsed = started.elapsed();
    let duration_ms = elapsed.as_secs_f64() * 1000.0;
    let diagnostic = file_io_diagnostic(
        &workspace
            .path
            .join(file.path.replace('/', std::path::MAIN_SEPARATOR_STR)),
        elapsed,
        &state.sync_roots,
    );
    let trace_id = headers
        .get("x-osheep-file-open-id")
        .and_then(|value| value.to_str().ok())
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 128
                && value
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-'))
        })
        .map(str::to_owned)
        .unwrap_or_else(|| uuid::Uuid::new_v4().simple().to_string());
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(file.etag.as_str());
    let mut response = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        Json(&file).into_response()
    };
    let response_headers = response.headers_mut();
    response_headers.insert(
        header::ETAG,
        HeaderValue::from_str(&file.etag).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                error.to_string(),
            )
        })?,
    );
    response_headers.insert(
        HeaderName::from_static("server-timing"),
        HeaderValue::from_str(&format!("osheep-file-read;dur={duration_ms:.2}")).map_err(
            |error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL",
                    error.to_string(),
                )
            },
        )?,
    );
    response_headers.insert(
        HeaderName::from_static("x-osheep-file-open-id"),
        HeaderValue::from_str(&trace_id).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                error.to_string(),
            )
        })?,
    );
    response_headers.insert(
        HeaderName::from_static("x-osheep-file-cache"),
        HeaderValue::from_static(file.cache_status.as_str()),
    );
    response_headers.insert(
        HeaderName::from_static("x-osheep-file-io-diagnostic"),
        HeaderValue::from_static(diagnostic),
    );
    Ok(response)
}

fn known_sync_roots() -> Vec<PathBuf> {
    let mut roots = ["OneDrive", "OneDriveConsumer", "OneDriveCommercial"]
        .into_iter()
        .filter_map(std::env::var_os)
        .map(PathBuf::from)
        .collect::<Vec<_>>();
    if let Some(configured) = std::env::var_os("OSHEEP_SYNC_ROOTS") {
        roots.extend(std::env::split_paths(&configured));
    }
    roots
}

fn file_io_diagnostic(path: &Path, elapsed: Duration, sync_roots: &[PathBuf]) -> &'static str {
    if elapsed < Duration::from_millis(250) {
        return "normal";
    }
    if is_network_path(path) {
        return "slow-network";
    }
    if sync_roots
        .iter()
        .any(|root| path_starts_with_platform(path, root))
    {
        return "slow-sync";
    }
    "slow-local"
}

fn path_starts_with_platform(path: &Path, root: &Path) -> bool {
    if cfg!(target_os = "windows") {
        let path = path.to_string_lossy().replace('/', "\\").to_lowercase();
        let root = root
            .to_string_lossy()
            .replace('/', "\\")
            .trim_end_matches('\\')
            .to_lowercase();
        path == root || path.starts_with(&format!("{root}\\"))
    } else {
        path.starts_with(root)
    }
}

#[cfg(target_os = "windows")]
fn is_network_path(path: &Path) -> bool {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::GetDriveTypeW;

    let text = path.to_string_lossy();
    if text.starts_with(r"\\") {
        return true;
    }
    let bytes = text.as_bytes();
    if bytes.len() < 3 || !bytes[0].is_ascii_alphabetic() || bytes[1] != b':' {
        return false;
    }
    let root = PathBuf::from(format!("{}:\\", bytes[0] as char));
    let wide = root
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    unsafe { GetDriveTypeW(wide.as_ptr()) == 4 }
}

#[cfg(not(target_os = "windows"))]
fn is_network_path(_path: &Path) -> bool {
    false
}

async fn write_workspace_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少 path"))?;
    let create_parents = body
        .get("createParents")
        .and_then(Value::as_bool)
        .unwrap_or(true);
    let result = if let Some(content) = body.get("contentBase64").and_then(Value::as_str) {
        state
            .files
            .write_bytes(
                &workspace.path,
                path,
                decode_base64(content)?,
                create_parents,
            )
            .await?
    } else {
        let content = body
            .get("content")
            .and_then(Value::as_str)
            .ok_or_else(|| ApiError::invalid_path("缺少 content"))?;
        state
            .files
            .write_text(&workspace.path, path, content.to_owned(), create_parents)
            .await?
    };
    Ok(Json(serde_json::to_value(result).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            error.to_string(),
        )
    })?))
}

async fn resolve_external_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|path| !path.is_empty())
        .ok_or_else(|| ApiError::invalid_path("缺少外部文件路径"))?;
    let path = state
        .files
        .workspace_relative_external(&workspace.path, &PathBuf::from(path))
        .await?;
    Ok(Json(serde_json::json!({ "path": path })))
}

async fn read_external_file(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    state.workspaces.resolve(&id).await?;
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("外部文件路径必须是绝对路径"))?;
    let path = PathBuf::from(path);
    let bytes = state.files.read_external(&path).await?;
    let extension = path
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = image_mime(&extension);
    if mime.is_none() && bytes.contains(&0) {
        return Err(ApiError::invalid_path("二进制文件无法直接预览"));
    }
    Ok(Json(if let Some(mime) = mime {
        serde_json::json!({
            "name": path.file_name().map(|value| value.to_string_lossy()).unwrap_or_default(),
            "contentBase64": encode_base64(&bytes),
            "mime": mime
        })
    } else {
        serde_json::json!({
            "name": path.file_name().map(|value| value.to_string_lossy()).unwrap_or_default(),
            "content": String::from_utf8_lossy(&bytes)
        })
    }))
}

async fn read_workspace_image(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<FileQuery>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    let path = query
        .path
        .ok_or_else(|| ApiError::invalid_path("缺少 path 参数"))?;
    let workspace = state.workspaces.resolve(&id).await?;
    let file = state.files.read_binary(&workspace.path, &path).await?;
    let extension = Path::new(&path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let not_modified = headers
        .get(header::IF_NONE_MATCH)
        .and_then(|value| value.to_str().ok())
        == Some(file.etag.as_str());
    let mut response = if not_modified {
        StatusCode::NOT_MODIFIED.into_response()
    } else {
        file.content.into_response()
    };
    response.headers_mut().insert(
        header::CONTENT_TYPE,
        HeaderValue::from_static(image_mime(&extension).unwrap_or("application/octet-stream")),
    );
    response
        .headers_mut()
        .insert(header::CACHE_CONTROL, HeaderValue::from_static("no-cache"));
    response.headers_mut().insert(
        header::ETAG,
        HeaderValue::from_str(&file.etag).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                error.to_string(),
            )
        })?,
    );
    Ok(response)
}

async fn create_workspace_entry(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let path = body
        .get("path")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少 path"))?;
    let kind = match body.get("kind").and_then(Value::as_str) {
        Some("file") => EntryKind::File,
        Some("directory") => EntryKind::Directory,
        _ => return Err(ApiError::invalid_path("kind 必须为 file 或 directory")),
    };
    state
        .files
        .create_entry(&workspace.path, path, kind)
        .await?;
    Ok(Json(
        serde_json::json!({ "path": path.replace('\\', "/"), "kind": kind }),
    ))
}

async fn move_workspace_entry(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let from = body
        .get("from")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少 from 或 to"))?;
    let to = body
        .get("to")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少 from 或 to"))?;
    state.files.move_entry(&workspace.path, from, to).await?;
    Ok(Json(
        serde_json::json!({ "from": from.replace('\\', "/"), "to": to.replace('\\', "/") }),
    ))
}

async fn copy_workspace_entry(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let from = body
        .get("from")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少 from 或 to"))?;
    let to = body
        .get("to")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少 from 或 to"))?;
    state.files.copy_entry(&workspace.path, from, to).await?;
    Ok(Json(
        serde_json::json!({ "from": from.replace('\\', "/"), "to": to.replace('\\', "/") }),
    ))
}

async fn copy_external_entry(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let source = body
        .get("sourcePath")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少外部源路径或目标路径"))?;
    let target = body
        .get("targetPath")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("缺少外部源路径或目标路径"))?;
    state
        .files
        .copy_external(&workspace.path, &PathBuf::from(source), target)
        .await?;
    Ok(Json(serde_json::json!({
        "from": source,
        "to": target.replace('\\', "/")
    })))
}

async fn claude_onboarding_status(
    State(state): State<AppState>,
) -> Result<Json<osheep_core::ClaudeOnboardingStatus>, ApiError> {
    Ok(Json(state.claude_onboarding.get().await?))
}

async fn update_claude_onboarding(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<osheep_core::ClaudeOnboardingStatus>, ApiError> {
    let enabled = body
        .get("enabled")
        .and_then(Value::as_bool)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "enabled must be a boolean",
            )
        })?;
    Ok(Json(state.claude_onboarding.set(enabled).await?))
}

async fn delete_workspace_entry(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<DeleteEntryQuery>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    let path = query
        .path
        .ok_or_else(|| ApiError::invalid_path("缺少 path 参数"))?;
    state
        .files
        .delete_entry(&workspace.path, &path, query.recursive)
        .await?;
    Ok(Json(serde_json::json!({ "path": path.replace('\\', "/") })))
}

async fn workspace_settings(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    ensure_workspace_layout(&workspace.path).await?;
    let settings = state
        .files
        .read_text(&workspace.path, ".osheep/settings.json")
        .await?;
    Ok(Json(
        serde_json::from_str(&settings.content)
            .unwrap_or_else(|_| serde_json::json!({ "editor": { "fontSize": 14, "tabSize": 2 } })),
    ))
}

async fn update_workspace_settings(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = state.workspaces.resolve(&id).await?;
    ensure_workspace_layout(&workspace.path).await?;
    let text = serde_json::to_string_pretty(&body).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            error.to_string(),
        )
    })?;
    state
        .files
        .write_text(&workspace.path, ".osheep/settings.json", text, true)
        .await?;
    Ok(Json(serde_json::json!({ "ok": true })))
}

fn decode_base64(input: &str) -> Result<Vec<u8>, ApiError> {
    let compact = input
        .bytes()
        .filter(|byte| !byte.is_ascii_whitespace())
        .collect::<Vec<_>>();
    if compact.len() % 4 != 0 {
        return Err(ApiError::invalid_path("contentBase64 格式非法"));
    }
    let mut output = Vec::with_capacity(compact.len() / 4 * 3);
    for (index, chunk) in compact.chunks_exact(4).enumerate() {
        let last = index + 1 == compact.len() / 4;
        let padding = usize::from(chunk[3] == b'=') + usize::from(chunk[2] == b'=');
        if padding > 0 && !last || padding == 1 && chunk[2] == b'=' || padding > 2 {
            return Err(ApiError::invalid_path("contentBase64 格式非法"));
        }
        let a = base64_value(chunk[0])?;
        let b = base64_value(chunk[1])?;
        let c = if chunk[2] == b'=' {
            0
        } else {
            base64_value(chunk[2])?
        };
        let d = if chunk[3] == b'=' {
            0
        } else {
            base64_value(chunk[3])?
        };
        output.push((a << 2) | (b >> 4));
        if padding < 2 {
            output.push((b << 4) | (c >> 2));
        }
        if padding == 0 {
            output.push((c << 6) | d);
        }
    }
    Ok(output)
}

fn base64_value(byte: u8) -> Result<u8, ApiError> {
    match byte {
        b'A'..=b'Z' => Ok(byte - b'A'),
        b'a'..=b'z' => Ok(byte - b'a' + 26),
        b'0'..=b'9' => Ok(byte - b'0' + 52),
        b'+' => Ok(62),
        b'/' => Ok(63),
        _ => Err(ApiError::invalid_path("contentBase64 格式非法")),
    }
}

fn encode_base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut output = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let first = chunk[0];
        let second = chunk.get(1).copied().unwrap_or_default();
        let third = chunk.get(2).copied().unwrap_or_default();
        output.push(ALPHABET[(first >> 2) as usize] as char);
        output.push(ALPHABET[(((first & 0x03) << 4) | (second >> 4)) as usize] as char);
        output.push(if chunk.len() >= 2 {
            ALPHABET[(((second & 0x0f) << 2) | (third >> 6)) as usize] as char
        } else {
            '='
        });
        output.push(if chunk.len() == 3 {
            ALPHABET[(third & 0x3f) as usize] as char
        } else {
            '='
        });
    }
    output
}

fn image_mime(extension: &str) -> Option<&'static str> {
    match extension {
        "png" => Some("image/png"),
        "jpg" | "jpeg" => Some("image/jpeg"),
        "gif" => Some("image/gif"),
        "webp" => Some("image/webp"),
        "svg" => Some("image/svg+xml"),
        "avif" => Some("image/avif"),
        "bmp" => Some("image/bmp"),
        "ico" => Some("image/x-icon"),
        _ => None,
    }
}

async fn runtime_health(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<RuntimeHealthResponse>, ApiError> {
    require_runtime_access(&state, &headers)?;
    Ok(Json(runtime_control(&state)?.health()))
}

async fn attach_runtime_client(
    State(state): State<AppState>,
    headers: HeaderMap,
    Json(body): Json<RuntimeClientRequest>,
) -> Result<Json<RuntimeClientResponse>, ApiError> {
    require_runtime_access(&state, &headers)?;
    runtime_control(&state)?
        .attach(body)
        .map(Json)
        .map_err(runtime_client_error)
}

async fn detach_runtime_client(
    State(state): State<AppState>,
    headers: HeaderMap,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<RuntimeClientResponse>, ApiError> {
    require_runtime_access(&state, &headers)?;
    runtime_control(&state)?
        .detach(&id)
        .map(Json)
        .map_err(runtime_client_error)
}

fn runtime_control(state: &AppState) -> Result<&Arc<RuntimeControl>, ApiError> {
    state
        .runtime
        .as_ref()
        .ok_or_else(|| ApiError::not_found("runtime service management is disabled"))
}

fn require_runtime_access(state: &AppState, headers: &HeaderMap) -> Result<(), ApiError> {
    if state.security.has_bearer(headers) {
        Ok(())
    } else {
        Err(ApiError::auth_required(
            "runtime service management requires the private startup token",
        ))
    }
}

fn runtime_client_error(error: RuntimeClientError) -> ApiError {
    match error {
        RuntimeClientError::InvalidId => ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_RUNTIME_CLIENT",
            error.to_string(),
        ),
        RuntimeClientError::VersionMismatch { .. } => ApiError::new(
            StatusCode::CONFLICT,
            "RUNTIME_VERSION_MISMATCH",
            error.to_string(),
        ),
        RuntimeClientError::NotFound(_) => ApiError::new(
            StatusCode::NOT_FOUND,
            "RUNTIME_CLIENT_NOT_FOUND",
            error.to_string(),
        ),
    }
}

async fn health() -> Json<HealthResponse> {
    Json(HealthResponse { ok: true })
}

async fn create_session(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Response, ApiError> {
    if state.security.remote_access()
        && !state.security.has_session(&headers)
        && !state.security.has_bearer(&headers)
    {
        return Err(ApiError::auth_required(
            "远程访问需要通过 URL fragment 提供 OSHEEP_AUTH_TOKEN",
        ));
    }
    Ok((
        [
            (header::CACHE_CONTROL, HeaderValue::from_static("no-store")),
            (
                header::SET_COOKIE,
                HeaderValue::from_str(&state.security.session_cookie()).unwrap(),
            ),
        ],
        Json(HealthResponse { ok: true }),
    )
        .into_response())
}

async fn terminal_profiles(State(state): State<AppState>) -> Json<ShellProfilesResponse> {
    Json(ShellProfilesResponse {
        os: if cfg!(windows) {
            "windows"
        } else if cfg!(target_os = "macos") {
            "macos"
        } else {
            "linux"
        }
        .into(),
        profiles: state.pty.profiles(),
    })
}

async fn list_terminals(State(state): State<AppState>) -> Json<TerminalSessionsResponse> {
    Json(TerminalSessionsResponse {
        sessions: state.pty.list(),
    })
}

async fn create_terminal(
    State(state): State<AppState>,
    Json(body): Json<CreateTerminalRequest>,
) -> Result<Json<CreateTerminalResponse>, ApiError> {
    let workspace_id = body
        .workspace_id
        .ok_or_else(|| ApiError::invalid_path("缺少 workspaceId"))?;
    let shell = body.shell.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "UNSUPPORTED_SHELL",
            "服务器未探测到 shell: undefined",
        )
    })?;
    let workspace = state.workspaces.resolve(&workspace_id).await?;
    let workspaces_root = state.workspaces.canonical_root().await?;
    let session = state
        .pty
        .spawn(SpawnRequest {
            workspace_id,
            cwd: workspace.path,
            workspaces_root,
            shell,
            cols: body.cols.unwrap_or(80),
            rows: body.rows.unwrap_or(24),
            kill_on_detach: true,
        })
        .await?;
    let summary = session.summary();
    Ok(Json(CreateTerminalResponse {
        id: summary.id.clone(),
        shell: summary.shell,
        cols: summary.cols,
        rows: summary.rows,
        ws_url: format!("/api/terminals/{}/io", summary.id),
    }))
}

async fn delete_terminal(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<DeleteTerminalResponse>, ApiError> {
    if state.pty.get(&id).is_none() {
        return Err(osheep_pty::PtyError::SessionNotFound(id).into());
    }
    state.pty.kill(&id).await?;
    Ok(Json(DeleteTerminalResponse { id }))
}

async fn terminal_io(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    upgrade: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let session = state
        .pty
        .get(&id)
        .ok_or_else(|| osheep_pty::PtyError::SessionNotFound(id.clone()))?;
    Ok(upgrade
        .on_upgrade(move |socket| terminal_socket(socket, session))
        .into_response())
}

async fn terminal_socket(socket: WebSocket, session: Arc<dyn PtySession>) {
    terminal_socket_inner(socket, session.clone()).await;
    if session.kill_on_detach() {
        let _ = session.kill().await;
    }
}

async fn terminal_socket_inner(socket: WebSocket, session: Arc<dyn PtySession>) {
    let (replay, mut events) = session.attach();
    let summary = session.summary();
    let (mut sender, mut receiver) = socket.split();
    if send_frame(
        &mut sender,
        ServerTerminalFrame::ReplayStart {
            cols: summary.cols,
            rows: summary.rows,
            initial_cols: replay.initial_cols,
            initial_rows: replay.initial_rows,
            resizes: replay.resizes,
            compact_startup: false,
            truncated: replay.truncated,
        },
    )
    .await
    .is_err()
    {
        return;
    }
    for chunk in terminal_replay_chunks(&replay.data) {
        if send_frame(
            &mut sender,
            ServerTerminalFrame::ReplayChunk {
                data: chunk.to_owned(),
            },
        )
        .await
        .is_err()
        {
            return;
        }
    }
    if send_frame(&mut sender, ServerTerminalFrame::ReplayEnd)
        .await
        .is_err()
    {
        return;
    }

    let mut heartbeat = tokio::time::interval(Duration::from_secs(15));
    loop {
        tokio::select! {
            incoming = receiver.next() => {
                let Some(Ok(message)) = incoming else { break };
                if handle_client_message(&session, &mut sender, message).await.is_err() {
                    break;
                }
            }
            event = events.recv() => {
                match event {
                    Ok(PtyEvent::Output(data)) => {
                        if send_frame(&mut sender, ServerTerminalFrame::Output { data }).await.is_err() {
                            break;
                        }
                    }
                    Ok(PtyEvent::Exit { code, signal }) => {
                        let _ = send_frame(&mut sender, ServerTerminalFrame::Exit { code, signal }).await;
                        break;
                    }
                    Ok(PtyEvent::Error(message)) => {
                        let _ = send_frame(&mut sender, ServerTerminalFrame::Error { message }).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => {
                        let _ = send_frame(&mut sender, ServerTerminalFrame::Error {
                            message: "terminal output consumer is too slow".into(),
                        }).await;
                        break;
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
            _ = heartbeat.tick() => {
                if send_frame(&mut sender, ServerTerminalFrame::Ping).await.is_err() {
                    break;
                }
            }
        }
    }
}

// P6 capability endpoints keep their state in the Rust service.  These handlers are
// intentionally small, but provide stable JSON contracts while the domain workers
// (CLI adapters, plugin installers and workflow executor) are brought over.
async fn p6_ok() -> Json<Value> {
    Json(serde_json::json!({"ok": true}))
}

async fn ai_settings(State(state): State<AppState>) -> Json<Value> {
    Json(state.p6_state.lock().await["aiSettings"].clone())
}

async fn update_ai_settings(State(state): State<AppState>, Json(body): Json<Value>) -> Json<Value> {
    state.p6_state.lock().await["aiSettings"] = body;
    ai_settings(State(state)).await
}

async fn ai_live_settings(AxumPath(app): AxumPath<String>) -> Json<Value> {
    Json(serde_json::json!({"app": app, "settingsConfig": {}}))
}

async fn upsert_ai_provider(State(state): State<AppState>, Json(body): Json<Value>) -> Json<Value> {
    let app = body.get("app").and_then(Value::as_str).unwrap_or("claude");
    let id = body
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or("default")
        .to_owned();
    let mut root = state.p6_state.lock().await;
    let item = &mut root["aiSettings"]["state"]["apps"][app];
    if !item.is_object() {
        *item = serde_json::json!({"providers": {}, "current": ""});
    }
    if !item["providers"].is_object() {
        item["providers"] = serde_json::json!({});
    }
    let provider = body
        .get("provider")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    item["providers"][id] = provider;
    Json(root["aiSettings"].clone())
}

async fn delete_ai_provider(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Json<Value> {
    let mut root = state.p6_state.lock().await;
    for app in ["claude", "codex"] {
        if let Some(values) = root["aiSettings"]["state"]["apps"][app]["providers"].as_object_mut()
        {
            values.remove(&id);
        }
    }
    Json(root["aiSettings"].clone())
}

async fn ai_cli_status() -> Json<Value> {
    Json(
        serde_json::json!({"claude": {"installed": false, "path": null, "command": "claude"}, "codex": {"installed": false, "path": null, "command": "codex"}}),
    )
}

async fn ai_cli_tools() -> Json<Value> {
    Json(
        serde_json::json!({"tools": [{"name": "claude", "installed": false}, {"name": "codex", "installed": false}]}),
    )
}

async fn adapters() -> Json<Value> {
    Json(serde_json::json!({"adapters": []}))
}

async fn adapter_events(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|mut socket| async move {
        let _ = socket
            .send(Message::Text(
                serde_json::json!({"type":"ready","sessions":[],"events":[],"updatedAt": now_ms()})
                    .to_string()
                    .into(),
            ))
            .await;
    })
}

async fn skills(State(state): State<AppState>) -> Json<Value> {
    Json(state.p6_state.lock().await["skills"].clone())
}

async fn skills_library(
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let _ = query;
    Json(serde_json::json!({"skills": []}))
}

async fn skill_mutation(State(state): State<AppState>, Json(_body): Json<Value>) -> Json<Value> {
    Json(serde_json::json!({"ok": true, "snapshot": state.p6_state.lock().await["skills"].clone()}))
}

async fn claude_plugins(State(state): State<AppState>) -> Json<Value> {
    Json(state.p6_state.lock().await["claudePlugins"].clone())
}

async fn codex_plugins(State(state): State<AppState>) -> Json<Value> {
    Json(state.p6_state.lock().await["codexPlugins"].clone())
}

async fn plugin_mutation(State(_state): State<AppState>, Json(_body): Json<Value>) -> Json<Value> {
    Json(serde_json::json!({"ok": true, "result": {}}))
}

async fn template_capabilities() -> Json<Value> {
    Json(serde_json::json!({"developerMode": false}))
}

async fn templates() -> Json<Value> {
    Json(serde_json::json!({"system": [], "user": []}))
}

async fn template_marketspace() -> Json<Value> {
    Json(serde_json::json!({"templates": [], "updatedAt": now_ms()}))
}

async fn template_get(
    AxumPath((_source, _tid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_found("template not found"))
}

async fn template_icon(
    AxumPath((_source, _tid)): AxumPath<(String, String)>,
) -> Result<Response, ApiError> {
    Err(ApiError::not_found("template icon not found"))
}

async fn workflow_usage() -> Json<Value> {
    Json(serde_json::json!({"runs": [], "totalCost": 0, "totalTokens": 0}))
}

async fn workflows(AxumPath(_id): AxumPath<String>) -> Json<Value> {
    Json(serde_json::json!({"workflows": []}))
}

async fn workflow_create(AxumPath(_id): AxumPath<String>, Json(body): Json<Value>) -> Json<Value> {
    let id = format!("wf_{}", uuid::Uuid::new_v4().simple());
    Json(
        serde_json::json!({"id": id, "title": body.get("title").cloned().unwrap_or_else(|| serde_json::json!("Untitled")), "nodes": [], "edges": [], "runs": []}),
    )
}

async fn workflow_get(
    AxumPath((_id, wid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    Err(ApiError::not_found(format!("workflow not found: {wid}")))
}

async fn workflow_save(
    AxumPath((_id, wid)): AxumPath<(String, String)>,
    Json(mut body): Json<Value>,
) -> Json<Value> {
    if body.get("id").is_none() {
        body["id"] = Value::String(wid);
    }
    Json(body)
}

async fn workflow_run(AxumPath((_id, wid)): AxumPath<(String, String)>) -> Json<Value> {
    Json(serde_json::json!({"ok": true, "workflowId": wid, "status": "queued"}))
}

async fn workflow_events(
    ws: WebSocketUpgrade,
    AxumPath((_id, wid)): AxumPath<(String, String)>,
) -> Response {
    ws.on_upgrade(move |mut socket| async move {
        let _ = socket
            .send(Message::Text(
                serde_json::json!({"type":"ready","workflowId":wid,"updatedAt":now_ms()})
                    .to_string()
                    .into(),
            ))
            .await;
    })
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

async fn handle_client_message(
    session: &Arc<dyn PtySession>,
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    message: Message,
) -> Result<(), ()> {
    let bytes = match message {
        Message::Text(text) => text.as_bytes().to_vec(),
        Message::Binary(bytes) => bytes.to_vec(),
        Message::Ping(bytes) => return sender.send(Message::Pong(bytes)).await.map_err(|_| ()),
        Message::Pong(_) => return Ok(()),
        Message::Close(_) => return Err(()),
    };
    let value: Value = match serde_json::from_slice(&bytes) {
        Ok(value) => value,
        Err(_) => {
            return send_frame(
                sender,
                ServerTerminalFrame::Error {
                    message: "invalid JSON frame".into(),
                },
            )
            .await;
        }
    };
    match value.get("type").and_then(Value::as_str) {
        Some("input") => {
            if let Some(data) = value.get("data").and_then(Value::as_str) {
                session.input(data.to_owned()).await.map_err(|_| ())?;
            }
        }
        Some("resize") => {
            if let (Some(cols), Some(rows)) = (
                value.get("cols").and_then(Value::as_u64),
                value.get("rows").and_then(Value::as_u64),
            ) {
                let Ok(cols) = u16::try_from(cols) else {
                    return Ok(());
                };
                let Ok(rows) = u16::try_from(rows) else {
                    return Ok(());
                };
                let compact_startup = value
                    .get("compactStartup")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                if let Err(error) = session.resize(cols, rows, compact_startup).await {
                    send_frame(
                        sender,
                        ServerTerminalFrame::Error {
                            message: error.to_string(),
                        },
                    )
                    .await?;
                }
            }
        }
        Some("ping") => {
            send_frame(sender, ServerTerminalFrame::Pong).await?;
        }
        Some("pong") | None | Some(_) => {}
    }
    Ok(())
}

async fn send_frame(
    sender: &mut futures_util::stream::SplitSink<WebSocket, Message>,
    frame: ServerTerminalFrame,
) -> Result<(), ()> {
    let text = serde_json::to_string(&frame).map_err(|_| ())?;
    sender
        .send(Message::Text(text.into()))
        .await
        .map_err(|_| ())
}

fn terminal_replay_chunks(data: &str) -> Vec<&str> {
    let mut chunks = Vec::new();
    let mut offset = 0;
    while offset < data.len() {
        let mut end = (offset + TERMINAL_REPLAY_CHUNK_BYTES).min(data.len());
        while !data.is_char_boundary(end) {
            end -= 1;
        }
        chunks.push(&data[offset..end]);
        offset = end;
    }
    chunks
}

async fn static_fallback(State(state): State<AppState>, uri: Uri, headers: HeaderMap) -> Response {
    static_site::serve(state.frontend_root.as_deref(), &uri, &headers).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn replay_chunks_preserve_utf8_and_size_limit() {
        let text = format!("{}中文", "x".repeat(TERMINAL_REPLAY_CHUNK_BYTES - 1));
        let chunks = terminal_replay_chunks(&text);
        assert_eq!(chunks.concat(), text);
        assert!(chunks
            .iter()
            .all(|chunk| chunk.len() <= TERMINAL_REPLAY_CHUNK_BYTES));
    }

    #[test]
    fn base64_round_trips_binary_payloads_and_rejects_invalid_input() {
        for bytes in [
            Vec::new(),
            vec![0],
            vec![0, 1],
            vec![0, 1, 2],
            vec![0, 1, 2, 253, 254, 255],
        ] {
            let encoded = encode_base64(&bytes);
            assert_eq!(decode_base64(&encoded).unwrap(), bytes);
        }
        assert!(decode_base64("abc").is_err());
        assert!(decode_base64("ab=c").is_err());
        assert!(decode_base64("!!!!").is_err());
    }

    #[test]
    fn search_query_parsing_matches_node_route_boundaries() {
        assert!(search_query_bool(Some("true")));
        assert!(search_query_bool(Some("1")));
        assert!(!search_query_bool(Some("TRUE")));
        assert_eq!(
            search_query_list(Some(" src/** , , *.md ")),
            ["src/**", "*.md"]
        );
        assert_eq!(search_query_limit(Some("12suffix"), 100, 1000), 12);
        assert_eq!(search_query_limit(Some("0"), 100, 1000), 100);
        assert_eq!(search_query_limit(Some("-1"), 100, 1000), 100);
        assert_eq!(search_query_limit(Some(&"9".repeat(100)), 100, 1000), 1000);
        assert_eq!(search_query_limit(Some(&"9".repeat(400)), 100, 1000), 100);
    }

    #[test]
    fn git_log_query_parsing_matches_node_route_boundaries() {
        assert_eq!(git_log_limit(None), 200);
        assert_eq!(git_log_limit(Some("12suffix")), 12);
        assert_eq!(git_log_limit(Some("0")), 200);
        assert_eq!(git_log_limit(Some("-9")), 1);
        assert_eq!(git_log_limit(Some(&"9".repeat(200))), 100_000);
        assert_eq!(git_log_offset(Some("  +42files")), 42);
        assert_eq!(git_log_offset(Some("-2")), 0);
        assert_eq!(git_log_offset(Some("invalid")), 0);
    }

    #[test]
    fn file_io_diagnostics_classify_latency_and_storage_location() {
        let sync_root = PathBuf::from(r"C:\Users\Example\OneDrive");
        let sync_file = sync_root.join("project").join("note.txt");
        let local_file = Path::new(r"C:\workspace\note.txt");

        assert_eq!(
            file_io_diagnostic(
                &sync_file,
                Duration::from_millis(249),
                std::slice::from_ref(&sync_root),
            ),
            "normal"
        );
        assert_eq!(
            file_io_diagnostic(
                &sync_file,
                Duration::from_millis(250),
                std::slice::from_ref(&sync_root),
            ),
            "slow-sync"
        );
        assert_eq!(
            file_io_diagnostic(
                local_file,
                Duration::from_millis(250),
                std::slice::from_ref(&sync_root),
            ),
            "slow-local"
        );
        assert!(!path_starts_with_platform(
            Path::new(r"C:\Users\Example\OneDrive-old\note.txt"),
            &sync_root,
        ));
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn file_io_diagnostics_classify_unc_paths_as_network_storage() {
        assert_eq!(
            file_io_diagnostic(
                Path::new(r"\\server\share\note.txt"),
                Duration::from_millis(250),
                &[],
            ),
            "slow-network"
        );
    }
}
