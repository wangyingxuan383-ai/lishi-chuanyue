//! In-app update (R14): downloads a release package with resume and SHA-256
//! verification, then hands it to the system installer (Android). The page
//! supplies the release's asset URL, size and hash; this side decides which
//! hosts may be fetched and checks every byte before anything is installed.
mod download;
#[cfg(test)]
mod tests;

use crate::error::{blocking, PlatformError, Result};
use download::{Asset, Check, Event, Failure, Tuning};
use serde::{Deserialize, Serialize};
use std::{
    cmp::Ordering,
    path::{Path, PathBuf},
    sync::{Arc, Mutex, RwLock},
    time::Duration,
};
use tauri::{
    ipc::Channel,
    plugin::{Builder, TauriPlugin},
    AppHandle, Runtime, State,
};
use tokio_util::sync::CancellationToken;

#[cfg(target_os = "android")]
use tauri::{plugin::PluginHandle, Manager};

const MAX_PACKAGE: u64 = 512 * 1024 * 1024;
const MAX_TEXT: usize = 64 * 1024;
const MAX_DEV_GET: usize = 1024 * 1024;

/// The update folder in the app's cache (Android: `getCacheDir()/updates`,
/// which the FileProvider shares with the installer) and the one running download.
pub struct Updates {
    dir: PathBuf,
    dev_file: PathBuf,
    active: Mutex<Option<CancellationToken>>,
}

/// Holds the single download slot until the download ends.
struct Running {
    updates: Arc<Updates>,
    token: CancellationToken,
}

impl Drop for Running {
    fn drop(&mut self) {
        *self
            .updates
            .active
            .lock()
            .unwrap_or_else(|e| e.into_inner()) = None;
    }
}

impl Updates {
    pub fn new(cache: &Path, data: &Path) -> Arc<Self> {
        Arc::new(Self {
            dir: cache.join("updates"),
            dev_file: data.join("update-dev-source.txt"),
            active: Mutex::new(None),
        })
    }

    /// Off the startup path: remove packages that are not newer than this
    /// build (already installed, or abandoned), and load the test source.
    pub fn housekeeping(self: &Arc<Self>) {
        let updates = Arc::clone(self);
        std::thread::spawn(move || {
            tidy(&updates.dir, env!("CARGO_PKG_VERSION"), None);
            if cfg!(debug_assertions) {
                let saved = std::fs::read_to_string(&updates.dev_file).ok();
                *DEV_SOURCE.write().unwrap_or_else(|e| e.into_inner()) =
                    saved.as_deref().and_then(normalize_dev_source);
            }
        });
    }

    fn package(&self, version: &str) -> PathBuf {
        self.dir.join(format!("{version}.apk"))
    }

    fn begin(self: &Arc<Self>) -> Result<Running> {
        let mut active = self.active.lock().unwrap_or_else(|e| e.into_inner());
        if active.is_some() {
            return Err(PlatformError::new("update_busy", "已经在下载了"));
        }
        let token = CancellationToken::new();
        *active = Some(token.clone());
        Ok(Running {
            updates: Arc::clone(self),
            token,
        })
    }
}

// ---------- versions (SemVer precedence, as in src/ui/app/update.ts) ----------

#[derive(Debug)]
pub struct Version {
    core: [String; 3],
    pre: Vec<String>,
}

fn identifier(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-')
}

fn numeric(part: &str) -> bool {
    !part.is_empty() && part.bytes().all(|b| b.is_ascii_digit())
}

/// `1.2.3`, `1.2.3-rc.1`, `1.2.3+build` (no `v` prefix); at most 64 characters,
/// so a valid version is also a safe file name.
pub fn parse_version(raw: &str) -> Option<Version> {
    if raw.len() > 64 {
        return None;
    }
    let (main, build) = match raw.split_once('+') {
        Some((main, build)) => (main, Some(build)),
        None => (raw, None),
    };
    if build.is_some_and(|build| !build.split('.').all(identifier)) {
        return None;
    }
    let (core, pre) = match main.split_once('-') {
        Some((core, pre)) => (core, Some(pre)),
        None => (main, None),
    };
    let parts: Vec<&str> = core.split('.').collect();
    if parts.len() != 3
        || !parts
            .iter()
            .all(|part| numeric(part) && (part.len() == 1 || !part.starts_with('0')))
    {
        return None;
    }
    let pre: Vec<String> = match pre {
        None => Vec::new(),
        Some(pre) => {
            let ids: Vec<&str> = pre.split('.').collect();
            if !ids
                .iter()
                .all(|id| identifier(id) && !(numeric(id) && id.len() > 1 && id.starts_with('0')))
            {
                return None;
            }
            ids.into_iter().map(String::from).collect()
        }
    };
    Some(Version {
        core: [parts[0].into(), parts[1].into(), parts[2].into()],
        pre,
    })
}

