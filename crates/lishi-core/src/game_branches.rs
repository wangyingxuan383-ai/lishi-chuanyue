//! Additive schema 3. Raw formal rows keep their global insertion sequence.
//! A selected path follows parent IDs and is replayed from the original opening.
//! Branch cards are not authorization; this module derives every ancestry bound.
use super::*;
use crate::game_annotations::{AnnotationBranchAccess, AnnotationScope};
use crate::game_context::ContextScope;
use sha2::{Digest, Sha256};
use std::{collections::BTreeSet, io::Read, path::PathBuf};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchCard {
    pub branch_id: String,
    pub parent_branch_id: Option<String>,
    pub fork_turn_id: Option<String>,
    pub fork_turn_count: u64,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
    pub name: String,
    pub archived: bool,
    pub revision: u64,
    pub annotation_fork_watermark: u64,
    pub created_at_ms: i64,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForkBranchRequest {
    pub world_id: String,
    pub source_branch_id: String,
    pub expected_head_turn_id: Option<String>,
    pub expected_revision: u64,
    pub operation_id: String,
    pub new_branch_id: String,
    pub name: String,
    pub fork_turn_id: Option<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchEditRequest {
    pub world_id: String,
    pub branch_id: String,
    pub expected_head_turn_id: Option<String>,
    pub expected_revision: u64,
    pub operation_id: String,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RewriteAction {
    pub turn_id: String,
    pub action_kind: GameActionKind,
    pub action_text: String,
}
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BranchCreated {
    pub branch: BranchCard,
    pub world: WorldViewV2,
    pub original_action: Option<RewriteAction>,
}
pub struct BranchContext {
    pub view: WorldViewV2,
    pub history: ValidatedHistory,
    pub annotation_scope: AnnotationScope,
    pub origins: Vec<String>,
}
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BranchUpgradeReceipt {
    pub from_version: u32,
    pub to_version: u32,
    pub backup_basename: String,
    pub backup_sha256: String,
    pub head_turn_id: Option<String>,
    pub turn_count: u64,
    pub completed_at_ms: i64,
}
/// Explicit user correction has a deliberately small typed surface. It is not
/// an arbitrary state replacement or a model tool.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "snake_case", deny_unknown_fields)]
pub enum FactCorrection {
    Name { name: String },
    Cash { amount: i64 },
}
pub(super) fn enabled(db: &Connection) -> Result<bool, GameStoreError> {
    Ok(db.pragma_query_value(None, "user_version", |r| r.get::<_, i32>(0))? == 3)
}
fn signed(n: u64) -> Result<i64, GameStoreError> {
    i64::try_from(n).map_err(|_| GameStoreError::RevisionOverflow)
}
fn branch_id(id: &str) -> bool {
    id == "main" || valid_game_id(id)
}
fn unsigned(row: &rusqlite::Row<'_>, column: usize) -> rusqlite::Result<u64> {
    let n: i64 = row.get(column)?;
    u64::try_from(n).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, n))
}
fn require_enabled(db: &Connection) -> Result<(), GameStoreError> {
    if !enabled(db)? {
        return Err(GameStoreError::IncompatibleSchema);
    }
    check_schema(db)
}
pub(super) fn check_tables(db: &Connection) -> Result<(), GameStoreError> {
    // Validate exact additive objects before opening recovery or changing WAL.
    let normalize = |s: &str| {
        s.trim()
            .trim_end_matches(';')
            .chars()
            .filter(|c| !c.is_ascii_whitespace())
            .collect::<String>()
            .to_ascii_lowercase()
    };
    for line in BRANCH_SCHEMA.lines().filter(|s| s.starts_with("CREATE ")) {
        let words: Vec<_> = line.split_whitespace().collect();
        let kind = words
            .get(1)
            .ok_or(GameStoreError::IncompatibleSchema)?
            .to_ascii_lowercase();
        let name = words
            .get(2)
            .ok_or(GameStoreError::IncompatibleSchema)?
            .split('(')
            .next()
            .ok_or(GameStoreError::IncompatibleSchema)?;
        let sql: Option<String> = db
            .query_row(
                "SELECT sql FROM sqlite_master WHERE type=?1 AND name=?2",
                params![kind, name],
                |r| r.get(0),
            )
            .optional()?;
        if sql.as_deref().map(normalize) != Some(normalize(line)) {
            return Err(GameStoreError::IncompatibleSchema);
        }
    }
    Ok(())
}
fn card(db: &Connection, id: &str) -> Result<BranchCard, GameStoreError> {
    if !branch_id(id) {
        return Err(GameStoreError::InvalidRequest);
    }
    let raw: Option<BranchCard> = db.query_row(
        "SELECT branch_id,parent_branch_id,fork_turn_id,fork_count,head_turn_id,turn_count,name,archived,revision,annotation_watermark,created_at_ms FROM game_branches WHERE branch_id=?1",
        [id], |r| Ok(BranchCard{branch_id:r.get(0)?,parent_branch_id:r.get(1)?,fork_turn_id:r.get(2)?,fork_turn_count:unsigned(r,3)?,head_turn_id:r.get(4)?,turn_count:unsigned(r,5)?,name:r.get(6)?,archived:r.get(7)?,revision:unsigned(r,8)?,annotation_fork_watermark:unsigned(r,9)?,created_at_ms:r.get(10)?})
    ).optional()?;
    let c = raw.ok_or(GameStoreError::NotFound)?;
    if !valid_text(&c.name, 256, false)
        || c.created_at_ms < 0
        || c.revision > i64::MAX as u64
        || c.turn_count < c.fork_turn_count
        || (c.turn_count == 0) != c.head_turn_id.is_none()
        || (c.fork_turn_count == 0) != c.fork_turn_id.is_none()
        || (c.branch_id == "main") != c.parent_branch_id.is_none()
        || c.parent_branch_id.as_deref().is_some_and(|p| !branch_id(p))
        || c.annotation_fork_watermark > i64::MAX as u64
    {
        return Err(GameStoreError::Database);
    }
    Ok(c)
}
fn raw_turn(db: &Connection, id: &str) -> Result<LegacyTurn, GameStoreError> {
    let sql = "SELECT turn_id,parent_turn_id,sequence,action_kind,action_text,narrative,choices,state,output,created_at_ms FROM game_turns WHERE turn_id=?1";
    let mut stmt = db.prepare(sql)?;
    let mut rows = stmt.query([id])?;
    read_turn(rows.next()?.ok_or(GameStoreError::Database)?)
}
fn check_citations(db: &Connection, id: &str, output: &TurnOutputV2) -> Result<(), GameStoreError> {
    for source in &output.source_references {
        let allowed:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM game_operation_sources WHERE operation_id=?1 AND source_id=?2)",params![id,source],|row|row.get(0))?;
        if !allowed {
            return Err(GameStoreError::InvalidOutput);
        }
    }
    Ok(())
}
fn path_ids(
    db: &Connection,
    head: Option<&str>,
    count: u64,
) -> Result<Vec<String>, GameStoreError> {
    // Hold IDs only. Full snapshots are read one at a time during replay.
    if count > 1_000_000 {
        return Err(GameStoreError::Database);
    }
    let mut ids = Vec::new();
    let mut seen = BTreeSet::new();
    let mut next = head.map(str::to_owned);
    while let Some(id) = next {
        if !valid_game_id(&id) || !seen.insert(id.clone()) || ids.len() as u64 >= count {
            return Err(GameStoreError::Database);
        }
        next = db.query_row(
            "SELECT parent_turn_id FROM game_turns WHERE turn_id=?1",
            [&id],
            |r| r.get(0),
        )?;
        ids.push(id);
    }
    if ids.len() as u64 != count {
        return Err(GameStoreError::Database);
    }
    ids.reverse();
    Ok(ids)
}
fn ancestry(
    db: &Connection,
    selected: &BranchCard,
    ids: &[String],
) -> Result<Vec<BranchCard>, GameStoreError> {
    let mut chain = vec![selected.clone()];
    let mut seen = BTreeSet::from([selected.branch_id.clone()]);
    while let Some(parent) = chain.last().and_then(|b| b.parent_branch_id.as_deref()) {
        if chain.len() >= 256 || !seen.insert(parent.to_owned()) {
            return Err(GameStoreError::Database);
        }
        let child = chain.last().ok_or(GameStoreError::Database)?;
        let p = card(db, parent)?;
        let parent_ids = path_ids(db, p.head_turn_id.as_deref(), p.turn_count)?;
        let n = usize::try_from(child.fork_turn_count).map_err(|_| GameStoreError::Database)?;
        if n > parent_ids.len()
            || parent_ids.get(n.wrapping_sub(1)).cloned() != child.fork_turn_id
            || parent_ids
                .iter()
                .zip(ids)
                .take(n.min(ids.len()))
                .any(|(a, b)| a != b)
        {
            return Err(GameStoreError::Database);
        }
        chain.push(p);
    }
    chain.reverse();
    if chain.first().map(|b| b.branch_id.as_str()) != Some("main") {
        return Err(GameStoreError::Database);
    }
    Ok(chain)
}
pub(super) fn read_context(
    db: &Connection,
    selected: &str,
) -> Result<BranchContext, GameStoreError> {
    require_enabled(db)?;
    audit_operations(db)?;
    let c = card(db, selected)?;
    let ids = path_ids(db, c.head_turn_id.as_deref(), c.turn_count)?;
    let chain = ancestry(db, &c, &ids)?;
    let mut header = read_header(db)?;
    let original_header = header.clone();
    let setup: WorldSetup = decode(&header.setup_json)?;
    validate_setup(&setup).map_err(|_| GameStoreError::Database)?;
    if setup.world_id != header.world_id {
        return Err(GameStoreError::Database);
    }
    let receipt = migration_receipt(db)?;
    let legacy_total = receipt.as_ref().map_or(0, |r| r.turn_count);
    let mut legacy_visible = 0;
    if receipt.is_some() {
        for id in &ids {
            if raw_turn(db, id)?.sequence > legacy_total {
                break;
            }
            legacy_visible += 1;
        }
    }
    let mut history = if receipt.is_some() {
        // Derive exactly the selected legacy prefix; future old snapshots are
        // audited for immutability, but never become this branch's initial facts.
        header.turn_count = legacy_visible;
        header.head_turn_id = ids.get((legacy_visible as usize).wrapping_sub(1)).cloned();
        header.current_state_json = if let Some(id) = &header.head_turn_id {
            raw_turn(db, id)?.state_json
        } else {
            header.initial_state_json.clone()
        };
        let mut builder = LegacyKnowledgeHistoryBuilder::from_header(&header)
            .map_err(|_| GameStoreError::Database)?;
        for id in ids.iter().take(legacy_visible as usize) {
            let turn = raw_turn(db, id)?;
            if turn.sequence > legacy_total {
                return Err(GameStoreError::Database);
            }
            builder
                .push_turn(&turn)
                .map_err(|_| GameStoreError::Database)?;
        }
        builder.finish().map_err(|_| GameStoreError::Database)?
    } else {
        let initial: WorldStateV2 = decode(&header.initial_state_json)?;
        if initial != initial_state_v2(&setup).map_err(|_| GameStoreError::Database)? {
            return Err(GameStoreError::Database);
        }
        ValidatedHistory::new(&header.world_id, initial, Vec::new(), None)
            .map_err(|_| GameStoreError::Database)?
    };
    let mut recent = std::collections::VecDeque::new();
    let mut origins = Vec::new();
    for (position, id) in ids.iter().enumerate() {
        let turn = raw_turn(db, id)?;
        let (origin, path_sequence): (String, u64) = db.query_row(
            "SELECT branch_id,path_sequence FROM game_turn_origins WHERE turn_id=?1",
            [id],
            |r| Ok((r.get(0)?, unsigned(r, 1)?)),
        )?;
        let expected_origin = chain
            .iter()
            .rev()
            .find(|b| position as u64 + 1 > b.fork_turn_count)
            .ok_or(GameStoreError::Database)?;
        if origin != expected_origin.branch_id || path_sequence != position as u64 + 1 {
            return Err(GameStoreError::Database);
        }
        let matching:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM game_operations o JOIN game_operation_branches b USING(operation_id) WHERE o.operation_id=?1 AND b.branch_id=?2 AND o.expected_head_turn_id IS ?3 AND o.action_kind=?4 AND o.action_text=?5 AND o.status='committed' AND o.candidate IS NULL AND o.error_code IS NULL)",params![id,origin,turn.parent_turn_id,action_name(turn.action_kind),turn.action_text],|r|r.get(0))?;
        if !matching {
            return Err(GameStoreError::Database);
        }
        let choices: Vec<Choice> = decode(&turn.choices_json)?;
        checked_choices(&choices)?;
        if position as u64 >= legacy_visible {
            let output =
                parse_output_v2(&turn.output_json).map_err(|_| GameStoreError::Database)?;
            check_citations(db, id, &output).map_err(|_| GameStoreError::Database)?;
            if output.narrative != turn.narrative || output.choices != choices {
                return Err(GameStoreError::Database);
            }
            history
                .append_v2_entry(CommittedHistoryEntry {
                    operation_id: id.clone(),
                    turn_id: id.clone(),
                    parent_turn_id: turn.parent_turn_id.clone(),
                    output,
                    state: decode(&turn.state_json)?,
                })
                .map_err(|_| GameStoreError::Database)?;
        }
        // Legacy rows need converted snapshots, not raw v1 JSON.
        origins.push(origin.clone());
        let state = if (position as u64) < legacy_visible {
            // Only the recent window needs historical legacy projections.
            if ids.len().saturating_sub(position) > RECENT_TURN_LIMIT {
                continue;
            }
            let mut prefix = header.clone();
            prefix.turn_count = position as u64 + 1;
            prefix.head_turn_id = Some(id.clone());
            prefix.current_state_json = turn.state_json.clone();
            let mut adapter =
                LegacyAdapter::from_header(&prefix).map_err(|_| GameStoreError::Database)?;
            for prior in ids.iter().take(position + 1) {
                adapter
                    .push_turn(&raw_turn(db, prior)?)
                    .map_err(|_| GameStoreError::Database)?;
            }
            adapter
                .finish()
                .map_err(|_| GameStoreError::Database)?
                .current_state
        } else {
            history.current_state().clone()
        };
        recent.push_back(CommittedTurnV2 {
            turn_id: id.clone(),
            parent_turn_id: turn.parent_turn_id,
            action_kind: turn.action_kind,
            action_text: turn.action_text,
            narrative: turn.narrative,
            choices,
            state,
            created_at_ms: turn.created_at_ms,
        });
        if recent.len() > RECENT_TURN_LIMIT {
            recent.pop_front();
        }
    }
    if history.turn_count() != c.turn_count || history.head_turn_id() != c.head_turn_id.as_deref() {
        return Err(GameStoreError::Database);
    }
    if selected == "main"
        && (original_header.head_turn_id != c.head_turn_id
            || original_header.turn_count != c.turn_count
            || decode::<WorldStateV2>(&original_header.current_state_json)?
                != *history.current_state())
    {
        return Err(GameStoreError::Database);
    }
    let opening_choices: Vec<Choice> = decode(&header.opening_choices_json)?;
    checked_choices(&opening_choices)?;
    let policy: String = db.query_row(
        "SELECT narrative_policy FROM game_branches WHERE branch_id=?1",
        [selected],
        |r| r.get(0),
    )?;
    let latest_id:Option<String>=db.query_row("SELECT o.operation_id FROM game_operations o JOIN game_operation_branches b USING(operation_id) WHERE b.branch_id=?1 ORDER BY o.rowid DESC LIMIT 1",[selected],|r|r.get(0)).optional()?;
    let latest = latest_id
        .map(|id| read_operation(db, &id))
        .transpose()?
        .flatten();
    let view = WorldViewV2 {
        setup,
        branch_id: selected.into(),
        head_turn_id: c.head_turn_id.clone(),
        turn_count: c.turn_count,
        state: history.current_state().clone(),
        opening_narrative: header.opening_narrative,
        opening_choices,
        narrative_policy: policy,
        turns: recent.into_iter().collect(),
        latest_operation: latest,
    };
    let mut accesses = Vec::new();
    for (i, b) in chain.iter().enumerate() {
        let cutoff = chain
            .iter()
            .skip(i + 1)
            .map(|child| child.fork_turn_count)
            .min()
            .unwrap_or(c.turn_count)
            .min(c.turn_count);
        accesses.push(AnnotationBranchAccess {
            branch_id: b.branch_id.clone(),
            through_turn_id: ids.get((cutoff as usize).wrapping_sub(1)).cloned(),
            through_change_seq: chain
                .get(i + 1)
                .map(|child| child.annotation_fork_watermark),
        });
    }
    Ok(BranchContext {
        annotation_scope: AnnotationScope {
            context: ContextScope::from_view(&view),
            branch_path: accesses,
        },
        view,
        history,
        origins,
    })
}
fn audit_operations(db: &Connection) -> Result<(), GameStoreError> {
    let mut statement=db.prepare("SELECT o.operation_id,b.branch_id,o.candidate FROM game_operations o LEFT JOIN game_operation_branches b USING(operation_id) ORDER BY o.rowid")?;
    let mut rows = statement.query([])?;
    let mut active_count = 0;
    while let Some(row) = rows.next()? {
        let id = bounded_text(row, 0, 128)?;
        let branch: Option<String> = row.get(1)?;
        let branch = branch.ok_or(GameStoreError::Database)?;
        let candidate: Option<String> = row.get(2)?;
        let op = read_operation(db, &id)?.ok_or(GameStoreError::Database)?;
        if !valid_game_id(&id)
            || op.created_at_ms < 0
            || op
                .expected_head_turn_id
                .as_deref()
                .is_some_and(|v| !valid_game_id(v))
            || !valid_text(
                &op.action_text,
                MAX_ACTION_BYTES,
                op.action_kind == GameActionKind::Continue,
            )
            || op
                .error_code
                .as_deref()
                .is_some_and(|v| !safe_error_code(v))
            || (op.status == GameOperationStatus::Validating) != candidate.is_some()
            || candidate
                .as_deref()
                .is_some_and(|v| !valid_text(v, MAX_CANDIDATE_BYTES, false))
        {
            return Err(GameStoreError::Database);
        }
        let c = card(db, &branch)?;
        if op.status.is_active() {
            active_count += 1;
            if active_count > 1
                || op.error_code.is_some()
                || op.expected_head_turn_id != c.head_turn_id
            {
                return Err(GameStoreError::Database);
            }
        }
        let turn_branch: Option<String> = db
            .query_row(
                "SELECT branch_id FROM game_turn_origins WHERE turn_id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        if op.status == GameOperationStatus::Committed {
            if turn_branch.as_deref() != Some(branch.as_str())
                || op.error_code.is_some()
                || candidate.is_some()
            {
                return Err(GameStoreError::Database);
            }
        } else if turn_branch.is_some() {
            return Err(GameStoreError::Database);
        }
    }
    Ok(())
}

