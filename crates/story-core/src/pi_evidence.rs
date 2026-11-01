//! Candidate evidence from native, bounded tool replies. A candidate is not a
//! delivery acknowledgement: only the model transport may later admit/accept
//! its hash. No model-authored provenance or UI projection is trusted here.
use crate::{agent_workspace as ws, pi_store::PiCallRequest, Error, Result, RunPlan};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const VERSION: u64 = 1;
const MAX_SEGMENTS: usize = 512;
const MAX_DELIVERY_BYTES: usize = 131072;
const MAX_STRING_LEAVES: usize = 4096;

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn pointer(path: &str, key: &str) -> String {
    format!("{path}/{}", key.replace('~', "~0").replace('/', "~1"))
}
fn strings(value: &Value, path: &str, out: &mut Vec<(String, String)>) {
    match value {
        Value::String(text) => out.push((path.into(), text.clone())),
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                strings(item, &pointer(path, &index.to_string()), out);
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                strings(item, &pointer(path, key), out);
            }
        }
        _ => {}
    }
}

/// Hash precisely the model-visible JSON's string leaves, sorted by escaped
/// JSON Pointer in UTF-8 byte order. Numeric/boolean/null leaves are omitted;
/// this avoids JavaScript's 1.0/1 serialization difference. The host must hash
/// the parsed JSON text content, not Pi's UI-only `details` field.
pub(crate) fn delivery_hash(delivered: &Value) -> String {
    let mut leaves = vec![];
    strings(delivered, "", &mut leaves);
    leaves.sort_unstable_by(|a, b| a.0.as_bytes().cmp(b.0.as_bytes()));
    format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(&leaves).expect("string leaves serialize"))
    )
}
fn check_delivery(value: &Value) -> Result<()> {
    fn walk(value: &Value, depth: usize, leaves: &mut usize, bytes: &mut usize) -> bool {
        if depth > 32 {
            return false;
        }
        match value {
            Value::String(text) => {
                *leaves += 1;
                *bytes = bytes.saturating_add(text.len());
                *leaves <= MAX_STRING_LEAVES && *bytes <= MAX_DELIVERY_BYTES
            }
            Value::Array(items) => items
                .iter()
                .all(|item| walk(item, depth + 1, leaves, bytes)),
            Value::Object(items) => items
                .values()
                .all(|item| walk(item, depth + 1, leaves, bytes)),
            _ => true,
        }
    }
    // Match the trusted host's manifest guard: UTF-8 bytes of string values,
    // excluding numeric leaves, object keys and JSON serialization overhead.
    if !walk(value, 0, &mut 0, &mut 0) {
        return Err(invalid("工具证据候选超过有界正文大小或层级"));
    }
    Ok(())
}

