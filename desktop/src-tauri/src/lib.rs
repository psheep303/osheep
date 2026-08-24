use rfd::AsyncFileDialog;
use std::{
    env,
    fs::{self, File},
    io,
    net::{IpAddr, Ipv4Addr, SocketAddr, TcpListener, TcpStream},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{Arc, Mutex},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};
use tauri::{webview::PageLoadEvent, Manager, WebviewUrl, WebviewWindowBuilder};

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

struct BackendPaths {
    node: PathBuf,
    script: PathBuf,
    working_dir: PathBuf,
    frontend_root: PathBuf,
    system_templates_root: PathBuf,
}

fn local_backend_paths(app: &tauri::AppHandle) -> io::Result<BackendPaths> {
    if cfg!(debug_assertions) {
        let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../..");
        let node = env::var_os("OSHEEP_NODE_BINARY")
            .map(PathBuf::from)
            .unwrap_or_else(|| PathBuf::from("node"));
        return Ok(BackendPaths {
            node,
            script: root.join("backend/dist/index.js"),
            working_dir: root.join("backend"),
            frontend_root: root.join("frontend/dist"),
            system_templates_root: root.join("backend/template-library/system"),
        });
    }

    let resources = app.path().resource_dir().map_err(io::Error::other)?;
    let data_dir = app.path().app_local_data_dir().map_err(io::Error::other)?;
    let node = materialize_bundled_node(&resources.join("sidecar/node.exe"), &data_dir)?;
    Ok(BackendPaths {
        node,
        script: resources.join("backend/dist/index.js"),
        working_dir: resources.join("backend"),
        frontend_root: resources.join("frontend"),
        system_templates_root: resources.join("backend/template-library/system"),
    })
}

fn materialize_bundled_node(source: &Path, data_dir: &Path) -> io::Result<PathBuf> {
    require_file(source, "bundled Node executable")?;

    // Running an executable directly from the install directory locks it on
    // Windows and prevents NSIS from replacing it during an upgrade.
    let runtime_dir = data_dir.join("runtime").join(env!("CARGO_PKG_VERSION"));
    let destination = runtime_dir.join("node.exe");
    if destination.is_file() {
        return Ok(destination);
    }
    if destination.exists() {
        return Err(io::Error::new(
            io::ErrorKind::AlreadyExists,
            format!(
                "bundled Node runtime path is not a file: {}",
                destination.display()
            ),
        ));
    }

    fs::create_dir_all(&runtime_dir)?;
    let temporary = runtime_dir.join(format!("node.exe.{}.tmp", std::process::id()));
    match fs::remove_file(&temporary) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::NotFound => {}
        Err(error) => return Err(error),
    }
    if let Err(error) = fs::copy(source, &temporary) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    match fs::rename(&temporary, &destination) {
        Ok(()) => Ok(destination),
        Err(_) if destination.is_file() => {
            // Another app instance completed the same atomic copy first.
            let _ = fs::remove_file(&temporary);
            Ok(destination)
        }
        Err(error) => {
            let _ = fs::remove_file(&temporary);
            Err(error)
        }
    }
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
        fs::write(config_path, replaced)?;
    }
    Ok(())
}

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
    let settings = local_backend_paths(app)
        .ok()
        .and_then(|paths| fs::read_to_string(paths.working_dir.join(".osheep/settings.json")).ok())
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

fn node_path(path: &Path) -> PathBuf {
    let text = path.to_string_lossy();
    text.strip_prefix("\\\\?\\")
        .map(PathBuf::from)
        .unwrap_or_else(|| path.to_path_buf())
}

fn reserve_port() -> io::Result<u16> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
    Ok(listener.local_addr()?.port())
}

fn wait_until_listening(backend: &BackendProcess, port: u16) -> io::Result<()> {
    let address = SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), port);
    let deadline = Instant::now() + Duration::from_secs(20);
    while Instant::now() < deadline {
        if let Some(status) = backend.child_exited()? {
            return Err(io::Error::other(format!(
                "osheep backend exited before startup ({status})"
            )));
        }
        if TcpStream::connect_timeout(&address, Duration::from_millis(100)).is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(25));
    }
    Err(io::Error::new(
        io::ErrorKind::TimedOut,
        "timed out waiting for the osheep backend",
    ))
}

