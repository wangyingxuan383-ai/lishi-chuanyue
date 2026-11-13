//! Agent edits are isolated until one guarded transaction. History is copied
//! along the selected route and replayed; other routes keep their old nodes.
use crate::{rules, Error, Result, RunPlan};
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde_json::{json, Map, Value};
use std::{
    collections::{HashMap, HashSet},
    hash::{Hash, Hasher},
};

pub(crate) fn id() -> String {
    uuid::Uuid::new_v4().to_string()
}
pub(crate) fn now() -> String {
    chrono::Utc::now().to_rfc3339()
}
pub(crate) fn parse(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}
pub(crate) fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}

fn exists(db: &Connection, table: &str) -> bool {
    db.query_row(
        "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?",
        [table],
        |_| Ok(()),
    )
    .optional()
    .ok()
    .flatten()
    .is_some()
}
pub(crate) fn rows(
    db: &Connection,
    sql: &str,
    args: &[&dyn rusqlite::ToSql],
) -> Result<Vec<Value>> {
    let mut statement = db.prepare(sql)?;
    let columns: Vec<String> = statement
        .column_names()
        .iter()
        .map(|s| s.to_string())
        .collect();
    let values = statement
        .query_map(args, |row| {
            let mut object = Map::new();
            for (i, name) in columns.iter().enumerate() {
                use rusqlite::types::ValueRef;
                let value = match row.get_ref(i)? {
                    ValueRef::Null => Value::Null,
                    ValueRef::Integer(n) => json!(n),
                    ValueRef::Real(n) => json!(n),
                    ValueRef::Text(s) => Value::String(String::from_utf8_lossy(s).into_owned()),
                    ValueRef::Blob(_) => Value::Null,
                };
                object.insert(name.clone(), value);
            }
            Ok(Value::Object(object))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    Ok(values)
}
fn raw(db: &Connection, table: &str, key: &str, value: &str) -> Result<Value> {
    rows(
        db,
        &format!("SELECT * FROM {table} WHERE {key}=?"),
        &[&value],
    )?
    .into_iter()
    .next()
    .ok_or_else(|| Error::Invalid("指定资料不存在或不属于本局".into()))
}
fn table_rows(db: &Connection, table: &str, world: &str) -> Result<Value> {
    if !exists(db, table) {
        return Ok(json!([]));
    }
    let sql = if table == "states" {
        "SELECT s.* FROM states s JOIN nodes n ON n.id=s.node_id WHERE n.world_id=? ORDER BY s.node_id".into()
    } else {
        format!(
            "SELECT * FROM {table} WHERE {}=? ORDER BY {}",
            if table == "worlds" { "id" } else { "world_id" },
            if table == "worlds" {
                "id"
            } else if table == "states" {
                "node_id"
            } else {
                "id"
            }
        )
    };
    Ok(Value::Array(rows(db, &sql, &[&world])?))
}
const TABLES: &[&str] = &[
    "worlds",
    "nodes",
    "states",
    "lines",
    "pins",
    "chapters",
    "fact_corrections",
    "story_fact_sources",
];
pub(crate) fn capture(db: &Connection, world: &str) -> Result<Value> {
    let mut result = Map::new();
    for table in TABLES {
        result.insert((*table).into(), table_rows(db, table, world)?);
    }
    Ok(Value::Object(result))
}
pub(crate) fn fingerprint(db: &Connection, world: &str) -> Result<String> {
    let mut hasher = std::collections::hash_map::DefaultHasher::new();
    let mut snapshot = capture(db, world)?;
    for row in snapshot["worlds"].as_array_mut().into_iter().flatten() {
        if let Some(o) = row.as_object_mut() {
            o.remove("played_at");
            o.remove("updated_at");
        }
    }
    if snapshot["story_fact_sources"].as_array().is_some_and(Vec::is_empty){snapshot.as_object_mut().unwrap().remove("story_fact_sources");}
    snapshot.to_string().hash(&mut hasher);
    Ok(format!("{:016x}", hasher.finish()))
}
pub(crate) fn base(db: &Connection, world: &str, line: &str) -> Result<Value> {
    let w = raw(db, "worlds", "id", world)?;
    let l = raw(db, "lines", "id", line)?;
    if text(&l, "world_id") != world
        || text(&w, "current_line_id") != line
        || !l["deleted_at"].is_null()
    {
        return Err(Error::Stale);
    }
    Ok(
        json!({"worldId":world,"lineId":line,"headId":l["node_id"],"fingerprint":fingerprint(db,world)?}),
    )
}
pub(crate) fn guard(db: &Connection, base: &Value) -> Result<()> {
    if fingerprint(db, text(base, "worldId"))? != text(base, "fingerprint") {
        return Err(Error::Stale);
    }
    Ok(())
}

fn decode(mut row: Value) -> Value {
    for (column, key) in [
        ("settings_json", "settings"),
        ("state_json", "state"),
        ("record_json", "record"),
        ("choices_json", "choices"),
        ("meta_json", "meta"),
        ("json", "data"),
    ] {
        if let Some(s) = row[column].as_str() {
            let v = parse(s);
            row.as_object_mut().unwrap().remove(column);
            row[key] = v;
        }
    }
    row
}
fn node(db: &Connection, world: &str, node_id: &str) -> Result<Value> {
    let row = raw(db, "nodes", "id", node_id)?;
    if text(&row, "world_id") != world {
        return Err(Error::Invalid("只能操作本局的剧情".into()));
    }
    Ok(decode(row))
}
fn state(db: &Connection, world: &str, node_id: &str) -> Result<Value> {
    node(db, world, node_id)?;
    Ok(parse(&db.query_row(
        "SELECT state_json FROM states WHERE node_id=?",
        [node_id],
        |r| r.get::<_, String>(0),
    )?))
}
fn head(db: &Connection, plan: &RunPlan) -> Result<String> {
    let line = raw(db, "lines", "id", &plan.line_id)?;
    if text(&line, "world_id") != plan.world_id {
        return Err(Error::Stale);
    }
    Ok(text(&line, "node_id").into())
}
/// A draft route has not been inserted into lines yet. Resolve its real head
/// without falling back to the head of the currently active formal route.
pub(crate) fn route_head(db: &Connection, plan: &RunPlan, task: &str, route: &str) -> Result<String> {
    if route.is_empty() { return head(db, plan); }
    let work = workspace(db, task)?;
    if let Some(found) = work["routes"].as_array().into_iter().flatten().find(|r| r["id"] == route) {
        let target = text(found, "headId"); node(db, &plan.world_id, target)?;
        return Ok(target.into());
    }
    let found = raw(db, "lines", "id", route)?;
    if found["world_id"] != plan.world_id || !found["deleted_at"].is_null() {
        return Err(Error::Invalid("目标路线不存在或不属于本故事".into()));
    }
    Ok(text(&found, "node_id").into())
}
pub(crate) fn scoped_resource_args(db: &Connection, plan: &RunPlan, task: &str, args: &Value) -> Result<Value> {
    let mut result = args.clone();
    let route = text(args, "routeId");
    let kind = canonical_kind(text(args, "kind"));
    if route.is_empty() || !["node","state","protagonist","people","places","cards","goals","facts"].contains(&kind) { return Ok(result); }
    let target_head = route_head(db, plan, task, route)?;
    let target = if text(args,"id").is_empty() { target_head.as_str() } else { text(args,"id") };
    if !path_nodes(db, &plan.world_id, &target_head)?.iter().any(|n| n["id"] == target) {
        return Err(Error::Tool { code:"route_target_mismatch",field:"id",message:format!("目标剧情不在所选路线；该路线停在{}，请读取目标路线的状态后修改",target_head),next:json!({"tool":"read_resource","args":{"kind":kind,"id":target_head,"routeId":route}}) });
    }
    if args["ref"]["containerId"].as_str().is_some_and(|container| container != target) {
        return Err(Error::Tool {code:"route_target_mismatch",field:"ref",message:"旧定位属于另一时点，请先读取所选路线的目标状态".into(),next:json!({"tool":"read_resource","args":{"kind":kind,"id":target,"routeId":route}})});
    }
    result["id"] = target.into();
    Ok(result)
}
pub(crate) fn canonical_kind(kind: &str) -> &str {
    match kind {
        "route" => "line",
        "history" => "node",
        "source" => "book",
        other => other,
    }
}
pub(crate) fn locators(db: &Connection, plan: &RunPlan) -> Result<Value> {
    let current = head(db, plan)?;
    let seq: i64 = db.query_row("SELECT seq FROM nodes WHERE id=?", [&current], |r| r.get(0))?;
    let state = state(db, &plan.world_id, &current)?;
    let binding = &state["source"];
    let reference = if let Some(id) = binding["bookId"].as_str() {
        let title: Option<String> = db
            .query_row("SELECT title FROM source_books WHERE id=?", [id], |r| {
                r.get(0)
            })
            .optional()?;
        let through = if plan.meta["agent"]["referenceScope"]["bookId"] == id {
            plan.meta["agent"]["referenceScope"]["through"].clone()
        } else {
            binding["through"].clone()
        };
        json!({"bookId":id,"title":title,"through":through,"position":binding["position"]})
    } else {
        Value::Null
    };
    Ok(
        json!({"currentHead":{"id":current,"seq":seq},"reference":reference,"message":"只含资料定位。按回合序号用search_resources(kind=node,query=序号)或list_resources定位；书名不能替代原文证据。"}),
    )
}
pub(crate) fn resolve_book(
    db: &Connection,
    plan: &RunPlan,
    requested: &str,
    bound: &str,
) -> Result<String> {
    let requested = if requested.trim().is_empty() {
        bound
    } else {
        requested.trim()
    };
    if !requested.is_empty()
        && db
            .query_row("SELECT 1 FROM source_books WHERE id=?", [requested], |_| {
                Ok(())
            })
            .optional()?
            .is_some()
    {
        return Ok(requested.into());
    }
    let matches = rows(
        db,
        "SELECT id,title FROM source_books WHERE title=? ORDER BY created_at DESC LIMIT 6",
        &[&requested],
    )?;
    if let Some(preferred) = matches.iter().find(|row| row["id"] == bound) {
        return Ok(text(preferred, "id").into());
    }
    if matches.len() == 1 {
        return Ok(text(&matches[0], "id").into());
    }
    let hint = locators(db, plan)?["reference"].clone();
    if matches.len() > 1 {
        return Err(Error::Invalid(format!("该书名对应多个已导入版本，请用list_resources(kind=book,query=书名)选择确切id。本局绑定定位：{hint}")));
    }
    Err(Error::Invalid(format!("未找到该书籍标识或精确书名；这不是原文查无依据。本局绑定定位：{hint}。请用list_resources(kind=book,query=书名)或search_resources(kind=book,query=书名)取得实际id，再查原文。")))
}
fn query_seq(query: &str) -> Option<i64> {
    let text = query.trim().strip_prefix('第').unwrap_or(query.trim());
    let text = ["回合", "回", "章"]
        .iter()
        .find_map(|suffix| text.strip_suffix(suffix))
        .unwrap_or(text)
        .trim();
    (!text.is_empty() && text.chars().all(|c| c.is_ascii_digit()))
        .then(|| text.parse::<i64>().ok())
        .flatten()
}
pub(crate) fn resource(
    db: &Connection,
    plan: &RunPlan,
    kind: &str,
    requested: &str,
) -> Result<Value> {
    let kind = canonical_kind(kind);
    let current = if requested.is_empty() {
        head(db, plan)?
    } else {
        requested.into()
    };
    match kind {
        "world" => Ok(decode(raw(db, "worlds", "id", &plan.world_id)?)),
        "settings" => Ok(decode(raw(db, "worlds", "id", &plan.world_id)?)["settings"].clone()),
        "state" => state(db, &plan.world_id, &current),
        "protagonist" | "people" | "places" | "cards" | "goals" | "facts" => {
            Ok(state(db, &plan.world_id, &current)?[kind].clone())
        }
        "node" => node(db, &plan.world_id, &current),
        "line" | "pin" | "chapter" => {
            let table = match kind {
                "line" => "lines",
                "pin" => "pins",
                _ => "chapters",
            };
            let rid = if requested.is_empty() && kind == "line" {
                &plan.line_id
            } else {
                requested
            };
            let row = raw(db, table, "id", rid)?;
            if text(&row, "world_id") != plan.world_id {
                return Err(Error::Invalid("只能操作本局的资料".into()));
            }
            let mut doc = decode(row);
            if kind == "line" {
                doc["headId"] = doc["node_id"].clone();
            }
            Ok(doc)
        }
        "book" => {
            let book = if requested.is_empty() {
                state(db, &plan.world_id, &head(db, plan)?)?["source"]["bookId"]
                    .as_str()
                    .unwrap_or("")
                    .into()
            } else {
                requested.to_string()
            };
            let mut row = decode(raw(db, "source_books", "id", &book)?);
            row["sections"] = Value::Array(rows(
                db,
                "SELECT * FROM source_sections WHERE book_id=? ORDER BY section",
                &[&book],
            )?);
            row["chunks"] = Value::Array(rows(
                db,
                "SELECT * FROM source_chunks WHERE book_id=? ORDER BY ordinal",
                &[&book],
            )?);
            Ok(row)
        }
        _ => Err(Error::Invalid(
            "不支持的本局资料类型；请先查看 list_resources".into(),
        )),
    }
}
pub(crate) fn list_page(db: &Connection, plan: &RunPlan, args: &Value) -> Result<Value> {
    if ["pageSize","charBudget","nextCursor"].iter().any(|key|args.get(*key).is_some()) {
        let mut legacy=args.clone();for key in ["pageSize","charBudget","nextCursor"]{legacy.as_object_mut().unwrap().remove(key);}legacy["offset"]=0.into();legacy["_directoryAll"]=true.into();
        let all=list_page(db,plan,&legacy)?;let mut paged=page(all["resources"].clone(),args);
        paged["resources"]=paged["value"].clone();paged["categories"]=all["categories"].clone();paged["currentHead"]=all["currentHead"].clone();paged["lineId"]=all["lineId"].clone();paged["message"]="这是定位目录，正文须按资源定位读取；oversized不代表已读内容".into();return Ok(paged);
    }

    let kind = canonical_kind(text(args, "kind"));
    let offset = args["offset"].as_i64().unwrap_or(0).max(0);
    let limit=if args["_directoryAll"]==true{i64::MAX}else{args["limit"].as_i64().unwrap_or(if kind.is_empty(){6}else{12}).clamp(1,40)};
    let query = format!("%{}%", text(args, "query"));
    let mut resources = vec![];
    let mut categories = vec![];
    for (k, label) in [
        ("world", "本局资料与标题"),
        ("settings", "故事设置"),
        ("state", "当前状态"),
        ("protagonist", "主角"),
        ("people", "人物"),
        ("places", "地点"),
        ("cards", "设定"),
        ("goals", "目标"),
        ("facts", "事实"),
    ] {
        if kind.is_empty() || kind == k {
            resources.push(json!({"kind":k,"label":label}));
        }
    }
    for (k, table, label) in [
        ("node", "nodes", "narrative"),
        ("line", "lines", "name"),
        ("pin", "pins", "text"),
        ("chapter", "chapters", "summary"),
    ] {
        if !exists(db, table) {
            continue;
        }
        let count: i64 = db.query_row(
            &format!("SELECT COUNT(*) FROM {table} WHERE world_id=?"),
            [&plan.world_id],
            |r| r.get(0),
        )?;
        categories.push(json!({"kind":k,"count":count}));
        if kind == k || (kind.is_empty() && k == "node") {
            let seq = if k == "node" {
                query_seq(text(args, "query"))
            } else {
                None
            };
            let sql=format!("SELECT id,substr({label},1,80) AS label{} FROM {table} WHERE world_id=? AND ({label} LIKE ?{}) ORDER BY {} DESC LIMIT ? OFFSET ?",if k=="node"{",seq"}else{""},if k=="node"{" OR seq=?"}else{""},if table=="nodes"{"seq"}else{"id"});
            let mut params: Vec<&dyn rusqlite::ToSql> = vec![&plan.world_id, &query];
            if k == "node" {
                params.push(&seq);
            }
            params.extend([&limit as &dyn rusqlite::ToSql, &offset]);
            for row in rows(db, &sql, &params)? {
                resources
                    .push(json!({"kind":k,"id":row["id"],"label":row["label"],"seq":row["seq"]}));
            }
        }
    }
    if exists(db, "source_books") {
        let count: i64 = db.query_row("SELECT COUNT(*) FROM source_books", [], |r| r.get(0))?;
        categories.push(json!({"kind":"book","count":count}));
        if kind == "book" || kind.is_empty() {
            for row in rows(db,"SELECT id,title FROM source_books WHERE title LIKE ? ORDER BY created_at DESC LIMIT ? OFFSET ?",&[&query,&limit,&offset])?{resources.push(json!({"kind":"book","id":row["id"],"label":row["title"]}));}
        }
    }
    Ok(
        json!({"resources":resources,"categories":categories,"currentHead":head(db,plan)?,"lineId":plan.line_id,"offset":offset,"nextOffset":offset.saturating_add(limit),"message":"这是资料定位。按kind分页列出，或search_resources搜索历史；不要反复请求完整目录。"}),
    )
}
pub(crate) fn search(db: &Connection, plan: &RunPlan, args: &Value) -> Result<Value> {
    let query = text(args, "query").trim();
    if query.is_empty() {
        return Err(Error::Invalid("请提供要搜索的文字".into()));
    }
    let wanted = canonical_kind(text(args, "kind"));
    if ![
        "", "node", "line", "pin", "chapter", "settings", "people", "places", "cards", "goals",
        "facts", "book",
    ]
    .contains(&wanted)
    {
        return Err(Error::Invalid("此搜索kind不支持；可用node/line/pin/chapter/settings/people/places/cards/goals/facts/book。世界标题与字段请用list_resources或read_resource(kind=world)，书籍正文用search_original。".into()));
    }
    let limit = args["limit"].as_i64().unwrap_or(12).clamp(1, 30);
    let mut hits = vec![];
    if wanted == "book" {
        for row in rows(
            db,
            "SELECT id,title FROM source_books WHERE title LIKE ? ORDER BY created_at DESC LIMIT ?",
            &[&format!("%{query}%"), &limit],
        )? {
            hits.push(json!({"kind":"book","id":row["id"],"title":row["title"],"text":row["title"],"message":"这是书籍定位，正文需search_original/read_original查证"}));
        }
        return Ok(json!({"matches":hits}));
    }
    for (kind, table, column) in [
        ("node", "nodes", "narrative"),
        ("line", "lines", "name"),
        ("pin", "pins", "text"),
        ("chapter", "chapters", "summary"),
    ] {
        if !exists(db, table) || (!wanted.is_empty() && wanted != kind) {
            continue;
        }
        let seq = if kind == "node" {
            query_seq(query)
        } else {
            None
        };
        let sql=format!("SELECT id,{column} AS content{} FROM {table} WHERE world_id=? AND ({column} LIKE ?{}) ORDER BY rowid DESC LIMIT ?",if kind=="node"{",seq"}else{""},if kind=="node"{" OR seq=?"}else{""});
        let text_query = format!("%{query}%");
        let mut params: Vec<&dyn rusqlite::ToSql> = vec![&plan.world_id, &text_query];
        if kind == "node" {
            params.push(&seq);
        }
        params.push(&limit);
        for row in rows(db, &sql, &params)? {
            let content = text(&row, "content");
            let start = content
                .find(query)
                .map(|i| content[..i].chars().count())
                .unwrap_or(0)
                .saturating_sub(100);
            hits.push(json!({"kind":kind,"id":row["id"],"seq":row["seq"],"path":if kind=="node"{"/narrative"}else{""},"text":content.chars().skip(start).take(900).collect::<String>()}));
            if hits.len() >= limit as usize {
                break;
            }
        }
        if hits.len() >= limit as usize {
            break;
        }
    }
    for kind in ["settings", "people", "places", "cards", "goals", "facts"] {
        if !wanted.is_empty() && wanted != kind {
            continue;
        }
        let value = resource(db, plan, kind, "")?;
        let items = if let Some(a) = value.as_array() {
            a.clone()
        } else {
            vec![value]
        };
        for (index, item) in items.iter().enumerate() {
            let content = item.to_string();
            if content.to_lowercase().contains(&query.to_lowercase()) {
                hits.push(json!({"kind":kind,"path":if item.is_object()&&kind!="settings"{format!("/{index}")}else{String::new()},"text":content.chars().take(900).collect::<String>()}));
                if hits.len() >= limit as usize {
                    break;
                }
            }
        }
        if hits.len() >= limit as usize {
            break;
        }
    }
    Ok(json!({"matches":hits}))
}
fn scope_book(plan: &RunPlan, value: &mut Value) {
    let binding = &plan.meta["agent"]["referenceScope"];
    if binding["bookId"] != value["id"] {
        return;
    }
    let Some(through) = binding["through"].as_u64() else {
        return;
    };
    for key in ["sections", "chunks"] {
        if let Some(items) = value[key].as_array_mut() {
            items.retain(|s| s["section"].as_u64().is_some_and(|n| n <= through));
        }
    }
    if let Some(items) = value["data"]["sections"].as_array_mut() {
        items.truncate((through + 1) as usize);
    }
    if let Some(data) = value["data"].as_object_mut() {
        for key in ["summary", "analysis", "analyses", "synopsis"] {
            data.remove(key);
        }
    }
    value["scope"] =
        json!({"through":through,"message":"只返回本次允许范围，不读取后续或全书总结"});
}
pub(crate) fn workspace(db: &Connection, task: &str) -> Result<Value> {
    let table = task_table(db, task)?;
    Ok(parse(&db.query_row(
        &format!("SELECT workspace_json FROM {table} WHERE id=?"),
        [task],
        |r| r.get::<_, String>(0),
    )?))
}
pub(crate) fn save_workspace(db: &Connection, task: &str, value: &Value) -> Result<()> {
    let table = task_table(db, task)?;
    db.execute(
        &format!("UPDATE {table} SET workspace_json=?,updated_at=? WHERE id=?"),
        params![value.to_string(), now(), task],
    )?;
    Ok(())
}

// Only task drafts share these business rules. Pi transcripts and the legacy
// Agent tables remain separate; a colliding identifier is never guessed.
fn task_table(db: &Connection, task: &str) -> Result<&'static str> {
    let has = |table: &str| -> Result<bool> {
        if !exists(db, table) { return Ok(false); }
        Ok(db.query_row(&format!("SELECT 1 FROM {table} WHERE id=?"), [task], |_| Ok(())).optional()?.is_some())
    };
    match (has("pi_tasks")?, has("agent_tasks")?) {
        (true, false) => Ok("pi_tasks"),
        (false, true) => Ok("agent_tasks"),
        (true, true) => Err(Error::Invalid("任务标识冲突，不能选择修改目标".into())),
        _ => Err(Error::Invalid("指定任务不存在".into())),
    }
}

fn workspace_task(db: &Connection, task: &str) -> Result<Value> {
    raw(db, task_table(db, task)?, "id", task)
}
fn matches_edit(edit: &Value, kind: &str, rid: &str) -> bool {
    text(edit, "kind") == kind && text(edit, "id") == rid
}
pub(crate) fn read(db: &Connection, plan: &RunPlan, task: &str, args: &Value) -> Result<Value> {
    read_selected(db,plan,args,Some(workspace(db,task)?))
}
pub(crate) fn read_formal(db:&Connection,plan:&RunPlan,args:&Value)->Result<Value> {
    read_selected(db,plan,args,None)
}
fn read_selected(db:&Connection,plan:&RunPlan,args:&Value,work:Option<Value>)->Result<Value> {
    let value=selected_value(db,plan,args,work)?;
    let kind=canonical_kind(text(args,"kind"));let rid=text(args,"id");
    let mut page=page(value,args);page["kind"]=kind.into();page["id"]=rid.into();
    attach_read_locators(&mut page,&json!({"kind":kind,"id":rid}));Ok(page)
}
/// Pin an explicitly selected draft field without confusing its first page
/// with the whole source. The caller caps the saved snapshot's byte size.
pub(crate) fn draft_view(db:&Connection,plan:&RunPlan,task:&str,args:&Value)->Result<Value> {
    selected_value(db,plan,args,Some(workspace(db,task)?))
}
fn selected_value(db:&Connection,plan:&RunPlan,args:&Value,work:Option<Value>)->Result<Value> {
    let scoped;
    let args = if !text(args,"routeId").is_empty() { scoped=scoped_resource_args(db,plan,text(&plan.meta["agent"],"taskId"),args)?; &scoped }else{args};
    let kind = canonical_kind(text(args, "kind"));
    let rid = text(args, "id");
    let draft = work.as_ref().unwrap_or(&Value::Null)["edits"]
        .as_array()
        .and_then(|edits| edits.iter().rev().find(|e| matches_edit(e, kind, rid)))
        .map(|e| e["after"].clone());
    let mut value=match draft{Some(value)=>value,None=>resource(db,plan,kind,rid)?};
    if kind == "book" {
        scope_book(plan, &mut value);
    }
    let path = text(args, "path");
    if !path.is_empty() {
        value = value
            .pointer(path)
            .cloned()
            .ok_or_else(|| Error::Invalid("资料路径不存在".into()))?;
    }
    Ok(value)
}

/// A JSON Pointer only has meaning together with its source. Keep that pair
/// in every pageable field so a stored page never becomes a second namespace
/// that the model has to guess or repeatedly unwrap.
pub(crate) fn attach_read_locators(page: &mut Value, base: &Value) {
    fn locator(base: &Value, path: &Value, offset: u64) -> Value {
        let mut read = base.clone();
        if read["id"].as_str() == Some("") {
            read.as_object_mut().unwrap().remove("id");
        }
        if path.as_str() != Some("") {
            read["path"] = path.clone();
        }
        read["offset"] = offset.into();
        read["limit"] = 1200.into();
        read
    }
    let path = page.get("path").cloned().unwrap_or(json!(""));
    let offset = if page["text"].is_string() {
        page["nextOffset"].as_u64().unwrap_or(0)
    } else {
        page["offset"].as_u64().unwrap_or(0)
    };
    let mut next = locator(base, &path, offset);
    for field in page["paths"].as_array_mut().into_iter().flatten() {
        if !field["read"].is_object() {
            field["read"] = locator(base, &field["path"], 0);
        }
    }
    let large_item = page["largeItem"] == true;
    for item in page["value"]
        .as_array_mut()
        .into_iter()
        .flatten()
        .filter(|_| large_item)
    {
        if item["largeItemPath"].is_string() {
            let target = item
                .get("textPath")
                .filter(|v| v.is_string())
                .unwrap_or(&item["largeItemPath"])
                .clone();
            if !item["read"].is_object() {
                item["read"] = locator(base, &target, 0);
            }
            for field in item["paths"].as_array_mut().into_iter().flatten() {
                if !field["read"].is_object() {
                    field["read"] = locator(base, &field["path"], 0);
                }
            }
            if next["path"].as_str().unwrap_or("") == path.as_str().unwrap_or("") {
                next = item["read"].clone();
            }
            item["message"] = "本项超过页上限；直接用read对象调用同一读取工具，不要把textPath配到本次分页调用的新标识。".into();
        }
    }
    for item in page["oversized"].as_array_mut().into_iter().flatten() {
        item["read"]=locator(base,&item["path"],0);
        for field in item["paths"].as_array_mut().into_iter().flatten() {field["read"]=locator(base,&field["path"],0);}
    }
    if page.get("nextCursor").is_some() {
        next=base.clone();next["path"]=path;next["pageSize"]=page["pageSize"].clone();next["charBudget"]=page["charBudget"].clone();
        if !page["nextCursor"].is_null(){next["nextCursor"]=page["nextCursor"].clone();}
    }
    page["read"] = next;
    page["readTool"] = if page["read"]["kind"].is_string() {
        "read_resource"
    } else {
        "read_tool_result"
    }
    .into();
}
pub(crate) fn page(value: Value, args: &Value) -> Value {
    if ["pageSize","charBudget","nextCursor"].iter().any(|key|args.get(*key).is_some()) {return page_v2(value,args);}

    let path = text(args, "path");
    let offset = args["offset"].as_u64().unwrap_or(0) as usize;
    let limit = args["limit"].as_u64().unwrap_or(6000).clamp(1, 24000) as usize;
    match value {
        Value::String(s) => {
            let selected = s.chars().skip(offset).take(limit).collect::<String>();
            json!({"path":path,"text":selected,"total":s.chars().count(),"offset":offset,"nextOffset":offset+selected.chars().count()})
        }
        Value::Array(a) => {
            let mut kept = vec![];
            let mut used = 0;
            let mut next = offset;
            let mut large_item = false;
            for (index, item) in a.iter().enumerate().skip(offset).take(100) {
                let cost = item.to_string().encode_utf16().count();
                if cost > limit {
                    if kept.is_empty() {
                        large_item = true;
                        let item_path = format!("{path}/{index}");
                        kept.push(json!({"index":index,"path":item_path,"largeItemPath":item_path,"keys":item.as_object().map(|o|o.keys().collect::<Vec<_>>()),"paths":page_paths(item,&item_path),"textPath":item.get("text").and_then(Value::as_str).map(|_|format!("{item_path}/text")),"message":"本项有内容但超过本页上限；按textPath或paths中的具体字段读取。文字用offset/limit分页，不能把本定位当作已读原文。"}));
                        next = index + 1;
                    }
                    break;
                }
                if cost + used > limit {
                    break;
                }
                kept.push(item.clone());
                used += cost;
                next = index + 1;
            }
            let mut page =
                json!({"path":path,"value":kept,"total":a.len(),"offset":offset,"nextOffset":next});
            if large_item {
                page["largeItem"] = true.into();
            }
            page
        }
        v if v.to_string().encode_utf16().count() > limit => {
            json!({"path":path,"keys":v.as_object().map(|o|o.keys().cloned().collect::<Vec<_>>()),"paths":page_paths(&v,path),"message":"内容较长，请按paths中实际存在的字段读取；文字使用offset/limit分页。此目录不是空内容，也不代表已读正文。","total":v.to_string().encode_utf16().count()})
        }
        v => json!({"path":path,"value":v}),
    }
}

fn page_v2(value:Value,args:&Value)->Value {
    let path=text(args,"path");
    let version=crate::pi_store::arguments_hash(&json!({"path":path,"value":value}));
    let mut offset=args["offset"].as_u64().unwrap_or(0) as usize;
    if let Some(cursor)=args["nextCursor"].as_str() {
        let parsed=cursor.split_once(':').filter(|(v,_)|*v==version).and_then(|(_,n)|n.parse::<usize>().ok());
        let Some(position)=parsed else{return json!({"pageError":{"code":"page_version_changed","message":"资料或游标已变化，请从新的首段重新读取"},"version":version,"complete":false});};offset=position;
    }
    let budget=args["charBudget"].as_u64().or_else(||args["limit"].as_u64()).unwrap_or(6000).clamp(1,24000) as usize;
    let size=args["pageSize"].as_u64().unwrap_or(40).clamp(1,100) as usize;
    let mut page=match &value {
        Value::String(s)=>{let mut used=0;let text=s.chars().skip(offset).take_while(|c|{used+=c.len_utf16();used<=budget}).collect::<String>();if text.is_empty()&&offset<s.chars().count(){return json!({"pageError":{"code":"character_budget_too_small","message":"文字预算不足以返回一个完整字符，请至少设为2"},"complete":false});}json!({"text":text,"total":s.chars().count(),"nextOffset":offset+text.chars().count()})},
        Value::Array(items)=>{
            let mut kept=vec![];let mut oversized=vec![];let mut used=0;let mut next=offset;
            for (index,item) in items.iter().enumerate().skip(offset).take(size) {
                let cost=item.to_string().encode_utf16().count();
                if cost>budget {
                    if kept.is_empty()&&oversized.is_empty(){let target=format!("{path}/{index}");oversized.push(json!({"index":index,"path":target,"paths":page_paths(item,&target),"message":"超大条目定位，内容未返回；按字段读取"}));next=index+1;}break;
                }
                if used+cost>budget {break;}used+=cost;kept.push(item.clone());next=index+1;
            }
            json!({"value":kept,"oversized":oversized,"total":items.len(),"nextOffset":next})
        },
        _ if value.to_string().encode_utf16().count()>budget=>json!({"paths":page_paths(&value,path),"directoryOnly":true,"total":1,"nextOffset":1}),
        _=>json!({"value":value,"total":1,"nextOffset":1})
    };
    let next=page["nextOffset"].as_u64().unwrap_or(0);let total=page["total"].as_u64().unwrap_or(0);
    page["path"]=path.into();page["offset"]=offset.into();page["version"]=version.clone().into();page["pageSize"]=size.into();page["charBudget"]=budget.into();
    page["complete"]=(next>=total).into();page["nextCursor"]=if next<total {format!("{version}:{next}").into()}else{Value::Null};page
}

#[cfg(test)]
mod page_tests {
    use super::*;

    #[test]
    fn every_large_array_descriptor_advances_before_its_independent_text_read() {
        let original = json!({"excerpts":[{"text":format!("第一章事实：钥匙在灯座。{}","背景".repeat(100))},{"text":format!("第二章事实：钥匙在竹匣。{}","背景".repeat(100))}]});
        let mut offset = 0;
        let mut texts = vec![];
        while offset < original["excerpts"].as_array().unwrap().len() as u64 {
            let mut descriptor = page(
                original["excerpts"].clone(),
                &json!({"path":"/excerpts","offset":offset,"limit":1}),
            );
            attach_read_locators(&mut descriptor, &json!({"callId":"original-search"}));
            let next = descriptor["nextOffset"].as_u64().unwrap();
            assert_eq!(next, offset + 1);
            let read = &descriptor["value"][0]["read"];
            crate::tools::validate_with(&crate::agent_tools::catalog(), "read_tool_result", read)
                .unwrap();
            let value = original
                .pointer(read["path"].as_str().unwrap())
                .unwrap()
                .clone();
            texts.push(page(value, read)["text"].as_str().unwrap().to_owned());
            offset = next;
        }
        assert_eq!(texts.len(), 2);
        assert!(texts[0].contains("第一章事实：钥匙在灯座"));
        assert!(texts[1].contains("第二章事实：钥匙在竹匣"));
    }
}
fn page_paths(value: &Value, path: &str) -> Vec<Value> {
    value.as_object().into_iter().flatten().take(20).map(|(key,v)|{
        let next=format!("{path}/{}",key.replace('~',"~0").replace('/',"~1"));
        json!({"path":next,"type":if v.is_string(){"string"}else if v.is_array(){"array"}else if v.is_object(){"object"}else{"value"},"total":v.as_str().map(|s|s.chars().count()).or_else(||v.as_array().map(Vec::len))})
    }).collect()
}
fn merge(value: &mut Value, patch: &Value) {
    if let (Some(target), Some(patch)) = (value.as_object_mut(), patch.as_object()) {
        for (key, v) in patch {
            if let Some(old) = target.get_mut(key) {
                merge(old, v)
            } else {
                target.insert(key.clone(), v.clone());
            }
        }
    } else {
        *value = patch.clone();
    }
}
fn modify(target: &mut Value, parts: &[String], operation: &str, args: &Value) -> Result<()> {
    if parts.is_empty() {
        match operation {
            "set" => *target = args["value"].clone(),
            "merge" => merge(target, &args["value"]),
            "remove" => *target = Value::Null,
            "append" => target
                .as_array_mut()
                .ok_or_else(|| Error::Invalid("append只适用于数组".into()))?
                .push(args["value"].clone()),
            "replace_text" => {
                let old = target
                    .as_str()
                    .ok_or_else(|| Error::Invalid("replace_text只适用于文字".into()))?;
                let find = text(args, "find");
                if find.is_empty() || !old.contains(find) {
                    return Err(Error::Invalid("没有找到待替换文字；请重新读取原文".into()));
                }
                *target = old.replace(find, text(args, "replace")).into();
            }
            _ => return Err(Error::Invalid("不支持的修改方式".into())),
        };
        return Ok(());
    }
    let key = &parts[0];
    if let Some(array) = target.as_array_mut() {
        let index = key
            .parse::<usize>()
            .map_err(|_| Error::Invalid("数组路径无效".into()))?;
        if index >= array.len() {
            return Err(Error::Invalid("数组路径超出范围".into()));
        }
        if parts.len() == 1 && operation == "remove" {
            array.remove(index);
            return Ok(());
        }
        modify(&mut array[index], &parts[1..], operation, args)
    } else {
        let object = target
            .as_object_mut()
            .ok_or_else(|| Error::Invalid("该路径不属于对象或数组".into()))?;
        if parts.len() == 1 && operation == "remove" {
            object.remove(key);
            return Ok(());
        }
        let child = object.entry(key.clone()).or_insert_with(|| {
            if parts.len() > 1 {
                json!({})
            } else {
                Value::Null
            }
        });
        modify(child, &parts[1..], operation, args)
    }
}
pub(crate) fn stage(db: &Connection, plan: &RunPlan, task: &str, args: &Value) -> Result<Value> {
    let scoped = scoped_resource_args(db, plan, task, args)?;
    let args = &scoped;
    let kind = canonical_kind(text(args, "kind"));
    let rid = text(args, "id");
    if kind=="facts" && text(args,"path").is_empty() && text(args,"operation")=="append" && args["value"].is_array(){
        return Err(Error::Tool{code:"invalid_append_item",field:"value",message:"facts的append每次追加一个事实对象，不能追加整个数组；多项请逐项append，或set保留原有项目的完整数组".into(),next:json!({"tool":"read_resource","args":{"kind":"facts"},"item":{"id":"事实唯一标识","detail":"具体事实文字","origin":"ai","citations":[]}})});
    }
    let mut w = workspace(db, task)?;
    let call = ws_call(args);
    if !call.is_empty()
        && w["appliedCalls"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == call))
    {
        return Ok(json!({"staged":true,"summary":args["summary"],"reused":true}));
    }
    if !w["edits"].is_array() {
        w["edits"] = json!([]);
    }
    let edits = w["edits"].as_array_mut().unwrap();
    let pos = edits.iter().position(|e| matches_edit(e, kind, rid));
    let mut edit = if let Some(pos) = pos {
        edits[pos].clone()
    } else {
        let original = resource(db, plan, kind, rid)?;
        json!({"kind":kind,"id":rid,"routeId":args["routeId"],"original":original,"after":original,"summaries":[]})
    };
    if let Some(route) = args.get("routeId") {
        edit["routeId"] = route.clone();
    }
    let path = text(args, "path");
    if !path.is_empty() && !path.starts_with('/') {
        return Err(Error::Invalid("path使用以/开头的JSON路径".into()));
    }
    // Resource ownership and internal identity are never model supplied.
    let root = path.split('/').nth(1).unwrap_or("");
    if kind == "book" && !["data", "title"].contains(&root) {
        return Err(Error::Invalid("参考书正文请修改/data/sections；章节和检索索引由核心重建，不能直接修改chunks/sections索引".into()));
    }
    if [
        "id",
        "world_id",
        "worldId",
        "parent_id",
        "parentId",
        "seq",
        "created_at",
        "last_child_id",
        "node_id",
    ]
    .contains(&root)
        && ![
            "settings",
            "state",
            "people",
            "places",
            "cards",
            "goals",
            "facts",
            "protagonist",
        ]
        .contains(&kind)
    {
        return Err(Error::Invalid(
            "内部归属由提交工具维护；请修改内容或路线headId".into(),
        ));
    }
    let parts: Vec<_> = path
        .split('/')
        .skip(1)
        .map(|s| s.replace("~1", "/").replace("~0", "~"))
        .collect();
    modify(&mut edit["after"], &parts, text(args, "operation"), args)?;
    if kind=="facts" {let before=edit["original"].clone();normalize_changed_fact_origins(&before,&mut edit["after"])?;}
    if kind=="state" {let before=edit["original"]["facts"].clone();normalize_changed_fact_origins(&before,&mut edit["after"]["facts"])?;}
    if let Some(conflicts)=edit["rebaseConflicts"].as_array_mut(){conflicts.retain(|conflict|{
        let at=text(conflict,"path");!(path.is_empty()||at==path||at.starts_with(&format!("{path}/")))
    });}
    if kind == "node"
        && (root == "record" || path.is_empty() && args["value"].get("record").is_some())
    {
        edit["recordReviewed"] = true.into();
    }
    edit["summaries"]
        .as_array_mut()
        .unwrap()
        .push(json!(text(args, "summary")));
    if !edit["callIds"].is_array(){edit["callIds"]=json!([]);}
    if !call.is_empty(){edit["callIds"].as_array_mut().unwrap().push(json!(call));}
    if edit["after"]==edit["original"] && edit["rebaseConflicts"].as_array().is_none_or(Vec::is_empty) {
        if let Some(pos)=pos {edits.remove(pos);}
    } else if let Some(pos) = pos {
        edits[pos] = edit
    } else {
        edits.push(edit)
    }
    if !w["appliedCalls"].is_array() {
        w["appliedCalls"] = json!([])
    }
    if !call.is_empty() {
        w["appliedCalls"].as_array_mut().unwrap().push(json!(call));
    }
    save_workspace(db, task, &w)?;
    Ok(
        json!({"staged":true,"summary":args["summary"],"message":"已放入本次修改草稿，完成任务后按当前策略采用"}),
    )
}