#[derive(Clone)]
struct Segment {
    output: String,
    root: String,
    start: usize,
    end: usize,
}
impl Segment {
    fn value(&self) -> Value {
        json!({"outputPath":self.output,"rootPath":self.root,"charStart":self.start,"charEnd":self.end})
    }
}
fn char_slice(text: &str, start: usize, end: usize) -> String {
    text.chars()
        .skip(start)
        .take(end.saturating_sub(start))
        .collect()
}
fn descendants(path: &str, parent: &str) -> bool {
    path == parent
        || path
            .strip_prefix(parent)
            .is_some_and(|suffix| suffix.starts_with('/'))
}
fn body_leaves(value: &Value, path: &str, out: &mut Vec<(String, String)>) {
    // A large-item descriptor is a locator, even if it contains a helpful
    // message or textPath. Do not promote that prose into story evidence.
    if value.get("largeItemPath").is_some() {
        return;
    }
    match value {
        Value::String(text) => {
            if !text.trim().is_empty() {
                out.push((path.into(), text.clone()));
            }
        }
        Value::Array(items) => {
            for (index, item) in items.iter().enumerate() {
                body_leaves(item, &pointer(path, &index.to_string()), out);
            }
        }
        Value::Object(items) => {
            for (key, item) in items {
                body_leaves(item, &pointer(path, key), out);
            }
        }
        _ => {}
    }
}
fn root_segments(tool: &str, data: &Value) -> Vec<Segment> {
    let mut leaves = vec![];
    match tool {
        "read_original" | "search_original" => {
            for (index, item) in data["excerpts"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                if let Some(text) = item["text"].as_str().filter(|text| !text.trim().is_empty()) {
                    leaves.push((format!("/excerpts/{index}/text"), text.into()));
                }
            }
        }
        "read_resource" | "read_provided_draft" => {
            if let Some(text) = data["text"].as_str().filter(|text| !text.trim().is_empty()) {
                leaves.push(("/text".into(), text.into()));
            }
            if let Some(value) = data.get("value") {
                body_leaves(value, "/value", &mut leaves);
            }
        }
        "read_webpage"|"read_document"|"find_document"|"browser_open"|"browser_read"|"browser_find"|"browser_follow" => {
            if let Some(text)=data["text"].as_str().filter(|s|!s.trim().is_empty()){leaves.push(("/text".into(),text.into()));}
            for (index,hit) in data["hits"].as_array().into_iter().flatten().enumerate(){if let Some(text)=hit["text"].as_str(){leaves.push((format!("/hits/{index}/text"),text.into()));}}
        }
        "read_player_choices" => {
            for (index, item) in data["references"]
                .as_array()
                .into_iter()
                .flatten()
                .enumerate()
            {
                if let Some(text) = item["text"].as_str().filter(|text| !text.trim().is_empty()) {
                    leaves.push((format!("/references/{index}/text"), text.into()));
                }
            }
        }
        // read_world is currently a locator directory. canon facts and skill
        // resources are auxiliary material, never original-text pages.
        _ => {}
    }
    leaves
        .into_iter()
        .take(MAX_SEGMENTS)
        .map(|(path, text)| Segment {
            output: path.clone(),
            root: path,
            start: 0,
            end: text.chars().count(),
        })
        .collect()
}
fn segments(source: &Value) -> Result<Vec<Segment>> {
    let items = source["segments"]
        .as_array()
        .ok_or_else(|| invalid("回读来源缺少原生字段映射"))?;
    if items.len() > MAX_SEGMENTS {
        return Err(invalid("回读来源字段过多"));
    }
    items
        .iter()
        .map(|item| {
            let output = item["outputPath"]
                .as_str()
                .filter(|p| p.starts_with('/'))
                .ok_or_else(|| invalid("回读来源字段路径无效"))?;
            let root = item["rootPath"]
                .as_str()
                .filter(|p| p.starts_with('/'))
                .ok_or_else(|| invalid("回读根字段路径无效"))?;
            let start = item["charStart"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .ok_or_else(|| invalid("回读来源起点无效"))?;
            let end = item["charEnd"]
                .as_u64()
                .and_then(|n| usize::try_from(n).ok())
                .filter(|end| *end >= start)
                .ok_or_else(|| invalid("回读来源终点无效"))?;
            Ok(Segment {
                output: output.into(),
                root: root.into(),
                start,
                end,
            })
        })
        .collect()
}
fn saved_call(
    db: &Connection,
    request: &PiCallRequest,
    call: &str,
) -> Result<Option<(String, Value, String)>> {
    let task = &request.task_id;
    let row:Option<(String,String,String,i64)>=db.query_row("SELECT tool,output_json,world_version,intent_revision FROM pi_calls WHERE task_id=? AND call_id=? AND status='done'",params![task,call],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?))).optional()?;
    let Some((tool, raw, version, revision)) = row else {
        return Ok(None);
    };
    if version != request.world_version || revision < 0 || revision > request.intent_revision {
        return Err(Error::Stale);
    }
    let output: Value = serde_json::from_str(&raw)?;
    if output["ok"] != true {
        return Ok(None);
    }
    let actor: Option<String> = db
        .query_row(
            "SELECT child_id FROM pi_child_calls WHERE task_id=? AND call_id=?",
            params![task, call],
            |r| r.get(0),
        )
        .optional()?;
    Ok(Some((
        tool,
        output["data"].clone(),
        actor.unwrap_or_default(),
    )))
}
fn reproject(input: &Value, input_segments: &[Segment], args: &Value) -> Vec<Segment> {
    let path = ws::text(args, "path");
    let Some(selected) = (if path.is_empty() {
        Some(input)
    } else {
        input.pointer(path)
    }) else {
        return vec![];
    };
    let page = ws::page(selected.clone(), args);
    // The page owns the resolved cursor offset; args.offset is only the
    // legacy input and stays zero on every modern continuation.
    let offset = page["offset"].as_u64().unwrap_or(0) as usize;
    let mut result = vec![];
    if let Some(text) = page["text"].as_str() {
        if let Some(segment) = input_segments.iter().find(|segment| segment.output == path) {
            let start = segment.start.saturating_add(offset);
            let end = start.saturating_add(text.chars().count());
            if end <= segment.end {
                result.push(Segment {
                    output: "/text".into(),
                    root: segment.root.clone(),
                    start,
                    end,
                });
            }
        }
    } else if page.get("value").is_some() && page["largeItem"] != true {
        for segment in input_segments
            .iter()
            .filter(|segment| descendants(&segment.output, path))
        {
            let suffix = &segment.output[path.len()..];
            let output = if selected.is_array() {
                let Some(suffix) = suffix.strip_prefix('/') else {
                    continue;
                };
                let (index, rest) = suffix.split_once('/').unwrap_or((suffix, ""));
                let Some(index) = index.parse::<usize>().ok().filter(|n| *n >= offset) else {
                    continue;
                };
                format!(
                    "/value/{}{}",
                    index - offset,
                    if rest.is_empty() {
                        String::new()
                    } else {
                        format!("/{rest}")
                    }
                )
            } else {
                format!("/value{suffix}")
            };
            if page.pointer(&output).is_some_and(Value::is_string) {
                result.push(Segment {
                    output,
                    root: segment.root.clone(),
                    start: segment.start,
                    end: segment.end,
                });
            }
        }
    }
    result
}
fn scope(plan: &RunPlan) -> Value {
    plan.meta["agent"]["referenceScope"].clone()
}
fn source_kind(
    db: &Connection,
    task: &Value,
    plan: &RunPlan,
    tool: &str,
    args: &Value,
    data: &Value,
) -> Result<&'static str> {
    Ok(match tool {
        "read_original" => "original",
        "read_webpage"|"read_document"|"find_document"|"browser_open"|"browser_read"|"browser_find"|"browser_follow"=>"external",
        "search_original" => "snippet",
        "read_canon_facts" => "auxiliary",
        "read_provided_draft" => "draft",
        "read_resource"
            if !plan.meta["agent"]["readOnlyActor"]
                .as_str()
                .unwrap_or("")
                .is_empty() =>
        {
            "world"
        }
        "read_resource" => {
            let kind = args["kind"]
                .as_str()
                .or(args["ref"]["kind"].as_str())
                .or(data["kind"].as_str())
                .or(data["ref"]["kind"].as_str())
                .unwrap_or("");
            let id = args["id"]
                .as_str()
                .or(args["ref"]["id"].as_str())
                .or(data["id"].as_str())
                .or(data["ref"]["id"].as_str())
                .unwrap_or("");
            let raw: Option<String> = db
                .query_row(
                    "SELECT workspace_json FROM pi_tasks WHERE id=?",
                    [ws::text(task, "id")],
                    |r| r.get(0),
                )
                .optional()?;
            let work = raw
                .map(|raw| ws::parse(&raw))
                .unwrap_or_else(|| task["workspace_json"].clone());
            if work["edits"].as_array().into_iter().flatten().any(|edit| {
                ws::canonical_kind(ws::text(edit, "kind")) == ws::canonical_kind(kind)
                    && ws::text(edit, "id") == id
                    && edit["after"] != edit["original"]
            }) {
                "draft"
            } else {
                "world"
            }
        }
        _ => "world",
    })
}

