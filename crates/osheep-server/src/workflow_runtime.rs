use osheep_core::{AgentSessionApp, AgentSessionService};
use osheep_pty::{PtyEvent, PtyRuntime, PtySession, SpawnRequest};
use serde_json::Value;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::process::Command;
use tokio::sync::{broadcast, oneshot, Mutex};
use tokio::time::{sleep, Duration};

#[derive(Clone)]
pub(crate) struct WorkflowRuntime {
    events: Arc<Mutex<HashMap<String, broadcast::Sender<Value>>>>,
    active: Arc<Mutex<HashMap<String, ActiveRun>>>,
    interactions: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
    data_root: PathBuf,
    pty: Option<Arc<dyn PtyRuntime>>,
    agent_sessions: Arc<Mutex<HashMap<String, Arc<dyn PtySession>>>>,
    session_service: AgentSessionService,
}

impl Default for WorkflowRuntime {
    fn default() -> Self {
        Self::new(PathBuf::from("."))
    }
}

#[derive(Clone)]
struct ActiveRun {
    run_id: String,
    cancelled: Arc<AtomicBool>,
    checkpoint_on_stop: Arc<AtomicBool>,
}

#[derive(Debug, thiserror::Error)]
pub(crate) enum RuntimeError {
    #[error(transparent)]
    Io(#[from] std::io::Error),
    #[error(transparent)]
    Json(#[from] serde_json::Error),
    #[error("workflow is already running")]
    AlreadyRunning,
    #[error("workflow interaction is not waiting")]
    NotWaiting,
    #[error("workflow has no runnable blocks")]
    NoRunnableBlocks,
    #[error("workflow checkpoint is no longer available")]
    CheckpointUnavailable,
}

impl WorkflowRuntime {
    pub(crate) fn new(data_root: PathBuf) -> Self {
        Self {
            events: Arc::default(),
            active: Arc::default(),
            interactions: Arc::default(),
            data_root,
            pty: None,
            agent_sessions: Arc::default(),
            session_service: AgentSessionService::new(),
        }
    }

    pub(crate) fn new_with_pty(data_root: PathBuf, pty: Arc<dyn PtyRuntime>) -> Self {
        Self {
            events: Arc::default(),
            active: Arc::default(),
            interactions: Arc::default(),
            data_root,
            pty: Some(pty),
            agent_sessions: Arc::default(),
            session_service: AgentSessionService::new(),
        }
    }

    pub(crate) async fn subscribe(&self, key: &str) -> broadcast::Receiver<Value> {
        self.sender(key).await.subscribe()
    }

    pub(crate) async fn start(
        &self,
        key: String,
        workflow_path: PathBuf,
        workspace_root: PathBuf,
        requested_ids: Option<Vec<String>>,
        retry_language: Option<&str>,
        resume: bool,
    ) -> Result<(String, Value), RuntimeError> {
        let mut run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        let cancelled = Arc::new(AtomicBool::new(false));
        let checkpoint_on_stop = Arc::new(AtomicBool::new(false));
        let limit_error = Arc::new(Mutex::new(None::<String>));
        {
            let mut active = self.active.lock().await;
            if active.contains_key(&key) {
                return Err(RuntimeError::AlreadyRunning);
            }
            active.insert(
                key.clone(),
                ActiveRun {
                    run_id: run_id.clone(),
                    cancelled: cancelled.clone(),
                    checkpoint_on_stop: checkpoint_on_stop.clone(),
                },
            );
        }

        let mut workflow = read_json(&workflow_path).await?;
        let full_run = requested_ids.as_ref().is_none_or(Vec::is_empty);
        let node_ids = ordered_node_ids(&workflow, requested_ids.as_deref());
        if node_ids.is_empty() {
            self.active.lock().await.remove(&key);
            return Err(RuntimeError::NoRunnableBlocks);
        }
        let resume_run = if resume && full_run {
            workflow["runs"]
                .as_array()
                .and_then(|runs| {
                    runs.iter().rev().find(|run| {
                        run["status"] == "stopped" && run["resumable"].as_bool() == Some(true)
                    })
                })
                .cloned()
        } else {
            None
        };
        if resume && resume_run.is_none() {
            self.active.lock().await.remove(&key);
            return Err(RuntimeError::CheckpointUnavailable);
        }
        if let Some(previous) = resume_run.as_ref() {
            if previous["nodeIds"].as_array().is_none_or(|ids| {
                ids.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<Vec<_>>()
                    != node_ids
            }) {
                self.active.lock().await.remove(&key);
                return Err(RuntimeError::CheckpointUnavailable);
            }
            if let Some(previous_id) = previous["id"].as_str() {
                run_id = previous_id.to_owned();
                if let Some(active) = self.active.lock().await.get_mut(&key) {
                    active.run_id = run_id.clone();
                }
            }
        }
        let reset = if full_run && resume_run.is_none() {
            workflow["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|node| node["id"].as_str().map(str::to_owned))
                .collect::<HashSet<_>>()
        } else {
            node_ids.iter().cloned().collect::<HashSet<_>>()
        };
        if let Some(nodes) = workflow["nodes"].as_array_mut() {
            for node in nodes {
                if node["id"].as_str().is_some_and(|id| reset.contains(id)) {
                    reset_node(node);
                }
            }
        }
        let now = now_ms();
        let run = if let Some(mut previous) = resume_run {
            previous["status"] = Value::String("running".into());
            previous["startedAt"] = Value::from(now);
            previous["completedAt"] = Value::Null;
            previous["error"] = Value::Null;
            previous["resumable"] = Value::Null;
            previous["resumeFingerprint"] = Value::Null;
            previous
        } else {
            serde_json::json!({
                "id":run_id,"status":"running","startedAt":now,"nodeIds":node_ids,"trace":[]
            })
        };
        if !workflow["runs"].is_array() {
            workflow["runs"] = Value::Array(Vec::new());
        }
        let runs = workflow["runs"].as_array_mut().expect("runs initialized");
        if runs.len() >= 50 {
            runs.drain(..runs.len() - 49);
        }
        if let Some(existing) = runs.iter_mut().find(|item| item["id"] == run_id) {
            *existing = run.clone();
        } else {
            runs.push(run.clone());
        }
        workflow["updatedAt"] = Value::from(now);
        if let Err(error) = write_json(&workflow_path, &workflow).await {
            self.active.lock().await.remove(&key);
            return Err(error);
        }
        self.emit(
            &key,
            serde_json::json!({"type":"run","updatedAt":now,"run":run}),
        )
        .await;

        let runtime = self.clone();
        let task_key = key.clone();
        let task_run_id = run_id.clone();
        let retry_language = retry_language.map(str::to_owned);
        tokio::spawn(async move {
            runtime
                .execute(
                    task_key.clone(),
                    workflow_path,
                    workspace_root,
                    task_run_id.clone(),
                    node_ids,
                    cancelled,
                    checkpoint_on_stop,
                    limit_error,
                    retry_language,
                )
                .await;
            let mut active = runtime.active.lock().await;
            if active
                .get(&task_key)
                .is_some_and(|run| run.run_id == task_run_id)
            {
                active.remove(&task_key);
            }
        });
        Ok((run_id, workflow))
    }

    pub(crate) async fn stop(&self, key: &str) -> bool {
        let active = self.active.lock().await.get(key).cloned();
        if let Some(run) = active {
            run.cancelled.store(true, Ordering::SeqCst);
            if let Some(session) = self.agent_sessions.lock().await.get(key).cloned() {
                let _ = session.kill().await;
            }
            true
        } else {
            false
        }
    }

    pub(crate) async fn pause(&self, key: &str) -> bool {
        let active = self.active.lock().await.get(key).cloned();
        if let Some(run) = active {
            run.checkpoint_on_stop.store(true, Ordering::SeqCst);
            run.cancelled.store(true, Ordering::SeqCst);
            if let Some(session) = self.agent_sessions.lock().await.get(key).cloned() {
                let _ = session.kill().await;
            }
            true
        } else {
            false
        }
    }

    pub(crate) async fn resolve(
        &self,
        key: &str,
        node_id: &str,
        value: Value,
    ) -> Result<(), RuntimeError> {
        self.interactions
            .lock()
            .await
            .remove(&interaction_key(key, node_id))
            .ok_or(RuntimeError::NotWaiting)?
            .send(value)
            .map_err(|_| RuntimeError::NotWaiting)
    }

    async fn execute(
        &self,
        key: String,
        workflow_path: PathBuf,
        workspace_root: PathBuf,
        run_id: String,
        node_ids: Vec<String>,
        cancelled: Arc<AtomicBool>,
        checkpoint_on_stop: Arc<AtomicBool>,
        limit_error: Arc<Mutex<Option<String>>>,
        retry_language: Option<String>,
    ) {
        let mut run_error = None;
        let initial_workflow = read_json(&workflow_path).await.ok();
        let max_duration = initial_workflow
            .as_ref()
            .and_then(|workflow| workflow["settings"]["maxRunDurationSeconds"].as_f64())
            .filter(|value| *value > 0.0);
        let deadline = max_duration
            .map(|seconds| std::time::Instant::now() + Duration::from_secs_f64(seconds));
        let max_cost = initial_workflow
            .as_ref()
            .filter(|workflow| workflow["settings"]["unbilled"] != Value::Bool(true))
            .and_then(|workflow| workflow["settings"]["maxRunCost"].as_f64())
            .filter(|value| *value > 0.0);
        let edges = read_json(&workflow_path)
            .await
            .ok()
            .and_then(|workflow| workflow["edges"].as_array().cloned())
            .unwrap_or_default();
        let selected = node_ids.iter().cloned().collect::<HashSet<_>>();
        let mut source_handles = HashMap::<String, Option<String>>::new();
        let mut skipped = HashSet::<String>::new();
        let mut checkpoints = HashMap::<String, Value>::new();
        if let Ok(workflow) = read_json(&workflow_path).await {
            if let Some(run) = find_run(&workflow, &run_id) {
                if let Some(trace) = run["trace"].as_array() {
                    for item in trace {
                        if item["status"] == "success" {
                            if let Some(node_id) = item["nodeId"].as_str() {
                                if let Some(output) = item.get("output") {
                                    checkpoints.insert(node_id.to_owned(), output.clone());
                                }
                            }
                        }
                    }
                }
            }
        }
        for node_id in node_ids {
            if cancelled.load(Ordering::SeqCst) {
                break;
            }
            if deadline.is_some_and(|deadline| std::time::Instant::now() >= deadline) {
                let seconds = max_duration.unwrap_or_default();
                *limit_error.lock().await = Some(format!(
                    "Workflow run duration exceeded the {}s limit.",
                    format_limit(seconds)
                ));
                cancelled.store(true, Ordering::SeqCst);
                break;
            }
            if let Some(output) = checkpoints.get(&node_id) {
                if let Ok(workflow) = read_json(&workflow_path).await {
                    if let Some(index) = node_index(&workflow, &node_id) {
                        source_handles.insert(
                            node_id.clone(),
                            source_handle(&workflow["nodes"][index], output),
                        );
                    }
                }
                continue;
            }
            if !node_is_active(&node_id, &edges, &selected, &source_handles, &skipped) {
                skipped.insert(node_id);
                continue;
            }
            let started_at = now_ms();
            let mut workflow = match read_json(&workflow_path).await {
                Ok(value) => value,
                Err(error) => {
                    run_error = Some(error.to_string());
                    break;
                }
            };
            let Some(index) = node_index(&workflow, &node_id) else {
                run_error = Some(format!("workflow node not found: {node_id}"));
                break;
            };
            {
                let node = &mut workflow["nodes"][index];
                node["status"] = Value::String("running".into());
                node["startedAt"] = Value::from(started_at);
                node["completedAt"] = Value::Null;
                node["error"] = Value::String(String::new());
                let kind = node["kind"].as_str().unwrap_or("agent").to_owned();
                let action = node["config"]["action"]
                    .as_str()
                    .unwrap_or("display")
                    .to_owned();
                if kind == "input" || (kind == "markdown" && action == "message") {
                    node["config"]["waitingForInput"] = Value::Bool(true);
                }
                if kind == "diff-approval" || (kind == "markdown" && action == "approval") {
                    node["config"]["waitingForApproval"] = Value::Bool(true);
                }
                if matches!(kind.as_str(), "agent" | "command") {
                    node["config"]["runDetails"] = running_details(node, started_at);
                }
            }
            let running_node = workflow["nodes"][index].clone();
            push_trace(&mut workflow, &run_id, &running_node, started_at);
            if write_json(&workflow_path, &workflow).await.is_err() {
                run_error = Some("failed to persist running node".into());
                break;
            }
            self.emit_node(&key, &workflow["nodes"][index]).await;
            if let Some(run) = find_run(&workflow, &run_id).cloned() {
                self.emit_run(&key, &run).await;
            }

            let mut node = workflow["nodes"][index].clone();
            if let Some(language) = retry_language.as_deref() {
                node["config"]["retryLanguage"] =
                    Value::String(if language == "zh-CN" { "zh-CN" } else { "en" }.to_owned());
            }
            let result = if let Some(deadline) = deadline {
                let remaining = deadline.saturating_duration_since(std::time::Instant::now());
                match tokio::time::timeout(
                    remaining,
                    self.execute_node(
                        &key,
                        &workflow_path,
                        &workspace_root,
                        &workflow,
                        &node,
                        cancelled.clone(),
                    ),
                )
                .await
                {
                    Ok(result) => result,
                    Err(_) => {
                        let seconds = max_duration.unwrap_or_default();
                        let message = format!(
                            "Workflow run duration exceeded the {}s limit.",
                            format_limit(seconds)
                        );
                        *limit_error.lock().await = Some(message.clone());
                        cancelled.store(true, Ordering::SeqCst);
                        if let Some(session) = self.agent_sessions.lock().await.get(&key).cloned() {
                            let _ = session.kill().await;
                        }
                        Err(message)
                    }
                }
            } else {
                self.execute_node(
                    &key,
                    &workflow_path,
                    &workspace_root,
                    &workflow,
                    &node,
                    cancelled.clone(),
                )
                .await
            };
            let completed_at = now_ms();
            let mut workflow = match read_json(&workflow_path).await {
                Ok(value) => value,
                Err(error) => {
                    run_error = Some(error.to_string());
                    break;
                }
            };
            let Some(index) = node_index(&workflow, &node_id) else {
                break;
            };
            match result {
                Ok(output) => {
                    let mut output = output;
                    self.apply_usage_cost(&node, &mut output).await;
                    let text = output_text(&output);
                    let node = &mut workflow["nodes"][index];
                    node["status"] = Value::String("success".into());
                    node["summary"] = Value::String(text.clone());
                    node["rawOutput"] = Value::String(
                        serde_json::to_string_pretty(&output).unwrap_or_else(|_| text.clone()),
                    );
                    node["completedAt"] = Value::from(completed_at);
                    node["config"]["waitingForInput"] = Value::Bool(false);
                    node["config"]["waitingForApproval"] = Value::Bool(false);
                    finish_details(node, "success", completed_at, Some(&output), None);
                    source_handles.insert(node_id.clone(), source_handle(node, &output));
                    complete_trace(
                        &mut workflow,
                        &run_id,
                        &node_id,
                        "success",
                        completed_at,
                        Some(output),
                        None,
                    );
                    if let Some(limit) = max_cost {
                        let cost = run_cost_from_workflow(&workflow, &run_id);
                        if cost > limit {
                            let message = format!(
                                "Workflow run cost exceeded the ${} limit.",
                                format_limit(limit)
                            );
                            *limit_error.lock().await = Some(message);
                            cancelled.store(true, Ordering::SeqCst);
                        }
                    }
                }
                Err(error) => {
                    let stopped = cancelled.load(Ordering::SeqCst);
                    let limit = limit_error.lock().await.clone();
                    let checkpoint = stopped && checkpoint_on_stop.load(Ordering::SeqCst);
                    let status = if checkpoint && limit.is_none() {
                        "stopped"
                    } else {
                        "error"
                    };
                    let node = &mut workflow["nodes"][index];
                    if checkpoint {
                        reset_node(node);
                    } else {
                        node["status"] = Value::String(status.into());
                        node["error"] = Value::String(error.clone());
                        node["summary"] = Value::String(error.clone());
                        node["rawOutput"] = Value::String(error.clone());
                        node["completedAt"] = Value::from(completed_at);
                    }
                    node["config"]["waitingForInput"] = Value::Bool(false);
                    node["config"]["waitingForApproval"] = Value::Bool(false);
                    if !checkpoint {
                        finish_details(node, "error", completed_at, None, Some(&error));
                    }
                    complete_trace(
                        &mut workflow,
                        &run_id,
                        &node_id,
                        status,
                        completed_at,
                        None,
                        Some(error.clone()),
                    );
                    if let Some(limit) = limit {
                        run_error = Some(limit);
                    } else if !stopped {
                        run_error = Some(error);
                    }
                }
            }
            workflow["updatedAt"] = Value::from(completed_at);
            if write_json(&workflow_path, &workflow).await.is_err() {
                run_error = Some("failed to persist completed node".into());
                break;
            }
            self.emit_node(&key, &workflow["nodes"][index]).await;
            if run_error.is_some() || cancelled.load(Ordering::SeqCst) {
                break;
            }
        }

        if let Ok(mut workflow) = read_json(&workflow_path).await {
            let completed_at = now_ms();
            let limit = limit_error.lock().await.clone();
            let status = if limit.is_some() {
                "error"
            } else if cancelled.load(Ordering::SeqCst) {
                "stopped"
            } else if run_error.is_some() {
                "error"
            } else {
                "success"
            };
            if let Some(run) = find_run_mut(&mut workflow, &run_id) {
                run["status"] = Value::String(status.into());
                run["completedAt"] = Value::from(completed_at);
                let resumable = status == "stopped" && checkpoint_on_stop.load(Ordering::SeqCst);
                if resumable {
                    run["resumable"] = Value::Bool(true);
                } else {
                    run["resumable"] = Value::Null;
                    run["resumeFingerprint"] = Value::Null;
                }
                if let Some(error) = limit.or(run_error) {
                    run["error"] = Value::String(error);
                }
                let run = run.clone();
                update_run_stats(&mut workflow, &run_id);
                let run = find_run(&workflow, &run_id).cloned().unwrap_or(run);
                workflow["updatedAt"] = Value::from(completed_at);
                let _ = write_json(&workflow_path, &workflow).await;
                self.emit_run(&key, &run).await;
            }
        }
    }

    async fn run_agent(
        &self,
        key: &str,
        workflow_path: &Path,
        workspace_root: &Path,
        workflow: &Value,
        node: &Value,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        let mut resolved_node = node.clone();
        for key in [
            "retries",
            "retryDelaySeconds",
            "retryForever",
            "retryStrategy",
            "retryLanguage",
        ] {
            if let Some(value) = resolved_node["config"][key].as_str() {
                if let Ok(resolved) = resolve_templates(value, workflow) {
                    resolved_node["config"][key] = if key == "retryForever" {
                        Value::Bool(matches!(
                            resolved.trim().to_ascii_lowercase().as_str(),
                            "true" | "1" | "yes"
                        ))
                    } else if matches!(key, "retries" | "retryDelaySeconds") {
                        resolved
                            .parse::<f64>()
                            .map(Value::from)
                            .unwrap_or(Value::String(resolved))
                    } else {
                        Value::String(resolved)
                    };
                }
            }
        }
        if let Some(ids) = resolved_node["config"]["retryProviderIds"].as_array_mut() {
            for id in ids {
                if let Some(value) = id.as_str() {
                    if let Ok(resolved) = resolve_templates(value, workflow) {
                        *id = Value::String(resolved);
                    }
                }
            }
        }
        // Match the Node runner's session-id contract: an id already present in
        // this workspace resumes that conversation, while a missing id starts a
        // new conversation. Claude can create a requested id directly; Codex
        // creates its native id first and is reassigned after the first turn.
        let provider = resolved_node["providerKind"]
            .as_str()
            .unwrap_or("claude-cli")
            .to_owned();
        let configured_session_id = resolved_node["config"]["sessionId"]
            .as_str()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(str::to_owned);
        let session_app = if provider == "codex-cli" {
            AgentSessionApp::Codex
        } else {
            AgentSessionApp::Claude
        };
        let existing_configured_session = if let Some(session_id) = configured_session_id.as_deref()
        {
            self.session_service
                .list(session_app)
                .await
                .map(|sessions| {
                    sessions
                        .iter()
                        .any(|session| session.id.as_str() == session_id)
                })
                .unwrap_or(false)
        } else {
            false
        };
        if existing_configured_session {
            resolved_node["config"]["resumeConversation"] = Value::Bool(true);
            resolved_node["config"]["conversationSessionId"] =
                Value::String(configured_session_id.clone().unwrap_or_default());
        } else {
            // A stale resume flag must not turn a missing id into a failed
            // resume attempt. Codex will be assigned the requested id after
            // its new native session is created.
            resolved_node["config"]["resumeConversation"] = Value::Bool(false);
            if provider == "codex-cli" {
                if let Some(config) = resolved_node["config"].as_object_mut() {
                    config.remove("conversationSessionId");
                }
            } else if configured_session_id.is_none() {
                // Claude requires an explicit id for interactive workflow runs.
                resolved_node["config"]["sessionId"] =
                    Value::String(uuid::Uuid::new_v4().to_string());
            }
        }
        let node = &resolved_node;
        let retries = agent_retry_count(node);
        let retry_forever = agent_retry_forever(node);
        let retry_delay = agent_retry_delay_millis(node);
        let retry_prompt = agent_retry_prompt(node);
        let retry_strategy = if retry_forever || retries > 0 {
            agent_retry_strategy(node).to_owned()
        } else {
            "none".to_owned()
        };
        let retry_provider_ids = agent_retry_provider_ids(node);
        let provider_plan =
            load_agent_provider_plan(&self.data_root, node, &retry_strategy, &retry_provider_ids)
                .await;
        let mut active_provider_id = load_current_agent_provider(&self.data_root, node).await;
        let mut attempt = 0usize;
        let mut current_node = node.clone();
        let mut attempt_transcripts = Vec::new();
        let mut retry_reasons = Vec::new();
        let mut provider_index = 0usize;

        loop {
            if cancelled.load(Ordering::SeqCst) {
                return Err("Workflow stopped.".to_owned());
            }
            if let Some(provider_id) = provider_plan.get(provider_index) {
                current_node["config"]["providerId"] = Value::String(provider_id.clone());
                if active_provider_id.as_deref() != Some(provider_id.as_str()) {
                    apply_agent_provider(&self.data_root, &current_node, provider_id).await?;
                    active_provider_id = Some(provider_id.clone());
                }
            }
            let result = self
                .run_agent_attempt(
                    key,
                    workflow_path,
                    workspace_root,
                    workflow,
                    &current_node,
                    cancelled.clone(),
                )
                .await;
            match result {
                Ok(mut output) => {
                    if current_node["providerKind"].as_str() == Some("codex-cli")
                        && !current_node["config"]["resumeConversation"]
                            .as_bool()
                            .unwrap_or(false)
                    {
                        let requested = current_node["config"]["sessionId"]
                            .as_str()
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_owned);
                        let actual = output["conversationSessionId"].as_str().map(str::to_owned);
                        if let (Some(requested), Some(actual)) = (requested, actual) {
                            if requested != actual {
                                let _ = self
                                    .session_service
                                    .reassign_codex_session_id(&actual, &requested)
                                    .await;
                                output["conversationSessionId"] = Value::String(requested);
                            }
                        }
                    }
                    if !attempt_transcripts.is_empty() {
                        let latest = output_text(&output);
                        output["retryTranscript"] = Value::String(attempt_transcripts.join("\n\n"));
                        output["text"] = Value::String(latest);
                    }
                    output["retryAttempts"] = Value::from(attempt as u64 + 1);
                    if let Some(provider_id) = current_node["config"]["providerId"].as_str() {
                        output["providerId"] = Value::String(provider_id.to_owned());
                    }
                    output["retryStrategy"] = Value::String(retry_strategy.clone());
                    output["retryProviderIds"] = Value::Array(
                        retry_provider_ids
                            .iter()
                            .cloned()
                            .map(Value::String)
                            .collect(),
                    );
                    if !retry_reasons.is_empty() {
                        output["retryReasons"] =
                            Value::Array(retry_reasons.into_iter().map(Value::String).collect());
                    }
                    clear_retry_details(workflow_path, node["id"].as_str().unwrap_or("")).await;
                    return Ok(output);
                }
                Err(error) => {
                    if !should_retry_agent_failure(&error, attempt, retries, retry_forever) {
                        if !retry_reasons.is_empty() {
                            persist_retry_reasons(
                                workflow_path,
                                node["id"].as_str().unwrap_or(""),
                                &retry_reasons,
                            )
                            .await;
                        }
                        clear_retry_details(workflow_path, node["id"].as_str().unwrap_or("")).await;
                        return Err(if attempt > 0 {
                            format!(
                                "{} failed after {} attempts: {}",
                                node_title(node),
                                attempt + 1,
                                error
                            )
                        } else {
                            error
                        });
                    }
                    retry_reasons.push(error.clone());
                    if provider_plan.len() > 1 {
                        provider_index = (provider_index + 1) % provider_plan.len();
                    }
                    attempt += 1;
                    attempt_transcripts.push(format!(
                        "{error}\n[osheep] retry {attempt}/{}: {retry_prompt}",
                        if retry_forever {
                            "infinity".to_owned()
                        } else {
                            retries.to_string()
                        }
                    ));
                    set_retry_details(
                        workflow_path,
                        node["id"].as_str().unwrap_or(""),
                        retry_delay,
                        attempt,
                        &error,
                    )
                    .await;
                    if let Ok(updated) = read_json(workflow_path).await {
                        if let Some(index) = node_index(&updated, node["id"].as_str().unwrap_or(""))
                        {
                            self.emit_node(&key, &updated["nodes"][index]).await;
                        }
                    }
                    current_node["prompt"] = Value::String(retry_prompt.to_owned());
                    current_node["config"]["resumeConversation"] = Value::Bool(true);
                    if current_node["providerKind"].as_str() == Some("codex-cli") {
                        let requested = current_node["config"]["sessionId"]
                            .as_str()
                            .filter(|value| !value.trim().is_empty())
                            .map(str::to_owned);
                        let actual = read_agent_conversation_id(
                            workflow_path,
                            node["id"].as_str().unwrap_or(""),
                        )
                        .await;
                        if let (Some(requested), Some(actual)) = (requested, actual) {
                            if requested != actual {
                                let _ = self
                                    .session_service
                                    .reassign_codex_session_id(&actual, &requested)
                                    .await;
                                current_node["config"]["conversationSessionId"] =
                                    Value::String(requested.clone());
                                current_node["config"]["sessionId"] = Value::String(requested);
                            }
                        }
                    }
                    let persisted_session_id = read_agent_conversation_id(
                        workflow_path,
                        node["id"].as_str().unwrap_or(""),
                    )
                    .await;
                    if let Some(session_id) = persisted_session_id.or_else(|| {
                        current_node["config"]["conversationSessionId"]
                            .as_str()
                            .or_else(|| current_node["config"]["sessionId"].as_str())
                            .map(str::to_owned)
                    }) {
                        current_node["config"]["conversationSessionId"] =
                            Value::String(session_id.clone());
                        current_node["config"]["sessionId"] = Value::String(session_id);
                    }
                    wait_cancelled(Duration::from_millis(retry_delay), cancelled.clone()).await?;
                    clear_retry_details(workflow_path, node["id"].as_str().unwrap_or("")).await;
                    if let Ok(updated) = read_json(workflow_path).await {
                        if let Some(index) = node_index(&updated, node["id"].as_str().unwrap_or(""))
                        {
                            self.emit_node(&key, &updated["nodes"][index]).await;
                        }
                    }
                }
            }
        }
    }

    async fn run_agent_attempt(
        &self,
        key: &str,
        workflow_path: &Path,
        workspace_root: &Path,
        workflow: &Value,
        node: &Value,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        let Some(pty) = self.pty.clone() else {
            return run_agent_process(workspace_root, workflow, node, cancelled).await;
        };
        let prompt = resolve_templates(node["prompt"].as_str().unwrap_or(""), workflow)?;
        let prompt = prompt.trim();
        if prompt.is_empty() {
            return Err(format!(
                "{} has no prompt.",
                node["title"].as_str().unwrap_or("Agent")
            ));
        }
        let provider = node["providerKind"].as_str().unwrap_or("claude-cli");
        let mut launch_node = node.clone();
        if provider == "claude-cli"
            && launch_node["config"]["resumeConversation"]
                .as_bool()
                .unwrap_or(false)
        {
            let session_id = launch_node["config"]["sessionId"]
                .as_str()
                .or_else(|| launch_node["config"]["conversationSessionId"].as_str())
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let exists = if let Some(session_id) = session_id {
                self.session_service
                    .list(AgentSessionApp::Claude)
                    .await
                    .map(|sessions| {
                        sessions
                            .iter()
                            .any(|session| session.id.as_str() == session_id)
                    })
                    .unwrap_or(false)
            } else {
                false
            };
            if !exists {
                launch_node["config"]["resumeConversation"] = Value::Bool(false);
            }
        }
        let (executable, args) = build_workflow_agent_invocation(provider, &launch_node, prompt)?;
        let agent_app = if provider == "codex-cli" {
            AgentSessionApp::Codex
        } else {
            AgentSessionApp::Claude
        };
        let baseline_session_ids = self
            .session_service
            .list_in_project(agent_app, workspace_root)
            .await
            .unwrap_or_default()
            .into_iter()
            .map(|item| item.id)
            .collect::<HashSet<_>>();
        let profile = pty
            .profiles()
            .into_iter()
            .next()
            .ok_or_else(|| "服务器未探测到可用 shell".to_owned())?;
        let session = pty
            .spawn(SpawnRequest {
                workspace_id: format!("workflow-{key}"),
                cwd: workspace_root.to_path_buf(),
                workspaces_root: workspace_root
                    .parent()
                    .unwrap_or(workspace_root)
                    .to_path_buf(),
                shell: profile.id,
                cols: 120,
                rows: 34,
                kill_on_detach: false,
                initial_executable: Some(executable),
                initial_args: args,
                terminal_program: Some("WezTerm".to_owned()),
            })
            .await
            .map_err(|error| error.to_string())?;
        let session_id = session.summary().id.clone();
        let (replay, mut events) = session.attach();
        self.agent_sessions
            .lock()
            .await
            .insert(key.to_owned(), session.clone());
        let node_id = node["id"].as_str().unwrap_or("").to_owned();
        self.persist_agent_details(
            workflow_path,
            key,
            &node_id,
            &session_id,
            "prompt-sent",
            "",
            None,
        )
        .await;
        let mut transcript = replay.data;
        let resume_configured = launch_node["config"]["resumeConversation"]
            .as_bool()
            .unwrap_or(false);
        let mut conversation_id = if provider == "codex-cli" && resume_configured {
            launch_node["config"]["conversationSessionId"]
                .as_str()
                .or_else(|| launch_node["config"]["sessionId"].as_str())
        } else if provider != "codex-cli" {
            launch_node["config"]["sessionId"].as_str()
        } else {
            None
        }
        .filter(|value| !value.trim().is_empty())
        .map(str::to_owned);
        let mut session_offset = 0usize;
        let mut session_remainder = String::new();
        let session_discovery_deadline = std::time::Instant::now() + Duration::from_secs(30);
        let mut final_message = String::new();
        let mut waiting_for_choice = false;
        let mut codex_pending_approvals = HashSet::new();
        let mut active_codex_turn_id: Option<String> = None;
        let mut codex_pending_abort: Option<(String, std::time::Instant, bool)> = None;
        let mut codex_user_interrupted = false;
        let mut pty_ended = false;
        let mut session_jsonl_seen = false;
        if let Some(id) = conversation_id.as_deref() {
            if let Ok(Some(content)) = self
                .session_service
                .read_in_project(agent_app, id, workspace_root)
                .await
            {
                session_offset = content.len();
                session_jsonl_seen = true;
            }
        }
        let result = 'agent_loop: loop {
            if cancelled.load(Ordering::SeqCst) {
                let _ = session.kill().await;
                break Err("Workflow stopped.".to_owned());
            }
            tokio::select! {
                event = events.recv(), if !pty_ended => match event {
                    Ok(PtyEvent::Output(data)) => {
                        transcript.push_str(&data);
                    }
                    Ok(PtyEvent::Exit { .. }) | Ok(PtyEvent::Error(_)) | Err(_) => {
                        pty_ended = true;
                    }
                },
                _ = sleep(Duration::from_millis(120)) => {
                    if !session_jsonl_seen {
                        if let Ok(sessions) = self.session_service.list_in_project(agent_app, workspace_root).await {
                            let existing_id = conversation_id.as_deref();
                            conversation_id = sessions
                                .into_iter()
                                .find(|item| {
                                    existing_id.is_some_and(|id| id == item.id)
                                        || (existing_id.is_none()
                                            && !baseline_session_ids.contains(&item.id)
                                            && item.updated_at
                                                >= node["startedAt"].as_u64().unwrap_or(0) as f64)
                                })
                                .map(|item| item.id);
                        }
                        if !session_jsonl_seen
                            && std::time::Instant::now() >= session_discovery_deadline
                        {
                            let _ = session.kill().await;
                            break 'agent_loop Err(format!(
                                "{} session JSONL was not created.",
                                if agent_app == AgentSessionApp::Codex {
                                    "Codex"
                                } else {
                                    "Claude Code"
                                }
                            ));
                        }
                    }
                    if let Some(id) = conversation_id.as_deref() {
                        if let Ok(Some(content)) = self.session_service.read_in_project(agent_app, id, workspace_root).await {
                            session_jsonl_seen = true;
                            let start = session_offset.min(content.len());
                            session_offset = content.len();
                            let lines = take_complete_jsonl_lines(
                                &mut session_remainder,
                                content.get(start..).unwrap_or(""),
                            );
                            for line in lines {
                                let Ok(value) = serde_json::from_str::<Value>(&line) else { continue };
                                if agent_app == AgentSessionApp::Codex {
                                    let payload = value.get("payload").unwrap_or(&Value::Null);
                                    let kind = payload["type"]
                                        .as_str()
                                        .or_else(|| value["type"].as_str())
                                        .unwrap_or("");
                                    let turn_id = payload["turn_id"]
                                        .as_str()
                                        .or_else(|| value["turn_id"].as_str())
                                        .unwrap_or("");
                                    if codex_user_interrupt_marker(&value) {
                                        codex_user_interrupted = true;
                                        continue;
                                    }
                                    if matches!(kind, "task_started" | "turn_started") {
                                        if !turn_id.is_empty() {
                                            if let Some((message, _, interrupted)) = codex_pending_abort.take() {
                                                let error = if interrupted {
                                                    "Codex turn was cancelled.".to_owned()
                                                } else {
                                                    message
                                                };
                                                let _ = session.kill().await;
                                                self.persist_agent_details(
                                                    workflow_path,
                                                    key,
                                                    &node_id,
                                                    &session_id,
                                                    "error",
                                                    &error,
                                                    Some(id),
                                                ).await;
                                                break 'agent_loop Err(error);
                                            }
                                            active_codex_turn_id = Some(turn_id.to_owned());
                                        }
                                        codex_user_interrupted = false;
                                    } else if active_codex_turn_id
                                        .as_deref()
                                        .is_some_and(|active| !turn_id.is_empty() && active != turn_id)
                                    {
                                        continue;
                                    }
                                    if matches!(kind, "turn_aborted" | "task_aborted") {
                                        if codex_pending_approvals.iter().any(|id| id == "__osheep_rejected_turn") {
                                            continue;
                                        }
                                        let message = codex_event_error_message(&value)
                                            .unwrap_or_else(|| "Codex turn was cancelled.".to_owned());
                                        if is_codex_api_error(&message) {
                                            let _ = session.kill().await;
                                            self.persist_agent_details(
                                                workflow_path,
                                                key,
                                                &node_id,
                                                &session_id,
                                                "error",
                                                &message,
                                                Some(id),
                                            ).await;
                                            break 'agent_loop Err(message);
                                        }
                                        if !codex_pending_approvals.is_empty() {
                                            codex_pending_approvals.clear();
                                            codex_pending_approvals.insert("__osheep_rejected_turn".to_owned());
                                            continue;
                                        }
                                        codex_pending_abort = Some((
                                            message,
                                            std::time::Instant::now() + Duration::from_millis(250),
                                            codex_user_interrupted,
                                        ));
                                        codex_user_interrupted = false;
                                        continue;
                                    }
                                }
                                let approval_state = if agent_app == AgentSessionApp::Codex {
                                    codex_approval_event(&mut codex_pending_approvals, &value)
                                } else {
                                    if agent_session_waiting_for_choice(agent_app, &value) {
                                        Some(true)
                                    } else if waiting_for_choice
                                        && agent_session_resume_event(agent_app, &value)
                                    {
                                        Some(false)
                                    } else {
                                        None
                                    }
                                };
                                if let Some(waiting) = approval_state {
                                    waiting_for_choice = waiting;
                                    self.persist_agent_details(
                                        workflow_path,
                                        key,
                                        &node_id,
                                        &session_id,
                                        if waiting { "waiting-for-choice" } else { "running" },
                                        &transcript,
                                        Some(id),
                                    )
                                    .await;
                                    if waiting {
                                        continue;
                                    }
                                }
                                if let Some(message) = agent_session_message(agent_app, &value) {
                                    final_message = message;
                                }
                                if let Some((success, message)) = agent_session_completion(agent_app, &value) {
                                    if waiting_for_choice {
                                        continue;
                                    }
                                    if success {
                                        let _ = session.kill().await;
                                        let answer = if agent_app == AgentSessionApp::Codex {
                                            parse_agent_session_result(agent_app, &content)
                                                .and_then(Result::ok)
                                                .filter(|answer| !answer.trim().is_empty())
                                                .unwrap_or_default()
                                        } else {
                                            final_message.clone()
                                        };
                                        break 'agent_loop Ok(serde_json::json!({"type":provider,"status":"success","stdout":"","stderr":"","text":answer,"transcript":answer,"usage":agent_session_usage(agent_app, &content),"exitCode":0,"conversationSessionId":id}));
                                    }
                                    let _ = session.kill().await;
                                    self.persist_agent_details(
                                        workflow_path,
                                        key,
                                        &node_id,
                                        &session_id,
                                        "error",
                                        &message,
                                        Some(id),
                                    )
                                    .await;
                                    break 'agent_loop Err(message);
                                }
                            }
                        }
                        if let Some((message, deadline, interrupted)) = codex_pending_abort.as_ref() {
                            if std::time::Instant::now() >= *deadline {
                                let message = if *interrupted {
                                    "Codex turn was cancelled.".to_owned()
                                } else {
                                    message.clone()
                                };
                                let _ = session.kill().await;
                                self.persist_agent_details(
                                    workflow_path,
                                    key,
                                    &node_id,
                                    &session_id,
                                    "error",
                                    &message,
                                    conversation_id.as_deref(),
                                ).await;
                                break 'agent_loop Err(message);
                            }
                        }
                    }
                }
            }
        };
        self.agent_sessions.lock().await.remove(key);
        result
    }

    async fn persist_agent_details(
        &self,
        workflow_path: &Path,
        key: &str,
        node_id: &str,
        session_id: &str,
        status: &str,
        transcript: &str,
        conversation_id: Option<&str>,
    ) {
        let Ok(mut workflow) = read_json(workflow_path).await else {
            return;
        };
        let Some(index) = node_index(&workflow, node_id) else {
            return;
        };
        let node = &mut workflow["nodes"][index];
        let started_at = node["startedAt"].as_u64().unwrap_or_else(now_ms);
        if !node["config"]["runDetails"].is_object() {
            let details = running_details(node, started_at);
            node["config"]["runDetails"] = details;
        }
        let details = &mut node["config"]["runDetails"];
        details["terminalSessionId"] = Value::String(session_id.to_owned());
        details["terminalStatus"] = Value::String(status.to_owned());
        details["transcript"] = Value::String(transcript.to_owned());
        details["stdout"] = Value::String(transcript.to_owned());
        if let Some(id) = conversation_id {
            details["conversationSessionId"] = Value::String(id.to_owned());
        }
        workflow["updatedAt"] = Value::from(now_ms());
        if write_json(workflow_path, &workflow).await.is_ok() {
            self.emit_node(key, &workflow["nodes"][index]).await;
        }
    }

    async fn execute_node(
        &self,
        key: &str,
        workflow_path: &Path,
        workspace_root: &Path,
        workflow: &Value,
        node: &Value,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        let kind = node["kind"].as_str().unwrap_or("agent");
        match kind {
            "trigger" | "manual-trigger" | "cron" | "webhook-trigger" => {
                Ok(output(kind, "Triggered."))
            }
            "agent" => {
                self.run_agent(
                    key,
                    workflow_path,
                    workspace_root,
                    workflow,
                    node,
                    cancelled,
                )
                .await
            }
            "command" => {
                let command = resolve_templates(node["prompt"].as_str().unwrap_or(""), workflow)?;
                run_shell(workspace_root, &command, cancelled).await
            }
            "wait" => {
                let seconds = match &node["config"]["seconds"] {
                    Value::String(value) => resolve_templates(value, workflow)?
                        .parse::<f64>()
                        .unwrap_or(1.0),
                    value => value.as_f64().unwrap_or(1.0),
                }
                .clamp(0.0, 86_400.0);
                wait_cancelled(Duration::from_secs_f64(seconds), cancelled).await?;
                Ok(output(kind, &format!("Waited {seconds:.1}s.")))
            }
            "file-read" => {
                let relative = resolve_templates(node["prompt"].as_str().unwrap_or(""), workflow)?;
                let relative = relative.trim();
                let path = safe_workspace_path(workspace_root, relative)?;
                let content = tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(
                    serde_json::json!({"type":kind,"status":"success","path":relative,"content":content,"text":content}),
                )
            }
            "file-write" => {
                let relative =
                    resolve_templates(node["config"]["path"].as_str().unwrap_or(""), workflow)?;
                let relative = relative.trim();
                let content = resolve_templates(
                    node["config"]["content"]
                        .as_str()
                        .unwrap_or(node["prompt"].as_str().unwrap_or("")),
                    workflow,
                )?;
                let path = safe_workspace_path(workspace_root, relative)?;
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                tokio::fs::write(path, &content)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(
                    serde_json::json!({"type":kind,"status":"success","path":relative,"bytes":content.len(),"content":content,"text":content}),
                )
            }
            "web" => {
                let url = resolve_templates(node["prompt"].as_str().unwrap_or(""), workflow)?;
                fetch_url(workspace_root, &url, "GET", None, cancelled).await
            }
            "http-request" => {
                let config = &node["config"];
                let url = resolve_templates(config["url"].as_str().unwrap_or(""), workflow)?;
                let method =
                    resolve_templates(config["method"].as_str().unwrap_or("GET"), workflow)?;
                let body = config["body"]
                    .as_str()
                    .map(|body| resolve_templates(body, workflow))
                    .transpose()?;
                fetch_url(workspace_root, &url, &method, body.as_deref(), cancelled).await
            }
            "input" => {
                self.wait_for_interaction(key, node, "input", cancelled)
                    .await
            }
            "diff-approval" => {
                self.wait_for_interaction(key, node, "diff-approval", cancelled)
                    .await
            }
            "markdown" => {
                let action = node["config"]["action"].as_str().unwrap_or("display");
                if matches!(action, "approval" | "message") {
                    self.wait_for_interaction(key, node, "markdown", cancelled)
                        .await
                } else {
                    Ok(output(kind, node["prompt"].as_str().unwrap_or("")))
                }
            }
            "if" => {
                let expression = if_expression(node);
                let result = crate::condition_expression::evaluate(&expression, |template| {
                    resolve_template_value(template, workflow)
                })?;
                Ok(serde_json::json!({
                    "type":"if","status":"success","result":result,
                    "expression":expression,"text":if result {"true"} else {"false"}
                }))
            }
            "variable" => execute_variable(node, workflow),
            "set" => {
                let raw = resolve_templates(
                    node["config"]["data"]
                        .as_str()
                        .unwrap_or("{\n  \"text\": \"\"\n}"),
                    workflow,
                )?;
                let data: Value = if raw.trim().is_empty() {
                    serde_json::json!({})
                } else {
                    serde_json::from_str(&raw).map_err(|error| {
                        format!("{} data JSON is invalid: {error}", node_title(node))
                    })?
                };
                let mut result = data.as_object().cloned().unwrap_or_default();
                result.insert("type".into(), Value::String("set".into()));
                result.insert("status".into(), Value::String("success".into()));
                result.insert("data".into(), data.clone());
                result.insert("text".into(), Value::String(output_text(&data)));
                Ok(Value::Object(result))
            }
            "merge" => execute_merge(node, workflow),
            "loop-items" => execute_loop_items(node, workflow),
            "json" => execute_json(node, workflow),
            "code" => run_code_block(workspace_root, workflow, node, cancelled).await,
            "codex-skill" | "claude-skill" => {
                let agent = if kind == "codex-skill" {
                    "codex"
                } else {
                    "claude"
                };
                let names = node["config"]["skillNames"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect::<HashSet<_>>();
                let enabled = apply_runtime_skill_selection(&self.data_root, agent, &names).await?;
                Ok(serde_json::json!({
                    "type":kind,"status":"success","selected":names,"enabled":enabled,
                    "text":format!("{} skills updated: {} enabled.", if agent == "codex" {"Codex"} else {"Claude"}, enabled.len())
                }))
            }
            "claude-plugin" => apply_claude_plugin_selection(workspace_root, node, cancelled).await,
            "codex-plugin" => apply_codex_plugin_selection(node).await,
            "mcp" => run_mcp_block(workspace_root, workflow, node, cancelled).await,
            "git-commit" => {
                let message =
                    resolve_templates(node["config"]["message"].as_str().unwrap_or(""), workflow)?;
                let message = message.trim();
                if message.is_empty() {
                    return Err("Git commit message is required.".into());
                }
                run_program(
                    workspace_root,
                    "git",
                    &["commit", "-m", message],
                    None,
                    cancelled,
                )
                .await
            }
            "git-checkout" => {
                let branch =
                    resolve_templates(node["config"]["branch"].as_str().unwrap_or(""), workflow)?;
                let branch = branch.trim();
                if branch.is_empty() {
                    return Err("Git branch is required.".into());
                }
                let create = node["config"]["createIfMissing"].as_bool().unwrap_or(false);
                let args = if create {
                    vec!["checkout", "-B", branch]
                } else {
                    vec!["checkout", branch]
                };
                run_program(workspace_root, "git", &args, None, cancelled).await
            }
            "git-delete-branch" => {
                let branch =
                    resolve_templates(node["config"]["branch"].as_str().unwrap_or(""), workflow)?;
                let branch = branch.trim();
                if branch.is_empty() {
                    return Err("Git branch is required.".into());
                }
                let flag = if node["config"]["force"].as_bool().unwrap_or(false) {
                    "-D"
                } else {
                    "-d"
                };
                run_program(
                    workspace_root,
                    "git",
                    &["branch", flag, branch],
                    None,
                    cancelled,
                )
                .await
            }
            "github-pr" => {
                let title =
                    resolve_templates(node["config"]["title"].as_str().unwrap_or(""), workflow)?;
                if title.trim().is_empty() {
                    return Err("GitHub PR title is required.".into());
                }
                let body =
                    resolve_templates(node["config"]["body"].as_str().unwrap_or(""), workflow)?;
                let base =
                    resolve_templates(node["config"]["base"].as_str().unwrap_or(""), workflow)?;
                let head =
                    resolve_templates(node["config"]["compare"].as_str().unwrap_or(""), workflow)?;
                let mut args = vec!["pr", "create", "--title", title.trim(), "--body", &body];
                if !base.trim().is_empty() {
                    args.extend(["--base", base.trim()]);
                }
                if !head.trim().is_empty() {
                    args.extend(["--head", head.trim()]);
                }
                if node["config"]["draft"].as_bool().unwrap_or(false) {
                    args.push("--draft");
                }
                let result = run_program(workspace_root, "gh", &args, None, cancelled).await?;
                let url = result["stdout"]
                    .as_str()
                    .unwrap_or("")
                    .lines()
                    .last()
                    .unwrap_or("");
                let number = url
                    .rsplit("/pull/")
                    .next()
                    .and_then(|value| value.trim_matches('/').parse::<u64>().ok());
                Ok(serde_json::json!({
                    "type":"github-pr","status":"success","url":url,"number":number,"text":url
                }))
            }
            other => Err(format!(
                "Workflow block type is not supported by this backend: {other}"
            )),
        }
    }

    async fn wait_for_interaction(
        &self,
        key: &str,
        node: &Value,
        kind: &str,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        let node_id = node["id"].as_str().unwrap_or_default();
        let (sender, mut receiver) = oneshot::channel();
        self.interactions
            .lock()
            .await
            .insert(interaction_key(key, node_id), sender);
        loop {
            tokio::select! {
                value = &mut receiver => {
                    let value = value.map_err(|_| "Workflow interaction was cancelled.".to_owned())?;
                    return Ok(serde_json::json!({"type":kind,"status":"success","value":value,"text":output_text(&value)}));
                }
                _ = sleep(Duration::from_millis(100)) => {
                    if cancelled.load(Ordering::SeqCst) {
                        self.interactions.lock().await.remove(&interaction_key(key, node_id));
                        return Err("Workflow stopped.".into());
                    }
                }
            }
        }
    }

    async fn apply_usage_cost(&self, node: &Value, output: &mut Value) {
        let output_provider_id = output["providerId"].as_str().map(str::to_owned);
        let Some(usage) = output.get_mut("usage").and_then(Value::as_object_mut) else {
            return;
        };
        if usage.get("cost").and_then(Value::as_f64).is_some() {
            return;
        }
        let model = usage
            .get("model")
            .and_then(Value::as_str)
            .or_else(|| node["model"].as_str())
            .unwrap_or("default");
        let Some(tokens) = usage_tokens(usage) else {
            return;
        };
        let settings = read_json(&self.data_root.join("settings.json")).await.ok();
        let prices = settings
            .as_ref()
            .and_then(|value| value["pricing"]["models"].as_array())
            .cloned()
            .unwrap_or_default();
        let input_includes_cache = node["providerKind"].as_str() != Some("claude-cli");
        if let Some(cost) = calculate_model_cost(model, &tokens, &prices, input_includes_cache) {
            let multiplier =
                provider_billing_multiplier(&self.data_root, node, output_provider_id.as_deref())
                    .await;
            usage.insert("cost".into(), Value::from(cost * multiplier));
            usage.insert("billingMultiplier".into(), Value::from(multiplier));
        }
    }

    async fn sender(&self, key: &str) -> broadcast::Sender<Value> {
        let mut events = self.events.lock().await;
        events
            .entry(key.to_owned())
            .or_insert_with(|| broadcast::channel(256).0)
            .clone()
    }

    async fn emit(&self, key: &str, event: Value) {
        let _ = self.sender(key).await.send(event);
    }

    async fn emit_node(&self, key: &str, node: &Value) {
        self.emit(
            key,
            serde_json::json!({"type":"node","updatedAt":now_ms(),"node":node}),
        )
        .await;
    }

    async fn emit_run(&self, key: &str, run: &Value) {
        self.emit(
            key,
            serde_json::json!({"type":"run","updatedAt":now_ms(),"run":run}),
        )
        .await;
    }
}

