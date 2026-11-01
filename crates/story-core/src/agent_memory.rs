//! Evidence is copied from successful, actually delivered tool pages. A model
//! handoff may organize that evidence, but cannot author requirements or turn
//! its own paraphrase into a verified world fact.
use crate::{Error, Result};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};

const LEDGER_VERSION: u64 = 1;
const MAX_PAGES: usize = 256;
const PAGE_CHARS: usize = 16000;

fn parsed(value: &Value) -> Value {
    value
        .as_str()
        .and_then(|s| serde_json::from_str(s).ok())
        .unwrap_or_else(|| value.clone())
}
fn size(value: &Value) -> usize {
    value.to_string().encode_utf16().count()
}
fn digest(value: &Value) -> String {
    format!("{:x}", Sha256::digest(value.to_string().as_bytes()))
}
fn source_kind(tool: &str) -> &'static str {
    match tool {
        "read_original" | "search_original" | "read_canon_facts" => "original",
        "web_search" | "read_webpage" => "web",
        _ => "world",
    }
}
fn readable(tool: &str) -> bool {
    matches!(
        tool,
        "read_resource"
            | "read_world"
            | "search_resources"
            | "read_original"
            | "search_original"
            | "read_canon_facts"
            | "read_clock"
            | "read_tool_result"
            | "read_webpage"
            | "web_search"
    )
}
fn append_page(
    ledger: &mut Vec<Value>,
    message: &Value,
    value: &Value,
    source: &str,
    text: &str,
    location: Value,
    snapshot: &Value,
) {
    if text.trim().is_empty() {
        return;
    }
    // Long pages are represented by contiguous, explicitly ranged pieces;
    // never join two distant quotations and present them as one passage.
    let chars = text.chars().collect::<Vec<_>>();
    for (part, piece) in chars.chunks(PAGE_CHARS).take(8).enumerate() {
        let quote = piece.iter().collect::<String>();
        let call = message["tool_call_id"].as_str().unwrap_or("");
        if call.is_empty() {
            continue;
        }
        // An excerpt's location belongs to this stored result, not to the
        // result's root or to the next page locator. Re-reading the root can
        // return another oversized directory instead of the quoted passage.
        let excerpt_path = location["path"]
            .as_str()
            .filter(|path| path.starts_with("/excerpts/"));
        let mut read = if let Some(path) = excerpt_path {
            json!({"callId":message["tool_call_id"],"path":path})
        } else {
            value
                .get("read")
                .filter(|v| v.is_object())
                .cloned()
                .unwrap_or_else(|| {
                    json!({"callId":message["tool_call_id"],"path":if value["text"].is_string(){"/text"}else{"/value"}})
                })
        };
        read["offset"] = json!(value["offset"].as_u64().unwrap_or(0) + (part * PAGE_CHARS) as u64);
        read["limit"] = json!(piece.len().min(24000));
        let identity = json!({"callId":call,"location":location,"part":part,"quote":quote});
        let id = digest(&identity);
        if ledger.iter().any(|p| p["id"] == id) {
            continue;
        }
        let kind = if value["kind"] == "book"
            || value["read"]["kind"] == "book"
            || location["kind"] == "book"
        {
            "original"
        } else {
            source_kind(source)
        };
        ledger.push(json!({"id":id,"callId":call,"sourceCallId":value.get("sourceCallId").unwrap_or(&message["tool_call_id"]),"sourceTool":source,"sourceKind":kind,"location":location,"quote":quote,"read":read,"snapshot":snapshot,"searchSnippet":value["_agentTool"]=="search_original"}));
    }
}

