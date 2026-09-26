use axum::{
    http::StatusCode,
    response::{IntoResponse, Response},
    Json,
};
use osheep_contract::{ApiErrorBody, ApiErrorEnvelope};
use osheep_core::{
    AgentError, AgentSessionError, ClaudeOnboardingError, FileError, GitError, SearchError,
    SessionError, StateError, WorkspaceError,
};
use osheep_pty::PtyError;

#[derive(Debug)]
pub struct ApiError {
    status: StatusCode,
    code: &'static str,
    message: String,
}

impl ApiError {
    pub fn new(status: StatusCode, code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status,
            code,
            message: message.into(),
        }
    }

    pub fn auth_required(message: impl Into<String>) -> Self {
        Self::new(StatusCode::UNAUTHORIZED, "AUTH_REQUIRED", message)
    }

    pub fn origin_not_allowed() -> Self {
        Self::new(
            StatusCode::FORBIDDEN,
            "ORIGIN_NOT_ALLOWED",
            "请求来源不在 Osheep 信任列表中",
        )
    }

    pub fn invalid_path(message: impl Into<String>) -> Self {
        Self::new(StatusCode::BAD_REQUEST, "INVALID_PATH", message)
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new(StatusCode::NOT_FOUND, "NOT_FOUND", message)
    }

    pub fn is_forbidden(&self) -> bool {
        self.status == StatusCode::FORBIDDEN
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        (
            self.status,
            Json(ApiErrorEnvelope {
                error: ApiErrorBody {
                    code: self.code.into(),
                    message: self.message,
                },
            }),
        )
            .into_response()
    }
}

impl From<std::io::Error> for ApiError {
    fn from(error: std::io::Error) -> Self {
        Self::new(
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                StatusCode::FORBIDDEN
            } else {
                StatusCode::INTERNAL_SERVER_ERROR
            },
            if error.kind() == std::io::ErrorKind::PermissionDenied {
                "IO_FORBIDDEN"
            } else {
                "IO_ERROR"
            },
            error.to_string(),
        )
    }
}

impl From<WorkspaceError> for ApiError {
    fn from(error: WorkspaceError) -> Self {
        match error {
            WorkspaceError::NotFound(id) => Self::new(
                StatusCode::NOT_FOUND,
                "WORKSPACE_NOT_FOUND",
                format!("工作区不存在: {id}"),
            ),
            WorkspaceError::OutsideRoot => Self::new(
                StatusCode::FORBIDDEN,
                "PATH_OUTSIDE_WORKSPACE",
                error.to_string(),
            ),
            WorkspaceError::InvalidRoot(_) => {
                Self::new(StatusCode::BAD_REQUEST, "INVALID_PATH", error.to_string())
            }
            WorkspaceError::InvalidName(_) => {
                Self::new(StatusCode::BAD_REQUEST, "INVALID_PATH", error.to_string())
            }
            WorkspaceError::EntryExists => {
                Self::new(StatusCode::CONFLICT, "ENTRY_EXISTS", error.to_string())
            }
            WorkspaceError::Io(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                error.to_string(),
            ),
        }
    }
}

impl From<FileError> for ApiError {
    fn from(error: FileError) -> Self {
        let (status, code) = match error {
            FileError::InvalidPath(_) => (StatusCode::BAD_REQUEST, "INVALID_PATH"),
            FileError::OutsideWorkspace => (StatusCode::FORBIDDEN, "PATH_OUTSIDE_WORKSPACE"),
            FileError::NotFound => (StatusCode::NOT_FOUND, "NOT_FOUND"),
            FileError::ParentNotFound => (StatusCode::NOT_FOUND, "PARENT_NOT_FOUND"),
            FileError::IsDirectory => (StatusCode::BAD_REQUEST, "IS_A_DIRECTORY"),
            FileError::NotDirectory => (StatusCode::BAD_REQUEST, "NOT_A_DIRECTORY"),
            FileError::EntryExists => (StatusCode::CONFLICT, "ENTRY_EXISTS"),
            FileError::DirectoryNotEmpty => (StatusCode::CONFLICT, "DIR_NOT_EMPTY"),
            FileError::FileTooLarge(_) => (StatusCode::PAYLOAD_TOO_LARGE, "FILE_TOO_LARGE"),
            FileError::BinaryFile => (StatusCode::UNSUPPORTED_MEDIA_TYPE, "BINARY_FILE"),
            FileError::Io(_) | FileError::Join(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "IO_ERROR")
            }
        };
        Self::new(status, code, error.to_string())
    }
}

impl From<StateError> for ApiError {
    fn from(error: StateError) -> Self {
        Self::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            "IO_ERROR",
            error.to_string(),
        )
    }
}

