//! Synchronous story and resource capabilities for Pi. No model loop or old
//! Agent session state is used; the caller supplies a guarded transaction.
use crate::{
    agent_workspace as ws, pi_store::PiCallRequest, tools::ToolDefinition, Error, Result, RunPlan,
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::collections::BTreeSet;

const NAMES: &[&str] = &[
    "list_resources",
    "read_resource",
    "search_resources",
    "read_world",
    "read_story_resources",
    "read_continuity",
    "stage_edit",
    "stage_story_turn",
    "stage_route",
    "discard_draft",
    "validate_changes",
    "finish_task",
    "read_clock",
    "stage_clock",
    "discover_tools",
    "read_tool_result",
    "read_player_choices",
    "list_skills",
    "read_skill",
    "read_skill_resource",
    "locate_original_event",
    "prepare_reference_check",
    "preview_turn_record",
    "search_original",
    "read_original",
    "read_canon_facts",
    "check_draft",
    "record_findings",
    "update_plan",
    "read_plan",
    "ask_user",
    "draft_skill",
    "delegate_readonly",
    "search_agent_history",
    "read_agent_history",
    "read_timeline",
    "read_evidence",
    "read_fact_sources",
    "read_commit_receipt",
    "read_committed_snapshot",
    "read_external_resource",
    "list_tool_packages",
];
pub(crate) fn supports(name: &str) -> bool {
    NAMES.contains(&name)
}
pub(crate) fn catalog() -> Vec<ToolDefinition> {
    let mut tools=crate::agent_tools::catalog()
        .into_iter()
        .filter(|t| supports(t.name)||crate::pi_async::supports(t.name))
        .map(|mut tool| {
            if tool.name=="read_skill_resource" {tool.parameters["properties"]["version"]=json!({"type":"string","maxLength":64});}
            if tool.name=="run_script" {tool.description="运行受控JavaScript，调用示例：const r=await tools.read_resource({kind:'settings'}); text(r.value)。工具由tools.<工具名>(参数)调用。分页：for await (const page of pages('read_resource',{kind:'people'})) 可读取每页；const items=await collectPages('read_resource',{kind:'people'},{maxPages:5}) 直接返回数组，使用items.length，不是items.items。第一个参数必须是工具名称字符串，不能传回调。支持text/store/load，不能访问Node、文件、裸网络或直接提交任务。";}
            if tool.name=="finish_task" {tool.description="按已选策略采用核对通过的完整独立资源组，未通过部分保留草稿。采用后立即关闭本批写权限；用read_commit_receipt/read_committed_snapshot/read_tool_result核对固定回执和正式快照，再更新计划并简要答复。不能继续编辑、重复提交或把部分采用说成全部完成；查询不产生剧情。";}
            if tool.name=="check_draft" {
                tool.description="读取任务约束、草稿资源组指纹及证据数量摘要；具体证据用read_evidence按来源/书籍筛选分页读取。不会调用模型或证明原著正确。逐项结论用record_findings记录。";
                tool.parameters["properties"]["includeEvidence"]=json!({"type":"boolean","description":"兼容完整材料读取，通常使用read_evidence分页"});
                tool.parameters["required"]=json!([]);
                tool.read_only=true;
            }
            if tool.name=="delegate_readonly" {
                tool.parameters["properties"]["tasks"]["items"]["additionalProperties"]=false.into();
                tool.parameters["properties"]["tasks"]["items"]["properties"]["draftRefs"]=json!({"type":"array","maxItems":16,"items":crate::pi_resources::schema()});
                tool.description="把独立查证交给同时最多两个只读Pi子会话。共享根任务模型、额度和取消；默认读取固定版本正式资料，draftRefs可明确提供必要草稿字段。子助手不能编辑、提交、执行脚本、提问或再次派生；返回带出处的核对报告，由主助手统一判断和采用。";
            }
            if ["read_resource","read_clock"].contains(&tool.name) {tool.parameters["properties"]["routeId"]=json!({"type":"string"});}
            if ["read_resource","stage_edit"].contains(&tool.name) {
                tool.parameters["properties"]["ref"]=crate::pi_resources::schema();
                if let Some(required)=tool.parameters["required"].as_array_mut(){required.retain(|v|v!="kind");}
                tool.description=if tool.name=="read_resource" {"按返回的ref直接读取资源；ref包含容器、实体及版本，不用猜ID。也可用kind/id/path重新定位。带ref时path相对ref目标，省略即目标本身；pageSize表示条目数、charBudget表示文字预算；继续回传nextCursor分页，offset/limit仅兼容旧调用。资料过期时按错误的next重新读取。"} else {"暂存本局修改。优先直接回传查阅或检索结果的ref，不把人物/卡片ID当成回合ID。带ref时path相对该目标，省略即修改该实体本身；也支持kind/id/path。operation=set/merge/remove/append/replace_text；replace_text须find/replace。append每次追加一个项目，不能用数组追加多项；facts项目须有id/detail，多项可逐项append或set保留旧项目的完整数组。历史正文要同步核对record，正式提交重算后续；书籍正文只改/data/sections，内部归属由程序维护。"};
            }
            if ["list_resources","read_resource","read_tool_result","read_agent_history","read_player_choices"].contains(&tool.name) {
                paging_schema(&mut tool.parameters);
            }
            tool
        })
        .collect::<Vec<_>>();
    tools.push(ToolDefinition{name:"record_findings",description:"记录本次具体目标及核对依据；从check_draft直接使用版本、resourceGroups完整指纹和evidenceLedger精确引文/位置。仅实际送达成功请求的原文可作原著依据，泛化编辑授权不证明事实；明确玩家分支可用playerReferenceId/quote/declaration={subject,value,scope}引用真实要求，对象和值逐字出自原句；local_custom另须明确补全许可和原句中的范围。报告可区分完成/部分完成/受阻。普通写作整理无需额外检查表。constraints.factContract=2时原著改动需分开sourceClaim（来源说法）和revisionDecision={summary,reason,appliesTo:world_rule/identity_fact/local_event}；local_event还须localReferences本局正式引文或明确玩家设定，原著规则不能证明本局已发生。basis=external可引用已送达网页/资料文件，但不能冒充原著核对。",parameters:json!({"type":"object","properties":{"report":{"type":"object","properties":{"worldVersion":{"type":"string"},"intentRevision":{"type":"integer","minimum":0},"goals":{"type":"array","maxItems":64,"items":{"type":"object"}},"findings":{"type":"array","maxItems":256,"items":{"type":"object"}}},"required":["worldVersion","intentRevision","goals","findings"]}},"required":["report"],"additionalProperties":false}),read_only:true});
    let mut evidence=ToolDefinition{name:"read_evidence",description:"读取本任务已实际送达成功模型窗口的证据。sourceKind可过滤original原著、player本局要求或book书籍，bookId限定书籍；支持pageSize/charBudget/nextCursor。目录不是原文，具体引文按返回定位读取。",parameters:json!({"type":"object","properties":{"sourceKind":{"type":"string","enum":["original","player","book"]},"bookId":{"type":"string"},"path":{"type":"string"}},"additionalProperties":false}),read_only:true};paging_schema(&mut evidence.parameters);tools.push(evidence);
    let mut facts=ToolDefinition{name:"read_fact_sources",description:"读取本局正式采用的事实来源和原句。按nodeId可定位历史回合；basis区分原著、玩家分支、本局自定与一致性。来源匹配不证明解释必然正确；新草稿不能把旧来源当成新的原著证据。",parameters:json!({"type":"object","properties":{"nodeId":{"type":"string"},"basis":{"type":"string"}},"additionalProperties":false}),read_only:true};paging_schema(&mut facts.parameters);tools.push(facts);
    tools.extend(crate::pi_history::catalog());
    tools.push(ToolDefinition{name:"draft_tool_package",description:"准备纯JavaScript工具包草稿。manifest遵循schema1/API1.0.0或1.0.1，files为包内相对路径到文字的映射；本地无IO检查后保存草稿，玩家采用和启用前不能执行。不提供Node、Shell、Tauri或任意设备权限。",parameters:json!({"type":"object","properties":{"manifest":{"type":"object"},"files":{"type":"object"}},"required":["manifest","files"],"additionalProperties":false}),read_only:false});
    // Shared ordinary schemas, without broadening the retired Agent catalog.
    tools.extend(crate::tools::catalog().into_iter().filter(|tool| matches!(tool.name, "read_story_resources" | "read_continuity")));
    tools.extend(crate::pi_documents::catalog());
    tools.extend(crate::pi_browser::catalog());
    tools.push(ToolDefinition{name:"list_tool_packages",description:"查看本任务启动时已启用的纯JavaScript工具包、版本、入口和工具名。工具包不能自行安装、授权或访问Node；不兼容的接口会明确失败。",parameters:json!({"type":"object","properties":{},"additionalProperties":false}),read_only:true});
    tools.push(ToolDefinition{name:"call_tool_package",description:"在现有QuickJS中运行已启用工具包的一项导出。packageId为列表中的id，entry和name须直接使用目录返回值。所有内部工具调用仍走本任务权限和累计账本，不能递归工具包或提交整个任务。",parameters:json!({"type":"object","properties":{"packageId":{"type":"string"},"entry":{"type":"string"},"name":{"type":"string"},"arguments":{"type":"object"}},"required":["packageId","entry","name"],"additionalProperties":false}),read_only:false});
    let mut external=ToolDefinition{name:"read_external_resource",description:"按完整ref回读本任务已经保存的网页/搜索/MCP资料快照。保留来源、内容版本和读取范围；抓到内容不代表事实正确，不能跨局读取。",parameters:json!({"type":"object","properties":{"ref":{"type":"object"},"path":{"type":"string"}},"required":["ref"],"additionalProperties":false}),read_only:true};paging_schema(&mut external.parameters);tools.push(external);
    for (name,description,properties) in [
        ("read_commit_receipt","读取本任务正式采用的回执、版本、实际修改和未完成事项；结束后仍可回读，不重新启动故事修改。",json!({"batchId":{"type":"string"},"path":{"type":"string"}})),
        ("read_committed_snapshot","读取本批次保存的固定正式快照；kind支持settings/state/protagonist/people/places/cards/goals/facts/node/line/clock。故事后来推进不会改变快照。",json!({"batchId":{"type":"string"},"kind":{"type":"string"},"path":{"type":"string"}})),
    ] {
        let mut schema=json!({"type":"object","properties":properties,"additionalProperties":false});paging_schema(&mut schema);
        tools.push(ToolDefinition{name,description,parameters:schema,read_only:true});
    }
    tools.extend(crate::pi_timeline::catalog());
    for tool in &mut tools {if ["read_agent_history","read_timeline"].contains(&tool.name){paging_schema(&mut tool.parameters);}}
    tools
}
pub(crate) fn definitions() -> Vec<Value> {
    catalog().into_iter().map(|t|json!({"name":t.name,"label":t.name,"description":t.description,"parameters":t.parameters,"readOnly":t.read_only,"execution":crate::pi_capabilities::describe(t.name,t.read_only)})).collect()
}
pub(crate) fn paging_schema(schema:&mut Value) {
    schema["properties"]["pageSize"]=json!({"type":"integer","minimum":1,"maximum":100});
    schema["properties"]["charBudget"]=json!({"type":"integer","minimum":1,"maximum":24000});
    schema["properties"]["nextCursor"]=json!({"type":"string","maxLength":160});
}
fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn metadata(task: &Value) -> Value {
    ws::parse(ws::text(task, "metadata_json"))
}
fn save_metadata(db: &Connection, task: &Value, value: &Value) -> Result<()> {
    db.execute(
        "UPDATE pi_tasks SET metadata_json=?,updated_at=? WHERE id=?",
        params![value.to_string(), ws::now(), ws::text(task, "id")],
    )?;
    Ok(())
}

/// Core edits stay in the shared gateway. These capabilities only touch task
/// control/resource records or read the story through the same business rules.
pub(crate) fn call(
    db: &Connection,
    task: &Value,
    plan: &RunPlan,
    request: &PiCallRequest,
) -> Result<Value> {
    let args = &request.args;
    match request.tool.as_str() {
        "read_story_resources" | "read_continuity" => crate::ordinary_resources::read(db, plan, &request.tool, &request.args),
        "discover_tools" => {
            let all = definitions();
            let names = args["names"]
                .as_array()
                .ok_or_else(|| invalid("工具名称应是列表"))?;
            if names.len() > all.len() {
                return Err(invalid("一次选择的工具过多"));
            }
            for name in names {
                if !name.as_str().is_some_and(|name|supports(name)||crate::pi_async::supports(name)) {
                    return Err(invalid("所选工具尚未接入，请使用目录中的名称"));
                }
            }
            let selected = all
                .iter()
                .filter(|t| names.iter().any(|n| n == &t["name"]))
                .cloned()
                .collect::<Vec<_>>();
            let mut meta = metadata(task);
            let mut enabled = meta["enabledTools"].as_array().cloned().unwrap_or_default();
            for name in names {
                if !enabled.contains(name) {
                    enabled.push(name.clone());
                }
            }
            meta["enabledTools"] = json!(enabled);
            save_metadata(db, task, &meta)?;
            Ok(
                json!({"definitions":selected,"enabledTools":enabled,"catalog":all.iter().map(|t|json!({"name":t["name"],"description":t["description"],"readOnly":t["readOnly"]})).collect::<Vec<_>>(),"message":"这些是已接通的本地能力；有效说明持续保留。发现工具不新增权限，不安装能力。"}),
            )
        }
        "read_commit_receipt" | "read_committed_snapshot" => crate::pi_closeout::call(db,task,plan,request),
        "read_external_resource" => crate::pi_external::read(db,task,plan,args),
        "list_tool_packages" => Ok(json!({"packages":metadata(task)["toolPackages"]})),
        "read_tool_result" => read_tool_result(db, task, plan, request),
        "read_player_choices" => player_choices(db, plan, args),
        "read_timeline" => crate::pi_timeline::read(db,task,plan,args),
        "search_agent_history" => crate::pi_history::search(db,plan,args),
        "read_agent_history" => crate::pi_history::read(db,plan,args),
        "list_skills" => skill_catalog(task),
        "read_skill" => read_skill(db, task, plan, request),
        "read_skill_resource" => skill_resource(db, task, plan, request),
        "preview_turn_record" => crate::reference_lookup::preview_record(plan,args),
        "search_original" | "read_original" | "read_canon_facts" | "locate_original_event" | "prepare_reference_check" => {
            original(db, plan, args, &request.tool)
        }
        "check_draft" => check_draft(db, task, plan,args),
        "read_evidence" => read_evidence(db,task,args),
        "record_findings" => crate::pi_goal_report::record(db,task,plan,&args["report"]),
        "read_fact_sources" => {
            let node=ws::text(args,"nodeId");let basis=ws::text(args,"basis");
            let rows=ws::rows(db,"SELECT id,line_id,node_id,resource_kind,resource_id,basis,claim,source_json,created_at FROM story_fact_sources WHERE world_id=? AND (?='' OR node_id=?) AND (?='' OR basis=?) ORDER BY created_at,id",&[&plan.world_id,&node,&node,&basis,&basis])?;
            let scope=&plan.meta["agent"]["referenceScope"];
            let value=json!(rows.into_iter().filter(|row|{
                let source=ws::parse(ws::text(row,"source_json"));
                !source["references"].as_array().into_iter().flatten().any(|reference|{
                    let location=reference.get("location").unwrap_or(reference);
                    location["bookId"]==scope["bookId"] && scope["through"].as_u64().is_some_and(|through|location["section"].as_u64().is_none_or(|n|n>through))
                })
            }).map(|mut r|{r["source"]=ws::parse(ws::text(&r,"source_json"));r.as_object_mut().unwrap().remove("source_json");r}).collect::<Vec<_>>());
            Ok(ws::page(value,args))
        }
        "read_plan" => Ok(plan_state(task)),
        "update_plan" => update_plan(db, task, args),
        "ask_user" => crate::pi_questions::ask(db,task,args),
        "draft_skill" => crate::agent_packages::draft_tx(db,ws::text(task,"id"),args),
        _ => Err(invalid("没有这个已接通的本地工具")),
    }
}

pub(crate) fn player_choices(db: &Connection, plan: &RunPlan, args: &Value) -> Result<Value> {
    let query = ws::text(args, "query");
    let before = args["beforeSeq"].as_i64().unwrap_or(i64::MAX);
    let offset = args["offset"].as_u64().unwrap_or(0).min(i64::MAX as u64) as i64;
    let limit = args["limit"].as_u64().unwrap_or(10).clamp(1, 20) as i64;
    let mut statement=db.prepare("WITH RECURSIVE history AS (SELECT * FROM nodes WHERE id=? AND world_id=? UNION ALL SELECT n.* FROM nodes n JOIN history h ON h.parent_id=n.id WHERE n.world_id=?) SELECT id,seq,action_text,director_note FROM history WHERE seq<=? AND (COALESCE(action_text,'')<>'' OR COALESCE(director_note,'')<>'') AND (?='' OR instr(COALESCE(action_text,''),?)>0 OR instr(COALESCE(director_note,''),?)>0) ORDER BY seq DESC LIMIT ? OFFSET ?")?;
    let rows = statement
        .query_map(
            params![
                plan.head_id,
                plan.world_id,
                plan.world_id,
                before,
                query,
                query,
                query,
                limit + 1,
                offset
            ],
            |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            },
        )?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let more = rows.len() > limit as usize;
    let mut references = vec![];
    for (id, seq, action, note) in rows.into_iter().take(limit as usize) {
        for (field, text) in [("action_text", action), ("director_note", note)] {
            if let Some(text) = text.filter(|s| !s.trim().is_empty()) {
                references.push(json!({"id":format!("{id}:{field}"),"text":text,"nodeId":id,"seq":seq,"field":field}));
            }
        }
    }
    Ok(
        json!({"references":references,"offset":offset,"nextOffset":if more{Some(offset+limit)}else{None},"message":"这里只含程序保存的真实玩家行动与幕后输入。AI正文和AI设定不证明玩家要求偏离原著。"}),
    )
}

