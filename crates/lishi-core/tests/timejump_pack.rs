use std::{
    cell::Cell,
    fs,
    io::{self, Cursor, Read, Write},
    path::{Path, PathBuf},
    rc::Rc,
};

use lishi_core::timejump_pack::{
    unpack_timejump_pack, write_timejump_pack, PackEntryName, PackLimits, PackManifest,
    PackMetadata, PackSource, TimejumpPackError, MAX_TIMEJUMP_ENTRY_BYTES,
    MAX_TIMEJUMP_MANIFEST_BYTES, MAX_TIMEJUMP_TOTAL_BYTES, TIMEJUMP_FORMAT_VERSION,
    TIMEJUMP_IO_BUFFER_BYTES, TIMEJUMP_MAGIC,
};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tempfile::{tempdir, TempDir};

fn metadata() -> PackMetadata {
    PackMetadata {
        world_id: "world-20261015-test".into(),
        schema_version: 3,
        created_at_ms: 1_792_000_000_000,
    }
}

fn source(root: &Path, name: PackEntryName, bytes: &[u8]) -> PackSource {
    let path = root.join(name.file_name());
    fs::write(&path, bytes).unwrap();
    PackSource { name, path }
}

fn encode(sources: &[PackSource]) -> (Vec<u8>, PackManifest) {
    let mut bytes = Vec::new();
    let manifest =
        write_timejump_pack(&mut bytes, &metadata(), sources, PackLimits::default()).unwrap();
    (bytes, manifest)
}

fn minimal() -> (TempDir, Vec<u8>, PackManifest) {
    let temp = tempdir().unwrap();
    let input = source(
        temp.path(),
        PackEntryName::WorldSqlite,
        b"fixture-not-domain-audited",
    );
    let (bytes, manifest) = encode(&[input]);
    (temp, bytes, manifest)
}

fn envelope(manifest: &Value, payload: &[u8]) -> Vec<u8> {
    let encoded = serde_json::to_vec(manifest).unwrap();
    let mut bytes = Vec::new();
    bytes.extend_from_slice(&TIMEJUMP_MAGIC);
    bytes.extend_from_slice(&TIMEJUMP_FORMAT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&(encoded.len() as u32).to_le_bytes());
    bytes.extend_from_slice(&encoded);
    bytes.extend_from_slice(payload);
    bytes
}

fn minimal_manifest() -> Value {
    let (_, _, manifest) = minimal();
    serde_json::to_value(manifest).unwrap()
}

fn fail_without_directory(bytes: &[u8], expected: TimejumpPackError) {
    let temp = tempdir().unwrap();
    let destination = temp.path().join("new-import");
    assert_eq!(
        unpack_timejump_pack(bytes, &destination, PackLimits::default()).unwrap_err(),
        expected
    );
    assert!(!destination.exists());
}

#[test]
fn chinese_five_entry_roundtrip_keeps_exact_bytes_and_typed_paths() {
    let temp = tempdir().unwrap();
    let inputs = [
        source(
            temp.path(),
            PackEntryName::ResearchJson,
            br#"{"version":1}"#,
        ),
        source(
            temp.path(),
            PackEntryName::WorldSqlite,
            b"SQLite format 3\0fixture",
        ),
        source(
            temp.path(),
            PackEntryName::AnnotationsSqlite,
            b"annotations fixture",
        ),
        source(
            temp.path(),
            PackEntryName::StoryMarkdown,
            "# 长安世界\n李安的故事。\n".as_bytes(),
        ),
        source(
            temp.path(),
            PackEntryName::SourcesJson,
            "{\"标题\":\"唐代制度\"}".as_bytes(),
        ),
    ];
    let (bytes, manifest) = encode(&inputs);
    let decoded = unpack_timejump_pack(
        Cursor::new(&bytes),
        temp.path().join("中文存档·导入"),
        PackLimits::default(),
    )
    .unwrap();
    assert_eq!(decoded.manifest, manifest);
    assert_eq!(
        decoded.manifest.entries[0].name,
        PackEntryName::ResearchJson
    );
    for input in inputs {
        let path = decoded.path(input.name).unwrap();
        assert_eq!(fs::read(path).unwrap(), fs::read(input.path).unwrap());
    }
    let manifest_json = serde_json::to_value(&manifest).unwrap();
    let object = manifest_json.as_object().unwrap();
    assert_eq!(object.len(), 5);
    assert!(object.get("config").is_none());
    assert!(object.get("trace").is_none());
}

