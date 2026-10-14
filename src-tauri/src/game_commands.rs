//! Native transport for formal worlds. The database owns facts; UI events are
//! provisional. Secrets, profiles and world files have separate lifetimes.
use lishi_core::{
    game_context::ContextBudget,
    game_protocol::{self, WorldSetup},
    game_provider::{self, Capability, ProviderKind, ProviderStore, ProviderView, StoredProvider},
    game_store::{GameOperationStatus, GameStoreError, GameTurnRequest},
    model_probe::{CredentialMode, ModelProbeDiagnostics, ModelProbeRequest, SavedEndpointPolicy},
    secrets::{SecretSlot, SecretStore, SecretValue},
    CancellationToken, StreamStatus,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use tauri::ipc::Channel;

#[path = "game_memory_service.rs"]
pub mod memory_service;
#[path = "game_runtime.rs"]
mod runtime;
#[path = "game_summary_commands.rs"]
pub mod summary_commands;
pub use runtime::WorldReply;
use runtime::{OutputRoute, StoreRoute};

fn world_file_name(id: &str) -> String {
    format!(
        "world-{}.sqlite",
        Sha256::digest(id.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>()
    )
}

#[derive(Debug, Serialize)]
pub struct GameCommandError {
    code: String,
}
impl GameCommandError {
    fn new(code: impl Into<String>) -> Self {
        Self { code: code.into() }
    }
}
impl std::fmt::Display for GameCommandError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.code)
    }
}
impl std::error::Error for GameCommandError {}
impl From<GameStoreError> for GameCommandError {
    fn from(e: GameStoreError) -> Self {
        Self::new(e.to_string())
    }
}
impl From<game_protocol::GameError> for GameCommandError {
    fn from(e: game_protocol::GameError) -> Self {
        Self::new(e.code())
    }
}
impl From<game_provider::ProviderError> for GameCommandError {
    fn from(e: game_provider::ProviderError) -> Self {
        Self::new(e.to_string())
    }
}

pub struct GameService {
    worlds: PathBuf,
    backups: PathBuf,
    stores: Mutex<BTreeMap<String, Arc<StoreRoute>>>,
    memory_directory: PathBuf,
    memories: memory_service::MemoryServices,
    pub providers: Arc<ProviderStore>,
    secrets: Arc<dyn SecretStore>,
    profile_busy: Arc<AtomicBool>,
    probe_busy: Arc<AtomicBool>,
    active: Mutex<Option<ActiveTurn>>,
}
struct ActiveTurn {
    id: String,
    cancel: CancellationToken,
}

impl GameService {
    pub fn open(directory: &Path, secrets: Arc<dyn SecretStore>) -> Result<Self, GameCommandError> {
        let worlds = directory.join("worlds");
        std::fs::create_dir_all(&worlds).map_err(|_| GameCommandError::new("game_database"))?;
        Ok(Self {
            worlds,
            backups: directory.join("backups"),
            stores: Mutex::new(BTreeMap::new()),
            memory_directory: directory.join("memory"),
            memories: Mutex::new(BTreeMap::new()),
            providers: Arc::new(ProviderStore::open(directory.join("game-settings.sqlite"))?),
            secrets,
            profile_busy: Arc::new(AtomicBool::new(false)),
            probe_busy: Arc::new(AtomicBool::new(false)),
            active: Mutex::new(None),
        })
    }
    fn store(&self, id: &str, create: bool) -> Result<Arc<StoreRoute>, GameCommandError> {
        if !(8..=128).contains(&id.len())
            || !id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        {
            return Err(GameCommandError::new("game_invalid_request"));
        }
        let mut stores = self
            .stores
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if let Some(store) = stores.get(id) {
            return Ok(Arc::clone(store));
        }
        let file = self.worlds.join(world_file_name(id));
        if !create && !file.is_file() {
            return Err(GameCommandError::new("game_not_found"));
        }
        let store = Arc::new(if file.is_file() {
            StoreRoute::open_existing(&file)?
        } else {
            StoreRoute::open_new(&file)?
        });
        if !create && store.view()?.setup().world_id != id {
            return Err(GameCommandError::new("game_invalid_request"));
        }
        stores.insert(id.into(), Arc::clone(&store));
        Ok(store)
    }
    fn upgrade_sync(
        &self,
        world_id: &str,
        expected_head: Option<&str>,
    ) -> Result<WorldReply, GameCommandError> {
        if !(8..=128).contains(&world_id.len())
            || !world_id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
        {
            return Err(GameCommandError::new("game_invalid_request"));
        }
        // Keep this reservation through reopening. No new caller can acquire
        // a store/turn while its owner lock is intentionally released.
        let active = self
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_migration_busy"));
        }
        let mut stores = self
            .stores
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        let file = self.worlds.join(world_file_name(world_id));
        let metadata = lishi_core::game_inspection::inspect_world(&file)?;
        if metadata.setup.world_id != world_id || metadata.head_turn_id.as_deref() != expected_head
        {
            return Err(GameCommandError::new("game_migration_conflict"));
        }
        if let Some(cached) = stores.get(world_id) {
            if Arc::strong_count(cached) != 1 {
                return Err(GameCommandError::new("game_migration_busy"));
            }
            let view = cached.view()?;
            if view.head_turn_id() != expected_head || view.turn_count() != metadata.turn_count {
                return Err(GameCommandError::new("game_migration_conflict"));
            }
            if view.latest_operation().is_some_and(|o| {
                matches!(
                    o.status,
                    GameOperationStatus::Pending
                        | GameOperationStatus::Generating
                        | GameOperationStatus::Validating
                )
            }) {
                return Err(GameCommandError::new("game_migration_busy"));
            }
        }
        if metadata.schema_version == 2 {
            if let Some(cached) = stores.get(world_id) {
                return cached.view();
            }
            let store = Arc::new(StoreRoute::open_existing(&file)?);
            let view = store.view()?;
            stores.insert(world_id.into(), store);
            return Ok(view);
        }
        if metadata.schema_version != 1 {
            return Err(GameCommandError::new("game_incompatible_schema"));
        }
        std::fs::create_dir_all(&self.backups)
            .map_err(|_| GameCommandError::new("game_migration_backup_failed"))?;
        // Dropping only the selected idle cache entry closes SQLite and releases
        // its owner lock. Existing backups and all other worlds stay owned.
        drop(stores.remove(world_id));
        let migration =
            lishi_core::game_migration::upgrade_v1_if_head(&file, &self.backups, expected_head);
        let restored = StoreRoute::open_existing(&file).and_then(|store| {
            let store = Arc::new(store);
            let view = store.view()?;
            stores.insert(world_id.into(), store);
            Ok(view)
        });
        match (migration, restored) {
            (Ok(_), Ok(view)) => Ok(view),
            (Err(error), Ok(_)) => Err(GameCommandError::new(error.to_string())),
            // An external owner can reject both migration and reopening. Busy
            // is a pre-commit refusal in the core, so preserve it rather than
            // imply that an uncertain migration has already modified the save.
            (Err(lishi_core::game_migration::MigrationError::Busy), Err(_)) => {
                Err(GameCommandError::new("game_migration_busy"))
            }
            (_, Err(_)) => Err(GameCommandError::new("game_migration_unconfirmed")),
        }
    }
    fn actor_view_sync(
        &self,
        world_id: &str,
        actor_id: &str,
    ) -> Result<serde_json::Value, GameCommandError> {
        let store = self.store(world_id, false)?;
        let history = store.knowledge_history()?;
        if history.world_id() != world_id || history.current_state().protagonist_id != actor_id {
            return Err(GameCommandError::new("game_invalid_request"));
        }
        let grants = lishi_core::game_knowledge::initial_visible_grants(&history, actor_id)?;
        let visibility =
            lishi_core::game_knowledge::SourceVisibilityIndex::from_recorded_observations(
                &history, grants,
            )?;
        let json = lishi_core::game_knowledge::minimal_actor_fact_json(
            &history,
            &visibility,
            actor_id,
            128 * 1024,
        )?;
        let mut value: serde_json::Value = serde_json::from_str(&json)
            .map_err(|_| GameCommandError::new("game_invalid_output"))?;
        let object = value
            .as_object_mut()
            .ok_or_else(|| GameCommandError::new("game_invalid_output"))?;
        object.insert("worldId".into(), serde_json::Value::String(world_id.into()));
        object.insert(
            "headTurnId".into(),
            serde_json::to_value(history.head_turn_id())
                .map_err(|_| GameCommandError::new("game_invalid_output"))?,
        );
        Ok(value)
    }
    fn profile_lease(&self) -> Result<ProfileLease, GameCommandError> {
        self.profile_busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| GameCommandError::new("game_provider_busy"))?;
        Ok(ProfileLease(Arc::clone(&self.profile_busy)))
    }
    fn turn_lease(
        self: &Arc<Self>,
        store: Arc<StoreRoute>,
        id: &str,
    ) -> Result<TurnLease, GameCommandError> {
        let mut active = self
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let cancel = CancellationToken::new();
        *active = Some(ActiveTurn {
            id: id.into(),
            cancel: cancel.clone(),
        });
        Ok(TurnLease {
            service: Arc::clone(self),
            store,
            id: id.into(),
            cancel,
            done: false,
        })
    }
}
struct ProfileLease(Arc<AtomicBool>);
impl Drop for ProfileLease {
    fn drop(&mut self) {
        self.0.store(false, Ordering::Release)
    }
}
struct TurnLease {
    service: Arc<GameService>,
    store: Arc<StoreRoute>,
    id: String,
    cancel: CancellationToken,
    done: bool,
}
impl Drop for TurnLease {
    fn drop(&mut self) {
        if !self.done {
            self.cancel.cancel();
            let _ = self.store.finish_uncommitted(
                &self.id,
                GameOperationStatus::Interrupted,
                Some("operation_dropped"),
            );
        }
        if let Ok(mut active) = self.service.active.lock() {
            if active.as_ref().is_some_and(|a| a.id == self.id) {
                *active = None;
            }
        }
    }
}