async fn provider_billing_multiplier(
    data_root: &Path,
    node: &Value,
    output_provider_id: Option<&str>,
) -> f64 {
    let provider_id = output_provider_id
        .or_else(|| node["config"]["providerId"].as_str())
        .unwrap_or("");
    if provider_id.trim().is_empty() {
        return 1.0;
    }
    let app = if node["providerKind"].as_str() == Some("codex-cli") {
        "codex"
    } else {
        "claude"
    };
    let path = std::env::var_os("OSHEEP_AI_SETTINGS_STORE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("ai-settings.json"));
    let Ok(bytes) = tokio::fs::read(path).await else {
        return 1.0;
    };
    let Ok(settings) = serde_json::from_slice::<Value>(&bytes) else {
        return 1.0;
    };
    settings["apps"][app]["providers"][provider_id]["billingMultiplier"]
        .as_f64()
        .filter(|value| value.is_finite() && *value >= 0.0)
        .unwrap_or(1.0)
}

fn usage_tokens(usage: &serde_json::Map<String, Value>) -> Option<(f64, f64, f64, f64)> {
    let input = usage_number_map(usage, &["input", "inputTokens", "input_tokens"]);
    let output = usage_number_map(usage, &["output", "outputTokens", "output_tokens"]);
    let cache_read = usage_number_map(
        usage,
        &[
            "cacheRead",
            "cache_read_input_tokens",
            "cached_input_tokens",
        ],
    );
    let cache_write = usage_number_map(
        usage,
        &[
            "cacheWrite",
            "cache_creation_input_tokens",
            "cache_write_tokens",
        ],
    );
    (input > 0.0 || output > 0.0 || cache_read > 0.0 || cache_write > 0.0).then_some((
        input,
        output,
        cache_read,
        cache_write,
    ))
}

fn usage_number_map(map: &serde_json::Map<String, Value>, keys: &[&str]) -> f64 {
    keys.iter()
        .find_map(|key| map.get(*key).and_then(Value::as_f64))
        .unwrap_or(0.0)
}

fn calculate_model_cost(
    model: &str,
    tokens: &(f64, f64, f64, f64),
    prices: &[Value],
    input_includes_cache: bool,
) -> Option<f64> {
    let price = prices.iter().find(|price| {
        price["model"]
            .as_str()
            .is_some_and(|value| value.eq_ignore_ascii_case(model))
    })?;
    if price["billingMode"].as_str() == Some("per-request") {
        return price["costPerRequest"].as_f64();
    }
    let input = tokens.0;
    let cache_read = tokens.2;
    let cache_write = tokens.3;
    let uncached_input = if input_includes_cache {
        if input >= cache_read + cache_write {
            input - cache_read - cache_write
        } else {
            input
        }
    } else {
        input
    };
    let input_rate = price["inputCostPerMillion"].as_f64().unwrap_or(0.0);
    let output_rate = price["outputCostPerMillion"].as_f64().unwrap_or(0.0);
    let read_rate = price["cacheReadCostPerMillion"]
        .as_f64()
        .unwrap_or(input_rate);
    let write_rate = price["cacheWriteCostPerMillion"]
        .as_f64()
        .unwrap_or(input_rate);
    let cost = (uncached_input * input_rate
        + tokens.1 * output_rate
        + cache_read * read_rate
        + cache_write * write_rate)
        / 1_000_000.0;
    cost.is_finite().then_some(cost)
}

fn format_limit(value: f64) -> String {
    if value < 0.0001 {
        format!("{value:.8}")
    } else {
        format!("{value:.4}")
    }
}

fn run_cost_from_workflow(workflow: &Value, run_id: &str) -> f64 {
    find_run(workflow, run_id)
        .and_then(|run| run["trace"].as_array())
        .into_iter()
        .flatten()
        .map(|trace| trace["cost"].as_f64().unwrap_or(0.0))
        .sum()
}

fn update_run_stats(workflow: &mut Value, run_id: &str) {
    let Some(run) = find_run(workflow, run_id).cloned() else {
        return;
    };
    let traces = run["trace"].as_array().cloned().unwrap_or_default();
    let mut input = 0.0;
    let mut output = 0.0;
    let mut cache_read = 0.0;
    let mut cache_write = 0.0;
    let mut total = 0.0;
    let mut cost = 0.0;
    for trace in &traces {
        input += trace["tokens"]["input"].as_f64().unwrap_or(0.0);
        output += trace["tokens"]["output"].as_f64().unwrap_or(0.0);
        cache_read += trace["tokens"]["cacheRead"].as_f64().unwrap_or(0.0);
        cache_write += trace["tokens"]["cacheWrite"].as_f64().unwrap_or(0.0);
        let trace_total = trace["tokens"]["total"].as_f64().unwrap_or(input + output);
        total += trace_total;
        cost += trace["cost"].as_f64().unwrap_or(0.0);
    }
    if let Some(run) = find_run_mut(workflow, run_id) {
        run["stats"] = serde_json::json!({
            "durationMs":run["completedAt"].as_u64().unwrap_or_else(now_ms).saturating_sub(run["startedAt"].as_u64().unwrap_or(0)),
            "inputTokens":input,"outputTokens":output,"cacheReadTokens":cache_read,
            "cacheWriteTokens":cache_write,"totalTokens":total.max(input + output),
            "cost":cost,"nodeCount":traces.len(),
            "retryCount":traces.iter().map(|trace| trace["retryReasons"].as_array().map_or(0, Vec::len)).sum::<usize>()
        });
    }
}

fn ordered_node_ids(workflow: &Value, requested: Option<&[String]>) -> Vec<String> {
    let nodes = workflow["nodes"].as_array().cloned().unwrap_or_default();
    let all = nodes
        .iter()
        .filter_map(|node| node["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    if let Some(requested) = requested.filter(|ids| !ids.is_empty()) {
        let requested = requested.iter().collect::<HashSet<_>>();
        return all
            .into_iter()
            .filter(|id| requested.contains(id))
            .collect();
    }
    let known = all.iter().cloned().collect::<HashSet<_>>();
    let roots = nodes
        .iter()
        .filter(|node| {
            matches!(
                node["kind"].as_str().unwrap_or("agent"),
                "trigger" | "manual-trigger" | "cron" | "webhook-trigger"
            )
        })
        .filter_map(|node| node["id"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let mut reachable = HashSet::new();
    let mut pending = VecDeque::from(roots);
    while let Some(id) = pending.pop_front() {
        if !reachable.insert(id.clone()) {
            continue;
        }
        for edge in workflow["edges"].as_array().into_iter().flatten() {
            if edge["from"] == id {
                if let Some(target) = edge["to"].as_str().filter(|target| known.contains(*target)) {
                    pending.push_back(target.to_owned());
                }
            }
        }
    }
    let planned = all
        .iter()
        .filter(|id| reachable.contains(*id))
        .cloned()
        .collect::<Vec<_>>();
    let mut indegree = all
        .iter()
        .filter(|id| reachable.contains(*id))
        .map(|id| (id.clone(), 0usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing = HashMap::<String, Vec<String>>::new();
    for edge in workflow["edges"].as_array().into_iter().flatten() {
        let (Some(from), Some(to)) = (edge["from"].as_str(), edge["to"].as_str()) else {
            continue;
        };
        if reachable.contains(from) && reachable.contains(to) {
            outgoing
                .entry(from.to_owned())
                .or_default()
                .push(to.to_owned());
            *indegree.entry(to.to_owned()).or_default() += 1;
        }
    }
    let mut queue = planned
        .iter()
        .filter(|id| indegree[*id] == 0)
        .cloned()
        .collect::<VecDeque<_>>();
    let mut result = Vec::new();
    while let Some(id) = queue.pop_front() {
        result.push(id.clone());
        for target in outgoing.get(&id).into_iter().flatten() {
            let count = indegree.get_mut(target).expect("known target");
            *count -= 1;
            if *count == 0 {
                queue.push_back(target.clone());
            }
        }
    }
    for id in planned {
        if !result.contains(&id) {
            result.push(id);
        }
    }
    result
}

fn node_is_active(
    node_id: &str,
    edges: &[Value],
    selected: &HashSet<String>,
    source_handles: &HashMap<String, Option<String>>,
    skipped: &HashSet<String>,
) -> bool {
    let incoming = edges
        .iter()
        .filter(|edge| edge["to"] == node_id)
        .filter(|edge| {
            edge["from"]
                .as_str()
                .is_some_and(|source| selected.contains(source))
        })
        .collect::<Vec<_>>();
    if incoming.is_empty() {
        return true;
    }
    incoming.into_iter().any(|edge| {
        let Some(source) = edge["from"].as_str() else {
            return false;
        };
        if skipped.contains(source) || !source_handles.contains_key(source) {
            return false;
        }
        let expected = edge["sourceHandle"].as_str();
        let actual = source_handles.get(source).and_then(Option::as_deref);
        expected.is_none() || actual.is_none() || expected == actual
    })
}

fn reset_node(node: &mut Value) {
    node["status"] = Value::String("idle".into());
    for key in ["summary", "rawOutput", "error", "startedAt", "completedAt"] {
        node.as_object_mut()
            .expect("workflow node object")
            .remove(key);
    }
    if let Some(config) = node["config"].as_object_mut() {
        config.remove("runDetails");
        config.remove("waitingForInput");
        config.remove("waitingForApproval");
    }
}

fn node_index(workflow: &Value, node_id: &str) -> Option<usize> {
    workflow["nodes"]
        .as_array()?
        .iter()
        .position(|node| node["id"] == node_id)
}

fn find_run<'a>(workflow: &'a Value, run_id: &str) -> Option<&'a Value> {
    workflow["runs"]
        .as_array()?
        .iter()
        .find(|run| run["id"] == run_id)
}

fn find_run_mut<'a>(workflow: &'a mut Value, run_id: &str) -> Option<&'a mut Value> {
    workflow["runs"]
        .as_array_mut()?
        .iter_mut()
        .find(|run| run["id"] == run_id)
}

fn push_trace(workflow: &mut Value, run_id: &str, node: &Value, started_at: u64) {
    if let Some(run) = find_run_mut(workflow, run_id) {
        if !run["trace"].is_array() {
            run["trace"] = Value::Array(Vec::new());
        }
        let trace = run["trace"].as_array_mut().expect("trace initialized");
        trace.push(serde_json::json!({
            "nodeId":node["id"],"title":node["title"],"kind":node["kind"],
            "model":node["model"],"status":"running","startedAt":started_at
        }));
    }
}

fn complete_trace(
    workflow: &mut Value,
    run_id: &str,
    node_id: &str,
    status: &str,
    completed_at: u64,
    output: Option<Value>,
    error: Option<String>,
) {
    let Some(run) = find_run_mut(workflow, run_id) else {
        return;
    };
    let Some(trace) = run["trace"].as_array_mut().and_then(|items| {
        items
            .iter_mut()
            .rev()
            .find(|item| item["nodeId"] == node_id)
    }) else {
        return;
    };
    trace["status"] = Value::String(status.into());
    trace["completedAt"] = Value::from(completed_at);
    trace["durationMs"] = Value::from(
        completed_at.saturating_sub(trace["startedAt"].as_u64().unwrap_or(completed_at)),
    );
    if let Some(output) = output {
        if let Some(usage) = output.get("usage") {
            if let Some(model) = usage["model"].as_str().filter(|value| !value.is_empty()) {
                trace["model"] = Value::String(model.to_owned());
            }
            let input = usage_number_value(usage, &["input", "inputTokens", "input_tokens"]);
            let output_tokens =
                usage_number_value(usage, &["output", "outputTokens", "output_tokens"]);
            let cache_read = usage_number_value(
                usage,
                &[
                    "cacheRead",
                    "cache_read_input_tokens",
                    "cached_input_tokens",
                ],
            );
            let cache_write = usage_number_value(
                usage,
                &[
                    "cacheWrite",
                    "cache_creation_input_tokens",
                    "cache_write_tokens",
                ],
            );
            trace["tokens"] = serde_json::json!({"input":input,"output":output_tokens,"cacheRead":cache_read,"cacheWrite":cache_write,"total":input + output_tokens});
            if let Some(cost) = usage["cost"].as_f64() {
                trace["cost"] = Value::from(cost);
            }
            if let Some(multiplier) = usage["billingMultiplier"].as_f64() {
                trace["billingMultiplier"] = Value::from(multiplier);
            }
        }
        if let Some(provider_id) = output["providerId"]
            .as_str()
            .filter(|value| !value.is_empty())
        {
            trace["providerId"] = Value::String(provider_id.to_owned());
        }
        trace["output"] = output;
    }
    if let Some(error) = error {
        trace["error"] = Value::String(error);
    }
}

fn usage_number_value(value: &Value, keys: &[&str]) -> f64 {
    keys.iter()
        .find_map(|key| value.get(*key).and_then(Value::as_f64))
        .unwrap_or(0.0)
}

fn running_details(node: &Value, started_at: u64) -> Value {
    let kind = node["kind"].as_str().unwrap_or("agent");
    let command_line = if kind == "command" {
        node["prompt"].as_str().unwrap_or("").to_owned()
    } else if node["providerKind"].as_str() == Some("codex-cli") {
        let approval = node["config"]["codexApproval"]
            .as_str()
            .unwrap_or("on-request");
        let sandbox = node["config"]["codexSandbox"]
            .as_str()
            .unwrap_or("workspace-write");
        let mut value = format!("codex --ask-for-approval {approval} --sandbox {sandbox}");
        if let Some(model) = node["model"]
            .as_str()
            .filter(|v| !v.is_empty() && *v != "default")
        {
            value.push_str(&format!(" --model {model}"));
        }
        value
    } else {
        let permission = if node["mode"].as_str() == Some("plan")
            || node["config"]["mode"].as_str() == Some("plan")
        {
            "plan"
        } else {
            node["config"]["claudePermissionMode"]
                .as_str()
                .unwrap_or("acceptEdits")
        };
        let mut value = format!("claude --permission-mode {permission}");
        if let Some(model) = node["model"]
            .as_str()
            .filter(|v| !v.is_empty() && *v != "default")
        {
            value.push_str(&format!(" --model {model}"));
        }
        value
    };
    serde_json::json!({
        "kind":if kind == "command" {"command"} else {"agent"},
        "title":node["title"].as_str().unwrap_or("Run"),
        "status":"running","startedAt":started_at,"commandLine":command_line,
        "stdout":"","stderr":"","transcript":"",
        "autoSuccess":node["config"]["autoSuccess"].as_bool().unwrap_or(true)
    })
}

fn finish_details(
    node: &mut Value,
    status: &str,
    completed_at: u64,
    output: Option<&Value>,
    error: Option<&str>,
) {
    if !matches!(
        node["kind"].as_str().unwrap_or("agent"),
        "agent" | "command"
    ) {
        return;
    }
    let is_agent = node["kind"].as_str() == Some("agent");
    if !node["config"]["runDetails"].is_object() {
        let fallback = running_details(node, node["startedAt"].as_u64().unwrap_or(completed_at));
        node["config"]["runDetails"] = fallback;
    }
    let details = &mut node["config"]["runDetails"];
    details["status"] = Value::String(status.to_owned());
    details["completedAt"] = Value::from(completed_at);
    details["durationMs"] = Value::from(
        completed_at.saturating_sub(details["startedAt"].as_u64().unwrap_or(completed_at)),
    );
    details["terminalStatus"] = Value::String(status.to_owned());
    if let Some(output) = output {
        details["stdout"] = Value::String(output["stdout"].as_str().unwrap_or("").to_owned());
        details["stderr"] = Value::String(output["stderr"].as_str().unwrap_or("").to_owned());
        details["transcript"] = Value::String(
            output["transcript"]
                .as_str()
                .or_else(|| output["text"].as_str())
                .unwrap_or_else(|| output["stdout"].as_str().unwrap_or(""))
                .to_owned(),
        );
        details["exitCode"] = output.get("exitCode").cloned().unwrap_or(Value::Null);
        if let Some(session_id) = output["conversationSessionId"].as_str() {
            details["conversationSessionId"] = Value::String(session_id.to_owned());
        }
        if let Some(usage) = output.get("usage") {
            details["usage"] = usage.clone();
        }
        for field in [
            "retryAttempts",
            "retryStrategy",
            "retryProviderIds",
            "retryReasons",
            "retryTranscript",
            "providerId",
        ] {
            if let Some(value) = output.get(field) {
                details[field] = value.clone();
            }
        }
    }
    if let Some(error) = error {
        let existing_stderr = details["stderr"].as_str().unwrap_or("");
        details["stderr"] = Value::String(if existing_stderr.is_empty() {
            error.to_owned()
        } else {
            format!("{existing_stderr}\n{error}")
        });
        if is_agent {
            details["stdout"] = Value::String(String::new());
            details["transcript"] = Value::String(error.to_owned());
        } else if details["transcript"]
            .as_str()
            .unwrap_or("")
            .trim()
            .is_empty()
        {
            details["transcript"] = Value::String(error.to_owned());
        }
        details["exitCode"] = Value::from(1);
    }
}

fn source_handle(node: &Value, output: &Value) -> Option<String> {
    match node["kind"].as_str().unwrap_or("agent") {
        "if" => Some(if output["result"].as_bool().unwrap_or(false) {
            "true".into()
        } else {
            "false".into()
        }),
        "diff-approval" => Some(if output["value"].as_bool().unwrap_or(false) {
            "success".into()
        } else {
            "failure".into()
        }),
        "markdown" if node["config"]["action"].as_str() == Some("approval") => {
            Some(if output["value"].as_bool().unwrap_or(false) {
                "success".into()
            } else {
                "failure".into()
            })
        }
        _ => None,
    }
}

fn if_expression(node: &Value) -> String {
    if let Some(expression) = node["config"]["expression"].as_str() {
        return expression.to_owned();
    }
    let left = node["config"]["left"].as_str().unwrap_or("");
    let right = node["config"]["right"].as_str().unwrap_or("");
    match node["config"]["operator"].as_str().unwrap_or("equals") {
        "notEquals" => format!("{left} != {right}"),
        "greaterThan" => format!("{left} > {right}"),
        "lessThan" => format!("{left} < {right}"),
        "exists" => format!("{left} != null"),
        "isEmpty" => format!("{left} == \"\""),
        _ => format!("{left} == {right}"),
    }
}

fn resolve_template_value(template: &str, workflow: &Value) -> Result<Value, String> {
    let expression = template
        .trim()
        .strip_prefix("{{")
        .and_then(|value| value.strip_suffix("}}"))
        .ok_or_else(|| format!("Invalid workflow variable: {template}"))?
        .trim();
    if let Some(rest) = expression.strip_prefix("vars[") {
        return resolve_workflow_variable(rest, template, workflow);
    }
    let Some(rest) = expression.strip_prefix("blocks[") else {
        return Err(format!("Unsupported workflow variable: {template}"));
    };
    let end = rest
        .find(']')
        .ok_or_else(|| format!("Invalid workflow variable: {template}"))?;
    let block_id = rest[..end]
        .trim()
        .parse::<u64>()
        .map_err(|_| format!("Invalid workflow block id: {template}"))?;
    let node = workflow["nodes"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|node| node["blockId"].as_u64() == Some(block_id))
        .ok_or_else(|| format!("Workflow block {block_id} does not exist."))?;
    let mut value = node["rawOutput"]
        .as_str()
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_else(|| Value::String(node["summary"].as_str().unwrap_or("").to_owned()));
    let mut path = rest[end + 1..].trim();
    while !path.is_empty() {
        let key;
        if let Some(next) = path.strip_prefix('.') {
            let end = next.find(['.', '[']).unwrap_or(next.len());
            key = &next[..end];
            path = &next[end..];
        } else if let Some(next) = path.strip_prefix('[') {
            let end = next
                .find(']')
                .ok_or_else(|| format!("Invalid workflow path: {template}"))?;
            key = next[..end].trim_matches(['\'', '"']).trim();
            path = &next[end + 1..];
        } else {
            return Err(format!("Invalid workflow path: {template}"));
        }
        value = match &value {
            Value::Object(object) => object.get(key).cloned(),
            Value::Array(array) => key
                .parse::<usize>()
                .ok()
                .and_then(|index| array.get(index).cloned()),
            _ => None,
        }
        .ok_or_else(|| format!("Workflow variable does not exist: {template}"))?;
    }
    Ok(value)
}

fn resolve_workflow_variable(
    rest: &str,
    template: &str,
    workflow: &Value,
) -> Result<Value, String> {
    let end = rest
        .find(']')
        .ok_or_else(|| format!("Invalid workflow variable: {template}"))?;
    let name = rest[..end].trim().trim_matches(['\'', '"']);
    if name.is_empty() {
        return Err(format!("Invalid workflow variable: {template}"));
    }
    let mut found = None;
    for node in workflow["nodes"].as_array().into_iter().flatten() {
        if node["kind"] != "variable" {
            continue;
        }
        let Some(output) = parsed_node_output(node) else {
            continue;
        };
        if let Some(value) = output["variables"].get(name) {
            found = Some(value.clone());
        } else if output["name"] == name {
            found = output.get("value").cloned();
        }
    }
    let mut value = found.ok_or_else(|| format!("Workflow variable does not exist: {template}"))?;
    apply_value_path(&mut value, &rest[end + 1..], template)?;
    Ok(value)
}

fn apply_value_path(value: &mut Value, mut path: &str, template: &str) -> Result<(), String> {
    while !path.is_empty() {
        let key;
        if let Some(next) = path.strip_prefix('.') {
            let end = next.find(['.', '[']).unwrap_or(next.len());
            key = &next[..end];
            path = &next[end..];
        } else if let Some(next) = path.strip_prefix('[') {
            let end = next
                .find(']')
                .ok_or_else(|| format!("Invalid workflow path: {template}"))?;
            key = next[..end].trim_matches(['\'', '"']).trim();
            path = &next[end + 1..];
        } else {
            return Err(format!("Invalid workflow path: {template}"));
        }
        *value = match value {
            Value::Object(object) => object.get(key).cloned(),
            Value::Array(array) => key
                .parse::<usize>()
                .ok()
                .and_then(|index| array.get(index).cloned()),
            _ => None,
        }
        .ok_or_else(|| format!("Workflow variable does not exist: {template}"))?;
    }
    Ok(())
}

fn resolve_templates(input: &str, workflow: &Value) -> Result<String, String> {
    let mut output = String::new();
    let mut offset = 0;
    while let Some(start_offset) = input[offset..].find("{{") {
        let start = offset + start_offset;
        output.push_str(&input[offset..start]);
        let end_offset = input[start + 2..]
            .find("}}")
            .ok_or_else(|| "Unclosed workflow variable.".to_owned())?;
        let end = start + 2 + end_offset + 2;
        let value = resolve_template_value(&input[start..end], workflow)?;
        let rendered = match value {
            Value::Null => String::new(),
            Value::String(value) => value,
            other => other.to_string(),
        };
        output.push_str(&rendered);
        offset = end;
    }
    output.push_str(&input[offset..]);
    Ok(output)
}

fn parsed_node_output(node: &Value) -> Option<Value> {
    node["rawOutput"]
        .as_str()
        .or_else(|| node["summary"].as_str())
        .and_then(|raw| serde_json::from_str(raw).ok())
}

fn incoming_outputs(workflow: &Value, node: &Value) -> Vec<Value> {
    let node_id = node["id"].as_str().unwrap_or_default();
    workflow["edges"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|edge| edge["to"] == node_id)
        .filter_map(|edge| edge["from"].as_str())
        .filter_map(|source_id| {
            workflow["nodes"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|item| item["id"] == source_id)
        })
        .filter_map(parsed_node_output)
        .collect()
}

fn node_title(node: &Value) -> &str {
    node["title"].as_str().unwrap_or("Workflow block")
}

fn agent_retry_count(node: &Value) -> usize {
    node["config"]["retries"]
        .as_u64()
        .or_else(|| {
            node["config"]["retries"]
                .as_f64()
                .map(|v| v.max(0.0) as u64)
        })
        .or_else(|| {
            node["config"]["retries"]
                .as_str()
                .and_then(|v| v.parse::<f64>().ok())
                .map(|v| v.max(0.0) as u64)
        })
        .unwrap_or(0)
        .min(100) as usize
}

fn agent_retry_forever(node: &Value) -> bool {
    match &node["config"]["retryForever"] {
        Value::Bool(value) => *value,
        Value::String(value) => matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "true" | "1" | "yes"
        ),
        _ => false,
    }
}

fn agent_retry_delay_millis(node: &Value) -> u64 {
    let value = node["config"]["retryDelaySeconds"]
        .as_f64()
        .or_else(|| {
            node["config"]["retryDelaySeconds"]
                .as_str()
                .and_then(|v| v.parse().ok())
        })
        .unwrap_or(0.0);
    if value.is_finite() {
        (value.clamp(0.0, 86_400.0) * 1000.0).round() as u64
    } else {
        0
    }
}

fn agent_retry_prompt(node: &Value) -> &'static str {
    let language = node["config"]["retryLanguage"].as_str().unwrap_or("");
    if language.eq_ignore_ascii_case("en") || language.eq_ignore_ascii_case("english") {
        "continue"
    } else {
        "继续"
    }
}

