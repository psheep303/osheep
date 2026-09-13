use crate::config::ServerConfig;
use crate::error::ApiError;
use crate::runtime::{RuntimeClientError, RuntimeControl};
use crate::security::{require_origin, require_session, Security, SecurityError};
use crate::skills_library::SkillsLibrary;
use crate::static_site;
use axum::body::Body;
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
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::process::Command;
use tokio::sync::{broadcast, Mutex};
use tower_http::cors::{AllowOrigin, CorsLayer};
use tower_http::trace::TraceLayer;

const TERMINAL_REPLAY_CHUNK_BYTES: usize = 64 * 1024;
const AI_TERMINAL_DONE_MARKER: &str = "__OSHEEP_AGENT_DONE__";

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
    ai_terminal_controls: Arc<Mutex<HashMap<String, Arc<AiTerminalControl>>>>,
    skills_library: SkillsLibrary,
    workflow_runtime: crate::workflow_runtime::WorkflowRuntime,
}

struct AiTerminalControl {
    session: Arc<dyn PtySession>,
    cancelled: AtomicBool,
    successful: AtomicBool,
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
        pty: pty.clone(),
        frontend_root: config.frontend_root,
        runtime,
        skills_library: skills_library_service,
        workflow_runtime: crate::workflow_runtime::WorkflowRuntime::new_with_pty(
            config.data_root.clone(),
            pty.clone(),
        ),
        p6_state: Arc::new(Mutex::new(serde_json::json!({
            "aiSettings": {"state": ai_settings_state, "paths": ai_settings_paths},
            "skills": {"enabled": [], "user": [], "paths": {"claude": [], "codex": []}},
            "claudePlugins": {"plugins": [], "marketplaces": [], "warnings": [], "paths": {}},
            "codexPlugins": {"plugins": [], "marketplaces": [], "warnings": [], "paths": {}},
            "workflows": {}
        }))),
        ai_terminal_controls: Arc::new(Mutex::new(HashMap::new())),
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
        .route("/api/model-prices/sync", post(sync_model_prices))
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
        .route("/api/ai/cli-tools/{name}/action", post(ai_cli_tool_action))
        .route("/api/workspaces/{id}/ai/models", post(ai_models))
        .route(
            "/api/workspaces/{id}/ai/chat/terminal",
            post(ai_chat_terminal),
        )
        .route(
            "/api/workspaces/{id}/ai/chat/terminal/{sessionId}/auto-success",
            post(ai_chat_terminal_auto_success),
        )
        .route(
            "/api/workspaces/{id}/ai/chat/terminal/{sessionId}/pause",
            post(ai_chat_terminal_pause),
        )
        .route(
            "/api/workspaces/{id}/ai/chat/terminal/{sessionId}/success",
            post(ai_chat_terminal_success),
        )
        .route("/api/workspaces/{id}/ai/chat", post(ai_chat))
        .route("/api/workspaces/{id}/ai/chat/stream", post(ai_chat_stream))
        .route("/api/workspaces/{id}/ai/exec/read", post(ai_exec_read))
        .route("/api/workspaces/{id}/ai/exec/write", post(ai_exec_write))
        .route("/api/workspaces/{id}/ai/exec/run", post(ai_exec_run))
        .route(
            "/api/workspaces/{id}/ai/exec/run/stream",
            post(ai_exec_run_stream),
        )
        .route("/api/workspaces/{id}/mcp/discover", post(mcp_discover))
        .route("/api/workspaces/{id}/mcp/call", post(mcp_call))
        .route("/api/adapters", get(adapters))
        .route("/api/adapter-events", get(adapter_events))
        .route("/api/skills", get(skills))
        .route("/api/skills/library", get(skills_library))
        .route("/api/skills/install", post(install_skill))
        .route("/api/skills/import", post(import_skill))
        .route("/api/skills/enable", post(enable_skill))
        .route("/api/skills/disable", post(disable_skill))
        .route("/api/skills/apply", post(apply_skill_selection))
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
        .route("/api/codex-plugins/local", post(codex_plugin_local_create))
        .route(
            "/api/codex-plugins/import-local",
            post(codex_plugin_local_import),
        )
        .route(
            "/api/codex-plugins/local/{name}",
            delete(codex_plugin_local_delete),
        )
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
            post(workflow_retry_now),
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
            initial_executable: None,
            initial_args: Vec::new(),
            terminal_program: None,
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
            initial_executable: None,
            initial_args: Vec::new(),
            terminal_program: None,
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

async fn sync_model_prices() -> Result<Json<Value>, ApiError> {
    // Keep the settings screen useful even when the optional LiteLLM network
    // source is unavailable. These are the same model identifiers exposed by
    // the local CLI adapters and are intentionally conservative estimates.
    let models = serde_json::json!([
        {"model":"claude-sonnet","provider":"anthropic","billingMode":"dynamic","inputCostPerMillion":3.0,"outputCostPerMillion":15.0,"source":"manual"},
        {"model":"claude-opus","provider":"anthropic","billingMode":"dynamic","inputCostPerMillion":15.0,"outputCostPerMillion":75.0,"source":"manual"},
        {"model":"gpt-5.1-codex","provider":"openai","billingMode":"dynamic","inputCostPerMillion":1.25,"outputCostPerMillion":10.0,"source":"manual"},
        {"model":"gpt-5","provider":"openai","billingMode":"dynamic","inputCostPerMillion":1.25,"outputCostPerMillion":10.0,"source":"manual"}
    ]);
    Ok(Json(
        serde_json::json!({"models":models,"source":"osheep-default","updatedAt":now_ms()}),
    ))
}

async fn ai_cli_tool_action(
    AxumPath(name): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    if name != "claude" && name != "codex" {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "CLI tool must be claude or codex",
        ));
    }
    let action = body.get("action").and_then(Value::as_str).unwrap_or("");
    if action != "install" && action != "update" {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "CLI action must be install or update",
        ));
    }
    let package = if name == "claude" {
        "@anthropic-ai/claude-code"
    } else {
        "@openai/codex"
    };
    if action == "update"
        && name == "claude"
        && find_path_executable("claude").is_some()
        && run_plugin_cli("claude", &["update"]).await.is_ok()
    {
        return Ok(Json(
            serde_json::json!({"status":{"name":name,"installed":true,"activeAction":Value::Null}}),
        ));
    }
    run_plugin_cli(
        "npm",
        &["install", "--global", &format!("{package}@latest")],
    )
    .await?;
    let executable = find_path_executable(&name);
    Ok(Json(serde_json::json!({
        "status":{"name":name,"installed":executable.is_some(),"path":executable,"activeAction":Value::Null}
    })))
}

