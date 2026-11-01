//! Native transport for the pinned Pi host. No Agent loop or model context lives here.
#[cfg(not(target_os = "android"))]
mod process;
mod runtime_manifest;
mod transport;

#[cfg(not(target_os = "android"))]
pub use process::{NodeLaunch, NodeProcess, ProcessExit};
pub use runtime_manifest::validate_runtime;
pub use transport::{
    AgentConnection, HostError, Incoming, IncomingReceiver, ToolRequest, TransportOptions,
    MAX_FRAME_BYTES,
};
