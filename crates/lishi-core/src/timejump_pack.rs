//! Bounded, uncompressed `.timejump` container transport.
//!
//! A pack contains an exact, typed manifest followed by raw entries in manifest
//! order. It never executes SQL or installs a save. Callers must make consistent
//! SQLite backups and audit the extracted domains before installing them. A
//! checksum detects corruption; it does not authenticate an author.
//!
//! The extraction directory must be new, inside a caller-owned private parent.
//! Callers must exclude concurrent filesystem changes to that parent and source
//! files. Standard-library path checks reject existing symlink/reparse traversal
//! but cannot provide an adversarial multi-process filesystem sandbox.

use std::{
    collections::HashSet,
    fmt,
    fs::{self, File, OpenOptions},
    io::{self, Read, Write},
    path::{Component, Path, PathBuf},
};

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::game_store::valid_game_id;

pub const TIMEJUMP_MAGIC: [u8; 8] = *b"TIMEJMP\0";
pub const TIMEJUMP_FORMAT_VERSION: u32 = 1;
pub const MAX_TIMEJUMP_MANIFEST_BYTES: u32 = 64 * 1024;
pub const MAX_TIMEJUMP_ENTRY_BYTES: u64 = 512 * 1024 * 1024;
pub const MAX_TIMEJUMP_TOTAL_BYTES: u64 = 1024 * 1024 * 1024;
pub const TIMEJUMP_IO_BUFFER_BYTES: usize = 64 * 1024;
const HEADER_BYTES: u64 = 16;
const MAX_TIMESTAMP_MS: i64 = 8_640_000_000_000_000;

/// Fixed names are the entire format's path namespace. Optional entries may be
/// absent at the transport layer; save-domain importers impose required subsets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum PackEntryName {
    #[serde(rename = "world.sqlite")]
    WorldSqlite,
    #[serde(rename = "annotations.sqlite")]
    AnnotationsSqlite,
    #[serde(rename = "research.json")]
    ResearchJson,
    #[serde(rename = "story.md")]
    StoryMarkdown,
    #[serde(rename = "sources.json")]
    SourcesJson,
}

