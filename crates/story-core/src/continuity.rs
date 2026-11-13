//! Sparse, sourced continuity changes live on their adopting node's record.
//! No current-state copy or globally mutable truth table is maintained.
use crate::{Error, Result};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};

const MAX_CHANGES: usize = 8;
fn issue(issues: &mut Vec<String>, message: &str) {
    if issues.len() < 20 {
        issues.push(message.into());
    }
}
fn text(value: &Value, maximum: usize) -> Option<String> {
    value
        .as_str()
        .map(str::trim)
        .filter(|s| !s.is_empty() && s.encode_utf16().count() <= maximum && !s.contains('\0'))
        .map(str::to_owned)
}
fn source(raw: &Value) -> Option<Value> {
    let from = raw["from"]
        .as_str()
        .filter(|s| ["narrative", "action"].contains(s))?;
    let quote = text(&raw["quote"], 600)?;
    let mut out = json!({"from":from,"quote":quote});
    if let Some(id) = raw.get("nodeId") {
        out["nodeId"] = text(id, 100)?.into();
    }
    Some(out)
}
fn normal_knowledge(raw: &Value) -> Option<Value> {
    let mut out = json!({"id":text(&raw["id"],100)?,"person":text(&raw["person"],100)?,"claim":text(&raw["claim"],600)?,
        "awareness":raw["awareness"].as_str().filter(|s|["witnessed","told","believes","rumor","denied","uncertain"].contains(s))?,"source":source(&raw["source"])?});
    if let Some(active) = raw.get("active") {
        if !active.is_boolean() {
            return None;
        }
        out["active"] = active.clone();
    }
    Some(out)
}
fn normal_thread(raw: &Value) -> Option<Value> {
    let mut out = json!({"id":text(&raw["id"],100)?,"kind":raw["kind"].as_str().filter(|s|["clue","promise"].contains(s))?,
        "title":text(&raw["title"],120)?,"detail":text(&raw["detail"],1200)?,"status":raw["status"].as_str().filter(|s|["open","resolved","dismissed"].contains(s))?,"source":source(&raw["source"])?});
    if let Some(recall) = raw.get("recall") {
        if !recall.is_boolean() {
            return None;
        }
        out["recall"] = recall.clone();
    }
    if let Some(due) = raw.get("dueMinute") {
        let minute = due
            .as_f64()
            .filter(|n| n.fract() == 0.0 && (0.0..=9_007_199_254_740_991.0).contains(n))?;
        out["dueMinute"] = json!(minute);
    }
    if let Some(entities) = raw.get("entities") {
        let entities = entities.as_array()?;
        if entities.len() > 12 {
            return None;
        }
        let mut seen = HashSet::new();
        let mut names = vec![];
        for entity in entities {
            let name = text(entity, 100)?;
            if seen.insert(name.clone()) {
                names.push(name);
            }
        }
        out["entities"] = json!(names);
    }
    Some(out)
}

/// Optional metadata is deliberately independent of ordinary record validity.
/// Invalid entries are omitted and reported; callers must not retry the model
/// merely because it supplied a bad continuity annotation.
pub(crate) fn normalize(raw: &Value, issues: &mut Vec<String>) -> Value {
    if raw.is_null() {
        return json!({});
    }
    if !raw.is_object() {
        issue(issues, "知情与线索附加记录格式无效，已忽略");
        return json!({});
    }
    let mut out = Map::new();
    for key in ["knowledge", "threads"] {
        let Some(values) = raw.get(key) else {
            continue;
        };
        let Some(values) = values.as_array() else {
            issue(issues, "知情与线索应为变化列表，已忽略无效部分");
            continue;
        };
        if values.len() > MAX_CHANGES {
            issue(issues, "本回合知情或线索变化过多，仅保留前8项");
        }
        let mut clean = vec![];
        let mut seen = HashSet::new();
        for raw in values.iter().take(MAX_CHANGES) {
            let value = if key == "knowledge" {
                normal_knowledge(raw)
            } else {
                normal_thread(raw)
            };
            if let Some(value) = value {
                if seen.insert(value["id"].as_str().unwrap().to_owned()) {
                    clean.push(value);
                } else {
                    issue(issues, "同一回合的知情或线索编号重复，已忽略重复项");
                }
            } else {
                issue(issues, "知情或线索的字段/出处不完整，已忽略无效项");
            }
        }
        if !clean.is_empty() {
            out.insert(key.into(), Value::Array(clean));
        }
    }
    Value::Object(out)
}

