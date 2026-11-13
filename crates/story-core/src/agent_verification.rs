//! A quotation proves that a source was read, not that a model's inference is
//! correct. New canon tasks bind each proposed edit to explicit findings so
//! one unrelated quotation cannot stand in for an entire verification report.
#[cfg(test)]
use crate::{Error, Result, RunPlan};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

#[cfg(test)]
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
#[cfg(test)]
fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
#[cfg(test)]
fn enabled(plan: &RunPlan) -> bool {
    plan.meta["agent"]["canonVerificationVersion"] == 1
}
#[cfg(test)]
fn explicit_canon(plan: &RunPlan) -> bool {
    plan.meta["agent"]["requiresOriginalEvidence"] == true
}
#[cfg(test)]
fn uses_canon(plan: &RunPlan, draft: &Value) -> bool {
    explicit_canon(plan)
        || plan.meta["agent"]["skills"]
            .as_array()
            .is_some_and(|skills| skills.iter().any(|s| s == "canon-reference"))
        || draft["skillsRead"]
            .as_array()
            .is_some_and(|skills| skills.iter().any(|s| s == "canon-reference"))
}
fn fingerprint(workspace: &Value) -> String {
    // Include original/after state, authored turns/routes and the applied-call
    // ledger. Adding a later edit cannot reuse an earlier verification report.
    let snapshot = json!({"edits":workspace["edits"],"turns":workspace["turns"],"routes":workspace["routes"],"appliedCalls":workspace["appliedCalls"]});
    format!("{:x}", Sha256::digest(snapshot.to_string().as_bytes()))
}
fn required_calls(workspace: &Value) -> BTreeSet<String> {
    let mut calls = BTreeSet::new();
    let mut legacy_active_edit = false;
    for edit in workspace["edits"].as_array().into_iter().flatten() {
        if edit["after"] == edit["original"] {
            continue;
        }
        if let Some(ids) = edit["callIds"].as_array() {
            calls.extend(
                ids.iter()
                    .filter_map(Value::as_str)
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
        } else {
            legacy_active_edit = true;
        }
    }
    if legacy_active_edit {
        calls.extend(
            workspace["appliedCalls"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_owned),
        );
    }
    for turn in workspace["turns"].as_array().into_iter().flatten() {
        if let Some(call) = turn["_agentCall"].as_str().filter(|s| !s.is_empty()) {
            calls.insert(call.into());
        }
    }
    for route in workspace["routes"].as_array().into_iter().flatten() {
        if let Some(call) = route["callId"].as_str().filter(|s| !s.is_empty()) {
            calls.insert(call.into());
        }
    }
    calls
}
pub(crate) fn pending(workspace: &Value) -> Value {
    json!({"workspaceFingerprint":fingerprint(workspace),"requiredEditCallIds":required_calls(workspace),"message":"按每一项修改登记核对结论和实际依据；内部section/chunk为读取索引，书中章名只能引用工具返回的title。证据匹配不等于模型推断已由程序证明。"})
}
#[cfg(test)]
fn strings(value: &Value, label: &str, max: usize) -> Result<Vec<String>> {
    let Some(items) = value.as_array() else {
        if value.is_null() {
            return Ok(vec![]);
        }
        return Err(invalid(format!("{label}须为数组")));
    };
    if items.len() > max {
        return Err(invalid(format!("{label}过多，请分项登记")));
    }
    items
        .iter()
        .map(|item| {
            item.as_str()
                .filter(|s| !s.trim().is_empty())
                .map(str::to_owned)
                .ok_or_else(|| invalid(format!("{label}须使用真实调用标识")))
        })
        .collect()
}
#[cfg(test)]
fn quote<'a>(reference: &'a Value) -> Result<&'a str> {
    let quoted = text(reference, "quote").trim();
    if !(4..=2400).contains(&quoted.chars().count()) {
        return Err(invalid("请提供4至2400字的实际原句，不能用模型概括代替引文"));
    }
    Ok(quoted)
}
#[cfg(test)]
fn cited_page<'a>(draft: &'a Value, reference: &Value, original: bool) -> Result<&'a Value> {
    let quoted = quote(reference)?;
    let call = text(reference, "callId");
    let evidence = text(reference, "evidenceId");
    if call.is_empty() && evidence.is_empty() {
        return Err(invalid("证据须提供实际callId或evidenceId"));
    }
    draft["evidenceLedger"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|page| {
            let call_matches = page["callId"] == call || page["sourceCallId"] == call;
            let identified = if evidence.is_empty() {
                !call.is_empty() && call_matches
            } else {
                page["id"] == evidence && (call.is_empty() || call_matches)
            };
            let source_ok = if original {
                page["sourceKind"] == "original"
                    && page["searchSnippet"] != true
                    && page["sourceTool"] != "read_canon_facts"
            } else {
                page["sourceKind"] == "world"
                    && (page["snapshot"].is_null()
                        || page["snapshot"] == draft["memorySnapshot"])
            };
            identified
                && source_ok
                && page["quote"].as_str().is_some_and(|body| body.contains(quoted))
        })
        .ok_or_else(|| {
            invalid(if original {
                "该项没有匹配实际读到的原文：请读取对应段落并给出精确引文，搜索命中、AI整理卡或其他问题的原文不能代替本项依据"
            } else {
                "该项没有匹配当前版本实际读到的本局资料，旧卡片印象或过期结果不能直接作为核对依据"
            })
        })
}
#[cfg(test)]
fn citation(draft: &Value, reference: &Value, original: bool) -> Result<Value> {
    let page = cited_page(draft, reference, original)?;
    let location = &page["location"];
    Ok(json!({
        "callId":page["callId"],"evidenceId":page["id"],
        "quote":quote(reference)?,"sourceKind":page["sourceKind"],
        "title":location["title"],"bookId":location["bookId"],
        "sectionIndex":location["section"],"chunkIndex":location["chunk"],
        "page":location["page"],"read":page["read"],
        "sourceLocationVerified":true,"interpretationVerified":false
    }))
}
#[cfg(test)]
fn player_reference(draft: &Value, reference: &Value) -> Result<Value> {
    let quoted = quote(reference)?;
    let id = text(reference, "id");
    let found = draft["playerChoiceReferences"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|item| {
            !id.is_empty()
                && item["id"] == id
                && item["text"]
                    .as_str()
                    .is_some_and(|body| body.contains(quoted))
        })
        .ok_or_else(|| {
            invalid(
                "玩家分支须引用程序提供的真实玩家输入，AI正文、设定卡或助手总结不能冒充玩家选择",
            )
        })?;
    Ok(
        json!({"id":found["id"],"quote":quoted,"nodeId":found["nodeId"],"seq":found["seq"],"field":found["field"],"fromStoredPlayerInput":true,"interpretationVerified":false}),
    )
}