#[test]
fn required_world_and_optional_entries_are_explicit() {
    let (temp, bytes, _) = minimal();
    let result =
        unpack_timejump_pack(&bytes[..], temp.path().join("stage"), PackLimits::default()).unwrap();
    assert!(result.path(PackEntryName::WorldSqlite).is_some());
    assert!(result.path(PackEntryName::AnnotationsSqlite).is_none());
    assert!(result.path(PackEntryName::ResearchJson).is_none());
    assert!(result.path(PackEntryName::StoryMarkdown).is_none());
    assert!(result.path(PackEntryName::SourcesJson).is_none());
    for schema_version in [1, 2, 3] {
        let source = source(temp.path(), PackEntryName::WorldSqlite, b"nonempty");
        let mut metadata = metadata();
        metadata.schema_version = schema_version;
        write_timejump_pack(io::sink(), &metadata, &[source], PackLimits::default()).unwrap();
    }
}

#[test]
fn unknown_names_and_traversal_reject_before_creating_a_stage() {
    for name in [
        "../world.sqlite",
        "sub/world.sqlite",
        "sub\\world.sqlite",
        "/world.sqlite",
        "C:\\world.sqlite",
        "world.sqlite:stream",
        "WORLD.SQLITE",
        "key.json",
        "trace.sqlite",
        "world.sqlite\0",
        "./world.sqlite",
        "..",
        "annotations.sqlite/../world.sqlite",
    ] {
        let mut manifest = minimal_manifest();
        manifest["entries"][0]["name"] = json!(name);
        fail_without_directory(
            &envelope(&manifest, b""),
            TimejumpPackError::InvalidManifest,
        );
    }
}

#[test]
fn duplicate_missing_empty_and_unknown_manifest_fields_reject_before_payload() {
    let base = minimal_manifest();
    let mut cases = Vec::new();
    let mut duplicate = base.clone();
    duplicate["entries"] = json!([base["entries"][0].clone(), base["entries"][0].clone()]);
    cases.push(duplicate);
    let mut missing = base.clone();
    missing["entries"][0]["name"] = json!("story.md");
    cases.push(missing);
    let mut empty = base.clone();
    empty["entries"] = json!([]);
    cases.push(empty);
    let mut empty_world = base.clone();
    empty_world["entries"][0]["sizeBytes"] = json!(0);
    cases.push(empty_world);
    let mut unknown = base.clone();
    unknown["apiKey"] = json!("synthetic-never-config-data");
    cases.push(unknown);
    let mut nested_unknown = base;
    nested_unknown["entries"][0]["path"] = json!("somewhere");
    cases.push(nested_unknown);
    for manifest in cases {
        fail_without_directory(
            &envelope(&manifest, b""),
            TimejumpPackError::InvalidManifest,
        );
    }
}

#[test]
fn malformed_hashes_ids_timestamps_and_versions_fail_closed() {
    for hash in ["", "a", &"A".repeat(64), &"g".repeat(64), &"0".repeat(65)] {
        let mut manifest = minimal_manifest();
        manifest["entries"][0]["sha256"] = json!(hash);
        fail_without_directory(
            &envelope(&manifest, b""),
            TimejumpPackError::InvalidManifest,
        );
    }
    for id in ["short", "中文世界-2026", "world/../000", "world\n000"] {
        let mut manifest = minimal_manifest();
        manifest["worldId"] = json!(id);
        fail_without_directory(
            &envelope(&manifest, b""),
            TimejumpPackError::InvalidManifest,
        );
    }
    for timestamp in [-1_i64, 8_640_000_000_000_001] {
        let mut manifest = minimal_manifest();
        manifest["createdAtMs"] = json!(timestamp);
        fail_without_directory(
            &envelope(&manifest, b""),
            TimejumpPackError::InvalidManifest,
        );
    }
    for schema in [0, 4, u32::MAX] {
        let mut manifest = minimal_manifest();
        manifest["schemaVersion"] = json!(schema);
        fail_without_directory(
            &envelope(&manifest, b""),
            TimejumpPackError::UnsupportedVersion,
        );
    }
    let mut manifest = minimal_manifest();
    manifest["formatVersion"] = json!(2);
    fail_without_directory(
        &envelope(&manifest, b""),
        TimejumpPackError::UnsupportedVersion,
    );
    let (_, mut bytes, _) = minimal();
    bytes[8..12].copy_from_slice(&2_u32.to_le_bytes());
    fail_without_directory(&bytes, TimejumpPackError::UnsupportedVersion);
}

