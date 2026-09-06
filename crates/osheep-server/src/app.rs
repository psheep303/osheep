use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::runtime::{RuntimeClientError, RuntimeControl};
use crate::security::{require_origin, require_session, Security, SecurityError};
use crate::skills_library::SkillsLibrary;
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
    skills_library: SkillsLibrary,
    workflow_runtime: crate::workflow_runtime::WorkflowRuntime,
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
    let store = Arc::new(StateStore::new(config.data_root.clone()));
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
    let ai_settings_paths = ai_settings_paths(&config.data_root);
    let skills_library_service = SkillsLibrary::new(&config.data_root).await;
    let ai_settings_state = normalize_ai_settings_state(
        store
            .read_value("ai-settings.json", default_ai_settings_state())
            .await?,
    );
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
        skills_library: skills_library_service,
        workflow_runtime: crate::workflow_runtime::WorkflowRuntime::default(),
        p6_state: Arc::new(Mutex::new(serde_json::json!({
            "aiSettings": {"state": ai_settings_state, "paths": ai_settings_paths},
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
            "/api/agent-sessions/{app}/{id}/terminal",
            post(create_agent_session_terminal),
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
        .route(
            "/api/ai-settings/import-live",
            post(import_ai_live_provider),
        )
        .route("/api/ai-settings/providers", post(upsert_ai_provider))
        .route(
            "/api/ai-settings/providers/{id}",
            put(upsert_ai_provider).delete(delete_ai_provider),
        )
        .route("/api/ai-settings/switch", post(switch_ai_provider))
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
        .route("/api/skills", get(skills))
        .route("/api/skills/library", get(skills_library))
        .route("/api/skills/install", post(skill_mutation))
        .route("/api/skills/import", post(skill_mutation))
        .route("/api/skills/enable", post(enable_skill))
        .route("/api/skills/disable", post(disable_skill))
        .route("/api/skills/apply", post(skill_mutation))
        .route("/api/skills/delete", post(delete_skill))
        .route("/api/claude-plugins", get(claude_plugins))
        .route("/api/claude-plugins/install", post(claude_plugin_install))
        .route(
            "/api/claude-plugins/uninstall",
            post(claude_plugin_uninstall),
        )
        .route("/api/claude-plugins/enable", post(claude_plugin_enable))
        .route("/api/claude-plugins/disable", post(claude_plugin_disable))
        .route(
            "/api/claude-plugins/marketplaces",
            post(claude_marketplace_add),
        )
        .route("/api/codex-plugins", get(codex_plugins))
        .route("/api/codex-plugins/install", post(codex_plugin_install))
        .route("/api/codex-plugins/uninstall", post(codex_plugin_uninstall))
        .route("/api/codex-plugins/local", post(plugin_mutation))
        .route("/api/codex-plugins/import-local", post(plugin_mutation))
        .route("/api/codex-plugins/local/{name}", delete(plugin_mutation))
        .route(
            "/api/codex-plugins/marketplaces",
            post(codex_marketplace_add),
        )
        .route("/api/templates/capabilities", get(template_capabilities))
        .route("/api/templates", get(templates))
        .route("/api/templates/local", get(templates))
        .route("/api/templates/marketspace", get(template_marketspace))
        .route(
            "/api/templates/marketspace/{id}/install",
            post(template_marketspace_install),
        )
        .route(
            "/api/templates/{source}/{tid}",
            get(template_get).delete(delete_template),
        )
        .route(
            "/api/templates/{source}/{tid}/icon",
            get(template_icon).put(update_template_icon),
        )
        .route("/api/workflow-usage", get(workflow_usage))
        .route(
            "/api/workspaces/{id}/workflows",
            get(workflows).post(workflow_create),
        )
        .route("/api/workspaces/{id}/workflows/usage", get(workflow_usage))
        .route(
            "/api/workspaces/{id}/workflows/{wid}",
            get(workflow_get).put(workflow_save).delete(delete_workflow),
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
        .route(
            "/api/workspaces/{id}/workflows/{wid}/pause",
            post(workflow_pause),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/stop",
            post(workflow_stop),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/events",
            get(workflow_events),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/nodes/{nodeId}/approval",
            post(resolve_workflow_approval),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/nodes/{nodeId}/input",
            post(resolve_workflow_input),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/nodes/{nodeId}/retry-now",
            post(p6_ok),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/template",
            post(save_workflow_as_template),
        )
        .route(
            "/api/workspaces/{id}/workflows/{wid}/system-template",
            post(save_workflow_as_system_template),
        )
        .route(
            "/api/workspaces/{id}/templates/{source}/{tid}/edit",
            post(edit_template_workflow),
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
        // Keep the public path in the same form users configured. On Windows,
        // `canonicalize` exposes an implementation-only `\\\\?\\` prefix.
        "path": state.workspaces.root().await
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

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSessionTerminalBody {
    workspace_id: Option<String>,
    shell: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
}

async fn create_agent_session_terminal(
    State(state): State<AppState>,
    AxumPath((app, id)): AxumPath<(String, String)>,
    Json(body): Json<AgentSessionTerminalBody>,
) -> Result<Json<CreateTerminalResponse>, ApiError> {
    let app = AgentSessionApp::parse(&app)?;
    let workspace_id = body
        .workspace_id
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "workspaceId is required",
            )
        })?;
    let shell = body.shell.ok_or_else(|| {
        ApiError::new(
            StatusCode::BAD_REQUEST,
            "UNSUPPORTED_SHELL",
            "服务器未探测到 shell: undefined",
        )
    })?;
    let workspace = state.workspaces.resolve(&workspace_id).await?;
    let agent_session = state
        .agent_sessions
        .get_in_project(app, &id, &workspace.path)
        .await?;
    let cwd = PathBuf::from(&agent_session.cwd);
    if !tokio::fs::metadata(&cwd)
        .await
        .map(|meta| meta.is_dir())
        .unwrap_or(false)
    {
        return Err(ApiError::not_found(format!(
            "Session working directory no longer exists: {}",
            agent_session.cwd
        )));
    }
    let session = state
        .pty
        .spawn(SpawnRequest {
            workspace_id: format!(
                "agent-{}-{}",
                match app {
                    AgentSessionApp::Claude => "claude",
                    AgentSessionApp::Codex => "codex",
                },
                agent_session.id
            ),
            cwd: cwd.clone(),
            workspaces_root: cwd,
            shell,
            cols: body.cols.unwrap_or(80),
            rows: body.rows.unwrap_or(24),
            kill_on_detach: true,
        })
        .await?;
    let resume = match app {
        AgentSessionApp::Claude => format!("claude --resume {}\r", agent_session.id),
        AgentSessionApp::Codex if cfg!(windows) => {
            format!("codex.cmd resume {}\r", agent_session.id)
        }
        AgentSessionApp::Codex => format!("codex resume {}\r", agent_session.id),
    };
    session.input(resume).await?;
    let summary = session.summary();
    Ok(Json(CreateTerminalResponse {
        id: summary.id.clone(),
        shell: summary.shell,
        cols: summary.cols,
        rows: summary.rows,
        ws_url: format!("/api/terminals/{}/io", summary.id),
    }))
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

fn default_ai_settings_state() -> Value {
    serde_json::json!({"version": 1, "apps": {
        "claude": {"providers": {}, "current": ""},
        "codex": {"providers": {}, "current": ""}
    }})
}

fn normalize_ai_settings_state(mut value: Value) -> Value {
    if !value.is_object() {
        return default_ai_settings_state();
    }
    value["version"] = Value::from(1);
    if !value["apps"].is_object() {
        value["apps"] = serde_json::json!({});
    }
    for app in ["claude", "codex"] {
        if !value["apps"][app].is_object() {
            value["apps"][app] = serde_json::json!({});
        }
        let manager = &mut value["apps"][app];
        if !manager["providers"].is_object() {
            manager["providers"] = serde_json::json!({});
        }
        if !manager["current"].is_string() {
            manager["current"] = Value::String(String::new());
        }
    }
    value
}

async fn persist_ai_settings(state: &AppState, root: &Value) -> Result<(), ApiError> {
    state
        .store
        .write_value("ai-settings.json", root["aiSettings"]["state"].clone())
        .await?;
    Ok(())
}

fn ai_settings_paths(data_root: &Path) -> Value {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.to_path_buf());
    let claude_dir = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let codex_dir = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let claude_settings = claude_dir.join("settings.json");
    let codex_auth = codex_dir.join("auth.json");
    let codex_config = codex_dir.join("config.toml");
    serde_json::json!({
        "store": data_root.join("ai-settings.json"),
        "claude": {"dir": claude_dir, "settings": claude_settings, "exists": claude_settings.exists()},
        "codex": {"dir": codex_dir, "auth": codex_auth, "config": codex_config, "authExists": codex_auth.exists(), "configExists": codex_config.exists()}
    })
}

async fn ai_settings(State(state): State<AppState>) -> Json<Value> {
    Json(state.p6_state.lock().await["aiSettings"].clone())
}

async fn update_ai_settings(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let next_state = normalize_ai_settings_state(body);
    let mut root = state.p6_state.lock().await;
    root["aiSettings"]["state"] = next_state;
    persist_ai_settings(&state, &root).await?;
    Ok(Json(root["aiSettings"].clone()))
}

async fn ai_live_settings(AxumPath(app): AxumPath<String>) -> Json<Value> {
    Json(serde_json::json!({"app": app, "settingsConfig": {}}))
}

async fn import_ai_live_provider(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let app = body.get("app").and_then(Value::as_str).unwrap_or("");
    if !matches!(app, "claude" | "codex") {
        return Err(ApiError::invalid_path("app must be claude or codex"));
    }
    let paths = state.p6_state.lock().await["aiSettings"]["paths"].clone();
    let settings_config = match app {
        "claude" => {
            let path = paths["claude"]["settings"]
                .as_str()
                .map(PathBuf::from)
                .ok_or_else(|| ApiError::not_found("Claude live settings not found"))?;
            let text = tokio::fs::read_to_string(path)
                .await
                .map_err(|_| ApiError::not_found("Claude live settings not found"))?;
            serde_json::from_str(&text)
                .map_err(|_| ApiError::invalid_path("Claude settings JSON is invalid"))?
        }
        "codex" => {
            let mut value = serde_json::Map::new();
            for field in ["auth", "config"] {
                if let Some(path) = paths["codex"][field].as_str() {
                    if let Ok(text) = tokio::fs::read_to_string(path).await {
                        value.insert(
                            field.to_owned(),
                            if field == "auth" {
                                serde_json::from_str(&text).unwrap_or(Value::String(text))
                            } else {
                                Value::String(text)
                            },
                        );
                    }
                }
            }
            if value.is_empty() {
                return Err(ApiError::not_found("Codex live settings not found"));
            }
            Value::Object(value)
        }
        _ => unreachable!(),
    };
    let mut root = state.p6_state.lock().await;
    let manager = &mut root["aiSettings"]["state"]["apps"][app];
    let providers = manager["providers"]
        .as_object_mut()
        .expect("normalized providers");
    let requested = body
        .get("id")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .unwrap_or("live");
    let mut id = requested.to_owned();
    let mut suffix = 2;
    while providers.contains_key(&id) {
        id = format!("{requested}-{suffix}");
        suffix += 1;
    }
    providers.insert(id.clone(), serde_json::json!({
        "id": id, "name": body.get("name").and_then(Value::as_str).unwrap_or(if app == "claude" { "Claude live" } else { "Codex live" }),
        "category": "custom", "settingsConfig": settings_config, "createdAt": now_ms()
    }));
    manager["current"] = Value::String(id);
    persist_ai_settings(&state, &root).await?;
    Ok(Json(root["aiSettings"].clone()))
}

async fn upsert_ai_provider(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
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
    let provider_id = provider
        .get("id")
        .and_then(Value::as_str)
        .unwrap_or(&id)
        .to_owned();
    item["providers"][&provider_id] = provider;
    if item["current"].as_str().unwrap_or("").is_empty() {
        item["current"] = Value::String(provider_id);
    }
    persist_ai_settings(&state, &root).await?;
    Ok(Json(root["aiSettings"].clone()))
}

async fn delete_ai_provider(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    let mut root = state.p6_state.lock().await;
    let app = query.get("app").map(String::as_str).unwrap_or("claude");
    if let Some(values) = root["aiSettings"]["state"]["apps"][app]["providers"].as_object_mut() {
        values.remove(&id);
    }
    persist_ai_settings(&state, &root).await?;
    Ok(Json(root["aiSettings"].clone()))
}

async fn switch_ai_provider(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let app = body.get("app").and_then(Value::as_str).unwrap_or("claude");
    let id = body.get("id").and_then(Value::as_str).unwrap_or("");
    let mut root = state.p6_state.lock().await;
    let manager = &mut root["aiSettings"]["state"]["apps"][app];
    if manager["providers"].get(id).is_some() {
        manager["current"] = Value::String(id.to_owned());
    }
    persist_ai_settings(&state, &root).await?;
    Ok(Json(root["aiSettings"].clone()))
}

async fn ai_cli_status() -> Json<Value> {
    let claude = find_path_executable("claude");
    let codex = find_path_executable("codex");
    Json(serde_json::json!({
        "claude": {"installed":claude.is_some(),"path":claude,"command":"claude"},
        "codex": {"installed":codex.is_some(),"path":codex,"command":"codex"}
    }))
}

async fn ai_cli_tools() -> Json<Value> {
    let claude = find_path_executable("claude");
    let codex = find_path_executable("codex");
    Json(serde_json::json!({"tools": [
        {"name":"claude","installed":claude.is_some(),"path":claude},
        {"name":"codex","installed":codex.is_some(),"path":codex}
    ]}))
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

async fn skills(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(skills_snapshot(&state).await?))
}

async fn skills_library(
    State(state): State<AppState>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Json<Value> {
    let skills = state
        .skills_library
        .search(query.get("q").map(String::as_str).unwrap_or(""))
        .await;
    Json(serde_json::json!({"skills": skills}))
}

async fn skill_mutation(
    State(state): State<AppState>,
    Json(_body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(
        serde_json::json!({"ok": true, "snapshot": skills_snapshot(&state).await?}),
    ))
}

fn skill_staging_root(state: &AppState, agent: &str) -> Result<PathBuf, ApiError> {
    if !matches!(agent, "claude" | "codex") {
        return Err(ApiError::invalid_path("agent must be claude or codex"));
    }
    Ok(state.store.root().join("skills").join(agent))
}

fn skill_dir(root: &Path, name: &str) -> Result<PathBuf, ApiError> {
    if !valid_name(name) {
        return Err(ApiError::invalid_path("skill name is invalid"));
    }
    Ok(root.join(name))
}

async fn move_skill_directory(source: &Path, destination: &Path) -> Result<(), ApiError> {
    if !tokio::fs::try_exists(source.join("SKILL.md"))
        .await
        .unwrap_or(false)
    {
        return Err(ApiError::not_found("skill not found"));
    }
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    if tokio::fs::try_exists(destination).await.unwrap_or(false) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ENTRY_EXISTS",
            "a skill with the same name already exists",
        ));
    }
    match tokio::fs::rename(source, destination).await {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_directory_if_missing(source, destination).await?;
            tokio::fs::remove_dir_all(source).await?;
            Ok(())
        }
    }
}

