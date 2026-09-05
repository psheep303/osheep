use osheep_contract::{RuntimeClientRequest, RuntimeClientResponse, RuntimeHealthResponse};
use osheep_instance::{read_registry, RuntimePaths, ServiceRegistry};
use rfd::AsyncFileDialog;
use std::{
    env,
    fs::{self, OpenOptions},
    io::{self, Read, Write},
    net::{SocketAddr, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread::{self, JoinHandle},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{webview::PageLoadEvent, Manager, WebviewUrl, WebviewWindowBuilder};
use uuid::Uuid;

#[derive(Default)]
struct BackendProcessState {
    child: Option<Child>,
    stopping: bool,
}

#[derive(Clone, Default)]
struct BackendProcess(Arc<Mutex<BackendProcessState>>);

#[derive(Default)]
struct StartupUiState {
    shell_loaded: bool,
    pending_error: Option<String>,
}

#[derive(Clone, Default)]
struct StartupUi(Arc<Mutex<StartupUiState>>);

#[derive(Default)]
struct SharedServiceClientState {
    stop: Option<mpsc::Sender<()>>,
    worker: Option<JoinHandle<()>>,
}

#[derive(Clone, Default)]
struct SharedServiceClient(Arc<Mutex<SharedServiceClientState>>);

#[tauri::command]
async fn pick_workspace_folder(
    window: tauri::WebviewWindow,
    initial_path: Option<String>,
) -> Result<Option<String>, String> {
    let mut dialog = AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("选择 osheep workspaces 文件夹");
    if let Some(path) = initial_path.filter(|path| !path.trim().is_empty()) {
        dialog = dialog.set_directory(path);
    }

    Ok(dialog
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[tauri::command]
async fn pick_skill_folder(window: tauri::WebviewWindow) -> Result<Option<String>, String> {
    Ok(AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("选择 Skill 文件夹")
        .pick_folder()
        .await
        .map(|folder| folder.path().to_string_lossy().into_owned()))
}

#[tauri::command]
fn open_external_url(url: String) -> Result<(), String> {
    let parsed =
        tauri::Url::parse(&url).map_err(|error| format!("invalid external URL: {error}"))?;
    if !matches!(parsed.scheme(), "http" | "https") {
        return Err("only http and https URLs can be opened externally".into());
    }

    #[cfg(target_os = "windows")]
    let mut command = {
        let mut command = Command::new("rundll32.exe");
        command.args(["url.dll,FileProtocolHandler", &url]);
        command
    };
    #[cfg(target_os = "macos")]
    let mut command = {
        let mut command = Command::new("open");
        command.arg(&url);
        command
    };
    #[cfg(all(unix, not(target_os = "macos")))]
    let mut command = {
        let mut command = Command::new("xdg-open");
        command.arg(&url);
        command
    };

    command
        .spawn()
        .map(|_| ())
        .map_err(|error| format!("failed to open external URL: {error}"))
}

#[tauri::command]
async fn save_export_file(
    window: tauri::WebviewWindow,
    suggested_name: String,
    contents: String,
) -> Result<Option<String>, String> {
    let safe_name = Path::new(&suggested_name)
        .file_name()
        .and_then(|name| name.to_str())
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("workflow.json");
    let extension = Path::new(safe_name)
        .extension()
        .and_then(|extension| extension.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let dialog = AsyncFileDialog::new()
        .set_parent(&window)
        .set_title("Save export")
        .set_file_name(safe_name);
    let dialog = match extension.as_str() {
        "md" | "markdown" => dialog.add_filter("Markdown", &["md", "markdown"]),
        "json" => dialog.add_filter("JSON", &["json"]),
        _ => dialog.add_filter("Text", &["txt"]),
    };
    let selected = dialog.save_file().await;
    let Some(file) = selected else {
        return Ok(None);
    };
    let path = file.path();
    fs::write(path, contents).map_err(|error| format!("failed to save export: {error}"))?;
    Ok(Some(path.to_string_lossy().into_owned()))
}

impl BackendProcess {
    #[allow(dead_code)]
    fn spawn(&self, command: &mut Command) -> io::Result<()> {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.stopping {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "desktop stopped during backend startup",
            ));
        }
        if state.child.is_some() {
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "backend process already managed",
            ));
        }

        state.child = Some(command.spawn()?);
        Ok(())
    }

    #[allow(dead_code)]
    fn child_exited(&self) -> io::Result<Option<std::process::ExitStatus>> {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let stopping = state.stopping;
        match state.child.as_mut() {
            Some(child) => child.try_wait(),
            None if stopping => Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "desktop stopped during backend startup",
            )),
            None => Err(io::Error::other("backend process unavailable")),
        }
    }

    fn is_stopping(&self) -> bool {
        self.0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .stopping
    }

    fn cleanup_startup_failure(&self) {
        let child = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .child
            .take();
        if let Some(mut child) = child {
            terminate_child(&mut child);
        }
    }

    fn stop(&self) {
        let child = {
            let mut state = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            state.stopping = true;
            state.child.take()
        };
        if let Some(mut child) = child {
            terminate_child(&mut child);
        }
    }
}

