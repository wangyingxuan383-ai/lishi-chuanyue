//! Read-only v2 facts and explicitly scoped character knowledge.
//!
//! This module does not choose branches, authenticate a caller, migrate saves,
//! or wire prompts into the production Provider. Its history input must come
//! from the core's committed storage. Replay detects incomplete/inconsistent
//! inputs; it is not a signature proving the origin of a supplied history.

use std::collections::{BTreeMap, BTreeSet};

use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::game_protocol::{EntityKind, GameError, GameResult};
use crate::game_protocol_v2::{
    apply_output_v2, fact_value_v2, validate_state_v2, AcquisitionMode, Certainty, CommitContext,
    ConditionV2, EntityV2, ItemHolding, KnowledgeTarget, StateSource, TurnOutputV2, WorldStateV2,
};

pub use crate::game_protocol_v2::FactKey;

fn valid_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn valid_commit_id(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'-' | b'_'))
}

fn find_entity<'a>(state: &'a WorldStateV2, id: &str) -> GameResult<&'a EntityV2> {
    if !valid_id(id) {
        return Err(GameError::InvalidReference);
    }
    state
        .entities
        .iter()
        .find(|entity| entity.id == id)
        .ok_or(GameError::InvalidReference)
}

/// Narrator/core query: this returns objective state, not a player-visible DTO.
pub fn entity_by_id<'a>(state: &'a WorldStateV2, id: &str) -> GameResult<Option<&'a EntityV2>> {
    validate_state_v2(state)?;
    if !valid_id(id) {
        return Err(GameError::InvalidReference);
    }
    Ok(state.entities.iter().find(|entity| entity.id == id))
}

/// Only normalized, positive holdings are usable. Legacy unknown records never
/// become available merely because a free-text owner attribute matches.
pub fn held_items<'a>(
    state: &'a WorldStateV2,
    holder_id: &str,
) -> GameResult<Vec<&'a ItemHolding>> {
    validate_state_v2(state)?;
    let holder = find_entity(state, holder_id)?;
    if !matches!(holder.kind, EntityKind::Person | EntityKind::Organization) {
        return Err(GameError::InvalidReference);
    }
    Ok(state
        .item_holdings
        .iter()
        .filter(|holding| {
            holding.value.holder_id.as_deref() == Some(holder_id)
                && holding.value.quantity.unwrap_or(0) > 0
        })
        .collect())
}

pub fn active_conditions<'a>(
    state: &'a WorldStateV2,
    entity_id: &str,
) -> GameResult<Vec<&'a ConditionV2>> {
    validate_state_v2(state)?;
    find_entity(state, entity_id)?;
    Ok(state
        .conditions
        .iter()
        .filter(|condition| condition.entity_id == entity_id && condition.active)
        .collect())
}

fn fact_sources(state: &WorldStateV2) -> BTreeMap<FactKey, &StateSource> {
    let mut result = BTreeMap::new();
    result.insert(FactKey::Time, &state.time.last_changed_source);
    result.insert(FactKey::Location, &state.location_source);
    for entity in &state.entities {
        result.insert(
            FactKey::EntityCreated {
                entity_id: entity.id.clone(),
            },
            &entity.created_source,
        );
        result.insert(
            FactKey::EntityName {
                entity_id: entity.id.clone(),
            },
            &entity.name_source,
        );
        if entity.alive.is_some() {
            result.insert(
                FactKey::EntityLife {
                    entity_id: entity.id.clone(),
                },
                &entity.life_source,
            );
        }
        for (key, source) in &entity.attribute_sources {
            result.insert(
                FactKey::EntityAttribute {
                    entity_id: entity.id.clone(),
                    key: key.clone(),
                },
                source,
            );
        }
        for alias in &entity.aliases {
            result.insert(
                FactKey::EntityAlias {
                    entity_id: entity.id.clone(),
                    text: alias.text.clone(),
                },
                &alias.source,
            );
        }
    }
    for holding in &state.item_holdings {
        result.insert(
            FactKey::ItemHolding {
                item_id: holding.item_id.clone(),
            },
            &holding.source,
        );
    }
    for condition in &state.conditions {
        result.insert(
            FactKey::Condition {
                condition_id: condition.id.clone(),
            },
            &condition.last_changed_source,
        );
    }
    for resource in &state.resources {
        result.insert(
            FactKey::Resource {
                owner_id: resource.owner_id.clone(),
                key: resource.key.clone(),
            },
            &resource.last_changed_source,
        );
    }
    for relationship in &state.relationships {
        result.insert(
            FactKey::Relationship {
                from_id: relationship.from_id.clone(),
                to_id: relationship.to_id.clone(),
                kind: relationship.kind.clone(),
            },
            &relationship.last_changed_source,
        );
    }
    for event in &state.events {
        result.insert(
            FactKey::Event {
                event_id: event.id.clone(),
            },
            &event.created_source,
        );
    }
    for claim in &state.claims {
        result.insert(
            FactKey::Claim {
                claim_id: claim.id.clone(),
            },
            &claim.last_changed_source,
        );
    }
    result
}