fn plan_state(task: &Value) -> Value {
    json!({"steps":ws::parse(ws::text(task,"plan_json")),"question":ws::parse(ws::text(task,"question_json")),"intentRevision":task["intent_revision"],"consumedIntentRevision":task["consumed_intent_revision"],"stopRevision":task["stop_revision"]})
}
fn update_plan(db: &Connection, task: &Value, args: &Value) -> Result<Value> {
    let steps = args["steps"]
        .as_array()
        .ok_or_else(|| invalid("任务步骤应是列表"))?;
    if steps.len() > 50 || args["steps"].to_string().len() > 64000 {
        return Err(invalid("任务步骤过多，请合并相关事项"));
    }
    let mut seen = BTreeSet::new();
    for step in steps {
        let id = ws::text(step, "id");
        if id.trim().is_empty()
            || ws::text(step, "text").trim().is_empty()
            || !seen.insert(id)
            || ![
                "pending",
                "in_progress",
                "completed",
                "cancelled",
                "blocked",
            ]
            .contains(&ws::text(step, "status"))
        {
            return Err(invalid("任务步骤须有不重复的标识、说明与有效状态"));
        }
    }
    db.execute(
        "UPDATE pi_tasks SET plan_json=?,updated_at=? WHERE id=?",
        params![args["steps"].to_string(), ws::now(), ws::text(task, "id")],
    )?;
    Ok(json!({"steps":steps,"message":"任务计划已保存；步骤完成不代表故事修改已经采用。"}))
}