fn normalize_changed_fact_origins(before:&Value,after:&mut Value)->Result<()> {
    let Some(items)=after.as_array_mut()else{return Ok(());};
    for (index,item) in items.iter_mut().enumerate(){
        if before.as_array().into_iter().flatten().any(|old|old["id"]==item["id"]&&old==item){continue;}
        let origin=text(item,"origin");
        if origin.is_empty(){item["origin"]=if before.as_array().into_iter().flatten().any(|old|old["id"]==item["id"]){"legacyUnknown"}else{"ai"}.into();}
        else if ["canon","original","reference"].contains(&origin){item["origin"]="source".into();}
        else if !["source","player","branch","ai","correction","legacyUnknown"].contains(&origin){
            return Err(Error::Tool{code:"invalid_fact_origin",field:"value",message:format!("第{}条新修改事实的origin无效；请使用source/player/branch/ai/correction/legacyUnknown，出处是否成立仍须单独核对",index+1),next:json!({"path":format!("/facts/{index}/origin"),"allowed":["source","player","branch","ai","correction","legacyUnknown"]})});
        }
    }
    Ok(())
}
pub(crate) fn stage_story(db: &Connection, task: &str, args: &Value) -> Result<Value> {
    if text(args, "narrative").trim().is_empty() {
        return Err(Error::Invalid("正式剧情正文不能为空".into()));
    }
    let mut w = workspace(db, task)?;
    let call = ws_call(args);
    if !call.is_empty()
        && w["appliedCalls"]
            .as_array()
            .is_some_and(|a| a.iter().any(|v| v == call))
    {
        return Ok(json!({"staged":true,"summary":args["summary"],"reused":true}));
    }
    if !w["turns"].is_array() {
        w["turns"] = json!([])
    }
    w["turns"].as_array_mut().unwrap().push(args.clone());
    if !w["appliedCalls"].is_array() {
        w["appliedCalls"] = json!([])
    }
    if !call.is_empty() {
        w["appliedCalls"].as_array_mut().unwrap().push(json!(call));
    }
    save_workspace(db, task, &w)?;
    Ok(
        json!({"staged":true,"summary":args["summary"],"message":"已暂存为正式剧情；当前尚未改变故事"}),
    )
}
pub(crate) fn stage_route(
    db: &Connection,
    plan: &RunPlan,
    task: &str,
    args: &Value,
) -> Result<Value> {
    let mut w = workspace(db, task)?;
    let call = ws_call(args);
    if let Some(existing) = w["routes"]
        .as_array()
        .and_then(|a| a.iter().find(|r| text(r, "callId") == call))
    {
        return Ok(json!({"staged":true,"routeId":existing["id"],"summary":args["summary"]}));
    }
    let node_id = args["headId"]
        .as_str()
        .map(str::to_owned)
        .unwrap_or(head(db, plan)?);
    node(db, &plan.world_id, &node_id)?;
    let new = id();
    let route = json!({"id":new,"name":args["name"],"headId":node_id,"activate":args["activate"]==true,"summary":args["summary"],"callId":call});
    if !w["routes"].is_array() {
        w["routes"] = json!([])
    }
    w["routes"].as_array_mut().unwrap().push(route);
    save_workspace(db, task, &w)?;
    Ok(json!({"staged":true,"routeId":new,"summary":args["summary"]}))
}
fn ws_call(args: &Value) -> &str {
    args["_agentCall"].as_str().unwrap_or("")
}
pub(crate) fn discard_draft(db:&Connection,task:&str,args:&Value)->Result<Value>{
    let kind=text(args,"kind");
    if args["all"]!=true && kind.is_empty(){return Err(Error::Invalid("请指定待撤回的草稿kind/id，或all=true；此操作不撤回正式本局".into()));}
    let mut w=workspace(db,task)?;
    let before=changes(&w).len();
    for key in ["edits","turns","routes"] {
        if let Some(items)=w[key].as_array_mut(){items.retain(|item|{
            if args["all"]==true{return false;}
            let item_kind=if key=="turns"{"story"}else if key=="routes"{"line"}else{text(item,"kind")};
            !(item_kind==kind && (text(args,"id").is_empty()||text(item,"id")==text(args,"id")))
        });}
    }
    save_workspace(db,task,&w)?;
    Ok(json!({"discarded":true,"removedChanges":before.saturating_sub(changes(&w).len()),"verification":crate::agent_verification::pending(&w),"message":"仅撤回本任务尚未采用的草稿，正式剧情、已发生的外部操作和累计用量不变；查清后可以重新暂存"}))
}
pub(crate) fn changes(w: &Value) -> Vec<Value> {
    let mut changes = vec![];
    for edit in w["edits"].as_array().into_iter().flatten() {
        if edit["after"]==edit["original"] {continue;}
        for summary in edit["summaries"].as_array().into_iter().flatten() {
            changes.push(json!({"kind":edit["kind"],"id":edit["id"],"summary":summary}));
        }
    }
    for turn in w["turns"].as_array().into_iter().flatten() {
        changes
            .push(json!({"kind":"story","summary":turn["summary"],"narrative":turn["narrative"]}));
    }
    for route in w["routes"].as_array().into_iter().flatten() {
        changes.push(json!({"kind":"line","id":route["id"],"summary":route["summary"]}));
    }
    changes
}
pub(crate) fn preview_changes(w: &Value) -> Vec<Value> {
    let mut details = vec![];
    for edit in w["edits"].as_array().into_iter().flatten() {
        if edit["after"]==edit["original"] {continue;}
        details.push(json!({"kind":edit["kind"],"id":edit["id"],"routeId":edit["routeId"],"summary":edit["summaries"].as_array().into_iter().flatten().filter_map(Value::as_str).collect::<Vec<_>>().join("；"),"before":edit["original"],"after":edit["after"]}));
    }
    for turn in w["turns"].as_array().into_iter().flatten() {
        details.push(json!({"kind":"story","summary":turn["summary"],"before":null,"after":turn,"narrative":turn["narrative"]}));
    }
    for route in w["routes"].as_array().into_iter().flatten() {
        details.push(json!({"kind":"line","id":route["id"],"summary":route["summary"],"before":null,"after":route}));
    }
    details
}
fn scoped_preview_changes(plan: &RunPlan, w: &Value) -> Vec<Value> {
    let mut details = preview_changes(w);
    for edit in details.iter_mut().filter(|e| e["kind"] == "book") {
        scope_book(plan, &mut edit["before"]);
        scope_book(plan, &mut edit["after"]);
    }
    details
}

