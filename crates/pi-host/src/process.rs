use crate::runtime_manifest::{absolute, io_error, validate_runtime};
use crate::{AgentConnection, HostError, IncomingReceiver, TransportOptions};
use serde_json::{json, Value};
use std::{
    path::{Path, PathBuf},
    process::Stdio,
    time::Duration,
};
use tokio::process::{Child, Command};

/// Paths are supplied by the native application, never by a model/tool.
/// Native validation checks the complete distribution before entry code can
/// execute. Pi also independently checks its locked resources during creation.
pub struct NodeLaunch {
    pub node_executable: PathBuf,
    pub runtime_directory: PathBuf,
    pub working_directory: PathBuf,
    pub transport: TransportOptions,
}

pub struct NodeProcess {
    connection: AgentConnection,
    child: Child,
}

#[derive(Debug, Clone)]
pub struct ProcessExit {
    pub code: Option<i32>,
    pub success: bool,
    pub forced: bool,
    /// These are protocol acknowledgements, not proof that an external write
    /// was rolled back. Its native call ledger remains authoritative.
    pub abort_confirmed: bool,
    pub session_close_confirmed: bool,
}

fn node_entry_argument(entry: &Path) -> Result<PathBuf, HostError> {
    #[cfg(windows)]
    {
        use std::path::{Component, Prefix};
        // Rust canonicalization returns a verbatim Win32 path. Node 24's
        // main-module loader treats that argv spelling as a drive-relative
        // path and fails with EISDIR on `D:`. Keep canonical validation, but
        // pass its ordinary spelling only after proving the identity again.
        let value = entry
            .to_str()
            .ok_or_else(|| HostError::Protocol("Pi entry argument must be UTF-8".into()))?;
        let argument = match entry.components().next() {
            Some(Component::Prefix(prefix)) => match prefix.kind() {
                Prefix::VerbatimDisk(_) => {
                    PathBuf::from(value.strip_prefix(r"\\?\").ok_or_else(|| {
                        HostError::Protocol("invalid verbatim Pi entry path".into())
                    })?)
                }
                Prefix::VerbatimUNC(_, _) => PathBuf::from(format!(
                    r"\\{}",
                    value.strip_prefix(r"\\?\UNC\").ok_or_else(|| {
                        HostError::Protocol("invalid verbatim Pi entry UNC path".into())
                    })?
                )),
                Prefix::Verbatim(_) => {
                    return Err(HostError::Protocol(
                        "unsupported Pi entry device path".into(),
                    ))
                }
                _ => entry.to_path_buf(),
            },
            _ => entry.to_path_buf(),
        };
        if absolute(&argument)? != entry {
            return Err(HostError::Protocol(
                "Pi entry argument changed its canonical identity".into(),
            ));
        }
        Ok(argument)
    }
    #[cfg(not(windows))]
    {
        Ok(entry.to_path_buf())
    }
}

fn paths(launch: &NodeLaunch) -> Result<(PathBuf, PathBuf, PathBuf), HostError> {
    let node = absolute(&launch.node_executable)?;
    // Validate the supplied directory before canonicalizing away any links.
    validate_runtime(&launch.runtime_directory)?;
    let runtime = absolute(&launch.runtime_directory)?;
    let working = absolute(&launch.working_directory)?;
    if !node.is_file() || !runtime.is_dir() || !working.is_dir() {
        return Err(HostError::Protocol(
            "native runtime paths are unavailable".into(),
        ));
    }
    let entry = absolute(&runtime.join("host/src/entry.mjs"))?;
    if !entry.is_file() || !entry.starts_with(&runtime) {
        return Err(HostError::Protocol("fixed Pi entry is unavailable".into()));
    }
    Ok((node, entry, working))
}

impl NodeProcess {
    /// Also exposed for native packaging/diagnostics without starting Node or
    /// issuing a model request. The fixed source/version checks are mandatory.
    pub fn validate_runtime(directory: &Path) -> Result<Value, HostError> {
        validate_runtime(directory)
    }

