//! Native low-latency Companion ("伴聊") execution engine for `Chat` and
//! `Research` gears (R33-T002, D187).
//!
//! - Zero Node.js cold start and zero `world_execution_leases` lock contention:
//!   story turns and companion chats run concurrently without blocking each other.
//! - Long-poll `snapshot(runId, afterSeq, waitMs)` wakes via `tokio::sync::Notify`.
//! - `Research` gear strictly clamps `through` to the attached world's reading
//!   ceiling so original-book RAG never leaks future-chapter spoilers.

use crate::{
    chat::{self, Completion, Model, TextSink},
    companion_store::{
        active_memories_for_persona_db, ensure_materialized_session_tx, ensure_schema_db,
        get_session_db, load_session_messages_db, next_message_seq_tx, project_active_branch,
        resolve_persona_db, CompanionStore, DEFAULT_PERSONA_ID, MEMORY_PROMPT_CHAR_CAP,
    },
    runtime::LeaseFactory,
    Error, ModelConfig, Result, RunPlan, Store,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex, MutexGuard},
    time::{Duration, Instant},
};
use tokio::sync::Notify;
use tokio_util::sync::CancellationToken;

const CHAT_RECENT_MESSAGES: usize = 16;
const CHAT_WINDOW_CHAR_BUDGET: usize = 24_000;
const RESEARCH_MAX_ROUNDS: usize = 4;
const RESEARCH_MAX_TOOL_CALLS: usize = 12;
const COMPACT_PROMPT_VERSION: &str = "companion-compact-1";

fn lock_unpoison<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex.lock().unwrap_or_else(|poisoned| {
        mutex.clear_poison();
        poisoned.into_inner()
    })
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

fn clipped(text: &str, max_chars: usize) -> String {
    let mut out: String = text.chars().take(max_chars).collect();
    if text.chars().count() > max_chars {
        out.push('…');
    }
    out
}

#[derive(Clone, Debug)]
struct LiveState {
    seq: u64,
    status: String,
    phase: String,
    content: String,
    thinking: String,
    steps: Vec<Value>,
    citations: Vec<Value>,
    usage: Option<Value>,
    error_text: Option<String>,
    settled_in_db: bool,
}

struct ActiveCompanionRun {
    run_id: String,
    session_id: String,
    gear: String,
    world_id: Option<String>,
    model_name: String,
    cancel: CancellationToken,
    live: Mutex<LiveState>,
    notify: Notify,
}

impl ActiveCompanionRun {
    fn bump(&self, mutate: impl FnOnce(&mut LiveState)) {
        {
            let mut live = lock_unpoison(&self.live);
            mutate(&mut live);
            live.seq = live.seq.saturating_add(1);
        }
        self.notify.notify_waiters();
    }

    fn snapshot_json(&self) -> Value {
        let live = lock_unpoison(&self.live);
        let done = live.status != "streaming";
        json!({
            "runId": self.run_id,
            "sessionId": self.session_id,
            "messageId": self.run_id,
            "seq": live.seq,
            "status": live.status,
            "phase": live.phase,
            "content": live.content,
            "thinking": live.thinking,
            "steps": live.steps,
            "citations": live.citations,
            "usage": live.usage,
            "errorText": live.error_text,
            "done": done,
        })
    }
}

pub struct CompanionRuntime {
    pub store: CompanionStore,
    pub(crate) model: Arc<dyn Model>,
    active: Mutex<HashMap<String, Arc<ActiveCompanionRun>>>,
    lease: LeaseFactory,
}

struct PreparedRun {
    run_id: String,
    session_id: String,
    gear: String,
    model: ModelConfig,
    fallback_model: Option<ModelConfig>,
    network: Value,
    bound_world_id: Option<String>,
    bound_line_id: Option<String>,
    bound_book_id: Option<String>,
    book_scope: Option<Value>,
    messages: Vec<Value>,
    user_message: Option<Value>,
    assistant_message: Value,
}

#[derive(Default)]
struct UsageTotals {
    prompt_tokens: Option<i64>,
    completion_tokens: Option<i64>,
    first_token_ms: Option<i64>,
    total_ms: i64,
    request_chars: usize,
}

impl UsageTotals {
    fn absorb(&mut self, reply: &Completion) {
        if self.first_token_ms.is_none() {
            self.first_token_ms = reply.first_token_ms.map(|n| n as i64);
        }
        self.total_ms = self.total_ms.saturating_add(reply.total_ms as i64);
        if let Some(u) = &reply.usage {
            if let Some(p) = u["prompt_tokens"]
                .as_i64()
                .or_else(|| u["input_tokens"].as_i64())
            {
                self.prompt_tokens = Some(self.prompt_tokens.unwrap_or(0).saturating_add(p));
            }
            if let Some(c) = u["completion_tokens"]
                .as_i64()
                .or_else(|| u["output_tokens"].as_i64())
            {
                self.completion_tokens = Some(self.completion_tokens.unwrap_or(0).saturating_add(c));
            }
        }
    }

    fn json_with_fallback(&self, output_text: &str, thinking_text: &str, elapsed_ms: u64) -> (Value, i64, i64, bool) {
        let estimated = self.prompt_tokens.is_none() || self.completion_tokens.is_none();
        let prompt = self
            .prompt_tokens
            .unwrap_or_else(|| (self.request_chars as i64).max(1));
        let completion = self.completion_tokens.unwrap_or_else(|| {
            (output_text.chars().count() + thinking_text.chars().count()) as i64
        });
        let total_ms = if self.total_ms > 0 {
            self.total_ms
        } else {
            elapsed_ms as i64
        };
        let val = json!({
            "promptTokens": prompt,
            "completionTokens": completion,
            "firstTokenMs": self.first_token_ms,
            "totalMs": total_ms,
            "estimated": estimated,
        });
        (val, prompt, completion, estimated)
    }
}

fn extract_completion_thinking(reply: &Completion) -> Option<String> {
    for key in ["thinking_text", "reasoning_content", "reasoning"] {
        if let Some(s) = reply.continuation.get(key).and_then(Value::as_str) {
            if !s.trim().is_empty() {
                return Some(s.to_owned());
            }
        }
    }
    None
}

fn read_world_snapshot_db(
    db: &Connection,
    world_id: &str,
    preferred_line_id: Option<&str>,
) -> Result<Option<(String, String, String, Value)>> {
    let row: Option<(String, String, String, String)> = if let Some(line_id) =
        preferred_line_id.filter(|s| !s.is_empty())
    {
        db.query_row(
            "SELECT w.title, l.id, l.node_id, s.state_json
             FROM worlds w
             JOIN lines l ON l.world_id=w.id AND l.id=?2
             JOIN states s ON s.node_id=l.node_id
             WHERE w.id=?1",
            params![world_id, line_id],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
        )
        .optional()?
    } else {
        None
    };
    let row = match row {
        Some(found) => Some(found),
        None => db
            .query_row(
                "SELECT w.title, l.id, l.node_id, s.state_json
                 FROM worlds w
                 JOIN lines l ON l.id=w.current_line_id AND l.world_id=w.id
                 JOIN states s ON s.node_id=l.node_id
                 WHERE w.id=?1",
                [world_id],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?)),
            )
            .optional()?,
    };
    let Some((title, line_id, head_id, state_raw)) = row else {
        return Ok(None);
    };
    let state: Value = serde_json::from_str(&state_raw).unwrap_or_else(|_| json!({}));
    Ok(Some((title, line_id, head_id, state)))
}

fn format_world_brief_header(title: &str, state: &Value) -> String {
    let hero = &state["protagonist"];
    let hero_name = hero["name"].as_str().unwrap_or("主角");
    let hero_id = hero["identity"].as_str().unwrap_or("").trim();
    let time_str = state["time"]["start"].as_str().unwrap_or("");
    let place_name = state["placeId"]
        .as_str()
        .and_then(|pid| {
            state["places"]
                .as_array()?
                .iter()
                .find(|p| p["id"].as_str() == Some(pid))
                .and_then(|p| p["name"].as_str())
        })
        .unwrap_or("");
    let goals: Vec<&str> = state["goals"]
        .as_array()
        .map(|arr| {
            arr.iter()
                .filter(|g| g["status"].as_str() == Some("进行中"))
                .filter_map(|g| g["name"].as_str())
                .take(4)
                .collect()
        })
        .unwrap_or_default();
    let mut lines = vec![format!("故事：《{title}》｜主角：{hero_name}")];
    if !hero_id.is_empty() {
        lines.push(format!("当前身份：{}", clipped(hero_id, 120)));
    }
    if !time_str.is_empty() || !place_name.is_empty() {
        lines.push(format!(
            "时间地点：{}{}",
            if time_str.is_empty() { "未定" } else { time_str },
            if place_name.is_empty() {
                String::new()
            } else {
                format!(" · {place_name}")
            }
        ));
    }
    if !goals.is_empty() {
        lines.push(format!("进行中目标：{}", goals.join("；")));
    }
    lines.join("\n")
}

fn build_system_prompt(
    persona: &Value,
    gear: &str,
    memories: &[Value],
    summary_text: &str,
    world_brief: Option<&str>,
    has_book_tools: bool,
    has_web_tools: bool,
    has_world_tool: bool,
) -> String {
    let pure = persona["pureRoleplay"].as_bool().unwrap_or(false) && gear == "chat";
    let base = persona["systemPrompt"].as_str().unwrap_or("").trim();
    let style = persona["styleNotes"].as_str().unwrap_or("").trim();
    let name = persona["name"].as_str().unwrap_or("伴聊伙伴");
    let mut sections = Vec::<String>::new();
    sections.push(base.to_owned());

    if !style.is_empty() {
        sections.push(format!(
            "{}\n{}",
            if pure { "【神态与语气】" } else { "【表达风格】" },
            style
        ));
    }
    if pure {
        sections.push(format!(
            "请始终以「{name}」本人第一人称在情境中自然交谈与行动，保持人物知情边界与性格一致，绝不提及AI、语言模型、提示词或系统规则。"
        ));
    } else if gear == "research" {
        let mut tool_notes = Vec::new();
        if has_book_tools {
            tool_notes.push("可用 list_sections / search_original / read_original / read_canon_notes 检索允许范围内的原著目录、原文与札记（工具参数 section 为 0 起始内部索引，向用户提及节号时请使用 1 起始的 sectionNumber 即“第 N 节”或原章节标题；先查后答，引用真实原句，绝不剧透或编造超出允许范围的章节）");
        }
        if has_world_tool {
            tool_notes.push("可用 read_world_brief 查阅当前挂载故事的人物、设定、目标与近期摘要");
        }
        if has_web_tools {
            tool_notes.push("可用 web_search / read_webpage 检索外部公开资料并核对网页正文");
        }
        sections.push(format!(
            "【查资料模式（只读）】\n你正在帮助用户查证资料，不会修改任何故事存档。{}。有几分证据说几分话，未查到的内容坦诚说明。",
            tool_notes.join("；")
        ));
    }
    if !pure {
        if let Some(brief) = world_brief.filter(|s| !s.trim().is_empty()) {
            sections.push(format!("【当前挂载故事（只读背景）】\n{brief}"));
        }
    }
    if !memories.is_empty() {
        let mem_lines: Vec<String> = memories
            .iter()
            .filter_map(|m| {
                let c = m["content"].as_str()?.trim();
                (!c.is_empty()).then(|| format!("- {c}"))
            })
            .collect();
        if !mem_lines.is_empty() {
            sections.push(format!(
                "{}\n{}",
                if pure {
                    "【你记得的往事与对方情况】"
                } else {
                    "【长期记忆】"
                },
                mem_lines.join("\n")
            ));
        }
    }
    if !summary_text.trim().is_empty() {
        sections.push(format!(
            "{}\n{}",
            if pure {
                "【此前交谈梗概】"
            } else {
                "【前文对话摘要】"
            },
            summary_text.trim()
        ));
    }
    sections.join("\n\n")
}