fn compare_number(a: &str, b: &str) -> Ordering {
    a.len().cmp(&b.len()).then_with(|| a.cmp(b))
}

pub fn compare(a: &Version, b: &Version) -> Ordering {
    for (x, y) in a.core.iter().zip(&b.core) {
        let order = compare_number(x, y);
        if order.is_ne() {
            return order;
        }
    }
    match (a.pre.is_empty(), b.pre.is_empty()) {
        (true, true) => return Ordering::Equal,
        (true, false) => return Ordering::Greater,
        (false, true) => return Ordering::Less,
        (false, false) => {}
    }
    for (x, y) in a.pre.iter().zip(&b.pre) {
        let order = match (numeric(x), numeric(y)) {
            (true, true) => compare_number(x, y),
            (true, false) => Ordering::Less,
            (false, true) => Ordering::Greater,
            (false, false) => x.cmp(y),
        };
        if order.is_ne() {
            return order;
        }
    }
    a.pre.len().cmp(&b.pre.len())
}

/// Only a release newer than this build may be downloaded or installed.
fn newer_version(raw: &str) -> Result<String> {
    let current = parse_version(env!("CARGO_PKG_VERSION")).expect("package version");
    match parse_version(raw) {
        Some(version) if compare(&version, &current).is_gt() => Ok(raw.to_owned()),
        _ => Err(PlatformError::new("update_version", "这个版本不比现在的新")),
    }
}

/// Keeps only packages newer than `current` (and, with `keep`, only that
/// version's files). Anything else in the folder is removed.
pub fn tidy(dir: &Path, current: &str, keep: Option<&str>) {
    let Some(current) = parse_version(current) else {
        return;
    };
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().into_owned();
        let version = [".apk.part.json", ".apk.part", ".apk"]
            .iter()
            .find_map(|suffix| name.strip_suffix(suffix));
        let wanted = version.is_some_and(|version| {
            keep.is_none_or(|keep| keep == version)
                && parse_version(version).is_some_and(|v| compare(&v, &current).is_gt())
        });
        if !wanted {
            let path = entry.path();
            if path.is_dir() {
                let _ = std::fs::remove_dir_all(path);
            } else {
                let _ = std::fs::remove_file(path);
            }
        }
    }
}

// ---------- a local test server instead of GitHub (debug builds only) ----------

static DEV_SOURCE: RwLock<Option<String>> = RwLock::new(None);

/// `http://127.0.0.1:<port>` or `http://localhost:<port>`, nothing else.
fn normalize_dev_source(raw: &str) -> Option<String> {
    let raw = raw.trim();
    if !download::is_loopback(raw) {
        return None;
    }
    let url = reqwest::Url::parse(raw).ok()?;
    if url.path() != "/" || url.query().is_some() || url.fragment().is_some() {
        return None;
    }
    Some(format!("http://{}:{}", url.host_str()?, url.port()?))
}

/// The local test server's copy of the release list, when a debug build has one set.
pub fn dev_release_url(url: &str) -> Option<String> {
    if !cfg!(debug_assertions) || !crate::link_policy::allowed(url, true) {
        return None;
    }
    let source = DEV_SOURCE
        .read()
        .unwrap_or_else(|e| e.into_inner())
        .clone()?;
    let parsed = reqwest::Url::parse(url).ok()?;
    let query = parsed.query().map(|q| format!("?{q}")).unwrap_or_default();
    Some(format!("{source}{}{query}", parsed.path()))
}