/// Extract candidates from an already bounded native reply. This default can
/// follow a direct read_original/search_original parent using pi_calls. A
/// nested read_tool_result requires capture_with_source's trusted descriptor.
pub(crate) fn capture(
    db: &Connection,
    task: &Value,
    plan: &RunPlan,
    request: &PiCallRequest,
    delivered: &Value,
    actor: &str,
) -> Result<Option<Value>> {
    capture_with_source(db, task, plan, request, delivered, actor, |_| Ok(None))
}

/// `get_source(call_id)` returns ONLY a source object previously returned by
/// this module and persisted by the native caller. It must never return model
/// parameters. No table for these descriptors is assumed or created here.
pub(crate) fn capture_with_source(
    db: &Connection,
    task: &Value,
    plan: &RunPlan,
    request: &PiCallRequest,
    delivered: &Value,
    actor: &str,
    mut get_source: impl FnMut(&str) -> Result<Option<Value>>,
) -> Result<Option<Value>> {
    if delivered["ok"] != true {
        return Ok(None);
    }
    check_delivery(delivered)?;
    if ![
        "read_webpage","read_document","find_document","browser_open","browser_read","browser_find","browser_follow",
        "read_original",
        "search_original",
        "read_canon_facts",
        "read_resource",
        "read_world",
        "read_player_choices",
        "read_provided_draft",
        "read_tool_result",
    ]
    .contains(&request.tool.as_str())
    {
        return Ok(None);
    }
    if request.task_id != ws::text(task, "id")
        || request.world_version != ws::text(task, "base_world_version")
        || task["intent_revision"].as_i64() != Some(request.intent_revision)
        || task["world_id"] != plan.world_id
        || task["line_id"] != plan.line_id
    {
        return Err(Error::Stale);
    }
    let data = &delivered["data"];
    let mut source = json!({"version":VERSION,"taskId":request.task_id,"callId":request.call_id,"tool":request.tool,"actor":actor,"worldId":plan.world_id,"lineId":plan.line_id,"worldVersion":request.world_version,"intentRevision":request.intent_revision,"referenceScope":scope(plan),"rootCallId":request.call_id,"rootTool":request.tool,"rootActor":actor,"path":request.args["path"].as_str().unwrap_or(""),"offset":request.args["offset"].as_u64().unwrap_or(0)});
    let (root, projected) = if request.tool == "read_tool_result" {
        let prior_id = ws::text(&request.args, "callId");
        let Some((prior_tool, prior_data, prior_actor)) = saved_call(db, request, prior_id)? else {
            return Ok(None);
        };
        let previous = get_source(prior_id)?;
        let (previous, previous_segments) = if let Some(previous) = previous {
            if previous["version"] != VERSION
                || previous["taskId"] != request.task_id
                || previous["callId"] != prior_id
                || previous["tool"] != prior_tool
                || previous["actor"] != prior_actor
                || previous["worldVersion"] != request.world_version
                || !previous["intentRevision"]
                    .as_i64()
                    .is_some_and(|revision| revision >= 0 && revision <= request.intent_revision)
                || previous["referenceScope"] != scope(plan)
            {
                return Err(Error::Stale);
            }
            let mappings = if prior_tool == "read_tool_result" {
                segments(&previous)?
            } else {
                root_segments(&prior_tool, &prior_data)
            };
            (previous, mappings)
        } else if ["read_original", "search_original", "read_canon_facts"]
            .contains(&prior_tool.as_str())
        {
            (
                json!({"rootCallId":prior_id,"rootTool":prior_tool,"rootActor":prior_actor,"sourceKind":if prior_tool=="read_original"{"original"}else if prior_tool=="search_original"{"snippet"}else{"auxiliary"}}),
                root_segments(&prior_tool, &prior_data),
            )
        } else {
            return Ok(None);
        };
        let root_id = ws::text(&previous, "rootCallId");
        let Some((root_tool, root_data, root_actor)) = saved_call(db, request, root_id)? else {
            return Ok(None);
        };
        if previous["rootTool"] != root_tool || previous["rootActor"] != root_actor {
            return Err(invalid("回读根调用与原生来源不一致"));
        }
        for key in [
            "rootCallId",
            "rootTool",
            "rootActor",
            "sourceKind",
            "resourceKind",
            "resourceId",
            "rootResourcePath",
            "rootResourceOffset",
        ] {
            source[key] = previous[key].clone();
        }
        source["sourceCallId"] = prior_id.into();
        (
            root_data,
            reproject(&prior_data, &previous_segments, &request.args),
        )
    } else {
        source["sourceKind"] =
            source_kind(db, task, plan, &request.tool, &request.args, data)?.into();
        source["resourceKind"] = data.get("kind").cloned().unwrap_or_else(|| {
            request
                .args
                .get("kind")
                .cloned()
                .unwrap_or_else(|| request.args["ref"]["kind"].clone())
        });
        source["resourceId"] = data.get("id").cloned().unwrap_or_else(|| {
            request
                .args
                .get("id")
                .cloned()
                .unwrap_or_else(|| request.args["ref"]["id"].clone())
        });
        source["rootResourcePath"] = format!(
            "{}{}",
            request.args["ref"]["path"].as_str().unwrap_or(""),
            request.args["path"].as_str().unwrap_or("")
        )
        .into();
        source["rootResourceOffset"] = request.args["offset"].as_u64().unwrap_or(0).into();
        source["sourceCallId"] = request.call_id.clone().into();
        // A locator-only bounded reply still keeps a root descriptor. Future
        // reads can recover the full native result from pi_calls, not from an
        // invented text field in the descriptor.
        (data.clone(), root_segments(&request.tool, data))
    };
    source["segments"] = json!(projected.iter().map(Segment::value).collect::<Vec<_>>());
    let mut pages = vec![];
    for segment in &projected {
        let Some(text) = data
            .pointer(&segment.output)
            .and_then(Value::as_str)
            .filter(|text| !text.trim().is_empty())
        else {
            continue;
        };
        let Some(root_text) = root.pointer(&segment.root).and_then(Value::as_str) else {
            return Err(invalid("证据根字段不是实际文字"));
        };
        if segment.end > root_text.chars().count()
            || text != char_slice(root_text, segment.start, segment.end)
        {
            return Err(invalid("有界证据文字与原生根结果不一致"));
        }
        let kind = ws::text(&source, "sourceKind");
        if kind == "auxiliary" {
            continue;
        }
        let mut page = json!({"callId":request.call_id,"sourceCallId":source["rootCallId"],"viaCallId":source["sourceCallId"],"sourceTool":source["rootTool"],"sourceKind":kind,"actor":actor,"sourceActor":source["rootActor"],"worldVersion":request.world_version,"intentRevision":request.intent_revision,"referenceScope":scope(plan),"path":source["path"],"sourcePath":segment.root,"deliveredPath":segment.output,"quote":text,"start":segment.start,"end":segment.end,"offsetUnit":"unicode-scalar","sourceLocationVerified":false,"interpretationVerified":false});
        if ["original", "snippet"].contains(&kind) {
            original_location(db, plan, &root, segment, &mut page)?;
        } else {
            page["resourceKind"] = source["resourceKind"].clone();
            page["resourceId"] = source["resourceId"].clone();
            let root_path = segment.root.strip_prefix("/value").unwrap_or("");
            page["resourcePath"] =
                format!("{}{root_path}", ws::text(&source, "rootResourcePath")).into();
            page["resourceOffset"] = source["rootResourceOffset"]
                .as_u64()
                .unwrap_or(0)
                .saturating_add(segment.start as u64)
                .into();
            if source["resourceKind"] == "book" {
                page["requiresOriginalRead"] = true.into();
            }
            if source["rootTool"] == "read_player_choices" {
                page["origin"] = "player_input".into();
                if let Some(reference) = segment
                    .root
                    .strip_suffix("/text")
                    .and_then(|path| root.pointer(path))
                {
                    page["playerReference"] = json!({"id":reference["id"],"nodeId":reference["nodeId"],"seq":reference["seq"],"field":reference["field"]});
                }
            }
        }
        if kind=="external" {
            page["location"]=json!({"path":segment.root,"offset":segment.start,"url":root["url"],"title":root["title"],"section":root["section"],"page":root["page"],"contentHash":root["resourceRef"]["version"],"readAt":root["readAt"]});
            page["sourceLocationVerified"]=true.into();
        }
        pages.push(page);
    }
    Ok(Some(
        json!({"deliveryHash":delivery_hash(delivered),"pages":pages,"source":source,"deliveryStatus":"candidate"}),
    ))
}