fn value_sql(value: &Value) -> rusqlite::types::Value {
    match value {
        Value::Null => rusqlite::types::Value::Null,
        Value::Number(n) if n.is_i64() => rusqlite::types::Value::Integer(n.as_i64().unwrap()),
        Value::Number(n) => rusqlite::types::Value::Real(n.as_f64().unwrap_or(0.)),
        Value::Bool(v) => rusqlite::types::Value::Integer(i64::from(*v)),
        Value::String(s) => rusqlite::types::Value::Text(s.clone()),
        v => rusqlite::types::Value::Text(v.to_string()),
    }
}
fn insert_row(db: &Connection, table: &str, row: &Value) -> Result<()> {
    let o = row
        .as_object()
        .ok_or_else(|| Error::Invalid("资料结构不完整".into()))?;
    let names: Vec<_> = o.keys().collect();
    let values: Vec<_> = o.values().map(value_sql).collect();
    let sql = format!(
        "INSERT INTO {table}({}) VALUES({}) ON CONFLICT DO UPDATE SET {}",
        names
            .iter()
            .map(|s| s.as_str())
            .collect::<Vec<_>>()
            .join(","),
        vec!["?"; names.len()].join(","),
        names
            .iter()
            .map(|s| format!("{s}=excluded.{s}"))
            .collect::<Vec<_>>()
            .join(",")
    );
    db.execute(&sql, rusqlite::params_from_iter(values))?;
    Ok(())
}
fn encode(mut doc: Value) -> Value {
    for (key, column) in [
        ("settings", "settings_json"),
        ("state", "state_json"),
        ("record", "record_json"),
        ("choices", "choices_json"),
        ("meta", "meta_json"),
        ("data", "json"),
    ] {
        if let Some(v) = doc.as_object_mut().unwrap().remove(key) {
            doc[column] = v.to_string().into();
        }
    }
    doc
}
fn path_nodes(db: &Connection, world: &str, head: &str) -> Result<Vec<Value>> {
    let mut result = vec![];
    let mut next = head.to_owned();
    let mut seen = HashSet::new();
    while !next.is_empty() {
        if !seen.insert(next.clone()) {
            return Err(Error::Invalid("故事路线出现循环".into()));
        }
        let row = node(db, world, &next)?;
        next = text(&row, "parent_id").into();
        result.push(row);
    }
    result.reverse();
    Ok(result)
}
fn clock_options(state: &Value, mode: &str, advance: bool) -> Value {
    let era = &state["era"];
    let style = era["clockStyle"]
        .as_str()
        .unwrap_or(if era["mode"] == "free" {
            "elapsed"
        } else {
            "era"
        });
    json!({"mode":mode,"advanceTime":advance,"difficulty":"标准","currency":era["currency"],"clock":{"mode":era["mode"],"clockStyle":style,"timeStyle":era["timeStyle"],"anchor":state["time"]["anchor"],"elapsedAnchor":state["time"]["elapsedAnchor"],"date":state["time"]["date"],"label":state["time"]["start"],"hour":state["time"]["startHour"].as_f64().unwrap_or(8.0),"rules":era["calendar"]}})
}
fn validate_state(db: &Connection, state: &Value) -> Result<()> {
    crate::agent_clock::validate_state_clock(state)?;
    if !state.is_object() || !state["protagonist"].is_object() || !state["time"].is_object() {
        return Err(Error::Invalid("世界状态缺少主角或时间".into()));
    }
    for field in [
        "people",
        "places",
        "cards",
        "goals",
        "deviations",
        "facts",
        "timeline",
        "dismissed",
    ] {
        if let Some(v) = state.get(field) {
            if !v.is_array() {
                return Err(Error::Invalid(format!("{field}必须是列表")));
            }
            let strings = ["deviations", "dismissed"].contains(&field);
            if !v.as_array().unwrap().iter().all(|i| {
                if strings {
                    i.is_string()
                } else {
                    i.is_object()
                }
            }) {
                return Err(Error::Invalid(format!("{field}列表内容格式无效")));
            }
        }
    }
    for field in ["items", "statuses"] {
        if let Some(v) = state["protagonist"].get(field) {
            if !v.is_array() {
                return Err(Error::Invalid(format!("主角{field}必须是列表")));
            }
        }
    }
    if let Some(stats) = state["protagonist"].get("stats") {
        if !stats.is_object() {
            return Err(Error::Invalid("主角数值必须是对象".into()));
        }
        for (field, value) in stats.as_object().unwrap() {
            if !value.is_null() && !value.as_f64().is_some_and(f64::is_finite) {
                return Err(Error::Invalid(format!("主角{field}必须是有限数值")));
            }
        }
    }
    if !state["time"]["elapsedMinutes"]
        .as_f64()
        .is_some_and(|v| v.is_finite() && v >= 0.)
    {
        return Err(Error::Invalid("经过时间必须是非负有限数值".into()));
    }
    if let Some(binding) = state.get("source").filter(|s| !s.is_null()) {
        let book = binding["bookId"]
            .as_str()
            .ok_or_else(|| Error::Invalid("参考书籍绑定缺少bookId".into()))?;
        let max: Option<i64> = db.query_row(
            "SELECT MAX(section) FROM source_sections WHERE book_id=?",
            [book],
            |r| r.get(0),
        )?;
        let max = max.ok_or_else(|| Error::Invalid("参考书籍不存在或没有章节".into()))?;
        for field in ["through", "position"] {
            if let Some(v) = binding.get(field).filter(|v| !v.is_null()) {
                if !v.as_i64().is_some_and(|n| n >= 0 && n <= max) {
                    return Err(Error::Invalid(format!("原著{field}超出有效章节")));
                }
            }
        }
    }
    Ok(())
}
fn settle(before: &Value, node: &Value) -> Result<Value> {
    let record = &node["record"];
    let advance = !["edit", "query", "rewrite"].contains(&text(node, "kind"));
    let derived = clock_options(before, text(node, "action_mode"), advance);
    let mut options = node["meta"]
        .get("settlementOptions")
        .cloned()
        .unwrap_or_else(|| derived.clone());
    // A history repair must project the evolving clock, not a frozen old date.
    options["clock"] = derived["clock"].clone();
    options["advanceTime"] = advance.into();
    let mut state = rules::apply_record(before, record, &options)
        .map(|v| v["state"].clone())
        .map_err(Error::Invalid)?;
    if let Some(patch) = node["meta"].get("agentStatePatch") {
        for p in patch.as_array().into_iter().flatten() {
            let parts: Vec<_> = text(p, "path")
                .split('/')
                .skip(1)
                .map(|s| s.replace("~1", "/").replace("~0", "~"))
                .collect();
            modify(
                &mut state,
                &parts,
                if p["remove"] == true { "remove" } else { "set" },
                p,
            )?;
        }
    }
    Ok(state)
}
fn diff(before: &Value, after: &Value, path: &str, out: &mut Vec<Value>) {
    if semantic_equal(before, after) {
        return;
    }
    if let (Some(a), Some(b)) = (before.as_object(), after.as_object()) {
        for k in a.keys().chain(b.keys()).collect::<HashSet<_>>() {
            let p = format!("{}/{}", path, k.replace('~', "~0").replace('/', "~1"));
            match (a.get(k), b.get(k)) {
                (Some(a), Some(b)) => diff(a, b, &p, out),
                (None, Some(b)) => out.push(json!({"path":p,"value":b})),
                (Some(_), None) => out.push(json!({"path":p,"remove":true})),
                _ => {}
            }
        }
    } else {
        out.push(json!({"path":path,"value":after}))
    }
}
fn semantic_equal(a: &Value, b: &Value) -> bool {
    match (a, b) {
        (Value::Number(a), Value::Number(b)) => a.as_f64() == b.as_f64(),
        (Value::Array(a), Value::Array(b)) => {
            a.len() == b.len() && a.iter().zip(b).all(|(a, b)| semantic_equal(a, b))
        }
        (Value::Object(a), Value::Object(b)) => {
            a.len() == b.len()
                && a.iter()
                    .all(|(k, a)| b.get(k).is_some_and(|b| semantic_equal(a, b)))
        }
        _ => a == b,
    }
}