/// Ensures wire messages after `system` start with `user` and merge adjacent
/// identical roles so Anthropic / Gemini / DeepSeek-Reasoner never 400.
fn build_wire_messages(
    system_prompt: String,
    branch_messages: &[Value],
    summary_up_to_id: Option<&str>,
    max_messages: usize,
    char_budget: usize,
) -> Vec<Value> {
    let mut start_idx = 0usize;
    let mut leading_greeting: Option<String> = None;
    if let Some(up_to) = summary_up_to_id.filter(|s| !s.is_empty()) {
        if let Some(pos) = branch_messages
            .iter()
            .position(|m| m["id"].as_str() == Some(up_to))
        {
            start_idx = pos + 1;
        }
    }
    let slice = &branch_messages[start_idx..];
    let usable: Vec<&Value> = slice
        .iter()
        .filter(|m| {
            matches!(m["role"].as_str(), Some("user" | "assistant"))
                && !m["content"].as_str().unwrap_or("").trim().is_empty()
                && m["status"].as_str() != Some("streaming")
        })
        .collect();

    let tail_start = usable.len().saturating_sub(max_messages);
    let mut window: Vec<&Value> = Vec::new();
    let mut used_chars = 0usize;
    for msg in usable[tail_start..].iter().rev() {
        let len = msg["content"].as_str().unwrap_or("").chars().count();
        if !window.is_empty() && used_chars + len > char_budget {
            break;
        }
        used_chars += len;
        window.push(*msg);
    }
    window.reverse();

    if window
        .first()
        .is_some_and(|m| m["role"].as_str() == Some("assistant"))
    {
        leading_greeting = window
            .remove(0)["content"]
            .as_str()
            .map(|s| s.trim().to_owned());
    }

    let final_system = match leading_greeting.filter(|s| !s.is_empty()) {
        Some(greet) => format!("{system_prompt}\n\n【开场白】\n{greet}"),
        None => system_prompt,
    };

    let mut out = vec![json!({ "role": "system", "content": final_system })];
    for msg in window {
        let role = msg["role"].as_str().unwrap_or("user");
        let content = msg["content"].as_str().unwrap_or("").trim();
        if content.is_empty() {
            continue;
        }
        if let Some(last) = out.last_mut().filter(|l| l["role"].as_str() == Some(role)) {
            let joined = format!("{}\n\n{}", last["content"].as_str().unwrap_or(""), content);
            last["content"] = joined.into();
        } else {
            out.push(json!({ "role": role, "content": content }));
        }
    }
    out
}

fn research_tool_definitions(has_book: bool, has_web: bool, has_world: bool) -> Vec<Value> {
    let mut defs = Vec::new();
    if has_book {
        let book_names = [
            "list_sections",
            "search_original",
            "read_original",
            "read_canon_notes",
        ];
        for tool in crate::tools::catalog() {
            if book_names.contains(&tool.name) {
                defs.push(tool.function());
            }
        }
    }
    if has_world {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "read_world_brief",
                "description": "只读查阅当前挂载故事的主角现状、人物关系、设定集卡片、目标与近期章节摘要。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "可选的人物名、地点、设定或情节关键词",
                            "minLength": 0,
                            "maxLength": 400
                        }
                    },
                    "additionalProperties": false
                }
            }
        }));
    }
    if has_web {
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "web_search",
                "description": "使用已配置的联网搜索能力检索公开资料，返回带真实 URL 的来源摘要。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "query": {
                            "type": "string",
                            "description": "搜索关键词",
                            "minLength": 1,
                            "maxLength": 400
                        }
                    },
                    "required": ["query"],
                    "additionalProperties": false
                }
            }
        }));
        defs.push(json!({
            "type": "function",
            "function": {
                "name": "read_webpage",
                "description": "读取指定公开 HTTP/HTTPS 网页的正文摘录以核对细节。",
                "parameters": {
                    "type": "object",
                    "properties": {
                        "url": {
                            "type": "string",
                            "description": "完整网页地址",
                            "minLength": 8,
                            "maxLength": 2048
                        },
                        "offset": {
                            "type": "integer",
                            "description": "起始字符偏移",
                            "minimum": 0,
                            "maximum": 2000000
                        },
                        "limit": {
                            "type": "integer",
                            "description": "最多读取字符数",
                            "minimum": 200,
                            "maximum": 16000
                        }
                    },
                    "required": ["url"],
                    "additionalProperties": false
                }
            }
        }));
    }
    defs
}

fn tool_label(name: &str) -> &'static str {
    match name {
        "list_sections" => "查阅原著目录",
        "search_original" => "检索原著原文",
        "read_original" => "精读原著片段",
        "read_canon_notes" => "查阅原著与本局札记",
        "read_world_brief" => "查阅当前故事设定",
        "web_search" => "联网检索资料",
        "read_webpage" => "读取网页正文",
        _ => "查阅资料",
    }
}

fn tool_query_preview(name: &str, args: &Value) -> String {
    match name {
        "read_webpage" => args["url"].as_str().unwrap_or("").to_owned(),
        "read_original" => {
            if let Some(sec) = args["section"].as_i64().or_else(|| args["ref"]["section"].as_i64()) {
                format!("第 {} 节", sec + 1)
            } else {
                String::new()
            }
        }
        _ => args["query"].as_str().unwrap_or("").trim().to_owned(),
    }
}

fn push_unique_citation(citations: &mut Vec<Value>, candidate: Value) {
    if citations.len() >= 24 {
        return;
    }
    let is_dup = citations.iter().any(|c| {
        c["kind"] == candidate["kind"]
            && match candidate["kind"].as_str() {
                Some("web") => !candidate["url"].is_null() && c["url"] == candidate["url"],
                Some("book") => {
                    c["bookId"] == candidate["bookId"]
                        && c["section"] == candidate["section"]
                        && c["chunk"] == candidate["chunk"]
                        && c["title"] == candidate["title"]
                }
                _ => c["title"] == candidate["title"] && c["quote"] == candidate["quote"],
            }
    });
    if !is_dup {
        citations.push(candidate);
    }
}

/// Builds the synthetic `RunPlan` for `runtime_sources::read_db`, strictly
/// enforcing `world_source.through` whenever `bound_world_id` has a book binding.
fn build_synthetic_source_plan(
    db: &Connection,
    model: &ModelConfig,
    bound_world_id: Option<&str>,
    bound_line_id: Option<&str>,
    bound_book_id: Option<&str>,
    book_scope: Option<&Value>,
) -> Result<Option<RunPlan>> {
    let mut world_id = String::new();
    let mut line_id = String::new();
    let mut head_id = String::new();
    let mut state = json!({});
    let mut world_source: Option<Value> = None;

    if let Some(wid) = bound_world_id.filter(|s| !s.is_empty()) {
        if let Some((_title, lid, hid, st)) = read_world_snapshot_db(db, wid, bound_line_id)? {
            world_id = wid.to_owned();
            line_id = lid;
            head_id = hid;
            if st["source"]["bookId"].is_string() {
                world_source = Some(st["source"].clone());
            }
            state = st;
        }
    }

    let effective_source = if let Some(ws) = world_source {
        // CRITICAL SPOILER FENCE: When attached to a world with a bound book,
        // `ws["through"]` is the hard ceiling. `book_scope` can narrow it, NEVER widen it!
        ws
    } else if let Some(bid) = bound_book_id.filter(|s| !s.is_empty()) {
        let through = match book_scope {
            Some(scope) if scope["mode"] == "chapters" && scope["to"].is_i64() => scope["to"].clone(),
            _ => Value::Null,
        };
        json!({
            "bookId": bid,
            "through": through,
            "position": 0,
            "mode": "reference",
            "instructions": "",
        })
    } else {
        return Ok(None);
    };

    state["source"] = effective_source.clone();
    let mut meta = json!({ "budgetChars": 16_000 });
    if let Some(scope) = book_scope.filter(|v| v["mode"] == "chapters") {
        if let (Some(from), Some(to)) = (scope["from"].as_i64(), scope["to"].as_i64()) {
            let clamped_to = match effective_source["through"].as_i64() {
                Some(ceiling) => to.min(ceiling),
                None => to,
            };
            let clamped_from = from.max(0).min(clamped_to.max(0));
            meta["sourceScope"] = json!({
                "mode": "chapters",
                "from": clamped_from,
                "to": clamped_to.max(clamped_from),
            });
        }
    }

    Ok(Some(RunPlan {
        id: "companion-research".into(),
        world_id,
        line_id,
        head_id,
        base_id: None,
        kind: "ask".into(),
        model: model.clone(),
        messages: vec![],
        extract_messages: vec![],
        state,
        settings: json!({}),
        options: json!({}),
        action: json!({"mode":"continue","text":""}),
        meta,
        reference: None,
        original: String::new(),
        carried_edits: vec![],
        trailing_ids: vec![],
        new_world: None,
        fallback_model: None,
    }))
}

