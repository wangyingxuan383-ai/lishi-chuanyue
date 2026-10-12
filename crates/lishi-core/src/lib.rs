//! Platform-independent application core. M01 exposes text and SQLite probes.

pub mod storage;

pub use storage::{ProbeNote, ProbeStore, ProbeStoreError, MAX_PROBE_NOTE_BYTES};

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
