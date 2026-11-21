use super::*;
use serde_json::json;

fn statement(sql: &str, params: Vec<Value>) -> Statement {
    Statement {
        sql: sql.into(),
        params,
    }
}

#[test]
fn batch_failure_rolls_back_all_statements_including_migrations() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqlStore::open(directory.path().into()).unwrap();
    store
        .query("CREATE TABLE t(id INTEGER PRIMARY KEY, name TEXT)", vec![])
        .unwrap();
    let error = store
        .batch(vec![
            statement(
                "CREATE TABLE extra(x); INSERT INTO t VALUES (1, 'first');",
                vec![],
            ),
            statement(
                "INSERT INTO t VALUES (?, ?)",
                vec![json!(1), json!("fake-parameter")],
            ),
        ])
        .unwrap_err();
    assert_eq!(error.code, "sql_failed");
    assert!(!error.message.contains("fake-parameter"));
    assert!(store.query("SELECT * FROM t", vec![]).unwrap().is_empty());
    assert!(store.query("SELECT * FROM extra", vec![]).is_err());
    store
        .batch(vec![statement(
            "INSERT INTO t VALUES (?, ?)",
            vec![json!(2), json!("中文")],
        )])
        .unwrap();
    assert_eq!(
        store.query("SELECT * FROM t", vec![]).unwrap()[0]["name"],
        "中文"
    );
}

#[test]
fn integers_and_blobs_and_parameter_types_obey_contract() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqlStore::open(directory.path().into()).unwrap();
    for value in [MAX_INTEGER, -MAX_INTEGER] {
        assert_eq!(
            store.query("SELECT ? AS v", vec![json!(value)]).unwrap()[0]["v"],
            value
        );
    }
    for value in [
        json!(MAX_INTEGER + 1),
        json!(-MAX_INTEGER - 1),
        json!(u64::MAX),
    ] {
        assert_eq!(
            store.query("SELECT ?", vec![value]).unwrap_err().code,
            "sql_integer_range"
        );
    }
    for sql in ["SELECT 9007199254740992", "SELECT -9007199254740992"] {
        assert_eq!(
            store.query(sql, vec![]).unwrap_err().code,
            "sql_integer_range"
        );
    }
    assert_eq!(
        store.query("SELECT X'0102'", vec![]).unwrap_err().code,
        "sql_blob_unsupported"
    );
    for value in [json!({}), json!([])] {
        assert_eq!(
            store.query("SELECT ?", vec![value]).unwrap_err().code,
            "sql_param_type"
        );
    }
    let values = store
        .query(
            "SELECT ? AS a, ? AS b, ? AS c, ? AS d, ? AS e",
            vec![
                json!(true),
                json!(false),
                Value::Null,
                json!(1.25),
                json!("中文"),
            ],
        )
        .unwrap();
    assert_eq!(
        values[0],
        serde_json::from_value::<Map<String, Value>>(
            json!({"a":1,"b":0,"c":null,"d":1.25,"e":"中文"})
        )
        .unwrap()
    );
    assert!(store.query("SELECT 1; SELECT 2", vec![]).is_err());
}

#[test]
fn backups_use_compressed_online_snapshot_keep_five_and_support_deletion() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqlStore::open(directory.path().into()).unwrap();
    store.query("CREATE TABLE t(x)", vec![]).unwrap();
    store.query("INSERT INTO t VALUES (42)", vec![]).unwrap();
    assert!(store.backup("../bad").is_err());
    for _ in 0..7 {
        store.backup("test").unwrap();
    }
    let backups = store.list_backups().unwrap();
    assert_eq!(backups.len(), 5);
    assert!(backups.windows(2).all(|p| p[0].name > p[1].name));
    let backup = &backups[0];
    assert!(chrono::DateTime::parse_from_rfc3339(&backup.at).is_ok());
    assert!(backup.name.ends_with(".sqlite.zip"));
    assert!(backup.size > 0);
    let stage = tempfile::tempdir().unwrap();
    let file = db_backup::materialize(&directory.path().join("backups"), &backup.name, stage.path()).unwrap();
    assert!(backup.size < fs::metadata(&file).unwrap().len());
    let connection = Connection::open(file).unwrap();
    assert_eq!(
        connection
            .query_row("SELECT x FROM t", [], |r| r.get::<_, i64>(0))
            .unwrap(),
        42
    );
    let receipt = store.delete_backups(&[backup.name.clone(), "../game.sqlite".into()]).unwrap();
    assert_eq!(receipt.inventory.items.len(), 4);
    assert_eq!(receipt.failed, 1);
    assert_eq!(receipt.inventory.total_bytes, backups.iter().skip(1).map(|item| item.size).sum::<u64>());
    let remaining = receipt.inventory.items.into_iter().map(|item| item.name).collect::<Vec<_>>();
    let receipt = store.delete_backups(&remaining).unwrap();
    assert_eq!(receipt.failed, 0);
    assert!(receipt.inventory.items.is_empty());
    assert_eq!(receipt.inventory.total_bytes, 0);
    assert!(directory.path().join("game.sqlite").is_file());
}