pub fn source_for_fact<'a>(
    state: &'a WorldStateV2,
    fact: &FactKey,
) -> GameResult<Option<&'a StateSource>> {
    validate_state_v2(state)?;
    Ok(fact_sources(state).get(fact).copied())
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CommittedHistoryEntry {
    pub operation_id: String,
    pub turn_id: String,
    pub parent_turn_id: Option<String>,
    pub output: TurnOutputV2,
    pub state: WorldStateV2,
}

/// Fully replayed mainline history. M04 must provide the correctly selected
/// ancestor path; passing an entire database or sibling branches is rejected.
#[derive(Debug, Clone)]
pub struct ValidatedHistory {
    world_id: String,
    current: WorldStateV2,
    head_turn_id: Option<String>,
    turn_count: u64,
    revisions: BTreeMap<FactKey, Vec<FactRevision>>,
    sources: BTreeSet<(FactKey, StateSource)>,
    recorded_observations: BTreeSet<(String, FactKey, StateSource)>,
    operations: BTreeSet<String>,
    turns: BTreeSet<String>,
    turn_metadata: BTreeMap<String, (u64, String)>,
    identity: [u8; 32],
}

#[derive(Debug, Clone, PartialEq)]
struct FactRevision {
    source: StateSource,
    value: serde_json::Value,
}

fn record_revisions(
    state: &WorldStateV2,
    revisions: &mut BTreeMap<FactKey, Vec<FactRevision>>,
    sources: &mut BTreeSet<(FactKey, StateSource)>,
) -> GameResult {
    for (fact, source) in fact_sources(state) {
        let value = fact_value_v2(state, &fact).ok_or(GameError::InvalidReference)?;
        let values = revisions.entry(fact.clone()).or_default();
        if let Some(previous) = values.iter().find(|previous| previous.source == *source) {
            if previous.value != value {
                return Err(GameError::InvalidReference);
            }
        } else {
            values.push(FactRevision {
                source: source.clone(),
                value,
            });
        }
        sources.insert((fact, source.clone()));
    }
    Ok(())
}

impl ValidatedHistory {
    pub fn new(
        world_id: &str,
        initial: WorldStateV2,
        entries: Vec<CommittedHistoryEntry>,
        expected_head_turn_id: Option<&str>,
    ) -> GameResult<Self> {
        if !(8..=128).contains(&world_id.len()) || !valid_commit_id(world_id) {
            return Err(GameError::InvalidReference);
        }
        validate_state_v2(&initial)?;
        // A v2 history starts at its actual initial state. Converted v1 history
        // requires the separate audited adapter, rather than pretending a head
        // snapshot was an initial state and losing previous known values.
        if fact_sources(&initial)
            .values()
            .any(|source| !matches!(source, StateSource::Initial))
            || initial
                .knowledge
                .iter()
                .any(|knowledge| !matches!(knowledge.source, StateSource::Initial))
        {
            return Err(GameError::InvalidReference);
        }
        let mut previous = &initial;
        let mut previous_id = None;
        let mut operations = BTreeSet::new();
        let mut turns = BTreeSet::new();
        let mut turn_metadata = BTreeMap::new();
        let mut sources = BTreeSet::new();
        let mut recorded_observations = BTreeSet::new();
        let mut revisions = BTreeMap::new();
        record_revisions(&initial, &mut revisions, &mut sources)?;
        for (position, entry) in entries.iter().enumerate() {
            if !valid_commit_id(&entry.operation_id)
                || !valid_commit_id(&entry.turn_id)
                || entry.parent_turn_id.as_deref() != previous_id
                || !operations.insert(entry.operation_id.clone())
                || !turns.insert(entry.turn_id.clone())
            {
                return Err(GameError::InvalidReference);
            }
            let context = CommitContext {
                operation_id: entry.operation_id.clone(),
                turn_id: entry.turn_id.clone(),
            };
            if apply_output_v2(previous, &entry.output, &context)? != entry.state {
                return Err(GameError::InvalidReference);
            }
            record_revisions(&entry.state, &mut revisions, &mut sources)?;
            turn_metadata.insert(
                entry.turn_id.clone(),
                (
                    (position + 1) as u64,
                    format!("{:x}", Sha256::digest(entry.output.narrative.as_bytes())),
                ),
            );
            recorded_observations.extend(entry.state.fact_observations.iter().map(|observation| {
                (
                    observation.actor_id.clone(),
                    observation.fact_key.clone(),
                    observation.fact_source.clone(),
                )
            }));
            previous = &entry.state;
            previous_id = Some(entry.turn_id.as_str());
        }
        if previous_id != expected_head_turn_id {
            return Err(GameError::Conflict);
        }
        let bytes = serde_json::to_vec(&(world_id, &initial, &entries))
            .map_err(|_| GameError::InvalidReference)?;
        let identity = Sha256::digest(bytes).into();
        Ok(Self {
            world_id: world_id.into(),
            current: previous.clone(),
            head_turn_id: previous_id.map(str::to_owned),
            turn_count: entries.len() as u64,
            revisions,
            sources,
            recorded_observations,
            operations,
            turns,
            turn_metadata,
            identity,
        })
    }