#[derive(Clone)]
struct PathNode {
    id: String,
    parent: Option<String>,
    changes: Value,
}
fn path(db: &Connection, world: &str, head: &str) -> Result<Vec<PathNode>> {
    let mut statement = db.prepare("WITH RECURSIVE up(id,parent_id,changes) AS (
        SELECT id,parent_id,json_extract(record_json,'$.continuity') FROM nodes WHERE id=? AND world_id=?
        UNION SELECT n.id,n.parent_id,json_extract(n.record_json,'$.continuity') FROM nodes n JOIN up ON n.id=up.parent_id WHERE n.world_id=?
      ) SELECT id,parent_id,changes FROM up")?;
    let rows = statement.query_map(params![head, world, world], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut nodes = HashMap::new();
    for row in rows {
        let (id, parent, raw) = row?;
        let changes = raw
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or(Value::Null);
        nodes.insert(
            id.clone(),
            PathNode {
                id,
                parent,
                changes,
            },
        );
    }
    let mut result = vec![];
    let mut cursor = Some(head.to_owned());
    let mut seen = HashSet::new();
    while let Some(id) = cursor {
        if !seen.insert(id.clone()) {
            return Err(Error::Invalid(
                "当前路线存在循环，无法读取知情与线索".into(),
            ));
        }
        let node = nodes
            .remove(&id)
            .ok_or_else(|| Error::Invalid("知情与线索定位不属于这个故事的有效路线".into()))?;
        cursor = node.parent.clone();
        result.push(node);
    }
    result.reverse();
    Ok(result)
}
fn quoted(
    db: &Connection,
    world: &str,
    source: &Value,
    allowed: &HashSet<String>,
    current: Option<(&str, &str, &str)>,
) -> Result<bool> {
    let id = source["nodeId"].as_str().unwrap_or("");
    let quote = source["quote"].as_str().unwrap_or("");
    if quote.trim().is_empty() {
        return Ok(false);
    }
    let from = source["from"].as_str().unwrap_or("");
    if let Some((node, narrative, action)) = current {
        if id == node {
            return Ok(if from == "narrative" {
                narrative.contains(quote)
            } else {
                action.contains(quote)
            });
        }
    }
    if !allowed.contains(id) {
        return Ok(false);
    }
    let row: Option<(String, Option<String>, Option<String>)> = db
        .query_row(
            "SELECT narrative,action_text,director_note FROM nodes WHERE id=? AND world_id=?",
            params![id, world],
            |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
        )
        .optional()?;
    Ok(row.is_some_and(|(narrative, action, director)| {
        if from == "narrative" {
            narrative.contains(quote)
        } else {
            format!(
                "{}\n{}",
                action.unwrap_or_default(),
                director.unwrap_or_default()
            )
            .contains(quote)
        }
    }))
}
fn actor(state: &Value, query: &str) -> Option<(String, String)> {
    let hero = &state["protagonist"];
    let matches = |value: &Value| {
        value["id"] == query
            || value["name"] == query
            || value["aliases"]
                .as_array()
                .into_iter()
                .flatten()
                .any(|name| name == query)
    };
    let mut candidates = vec![];
    if ["主角", "protagonist"].contains(&query) || matches(hero) {
        if let Some(name) = hero["name"].as_str().filter(|s| !s.trim().is_empty()) {
            candidates.push(("protagonist".into(), name.into()));
        }
    }
    for person in state["people"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|person| matches(person))
    {
        if let (Some(id), Some(name)) = (person["id"].as_str(), person["name"].as_str()) {
            if !id.is_empty() && !name.is_empty() {
                candidates.push((id.into(), name.into()));
            }
        }
    }
    (candidates.len() == 1).then(|| candidates.remove(0))
}
fn actor_state(db: &Connection, node: &str) -> Result<Value> {
    let hero:Option<(Option<String>,Option<String>)>=db.query_row("SELECT json_extract(state_json,'$.protagonist.name'),json_extract(state_json,'$.protagonist.aliases') FROM states WHERE node_id=?",[node],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    let Some((name, aliases)) = hero else {
        return Ok(json!({}));
    };
    let mut stmt=db.prepare("SELECT json_extract(p.value,'$.id'),json_extract(p.value,'$.name'),json_extract(p.value,'$.aliases') FROM states s,json_each(s.state_json,'$.people') p WHERE s.node_id=?")?;
    let rows = stmt.query_map([node], |r| {
        Ok((
            r.get::<_, Option<String>>(0)?,
            r.get::<_, Option<String>>(1)?,
            r.get::<_, Option<String>>(2)?,
        ))
    })?;
    let mut people = vec![];
    for row in rows {
        let (id, name, aliases) = row?;
        people.push(json!({"id":id,"name":name,"aliases":aliases.and_then(|s|serde_json::from_str::<Value>(&s).ok()).unwrap_or(json!([]))}));
    }
    Ok(
        json!({"protagonist":{"name":name,"aliases":aliases.and_then(|s|serde_json::from_str::<Value>(&s).ok()).unwrap_or(json!([]))},"people":people}),
    )
}
fn validate_item(
    db: &Connection,
    world: &str,
    node: &str,
    item: &Value,
    kind: &str,
    allowed: &HashSet<String>,
    current: Option<(&str, &str, &str)>,
    state: &Value,
    prior: Option<&Value>,
) -> Result<Value> {
    let mut out = item.clone();
    if out["source"].get("nodeId").is_none() {
        out["source"]["nodeId"] = node.into();
    }
    if !quoted(db, world, &out["source"], allowed, current)? {
        return Err(Error::Invalid(
            "知情或线索的引文不存在于当前路线的指定正文/玩家行动中".into(),
        ));
    }
    if kind == "knowledge" {
        let query = out["person"].as_str().unwrap_or("");
        let (person, name) = actor(state, query).ok_or_else(|| {
            Error::Invalid("知情记录的人物不存在或名字不唯一，请使用本局真实人物定位".into())
        })?;
        if prior.is_some_and(|value| value["person"] != person) {
            return Err(Error::Invalid(
                "知情记录的同一编号不能改指另一个人物，请另建记录".into(),
            ));
        }
        out["person"] = person.into();
        out["personName"] = name.into();
    }
    Ok(out)
}

/// Project only the selected head's ancestry. Each later correction is an
/// immutable event; undo or a different branch automatically exposes the
/// appropriate prior version instead of mutating a shared ancestor.
pub(crate) fn project(db: &Connection, world: &str, head: &str) -> Result<Value> {
    let nodes = path(db, world, head)?;
    let mut allowed = HashSet::new();
    let mut knowledge = Map::new();
    let mut threads = Map::new();
    let mut ignored = 0usize;
    for node in nodes {
        let mut issues = vec![];
        let changes = normalize(&node.changes, &mut issues);
        ignored += issues.len();
        let state = if changes["knowledge"].is_array() {
            actor_state(db, &node.id)?
        } else {
            json!({})
        };
        allowed.insert(node.id.clone());
        for kind in ["knowledge", "threads"] {
            let map = if kind == "knowledge" {
                &mut knowledge
            } else {
                &mut threads
            };
            for item in changes[kind].as_array().into_iter().flatten() {
                let id = item["id"].as_str().unwrap();
                match validate_item(
                    db,
                    world,
                    &node.id,
                    item,
                    kind,
                    &allowed,
                    None,
                    &state,
                    map.get(id),
                ) {
                    Ok(mut item) => {
                        let previous = map.get(id);
                        item["originNodeId"] = previous
                            .map(|v| v["originNodeId"].clone())
                            .unwrap_or(json!(node.id));
                        item["historyCount"] = json!(
                            previous
                                .and_then(|v| v["historyCount"].as_u64())
                                .unwrap_or(0)
                                + 1
                        );
                        item["nodeId"] = node.id.clone().into();
                        if kind == "knowledge" && item.get("active").is_none() {
                            item["active"] = true.into();
                        }
                        if kind == "threads" && item.get("recall").is_none() {
                            item["recall"] = true.into();
                        }
                        map.insert(id.into(), item);
                    }
                    Err(_) => ignored += 1,
                }
            }
        }
    }
    Ok(
        json!({"worldId":world,"headId":head,"knowledge":knowledge.into_values().collect::<Vec<_>>(),"threads":threads.into_values().collect::<Vec<_>>(),"ignoredEvents":ignored}),
    )
}

/// Clean a record before its existing transaction adopts it. Strict callers
/// (history drafts/manual edits) get a concrete rejection; ordinary generation
/// drops bad optional annotations and continues saving the valid passage.
pub(crate) fn validate_record(
    db: &Connection,
    world: &str,
    base_head: &str,
    current_node: &str,
    narrative: &str,
    action: &Value,
    state: &Value,
    record: &Value,
    strict: bool,
) -> Result<(Value, Vec<String>)> {
    let mut out = record.clone();
    let Some(raw) = record.get("continuity") else {
        return Ok((out, vec![]));
    };
    let mut issues = vec![];
    let changes = normalize(raw, &mut issues);
    let (mut allowed, prior) = if base_head.is_empty() {
        (HashSet::new(), json!({}))
    } else {
        let checked = (|| {
            Ok::<_, Error>((
                path(db, world, base_head)?
                    .into_iter()
                    .map(|n| n.id)
                    .collect::<HashSet<_>>(),
                project(db, world, base_head)?,
            ))
        })();
        match checked {
            Ok(value) => value,
            Err(error) => {
                if strict {
                    return Err(error);
                }
                if let Some(object) = out.as_object_mut() {
                    object.remove("continuity");
                }
                issue(&mut issues, "历史资料未能校对，本回合附加知情与线索未保存");
                return Ok((out, issues));
            }
        }
    };
    allowed.insert(current_node.into());
    let action = format!(
        "{}\n{}",
        action["text"].as_str().unwrap_or(""),
        action["directorNote"].as_str().unwrap_or("")
    );
    let mut clean = Map::new();
    for kind in ["knowledge", "threads"] {
        let mut events = vec![];
        for item in changes[kind].as_array().into_iter().flatten() {
            let previous = prior[kind]
                .as_array()
                .into_iter()
                .flatten()
                .find(|old| old["id"] == item["id"]);
            match validate_item(
                db,
                world,
                current_node,
                item,
                kind,
                &allowed,
                Some((current_node, narrative, &action)),
                state,
                previous,
            ) {
                Ok(event) => events.push(event),
                Err(error) => issue(&mut issues, &error.to_string()),
            }
        }
        if !events.is_empty() {
            clean.insert(kind.into(), Value::Array(events));
        }
    }
    if strict && !issues.is_empty() {
        return Err(Error::Invalid(issues.join("；")));
    }
    if let Some(object) = out.as_object_mut() {
        if clean.is_empty() {
            object.remove("continuity");
        } else {
            object.insert("continuity".into(), Value::Object(clean));
        }
    }
    Ok((out, issues))
}

/// A bounded recall view; source verification and adoption remain separate.
pub(crate) fn recall(view: &Value, query: &str, cap: usize) -> String {
    let mut rows = vec![];
    for item in view["knowledge"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| {
            v["active"] != false
                && (v["person"] == "protagonist"
                    || v["personName"]
                        .as_str()
                        .is_some_and(|name| !name.is_empty() && query.contains(name)))
        })
    {
        rows.push((
            item,
            format!(
                "人物{}：{}（{}，{}；认知不等于事实）",
                item["personName"].as_str().unwrap_or("人物"),
                item["claim"].as_str().unwrap_or(""),
                item["awareness"].as_str().unwrap_or("uncertain"),
                item["nodeId"].as_str().unwrap_or("")
            ),
        ));
    }
    for item in view["threads"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|v| v["status"] == "open" && v["recall"] != false)
    {
        rows.push((
            item,
            format!(
                "未完事项{}：{}（{}）",
                item["title"].as_str().unwrap_or(""),
                item["detail"].as_str().unwrap_or(""),
                item["nodeId"].as_str().unwrap_or("")
            ),
        ));
    }
    rows.sort_by_key(|(v, _)| {
        ![v["personName"].as_str(), v["title"].as_str()]
            .into_iter()
            .flatten()
            .chain(
                v["entities"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str),
            )
            .any(|s| !s.is_empty() && query.contains(s))
    });
    let mut out = String::new();
    let mut count = 0;
    for (_, line) in rows {
        let line = line.chars().take(350).collect::<String>();
        if out.encode_utf16().count() + line.encode_utf16().count() + 110 > cap {
            continue;
        }
        if out.is_empty() {
            out.push_str(
                "\n【本局关键知情与未完事项（部分，可用read_continuity查原句；不强推后续）】\n",
            );
        }
        out.push_str(&line);
        out.push('\n');
        count += 1;
        if count >= 8 {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;
    fn db() -> Connection {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE nodes(id TEXT PRIMARY KEY,world_id TEXT,parent_id TEXT,narrative TEXT,action_text TEXT,director_note TEXT,record_json TEXT);CREATE TABLE states(node_id TEXT PRIMARY KEY,state_json TEXT);").unwrap();
        db
    }
    fn state() -> Value {
        json!({"protagonist":{"name":"旅人","aliases":[]},"people":[{"id":"a","name":"甲","aliases":["阿甲"]},{"id":"b","name":"乙","aliases":[]}]})
    }
    fn node(db: &Connection, id: &str, parent: Option<&str>, narrative: &str, changes: Value) {
        db.execute(
            "INSERT INTO nodes VALUES(?,'w',?,?,NULL,NULL,?)",
            params![
                id,
                parent,
                narrative,
                json!({"continuity":changes}).to_string()
            ],
        )
        .unwrap();
        db.execute(
            "INSERT INTO states VALUES(?,?)",
            params![id, state().to_string()],
        )
        .unwrap();
    }
    fn knowledge(person: &str, awareness: &str, quote: &str) -> Value {
        json!({"knowledge":[{"id":"secret","person":person,"claim":"信中所言","awareness":awareness,"source":{"from":"narrative","quote":quote}}]})
    }
    #[test]
    fn sparse_projection_stays_small_on_thirty_three_hundred_and_thousand_nodes() {
        for size in [30, 300, 1000] {
            let db = db();
            for index in 0..size {
                let id = format!("n{index}");
                let parent = (index > 0).then(|| format!("n{}", index - 1));
                let narrative = format!("甲听说第{index}条消息。");
                let changes = if index % 30 == 0 {
                    knowledge("a", "rumor", narrative.trim_end_matches('。'))
                } else {
                    json!({})
                };
                node(&db, &id, parent.as_deref(), &narrative, changes);
            }
            let view = project(&db, "w", &format!("n{}", size - 1)).unwrap();
            assert_eq!(view["knowledge"].as_array().unwrap().len(), 1);
            assert_eq!(view["knowledge"][0]["historyCount"], (size - 1) / 30 + 1);
            assert!(recall(&view, "甲", 500).encode_utf16().count() <= 500);
        }
    }
    #[test]
    fn sparse_changes_follow_branch_and_undo_and_preserve_uncertain_belief() {
        let db = db();
        node(
            &db,
            "n0",
            None,
            "甲听说信中之事。",
            knowledge("阿甲", "rumor", "甲听说信中之事"),
        );
        node(
            &db,
            "n1",
            Some("n0"),
            "甲得知那是误传。",
            knowledge("a", "denied", "甲得知那是误传"),
        );
        node(&db, "side", Some("n0"), "乙仍在等候。", json!({}));
        let latest = project(&db, "w", "n1").unwrap();
        assert_eq!(latest["knowledge"][0]["awareness"], "denied");
        assert_eq!(latest["knowledge"][0]["historyCount"], 2);
        assert_eq!(latest["knowledge"][0]["originNodeId"], "n0");
        for head in ["n0", "side"] {
            let old = project(&db, "w", head).unwrap();
            assert_eq!(old["knowledge"][0]["awareness"], "rumor");
            assert_eq!(old["knowledge"][0]["source"]["nodeId"], "n0");
        }
    }
    #[test]
    fn evidence_cannot_come_from_other_route_future_or_nonexistent_people() {
        let db = db();
        node(&db, "n0", None, "开篇。", json!({}));
        node(
            &db,
            "left",
            Some("n0"),
            "甲见到了密信。",
            knowledge("a", "witnessed", "甲见到了密信"),
        );
        let mut bad = knowledge("a", "witnessed", "甲见到了密信");
        bad["knowledge"][0]["source"]["nodeId"] = "left".into();
        let record = json!({"time":10,"continuity":bad});
        assert!(validate_record(
            &db,
            "w",
            "n0",
            "right",
            "乙仍在等候。",
            &json!({}),
            &state(),
            &record,
            true
        )
        .is_err());
        let (clean, issues) = validate_record(
            &db,
            "w",
            "n0",
            "right",
            "乙仍在等候。",
            &json!({}),
            &state(),
            &record,
            false,
        )
        .unwrap();
        assert!(clean.get("continuity").is_none());
        assert_eq!(clean["time"], 10);
        assert!(!issues.is_empty());
        let bad = json!({"continuity":knowledge("未登场的人","told","乙仍在等候")});
        assert!(validate_record(
            &db,
            "w",
            "n0",
            "right",
            "乙仍在等候。",
            &json!({}),
            &state(),
            &bad,
            true
        )
        .is_err());
        assert!(project(&db, "foreign", "left").is_err());
    }
    #[test]
    fn hidden_thread_is_still_open_and_resolving_one_branch_does_not_rewrite_its_origin() {
        let db = db();
        let open = json!({"threads":[{"id":"promise","kind":"promise","title":"交还密信","detail":"尚待交还","status":"open","recall":false,"source":{"from":"narrative","quote":"答应交还密信"}}]});
        node(&db, "n0", None, "旅人答应交还密信。", open);
        let mut resolved = project(&db, "w", "n0").unwrap()["threads"][0].clone();
        resolved["status"] = "resolved".into();
        resolved["source"] = json!({"from":"narrative","quote":"密信已交还"});
        node(
            &db,
            "n1",
            Some("n0"),
            "密信已交还。",
            json!({"threads":[resolved]}),
        );
        assert_eq!(
            project(&db, "w", "n1").unwrap()["threads"][0]["status"],
            "resolved"
        );
        let origin = project(&db, "w", "n0").unwrap();
        assert_eq!(origin["threads"][0]["status"], "open");
        assert_eq!(origin["threads"][0]["recall"], false);
    }
    #[test]
    fn changing_record_identity_is_rejected_while_new_current_people_are_accepted() {
        let db = db();
        node(
            &db,
            "n0",
            None,
            "甲看过密信。",
            knowledge("a", "witnessed", "甲看过密信"),
        );
        let bad = json!({"continuity":knowledge("b","told","乙得知消息")});
        assert!(validate_record(
            &db,
            "w",
            "n0",
            "n1",
            "乙得知消息。",
            &json!({}),
            &state(),
            &bad,
            true
        )
        .is_err());
        let mut current = state();
        current["people"]
            .as_array_mut()
            .unwrap()
            .push(json!({"id":"c","name":"丙","aliases":[]}));
        let mut new = knowledge("丙", "told", "丙得知消息");
        new["knowledge"][0]["id"] = "new".into();
        let (record, _) = validate_record(
            &db,
            "w",
            "n0",
            "n1",
            "丙得知消息。",
            &json!({}),
            &current,
            &json!({"continuity":new}),
            true,
        )
        .unwrap();
        assert_eq!(record["continuity"]["knowledge"][0]["person"], "c");
        assert_eq!(
            record["continuity"]["knowledge"][0]["source"]["nodeId"],
            "n1"
        );
    }
    #[test]
    fn malformed_optional_annotations_do_not_invalidate_normal_story_records() {
        let mut issues = vec![];
        assert_eq!(
            normalize(
                &json!({"knowledge":"bad","threads":[{"id":"missing"}]}),
                &mut issues
            ),
            json!({})
        );
        assert!(!issues.is_empty());
        let parsed = crate::rules::parse_record(
            "{\"time\":5,\"continuity\":{\"knowledge\":\"bad\"},\"choices\":[\"继续\"]}",
        )
        .unwrap();
        assert_eq!(parsed["record"]["time"], 5);
        assert!(parsed["record"].get("continuity").is_none());
        assert!(!parsed["issues"].as_array().unwrap().is_empty());
    }
}