async fn ai_chat_terminal_control(
    State(state): State<AppState>,
    AxumPath((id, session_id)): AxumPath<(String, String)>,
    action: &'static str,
) -> Result<Json<Value>, ApiError> {
    let _ = resolve_workspace_path(&state, &id).await?;
    if session_id.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "sessionId is required",
        ));
    }
    let control = state
        .ai_terminal_controls
        .lock()
        .await
        .get(&session_id)
        .cloned();
    let workflow_session = if control.is_none() {
        state.pty.get(&session_id)
    } else {
        None
    };
    if control.is_none() && workflow_session.is_none() {
        return Err(ApiError::new(
            StatusCode::NOT_FOUND,
            "SESSION_NOT_FOUND",
            "terminal session is no longer active",
        ));
    }
    if let Some(control) = control {
        match action {
            "pause" => {
                control.session.input("\u{3}".into()).await?;
            }
            "success" => {
                control.successful.store(true, Ordering::Release);
                control.cancelled.store(true, Ordering::Release);
                let _ = control.session.kill().await;
                state.ai_terminal_controls.lock().await.remove(&session_id);
            }
            "auto-success" => {}
            _ => {}
        }
    } else if let Some(session) = workflow_session {
        match action {
            "pause" => {
                session.input("\u{3}".into()).await?;
            }
            "success" => {
                let _ = session.kill().await;
            }
            "auto-success" => {}
            _ => {}
        }
    }
    Ok(Json(
        serde_json::json!({"ok":true,"sessionId":session_id,"action":action}),
    ))
}

async fn ai_chat_terminal_auto_success(
    state: State<AppState>,
    path: AxumPath<(String, String)>,
    _body: Option<Json<Value>>,
) -> Result<Json<Value>, ApiError> {
    ai_chat_terminal_control(state, path, "auto-success").await
}

async fn ai_chat_terminal_pause(
    state: State<AppState>,
    path: AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    ai_chat_terminal_control(state, path, "pause").await
}

async fn ai_chat_terminal_success(
    state: State<AppState>,
    path: AxumPath<(String, String)>,
) -> Result<Json<Value>, ApiError> {
    ai_chat_terminal_control(state, path, "success").await
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

async fn ai_models(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let _ = resolve_workspace_path(&state, &id).await?;
    let kind = body
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("claude-cli");
    let models = match kind {
        "claude-cli" => vec!["default", "sonnet", "opus"],
        "codex-cli" => vec!["default", "gpt-5.1-codex", "gpt-5.1", "gpt-5"],
        _ => {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "osheep code only supports Claude Code CLI or Codex CLI",
            ))
        }
    };
    Ok(Json(serde_json::json!({"models":models})))
}

fn ai_prompt(body: &Value) -> Result<String, ApiError> {
    let messages = body
        .get("messages")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "messages is required",
            )
        })?;
    let transcript = messages
        .iter()
        .filter_map(|message| {
            let content = message.get("content")?.as_str()?;
            let role = message
                .get("role")
                .and_then(Value::as_str)
                .unwrap_or("user");
            Some(format!("### {role}\n{content}"))
        })
        .collect::<Vec<_>>()
        .join("\n\n");
    if transcript.trim().is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "messages must contain content",
        ));
    }
    Ok(format!(
        "You are being invoked by osheep. The current working directory is the project root. Reply in the user's language.\n\n{transcript}\n"
    ))
}

async fn run_ai_request(state: &AppState, id: &str, body: &Value) -> Result<Value, ApiError> {
    run_ai_request_with_cancel(state, id, body, Arc::new(AtomicBool::new(false))).await
}

async fn run_ai_request_with_cancel(
    state: &AppState,
    id: &str,
    body: &Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, ApiError> {
    let workspace = resolve_workspace_path(state, id).await?;
    let kind = body
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("claude-cli");
    if !matches!(kind, "claude-cli" | "codex-cli") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "osheep code only supports Claude Code CLI or Codex CLI",
        ));
    }
    let prompt = body
        .get("terminalPrompt")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or(ai_prompt(body)?);
    crate::workflow_runtime::run_cli_chat_with_cancel(
        &workspace,
        kind,
        body.get("model")
            .and_then(Value::as_str)
            .unwrap_or("default"),
        &prompt,
        cancelled,
    )
    .await
    .map_err(|message| ApiError::new(StatusCode::BAD_GATEWAY, "UPSTREAM_FAILED", message))
}

async fn ai_chat(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let result = run_ai_request(&state, &id, &body).await?;
    Ok(Json(serde_json::json!({
        "content":result["text"].as_str().unwrap_or(""),
        "raw":{"stderr":result["stderr"],"exitCode":result["exitCode"],"signal":Value::Null}
    })))
}

fn sse_response(events: &[(&str, Value)]) -> Result<Response, ApiError> {
    let mut content = String::new();
    for (event, data) in events {
        content.push_str("event: ");
        content.push_str(event);
        content.push_str("\ndata: ");
        content.push_str(&serde_json::to_string(data).map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                error.to_string(),
            )
        })?);
        content.push_str("\n\n");
    }
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .body(Body::from(content))
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                error.to_string(),
            )
        })
}

async fn ai_chat_stream(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let result = run_ai_request(&state, &id, &body).await?;
    sse_response(&[
        ("delta", serde_json::json!({"content":result["text"]})),
        ("done", serde_json::json!({})),
    ])
}

async fn ai_chat_terminal(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let workspace = resolve_workspace_path(&state, &id).await?;
    let kind = body
        .get("kind")
        .and_then(Value::as_str)
        .unwrap_or("claude-cli");
    if !matches!(kind, "claude-cli" | "codex-cli") {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "osheep code only supports Claude Code CLI or Codex CLI",
        ));
    }
    let profile = state.pty.profiles().into_iter().next().ok_or_else(|| {
        ApiError::new(
            StatusCode::SERVICE_UNAVAILABLE,
            "PTY_UNAVAILABLE",
            "服务器未探测到可用 shell",
        )
    })?;
    let command = build_agent_terminal_command(kind, &body)?;
    let workspaces_root = state.workspaces.canonical_root().await?;
    let session = state
        .pty
        .spawn(SpawnRequest {
            workspace_id: format!("ai-{id}"),
            cwd: workspace,
            workspaces_root,
            shell: profile.id,
            cols: 120,
            rows: 34,
            kill_on_detach: false,
            initial_executable: None,
            initial_args: Vec::new(),
            terminal_program: None,
        })
        .await?;
    let session_id = session.summary().id.clone();
    let control = Arc::new(AiTerminalControl {
        session: session.clone(),
        cancelled: AtomicBool::new(false),
        successful: AtomicBool::new(false),
    });
    state
        .ai_terminal_controls
        .lock()
        .await
        .insert(session_id.clone(), control.clone());
    let (sender, receiver) =
        tokio::sync::mpsc::channel::<Result<String, std::convert::Infallible>>(64);
    sender
        .send(Ok(sse_event(
            "session",
            &serde_json::json!({"sessionId":session_id}),
        )))
        .await
        .ok();
    sender
        .send(Ok(sse_event(
            "status",
            &serde_json::json!({"status":"prompt-sent"}),
        )))
        .await
        .ok();
    if let Some(conversation_id) = body
        .get("conversationSessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
    {
        sender
            .send(Ok(sse_event(
                "conversation",
                &serde_json::json!({"sessionId":conversation_id}),
            )))
            .await
            .ok();
    }
    let input = format!("{command}\r");
    session.input(input).await?;
    let state_controls = state.ai_terminal_controls.clone();
    let task_session_id = session_id.clone();
    tokio::spawn(async move {
        let (replay, mut events) = session.attach();
        let mut transcript = replay.data;
        loop {
            match events.recv().await {
                Ok(PtyEvent::Output(data)) => {
                    transcript.push_str(&data);
                    if sender
                        .send(Ok(sse_event(
                            "log",
                            &serde_json::json!({"stream":"stdout","content":data}),
                        )))
                        .await
                        .is_err()
                    {
                        let _ = session.kill().await;
                        break;
                    }
                    if transcript.contains(AI_TERMINAL_DONE_MARKER) {
                        transcript = transcript.replace(AI_TERMINAL_DONE_MARKER, "");
                        let result = serde_json::json!({
                            "sessionId":task_session_id,"content":"",
                            "transcript":transcript,"changedFiles":[],"verification":[],
                            "exitCode":0,"signal":Value::Null,"outcome":"success"
                        });
                        let _ = sender.send(Ok(sse_event("result", &result))).await;
                        let _ = sender
                            .send(Ok(sse_event("done", &serde_json::json!({}))))
                            .await;
                        let _ = session.kill().await;
                        break;
                    }
                }
                Ok(PtyEvent::Exit { code, .. }) => {
                    let outcome = if control.successful.load(Ordering::Acquire) {
                        "success"
                    } else if control.cancelled.load(Ordering::Acquire) {
                        "cancelled"
                    } else {
                        "success"
                    };
                    let result = serde_json::json!({
                        // The frontend cleans the PTY transcript according to
                        // the selected CLI. Returning it as `content` would
                        // bypass that parser and persist shell chrome as the
                        // block answer.
                        "sessionId":task_session_id,"content":"",
                        "transcript":transcript,"changedFiles":[],"verification":[],
                        "exitCode":code,"signal":Value::Null,"outcome":outcome
                    });
                    let _ = sender.send(Ok(sse_event("result", &result))).await;
                    let _ = sender
                        .send(Ok(sse_event("done", &serde_json::json!({}))))
                        .await;
                    break;
                }
                Ok(PtyEvent::Error(message)) => {
                    let _ = sender
                        .send(Ok(sse_event(
                            "error",
                            &serde_json::json!({"message":message}),
                        )))
                        .await;
                    let _ = sender
                        .send(Ok(sse_event("done", &serde_json::json!({}))))
                        .await;
                    break;
                }
                Err(_) => break,
            }
        }
        state_controls.lock().await.remove(&task_session_id);
    });
    let stream = futures_util::stream::unfold(receiver, |mut receiver| async move {
        receiver.recv().await.map(|item| (item, receiver))
    });
    Response::builder()
        .status(StatusCode::OK)
        .header(header::CONTENT_TYPE, "text/event-stream; charset=utf-8")
        .header(header::CACHE_CONTROL, "no-cache, no-transform")
        .body(Body::from_stream(stream))
        .map_err(|error| {
            ApiError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "INTERNAL",
                error.to_string(),
            )
        })
}

