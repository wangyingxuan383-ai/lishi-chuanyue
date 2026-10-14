//! Native entry points bind derived memory to an owned, audited world.
//! No caller can supply an ancestor path, character grants or replacement facts.
use super::{blocking, GameCommandError, GameService, StoreRoute};
use lishi_core::{
    game_annotations::{AnnotationScope, AnnotationStore, AnnotationView, SummaryOperation},
    game_context::{
        compile_context, CompiledContext, ContextBudget, ContextFragment, ContextFragmentKind,
        ContextFragmentStatus, ContextRules, ContextScope, ContextTrace,
    },
    game_context_log::TraceStore,
    game_knowledge::{
        initial_visible_grants, minimal_actor_fact_json, SourceVisibilityIndex, ValidatedHistory,
    },
    game_memory::{MemoryIndex, MemoryKnownIdentity, MemoryPage, MemoryQuery, MemoryScope},
    game_protocol_v2::FactKey,
    game_store::GameTurnRequest,
    game_store_v2::{GameStoreV2, WorldViewV2},
};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    path::Path,
    sync::{Arc, Mutex},
};

struct IndexCache {
    index: MemoryIndex,
    head: Option<Option<String>>,
    visible_turn_ids: Vec<String>,
}
pub(super) struct GameMemoryService {
    cache: Mutex<IndexCache>,
    pub(super) annotations: AnnotationStore,
    traces: TraceStore,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryReply {
    world_id: String,
    branch_id: String,
    head_turn_id: Option<String>,
    page: MemoryPage,
}
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AnnotationsReply {
    world_id: String,
    branch_id: String,
    head_turn_id: Option<String>,
    annotations: AnnotationView,
    operations: Vec<SummaryOperation>,
}
pub(super) fn context_scope(view: &WorldViewV2) -> AnnotationScope {
    AnnotationScope::single(ContextScope::from_view(view))
}
fn error(value: impl std::fmt::Display) -> GameCommandError {
    GameCommandError::new(value.to_string())
}
fn v2(route: &StoreRoute) -> Result<&GameStoreV2, GameCommandError> {
    match route {
        StoreRoute::V2(store) => Ok(store),
        _ => Err(GameCommandError::new("game_upgrade_required")),
    }
}
fn checked_view(
    store: &GameStoreV2,
    world_id: &str,
    expected_head: Option<&str>,
) -> Result<WorldViewV2, GameCommandError> {
    let view = store.view()?;
    if view.setup.world_id != world_id || view.head_turn_id.as_deref() != expected_head {
        return Err(GameCommandError::new("game_stale_head"));
    }
    Ok(view)
}

impl GameMemoryService {
    fn open(directory: &Path, world_id: &str) -> Result<Self, GameCommandError> {
        std::fs::create_dir_all(directory)
            .map_err(|_| GameCommandError::new("memory_unavailable"))?;
        let stem = format!("{:x}", Sha256::digest(world_id.as_bytes()));
        // The index's owner guard is acquired before opening its sibling log.
        let index = MemoryIndex::open_sidecar(directory.join(format!("{stem}.index.sqlite")))
            .map_err(error)?;
        let annotations =
            AnnotationStore::open(directory.join(format!("{stem}.annotations.sqlite")))
                .map_err(error)?;
        let traces = TraceStore::open_sidecar(directory.join(format!("{stem}.traces.sqlite")))
            .map_err(error)?;
        Ok(Self {
            cache: Mutex::new(IndexCache {
                index,
                head: None,
                visible_turn_ids: vec![],
            }),
            annotations,
            traces,
        })
    }
    fn identities(
        history: &ValidatedHistory,
    ) -> Result<Vec<MemoryKnownIdentity>, GameCommandError> {
        let actor = &history.current_state().protagonist_id;
        let grants = initial_visible_grants(history, actor)?;
        let visibility = SourceVisibilityIndex::from_recorded_observations(history, grants)?;
        let raw = minimal_actor_fact_json(history, &visibility, actor, 2 * 1024 * 1024)?;
        let known: serde_json::Value = serde_json::from_str(&raw)
            .map_err(|_| GameCommandError::new("memory_invalid_input"))?;
        known["entities"]
            .as_array()
            .ok_or_else(|| GameCommandError::new("memory_invalid_input"))?
            .iter()
            .map(|entity| {
                let entity_id = entity["entityId"]
                    .as_str()
                    .ok_or_else(|| GameCommandError::new("memory_invalid_input"))?
                    .to_owned();
                let mut names = Vec::new();
                if let Some(name) = entity["name"].as_str() {
                    names.push(name.into());
                }
                for alias in entity["aliases"]
                    .as_array()
                    .ok_or_else(|| GameCommandError::new("memory_invalid_input"))?
                {
                    names.push(
                        alias
                            .as_str()
                            .ok_or_else(|| GameCommandError::new("memory_invalid_input"))?
                            .into(),
                    );
                }
                Ok(MemoryKnownIdentity { entity_id, names })
            })
            .collect()
    }
    fn query(
        &self,
        store: &GameStoreV2,
        view: &WorldViewV2,
        history: &ValidatedHistory,
        query: &MemoryQuery,
    ) -> Result<MemoryPage, GameCommandError> {
        if history.world_id() != view.setup.world_id
            || history.head_turn_id() != view.head_turn_id.as_deref()
            || history.current_state() != &view.state
        {
            return Err(GameCommandError::new("game_stale_head"));
        }
        let identities = Self::identities(history)?;
        let mut cache = self
            .cache
            .lock()
            .map_err(|_| GameCommandError::new("memory_unavailable"))?;
        if cache.head.as_ref() != Some(&view.head_turn_id) {
            let receipt = store.rebuild_memory_index(&mut cache.index)?;
            if receipt.scope.head_turn_id != view.head_turn_id || receipt.scope.state != view.state
            {
                return Err(GameCommandError::new("game_stale_head"));
            }
            cache.visible_turn_ids = receipt.scope.visible_turn_ids;
            cache.head = Some(view.head_turn_id.clone());
        }
        let IndexCache {
            index,
            visible_turn_ids,
            ..
        } = &mut *cache;
        let page = index
            .retrieve(
                &MemoryScope {
                    world_id: &view.setup.world_id,
                    branch_id: &view.branch_id,
                    head_turn_id: view.head_turn_id.as_deref(),
                    visible_turn_ids,
                },
                query,
                &view.state,
                &identities,
            )
            .map_err(error)?;
        for fragment in &page.fragments {
            if history.narrative_sha256(&fragment.source.turn_id)
                != Some(fragment.source.narrative_sha256.as_str())
            {
                return Err(GameCommandError::new("memory_invalid_scope"));
            }
        }
        // Verify cached text against the exact immutable source bytes, not just
        // a SHA string stored in the same disposable cache.
        if !page.fragments.is_empty() {
            let mut verified = std::collections::BTreeSet::new();
            let scope = store.visit_committed_turns(|turn, _, _| {
                for fragment in page
                    .fragments
                    .iter()
                    .filter(|fragment| fragment.source.turn_id == turn.turn_id)
                {
                    if turn
                        .narrative
                        .get(fragment.source.byte_start..fragment.source.byte_end)
                        != Some(fragment.text.as_str())
                    {
                        return Err(lishi_core::game_store::GameStoreError::Database);
                    }
                    verified.insert((fragment.source.turn_id.clone(), fragment.source.byte_start));
                }
                Ok(())
            })?;
            if scope.head_turn_id != view.head_turn_id || verified.len() != page.fragments.len() {
                return Err(GameCommandError::new("memory_invalid_scope"));
            }
        }
        Ok(page)
    }
    pub(super) fn annotation_reply(
        &self,
        view: &WorldViewV2,
        history: &ValidatedHistory,
    ) -> Result<AnnotationsReply, GameCommandError> {
        let scope = context_scope(view);
        Ok(AnnotationsReply {
            world_id: view.setup.world_id.clone(),
            branch_id: view.branch_id.clone(),
            head_turn_id: view.head_turn_id.clone(),
            annotations: self.annotations.view(&scope, history).map_err(error)?,
            operations: self
                .annotations
                .summary_operations(&scope, history, 64)
                .map_err(error)?,
        })
    }
    pub(super) fn compile(
        &self,
        store: &GameStoreV2,
        view: &WorldViewV2,
        request: &GameTurnRequest,
        budget: ContextBudget,
    ) -> Result<CompiledContext, GameCommandError> {
        let history = store.knowledge_history()?;
        let scope = context_scope(view);
        let mut fragments = Vec::new();
        let annotations = self.annotations.view(&scope, &history).map_err(error)?;
        let pins = annotations
            .pins
            .iter()
            .map(|pin| pin.context_pin(&scope, &history).map_err(error))
            .collect::<Result<Vec<_>, _>>()?;
        for summary in &annotations.summaries {
            fragments.push(summary.context_fragment(&scope, &history).map_err(error)?);
        }
        // Recall uses bounded known identities and explicit topic cues, rather
        // than treating a whole natural-language action as one FTS phrase.
        // The player's complete action still occupies its mandatory section.
        let mut seen_fragments = std::collections::BTreeSet::new();
        for query in Self::recall_queries(&history, &request.action_text)? {
            let page = self.query(store, view, &history, &query)?;
            for fragment in page.fragments {
                if !seen_fragments
                    .insert((fragment.source.turn_id.clone(), fragment.source.byte_start))
                {
                    continue;
                }
                fragments.push(ContextFragment {
                    id: format!(
                        "memory-{}-{}",
                        fragment.source.turn_id, fragment.source.byte_start
                    ),
                    scope: scope.context.clone(),
                    kind: ContextFragmentKind::RelatedMemory,
                    status: ContextFragmentStatus::Committed,
                    source_turn_ids: vec![fragment.source.turn_id],
                    body: fragment.text,
                    relevance: 1,
                });
            }
        }
        for turn in view.turns.iter().rev().take(8) {
            fragments.push(ContextFragment {
                id: format!("dialogue-{}", turn.turn_id),
                scope: scope.context.clone(),
                kind: ContextFragmentKind::RecentDialogue,
                status: ContextFragmentStatus::Committed,
                source_turn_ids: vec![turn.turn_id.clone()],
                body: serde_json::to_string(&(
                    &turn.action_kind,
                    &turn.action_text,
                    &turn.narrative,
                ))
                .map_err(|_| GameCommandError::new("memory_invalid_input"))?,
                relevance: 0,
            });
        }
        let compiled = compile_context(
            view,
            request,
            &history,
            ContextRules::v2(),
            budget,
            &pins,
            &fragments,
        )
        .map_err(error)?;
        self.record_trace(&compiled.trace)?;
        Ok(compiled)
    }
    fn recall_queries(
        history: &ValidatedHistory,
        action: &str,
    ) -> Result<Vec<MemoryQuery>, GameCommandError> {
        if action.is_empty() {
            return Ok(vec![]);
        }
        let mut identities = Self::identities(history)?;
        identities
            .sort_by_key(|identity| identity.entity_id == history.current_state().protagonist_id);
        let mut queries = Vec::new();
        for identity in identities.into_iter().filter(|identity| {
            identity
                .names
                .iter()
                .any(|name| !name.is_empty() && action.contains(name))
        }) {
            queries.push(MemoryQuery {
                entity_ids: vec![identity.entity_id],
                max_results: 2,
                ..MemoryQuery::default()
            });
            if queries.len() == 3 {
                break;
            }
        }
        for cue in [
            "暗号",
            "钥匙",
            "欠债",
            "旧腿伤",
            "旧伤",
            "伤病",
            "约定",
            "承诺",
        ] {
            if action.contains(cue) {
                queries.push(MemoryQuery {
                    query: cue.into(),
                    max_results: 2,
                    ..MemoryQuery::default()
                });
            }
            if queries.len() >= 7 {
                break;
            }
        }
        if action.len() <= 256 {
            queries.push(MemoryQuery {
                query: action.into(),
                max_results: 2,
                ..MemoryQuery::default()
            });
        }
        queries.truncate(8);
        Ok(queries)
    }
    fn record_trace(&self, trace: &ContextTrace) -> Result<(), GameCommandError> {
        self.traces.record(trace).map_err(error)
    }
    pub(super) fn record_actual_usage(
        &self,
        id: &str,
        usage: Option<usize>,
    ) -> Result<(), GameCommandError> {
        self.traces.record_actual_usage(id, usage).map_err(error)
    }
}

fn annotation_id() -> Result<String, GameCommandError> {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|_| GameCommandError::new("game_unavailable"))?
        .as_nanos();
    Ok(format!(
        "annotation-{nanos:x}-{:x}-{:x}",
        std::process::id(),
        super::KEY_SEQUENCE.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
    ))
}