async fn enable_skill(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    let name = body.get("name").and_then(Value::as_str).unwrap_or("");
    let source = skill_dir(&skill_staging_root(&state, agent)?, name)?;
    let target_root = skill_live_roots(agent)
        .into_iter()
        .next()
        .expect("agent skill root");
    let target = skill_dir(&target_root, name)?;
    move_skill_directory(&source, &target).await?;
    Ok(Json(
        serde_json::json!({"snapshot": skills_snapshot(&state).await?}),
    ))
}

async fn disable_skill(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    let name = body.get("name").and_then(Value::as_str).unwrap_or("");
    let target = skill_dir(&skill_staging_root(&state, agent)?, name)?;
    let source = skill_live_roots(agent)
        .into_iter()
        .filter_map(|root| skill_dir(&root, name).ok())
        .find(|path| path.join("SKILL.md").exists())
        .ok_or_else(|| ApiError::not_found("skill not found"))?;
    move_skill_directory(&source, &target).await?;
    Ok(Json(
        serde_json::json!({"snapshot": skills_snapshot(&state).await?}),
    ))
}

async fn delete_skill(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    let name = body.get("name").and_then(Value::as_str).unwrap_or("");
    let path = skill_dir(&skill_staging_root(&state, agent)?, name)?;
    if tokio::fs::try_exists(path.join(".osheep-built-in"))
        .await
        .unwrap_or(false)
    {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "BUILT_IN_SKILL",
            "Built-in skills cannot be deleted",
        ));
    }
    tokio::fs::remove_dir_all(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found("skill not found")
        } else {
            error.into()
        }
    })?;
    Ok(Json(
        serde_json::json!({"snapshot": skills_snapshot(&state).await?}),
    ))
}

