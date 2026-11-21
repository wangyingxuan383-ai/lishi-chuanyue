use crate::{Error, Result, migration, pi_backup, sql::BackupInfo};
use chrono::{DateTime, NaiveDateTime, Utc};
use rusqlite::{Connection, OpenFlags};
use std::{collections::HashSet, fs::{self, File}, io, path::{Path, PathBuf}};
use zip::{CompressionMethod, ZipArchive, ZipWriter, write::SimpleFileOptions};

pub(crate) const KEEP: usize = 5;
const DATABASE: &str = "game.sqlite";

fn invalid() -> Error {
    Error::Invalid("备份无法读取或校验未通过".into())
}

fn io_error(_: io::Error) -> Error {
    Error::Invalid("备份文件操作失败".into())
}

fn zip_error(_: zip::result::ZipError) -> Error {
    invalid()
}

fn real_directory(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => Ok(true),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        _ => Err(invalid()),
    }
}

pub(crate) fn compressed(name: &str) -> bool {
    name.ends_with(".sqlite.zip")
}

fn backup_stem(stem: &str) -> bool {
    let Some((stamp, label)) = stem.split_once('-') else { return false };
    NaiveDateTime::parse_from_str(stamp, "%Y%m%dT%H%M%S%.fZ").is_ok()
        && (1..=40).contains(&label.len())
        && label.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_' || b == b'-')
}

pub(crate) fn valid_name(name: &str) -> bool {
    name.strip_suffix(".sqlite.zip").or_else(|| name.strip_suffix(".sqlite")).is_some_and(backup_stem)
}

/// All members are regular files with fixed names or the generated Pi filenames.
/// No archive path is used to choose an arbitrary destination.
fn read_archive(path: &Path, target: Option<&Path>) -> Result<()> {
    let mut archive = ZipArchive::new(File::open(path).map_err(io_error)?).map_err(zip_error)?;
    let mut names = HashSet::new();
    for index in 0..archive.len() {
        let mut entry = archive.by_index(index).map_err(zip_error)?;
        let name = entry.name().map_err(zip_error)?.into_owned();
        let output = if name == DATABASE {
            target.map(|directory| directory.join(DATABASE))
        } else if let Some(file) = name.strip_prefix("pi/") {
            let session = file.strip_suffix(".jsonl").is_some_and(|id| uuid::Uuid::parse_str(id).is_ok());
            if file != "manifest.json" && !session { return Err(invalid()); }
            target.map(|directory| directory.join(DATABASE).with_extension("pi").join(file))
        } else {
            return Err(invalid());
        };
        if !entry.is_file() || entry.is_symlink() || !names.insert(name) { return Err(invalid()); }
        let bytes = entry.size();
        let read = match output {
            Some(output) => {
                let mut file = File::options().write(true).create_new(true).open(output).map_err(io_error)?;
                io::copy(&mut entry, &mut file).map_err(io_error)?
            }
            None => io::copy(&mut entry, &mut io::sink()).map_err(io_error)?,
        };
        if read != bytes { return Err(invalid()); }
    }
    if !names.contains(DATABASE) || (names.len() > 1 && !names.contains("pi/manifest.json")) {
        return Err(invalid());
    }
    Ok(())
}

pub(crate) fn checked_version(connection: &Connection) -> Result<i64> {
    let check: String = connection.query_row("PRAGMA quick_check", [], |row| row.get(0))?;
    let version = migration::version(connection)?;
    if check != "ok" || version == 0 { return Err(invalid()); }
    Ok(version)
}

pub(crate) fn save(reader: &Connection, directory: &Path, label: &str, version: i64) -> Result<String> {
    if !real_directory(directory)? { fs::create_dir_all(directory).map_err(io_error)?; }
    let stage = tempfile::Builder::new().prefix(".backup-").tempdir_in(directory).map_err(io_error)?;
    let database = stage.path().join(DATABASE);
    reader.backup(rusqlite::MAIN_DB, &database, None)?;
    let saved = Connection::open_with_flags(&database, OpenFlags::SQLITE_OPEN_READ_ONLY)?;
    if checked_version(&saved)? != version { return Err(invalid()); }
    if version >= 8 {
        let root = directory.parent().ok_or_else(invalid)?;
        pi_backup::snapshot(&saved, root, &database)?;
    }
    drop(saved);

    let mut file = tempfile::NamedTempFile::new_in(directory).map_err(io_error)?;
    let mut zip = ZipWriter::new(file.as_file_mut());
    let options = SimpleFileOptions::default().compression_method(CompressionMethod::Deflated).large_file(true);
    zip.start_file(DATABASE, options).map_err(zip_error)?;
    io::copy(&mut File::open(&database).map_err(io_error)?, &mut zip).map_err(io_error)?;
    if version >= 8 {
        for entry in fs::read_dir(database.with_extension("pi")).map_err(io_error)? {
            let entry = entry.map_err(io_error)?;
            zip.start_file(format!("pi/{}", entry.file_name().to_string_lossy()), options).map_err(zip_error)?;
            io::copy(&mut File::open(entry.path()).map_err(io_error)?, &mut zip).map_err(io_error)?;
        }
    }
    zip.finish().map_err(zip_error)?;
    file.as_file().sync_all().map_err(io_error)?;
    read_archive(file.path(), None)?;
    let name = format!("{}-{label}.sqlite.zip", Utc::now().format("%Y%m%dT%H%M%S%.9fZ"));
    file.persist_noclobber(directory.join(&name)).map_err(|error| io_error(error.error))?;
    Ok(name)
}