async fn blocking<T: Send + 'static>(
    work: impl FnOnce() -> Result<T, GameCommandError> + Send + 'static,
) -> Result<T, GameCommandError> {
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|_| GameCommandError::new("game_worker_failed"))?
}
async fn profile_work<T: Send + 'static>(
    service: Arc<GameService>,
    work: impl FnOnce(Arc<GameService>) -> Result<T, GameCommandError> + Send + 'static,
) -> Result<T, GameCommandError> {
    let lease = service.profile_lease()?;
    let mut task = tauri::async_runtime::spawn_blocking(move || {
        let _lease = lease;
        work(service)
    });
    match tokio::time::timeout(Duration::from_secs(10), &mut task).await {
        Err(_) => {
            task.abort();
            Err(GameCommandError::new("game_provider_unconfirmed"))
        }
        Ok(Err(_)) => Err(GameCommandError::new("game_worker_failed")),
        Ok(Ok(result)) => result,
    }
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldCard {
    world_id: String,
    title: String,
    country: String,
    era_year: i32,
    protagonist_name: String,
    head_turn_id: Option<String>,
    turn_count: u64,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct WorldList {
    worlds: Vec<WorldCard>,
    unavailable_count: u64,
}

#[tauri::command]
pub async fn list_game_worlds(
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldList, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || list_worlds_sync(&service)).await
}

fn list_worlds_sync(service: &GameService) -> Result<WorldList, GameCommandError> {
    let mut result = WorldList {
        worlds: Vec::new(),
        unavailable_count: 0,
    };
    for entry in
        std::fs::read_dir(&service.worlds).map_err(|_| GameCommandError::new("game_database"))?
    {
        let entry = match entry {
            Ok(e) => e,
            Err(_) => {
                result.unavailable_count += 1;
                continue;
            }
        };
        if entry.path().extension().is_none_or(|e| e != "sqlite") {
            continue;
        }
        let file_name = entry.file_name().to_string_lossy().into_owned();
        if !file_name.starts_with("world-") {
            continue;
        }
        let candidate =
            (|| -> Result<lishi_core::game_inspection::WorldMetadata, GameCommandError> {
                let metadata = lishi_core::game_inspection::inspect_world(entry.path())?;
                if world_file_name(&metadata.setup.world_id) != file_name {
                    return Err(GameCommandError::new("game_invalid_request"));
                }
                Ok(metadata)
            })();
        match candidate {
            Ok(view) => result.worlds.push(WorldCard {
                world_id: view.setup.world_id,
                title: view.setup.title,
                country: view.setup.country,
                era_year: view.setup.era_year,
                protagonist_name: view.setup.protagonist_name,
                head_turn_id: view.head_turn_id,
                turn_count: view.turn_count,
            }),
            Err(_) => result.unavailable_count += 1,
        }
        if result.worlds.len() >= 512 {
            break;
        }
    }
    result
        .worlds
        .sort_by(|a, b| a.title.cmp(&b.title).then(a.world_id.cmp(&b.world_id)));
    Ok(result)
}
#[tauri::command]
pub async fn create_game_world(
    setup: WorldSetup,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldReply, GameCommandError> {
    game_protocol::validate_setup(&setup)?;
    let service = Arc::clone(service.inner());
    blocking(move || {
        let store = service.store(&setup.world_id, true)?;
        store.create_world(&setup)
    })
    .await
}
#[tauri::command]
pub async fn get_game_world(
    world_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || service.store(&world_id, false)?.view()).await
}
#[tauri::command]
pub async fn set_game_policy(
    world_id: String,
    policy: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        let store = service.store(&world_id, false)?;
        store.update_policy(&policy)?;
        store.view()
    })
    .await
}

#[tauri::command]
pub async fn upgrade_game_world(
    world_id: String,
    expected_head_turn_id: Option<String>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || service.upgrade_sync(&world_id, expected_head_turn_id.as_deref())).await
}

#[tauri::command]
pub async fn get_game_actor_view(
    world_id: String,
    actor_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<serde_json::Value, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || service.actor_view_sync(&world_id, &actor_id)).await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct GameProgress {
    operation_id: String,
    sequence: u64,
    kind: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    phase: Option<&'static str>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error_code: Option<String>,
}
struct Progress {
    channel: Channel<GameProgress>,
    id: String,
    sequence: u64,
}
impl Progress {
    fn send(
        &mut self,
        kind: &'static str,
        phase: Option<&'static str>,
        text: Option<String>,
        error: Option<String>,
    ) {
        let _ = self.channel.send(GameProgress {
            operation_id: self.id.clone(),
            sequence: self.sequence,
            kind,
            phase,
            text,
            error_code: error,
        });
        self.sequence += 1;
    }
    fn phase(&mut self, phase: &'static str) {
        self.send("phase", Some(phase), None, None)
    }
}