fn sse_event(event: &str, data: &Value) -> String {
    format!("event: {event}\ndata: {}\n\n", data)
}

fn build_agent_terminal_command(kind: &str, body: &Value) -> Result<String, ApiError> {
    let prompt = body
        .get("terminalPrompt")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_QUERY",
                "prompt is required",
            )
        })?;
    let quote = |value: &str| {
        if cfg!(windows) {
            format!("'{}'", value.replace('\'', "''"))
        } else {
            format!("'{}'", value.replace('\'', "'\\''"))
        }
    };
    let resume = body
        .get("resumeConversation")
        .and_then(Value::as_bool)
        .unwrap_or(false);
    let conversation_id = body
        .get("conversationSessionId")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty());
    let mut args = agent_terminal_executable(kind);
    if kind == "codex-cli" {
        if resume && conversation_id.is_some() {
            args.push("resume".to_owned());
        }
        args.extend([
            "--ask-for-approval".to_owned(),
            body.get("codexApproval")
                .and_then(Value::as_str)
                .filter(|value| matches!(*value, "untrusted" | "on-request" | "never"))
                .unwrap_or("on-request")
                .to_owned(),
            "--sandbox".to_owned(),
            body.get("codexSandbox")
                .and_then(Value::as_str)
                .unwrap_or("workspace-write")
                .to_owned(),
        ]);
        if body.get("mode").and_then(Value::as_str) == Some("goal") {
            args.extend(["--enable".to_owned(), "goals".to_owned()]);
        }
    } else {
        let permission = if body.get("mode").and_then(Value::as_str) == Some("plan") {
            "plan"
        } else {
            match body.get("claudePermissionMode").and_then(Value::as_str) {
                Some("default") | None => "manual",
                Some(value) => value,
            }
        };
        args.extend(["--permission-mode".to_owned(), permission.to_owned()]);
        if let Some(session_id) = conversation_id {
            args.extend([
                if resume { "--resume" } else { "--session-id" }.to_owned(),
                session_id.to_owned(),
            ]);
        }
    }
    if let Some(effort) = body.get("effort").and_then(Value::as_str).filter(|value| {
        if kind == "claude-cli" {
            matches!(
                *value,
                "minimal" | "low" | "medium" | "high" | "xhigh" | "max" | "ultracode"
            )
        } else {
            matches!(
                *value,
                "minimal" | "low" | "medium" | "high" | "xhigh" | "max"
            )
        }
    }) {
        let effort = if kind == "claude-cli" && effort == "minimal" {
            "low"
        } else {
            effort
        };
        if kind == "claude-cli" {
            args.extend(["--effort".to_owned(), effort.to_owned()]);
        } else {
            args.extend([
                "-c".to_owned(),
                format!("model_reasoning_effort=\"{effort}\""),
            ]);
        }
    }
    if let Some(model) = body
        .get("model")
        .and_then(Value::as_str)
        .filter(|value| *value != "default" && !value.is_empty())
    {
        args.extend(["--model".to_owned(), model.to_owned()]);
    }
    if kind == "codex-cli" && resume {
        if let Some(session_id) = conversation_id {
            args.push(session_id.to_owned());
        }
    }
    args.push(prompt.to_owned());
    let command = args
        .into_iter()
        .map(|value| quote(&value))
        .collect::<Vec<_>>()
        .join(" ");
    let invocation = if cfg!(windows) {
        format!("& {command}")
    } else {
        command
    };
    let completion = if cfg!(windows) {
        format!("Write-Output '{}'", AI_TERMINAL_DONE_MARKER)
    } else {
        format!("printf '\\n{}\\n'", AI_TERMINAL_DONE_MARKER)
    };
    Ok(format!("{invocation}; {completion}"))
}

fn agent_terminal_executable(kind: &str) -> Vec<String> {
    if kind != "codex-cli" {
        return vec!["claude".to_owned()];
    }
    if cfg!(windows) {
        if let Some(shim) = find_path_executable("codex") {
            if let Some(parent) = shim.parent() {
                let script = parent
                    .join("node_modules")
                    .join("@openai")
                    .join("codex")
                    .join("bin")
                    .join("codex.js");
                if script.is_file() {
                    let node =
                        find_path_executable("node").unwrap_or_else(|| PathBuf::from("node.exe"));
                    return vec![
                        node.to_string_lossy().into_owned(),
                        script.to_string_lossy().into_owned(),
                    ];
                }
            }
        }
    }
    vec!["codex".to_owned()]
}

fn string_list(value: Option<&Value>) -> Vec<String> {
    match value {
        Some(Value::String(value)) if !value.is_empty() => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    }
}

