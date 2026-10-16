use crate::error::{blocking, io_error, PlatformError, Result};
use std::io::{Read, Write};
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FilePath;

const MAX_IMPORT: u64 = 64 * 1024 * 1024;

fn read_text(file: impl Read) -> Result<String> {
    let mut bytes = Vec::new();
    file.take(MAX_IMPORT + 1)
        .read_to_end(&mut bytes)
        .map_err(|_| io_error())?;
    if bytes.len() as u64 > MAX_IMPORT {
        return Err(PlatformError::new("file_too_large", "文件超过 64 MiB"));
    }
    String::from_utf8(bytes)
        .map_err(|_| PlatformError::new("file_not_utf8", "文件不是有效的 UTF-8 文本"))
}

fn open_file(app: &AppHandle, selected: FilePath, mode: &str) -> Result<std::fs::File> {
    #[cfg(target_os = "android")]
    {
        crate::file_access_android::open_document(app, &selected, mode).map_err(|_| io_error())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let path = selected.into_path().map_err(|_| io_error())?;
        match mode {
            "r" => std::fs::File::open(path),
            _ => std::fs::File::create(path),
        }
        .map_err(|_| io_error())
    }
}

#[tauri::command]
pub async fn file_import_text(app: AppHandle) -> Result<Option<String>> {
    #[cfg(target_os = "android")]
    let selected = crate::document_picker::pick_import(&app)
        .await
        .map_err(|_| io_error())?;
    #[cfg(not(target_os = "android"))]
    let selected = {
        let handle = app.clone();
        blocking(move || Ok(handle.dialog().file().blocking_pick_file())).await?
    };
    let Some(selected) = selected else {
        return Ok(None);
    };
    blocking(move || read_text(open_file(&app, selected, "r")?).map(Some)).await
}

#[tauri::command]
pub async fn file_export_text(
    app: AppHandle,
    suggested_name: String,
    text: String,
) -> Result<bool> {
    #[cfg(target_os = "android")]
    let selected = crate::document_picker::pick_export(&app, &suggested_name)
        .await
        .map_err(|_| io_error())?;
    #[cfg(not(target_os = "android"))]
    let selected = {
        let handle = app.clone();
        blocking(move || {
            Ok(handle
                .dialog()
                .file()
                .set_file_name(suggested_name)
                .blocking_save_file())
        })
        .await?
    };
    let Some(selected) = selected else {
        return Ok(false);
    };
    blocking(move || {
        let mut file = open_file(&app, selected, "wt")?;
        file.write_all(text.as_bytes()).map_err(|_| io_error())?;
        file.flush().map_err(|_| io_error())?;
        Ok(true)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn import_checks_utf8_and_size() {
        assert_eq!(read_text("中文".as_bytes()).unwrap(), "中文");
        assert_eq!(read_text(&b"\xff"[..]).unwrap_err().code, "file_not_utf8");
        assert_eq!(
            read_text(std::io::repeat(b'a').take(MAX_IMPORT + 1))
                .unwrap_err()
                .code,
            "file_too_large"
        );
    }
}
