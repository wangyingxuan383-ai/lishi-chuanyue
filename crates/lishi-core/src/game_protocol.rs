//! Versioned, platform-independent world facts and model output validation.
//!
//! Text from a model is untrusted. Only the closed operations below can change
//! facts, and the complete result is checked before it can be persisted.

use std::collections::{BTreeMap, BTreeSet};
use std::fmt;

use serde::{Deserialize, Deserializer, Serialize};

pub const GAME_PROTOCOL_VERSION: u32 = 1;
pub const MAX_TURN_OUTPUT_BYTES: usize = 256 * 1024;
pub const MAX_NARRATIVE_BYTES: usize = 64 * 1024;
pub const MAX_CHOICES: usize = 6;
pub const MAX_ENTITIES: usize = 512;
pub const MAX_STATE_ITEMS: usize = 512;
pub const MAX_EVENTS: usize = 4096;
pub const MAX_KNOWN_FACTS: usize = 4096;
pub const MAX_ELAPSED_SECONDS: u64 = 9_007_199_254_740_991;
pub const MAX_RESOURCE_AMOUNT: i64 = 9_007_199_254_740_991;

pub type GameResult<T = ()> = Result<T, GameError>;

/// Closed error codes never include model text, database details, or secrets.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GameError {
    InvalidSetup,
    InvalidProtocol,
    InvalidOutput,
    InvalidEntity,
    InvalidResource,
    InvalidTime,
    DeadCannotRevive,
    InvalidRelationship,
    InvalidCondition,
    InvalidKnowledge,
    InvalidEvent,
    InvalidReference,
    Conflict,
    TooLarge,
}

impl GameError {
    pub const fn code(self) -> &'static str {
        match self {
            Self::InvalidSetup => "game_invalid_setup",
            Self::InvalidProtocol => "game_invalid_protocol",
            Self::InvalidOutput => "game_invalid_output",
            Self::InvalidEntity => "game_invalid_entity",
            Self::InvalidResource => "game_invalid_resource",
            Self::InvalidTime => "game_invalid_time",
            Self::DeadCannotRevive => "game_dead_cannot_revive",
            Self::InvalidRelationship => "game_invalid_relationship",
            Self::InvalidCondition => "game_invalid_condition",
            Self::InvalidKnowledge => "game_invalid_knowledge",
            Self::InvalidEvent => "game_invalid_event",
            Self::InvalidReference => "game_invalid_reference",
            Self::Conflict => "game_conflict",
            Self::TooLarge => "game_too_large",
        }
    }
}

impl fmt::Display for GameError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.code())
    }
}

impl std::error::Error for GameError {}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldSetup {
    pub world_id: String,
    pub title: String,
    pub country: String,
    pub era_year: i32,
    pub location_name: String,
    pub protagonist_name: String,
    pub narrative_style: String,
}