async fn ai_exec_read(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = resolve_workspace_path(&state, &id).await?;
    match body.get("kind").and_then(Value::as_str).unwrap_or("") {
        "file" => {
            let path = body.get("path").and_then(Value::as_str).ok_or_else(|| {
                ApiError::new(StatusCode::BAD_REQUEST, "INVALID_QUERY", "missing path")
            })?;
            let file = state.files.read_text(&workspace, path).await?;
            let lines = file.content.lines().collect::<Vec<_>>();
            let start = body
                .get("startLine")
                .and_then(Value::as_u64)
                .unwrap_or(1)
                .max(1) as usize;
            let count = body
                .get("lineCount")
                .and_then(Value::as_u64)
                .unwrap_or(lines.len() as u64) as usize;
            let content = lines
                .iter()
                .skip(start.saturating_sub(1))
                .take(count)
                .copied()
                .collect::<Vec<_>>()
                .join("\n");
            Ok(Json(serde_json::json!({
                "kind":"file","path":file.path,"content":content,"size":file.size,
                "mtime":file.mtime,"truncated":start > 1 || start.saturating_sub(1) + count < lines.len(),
                "startLine":start,"endLine":start.saturating_add(count).saturating_sub(1).min(lines.len()),
                "totalLines":lines.len()
            })))
        }
        "list" => {
            let path = body.get("path").and_then(Value::as_str).unwrap_or("");
            let entries = state
                .files
                .list_tree(
                    &workspace,
                    path,
                    body.get("includeHidden")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                    true,
                )
                .await?;
            Ok(Json(
                serde_json::json!({"kind":"list","path":path,"entries":entries}),
            ))
        }
        "search" => {
            let query = body.get("query").and_then(Value::as_str).unwrap_or("");
            if query.is_empty() {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "INVALID_QUERY",
                    "missing query",
                ));
            }
            let result = state
                .search
                .search(
                    &workspace,
                    SearchOptions {
                        query: query.to_owned(),
                        case_sensitive: false,
                        whole_word: false,
                        regex: false,
                        include: string_list(body.get("include")),
                        exclude: string_list(body.get("exclude")),
                        max_files: 5000,
                        max_matches_per_file: 100,
                    },
                )
                .await?;
            let mut value = serde_json::to_value(result).map_err(|error| {
                ApiError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "INTERNAL",
                    error.to_string(),
                )
            })?;
            value["kind"] = Value::String("search".into());
            Ok(Json(value))
        }
        _ => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "read.kind must be file, list, or search",
        )),
    }
}

async fn ai_exec_write(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = resolve_workspace_path(&state, &id).await?;
    let kind = body.get("kind").and_then(Value::as_str).unwrap_or("");
    let path = body.get("path").and_then(Value::as_str).unwrap_or("");
    match kind {
        "write_file" | "append_file" => {
            let content = body.get("content").and_then(Value::as_str).ok_or_else(|| {
                ApiError::new(StatusCode::BAD_REQUEST, "INVALID_QUERY", "missing content")
            })?;
            let content = if kind == "append_file" {
                state
                    .files
                    .read_text(&workspace, path)
                    .await
                    .map(|file| file.content)
                    .unwrap_or_default()
                    + content
            } else {
                content.to_owned()
            };
            let written = state
                .files
                .write_text(&workspace, path, content, true)
                .await?;
            Ok(Json(
                serde_json::json!({"ok":true,"kind":kind,"path":written.path,"size":written.size,"mtime":written.mtime}),
            ))
        }
        "edit_file" | "multi_edit" => {
            let file = state.files.read_text(&workspace, path).await?;
            let before = file.content;
            let edits = if kind == "edit_file" {
                vec![(
                    body.get("oldString")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                    body.get("newString")
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned(),
                )]
            } else {
                body.get("edits")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .map(|edit| {
                        (
                            edit["oldString"].as_str().unwrap_or("").to_owned(),
                            edit["newString"].as_str().unwrap_or("").to_owned(),
                        )
                    })
                    .collect()
            };
            if edits.is_empty() || edits.iter().any(|(old, _)| old.is_empty()) {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "INVALID_QUERY",
                    "edits require a non-empty oldString",
                ));
            }
            let mut after = before.clone();
            for (old, new) in &edits {
                if after.matches(old).count() != 1 {
                    return Err(ApiError::new(
                        StatusCode::BAD_REQUEST,
                        "INVALID_QUERY",
                        "oldString must occur exactly once",
                    ));
                }
                after = after.replacen(old, new, 1);
            }
            let written = state
                .files
                .write_text(&workspace, path, after.clone(), false)
                .await?;
            Ok(Json(serde_json::json!({
                "ok":true,"kind":kind,"path":written.path,"size":written.size,"mtime":written.mtime,
                "replacements":edits.len(),"diff":{"before":before,"after":after,"edits":edits}
            })))
        }
        "move" => {
            let from = body.get("from").and_then(Value::as_str).unwrap_or("");
            let to = body.get("to").and_then(Value::as_str).unwrap_or("");
            state.files.move_entry(&workspace, from, to).await?;
            Ok(Json(
                serde_json::json!({"ok":true,"kind":"move","from":from,"to":to}),
            ))
        }
        "delete" => {
            state
                .files
                .delete_entry(
                    &workspace,
                    path,
                    body.get("recursive")
                        .and_then(Value::as_bool)
                        .unwrap_or(false),
                )
                .await?;
            Ok(Json(
                serde_json::json!({"ok":true,"kind":"delete","path":path}),
            ))
        }
        "create" => {
            let entry_kind = if body.get("entryKind").and_then(Value::as_str) == Some("directory") {
                EntryKind::Directory
            } else {
                EntryKind::File
            };
            state
                .files
                .create_entry(&workspace, path, entry_kind)
                .await?;
            Ok(Json(
                serde_json::json!({"ok":true,"action":"create","path":path,"entryKind":body["entryKind"]}),
            ))
        }
        _ => Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "write.kind is invalid",
        )),
    }
}

async fn run_workspace_command(root: &Path, body: &Value) -> Result<Value, ApiError> {
    let command_line = body
        .get("command")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if command_line.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "missing command",
        ));
    }
    let relative = body.get("cwd").and_then(Value::as_str).unwrap_or("");
    let relative_path = Path::new(relative);
    if relative_path.is_absolute()
        || relative_path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err(ApiError::invalid_path("cwd must stay inside the workspace"));
    }
    let cwd = root.join(relative_path);
    let started = Instant::now();
    let mut command = if cfg!(windows) {
        let mut command = Command::new("powershell.exe");
        command.args([
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command_line,
        ]);
        command
    } else {
        let mut command = Command::new("sh");
        command.args(["-lc", command_line]);
        command
    };
    command.current_dir(&cwd).kill_on_drop(true);
    let timeout_ms = body
        .get("timeoutMs")
        .and_then(Value::as_u64)
        .unwrap_or(60_000)
        .clamp(1, 600_000);
    let output = tokio::time::timeout(Duration::from_millis(timeout_ms), command.output())
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "COMMAND_TIMEOUT",
                "command timed out",
            )
        })?
        .map_err(ApiError::from)?;
    Ok(serde_json::json!({
        "command":command_line,"cwd":relative,"shell":if cfg!(windows) {"powershell"} else {"sh"},
        "exitCode":output.status.code(),"signal":Value::Null,"durationMs":started.elapsed().as_millis() as u64,
        "stdout":String::from_utf8_lossy(&output.stdout),"stderr":String::from_utf8_lossy(&output.stderr),
        "truncated":false
    }))
}

