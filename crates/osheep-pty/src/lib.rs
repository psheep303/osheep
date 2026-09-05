use async_trait::async_trait;
use osheep_contract::{ShellProfile, TerminalReplayResize, TerminalSessionSummary};
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::collections::HashMap;
use std::env;
use std::io::{Read, Write};
use std::path::{Component, Path, PathBuf};
use std::sync::{
    atomic::{AtomicBool, AtomicU64, Ordering},
    Arc, Mutex, RwLock,
};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use thiserror::Error;
use tokio::sync::{broadcast, mpsc};
use uuid::Uuid;

const INPUT_QUEUE_CAPACITY: usize = 64;
const OUTPUT_QUEUE_CAPACITY: usize = 256;
const TERMINAL_REPLAY_LIMIT_BYTES: usize = 256 * 1024;
const AGENT_TERMINAL_REPLAY_LIMIT_BYTES: usize = 4 * 1024 * 1024;
const INPUT_BUFFER_LIMIT: usize = 4096;
const REPLAY_RESET: &str = "\x1b[0m\x1b[?2026l\x1b[2J\x1b[H";

#[derive(Debug, Error)]
pub enum PtyError {
    #[error("服务器未探测到 shell: {0}")]
    UnsupportedShell(String),
    #[error("cols / rows 必须在 1..1000 之间")]
    InvalidSize,
    #[error("并发会话数达到上限 {0}")]
    TooManySessions(usize),
    #[error("终端会话不存在: {0}")]
    SessionNotFound(String),
    #[error("PTY 启动失败: {0}")]
    Spawn(String),
    #[error("PTY 会话已关闭")]
    Closed,
}

