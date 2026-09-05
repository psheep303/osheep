use osheep_contract::{RuntimeClientResponse, RuntimeHealthResponse};
use osheep_instance::{read_registry, RuntimePaths};
use reqwest::header::AUTHORIZATION;
use std::net::TcpListener;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

struct ManagedChild {
    child: Child,
}

impl ManagedChild {
    fn spawn(runtime: &Path, workspaces: &Path, port: u16) -> Self {
        let child = Command::new(env!("CARGO_BIN_EXE_osheep-server"))
            .env("OSHEEP_RUNTIME_DIR", runtime)
            .env("OSHEEP_HOST", "127.0.0.1")
            .env("OSHEEP_PORT", port.to_string())
            .env("WORKSPACES_ROOT", workspaces)
            .env("OSHEEP_DATA_ROOT", runtime.join("data"))
            .env("OSHEEP_SERVICE_IDLE_TIMEOUT_MS", "500")
            .env("OSHEEP_CLIENT_LEASE_TIMEOUT_MS", "2000")
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .expect("spawn managed osheep server");
        Self { child }
    }

    fn wait_timeout(&mut self, timeout: Duration) -> Option<std::process::ExitStatus> {
        let deadline = Instant::now() + timeout;
        while Instant::now() < deadline {
            if let Some(status) = self.child.try_wait().expect("poll child") {
                return Some(status);
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        None
    }
}

impl Drop for ManagedChild {
    fn drop(&mut self) {
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }
}

fn temp_dir(label: &str) -> PathBuf {
    std::env::temp_dir().join(format!(
        "osheep-managed-{label}-{}-{}",
        std::process::id(),
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ))
}

async fn wait_for_registry(paths: &RuntimePaths) -> osheep_instance::ServiceRegistry {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(registry) = read_registry(paths) {
            if registry.validate(env!("CARGO_PKG_VERSION")).is_ok() {
                return registry;
            }
        }
        assert!(
            Instant::now() < deadline,
            "managed registry was not published"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

async fn wait_for_replacement_registry(
    paths: &RuntimePaths,
    previous_pid: u32,
) -> osheep_instance::ServiceRegistry {
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        if let Ok(registry) = read_registry(paths) {
            if registry.pid != previous_pid && registry.validate(env!("CARGO_PKG_VERSION")).is_ok()
            {
                return registry;
            }
        }
        assert!(
            Instant::now() < deadline,
            "stale managed registry was not replaced"
        );
        tokio::time::sleep(Duration::from_millis(20)).await;
    }
}

#[tokio::test]
async fn managed_server_registers_clients_and_stops_after_last_detach() {
    let root = temp_dir("lifecycle");
    let runtime_dir = root.join("runtime");
    let workspaces = root.join("data/workspaces");
    let paths = RuntimePaths::new(&runtime_dir);
    let mut server = ManagedChild::spawn(&runtime_dir, &workspaces, 0);
    let registry = wait_for_registry(&paths).await;
    let address = registry.validate(env!("CARGO_PKG_VERSION")).unwrap();
    assert_eq!(registry.pid, server.child.id());
    let base = format!("http://{address}");
    let bearer = format!("Bearer {}", registry.token);
    let client = reqwest::Client::new();

    let unauthorized = client
        .get(format!("{base}/api/runtime/health"))
        .send()
        .await
        .unwrap();
    assert_eq!(unauthorized.status(), reqwest::StatusCode::UNAUTHORIZED);

    let health: RuntimeHealthResponse = client
        .get(format!("{base}/api/runtime/health"))
        .header(AUTHORIZATION, &bearer)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(health.pid, registry.pid);
    assert_eq!(health.service_version, env!("CARGO_PKG_VERSION"));

    let wrong_version = client
        .post(format!("{base}/api/runtime/clients"))
        .header(AUTHORIZATION, &bearer)
        .json(&serde_json::json!({
            "clientId": "desktop_wrong_version",
            "clientVersion": "9.0.0"
        }))
        .send()
        .await
        .unwrap();
    assert_eq!(wrong_version.status(), reqwest::StatusCode::CONFLICT);

    let attached: RuntimeClientResponse = client
        .post(format!("{base}/api/runtime/clients"))
        .header(AUTHORIZATION, &bearer)
        .json(&serde_json::json!({
            "clientId": "desktop_client_123",
            "clientVersion": env!("CARGO_PKG_VERSION")
        }))
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap()
        .json()
        .await
        .unwrap();
    assert_eq!(attached.client_id, "desktop_client_123");
    tokio::time::sleep(Duration::from_millis(650)).await;
    assert!(server.child.try_wait().unwrap().is_none());

    client
        .delete(format!("{base}/api/runtime/clients/desktop_client_123"))
        .header(AUTHORIZATION, &bearer)
        .send()
        .await
        .unwrap()
        .error_for_status()
        .unwrap();
    assert!(server.wait_timeout(Duration::from_secs(3)).is_some());
    assert!(!paths.registry_file().exists());
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn concurrent_start_keeps_one_registered_service() {
    let root = temp_dir("concurrent");
    let runtime_dir = root.join("runtime");
    let workspaces = root.join("data/workspaces");
    let paths = RuntimePaths::new(&runtime_dir);
    let mut first = ManagedChild::spawn(&runtime_dir, &workspaces, 0);
    let registry = wait_for_registry(&paths).await;
    let mut second = ManagedChild::spawn(&runtime_dir, &workspaces, 0);
    let second_status = second
        .wait_timeout(Duration::from_secs(3))
        .expect("competing server did not exit");
    assert!(!second_status.success());
    assert_eq!(read_registry(&paths).unwrap().pid, registry.pid);
    assert!(first.child.try_wait().unwrap().is_none());
    let _ = first.child.kill();
    let _ = first.child.wait();
    let deadline = Instant::now() + Duration::from_secs(2);
    while paths.registry_file().exists() && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[tokio::test]
async fn crashed_service_registry_is_replaced_by_next_owner() {
    let root = temp_dir("crash-takeover");
    let runtime_dir = root.join("runtime");
    let workspaces = root.join("data/workspaces");
    let paths = RuntimePaths::new(&runtime_dir);
    let mut crashed = ManagedChild::spawn(&runtime_dir, &workspaces, 0);
    let stale = wait_for_registry(&paths).await;
    crashed.child.kill().unwrap();
    crashed.child.wait().unwrap();
    assert!(paths.registry_file().is_file());

    let mut replacement = ManagedChild::spawn(&runtime_dir, &workspaces, 0);
    let current = wait_for_replacement_registry(&paths, stale.pid).await;
    assert_eq!(current.pid, replacement.child.id());
    assert_ne!(current.token, stale.token);
    replacement.child.kill().unwrap();
    replacement.child.wait().unwrap();
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn occupied_port_fails_without_publishing_registry() {
    let root = temp_dir("occupied-port");
    let runtime_dir = root.join("runtime");
    let workspaces = root.join("data/workspaces");
    let paths = RuntimePaths::new(&runtime_dir);
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    let mut server = ManagedChild::spawn(&runtime_dir, &workspaces, port);
    let status = server
        .wait_timeout(Duration::from_secs(3))
        .expect("server did not fail on occupied port");
    assert!(!status.success());
    assert!(!paths.registry_file().exists());
    drop(listener);
    std::fs::remove_dir_all(root).unwrap();
}
