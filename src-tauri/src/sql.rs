use crate::error::{io_error, PlatformError, Result};
use chrono::{DateTime, Utc};
use rusqlite::{params_from_iter, types::ValueRef, Connection};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{fs, path::PathBuf, sync::Mutex, time::Duration};

const MAX_INTEGER: i64 = 9_007_199_254_740_991;

pub struct SqlStore {
    connection: Mutex<Connection>,
    directory: PathBuf,
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
    pub fn open(directory: PathBuf) -> Result<Self> {
        fs::create_dir_all(&directory).map_err(|_| io_error())?;
        let connection = Connection::open(directory.join("game.sqlite")).map_err(sql_error)?;
        connection
            .busy_timeout(Duration::from_millis(5000))
            .map_err(sql_error)?;
        connection
            .execute_batch("PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;")
            .map_err(sql_error)?;
        Ok(Self {
            connection: Mutex::new(connection),
            directory,
        })
    }

    pub fn query(&self, sql: &str, params: Vec<Value>) -> Result<Vec<Map<String, Value>>> {
        let params = parameters(params)?;
        let connection = self.connection.lock().map_err(|_| io_error())?;
        let mut statement = connection.prepare(sql).map_err(sql_error)?;
        let read_only = statement.readonly();
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

    pub fn batch(&self, statements: Vec<Statement>) -> Result<()> {
        let mut connection = self.connection.lock().map_err(|_| io_error())?;
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
        if !(1..=40).contains(&label.len())
            || !label
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
        {
            return Err(PlatformError::new("sql_backup_label", "备份标签格式不正确"));
        }
        let connection = self.connection.lock().map_err(|_| io_error())?;
        let directory = self.directory.join("backups");
        fs::create_dir_all(&directory).map_err(|_| io_error())?;
        let name = format!("{}-{label}.sqlite", Utc::now().format("%Y%m%dT%H%M%S%.9fZ"));
        let path = directory.join(&name);
        if let Err(error) = connection.backup(rusqlite::MAIN_DB, &path, None) {
            let _ = fs::remove_file(&path);
            return Err(sql_error(error));
        }
        for old in self.list_backups()?.into_iter().skip(20) {
            fs::remove_file(directory.join(old.name)).map_err(|_| io_error())?;
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

#[cfg(test)]
mod tests;
