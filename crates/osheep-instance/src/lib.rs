use serde::{Deserialize, Serialize};
use std::fs::{self, File, OpenOptions};
use std::io::{self, Write};
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use thiserror::Error;

pub const REGISTRY_SCHEMA_VERSION: u32 = 1;
pub const REGISTRY_FILE_NAME: &str = "service.json";
pub const LOCK_FILE_NAME: &str = "service.lock";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ServiceRegistry {
    pub schema_version: u32,
    pub service_version: String,
    pub pid: u32,
    pub address: String,
    pub token: String,
    pub started_at: u64,
}

impl ServiceRegistry {
    pub fn new(service_version: impl Into<String>, address: SocketAddr, token: String) -> Self {
        Self {
            schema_version: REGISTRY_SCHEMA_VERSION,
            service_version: service_version.into(),
            pid: std::process::id(),
            address: address.to_string(),
            token,
            started_at: now_millis(),
        }
    }

    pub fn validate(&self, expected_version: &str) -> Result<SocketAddr, RegistryError> {
        if self.schema_version != REGISTRY_SCHEMA_VERSION {
            return Err(RegistryError::SchemaVersion {
                expected: REGISTRY_SCHEMA_VERSION,
                actual: self.schema_version,
            });
        }
        if self.service_version != expected_version {
            return Err(RegistryError::ServiceVersion {
                expected: expected_version.to_owned(),
                actual: self.service_version.clone(),
            });
        }
        if self.pid == 0 {
            return Err(RegistryError::InvalidPid);
        }
        let address = self
            .address
            .parse::<SocketAddr>()
            .map_err(|_| RegistryError::InvalidAddress(self.address.clone()))?;
        if !address.ip().is_loopback() || address.port() == 0 {
            return Err(RegistryError::NonLoopbackAddress(self.address.clone()));
        }
        if self.token.len() < 32 || !self.token.is_ascii() {
            return Err(RegistryError::InvalidToken);
        }
        Ok(address)
    }
}

#[derive(Debug, Clone)]
pub struct RuntimePaths {
    directory: PathBuf,
}

impl RuntimePaths {
    pub fn new(directory: impl Into<PathBuf>) -> Self {
        Self {
            directory: directory.into(),
        }
    }

    pub fn directory(&self) -> &Path {
        &self.directory
    }

    pub fn lock_file(&self) -> PathBuf {
        self.directory.join(LOCK_FILE_NAME)
    }

    pub fn registry_file(&self) -> PathBuf {
        self.directory.join(REGISTRY_FILE_NAME)
    }
}

