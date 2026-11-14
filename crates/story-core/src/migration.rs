//! One versioned SQL source for the browser and every native database owner.
use crate::{Error, Result};
use chrono::Utc;
use rusqlite::{Connection, OpenFlags, OptionalExtension, TransactionBehavior};
use std::{fs, path::Path};

pub const LATEST_VERSION: i64 = 13;
pub const MIGRATIONS: &[(i64, &str)] = &[
    (1, include_str!("migrations/001.sql")),
    (2, include_str!("migrations/002.sql")),
    (3, include_str!("migrations/003.sql")),
    (4, include_str!("migrations/004.sql")),
    (5, include_str!("schema.sql")),
    (6, include_str!("migrations/006.sql")),
    (7, include_str!("agent_schema.sql")),
    (8, include_str!("pi_schema.sql")),
    (9, include_str!("migrations/009.sql")),
    (10, include_str!("migrations/010.sql")),
    (11, include_str!("migrations/011.sql")),
    (12, include_str!("migrations/012.sql")),
    (13, include_str!("migrations/013.sql")),
];

pub fn version(connection: &Connection) -> Result<i64> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='schema_version'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !exists {
        return Ok(0);
    }
    Ok(connection.query_row(
        "SELECT COALESCE(MAX(version),0) FROM schema_version",
        [],
        |r| r.get(0),
    )?)
}

