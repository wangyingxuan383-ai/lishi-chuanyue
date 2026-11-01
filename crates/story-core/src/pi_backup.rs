//! Database backups own matching, immutable Pi files. An older database must
//! never reopen a live session file which has since gained different messages.
use crate::{agent_workspace as ws, Error, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{fs, path::Path};

fn digest(bytes: &[u8]) -> String { format!("{:x}", Sha256::digest(bytes)) }
fn io(_: std::io::Error) -> Error { Error::Invalid("助手会话备份文件未能校验，原存档保留".into()) }

pub(crate) fn snapshot(db: &Connection, root: &Path, backup: &Path) -> Result<()> {
    let sidecar=backup.with_extension("pi");
    fs::create_dir_all(&sidecar).map_err(io)?;
    let mut files=vec![];
    for row in ws::rows(db,"SELECT id,session_file FROM pi_sessions WHERE session_file IS NOT NULL",&[])? {
        let id=ws::text(&row,"id");
        let active:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM pi_tasks WHERE session_id=? AND (status IN ('running','committing') OR json_extract(metadata_json,'$._nativeHostActive')=1))",[id],|r|r.get(0))?;
        if active {continue;}
        let source=Path::new(ws::text(&row,"session_file"));
        let owned=root.join("agent-sessions").join(id);
        if crate::pi_runtime::require_owned_path(&owned,source).is_err() || !source.is_file(){continue;}
        let real=source.canonicalize().map_err(io)?;
        if !real.starts_with(owned.canonicalize().map_err(io)?){continue;}
        let bytes=fs::read(real).map_err(io)?;
        let file=format!("{}.jsonl",uuid::Uuid::new_v4());
        fs::write(sidecar.join(&file),&bytes).map_err(io)?;
        files.push(json!({"sessionId":id,"file":file,"sha256":digest(&bytes)}));
    }
    let manifest=json!({"version":1,"databaseSha256":digest(&fs::read(backup).map_err(io)?),"files":files});
    fs::write(sidecar.join("manifest.json"),manifest.to_string()).map_err(io)?;
    Ok(())
}

/// Changes only the prepared database and creates fresh owned files. Existing
/// live files are never overwritten, even when restoring an older backup.
pub(crate) fn prepare(db: &Connection, root: &Path, backup: &Path) -> Result<()> {
    let sidecar=backup.with_extension("pi");
    let manifest=fs::read_to_string(sidecar.join("manifest.json")).ok().and_then(|s|serde_json::from_str::<Value>(&s).ok());
    if let Some(m)=&manifest {
        if m["version"]!=1 || m["databaseSha256"]!=digest(&fs::read(backup).map_err(io)?) {return Err(Error::Invalid("数据库和助手备份不匹配，尚未恢复存档".into()));}
    }
    for row in ws::rows(db,"SELECT id,session_file FROM pi_sessions WHERE session_file IS NOT NULL",&[])? {
        let id=ws::text(&row,"id");
        let entry=manifest.as_ref().and_then(|m|m["files"].as_array()).and_then(|v|v.iter().find(|v|v["sessionId"]==id));
        if let Some(entry)=entry {
            let file=ws::text(entry,"file");
            if file.contains(['/', '\\']) || !file.ends_with(".jsonl") || file.contains("..") {return Err(Error::Invalid("助手会话备份定位无效".into()));}
            let bytes=fs::read(sidecar.join(file)).map_err(io)?;
            if entry["sha256"]!=digest(&bytes){return Err(Error::Invalid("助手会话备份校验失败，尚未恢复存档".into()));}
            if id.contains(['/', '\\']) || id.contains("..") {return Err(Error::Invalid("助手会话标识无效".into()));}
            let directory=root.join("agent-sessions").join(id);
            fs::create_dir_all(&directory).map_err(io)?;
            let destination=directory.join(format!("restored-{}.jsonl",uuid::Uuid::new_v4()));
            fs::write(&destination,bytes).map_err(io)?;
            db.execute("UPDATE pi_sessions SET session_file=? WHERE id=?",params![destination.to_string_lossy(),id])?;
        }else{
            // Pre-sidecar/active backups retain readable history and drafts,
            // but cannot safely replay a different on-disk Pi transcript.
            db.execute("UPDATE pi_tasks SET metadata_json=json_set(metadata_json,'$.restoreContextMissing',json('true')) WHERE session_id=?",[id])?;
            db.execute("UPDATE pi_sessions SET session_file=NULL WHERE id=?",[id])?;
        }
    }
    Ok(())
}