impl PackEntryName {
    pub const fn file_name(self) -> &'static str {
        match self {
            Self::WorldSqlite => "world.sqlite",
            Self::AnnotationsSqlite => "annotations.sqlite",
            Self::ResearchJson => "research.json",
            Self::StoryMarkdown => "story.md",
            Self::SourcesJson => "sources.json",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackMetadata {
    pub world_id: String,
    pub schema_version: u32,
    pub created_at_ms: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PackSource {
    pub name: PackEntryName,
    pub path: PathBuf,
}

/// Limits can be lowered for callers and tests. They cannot exceed the public
/// hard bounds, including the manifest allocation bound. `max_total_bytes`
/// includes the header and manifest, not only payloads.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct PackLimits {
    pub max_manifest_bytes: u32,
    pub max_entry_bytes: u64,
    pub max_total_bytes: u64,
}

impl Default for PackLimits {
    fn default() -> Self {
        Self {
            max_manifest_bytes: MAX_TIMEJUMP_MANIFEST_BYTES,
            max_entry_bytes: MAX_TIMEJUMP_ENTRY_BYTES,
            max_total_bytes: MAX_TIMEJUMP_TOTAL_BYTES,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackEntry {
    pub name: PackEntryName,
    pub size_bytes: u64,
    pub sha256: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PackManifest {
    pub format_version: u32,
    pub world_id: String,
    pub schema_version: u32,
    pub created_at_ms: i64,
    pub entries: Vec<PackEntry>,
}

/// Constructed only after every payload, checksum and the final EOF validate.
/// Domain validation remains the caller's responsibility.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VerifiedTimejumpPack {
    pub manifest: PackManifest,
    pub directory: PathBuf,
}

impl VerifiedTimejumpPack {
    pub fn path(&self, name: PackEntryName) -> Option<PathBuf> {
        self.manifest
            .entries
            .iter()
            .any(|entry| entry.name == name)
            .then(|| self.directory.join(name.file_name()))
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TimejumpPackError {
    InvalidLimits,
    InvalidHeader,
    UnsupportedVersion,
    InvalidManifest,
    TooLarge,
    Truncated,
    TrailingData,
    ChecksumMismatch,
    SourceChanged,
    UnsafePath,
    DestinationExists,
    Io,
}

impl TimejumpPackError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidLimits => "timejump_invalid_limits",
            Self::InvalidHeader => "timejump_invalid_header",
            Self::UnsupportedVersion => "timejump_unsupported_version",
            Self::InvalidManifest => "timejump_invalid_manifest",
            Self::TooLarge => "timejump_too_large",
            Self::Truncated => "timejump_truncated",
            Self::TrailingData => "timejump_trailing_data",
            Self::ChecksumMismatch => "timejump_checksum_mismatch",
            Self::SourceChanged => "timejump_source_changed",
            Self::UnsafePath => "timejump_unsafe_path",
            Self::DestinationExists => "timejump_destination_exists",
            Self::Io => "timejump_io_error",
        }
    }
}

impl fmt::Display for TimejumpPackError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(self.code())
    }
}

impl std::error::Error for TimejumpPackError {}

/// Hash regular files in bounded chunks, then stream the same entries to the
/// output. Sources must be immutable, consistent snapshots owned by the caller.
/// Changes detected during the second pass fail rather than return a manifest.
/// On failure, the caller must discard the incomplete output.
pub fn write_timejump_pack<W: Write>(
    mut writer: W,
    metadata: &PackMetadata,
    sources: &[PackSource],
    limits: PackLimits,
) -> Result<PackManifest, TimejumpPackError> {
    validate_limits(limits)?;
    validate_metadata(metadata)?;
    if sources.is_empty() || sources.len() > 5 {
        return Err(TimejumpPackError::InvalidManifest);
    }
    let mut entries = Vec::with_capacity(sources.len());
    let mut seen = HashSet::new();
    let mut payload_bytes = 0_u64;
    for source in sources {
        if !seen.insert(source.name) {
            return Err(TimejumpPackError::InvalidManifest);
        }
        let mut input = open_regular_source(&source.path)?;
        let size = input.metadata().map_err(|_| TimejumpPackError::Io)?.len();
        check_payload_size(size, &mut payload_bytes, limits)?;
        let sha256 = hash_exact(&mut input, size)?;
        entries.push(PackEntry {
            name: source.name,
            size_bytes: size,
            sha256,
        });
    }
    let manifest = PackManifest {
        format_version: TIMEJUMP_FORMAT_VERSION,
        world_id: metadata.world_id.clone(),
        schema_version: metadata.schema_version,
        created_at_ms: metadata.created_at_ms,
        entries,
    };
    let manifest_bytes =
        serde_json::to_vec(&manifest).map_err(|_| TimejumpPackError::InvalidManifest)?;
    validate_manifest(&manifest, manifest_bytes.len(), limits)?;
    writer
        .write_all(&TIMEJUMP_MAGIC)
        .and_then(|()| writer.write_all(&TIMEJUMP_FORMAT_VERSION.to_le_bytes()))
        .and_then(|()| writer.write_all(&(manifest_bytes.len() as u32).to_le_bytes()))
        .and_then(|()| writer.write_all(&manifest_bytes))
        .map_err(|_| TimejumpPackError::Io)?;
    for (source, entry) in sources.iter().zip(&manifest.entries) {
        let mut input = open_regular_source(&source.path)?;
        if input.metadata().map_err(|_| TimejumpPackError::Io)?.len() != entry.size_bytes {
            return Err(TimejumpPackError::SourceChanged);
        }
        let digest =
            copy_exact(&mut input, &mut writer, entry.size_bytes).map_err(|error| match error {
                TimejumpPackError::Truncated => TimejumpPackError::SourceChanged,
                other => other,
            })?;
        if read_extra(&mut input)? {
            return Err(TimejumpPackError::SourceChanged);
        }
        if digest != entry.sha256 {
            return Err(TimejumpPackError::SourceChanged);
        }
    }
    writer.flush().map_err(|_| TimejumpPackError::Io)?;
    Ok(manifest)
}

/// Validate a bounded manifest before creating `new_stage_dir`, then stream each
/// entry to an exclusive new file. Failure never produces a verified bundle or
/// touches an existing save. Partial staging files may remain: the caller owns
/// this private directory and must remove it on all failure paths.
pub fn unpack_timejump_pack<R: Read>(
    mut reader: R,
    new_stage_dir: impl AsRef<Path>,
    limits: PackLimits,
) -> Result<VerifiedTimejumpPack, TimejumpPackError> {
    validate_limits(limits)?;
    let mut header = [0_u8; HEADER_BYTES as usize];
    read_exact(&mut reader, &mut header)?;
    if header[..8] != TIMEJUMP_MAGIC {
        return Err(TimejumpPackError::InvalidHeader);
    }
    let version = u32::from_le_bytes(header[8..12].try_into().expect("fixed header"));
    if version != TIMEJUMP_FORMAT_VERSION {
        return Err(TimejumpPackError::UnsupportedVersion);
    }
    let manifest_len = u32::from_le_bytes(header[12..16].try_into().expect("fixed header"));
    if manifest_len == 0 {
        return Err(TimejumpPackError::InvalidManifest);
    }
    if manifest_len > limits.max_manifest_bytes
        || HEADER_BYTES + u64::from(manifest_len) > limits.max_total_bytes
    {
        return Err(TimejumpPackError::TooLarge);
    }
    let mut manifest_bytes = vec![0_u8; manifest_len as usize];
    read_exact(&mut reader, &mut manifest_bytes)?;
    let manifest_text =
        std::str::from_utf8(&manifest_bytes).map_err(|_| TimejumpPackError::InvalidManifest)?;
    let manifest: PackManifest =
        serde_json::from_str(manifest_text).map_err(|_| TimejumpPackError::InvalidManifest)?;
    validate_manifest(&manifest, manifest_bytes.len(), limits)?;
    let directory = new_stage_dir.as_ref();
    create_private_stage(directory)?;
    for entry in &manifest.entries {
        let path = directory.join(entry.name.file_name());
        // Never follow an existing entry, even in this caller-owned new stage.
        reject_existing(&path)?;
        let mut output = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|error| match error.kind() {
                io::ErrorKind::AlreadyExists => TimejumpPackError::DestinationExists,
                _ => TimejumpPackError::Io,
            })?;
        let digest = copy_exact(&mut reader, &mut output, entry.size_bytes)?;
        output.flush().map_err(|_| TimejumpPackError::Io)?;
        output.sync_all().map_err(|_| TimejumpPackError::Io)?;
        if digest != entry.sha256 {
            return Err(TimejumpPackError::ChecksumMismatch);
        }
    }
    if read_extra(&mut reader)? {
        return Err(TimejumpPackError::TrailingData);
    }
    Ok(VerifiedTimejumpPack {
        manifest,
        directory: directory.to_path_buf(),
    })
}

fn validate_limits(limits: PackLimits) -> Result<(), TimejumpPackError> {
    if limits.max_manifest_bytes == 0
        || limits.max_manifest_bytes > MAX_TIMEJUMP_MANIFEST_BYTES
        || limits.max_entry_bytes == 0
        || limits.max_entry_bytes > MAX_TIMEJUMP_ENTRY_BYTES
        || limits.max_total_bytes < HEADER_BYTES
        || limits.max_total_bytes > MAX_TIMEJUMP_TOTAL_BYTES
    {
        return Err(TimejumpPackError::InvalidLimits);
    }
    Ok(())
}

fn validate_metadata(metadata: &PackMetadata) -> Result<(), TimejumpPackError> {
    if !valid_game_id(&metadata.world_id)
        || !(0..=MAX_TIMESTAMP_MS).contains(&metadata.created_at_ms)
    {
        return Err(TimejumpPackError::InvalidManifest);
    }
    if !(1..=3).contains(&metadata.schema_version) {
        return Err(TimejumpPackError::UnsupportedVersion);
    }
    Ok(())
}

fn validate_manifest(
    manifest: &PackManifest,
    manifest_bytes: usize,
    limits: PackLimits,
) -> Result<(), TimejumpPackError> {
    if manifest.format_version != TIMEJUMP_FORMAT_VERSION {
        return Err(TimejumpPackError::UnsupportedVersion);
    }
    validate_metadata(&PackMetadata {
        world_id: manifest.world_id.clone(),
        schema_version: manifest.schema_version,
        created_at_ms: manifest.created_at_ms,
    })?;
    if manifest_bytes > limits.max_manifest_bytes as usize {
        return Err(TimejumpPackError::TooLarge);
    }
    if manifest.entries.is_empty() || manifest.entries.len() > 5 {
        return Err(TimejumpPackError::InvalidManifest);
    }
    let mut seen = HashSet::new();
    let mut payload_bytes = 0;
    for entry in &manifest.entries {
        if !seen.insert(entry.name)
            || entry.sha256.len() != 64
            || !entry
                .sha256
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
            || (entry.name == PackEntryName::WorldSqlite && entry.size_bytes == 0)
        {
            return Err(TimejumpPackError::InvalidManifest);
        }
        check_payload_size(entry.size_bytes, &mut payload_bytes, limits)?;
    }
    if !seen.contains(&PackEntryName::WorldSqlite) {
        return Err(TimejumpPackError::InvalidManifest);
    }
    HEADER_BYTES
        .checked_add(manifest_bytes as u64)
        .and_then(|size| size.checked_add(payload_bytes))
        .filter(|&size| size <= limits.max_total_bytes)
        .ok_or(TimejumpPackError::TooLarge)?;
    Ok(())
}

fn check_payload_size(
    size: u64,
    total: &mut u64,
    limits: PackLimits,
) -> Result<(), TimejumpPackError> {
    if size > limits.max_entry_bytes {
        return Err(TimejumpPackError::TooLarge);
    }
    *total = total
        .checked_add(size)
        .filter(|&sum| sum <= limits.max_total_bytes)
        .ok_or(TimejumpPackError::TooLarge)?;
    Ok(())
}

fn read_exact<R: Read>(reader: &mut R, output: &mut [u8]) -> Result<(), TimejumpPackError> {
    reader
        .read_exact(output)
        .map_err(|error| match error.kind() {
            io::ErrorKind::UnexpectedEof => TimejumpPackError::Truncated,
            _ => TimejumpPackError::Io,
        })
}

fn read_extra<R: Read>(reader: &mut R) -> Result<bool, TimejumpPackError> {
    let mut extra = [0_u8; 1];
    loop {
        match reader.read(&mut extra) {
            Ok(size) => return Ok(size != 0),
            Err(error) if error.kind() == io::ErrorKind::Interrupted => continue,
            Err(_) => return Err(TimejumpPackError::Io),
        }
    }
}

fn hash_exact<R: Read>(reader: &mut R, size: u64) -> Result<String, TimejumpPackError> {
    let digest = copy_exact(reader, &mut io::sink(), size)?;
    if read_extra(reader)? {
        return Err(TimejumpPackError::SourceChanged);
    }
    Ok(digest)
}

fn copy_exact<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    mut remaining: u64,
) -> Result<String, TimejumpPackError> {
    let mut digest = Sha256::new();
    let mut buffer = [0_u8; TIMEJUMP_IO_BUFFER_BYTES];
    while remaining != 0 {
        let count = buffer.len().min(remaining as usize);
        read_exact(reader, &mut buffer[..count])?;
        writer
            .write_all(&buffer[..count])
            .map_err(|_| TimejumpPackError::Io)?;
        digest.update(&buffer[..count]);
        remaining -= count as u64;
    }
    Ok(format!("{:x}", digest.finalize()))
}