#[test]
fn header_utf8_json_and_duplicate_keys_are_strictly_validated() {
    let (_, mut bytes, _) = minimal();
    bytes[0] = b'X';
    fail_without_directory(&bytes, TimejumpPackError::InvalidHeader);
    for payload in [vec![], vec![0xff], b"[1,2]".to_vec(), b"{}".to_vec()] {
        let mut bytes = TIMEJUMP_MAGIC.to_vec();
        bytes.extend_from_slice(&TIMEJUMP_FORMAT_VERSION.to_le_bytes());
        bytes.extend_from_slice(&(payload.len() as u32).to_le_bytes());
        bytes.extend_from_slice(&payload);
        fail_without_directory(&bytes, TimejumpPackError::InvalidManifest);
    }
    let manifest = serde_json::to_string(&minimal_manifest()).unwrap();
    let malformed = manifest.replacen("{", "{\"worldId\":\"duplicate-world\",", 1);
    let mut bytes = TIMEJUMP_MAGIC.to_vec();
    bytes.extend_from_slice(&TIMEJUMP_FORMAT_VERSION.to_le_bytes());
    bytes.extend_from_slice(&(malformed.len() as u32).to_le_bytes());
    bytes.extend_from_slice(malformed.as_bytes());
    fail_without_directory(&bytes, TimejumpPackError::InvalidManifest);
}

#[test]
fn corrupt_truncated_and_trailing_payloads_never_return_verified_bundle() {
    let (_, bytes, _) = minimal();
    for length in [0, 7, 8, 11, 15, 16, 20, bytes.len() - 1] {
        let temp = tempdir().unwrap();
        assert_eq!(
            unpack_timejump_pack(
                &bytes[..length],
                temp.path().join("stage"),
                PackLimits::default()
            )
            .unwrap_err(),
            TimejumpPackError::Truncated
        );
    }
    let temp = tempdir().unwrap();
    let mut changed = bytes.clone();
    *changed.last_mut().unwrap() ^= 1;
    assert_eq!(
        unpack_timejump_pack(
            &changed[..],
            temp.path().join("corrupt"),
            PackLimits::default()
        )
        .unwrap_err(),
        TimejumpPackError::ChecksumMismatch
    );
    let mut trailing = bytes;
    trailing.push(0);
    assert_eq!(
        unpack_timejump_pack(
            &trailing[..],
            temp.path().join("trailing"),
            PackLimits::default()
        )
        .unwrap_err(),
        TimejumpPackError::TrailingData
    );
    assert_eq!(fs::read_dir(temp.path()).unwrap().count(), 2);
}

#[test]
fn bounds_apply_to_entire_pack_and_are_checked_before_large_allocations() {
    let (_, bytes, _) = minimal();
    let temp = tempdir().unwrap();
    let limits = PackLimits {
        max_total_bytes: bytes.len() as u64,
        ..PackLimits::default()
    };
    unpack_timejump_pack(&bytes[..], temp.path().join("exact"), limits).unwrap();
    let limits = PackLimits {
        max_total_bytes: bytes.len() as u64 - 1,
        ..PackLimits::default()
    };
    let rejected = temp.path().join("over");
    assert_eq!(
        unpack_timejump_pack(&bytes[..], &rejected, limits).unwrap_err(),
        TimejumpPackError::TooLarge
    );
    assert!(!rejected.exists());
    let mut manifest = minimal_manifest();
    manifest["entries"][0]["sizeBytes"] = json!(u64::MAX);
    fail_without_directory(&envelope(&manifest, b""), TimejumpPackError::TooLarge);
    let mut huge_header = TIMEJUMP_MAGIC.to_vec();
    huge_header.extend_from_slice(&TIMEJUMP_FORMAT_VERSION.to_le_bytes());
    huge_header.extend_from_slice(&u32::MAX.to_le_bytes());
    fail_without_directory(&huge_header, TimejumpPackError::TooLarge);
    for limits in [
        PackLimits {
            max_manifest_bytes: 0,
            ..PackLimits::default()
        },
        PackLimits {
            max_manifest_bytes: MAX_TIMEJUMP_MANIFEST_BYTES + 1,
            ..PackLimits::default()
        },
        PackLimits {
            max_entry_bytes: MAX_TIMEJUMP_ENTRY_BYTES + 1,
            ..PackLimits::default()
        },
        PackLimits {
            max_entry_bytes: 0,
            ..PackLimits::default()
        },
        PackLimits {
            max_total_bytes: MAX_TIMEJUMP_TOTAL_BYTES + 1,
            ..PackLimits::default()
        },
        PackLimits {
            max_total_bytes: 15,
            ..PackLimits::default()
        },
    ] {
        assert_eq!(
            unpack_timejump_pack(&bytes[..], temp.path().join("invalid"), limits).unwrap_err(),
            TimejumpPackError::InvalidLimits
        );
    }
}