async fn claude_plugins(State(state): State<AppState>) -> Json<Value> {
    let snapshot = crate::plugin_catalog::claude_snapshot().await;
    state.p6_state.lock().await["claudePlugins"] = snapshot.clone();
    Json(snapshot)
}

async fn codex_plugins(State(state): State<AppState>) -> Json<Value> {
    let snapshot = crate::plugin_catalog::codex_snapshot().await;
    state.p6_state.lock().await["codexPlugins"] = snapshot.clone();
    Json(snapshot)
}

async fn plugin_mutation(State(_state): State<AppState>, Json(_body): Json<Value>) -> Json<Value> {
    Json(serde_json::json!({"ok": true, "result": {}}))
}

async fn claude_plugin_install(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let selector = plugin_selector(&body)?;
    run_plugin_cli("claude", &["plugin", "install", selector]).await?;
    plugin_snapshot_response(&state, "claude").await
}

async fn claude_plugin_uninstall(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let selector = plugin_selector(&body)?;
    let mut args = vec!["plugin", "uninstall", selector, "--yes"];
    if let Some(scope) = body.get("scope").and_then(Value::as_str) {
        args.extend(["--scope", scope]);
    }
    run_plugin_cli("claude", &args).await?;
    plugin_snapshot_response(&state, "claude").await
}

async fn claude_plugin_enable(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let selector = plugin_selector(&body)?;
    run_plugin_cli("claude", &["plugin", "enable", selector]).await?;
    plugin_snapshot_response(&state, "claude").await
}

