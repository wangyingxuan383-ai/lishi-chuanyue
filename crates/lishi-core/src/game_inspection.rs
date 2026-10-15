//! Read-only discovery, including WAL, before selecting a playable store.
//! Listing never initializes a database, interrupts requests or upgrades saves.
use crate::{
    game_protocol::{validate_setup, WorldSetup},
    game_store::{valid_game_id, GameStoreError},
};
use rusqlite::{Connection, OpenFlags};
use std::path::Path;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct WorldMetadata {
    pub schema_version: i32,
    pub setup: WorldSetup,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
}

pub fn inspect_world(path: impl AsRef<Path>) -> Result<WorldMetadata, GameStoreError> {
    if !path.as_ref().is_file() {
        return Err(GameStoreError::NotFound);
    }
    let db = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| GameStoreError::Database)?;
    db.execute_batch("PRAGMA query_only=ON;BEGIN DEFERRED;")?;
    let version: i32 = db.pragma_query_value(None, "user_version", |r| r.get(0))?;
    let app: i32 = db.pragma_query_value(None, "application_id", |r| r.get(0))?;
    if !matches!(version, 1..=3) || app != 0x4c495348 {
        return Err(GameStoreError::IncompatibleSchema);
    }
    let count: i64 = db.query_row("SELECT count(*) FROM game_world", [], |r| r.get(0))?;
    if count != 1 {
        return Err(GameStoreError::Database);
    }
    let (world_id, setup_json, head, count): (String, String, Option<String>, i64) = db.query_row(
        "SELECT world_id,setup,head_turn_id,turn_count FROM game_world WHERE id=1",
        [],
        |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
    )?;
    let setup: WorldSetup =
        serde_json::from_str(&setup_json).map_err(|_| GameStoreError::Database)?;
    validate_setup(&setup).map_err(|_| GameStoreError::Database)?;
    if world_id != setup.world_id
        || count < 0
        || (count == 0) != head.is_none()
        || head.as_ref().is_some_and(|id| !valid_game_id(id))
    {
        return Err(GameStoreError::Database);
    }
    Ok(WorldMetadata {
        schema_version: version,
        setup,
        head_turn_id: head,
        turn_count: count as u64,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        game_protocol::initial_state,
        game_store::{GameActionKind, GameOperationStatus, GameStore, GameTurnRequest},
    };
    fn setup() -> WorldSetup {
        WorldSetup {
            world_id: "inspection-world-0001".into(),
            title: "只读发现".into(),
            country: "秦".into(),
            era_year: -221,
            location_name: "咸阳".into(),
            protagonist_name: "李明".into(),
            narrative_style: "中文".into(),
        }
    }
    #[test]
    fn listing_does_not_interrupt_a_live_operation_or_initialize_empty_files() {
        let temp = tempfile::tempdir().unwrap();
        let path = temp.path().join("world.sqlite");
        let s = setup();
        let store = GameStore::open(&path).unwrap();
        store
            .create_world(&s, &initial_state(&s).unwrap(), "开局", &[])
            .unwrap();
        store
            .begin(&GameTurnRequest {
                operation_id: "inspection-operation-01".into(),
                world_id: s.world_id.clone(),
                branch_id: "main".into(),
                expected_head_turn_id: None,
                action_kind: GameActionKind::Action,
                action_text: "等待".into(),
            })
            .unwrap();
        let metadata = inspect_world(&path).unwrap();
        assert_eq!(metadata.turn_count, 0);
        assert_eq!(metadata.setup, s);
        assert_eq!(
            store.view().unwrap().latest_operation.unwrap().status,
            GameOperationStatus::Pending
        );
        let blank = temp.path().join("blank.sqlite");
        std::fs::write(&blank, []).unwrap();
        assert_eq!(
            inspect_world(&blank).unwrap_err(),
            GameStoreError::IncompatibleSchema
        );
        assert_eq!(std::fs::metadata(blank).unwrap().len(), 0);
        let missing = temp.path().join("missing.sqlite");
        assert_eq!(
            inspect_world(&missing).unwrap_err(),
            GameStoreError::NotFound
        );
        assert!(!missing.exists());
    }
}
