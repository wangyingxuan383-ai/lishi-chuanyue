//! One SQLite read snapshot for formal story, books, sources and readable Pi.
use crate::{agent_workspace as ws, pi_archive, Error, Result, Store};
use rusqlite::{Connection, ToSql, TransactionBehavior};
use serde::ser::{SerializeMap, SerializeSeq};
use serde::{Serialize, Serializer};
use serde_json::Value;
use std::{cell::RefCell, collections::BTreeSet, io::Write};

type BookIds = RefCell<BTreeSet<String>>;

fn book_ids(value: &Value, ids: &mut BTreeSet<String>) {
    match value {
        Value::Object(map) => {
            if let Some(id) = map.get("bookId").and_then(Value::as_str) {
                ids.insert(id.into());
            }
            for item in map.values() {
                book_ids(item, ids);
            }
        }
        Value::Array(items) => {
            for item in items {
                book_ids(item, ids);
            }
        }
        _ => {}
    }
}

// Keep concrete database and validation errors across the serializer boundary.
#[derive(Default)]
struct ExportError(RefCell<Option<Error>>);

impl ExportError {
    fn report<E: serde::ser::Error>(&self, error: Error) -> E {
        let reported = E::custom(&error);
        self.0.replace(Some(error));
        reported
    }
}

enum RowError<E> {
    Sql(rusqlite::Error),
    Serialize(E),
}

impl<E> From<rusqlite::Error> for RowError<E> {
    fn from(error: rusqlite::Error) -> Self {
        Self::Sql(error)
    }
}

enum RowKind<'a> {
    Plain,
    References(&'a BookIds),
    FactSource(&'a BookIds),
    Job,
    Note,
}

impl RowKind<'_> {
    fn prepare(&self, mut row: Value) -> Value {
        match self {
            Self::FactSource(_) => {
                row["source_json"] =
                    pi_archive::formal_source(&ws::parse(ws::text(&row, "source_json")))
                        .to_string()
                        .into();
            }
            Self::Job => return ws::parse(ws::text(&row, "json")),
            Self::Note => {
                for key in ["scope", "refs", "progress"] {
                    row[key] = ws::parse(ws::text(&row, key));
                }
                row["active"] = (row["active"].as_i64() == Some(1)).into();
                if row["status"] == "running" {
                    row["status"] = "paused".into();
                }
            }
            _ => {}
        }
        if let Self::References(ids) | Self::FactSource(ids) = self {
            for (key, value) in row.as_object().into_iter().flatten() {
                if key.ends_with("_json") || key == "json" {
                    book_ids(
                        &ws::parse(value.as_str().unwrap_or("")),
                        &mut ids.borrow_mut(),
                    );
                }
            }
        }
        row
    }
}

struct Rows<'a> {
    db: &'a Connection,
    query: &'static str,
    args: &'a [&'a dyn ToSql],
    kind: RowKind<'a>,
    errors: &'a ExportError,
}

impl Serialize for Rows<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(None)?;
        ws::visit_rows(self.db, self.query, self.args, |row| {
            seq.serialize_element(&self.kind.prepare(row))
                .map_err(RowError::Serialize)
        })
        .map_err(|error| match error {
            RowError::Sql(error) => self.errors.report(error.into()),
            RowError::Serialize(error) => error,
        })?;
        seq.end()
    }
}

struct Format7<'a> {
    db: &'a Connection,
    world: &'a str,
    row: Value,
    errors: &'a ExportError,
}

