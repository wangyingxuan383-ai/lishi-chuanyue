use std::io::{self, Cursor, Read, Write};

use lishi_core::probe_pack::{
    copy_probe_pack, decode_probe_pack, encode_probe_pack, ProbePackError, MAX_PROBE_PACK_BYTES,
    MAX_PROBE_PACK_NOTE_BYTES,
};

#[test]
fn chinese_emoji_newlines_controls_and_empty_note_round_trip() {
    for note in [
        "长安的钥匙🔑仍在。\n第二行\r\n🙂\0",
        "",
        "历史穿越-技术探针",
    ] {
        let encoded = encode_probe_pack(note).unwrap();
        assert_eq!(decode_probe_pack(&encoded).unwrap().note, note);
    }
}

#[test]
fn byte_limits_include_json_escape_expansion() {
    for note in [
        "a".repeat(MAX_PROBE_PACK_NOTE_BYTES),
        "\0".repeat(MAX_PROBE_PACK_NOTE_BYTES),
    ] {
        let encoded = encode_probe_pack(&note).unwrap();
        assert!(encoded.len() <= MAX_PROBE_PACK_BYTES);
        assert_eq!(decode_probe_pack(&encoded).unwrap().note, note);
    }
    let chinese = "史".repeat(MAX_PROBE_PACK_NOTE_BYTES / 3 + 1);
    assert_eq!(encode_probe_pack(&chinese), Err(ProbePackError::TooLarge));
    assert_eq!(
        decode_probe_pack(&vec![b' '; MAX_PROBE_PACK_BYTES + 1]),
        Err(ProbePackError::TooLarge)
    );
}

#[test]
fn truncated_invalid_utf8_unknown_duplicate_and_trailing_fields_are_rejected() {
    let encoded = encode_probe_pack("安全文本").unwrap();
    assert_eq!(
        decode_probe_pack(&encoded[..encoded.len() - 1]),
        Err(ProbePackError::Invalid)
    );
    assert_eq!(decode_probe_pack(&[0xff]), Err(ProbePackError::Invalid));
    let mut json: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
    json["secret"] = serde_json::json!("forbidden");
    assert_eq!(
        decode_probe_pack(&serde_json::to_vec(&json).unwrap()),
        Err(ProbePackError::Invalid)
    );
    let text = String::from_utf8(encoded.clone()).unwrap();
    let duplicate = text.replacen("{", "{\"note\":\"other\",", 1);
    assert_eq!(
        decode_probe_pack(duplicate.as_bytes()),
        Err(ProbePackError::Invalid)
    );
    let mut trailing = encoded;
    trailing.extend_from_slice(b"{}");
    assert_eq!(decode_probe_pack(&trailing), Err(ProbePackError::Invalid));
}

#[test]
fn format_version_algorithm_and_checksum_are_enforced() {
    let encoded = encode_probe_pack("原始内容").unwrap();
    let base: serde_json::Value = serde_json::from_slice(&encoded).unwrap();
    let mut changed = base.clone();
    changed["format"] = serde_json::json!("timejump");
    assert_eq!(
        decode_probe_pack(&serde_json::to_vec(&changed).unwrap()),
        Err(ProbePackError::Invalid)
    );
    changed = base.clone();
    changed["version"] = serde_json::json!(2);
    assert_eq!(
        decode_probe_pack(&serde_json::to_vec(&changed).unwrap()),
        Err(ProbePackError::UnsupportedVersion)
    );
    changed = base.clone();
    changed["note"] = serde_json::json!("内容被修改");
    assert_eq!(
        decode_probe_pack(&serde_json::to_vec(&changed).unwrap()),
        Err(ProbePackError::ChecksumMismatch)
    );
    changed = base.clone();
    changed["checksum"]["algorithm"] = serde_json::json!("none");
    assert_eq!(
        decode_probe_pack(&serde_json::to_vec(&changed).unwrap()),
        Err(ProbePackError::Invalid)
    );
    changed = base;
    changed["checksum"]["value"] = serde_json::json!("0".repeat(64));
    assert_eq!(
        decode_probe_pack(&serde_json::to_vec(&changed).unwrap()),
        Err(ProbePackError::ChecksumMismatch)
    );
}

#[test]
fn bounded_copy_rejects_infinite_input_and_writes_no_more_than_limit() {
    let mut stage = Vec::new();
    assert_eq!(
        copy_probe_pack(io::repeat(1), &mut stage),
        Err(ProbePackError::TooLarge)
    );
    assert_eq!(stage.len(), MAX_PROBE_PACK_BYTES);
    let exact = vec![b' '; MAX_PROBE_PACK_BYTES];
    stage.clear();
    assert_eq!(
        copy_probe_pack(Cursor::new(&exact), &mut stage).unwrap(),
        exact.len()
    );
    assert_eq!(stage, exact);
}

#[test]
fn source_revocation_or_destination_failure_returns_safe_io_error() {
    struct Revoked;
    impl Read for Revoked {
        fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
            Err(io::Error::new(
                io::ErrorKind::PermissionDenied,
                "private URI must not escape",
            ))
        }
    }
    struct FailedDestination;
    impl Write for FailedDestination {
        fn write(&mut self, _: &[u8]) -> io::Result<usize> {
            Err(io::Error::other("private destination must not escape"))
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    assert_eq!(
        copy_probe_pack(Revoked, Vec::new()),
        Err(ProbePackError::Io)
    );
    assert_eq!(
        copy_probe_pack(Cursor::new(b"hello"), FailedDestination),
        Err(ProbePackError::Io)
    );
    assert_eq!(ProbePackError::Io.to_string(), "file_io_error");
}