fn configured_skills(task: &Value) -> Vec<Value> {
    let meta = metadata(task);
    let mut all = meta["skillSnapshots"]
        .as_array()
        .cloned()
        .unwrap_or_else(|| {
            crate::skills::catalog_json()
                .as_array()
                .cloned()
                .unwrap_or_default()
        });
    all.extend(
        meta["customSkills"]
            .as_array()
            .into_iter()
            .flatten()
            .cloned(),
    );
    all
}
fn skill_id(skill: &Value) -> &str {
    skill["id"]
        .as_str()
        .unwrap_or_else(|| ws::text(skill, "name"))
}
fn skill_version(skill: &Value) -> Value {
    skill
        .get("version")
        .cloned()
        .unwrap_or_else(|| skill["metadata"]["version"].clone())
}
fn skill_catalog(task: &Value) -> Result<Value> {
    Ok(
        json!({"skills":configured_skills(task).iter().map(|s|json!({"id":skill_id(s),"name":s["name"],"description":s["description"],"version":skill_version(s),"hash":s["hash"],"capabilities":s["capabilities"],"compatibility":s["compatibility"],"resources":s["files"].as_object().map(|v|v.keys().collect::<Vec<_>>())})).collect::<Vec<_>>(),"requested":metadata(task)["skills"],"message":"这里只是技能目录。按需读取正文与支持资料，读取并不证明已完成查证或修改。"}),
    )
}
fn selected_skill(task: &Value, requested: &str) -> Result<Value> {
    let all = configured_skills(task);
    let matches = all
        .into_iter()
        .filter(|s| skill_id(s) == requested || ws::text(s, "name") == requested)
        .collect::<Vec<_>>();
    if requested.is_empty() || matches.len() != 1 {
        return Err(invalid("技能名称不存在或有重名，请从list_skills使用确切id"));
    }
    let mut skill = matches.into_iter().next().unwrap();
    if !skill["body"].is_string() {
        if let Some(content) = skill["content"].as_str() {
            skill["body"] = content.into();
        } else {
            skill = crate::skills::read(ws::text(&skill, "name"))?;
        }
    }
    let id = skill_id(&skill).to_owned();
    skill["id"] = id.into();
    skill["version"] = skill_version(&skill);
    Ok(skill)
}
fn call_actor(db: &Connection, task: &Value, call: &str) -> Result<Option<String>> {
    // The native mapping is authoritative. A child-shaped prefix alone is
    // neither a child identity nor proof that the call actually exists.
    let actor: Option<Option<String>> = db.query_row(
        "SELECT a.child_id FROM pi_calls c LEFT JOIN pi_child_calls a ON a.task_id=c.task_id AND a.call_id=c.call_id WHERE c.task_id=? AND c.call_id=?",
        params![ws::text(task,"id"),call], |r|r.get(0),
    ).optional()?;
    Ok(actor.map(Option::unwrap_or_default))
}
fn request_actor(db: &Connection, task: &Value, plan: &RunPlan, request: &PiCallRequest) -> Result<String> {
    let actor = call_actor(db, task, &request.call_id)?
        .ok_or_else(|| invalid("当前技能读取没有实际调用记录"))?;
    if actor != ws::text(&plan.meta["agent"], "readOnlyActor") {
        return Err(invalid("技能读取调用不属于当前助手身份"));
    }
    Ok(actor)
}
fn prior_skill(db: &Connection, task: &Value, requested: &str, actor: &str) -> Result<Option<(String, Value)>> {
    let raw:Option<(String,String)>=db.query_row("SELECT c.call_id,c.output_json FROM pi_calls c LEFT JOIN pi_child_calls a ON a.task_id=c.task_id AND a.call_id=c.call_id WHERE c.task_id=? AND c.tool='read_skill' AND c.status='done' AND COALESCE(a.child_id,'')=? AND (json_extract(c.output_json,'$.data.id')=? OR json_extract(c.output_json,'$.data.name')=?) ORDER BY c.rowid LIMIT 1",params![ws::text(task,"id"),actor,requested,requested],|r|Ok((r.get(0)?,r.get(1)?))).optional()?;
    Ok(raw.map(|(call,v)| (call,ws::parse(&v)["data"].clone())))
}

