//! A single-note SQLite probe for verifying platform-private persistence.
//!
//! This table is not the world, turn, or conversation schema. The host selects
//! the database path and creates its parent directory before opening the store.

use std::error::Error;
use std::fmt;
use std::path::Path;
use std::sync::{Mutex, MutexGuard};
use std::time::{Duration, SystemTime, SystemTimeError, UNIX_EPOCH};

use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde::Serialize;

pub const MAX_PROBE_NOTE_BYTES: usize = 64 * 1024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ProbeNote {
    pub text: String,
    pub saved_at_ms: i64,
    pub revision: i64,
}

#[derive(Debug)]
pub enum ProbeStoreError {
    Sqlite(rusqlite::Error),
    MutexPoisoned,
    TextTooLarge {
        actual_bytes: usize,
        max_bytes: usize,
    },
    ClockBeforeUnixEpoch(SystemTimeError),
    TimestampOutOfRange,
    RevisionOverflow,
}

impl fmt::Display for ProbeStoreError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Sqlite(error) => write!(formatter, "SQLite probe error: {error}"),
            Self::MutexPoisoned => write!(formatter, "SQLite probe lock is poisoned"),
            Self::TextTooLarge {
                actual_bytes,
                max_bytes,
            } => write!(
                formatter,
                "Probe note is {actual_bytes} UTF-8 bytes; the limit is {max_bytes} bytes"
            ),
            Self::ClockBeforeUnixEpoch(_) => {
                write!(formatter, "System clock is before the Unix epoch")
            }
            Self::TimestampOutOfRange => {
                write!(
                    formatter,
                    "Probe note timestamp exceeds the supported range"
                )
            }
            Self::RevisionOverflow => {
                write!(formatter, "Probe note revision exceeds the supported range")
            }
        }
    }
}

impl Error for ProbeStoreError {
    fn source(&self) -> Option<&(dyn Error + 'static)> {
        match self {
            Self::Sqlite(error) => Some(error),
            Self::ClockBeforeUnixEpoch(error) => Some(error),
            _ => None,
        }
    }
}

impl From<rusqlite::Error> for ProbeStoreError {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sqlite(error)
    }
}

/// Thread-safe access to one current note; no database handle is exposed.
pub struct ProbeStore {
    connection: Mutex<Connection>,
}

impl ProbeStore {
    /// Opens a probe database. The caller owns the path and parent directory.
    pub fn open(path: impl AsRef<Path>) -> Result<Self, ProbeStoreError> {
        let connection = Connection::open(path)?;
        connection.busy_timeout(Duration::from_secs(5))?;
        connection.pragma_update(None, "journal_mode", "WAL")?;
        connection.pragma_update(None, "synchronous", "FULL")?;
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS probe_note (
                id INTEGER PRIMARY KEY CHECK (id = 1),
                text TEXT NOT NULL CHECK (length(CAST(text AS BLOB)) <= 65536),
                saved_at_ms INTEGER NOT NULL CHECK (saved_at_ms >= 0),
                revision INTEGER NOT NULL CHECK (revision > 0)
            ) STRICT;",
        )?;

        Ok(Self {
            connection: Mutex::new(connection),
        })
    }

    /// Atomically replaces the current note and advances its revision.
    ///
    /// The limit applies to UTF-8 bytes. Text is never truncated or normalized.
    /// A returned note has been committed; an error leaves the prior note intact.
    pub fn save_note(&self, text: &str) -> Result<ProbeNote, ProbeStoreError> {
        if text.len() > MAX_PROBE_NOTE_BYTES {
            return Err(ProbeStoreError::TextTooLarge {
                actual_bytes: text.len(),
                max_bytes: MAX_PROBE_NOTE_BYTES,
            });
        }

        let mut connection = self.lock_connection()?;
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let previous_revision: Option<i64> = transaction
            .query_row("SELECT revision FROM probe_note WHERE id = 1", [], |row| {
                row.get(0)
            })
            .optional()?;
        let revision = previous_revision
            .unwrap_or(0)
            .checked_add(1)
            .ok_or(ProbeStoreError::RevisionOverflow)?;
        let elapsed = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(ProbeStoreError::ClockBeforeUnixEpoch)?;
        let saved_at_ms =
            i64::try_from(elapsed.as_millis()).map_err(|_| ProbeStoreError::TimestampOutOfRange)?;

        transaction.execute(
            "INSERT INTO probe_note (id, text, saved_at_ms, revision)
             VALUES (1, ?1, ?2, ?3)
             ON CONFLICT(id) DO UPDATE SET
                 text = excluded.text,
                 saved_at_ms = excluded.saved_at_ms,
                 revision = excluded.revision",
            params![text, saved_at_ms, revision],
        )?;
        transaction.commit()?;

        Ok(ProbeNote {
            text: text.to_owned(),
            saved_at_ms,
            revision,
        })
    }

    pub fn read_note(&self) -> Result<Option<ProbeNote>, ProbeStoreError> {
        let connection = self.lock_connection()?;
        connection
            .query_row(
                "SELECT text, saved_at_ms, revision FROM probe_note WHERE id = 1",
                [],
                |row| {
                    Ok(ProbeNote {
                        text: row.get(0)?,
                        saved_at_ms: row.get(1)?,
                        revision: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(ProbeStoreError::from)
    }

    fn lock_connection(&self) -> Result<MutexGuard<'_, Connection>, ProbeStoreError> {
        self.connection
            .lock()
            .map_err(|_| ProbeStoreError::MutexPoisoned)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn post_write_failure_rolls_back_all_note_fields_and_revision() {
        let directory = tempfile::tempdir().expect("create isolated temporary directory");
        let path = directory.path().join("rollback-probe.sqlite3");
        let store = ProbeStore::open(&path).expect("open probe database");
        let original = store.save_note("原始笔记\n🙂").expect("save original note");

        {
            let connection = store.connection.lock().expect("lock test connection");
            // RAISE(FAIL) preserves changes already made by this SQL statement.
            // The enclosing transaction must undo the updated row on failure.
            connection
                .execute_batch(
                    "CREATE TRIGGER fail_after_note_update
                     AFTER UPDATE ON probe_note
                     WHEN NEW.text = 'fail-after-write'
                     BEGIN
                         SELECT RAISE(FAIL, 'injected post-write failure');
                     END;",
                )
                .expect("install a failure after the note row is updated");
        }

        let error = store
            .save_note("fail-after-write")
            .expect_err("injected write must fail");
        assert!(matches!(error, ProbeStoreError::Sqlite(_)));
        assert_eq!(
            store.read_note().expect("read after failed save"),
            Some(original.clone())
        );
        drop(store);

        let reopened = ProbeStore::open(&path).expect("reopen probe database");
        assert_eq!(
            reopened.read_note().expect("read durable original"),
            Some(original)
        );
        let next = reopened
            .save_note("恢复后的笔记")
            .expect("save after failure");
        assert_eq!(
            next.revision, 2,
            "a failed save must not consume a revision"
        );
        assert_eq!(reopened.read_note().expect("read new note"), Some(next));
    }
}
