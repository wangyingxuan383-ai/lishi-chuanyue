//! Pure v2 demo and prompt compilation. No configuration, Key, transport, SQL,
//! retries or model invocation lives here. Native callers retain the existing
//! one-attempt production transport and 30/30/90 second cancellation budgets.

use std::collections::{BTreeMap, BTreeSet};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};

use crate::game_knowledge::{
    initial_visible_grants, minimal_actor_fact_json, SourceVisibilityIndex, ValidatedHistory,
};
use crate::game_protocol::{EntityKind, GameError, GameResult};
use crate::game_protocol_v2::{
    apply_output_v2, validate_state_v2, AliasKind, CommitContext, ConditionCategory,
    ConditionInput, Disclosure, EntityInput, EventInput, FactKey, StateChangeV2, StateSource,
    TimeAdvanceV2, TurnOutputV2, WorldStateV2,
};
use crate::game_provider::{initial_choices, ProviderError};
use crate::game_store::{GameActionKind, GameTurnRequest};
use crate::game_store_v2::{valid_game_id, WorldViewV2};

pub const GAME_PROMPT_VERSION_V2: u32 = 8;
// Legacy pure helper only. Production uses the saved ContextBudget through game_context.
pub const MAX_GAME_PROMPT_BYTES_V2: usize = 16 * 1024;
const DEMO_INJURY: &str = "需要休息的伤病（演示设定）";

