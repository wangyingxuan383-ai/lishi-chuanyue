//! Read-only schema gate for untrusted portable world databases.
//!
//! Normal playable-store opening performs recovery writes. Import must call
//! this gate before discovery or that opening, so imported triggers, views,
//! virtual tables and altered constraints cannot run or become future rules.
//! This verifies schema/integrity only; callers must still audit every domain.

use std::path::Path;

use rusqlite::{types::ValueRef, Connection, OpenFlags};

use crate::{game_store::GameStoreError, game_store_v2};

const APPLICATION_ID: i32 = 0x4c495348;
const MAX_SCHEMA_OBJECTS: usize = 128;
const MAX_SCHEMA_SQL_BYTES: usize = 64 * 1024;

#[derive(Debug, PartialEq, Eq)]
struct SchemaObject {
    kind: String,
    name: String,
    table: String,
    sql: Option<Vec<String>>,
}

/// Inspect only supported, exact application schemas without opening a writer,
/// initializing a database, recovering operations, acquiring owner locks or
/// executing SQL obtained from the package. Schema 3 may predate fast-forward.
pub fn validate_world_schema(
    path: impl AsRef<Path>,
    expected_schema: u32,
) -> Result<(), GameStoreError> {
    if !(1..=3).contains(&expected_schema) {
        return Err(GameStoreError::IncompatibleSchema);
    }
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )?;
    connection.execute_batch("PRAGMA trusted_schema=OFF; PRAGMA query_only=ON; BEGIN DEFERRED;")?;
    let application: i32 =
        connection.pragma_query_value(None, "application_id", |row| row.get(0))?;
    let version: i32 = connection.pragma_query_value(None, "user_version", |row| row.get(0))?;
    if application != APPLICATION_ID || version != expected_schema as i32 {
        return Err(GameStoreError::IncompatibleSchema);
    }
    let actual = schema_objects(&connection)?;
    let expected = Connection::open_in_memory()?;
    expected.execute_batch(if version == 1 {
        crate::game_store::SCHEMA
    } else {
        game_store_v2::SCHEMA
    })?;
    if version == 3 {
        expected.execute_batch(game_store_v2::branches::BRANCH_SCHEMA)?;
        if actual
            .iter()
            .any(|object| object.kind == "table" && object.name == "game_fast_forward_schema")
        {
            expected.execute_batch(game_store_v2::fast_forward::FAST_FORWARD_SCHEMA)?;
        }
    }
    if actual != schema_objects(&expected)? {
        return Err(GameStoreError::IncompatibleSchema);
    }
    if connection.query_row("PRAGMA quick_check", [], |row| row.get::<_, String>(0))? != "ok"
        || connection
            .prepare("PRAGMA foreign_key_check")?
            .query([])?
            .next()?
            .is_some()
    {
        return Err(GameStoreError::Database);
    }
    Ok(())
}

fn schema_text(row: &rusqlite::Row<'_>, column: usize) -> Result<String, GameStoreError> {
    match row.get_ref(column)? {
        ValueRef::Text(value) if value.len() <= MAX_SCHEMA_SQL_BYTES => std::str::from_utf8(value)
            .map(str::to_owned)
            .map_err(|_| GameStoreError::IncompatibleSchema),
        _ => Err(GameStoreError::IncompatibleSchema),
    }
}

fn schema_objects(connection: &Connection) -> Result<Vec<SchemaObject>, GameStoreError> {
    // Include SQLite's generated indexes too: excluding all sqlite_* names
    // could hide objects injected with writable_schema. Supported app schemas
    // never create sqlite_stat tables or any other optional internal object.
    let mut statement = connection
        .prepare("SELECT type,name,tbl_name,sql FROM sqlite_schema ORDER BY type,name")?;
    let mut rows = statement.query([])?;
    let mut objects = Vec::new();
    while let Some(row) = rows.next()? {
        if objects.len() >= MAX_SCHEMA_OBJECTS {
            return Err(GameStoreError::IncompatibleSchema);
        }
        objects.push(SchemaObject {
            kind: schema_text(row, 0)?,
            name: schema_text(row, 1)?,
            table: schema_text(row, 2)?,
            sql: match row.get_ref(3)? {
                ValueRef::Null => None,
                _ => Some(sql_tokens(&schema_text(row, 3)?)?),
            },
        });
    }
    Ok(objects)
}

/// Compare tokens instead of stripping whitespace from all SQL. String literal
/// contents and token boundaries must stay exact: 'pending' != 'pen ding', and
/// changing a CHECK literal's case can change the accepted rows. Quoted names
/// are preserved too; this is a strict supported-schema gate, not a SQL parser.
pub(crate) fn sql_tokens(sql: &str) -> Result<Vec<String>, GameStoreError> {
    if sql.len() > MAX_SCHEMA_SQL_BYTES {
        return Err(GameStoreError::IncompatibleSchema);
    }
    let bytes = sql.as_bytes();
    let mut tokens = Vec::new();
    let mut at = 0;
    while at < bytes.len() {
        let first = bytes[at];
        if first.is_ascii_whitespace() {
            at += 1;
            continue;
        }
        let start = at;
        if matches!(first, b'\'' | b'"' | b'`' | b'[') {
            let end = if first == b'[' { b']' } else { first };
            at += 1;
            loop {
                if at >= bytes.len() {
                    return Err(GameStoreError::IncompatibleSchema);
                }
                if bytes[at] == end {
                    at += 1;
                    if first != b'[' && bytes.get(at) == Some(&end) {
                        at += 1;
                    } else {
                        break;
                    }
                } else {
                    at += 1;
                }
            }
            tokens.push(sql[start..at].into());
        } else if first.is_ascii_alphanumeric() || first == b'_' {
            at += 1;
            while bytes
                .get(at)
                .is_some_and(|value| value.is_ascii_alphanumeric() || *value == b'_')
            {
                at += 1;
            }
            tokens.push(sql[start..at].to_ascii_lowercase());
        } else if first.is_ascii() {
            // App-generated schemas contain no comments. Reject comments rather
            // than accepting arbitrary appended input hidden by normalization.
            if (first == b'-' && bytes.get(at + 1) == Some(&b'-'))
                || (first == b'/' && bytes.get(at + 1) == Some(&b'*'))
            {
                return Err(GameStoreError::IncompatibleSchema);
            }
            at += 1;
            tokens.push(sql[start..at].into());
        } else {
            return Err(GameStoreError::IncompatibleSchema);
        }
    }
    Ok(tokens)
}

#[cfg(test)]
mod tests {
    use super::sql_tokens;

    #[test]
    fn formatting_can_change_but_literals_and_token_boundaries_cannot() {
        assert_eq!(
            sql_tokens("CREATE TABLE t (n INT CHECK(n IN('pending','it''s')))").unwrap(),
            sql_tokens("create  table t(n int check(n in( 'pending' , 'it''s' )))").unwrap()
        );
        for altered in [
            "CREATE TABLE t(n INT CHECK(n IN('pen ding','it''s')))",
            "CREATE TABLE t(n INT CHECK(n IN('PENDING','it''s')))",
            "CREATE TABLE t(n INTCHECK(n IN('pending','it''s')))",
        ] {
            assert_ne!(
                sql_tokens("CREATE TABLE t(n INT CHECK(n IN('pending','it''s')))").unwrap(),
                sql_tokens(altered).unwrap()
            );
        }
        for malformed in [
            "SELECT 'unterminated",
            "SELECT /* hidden */ 1",
            "SELECT -- hidden\n1",
        ] {
            assert!(sql_tokens(malformed).is_err());
        }
    }
}