fn no_active(db: &Connection) -> Result<(), GameStoreError> {
    if db.query_row("SELECT EXISTS(SELECT 1 FROM game_operations WHERE status IN ('pending','generating','validating'))",[],|r|r.get::<_,bool>(0))? {return Err(GameStoreError::Busy);}
    Ok(())
}
fn unique_operation(db: &Connection, id: &str) -> Result<(), GameStoreError> {
    if !valid_game_id(id) {
        return Err(GameStoreError::InvalidRequest);
    }
    if db.query_row("SELECT EXISTS(SELECT 1 FROM game_operations WHERE operation_id=?1) OR EXISTS(SELECT 1 FROM game_branch_controls WHERE operation_id=?1)",[id],|r|r.get::<_,bool>(0))?{return Err(GameStoreError::Duplicate);}
    Ok(())
}
fn check_edit(db: &Connection, r: &BranchEditRequest) -> Result<BranchCard, GameStoreError> {
    let context = read_context(db, &r.branch_id)?;
    if context.view.setup.world_id != r.world_id {
        return Err(GameStoreError::InvalidRequest);
    }
    let c = card(db, &r.branch_id)?;
    if c.head_turn_id != r.expected_head_turn_id || c.revision != r.expected_revision {
        return Err(GameStoreError::StaleHead);
    }
    no_active(db)?;
    unique_operation(db, &r.operation_id)?;
    Ok(c)
}
impl GameStoreV2 {
    /// Only trusted native preflight registers these IDs; this is not exposed
    /// as an IPC tool, and it cannot write game facts or grant observations.
    pub fn allow_research_sources(
        &self,
        operation_id: &str,
        source_ids: &[String],
    ) -> Result<(), GameStoreError> {
        if source_ids.len() > 128
            || source_ids.iter().any(|id| !valid_game_id(id))
            || source_ids.iter().collect::<BTreeSet<_>>().len() != source_ids.len()
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut db = self.connection()?;
        require_enabled(&db)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let operation = read_operation(&tx, operation_id)?.ok_or(GameStoreError::NotFound)?;
        if operation.status != GameOperationStatus::Generating {
            return Err(GameStoreError::InvalidTransition);
        }
        for id in source_ids {
            tx.execute("INSERT OR IGNORE INTO game_operation_sources(operation_id,source_id) VALUES(?1,?2)",params![operation_id,id])?;
        }
        tx.commit()?;
        Ok(())
    }
    pub fn correct_fact_on_new_branch(
        &self,
        r: &ForkBranchRequest,
        correction_id: &str,
        correction: &FactCorrection,
        annotation_watermark: u64,
        research_watermark: u64,
    ) -> Result<BranchCreated, GameStoreError> {
        use crate::game_knowledge::{
            initial_visible_grants, observed_facts_for_actor, SourceVisibilityIndex,
        };
        use crate::game_protocol_v2::{
            Disclosure, EventInput, FactKey, StateChangeV2, TimeAdvanceV2,
        };
        if r.operation_id == correction_id
            || r.fork_turn_id != r.expected_head_turn_id
            || !valid_game_id(&r.new_branch_id)
            || !valid_text(&r.name, 256, false)
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let source = read_context(&tx, &r.source_branch_id)?;
        let actor = &source.view.state.protagonist_id;
        let grants = initial_visible_grants(&source.history, actor)
            .map_err(|_| GameStoreError::InvalidRequest)?;
        let visibility = SourceVisibilityIndex::from_recorded_observations(&source.history, grants)
            .map_err(|_| GameStoreError::InvalidRequest)?;
        let known = observed_facts_for_actor(&source.history, &visibility, actor)
            .map_err(|_| GameStoreError::InvalidRequest)?;
        let event_id =
            format!("correction-{:x}", Sha256::digest(correction_id.as_bytes()))[..43].to_owned();
        let (fact, change, description) = match correction {
            FactCorrection::Name { name } => {
                let fact = FactKey::EntityName {
                    entity_id: actor.clone(),
                };
                let entity = source
                    .view
                    .state
                    .entities
                    .iter()
                    .find(|e| e.id == *actor)
                    .ok_or(GameStoreError::InvalidRequest)?;
                if !valid_text(name, 128, false)
                    || !known
                        .iter()
                        .any(|f| f.fact_key == fact && f.value == serde_json::json!(entity.name))
                {
                    return Err(GameStoreError::InvalidRequest);
                }
                (
                    fact,
                    StateChangeV2::RenameEntity {
                        entity_id: actor.clone(),
                        expected_name: entity.name.clone(),
                        new_name: name.clone(),
                        event_id: event_id.clone(),
                    },
                    format!("玩家明确修正主角姓名为{name}；保留原世界线。"),
                )
            }
            FactCorrection::Cash { amount } => {
                let fact = FactKey::Resource {
                    owner_id: actor.clone(),
                    key: "cash".into(),
                };
                let old = source
                    .view
                    .state
                    .resources
                    .iter()
                    .find(|res| res.owner_id == *actor && res.key == "cash")
                    .ok_or(GameStoreError::InvalidRequest)?;
                if *amount < 0
                    || *amount > 9_007_199_254_740_991
                    || !known.iter().any(|f| {
                        f.fact_key == fact
                            && crate::game_protocol_v2::fact_value_v2(&source.view.state, &fact)
                                .as_ref()
                                == Some(&f.value)
                    })
                {
                    return Err(GameStoreError::InvalidRequest);
                }
                (
                    fact,
                    StateChangeV2::ChangeResource {
                        owner_id: actor.clone(),
                        key: "cash".into(),
                        unit: old.unit.clone(),
                        delta: amount
                            .checked_sub(old.amount)
                            .ok_or(GameStoreError::InvalidRequest)?,
                        expected_amount: Some(old.amount),
                        event_id: event_id.clone(),
                    },
                    format!(
                        "玩家明确修正本人资产cash为{amount} {}；保留原世界线。",
                        old.unit
                    ),
                )
            }
        };
        unique_operation(&tx, correction_id)?;
        let result = fork_in_transaction(&tx, r, annotation_watermark, research_watermark)?;
        let output = TurnOutputV2 {
            protocol_version: 2,
            narrative: description.clone(),
            choices: Vec::new(),
            time_advance: TimeAdvanceV2 {
                elapsed_seconds: 0,
                event_id: None,
            },
            state_changes: vec![
                change,
                StateChangeV2::ObserveFact {
                    actor_id: actor.clone(),
                    fact_key: fact,
                    event_id: event_id.clone(),
                },
            ],
            events: vec![EventInput {
                id: event_id,
                description: description.clone(),
                entity_ids: vec![actor.clone()],
                disclosure: Disclosure::Restricted,
            }],
            source_references: Vec::new(),
            uncertainties: vec![
                "这是玩家明确发起的世界外事实修正，没有调用模型或进行历史考证。".into(),
            ],
        };
        let next = apply_output_v2(
            &result.world.state,
            &output,
            &CommitContext {
                operation_id: correction_id.into(),
                turn_id: correction_id.into(),
            },
        )
        .map_err(|_| GameStoreError::InvalidOutput)?;
        let timestamp = now_ms()?;
        let global: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM game_turns",
            [],
            |row| row.get(0),
        )?;
        let count = result
            .world
            .turn_count
            .checked_add(1)
            .ok_or(GameStoreError::RevisionOverflow)?;
        tx.execute("INSERT INTO game_operations(operation_id,expected_head_turn_id,action_kind,action_text,status,candidate,error_code,created_at_ms) VALUES(?1,?2,'action',?3,'committed',NULL,NULL,?4)",params![correction_id,result.world.head_turn_id,description,timestamp])?;
        tx.execute(
            "INSERT INTO game_operation_branches VALUES(?1,?2)",
            params![correction_id, r.new_branch_id],
        )?;
        tx.execute("INSERT INTO game_turns(turn_id,parent_turn_id,sequence,action_kind,action_text,narrative,choices,state,output,created_at_ms) VALUES(?1,?2,?3,'action',?4,?4,?5,?6,?7,?8)",params![correction_id,result.world.head_turn_id,global,description,json(&output.choices)?,json(&next)?,json(&output)?,timestamp])?;
        tx.execute(
            "INSERT INTO game_turn_origins VALUES(?1,?2,?3)",
            params![correction_id, r.new_branch_id, signed(count)?],
        )?;
        tx.execute("UPDATE game_branches SET head_turn_id=?2,turn_count=?3,revision=revision+1 WHERE branch_id=?1",params![r.new_branch_id,correction_id,signed(count)?])?;
        let world = read_context(&tx, &r.new_branch_id)?.view;
        let branch = card(&tx, &r.new_branch_id)?;
        tx.commit()?;
        Ok(BranchCreated {
            world,
            branch,
            original_action: None,
        })
    }
    /// The root has no fork boundary. Child values are frozen with the branch.
    pub fn research_fork_watermark(&self, branch: &str) -> Result<u64, GameStoreError> {
        if branch == "main" {
            return Ok(0);
        }
        let db = self.connection()?;
        Ok(db.query_row(
            "SELECT watermark FROM game_branch_watermarks WHERE branch_id=?1 AND domain='research'",
            [branch],
            |r| unsigned(r, 0),
        )?)
    }
    pub fn operation_branch(&self, id: &str) -> Result<String, GameStoreError> {
        if !self.branches_enabled()? {
            return Ok("main".into());
        }
        let db = self.connection()?;
        Ok(db.query_row(
            "SELECT branch_id FROM game_operation_branches WHERE operation_id=?1",
            [id],
            |r| r.get(0),
        )?)
    }
    pub fn selected_view(&self, id: &str) -> Result<WorldViewV2, GameStoreError> {
        if self.branches_enabled()? {
            self.view_branch(id)
        } else if id == "main" {
            self.view()
        } else {
            Err(GameStoreError::IncompatibleSchema)
        }
    }
    pub fn selected_history(&self, id: &str) -> Result<ValidatedHistory, GameStoreError> {
        if self.branches_enabled()? {
            self.knowledge_history_branch(id)
        } else if id == "main" {
            self.knowledge_history()
        } else {
            Err(GameStoreError::IncompatibleSchema)
        }
    }
    pub fn selected_annotation_scope(
        &self,
        view: &WorldViewV2,
    ) -> Result<AnnotationScope, GameStoreError> {
        if self.branches_enabled()? {
            let context = self.read_branch_context(&view.branch_id)?;
            if context.view.head_turn_id != view.head_turn_id || context.view.state != view.state {
                return Err(GameStoreError::StaleHead);
            }
            Ok(context.annotation_scope)
        } else if view.branch_id == "main" {
            Ok(AnnotationScope::single(ContextScope::from_view(view)))
        } else {
            Err(GameStoreError::IncompatibleSchema)
        }
    }
    pub fn selected_visit(
        &self,
        id: &str,
        visitor: impl FnMut(CommittedTurnV2, u64, &str) -> Result<(), GameStoreError>,
    ) -> Result<CommittedHistoryScope, GameStoreError> {
        if self.branches_enabled()? {
            self.visit_committed_turns_branch(id, visitor)
        } else if id == "main" {
            self.visit_committed_turns(visitor)
        } else {
            Err(GameStoreError::IncompatibleSchema)
        }
    }
    pub fn selected_rebuild(
        &self,
        id: &str,
        index: &mut MemoryIndex,
    ) -> Result<GameMemoryIndexReceipt, GameStoreError> {
        if self.branches_enabled()? {
            self.rebuild_memory_index_branch(id, index)
        } else if id == "main" {
            self.rebuild_memory_index(index)
        } else {
            Err(GameStoreError::IncompatibleSchema)
        }
    }
    pub fn branches_enabled(&self) -> Result<bool, GameStoreError> {
        {
            let db = self.connection()?;
            enabled(&db)
        }
    }
    /// Explicit backup first, using the already held world owner lock.
    pub fn enable_branches(
        &self,
        backup_directory: &Path,
        expected_head: Option<&str>,
    ) -> Result<BranchUpgradeReceipt, GameStoreError> {
        let mut db = self.connection()?;
        if enabled(&db)? {
            return Err(GameStoreError::Duplicate);
        }
        no_active(&db)?;
        let view = view_connection(&db)?;
        if view.head_turn_id.as_deref() != expected_head {
            return Err(GameStoreError::StaleHead);
        }
        std::fs::create_dir_all(backup_directory).map_err(|_| GameStoreError::Unavailable)?;
        let timestamp = now_ms()?;
        let name = format!("branches-{}-{timestamp}.sqlite", view.setup.world_id);
        let path: PathBuf = backup_directory.join(&name);
        let file = File::options()
            .write(true)
            .create_new(true)
            .open(&path)
            .map_err(|_| GameStoreError::Unavailable)?;
        drop(file);
        {
            let mut destination = Connection::open(&path)?;
            let backup = rusqlite::backup::Backup::new(&db, &mut destination)?;
            let mut busy = 0;
            loop {
                match backup.step(64)? {
                    rusqlite::backup::StepResult::Done => break,
                    rusqlite::backup::StepResult::More => {}
                    _ => {
                        busy += 1;
                        if busy > 20 {
                            return Err(GameStoreError::Unavailable);
                        }
                        std::thread::sleep(std::time::Duration::from_millis(5));
                    }
                }
            }
            drop(backup);
            if destination.query_row("PRAGMA integrity_check", [], |r| r.get::<_, String>(0))?
                != "ok"
            {
                return Err(GameStoreError::Database);
            }
        }
        let mut digest = Sha256::new();
        let mut file = File::open(&path).map_err(|_| GameStoreError::Unavailable)?;
        let mut buf = [0; 64 * 1024];
        loop {
            let n = file
                .read(&mut buf)
                .map_err(|_| GameStoreError::Unavailable)?;
            if n == 0 {
                break;
            }
            digest.update(&buf[..n]);
        }
        let receipt = BranchUpgradeReceipt {
            from_version: 2,
            to_version: 3,
            backup_basename: name,
            backup_sha256: format!("{:x}", digest.finalize()),
            head_turn_id: view.head_turn_id.clone(),
            turn_count: view.turn_count,
            completed_at_ms: timestamp,
        };
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        tx.execute_batch(BRANCH_SCHEMA)?;
        tx.execute("INSERT INTO game_branches(branch_id,parent_branch_id,fork_turn_id,fork_count,head_turn_id,turn_count,name,archived,revision,annotation_watermark,created_at_ms,narrative_policy) VALUES('main',NULL,NULL,0,?1,?2,'主世界线',0,0,0,?3,?4)",params![view.head_turn_id,signed(view.turn_count)?,timestamp,view.narrative_policy])?;
        tx.execute(
            "INSERT INTO game_turn_origins SELECT turn_id,'main',sequence FROM game_turns",
            [],
        )?;
        tx.execute(
            "INSERT INTO game_operation_branches SELECT operation_id,'main' FROM game_operations",
            [],
        )?;
        tx.execute(
            "INSERT INTO game_branch_migrations(receipt) VALUES(?1)",
            [json(&receipt)?],
        )?;
        tx.pragma_update(None, "user_version", 3)?;
        read_context(&tx, "main")?;
        tx.commit()?;
        Ok(receipt)
    }
    pub fn read_branch_context(&self, id: &str) -> Result<BranchContext, GameStoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let c = read_context(&tx, id)?;
        tx.commit()?;
        Ok(c)
    }
    pub fn view_branch(&self, id: &str) -> Result<WorldViewV2, GameStoreError> {
        Ok(self.read_branch_context(id)?.view)
    }
    pub fn knowledge_history_branch(&self, id: &str) -> Result<ValidatedHistory, GameStoreError> {
        Ok(self.read_branch_context(id)?.history)
    }
    pub fn list_branches(&self) -> Result<Vec<BranchCard>, GameStoreError> {
        let db = self.connection()?;
        require_enabled(&db)?;
        let mut stmt =
            db.prepare("SELECT branch_id FROM game_branches ORDER BY created_at_ms,branch_id")?;
        let ids = stmt
            .query_map([], |r| r.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        ids.iter().map(|id| card(&db, id)).collect()
    }
    pub fn fork_branch(
        &self,
        r: &ForkBranchRequest,
        watermark: u64,
    ) -> Result<BranchCreated, GameStoreError> {
        self.fork_branch_with_watermarks(r, watermark, 0)
    }
    pub fn fork_branch_with_watermarks(
        &self,
        r: &ForkBranchRequest,
        watermark: u64,
        research_watermark: u64,
    ) -> Result<BranchCreated, GameStoreError> {
        if !valid_game_id(&r.new_branch_id)
            || !valid_text(&r.name, 256, false)
            || watermark > i64::MAX as u64
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let result = fork_in_transaction(&tx, r, watermark, research_watermark)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn rewrite_branch(
        &self,
        r: &ForkBranchRequest,
        turn_id: &str,
        watermark: u64,
    ) -> Result<BranchCreated, GameStoreError> {
        self.rewrite_branch_with_watermarks(r, turn_id, watermark, 0)
    }
    pub fn rewrite_branch_with_watermarks(
        &self,
        r: &ForkBranchRequest,
        turn_id: &str,
        watermark: u64,
        research_watermark: u64,
    ) -> Result<BranchCreated, GameStoreError> {
        let context = self.read_branch_context(&r.source_branch_id)?;
        if !context.history.contains_turn(turn_id) {
            return Err(GameStoreError::InvalidRequest);
        }
        let turn = {
            let db = self.connection()?;
            raw_turn(&db, turn_id)?
        };
        let mut fork = r.clone();
        fork.fork_turn_id = turn.parent_turn_id.clone();
        let mut result = self.fork_branch_with_watermarks(&fork, watermark, research_watermark)?;
        result.original_action = Some(RewriteAction {
            turn_id: turn.turn_id,
            action_kind: turn.action_kind,
            action_text: turn.action_text,
        });
        Ok(result)
    }
    pub fn rename_branch(
        &self,
        r: &BranchEditRequest,
        name: &str,
    ) -> Result<BranchCard, GameStoreError> {
        self.edit_branch(r, Some(name), None)
    }
    pub fn archive_branch(&self, r: &BranchEditRequest) -> Result<BranchCard, GameStoreError> {
        self.edit_branch(r, None, Some(true))
    }
    pub fn restore_branch(&self, r: &BranchEditRequest) -> Result<BranchCard, GameStoreError> {
        self.edit_branch(r, None, Some(false))
    }
    fn edit_branch(
        &self,
        r: &BranchEditRequest,
        name: Option<&str>,
        archived: Option<bool>,
    ) -> Result<BranchCard, GameStoreError> {
        if name.is_some_and(|n| !valid_text(n, 256, false)) {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let c = check_edit(&tx, r)?;
        tx.execute(
            "UPDATE game_branches SET name=?2,archived=?3,revision=revision+1 WHERE branch_id=?1",
            params![
                r.branch_id,
                name.unwrap_or(&c.name),
                archived.unwrap_or(c.archived)
            ],
        )?;
        tx.execute(
            "INSERT INTO game_branch_controls VALUES(?1,?2,'edit',?3)",
            params![r.operation_id, r.branch_id, now_ms()?],
        )?;
        let result = card(&tx, &r.branch_id)?;
        tx.commit()?;
        Ok(result)
    }
    pub fn begin_branch(&self, r: &GameTurnRequest) -> Result<(), GameStoreError> {
        if !valid_game_id(&r.world_id)
            || !valid_text(
                &r.action_text,
                MAX_ACTION_BYTES,
                r.action_kind == GameActionKind::Continue,
            )
        {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let context = read_context(&tx, &r.branch_id)?;
        let c = card(&tx, &r.branch_id)?;
        if context.view.setup.world_id != r.world_id || c.archived {
            return Err(GameStoreError::InvalidRequest);
        }
        if c.head_turn_id != r.expected_head_turn_id {
            return Err(GameStoreError::StaleHead);
        }
        no_active(&tx)?;
        unique_operation(&tx, &r.operation_id)?;
        tx.execute("INSERT INTO game_operations(operation_id,expected_head_turn_id,action_kind,action_text,status,candidate,error_code,created_at_ms) VALUES(?1,?2,?3,?4,'pending',NULL,NULL,?5)",params![r.operation_id,r.expected_head_turn_id,action_name(r.action_kind),r.action_text,now_ms()?])?;
        tx.execute(
            "INSERT INTO game_operation_branches VALUES(?1,?2)",
            params![r.operation_id, r.branch_id],
        )?;
        tx.commit()?;
        Ok(())
    }
    pub fn commit_branch_with_hook<F: FnOnce() -> Result<(), GameStoreError>>(
        &self,
        id: &str,
        output: &TurnOutputV2,
        hook: F,
    ) -> Result<WorldViewV2, GameStoreError> {
        self.commit_branch_with_transaction_hook(id, output, |_| hook())
    }
    /// Companion progress is written in the same transaction as formal facts;
    /// the callback must not perform network or platform operations.
    pub fn commit_branch_with_transaction_hook<
        F: FnOnce(&rusqlite::Transaction<'_>) -> Result<(), GameStoreError>,
    >(
        &self,
        id: &str,
        output: &TurnOutputV2,
        hook: F,
    ) -> Result<WorldViewV2, GameStoreError> {
        let mut db = self.connection()?;
        let branch: String = db.query_row(
            "SELECT branch_id FROM game_operation_branches WHERE operation_id=?1",
            [id],
            |r| r.get(0),
        )?;
        let context = read_context(&db, &branch)?;
        let c = card(&db, &branch)?;
        let op = read_operation(&db, id)?.ok_or(GameStoreError::NotFound)?;
        let candidate: Option<String> = db.query_row(
            "SELECT candidate FROM game_operations WHERE operation_id=?1",
            [id],
            |r| r.get(0),
        )?;
        if c.archived || op.status != GameOperationStatus::Validating {
            return Err(GameStoreError::InvalidTransition);
        }
        if c.head_turn_id != op.expected_head_turn_id {
            return Err(GameStoreError::StaleHead);
        }
        if parse_output_v2(
            candidate
                .as_deref()
                .ok_or(GameStoreError::InvalidTransition)?,
        )
        .map_err(|_| GameStoreError::InvalidOutput)?
            != *output
        {
            return Err(GameStoreError::InvalidOutput);
        }
        check_citations(&db, id, output)?;
        let next = apply_output_v2(
            &context.view.state,
            output,
            &CommitContext {
                operation_id: id.into(),
                turn_id: id.into(),
            },
        )
        .map_err(|_| GameStoreError::InvalidOutput)?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = card(&tx, &branch)?;
        if current != c {
            return Err(GameStoreError::StaleHead);
        }
        let global: i64 = tx.query_row(
            "SELECT COALESCE(MAX(sequence),0)+1 FROM game_turns",
            [],
            |r| r.get(0),
        )?;
        let path = c
            .turn_count
            .checked_add(1)
            .ok_or(GameStoreError::RevisionOverflow)?;
        let timestamp = now_ms()?;
        tx.execute("INSERT INTO game_turns(turn_id,parent_turn_id,sequence,action_kind,action_text,narrative,choices,state,output,created_at_ms) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",params![id,c.head_turn_id,global,action_name(op.action_kind),op.action_text,output.narrative,json(&output.choices)?,json(&next)?,json(output)?,timestamp])?;
        tx.execute(
            "INSERT INTO game_turn_origins VALUES(?1,?2,?3)",
            params![id, branch, signed(path)?],
        )?;
        tx.execute("UPDATE game_branches SET head_turn_id=?2,turn_count=?3,revision=revision+1 WHERE branch_id=?1",params![branch,id,signed(path)?])?;
        if branch == "main" {
            tx.execute(
                "UPDATE game_world SET current_state=?1,head_turn_id=?2,turn_count=?3 WHERE id=1",
                params![json(&next)?, id, signed(path)?],
            )?;
        }
        if tx.execute("UPDATE game_operations SET status='committed',candidate=NULL,error_code=NULL WHERE operation_id=?1 AND status='validating'",[id])?!=1{return Err(GameStoreError::InvalidTransition);}
        hook(&tx)?;
        let result = read_context(&tx, &branch)?.view;
        tx.commit()?;
        Ok(result)
    }
    pub fn update_policy_branch(
        &self,
        branch: &str,
        head: Option<&str>,
        policy: &str,
    ) -> Result<WorldViewV2, GameStoreError> {
        if !valid_text(policy, MAX_POLICY_BYTES, true) {
            return Err(GameStoreError::InvalidRequest);
        }
        let mut db = self.connection()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        let c = card(&tx, branch)?;
        no_active(&tx)?;
        if c.archived || c.head_turn_id.as_deref() != head {
            return Err(GameStoreError::StaleHead);
        }
        tx.execute(
            "UPDATE game_branches SET narrative_policy=?2,revision=revision+1 WHERE branch_id=?1",
            params![branch, policy],
        )?;
        if branch == "main" {
            tx.execute(
                "UPDATE game_world SET narrative_policy=?1 WHERE id=1",
                [policy],
            )?;
        }
        let view = read_context(&tx, branch)?.view;
        tx.commit()?;
        Ok(view)
    }
    pub fn visit_committed_turns_branch(
        &self,
        branch: &str,
        mut visitor: impl FnMut(CommittedTurnV2, u64, &str) -> Result<(), GameStoreError>,
    ) -> Result<CommittedHistoryScope, GameStoreError> {
        let mut db = self.connection()?;
        let tx = db.transaction()?;
        let context = read_context(&tx, branch)?;
        let ids = context.history.visible_turn_ids();
        // Replay each requested prefix to expose its audited normalized snapshot.
        // Memory stays bounded; the full history proof was already checked once.
        for (n, id) in ids.iter().enumerate() {
            let turn = raw_turn(&tx, id)?;
            let origin: String = tx.query_row(
                "SELECT branch_id FROM game_turn_origins WHERE turn_id=?1",
                [id],
                |r| r.get(0),
            )?;
            let state = if turn.sequence <= migration_receipt(&tx)?.map_or(0, |r| r.turn_count) {
                let mut h = read_header(&tx)?;
                h.turn_count = n as u64 + 1;
                h.head_turn_id = Some(id.clone());
                h.current_state_json = turn.state_json.clone();
                let mut a = LegacyAdapter::from_header(&h).map_err(|_| GameStoreError::Database)?;
                for prior in ids.iter().take(n + 1) {
                    a.push_turn(&raw_turn(&tx, prior)?)
                        .map_err(|_| GameStoreError::Database)?;
                }
                a.finish()
                    .map_err(|_| GameStoreError::Database)?
                    .current_state
            } else {
                decode(&turn.state_json)?
            };
            visitor(
                CommittedTurnV2 {
                    turn_id: id.clone(),
                    parent_turn_id: turn.parent_turn_id,
                    action_kind: turn.action_kind,
                    action_text: turn.action_text,
                    narrative: turn.narrative,
                    choices: decode(&turn.choices_json)?,
                    state,
                    created_at_ms: turn.created_at_ms,
                },
                n as u64 + 1,
                &origin,
            )?;
        }
        let scope = history_scope(context.view, ids);
        tx.commit()?;
        Ok(scope)
    }
    pub fn rebuild_memory_index_branch(
        &self,
        branch: &str,
        index: &mut MemoryIndex,
    ) -> Result<GameMemoryIndexReceipt, GameStoreError> {
        let context = self.read_branch_context(branch)?;
        let mut scope = None;
        let mut source_error = None;
        let receipt = index
            .rebuild_with_visitor(
                &context.view.setup.world_id,
                branch,
                context.view.head_turn_id.as_deref(),
                |emit| match self.visit_committed_turns_branch(branch, |turn, n, origin| {
                    emit(MemoryTurnInput::owned(turn, n, origin.into())).map_err(memory_store_error)
                }) {
                    Ok(s) if s.head_turn_id == context.view.head_turn_id => {
                        scope = Some(s);
                        Ok(())
                    }
                    Ok(_) => {
                        source_error = Some(GameStoreError::StaleHead);
                        Err(MemoryError::Database)
                    }
                    Err(e) => {
                        source_error = Some(e);
                        Err(MemoryError::Database)
                    }
                },
            )
            .map_err(|e| source_error.unwrap_or_else(|| memory_store_error(e)))?;
        Ok(GameMemoryIndexReceipt {
            scope: scope.ok_or(GameStoreError::Database)?,
            index: receipt,
        })
    }
}

fn fork_in_transaction(
    tx: &rusqlite::Transaction<'_>,
    r: &ForkBranchRequest,
    watermark: u64,
    research_watermark: u64,
) -> Result<BranchCreated, GameStoreError> {
    let edit = BranchEditRequest {
        world_id: r.world_id.clone(),
        branch_id: r.source_branch_id.clone(),
        expected_head_turn_id: r.expected_head_turn_id.clone(),
        expected_revision: r.expected_revision,
        operation_id: r.operation_id.clone(),
    };
    let source = check_edit(tx, &edit)?;
    if source.archived {
        return Err(GameStoreError::InvalidRequest);
    }
    let context = read_context(tx, &r.source_branch_id)?;
    let fork_count = match &r.fork_turn_id {
        Some(id) => context
            .history
            .turn_position(id)
            .ok_or(GameStoreError::InvalidRequest)?,
        None => 0,
    };
    if tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM game_branches WHERE branch_id=?1)",
        [&r.new_branch_id],
        |r| r.get::<_, bool>(0),
    )? {
        return Err(GameStoreError::Duplicate);
    }
    let timestamp = now_ms()?;
    // Old policy has no historical revisions; fork uses the explicitly
    // visible source policy. This does not claim old-node reconstruction.
    tx.execute("INSERT INTO game_branches(branch_id,parent_branch_id,fork_turn_id,fork_count,head_turn_id,turn_count,name,archived,revision,annotation_watermark,created_at_ms,narrative_policy) VALUES(?1,?2,?3,?4,?3,?4,?5,0,0,?6,?7,?8)",params![r.new_branch_id,r.source_branch_id,r.fork_turn_id,signed(fork_count)?,r.name,signed(watermark)?,timestamp,context.view.narrative_policy])?;
    tx.execute("INSERT INTO game_branch_controls(operation_id,branch_id,kind,created_at_ms) VALUES(?1,?2,'fork',?3)",params![r.operation_id,r.new_branch_id,timestamp])?;
    tx.execute(
        "INSERT INTO game_branch_watermarks(branch_id,domain,watermark) VALUES(?1,'research',?2)",
        params![r.new_branch_id, signed(research_watermark)?],
    )?;
    let view = read_context(tx, &r.new_branch_id)?.view;
    let branch = card(tx, &r.new_branch_id)?;
    Ok(BranchCreated {
        branch,
        world: view,
        original_action: None,
    })
}

const BRANCH_SCHEMA:&str="
CREATE TABLE game_branches(branch_id TEXT PRIMARY KEY,parent_branch_id TEXT REFERENCES game_branches(branch_id),fork_turn_id TEXT REFERENCES game_turns(turn_id),fork_count INTEGER NOT NULL CHECK(fork_count>=0),head_turn_id TEXT REFERENCES game_turns(turn_id),turn_count INTEGER NOT NULL CHECK(turn_count>=fork_count),name TEXT NOT NULL,archived INTEGER NOT NULL CHECK(archived IN (0,1)),revision INTEGER NOT NULL CHECK(revision>=0),annotation_watermark INTEGER NOT NULL CHECK(annotation_watermark>=0),created_at_ms INTEGER NOT NULL,narrative_policy TEXT NOT NULL);
CREATE TABLE game_turn_origins(turn_id TEXT PRIMARY KEY REFERENCES game_turns(turn_id),branch_id TEXT NOT NULL REFERENCES game_branches(branch_id),path_sequence INTEGER NOT NULL CHECK(path_sequence>0),UNIQUE(branch_id,path_sequence));
CREATE TABLE game_operation_branches(operation_id TEXT PRIMARY KEY REFERENCES game_operations(operation_id),branch_id TEXT NOT NULL REFERENCES game_branches(branch_id));
CREATE TABLE game_branch_controls(operation_id TEXT PRIMARY KEY,branch_id TEXT NOT NULL REFERENCES game_branches(branch_id),kind TEXT NOT NULL,created_at_ms INTEGER NOT NULL);
CREATE TABLE game_branch_migrations(receipt TEXT NOT NULL);
CREATE TABLE game_branch_watermarks(branch_id TEXT NOT NULL REFERENCES game_branches(branch_id),domain TEXT NOT NULL,watermark INTEGER NOT NULL CHECK(watermark>=0),PRIMARY KEY(branch_id,domain));
CREATE TABLE game_operation_sources(operation_id TEXT NOT NULL REFERENCES game_operations(operation_id),source_id TEXT NOT NULL,PRIMARY KEY(operation_id,source_id));
CREATE TRIGGER game_branch_parent_immutable BEFORE UPDATE OF branch_id,parent_branch_id,fork_turn_id,fork_count,annotation_watermark,created_at_ms ON game_branches BEGIN SELECT RAISE(ABORT,'immutable branch origin'); END;
CREATE TRIGGER game_branch_no_delete BEFORE DELETE ON game_branches BEGIN SELECT RAISE(ABORT,'archive branch'); END;
CREATE TRIGGER game_turn_origin_no_update BEFORE UPDATE ON game_turn_origins BEGIN SELECT RAISE(ABORT,'immutable turn origin'); END;
CREATE TRIGGER game_turn_origin_no_delete BEFORE DELETE ON game_turn_origins BEGIN SELECT RAISE(ABORT,'immutable turn origin'); END;
CREATE TRIGGER game_operation_branch_no_update BEFORE UPDATE ON game_operation_branches BEGIN SELECT RAISE(ABORT,'immutable operation branch'); END;
CREATE TRIGGER game_operation_branch_no_delete BEFORE DELETE ON game_operation_branches BEGIN SELECT RAISE(ABORT,'immutable operation branch'); END;
CREATE TRIGGER game_branch_watermark_no_update BEFORE UPDATE ON game_branch_watermarks BEGIN SELECT RAISE(ABORT,'immutable branch watermark'); END;
CREATE TRIGGER game_branch_watermark_no_delete BEFORE DELETE ON game_branch_watermarks BEGIN SELECT RAISE(ABORT,'immutable branch watermark'); END;
CREATE TRIGGER game_operation_source_insert_guard BEFORE INSERT ON game_operation_sources WHEN (SELECT status FROM game_operations WHERE operation_id=NEW.operation_id)!='generating' BEGIN SELECT RAISE(ABORT,'source registration closed'); END;
CREATE TRIGGER game_operation_source_no_update BEFORE UPDATE ON game_operation_sources BEGIN SELECT RAISE(ABORT,'immutable allowed source'); END;
CREATE TRIGGER game_operation_source_no_delete BEFORE DELETE ON game_operation_sources BEGIN SELECT RAISE(ABORT,'immutable allowed source'); END;
";
