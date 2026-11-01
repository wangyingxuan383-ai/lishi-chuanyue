//! Pure, bounded finding validation. This checks exact source text, native
//! delivery/version coordinates and complete resource boundaries. It does not
//! prove that a quotation supports the model's interpretation, replay story
//! state, authorize a write, commit a draft or rebase an unadopted remainder.
use crate::{pi_verification, Error, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn array<'a>(value: &'a Value, label: &str, max: usize) -> Result<&'a [Value]> {
    let values = value
        .as_array()
        .ok_or_else(|| invalid(format!("{label}须为数组")))?;
    if values.len() > max {
        return Err(invalid(format!("{label}超过本批上限{max}")));
    }
    Ok(values)
}
fn short(value: &Value, key: &str, max: usize) -> Result<String> {
    let result = text(value, key).trim();
    if result.is_empty() || result.chars().count() > max {
        return Err(invalid(format!("{key}须填写具体内容（最多{max}字）")));
    }
    Ok(result.into())
}
fn selection(group: &Value) -> Value {
    json!({"groupId":group["groupId"],"fingerprint":group["fingerprint"],"afterFingerprint":group["afterFingerprint"],"originalFingerprint":group["originalFingerprint"]})
}
fn quote(reference: &Value) -> Result<&str> {
    let quote = text(reference, "quote");
    if !(4..=2400).contains(&quote.chars().count()) || quote.trim().is_empty() {
        return Err(invalid(
            "引用须保留4至2400字的精确原句，不以概括、目录或省略号代替",
        ));
    }
    Ok(quote)
}

fn citation(
    reference: &Value,
    pages: &[Value],
    constraints: &Value,
    expected: &str,
) -> Result<Value> {
    let original=expected=="original";
    let external=expected=="external";
    let quoted = quote(reference)?;
    let id = text(reference, "evidenceId");
    if id.is_empty() {
        return Err(invalid("引用缺少本次evidenceLedger中的evidenceId"));
    }
    let found = pages
        .iter()
        .filter(|page| page["id"] == id)
        .collect::<Vec<_>>();
    if found.len() != 1 {
        return Err(invalid("引用定位已不存在或有歧义，请重新读取当前原文"));
    }
    let page = found[0];
    if page["deliveryConfirmed"] != true
        || page["confirmedIntentRevision"] != constraints["intentRevision"]
        || page["worldVersion"] != constraints["worldVersion"]
        || page["snapshot"]["worldVersion"] != constraints["worldVersion"]
    {
        return Err(invalid(
            "本项原文尚未实际送达成功模型请求，或属于旧要求/旧故事版本",
        ));
    }
    if original {
        if page["sourceKind"] != "original"
            || page["searchSnippet"] == true
            || page["sourceLocationVerified"] != true
            || page["sourceTool"] != "read_original"
            || page["requiresOriginalRead"] == true
        {
            return Err(invalid(
                "原著依据须为已实际阅读的原文，搜索片段、AI摘要、本局资料和草稿不能替代",
            ));
        }
    } else if external {
        if page["sourceKind"]!="external"||page["sourceLocationVerified"]!=true{return Err(invalid("外部依据须为实际读取且送达的资料快照，不能冒充原著原文"));}
    } else if page["sourceKind"] != "world" || page["requiresOriginalRead"] == true {
        return Err(invalid(
            "本局一致性依据须为当前正式故事资料，草稿和通用书籍读取不能充当正式事实",
        ));
    }
    let location = &page["location"];
    let supplied = &reference["location"];
    let required: &[&str] = if original {
        &["bookId", "section", "chunk", "path", "offset"]
    } else {
        &["path", "offset"]
    };
    for key in required {
        if location[*key].is_null() || supplied.get(*key) != location.get(*key) {
            return Err(invalid(format!(
                "引用的{key}与实际阅读位置不符，请直接使用evidenceLedger.location"
            )));
        }
    }
    // Never let a model-authored chapter name or page silently replace the
    // actual book metadata, even when its quotation happens to be correct.
    for key in [
        "bookId", "section", "chunk", "path", "offset", "title", "page",
    ] {
        if supplied
            .get(key)
            .is_some_and(|value| value != &location[key])
        {
            return Err(invalid(format!("引用的{key}与实际出处不符")));
        }
    }
    let body = text(page, "quote");
    let unit = text(page, "offsetUnit");
    if !["utf16", "unicode-scalar"].contains(&unit) {
        return Err(invalid("原生证据缺少明确的文字偏移单位"));
    }
    let start = page["start"]
        .as_u64()
        .ok_or_else(|| invalid("证据起点无效"))?;
    let end = page["end"]
        .as_u64()
        .ok_or_else(|| invalid("证据终点无效"))?;
    let length = |value: &str| -> u64 {
        if unit == "utf16" {
            value.encode_utf16().count() as u64
        } else {
            value.chars().count() as u64
        }
    };
    if start.checked_add(length(body)) != Some(end) || location["offset"].as_u64() != Some(start) {
        return Err(invalid("原生证据的区间与正文不一致"));
    }
    let matching = body.match_indices(quoted).find_map(|(byte, _)| {
        let at = start.checked_add(length(&body[..byte]))?;
        if reference
            .get("quoteOffset")
            .is_none_or(|offset| offset.as_u64() == Some(at))
        {
            Some(at)
        } else {
            None
        }
    });
    let quote_start =
        matching.ok_or_else(|| invalid("精确引文或quoteOffset未出现在该次实际送达的有界正文中"))?;
    let quote_end = quote_start
        .checked_add(length(quoted))
        .ok_or_else(|| invalid("引文区间溢出"))?;
    Ok(
        json!({"evidenceId":page["id"],"callId":page["callId"],"actorId":page["actorId"],"quote":quoted,"sourceKind":page["sourceKind"],"location":location,"quoteOffset":quote_start,"quoteEnd":quote_end,"offsetUnit":unit,"deliveryConfirmed":true,"worldVersion":constraints["worldVersion"],"intentRevision":constraints["intentRevision"],"sourceLocationVerified":true,"interpretationVerified":false}),
    )
}

