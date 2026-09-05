use futures_util::{SinkExt, StreamExt};
use osheep_contract::{CreateTerminalResponse, ServerTerminalFrame, TerminalSessionsResponse};
use osheep_pty::{NativePtyRuntime, PtyRuntime};
use osheep_server::{build_app, ServerConfig};
use reqwest::header::{COOKIE, SET_COOKIE};
use std::sync::Arc;
use std::time::Duration;
use tokio_tungstenite::connect_async;
use tokio_tungstenite::tungstenite::client::IntoClientRequest;
use tokio_tungstenite::tungstenite::http::HeaderValue;
use tokio_tungstenite::tungstenite::Message;
use uuid::Uuid;

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn live_http_and_websocket_terminal_round_trip() {
    let root = std::env::temp_dir().join(format!("osheep-server-live-{}", Uuid::new_v4()));
    std::fs::create_dir_all(root.join("demo")).unwrap();
    let runtime = Arc::new(NativePtyRuntime::new(2));
    let profile = runtime
        .profiles()
        .into_iter()
        .next()
        .expect("no native shell was detected");
    let app = build_app(
        ServerConfig {
            host: "127.0.0.1".into(),
            port: 0,
            workspaces_root: root.clone(),
            data_root: root.join(".state"),
            frontend_root: None,
            cors_origins: Vec::new(),
            auth_token: None,
            max_terminal_sessions: 2,
            terminal_idle_timeout_ms: 0,
            allow_external_workspace_paths: false,
            max_file_size_bytes: 5 * 1024 * 1024,
        },
        runtime,
    )
    .await
    .unwrap();
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let address = listener.local_addr().unwrap();
    let server = tokio::spawn(async move {
        axum::serve(listener, app).await.unwrap();
    });
    let base = format!("http://{address}");
    let client = reqwest::Client::new();
    let auth = client
        .post(format!("{base}/api/auth/session"))
        .send()
        .await
        .unwrap();
    assert!(auth.status().is_success());
    let cookie = auth
        .headers()
        .get(SET_COOKIE)
        .unwrap()
        .to_str()
        .unwrap()
        .split(';')
        .next()
        .unwrap()
        .to_owned();
    let created = client
        .post(format!("{base}/api/terminals"))
        .header(COOKIE, &cookie)
        .json(&serde_json::json!({
            "workspaceId": "demo",
            "shell": profile.id,
            "cols": 90,
            "rows": 28
        }))
        .send()
        .await
        .unwrap();
    assert!(
        created.status().is_success(),
        "{}",
        created.text().await.unwrap()
    );
    let created: CreateTerminalResponse = created.json().await.unwrap();

    let mut request = format!("ws://{address}{}", created.ws_url)
        .into_client_request()
        .unwrap();
    request
        .headers_mut()
        .insert(COOKIE, HeaderValue::from_str(&cookie).unwrap());
    request
        .headers_mut()
        .insert("origin", HeaderValue::from_str(&base).unwrap());
    let (mut socket, _) = connect_async(request).await.unwrap();
    let command = match created.shell.as_str() {
        "powershell" => "Write-Output 'OSHEEP_LIVE_WS_中文'; exit\r",
        "cmd" => "echo OSHEEP_LIVE_WS&&exit\r",
        "bash" | "zsh" => "printf 'OSHEEP_LIVE_WS_中文\\n'; exit\n",
        other => panic!("unexpected shell profile: {other}"),
    };
    let mut output = String::new();
    tokio::time::timeout(Duration::from_secs(15), async {
        while let Some(message) = socket.next().await {
            let message = message.unwrap();
            let Message::Text(text) = message else {
                continue;
            };
            match serde_json::from_str::<ServerTerminalFrame>(&text).unwrap() {
                ServerTerminalFrame::ReplayEnd => {
                    socket
                        .send(Message::Text(
                            serde_json::json!({ "type": "input", "data": command })
                                .to_string()
                                .into(),
                        ))
                        .await
                        .unwrap();
                }
                ServerTerminalFrame::Output { data } => output.push_str(&data),
                ServerTerminalFrame::Exit { .. } => break,
                ServerTerminalFrame::Error { message } => panic!("terminal error: {message}"),
                ServerTerminalFrame::Ping => {
                    socket
                        .send(Message::Text(r#"{"type":"pong"}"#.into()))
                        .await
                        .unwrap();
                }
                _ => {}
            }
        }
    })
    .await
    .expect("terminal WebSocket did not exit within 15 seconds");
    assert!(
        output.contains("OSHEEP_LIVE_WS"),
        "missing output: {output:?}"
    );

    tokio::time::timeout(Duration::from_secs(2), async {
        loop {
            let sessions: TerminalSessionsResponse = client
                .get(format!("{base}/api/terminals"))
                .header(COOKIE, &cookie)
                .send()
                .await
                .unwrap()
                .json()
                .await
                .unwrap();
            if sessions.sessions.is_empty() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
    })
    .await
    .expect("exited terminal remained in the REST session list");
    server.abort();
    std::fs::remove_dir_all(root).ok();
}
