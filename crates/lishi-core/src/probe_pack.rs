//! Small, explicitly typed M01 file probe. This is not a game save format.
//!
//! Only the supplied note is serialized. The checksum detects accidental
//! corruption; it does not authenticate a document or its author.

use std::fmt;
use std::io::{Read, Write};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

pub const PROBE_PACK_FORMAT: &str = "lishi-m01-probe";
pub const PROBE_PACK_VERSION: u32 = 1;
pub const MAX_PROBE_PACK_NOTE_BYTES: usize = 64 * 1024;
// JSON may represent each control byte with a six-byte escape.
pub const MAX_PROBE_PACK_BYTES: usize = 400 * 1024;

#[derive(Debug, PartialEq, Eq)]
pub struct ProbePack {
    pub note: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProbePackError {
    TooLarge,
    Invalid,
    UnsupportedVersion,
    ChecksumMismatch,
    Io,
}

impl ProbePackError {
    pub fn code(self) -> &'static str {
        match self {
            Self::TooLarge => "pack_too_large",
            Self::Invalid => "pack_invalid",
            Self::UnsupportedVersion => "pack_unsupported_version",
            Self::ChecksumMismatch => "pack_checksum_mismatch",
            Self::Io => "file_io_error",
        }
    }
}

impl fmt::Display for ProbePackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for ProbePackError {}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Envelope {
    format: String,
    version: u32,
    note: String,
    checksum: Checksum,
}

#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Checksum {
    algorithm: String,
    value: String,
}

fn checksum(note: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(PROBE_PACK_FORMAT.as_bytes());
    digest.update([0]);
    digest.update(PROBE_PACK_VERSION.to_le_bytes());
    digest.update([0]);
    digest.update(note.as_bytes());
    format!("{:x}", digest.finalize())
}

pub fn encode_probe_pack(note: &str) -> Result<Vec<u8>, ProbePackError> {
    if note.len() > MAX_PROBE_PACK_NOTE_BYTES {
        return Err(ProbePackError::TooLarge);
    }
    let envelope = Envelope {
        format: PROBE_PACK_FORMAT.into(),
        version: PROBE_PACK_VERSION,
        note: note.into(),
        checksum: Checksum {
            algorithm: "sha256".into(),
            value: checksum(note),
        },
    };
    let bytes = serde_json::to_vec_pretty(&envelope).map_err(|_| ProbePackError::Invalid)?;
    if bytes.len() > MAX_PROBE_PACK_BYTES {
        return Err(ProbePackError::TooLarge);
    }
    Ok(bytes)
}

pub fn decode_probe_pack(bytes: &[u8]) -> Result<ProbePack, ProbePackError> {
    if bytes.len() > MAX_PROBE_PACK_BYTES {
        return Err(ProbePackError::TooLarge);
    }
    let envelope: Envelope = serde_json::from_slice(bytes).map_err(|_| ProbePackError::Invalid)?;
    if envelope.format != PROBE_PACK_FORMAT {
        return Err(ProbePackError::Invalid);
    }
    if envelope.version != PROBE_PACK_VERSION {
        return Err(ProbePackError::UnsupportedVersion);
    }
    if envelope.note.len() > MAX_PROBE_PACK_NOTE_BYTES {
        return Err(ProbePackError::TooLarge);
    }
    if envelope.checksum.algorithm != "sha256"
        || envelope.checksum.value.len() != 64
        || !envelope
            .checksum
            .value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(ProbePackError::Invalid);
    }
    if envelope.checksum.value != checksum(&envelope.note) {
        return Err(ProbePackError::ChecksumMismatch);
    }
    Ok(ProbePack {
        note: envelope.note,
    })
}

/// Copies at most MAX bytes to a private stage, then reads one extra byte to
/// distinguish an exact-size document from an oversized/unbounded input.
/// The caller owns and removes the stage on every success or error path.
pub fn copy_probe_pack<R: Read, W: Write>(
    mut source: R,
    mut stage: W,
) -> Result<usize, ProbePackError> {
    let mut copied = 0;
    let mut buffer = [0_u8; 8192];
    while copied < MAX_PROBE_PACK_BYTES {
        let limit = buffer.len().min(MAX_PROBE_PACK_BYTES - copied);
        let count = source
            .read(&mut buffer[..limit])
            .map_err(|_| ProbePackError::Io)?;
        if count == 0 {
            stage.flush().map_err(|_| ProbePackError::Io)?;
            return Ok(copied);
        }
        stage
            .write_all(&buffer[..count])
            .map_err(|_| ProbePackError::Io)?;
        copied += count;
    }
    let mut overflow = [0_u8; 1];
    if source.read(&mut overflow).map_err(|_| ProbePackError::Io)? != 0 {
        return Err(ProbePackError::TooLarge);
    }
    stage.flush().map_err(|_| ProbePackError::Io)?;
    Ok(copied)
}
