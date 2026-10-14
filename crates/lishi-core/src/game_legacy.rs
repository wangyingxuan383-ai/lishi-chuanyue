//! Deterministic, read-only v1 to v2 compatibility projection.
//!
//! A complete archive is streamed in sequence. Only the initial/current
//! projections, current v1 snapshot and expected final snapshot are retained;
//! the adapter never stores every full snapshot or rewrites original JSON.
//! The archive's independent audit additionally covers failed operation inputs.

use std::collections::{BTreeMap, BTreeSet};

use sha2::{Digest, Sha256};

use crate::game_archive::{LegacyTurn, LegacyWorldHeader, MAX_ARCHIVE_STATE_BYTES};
use crate::game_protocol::{
    apply_output, initial_state, parse_output, validate_setup, validate_state, Choice, Entity,
    EntityKind, GameError, GameResult, StateChange, WorldSetup, WorldState, MAX_NARRATIVE_BYTES,
    MAX_RESOURCE_AMOUNT,
};
use crate::game_protocol_v2::{
    validate_state_v2, AcquisitionMode, Certainty, ConditionCategory, ConditionV2, Disclosure,
    EntityV2, GameEventV2, GameTimeV2, HoldingStatus, HoldingValue, ItemHolding, Knowledge,
    KnowledgeTarget, RelationshipV2, ResourceV2, StateSource, WorldStateV2,
    GAME_PROTOCOL_VERSION_V2,
};
use crate::game_store::{valid_game_id, GameActionKind, MAX_ACTION_BYTES};

/// Result of a complete, successfully replayed v1 chain. The original header
/// and turn JSON remain in the archive; this is only a derived state projection.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LegacyAdaptedWorld {
    pub world_id: String,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
    pub initial_state: WorldStateV2,
    pub current_state: WorldStateV2,
    /// Length-prefixed raw header and committed turn records, including exact
    /// JSON whitespace. Unlike the archive fingerprint this excludes operations.
    pub raw_history_sha256: String,
}

pub struct LegacyAdapter {
    world_id: String,
    expected_head: Option<String>,
    expected_turn_count: u64,
    expected_current: WorldState,
    initial: WorldStateV2,
    current: WorldStateV2,
    previous: WorldState,
    head: Option<String>,
    turn_count: u64,
    seen_ids: BTreeSet<String>,
    trusted_bag_unchanged: bool,
    raw_hash: Sha256,
}

impl std::fmt::Debug for LegacyAdapter {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("LegacyAdapter")
            .field("turn_count", &self.turn_count)
            .field("read_only", &true)
            .finish_non_exhaustive()
    }
}

impl LegacyAdapter {
    pub fn from_header(header: &LegacyWorldHeader) -> GameResult<Self> {
        let setup: WorldSetup = decode(&header.setup_json, 32 * 1024)?;
        validate_setup(&setup)?;
        let previous: WorldState = decode(&header.initial_state_json, MAX_ARCHIVE_STATE_BYTES)?;
        let expected_current: WorldState =
            decode(&header.current_state_json, MAX_ARCHIVE_STATE_BYTES)?;
        validate_state(&previous)?;
        validate_state(&expected_current)?;
        if header.world_id != setup.world_id
            || !valid_game_id(&header.world_id)
            || previous.time.era_year != setup.era_year
            || previous.time.elapsed_seconds != 0
            || header.created_at_ms < 0
            || header
                .head_turn_id
                .as_deref()
                .is_some_and(|id| !valid_game_id(id))
            || (header.turn_count == 0) != header.head_turn_id.is_none()
        {
            return Err(GameError::InvalidReference);
        }
        let trusted_bag_unchanged = previous == initial_state(&setup)?;
        let initial =
            convert_snapshot(None, &previous, &legacy_source(None), trusted_bag_unchanged)?;
        let mut raw_hash = Sha256::new();
        raw_hash.update(b"lishi-v1-adapter-raw\0");
        hash_header(&mut raw_hash, header);
        Ok(Self {
            world_id: header.world_id.clone(),
            expected_head: header.head_turn_id.clone(),
            expected_turn_count: header.turn_count,
            expected_current,
            current: initial.clone(),
            initial,
            previous,
            head: None,
            turn_count: 0,
            seen_ids: BTreeSet::new(),
            trusted_bag_unchanged,
            raw_hash,
        })
    }

