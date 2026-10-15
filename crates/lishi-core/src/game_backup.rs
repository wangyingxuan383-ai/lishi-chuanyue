//! Consistent online snapshots; never copy a live main database without WAL.
use crate::game_store::GameStoreError;
use rusqlite::{
    backup::{Backup, StepResult},
    Connection,
};
use std::{
    fs::{File, OpenOptions},
    path::Path,
    time::Duration,
};

pub(crate) fn snapshot(connection: &Connection, target: &Path) -> Result<(), GameStoreError> {
    // The caller supplies a private stage and holds the source owner/mutex.
    let file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(target)
        .map_err(|_| GameStoreError::Unavailable)?;
    drop(file);
    let result = (|| {
        let mut destination = Connection::open(target)?;
        let backup = Backup::new(connection, &mut destination)?;
        let mut busy = 0;
        loop {
            match backup.step(64)? {
                StepResult::Done => break,
                StepResult::More => {}
                _ => {
                    busy += 1;
                    if busy > 20 {
                        return Err(GameStoreError::Busy);
                    }
                    std::thread::sleep(Duration::from_millis(5));
                }
            }
        }
        drop(backup);
        if destination.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))? != "ok" {
            return Err(GameStoreError::Database);
        }
        destination.execute_batch("PRAGMA journal_mode=DELETE;")?;
        drop(destination);
        File::options()
            .write(true)
            .open(target)
            .and_then(|f| f.sync_all())
            .map_err(|_| GameStoreError::Unavailable)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = std::fs::remove_file(target);
    }
    result
}