fn skill_read_locator(call: &str, offset: usize) -> Value {
    json!({"callId":call,"path":"/body","offset":offset,"limit":2000})
}
fn body_ranges(read: &Value, total: usize) -> Vec<(usize, usize)> {
    read["bodyRanges"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|range| {
            Some((
                range[0].as_u64()?.min(total as u64) as usize,
                range[1].as_u64()?.min(total as u64) as usize,
            ))
        })
        .filter(|(start, end)| start < end)
        .collect()
}
fn merge_ranges(mut ranges: Vec<(usize, usize)>) -> Vec<(usize, usize)> {
    ranges.sort_unstable();
    let mut merged: Vec<(usize, usize)> = vec![];
    for (start, end) in ranges {
        if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
            last.1 = last.1.max(end);
        } else {
            merged.push((start, end));
        }
    }
    merged
}
fn range_complete(ranges: &[(usize, usize)], total: usize) -> bool {
    total == 0
        || ranges
            .first()
            .is_some_and(|&(start, end)| start == 0 && end >= total)
}
fn first_missing(ranges: &[(usize, usize)]) -> usize {
    ranges
        .first()
        .filter(|&&(start, _)| start == 0)
        .map(|&(_, end)| end)
        .unwrap_or(0)
}

/// Count only text actually present in a bounded delivery, never a directory
/// or a supporting file. Ranges use the same Unicode scalar offsets as pages.
fn record_body_range(
    db: &Connection,
    task: &Value,
    actor: &str,
    source_call: &str,
    skill: &Value,
    start: usize,
    end: usize,
    page: &Value,
) -> Result<Option<Value>> {
    // A parent may inspect a child's result, but that view cannot complete
    // either actor's pinned method-body requirement.
    if call_actor(db, task, source_call)?.as_deref() != Some(actor) {
        return Ok(None);
    }
    let total = ws::text(skill, "body").chars().count();
    let mut meta = metadata(task);
    let reads = meta["skillReads"]
        .as_array_mut()
        .ok_or_else(|| invalid("请先read_skill登记实际技能版本"))?;
    let read = reads
        .iter_mut()
        .find(|read| {
            ws::text(read,"actor") == actor
                && ws::text(read,"callId") == source_call
                && read["id"] == skill["id"]
                && read["version"] == skill["version"]
                && read["hash"] == skill["hash"]
        })
        .ok_or_else(|| invalid("这份技能正文与本任务已读取版本不一致"))?;
    let mut ranges = body_ranges(read, total);
    if start < end.min(total) {
        ranges.push((start, end.min(total)));
    }
    let ranges = merge_ranges(ranges);
    let complete = range_complete(&ranges, total);
    read["bodyRanges"] = json!(ranges);
    read["bodyChars"] = total.into();
    read["bodyRead"] = complete.into();
    read["requiresRead"] = (!complete).into();
    let locator = skill_read_locator(ws::text(read, "callId"), first_missing(&ranges));
    read["read"] = locator.clone();
    let result = json!({"id":skill["id"],"actor":actor,"version":skill["version"],"hash":skill["hash"],"bodyRead":complete,"requiresRead":!complete,"read":locator});
    let mut candidate=page.clone();
    candidate["skillRead"]=result.clone();
    // Count only text that remains in the final bounded response, including
    // this report's size; a large identifier must not externalize it again.
    let delivered=delivery("skill-page","read_tool_result",json!({"ok":true,"data":candidate}));
    if delivered["data"]["text"]!=page["text"] {return Ok(None);}
    save_metadata(db, task, &meta)?;
    Ok(Some(result))
}