/// The release list from the test server (debug builds; loopback only).
pub async fn dev_get(url: &str, timeout_ms: u64) -> Result<crate::stream::GetResponse> {
    let failed = || PlatformError::new("llm_network", "网络请求失败");
    if !download::is_loopback(url) {
        return Err(failed());
    }
    let client = crate::stream::client().map_err(|_| failed())?;
    let run = async {
        let response = client.get(url).send().await.ok()?;
        let status = response.status().as_u16();
        let bytes = response.bytes().await.ok()?;
        let body = String::from_utf8_lossy(&bytes[..bytes.len().min(MAX_DEV_GET)]).into_owned();
        Some(crate::stream::GetResponse { status, body })
    };
    match tokio::time::timeout(Duration::from_millis(timeout_ms), run).await {
        Ok(Some(response)) => Ok(response),
        Ok(None) => Err(failed()),
        Err(_) => Err(PlatformError::new("llm_timeout", "请求超时")),
    }
}

// ---------- commands ----------

fn failure(failure: Failure) -> PlatformError {
    match failure {
        Failure::Url => PlatformError::new("update_url", "只能从本应用的发布页下载"),
        Failure::Http => PlatformError::new("update_http", "下载地址打不开"),
        Failure::Network => PlatformError::new("update_network", "网络中断了，已下载的部分会保留"),
        Failure::Size => PlatformError::new("update_size", "文件大小和发布信息不一致，已删除"),
        Failure::Hash => PlatformError::new("update_hash", "安装包校验没通过，已删除"),
        Failure::Storage => PlatformError::new("update_storage", "存储空间不足或写入失败"),
        Failure::Cancelled => PlatformError::new("update_cancelled", "下载已暂停"),
    }
}