impl SharedServiceClient {
    fn start(&self, registry: ServiceRegistry) -> io::Result<SocketAddr> {
        let address = verify_shared_service(&registry)?;
        let client_id = format!("desktop_{}", Uuid::new_v4().simple());
        let request = RuntimeClientRequest {
            client_id: client_id.clone(),
            client_version: env!("CARGO_PKG_VERSION").into(),
        };
        let response: RuntimeClientResponse =
            runtime_json_request(&registry, "POST", "/api/runtime/clients", Some(&request))?;
        if response.client_id != client_id {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "runtime service returned a different client ID",
            ));
        }
        let heartbeat = Duration::from_millis((response.lease_timeout_ms / 3).clamp(1_000, 15_000));
        let (stop, stopped) = mpsc::channel();
        let worker_registry = registry;
        let worker_request = request;
        let worker_id = client_id;
        let worker = thread::spawn(move || loop {
            match stopped.recv_timeout(heartbeat) {
                Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                    let _ = runtime_empty_request(
                        &worker_registry,
                        "DELETE",
                        &format!("/api/runtime/clients/{worker_id}"),
                    );
                    break;
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    let _ = runtime_json_request::<_, RuntimeClientResponse>(
                        &worker_registry,
                        "POST",
                        "/api/runtime/clients",
                        Some(&worker_request),
                    );
                }
            }
        });
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.worker.is_some() {
            let _ = stop.send(());
            let _ = worker.join();
            return Err(io::Error::new(
                io::ErrorKind::AlreadyExists,
                "shared service client already started",
            ));
        }
        state.stop = Some(stop);
        state.worker = Some(worker);
        Ok(address)
    }

    fn stop(&self) {
        let (stop, worker) = {
            let mut state = self
                .0
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner());
            (state.stop.take(), state.worker.take())
        };
        if let Some(stop) = stop {
            let _ = stop.send(());
        }
        if let Some(worker) = worker {
            let _ = worker.join();
        }
    }
}

impl StartupUi {
    fn queue_error(&self, message: String) -> Option<String> {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.shell_loaded {
            Some(message)
        } else {
            state.pending_error = Some(message);
            None
        }
    }

    fn mark_shell_loaded(&self) -> Option<String> {
        let mut state = self
            .0
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.shell_loaded {
            None
        } else {
            state.shell_loaded = true;
            state.pending_error.take()
        }
    }
}

impl Drop for BackendProcessState {
    fn drop(&mut self) {
        if let Some(child) = self.child.as_mut() {
            terminate_child(child);
        }
    }
}

fn terminate_child(child: &mut Child) {
    if matches!(child.try_wait(), Ok(Some(_))) {
        return;
    }

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }

    let _ = child.kill();
    let _ = child.wait();
}

fn require_file(path: &Path, label: &str) -> io::Result<()> {
    if path.is_file() {
        Ok(())
    } else {
        Err(io::Error::new(
            io::ErrorKind::NotFound,
            format!("{label} not found: {}", path.display()),
        ))
    }
}

fn files_match(left: &Path, right: &Path) -> io::Result<bool> {
    let left_metadata = fs::metadata(left)?;
    let right_metadata = fs::metadata(right)?;
    if left_metadata.len() != right_metadata.len() {
        return Ok(false);
    }
    Ok(fs::read(left)? == fs::read(right)?)
}

fn copy_file_verified(source: &Path, destination: &Path) -> io::Result<()> {
    let parent = destination.parent().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "migration destination has no parent",
        )
    })?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".osheep-migrate-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    fs::copy(source, &temporary)?;
    if !files_match(source, &temporary)? {
        let _ = fs::remove_file(&temporary);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!("migration verification failed: {}", source.display()),
        ));
    }
    match fs::rename(&temporary, destination) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
}

#[allow(dead_code)]
fn merge_verified_directory(source: &Path, destination: &Path, conflicts: &Path) -> io::Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let conflict_path = conflicts.join(entry.file_name());
        if file_type.is_dir() {
            merge_verified_directory(&source_path, &destination_path, &conflict_path)?;
            if fs::read_dir(&source_path)?.next().is_none() {
                fs::remove_dir(&source_path)?;
            }
        } else if file_type.is_file() {
            if !destination_path.exists() {
                copy_file_verified(&source_path, &destination_path)?;
            } else if !files_match(&source_path, &destination_path)? {
                copy_file_verified(&source_path, &conflict_path)?;
            }
            fs::remove_file(&source_path)?;
        }
    }
    Ok(())
}

fn copy_verified_directory(source: &Path, destination: &Path, conflicts: &Path) -> io::Result<()> {
    if !source.is_dir() {
        return Ok(());
    }
    for entry in fs::read_dir(source)? {
        let entry = entry?;
        let file_type = entry.file_type()?;
        let source_path = entry.path();
        let destination_path = destination.join(entry.file_name());
        let conflict_path = conflicts.join(entry.file_name());
        if file_type.is_dir() {
            copy_verified_directory(&source_path, &destination_path, &conflict_path)?;
        } else if file_type.is_file() {
            if !destination_path.exists() {
                copy_file_verified(&source_path, &destination_path)?;
            } else if !files_match(&source_path, &destination_path)? {
                copy_file_verified(&source_path, &conflict_path)?;
            }
        }
    }
    Ok(())
}

