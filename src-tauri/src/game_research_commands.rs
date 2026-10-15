//! Search is an independent operation. Evidence never writes formal facts.
use super::{blocking, profile_work, ActiveTurn, GameCommandError, GameService, StoreRoute};
use lishi_core::{
    game_context::{ContextFragment, ContextFragmentKind, ContextFragmentStatus},
    game_knowledge::ValidatedHistory,
    game_research::{
        temporal_warnings, BraveResearchConfig, BraveResearchProvider, ResearchConclusion,
        ResearchEra, ResearchProvider, ResearchQuery, ResearchTopic, TemporalWarning,
    },
    game_research_store::{
        ResearchAdoption, ResearchBranchAccess, ResearchOperation, ResearchRecord, ResearchScope,
        ResearchStore,
    },
    secrets::{SecretSlot, SecretValue},
    CancellationToken,
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::sync::Arc;
fn err(e: impl std::fmt::Display) -> GameCommandError {
    GameCommandError::new(e.to_string())
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchProfile {
    pub configured: bool,
    pub revision: u64,
    pub config: Option<BraveResearchConfig>,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ResearchReply {
    pub world_id: String,
    pub branch_id: String,
    pub head_turn_id: Option<String>,
    pub cached: bool,
    pub operation: Option<ResearchOperation>,
    pub record: Option<ResearchRecord>,
    pub warnings: Vec<TemporalWarning>,
}
fn profile(s: &ResearchStore) -> Result<ResearchProfile, GameCommandError> {
    let stored = s.stored_config().map_err(err)?;
    Ok(ResearchProfile {
        configured: stored.as_ref().is_some_and(|p| p.secret_slot.is_some()),
        revision: s.config_revision().map_err(err)?,
        config: stored.map(|p| p.config),
    })
}
pub(super) fn scope(
    store: &lishi_core::game_store_v2::GameStoreV2,
    view: &lishi_core::game_store_v2::WorldViewV2,
) -> Result<ResearchScope, GameCommandError> {
    if !store.branches_enabled()? {
        return Ok(ResearchScope::single(
            lishi_core::game_context::ContextScope::from_view(view),
        ));
    }
    let context = store.read_branch_context(&view.branch_id)?;
    if context.view.head_turn_id != view.head_turn_id || context.view.state != view.state {
        return Err(GameCommandError::new("game_stale_head"));
    }
    let path = &context.annotation_scope.branch_path;
    let mut branches = Vec::new();
    for (index, access) in path.iter().enumerate() {
        branches.push(ResearchBranchAccess {
            branch_id: access.branch_id.clone(),
            through_turn_id: access.through_turn_id.clone(),
            through_change_seq: match path.get(index + 1) {
                Some(child) => Some(store.research_fork_watermark(&child.branch_id)?),
                None => None,
            },
        });
    }
    Ok(ResearchScope {
        context: context.annotation_scope.context,
        branch_path: branches,
    })
}
pub(super) fn fragments(
    s: &GameService,
    store: &lishi_core::game_store_v2::GameStoreV2,
    view: &lishi_core::game_store_v2::WorldViewV2,
    history: &ValidatedHistory,
) -> Result<Vec<ContextFragment>, GameCommandError> {
    let scope = scope(store, view)?;
    let adopted = match s.research().and_then(|store|store.adopted(&scope,history).map_err(err)){
        Ok(records)=>records,
        Err(_)=>return Ok(vec![ContextFragment{id:"historical-research-unavailable".into(),scope:scope.context.clone(),kind:ContextFragmentKind::HistoricalEvidence,status:ContextFragmentStatus::Committed,source_turn_ids:vec![],body:"历史研究资料目前无法读取；没有可引用来源，请标明历史不确定性，不以资料替换正式世界事实。".into(),relevance:1}])
    };
    let mut fragments = Vec::new();
    for adoption in adopted.iter().rev().take(16) {
        let record = &adoption.evidence;
        // Serialize selected evidence as inert data. Conclusions retain uncertainty;
        // requested-era tags are never treated as verified historical dates.
        let body=serde_json::to_string(&serde_json::json!({"untrustedHistoricalEvidence":record,"historicalBaselineOnly":true,"cannotOverrideWorldFacts":true})).map_err(err)?;
        fragments.push(ContextFragment {
            id: format!("research-{}", adoption.id),
            scope: scope.context.clone(),
            kind: ContextFragmentKind::HistoricalEvidence,
            status: ContextFragmentStatus::Committed,
            source_turn_ids: adoption.head_turn_id.iter().cloned().collect(),
            body,
            relevance: 1,
        });
    }
    Ok(fragments)
}
#[tauri::command]
pub async fn get_game_research_profile(
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ResearchProfile, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || profile(s.research()?.as_ref())).await
}
#[tauri::command]
pub async fn save_game_research_profile(
    config: BraveResearchConfig,
    token: Option<String>,
    expected_revision: u64,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ResearchProfile, GameCommandError> {
    let s = Arc::clone(service.inner());
    profile_work(s, move |s| {
        BraveResearchProvider::new(config.clone()).map_err(err)?;
        if s.research()?.config_revision().map_err(err)? != expected_revision {
            return Err(GameCommandError::new("research_Conflict"));
        }
        let old = s.research()?.stored_config().map_err(err)?;
        let new = if let Some(token) = token {
            let slot = SecretSlot::new(&format!(
                "research-key-{:x}-{:x}",
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_err(err)?
                    .as_nanos(),
                super::KEY_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ))
            .map_err(err)?;
            let value = SecretValue::new(token).map_err(err)?;
            s.secrets.save(&slot, &value).map_err(err)?;
            Some(slot)
        } else {
            None
        };
        let slot = new
            .as_ref()
            .map(|v| v.as_str().to_owned())
            .or_else(|| old.as_ref().and_then(|p| p.secret_slot.clone()));
        if let Err(problem) = s.research()?.save_config(config, slot, expected_revision) {
            if let Some(slot) = new {
                let _ = s.secrets.delete(&slot);
            }
            return Err(err(problem));
        }
        if new.is_some() {
            if let Some(old) = old.and_then(|p| p.secret_slot) {
                if let Ok(slot) = SecretSlot::new(&old) {
                    let _ = s.secrets.delete(&slot);
                }
            }
        }
        profile(s.research()?.as_ref())
    })
    .await
}
#[tauri::command]
pub async fn delete_game_research_profile(
    expected_revision: u64,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ResearchProfile, GameCommandError> {
    let s = Arc::clone(service.inner());
    profile_work(s, move |s| {
        let old = s.research()?.stored_config().map_err(err)?;
        s.research()?.clear_config(expected_revision).map_err(err)?;
        if let Some(old) = old.and_then(|p| p.secret_slot) {
            if let Ok(slot) = SecretSlot::new(&old) {
                let _ = s.secrets.delete(&slot);
            }
        }
        profile(s.research()?.as_ref())
    })
    .await
}
struct ResearchLease {
    service: Arc<GameService>,
    id: String,
    cancel: CancellationToken,
    done: bool,
}
impl Drop for ResearchLease {
    fn drop(&mut self) {
        if !self.done {
            self.cancel.cancel();
            if let Ok(store) = self.service.research() {
                let _ = store.cancel(&self.id);
            }
        }
        if let Ok(mut active) = self.service.active.lock() {
            if active.as_ref().is_some_and(|a| a.id == self.id) {
                *active = None;
            }
        }
    }
}
impl ResearchLease {
    fn acquire(service: Arc<GameService>, id: &str) -> Result<Self, GameCommandError> {
        let cancel = CancellationToken::new();
        {
            let mut active = service.active.lock().map_err(err)?;
            if active.is_some() {
                return Err(GameCommandError::new("game_busy"));
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
            done: false,
        })
    }
}
pub(super) async fn search(
    s: Arc<GameService>,
    query: ResearchQuery,
    id: String,
    force: bool,
    cancel: CancellationToken,
) -> Result<(Option<ResearchOperation>, Option<ResearchRecord>, bool), GameCommandError> {
    query.validate().map_err(err)?;
    let store = s.research()?;
    let q = query.clone();
    let frozen = blocking(move || {
        store
            .stored_config()
            .map_err(err)?
            .ok_or_else(|| GameCommandError::new("research_config_missing"))
    })
    .await?;
    let provider = BraveResearchProvider::new(frozen.config.clone()).map_err(err)?;
    if !force {
        let store = s.research()?;
        let namespace = provider.cache_namespace();
        if let Some(record) = blocking(move || {
            store
                .cached(&q, &namespace, 24 * 60 * 60 * 1000)
                .map_err(err)
        })
        .await?
        {
            let store = s.research()?;
            let operation_id = id.clone();
            let q = query.clone();
            let namespace = provider.cache_namespace();
            let record_id = record.id.clone();
            let operation = blocking(move || {
                store
                    .record_cached_operation(&operation_id, &q, &namespace, &record_id)
                    .map_err(err)
            })
            .await?;
            return Ok((Some(operation), Some(record), true));
        }
    }
    let key_s = Arc::clone(&s);
    let revision = frozen.revision;
    let key = profile_work(key_s, move |s| {
        let current = s
            .research()?
            .stored_config()
            .map_err(err)?
            .ok_or_else(|| GameCommandError::new("research_config_missing"))?;
        if current.revision != revision {
            return Err(GameCommandError::new("research_Conflict"));
        }
        let slot = SecretSlot::new(
            current
                .secret_slot
                .as_deref()
                .ok_or_else(|| GameCommandError::new("research_key_missing"))?,
        )
        .map_err(err)?;
        s.secrets
            .load(&slot)
            .map_err(err)?
            .ok_or_else(|| GameCommandError::new("research_key_missing"))
    })
    .await?;
    let operation = s
        .research()?
        .run_search(&id, &query, &provider, Some(key), cancel)
        .await
        .map_err(err)?;
    let store = s.research()?;
    let record_id = operation.record_id.clone();
    let record = blocking(move || match record_id {
        Some(id) => store.record(&id).map_err(err),
        None => Ok(None),
    })
    .await?;
    Ok((Some(operation), record, false))
}
#[tauri::command]
pub async fn research_game_history(
    world_id: String,
    branch_id: String,
    expected_head_turn_id: Option<String>,
    operation_id: String,
    query: ResearchQuery,
    force_refresh: bool,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ResearchReply, GameCommandError> {
    let s = Arc::clone(service.inner());
    let lease = ResearchLease::acquire(Arc::clone(&s), &operation_id)?;
    tauri::async_runtime::spawn(async move {
        let mut lease = lease;
        let owner = Arc::clone(&s);
        let world = world_id.clone();
        let branch = branch_id.clone();
        let head = expected_head_turn_id.clone();
        let view = blocking(move || {
            let route = owner.store(&world, false)?;
            let view = route.view_branch(&branch)?;
            if view.head_turn_id() != head.as_deref() {
                return Err(GameCommandError::new("game_stale_head"));
            }
            Ok(view)
        })
        .await?;
        let (operation, record, cached) = search(
            Arc::clone(&s),
            query,
            operation_id,
            force_refresh,
            lease.cancel.clone(),
        )
        .await?;
        let (era_year, elapsed_seconds) = match view.state() {
            super::runtime::StateReply::V1(v) => (v.time.era_year, v.time.elapsed_seconds),
            super::runtime::StateReply::V2(v) => (v.time.era_year, v.time.elapsed_seconds),
        };
        let calendar =
            lishi_core::game_calendar::calendar_range(era_year, elapsed_seconds).map_err(err)?;
        let mut warnings = Vec::new();
        if let Some(record) = record.as_ref() {
            for year in [
                calendar.earliest.date.era_year,
                calendar.latest.date.era_year,
            ] {
                for warning in temporal_warnings(&record.conclusions, year).map_err(err)? {
                    if !warnings.contains(&warning) {
                        warnings.push(warning);
                    }
                }
            }
        }
        lease.done = true;
        Ok(ResearchReply {
            world_id,
            branch_id,
            head_turn_id: expected_head_turn_id,
            cached,
            operation,
            record,
            warnings,
        })
    })
    .await
    .map_err(|_| GameCommandError::new("game_worker_failed"))?
}
#[tauri::command]
pub async fn adopt_game_research(
    world_id: String,
    branch_id: String,
    expected_head_turn_id: Option<String>,
    adoption_id: String,
    record_id: String,
    source_ids: Vec<String>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ResearchAdoption, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let active = s.active.lock().map_err(err)?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let route = s.store(&world_id, false)?;
        let StoreRoute::V2(store) = route.as_ref() else {
            return Err(GameCommandError::new("game_upgrade_required"));
        };
        if !store.branches_enabled()? {
            return Err(GameCommandError::new("game_upgrade_required"));
        }
        let view = store.selected_view(&branch_id)?;
        if view.head_turn_id != expected_head_turn_id {
            return Err(GameCommandError::new("game_stale_head"));
        }
        let history = store.selected_history(&branch_id)?;
        let scope = scope(store, &view)?;
        s.research()?
            .adopt(&scope, &history, &adoption_id, &record_id, &source_ids)
            .map_err(err)
    })
    .await
}
#[tauri::command]
pub async fn list_game_research(
    world_id: String,
    branch_id: String,
    expected_head_turn_id: Option<String>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<Vec<ResearchRecord>, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        let route = s.store(&world_id, false)?;
        let StoreRoute::V2(store) = route.as_ref() else {
            return Ok(vec![]);
        };
        let view = store.selected_view(&branch_id)?;
        if view.head_turn_id != expected_head_turn_id {
            return Err(GameCommandError::new("game_stale_head"));
        }
        let history = store.selected_history(&branch_id)?;
        let scope = scope(store, &view)?;
        let adopted = s.research()?.adopted(&scope, &history).map_err(err)?;
        let records = adopted.into_iter().map(|a| a.evidence).collect();
        Ok(records)
    })
    .await
}
pub(super) fn allowed_sources(
    s: &GameService,
    store: &lishi_core::game_store_v2::GameStoreV2,
    view: &lishi_core::game_store_v2::WorldViewV2,
    history: &ValidatedHistory,
) -> Result<Vec<String>, GameCommandError> {
    let scope = scope(store, view)?;
    let adopted = match s
        .research()
        .and_then(|store| store.adopted(&scope, history).map_err(err))
    {
        Ok(records) => records,
        Err(_) => return Ok(vec![]),
    };
    let ids: std::collections::BTreeSet<_> = adopted
        .iter()
        .rev()
        .take(16)
        .flat_map(|a| a.evidence.sources.iter().map(|source| source.id.clone()))
        .collect();
    Ok(ids.into_iter().take(128).collect())
}
#[tauri::command]
pub async fn add_game_research_conclusion(
    record_id: String,
    conclusion: ResearchConclusion,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<ResearchRecord, GameCommandError> {
    let s = Arc::clone(service.inner());
    blocking(move || {
        s.research()?
            .add_conclusion(&record_id, &conclusion)
            .map_err(err)?;
        s.research()?
            .record(&record_id)
            .map_err(err)?
            .ok_or_else(|| GameCommandError::new("research_missing"))
    })
    .await
}
/// Deterministic preflight, at most one bounded independent search. It adds no
/// model analysis requests and never silently writes world facts.
pub(super) async fn preflight(
    s: Arc<GameService>,
    route: Arc<StoreRoute>,
    request: &lishi_core::game_store::GameTurnRequest,
    cancel: CancellationToken,
) -> Result<Option<ContextFragment>, GameCommandError> {
    let topic = if request.action_text.contains("官职") || request.action_text.contains("制度")
    {
        Some(ResearchTopic::Office)
    } else if request.action_text.contains("发明") || request.action_text.contains("技术") {
        Some(ResearchTopic::Technology)
    } else if request.action_text.contains("生卒") || request.action_text.contains("人物") {
        Some(ResearchTopic::Person)
    } else if request.action_text.contains("地名") || request.action_text.contains("交通") {
        Some(ResearchTopic::Place)
    } else if request.action_text.contains("考证") || request.action_text.contains("史实") {
        Some(ResearchTopic::Chronology)
    } else {
        None
    };
    let Some(topic) = topic else { return Ok(None) };
    let Ok(store) = s.research() else {
        return Ok(None);
    };
    if !matches!(
        blocking(move || store.stored_config().map_err(err)).await,
        Ok(Some(_))
    ) {
        return Ok(None);
    }
    let current = route.view_branch(&request.branch_id)?;
    let super::WorldReply::V2(view) = current else {
        return Ok(None);
    };
    let range = match lishi_core::game_calendar::calendar_range(
        view.state.time.era_year,
        view.state.time.elapsed_seconds,
    ) {
        Ok(range) => range,
        Err(_) => return Ok(None),
    };
    let requested_era = ResearchEra {
        start_year: range.earliest.date.era_year,
        end_year: range.latest.date.era_year,
    };
    let query = ResearchQuery {
        query: format!(
            "{} 公元纪年{} {} {}",
            view.setup.country,
            requested_era.start_year,
            view.setup.location_name,
            request.action_text.chars().take(300).collect::<String>()
        ),
        topic,
        era: Some(requested_era),
        entity_tags: vec![],
        region: None,
    };
    let id = format!(
        "research-{:x}",
        Sha256::digest(request.operation_id.as_bytes())
    );
    let id = id[..48].to_owned();
    // Failure leaves explicit diagnostics and uncertainty, while ordinary play
    // may proceed. A cancellation still terminates the enclosing formal request.
    let result = search(Arc::clone(&s), query, id.clone(), false, cancel.clone()).await;
    if cancel.is_cancelled() {
        return Err(GameCommandError::new("game_cancelled"));
    }
    if let Ok((_, Some(record), _)) = result {
        if !record.sources.is_empty() {
            let StoreRoute::V2(store) = route.as_ref() else {
                return Ok(None);
            };
            let scope = scope(store, &view)?;
            let history = store.selected_history(&view.branch_id)?;
            s.research()?
                .adopt(
                    &scope,
                    &history,
                    &format!("adopt-{id}"),
                    &record.id,
                    &record
                        .sources
                        .iter()
                        .map(|r| r.id.clone())
                        .collect::<Vec<_>>(),
                )
                .map_err(err)?;
            return Ok(None);
        }
    }
    Ok(Some(ContextFragment {
        id: format!("uncertain-{id}"),
        scope: lishi_core::game_context::ContextScope::from_view(&view),
        kind: ContextFragmentKind::HistoricalEvidence,
        status: ContextFragmentStatus::Committed,
        source_turn_ids: view.head_turn_id.iter().cloned().collect(),
        body: "本次重要历史问题的独立查询未取得可采用依据。必须在叙事或uncertainties中明确说明相关制度、人物或技术的历史细节尚不确定；可继续本世界线，但不得捏造来源或据此覆盖已有事实。".into(),
        relevance: u32::MAX,
    }))
}