async fn ai_exec_run(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let workspace = resolve_workspace_path(&state, &id).await?;
    Ok(Json(run_workspace_command(&workspace, &body).await?))
}

async fn ai_exec_run_stream(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Response, ApiError> {
    let workspace = resolve_workspace_path(&state, &id).await?;
    let result = run_workspace_command(&workspace, &body).await?;
    let mut events = Vec::new();
    if !result["stdout"].as_str().unwrap_or("").is_empty() {
        events.push(("log", serde_json::json!({"stream":"stdout","content":result["stdout"],"shell":result["shell"]})));
    }
    if !result["stderr"].as_str().unwrap_or("").is_empty() {
        events.push(("log", serde_json::json!({"stream":"stderr","content":result["stderr"],"shell":result["shell"]})));
    }
    events.push(("result", result));
    events.push(("done", serde_json::json!({})));
    sse_response(&events)
}

async fn mcp_request(
    state: &AppState,
    workspace_id: &str,
    body: &Value,
    method: &str,
    params: Value,
) -> Result<Value, ApiError> {
    let workspace = resolve_workspace_path(state, workspace_id).await?;
    let remote = body
        .get("postUrl")
        .or_else(|| body.get("remoteLink"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if remote.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "Remote MCP Link is required",
        ));
    }
    let headers = body
        .get("headers")
        .cloned()
        .unwrap_or_else(|| serde_json::json!({}));
    let api_key = body.get("apiKey").and_then(Value::as_str).unwrap_or("");
    let script = r#"const [url,method,params,headers,key]=process.argv.slice(1);(async()=>{const h={accept:'application/json,text/event-stream','content-type':'application/json','MCP-Protocol-Version':'2025-03-26',...JSON.parse(headers||'{}')};if(key)h.authorization=`Bearer ${key}`;const send=async(m,p,id)=>{const r=await fetch(url,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',id,method:m,params:p})});const t=await r.text();let v;try{v=JSON.parse(t)}catch{const d=t.split(/\n\n/).map(x=>x.match(/data:\s*(.*)/)?.[1]).find(Boolean);v=d?JSON.parse(d):null}if(!r.ok||!v)throw new Error(`MCP request failed (${r.status}): ${t.slice(0,500)}`);return v};const init=await send('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'osheep',version:'0.2.1'}},'init');await fetch(url,{method:'POST',headers:h,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})});const out=await send(method,JSON.parse(params||'{}'),'request');process.stdout.write(JSON.stringify({init,out}))})().catch(e=>{console.error(e.message);process.exit(1)})"#;
    let result = crate::workflow_runtime::run_program(
        &workspace,
        "node",
        &[
            "-e",
            script,
            remote,
            method,
            &params.to_string(),
            &headers.to_string(),
            api_key,
        ],
        None,
        Arc::new(std::sync::atomic::AtomicBool::new(false)),
    )
    .await
    .map_err(|message| ApiError::new(StatusCode::BAD_GATEWAY, "MCP_UPSTREAM_FAILED", message))?;
    serde_json::from_str(result["stdout"].as_str().unwrap_or("{}")).map_err(|error| {
        ApiError::new(
            StatusCode::BAD_GATEWAY,
            "MCP_UPSTREAM_FAILED",
            error.to_string(),
        )
    })
}

async fn mcp_discover(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let remote = body
        .get("remoteLink")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let post_url = body
        .get("postUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let endpoint = if post_url.is_empty() {
        remote.clone()
    } else {
        post_url
    };
    let result = mcp_request(
        &state,
        &id,
        &serde_json::json!({"remoteLink":remote,"postUrl":endpoint,"headers":body["headers"],"apiKey":body["apiKey"]}),
        "tools/list",
        serde_json::json!({}),
    )
    .await?;
    let tools = result["out"]["result"]["tools"].clone();
    Ok(Json(serde_json::json!({
        "remoteLink":remote,"postUrl":endpoint,"tools":tools,"raw":result["out"]["result"],"connectedAt":now_ms()
    })))
}

async fn mcp_call(
    State(state): State<AppState>,
    AxumPath(id): AxumPath<String>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let remote = body
        .get("remoteLink")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let endpoint = body
        .get("postUrl")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    let endpoint = if endpoint.is_empty() {
        remote.clone()
    } else {
        endpoint
    };
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim()
        .to_owned();
    if name.is_empty() {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_QUERY",
            "MCP tool name is required",
        ));
    }
    let result = mcp_request(
        &state,
        &id,
        &serde_json::json!({"remoteLink":remote,"postUrl":endpoint,"headers":body["headers"],"apiKey":body["apiKey"]}),
        "tools/call",
        serde_json::json!({"name":name,"arguments":body.get("arguments").cloned().unwrap_or_else(|| serde_json::json!({}))}),
    )
    .await?;
    let response = result["out"].clone();
    let ok = response.get("error").is_none();
    Ok(Json(serde_json::json!({
        "remoteLink":remote,"postUrl":endpoint,"ok":ok,"status":if ok {"success"} else {"failed"},
        "result":response["result"],"error":response["error"],"response":response
    })))
}

async fn adapters() -> Json<Value> {
    Json(serde_json::json!({"adapters": [
        {"id":"claude-code","name":"Claude Code","version":"1.0.0","kind":"agent",
            "capabilities":{"streaming":true,"structuredEvents":true,"session":true,"resume":true,"multiTurn":false,"approval":"manual","interruption":"hard","transport":"pty","modelSelection":true,"workingDirectory":true,"usage":true},
            "configSchema":{"fields":[
                {"key":"model","label":"Model","type":"text","defaultValue":"default"},
                {"key":"workingDirectory","label":"Working Directory","type":"text"},
                {"key":"claudePermissionMode","label":"Permission Mode","type":"select","options":["default","acceptEdits","plan","auto","dontAsk","bypassPermissions"]},
                {"key":"effort","label":"Effort","type":"select","options":["low","medium","high","xhigh","max"]}
            ]}},
        {"id":"codex","name":"Codex CLI","version":"1.0.0","kind":"agent",
            "capabilities":{"streaming":true,"structuredEvents":true,"session":true,"resume":true,"multiTurn":false,"approval":"manual","interruption":"hard","transport":"pty","modelSelection":true,"workingDirectory":true,"usage":true},
            "configSchema":{"fields":[
                {"key":"model","label":"Model","type":"text","defaultValue":"default"},
                {"key":"workingDirectory","label":"Working Directory","type":"text"},
                {"key":"codexApproval","label":"Approval","type":"select","options":["untrusted","on-request","never"]},
                {"key":"codexSandbox","label":"Sandbox","type":"select","options":["read-only","workspace-write","danger-full-access"]},
                {"key":"effort","label":"Reasoning Effort","type":"select","options":["minimal","low","medium","high","xhigh","max"]}
            ]}}
    ]}))
}

