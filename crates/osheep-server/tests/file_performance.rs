use async_trait::async_trait;
use axum::body::{to_bytes, Body};
use axum::http::{header, Request, StatusCode};
use osheep_contract::{ShellProfile, TerminalSessionSummary};
use osheep_pty::{PtyError, PtyRuntime, PtySession, SpawnRequest};
use osheep_server::{build_app, ServerConfig};
use std::sync::Arc;
use std::time::Instant;
use tower::ServiceExt;
use uuid::Uuid;

struct BenchmarkRuntime;

#[async_trait]
impl PtyRuntime for BenchmarkRuntime {
    fn profiles(&self) -> Vec<ShellProfile> {
        Vec::new()
    }

    fn list(&self) -> Vec<TerminalSessionSummary> {
        Vec::new()
    }

    fn get(&self, _id: &str) -> Option<Arc<dyn PtySession>> {
        None
    }

    async fn spawn(&self, _request: SpawnRequest) -> Result<Arc<dyn PtySession>, PtyError> {
        Err(PtyError::Spawn("not used by file benchmark".into()))
    }

    async fn kill(&self, id: &str) -> Result<(), PtyError> {
        Err(PtyError::SessionNotFound(id.into()))
    }
}

fn percentile(samples: &mut [f64], percentile: f64) -> f64 {
    samples.sort_by(f64::total_cmp);
    let index = ((samples.len() - 1) as f64 * percentile).ceil() as usize;
    samples[index]
}

#[tokio::test]
#[ignore = "manual P4 latency benchmark"]
async fn http_file_reads_meet_p4_local_latency_targets() {
    let root = std::env::temp_dir().join(format!("osheep-file-benchmark-{}", Uuid::new_v4()));
    let workspace = root.join("workspaces/bench");
    std::fs::create_dir_all(&workspace).unwrap();
    let sizes = [("1k", 1024), ("100k", 100 * 1024), ("1m", 1024 * 1024)];
    for (label, size) in sizes {
        for index in 0..12 {
            std::fs::write(
                workspace.join(format!("{label}-{index}.txt")),
                vec![b'x'; size],
            )
            .unwrap();
        }
    }
    let app = build_app(
        ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            workspaces_root: root.join("workspaces"),
            data_root: root.join("data"),
            frontend_root: None,
            cors_origins: Vec::new(),
            auth_token: None,
            max_terminal_sessions: 1,
            terminal_idle_timeout_ms: 0,
            allow_external_workspace_paths: false,
            max_file_size_bytes: 5 * 1024 * 1024,
        },
        Arc::new(BenchmarkRuntime),
    )
    .await
    .unwrap();
    let auth = app
        .clone()
        .oneshot(
            Request::post("/api/auth/session")
                .body(Body::empty())
                .unwrap(),
        )
        .await
        .unwrap();
    let cookie = auth
        .headers()
        .get(header::SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();

    for (label, _) in sizes {
        let mut cold = Vec::new();
        for index in 0..12 {
            let started = Instant::now();
            let response = app
                .clone()
                .oneshot(
                    Request::get(format!(
                        "/api/workspaces/bench/fs/file?path={label}-{index}.txt"
                    ))
                    .header(header::COOKIE, &cookie)
                    .body(Body::empty())
                    .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            to_bytes(response.into_body(), usize::MAX).await.unwrap();
            cold.push(started.elapsed().as_secs_f64() * 1000.0);
        }

        let mut warm = Vec::new();
        for _ in 0..20 {
            let started = Instant::now();
            let response = app
                .clone()
                .oneshot(
                    Request::get(format!("/api/workspaces/bench/fs/file?path={label}-11.txt"))
                        .header(header::COOKIE, &cookie)
                        .body(Body::empty())
                        .unwrap(),
                )
                .await
                .unwrap();
            assert_eq!(response.status(), StatusCode::OK);
            to_bytes(response.into_body(), usize::MAX).await.unwrap();
            warm.push(started.elapsed().as_secs_f64() * 1000.0);
        }

        let cold_p50 = percentile(&mut cold.clone(), 0.50);
        let cold_p95 = percentile(&mut cold, 0.95);
        let warm_p50 = percentile(&mut warm.clone(), 0.50);
        let warm_p95 = percentile(&mut warm, 0.95);
        println!(
            "P4 file benchmark {label}: cold p50={cold_p50:.2}ms p95={cold_p95:.2}ms; warm p50={warm_p50:.2}ms p95={warm_p95:.2}ms"
        );
        assert!(cold_p95 < 250.0, "{label} cold p95 was {cold_p95:.2}ms");
        let warm_limit = if cfg!(debug_assertions) { 250.0 } else { 100.0 };
        assert!(
            warm_p95 < warm_limit,
            "{label} warm p95 was {warm_p95:.2}ms (limit {warm_limit:.0}ms)"
        );
    }
    std::fs::remove_dir_all(root).ok();
}