#[test]
fn startup_removes_only_legacy_backups_even_without_schema_migration() {
    let directory = tempfile::tempdir().unwrap();
    let store = app_store(directory.path());
    store.query("INSERT INTO t VALUES (7)", vec![]).unwrap();
    let files = directory.path().join("backups");
    let current = store.backup("manual").unwrap();
    let obsolete = files.join("20261120T010203.999999999Z-manual.sqlite");
    fs::write(&obsolete, b"old database backup").unwrap();
    let pi = obsolete.with_extension("pi");
    fs::create_dir(&pi).unwrap();
    fs::write(pi.join("manifest.json"), "old sidecar").unwrap();
    let orphan = files.join("20261120T020203.999999999Z-auto.pi");
    fs::create_dir(&orphan).unwrap();
    let unknown = files.join("export.sqlite");
    fs::write(&unknown, b"unmanaged").unwrap();
    drop(store);
    for _ in 0..2 {
        let reopened = SqlStore::open(directory.path().into()).unwrap();
        assert_eq!(values(&reopened), vec![json!(7)]);
        assert_eq!(reopened.list_backups().unwrap()[0].name, current);
        assert!(!obsolete.exists() && !pi.exists() && !orphan.exists());
        assert!(unknown.is_file());
    }
}

#[test]
fn batch_cannot_commit_early_and_bad_parameters_also_roll_back() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqlStore::open(directory.path().into()).unwrap();
    store.query("CREATE TABLE t(x)", vec![]).unwrap();
    assert_eq!(
        store
            .batch(vec![statement("INSERT INTO t VALUES (1); COMMIT;", vec![])])
            .unwrap_err()
            .code,
        "sql_failed"
    );
    assert!(store.query("SELECT * FROM t", vec![]).unwrap().is_empty());
    assert_eq!(
        store
            .batch(vec![
                statement("INSERT INTO t VALUES (1)", vec![]),
                statement("INSERT INTO t VALUES (?)", vec![json!({})])
            ])
            .unwrap_err()
            .code,
        "sql_failed"
    );
    assert!(store.query("SELECT * FROM t", vec![]).unwrap().is_empty());
    // The temporary transaction hook is removed on failure.
    store.query("BEGIN", vec![]).unwrap();
    store.query("ROLLBACK", vec![]).unwrap();
}

#[test]
fn writes_return_empty_rows_even_with_returning() {
    let directory = tempfile::tempdir().unwrap();
    let store = SqlStore::open(directory.path().into()).unwrap();
    assert!(store.query("CREATE TABLE t(x)", vec![]).unwrap().is_empty());
    assert!(store
        .query("INSERT INTO t VALUES (1) RETURNING x", vec![])
        .unwrap()
        .is_empty());
    assert_eq!(store.query("SELECT x FROM t", vec![]).unwrap()[0]["x"], 1);
}

fn app_store(directory: &std::path::Path) -> SqlStore {
    let store = SqlStore::open(directory.into()).unwrap();
    store
        .batch(vec![statement(
            "CREATE TABLE t(x);",
            vec![],
        )])
        .unwrap();
    store
}

fn values(store: &SqlStore) -> Vec<Value> {
    store
        .query("SELECT x FROM t ORDER BY x", vec![])
        .unwrap()
        .into_iter()
        .map(|row| row["x"].clone())
        .collect()
}

#[test]
fn restore_replaces_live_data_and_saves_it_first() {
    let directory = tempfile::tempdir().unwrap();
    let store = app_store(directory.path());
    store.query("INSERT INTO t VALUES (1)", vec![]).unwrap();
    let good = store.backup("auto").unwrap();
    store.query("INSERT INTO t VALUES (2)", vec![]).unwrap();
    store.query("CREATE TABLE later(y)", vec![]).unwrap();

    let saved = store.restore(&good).unwrap();
    assert!(saved.ends_with("-before-restore.sqlite.zip"));
    assert_eq!(values(&store), vec![json!(1)]);
    assert!(store.query("SELECT * FROM later", vec![]).is_err());
    // The reopened connection is usable and writable.
    store.query("INSERT INTO t VALUES (3)", vec![]).unwrap();
    assert_eq!(values(&store), vec![json!(1), json!(3)]);
    // The before-restore backup holds what was replaced, so a restore can be undone.
    store.restore(&saved).unwrap();
    assert_eq!(values(&store), vec![json!(1), json!(2)]);
    let before_restore = store
        .list_backups()
        .unwrap()
        .into_iter()
        .filter(|b| b.name.ends_with("-before-restore.sqlite.zip"))
        .count();
    assert_eq!(before_restore, 2);
    // A store opened afresh sees the restored data on disk.
    drop(store);
    let reopened = SqlStore::open(directory.path().into()).unwrap();
    assert_eq!(values(&reopened), vec![json!(1), json!(2)]);
}