    pub fn world_id(&self) -> &str {
        &self.world_id
    }

    pub fn current_state(&self) -> &WorldStateV2 {
        &self.current
    }

    pub fn head_turn_id(&self) -> Option<&str> {
        self.head_turn_id.as_deref()
    }

    pub fn turn_count(&self) -> u64 {
        self.turn_count
    }

    /// Membership in the exact, replayed ancestor path, never a database-wide
    /// or sibling-branch query. Callers still bind the world and head.
    pub fn contains_turn(&self, turn_id: &str) -> bool {
        self.turns.contains(turn_id)
    }

    /// One-based position in the audited path, including inherited ancestors.
    /// The initial node has no turn ID and is not a narrative source.
    pub fn turn_position(&self, turn_id: &str) -> Option<u64> {
        self.turn_metadata
            .get(turn_id)
            .map(|(position, _)| *position)
    }

    pub fn narrative_sha256(&self, turn_id: &str) -> Option<&str> {
        self.turn_metadata
            .get(turn_id)
            .map(|(_, hash)| hash.as_str())
    }

    pub fn visible_turn_ids(&self) -> Vec<String> {
        let mut ordered: Vec<_> = self.turn_metadata.iter().collect();
        ordered.sort_unstable_by_key(|(_, (position, _))| *position);
        ordered.into_iter().map(|(id, _)| id.clone()).collect()
    }

    /// Continue an audited legacy prefix or v2 path. Every new row is replayed
    /// against the exact current node before changing this read-only index.
    pub fn append_v2_entry(&mut self, entry: CommittedHistoryEntry) -> GameResult {
        if !valid_commit_id(&entry.operation_id)
            || !valid_commit_id(&entry.turn_id)
            || entry.parent_turn_id != self.head_turn_id
            || self.operations.contains(&entry.operation_id)
            || self.turns.contains(&entry.turn_id)
        {
            return Err(GameError::InvalidReference);
        }
        let context = CommitContext {
            operation_id: entry.operation_id.clone(),
            turn_id: entry.turn_id.clone(),
        };
        let next = apply_output_v2(&self.current, &entry.output, &context)?;
        if next != entry.state {
            return Err(GameError::InvalidReference);
        }
        let turn_count = self.turn_count.checked_add(1).ok_or(GameError::TooLarge)?;
        let bytes = serde_json::to_vec(&entry).map_err(|_| GameError::InvalidReference)?;
        let mut hash = Sha256::new();
        hash.update(b"lishi-knowledge-append-v2\0");
        hash.update(self.identity);
        hash.update((bytes.len() as u64).to_le_bytes());
        hash.update(bytes);
        // Build the small changes first so an unexpected provenance conflict
        // cannot partially alter an index the caller intends to reuse.
        let mut changes = Vec::new();
        for (fact, source) in fact_sources(&next) {
            let value = fact_value_v2(&next, &fact).ok_or(GameError::InvalidReference)?;
            if let Some(previous) = self
                .revisions
                .get(&fact)
                .and_then(|values| values.iter().find(|value| value.source == *source))
            {
                if previous.value != value {
                    return Err(GameError::InvalidReference);
                }
            } else {
                changes.push((
                    fact,
                    FactRevision {
                        source: source.clone(),
                        value,
                    },
                ));
            }
        }
        for (fact, revision) in changes {
            self.sources.insert((fact.clone(), revision.source.clone()));
            self.revisions.entry(fact).or_default().push(revision);
        }
        self.operations.insert(entry.operation_id);
        self.recorded_observations
            .extend(next.fact_observations.iter().map(|observation| {
                (
                    observation.actor_id.clone(),
                    observation.fact_key.clone(),
                    observation.fact_source.clone(),
                )
            }));
        self.turns.insert(entry.turn_id.clone());
        self.turn_metadata.insert(
            entry.turn_id.clone(),
            (
                turn_count,
                format!("{:x}", Sha256::digest(entry.output.narrative.as_bytes())),
            ),
        );
        self.head_turn_id = Some(entry.turn_id);
        self.turn_count = turn_count;
        self.current = next;
        self.identity = hash.finalize().into();
        Ok(())
    }
}