/// Return (head, changes). Called only while holding the final SQLite transaction.
fn apply_workspace(tx: &Transaction<'_>, plan: &RunPlan, w: &Value) -> Result<String> {
    let original_head = head(tx, plan)?;
    for route in w["routes"].as_array().into_iter().flatten() {
        node(tx, &plan.world_id, text(route, "headId"))?;
        tx.execute("INSERT INTO lines(id,world_id,name,node_id,kind,auto_named,archived,created_at) VALUES(?,?,?,?,'line',0,0,?)",params![text(route,"id"),plan.world_id,text(route,"name"),text(route,"headId"),now()])?;
        if route["activate"] == true {
            tx.execute(
                "UPDATE worlds SET current_line_id=? WHERE id=?",
                params![text(route, "id"), plan.world_id],
            )?;
        }
    }
    let mut node_edits: HashMap<String, Value> = HashMap::new();
    let mut state_edits: HashMap<String, Value> = HashMap::new();
    for edit in w["edits"].as_array().into_iter().flatten() {
        if edit["after"]==edit["original"] {continue;}
        let kind = text(edit, "kind");
        let rid = if text(edit, "id").is_empty() {
            original_head.as_str()
        } else {
            text(edit, "id")
        };
        let after = edit["after"].clone();
        match kind {
            "node" => {
                if !after.is_null() && text(&after, "world_id") != plan.world_id {
                    return Err(Error::Invalid("剧情只能属于本局".into()));
                }
                if !after.is_null()
                    && (!after["narrative"].is_string()
                        || !after["record"].is_object()
                        || !after["choices"].is_array()
                        || !after["meta"].is_object())
                {
                    return Err(Error::Invalid(
                        "剧情资料的正文、record、choices或meta格式无效".into(),
                    ));
                }
                if after["narrative"] != edit["original"]["narrative"]
                    && edit["recordReviewed"] != true
                {
                    return Err(Error::Invalid(
                        "修改剧情后还需核对并暂存这一回合的record，再重算后续状态".into(),
                    ));
                }
                node_edits.insert(rid.into(), after);
            }
            "state" => {
                validate_state(tx, &after)?;
                crate::agent_clock::validate_clock_transition(&edit["original"], &after)?;
                state_edits.insert(rid.into(), after);
            }
            "protagonist" | "people" | "places" | "cards" | "goals" | "facts" => {
                let mut s =
                    state_edits
                        .get(rid)
                        .cloned()
                        .unwrap_or(state(tx, &plan.world_id, rid)?);
                s[kind] = after;
                state_edits.insert(rid.into(), s);
            }
            "settings" => {
                if !after.is_object() {
                    return Err(Error::Invalid("本局设置必须是对象".into()));
                }
                tx.execute(
                    "UPDATE worlds SET settings_json=? WHERE id=?",
                    params![after.to_string(), plan.world_id],
                )?;
            }
            "world" => {
                if after["id"] != plan.world_id {
                    return Err(Error::Invalid("不能改变本局内部归属".into()));
                }
                tx.execute(
                    "UPDATE worlds SET title=?,era_id=?,settings_json=?,archived=? WHERE id=?",
                    params![
                        after["title"].as_str().unwrap_or("未命名故事"),
                        after["era_id"].as_str().unwrap_or(""),
                        after["settings"].to_string(),
                        after["archived"].as_i64().unwrap_or(0),
                        plan.world_id
                    ],
                )?;
                if let Some(line) = after["current_line_id"].as_str() {
                    let l = raw(tx, "lines", "id", line)?;
                    if text(&l, "world_id") != plan.world_id {
                        return Err(Error::Invalid("只能切换本局路线".into()));
                    }
                    tx.execute(
                        "UPDATE worlds SET current_line_id=? WHERE id=?",
                        params![line, plan.world_id],
                    )?;
                }
            }
            "line" | "pin" | "chapter" => {
                let table = match kind {
                    "line" => "lines",
                    "pin" => "pins",
                    _ => "chapters",
                };
                let rid = if text(edit, "id").is_empty() && kind == "line" {
                    &plan.line_id
                } else {
                    text(edit, "id")
                };
                if after.is_null() {
                    if kind == "line" && rid == plan.line_id {
                        return Err(Error::Invalid(
                            "请先切换到保留的路线，再删除当前路线".into(),
                        ));
                    }
                    tx.execute(
                        &format!("DELETE FROM {table} WHERE id=? AND world_id=?"),
                        params![rid, plan.world_id],
                    )?;
                } else {
                    if text(&after, "id") != rid || text(&after, "world_id") != plan.world_id {
                        return Err(Error::Invalid("不能改变资料内部归属".into()));
                    }
                    let mut after = after;
                    if kind == "line" {
                        if let Some(n) = after.as_object_mut().unwrap().remove("headId") {
                            node(tx, &plan.world_id, n.as_str().unwrap_or(""))?;
                            after["node_id"] = n;
                        }
                    }
                    insert_row(tx, table, &encode(after))?;
                }
            }
            "book" => derive_book(tx, plan, edit, &mut state_edits, &original_head)?,
            _ => return Err(Error::Invalid("该资料不允许写入".into())),
        }
    }
    // Rebuild every current-story route using an edited node, preserving all
    // old paths and their post-state snapshots for the reversible task.
    let affected: HashSet<String> = node_edits
        .keys()
        .chain(state_edits.keys())
        .cloned()
        .collect();
    let routes = rows(
        tx,
        "SELECT * FROM lines WHERE world_id=? AND deleted_at IS NULL",
        &[&plan.world_id],
    )?;
    let route_paths: HashMap<String, Vec<Value>> = routes
        .iter()
        .map(|r| {
            Ok((
                text(r, "id").to_string(),
                path_nodes(tx, &plan.world_id, text(r, "node_id"))?,
            ))
        })
        .collect::<Result<_>>()?;
    let main_nodes: HashSet<_> = route_paths
        .get(&plan.line_id)
        .into_iter()
        .flatten()
        .map(|n| text(n, "id").to_owned())
        .collect();
    let mut targets: HashMap<String, String> = HashMap::new();
    for target in &affected {
        let requested = w["edits"]
            .as_array()
            .into_iter()
            .flatten()
            .find(|e| {
                text(e, "id") == target || text(e, "id").is_empty() && target == &original_head
            })
            .and_then(|e| e["routeId"].as_str());
        let route = if let Some(route) = requested {
            route.to_owned()
        } else if main_nodes.contains(target) {
            plan.line_id.clone()
        } else {
            routes
                .iter()
                .find(|r| {
                    route_paths
                        .get(text(r, "id"))
                        .is_some_and(|path| path.iter().any(|n| text(n, "id") == target))
                })
                .map(|r| text(r, "id").to_owned())
                .ok_or_else(|| {
                    Error::Invalid("目标剧情不在有效路线；请先保留/恢复相应路线".into())
                })?
        };
        if !route_paths
            .get(&route)
            .is_some_and(|path| path.iter().any(|n| text(n, "id") == target))
        {
            return Err(Error::Invalid("指定剧情不在目标路线".into()));
        }
        targets.insert(target.clone(), route);
    }
    let mut processed = HashSet::new();
    for route in routes {
        let route_id = text(&route, "id");
        let local: HashSet<_> = targets
            .iter()
            .filter(|(_, r)| r.as_str() == route_id)
            .map(|(n, _)| n.clone())
            .collect();
        if local.is_empty() {
            continue;
        }
        let path = route_paths.get(route_id).cloned().unwrap_or_default();
        let Some(first) = path.iter().position(|n| local.contains(text(n, "id"))) else {
            continue;
        };
        let mut parent = if first > 0 {
            Some(text(&path[first - 1], "id").to_owned())
        } else {
            None
        };
        let mut previous = if first > 0 {
            state(tx, &plan.world_id, parent.as_deref().unwrap())?
        } else {
            Value::Null
        };
        let mut remap: HashMap<String,String> = HashMap::new();
        for old in path.iter().skip(first) {
            let old_id = text(old, "id");
            let mut changed = if local.contains(old_id) {
                node_edits
                    .get(old_id)
                    .cloned()
                    .unwrap_or_else(|| old.clone())
            } else {
                old.clone()
            };
            if local.contains(old_id) {
                processed.insert(old_id.to_owned());
            }
            if changed.is_null() {
                if parent.is_none() {
                    return Err(Error::Invalid("开场不能直接删除；请修改开场内容".into()));
                }
                continue;
            }
            let explicitly_set = if local.contains(old_id) {
                state_edits.get(old_id)
            } else {
                None
            };
            let next = if let Some(s) = explicitly_set {
                s.clone()
            } else if previous.is_null() {
                let seed = changed["meta"]["openingSeed"].clone();
                if seed.is_null() {
                    return Err(Error::Invalid(
                        "旧开场没有初始状态，请同时提供核对后的state或meta.openingSeed".into(),
                    ));
                }
                opening_state(&seed, &changed)?
            } else {
                settle(&previous, &changed)?
            };
            validate_state(tx, &next)?;
            crate::agent_clock::validate_clock_transition(&state(tx, &plan.world_id, old_id)?, &next)?;
            if let Some(s) = explicitly_set {
                let calculated = if previous.is_null() {
                    state(tx, &plan.world_id, old_id)?
                } else {
                    settle(&previous, &changed)?
                };
                let mut patch = vec![];
                diff(&calculated, s, "", &mut patch);
                changed["meta"]["agentStatePatch"] = json!(patch);
            }
            let new_id = id();
            changed["id"] = new_id.clone().into();
            changed["parent_id"] = json!(parent);
            changed["last_child_id"] = Value::Null;
            changed["created_at"] = now().into();
            changed["rewritten"] = 1.into();
            changed["meta"]["agentOriginalNodeId"] = old_id.into();
            if changed["record"]["continuity"].is_object(){
                for kind in ["knowledge","threads"] {for item in changed.get_mut("record").and_then(|r|r.get_mut("continuity")).and_then(|r|r.get_mut(kind)).and_then(Value::as_array_mut).into_iter().flatten(){
                    if let Some(source)=item["source"]["nodeId"].as_str().map(str::to_owned){if source==old_id{item["source"]["nodeId"]=new_id.clone().into();}else if let Some(mapped)=remap.get(&source){item["source"]["nodeId"]=Value::String(mapped.clone());}}
                    if kind=="knowledge" {let prior=state(tx,&plan.world_id,old_id)?;if let Some(person)=prior["people"].as_array().into_iter().flatten().find(|p|p["id"]==item["person"]){if let Some(p)=next["people"].as_array().into_iter().flatten().find(|p|p["name"]==person["name"]){item["person"]=p["id"].clone();}}}
                }}
                let action=json!({"text":changed["action_text"],"directorNote":changed["director_note"]});
                let (record,_)=crate::continuity::validate_record(tx,&plan.world_id,parent.as_deref().unwrap_or(""),&new_id,text(&changed,"narrative"),&action,&next,&changed["record"],true)?;
                changed["record"]=record;
            }

            insert_row(tx, "nodes", &encode(changed))?;
            tx.execute(
                "INSERT INTO states(node_id,state_json) VALUES(?,?)",
                params![new_id, next.to_string()],
            )?;
            if let Some(p) = &parent {
                tx.execute(
                    "UPDATE nodes SET last_child_id=? WHERE id=?",
                    params![new_id, p],
                )?;
            }
            remap.insert(old_id.to_owned(), new_id.clone());
            parent = Some(new_id);
            previous = next;
        }
        let final_head = parent.ok_or_else(|| Error::Invalid("路线至少需要一个开场".into()))?;
        tx.execute(
            "UPDATE lines SET node_id=? WHERE id=?",
            params![final_head, route["id"].as_str()],
        )?;
        // A summary based on changed history must never remain a source for the new route.
        // Keep the old chapter for old routes, rebuild a sourced summary for the copied one.
        if exists(tx, "chapters") {
            for mut chapter in rows(
                tx,
                "SELECT * FROM chapters WHERE world_id=?",
                &[&plan.world_id],
            )? {
                let first = text(&chapter, "first_node_id").to_owned();
                let last = text(&chapter, "last_node_id").to_owned();
                if remap.contains_key(&first) || remap.contains_key(&last) {
                    chapter["id"] = id().into();
                    if let Some(n) = remap.get(&first) {
                        chapter["first_node_id"] = n.clone().into();
                    }
                    if let Some(n) = remap.get(&last) {
                        chapter["last_node_id"] = n.clone().into();
                    }
                    let Some(start) = path.iter().position(|n| text(n, "id") == first) else {
                        continue;
                    };
                    let Some(end) = path.iter().position(|n| text(n, "id") == last) else {
                        continue;
                    };
                    if end < start {
                        continue;
                    }
                    let summary = path[start..=end]
                        .iter()
                        .map(|n| {
                            if local.contains(text(n, "id")) {
                                node_edits.get(text(n, "id")).unwrap_or(n)
                            } else {
                                n
                            }
                        })
                        .filter(|n| !n.is_null())
                        .map(|n| text(n, "narrative").chars().take(360).collect::<String>())
                        .collect::<Vec<_>>()
                        .join("\n");
                    if chapter.get("title").is_some() {
                        chapter["title"] = summary
                            .lines()
                            .next()
                            .unwrap_or("修订章节")
                            .chars()
                            .take(24)
                            .collect::<String>()
                            .into();
                    }
                    if chapter.get("gist").is_some() {
                        chapter["gist"] = summary.chars().take(240).collect::<String>().into();
                    }
                    chapter["summary"] = summary.into();
                    chapter["model"] = "agent-history-replay".into();
                    chapter["edited"] = 1.into();
                    insert_row(tx, "chapters", &chapter)?;
                }
            }
        }
        if exists(tx, "pins") {
            for mut pin in rows(tx, "SELECT * FROM pins WHERE world_id=?", &[&plan.world_id])? {
                if let Some(n) = remap.get(text(&pin, "origin_node_id")) {
                    pin["id"] = id().into();
                    pin["origin_node_id"] = n.clone().into();
                    insert_row(tx, "pins", &pin)?;
                }
            }
        }
    }
    if processed != affected {
        return Err(Error::Invalid(
            "部分目标剧情没有完成重算，整批修改未采用".into(),
        ));
    }
    let active_line: String = tx.query_row(
        "SELECT current_line_id FROM worlds WHERE id=?",
        [&plan.world_id],
        |r| r.get(0),
    )?;
    let mut current_head: String = tx.query_row(
        "SELECT node_id FROM lines WHERE id=? AND world_id=?",
        params![active_line, plan.world_id],
        |r| r.get(0),
    )?;
    for turn in w["turns"].as_array().into_iter().flatten() {
        let before = state(tx, &plan.world_id, &current_head)?;
        let seq: i64 = tx.query_row("SELECT seq FROM nodes WHERE id=?", [&current_head], |r| {
            r.get(0)
        })?;
        let record = turn
            .get("record")
            .filter(|v| v.is_object())
            .cloned()
            .ok_or_else(|| {
                Error::Invalid("写入正式剧情需要与正文一致的record，不能只保存正文".into())
            })?;
        let opts = clock_options(&before, "continue", true);
        let after =
            rules::apply_record(&before, &record, &opts).map_err(Error::Invalid)?["state"].clone();
        let new = id();
        let (record,_)=crate::continuity::validate_record(tx,&plan.world_id,&current_head,&new,text(turn,"narrative"),&json!({"text":"Agent 写入剧情"}),&after,&record,true)?;
        tx.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,action_mode,action_text,narrative,record_json,choices_json,status,meta_json,created_at) VALUES(?,?,?,?, 'turn','continue','Agent 写入剧情',?,?,?,'ok',?,?)",params![new,plan.world_id,current_head,seq+1,text(turn,"narrative"),record.to_string(),turn.get("choices").unwrap_or(&json!([])).to_string(),json!({"agentTaskId":plan.meta["agent"]["taskId"],"settlementOptions":opts}).to_string(),now()])?;
        tx.execute(
            "INSERT INTO states(node_id,state_json) VALUES(?,?)",
            params![new, after.to_string()],
        )?;
        tx.execute(
            "UPDATE nodes SET last_child_id=? WHERE id=?",
            params![new, current_head],
        )?;
        current_head = new;
        tx.execute(
            "UPDATE lines SET node_id=? WHERE id=?",
            params![current_head, active_line],
        )?;
    }
    if !changes(w).is_empty() {
        tx.execute(
            "UPDATE worlds SET updated_at=? WHERE id=?",
            params![now(), plan.world_id],
        )?;
    }
    Ok(current_head)
}
fn derive_book(
    tx: &Transaction<'_>,
    plan: &RunPlan,
    edit: &Value,
    states: &mut HashMap<String, Value>,
    head: &str,
) -> Result<()> {
    let after = &edit["after"];
    if after.is_null() {
        return Err(Error::Invalid(
            "共享原著不能由本局删除；可以解除本局source绑定".into(),
        ));
    }
    let new = id();
    let mut data = after["data"].clone();
    let at = now();
    if !data.is_object()
        || !data["sections"].is_array()
        || data["sections"].as_array().is_none_or(Vec::is_empty)
    {
        return Err(Error::Invalid("参考书必须含标准化data.sections正文".into()));
    }
    data["id"] = new.clone().into();
    data["createdAt"] = at.clone().into();
    if after["title"] != edit["original"]["title"] {
        data["title"] = after["title"].clone();
    }
    if !data["title"].is_string() {
        return Err(Error::Invalid("参考书名必须是文字".into()));
    }
    if !["txt", "epub", "pdf", "docx"].contains(&text(&data, "format")) {
        return Err(Error::Invalid("参考书格式无效".into()));
    }
    tx.execute(
        "INSERT INTO source_books(id,title,format,created_at,json) VALUES(?,?,?,?,?)",
        params![
            new,
            text(&data, "title"),
            text(&data, "format"),
            at,
            data.to_string()
        ],
    )?;
    let mut terms: HashMap<String, Vec<i64>> = HashMap::new();
    let mut ordinal = 0i64;
    for (section, s) in data["sections"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if !s["title"].is_string() || !s["text"].is_string() {
            return Err(Error::Invalid("参考书章节必须包含title和text文字".into()));
        }
        tx.execute(
            "INSERT INTO source_sections(book_id,section,title,page) VALUES(?,?,?,?)",
            params![new, section as i64, text(s, "title"), s["page"].as_i64()],
        )?;
        let mut chunk = String::new();
        let mut units = 0;
        let mut flush = |chunk: &mut String| -> Result<()> {
            if chunk.is_empty() {
                return Ok(());
            }
            for term in crate::runtime_sources::terms(chunk) {
                terms.entry(term).or_default().push(ordinal);
            }
            tx.execute(
                "INSERT INTO source_chunks(book_id,ordinal,section,text) VALUES(?,?,?,?)",
                params![new, ordinal, section as i64, *chunk],
            )?;
            ordinal += 1;
            chunk.clear();
            Ok(())
        };
        for c in text(s, "text").chars() {
            if units + c.len_utf16() > 2400 {
                flush(&mut chunk)?;
                units = 0;
            }
            chunk.push(c);
            units += c.len_utf16();
        }
        flush(&mut chunk)?;
    }
    for (term, postings) in terms {
        tx.execute(
            "INSERT INTO source_terms(book_id,term,postings) VALUES(?,?,?)",
            params![new, term, json!(postings).to_string()],
        )?;
    }
    let mut s = states
        .get(head)
        .cloned()
        .unwrap_or(state(tx, &plan.world_id, head)?);
    if s["source"]["bookId"] == edit["original"]["id"] {
        s["source"]["bookId"] = new.into();
        if let Some(o) = s["source"].as_object_mut() {
            o.remove("analysisId");
        }
        states.insert(head.into(), s);
    }
    Ok(())
}
fn opening_state(seed: &Value, node: &Value) -> Result<Value> {
    let mut initial = seed.clone();
    let record = &node["record"];
    if let Some(hour) = record.get("hour") {
        initial["time"]["startHour"] = hour.clone();
    }
    if initial["era"]["clockStyle"] != "elapsed" {
        if let Some(date) = record.get("date") {
            if let Some(parsed) = rules::calendar::read_date(date, &initial["era"]["calendar"]) {
                initial["time"]["date"] = serde_json::to_value(&parsed)?;
                initial["time"]["start"] =
                    rules::calendar::format_date(&parsed, &initial["era"]["calendar"]).into();
            } else if initial["era"]["packId"].is_null() && date.is_string() {
                initial["time"]["start"] = date.clone();
            }
        }
    }
    if initial["era"]["packId"].is_null() {
        if let Some(currency) = record.get("currency").filter(|v| v.is_array()) {
            initial["era"]["currency"] = json!({"units":currency});
        }
    }
    if let Some(money) = rules::money::parse_money(&record["money"], &initial["era"]["currency"]) {
        initial["protagonist"]["stats"]["money"] = json!(money.max(0.));
    }
    let mut opening = node.clone();
    opening["kind"] = "edit".into();
    opening["record"]
        .as_object_mut()
        .ok_or_else(|| Error::Invalid("开场记录无效".into()))?
        .remove("money");
    if let Some(events) = initial["timeline"].as_array() {
        initial["timeline"] = json!(rules::calendar::retime(
            events,
            &clock_options(&initial, "continue", false)["clock"]
        ));
    }
    settle(&initial, &opening)
}
pub(crate) fn validate(tx: &Transaction<'_>, plan: &RunPlan, task: &str) -> Result<Value> {
    let row = workspace_task(tx, task)?;
    guard(tx, &parse(text(&row, "base_json")))?;
    let w = workspace(tx, task)?;
    if w["edits"].as_array().into_iter().flatten().any(|e|e["rebaseConflicts"].as_array().is_some_and(|c|!c.is_empty())) {
        return Err(Error::Tool{code:"draft_rebase_conflict",field:"edits",message:"故事变化后有冲突字段尚未重新核对；请读取草稿的rebaseConflicts并针对这些字段重新暂存或撤回".into(),next:json!({"tool":"check_draft","args":{}})});
    }
    tx.execute_batch("SAVEPOINT agent_validation")?;
    let result = apply_workspace(tx, plan, &w);
    let report = match result {
        Ok(head) => Ok(
            json!({"valid":true,"headId":head,"changes":changes(&w),"preview":{"changes":scoped_preview_changes(plan,&w)},"summary":"本批修改已通过结构、引用、时间和路线重算检查；叙事与原著事实仍须按证据核对。"}),
        ),
        Err(error) => Err(error),
    };
    tx.execute_batch("ROLLBACK TO agent_validation; RELEASE agent_validation")?;
    report
}
#[cfg(test)]
pub(crate) fn apply(
    tx: &Transaction<'_>,
    plan: &RunPlan,
    task: &str,
    summary: &str,
) -> Result<Value> {
    let row = raw(tx, "agent_tasks", "id", task)?;
    let (result, backup) = apply_contents(tx, plan, task, summary)?;
    // Legacy compatibility only. Pi commits its own receipt and story-owned
    // recovery record in the gateway's transaction, never in this table.
    tx.execute("UPDATE agent_tasks SET status='committed',backup_json=?,result_json=?,error=NULL,updated_at=? WHERE id=?",params![backup.map(|b|b.to_string()),result.to_string(),now(),text(&row,"id")])?;
    Ok(result)
}