async fn adapter_events(ws: WebSocketUpgrade) -> Response {
    ws.on_upgrade(|mut socket| async move {
        if socket
            .send(Message::Text(
                serde_json::json!({"type":"ready","sessions":[],"events":[],"updatedAt": now_ms()})
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
                message = socket.recv() => match message {
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(Message::Ping(bytes))) => {
                        if socket.send(Message::Pong(bytes)).await.is_err() { break; }
                    }
                    _ => {}
                },
                _ = heartbeat.tick() => {
                    if socket.send(Message::Ping(Vec::new().into())).await.is_err() { break; }
                }
            }
        }
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

fn skill_staging_root(state: &AppState, agent: &str) -> Result<PathBuf, ApiError> {
    if !matches!(agent, "claude" | "codex") {
        return Err(ApiError::invalid_path("agent must be claude or codex"));
    }
    Ok(state.store.root().join("skills").join(agent))
}

fn validate_skill_source(source: &str) -> Result<&str, ApiError> {
    let source = source.trim();
    let supported = source.starts_with("https://")
        || source.starts_with("http://")
        || source.starts_with("git@")
        || source.starts_with("github:");
    if !supported
        || source.len() > 2048
        || source
            .chars()
            .any(|character| character.is_whitespace() || "\"'<>|&;%!^()".contains(character))
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_SKILL_SOURCE",
            "Skill source must be a URL or GitHub source",
        ));
    }
    Ok(source)
}

async fn skill_manifest(state: &AppState, agent: &str) -> Value {
    let path = skill_staging_root(state, agent)
        .expect("validated skill agent")
        .join("manifest.json");
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({}))
}

async fn write_skill_manifest(
    state: &AppState,
    agent: &str,
    manifest: &Value,
) -> Result<(), ApiError> {
    let root = skill_staging_root(state, agent)?;
    tokio::fs::create_dir_all(&root).await?;
    write_json_atomic(root.join("manifest.json"), manifest).await
}

async fn replace_skill_directory(source: &Path, destination: &Path) -> Result<(), ApiError> {
    if !tokio::fs::try_exists(source.join("SKILL.md"))
        .await
        .unwrap_or(false)
    {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_SKILL_FOLDER",
            "Selected folder must contain SKILL.md",
        ));
    }
    if tokio::fs::try_exists(destination).await.unwrap_or(false) {
        tokio::fs::remove_dir_all(destination).await?;
    }
    copy_directory_if_missing(source, destination).await
}

async fn find_produced_skill_dirs(root: &Path, depth: usize) -> Result<Vec<PathBuf>, ApiError> {
    if depth > 4 {
        return Ok(Vec::new());
    }
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut result = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        if !entry.file_type().await?.is_dir() {
            continue;
        }
        let directory = entry.path();
        let name = entry.file_name().to_string_lossy().into_owned();
        if valid_name(&name)
            && tokio::fs::try_exists(directory.join("SKILL.md"))
                .await
                .unwrap_or(false)
        {
            result.push(directory);
        } else {
            result.extend(Box::pin(find_produced_skill_dirs(&directory, depth + 1)).await?);
        }
    }
    Ok(result)
}

async fn enabled_skill_dirs(
    agent: &str,
) -> Result<std::collections::BTreeMap<String, PathBuf>, ApiError> {
    let mut result = std::collections::BTreeMap::new();
    for root in skill_live_roots(agent) {
        for directory in find_produced_skill_dirs(&root, 0).await? {
            if let Some(name) = directory.file_name().and_then(|value| value.to_str()) {
                result.insert(name.to_owned(), directory);
            }
        }
    }
    Ok(result)
}

async fn run_skill_installer(
    source: &str,
    skill: Option<&str>,
    agent: &str,
    temporary_root: &Path,
) -> Result<(), ApiError> {
    let executable = find_path_executable(if cfg!(windows) { "npx.cmd" } else { "npx" })
        .or_else(|| find_path_executable("npx"))
        .ok_or_else(|| {
            ApiError::new(
                StatusCode::CONFLICT,
                "NPX_NOT_FOUND",
                "Node.js/npx is required to manage skills",
            )
        })?;
    let mut arguments = vec!["--yes", "skills", "add", source];
    if let Some(skill) = skill {
        arguments.extend(["--skill", skill]);
    }
    arguments.extend([
        "-a",
        if agent == "claude" {
            "claude-code"
        } else {
            "codex"
        },
        "-g",
        "-y",
        "--copy",
    ]);
    let extension = executable
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mut command =
        if cfg!(windows) && matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat") {
            let mut command = tokio::process::Command::new("cmd.exe");
            command
                .args(["/D", "/S", "/C"])
                .arg(&executable)
                .args(&arguments);
            command
        } else {
            let mut command = tokio::process::Command::new(&executable);
            command.args(&arguments);
            command
        };
    if agent == "claude" {
        command.env("CLAUDE_CONFIG_DIR", temporary_root);
    } else {
        command.env("CODEX_HOME", temporary_root);
    }
    let output = tokio::time::timeout(Duration::from_secs(5 * 60), command.output())
        .await
        .map_err(|_| {
            ApiError::new(
                StatusCode::GATEWAY_TIMEOUT,
                "SKILL_COMMAND_FAILED",
                "Skill installation timed out",
            )
        })?
        .map_err(ApiError::from)?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_owned();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_owned();
    Err(ApiError::new(
        StatusCode::BAD_GATEWAY,
        "SKILL_COMMAND_FAILED",
        if stderr.is_empty() { stdout } else { stderr },
    ))
}

async fn install_skill(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    let staging = skill_staging_root(&state, agent)?;
    let source = validate_skill_source(body.get("source").and_then(Value::as_str).unwrap_or(""))?;
    let skill = body
        .get("skill")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty());
    if skill.is_some_and(|value| !valid_name(value)) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_SKILL_NAME",
            "Skill name contains unsupported characters",
        ));
    }
    let temporary = std::env::temp_dir().join(format!(
        "osheep-skill-install-{}",
        uuid::Uuid::new_v4().simple()
    ));
    tokio::fs::create_dir_all(&temporary).await?;
    let before = enabled_skill_dirs(agent).await?;
    let command_result = run_skill_installer(source, skill, agent, &temporary).await;
    let mut produced = find_produced_skill_dirs(&temporary, 0).await?;
    if produced.is_empty() {
        for (name, directory) in enabled_skill_dirs(agent).await? {
            if !before.contains_key(&name) {
                produced.push(directory);
            }
        }
    }
    if produced.is_empty() {
        let _ = tokio::fs::remove_dir_all(&temporary).await;
        command_result?;
        return Err(ApiError::new(
            StatusCode::BAD_GATEWAY,
            "SKILL_INSTALL_EMPTY",
            "The installer produced no skill to stage",
        ));
    }
    let mut manifest = skill_manifest(&state, agent).await;
    for directory in produced {
        let Some(name) = directory
            .file_name()
            .and_then(|value| value.to_str())
            .map(str::to_owned)
        else {
            continue;
        };
        replace_skill_directory(&directory, &staging.join(&name)).await?;
        manifest[&name] = serde_json::json!({
            "origin":if body.get("origin").and_then(Value::as_str) == Some("skills.sh") {"skills.sh"} else {"manual"},
            "source":source
        });
    }
    write_skill_manifest(&state, agent, &manifest).await?;
    let _ = tokio::fs::remove_dir_all(&temporary).await;
    Ok(Json(
        serde_json::json!({"snapshot":skills_snapshot(&state).await?}),
    ))
}