fn player_reference(reference: &Value, constraints: &Value, kind: &str) -> Result<Value> {
    let quoted = quote(reference)?;
    let id = text(reference, "playerReferenceId");
    let found = constraints["playerReferences"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|item| !id.is_empty() && item["id"] == id)
        .collect::<Vec<_>>();
    if found.len() != 1 {
        return Err(invalid(
            "玩家分支须引用程序提供的真实玩家原句，助手说明和设定卡不能冒充玩家要求",
        ));
    }
    let item = found[0];
    let expected = match kind {"player_setting"=>"setting","local_custom"=>"local_custom",_=>"choice"};
    let declaration = if item["kind"]=="request" && item["explicit"]!=true {
        // The model identifies the intended branch; native code verifies the
        // exact player's words and concrete spans, not their interpretation.
        // A generic permission to edit is not a statement of a new fact.
        let declared=&reference["declaration"];
        let subject=short(declared,"subject",300)?;
        let value=short(declared,"value",1200)?;
        let scope=short(declared,"scope",600)?;
        let generic=["修改","更新","改写","整理","补充","核实","修复","参考","原著","按原著","正确","正确设定","设定","人物","身份","关系","剧情","资料","规则","内容","一切","全部","所有内容"];
        if !quoted.contains(&subject)||!quoted.contains(&value)||subject==value||generic.contains(&value.as_str()) {
            return Err(invalid("具体本局分支须用玩家原句中的对象和具体值；允许修改、更新设定或按原著纠错不证明新事实"));
        }
        if kind=="local_custom" && (!quoted.contains(&scope)||!["自行补全","自行设定","自行补充","自己补充","自定","自由发挥","自由创作","合理补全","合理补充"].iter().any(|word|value.contains(word))) {
            return Err(invalid("本局自定须引用玩家明确允许自行补全的原句及其适用范围，普通编辑授权不扩大为自由编造原著"));
        }
        Some(json!({"subject":subject,"value":value,"scope":scope,"classifiedBy":"assistant","interpretationVerified":false}))
    }else{None};
    if declaration.is_none() && (item["kind"] != expected || item["explicit"] != true) {
        return Err(invalid(
            "该句仅是任务要求或编辑授权，不能证明具体设定，也不能证明玩家行动已经成功",
        ));
    }
    if item
        .get("worldVersion")
        .is_some_and(|version| version != &constraints["worldVersion"])
        || item.get("intentRevision").is_some_and(|revision| {
            revision.as_i64().is_none_or(|revision| {
                revision < 0 || Some(revision) > constraints["intentRevision"].as_i64()
            })
        })
        || !text(item, "text").contains(quoted)
    {
        return Err(invalid("玩家原句、版本或适用要求与本次任务不符"));
    }
    Ok(
        json!({"playerReferenceId":item["id"],"quote":quoted,"kind":expected,"scope":declaration.as_ref().map(|v|v["scope"].clone()).unwrap_or_else(||item["scope"].clone()),"declaration":declaration,"nodeId":item["nodeId"],"field":item["field"],"worldVersion":constraints["worldVersion"],"intentRevision":constraints["intentRevision"],"fromStoredPlayerInput":true,"actionSuccessVerified":false,"interpretationVerified":false}),
    )
}