pub(crate) fn apply_contents(
    tx: &Transaction<'_>,
    plan: &RunPlan,
    task: &str,
    summary: &str,
) -> Result<(Value, Option<Value>)> {
    let row = workspace_task(tx, task)?;
    let base = parse(text(&row, "base_json"));
    guard(tx, &base)?;
    let w = parse(text(&row, "workspace_json"));
    let changes = changes(&w);
    let before = if text(&row, "policy") == "auto-reversible" && !changes.is_empty() {
        Some(capture(tx, &plan.world_id)?)
    } else {
        None
    };
    let head = apply_workspace(tx, plan, &w)?;
    let backup = match before {
        Some(before) => Some(json!({"before":before,"postFingerprint":fingerprint(tx,&plan.world_id)?,"worldId":plan.world_id})),
        None => None,
    };
    let result = json!({"summary":summary,"changes":changes,"headId":head,"worldChanged":!changes.is_empty(),"undoable":backup.is_some()});
    Ok((result, backup))
}
#[cfg(test)]
pub(crate) fn undo(tx: &Transaction<'_>, task: &str) -> Result<Value> {
    let row = raw(tx, "agent_tasks", "id", task)?;
    if text(&row, "status") != "committed" || text(&row, "policy") != "auto-reversible" {
        return Err(Error::Invalid("这项任务没有可撤回的恢复点".into()));
    }
    let backup = parse(text(&row, "backup_json"));
    restore_backup(tx, &backup)?;
    tx.execute(
        "UPDATE agent_tasks SET status='undone',backup_json=NULL,updated_at=? WHERE id=?",
        params![now(), task],
    )?;
    Ok(json!({"undone":true,"worldChanged":true}))
}

