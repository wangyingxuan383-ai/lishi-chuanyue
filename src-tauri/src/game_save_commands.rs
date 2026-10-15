//! Private staging, consistent snapshots and one-directory import publication.
//! JS receives neither native paths nor Android document URIs.
use super::{ActiveTurn, GameCommandError, GameService, StoreRoute, WorldReply};
use lishi_core::{
    game_annotations::AnnotationStore,
    game_research_store::{ResearchStore, WorldResearchBundle},
    timejump_pack::{self, PackEntryName, PackLimits, PackMetadata, PackSource},
    CancellationToken,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::Arc,
    time::{SystemTime, UNIX_EPOCH},
};
use tauri::{AppHandle, Manager};
use tauri_plugin_dialog::{DialogExt, PickerMode};
use tauri_plugin_fs::FilePath;
#[cfg(target_os = "android")]
#[path = "file_access_android.rs"]
mod android_access;

const MAX_RESEARCH_JSON: u64 = 64 * 1024 * 1024;
fn error(code: impl Into<String>) -> GameCommandError {
    GameCommandError::new(code)
}
fn io_error(_: impl std::fmt::Display) -> GameCommandError {
    error("save_io")
}
fn data_error(_: impl std::fmt::Display) -> GameCommandError {
    error("save_invalid")
}
fn stamp() -> Result<i64, GameCommandError> {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(io_error)?
        .as_millis()
        .try_into()
        .map_err(io_error)
}
pub(super) fn stem(id: &str) -> String {
    format!("{:x}", Sha256::digest(id.as_bytes()))
}
fn regular(path: &Path) -> bool {
    fs::symlink_metadata(path)
        .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink() && !reparse(&m))
}
fn reparse(metadata: &fs::Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        metadata.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        let _ = metadata;
        false
    }
}
pub(super) fn ensure_private_directory(path: &Path) -> Result<(), GameCommandError> {
    fs::create_dir_all(path).map_err(io_error)?;
    let metadata = fs::symlink_metadata(path).map_err(io_error)?;
    if !metadata.is_dir() || metadata.file_type().is_symlink() || reparse(&metadata) {
        return Err(error("save_invalid_path"));
    }
    Ok(())
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ImportReceipt {
    version: u32,
    world_id: String,
    schema_version: u32,
    imported_at_ms: i64,
}
fn imported_directory(
    service: &GameService,
    id: &str,
) -> Result<Option<PathBuf>, GameCommandError> {
    let path = service.imports.join(stem(id));
    if !path.exists() {
        return Ok(None);
    }
    ensure_private_directory(&path)?;
    let receipt_path = path.join("import.json");
    if !regular(&receipt_path) {
        return Err(error("save_invalid"));
    }
    let bytes = read_small(&receipt_path, 4096)?;
    let receipt: ImportReceipt = serde_json::from_slice(&bytes).map_err(data_error)?;
    if receipt.version != 1
        || receipt.world_id != id
        || !matches!(receipt.schema_version, 1..=3)
        || receipt.imported_at_ms < 0
    {
        return Err(error("save_invalid"));
    }
    if !regular(&path.join("world.sqlite")) {
        return Err(error("save_invalid"));
    }
    Ok(Some(path))
}
impl GameService {
    pub(super) fn world_path(&self, id: &str) -> Result<PathBuf, GameCommandError> {
        if !lishi_core::game_store::valid_game_id(id) {
            return Err(error("game_invalid_request"));
        }
        let original = self.worlds.join(super::world_file_name(id));
        let imported = imported_directory(self, id)?;
        if original.exists() && imported.is_some() {
            return Err(error("save_duplicate"));
        }
        Ok(imported.map_or(original, |d| d.join("world.sqlite")))
    }
    pub(super) fn memory_path(&self, id: &str) -> Result<PathBuf, GameCommandError> {
        Ok(imported_directory(self, id)?
            .map_or_else(|| self.memory_directory.clone(), |d| d.join("memory")))
    }
    pub(super) fn evidence_for_world(
        &self,
        id: &str,
    ) -> Result<Arc<ResearchStore>, GameCommandError> {
        let Some(directory) = imported_directory(self, id)? else {
            return self.research();
        };
        let mut stores = self.world_research.lock().map_err(io_error)?;
        if let Some(store) = stores.get(id) {
            return Ok(Arc::clone(store));
        }
        let store = Arc::new(
            ResearchStore::open_sidecar(directory.join("research.sqlite")).map_err(data_error)?,
        );
        stores.insert(id.into(), Arc::clone(&store));
        Ok(store)
    }
}
pub(super) fn imported_metadata(
    service: &GameService,
) -> Result<(Vec<lishi_core::game_inspection::WorldMetadata>, u64), GameCommandError> {
    let mut result = Vec::new();
    let mut unavailable = 0;
    for entry in fs::read_dir(&service.imports).map_err(io_error)?.take(1024) {
        let entry = match entry {
            Ok(value) => value,
            Err(_) => {
                unavailable += 1;
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        if name.len() != 64 || !name.bytes().all(|v| v.is_ascii_hexdigit()) {
            continue;
        }
        let path = entry.path();
        let candidate = (|| {
            ensure_private_directory(&path)?;
            let metadata = lishi_core::game_inspection::inspect_world(path.join("world.sqlite"))?;
            if stem(&metadata.setup.world_id) != name
                || imported_directory(service, &metadata.setup.world_id)?.as_ref() != Some(&path)
            {
                return Err(error("save_invalid"));
            }
            Ok(metadata)
        })();
        match candidate {
            Ok(metadata) => result.push(metadata),
            Err(_) => unavailable += 1,
        }
    }
    Ok((result, unavailable))
}
struct LibraryLease {
    service: Arc<GameService>,
    id: String,
    cancel: CancellationToken,
}
impl LibraryLease {
    fn acquire(service: Arc<GameService>, id: &str) -> Result<Self, GameCommandError> {
        if !lishi_core::game_store::valid_game_id(id) {
            return Err(error("game_invalid_request"));
        }
        let cancel = CancellationToken::new();
        {
            let mut active = service.active.lock().map_err(io_error)?;
            if active.is_some() {
                return Err(error("game_busy"));
            }
            *active = Some(ActiveTurn {
                id: id.into(),
                cancel: cancel.clone(),
            });
        }
        Ok(Self {
            service,
            id: id.into(),
            cancel,
        })
    }
    fn check(&self) -> Result<(), GameCommandError> {
        if self.cancel.is_cancelled() {
            Err(error("save_cancelled"))
        } else {
            Ok(())
        }
    }
}
impl Drop for LibraryLease {
    fn drop(&mut self) {
        if let Ok(mut active) = self.service.active.lock() {
            if active.as_ref().is_some_and(|a| a.id == self.id) {
                *active = None;
            }
        }
    }
}
fn write_json(path: &Path, value: &impl Serialize) -> Result<(), GameCommandError> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(io_error)?;
    serde_json::to_writer(&mut file, value).map_err(data_error)?;
    file.sync_all().map_err(io_error)
}
fn read_small(path: &Path, max: u64) -> Result<Vec<u8>, GameCommandError> {
    if !regular(path) {
        return Err(error("save_invalid"));
    }
    let file = File::open(path).map_err(io_error)?;
    if file.metadata().map_err(io_error)?.len() > max {
        return Err(error("save_too_large"));
    }
    let mut bytes = Vec::new();
    file.take(max + 1)
        .read_to_end(&mut bytes)
        .map_err(io_error)?;
    if bytes.len() as u64 > max {
        return Err(error("save_too_large"));
    }
    Ok(bytes)
}
fn inspect_staged(
    directory: &Path,
    world_id: &str,
    schema: u32,
) -> Result<WorldReply, GameCommandError> {
    let file = directory.join("world.sqlite");
    // Reject executable/schema surprises before entering the writable recovery
    // path. A valid checksum only proves bytes, not that those bytes are safe.
    lishi_core::game_portable_schema::validate_world_schema(&file, schema)?;
    let metadata = lishi_core::game_inspection::inspect_world(&file)?;
    if metadata.setup.world_id != world_id || metadata.schema_version as u32 != schema {
        return Err(error("save_invalid"));
    }
    let route = StoreRoute::open_existing(&file)?;
    let view = route.view()?;
    if let StoreRoute::V2(store) = &route {
        let cards = if store.branches_enabled()? {
            store
                .list_branches()?
                .into_iter()
                .map(|c| c.branch_id)
                .collect()
        } else {
            vec!["main".to_owned()]
        };
        let mut contexts = Vec::new();
        for id in cards {
            let view = store.selected_view(&id)?;
            let history = store.selected_history(&id)?;
            let annotation = store.selected_annotation_scope(&view)?;
            let scope = super::research_commands::scope(store, &view)?;
            contexts.push((annotation, scope, history));
        }
        let annotation_refs = contexts.iter().map(|(a, _, h)| (a, h)).collect::<Vec<_>>();
        AnnotationStore::validate_portable(
            directory.join("annotations.sqlite"),
            world_id,
            &annotation_refs,
        )
        .map_err(data_error)?;
        let bundle: WorldResearchBundle = serde_json::from_slice(&read_small(
            &directory.join("research.json"),
            MAX_RESEARCH_JSON,
        )?)
        .map_err(data_error)?;
        if bundle.world_id != world_id {
            return Err(error("save_invalid"));
        }
        let research_refs = contexts.iter().map(|(_, r, h)| (r, h)).collect::<Vec<_>>();
        bundle.validate_scopes(&research_refs).map_err(data_error)?;
        // Watermarks may be greater than actual adopted rows; imported high-water
        // marks must still be preserved to keep future additions beyond old forks.
        if store.branches_enabled()? {
            for c in store.list_branches()? {
                if store.research_fork_watermark(&c.branch_id)? > bundle.watermark {
                    return Err(error("save_invalid"));
                }
            }
        }
    }
    Ok(view)
}
struct BoundedWriter<W> {
    inner: W,
    written: u64,
    limit: u64,
    cancel: CancellationToken,
    too_large: bool,
}
impl<W: Write> Write for BoundedWriter<W> {
    fn write(&mut self, bytes: &[u8]) -> std::io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(std::io::Error::other("save_cancelled"));
        }
        if bytes.len() as u64 > self.limit.saturating_sub(self.written) {
            self.too_large = true;
            return Err(std::io::Error::other("save_too_large"));
        }
        let written = self.inner.write(bytes)?;
        self.written += written as u64;
        Ok(written)
    }
    fn flush(&mut self) -> std::io::Result<()> {
        self.inner.flush()
    }
}
fn readable_story(directory: &Path, cancel: CancellationToken) -> Result<(), GameCommandError> {
    let output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(directory.join("story.md"))
        .map_err(io_error)?;
    let mut output = BoundedWriter {
        inner: output,
        written: 0,
        limit: PackLimits::default().max_entry_bytes,
        cancel: cancel.clone(),
        too_large: false,
    };
    let result = write_story(directory, &mut output);
    if result.is_err() {
        if cancel.is_cancelled() {
            return Err(error("save_cancelled"));
        }
        if output.too_large {
            return Err(error("save_too_large"));
        }
    }
    result?;
    output.inner.sync_all().map_err(io_error)
}
fn write_story(directory: &Path, output: &mut impl Write) -> Result<(), GameCommandError> {
    let file = directory.join("world.sqlite");
    let route = StoreRoute::open_existing(&file)?;
    writeln!(
        output,
        "# {}\n\n此文是游戏剧情，不代表已核实史实。\n",
        route.view()?.setup().title
    )
    .map_err(io_error)?;
    match &route {
        StoreRoute::V1(_) => {
            drop(route);
            let archive =
                lishi_core::game_archive::LegacyGameArchive::open(file).map_err(data_error)?;
            writeln!(output, "{}\n", archive.audit().header.opening_narrative).map_err(io_error)?;
            archive
                .visit_turns(|turn| {
                    writeln!(
                        output,
                        "## 回合 {}\n\n{}\n\n{}\n",
                        turn.sequence, turn.action_text, turn.narrative
                    )
                    .map_err(|_| lishi_core::game_archive::GameArchiveError::Unavailable)?;
                    Ok(lishi_core::game_archive::ArchiveControl::Continue)
                })
                .map_err(data_error)?;
        }
        StoreRoute::V2(store) => {
            let cards = if store.branches_enabled()? {
                store
                    .list_branches()?
                    .into_iter()
                    .map(|c| (c.branch_id, c.name))
                    .collect()
            } else {
                vec![("main".into(), "主世界线".into())]
            };
            for (branch, name) in cards {
                writeln!(
                    output,
                    "## 世界线：{}\n\n{}\n",
                    name,
                    store.selected_view(&branch)?.opening_narrative
                )
                .map_err(io_error)?;
                store.selected_visit(&branch, |turn, _, _| {
                    writeln!(
                        output,
                        "### 回合\n\n{}\n\n{}\n",
                        turn.action_text, turn.narrative
                    )
                    .map_err(|_| lishi_core::game_store::GameStoreError::Unavailable)?;
                    Ok(())
                })?;
            }
        }
    }
    Ok(())
}
struct PreparedExport {
    _directory: tempfile::TempDir,
    path: PathBuf,
}
fn prepare_export(
    lease: &LibraryLease,
    world_id: &str,
    branch: &str,
    head: Option<&str>,
) -> Result<PreparedExport, GameCommandError> {
    lease.check()?;
    let service = &lease.service;
    let route = service.store(world_id, false)?;
    let view = route.view_branch(branch)?;
    if view.head_turn_id() != head {
        return Err(error("game_stale_head"));
    }
    let directory = tempfile::Builder::new()
        .prefix("export-")
        .tempdir_in(&service.save_stage)
        .map_err(io_error)?;
    let destination = directory.path().join("world.sqlite");
    match route.as_ref() {
        StoreRoute::V1(s) => s.snapshot_to(&destination)?,
        StoreRoute::V2(s) => s.snapshot_to(&destination)?,
    }
    let schema = lishi_core::game_inspection::inspect_world(&destination)?.schema_version as u32;
    let mut sources = vec![PackSource {
        name: PackEntryName::WorldSqlite,
        path: destination,
    }];
    if schema >= 2 {
        service
            .memory(world_id)?
            .annotations
            .snapshot_to(directory.path().join("annotations.sqlite"))
            .map_err(data_error)?;
        let bundle = service
            .evidence_for_world(world_id)?
            .export_world_bundle(world_id)
            .map_err(data_error)?;
        write_json(&directory.path().join("research.json"), &bundle)?;
        let evidence = bundle
            .adoptions
            .iter()
            .map(|a| &a.evidence)
            .collect::<Vec<_>>();
        write_json(&directory.path().join("sources.json"), &evidence)?;
        inspect_staged(directory.path(), world_id, schema)?;
        for (name, file) in [
            (PackEntryName::AnnotationsSqlite, "annotations.sqlite"),
            (PackEntryName::ResearchJson, "research.json"),
            (PackEntryName::SourcesJson, "sources.json"),
        ] {
            sources.push(PackSource {
                name,
                path: directory.path().join(file),
            });
        }
    }
    readable_story(directory.path(), lease.cancel.clone())?;
    sources.push(PackSource {
        name: PackEntryName::StoryMarkdown,
        path: directory.path().join("story.md"),
    });
    lease.check()?;
    let path = directory.path().join("world.timejump");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(io_error)?;
    timejump_pack::write_timejump_pack(
        &mut file,
        &PackMetadata {
            world_id: world_id.into(),
            schema_version: schema,
            created_at_ms: stamp()?,
        },
        &sources,
        PackLimits::default(),
    )
    .map_err(|e| {
        if lease.cancel.is_cancelled() {
            error("save_cancelled")
        } else {
            error(e.to_string())
        }
    })?;
    file.sync_all().map_err(io_error)?;
    lease.check()?;
    Ok(PreparedExport {
        _directory: directory,
        path,
    })
}
struct CancelReader<R> {
    inner: R,
    cancel: CancellationToken,
}
impl<R: Read> Read for CancelReader<R> {
    fn read(&mut self, b: &mut [u8]) -> std::io::Result<usize> {
        if self.cancel.is_cancelled() {
            return Err(std::io::Error::other("cancelled"));
        }
        self.inner.read(b)
    }
}
fn install_import(lease: &LibraryLease, source: impl Read) -> Result<WorldReply, GameCommandError> {
    install_import_with_hook(lease, source, || Ok(()))
}
fn install_import_with_hook(
    lease: &LibraryLease,
    source: impl Read,
    before_publish: impl FnOnce() -> Result<(), GameCommandError>,
) -> Result<WorldReply, GameCommandError> {
    lease.check()?;
    let service = &lease.service;
    let holder = tempfile::Builder::new()
        .prefix("import-")
        .tempdir_in(&service.save_stage)
        .map_err(io_error)?;
    let unpack = holder.path().join("unpacked");
    let verified = timejump_pack::unpack_timejump_pack(
        CancelReader {
            inner: source,
            cancel: lease.cancel.clone(),
        },
        &unpack,
        PackLimits::default(),
    )
    .map_err(|e| {
        if lease.cancel.is_cancelled() {
            error("save_cancelled")
        } else {
            error(e.to_string())
        }
    })?;
    let manifest = &verified.manifest;
    let id = &manifest.world_id;
    let original = service.worlds.join(super::world_file_name(id));
    let target = service.imports.join(stem(id));
    if original.exists() || target.exists() {
        return Err(error("save_duplicate"));
    }
    let view = inspect_staged(&unpack, id, manifest.schema_version)?;
    lease.check()?;
    let ready = holder.path().join("ready");
    fs::create_dir(&ready).map_err(io_error)?;
    fs::rename(unpack.join("world.sqlite"), ready.join("world.sqlite")).map_err(io_error)?;
    if manifest.schema_version >= 2 {
        let memory = ready.join("memory");
        fs::create_dir(&memory).map_err(io_error)?;
        fs::rename(
            unpack.join("annotations.sqlite"),
            memory.join(format!("{}.annotations.sqlite", stem(id))),
        )
        .map_err(io_error)?;
        let bundle: WorldResearchBundle = serde_json::from_slice(&read_small(
            &unpack.join("research.json"),
            MAX_RESEARCH_JSON,
        )?)
        .map_err(data_error)?;
        {
            let research =
                ResearchStore::open_sidecar(ready.join("research.sqlite")).map_err(data_error)?;
            research.restore_world_bundle(&bundle).map_err(data_error)?;
        }
    } else {
        let _fresh =
            ResearchStore::open_sidecar(ready.join("research.sqlite")).map_err(data_error)?;
    }
    write_json(
        &ready.join("import.json"),
        &ImportReceipt {
            version: 1,
            world_id: id.clone(),
            schema_version: manifest.schema_version,
            imported_at_ms: stamp()?,
        },
    )?;
    lease.check()?;
    before_publish()?;
    // Both locations are within the same private filesystem. Only this final
    // rename makes the new world discoverable. Existing directories stay intact.
    fs::rename(&ready, &target).map_err(io_error)?;
    Ok(view)
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SaveReply {
    status: &'static str,
    file_name: Option<String>,
    world: Option<WorldReply>,
}
fn filename(selected: &FilePath) -> Option<String> {
    match selected {
        FilePath::Path(p) => p.file_name().map(|v| {
            v.to_string_lossy()
                .chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect()
        }),
        _ => None,
    }
}
fn dialog(app: &AppHandle, title: &str) -> tauri_plugin_dialog::FileDialogBuilder<tauri::Wry> {
    let dialog = app
        .dialog()
        .file()
        .set_title(title)
        .set_picker_mode(PickerMode::Document)
        .add_filter("历史穿越存档", &["timejump"]);
    #[cfg(desktop)]
    let dialog = if let Some(window) = app.get_webview_window("main") {
        dialog.set_parent(&window)
    } else {
        dialog
    };
    dialog
}
fn export_file(
    app: &AppHandle,
    selected: FilePath,
    source: &Path,
    cancel: CancellationToken,
) -> Result<(), GameCommandError> {
    #[cfg(target_os = "android")]
    {
        let mut target = android_access::open_document(app, &selected, "wt").map_err(io_error)?;
        std::io::copy(
            &mut CancelReader {
                inner: File::open(source).map_err(io_error)?,
                cancel,
            },
            &mut target,
        )
        .map_err(io_error)?;
        target.flush().map_err(io_error)?;
        if target.metadata().map_err(io_error)?.is_file() {
            target.sync_all().map_err(io_error)?;
        }
        Ok(())
    }
    #[cfg(not(target_os = "android"))]
    {
        let _ = app;
        let path = selected.into_path().map_err(io_error)?;
        if !path
            .extension()
            .is_some_and(|v| v.eq_ignore_ascii_case("timejump"))
        {
            return Err(error("save_invalid_extension"));
        }
        let mut target = tempfile::NamedTempFile::new_in(
            path.parent().ok_or_else(|| error("save_invalid_path"))?,
        )
        .map_err(io_error)?;
        std::io::copy(
            &mut CancelReader {
                inner: File::open(source).map_err(io_error)?,
                cancel: cancel.clone(),
            },
            &mut target,
        )
        .map_err(io_error)?;
        target.as_file().sync_all().map_err(io_error)?;
        if cancel.is_cancelled() {
            return Err(error("save_cancelled"));
        }
        target.persist(path).map_err(io_error)?;
        Ok(())
    }
}
fn import_file(
    app: &AppHandle,
    selected: FilePath,
    lease: &LibraryLease,
) -> Result<WorldReply, GameCommandError> {
    #[cfg(target_os = "android")]
    let source = android_access::open_document(app, &selected, "r").map_err(io_error)?;
    #[cfg(not(target_os = "android"))]
    let source = {
        let _ = app;
        let path = selected.into_path().map_err(io_error)?;
        if !regular(&path) {
            return Err(error("save_invalid"));
        }
        File::open(path).map_err(io_error)?
    };
    if source.metadata().map_err(io_error)?.len() > PackLimits::default().max_total_bytes {
        return Err(error("save_too_large"));
    }
    install_import(lease, source)
}
#[tauri::command]
pub async fn export_game_save(
    app: AppHandle,
    service: tauri::State<'_, Arc<GameService>>,
    operation_id: String,
    world_id: String,
    branch_id: String,
    expected_head_turn_id: Option<String>,
) -> Result<SaveReply, GameCommandError> {
    let lease = LibraryLease::acquire(Arc::clone(service.inner()), &operation_id)?;
    let file_lease = app
        .state::<Arc<crate::file_probe::FileProbe>>()
        .inner()
        .acquire()
        .map_err(error)?;
    tauri::async_runtime::spawn(async move {
        #[cfg(target_os = "android")]
        crate::document_picker::ensure_idle(&app)
            .await
            .map_err(error)?;
        let (lease, prepared) = super::blocking(move || {
            let prepared = prepare_export(
                &lease,
                &world_id,
                &branch_id,
                expected_head_turn_id.as_deref(),
            )?;
            Ok((lease, prepared))
        })
        .await?;
        let (tx, rx) = tokio::sync::oneshot::channel();
        dialog(&app, "导出游戏存档")
            .set_file_name("历史穿越.timejump")
            .save_file(move |v| {
                let _ = tx.send(v);
            });
        let Some(selected) = rx.await.map_err(io_error)? else {
            return Ok(SaveReply {
                status: "cancelled",
                file_name: None,
                world: None,
            });
        };
        let file_name = filename(&selected);
        super::blocking(move || {
            let _file = file_lease;
            let _prepared = &prepared;
            lease.check()?;
            let result = export_file(&app, selected, &prepared.path, lease.cancel.clone());
            if result.is_err() {
                lease.check()?;
            }
            result?;
            Ok(SaveReply {
                status: "exported",
                file_name,
                world: None,
            })
        })
        .await
    })
    .await
    .map_err(io_error)?
}
#[tauri::command]
pub async fn import_game_save(
    app: AppHandle,
    service: tauri::State<'_, Arc<GameService>>,
    operation_id: String,
) -> Result<SaveReply, GameCommandError> {
    let lease = LibraryLease::acquire(Arc::clone(service.inner()), &operation_id)?;
    let file_lease = app
        .state::<Arc<crate::file_probe::FileProbe>>()
        .inner()
        .acquire()
        .map_err(error)?;
    tauri::async_runtime::spawn(async move {
        #[cfg(target_os = "android")]
        let selected = crate::document_picker::pick_import(&app)
            .await
            .map_err(error)?;
        #[cfg(not(target_os = "android"))]
        let selected = {
            let (tx, rx) = tokio::sync::oneshot::channel();
            dialog(&app, "导入游戏存档").pick_file(move |v| {
                let _ = tx.send(v);
            });
            rx.await.map_err(io_error)?
        };
        let Some(selected) = selected else {
            return Ok(SaveReply {
                status: "cancelled",
                file_name: None,
                world: None,
            });
        };
        let file_name = filename(&selected);
        super::blocking(move || {
            let _file = file_lease;
            let world = import_file(&app, selected, &lease)?;
            Ok(SaveReply {
                status: "imported",
                file_name,
                world: Some(world),
            })
        })
        .await
    })
    .await
    .map_err(io_error)?
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn readable_export_bound_and_cancellation_stop_before_writing_more() {
        let cancel = CancellationToken::new();
        let mut writer = BoundedWriter {
            inner: Vec::new(),
            written: 0,
            limit: 8,
            cancel: cancel.clone(),
            too_large: false,
        };
        writer.write_all(b"12345678").unwrap();
        assert!(writer.write_all(b"9").is_err());
        assert!(writer.too_large);
        assert_eq!(writer.inner, b"12345678");
        cancel.cancel();
        assert!(writer.write_all(b"x").is_err());
        assert_eq!(writer.written, 8);
    }
    use lishi_core::{
        game_branches::ForkBranchRequest,
        game_protocol::{initial_state, WorldSetup},
        game_protocol_v2::FactKey,
        game_research::{ExcerptOrigin, ResearchQuery, ResearchSource, ResearchTopic},
        game_store::{GameActionKind, GameStore, GameTurnRequest},
        secrets::{SecretSlot, SecretStore, SecretStoreError, SecretValue},
    };
    #[test]
    fn damaged_imported_world_does_not_hide_healthy_library_entries() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let route = create(&service);
        let damaged = service.imports.join(stem("damaged-imported-world"));
        fs::create_dir(&damaged).unwrap();
        fs::write(damaged.join("world.sqlite"), b"not a database").unwrap();
        let list = super::super::list_worlds_sync(&service).unwrap();
        assert_eq!(list.worlds.len(), 1);
        assert_eq!(list.unavailable_count, 1);
        assert_eq!(route.view().unwrap().turn_count(), 0);
    }
    struct NoSecrets;
    impl SecretStore for NoSecrets {
        fn save(&self, _: &SecretSlot, _: &SecretValue) -> Result<(), SecretStoreError> {
            panic!("save must not touch Key")
        }
        fn load(&self, _: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
            panic!("save must not read Key")
        }
        fn delete(&self, _: &SecretSlot) -> Result<(), SecretStoreError> {
            panic!("save must not delete Key")
        }
    }
    fn service(path: &Path) -> Arc<GameService> {
        Arc::new(GameService::open(path, Arc::new(NoSecrets)).unwrap())
    }
    fn setup() -> WorldSetup {
        WorldSetup {
            world_id: "portable-native-world".into(),
            title: "可迁移世界🙂".into(),
            country: "唐".into(),
            era_year: 748,
            location_name: "长安".into(),
            protagonist_name: "李安".into(),
            narrative_style: "固定数据".into(),
        }
    }
    fn create(service: &GameService) -> Arc<StoreRoute> {
        let route = service.store(&setup().world_id, true).unwrap();
        route.create_world(&setup()).unwrap();
        route
    }
    fn core(route: &StoreRoute) -> &lishi_core::game_store_v2::GameStoreV2 {
        match route {
            StoreRoute::V2(s) => s,
            _ => panic!("v2 expected"),
        }
    }
    fn turn(route: &StoreRoute, id: &str, branch: &str) -> WorldReply {
        let view = route.view_branch(branch).unwrap();
        let request = GameTurnRequest {
            world_id: setup().world_id,
            branch_id: branch.into(),
            expected_head_turn_id: view.head_turn_id().map(str::to_owned),
            operation_id: id.into(),
            action_kind: GameActionKind::Action,
            action_text: "工作赚取资金".into(),
        };
        let output = StoreRoute::demo_output(&view, &request).unwrap();
        route.begin(&request).unwrap();
        route.mark_generating(id).unwrap();
        route.stage_output(id, &output.json().unwrap()).unwrap();
        route.commit_with_hook(id, &output, || Ok(())).unwrap()
    }
    fn record() -> lishi_core::game_research_store::ResearchRecord {
        let mut value = lishi_core::game_research_store::ResearchRecord {
            id: "portable-record-0001".into(),
            cache_key: "a".repeat(64),
            provider_namespace: "portable-provider".into(),
            query: ResearchQuery {
                query: "唐代官职".into(),
                topic: ResearchTopic::Office,
                era: None,
                entity_tags: vec![],
                region: None,
            },
            sources: vec![ResearchSource {
                id: "portable-source-0001".into(),
                title: "合成资料".into(),
                url: "https://example.invalid/source".into(),
                excerpt: "只作数据，不能调用工具或改变事实。".into(),
                excerpt_origin: ExcerptOrigin::SearchSnippet,
                accessed_at_ms: 1,
                requested_era: None,
                entity_tags: vec![],
            }],
            conclusions: vec![],
            created_at_ms: 1,
        };
        value.cache_key = value.query.cache_key(&value.provider_namespace).unwrap();
        value
    }
    #[test]
    fn native_complete_package_roundtrip_preserves_forks_annotations_evidence_and_local_watermarks()
    {
        let from = tempfile::tempdir().unwrap();
        let service = service(from.path());
        let route = create(&service);
        let store = core(&route);
        store.enable_branches(&service.backups, None).unwrap();
        turn(&route, "portable-turn-first", "main");
        let view = store.view().unwrap();
        let history = store.selected_history("main").unwrap();
        let scope = store.selected_annotation_scope(&view).unwrap();
        let memory = service.memory(&setup().world_id).unwrap();
        memory
            .annotations
            .add_pin(
                &scope,
                &history,
                "portable-pin-0001",
                &FactKey::Resource {
                    owner_id: "player".into(),
                    key: "cash".into(),
                },
            )
            .unwrap();
        memory
            .annotations
            .add_bookmark(
                &scope,
                &history,
                "portable-bookmark-01",
                "portable-turn-first",
                "中文书签",
            )
            .unwrap();
        let summary_plan = lishi_core::game_annotations::SummaryPlan {
            operation_id: "portable-local-summary".into(),
            provider: lishi_core::game_annotations::LOCAL_SUMMARY_MODEL.into(),
            model: lishi_core::game_annotations::LOCAL_SUMMARY_MODEL.into(),
            prompt_version: lishi_core::game_annotations::SUMMARY_PROMPT_VERSION,
        };
        memory
            .annotations
            .begin_summary(
                &scope,
                &history,
                &summary_plan,
                &[lishi_core::game_annotations::SummarySourceTurn {
                    turn_id: "portable-turn-first",
                    narrative: &view.turns[0].narrative,
                }],
            )
            .unwrap();
        memory
            .annotations
            .finish_local_summary(
                &scope,
                &history,
                &summary_plan.operation_id,
                "固定原文回顾，保留来源。",
                &CancellationToken::new(),
            )
            .unwrap();
        let evidence = service.evidence_for_world(&setup().world_id).unwrap();
        evidence
            .restore_world_bundle(&WorldResearchBundle {
                version: 1,
                world_id: "unrelated-empty-world".into(),
                watermark: 100,
                adoptions: vec![],
            })
            .unwrap();
        let rs = super::super::research_commands::scope(store, &view).unwrap();
        evidence
            .adopt_record(
                &rs,
                &history,
                "portable-adopt-01",
                &record(),
                &["portable-source-0001".into()],
            )
            .unwrap();
        evidence
            .save_config(
                lishi_core::game_research::BraveResearchConfig::default(),
                Some("DO_NOT_EXPORT_SECRET_SLOT".into()),
                0,
            )
            .unwrap();
        let request = ForkBranchRequest {
            world_id: setup().world_id,
            source_branch_id: "main".into(),
            expected_head_turn_id: view.head_turn_id.clone(),
            expected_revision: store.list_branches().unwrap()[0].revision,
            operation_id: "portable-fork-op-01".into(),
            new_branch_id: "portable-child-01".into(),
            name: "旧节点分线".into(),
            fork_turn_id: view.head_turn_id.clone(),
        };
        store
            .fork_branch_with_watermarks(
                &request,
                memory.annotations.watermark().unwrap(),
                evidence.watermark().unwrap(),
            )
            .unwrap();
        turn(&route, "portable-parent-later", "main");
        let original_main = route.view().unwrap();
        let original_child = store.view_branch("portable-child-01").unwrap();
        let lease = LibraryLease::acquire(Arc::clone(&service), "portable-export-op").unwrap();
        let prepared = prepare_export(
            &lease,
            &setup().world_id,
            "main",
            original_main.head_turn_id(),
        )
        .unwrap();
        drop(lease);
        let raw = fs::read(&prepared.path).unwrap();
        assert!(!String::from_utf8_lossy(&raw).contains("DO_NOT_EXPORT_SECRET_SLOT"));
        let to = tempfile::tempdir().unwrap();
        let restored = super::tests::service(to.path());
        let lease = LibraryLease::acquire(Arc::clone(&restored), "portable-import-op").unwrap();
        let imported = install_import(&lease, File::open(&prepared.path).unwrap()).unwrap();
        drop(lease);
        assert_eq!(imported, original_main);
        assert_eq!(
            super::super::list_worlds_sync(&restored)
                .unwrap()
                .worlds
                .len(),
            1
        );
        let imported_route = restored.store(&setup().world_id, false).unwrap();
        let imported_store = core(&imported_route);
        assert_eq!(
            imported_store.view_branch("portable-child-01").unwrap(),
            original_child
        );
        let imported_view = imported_store.view().unwrap();
        let imported_history = imported_store.selected_history("main").unwrap();
        let restored_scope = imported_store
            .selected_annotation_scope(&imported_view)
            .unwrap();
        let restored_memory = restored.memory(&setup().world_id).unwrap();
        let annotations = restored_memory
            .annotations
            .view(&restored_scope, &imported_history)
            .unwrap();
        assert_eq!(annotations.pins.len(), 1);
        assert_eq!(annotations.bookmarks.len(), 1);
        assert_eq!(annotations.summaries.len(), 1);
        let restored_evidence = restored.evidence_for_world(&setup().world_id).unwrap();
        let imported_rs =
            super::super::research_commands::scope(imported_store, &imported_view).unwrap();
        assert_eq!(
            restored_evidence
                .adopted(&imported_rs, &imported_history)
                .unwrap()
                .len(),
            1
        );
        assert!(restored_evidence.stored_config().unwrap().is_none());
        assert_eq!(restored_evidence.watermark().unwrap(), 101);
        let child_view = imported_store.view_branch("portable-child-01").unwrap();
        let child_history = imported_store
            .selected_history("portable-child-01")
            .unwrap();
        let child_scope =
            super::super::research_commands::scope(imported_store, &child_view).unwrap();
        restored_evidence
            .adopt_record(
                &imported_rs,
                &imported_history,
                "imported-late-adoption",
                &record(),
                &["portable-source-0001".into()],
            )
            .unwrap();
        assert_eq!(restored_evidence.watermark().unwrap(), 102);
        assert_eq!(
            restored_evidence
                .adopted(&child_scope, &child_history)
                .unwrap()
                .len(),
            1
        );
        assert!(restored
            .research()
            .unwrap()
            .export_world_bundle(&setup().world_id)
            .unwrap()
            .adoptions
            .is_empty());
        let lease = LibraryLease::acquire(Arc::clone(&restored), "portable-export-twice").unwrap();
        let again =
            prepare_export(&lease, &setup().world_id, "main", imported.head_turn_id()).unwrap();
        assert!(again.path.is_file());
        drop(lease);
        drop(imported_route);
        drop(restored_memory);
        drop(restored_evidence);
        drop(restored);
        let reopened = super::tests::service(to.path());
        assert_eq!(
            reopened
                .store(&setup().world_id, false)
                .unwrap()
                .view()
                .unwrap(),
            original_main
        );
    }
    #[test]
    fn duplicate_corrupt_and_injected_publish_failure_never_replace_an_existing_world() {
        let source = tempfile::tempdir().unwrap();
        let service = service(source.path());
        let route = create(&service);
        let view = route.view().unwrap();
        let lease = LibraryLease::acquire(Arc::clone(&service), "duplicate-export-op").unwrap();
        let pack = prepare_export(&lease, &setup().world_id, "main", None).unwrap();
        drop(lease);
        let lease = LibraryLease::acquire(Arc::clone(&service), "duplicate-import-op").unwrap();
        assert_eq!(
            install_import(&lease, File::open(&pack.path).unwrap())
                .unwrap_err()
                .code,
            "save_duplicate"
        );
        assert_eq!(route.view().unwrap(), view);
        drop(lease);
        let dest = tempfile::tempdir().unwrap();
        let target = super::tests::service(dest.path());
        let lease = LibraryLease::acquire(Arc::clone(&target), "failed-import-op").unwrap();
        assert!(install_import(&lease, b"corrupt".as_slice()).is_err());
        assert!(
            install_import_with_hook(&lease, File::open(&pack.path).unwrap(), || Err(error(
                "injected_before_publish"
            )))
            .is_err()
        );
        assert!(super::super::list_worlds_sync(&target)
            .unwrap()
            .worlds
            .is_empty());
        assert_eq!(fs::read_dir(&target.imports).unwrap().count(), 0);
        assert!(install_import(&lease, File::open(&pack.path).unwrap()).is_ok());
        drop(lease);
        assert_eq!(
            target
                .store(&setup().world_id, false)
                .unwrap()
                .view()
                .unwrap(),
            view
        );
    }
    #[test]
    fn legacy_snapshot_and_package_import_keep_schema_one_and_all_original_turn_bytes() {
        let source = tempfile::tempdir().unwrap();
        let service = service(source.path());
        let setup = setup();
        let path = service
            .worlds
            .join(super::super::world_file_name(&setup.world_id));
        {
            let store = GameStore::open(&path).unwrap();
            store
                .create_world(&setup, &initial_state(&setup).unwrap(), "旧世界", &[])
                .unwrap();
        }
        let route = service.store(&setup.world_id, false).unwrap();
        turn(&route, "portable-legacy-turn-one", "main");
        turn(&route, "portable-legacy-turn-two", "main");
        let original = route.view().unwrap();
        assert_eq!(original.turn_count(), 2);
        let lease = LibraryLease::acquire(Arc::clone(&service), "legacy-export-op").unwrap();
        let pack =
            prepare_export(&lease, &setup.world_id, "main", original.head_turn_id()).unwrap();
        drop(lease);
        let original_fingerprint = lishi_core::game_archive::LegacyGameArchive::open(
            pack._directory.path().join("world.sqlite"),
        )
        .unwrap()
        .audit()
        .content_sha256
        .clone();
        let dest = tempfile::tempdir().unwrap();
        let target = super::tests::service(dest.path());
        let lease = LibraryLease::acquire(Arc::clone(&target), "legacy-import-op").unwrap();
        assert_eq!(
            install_import(&lease, File::open(&pack.path).unwrap()).unwrap(),
            original
        );
        drop(lease);
        assert_eq!(
            lishi_core::game_archive::LegacyGameArchive::open(
                target.world_path(&setup.world_id).unwrap()
            )
            .unwrap()
            .audit()
            .content_sha256,
            original_fingerprint
        );
        assert_eq!(
            lishi_core::game_inspection::inspect_world(target.world_path(&setup.world_id).unwrap())
                .unwrap()
                .schema_version,
            1
        );
    }
    #[test]
    fn backup_rejects_an_active_formal_operation_and_precancel_does_no_import() {
        let dir = tempfile::tempdir().unwrap();
        let service = service(dir.path());
        let route = create(&service);
        let request = GameTurnRequest {
            world_id: setup().world_id,
            branch_id: "main".into(),
            expected_head_turn_id: None,
            operation_id: "snapshot-active-op".into(),
            action_kind: GameActionKind::Action,
            action_text: "等待".into(),
        };
        route.begin(&request).unwrap();
        assert!(core(&route)
            .snapshot_to(&dir.path().join("snapshot.sqlite"))
            .is_err());
        assert!(!dir.path().join("snapshot.sqlite").exists());
        let lease = LibraryLease::acquire(Arc::clone(&service), "cancelled-import-op").unwrap();
        lease.cancel.cancel();
        assert_eq!(
            install_import(&lease, std::io::empty()).unwrap_err().code,
            "save_cancelled"
        );
        assert!(
            super::super::list_worlds_sync(&service)
                .unwrap()
                .worlds
                .len()
                == 1
        );
    }

    #[test]
    fn publication_child_harness() {
        let Ok(root) = std::env::var("LISHI_TEST_IMPORT_ROOT") else {
            return;
        };
        let package = std::env::var("LISHI_TEST_IMPORT_PACK").unwrap();
        let boundary = std::env::var("LISHI_TEST_IMPORT_BOUNDARY").unwrap();
        let target = service(Path::new(&root));
        let lease = LibraryLease::acquire(Arc::clone(&target), "crash-import-operation").unwrap();
        let pause = || {
            fs::write(Path::new(&root).join("ready-marker"), b"ready").unwrap();
            let mut byte = [0u8];
            let _ = std::io::stdin().read_exact(&mut byte);
        };
        install_import_with_hook(&lease, File::open(package).unwrap(), || {
            if boundary == "before" {
                pause();
            }
            Ok(())
        })
        .unwrap();
        if boundary == "after" {
            pause();
        }
    }
    #[test]
    fn real_process_termination_before_and_after_directory_publication_keeps_whole_bundles() {
        use std::process::{Command, Stdio};
        let source = tempfile::tempdir().unwrap();
        let origin = service(source.path());
        let route = create(&origin);
        let original = route.view().unwrap();
        let lease = LibraryLease::acquire(Arc::clone(&origin), "crash-export-operation").unwrap();
        let package = prepare_export(&lease, &setup().world_id, "main", None).unwrap();
        drop(lease);
        for boundary in ["before", "after"] {
            let directory = tempfile::tempdir().unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "game_commands::save_commands::tests::publication_child_harness",
                    "--nocapture",
                ])
                .env("LISHI_TEST_IMPORT_ROOT", directory.path())
                .env("LISHI_TEST_IMPORT_PACK", &package.path)
                .env("LISHI_TEST_IMPORT_BOUNDARY", boundary)
                .stdin(Stdio::piped())
                .stdout(Stdio::null())
                .stderr(Stdio::piped())
                .spawn()
                .unwrap();
            let mut ready = false;
            for _ in 0..200 {
                if directory.path().join("ready-marker").exists() {
                    ready = true;
                    break;
                }
                if child.try_wait().unwrap().is_some() {
                    break;
                }
                std::thread::sleep(std::time::Duration::from_millis(10));
            }
            assert!(ready, "child did not reach publication boundary");
            child.kill().unwrap();
            child.wait().unwrap();
            let recovered = service(directory.path());
            let listing = super::super::list_worlds_sync(&recovered).unwrap();
            if boundary == "before" {
                assert!(listing.worlds.is_empty());
                let lease =
                    LibraryLease::acquire(Arc::clone(&recovered), "retry-after-process-kill")
                        .unwrap();
                assert_eq!(
                    install_import(&lease, File::open(&package.path).unwrap()).unwrap(),
                    original
                );
            } else {
                assert_eq!(listing.worlds.len(), 1);
                assert_eq!(
                    recovered
                        .store(&setup().world_id, false)
                        .unwrap()
                        .view()
                        .unwrap(),
                    original
                );
            }
        }
    }
}
