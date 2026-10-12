//! System-picker-only technical import/export. No frontend path or URI input.

use std::error::Error;
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;

use lishi_core::probe_pack::{
    copy_probe_pack, decode_probe_pack, encode_probe_pack, ProbePackError, MAX_PROBE_PACK_BYTES,
};
use serde::{Deserialize, Serialize};
use tauri::{AppHandle, Manager, Runtime, State};
use tauri_plugin_dialog::{DialogExt, FileDialogBuilder, PickerMode};
use tauri_plugin_fs::FilePath;
#[cfg(not(target_os = "android"))]
use tauri_plugin_fs::{FsExt, OpenOptions};
#[cfg(not(target_os = "android"))]
use tempfile::NamedTempFile;

const PACK_EXTENSION: &str = "lishi-probe";
const DEFAULT_FILE_NAME: &str = "历史穿越-技术探针.lishi-probe";
const FILE_WAIT_LIMIT: Duration = Duration::from_secs(30);

#[cfg(target_os = "android")]
#[path = "file_access_android.rs"]
mod android_access;

pub struct FileProbe {
    busy: AtomicBool,
    stage_directory: PathBuf,
}

struct FileLease(Arc<FileProbe>);

impl Drop for FileLease {
    fn drop(&mut self) {
        self.0.busy.store(false, Ordering::Release);
    }
}

impl FileProbe {
    fn acquire(self: &Arc<Self>) -> Result<FileLease, &'static str> {
        self.busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| "file_busy")?;
        Ok(FileLease(Arc::clone(self)))
    }
}

pub fn setup<R: Runtime>(app: &impl Manager<R>) -> Result<(), Box<dyn Error>> {
    let directory = app.path().app_data_dir()?.join("m01-import-stage");
    std::fs::create_dir_all(&directory)?;
    let metadata = std::fs::symlink_metadata(&directory)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() {
        return Err("file_unavailable".into());
    }
    cleanup_stages(&directory)?;
    app.manage(Arc::new(FileProbe {
        busy: AtomicBool::new(false),
        stage_directory: directory,
    }));
    Ok(())
}