    pub async fn spawn(launch: NodeLaunch) -> Result<(Self, IncomingReceiver), HostError> {
        let (node, entry, working) = paths(&launch)?;
        let entry = node_entry_argument(&entry)?;
        let mut command = Command::new(node);
        command
            .arg(entry)
            .current_dir(working)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .kill_on_drop(true)
            .env_clear();
        // Do not inherit provider keys, proxy credentials, NODE_OPTIONS, Node
        // extension loaders or authentication paths from the desktop shell.
        // Only OS startup/temp/locale values are retained.
        for name in [
            "SystemRoot",
            "WINDIR",
            "TEMP",
            "TMP",
            "TMPDIR",
            "LANG",
            "LC_ALL",
        ] {
            if let Some(value) = std::env::var_os(name) {
                command.env(name, value);
            }
        }
        #[cfg(windows)]
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW
        let mut child = command.spawn().map_err(io_error)?;
        let output = child
            .stdout
            .take()
            .ok_or_else(|| HostError::Protocol("missing host output pipe".into()))?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| HostError::Protocol("missing host input pipe".into()))?;
        let (connection, incoming) = match AgentConnection::attach(output, input, launch.transport)
        {
            Ok(transport) => transport,
            Err(error) => {
                let _ = child.start_kill();
                let _ = child.wait().await;
                return Err(error);
            }
        };
        Ok((Self { connection, child }, incoming))
    }

    pub fn connection(&self) -> AgentConnection {
        self.connection.clone()
    }
    pub fn process_id(&self) -> Option<u32> {
        self.child.id()
    }

    pub async fn wait(&mut self) -> Result<ProcessExit, HostError> {
        let status = self.child.wait().await.map_err(io_error)?;
        self.connection.close_transport().await;
        Ok(ProcessExit {
            code: status.code(),
            success: status.success(),
            forced: false,
            abort_confirmed: false,
            session_close_confirmed: false,
        })
    }

    /// Only this owned child is terminated; no PID lookup/reuse can affect a
    /// newer host. The native service has already fenced and settled writes.
    pub async fn terminate(&mut self) -> Result<(), HostError> {
        self.connection.close_transport().await;
        self.child.start_kill().map_err(io_error)?;
        self.child.wait().await.map_err(io_error)?;
        Ok(())
    }

    /// First asks Pi to stop and dispose its session, then closes stdin and
    /// waits for process exit. A timeout kills this owned process only and
    /// reports `forced`; it never retries tools or claims a business rollback.
    pub async fn shutdown(&mut self, grace: Duration) -> Result<ProcessExit, HostError> {
        let abort_confirmed = matches!(
            tokio::time::timeout(grace, self.connection.request("abort", json!({}))).await,
            Ok(Ok(_))
        );
        let session_close_confirmed = matches!(
            tokio::time::timeout(grace, self.connection.request("close", json!({}))).await,
            Ok(Ok(_))
        );
        self.connection.close_transport().await;
        let (status, forced) = match tokio::time::timeout(grace, self.child.wait()).await {
            Ok(result) => (result.map_err(io_error)?, false),
            Err(_) => {
                self.child.start_kill().map_err(io_error)?;
                (self.child.wait().await.map_err(io_error)?, true)
            }
        };
        Ok(ProcessExit {
            code: status.code(),
            success: status.success(),
            forced,
            abort_confirmed,
            session_close_confirmed,
        })
    }
}

#[cfg(all(test, windows))]
mod windows_entry_tests {
    use super::*;

    #[test]
    fn node_argument_keeps_the_verified_file_without_verbatim_prefix() {
        let canonical = std::env::current_exe().unwrap().canonicalize().unwrap();
        assert!(canonical.to_str().unwrap().starts_with(r"\\?\"));
        let argument = node_entry_argument(&canonical).unwrap();
        assert!(!argument.to_str().unwrap().starts_with(r"\\?\"));
        assert_eq!(argument.canonicalize().unwrap(), canonical);
    }
}