fn atomic_write(path: &Path, contents: &[u8]) -> io::Result<()> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "atomic write has no parent"))?;
    fs::create_dir_all(parent)?;
    let temporary = parent.join(format!(
        ".osheep-write-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
    ));
    let result = (|| {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        file.write_all(contents)?;
        file.sync_all()?;
        replace_file(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

#[cfg(target_os = "windows")]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };
    if !destination.exists() {
        return fs::rename(source, destination);
    }
    let source: Vec<u16> = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let destination: Vec<u16> = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect();
    let result = unsafe {
        MoveFileExW(
            source.as_ptr(),
            destination.as_ptr(),
            MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "windows"))]
fn replace_file(source: &Path, destination: &Path) -> io::Result<()> {
    fs::rename(source, destination)
}

fn rewrite_default_workspace_root(
    config_path: &Path,
    legacy_workspaces: &Path,
    target_workspaces: &Path,
) -> io::Result<()> {
    if !config_path.is_file() {
        return Ok(());
    }
    let text = fs::read_to_string(config_path)?;
    let legacy = legacy_workspaces.to_string_lossy();
    let target = target_workspaces.to_string_lossy();
    let legacy_json = legacy.replace('\\', "\\\\");
    let target_json = target.replace('\\', "\\\\");
    let replaced = text
        .replace(&legacy_json, &target_json)
        .replace(legacy.as_ref(), target.as_ref());
    if replaced != text {
        atomic_write(config_path, replaced.as_bytes())?;
    }
    Ok(())
}

fn migrate_node_data_to_rust(source: &Path, destination: &Path) -> io::Result<()> {
    let marker = destination.join("migration-node-v1.json");
    if marker.is_file() || !source.is_dir() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    let migration_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let conflicts = destination
        .join("migration-conflicts")
        .join(format!("node-data-{migration_id}"));
    copy_verified_directory(source, destination, &conflicts)?;
    rewrite_default_workspace_root(
        &destination.join("workspace-root.json"),
        &source.join("workspaces"),
        &destination.join("workspaces"),
    )?;
    let record = serde_json::json!({
        "schemaVersion": 1,
        "source": source,
        "completedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    });
    let bytes = serde_json::to_vec_pretty(&record).map_err(io::Error::other)?;
    atomic_write(&marker, &bytes)
}

fn migrate_legacy_app_data_to_rust(legacy: &Path, destination: &Path) -> io::Result<()> {
    let marker = destination.join("migration-appdata-v1.json");
    if marker.is_file() {
        return Ok(());
    }
    let legacy_workspaces = legacy.join("workspaces");
    let legacy_config = legacy.join("workspace-root.json");
    if !legacy_workspaces.is_dir() && !legacy_config.is_file() {
        return Ok(());
    }
    fs::create_dir_all(destination)?;
    let migration_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let conflicts = destination
        .join("migration-conflicts")
        .join(format!("appdata-{migration_id}"));
    copy_verified_directory(
        &legacy_workspaces,
        &destination.join("workspaces"),
        &conflicts.join("workspaces"),
    )?;
    if legacy_config.is_file() {
        let destination_config = destination.join("workspace-root.json");
        if !destination_config.exists() {
            copy_file_verified(&legacy_config, &destination_config)?;
        } else if !files_match(&legacy_config, &destination_config)? {
            copy_file_verified(&legacy_config, &conflicts.join("workspace-root.json"))?;
        }
        rewrite_default_workspace_root(
            &destination_config,
            &legacy_workspaces,
            &destination.join("workspaces"),
        )?;
    }
    let record = serde_json::json!({
        "schemaVersion": 1,
        "source": legacy,
        "completedAt": SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis()
    });
    let bytes = serde_json::to_vec_pretty(&record).map_err(io::Error::other)?;
    atomic_write(&marker, &bytes)
}

#[allow(dead_code)]
fn migrate_desktop_persistent_data(legacy_data: &Path, backend_data: &Path) -> io::Result<()> {
    fs::create_dir_all(backend_data)?;
    let legacy_workspaces = legacy_data.join("workspaces");
    let target_workspaces = backend_data.join("workspaces");
    let migration_id = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_nanos();
    let conflicts = backend_data
        .join("migration-conflicts")
        .join(format!("desktop-appdata-{migration_id}"));
    merge_verified_directory(
        &legacy_workspaces,
        &target_workspaces,
        &conflicts.join("workspaces"),
    )?;
    if legacy_workspaces.is_dir() && fs::read_dir(&legacy_workspaces)?.next().is_none() {
        fs::remove_dir(&legacy_workspaces)?;
    }

    let legacy_config = legacy_data.join("workspace-root.json");
    let target_config = backend_data.join("workspace-root.json");
    if legacy_config.is_file() {
        if !target_config.exists() {
            copy_file_verified(&legacy_config, &target_config)?;
        } else if !files_match(&legacy_config, &target_config)? {
            copy_file_verified(&legacy_config, &conflicts.join("workspace-root.json"))?;
        }
        rewrite_default_workspace_root(&target_config, &legacy_workspaces, &target_workspaces)?;
        fs::remove_file(&legacy_config)?;
    } else {
        rewrite_default_workspace_root(&target_config, &legacy_workspaces, &target_workspaces)?;
    }
    Ok(())
}

fn startup_theme(app: &tauri::AppHandle) -> &'static str {
    let settings = app
        .path()
        .app_local_data_dir()
        .ok()
        .and_then(|root| fs::read_to_string(root.join("data/settings.json")).ok())
        .unwrap_or_default();
    let compact: String = settings
        .chars()
        .filter(|character| !character.is_whitespace())
        .collect();
    if compact.contains("\"theme\":\"dark\"") {
        "dark"
    } else if compact.contains("\"theme\":\"light\"") {
        "light"
    } else if compact.contains("\"theme\":\"system\"") {
        "system"
    } else {
        "dark"
    }
}

struct SharedServicePaths {
    executable: PathBuf,
    frontend_root: PathBuf,
    runtime: RuntimePaths,
    data_root: PathBuf,
    log_dir: PathBuf,
}

fn shared_service_paths(app: &tauri::AppHandle) -> io::Result<SharedServicePaths> {
    let app_data = app.path().app_local_data_dir().map_err(io::Error::other)?;
    let log_dir = app.path().app_log_dir().map_err(io::Error::other)?;
    let (executable, frontend_root) = if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        (
            root.join("target/debug")
                .join(format!("osheep-server{}", env::consts::EXE_SUFFIX)),
            root.join("frontend/dist"),
        )
    } else {
        let resources = app.path().resource_dir().map_err(io::Error::other)?;
        (
            resources
                .join("sidecar")
                .join(format!("osheep-server{}", env::consts::EXE_SUFFIX)),
            resources.join("frontend"),
        )
    };
    Ok(SharedServicePaths {
        executable,
        frontend_root,
        runtime: RuntimePaths::new(app_data.join("runtime/shared-service")),
        data_root: app_data.join("data"),
        log_dir,
    })
}

fn ensure_shared_service(
    app: &tauri::AppHandle,
    stopping: &BackendProcess,
) -> io::Result<ServiceRegistry> {
    let paths = shared_service_paths(app)?;
    if let Some(registry) = discover_shared_service(&paths.runtime)? {
        return Ok(registry);
    }
    spawn_shared_service(&paths)?;
    let deadline = Instant::now() + Duration::from_secs(20);
    let mut last_error = None;
    while Instant::now() < deadline {
        if stopping.is_stopping() {
            return Err(io::Error::new(
                io::ErrorKind::Interrupted,
                "desktop stopped during shared service startup",
            ));
        }
        match discover_shared_service(&paths.runtime) {
            Ok(Some(registry)) => return Ok(registry),
            Ok(None) => {}
            Err(error) => last_error = Some(error),
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(last_error.unwrap_or_else(|| {
        io::Error::new(
            io::ErrorKind::TimedOut,
            "timed out waiting for the shared osheep service",
        )
    }))
}

fn discover_shared_service(paths: &RuntimePaths) -> io::Result<Option<ServiceRegistry>> {
    let registry = match read_registry(paths) {
        Ok(registry) => registry,
        Err(osheep_instance::RegistryError::Io(error))
            if error.kind() == io::ErrorKind::NotFound =>
        {
            return Ok(None);
        }
        Err(_) => return Ok(None),
    };
    if registry.validate(&registry.service_version).is_err() {
        return Ok(None);
    }
    match verify_shared_service(&registry) {
        Ok(_) => {
            if registry.service_version != env!("CARGO_PKG_VERSION") {
                Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    format!(
                        "running osheep service version {} does not match desktop version {}",
                        registry.service_version,
                        env!("CARGO_PKG_VERSION")
                    ),
                ))
            } else {
                Ok(Some(registry))
            }
        }
        Err(_) => Ok(None),
    }
}

fn verify_shared_service(registry: &ServiceRegistry) -> io::Result<SocketAddr> {
    let address = registry
        .validate(&registry.service_version)
        .map_err(io::Error::other)?;
    let health: RuntimeHealthResponse =
        runtime_json_request::<serde_json::Value, _>(registry, "GET", "/api/runtime/health", None)?;
    if !health.ok
        || health.pid != registry.pid
        || health.service_version != registry.service_version
    {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "runtime health identity does not match the service registry",
        ));
    }
    Ok(address)
}

