//! 原著核对: the deep tier's checked rewrite and the standard tier's lite check
//! (reference-review-2 and reference-review-lite-4, D161, D162).
use super::*;

impl Engine {
    /// One helper-model request, with evidence, text and record validated together.
    /// It lists sentences that contradict the supplied original; each fix is
    /// applied locally only where its quote occurs exactly once. Anything that
    /// goes wrong keeps the passage as written: the check never stops a turn.
    pub(super) async fn review_reference_lite(self:&Arc<Self>, shared:&Shared, plan:&RunPlan, narrative:&str, record:&Value)->Result<(String,Value,Value)>{
        self.emit_run_event(plan,json!({"type":"organizing","phase":"reference-review"}))?;
        let cap=plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize;
        let extra_passages = shared.lock().map_err(|_| Error::Cancelled)?.draft["originalPassages"].as_array().cloned().unwrap_or_default();
        let passages = lite_review_passages(plan, &extra_passages, cap);
        let mut messages=lite_review_messages_with(plan, &passages, narrative);
        if let Some(message)=messages.last_mut() {
            message["content"]=format!("{}\n【本回合记录】\n{}",message["content"].as_str().unwrap_or(""),record).into();
        }
        let result=match self.complete(shared,"reference-review-lite",messages,vec![],true).await {
            Ok(result)=>result,
            Err(error@(Error::Cancelled|Error::Stale))=>return Err(error),
            Err(error)=>return Ok((narrative.to_owned(),record.clone(),json!({"version":"reference-review-lite-4","status":"skipped","reason":error.to_string()}))),
        };
        // Do not repair truncated JSON into an executable record patch.
        let text=result.text.trim();
        let body=text.strip_prefix("```json").or_else(||text.strip_prefix("```")).and_then(|s|s.strip_suffix("```")).unwrap_or(text).trim();
        let raw_issues=serde_json::from_str::<Value>(body).map(|v|v["issues"].clone()).unwrap_or(Value::Null);
        let Some(raw_list) = raw_issues.as_array() else {
            return Ok((narrative.to_owned(), record.clone(), json!({
                "version":"reference-review-lite-4","status":"skipped","issues":[],"skipped":0,
                "unresolved":["原著核对未返回完整的更正结果，已保留本段原稿和记录。"]
            })));
        };
        // Filter per issue so one unverified citation does not discard independently verified fixes.
        let mut verified_issues = Vec::new();
        let mut unverified = 0usize;
        for issue in raw_list.iter().take(5) {
            if has_lite_evidence(plan, &passages, issue) {
                verified_issues.push(issue.clone());
            } else {
                unverified += 1;
            }
        }
        let (revised,revised_record,applied,apply_skipped)=apply_lite_review(narrative,record,&Value::Array(verified_issues));
        let skipped = unverified + apply_skipped;
        let mut unresolved = Vec::new();
        if unverified > 0 {
            unresolved.push("部分更正没有对应到本次提供的原著原句，已跳过未核实的条目。");
        }
        if apply_skipped > 0 {
            unresolved.push("部分更正未能同时校准正文和回合记录，已跳过冲突条目；可使用“按原著纠错”进一步核对。");
        }
        Ok((revised,revised_record,json!({"version":"reference-review-lite-4","status":if skipped>0{"partial"}else{"reviewed"},"issues":applied,"skipped":skipped,"unresolved":unresolved})))
    }
    pub(super) async fn review_reference(self:&Arc<Self>, shared:&Shared, plan:&RunPlan, mcp:&BuiltinMcp, tools:&[Value], narrative:&str, record:&Value)->Result<Value>{
        let cap=plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize;
        let parts=crate::stage_context::parts(narrative,(cap/6).clamp(256,2400));
        let mut body=String::new();let mut current=record.clone();let mut findings=vec![];let mut unresolved=vec![];
        for (index,part) in parts.iter().enumerate(){
            self.check(shared)?;
            let reviewed=self.review_reference_part(shared,plan,mcp,tools,part,&current,index).await?;
            body.push_str(reviewed["narrative"].as_str().unwrap_or(part));current=reviewed["record"].clone();
            findings.extend(reviewed["report"]["findings"].as_array().cloned().unwrap_or_default());
            unresolved.extend(reviewed["report"]["unresolved"].as_array().cloned().unwrap_or_default());
        }
        Ok(json!({"narrative":body,"record":current,"report":{"version":"reference-review-2","parts":parts.len(),"findings":findings,"unresolved":unresolved,"status":if unresolved.is_empty(){"reviewed"}else{"partial"}}}))
    }
    async fn review_reference_part(self:&Arc<Self>, shared:&Shared, plan:&RunPlan, mcp:&BuiltinMcp, tools:&[Value], narrative:&str, record:&Value,part:usize)->Result<Value>{
        self.emit_run_event(plan,json!({"type":"organizing","phase":"reference-review"}))?;
        let compact=crate::stage_context::state(&plan.state,narrative,(plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize/10).min(1500)).to_string();
        let mut reference=plan.reference.clone().unwrap_or(Value::Null);
        let mut left=(plan.meta["budgetChars"].as_u64().unwrap_or(12000)/4) as usize;
        let mut evidence=vec![];
        for p in reference["passages"].as_array().into_iter().flatten().filter(|p|p["kind"]=="original") {let cost=p.to_string().encode_utf16().count();if cost<=left{left-=cost;evidence.push(p.clone());}}
        reference["passages"]=evidence.into();
        let mut messages=vec![json!({"role":"system","content":r#"核对尚未保存草稿中新引入的关键身份、关系、称谓、能力、物品、时间和事件。保留玩家明确分支，AI自行写错不算玩家改写。先用已提供原文，需要时批量定位具体主张，再read_original读原文与邻文，不扫描整本书。只纠正有依据的细节，不替玩家作决定，不补回已经改变的命运。缺少原文依据的具体值保留不确定性；确实影响当前关键情节且必须玩家决定时填写needsPlayer。最后只返回JSON：{"replacement":"完整核对后的本段正文","recordPatch":{仅受改稿影响的记录字段},"findings":[{"claim":"具体主张","status":"supported/branch/uncertain","playerFactId":"branch时对应的玩家事实ID","playerQuote":"当前是玩家写入正文时也可引用其准确原句；来源不明的旧事实标uncertain","citations":[{"bookId":"书籍ID","section":0,"chunk":0,"quote":"实际读到的原句"}]}],"unresolved":["资料不足"],"needsPlayer":"必要问题，可省略"}。没有新关键事实时findings可为空；核对说明不进入正文。"#}),json!({"role":"user","content":format!("【玩家行动】{}\n【原著用法】{}\n【当前必要事实】{}\n【玩家事实定位】{}\n【已提供原文】{}\n【待核对正文】{}\n【原回合记录】{}",plan.action,plan.reading_source(),compact,crate::stage_context::facts(&plan.state,narrative,(plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize/12).min(1400)),reference,narrative,record)})];
        for round in 0..2 {
            let final_round=round==1;
            messages.push(json!({"role":"system","content":if final_round {"这是本段核对的收尾请求，不再调用工具。根据实际已读材料输出完整JSON，保留玩家分支；不能核实的项目标uncertain并写入unresolved，不能把候选或推测当原著。确实必须玩家决定的关键矛盾填needsPlayer。不延长检索，不把无法核实说成已核实。".to_owned()} else {format!("本段核对第{}轮，最多再有{}轮查证，然后必须返回JSON结论。只检查草稿新引入的具体细节；复用当前已有原句，候选够用后read_original，不再次用相同人物名泛搜；互不依赖的问题同批查证。",round+1,1-round)}}));
            let review_tools=if final_round{vec![]}else{tools.iter().filter(|t|["read_original","prepare_reference_check","read_canon_facts","read_history","read_characters"].contains(&t["function"]["name"].as_str().unwrap_or(""))).cloned().collect()};
            let result=self.complete(shared,&format!("reference-review:{part}:{round}"),messages.clone(),review_tools,false).await?;
            if !result.tool_calls.is_empty(){
                messages.push(chat::assistant_message(&result));
                for call in &result.tool_calls {
                    let name=call["function"]["name"].as_str().unwrap_or("");
                    if !is_read_tool(name){return Err(Error::fail(crate::failure::FailKind::Review,"原著核对只允许读取与预演"));}
                    let args:Value=serde_json::from_str(call["function"]["arguments"].as_str().unwrap_or("{}"))
                        .map_err(|_| Error::fail(crate::failure::FailKind::Review, "原著核对的查阅参数不完整"))?;
                    let key=format!("reference-tool:{part}:{round}:{}",call["id"].as_str().unwrap_or(""));
                    let cached=self.store.lock()?.query_row("SELECT output_json FROM execution_steps WHERE run_id=? AND step_key=? AND status='done' AND kind=? AND input_json=?",params![plan.id,key,name,args.to_string()],|r|r.get::<_,String>(0)).optional()?;
                    let value=if let Some(cached)=cached {serde_json::from_str(&cached)?} else {
                        shared.lock().map_err(|_|Error::Cancelled)?.charge_tool()?; self.checkpoint(shared)?;
                        let output=mcp.call(name,&args).await?;
                        self.store.owned(plan, |tx| {
                            tx.execute("INSERT OR REPLACE INTO execution_steps(run_id,step_key,kind,status,input_json,output_json) VALUES(?,?,?,'done',?,?)",params![plan.id,key,name,args.to_string(),output.to_string()])?;
                            Ok(())
                        })?;
                        output
                    };
                    messages.push(json!({"role":"tool","tool_call_id":call["id"],"content":value.to_string()}));
                }
                continue;
            }
            let mut report=match rules::record::complete_json(&result.text){Some(report)=>report,None=>{
                if refused(&result,&result.text,false){return Err(Error::Refused("AI服务拒绝了这次原著核对，正文草稿已保留，原路线未改动。请检查服务提示或换用可用模型后继续。".into()));}
                if !final_round{messages.push(json!({"role":"assistant","content":result.text}));messages.push(json!({"role":"user","content":"请按要求返回完整JSON核对结果；资料不足标uncertain，不再展开查证。"}));continue;}
                return Err(Error::fail(crate::failure::FailKind::Review,"原著核对未返回完整结果，正文草稿已保留，可继续重试"));
            }};
            let provided=shared.lock().map_err(|_|Error::Cancelled)?.draft["originalPassages"].as_array().cloned().unwrap_or_default();
            if let Err(error)=crate::writing_context::validate_findings(&report,&provided,&plan.state,plan.reading_source(),&plan.action){
                if !final_round{messages.push(json!({"role":"assistant","content":result.text}));messages.push(json!({"role":"user","content":format!("核对格式或依据未通过：{}。保留有效结果，补查或标明uncertain；不要把不明来源旧状态当玩家分支。",error)}));continue;}
                // Unverified evidence does not become a protected branch or a
                // verified correction. Keep the untouched draft and surface each
                // missing basis; a local correction can perform deeper checking.
                if !report["findings"].is_array(){return Err(check_reply_error(error));}
                let mut unresolved=report["unresolved"].as_array().cloned().unwrap_or_default();
                for finding in report["findings"].as_array_mut().unwrap(){
                    if crate::writing_context::validate_findings(&json!({"findings":[finding.clone()]}),&provided,&plan.state,plan.reading_source(),&plan.action).is_err(){
                        unresolved.push(format!("{}：尚未取得有效原文或玩家分支依据",finding["claim"].as_str().unwrap_or("关键细节")).into());
                        finding["status"]="uncertain".into();finding["citations"]=json!([]);
                    }
                }
                report["unresolved"]=unresolved.into();report["replacement"]=narrative.into();report["recordPatch"]=json!({});
            }
            shared.lock().map_err(|_|Error::Cancelled)?.draft["referenceReview"]=report.clone(); self.checkpoint(shared)?;
            if let Some(question)=report["needsPlayer"].as_str().filter(|s|!s.trim().is_empty()){return Err(Error::fail(crate::failure::FailKind::Review,format!("这段关键情节还需确认：{question}")));}
            let mut local=plan.clone();local.meta["anchor"]=json!({"original":narrative});local.meta["correctionRange"]=json!({"start":0,"end":narrative.encode_utf16().count()});local.meta["originalRecord"]=record.clone();
            let revised=crate::writing_context::local_correction(&local,&report).map_err(check_reply_error)?;
            let mut issues=vec![];let record=rules::record::normalize_record(&revised["record"],&mut issues).ok_or_else(||Error::fail(crate::failure::FailKind::Review,"核对后的回合记录无效，草稿已保留"))?;
            if let Some(problem) = turn_record_problem(plan, &record) {
                return Err(Error::fail(crate::failure::FailKind::Review, format!("核对后的记录不完整：{problem}")));
            }
            return Ok(json!({"narrative":revised["narrative"],"record":record,"report":{"version":"reference-review-1","findings":report["findings"],"unresolved":report["unresolved"],"status":if report["unresolved"].as_array().is_some_and(|a|!a.is_empty()){"partial"}else{"reviewed"}}}));
        }
        Err(Error::fail(crate::failure::FailKind::Review,"关键细节仍需补查，草稿已保留；请缩小待查问题或补充必要线索"))
    }
}

/// The lite check's request: the passage, what the player asked, and the
/// original already supplied to the writer (about a fifth of the budget).
#[cfg(test)]
pub(super) fn lite_review_messages(plan:&RunPlan, narrative:&str, cap:usize)->Vec<Value>{
    let passages = lite_review_passages(plan, &[], cap);
    lite_review_messages_with(plan, &passages, narrative)
}

fn lite_review_messages_with(plan:&RunPlan, passages:&[&Value], narrative:&str)->Vec<Value>{
    let position=plan.reading_source()["position"].as_u64().unwrap_or(0);
    let evidence=passages.iter().copied().map(lite_evidence_line).collect::<String>();
    let notes=plan.reference.as_ref().and_then(|r|r["notes"].as_str()).unwrap_or("");
    let source=plan.reading_source();
    let usage=if source["plot"]=="canon"{"尽量沿原著剧情"}else{"同人，允许本局分支"};
    vec![
        json!({"role":"system","content":"你是原著校对。故事现在大约在原著的【当前位置】，那之后的情节还没有发生。
规则：
- 只找出正文里与下列原著资料明显矛盾、并且在当前位置时就已成立的具体细节：人名、称谓、身份、关系、能力、物品、地点。
- 不要拿后面章节才出现的人物、徒弟、身份或事件来“纠正”现在；玩家行动造成的改变、本局已有的分支和资料里没有的内容都不算错。拿不准就不改。
- 不改文风，不增删情节，不引入正文里没有的人物。
- 每个问题必须附原文引文（section 和 chunk 用下面原文标题显示的数字，quote 逐字照抄下面对应原著片段），不能引用正文或札记充当原文。
- recordPatch 只含受这句更正影响的回合记录字段，不受影响留空对象；数组字段提供更正后的完整列表并保留无关项目，对象字段只提供有变化的属性，不能改整局设定；按列出顺序修正记录，后项基于前项结果；正文和记录无法同步就不要提出这条更正。
最多 5 条；没有问题返回 {\"issues\":[]}。只返回 JSON，不要加代码块或额外说明：
{\"issues\":[{\"quote\":\"正文中有错的原句，逐字照抄\",\"problem\":\"与原著哪里不符\",\"fix\":\"改正后的这句\",\"citations\":[{\"section\":1,\"chunk\":1,\"quote\":\"下面对应原著片段中的原句，逐字照抄\"}],\"recordPatch\":{}}]}"}),
        json!({"role":"user","content":format!("【当前位置】原著第{}节前后\n【原著用法】{usage}；{}\n【玩家行动】{}\n【原著札记】{}\n【原著原文】（只含当前位置及之前不远的片段）{}\n【待校对正文】\n{narrative}",position+1,source["instructions"].as_str().unwrap_or(""),plan.action["text"].as_str().unwrap_or(""),if notes.is_empty(){"（无）"}else{notes},if evidence.is_empty(){"（本回合没有取到当前位置之前的原文）".to_owned()}else{evidence})}),
    ]
}

fn lite_review_passages<'a>(plan: &'a RunPlan, extra: &'a [Value], cap: usize) -> Vec<&'a Value> {
    let source = plan.reading_source();
    let position = source["position"].as_u64().unwrap_or(0);
    let through = source["through"].as_u64().unwrap_or(u64::MAX);
    let last = through.min(position.saturating_add(LITE_REVIEW_AHEAD));
    let mut left = cap / 5;
    let mut kept = Vec::new();
    let mut seen = std::collections::HashSet::new();
    // Combine pre-supplied passages and passages read via tools during writing (deduped).
    let combined = plan
        .reference
        .as_ref()
        .and_then(|r| r["passages"].as_array())
        .into_iter()
        .flatten()
        .chain(extra.iter());
    for passage in combined {
        let Some(section) = passage["section"].as_u64() else { continue; };
        let Some(chunk) = passage["chunk"].as_u64() else { continue; };
        let Some(text) = passage["text"].as_str().filter(|t| !t.trim().is_empty()) else { continue; };
        if passage["kind"] != "original" || section > last {
            continue;
        }
        if !seen.insert((section, chunk, text)) {
            continue;
        }
        let cost = lite_evidence_line(passage).encode_utf16().count();
        if cost > left { continue; }
        left -= cost;
        kept.push(passage);
    }
    kept
}

fn lite_evidence_line(passage: &Value) -> String {
    format!("\n[第{}节·{}·片段{}]\n{}\n",
        passage["section"].as_u64().unwrap_or(0).saturating_add(1),
        passage["title"].as_str().unwrap_or(""),
        passage["chunk"].as_u64().unwrap_or(0).saturating_add(1),
        passage["text"].as_str().unwrap_or(""))
}

fn normalize_quote_for_match(s: &str) -> String {
    s.chars()
        .filter(|c| !c.is_whitespace() && !"“”\"‘’'《》「」『』，。！？；：、,.!?;:-—…()（）[]【】".contains(*c))
        .collect()
}

fn has_lite_evidence(plan: &RunPlan, passages: &[&Value], issue: &Value) -> bool {
    issue["citations"].as_array().is_some_and(|citations| {
        !citations.is_empty() && citations.iter().all(|cite| {
            let section = cite["section"].as_u64().and_then(|n| n.checked_sub(1));
            let chunk = cite["chunk"].as_u64().and_then(|n| n.checked_sub(1));
            cite["quote"].as_str().is_some_and(|quote| {
                let norm_quote = normalize_quote_for_match(quote);
                !quote.trim().is_empty() && passages.iter().any(|p| {
                    p["section"].as_u64() == section && p["chunk"].as_u64() == chunk
                        && p.get("bookId").is_none_or(|id| id == &plan.reading_source()["bookId"])
                        && p["text"].as_str().is_some_and(|text| {
                            text.contains(quote)
                                || (norm_quote.chars().count() >= 4
                                    && normalize_quote_for_match(text).contains(&norm_quote))
                        })
                })
            })
        })
    })
}

/// How many sections past the player's reading position the lite check may cite:
/// the story moves on from where it started, but not by a book's worth.
pub(super) const LITE_REVIEW_AHEAD: u64 = 3;

/// Local, conservative application: a fix is used only when its quote occurs
/// exactly once and the replacement stays about the same size.
pub(super) fn apply_lite_fixes(narrative:&str, issues:&Value)->(String,Vec<Value>,usize){
    let mut text=narrative.to_owned();let mut applied=vec![];let mut skipped=0;
    for issue in issues.as_array().into_iter().flatten().take(5) {
        let quote=issue["quote"].as_str().unwrap_or("").trim();
        let fix=issue["fix"].as_str().unwrap_or("").trim();
        let fits=!quote.is_empty()&&!fix.is_empty()&&quote!=fix&&text.matches(quote).count()==1&&fix.chars().count()<=quote.chars().count()*2+40;
        if fits {text=text.replacen(quote,fix,1);applied.push(json!({"quote":quote,"problem":issue["problem"],"fix":fix,"citations":issue["citations"]}));} else {skipped+=1;}
    }
    (text,applied,skipped)
}

/// A sentence correction and its record patch form one unit. Never apply one
/// side of an invalid result; independent valid fixes still apply while any
/// later full-array replacement touching a field from a rejected issue is skipped.
pub(super) fn apply_lite_review(narrative:&str, record:&Value, issues:&Value)->(String,Value,Vec<Value>,usize){
    let empty_patch = serde_json::Map::new();
    let mut text=narrative.to_owned();let mut current=record.clone();let mut applied=vec![];let mut skipped=0;
    let mut tainted_arrays = std::collections::HashSet::<String>::new();
    let allowed = ["time","money","place","stats","items","people","status","goals","date","hour","died","currency","log","deviation","report","risk","beat","challenge","continuity","choices"];
    let mark_tainted = |patch: &serde_json::Map<String, Value>, tainted: &mut std::collections::HashSet<String>| {
        for (k, v) in patch {
            if v.is_array() {
                tainted.insert(k.clone());
            }
        }
    };
    for issue in issues.as_array().into_iter().flatten().take(5) {
        let patch = match issue.get("recordPatch") {
            None | Some(Value::Null) => &empty_patch,
            Some(Value::Object(map)) => map,
            _ => { skipped += 1; continue; }
        };
        if patch.iter().any(|(k,v)|v.is_null()||!allowed.contains(&k.as_str())) {
            mark_tainted(patch, &mut tainted_arrays);
            skipped += 1;
            continue;
        }
        if patch.iter().any(|(k, v)| v.is_array() && tainted_arrays.contains(k)) {
            skipped += 1;
            continue;
        }
        let (revised,mut fixes,_)=apply_lite_fixes(&text,&json!([issue]));
        if fixes.is_empty(){
            mark_tainted(patch, &mut tainted_arrays);
            skipped += 1;
            continue;
        }
        if patch.is_empty() {
            text = revised;
            applied.append(&mut fixes);
            continue;
        }
        let mut next=current.clone();
        for (key,value) in patch {
            if let (Some(old),Some(new))=(next[key].as_object_mut(),value.as_object()){old.extend(new.clone());}
            else {next[key]=value.clone();}
        }
        let mut warnings=vec![];
        let Some(normalized)=rules::record::normalize_record(&next,&mut warnings) else {
            mark_tainted(patch, &mut tainted_arrays);
            skipped += 1;
            continue;
        };
        if !warnings.is_empty()||patch.keys().any(|k|normalized.get(k).is_none()){
            mark_tainted(patch, &mut tainted_arrays);
            skipped += 1;
            continue;
        }
        text=revised;current=normalized;applied.append(&mut fixes);
    }
    (text,current,applied,skipped)
}

#[cfg(test)]
mod lite_review_tests {
    use super::*;
    #[test]
    fn the_lite_check_sees_where_the_story_is_and_not_far_later_chapters() {
        let mut plan: RunPlan = serde_json::from_value(json!({"id":"r","worldId":"w","lineId":"l","headId":"h","baseId":"h","kind":"turn","model":{"slot":"t","url":"https://unused.invalid","model":"t","includeUsage":false},"messages":[],"extractMessages":[],"state":{"source":{"bookId":"b","fanfic":true,"plot":"canon","position":12,"instructions":"沿原著"}},"settings":{},"options":{},"action":{"text":"上前行礼"},"meta":{}})).unwrap();
        plan.reference = Some(json!({"passages":[
            {"kind":"original","section":12,"chunk":40,"title":"双叉岭","text":"两个从者挑着担子"},
            {"kind":"original","section":26,"chunk":99,"title":"白虎岭","text":"八戒沙僧护着师父"}
        ]}));
        let messages = lite_review_messages(&plan, "两个从人上前。", 12000);
        let user = messages[1]["content"].as_str().unwrap();
        assert!(user.contains("【当前位置】原著第13节") && user.contains("[第13节·双叉岭") && user.contains("两个从者"), "{user}");
        assert!(!user.contains("八戒沙僧"), "{user}");
        assert!(messages[0]["content"].as_str().unwrap().contains("还没有发生"));
    }
    #[test]
    fn lite_review_uses_tool_read_passages_and_normalizes_punctuation_in_citations() {
        let plan: RunPlan = serde_json::from_value(json!({"id":"r","worldId":"w","lineId":"l","headId":"h","baseId":"h","kind":"turn","model":{"slot":"t","url":"https://unused.invalid","model":"t","includeUsage":false},"messages":[],"extractMessages":[],"state":{"source":{"bookId":"b","fanfic":true,"plot":"canon","position":5,"instructions":"沿原著"}},"settings":{},"options":{},"action":{"text":"问路"},"meta":{}})).unwrap();
        let extra = vec![json!({"kind":"original","bookId":"b","section":5,"chunk":2,"title":"第六章","text":"“玄铁令原在翠微楼掌柜手中。”"})];
        let passages = lite_review_passages(&plan, &extra, 12000);
        assert_eq!(passages.len(), 1);
        let issue = json!({"quote":"白玉令","fix":"玄铁令","citations":[{"section":6,"chunk":3,"quote":"玄铁令原在翠微楼掌柜手中"}]});
        assert!(has_lite_evidence(&plan, &passages, &issue));
    }
    #[test]
    fn fixes_apply_only_where_the_quote_is_unique_and_the_size_is_close() {
        let issues = json!([{"quote":"三文","problem":"x","fix":"两文"},{"quote":"纸","problem":"y","fix":"布"},{"quote":"一句","problem":"z","fix":"很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长很长"}]);
        let (text, applied, skipped) = apply_lite_fixes("一张纸三文，又一张纸。一句", &issues);
        assert_eq!(text, "一张纸两文，又一张纸。一句");
        assert_eq!((applied.len(), skipped), (1, 2));
    }
    #[test]
    fn lite_corrections_apply_independent_valid_fixes_and_block_tainted_arrays() {
        let record=json!({"money":-2,"time":5,"items":[{"name":"纸","delta":1}],"people":[{"name":"李四"},{"name":"店主"}]});
        let issues=json!([
            {"quote":"李四","fix":"张三","recordPatch":{"people":[{"name":"张三"},{"name":"店主"}]}},
            {"quote":"两文","fix":"三文","recordPatch":{"money":-3}},
            {"quote":"收好","fix":"藏好"},
            {"quote":"纸","fix":"布","recordPatch":{"source":{}}}
        ]);
        // Independent valid fixes (including omitted recordPatch on pure-prose fix) succeed while forbidden "source" is skipped.
        let (text,corrected,applied,skipped)=apply_lite_review("李四付了两文，收好纸。",&record,&issues);
        assert_eq!(text,"张三付了三文，藏好纸。");
        assert_eq!((applied.len(),skipped),(3,1));
        assert_eq!(corrected["people"],json!([{"name":"张三"},{"name":"店主"}]));
        assert_eq!(corrected["money"],-3);assert_eq!(corrected["time"],5);assert_eq!(corrected["items"][0]["name"],"纸");
        // A later full-array patch on the same array field touched by a rejected earlier issue is safely skipped.
        let dependent = json!([
            {"quote":"不存在的词","fix":"张三","recordPatch":{"people":[{"name":"张三"},{"name":"店主"}]}},
            {"quote":"店主","fix":"掌柜","recordPatch":{"people":[{"name":"张三"},{"name":"掌柜"}]}}
        ]);
        let (text2,unchanged,applied2,skipped2)=apply_lite_review("李四付了两文，店主点头。",&record,&dependent);
        assert_eq!(text2,"李四付了两文，店主点头。");
        assert_eq!(unchanged,record);
        assert!(applied2.is_empty());
        assert_eq!(skipped2,2);
    }
}