fn local_backend_command(app: &tauri::AppHandle, port: u16) -> io::Result<Command> {
    let paths = local_backend_paths(app)?;
    let node = node_path(&paths.node);
    let script = node_path(&paths.script);
    let working_dir = node_path(&paths.working_dir);
    let frontend_root = node_path(&paths.frontend_root);
    let system_templates_root = node_path(&paths.system_templates_root);
    require_file(&script, "backend entry point")?;
    require_file(&frontend_root.join("index.html"), "frontend entry point")?;

    let data_dir = node_path(&app.path().app_local_data_dir().map_err(io::Error::other)?);
    let backend_data = working_dir.join(".osheep");
    let log_dir = app.path().app_log_dir().map_err(io::Error::other)?;
    migrate_desktop_persistent_data(&data_dir, &backend_data)?;
    fs::create_dir_all(backend_data.join("workspaces"))?;
    fs::create_dir_all(&log_dir)?;
    let _ = fs::write(
        log_dir.join("startup-command.log"),
        format!(
            "node={:?}\nscript={:?}\nworking_dir={:?}\nfrontend_root={:?}\nsystem_templates_root={:?}\ndata_dir={:?}\n",
            node, script, working_dir, frontend_root, system_templates_root, data_dir
        ),
    );
    let stdout = File::create(log_dir.join("backend.log"))?;
    let stderr = stdout.try_clone()?;

    let mut command = Command::new(&node);
    command
        // Use a relative entry after setting current_dir; Node on Windows can
        // misparse an absolute drive-letter argument from a bundled resource.
        .arg("dist/index.js")
        .current_dir(&working_dir)
        .env("NODE_ENV", "production")
        .env("OSHEEP_HOST", "127.0.0.1")
        .env("OSHEEP_PORT", port.to_string())
        .env("OSHEEP_ALLOW_EXTERNAL_WORKSPACE_PATHS", "1")
        .env(
            "OSHEEP_FRONTEND_ROOT",
            frontend_root.to_string_lossy().as_ref(),
        )
        .env(
            "OSHEEP_SYSTEM_TEMPLATES_ROOT",
            system_templates_root.to_string_lossy().as_ref(),
        )
        .env(
            "WORKSPACES_ROOT",
            backend_data.join("workspaces").to_string_lossy().as_ref(),
        )
        .env(
            "OSHEEP_WORKSPACE_ROOT_CONFIG",
            backend_data
                .join("workspace-root.json")
                .to_string_lossy()
                .as_ref(),
        )
        .env(
            "OSHEEP_TEMPLATES_ROOT",
            backend_data.join("templates").to_string_lossy().as_ref(),
        )
        .stdin(Stdio::null())
        .stdout(Stdio::from(stdout))
        .stderr(Stdio::from(stderr));

    #[cfg(target_os = "windows")]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }

    Ok(command)
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
                let outcome = (|| -> io::Result<u16> {
                    let port = reserve_port()?;
                    let mut command = local_backend_command(&handle, port)?;
                    backend.spawn(&mut command)?;
                    if let Err(error) = wait_until_listening(&backend, port) {
                        backend.cleanup_startup_failure();
                        return Err(error);
                    }
                    Ok(port)
                })();

                match outcome {
                    Ok(port) => {
                        if backend.is_stopping() {
                            return;
                        }
                        // The bundled shell is the desktop loading page. Skip the
                        // web app's initial splash on this navigation so Windows
                        // never shows two consecutive loading screens.
                        let theme_query = format!("&osheepTheme={configured_theme}");
                        let url =
                            match format!("http://127.0.0.1:{port}/?osheepDesktop=1{theme_query}")
                                .parse::<tauri::Url>()
                            {
                                Ok(url) => url,
                                Err(error) => {
                                    eprintln!("failed to parse local backend URL: {error}");
                                    backend.cleanup_startup_failure();
                                    return;
                                }
                            };
                        let main_handle = handle.clone();
                        let main_backend = backend.clone();
                        if let Err(error) = handle.run_on_main_thread(move || {
                            if main_backend.is_stopping() {
                                return;
                            }
                            match main_handle.get_webview_window("main") {
                                Some(window) => {
                                    if let Err(error) = window.navigate(url) {
                                        eprintln!("failed to navigate main window: {error}");
                                        main_backend.cleanup_startup_failure();
                                    }
                                }
                                None => {
                                    eprintln!("main window closed before backend became ready");
                                    main_backend.cleanup_startup_failure();
                                }
                            }
                        }) {
                            eprintln!("failed to schedule main-window navigation: {error}");
                            backend.cleanup_startup_failure();
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
    fn bundled_node_is_copied_to_versioned_runtime_directory() {
        let root = unique_temp_dir("bundled-node-copy");
        let source = root.join("resources/sidecar/node.exe");
        let data_dir = root.join("data");
        fs::create_dir_all(source.parent().expect("source parent")).expect("create resources");
        fs::write(&source, b"bundled node").expect("write source");

        let runtime = materialize_bundled_node(&source, &data_dir).expect("copy bundled node");

        assert_eq!(
            runtime,
            data_dir
                .join("runtime")
                .join(env!("CARGO_PKG_VERSION"))
                .join("node.exe")
        );
        assert_eq!(fs::read(runtime).expect("read runtime"), b"bundled node");
        fs::remove_dir_all(root).expect("remove test directory");
    }

    #[test]
    fn existing_bundled_node_runtime_is_reused() {
        let root = unique_temp_dir("bundled-node-reuse");
        let source = root.join("resources/sidecar/node.exe");
        let data_dir = root.join("data");
        let runtime = data_dir
            .join("runtime")
            .join(env!("CARGO_PKG_VERSION"))
            .join("node.exe");
        fs::create_dir_all(source.parent().expect("source parent")).expect("create resources");
        fs::create_dir_all(runtime.parent().expect("runtime parent")).expect("create runtime");
        fs::write(&source, b"new source").expect("write source");
        fs::write(&runtime, b"existing runtime").expect("write runtime");

        assert_eq!(
            materialize_bundled_node(&source, &data_dir).expect("reuse runtime"),
            runtime
        );
        assert_eq!(
            fs::read(&runtime).expect("read runtime"),
            b"existing runtime"
        );
        fs::remove_dir_all(root).expect("remove test directory");
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
