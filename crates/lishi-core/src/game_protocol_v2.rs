//! Strict, opt-in v2 facts. This module does not upgrade or write a save.
//!
//! Model input types deliberately omit provenance. A trusted commit context
//! supplies provenance only after the complete candidate has been validated.
//! The store remains responsible for locking, head CAS and atomic persistence.

use std::collections::{BTreeMap, BTreeSet};

use serde::{Deserialize, Deserializer, Serialize};

pub use crate::game_protocol::{
    Choice, DatePrecision, EntityKind, GameError, GameResult, WorldSetup,
};
use crate::game_protocol::{
    MAX_CHOICES, MAX_ELAPSED_SECONDS, MAX_ENTITIES, MAX_EVENTS, MAX_KNOWN_FACTS,
    MAX_NARRATIVE_BYTES, MAX_RESOURCE_AMOUNT, MAX_STATE_ITEMS, MAX_TURN_OUTPUT_BYTES,
};

pub const GAME_PROTOCOL_VERSION_V2: u32 = 2;
pub const MAX_ALIASES: usize = 32;
pub const MAX_CLAIMS: usize = 4096;

/// Supplied by the core, never decoded from a model response. This is not a
/// replacement for the store's expected-head check.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitContext {
    pub operation_id: String,
    pub turn_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StateSource {
    Initial,
    Turn {
        operation_id: String,
        turn_id: String,
        event_id: String,
    },
    LegacySnapshot {
        #[serde(deserialize_with = "required_nullable")]
        turn_id: Option<String>,
        format_version: u32,
    },
}

/// One fact, never a wildcard for an entity or every fact in an event.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum FactKey {
    EntityCreated {
        entity_id: String,
    },
    EntityName {
        entity_id: String,
    },
    EntityLife {
        entity_id: String,
    },
    EntityAttribute {
        entity_id: String,
        key: String,
    },
    EntityAlias {
        entity_id: String,
        text: String,
    },
    ItemHolding {
        item_id: String,
    },
    Condition {
        condition_id: String,
    },
    Resource {
        owner_id: String,
        key: String,
    },
    Relationship {
        from_id: String,
        to_id: String,
        kind: String,
    },
    Event {
        event_id: String,
    },
    Claim {
        claim_id: String,
    },
    Time,
    Location,
}

