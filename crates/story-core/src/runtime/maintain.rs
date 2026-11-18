//! 设定集整理 and 章节摘要 (D168): asked after the passage is saved, in a run
//! of their own that never holds the story, applied only if still fitting.
use super::*;

impl Engine {
    /// The requests for 设定集整理 and 章节摘要; results go into the draft.
    pub(super) async fn maintain_requests(self: &Arc<Self>, shared: &Shared, plan: &RunPlan, narrative: &str, upkeep_state: &Value) -> Result<()> {
        let shared = shared.clone();
        let narrative = narrative.to_owned();
        let state = &plan.state;
        {
            if let Some(messages) = plan.meta["upkeepMessages"].as_array() {
                let messages = crate::stage_context::organization(&plan, messages, &narrative);
                if let Some(response) = self.optional_complete(&shared, "upkeep", messages).await? {
                    if let Some(patch) =
                        crate::organize::upkeep_patch(&response.text, upkeep_state)
                    {
                        shared.lock().map_err(|_| Error::Cancelled)?.draft["upkeepPatch"] = patch;
                    }
                    shared.lock().map_err(|_| Error::Cancelled)?.draft["upkeepAttempted"] =
                        true.into();
                }
            }
            if let Some(messages) = plan.meta["chapterMessages"].as_array() {
                let (mut messages, groups) = crate::stage_context::chapter(messages, &narrative, plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize);
                if state["era"]["mode"] == "free" {
                    for message in &mut messages {
                        if message["role"] == "system" {
                            message["content"] = message["content"]
                                .as_str()
                                .unwrap_or("")
                                .replace("历史互动小说", "互动小说")
                                .into();
                        }
                    }
                }
                let mut summaries=vec![];let mut complete=true;
                if groups.len()>1 {
                    for (index, group) in groups.iter().enumerate(){
                        let mut request=messages.clone();let content=request.last_mut().ok_or_else(||Error::Invalid("章节上下文缺失".into()))?;
                        content["content"]=format!("{}\n【本章剧情·第{}/{}组】\n{}\n仅总结本组实际发生的事，后续将合并整章。",content["content"].as_str().unwrap_or(""),index+1,groups.len(),group).into();
                        if let Some(response)=self.optional_complete(&shared,&format!("chapter:part:{index}"),request).await? {
                            if let Some(chapter)=crate::organize::parse_chapter(&response.text){summaries.push(chapter);}else{complete=false;break;}
                        }else{complete=false;break;}
                    }
                }
                let content=messages.last_mut().ok_or_else(||Error::Invalid("章节上下文缺失".into()))?;
                content["content"]=format!("{}\n【本章剧情】\n{}",content["content"].as_str().unwrap_or(""),if groups.len()>1{format!("以下为按原文顺序核实的分组摘要，请合并整章，不能新增事实：\n{}",json!(summaries))}else{groups.first().cloned().unwrap_or_default()}).into();
                if let Some(response) = if complete {self.optional_complete(&shared, "chapter", messages).await?} else {None}
                {
                    if let Some(chapter) = crate::organize::parse_chapter(&response.text) {
                        shared.lock().map_err(|_| Error::Cancelled)?.draft["chapter"] = chapter;
                    }
                }
            }
        }
        Ok(())
    }

    /// Registers the tidying that follows a saved passage as its own run (D168).
    /// It holds a lease of its own, so the next passage never waits for it.
    pub(super) fn start_maintenance(self: &Arc<Self>, plan: &RunPlan, narrative: &str, result: &Value) -> Result<Option<String>> {
        if plan.meta["upkeepMessages"].is_null() && plan.meta["chapterMessages"].is_null() {
            return Ok(None);
        }
        let node = result["nodeId"].as_str().ok_or(Error::Stale)?.to_owned();
        let head = result["headId"].as_str().unwrap_or(&node).to_owned();
        let state: String = self.store.lock()?.query_row("SELECT state_json FROM states WHERE node_id=?", [&head], |r| r.get(0))?;
        let mut tidy = plan.clone();
        tidy.id = format!("{}~maintain", plan.id);
        tidy.kind = "maintain".into();
        tidy.head_id = head;
        tidy.base_id = Some(node.clone());
        tidy.original = narrative.to_owned();
        tidy.state = serde_json::from_str(&state)?;
        tidy.messages = vec![];
        tidy.extract_messages = vec![];
        tidy.reference = None;
        tidy.carried_edits = vec![];
        tidy.trailing_ids = vec![];
        let mut meta = json!({"maintainNode": node, "passageRun": plan.id, "budgetChars": plan.meta["budgetChars"]});
        for key in ["upkeepMessages", "upkeepVersion", "chapterMessages", "chapterFirstId", "chapterVersion", "modelRequestLimit"] {
            if !plan.meta[key].is_null() { meta[key] = plan.meta[key].clone(); }
        }
        tidy.meta = meta;
        self.start(tidy).map(Some)
    }