struct MeasuredReader<R> {
    inner: R,
    largest_request: Rc<Cell<usize>>,
}
impl<R: Read> Read for MeasuredReader<R> {
    fn read(&mut self, output: &mut [u8]) -> io::Result<usize> {
        self.largest_request
            .set(self.largest_request.get().max(output.len()));
        self.inner.read(output)
    }
}
struct MeasuredWriter<W> {
    inner: W,
    largest_write: Rc<Cell<usize>>,
}
impl<W: Write> Write for MeasuredWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.largest_write
            .set(self.largest_write.get().max(bytes.len()));
        self.inner.write(bytes)
    }
    fn flush(&mut self) -> io::Result<()> {
        self.inner.flush()
    }
}

#[test]
fn payload_io_is_streamed_in_64k_chunks_not_database_sized_buffers() {
    let temp = tempdir().unwrap();
    let input = source(
        temp.path(),
        PackEntryName::WorldSqlite,
        &vec![0x42; TIMEJUMP_IO_BUFFER_BYTES * 4 + 17],
    );
    let largest_write = Rc::new(Cell::new(0));
    let mut bytes = Vec::new();
    let writer = MeasuredWriter {
        inner: &mut bytes,
        largest_write: largest_write.clone(),
    };
    write_timejump_pack(writer, &metadata(), &[input], PackLimits::default()).unwrap();
    assert_eq!(largest_write.get(), TIMEJUMP_IO_BUFFER_BYTES);
    let largest_request = Rc::new(Cell::new(0));
    let reader = MeasuredReader {
        inner: Cursor::new(&bytes),
        largest_request: largest_request.clone(),
    };
    unpack_timejump_pack(reader, temp.path().join("stage"), PackLimits::default()).unwrap();
    assert_eq!(largest_request.get(), TIMEJUMP_IO_BUFFER_BYTES);
}

struct MutatingWriter {
    source: PathBuf,
    changed: bool,
    bytes: Vec<u8>,
}
impl Write for MutatingWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        if !self.changed {
            fs::write(&self.source, b"after!")?;
            self.changed = true;
        }
        self.bytes.extend_from_slice(bytes);
        Ok(bytes.len())
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn writer_detects_same_size_source_change_between_hash_and_payload_passes() {
    let temp = tempdir().unwrap();
    let input = source(temp.path(), PackEntryName::WorldSqlite, b"before");
    let mut writer = MutatingWriter {
        source: input.path.clone(),
        changed: false,
        bytes: Vec::new(),
    };
    assert_eq!(
        write_timejump_pack(&mut writer, &metadata(), &[input], PackLimits::default()).unwrap_err(),
        TimejumpPackError::SourceChanged
    );
    assert!(!writer.bytes.is_empty());
}

#[test]
fn writer_invalid_inputs_fail_before_output_and_dont_follow_existing_paths() {
    let temp = tempdir().unwrap();
    let input = source(temp.path(), PackEntryName::WorldSqlite, b"valid-size");
    let mut output = Vec::new();
    for inputs in [
        vec![],
        vec![input.clone(), input.clone()],
        vec![source(
            temp.path(),
            PackEntryName::StoryMarkdown,
            b"only story",
        )],
        vec![source(temp.path(), PackEntryName::WorldSqlite, b"")],
    ] {
        assert_eq!(
            write_timejump_pack(&mut output, &metadata(), &inputs, PackLimits::default())
                .unwrap_err(),
            TimejumpPackError::InvalidManifest
        );
        assert!(output.is_empty());
    }
    let input = source(temp.path(), PackEntryName::WorldSqlite, b"valid-size");
    let limits = PackLimits {
        max_entry_bytes: 3,
        ..PackLimits::default()
    };
    assert_eq!(
        write_timejump_pack(&mut output, &metadata(), &[input], limits).unwrap_err(),
        TimejumpPackError::TooLarge
    );
    assert!(output.is_empty());
    let directory_source = PackSource {
        name: PackEntryName::WorldSqlite,
        path: temp.path().to_path_buf(),
    };
    assert_eq!(
        write_timejump_pack(
            &mut output,
            &metadata(),
            &[directory_source],
            PackLimits::default()
        )
        .unwrap_err(),
        TimejumpPackError::UnsafePath
    );
    assert!(output.is_empty());
}