impl From<SessionError> for ApiError {
    fn from(error: SessionError) -> Self {
        match error {
            SessionError::InvalidId => Self::invalid_path("session id 非法"),
            SessionError::NotFound(message) => Self::not_found(message),
            SessionError::InvalidJson => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                error.to_string(),
            ),
            SessionError::Io(_) | SessionError::Json(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                error.to_string(),
            ),
        }
    }
}

impl From<AgentSessionError> for ApiError {
    fn from(error: AgentSessionError) -> Self {
        match error {
            AgentSessionError::InvalidQuery(message) => {
                Self::new(StatusCode::BAD_REQUEST, "INVALID_QUERY", message)
            }
            AgentSessionError::NotFound => {
                Self::not_found("Agent session not found in the current project")
            }
            AgentSessionError::Io(error) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                error.to_string(),
            ),
        }
    }
}

impl From<AgentError> for ApiError {
    fn from(error: AgentError) -> Self {
        match error {
            AgentError::InvalidName => Self::invalid_path("agent name is invalid"),
            AgentError::NotFound(message) => Self::not_found(message),
            AgentError::Exists => {
                Self::new(StatusCode::CONFLICT, "ENTRY_EXISTS", error.to_string())
            }
            AgentError::Io(_) | AgentError::Json(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                error.to_string(),
            ),
        }
    }
}

impl From<ClaudeOnboardingError> for ApiError {
    fn from(error: ClaudeOnboardingError) -> Self {
        match error {
            ClaudeOnboardingError::Json(_) => {
                Self::new(StatusCode::BAD_REQUEST, "INVALID_QUERY", error.to_string())
            }
            ClaudeOnboardingError::Io(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                error.to_string(),
            ),
        }
    }
}

impl From<SearchError> for ApiError {
    fn from(error: SearchError) -> Self {
        match error {
            SearchError::InvalidQuery(message) => {
                Self::new(StatusCode::BAD_REQUEST, "INVALID_QUERY", message)
            }
            SearchError::Cancelled => Self::new(
                StatusCode::REQUEST_TIMEOUT,
                "SEARCH_CANCELLED",
                error.to_string(),
            ),
            SearchError::Join(_) => Self::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                "IO_ERROR",
                error.to_string(),
            ),
        }
    }
}

impl From<GitError> for ApiError {
    fn from(error: GitError) -> Self {
        let (status, code) = match error {
            GitError::NotARepo => (StatusCode::CONFLICT, "NOT_A_REPO"),
            GitError::InvalidPath(_) => (StatusCode::BAD_REQUEST, "INVALID_PATH"),
            GitError::InvalidRef(_) => (StatusCode::BAD_REQUEST, "INVALID_REF"),
            GitError::EmptyCommitMessage => (StatusCode::BAD_REQUEST, "EMPTY_COMMIT_MESSAGE"),
            GitError::DirtyWorktree(_) => (StatusCode::CONFLICT, "DIRTY_WORKTREE"),
            GitError::BranchExists(_) => (StatusCode::CONFLICT, "BRANCH_EXISTS"),
            GitError::EntryExists(_) => (StatusCode::CONFLICT, "ENTRY_EXISTS"),
            GitError::NoUpstream(_) => (StatusCode::CONFLICT, "NO_UPSTREAM"),
            GitError::NonFastForward(_) => (StatusCode::CONFLICT, "NON_FAST_FORWARD"),
            GitError::Rejected(_) => (StatusCode::CONFLICT, "REJECTED"),
            GitError::Timeout => (StatusCode::GATEWAY_TIMEOUT, "GIT_TIMEOUT"),
            GitError::OutputTooLarge => (StatusCode::PAYLOAD_TOO_LARGE, "GIT_OUTPUT_TOO_LARGE"),
            GitError::Cancelled => (StatusCode::REQUEST_TIMEOUT, "GIT_CANCELLED"),
            GitError::CommandFailed(_) | GitError::Io(_) | GitError::Join(_) => {
                (StatusCode::INTERNAL_SERVER_ERROR, "GIT_FAILED")
            }
        };
        Self::new(status, code, error.to_string())
    }
}

impl From<PtyError> for ApiError {
    fn from(error: PtyError) -> Self {
        let (status, code) = match error {
            PtyError::UnsupportedShell(_) => (StatusCode::BAD_REQUEST, "UNSUPPORTED_SHELL"),
            PtyError::InvalidSize => (StatusCode::BAD_REQUEST, "INVALID_SIZE"),
            PtyError::TooManySessions(_) => (StatusCode::TOO_MANY_REQUESTS, "TOO_MANY_SESSIONS"),
            PtyError::SessionNotFound(_) => (StatusCode::NOT_FOUND, "SESSION_NOT_FOUND"),
            PtyError::Spawn(_) => (StatusCode::INTERNAL_SERVER_ERROR, "PTY_SPAWN_FAILED"),
            PtyError::Closed => (StatusCode::CONFLICT, "SESSION_CLOSED"),
        };
        Self::new(status, code, error.to_string())
    }
}