/// The immediate transaction serializes native service/page startup. Its
/// separate read connection snapshots the last committed WAL state before
/// any schema write, without asking SQLite to back up an active writer.
pub fn migrate(connection: &mut Connection, backup_directory: Option<&Path>) -> Result<i64> {
    let source = connection.path().map(str::to_owned);
    let tx = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = version(&tx)?;
    if current > LATEST_VERSION {
        return Err(Error::Invalid("存档来自更新版本，请先更新应用".into()));
    }
    if current == LATEST_VERSION {
        return Ok(current);
    }
    if current > 0 {
        if let Some(directory) = backup_directory {
            let path = source
                .as_deref()
                .filter(|p| !p.is_empty() && *p != ":memory:")
                .ok_or_else(|| Error::Invalid("无法为升级建立一致性备份".into()))?;
            fs::create_dir_all(directory)
                .map_err(|_| Error::Invalid("无法建立升级备份目录".into()))?;
            let destination = directory.join(format!(
                "{}-before-v{}.sqlite",
                Utc::now().format("%Y%m%dT%H%M%S%.9fZ"),
                current + 1
            ));
            let reader = Connection::open_with_flags(path, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            reader.backup(rusqlite::MAIN_DB, &destination, None)?;
            let backup =
                Connection::open_with_flags(&destination, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
            let check: String = backup.query_row("PRAGMA quick_check", [], |r| r.get(0))?;
            if check != "ok" || version(&backup)? != current {
                return Err(Error::Invalid("升级备份校验未通过，尚未修改存档".into()));
            }
        }
    }
    tx.execute_batch("CREATE TABLE IF NOT EXISTS schema_version(version INTEGER NOT NULL)")?;
    for (target, sql) in MIGRATIONS.iter().filter(|(v, _)| *v > current) {
        if *target == 8 {
            tx.execute_batch(include_str!("execution_lease_schema.sql"))?;
        }
        tx.execute_batch(sql)?;
        tx.execute("INSERT INTO schema_version(version) VALUES(?)", [target])?;
    }
    tx.commit()?;
    Ok(LATEST_VERSION)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql::SqlStore;

    fn legacy_file(directory: &Path) -> Connection {
        let db = Connection::open(directory.join("game.sqlite")).unwrap();
        db.execute_batch(
            "PRAGMA journal_mode=WAL; CREATE TABLE schema_version(version INTEGER NOT NULL)",
        )
        .unwrap();
        for (v, sql) in MIGRATIONS.iter().filter(|(v, _)| *v <= 7) {
            db.execute_batch(sql).unwrap();
            db.execute("INSERT INTO schema_version VALUES(?)", [v])
                .unwrap();
        }
        db.execute("INSERT INTO worlds(id,title,era_id,settings_json,created_at,updated_at,played_at) VALUES('old-world','原故事','free','{\"keep\":true}','test','test','test')",[]).unwrap();
        db.execute("INSERT INTO agent_sessions VALUES('old-session','old-world','old-line','旧会话','test','test')",[]).unwrap();
        db.execute("INSERT INTO agent_tasks(id,session_id,run_id,text,policy,status,base_json,created_at,updated_at) VALUES('old-task','old-session','old-run','不要重跑','preview','running','{}','test','test')",[]).unwrap();
        db
    }

    #[test]
    fn native_upgrade_preserves_legacy_and_backups_committed_wal_state() {
        let directory = tempfile::tempdir().unwrap();
        let old = legacy_file(directory.path());
        // Keep an independent connection alive: migration must snapshot WAL,
        // not copy the main file while committed pages are still in its log.
        let store = SqlStore::open(directory.path().into()).unwrap();
        assert_eq!(version(&store.shared().lock().unwrap()).unwrap(), LATEST_VERSION);
        assert_eq!(
            store
                .query("SELECT status FROM agent_tasks WHERE id='old-task'", vec![])
                .unwrap()[0]["status"],
            "running"
        );
        assert_eq!(
            store
                .query("SELECT COUNT(*) AS n FROM pi_tasks", vec![])
                .unwrap()[0]["n"],
            0
        );
        assert_eq!(
            store
                .query("SELECT settings_json FROM worlds", vec![])
                .unwrap()[0]["settings_json"],
            "{\"keep\":true}"
        );
        let backups = store.list_backups().unwrap();
        assert_eq!(backups.len(), 1);
        assert!(backups[0].name.ends_with("before-v8.sqlite"));
        let backup =
            Connection::open(directory.path().join("backups").join(&backups[0].name)).unwrap();
        assert_eq!(version(&backup).unwrap(), 7);
        assert_eq!(
            backup
                .query_row(
                    "SELECT status FROM agent_tasks WHERE id='old-task'",
                    [],
                    |r| r.get::<_, String>(0)
                )
                .unwrap(),
            "running"
        );
        drop(backup);
        drop(store);
        drop(old);
    }

    #[test]
    fn failed_upgrade_keeps_version_and_formal_rows() {
        let directory = tempfile::tempdir().unwrap();
        let old = legacy_file(directory.path());
        old.execute_batch("CREATE TABLE pi_sessions(id TEXT)")
            .unwrap();
        assert!(SqlStore::open(directory.path().into()).is_err());
        assert_eq!(version(&old).unwrap(), 7);
        assert_eq!(
            old.query_row("SELECT title FROM worlds", [], |r| r.get::<_, String>(0))
                .unwrap(),
            "原故事"
        );
        assert!(!old
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE name='pi_tasks')",
                [],
                |r| r.get::<_, bool>(0)
            )
            .unwrap());
    }

    #[test]
    fn v12_adds_nullable_error_kind_preserves_old_errors_and_can_reopen() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE schema_version(version INTEGER NOT NULL)").unwrap();
        for (v, sql) in MIGRATIONS.iter().filter(|(v, _)| *v <= 11) {
            if *v == 8 { db.execute_batch(include_str!("execution_lease_schema.sql")).unwrap(); }
            db.execute_batch(sql).unwrap();
            db.execute("INSERT INTO schema_version VALUES(?)", [v]).unwrap();
        }
        db.execute("INSERT INTO execution_runs(id,world_id,line_id,base_head_id,status,plan_json,budget_json,draft_json,error,created_at,updated_at) VALUES('old','w','l','n','failed','{}','{}','{}','旧错误','test','test')", []).unwrap();
        assert_eq!(migrate(&mut db, None).unwrap(), LATEST_VERSION);
        let saved: (String, Option<String>) = db.query_row("SELECT error,error_kind FROM execution_runs WHERE id='old'", [], |r| Ok((r.get(0)?, r.get(1)?))).unwrap();
        assert_eq!(saved, ("旧错误".into(), None));
        assert_eq!(migrate(&mut db, None).unwrap(), LATEST_VERSION);
        assert_eq!(db.query_row("SELECT COUNT(*) FROM schema_version WHERE version=12", [], |r| r.get::<_, i64>(0)).unwrap(), 1);
    }

    #[test]
    fn v13_adds_canon_notes_that_go_with_their_book() {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        assert_eq!(migrate(&mut db, None).unwrap(), 13);
        db.execute_batch("INSERT INTO source_books VALUES('b','书','txt','t','{}'); INSERT INTO canon_notes(id,book_id,kind,title,created_at,updated_at) VALUES('n','b','plot','主线','t','t');").unwrap();
        assert_eq!(db.query_row("SELECT status||active FROM canon_notes", [], |r| r.get::<_, String>(0)).unwrap(), "paused1");
        db.execute("DELETE FROM source_books WHERE id='b'", []).unwrap();
        assert_eq!(db.query_row("SELECT COUNT(*) FROM canon_notes", [], |r| r.get::<_, i64>(0)).unwrap(), 0);
    }
}