/// Stream a complete v1 archive through the frozen adapter. Only changed fact
/// revisions and the latest snapshot are retained, rather than all snapshots.
/// Supplied naked v2 snapshots cannot mint a trusted legacy history.
pub struct LegacyKnowledgeHistoryBuilder {
    adapter: crate::game_legacy::LegacyAdapter,
    revisions: BTreeMap<FactKey, Vec<FactRevision>>,
    sources: BTreeSet<(FactKey, StateSource)>,
    turns: BTreeSet<String>,
    turn_metadata: BTreeMap<String, (u64, String)>,
}

impl LegacyKnowledgeHistoryBuilder {
    pub fn from_header(header: &crate::game_archive::LegacyWorldHeader) -> GameResult<Self> {
        let adapter = crate::game_legacy::LegacyAdapter::from_header(header)?;
        let mut revisions = BTreeMap::new();
        let mut sources = BTreeSet::new();
        record_revisions(adapter.initial_state(), &mut revisions, &mut sources)?;
        Ok(Self {
            adapter,
            revisions,
            sources,
            turns: BTreeSet::new(),
            turn_metadata: BTreeMap::new(),
        })
    }

    pub fn push_turn(&mut self, turn: &crate::game_archive::LegacyTurn) -> GameResult {
        let state = self.adapter.push_turn(turn)?;
        record_revisions(state, &mut self.revisions, &mut self.sources)?;
        self.turns.insert(turn.turn_id.clone());
        self.turn_metadata.insert(
            turn.turn_id.clone(),
            (
                turn.sequence,
                format!("{:x}", Sha256::digest(turn.narrative.as_bytes())),
            ),
        );
        Ok(())
    }

    pub fn finish(self) -> GameResult<ValidatedHistory> {
        let adapted = self.adapter.finish()?;
        let mut hash = Sha256::new();
        hash.update(b"lishi-knowledge-legacy-history\0");
        hash.update(adapted.world_id.as_bytes());
        hash.update([0]);
        hash.update(adapted.raw_history_sha256.as_bytes());
        Ok(ValidatedHistory {
            world_id: adapted.world_id,
            current: adapted.current_state,
            head_turn_id: adapted.head_turn_id,
            turn_count: adapted.turn_count,
            revisions: self.revisions,
            sources: self.sources,
            recorded_observations: BTreeSet::new(),
            operations: self.turns.clone(),
            turns: self.turns,
            turn_metadata: self.turn_metadata,
            identity: hash.finalize().into(),
        })
    }
}

/// An exact observation granted by trusted core scene/initialization rules.
/// This is not a model-output or front-end capability. Source identity alone
/// cannot grant every initial fact or every fact attached to the same event.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceVisibilityGrant {
    pub actor_id: String,
    pub fact: FactKey,
    pub source: StateSource,
}