impl Serialize for Format7<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut map = serializer.serialize_map(Some(14))?;
        map.serialize_entry("format", "lishi-world")?;
        // 8: 本局札记 (storyNotes, D174).
        map.serialize_entry("version", &8)?;
        map.serialize_entry("exportedAt", &ws::now())?;
        map.serialize_entry("world", &self.row)?;
        let ids = BookIds::default();
        let args: &[&dyn ToSql] = &[&self.world];
        for (name, query, kind) in [
            ("nodes", "SELECT * FROM nodes WHERE world_id=? ORDER BY seq,id", RowKind::References(&ids)),
            ("states", "SELECT s.* FROM states s JOIN nodes n ON n.id=s.node_id WHERE n.world_id=? ORDER BY s.node_id", RowKind::References(&ids)),
            ("lines", "SELECT * FROM lines WHERE world_id=? ORDER BY id", RowKind::Plain),
            ("pins", "SELECT * FROM pins WHERE world_id=? ORDER BY id", RowKind::Plain),
            ("chapters", "SELECT * FROM chapters WHERE world_id=? ORDER BY id", RowKind::Plain),
            ("factSources", "SELECT * FROM story_fact_sources WHERE world_id=? ORDER BY id", RowKind::FactSource(&ids)),
            ("factCorrections", "SELECT * FROM fact_corrections WHERE world_id=? ORDER BY id", RowKind::References(&ids)),
            ("storyNotes", "SELECT id,world_id AS worldId,kind,title,scope_json AS scope,content,previous_content AS previousContent,refs_json AS refs,model,status,active,progress_json AS progress,origin_world_id AS originWorldId,origin_title AS originTitle,created_at AS createdAt,updated_at AS updatedAt,'story' AS source FROM story_notes WHERE world_id=? ORDER BY created_at,id", RowKind::Note),
        ] {
            map.serialize_entry(name, &Rows { db: self.db, query, args, kind, errors: self.errors })?;
        }
        let pi = pi_archive::export_readable(self.db, self.world)
            .map_err(|error| self.errors.report(error))?;
        book_ids(&pi, &mut ids.borrow_mut());
        map.serialize_entry("pi", &pi)?;
        drop(pi);
        map.serialize_entry(
            "books",
            &Books {
                db: self.db,
                world: self.world,
                ids: ids.into_inner(),
                errors: self.errors,
            },
        )?;
        map.end()
    }
}

struct Books<'a> {
    db: &'a Connection,
    world: &'a str,
    ids: BTreeSet<String>,
    errors: &'a ExportError,
}

impl Serialize for Books<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let mut seq = serializer.serialize_seq(Some(self.ids.len()))?;
        for id in &self.ids {
            seq.serialize_element(&Book {
                db: self.db,
                world: self.world,
                id,
                errors: self.errors,
            })?;
        }
        seq.end()
    }
}

struct Book<'a> {
    db: &'a Connection,
    world: &'a str,
    id: &'a str,
    errors: &'a ExportError,
}