fn saved_credential(
    service: &GameService,
) -> Result<(StoredProvider, SecretValue), GameCommandError> {
    let profile = service
        .providers
        .stored()?
        .ok_or_else(|| GameCommandError::new("game_provider_missing"))?;
    let key = service
        .secrets
        .load(
            &SecretSlot::new(&profile.secret_slot)
                .map_err(|_| GameCommandError::new("credential_unavailable"))?,
        )
        .map_err(|_| GameCommandError::new("credential_unavailable"))?
        .ok_or_else(|| GameCommandError::new("credential_missing"))?;
    Ok((profile, key))
}

async fn run_turn(
    mut lease: TurnLease,
    request: GameTurnRequest,
    provider_kind: ProviderKind,
    mut progress: Progress,
) -> Result<WorldReply, GameCommandError> {
    let store = Arc::clone(&lease.store);
    let request_copy = request.clone();
    let view = blocking(move || {
        let view = store.view()?;
        if view.protagonist_dead() {
            return Err(GameCommandError::new("game_protagonist_dead"));
        }
        store.begin(&request_copy)?;
        store.view()
    })
    .await?;
    progress.phase("pending");
    let generation:Result<OutputRoute,GameCommandError>=async {
        if lease.cancel.is_cancelled(){return Err(GameCommandError::new("game_cancelled"))}
        let store=Arc::clone(&lease.store);let id=lease.id.clone();blocking(move||{store.mark_generating(&id)?;Ok(())}).await?;
        progress.phase("generating");
        let output=match provider_kind {
            ProviderKind::Demo=>{
                // A small cancellable boundary makes the demo honest about its
                // provisional stage, without faking model token streaming.
                tokio::select!{biased;_ = lease.cancel.cancelled()=>return Err(GameCommandError::new("game_cancelled")),
                    _=tokio::time::sleep(Duration::from_millis(180))=>{}}
                StoreRoute::demo_output(&view,&request)?
            }
            ProviderKind::Compatible=>{
                #[cfg(target_os="android")]
                if !crate::android_tls::is_ready(){return Err(GameCommandError::new("model_tls_unavailable"))}
                let profile_store=Arc::clone(&lease.service.providers);
                let frozen=blocking(move||profile_store.stored()?.ok_or_else(||GameCommandError::new("game_provider_missing"))).await?;
                let budget=frozen.config.context_budget;
                let prompt_store=Arc::clone(&lease.store);let prompt_view=view.clone();let prompt_request=request.clone();let prompt_service=Arc::clone(&lease.service);
                let (prompt,memory)=blocking(move||prompt_service.compile_context_prompt(&prompt_store,&prompt_view,&prompt_request,budget)).await?;
                let (profile,key)=profile_work(Arc::clone(&lease.service),|s|saved_credential(&s)).await?;
                if profile.config.revision!=frozen.config.revision {return Err(GameCommandError::new("game_provider_stale"))}
                let policy=if profile.config.allow_insecure_http{SavedEndpointPolicy::ExplicitHttp}else{SavedEndpointPolicy::HttpsOnly};
                let context_policy=lishi_core::model_probe::ModelContextPolicy {max_prompt_bytes:budget.effective_input_limit_bytes().map_err(|_|GameCommandError::new("game_provider_invalid"))?,
                    output_reserve_tokens:Some(budget.output_reserve_tokens.try_into().map_err(|_|GameCommandError::new("game_provider_invalid"))?)};
                let result=lishi_core::model_probe::run_model_probe_with_context_policy(ModelProbeRequest{operation_id:request.operation_id.clone(),
                    endpoint:profile.config.endpoint,model:profile.config.model,prompt,include_usage:false,credential_mode:CredentialMode::Saved},
                    Some(key),lease.cancel.clone(),game_provider::production_stream_options(),policy,context_policy,|_|true).await;
                if let Some(memory)=memory {
                    let id=request.operation_id.clone();let actual=result.diagnostics.usage.as_ref().and_then(|usage|usize::try_from(usage.prompt_tokens).ok());
                    blocking(move||memory.record_actual_usage(&id,actual)).await?;
                }
                if result.stream.status==StreamStatus::Cancelled{return Err(GameCommandError::new("game_cancelled"))}
                if result.stream.status!=StreamStatus::Completed {
                    let code=result.stream.error_code.and_then(|e|serde_json::to_value(e).ok()).and_then(|v|v.as_str().map(str::to_owned))
                        .unwrap_or_else(||"game_provider_failed".into());return Err(GameCommandError::new(code));
                }
                lease.service.providers.record_streaming(profile.config.revision,Capability::Supported)?;
                StoreRoute::parse_output(&view,&result.stream.text)?
            }
        };
        output.validate_against(&view,&request.operation_id)?;
        if lease.cancel.is_cancelled(){return Err(GameCommandError::new("game_cancelled"))}
        // Never stream raw JSON or reasoning. Display only a decoded, still
        // provisional narrative; the state is updated solely by SQL commit.
        progress.send("narrative",None,Some(output.narrative().to_owned()),None);
        let raw=output.json()?;
        let store=Arc::clone(&lease.store);let id=lease.id.clone();blocking(move||{store.stage_output(&id,&raw)?;Ok(())}).await?;
        progress.phase("validating");Ok(output)
    }.await;
    let output = match generation {
        Ok(output) => output,
        Err(error) => {
            let cancelled = lease.cancel.is_cancelled() || error.code == "game_cancelled";
            let status = if cancelled {
                GameOperationStatus::Cancelled
            } else {
                GameOperationStatus::Failed
            };
            let code = if cancelled {
                "game_cancelled".to_owned()
            } else {
                error.code
            };
            let store = Arc::clone(&lease.store);
            let id = lease.id.clone();
            let persisted_code = code.clone();
            let view = blocking(move || {
                store.finish_uncommitted(&id, status, Some(&persisted_code))?;
                store.view()
            })
            .await?;
            progress.send(
                "phase",
                Some(if cancelled { "cancelled" } else { "failed" }),
                None,
                Some(code),
            );
            lease.done = true;
            return Ok(view);
        }
    };
    let store = Arc::clone(&lease.store);
    let id = lease.id.clone();
    let cancel = lease.cancel.clone();
    let committed = blocking(move || {
        if cancel.is_cancelled() {
            store.finish_uncommitted(
                &id,
                GameOperationStatus::Cancelled,
                Some("game_cancelled"),
            )?;
            return store.view();
        }
        // The hook runs inside the short transaction immediately before commit.
        store.commit_with_hook(&id, &output, || {
            if cancel.is_cancelled() {
                Err(GameStoreError::Cancelled)
            } else {
                Ok(())
            }
        })
    })
    .await;
    match committed {
        Ok(view) => {
            lease.done = true;
            progress.phase(
                if view
                    .latest_operation()
                    .is_some_and(|o| o.status == GameOperationStatus::Committed)
                {
                    "committed"
                } else {
                    "cancelled"
                },
            );
            Ok(view)
        }
        Err(error) => {
            let cancelled = lease.cancel.is_cancelled() || error.code == "game_cancelled";
            let store = Arc::clone(&lease.store);
            let id = lease.id.clone();
            let code = if cancelled {
                "game_cancelled".into()
            } else {
                error.code
            };
            let safe_code = code.clone();
            let status = if cancelled {
                GameOperationStatus::Cancelled
            } else {
                GameOperationStatus::Failed
            };
            let view = blocking(move || {
                store.finish_uncommitted(&id, status, Some(&safe_code))?;
                store.view()
            })
            .await?;
            progress.send(
                "phase",
                Some(if cancelled { "cancelled" } else { "failed" }),
                None,
                Some(code),
            );
            lease.done = true;
            Ok(view)
        }
    }
}

