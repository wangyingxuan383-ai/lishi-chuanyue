//! Database backups own matching, immutable Pi files. An older database must
//! never reopen a live session file which has since gained different messages.
use crate::{agent_workspace as ws, Error, Result};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{collections::{HashMap, HashSet}, fs, io::{ErrorKind, Read}, path::Path};

fn io(_: std::io::Error) -> Error { Error::Invalid("助手会话备份文件未能校验，原存档保留".into()) }

fn digest(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(io)?;
    let mut hash = Sha256::new();
    let mut buffer = [0; 64 * 1024];
    loop {
        let count = file.read(&mut buffer).map_err(io)?;
        if count == 0 { break; }
        hash.update(&buffer[..count]);
    }
    Ok(format!("{:x}", hash.finalize()))
}

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
        let file=format!("{}.jsonl",uuid::Uuid::new_v4());
        let destination = sidecar.join(&file);
        fs::copy(real, &destination).map_err(io)?;
        files.push(json!({"sessionId":id,"file":file,"sha256":digest(&destination)?}));
    }
    let manifest=json!({"version":1,"databaseSha256":digest(backup)?,"files":files});
    fs::write(sidecar.join("manifest.json"),manifest.to_string()).map_err(io)?;
    Ok(())
}

/// Changes only the prepared database and creates fresh owned files. Existing
/// live files are never overwritten, even when restoring an older backup.
pub(crate) fn prepare(db: &Connection, root: &Path, backup: &Path) -> Result<()> {
    let sidecar=backup.with_extension("pi");
    let invalid = || Error::Invalid("助手备份清单无效，尚未恢复存档".into());
    let mut entries = HashMap::new();
    match fs::symlink_metadata(&sidecar) {
        Ok(metadata) if metadata.is_dir() => {
            let manifest: Value = serde_json::from_str(
                &fs::read_to_string(sidecar.join("manifest.json")).map_err(io)?,
            ).map_err(|_| invalid())?;
            if manifest["version"] != 1 || manifest["databaseSha256"] != digest(backup)? {
                return Err(Error::Invalid("数据库和助手备份不匹配，尚未恢复存档".into()));
            }
            let mut file_names = HashSet::new();
            for entry in manifest["files"].as_array().ok_or_else(invalid)? {
                let id = ws::text(entry, "sessionId");
                let file = ws::text(entry, "file");
                let sha = ws::text(entry, "sha256");
                if !safe_component(id) || !safe_component(file) || !file.ends_with(".jsonl")
                    || sha.len() != 64 || !sha.bytes().all(|b| b.is_ascii_hexdigit())
                    || !file_names.insert(file.to_ascii_lowercase())
                    || entries.insert(id.to_owned(), (file.to_owned(), sha.to_owned())).is_some()
                {
                    return Err(invalid());
                }
            }
        }
        // A backup from before the companion-file format has no directory.
        // An existing directory with a missing or broken manifest is damaged.
        Err(error) if error.kind() == ErrorKind::NotFound => {}
        Err(error) => return Err(io(error)),
        Ok(_) => return Err(invalid()),
    }
    let rows = ws::rows(db, "SELECT id FROM pi_sessions WHERE session_file IS NOT NULL", &[])?;
    let known = rows.iter().map(|row| ws::text(row, "id")).collect::<HashSet<_>>();
    if entries.keys().any(|id| !known.contains(id.as_str())) { return Err(invalid()); }
    let mut created = Vec::new();
    let result = (|| {
        for row in &rows {
            let id = ws::text(row, "id");
            if let Some((file, sha)) = entries.get(id) {
                let source = sidecar.join(file);
                if !fs::symlink_metadata(&source).map_err(io)?.is_file() { return Err(invalid()); }
                if *sha != digest(&source)? {
                    return Err(Error::Invalid("助手会话备份校验失败，尚未恢复存档".into()));
                }
                let directory = root.join("agent-sessions").join(id);
                fs::create_dir_all(&directory).map_err(io)?;
                let destination = directory.join(format!("restored-{}.jsonl", uuid::Uuid::new_v4()));
                let mut output = fs::OpenOptions::new().write(true).create_new(true).open(&destination).map_err(io)?;
                created.push(destination.clone());
                let mut input = fs::File::open(source).map_err(io)?;
                std::io::copy(&mut input, &mut output).map_err(io)?;
                db.execute(
                    "UPDATE pi_sessions SET session_file=? WHERE id=?",
                    params![destination.to_string_lossy(), id],
                )?;
            } else {
                // Old backups and sessions still active when backed up can
                // show saved history, but cannot replay a different Pi file.
                db.execute("UPDATE pi_tasks SET metadata_json=json_set(metadata_json,'$.restoreContextMissing',json('true')) WHERE session_id=?",[id])?;
                db.execute("UPDATE pi_sessions SET session_file=NULL WHERE id=?", [id])?;
            }
        }
        Ok(())
    })();
    if result.is_err() {
        for path in created { let _ = fs::remove_file(path); }
    }
    result
}

fn safe_component(value: &str) -> bool {
    !value.is_empty() && !value.contains(['/', '\\', ':']) && !value.contains("..")
        && value != "." && !value.ends_with(['.', ' ']) && !value.chars().any(char::is_control)
}