/// Controlled player initialization and v1 display compatibility. This is a
/// core policy, not a frontend endpoint for granting arbitrary knowledge.
/// New v2 turn sources are learned only through formal ObserveFact operations.
pub fn initial_visible_grants(
    history: &ValidatedHistory,
    actor_id: &str,
) -> GameResult<Vec<SourceVisibilityGrant>> {
    let state = history.current_state();
    if find_entity(state, actor_id)?.kind != EntityKind::Person {
        return Err(GameError::InvalidKnowledge);
    }
    if actor_id != state.protagonist_id {
        return Ok(Vec::new());
    }
    let mut selected = BTreeSet::new();
    let initial_sources = [
        StateSource::Initial,
        StateSource::LegacySnapshot {
            turn_id: None,
            format_version: 1,
        },
    ];
    let mut initial_keys = vec![
        FactKey::EntityCreated {
            entity_id: actor_id.into(),
        },
        FactKey::EntityName {
            entity_id: actor_id.into(),
        },
        FactKey::EntityLife {
            entity_id: actor_id.into(),
        },
        FactKey::EntityCreated {
            entity_id: "travel-bag".into(),
        },
        FactKey::EntityName {
            entity_id: "travel-bag".into(),
        },
        FactKey::ItemHolding {
            item_id: "travel-bag".into(),
        },
        FactKey::Resource {
            owner_id: actor_id.into(),
            key: "cash".into(),
        },
        FactKey::Time,
        FactKey::Location,
    ];
    let mut visible_places = BTreeSet::new();
    if let Some(locations) = history.revisions.get(&FactKey::Location) {
        for revision in locations.iter().filter(|revision| {
            matches!(
                revision.source,
                StateSource::Initial | StateSource::LegacySnapshot { .. }
            )
        }) {
            if let Some(place) = revision.value.as_str() {
                visible_places.insert(place.to_owned());
            }
        }
    }
    for place in &visible_places {
        initial_keys.push(FactKey::EntityCreated {
            entity_id: place.clone(),
        });
        initial_keys.push(FactKey::EntityName {
            entity_id: place.clone(),
        });
    }
    for fact in initial_keys {
        for source in &initial_sources {
            if history.sources.contains(&(fact.clone(), source.clone())) {
                selected.insert((fact.clone(), source.clone()));
            }
        }
    }
    // The old UI displayed player resources, conditions and carried items.
    // Preserve only those exact legacy revisions. Do not use today's v2 owner
    // to classify an NPC's secret item as previously visible to the player.
    let owned_items = history
        .revisions
        .iter()
        .filter_map(|(fact, revisions)| {
            let FactKey::ItemHolding { item_id } = fact else {
                return None;
            };
            revisions
                .iter()
                .any(|revision| {
                    matches!(
                        revision.source,
                        StateSource::Initial | StateSource::LegacySnapshot { .. }
                    ) && revision.value["holderId"].as_str() == Some(actor_id)
                })
                .then_some(item_id.clone())
        })
        .collect::<BTreeSet<_>>();
    for (fact, revisions) in &history.revisions {
        for revision in revisions
            .iter()
            .filter(|revision| matches!(revision.source, StateSource::LegacySnapshot { .. }))
        {
            let visible = match fact {
                FactKey::EntityCreated { entity_id } | FactKey::EntityName { entity_id } => {
                    entity_id == actor_id
                        || owned_items.contains(entity_id)
                        || visible_places.contains(entity_id)
                }
                FactKey::EntityLife { entity_id } => entity_id == actor_id,
                FactKey::EntityAttribute { entity_id, .. } => owned_items.contains(entity_id),
                FactKey::ItemHolding { item_id } => owned_items.contains(item_id),
                FactKey::Condition { .. } => revision.value["entityId"].as_str() == Some(actor_id),
                FactKey::Resource { owner_id, .. } => owner_id == actor_id,
                FactKey::Time | FactKey::Location => true,
                _ => false,
            };
            if visible {
                selected.insert((fact.clone(), revision.source.clone()));
            }
        }
    }
    Ok(selected
        .into_iter()
        .map(|(fact, source)| SourceVisibilityGrant {
            actor_id: actor_id.into(),
            fact,
            source,
        })
        .collect())
}

pub fn legacy_player_visibility_grants(
    history: &ValidatedHistory,
) -> GameResult<Vec<SourceVisibilityGrant>> {
    initial_visible_grants(history, &history.current_state().protagonist_id)
}

#[derive(Debug, Clone)]
pub struct SourceVisibilityIndex {
    history_identity: [u8; 32],
    grants: BTreeSet<(String, FactKey, StateSource)>,
}

impl SourceVisibilityIndex {
    /// Rebuild from immutable, formally committed observations. Initial scene
    /// grants remain explicit core rules and cannot authorize a later fact.
    pub fn from_recorded_observations(
        history: &ValidatedHistory,
        mut initial_grants: Vec<SourceVisibilityGrant>,
    ) -> GameResult<Self> {
        let mut compatibility_grants = BTreeMap::new();
        for grant in &initial_grants {
            match &grant.source {
                StateSource::Turn { .. } => return Err(GameError::InvalidKnowledge),
                StateSource::LegacySnapshot {
                    turn_id: Some(_), ..
                } => {
                    if !compatibility_grants.contains_key(&grant.actor_id) {
                        compatibility_grants.insert(
                            grant.actor_id.clone(),
                            initial_visible_grants(history, &grant.actor_id)?
                                .into_iter()
                                .map(|grant| (grant.fact, grant.source))
                                .collect::<BTreeSet<_>>(),
                        );
                    }
                    if !compatibility_grants[&grant.actor_id]
                        .contains(&(grant.fact.clone(), grant.source.clone()))
                    {
                        return Err(GameError::InvalidKnowledge);
                    }
                }
                _ => {}
            }
        }
        // The head has only the latest observation for each actor/fact.
        // Earlier immutable observations still prove old names were learned;
        // rebuilding from the head alone would incorrectly erase that memory.
        initial_grants.extend(history.recorded_observations.iter().map(
            |(actor_id, fact, source)| SourceVisibilityGrant {
                actor_id: actor_id.clone(),
                fact: fact.clone(),
                source: source.clone(),
            },
        ));
        Self::new(history, initial_grants)
    }

