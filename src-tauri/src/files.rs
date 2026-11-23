use crate::error::{blocking, io_error, PlatformError, Result};
use base64::Engine;
use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, Mutex, OnceLock,
};
use tauri::AppHandle;
#[cfg(not(target_os = "android"))]
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_fs::FilePath;

const MAX_IMPORT: u64 = 64 * 1024 * 1024;
const ARCHIVE_LIMIT: &str = "完整存档超过当前64MiB导入上限，未写出不可导入的文件。";

struct CappedArchive<W> {
    inner: W,
    remaining: u64,
    exceeded: bool,
}

impl<W: Write> Write for CappedArchive<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if bytes.len() as u64 > self.remaining {
            self.exceeded = true;
            return Err(std::io::Error::other(ARCHIVE_LIMIT));
        }
        let written = self.inner.write(bytes)?;
        self.remaining -= written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> { self.inner.flush() }
}

#[derive(serde::Serialize)]
pub struct BookFile {
    name: String,
    data: String,
}
static BOOK_IMPORTS: OnceLock<Mutex<HashMap<String, Arc<AtomicBool>>>> = OnceLock::new();

#[tauri::command]
pub async fn file_grant_agent(app:AppHandle,store:tauri::State<'_,Arc<crate::sql::SqlStore>>,directory:bool,writable:bool)->Result<Option<serde_json::Value>> {
    let issued=store.generation();let owner=Arc::clone(store.inner());
    let store=store.shared();
    #[cfg(target_os="android")]
    let selected=crate::document_picker::pick_agent_grant(&app,directory,writable).await.map_err(|_|PlatformError::new("file_grant_unavailable","未能取得资料授权，请重新选择文件或目录"))?;
    #[cfg(not(target_os="android"))]
    let selected={let handle=app.clone();blocking(move||{
        let picked=if directory{handle.dialog().file().blocking_pick_folder()}else{handle.dialog().file().add_filter("资料",&["txt","md","json","epub","pdf","docx"]).blocking_pick_file()};
        Ok(picked.map(|file|{let name=match &file{FilePath::Path(path)=>path.file_name().and_then(|s|s.to_str()).unwrap_or("资料").to_owned(),_=>"资料".into()};(file,name,writable)}))
    }).await?};
    let Some((file,name,actual_writable))=selected else{return Ok(None);};
    let scope=match file{FilePath::Path(path)=>serde_json::json!({"path":path,"name":name,"directory":directory}),FilePath::Url(uri)=>serde_json::json!({"uri":uri.as_str(),"name":name,"directory":directory})};
    blocking(move||{
        if owner.generation()!=issued{return Err(PlatformError::new("file_grant_stale","选择资料期间存档已恢复，请重新选择"));}
        story_core::pi_documents::register(&store,&scope,actual_writable).map(Some).map_err(|_|PlatformError::new("file_grant_failed","资料授权未保存，请重新选择"))
    }).await
}
struct BookImport {
    id: String,
    cancelled: Arc<AtomicBool>,
}
impl BookImport {
    fn new(id: String) -> Self {
        let cancelled = Arc::new(AtomicBool::new(false));
        BOOK_IMPORTS
            .get_or_init(Default::default)
            .lock()
            .unwrap()
            .insert(id.clone(), cancelled.clone());
        Self { id, cancelled }
    }
    fn check(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            Err(PlatformError::new("book_cancelled", "已取消"))
        } else {
            Ok(())
        }
    }
}
impl Drop for BookImport {
    fn drop(&mut self) {
        if let Some(map) = BOOK_IMPORTS.get() {
            if let Ok(mut map) = map.lock() {
                map.remove(&self.id);
            }
        }
    }
}

#[tauri::command]
pub fn file_cancel_book(request_id: String) {
    if let Some(map) = BOOK_IMPORTS.get() {
        if let Ok(map) = map.lock() {
            if let Some(cancelled) = map.get(&request_id) {
                cancelled.store(true, Ordering::Relaxed);
            }
        }
    }
}