/// Report shape: {worldVersion,intentRevision,goals:[{id,status,summary,
/// requiresCanon?,scope?}],findings:[{id,goalId,topic,claim,basis,resources:
/// [{groupId,fingerprint,afterFingerprint}],references:[...]}]}.
/// Envelope/identity errors reject the report. Invalid individual evidence is
/// retained as a rejected finding; that resource's whole atomic set is then
/// excluded from validSelections, allowing unrelated validated work to remain.
pub(crate) fn validate_report(
    workspace: &Value,
    evidence_pages: &Value,
    report: &Value,
    task_constraints: &Value,
) -> Result<Value> {
    let world = text(task_constraints, "worldVersion");
    let intent = task_constraints["intentRevision"]
        .as_i64()
        .filter(|value| *value >= 0);
    if world.is_empty() || intent.is_none() {
        return Err(invalid("核对缺少程序提供的故事版本或要求版本"));
    }
    if report["worldVersion"] != world || report["intentRevision"].as_i64() != intent {
        return Err(invalid(
            "核对报告属于旧故事或旧要求，请重新读取当前草稿后核对",
        ));
    }
    let pages = array(evidence_pages, "evidenceLedger", 32768)?;
    let groups_value = pi_verification::resource_groups(workspace)?;
    let groups = groups_value
        .as_array()
        .expect("resource_groups returns array");
    let by_group = groups
        .iter()
        .map(|group| (text(group, "groupId").to_owned(), group))
        .collect::<BTreeMap<_, _>>();
    let goals = array(&report["goals"], "goals", 64)?;
    if goals.is_empty() {
        return Err(invalid("请提供本次实际目标及其结果"));
    }
    let mut by_goal = BTreeMap::new();
    for goal in goals {
        let id = short(goal, "id", 128)?;
        short(goal, "summary", 2400)?;
        if !["completed", "partial", "blocked", "no_change"].contains(&text(goal, "status"))
            || goal
                .get("requiresCanon")
                .is_some_and(|value| !value.is_boolean())
            || goal.get("scope").is_some_and(|value| {
                !["canon", "mechanical", "style", "local"].contains(&value.as_str().unwrap_or(""))
            })
            || by_goal.insert(id, goal).is_some()
        {
            return Err(invalid("目标状态、范围无效或标识重复"));
        }
    }
    let findings = array(&report["findings"], "findings", 256)?;
    let mut ids = BTreeSet::new();
    let mut covered = BTreeSet::new();
    let mut blocked_groups = BTreeSet::new();
    let mut group_goals: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    let mut goal_findings: BTreeMap<String, Vec<(bool, String)>> = BTreeMap::new();
    let mut normalized = vec![];
    let mut unresolved = vec![];
    for finding in findings {
        let id = short(finding, "id", 128)?;
        if !ids.insert(id.clone()) {
            return Err(invalid("核对项标识不能重复"));
        }
        let goal_id = short(finding, "goalId", 128)?;
        let Some(goal) = by_goal.get(&goal_id) else {
            return Err(invalid("核对项引用了不存在的目标"));
        };
        let topic = short(finding, "topic", 300)?;
        let claim = short(finding, "claim", 2400)?;
        let basis = text(finding, "basis");
        if ![
            "original",
            "player_setting",
            "player_choice",
            "local_custom",
            "local_consistency",
            "external",
            "insufficient",
        ]
        .contains(&basis)
        {
            return Err(invalid("核对依据类型无效"));
        }
        let requires_canon = goal["requiresCanon"]
            .as_bool()
            .unwrap_or(task_constraints["requiresCanon"] == true);
        let resources = array(&finding["resources"], "resources", 1024)?;
        let mut resource_ids = BTreeSet::new();
        let mut errors = vec![];
        let mut normalized_resources = vec![];
        for resource in resources {
            let group_id = text(resource, "groupId");
            let Some(group) = by_group.get(group_id) else {
                errors.push(
                    "该资源组不在当前草稿中，请重新读取check_draft.resourceGroups".to_owned(),
                );
                continue;
            };
            if !resource_ids.insert(group_id.to_owned()) {
                errors.push("同一核对项不能重复列出相同资源组".into());
            }
            group_goals
                .entry(group_id.into())
                .or_default()
                .insert(goal_id.clone());
            if resource["fingerprint"] != group["fingerprint"]
                || resource["afterFingerprint"] != group["afterFingerprint"]
                || resource
                    .get("originalFingerprint")
                    .is_some_and(|value| value != &group["originalFingerprint"])
                || resource.as_object().is_none_or(|object| {
                    object.keys().any(|key| {
                        ![
                            "groupId",
                            "fingerprint",
                            "afterFingerprint",
                            "originalFingerprint",
                            "collection",
                            "kind",
                            "id",
                            "routeId",
                            "callIds",
                            "atomicSetId",
                            "atomicSetSize",
                        ]
                        .contains(&key.as_str())
                    })
                })
            {
                errors.push(format!(
                    "资源{group_id}的完整原稿、改稿、调用归属已变化；不能按字段或callId选择"
                ));
            }
            normalized_resources.push(selection(group));
        }
        let references = array(&finding["references"], "references", 12)?;
        let mut citations = vec![];
        match basis {
            "original" | "local_consistency" | "external" => {
                if basis == "original" && references.is_empty() {
                    errors.push("本项原著结论没有精确原文依据".into());
                }
                for reference in references {
                    match citation(reference, pages, task_constraints, if basis=="local_consistency"{"world"}else{basis}) {
                        Ok(value) => citations.push(value),
                        Err(error) => errors.push(error.to_string()),
                    }
                }
                if basis == "external" && requires_canon {errors.push("网页或普通资料文件只证明外部来源说法，不能完成原著查证；请读取已导入原著或记录资料不足".into());}
                if basis == "local_consistency" && requires_canon {
                    errors.push("仅核对本局一致性，尚不能完成该原著核对目标".into());
                }
                if basis == "local_consistency"
                    && task_constraints["requiresCanon"] == true
                    && resource_ids.iter().any(|id| {
                        !task_constraints["mechanicalGroupIds"]
                            .as_array()
                            .into_iter()
                            .flatten()
                            .any(|allowed| allowed == id)
                    })
                {
                    errors.push("该资源包含程序未确认可豁免原著查证的实际差异；不能仅凭非原著目标、机械或文风标签采用人物和设定事实修改".into());
                }
            }
            "player_setting" | "player_choice" => {
                if references.is_empty() {
                    errors.push("玩家分支没有明确玩家原句".into());
                }
                for reference in references {
                    match player_reference(reference, task_constraints, basis) {
                        Ok(value) => citations.push(value),
                        Err(error) => errors.push(error.to_string()),
                    }
                }
            }
            "local_custom" => {
                if references.is_empty() {
                    errors.push(
                        "本局自定资料须附玩家允许补全的原句，编辑授权不能当作具体事实依据"
                            .into(),
                    );
                }
                for reference in references {
                    match player_reference(reference,task_constraints,"local_custom") {
                        Ok(value)=>citations.push(value),Err(error)=>errors.push(error.to_string()),
                    }
                }
            }
            "insufficient" => errors.push(claim.clone()),
            _ => unreachable!(),
        }
        if task_constraints["factContract"]==2 && !resources.is_empty() && basis=="original" {
            if short(finding,"sourceClaim",2400).is_err(){errors.push("请将来源实际说法写入sourceClaim，与本局修订决定分开".into());}
            let decision=&finding["revisionDecision"];
            if short(decision,"summary",2400).is_err()||short(decision,"reason",2400).is_err()||!["world_rule","identity_fact","local_event"].contains(&text(decision,"appliesTo")){errors.push("revisionDecision须分别说明本局具体改动、理由和appliesTo（world_rule/identity_fact/local_event），不能把原著规则直接记成本局已发生事件".into());}
            if text(decision,"appliesTo")=="local_event" {
                let supporting=array(&decision["localReferences"],"localReferences",12).unwrap_or(&[]);
                if supporting.is_empty(){errors.push("修订本局发生的事件还需要本局正式原句或明确玩家设定，原著规则不能证明本局已经发生".into());}
                for reference in supporting {
                    let checked=if reference["playerReferenceId"].is_string(){player_reference(reference,task_constraints,"player_setting")}else{citation(reference,pages,task_constraints,"world")};
                    match checked {Ok(value)=>citations.push(value),Err(e)=>errors.push(e.to_string())}
                }
            }
        }
        let eligible = errors.is_empty();
        covered.extend(resource_ids.iter().cloned());
        if !eligible {
            blocked_groups.extend(resource_ids.iter().cloned());
        }
        goal_findings
            .entry(goal_id.clone())
            .or_default()
            .push((eligible, id.clone()));
        for reason in &errors {
            unresolved.push(json!({"goalId":goal_id,"findingId":id,"resourceGroupIds":resource_ids,"reason":reason}));
        }
        normalized.push(json!({"id":id,"goalId":goal_id,"topic":topic,"claim":claim,"basis":basis,"resources":normalized_resources,"references":citations,"requiresCanon":requires_canon,"eligibleForAdoption":eligible,"errors":errors,"sourceLocationVerified":!citations.is_empty(),"interpretationVerified":false,"localCustom":basis=="local_custom","sourceClaim":finding["sourceClaim"],"revisionDecision":finding["revisionDecision"]}));
    }
    // A requested canon task cannot turn every goal into a mechanical goal to
    // bypass actual original-reading. Mixed tasks may retain separate clock
    // or style goals while at least one original goal remains accountable.
    if task_constraints["requiresCanon"] == true
        && !goals
            .iter()
            .any(|goal| goal["requiresCanon"].as_bool().unwrap_or(true))
    {
        return Err(invalid(
            "本次明确要求核对原著，至少保留一个原著核对目标，不能把全部目标改成非原著范围",
        ));
    }
    for group in groups {
        let id = text(group, "groupId");
        if !covered.contains(id) {
            blocked_groups.insert(id.to_owned());
            unresolved.push(json!({"resourceGroupIds":[id],"reason":"该完整资源尚无核对结论，不能随其他已核对资源采用"}));
        }
    }
    let blocked_sets = groups
        .iter()
        .filter(|group| blocked_groups.contains(text(group, "groupId")))
        .map(|group| text(group, "atomicSetId").to_owned())
        .collect::<BTreeSet<_>>();
    for group in groups {
        if blocked_sets.contains(text(group, "atomicSetId"))
            && blocked_groups.insert(text(group, "groupId").into())
        {
            unresolved.push(json!({"resourceGroupIds":[group["groupId"]],"reason":"该资源与未核实修改处于同一状态/回放/路线依赖组，必须一同核对，不能拆开采用"}));
        }
    }
    for finding in &mut normalized {
        // Evidence may match while another finding or dependent resource is
        // unresolved. Distinguish that from eligibility of the actual batch.
        finding["checksMatched"] = finding["eligibleForAdoption"].clone();
        if finding["resources"]
            .as_array()
            .into_iter()
            .flatten()
            .any(|resource| blocked_groups.contains(text(resource, "groupId")))
        {
            finding["eligibleForAdoption"] = false.into();
        }
    }
    let valid = groups
        .iter()
        .filter(|group| !blocked_groups.contains(text(group, "groupId")))
        .map(selection)
        .collect::<Vec<_>>();
    // Enforce the same whole-resource/atomic-set rules used by the native
    // adoption selector. This is not an adoption call or a semantic proof.
    pi_verification::select_verified_workspace(workspace, &json!(valid))?;
    let mut normalized_goals = vec![];
    let mut unresolved_goals = vec![];
    for goal in goals {
        let id = text(goal, "id");
        let checks = goal_findings.get(id).cloned().unwrap_or_default();
        let related = group_goals
            .iter()
            .filter(|(_, owners)| owners.contains(id))
            .map(|(group, _)| group.clone())
            .collect::<Vec<_>>();
        let good = checks.iter().filter(|(eligible, _)| *eligible).count();
        let bad = checks.len() - good;
        let requires_canon = goal["requiresCanon"]
            .as_bool()
            .unwrap_or(task_constraints["requiresCanon"] == true);
        let missing_original = requires_canon
            && !normalized.iter().any(|finding| {
                finding["goalId"] == id
                    && finding["eligibleForAdoption"] == true
                    && [
                        "original",
                        "player_setting",
                        "player_choice",
                        "local_custom",
                    ]
                    .contains(&text(finding, "basis"))
            });
        let blocked_resource = related.iter().any(|group| blocked_groups.contains(group));
        let declared = text(goal, "status");
        let missing_no_change = declared == "no_change" && !related.is_empty();
        let state = if declared == "blocked"
            || declared == "partial"
            || bad > 0
            || missing_original
            || blocked_resource
            || missing_no_change
        {
            if good > 0 || related.iter().any(|group| !blocked_groups.contains(group)) {
                "partial"
            } else {
                "blocked"
            }
        } else {
            declared
        };
        let value = json!({"id":id,"status":state,"declaredStatus":declared,"summary":goal["summary"],"scope":goal["scope"],"requiresCanon":requires_canon,"resourceGroupIds":related,"findingIds":checks.iter().map(|(_, id)|id).collect::<Vec<_>>(),"interpretationVerified":false});
        if ["partial", "blocked"].contains(&state) {
            unresolved_goals.push(value.clone());
        }
        normalized_goals.push(value);
    }
    let status = if unresolved_goals.is_empty() && blocked_groups.is_empty() {
        "completed"
    } else if !valid.is_empty()
        || normalized_goals
            .iter()
            .any(|goal| ["completed", "no_change"].contains(&text(goal, "status")))
    {
        "partial"
    } else {
        "blocked"
    };
    Ok(
        json!({"verificationVersion":1,"worldVersion":world,"intentRevision":intent,"workspaceFingerprint":crate::pi_store::arguments_hash(workspace),"status":status,"validSelections":valid,"unresolvedGroupIds":blocked_groups,"normalizedFindings":normalized,"goals":normalized_goals,"unresolvedGoals":unresolved_goals,"unresolved":unresolved,"sourceLocationVerified":normalized.iter().any(|finding|finding["sourceLocationVerified"]==true),"interpretationVerified":false,"requiresStoryValidation":!valid.is_empty(),"message":"程序只核对原句、出处、送达版本及完整资源范围；引文是否支持具体结论、是否尊重玩家分支仍由模型核对。正式采用后还需读取提交回执与状态。"}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn workspace() -> Value {
        json!({"edits":[{"kind":"pin","id":"p","original":{"text":"旧"},"after":{"text":"五年一届"},"callIds":["edit-p"]},{"kind":"chapter","id":"c","original":{"summary":"旧"},"after":{"summary":"尚未核实"},"callIds":["edit-c"]}]})
    }
    fn constraints() -> Value {
        json!({"worldVersion":"v1","intentRevision":2,"requiresCanon":true,"allowLocalCustom":false,"playerReferences":[]})
    }
    fn pages() -> Value {
        let body = "😀玄老明确说，五年后你们将参加下一届大赛。";
        json!([{"id":"e1","callId":"read-1","actorId":"","sourceTool":"read_original","sourceKind":"original","deliveryConfirmed":true,"confirmedIntentRevision":2,"worldVersion":"v1","snapshot":{"worldVersion":"v1"},"sourceLocationVerified":true,"quote":body,"start":20,"end":20+body.encode_utf16().count(),"offsetUnit":"utf16","location":{"bookId":"b","section":2,"chunk":3,"title":"真正章名","page":7,"path":"/excerpts/0/text","offset":20}}])
    }
    fn finding(w: &Value, group: usize) -> Value {
        let g = pi_verification::resource_groups(w).unwrap();
        json!({"id":format!("f{group}"),"goalId":format!("g{group}"),"topic":"赛事周期","claim":"应为五年周期","basis":"original","resources":[selection(&g[group])],"references":[{"evidenceId":"e1","quote":"五年后你们将参加下一届大赛","location":pages()[0]["location"],"quoteOffset":28}]})
    }
    fn report(w: &Value) -> Value {
        json!({"worldVersion":"v1","intentRevision":2,"goals":[{"id":"g0","status":"completed","summary":"核对赛事"},{"id":"g1","status":"blocked","summary":"另一项资料不足"}],"findings":[finding(w,0),{"id":"f1","goalId":"g1","topic":"身份","claim":"当前资料没有足够身份依据","basis":"insufficient","resources":[selection(&pi_verification::resource_groups(w).unwrap()[1])],"references":[]}]})
    }
    #[test]
    fn partial_report_keeps_verified_whole_resources_and_exact_native_coordinates() {
        let w = workspace();
        let value = validate_report(&w, &pages(), &report(&w), &constraints()).unwrap();
        assert_eq!(value["status"], "partial");
        assert_eq!(value["validSelections"].as_array().unwrap().len(), 1);
        assert_eq!(
            value["normalizedFindings"][0]["references"][0]["quoteOffset"],
            28
        );
        assert_eq!(
            value["normalizedFindings"][0]["references"][0]["location"]["title"],
            "真正章名"
        );
        assert_eq!(
            value["normalizedFindings"][0]["interpretationVerified"],
            false
        );
        assert_eq!(value["unresolvedGoals"].as_array().unwrap().len(), 1);
    }
    #[test]
    fn canon_rule_and_a_local_event_require_distinct_revision_evidence_in_new_tasks(){
        let w=workspace();let mut limits=constraints();limits["factContract"]=2.into();let mut r=report(&w);
        r["findings"][0]["sourceClaim"]="原文给出赛事周期".into();
        r["findings"][0]["revisionDecision"]=json!({"summary":"让主角已参加这届大赛","reason":"原著存在这项赛事","appliesTo":"local_event","localReferences":[]});
        let rejected=validate_report(&w,&pages(),&r,&limits).unwrap();assert_eq!(rejected["normalizedFindings"][0]["eligibleForAdoption"],false);
        r["findings"][0]["revisionDecision"]=json!({"summary":"修正资料中的赛事周期","reason":"规则卡当前周期与已读原文冲突","appliesTo":"world_rule"});
        let allowed=validate_report(&w,&pages(),&r,&limits).unwrap();assert_eq!(allowed["normalizedFindings"][0]["eligibleForAdoption"],true);assert_eq!(allowed["normalizedFindings"][0]["revisionDecision"]["appliesTo"],"world_rule");
    }
    #[test]
    fn tool_success_snippets_drafts_old_intent_and_wrong_book_do_not_verify_original() {
        let w = workspace();
        let r = report(&w);
        for change in [
            json!({"deliveryConfirmed":false}),
            json!({"sourceKind":"snippet"}),
            json!({"sourceKind":"draft"}),
            json!({"confirmedIntentRevision":1}),
            json!({"worldVersion":"v0"}),
            json!({"sourceLocationVerified":false}),
        ] {
            let mut p = pages();
            for (key, value) in change.as_object().unwrap() {
                p[0][key] = value.clone();
            }
            let out = validate_report(&w, &p, &r, &constraints()).unwrap();
            assert!(
                out["validSelections"].as_array().unwrap().is_empty(),
                "rejected {change}"
            );
        }
        let mut bad = r.clone();
        bad["findings"][0]["references"][0]["location"]["bookId"] = "other".into();
        assert!(
            validate_report(&w, &pages(), &bad, &constraints()).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut bad = r.clone();
        bad["findings"][0]["references"][0]["quoteOffset"] = 27.into();
        assert!(
            validate_report(&w, &pages(), &bad, &constraints()).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .is_empty()
        );
    }
    #[test]
    fn changed_after_and_half_atomic_set_cannot_use_an_old_valid_finding() {
        let mut w = workspace();
        let old = report(&w);
        w["edits"][0]["after"]["text"] = "又加未核实身份".into();
        assert!(
            validate_report(&w, &pages(), &old, &constraints()).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut linked = workspace();
        linked["edits"][0]["kind"] = "people".into();
        linked["edits"][1]["kind"] = "state".into();
        let out = validate_report(&linked, &pages(), &report(&linked), &constraints()).unwrap();
        assert!(
            out["validSelections"].as_array().unwrap().is_empty(),
            "state and people cannot be partially adopted"
        );
        assert_eq!(out["unresolvedGroupIds"].as_array().unwrap().len(), 2);
    }
    #[test]
    fn generic_authorization_is_not_a_specific_player_setting_and_action_is_not_success() {
        let w = workspace();
        let mut r = report(&w);
        r["findings"][0]["basis"] = "player_setting".into();
        r["findings"][0]["references"] =
            json!([{"playerReferenceId":"p","quote":"请更新设定资料"}]);
        let mut c = constraints();
        c["playerReferences"] =
            json!([{"id":"p","text":"请更新设定资料","kind":"authorization","explicit":true}]);
        assert!(
            validate_report(&w, &pages(), &r, &c).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        c["playerReferences"][0] = json!({"id":"p","text":"我设定小兰在本局仍然活着。","kind":"setting","explicit":true,"scope":"本局"});
        r["findings"][0]["references"][0]["quote"] = "小兰在本局仍然活着".into();
        let out = validate_report(&w, &pages(), &r, &c).unwrap();
        assert_eq!(out["validSelections"].as_array().unwrap().len(), 1);
        assert_eq!(
            out["normalizedFindings"][0]["references"][0]["actionSuccessVerified"],
            false
        );
        r["findings"][0]["basis"] = "player_choice".into();
        assert!(
            validate_report(&w, &pages(), &r, &c).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .is_empty(),
            "a setting reference is not an action"
        );
    }
    #[test]
    fn ordinary_style_and_time_goals_need_no_canon_checklist_but_cannot_erase_a_canon_goal() {
        let w = workspace();
        let mut c = constraints();
        c["requiresCanon"] = false.into();
        let mut r = report(&w);
        r["goals"][0]["scope"] = "mechanical".into();
        r["findings"][0]["basis"] = "local_consistency".into();
        r["findings"][0]["references"] = json!([]);
        assert_eq!(
            validate_report(&w, &json!([]), &r, &c).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        c["requiresCanon"] = true.into();
        r["goals"][0]["requiresCanon"] = false.into();
        r["goals"][1]["requiresCanon"] = false.into();
        assert!(validate_report(&w, &pages(), &r, &c).is_err());
        r["goals"][1]["requiresCanon"] = true.into();
        assert!(
            validate_report(&w, &pages(), &r, &c).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .is_empty(),
            "a model's mechanical label is not a native diff grant"
        );
        c["mechanicalGroupIds"] =
            json!([pi_verification::resource_groups(&w).unwrap()[0]["groupId"]]);
        assert_eq!(
            validate_report(&w, &pages(), &r, &c).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }
    #[test]
    fn mechanical_labels_cannot_downgrade_factual_resources_without_native_diff_grant() {
        let mut w = workspace();
        w["edits"].as_array_mut().unwrap().truncate(1);
        w["edits"][0]["kind"] = "people".into();
        w["edits"][0]["after"] =
            json!([{"id":"person","name":"旅人","identity":"模型未经原著核实的新身份"}]);
        let groups = pi_verification::resource_groups(&w).unwrap();
        let r = json!({"worldVersion":"v1","intentRevision":2,"mechanicalGroupIds":[groups[0]["groupId"]],"goals":[{"id":"edit","status":"completed","summary":"把事实修改冒称机械任务","requiresCanon":false,"scope":"mechanical"},{"id":"canon","status":"blocked","summary":"另留空原著目标以逃过全非canon检查","requiresCanon":true,"scope":"canon"}],"findings":[{"id":"change","goalId":"edit","topic":"人物身份","claim":"只作机械整理","basis":"local_consistency","resources":groups,"references":[]},{"id":"unread","goalId":"canon","topic":"未读原著","claim":"没有读取任何原著正文","basis":"insufficient","resources":[],"references":[]}]});
        let out = validate_report(&w, &json!([]), &r, &constraints()).unwrap();
        assert!(out["validSelections"].as_array().unwrap().is_empty());
        assert_eq!(out["normalizedFindings"][0]["eligibleForAdoption"], false);
        assert!(out["normalizedFindings"][0]["errors"]
            .as_array()
            .unwrap()
            .iter()
            .any(|value| value.as_str().unwrap().contains("程序未确认")));
    }
    #[test]
    fn readonly_verification_does_not_create_a_story_edit_and_local_custom_requires_authorization()
    {
        let w = json!({});
        let mut f = finding(&workspace(), 0);
        f["resources"] = json!([]);
        let r = json!({"worldVersion":"v1","intentRevision":2,"goals":[{"id":"g0","status":"no_change","summary":"查清赛事，无需改动"}],"findings":[f]});
        let out = validate_report(&w, &pages(), &r, &constraints()).unwrap();
        assert_eq!(out["status"], "completed");
        assert_eq!(out["requiresStoryValidation"], false);
        let w = workspace();
        let mut r = report(&w);
        r["findings"][0]["basis"] = "local_custom".into();
        r["findings"][0]["references"] = json!([]);
        assert!(
            validate_report(&w, &pages(), &r, &constraints()).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .is_empty()
        );
        let mut c = constraints();
        c["allowLocalCustom"] = true.into();
        // A global boolean is not a per-finding authorization. Cite the
        // actual player's scope and explicit permission to fill that scope.
        assert!(validate_report(&w,&pages(),&r,&c).unwrap()["validSelections"].as_array().unwrap().is_empty());
        c["playerReferences"]=json!([{"id":"allow","text":"缺少门派资料时可以自行补全门派背景。","kind":"request","explicit":false}]);
        r["findings"][0]["references"]=json!([{"playerReferenceId":"allow","quote":"缺少门派资料时可以自行补全门派背景。","declaration":{"subject":"门派","value":"自行补全","scope":"门派背景"}}]);
        assert_eq!(
            validate_report(&w, &pages(), &r, &c).unwrap()["validSelections"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
    }

    #[test]
    fn explicit_task_branch_uses_real_spans_and_generic_authorization_is_not_a_fact() {
        let w=workspace();let mut c=constraints();let mut r=report(&w);
        c["playerReferences"]=json!([{"id":"task:request","text":"我设定阿兰在本局仍然活着，其余遵循原著。","kind":"request","explicit":false}]);
        r["findings"][0]["basis"]="player_setting".into();
        r["findings"][0]["references"]=json!([{"playerReferenceId":"task:request","quote":"我设定阿兰在本局仍然活着","declaration":{"subject":"阿兰","value":"仍然活着","scope":"本局"}}]);
        let out=validate_report(&w,&json!([]),&r,&c).unwrap();
        assert_eq!(out["validSelections"].as_array().unwrap().len(),1);
        assert_eq!(out["normalizedFindings"][0]["references"][0]["fromStoredPlayerInput"],true);
        assert_eq!(out["normalizedFindings"][0]["references"][0]["interpretationVerified"],false);
        for (quote,subject,value) in [("更新人物设定资料","人物","更新"),("我设定阿兰在本局仍然活着","阿兰","原著隐藏的能力")] {
            c["playerReferences"][0]["text"]=quote.into();
            r["findings"][0]["references"][0]["quote"]=quote.into();
            r["findings"][0]["references"][0]["declaration"]=json!({"subject":subject,"value":value,"scope":"本局"});
            assert!(validate_report(&w,&json!([]),&r,&c).unwrap()["validSelections"].as_array().unwrap().is_empty());
        }
        r["findings"][0]["references"][0]["playerReferenceId"]="assistant-invented".into();
        assert!(validate_report(&w,&json!([]),&r,&c).unwrap()["validSelections"].as_array().unwrap().is_empty());
    }

    #[test]
    fn accepts_actual_native_capture_and_receipt_shape_only_after_successful_delivery() {
        use crate::{pi_budget, pi_evidence, pi_receipts, pi_store::PiCallRequest, RunPlan};
        use rusqlite::{params, Connection};
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE worlds(id TEXT PRIMARY KEY);INSERT INTO worlds VALUES('w');",
        )
        .unwrap();
        db.execute_batch(include_str!("pi_schema.sql")).unwrap();
        db.execute_batch("INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('s','w','l','隔离原著形状检查','test','test');").unwrap();
        db.execute_batch("CREATE TABLE source_books(id TEXT PRIMARY KEY);CREATE TABLE source_sections(book_id TEXT,section INTEGER,title TEXT,page INTEGER);CREATE TABLE source_chunks(book_id TEXT,ordinal INTEGER,section INTEGER,text TEXT);INSERT INTO source_books VALUES('b');INSERT INTO source_sections VALUES('b',0,'真实第一章',7);INSERT INTO pi_tasks(id,session_id,world_id,line_id,text,status,policy,base_json,base_world_version,intent_revision,consumed_intent_revision,created_at,updated_at) VALUES('t','s','w','l','核对原著','running','auto','{}','v1',2,2,'test','test');INSERT INTO pi_calls(task_id,call_id,tool,args_hash,world_version,intent_revision,external_write,status,output_json,created_at,updated_at) VALUES('t','read','read_original','h','v1',2,0,'done','{}','test','test');").unwrap();
        let body = "😀玄老明确说，五年后你们将参加下一届大赛。";
        db.execute("INSERT INTO source_chunks VALUES('b',0,0,?)", [body])
            .unwrap();
        let plan: RunPlan = serde_json::from_value(json!({"id":"t","worldId":"w","lineId":"l","headId":"n","kind":"pi_task","model":{"slot":"","url":"","model":"","includeUsage":false},"messages":[],"extractMessages":[],"state":{},"settings":{},"options":{},"action":{},"meta":{"agent":{"referenceScope":{"bookId":"b","through":0}}}})).unwrap();
        let task = json!({"id":"t","world_id":"w","line_id":"l","base_world_version":"v1","intent_revision":2,"consumed_intent_revision":2});
        let delivered = json!({"ok":true,"data":{"bookId":"b","through":0,"status":"ready","excerpts":[{"kind":"original","bookId":"b","section":0,"chunk":0,"title":"真实第一章","page":7,"start":0,"end":body.encode_utf16().count(),"text":body}]}});
        db.execute(
            "UPDATE pi_calls SET output_json=? WHERE task_id='t' AND call_id='read'",
            params![delivered.to_string()],
        )
        .unwrap();
        let request = PiCallRequest {
            task_id: "t".into(),
            call_id: "read".into(),
            tool: "read_original".into(),
            args: json!({"section":0}),
            intent_revision: 2,
            world_version: "v1".into(),
            external_write: false,
        };
        let candidate = pi_evidence::capture(&db, &task, &plan, &request, &delivered, "")
            .unwrap()
            .unwrap();
        let tx = db.transaction().unwrap();
        pi_receipts::save(&tx, &task, "read", "", &candidate).unwrap();
        pi_budget::reserve_model(&tx, "t", "model", "model", &json!({})).unwrap();
        pi_receipts::admit(
            &tx,
            &task,
            "model",
            "",
            &json!([{"callId":"read","tool":"read_original","hash":candidate["deliveryHash"]}]),
            "model",
        )
        .unwrap();
        tx.commit().unwrap();
        assert!(pi_receipts::pages(&db, &task)
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        let tx = db.transaction().unwrap();
        pi_budget::finish_model(
            &tx,
            "t",
            "model",
            &json!({"input":10,"output":2}),
            "success",
        )
        .unwrap();
        pi_receipts::confirm(&tx, "t", "model", true).unwrap();
        tx.commit().unwrap();
        let actual_pages = pi_receipts::pages(&db, &task).unwrap();
        let w = workspace();
        let mut r = report(&w);
        r["findings"][0]["references"][0]["evidenceId"] = actual_pages[0]["id"].clone();
        r["findings"][0]["references"][0]["location"] = actual_pages[0]["location"].clone();
        r["findings"][0]["references"][0]["quoteOffset"] = 8.into();
        let normalized = validate_report(&w, &actual_pages, &r, &constraints()).unwrap();
        assert_eq!(normalized["validSelections"].as_array().unwrap().len(), 1);
        assert_eq!(
            normalized["normalizedFindings"][0]["references"][0]["quoteOffset"],
            8
        );
        assert_eq!(
            normalized["normalizedFindings"][0]["references"][0]["location"]["title"],
            "真实第一章"
        );
    }
}
