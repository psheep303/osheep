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

#[derive(Clone, Default)]
pub(crate) struct WorkflowRuntime {
    events: Arc<Mutex<HashMap<String, broadcast::Sender<Value>>>>,
    active: Arc<Mutex<HashMap<String, ActiveRun>>>,
    interactions: Arc<Mutex<HashMap<String, oneshot::Sender<Value>>>>,
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
}

impl WorkflowRuntime {
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
        let node_ids = ordered_node_ids(&workflow, requested_ids.as_deref());
        let reset = node_ids.iter().collect::<HashSet<_>>();
        if let Some(nodes) = workflow["nodes"].as_array_mut() {
            for node in nodes {
                if node["id"]
                    .as_str()
                    .is_some_and(|id| reset.contains(&id.to_owned()))
                {
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
        for node_id in node_ids {
            if cancelled.load(Ordering::SeqCst) {
                break;
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
                .execute_node(&key, &workspace_root, &node, cancelled.clone())
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

    async fn execute_node(
        &self,
        key: &str,
        workspace_root: &Path,
        node: &Value,
        cancelled: Arc<AtomicBool>,
    ) -> Result<Value, String> {
        let kind = node["kind"].as_str().unwrap_or("agent");
        match kind {
            "trigger" | "cron" => Ok(output(kind, "Triggered.")),
            "agent" => run_agent(workspace_root, node, cancelled).await,
            "command" => {
                run_shell(
                    workspace_root,
                    node["prompt"].as_str().unwrap_or(""),
                    cancelled,
                )
                .await
            }
            "wait" => {
                let seconds = node["config"]["seconds"].as_f64().unwrap_or(1.0).max(0.0);
                wait_cancelled(Duration::from_secs_f64(seconds), cancelled).await?;
                Ok(output(kind, &format!("Waited {seconds:.1}s.")))
            }
            "file-read" => {
                let relative = node["prompt"].as_str().unwrap_or("").trim();
                let path = safe_workspace_path(workspace_root, relative)?;
                let content = tokio::fs::read_to_string(&path)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(
                    serde_json::json!({"type":kind,"status":"success","path":relative,"content":content,"text":content}),
                )
            }
            "file-write" => {
                let relative = node["config"]["path"].as_str().unwrap_or("").trim();
                let content = node["config"]["content"]
                    .as_str()
                    .unwrap_or(node["prompt"].as_str().unwrap_or(""));
                let path = safe_workspace_path(workspace_root, relative)?;
                if let Some(parent) = path.parent() {
                    tokio::fs::create_dir_all(parent)
                        .await
                        .map_err(|error| error.to_string())?;
                }
                tokio::fs::write(path, content)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok(
                    serde_json::json!({"type":kind,"status":"success","path":relative,"bytes":content.len(),"content":content,"text":content}),
                )
            }
            "web" => {
                fetch_url(
                    workspace_root,
                    node["prompt"].as_str().unwrap_or(""),
                    "GET",
                    None,
                    cancelled,
                )
                .await
            }
            "http-request" => {
                let config = &node["config"];
                fetch_url(
                    workspace_root,
                    config["url"].as_str().unwrap_or(""),
                    config["method"].as_str().unwrap_or("GET"),
                    config["body"].as_str(),
                    cancelled,
                )
                .await
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
            "variable" | "set" | "json" | "merge" | "loop-items" | "if" => {
                let data = node.get("config").cloned().unwrap_or(Value::Null);
                Ok(
                    serde_json::json!({"type":kind,"status":"success","data":data,"text":output_text(&data)}),
                )
            }
            "codex-plugin" | "claude-plugin" | "codex-skill" | "claude-skill" => {
                Ok(output(kind, "Selection applied."))
            }
            "git-commit" => {
                let message = node["config"]["message"].as_str().unwrap_or("").trim();
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
                let branch = node["config"]["branch"].as_str().unwrap_or("").trim();
                if branch.is_empty() {
                    return Err("Git branch is required.".into());
                }
                run_program(
                    workspace_root,
                    "git",
                    &["checkout", branch],
                    None,
                    cancelled,
                )
                .await
            }
            "git-delete-branch" => {
                let branch = node["config"]["branch"].as_str().unwrap_or("").trim();
                if branch.is_empty() {
                    return Err("Git branch is required.".into());
                }
                run_program(
                    workspace_root,
                    "git",
                    &["branch", "-d", branch],
                    None,
                    cancelled,
                )
                .await
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
    let mut indegree = all
        .iter()
        .map(|id| (id.clone(), 0usize))
        .collect::<HashMap<_, _>>();
    let mut outgoing = HashMap::<String, Vec<String>>::new();
    for edge in workflow["edges"].as_array().into_iter().flatten() {
        let (Some(from), Some(to)) = (edge["from"].as_str(), edge["to"].as_str()) else {
            continue;
        };
        if known.contains(from) && known.contains(to) {
            outgoing
                .entry(from.to_owned())
                .or_default()
                .push(to.to_owned());
            *indegree.entry(to.to_owned()).or_default() += 1;
        }
    }
    let mut queue = all
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
    for id in all {
        if !result.contains(&id) {
            result.push(id);
        }
    }
    result
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

async fn run_agent(
    workspace_root: &Path,
    node: &Value,
    cancelled: Arc<AtomicBool>,
) -> Result<Value, String> {
    let prompt = node["prompt"].as_str().unwrap_or("").trim();
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

async fn run_program(
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
            command.args(["/D", "/S", "/C"]).arg(&executable).args(args);
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

fn find_executable(program: &str) -> Option<PathBuf> {
    let path = Path::new(program);
    if path.components().count() > 1 && path.exists() {
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
            "nodes":[{"id":"b"},{"id":"a"},{"id":"c"}],
            "edges":[{"from":"a","to":"b"},{"from":"b","to":"c"}]
        });
        assert_eq!(ordered_node_ids(&workflow, None), vec!["a", "b", "c"]);
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