impl Serialize for Book<'_> {
    fn serialize<S: Serializer>(&self, serializer: S) -> std::result::Result<S::Ok, S::Error> {
        let rows = ws::rows(
            self.db,
            "SELECT json FROM source_books WHERE id=?",
            &[&self.id],
        )
        .map_err(|error| self.errors.report(error))?;
        let row = rows.first().ok_or_else(|| {
            self.errors
                .report(Error::Invalid("参考书籍缺失，无法导出完整故事".into()))
        })?;
        let mut map = serializer.serialize_map(Some(4))?;
        let mut book = ws::parse(ws::text(row, "json"));
        drop(rows);
        if book["sections"]
            .as_array()
            .is_some_and(|sections| sections.iter().any(|s| !s["text"].is_string()))
        {
            let mut by_section: std::collections::BTreeMap<usize, String> =
                std::collections::BTreeMap::new();
            let mut stmt = self
                .db
                .prepare(
                    "SELECT section, text FROM source_chunks WHERE book_id=? ORDER BY section ASC, ordinal ASC",
                )
                .map_err(|e| self.errors.report(e.into()))?;
            let mut chunk_rows = stmt
                .query([&self.id])
                .map_err(|e| self.errors.report(e.into()))?;
            while let Some(r) = chunk_rows.next().map_err(|e| self.errors.report(e.into()))? {
                let sec: i64 = r.get(0).map_err(|e| self.errors.report(e.into()))?;
                let txt: String = r.get(1).map_err(|e| self.errors.report(e.into()))?;
                if let Ok(idx) = usize::try_from(sec) {
                    by_section.entry(idx).or_default().push_str(&txt);
                }
            }
            if let Some(sections) = book["sections"].as_array_mut() {
                for (idx, section) in sections.iter_mut().enumerate() {
                    if !section["text"].is_string() {
                        let sec_key = section
                            .get("index")
                            .or_else(|| section.get("section"))
                            .and_then(Value::as_u64)
                            .and_then(|n| usize::try_from(n).ok())
                            .unwrap_or(idx);
                        let full_text = by_section.get(&sec_key).cloned().unwrap_or_default();
                        if let Some(obj) = section.as_object_mut() {
                            obj.insert("text".into(), Value::String(full_text));
                        }
                    }
                }
            }
        }
        map.serialize_entry("book", &book)?;
        drop(book);
        let book_only: &[&dyn ToSql] = &[&self.id];
        let book_and_world: &[&dyn ToSql] = &[&self.id, &self.world];
        for (name, query, kind, args) in [
            ("jobs", "SELECT json FROM source_jobs WHERE book_id=? ORDER BY id", RowKind::Job, book_only),
            ("analysis", "SELECT job_id AS jobId,ordinal,section,text FROM source_analysis WHERE book_id=? ORDER BY job_id,ordinal", RowKind::Plain, book_only),
            ("notes", "SELECT id,book_id AS bookId,world_id AS worldId,kind,title,scope_json AS scope,content,previous_content AS previousContent,refs_json AS refs,model,status,active,progress_json AS progress,created_at AS createdAt,updated_at AS updatedAt FROM canon_notes WHERE book_id=? AND (world_id IS NULL OR world_id=?) ORDER BY created_at,id", RowKind::Note, book_and_world),
        ] {
            map.serialize_entry(name, &Rows { db: self.db, query, args, kind, errors: self.errors })?;
        }
        map.end()
    }
}