fn agent_retry_strategy(node: &Value) -> &str {
    let value = node["config"]["retryStrategy"].as_str().unwrap_or("none");
    if matches!(value, "round-robin" | "lowest-multiplier") {
        value
    } else {
        "none"
    }
}

fn agent_retry_provider_ids(node: &Value) -> Vec<String> {
    let mut seen = HashSet::new();
    node["config"]["retryProviderIds"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|id| !id.is_empty())
        .filter(|id| seen.insert((*id).to_owned()))
        .map(str::to_owned)
        .collect()
}

fn should_retry_agent_failure(
    message: &str,
    attempt: usize,
    retries: usize,
    retry_forever: bool,
) -> bool {
    if !retry_forever && attempt >= retries {
        return false;
    }
    let normalized = message.trim().to_ascii_lowercase();
    if normalized.is_empty()
        || normalized.contains("workflow stopped")
        || normalized.contains("cancel")
        || normalized.contains("user rejected")
        || normalized.contains("permission denied")
        || normalized.contains("pty event stream closed")
    {
        return false;
    }
    // Provider rotation is applied after every retryable terminal error.
    true
}

async fn set_retry_details(
    workflow_path: &Path,
    node_id: &str,
    delay_seconds: u64,
    attempt: usize,
    reason: &str,
) {
    let Ok(mut workflow) = read_json(workflow_path).await else {
        return;
    };
    let Some(index) = node_index(&workflow, node_id) else {
        return;
    };
    let node = &mut workflow["nodes"][index];
    if !node["config"]["runDetails"].is_object() {
        let started_at = node["startedAt"].as_u64().unwrap_or_else(now_ms);
        node["config"]["runDetails"] = running_details(node, started_at);
    }
    let details = &mut node["config"]["runDetails"];
    details["status"] = Value::String("running".into());
    details["terminalStatus"] = Value::String("running".into());
    details["retryAt"] = Value::from(now_ms().saturating_add(delay_seconds));
    details["retryAttempt"] = Value::from(attempt as u64);
    details["retryReason"] = Value::String(reason.to_owned());
    workflow["updatedAt"] = Value::from(now_ms());
    let _ = write_json(workflow_path, &workflow).await;
}

