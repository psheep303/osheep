use serde::{Deserialize, Serialize};

pub const API_VERSION: &str = "0.2.1";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct HealthResponse {
    pub ok: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeHealthResponse {
    pub ok: bool,
    pub service_version: String,
    pub pid: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeClientRequest {
    pub client_id: String,
    pub client_version: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RuntimeClientResponse {
    pub client_id: String,
    pub lease_timeout_ms: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiErrorBody {
    pub code: String,
    pub message: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ApiErrorEnvelope {
    pub error: ApiErrorBody,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellProfile {
    pub id: String,
    pub label: String,
    pub executable: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct ShellProfilesResponse {
    pub os: String,
    pub profiles: Vec<ShellProfile>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSessionSummary {
    pub id: String,
    pub workspace_id: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
    pub created_at: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct TerminalSessionsResponse {
    pub sessions: Vec<TerminalSessionSummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalRequest {
    pub workspace_id: Option<String>,
    pub shell: Option<String>,
    pub cols: Option<u16>,
    pub rows: Option<u16>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateTerminalResponse {
    pub id: String,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
    pub ws_url: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct DeleteTerminalResponse {
    pub id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalReplayResize {
    pub offset: usize,
    pub cols: u16,
    pub rows: u16,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compact_startup: Option<bool>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "kebab-case")]
pub enum ServerTerminalFrame {
    Output {
        data: String,
    },
    ReplayStart {
        cols: u16,
        rows: u16,
        #[serde(rename = "initialCols")]
        initial_cols: u16,
        #[serde(rename = "initialRows")]
        initial_rows: u16,
        resizes: Vec<TerminalReplayResize>,
        #[serde(rename = "compactStartup")]
        compact_startup: bool,
        truncated: bool,
    },
    ReplayChunk {
        data: String,
    },
    ReplayEnd,
    Exit {
        code: u32,
        signal: Option<u32>,
    },
    Error {
        message: String,
    },
    Ping,
    Pong,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum ClientTerminalFrame {
    Input {
        data: String,
    },
    Resize {
        cols: u16,
        rows: u16,
        #[serde(rename = "compactStartup")]
        compact_startup: Option<bool>,
    },
    Ping,
    Pong,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminal_create_response_keeps_node_field_names() {
        let value = serde_json::to_value(CreateTerminalResponse {
            id: "t_demo".into(),
            shell: "powershell".into(),
            cols: 80,
            rows: 24,
            ws_url: "/api/terminals/t_demo/io".into(),
        })
        .unwrap();
        assert_eq!(value["wsUrl"], "/api/terminals/t_demo/io");
        assert!(value.get("ws_url").is_none());
    }

    #[test]
    fn replay_frames_keep_existing_discriminators() {
        assert_eq!(
            serde_json::to_value(ServerTerminalFrame::ReplayEnd).unwrap(),
            serde_json::json!({ "type": "replay-end" })
        );
        assert_eq!(
            serde_json::to_value(ServerTerminalFrame::Exit {
                code: 0,
                signal: None,
            })
            .unwrap(),
            serde_json::json!({ "type": "exit", "code": 0, "signal": null })
        );
    }
}