async fn claude_plugin_disable(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let selector = plugin_selector(&body)?;
    run_plugin_cli("claude", &["plugin", "disable", selector]).await?;
    plugin_snapshot_response(&state, "claude").await
}

async fn claude_marketplace_add(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let source = plugin_source(&body)?;
    run_plugin_cli("claude", &["plugin", "marketplace", "add", source]).await?;
    plugin_snapshot_response(&state, "claude").await
}

async fn codex_plugin_install(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let selector = plugin_selector(&body)?;
    run_plugin_cli("codex", &["plugin", "add", selector, "--json"]).await?;
    plugin_snapshot_response(&state, "codex").await
}

async fn codex_plugin_uninstall(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let selector = plugin_selector(&body)?;
    run_plugin_cli("codex", &["plugin", "remove", selector, "--json"]).await?;
    plugin_snapshot_response(&state, "codex").await
}

async fn codex_marketplace_add(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let source = plugin_source(&body)?;
    run_plugin_cli("codex", &["plugin", "marketplace", "add", source, "--json"]).await?;
    plugin_snapshot_response(&state, "codex").await
}

fn plugin_selector(body: &Value) -> Result<&str, ApiError> {
    body.get("selector")
        .and_then(Value::as_str)
        .filter(|value| {
            !value.is_empty()
                && value.len() <= 200
                && !value.chars().any(char::is_control)
                && !value.chars().any(char::is_whitespace)
        })
        .ok_or_else(|| ApiError::invalid_path("plugin selector is invalid"))
}

fn plugin_source(body: &Value) -> Result<&str, ApiError> {
    body.get("source")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty() && value.len() <= 2048)
        .ok_or_else(|| ApiError::invalid_path("plugin marketplace source is invalid"))
}

async fn plugin_snapshot_response(state: &AppState, app: &str) -> Result<Json<Value>, ApiError> {
    let snapshot = if app == "claude" {
        crate::plugin_catalog::claude_snapshot().await
    } else {
        crate::plugin_catalog::codex_snapshot().await
    };
    state.p6_state.lock().await[if app == "claude" {
        "claudePlugins"
    } else {
        "codexPlugins"
    }] = snapshot.clone();
    Ok(Json(serde_json::json!({"snapshot":snapshot})))
}

async fn run_plugin_cli(program: &str, args: &[&str]) -> Result<(), ApiError> {
    let executable = find_path_executable(program).ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "CLI_NOT_FOUND",
            format!("{program} is not installed or not on PATH"),
        )
    })?;
    let extension = executable
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let output =
        if cfg!(windows) && matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat") {
            tokio::process::Command::new("cmd.exe")
                .args(["/D", "/S", "/C"])
                .arg(executable)
                .args(args)
                .output()
                .await
        } else if cfg!(windows) && extension.eq_ignore_ascii_case("ps1") {
            tokio::process::Command::new("powershell.exe")
                .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
                .arg(executable)
                .args(args)
                .output()
                .await
        } else {
            tokio::process::Command::new(executable)
                .args(args)
                .output()
                .await
        }
        .map_err(ApiError::from)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Err(ApiError::new(
        StatusCode::BAD_GATEWAY,
        "PLUGIN_CLI_FAILED",
        if stderr.is_empty() { stdout } else { stderr },
    ))
}

