//! Formal, read-only story views shared by ordinary requests and Pi.
use crate::{agent_workspace as ws, pi_store::arguments_hash, Error, Result, RunPlan};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
fn invalid(s: &str) -> Error {
    Error::Invalid(s.into())
}
fn head<'a>(plan: &'a RunPlan) -> &'a str {
    plan.base_id.as_deref().unwrap_or(&plan.head_id)
}
pub(crate) fn read(db: &Connection, plan: &RunPlan, name: &str, args: &Value) -> Result<Value> {
    let mut paging = args.clone();
    if paging.get("pageSize").is_none() {
        paging["pageSize"] = 10.into();
    }
    if paging.get("charBudget").is_none() {
        paging["charBudget"] = 6000.into();
    }
    let args = &paging;
    let head = head(plan);
    let belongs = db
        .query_row(
            "SELECT 1 FROM nodes WHERE id=? AND world_id=?",
            params![head, plan.world_id],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if !belongs && !(plan.kind == "opening" && plan.new_world.is_some()) {
        return Err(invalid("资料定位不属于本次故事路线"));
    }
    if name == "read_continuity" {
        let mut scoped = args.clone();
        for field in ["query", "includeInactive"] {
            if let Some(value) = args["ref"].get(field) {
                scoped[field] = value.clone();
            }
        }
        let args = &scoped;
        let mut value = if belongs {
            crate::continuity::project(db, &plan.world_id, head)?
        } else {
            json!({"knowledge":[],"threads":[]})
        };
        let query = args["query"].as_str().unwrap_or("");
        for kind in ["knowledge", "threads"] {
            let rows = value[kind].as_array().cloned().unwrap_or_default();
            value[kind] = rows
                .into_iter()
                .filter(|item| query.is_empty() || item.to_string().contains(query))
                .filter(|item| {
                    args["includeInactive"] == true
                        || if kind == "knowledge" {
                            item["active"] != false
                        } else {
                            item["status"] == "open"
                        }
                })
                .collect::<Vec<_>>()
                .into();
        }
        let kind = args["ref"]["kind"]
            .as_str()
            .or_else(|| args["kind"].as_str())
            .unwrap_or("threads");
        if !["knowledge", "threads"].contains(&kind) {
            return Err(invalid("请选择knowledge或threads"));
        }
        let selected = value[kind].as_array().cloned().unwrap_or_default();
        let revision = arguments_hash(&json!({"headId":head,"kind":kind,"values":selected}));
        let make = |index: usize, field: Option<&str>| {
            let mut r = json!({"worldId":plan.world_id,"lineId":plan.line_id,"headId":head,"kind":kind,"index":index,"revision":revision,"query":query,"includeInactive":args["includeInactive"]==true});
            if let Some(field) = field {
                r["field"] = field.into();
            }
            r
        };
        if args["ref"].is_object() {
            let r = &args["ref"];
            if r["worldId"] != plan.world_id
                || r["lineId"] != plan.line_id
                || r["headId"] != head
                || r["revision"] != revision
            {
                return Err(invalid("知情或线索定位已过期，请重新查询"));
            }
            let index = r["index"]
                .as_u64()
                .ok_or_else(|| invalid("记录定位缺少序号"))? as usize;
            let item = selected
                .get(index)
                .ok_or_else(|| invalid("该记录已不在本次读取范围"))?;
            if let Some(field) = r["field"].as_str() {
                let string = (if field == "source.quote" {
                    Some(&item["source"]["quote"])
                } else {
                    item.get(field)
                })
                .filter(|v| v.is_string())
                .ok_or_else(|| invalid("记录没有这个文字字段"))?;
                let mut page = ws::page(string.clone(), args);
                page["ref"] = r.clone();
                return Ok(page);
            }
            let mut fields = json!({});
            for (key, v) in item.as_object().into_iter().flatten() {
                if let Some(s) = v.as_str() {
                    fields[key] = json!({"preview":s.chars().take(100).collect::<String>(),"ref":make(index,Some(key))});
                } else if key == "source" {
                    fields[key] = json!({"nodeId":v["nodeId"],"from":v["from"],"quoteRef":make(index,Some("source.quote"))});
                } else {
                    fields[key] = v.clone();
                }
            }
            return Ok(json!({"fields":fields,"ref":r}));
        }
        let rows = selected
            .iter()
            .enumerate()
            .map(|(index, item)| {
                let mut item = item.clone();
                item["ref"] = make(index, None);
                item
            })
            .collect::<Vec<_>>();
        let mut page = ws::page(json!(rows), args);
        for item in page["oversized"].as_array_mut().into_iter().flatten() {
            if let Some(index) = item["index"].as_u64() {
                item["ref"] = make(index as usize, None);
            }
        }
        page["kind"] = kind.into();
        page["ignoredEvents"] = value["ignoredEvents"].clone();
        page["headId"] = head.into();
        page["note"] = "人物认知不等于世界真相；未记录不代表不知道。".into();
        return Ok(page);
    }
    let reference = &args["ref"];
    let kind = reference["kind"]
        .as_str()
        .or_else(|| args["kind"].as_str())
        .unwrap_or("cards");
    if !["places", "cards", "goals", "items", "people"].contains(&kind) {
        return Err(invalid("普通资料仅支持地点、设定、目标、人物和当前物品"));
    }
    let state = if belongs {
        ws::resource(db, plan, "state", head)?
    } else {
        plan.state.clone()
    };
    let values = if kind == "items" {
        state["protagonist"]["items"].clone()
    } else {
        state[kind].clone()
    };
    let revision = arguments_hash(&values);
    let make_ref = |index: usize, field: Option<&str>| {
        let mut r = json!({"worldId":plan.world_id,"lineId":plan.line_id,"headId":head,"kind":kind,"index":index,"revision":revision});
        if let Some(field) = field {
            r["field"] = field.into();
        }
        r
    };
    if reference.is_object() {
        if reference["worldId"] != plan.world_id
            || reference["lineId"] != plan.line_id
            || reference["headId"] != head
            || reference["revision"] != revision
        {
            return Err(invalid("资料定位已过期或属于其他故事，请重新查询目录"));
        }
        let index = reference["index"]
            .as_u64()
            .ok_or_else(|| invalid("资料定位缺少条目序号"))? as usize;
        let item = values
            .as_array()
            .and_then(|a| a.get(index))
            .ok_or_else(|| invalid("资料条目已不存在，请重新查询"))?;
        if let Some(field) = reference["field"].as_str() {
            let value = item
                .get(field)
                .or_else(|| item.pointer(&format!("/{field}")))
                .ok_or_else(|| invalid("资料字段已不存在"))?;
            let mut page = ws::page(value.clone(), args);
            for descriptor in page["oversized"].as_array_mut().into_iter().flatten() {
                for path in descriptor["paths"].as_array_mut().into_iter().flatten() {
                    if let Some(suffix) = path["path"].as_str() {
                        path["ref"] = make_ref(index, Some(&format!("{field}{suffix}")));
                    }
                }
            }
            for path in page["paths"].as_array_mut().into_iter().flatten() {
                if let Some(suffix) = path["path"].as_str() {
                    path["ref"] = make_ref(index, Some(&format!("{field}{suffix}")));
                }
            }
            page["ref"] = reference.clone();
            return Ok(page);
        }
        let mut row = json!({"ref":reference,"fields":{}});
        for (key, value) in item.as_object().into_iter().flatten() {
            if let Some(s) = value.as_str() {
                row["fields"][key] = json!({"preview":s.chars().take(120).collect::<String>(),"ref":make_ref(index,Some(key)),"complete":s.chars().count()<=120});
            } else if value.is_array() || value.is_object() {
                row["fields"][key] =
                    json!({"count":value.as_array().map(Vec::len),"ref":make_ref(index,Some(key))});
            } else {
                row["fields"][key] = value.clone();
            }
        }
        return Ok(row);
    }
    let query = args["query"].as_str().unwrap_or("");
    let rows=values.as_array().into_iter().flatten().enumerate().filter(|(_,item)|query.is_empty()||item.to_string().contains(query)).map(|(index,item)|json!({"name":item["name"],"id":item["id"],"kind":item["kind"],"status":item["status"],"ref":make_ref(index,None)})).collect::<Vec<_>>();
    let mut page = ws::page(json!(rows), args);
    for item in page["oversized"].as_array_mut().into_iter().flatten() {
        if let Some(index) = item["index"].as_u64() {
            let filtered_index = index as usize;
            let index = values
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
                .filter(|(_, item)| query.is_empty() || item.to_string().contains(query))
                .nth(filtered_index)
                .map(|(i, _)| i)
                .unwrap_or(filtered_index);
            item["ref"] = make_ref(index, None);
        }
    }
    page["kind"] = kind.into();
    page["headId"] = head.into();
    page["note"] =
        "这是本局正式资料的只读定位；回传ref读取字段，不能作为修改或书籍访问授权。".into();
    Ok(page)
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Connection, RunPlan) {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE nodes(id TEXT PRIMARY KEY,world_id TEXT,parent_id TEXT,narrative TEXT,action_text TEXT,director_note TEXT,record_json TEXT);CREATE TABLE states(node_id TEXT PRIMARY KEY,state_json TEXT);").unwrap();
        let state = json!({"protagonist":{"name":"旅人","aliases":[],"items":[]},"people":[],"places":[],"goals":[],"cards":[{"id":"card-a","name":"长设定","kind":"设定","content":"月下的青铜钥匙。".repeat(200)}]});
        db.execute(
            "INSERT INTO nodes VALUES('n','w',NULL,'开篇。',NULL,NULL,'{}')",
            [],
        )
        .unwrap();
        db.execute("INSERT INTO states VALUES('n',?)", [state.to_string()])
            .unwrap();
        let plan=serde_json::from_value(json!({"id":"read-test","worldId":"w","lineId":"l","headId":"n","baseId":"n","kind":"turn","model":{"slot":"unused","url":"https://test.invalid/v1","model":"mock","auxModel":null,"includeUsage":false,"maxTokens":null},"messages":[],"extractMessages":[],"state":state,"settings":{},"options":{},"action":{},"meta":{},"reference":null,"original":"","carriedEdits":[],"trailingIds":[],"newWorld":null})).unwrap();
        (db, plan)
    }
    #[test]
    fn formal_resource_read_ref_cannot_access_other_world_or_books_or_changed_version() {
        let (db, plan) = fixture();
        let list = read(
            &db,
            &plan,
            "read_story_resources",
            &json!({"kind":"cards","pageSize":1,"charBudget":6000}),
        )
        .unwrap();
        let mut reference = list["value"][0]["ref"].clone();
        assert!(reference.is_object());
        let detail = read(
            &db,
            &plan,
            "read_story_resources",
            &json!({"ref":reference}),
        )
        .unwrap();
        assert!(detail["fields"]["content"]["ref"].is_object());
        reference["worldId"] = "foreign".into();
        assert!(read(
            &db,
            &plan,
            "read_story_resources",
            &json!({"ref":reference})
        )
        .is_err());
        assert!(read(&db, &plan, "read_story_resources", &json!({"kind":"book"})).is_err());
        let reference = list["value"][0]["ref"].clone();
        db.execute("UPDATE states SET state_json=json_set(state_json,'$.cards[0].content','已修改') WHERE node_id='n'",[]).unwrap();
        assert!(read(
            &db,
            &plan,
            "read_story_resources",
            &json!({"ref":reference})
        )
        .is_err());
    }
    #[test]
    fn oversized_directory_and_text_have_real_read_refs_and_advancing_cursor() {
        let (db, plan) = fixture();
        let list = read(
            &db,
            &plan,
            "read_story_resources",
            &json!({"kind":"cards","pageSize":1,"charBudget":128}),
        )
        .unwrap();
        let reference = list["oversized"][0]["ref"].clone();
        assert!(reference.is_object());
        let detail = read(
            &db,
            &plan,
            "read_story_resources",
            &json!({"ref":reference}),
        )
        .unwrap();
        let field = detail["fields"]["content"]["ref"].clone();
        let mut args = json!({"ref":field,"charBudget":128});
        let mut text = String::new();
        let mut previous = Value::Null;
        loop {
            let page = read(&db, &plan, "read_story_resources", &args).unwrap();
            text += page["text"].as_str().unwrap();
            if page["complete"] == true {
                break;
            }
            assert_ne!(page["nextCursor"], previous);
            previous = page["nextCursor"].clone();
            args["nextCursor"] = previous.clone();
        }
        assert_eq!(text, "月下的青铜钥匙。".repeat(200));
        assert!(
            crate::tools::validate("read_story_resources", &json!({"worldId":"foreign"})).is_err()
        );
    }
    #[test]
    fn continuity_filter_ref_preserves_scope_and_can_read_its_exact_quote() {
        let (db, plan) = fixture();
        let quote = "开篇。";
        let record = json!({"continuity":{"threads":[
            {"id":"closed","kind":"clue","title":"另一件事","detail":"已经结束","status":"resolved","source":{"from":"narrative","quote":quote}},
            {"id":"letter","kind":"promise","title":"密信","detail":"密信需交还。".repeat(100),"status":"open","source":{"from":"narrative","quote":quote}}
        ]}});
        db.execute(
            "UPDATE nodes SET record_json=? WHERE id='n'",
            [record.to_string()],
        )
        .unwrap();
        let list = read(
            &db,
            &plan,
            "read_continuity",
            &json!({"kind":"threads","query":"密信","charBudget":128}),
        )
        .unwrap();
        let reference = list["oversized"][0]["ref"].clone();
        assert_eq!(reference["query"], "密信");
        let detail = read(&db, &plan, "read_continuity", &json!({"ref":reference})).unwrap();
        let quote_ref = detail["fields"]["source"]["quoteRef"].clone();
        let page = read(&db, &plan, "read_continuity", &json!({"ref":quote_ref})).unwrap();
        assert_eq!(page["text"], quote);
        let mut wrong = reference.clone();
        wrong["lineId"] = "other-line".into();
        assert!(read(&db, &plan, "read_continuity", &json!({"ref":wrong})).is_err());
        db.execute("UPDATE nodes SET record_json='{}' WHERE id='n'", [])
            .unwrap();
        assert!(read(&db, &plan, "read_continuity", &json!({"ref":reference})).is_err());
    }
}