    /// Returns the complete converted state at this exact historical node.
    /// Callers can persist/query each projection without retaining all states.
    /// A rejected row leaves every adapter field and the hash unchanged.
    pub fn push_turn(&mut self, turn: &LegacyTurn) -> GameResult<&WorldStateV2> {
        if self.turn_count >= self.expected_turn_count
            || turn.sequence != self.turn_count.checked_add(1).ok_or(GameError::TooLarge)?
            || turn.parent_turn_id != self.head
            || !valid_game_id(&turn.turn_id)
            || self.seen_ids.contains(&turn.turn_id)
            || turn.created_at_ms < 0
            || turn.action_text.len() > MAX_ACTION_BYTES
            || (turn.action_kind == GameActionKind::Action && turn.action_text.trim().is_empty())
            || !plain_text(&turn.action_text)
            || turn.narrative.len() > MAX_NARRATIVE_BYTES
        {
            return Err(GameError::InvalidReference);
        }
        let output = parse_output(&turn.output_json)?;
        let snapshot: WorldState = decode(&turn.state_json, MAX_ARCHIVE_STATE_BYTES)?;
        let choices: Vec<Choice> = decode(&turn.choices_json, 128 * 1024)?;
        let replayed = apply_output(&self.previous, &output)?;
        if replayed != snapshot || output.narrative != turn.narrative || output.choices != choices {
            return Err(GameError::InvalidReference);
        }
        let bag_unchanged = self.trusted_bag_unchanged
            && holding_attributes(bag(&self.previous)) == holding_attributes(bag(&snapshot))
            // A transfer and return in the same old turn must not reactivate
            // the trusted opening exception just because the final string is
            // identical. v1 did not provide formal custody semantics.
            && !output.state_changes.iter().any(|change| {
                matches!(change, StateChange::SetAttribute { entity_id, key, .. }
                    if entity_id == "travel-bag" && holding_key(key))
            });
        let next = convert_snapshot(
            Some((&self.previous, &self.current)),
            &snapshot,
            &legacy_source(Some(&turn.turn_id)),
            bag_unchanged,
        )?;
        hash_turn(&mut self.raw_hash, turn);
        self.seen_ids.insert(turn.turn_id.clone());
        self.turn_count = turn.sequence;
        self.head = Some(turn.turn_id.clone());
        self.trusted_bag_unchanged = bag_unchanged;
        self.previous = snapshot;
        self.current = next;
        Ok(&self.current)
    }

    pub fn world_id(&self) -> &str {
        &self.world_id
    }

    pub fn head_turn_id(&self) -> Option<&str> {
        self.head.as_deref()
    }

    pub fn turn_count(&self) -> u64 {
        self.turn_count
    }

    pub fn initial_state(&self) -> &WorldStateV2 {
        &self.initial
    }

    pub fn current_state(&self) -> &WorldStateV2 {
        &self.current
    }

    /// Completion requires the exact final head, number of rows and v1 state
    /// declared by the stable archive header. A truncated recent view fails.
    pub fn finish(self) -> GameResult<LegacyAdaptedWorld> {
        if self.turn_count != self.expected_turn_count
            || self.head != self.expected_head
            || self.previous != self.expected_current
        {
            return Err(GameError::Conflict);
        }
        Ok(LegacyAdaptedWorld {
            world_id: self.world_id,
            head_turn_id: self.head,
            turn_count: self.turn_count,
            initial_state: self.initial,
            current_state: self.current,
            raw_history_sha256: format!("{:x}", self.raw_hash.finalize()),
        })
    }
}