fn read_skill(db: &Connection, task: &Value, plan: &RunPlan, request: &PiCallRequest) -> Result<Value> {
    let actor = request_actor(db, task, plan, request)?;
    let requested = request.args["id"]
        .as_str()
        .or_else(|| request.args["name"].as_str())
        .unwrap_or("");
    let (source_call, mut skill) = match prior_skill(db, task, requested, &actor)? {
        Some(prior) => prior,
        None => (request.call_id.clone(),selected_skill(task, requested)?),
    };
    skill["actor"] = actor.clone().into();
    skill["requestedId"] = requested.into();
    skill["taskAdapter"]="本次由Pi会话执行，方法说明不能扩大权限。按需使用本次工具目录中的能力；原著用search_original/read_original读实际原文。修改先stage_edit/stage_clock/stage_story_turn，再validate_changes和finish_task。不要使用旧compose_draft/stage_changes/commit_turn。read_skill只记录读取版本，不代表已经完成查证；写作、整理不强制单独填检查表。技能提到未加载能力时先discover_tools；目录未提供的能力不能声称已执行。Shell/Python/Node不能直接执行，JavaScript只可交给已接通的受控run_script。".into();
    let mut meta = metadata(task);
    let mut reads = meta["skillReads"].as_array().cloned().unwrap_or_default();
    if !reads.iter().any(|v| v["id"] == skill["id"] && ws::text(v,"actor")==actor && ws::text(v,"callId")==source_call) {
        reads.push(json!({"id":skill["id"],"actor":actor,"name":skill["name"],"version":skill["version"],"hash":skill["hash"],"callId":source_call,"status":"fetched","verification":"not_verified","bodyRead":false,"bodyRanges":[]}));
    }
    let read = reads.iter_mut().find(|v| v["id"] == skill["id"] && ws::text(v,"actor")==actor && ws::text(v,"callId")==source_call).unwrap();
    let total = ws::text(&skill, "body").chars().count();
    let mut ranges = merge_ranges(body_ranges(read, total));
    skill["bodyRead"] = range_complete(&ranges, total).into();
    skill["requiresRead"] = (!range_complete(&ranges, total)).into();
    skill["read"] = skill_read_locator(ws::text(read, "callId"), first_missing(&ranges));
    // Reserve the fields above before checking the actual returned envelope.
    // A large skill may include resources as well as its body: fetching that
    // object does not mean the model has seen the externally stored method.
    let mut direct_skill=skill.clone();
    direct_skill["bodyRead"]=true.into();
    direct_skill["requiresRead"]=false.into();
    direct_skill["read"]=skill_read_locator(ws::text(read,"callId"),total);
    let delivered = delivery(
        &request.call_id,
        "read_skill",
        json!({"ok":true,"data":direct_skill}),
    );
    if delivered["data"]["body"] == skill["body"] {
        ranges = vec![(0, total)];
    }
    let complete = range_complete(&ranges, total);
    read["bodyRanges"] = json!(ranges);
    read["bodyChars"] = total.into();
    read["bodyRead"] = complete.into();
    read["requiresRead"] = (!complete).into();
    read["read"] = skill_read_locator(ws::text(read, "callId"), first_missing(&ranges));
    skill["bodyRead"] = complete.into();
    skill["requiresRead"] = (!complete).into();
    skill["read"] = read["read"].clone();
    meta["skillReads"] = json!(reads);
    save_metadata(db, task, &meta)?;
    Ok(skill)
}
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 500
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn skill_resource(db: &Connection, task: &Value, plan: &RunPlan, request: &PiCallRequest) -> Result<Value> {
    let actor = request_actor(db, task, plan, request)?;
    let args=&request.args;
    let id = ws::text(args, "id");
    let path = ws::text(args, "path");
    if !safe_path(path) {
        return Err(invalid("只能读取所选技能包内的资源"));
    }
    // Pin every support resource to the same original call as the body. A
    // preference edited since this task began must not silently supply a new
    // file or hash for the method whose version was already read.
    let (source_call,skill) = prior_skill(db, task, id, &actor)?
        .ok_or_else(|| invalid("请先read_skill取得本任务固定的技能版本及资源定位"))?;
    if args.get("version").is_some_and(|version|version!=&skill["version"]) {
        return Err(invalid("资源版本与本任务固定的技能版本不一致，请使用read_skill返回的版本"));
    }
    let content = if path == "SKILL.md" {
        skill["body"].as_str()
    } else {
        skill["files"][path].as_str()
    }
    .ok_or_else(|| invalid("技能资源不存在"))?;
    let offset = args["offset"].as_u64().unwrap_or(0).min(usize::MAX as u64) as usize;
    let limit = args["limit"]
        .as_u64()
        .unwrap_or(2000)
        .clamp(1, if path == "SKILL.md" { 2000 } else { 24000 }) as usize;
    let part = content.chars().skip(offset).take(limit).collect::<String>();
    let mut result = json!({"id":skill["id"],"path":path,"version":skill["version"],"hash":skill["hash"],"text":part,"offset":offset,"nextOffset":offset+part.chars().count(),"total":content.chars().count(),"executed":false});
    if path == "SKILL.md" {
        let delivered = delivery(
            "skill-page",
            "read_skill_resource",
            json!({"ok":true,"data":result}),
        );
        if delivered["data"]["text"] == result["text"] {
            if let Some(coverage)=record_body_range(db, task, &actor, &source_call, &skill, offset, offset + part.chars().count(), &result)? {
                result["skillRead"] = coverage;
            }
        }
    }
    Ok(result)
}

fn original(db: &Connection, plan: &RunPlan, args: &Value, name: &str) -> Result<Value> {
    let mut source = plan.clone();
    source.state = ws::resource(db, plan, "state", "")?;
    let bound = source.state["source"]["bookId"].as_str().unwrap_or("");
    let requested = args["bookId"].as_str().or_else(||args["ref"]["bookId"].as_str()).unwrap_or("");
    if !bound.is_empty() || !requested.is_empty() {
        let resolved = ws::resolve_book(db, plan, requested, bound)?;
        if source.state["source"]["bookId"] != resolved {
            source.state["source"] =
                json!({"bookId":resolved,"through":null,"position":0,"method":"search"});
        }
    }
    let scope = &plan.meta["agent"]["referenceScope"];
    if scope.is_object() && source.state["source"]["bookId"] == scope["bookId"] {
        source.state["source"]["through"] = scope["through"].clone();
    }
    source.meta["budgetChars"] = 32000.into();
    let mut scoped = args.clone();
    scoped.as_object_mut().unwrap().remove("bookId");
    crate::runtime_sources::read_db(db, &source, name, &scoped)
}