fn execute_world_brief_db(
    db: &Connection,
    world_id: &str,
    line_id: Option<&str>,
    query: &str,
) -> Result<(Value, String, Vec<Value>)> {
    let Some((title, _lid, head_id, state)) = read_world_snapshot_db(db, world_id, line_id)? else {
        return Err(invalid("当前挂载的故事不存在或已被删除"));
    };
    let q = query.trim().to_lowercase();
    let matches_q = |hay: &str| q.is_empty() || hay.to_lowercase().contains(&q);
    let people: Vec<Value> = state["people"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|p| {
            matches_q(&format!(
                "{} {} {}",
                p["name"].as_str().unwrap_or(""),
                p["role"].as_str().unwrap_or(""),
                p["notes"].as_str().unwrap_or("")
            ))
        })
        .take(12)
        .map(|p| {
            json!({
                "name": p["name"],
                "aliases": p["aliases"],
                "role": p["role"],
                "attitude": p["attitude"],
                "alive": p["alive"],
                "notes": p["notes"],
            })
        })
        .collect();
    let cards: Vec<Value> = state["cards"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| {
            matches_q(&format!(
                "{} {}",
                c["name"].as_str().unwrap_or(""),
                c["content"].as_str().unwrap_or("")
            ))
        })
        .take(8)
        .map(|c| {
            json!({
                "kind": c["kind"],
                "name": c["name"],
                "content": clipped(c["content"].as_str().unwrap_or(""), 300),
            })
        })
        .collect();
    let goals: Vec<Value> = state["goals"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|g| g["status"] == "进行中" || !q.is_empty())
        .take(8)
        .map(|g| json!({"name": g["name"], "kind": g["kind"], "status": g["status"], "progress": g["progress"]}))
        .collect();

    let recent_chapters: Vec<String> = {
        let mut stmt = db.prepare(
            "WITH RECURSIVE route(id,parent_id) AS (
                SELECT id,parent_id FROM nodes WHERE world_id=?1 AND id=?2
                UNION ALL SELECT n.id,n.parent_id FROM nodes n JOIN route r ON n.id=r.parent_id WHERE n.world_id=?1
             )
             SELECT summary FROM chapters
             WHERE world_id=?1 AND last_node_id IN (SELECT id FROM route)
             ORDER BY created_at DESC LIMIT 3",
        )?;
        let rows = stmt
            .query_map(params![world_id, head_id], |r| r.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        rows
    };

    let output = json!({
        "worldId": world_id,
        "title": title,
        "protagonist": {
            "name": state["protagonist"]["name"],
            "gender": state["protagonist"]["gender"],
            "age": state["protagonist"]["age"],
            "identity": state["protagonist"]["identity"],
            "statuses": state["protagonist"]["statuses"],
        },
        "time": state["time"]["start"],
        "goals": goals,
        "people": people,
        "cards": cards,
        "recentChapterSummaries": recent_chapters,
    });
    let summary = format!(
        "读取《{}》人物 {} 位、设定 {} 张",
        title,
        output["people"].as_array().map(Vec::len).unwrap_or(0),
        output["cards"].as_array().map(Vec::len).unwrap_or(0)
    );
    let cite = vec![json!({
        "kind": "world",
        "title": format!("《{}》本局资料", title),
        "quote": format_world_brief_header(&title, &state),
    })];
    Ok((output, summary, cite))
}

fn execute_book_tool_db(
    store: &Store,
    prep: &PreparedRun,
    name: &str,
    args: &Value,
) -> Result<(Value, String, Vec<Value>)> {
    let db = store.lock()?;
    let Some(plan) = build_synthetic_source_plan(
        &db,
        &prep.model,
        prep.bound_world_id.as_deref(),
        prep.bound_line_id.as_deref(),
        prep.bound_book_id.as_deref(),
        prep.book_scope.as_ref(),
    )?
    else {
        return Err(invalid("当前未挂载参考书籍"));
    };
    let mut output = crate::runtime_sources::read_db(&db, &plan, name, args)?;
    if let Some(arr) = output.get_mut("sections").and_then(Value::as_array_mut) {
        for sec in arr {
            if let Some(idx) = sec.get("section").and_then(Value::as_i64) {
                sec["sectionNumber"] = json!(idx + 1);
            }
        }
    }
    if let Some(arr) = output.get_mut("excerpts").and_then(Value::as_array_mut) {
        for ex in arr {
            if let Some(idx) = ex.get("section").and_then(Value::as_i64) {
                ex["sectionNumber"] = json!(idx + 1);
            }
        }
    }
    let mut cites = Vec::new();
    let summary = match name {
        "list_sections" => {
            let n = output["sections"].as_array().map(Vec::len).unwrap_or(0);
            format!(
                "列出 {} 节目录（允许范围至第 {} 节）",
                n,
                output["through"].as_i64().unwrap_or(0) + 1
            )
        }
        "search_original" | "read_original" => {
            let excerpts = output["excerpts"].as_array().cloned().unwrap_or_default();
            for ex in &excerpts {
                if ex["kind"] == "original" && ex["match"] != "nearby" {
                    cites.push(json!({
                        "kind": "book",
                        "bookId": ex["bookId"],
                        "title": ex["title"],
                        "section": ex["section"],
                        "chunk": ex["chunk"],
                        "quote": clipped(ex["text"].as_str().unwrap_or(""), 220),
                    }));
                }
            }
            if excerpts.is_empty() {
                "未命中原文".into()
            } else if name == "search_original" {
                format!("命中 {} 段原文", cites.len().max(excerpts.len()))
            } else {
                format!("读到 {} 段原文摘录", excerpts.len())
            }
        }
        "read_canon_notes" => {
            let notes = output["notes"].as_array().cloned().unwrap_or_default();
            for n in &notes {
                let is_story = n["source"] == "story";
                cites.push(json!({
                    "kind": if is_story { "world" } else { "book" },
                    "bookId": if is_story { Value::Null } else { output["bookId"].clone() },
                    "title": format!("札记·{}", n["title"].as_str().unwrap_or("")),
                    "quote": clipped(n["content"].as_str().unwrap_or(""), 200),
                }));
            }
            format!("查阅到 {} 份相关札记", notes.len())
        }
        _ => "已完成查阅".into(),
    };
    Ok((output, summary, cites))
}

fn settle_run_db(
    store: &Store,
    run: &ActiveCompanionRun,
    totals: &UsageTotals,
    elapsed_ms: u64,
) -> Result<Option<Value>> {
    let (status, content, thinking, steps, citations, error_text, already) = {
        let live = lock_unpoison(&run.live);
        (
            live.status.clone(),
            live.content.clone(),
            live.thinking.clone(),
            live.steps.clone(),
            live.citations.clone(),
            live.error_text.clone(),
            live.settled_in_db,
        )
    };
    if already {
        return Ok(None);
    }
    let (usage_json, prompt_tokens, completion_tokens, estimated) =
        totals.json_with_fallback(&content, &thinking, elapsed_ms);
    let outcome = match status.as_str() {
        "done" => "ok",
        "cancelled" => "cancelled",
        _ => "failed",
    };
    let purpose = if run.gear == "research" {
        "companion:research"
    } else {
        "companion:chat"
    };

    let mut db = store.lock()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let now = now_iso();
    let msg_exists: bool = tx.query_row(
        "SELECT EXISTS(SELECT 1 FROM companion_messages WHERE id=?1)",
        [&run.run_id],
        |r| r.get(0),
    )?;
    if msg_exists {
        tx.execute(
            "UPDATE companion_messages SET
                status=?1, content=?2, thinking=?3, steps_json=?4, citations_json=?5,
                usage_json=?6, error_text=?7, updated_at=?8
             WHERE id=?9",
            params![
                status,
                content,
                thinking,
                serde_json::to_string(&steps)?,
                serde_json::to_string(&citations)?,
                usage_json.to_string(),
                error_text.as_deref(),
                now,
                run.run_id
            ],
        )?;
        tx.execute(
            "UPDATE companion_sessions SET updated_at=?1 WHERE id=?2",
            params![now, run.session_id],
        )?;
    }
    if !(status == "failed" && prompt_tokens <= 1 && completion_tokens == 0 && totals.total_ms == 0) {
        let usage_id = format!("companion:{}", run.run_id);
        tx.execute(
            "INSERT INTO usage(id,world_id,node_id,purpose,profile_id,model,prompt_tokens,
                               completion_tokens,estimated,first_token_ms,total_ms,outcome,at)
             VALUES(?1,?2,NULL,?3,NULL,?4,?5,?6,?7,?8,?9,?10,?11)
             ON CONFLICT(id) DO UPDATE SET
                prompt_tokens=excluded.prompt_tokens,
                completion_tokens=excluded.completion_tokens,
                estimated=excluded.estimated,
                total_ms=excluded.total_ms,
                outcome=excluded.outcome",
            params![
                usage_id,
                run.world_id.as_deref(),
                purpose,
                run.model_name,
                prompt_tokens,
                completion_tokens,
                i64::from(estimated),
                totals.first_token_ms,
                usage_json["totalMs"].as_i64(),
                outcome,
                now
            ],
        )?;
    }
    tx.commit()?;
    {
        let mut live = lock_unpoison(&run.live);
        live.usage = Some(usage_json.clone());
        live.settled_in_db = true;
        live.seq = live.seq.saturating_add(1);
    }
    run.notify.notify_waiters();
    Ok(Some(usage_json))
}

impl CompanionRuntime {
    pub fn new(store: Store, model: Arc<dyn Model>) -> Self {
        Self::with_lease(store, model, Arc::new(|_| Box::new(())))
    }

    pub fn with_lease(store: Store, model: Arc<dyn Model>, lease: LeaseFactory) -> Self {
        Self {
            store: CompanionStore(store),
            model,
            active: Mutex::new(HashMap::new()),
            lease,
        }
    }

    pub async fn shutdown(&self) {
        let runs: Vec<Arc<ActiveCompanionRun>> = {
            let active = lock_unpoison(&self.active);
            active.values().cloned().collect()
        };
        for r in &runs {
            r.cancel.cancel();
        }
        let _ = tokio::time::timeout(Duration::from_secs(6), async {
            loop {
                if lock_unpoison(&self.active).is_empty() {
                    break;
                }
                tokio::time::sleep(Duration::from_millis(15)).await;
            }
        })
        .await;
    }

    pub async fn dispatch(self: &Arc<Self>, request: Value) -> Result<Value> {
        let op = request["op"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("伴聊请求缺少操作类型 op"))?;
        match op {
            "send" => self.start_send(request),
            "snapshot" => self.snapshot(&request).await,
            "stop" => self.stop(&request).await,
            "compact" => self.compact(request).await,
            "shutdown" => {
                self.shutdown().await;
                Ok(json!({ "ok": true }))
            }
            _ => {
                let rt = Arc::clone(self);
                tokio::task::spawn_blocking(move || dispatch_store_op(&rt, &request))
                    .await
                    .map_err(|_| invalid("伴聊本地数据操作中断"))?
            }
        }
    }