pub(crate) fn restore_backup(tx: &Transaction<'_>, backup: &Value) -> Result<()> {
    let world = text(&backup, "worldId");
    if world.is_empty() || fingerprint(tx, world)? != text(&backup, "postFingerprint") {
        return Err(Error::Stale);
    }
    let before = &backup["before"];
    // Restore existing rows first. Delete newly created state/node rows only
    // after lines and parents point at the saved path again.
    for table in [
        "worlds",
        "nodes",
        "states",
        "lines",
        "pins",
        "chapters",
        "fact_corrections",
        "story_fact_sources",
    ] {
        for row in before[table].as_array().into_iter().flatten() {
            insert_row(tx, table, row)?;
        }
    }
    for table in [
        "story_fact_sources",
        "fact_corrections",
        "pins",
        "chapters",
        "lines",
        "states",
        "nodes",
    ] {
        if !exists(tx, table) {
            continue;
        }
        let key = if table == "states" { "node_id" } else { "id" };
        let keep: HashSet<_> = before[table]
            .as_array()
            .into_iter()
            .flatten()
            .map(|r| text(r, key).to_owned())
            .collect();
        let live = table_rows(tx, table, world)?;
        let mut removing: Vec<_> = live
            .as_array()
            .into_iter()
            .flatten()
            .filter(|r| !keep.contains(text(r, key)))
            .cloned()
            .collect();
        if table == "nodes" {
            removing.sort_by_key(|r| std::cmp::Reverse(r["seq"].as_i64().unwrap_or(0)));
        }
        for row in removing {
            tx.execute(
                &format!("DELETE FROM {table} WHERE {key}=?"),
                [text(&row, key)],
            )?;
        }
    }
    Ok(())
}