fn bad_request() -> PlatformError {
    PlatformError::new("update_request", "更新信息不完整")
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DownloadRequest {
    version: String,
    url: String,
    size: u64,
    sha256: String,
}

/// Resolves once `<version>.apk` holds exactly the published bytes.
#[tauri::command]
async fn download(
    updates: State<'_, Arc<Updates>>,
    request: DownloadRequest,
    on_event: Channel<Event>,
) -> Result<()> {
    let version = newer_version(&request.version)?;
    let sha256 = download::parse_sha256(&request.sha256).ok_or_else(bad_request)?;
    if request.size == 0 || request.size > MAX_PACKAGE {
        return Err(bad_request());
    }
    let loopback = cfg!(debug_assertions);
    if !download::allowed(&request.url, false, loopback) {
        return Err(failure(Failure::Url));
    }
    let running = updates.begin()?;
    let dir = updates.dir.clone();
    let keep = version.clone();
    blocking(move || {
        std::fs::create_dir_all(&dir).map_err(|_| failure(Failure::Storage))?;
        // Only one release is kept: an older, never-installed download goes now.
        tidy(&dir, env!("CARGO_PKG_VERSION"), Some(&keep));
        Ok(())
    })
    .await?;
    let file = updates.package(&version);
    let asset = Asset {
        url: &request.url,
        size: request.size,
        sha256,
    };
    let sink = move |event: Event| {
        let _ = on_event.send(event);
    };
    download::fetch(
        &asset,
        &file,
        &|| crate::stream::client().ok(),
        &Tuning::app(loopback),
        &running.token,
        &sink,
    )
    .await
    .map_err(failure)
}

/// Pauses the running download; its bytes stay for the next try.
#[tauri::command]
fn cancel(updates: State<'_, Arc<Updates>>) {
    if let Some(token) = updates
        .active
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .as_ref()
    {
        token.cancel();
    }
}

/// A release's SHA256SUMS.txt (the fallback when an asset has no digest).
#[tauri::command]
async fn fetch_text(url: String) -> Result<String> {
    let client = crate::stream::client().map_err(|_| failure(Failure::Network))?;
    let tuning = Tuning {
        headers: Duration::from_secs(20),
        idle: Duration::from_secs(20),
        ..Tuning::app(cfg!(debug_assertions))
    };
    let bytes = download::fetch_small(&url, &client, &tuning, MAX_TEXT)
        .await
        .map_err(failure)?;
    String::from_utf8(bytes).map_err(|_| PlatformError::new("update_text", "校验文件不是文本"))
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
enum InstallStatus {
    /// The system installer is open.
    Started,
    /// The player must allow 安装未知应用 first; the settings page is open.
    Permission,
    /// Not on this platform.
    Unsupported,
}

#[derive(Serialize, Deserialize)]
struct InstallReply {
    status: InstallStatus,
}

/// Checks the package again, then opens the system installer for it.
#[tauri::command]
async fn install<R: Runtime>(
    app: AppHandle<R>,
    updates: State<'_, Arc<Updates>>,
    version: String,
    size: u64,
    sha256: String,
) -> Result<InstallReply> {
    let version = newer_version(&version)?;
    let sha256 = download::parse_sha256(&sha256).ok_or_else(bad_request)?;
    let file = updates.package(&version);
    match download::verify(&file, size, &sha256).await {
        Check::Matches => {}
        Check::Missing => {
            return Err(PlatformError::new(
                "update_missing",
                "安装包不见了，请重新下载",
            ))
        }
        Check::Differs => {
            let _ = tokio::fs::remove_file(&file).await;
            return Err(failure(Failure::Hash));
        }
    }
    #[cfg(target_os = "android")]
    {
        app.state::<AndroidUpdates<R>>()
            .0
            .run_mobile_plugin_async::<InstallReply>(
                "installPackage",
                serde_json::json!({ "path": file.to_string_lossy() }),
            )
            .await
            .map_err(|_| PlatformError::new("update_install", "没能打开系统安装界面"))
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = (app, file);
        Ok(InstallReply {
            status: InstallStatus::Unsupported,
        })
    }
}

/// Android: may this app install packages yet (安装未知应用)? Elsewhere false.
#[tauri::command]
async fn can_install<R: Runtime>(app: AppHandle<R>) -> Result<bool> {
    #[cfg(target_os = "android")]
    {
        #[derive(Deserialize)]
        struct Reply {
            allowed: bool,
        }
        let reply: Reply = app
            .state::<AndroidUpdates<R>>()
            .0
            .run_mobile_plugin_async("canInstallPackages", serde_json::json!({}))
            .await
            .map_err(|_| PlatformError::new("update_install", "没能读取安装权限"))?;
        Ok(reply.allowed)
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        Ok(false)
    }
}

#[derive(Serialize)]
struct DevSource {
    available: bool,
    url: Option<String>,
}

#[tauri::command]
fn dev_source() -> DevSource {
    DevSource {
        available: cfg!(debug_assertions),
        url: DEV_SOURCE.read().unwrap_or_else(|e| e.into_inner()).clone(),
    }
}

/// Debug builds: read releases from a local test server (null clears).
#[tauri::command]
async fn set_dev_source(updates: State<'_, Arc<Updates>>, url: Option<String>) -> Result<()> {
    if !cfg!(debug_assertions) {
        return Err(PlatformError::new(
            "update_dev_only",
            "只有调试版可以设置测试更新源",
        ));
    }
    let source = match url.as_deref().map(str::trim) {
        None | Some("") => None,
        Some(raw) => Some(normalize_dev_source(raw).ok_or_else(|| {
            PlatformError::new("update_dev_source", "要写成 http://127.0.0.1:端口")
        })?),
    };
    let file = updates.dev_file.clone();
    let saved = source.clone();
    blocking(move || {
        match &saved {
            Some(url) => std::fs::write(&file, url),
            None => match std::fs::remove_file(&file) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
                other => other,
            },
        }
        .map_err(|_| crate::error::io_error())
    })
    .await?;
    *DEV_SOURCE.write().unwrap_or_else(|e| e.into_inner()) = source;
    Ok(())
}

#[cfg(target_os = "android")]
struct AndroidUpdates<R: Runtime>(PluginHandle<R>);

pub fn init<R: Runtime>() -> TauriPlugin<R> {
    Builder::new("updates")
        .invoke_handler(tauri::generate_handler![
            download,
            cancel,
            fetch_text,
            install,
            can_install,
            dev_source,
            set_dev_source
        ])
        .setup(|app, api| {
            #[cfg(target_os = "android")]
            app.manage(AndroidUpdates(
                api.register_android_plugin("io.timejump.chuanyue", "UpdatePlugin")?,
            ));
            #[cfg(not(target_os = "android"))]
            let _ = (app, api);
            Ok(())
        })
        .build()
}