fn find_path_executable(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.components().count() > 1 && path.is_file() {
        return Some(path.to_owned());
    }
    let path_env = std::env::var_os("PATH")?;
    #[cfg(windows)]
    let extensions = ["", ".exe", ".cmd", ".bat", ".ps1"];
    #[cfg(not(windows))]
    let extensions = [""];
    for directory in std::env::split_paths(&path_env) {
        for extension in extensions {
            let candidate = directory.join(format!("{program}{extension}"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
    }
    None
}

async fn template_capabilities() -> Json<Value> {
    Json(
        serde_json::json!({"developerMode": std::env::var("OSHEEP_DEVELOPER_MODE").ok().as_deref() == Some("1")}),
    )
}

async fn templates(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    Ok(Json(list_templates(&state).await?))
}

async fn template_marketspace(State(state): State<AppState>) -> Result<Json<Value>, ApiError> {
    let local = list_templates(&state).await?;
    let entries = local["system"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|template| {
            serde_json::json!({
                "id": template["id"],
                "name": template["title"],
                "description": template["description"],
                "source": {"type": "github", "repo": "local/osheep-templates"},
                "version": template.get("version").and_then(Value::as_str).unwrap_or("local")
            })
        })
        .collect::<Vec<_>>();
    Ok(Json(
        serde_json::json!({"version": "local", "templates": entries}),
    ))
}

async fn template_get(
    State(state): State<AppState>,
    AxumPath((source, tid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    Ok(Json(read_template(&state, &source, &tid).await?))
}

async fn template_icon(
    State(state): State<AppState>,
    AxumPath((source, tid)): AxumPath<(String, String)>,
) -> Result<Response, ApiError> {
    let template = read_template(&state, &source, &tid).await?;
    let file = template
        .get("iconFile")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::not_found("template icon not found"))?;
    let path = template_dir(&state, &source, &tid)?.join(file);
    let data = tokio::fs::read(&path)
        .await
        .map_err(|_| ApiError::not_found("template icon not found"))?;
    Ok((
        [(
            header::CONTENT_TYPE,
            mime_guess::from_path(path).first_or_octet_stream().as_ref(),
        )],
        data,
    )
        .into_response())
}

async fn workflow_usage() -> Json<Value> {
    Json(empty_workflow_usage(0))
}

async fn workflows(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let directory = root.join(".osheep/workflows");
    let mut items = Vec::new();
    let mut entries = match tokio::fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Json(serde_json::json!({"workflows": []})))
        }
        Err(error) => return Err(error.into()),
    };
    while let Some(entry) = entries.next_entry().await? {
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Ok(value) = read_json(&path).await {
            if valid_workflow_id(value.get("id").and_then(Value::as_str).unwrap_or("")) {
                items.push(workflow_summary(&value));
            }
        }
    }
    items.sort_by(|left, right| right["updatedAt"].as_u64().cmp(&left["updatedAt"].as_u64()));
    Ok(Json(serde_json::json!({"workflows": items})))
}

async fn workflow_create(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let now = now_ms();
    let workflow_id = format!("wf_{}", uuid::Uuid::new_v4().simple());
    let mut record = body;
    record["id"] = Value::String(workflow_id.clone());
    record["title"] = Value::String(
        record
            .get("title")
            .and_then(Value::as_str)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or("Untitled")
            .to_owned(),
    );
    record["readme"] = Value::String(
        record
            .get("readme")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    );
    record["createdAt"] = Value::from(now);
    record["updatedAt"] = Value::from(now);
    if !record["nodes"].is_array() {
        record["nodes"] = default_workflow_nodes();
    }
    if !record["edges"].is_array() {
        record["edges"] = Value::Array(vec![]);
    }
    if !record["runs"].is_array() {
        record["runs"] = Value::Array(vec![]);
    }
    write_workflow(&root, &workflow_id, &record).await?;
    Ok(Json(record))
}

async fn workflow_get(
    State(state): State<AppState>,
    AxumPath((id, wid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    Ok(Json(read_workflow(&root, &wid).await?))
}

async fn workflow_save(
    State(state): State<AppState>,
    AxumPath((id, wid)): AxumPath<(String, String)>,
    Json(mut body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let mut current = read_workflow(&root, &wid).await?;
    if body.get("nodes").is_none() && body.get("title").is_some() {
        current["title"] = body["title"].clone();
        body = current.clone();
    }
    if body
        .get("id")
        .and_then(Value::as_str)
        .is_some_and(|value| value != wid)
    {
        return Err(ApiError::invalid_path("workflow id does not match URL"));
    }
    body["id"] = Value::String(wid.clone());
    body["createdAt"] = current
        .get("createdAt")
        .cloned()
        .unwrap_or_else(|| Value::from(now_ms()));
    body["updatedAt"] = Value::from(now_ms());
    write_workflow(&root, &wid, &body).await?;
    Ok(Json(body))
}

async fn workflow_run(
    State(state): State<AppState>,
    AxumPath((id, wid)): AxumPath<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let path = workflow_path(&root, &wid)?;
    let _ = read_workflow(&root, &wid).await?;
    let requested = body.get("nodeIds").and_then(Value::as_array).map(|items| {
        items
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect::<Vec<_>>()
    });
    let key = workflow_runtime_key(&root, &wid);
    let (run_id, workflow) = state
        .workflow_runtime
        .start(key, path, root, requested)
        .await
        .map_err(workflow_runtime_error)?;
    Ok(Json(
        serde_json::json!({"runId":run_id,"workflow":workflow}),
    ))
}

async fn delete_workflow(
    State(state): State<AppState>,
    AxumPath((id, wid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let path = workflow_path(&root, &wid)?;
    tokio::fs::remove_file(path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found(format!("workflow not found: {wid}"))
        } else {
            error.into()
        }
    })?;
    Ok(Json(serde_json::json!({"ok": true})))
}

async fn workflow_pause(
    State(state): State<AppState>,
    AxumPath((id, wid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let _ = read_workflow(&root, &wid).await?;
    state
        .workflow_runtime
        .stop(&workflow_runtime_key(&root, &wid))
        .await;
    Ok(Json(serde_json::json!({"ok": true, "paused": true})))
}

async fn workflow_stop(
    State(state): State<AppState>,
    AxumPath((id, wid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let _ = read_workflow(&root, &wid).await?;
    state
        .workflow_runtime
        .stop(&workflow_runtime_key(&root, &wid))
        .await;
    Ok(Json(serde_json::json!({"ok": true, "stopped": true})))
}

async fn template_marketspace_install(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, ApiError> {
    read_template(&state, "system", &id).await.map(Json)
}

fn developer_mode() -> bool {
    std::env::var("OSHEEP_DEVELOPER_MODE").ok().as_deref() == Some("1")
}

fn require_template_source(source: &str) -> Result<(), ApiError> {
    if !matches!(source, "system" | "user") {
        return Err(ApiError::invalid_path("template source is invalid"));
    }
    if source == "system" && !developer_mode() {
        return Err(ApiError::invalid_path(
            "system templates can only be edited in developer mode",
        ));
    }
    Ok(())
}

async fn save_workflow_template(
    state: &AppState,
    workspace_id: &str,
    workflow_id: &str,
    source: &str,
) -> Result<Json<Value>, ApiError> {
    require_template_source(source)?;
    let root = resolve_workspace_path(state, workspace_id).await?;
    let workflow = read_workflow(&root, workflow_id).await?;
    let now = now_ms();
    let template_id = format!("tpl_{}", uuid::Uuid::new_v4().simple());
    let record = serde_json::json!({
        "id": template_id,
        "source": source,
        "title": workflow.get("title").and_then(Value::as_str).unwrap_or("Workflow template"),
        "description": if source == "system" { "Built-in workflow template" } else { "Custom workflow template" },
        "readme": workflow.get("readme").and_then(Value::as_str).unwrap_or(""),
        "createdAt": now,
        "updatedAt": now,
        "nodes": workflow.get("nodes").cloned().unwrap_or_else(|| Value::Array(vec![])),
        "edges": workflow.get("edges").cloned().unwrap_or_else(|| Value::Array(vec![]))
    });
    write_json_atomic(
        template_dir(state, source, &template_id)?.join("template.json"),
        &record,
    )
    .await?;
    Ok(Json(read_template(state, source, &template_id).await?))
}

async fn save_workflow_as_template(
    State(state): State<AppState>,
    AxumPath((workspace_id, workflow_id)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    save_workflow_template(&state, &workspace_id, &workflow_id, "user").await
}

async fn save_workflow_as_system_template(
    State(state): State<AppState>,
    AxumPath((workspace_id, workflow_id)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    save_workflow_template(&state, &workspace_id, &workflow_id, "system").await
}

async fn edit_template_workflow(
    State(state): State<AppState>,
    AxumPath((workspace_id, source, template_id)): AxumPath<(String, String, String)>,
) -> Result<Json<Value>, ApiError> {
    require_template_source(&source)?;
    let root = resolve_workspace_path(&state, &workspace_id).await?;
    let template = read_template(&state, &source, &template_id).await?;
    let directory = root.join(".osheep/workflows");
    let mut entries = tokio::fs::read_dir(&directory).await.ok();
    while let Some(entries) = entries.as_mut() {
        let Some(entry) = entries.next_entry().await? else {
            break;
        };
        if let Ok(existing) = read_json(&entry.path()).await {
            if existing["templateBinding"]["source"].as_str() == Some(source.as_str())
                && existing["templateBinding"]["id"].as_str() == Some(template_id.as_str())
            {
                let id = existing["id"].as_str().unwrap_or_default().to_owned();
                if valid_workflow_id(&id) {
                    let mut updated = existing;
                    updated["title"] = template["title"].clone();
                    updated["readme"] = template["readme"].clone();
                    updated["nodes"] = template["nodes"].clone();
                    updated["edges"] = template["edges"].clone();
                    updated["runs"] = Value::Array(vec![]);
                    updated["updatedAt"] = Value::from(now_ms());
                    write_workflow(&root, &id, &updated).await?;
                    return Ok(Json(updated));
                }
            }
        }
    }
    let workflow_id = format!("wf_{}", uuid::Uuid::new_v4().simple());
    let now = now_ms();
    let record = serde_json::json!({
        "id": workflow_id,
        "title": template["title"],
        "readme": template["readme"],
        "templateBinding": {"source": source, "id": template_id},
        "nodes": template["nodes"],
        "edges": template["edges"],
        "runs": [],
        "createdAt": now,
        "updatedAt": now
    });
    let id = record["id"].as_str().expect("created workflow id");
    write_workflow(&root, id, &record).await?;
    Ok(Json(record))
}

async fn delete_template(
    State(state): State<AppState>,
    AxumPath((source, tid)): AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    require_template_source(&source)?;
    let path = template_dir(&state, &source, &tid)?;
    tokio::fs::remove_dir_all(&path).await.map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            ApiError::not_found("template not found")
        } else {
            error.into()
        }
    })?;
    Ok(Json(serde_json::json!({"ok": true})))
}

async fn update_template_icon(
    State(state): State<AppState>,
    AxumPath((source, tid)): AxumPath<(String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    require_template_source(&source)?;
    let mut template = read_template(&state, &source, &tid).await?;
    let icon = body
        .get("icon")
        .and_then(Value::as_str)
        .ok_or_else(|| ApiError::invalid_path("icon is required"))?;
    let (header_value, content) = icon
        .split_once(',')
        .ok_or_else(|| ApiError::invalid_path("icon must be a data URL"))?;
    let mime = header_value
        .strip_prefix("data:")
        .and_then(|value| value.strip_suffix(";base64"))
        .ok_or_else(|| ApiError::invalid_path("icon must be a base64 data URL"))?;
    let bytes = decode_base64(content)?;
    if bytes.len() > 2 * 1024 * 1024 {
        return Err(ApiError::invalid_path("icon is too large"));
    }
    let ext = match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/svg+xml" => "svg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        _ => return Err(ApiError::invalid_path("unsupported icon type")),
    };
    let file = format!("icon.{ext}");
    let directory = template_dir(&state, &source, &tid)?;
    tokio::fs::write(directory.join(&file), bytes).await?;
    template["iconFile"] = Value::String(file);
    template["updatedAt"] = Value::from(now_ms());
    write_json_atomic(directory.join("template.json"), &template).await?;
    Ok(Json(read_template(&state, &source, &tid).await?))
}

fn empty_workflow_usage(project_count: u64) -> Value {
    serde_json::json!({"generatedAt": now_ms(), "range": "30d", "projectCount": project_count,
        "totals": {"runs":0,"inputTokens":0,"outputTokens":0,"cacheReadTokens":0,"cacheWriteTokens":0,"totalTokens":0,"cost":0},
        "daily": [], "workflows": [], "models": [], "recentRuns": []})
}

fn valid_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn valid_workflow_id(value: &str) -> bool {
    value.starts_with("wf_")
        && value.len() >= 11
        && value.len() <= 40
        && value[3..]
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit())
}

fn workflow_path(root: &Path, id: &str) -> Result<PathBuf, ApiError> {
    if !valid_workflow_id(id) {
        return Err(ApiError::invalid_path("workflow id is invalid"));
    }
    Ok(root.join(".osheep/workflows").join(format!("{id}.json")))
}

async fn read_json(path: &Path) -> Result<Value, ApiError> {
    let content = tokio::fs::read(path).await?;
    serde_json::from_slice(&content).map_err(|_| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "IO_ERROR",
            "JSON file parse failed",
        )
    })
}

async fn write_json_atomic(path: PathBuf, value: &Value) -> Result<(), ApiError> {
    let parent = path
        .parent()
        .ok_or_else(|| ApiError::invalid_path("file has no parent directory"))?
        .to_path_buf();
    tokio::fs::create_dir_all(&parent).await?;
    let temporary = parent.join(format!(
        ".osheep-write-{}.tmp",
        uuid::Uuid::new_v4().simple()
    ));
    let mut data = serde_json::to_vec_pretty(value).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "IO_ERROR",
            error.to_string(),
        )
    })?;
    data.push(b'\n');
    tokio::fs::write(&temporary, data).await?;
    match tokio::fs::rename(&temporary, &path).await {
        Ok(()) => Ok(()),
        Err(_) => {
            tokio::fs::copy(&temporary, &path).await?;
            let _ = tokio::fs::remove_file(&temporary).await;
            Ok(())
        }
    }
}

async fn read_workflow(root: &Path, id: &str) -> Result<Value, ApiError> {
    let path = workflow_path(root, id)?;
    read_json(&path).await.map_err(|error| {
        if path.exists() {
            error
        } else {
            ApiError::not_found(format!("workflow not found: {id}"))
        }
    })
}

async fn write_workflow(root: &Path, id: &str, record: &Value) -> Result<(), ApiError> {
    write_json_atomic(workflow_path(root, id)?, record).await
}

fn workflow_summary(record: &Value) -> Value {
    let runs = record.get("runs").and_then(Value::as_array);
    serde_json::json!({
        "id": record.get("id").and_then(Value::as_str).unwrap_or_default(),
        "title": record.get("title").and_then(Value::as_str).unwrap_or("Untitled"),
        "createdAt": record.get("createdAt").and_then(Value::as_u64).unwrap_or(0),
        "updatedAt": record.get("updatedAt").and_then(Value::as_u64).unwrap_or(0),
        "nodeCount": record.get("nodes").and_then(Value::as_array).map_or(0, Vec::len),
        "edgeCount": record.get("edges").and_then(Value::as_array).map_or(0, Vec::len),
        "status": runs.and_then(|items| items.last()).and_then(|item| item.get("status")).and_then(Value::as_str).unwrap_or("idle")
    })
}

fn default_workflow_nodes() -> Value {
    serde_json::json!([
        {"id": format!("node_{}", uuid::Uuid::new_v4().simple().to_string()[..8].to_string()), "kind":"trigger", "title":"Start", "providerKind":"claude-cli", "model":"", "prompt":"", "x":80, "y":120, "status":"idle"},
        {"id": format!("node_{}", uuid::Uuid::new_v4().simple().to_string()[..8].to_string()), "kind":"agent", "title":"Agent", "providerKind":"claude-cli", "model":"", "prompt":"", "x":360, "y":120, "status":"idle"}
    ])
}

fn template_dir(state: &AppState, source: &str, id: &str) -> Result<PathBuf, ApiError> {
    if !matches!(source, "system" | "user") || !valid_name(id) {
        return Err(ApiError::invalid_path("template id is invalid"));
    }
    Ok(state.store.templates_root().join(source).join(id))
}

async fn read_template(state: &AppState, source: &str, id: &str) -> Result<Value, ApiError> {
    let path = template_dir(state, source, id)?.join("template.json");
    let mut value = read_json(&path).await.map_err(|error| {
        if path.exists() {
            error
        } else {
            ApiError::not_found(format!("template not found: {id}"))
        }
    })?;
    if !value.is_object() {
        return Err(ApiError::invalid_path("template is invalid"));
    }
    value["id"] = Value::String(id.to_owned());
    value["source"] = Value::String(source.to_owned());
    value["title"] = Value::String(
        value
            .get("title")
            .and_then(Value::as_str)
            .unwrap_or(id)
            .to_owned(),
    );
    value["description"] = Value::String(
        value
            .get("description")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    );
    value["readme"] = Value::String(
        value
            .get("readme")
            .and_then(Value::as_str)
            .unwrap_or("")
            .to_owned(),
    );
    value["createdAt"] = Value::from(value.get("createdAt").and_then(Value::as_u64).unwrap_or(0));
    value["updatedAt"] = Value::from(value.get("updatedAt").and_then(Value::as_u64).unwrap_or(0));
    if !value["nodes"].is_array() {
        value["nodes"] = Value::Array(vec![]);
    }
    if !value["edges"].is_array() {
        value["edges"] = Value::Array(vec![]);
    }
    if let Some(icon) = value
        .get("iconFile")
        .and_then(Value::as_str)
        .map(str::to_owned)
    {
        value["icon"] = Value::String(format!(
            "/api/templates/{source}/{id}/icon?v={}",
            value["updatedAt"]
        ));
        value["iconFile"] = Value::String(icon);
    }
    Ok(value)
}

fn public_template(value: Value) -> Value {
    serde_json::json!({
        "id": value["id"], "source": value["source"], "title": value["title"],
        "description": value["description"], "version": value.get("version").cloned(),
        "icon": value.get("icon").cloned(), "updatedAt": value["updatedAt"],
        "nodeCount": value.get("nodes").and_then(Value::as_array).map_or(0, Vec::len)
    })
}

async fn list_templates(state: &AppState) -> Result<Value, ApiError> {
    let mut system = Vec::new();
    let mut user = Vec::new();
    for (source, destination) in [("system", &mut system), ("user", &mut user)] {
        let root = state.store.templates_root().join(source);
        let mut entries = match tokio::fs::read_dir(&root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let id = entry.file_name().to_string_lossy().into_owned();
            if !entry.file_type().await?.is_dir() || !valid_name(&id) {
                continue;
            }
            if let Ok(template) = read_template(state, source, &id).await {
                destination.push(public_template(template));
            }
        }
        destination.sort_by(|left, right| left["title"].as_str().cmp(&right["title"].as_str()));
    }
    Ok(serde_json::json!({"system": system, "user": user,
        "developerMode": std::env::var("OSHEEP_DEVELOPER_MODE").ok().as_deref() == Some("1")}))
}

fn user_home() -> PathBuf {
    std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("."))
}

fn skill_live_roots(agent: &str) -> Vec<PathBuf> {
    let home = user_home();
    let shared = std::env::var_os("OSHEEP_AGENTS_SKILLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".agents/skills"));
    let app_root = match agent {
        "claude" => std::env::var_os("CLAUDE_CONFIG_DIR")
            .or_else(|| std::env::var_os("OSHEEP_CLAUDE_CONFIG_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude")),
        _ => std::env::var_os("CODEX_HOME")
            .or_else(|| std::env::var_os("OSHEEP_CODEX_CONFIG_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex")),
    };
    vec![app_root.join("skills"), shared]
}

async fn copy_directory_if_missing(source: &Path, destination: &Path) -> Result<(), ApiError> {
    if tokio::fs::try_exists(destination.join("SKILL.md"))
        .await
        .unwrap_or(false)
    {
        return Ok(());
    }
    tokio::fs::create_dir_all(destination).await?;
    let mut entries = tokio::fs::read_dir(source).await?;
    while let Some(entry) = entries.next_entry().await? {
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        if entry.file_type().await?.is_dir() {
            Box::pin(copy_directory_if_missing(&source_path, &destination_path)).await?;
        } else {
            tokio::fs::copy(source_path, destination_path).await?;
        }
    }
    Ok(())
}

async fn skill_description(directory: &Path) -> Option<String> {
    let content = tokio::fs::read_to_string(directory.join("SKILL.md"))
        .await
        .ok()?;
    content
        .lines()
        .find_map(|line| {
            line.strip_prefix("description:")
                .map(|value| value.trim().trim_matches(['\"', '\'']).to_owned())
        })
        .filter(|value| !value.is_empty())
}

async fn skills_snapshot(state: &AppState) -> Result<Value, ApiError> {
    let built_in_root = state
        .store
        .root()
        .parent()
        .unwrap_or_else(|| Path::new("."))
        .join("template-library/user-skills");
    for agent in ["claude", "codex"] {
        let staging = state.store.root().join("skills").join(agent);
        let mut entries = match tokio::fs::read_dir(&built_in_root).await {
            Ok(entries) => entries,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.into()),
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().await?.is_dir()
                && valid_name(&name)
                && tokio::fs::try_exists(entry.path().join("SKILL.md"))
                    .await
                    .unwrap_or(false)
            {
                let live = skill_live_roots(agent)
                    .into_iter()
                    .any(|root| root.join(&name).join("SKILL.md").exists());
                if !live {
                    copy_directory_if_missing(&entry.path(), &staging.join(name)).await?;
                }
            }
        }
    }
    let mut enabled_by_path = std::collections::BTreeMap::<PathBuf, Value>::new();
    let mut user = Vec::new();
    for agent in ["claude", "codex"] {
        let roots = skill_live_roots(agent);
        for root in &roots {
            let mut entries = match tokio::fs::read_dir(root).await {
                Ok(entries) => entries,
                Err(_) => continue,
            };
            while let Some(entry) = entries.next_entry().await? {
                let name = entry.file_name().to_string_lossy().into_owned();
                if entry.file_type().await?.is_dir()
                    && valid_name(&name)
                    && tokio::fs::try_exists(entry.path().join("SKILL.md"))
                        .await
                        .unwrap_or(false)
                {
                    let path = entry.path();
                    if let Some(existing) = enabled_by_path.get_mut(&path) {
                        if let Some(agents) = existing["agents"].as_array_mut() {
                            agents.push(Value::String(agent.to_owned()));
                        }
                    } else {
                        enabled_by_path.insert(path.clone(), serde_json::json!({"name":name,"description":skill_description(&path).await,"path":path,"agents":[agent],"source":"local","builtIn":tokio::fs::try_exists(entry.path().join(".osheep-built-in")).await.unwrap_or(false)}));
                    }
                }
            }
        }
        let staging = state.store.root().join("skills").join(agent);
        let mut entries = match tokio::fs::read_dir(&staging).await {
            Ok(entries) => entries,
            Err(_) => continue,
        };
        while let Some(entry) = entries.next_entry().await? {
            let name = entry.file_name().to_string_lossy().into_owned();
            if entry.file_type().await?.is_dir()
                && valid_name(&name)
                && tokio::fs::try_exists(entry.path().join("SKILL.md"))
                    .await
                    .unwrap_or(false)
            {
                user.push(serde_json::json!({"name":name,"description":skill_description(&entry.path()).await,"path":entry.path(),"agent":agent,"origin":"manual","builtIn":tokio::fs::try_exists(entry.path().join(".osheep-built-in")).await.unwrap_or(false)}));
            }
        }
    }
    let mut enabled = enabled_by_path.into_values().collect::<Vec<_>>();
    enabled.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    user.sort_by(|left, right| left["name"].as_str().cmp(&right["name"].as_str()));
    Ok(
        serde_json::json!({"enabled":enabled,"user":user,"paths":{"claude":skill_live_roots("claude"),"codex":skill_live_roots("codex")}}),
    )
}

async fn workflow_events(
    State(state): State<AppState>,
    ws: WebSocketUpgrade,
    AxumPath((id, wid)): AxumPath<(String, String)>,
) -> Result<Response, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let _ = read_workflow(&root, &wid).await?;
    let mut events = state
        .workflow_runtime
        .subscribe(&workflow_runtime_key(&root, &wid))
        .await;
    Ok(ws.on_upgrade(move |socket| async move {
        let (mut sender, mut receiver) = socket.split();
        if sender
            .send(Message::Text(
                serde_json::json!({"type":"ready","workflowId":wid,"updatedAt":now_ms()})
                    .to_string()
                    .into(),
            ))
            .await
            .is_err()
        {
            return;
        }
        let mut heartbeat = tokio::time::interval(Duration::from_secs(20));
        loop {
            tokio::select! {
                event = events.recv() => match event {
                    Ok(event) => {
                        if sender.send(Message::Text(event.to_string().into())).await.is_err() { break; }
                    }
                    Err(broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(broadcast::error::RecvError::Closed) => break,
                },
                message = receiver.next() => match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(bytes))) => {
                        if sender.send(Message::Pong(bytes)).await.is_err() { break; }
                    }
                    _ => {}
                },
                _ = heartbeat.tick() => {
                    if sender.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
            }
        }
    }))
}