#[cfg(test)]
mod cursor_tests {
 use super::*;
 #[test]fn v2_pages_do_not_lose_items_or_mix_oversized_locators_with_data(){
  let data=json!([{"name":"短项"},{"name":"超大项","text":"甲".repeat(2000)},{"name":"最后项"}]);
  let first=page(data.clone(),&json!({"pageSize":2,"charBudget":200}));assert_eq!(first["value"].as_array().unwrap().len(),1);
  let second=page(data.clone(),&json!({"pageSize":2,"charBudget":200,"nextCursor":first["nextCursor"]}));assert_eq!(second["value"],json!([]));assert_eq!(second["oversized"][0]["index"],1);assert_eq!(second["complete"],false);
  let third=page(data.clone(),&json!({"pageSize":2,"charBudget":200,"nextCursor":second["nextCursor"]}));assert_eq!(third["value"][0]["name"],"最后项");assert!(third["nextCursor"].is_null());
  let changed=page(json!([{"name":"新内容"}]),&json!({"pageSize":2,"nextCursor":first["nextCursor"]}));assert_eq!(changed["pageError"]["code"],"page_version_changed");
  assert_eq!(page(data,&json!({"offset":2,"limit":200}))["value"][0]["name"],"最后项","old offset/limit remains readable");
 }
}