fn spawn_shared_service(paths: &SharedServicePaths) -> io::Result<()> {
    require_file(&paths.executable, "shared osheep service")?;
    require_file(
        &paths.frontend_root.join("index.html"),
        "frontend entry point",
    )?;
    let node_data = if cfg!(debug_assertions) {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../backend/.osheep")
    } else {
        paths
            .frontend_root
            .parent()
            .unwrap_or(&paths.frontend_root)
            .join("backend/.osheep")
    };
    migrate_node_data_to_rust(&node_data, &paths.data_root)?;
    if let Some(app_data) = paths.data_root.parent() {
        migrate_legacy_app_data_to_rust(app_data, &paths.data_root)?;
    }
    fs::create_dir_all(paths.data_root.join("workspaces"))?;
    fs::create_dir_all(paths.runtime.directory())?;
    fs::create_dir_all(&paths.log_dir)?;
    let stdout = OpenOptions::new()
        .create(true)
        .append(true)
        .open(paths.log_dir.join("rust-service.log"))?;
    let stderr = stdout.try_clone()?;
    let mut command = Command::new(&paths.executable);
    command
        .env("OSHEEP_HOST", "127.0.0.1")
        .env("OSHEEP_PORT", "0")
        .env("OSHEEP_RUNTIME_DIR", paths.runtime.directory())
        .env("OSHEEP_FRONTEND_ROOT", &paths.frontend_root)
        .env("OSHEEP_DATA_ROOT", &paths.data_root)
        .env("WORKSPACES_ROOT", paths.data_root.join("workspaces"))
        .env("OSHEEP_ALLOW_EXTERNAL_WORKSPACE_PATHS", "1")
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));
    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    let mut child = command.spawn()?;
    thread::spawn(move || {
        let _ = child.wait();
    });
    Ok(())
}