fn operation_suffix(operation_id: &str) -> String {
    Sha256::digest(operation_id.as_bytes())[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

/// Fixed, local rules with formal inventory, provenance and visible facts.
/// The complete output is validated privately before the caller can persist it.
pub fn demo_output_v2(state: &WorldStateV2, request: &GameTurnRequest) -> GameResult<TurnOutputV2> {
    validate_state_v2(state)?;
    if !valid_game_id(&request.operation_id) || !valid_game_id(&request.world_id) {
        return Err(GameError::InvalidReference);
    }
    let player = state
        .entities
        .iter()
        .find(|entity| entity.id == state.protagonist_id)
        .ok_or(GameError::InvalidReference)?;
    if player.alive != Some(true) {
        return Err(GameError::InvalidEntity);
    }
    if request.action_text.len() > crate::game_store_v2::MAX_ACTION_BYTES
        || request
            .action_text
            .chars()
            .any(|c| c.is_control() && !matches!(c, '\n' | '\r' | '\t'))
        || (request.action_kind == GameActionKind::Continue && !request.action_text.is_empty())
    {
        return Err(GameError::InvalidOutput);
    }
    let action = if request.action_kind == GameActionKind::Continue {
        "继续观察周围"
    } else {
        request.action_text.as_str()
    };
    if action.trim().is_empty() {
        return Err(GameError::InvalidOutput);
    }
    let suffix = operation_suffix(&request.operation_id);
    let event_id = format!("event-{suffix}");
    let cash = state
        .resources
        .iter()
        .find(|resource| resource.owner_id == state.protagonist_id && resource.key == "cash");
    let unit = cash.map_or("记账单位", |resource| resource.unit.as_str());
    let mut changes = Vec::new();
    let mut visible = BTreeSet::from([
        FactKey::EntityCreated {
            entity_id: state.protagonist_id.clone(),
        },
        FactKey::EntityName {
            entity_id: state.protagonist_id.clone(),
        },
        FactKey::EntityLife {
            entity_id: state.protagonist_id.clone(),
        },
        FactKey::EntityCreated {
            entity_id: state.location_id.clone(),
        },
        FactKey::EntityName {
            entity_id: state.location_id.clone(),
        },
        FactKey::Time,
        FactKey::Location,
    ]);
    let mut subjects = BTreeSet::from([state.protagonist_id.clone(), state.location_id.clone()]);
    let mut elapsed = 3600;
    let consequence = if action.contains("购买") || action.contains("买") {
        if cash.is_some_and(|resource| resource.amount >= 5) {
            let item_id = format!("item-{suffix}");
            let name = if action.contains("口粮") {
                "口粮"
            } else {
                "补给"
            };
            subjects.insert(item_id.clone());
            changes.push(StateChangeV2::ChangeResource {
                owner_id: state.protagonist_id.clone(),
                key: "cash".into(),
                unit: unit.into(),
                delta: -5,
                expected_amount: cash.map(|resource| resource.amount),
                event_id: event_id.clone(),
            });
            changes.push(StateChangeV2::CreateEntity {
                entity: EntityInput {
                    id: item_id.clone(),
                    kind: EntityKind::Item,
                    name: name.into(),
                    alive: None,
                    attributes: BTreeMap::new(),
                },
                event_id: event_id.clone(),
            });
            changes.push(StateChangeV2::SetItemHolding {
                item_id: item_id.clone(),
                expected_holding: None,
                holder_id: Some(state.protagonist_id.clone()),
                place_id: None,
                quantity: 1,
                unit: "份".into(),
                event_id: event_id.clone(),
            });
            visible.extend([
                FactKey::EntityCreated {
                    entity_id: item_id.clone(),
                },
                FactKey::EntityName {
                    entity_id: item_id.clone(),
                },
                FactKey::ItemHolding { item_id },
            ]);
            format!("支付5{unit}，得到1份{name}。")
        } else {
            "资金不足，购买没有发生，随身物品不变。".into()
        }
    } else if action.contains("短工") || action.contains("赚钱") || action.contains("工作") {
        changes.push(StateChangeV2::ChangeResource {
            owner_id: state.protagonist_id.clone(),
            key: "cash".into(),
            unit: unit.into(),
            delta: 10,
            expected_amount: cash.map(|resource| resource.amount),
            event_id: event_id.clone(),
        });
        visible.insert(FactKey::Resource {
            owner_id: state.protagonist_id.clone(),
            key: "cash".into(),
        });
        elapsed = 7200;
        format!("两小时短工，获得10{unit}。")
    } else if let Some(new_name) = action
        .strip_prefix("改名为")
        .or_else(|| action.strip_prefix("改名："))
    {
        let new_name = new_name.trim();
        changes.push(StateChangeV2::RenameEntity {
            entity_id: state.protagonist_id.clone(),
            expected_name: player.name.clone(),
            new_name: new_name.into(),
            event_id: event_id.clone(),
        });
        visible.insert(FactKey::EntityAlias {
            entity_id: state.protagonist_id.clone(),
            text: player.name.clone(),
        });
        format!("你决定以后使用“{new_name}”这个名字，旧称仍能指向同一个人。")
    } else if let Some(alias) = action
        .strip_prefix("增加别名：")
        .or_else(|| action.strip_prefix("别名："))
    {
        let alias = alias.trim();
        changes.push(StateChangeV2::AddAlias {
            entity_id: state.protagonist_id.clone(),
            text: alias.into(),
            kind: AliasKind::Nickname,
            event_id: event_id.clone(),
        });
        visible.insert(FactKey::EntityAlias {
            entity_id: state.protagonist_id.clone(),
            text: alias.into(),
        });
        format!("你采用“{alias}”作为别名，身份与正式姓名保持。")
    } else if action.contains("受伤") {
        let condition_id = format!("injury-{suffix}");
        changes.push(StateChangeV2::AddCondition {
            condition: ConditionInput {
                id: condition_id.clone(),
                entity_id: state.protagonist_id.clone(),
                description: DEMO_INJURY.into(),
                category: ConditionCategory::Injury,
                active: true,
            },
            event_id: event_id.clone(),
        });
        visible.insert(FactKey::Condition { condition_id });
        "一次意外造成伤病，持续状态已记录。".into()
    } else if action.contains("休息") {
        for condition in state.conditions.iter().filter(|condition| {
            condition.entity_id == state.protagonist_id
                && condition.active
                && condition.description == DEMO_INJURY
                && matches!(
                    condition.category,
                    ConditionCategory::Injury
                        | ConditionCategory::Illness
                        | ConditionCategory::LegacyUnspecified
                )
        }) {
            changes.push(StateChangeV2::ResolveCondition {
                condition_id: condition.id.clone(),
                event_id: event_id.clone(),
            });
            visible.insert(FactKey::Condition {
                condition_id: condition.id.clone(),
            });
        }
        elapsed = 7200;
        "休息两小时，固定演示伤病解决；债务不变。".into()
    } else if action.contains("死亡") {
        changes.push(StateChangeV2::SetLifeStatus {
            entity_id: state.protagonist_id.clone(),
            alive: false,
            event_id: event_id.clone(),
        });
        "本段人生在这里结束，已发生的剧情与状态保留。".into()
    } else {
        "生活推进，你留意交谈与动静。".into()
    };
    if cash.is_some() {
        visible.insert(FactKey::Resource {
            owner_id: state.protagonist_id.clone(),
            key: "cash".into(),
        });
    }
    for fact_key in visible {
        changes.push(StateChangeV2::ObserveFact {
            actor_id: state.protagonist_id.clone(),
            fact_key,
            event_id: event_id.clone(),
        });
    }
    let output = TurnOutputV2 {
        protocol_version: 2,
        narrative: format!(
            "{}尝试：{action}。\n{consequence}\n你查看自己的状态、随身资金和周围位置。",
            player.name
        ),
        choices: initial_choices(),
        time_advance: TimeAdvanceV2 {
            elapsed_seconds: elapsed,
            event_id: Some(event_id.clone()),
        },
        state_changes: changes,
        events: vec![EventInput {
            id: event_id,
            description: consequence,
            entity_ids: subjects.into_iter().collect(),
            disclosure: Disclosure::Restricted,
        }],
        source_references: Vec::new(),
        uncertainties: vec![
            "当前是固定规则演示，不代表AI推演或经过考证的史实；补给与休息是游戏规则。".into(),
        ],
    };
    apply_output_v2(
        state,
        &output,
        &CommitContext {
            operation_id: request.operation_id.clone(),
            turn_id: request.operation_id.clone(),
        },
    )?;
    Ok(output)
}

// Column arrays reduce repeated keys, not the set of included formal values.
pub fn compact_narrator_facts_v2(state: &WorldStateV2) -> Result<String, ProviderError> {
    validate_state_v2(state).map_err(|_| ProviderError::Database)?;
    let json = json!({
        "t":[state.time.era_year,state.time.precision,state.time.elapsed_seconds],"p":state.protagonist_id,"l":state.location_id,
        "e":state.entities.iter().map(|e|json!([e.id,e.kind,e.name,e.alive,e.attributes,e.aliases.iter().map(|alias|json!([alias.text,alias.kind])).collect::<Vec<_>>()])).collect::<Vec<_>>(),
        "r":state.resources.iter().map(|r|json!([r.owner_id,r.key,r.unit,r.amount])).collect::<Vec<_>>(),
        "rel":state.relationships.iter().map(|r|json!([r.from_id,r.to_id,r.kind,r.strength])).collect::<Vec<_>>(),
        "h":state.item_holdings.iter().map(|h|json!([h.item_id,h.value.status,h.value.holder_id,h.value.place_id,h.value.quantity,h.value.unit])).collect::<Vec<_>>(),
        "c":state.conditions.iter().map(|c|json!([c.id,c.entity_id,c.description,c.category,c.active])).collect::<Vec<_>>(),
        "ev":state.events.iter().map(|e|json!([e.id,e.description,e.entity_ids,e.disclosure])).collect::<Vec<_>>(),
        "cl":state.claims.iter().map(|c|json!([c.id,c.text,c.entity_ids,c.assessment,c.evidence_event_ids])).collect::<Vec<_>>(),
        "legacyAttributes":state.entities.iter().flat_map(|e|e.attribute_sources.iter().filter(|(_,source)|matches!(source,StateSource::LegacySnapshot { .. })).map(|(key,_)|json!([e.id,key]))).collect::<Vec<_>>()
    });
    serde_json::to_string(&json).map_err(|_| ProviderError::Database)
}

fn compact_fact_key(key: &Value) -> Value {
    match key["type"].as_str().unwrap_or("") {
        "entity_created" => json!(["entity", key["entityId"]]),
        "entity_name" => json!(["name", key["entityId"]]),
        "entity_life" => json!(["life", key["entityId"]]),
        "entity_attribute" => json!(["attribute", key["entityId"], key["key"]]),
        "entity_alias" => json!(["alias", key["entityId"], key["text"]]),
        "item_holding" => json!(["holding", key["itemId"]]),
        "condition" => json!(["condition", key["conditionId"]]),
        "resource" => json!(["resource", key["ownerId"], key["key"]]),
        "relationship" => json!(["relationship", key["fromId"], key["toId"], key["kind"]]),
        "event" => json!(["event", key["eventId"]]),
        "claim" => json!(["claim", key["claimId"]]),
        "time" => json!(["time"]),
        "location" => json!(["location"]),
        _ => key.clone(),
    }
}

// Keep every value in the actor DTO. IDs already present in the fact key need
// not be repeated in its value; column arrays remove only structural verbosity.
fn compact_fact_value(key: &Value, value: &Value) -> Value {
    match key["type"].as_str().unwrap_or("") {
        "entity_created" => json!([value["kind"]]),
        "entity_alias" => json!([value["kind"]]),
        "item_holding" => json!([
            value["status"],
            value["holderId"],
            value["placeId"],
            value["quantity"],
            value["unit"]
        ]),
        "condition" => json!([
            value["entityId"],
            value["description"],
            value["category"],
            value["active"]
        ]),
        "resource" => json!([value["unit"], value["amount"]]),
        "relationship" => json!([value["strength"]]),
        "event" => json!([
            value["description"],
            value["entityIds"],
            value["disclosure"]
        ]),
        "claim" => json!([
            value["text"],
            value["entityIds"],
            value["assessment"],
            value["evidenceEventIds"]
        ]),
        "time" => json!([
            value["eraYear"],
            value["precision"],
            value["elapsedSeconds"]
        ]),
        _ => value.clone(),
    }
}

pub fn compact_actor_facts_v2(history: &ValidatedHistory) -> Result<String, ProviderError> {
    let grants = initial_visible_grants(history, &history.current_state().protagonist_id)
        .map_err(|_| ProviderError::Database)?;
    let index = SourceVisibilityIndex::from_recorded_observations(history, grants)
        .map_err(|_| ProviderError::Database)?;
    let mut actors = BTreeMap::new();
    for actor in history
        .current_state()
        .entities
        .iter()
        .filter(|entity| entity.kind == EntityKind::Person)
    {
        let raw = minimal_actor_fact_json(history, &index, &actor.id, usize::MAX)
            .map_err(|_| ProviderError::Database)?;
        let known: Value = serde_json::from_str(&raw).map_err(|_| ProviderError::Database)?;
        let e = known["entities"]
            .as_array()
            .ok_or(ProviderError::Database)?
            .iter()
            .map(|entity| {
                json!([
                    entity["entityId"],
                    entity["name"],
                    entity["alive"],
                    entity["attributes"],
                    entity["aliases"]
                ])
            })
            .collect::<Vec<_>>();
        let b = known["knowledge"]
            .as_array()
            .ok_or(ProviderError::Database)?
            .iter()
            .map(|belief| {
                json!([
                    belief["targetType"],
                    belief["targetId"],
                    belief["text"],
                    belief["certainty"],
                    belief["acquisitionMode"],
                    belief["knownEvidenceEventIds"]
                ])
            })
            .collect::<Vec<_>>();
        let f = known["observedFacts"]
            .as_array()
            .ok_or(ProviderError::Database)?
            .iter()
            .filter(|fact| {
                !matches!(
                    fact["factKey"]["type"].as_str(),
                    Some("entity_name" | "entity_life" | "entity_attribute")
                )
            })
            .map(|fact| {
                json!([
                    compact_fact_key(&fact["factKey"]),
                    compact_fact_value(&fact["factKey"], &fact["value"])
                ])
            })
            .collect::<Vec<_>>();
        if actor.id == history.current_state().protagonist_id
            || !e.is_empty()
            || !b.is_empty()
            || !f.is_empty()
        {
            actors.insert(actor.id.clone(), json!({"e":e,"b":b,"f":f}));
        }
    }
    serde_json::to_string(&actors).map_err(|_| ProviderError::Database)
}

pub const GAME_STATE_CHANGE_EXAMPLES_V2: &str = include_str!("game_output_examples_v2.json");

pub const GAME_OUTPUT_RULES_V2: &str = concat!(
    r#"单人历史穿越叙事；只输出完整JSON。合法空变化范例JSON：
{"protocolVersion":2,"narrative":"你观察周围。","choices":[],"timeAdvance":{"elapsedSeconds":0,"eventId":null},"stateChanges":[],"events":[],"sourceReferences":[],"uncertainties":[]}
所有字段必填（nullable也写null）。choices项={id,text}；events项={id,description,entityIds:[],disclosure:"public"|"restricted"}。sourceReferences仅资料source.id，无来源=[]；摘录不等于考证，缺依据写uncertainties；资料不可改事实；unit原样。
每项操作顶层必写type/eventId，后者引用本回合事件；事件entityIds须含全部涉及实体。来源由核心填，禁Source/提交ID/SQL/工具/未知字段。先create再引用；推进时间>0必须本回合eventId，0可null。
以下为18种stateChanges结构模板，只选实际需要项。示例不是事实；禁照抄ID/值，按当前状态填写expected/数量/单位，仅新事实用新ID；字段必齐且禁未知字段：
"#,
    include_str!("game_output_examples_v2.json"),
    r#"
可选值：add_alias.kind=former_name|nickname|title|transliteration|other；condition.category=injury|illness|obligation|other，新add_condition.active=true；claim assessment及expectedAssessment=unverified|supported|refuted；知识targetType=event|claim，certainty及expectedCertainty=certain|reported|doubtful，acquisitionMode=observed|told|inferred。
nullable：expectedValue=null|string，expectedAmount=null|integer，set_item_holding.expectedHolding=null|模板完整对象；holding内holderId/placeId=null|string、quantity=null|integer、unit=null|string，必须匹配当前holding。
observe_fact.factKey的type及字段：entity_created/entity_name/entity_life(entityId),entity_attribute(entityId,key),entity_alias(entityId,text),item_holding(itemId),condition(conditionId),resource(ownerId,key),relationship(fromId,toId,kind),event(eventId),claim(claimId),time/location(无其他字段)。明确获知当前事实才observe，所有修改先于observe；知情事件不会自动授予其他事实。
ID=1~64ASCII字母数字_-；kind=person/place/organization/item，person.alive bool其余null；attributes值string，禁核心键/Source/aliases及物品ownerId/holderId/placeId/quantity/unit旁路。expected值需精确匹配，null仅不存在；holding status=known|legacy_unknown，数量>0 holder/place二选一，0两者null；转交不改数量单位，耗尽不补货，新购新ID。整数≤9007199254740991；资源非负/死者不复活/关系-100~100且不同实体。事件/claim描述≤2048 UTF8字节；supported/refuted需证据，assess保留旧证据增加证据。event知识证据空；claim知识证据仅其证据子集。持续状态须显式更新/解决，时间流逝不自动治愈/消债/履约。≤128操作/32事件/6选项，不替玩家选未来。
set_item_holding首次登记新物品时expectedHolding:null；已有known holding只转交/放下/取回，数量和unit不变。吃掉/耗用必须change_item_quantity(delta负数)，0时核心自动清空holder/place；禁用set_item_holding减数量。正文放下/取回/消耗必须同步h，不能只写叙事。
只做指定范围，“先做一段”不做完整趟/结账；重大决定暂停，已付报酬不重发。
时间：一时辰=7200秒，半时辰=3600秒；正文/事件时长须与elapsedSeconds一致。十分钟勿写一刻；历史时长不确定用分钟。
分区：叙事者事实用于推演；角色已知才是角色言行依据，未列角色=未知。禁全局秘密/claim判断自动变角色知识；认知可保留旧值；世界外方针非主角行动。
列式JSON叙事者：t=[纪年,精度,经过秒],p主角,l地点,e=[id,kind,name,alive,attrs,[[alias,kind]]],r=[owner,key,unit,amount],rel=[from,to,kind,strength],h=[item,status,holder,place,quantity,unit],c=[id,entity,description,category,active],ev=[id,description,entityIds,disclosure],cl=[id,text,entityIds,assessment,evidenceIds]；legacyAttributes只标旧字符串不能代替h。
角色键actorId：e=[id,已知name|null,已知alive|null,attrs,aliases],b=[targetType,targetId,text,自己的certainty,acquisitionMode,evidenceIds],f=[key,value]。key为[type简写,原ID依次]；值entity/alias=[kind],holding=[status,holder,place,quantity,unit],condition=[entity,description,category,active],resource=[unit,amount],relationship=[strength],event=[description,entityIds,disclosure],claim=[text,entityIds,assessment,evidenceIds],time=[纪年,精度,经过秒],location=地点ID。name/life/attribute已在角色e。
"#
);

pub fn compile_game_prompt_v2(
    view: &WorldViewV2,
    request: &GameTurnRequest,
    history: &ValidatedHistory,
) -> Result<String, ProviderError> {
    if request.world_id != view.setup.world_id
        || history.world_id() != view.setup.world_id
        || request.branch_id != view.branch_id
        || request.expected_head_turn_id != view.head_turn_id
        || history.head_turn_id() != view.head_turn_id.as_deref()
        || history.turn_count() != view.turn_count
        || history.current_state() != &view.state
    {
        return Err(ProviderError::Stale);
    }
    validate_state_v2(&view.state).map_err(|_| ProviderError::Database)?;
    let narrator = compact_narrator_facts_v2(&view.state)?;
    let actors = compact_actor_facts_v2(history)?;
    let setup = serde_json::to_string(&view.setup).map_err(|_| ProviderError::Database)?;
    let policy =
        serde_json::to_string(&view.narrative_policy).map_err(|_| ProviderError::Database)?;
    let action =
        serde_json::to_string(&json!({"kind":request.action_kind,"text":request.action_text}))
            .map_err(|_| ProviderError::Database)?;
    let mut prompt=format!("promptVersion={GAME_PROMPT_VERSION_V2}\n{GAME_OUTPUT_RULES_V2}\n开局设置JSON：{setup}\n世界外方针JSON：{policy}\n叙事者事实JSON：{narrator}\n角色已知JSON：{actors}\n");
    let tail = format!("当前行动JSON：{action}\n");
    if prompt.len().saturating_add(tail.len()) > MAX_GAME_PROMPT_BYTES_V2 {
        return Err(ProviderError::ContextTooLarge);
    }
    for turn in view.turns.iter().rev().take(4).rev() {
        let narrative = turn.narrative.chars().take(200).collect::<String>();
        let recent = format!(
            "近期已提交剧情JSON：{}\n",
            serde_json::to_string(&narrative).map_err(|_| ProviderError::Database)?
        );
        if prompt
            .len()
            .saturating_add(recent.len())
            .saturating_add(tail.len())
            <= MAX_GAME_PROMPT_BYTES_V2
        {
            prompt.push_str(&recent);
        }
    }
    prompt.push_str(&tail);
    Ok(prompt)
}