/// `era_year` is the historical starting year. Calendar conversion is deferred;
/// elapsed time advances monotonically without claiming a new calendar date.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameTime {
    pub era_year: i32,
    pub precision: DatePrecision,
    pub elapsed_seconds: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum DatePrecision {
    Year,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Person,
    Place,
    Organization,
    Item,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Entity {
    pub id: String,
    pub kind: EntityKind,
    pub name: String,
    #[serde(deserialize_with = "required_nullable")]
    pub alive: Option<bool>,
    pub attributes: BTreeMap<String, String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Resource {
    pub owner_id: String,
    pub key: String,
    pub unit: String,
    pub amount: i64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Relationship {
    pub from_id: String,
    pub to_id: String,
    pub kind: String,
    pub strength: i32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Condition {
    pub id: String,
    pub entity_id: String,
    pub description: String,
    pub active: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct KnownFact {
    pub actor_id: String,
    pub fact_id: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GameEvent {
    pub id: String,
    pub description: String,
    pub entity_ids: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorldState {
    pub protocol_version: u32,
    pub time: GameTime,
    pub location_id: String,
    pub protagonist_id: String,
    pub entities: Vec<Entity>,
    pub resources: Vec<Resource>,
    pub relationships: Vec<Relationship>,
    pub conditions: Vec<Condition>,
    pub known_facts: Vec<KnownFact>,
    pub events: Vec<GameEvent>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Choice {
    pub id: String,
    pub text: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TimeAdvance {
    pub elapsed_seconds: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum StateChange {
    CreateEntity {
        entity: Entity,
    },
    SetAttribute {
        entity_id: String,
        key: String,
        value: String,
        #[serde(deserialize_with = "required_nullable")]
        expected_value: Option<String>,
    },
    SetLifeStatus {
        entity_id: String,
        alive: bool,
    },
    Move {
        location_id: String,
    },
    ChangeResource {
        owner_id: String,
        key: String,
        unit: String,
        delta: i64,
        #[serde(deserialize_with = "required_nullable")]
        expected_amount: Option<i64>,
    },
    ChangeRelationship {
        from_id: String,
        to_id: String,
        kind: String,
        strength: i32,
    },
    AddCondition {
        condition: Condition,
    },
    ResolveCondition {
        condition_id: String,
    },
    RecordKnowledge {
        actor_id: String,
        fact_id: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnOutput {
    pub protocol_version: u32,
    pub narrative: String,
    pub choices: Vec<Choice>,
    pub time_advance: TimeAdvance,
    pub state_changes: Vec<StateChange>,
    pub events: Vec<GameEvent>,
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
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn setup_identifier(value: &str) -> bool {
    (8..=128).contains(&value.len())
        && value
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

fn text(value: &str, limit: usize, multiline: bool) -> bool {
    !value.trim().is_empty()
        && value.len() <= limit
        && !value.chars().any(|character| {
            character.is_control() && !(multiline && matches!(character, '\n' | '\r' | '\t'))
        })
}

fn historical_year(year: i32) -> bool {
    year != 0 && (-999_999..=999_999).contains(&year)
}

fn attribute_key(key: &str) -> bool {
    text(key, 64, false)
        && key == key.trim()
        && !matches!(
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
}

fn entity_valid(entity: &Entity) -> bool {
    identifier(&entity.id)
        && text(&entity.name, 256, false)
        && matches!(
            (entity.kind, entity.alive),
            (EntityKind::Person, Some(_))
                | (
                    EntityKind::Place | EntityKind::Organization | EntityKind::Item,
                    None
                )
        )
        && entity.attributes.len() <= 64
        && entity
            .attributes
            .iter()
            .all(|(key, value)| attribute_key(key) && text(value, 2048, true))
}

pub fn validate_setup(setup: &WorldSetup) -> GameResult {
    if !setup_identifier(&setup.world_id)
        || !text(&setup.title, 256, false)
        || !text(&setup.country, 128, false)
        || !historical_year(setup.era_year)
        || !text(&setup.location_name, 256, false)
        || !text(&setup.protagonist_name, 128, false)
        || !text(&setup.narrative_style, 2048, true)
    {
        return Err(GameError::InvalidSetup);
    }
    Ok(())
}

/// Deterministic starting facts. A trusted, fixed opening can accompany this
/// initial snapshot; later model narratives require a validated formal turn.
pub fn initial_state(setup: &WorldSetup) -> GameResult<WorldState> {
    validate_setup(setup)?;
    let state = WorldState {
        protocol_version: GAME_PROTOCOL_VERSION,
        time: GameTime {
            era_year: setup.era_year,
            precision: DatePrecision::Year,
            elapsed_seconds: 0,
        },
        location_id: "start-place".into(),
        protagonist_id: "player".into(),
        entities: vec![
            Entity {
                id: "player".into(),
                kind: EntityKind::Person,
                name: setup.protagonist_name.clone(),
                alive: Some(true),
                attributes: BTreeMap::new(),
            },
            Entity {
                id: "start-place".into(),
                kind: EntityKind::Place,
                name: setup.location_name.clone(),
                alive: None,
                attributes: BTreeMap::new(),
            },
            Entity {
                id: "travel-bag".into(),
                kind: EntityKind::Item,
                name: "行囊".into(),
                alive: None,
                attributes: BTreeMap::from([("ownerId".into(), "player".into())]),
            },
        ],
        resources: vec![Resource {
            owner_id: "player".into(),
            key: "cash".into(),
            unit: "记账单位".into(),
            amount: 100,
        }],
        relationships: Vec::new(),
        conditions: Vec::new(),
        known_facts: Vec::new(),
        events: Vec::new(),
    };
    validate_state(&state)?;
    Ok(state)
}

pub fn validate_state(state: &WorldState) -> GameResult {
    if state.protocol_version != GAME_PROTOCOL_VERSION {
        return Err(GameError::InvalidProtocol);
    }
    if !historical_year(state.time.era_year) || state.time.elapsed_seconds > MAX_ELAPSED_SECONDS {
        return Err(GameError::InvalidTime);
    }
    if state.entities.len() > MAX_ENTITIES
        || state.resources.len() > MAX_STATE_ITEMS
        || state.relationships.len() > MAX_STATE_ITEMS
        || state.conditions.len() > MAX_STATE_ITEMS
        || state.known_facts.len() > MAX_KNOWN_FACTS
        || state.events.len() > MAX_EVENTS
    {
        return Err(GameError::TooLarge);
    }
    let mut entities = BTreeMap::new();
    for entity in &state.entities {
        if !entity_valid(entity) || entities.insert(entity.id.as_str(), entity).is_some() {
            return Err(GameError::InvalidEntity);
        }
    }
    if !matches!(entities.get(state.location_id.as_str()), Some(entity) if entity.kind == EntityKind::Place)
        || !matches!(entities.get(state.protagonist_id.as_str()), Some(entity) if entity.kind == EntityKind::Person)
    {
        return Err(GameError::InvalidEntity);
    }
    let mut resources = BTreeSet::new();
    for resource in &state.resources {
        if !entities.contains_key(resource.owner_id.as_str())
            || !text(&resource.key, 64, false)
            || !text(&resource.unit, 64, false)
            || resource.amount < 0
            || resource.amount > MAX_RESOURCE_AMOUNT
            || !resources.insert((resource.owner_id.as_str(), resource.key.as_str()))
        {
            return Err(GameError::InvalidResource);
        }
    }
    let mut relationships = BTreeSet::new();
    for relationship in &state.relationships {
        if relationship.from_id == relationship.to_id
            || !entities.contains_key(relationship.from_id.as_str())
            || !entities.contains_key(relationship.to_id.as_str())
            || !text(&relationship.kind, 128, false)
            || !(-100..=100).contains(&relationship.strength)
            || !relationships.insert((
                relationship.from_id.as_str(),
                relationship.to_id.as_str(),
                relationship.kind.as_str(),
            ))
        {
            return Err(GameError::InvalidRelationship);
        }
    }
    let mut conditions = BTreeSet::new();
    for condition in &state.conditions {
        if !identifier(&condition.id)
            || !entities.contains_key(condition.entity_id.as_str())
            || !text(&condition.description, 2048, true)
            || !conditions.insert(condition.id.as_str())
        {
            return Err(GameError::InvalidCondition);
        }
    }
    let mut events = BTreeSet::new();
    for event in &state.events {
        let mut references = BTreeSet::new();
        if !identifier(&event.id)
            || !text(&event.description, 2048, true)
            || event.entity_ids.len() > 64
            || !events.insert(event.id.as_str())
            || event
                .entity_ids
                .iter()
                .any(|id| !entities.contains_key(id.as_str()) || !references.insert(id.as_str()))
        {
            return Err(GameError::InvalidEvent);
        }
    }
    let mut known_facts = BTreeSet::new();
    for fact in &state.known_facts {
        if !matches!(entities.get(fact.actor_id.as_str()), Some(entity) if entity.kind == EntityKind::Person)
            || !events.contains(fact.fact_id.as_str())
            || !known_facts.insert((fact.actor_id.as_str(), fact.fact_id.as_str()))
        {
            return Err(GameError::InvalidKnowledge);
        }
    }
    Ok(())
}

fn validate_output(output: &TurnOutput) -> GameResult {
    if output.protocol_version != GAME_PROTOCOL_VERSION {
        return Err(GameError::InvalidProtocol);
    }
    if output.narrative.len() > MAX_NARRATIVE_BYTES
        || output.choices.len() > MAX_CHOICES
        || output.state_changes.len() > 128
        || output.events.len() > 32
        || output.uncertainties.len() > 16
    {
        return Err(GameError::TooLarge);
    }
    if !text(&output.narrative, MAX_NARRATIVE_BYTES, true) {
        return Err(GameError::InvalidOutput);
    }
    if output.time_advance.elapsed_seconds > MAX_ELAPSED_SECONDS {
        return Err(GameError::InvalidTime);
    }
    let mut choices = BTreeSet::new();
    if output.choices.iter().any(|choice| {
        !identifier(&choice.id)
            || !text(&choice.text, 2048, true)
            || !choices.insert(choice.id.as_str())
    }) || output
        .uncertainties
        .iter()
        .any(|uncertainty| !text(uncertainty, 2048, true))
    {
        return Err(GameError::InvalidOutput);
    }
    // No research-source registry exists in M02. The model may express
    // uncertainty but cannot invent authoritative source IDs.
    if !output.source_references.is_empty() {
        return Err(GameError::InvalidReference);
    }
    if serde_json::to_vec(output)
        .map_err(|_| GameError::InvalidOutput)?
        .len()
        > MAX_TURN_OUTPUT_BYTES
    {
        return Err(GameError::TooLarge);
    }
    Ok(())
}

/// Accept one complete JSON object, optionally inside one complete `json`
/// fence. Never search for an executable fragment in surrounding model text.
pub fn parse_output(raw: &str) -> GameResult<TurnOutput> {
    if raw.len() > MAX_TURN_OUTPUT_BYTES {
        return Err(GameError::TooLarge);
    }
    let whole = raw.trim();
    let json = if let Some(fenced) = whole.strip_prefix("```json") {
        let fenced = fenced
            .strip_prefix("\r\n")
            .or_else(|| fenced.strip_prefix('\n'))
            .ok_or(GameError::InvalidOutput)?;
        fenced
            .strip_suffix("```")
            .ok_or(GameError::InvalidOutput)?
            .trim()
    } else {
        whole
    };
    let output: TurnOutput = serde_json::from_str(json).map_err(|_| GameError::InvalidOutput)?;
    validate_output(&output)?;
    Ok(output)
}

/// Apply to a private clone. Even a late invalid operation leaves every fact in
/// the caller's snapshot unchanged. The persistence layer must recheck its head
/// and commit this complete snapshot in one transaction.
pub fn apply_output(state: &WorldState, output: &TurnOutput) -> GameResult<WorldState> {
    validate_state(state)?;
    validate_output(output)?;
    let mut next = state.clone();
    next.time.elapsed_seconds = next
        .time
        .elapsed_seconds
        .checked_add(output.time_advance.elapsed_seconds)
        .filter(|time| *time <= MAX_ELAPSED_SECONDS)
        .ok_or(GameError::InvalidTime)?;

    for event in &output.events {
        if next.events.iter().any(|existing| existing.id == event.id) {
            return Err(GameError::Conflict);
        }
        next.events.push(event.clone());
    }
    for change in &output.state_changes {
        match change {
            StateChange::CreateEntity { entity } => {
                if !entity_valid(entity) {
                    return Err(GameError::InvalidEntity);
                }
                if next
                    .entities
                    .iter()
                    .any(|existing| existing.id == entity.id)
                {
                    return Err(GameError::Conflict);
                }
                next.entities.push(entity.clone());
            }
            StateChange::SetAttribute {
                entity_id,
                key,
                value,
                expected_value,
            } => {
                if !attribute_key(key)
                    || !text(value, 2048, true)
                    || expected_value
                        .as_ref()
                        .is_some_and(|value| !text(value, 2048, true))
                {
                    return Err(GameError::InvalidEntity);
                }
                let entity = next
                    .entities
                    .iter_mut()
                    .find(|entity| entity.id == *entity_id)
                    .ok_or(GameError::InvalidReference)?;
                if expected_value
                    .as_ref()
                    .is_some_and(|expected| entity.attributes.get(key) != Some(expected))
                {
                    return Err(GameError::Conflict);
                }
                entity.attributes.insert(key.clone(), value.clone());
            }
            StateChange::SetLifeStatus { entity_id, alive } => {
                let entity = next
                    .entities
                    .iter_mut()
                    .find(|entity| entity.id == *entity_id)
                    .ok_or(GameError::InvalidReference)?;
                if entity.kind != EntityKind::Person {
                    return Err(GameError::InvalidEntity);
                }
                if entity.alive == Some(false) && *alive {
                    return Err(GameError::DeadCannotRevive);
                }
                entity.alive = Some(*alive);
            }
            StateChange::Move { location_id } => {
                if !next
                    .entities
                    .iter()
                    .any(|entity| entity.id == *location_id && entity.kind == EntityKind::Place)
                {
                    return Err(GameError::InvalidReference);
                }
                next.location_id = location_id.clone();
            }
            StateChange::ChangeResource {
                owner_id,
                key,
                unit,
                delta,
                expected_amount,
            } => {
                if !next.entities.iter().any(|entity| entity.id == *owner_id) {
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
                    .find(|resource| resource.owner_id == *owner_id && resource.key == *key)
                {
                    if resource.unit != *unit {
                        return Err(GameError::InvalidResource);
                    }
                    if expected_amount.is_some_and(|expected| expected != resource.amount) {
                        return Err(GameError::Conflict);
                    }
                    resource.amount = resource
                        .amount
                        .checked_add(*delta)
                        .filter(|amount| (0..=MAX_RESOURCE_AMOUNT).contains(amount))
                        .ok_or(GameError::InvalidResource)?;
                } else {
                    if expected_amount.is_some_and(|expected| expected != 0) {
                        return Err(GameError::Conflict);
                    }
                    if *delta < 0 {
                        return Err(GameError::InvalidResource);
                    }
                    next.resources.push(Resource {
                        owner_id: owner_id.clone(),
                        key: key.clone(),
                        unit: unit.clone(),
                        amount: *delta,
                    });
                }
            }
            StateChange::ChangeRelationship {
                from_id,
                to_id,
                kind,
                strength,
            } => {
                if let Some(relationship) = next.relationships.iter_mut().find(|relationship| {
                    relationship.from_id == *from_id
                        && relationship.to_id == *to_id
                        && relationship.kind == *kind
                }) {
                    relationship.strength = *strength;
                } else {
                    next.relationships.push(Relationship {
                        from_id: from_id.clone(),
                        to_id: to_id.clone(),
                        kind: kind.clone(),
                        strength: *strength,
                    });
                }
            }
            StateChange::AddCondition { condition } => {
                if !condition.active {
                    return Err(GameError::InvalidCondition);
                }
                if next
                    .conditions
                    .iter()
                    .any(|existing| existing.id == condition.id)
                {
                    return Err(GameError::Conflict);
                }
                next.conditions.push(condition.clone());
            }
            StateChange::ResolveCondition { condition_id } => {
                let condition = next
                    .conditions
                    .iter_mut()
                    .find(|condition| condition.id == *condition_id)
                    .ok_or(GameError::InvalidReference)?;
                if !condition.active {
                    return Err(GameError::InvalidCondition);
                }
                condition.active = false;
            }
            StateChange::RecordKnowledge { actor_id, fact_id } => {
                if next
                    .known_facts
                    .iter()
                    .any(|fact| fact.actor_id == *actor_id && fact.fact_id == *fact_id)
                {
                    return Err(GameError::Conflict);
                }
                next.known_facts.push(KnownFact {
                    actor_id: actor_id.clone(),
                    fact_id: fact_id.clone(),
                });
            }
        }
    }
    validate_state(&next)?;
    Ok(next)
}