async fn clear_retry_details(workflow_path: &Path, node_id: &str) {
    let Ok(mut workflow) = read_json(workflow_path).await else {
        return;
    };
    let Some(index) = node_index(&workflow, node_id) else {
        return;
    };
    if let Some(details) = workflow["nodes"][index]["config"]["runDetails"].as_object_mut() {
        for field in ["retryAt", "retryAttempt", "retryReason"] {
            details.remove(field);
        }
    }
    workflow["updatedAt"] = Value::from(now_ms());
    let _ = write_json(workflow_path, &workflow).await;
}

async fn read_agent_conversation_id(workflow_path: &Path, node_id: &str) -> Option<String> {
    let workflow = read_json(workflow_path).await.ok()?;
    let index = node_index(&workflow, node_id)?;
    workflow["nodes"][index]["config"]["runDetails"]["conversationSessionId"]
        .as_str()
        .filter(|id| !id.trim().is_empty())
        .map(str::to_owned)
}

async fn persist_retry_reasons(workflow_path: &Path, node_id: &str, reasons: &[String]) {
    let Ok(mut workflow) = read_json(workflow_path).await else {
        return;
    };
    let Some(index) = node_index(&workflow, node_id) else {
        return;
    };
    if !workflow["nodes"][index]["config"]["runDetails"].is_object() {
        let started_at = workflow["nodes"][index]["startedAt"]
            .as_u64()
            .unwrap_or_else(now_ms);
        workflow["nodes"][index]["config"]["runDetails"] =
            running_details(&workflow["nodes"][index], started_at);
    }
    workflow["nodes"][index]["config"]["runDetails"]["retryReasons"] =
        Value::Array(reasons.iter().cloned().map(Value::String).collect());
    workflow["nodes"][index]["config"]["runDetails"]["retryTranscript"] =
        Value::String(reasons.join("\n\n"));
    let _ = write_json(workflow_path, &workflow).await;
}

