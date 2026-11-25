//! SQLite persistence for Companion ("伴聊") personas, sessions, tree messages,
//! and dual-layer memories (R33-T001, D187).
//!
//! INVARIANT: `initialize()` only creates tables/indexes and NEVER inserts
//! built-in persona rows so `SqlStore::is_empty()` remains true on first launch.

use crate::{Error, Result, Store};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Transaction, TransactionBehavior};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};

pub const DEFAULT_PERSONA_ID: &str = "builtin:lingxi";
pub const MEMORY_PROMPT_CHAR_CAP: usize = 1200;
const BUILTIN_EPOCH: &str = "2026-01-01T00:00:00Z";

#[derive(Clone)]
pub struct CompanionStore(pub Store);

struct BuiltinDef {
    id: &'static str,
    name: &'static str,
    avatar: &'static str,
    tagline: &'static str,
    role_kind: &'static str,
    system_prompt: &'static str,
    greeting: &'static str,
    starters: &'static [&'static str],
    style_notes: &'static str,
    memory_scope: &'static str,
    pure_roleplay: bool,
    sort_order: i64,
}

const BUILTINS: &[BuiltinDef] = &[
    BuiltinDef {
        id: "builtin:lingxi",
        name: "灵犀",
        avatar: "灵",
        tagline: "温润通透的随身伴读，闲聊、构思、查证皆宜",
        role_kind: "assistant",
        system_prompt: "你是「灵犀」，一位温润通透、敏锐体贴的随身伴读与创作伙伴。无论是日常闲谈、推演历史与奇幻设定、梳理人物动机，还是解答疑问，都请用自然平实的中文交流：有主见而不强加于人，言之有物而不堆砌空泛套话。需要分条时清晰克制，适合畅谈时如熟友对坐。",
        greeting: "我在。想随便聊聊、盘一盘新故事的点子，还是查点原著与史料？",
        starters: &[
            "帮我想一个反套路的历史穿越开局",
            "陪我聊聊最近在读的小说设定",
            "帮我推演一个两难处境下的破局办法",
        ],
        style_notes: "自然平实、敏锐体贴，像熟识的书友，不端架子也不堆砌套话。",
        memory_scope: "persona",
        pure_roleplay: false,
        sort_order: 10,
    },
    BuiltinDef {
        id: "builtin:editor",
        name: "青灯编修",
        avatar: "编",
        tagline: "老辣克制的故事策划，专治卡文、人设扁平与逻辑暗伤",
        role_kind: "advisor",
        system_prompt: "你是「青灯编修」，一位经验老辣、审美克制的互动小说策划与剧情医生。你擅长从人物利益冲突、代价约束、时代肌理与场面调度出发，帮作者诊断开局钩子、中盘节奏、人设弧光与逻辑暗伤。少说空泛夸奖，直指关键问题，并给出两到三种有区分度、能直接落笔的具体桥段方案。",
        greeting: "稿子或大纲拿来看看？不管是开局没钩子、中盘泄气，还是人物立不住，我们一处一处拆。",
        starters: &[
            "帮我诊断一下这段开局为什么不够抓人",
            "主角和对手的利益冲突怎么立得更扎实？",
            "给我三个不落俗套的剧情转折方案",
        ],
        style_notes: "直指要害、重因果与人物动机，少空泛夸奖，多给可落地的改法与具体桥段。",
        memory_scope: "persona",
        pure_roleplay: false,
        sort_order: 20,
    },
    BuiltinDef {
        id: "builtin:scholar",
        name: "兰台考据",
        avatar: "考",
        tagline: "严谨求实的史料与原著考据官，有几分证据说几分话",
        role_kind: "advisor",
        system_prompt: "你是「兰台考据」，一位严谨求实又通晓叙事落地的史料与原著考据顾问。回答朝代制度、衣食住行、称谓物价、地理沿革或原著细节时，严格区分「确凿史实/原文依据」与「合理文学推演」；拿不准或资料未覆盖之处坦诚说明，绝不凭印象捏造引文或章回。",
        greeting: "请讲。无论是朝代官制、名物称谓、风俗物价，还是核对书中细节，我都会分清依据与推演。",
        starters: &[
            "唐天宝年间在长安住店吃饭怎么付钱？",
            "帮我考证一下这个身份在当时的日常起居与规矩",
            "核对原著里这段人物关系的来龙去脉",
        ],
        style_notes: "条理分明、重出处、知之为知之；史实、原著与文学推演严格区分，绝不编造引文。",
        memory_scope: "persona",
        pure_roleplay: false,
        sort_order: 30,
    },
    BuiltinDef {
        id: "builtin:tavern",
        name: "夜雨茶寮·陆掌柜",
        avatar: "茶",
        tagline: "风雪夜归人歇脚的江湖茶寮，只谈风月与奇闻，不问来处",
        role_kind: "roleplay",
        system_prompt: "你是「陆掌柜」，在官道岔口经营一间夜雨茶寮已有二十余年。你见过赶考举子、落魄刀客、微服贵人与异乡过客，眼毒心热却守口如瓶。请始终以陆掌柜第一人称与来客交谈，自然穿插拨炭、温茶、听雨等细微动作与神态描写，语气带着烟火气与江湖阅历。",
        greeting: "外头风硬，快进屋烤烤火。新焙的粗茶刚滚，客官今夜是想听段旧闻，还是心里藏着事没处说？",
        starters: &[
            "掌柜的，温一壶热茶，外面最近有什么风声？",
            "我刚从一场险局里脱身，借宝地歇口气。",
            "这茶寮开了多少年了？见过最奇的客人是谁？",
        ],
        style_notes: "纯角色扮演：以茶寮陆掌柜第一人称交谈，穿插温茶、拨炭等细微动作，绝不提及AI或模型。",
        memory_scope: "persona",
        pure_roleplay: true,
        sort_order: 40,
    },
];

fn normalize_persona_id(id: &str) -> &str {
    if id == "lingxi" {
        DEFAULT_PERSONA_ID
    } else {
        id
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn new_id() -> String {
    uuid::Uuid::new_v4().simple().to_string()
}

fn invalid(msg: impl Into<String>) -> Error {
    Error::Invalid(msg.into())
}

fn parse_json_or(raw: &str, fallback: Value) -> Value {
    serde_json::from_str(raw).unwrap_or(fallback)
}

fn table_exists(db: &Connection, name: &str) -> Result<bool> {
    Ok(db.query_row(
        "SELECT EXISTS(SELECT 1 FROM sqlite_master WHERE type='table' AND name=?1)",
        [name],
        |r| r.get(0),
    )?)
}

fn builtin_value(def: &BuiltinDef) -> Value {
    json!({
        "id": def.id,
        "name": def.name,
        "avatar": def.avatar,
        "tagline": def.tagline,
        "roleKind": def.role_kind,
        "systemPrompt": def.system_prompt,
        "greeting": def.greeting,
        "starters": def.starters,
        "styleNotes": def.style_notes,
        "memoryScope": def.memory_scope,
        "pureRoleplay": def.pure_roleplay,
        "sourceWorldId": Value::Null,
        "sourcePersonId": Value::Null,
        "sourceHeadId": Value::Null,
        "sortOrder": def.sort_order,
        "builtin": true,
        "customized": false,
        "metadata": {},
        "createdAt": BUILTIN_EPOCH,
        "updatedAt": BUILTIN_EPOCH,
    })
}

pub fn is_builtin_persona_id(id: &str) -> bool {
    BUILTINS.iter().any(|b| b.id == id)
}

fn read_persona_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let id: String = row.get(0)?;
    let builtin = is_builtin_persona_id(&id);
    let metadata = parse_json_or(&row.get::<_, String>(15)?, json!({}));
    let bound_line_id = metadata
        .get("boundLineId")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
        .map(str::to_owned);
    let mut out = json!({
        "id": id,
        "name": row.get::<_, String>(1)?,
        "avatar": row.get::<_, String>(2)?,
        "tagline": row.get::<_, String>(3)?,
        "roleKind": row.get::<_, String>(4)?,
        "systemPrompt": row.get::<_, String>(5)?,
        "greeting": row.get::<_, String>(6)?,
        "starters": parse_json_or(&row.get::<_, String>(7)?, json!([])),
        "styleNotes": row.get::<_, String>(8)?,
        "memoryScope": row.get::<_, String>(9)?,
        "pureRoleplay": row.get::<_, i64>(10)? != 0,
        "sourceWorldId": row.get::<_, Option<String>>(11)?,
        "sourcePersonId": row.get::<_, Option<String>>(12)?,
        "sourceHeadId": row.get::<_, Option<String>>(13)?,
        "sortOrder": row.get::<_, i64>(14)?,
        "builtin": builtin,
        "customized": builtin,
        "metadata": metadata,
        "createdAt": row.get::<_, String>(16)?,
        "updatedAt": row.get::<_, String>(17)?,
    });
    if let Some(lid) = bound_line_id {
        out["boundLineId"] = lid.into();
    }
    Ok(out)
}

fn read_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    let scope_raw: Option<String> = row.get(7)?;
    let book_scope = scope_raw
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| parse_json_or(s, Value::Null))
        .unwrap_or(Value::Null);
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "title": row.get::<_, String>(1)?,
        "personaId": row.get::<_, String>(2)?,
        "activeGear": row.get::<_, String>(3)?,
        "boundWorldId": row.get::<_, Option<String>>(4)?,
        "boundLineId": row.get::<_, Option<String>>(5)?,
        "boundBookId": row.get::<_, Option<String>>(6)?,
        "bookScope": book_scope,
        "piSessionId": row.get::<_, Option<String>>(8)?,
        "activeLeafId": row.get::<_, Option<String>>(9)?,
        "summaryText": row.get::<_, String>(10)?,
        "summaryUpToMsgId": row.get::<_, Option<String>>(11)?,
        "pinned": row.get::<_, i64>(12)? != 0,
        "archived": row.get::<_, i64>(13)? != 0,
        "legacyPi": false,
        "metadata": parse_json_or(&row.get::<_, String>(14)?, json!({})),
        "createdAt": row.get::<_, String>(15)?,
        "updatedAt": row.get::<_, String>(16)?,
    }))
}

#[derive(Clone)]
pub(crate) struct MessageRecord {
    pub id: String,
    pub parent_id: Option<String>,
    pub seq: i64,
    pub value: Value,
}