#[derive(Debug, Clone)]
pub struct SpawnRequest {
    pub workspace_id: String,
    pub cwd: PathBuf,
    pub workspaces_root: PathBuf,
    pub shell: String,
    pub cols: u16,
    pub rows: u16,
    pub kill_on_detach: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ReplaySnapshot {
    pub data: String,
    pub truncated: bool,
    pub initial_cols: u16,
    pub initial_rows: u16,
    pub resizes: Vec<TerminalReplayResize>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyEvent {
    Output(String),
    Exit { code: u32, signal: Option<u32> },
    Error(String),
}

#[async_trait]
pub trait PtySession: Send + Sync {
    fn summary(&self) -> TerminalSessionSummary;
    fn attach(&self) -> (ReplaySnapshot, broadcast::Receiver<PtyEvent>);
    async fn input(&self, data: String) -> Result<(), PtyError>;
    async fn resize(&self, cols: u16, rows: u16, compact_startup: bool) -> Result<(), PtyError>;
    async fn kill(&self) -> Result<(), PtyError>;
    fn kill_on_detach(&self) -> bool;
}

#[async_trait]
pub trait PtyRuntime: Send + Sync {
    fn profiles(&self) -> Vec<ShellProfile>;
    fn list(&self) -> Vec<TerminalSessionSummary>;
    fn get(&self, id: &str) -> Option<Arc<dyn PtySession>>;
    async fn spawn(&self, request: SpawnRequest) -> Result<Arc<dyn PtySession>, PtyError>;
    async fn kill(&self, id: &str) -> Result<(), PtyError>;
}

#[derive(Debug)]
enum PtyCommand {
    Input(String),
    Resize { cols: u16, rows: u16 },
    Kill,
}

#[derive(Debug)]
struct ReplayBuffer {
    data: String,
    truncated: bool,
    start_offset: usize,
    output_offset: usize,
    initial_cols: u16,
    initial_rows: u16,
    resizes: Vec<TerminalReplayResize>,
    limit_bytes: usize,
}

impl ReplayBuffer {
    fn new(cols: u16, rows: u16, limit_bytes: usize) -> Self {
        Self {
            data: String::new(),
            truncated: false,
            start_offset: 0,
            output_offset: 0,
            initial_cols: cols,
            initial_rows: rows,
            resizes: Vec::new(),
            limit_bytes,
        }
    }

    fn append(&mut self, value: &str) {
        self.data.push_str(value);
        self.output_offset += utf16_len(value);
        if self.data.len() <= self.limit_bytes {
            return;
        }
        let mut remove = self.data.len() - self.limit_bytes;
        while !self.data.is_char_boundary(remove) {
            remove += 1;
        }
        self.start_offset += utf16_len(&self.data[..remove]);
        self.data.drain(..remove);
        self.truncated = true;
    }

    fn record_resize(&mut self, cols: u16, rows: u16, compact_startup: bool) {
        let marker = TerminalReplayResize {
            offset: self.output_offset,
            cols,
            rows,
            compact_startup: compact_startup.then_some(true),
        };
        if self
            .resizes
            .last()
            .is_some_and(|previous| previous.offset == marker.offset)
        {
            let last = self.resizes.len() - 1;
            self.resizes[last] = marker;
        } else {
            self.resizes.push(marker);
        }
    }

    fn snapshot(&self) -> ReplaySnapshot {
        if !self.truncated {
            return ReplaySnapshot {
                data: self.data.clone(),
                truncated: false,
                initial_cols: self.initial_cols,
                initial_rows: self.initial_rows,
                resizes: self.resizes.clone(),
            };
        }

        let safe_start_bytes = find_safe_replay_start(&self.data);
        let safe_start_offset = utf16_len(&self.data[..safe_start_bytes]);
        let absolute_start = self.start_offset + safe_start_offset;
        let mut initial_cols = self.initial_cols;
        let mut initial_rows = self.initial_rows;
        for resize in &self.resizes {
            if resize.offset > absolute_start {
                break;
            }
            initial_cols = resize.cols;
            initial_rows = resize.rows;
        }
        let prefix_offset = utf16_len(REPLAY_RESET);
        let resizes = self
            .resizes
            .iter()
            .filter(|resize| resize.offset > absolute_start)
            .map(|resize| TerminalReplayResize {
                offset: resize.offset - absolute_start + prefix_offset,
                cols: resize.cols,
                rows: resize.rows,
                compact_startup: resize.compact_startup,
            })
            .collect();
        ReplaySnapshot {
            data: format!("{REPLAY_RESET}{}", &self.data[safe_start_bytes..]),
            truncated: true,
            initial_cols,
            initial_rows,
            resizes,
        }
    }
}

struct NativeSession {
    summary: RwLock<TerminalSessionSummary>,
    commands: mpsc::Sender<PtyCommand>,
    events: broadcast::Sender<PtyEvent>,
    replay: Arc<Mutex<ReplayBuffer>>,
    alive: Arc<AtomicBool>,
    kill_on_detach: bool,
}

#[async_trait]
impl PtySession for NativeSession {
    fn summary(&self) -> TerminalSessionSummary {
        self.summary
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .clone()
    }

    fn attach(&self) -> (ReplaySnapshot, broadcast::Receiver<PtyEvent>) {
        let replay = self
            .replay
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let events = self.events.subscribe();
        (replay.snapshot(), events)
    }

    async fn input(&self, data: String) -> Result<(), PtyError> {
        self.commands
            .send(PtyCommand::Input(data))
            .await
            .map_err(|_| PtyError::Closed)
    }

    async fn resize(&self, cols: u16, rows: u16, compact_startup: bool) -> Result<(), PtyError> {
        validate_size(cols, rows)?;
        let current = self.summary();
        if current.cols == cols && current.rows == rows {
            return Ok(());
        }
        self.commands
            .send(PtyCommand::Resize { cols, rows })
            .await
            .map_err(|_| PtyError::Closed)?;
        if !self.kill_on_detach {
            self.replay
                .lock()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .record_resize(cols, rows, compact_startup);
        }
        let mut summary = self
            .summary
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        summary.cols = cols;
        summary.rows = rows;
        Ok(())
    }

    async fn kill(&self) -> Result<(), PtyError> {
        self.alive.store(false, Ordering::Release);
        self.commands
            .send(PtyCommand::Kill)
            .await
            .map_err(|_| PtyError::Closed)
    }

    fn kill_on_detach(&self) -> bool {
        self.kill_on_detach
    }
}

pub struct NativePtyRuntime {
    profiles: Vec<NativeShellProfile>,
    sessions: Arc<RwLock<HashMap<String, Arc<NativeSession>>>>,
    max_sessions: usize,
    idle_timeout: Duration,
}

#[derive(Debug, Clone)]
struct NativeShellProfile {
    public: ShellProfile,
    args: Vec<String>,
}

impl NativePtyRuntime {
    pub fn new(max_sessions: usize) -> Self {
        Self {
            profiles: detect_profiles(),
            sessions: Arc::new(RwLock::new(HashMap::new())),
            max_sessions,
            idle_timeout: Duration::ZERO,
        }
    }

    pub fn with_idle_timeout(mut self, idle_timeout: Duration) -> Self {
        self.idle_timeout = idle_timeout;
        self
    }
}

#[async_trait]
impl PtyRuntime for NativePtyRuntime {
    fn profiles(&self) -> Vec<ShellProfile> {
        self.profiles
            .iter()
            .map(|profile| profile.public.clone())
            .collect()
    }

    fn list(&self) -> Vec<TerminalSessionSummary> {
        self.sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .filter(|session| session.alive.load(Ordering::Acquire))
            .map(|session| session.summary())
            .collect()
    }

    fn get(&self, id: &str) -> Option<Arc<dyn PtySession>> {
        self.sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .get(id)
            .filter(|session| session.alive.load(Ordering::Acquire))
            .cloned()
            .map(|session| session as Arc<dyn PtySession>)
    }

    async fn spawn(&self, request: SpawnRequest) -> Result<Arc<dyn PtySession>, PtyError> {
        validate_size(request.cols, request.rows)?;
        let active_count = self
            .sessions
            .read()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .values()
            .filter(|session| session.alive.load(Ordering::Acquire))
            .count();
        if active_count >= self.max_sessions {
            return Err(PtyError::TooManySessions(self.max_sessions));
        }
        let profile = self
            .profiles
            .iter()
            .find(|profile| profile.public.id == request.shell)
            .cloned()
            .ok_or_else(|| PtyError::UnsupportedShell(request.shell.clone()))?;

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: request.rows,
                cols: request.cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        let mut command = CommandBuilder::new(&profile.public.executable);
        command.args(profile.args);
        command.cwd(platform_shell_path(&request.cwd));
        for (key, value) in terminal_environment() {
            command.env(key, value);
        }
        let mut child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        drop(pair.slave);
        let mut reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        let mut writer = pair
            .master
            .take_writer()
            .map_err(|error| PtyError::Spawn(error.to_string()))?;
        let master = pair.master;

        let id = format!("t_{}", &Uuid::new_v4().simple().to_string()[..8]);
        let created_at = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;
        let (commands, mut command_rx) = mpsc::channel(INPUT_QUEUE_CAPACITY);
        let (events, _) = broadcast::channel(OUTPUT_QUEUE_CAPACITY);
        let replay_limit = if request.kill_on_detach {
            TERMINAL_REPLAY_LIMIT_BYTES
        } else {
            AGENT_TERMINAL_REPLAY_LIMIT_BYTES
        };
        let replay = Arc::new(Mutex::new(ReplayBuffer::new(
            request.cols,
            request.rows,
            replay_limit,
        )));
        let alive = Arc::new(AtomicBool::new(true));
        let last_activity = Arc::new(AtomicU64::new(now_millis()));
        let session = Arc::new(NativeSession {
            summary: RwLock::new(TerminalSessionSummary {
                id: id.clone(),
                workspace_id: request.workspace_id,
                shell: request.shell,
                cols: request.cols,
                rows: request.rows,
                created_at,
            }),
            commands,
            events: events.clone(),
            replay: replay.clone(),
            alive: alive.clone(),
            kill_on_detach: request.kill_on_detach,
        });
        self.sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .insert(id.clone(), session.clone());

        let reader_events = events.clone();
        let reader_replay = replay;
        let reader_activity = last_activity.clone();
        let reader_error = Arc::new(Mutex::new(None));
        let reader_error_slot = reader_error.clone();
        let reader_task = tokio::task::spawn_blocking(move || {
            let mut decoder = Utf8Decoder::default();
            let mut buffer = [0_u8; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) => {
                        if let Some(text) = decoder.finish() {
                            publish_output(&reader_events, &reader_replay, text);
                        }
                        break;
                    }
                    Ok(read) => {
                        reader_activity.store(now_millis(), Ordering::Release);
                        for text in decoder.push(&buffer[..read]) {
                            publish_output(&reader_events, &reader_replay, text);
                        }
                    }
                    Err(error) => {
                        *reader_error_slot
                            .lock()
                            .unwrap_or_else(|poisoned| poisoned.into_inner()) =
                            Some(error.to_string());
                        break;
                    }
                }
            }
        });

        let cleanup_sessions = self.sessions.clone();
        let session_id = id;
        let final_events = events;
        let command_events = final_events.clone();
        let cleanup_alive = alive.clone();
        let idle_timeout = self.idle_timeout;
        let initial_cwd = request.cwd;
        let workspaces_root = request.workspaces_root;
        let command_task = tokio::task::spawn_blocking(move || {
            let mut input_guard = InputGuard::new(initial_cwd, workspaces_root);
            loop {
                if let Some(error) = reader_error
                    .lock()
                    .unwrap_or_else(|poisoned| poisoned.into_inner())
                    .take()
                {
                    let _ = child.kill();
                    break PtyEvent::Error(error);
                }
                match command_rx.try_recv() {
                    Ok(PtyCommand::Input(data)) => {
                        last_activity.store(now_millis(), Ordering::Release);
                        if process_input(&mut writer, &command_events, &mut input_guard, &data)
                            .is_err()
                        {
                            let _ = child.kill();
                            break PtyEvent::Error("PTY 输入失败".into());
                        }
                    }
                    Ok(PtyCommand::Resize { cols, rows }) => {
                        if let Err(error) = master.resize(PtySize {
                            rows,
                            cols,
                            pixel_width: 0,
                            pixel_height: 0,
                        }) {
                            let _ = command_events.send(PtyEvent::Error(error.to_string()));
                        }
                        last_activity.store(now_millis(), Ordering::Release);
                    }
                    Ok(PtyCommand::Kill) => {
                        let _ = child.kill();
                    }
                    Err(mpsc::error::TryRecvError::Disconnected) => {
                        let _ = child.kill();
                    }
                    Err(mpsc::error::TryRecvError::Empty) => {}
                }
                match child.try_wait() {
                    Ok(Some(status)) => {
                        break PtyEvent::Exit {
                            code: status.exit_code(),
                            signal: None,
                        };
                    }
                    Ok(None) => {}
                    Err(error) => {
                        break PtyEvent::Error(error.to_string());
                    }
                }
                if !idle_timeout.is_zero()
                    && now_millis().saturating_sub(last_activity.load(Ordering::Acquire))
                        >= idle_timeout.as_millis() as u64
                {
                    let _ = child.kill();
                    break PtyEvent::Error("session killed: idle-timeout".into());
                }
                std::thread::sleep(Duration::from_millis(10));
            }
        });
        tokio::spawn(async move {
            let final_event = match command_task.await {
                Ok(event) => event,
                Err(error) => PtyEvent::Error(error.to_string()),
            };
            let _ = reader_task.await;
            cleanup_alive.store(false, Ordering::Release);
            let _ = final_events.send(final_event);
            cleanup_sessions
                .write()
                .unwrap_or_else(|poisoned| poisoned.into_inner())
                .remove(&session_id);
        });

        Ok(session as Arc<dyn PtySession>)
    }

