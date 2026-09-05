use osheep_instance::{RuntimePaths, ServiceLock, ServiceRegistry};
use osheep_pty::NativePtyRuntime;
use osheep_server::{build_app_with_runtime, RuntimeControl, ServerConfig};
use std::env;
use std::sync::Arc;
use std::time::Duration;
use tracing_subscriber::EnvFilter;
use uuid::Uuid;

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    tracing_subscriber::fmt()
        .with_env_filter(EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()))
        .init();
    let mut config = ServerConfig::from_env()?;
    let managed = managed_service_config(&config)?;
    if let Some(managed) = &managed {
        config.auth_token = Some(managed.token.clone());
    }
    let address = format!("{}:{}", config.host, config.port);
    let runtime = Arc::new(
        NativePtyRuntime::new(config.max_terminal_sessions)
            .with_idle_timeout(Duration::from_millis(config.terminal_idle_timeout_ms)),
    );
    let listener = tokio::net::TcpListener::bind(&address).await?;
    let local_address = listener.local_addr()?;
    let runtime_control = managed.as_ref().map(|managed| {
        RuntimeControl::new(
            env!("CARGO_PKG_VERSION"),
            managed.idle_timeout,
            managed.lease_timeout,
        )
    });
    let app = build_app_with_runtime(config, runtime, runtime_control.clone()).await?;
    let _published = managed
        .map(|managed| {
            managed.lock.publish(ServiceRegistry::new(
                env!("CARGO_PKG_VERSION"),
                local_address,
                managed.token,
            ))
        })
        .transpose()?;
    tracing::info!(address = %local_address, managed = runtime_control.is_some(), "osheep-server listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal(runtime_control))
        .await?;
    Ok(())
}

struct ManagedServiceConfig {
    lock: ServiceLock,
    token: String,
    idle_timeout: Duration,
    lease_timeout: Duration,
}

fn managed_service_config(
    config: &ServerConfig,
) -> Result<Option<ManagedServiceConfig>, Box<dyn std::error::Error>> {
    let Some(directory) = env::var_os("OSHEEP_RUNTIME_DIR") else {
        return Ok(None);
    };
    let host = config.host.trim().to_ascii_lowercase();
    if host != "localhost" && host != "::1" && host != "[::1]" && !host.starts_with("127.") {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "managed osheep service must listen on a loopback host",
        )
        .into());
    }
    let token = env::var("OSHEEP_INSTANCE_TOKEN")
        .ok()
        .filter(|value| value.len() >= 32 && value.is_ascii())
        .unwrap_or_else(|| format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple()));
    Ok(Some(ManagedServiceConfig {
        lock: ServiceLock::try_acquire(RuntimePaths::new(directory))?,
        token,
        idle_timeout: duration_env("OSHEEP_SERVICE_IDLE_TIMEOUT_MS", 10_000)?,
        lease_timeout: duration_env("OSHEEP_CLIENT_LEASE_TIMEOUT_MS", 45_000)?,
    }))
}

fn duration_env(
    key: &'static str,
    fallback_ms: u64,
) -> Result<Duration, Box<dyn std::error::Error>> {
    let millis = match env::var(key) {
        Ok(value) => value.parse::<u64>().map_err(|_| {
            std::io::Error::new(
                std::io::ErrorKind::InvalidInput,
                format!("invalid integer in {key}: {value}"),
            )
        })?,
        Err(_) => fallback_ms,
    };
    if millis == 0 {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            format!("{key} must be greater than zero"),
        )
        .into());
    }
    Ok(Duration::from_millis(millis))
}

async fn shutdown_signal(runtime: Option<Arc<RuntimeControl>>) {
    match runtime {
        Some(runtime) => {
            tokio::select! {
                _ = tokio::signal::ctrl_c() => {}
                _ = runtime.wait_for_shutdown() => {}
            }
        }
        None => {
            let _ = tokio::signal::ctrl_c().await;
        }
    }
}