fn runtime_json_request<T: serde::Serialize + ?Sized, R: serde::de::DeserializeOwned>(
    registry: &ServiceRegistry,
    method: &str,
    path: &str,
    body: Option<&T>,
) -> io::Result<R> {
    let body = body
        .map(serde_json::to_vec)
        .transpose()
        .map_err(io::Error::other)?
        .unwrap_or_default();
    let response = runtime_http_request(registry, method, path, &body)?;
    serde_json::from_slice(&response).map_err(io::Error::other)
}

fn runtime_empty_request(registry: &ServiceRegistry, method: &str, path: &str) -> io::Result<()> {
    runtime_http_request(registry, method, path, &[]).map(|_| ())
}

fn runtime_http_request(
    registry: &ServiceRegistry,
    method: &str,
    path: &str,
    body: &[u8],
) -> io::Result<Vec<u8>> {
    let address = registry
        .validate(&registry.service_version)
        .map_err(io::Error::other)?;
    let mut stream = TcpStream::connect_timeout(&address, Duration::from_millis(500))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.set_write_timeout(Some(Duration::from_secs(2)))?;
    write!(
        stream,
        "{method} {path} HTTP/1.1\r\nHost: {address}\r\nAuthorization: Bearer {}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
        registry.token,
        body.len()
    )?;
    stream.write_all(body)?;
    stream.flush()?;
    let mut response = Vec::new();
    stream.read_to_end(&mut response)?;
    let header_end = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP response"))?;
    let headers = std::str::from_utf8(&response[..header_end])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))?;
    let status = headers
        .lines()
        .next()
        .and_then(|line| line.split_whitespace().nth(1))
        .and_then(|value| value.parse::<u16>().ok())
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidData, "invalid HTTP status"))?;
    if !(200..300).contains(&status) {
        return Err(io::Error::other(format!(
            "runtime service request failed with HTTP {status}"
        )));
    }
    Ok(response[header_end + 4..].to_vec())
}

fn javascript_string(value: &str) -> String {
    let mut output = String::with_capacity(value.len() + 2);
    output.push('"');
    for character in value.chars() {
        match character {
            '"' => output.push_str("\\\""),
            '\\' => output.push_str("\\\\"),
            '\n' => output.push_str("\\n"),
            '\r' => output.push_str("\\r"),
            '\u{2028}' => output.push_str("\\u2028"),
            '\u{2029}' => output.push_str("\\u2029"),
            character if character <= '\u{001f}' => {
                use std::fmt::Write;
                let _ = write!(output, "\\u{:04x}", character as u32);
            }
            character => output.push(character),
        }
    }
    output.push('"');
    output
}

fn startup_error_script(message: &str) -> String {
    format!(
        "window.__osheepStartupError({})",
        javascript_string(message)
    )
}

fn schedule_startup_error(handle: &tauri::AppHandle, backend: &BackendProcess, message: String) {
    if backend.is_stopping() {
        return;
    }
    let script = startup_error_script(&message);
    let main_handle = handle.clone();
    let main_backend = backend.clone();
    if let Err(error) = handle.run_on_main_thread(move || {
        if main_backend.is_stopping() {
            return;
        }
        match main_handle.get_webview_window("main") {
            Some(window) => {
                if let Err(error) = window.eval(script) {
                    eprintln!("failed to show startup error: {error}");
                }
            }
            None => eprintln!("main window closed before startup error display"),
        }
    }) {
        eprintln!("failed to schedule startup error display: {error}");
    }
}

fn remote_url() -> io::Result<Option<tauri::Url>> {
    let Some(raw) = env::var("OSHEEP_REMOTE_URL")
        .ok()
        .filter(|v| !v.trim().is_empty())
    else {
        return Ok(None);
    };
    let url = raw
        .trim()
        .trim_end_matches('/')
        .parse::<tauri::Url>()
        .map_err(|error| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("invalid OSHEEP_REMOTE_URL: {error}"),
            )
        })?;
    if !matches!(url.scheme(), "http" | "https") {
        return Err(io::Error::new(
            io::ErrorKind::InvalidInput,
            "OSHEEP_REMOTE_URL must use http or https",
        ));
    }
    Ok(Some(url))
}