#[tauri::command]
pub async fn start_game_turn(
    request: GameTurnRequest,
    provider_kind: ProviderKind,
    on_event: Channel<GameProgress>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    let id = request.world_id.clone();
    let s = Arc::clone(&service);
    let store = blocking(move || s.store(&id, false)).await?;
    let lease = service.turn_lease(store, &request.operation_id)?;
    let progress = Progress {
        channel: on_event,
        id: request.operation_id.clone(),
        sequence: 0,
    };
    // Dropping the IPC receiver detaches this owned task; it cannot release a
    // still-running operation. A separate cancellation token controls it.
    tauri::async_runtime::spawn(run_turn(lease, request, provider_kind, progress))
        .await
        .map_err(|_| GameCommandError::new("game_worker_failed"))?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CancelReply {
    operation_id: String,
    state: &'static str,
}
#[tauri::command]
pub fn cancel_game_turn(
    operation_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<CancelReply, GameCommandError> {
    let active = service
        .active
        .lock()
        .map_err(|_| GameCommandError::new("game_unavailable"))?;
    let state = match active.as_ref() {
        Some(a) if a.id == operation_id => {
            a.cancel.cancel();
            "cancel_requested"
        }
        _ => "not_found",
    };
    Ok(CancelReply {
        operation_id,
        state,
    })
}

#[tauri::command]
pub async fn get_game_provider(
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ProviderView, GameCommandError> {
    let store = Arc::clone(&service.providers);
    blocking(move || Ok(store.view()?)).await
}
#[tauri::command]
pub async fn list_game_presets(
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<Vec<game_provider::GamePreset>, GameCommandError> {
    let store = Arc::clone(&service.providers);
    blocking(move || Ok(store.presets()?)).await
}
#[tauri::command]
pub async fn save_game_preset(
    name: String,
    setup: WorldSetup,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<Vec<game_provider::GamePreset>, GameCommandError> {
    let store = Arc::clone(&service.providers);
    blocking(move || {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| GameCommandError::new("game_clock"))?
            .as_nanos();
        Ok(store.save_preset(
            &format!(
                "preset-{time:x}-{:x}",
                KEY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
            ),
            &name,
            &setup,
        )?)
    })
    .await
}
static KEY_SEQUENCE: AtomicU64 = AtomicU64::new(0);
#[tauri::command]
pub async fn save_game_provider(
    endpoint: String,
    model: String,
    token: Option<String>,
    expected_revision: u64,
    allow_insecure_http: Option<bool>,
    context_budget: Option<ContextBudget>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ProviderView, GameCommandError> {
    let token = token
        .map(SecretValue::new)
        .transpose()
        .map_err(|_| GameCommandError::new("secret_invalid_value"))?;
    let allow_insecure_http = allow_insecure_http.unwrap_or(false);
    if let Some(budget) = context_budget {
        budget
            .effective_input_limit_bytes()
            .map_err(|_| GameCommandError::new("game_provider_invalid"))?;
    }
    game_provider::validate_config_with_http_opt_in(&endpoint, &model, allow_insecure_http)?;
    profile_work(Arc::clone(service.inner()), move |service| {
        save_provider_with_budget(
            &service,
            ProviderSaveInput {
                endpoint: &endpoint,
                model: &model,
                token,
                expected_revision,
                allow_insecure_http,
                context_budget,
            },
        )
    })
    .await
}
#[cfg(test)]
fn save_provider_sync(
    service: &GameService,
    endpoint: &str,
    model: &str,
    token: Option<SecretValue>,
    expected_revision: u64,
    allow_insecure_http: bool,
) -> Result<ProviderView, GameCommandError> {
    save_provider_with_budget(
        service,
        ProviderSaveInput {
            endpoint,
            model,
            token,
            expected_revision,
            allow_insecure_http,
            context_budget: None,
        },
    )
}

struct ProviderSaveInput<'a> {
    endpoint: &'a str,
    model: &'a str,
    token: Option<SecretValue>,
    expected_revision: u64,
    allow_insecure_http: bool,
    context_budget: Option<ContextBudget>,
}

fn save_provider_with_budget(
    service: &GameService,
    input: ProviderSaveInput<'_>,
) -> Result<ProviderView, GameCommandError> {
    let ProviderSaveInput {
        endpoint,
        model,
        token,
        expected_revision,
        allow_insecure_http,
        context_budget,
    } = input;
    game_provider::validate_config_with_http_opt_in(endpoint, model, allow_insecure_http)?;
    if let Some(budget) = context_budget {
        budget
            .effective_input_limit_bytes()
            .map_err(|_| GameCommandError::new("game_provider_invalid"))?;
    }
    let previous = service.providers.stored()?;
    if service.providers.revision()? != expected_revision {
        return Err(GameCommandError::new("game_provider_stale"));
    }
    let mut new_slot = None;
    let slot = if let Some(token) = token {
        let time = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .map_err(|_| GameCommandError::new("game_clock"))?
            .as_nanos();
        let slot = format!(
            "game-key-{time:x}-{:x}",
            KEY_SEQUENCE.fetch_add(1, Ordering::Relaxed)
        );
        service.providers.allocate_slot(&slot)?;
        let secret_slot =
            SecretSlot::new(&slot).map_err(|_| GameCommandError::new("credential_unavailable"))?;
        let verify = (|| -> Result<(), GameCommandError> {
            service
                .secrets
                .save(&secret_slot, &token)
                .map_err(|_| GameCommandError::new("credential_unavailable"))?;
            let restored = service
                .secrets
                .load(&secret_slot)
                .map_err(|_| GameCommandError::new("credential_unavailable"))?
                .ok_or_else(|| GameCommandError::new("credential_missing"))?;
            if restored.expose_secret() != token.expose_secret() {
                return Err(GameCommandError::new("credential_unavailable"));
            }
            Ok(())
        })();
        if let Err(error) = verify {
            let _ = service.secrets.delete(&secret_slot);
            return Err(error);
        }
        new_slot = Some(secret_slot);
        slot
    } else {
        previous
            .as_ref()
            .ok_or_else(|| GameCommandError::new("game_provider_missing"))?
            .secret_slot
            .clone()
    };
    let result = match context_budget {
        Some(budget) => service.providers.save_with_context_budget(
            endpoint,
            model,
            &slot,
            expected_revision,
            allow_insecure_http,
            budget,
        ),
        None => service.providers.save_with_http_opt_in(
            endpoint,
            model,
            &slot,
            expected_revision,
            allow_insecure_http,
        ),
    };
    if result.is_err() {
        if let Some(slot) = new_slot {
            let _ = service.secrets.delete(&slot);
        }
    }
    let result = result?;
    if let Some(previous) = previous {
        if previous.secret_slot != slot {
            if let Ok(old) = SecretSlot::new(&previous.secret_slot) {
                let _ = service.secrets.delete(&old);
            }
        }
    }
    Ok(result)
}

#[tauri::command]
pub async fn delete_game_provider(
    expected_revision: u64,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ProviderView, GameCommandError> {
    profile_work(Arc::clone(service.inner()), move |service| {
        let previous = service.providers.stored()?;
        let cleared = service.providers.clear(expected_revision)?;
        if let Some(profile) = previous {
            service
                .secrets
                .delete(
                    &SecretSlot::new(&profile.secret_slot)
                        .map_err(|_| GameCommandError::new("credential_unavailable"))?,
                )
                .map_err(|_| GameCommandError::new("game_provider_unconfirmed"))?;
        }
        Ok(cleared)
    })
    .await
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderTest {
    status: StreamStatus,
    error_code: Option<String>,
    diagnostics: ModelProbeDiagnostics,
}
#[tauri::command]
pub async fn test_game_provider(
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ProviderTest, GameCommandError> {
    #[cfg(target_os = "android")]
    if !crate::android_tls::is_ready() {
        return Err(GameCommandError::new("model_tls_unavailable"));
    }
    let service = Arc::clone(service.inner());
    service
        .probe_busy
        .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
        .map_err(|_| GameCommandError::new("game_provider_busy"))?;
    let _probe_lease = ProfileLease(Arc::clone(&service.probe_busy));
    let (profile, key) = profile_work(Arc::clone(&service), |s| saved_credential(&s)).await?;
    let policy = if profile.config.allow_insecure_http {
        SavedEndpointPolicy::ExplicitHttp
    } else {
        SavedEndpointPolicy::HttpsOnly
    };
    let result = lishi_core::model_probe::run_model_probe_with_endpoint_policy(
        ModelProbeRequest {
            operation_id: "provider-connection-test".into(),
            endpoint: profile.config.endpoint,
            model: profile.config.model,
            prompt: "请只回复：连接测试完成。".into(),
            include_usage: false,
            credential_mode: CredentialMode::Saved,
        },
        Some(key),
        CancellationToken::new(),
        game_provider::production_stream_options(),
        policy,
        |_| true,
    )
    .await;
    if result.stream.status == StreamStatus::Completed {
        service
            .providers
            .record_streaming(profile.config.revision, Capability::Supported)?;
    }
    let code = result
        .stream
        .error_code
        .and_then(|e| serde_json::to_value(e).ok())
        .and_then(|v| v.as_str().map(str::to_owned));
    if result.diagnostics.http_status == Some(200)
        && code.as_deref() == Some("invalid_content_type")
    {
        service
            .providers
            .record_streaming(profile.config.revision, Capability::Unsupported)?;
    }
    Ok(ProviderTest {
        status: result.stream.status,
        error_code: code,
        diagnostics: result.diagnostics,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use lishi_core::game_store::GameStore;
    use lishi_core::secrets::SecretStoreError;
    use std::sync::mpsc;

    #[derive(Default)]
    struct FakeSecrets {
        values: Mutex<BTreeMap<String, String>>,
        fail_save: AtomicBool,
    }
    impl SecretStore for FakeSecrets {
        fn save(&self, slot: &SecretSlot, value: &SecretValue) -> Result<(), SecretStoreError> {
            if self.fail_save.load(Ordering::Acquire) {
                return Err(SecretStoreError::IoError);
            }
            self.values
                .lock()
                .unwrap()
                .insert(slot.as_str().into(), value.expose_secret().into());
            Ok(())
        }
        fn load(&self, slot: &SecretSlot) -> Result<Option<SecretValue>, SecretStoreError> {
            self.values
                .lock()
                .unwrap()
                .get(slot.as_str())
                .map(|s| SecretValue::new(s.clone()))
                .transpose()
        }
        fn delete(&self, slot: &SecretSlot) -> Result<(), SecretStoreError> {
            self.values.lock().unwrap().remove(slot.as_str());
            Ok(())
        }
    }
    fn setup() -> WorldSetup {
        WorldSetup {
            world_id: "native-world-one".into(),
            title: "独立世界".into(),
            country: "唐".into(),
            era_year: 618,
            location_name: "长安".into(),
            protagonist_name: "行旅者".into(),
            narrative_style: "简洁".into(),
        }
    }
    #[test]
    fn case_distinct_world_ids_use_distinct_bounded_file_names() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(FakeSecrets::default());
        let service = GameService::open(dir.path(), secrets).unwrap();
        let first = setup();
        let mut second = first.clone();
        second.world_id = "Native-world-one".into();
        for setup in [&first, &second] {
            let store = service.store(&setup.world_id, true).unwrap();
            store.create_world(setup).unwrap();
        }
        assert_ne!(
            world_file_name(&first.world_id),
            world_file_name(&second.world_id)
        );
        assert_eq!(world_file_name(&"w".repeat(128)).len(), 77);
        assert_eq!(
            service
                .store(&first.world_id, false)
                .unwrap()
                .view()
                .unwrap()
                .setup()
                .world_id,
            first.world_id
        );
        assert_eq!(
            service
                .store(&second.world_id, false)
                .unwrap()
                .view()
                .unwrap()
                .setup()
                .world_id,
            second.world_id
        );
    }
    #[test]
    fn failed_or_stale_secret_save_preserves_live_profile_and_never_serializes_key() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(FakeSecrets::default());
        let service = GameService::open(dir.path(), secrets.clone()).unwrap();
        let saved = save_provider_sync(
            &service,
            "https://example.com/v1/chat/completions",
            "one",
            Some(SecretValue::new("invalid-game-test-one".into()).unwrap()),
            0,
            false,
        )
        .unwrap();
        assert!(saved.configured);
        let old = service.providers.stored().unwrap().unwrap();
        secrets.fail_save.store(true, Ordering::Release);
        assert!(save_provider_sync(
            &service,
            "https://other.example.com/v1/chat/completions",
            "two",
            Some(SecretValue::new("invalid-game-test-two".into()).unwrap()),
            1,
            false
        )
        .is_err());
        assert_eq!(
            service.providers.stored().unwrap().unwrap().secret_slot,
            old.secret_slot
        );
        assert_eq!(
            saved_credential(&service).unwrap().1.expose_secret(),
            "invalid-game-test-one"
        );
        assert_eq!(
            save_provider_sync(
                &service,
                "https://other.example.com/v1/chat/completions",
                "three",
                None,
                0,
                false
            )
            .err()
            .unwrap()
            .code,
            "game_provider_stale"
        );
        let serialized = serde_json::to_string(&service.providers.view().unwrap()).unwrap();
        assert!(!serialized.contains("invalid-game-test"));
        assert!(!serialized.contains("game-key-"));
        assert_eq!(
            save_provider_sync(
                &service,
                "http://192.0.2.1:8317/v1/chat/completions",
                "one",
                None,
                1,
                false
            )
            .err()
            .unwrap()
            .code,
            "game_provider_invalid"
        );
        assert!(
            !service
                .providers
                .view()
                .unwrap()
                .config
                .unwrap()
                .allow_insecure_http
        );
        let http = save_provider_sync(
            &service,
            "http://192.0.2.1:8317/v1/chat/completions",
            "one",
            None,
            1,
            true,
        )
        .unwrap();
        assert!(http.config.unwrap().allow_insecure_http);
        assert_eq!(
            service.providers.stored().unwrap().unwrap().secret_slot,
            old.secret_slot
        );
        assert_eq!(
            saved_credential(&service).unwrap().1.expose_secret(),
            "invalid-game-test-one"
        );
    }
    #[tokio::test]
    async fn expired_profile_worker_keeps_lease_until_real_completion() {
        let busy = Arc::new(AtomicBool::new(true));
        let lease = ProfileLease(Arc::clone(&busy));
        let (entered_tx, entered_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let mut task = tauri::async_runtime::spawn_blocking(move || {
            let _lease = lease;
            entered_tx.send(()).unwrap();
            release_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            done_tx.send(()).unwrap();
        });
        entered_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(tokio::time::timeout(Duration::from_millis(20), &mut task)
            .await
            .is_err());
        task.abort();
        assert!(busy.load(Ordering::Acquire));
        release_tx.send(()).unwrap();
        done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        for _ in 0..100 {
            if !busy.load(Ordering::Acquire) {
                return;
            }
            std::thread::sleep(Duration::from_millis(1));
        }
        panic!("profile lease did not release");
    }
    #[tokio::test]
    async fn native_demo_commits_once_and_cancel_preserves_formal_state() {
        let dir = tempfile::tempdir().unwrap();
        let service =
            Arc::new(GameService::open(dir.path(), Arc::new(FakeSecrets::default())).unwrap());
        let setup = setup();
        let old_store =
            GameStore::open(service.worlds.join(world_file_name(&setup.world_id))).unwrap();
        old_store
            .create_world(
                &setup,
                &game_protocol::initial_state(&setup).unwrap(),
                &game_provider::opening_narrative(&setup),
                &game_provider::initial_choices(),
            )
            .unwrap();
        drop(old_store);
        let store = service.store(&setup.world_id, false).unwrap();
        let request = GameTurnRequest {
            operation_id: "native-operation-one".into(),
            world_id: setup.world_id.clone(),
            branch_id: "main".into(),
            expected_head_turn_id: None,
            action_kind: lishi_core::game_store::GameActionKind::Action,
            action_text: "购买补给".into(),
        };
        let lease = service
            .turn_lease(Arc::clone(&store), &request.operation_id)
            .unwrap();
        let progress = Progress {
            channel: Channel::new(|_| Ok(())),
            id: request.operation_id.clone(),
            sequence: 0,
        };
        let committed = run_turn(lease, request.clone(), ProviderKind::Demo, progress)
            .await
            .unwrap();
        assert_eq!(committed.turn_count(), 1);
        assert!(matches!(&committed,WorldReply::V1(view) if view.state.resources[0].amount==95));
        let request = GameTurnRequest {
            operation_id: "native-operation-two".into(),
            expected_head_turn_id: committed.head_turn_id().map(str::to_owned),
            ..request
        };
        let lease = service
            .turn_lease(Arc::clone(&store), &request.operation_id)
            .unwrap();
        lease.cancel.cancel();
        let progress = Progress {
            channel: Channel::new(|_| Ok(())),
            id: request.operation_id.clone(),
            sequence: 0,
        };
        let cancelled = run_turn(lease, request, ProviderKind::Demo, progress)
            .await
            .unwrap();
        assert_eq!(
            serde_json::to_value(cancelled.state()).unwrap(),
            serde_json::to_value(committed.state()).unwrap()
        );
        assert_eq!(cancelled.head_turn_id(), committed.head_turn_id());
        assert_eq!(
            cancelled.latest_operation().unwrap().status,
            GameOperationStatus::Cancelled
        );
        assert!(service.active.lock().unwrap().is_none());
    }

    fn seed_legacy(service: &GameService, setup: &WorldSetup, turns: usize) {
        let store = GameStore::open(service.worlds.join(world_file_name(&setup.world_id))).unwrap();
        store
            .create_world(
                setup,
                &game_protocol::initial_state(setup).unwrap(),
                &game_provider::opening_narrative(setup),
                &game_provider::initial_choices(),
            )
            .unwrap();
        for index in 1..=turns {
            let view = store.view().unwrap();
            let request = GameTurnRequest {
                operation_id: format!("native-legacy-{index:08}"),
                world_id: setup.world_id.clone(),
                branch_id: "main".into(),
                expected_head_turn_id: view.head_turn_id,
                action_kind: lishi_core::game_store::GameActionKind::Action,
                action_text: "做短工赚钱".into(),
            };
            let output = game_provider::demo_output(&view.state, &request).unwrap();
            store.begin(&request).unwrap();
            store.mark_generating(&request.operation_id).unwrap();
            store
                .stage_output(
                    &request.operation_id,
                    &serde_json::to_string(&output).unwrap(),
                )
                .unwrap();
            store.commit(&request.operation_id, &output).unwrap();
        }
    }
    fn progress(id: &str) -> Progress {
        Progress {
            channel: Channel::new(|_| Ok(())),
            id: id.into(),
            sequence: 0,
        }
    }
    fn request(id: &str, world: &str, head: Option<String>, text: &str) -> GameTurnRequest {
        GameTurnRequest {
            operation_id: id.into(),
            world_id: world.into(),
            branch_id: "main".into(),
            expected_head_turn_id: head,
            action_kind: lishi_core::game_store::GameActionKind::Action,
            action_text: text.into(),
        }
    }

    #[test]
    fn native_discovery_routes_two_versions_without_initializing_or_upgrading_old_saves() {
        let dir = tempfile::tempdir().unwrap();
        let service = GameService::open(dir.path(), Arc::new(FakeSecrets::default())).unwrap();
        let old = setup();
        seed_legacy(&service, &old, 2);
        let before = lishi_core::game_inspection::inspect_world(
            service.worlds.join(world_file_name(&old.world_id)),
        )
        .unwrap();
        let mut fresh = old.clone();
        fresh.world_id = "native-default-v2".into();
        let store = service.store(&fresh.world_id, true).unwrap();
        assert!(matches!(
            store.create_world(&fresh).unwrap(),
            WorldReply::V2(_)
        ));
        drop(store);
        let discovered = list_worlds_sync(&service).unwrap();
        assert_eq!(discovered.worlds.len(), 2);
        assert_eq!(discovered.unavailable_count, 0);
        assert_eq!(
            lishi_core::game_inspection::inspect_world(
                service.worlds.join(world_file_name(&old.world_id))
            )
            .unwrap(),
            before
        );
        assert!(!service.backups.exists());
        assert!(matches!(
            service.store(&old.world_id, false).unwrap().view().unwrap(),
            WorldReply::V1(_)
        ));
        assert_eq!(
            lishi_core::game_inspection::inspect_world(
                service.worlds.join(world_file_name(&old.world_id))
            )
            .unwrap()
            .schema_version,
            1
        );
        let empty_path = service.worlds.join(world_file_name("native-empty-file"));
        std::fs::write(&empty_path, []).unwrap();
        let unavailable = list_worlds_sync(&service).unwrap();
        assert_eq!(unavailable.unavailable_count, 1);
        assert_eq!(std::fs::metadata(&empty_path).unwrap().len(), 0);
    }

    #[tokio::test]
    async fn native_v2_ten_turn_restart_cancel_stale_head_and_dropped_lease_preserve_state() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(FakeSecrets::default());
        let service = Arc::new(GameService::open(dir.path(), secrets.clone()).unwrap());
        let setup = setup();
        let store = service.store(&setup.world_id, true).unwrap();
        let mut view = store.create_world(&setup).unwrap();
        assert!(matches!(&view, WorldReply::V2(_)));
        for (index, text) in [
            "购买补给",
            "做短工赚钱",
            "赶路时受伤",
            "休息两个小时",
            "打听消息",
            "购买口粮",
            "工作赚钱",
            "打听消息",
            "休息两个小时",
            "整理行囊",
        ]
        .iter()
        .enumerate()
        {
            let request = request(
                &format!("native-v2-turn-{index:08}"),
                &setup.world_id,
                view.head_turn_id().map(str::to_owned),
                text,
            );
            let lease = service
                .turn_lease(Arc::clone(&store), &request.operation_id)
                .unwrap();
            view = run_turn(
                lease,
                request.clone(),
                ProviderKind::Demo,
                progress(&request.operation_id),
            )
            .await
            .unwrap();
            assert_eq!(view.turn_count(), index as u64 + 1);
            assert_eq!(
                view.latest_operation().unwrap().status,
                GameOperationStatus::Committed
            );
        }
        let state = serde_json::to_value(view.state()).unwrap();
        let head = view.head_turn_id().map(str::to_owned);
        let stale = request("native-v2-stale-head", &setup.world_id, None, "购买补给");
        let lease = service
            .turn_lease(Arc::clone(&store), &stale.operation_id)
            .unwrap();
        assert_eq!(
            run_turn(
                lease,
                stale.clone(),
                ProviderKind::Demo,
                progress(&stale.operation_id)
            )
            .await
            .unwrap_err()
            .code,
            "game_stale_head"
        );
        assert_eq!(store.view().unwrap().turn_count(), 10);
        let cancelled = request(
            "native-v2-cancelled",
            &setup.world_id,
            head.clone(),
            "购买补给",
        );
        let lease = service
            .turn_lease(Arc::clone(&store), &cancelled.operation_id)
            .unwrap();
        lease.cancel.cancel();
        let cancelled_view = run_turn(
            lease,
            cancelled.clone(),
            ProviderKind::Demo,
            progress(&cancelled.operation_id),
        )
        .await
        .unwrap();
        assert_eq!(serde_json::to_value(cancelled_view.state()).unwrap(), state);
        assert_eq!(
            cancelled_view.latest_operation().unwrap().status,
            GameOperationStatus::Cancelled
        );
        let dropped = request(
            "native-v2-dropped",
            &setup.world_id,
            head.clone(),
            "购买补给",
        );
        let lease = service
            .turn_lease(Arc::clone(&store), &dropped.operation_id)
            .unwrap();
        store.begin(&dropped).unwrap();
        drop(lease);
        let dropped_view = store.view().unwrap();
        assert_eq!(
            dropped_view.latest_operation().unwrap().status,
            GameOperationStatus::Interrupted
        );
        assert_eq!(serde_json::to_value(dropped_view.state()).unwrap(), state);
        assert!(service.active.lock().unwrap().is_none());
        let actor = service.actor_view_sync(&setup.world_id, "player").unwrap();
        assert_eq!(actor["headTurnId"], serde_json::json!(head));
        assert!(actor["observedFacts"].as_array().unwrap().len() > 4);
        drop(store);
        drop(service);
        let reopened = GameService::open(dir.path(), secrets).unwrap();
        let view = reopened
            .store(&setup.world_id, false)
            .unwrap()
            .view()
            .unwrap();
        assert_eq!(view.turn_count(), 10);
        assert_eq!(view.head_turn_id().map(str::to_owned), head);
        assert_eq!(serde_json::to_value(view.state()).unwrap(), state);
    }

    #[test]
    fn native_explicit_upgrade_checks_cas_leases_and_keeps_provider_credentials_separate() {
        let dir = tempfile::tempdir().unwrap();
        let secrets = Arc::new(FakeSecrets::default());
        let service = Arc::new(GameService::open(dir.path(), secrets.clone()).unwrap());
        let setup = setup();
        seed_legacy(&service, &setup, 2);
        let profile = save_provider_sync(
            &service,
            "https://example.com/v1/chat/completions",
            "fixture",
            Some(SecretValue::new("invalid-native-upgrade-fixture-key".into()).unwrap()),
            0,
            false,
        )
        .unwrap();
        let profile_json = serde_json::to_value(&profile).unwrap();
        let borrowed = service.store(&setup.world_id, false).unwrap();
        let before = borrowed.view().unwrap();
        let head = before.head_turn_id().map(str::to_owned);
        assert_eq!(
            service
                .upgrade_sync(&setup.world_id, head.as_deref())
                .unwrap_err()
                .code,
            "game_migration_busy"
        );
        let lease = service
            .turn_lease(Arc::clone(&borrowed), "native-upgrade-active")
            .unwrap();
        assert_eq!(
            service
                .upgrade_sync(&setup.world_id, head.as_deref())
                .unwrap_err()
                .code,
            "game_migration_busy"
        );
        drop(lease);
        drop(borrowed);
        assert_eq!(
            service
                .upgrade_sync(&setup.world_id, None)
                .unwrap_err()
                .code,
            "game_migration_conflict"
        );
        assert!(!service.backups.exists());
        let upgraded = service
            .upgrade_sync(&setup.world_id, head.as_deref())
            .unwrap();
        assert!(matches!(&upgraded, WorldReply::V2(_)));
        assert_eq!(upgraded.head_turn_id(), before.head_turn_id());
        assert_eq!(upgraded.turn_count(), before.turn_count());
        assert_eq!(
            serde_json::to_value(service.providers.view().unwrap()).unwrap(),
            profile_json
        );
        assert_eq!(
            saved_credential(&service).unwrap().1.expose_secret(),
            "invalid-native-upgrade-fixture-key"
        );
        assert!(!serde_json::to_string(&upgraded)
            .unwrap()
            .contains("invalid-native-upgrade-fixture-key"));
        let backups: Vec<_> = std::fs::read_dir(&service.backups)
            .unwrap()
            .map(Result::unwrap)
            .filter(|entry| entry.path().extension().is_some_and(|ext| ext == "sqlite"))
            .collect();
        assert_eq!(backups.len(), 1);
        assert_eq!(
            lishi_core::game_inspection::inspect_world(backups[0].path())
                .unwrap()
                .schema_version,
            1
        );
        let actor = service.actor_view_sync(&setup.world_id, "player").unwrap();
        let observed_cash = actor["observedFacts"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["factKey"]["type"] == "resource")
            .unwrap();
        if let WorldReply::V1(v) = &before {
            assert_eq!(
                observed_cash["value"]["amount"],
                v.state.resources[0].amount
            );
        }
        assert_eq!(
            service
                .actor_view_sync(&setup.world_id, "missing-actor")
                .unwrap_err()
                .code,
            "game_invalid_request"
        );
        service
            .upgrade_sync(&setup.world_id, head.as_deref())
            .unwrap();
        let backup_count = std::fs::read_dir(&service.backups)
            .unwrap()
            .map(Result::unwrap)
            .filter(|e| e.path().extension().is_some_and(|ext| ext == "sqlite"))
            .count();
        assert_eq!(backup_count, 1);
    }

    #[test]
    fn native_world_reply_keeps_original_shape_and_rejects_cross_version_outputs() {
        let dir = tempfile::tempdir().unwrap();
        let service = GameService::open(dir.path(), Arc::new(FakeSecrets::default())).unwrap();
        let old = setup();
        seed_legacy(&service, &old, 1);
        let v1_store = service.store(&old.world_id, false).unwrap();
        let v1 = v1_store.view().unwrap();
        let mut fresh = old.clone();
        fresh.world_id = "native-shape-v2".into();
        let v2_store = service.store(&fresh.world_id, true).unwrap();
        let v2 = v2_store.create_world(&fresh).unwrap();
        let v1_json = serde_json::to_value(&v1).unwrap();
        let v2_json = serde_json::to_value(&v2).unwrap();
        if let WorldReply::V1(view) = &v1 {
            assert_eq!(v1_json, serde_json::to_value(view).unwrap());
        } else {
            panic!("legacy world was automatically upgraded");
        }
        if let WorldReply::V2(view) = &v2 {
            assert_eq!(v2_json, serde_json::to_value(view).unwrap());
        } else {
            panic!("new world did not use v2");
        }
        assert_eq!(v1_json["state"]["protocolVersion"], 1);
        assert_eq!(v2_json["state"]["protocolVersion"], 2);
        assert_eq!(
            v1_json.as_object().unwrap().keys().collect::<Vec<_>>(),
            v2_json.as_object().unwrap().keys().collect::<Vec<_>>()
        );
        let request_v1 = request(
            "native-shape-op1",
            &old.world_id,
            v1.head_turn_id().map(str::to_owned),
            "购买補给",
        );
        let request_v2 = request("native-shape-op2", &fresh.world_id, None, "购买补给");
        let output_v1 = StoreRoute::demo_output(&v1, &request_v1).unwrap();
        let output_v2 = StoreRoute::demo_output(&v2, &request_v2).unwrap();
        assert!(StoreRoute::parse_output(&v1, &output_v2.json().unwrap()).is_err());
        assert!(StoreRoute::parse_output(&v2, &output_v1.json().unwrap()).is_err());
        assert_eq!(
            output_v1
                .validate_against(&v2, &request_v2.operation_id)
                .unwrap_err()
                .code,
            "game_invalid_protocol"
        );
        assert_eq!(
            output_v2
                .validate_against(&v1, &request_v1.operation_id)
                .unwrap_err()
                .code,
            "game_invalid_protocol"
        );
        assert_eq!(v1_store.view().unwrap(), v1);
        assert_eq!(v2_store.view().unwrap(), v2);
    }

    #[test]
    fn native_v2_commit_cancellation_rolls_back_and_readonly_discovery_keeps_live_operation() {
        let dir = tempfile::tempdir().unwrap();
        let service =
            Arc::new(GameService::open(dir.path(), Arc::new(FakeSecrets::default())).unwrap());
        let setup = setup();
        let store = service.store(&setup.world_id, true).unwrap();
        let before = store.create_world(&setup).unwrap();
        let request = request("native-hook-cancel-001", &setup.world_id, None, "购买补给");
        let lease = service
            .turn_lease(Arc::clone(&store), &request.operation_id)
            .unwrap();
        store.begin(&request).unwrap();
        store.mark_generating(&request.operation_id).unwrap();
        let output = StoreRoute::demo_output(&before, &request).unwrap();
        store
            .stage_output(&request.operation_id, &output.json().unwrap())
            .unwrap();
        let listed = list_worlds_sync(&service).unwrap();
        assert_eq!(listed.worlds.len(), 1);
        assert_eq!(listed.worlds[0].turn_count, 0);
        assert_eq!(
            store.view().unwrap().latest_operation().unwrap().status,
            GameOperationStatus::Validating
        );
        assert_eq!(
            service
                .upgrade_sync(&setup.world_id, None)
                .unwrap_err()
                .code,
            "game_migration_busy"
        );
        assert_eq!(
            service
                .turn_lease(Arc::clone(&store), "native-concurrent-turn")
                .err()
                .unwrap()
                .code,
            "game_busy"
        );
        let result = store.commit_with_hook(&request.operation_id, &output, || {
            lease.cancel.cancel();
            Err(GameStoreError::Cancelled)
        });
        assert_eq!(result.unwrap_err().code, "game_cancelled");
        let cancelled = store.view().unwrap();
        assert_eq!(cancelled.head_turn_id(), before.head_turn_id());
        assert_eq!(cancelled.turn_count(), 0);
        assert_eq!(
            serde_json::to_value(cancelled.state()).unwrap(),
            serde_json::to_value(before.state()).unwrap()
        );
        store
            .finish_uncommitted(
                &request.operation_id,
                GameOperationStatus::Cancelled,
                Some("game_cancelled"),
            )
            .unwrap();
        drop(lease);
        assert_eq!(
            store.view().unwrap().latest_operation().unwrap().status,
            GameOperationStatus::Cancelled
        );
        assert!(service.active.lock().unwrap().is_none());
        assert_eq!(store.begin(&request).unwrap_err().code, "game_duplicate");
    }

    #[test]
    fn native_explicit_upgrade_reports_external_owner_busy_without_uncertain_write() {
        let dir = tempfile::tempdir().unwrap();
        let service = GameService::open(dir.path(), Arc::new(FakeSecrets::default())).unwrap();
        let setup = setup();
        seed_legacy(&service, &setup, 1);
        let file = service.worlds.join(world_file_name(&setup.world_id));
        let external = GameStore::open(&file).unwrap();
        let before = external.view().unwrap();
        assert_eq!(
            service
                .upgrade_sync(&setup.world_id, before.head_turn_id.as_deref())
                .unwrap_err()
                .code,
            "game_migration_busy"
        );
        assert_eq!(external.view().unwrap(), before);
        assert_eq!(
            lishi_core::game_inspection::inspect_world(&file)
                .unwrap()
                .schema_version,
            1
        );
        assert!(service.stores.lock().unwrap().is_empty());
        assert_eq!(std::fs::read_dir(&service.backups).unwrap().count(), 0);
        drop(external);
        let upgraded = service
            .upgrade_sync(&setup.world_id, before.head_turn_id.as_deref())
            .unwrap();
        assert!(matches!(upgraded, WorldReply::V2(_)));
        assert_eq!(upgraded.turn_count(), 1);
    }

    #[test]
    fn native_actor_query_does_not_expose_unobserved_global_entity_or_npc_private_view() {
        use lishi_core::game_protocol_v2::{
            Disclosure, EntityInput, EventInput, StateChangeV2, TimeAdvanceV2, TurnOutputV2,
        };
        let dir = tempfile::tempdir().unwrap();
        let service = GameService::open(dir.path(), Arc::new(FakeSecrets::default())).unwrap();
        let setup = setup();
        let store = service.store(&setup.world_id, true).unwrap();
        store.create_world(&setup).unwrap();
        let request = request(
            "native-hidden-entity-001",
            &setup.world_id,
            None,
            "按固定夹具创建隐藏人物。",
        );
        let output = TurnOutputV2 {
            protocol_version: 2,
            narrative: "这里只是固定测试剧情。".into(),
            choices: Vec::new(),
            time_advance: TimeAdvanceV2 {
                elapsed_seconds: 0,
                event_id: None,
            },
            state_changes: vec![StateChangeV2::CreateEntity {
                entity: EntityInput {
                    id: "hidden-person".into(),
                    kind: lishi_core::game_protocol::EntityKind::Person,
                    name: "隐藏身份甲".into(),
                    alive: Some(true),
                    attributes: BTreeMap::from([("secret".into(), "未获知的秘密标记".into())]),
                },
                event_id: "hidden-event".into(),
            }],
            events: vec![EventInput {
                id: "hidden-event".into(),
                description: "不可向未获知角色广播的事件内容。".into(),
                entity_ids: vec!["hidden-person".into()],
                disclosure: Disclosure::Restricted,
            }],
            source_references: Vec::new(),
            uncertainties: Vec::new(),
        };
        store.begin(&request).unwrap();
        store.mark_generating(&request.operation_id).unwrap();
        store
            .stage_output(
                &request.operation_id,
                &serde_json::to_string(&output).unwrap(),
            )
            .unwrap();
        store
            .commit_with_hook(&request.operation_id, &OutputRoute::V2(output), || Ok(()))
            .unwrap();
        let view = service.actor_view_sync(&setup.world_id, "player").unwrap();
        let json = serde_json::to_string(&view).unwrap();
        assert!(!json.contains("隐藏身份甲"));
        assert!(!json.contains("未获知的秘密标记"));
        assert!(!json.contains("不可向未获知角色广播"));
        assert_eq!(
            service
                .actor_view_sync(&setup.world_id, "hidden-person")
                .unwrap_err()
                .code,
            "game_invalid_request"
        );
        assert_eq!(view["worldId"], setup.world_id);
        assert_eq!(view["actorId"], "player");
        assert_eq!(view["headTurnId"], request.operation_id);
    }
}