async fn import_skill(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    let staging = skill_staging_root(&state, agent)?;
    let temporary = std::env::temp_dir().join(format!(
        "osheep-skill-import-{}",
        uuid::Uuid::new_v4().simple()
    ));
    tokio::fs::create_dir_all(&temporary).await?;
    let (source, name) = if let Some(source_path) = body.get("sourcePath").and_then(Value::as_str) {
        let source = PathBuf::from(source_path);
        if !source.is_dir() || !source.join("SKILL.md").is_file() {
            return Err(ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_SKILL_FOLDER",
                "Selected folder must contain SKILL.md",
            ));
        }
        let name = source
            .file_name()
            .and_then(|value| value.to_str())
            .unwrap_or("")
            .to_owned();
        (source, name)
    } else {
        let files = body.get("files").and_then(Value::as_array).ok_or_else(|| {
            ApiError::new(
                StatusCode::BAD_REQUEST,
                "INVALID_SKILL_FOLDER",
                "Select a skill folder to import",
            )
        })?;
        let first_path = files
            .first()
            .and_then(|file| file.get("path"))
            .and_then(Value::as_str)
            .unwrap_or("")
            .replace('\\', "/");
        let top_name = first_path
            .split('/')
            .find(|part| !part.is_empty())
            .unwrap_or("");
        let strip_top = files.iter().all(|file| {
            file.get("path")
                .and_then(Value::as_str)
                .map(|path| path.replace('\\', "/"))
                .is_some_and(|path| path.split('/').next() == Some(top_name) && path.contains('/'))
        });
        for file in files {
            let raw_path = file.get("path").and_then(Value::as_str).unwrap_or("");
            let mut parts = raw_path
                .replace('\\', "/")
                .split('/')
                .filter(|part| !part.is_empty())
                .map(str::to_owned)
                .collect::<Vec<_>>();
            if strip_top && !parts.is_empty() {
                parts.remove(0);
            }
            if parts.is_empty() || parts.iter().any(|part| !valid_name(part)) {
                return Err(ApiError::new(
                    StatusCode::BAD_REQUEST,
                    "INVALID_SKILL_FOLDER",
                    "Selected folder contains an invalid file path",
                ));
            }
            let destination = parts
                .iter()
                .fold(temporary.clone(), |path, part| path.join(part));
            if let Some(parent) = destination.parent() {
                tokio::fs::create_dir_all(parent).await?;
            }
            let data = decode_base64(file.get("data").and_then(Value::as_str).unwrap_or(""))
                .map_err(|_| {
                    ApiError::new(
                        StatusCode::BAD_REQUEST,
                        "INVALID_SKILL_FOLDER",
                        "Selected folder contains an unreadable file",
                    )
                })?;
            tokio::fs::write(destination, data).await?;
        }
        (temporary.clone(), top_name.to_owned())
    };
    if !valid_name(&name) {
        return Err(ApiError::new(
            StatusCode::BAD_REQUEST,
            "INVALID_SKILL_NAME",
            "Skill folder name contains unsupported characters",
        ));
    }
    replace_skill_directory(&source, &staging.join(&name)).await?;
    let mut manifest = skill_manifest(&state, agent).await;
    manifest[&name] = serde_json::json!({"origin":"manual"});
    write_skill_manifest(&state, agent, &manifest).await?;
    let _ = tokio::fs::remove_dir_all(&temporary).await;
    Ok(Json(
        serde_json::json!({"snapshot":skills_snapshot(&state).await?}),
    ))
}

async fn apply_skill_selection(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let agent = body.get("agent").and_then(Value::as_str).unwrap_or("");
    let staging = skill_staging_root(&state, agent)?;
    let selected = body
        .get("names")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|name| valid_name(name))
        .map(str::to_owned)
        .collect::<std::collections::HashSet<_>>();
    let enabled = enabled_skill_dirs(agent).await?;
    let mut staged = std::collections::BTreeMap::new();
    for directory in find_produced_skill_dirs(&staging, 0).await? {
        if let Some(name) = directory.file_name().and_then(|value| value.to_str()) {
            staged.insert(name.to_owned(), directory);
        }
    }
    for (name, source) in enabled {
        if !selected.contains(&name) {
            move_skill_directory(&source, &staging.join(name)).await?;
        }
    }
    let live_root = skill_live_roots(agent)
        .into_iter()
        .next()
        .expect("agent skill root");
    for (name, source) in staged {
        if selected.contains(&name) {
            move_skill_directory(&source, &live_root.join(name)).await?;
        }
    }
    Ok(Json(
        serde_json::json!({"snapshot":skills_snapshot(&state).await?}),
    ))
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
    let mut manifest = skill_manifest(&state, agent).await;
    if let Some(entries) = manifest.as_object_mut() {
        entries.remove(name);
    }
    write_skill_manifest(&state, agent, &manifest).await?;
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

fn valid_codex_plugin_name(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 80
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.'))
}

fn codex_plugin_paths() -> (PathBuf, PathBuf) {
    let root = std::env::var_os("CODEX_HOME")
        .or_else(|| std::env::var_os("OSHEEP_CODEX_CONFIG_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| user_home().join(".codex"));
    (root.join("plugins"), root.join("plugins/marketplace.json"))
}

async fn read_personal_codex_marketplace(path: &Path) -> Value {
    tokio::fs::read(path)
        .await
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .filter(Value::is_object)
        .unwrap_or_else(|| serde_json::json!({"name":"personal","plugins":[]}))
}

async fn write_personal_codex_marketplace(path: &Path, value: &Value) -> Result<(), ApiError> {
    if let Some(parent) = path.parent() {
        tokio::fs::create_dir_all(parent).await?;
    }
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            error.to_string(),
        )
    })?;
    bytes.push(b'\n');
    tokio::fs::write(path, bytes).await?;
    Ok(())
}

async fn codex_plugin_local_create(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let name = body
        .get("name")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    if !valid_codex_plugin_name(name) {
        return Err(ApiError::invalid_path("plugin name is invalid"));
    }
    let display = body
        .get("displayName")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or(name);
    let description = body
        .get("description")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("Personal Codex plugin");
    let (root, marketplace_path) = codex_plugin_paths();
    let plugin_root = root.join(name);
    let manifest = plugin_root.join(".codex-plugin/plugin.json");
    if tokio::fs::try_exists(&manifest).await.unwrap_or(false) {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            "ENTRY_EXISTS",
            "Codex plugin already exists",
        ));
    }
    tokio::fs::create_dir_all(manifest.parent().unwrap()).await?;
    let bytes = serde_json::to_vec_pretty(&serde_json::json!({
        "name": name, "version":"0.1.0", "description":description,
        "interface":{"displayName":display,"shortDescription":description}
    }))
    .map_err(|error| {
        ApiError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL",
            error.to_string(),
        )
    })?;
    tokio::fs::write(&manifest, bytes).await?;
    let mut marketplace = read_personal_codex_marketplace(&marketplace_path).await;
    let plugins = marketplace["plugins"].as_array_mut().unwrap();
    plugins.retain(|item| item["name"].as_str() != Some(name));
    plugins.push(serde_json::json!({"name":name,"source":{"path":name}}));
    write_personal_codex_marketplace(&marketplace_path, &marketplace).await?;
    let snapshot = crate::plugin_catalog::codex_snapshot().await;
    state.p6_state.lock().await["codexPlugins"] = snapshot.clone();
    Ok(Json(snapshot))
}