async fn load_agent_provider_plan(
    data_root: &Path,
    node: &Value,
    strategy: &str,
    configured_ids: &[String],
) -> Vec<String> {
    let app = if node["providerKind"].as_str() == Some("codex-cli") {
        "codex"
    } else {
        "claude"
    };
    let settings_path = std::env::var_os("OSHEEP_AI_SETTINGS_STORE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("ai-settings.json"));
    let Ok(raw) = tokio::fs::read(&settings_path).await else {
        return Vec::new();
    };
    let Ok(settings) = serde_json::from_slice::<Value>(&raw) else {
        return Vec::new();
    };
    let manager = &settings["apps"][app];
    let providers = manager["providers"].as_object();
    let current = manager["current"].as_str().unwrap_or("");
    if strategy == "none" {
        return (!current.is_empty())
            .then(|| vec![current.to_owned()])
            .unwrap_or_default();
    }
    let mut ids = configured_ids
        .iter()
        .filter(|id| providers.is_some_and(|items| items.contains_key(id.as_str())))
        .cloned()
        .collect::<Vec<_>>();
    if ids.is_empty() {
        return (!current.is_empty())
            .then(|| vec![current.to_owned()])
            .unwrap_or_default();
    }
    if strategy == "lowest-multiplier" {
        ids.sort_by(|a, b| {
            let provider = |id: &str| providers.and_then(|items| items.get(id));
            let multiplier = |id: &str| {
                provider(id)
                    .and_then(|item| item["billingMultiplier"].as_f64())
                    .filter(|value| value.is_finite() && *value > 0.0)
                    .unwrap_or(1.0)
            };
            multiplier(a)
                .partial_cmp(&multiplier(b))
                .unwrap_or(std::cmp::Ordering::Equal)
                .then_with(|| {
                    provider(a)
                        .and_then(|item| item["sortIndex"].as_i64())
                        .unwrap_or(0)
                        .cmp(
                            &provider(b)
                                .and_then(|item| item["sortIndex"].as_i64())
                                .unwrap_or(0),
                        )
                })
                .then_with(|| a.cmp(b))
        });
    }
    ids
}

async fn load_current_agent_provider(data_root: &Path, node: &Value) -> Option<String> {
    let app = if node["providerKind"].as_str() == Some("codex-cli") {
        "codex"
    } else {
        "claude"
    };
    let settings_path = std::env::var_os("OSHEEP_AI_SETTINGS_STORE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("ai-settings.json"));
    let raw = tokio::fs::read(settings_path).await.ok()?;
    let settings = serde_json::from_slice::<Value>(&raw).ok()?;
    let current = settings["apps"][app]["current"].as_str()?;
    settings["apps"][app]["providers"]
        .get(current)
        .is_some_and(Value::is_object)
        .then(|| current.to_owned())
}

async fn apply_agent_provider(
    data_root: &Path,
    node: &Value,
    provider_id: &str,
) -> Result<(), String> {
    if provider_id.trim().is_empty() {
        return Ok(());
    }
    let settings_path = std::env::var_os("OSHEEP_AI_SETTINGS_STORE_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.join("ai-settings.json"));
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_else(|| data_root.to_path_buf());
    let claude_config_dir = std::env::var_os("OSHEEP_CLAUDE_CONFIG_DIR")
        .or_else(|| std::env::var_os("CLAUDE_CONFIG_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let codex_config_dir = std::env::var_os("CODEX_HOME")
        .or_else(|| std::env::var_os("OSHEEP_CODEX_CONFIG_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    apply_agent_provider_to_paths(
        &settings_path,
        &claude_config_dir,
        &codex_config_dir,
        node,
        provider_id,
    )
    .await
}

async fn apply_agent_provider_to_paths(
    settings_path: &Path,
    claude_config_dir: &Path,
    codex_config_dir: &Path,
    node: &Value,
    provider_id: &str,
) -> Result<(), String> {
    if provider_id.trim().is_empty() {
        return Ok(());
    }
    let app = if node["providerKind"].as_str() == Some("codex-cli") {
        "codex"
    } else {
        "claude"
    };
    let raw = tokio::fs::read(&settings_path)
        .await
        .map_err(|error| format!("Failed to read AI provider settings: {error}"))?;
    let mut settings = serde_json::from_slice::<Value>(&raw)
        .map_err(|error| format!("Failed to parse AI provider settings: {error}"))?;
    let provider = &settings["apps"][app]["providers"][provider_id];
    if !provider.is_object() {
        return Err(format!("AI provider not found: {provider_id}"));
    }
    if app == "claude" {
        let path = claude_config_dir.join("settings.json");
        let mut config = provider["settingsConfig"]
            .clone()
            .as_object()
            .cloned()
            .ok_or_else(|| format!("Claude provider has invalid settings: {provider_id}"))?;
        config.remove("api_format");
        config.remove("apiFormat");
        config.remove("openrouter_compat_mode");
        config.remove("openrouterCompatMode");
        if let Some(parent) = path.parent() {
            tokio::fs::create_dir_all(parent)
                .await
                .map_err(|error| format!("Failed to create Claude config directory: {error}"))?;
        }
        let bytes = serde_json::to_vec_pretty(&Value::Object(config))
            .map_err(|error| format!("Failed to encode Claude settings: {error}"))?;
        tokio::fs::write(path, bytes)
            .await
            .map_err(|error| format!("Failed to apply Claude provider: {error}"))?;
    } else {
        let config = &provider["settingsConfig"];
        let auth = config["auth"].clone();
        let toml = config["config"].as_str().unwrap_or("");
        let root = codex_config_dir;
        tokio::fs::create_dir_all(&root)
            .await
            .map_err(|error| format!("Failed to create Codex config directory: {error}"))?;
        let keep_existing_auth = provider["category"].as_str() == Some("official")
            && !codex_auth_has_login_material(&auth);
        if !keep_existing_auth && auth.is_object() {
            let bytes = serde_json::to_vec_pretty(&auth)
                .map_err(|error| format!("Failed to encode Codex auth: {error}"))?;
            tokio::fs::write(root.join("auth.json"), bytes)
                .await
                .map_err(|error| format!("Failed to apply Codex auth: {error}"))?;
        }
        tokio::fs::write(root.join("config.toml"), toml)
            .await
            .map_err(|error| format!("Failed to apply Codex config: {error}"))?;
    }
    // Keep the persisted provider selection in sync with the live files. The
    // TypeScript runner updates both on every retry, so the next attempt and
    // a subsequent run observe the same provider.
    if let Some(manager) = settings["apps"][app].as_object_mut() {
        manager.insert("current".to_owned(), Value::String(provider_id.to_owned()));
    }
    let bytes = serde_json::to_vec_pretty(&settings)
        .map_err(|error| format!("Failed to encode AI provider settings: {error}"))?;
    tokio::fs::write(settings_path, bytes)
        .await
        .map_err(|error| format!("Failed to persist AI provider selection: {error}"))?;
    Ok(())
}

fn codex_auth_has_login_material(auth: &Value) -> bool {
    let Some(auth) = auth.as_object() else {
        return false;
    };
    auth.iter().any(|(key, value)| {
        if key == "auth_mode" || value.is_null() {
            return false;
        }
        match value {
            Value::String(text) => !text.trim().is_empty(),
            Value::Array(values) => !values.is_empty(),
            Value::Object(values) => !values.is_empty(),
            _ => true,
        }
    })
}

fn parse_maybe_json(raw: &str) -> Value {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        Value::String(String::new())
    } else {
        serde_json::from_str(trimmed).unwrap_or_else(|_| Value::String(raw.to_owned()))
    }
}

fn execute_variable(node: &Value, workflow: &Value) -> Result<Value, String> {
    let entries = node["config"]["variables"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            vec![serde_json::json!({
                "name":node["config"]["name"],
                "value":node["config"]["value"],
                "type":"auto"
            })]
        });
    let mut variables = serde_json::Map::new();
    let mut variable_types = serde_json::Map::new();
    for existing in workflow["nodes"].as_array().into_iter().flatten() {
        if existing["kind"] != "variable" || existing["id"] == node["id"] {
            continue;
        }
        if let Some(output) = parsed_node_output(existing) {
            if let Some(values) = output["variables"].as_object() {
                variables.extend(values.clone());
            }
            if let Some(types) = output["variableTypes"].as_object() {
                variable_types.extend(types.clone());
            }
        }
    }
    let mut first = None;
    for entry in entries {
        let name = resolve_templates(entry["name"].as_str().unwrap_or(""), workflow)?;
        let name = name.trim().to_owned();
        if name.is_empty() {
            continue;
        }
        let raw = resolve_templates(entry["value"].as_str().unwrap_or(""), workflow)?;
        let value_type = entry["type"].as_str().unwrap_or("auto");
        let value = match value_type {
            "text" => Value::String(raw),
            "json" => serde_json::from_str(&raw).map_err(|error| {
                format!(
                    "{} variable {name} has invalid JSON: {error}",
                    node_title(node)
                )
            })?,
            "number" => serde_json::Number::from_f64(raw.trim().parse::<f64>().map_err(|_| {
                format!(
                    "{} variable {name} must be a finite number.",
                    node_title(node)
                )
            })?)
            .map(Value::Number)
            .ok_or_else(|| {
                format!(
                    "{} variable {name} must be a finite number.",
                    node_title(node)
                )
            })?,
            "boolean" => match raw.trim().to_ascii_lowercase().as_str() {
                "true" => Value::Bool(true),
                "false" => Value::Bool(false),
                _ => {
                    return Err(format!(
                        "{} variable {name} must be true or false.",
                        node_title(node)
                    ))
                }
            },
            _ => parse_maybe_json(&raw),
        };
        if first.is_none() {
            first = Some((name.clone(), value.clone()));
        }
        variables.insert(name.clone(), value);
        variable_types.insert(name, Value::String(value_type.to_owned()));
    }
    let Some((name, value)) = first else {
        return Err(format!("{} has no variable name.", node_title(node)));
    };
    let data = Value::Object(variables.clone());
    Ok(serde_json::json!({
        "type":"variable","status":"success","name":name,"value":value,
        "variables":variables,"variableTypes":variable_types,"data":data,
        "text":output_text(&data)
    }))
}

fn execute_merge(node: &Value, workflow: &Value) -> Result<Value, String> {
    let items = incoming_outputs(workflow, node);
    let mode = resolve_templates(
        node["config"]["mode"].as_str().unwrap_or("object"),
        workflow,
    )?;
    let data = if mode == "array" {
        Value::Array(
            items
                .iter()
                .map(|item| item.get("data").cloned().unwrap_or_else(|| item.clone()))
                .collect(),
        )
    } else {
        let mut merged = serde_json::Map::new();
        for item in &items {
            let value = item.get("data").unwrap_or(item);
            if let Some(object) = value.as_object() {
                merged.extend(object.clone());
            }
        }
        Value::Object(merged)
    };
    Ok(serde_json::json!({
        "type":"merge","status":"success","mode":mode,"data":data,
        "items":items,"text":output_text(&data)
    }))
}

fn execute_loop_items(node: &Value, workflow: &Value) -> Result<Value, String> {
    let incoming = incoming_outputs(workflow, node);
    let source = if let Some(source) = node["config"]["source"]
        .as_str()
        .filter(|source| !source.trim().is_empty())
    {
        let rendered = resolve_templates(source, workflow)?;
        parse_maybe_json(&rendered)
    } else {
        incoming
            .first()
            .map(|value| value.get("data").cloned().unwrap_or_else(|| value.clone()))
            .unwrap_or(Value::Null)
    };
    let items = match source {
        Value::Array(items) => items,
        Value::Null => Vec::new(),
        value => vec![value],
    };
    let batch_size = match &node["config"]["batchSize"] {
        Value::String(value) => resolve_templates(value, workflow)?
            .parse::<usize>()
            .unwrap_or(1),
        value => value.as_u64().unwrap_or(1) as usize,
    }
    .clamp(1, 1000);
    let batches = items
        .chunks(batch_size)
        .map(|batch| Value::Array(batch.to_vec()))
        .collect::<Vec<_>>();
    let mode = resolve_templates(node["config"]["mode"].as_str().unwrap_or("items"), workflow)?;
    let data = if mode == "batches" {
        Value::Array(batches.clone())
    } else {
        Value::Array(items.clone())
    };
    Ok(serde_json::json!({
        "type":"loop-items","status":"success","mode":mode,"batchSize":batch_size,
        "items":items,"batches":batches,"data":data,"count":items.len(),"text":output_text(&data)
    }))
}

fn execute_json(node: &Value, workflow: &Value) -> Result<Value, String> {
    let incoming = incoming_outputs(workflow, node);
    let source = if let Some(source) = node["config"]["source"]
        .as_str()
        .filter(|source| !source.trim().is_empty())
    {
        parse_maybe_json(&resolve_templates(source, workflow)?)
    } else {
        incoming
            .first()
            .cloned()
            .unwrap_or(Value::String(String::new()))
    };
    let path = resolve_templates(node["config"]["path"].as_str().unwrap_or(""), workflow)?;
    let mut value = source.clone();
    if !path.trim().is_empty() {
        let normalized = if path.starts_with(['.', '[']) {
            path.clone()
        } else {
            format!(".{path}")
        };
        apply_value_path(&mut value, &normalized, &path)?;
    }
    Ok(serde_json::json!({
        "type":"json","status":"success","path":path,"source":source,
        "value":value,"data":value,"text":output_text(&value)
    }))
}

async fn run_code_block(
    workspace_root: &Path,
    workflow: &Value,
    node: &Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    const SCRIPT: &str = "let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>b+=c);process.stdin.on('end',async()=>{try{const p=JSON.parse(b);const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;const helpers={jsonPreview:v=>JSON.stringify(v,null,2),textFromAny:v=>typeof v==='string'?v:JSON.stringify(v,null,2)};const v=await new AsyncFunction('input','items','helpers',`\\\"use strict\\\";\\n${p.code}`)(p.input,p.items,helpers);process.stdout.write(JSON.stringify(v===undefined?null:v))}catch(e){console.error(e&&e.stack||String(e));process.exit(1)}})";
    let items = incoming_outputs(workflow, node);
    let mut code = node["config"]["code"]
        .as_str()
        .unwrap_or("return { text: input.text || input.content || input.stdout || '', input };")
        .to_owned();
    let mut offset = 0;
    while let Some(relative) = code[offset..].find("{{") {
        let start = offset + relative;
        let end = code[start + 2..]
            .find("}}")
            .map(|end| start + 2 + end + 2)
            .ok_or_else(|| "Unclosed workflow variable.".to_owned())?;
        let replacement =
            serde_json::to_string(&resolve_template_value(&code[start..end], workflow)?)
                .map_err(|error| error.to_string())?;
        code.replace_range(start..end, &replacement);
        offset = start + replacement.len();
    }
    let payload = serde_json::json!({
        "code":code,"input":items.first().cloned().unwrap_or_else(|| serde_json::json!({})),
        "items":items
    });
    let process = run_program(
        workspace_root,
        "node",
        &["-e", SCRIPT],
        Some(&payload.to_string()),
        cancelled,
    )
    .await?;
    let value: Value = serde_json::from_str(process["stdout"].as_str().unwrap_or("null"))
        .map_err(|error| format!("Code block returned invalid JSON: {error}"))?;
    let mut result = value.as_object().cloned().unwrap_or_default();
    result
        .entry("type")
        .or_insert_with(|| Value::String("code".into()));
    result
        .entry("status")
        .or_insert_with(|| Value::String("success".into()));
    result.entry("data").or_insert_with(|| value.clone());
    result
        .entry("text")
        .or_insert_with(|| Value::String(output_text(&value)));
    Ok(Value::Object(result))
}

async fn run_agent_process(
    workspace_root: &Path,
    workflow: &Value,
    node: &Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let prompt = resolve_templates(node["prompt"].as_str().unwrap_or(""), workflow)?;
    let prompt = prompt.trim();
    if prompt.is_empty() {
        return Err(format!(
            "{} has no prompt.",
            node["title"].as_str().unwrap_or("Agent")
        ));
    }
    let provider = node["providerKind"].as_str().unwrap_or("claude-cli");
    let model = node["model"]
        .as_str()
        .filter(|model| !model.is_empty() && *model != "default");
    if provider == "codex-cli" {
        let sandbox = node["config"]["codexSandbox"]
            .as_str()
            .unwrap_or("workspace-write");
        let mut args = vec!["exec", "--skip-git-repo-check", "--sandbox", sandbox];
        if let Some(model) = model {
            args.extend(["--model", model]);
        }
        args.push("-");
        run_program(workspace_root, "codex", &args, Some(prompt), cancelled).await
    } else {
        let permission = node["config"]["claudePermissionMode"]
            .as_str()
            .unwrap_or("acceptEdits");
        let mut args = vec![
            "-p",
            "--output-format",
            "text",
            "--permission-mode",
            permission,
        ];
        if let Some(model) = model {
            args.extend(["--model", model]);
        }
        run_program(workspace_root, "claude", &args, Some(prompt), cancelled).await
    }
}

fn build_workflow_agent_invocation(
    provider: &str,
    node: &Value,
    prompt: &str,
) -> Result<(PathBuf, Vec<String>), String> {
    let mut args = Vec::<String>::new();
    let mut codex_resume_id = None;
    let executable = if provider == "codex-cli" {
        if cfg!(windows) {
            if let Some(shim) = find_executable("codex") {
                if let Some(parent) = shim.parent() {
                    let script = parent
                        .join("node_modules")
                        .join("@openai")
                        .join("codex")
                        .join("bin")
                        .join("codex.js");
                    if script.is_file() {
                        args.push(script.to_string_lossy().into_owned());
                        find_executable("node").unwrap_or_else(|| PathBuf::from("node.exe"))
                    } else {
                        find_executable("codex").unwrap_or_else(|| PathBuf::from("codex"))
                    }
                } else {
                    find_executable("codex").unwrap_or_else(|| PathBuf::from("codex"))
                }
            } else {
                find_executable("codex").unwrap_or_else(|| PathBuf::from("codex"))
            }
        } else {
            find_executable("codex").unwrap_or_else(|| PathBuf::from("codex"))
        }
    } else {
        find_executable("claude").unwrap_or_else(|| PathBuf::from("claude"))
    };
    if provider == "codex-cli" {
        if node["config"]["resumeConversation"]
            .as_bool()
            .unwrap_or(false)
        {
            if let Some(session_id) = node["config"]["conversationSessionId"]
                .as_str()
                .filter(|value| !value.is_empty())
            {
                args.push("resume".to_owned());
                codex_resume_id = Some(session_id.to_owned());
            }
        }
        args.push("--ask-for-approval".to_owned());
        args.push(
            node["config"]["codexApproval"]
                .as_str()
                .unwrap_or("on-request")
                .to_owned(),
        );
        args.push("--sandbox".to_owned());
        args.push(
            node["config"]["codexSandbox"]
                .as_str()
                .unwrap_or("workspace-write")
                .to_owned(),
        );
        if node["mode"].as_str() == Some("goal") {
            args.extend(["--enable".to_owned(), "goals".to_owned()]);
        }
        if let Some(effort) = node["config"]["effort"]
            .as_str()
            .filter(|value| !value.is_empty() && *value != "off")
        {
            args.extend([
                "-c".to_owned(),
                format!("model_reasoning_effort=\"{effort}\""),
            ]);
        }
    } else {
        let permission = if node["mode"].as_str() == Some("plan")
            || node["config"]["mode"].as_str() == Some("plan")
        {
            "plan"
        } else {
            node["config"]["claudePermissionMode"]
                .as_str()
                .unwrap_or("acceptEdits")
        };
        args.push("--permission-mode".to_owned());
        args.push(permission.to_owned());
        if let Some(session_id) = node["config"]["sessionId"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
        {
            let resume = node["config"]["resumeConversation"]
                .as_bool()
                .unwrap_or(false);
            args.push(if resume { "--resume" } else { "--session-id" }.to_owned());
            args.push(session_id.to_owned());
        }
    }
    if let Some(model) = node["model"]
        .as_str()
        .filter(|v| !v.is_empty() && *v != "default")
    {
        args.extend(["--model".to_owned(), model.to_owned()]);
    }
    if let Some(session_id) = codex_resume_id {
        args.push(session_id);
    }
    args.push(prompt.to_owned());
    Ok((executable, args))
}

fn agent_session_waiting_for_choice(app: AgentSessionApp, value: &Value) -> bool {
    if app == AgentSessionApp::Claude {
        if value["type"].as_str() != Some("assistant") {
            return false;
        }
        return value["message"]["content"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|item| {
                item["type"].as_str() == Some("tool_use")
                    && item["name"].as_str() == Some("AskUserQuestion")
            });
    }
    let payload = value.get("payload").unwrap_or(value);
    let kind = payload["type"]
        .as_str()
        .unwrap_or(value["type"].as_str().unwrap_or(""));
    if kind == "item_completed" && payload["item"]["status"].as_str() == Some("declined") {
        return true;
    }
    if matches!(kind, "function_call_output" | "custom_tool_call_output") {
        let output = payload.get("output").unwrap_or(&Value::Null);
        return codex_output_was_approval_denied(output) || codex_output_was_user_aborted(output);
    }
    if kind != "custom_tool_call" {
        return false;
    }
    let name = payload["name"]
        .as_str()
        .or_else(|| value["name"].as_str())
        .unwrap_or("");
    if name != "exec" {
        return false;
    }
    let input = payload.get("input").unwrap_or(&Value::Null);
    codex_requests_escalation(input) || value.get("input").is_some_and(codex_requests_escalation)
}

fn codex_approval_event(pending: &mut HashSet<String>, value: &Value) -> Option<bool> {
    const REJECTED: &str = "__osheep_rejected_turn";
    let payload = value.get("payload").unwrap_or(value);
    let kind = payload["type"]
        .as_str()
        .unwrap_or(value["type"].as_str().unwrap_or(""));
    let call_id = payload["call_id"]
        .as_str()
        .or_else(|| value["call_id"].as_str())
        .unwrap_or("");

    if matches!(kind, "task_started" | "turn_started") {
        pending.clear();
        return Some(false);
    }
    if matches!(kind, "function_call" | "custom_tool_call") && !call_id.is_empty() {
        let name = payload["name"]
            .as_str()
            .or_else(|| value["name"].as_str())
            .unwrap_or("");
        if kind == "custom_tool_call"
            && name == "exec"
            && (codex_requests_escalation(&payload["input"])
                || codex_requests_escalation(&value["input"]))
        {
            if pending.insert(call_id.to_owned()) {
                return Some(true);
            }
        }
        return None;
    }
    if kind == "item_completed" && payload["item"]["status"].as_str() == Some("declined") {
        pending.insert(REJECTED.to_owned());
        return Some(true);
    }
    if matches!(kind, "function_call_output" | "custom_tool_call_output") {
        let output = payload.get("output").unwrap_or(&Value::Null);
        let denied = codex_output_was_approval_denied(output)
            || (!call_id.is_empty()
                && pending.contains(call_id)
                && codex_output_was_user_aborted(output));
        if denied {
            pending.remove(call_id);
            pending.insert(REJECTED.to_owned());
            return Some(true);
        }
        if pending.remove(call_id) && pending.is_empty() {
            return Some(false);
        }
    }
    None
}

fn take_complete_jsonl_lines(remainder: &mut String, appended: &str) -> Vec<String> {
    remainder.push_str(appended);
    let Some(last_newline) = remainder.rfind('\n') else {
        return Vec::new();
    };
    let complete = remainder[..=last_newline].to_owned();
    remainder.drain(..=last_newline);
    complete
        .lines()
        .map(|line| line.trim_end_matches('\r').to_owned())
        .collect()
}

fn agent_session_resume_event(app: AgentSessionApp, value: &Value) -> bool {
    if app == AgentSessionApp::Claude {
        if value["type"].as_str() != Some("user") {
            return false;
        }
        let content = &value["message"]["content"];
        if content.as_str().is_some_and(|text| !text.trim().is_empty()) {
            return true;
        }
        return content.as_array().into_iter().flatten().any(|item| {
            if item["type"].as_str() == Some("tool_result") {
                return true;
            }
            item["text"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
        });
    }
    let payload = value.get("payload").unwrap_or(value);
    if matches!(
        payload["type"].as_str(),
        Some("task_started" | "turn_started")
    ) {
        return true;
    }
    if matches!(
        payload["type"].as_str(),
        Some("function_call_output" | "custom_tool_call_output")
    ) {
        let output = payload
            .get("output")
            .unwrap_or(&Value::Null)
            .to_string()
            .to_ascii_lowercase();
        return !codex_output_was_approval_denied(payload.get("output").unwrap_or(&Value::Null))
            && !codex_output_was_user_aborted(payload.get("output").unwrap_or(&Value::Null))
            && !output.contains("code-mode host closed its stdout")
            && !output.contains("aborted by user after")
            && !output.contains("declined")
            && !output.contains("denied");
    }
    false
}

fn codex_requests_escalation(input: &Value) -> bool {
    match input {
        Value::Object(object) => object.iter().any(|(key, value)| {
            (key == "sandbox_permissions" && value.as_str() == Some("require_escalated"))
                || codex_requests_escalation(value)
        }),
        Value::Array(items) => items.iter().any(codex_requests_escalation),
        Value::String(text) => {
            if let Ok(parsed) = serde_json::from_str::<Value>(text) {
                if codex_requests_escalation(&parsed) {
                    return true;
                }
            }
            let normalized = text.replace("\\\"", "\"").replace("\\'", "'");
            let lower = normalized.to_ascii_lowercase();
            lower.contains("sandbox_permissions") && lower.contains("require_escalated")
        }
        _ => false,
    }
}

fn codex_output_was_approval_denied(value: &Value) -> bool {
    match value {
        Value::String(text) => text
            .to_ascii_lowercase()
            .contains("code-mode host closed its stdout"),
        Value::Object(object) => object.values().any(codex_output_was_approval_denied),
        Value::Array(items) => items.iter().any(codex_output_was_approval_denied),
        _ => false,
    }
}

fn codex_output_was_user_aborted(value: &Value) -> bool {
    match value {
        Value::String(text) => text.to_ascii_lowercase().contains("aborted by user after"),
        Value::Object(object) => object.values().any(codex_output_was_user_aborted),
        Value::Array(items) => items.iter().any(codex_output_was_user_aborted),
        _ => false,
    }
}

fn agent_session_completion(app: AgentSessionApp, value: &Value) -> Option<(bool, String)> {
    if app == AgentSessionApp::Claude {
        let kind = value["type"].as_str().unwrap_or("");
        let subtype = value["subtype"].as_str().unwrap_or("");
        let api_error = value["isApiErrorMessage"].as_bool().unwrap_or(false)
            || value["is_api_error_message"].as_bool().unwrap_or(false);
        let result_error = kind == "result"
            && subtype != "success"
            && !subtype.is_empty()
            && (value.get("error").is_some() || value.get("result").is_some());
        if value["is_error"].as_bool().unwrap_or(false) || api_error || result_error {
            return Some((
                false,
                error_message_value(&value["error"])
                    .unwrap_or_else(|| "Claude Code failed.".to_owned()),
            ));
        }
        if (kind == "system" && subtype == "turn_duration")
            || (kind == "result" && subtype == "success")
        {
            return Some((true, String::new()));
        }
        return None;
    }
    let payload = value.get("payload").unwrap_or(value);
    let kind = payload["type"]
        .as_str()
        .unwrap_or(value["type"].as_str().unwrap_or(""));
    if matches!(kind, "task_complete" | "turn_complete" | "turn_completed") {
        if let Some(error) = payload["error"]["message"]
            .as_str()
            .or_else(|| payload["error"].as_str())
            .filter(|message| !message.trim().is_empty())
        {
            return Some((false, error.to_owned()));
        }
        return Some((true, String::new()));
    }
    if kind == "stream_error" {
        let message = codex_event_terminal_message(value)?;
        return codex_terminal_stream_error(&message).then_some((false, message));
    }
    if kind
        .split('_')
        .any(|part| matches!(part, "error" | "failed" | "failure"))
    {
        let message = codex_event_terminal_message(value)?;
        return is_codex_api_error(&message).then_some((false, message));
    }
    None
}

fn codex_event_terminal_message(value: &Value) -> Option<String> {
    let payload = value.get("payload").unwrap_or(value);
    error_message_value(&payload["error"])
        .or_else(|| error_message_value(&value["error"]))
        .or_else(|| error_message_value(&payload["message"]))
        .or_else(|| error_message_value(&value["message"]))
        .or_else(|| error_message_value(&payload["reason"]))
        .or_else(|| error_message_value(&value["reason"]))
}

fn codex_event_error_message(value: &Value) -> Option<String> {
    let payload = value.get("payload").unwrap_or(value);
    error_message_value(&payload["reason"])
        .or_else(|| error_message_value(&payload["error"]))
        .or_else(|| error_message_value(&payload["message"]))
        .or_else(|| error_message_value(&value["reason"]))
        .or_else(|| error_message_value(&value["error"]))
        .or_else(|| error_message_value(&value["message"]))
}

fn is_codex_api_error(message: &str) -> bool {
    static API_ERROR: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(
            r"(?i)\b(?:unexpected status|last status|HTTP(?: status)?|response status|status code|status)\s*(?:code\s*)?[:=]?\s*[1-5]\d{2}\b|\b(?:API Error|API request|api_error|INVALID_API_KEY|API_KEY_DISABLED|rate[_ ]limit|overloaded|service unavailable|fetch failed|network error|connection (?:reset|refused|timed out)|econnreset|econnrefused|etimedout|enotfound|dns|tls)\b",
        )
        .expect("valid Codex API error pattern")
    });
    API_ERROR.is_match(message)
}

fn codex_terminal_stream_error(message: &str) -> bool {
    static RETRY_LIMIT: std::sync::LazyLock<regex::Regex> = std::sync::LazyLock::new(|| {
        regex::Regex::new(r"(?i)\b(?:exceeded|reached) (?:the )?retry limit\b")
            .expect("valid Codex stream error pattern")
    });
    RETRY_LIMIT.is_match(message)
}

fn codex_user_interrupt_marker(value: &Value) -> bool {
    let payload = value.get("payload").unwrap_or(&Value::Null);
    if value["type"].as_str() != Some("response_item")
        || payload["type"].as_str() != Some("message")
        || payload["role"].as_str() != Some("developer")
    {
        return false;
    }
    payload["content"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|item| item["text"].as_str())
        .any(|text| {
            text.to_ascii_lowercase().contains("<turn_aborted>")
                && text
                    .to_ascii_lowercase()
                    .contains("previous turn was interrupted on purpose")
                && text.to_ascii_lowercase().contains("</turn_aborted>")
        })
}

fn error_message_value(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|text| !text.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| {
            value["message"]
                .as_str()
                .filter(|text| !text.trim().is_empty())
                .map(str::to_owned)
        })
}

fn agent_session_message(app: AgentSessionApp, value: &Value) -> Option<String> {
    if app == AgentSessionApp::Claude {
        if value["type"].as_str() != Some("assistant") {
            return None;
        }
        let content = value["message"]["content"].clone();
        if let Some(text) = content.as_str().filter(|text| !text.trim().is_empty()) {
            return Some(text.to_owned());
        }
        let text = content
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|item| item["text"].as_str())
            .collect::<Vec<_>>()
            .join("\n");
        return (!text.trim().is_empty()).then_some(text);
    }
    let payload = value.get("payload").unwrap_or(value);
    if payload["type"].as_str() == Some("message")
        || payload["type"].as_str() == Some("assistant_message")
    {
        if let Some(text) = payload["text"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
        {
            return Some(text.to_owned());
        }
        if let Some(text) = payload["content"]
            .as_str()
            .filter(|text| !text.trim().is_empty())
        {
            return Some(text.to_owned());
        }
    }
    if value["type"].as_str() == Some("response_item") {
        let item = value.get("payload").unwrap_or(value);
        if item["role"].as_str() == Some("assistant") {
            let text = item["content"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|entry| {
                    entry["text"]
                        .as_str()
                        .or_else(|| entry["output_text"].as_str())
                })
                .collect::<Vec<_>>()
                .join("\n");
            return (!text.trim().is_empty()).then_some(text);
        }
    }
    None
}

fn parse_agent_session_result(
    app: AgentSessionApp,
    content: &str,
) -> Option<Result<String, String>> {
    if app == AgentSessionApp::Codex {
        return parse_codex_session_result(content);
    }
    let mut answer = String::new();
    for line in content.lines() {
        let Ok(value) = serde_json::from_str::<Value>(line) else {
            continue;
        };
        if let Some(message) = agent_session_message(app, &value) {
            answer = message;
        }
        if let Some((success, message)) = agent_session_completion(app, &value) {
            if success {
                return Some(Ok(answer));
            }
            return Some(Err(message));
        }
    }
    None
}

fn agent_session_usage(app: AgentSessionApp, content: &str) -> Value {
    let values = content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    let mut input = 0.0;
    let mut output = 0.0;
    let mut cache_read = 0.0;
    let mut cache_write = 0.0;
    let mut model = None::<String>;
    if app == AgentSessionApp::Codex {
        for value in values.iter().rev() {
            let payload = value.get("payload").unwrap_or(value);
            if model.is_none() {
                model = payload["model"]
                    .as_str()
                    .or_else(|| value["model"].as_str())
                    .map(str::to_owned);
            }
            if payload["type"].as_str() != Some("token_count") {
                continue;
            }
            let usage = payload
                .get("info")
                .and_then(|value| value.get("total_token_usage"))
                .or_else(|| payload.get("total_token_usage"));
            input = usage_number(usage, &["input_tokens", "inputTokens"]);
            output = usage_number(usage, &["output_tokens", "outputTokens"]);
            cache_read = usage_number(
                usage,
                &[
                    "cached_input_tokens",
                    "cache_read_input_tokens",
                    "cacheReadInputTokens",
                    "cacheRead",
                ],
            );
            cache_write = usage_number(
                usage,
                &[
                    "cache_write_tokens",
                    "cache_creation_input_tokens",
                    "cacheWriteInputTokens",
                    "cacheWrite",
                ],
            );
            break;
        }
    } else {
        for value in values {
            if value["type"].as_str() != Some("assistant") {
                continue;
            }
            if model.is_none() {
                model = value["message"]["model"]
                    .as_str()
                    .or_else(|| value["model"].as_str())
                    .map(str::to_owned);
            }
            let usage = value["message"].get("usage").or_else(|| value.get("usage"));
            input += usage_number(usage, &["input_tokens", "inputTokens"]);
            output += usage_number(usage, &["output_tokens", "outputTokens"]);
            cache_read += usage_number(
                usage,
                &[
                    "cache_read_input_tokens",
                    "cached_input_tokens",
                    "cacheReadInputTokens",
                    "cache_read_tokens",
                    "cacheRead",
                ],
            );
            cache_write += usage_number(
                usage,
                &[
                    "cache_creation_input_tokens",
                    "cache_write_input_tokens",
                    "cacheWriteInputTokens",
                    "cacheWrite",
                ],
            );
        }
    }
    let mut result = serde_json::json!({"input":input,"output":output,"cacheRead":cache_read,"cacheWrite":cache_write,"total":input+output});
    if let Some(model) = model {
        result["model"] = Value::String(model);
    }
    result
}

fn usage_number(value: Option<&Value>, keys: &[&str]) -> f64 {
    keys.iter()
        .find_map(|key| {
            value
                .and_then(|value| value.get(*key))
                .and_then(Value::as_f64)
        })
        .unwrap_or(0.0)
}

fn parse_codex_session_result(content: &str) -> Option<Result<String, String>> {
    let values = content
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .collect::<Vec<_>>();
    for value in values.iter().rev() {
        let payload = value.get("payload").unwrap_or(value);
        let kind = payload["type"]
            .as_str()
            .or_else(|| value["type"].as_str())
            .unwrap_or("");
        if matches!(kind, "task_complete" | "turn_complete" | "turn_completed") {
            if let Some(error) = payload["error"]["message"]
                .as_str()
                .or_else(|| payload["error"].as_str())
                .filter(|message| !message.trim().is_empty())
            {
                return Some(Err(error.to_owned()));
            }
            return Some(Ok(codex_final_answer(&values)));
        }
        if matches!(
            kind,
            "error"
                | "turn_failed"
                | "task_failed"
                | "turn_aborted"
                | "task_aborted"
                | "stream_error"
        ) {
            return Some(Err(error_message_value(&payload["message"])
                .or_else(|| error_message_value(&payload["error"]))
                .unwrap_or_else(|| "Codex failed.".to_owned())));
        }
    }
    None
}

fn codex_final_answer(values: &[Value]) -> String {
    for value in values.iter().rev() {
        let payload = value.get("payload").unwrap_or(value);
        let kind = value["type"].as_str().unwrap_or("");
        let payload_kind = payload["type"].as_str().unwrap_or("");
        if kind == "task_complete" || (kind == "event_msg" && payload_kind == "task_complete") {
            let answer = clean_structured_text(
                value["last_agent_message"]
                    .as_str()
                    .or_else(|| payload["last_agent_message"].as_str())
                    .unwrap_or(""),
            );
            if !answer.is_empty() {
                return answer;
            }
        }
    }
    for value in values.iter().rev() {
        let payload = value.get("payload").unwrap_or(&Value::Null);
        if value["type"].as_str() == Some("response_item")
            && payload["type"].as_str() == Some("message")
            && payload["role"].as_str() == Some("assistant")
        {
            let answer = json_content_text(&payload["content"]);
            if !answer.is_empty() {
                return answer;
            }
        }
        if value["type"].as_str() == Some("message") && value["role"].as_str() == Some("assistant")
        {
            let answer = json_content_text(&value["content"]);
            if !answer.is_empty() {
                return answer;
            }
        }
    }
    String::new()
}

fn json_content_text(value: &Value) -> String {
    match value {
        Value::String(text) => clean_structured_text(text),
        Value::Array(items) => items
            .iter()
            .map(json_content_text)
            .filter(|text| !text.is_empty())
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) => {
            if let Some(text) = object.get("text").and_then(Value::as_str) {
                return clean_structured_text(text);
            }
            object
                .get("content")
                .map(json_content_text)
                .unwrap_or_default()
        }
        _ => String::new(),
    }
}

fn clean_structured_text(value: &str) -> String {
    let mut text = value.replace('\r', "");
    for tag in ["system-reminder", "environment_context"] {
        loop {
            let Some(start) = text.to_ascii_lowercase().find(&format!("<{tag}>")) else {
                break;
            };
            let Some(end) = text.to_ascii_lowercase()[start..].find(&format!("</{tag}>")) else {
                break;
            };
            text.replace_range(start..start + end + tag.len() + 3, "");
        }
    }
    text.trim().to_owned()
}

pub(crate) async fn run_cli_chat_with_cancel(
    workspace_root: &Path,
    kind: &str,
    model: &str,
    prompt: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let node = serde_json::json!({
        "kind":"agent",
        "title":if kind == "codex-cli" {"Codex"} else {"Claude"},
        "providerKind":kind,
        "model":model,
        "prompt":prompt,
        "config":{
            "codexSandbox":"workspace-write",
            "claudePermissionMode":"acceptEdits"
        }
    });
    run_agent_process(
        workspace_root,
        &serde_json::json!({"nodes":[],"edges":[]}),
        &node,
        cancelled,
    )
    .await
}

async fn apply_claude_plugin_selection(
    workspace_root: &Path,
    node: &Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let selected = node["config"]["pluginSelectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let snapshot = crate::plugin_catalog::claude_snapshot().await;
    let mut enabled = Vec::new();
    for plugin in snapshot["plugins"].as_array().into_iter().flatten() {
        if !plugin["status"]["installed"].as_bool().unwrap_or(false) {
            continue;
        }
        let selector = plugin["selector"].as_str().unwrap_or("");
        let should_enable = selected.contains(selector);
        let currently_enabled = plugin["status"]["enabled"].as_bool().unwrap_or(false);
        if should_enable != currently_enabled {
            let action = if should_enable { "enable" } else { "disable" };
            run_program(
                workspace_root,
                "claude",
                &["plugin", action, selector],
                None,
                cancelled.clone(),
            )
            .await?;
        }
        if should_enable {
            enabled.push(selector.to_owned());
        }
    }
    Ok(serde_json::json!({
        "type":"claude-plugin","status":"success","selected":selected,"enabled":enabled,
        "text":format!("Claude plugins updated: {} enabled.", enabled.len())
    }))
}

async fn apply_codex_plugin_selection(node: &Value) -> Result<Value, String> {
    let selected = node["config"]["pluginSelectors"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<HashSet<_>>();
    let snapshot = crate::plugin_catalog::codex_snapshot().await;
    let installed = snapshot["plugins"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|plugin| plugin["status"]["installed"].as_bool().unwrap_or(false))
        .filter_map(|plugin| plugin["selector"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let home = std::env::var_os("CODEX_HOME")
        .or_else(|| std::env::var_os("OSHEEP_CODEX_CONFIG_DIR"))
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::var_os("USERPROFILE")
                .or_else(|| std::env::var_os("HOME"))
                .map(PathBuf::from)
                .unwrap_or_default()
                .join(".codex")
        });
    let config_path = home.join("config.toml");
    let original = tokio::fs::read_to_string(&config_path)
        .await
        .unwrap_or_default();
    let mut lines = original.lines().map(str::to_owned).collect::<Vec<_>>();
    for selector in &installed {
        let header = format!("[plugins.\"{selector}\"]");
        let alternate = format!("[plugins.{selector}]");
        let start = lines
            .iter()
            .position(|line| line.trim() == header || line.trim() == alternate);
        if let Some(start) = start {
            let end = (start + 1..lines.len())
                .find(|index| lines[*index].trim_start().starts_with('['))
                .unwrap_or(lines.len());
            let mut enabled_line = None;
            for (index, line) in lines.iter().enumerate().take(end).skip(start + 1) {
                if line.trim_start().starts_with("enabled") {
                    enabled_line = Some(index);
                    break;
                }
            }
            let value = format!("enabled = {}", selected.contains(selector));
            if let Some(index) = enabled_line {
                lines[index] = value;
            } else {
                lines.insert(end, value);
            }
        } else {
            lines.push(String::new());
            lines.push(header);
            lines.push(format!("enabled = {}", selected.contains(selector)));
        }
    }
    if let Some(parent) = config_path.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    let mut output = lines.join("\n");
    output.push('\n');
    tokio::fs::write(&config_path, output)
        .await
        .map_err(|error| error.to_string())?;
    Ok(serde_json::json!({
        "type":"codex-plugin","status":"success","selected":selected,
        "enabled":installed.iter().filter(|selector| selected.contains(*selector)).collect::<Vec<_>>(),
        "text":format!("Codex plugins updated: {} enabled.", selected.len())
    }))
}

async fn copy_skill_tree(source: &Path, destination: &Path) -> Result<(), String> {
    tokio::fs::create_dir_all(destination)
        .await
        .map_err(|error| error.to_string())?;
    let mut entries = tokio::fs::read_dir(source)
        .await
        .map_err(|error| error.to_string())?;
    while let Some(entry) = entries
        .next_entry()
        .await
        .map_err(|error| error.to_string())?
    {
        let target = destination.join(entry.file_name());
        if entry
            .file_type()
            .await
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            Box::pin(copy_skill_tree(&entry.path(), &target)).await?;
        } else {
            tokio::fs::copy(entry.path(), target)
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

async fn move_skill_tree(source: &Path, destination: &Path) -> Result<(), String> {
    if let Some(parent) = destination.parent() {
        tokio::fs::create_dir_all(parent)
            .await
            .map_err(|error| error.to_string())?;
    }
    if tokio::fs::try_exists(destination).await.unwrap_or(false) {
        tokio::fs::remove_dir_all(destination)
            .await
            .map_err(|error| error.to_string())?;
    }
    match tokio::fs::rename(source, destination).await {
        Ok(()) => Ok(()),
        Err(_) => {
            copy_skill_tree(source, destination).await?;
            tokio::fs::remove_dir_all(source)
                .await
                .map_err(|error| error.to_string())
        }
    }
}

async fn runtime_skill_dirs(root: &Path) -> Vec<(String, PathBuf)> {
    let mut result = Vec::new();
    let mut entries = match tokio::fs::read_dir(root).await {
        Ok(entries) => entries,
        Err(_) => return result,
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !name.is_empty()
            && name.len() <= 64
            && name
                .bytes()
                .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
            && entry.path().join("SKILL.md").is_file()
        {
            result.push((name, entry.path()));
        }
    }
    result
}

async fn apply_runtime_skill_selection(
    data_root: &Path,
    agent: &str,
    selected: &HashSet<String>,
) -> Result<Vec<String>, String> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .unwrap_or_default();
    let app_root = if agent == "claude" {
        std::env::var_os("CLAUDE_CONFIG_DIR")
            .or_else(|| std::env::var_os("OSHEEP_CLAUDE_CONFIG_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".claude"))
    } else {
        std::env::var_os("CODEX_HOME")
            .or_else(|| std::env::var_os("OSHEEP_CODEX_CONFIG_DIR"))
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
    };
    let live_root = app_root.join("skills");
    let shared_root = std::env::var_os("OSHEEP_AGENTS_SKILLS_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".agents/skills"));
    let staging = data_root.join("skills").join(agent);
    let mut enabled = runtime_skill_dirs(&live_root).await;
    enabled.extend(runtime_skill_dirs(&shared_root).await);
    for (name, source) in enabled {
        if !selected.contains(&name) {
            move_skill_tree(&source, &staging.join(&name)).await?;
        }
    }
    for (name, source) in runtime_skill_dirs(&staging).await {
        if selected.contains(&name) {
            move_skill_tree(&source, &live_root.join(&name)).await?;
        }
    }
    Ok(runtime_skill_dirs(&live_root)
        .await
        .into_iter()
        .map(|(name, _)| name)
        .collect())
}

async fn run_mcp_block(
    workspace_root: &Path,
    workflow: &Value,
    node: &Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let remote = resolve_templates(
        node["config"]["remoteLink"].as_str().unwrap_or(""),
        workflow,
    )?;
    let post_url = resolve_templates(node["config"]["postUrl"].as_str().unwrap_or(""), workflow)?;
    let endpoint = if post_url.trim().is_empty() {
        remote.clone()
    } else {
        post_url.clone()
    };
    let tool = resolve_templates(node["config"]["toolName"].as_str().unwrap_or(""), workflow)?;
    let args = resolve_templates(
        node["config"]["arguments"].as_str().unwrap_or("{}"),
        workflow,
    )?;
    if remote.trim().is_empty() {
        return Err(format!("{} has no Remote MCP Link.", node_title(node)));
    }
    const SCRIPT: &str = "const[u,m,p,h,k]=process.argv.slice(1);(async()=>{const x={accept:'application/json,text/event-stream','content-type':'application/json','MCP-Protocol-Version':'2025-03-26',...JSON.parse(h||'{}')};if(k)x.authorization='Bearer '+k;const q=async(method,params,id)=>{const r=await fetch(u,{method:'POST',headers:x,body:JSON.stringify({jsonrpc:'2.0',id,method,params})});const t=await r.text();let v;try{v=JSON.parse(t)}catch{const d=t.match(/data:\\s*(.*)/)?.[1];v=d?JSON.parse(d):null}if(!r.ok||!v)throw Error(t.slice(0,500));return v};await q('initialize',{protocolVersion:'2025-03-26',capabilities:{},clientInfo:{name:'osheep',version:'0.2.1'}},'i');await fetch(u,{method:'POST',headers:x,body:JSON.stringify({jsonrpc:'2.0',method:'notifications/initialized',params:{}})});process.stdout.write(JSON.stringify(await q(m,JSON.parse(p||'{}'),'r')))}catch(e){console.error(e.message);process.exit(1)}})().catch(e=>{console.error(e.message);process.exit(1)})";
    let method = if tool.trim().is_empty() {
        "tools/list"
    } else {
        "tools/call"
    };
    let params = if method == "tools/list" {
        serde_json::json!({})
    } else {
        let arguments: Value =
            serde_json::from_str(&args).unwrap_or_else(|_| serde_json::json!({}));
        serde_json::json!({"name":tool,"arguments":arguments})
    };
    let result = run_program(
        workspace_root,
        "node",
        &[
            "-e",
            SCRIPT,
            &endpoint,
            method,
            &params.to_string(),
            node["config"]["headers"].as_str().unwrap_or("{}"),
            node["config"]["apiKey"].as_str().unwrap_or(""),
        ],
        None,
        cancelled,
    )
    .await?;
    let response: Value = serde_json::from_str(result["stdout"].as_str().unwrap_or("{}"))
        .map_err(|error| format!("MCP returned invalid JSON: {error}"))?;
    if method == "tools/list" {
        let tools = response["result"]["tools"].clone();
        Ok(
            serde_json::json!({"type":"mcp","status":"connected","remoteLink":remote,"postUrl":endpoint,"tools":tools,"text":format!("Ready. Discovered {} tools.", tools.as_array().map_or(0, Vec::len))}),
        )
    } else {
        let ok = response.get("error").is_none();
        Ok(
            serde_json::json!({"type":"mcp","status":if ok {"success"} else {"failed"},"remoteLink":remote,"postUrl":endpoint,"tool":tool,"arguments":params["arguments"],"result":response["result"],"error":response["error"],"response":response,"text":output_text(&response)}),
        )
    }
}

async fn run_shell(
    workspace_root: &Path,
    command: &str,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    if command.trim().is_empty() {
        return Err("Command block has no command.".into());
    }
    #[cfg(windows)]
    let (program, args) = (
        "powershell.exe",
        vec![
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ],
    );
    #[cfg(not(windows))]
    let (program, args) = ("sh", vec!["-lc", command]);
    run_program(workspace_root, program, &args, None, cancelled).await
}

pub(crate) async fn run_program(
    workspace_root: &Path,
    program: &str,
    args: &[&str],
    stdin: Option<&str>,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let executable = find_executable(program)
        .ok_or_else(|| format!("{program} is not installed or not on PATH."))?;
    let extension = executable
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("");
    let mut command =
        if cfg!(windows) && matches!(extension.to_ascii_lowercase().as_str(), "cmd" | "bat") {
            let mut command = Command::new("cmd.exe");
            // npm-installed CLIs are `.cmd` shims.  cmd otherwise emits
            // diagnostics using the machine code page (GBK on zh-CN), while
            // the workflow API treats process output as UTF-8.  Set the code
            // page before invoking the shim so startup failures stay readable.
            let mut command_line = String::from("chcp 65001>nul & call ");
            command_line.push_str(&quote_windows_cmd_arg(&executable.to_string_lossy()));
            for arg in args {
                command_line.push(' ');
                command_line.push_str(&quote_windows_cmd_arg(arg));
            }
            // `Command::arg` re-quotes an argument containing spaces. That
            // turns the embedded quotes around the npm shim path into literal
            // characters when cmd parses `/C`. Use the Windows raw argument
            // API so cmd receives the command line exactly once.
            #[cfg(windows)]
            {
                command.raw_arg(format!("/D /S /C {command_line}"));
            }
            #[cfg(not(windows))]
            {
                command.args(["/D", "/S", "/C"]).arg(command_line);
            }
            command
        } else if cfg!(windows) && extension.eq_ignore_ascii_case("ps1") {
            let mut command = Command::new("powershell.exe");
            command
                .args(["-NoLogo", "-NoProfile", "-NonInteractive", "-File"])
                .arg(&executable)
                .args(args);
            command
        } else {
            let mut command = Command::new(&executable);
            command.args(args);
            command
        };
    command
        .current_dir(workspace_root)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .kill_on_drop(true);
    if stdin.is_some() {
        command.stdin(Stdio::piped());
    }
    let mut child = command.spawn().map_err(|error| error.to_string())?;
    if let Some(input) = stdin {
        if let Some(mut pipe) = child.stdin.take() {
            pipe.write_all(input.as_bytes())
                .await
                .map_err(|error| error.to_string())?;
        }
    }
    let mut output_future = Box::pin(child.wait_with_output());
    let process_output = loop {
        tokio::select! {
            result = &mut output_future => break result.map_err(|error| error.to_string())?,
            _ = sleep(Duration::from_millis(100)) => {
                if cancelled.load(Ordering::SeqCst) { return Err("Workflow stopped.".into()); }
            }
        }
    };
    let stdout = String::from_utf8_lossy(&process_output.stdout)
        .trim()
        .to_owned();
    let stderr = String::from_utf8_lossy(&process_output.stderr)
        .trim()
        .to_owned();
    if !process_output.status.success() {
        return Err(if stderr.is_empty() {
            format!("{program} exited with {}", process_output.status)
        } else {
            stderr
        });
    }
    Ok(
        serde_json::json!({"type":"process","status":"success","stdout":stdout,"stderr":stderr,"text":stdout,"exitCode":process_output.status.code()}),
    )
}

fn quote_windows_cmd_arg(value: &str) -> String {
    if !value.is_empty()
        && value
            .bytes()
            .all(|byte| !matches!(byte, b' ' | b'\t' | b'"' | b'&' | b'|' | b'<' | b'>' | b'^'))
    {
        return value.to_owned();
    }
    format!("\"{}\"", value.replace('"', "\\\""))
}

fn find_executable(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.components().count() > 1 && path.exists() {
        return Some(path.to_owned());
    }
    let path_env = std::env::var_os("PATH");
    #[cfg(windows)]
    let extensions: &[&str] = if Path::new(program).extension().is_some() {
        &[""]
    } else {
        &[".exe", ".cmd", ".bat", ".ps1"]
    };
    #[cfg(not(windows))]
    let extensions: &[&str] = &[""];
    if let Some(path_env) = path_env {
        for directory in std::env::split_paths(&path_env) {
            for extension in extensions {
                let candidate = directory.join(format!("{program}{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    #[cfg(windows)]
    if Path::new(program).extension().is_none() {
        if let Some(app_data) = std::env::var_os("APPDATA").map(PathBuf::from) {
            let directory = app_data.join("npm");
            for extension in [".exe", ".cmd", ".bat"] {
                let candidate = directory.join(format!("{program}{extension}"));
                if candidate.is_file() {
                    return Some(candidate);
                }
            }
        }
    }
    None
}

async fn fetch_url(
    workspace_root: &Path,
    url: &str,
    method: &str,
    body: Option<&str>,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    if url.trim().is_empty() {
        return Err("HTTP block has no URL.".into());
    }
    const SCRIPT: &str = "const[u,m]=process.argv.slice(1);let b='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>b+=c);process.stdin.on('end',()=>fetch(u,{method:m,body:['GET','HEAD'].includes(m.toUpperCase())?undefined:b||undefined}).then(async r=>process.stdout.write(JSON.stringify({ok:r.ok,status:r.status,text:await r.text()}))).catch(e=>{console.error(e.message);process.exit(1)}))";
    let result = run_program(
        workspace_root,
        "node",
        &["-e", SCRIPT, url, method],
        Some(body.unwrap_or("")),
        cancelled,
    )
    .await?;
    let raw = result["stdout"].as_str().unwrap_or("");
    let response: Value = serde_json::from_str(raw)
        .map_err(|_| format!("HTTP helper returned an invalid response: {raw}"))?;
    let ok = response["ok"].as_bool().unwrap_or(false);
    Ok(serde_json::json!({
        "type":"http-request",
        "status":if ok {"success"} else {"http-error"},
        "method":method,
        "url":url,
        "statusCode":response["status"],
        "text":response["text"]
    }))
}

async fn wait_cancelled(duration: Duration, cancelled: Arc<AtomicBool>) -> Result<(), String> {
    let mut remaining = duration;
    while remaining > Duration::ZERO {
        if cancelled.load(Ordering::SeqCst) {
            return Err("Workflow stopped.".into());
        }
        let step = remaining.min(Duration::from_millis(100));
        sleep(step).await;
        remaining = remaining.saturating_sub(step);
    }
    Ok(())
}

fn safe_workspace_path(root: &Path, relative: &str) -> Result<PathBuf, String> {
    if relative.is_empty() {
        return Err("File path is required.".into());
    }
    let path = Path::new(relative);
    if path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return Err("File path must stay inside the workspace.".into());
    }
    Ok(root.join(path))
}

fn output(kind: &str, text: &str) -> Value {
    serde_json::json!({"type":kind,"status":"success","text":text})
}

fn output_text(value: &Value) -> String {
    value
        .get("text")
        .and_then(Value::as_str)
        .map(str::to_owned)
        .unwrap_or_else(|| {
            if let Some(value) = value.as_str() {
                value.to_owned()
            } else {
                serde_json::to_string_pretty(value).unwrap_or_default()
            }
        })
}

fn interaction_key(key: &str, node_id: &str) -> String {
    format!("{key}\0{node_id}")
}

async fn read_json(path: &Path) -> Result<Value, RuntimeError> {
    Ok(serde_json::from_slice(&tokio::fs::read(path).await?)?)
}

async fn write_json(path: &Path, value: &Value) -> Result<(), RuntimeError> {
    let parent = path
        .parent()
        .ok_or_else(|| std::io::Error::other("workflow has no parent"))?;
    tokio::fs::create_dir_all(parent).await?;
    let temporary = parent.join(format!(".workflow-{}.tmp", uuid::Uuid::new_v4().simple()));
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    tokio::fs::write(&temporary, bytes).await?;
    if tokio::fs::rename(&temporary, path).await.is_err() {
        tokio::fs::copy(&temporary, path).await?;
        let _ = tokio::fs::remove_file(&temporary).await;
    }
    Ok(())
}

fn now_ms() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sorts_nodes_by_dependencies() {
        let workflow = serde_json::json!({
            "nodes":[{"id":"b"},{"id":"a","kind":"trigger"},{"id":"c"}],
            "edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]
        });
        assert_eq!(ordered_node_ids(&workflow, None), vec!["a", "b", "c"]);
    }

    #[test]
    fn full_run_excludes_nodes_disconnected_from_a_trigger() {
        let workflow = serde_json::json!({
            "nodes":[
                {"id":"start","kind":"trigger"},
                {"id":"connected","kind":"command"},
                {"id":"orphan","kind":"command"}
            ],
            "edges":[{"from":"start","to":"connected"}]
        });
        assert_eq!(
            ordered_node_ids(&workflow, None),
            vec!["start", "connected"]
        );
    }

    #[test]
    fn if_output_activates_only_the_matching_handle() {
        let edges = serde_json::json!([
            {"from":"condition","to":"yes","sourceHandle":"true"},
            {"from":"condition","to":"no","sourceHandle":"false"}
        ]);
        let selected = ["condition", "yes", "no"]
            .into_iter()
            .map(str::to_owned)
            .collect();
        let handles = [("condition".to_owned(), Some("true".to_owned()))]
            .into_iter()
            .collect();
        assert!(node_is_active(
            "yes",
            edges.as_array().unwrap(),
            &selected,
            &handles,
            &HashSet::new()
        ));
        assert!(!node_is_active(
            "no",
            edges.as_array().unwrap(),
            &selected,
            &handles,
            &HashSet::new()
        ));
    }

    #[test]
    fn run_details_are_available_while_running_and_after_completion() {
        let mut node = serde_json::json!({
            "kind":"agent","title":"Codex","providerKind":"codex-cli","config":{}
        });
        node["config"]["runDetails"] = running_details(&node, 100);
        assert_eq!(node["config"]["runDetails"]["status"], "running");
        assert_eq!(
            node["config"]["runDetails"]["commandLine"],
            "codex --ask-for-approval on-request --sandbox workspace-write"
        );
        finish_details(
            &mut node,
            "success",
            145,
            Some(&serde_json::json!({"stdout":"done","stderr":"","text":"done","exitCode":0})),
            None,
        );
        assert_eq!(node["config"]["runDetails"]["status"], "success");
        assert_eq!(node["config"]["runDetails"]["durationMs"], 45);
    }

    #[test]
    fn finished_agent_details_keep_markdown_message_separate_from_retry_log() {
        let mut node = serde_json::json!({
            "kind":"agent", "title":"Claude", "providerKind":"claude-cli", "config":{}
        });
        node["config"]["runDetails"] = running_details(&node, 100);
        finish_details(
            &mut node,
            "success",
            120,
            Some(&serde_json::json!({
                "stdout":"raw tui", "transcript":"last answer", "text":"last answer",
                "retryTranscript":"API 503\\n[osheep] retry 1/2: continue", "retryAttempts":2
            })),
            None,
        );
        assert_eq!(node["config"]["runDetails"]["transcript"], "last answer");
        assert_eq!(node["config"]["runDetails"]["retryAttempts"], 2);
        assert!(node["config"]["runDetails"]["retryTranscript"]
            .as_str()
            .unwrap()
            .contains("retry 1/2"));
    }

    #[test]
    fn failed_agent_details_drop_terminal_replay_noise() {
        let mut node = serde_json::json!({
            "kind":"agent", "title":"Codex", "providerKind":"codex-cli", "config":{}
        });
        node["startedAt"] = Value::from(100u64);
        node["config"]["runDetails"] = serde_json::json!({
            "status":"running", "startedAt":100, "stdout":"tui replay",
            "stderr":"", "transcript":"tui replay"
        });
        finish_details(
            &mut node,
            "error",
            120,
            None,
            Some("Codex failed after 2 attempts: unexpected status 404"),
        );
        assert_eq!(
            node["config"]["runDetails"]["stdout"],
            Value::String(String::new())
        );
        assert_eq!(
            node["config"]["runDetails"]["transcript"],
            "Codex failed after 2 attempts: unexpected status 404"
        );
    }

    #[test]
    fn workflow_agent_invocation_keeps_interactive_tui_and_prompt() {
        let claude = serde_json::json!({
            "providerKind":"claude-cli", "model":"sonnet", "mode":"plan",
            "config":{"resumeConversation":false, "claudePermissionMode":"acceptEdits"}
        });
        let (_, claude_args) =
            build_workflow_agent_invocation("claude-cli", &claude, "继续").unwrap();
        assert!(!claude_args.iter().any(|arg| arg == "-p"));
        assert_eq!(claude_args.last().map(String::as_str), Some("继续"));

        let claude_resume = serde_json::json!({
            "providerKind":"claude-cli",
            "config":{
                "resumeConversation":true,
                "sessionId":"550e8400-e29b-41d4-a716-446655440000"
            }
        });
        let (_, claude_resume_args) =
            build_workflow_agent_invocation("claude-cli", &claude_resume, "继续").unwrap();
        assert!(claude_resume_args.windows(2).any(|pair| {
            pair[0] == "--resume" && pair[1] == "550e8400-e29b-41d4-a716-446655440000"
        }));

        let codex = serde_json::json!({
            "providerKind":"codex-cli", "model":"gpt-5", "mode":"goal",
            "config":{"codexApproval":"on-request", "codexSandbox":"workspace-write"}
        });
        let (_, codex_args) =
            build_workflow_agent_invocation("codex-cli", &codex, "Build").unwrap();
        assert!(!codex_args.iter().any(|arg| arg == "exec"));
        assert_eq!(codex_args.last().map(String::as_str), Some("Build"));

        let codex_resume = serde_json::json!({
            "providerKind":"codex-cli",
            "config":{
                "resumeConversation":true,
                "conversationSessionId":"550e8400-e29b-41d4-a716-446655440000"
            }
        });
        let (_, codex_resume_args) =
            build_workflow_agent_invocation("codex-cli", &codex_resume, "继续").unwrap();
        assert!(codex_resume_args
            .windows(2)
            .any(|pair| { pair[0] == "resume" && pair[1] == "--ask-for-approval" }));
        assert!(codex_resume_args
            .iter()
            .any(|arg| arg == "550e8400-e29b-41d4-a716-446655440000"));
    }

    #[test]
    fn agent_session_jsonl_keeps_last_assistant_message_and_structured_error() {
        let claude = concat!(
            r#"{"type":"assistant","message":{"content":[{"text":"first"}]}}"#,
            "\n",
            r#"{"type":"assistant","message":{"content":[{"text":"last"}]}}"#,
            "\n",
            r#"{"type":"result","subtype":"success"}"#
        );
        assert_eq!(
            parse_agent_session_result(AgentSessionApp::Claude, claude),
            Some(Ok("last".into()))
        );
        let codex = r#"{"payload":{"type":"task_complete","error":{"message":"API 503"}}}"#;
        assert_eq!(
            parse_agent_session_result(AgentSessionApp::Codex, codex),
            Some(Err("API 503".into()))
        );
        let codex_answer = concat!(
            r#"{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"工具输出不应成为最终结果"}]}}"#,
            "\n",
            r#"{"type":"event_msg","payload":{"type":"task_complete","last_agent_message":"最终答案"}}"#
        );
        assert_eq!(
            parse_agent_session_result(AgentSessionApp::Codex, codex_answer),
            Some(Ok("最终答案".into()))
        );
    }

    #[test]
    fn agent_session_lifecycle_matches_codex_terminal_events() {
        let escalation = serde_json::json!({
            "type": "custom_tool_call",
            "payload": {
                "type": "custom_tool_call",
                "name": "exec",
                "input": {"sandbox_permissions": "require_escalated"}
            }
        });
        assert!(agent_session_waiting_for_choice(
            AgentSessionApp::Codex,
            &escalation
        ));
        assert!(agent_session_waiting_for_choice(
            AgentSessionApp::Codex,
            &serde_json::json!({
                "type":"custom_tool_call",
                "name":"exec",
                "input":"exec(command=\"curl.exe -I https://example.com\", sandbox_permissions: \\\"require_escalated\\\")"
            })
        ));
        assert!(agent_session_waiting_for_choice(
            AgentSessionApp::Codex,
            &serde_json::json!({
                "type":"custom_tool_call_output",
                "output":"aborted by user after approval"
            })
        ));

        let declined = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "item_completed",
                "item": {"status": "declined"}
            }
        });
        assert!(agent_session_waiting_for_choice(
            AgentSessionApp::Codex,
            &declined
        ));
        assert!(agent_session_resume_event(
            AgentSessionApp::Codex,
            &serde_json::json!({"type":"event_msg","payload":{"type":"task_started"}})
        ));
        assert!(agent_session_resume_event(
            AgentSessionApp::Codex,
            &serde_json::json!({"type":"event_msg","payload":{"type":"custom_tool_call_output","output":"ok"}})
        ));
        assert!(agent_session_resume_event(
            AgentSessionApp::Claude,
            &serde_json::json!({"type":"user","message":{"content":[{"type":"tool_result","tool_use_id":"q"}]}})
        ));

        let failed = serde_json::json!({
            "type": "event_msg",
            "payload": {
                "type": "task_complete",
                "error": {"message": "unexpected status 503 Service Unavailable"}
            }
        });
        assert_eq!(
            agent_session_completion(AgentSessionApp::Codex, &failed),
            Some((false, "unexpected status 503 Service Unavailable".into()))
        );
        assert_eq!(
            agent_session_completion(
                AgentSessionApp::Codex,
                &serde_json::json!({
                    "type":"event_msg",
                    "payload":{"type":"turn_failed","message":"tool execution failed"}
                })
            ),
            None
        );
        assert_eq!(
            agent_session_completion(
                AgentSessionApp::Codex,
                &serde_json::json!({
                    "type":"event_msg",
                    "payload":{"type":"turn_failed","message":"network error: connection reset"}
                })
            ),
            Some((false, "network error: connection reset".into()))
        );
        assert_eq!(
            agent_session_completion(
                AgentSessionApp::Codex,
                &serde_json::json!({
                    "type":"event_msg",
                    "payload":{
                        "type":"turn_failed",
                        "error":{"message":"unexpected status 503 Service Unavailable"},
                        "message":"tool execution failed"
                    }
                })
            ),
            Some((false, "unexpected status 503 Service Unavailable".into()))
        );
        assert_eq!(
            agent_session_completion(
                AgentSessionApp::Codex,
                &serde_json::json!({
                    "type":"event_msg",
                    "payload":{"type":"stream_error","message":"reached retry limit"}
                })
            ),
            Some((false, "reached retry limit".into()))
        );
        assert_eq!(
            agent_session_completion(
                AgentSessionApp::Codex,
                &serde_json::json!({
                    "type":"event_msg",
                    "payload":{"type":"stream_error","message":"temporary stream interruption"}
                })
            ),
            None
        );
        assert_eq!(
            agent_session_completion(
                AgentSessionApp::Codex,
                &serde_json::json!({
                    "type":"event_msg",
                    "payload":{"type":"turn_aborted","reason":"interrupted"}
                })
            ),
            None
        );
        assert!(codex_user_interrupt_marker(&serde_json::json!({
            "type":"response_item",
            "payload":{
                "type":"message",
                "role":"developer",
                "content":[{"type":"input_text","text":"<turn_aborted>The previous turn was interrupted on purpose.</turn_aborted>"}]
            }
        })));
    }

    #[test]
    fn codex_approval_waiting_is_bound_to_the_matching_call() {
        let mut pending = HashSet::new();
        let request = serde_json::json!({
            "type":"response_item",
            "payload":{
                "type":"custom_tool_call",
                "name":"exec",
                "call_id":"call_1",
                "input":"{\"sandbox_permissions\":\"require_escalated\"}"
            }
        });
        assert_eq!(codex_approval_event(&mut pending, &request), Some(true));
        let unrelated = serde_json::json!({
            "type":"response_item",
            "payload":{"type":"custom_tool_call_output","call_id":"call_other","output":"ok"}
        });
        assert_eq!(codex_approval_event(&mut pending, &unrelated), None);
        let accepted = serde_json::json!({
            "type":"response_item",
            "payload":{"type":"custom_tool_call_output","call_id":"call_1","output":"ok"}
        });
        assert_eq!(codex_approval_event(&mut pending, &accepted), Some(false));
        assert!(pending.is_empty());
    }

    #[test]
    fn jsonl_monitor_retains_partial_event_lines_between_polls() {
        let mut remainder = String::new();
        assert!(
            take_complete_jsonl_lines(&mut remainder, "{\"type\":\"event_msg\",\"payload\":")
                .is_empty()
        );
        let lines = take_complete_jsonl_lines(
            &mut remainder,
            "{\"type\":\"task_started\"}}\n{\"type\":\"partial",
        );
        assert_eq!(
            lines,
            vec!["{\"type\":\"event_msg\",\"payload\":{\"type\":\"task_started\"}}"]
        );
        assert_eq!(remainder, "{\"type\":\"partial");
    }

    #[test]
    fn codex_task_start_is_the_jsonl_running_transition() {
        let mut pending = HashSet::new();
        let started = serde_json::json!({
            "type":"event_msg",
            "payload":{"type":"task_started","turn_id":"turn_1"}
        });
        assert_eq!(codex_approval_event(&mut pending, &started), Some(false));
    }

    #[test]
    fn official_codex_provider_without_login_material_keeps_oauth_auth_file() {
        assert!(!codex_auth_has_login_material(&serde_json::json!({
            "auth_mode":"chatgpt",
            "OPENAI_API_KEY":""
        })));
        assert!(codex_auth_has_login_material(&serde_json::json!({
            "auth_mode":"chatgpt",
            "tokens":{"access_token":"token"}
        })));
        assert!(codex_auth_has_login_material(&serde_json::json!({
            "OPENAI_API_KEY":"sk-test"
        })));
    }

    #[test]
    fn data_blocks_use_upstream_outputs_and_typed_variables() {
        let variable = serde_json::json!({
            "id":"vars","kind":"variable","title":"Variables",
            "config":{"variables":[{"name":"count","value":"3","type":"number"}]}
        });
        let mut workflow = serde_json::json!({"nodes":[variable.clone()],"edges":[]});
        let output = execute_variable(&variable, &workflow).unwrap();
        assert_eq!(output["variables"]["count"], 3.0);
        workflow["nodes"][0]["rawOutput"] = Value::String(output.to_string());
        assert_eq!(
            resolve_template_value("{{vars[count]}}", &workflow).unwrap(),
            serde_json::json!(3.0)
        );

        workflow["nodes"] = serde_json::json!([
            {"id":"one","rawOutput":"{\"data\":{\"left\":1}}"},
            {"id":"two","rawOutput":"{\"data\":{\"right\":2}}"},
            {"id":"merge","kind":"merge","config":{"mode":"object"}}
        ]);
        workflow["edges"] = serde_json::json!([
            {"from":"one","to":"merge"},{"from":"two","to":"merge"}
        ]);
        let merged = execute_merge(&workflow["nodes"][2], &workflow).unwrap();
        assert_eq!(merged["data"], serde_json::json!({"left":1,"right":2}));
    }

    #[test]
    fn json_block_extracts_a_nested_path() {
        let workflow = serde_json::json!({"nodes":[],"edges":[]});
        let node = serde_json::json!({
            "kind":"json","config":{"source":"{\"items\":[{\"name\":\"first\"}]}","path":"items[0].name"}
        });
        let output = execute_json(&node, &workflow).unwrap();
        assert_eq!(output["value"], "first");
    }

    #[test]
    fn rejects_parent_file_paths() {
        assert!(safe_workspace_path(Path::new("workspace"), "../secret").is_err());
    }

    #[test]
    fn agent_retry_settings_match_ts_defaults_and_types() {
        let node = serde_json::json!({"config": {
            "retries": "2", "retryForever": "true", "retryDelaySeconds": "1.5",
            "retryLanguage": "en", "retryStrategy": "lowest-multiplier",
            "retryProviderIds": ["cheap", "cheap", "standard", 4]
        }});
        assert_eq!(agent_retry_count(&node), 2);
        assert!(agent_retry_forever(&node));
        assert_eq!(agent_retry_delay_millis(&node), 1500);
        assert_eq!(agent_retry_prompt(&node), "continue");
        assert_eq!(agent_retry_strategy(&node), "lowest-multiplier");
        assert_eq!(agent_retry_provider_ids(&node), vec!["cheap", "standard"]);
    }

    #[test]
    fn agent_retry_failure_classification_matches_terminal_semantics() {
        assert!(should_retry_agent_failure(
            "HTTP 429 rate limit",
            0,
            2,
            false
        ));
        assert!(should_retry_agent_failure(
            "API server unavailable",
            1,
            2,
            false
        ));
        assert!(should_retry_agent_failure("invalid prompt", 0, 2, false));
        assert!(!should_retry_agent_failure(
            "PTY event stream closed",
            0,
            2,
            false
        ));
        assert!(!should_retry_agent_failure("network error", 2, 2, false));
        assert!(should_retry_agent_failure("network error", 99, 0, true));
    }

    #[tokio::test]
    async fn provider_plan_honors_retry_strategy_and_multipliers() {
        let root = std::env::temp_dir().join(format!(
            "osheep-provider-plan-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(
            root.join("ai-settings.json"),
            serde_json::json!({
                "apps": {"claude": {"current":"standard", "providers": {
                    "standard":{"billingMultiplier":1}, "cheap":{"billingMultiplier":0.5}
                }}}
            })
            .to_string(),
        )
        .await
        .unwrap();
        let node = serde_json::json!({"providerKind":"claude-cli"});
        let ids = load_agent_provider_plan(
            &root,
            &node,
            "lowest-multiplier",
            &["standard".into(), "cheap".into()],
        )
        .await;
        assert_eq!(ids, vec!["cheap", "standard"]);
        let round_robin = load_agent_provider_plan(
            &root,
            &node,
            "round-robin",
            &["standard".into(), "cheap".into()],
        )
        .await;
        assert_eq!(round_robin, vec!["standard", "cheap"]);
        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[tokio::test]
    async fn applying_agent_provider_updates_live_cli_files_and_selected_provider() {
        let root = std::env::temp_dir().join(format!(
            "osheep-apply-agent-provider-{}",
            uuid::Uuid::new_v4().simple()
        ));
        let settings_path = root.join("ai-settings.json");
        let claude_dir = root.join("claude-config");
        let codex_dir = root.join("codex-config");
        tokio::fs::create_dir_all(&root).await.unwrap();
        tokio::fs::write(
            &settings_path,
            serde_json::json!({
                "apps": {
                    "claude": {
                        "current":"old-claude",
                        "providers": {
                            "new-claude": {
                                "settingsConfig": {
                                    "env":{"ANTHROPIC_BASE_URL":"https://claude.example"},
                                    "api_format":"internal-only"
                                }
                            }
                        }
                    },
                    "codex": {
                        "current":"old-codex",
                        "providers": {
                            "new-codex": {
                                "category":"custom",
                                "settingsConfig": {
                                    "auth":{"OPENAI_API_KEY":"codex-secret"},
                                    "config":"model_provider = \"new-codex\"\n"
                                }
                            }
                        }
                    }
                }
            })
            .to_string(),
        )
        .await
        .unwrap();

        apply_agent_provider_to_paths(
            &settings_path,
            &claude_dir,
            &codex_dir,
            &serde_json::json!({"providerKind":"claude-cli"}),
            "new-claude",
        )
        .await
        .unwrap();
        apply_agent_provider_to_paths(
            &settings_path,
            &claude_dir,
            &codex_dir,
            &serde_json::json!({"providerKind":"codex-cli"}),
            "new-codex",
        )
        .await
        .unwrap();

        let claude_live: Value = serde_json::from_slice(
            &tokio::fs::read(claude_dir.join("settings.json"))
                .await
                .unwrap(),
        )
        .unwrap();
        assert_eq!(
            claude_live["env"]["ANTHROPIC_BASE_URL"],
            "https://claude.example"
        );
        assert!(claude_live.get("api_format").is_none());
        assert_eq!(
            tokio::fs::read_to_string(codex_dir.join("config.toml"))
                .await
                .unwrap(),
            "model_provider = \"new-codex\"\n"
        );
        let codex_auth: Value =
            serde_json::from_slice(&tokio::fs::read(codex_dir.join("auth.json")).await.unwrap())
                .unwrap();
        assert_eq!(codex_auth["OPENAI_API_KEY"], "codex-secret");
        let settings: Value =
            serde_json::from_slice(&tokio::fs::read(&settings_path).await.unwrap()).unwrap();
        assert_eq!(settings["apps"]["claude"]["current"], "new-claude");
        assert_eq!(settings["apps"]["codex"]["current"], "new-codex");
        tokio::fs::remove_dir_all(root).await.ok();
    }

    #[tokio::test]
    async fn persists_and_broadcasts_node_and_run_statuses() {
        let root = std::env::temp_dir().join(format!(
            "osheep-workflow-runtime-{}",
            uuid::Uuid::new_v4().simple()
        ));
        tokio::fs::create_dir_all(&root).await.unwrap();
        let path = root.join("workflow.json");
        let workflow = serde_json::json!({
            "id":"wf_contract00","updatedAt":0,
            "nodes":[
                {"id":"start","kind":"trigger","title":"Start","providerKind":"claude-cli","model":"","prompt":"","status":"idle"},
                {"id":"wait","kind":"wait","title":"Wait","providerKind":"claude-cli","model":"","prompt":"","config":{"seconds":0.01},"status":"idle"}
            ],
            "edges":[{"from":"start","to":"wait"}],"runs":[]
        });
        write_json(&path, &workflow).await.unwrap();
        let runtime = WorkflowRuntime::default();
        let mut events = runtime.subscribe("contract").await;
        let (_, initial) = runtime
            .start(
                "contract".into(),
                path.clone(),
                root.clone(),
                None,
                None,
                false,
            )
            .await
            .unwrap();
        assert_eq!(initial["runs"][0]["status"], "running");

        let final_run = tokio::time::timeout(Duration::from_secs(3), async {
            loop {
                let event = events.recv().await.unwrap();
                if event["type"] == "run" && event["run"]["status"] == "success" {
                    return event["run"].clone();
                }
            }
        })
        .await
        .unwrap();
        assert_eq!(final_run["trace"].as_array().unwrap().len(), 2);
        let stored = read_json(&path).await.unwrap();
        assert!(stored["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .all(|node| node["status"] == "success"));
        tokio::fs::remove_dir_all(root).await.ok();
    }
}