fn cleanup_stages(directory: &Path) -> std::io::Result<()> {
    for entry in std::fs::read_dir(directory)? {
        let entry = entry?;
        let name = entry.file_name();
        if name
            .to_str()
            .is_some_and(|name| name.starts_with("m01-pack-") && name.ends_with(".tmp"))
            && entry.file_type()?.is_file()
        {
            // Only this probe's flat, private temporary files are removed.
            // Directories, symlinks and every differently named file are kept.
            std::fs::remove_file(entry.path())?;
        }
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
pub struct ExportProbePackRequest {
    text: String,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ExportStatus {
    Exported,
    Cancelled,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ImportStatus {
    Imported,
    Cancelled,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportProbePackReply {
    status: ExportStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ImportProbePackReply {
    status: ImportStatus,
    #[serde(skip_serializing_if = "Option::is_none")]
    file_name: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    note: Option<String>,
}

fn file_dialog(app: &AppHandle, title: &str) -> FileDialogBuilder<tauri::Wry> {
    let dialog = app
        .dialog()
        .file()
        .set_title(title)
        .set_picker_mode(PickerMode::Document)
        .add_filter("历史穿越技术探针", &[PACK_EXTENSION]);
    #[cfg(desktop)]
    let dialog = if let Some(window) = app.get_webview_window("main") {
        dialog.set_parent(&window)
    } else {
        dialog
    };
    dialog
}

fn display_file_name(path: &FilePath) -> Option<String> {
    // Document IDs in a content URI are not the provider's display filename.
    // Do not expose either an absolute private path or that URI to the frontend.
    match path {
        FilePath::Path(path) => path.file_name().map(|name| {
            name.to_string_lossy()
                .chars()
                .filter(|c| !c.is_control())
                .collect()
        }),
        FilePath::Url(_) => None,
    }
}

fn read_staged_note(source: impl Read, directory: &Path) -> Result<String, ProbePackError> {
    let mut stage = tempfile::Builder::new()
        .prefix("m01-pack-")
        .suffix(".tmp")
        .tempfile_in(directory)
        .map_err(|_| ProbePackError::Io)?;
    copy_probe_pack(source, stage.as_file_mut())?;
    stage
        .as_file_mut()
        .seek(SeekFrom::Start(0))
        .map_err(|_| ProbePackError::Io)?;
    let mut bytes = Vec::new();
    stage
        .as_file_mut()
        .take((MAX_PROBE_PACK_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| ProbePackError::Io)?;
    let note = decode_probe_pack(&bytes)?.note;
    // NamedTempFile removes its private stage on both success and failure.
    Ok(note)
}

#[cfg(not(target_os = "android"))]
fn write_desktop_pack(path: &Path, bytes: &[u8]) -> Result<(), &'static str> {
    if !path.extension().is_some_and(|extension| {
        extension
            .to_string_lossy()
            .eq_ignore_ascii_case(PACK_EXTENSION)
    }) {
        return Err("file_invalid_extension");
    }
    let parent = path.parent().ok_or("file_io_error")?;
    let mut stage = NamedTempFile::new_in(parent).map_err(|_| "file_io_error")?;
    stage.write_all(bytes).map_err(|_| "file_io_error")?;
    stage.as_file().sync_all().map_err(|_| "file_io_error")?;
    // The saved document is replaced only after the entire bounded pack exists.
    stage.persist(path).map_err(|_| "file_io_error")?;
    Ok(())
}

fn export_selected(app: &AppHandle, selected: FilePath, bytes: &[u8]) -> Result<(), &'static str> {
    #[cfg(target_os = "android")]
    {
        // SAF's ACTION_CREATE_DOCUMENT has already created/selected this document.
        // A provider can fail after writing some bytes. That is reported as an
        // unconfirmed/error result; no database or secret file is involved.
        if !matches!(&selected, FilePath::Url(uri) if uri.scheme() == "content") {
            return Err("file_unavailable");
        }
        let mut file = android_access::open_document(app, &selected, "wt")?;
        file.write_all(bytes).map_err(|_| "file_io_error")?;
        file.flush().map_err(|_| "file_io_error")?;
        if file.metadata().map_err(|_| "file_io_error")?.is_file() {
            file.sync_all().map_err(|_| "file_io_error")?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let path = selected.into_path().map_err(|_| "file_unavailable")?;
        write_desktop_pack(&path, bytes)
    }
}

fn import_selected(
    app: &AppHandle,
    selected: FilePath,
    directory: &Path,
) -> Result<String, &'static str> {
    #[cfg(target_os = "android")]
    if !matches!(&selected, FilePath::Url(uri) if uri.scheme() == "content") {
        return Err("file_unavailable");
    }
    #[cfg(not(target_os = "android"))]
    let source = {
        let mut options = OpenOptions::new();
        options.read(true);
        app.fs()
            .open(selected, options)
            .map_err(|_| "file_io_error")?
    };
    #[cfg(target_os = "android")]
    let source = android_access::open_document(app, &selected, "r")?;
    let metadata = source.metadata().map_err(|_| "file_io_error")?;
    #[cfg(not(target_os = "android"))]
    if !metadata.is_file() {
        return Err("file_io_error");
    }
    if metadata.len() > MAX_PROBE_PACK_BYTES as u64 {
        return Err("pack_too_large");
    }
    // The URI-backed descriptor is copied first. Only a private staged document
    // is parsed; neither this URI nor any picked path is passed to SQLite.
    read_staged_note(source, directory).map_err(ProbePackError::code)
}

async fn file_worker<T: Send + 'static>(
    lease: FileLease,
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
) -> Result<T, &'static str> {
    file_worker_with_timeout(lease, work, FILE_WAIT_LIMIT).await
}

async fn file_worker_with_timeout<T: Send + 'static>(
    lease: FileLease,
    work: impl FnOnce() -> Result<T, &'static str> + Send + 'static,
    wait_limit: Duration,
) -> Result<T, &'static str> {
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        work()
    });
    match tokio::time::timeout(wait_limit, &mut task).await {
        Ok(result) => result.map_err(|_| "file_unavailable")?,
        Err(_) => {
            // A running blocking I/O task cannot be cancelled by abort. Its
            // owned lease still prevents a second operation until it ends.
            task.abort();
            Err("file_unconfirmed")
        }
    }
}

#[tauri::command]
pub async fn export_probe_pack(
    app: AppHandle,
    probe: State<'_, Arc<FileProbe>>,
    request: ExportProbePackRequest,
) -> Result<ExportProbePackReply, &'static str> {
    let bytes = encode_probe_pack(&request.text).map_err(ProbePackError::code)?;
    let lease = probe.inner().acquire()?;
    let (sender, receiver) = tokio::sync::oneshot::channel();
    file_dialog(&app, "导出技术探针")
        .set_file_name(DEFAULT_FILE_NAME)
        .save_file(move |selected| {
            let _ = sender.send(selected);
        });
    let selected = receiver.await.map_err(|_| "file_unavailable")?;
    let Some(selected) = selected else {
        return Ok(ExportProbePackReply {
            status: ExportStatus::Cancelled,
            file_name: None,
        });
    };
    let file_name = display_file_name(&selected);
    file_worker(lease, move || export_selected(&app, selected, &bytes)).await?;
    Ok(ExportProbePackReply {
        status: ExportStatus::Exported,
        file_name,
    })
}