async fn codex_plugin_local_import(
    State(state): State<AppState>,
    Json(body): Json<Value>,
) -> Result<Json<Value>, ApiError> {
    let source = body
        .get("path")
        .and_then(Value::as_str)
        .unwrap_or("")
        .trim();
    let source = PathBuf::from(source);
    let manifest_path = source.join(".codex-plugin/plugin.json");
    let manifest: Value =
        serde_json::from_slice(&tokio::fs::read(&manifest_path).await?).map_err(|error| {
            ApiError::new(StatusCode::BAD_REQUEST, "INVALID_QUERY", error.to_string())
        })?;
    let name = manifest["name"].as_str().unwrap_or("").trim();
    if !valid_codex_plugin_name(name) {
        return Err(ApiError::invalid_path(
            "Codex plugin manifest with a valid name is required",
        ));
    }
    let (root, marketplace_path) = codex_plugin_paths();
    let destination = root.join(name);
    if source != destination {
        if tokio::fs::try_exists(&destination).await.unwrap_or(false) {
            tokio::fs::remove_dir_all(&destination).await?;
        }
        copy_directory_if_missing(&source, &destination).await?;
    }
    let mut marketplace = read_personal_codex_marketplace(&marketplace_path).await;
    let plugins = marketplace["plugins"].as_array_mut().unwrap();
    plugins.retain(|item| item["name"].as_str() != Some(name));
    plugins.push(serde_json::json!({"name":name,"source":{"path":name}}));
    write_personal_codex_marketplace(&marketplace_path, &marketplace).await?;
    let snapshot = crate::plugin_catalog::codex_snapshot().await;
    state.p6_state.lock().await["codexPlugins"] = snapshot.clone();
    Ok(Json(snapshot))
}

async fn codex_plugin_local_delete(
    State(state): State<AppState>,
    AxumPath(name): AxumPath<String>,
    Query(query): Query<std::collections::HashMap<String, String>>,
) -> Result<Json<Value>, ApiError> {
    if !valid_codex_plugin_name(&name) {
        return Err(ApiError::invalid_path("plugin name is invalid"));
    }
    let (root, marketplace_path) = codex_plugin_paths();
    let mut marketplace = read_personal_codex_marketplace(&marketplace_path).await;
    let plugins = marketplace["plugins"].as_array_mut().unwrap();
    let existed = plugins
        .iter()
        .any(|item| item["name"].as_str() == Some(name.as_str()));
    if !existed {
        return Err(ApiError::not_found(format!(
            "Personal Codex plugin not found: {name}"
        )));
    }
    plugins.retain(|item| item["name"].as_str() != Some(name.as_str()));
    if query
        .get("deleteSource")
        .is_some_and(|value| value == "true")
    {
        let path = root.join(&name);
        if tokio::fs::try_exists(&path).await.unwrap_or(false) {
            tokio::fs::remove_dir_all(path).await?;
        }
    }
    write_personal_codex_marketplace(&marketplace_path, &marketplace).await?;
    let snapshot = crate::plugin_catalog::codex_snapshot().await;
    state.p6_state.lock().await["codexPlugins"] = snapshot.clone();
    Ok(Json(snapshot))
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
    let extensions: &[&str] = if Path::new(program).extension().is_some() {
        &[""]
    } else {
        &[".exe", ".cmd", ".bat", ".ps1"]
    };
    #[cfg(not(windows))]
    let extensions: &[&str] = &[""];
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
    let retry_language = Some(
        if body.get("language").and_then(Value::as_str) == Some("zh-CN") {
            "zh-CN"
        } else {
            "en"
        },
    );
    let key = workflow_runtime_key(&root, &wid);
    let (run_id, workflow) = state
        .workflow_runtime
        .start(key, path, root, requested, retry_language)
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

async fn workflow_retry_now(
    State(state): State<AppState>,
    AxumPath((id, wid, _node_id)): AxumPath<(String, String, String)>,
) -> Result<Json<Value>, ApiError> {
    let root = resolve_workspace_path(&state, &id).await?;
    let _ = read_workflow(&root, &wid).await?;
    Err(ApiError::new(
        StatusCode::CONFLICT,
        "WORKFLOW_NOT_WAITING",
        "agent retry is no longer pending",
    ))
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
        let manifest = skill_manifest(state, agent).await;
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
                        let source = if manifest[&name]["origin"] == "skills.sh" {
                            "skills.sh"
                        } else {
                            "local"
                        };
                        enabled_by_path.insert(path.clone(), serde_json::json!({"name":name,"description":skill_description(&path).await,"path":path,"agents":[agent],"source":source,"builtIn":tokio::fs::try_exists(entry.path().join(".osheep-built-in")).await.unwrap_or(false)}));
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
                let record = &manifest[&name];
                user.push(serde_json::json!({"name":name,"description":skill_description(&entry.path()).await,"path":entry.path(),"agent":agent,"origin":record["origin"].as_str().unwrap_or("manual"),"source":record.get("source").cloned().unwrap_or(Value::Null),"builtIn":record["builtIn"].as_bool().unwrap_or_else(|| entry.path().join(".osheep-built-in").exists())}));
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
        crate::workflow_runtime::RuntimeError::NoRunnableBlocks => ApiError::new(
            StatusCode::BAD_REQUEST,
            "WORKFLOW_NOT_RUNNABLE",
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
    fn agent_terminal_commands_preserve_interactive_cli_options() {
        let claude = build_agent_terminal_command(
            "claude-cli",
            &serde_json::json!({
                "terminalPrompt":"review user's change",
                "mode":"plan",
                "effort":"high",
                "conversationSessionId":"550e8400-e29b-41d4-a716-446655440000"
            }),
        )
        .unwrap();
        assert!(claude.contains("'--permission-mode' 'plan'"));
        assert!(claude.contains("'--session-id' '550e8400-e29b-41d4-a716-446655440000'"));
        assert!(claude.contains("'--effort' 'high'"));

        let codex = build_agent_terminal_command(
            "codex-cli",
            &serde_json::json!({
                "terminalPrompt":"continue",
                "resumeConversation":true,
                "conversationSessionId":"550e8400-e29b-41d4-a716-446655440000",
                "codexApproval":"never",
                "codexSandbox":"danger-full-access",
                "effort":"xhigh"
            }),
        )
        .unwrap();
        assert!(codex.contains("'resume'"));
        assert!(codex.contains("'--ask-for-approval' 'never'"));
        assert!(codex.contains("'--sandbox' 'danger-full-access'"));
        assert!(codex.contains("'model_reasoning_effort=\"xhigh\"'"));
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
    fn skill_sources_reject_shell_metacharacters() {
        assert_eq!(
            validate_skill_source("https://github.com/anthropics/skills").unwrap(),
            "https://github.com/anthropics/skills"
        );
        assert!(validate_skill_source("https://example.test/repo%PATH%").is_err());
        assert!(validate_skill_source("owner/repo").is_err());
    }

    #[tokio::test]
    async fn recursively_discovers_produced_skill_directories() {
        let root = std::env::temp_dir().join(format!(
            "osheep-skill-discovery-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let skill = root.join("nested/example");
        tokio::fs::create_dir_all(&skill).await.unwrap();
        tokio::fs::write(skill.join("SKILL.md"), "# Example")
            .await
            .unwrap();
        assert_eq!(find_produced_skill_dirs(&root, 0).await.unwrap(), [skill]);
        tokio::fs::remove_dir_all(root).await.unwrap();
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