    fn start_send(self: &Arc<Self>, request: Value) -> Result<Value> {
        let raw_session_id = request["sessionId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("缺少伴聊会话标识"))?;
        let model: ModelConfig = serde_json::from_value(request["model"].clone())
            .map_err(|_| invalid("请先配置可用的 AI 服务与模型"))?;
        let fallback_model: Option<ModelConfig> = request
            .get("fallbackModel")
            .filter(|v| v.is_object())
            .cloned()
            .map(serde_json::from_value)
            .transpose()
            .map_err(|_| invalid("备用模型配置格式无效"))?;

        let prep = self.prepare_send_db(raw_session_id, &request, model, fallback_model)?;
        let run = Arc::new(ActiveCompanionRun {
            run_id: prep.run_id.clone(),
            session_id: prep.session_id.clone(),
            gear: prep.gear.clone(),
            world_id: prep.bound_world_id.clone(),
            model_name: prep.model.model.clone(),
            cancel: CancellationToken::new(),
            live: Mutex::new(LiveState {
                seq: 1,
                status: "streaming".into(),
                phase: "thinking".into(),
                content: String::new(),
                thinking: String::new(),
                steps: vec![],
                citations: vec![],
                usage: None,
                error_text: None,
                settled_in_db: false,
            }),
            notify: Notify::new(),
        });
        {
            let mut active = lock_unpoison(&self.active);
            active.insert(prep.run_id.clone(), run.clone());
        }

        let response = json!({
            "runId": prep.run_id,
            "sessionId": prep.session_id,
            "userMessage": prep.user_message,
            "assistantMessage": prep.assistant_message,
        });

        let runtime = Arc::clone(self);
        let guard = (self.lease)(crate::chat::REQUEST_BACKSTOP_MS);
        tokio::spawn(async move {
            let _keep_alive = guard;
            runtime.execute_run(prep, run).await;
        });

        Ok(response)
    }

    fn prepare_send_db(
        &self,
        raw_session_id: &str,
        request: &Value,
        model: ModelConfig,
        fallback_model: Option<ModelConfig>,
    ) -> Result<PreparedRun> {
        let mut db = self.store.0.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        crate::maintenance::guard(&tx)?;
        ensure_schema_db(&tx)?;

        let session_id = ensure_materialized_session_tx(&tx, raw_session_id)?;
        {
            let active = lock_unpoison(&self.active);
            if active.values().any(|r| r.session_id == session_id) {
                return Err(Error::Busy {
                    holder: "companion".into(),
                    until_ms: 0,
                });
            }
        }

        let session =
            get_session_db(&tx, &session_id)?.ok_or_else(|| invalid("找不到这段伴聊会话"))?;
        let gear = request["gear"]
            .as_str()
            .or_else(|| session["activeGear"].as_str())
            .map(|g| if g == "research" { "research" } else { "chat" })
            .unwrap_or("chat")
            .to_owned();

        let persona = resolve_persona_db(
            &tx,
            session["personaId"].as_str().unwrap_or(DEFAULT_PERSONA_ID),
            session["metadata"].get("personaSnapshot"),
        )?;
        let memories = active_memories_for_persona_db(
            &tx,
            persona["id"].as_str().unwrap_or(DEFAULT_PERSONA_ID),
            persona["memoryScope"].as_str().unwrap_or("persona"),
            MEMORY_PROMPT_CHAR_CAP,
        )?;

        let existing_all = load_session_messages_db(&tx, &session_id)?;
        let now = now_iso();
        let mut user_msg_val: Option<Value> = None;
        let assistant_parent_id: String;

        if let Some(regen_id) = request["regenerateMessageId"]
            .as_str()
            .filter(|s| !s.is_empty())
        {
            let target = existing_all
                .iter()
                .find(|m| m.id == regen_id)
                .ok_or_else(|| invalid("找不到要重新生成的回复"))?;
            if target.value["role"] == "user" {
                assistant_parent_id = target.id.clone();
            } else {
                assistant_parent_id = target
                    .parent_id
                    .clone()
                    .ok_or_else(|| invalid("开场问候不能直接重答，请发送一条新消息"))?;
            }
        } else {
            let user_text = request["text"].as_str().unwrap_or("").trim();
            if user_text.is_empty() {
                return Err(invalid("请输入要发送的内容"));
            }
            if user_text.chars().count() > 32_000 {
                return Err(invalid("单次发送内容请控制在 32,000 字以内"));
            }
            let user_parent: Option<String> = if let Some(edit_id) =
                request["editMessageId"].as_str().filter(|s| !s.is_empty())
            {
                let edited = existing_all
                    .iter()
                    .find(|m| m.id == edit_id)
                    .ok_or_else(|| invalid("找不到要编辑的原消息"))?;
                if edited.value["role"] != "user" {
                    return Err(invalid("只能编辑自己发送的消息"));
                }
                edited.parent_id.clone()
            } else if request.get("parentId").is_some() {
                request["parentId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
            } else {
                session["activeLeafId"]
                    .as_str()
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned)
                    .or_else(|| existing_all.last().map(|m| m.id.clone()))
            };

            let u_seq = next_message_seq_tx(&tx, &session_id)?;
            let u_id = new_id();
            tx.execute(
                "INSERT INTO companion_messages(
                    id,session_id,parent_id,seq,role,gear,status,content,thinking,steps_json,
                    citations_json,pi_task_id,model_id,usage_json,error_text,created_at,updated_at
                 ) VALUES(?1,?2,?3,?4,'user',?5,'done',?6,'','[]','[]',NULL,'',NULL,NULL,?7,?7)",
                params![u_id, session_id, user_parent, u_seq, gear, user_text, now],
            )?;
            user_msg_val = Some(json!({
                "id": u_id,
                "sessionId": session_id,
                "parentId": user_parent,
                "seq": u_seq,
                "role": "user",
                "gear": gear,
                "status": "done",
                "content": user_text,
                "thinking": "",
                "steps": [],
                "citations": [],
                "piTaskId": Value::Null,
                "modelId": "",
                "usage": Value::Null,
                "errorText": Value::Null,
                "createdAt": now,
                "updatedAt": now,
            }));
            assistant_parent_id = u_id;
        }

        let a_seq = next_message_seq_tx(&tx, &session_id)?;
        let run_id = new_id();
        tx.execute(
            "INSERT INTO companion_messages(
                id,session_id,parent_id,seq,role,gear,status,content,thinking,steps_json,
                citations_json,pi_task_id,model_id,usage_json,error_text,created_at,updated_at
             ) VALUES(?1,?2,?3,?4,'assistant',?5,'streaming','','','[]','[]',NULL,?6,NULL,NULL,?7,?7)",
            params![
                run_id,
                session_id,
                assistant_parent_id,
                a_seq,
                gear,
                model.model,
                now
            ],
        )?;

        let book_scope = request
            .get("bookScope")
            .filter(|v| v.is_object())
            .cloned()
            .or_else(|| session.get("bookScope").filter(|v| v.is_object()).cloned());
        let book_scope_str = book_scope.as_ref().map(Value::to_string);

        // Auto-title untitled default sessions on first user message.
        let mut next_title = session["title"].as_str().unwrap_or("新对话").to_owned();
        if existing_all.iter().all(|m| m.value["role"] != "user") {
            if let Some(u) = &user_msg_val {
                let default_prefix = format!("与{}的对话", persona["name"].as_str().unwrap_or(""));
                if next_title == "新对话" || next_title == default_prefix {
                    next_title = u["content"]
                        .as_str()
                        .unwrap_or("新对话")
                        .lines()
                        .next()
                        .unwrap_or("新对话")
                        .chars()
                        .take(28)
                        .collect();
                }
            }
        }

        tx.execute(
            "UPDATE companion_sessions SET
                title=?1, active_gear=?2, active_leaf_id=?3,
                book_scope_json=COALESCE(?4, book_scope_json), updated_at=?5
             WHERE id=?6",
            params![next_title, gear, run_id, book_scope_str, now, session_id],
        )?;

        let updated_all = load_session_messages_db(&tx, &session_id)?;
        let (_, branch_to_parent) =
            project_active_branch(&updated_all, Some(&assistant_parent_id));

        let bound_world_id = session["boundWorldId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let bound_line_id = session["boundLineId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);
        let mut bound_book_id = session["boundBookId"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned);

        let mut world_brief: Option<String> = None;
        if let Some(ref wid) = bound_world_id {
            if let Some((w_title, _lid, _hid, w_state)) =
                read_world_snapshot_db(&tx, wid, bound_line_id.as_deref())?
            {
                world_brief = Some(format_world_brief_header(&w_title, &w_state));
                if let Some(w_book) = w_state["source"]["bookId"].as_str().filter(|s| !s.is_empty())
                {
                    bound_book_id = Some(w_book.to_owned());
                }
            }
        }

        let raw_net = request.get("network").cloned().unwrap_or(Value::Null);
        let net_snap = crate::pi_network::snapshot(&raw_net)?;
        let model_wire = serde_json::to_value(&model)?;
        let resolved_network = crate::pi_network::bind_model(&net_snap, &model_wire);
        let has_web_tools = gear == "research" && resolved_network["mode"] != "off";
        let has_book_tools = gear == "research" && bound_book_id.is_some();
        let has_world_tool = gear == "research" && world_brief.is_some();

        let summary_up_to = session["summaryUpToMsgId"].as_str();
        let valid_summary = if let Some(up_to) = summary_up_to.filter(|s| !s.is_empty()) {
            if branch_to_parent.iter().any(|m| m["id"].as_str() == Some(up_to)) {
                session["summaryText"].as_str().unwrap_or("")
            } else {
                ""
            }
        } else {
            ""
        };

        let sys_prompt = build_system_prompt(
            &persona,
            &gear,
            &memories,
            valid_summary,
            world_brief.as_deref(),
            has_book_tools,
            has_web_tools,
            has_world_tool,
        );
        let wire_messages = build_wire_messages(
            sys_prompt,
            &branch_to_parent,
            summary_up_to,
            CHAT_RECENT_MESSAGES,
            CHAT_WINDOW_CHAR_BUDGET,
        );

        let assistant_message = json!({
            "id": run_id,
            "sessionId": session_id,
            "parentId": assistant_parent_id,
            "seq": a_seq,
            "role": "assistant",
            "gear": gear,
            "status": "streaming",
            "content": "",
            "thinking": "",
            "steps": [],
            "citations": [],
            "piTaskId": Value::Null,
            "modelId": model.model,
            "usage": Value::Null,
            "errorText": Value::Null,
            "createdAt": now,
            "updatedAt": now,
        });