fn decode<T: serde::de::DeserializeOwned>(json: &str, limit: usize) -> GameResult<T> {
    if json.len() > limit {
        return Err(GameError::TooLarge);
    }
    serde_json::from_str(json).map_err(|_| GameError::InvalidProtocol)
}

fn legacy_source(turn_id: Option<&str>) -> StateSource {
    StateSource::LegacySnapshot {
        turn_id: turn_id.map(str::to_owned),
        format_version: 1,
    }
}

fn plain_text(value: &str) -> bool {
    !value
        .chars()
        .any(|ch| ch.is_control() && !matches!(ch, '\n' | '\r' | '\t'))
}

fn bag(state: &WorldState) -> Option<&Entity> {
    state.entities.iter().find(|e| e.id == "travel-bag")
}

fn holding_key(key: &str) -> bool {
    matches!(
        key.to_ascii_lowercase().as_str(),
        "ownerid" | "holderid" | "placeid" | "quantity" | "unit"
    )
}

fn holding_attributes(entity: Option<&Entity>) -> BTreeMap<&str, &str> {
    entity.map_or_else(BTreeMap::new, |entity| {
        entity
            .attributes
            .iter()
            .filter(|(key, _)| holding_key(key))
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect()
    })
}

fn unknown_holding() -> HoldingValue {
    HoldingValue {
        status: HoldingStatus::LegacyUnknown,
        holder_id: None,
        place_id: None,
        quantity: None,
        unit: None,
    }
}

/// Frozen conversion rule. Do not infer ownership, count or unit from the
/// item's name, narrative, event prose, quantity suffix or a similar key.
fn converted_holding(entity: &Entity, state: &WorldState, trusted_bag: bool) -> HoldingValue {
    let attributes = holding_attributes(Some(entity));
    if trusted_bag && entity.id == "travel-bag" {
        return HoldingValue {
            status: HoldingStatus::Known,
            holder_id: Some(state.protagonist_id.clone()),
            place_id: None,
            quantity: Some(1),
            unit: Some("件".into()),
        };
    }
    if attributes
        .keys()
        .any(|key| !matches!(*key, "ownerId" | "quantity" | "unit"))
    {
        return unknown_holding();
    }
    let (Some(owner), Some(quantity_text), Some(unit)) = (
        attributes.get("ownerId"),
        attributes.get("quantity"),
        attributes.get("unit"),
    ) else {
        return unknown_holding();
    };
    let Ok(quantity) = quantity_text.parse::<i64>() else {
        return unknown_holding();
    };
    if !(0..=MAX_RESOURCE_AMOUNT).contains(&quantity)
        || quantity.to_string() != *quantity_text
        || unit.trim().is_empty()
        || unit.len() > 64
        || unit.chars().any(char::is_control)
        || !state.entities.iter().any(|e| {
            e.id == **owner && matches!(e.kind, EntityKind::Person | EntityKind::Organization)
        })
    {
        return unknown_holding();
    }
    HoldingValue {
        status: HoldingStatus::Known,
        holder_id: (quantity > 0).then(|| (*owner).to_owned()),
        place_id: None,
        quantity: Some(quantity),
        unit: Some((*unit).to_owned()),
    }
}