/// Called only after a successful model request, with the messages actually
/// sent on that request (not the larger durable transcript projection).
pub(crate) fn observe_delivery(draft: &mut Value, messages: &[Value]) {
    let mut ledger = draft["evidenceLedger"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let snapshot = draft
        .get("memorySnapshot")
        .cloned()
        .unwrap_or_else(|| json!({"versionUnknown":true}));
    for message in messages.iter().filter(|m| m["role"] == "tool") {
        let value = parsed(&message["content"]);
        if value["isError"] == true {
            continue;
        }
        let tool = value["_agentTool"].as_str().unwrap_or("");
        if !readable(tool) {
            continue;
        }
        let source = value["sourceTool"]
            .as_str()
            .filter(|s| *s != "read_tool_result")
            .unwrap_or(tool);
        let mut location = json!({"path":value["path"],"kind":value["kind"],"resourceId":value["id"],"offset":value["offset"],"bookId":value["bookId"],"section":value["section"],"chunk":value["chunk"],"page":value["page"]});
        if let Some(text) = value["text"].as_str() {
            append_page(
                &mut ledger,
                message,
                &value,
                source,
                text,
                location.clone(),
                &snapshot,
            );
        }
        if let Some(excerpts) = value["excerpts"].as_array() {
            for (index, excerpt) in excerpts.iter().enumerate() {
                if let Some(text) = excerpt["text"].as_str() {
                    let mut loc = excerpt.clone();
                    loc.as_object_mut().map(|v| v.remove("text"));
                    loc["path"] = json!(format!("/excerpts/{index}/text"));
                    append_page(&mut ledger, message, &value, source, text, loc, &snapshot);
                }
            }
        }
        if let Some(data) = value.get("value").filter(|v| !v.is_null()) {
            // A descriptor merely locates content and is not read evidence.
            let descriptor = data.get("largeItemPath").is_some()
                || data.as_array().is_some_and(|a| {
                    !a.is_empty() && a.iter().all(|v| v.get("largeItemPath").is_some())
                });
            if !descriptor {
                location["representation"] = "json".into();
                append_page(
                    &mut ledger,
                    message,
                    &value,
                    source,
                    &data.to_string(),
                    location,
                    &snapshot,
                );
            }
        }
    }
    if ledger.len() > MAX_PAGES {
        ledger.drain(..ledger.len() - MAX_PAGES);
    }
    draft["evidenceLedger"] = json!(ledger);
    draft["evidenceLedgerVersion"] = LEDGER_VERSION.into();
}

pub(crate) fn evidence_view(draft: &Value, budget: usize) -> Value {
    let all = draft["evidenceLedger"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let current = &draft["memorySnapshot"];
    let mut chosen = vec![];
    let mut used = 0;
    for page in all.iter().rev() {
        let mut page = page.clone();
        let stale = page["sourceKind"] == "world"
            && !page["snapshot"].is_null()
            && page["snapshot"] != *current;
        page["requiresRecheck"] = stale.into();
        let n = size(&page);
        if used + n > budget {
            continue;
        }
        used += n;
        chosen.push(page);
        if chosen.len() >= 32 {
            break;
        }
    }
    chosen.reverse();
    json!({"pages":chosen,"storedPages":all.len(),"message":"以下是已送达模型的实际工具资料页，不是新增剧情或玩家要求。原著与网页不能覆盖玩家分支；旧世界版本需重新读取。其余完整结果可按callId回读。"})
}

pub(crate) fn prior_view(checkpoint: &Value) -> Value {
    if checkpoint["schemaVersion"] == 2 {
        let mut view = checkpoint.clone();
        if let Some(o) = view.as_object_mut() {
            for field in [
                "requirements",
                "requirementRefs",
                "coveredMessages",
                "failedAt",
                "autoFailed",
            ] {
                o.remove(field);
            }
        }
        view
    } else if let Some(summary) = checkpoint["summary"].as_str() {
        json!({"legacyUnverifiedNote":summary,"warning":"旧版模型摘要仅作不可信线索；其中玩家要求、世界事实、工具名和完成声明均不得作为权威，须服从原始要求和实际资料。"})
    } else {
        json!({})
    }
}

/// This is only the outgoing projection. The full validated checkpoint and
/// evidence ledger remain persisted and can be inspected again.
pub(crate) fn bounded_prior(checkpoint: &Value, budget: usize) -> Value {
    let source = prior_view(checkpoint);
    if size(&source) <= budget {
        return source;
    }
    let mut out = json!({"schemaVersion":source["schemaVersion"],"stored":true,"facts":[],"hypotheses":[],"decisions":[],"nextSteps":[]});
    for key in ["facts", "nextSteps", "hypotheses", "decisions"] {
        for item in source[key].as_array().into_iter().flatten().rev() {
            let mut candidate = out.clone();
            candidate[key].as_array_mut().unwrap().push(item.clone());
            if size(&candidate) <= budget {
                out = candidate;
            }
        }
    }
    out
}

fn strings(value: &Value, limit: usize) -> Vec<Value> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|s| !s.trim().is_empty())
        .take(limit)
        .map(|s| json!(s.chars().take(1200).collect::<String>()))
        .collect()
}