        tx.commit()?;
        Ok(PreparedRun {
            run_id,
            session_id,
            gear,
            model,
            fallback_model,
            network: resolved_network,
            bound_world_id,
            bound_line_id,
            bound_book_id,
            book_scope,
            messages: wire_messages,
            user_message: user_msg_val,
            assistant_message,
        })
    }

    async fn execute_run(&self, mut prep: PreparedRun, run: Arc<ActiveCompanionRun>) {
        let started = Instant::now();
        let mut totals = UsageTotals::default();
        let outcome = if prep.gear == "research" {
            self.run_research_loop(&mut prep, &run, &mut totals).await
        } else {
            self.run_chat_turn(&mut prep, &run, &mut totals).await
        };

        match outcome {
            Ok(()) => {
                run.bump(|live| {
                    live.status = "done".into();
                    live.phase = "done".into();
                });
            }
            Err(Error::Cancelled) => {
                run.bump(|live| {
                    live.status = "cancelled".into();
                    live.phase = "done".into();
                    for step in &mut live.steps {
                        if step["status"] == "running" {
                            step["status"] = "failed".into();
                            step["summary"] = "已停止".into();
                        }
                    }
                });
            }
            Err(err) => {
                let msg = err.to_string();
                run.bump(|live| {
                    live.status = "failed".into();
                    live.phase = "done".into();
                    live.error_text = Some(msg);
                    for step in &mut live.steps {
                        if step["status"] == "running" {
                            step["status"] = "failed".into();
                        }
                    }
                });
            }
        }

        let _ = settle_run_db(&self.store.0, &run, &totals, started.elapsed().as_millis() as u64);
        lock_unpoison(&self.active).remove(&run.run_id);
        run.notify.notify_waiters();
    }

    async fn call_model_streaming(
        &self,
        prep: &mut PreparedRun,
        run: &Arc<ActiveCompanionRun>,
        messages: &[Value],
        tools: &[Value],
        final_only: bool,
        stream_visible_text: bool,
        totals: &mut UsageTotals,
    ) -> Result<Completion> {
        let mut tried_fallback = false;
        loop {
            if run.cancel.is_cancelled() {
                return Err(Error::Cancelled);
            }
            let body = chat::request_with(&prep.model, messages, tools, false, final_only);
            totals.request_chars = totals.request_chars.saturating_add(
                messages
                    .iter()
                    .map(|m| m["content"].as_str().map(|s| s.chars().count()).unwrap_or(0))
                    .sum::<usize>(),
            );
            let run_sink = Arc::clone(run);
            let base_thinking = {
                let live = lock_unpoison(&run.live);
                live.thinking.clone()
            };
            let base_thinking_in = base_thinking.clone();
            let round_thinking = Arc::new(Mutex::new(String::new()));
            let round_thinking_in = Arc::clone(&round_thinking);

            let sink: TextSink = Arc::new(move |frame: String| {
                if frame == "\0phase:thinking" {
                    run_sink.bump(|live| {
                        if live.content.is_empty() {
                            live.phase = "thinking".into();
                        }
                    });
                    return;
                }
                if let Some(rest) = frame.strip_prefix("\0thinking:") {
                    let combined = {
                        let mut rt = lock_unpoison(&round_thinking_in);
                        if !rt.is_empty() && rest.starts_with(rt.as_str()) {
                            *rt = rest.to_owned();
                        } else {
                            rt.push_str(rest);
                        }
                        if base_thinking_in.is_empty() {
                            rt.clone()
                        } else {
                            format!("{base_thinking_in}\n\n{}", rt.as_str())
                        }
                    };
                    run_sink.bump(|live| {
                        live.phase = "thinking".into();
                        live.thinking = combined;
                    });
                    return;
                }
                if frame.starts_with('\0') || !stream_visible_text {
                    return;
                }
                run_sink.bump(|live| {
                    live.phase = "writing".into();
                    live.content = frame;
                });
            });

            let fut = self
                .model
                .complete(prep.model.clone(), body, run.cancel.child_token(), sink);
            let res = tokio::select! {
                biased;
                _ = run.cancel.cancelled() => Err(Error::Cancelled),
                r = fut => r,
            };

            match res {
                Ok(reply) => {
                    totals.absorb(&reply);
                    if let Some(done_thinking) = extract_completion_thinking(&reply) {
                        run.bump(|live| {
                            live.thinking = if base_thinking.is_empty() {
                                done_thinking
                            } else {
                                format!("{base_thinking}\n\n{done_thinking}")
                            };
                        });
                    }
                    return Ok(reply);
                }
                Err(err) => {
                    if !tried_fallback && crate::failure::fallback_eligible(&err) {
                        if let Some(backup) = prep
                            .fallback_model
                            .clone()
                            .filter(|b| !b.same_service(&prep.model))
                        {
                            tried_fallback = true;
                            prep.model = backup;
                            continue;
                        }
                    }
                    return Err(err);
                }
            }
        }
    }

    async fn run_chat_turn(
        &self,
        prep: &mut PreparedRun,
        run: &Arc<ActiveCompanionRun>,
        totals: &mut UsageTotals,
    ) -> Result<()> {
        let msgs = prep.messages.clone();
        let reply = self
            .call_model_streaming(prep, run, &msgs, &[], false, true, totals)
            .await?;
        if matches!(
            reply.finish_reason.as_deref(),
            Some("content_filter" | "safety" | "prohibited_content" | "recitation" | "refusal")
        ) && reply.text.trim().is_empty()
        {
            return Err(Error::Refused("AI 服务拒绝了这次回复，请换个说法或切换模型".into()));
        }
        run.bump(|live| {
            if !reply.text.is_empty() {
                live.content = reply.text;
            }
        });
        Ok(())
    }

    async fn run_research_loop(
        &self,
        prep: &mut PreparedRun,
        run: &Arc<ActiveCompanionRun>,
        totals: &mut UsageTotals,
    ) -> Result<()> {
        let has_web = prep.network["mode"] != "off";
        let has_book = prep.bound_book_id.is_some();
        let has_world = prep.bound_world_id.is_some();
        let tools = research_tool_definitions(has_book, has_web, has_world);
        if tools.is_empty() {
            return self.run_chat_turn(prep, run, totals).await;
        }

        let mut messages = prep.messages.clone();
        let mut total_calls = 0usize;

        for round in 0..=RESEARCH_MAX_ROUNDS {
            let force_final = round == RESEARCH_MAX_ROUNDS || total_calls >= RESEARCH_MAX_TOOL_CALLS;
            if force_final {
                messages.push(json!({
                    "role": "system",
                    "content": "【查阅阶段已结束】请依据上方已查到的资料完整回答用户问题，不要再调用工具；未查实之处坦诚说明。"
                }));
            }
            run.bump(|live| {
                live.content.clear();
            });
            let reply = self
                .call_model_streaming(prep, run, &messages, &tools, force_final, true, totals)
                .await?;

            if reply.tool_calls.is_empty() || force_final {
                run.bump(|live| {
                    if !reply.text.is_empty() {
                        live.content = reply.text;
                    }
                });
                return Ok(());
            }

            run.bump(|live| {
                live.content.clear();
                live.phase = "searching".into();
            });
            messages.push(chat::assistant_message(&reply));

            for call in &reply.tool_calls {
                if run.cancel.is_cancelled() {
                    return Err(Error::Cancelled);
                }
                let call_id = call["id"].as_str().unwrap_or("").to_owned();
                let name = call["function"]["name"].as_str().unwrap_or("").to_owned();
                let args: Value = serde_json::from_str(
                    call["function"]["arguments"].as_str().unwrap_or("{}"),
                )
                .unwrap_or_else(|_| json!({}));

                if total_calls >= RESEARCH_MAX_TOOL_CALLS {
                    messages.push(json!({
                        "role": "tool",
                        "tool_call_id": call_id,
                        "content": json!({"ok": false, "error": "已达单次查阅上限，请直接根据已有资料作答"}).to_string(),
                    }));
                    continue;
                }
                total_calls += 1;

                let step_id = format!("step-{total_calls}");
                let preview_q = tool_query_preview(&name, &args);
                run.bump(|live| {
                    live.steps.push(json!({
                        "id": step_id,
                        "tool": name,
                        "label": tool_label(&name),
                        "query": preview_q,
                        "status": "running",
                        "summary": "正在查阅…",
                    }));
                });

                let tool_outcome = self.execute_single_research_tool(prep, &run.cancel, &name, &args).await;
                match tool_outcome {
                    Err(Error::Cancelled) => return Err(Error::Cancelled),
                    Ok((payload, summary, new_cites)) => {
                        run.bump(|live| {
                            if let Some(step) = live.steps.iter_mut().find(|s| s["id"] == step_id) {
                                step["status"] = "done".into();
                                step["summary"] = summary.into();
                            }
                            for c in new_cites {
                                push_unique_citation(&mut live.citations, c);
                            }
                        });
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": payload.to_string(),
                        }));
                    }
                    Err(err) => {
                        let msg = err.to_string();
                        run.bump(|live| {
                            if let Some(step) = live.steps.iter_mut().find(|s| s["id"] == step_id) {
                                step["status"] = "failed".into();
                                step["summary"] = clipped(&msg, 120).into();
                            }
                        });
                        messages.push(json!({
                            "role": "tool",
                            "tool_call_id": call_id,
                            "content": json!({"ok": false, "error": msg}).to_string(),
                        }));
                    }
                }
            }
        }
        Ok(())
    }

    async fn execute_single_research_tool(
        &self,
        prep: &PreparedRun,
        cancel: &CancellationToken,
        name: &str,
        args: &Value,
    ) -> Result<(Value, String, Vec<Value>)> {
        match name {
            "web_search" => {
                let query = args["query"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| invalid("缺少搜索词 query"))?;
                let req = json!({
                    "op": "web_search",
                    "query": query,
                    "network": prep.network,
                });
                let res = self.model.network(req, cancel.child_token()).await?;
                let sources = res["sources"].as_array().cloned().unwrap_or_default();
                let mut cites = Vec::new();
                for s in &sources {
                    if let Some(url) = s["url"].as_str().filter(|u| !u.is_empty()) {
                        let title = s["title"]
                            .as_str()
                            .filter(|t| !t.trim().is_empty())
                            .unwrap_or(url);
                        cites.push(json!({
                            "kind": "web",
                            "title": title,
                            "url": url,
                            "quote": clipped(s["text"].as_str().unwrap_or(""), 200),
                        }));
                    }
                }
                let summary = format!("检索到 {} 条网页来源", sources.len());
                Ok((res, summary, cites))
            }
            "read_webpage" => {
                let url = args["url"]
                    .as_str()
                    .filter(|s| !s.trim().is_empty())
                    .ok_or_else(|| invalid("缺少网页地址 url"))?;
                let req = json!({
                    "op": "read_webpage",
                    "url": url,
                    "offset": args.get("offset").cloned().unwrap_or(json!(0)),
                    "limit": args.get("limit").cloned().unwrap_or(json!(8000)),
                    "network": prep.network,
                });
                let res = self.model.network(req, cancel.child_token()).await?;
                let title = res["title"]
                    .as_str()
                    .filter(|t| !t.trim().is_empty())
                    .unwrap_or(url);
                let cite = json!({
                    "kind": "web",
                    "title": title,
                    "url": res["url"].as_str().unwrap_or(url),
                    "quote": clipped(res["text"].as_str().unwrap_or(""), 220),
                });
                let summary = format!("读取网页《{}》", clipped(title, 28));
                Ok((res, summary, vec![cite]))
            }
            "read_world_brief" => {
                let wid = prep
                    .bound_world_id
                    .as_deref()
                    .ok_or_else(|| invalid("当前会话未挂载故事"))?;
                let db = self.store.0.lock()?;
                execute_world_brief_db(
                    &db,
                    wid,
                    prep.bound_line_id.as_deref(),
                    args["query"].as_str().unwrap_or(""),
                )
            }
            "list_sections" | "search_original" | "read_original" | "read_canon_notes" => {
                execute_book_tool_db(&self.store.0, prep, name, args)
            }
            _ => Err(invalid(format!("不支持的查阅工具：{name}"))),
        }
    }

    async fn snapshot(&self, request: &Value) -> Result<Value> {
        let run_id = request["runId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("缺少 runId"))?;
        let after_seq = request["afterSeq"].as_u64().unwrap_or(0);
        let wait_ms = request["waitMs"].as_u64().unwrap_or(0).min(25_000);

        let active_run = lock_unpoison(&self.active).get(run_id).cloned();
        if let Some(run) = active_run {
            if wait_ms > 0 {
                // Race-free Notify registration BEFORE checking seq/status!
                let notified = run.notify.notified();
                tokio::pin!(notified);
                notified.as_mut().enable();
                let ready = {
                    let live = lock_unpoison(&run.live);
                    live.seq > after_seq || live.status != "streaming"
                };
                if !ready {
                    let _ = tokio::time::timeout(Duration::from_millis(wait_ms), notified).await;
                } else {
                    tokio::task::yield_now().await;
                }
            }
            return Ok(run.snapshot_json());
        }

        // Settled run: read directly from `companion_messages` by `run_id == message.id`.
        let db = self.store.0.lock()?;
        ensure_schema_db(&db)?;
        let row: Option<(String, String, String, String, String, String, Option<String>, Option<String>)> = db
            .query_row(
                "SELECT session_id,status,content,thinking,steps_json,citations_json,usage_json,error_text
                 FROM companion_messages WHERE id=?1",
                [run_id],
                |r| {
                    Ok((
                        r.get(0)?,
                        r.get(1)?,
                        r.get(2)?,
                        r.get(3)?,
                        r.get(4)?,
                        r.get(5)?,
                        r.get(6)?,
                        r.get(7)?,
                    ))
                },
            )
            .optional()?;
        let Some((session_id, status, content, thinking, steps_raw, cites_raw, usage_raw, error_text)) = row else {
            return Err(invalid("找不到这次伴聊生成记录"));
        };
        let status = if status == "streaming" {
            let _ = db.execute(
                "UPDATE companion_messages SET status='interrupted', updated_at=?1 WHERE id=?2 AND status='streaming'",
                params![now_iso(), run_id],
            );
            "interrupted".to_owned()
        } else {
            status
        };
        Ok(json!({
            "runId": run_id,
            "sessionId": session_id,
            "messageId": run_id,
            "seq": after_seq.saturating_add(1).max(1),
            "status": status,
            "phase": "done",
            "content": content,
            "thinking": thinking,
            "steps": serde_json::from_str::<Value>(&steps_raw).unwrap_or_else(|_| json!([])),
            "citations": serde_json::from_str::<Value>(&cites_raw).unwrap_or_else(|_| json!([])),
            "usage": usage_raw.and_then(|s| serde_json::from_str::<Value>(&s).ok()),
            "errorText": error_text,
            "done": true,
        }))
    }

    async fn stop(&self, request: &Value) -> Result<Value> {
        let target_run = {
            let active = lock_unpoison(&self.active);
            if let Some(rid) = request["runId"].as_str().filter(|s| !s.is_empty()) {
                active.get(rid).cloned()
            } else if let Some(sid) = request["sessionId"].as_str().filter(|s| !s.is_empty()) {
                active.values().find(|r| r.session_id == sid).cloned()
            } else {
                None
            }
        };

        let Some(run) = target_run else {
            return Ok(json!({
                "runId": request["runId"],
                "status": "settled",
                "accepted": false,
                "settled": true,
            }));
        };

        let notified = run.notify.notified();
        tokio::pin!(notified);
        notified.as_mut().enable();
        run.cancel.cancel();

        let settled = {
            let live = lock_unpoison(&run.live);
            live.settled_in_db
        };
        if !settled {
            let _ = tokio::time::timeout(Duration::from_millis(1500), async {
                loop {
                    if lock_unpoison(&run.live).settled_in_db {
                        break;
                    }
                    run.notify.notified().await;
                }
            })
            .await;
        }
        if !lock_unpoison(&run.live).settled_in_db {
            run.bump(|live| {
                live.status = "cancelled".into();
                live.phase = "done".into();
            });
            let _ = settle_run_db(&self.store.0, &run, &UsageTotals::default(), 0);
        }

        let snap = run.snapshot_json();
        Ok(json!({
            "runId": run.run_id,
            "status": "cancelled",
            "accepted": true,
            "settled": true,
            "snapshot": snap,
        }))
    }

    async fn compact(&self, request: Value) -> Result<Value> {
        let session_id = request["sessionId"]
            .as_str()
            .filter(|s| !s.trim().is_empty())
            .ok_or_else(|| invalid("缺少会话标识"))?
            .to_owned();
        let model: ModelConfig = serde_json::from_value(request["model"].clone())
            .map_err(|_| invalid("请先配置可用的 AI 服务与模型"))?;
        let keep_recent = request["keepRecent"].as_u64().unwrap_or(6).clamp(2, 12) as usize;

        let (real_id, bound_world_id, prior_summary, to_summarize, up_to_msg_id) = {
            let db = self.store.0.lock()?;
            ensure_schema_db(&db)?;
            let session =
                get_session_db(&db, &session_id)?.ok_or_else(|| invalid("找不到这段伴聊会话"))?;
            let real_id = session["id"].as_str().unwrap_or(&session_id).to_owned();
            let all = load_session_messages_db(&db, &real_id)?;
            let (_, branch) = project_active_branch(&all, session["activeLeafId"].as_str());
            let done_msgs: Vec<Value> = branch
                .into_iter()
                .filter(|m| {
                    matches!(m["role"].as_str(), Some("user" | "assistant"))
                        && m["status"] == "done"
                        && !m["content"].as_str().unwrap_or("").trim().is_empty()
                })
                .collect();
            if done_msgs.len() <= keep_recent {
                return Err(invalid("当前对话还不长，无需压缩摘要"));
            }
            let split_at = done_msgs.len() - keep_recent;
            let up_to = done_msgs[split_at - 1]["id"]
                .as_str()
                .unwrap_or("")
                .to_owned();
            let prev_up_to = session["summaryUpToMsgId"].as_str().unwrap_or("");
            let (slice_start, prior) = if !prev_up_to.is_empty() {
                if let Some(pos) = done_msgs[..split_at]
                    .iter()
                    .position(|m| m["id"].as_str() == Some(prev_up_to))
                {
                    (
                        pos + 1,
                        session["summaryText"].as_str().unwrap_or("").to_owned(),
                    )
                } else {
                    (0, String::new())
                }
            } else {
                (0, String::new())
            };
            let slice = done_msgs[slice_start..split_at].to_vec();
            if slice.is_empty() {
                return Ok(json!({
                    "session": session,
                    "summaryText": session["summaryText"],
                    "summaryUpToMsgId": session["summaryUpToMsgId"],
                }));
            }
            (
                real_id,
                session["boundWorldId"].as_str().map(str::to_owned),
                prior,
                slice,
                up_to,
            )
        };

        let transcript = to_summarize
            .iter()
            .map(|m| {
                let speaker = if m["role"] == "user" { "用户" } else { "回复" };
                format!("【{speaker}】{}", clipped(m["content"].as_str().unwrap_or(""), 1200))
            })
            .collect::<Vec<_>>()
            .join("\n\n");
        let user_body = if prior_summary.trim().is_empty() {
            format!("【待压缩的早期对话】\n{transcript}")
        } else {
            format!("【已有摘要】\n{prior_summary}\n\n【新增待合并对话】\n{transcript}")
        };
        let wire = vec![
            json!({
                "role": "system",
                "content": format!("你是伴聊会话摘要整理器（{COMPACT_PROMPT_VERSION}）。把下方早期对话压缩成不超过 600 字的精炼备忘：保留双方确定的人设约定、故事构思细节、关键结论与用户偏好，去掉寒暄套话，直接输出摘要正文。")
            }),
            json!({ "role": "user", "content": user_body }),
        ];
        let body = chat::request(&model, &wire, &[], true);
        let reply = self
            .model
            .complete(
                model.clone(),
                body,
                CancellationToken::new(),
                Arc::new(|_| {}),
            )
            .await?;
        let summary_text = reply.text.trim().to_owned();
        if summary_text.is_empty() {
            return Err(invalid("摘要模型未返回有效内容"));
        }

        let mut totals = UsageTotals {
            request_chars: wire
                .iter()
                .map(|m| m["content"].as_str().map(|s| s.chars().count()).unwrap_or(0))
                .sum(),
            ..Default::default()
        };
        totals.absorb(&reply);
        let (_, prompt_tokens, completion_tokens, estimated) =
            totals.json_with_fallback(&summary_text, "", reply.total_ms);

        {
            let mut db = self.store.0.lock()?;
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
            crate::maintenance::guard(&tx)?;
            let now = now_iso();
            let aux_name = model.aux_model.as_deref().unwrap_or(&model.model);
            tx.execute(
                "UPDATE companion_sessions SET summary_text=?1, summary_up_to_msg_id=?2, updated_at=?3 WHERE id=?4",
                params![summary_text, up_to_msg_id, now, real_id],
            )?;
            tx.execute(
                "INSERT INTO usage(id,world_id,node_id,purpose,profile_id,model,prompt_tokens,
                                   completion_tokens,estimated,first_token_ms,total_ms,outcome,at)
                 VALUES(?1,?2,NULL,'companion:compact',NULL,?3,?4,?5,?6,?7,?8,'ok',?9)",
                params![
                    format!("companion-compact:{}", new_id()),
                    bound_world_id.as_deref(),
                    aux_name,
                    prompt_tokens,
                    completion_tokens,
                    i64::from(estimated),
                    totals.first_token_ms,
                    reply.total_ms as i64,
                    now
                ],
            )?;
            tx.commit()?;
        }

        let updated = self.store.get_session_detail(&real_id)?;
        Ok(json!({
            "session": updated["session"],
            "summaryText": summary_text,
            "summaryUpToMsgId": up_to_msg_id,
        }))
    }
}

