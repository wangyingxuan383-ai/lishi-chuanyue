//! Native transport for formal worlds. The database owns facts; UI events are
//! provisional. Secrets, profiles and world files have separate lifetimes.
use lishi_core::{
    game_protocol::{self, WorldSetup},
    game_provider::{self, Capability, ProviderKind, ProviderStore, ProviderView, StoredProvider},
    game_store::{GameOperationStatus, GameStore, GameStoreError, GameTurnRequest, WorldView},
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
    stores: Mutex<BTreeMap<String, Arc<GameStore>>>,
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
            stores: Mutex::new(BTreeMap::new()),
            providers: Arc::new(ProviderStore::open(directory.join("game-settings.sqlite"))?),
            secrets,
            profile_busy: Arc::new(AtomicBool::new(false)),
            probe_busy: Arc::new(AtomicBool::new(false)),
            active: Mutex::new(None),
        })
    }
    fn store(&self, id: &str, create: bool) -> Result<Arc<GameStore>, GameCommandError> {
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
        let store = Arc::new(GameStore::open(&file)?);
        if !create && store.view()?.setup.world_id != id {
            return Err(GameCommandError::new("game_invalid_request"));
        }
        stores.insert(id.into(), Arc::clone(&store));
        Ok(store)
    }
    fn profile_lease(&self) -> Result<ProfileLease, GameCommandError> {
        self.profile_busy
            .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
            .map_err(|_| GameCommandError::new("game_provider_busy"))?;
        Ok(ProfileLease(Arc::clone(&self.profile_busy)))
    }
    fn turn_lease(
        self: &Arc<Self>,
        store: Arc<GameStore>,
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
    store: Arc<GameStore>,
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
    blocking(move || {
        let mut result = WorldList {
            worlds: Vec::new(),
            unavailable_count: 0,
        };
        for entry in std::fs::read_dir(&service.worlds)
            .map_err(|_| GameCommandError::new("game_database"))?
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
            let candidate = (|| -> Result<WorldView, GameCommandError> {
                let mut stores = service
                    .stores
                    .lock()
                    .map_err(|_| GameCommandError::new("game_unavailable"))?;
                if let Some(store) = stores
                    .iter()
                    .find(|(id, _)| world_file_name(id) == file_name)
                    .map(|(_, s)| s)
                {
                    return Ok(store.view()?);
                }
                let store = Arc::new(GameStore::open(entry.path())?);
                let view = store.view()?;
                if world_file_name(&view.setup.world_id) != file_name {
                    return Err(GameCommandError::new("game_invalid_request"));
                }
                stores.insert(view.setup.world_id.clone(), store);
                Ok(view)
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
    })
    .await
}
#[tauri::command]
pub async fn create_game_world(
    setup: WorldSetup,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldView, GameCommandError> {
    game_protocol::validate_setup(&setup)?;
    let service = Arc::clone(service.inner());
    blocking(move || {
        let state = game_protocol::initial_state(&setup)?;
        let store = service.store(&setup.world_id, true)?;
        Ok(store.create_world(
            &setup,
            &state,
            &game_provider::opening_narrative(&setup),
            &game_provider::initial_choices(),
        )?)
    })
    .await
}
#[tauri::command]
pub async fn get_game_world(
    world_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldView, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || Ok(service.store(&world_id, false)?.view()?)).await
}
#[tauri::command]
pub async fn set_game_policy(
    world_id: String,
    policy: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<WorldView, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        let store = service.store(&world_id, false)?;
        store.update_policy(&policy)?;
        Ok(store.view()?)
    })
    .await
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
) -> Result<WorldView, GameCommandError> {
    let store = Arc::clone(&lease.store);
    let request_copy = request.clone();
    let view = blocking(move || {
        let view = store.view()?;
        if view
            .state
            .entities
            .iter()
            .find(|e| e.id == view.state.protagonist_id)
            .is_some_and(|e| e.alive == Some(false))
        {
            return Err(GameCommandError::new("game_protagonist_dead"));
        }
        store.begin(&request_copy)?;
        Ok(store.view()?)
    })
    .await?;
    progress.phase("pending");
    let generation:Result<game_protocol::TurnOutput,GameCommandError>=async {
        if lease.cancel.is_cancelled(){return Err(GameCommandError::new("game_cancelled"))}
        let store=Arc::clone(&lease.store);let id=lease.id.clone();blocking(move||{store.mark_generating(&id)?;Ok(())}).await?;
        progress.phase("generating");
        let output=match provider_kind {
            ProviderKind::Demo=>{
                // A small cancellable boundary makes the demo honest about its
                // provisional stage, without faking model token streaming.
                tokio::select!{biased;_ = lease.cancel.cancelled()=>return Err(GameCommandError::new("game_cancelled")),
                    _=tokio::time::sleep(Duration::from_millis(180))=>{}}
                game_provider::demo_output(&view.state,&request)?
            }
            ProviderKind::Compatible=>{
                #[cfg(target_os="android")]
                if !crate::android_tls::is_ready(){return Err(GameCommandError::new("model_tls_unavailable"))}
                let prompt=game_provider::compile_game_prompt(&view,&request)?;
                let (profile,key)=profile_work(Arc::clone(&lease.service),|s|saved_credential(&s)).await?;
                let policy=if profile.config.allow_insecure_http{SavedEndpointPolicy::ExplicitHttp}else{SavedEndpointPolicy::HttpsOnly};
                let result=lishi_core::model_probe::run_model_probe_with_endpoint_policy(ModelProbeRequest{operation_id:request.operation_id.clone(),
                    endpoint:profile.config.endpoint,model:profile.config.model,prompt,include_usage:false,credential_mode:CredentialMode::Saved},
                    Some(key),lease.cancel.clone(),game_provider::production_stream_options(),policy,|_|true).await;
                if result.stream.status==StreamStatus::Cancelled{return Err(GameCommandError::new("game_cancelled"))}
                if result.stream.status!=StreamStatus::Completed {
                    let code=result.stream.error_code.and_then(|e|serde_json::to_value(e).ok()).and_then(|v|v.as_str().map(str::to_owned))
                        .unwrap_or_else(||"game_provider_failed".into());return Err(GameCommandError::new(code));
                }
                lease.service.providers.record_streaming(profile.config.revision,Capability::Supported)?;
                game_protocol::parse_output(&result.stream.text)?
            }
        };
        game_protocol::apply_output(&view.state,&output)?;
        if lease.cancel.is_cancelled(){return Err(GameCommandError::new("game_cancelled"))}
        // Never stream raw JSON or reasoning. Display only a decoded, still
        // provisional narrative; the state is updated solely by SQL commit.
        progress.send("narrative",None,Some(output.narrative.clone()),None);
        let raw=serde_json::to_string(&output).map_err(|_|GameCommandError::new("game_invalid_output"))?;
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
                Ok(store.view()?)
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
            return Ok(store.view()?);
        }
        // The hook runs inside the short transaction immediately before commit.
        Ok(store.commit_with_hook(&id, &output, || {
            if cancel.is_cancelled() {
                Err(GameStoreError::Cancelled)
            } else {
                Ok(())
            }
        })?)
    })
    .await;
    match committed {
        Ok(view) => {
            lease.done = true;
            progress.phase(
                if view
                    .latest_operation
                    .as_ref()
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
                Ok(store.view()?)
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
) -> Result<WorldView, GameCommandError> {
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
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ProviderView, GameCommandError> {
    let token = token
        .map(SecretValue::new)
        .transpose()
        .map_err(|_| GameCommandError::new("secret_invalid_value"))?;
    let allow_insecure_http = allow_insecure_http.unwrap_or(false);
    game_provider::validate_config_with_http_opt_in(&endpoint, &model, allow_insecure_http)?;
    profile_work(Arc::clone(service.inner()), move |service| {
        save_provider_sync(
            &service,
            &endpoint,
            &model,
            token,
            expected_revision,
            allow_insecure_http,
        )
    })
    .await
}
fn save_provider_sync(
    service: &GameService,
    endpoint: &str,
    model: &str,
    token: Option<SecretValue>,
    expected_revision: u64,
    allow_insecure_http: bool,
) -> Result<ProviderView, GameCommandError> {
    game_provider::validate_config_with_http_opt_in(endpoint, model, allow_insecure_http)?;
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
    let result = service.providers.save_with_http_opt_in(
        endpoint,
        model,
        &slot,
        expected_revision,
        allow_insecure_http,
    );
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
            store
                .create_world(
                    setup,
                    &game_protocol::initial_state(setup).unwrap(),
                    &game_provider::opening_narrative(setup),
                    &game_provider::initial_choices(),
                )
                .unwrap();
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
                .setup
                .world_id,
            first.world_id
        );
        assert_eq!(
            service
                .store(&second.world_id, false)
                .unwrap()
                .view()
                .unwrap()
                .setup
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
        let store = service.store(&setup.world_id, true).unwrap();
        store
            .create_world(
                &setup,
                &game_protocol::initial_state(&setup).unwrap(),
                &game_provider::opening_narrative(&setup),
                &game_provider::initial_choices(),
            )
            .unwrap();
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
        assert_eq!(committed.turn_count, 1);
        assert_eq!(committed.state.resources[0].amount, 95);
        let request = GameTurnRequest {
            operation_id: "native-operation-two".into(),
            expected_head_turn_id: committed.head_turn_id.clone(),
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
        assert_eq!(cancelled.state, committed.state);
        assert_eq!(cancelled.head_turn_id, committed.head_turn_id);
        assert_eq!(
            cancelled.latest_operation.unwrap().status,
            GameOperationStatus::Cancelled
        );
        assert!(service.active.lock().unwrap().is_none());
    }
}