fn with_snapshot<T>(
    store: &Store,
    world: &str,
    export: impl FnOnce(&Format7<'_>) -> serde_json::Result<T>,
) -> Result<T> {
    let mut db = store.lock()?;
    let was_query_only: bool = db.pragma_query_value(None, "query_only", |row| row.get(0))?;
    db.pragma_update(None, "query_only", true)?;
    let result = (|| {
        let tx = db.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let row = ws::rows(&tx, "SELECT * FROM worlds WHERE id=?", &[&world])?
            .into_iter()
            .next()
            .ok_or_else(|| Error::Invalid("故事不存在".into()))?;
        let errors = ExportError::default();
        let archive = Format7 {
            db: &tx,
            world,
            row,
            errors: &errors,
        };
        let result = export(&archive).map_err(|error| {
            errors
                .0
                .into_inner()
                .unwrap_or_else(|| Error::Invalid(error.to_string()))
        })?;
        tx.commit()?;
        Ok(result)
    })();
    db.pragma_update(None, "query_only", was_query_only)?;
    result
}

pub fn export(store: &Store, world: &str) -> Result<Value> {
    with_snapshot(store, world, |archive| serde_json::to_value(archive))
}

/// Stream formal tables and each book into the destination without retaining the
/// whole archive. The caller owns the writer limit and discards failed output.
pub fn export_to(store: &Store, world: &str, writer: impl Write) -> Result<()> {
    with_snapshot(store, world, |archive| {
        serde_json::to_writer(writer, archive)
    })
}

pub fn validate_history(request: &Value) -> Result<Value> {
    let world = ws::text(request, "worldId");
    let lines = request["lineIds"]
        .as_array()
        .ok_or_else(|| Error::Invalid("缺少归档路线".into()))?
        .iter()
        .filter_map(Value::as_str)
        .map(str::to_owned)
        .collect::<Vec<_>>();
    pi_archive::validate_readable(&request["pi"], world, &lines)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    use std::sync::{Arc, Mutex};

    fn store() -> Store {
        let mut db = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        db.execute_batch(
            "INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('w','荒野','','t','t','t');
            INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',0,'opening','桥边','t');
            INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n','t');
            UPDATE worlds SET current_line_id='l' WHERE id='w';
            INSERT INTO source_books VALUES('b','样书','txt','t','{\"id\":\"b\",\"sections\":[]}');
            INSERT INTO states(node_id,state_json) VALUES('n','{\"source\":{\"bookId\":\"b\"}}');
            INSERT INTO canon_notes(id,book_id,world_id,kind,title,scope_json,content,previous_content,refs_json,status,progress_json,created_at,updated_at)
            VALUES('note','b','w','question','疑问','{}','已保存部分','原著札记旧版','[0]','running','{\"parts\":[\"摘要\"],\"total\":2}','t','t');
            INSERT INTO story_notes(id,world_id,kind,title,scope_json,content,previous_content,refs_json,model,status,active,progress_json,origin_title,created_at,updated_at)
            VALUES('sn','w','plot','主线梗概','{\"to\":3}','第一回合起','旧版','[]','m','done',1,'{\"parts\":[],\"total\":0}','前作','t','t');",
        )
        .unwrap();
        Store(Arc::new(Mutex::new(db)))
    }

    #[test]
    fn native_export_preserves_format8_rows_and_notes() {
        let store = store();
        let mut expected = export(&store, "w").unwrap();
        let mut bytes = Vec::new();
        export_to(&store, "w", &mut bytes).unwrap();
        let mut native: Value = serde_json::from_slice(&bytes).unwrap();
        expected.as_object_mut().unwrap().remove("exportedAt");
        native.as_object_mut().unwrap().remove("exportedAt");
        assert_eq!(native, expected);
        assert_eq!(native["version"], 8);
        let story = &native["storyNotes"][0];
        assert_eq!(story["source"], "story");
        assert_eq!(story["scope"]["to"], 3);
        assert_eq!(story["active"], true);
        assert_eq!(story["previousContent"], "旧版");
        assert_eq!(story["originTitle"], "前作");
        assert_eq!(native["lines"][0]["node_id"], "n");
        assert_eq!(native["nodes"][0]["narrative"], "桥边");
        assert_eq!(native["books"][0]["book"]["id"], "b");
        let note = &native["books"][0]["notes"][0];
        assert_eq!(note["status"], "paused");
        assert_eq!(note["previousContent"], "原著札记旧版");
        assert_eq!(note["refs"], json!([0]));
        assert_eq!(note["progress"]["parts"], json!(["摘要"]));
    }

    #[test]
    fn rejected_writes_release_the_read_snapshot_and_preserve_missing_book_errors() {
        let store = store();
        let mut cap = [0; 16];
        assert!(export_to(&store, "w", &mut cap[..]).is_err());
        let db = store.lock().unwrap();
        assert!(db.is_autocommit());
        db.execute("DELETE FROM source_books WHERE id='b'", [])
            .unwrap();
        drop(db);
        let error = export_to(&store, "w", std::io::sink()).unwrap_err();
        assert!(matches!(error, Error::Invalid(message) if message.contains("参考书籍缺失")));
    }

    #[test]
    fn slim_book_sections_rehydrate_full_text_from_source_chunks_on_export() {
        let store = store();
        {
            let db = store.lock().unwrap();
            db.execute(
                "UPDATE source_books SET json=? WHERE id='b'",
                [r#"{"id":"b","title":"样书","sections":[{"title":"第一章"},{"title":"第二章"}]}"#],
            )
            .unwrap();
            db.execute_batch(
                "INSERT INTO source_chunks(book_id,ordinal,section,text) VALUES
                   ('b',1,0,'后半段。'),
                   ('b',0,0,'前半段，'),
                   ('b',2,1,'第二章全文。');",
            )
            .unwrap();
        }
        let exported = export(&store, "w").unwrap();
        let sections = exported["books"][0]["book"]["sections"].as_array().unwrap();
        assert_eq!(sections[0]["text"], "前半段，后半段。");
        assert_eq!(sections[1]["text"], "第二章全文。");
    }
}