fn picked_file_name(selected: &FilePath, picked_name: Option<String>, fallback: &str) -> String {
    if let Some(name) = picked_name
        .map(|s| s.rsplit(['/', '\\']).next().unwrap_or("").trim().to_owned())
        .filter(|s| !s.is_empty() && s != "." && s != "..")
    {
        return name;
    }
    match selected {
        FilePath::Path(path) => path
            .file_name()
            .and_then(|n| n.to_str())
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(fallback)
            .to_owned(),
        FilePath::Url(_) => fallback.to_owned(),
    }
}

#[tauri::command]
pub async fn file_import_book(
    app: AppHandle,
    request_id: String,
    on_progress: tauri::ipc::Channel<u64>,
) -> Result<Option<BookFile>> {
    let operation = BookImport::new(request_id);
    #[cfg(target_os = "android")]
    let selected = crate::document_picker::pick_import(&app)
        .await
        .map_err(|_| io_error())?;
    #[cfg(not(target_os = "android"))]
    let selected = {
        let handle = app.clone();
        blocking(move || {
            Ok(handle
                .dialog()
                .file()
                .add_filter("书籍", &["txt", "epub", "pdf", "docx"])
                .blocking_pick_file()
                .map(|file| (file, None)))
        })
        .await?
    };
    let Some((selected, picked_name)) = selected else {
        return Ok(None);
    };
    blocking(move || {
        operation.check()?;
        let name = picked_file_name(&selected, picked_name, "参考书籍");
        let mut bytes = Vec::new();
        let mut file = open_file(&app, selected, "r")?;
        let mut buffer = [0u8; 65536];
        loop {
            operation.check()?;
            let count = file.read(&mut buffer).map_err(|_| io_error())?;
            if count == 0 {
                break;
            }
            bytes.extend_from_slice(&buffer[..count]);
            if bytes.len() as u64 > MAX_IMPORT {
                return Err(PlatformError::new("file_too_large", "文件超过 64 MiB"));
            }
            let _ = on_progress.send(bytes.len() as u64);
        }
        operation.check()?;
        Ok(Some(BookFile {
            name,
            data: base64::engine::general_purpose::STANDARD.encode(bytes),
        }))
    })
    .await
}