pub(crate) fn materialize(directory: &Path, name: &str, stage: &Path) -> Result<PathBuf> {
    let path = directory.join(name);
    if !valid_name(name) || !real_directory(directory)? || !fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file()) {
        return Err(invalid());
    }
    if !compressed(name) { return Ok(path); }
    fs::create_dir(stage.join(DATABASE).with_extension("pi")).map_err(io_error)?;
    read_archive(&path, Some(stage))?;
    let database = stage.join(DATABASE);
    let sidecar = database.with_extension("pi");
    if !sidecar.join("manifest.json").exists() { fs::remove_dir(sidecar).map_err(io_error)?; }
    Ok(database)
}

fn entries(directory: &Path) -> Result<Vec<fs::DirEntry>> {
    if !real_directory(directory)? { return Ok(Vec::new()); }
    match fs::read_dir(directory) {
        Ok(entries) => entries.collect::<io::Result<_>>().map_err(io_error),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
        Err(error) => Err(io_error(error)),
    }
}

pub(crate) fn list(directory: &Path) -> Result<Vec<BackupInfo>> {
    let mut backups = Vec::new();
    for entry in entries(directory)? {
        let name = entry.file_name().to_string_lossy().into_owned();
        if !valid_name(&name) || !entry.file_type().map_err(io_error)?.is_file() { continue; }
        let meta = entry.metadata().map_err(io_error)?;
        let at: DateTime<Utc> = meta.modified().map_err(io_error)?.into();
        let mut size = meta.len();
        if !compressed(&name) {
            let sidecar = entry.path().with_extension("pi");
            if fs::symlink_metadata(&sidecar).is_ok_and(|meta| meta.is_dir()) {
                for companion in entries(&sidecar)? {
                    if companion.file_type().map_err(io_error)?.is_file() {
                        size += companion.metadata().map_err(io_error)?.len();
                    }
                }
            }
        }
        backups.push(BackupInfo { name, at: at.to_rfc3339(), size });
    }
    backups.sort_by(|a, b| b.name.cmp(&a.name));
    Ok(backups)
}

fn remove_sidecar(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) if meta.is_dir() => fs::remove_dir_all(path).map_err(io_error),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        _ => Err(invalid()),
    }
}

pub(crate) fn delete(directory: &Path, name: &str) -> Result<()> {
    if !valid_name(name) { return Err(invalid()); }
    if !real_directory(directory)? { return Ok(()); }
    let path = directory.join(name);
    match fs::symlink_metadata(&path) {
        Ok(meta) if meta.is_file() => {
            if !compressed(name) { remove_sidecar(&path.with_extension("pi"))?; }
            fs::remove_file(path).map_err(io_error)
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(()),
        _ => Err(invalid()),
    }
}

pub(crate) fn prune(directory: &Path) -> Result<()> {
    for backup in list(directory)?.into_iter().filter(|item| compressed(&item.name)).skip(KEEP) {
        delete(directory, &backup.name)?;
    }
    Ok(())
}

/// Only known legacy backup names are eligible. Leave unknown files and links in place.
pub(crate) fn clean_legacy(connection: &Connection, directory: &Path) -> Result<()> {
    let old = entries(directory)?.into_iter().filter_map(|entry| {
        let name = entry.file_name().to_string_lossy().into_owned();
        let eligible = name.strip_suffix(".sqlite").or_else(|| name.strip_suffix(".pi")).is_some_and(backup_stem);
        eligible.then_some((entry, name))
    }).collect::<Vec<_>>();
    if old.is_empty() { return Ok(()); }
    if checked_version(connection)? != migration::LATEST_VERSION { return Err(invalid()); }
    for (entry, name) in old {
        if name.ends_with(".pi") && fs::symlink_metadata(entry.path()).is_ok_and(|meta| meta.is_dir()) {
            remove_sidecar(&entry.path())?;
        } else if name.ends_with(".sqlite") && entry.file_type().map_err(io_error)?.is_file() {
            delete(directory, &name)?;
        }
    }
    Ok(())
}
