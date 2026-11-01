//! Bounded book navigation and per-claim candidate preparation. These locate
//! evidence; only read_original delivers the original-reading contract.
use crate::{Error, Result, RunPlan};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

pub fn read(db: &Connection, plan: &RunPlan, name: &str, args: &Value) -> Result<Value> {
    let binding = &plan.state["source"];
    let Some(book) = binding["bookId"].as_str() else {
        return Ok(json!({"status":"insufficient","reason":"未绑定参考书籍","items":[]}));
    };
    if args["bookId"].as_str().is_some_and(|id| id != book) {
        return Err(Error::Invalid("资料不属于本局绑定书籍".into()));
    }
    let query_only = db.query_row("PRAGMA query_only", [], |r| r.get::<_, bool>(0))?;
    let has_cache=!query_only && db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='reference_lookup_cache'",[],|r|r.get::<_,i64>(0))?>0;
    let revision = if db.query_row("SELECT count(*) FROM sqlite_master WHERE type='table' AND name='reference_index_versions'",[],|r|r.get::<_,i64>(0))?>0 {
        db.query_row(
            "SELECT revision FROM reference_index_versions WHERE book_id=?",
            [book],
            |r| r.get::<_, i64>(0),
        )
        .optional()?
        .unwrap_or(1)
    } else {
        1
    };
    let scope = json!({"binding":binding,"revision":revision,"head":plan.head_id,"budget":plan.meta["budgetChars"],"entities":plan.state["people"].as_array().into_iter().flatten().map(|p|json!([p["name"],p["aliases"]])).collect::<Vec<_>>()});
    let cache_key = format!(
        "{:x}",
        Sha256::digest(json!([name, args, scope]).to_string().as_bytes())
    );
    if has_cache {
        if let Some(value) = db
            .query_row(
                "SELECT result_json FROM reference_lookup_cache WHERE cache_key=?",
                [&cache_key],
                |r| r.get::<_, String>(0),
            )
            .optional()?
        {
            let mut result: Value = serde_json::from_str(&value)?;
            result["cached"] = true.into();
            return Ok(result);
        }
    }
    if args["queries"]
        .as_array()
        .or_else(|| args["claims"].as_array())
        .is_some_and(|a| a.len() > 8)
    {
        return Err(Error::Invalid("每批最多8项，请拆分后继续".into()));
    }
    if args["queries"].as_array().or_else(|| args["claims"].as_array()).is_some_and(|a|a.iter().any(|q|q.as_str().or_else(||q["claim"].as_str()).is_none_or(|s|s.trim().is_empty()))) { return Err(Error::Invalid("每项检索线索应为非空文字".into())); }
    let mut queries: Vec<String> = args["queries"]
        .as_array()
        .or_else(|| args["claims"].as_array())
        .into_iter()
        .flatten()
        .filter_map(|q| q.as_str().or_else(|| q["claim"].as_str()))
        .take(8)
        .map(str::to_owned)
        .collect();
    if queries.is_empty() {
        if let Some(query) = args["query"].as_str().filter(|s| !s.trim().is_empty()) {
            queries.push(query.to_owned());
        }
    }
    if queries.is_empty() {
        return Err(Error::Invalid(
            "请提供事件线索query，或最多8项queries/claims".into(),
        ));
    }
    if queries.iter().any(|s| s.chars().count() > 4000) {
        return Err(Error::Invalid(
            "单项查证线索不能超过4000字符，请分项检索".into(),
        ));
    }
    let mut items = vec![];
    let mut global_budget =
        (plan.meta["budgetChars"].as_u64().unwrap_or(12000) / 4).clamp(800, 12000) as usize;
    for query in queries {
        let found =
            crate::runtime_sources::read_db(db, plan, "search_original", &json!({"query":query}))?;
        let mut candidates = vec![];
        for p in found["excerpts"].as_array().into_iter().flatten().take(4) {
            let snippet = p["text"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(180)
                .collect::<String>();
            let item = json!({"ref":{"bookId":book,"bookVersion":format!("{book}:{revision}"),"section":p["section"],"chunk":p["chunk"],"start":p["start"],"end":p["end"]},"title":p["title"],"page":p["page"],"snippet":snippet});
            let cost = item.to_string().encode_utf16().count();
            if cost > global_budget {
                break;
            }
            global_budget -= cost;
            candidates.push(item);
        }
        items.push(json!({"claim":query,"status":if candidates.is_empty(){"insufficient"}else{"candidates"},"candidates":candidates,"verified":false}));
    }
    let result = json!({"bookId":book,"bookVersion":format!("{book}:{revision}"),"through":binding["through"],"items":items,"anchorKind":"candidate","verified":false,"cached":false,"note":"候选定位不是已经核实的事实；用read_original直接回传ref读原文与邻段，再判断相应时点、人物知情和玩家分支。不会改写玩家设置的原著位置。"});
    if has_cache {
        db.execute("INSERT OR REPLACE INTO reference_lookup_cache(cache_key,book_id,revision,scope_json,result_json,created_at) VALUES(?,?,?,?,?,?)",params![cache_key,book,revision,scope.to_string(),result.to_string(),chrono::Utc::now().to_rfc3339()])?;
        db.execute("DELETE FROM reference_lookup_cache WHERE book_id=? AND cache_key NOT IN (SELECT cache_key FROM reference_lookup_cache WHERE book_id=? ORDER BY created_at DESC LIMIT 32)",params![book,book])?;
    }
    Ok(result)
}

pub fn preview_record(plan: &RunPlan, args: &Value) -> Result<Value> {
    let result = crate::rules::apply_record(&plan.state, &args["record"], &plan.options)
        .map_err(Error::Invalid)?;
    Ok(
        json!({"preview":true,"committed":false,"before":{"time":plan.state["time"],"stats":plan.state["protagonist"]["stats"],"items":plan.state["protagonist"]["items"]},"after":{"time":result["state"]["time"],"stats":result["state"]["protagonist"]["stats"],"items":result["state"]["protagonist"]["items"]},"notes":result["notes"],"log":result["log"]}),
    )
}