fn convert_snapshot(
    previous: Option<(&WorldState, &WorldStateV2)>,
    state: &WorldState,
    source: &StateSource,
    trusted_bag: bool,
) -> GameResult<WorldStateV2> {
    validate_state(state)?;
    let old = previous.map(|(_, projection)| projection);
    let old_entities: BTreeMap<_, _> = old
        .into_iter()
        .flat_map(|s| &s.entities)
        .map(|e| (e.id.as_str(), e))
        .collect();
    let entities = state
        .entities
        .iter()
        .map(|entity| {
            let old = old_entities.get(entity.id.as_str()).copied();
            EntityV2 {
                id: entity.id.clone(),
                kind: entity.kind,
                name: entity.name.clone(),
                alive: entity.alive,
                attributes: entity.attributes.clone(),
                aliases: Vec::new(),
                created_source: old.map_or_else(|| source.clone(), |e| e.created_source.clone()),
                name_source: old
                    .filter(|e| e.name == entity.name)
                    .map_or_else(|| source.clone(), |e| e.name_source.clone()),
                life_source: old
                    .filter(|e| e.alive == entity.alive)
                    .map_or_else(|| source.clone(), |e| e.life_source.clone()),
                attribute_sources: entity
                    .attributes
                    .iter()
                    .map(|(key, value)| {
                        let unchanged = old.filter(|e| e.attributes.get(key) == Some(value));
                        (
                            key.clone(),
                            unchanged
                                .and_then(|e| e.attribute_sources.get(key))
                                .unwrap_or(source)
                                .clone(),
                        )
                    })
                    .collect(),
            }
        })
        .collect();
    let resources = state
        .resources
        .iter()
        .map(|resource| {
            let unchanged = old.into_iter().flat_map(|s| &s.resources).find(|r| {
                r.owner_id == resource.owner_id
                    && r.key == resource.key
                    && r.unit == resource.unit
                    && r.amount == resource.amount
            });
            ResourceV2 {
                owner_id: resource.owner_id.clone(),
                key: resource.key.clone(),
                unit: resource.unit.clone(),
                amount: resource.amount,
                last_changed_source: unchanged
                    .map_or_else(|| source.clone(), |r| r.last_changed_source.clone()),
            }
        })
        .collect();
    let relationships = state
        .relationships
        .iter()
        .map(|relationship| {
            let unchanged = old.into_iter().flat_map(|s| &s.relationships).find(|r| {
                r.from_id == relationship.from_id
                    && r.to_id == relationship.to_id
                    && r.kind == relationship.kind
                    && r.strength == relationship.strength
            });
            RelationshipV2 {
                from_id: relationship.from_id.clone(),
                to_id: relationship.to_id.clone(),
                kind: relationship.kind.clone(),
                strength: relationship.strength,
                last_changed_source: unchanged
                    .map_or_else(|| source.clone(), |r| r.last_changed_source.clone()),
            }
        })
        .collect();
    let item_holdings = state
        .entities
        .iter()
        .filter(|e| e.kind == EntityKind::Item)
        .map(|entity| {
            let value = converted_holding(entity, state, trusted_bag);
            let old_record = old
                .into_iter()
                .flat_map(|s| &s.item_holdings)
                .find(|h| h.item_id == entity.id);
            let previous_entity =
                previous.and_then(|(s, _)| s.entities.iter().find(|e| e.id == entity.id));
            let unchanged = old_record.filter(|h| {
                h.value == value
                    && holding_attributes(previous_entity) == holding_attributes(Some(entity))
            });
            ItemHolding {
                item_id: entity.id.clone(),
                value,
                source: unchanged.map_or_else(
                    || {
                        if trusted_bag && entity.id == "travel-bag" {
                            StateSource::Initial
                        } else {
                            source.clone()
                        }
                    },
                    |h| h.source.clone(),
                ),
            }
        })
        .collect();
    let conditions = state
        .conditions
        .iter()
        .map(|condition| {
            let previous = old
                .into_iter()
                .flat_map(|s| &s.conditions)
                .find(|c| c.id == condition.id);
            let unchanged = previous.filter(|c| {
                c.description == condition.description
                    && c.active == condition.active
                    && c.entity_id == condition.entity_id
            });
            let changed_source =
                unchanged.map_or_else(|| source.clone(), |c| c.last_changed_source.clone());
            ConditionV2 {
                id: condition.id.clone(),
                entity_id: condition.entity_id.clone(),
                description: condition.description.clone(),
                category: ConditionCategory::LegacyUnspecified,
                active: condition.active,
                started_source: previous
                    .map_or_else(|| source.clone(), |c| c.started_source.clone()),
                last_changed_source: changed_source.clone(),
                resolved_source: (!condition.active).then_some(changed_source),
            }
        })
        .collect();
    let events = state
        .events
        .iter()
        .map(|event| {
            let previous = old
                .into_iter()
                .flat_map(|s| &s.events)
                .find(|e| e.id == event.id);
            GameEventV2 {
                id: event.id.clone(),
                description: event.description.clone(),
                entity_ids: event.entity_ids.clone(),
                disclosure: Disclosure::LegacyUnspecified,
                created_source: previous
                    .map_or_else(|| source.clone(), |e| e.created_source.clone()),
            }
        })
        .collect();
    let knowledge = state
        .known_facts
        .iter()
        .map(|fact| {
            let previous = old.into_iter().flat_map(|s| &s.knowledge).find(|k| {
                k.actor_id == fact.actor_id
                    && k.target_type == KnowledgeTarget::Event
                    && k.target_id == fact.fact_id
            });
            let event = state
                .events
                .iter()
                .find(|event| event.id == fact.fact_id)
                .ok_or(GameError::InvalidKnowledge)?;
            Ok(Knowledge {
                actor_id: fact.actor_id.clone(),
                target_type: KnowledgeTarget::Event,
                target_id: fact.fact_id.clone(),
                certainty: Certainty::LegacyUnspecified,
                acquisition_mode: AcquisitionMode::LegacyUnspecified,
                acquisition_event_id: None,
                source: previous.map_or_else(|| source.clone(), |k| k.source.clone()),
                known_text: event.description.clone(),
                known_evidence_event_ids: Vec::new(),
            })
        })
        .collect::<GameResult<Vec<_>>>()?;
    let projection = WorldStateV2 {
        protocol_version: GAME_PROTOCOL_VERSION_V2,
        time: GameTimeV2 {
            era_year: state.time.era_year,
            precision: state.time.precision,
            elapsed_seconds: state.time.elapsed_seconds,
            last_changed_source: old
                .filter(|s| {
                    s.time.era_year == state.time.era_year
                        && s.time.precision == state.time.precision
                        && s.time.elapsed_seconds == state.time.elapsed_seconds
                })
                .map_or_else(|| source.clone(), |s| s.time.last_changed_source.clone()),
        },
        location_id: state.location_id.clone(),
        location_source: old
            .filter(|s| s.location_id == state.location_id)
            .map_or_else(|| source.clone(), |s| s.location_source.clone()),
        protagonist_id: state.protagonist_id.clone(),
        entities,
        resources,
        relationships,
        item_holdings,
        conditions,
        events,
        claims: Vec::new(),
        knowledge,
        fact_observations: Vec::new(),
    };
    validate_state_v2(&projection)?;
    Ok(projection)
}