    pub fn new(history: &ValidatedHistory, grants: Vec<SourceVisibilityGrant>) -> GameResult<Self> {
        let mut result = BTreeSet::new();
        for grant in grants {
            let actor = find_entity(history.current_state(), &grant.actor_id)?;
            if actor.kind != EntityKind::Person
                || !history
                    .sources
                    .contains(&(grant.fact.clone(), grant.source.clone()))
            {
                return Err(GameError::InvalidKnowledge);
            }
            result.insert((grant.actor_id, grant.fact, grant.source));
        }
        Ok(Self {
            history_identity: history.identity,
            grants: result,
        })
    }

    fn validate_for(&self, history: &ValidatedHistory, actor_id: &str) -> GameResult {
        if self.history_identity != history.identity {
            return Err(GameError::Conflict);
        }
        if find_entity(history.current_state(), actor_id)?.kind != EntityKind::Person {
            return Err(GameError::InvalidKnowledge);
        }
        Ok(())
    }

    fn contains(&self, actor_id: &str, fact: &FactKey, source: &StateSource) -> bool {
        self.grants
            .contains(&(actor_id.to_owned(), fact.clone(), source.clone()))
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "status", rename_all = "snake_case")]
pub enum KnownValue<T> {
    Unknown,
    Known { value: T, source: StateSource },
}