impl GameService {
    pub(super) fn compile_context_prompt(
        &self,
        route: &StoreRoute,
        view: &super::WorldReply,
        request: &GameTurnRequest,
        budget: ContextBudget,
    ) -> Result<(String, Option<Arc<GameMemoryService>>), GameCommandError> {
        match (route, view) {
            (StoreRoute::V1(_), super::WorldReply::V1(view)) => Ok((
                lishi_core::game_provider::compile_game_prompt(view, request)?,
                None,
            )),
            (StoreRoute::V2(store), super::WorldReply::V2(view)) => {
                let memory = self.memory(&view.setup.world_id)?;
                let compiled = memory.compile(store, view, request, budget)?;
                Ok((compiled.prompt, Some(memory)))
            }
            _ => Err(GameCommandError::new("game_invalid_protocol")),
        }
    }
    pub(super) fn memory(
        &self,
        world_id: &str,
    ) -> Result<Arc<GameMemoryService>, GameCommandError> {
        // Validation and formal ownership precede all sidecar creation.
        let store = self.store(world_id, false)?;
        v2(&store)?;
        let mut services = self
            .memories
            .lock()
            .map_err(|_| GameCommandError::new("memory_unavailable"))?;
        if let Some(memory) = services.get(world_id) {
            return Ok(Arc::clone(memory));
        }
        let memory = Arc::new(GameMemoryService::open(&self.memory_directory, world_id)?);
        services.insert(world_id.into(), Arc::clone(&memory));
        Ok(memory)
    }
    fn annotation_action(
        &self,
        world_id: &str,
        expected_head: Option<&str>,
        mutate: impl FnOnce(
            &GameMemoryService,
            &WorldViewV2,
            &ValidatedHistory,
            &AnnotationScope,
        ) -> Result<(), GameCommandError>,
    ) -> Result<AnnotationsReply, GameCommandError> {
        let store = self.store(world_id, false)?;
        let active = self
            .active
            .lock()
            .map_err(|_| GameCommandError::new("game_unavailable"))?;
        if active.is_some() {
            return Err(GameCommandError::new("game_busy"));
        }
        let store = v2(&store)?;
        let view = checked_view(store, world_id, expected_head)?;
        let history = store.knowledge_history()?;
        let memory = self.memory(world_id)?;
        let scope = context_scope(&view);
        mutate(&memory, &view, &history, &scope)?;
        memory.annotation_reply(&view, &history)
    }
}

