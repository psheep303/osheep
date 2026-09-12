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
    ) -> Result<(String, Value), RuntimeError> {
        let run_id = format!("run_{}", uuid::Uuid::new_v4().simple());
        let cancelled = Arc::new(AtomicBool::new(false));
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
        let reset = if full_run {
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
        let run = serde_json::json!({
            "id":run_id,"status":"running","startedAt":now,"nodeIds":node_ids,"trace":[]
        });
        if !workflow["runs"].is_array() {
            workflow["runs"] = Value::Array(Vec::new());
        }
        let runs = workflow["runs"].as_array_mut().expect("runs initialized");
        if runs.len() >= 50 {
            runs.drain(..runs.len() - 49);
        }
        runs.push(run.clone());
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
        tokio::spawn(async move {
            runtime
                .execute(
                    task_key.clone(),
                    workflow_path,
                    workspace_root,
                    task_run_id.clone(),
                    node_ids,
                    cancelled,
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
    ) {
        let mut run_error = None;
        let edges = read_json(&workflow_path)
            .await
            .ok()
            .and_then(|workflow| workflow["edges"].as_array().cloned())
            .unwrap_or_default();
        let selected = node_ids.iter().cloned().collect::<HashSet<_>>();
        let mut source_handles = HashMap::<String, Option<String>>::new();
        let mut skipped = HashSet::<String>::new();
        for node_id in node_ids {
            if cancelled.load(Ordering::SeqCst) {
                break;
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

            let node = workflow["nodes"][index].clone();
            let result = self
                .execute_node(
                    &key,
                    &workflow_path,
                    &workspace_root,
                    &workflow,
                    &node,
                    cancelled.clone(),
                )
                .await;
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
                }
                Err(error) => {
                    let stopped = cancelled.load(Ordering::SeqCst);
                    let status = "error";
                    let node = &mut workflow["nodes"][index];
                    node["status"] = Value::String(status.into());
                    node["error"] = Value::String(error.clone());
                    node["summary"] = Value::String(error.clone());
                    node["rawOutput"] = Value::String(error.clone());
                    node["completedAt"] = Value::from(completed_at);
                    node["config"]["waitingForInput"] = Value::Bool(false);
                    node["config"]["waitingForApproval"] = Value::Bool(false);
                    finish_details(node, "error", completed_at, None, Some(&error));
                    complete_trace(
                        &mut workflow,
                        &run_id,
                        &node_id,
                        status,
                        completed_at,
                        None,
                        Some(error.clone()),
                    );
                    if !stopped {
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
            let status = if cancelled.load(Ordering::SeqCst) {
                "stopped"
            } else if run_error.is_some() {
                "error"
            } else {
                "success"
            };
            if let Some(run) = find_run_mut(&mut workflow, &run_id) {
                run["status"] = Value::String(status.into());
                run["completedAt"] = Value::from(completed_at);
                if let Some(error) = run_error {
                    run["error"] = Value::String(error);
                }
                let run = run.clone();
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
        let (executable, args) = build_workflow_agent_invocation(provider, node, prompt)?;
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
        let mut last_update = now_ms();
        let agent_app = if provider == "codex-cli" {
            AgentSessionApp::Codex
        } else {
            AgentSessionApp::Claude
        };
        let mut conversation_id = node["config"]["sessionId"]
            .as_str()
            .filter(|value| !value.trim().is_empty())
            .map(str::to_owned);
        let mut session_offset = 0usize;
        let mut final_message = String::new();
        if let Some(id) = conversation_id.as_deref() {
            if let Ok(Some(content)) = self
                .session_service
                .read_in_project(agent_app, id, workspace_root)
                .await
            {
                session_offset = content.len();
            }
        }
        let result = 'agent_loop: loop {
            if cancelled.load(Ordering::SeqCst) {
                let _ = session.kill().await;
                break Err("Workflow stopped.".to_owned());
            }
            tokio::select! {
                event = events.recv() => match event {
                    Ok(PtyEvent::Output(data)) => {
                        transcript.push_str(&data);
                        if now_ms().saturating_sub(last_update) >= 250 {
                            self.persist_agent_details(workflow_path, key, &node_id, &session_id, "running", &transcript, None).await;
                            last_update = now_ms();
                        }
                    }
                    Ok(PtyEvent::Exit { code, .. }) => {
                        if cancelled.load(Ordering::SeqCst) {
                            break Err("Workflow stopped.".to_owned());
                        }
                        if code != 0 {
                            let message = if !final_message.trim().is_empty() {
                                final_message.clone()
                            } else {
                                clean_terminal_text(&transcript)
                            };
                            if !final_message.trim().is_empty() {
                                self.persist_agent_details(workflow_path, key, &node_id, &session_id, "error", &final_message, conversation_id.as_deref()).await;
                            }
                            break Err(if message.is_empty() {
                                format!("{provider} exited with code {code}.")
                            } else {
                                message
                            });
                        }
                        let answer = if final_message.trim().is_empty() { clean_terminal_text(&transcript) } else { final_message.clone() };
                        break Ok(serde_json::json!({"type":provider,"status":if code == 0 {"success"} else {"error"},"stdout":transcript,"stderr":"","text":answer,"transcript":answer,"exitCode":code,"conversationSessionId":conversation_id}));
                    }
                    Ok(PtyEvent::Error(message)) => {
                        if !final_message.trim().is_empty() {
                            self.persist_agent_details(workflow_path, key, &node_id, &session_id, "error", &final_message, conversation_id.as_deref()).await;
                        }
                        break Err(message);
                    }
                    Err(_) => {
                        if conversation_id.is_none() {
                            if let Ok(sessions) = self.session_service.list_in_project(agent_app, workspace_root).await {
                                conversation_id = sessions
                                    .into_iter()
                                    .find(|item| item.updated_at >= node["startedAt"].as_u64().unwrap_or(0) as f64)
                                    .map(|item| item.id);
                            }
                        }
                        let mut recovered = None;
                        for _ in 0..25 {
                            if let Some(id) = conversation_id.as_deref() {
                                if let Ok(Some(content)) = self.session_service.read_in_project(agent_app, id, workspace_root).await {
                                    if let Some(result) = parse_agent_session_result(agent_app, &content) {
                                        recovered = Some((id.to_owned(), result));
                                        break;
                                    }
                                }
                            }
                            sleep(Duration::from_millis(120)).await;
                        }
                        if let Some((id, result)) = recovered {
                            match result {
                                Ok(answer) => break 'agent_loop Ok(serde_json::json!({"type":provider,"status":"success","stdout":transcript,"stderr":"","text":answer,"transcript":answer,"exitCode":0,"conversationSessionId":id})),
                                Err(message) => break 'agent_loop Err(message),
                            }
                        }
                        if !final_message.trim().is_empty() {
                            self.persist_agent_details(workflow_path, key, &node_id, &session_id, "error", &final_message, conversation_id.as_deref()).await;
                        }
                        let fallback = clean_terminal_text(&transcript);
                        break Err(if fallback.is_empty() {
                            "Agent process ended before the session reported a result.".to_owned()
                        } else {
                            fallback
                        });
                    }
                },
                _ = sleep(Duration::from_millis(120)) => {
                    if conversation_id.is_none() {
                        if let Ok(sessions) = self.session_service.list_in_project(agent_app, workspace_root).await {
                            conversation_id = sessions
                                .into_iter()
                                .find(|item| item.updated_at >= node["startedAt"].as_u64().unwrap_or(0) as f64)
                                .map(|item| item.id);
                            if let Some(id) = conversation_id.as_deref() {
                                self.persist_agent_details(workflow_path, key, &node_id, &session_id, "running", &transcript, Some(id)).await;
                            }
                        }
                    }
                    if let Some(id) = conversation_id.as_deref() {
                        if let Ok(Some(content)) = self.session_service.read_in_project(agent_app, id, workspace_root).await {
                            let start = session_offset.min(content.len());
                            session_offset = content.len();
                            for line in content.get(start..).unwrap_or("").lines() {
                                let Ok(value) = serde_json::from_str::<Value>(line) else { continue };
                                if let Some(message) = agent_session_message(agent_app, &value) {
                                    final_message = message;
                                }
                                if let Some((success, message)) = agent_session_completion(agent_app, &value) {
                                    if success {
                                        let _ = session.kill().await;
                                        let answer = if final_message.trim().is_empty() { clean_terminal_text(&transcript) } else { final_message.clone() };
                                        break 'agent_loop Ok(serde_json::json!({"type":provider,"status":"success","stdout":transcript,"stderr":"","text":answer,"transcript":answer,"exitCode":0,"conversationSessionId":id}));
                                    }
                                    let _ = session.kill().await;
                                    if !final_message.trim().is_empty() {
                                        self.persist_agent_details(workflow_path, key, &node_id, &session_id, "error", &final_message, Some(id)).await;
                                    }
                                    break 'agent_loop Err(message);
                                }
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
        trace["output"] = output;
    }
    if let Some(error) = error {
        trace["error"] = Value::String(error);
    }
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
    }
    if let Some(error) = error {
        let existing_stderr = details["stderr"].as_str().unwrap_or("");
        details["stderr"] = Value::String(if existing_stderr.is_empty() {
            error.to_owned()
        } else {
            format!("{existing_stderr}\n{error}")
        });
        if details["transcript"]
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

fn clean_terminal_text(value: &str) -> String {
    value.trim().to_owned()
}

fn agent_session_completion(app: AgentSessionApp, value: &Value) -> Option<(bool, String)> {
    if app == AgentSessionApp::Claude {
        let kind = value["type"].as_str().unwrap_or("");
        let subtype = value["subtype"].as_str().unwrap_or("");
        if value["is_error"].as_bool().unwrap_or(false)
            || (kind == "result" && subtype != "success" && !subtype.is_empty())
        {
            return Some((
                false,
                value["error"]
                    .as_str()
                    .unwrap_or("Claude Code failed.")
                    .to_owned(),
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
    if matches!(kind, "task_complete" | "turn_complete") {
        if let Some(error) = payload["error"]["message"]
            .as_str()
            .or_else(|| payload["error"].as_str())
            .filter(|message| !message.trim().is_empty())
        {
            return Some((false, error.to_owned()));
        }
        return Some((true, String::new()));
    }
    if matches!(kind, "error" | "turn_failed" | "task_failed") {
        return Some((
            false,
            payload["message"]
                .as_str()
                .unwrap_or("Codex failed.")
                .to_owned(),
        ));
    }
    None
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
            .start("contract".into(), path.clone(), root.clone(), None)
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