async fn resolve_workflow_approval(
    State(state): State<AppState>,
    AxumPath((id, wid, node_id)): AxumPath<(String, String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let _ = read_workflow(&root, &wid).await?;
    let approved = body
        .get("approved")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    state
        .workflow_runtime
        .resolve(
            &workflow_runtime_key(&root, &wid),
            &node_id,
            Value::Bool(approved),
        )
        .await
        .map_err(workflow_runtime_error)?;
    Ok(Json(serde_json::json!({"ok":true})))
}

async fn resolve_workflow_input(
    State(state): State<AppState>,
    AxumPath((id, wid, node_id)): AxumPath<(String, String, String)>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let _ = read_workflow(&root, &wid).await?;
    let value = body
        .get("value")
        .cloned()
        .unwrap_or_else(|| Value::String(String::new()));
    state
        .workflow_runtime
        .resolve(&workflow_runtime_key(&root, &wid), &node_id, value)
        .await
        .map_err(workflow_runtime_error)?;
    Ok(Json(serde_json::json!({"ok":true})))
}

fn workflow_runtime_key(root: &Path, workflow_id: &str) -> String {
    format!("{}\0{workflow_id}", root.display())
}

fn workflow_runtime_error(error: crate::workflow_runtime::RuntimeError) -> ApiError {
    match error {
        crate::workflow_runtime::RuntimeError::AlreadyRunning => {
            ApiError::new(StatusCode::CONFLICT, "WORKFLOW_RUNNING", error.to_string())
        }
        crate::workflow_runtime::RuntimeError::NotWaiting => ApiError::new(
            StatusCode::CONFLICT,
            "WORKFLOW_NOT_WAITING",
            error.to_string(),
        ),
        _ => ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "WORKFLOW_RUNTIME_ERROR",
            error.to_string(),
        ),
    }
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