fn hash_text(hash: &mut Sha256, value: &str) {
    hash.update((value.len() as u64).to_le_bytes());
    hash.update(value.as_bytes());
}

fn hash_optional(hash: &mut Sha256, value: Option<&str>) {
    hash.update([u8::from(value.is_some())]);
    if let Some(value) = value {
        hash_text(hash, value);
    }
}

fn hash_header(hash: &mut Sha256, header: &LegacyWorldHeader) {
    for field in [
        &header.world_id,
        &header.setup_json,
        &header.initial_state_json,
        &header.current_state_json,
        &header.opening_narrative,
        &header.opening_choices_json,
        &header.narrative_policy,
    ] {
        hash_text(hash, field);
    }
    hash_optional(hash, header.head_turn_id.as_deref());
    hash.update(header.turn_count.to_le_bytes());
    hash.update(header.created_at_ms.to_le_bytes());
}

fn hash_turn(hash: &mut Sha256, turn: &LegacyTurn) {
    hash.update(b"turn\0");
    hash_text(hash, &turn.turn_id);
    hash_optional(hash, turn.parent_turn_id.as_deref());
    hash.update(turn.sequence.to_le_bytes());
    for field in [
        match turn.action_kind {
            GameActionKind::Action => "action",
            GameActionKind::Continue => "continue",
        },
        &turn.action_text,
        &turn.narrative,
        &turn.choices_json,
        &turn.state_json,
        &turn.output_json,
    ] {
        hash_text(hash, field);
    }
    hash.update(turn.created_at_ms.to_le_bytes());
}