impl<T> KnownValue<T> {
    pub fn value(&self) -> Option<&T> {
        match self {
            Self::Unknown => None,
            Self::Known { value, .. } => Some(value),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorEntityFacts {
    pub entity_id: String,
    pub name: KnownValue<String>,
    pub alive: KnownValue<bool>,
    /// Unknown attribute names are omitted as well as their values.
    pub attributes: BTreeMap<String, KnownValue<String>>,
    pub aliases: Vec<KnownValue<String>>,
}

pub fn actor_fact_view(
    history: &ValidatedHistory,
    visibility: &SourceVisibilityIndex,
    actor_id: &str,
    entity_id: &str,
) -> GameResult<ActorEntityFacts> {
    visibility.validate_for(history, actor_id)?;
    find_entity(history.current_state(), entity_id)?;
    let mut result = ActorEntityFacts {
        entity_id: entity_id.into(),
        name: KnownValue::Unknown,
        alive: KnownValue::Unknown,
        attributes: BTreeMap::new(),
        aliases: Vec::new(),
    };
    for (fact, revisions) in &history.revisions {
        let entity_matches = match fact {
            FactKey::EntityName { entity_id: id }
            | FactKey::EntityLife { entity_id: id }
            | FactKey::EntityAttribute { entity_id: id, .. }
            | FactKey::EntityAlias { entity_id: id, .. } => id == entity_id,
            _ => false,
        };
        if !entity_matches {
            continue;
        }
        let Some(revision) = revisions
            .iter()
            .rev()
            .find(|revision| visibility.contains(actor_id, fact, &revision.source))
        else {
            continue;
        };
        let known_string = |value: &serde_json::Value| -> GameResult<KnownValue<String>> {
            Ok(KnownValue::Known {
                value: value.as_str().ok_or(GameError::InvalidKnowledge)?.into(),
                source: revision.source.clone(),
            })
        };
        match fact {
            FactKey::EntityName { .. } => result.name = known_string(&revision.value)?,
            FactKey::EntityLife { .. } => {
                result.alive = KnownValue::Known {
                    value: revision
                        .value
                        .as_bool()
                        .ok_or(GameError::InvalidKnowledge)?,
                    source: revision.source.clone(),
                }
            }
            FactKey::EntityAttribute { key, .. } => {
                result
                    .attributes
                    .insert(key.clone(), known_string(&revision.value)?);
            }
            FactKey::EntityAlias { .. } => {
                result.aliases.push(known_string(&revision.value["text"])?)
            }
            _ => {}
        }
    }
    let mut aliases: BTreeSet<String> = result
        .aliases
        .iter()
        .filter_map(|alias| alias.value().cloned())
        .collect();
    let name_key = FactKey::EntityName {
        entity_id: entity_id.into(),
    };
    if let Some(names) = history.revisions.get(&name_key) {
        for name in names
            .iter()
            .rev()
            .filter(|name| visibility.contains(actor_id, &name_key, &name.source))
        {
            let old_name = name.value.as_str().ok_or(GameError::InvalidKnowledge)?;
            if result
                .name
                .value()
                .is_some_and(|current| current == old_name)
                || !aliases.insert(old_name.into())
            {
                continue;
            }
            // A name this actor previously knew remains a usable identity
            // reference, even if no separate alias observation was issued.
            result.aliases.push(KnownValue::Known {
                value: old_name.into(),
                source: name.source.clone(),
            });
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibleNameCandidate {
    pub entity_id: String,
    pub display_name: String,
    pub matched_names: Vec<String>,
}

/// Exact, trimmed matching. A name collision returns every visible candidate;
/// no relation score, list position, or global secret name resolves it silently.
pub fn resolve_visible_name(
    history: &ValidatedHistory,
    visibility: &SourceVisibilityIndex,
    actor_id: &str,
    name: &str,
) -> GameResult<Vec<VisibleNameCandidate>> {
    visibility.validate_for(history, actor_id)?;
    let name = name.trim();
    if name.is_empty() || name.len() > 256 || name.chars().any(char::is_control) {
        return Err(GameError::InvalidEntity);
    }
    let mut result = Vec::new();
    for entity in &history.current_state().entities {
        let view = actor_fact_view(history, visibility, actor_id, &entity.id)?;
        let mut matched_names = BTreeSet::new();
        if view.name.value().is_some_and(|known| known == name) {
            matched_names.insert(name.to_owned());
        }
        for alias in &view.aliases {
            if alias.value().is_some_and(|known| known == name) {
                matched_names.insert(name.to_owned());
            }
        }
        if !matched_names.is_empty() {
            result.push(VisibleNameCandidate {
                entity_id: entity.id.clone(),
                display_name: view
                    .name
                    .value()
                    .cloned()
                    .unwrap_or_else(|| name.to_owned()),
                matched_names: matched_names.into_iter().collect(),
            });
        }
    }
    Ok(result)
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorKnowledge {
    pub target_type: KnowledgeTarget,
    pub target_id: String,
    pub known_text: String,
    pub certainty: Certainty,
    pub acquisition_mode: AcquisitionMode,
    pub known_evidence_event_ids: Vec<String>,
    pub source: StateSource,
}

#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActorObservedFact {
    pub fact_key: FactKey,
    pub value: serde_json::Value,
    pub source: StateSource,
}

/// Each value is the most recent version this actor was formally allowed to
/// learn, including inventory/conditions/time. It is never the global latest
/// value merely because the target has the same stable ID.
pub fn observed_facts_for_actor(
    history: &ValidatedHistory,
    visibility: &SourceVisibilityIndex,
    actor_id: &str,
) -> GameResult<Vec<ActorObservedFact>> {
    visibility.validate_for(history, actor_id)?;
    Ok(history
        .revisions
        .iter()
        .filter_map(|(fact, revisions)| {
            revisions
                .iter()
                .rev()
                .find(|revision| visibility.contains(actor_id, fact, &revision.source))
                .map(|revision| ActorObservedFact {
                    fact_key: fact.clone(),
                    value: revision.value.clone(),
                    source: revision.source.clone(),
                })
        })
        .collect())
}

/// Deliberately does not return Claim, global assessment or its later evidence.
pub fn knowledge_for_actor(
    history: &ValidatedHistory,
    actor_id: &str,
) -> GameResult<Vec<ActorKnowledge>> {
    if find_entity(history.current_state(), actor_id)?.kind != EntityKind::Person {
        return Err(GameError::InvalidKnowledge);
    }
    Ok(history
        .current_state()
        .knowledge
        .iter()
        .filter(|knowledge| knowledge.actor_id == actor_id)
        .map(|knowledge| ActorKnowledge {
            target_type: knowledge.target_type,
            target_id: knowledge.target_id.clone(),
            known_text: knowledge.known_text.clone(),
            certainty: knowledge.certainty,
            acquisition_mode: knowledge.acquisition_mode,
            known_evidence_event_ids: knowledge.known_evidence_event_ids.clone(),
            source: knowledge.source.clone(),
        })
        .collect())
}

/// A character-only input, kept separate from objective narrator facts. The
/// byte limit applies to the exact UTF-8 JSON returned; no necessary fact is
/// silently removed. Sources remain queryable locally, outside this compact DTO.
pub fn minimal_actor_fact_json(
    history: &ValidatedHistory,
    visibility: &SourceVisibilityIndex,
    actor_id: &str,
    max_bytes: usize,
) -> GameResult<String> {
    visibility.validate_for(history, actor_id)?;
    let mut entities = Vec::new();
    for entity in &history.current_state().entities {
        let facts = actor_fact_view(history, visibility, actor_id, &entity.id)?;
        if facts.name.value().is_none()
            && facts.alive.value().is_none()
            && facts.attributes.is_empty()
            && facts.aliases.is_empty()
        {
            continue;
        }
        entities.push(serde_json::json!({
            "entityId": facts.entity_id,
            "name": facts.name.value(),
            "alive": facts.alive.value(),
            "attributes": facts.attributes.into_iter().filter_map(|(key, value)| value.value().cloned().map(|value| (key, value))).collect::<BTreeMap<_, _>>(),
            "aliases": facts.aliases.iter().filter_map(KnownValue::value).collect::<Vec<_>>()
        }));
    }
    let knowledge = knowledge_for_actor(history, actor_id)?
        .into_iter()
        .map(|known| {
            serde_json::json!({
                "targetType": known.target_type,
                "targetId": known.target_id,
                "text": known.known_text,
                "certainty": known.certainty,
                "acquisitionMode": known.acquisition_mode,
                "knownEvidenceEventIds": known.known_evidence_event_ids
            })
        })
        .collect::<Vec<_>>();
    let observed_facts = observed_facts_for_actor(history, visibility, actor_id)?
        .into_iter()
        .map(|fact| serde_json::json!({"factKey":fact.fact_key,"value":fact.value}))
        .collect::<Vec<_>>();
    let json = serde_json::to_string(
        &serde_json::json!({ "actorId": actor_id, "entities": entities, "knowledge": knowledge, "observedFacts": observed_facts }),
    )
    .map_err(|_| GameError::InvalidKnowledge)?;
    if json.len() > max_bytes {
        return Err(GameError::TooLarge);
    }
    Ok(json)
}

/// Objective inputs for the narrator, deliberately separate from character
/// views. All current formal values remain; only verbose provenance is omitted.
/// No source pruning or history truncation changes facts to fit this limit.
pub fn minimal_narrator_fact_json(
    history: &ValidatedHistory,
    max_bytes: usize,
) -> GameResult<String> {
    let state = history.current_state();
    let facts = fact_sources(state).keys().map(|fact| {
        Ok(serde_json::json!({"factKey": fact, "value": fact_value_v2(state, fact).ok_or(GameError::InvalidReference)?}))
    }).collect::<GameResult<Vec<_>>>()?;
    let knowledge = state.knowledge.iter().map(|known| serde_json::json!({
        "actorId":known.actor_id,"targetType":known.target_type,"targetId":known.target_id,
        "knownText":known.known_text,"certainty":known.certainty,"acquisitionMode":known.acquisition_mode,
        "knownEvidenceEventIds":known.known_evidence_event_ids
    })).collect::<Vec<_>>();
    let legacy_attributes = state
        .entities
        .iter()
        .flat_map(|entity| {
            entity
                .attribute_sources
                .iter()
                .filter(|(_, source)| matches!(source, StateSource::LegacySnapshot { .. }))
                .map(|(key, _)| serde_json::json!({"entityId":entity.id,"key":key}))
        })
        .collect::<Vec<_>>();
    let observations = state.fact_observations.iter().map(|observation| {
        let value = history.revisions.get(&observation.fact_key).and_then(|values|values.iter().find(|revision| revision.source == observation.fact_source)).ok_or(GameError::InvalidKnowledge)?;
        Ok(serde_json::json!({"actorId":observation.actor_id,"factKey":observation.fact_key,"knownValue":value.value}))
    }).collect::<GameResult<Vec<_>>>()?;
    let json = serde_json::to_string(&serde_json::json!({
        "protocolVersion":2,"worldId":history.world_id(),"headTurnId":history.head_turn_id(),
        "protagonistId":state.protagonist_id,"facts":facts,"knowledge":knowledge,
        "legacyAttributeKeys":legacy_attributes,
        "factObservations":observations
    }))
    .map_err(|_| GameError::InvalidOutput)?;
    if json.len() > max_bytes {
        return Err(GameError::TooLarge);
    }
    Ok(json)
}