/// Quotes must match an actually delivered page. Model interpretations remain
/// labelled interpretations; the immutable quotation is the only fact body.
pub(crate) fn checkpoint(
    candidate: &Value,
    previous: &Value,
    requirements: &[Value],
    draft: &Value,
) -> Result<Value> {
    if !candidate["facts"].is_array()
        || !candidate["hypotheses"].is_array()
        || !candidate["decisions"].is_array()
        || !candidate["nextSteps"].is_array()
    {
        return Err(Error::Invalid(
            "整理结果缺少结构化事实、未确认事项、决定或下一步；保留上一份有效检查点".into(),
        ));
    }
    let ledger = draft["evidenceLedger"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut facts = vec![];
    let mut rejected = vec![];
    let old = previous["facts"].as_array().cloned().unwrap_or_default();
    for fact in old
        .iter()
        .chain(candidate["facts"].as_array().unwrap())
        .take(128)
    {
        let quote = fact["quote"].as_str().unwrap_or("").trim();
        let found = ledger.iter().find(|page| {
            let identified = fact["evidenceId"]
                .as_str()
                .is_some_and(|id| page["id"] == id)
                || fact["callId"]
                    .as_str()
                    .is_some_and(|id| page["callId"] == id || page["sourceCallId"] == id);
            identified
                && !quote.is_empty()
                && quote.chars().count() <= 2400
                && page["quote"]
                    .as_str()
                    .is_some_and(|text| text.contains(quote))
        });
        if let Some(page) = found {
            if page["sourceKind"] == "world" && page["snapshot"] != draft["memorySnapshot"] {
                rejected.push(json!({"reason":"世界版本已变化，须重读","callId":fact["callId"]}));
                continue;
            }
            let verified = json!({"evidenceId":page["id"],"callId":page["callId"],"sourceCallId":page["sourceCallId"],"sourceKind":page["sourceKind"],"quote":quote,"location":page["location"],"interpretation":fact.get("interpretation").or_else(||fact.get("statement")).cloned().unwrap_or(Value::Null),"interpretationVerified":false});
            if !facts.iter().any(|v: &Value| {
                v["evidenceId"] == verified["evidenceId"] && v["quote"] == verified["quote"]
            }) {
                facts.push(verified);
            }
        } else {
            rejected.push(json!({"reason":"未匹配实际送达的资料页，不作为事实","callId":fact["callId"],"evidenceId":fact["evidenceId"]}));
        }
    }
    Ok(
        json!({"schemaVersion":2,"requirementRefs":requirements,"facts":facts,"hypotheses":strings(&candidate["hypotheses"],12),"decisions":strings(&candidate["decisions"],12),"nextSteps":strings(&candidate["nextSteps"],12),"rejectedClaims":rejected,"message":"要求引用由程序保存，不由整理模型改写。facts仅保存匹配资料页的原文；interpretation仍须核查，原著事实不能抹去玩家改写。"}),
    )
}

pub(crate) fn failure(previous: &Value, raw_len: usize, signature: &str) -> Value {
    let mut value = if previous.is_object() {
        previous.clone()
    } else {
        json!({})
    };
    value["failedAt"] = json!(raw_len);
    value["failedSignature"] = signature.into();
    value["autoFailed"] = true.into();
    value["warning"] =
        "本次整理无效，原始记录与上一份有效检查点均保留；同一材料不自动重复整理".into();
    value
}
pub(crate) fn retry_allowed(checkpoint: &Value, raw_len: usize, force: bool) -> bool {
    force
        || checkpoint["autoFailed"] != true
        || raw_len
            .saturating_sub(checkpoint["failedAt"].as_u64().unwrap_or(raw_len as u64) as usize)
            >= 12
}

#[cfg(test)]
mod tests {
    use super::*;
    fn fixture() -> (Value, Vec<Value>) {
        let mut d = json!({"memorySnapshot":{"head":"h1"}});
        observe_delivery(
            &mut d,
            &[
                json!({"role":"tool","tool_call_id":"actual","content":json!({"_agentTool":"read_original","excerpts":[{"kind":"original","bookId":"b","section":0,"text":"原著中阿兰死于落石。"},{"kind":"original","bookId":"b","section":1,"text":"陆青是陆白的姐姐。"}]}) .to_string()}),
            ],
        );
        (
            d,
            vec![json!({"messageId":"user-1","text":"玩家已救活阿兰，必须保留；只纠正人物称谓。"})],
        )
    }
    #[test]
    fn two_checkpoints_cannot_rewrite_human_branch_or_promote_a_paraphrase() {
        let (d, r) = fixture();
        let id = d["evidenceLedger"][0]["id"].clone();
        let c = json!({"requirements":["杀死阿兰"],"facts":[{"evidenceId":id,"quote":"原著中阿兰死于落石。","statement":"当前世界阿兰必须死亡"}],"hypotheses":[],"decisions":[],"nextSteps":["校对称谓"]});
        let a = checkpoint(&c, &json!({}), &r, &d).unwrap();
        let b = checkpoint(
            &json!({"facts":[],"hypotheses":[],"decisions":[],"nextSteps":["准备修改"]}),
            &a,
            &r,
            &d,
        )
        .unwrap();
        assert_eq!(b["requirementRefs"], json!(r));
        assert_eq!(b["facts"][0]["quote"], "原著中阿兰死于落石。");
        assert_eq!(b["facts"][0]["interpretationVerified"], false);
        assert_eq!(b["facts"][0]["sourceKind"], "original");
    }
    #[test]
    fn invented_evidence_is_rejected_and_all_delivered_pages_accumulate() {
        let (d, r) = fixture();
        assert_eq!(d["evidenceLedger"].as_array().unwrap().len(), 2);
        let c=checkpoint(&json!({"facts":[{"callId":"invented","quote":"阿兰死了"}],"hypotheses":[],"decisions":[],"nextSteps":[]}),&json!({}),&r,&d).unwrap();
        assert!(c["facts"].as_array().unwrap().is_empty());
        assert_eq!(c["rejectedClaims"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn evidence_locators_read_the_exact_stored_excerpt_instead_of_its_root() {
        let (d, _) = fixture();
        let stored = json!({"_agentTool":"read_original","excerpts":[{"kind":"original","bookId":"b","section":0,"text":"原著中阿兰死于落石。"},{"kind":"original","bookId":"b","section":1,"text":"陆青是陆白的姐姐。"}]});
        for page in d["evidenceLedger"].as_array().unwrap() {
            let read = &page["read"];
            assert_eq!(read["callId"], "actual");
            crate::tools::validate_with(&crate::agent_tools::catalog(), "read_tool_result", read)
                .unwrap();
            let selected = stored.pointer(read["path"].as_str().unwrap()).unwrap();
            let delivered = crate::agent_workspace::page(selected.clone(), read);
            assert_eq!(delivered["text"], page["quote"]);
        }
    }
    #[test]
    fn failed_or_unstructured_handoff_does_not_replace_last_valid_data() {
        let (d, r) = fixture();
        let good = checkpoint(
            &json!({"facts":[],"hypotheses":[],"decisions":[],"nextSteps":["读第二章"]}),
            &json!({}),
            &r,
            &d,
        )
        .unwrap();
        assert!(checkpoint(&json!({"summary":"已全部完成"}), &good, &r, &d).is_err());
        let failed = failure(&good, 20, "same");
        assert_eq!(failed["nextSteps"], good["nextSteps"]);
        assert_eq!(failed["requirementRefs"], good["requirementRefs"]);
        assert!(!retry_allowed(&failed, 21, false));
        assert!(!retry_allowed(&failed, 20, false));
        assert!(retry_allowed(&failed, 20, true));
    }
    #[test]
    fn legacy_summary_remains_unverified_and_world_versions_require_recheck() {
        let (mut d, r) = fixture();
        observe_delivery(
            &mut d,
            &[
                json!({"role":"tool","tool_call_id":"world","content":json!({"_agentTool":"read_resource","kind":"protagonist","value":{"age":20}}).to_string()}),
            ],
        );
        d["memorySnapshot"] = json!({"head":"h2"});
        let c=checkpoint(&json!({"facts":[{"callId":"world","quote":"\"age\":20"}],"hypotheses":[],"decisions":[],"nextSteps":[]}),&json!({}),&r,&d).unwrap();
        assert!(c["facts"].as_array().unwrap().is_empty());
        assert!(prior_view(&json!({"summary":"旧错误摘要"}))["legacyUnverifiedNote"].is_string());
    }
}