fn reject_existing(path: &Path) -> Result<(), TimejumpPackError> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if is_link_or_reparse(&metadata) => Err(TimejumpPackError::UnsafePath),
        Ok(_) => Err(TimejumpPackError::DestinationExists),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(_) => Err(TimejumpPackError::Io),
    }
}

fn create_private_stage(path: &Path) -> Result<(), TimejumpPackError> {
    // One fresh directory only; never recursively follow caller-provided paths.
    if !path.is_absolute() || path.file_name().is_none() {
        return Err(TimejumpPackError::UnsafePath);
    }
    let parent = path.parent().ok_or(TimejumpPackError::UnsafePath)?;
    check_existing_components(parent)?;
    if !fs::metadata(parent)
        .map_err(|_| TimejumpPackError::Io)?
        .is_dir()
    {
        return Err(TimejumpPackError::UnsafePath);
    }
    reject_existing(path)?;
    fs::create_dir(path).map_err(|error| match error.kind() {
        io::ErrorKind::AlreadyExists => TimejumpPackError::DestinationExists,
        _ => TimejumpPackError::Io,
    })?;
    let metadata = fs::symlink_metadata(path).map_err(|_| TimejumpPackError::Io)?;
    if is_link_or_reparse(&metadata) || !metadata.is_dir() {
        return Err(TimejumpPackError::UnsafePath);
    }
    Ok(())
}