    async fn kill(&self, id: &str) -> Result<(), PtyError> {
        let session = self
            .sessions
            .write()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
            .remove(id)
            .ok_or_else(|| PtyError::SessionNotFound(id.to_owned()))?;
        session.kill().await
    }
}

fn publish_output(
    events: &broadcast::Sender<PtyEvent>,
    replay: &Arc<Mutex<ReplayBuffer>>,
    text: String,
) {
    let mut replay = replay
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner());
    replay.append(&text);
    let _ = events.send(PtyEvent::Output(text));
}

struct InputGuard {
    logical_cwd: PathBuf,
    workspaces_root: PathBuf,
    input_buffer: String,
    buffer_dirty: bool,
}

impl InputGuard {
    fn new(logical_cwd: PathBuf, workspaces_root: PathBuf) -> Self {
        Self {
            logical_cwd: normalize_path(&logical_cwd),
            workspaces_root: normalize_path(&workspaces_root),
            input_buffer: String::new(),
            buffer_dirty: false,
        }
    }
}

fn process_input(
    writer: &mut dyn Write,
    events: &broadcast::Sender<PtyEvent>,
    guard: &mut InputGuard,
    data: &str,
) -> std::io::Result<()> {
    if data == "\x1b\r" {
        guard.input_buffer.clear();
        guard.buffer_dirty = true;
        writer.write_all(data.as_bytes())?;
        return writer.flush();
    }

    let mut pending = String::new();
    for character in data.chars() {
        if matches!(character, '\r' | '\n') {
            write_pending(writer, &mut pending)?;
            let line = std::mem::take(&mut guard.input_buffer);
            let dirty = std::mem::replace(&mut guard.buffer_dirty, false);
            if !dirty {
                if let Some(target) = parse_cd_target(&line) {
                    let target_path = Path::new(&target);
                    let next = if target_path.is_absolute() {
                        normalize_path(target_path)
                    } else {
                        normalize_path(&guard.logical_cwd.join(target_path))
                    };
                    if !is_within_root(&next, &guard.workspaces_root) {
                        writer.write_all(b"\x03")?;
                        writer.flush()?;
                        let warning = format!(
                            "\r\n\x1b[33m警告：超出 workspaces ({})，已忽略 \"{}\"\x1b[0m\r\n",
                            guard.workspaces_root.display(),
                            target
                        );
                        let _ = events.send(PtyEvent::Output(warning));
                        continue;
                    }
                    guard.logical_cwd = next;
                }
            }
            writer.write_all(character.to_string().as_bytes())?;
            continue;
        }

        if matches!(character, '\u{8}' | '\u{7f}') {
            guard.input_buffer.pop();
            pending.push(character);
            continue;
        }
        if character == '\t' || (character as u32) < 0x20 {
            guard.buffer_dirty = true;
            pending.push(character);
            continue;
        }
        guard.input_buffer.push(character);
        if guard.input_buffer.chars().count() > INPUT_BUFFER_LIMIT {
            guard.input_buffer = guard
                .input_buffer
                .chars()
                .rev()
                .take(INPUT_BUFFER_LIMIT)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect();
        }
        pending.push(character);
    }
    write_pending(writer, &mut pending)?;
    writer.flush()
}