#[tauri::command]
pub async fn import_probe_pack(
    app: AppHandle,
    probe: State<'_, Arc<FileProbe>>,
) -> Result<ImportProbePackReply, &'static str> {
    let lease = probe.inner().acquire()?;
    let directory = probe.stage_directory.clone();
    let (sender, receiver) = tokio::sync::oneshot::channel();
    file_dialog(&app, "导入技术探针").pick_file(move |selected| {
        let _ = sender.send(selected);
    });
    let selected = receiver.await.map_err(|_| "file_unavailable")?;
    let Some(selected) = selected else {
        return Ok(ImportProbePackReply {
            status: ImportStatus::Cancelled,
            file_name: None,
            note: None,
        });
    };
    let file_name = display_file_name(&selected);
    let note = file_worker(lease, move || import_selected(&app, selected, &directory)).await?;
    Ok(ImportProbePackReply {
        status: ImportStatus::Imported,
        file_name,
        note: Some(note),
    })
}

#[cfg(test)]
mod tests {
    use std::io;

    use super::*;

    #[test]
    fn import_stage_is_removed_on_success_damage_oversize_and_revocation() {
        let directory = tempfile::tempdir().unwrap();
        let bytes = encode_probe_pack("导入预览🙂\n不覆盖原笔记").unwrap();
        assert_eq!(
            read_staged_note(bytes.as_slice(), directory.path()).unwrap(),
            "导入预览🙂\n不覆盖原笔记"
        );
        assert_eq!(
            read_staged_note(b"broken".as_slice(), directory.path()),
            Err(ProbePackError::Invalid)
        );
        assert_eq!(
            read_staged_note(io::repeat(0), directory.path()),
            Err(ProbePackError::TooLarge)
        );
        struct Revoked;
        impl Read for Revoked {
            fn read(&mut self, _: &mut [u8]) -> io::Result<usize> {
                Err(io::Error::from(io::ErrorKind::PermissionDenied))
            }
        }
        assert_eq!(
            read_staged_note(Revoked, directory.path()),
            Err(ProbePackError::Io)
        );
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 0);
    }

    #[test]
    fn file_operation_lease_is_owned_and_excludes_queued_work() {
        let directory = tempfile::tempdir().unwrap();
        let probe = Arc::new(FileProbe {
            busy: AtomicBool::new(false),
            stage_directory: directory.path().to_owned(),
        });
        let lease = probe.acquire().unwrap();
        assert!(matches!(probe.acquire(), Err("file_busy")));
        drop(lease);
        let _lease = probe.acquire().unwrap();
    }

    #[tokio::test]
    async fn timed_out_running_worker_keeps_lease_until_it_really_finishes() {
        let directory = tempfile::tempdir().unwrap();
        let probe = Arc::new(FileProbe {
            busy: AtomicBool::new(false),
            stage_directory: directory.path().to_owned(),
        });
        let lease = probe.acquire().unwrap();
        let (started_sender, started_receiver) = std::sync::mpsc::channel();
        let (release_sender, release_receiver) = std::sync::mpsc::channel();
        let result = file_worker_with_timeout(
            lease,
            move || {
                let _ = started_sender.send(());
                let _ = release_receiver.recv_timeout(Duration::from_secs(2));
                Ok(())
            },
            Duration::from_millis(30),
        )
        .await;
        assert_eq!(result, Err("file_unconfirmed"));
        started_receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap();
        assert!(matches!(probe.acquire(), Err("file_busy")));
        release_sender.send(()).unwrap();
        let mut released = false;
        for _ in 0..20 {
            if let Ok(lease) = probe.acquire() {
                drop(lease);
                released = true;
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }
        assert!(released);
    }

    #[test]
    fn startup_cleanup_removes_only_owned_flat_stage_files() {
        let directory = tempfile::tempdir().unwrap();
        std::fs::write(directory.path().join("m01-pack-abcd.tmp"), b"interrupted").unwrap();
        std::fs::write(directory.path().join("other.tmp"), b"preserve").unwrap();
        std::fs::create_dir(directory.path().join("m01-pack-directory.tmp")).unwrap();
        cleanup_stages(directory.path()).unwrap();
        assert!(!directory.path().join("m01-pack-abcd.tmp").exists());
        assert_eq!(
            std::fs::read(directory.path().join("other.tmp")).unwrap(),
            b"preserve"
        );
        assert!(directory.path().join("m01-pack-directory.tmp").is_dir());
    }

    #[cfg(not(target_os = "android"))]
    #[test]
    fn desktop_export_replaces_only_requested_probe_file_and_preserves_on_invalid_extension() {
        let directory = tempfile::tempdir().unwrap();
        let path = directory.path().join("中文🙂.lishi-probe");
        let bytes = encode_probe_pack("新文本").unwrap();
        std::fs::write(&path, b"old").unwrap();
        write_desktop_pack(&path, &bytes).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        let protected = directory.path().join("m01-probe.sqlite");
        std::fs::write(&protected, b"preserve").unwrap();
        assert_eq!(
            write_desktop_pack(&protected, &bytes),
            Err("file_invalid_extension")
        );
        assert_eq!(std::fs::read(&protected).unwrap(), b"preserve");
        assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
    }
}