#[test]
fn restore_rejects_foreign_corrupt_newer_and_unsafe_names() {
    let directory = tempfile::tempdir().unwrap();
    let store = app_store(directory.path());
    store.query("INSERT INTO t VALUES (7)", vec![]).unwrap();
    let backups = directory.path().join("backups");
    fs::create_dir_all(&backups).unwrap();

    // A SQLite file without schema_version is not one of ours.
    let foreign = Connection::open(backups.join("20990101T000000Z-foreign.sqlite")).unwrap();
    foreign.execute_batch("CREATE TABLE other(x);").unwrap();
    drop(foreign);
    // Not a database at all.
    fs::write(
        backups.join("20990101T000001Z-garbage.sqlite"),
        b"not a database, just text that is long enough to have a header",
    )
    .unwrap();
    // An app database from a newer version.
    let newer = Connection::open(backups.join("20990101T000002Z-newer.sqlite")).unwrap();
    newer
        .execute_batch(
            "CREATE TABLE schema_version (version INTEGER NOT NULL);
             INSERT INTO schema_version VALUES (99);",
        )
        .unwrap();
    drop(newer);

    for (name, code) in [
        ("20990101T000000Z-foreign.sqlite", "sql_restore_invalid"),
        ("20990101T000001Z-garbage.sqlite", "sql_restore_invalid"),
        ("20990101T000002Z-newer.sqlite", "sql_restore_newer"),
        ("missing-file.sqlite", "sql_restore_missing"),
        ("../game.sqlite", "sql_restore_missing"),
        ("..\\game.sqlite", "sql_restore_missing"),
        ("backups/x.sqlite", "sql_restore_missing"),
        ("x.txt", "sql_restore_missing"),
    ] {
        assert_eq!(store.restore(name).unwrap_err().code, code, "{name}");
    }
    // Nothing changed, and no before-restore backup was made for a rejected file.
    assert_eq!(values(&store), vec![json!(7)]);
    assert!(!store
        .list_backups()
        .unwrap()
        .iter()
        .any(|b| b.name.contains("before-restore")));
}

#[test]
fn restore_fence_rejects_old_queued_save_and_preserves_matching_pi_context() {
    let directory=tempfile::tempdir().unwrap();let store=app_store(directory.path());
    let session_dir=directory.path().join("agent-sessions").join("s");fs::create_dir_all(&session_dir).unwrap();
    let session_file=session_dir.join("test.jsonl");fs::write(&session_file,"old transcript\n").unwrap();
    store.query("INSERT INTO worlds(id,title,era_id,settings_json,created_at,updated_at,played_at) VALUES('w','独立','free','{}','','','')",vec![]).unwrap();
    store.query("INSERT INTO pi_sessions(id,world_id,line_id,title,session_file,created_at,updated_at) VALUES('s','w','l','测试',?,'','')",vec![json!(session_file.to_str().unwrap())]).unwrap();
    let backup=store.backup("context").unwrap();
    fs::write(&session_file,"new transcript must survive\n").unwrap();
    let issued=store.generation();let ticket=crate::maintenance::begin(&store.shared()).unwrap();
    assert!(store.query("INSERT INTO t VALUES(9)",vec![]).is_err());
    store.restore_managed(&backup,&ticket).unwrap();crate::maintenance::end(&store.shared(),&ticket).unwrap();
    assert!(store.batch_at(issued,vec![statement("INSERT INTO t VALUES(7)",vec![])]).is_err());
    let file=store.query("SELECT session_file FROM pi_sessions WHERE id='s'",vec![]).unwrap()[0]["session_file"].as_str().unwrap().to_owned();
    assert_ne!(file,session_file.to_str().unwrap());assert_eq!(fs::read_to_string(file).unwrap(),"old transcript\n");
    assert_eq!(fs::read_to_string(&session_file).unwrap(),"new transcript must survive\n");
    assert!(values(&store).is_empty());
    // Corrupt matching sidecar must fail before touching the live database.
    fs::write(directory.path().join("backups").join(&backup), b"not an intact archive").unwrap();
    store.query("INSERT INTO t VALUES(5)",vec![]).unwrap();
    assert!(store.restore(&backup).is_err());assert_eq!(values(&store),vec![json!(5)]);
}