fn write_pending(writer: &mut dyn Write, pending: &mut String) -> std::io::Result<()> {
    if !pending.is_empty() {
        writer.write_all(pending.as_bytes())?;
        pending.clear();
    }
    Ok(())
}

fn parse_cd_target(line: &str) -> Option<String> {
    let trimmed = line.trim_start();
    let command_end = trimmed.find(char::is_whitespace).unwrap_or(trimmed.len());
    let command = &trimmed[..command_end];
    if !["cd", "chdir", "sl", "set-location", "pushd"]
        .iter()
        .any(|candidate| command.eq_ignore_ascii_case(candidate))
    {
        return None;
    }
    let mut target = trimmed[command_end..].trim();
    if target
        .get(..2)
        .is_some_and(|prefix| prefix.eq_ignore_ascii_case("/d"))
    {
        target = target[2..].trim_start();
    }
    if target.is_empty()
        || target
            .chars()
            .any(|ch| matches!(ch, ';' | '|' | '&' | '`' | '$' | '\r' | '\n'))
    {
        return None;
    }
    if target.len() >= 2
        && ((target.starts_with('"') && target.ends_with('"'))
            || (target.starts_with('\'') && target.ends_with('\'')))
    {
        target = &target[1..target.len() - 1];
    }
    (!target.is_empty()).then(|| target.to_owned())
}

