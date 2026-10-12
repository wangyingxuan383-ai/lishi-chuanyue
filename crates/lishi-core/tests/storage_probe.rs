use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use lishi_core::{ProbeStore, ProbeStoreError, MAX_PROBE_NOTE_BYTES};

fn now_ms() -> i64 {
    i64::try_from(
        SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("clock is after Unix epoch")
            .as_millis(),
    )
    .expect("test timestamp fits i64")
}

#[test]
fn reopen_preserves_chinese_emoji_newlines_and_embedded_nul() {
    let directory = tempfile::tempdir().expect("create isolated temporary directory");
    let path = directory.path().join("unicode-probe.sqlite3");
    let text = "  唐朝开局：长安🙂\n第二行\r\n第三行\0结尾  ";

    let saved = {
        let store = ProbeStore::open(&path).expect("open probe database");
        assert_eq!(store.read_note().expect("read empty database"), None);
        let note = store.save_note(text).expect("save Unicode note");
        assert_eq!(note.text.as_bytes(), text.as_bytes());
        assert_eq!(note.revision, 1);
        note
    };

    let reopened = ProbeStore::open(&path).expect("reopen probe database");
    assert_eq!(
        reopened.read_note().expect("read durable note"),
        Some(saved.clone())
    );
    let updated = reopened
        .save_note("下一次更新")
        .expect("update reopened note");
    assert_eq!(updated.revision, saved.revision + 1);
}

#[test]
fn empty_and_repeated_updates_have_consecutive_revisions_and_valid_timestamps() {
    let directory = tempfile::tempdir().expect("create isolated temporary directory");
    let store = ProbeStore::open(directory.path().join("revision-probe.sqlite3"))
        .expect("open probe database");

    for (index, text) in ["", "重复笔记", "重复笔记", "新笔记"]
        .into_iter()
        .enumerate()
    {
        let before = now_ms();
        let note = store.save_note(text).expect("save note");
        let after = now_ms();

        assert_eq!(note.text, text);
        assert_eq!(
            note.revision,
            i64::try_from(index + 1).expect("revision fits i64")
        );
        assert!((before..=after).contains(&note.saved_at_ms));
        assert_eq!(store.read_note().expect("read current note"), Some(note));
    }
}

#[test]
fn byte_limit_accepts_exact_boundary_and_rejects_without_changing_note() {
    let directory = tempfile::tempdir().expect("create isolated temporary directory");
    let store = ProbeStore::open(directory.path().join("limit-probe.sqlite3"))
        .expect("open probe database");
    let boundary = "x".repeat(MAX_PROBE_NOTE_BYTES);
    let saved = store.save_note(&boundary).expect("save exact byte limit");
    assert_eq!(saved.text.as_bytes(), boundary.as_bytes());

    let over_limit = format!("{boundary}x");
    let error = store
        .save_note(&over_limit)
        .expect_err("reject one extra byte");
    assert!(matches!(
        error,
        ProbeStoreError::TextTooLarge {
            actual_bytes,
            max_bytes
        } if actual_bytes == MAX_PROBE_NOTE_BYTES + 1 && max_bytes == MAX_PROBE_NOTE_BYTES
    ));
    assert_eq!(
        store.read_note().expect("read after rejection"),
        Some(saved)
    );

    let multibyte = "中".repeat(MAX_PROBE_NOTE_BYTES / 3);
    let accepted = store
        .save_note(&multibyte)
        .expect("save multibyte note below limit");
    let oversized_multibyte = format!("{multibyte}🙂");
    let error = store
        .save_note(&oversized_multibyte)
        .expect_err("limit counts bytes rather than characters");
    assert!(matches!(
        error,
        ProbeStoreError::TextTooLarge {
            actual_bytes,
            max_bytes
        } if actual_bytes == oversized_multibyte.len() && max_bytes == MAX_PROBE_NOTE_BYTES
    ));
    assert_eq!(
        store.read_note().expect("read after Unicode rejection"),
        Some(accepted)
    );
}

#[test]
fn shared_store_serializes_writes_from_multiple_threads() {
    fn assert_send_and_sync<T: Send + Sync>() {}
    assert_send_and_sync::<ProbeStore>();

    let directory = tempfile::tempdir().expect("create isolated temporary directory");
    let store = Arc::new(
        ProbeStore::open(directory.path().join("thread-probe.sqlite3"))
            .expect("open probe database"),
    );
    let handles: Vec<_> = (0..8)
        .map(|index| {
            let store = Arc::clone(&store);
            std::thread::spawn(move || {
                store
                    .save_note(&format!("并发笔记 {index}"))
                    .expect("save from worker thread")
                    .revision
            })
        })
        .collect();
    let mut revisions: Vec<_> = handles
        .into_iter()
        .map(|handle| handle.join().expect("join worker thread"))
        .collect();
    revisions.sort_unstable();

    assert_eq!(revisions, (1..=8).collect::<Vec<i64>>());
    assert_eq!(
        store
            .read_note()
            .expect("read final note")
            .expect("note exists")
            .revision,
        8
    );
}