fn read_tool_result(db: &Connection, task: &Value, plan: &RunPlan, request: &PiCallRequest) -> Result<Value> {
    let actor = request_actor(db, task, plan, request)?;
    let args=&request.args;
    let call = ws::text(args, "callId");
    let (tool, raw): (String, String) = db
        .query_row(
            "SELECT tool,output_json FROM pi_calls WHERE task_id=? AND call_id=? AND status='done'",
            params![ws::text(task, "id"), call],
            |r| Ok((r.get(0)?, r.get(1)?)),
        )
        .optional()?
        .ok_or_else(|| invalid("本任务没有这项已完成工具结果；不能读取其他任务结果"))?;
    let result = ws::parse(&raw);
    let original = result.get("data").unwrap_or(&result);
    let path = ws::text(args, "path");
    let value = if path.is_empty() {
        original.clone()
    } else {
        original
            .pointer(path)
            .cloned()
            .ok_or_else(|| invalid("工具结果路径不存在，请使用该callId返回的真实字段定位"))?
    };
    let skill_body = tool == "read_skill" && path == "/body";
    let mut effective = args.clone();
    if skill_body {
        effective["limit"] = args["limit"].as_u64().unwrap_or(2000).clamp(1, 2000).into();
    }
    let mut page = ws::page(value, &effective);
    ws::attach_read_locators(&mut page, &json!({"callId":call}));
    page["callId"] = call.into();
    page["sourceTool"] = tool.clone().into();
    page["sourceOk"] = result["ok"].clone();
    if skill_body {
        let delivered = delivery(
            "skill-page",
            "read_tool_result",
            json!({"ok":true,"data":page}),
        );
        if let Some(text) = page["text"]
            .as_str()
            .filter(|_| delivered["data"]["text"] == page["text"])
        {
            let start = page["offset"].as_u64().unwrap_or(0) as usize;
            if let Some(coverage)=record_body_range(db, task, &actor, call, original, start, start + text.chars().count(), &page)? {
                page["skillRead"] = coverage;
            }
        }
    }
    if tool == "read_tool_result" {
        if original["read"].is_object() {
            page["read"] = original["read"].clone();
        }
        page["sourceTool"] = original["sourceTool"].clone();
    }
    Ok(page)
}
fn read_evidence(db:&Connection,task:&Value,args:&Value)->Result<Value> {
    let evidence=crate::pi_receipts::pages(db,task)?;
    let selected=evidence.as_array().into_iter().flatten().filter(|item|{
        let kind=ws::text(args,"sourceKind");(kind.is_empty()||if kind=="book" {item["bookId"].is_string()}else{item["sourceKind"]==kind})&&(ws::text(args,"bookId").is_empty()||item["bookId"]==args["bookId"])
    }).cloned().collect::<Vec<_>>();
    let mut paging=args.clone();if paging.get("pageSize").is_none(){paging["pageSize"]=20.into();}
    let data=json!(selected);let path=ws::text(args,"path");let data=if path.is_empty(){data}else{data.pointer(path).cloned().ok_or_else(||invalid("证据字段不存在，请从证据目录重新定位"))?};
    let mut page=ws::page(data,&paging);let mut base=args.clone();for key in ["path","nextCursor","offset","limit"]{base.as_object_mut().unwrap().remove(key);}
    ws::attach_read_locators(&mut page,&base);page["readTool"]="read_evidence".into();
    Ok(page)
}
fn check_draft(db: &Connection, task: &Value, plan: &RunPlan,args:&Value) -> Result<Value> {
    let mut stmt=db.prepare("SELECT call_id,tool,output_json FROM pi_calls WHERE task_id=? AND status='done' AND tool IN ('search_original','read_original','read_canon_facts','read_resource','read_player_choices') ORDER BY rowid DESC LIMIT 40")?;
    let rows = stmt
        .query_map([ws::text(task, "id")], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
            ))
        })?
        .collect::<std::result::Result<Vec<_>, _>>()?;
    let evidence=rows.into_iter().filter_map(|(id,tool,raw)|{let output=ws::parse(&raw);if output["ok"]!=true{return None;}let data=&output["data"];Some(json!({"callId":id,"tool":tool,"status":data["status"],"bookId":data["bookId"],"through":data["through"],"excerpts":data["excerpts"].as_array().map(|v|v.iter().map(|e|json!({"kind":e["kind"],"bookId":e["bookId"],"section":e["section"],"chunk":e["chunk"],"title":e["title"],"page":e["page"],"start":e["start"],"end":e["end"]})).collect::<Vec<_>>()),"read":{"callId":id,"path":"","offset":0,"limit":1200}}))}).collect::<Vec<_>>();
    let workspace = ws::workspace(db, ws::text(task, "id"))?;
    let ledger=crate::pi_receipts::pages(db,task)?;
    let summary=json!({"count":ledger.as_array().map(Vec::len).unwrap_or(0),"readTool":"read_evidence","read":{"pageSize":20,"charBudget":6000}});
    let ledger=if args["includeEvidence"]==true {ledger}else {json!([])};
    Ok(
        json!({"evidenceSummary":summary,"constraints":crate::pi_goal_report::constraints(db,task,plan)?,"goalResult":metadata(task)["goalResult"],"evidenceLedger":ledger,"evidenceDeliveryVersion":1,"sourceReads":evidence,"referenceScope":plan.meta["agent"]["referenceScope"],"verification":crate::agent_verification::pending(&workspace),"resourceGroups":crate::pi_verification::resource_groups(&workspace)?,"skillReads":metadata(task)["skillReads"],"verified":false,"instructions":"evidenceLedger只含经成功模型请求确认实际送达的有界正文，不含搜索摘要；sourceReads仅为调用/出处定位，不代表原文已读。resourceGroups以完整原始/修改后资源绑定指纹，atomicSet内不能拆成半份采用；它们不代表事实已核实。原著请read_original，外置结果请read_tool_result按字段分页，再逐项核对。读技能不代表完成查证，目录、摘要和较早身份不能代替当前依据。玩家分支须核对真实原句，编辑授权不能证明新事实。"}),
    )
}

/// Full results are committed to pi_calls before a bounded delivery view is
/// sent to Pi. The locator always points at the original result data.
pub(crate) fn script_delivery(call_id:&str,result:Value)->Value {
    if result.to_string().len()<=256*1024 {return result;}
    json!({"ok":result["ok"],"data":{"paged":true,"storedResult":true,"callId":call_id,"readTool":"read_tool_result","read":{"callId":call_id,"pageSize":40,"charBudget":12000},"message":"完整结构超过256KiB；未返回内容。请用pages(read_tool_result,read)读取，不能把分页定位当作value/resources。"}})
}
pub(crate) fn delivery(call_id: &str, tool: &str, mut result: Value) -> Value {
    if tool=="read_skill" && result["ok"]==true {
        let resources=crate::skills::resource_directory(&result["data"]);
        if let Some(data)=result["data"].as_object_mut() {
            // pi_calls retains all files, while the model sees paths only.
            data.remove("files");
            data.insert("resources".into(),resources);
        }
    }
    // Loadout control must survive display pagination. The trusted host has
    // already registered these native schemas; this adds no authority.
    let loadout=if tool=="discover_tools"&&result["ok"]==true {
        Some(json!(result["data"]["enabledTools"].as_array().into_iter().flatten().filter(|n|n.as_str().is_some_and(|n|supports(n)||crate::pi_async::supports(n))).cloned().collect::<Vec<_>>()))
    }else{None};
    if result.to_string().encode_utf16().count() <= 16000 {
        if let Some(names)=loadout{result["toolLoadout"]=names;}
        return result;
    }
    let data = result.get("data").cloned().unwrap_or(result.clone());
    let mut page = ws::page(data, &json!({"pageSize":40,"charBudget":10000}));
    ws::attach_read_locators(&mut page, &json!({"callId":call_id}));
    page["sourceTool"] = tool.into();
    page["callId"] = call_id.into();
    page["storedResult"] = true.into();
    if tool == "read_skill" {
        page["requiresRead"] = result["data"]["requiresRead"].clone();
        page["bodyRead"] = result["data"]["bodyRead"].clone();
        page["read"] = result["data"]["read"].clone();
        page["message"]=if result["data"]["requiresRead"]==true {
            "技能正文尚未全部送达。按read中的原始调用、/body和nextOffset分页读完，再继续执行方法；支持文件不能代替SKILL.md。"
        } else {
            "这份技能正文已经完整送达；支持资源与原始正文仍可按read回读。读取不证明查证和修改已经完成。"
        }.into();
    }
    let mut delivered=json!({"ok":result["ok"],"data":page});if let Some(names)=loadout{delivered["toolLoadout"]=names;}delivered
}

