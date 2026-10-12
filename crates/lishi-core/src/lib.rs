//! Platform-independent application core. M01 exposes text and SQLite probes.

pub mod probe_jobs;
pub mod probe_pack;
pub mod recovery;
pub mod secret_probe;
pub mod secrets;
pub mod storage;
pub mod stream;

pub use storage::{ProbeNote, ProbeStore, ProbeStoreError, MAX_PROBE_NOTE_BYTES};
pub use stream::{
    run_probe_stream, run_probe_stream_with_options, ProbeStreamEvent, StreamErrorCode,
    StreamEventKind, StreamOptions, StreamResult, StreamStatus,
};
pub use tokio_util::sync::CancellationToken;

use serde::Serialize;

pub const CORE_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EchoResult {
    pub text: String,
    pub unicode_scalar_count: usize,
    pub utf8_byte_count: usize,
}

pub fn echo_text(text: String) -> EchoResult {
    EchoResult {
        unicode_scalar_count: text.chars().count(),
        utf8_byte_count: text.len(),
        text,
    }
}