/// `args` is record_skill_check input. Store the returned value, not the
/// model-authored object, in draft.skillChecks.
#[cfg(test)]
pub(crate) fn validate_report(
    plan: &RunPlan,
    draft: &Value,
    workspace: &Value,
    args: &Value,
) -> Result<Value> {
    let mut report = json!({"id":args["id"],"status":args["status"],"summary":args["summary"],"evidenceCallIds":args.get("evidenceCallIds").cloned().unwrap_or(json!([]))});
    if !enabled(plan) || args["id"] != "canon-reference" {
        return Ok(report);
    }
    let status = text(args, "status");
    if status == "not_applicable" && explicit_canon(plan) {
        return Err(invalid("本次明确要求按原著核对，不能把遵循原著标为不适用"));
    }
    if !["completed", "insufficient", "not_applicable"].contains(&status) {
        return Err(invalid("原著核对状态无效"));
    }
    let findings = args["findings"].as_array();
    if status == "completed" && findings.is_none_or(Vec::is_empty) {
        return Err(invalid(
            "原著核对须逐项提供findings，不能只用一段总结或读过任一原文标记全部完成",
        ));
    }
    if findings.is_some_and(|items| items.len() > 64) {
        return Err(invalid("本次核对项过多，请按实际修改分项归纳（最多64项）"));
    }
    let required = required_calls(workspace);
    let mut covered = BTreeSet::new();
    let mut normalized = vec![];
    let mut unresolved = vec![];
    for finding in findings.into_iter().flatten() {
        let topic = text(finding, "topic").trim();
        let claim = text(finding, "claim").trim();
        if topic.is_empty()
            || topic.chars().count() > 300
            || claim.is_empty()
            || claim.chars().count() > 2400
        {
            return Err(invalid(
                "每项核对须填写具体topic和claim，不用总括的已完成代替",
            ));
        }
        let edit_calls = strings(&finding["editCallIds"], "editCallIds", 128)?;
        if edit_calls.iter().any(|call| !required.contains(call)) {
            return Err(invalid(
                "核对项引用了不在当前草稿中的修改调用；请用check_draft取得实际requiredEditCallIds",
            ));
        }
        let basis = text(finding, "basis");
        let mut citations = vec![];
        let mut player_refs = vec![];
        match basis {
            "original" | "local_consistency" => {
                let refs = finding["citations"]
                    .as_array()
                    .filter(|items| !items.is_empty())
                    .ok_or_else(|| {
                        invalid("每项核对须提供本项实际引文，不能借用无关技能或目录调用")
                    })?;
                if refs.len() > 12 {
                    return Err(invalid("单项引文过多，请只保留直接相关的原文"));
                }
                for reference in refs {
                    citations.push(citation(draft, reference, basis == "original")?);
                }
                if basis == "local_consistency" {
                    unresolved.push(json!({"topic":topic,"reason":"仅核对本局资料一致性，原著尚未逐项证实","editCallIds":edit_calls}));
                }
            }
            "player_choice" => {
                let refs = finding["playerRefs"]
                    .as_array()
                    .filter(|items| !items.is_empty())
                    .ok_or_else(|| invalid("玩家分支核对须提供playerRefs原始玩家输入引用"))?;
                if refs.len() > 12 {
                    return Err(invalid("单项玩家引用过多"));
                }
                for reference in refs {
                    player_refs.push(player_reference(draft, reference)?);
                }
            }
            "insufficient" => {
                unresolved.push(json!({"topic":topic,"reason":claim,"editCallIds":edit_calls}));
            }
            _ => {
                return Err(invalid(
                    "basis须为original、player_choice、local_consistency或insufficient",
                ))
            }
        }
        covered.extend(edit_calls.iter().cloned());
        normalized.push(json!({"topic":topic,"claim":claim,"basis":basis,"editCallIds":edit_calls,"citations":citations,"playerRefs":player_refs,"interpretationVerified":false}));
    }
    let missing = required.difference(&covered).cloned().collect::<Vec<_>>();
    // Incomplete reports remain inspectable, but cannot advertise a completed
    // canon pass. The model may save insufficient and finish as blocked.
    if status == "completed" && (!missing.is_empty() || !unresolved.is_empty()) {
        return Err(invalid(format!("原著核对尚未完成：未逐项覆盖的修改={}; 未核实事项={}。请补读对应原文/玩家选择并更新findings，或登记insufficient并保留草稿报告受阻。",json!(missing),json!(unresolved))));
    }
    report["verificationVersion"] = 1.into();
    report["workspaceFingerprint"] = fingerprint(workspace).into();
    report["intentRevision"] = draft["intentRevision"].clone();
    report["sourceLocationVerified"] = normalized
        .iter()
        .any(|item| {
            item["citations"].as_array().is_some_and(|v| !v.is_empty())
                || item["playerRefs"].as_array().is_some_and(|v| !v.is_empty())
        })
        .into();
    report["findings"] = json!(normalized);
    report["coveredEditCallIds"] = json!(covered);
    report["missingEditCallIds"] = json!(missing);
    report["unresolved"] = json!(unresolved);
    report["interpretationVerified"] = false.into();
    Ok(report)
}

