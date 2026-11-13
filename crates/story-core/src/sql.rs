use crate::error::{io_error, PlatformError, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params_from_iter, types::ValueRef, Connection, OpenFlags};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, atomic::{AtomicU64, Ordering}},
    time::Duration,
};

const MAX_INTEGER: i64 = 9_007_199_254_740_991;

pub struct SqlStore {
    connection: Arc<Mutex<Connection>>,
    directory: PathBuf,
    generation: AtomicU64,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Statement {
    pub sql: String,
    pub params: Vec<Value>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BackupInfo {
    pub name: String,
    pub at: String,
    pub size: u64,
}

fn sql_error(_: rusqlite::Error) -> PlatformError {
    PlatformError::new("sql_failed", "数据库操作失败")
}

fn integer_error() -> PlatformError {
    PlatformError::new("sql_integer_range", "整数超出 JavaScript 精确范围")
}

fn parameters(params: Vec<Value>) -> Result<Vec<rusqlite::types::Value>> {
    params
        .into_iter()
        .map(|value| {
            use rusqlite::types::Value as SqlValue;
            Ok(match value {
                Value::Null => SqlValue::Null,
                Value::Bool(v) => SqlValue::Integer(i64::from(v)),
                Value::String(v) => SqlValue::Text(v),
                Value::Number(v) if v.is_i64() || v.is_u64() => {
                    let v = v.as_i64().ok_or_else(integer_error)?;
                    if !(-MAX_INTEGER..=MAX_INTEGER).contains(&v) {
                        return Err(integer_error());
                    }
                    SqlValue::Integer(v)
                }
                Value::Number(v) => SqlValue::Real(v.as_f64().ok_or_else(integer_error)?),
                _ => {
                    return Err(PlatformError::new(
                        "sql_param_type",
                        "SQL 参数不支持对象或数组",
                    ))
                }
            })
        })
        .collect()
}

impl SqlStore {
    pub fn shared(&self) -> crate::Store {
        crate::Store(Arc::clone(&self.connection))
    }

    /// Used only by the browser's one-time IndexedDB handoff. System run tables
    /// do not make a fresh host a user database; any actual application row does.
    pub fn is_empty(&self) -> Result<bool> {
        let connection = crate::store::lock_connection(&self.connection);
        empty_database(&connection)
    }

    pub fn import_legacy(&self, bytes: &[u8]) -> Result<bool> {
        if bytes.len() > 128 * 1024 * 1024 || !bytes.starts_with(b"SQLite format 3\0") {
            return Err(PlatformError::new(
                "sql_import_invalid",
                "旧开发台数据库不是有效的 SQLite 文件",
            ));
        }
        let mut connection = crate::store::lock_connection(&self.connection);
        if !empty_database(&connection)? {
            return Ok(false);
        }
        let backups = self.directory.join("backups");
        fs::create_dir_all(&backups).map_err(|_| io_error())?;
        let path = backups.join(format!(
            "{}-legacy-import.sqlite",
            Utc::now().format("%Y%m%dT%H%M%S%.9fZ")
        ));
        fs::write(&path, bytes).map_err(|_| io_error())?;
        let version = backup_schema_version(&path)?;
        if version > crate::migration::LATEST_VERSION {
            return Err(PlatformError::new(
                "sql_restore_newer",
                "旧开发台数据来自更新版本，请先更新",
            ));
        }
        connection
            .restore(
                rusqlite::MAIN_DB,
                &path,
                None::<fn(rusqlite::backup::Progress)>,
            )
            .map_err(sql_error)?;
        *connection = Self::connect(&self.directory)?;
        Ok(true)
    }

    pub fn open(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(&directory).map_err(|_| io_error())?;
        let connection = Self::connect(&directory)?;
        Ok(Self {
            connection: Arc::new(Mutex::new(connection)),
            directory,
            generation: AtomicU64::new(0),
        })
    }

    fn connect(directory: &Path) -> Result<Connection> {
        let mut connection = Connection::open(directory.join("game.sqlite")).map_err(sql_error)?;
        connection
            .busy_timeout(Duration::from_millis(5000))
            .map_err(sql_error)?;
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(sql_error)?;
        crate::migration::migrate(&mut connection, Some(&directory.join("backups")))
            .map_err(|_| PlatformError::new("sql_migration_failed", "存档升级未完成，原有数据与升级备份已保留"))?;
        Ok(connection)
    }

    pub fn generation(&self) -> u64 {self.generation.load(Ordering::SeqCst)}
    pub fn fence_writes(&self) {self.generation.fetch_add(1,Ordering::SeqCst);}
    fn check_generation(&self, issued:u64)->Result<()> {if issued!=self.generation(){return Err(PlatformError::new("sql_restored","存档已经恢复，已取消旧页面的延迟保存"));}Ok(())}

    pub fn query(&self, sql: &str, params: Vec<Value>) -> Result<Vec<Map<String, Value>>> {
        self.query_at(self.generation(),sql,params)
    }
    pub fn query_at(&self,issued:u64,sql:&str,params:Vec<Value>)->Result<Vec<Map<String,Value>>> {
        let params = parameters(params)?;
        let connection = crate::store::lock_connection(&self.connection);
        let mut statement = connection.prepare(sql).map_err(sql_error)?;
        let read_only = statement.readonly();
        if !read_only {self.check_generation(issued)?;crate::maintenance::guard(&connection).map_err(|_|PlatformError::new("sql_maintenance","正在维护或恢复存档，请等待完成"))?;}
        let names: Vec<String> = statement
            .column_names()
            .into_iter()
            .map(str::to_owned)
            .collect();
        let mut rows = statement
            .query(params_from_iter(params))
            .map_err(sql_error)?;
        let mut result = Vec::new();
        while let Some(row) = rows.next().map_err(sql_error)? {
            if !read_only {
                continue;
            }
            let mut object = Map::new();
            for (index, name) in names.iter().enumerate() {
                let value = match row.get_ref(index).map_err(sql_error)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(v) => {
                        if !(-MAX_INTEGER..=MAX_INTEGER).contains(&v) {
                            return Err(integer_error());
                        }
                        Value::from(v)
                    }
                    ValueRef::Real(v) => Value::from(v),
                    ValueRef::Text(v) => Value::String(String::from_utf8_lossy(v).into_owned()),
                    ValueRef::Blob(_) => {
                        return Err(PlatformError::new(
                            "sql_blob_unsupported",
                            "SQL 不支持 BLOB",
                        ))
                    }
                };
                object.insert(name.clone(), value);
            }
            result.push(object);
        }
        Ok(result)
    }

    pub fn batch(&self, statements: Vec<Statement>) -> Result<()> {self.batch_at(self.generation(),statements)}
    pub fn batch_at(&self,issued:u64,statements:Vec<Statement>)->Result<()> {
        let mut connection = crate::store::lock_connection(&self.connection);
        self.check_generation(issued)?;
        crate::maintenance::guard(&connection).map_err(|_|PlatformError::new("sql_maintenance","正在维护或恢复存档，请等待完成"))?;
        let transaction = connection.transaction().map_err(sql_error)?;
        fn keep_transaction(
            context: rusqlite::hooks::AuthContext<'_>,
        ) -> rusqlite::hooks::Authorization {
            if matches!(
                context.action,
                rusqlite::hooks::AuthAction::Transaction { .. }
            ) {
                rusqlite::hooks::Authorization::Deny
            } else {
                rusqlite::hooks::Authorization::Allow
            }
        }
        transaction
            .authorizer(Some(keep_transaction))
            .map_err(sql_error)?;
        let execution = (|| {
            for statement in statements {
                if statement.params.is_empty() {
                    transaction
                        .execute_batch(&statement.sql)
                        .map_err(sql_error)?;
                } else {
                    let params = parameters(statement.params)
                        .map_err(|_| PlatformError::new("sql_failed", "批量 SQL 参数无效"))?;
                    transaction
                        .execute(&statement.sql, params_from_iter(params))
                        .map_err(sql_error)?;
                }
            }
            Ok(())
        })();
        transaction
            .authorizer(
                None::<fn(rusqlite::hooks::AuthContext<'_>) -> rusqlite::hooks::Authorization>,
            )
            .map_err(sql_error)?;
        execution?;
        transaction.commit().map_err(sql_error)
    }

    pub fn backup(&self, label: &str) -> Result<String> {
        let connection = crate::store::lock_connection(&self.connection);
        self.backup_locked(&connection, label, None)
    }

    /// Replaces the live database with the backup `name` (B2); returns the
    /// name of the `before-restore` backup holding the data it replaced.
    ///
    /// The file must be an intact SQLite database of this app (it has a
    /// `schema_version` table, no newer than the live one). Pages are copied
    /// into the live connection with SQLite's online backup API, which is
    /// WAL-safe and leaves the database as it was if the copy fails; the
    /// connection is then reopened so no cached schema or session state survives.
    pub fn restore(&self, name: &str) -> Result<String> { self.restore_inner(name,None) }
    pub fn restore_managed(&self,name:&str,ticket:&crate::maintenance::Ticket)->Result<String> {self.restore_inner(name,Some(ticket))}
    fn restore_inner(&self, name: &str,ticket:Option<&crate::maintenance::Ticket>) -> Result<String> {
        let missing = || PlatformError::new("sql_restore_missing", "没有这份备份");
        if !valid_backup_name(name) {
            return Err(missing());
        }
        let path = self.directory.join("backups").join(name);
        if !path.is_file() {
            return Err(missing());
        }
        let version = backup_schema_version(&path)?;
        let mut connection = crate::store::lock_connection(&self.connection);
        if let Some(ticket)=ticket {crate::maintenance::verify(&connection,ticket).map_err(|_|PlatformError::new("sql_maintenance","存档维护批次失效，尚未恢复"))?;}else{crate::maintenance::guard(&connection).map_err(|_|PlatformError::new("sql_maintenance","正在恢复存档，请等待完成"))?;}

        let has_runs: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_runs')", [], |r| r.get(0)).map_err(sql_error)?;
        if has_runs && connection.query_row("SELECT EXISTS(SELECT 1 FROM execution_runs WHERE status IN ('running','committing'))", [], |r| r.get::<_,bool>(0)).map_err(sql_error)? {
            return Err(PlatformError::new("sql_restore_busy", "请先停止正在生成的故事，再恢复备份"));
        }
        let has_pi: bool = connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_tasks')", [], |r| r.get(0)).map_err(sql_error)?;
        if has_pi && connection.query_row("SELECT EXISTS(SELECT 1 FROM pi_tasks WHERE status IN ('running','committing'))", [], |r| r.get::<_,bool>(0)).map_err(sql_error)? {
            return Err(PlatformError::new("sql_restore_busy", "请先停止助手任务，再恢复备份"));
        }
        if let Ok(Some(live)) = schema_version(&connection) {
            if version > live {
                return Err(PlatformError::new(
                    "sql_restore_newer",
                    "这份备份来自更新版本的应用，请先更新",
                ));
            }
        }
        // Fully migrate and check a private copy before changing live pages.
        let prepared_dir=self.directory.join(format!("restore-{}",uuid::Uuid::new_v4()));
        fs::create_dir_all(&prepared_dir).map_err(|_|io_error())?;
        let prepared_path=prepared_dir.join("game.sqlite");
        fs::copy(&path,&prepared_path).map_err(|_|io_error())?;
        let prepared=(|| {
            let db=Self::connect(&prepared_dir)?;
            crate::pi_backup::prepare(&db,&self.directory,&path).map_err(|_|PlatformError::new("sql_restore_context","助手备份校验未完成，原存档未改变"))?;
            if let Some(ticket)=ticket {
                crate::maintenance::install(&db,ticket).map_err(|_|io_error())?;
                db.execute_batch("UPDATE pi_tasks SET status=CASE WHEN status IN ('running','committing') THEN 'interrupted' ELSE status END,metadata_json=json_set(metadata_json,'$._nativeHostActive',json('false')) WHERE status IN ('running','committing') OR json_extract(metadata_json,'$._nativeHostActive')=1; UPDATE pi_model_requests SET status='unknown' WHERE status IN ('running','awaiting_usage'); UPDATE execution_runs SET status='interrupted',error='从备份恢复后保留进度，未自动执行' WHERE status IN ('running','committing'); UPDATE world_execution_leases SET owner_id='',owner_instance='',expires_at_ms=0,fence=fence+1;").map_err(sql_error)?;
            }
            let check:String=db.query_row("PRAGMA quick_check",[],|r|r.get(0)).map_err(sql_error)?;
            if check!="ok" {return Err(PlatformError::new("sql_restore_invalid","备份校验失败，原存档未改变"));}
            db.execute_batch("PRAGMA wal_checkpoint(TRUNCATE)").map_err(sql_error)?;
            Ok(())
        })();
        if let Err(error)=prepared {let _=fs::remove_dir_all(&prepared_dir);return Err(error);}
        let saved = self.backup_locked(&connection, "before-restore", Some(name))?;
        self.fence_writes();
        let applied=(|| {
            connection.restore(rusqlite::MAIN_DB,&prepared_path,None::<fn(rusqlite::backup::Progress)>).map_err(sql_error)?;
            *connection=Self::connect(&self.directory)?;
            Ok(())
        })();
        if applied.is_err() {
            connection.restore(rusqlite::MAIN_DB,self.directory.join("backups").join(&saved),None::<fn(rusqlite::backup::Progress)>).map_err(sql_error)?;
            *connection=Self::connect(&self.directory)?;
        }
        let _=fs::remove_dir_all(&prepared_dir);
        applied?;
        Ok(saved)
    }

    /// Snapshots `connection` into backups/ and keeps the newest 20, never
    /// pruning `keep` (the file a restore is about to read).
    fn backup_locked(
        &self,
        connection: &Connection,
        label: &str,
        keep: Option<&str>,
    ) -> Result<String> {
        if !(1..=40).contains(&label.len())
            || !label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        {
            return Err(PlatformError::new("sql_backup_label", "备份标签格式不正确"));
        }
        let directory = self.directory.join("backups");
        fs::create_dir_all(&directory).map_err(|_| io_error())?;
        let name = format!("{}-{label}.sqlite", Utc::now().format("%Y%m%dT%H%M%S%.9fZ"));
        let path = directory.join(&name);
        connection.execute_batch("BEGIN IMMEDIATE").map_err(sql_error)?;
        let snapshot=(|| {
            let reader=Connection::open_with_flags(self.directory.join("game.sqlite"),OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql_error)?;
            reader.backup(rusqlite::MAIN_DB,&path,None).map_err(sql_error)?;
            let saved=Connection::open_with_flags(&path,OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(sql_error)?;
            crate::pi_backup::snapshot(&saved,&self.directory,&path).map_err(|_|PlatformError::new("sql_backup_context","未能建立匹配的助手会话备份"))?;
            Ok(())
        })();
        let ended=connection.execute_batch(if snapshot.is_ok(){"COMMIT"}else{"ROLLBACK"}).map_err(sql_error);
        if let Err(error)=snapshot {let _=fs::remove_file(&path);let _=fs::remove_dir_all(path.with_extension("pi"));return Err(error);}
        ended?;
        for old in self
            .list_backups()?
            .into_iter()
            .skip(20)
            .filter(|old| Some(old.name.as_str()) != keep)
        {
            let old_path=directory.join(old.name);
            fs::remove_file(&old_path).map_err(|_| io_error())?;
            let _=fs::remove_dir_all(old_path.with_extension("pi"));
        }
        Ok(name)
    }

    pub fn list_backups(&self) -> Result<Vec<BackupInfo>> {
        let entries = match fs::read_dir(self.directory.join("backups")) {
            Ok(v) => v,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(_) => return Err(io_error()),
        };
        let mut backups = Vec::new();
        for entry in entries {
            let entry = entry.map_err(|_| io_error())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if !name.ends_with(".sqlite") {
                continue;
            }
            let meta = entry.metadata().map_err(|_| io_error())?;
            if !meta.is_file() {
                continue;
            }
            let at: DateTime<Utc> = meta.modified().map_err(|_| io_error())?.into();
            backups.push(BackupInfo {
                name,
                at: at.to_rfc3339(),
                size: meta.len(),
            });
        }
        backups.sort_by(|a, b| b.name.cmp(&a.name));
        Ok(backups)
    }
}

/// A plain file name in backups/: no separators, no `..`, ends in `.sqlite`.
fn empty_database(connection: &Connection) -> Result<bool> {
    let runs: bool=connection.query_row("SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name='execution_runs')",[],|r|r.get(0)).map_err(sql_error)?;
    if runs
        && connection
            .query_row("SELECT EXISTS(SELECT 1 FROM execution_runs)", [], |r| {
                r.get::<_, bool>(0)
            })
            .map_err(sql_error)?
    {
        return Ok(false);
    }
    let mut statement = connection.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'execution_%' AND name <> 'schema_version'").map_err(sql_error)?;
    let names = statement
        .query_map([], |r| r.get::<_, String>(0))
        .map_err(sql_error)?
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(sql_error)?;
    for name in names {
        let has_rows: bool = connection
            .query_row(
                &format!(
                    "SELECT EXISTS(SELECT 1 FROM \"{}\" LIMIT 1)",
                    name.replace('"', "\"\"")
                ),
                [],
                |r| r.get(0),
            )
            .map_err(sql_error)?;
        if has_rows {
            return Ok(false);
        }
    }
    Ok(true)
}

fn valid_backup_name(name: &str) -> bool {
    (8..=120).contains(&name.len())
        && name.ends_with(".sqlite")
        && !name.starts_with('.')
        && !name.contains("..")
        && name
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-' || b == b'.')
}

fn schema_version(connection: &Connection) -> rusqlite::Result<Option<i64>> {
    connection.query_row("SELECT MAX(version) FROM schema_version", [], |row| {
        row.get::<_, Option<i64>>(0)
    })
}

/// The backup's schema version, or an error unless it is an intact database of this app.
fn backup_schema_version(path: &Path) -> Result<i64> {
    let invalid =
        || PlatformError::new("sql_restore_invalid", "这份备份已损坏，或不是本应用的存档");
    let connection = Connection::open_with_flags(
        path,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .map_err(|_| invalid())?;
    let check: String = connection
        .query_row("PRAGMA quick_check", [], |row| row.get(0))
        .map_err(|_| invalid())?;
    if check != "ok" {
        return Err(invalid());
    }
    match schema_version(&connection) {
        Ok(Some(version)) if version > 0 => Ok(version),
        _ => Err(invalid()),
    }
}

#[cfg(test)]
mod tests;