fn open_regular_source(path: &Path) -> Result<File, TimejumpPackError> {
    check_existing_components(path)?;
    let before = fs::symlink_metadata(path).map_err(|_| TimejumpPackError::Io)?;
    if !before.is_file() || is_link_or_reparse(&before) {
        return Err(TimejumpPackError::UnsafePath);
    }
    let file = File::open(path).map_err(|_| TimejumpPackError::Io)?;
    if !file
        .metadata()
        .map_err(|_| TimejumpPackError::Io)?
        .is_file()
    {
        return Err(TimejumpPackError::UnsafePath);
    }
    Ok(file)
}

fn check_existing_components(path: &Path) -> Result<(), TimejumpPackError> {
    if !path.is_absolute() {
        return Err(TimejumpPackError::UnsafePath);
    }
    let mut resolved = PathBuf::new();
    for component in path.components() {
        if matches!(component, Component::ParentDir | Component::CurDir) {
            return Err(TimejumpPackError::UnsafePath);
        }
        resolved.push(component.as_os_str());
        // Windows drive/UNC prefixes are not themselves ordinary filesystem
        // entries. The following RootDir completes the volume root.
        if matches!(component, Component::Prefix(_)) {
            continue;
        }
        let metadata = fs::symlink_metadata(&resolved).map_err(|_| TimejumpPackError::Io)?;
        if is_link_or_reparse(&metadata) {
            return Err(TimejumpPackError::UnsafePath);
        }
    }
    Ok(())
}

fn is_link_or_reparse(metadata: &fs::Metadata) -> bool {
    if metadata.file_type().is_symlink() {
        return true;
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        if metadata.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return true;
        }
    }
    false
}