#[derive(Debug, Error)]
pub enum RegistryError {
    #[error("another osheep service owns the runtime lock")]
    AlreadyRunning,
    #[error("registry schema mismatch: expected {expected}, found {actual}")]
    SchemaVersion { expected: u32, actual: u32 },
    #[error("service version mismatch: expected {expected}, found {actual}")]
    ServiceVersion { expected: String, actual: String },
    #[error("service registry contains an invalid PID")]
    InvalidPid,
    #[error("service registry contains an invalid address: {0}")]
    InvalidAddress(String),
    #[error("service registry address is not a loopback socket: {0}")]
    NonLoopbackAddress(String),
    #[error("service registry token is invalid")]
    InvalidToken,
    #[error("service registry I/O failed: {0}")]
    Io(#[from] io::Error),
    #[error("service registry JSON is invalid: {0}")]
    Json(#[from] serde_json::Error),
}

pub struct ServiceLock {
    paths: RuntimePaths,
    file: File,
}

impl ServiceLock {
    pub fn try_acquire(paths: RuntimePaths) -> Result<Self, RegistryError> {
        fs::create_dir_all(paths.directory())?;
        restrict_directory(paths.directory())?;
        let file = OpenOptions::new()
            .create(true)
            .truncate(false)
            .read(true)
            .write(true)
            .open(paths.lock_file())?;
        restrict_file(&paths.lock_file())?;
        if !try_lock_exclusive(&file)? {
            return Err(RegistryError::AlreadyRunning);
        }
        Ok(Self { paths, file })
    }

    pub fn publish(self, registry: ServiceRegistry) -> Result<PublishedService, RegistryError> {
        registry.validate(&registry.service_version)?;
        let registry_path = self.paths.registry_file();
        remove_if_exists(&registry_path)?;
        atomic_write_json(&registry_path, &registry)?;
        Ok(PublishedService {
            lock: self,
            registry,
        })
    }
}

pub struct PublishedService {
    lock: ServiceLock,
    registry: ServiceRegistry,
}

impl PublishedService {
    pub fn registry(&self) -> &ServiceRegistry {
        &self.registry
    }
}

impl Drop for PublishedService {
    fn drop(&mut self) {
        let path = self.lock.paths.registry_file();
        let remove = read_registry(&self.lock.paths).is_ok_and(|current| {
            current.pid == self.registry.pid && current.token == self.registry.token
        });
        if remove {
            let _ = fs::remove_file(path);
        }
        let _ = unlock(&self.lock.file);
    }
}

pub fn read_registry(paths: &RuntimePaths) -> Result<ServiceRegistry, RegistryError> {
    let bytes = fs::read(paths.registry_file())?;
    Ok(serde_json::from_slice(&bytes)?)
}

fn atomic_write_json(path: &Path, value: &ServiceRegistry) -> Result<(), RegistryError> {
    let parent = path
        .parent()
        .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "registry has no parent"))?;
    let temporary = parent.join(format!(
        ".{REGISTRY_FILE_NAME}.{}.{}.tmp",
        std::process::id(),
        now_millis()
    ));
    let result = (|| -> Result<(), RegistryError> {
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .open(&temporary)?;
        restrict_file(&temporary)?;
        serde_json::to_writer(&mut file, value)?;
        file.write_all(b"\n")?;
        file.sync_all()?;
        fs::rename(&temporary, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn remove_if_exists(path: &Path) -> io::Result<()> {
    match fs::remove_file(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(error),
    }
}

#[cfg(windows)]
fn try_lock_exclusive(file: &File) -> io::Result<bool> {
    use std::mem::zeroed;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Foundation::ERROR_LOCK_VIOLATION;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    let result = unsafe {
        LockFileEx(
            file.as_raw_handle() as _,
            LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if result != 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error.raw_os_error() == Some(ERROR_LOCK_VIOLATION as i32) {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(windows)]
fn unlock(file: &File) -> io::Result<()> {
    use std::mem::zeroed;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
    use windows_sys::Win32::System::IO::OVERLAPPED;

    let mut overlapped: OVERLAPPED = unsafe { zeroed() };
    let result = unsafe {
        UnlockFileEx(
            file.as_raw_handle() as _,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if result == 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(unix)]
fn try_lock_exclusive(file: &File) -> io::Result<bool> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
    if result == 0 {
        return Ok(true);
    }
    let error = io::Error::last_os_error();
    if error
        .raw_os_error()
        .is_some_and(|code| code == libc::EWOULDBLOCK || code == libc::EAGAIN)
    {
        Ok(false)
    } else {
        Err(error)
    }
}

#[cfg(unix)]
fn unlock(file: &File) -> io::Result<()> {
    use std::os::fd::AsRawFd;
    let result = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_UN) };
    if result == 0 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn restrict_directory(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

#[cfg(not(unix))]
fn restrict_directory(_path: &Path) -> io::Result<()> {
    Ok(())
}

#[cfg(unix)]
fn restrict_file(path: &Path) -> io::Result<()> {
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(path, fs::Permissions::from_mode(0o600))
}

#[cfg(not(unix))]
fn restrict_file(_path: &Path) -> io::Result<()> {
    Ok(())
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::{IpAddr, Ipv4Addr};

    fn temp_paths(label: &str) -> RuntimePaths {
        RuntimePaths::new(std::env::temp_dir().join(format!(
            "osheep-instance-{label}-{}-{}",
            std::process::id(),
            now_millis()
        )))
    }

    fn registry(version: &str) -> ServiceRegistry {
        ServiceRegistry::new(
            version,
            SocketAddr::new(IpAddr::V4(Ipv4Addr::LOCALHOST), 43178),
            "a".repeat(64),
        )
    }

    #[test]
    fn registry_requires_version_loopback_pid_and_token() {
        let valid = registry("0.2.1");
        assert_eq!(valid.validate("0.2.1").unwrap().port(), 43178);

        let mut wrong_version = valid.clone();
        wrong_version.service_version = "9.0.0".into();
        assert!(matches!(
            wrong_version.validate("0.2.1"),
            Err(RegistryError::ServiceVersion { .. })
        ));
        let mut external = valid.clone();
        external.address = "0.0.0.0:43178".into();
        assert!(matches!(
            external.validate("0.2.1"),
            Err(RegistryError::NonLoopbackAddress(_))
        ));
        let mut weak_token = valid;
        weak_token.token = "short".into();
        assert!(matches!(
            weak_token.validate("0.2.1"),
            Err(RegistryError::InvalidToken)
        ));
    }

    #[test]
    fn exclusive_lock_serializes_publish_and_cleans_matching_registry() {
        let paths = temp_paths("lock");
        let published = ServiceLock::try_acquire(paths.clone())
            .unwrap()
            .publish(registry("0.2.1"))
            .unwrap();
        assert_eq!(read_registry(&paths).unwrap(), *published.registry());
        assert!(matches!(
            ServiceLock::try_acquire(paths.clone()),
            Err(RegistryError::AlreadyRunning)
        ));
        drop(published);
        assert!(!paths.registry_file().exists());
        let second = ServiceLock::try_acquire(paths.clone()).unwrap();
        drop(second);
        fs::remove_dir_all(paths.directory()).unwrap();
    }

    #[test]
    fn stale_registry_is_replaced_only_after_lock_acquisition() {
        let paths = temp_paths("stale");
        fs::create_dir_all(paths.directory()).unwrap();
        fs::write(
            paths.registry_file(),
            serde_json::to_vec(&registry("old")).unwrap(),
        )
        .unwrap();
        let current = registry("0.2.1");
        let published = ServiceLock::try_acquire(paths.clone())
            .unwrap()
            .publish(current.clone())
            .unwrap();
        assert_eq!(read_registry(&paths).unwrap(), current);
        drop(published);
        fs::remove_dir_all(paths.directory()).unwrap();
    }
}