fn dispatch_store_op(rt: &CompanionRuntime, request: &Value) -> Result<Value> {
    let store = &rt.store;
    match request["op"].as_str().unwrap_or("") {
        "persona_list" => Ok(json!({ "personas": store.list_personas()? })),
        "persona_get" => {
            let id = request["id"]
                .as_str()
                .ok_or_else(|| invalid("缺少人格标识"))?;
            Ok(json!({ "persona": store.get_persona(id)? }))
        }
        "persona_save" => {
            let p = request.get("persona").unwrap_or(request);
            Ok(json!({ "persona": store.save_persona(p)? }))
        }
        "persona_delete" => {
            let id = request["id"]
                .as_str()
                .ok_or_else(|| invalid("缺少人格标识"))?;
            store.delete_persona(id)
        }
        "persona_export" => {
            let id = request["id"]
                .as_str()
                .ok_or_else(|| invalid("缺少人格标识"))?;
            Ok(json!({ "bundle": store.export_persona(id)? }))
        }
        "persona_import" => {
            let raw = request.get("raw").unwrap_or(request);
            Ok(json!({ "persona": store.import_persona(raw)? }))
        }
        "memory_list" => Ok(json!({
            "memories": store.list_memories(
                request["personaId"].as_str(),
                request["scope"].as_str(),
                request["includeDisabled"].as_bool().unwrap_or(true),
            )?
        })),
        "memory_save" => {
            let m = request.get("memory").unwrap_or(request);
            Ok(json!({ "memory": store.save_memory(m)? }))
        }
        "memory_toggle" => {
            let id = request["id"]
                .as_str()
                .ok_or_else(|| invalid("缺少记忆标识"))?;
            Ok(json!({
                "memory": store.toggle_memory(
                    id,
                    request.get("enabled").and_then(Value::as_bool),
                    request.get("pinned").and_then(Value::as_bool),
                )?
            }))
        }
        "memory_delete" => {
            let id = request["id"]
                .as_str()
                .ok_or_else(|| invalid("缺少记忆标识"))?;
            store.delete_memory(id)
        }
        "session_list" => store.list_sessions(
            request["worldId"].as_str(),
            request["includeArchived"].as_bool().unwrap_or(false),
            request["query"].as_str().unwrap_or(""),
            request["offset"].as_u64().unwrap_or(0) as usize,
            request["limit"].as_u64().unwrap_or(40) as usize,
        ),
        "session_get" | "session_detail" => {
            let id = request["id"]
                .as_str()
                .or_else(|| request["sessionId"].as_str())
                .ok_or_else(|| invalid("缺少会话标识"))?;
            store.get_session_detail_with_active(id, |sid| {
                let active = lock_unpoison(&rt.active);
                active
                    .values()
                    .find(|r| r.session_id == sid && !lock_unpoison(&r.live).settled_in_db)
                    .map(|r| r.run_id.clone())
            })
        }
        "session_create" => store.create_session(request),
        "session_update" => Ok(json!({ "session": store.update_session(request)? })),
        "session_switch_branch" => {
            let sid = request["sessionId"]
                .as_str()
                .ok_or_else(|| invalid("缺少 sessionId"))?;
            let mid = request["messageId"]
                .as_str()
                .ok_or_else(|| invalid("缺少 messageId"))?;
            store.switch_branch(sid, mid)
        }
        "session_delete" => {
            let id = request["id"]
                .as_str()
                .or_else(|| request["sessionId"].as_str())
                .ok_or_else(|| invalid("缺少会话标识"))?;
            store.delete_session(id)
        }
        "message_append" => {
            let sid = request["sessionId"]
                .as_str()
                .ok_or_else(|| invalid("缺少 sessionId"))?;
            let msg = request
                .get("message")
                .ok_or_else(|| invalid("缺少 message"))?;
            store.append_message(sid, msg)
        }
        "import_handoff" => store.import_handoff(request),
        other => Err(invalid(format!("未知的伴聊接口：{other}"))),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::chat::BoxFuture;
    use std::collections::VecDeque;

    enum ScriptedTurn {
        Chat {
            thinking: &'static str,
            text: &'static str,
        },
        ToolCall {
            calls: Vec<Value>,
        },
        SlowHang,
    }

    struct FakeModel {
        turns: Mutex<VecDeque<ScriptedTurn>>,
        captured_bodies: Mutex<Vec<Value>>,
        web_sources: Value,
    }

    impl FakeModel {
        fn new(turns: Vec<ScriptedTurn>) -> Arc<Self> {
            Arc::new(Self {
                turns: Mutex::new(turns.into()),
                captured_bodies: Mutex::new(vec![]),
                web_sources: json!({
                    "provider": "fake",
                    "query": "天宝物价",
                    "text": "斗米十余文",
                    "sources": [{"url": "https://example.org/tang", "title": "唐代物价考", "text": "天宝年间斗米十余文"}],
                    "untrusted": true
                }),
            })
        }
    }

    impl Model for FakeModel {
        fn complete(
            &self,
            _config: ModelConfig,
            body: Value,
            cancel: CancellationToken,
            sink: TextSink,
        ) -> BoxFuture<Result<Completion>> {
            lock_unpoison(&self.captured_bodies).push(body);
            let scripted = lock_unpoison(&self.turns)
                .pop_front()
                .expect("scripted model turn");
            Box::pin(async move {
                match scripted {
                    ScriptedTurn::Chat { thinking, text } => {
                        if !thinking.is_empty() {
                            sink("\0phase:thinking".into());
                            sink(format!("\0thinking:{thinking}"));
                        }
                        sink(text.to_owned());
                        let mut continuation = serde_json::Map::new();
                        if !thinking.is_empty() {
                            continuation.insert("thinking_text".into(), json!(thinking));
                        }
                        Ok(Completion {
                            text: text.to_owned(),
                            continuation,
                            tool_calls: vec![],
                            finish_reason: Some("stop".into()),
                            usage: Some(json!({"prompt_tokens": 120, "completion_tokens": 45})),
                            first_token_ms: Some(12),
                            total_ms: 35,
                        })
                    }
                    ScriptedTurn::ToolCall { calls } => Ok(Completion {
                        text: String::new(),
                        continuation: serde_json::Map::new(),
                        tool_calls: calls,
                        finish_reason: Some("tool_calls".into()),
                        usage: Some(json!({"prompt_tokens": 90, "completion_tokens": 20})),
                        first_token_ms: Some(10),
                        total_ms: 25,
                    }),
                    ScriptedTurn::SlowHang => {
                        sink("\0thinking:正在深思…".into());
                        sink("半截回复内容".into());
                        cancel.cancelled().await;
                        Err(Error::Cancelled)
                    }
                }
            })
        }

        fn network(&self, request: Value, _cancel: CancellationToken) -> BoxFuture<Result<Value>> {
            let out = self.web_sources.clone();
            Box::pin(async move {
                assert_eq!(request["op"], "web_search");
                Ok(out)
            })
        }
    }

    fn model_cfg() -> Value {
        json!({
            "slot": "main",
            "url": "https://api.example.invalid/v1/chat/completions",
            "model": "test-main",
            "auxModel": "test-aux",
            "includeUsage": true
        })
    }

    fn setup_db() -> Store {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON;").unwrap();
        crate::migration::migrate(&mut db, None).unwrap();
        Store(Arc::new(Mutex::new(db)))
    }

    #[tokio::test]
    async fn chat_gear_streams_without_world_lease_conflict_and_pure_roleplay_stays_clean() {
        let store = setup_db();
        {
            let mut db = store.lock().unwrap();
            db.execute_batch(
                "INSERT INTO worlds(id,title,era_id,current_line_id,created_at,updated_at,played_at)
                 VALUES('w1','长安局','tang','l1','t','t','t');
                 INSERT INTO nodes(id,world_id,seq,kind,created_at) VALUES('n1','w1',0,'opening','t');
                 INSERT INTO states(node_id,state_json) VALUES('n1','{\"protagonist\":{\"name\":\"李安\",\"identity\":\"不良人\"},\"time\":{\"start\":\"天宝七载\"},\"places\":[],\"goals\":[]}');
                 INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l1','w1','主线','n1','t');",
            )
            .unwrap();
            let tx = db.transaction_with_behavior(TransactionBehavior::Immediate).unwrap();
            crate::execution_lease::ensure_schema(&tx).unwrap();
            crate::execution_lease::acquire_tx(&tx, "w1", "story-run-1", "inst", crate::execution_lease::now_ms(), 60_000).unwrap();
            tx.commit().unwrap();
        }

        let fake = FakeModel::new(vec![
            ScriptedTurn::Chat {
                thinking: "先梳理不良人处境",
                text: "可以先从西市暗桩查起。",
            },
            ScriptedTurn::Chat {
                thinking: "",
                text: "客官慢用，外头雨正大。",
            },
        ]);
        let rt = Arc::new(CompanionRuntime::new(store.clone(), fake.clone()));

        let created = rt
            .dispatch(json!({
                "op": "session_create",
                "personaId": "builtin:lingxi",
                "boundWorldId": "w1",
            }))
            .await
            .unwrap();
        let sid = created["session"]["id"].as_str().unwrap();

        let sent = rt
            .dispatch(json!({
                "op": "send",
                "sessionId": sid,
                "gear": "chat",
                "text": "下一步怎么查？",
                "model": model_cfg(),
            }))
            .await
            .unwrap();
        let run_id = sent["runId"].as_str().unwrap();

        let mut after_seq = 0u64;
        let mut snap;
        loop {
            snap = rt
                .dispatch(json!({"op": "snapshot", "runId": run_id, "afterSeq": after_seq, "waitMs": 200}))
                .await
                .unwrap();
            after_seq = snap["seq"].as_u64().unwrap_or(after_seq);
            if snap["done"] == true {
                break;
            }
        }
        assert_eq!(snap["status"], "done");
        assert_eq!(snap["thinking"], "先梳理不良人处境");
        assert_eq!(snap["content"], "可以先从西市暗桩查起。");

        // Pure roleplay persona (`builtin:tavern`) must NEVER inject meta world brief or AI framing:
        let rp = rt
            .dispatch(json!({
                "op": "session_create",
                "personaId": "builtin:tavern",
                "boundWorldId": "w1",
            }))
            .await
            .unwrap();
        let rp_sid = rp["session"]["id"].as_str().unwrap();
        let rp_sent = rt
            .dispatch(json!({
                "op": "send",
                "sessionId": rp_sid,
                "gear": "chat",
                "text": "掌柜的，来碗热茶。",
                "model": model_cfg(),
            }))
            .await
            .unwrap();
        let rp_rid = rp_sent["runId"].as_str().unwrap();
        let mut rp_seq = 0u64;
        loop {
            let s = rt
                .dispatch(json!({"op": "snapshot", "runId": rp_rid, "afterSeq": rp_seq, "waitMs": 200}))
                .await
                .unwrap();
            rp_seq = s["seq"].as_u64().unwrap_or(rp_seq);
            if s["done"] == true {
                break;
            }
        }

        let bodies = lock_unpoison(&fake.captured_bodies);
        let assistant_sys = bodies[0]["messages"][0]["content"].as_str().unwrap();
        assert!(assistant_sys.contains("长安局") && assistant_sys.contains("李安"));
        let rp_sys = bodies[1]["messages"][0]["content"].as_str().unwrap();
        assert!(!rp_sys.contains("长安局"), "pure roleplay must strip attached world meta framing");

        let chat_usage_count: i64 = store
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM usage WHERE purpose='companion:chat' AND outcome='ok'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(chat_usage_count, 2);
    }

    #[tokio::test]
    async fn stop_preserves_partial_reply_and_logs_cancelled_usage() {
        let store = setup_db();
        let fake = FakeModel::new(vec![ScriptedTurn::SlowHang]);
        let rt = Arc::new(CompanionRuntime::new(store.clone(), fake));
        let created = rt
            .dispatch(json!({"op": "session_create", "personaId": "builtin:lingxi"}))
            .await
            .unwrap();
        let sid = created["session"]["id"].as_str().unwrap();
        let sent = rt
            .dispatch(json!({
                "op": "send",
                "sessionId": sid,
                "text": "写一段很长的分析",
                "model": model_cfg(),
            }))
            .await
            .unwrap();
        let run_id = sent["runId"].as_str().unwrap();

        for _ in 0..30 {
            let s = rt
                .dispatch(json!({"op": "snapshot", "runId": run_id, "afterSeq": 0, "waitMs": 50}))
                .await
                .unwrap();
            if s["content"] == "半截回复内容" {
                break;
            }
            tokio::time::sleep(Duration::from_millis(10)).await;
        }

        let stopped = rt
            .dispatch(json!({"op": "stop", "runId": run_id}))
            .await
            .unwrap();
        assert_eq!(stopped["status"], "cancelled");

        let detail = rt
            .dispatch(json!({"op": "session_detail", "id": sid}))
            .await
            .unwrap();
        let last_msg = detail["messages"].as_array().unwrap().last().unwrap();
        assert_eq!(last_msg["status"], "cancelled");
        assert_eq!(last_msg["content"], "半截回复内容");
        assert!(last_msg["thinking"].as_str().unwrap().contains("正在深思"));

        let cancelled_usage: i64 = store
            .lock()
            .unwrap()
            .query_row(
                "SELECT COUNT(*) FROM usage WHERE purpose='companion:chat' AND outcome='cancelled'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        assert_eq!(cancelled_usage, 1);
    }

    #[tokio::test]
    async fn research_gear_clamps_world_spoiler_fence_and_records_steps_and_citations() {
        let store = setup_db();
        {
            let db = store.lock().unwrap();
            db.execute_batch(
                "INSERT INTO source_books(id,title,format,created_at,json) VALUES('b1','测试原著','txt','t','{}');
                 INSERT INTO source_sections(book_id,section,title,page) VALUES('b1',0,'第一章 初入青云',NULL),('b1',1,'第二章 试剑',NULL),('b1',2,'第三章 终局真相',NULL);
                 INSERT INTO source_chunks(book_id,ordinal,section,text) VALUES
                   ('b1',0,0,'少年林牧在青云崖拾得一把青竹剑。'),
                   ('b1',1,1,'试剑台上众人比试剑法。'),
                   ('b1',2,2,'终局揭晓：掌门其实早就隐居海外孤岛。');
                 INSERT INTO source_terms(book_id,term,postings) VALUES
                   ('b1','青竹','[0]'),('b1','竹剑','[0]'),('b1','孤岛','[2]'),('b1','海外','[2]');
                 INSERT INTO worlds(id,title,era_id,current_line_id,created_at,updated_at,played_at)
                   VALUES('w-fenced','限章同人','free','l1','t','t','t');
                 INSERT INTO nodes(id,world_id,seq,kind,created_at) VALUES('n1','w-fenced',0,'opening','t');
                 INSERT INTO states(node_id,state_json) VALUES('n1','{\"source\":{\"bookId\":\"b1\",\"through\":0,\"position\":0,\"mode\":\"fanfic\",\"instructions\":\"\"},\"protagonist\":{\"name\":\"林牧\",\"identity\":\"外门弟子\"},\"time\":{\"start\":\"第一日\"},\"places\":[],\"goals\":[]}');
                 INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l1','w-fenced','主线','n1','t');",
            )
            .unwrap();
        }

        let fake = FakeModel::new(vec![
            ScriptedTurn::ToolCall {
                calls: vec![
                    json!({"id":"c1","type":"function","function":{"name":"search_original","arguments":"{\"query\":\"青竹剑\"}"}}),
                    json!({"id":"c2","type":"function","function":{"name":"read_original","arguments":"{\"section\":2}"}}),
                    json!({"id":"c3","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"天宝物价\"}"}}),
                ],
            },
            ScriptedTurn::Chat {
                thinking: "",
                text: "第一章写到林牧拾得青竹剑；第三章超出本局进度未读取。",
            },
        ]);
        let rt = Arc::new(CompanionRuntime::new(store.clone(), fake.clone()));
        let created = rt
            .dispatch(json!({
                "op": "session_create",
                "boundWorldId": "w-fenced",
                "activeGear": "research",
            }))
            .await
            .unwrap();
        let sid = created["session"]["id"].as_str().unwrap();

        let sent = rt
            .dispatch(json!({
                "op": "send",
                "sessionId": sid,
                "gear": "research",
                "text": "查一下青竹剑和第三章内容",
                "bookScope": {"mode": "chapters", "from": 0, "to": 2},
                "model": model_cfg(),
            }))
            .await
            .unwrap();
        let run_id = sent["runId"].as_str().unwrap();
        let mut r_seq = 0u64;
        loop {
            let s = rt
                .dispatch(json!({"op": "snapshot", "runId": run_id, "afterSeq": r_seq, "waitMs": 200}))
                .await
                .unwrap();
            r_seq = s["seq"].as_u64().unwrap_or(r_seq);
            if s["done"] == true {
                assert_eq!(s["steps"].as_array().unwrap().len(), 3);
                assert_eq!(s["steps"][0]["status"], "done");
                assert_eq!(s["steps"][1]["status"], "failed", "section 2 past world through=0 must be blocked");
                assert_eq!(s["steps"][2]["status"], "done");
                let cites = s["citations"].as_array().unwrap();
                assert!(cites.iter().any(|c| c["kind"] == "book" && c["section"] == 0));
                assert!(!cites.iter().any(|c| c["section"] == 2));
                assert!(cites.iter().any(|c| c["kind"] == "web" && c["url"] == "https://example.org/tang"));
                break;
            }
        }
        let bodies = lock_unpoison(&fake.captured_bodies);
        assert!(
            !bodies[1].to_string().contains("隐居海外孤岛"),
            "spoiler text from section 2 must never enter model context"
        );
    }

    #[tokio::test]
    async fn compact_summarizes_older_messages_with_aux_model() {
        let store = setup_db();
        let fake = FakeModel::new(vec![ScriptedTurn::Chat {
            thinking: "",
            text: "双方约定主角名为沈砚，背景为明末锦衣卫百户。",
        }]);
        let rt = Arc::new(CompanionRuntime::new(store.clone(), fake.clone()));
        let created = rt
            .dispatch(json!({"op": "session_create", "title": "长对话"}))
            .await
            .unwrap();
        let sid = created["session"]["id"].as_str().unwrap();
        for i in 1..=6 {
            rt.dispatch(json!({
                "op": "message_append",
                "sessionId": sid,
                "message": {"role": if i % 2 == 1 { "user" } else { "assistant" }, "content": format!("第 {i} 条历史消息")}
            }))
            .await
            .unwrap();
        }
        let compacted = rt
            .dispatch(json!({
                "op": "compact",
                "sessionId": sid,
                "keepRecent": 2,
                "model": model_cfg(),
            }))
            .await
            .unwrap();
        assert!(compacted["summaryText"].as_str().unwrap().contains("沈砚"));
        assert!(!compacted["summaryUpToMsgId"].is_null());
        let bodies = lock_unpoison(&fake.captured_bodies);
        assert_eq!(bodies[0]["model"], "test-aux");
    }

    #[tokio::test]
    async fn session_detail_and_get_heal_orphan_streaming_messages_when_no_run_is_active() {
        let store = setup_db();
        let fake = FakeModel::new(vec![ScriptedTurn::SlowHang]);
        let rt = Arc::new(CompanionRuntime::new(store.clone(), fake));

        let created = rt
            .dispatch(json!({
                "op": "session_create",
                "title": "自愈测试",
                "metadata": {"activeRunId": "stale-run-99"},
            }))
            .await
            .unwrap();
        let sid = created["session"]["id"].as_str().unwrap().to_owned();

        // Insert an orphan `streaming` message with no active run in `rt.active`:
        let appended = rt
            .dispatch(json!({
                "op": "message_append",
                "sessionId": sid,
                "message": {
                    "id": "orphan-msg-1",
                    "role": "assistant",
                    "gear": "chat",
                    "status": "streaming",
                    "content": "中断前写到一半的内容",
                    "steps": [{"id": "s1", "tool": "search_original", "label": "检索原著原文", "status": "running", "summary": "正在查阅…"}],
                }
            }))
            .await
            .unwrap();
        assert_eq!(appended["message"]["status"], "streaming");

        let healed = rt
            .dispatch(json!({"op": "session_get", "id": sid}))
            .await
            .unwrap();
        assert!(healed["activeRunId"].is_null());
        assert!(healed["session"]["activeRunId"].is_null());
        assert!(healed["session"]["metadata"].get("activeRunId").is_none());
        assert_eq!(healed["messages"][0]["status"], "interrupted");
        assert_eq!(healed["messages"][0]["content"], "中断前写到一半的内容");
        assert_eq!(healed["messages"][0]["steps"][0]["status"], "failed");

        // Verify live active runs are NOT marked interrupted while running, and expose activeRunId:
        let sent = rt
            .dispatch(json!({
                "op": "send",
                "sessionId": sid,
                "text": "继续聊",
                "model": model_cfg(),
            }))
            .await
            .unwrap();
        let live_run_id = sent["runId"].as_str().unwrap().to_owned();
        let while_live = rt
            .dispatch(json!({"op": "session_detail", "id": sid}))
            .await
            .unwrap();
        assert_eq!(while_live["activeRunId"], live_run_id);
        assert_eq!(while_live["session"]["activeRunId"], live_run_id);
        assert_eq!(
            while_live["messages"].as_array().unwrap().last().unwrap()["status"],
            "streaming"
        );

        let stopped = rt
            .dispatch(json!({"op": "stop", "sessionId": sid}))
            .await
            .unwrap();
        assert_eq!(stopped["status"], "cancelled");
    }
}