#[test]
fn existing_destination_is_never_reused_or_overwritten() {
    let (temp, bytes, _) = minimal();
    let destination = temp.path().join("existing");
    fs::create_dir(&destination).unwrap();
    fs::write(destination.join("world.sqlite"), b"previous private save").unwrap();
    assert_eq!(
        unpack_timejump_pack(&bytes[..], &destination, PackLimits::default()).unwrap_err(),
        TimejumpPackError::DestinationExists
    );
    assert_eq!(
        fs::read(destination.join("world.sqlite")).unwrap(),
        b"previous private save"
    );
    for unsafe_path in [
        PathBuf::from("relative-stage"),
        temp.path().join("..").join("escaped-stage"),
    ] {
        assert_eq!(
            unpack_timejump_pack(&bytes[..], unsafe_path, PackLimits::default()).unwrap_err(),
            TimejumpPackError::UnsafePath
        );
    }
}

#[cfg(windows)]
fn create_directory_link(target: &Path, link: &Path) {
    // Directory junctions exercise the Windows reparse check even when the
    // process lacks the separate symbolic-link creation privilege.
    let result = std::process::Command::new("cmd.exe")
        .args(["/D", "/C", "mklink", "/J"])
        .arg(link)
        .arg(target)
        .output()
        .unwrap();
    assert!(result.status.success(), "junction creation failed");
}
#[cfg(unix)]
fn create_directory_link(target: &Path, link: &Path) {
    std::os::unix::fs::symlink(target, link).unwrap();
}

#[test]
fn linked_destination_parent_and_source_are_rejected_without_touching_target() {
    let (temp, bytes, _) = minimal();
    let target = temp.path().join("target");
    fs::create_dir(&target).unwrap();
    fs::write(target.join("world.sqlite"), b"untouched").unwrap();
    let link = temp.path().join("linked");
    create_directory_link(&target, &link);
    assert_eq!(
        unpack_timejump_pack(&bytes[..], link.join("stage"), PackLimits::default()).unwrap_err(),
        TimejumpPackError::UnsafePath
    );
    assert_eq!(
        unpack_timejump_pack(&bytes[..], &link, PackLimits::default()).unwrap_err(),
        TimejumpPackError::UnsafePath
    );
    let source = PackSource {
        name: PackEntryName::WorldSqlite,
        path: link.join("world.sqlite"),
    };
    assert_eq!(
        write_timejump_pack(io::sink(), &metadata(), &[source], PackLimits::default()).unwrap_err(),
        TimejumpPackError::UnsafePath
    );
    assert_eq!(fs::read(target.join("world.sqlite")).unwrap(), b"untouched");
    assert!(!target.join("stage").exists());
}

struct ErrorReader;
impl Read for ErrorReader {
    fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
        Err(io::Error::other("synthetic"))
    }
}
struct ErrorWriter;
impl Write for ErrorWriter {
    fn write(&mut self, _: &[u8]) -> io::Result<usize> {
        Err(io::Error::other("synthetic"))
    }
    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

#[test]
fn io_failures_have_safe_codes_and_no_successful_bundle() {
    let temp = tempdir().unwrap();
    assert_eq!(
        unpack_timejump_pack(
            ErrorReader,
            temp.path().join("stage"),
            PackLimits::default()
        )
        .unwrap_err(),
        TimejumpPackError::Io
    );
    let input = source(
        temp.path(),
        PackEntryName::WorldSqlite,
        b"some private story",
    );
    let error =
        write_timejump_pack(ErrorWriter, &metadata(), &[input], PackLimits::default()).unwrap_err();
    assert_eq!(error, TimejumpPackError::Io);
    assert_eq!(error.to_string(), "timejump_io_error");
}

#[test]
fn zero_length_optional_payload_and_boundary_timestamp_are_valid() {
    let temp = tempdir().unwrap();
    let inputs = [
        source(temp.path(), PackEntryName::WorldSqlite, b"nonempty"),
        source(temp.path(), PackEntryName::StoryMarkdown, b""),
    ];
    let mut bytes = Vec::new();
    let mut metadata = metadata();
    metadata.created_at_ms = 8_640_000_000_000_000;
    let manifest =
        write_timejump_pack(&mut bytes, &metadata, &inputs, PackLimits::default()).unwrap();
    assert_eq!(
        manifest.entries[1].sha256,
        format!("{:x}", Sha256::digest([]))
    );
    let result =
        unpack_timejump_pack(&bytes[..], temp.path().join("stage"), PackLimits::default()).unwrap();
    assert_eq!(
        fs::metadata(result.path(PackEntryName::StoryMarkdown).unwrap())
            .unwrap()
            .len(),
        0
    );
}