/// The latest formally acquired version of one fact. Immutable earlier turn
/// snapshots keep previous observations. Model input cannot supply sources.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FactObservation {
    pub actor_id: String,
    pub fact_key: FactKey,
    pub fact_source: StateSource,
    pub acquisition_source: StateSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameTimeV2 {
    pub era_year: i32,
    pub precision: DatePrecision,
    pub elapsed_seconds: u64,
    pub last_changed_source: StateSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AliasKind {
    FormerName,
    Nickname,
    Title,
    Transliteration,
    Other,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityAlias {
    pub text: String,
    pub kind: AliasKind,
    pub source: StateSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityV2 {
    pub id: String,
    pub kind: EntityKind,
    pub name: String,
    #[serde(deserialize_with = "required_nullable")]
    pub alive: Option<bool>,
    pub attributes: BTreeMap<String, String>,
    pub aliases: Vec<EntityAlias>,
    pub created_source: StateSource,
    pub name_source: StateSource,
    pub life_source: StateSource,
    pub attribute_sources: BTreeMap<String, StateSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EntityInput {
    pub id: String,
    pub kind: EntityKind,
    pub name: String,
    #[serde(deserialize_with = "required_nullable")]
    pub alive: Option<bool>,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ResourceV2 {
    pub owner_id: String,
    pub key: String,
    pub unit: String,
    pub amount: i64,
    pub last_changed_source: StateSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RelationshipV2 {
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub strength: i32,
    pub last_changed_source: StateSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum HoldingStatus {
    Known,
    LegacyUnknown,
}

/// Complete optimistic precondition. Null is an explicit absence, not a
/// wildcard. Zero stock retains the unit and loses its custodian/location.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct HoldingValue {
    pub status: HoldingStatus,
    #[serde(deserialize_with = "required_nullable")]
    pub holder_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub place_id: Option<String>,
    #[serde(deserialize_with = "required_nullable")]
    pub quantity: Option<i64>,
    #[serde(deserialize_with = "required_nullable")]
    pub unit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ItemHolding {
    pub item_id: String,
    pub value: HoldingValue,
    pub source: StateSource,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ConditionCategory {
    Injury,
    Illness,
    Obligation,
    Other,
    LegacyUnspecified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConditionV2 {
    pub id: String,
    pub entity_id: String,
    pub description: String,
    pub category: ConditionCategory,
    pub active: bool,
    pub started_source: StateSource,
    pub last_changed_source: StateSource,
    #[serde(deserialize_with = "required_nullable")]
    pub resolved_source: Option<StateSource>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConditionInput {
    pub id: String,
    pub entity_id: String,
    pub description: String,
    pub category: ConditionCategory,
    pub active: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Disclosure {
    Public,
    Restricted,
    LegacyUnspecified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameEventV2 {
    pub id: String,
    pub description: String,
    pub entity_ids: Vec<String>,
    pub disclosure: Disclosure,
    pub created_source: StateSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventInput {
    pub id: String,
    pub description: String,
    pub entity_ids: Vec<String>,
    pub disclosure: Disclosure,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClaimAssessment {
    Unverified,
    Supported,
    Refuted,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Claim {
    pub id: String,
    pub text: String,
    pub entity_ids: Vec<String>,
    pub assessment: ClaimAssessment,
    pub evidence_event_ids: Vec<String>,
    pub created_source: StateSource,
    pub last_changed_source: StateSource,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimInput {
    pub id: String,
    pub text: String,
    pub entity_ids: Vec<String>,
    pub assessment: ClaimAssessment,
    pub evidence_event_ids: Vec<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum KnowledgeTarget {
    Event,
    Claim,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Certainty {
    Certain,
    Reported,
    Doubtful,
    LegacyUnspecified,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AcquisitionMode {
    Observed,
    Told,
    Inferred,
    LegacyUnspecified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Knowledge {
    pub actor_id: String,
    pub target_type: KnowledgeTarget,
    pub target_id: String,
    pub certainty: Certainty,
    pub acquisition_mode: AcquisitionMode,
    #[serde(deserialize_with = "required_nullable")]
    pub acquisition_event_id: Option<String>,
    pub source: StateSource,
    /// Frozen at acquisition/update. Never refresh this from global assessment.
    pub known_text: String,
    pub known_evidence_event_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldStateV2 {
    pub protocol_version: u32,
    pub time: GameTimeV2,
    pub location_id: String,
    pub location_source: StateSource,
    pub protagonist_id: String,
    pub entities: Vec<EntityV2>,
    pub resources: Vec<ResourceV2>,
    pub relationships: Vec<RelationshipV2>,
    pub item_holdings: Vec<ItemHolding>,
    pub conditions: Vec<ConditionV2>,
    pub events: Vec<GameEventV2>,
    pub claims: Vec<Claim>,
    pub knowledge: Vec<Knowledge>,
    pub fact_observations: Vec<FactObservation>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeAdvanceV2 {
    pub elapsed_seconds: u64,
    #[serde(deserialize_with = "required_nullable")]
    pub event_id: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StateChangeV2 {
    CreateEntity {
        entity: EntityInput,
        event_id: String,
    },
    RenameEntity {
        entity_id: String,
        expected_name: String,
        new_name: String,
        event_id: String,
    },
    AddAlias {
        entity_id: String,
        text: String,
        kind: AliasKind,
        event_id: String,
    },
    SetAttribute {
        entity_id: String,
        key: String,
        value: String,
        #[serde(deserialize_with = "required_nullable")]
        expected_value: Option<String>,
        event_id: String,
    },
    SetLifeStatus {
        entity_id: String,
        alive: bool,
        event_id: String,
    },
    Move {
        location_id: String,
        event_id: String,
    },
    ChangeResource {
        owner_id: String,
        key: String,
        unit: String,
        delta: i64,
        #[serde(deserialize_with = "required_nullable")]
        expected_amount: Option<i64>,
        event_id: String,
    },
    ChangeRelationship {
        from_id: String,
        to_id: String,
        kind: String,
        strength: i32,
        event_id: String,
    },
    SetItemHolding {
        item_id: String,
        #[serde(deserialize_with = "required_nullable")]
        expected_holding: Option<HoldingValue>,
        #[serde(deserialize_with = "required_nullable")]
        holder_id: Option<String>,
        #[serde(deserialize_with = "required_nullable")]
        place_id: Option<String>,
        quantity: i64,
        unit: String,
        event_id: String,
    },
    ChangeItemQuantity {
        item_id: String,
        expected_holding: HoldingValue,
        delta: i64,
        event_id: String,
    },
    AddCondition {
        condition: ConditionInput,
        event_id: String,
    },
    UpdateCondition {
        condition_id: String,
        expected_description: String,
        new_description: String,
        event_id: String,
    },
    ResolveCondition {
        condition_id: String,
        event_id: String,
    },
    CreateClaim {
        claim: ClaimInput,
        event_id: String,
    },
    AssessClaim {
        claim_id: String,
        expected_assessment: ClaimAssessment,
        assessment: ClaimAssessment,
        evidence_event_ids: Vec<String>,
        event_id: String,
    },
    RecordKnowledge {
        actor_id: String,
        target_type: KnowledgeTarget,
        target_id: String,
        certainty: Certainty,
        acquisition_mode: AcquisitionMode,
        known_evidence_event_ids: Vec<String>,
        event_id: String,
    },
    UpdateKnowledge {
        actor_id: String,
        target_type: KnowledgeTarget,
        target_id: String,
        expected_certainty: Certainty,
        certainty: Certainty,
        acquisition_mode: AcquisitionMode,
        known_evidence_event_ids: Vec<String>,
        event_id: String,
    },
    ObserveFact {
        actor_id: String,
        fact_key: FactKey,
        event_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnOutputV2 {
    pub protocol_version: u32,
    pub narrative: String,
    pub choices: Vec<Choice>,
    pub time_advance: TimeAdvanceV2,
    pub state_changes: Vec<StateChangeV2>,
    pub events: Vec<EventInput>,
    pub source_references: Vec<String>,
    pub uncertainties: Vec<String>,
}

fn required_nullable<'de, D, T>(deserializer: D) -> Result<Option<T>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Option::<T>::deserialize(deserializer)
}

fn identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 64
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn commit_identifier(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= 128
        && value
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_'))
}

fn text(value: &str, limit: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value.len() <= limit
        && !value
            .chars()
            .any(|c| c.is_control() && !(multiline && matches!(c, '\n' | '\r' | '\t')))
}

fn attribute_key(key: &str, kind: EntityKind, legacy: bool) -> bool {
    if !text(key, 64, false)
        || key != key.trim()
        || matches!(
            key.to_ascii_lowercase().as_str(),
            "id" | "kind"
                | "name"
                | "alive"
                | "location"
                | "locationid"
                | "protagonistid"
                | "time"
                | "erayear"
                | "elapsedseconds"
                | "protocolversion"
        )
    {
        return false;
    }
    if legacy {
        // v1 admitted these as ordinary string attributes. Keeping their
        // original text does not turn them into v2 provenance or inventory.
        return true;
    }
    !matches!(
        key.to_ascii_lowercase().as_str(),
        "aliases" | "createdsource" | "namesource" | "lifesource" | "attributesources"
    ) && (kind != EntityKind::Item
        || !matches!(
            key.to_ascii_lowercase().as_str(),
            "ownerid" | "holderid" | "placeid" | "quantity" | "unit"
        ))
}

fn life_valid(kind: EntityKind, alive: Option<bool>) -> bool {
    matches!(
        (kind, alive),
        (EntityKind::Person, Some(_))
            | (
                EntityKind::Place | EntityKind::Organization | EntityKind::Item,
                None
            )
    )
}

fn entity_input_valid(entity: &EntityInput) -> bool {
    identifier(&entity.id)
        && text(&entity.name, 256, false)
        && life_valid(entity.kind, entity.alive)
        && entity.attributes.len() <= 64
        && entity
            .attributes
            .iter()
            .all(|(k, v)| attribute_key(k, entity.kind, false) && text(v, 2048, true))
}

fn source_shape(source: &StateSource) -> bool {
    match source {
        StateSource::Initial => true,
        StateSource::Turn {
            operation_id,
            turn_id,
            event_id,
        } => commit_identifier(operation_id) && commit_identifier(turn_id) && identifier(event_id),
        StateSource::LegacySnapshot {
            turn_id,
            format_version,
        } => *format_version == 1 && turn_id.as_ref().is_none_or(|id| commit_identifier(id)),
    }
}

fn source_valid(
    source: &StateSource,
    events: &BTreeMap<&str, &GameEventV2>,
    subjects: &[&str],
) -> bool {
    if !source_shape(source) {
        return false;
    }
    match source {
        StateSource::Turn {
            operation_id,
            turn_id,
            event_id,
        } => {
            matches!(events.get(event_id.as_str()),Some(event) if matches!(&event.created_source,StateSource::Turn{operation_id:op,turn_id:turn,event_id:id} if op==operation_id && turn==turn_id && id==event_id) && subjects.iter().all(|id| event.entity_ids.iter().any(|reference| reference==id)))
        }
        StateSource::Initial | StateSource::LegacySnapshot { .. } => true,
    }
}

fn ids_valid(ids: &[String], entities: &BTreeMap<&str, &EntityV2>) -> bool {
    let mut seen = BTreeSet::new();
    ids.len() <= 64
        && ids
            .iter()
            .all(|id| entities.contains_key(id.as_str()) && seen.insert(id.as_str()))
}

fn event_ids_valid(ids: &[String], events: &BTreeMap<&str, &GameEventV2>) -> bool {
    let mut seen = BTreeSet::new();
    ids.len() <= 64
        && ids
            .iter()
            .all(|id| events.contains_key(id.as_str()) && seen.insert(id.as_str()))
}

fn holding_valid(value: &HoldingValue, entities: &BTreeMap<&str, &EntityV2>) -> bool {
    match value.status {
        HoldingStatus::LegacyUnknown => {
            value.holder_id.is_none()
                && value.place_id.is_none()
                && value.quantity.is_none()
                && value.unit.is_none()
        }
        HoldingStatus::Known => {
            let Some(quantity) = value.quantity else {
                return false;
            };
            if !(0..=MAX_RESOURCE_AMOUNT).contains(&quantity)
                || !value
                    .unit
                    .as_ref()
                    .is_some_and(|unit| text(unit, 64, false))
            {
                return false;
            }
            if quantity == 0 {
                return value.holder_id.is_none() && value.place_id.is_none();
            }
            match (&value.holder_id, &value.place_id) {
                (Some(holder), None) => {
                    matches!(entities.get(holder.as_str()),Some(e) if matches!(e.kind,EntityKind::Person|EntityKind::Organization))
                }
                (None, Some(place)) => {
                    matches!(entities.get(place.as_str()),Some(e) if e.kind==EntityKind::Place)
                }
                _ => false,
            }
        }
    }
}

/// Internal lookup on a candidate. Public readers validate the snapshot first;
/// applying an observation must also work before final whole-turn validation.
pub(crate) fn fact_source_v2<'a>(
    state: &'a WorldStateV2,
    fact: &FactKey,
) -> Option<&'a StateSource> {
    let entity = |id: &str| state.entities.iter().find(|e| e.id == id);
    match fact {
        FactKey::EntityCreated { entity_id } => entity(entity_id).map(|e| &e.created_source),
        FactKey::EntityName { entity_id } => entity(entity_id).map(|e| &e.name_source),
        FactKey::EntityLife { entity_id } => entity(entity_id)
            .filter(|e| e.alive.is_some())
            .map(|e| &e.life_source),
        FactKey::EntityAttribute { entity_id, key } => {
            entity(entity_id).and_then(|e| e.attribute_sources.get(key))
        }
        FactKey::EntityAlias { entity_id, text } => entity(entity_id)
            .and_then(|e| e.aliases.iter().find(|a| a.text == *text))
            .map(|a| &a.source),
        FactKey::ItemHolding { item_id } => state
            .item_holdings
            .iter()
            .find(|h| h.item_id == *item_id)
            .map(|h| &h.source),
        FactKey::Condition { condition_id } => state
            .conditions
            .iter()
            .find(|c| c.id == *condition_id)
            .map(|c| &c.last_changed_source),
        FactKey::Resource { owner_id, key } => state
            .resources
            .iter()
            .find(|r| r.owner_id == *owner_id && r.key == *key)
            .map(|r| &r.last_changed_source),
        FactKey::Relationship {
            from_id,
            to_id,
            kind,
        } => state
            .relationships
            .iter()
            .find(|r| r.from_id == *from_id && r.to_id == *to_id && r.kind == *kind)
            .map(|r| &r.last_changed_source),
        FactKey::Event { event_id } => state
            .events
            .iter()
            .find(|e| e.id == *event_id)
            .map(|e| &e.created_source),
        FactKey::Claim { claim_id } => state
            .claims
            .iter()
            .find(|c| c.id == *claim_id)
            .map(|c| &c.last_changed_source),
        FactKey::Time => Some(&state.time.last_changed_source),
        FactKey::Location => Some(&state.location_source),
    }
}

pub(crate) fn fact_value_v2(state: &WorldStateV2, fact: &FactKey) -> Option<serde_json::Value> {
    let entity = |id: &str| state.entities.iter().find(|e| e.id == id);
    Some(match fact {
        FactKey::EntityCreated { entity_id } => {
            let e = entity(entity_id)?;
            serde_json::json!({"id":e.id,"kind":e.kind})
        }
        FactKey::EntityName { entity_id } => serde_json::json!(entity(entity_id)?.name),
        FactKey::EntityLife { entity_id } => serde_json::json!(entity(entity_id)?.alive?),
        FactKey::EntityAttribute { entity_id, key } => {
            serde_json::json!(entity(entity_id)?.attributes.get(key)?)
        }
        FactKey::EntityAlias { entity_id, text } => {
            let alias = entity(entity_id)?
                .aliases
                .iter()
                .find(|a| a.text == *text)?;
            serde_json::json!({"text":alias.text,"kind":alias.kind})
        }
        FactKey::ItemHolding { item_id } => serde_json::json!(
            state
                .item_holdings
                .iter()
                .find(|h| h.item_id == *item_id)?
                .value
        ),
        FactKey::Condition { condition_id } => {
            let c = state.conditions.iter().find(|c| c.id == *condition_id)?;
            serde_json::json!({"id":c.id,"entityId":c.entity_id,"description":c.description,"category":c.category,"active":c.active})
        }
        FactKey::Resource { owner_id, key } => {
            let r = state
                .resources
                .iter()
                .find(|r| r.owner_id == *owner_id && r.key == *key)?;
            serde_json::json!({"ownerId":r.owner_id,"key":r.key,"unit":r.unit,"amount":r.amount})
        }
        FactKey::Relationship {
            from_id,
            to_id,
            kind,
        } => {
            let r = state
                .relationships
                .iter()
                .find(|r| r.from_id == *from_id && r.to_id == *to_id && r.kind == *kind)?;
            serde_json::json!({"fromId":r.from_id,"toId":r.to_id,"kind":r.kind,"strength":r.strength})
        }
        FactKey::Event { event_id } => {
            let e = state.events.iter().find(|e| e.id == *event_id)?;
            serde_json::json!({"id":e.id,"description":e.description,"entityIds":e.entity_ids,"disclosure":e.disclosure})
        }
        FactKey::Claim { claim_id } => {
            let c = state.claims.iter().find(|c| c.id == *claim_id)?;
            serde_json::json!({"id":c.id,"text":c.text,"entityIds":c.entity_ids,"assessment":c.assessment,"evidenceEventIds":c.evidence_event_ids})
        }
        FactKey::Time => {
            serde_json::json!({"eraYear":state.time.era_year,"precision":state.time.precision,"elapsedSeconds":state.time.elapsed_seconds})
        }
        FactKey::Location => serde_json::json!(state.location_id),
    })
}

fn fact_subjects<'a>(state: &'a WorldStateV2, fact: &'a FactKey) -> GameResult<Vec<&'a str>> {
    let entity = |id: &str| state.entities.iter().find(|e| e.id == id);
    let subjects = match fact {
        FactKey::EntityCreated { entity_id } | FactKey::EntityName { entity_id } => {
            entity(entity_id).ok_or(GameError::InvalidReference)?;
            vec![entity_id.as_str()]
        }
        FactKey::EntityLife { entity_id } => {
            if !entity(entity_id).is_some_and(|e| e.kind == EntityKind::Person) {
                return Err(GameError::InvalidReference);
            }
            vec![entity_id.as_str()]
        }
        FactKey::EntityAttribute { entity_id, key } => {
            if !entity(entity_id).is_some_and(|e| e.attributes.contains_key(key)) {
                return Err(GameError::InvalidReference);
            }
            vec![entity_id.as_str()]
        }
        FactKey::EntityAlias {
            entity_id,
            text: alias,
        } => {
            entity(entity_id).ok_or(GameError::InvalidReference)?;
            if !text(alias, 256, false) {
                return Err(GameError::InvalidReference);
            }
            // An acquired alias can disappear from the *current* alias list
            // when it becomes a formal name. Its old observation stays valid.
            vec![entity_id.as_str()]
        }
        FactKey::ItemHolding { item_id } => {
            if !state.item_holdings.iter().any(|h| h.item_id == *item_id) {
                return Err(GameError::InvalidReference);
            }
            vec![item_id.as_str()]
        }
        FactKey::Condition { condition_id } => vec![state
            .conditions
            .iter()
            .find(|c| c.id == *condition_id)
            .ok_or(GameError::InvalidReference)?
            .entity_id
            .as_str()],
        FactKey::Resource { owner_id, key } => {
            if !state
                .resources
                .iter()
                .any(|r| r.owner_id == *owner_id && r.key == *key)
            {
                return Err(GameError::InvalidReference);
            }
            vec![owner_id.as_str()]
        }
        FactKey::Relationship {
            from_id,
            to_id,
            kind,
        } => {
            if !state
                .relationships
                .iter()
                .any(|r| r.from_id == *from_id && r.to_id == *to_id && r.kind == *kind)
            {
                return Err(GameError::InvalidReference);
            }
            vec![from_id.as_str(), to_id.as_str()]
        }
        FactKey::Event { event_id } => state
            .events
            .iter()
            .find(|e| e.id == *event_id)
            .ok_or(GameError::InvalidReference)?
            .entity_ids
            .iter()
            .map(String::as_str)
            .collect(),
        FactKey::Claim { claim_id } => state
            .claims
            .iter()
            .find(|c| c.id == *claim_id)
            .ok_or(GameError::InvalidReference)?
            .entity_ids
            .iter()
            .map(String::as_str)
            .collect(),
        FactKey::Time => vec![state.protagonist_id.as_str()],
        // The fact's older source may concern the previous location, so its
        // snapshot-independent subject is the protagonist, not today's place.
        FactKey::Location => vec![state.protagonist_id.as_str()],
    };
    Ok(subjects)
}

/// Validates a snapshot's internal references. Source *lineage* is deliberately
/// checked by the full-history reader, not inferred from a single snapshot.
pub fn validate_state_v2(state: &WorldStateV2) -> GameResult {
    if state.protocol_version != GAME_PROTOCOL_VERSION_V2 {
        return Err(GameError::InvalidProtocol);
    }
    if state.time.era_year == 0
        || !(-999_999..=999_999).contains(&state.time.era_year)
        || state.time.elapsed_seconds > MAX_ELAPSED_SECONDS
    {
        return Err(GameError::InvalidTime);
    }
    if state.entities.len() > MAX_ENTITIES
        || state.resources.len() > MAX_STATE_ITEMS
        || state.relationships.len() > MAX_STATE_ITEMS
        || state.item_holdings.len() > MAX_STATE_ITEMS
        || state.conditions.len() > MAX_STATE_ITEMS
        || state.events.len() > MAX_EVENTS
        || state.claims.len() > MAX_CLAIMS
        || state.knowledge.len() > MAX_KNOWN_FACTS
        || state.fact_observations.len() > MAX_KNOWN_FACTS
    {
        return Err(GameError::TooLarge);
    }
    let mut entities = BTreeMap::new();
    for e in &state.entities {
        let mut aliases = BTreeSet::new();
        if !identifier(&e.id)
            || !text(&e.name, 256, false)
            || !life_valid(e.kind, e.alive)
            || e.attributes.len() > 64
            || e.aliases.len() > MAX_ALIASES
            || e.attributes.keys().ne(e.attribute_sources.keys())
            || !e.attributes.iter().all(|(k, v)| {
                attribute_key(
                    k,
                    e.kind,
                    matches!(
                        e.attribute_sources.get(k),
                        Some(StateSource::LegacySnapshot { .. })
                    ),
                ) && text(v, 2048, true)
            })
            || e.aliases.iter().any(|a| {
                !text(&a.text, 256, false) || a.text == e.name || !aliases.insert(a.text.as_str())
            })
            || entities.insert(e.id.as_str(), e).is_some()
        {
            return Err(GameError::InvalidEntity);
        }
    }
    if !matches!(entities.get(state.protagonist_id.as_str()),Some(e) if e.kind==EntityKind::Person)
        || !matches!(entities.get(state.location_id.as_str()),Some(e) if e.kind==EntityKind::Place)
    {
        return Err(GameError::InvalidEntity);
    }
    let mut events = BTreeMap::new();
    for e in &state.events {
        if !identifier(&e.id)
            || !text(&e.description, 2048, true)
            || !ids_valid(&e.entity_ids, &entities)
            || !source_shape(&e.created_source)
            || (e.disclosure == Disclosure::LegacyUnspecified
                && !matches!(e.created_source, StateSource::LegacySnapshot { .. }))
            || matches!(&e.created_source,StateSource::Turn{event_id,..} if event_id!=&e.id)
            || events.insert(e.id.as_str(), e).is_some()
        {
            return Err(GameError::InvalidEvent);
        }
    }
    if !source_valid(
        &state.time.last_changed_source,
        &events,
        &[&state.protagonist_id],
    ) {
        return Err(GameError::InvalidTime);
    }
    if !source_valid(
        &state.location_source,
        &events,
        &[&state.protagonist_id, &state.location_id],
    ) {
        return Err(GameError::InvalidReference);
    }
    for e in &state.entities {
        for source in [&e.created_source, &e.name_source, &e.life_source]
            .into_iter()
            .chain(e.attribute_sources.values())
            .chain(e.aliases.iter().map(|a| &a.source))
        {
            if !source_valid(source, &events, &[&e.id]) {
                return Err(GameError::InvalidReference);
            }
        }
    }
    let mut resources = BTreeSet::new();
    for r in &state.resources {
        if !entities.contains_key(r.owner_id.as_str())
            || !text(&r.key, 64, false)
            || !text(&r.unit, 64, false)
            || !(0..=MAX_RESOURCE_AMOUNT).contains(&r.amount)
            || !resources.insert((&r.owner_id, &r.key))
            || !source_valid(&r.last_changed_source, &events, &[&r.owner_id])
        {
            return Err(GameError::InvalidResource);
        }
    }
    let mut relationships = BTreeSet::new();
    for r in &state.relationships {
        if r.from_id == r.to_id
            || !entities.contains_key(r.from_id.as_str())
            || !entities.contains_key(r.to_id.as_str())
            || !text(&r.kind, 128, false)
            || !(-100..=100).contains(&r.strength)
            || !relationships.insert((&r.from_id, &r.to_id, &r.kind))
            || !source_valid(&r.last_changed_source, &events, &[&r.from_id, &r.to_id])
        {
            return Err(GameError::InvalidRelationship);
        }
    }
    let mut holdings = BTreeSet::new();
    for h in &state.item_holdings {
        let mut subjects = vec![h.item_id.as_str()];
        subjects.extend(h.value.holder_id.as_deref());
        subjects.extend(h.value.place_id.as_deref());
        if !matches!(entities.get(h.item_id.as_str()),Some(e) if e.kind==EntityKind::Item)
            || !holdings.insert(h.item_id.as_str())
            || !holding_valid(&h.value, &entities)
            || !source_valid(&h.source, &events, &subjects)
            || (h.value.status == HoldingStatus::LegacyUnknown
                && !matches!(h.source, StateSource::LegacySnapshot { .. }))
        {
            return Err(GameError::InvalidResource);
        }
    }
    if entities
        .values()
        .any(|e| e.kind == EntityKind::Item && !holdings.contains(e.id.as_str()))
    {
        return Err(GameError::InvalidResource);
    }
    let mut conditions = BTreeSet::new();
    for c in &state.conditions {
        if !identifier(&c.id)
            || !entities.contains_key(c.entity_id.as_str())
            || !text(&c.description, 2048, true)
            || !conditions.insert(c.id.as_str())
            || c.active == c.resolved_source.is_some()
            || (c.category == ConditionCategory::LegacyUnspecified
                && !matches!(c.started_source, StateSource::LegacySnapshot { .. }))
            || ![&c.started_source, &c.last_changed_source]
                .into_iter()
                .chain(c.resolved_source.iter())
                .all(|source| source_valid(source, &events, &[&c.entity_id]))
            || (!c.active && c.resolved_source.as_ref() != Some(&c.last_changed_source))
        {
            return Err(GameError::InvalidCondition);
        }
    }
    let mut claims = BTreeMap::new();
    for c in &state.claims {
        let subjects: Vec<_> = c.entity_ids.iter().map(String::as_str).collect();
        if !identifier(&c.id)
            || !text(&c.text, 2048, true)
            || !ids_valid(&c.entity_ids, &entities)
            || !event_ids_valid(&c.evidence_event_ids, &events)
            || (c.assessment != ClaimAssessment::Unverified && c.evidence_event_ids.is_empty())
            || !source_valid(&c.created_source, &events, &subjects)
            || !source_valid(&c.last_changed_source, &events, &subjects)
            || claims.insert(c.id.as_str(), c).is_some()
        {
            return Err(GameError::InvalidKnowledge);
        }
    }
    let mut knowledge = BTreeSet::new();
    for k in &state.knowledge {
        let target_text = match k.target_type {
            KnowledgeTarget::Event => events
                .get(k.target_id.as_str())
                .map(|e| e.description.as_str()),
            KnowledgeTarget::Claim => claims.get(k.target_id.as_str()).map(|c| c.text.as_str()),
        };
        let legacy = matches!(k.source, StateSource::LegacySnapshot { .. });
        if !matches!(entities.get(k.actor_id.as_str()),Some(e) if e.kind==EntityKind::Person)
            || target_text != Some(k.known_text.as_str())
            || !knowledge.insert((&k.actor_id, k.target_type, &k.target_id))
            || !event_ids_valid(&k.known_evidence_event_ids, &events)
            || (k.target_type == KnowledgeTarget::Event && !k.known_evidence_event_ids.is_empty())
            || !source_valid(&k.source, &events, &[&k.actor_id])
            || (!legacy
                && (k.certainty == Certainty::LegacyUnspecified
                    || k.acquisition_mode == AcquisitionMode::LegacyUnspecified
                    || !matches!((&k.acquisition_event_id,&k.source),(Some(id),StateSource::Turn{event_id,..}) if id==event_id)))
            || (legacy
                && k.acquisition_event_id
                    .as_ref()
                    .is_some_and(|id| !events.contains_key(id.as_str())))
        {
            return Err(GameError::InvalidKnowledge);
        }
    }
    let mut observations = BTreeSet::new();
    for observation in &state.fact_observations {
        let subjects = fact_subjects(state, &observation.fact_key)?;
        if !matches!(entities.get(observation.actor_id.as_str()), Some(e) if e.kind == EntityKind::Person)
            || !observations.insert((&observation.actor_id, &observation.fact_key))
            || !source_valid(&observation.fact_source, &events, &subjects)
            || !matches!(observation.acquisition_source, StateSource::Turn { .. })
            || !source_valid(
                &observation.acquisition_source,
                &events,
                &[&observation.actor_id],
            )
        {
            return Err(GameError::InvalidKnowledge);
        }
    }
    Ok(())
}

pub fn initial_state_v2(setup: &WorldSetup) -> GameResult<WorldStateV2> {
    crate::game_protocol::validate_setup(setup)?;
    let initial = StateSource::Initial;
    let entity = |id: &str, kind: EntityKind, name: String, alive: Option<bool>| EntityV2 {
        id: id.into(),
        kind,
        name,
        alive,
        attributes: BTreeMap::new(),
        aliases: Vec::new(),
        created_source: initial.clone(),
        name_source: initial.clone(),
        life_source: initial.clone(),
        attribute_sources: BTreeMap::new(),
    };
    let state = WorldStateV2 {
        protocol_version: GAME_PROTOCOL_VERSION_V2,
        time: GameTimeV2 {
            era_year: setup.era_year,
            precision: DatePrecision::Year,
            elapsed_seconds: 0,
            last_changed_source: initial.clone(),
        },
        location_id: "start-place".into(),
        location_source: initial.clone(),
        protagonist_id: "player".into(),
        entities: vec![
            entity(
                "player",
                EntityKind::Person,
                setup.protagonist_name.clone(),
                Some(true),
            ),
            entity(
                "start-place",
                EntityKind::Place,
                setup.location_name.clone(),
                None,
            ),
            entity("travel-bag", EntityKind::Item, "行囊".into(), None),
        ],
        resources: vec![ResourceV2 {
            owner_id: "player".into(),
            key: "cash".into(),
            unit: "记账单位".into(),
            amount: 100,
            last_changed_source: initial.clone(),
        }],
        relationships: Vec::new(),
        item_holdings: vec![ItemHolding {
            item_id: "travel-bag".into(),
            value: HoldingValue {
                status: HoldingStatus::Known,
                holder_id: Some("player".into()),
                place_id: None,
                quantity: Some(1),
                unit: Some("件".into()),
            },
            source: initial,
        }],
        conditions: Vec::new(),
        events: Vec::new(),
        claims: Vec::new(),
        knowledge: Vec::new(),
        fact_observations: Vec::new(),
    };
    validate_state_v2(&state)?;
    Ok(state)
}

fn validate_output_v2(output: &TurnOutputV2) -> GameResult {
    if output.protocol_version != GAME_PROTOCOL_VERSION_V2 {
        return Err(GameError::InvalidProtocol);
    }
    if output.narrative.len() > MAX_NARRATIVE_BYTES
        || output.choices.len() > MAX_CHOICES
        || output.state_changes.len() > 128
        || output.events.len() > 32
        || output.uncertainties.len() > 16
        || serde_json::to_vec(output)
            .map_err(|_| GameError::InvalidOutput)?
            .len()
            > MAX_TURN_OUTPUT_BYTES
    {
        return Err(GameError::TooLarge);
    }
    if !text(&output.narrative, MAX_NARRATIVE_BYTES, true) {
        return Err(GameError::InvalidOutput);
    }
    if output.time_advance.elapsed_seconds > MAX_ELAPSED_SECONDS
        || (output.time_advance.elapsed_seconds > 0 && output.time_advance.event_id.is_none())
        || output
            .time_advance
            .event_id
            .as_ref()
            .is_some_and(|id| !identifier(id))
    {
        return Err(GameError::InvalidTime);
    }
    let mut choices = BTreeSet::new();
    if output
        .choices
        .iter()
        .any(|c| !identifier(&c.id) || !text(&c.text, 2048, true) || !choices.insert(c.id.as_str()))
        || output.uncertainties.iter().any(|u| !text(u, 2048, true))
    {
        return Err(GameError::InvalidOutput);
    }
    if !output.source_references.is_empty() {
        return Err(GameError::InvalidReference);
    }
    let mut events = BTreeSet::new();
    if output.events.iter().any(|e| {
        !identifier(&e.id)
            || !text(&e.description, 2048, true)
            || e.entity_ids.len() > 64
            || e.disclosure == Disclosure::LegacyUnspecified
            || !events.insert(e.id.as_str())
    }) {
        return Err(GameError::InvalidEvent);
    }
    Ok(())
}

/// Decode one whole JSON object or one whole json fence, never a fragment.
pub fn parse_output_v2(raw: &str) -> GameResult<TurnOutputV2> {
    if raw.len() > MAX_TURN_OUTPUT_BYTES {
        return Err(GameError::TooLarge);
    }
    let whole = raw.trim();
    let json = if let Some(body) = whole.strip_prefix("```json") {
        body.strip_prefix("\r\n")
            .or_else(|| body.strip_prefix('\n'))
            .ok_or(GameError::InvalidOutput)?
            .strip_suffix("```")
            .ok_or(GameError::InvalidOutput)?
            .trim()
    } else {
        whole
    };
    let output: TurnOutputV2 = serde_json::from_str(json).map_err(|_| GameError::InvalidOutput)?;
    validate_output_v2(&output)?;
    Ok(output)
}

fn turn_source(
    state: &WorldStateV2,
    new_events: &BTreeSet<&str>,
    context: &CommitContext,
    event_id: &str,
    subjects: &[&str],
) -> GameResult<StateSource> {
    if !new_events.contains(event_id) {
        return Err(GameError::InvalidReference);
    }
    let event = state
        .events
        .iter()
        .find(|event| event.id == event_id)
        .ok_or(GameError::InvalidReference)?;
    if !subjects
        .iter()
        .all(|id| event.entity_ids.iter().any(|reference| reference == id))
    {
        return Err(GameError::InvalidReference);
    }
    Ok(StateSource::Turn {
        operation_id: context.operation_id.clone(),
        turn_id: context.turn_id.clone(),
        event_id: event_id.into(),
    })
}

fn known_target(
    state: &WorldStateV2,
    target_type: KnowledgeTarget,
    target_id: &str,
    evidence: &[String],
) -> GameResult<String> {
    let mut seen = BTreeSet::new();
    if evidence.len() > 64
        || evidence
            .iter()
            .any(|id| !seen.insert(id) || !state.events.iter().any(|e| e.id == *id))
    {
        return Err(GameError::InvalidKnowledge);
    }
    match target_type {
        KnowledgeTarget::Event => {
            if !evidence.is_empty() {
                return Err(GameError::InvalidKnowledge);
            }
            state
                .events
                .iter()
                .find(|e| e.id == target_id)
                .map(|e| e.description.clone())
                .ok_or(GameError::InvalidReference)
        }
        KnowledgeTarget::Claim => {
            let claim = state
                .claims
                .iter()
                .find(|c| c.id == target_id)
                .ok_or(GameError::InvalidReference)?;
            if evidence
                .iter()
                .any(|id| !claim.evidence_event_ids.contains(id))
            {
                return Err(GameError::InvalidKnowledge);
            }
            Ok(claim.text.clone())
        }
    }
}

fn new_knowledge(
    state: &WorldStateV2,
    actor_id: &str,
    target: (KnowledgeTarget, &str),
    certainty: Certainty,
    acquisition_mode: AcquisitionMode,
    evidence: &[String],
    source: StateSource,
) -> GameResult<Knowledge> {
    let (target_type, target_id) = target;
    if !state
        .entities
        .iter()
        .any(|e| e.id == actor_id && e.kind == EntityKind::Person)
        || certainty == Certainty::LegacyUnspecified
        || acquisition_mode == AcquisitionMode::LegacyUnspecified
    {
        return Err(GameError::InvalidKnowledge);
    }
    let StateSource::Turn { event_id, .. } = &source else {
        return Err(GameError::InvalidKnowledge);
    };
    Ok(Knowledge {
        actor_id: actor_id.into(),
        target_type,
        target_id: target_id.into(),
        certainty,
        acquisition_mode,
        acquisition_event_id: Some(event_id.clone()),
        known_text: known_target(state, target_type, target_id, evidence)?,
        known_evidence_event_ids: evidence.to_vec(),
        source,
    })
}

/// Apply only to a private clone. A failure at the last operation does not
/// settle earlier money, transfer items, advance time or leave provenance.
pub fn apply_output_v2(
    state: &WorldStateV2,
    output: &TurnOutputV2,
    context: &CommitContext,
) -> GameResult<WorldStateV2> {
    validate_state_v2(state)?;
    validate_output_v2(output)?;
    if !commit_identifier(&context.operation_id) || !commit_identifier(&context.turn_id) {
        return Err(GameError::InvalidReference);
    }
    // Reusing a commit identity in a snapshot is a conflict. The store handles
    // idempotent operation replies rather than generating a second commit.
    if state.events.iter().any(|e| matches!(&e.created_source,StateSource::Turn{operation_id,turn_id,..} if operation_id==&context.operation_id || turn_id==&context.turn_id)) {return Err(GameError::Conflict);}
    let mut next = state.clone();
    let mut observed_values = BTreeMap::new();
    let new_events: BTreeSet<_> = output.events.iter().map(|e| e.id.as_str()).collect();
    for event in &output.events {
        if next.events.iter().any(|e| e.id == event.id) {
            return Err(GameError::Conflict);
        }
        next.events.push(GameEventV2 {
            id: event.id.clone(),
            description: event.description.clone(),
            entity_ids: event.entity_ids.clone(),
            disclosure: event.disclosure,
            created_source: StateSource::Turn {
                operation_id: context.operation_id.clone(),
                turn_id: context.turn_id.clone(),
                event_id: event.id.clone(),
            },
        });
    }
    if let Some(event_id) = &output.time_advance.event_id {
        let source = turn_source(
            &next,
            &new_events,
            context,
            event_id,
            &[&next.protagonist_id],
        )?;
        if output.time_advance.elapsed_seconds > 0 {
            next.time.last_changed_source = source;
        }
    }
    next.time.elapsed_seconds = next
        .time
        .elapsed_seconds
        .checked_add(output.time_advance.elapsed_seconds)
        .filter(|elapsed| *elapsed <= MAX_ELAPSED_SECONDS)
        .ok_or(GameError::InvalidTime)?;
    for change in &output.state_changes {
        match change {
            StateChangeV2::CreateEntity { entity, event_id } => {
                if !entity_input_valid(entity) {
                    return Err(GameError::InvalidEntity);
                }
                if next.entities.iter().any(|e| e.id == entity.id) {
                    return Err(GameError::Conflict);
                }
                let source = turn_source(&next, &new_events, context, event_id, &[&entity.id])?;
                next.entities.push(EntityV2 {
                    id: entity.id.clone(),
                    kind: entity.kind,
                    name: entity.name.clone(),
                    alive: entity.alive,
                    attributes: entity.attributes.clone(),
                    aliases: Vec::new(),
                    created_source: source.clone(),
                    name_source: source.clone(),
                    life_source: source.clone(),
                    attribute_sources: entity
                        .attributes
                        .keys()
                        .map(|key| (key.clone(), source.clone()))
                        .collect(),
                });
            }
            StateChangeV2::RenameEntity {
                entity_id,
                expected_name,
                new_name,
                event_id,
            } => {
                if !text(expected_name, 256, false)
                    || !text(new_name, 256, false)
                    || expected_name == new_name
                {
                    return Err(GameError::InvalidEntity);
                }
                let source = turn_source(&next, &new_events, context, event_id, &[entity_id])?;
                let entity = next
                    .entities
                    .iter_mut()
                    .find(|e| e.id == *entity_id)
                    .ok_or(GameError::InvalidReference)?;
                if entity.name != *expected_name {
                    return Err(GameError::Conflict);
                }
                entity.aliases.retain(|a| a.text != *new_name);
                entity.aliases.push(EntityAlias {
                    text: entity.name.clone(),
                    kind: AliasKind::FormerName,
                    source: source.clone(),
                });
                entity.name = new_name.clone();
                entity.name_source = source;
            }
            StateChangeV2::AddAlias {
                entity_id,
                text: alias,
                kind,
                event_id,
            } => {
                if !text(alias, 256, false) {
                    return Err(GameError::InvalidEntity);
                }
                let source = turn_source(&next, &new_events, context, event_id, &[entity_id])?;
                let entity = next
                    .entities
                    .iter_mut()
                    .find(|e| e.id == *entity_id)
                    .ok_or(GameError::InvalidReference)?;
                if entity.name == *alias || entity.aliases.iter().any(|a| a.text == *alias) {
                    return Err(GameError::Conflict);
                }
                entity.aliases.push(EntityAlias {
                    text: alias.clone(),
                    kind: *kind,
                    source,
                });
            }
            StateChangeV2::SetAttribute {
                entity_id,
                key,
                value,
                expected_value,
                event_id,
            } => {
                let source = turn_source(&next, &new_events, context, event_id, &[entity_id])?;
                let entity = next
                    .entities
                    .iter_mut()
                    .find(|e| e.id == *entity_id)
                    .ok_or(GameError::InvalidReference)?;
                if !attribute_key(key, entity.kind, false)
                    || !text(value, 2048, true)
                    || expected_value
                        .as_ref()
                        .is_some_and(|v| !text(v, 2048, true))
                {
                    return Err(GameError::InvalidEntity);
                }
                if entity.attributes.get(key) != expected_value.as_ref() {
                    return Err(GameError::Conflict);
                }
                entity.attributes.insert(key.clone(), value.clone());
                entity.attribute_sources.insert(key.clone(), source);
            }
            StateChangeV2::SetLifeStatus {
                entity_id,
                alive,
                event_id,
            } => {
                let source = turn_source(&next, &new_events, context, event_id, &[entity_id])?;
                let entity = next
                    .entities
                    .iter_mut()
                    .find(|e| e.id == *entity_id)
                    .ok_or(GameError::InvalidReference)?;
                if entity.kind != EntityKind::Person {
                    return Err(GameError::InvalidEntity);
                }
                if entity.alive == Some(false) && *alive {
                    return Err(GameError::DeadCannotRevive);
                }
                entity.alive = Some(*alive);
                entity.life_source = source;
            }
            StateChangeV2::Move {
                location_id,
                event_id,
            } => {
                let source = turn_source(
                    &next,
                    &new_events,
                    context,
                    event_id,
                    &[&next.protagonist_id, location_id],
                )?;
                if !next
                    .entities
                    .iter()
                    .any(|e| e.id == *location_id && e.kind == EntityKind::Place)
                {
                    return Err(GameError::InvalidReference);
                }
                next.location_id = location_id.clone();
                next.location_source = source;
            }
            StateChangeV2::ChangeResource {
                owner_id,
                key,
                unit,
                delta,
                expected_amount,
                event_id,
            } => {
                let source = turn_source(&next, &new_events, context, event_id, &[owner_id])?;
                if !next.entities.iter().any(|e| e.id == *owner_id) {
                    return Err(GameError::InvalidReference);
                }
                if !text(key, 64, false)
                    || !text(unit, 64, false)
                    || !(-MAX_RESOURCE_AMOUNT..=MAX_RESOURCE_AMOUNT).contains(delta)
                    || expected_amount
                        .is_some_and(|amount| !(0..=MAX_RESOURCE_AMOUNT).contains(&amount))
                {
                    return Err(GameError::InvalidResource);
                }
                if let Some(resource) = next
                    .resources
                    .iter_mut()
                    .find(|r| r.owner_id == *owner_id && r.key == *key)
                {
                    if resource.unit != *unit {
                        return Err(GameError::InvalidResource);
                    }
                    if *expected_amount != Some(resource.amount) {
                        return Err(GameError::Conflict);
                    }
                    resource.amount = resource
                        .amount
                        .checked_add(*delta)
                        .filter(|amount| (0..=MAX_RESOURCE_AMOUNT).contains(amount))
                        .ok_or(GameError::InvalidResource)?;
                    resource.last_changed_source = source;
                } else {
                    if expected_amount.is_some() {
                        return Err(GameError::Conflict);
                    }
                    if *delta < 0 {
                        return Err(GameError::InvalidResource);
                    }
                    next.resources.push(ResourceV2 {
                        owner_id: owner_id.clone(),
                        key: key.clone(),
                        unit: unit.clone(),
                        amount: *delta,
                        last_changed_source: source,
                    });
                }
            }
            StateChangeV2::ChangeRelationship {
                from_id,
                to_id,
                kind,
                strength,
                event_id,
            } => {
                let source = turn_source(&next, &new_events, context, event_id, &[from_id, to_id])?;
                if let Some(r) = next
                    .relationships
                    .iter_mut()
                    .find(|r| r.from_id == *from_id && r.to_id == *to_id && r.kind == *kind)
                {
                    r.strength = *strength;
                    r.last_changed_source = source;
                } else {
                    next.relationships.push(RelationshipV2 {
                        from_id: from_id.clone(),
                        to_id: to_id.clone(),
                        kind: kind.clone(),
                        strength: *strength,
                        last_changed_source: source,
                    });
                }
            }
            StateChangeV2::SetItemHolding {
                item_id,
                expected_holding,
                holder_id,
                place_id,
                quantity,
                unit,
                event_id,
            } => {
                if !next
                    .entities
                    .iter()
                    .any(|e| e.id == *item_id && e.kind == EntityKind::Item)
                {
                    return Err(GameError::InvalidReference);
                }
                let index = next
                    .item_holdings
                    .iter()
                    .position(|h| h.item_id == *item_id);
                let existing = index.map(|i| &next.item_holdings[i].value);
                if existing != expected_holding.as_ref() {
                    return Err(GameError::Conflict);
                }
                if let Some(old) = existing {
                    if old.status == HoldingStatus::Known
                        && (old.quantity != Some(*quantity) || old.unit.as_ref() != Some(unit))
                    {
                        return Err(GameError::InvalidResource);
                    }
                }
                let mut subjects = vec![item_id.as_str()];
                subjects.extend(holder_id.as_deref());
                subjects.extend(place_id.as_deref());
                if let Some(old) = existing {
                    subjects.extend(old.holder_id.as_deref());
                    subjects.extend(old.place_id.as_deref());
                }
                let source = turn_source(&next, &new_events, context, event_id, &subjects)?;
                let holding = ItemHolding {
                    item_id: item_id.clone(),
                    value: HoldingValue {
                        status: HoldingStatus::Known,
                        holder_id: holder_id.clone(),
                        place_id: place_id.clone(),
                        quantity: Some(*quantity),
                        unit: Some(unit.clone()),
                    },
                    source,
                };
                if let Some(i) = index {
                    next.item_holdings[i] = holding;
                } else {
                    next.item_holdings.push(holding);
                }
            }
            StateChangeV2::ChangeItemQuantity {
                item_id,
                expected_holding,
                delta,
                event_id,
            } => {
                if !(-MAX_RESOURCE_AMOUNT..=MAX_RESOURCE_AMOUNT).contains(delta) {
                    return Err(GameError::InvalidResource);
                }
                let index = next
                    .item_holdings
                    .iter()
                    .position(|h| h.item_id == *item_id)
                    .ok_or(GameError::InvalidReference)?;
                let old = &next.item_holdings[index].value;
                if old != expected_holding {
                    return Err(GameError::Conflict);
                }
                if old.status != HoldingStatus::Known || old.quantity == Some(0) {
                    return Err(GameError::InvalidResource);
                }
                let mut subjects = vec![item_id.as_str()];
                subjects.extend(old.holder_id.as_deref());
                subjects.extend(old.place_id.as_deref());
                let source = turn_source(&next, &new_events, context, event_id, &subjects)?;
                let quantity = old
                    .quantity
                    .ok_or(GameError::InvalidResource)?
                    .checked_add(*delta)
                    .filter(|q| (0..=MAX_RESOURCE_AMOUNT).contains(q))
                    .ok_or(GameError::InvalidResource)?;
                let holding = &mut next.item_holdings[index];
                holding.value.quantity = Some(quantity);
                holding.source = source;
                if quantity == 0 {
                    holding.value.holder_id = None;
                    holding.value.place_id = None;
                }
            }
            StateChangeV2::AddCondition {
                condition,
                event_id,
            } => {
                if !condition.active || condition.category == ConditionCategory::LegacyUnspecified {
                    return Err(GameError::InvalidCondition);
                }
                if next.conditions.iter().any(|c| c.id == condition.id) {
                    return Err(GameError::Conflict);
                }
                let source = turn_source(
                    &next,
                    &new_events,
                    context,
                    event_id,
                    &[&condition.entity_id],
                )?;
                next.conditions.push(ConditionV2 {
                    id: condition.id.clone(),
                    entity_id: condition.entity_id.clone(),
                    description: condition.description.clone(),
                    category: condition.category,
                    active: true,
                    started_source: source.clone(),
                    last_changed_source: source,
                    resolved_source: None,
                });
            }
            StateChangeV2::UpdateCondition {
                condition_id,
                expected_description,
                new_description,
                event_id,
            } => {
                let condition = next
                    .conditions
                    .iter()
                    .find(|c| c.id == *condition_id)
                    .ok_or(GameError::InvalidReference)?;
                let source = turn_source(
                    &next,
                    &new_events,
                    context,
                    event_id,
                    &[&condition.entity_id],
                )?;
                if !condition.active || !text(new_description, 2048, true) {
                    return Err(GameError::InvalidCondition);
                }
                if condition.description != *expected_description {
                    return Err(GameError::Conflict);
                }
                let condition = next
                    .conditions
                    .iter_mut()
                    .find(|c| c.id == *condition_id)
                    .ok_or(GameError::InvalidReference)?;
                condition.description = new_description.clone();
                condition.last_changed_source = source;
            }
            StateChangeV2::ResolveCondition {
                condition_id,
                event_id,
            } => {
                let condition = next
                    .conditions
                    .iter()
                    .find(|c| c.id == *condition_id)
                    .ok_or(GameError::InvalidReference)?;
                let source = turn_source(
                    &next,
                    &new_events,
                    context,
                    event_id,
                    &[&condition.entity_id],
                )?;
                if !condition.active {
                    return Err(GameError::InvalidCondition);
                }
                let condition = next
                    .conditions
                    .iter_mut()
                    .find(|c| c.id == *condition_id)
                    .ok_or(GameError::InvalidReference)?;
                condition.active = false;
                condition.last_changed_source = source.clone();
                condition.resolved_source = Some(source);
            }
            StateChangeV2::CreateClaim { claim, event_id } => {
                if next.claims.iter().any(|c| c.id == claim.id) {
                    return Err(GameError::Conflict);
                }
                let subjects: Vec<_> = claim.entity_ids.iter().map(String::as_str).collect();
                let source = turn_source(&next, &new_events, context, event_id, &subjects)?;
                next.claims.push(Claim {
                    id: claim.id.clone(),
                    text: claim.text.clone(),
                    entity_ids: claim.entity_ids.clone(),
                    assessment: claim.assessment,
                    evidence_event_ids: claim.evidence_event_ids.clone(),
                    created_source: source.clone(),
                    last_changed_source: source,
                });
            }
            StateChangeV2::AssessClaim {
                claim_id,
                expected_assessment,
                assessment,
                evidence_event_ids,
                event_id,
            } => {
                let index = next
                    .claims
                    .iter()
                    .position(|c| c.id == *claim_id)
                    .ok_or(GameError::InvalidReference)?;
                let claim = &next.claims[index];
                let subjects: Vec<_> = claim.entity_ids.iter().map(String::as_str).collect();
                let source = turn_source(&next, &new_events, context, event_id, &subjects)?;
                if claim.assessment != *expected_assessment {
                    return Err(GameError::Conflict);
                }
                let mut seen = BTreeSet::new();
                if evidence_event_ids.is_empty()
                    || evidence_event_ids
                        .iter()
                        .any(|id| !seen.insert(id) || !next.events.iter().any(|e| e.id == *id))
                    || claim
                        .evidence_event_ids
                        .iter()
                        .any(|id| !evidence_event_ids.contains(id))
                    || !evidence_event_ids
                        .iter()
                        .any(|id| !claim.evidence_event_ids.contains(id))
                {
                    return Err(GameError::InvalidKnowledge);
                }
                let claim = &mut next.claims[index];
                claim.assessment = *assessment;
                claim.evidence_event_ids = evidence_event_ids.clone();
                claim.last_changed_source = source;
            }
            StateChangeV2::RecordKnowledge {
                actor_id,
                target_type,
                target_id,
                certainty,
                acquisition_mode,
                known_evidence_event_ids,
                event_id,
            } => {
                if next.knowledge.iter().any(|k| {
                    k.actor_id == *actor_id
                        && k.target_type == *target_type
                        && k.target_id == *target_id
                }) {
                    return Err(GameError::Conflict);
                }
                let source = turn_source(&next, &new_events, context, event_id, &[actor_id])?;
                next.knowledge.push(new_knowledge(
                    &next,
                    actor_id,
                    (*target_type, target_id),
                    *certainty,
                    *acquisition_mode,
                    known_evidence_event_ids,
                    source,
                )?);
            }
            StateChangeV2::UpdateKnowledge {
                actor_id,
                target_type,
                target_id,
                expected_certainty,
                certainty,
                acquisition_mode,
                known_evidence_event_ids,
                event_id,
            } => {
                let index = next
                    .knowledge
                    .iter()
                    .position(|k| {
                        k.actor_id == *actor_id
                            && k.target_type == *target_type
                            && k.target_id == *target_id
                    })
                    .ok_or(GameError::InvalidReference)?;
                if next.knowledge[index].certainty != *expected_certainty {
                    return Err(GameError::Conflict);
                }
                let source = turn_source(&next, &new_events, context, event_id, &[actor_id])?;
                next.knowledge[index] = new_knowledge(
                    &next,
                    actor_id,
                    (*target_type, target_id),
                    *certainty,
                    *acquisition_mode,
                    known_evidence_event_ids,
                    source,
                )?;
            }
            StateChangeV2::ObserveFact {
                actor_id,
                fact_key,
                event_id,
            } => {
                if !next
                    .entities
                    .iter()
                    .any(|e| e.id == *actor_id && e.kind == EntityKind::Person)
                {
                    return Err(GameError::InvalidKnowledge);
                }
                let fact_source = fact_source_v2(&next, fact_key)
                    .ok_or(GameError::InvalidReference)?
                    .clone();
                let value = fact_value_v2(&next, fact_key).ok_or(GameError::InvalidReference)?;
                let mut subjects = fact_subjects(&next, fact_key)?;
                subjects.push(actor_id.as_str());
                let acquisition_source =
                    turn_source(&next, &new_events, context, event_id, &subjects)?;
                let observation = FactObservation {
                    actor_id: actor_id.clone(),
                    fact_key: fact_key.clone(),
                    fact_source,
                    acquisition_source,
                };
                observed_values.insert(
                    (actor_id.clone(), fact_key.clone()),
                    (observation.fact_source.clone(), value),
                );
                if let Some(existing) = next
                    .fact_observations
                    .iter_mut()
                    .find(|o| o.actor_id == *actor_id && o.fact_key == *fact_key)
                {
                    *existing = observation;
                } else {
                    next.fact_observations.push(observation);
                }
            }
        }
    }
    // A turn has one immutable final snapshot. Reject observing an intermediate
    // value then changing that same fact later in this output: its provenance
    // could otherwise match the final value and reveal something never learned.
    for ((_, fact), (source, value)) in observed_values {
        if fact_value_v2(&next, &fact).as_ref() != Some(&value)
            || fact_source_v2(&next, &fact) != Some(&source)
        {
            return Err(GameError::Conflict);
        }
    }
    validate_state_v2(&next)?;
    Ok(next)
}