fn read_message_record(row: &rusqlite::Row<'_>) -> rusqlite::Result<MessageRecord> {
    let id: String = row.get(0)?;
    let parent_id: Option<String> = row.get(2)?;
    let seq: i64 = row.get(3)?;
    let usage_raw: Option<String> = row.get(13)?;
    let usage = usage_raw
        .as_deref()
        .filter(|s| !s.trim().is_empty())
        .map(|s| parse_json_or(s, Value::Null))
        .unwrap_or(Value::Null);
    let value = json!({
        "id": id,
        "sessionId": row.get::<_, String>(1)?,
        "parentId": parent_id,
        "seq": seq,
        "role": row.get::<_, String>(4)?,
        "gear": row.get::<_, String>(5)?,
        "status": row.get::<_, String>(6)?,
        "content": row.get::<_, String>(7)?,
        "thinking": row.get::<_, String>(8)?,
        "steps": parse_json_or(&row.get::<_, String>(9)?, json!([])),
        "citations": parse_json_or(&row.get::<_, String>(10)?, json!([])),
        "piTaskId": row.get::<_, Option<String>>(11)?,
        "modelId": row.get::<_, String>(12)?,
        "usage": usage,
        "errorText": row.get::<_, Option<String>>(14)?,
        "createdAt": row.get::<_, String>(15)?,
        "updatedAt": row.get::<_, String>(16)?,
    });
    Ok(MessageRecord {
        id,
        parent_id,
        seq,
        value,
    })
}

fn read_memory_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Value> {
    Ok(json!({
        "id": row.get::<_, String>(0)?,
        "scope": row.get::<_, String>(1)?,
        "personaId": row.get::<_, String>(2)?,
        "category": row.get::<_, String>(3)?,
        "content": row.get::<_, String>(4)?,
        "sourceSessionId": row.get::<_, Option<String>>(5)?,
        "sourceMessageId": row.get::<_, Option<String>>(6)?,
        "enabled": row.get::<_, i64>(7)? != 0,
        "pinned": row.get::<_, i64>(8)? != 0,
        "createdAt": row.get::<_, String>(9)?,
        "updatedAt": row.get::<_, String>(10)?,
    }))
}

pub(crate) fn ensure_schema_db(db: &Connection) -> Result<()> {
    db.execute_batch(include_str!("companion_schema.sql"))?;
    Ok(())
}