fn original_location(
    db: &Connection,
    plan: &RunPlan,
    root: &Value,
    segment: &Segment,
    page: &mut Value,
) -> Result<()> {
    let index = segment
        .root
        .strip_prefix("/excerpts/")
        .and_then(|rest| rest.strip_suffix("/text"))
        .and_then(|index| index.parse::<usize>().ok())
        .ok_or_else(|| invalid("原文证据必须来自实际excerpts文字"))?;
    let excerpt = root["excerpts"]
        .as_array()
        .and_then(|items| items.get(index))
        .ok_or_else(|| invalid("原文片段不存在"))?;
    let book = ws::text(excerpt, "bookId");
    let section = excerpt["section"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| invalid("原文章节无效"))?;
    let chunk = excerpt["chunk"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| invalid("原文文本块无效"))?;
    let through = root["through"]
        .as_i64()
        .filter(|n| *n >= 0)
        .ok_or_else(|| invalid("原文结果缺少允许章节"))?;
    let fence = scope(plan);
    if excerpt["kind"] != "original"
        || book.is_empty()
        || root["bookId"] != book
        || section > through
        || fence["bookId"] == book && fence["through"].as_i64().is_some_and(|n| section > n)
    {
        return Err(invalid("原文片段已超出本次参考范围"));
    }
    let stored:Option<(String,String,Option<i64>)>=db.query_row("SELECT c.text,s.title,s.page FROM source_chunks c JOIN source_sections s ON s.book_id=c.book_id AND s.section=c.section JOIN source_books b ON b.id=c.book_id WHERE c.book_id=? AND c.ordinal=? AND c.section=?",params![book,chunk,section],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?))).optional()?;
    let Some((original, title, paper_page)) = stored else {
        return Err(invalid("原著版本或文本块已经不存在"));
    };
    let start = excerpt["start"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .ok_or_else(|| invalid("原文起点无效"))?;
    let end = excerpt["end"]
        .as_u64()
        .and_then(|n| usize::try_from(n).ok())
        .filter(|n| *n >= start)
        .ok_or_else(|| invalid("原文终点无效"))?;
    let text = ws::text(excerpt, "text");
    // Original chunk offsets are UTF-16 units, while read_tool_result uses
    // Unicode scalar offsets. Verify boundaries rather than lossy decoding.
    let utf16 = original.encode_utf16().collect::<Vec<_>>();
    let selected = utf16
        .get(start..end)
        .and_then(|part| String::from_utf16(part).ok())
        .ok_or_else(|| invalid("原文区间超出正文或拆开了字符"))?;
    if selected != text || excerpt["title"] != title || excerpt["page"].as_i64() != paper_page {
        return Err(invalid("原文、章名或页码与书籍版本不一致"));
    }
    let before = char_slice(text, 0, segment.start).encode_utf16().count();
    let length = ws::text(page, "quote").encode_utf16().count();
    page["bookId"] = book.into();
    page["section"] = section.into();
    page["chunk"] = chunk.into();
    page["title"] = title.into();
    page["page"] = json!(paper_page);
    page["start"] = (start + before).into();
    page["end"] = (start + before + length).into();
    page["offsetUnit"] = "utf16".into();
    page["sourceLocationVerified"] = true.into();
    // A search excerpt can help locate the same text, but remains a snippet.
    page["searchSnippet"] = (page["sourceKind"] == "snippet").into();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        db: Connection,
        plan: RunPlan,
        task: Value,
        original: Value,
    }
    impl Fixture {
        fn new(text: &str) -> Self {
            let db = Connection::open_in_memory().unwrap();
            db.execute_batch("CREATE TABLE source_books(id TEXT PRIMARY KEY);CREATE TABLE source_sections(book_id TEXT,section INTEGER,title TEXT,page INTEGER);CREATE TABLE source_chunks(book_id TEXT,ordinal INTEGER,section INTEGER,text TEXT);CREATE TABLE pi_calls(task_id TEXT,call_id TEXT,tool TEXT,status TEXT,output_json TEXT,world_version TEXT,intent_revision INTEGER);CREATE TABLE pi_child_calls(task_id TEXT,call_id TEXT,child_id TEXT);CREATE TABLE pi_tasks(id TEXT,workspace_json TEXT);INSERT INTO source_books VALUES('b');INSERT INTO source_sections VALUES('b',0,'真实第一章',7);INSERT INTO pi_tasks VALUES('t','{}');").unwrap();
            db.execute("INSERT INTO source_chunks VALUES('b',0,0,?)", [text])
                .unwrap();
            let plan=serde_json::from_value(json!({"id":"t","worldId":"w","lineId":"l","headId":"n","kind":"pi_task","model":{"slot":"","url":"","model":"","includeUsage":false},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{"agent":{"referenceScope":{"bookId":"b","through":0}}}})).unwrap();
            let task = json!({"id":"t","world_id":"w","line_id":"l","base_world_version":"v1","intent_revision":2});
            let original = json!({"ok":true,"data":{"bookId":"b","through":0,"status":"ready","excerpts":[{"kind":"original","bookId":"b","section":0,"chunk":0,"title":"真实第一章","page":7,"start":0,"end":text.encode_utf16().count(),"text":text}]}});
            Self {
                db,
                plan,
                task,
                original,
            }
        }
        fn request(&self, id: &str, tool: &str, args: Value) -> PiCallRequest {
            PiCallRequest {
                task_id: "t".into(),
                call_id: id.into(),
                tool: tool.into(),
                args,
                intent_revision: 2,
                world_version: "v1".into(),
                external_write: false,
            }
        }
        fn save(&self, id: &str, tool: &str, value: &Value) {
            self.db
                .execute(
                    "INSERT INTO pi_calls VALUES('t',?,?, 'done',?,'v1',2)",
                    params![id, tool, value.to_string()],
                )
                .unwrap();
        }
        fn page(&self, source: &Value, args: &Value) -> Value {
            let path = ws::text(args, "path");
            let data = &source["data"];
            let selected = if path.is_empty() {
                data.clone()
            } else {
                data.pointer(path).unwrap().clone()
            };
            json!({"ok":true,"data":ws::page(selected,args)})
        }
    }
    #[test]
    fn hashes_all_string_leaves_by_utf8_pointer_order_and_ignores_numeric_spelling() {
        let a: Value =
            serde_json::from_str(r#"{"中":"末","a/b":{"~":"句\n字"},"a":["甲",1.0,true,null]}"#)
                .unwrap();
        let b = json!({"a":["甲",1,false,null],"a/b":{"~":"句\n字"},"中":"末"});
        assert_eq!(delivery_hash(&a), delivery_hash(&b));
        let leaves = json!([["/a/0", "甲"], ["/a~1b/~0", "句\n字"], ["/中", "末"]]);
        assert_eq!(
            delivery_hash(&a),
            format!("{:x}", Sha256::digest(serde_json::to_vec(&leaves).unwrap()))
        );
        let shared = json!({"ok":true,"data":{"a/b":"中文😀","a~b":["甲",1.0,null,{"":"乙\n丙"}],"":{"~/":"零"},"\u{e000}":"BMP","\u{10000}":"astral"},"count":1.0});
        assert_eq!(
            delivery_hash(&shared),
            "5a61792cff86f4497149e00c325cb4037463a2739cbd60cd7983c95aebd8c627"
        );
        assert!(check_delivery(&json!({"text":"中".repeat(43690)+"aa"})).is_ok());
        assert!(check_delivery(&json!({"text":"中".repeat(43690)+"aaa"})).is_err());
    }
    #[test]
    fn short_original_has_real_location_and_never_claims_delivery_or_interpretation() {
        let f = Fixture::new("旅人把青铜钥匙放在竹匣中。");
        let result = capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("original", "read_original", json!({"section":0})),
            &f.original,
            "",
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["pages"][0]["quote"], "旅人把青铜钥匙放在竹匣中。");
        assert_eq!(result["pages"][0]["title"], "真实第一章");
        assert_eq!(result["pages"][0]["page"], 7);
        assert_eq!(result["pages"][0]["sourceKind"], "original");
        assert_eq!(result["pages"][0]["interpretationVerified"], false);
        assert_eq!(result["deliveryStatus"], "candidate");
        assert!(result.get("accepted").is_none());
        let mut bad = f.original.clone();
        bad["data"]["excerpts"][0]["title"] = "模型编造章名".into();
        assert!(capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("bad", "read_original", json!({})),
            &bad,
            ""
        )
        .is_err());
    }
    #[test]
    fn late_and_nested_pages_keep_current_page_provenance_and_utf16_chunk_offsets() {
        let text = format!(
            "{}关键事实：钥匙在竹匣里，不在灯座。{}",
            "😀雨".repeat(1300),
            "雪".repeat(18000)
        );
        let f = Fixture::new(&text);
        f.save("original", "read_original", &f.original);
        let bounded = crate::pi_tools::delivery("original", "read_original", f.original.clone());
        let root = capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("original", "read_original", json!({})),
            &bounded,
            "",
        )
        .unwrap()
        .unwrap();
        assert!(
            root["pages"].as_array().unwrap().is_empty(),
            "the big-result directory is not text evidence"
        );
        let args = json!({"callId":"original","path":"/excerpts/0/text","offset":2595,"limit":100});
        let page = f.page(&f.original, &args);
        f.save("page", "read_tool_result", &page);
        let first = capture_with_source(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("page", "read_tool_result", args),
            &page,
            "",
            |id| Ok((id == "original").then(|| root["source"].clone())),
        )
        .unwrap()
        .unwrap();
        assert!(first["pages"][0]["quote"]
            .as_str()
            .unwrap()
            .contains("关键事实"));
        let args = json!({"callId":"page","path":"/text","offset":5,"limit":18});
        let nested = f.page(&page, &args);
        let next = capture_with_source(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("nested", "read_tool_result", args),
            &nested,
            "",
            |id| Ok((id == "page").then(|| first["source"].clone())),
        )
        .unwrap()
        .unwrap();
        assert_eq!(next["pages"][0]["sourceCallId"], "original");
        assert_eq!(next["pages"][0]["viaCallId"], "page");
        assert_eq!(next["pages"][0]["path"], "/text");
        assert_eq!(next["pages"][0]["sourcePath"], "/excerpts/0/text");
        let expected = text
            .chars()
            .take(2600)
            .collect::<String>()
            .encode_utf16()
            .count();
        assert_eq!(next["pages"][0]["start"], expected);
        assert_eq!(
            next["pages"][0]["quote"],
            text.chars().skip(2600).take(18).collect::<String>()
        );
        assert_eq!(next["source"]["offset"], 5, "not the next-page offset");
    }
    #[test]
    fn summaries_errors_locators_and_out_of_scope_text_cannot_be_original_evidence() {
        let mut f = Fixture::new("原著事实只在允许范围内读取。");
        let facts = json!({"ok":true,"data":{"facts":[{"quote":"原著事实只在允许范围内读取。","statement":"摘要"}]}});
        let candidate = capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("facts", "read_canon_facts", json!({})),
            &facts,
            "",
        )
        .unwrap()
        .unwrap();
        assert!(candidate["pages"].as_array().unwrap().is_empty());
        let snippet = capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("search", "search_original", json!({})),
            &f.original,
            "",
        )
        .unwrap()
        .unwrap();
        assert_eq!(snippet["pages"][0]["sourceKind"], "snippet");
        assert_eq!(snippet["pages"][0]["searchSnippet"], true);
        assert!(capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("error", "read_original", json!({})),
            &json!({"ok":false,"error":{"message":"失败"}}),
            ""
        )
        .unwrap()
        .is_none());
        let directory = json!({"ok":true,"data":{"kind":"book","value":[{"largeItemPath":"/data/sections/0","textPath":"/data/sections/0/text","message":"只是目录"}]}});
        assert!(capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("dir", "read_resource", json!({"kind":"book","id":"b"})),
            &directory,
            ""
        )
        .unwrap()
        .unwrap()["pages"]
            .as_array()
            .unwrap()
            .is_empty());
        f.plan.meta["agent"]["referenceScope"]["through"] = (-1).into();
        assert!(capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("fenced", "read_original", json!({})),
            &f.original,
            ""
        )
        .is_err());
    }
    #[test]
    fn draft_resource_is_not_formal_world_and_book_reads_need_original_tool() {
        let f = Fixture::new("原文。");
        f.db.execute("UPDATE pi_tasks SET workspace_json=? WHERE id='t'",[json!({"edits":[{"kind":"settings","id":"","original":{"premise":"旧"},"after":{"premise":"草稿"}}]}).to_string()]).unwrap();
        let value = json!({"ok":true,"data":{"kind":"settings","id":"","text":"草稿","offset":0,"nextOffset":2}});
        let result = capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request(
                "draft",
                "read_resource",
                json!({"kind":"settings","path":"/premise"}),
            ),
            &value,
            "",
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["pages"][0]["sourceKind"], "draft");
        let value = json!({"ok":true,"data":{"kind":"book","id":"b","text":"原文。"}});
        let result = capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("book", "read_resource", json!({"kind":"book","id":"b"})),
            &value,
            "",
        )
        .unwrap()
        .unwrap();
        assert_eq!(result["pages"][0]["sourceKind"], "world");
        assert_eq!(result["pages"][0]["requiresOriginalRead"], true);
    }
    #[test]
    fn later_intent_can_reread_earlier_native_text_but_not_future_results() {
        let f = Fixture::new("旧调用中的不可变原文，可以按新要求重新读取。");
        f.save("original", "read_original", &f.original);
        let root = capture(
            &f.db,
            &f.task,
            &f.plan,
            &f.request("original", "read_original", json!({"section":0})),
            &f.original,
            "",
        )
        .unwrap()
        .unwrap();
        let mut task = f.task.clone();
        task["intent_revision"] = 3.into();
        let args = json!({"callId":"original","path":"/excerpts/0/text","offset":2,"limit":12});
        let page = f.page(&f.original, &args);
        let mut request = f.request("new-page", "read_tool_result", args);
        request.intent_revision = 3;
        let candidate = capture_with_source(&f.db, &task, &f.plan, &request, &page, "", |id| {
            Ok((id == "original").then(|| root["source"].clone()))
        })
        .unwrap()
        .unwrap();
        assert_eq!(candidate["pages"][0]["intentRevision"], 3);
        assert_eq!(candidate["source"]["intentRevision"], 3);
        assert_eq!(
            candidate["deliveryStatus"], "candidate",
            "new intent still needs a new accepted model delivery"
        );
        f.db.execute(
            "UPDATE pi_calls SET intent_revision=4 WHERE call_id='original'",
            [],
        )
        .unwrap();
        assert!(capture(&f.db, &task, &f.plan, &request, &page, "").is_err());
    }
}

#[cfg(test)]
mod cursor_mapping_tests {
    use super::*;
    #[test]
    fn modern_cursor_maps_second_array_page_to_original_texts() {
        let value=json!({"value":[{"text":"第一段"},{"text":"第二段"},{"text":"第三段😀"}]});
        let segments=(0..3).map(|i|Segment {output:format!("/value/{i}/text"),root:format!("/value/{i}/text"),start:0,end:value["value"][i]["text"].as_str().unwrap().chars().count()}).collect::<Vec<_>>();
        let first=ws::page(value["value"].clone(),&json!({"path":"/value","pageSize":1,"charBudget":500}));
        let args=json!({"path":"/value","pageSize":1,"charBudget":500,"nextCursor":first["nextCursor"]});
        let mapped=reproject(&value,&segments,&args);
        assert_eq!(mapped.len(),1);assert_eq!(mapped[0].root,"/value/1/text");assert_eq!(mapped[0].output,"/value/0/text");
    }
}
