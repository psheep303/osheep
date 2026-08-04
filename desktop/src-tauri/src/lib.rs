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
    time::{Duration, Instant},
};
use tauri::{Manager, WebviewUrl, WebviewWindowBuilder};

#[derive(Default)]
struct BackendProcessState {
    child: Option<Child>,
    stopping: bool,
}

#[derive(Clone, Default)]
struct BackendProcess(Arc<Mutex<BackendProcessState>>);

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

impl BackendProcess {
    fn store(&self, child: Child) -> Result<(), Child> {
        let Ok(mut state) = self.0.lock() else {
            return Err(child);
        };
        if state.stopping {
            Err(child)
        } else {
            state.child = Some(child);
            Ok(())
        }
    }

    fn child_exited(&self) -> io::Result<Option<std::process::ExitStatus>> {
        let mut state = self
            .0
            .lock()
            .map_err(|_| io::Error::other("backend mutex poisoned"))?;
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

    fn stop(&self) {
        let Ok(mut state) = self.0.lock() else {
            return;
        };
        state.stopping = true;
        let Some(mut child) = state.child.take() else {
            return;
        };
        drop(state);
        terminate_child(&mut child);
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
    Ok(BackendPaths {
        node: resources.join("sidecar/node.exe"),
        script: resources.join("backend/dist/index.js"),
        working_dir: resources.join("backend"),
        frontend_root: resources.join("frontend"),
        system_templates_root: resources.join("backend/template-library/system"),
    })
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

fn spawn_local_backend(app: &tauri::AppHandle, port: u16) -> io::Result<Child> {
    let paths = local_backend_paths(app)?;
    let node = node_path(&paths.node);
    let script = node_path(&paths.script);
    let working_dir = node_path(&paths.working_dir);
    let frontend_root = node_path(&paths.frontend_root);
    let system_templates_root = node_path(&paths.system_templates_root);
    require_file(&script, "backend entry point")?;
    require_file(&frontend_root.join("index.html"), "frontend entry point")?;

    let data_dir = node_path(&app.path().app_local_data_dir().map_err(io::Error::other)?);
    let log_dir = app.path().app_log_dir().map_err(io::Error::other)?;
    fs::create_dir_all(data_dir.join("workspaces"))?;
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
            data_dir.join("workspaces").to_string_lossy().as_ref(),
        )
        .env(
            "OSHEEP_WORKSPACE_ROOT_CONFIG",
            data_dir.join("workspace-root.json").to_string_lossy().as_ref(),
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

    command.spawn()
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
        .invoke_handler(tauri::generate_handler![pick_workspace_folder])
        .setup(|app| {
            let backend = BackendProcess::default();
            app.manage(backend.clone());

            if let Some(url) = remote_url()? {
                WebviewWindowBuilder::new(app, "main", WebviewUrl::External(url))
                    .title("Osheep")
                    .inner_size(1440.0, 900.0)
                    .min_inner_size(960.0, 640.0)
                    .build()?;
                return Ok(());
            }

            let window = WebviewWindowBuilder::new(
                app,
                "main",
                WebviewUrl::App("index.html".into()),
            )
            .title("Osheep")
            .inner_size(1440.0, 900.0)
            .min_inner_size(960.0, 640.0)
            .build()?;

            let handle = app.handle().clone();
            thread::spawn(move || {
                let outcome = (|| -> io::Result<u16> {
                    let port = reserve_port()?;
                    let child = spawn_local_backend(&handle, port)?;
                    if let Err(mut child) = backend.store(child) {
                        terminate_child(&mut child);
                        return Err(io::Error::new(
                            io::ErrorKind::Interrupted,
                            "desktop stopped during backend startup",
                        ));
                    }
                    wait_until_listening(&backend, port)?;
                    Ok(port)
                })();

                match outcome {
                    Ok(port) => {
                        let url = format!("http://127.0.0.1:{port}")
                            .parse::<tauri::Url>()
                            .expect("local backend URL");
                        let _ = handle.run_on_main_thread(move || {
                            let _ = window.navigate(url);
                        });
                    }
                    Err(error) => {
                        backend.stop();
                        let script = format!(
                            "window.__osheepStartupError({})",
                            javascript_string(&error.to_string())
                        );
                        let _ = handle.run_on_main_thread(move || {
                            let _ = window.eval(script);
                        });
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