#[tauri::command]
pub async fn get_game_context_trace(
    world_id: String,
    operation_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<Option<ContextTrace>, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        let route = service.store(&world_id, false)?;
        let history = v2(&route)?.knowledge_history()?;
        let memory = service.memory(&world_id)?;
        let trace = memory.traces.get(&operation_id).map_err(error)?;
        if let Some(trace) = &trace {
            if trace.world_id != world_id
                || trace.branch_id != "main"
                || trace
                    .head_turn_id
                    .as_deref()
                    .is_some_and(|head| !history.contains_turn(head))
            {
                return Err(GameCommandError::new("memory_invalid_scope"));
            }
        }
        Ok(trace)
    })
    .await
}

#[tauri::command]
pub async fn query_game_memory(
    world_id: String,
    expected_head_turn_id: Option<String>,
    query: MemoryQuery,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<MemoryReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        let route = service.store(&world_id, false)?;
        let store = v2(&route)?;
        let view = checked_view(store, &world_id, expected_head_turn_id.as_deref())?;
        let history = store.knowledge_history()?;
        let memory = service.memory(&world_id)?;
        let page = memory.query(store, &view, &history, &query)?;
        Ok(MemoryReply {
            world_id,
            branch_id: view.branch_id,
            head_turn_id: view.head_turn_id,
            page,
        })
    })
    .await
}
#[tauri::command]
pub async fn get_game_annotations(
    world_id: String,
    expected_head_turn_id: Option<String>,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<AnnotationsReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        let route = service.store(&world_id, false)?;
        let store = v2(&route)?;
        let view = checked_view(store, &world_id, expected_head_turn_id.as_deref())?;
        service
            .memory(&world_id)?
            .annotation_reply(&view, &store.knowledge_history()?)
    })
    .await
}
#[tauri::command]
pub async fn pin_game_fact(
    world_id: String,
    expected_head_turn_id: Option<String>,
    fact_key: FactKey,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<AnnotationsReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        service.annotation_action(
            &world_id,
            expected_head_turn_id.as_deref(),
            |memory, _, history, scope| {
                memory
                    .annotations
                    .add_pin(scope, history, &annotation_id()?, &fact_key)
                    .map_err(error)?;
                Ok(())
            },
        )
    })
    .await
}
#[tauri::command]
pub async fn bookmark_game_turn(
    world_id: String,
    expected_head_turn_id: Option<String>,
    turn_id: String,
    label: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<AnnotationsReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        service.annotation_action(
            &world_id,
            expected_head_turn_id.as_deref(),
            |memory, _, history, scope| {
                memory
                    .annotations
                    .add_bookmark(scope, history, &annotation_id()?, &turn_id, &label)
                    .map_err(error)?;
                Ok(())
            },
        )
    })
    .await
}
#[tauri::command]
pub async fn remove_game_annotation(
    world_id: String,
    expected_head_turn_id: Option<String>,
    annotation_id: String,
    service: tauri::State<'_, Arc<GameService>>,
) -> Result<AnnotationsReply, GameCommandError> {
    let service = Arc::clone(service.inner());
    blocking(move || {
        service.annotation_action(
            &world_id,
            expected_head_turn_id.as_deref(),
            |memory, _, history, scope| {
                memory
                    .annotations
                    .remove_annotation(scope, history, &annotation_id)
                    .map_err(error)?;
                Ok(())
            },
        )
    })
    .await
}