    /// The tidying run: ask, then apply what still fits the story (D168).
    pub(super) async fn maintain(self: &Arc<Self>, shared: Shared) -> Result<()> {
        let plan = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
        shared.lock().map_err(|_| Error::Cancelled)?.stage = crate::failure::Stage::Maintain;
        let narrative = plan.original.clone();
        self.maintain_requests(&shared, &plan, &narrative, &plan.state).await?;
        self.checkpoint(&shared)?;
        self.check(&shared)?;
        let c = shared.lock().map_err(|_| Error::Cancelled)?;
        let plan = &c.plan;
        let node = plan.meta["maintainNode"].as_str().unwrap_or("").to_owned();
        let mut db = self.store.lock()?;
        let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
        Store::guard(&tx, plan)?;
        let time = Utc::now().to_rfc3339();
        let head: Option<String> = tx.query_row("SELECT node_id FROM lines WHERE id=? AND world_id=? AND deleted_at IS NULL", params![plan.line_id, plan.world_id], |r| r.get(0)).optional()?;
        // The 设定集 patch applies to the story as it was; once the player has
        // gone on, the next passage asks for it again.
        // A newer writer can already be using this head, before its commit changes it.
        let writer = execution_lease::current(&tx, &plan.world_id)?;
        let available = writer.is_none_or(|l| l.ticket.owner_id.is_empty()
            || l.expires_at_ms <= execution_lease::now_ms()
            || Some(l.ticket.owner_id.as_str()) == plan.meta["passageRun"].as_str());
        let still_head = available && head.as_deref() == Some(plan.head_id.as_str());
        let mut upkeep_done = false;
        if still_head && c.draft["upkeepPatch"].is_object() {
            let patch = &c.draft["upkeepPatch"];
            let mut opts = plan.options.clone();
            opts["advanceTime"] = false.into();
            let next = rules::apply_record(&plan.state, patch, &opts).map_err(|e| Error::fail(crate::failure::FailKind::Settle, e))?;
            if next["state"] != plan.state {
                let next_id = uuid::Uuid::new_v4().simple().to_string();
                let seq: i64 = tx.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM nodes WHERE world_id=?", [&plan.world_id], |r| r.get(0))?;
                insert_node(&tx, &next_id, &plan.world_id, Some(&plan.head_id), seq, "edit", &json!({"text":"AI 整理了设定集"}), "", patch,
                    &json!({"by":"AI","promptVersion":plan.meta["upkeepVersion"],"chips":next["chips"],"upkeep":true}), &next["state"], &time)?;
                tx.execute("UPDATE lines SET node_id=? WHERE id=?", params![next_id, plan.line_id])?;
            }
            upkeep_done = true;
        }
        if still_head && c.draft["upkeepAttempted"] == true && (upkeep_done || !c.draft["upkeepPatch"].is_object()) {
            tx.execute("UPDATE nodes SET meta_json=json_set(meta_json,'$.upkeep',json('true')) WHERE id=?", [&node])?;
        }
        if c.draft["chapter"].is_object() {
            let chapter = &c.draft["chapter"];
            let first = plan.meta["chapterFirstId"].as_str().filter(|s| *s != "{{NODE_ID}}").unwrap_or(&node).to_owned();
            // A later passage may have summarized the same chapter first.
            let taken = tx.query_row("SELECT 1 FROM chapters WHERE world_id=? AND first_node_id=?", params![plan.world_id, first], |_| Ok(())).optional()?.is_some();
            if !taken {
                tx.execute("INSERT INTO chapters(id,world_id,first_node_id,last_node_id,title,gist,summary,model,prompt_version,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)",params![uuid::Uuid::new_v4().simple().to_string(),plan.world_id,first,node,chapter["title"].as_str().unwrap_or("未命名章节"),chapter["gist"].as_str().unwrap_or(""),chapter["summary"].as_str().unwrap_or(""),plan.model.aux_model.as_ref().unwrap_or(&plan.model.model),plan.meta["chapterVersion"].as_str().unwrap_or("chapter-2"),time])?;
            }
        }
        write_usage(&tx, &plan.id, &plan.world_id, Some(&node), "ok")?;
        tx.execute("UPDATE execution_runs SET status='committed',result_json=?,updated_at=? WHERE id=? AND status='running'", params![json!({"worldId":plan.world_id,"nodeId":node}).to_string(), time, plan.id])?;
        tx.commit()?;
        Ok(())
    }
}