/// Call before adopting a completed canon task. A deliberate blocked result
/// may retain an incomplete report and draft; it must not call this adoption
/// guard as if the draft were ready to commit.
#[cfg(test)]
pub(crate) fn validate_completion(
    plan: &RunPlan,
    draft: &Value,
    workspace: &Value,
) -> Result<Value> {
    if !enabled(plan) || !uses_canon(plan, draft) {
        return Ok(json!({"required":false}));
    }
    let report = draft["skillChecks"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|r| r["id"] == "canon-reference")
        .ok_or_else(|| invalid("请先逐项记录遵循原著的实际核对依据"))?;
    if report["status"] == "not_applicable" && !explicit_canon(plan) {
        return Ok(json!({"required":false,"status":"not_applicable"}));
    }
    if report["verificationVersion"] != 1 {
        return Err(invalid(
            "当前原著检查仍是旧式总结；请用findings逐项绑定实际修改与依据",
        ));
    }
    if report["workspaceFingerprint"] != fingerprint(workspace) {
        return Err(invalid(
            "核对后草稿发生变化，旧检查不能覆盖新修改；请重新核对并登记当前findings",
        ));
    }
    if report["intentRevision"] != draft["intentRevision"] {
        return Err(invalid(
            "玩家补充了新要求，旧核对不能直接采用；请按当前要求重新检查并登记findings",
        ));
    }
    let no_draft = required_calls(workspace).is_empty()
        && ["edits", "turns", "routes"]
            .iter()
            .all(|key| workspace[*key].as_array().is_none_or(Vec::is_empty));
    if report["status"] == "insufficient" && no_draft {
        return Ok(
            json!({"required":true,"status":"insufficient","findings":report["findings"],"unresolved":report["unresolved"],"sourceLocationVerified":report["sourceLocationVerified"],"interpretationVerified":false,"message":"没有待采用修改；本次只答复资料不足，不能声称原著已核实。"}),
        );
    }
    if report["status"] != "completed"
        || report["unresolved"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
        || report["missingEditCallIds"]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    {
        return Err(invalid("仍有未核实的原著修改，不能宣称全面完成或自动采用；请继续查证，或明确报告受阻并保留草稿"));
    }
    // Do not trust a saved report alone: revalidate every quotation and player
    // reference against the current trusted projection when resuming a run.
    let checked = validate_report(plan, draft, workspace, report)?;
    Ok(
        json!({"required":true,"status":"completed","findings":checked["findings"],"sourceLocationVerified":true,"interpretationVerified":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn plan() -> RunPlan {
        serde_json::from_value(json!({"id":"verification","worldId":"w","lineId":"l","headId":"n","kind":"pi_task","model":{"slot":"no-key","url":"https://fixture.invalid","model":"fake","includeUsage":false},"options":{},"action":{},"meta":{"agent":{"canonVerificationVersion":1,"requiresOriginalEvidence":true}},"messages":[],"extractMessages":[],"state":{},"settings":{}})).unwrap()
    }
    fn draft() -> Value {
        json!({"memorySnapshot":{"head":"n"},"evidenceLedger":[{"id":"e1","callId":"read-1","sourceCallId":"read-1","sourceTool":"read_original","sourceKind":"original","quote":"玄老明确说，五年后你们将参加下一届大赛。","location":{"title":"第六十三章 预备队（上）","section":211,"chunk":301,"bookId":"b"},"read":{"callId":"read-1","path":"/excerpts/0/text"},"searchSnippet":false}],"playerChoiceReferences":[{"id":"p1","text":"我救下阿兰，保留他活着的分支。","nodeId":"n0","seq":3,"field":"action_text"}]})
    }
    fn workspace() -> Value {
        json!({"edits":[{"kind":"node","id":"n","after":{"narrative":"五年一届"}}],"appliedCalls":["edit-1"]})
    }
    fn report() -> Value {
        json!({"id":"canon-reference","status":"completed","summary":"逐项核对","findings":[{"topic":"赛事周期","claim":"大赛应为五年周期","basis":"original","editCallIds":["edit-1"],"citations":[{"callId":"read-1","quote":"五年后你们将参加下一届大赛","title":"第211章"}]}]})
    }
    #[test]
    fn each_edit_needs_actual_evidence_and_titles_are_not_model_authored() {
        let p = plan();
        let mut d = draft();
        let w = workspace();
        let r = validate_report(&p, &d, &w, &report()).unwrap();
        assert_eq!(
            r["findings"][0]["citations"][0]["title"],
            "第六十三章 预备队（上）"
        );
        assert_eq!(r["findings"][0]["citations"][0]["sectionIndex"], 211);
        assert_eq!(r["interpretationVerified"], false);
        d["skillChecks"] = json!([r]);
        assert!(validate_completion(&p, &d, &w).is_ok());
        let mut changed = w.clone();
        changed["appliedCalls"]
            .as_array_mut()
            .unwrap()
            .push(json!("edit-2"));
        assert!(validate_completion(&p, &d, &changed)
            .unwrap_err()
            .to_string()
            .contains("草稿发生变化"));
        assert!(validate_report(&p, &d, &changed, &report())
            .unwrap_err()
            .to_string()
            .contains("edit-2"));
        d["intentRevision"] = 2.into();
        assert!(validate_completion(&p, &d, &w)
            .unwrap_err()
            .to_string()
            .contains("补充了新要求"));
    }
    #[test]
    fn one_quote_cannot_complete_missing_items_or_fabricated_quotes() {
        let p = plan();
        let d = draft();
        let w = workspace();
        let mut r = report();
        r["findings"][0]["citations"][0]["quote"] = "魂骨同部位不能重复吸收".into();
        assert!(validate_report(&p, &d, &w, &r).is_err());
        let mut wrong = d.clone();
        wrong["evidenceLedger"][0]["searchSnippet"] = true.into();
        assert!(validate_report(&p, &wrong, &w, &report()).is_err());
        let mut incomplete = report();
        incomplete["findings"][0]["editCallIds"] = json!([]);
        assert!(validate_report(&p, &d, &w, &incomplete)
            .unwrap_err()
            .to_string()
            .contains("edit-1"));
    }
    #[test]
    fn local_consistency_is_not_canon_and_player_choice_requires_actual_input() {
        let p = plan();
        let mut d = draft();
        let w = workspace();
        d["evidenceLedger"].as_array_mut().unwrap().push(json!({"id":"world-page","callId":"read-world","sourceKind":"world","sourceTool":"read_resource","quote":"背包中仍保存尚未吸收的魂骨。","snapshot":{"head":"n"},"location":{"kind":"state"}}));
        let mut r = report();
        r["findings"][0]["basis"] = "local_consistency".into();
        r["findings"][0]["citations"] = json!([{"callId":"read-world","quote":"尚未吸收的魂骨"}]);
        assert!(validate_report(&p, &d, &w, &r).is_err());
        r["status"] = "insufficient".into();
        let saved = validate_report(&p, &d, &w, &r).unwrap();
        assert_eq!(saved["unresolved"].as_array().unwrap().len(), 1);
        d["skillChecks"] = json!([saved]);
        assert!(validate_completion(&p, &d, &w).is_err());
        let mut branch = report();
        branch["findings"][0]["basis"] = "player_choice".into();
        branch["findings"][0]["playerRefs"] = json!([{"id":"p1","quote":"保留他活着的分支"}]);
        assert!(validate_report(&p, &d, &w, &branch).is_ok());
        branch["findings"][0]["playerRefs"][0]["quote"] = "阿兰原著中早已死亡".into();
        assert!(validate_report(&p, &d, &w, &branch).is_err());
    }
    #[test]
    fn new_guard_does_not_upgrade_legacy_or_non_canon_tasks() {
        let mut p = plan();
        p.meta["agent"]["canonVerificationVersion"] = Value::Null;
        assert!(validate_completion(&p, &json!({}), &workspace()).is_ok());
        assert!(validate_report(
            &p,
            &draft(),
            &workspace(),
            &json!({"id":"canon-reference","status":"completed","summary":"旧记录"})
        )
        .is_ok());
        p.meta["agent"]["canonVerificationVersion"] = 1.into();
        p.meta["agent"]["requiresOriginalEvidence"] = false.into();
        assert_eq!(
            validate_completion(&p, &json!({}), &workspace()).unwrap()["required"],
            false
        );
    }
    #[test]
    fn a_readonly_insufficient_answer_is_allowed_without_adopting_any_draft() {
        let p = plan();
        let mut d = draft();
        let w = json!({});
        let report = validate_report(
            &p,
            &d,
            &w,
            &json!({"id":"canon-reference","status":"insufficient","summary":"对应原文资料不足，无法核实"}),
        )
        .unwrap();
        d["skillChecks"] = json!([report]);
        assert_eq!(
            validate_completion(&p, &d, &w).unwrap()["status"],
            "insufficient"
        );
        let mut modified = workspace();
        modified["appliedCalls"] = json!([]);
        d["skillChecks"][0]["workspaceFingerprint"] = fingerprint(&modified).into();
        assert!(validate_completion(&p, &d, &modified).is_err());
    }
    #[test]
    fn discarded_and_reverted_calls_are_not_pending_verification() {
        let p = plan();
        let d = draft();
        let mut w = workspace();
        w["edits"][0]["callIds"] = json!(["edit-1"]);
        w["appliedCalls"] = json!(["old-discarded", "edit-1"]);
        assert_eq!(pending(&w)["requiredEditCallIds"], json!(["edit-1"]));
        assert!(validate_report(&p, &d, &w, &report()).is_ok());
        w["edits"] = json!([]);
        assert_eq!(pending(&w)["requiredEditCallIds"], json!([]));
        let mut query = report();
        query["findings"][0]["editCallIds"] = json!([]);
        assert!(validate_report(&p, &d, &w, &query).is_ok());
        let mut reverted = workspace();
        reverted["edits"][0]["original"] = reverted["edits"][0]["after"].clone();
        assert_eq!(pending(&reverted)["requiredEditCallIds"], json!([]));
    }
}