#[tauri::command]
pub async fn file_extract_pdf(data: String, request_id: String) -> Result<book_pdf::PdfText> {
    let operation = BookImport::new(request_id);
    blocking(move || {
        operation.check()?;
        if data.len() > 90 * 1024 * 1024 {
            return Err(PlatformError::new("file_too_large", "文件超过 64 MiB"));
        }
        let bytes = base64::engine::general_purpose::STANDARD
            .decode(data)
            .map_err(|_| io_error())?;
        let pages = book_pdf::extract_with_cancel(&bytes, || operation.cancelled.load(Ordering::Relaxed));
        operation.check()?;
        pages.map_err(|message| PlatformError::new("pdf_extract", message))
    })
    .await
}

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
        .map_err(|_| io_error())?
        .map(|(file, _)| file);
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
pub async fn file_import_skill(app: AppHandle) -> Result<Option<BookFile>> {
    #[cfg(target_os = "android")]
    let selected = crate::document_picker::pick_import(&app).await.map_err(|_|io_error())?;
    #[cfg(not(target_os = "android"))]
    let selected = {
        let handle=app.clone();
        blocking(move ||Ok(handle.dialog().file().add_filter("技能与工具包",&["zip","md","json","toolpkg"]).blocking_pick_file().map(|file|(file,None)))).await?
    };
    let Some((selected,picked_name))=selected else{return Ok(None);};
    blocking(move || {
        let name=picked_file_name(&selected,picked_name,"技能包");
        let mut bytes=Vec::new();open_file(&app,selected,"r")?.take(8*1024*1024+1).read_to_end(&mut bytes).map_err(|_|io_error())?;
        if bytes.len()>8*1024*1024{return Err(PlatformError::new("file_too_large","技能包最多8MiB"));}
        Ok(Some(BookFile{name,data:base64::engine::general_purpose::STANDARD.encode(bytes)}))
    }).await
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

/// Serialize a consistent native snapshot directly into an app-private file.
/// Only a small status or a structured error crosses the WebView boundary.
#[tauri::command]
pub async fn file_export_world(
    app:AppHandle,store:tauri::State<'_,Arc<crate::sql::SqlStore>>,world_id:String,suggested_name:String,
)->std::result::Result<bool,serde_json::Value>{
    use tauri::Manager;
    let failure=|phase:&str,message:String|serde_json::json!({"code":"archive_export_failed","phase":phase,"message":format!("{}：{}",match phase {"prepare"=>"准备存档失败","select"=>"未能选择保存位置",_=>"保存文件失败"},message)});
    let directory=app.path().app_cache_dir().map_err(|e|failure("prepare",e.to_string()))?.join("archive-export");
    let path=directory.join(format!("{}.json",uuid::Uuid::new_v4()));
    struct Temporary(std::path::PathBuf);
    impl Drop for Temporary{fn drop(&mut self){let _=std::fs::remove_file(&self.0);}}
    let snapshot=store.shared();let copy=path.clone();
    let temporary=tauri::async_runtime::spawn_blocking(move||->std::result::Result<Temporary,String>{
        std::fs::create_dir_all(directory).map_err(|e|e.to_string())?;
        let temporary=Temporary(copy);
        let file = std::fs::File::create(&temporary.0).map_err(|e| e.to_string())?;
        let mut writer = CappedArchive { inner: std::io::BufWriter::new(file), remaining: MAX_IMPORT, exceeded: false };
        let serialized = story_core::world_archive::export_to(&snapshot, &world_id, &mut writer);
        if writer.exceeded { return Err(ARCHIVE_LIMIT.into()); }
        serialized.map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())?;
        Ok(temporary)
    }).await.map_err(|e|failure("prepare",e.to_string()))?.map_err(|e|failure("prepare",e))?;
    // Keep the existing 64MiB import boundary symmetrical. Never report success
    // for an archive the application would reject when importing it again.
    if std::fs::metadata(&path).map_err(|e|failure("prepare",e.to_string()))?.len()>MAX_IMPORT{
        return Err(failure("prepare",ARCHIVE_LIMIT.into()));
    }
    #[cfg(target_os="android")]
    let selected=crate::document_picker::pick_export(&app,&suggested_name).await.map_err(|e|failure("select",e.to_string()))?;
    #[cfg(not(target_os="android"))]
    let selected={let handle=app.clone();blocking(move||Ok(handle.dialog().file().set_file_name(suggested_name).blocking_save_file())).await.map_err(|e|failure("select",e.message.into()))?};
    let Some(selected)=selected else{return Ok(false);};
    blocking(move||{let mut source=std::fs::File::open(&temporary.0).map_err(|_|io_error())?;let mut destination=open_file(&app,selected,"wt")?;std::io::copy(&mut source,&mut destination).map_err(|_|io_error())?;destination.flush().map_err(|_|io_error())?;Ok(true)}).await.map_err(|e|failure("write",e.message.into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn archive_serialization_never_writes_past_its_input_compatible_limit() {
        let mut writer = CappedArchive { inner: Vec::new(), remaining: 3, exceeded: false };
        writer.write_all(b"abc").unwrap();
        assert!(writer.write_all(b"d").is_err());
        assert_eq!(writer.inner, b"abc");
        assert!(writer.exceeded);
    }

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

    #[test]
    fn picked_file_name_preserves_android_and_desktop_extensions() {
        let content = FilePath::Url(tauri::Url::parse("content://example.documents/document/42").unwrap());
        assert_eq!(
            picked_file_name(&content, Some("三国演义.epub".into()), "参考书籍"),
            "三国演义.epub"
        );
        assert_eq!(
            picked_file_name(&content, Some("skill-pack.zip".into()), "技能包"),
            "skill-pack.zip"
        );
        assert_eq!(picked_file_name(&content, None, "参考书籍"), "参考书籍");
        assert_eq!(picked_file_name(&content, Some("   ".into()), "技能包"), "技能包");
        let desktop = FilePath::Path(std::path::PathBuf::from("archive/资治通鉴.pdf"));
        assert_eq!(picked_file_name(&desktop, None, "参考书籍"), "资治通鉴.pdf");
    }
}