pub fn run() {
    let app_result = tauri::Builder::default()
        .invoke_handler(tauri::generate_handler![
            pick_workspace_folder,
            pick_skill_folder,
            open_external_url,
            save_export_file
        ])
        .setup(|app| {
            let backend = BackendProcess::default();
            app.manage(backend.clone());
            let shared_service = SharedServiceClient::default();
            app.manage(shared_service.clone());

            if let Some(url) = remote_url()? {
                let builder = WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                    .title("Osheep")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(960.0, 640.0);
                #[cfg(target_os = "windows")]
                let builder = builder.decorations(false);
                builder.build()?;
                return Ok(());
            }

            let startup_ui = StartupUi::default();
            let page_ui = startup_ui.clone();
            let page_backend = backend.clone();
            let configured_theme = startup_theme(app.handle());
            let startup_url = format!("index.html?osheepTheme={configured_theme}");
            let builder =
                WebviewWindowBuilder::new(app, "main", WebviewUrl::App(startup_url.into()))
                    .title("Osheep")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(960.0, 640.0);
            #[cfg(target_os = "windows")]
            let builder = builder.decorations(false);
            builder
                .on_page_load(move |window, payload| {
                    if payload.event() == PageLoadEvent::Finished {
                        if let Some(message) = page_ui.mark_shell_loaded() {
                            schedule_startup_error(window.app_handle(), &page_backend, message);
                        }
                    }
                })
                .build()?;

            let handle = app.handle().clone();
            thread::spawn(move || {
                let outcome = (|| -> io::Result<SocketAddr> {
                    let registry = ensure_shared_service(&handle, &backend)?;
                    shared_service.start(registry)
                })();

                match outcome {
                    Ok(address) => {
                        if backend.is_stopping() {
                            return;
                        }
                        // The bundled shell is the desktop loading page. Skip the
                        // web app's initial splash on this navigation so Windows
                        // never shows two consecutive loading screens.
                        let theme_query = format!("&osheepTheme={configured_theme}");
                        let url = match format!("http://{address}/?osheepDesktop=1{theme_query}")
                            .parse::<tauri::Url>()
                        {
                            Ok(url) => url,
                            Err(error) => {
                                eprintln!("failed to parse local backend URL: {error}");
                                backend.cleanup_startup_failure();
                                shared_service.stop();
                                return;
                            }
                        };
                        let main_handle = handle.clone();
                        let main_backend = backend.clone();
                        let main_shared_service = shared_service.clone();
                        if let Err(error) = handle.run_on_main_thread(move || {
                            if main_backend.is_stopping() {
                                return;
                            }
                            match main_handle.get_webview_window("main") {
                                Some(window) => {
                                    if let Err(error) = window.navigate(url) {
                                        eprintln!("failed to navigate main window: {error}");
                                        main_backend.cleanup_startup_failure();
                                        main_shared_service.stop();
                                    }
                                }
                                None => {
                                    eprintln!("main window closed before backend became ready");
                                    main_backend.cleanup_startup_failure();
                                    main_shared_service.stop();
                                }
                            }
                        }) {
                            eprintln!("failed to schedule main-window navigation: {error}");
                            backend.cleanup_startup_failure();
                            shared_service.stop();
                        }
                    }
                    Err(error) => {
                        if let Some(message) = startup_ui.queue_error(error.to_string()) {
                            schedule_startup_error(&handle, &backend, message);
                        }
                    }
                }
            });
            Ok(())
        })
        .build(tauri::generate_context!());

    let app = match app_result {
        Ok(app) => app,
        Err(error) => {
            let diagnostic = format!("failed to start osheep desktop: {error:?}\n");
            let _ = fs::write(
                env::temp_dir().join("osheep-desktop-startup.log"),
                diagnostic,
            );
            return;
        }
    };

    app.run(|handle, event| {
        if matches!(
            event,
            tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
        ) {
            handle.state::<BackendProcess>().stop();
            handle.state::<SharedServiceClient>().stop();
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;

    fn unique_temp_dir(label: &str) -> PathBuf {
        use std::time::SystemTime;

        env::temp_dir().join(format!(
            "osheep-{label}-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("system time after Unix epoch")
                .as_nanos()
        ))
    }

    #[test]
    fn javascript_string_escapes_script_sensitive_characters() {
        assert_eq!(
            javascript_string("\\\"\n\r\t\u{0008}\u{2028}\u{2029}"),
            "\"\\\\\\\"\\n\\r\\u0009\\u0008\\u2028\\u2029\""
        );
    }

    #[test]
    fn startup_error_script_calls_loaded_page_callback() {
        assert_eq!(
            startup_error_script("bad \\\"input\n"),
            "window.__osheepStartupError(\"bad \\\\\\\"input\\n\")"
        );
    }

    #[test]
    fn startup_ui_flushes_error_after_shell_load() {
        let ui = StartupUi::default();
        assert_eq!(ui.queue_error("startup failed".into()), None);
        assert_eq!(ui.mark_shell_loaded(), Some("startup failed".into()));
        assert_eq!(ui.mark_shell_loaded(), None);
    }

    #[test]
    fn startup_ui_dispatches_error_immediately_after_shell_load() {
        let ui = StartupUi::default();
        assert_eq!(ui.mark_shell_loaded(), None);
        assert_eq!(
            ui.queue_error("startup failed".into()),
            Some("startup failed".into())
        );
    }

    #[test]
    fn desktop_persistent_data_is_merged_verified_and_removed_from_appdata() {
        let root = unique_temp_dir("persistent-data-migration");
        let legacy = root.join("appdata");
        let target = root.join("install/backend/.osheep");
        let legacy_workspaces = legacy.join("workspaces");
        let target_workspaces = target.join("workspaces");
        fs::create_dir_all(legacy_workspaces.join("new-project/.osheep"))
            .expect("create legacy workspace");
        fs::create_dir_all(legacy_workspaces.join("conflict-project"))
            .expect("create legacy conflict");
        fs::create_dir_all(target_workspaces.join("conflict-project"))
            .expect("create target conflict");
        fs::write(
            legacy_workspaces.join("new-project/.osheep/settings.json"),
            b"new",
        )
        .expect("write legacy workspace");
        fs::write(
            legacy_workspaces.join("conflict-project/data.json"),
            b"legacy",
        )
        .expect("write legacy conflict");
        fs::write(
            target_workspaces.join("conflict-project/data.json"),
            b"current",
        )
        .expect("write target conflict");
        fs::write(
            legacy.join("workspace-root.json"),
            format!(
                "{{\n  \"root\": \"{}\"\n}}",
                legacy_workspaces.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write workspace config");

        migrate_desktop_persistent_data(&legacy, &target).expect("migrate desktop data");

        assert_eq!(
            fs::read(target_workspaces.join("new-project/.osheep/settings.json"))
                .expect("read migrated workspace"),
            b"new"
        );
        assert_eq!(
            fs::read(target_workspaces.join("conflict-project/data.json"))
                .expect("read current conflict"),
            b"current"
        );
        let conflict_files = fs::read_dir(target.join("migration-conflicts"))
            .expect("read conflict root")
            .collect::<Result<Vec<_>, _>>()
            .expect("read conflict entries");
        assert_eq!(conflict_files.len(), 1);
        assert_eq!(
            fs::read(
                conflict_files[0]
                    .path()
                    .join("workspaces/conflict-project/data.json")
            )
            .expect("read preserved legacy conflict"),
            b"legacy"
        );
        let config = fs::read_to_string(target.join("workspace-root.json"))
            .expect("read migrated workspace config");
        assert!(config.contains(&target_workspaces.to_string_lossy().replace('\\', "\\\\")));
        assert!(!legacy_workspaces.exists());
        assert!(!legacy.join("workspace-root.json").exists());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn node_data_migration_copies_verifies_and_preserves_rollback_source() {
        let root = unique_temp_dir("node-to-rust-migration");
        let source = root.join("backend/.osheep");
        let destination = root.join("appdata/data");
        fs::create_dir_all(source.join("workspaces/demo")).expect("create source workspace");
        fs::create_dir_all(destination.join("workspaces/demo"))
            .expect("create destination workspace");
        fs::write(source.join("settings.json"), b"source settings").expect("write settings");
        fs::write(source.join("workspaces/demo/note.txt"), b"source note")
            .expect("write source note");
        fs::write(
            destination.join("workspaces/demo/note.txt"),
            b"current note",
        )
        .expect("write current note");
        fs::write(
            source.join("workspace-root.json"),
            format!(
                "{{\"root\":\"{}\"}}",
                source
                    .join("workspaces")
                    .to_string_lossy()
                    .replace('\\', "\\\\")
            ),
        )
        .expect("write workspace root");

        migrate_node_data_to_rust(&source, &destination).expect("migrate node data");

        assert_eq!(
            fs::read(source.join("settings.json")).expect("source remains"),
            b"source settings"
        );
        assert_eq!(
            fs::read(destination.join("settings.json")).expect("settings copied"),
            b"source settings"
        );
        assert_eq!(
            fs::read(destination.join("workspaces/demo/note.txt")).expect("current preserved"),
            b"current note"
        );
        let conflict = fs::read_dir(destination.join("migration-conflicts"))
            .expect("conflict root")
            .next()
            .expect("conflict entry")
            .expect("valid conflict entry")
            .path()
            .join("workspaces/demo/note.txt");
        assert_eq!(
            fs::read(conflict).expect("source conflict preserved"),
            b"source note"
        );
        let workspace_config =
            fs::read_to_string(destination.join("workspace-root.json")).expect("workspace config");
        assert!(workspace_config.contains(
            &destination
                .join("workspaces")
                .to_string_lossy()
                .replace('\\', "\\\\")
        ));
        assert!(destination.join("migration-node-v1.json").is_file());
        fs::write(source.join("settings.json"), b"changed after marker")
            .expect("change source after migration");
        migrate_node_data_to_rust(&source, &destination).expect("repeat migration");
        assert_eq!(
            fs::read(destination.join("settings.json")).expect("marker prevents replay"),
            b"source settings"
        );
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn legacy_app_data_migration_copies_conflicts_and_preserves_source() {
        let root = unique_temp_dir("legacy-appdata-to-rust-migration");
        let legacy = root.join("appdata");
        let destination = legacy.join("data");
        let legacy_workspaces = legacy.join("workspaces");
        let destination_workspaces = destination.join("workspaces");
        fs::create_dir_all(legacy_workspaces.join("new-project/.osheep"))
            .expect("create legacy workspace");
        fs::create_dir_all(legacy_workspaces.join("conflict-project"))
            .expect("create legacy conflict workspace");
        fs::create_dir_all(destination_workspaces.join("conflict-project"))
            .expect("create destination conflict workspace");
        fs::write(
            legacy_workspaces.join("new-project/.osheep/settings.json"),
            b"legacy settings",
        )
        .expect("write legacy settings");
        fs::write(
            legacy_workspaces.join("conflict-project/note.txt"),
            b"legacy note",
        )
        .expect("write legacy conflict");
        fs::write(
            destination_workspaces.join("conflict-project/note.txt"),
            b"current note",
        )
        .expect("write destination conflict");
        fs::write(
            legacy.join("workspace-root.json"),
            format!(
                "{{\"root\":\"{}\"}}",
                legacy_workspaces.to_string_lossy().replace('\\', "\\\\")
            ),
        )
        .expect("write legacy workspace root");

        migrate_legacy_app_data_to_rust(&legacy, &destination).expect("migrate legacy app data");

        assert_eq!(
            fs::read(legacy_workspaces.join("new-project/.osheep/settings.json"))
                .expect("legacy source remains"),
            b"legacy settings"
        );
        assert_eq!(
            fs::read(destination_workspaces.join("new-project/.osheep/settings.json"))
                .expect("settings copied"),
            b"legacy settings"
        );
        assert_eq!(
            fs::read(destination_workspaces.join("conflict-project/note.txt"))
                .expect("destination conflict preserved"),
            b"current note"
        );
        let conflict = fs::read_dir(destination.join("migration-conflicts"))
            .expect("conflict root")
            .next()
            .expect("conflict entry")
            .expect("valid conflict entry")
            .path()
            .join("workspaces/conflict-project/note.txt");
        assert_eq!(
            fs::read(conflict).expect("legacy conflict preserved"),
            b"legacy note"
        );
        assert!(legacy.join("workspace-root.json").is_file());
        let workspace_config =
            fs::read_to_string(destination.join("workspace-root.json")).expect("workspace config");
        assert!(workspace_config.contains(
            &destination_workspaces
                .to_string_lossy()
                .replace('\\', "\\\\")
        ));
        assert!(destination.join("migration-appdata-v1.json").is_file());

        fs::write(
            legacy_workspaces.join("added-after-marker.txt"),
            b"do not replay",
        )
        .expect("change source after migration");
        migrate_legacy_app_data_to_rust(&legacy, &destination)
            .expect("repeat legacy app data migration");
        assert!(!destination_workspaces
            .join("added-after-marker.txt")
            .exists());
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn shared_service_health_verifies_registry_identity_and_bearer() {
        let listener = std::net::TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .expect("bind fake service");
        let address = listener.local_addr().expect("fake service address");
        let token = "t".repeat(64);
        let registry = ServiceRegistry::new(env!("CARGO_PKG_VERSION"), address, token.clone());
        let expected_pid = registry.pid;
        let server = thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept health request");
            stream
                .set_read_timeout(Some(Duration::from_secs(2)))
                .expect("set read timeout");
            let mut request = Vec::new();
            let mut buffer = [0_u8; 1024];
            loop {
                let read = stream.read(&mut buffer).expect("read request");
                request.extend_from_slice(&buffer[..read]);
                if read == 0 || request.windows(4).any(|window| window == b"\r\n\r\n") {
                    break;
                }
            }
            let request = String::from_utf8(request).expect("request UTF-8");
            assert!(request.starts_with("GET /api/runtime/health HTTP/1.1\r\n"));
            assert!(request.contains(&format!("Authorization: Bearer {token}\r\n")));
            let body = serde_json::to_vec(&RuntimeHealthResponse {
                ok: true,
                service_version: env!("CARGO_PKG_VERSION").into(),
                pid: expected_pid,
            })
            .expect("health JSON");
            write!(
                stream,
                "HTTP/1.1 200 OK\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                body.len()
            )
            .expect("write headers");
            stream.write_all(&body).expect("write body");
        });

        assert_eq!(verify_shared_service(&registry).unwrap(), address);
        server.join().expect("join fake service");
    }

    #[cfg(target_os = "windows")]
    #[test]
    fn spawn_after_stop_does_not_start_command() {
        use std::{os::windows::process::CommandExt, time::SystemTime};

        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        let marker = env::temp_dir().join(format!(
            "osheep-spawn-after-stop-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(SystemTime::UNIX_EPOCH)
                .expect("system time after Unix epoch")
                .as_nanos()
        ));
        let backend = BackendProcess::default();
        backend.stop();
        let mut command = Command::new("cmd");
        command
            .args(["/C", &format!("type nul > \\\"{}\\\"", marker.display())])
            .creation_flags(CREATE_NO_WINDOW);

        let error = backend
            .spawn(&mut command)
            .expect_err("spawn must reject after stop");
        assert_eq!(error.kind(), io::ErrorKind::Interrupted);
        assert!(!marker.exists(), "rejected command still ran");
    }
}