#[cfg(test)]
mod actor_tests {
    use super::*;
    use crate::{pi_children::ChildAuthority, pi_gateway::{StoryToolGateway, TaskPermit}, Store};
    use std::sync::{Arc, Mutex};

    struct Fixture { store: Store, gateway: StoryToolGateway, permit: TaskPermit, version: String, child: ChildAuthority, delegation: PiCallRequest }
    impl Fixture {
        fn new(body: &str) -> Self {
            Self::configured(json!({"skills":["owned-skill"],"customSkills":[{"id":"owned-skill","name":"独立技能","version":"1.0.0","hash":"fixed-skill","content":body,"files":{"references/note.md":"同版本支持资料"}}]}))
        }
        fn configured(config: Value) -> Self {
            let mut db=Connection::open_in_memory().unwrap();
            db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
            crate::migration::migrate(&mut db,None).unwrap();
            db.execute_batch("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','隔离技能','free','l','{\"premise\":\"正式设定\"}','test','test','test');INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('n','w',0,'opening','独立正文','test');INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','n','test');INSERT INTO states(node_id,state_json) VALUES('n','{\"time\":{\"start\":\"第一天\",\"elapsedMinutes\":0},\"source\":null}');INSERT INTO pi_sessions(id,world_id,line_id,title,created_at,updated_at) VALUES('s','w','l','技能隔离','test','test')").unwrap();
            let store=Store(Arc::new(Mutex::new(db)));let gateway=StoryToolGateway::new(store.clone());
            let task=gateway.start_task("s","t","核对技能","auto-reversible",false,json!({"model":"no-http"}),config).unwrap();
            let permit=gateway.permit("t").unwrap();let version=ws::text(&task,"base_world_version").to_owned();
            let delegation=PiCallRequest{task_id:"t".into(),call_id:"delegate".into(),tool:"delegate_readonly".into(),args:json!({"tasks":[{"name":"只读技能核对","prompt":"读取所选技能，不替主助手完成执行门槛"}]}),intent_revision:0,world_version:version.clone(),external_write:false};
            let prepared=gateway.prepare_children(&permit,&delegation).unwrap();assert_eq!(prepared["ok"],true,"{prepared}");
            let id=prepared["data"]["children"][0]["id"].as_str().unwrap();
            let child=gateway.open_child(&permit,id,"isolated-child-session").unwrap();
            Self{store,gateway,permit,version,child,delegation}
        }
        fn request(&self,id:&str,tool:&str,args:Value)->PiCallRequest {PiCallRequest{task_id:"t".into(),call_id:id.into(),tool:tool.into(),args,intent_revision:0,world_version:self.version.clone(),external_write:false}}
        fn root_raw(&self,id:&str,tool:&str,args:Value)->Value {self.gateway.invoke(&self.permit,self.request(id,tool,args)).unwrap()}
        fn root(&self,id:&str,tool:&str,args:Value)->Value {let r=self.root_raw(id,tool,args);assert_eq!(r["ok"],true,"{r}");r["data"].clone()}
        fn child_raw(&self,id:&str,tool:&str,args:Value)->Value {self.gateway.invoke_child(&self.permit,self.request(&self.child.call_id(id),tool,args),&self.child).unwrap()}
        fn child(&self,id:&str,tool:&str,args:Value)->Value {let r=self.child_raw(id,tool,args);assert_eq!(r["ok"],true,"{r}");r["data"].clone()}
        fn reads(&self)->Vec<Value> {self.gateway.0.task("t").unwrap()["metadata_json"]["skillReads"].as_array().cloned().unwrap_or_default()}
        fn end_child(&self) {
            self.gateway.finish_child(&self.permit,&self.child,&json!({"ok":true,"text":"已读取独立技能"})).unwrap();
            assert_eq!(self.gateway.finish_children(&self.permit,&self.delegation).unwrap()["ok"],true);
        }
        fn finish(&self,id:&str)->Value {self.root_raw(id,"finish_task",json!({"summary":"已核对独立方法","outcome":"no_changes_needed"}))}
    }

    #[test]
    fn builtin_files_stay_in_the_task_snapshot_not_the_automatic_delivery_or_another_task() {
        let mut skill=crate::skills::read("story-recap").unwrap();
        skill["hash"]=crate::pi_store::arguments_hash(&skill).into();
        let expected=skill["files"]["references/method.md"].clone();
        let f=Fixture::configured(json!({"skills":["story-recap"],"skillSnapshots":[skill]}));
        assert_eq!(f.root_raw("not-read","read_skill_resource",json!({"id":"story-recap","path":"references/method.md"}))["ok"],false);
        let delivery=f.root("method","read_skill",json!({"id":"story-recap"}));
        assert_eq!(delivery["version"],"1.1.0");assert_eq!(delivery["bodyRead"],true);
        assert!(delivery.get("files").is_none());assert_eq!(delivery["resources"].as_array().unwrap().len(),2);
        let saved:String=f.store.lock().unwrap().query_row("SELECT output_json FROM pi_calls WHERE task_id='t' AND call_id='method'",[],|row|row.get(0)).unwrap();
        assert_eq!(ws::parse(&saved)["data"]["files"]["references/method.md"],expected);
        let mut updated=crate::skills::read("story-recap").unwrap();updated["version"]="9.0.0".into();updated["metadata"]["version"]="9.0.0".into();updated["files"]["references/method.md"]="以后版本的支持资料".into();updated["hash"]=crate::pi_store::arguments_hash(&updated).into();
        let mut metadata=f.gateway.0.task("t").unwrap()["metadata_json"].clone();metadata["skillSnapshots"]=json!([updated.clone()]);
        f.store.lock().unwrap().execute("UPDATE pi_tasks SET metadata_json=? WHERE id='t'",[metadata.to_string()]).unwrap();
        let fixed=f.root("support","read_skill_resource",json!({"id":"story-recap","path":"references/method.md","version":"1.1.0","limit":24000}));
        assert_eq!(fixed["text"],expected);assert_eq!(fixed["version"],"1.1.0");
        assert_eq!(f.root_raw("wrong-version","read_skill_resource",json!({"id":"story-recap","path":"references/method.md","version":"9.0.0"}))["ok"],false);
        assert_eq!(f.root_raw("escape","read_skill_resource",json!({"id":"story-recap","path":"../SKILL.md"}))["ok"],false);
        assert_eq!(f.child_raw("cannot-inherit","read_skill_resource",json!({"id":"story-recap","path":"references/method.md"}))["ok"],false);
        f.end_child();assert_eq!(f.finish("done")["ok"],true);
        let other=f.gateway.start_task("s","next-task","核对新版技能","auto-reversible",false,json!({"model":"no-http"}),json!({"skills":["story-recap"],"skillSnapshots":[updated]})).unwrap();
        let permit=f.gateway.permit("next-task").unwrap();let version=ws::text(&other,"base_world_version").to_owned();
        let call=|id:&str,tool:&str,args:Value|f.gateway.invoke(&permit,PiCallRequest{task_id:"next-task".into(),call_id:id.into(),tool:tool.into(),args,intent_revision:0,world_version:version.clone(),external_write:false}).unwrap();
        assert_eq!(call("foreign-method","read_skill_resource",json!({"id":"story-recap","path":"references/method.md"}))["ok"],false,"a previous task's read does not authorize the new one");
        assert_eq!(call("new-method","read_skill",json!({"id":"story-recap"}))["data"]["version"],"9.0.0");
        assert_eq!(call("new-support","read_skill_resource",json!({"id":"story-recap","path":"references/method.md","version":"9.0.0"}))["data"]["text"],"以后版本的支持资料");
    }

