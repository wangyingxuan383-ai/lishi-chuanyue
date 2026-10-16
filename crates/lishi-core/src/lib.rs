//! Platform-independent application core. M01 exposes text and SQLite probes.

pub mod game_annotations;
pub mod game_archive;
mod game_backup;
pub mod game_call_log;
pub mod game_context;
pub mod game_context_log;
pub mod game_cost;
pub mod game_inspection;
pub mod game_knowledge;
pub mod game_legacy;
pub mod game_memory;
pub mod game_migration;
pub mod game_output_diagnostic;
pub mod game_portable_schema;
pub mod game_protocol;
pub mod game_protocol_v2;
pub mod game_provider;
pub mod game_provider_v2;
pub mod game_store;
pub mod game_store_v2;
pub use game_store_v2::branches as game_branches;
pub mod game_calendar;
pub mod game_fast_forward;
pub mod game_research;
pub mod game_research_store;
pub mod model_probe;
pub mod probe_jobs;
pub mod probe_pack;
pub mod recovery;
pub mod secret_probe;
pub mod secrets;
pub mod storage;
pub mod stream;
pub mod timejump_pack;

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