fn normalize_path(path: &Path) -> PathBuf {
    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    normalized
}

fn is_within_root(path: &Path, root: &Path) -> bool {
    if cfg!(windows) {
        let path = path.to_string_lossy().to_lowercase();
        let root = root.to_string_lossy().to_lowercase();
        path == root
            || path
                .strip_prefix(&root)
                .is_some_and(|rest| rest.starts_with('\\') || rest.starts_with('/'))
    } else {
        path == root || path.starts_with(root)
    }
}

fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

fn find_safe_replay_start(data: &str) -> usize {
    let mut search_end = data.len().min(64 * 1024);
    while !data.is_char_boundary(search_end) {
        search_end -= 1;
    }
    let search = &data[..search_end];
    if let Some(offset) = ["\x1b[?1049h", "\x1b[2J", "\x1b[3J"]
        .iter()
        .filter_map(|anchor| search.find(anchor))
        .min()
    {
        return offset;
    }
    let mut synchronized_start = search.find("\x1b[?2026h");
    while let Some(offset) = synchronized_start {
        if data[offset + 8..].contains("\x1b[?2026l") {
            return offset;
        }
        synchronized_start = search[offset + 1..]
            .find("\x1b[?2026h")
            .map(|next| offset + 1 + next);
    }
    if let Some(offset) = search.find(['\r', '\n']) {
        return if search[offset..].starts_with("\r\n") {
            offset + 2
        } else {
            offset + 1
        };
    }
    search[1.min(search.len())..]
        .find('\x1b')
        .map_or(0, |offset| offset + 1)
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn validate_size(cols: u16, rows: u16) -> Result<(), PtyError> {
    if cols == 0 || rows == 0 || cols > 1000 || rows > 1000 {
        Err(PtyError::InvalidSize)
    } else {
        Ok(())
    }
}

fn terminal_environment() -> Vec<(String, String)> {
    let mut values: Vec<(String, String)> = env::vars()
        .filter(|(key, _)| {
            !key.starts_with("VSCODE_")
                && key != "CODEX_INTERNAL_ORIGINATOR_OVERRIDE"
                && key != "CODEX_TUI_DISABLE_KEYBOARD_ENHANCEMENT"
        })
        .collect();
    values.push(("TERM".into(), "xterm-256color".into()));
    values.push(("TERM_PROGRAM".into(), "WezTerm".into()));
    values
}

fn platform_shell_path(path: &Path) -> PathBuf {
    if cfg!(windows) {
        let value = path.to_string_lossy();
        if let Some(rest) = value.strip_prefix(r"\\?\UNC\") {
            return PathBuf::from(format!(r"\\{rest}"));
        }
        if let Some(rest) = value.strip_prefix(r"\\?\") {
            return PathBuf::from(rest);
        }
    }
    path.to_path_buf()
}

fn detect_profiles() -> Vec<NativeShellProfile> {
    let mut profiles = Vec::new();
    if cfg!(windows) {
        if let Some(executable) = find_executable("powershell.exe") {
            profiles.push(profile(
                "powershell",
                "PowerShell",
                executable,
                &["-NoLogo"],
            ));
        }
        if let Some(executable) = find_executable("cmd.exe") {
            profiles.push(profile("cmd", "Command Prompt", executable, &[]));
        }
        for candidate in [
            r"C:\Program Files\Git\bin\bash.exe",
            r"C:\Program Files (x86)\Git\bin\bash.exe",
        ] {
            let executable = PathBuf::from(candidate);
            if executable.is_file() {
                profiles.push(profile("bash", "Git Bash", executable, &["--login", "-i"]));
                break;
            }
        }
    } else {
        if let Some(executable) = find_executable("bash") {
            profiles.push(profile("bash", "bash", executable, &[]));
        }
        if let Some(executable) = find_executable("zsh") {
            profiles.push(profile("zsh", "zsh", executable, &[]));
        }
    }
    profiles
}

fn profile(id: &str, label: &str, executable: PathBuf, args: &[&str]) -> NativeShellProfile {
    NativeShellProfile {
        public: ShellProfile {
            id: id.into(),
            label: label.into(),
            executable: executable.to_string_lossy().into_owned(),
        },
        args: args.iter().map(|arg| (*arg).to_owned()).collect(),
    }
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let candidate = Path::new(name);
    if candidate.is_absolute() && candidate.is_file() {
        return Some(candidate.to_path_buf());
    }
    env::split_paths(&env::var_os("PATH")?).find_map(|directory| {
        let candidate = directory.join(name);
        candidate.is_file().then_some(candidate)
    })
}

#[derive(Default)]
struct Utf8Decoder {
    pending: Vec<u8>,
}

impl Utf8Decoder {
    fn push(&mut self, bytes: &[u8]) -> Vec<String> {
        self.pending.extend_from_slice(bytes);
        let mut output = Vec::new();
        loop {
            match std::str::from_utf8(&self.pending) {
                Ok(text) => {
                    if !text.is_empty() {
                        output.push(text.to_owned());
                    }
                    self.pending.clear();
                    break;
                }
                Err(error) => {
                    let valid = error.valid_up_to();
                    if valid > 0 {
                        output.push(String::from_utf8_lossy(&self.pending[..valid]).into_owned());
                        self.pending.drain(..valid);
                        continue;
                    }
                    if let Some(length) = error.error_len() {
                        output.push(String::from_utf8_lossy(&self.pending[..length]).into_owned());
                        self.pending.drain(..length);
                        continue;
                    }
                    break;
                }
            }
        }
        output
    }

    fn finish(&mut self) -> Option<String> {
        if self.pending.is_empty() {
            None
        } else {
            let pending = std::mem::take(&mut self.pending);
            Some(String::from_utf8_lossy(&pending).into_owned())
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn decoder_preserves_utf8_split_across_pty_reads() {
        let mut decoder = Utf8Decoder::default();
        let bytes = "中文".as_bytes();
        assert!(decoder.push(&bytes[..2]).is_empty());
        assert_eq!(decoder.push(&bytes[2..]).join(""), "中文");
        assert_eq!(decoder.finish(), None);
    }

    #[test]
    fn replay_buffer_stays_bounded_on_utf8_boundaries() {
        let mut replay = ReplayBuffer::new(80, 24, TERMINAL_REPLAY_LIMIT_BYTES);
        replay.append(&"中".repeat(TERMINAL_REPLAY_LIMIT_BYTES));
        assert!(replay.data.len() <= TERMINAL_REPLAY_LIMIT_BYTES);
        assert!(replay.truncated);
        assert!(std::str::from_utf8(replay.data.as_bytes()).is_ok());
    }

    #[test]
    fn persistent_replay_rebases_dimensions_and_resize_offsets() {
        let mut replay = ReplayBuffer::new(120, 34, 36);
        replay.append("old output before resize\r\n");
        replay.record_resize(100, 30, false);
        replay.append("partial discarded\r\n");
        replay.record_resize(84, 28, true);
        replay.append("complete retained line\r\n");

        let snapshot = replay.snapshot();
        assert!(snapshot.truncated);
        assert_eq!((snapshot.initial_cols, snapshot.initial_rows), (84, 28));
        assert!(snapshot.data.starts_with(REPLAY_RESET));
        assert!(snapshot.data.ends_with("complete retained line\r\n"));
        assert!(snapshot.resizes.is_empty());
    }

    #[test]
    fn resize_offsets_use_javascript_utf16_units() {
        let mut replay = ReplayBuffer::new(80, 24, 1024);
        replay.append("a😀中");
        replay.record_resize(100, 30, true);
        assert_eq!(replay.resizes[0].offset, 4);
        assert_eq!(replay.resizes[0].compact_startup, Some(true));
    }

    #[test]
    fn input_guard_blocks_cd_outside_workspace_root() {
        let root = if cfg!(windows) {
            PathBuf::from(r"C:\workspaces")
        } else {
            PathBuf::from("/workspaces")
        };
        let cwd = root.join("demo");
        let mut guard = InputGuard::new(cwd, root);
        let (events, mut receiver) = broadcast::channel(2);
        let mut written = Vec::new();

        process_input(&mut written, &events, &mut guard, "cd ../../outside\r").unwrap();

        assert!(written.ends_with(b"\x03"));
        assert!(
            matches!(receiver.try_recv(), Ok(PtyEvent::Output(message)) if message.contains("已忽略"))
        );
    }

    #[test]
    fn input_guard_tracks_allowed_cd_and_preserves_alt_enter() {
        let root = if cfg!(windows) {
            PathBuf::from(r"C:\workspaces")
        } else {
            PathBuf::from("/workspaces")
        };
        let cwd = root.join("demo");
        let mut guard = InputGuard::new(cwd, root.clone());
        let (events, _) = broadcast::channel(2);
        let mut written = Vec::new();

        process_input(&mut written, &events, &mut guard, "cd ../other\r").unwrap();
        process_input(&mut written, &events, &mut guard, "\x1b\r").unwrap();

        assert_eq!(guard.logical_cwd, root.join("other"));
        assert!(written.ends_with(b"\x1b\r"));
    }

    #[test]
    fn shell_profiles_have_stable_ids() {
        for profile in detect_profiles() {
            assert!(matches!(
                profile.public.id.as_str(),
                "powershell" | "cmd" | "bash" | "zsh"
            ));
            assert!(Path::new(&profile.public.executable).is_file());
        }
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn detected_native_shells_round_trip_and_cleanup() {
        let root = env::temp_dir().join(format!("osheep-pty-test-{}", Uuid::new_v4()));
        let workspace = root.join("demo");
        std::fs::create_dir_all(&workspace).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let workspace = std::fs::canonicalize(workspace).unwrap();
        let runtime = NativePtyRuntime::new(8);
        let profiles = runtime.profiles();
        assert!(!profiles.is_empty(), "no native shell was detected");

        for profile in profiles {
            let session = runtime
                .spawn(SpawnRequest {
                    workspace_id: "demo".into(),
                    cwd: workspace.clone(),
                    workspaces_root: root.clone(),
                    shell: profile.id.clone(),
                    cols: 80,
                    rows: 24,
                    kill_on_detach: true,
                })
                .await
                .unwrap();
            let (_, mut events) = session.attach();
            session.resize(100, 30, false).await.unwrap();
            assert_eq!((session.summary().cols, session.summary().rows), (100, 30));
            let command = match profile.id.as_str() {
                "powershell" => {
                    "1..2000 | ForEach-Object { Write-Output \"LONG_$_\" }; Write-Output 'OSHEEP_UTF8_中文'; Write-Output ([char]27 + '[31mOSHEEP_ANSI' + [char]27 + '[0m'); exit\r"
                }
                "cmd" => {
                    "(for /L %i in (1,1,2000) do @echo LONG_%i) & echo OSHEEP_CMD & exit\r"
                }
                "bash" | "zsh" => {
                    "for i in $(seq 1 2000); do printf 'LONG_%s\\n' \"$i\"; done; printf 'OSHEEP_UTF8_中文\\n\\033[31mOSHEEP_ANSI\\033[0m\\n'; exit\n"
                }
                other => panic!("unexpected shell profile: {other}"),
            };
            session.input(command.into()).await.unwrap();

            let mut output = String::new();
            let exited = tokio::time::timeout(Duration::from_secs(15), async {
                loop {
                    match events.recv().await {
                        Ok(PtyEvent::Output(data)) => output.push_str(&data),
                        Ok(PtyEvent::Exit { .. }) => break true,
                        Ok(PtyEvent::Error(error)) => panic!("{} PTY error: {error}", profile.id),
                        Err(error) => panic!("{} event channel error: {error}", profile.id),
                    }
                }
            })
            .await
            .unwrap_or_else(|_| panic!("{} did not exit within 15 seconds", profile.id));
            assert!(exited);
            assert!(
                output.len() > 10_000,
                "{} did not produce the expected long output",
                profile.id
            );
            assert!(
                output.contains(if profile.id == "cmd" {
                    "OSHEEP_CMD"
                } else {
                    "OSHEEP_UTF8_中文"
                }),
                "{} output did not contain marker: {output:?}",
                profile.id
            );
        }

        tokio::time::timeout(Duration::from_secs(2), async {
            while !runtime.list().is_empty() {
                tokio::time::sleep(Duration::from_millis(10)).await;
            }
        })
        .await
        .expect("exited sessions were not removed from the runtime");
        std::fs::remove_dir_all(root).ok();
    }

    #[tokio::test(flavor = "multi_thread", worker_threads = 2)]
    async fn persistent_native_session_replays_detached_output_and_resize() {
        let root = env::temp_dir().join(format!("osheep-pty-replay-{}", Uuid::new_v4()));
        let workspace = root.join("demo");
        std::fs::create_dir_all(&workspace).unwrap();
        let root = std::fs::canonicalize(root).unwrap();
        let workspace = std::fs::canonicalize(workspace).unwrap();
        let runtime = NativePtyRuntime::new(2);
        let profile = runtime
            .profiles()
            .into_iter()
            .next()
            .expect("no native shell was detected");
        let session = runtime
            .spawn(SpawnRequest {
                workspace_id: "demo".into(),
                cwd: workspace,
                workspaces_root: root.clone(),
                shell: profile.id.clone(),
                cols: 80,
                rows: 24,
                kill_on_detach: false,
            })
            .await
            .unwrap();
        let (_, first_attachment) = session.attach();
        drop(first_attachment);
        session.resize(96, 32, true).await.unwrap();
        let command = match profile.id.as_str() {
            "powershell" => "Write-Output 'OSHEEP_DETACHED_中文'\r",
            "cmd" => "echo OSHEEP_DETACHED\r",
            "bash" | "zsh" => "printf 'OSHEEP_DETACHED_中文\\n'\n",
            other => panic!("unexpected shell profile: {other}"),
        };
        session.input(command.into()).await.unwrap();

        let replay = tokio::time::timeout(Duration::from_secs(10), async {
            loop {
                let (snapshot, receiver) = session.attach();
                drop(receiver);
                if snapshot.data.contains("OSHEEP_DETACHED") {
                    break snapshot;
                }
                tokio::time::sleep(Duration::from_millis(20)).await;
            }
        })
        .await
        .expect("detached output was not added to replay");
        assert_eq!((replay.initial_cols, replay.initial_rows), (80, 24));
        assert_eq!(replay.resizes.len(), 1);
        assert_eq!((replay.resizes[0].cols, replay.resizes[0].rows), (96, 32));
        assert_eq!(replay.resizes[0].compact_startup, Some(true));
        runtime.kill(&session.summary().id).await.unwrap();
        std::fs::remove_dir_all(root).ok();
    }
}