pub(crate) fn list_personas_db(db: &Connection) -> Result<Vec<Value>> {
    ensure_schema_db(db)?;
    let mut stmt = db.prepare(
        "SELECT id,name,avatar,tagline,role_kind,system_prompt,greeting,starters_json,style_notes,
                memory_scope,pure_roleplay,source_world_id,source_person_id,source_head_id,
                sort_order,metadata_json,created_at,updated_at
         FROM companion_personas
         ORDER BY sort_order ASC, updated_at DESC, id ASC",
    )?;
    let saved: Vec<Value> = stmt
        .query_map([], read_persona_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut overrides = HashMap::<String, Value>::new();
    let mut customs = Vec::<Value>::new();
    for item in saved {
        let id = item["id"].as_str().unwrap_or("").to_owned();
        if is_builtin_persona_id(&id) {
            overrides.insert(id, item);
        } else {
            customs.push(item);
        }
    }
    let mut out = Vec::with_capacity(BUILTINS.len() + customs.len());
    for def in BUILTINS {
        if let Some(custom) = overrides.remove(def.id) {
            out.push(custom);
        } else {
            out.push(builtin_value(def));
        }
    }
    out.extend(customs);
    out.sort_by(|a, b| {
        let sa = a["sortOrder"].as_i64().unwrap_or(100);
        let sb = b["sortOrder"].as_i64().unwrap_or(100);
        sa.cmp(&sb)
            .then_with(|| {
                b["builtin"]
                    .as_bool()
                    .unwrap_or(false)
                    .cmp(&a["builtin"].as_bool().unwrap_or(false))
            })
            .then_with(|| {
                b["updatedAt"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(a["updatedAt"].as_str().unwrap_or(""))
            })
            .then_with(|| {
                a["id"]
                    .as_str()
                    .unwrap_or("")
                    .cmp(b["id"].as_str().unwrap_or(""))
            })
    });
    Ok(out)
}

pub(crate) fn get_persona_db(db: &Connection, raw_id: &str) -> Result<Option<Value>> {
    ensure_schema_db(db)?;
    let id = normalize_persona_id(raw_id);
    let saved = db
        .query_row(
            "SELECT id,name,avatar,tagline,role_kind,system_prompt,greeting,starters_json,style_notes,
                    memory_scope,pure_roleplay,source_world_id,source_person_id,source_head_id,
                    sort_order,metadata_json,created_at,updated_at
             FROM companion_personas WHERE id=?1",
            [id],
            read_persona_row,
        )
        .optional()?;
    if saved.is_some() {
        return Ok(saved);
    }
    Ok(BUILTINS.iter().find(|b| b.id == id).map(builtin_value))
}

pub(crate) fn resolve_persona_db(
    db: &Connection,
    raw_id: &str,
    snapshot: Option<&Value>,
) -> Result<Value> {
    let id = normalize_persona_id(raw_id);
    if let Some(found) = get_persona_db(db, id)? {
        return Ok(found);
    }
    if let Some(snap) = snapshot.filter(|v| v.is_object() && v["name"].is_string()) {
        return Ok(json!({
            "id": id,
            "name": snap["name"].as_str().unwrap_or("已删除人格"),
            "avatar": snap["avatar"].as_str().unwrap_or("伴"),
            "tagline": snap["tagline"].as_str().unwrap_or(""),
            "roleKind": snap["roleKind"].as_str().unwrap_or("assistant"),
            "systemPrompt": snap["systemPrompt"].as_str().unwrap_or("请自然友好地与用户对话。"),
            "greeting": "",
            "starters": [],
            "styleNotes": snap["styleNotes"].as_str().unwrap_or(""),
            "memoryScope": snap["memoryScope"].as_str().unwrap_or("persona"),
            "pureRoleplay": snap["pureRoleplay"].as_bool().unwrap_or(false),
            "sourceWorldId": Value::Null,
            "sourcePersonId": Value::Null,
            "sourceHeadId": Value::Null,
            "sortOrder": 999,
            "builtin": false,
            "customized": false,
            "metadata": {},
            "createdAt": BUILTIN_EPOCH,
            "updatedAt": BUILTIN_EPOCH,
        }));
    }
    Ok(builtin_value(&BUILTINS[0]))
}

fn persona_snapshot(persona: &Value) -> Value {
    json!({
        "name": persona["name"],
        "avatar": persona["avatar"],
        "tagline": persona["tagline"],
        "roleKind": persona["roleKind"],
        "systemPrompt": persona["systemPrompt"],
        "styleNotes": persona["styleNotes"],
        "memoryScope": persona["memoryScope"],
        "pureRoleplay": persona["pureRoleplay"],
    })
}

pub(crate) fn active_memories_for_persona_db(
    db: &Connection,
    raw_persona_id: &str,
    memory_scope: &str,
    char_cap: usize,
) -> Result<Vec<Value>> {
    ensure_schema_db(db)?;
    let persona_id = normalize_persona_id(raw_persona_id);
    if memory_scope == "off" || char_cap == 0 {
        return Ok(vec![]);
    }
    let mut stmt = db.prepare(
        "SELECT id,scope,persona_id,category,content,source_session_id,source_message_id,
                enabled,pinned,created_at,updated_at
         FROM companion_memories
         WHERE enabled=1 AND (scope='global' OR (scope='persona' AND persona_id=?1))
         ORDER BY pinned DESC, updated_at DESC, id ASC
         LIMIT 64",
    )?;
    let rows = stmt
        .query_map([persona_id], read_memory_row)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    let mut selected = Vec::new();
    let mut used = 0usize;
    for item in rows {
        let content = item["content"].as_str().unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        let line_len = content.chars().count() + 8;
        if !selected.is_empty() && used + line_len > char_cap {
            continue;
        }
        if selected.is_empty() && line_len > char_cap {
            let mut clipped = item.clone();
            let capped: String = content.chars().take(char_cap.saturating_sub(8)).collect();
            clipped["content"] = capped.into();
            selected.push(clipped);
            break;
        }
        used += line_len;
        selected.push(item);
    }
    Ok(selected)
}

pub(crate) fn load_session_messages_db(
    db: &Connection,
    session_id: &str,
) -> Result<Vec<MessageRecord>> {
    let mut stmt = db.prepare(
        "SELECT id,session_id,parent_id,seq,role,gear,status,content,thinking,steps_json,
                citations_json,pi_task_id,model_id,usage_json,error_text,created_at,updated_at
         FROM companion_messages
         WHERE session_id=?1
         ORDER BY seq ASC, id ASC",
    )?;
    let rows = stmt
        .query_map([session_id], read_message_record)?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    Ok(rows)
}

/// Walks root-to-leaf along `active_leaf_id` (or newest message fallback) and
/// attaches `{ branchIndex, branchCount, siblingIds }` at every fork point.
pub(crate) fn project_active_branch(
    all: &[MessageRecord],
    active_leaf_id: Option<&str>,
) -> (Option<String>, Vec<Value>) {
    if all.is_empty() {
        return (None, vec![]);
    }
    let by_id: HashMap<&str, &MessageRecord> = all.iter().map(|m| (m.id.as_str(), m)).collect();
    let mut children: HashMap<Option<&str>, Vec<&MessageRecord>> = HashMap::new();
    for m in all {
        children.entry(m.parent_id.as_deref()).or_default().push(m);
    }
    for list in children.values_mut() {
        list.sort_by(|a, b| a.seq.cmp(&b.seq).then_with(|| a.id.cmp(&b.id)));
    }
    let leaf = active_leaf_id
        .and_then(|id| by_id.get(id).copied())
        .or_else(|| all.iter().max_by(|a, b| a.seq.cmp(&b.seq).then_with(|| a.id.cmp(&b.id))))
        .unwrap();
    let mut chain = Vec::<&MessageRecord>::new();
    let mut seen = HashSet::<&str>::new();
    let mut cursor = Some(leaf);
    while let Some(cur) = cursor {
        if !seen.insert(cur.id.as_str()) {
            break;
        }
        chain.push(cur);
        cursor = cur.parent_id.as_deref().and_then(|pid| by_id.get(pid).copied());
    }
    chain.reverse();
    let projected = chain
        .into_iter()
        .map(|node| {
            let siblings = children
                .get(&node.parent_id.as_deref())
                .map(Vec::as_slice)
                .unwrap_or(&[]);
            let sibling_ids: Vec<String> = siblings.iter().map(|s| s.id.clone()).collect();
            let branch_index = sibling_ids
                .iter()
                .position(|id| id == &node.id)
                .unwrap_or(0);
            let final_siblings = if sibling_ids.is_empty() {
                vec![node.id.clone()]
            } else {
                sibling_ids
            };
            let branch_count = final_siblings.len().max(1);
            let mut out = node.value.clone();
            out["branchIndex"] = branch_index.into();
            out["branchCount"] = branch_count.into();
            out["siblingIds"] = json!(final_siblings);
            out["branch"] = json!({
                "branchIndex": branch_index,
                "branchCount": branch_count,
                "siblingIds": final_siblings,
            });
            out
        })
        .collect();
    (Some(leaf.id.clone()), projected)
}

/// Resolves the deepest latest leaf reachable beneath `target_message_id`.
pub(crate) fn resolve_subtree_leaf(all: &[MessageRecord], target_message_id: &str) -> Option<String> {
    if !all.iter().any(|m| m.id == target_message_id) {
        return None;
    }
    let mut children: HashMap<&str, Vec<&MessageRecord>> = HashMap::new();
    for m in all {
        if let Some(pid) = m.parent_id.as_deref() {
            children.entry(pid).or_default().push(m);
        }
    }
    let mut current = target_message_id;
    let mut visited = HashSet::<&str>::new();
    while visited.insert(current) {
        let Some(next) = children
            .get(current)
            .and_then(|list| list.iter().max_by(|a, b| a.seq.cmp(&b.seq).then_with(|| a.id.cmp(&b.id))))
        else {
            break;
        };
        current = next.id.as_str();
    }
    Some(current.to_owned())
}

fn resolve_legacy_pi_title(db: &Connection, pi_id: &str, raw_title: String) -> String {
    let t = raw_title.trim();
    if !t.is_empty() && t != "Agent 助手" && t != "新对话" {
        return t.to_owned();
    }
    if table_exists(db, "pi_tasks").unwrap_or(false) {
        if let Ok(Some(first_task)) = db
            .query_row(
                "SELECT text FROM pi_tasks WHERE session_id=?1 AND trim(text)<>'' ORDER BY created_at ASC, id ASC LIMIT 1",
                [pi_id],
                |r| r.get::<_, String>(0),
            )
            .optional()
        {
            let single: String = first_task
                .split_whitespace()
                .collect::<Vec<_>>()
                .join(" ")
                .chars()
                .take(24)
                .collect();
            if !single.is_empty() {
                return single;
            }
        }
    }
    if t.is_empty() {
        "改档任务".into()
    } else {
        t.to_owned()
    }
}

pub(crate) fn get_session_db(db: &Connection, id: &str) -> Result<Option<Value>> {
    ensure_schema_db(db)?;
    let direct = db
        .query_row(
            "SELECT id,title,persona_id,active_gear,bound_world_id,bound_line_id,bound_book_id,
                    book_scope_json,pi_session_id,active_leaf_id,summary_text,summary_up_to_msg_id,
                    pinned,archived,metadata_json,created_at,updated_at
             FROM companion_sessions WHERE id=?1",
            [id],
            read_session_row,
        )
        .optional()?;
    if direct.is_some() {
        return Ok(direct);
    }
    if let Some(pi_id) = id.strip_prefix("pi:") {
        let linked = db
            .query_row(
                "SELECT id,title,persona_id,active_gear,bound_world_id,bound_line_id,bound_book_id,
                        book_scope_json,pi_session_id,active_leaf_id,summary_text,summary_up_to_msg_id,
                        pinned,archived,metadata_json,created_at,updated_at
                 FROM companion_sessions WHERE pi_session_id=?1 ORDER BY updated_at DESC LIMIT 1",
                [pi_id],
                read_session_row,
            )
            .optional()?;
        if linked.is_some() {
            return Ok(linked);
        }
        if table_exists(db, "pi_sessions")? {
            let legacy = db
                .query_row(
                    "SELECT id,world_id,line_id,title,created_at,updated_at FROM pi_sessions WHERE id=?1",
                    [pi_id],
                    |r| {
                        let pid: String = r.get(0)?;
                        let raw_title: String = r.get(3)?;
                        Ok((
                            pid,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            raw_title,
                            r.get::<_, String>(4)?,
                            r.get::<_, String>(5)?,
                        ))
                    },
                )
                .optional()?
                .map(|(pid, wid, lid, raw_title, created_at, updated_at)| {
                    let title = resolve_legacy_pi_title(db, &pid, raw_title);
                    json!({
                        "id": format!("pi:{pid}"),
                        "title": title,
                        "personaId": DEFAULT_PERSONA_ID,
                        "activeGear": "agent",
                        "boundWorldId": wid,
                        "boundLineId": lid,
                        "boundBookId": Value::Null,
                        "bookScope": Value::Null,
                        "piSessionId": pid,
                        "activeLeafId": Value::Null,
                        "summaryText": "",
                        "summaryUpToMsgId": Value::Null,
                        "pinned": false,
                        "archived": false,
                        "legacyPi": true,
                        "metadata": {},
                        "createdAt": created_at,
                        "updatedAt": updated_at,
                    })
                });
            return Ok(legacy);
        }
    }
    Ok(None)
}

/// Lazily materializes a virtual `pi:<id>` legacy session into `companion_sessions`
/// when the user writes, renames, pins, or appends companion messages to it.
pub(crate) fn ensure_materialized_session_tx(tx: &Transaction<'_>, id: &str) -> Result<String> {
    ensure_schema_db(tx)?;
    if tx
        .query_row("SELECT 1 FROM companion_sessions WHERE id=?1", [id], |_| Ok(()))
        .optional()?
        .is_some()
    {
        return Ok(id.to_owned());
    }
    if let Some(pi_id) = id.strip_prefix("pi:") {
        if let Some(existing_id) = tx
            .query_row(
                "SELECT id FROM companion_sessions WHERE pi_session_id=?1 LIMIT 1",
                [pi_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            return Ok(existing_id);
        }
        if table_exists(tx, "pi_sessions")? {
            if let Some((world_id, line_id, raw_title, created_at, updated_at)) = tx
                .query_row(
                    "SELECT world_id,line_id,title,created_at,updated_at FROM pi_sessions WHERE id=?1",
                    [pi_id],
                    |r| {
                        Ok((
                            r.get::<_, String>(0)?,
                            r.get::<_, String>(1)?,
                            r.get::<_, String>(2)?,
                            r.get::<_, String>(3)?,
                            r.get::<_, String>(4)?,
                        ))
                    },
                )
                .optional()?
            {
                let title = resolve_legacy_pi_title(tx, pi_id, raw_title);
                let persona = builtin_value(&BUILTINS[0]);
                let meta = json!({ "personaSnapshot": persona_snapshot(&persona), "legacyPi": true });
                tx.execute(
                    "INSERT INTO companion_sessions(
                        id,title,persona_id,active_gear,bound_world_id,bound_line_id,bound_book_id,
                        book_scope_json,pi_session_id,active_leaf_id,summary_text,summary_up_to_msg_id,
                        pinned,archived,metadata_json,created_at,updated_at
                     ) VALUES(?1,?2,?3,'agent',?4,?5,NULL,NULL,?6,NULL,'',NULL,0,0,?7,?8,?9)",
                    params![
                        id,
                        title,
                        DEFAULT_PERSONA_ID,
                        world_id,
                        line_id,
                        pi_id,
                        meta.to_string(),
                        created_at,
                        updated_at
                    ],
                )?;
                return Ok(id.to_owned());
            }
        }
    }
    Err(invalid("找不到这段伴聊会话"))
}

pub(crate) fn load_pi_tasks_summary(
    db: &Connection,
    pi_session_id: &str,
    companion_session_id: Option<&str>,
) -> Result<Vec<Value>> {
    let clean_pi = pi_session_id.trim();
    let clean_comp = companion_session_id.map(str::trim).filter(|s| !s.is_empty());
    if (clean_pi.is_empty() && clean_comp.is_none()) || !table_exists(db, "pi_tasks")? {
        return Ok(vec![]);
    }
    let has_messages = clean_comp.is_some() && table_exists(db, "companion_messages")?;
    let comp_arg = if has_messages { clean_comp } else { None };
    let has_leases = table_exists(db, "world_execution_leases")?;
    let now_ms = crate::execution_lease::now_ms();
    let mut stmt = db.prepare(
        "SELECT id,world_id,text,status,policy,metadata_json,lease_json,stop_revision,host_owner,result_json,error,created_at,updated_at
         FROM pi_tasks
         WHERE (?1 <> '' AND session_id = ?1)
            OR (?2 IS NOT NULL AND id IN (
                SELECT DISTINCT pi_task_id FROM companion_messages
                WHERE session_id = ?2 AND pi_task_id IS NOT NULL AND pi_task_id <> ''
            ))
         ORDER BY created_at ASC, id ASC
         LIMIT 50",
    )?;
    let raw_rows: Vec<(
        String,
        String,
        String,
        String,
        String,
        String,
        String,
        i64,
        String,
        Option<String>,
        Option<String>,
        String,
        String,
    )> = stmt
        .query_map(params![clean_pi, comp_arg], |r| {
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                r.get(3)?,
                r.get(4)?,
                r.get(5)?,
                r.get(6)?,
                r.get(7)?,
                r.get(8)?,
                r.get(9)?,
                r.get(10)?,
                r.get(11)?,
                r.get(12)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;

    let mut out = Vec::with_capacity(raw_rows.len());
    for (
        id,
        world_id,
        text,
        raw_status,
        policy,
        meta_raw,
        lease_raw,
        stop_rev,
        host_owner,
        result_raw,
        error,
        created_at,
        updated_at,
    ) in raw_rows
    {
        let meta_val = parse_json_or(&meta_raw, json!({}));
        let lease_val = parse_json_or(&lease_raw, json!({}));
        let parsed_ticket =
            serde_json::from_value::<crate::execution_lease::LeaseTicket>(lease_val.clone()).ok();
        let live = if has_leases {
            if let Some(ref saved) = parsed_ticket {
                crate::execution_lease::current(db, &world_id)?
                    .is_some_and(|st| st.ticket == *saved && st.expires_at_ms > now_ms)
            } else {
                crate::execution_lease::current(db, &world_id)?.is_some_and(|st| {
                    !st.ticket.owner_id.is_empty()
                        && st.ticket.owner_id == id
                        && st.expires_at_ms > now_ms
                }) || lease_val["expiresAtMs"].as_i64().is_some_and(|exp| exp > now_ms)
            }
        } else {
            lease_val["expiresAtMs"].as_i64().is_some_and(|exp| exp > now_ms)
        };

        let is_ongoing = matches!(raw_status.as_str(), "running" | "stopping" | "committing");
        let eff_status = if is_ongoing && !live {
            "interrupted".to_owned()
        } else {
            raw_status.clone()
        };

        let row_val = json!({
            "id": id,
            "world_id": world_id,
            "status": raw_status,
            "metadata_json": meta_val,
            "lease_json": lease_val,
            "stop_revision": stop_rev,
            "host_owner": host_owner,
        });
        let attempt_id = lease_val["attemptId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .or_else(|| {
                meta_val["attemptId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            })
            .unwrap_or_else(|| {
                if lease_val.as_object().is_some_and(|o| !o.is_empty()) {
                    crate::pi_store::arguments_hash(&lease_val)
                } else {
                    String::new()
                }
            });
        let execution = if has_leases && parsed_ticket.is_some() {
            let mut exec = crate::pi_lifecycle::execution(db, &row_val)?;
            if eff_status == "interrupted" {
                exec["phase"] = "interrupted".into();
                exec["ownerStatus"] = "lost".into();
            }
            exec
        } else {
            json!({
                "attemptId": attempt_id,
                "phase": eff_status,
                "ownerStatus": if live { "active" } else if is_ongoing { "lost" } else { "idle" },
            })
        };

        let summary = result_raw
            .as_deref()
            .and_then(|s| serde_json::from_str::<Value>(s).ok())
            .and_then(|v| v["summary"].as_str().map(str::to_owned));
        out.push(json!({
            "id": id,
            "text": text,
            "status": eff_status,
            "policy": policy,
            "summary": summary,
            "error": error,
            "execution": execution,
            "createdAt": created_at,
            "updatedAt": updated_at,
        }));
    }
    Ok(out)
}

pub(crate) fn next_message_seq_tx(tx: &Transaction<'_>, session_id: &str) -> Result<i64> {
    Ok(tx.query_row(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM companion_messages WHERE session_id=?1",
        [session_id],
        |r| r.get(0),
    )?)
}

pub(crate) fn heal_orphan_streaming_db(
    db: &mut Connection,
    session_id: &str,
    active_run_id: Option<&str>,
) -> Result<usize> {
    ensure_schema_db(db)?;
    let orphan_rows: Vec<(String, String)> = {
        let mut stmt = db.prepare(
            "SELECT id, steps_json FROM companion_messages
             WHERE session_id=?1 AND status='streaming' AND (?2 IS NULL OR id<>?2)",
        )?;
        let rows = stmt
            .query_map(params![session_id, active_run_id], |r| {
                Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };
    let cleaned_meta: Option<String> = if active_run_id.is_none() {
        let raw_meta: Option<String> = db
            .query_row(
                "SELECT metadata_json FROM companion_sessions WHERE id=?1",
                [session_id],
                |r| r.get::<_, String>(0),
            )
            .optional()?;
        raw_meta.and_then(|s| {
            let mut v: Value = serde_json::from_str(&s).ok()?;
            let obj = v.as_object_mut()?;
            let removed_a = obj.remove("activeRunId").is_some();
            let removed_b = obj.remove("active_run_id").is_some();
            (removed_a || removed_b).then(|| v.to_string())
        })
    } else {
        None
    };

    if orphan_rows.is_empty() && cleaned_meta.is_none() {
        return Ok(0);
    }
    crate::maintenance::guard(db)?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now_iso();
    for (msg_id, steps_raw) in &orphan_rows {
        let mut steps: Value = serde_json::from_str(steps_raw).unwrap_or_else(|_| json!([]));
        if let Some(arr) = steps.as_array_mut() {
            for step in arr {
                if step["status"] == "running" {
                    step["status"] = "failed".into();
                    if step["summary"] == "正在查阅…" {
                        step["summary"] = "已中断".into();
                    }
                }
            }
        }
        tx.execute(
            "UPDATE companion_messages SET status='interrupted', steps_json=?1, updated_at=?2
             WHERE id=?3 AND status='streaming'",
            params![steps.to_string(), now, msg_id],
        )?;
    }
    if let Some(meta_str) = cleaned_meta {
        tx.execute(
            "UPDATE companion_sessions SET metadata_json=?1, updated_at=?2 WHERE id=?3",
            params![meta_str, now, session_id],
        )?;
    }
    tx.commit()?;
    Ok(orphan_rows.len())
}

impl CompanionStore {
    /// Creates `companion_*` tables and indexes idempotently. Never inserts rows.
    pub fn initialize(&self) -> Result<()> {
        let db = self.0.lock()?;
        ensure_schema_db(&db)
    }

    pub fn list_personas(&self) -> Result<Vec<Value>> {
        let db = self.0.lock()?;
        list_personas_db(&db)
    }

    pub fn get_persona(&self, id: &str) -> Result<Value> {
        let db = self.0.lock()?;
        get_persona_db(&db, id)?.ok_or_else(|| invalid("找不到这张人格卡"))
    }

    pub fn save_persona(&self, input: &Value) -> Result<Value> {
        if !input.is_object() {
            return Err(invalid("人格卡格式无效"));
        }
        let name = input["name"].as_str().unwrap_or("").trim();
        if name.is_empty() || name.chars().count() > 64 {
            return Err(invalid("请填写 1～64 字的人格名称"));
        }
        let system_prompt = input["systemPrompt"].as_str().unwrap_or("").trim();
        if system_prompt.is_empty() || system_prompt.chars().count() > 24_000 {
            return Err(invalid("请填写人格设定提示词（最多 24,000 字）"));
        }
        let role_kind = input["roleKind"].as_str().unwrap_or("assistant");
        if !["assistant", "advisor", "roleplay", "npc"].contains(&role_kind) {
            return Err(invalid("人格类型无效"));
        }
        let memory_scope = input["memoryScope"].as_str().unwrap_or("persona");
        if !["persona", "global", "off"].contains(&memory_scope) {
            return Err(invalid("记忆范围无效"));
        }
        let id = input["id"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(|s| normalize_persona_id(s).to_owned())
            .unwrap_or_else(|| format!("persona:{}", new_id()));
        if id.len() > 128 {
            return Err(invalid("人格标识过长"));
        }
        if id.starts_with("builtin:") && !is_builtin_persona_id(&id) {
            return Err(invalid("不能新建 builtin: 前缀的人格标识"));
        }
        let avatar: String = input["avatar"]
            .as_str()
            .unwrap_or("")
            .trim()
            .chars()
            .take(8)
            .collect();
        let avatar = if avatar.is_empty() {
            name.chars().next().map(|c| c.to_string()).unwrap_or_else(|| "伴".into())
        } else {
            avatar
        };
        let tagline: String = input["tagline"].as_str().unwrap_or("").trim().chars().take(160).collect();
        let greeting: String = input["greeting"].as_str().unwrap_or("").trim().chars().take(2000).collect();
        let style_notes: String = input["styleNotes"].as_str().unwrap_or("").trim().chars().take(2000).collect();
        let starters: Vec<String> = input["starters"]
            .as_array()
            .map(|arr| {
                arr.iter()
                    .filter_map(Value::as_str)
                    .map(str::trim)
                    .filter(|s| !s.is_empty())
                    .take(8)
                    .map(|s| s.chars().take(120).collect())
                    .collect()
            })
            .unwrap_or_default();
        let pure_roleplay = input["pureRoleplay"]
            .as_bool()
            .unwrap_or(matches!(role_kind, "roleplay" | "npc"));
        let sort_order = input["sortOrder"].as_i64().unwrap_or(100);
        let source_world_id = input["sourceWorldId"].as_str().filter(|s| !s.is_empty());
        let source_person_id = input["sourcePersonId"].as_str().filter(|s| !s.is_empty());
        let source_head_id = input["sourceHeadId"].as_str().filter(|s| !s.is_empty());
        let mut metadata = input
            .get("metadata")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        if let Some(lid) = input["boundLineId"].as_str().filter(|s| !s.is_empty()) {
            metadata["boundLineId"] = lid.into();
        }

        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        ensure_schema_db(&tx)?;
        let now = now_iso();
        let existing_created: Option<String> = tx
            .query_row(
                "SELECT created_at FROM companion_personas WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?;
        let created_at = existing_created.unwrap_or_else(|| now.clone());
        tx.execute(
            "INSERT INTO companion_personas(
                id,name,avatar,tagline,role_kind,system_prompt,greeting,starters_json,style_notes,
                memory_scope,pure_roleplay,source_world_id,source_person_id,source_head_id,
                sort_order,metadata_json,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?17,?18)
             ON CONFLICT(id) DO UPDATE SET
                name=excluded.name,
                avatar=excluded.avatar,
                tagline=excluded.tagline,
                role_kind=excluded.role_kind,
                system_prompt=excluded.system_prompt,
                greeting=excluded.greeting,
                starters_json=excluded.starters_json,
                style_notes=excluded.style_notes,
                memory_scope=excluded.memory_scope,
                pure_roleplay=excluded.pure_roleplay,
                source_world_id=excluded.source_world_id,
                source_person_id=excluded.source_person_id,
                source_head_id=excluded.source_head_id,
                sort_order=excluded.sort_order,
                metadata_json=excluded.metadata_json,
                updated_at=excluded.updated_at",
            params![
                id,
                name,
                avatar,
                tagline,
                role_kind,
                system_prompt,
                greeting,
                serde_json::to_string(&starters)?,
                style_notes,
                memory_scope,
                i64::from(pure_roleplay),
                source_world_id,
                source_person_id,
                source_head_id,
                sort_order,
                metadata.to_string(),
                created_at,
                now
            ],
        )?;
        let saved = get_persona_db(&tx, &id)?.ok_or_else(|| invalid("保存人格卡失败"))?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn delete_persona(&self, raw_id: &str) -> Result<Value> {
        let id = normalize_persona_id(raw_id);
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        ensure_schema_db(&tx)?;
        let removed = tx.execute("DELETE FROM companion_personas WHERE id=?1", [id])?;
        if is_builtin_persona_id(id) {
            tx.commit()?;
            return Ok(json!({ "id": id, "deleted": false, "resetBuiltin": removed > 0 }));
        }
        tx.execute(
            "DELETE FROM companion_memories WHERE scope='persona' AND persona_id=?1",
            [id],
        )?;
        tx.commit()?;
        Ok(json!({ "id": id, "deleted": removed > 0, "resetBuiltin": false }))
    }

    pub fn export_persona(&self, id: &str) -> Result<Value> {
        let persona = self.get_persona(id)?;
        Ok(json!({
            "format": "lishi-persona-v1",
            "version": 1,
            "exportedAt": now_iso(),
            "persona": {
                "name": persona["name"],
                "avatar": persona["avatar"],
                "tagline": persona["tagline"],
                "roleKind": if persona["roleKind"] == "npc" { json!("roleplay") } else { persona["roleKind"].clone() },
                "systemPrompt": persona["systemPrompt"],
                "greeting": persona["greeting"],
                "starters": persona["starters"],
                "styleNotes": persona["styleNotes"],
                "memoryScope": persona["memoryScope"],
                "pureRoleplay": persona["pureRoleplay"],
                "sortOrder": persona["sortOrder"],
            }
        }))
    }

    pub fn import_persona(&self, raw: &Value) -> Result<Value> {
        let parsed: Value = match raw {
            Value::String(text) => {
                if text.len() > 256 * 1024 {
                    return Err(invalid("人格卡文件超过 256 KB 上限"));
                }
                serde_json::from_str(text.trim_start_matches('\u{feff}'))
                    .map_err(|_| invalid("人格卡 JSON 格式无效"))?
            }
            Value::Object(_) => raw.clone(),
            _ => return Err(invalid("人格卡内容无效")),
        };
        let body = if parsed.get("format").is_some() {
            if parsed["format"] != "lishi-persona-v1" {
                return Err(invalid("不支持的人格卡文件版本"));
            }
            parsed["persona"].clone()
        } else {
            parsed
        };
        if !body.is_object() {
            return Err(invalid("人格卡缺少主体字段"));
        }
        let mut clean = body;
        if let Some(obj) = clean.as_object_mut() {
            obj.insert("id".into(), format!("persona:{}", new_id()).into());
            obj.remove("sourceWorldId");
            obj.remove("sourcePersonId");
            obj.remove("sourceHeadId");
            if obj.get("roleKind").and_then(Value::as_str) == Some("npc") {
                obj.insert("roleKind".into(), "roleplay".into());
            }
        }
        self.save_persona(&clean)
    }

    pub fn list_memories(
        &self,
        persona_id: Option<&str>,
        scope: Option<&str>,
        include_disabled: bool,
    ) -> Result<Vec<Value>> {
        let db = self.0.lock()?;
        ensure_schema_db(&db)?;
        let mut sql = String::from(
            "SELECT id,scope,persona_id,category,content,source_session_id,source_message_id,
                    enabled,pinned,created_at,updated_at
             FROM companion_memories WHERE 1=1",
        );
        let mut args: Vec<String> = Vec::new();
        if !include_disabled {
            sql.push_str(" AND enabled=1");
        }
        let clean_pid = persona_id.filter(|s| !s.is_empty()).map(normalize_persona_id);
        match (scope, clean_pid) {
            (Some("global"), _) => sql.push_str(" AND scope='global'"),
            (Some("persona"), Some(pid)) => {
                sql.push_str(" AND scope='persona' AND persona_id=?1");
                args.push(pid.to_owned());
            }
            (Some("persona"), None) => sql.push_str(" AND scope='persona'"),
            (_, Some(pid)) => {
                sql.push_str(" AND (scope='global' OR (scope='persona' AND persona_id=?1))");
                args.push(pid.to_owned());
            }
            _ => {}
        }
        sql.push_str(" ORDER BY pinned DESC, updated_at DESC, id ASC LIMIT 200");
        let mut stmt = db.prepare(&sql)?;
        let rows = stmt
            .query_map(rusqlite::params_from_iter(args.iter()), read_memory_row)?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        Ok(rows)
    }

    pub fn active_memories_for_persona(
        &self,
        persona_id: &str,
        memory_scope: &str,
    ) -> Result<Vec<Value>> {
        let db = self.0.lock()?;
        active_memories_for_persona_db(&db, persona_id, memory_scope, MEMORY_PROMPT_CHAR_CAP)
    }

    pub fn save_memory(&self, input: &Value) -> Result<Value> {
        if !input.is_object() {
            return Err(invalid("记忆条目格式无效"));
        }
        let content = input["content"].as_str().unwrap_or("").trim();
        if content.is_empty() || content.chars().count() > 1000 {
            return Err(invalid("记忆内容请控制在 1～1000 字以内"));
        }
        let scope = input["scope"].as_str().unwrap_or("persona");
        if !["persona", "global"].contains(&scope) {
            return Err(invalid("记忆范围须为 persona 或 global"));
        }
        let persona_id = if scope == "global" {
            ""
        } else {
            let pid = input["personaId"].as_str().unwrap_or("").trim();
            if pid.is_empty() {
                return Err(invalid("专属记忆需要指定所属人格"));
            }
            normalize_persona_id(pid)
        };
        let category = input["category"].as_str().unwrap_or("fact");
        if !["fact", "preference", "lore", "bond", "relation", "note"].contains(&category) {
            return Err(invalid("记忆分类无效"));
        }
        let id = input["id"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(new_id);
        let enabled = input["enabled"].as_bool().unwrap_or(true);
        let pinned = input["pinned"].as_bool().unwrap_or(false);
        let source_session_id = input["sourceSessionId"].as_str().filter(|s| !s.is_empty());
        let source_message_id = input["sourceMessageId"].as_str().filter(|s| !s.is_empty());

        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        ensure_schema_db(&tx)?;
        let now = now_iso();
        let created_at: String = tx
            .query_row(
                "SELECT created_at FROM companion_memories WHERE id=?1",
                [&id],
                |r| r.get(0),
            )
            .optional()?
            .unwrap_or_else(|| now.clone());
        tx.execute(
            "INSERT INTO companion_memories(
                id,scope,persona_id,category,content,source_session_id,source_message_id,
                enabled,pinned,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(id) DO UPDATE SET
                scope=excluded.scope,
                persona_id=excluded.persona_id,
                category=excluded.category,
                content=excluded.content,
                source_session_id=COALESCE(excluded.source_session_id, companion_memories.source_session_id),
                source_message_id=COALESCE(excluded.source_message_id, companion_memories.source_message_id),
                enabled=excluded.enabled,
                pinned=excluded.pinned,
                updated_at=excluded.updated_at",
            params![
                id,
                scope,
                persona_id,
                category,
                content,
                source_session_id,
                source_message_id,
                i64::from(enabled),
                i64::from(pinned),
                created_at,
                now
            ],
        )?;
        let saved = tx.query_row(
            "SELECT id,scope,persona_id,category,content,source_session_id,source_message_id,
                    enabled,pinned,created_at,updated_at
             FROM companion_memories WHERE id=?1",
            [&id],
            read_memory_row,
        )?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn toggle_memory(
        &self,
        id: &str,
        enabled: Option<bool>,
        pinned: Option<bool>,
    ) -> Result<Value> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        ensure_schema_db(&tx)?;
        let existing: Option<(bool, bool)> = tx
            .query_row(
                "SELECT enabled,pinned FROM companion_memories WHERE id=?1",
                [id],
                |r| Ok((r.get::<_, i64>(0)? != 0, r.get::<_, i64>(1)? != 0)),
            )
            .optional()?;
        let Some((cur_enabled, cur_pinned)) = existing else {
            return Err(invalid("找不到这条记忆"));
        };
        let next_enabled = enabled.unwrap_or(cur_enabled);
        let next_pinned = pinned.unwrap_or(cur_pinned);
        tx.execute(
            "UPDATE companion_memories SET enabled=?1, pinned=?2, updated_at=?3 WHERE id=?4",
            params![i64::from(next_enabled), i64::from(next_pinned), now_iso(), id],
        )?;
        let saved = tx.query_row(
            "SELECT id,scope,persona_id,category,content,source_session_id,source_message_id,
                    enabled,pinned,created_at,updated_at
             FROM companion_memories WHERE id=?1",
            [id],
            read_memory_row,
        )?;
        tx.commit()?;
        Ok(saved)
    }

    pub fn delete_memory(&self, id: &str) -> Result<Value> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        ensure_schema_db(&tx)?;
        let deleted = tx.execute("DELETE FROM companion_memories WHERE id=?1", [id])? > 0;
        tx.commit()?;
        Ok(json!({ "id": id, "deleted": deleted }))
    }

    pub fn list_sessions(
        &self,
        world_id: Option<&str>,
        include_archived: bool,
        query: &str,
        offset: usize,
        limit: usize,
    ) -> Result<Value> {
        let db = self.0.lock()?;
        ensure_schema_db(&db)?;
        let limit = limit.clamp(1, 100);
        let q_lower = query.trim().to_lowercase();
        let world_filter = world_id.filter(|s| !s.is_empty());

        let mut items: Vec<Value> = {
            let mut stmt = db.prepare(
                "SELECT id,title,persona_id,active_gear,bound_world_id,bound_line_id,bound_book_id,
                        book_scope_json,pi_session_id,active_leaf_id,summary_text,summary_up_to_msg_id,
                        pinned,archived,metadata_json,created_at,updated_at
                 FROM companion_sessions
                 WHERE (?1=1 OR archived=0) AND (?2 IS NULL OR bound_world_id=?2)",
            )?;
            let rows = stmt
                .query_map(params![i64::from(include_archived), world_filter], read_session_row)?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            rows
        };

        // Seamlessly wrap legacy 0.19.1 unlinked `pi_sessions` without mutating DB on read.
        if table_exists(&db, "pi_sessions")? {
            let mut stmt = db.prepare(
                "SELECT p.id,p.world_id,p.line_id,p.title,p.created_at,p.updated_at
                 FROM pi_sessions p
                 WHERE (?1 IS NULL OR p.world_id=?1)
                   AND NOT EXISTS (SELECT 1 FROM companion_sessions c WHERE c.pi_session_id=p.id)",
            )?;
            let legacy_rows = stmt
                .query_map([world_filter], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, String>(4)?,
                        r.get::<_, String>(5)?,
                    ))
                })?
                .collect::<rusqlite::Result<Vec<_>>>()?;
            drop(stmt);
            for (pid, wid, lid, raw_title, created_at, updated_at) in legacy_rows {
                let title = resolve_legacy_pi_title(&db, &pid, raw_title);
                items.push(json!({
                    "id": format!("pi:{pid}"),
                    "title": title,
                    "personaId": DEFAULT_PERSONA_ID,
                    "activeGear": "agent",
                    "boundWorldId": wid,
                    "boundLineId": lid,
                    "boundBookId": Value::Null,
                    "bookScope": Value::Null,
                    "piSessionId": pid,
                    "activeLeafId": Value::Null,
                    "summaryText": "",
                    "summaryUpToMsgId": Value::Null,
                    "pinned": false,
                    "archived": false,
                    "legacyPi": true,
                    "metadata": {},
                    "createdAt": created_at,
                    "updatedAt": updated_at,
                }));
            }
        }

        if !q_lower.is_empty() {
            items.retain(|s| {
                if s["title"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&q_lower)
                {
                    return true;
                }
                let sid = s["id"].as_str().unwrap_or("");
                if let Some(pi_id) = sid.strip_prefix("pi:") {
                    if table_exists(&db, "pi_tasks").unwrap_or(false) {
                        return db
                            .query_row(
                                "SELECT EXISTS(SELECT 1 FROM pi_tasks WHERE session_id=?1 AND instr(lower(text), ?2)>0)",
                                params![pi_id, q_lower],
                                |r| r.get::<_, bool>(0),
                            )
                            .unwrap_or(false);
                    }
                }
                db.query_row(
                    "SELECT EXISTS(SELECT 1 FROM companion_messages WHERE session_id=?1 AND instr(lower(content), ?2)>0)",
                    params![sid, q_lower],
                    |r| r.get::<_, bool>(0),
                )
                .unwrap_or(false)
            });
        }

        items.sort_by(|a, b| {
            let pa = a["pinned"].as_bool().unwrap_or(false);
            let pb = b["pinned"].as_bool().unwrap_or(false);
            pb.cmp(&pa)
                .then_with(|| {
                    b["updatedAt"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(a["updatedAt"].as_str().unwrap_or(""))
                })
                .then_with(|| {
                    a["id"]
                        .as_str()
                        .unwrap_or("")
                        .cmp(b["id"].as_str().unwrap_or(""))
                })
        });

        let total = items.len();
        let page: Vec<Value> = items.into_iter().skip(offset).take(limit).collect();
        let next = offset + page.len();
        Ok(json!({
            "sessions": page,
            "nextOffset": (next < total).then_some(next),
        }))
    }

    pub fn heal_orphan_streaming(
        &self,
        session_id: &str,
        active_run_id: Option<&str>,
    ) -> Result<usize> {
        let mut db = self.0.lock()?;
        ensure_schema_db(&db)?;
        heal_orphan_streaming_db(&mut db, session_id, active_run_id)
    }

    pub fn get_session_detail_with_active(
        &self,
        id: &str,
        active_run_for: impl FnOnce(&str) -> Option<String>,
    ) -> Result<Value> {
        let _ = crate::pi_lifecycle::reconcile(&self.0);
        let mut db = self.0.lock()?;
        let initial_session =
            get_session_db(&db, id)?.ok_or_else(|| invalid("找不到这段伴聊会话"))?;
        let real_id = initial_session["id"].as_str().unwrap_or(id).to_owned();
        let active_run_id = active_run_for(&real_id);
        let _ = heal_orphan_streaming_db(&mut db, &real_id, active_run_id.as_deref());
        let mut session = get_session_db(&db, &real_id)?.unwrap_or(initial_session);
        let persona = resolve_persona_db(
            &db,
            session["personaId"].as_str().unwrap_or(DEFAULT_PERSONA_ID),
            session["metadata"].get("personaSnapshot"),
        )?;
        let all = load_session_messages_db(&db, &real_id)?;
        let (resolved_leaf, messages) =
            project_active_branch(&all, session["activeLeafId"].as_str());
        if session["activeLeafId"].is_null() {
            if let Some(leaf) = resolved_leaf {
                session["activeLeafId"] = leaf.into();
            }
        }
        let pi_tasks = load_pi_tasks_summary(
            &db,
            session["piSessionId"].as_str().unwrap_or(""),
            Some(&real_id),
        )?;
        let active_val = match active_run_id {
            Some(rid) => Value::String(rid),
            None => Value::Null,
        };
        session["activeRunId"] = active_val.clone();
        Ok(json!({
            "session": session,
            "persona": persona,
            "messages": messages,
            "piTasks": pi_tasks,
            "activeRunId": active_val,
        }))
    }

    pub fn get_session_detail(&self, id: &str) -> Result<Value> {
        let _ = crate::pi_lifecycle::reconcile(&self.0);
        let db = self.0.lock()?;
        let mut session = get_session_db(&db, id)?.ok_or_else(|| invalid("找不到这段伴聊会话"))?;
        let real_id = session["id"].as_str().unwrap_or(id).to_owned();
        let persona = resolve_persona_db(
            &db,
            session["personaId"].as_str().unwrap_or(DEFAULT_PERSONA_ID),
            session["metadata"].get("personaSnapshot"),
        )?;
        let all = load_session_messages_db(&db, &real_id)?;
        let (resolved_leaf, messages) =
            project_active_branch(&all, session["activeLeafId"].as_str());
        if session["activeLeafId"].is_null() {
            if let Some(leaf) = resolved_leaf {
                session["activeLeafId"] = leaf.into();
            }
        }
        let pi_tasks = load_pi_tasks_summary(
            &db,
            session["piSessionId"].as_str().unwrap_or(""),
            Some(&real_id),
        )?;
        session["activeRunId"] = Value::Null;
        Ok(json!({
            "session": session,
            "persona": persona,
            "messages": messages,
            "piTasks": pi_tasks,
            "activeRunId": Value::Null,
        }))
    }

    pub fn create_session(&self, input: &Value) -> Result<Value> {
        let id = input["id"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(new_id);
        let persona_id = normalize_persona_id(
            input["personaId"]
                .as_str()
                .filter(|s| !s.trim().is_empty())
                .unwrap_or(DEFAULT_PERSONA_ID),
        );
        let active_gear = input["activeGear"].as_str().unwrap_or("chat");
        if !["chat", "research", "agent"].contains(&active_gear) {
            return Err(invalid("伴聊挡位无效"));
        }
        let bound_world_id = input["boundWorldId"].as_str().filter(|s| !s.is_empty());
        let bound_line_id = input["boundLineId"].as_str().filter(|s| !s.is_empty());
        let bound_book_id = input["boundBookId"].as_str().filter(|s| !s.is_empty());
        let pi_session_id = input["piSessionId"].as_str().filter(|s| !s.is_empty());
        let book_scope_json = input
            .get("bookScope")
            .filter(|v| v.is_object())
            .map(Value::to_string);
        let with_greeting = input["withGreeting"].as_bool().unwrap_or(false);

        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        ensure_schema_db(&tx)?;
        let persona = resolve_persona_db(&tx, persona_id, None)?;
        let default_title = format!("与{}的对话", persona["name"].as_str().unwrap_or("灵犀"));
        let title: String = input["title"]
            .as_str()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .unwrap_or(&default_title)
            .chars()
            .take(120)
            .collect();
        let mut metadata = input
            .get("metadata")
            .filter(|v| v.is_object())
            .cloned()
            .unwrap_or_else(|| json!({}));
        metadata["personaSnapshot"] = persona_snapshot(&persona);
        let now = now_iso();
        tx.execute(
            "INSERT INTO companion_sessions(
                id,title,persona_id,active_gear,bound_world_id,bound_line_id,bound_book_id,
                book_scope_json,pi_session_id,active_leaf_id,summary_text,summary_up_to_msg_id,
                pinned,archived,metadata_json,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,NULL,'',NULL,0,0,?10,?11,?11)",
            params![
                id,
                title,
                persona_id,
                active_gear,
                bound_world_id,
                bound_line_id,
                bound_book_id,
                book_scope_json,
                pi_session_id,
                metadata.to_string(),
                now
            ],
        )?;
        if with_greeting {
            let greeting = persona["greeting"].as_str().unwrap_or("").trim();
            if !greeting.is_empty() {
                let mid = new_id();
                tx.execute(
                    "INSERT INTO companion_messages(
                        id,session_id,parent_id,seq,role,gear,status,content,thinking,
                        steps_json,citations_json,pi_task_id,model_id,usage_json,error_text,
                        created_at,updated_at
                     ) VALUES(?1,?2,NULL,1,'assistant','chat','done',?3,'','[]','[]',NULL,'',NULL,NULL,?4,?4)",
                    params![mid, id, greeting, now],
                )?;
                tx.execute(
                    "UPDATE companion_sessions SET active_leaf_id=?1 WHERE id=?2",
                    params![mid, id],
                )?;
            }
        }
        tx.commit()?;
        drop(db);
        self.get_session_detail(&id)
    }

    pub fn update_session(&self, input: &Value) -> Result<Value> {
        let raw_id = input["id"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("缺少会话标识"))?;
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        let id = ensure_materialized_session_tx(&tx, raw_id)?;
        let mut current = get_session_db(&tx, &id)?.ok_or_else(|| invalid("找不到这段伴聊会话"))?;

        if let Some(title) = input.get("title").and_then(Value::as_str) {
            let clean: String = title.trim().chars().take(120).collect();
            if clean.is_empty() {
                return Err(invalid("会话标题不能为空"));
            }
            current["title"] = clean.into();
        }
        if let Some(pid) = input.get("personaId").and_then(Value::as_str) {
            if !pid.trim().is_empty() {
                let clean_pid = normalize_persona_id(pid.trim());
                let persona = resolve_persona_db(&tx, clean_pid, None)?;
                current["personaId"] = clean_pid.into();
                current["metadata"]["personaSnapshot"] = persona_snapshot(&persona);
            }
        }
        if let Some(gear) = input.get("activeGear").and_then(Value::as_str) {
            if !["chat", "research", "agent"].contains(&gear) {
                return Err(invalid("伴聊挡位无效"));
            }
            current["activeGear"] = gear.into();
        }
        for (req_key, cur_key) in [
            ("boundWorldId", "boundWorldId"),
            ("boundLineId", "boundLineId"),
            ("boundBookId", "boundBookId"),
            ("piSessionId", "piSessionId"),
            ("summaryUpToMsgId", "summaryUpToMsgId"),
        ] {
            if let Some(val) = input.get(req_key) {
                current[cur_key] = match val.as_str().filter(|s| !s.is_empty()) {
                    Some(s) => s.into(),
                    None => Value::Null,
                };
            }
        }
        if let Some(val) = input.get("activeLeafId") {
            current["activeLeafId"] = match val.as_str().filter(|s| !s.is_empty()) {
                Some(target) => {
                    let all = load_session_messages_db(&tx, &id)?;
                    resolve_subtree_leaf(&all, target)
                        .unwrap_or_else(|| target.to_owned())
                        .into()
                }
                None => Value::Null,
            };
        }
        if let Some(scope) = input.get("bookScope") {
            current["bookScope"] = if scope.is_object() {
                scope.clone()
            } else {
                Value::Null
            };
        }
        if let Some(summary) = input.get("summaryText").and_then(Value::as_str) {
            current["summaryText"] = summary.into();
        }
        if let Some(pinned) = input.get("pinned").and_then(Value::as_bool) {
            current["pinned"] = pinned.into();
        }
        if let Some(archived) = input.get("archived").and_then(Value::as_bool) {
            current["archived"] = archived.into();
        }
        if let Some(meta) = input.get("metadata").and_then(Value::as_object) {
            if let Some(cur_meta) = current["metadata"].as_object_mut() {
                for (k, v) in meta {
                    cur_meta.insert(k.clone(), v.clone());
                }
            }
        }
        let now = now_iso();
        let book_scope_json = current["bookScope"]
            .is_object()
            .then(|| current["bookScope"].to_string());
        tx.execute(
            "UPDATE companion_sessions SET
                title=?1, persona_id=?2, active_gear=?3, bound_world_id=?4, bound_line_id=?5,
                bound_book_id=?6, book_scope_json=?7, pi_session_id=?8, active_leaf_id=?9,
                summary_text=?10, summary_up_to_msg_id=?11, pinned=?12, archived=?13,
                metadata_json=?14, updated_at=?15
             WHERE id=?16",
            params![
                current["title"].as_str().unwrap_or("新对话"),
                current["personaId"].as_str().unwrap_or(DEFAULT_PERSONA_ID),
                current["activeGear"].as_str().unwrap_or("chat"),
                current["boundWorldId"].as_str(),
                current["boundLineId"].as_str(),
                current["boundBookId"].as_str(),
                book_scope_json,
                current["piSessionId"].as_str(),
                current["activeLeafId"].as_str(),
                current["summaryText"].as_str().unwrap_or(""),
                current["summaryUpToMsgId"].as_str(),
                i64::from(current["pinned"].as_bool().unwrap_or(false)),
                i64::from(current["archived"].as_bool().unwrap_or(false)),
                current["metadata"].to_string(),
                now,
                id
            ],
        )?;
        let updated = get_session_db(&tx, &id)?.ok_or_else(|| invalid("更新会话失败"))?;
        tx.commit()?;
        Ok(updated)
    }

    pub fn switch_branch(&self, session_id: &str, message_id: &str) -> Result<Value> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        let id = ensure_materialized_session_tx(&tx, session_id)?;
        let all = load_session_messages_db(&tx, &id)?;
        let leaf = resolve_subtree_leaf(&all, message_id)
            .ok_or_else(|| invalid("找不到要切换的消息分支"))?;
        tx.execute(
            "UPDATE companion_sessions SET active_leaf_id=?1, updated_at=?2 WHERE id=?3",
            params![leaf, now_iso(), id],
        )?;
        tx.commit()?;
        drop(db);
        self.get_session_detail(&id)
    }

    pub fn delete_session(&self, id: &str) -> Result<Value> {
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        ensure_schema_db(&tx)?;
        let mut deleted = tx.execute("DELETE FROM companion_sessions WHERE id=?1", [id])? > 0;
        if let Some(pi_id) = id.strip_prefix("pi:") {
            deleted |= tx.execute(
                "DELETE FROM companion_sessions WHERE pi_session_id=?1",
                [pi_id],
            )? > 0;
            if table_exists(&tx, "pi_sessions")? {
                deleted |= tx.execute("DELETE FROM pi_sessions WHERE id=?1", [pi_id])? > 0;
            }
        }
        tx.commit()?;
        Ok(json!({ "id": id, "deleted": deleted }))
    }

    pub fn append_message(&self, session_id: &str, message: &Value) -> Result<Value> {
        let role = message["role"].as_str().unwrap_or("user");
        if !["user", "assistant", "system", "system_note"].contains(&role) {
            return Err(invalid("消息角色无效"));
        }
        let gear = message["gear"].as_str().unwrap_or("chat");
        if !["chat", "research", "agent"].contains(&gear) {
            return Err(invalid("消息挡位无效"));
        }
        let status = message["status"].as_str().unwrap_or("done");
        if !["streaming", "done", "cancelled", "failed", "interrupted"].contains(&status) {
            return Err(invalid("消息状态无效"));
        }
        let mut db = self.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        let real_session_id = ensure_materialized_session_tx(&tx, session_id)?;
        let cur_leaf: Option<String> = tx.query_row(
            "SELECT active_leaf_id FROM companion_sessions WHERE id=?1",
            [&real_session_id],
            |r| r.get(0),
        )?;
        let parent_id: Option<String> = if message.get("parentId").is_some() {
            message["parentId"].as_str().filter(|s| !s.is_empty()).map(str::to_owned)
        } else {
            cur_leaf
        };
        if let Some(ref pid) = parent_id {
            let valid_parent: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM companion_messages WHERE id=?1 AND session_id=?2)",
                params![pid, real_session_id],
                |r| r.get(0),
            )?;
            if !valid_parent {
                return Err(invalid("父消息不属于当前会话"));
            }
        }
        let id = message["id"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned)
            .unwrap_or_else(new_id);
        let seq = next_message_seq_tx(&tx, &real_session_id)?;
        let now = now_iso();
        let steps_json = message
            .get("steps")
            .filter(|v| v.is_array())
            .cloned()
            .unwrap_or_else(|| json!([]))
            .to_string();
        let citations_json = message
            .get("citations")
            .filter(|v| v.is_array())
            .cloned()
            .unwrap_or_else(|| json!([]))
            .to_string();
        let usage_json = message
            .get("usage")
            .filter(|v| v.is_object())
            .map(Value::to_string);
        tx.execute(
            "INSERT INTO companion_messages(
                id,session_id,parent_id,seq,role,gear,status,content,thinking,steps_json,
                citations_json,pi_task_id,model_id,usage_json,error_text,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15,?16,?16)",
            params![
                id,
                real_session_id,
                parent_id,
                seq,
                role,
                gear,
                status,
                message["content"].as_str().unwrap_or(""),
                message["thinking"].as_str().unwrap_or(""),
                steps_json,
                citations_json,
                message["piTaskId"].as_str().filter(|s| !s.is_empty()),
                message["modelId"].as_str().unwrap_or(""),
                usage_json,
                message["errorText"].as_str().filter(|s| !s.is_empty()),
                now
            ],
        )?;
        tx.execute(
            "UPDATE companion_sessions SET active_leaf_id=?1, active_gear=?2, updated_at=?3 WHERE id=?4",
            params![id, gear, now, real_session_id],
        )?;
        let saved_msg = {
            let mut stmt = tx.prepare(
                "SELECT id,session_id,parent_id,seq,role,gear,status,content,thinking,steps_json,
                        citations_json,pi_task_id,model_id,usage_json,error_text,created_at,updated_at
                 FROM companion_messages WHERE id=?1",
            )?;
            stmt.query_row([&id], read_message_record)?.value
        };
        let saved_session =
            get_session_db(&tx, &real_session_id)?.ok_or_else(|| invalid("读取会话失败"))?;
        tx.commit()?;
        Ok(json!({ "message": saved_msg, "session": saved_session }))
    }

    /// Imports Q&A pairs (e.g. from `AskSheet` "查一查 → 转到伴聊深聊 ↗") or an
    /// ordered message list into an existing or brand-new companion session.
    pub fn import_handoff(&self, input: &Value) -> Result<Value> {
        let mut raw_messages = Vec::<(String, String, String, Value)>::new();
        if let Some(turns) = input["turns"].as_array() {
            for t in turns {
                let q = t["q"]
                    .as_str()
                    .or_else(|| t["user"].as_str())
                    .unwrap_or("")
                    .trim();
                let a = t["a"]
                    .as_str()
                    .or_else(|| t["assistant"].as_str())
                    .unwrap_or("")
                    .trim();
                if !q.is_empty() {
                    raw_messages.push(("user".into(), q.to_owned(), "research".into(), json!([])));
                }
                if !a.is_empty() {
                    raw_messages.push((
                        "assistant".into(),
                        a.to_owned(),
                        "research".into(),
                        t.get("citations")
                            .filter(|v| v.is_array())
                            .cloned()
                            .unwrap_or_else(|| json!([])),
                    ));
                }
            }
        }
        if let Some(msgs) = input["messages"].as_array() {
            for m in msgs {
                let role = m["role"].as_str().unwrap_or("user");
                let content = m["content"].as_str().unwrap_or("").trim();
                if ["user", "assistant"].contains(&role) && !content.is_empty() {
                    raw_messages.push((
                        role.to_owned(),
                        content.to_owned(),
                        m["gear"].as_str().unwrap_or("chat").to_owned(),
                        m.get("citations")
                            .filter(|v| v.is_array())
                            .cloned()
                            .unwrap_or_else(|| json!([])),
                    ));
                }
            }
        }
        let first_q = raw_messages
            .iter()
            .find(|(r, _, _, _)| r == "user")
            .map(|(_, c, _, _)| c.chars().take(24).collect::<String>())
            .unwrap_or_else(|| "转入伴聊".into());

        let session_id = if let Some(existing_sid) =
            input["sessionId"].as_str().filter(|s| !s.trim().is_empty())
        {
            existing_sid.to_owned()
        } else {
            let mut create_req = input.clone();
            if !create_req["title"].as_str().is_some_and(|s| !s.trim().is_empty()) {
                create_req["title"] = first_q.clone().into();
            }
            if !create_req["activeGear"].is_string() {
                create_req["activeGear"] = "research".into();
            }
            create_req["withGreeting"] = false.into();
            let created = self.create_session(&create_req)?;
            created["session"]["id"].as_str().unwrap_or("").to_owned()
        };

        if !raw_messages.is_empty() {
            let mut db = self.0.lock()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            crate::maintenance::guard(&tx)?;
            let real_sid = ensure_materialized_session_tx(&tx, &session_id)?;
            let now = now_iso();
            let cur_leaf: Option<String> = tx.query_row(
                "SELECT active_leaf_id FROM companion_sessions WHERE id=?1",
                [&real_sid],
                |r| r.get(0),
            )?;
            let mut parent = cur_leaf;
            let mut seq = next_message_seq_tx(&tx, &real_sid)? - 1;
            for (role, content, gear, citations) in raw_messages {
                seq += 1;
                let mid = new_id();
                tx.execute(
                    "INSERT INTO companion_messages(
                        id,session_id,parent_id,seq,role,gear,status,content,thinking,
                        steps_json,citations_json,pi_task_id,model_id,usage_json,error_text,
                        created_at,updated_at
                     ) VALUES(?1,?2,?3,?4,?5,?6,'done',?7,'','[]',?8,NULL,'',NULL,NULL,?9,?9)",
                    params![
                        mid,
                        real_sid,
                        parent,
                        seq,
                        role,
                        if ["chat", "research", "agent"].contains(&gear.as_str()) {
                            gear
                        } else {
                            "chat".into()
                        },
                        content,
                        citations.to_string(),
                        now
                    ],
                )?;
                parent = Some(mid);
            }
            if let Some(leaf) = parent {
                tx.execute(
                    "UPDATE companion_sessions SET active_leaf_id=?1, title=CASE WHEN title LIKE '与%的对话' OR title='新对话' THEN ?2 ELSE title END, updated_at=?3 WHERE id=?4",
                    params![leaf, first_q, now, real_sid],
                )?;
            }
            tx.commit()?;
            drop(db);
            return self.get_session_detail(&real_sid);
        }
        self.get_session_detail(&session_id)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sql::SqlStore;
    use std::sync::{Arc, Mutex};

    #[test]
    fn initialize_keeps_sql_store_empty_and_merges_builtin_personas() {
        let dir = tempfile::tempdir().unwrap();
        let sql = SqlStore::open(dir.path().to_path_buf()).unwrap();
        let store = CompanionStore(sql.shared());
        store.initialize().unwrap();
        assert!(
            sql.is_empty().unwrap(),
            "CompanionStore::initialize must never insert rows on fresh launch"
        );

        let personas = store.list_personas().unwrap();
        assert_eq!(personas.len(), 4);
        assert_eq!(personas[0]["id"], "builtin:lingxi");
        assert_eq!(personas[3]["id"], "builtin:tavern");
        assert_eq!(personas[3]["pureRoleplay"], true);
        assert!(sql.is_empty().unwrap(), "listing built-in personas stays read-only");

        let customized = store
            .save_persona(&json!({
                "id": "builtin:lingxi",
                "name": "灵犀·改",
                "systemPrompt": "自定义口吻",
                "roleKind": "assistant",
                "memoryScope": "persona",
            }))
            .unwrap();
        assert_eq!(customized["builtin"], true);
        assert_eq!(customized["customized"], true);

        let reset = store.delete_persona("builtin:lingxi").unwrap();
        assert_eq!(reset["resetBuiltin"], true);
        assert_eq!(store.get_persona("builtin:lingxi").unwrap()["name"], "灵犀");

        let custom = store
            .save_persona(&json!({
                "name": "沈先生",
                "tagline": "幕僚",
                "roleKind": "roleplay",
                "systemPrompt": "你是沈先生。",
                "pureRoleplay": true,
            }))
            .unwrap();
        let exported = store.export_persona(custom["id"].as_str().unwrap()).unwrap();
        assert_eq!(exported["format"], "lishi-persona-v1");
        let imported = store.import_persona(&exported).unwrap();
        assert_ne!(imported["id"], custom["id"]);
        assert_eq!(imported["name"], "沈先生");
    }

    #[test]
    fn tree_messages_support_regenerate_edit_fork_and_branch_switching() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migration::migrate(&mut conn, None).unwrap();
        let store = CompanionStore(Store(Arc::new(Mutex::new(conn))));
        store.initialize().unwrap();

        let created = store.create_session(&json!({"title":"分支测试"})).unwrap();
        let sid = created["session"]["id"].as_str().unwrap();

        let u1 = store
            .append_message(sid, &json!({"role":"user","content":"第一问"}))
            .unwrap()["message"]
            .clone();
        let a1 = store
            .append_message(sid, &json!({"role":"assistant","content":"回答A"}))
            .unwrap()["message"]
            .clone();
        // Regenerate assistant sibling under u1:
        let a2 = store
            .append_message(
                sid,
                &json!({"role":"assistant","parentId": u1["id"], "content":"回答B"}),
            )
            .unwrap()["message"]
            .clone();

        let detail = store.get_session_detail(sid).unwrap();
        let msgs = detail["messages"].as_array().unwrap();
        assert_eq!(msgs.len(), 2);
        assert_eq!(msgs[1]["id"], a2["id"]);
        assert_eq!(msgs[1]["branch"]["branchCount"], 2);
        assert_eq!(msgs[1]["branch"]["branchIndex"], 1);
        assert_eq!(msgs[1]["branchCount"], 2);
        assert_eq!(msgs[1]["branchIndex"], 1);

        // Edit user message u1 (fork at root):
        let u2 = store
            .append_message(
                sid,
                &json!({"role":"user","parentId": Value::Null, "content":"改写第一问"}),
            )
            .unwrap()["message"]
            .clone();
        let a3 = store
            .append_message(sid, &json!({"role":"assistant","content":"回答C"}))
            .unwrap()["message"]
            .clone();
        let detail_fork = store.get_session_detail(sid).unwrap();
        assert_eq!(detail_fork["messages"][0]["id"], u2["id"]);
        assert_eq!(detail_fork["messages"][0]["branch"]["branchCount"], 2);
        assert_eq!(detail_fork["messages"][1]["id"], a3["id"]);

        // Switch back to u1 -> lands on deepest latest leaf under u1 (a2), then switch to a1:
        let switched_u1 = store
            .switch_branch(sid, u1["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(switched_u1["messages"][0]["id"], u1["id"]);
        assert_eq!(switched_u1["messages"][1]["id"], a2["id"]);

        let switched_a1 = store
            .switch_branch(sid, a1["id"].as_str().unwrap())
            .unwrap();
        assert_eq!(switched_a1["messages"][1]["id"], a1["id"]);
        assert_eq!(switched_a1["messages"][1]["branch"]["branchIndex"], 0);
    }

    #[test]
    fn soft_world_binding_survives_world_deletion_and_wraps_legacy_pi_sessions() {
        let mut conn = Connection::open_in_memory().unwrap();
        conn.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migration::migrate(&mut conn, None).unwrap();
        conn.execute_batch(
            "INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('w1','大唐','tang','t','t','t');
             INSERT INTO nodes(id,world_id,seq,kind,created_at) VALUES('n1','w1',0,'opening','t');
             INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l1','w1','主线','n1','t');
             INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('old-pi','w1','l1','旧助手会话','2026-11-01T00:00:00Z','2026-11-02T00:00:00Z');",
        )
        .unwrap();
        let store = CompanionStore(Store(Arc::new(Mutex::new(conn))));
        store.initialize().unwrap();

        let list = store.list_sessions(Some("w1"), false, "", 0, 20).unwrap();
        assert_eq!(list["sessions"].as_array().unwrap().len(), 1);
        assert_eq!(list["sessions"][0]["id"], "pi:old-pi");
        assert_eq!(list["sessions"][0]["legacyPi"], true);

        let chat = store
            .create_session(&json!({
                "title": "长安夜话",
                "boundWorldId": "w1",
                "boundLineId": "l1",
            }))
            .unwrap();
        let chat_id = chat["session"]["id"].as_str().unwrap();
        store
            .append_message(chat_id, &json!({"role":"user","content":"保留这段聊天"}))
            .unwrap();

        // Deleting the world cascades lines/nodes/pi_sessions, but MUST NOT delete companion_sessions/messages!
        store
            .0
            .lock()
            .unwrap()
            .execute("DELETE FROM worlds WHERE id='w1'", [])
            .unwrap();

        let survived = store.get_session_detail(chat_id).unwrap();
        assert_eq!(survived["messages"][0]["content"], "保留这段聊天");
        assert_eq!(survived["session"]["boundWorldId"], "w1");
    }

    #[test]
    fn memory_isolation_and_char_cap_respect_persona_and_global_scopes() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut conn, None).unwrap();
        let store = CompanionStore(Store(Arc::new(Mutex::new(conn))));
        store.initialize().unwrap();

        store
            .save_memory(&json!({
                "scope": "global",
                "category": "preference",
                "content": "玩家偏爱克制冷峻的文风",
                "pinned": true,
            }))
            .unwrap();
        store
            .save_memory(&json!({
                "scope": "persona",
                "personaId": "builtin:lingxi",
                "category": "fact",
                "content": "与灵犀约定正在构思明末辽东开局",
            }))
            .unwrap();
        store
            .save_memory(&json!({
                "scope": "persona",
                "personaId": "builtin:tavern",
                "category": "relation",
                "content": "欠陆掌柜三文茶钱",
            }))
            .unwrap();

        let lingxi_mems = store
            .active_memories_for_persona("builtin:lingxi", "persona")
            .unwrap();
        assert_eq!(lingxi_mems.len(), 2);
        assert!(lingxi_mems.iter().all(|m| m["personaId"] != "builtin:tavern"));
        assert!(store
            .active_memories_for_persona("builtin:lingxi", "off")
            .unwrap()
            .is_empty());

        // Regression guard: import_handoff with non-empty turns must drop Store lock before reading detail.
        let handoff = store
            .import_handoff(&json!({
                "turns": [{"q": "王掌柜是什么来头？", "a": "西市老字号绸缎庄东家。"}],
            }))
            .unwrap();
        assert_eq!(handoff["messages"].as_array().unwrap().len(), 2);
        assert_eq!(handoff["messages"][1]["content"], "西市老字号绸缎庄东家。");
    }

    #[test]
    fn pi_tasks_summary_keeps_earlier_route_tasks_and_reconciles_dead_runs_with_attempt_id() {
        let (raw_store, gateway, live_attempt) = crate::pi_lifecycle::tests::fixture();
        crate::pi_lifecycle::settle(&raw_store, "t", &live_attempt, "收尾").unwrap();
        // Finish task 't' on route 'l' (pi session 's') as previewed:
        raw_store
            .lock()
            .unwrap()
            .execute(
                "UPDATE pi_tasks SET status='previewed', result_json='{\"summary\":\"已改好时间\"}' WHERE id='t'",
                [],
            )
            .unwrap();
        // Switch story to a second route 'l2' with a brand-new pi session 's2' and a task 't2':
        raw_store
            .lock()
            .unwrap()
            .execute_batch(
                "INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l2','w','支线','n','test');
                 UPDATE worlds SET current_line_id='l2' WHERE id='w';",
            )
            .unwrap();
        gateway
            .create_session(&crate::pi_store::NewSession {
                id: "s2".into(),
                world_id: "w".into(),
                line_id: "l2".into(),
                title: "支线任务".into(),
                session_file: None,
            })
            .unwrap();
        let row2 = gateway
            .start_task(
                "s2",
                "t2",
                "修改支线人物",
                "preview",
                false,
                json!({"model":"no-http"}),
                json!({}),
            )
            .unwrap();
        let attempt2 =
            crate::pi_lifecycle::attempt(&json!({"lease_json": row2["lease_json"].to_string()}));
        assert_ne!(live_attempt, attempt2);

        let comp = CompanionStore(raw_store.clone());
        comp.initialize().unwrap();
        let created = comp
            .create_session(&json!({
                "title": "跨路线改档伴聊",
                "boundWorldId": "w",
                "boundLineId": "l2",
                "piSessionId": "s2",
                "activeGear": "agent",
            }))
            .unwrap();
        let cid = created["session"]["id"].as_str().unwrap();
        // Earlier message linked to task 't' from old pi_session 's':
        comp.append_message(
            cid,
            &json!({"role":"assistant","gear":"agent","content":"已完成第一处","piTaskId":"t"}),
        )
        .unwrap();
        comp.append_message(
            cid,
            &json!({"role":"assistant","gear":"agent","content":"正在改支线","piTaskId":"t2"}),
        )
        .unwrap();

        // While lease is live, 't2' reports running with non-empty execution.attemptId, AND 't' from 's' is still returned!
        let live_detail = comp.get_session_detail(cid).unwrap();
        let live_tasks = live_detail["piTasks"].as_array().unwrap();
        assert_eq!(live_tasks.len(), 2);
        let t1_card = live_tasks.iter().find(|x| x["id"] == "t").unwrap();
        assert_eq!(t1_card["status"], "previewed");
        assert_eq!(t1_card["summary"], "已改好时间");
        let t2_card = live_tasks.iter().find(|x| x["id"] == "t2").unwrap();
        assert_eq!(t2_card["status"], "running");
        assert_eq!(t2_card["execution"]["attemptId"], attempt2);

        // Once the execution lease expires, load_pi_tasks_summary (even directly on &Connection) reports 'interrupted'!
        raw_store
            .lock()
            .unwrap()
            .execute("UPDATE world_execution_leases SET expires_at_ms=0", [])
            .unwrap();
        let direct = load_pi_tasks_summary(&raw_store.lock().unwrap(), "s2", Some(cid)).unwrap();
        let t2_dead = direct.iter().find(|x| x["id"] == "t2").unwrap();
        assert_eq!(t2_dead["status"], "interrupted");
        assert_eq!(t2_dead["execution"]["attemptId"], attempt2);
    }
}