pub(super) type MemoryServices = Mutex<BTreeMap<String, Arc<GameMemoryService>>>;

#[cfg(test)]
mod tests {
    use super::*;
    use lishi_core::{
        game_context::{ContextSectionKind, ContextSectionOutcome},
        game_protocol::{EntityKind, WorldSetup},
        game_protocol_v2::{
            initial_state_v2, ConditionCategory, ConditionInput, EntityInput, StateChangeV2,
        },
        game_provider_v2::demo_output_v2,
        game_store::GameActionKind,
    };

    #[test]
    fn full_three_hundred_turns_reach_native_context_and_persist_reminders() {
        let temporary = tempfile::tempdir().unwrap();
        let setup = WorldSetup {
            world_id: "native-memory-long-world".into(),
            title: "原生长记忆固定夹具".into(),
            country: "秦".into(),
            era_year: -221,
            location_name: "咸阳".into(),
            protagonist_name: "李明".into(),
            narrative_style: "固定验收，不作史实".into(),
        };
        let store = GameStoreV2::open(temporary.path().join("world.sqlite")).unwrap();
        store
            .create_world_v2(&setup, &initial_state_v2(&setup).unwrap(), "固定开局", &[])
            .unwrap();
        let timer = std::time::Instant::now();
        for sequence in 1..=300 {
            let view = store.view().unwrap();
            let request = GameTurnRequest {
                operation_id: format!("native-long-turn-{sequence:04}"),
                world_id: setup.world_id.clone(),
                branch_id: "main".into(),
                expected_head_turn_id: view.head_turn_id,
                action_kind: GameActionKind::Action,
                action_text: if sequence == 150 {
                    "改名为李安".into()
                } else {
                    format!("观察街市第{sequence}次")
                },
            };
            let mut output = demo_output_v2(&view.state, &request).unwrap();
            let event_id = output.events[0].id.clone();
            let mut observed = Vec::new();
            match sequence {
                5 => {
                    output.narrative = "李明在渡口伤了左腿，旧腿伤将长期保留。".into();
                    output.state_changes.push(StateChangeV2::AddCondition {
                        condition: ConditionInput {
                            id: "fixture-injury".into(),
                            entity_id: "player".into(),
                            description: "旧腿伤".into(),
                            category: ConditionCategory::Injury,
                            active: true,
                        },
                        event_id: event_id.clone(),
                    });
                    observed.push(FactKey::Condition {
                        condition_id: "fixture-injury".into(),
                    });
                }
                70 => {
                    output.narrative = "李明把钥匙藏在行囊里，约定暗号为青石。".into();
                    output.events[0].entity_ids.push("fixture-key".into());
                    output.state_changes.push(StateChangeV2::CreateEntity {
                        entity: EntityInput {
                            id: "fixture-key".into(),
                            kind: EntityKind::Item,
                            name: "钥匙".into(),
                            alive: None,
                            attributes: BTreeMap::new(),
                        },
                        event_id: event_id.clone(),
                    });
                    output.state_changes.push(StateChangeV2::SetItemHolding {
                        item_id: "fixture-key".into(),
                        expected_holding: None,
                        holder_id: Some("player".into()),
                        place_id: None,
                        quantity: 1,
                        unit: "把".into(),
                        event_id: event_id.clone(),
                    });
                    observed.extend([
                        FactKey::EntityCreated {
                            entity_id: "fixture-key".into(),
                        },
                        FactKey::EntityName {
                            entity_id: "fixture-key".into(),
                        },
                        FactKey::ItemHolding {
                            item_id: "fixture-key".into(),
                        },
                    ]);
                }
                100 => {
                    output.narrative = "李明欠债十枚，约定下月偿还；此后无人说债务已清。".into();
                    output.state_changes.push(StateChangeV2::AddCondition {
                        condition: ConditionInput {
                            id: "fixture-debt".into(),
                            entity_id: "player".into(),
                            description: "欠债十枚".into(),
                            category: ConditionCategory::Obligation,
                            active: true,
                        },
                        event_id: event_id.clone(),
                    });
                    observed.push(FactKey::Condition {
                        condition_id: "fixture-debt".into(),
                    });
                }
                _ => {}
            }
            for fact_key in observed {
                output.state_changes.push(StateChangeV2::ObserveFact {
                    actor_id: "player".into(),
                    fact_key,
                    event_id: event_id.clone(),
                });
            }
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
        let view = store.view().unwrap();
        assert_eq!(view.turn_count, 300);
        assert_eq!(view.turns.len(), 100);
        assert!(view
            .state
            .conditions
            .iter()
            .any(|condition| condition.id == "fixture-injury" && condition.active));
        assert!(view
            .state
            .conditions
            .iter()
            .any(|condition| condition.id == "fixture-debt" && condition.active));
        assert!(view
            .state
            .item_holdings
            .iter()
            .any(|holding| holding.item_id == "fixture-key" && holding.value.quantity == Some(1)));
        let before = serde_json::to_vec(&view).unwrap();
        let history = store.knowledge_history().unwrap();
        let memory =
            GameMemoryService::open(&temporary.path().join("memory"), &setup.world_id).unwrap();
        for (query, expected) in [("李明欠债", 100), ("李安钥匙", 70), ("旧腿伤", 5)] {
            let page = memory
                .query(
                    &store,
                    &view,
                    &history,
                    &MemoryQuery {
                        query: query.into(),
                        max_results: 1,
                        ..MemoryQuery::default()
                    },
                )
                .unwrap();
            assert_eq!(page.fragments.len(), 1, "{query}");
            assert_eq!(page.fragments[0].source.sequence, expected, "{query}");
        }
        let scope = context_scope(&view);
        memory
            .annotations
            .add_pin(
                &scope,
                &history,
                "fixed-debt-reminder",
                &FactKey::Condition {
                    condition_id: "fixture-debt".into(),
                },
            )
            .unwrap();
        memory
            .annotations
            .add_bookmark(
                &scope,
                &history,
                "fixed-key-bookmark",
                "native-long-turn-0070",
                "钥匙暗号",
            )
            .unwrap();
        let request = GameTurnRequest {
            operation_id: "native-long-context-0301".into(),
            world_id: setup.world_id.clone(),
            branch_id: "main".into(),
            expected_head_turn_id: view.head_turn_id.clone(),
            action_kind: GameActionKind::Action,
            action_text: "我准备取出钥匙，暗号是什么？".into(),
        };
        let compiled = memory
            .compile(
                &store,
                &view,
                &request,
                ContextBudget {
                    max_input_bytes: 128 * 1024,
                    context_limit_tokens: 196608,
                    output_reserve_tokens: 4096,
                    transport_reserve_tokens: 512,
                },
            )
            .unwrap();
        assert!(compiled.prompt.contains("青石")); // Early narrative-only clue.
        assert!(compiled.prompt.contains("旧腿伤"));
        assert!(compiled.prompt.contains("欠债十枚"));
        assert!(compiled
            .trace
            .sections
            .iter()
            .any(|section| section.kind == ContextSectionKind::RelatedMemory
                && section.outcome == ContextSectionOutcome::Included));
        assert!(compiled
            .trace
            .sections
            .iter()
            .any(|section| section.kind == ContextSectionKind::PinnedFact
                && section.outcome == ContextSectionOutcome::Included));
        assert!(compiled.trace.actual_input_tokens.is_none());
        assert_eq!(serde_json::to_vec(&store.view().unwrap()).unwrap(), before);
        let trace = compiled.trace.clone();
        drop(memory);
        let reopened =
            GameMemoryService::open(&temporary.path().join("memory"), &setup.world_id).unwrap();
        let annotations = reopened.annotation_reply(&view, &history).unwrap();
        assert_eq!(annotations.annotations.pins.len(), 1);
        assert_eq!(
            annotations.annotations.bookmarks[0].turn_id,
            "native-long-turn-0070"
        );
        assert_eq!(
            reopened.traces.get(&request.operation_id).unwrap(),
            Some(trace)
        );
        println!(
            "native_long_fixture turns=300 input_bytes={} elapsed_ms={}",
            compiled.prompt.len(),
            timer.elapsed().as_millis()
        );
    }
}
