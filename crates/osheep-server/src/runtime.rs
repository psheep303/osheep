use osheep_contract::{RuntimeClientRequest, RuntimeClientResponse, RuntimeHealthResponse};
use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tokio::sync::Notify;

struct RuntimeState {
    clients: HashMap<String, Instant>,
    empty_since: Instant,
}

pub struct RuntimeControl {
    service_version: String,
    pid: u32,
    idle_timeout: Duration,
    lease_timeout: Duration,
    state: Mutex<RuntimeState>,
    changed: Notify,
}

impl RuntimeControl {
    pub fn new(
        service_version: impl Into<String>,
        idle_timeout: Duration,
        lease_timeout: Duration,
    ) -> Arc<Self> {
        Arc::new(Self {
            service_version: service_version.into(),
            pid: std::process::id(),
            idle_timeout,
            lease_timeout,
            state: Mutex::new(RuntimeState {
                clients: HashMap::new(),
                empty_since: Instant::now(),
            }),
            changed: Notify::new(),
        })
    }

    pub fn health(&self) -> RuntimeHealthResponse {
        RuntimeHealthResponse {
            ok: true,
            service_version: self.service_version.clone(),
            pid: self.pid,
        }
    }

    pub fn attach(
        &self,
        request: RuntimeClientRequest,
    ) -> Result<RuntimeClientResponse, RuntimeClientError> {
        validate_client_id(&request.client_id)?;
        if request.client_version != self.service_version {
            return Err(RuntimeClientError::VersionMismatch {
                expected: self.service_version.clone(),
                actual: request.client_version,
            });
        }
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        state
            .clients
            .insert(request.client_id.clone(), Instant::now());
        drop(state);
        self.changed.notify_waiters();
        Ok(RuntimeClientResponse {
            client_id: request.client_id,
            lease_timeout_ms: self.lease_timeout.as_millis() as u64,
        })
    }

    pub fn detach(&self, client_id: &str) -> Result<RuntimeClientResponse, RuntimeClientError> {
        validate_client_id(client_id)?;
        let mut state = self
            .state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        if state.clients.remove(client_id).is_none() {
            return Err(RuntimeClientError::NotFound(client_id.to_owned()));
        }
        if state.clients.is_empty() {
            state.empty_since = Instant::now();
        }
        drop(state);
        self.changed.notify_waiters();
        Ok(RuntimeClientResponse {
            client_id: client_id.to_owned(),
            lease_timeout_ms: self.lease_timeout.as_millis() as u64,
        })
    }

    pub async fn wait_for_shutdown(&self) {
        loop {
            let wait = {
                let mut state = self
                    .state
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner());
                let now = Instant::now();
                let had_clients = !state.clients.is_empty();
                state
                    .clients
                    .retain(|_, seen| now.saturating_duration_since(*seen) < self.lease_timeout);
                if had_clients && state.clients.is_empty() {
                    state.empty_since = now;
                }
                if state.clients.is_empty() {
                    let elapsed = now.saturating_duration_since(state.empty_since);
                    if elapsed >= self.idle_timeout {
                        return;
                    }
                    self.idle_timeout - elapsed
                } else {
                    self.lease_timeout
                }
            };
            tokio::select! {
                _ = tokio::time::sleep(wait) => {}
                _ = self.changed.notified() => {}
            }
        }
    }

    #[cfg(test)]
    fn client_count(&self) -> usize {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clients
            .len()
    }
}

#[derive(Debug, thiserror::Error)]
pub enum RuntimeClientError {
    #[error("runtime client ID is invalid")]
    InvalidId,
    #[error("runtime client version mismatch: expected {expected}, found {actual}")]
    VersionMismatch { expected: String, actual: String },
    #[error("runtime client is not registered: {0}")]
    NotFound(String),
}

fn validate_client_id(client_id: &str) -> Result<(), RuntimeClientError> {
    if (8..=128).contains(&client_id.len())
        && client_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
    {
        Ok(())
    } else {
        Err(RuntimeClientError::InvalidId)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn request(id: &str) -> RuntimeClientRequest {
        RuntimeClientRequest {
            client_id: id.into(),
            client_version: "0.2.1".into(),
        }
    }

    #[test]
    fn attach_refreshes_existing_client_and_detach_is_strict() {
        let control = RuntimeControl::new("0.2.1", Duration::from_secs(1), Duration::from_secs(1));
        control.attach(request("client_123")).unwrap();
        control.attach(request("client_123")).unwrap();
        assert_eq!(control.client_count(), 1);
        control.detach("client_123").unwrap();
        assert!(matches!(
            control.detach("client_123"),
            Err(RuntimeClientError::NotFound(_))
        ));
    }

    #[tokio::test]
    async fn last_client_detach_starts_idle_shutdown() {
        let control =
            RuntimeControl::new("0.2.1", Duration::from_millis(30), Duration::from_secs(1));
        control.attach(request("client_123")).unwrap();
        let waiting = {
            let control = control.clone();
            tokio::spawn(async move { control.wait_for_shutdown().await })
        };
        tokio::time::sleep(Duration::from_millis(40)).await;
        assert!(!waiting.is_finished());
        control.detach("client_123").unwrap();
        tokio::time::timeout(Duration::from_millis(200), waiting)
            .await
            .expect("runtime did not stop after idle timeout")
            .unwrap();
    }

    #[tokio::test]
    async fn expired_client_lease_cannot_keep_runtime_alive() {
        let control = RuntimeControl::new(
            "0.2.1",
            Duration::from_millis(20),
            Duration::from_millis(30),
        );
        control.attach(request("client_123")).unwrap();
        tokio::time::timeout(Duration::from_millis(200), control.wait_for_shutdown())
            .await
            .expect("expired lease kept runtime alive");
    }
}