    #[test]
    fn short_skill_reads_pin_the_actual_actor_in_both_read_orders() {
        for root_first in [false,true] {
            let f=Fixture::new("# 独立短方法\n先读取资料，再执行核对。");
            if root_first {f.root("root-skill","read_skill",json!({"id":"owned-skill"}));}
            assert_eq!(f.child_raw("no-own-skill","read_skill_resource",json!({"id":"owned-skill","path":"references/note.md"}))["ok"],false,"a child must not reuse the root read");
            let child=f.child("skill","read_skill",json!({"id":"owned-skill"}));
            let child_call=f.child.call_id("skill");
            assert_eq!(child["bodyRead"],true);assert_eq!(child["read"]["callId"],child_call);
            assert_eq!(f.child("skill-again","read_skill",json!({"id":"owned-skill"}))["read"]["callId"],child_call);
            if !root_first {
                assert_eq!(f.root_raw("root-no-own-skill","read_skill_resource",json!({"id":"owned-skill","path":"SKILL.md"}))["ok"],false);
                f.end_child();
                assert_eq!(f.finish("child-cannot-satisfy-root")["ok"],false);
                f.root("root-skill","read_skill",json!({"id":"owned-skill"}));
            } else {f.end_child();}
            assert_eq!(f.root("root-again","read_skill",json!({"id":"owned-skill"}))["read"]["callId"],"root-skill");
            let reads=f.reads();assert_eq!(reads.len(),2);
            let root=reads.iter().find(|r|ws::text(r,"actor").is_empty()).unwrap();
            let child=reads.iter().find(|r|r["actor"]==f.child.id).unwrap();
            assert_eq!(root["callId"],"root-skill");assert_eq!(child["callId"],child_call);
            assert_eq!(root["bodyRead"],true);assert_eq!(child["bodyRead"],true);
            assert_eq!(f.finish("root-complete")["ok"],true);
            assert_eq!(f.store.lock().unwrap().query_row("SELECT COUNT(*) FROM nodes",[],|r|r.get::<_,i64>(0)).unwrap(),1);
        }
    }

    #[test]
    fn long_skill_pages_credit_only_the_pinned_call_actor_not_another_reader_or_prefix() {
        let body=format!("# 独立长方法\n{}末尾方法。","方法🙂".repeat(6000));let total=body.chars().count();
        for root_first in [false,true] {
            let f=Fixture::new(&body);
            if root_first {assert_eq!(f.root("root-skill","read_skill",json!({"id":"owned-skill"}))["requiresRead"],true);}
            let child=f.child("skill","read_skill",json!({"id":"owned-skill"}));let child_call=f.child.call_id("skill");
            assert_eq!(child["requiresRead"],true);assert_eq!(child["read"]["callId"],child_call);
            assert_eq!(f.child_raw("root-page-denied","read_tool_result",json!({"callId":"root-skill","path":"/body","offset":0,"limit":2000}))["ok"],false);
            let mut offset=0;
            while offset<total {
                let page=if offset%4000==0 {f.child(&format!("page-{offset}"),"read_tool_result",json!({"callId":child_call,"path":"/body","offset":offset,"limit":2000}))}
                    else {f.child(&format!("resource-{offset}"),"read_skill_resource",json!({"id":"owned-skill","path":"SKILL.md","offset":offset,"limit":2000}))};
                offset=page["nextOffset"].as_u64().unwrap()as usize;assert_eq!(page["skillRead"]["bodyRead"],offset==total);
            }
            let foreign=f.root("inspect-child-body","read_tool_result",json!({"callId":child_call,"path":"/body","offset":0,"limit":2000}));
            assert!(foreign["text"].as_str().unwrap().starts_with('#'));assert!(foreign["skillRead"].is_null(),"reading a child's locator cannot credit the parent");
            if !root_first {f.root("root-skill","read_skill",json!({"id":"owned-skill"}));}
            f.end_child();assert_eq!(f.finish("child-body-not-root-body")["ok"],false);
            let reads=f.reads();let child=reads.iter().find(|r|r["actor"]==f.child.id).unwrap();let root=reads.iter().find(|r|ws::text(r,"actor").is_empty()).unwrap();
            assert_eq!(child["bodyRanges"],json!([[0,total]]));assert_eq!(root["bodyRead"],false);assert_eq!(root["bodyRanges"],json!([]));
            let prefix_only=f.child.call_id("root-looking-like-child");
            let page=f.root(&prefix_only,"read_tool_result",json!({"callId":"root-skill","path":"/body","offset":0,"limit":2000}));
            assert_eq!(page["skillRead"]["actor"],"");assert_eq!(page["skillRead"]["bodyRead"],false);
            let mut offset=2000;
            while offset<total {
                let page=f.root(&format!("root-page-{offset}"),"read_skill_resource",json!({"id":"owned-skill","path":"SKILL.md","offset":offset,"limit":2000}));
                offset=page["nextOffset"].as_u64().unwrap()as usize;
            }
            let reads=f.reads();assert_eq!(reads.len(),2);
            for read in reads {assert_eq!(read["bodyRead"],true);assert_eq!(read["bodyRanges"],json!([[0,total]]));}
            assert_eq!(f.finish("all-own-pages")["ok"],true);
        }
    }
}

#[cfg(test)]mod script_delivery_tests {
 use super::*;
 #[test]fn script_gets_structured_values_not_a_model_display_page(){let result=json!({"ok":true,"data":{"resources":(0..400).map(|n|json!({"id":n,"text":"资料".repeat(30)})).collect::<Vec<_>>()}});assert!(result.to_string().len()>16000);assert_eq!(script_delivery("read",result.clone())["data"]["resources"].as_array().unwrap().len(),400);assert!(delivery("read","list_resources",result)["data"]["storedResult"]==true);let large=script_delivery("large",json!({"ok":true,"data":{"value":"大".repeat(100000)}}));assert_eq!(large["data"]["paged"],true);assert_eq!(large["data"]["read"]["callId"],"large");}
}

#[cfg(test)]
mod discovery_delivery_tests {
    use super::*;
    #[test]
    fn large_tool_directory_retains_a_separate_validated_loadout(){
        let result=delivery("discovery","discover_tools",json!({"ok":true,"data":{"enabledTools":["search_original","read_original"],"definitions":[{"description":"长工具说明".repeat(5000)}]}}));
        assert_eq!(result["toolLoadout"],json!(["search_original","read_original"]));assert_eq!(result["data"]["storedResult"],true);
        let error=delivery("failed","discover_tools",json!({"ok":false,"error":{"message":"不能授权"}}));assert!(error.get("toolLoadout").is_none());
    }
}
