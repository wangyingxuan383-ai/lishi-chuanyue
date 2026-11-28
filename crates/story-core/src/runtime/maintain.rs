//! 设定集整理 and 章节摘要 (D168): asked after the passage is saved, in a run
//! of their own that never holds the story, applied only if still fitting.
use super::*;

impl Engine {
    /// The requests for 设定集整理 and 章节摘要; results go into the draft.
    pub(super) async fn maintain_requests(self: &Arc<Self>, shared: &Shared, plan: &RunPlan, narrative: &str, upkeep_state: &Value) -> Result<()> {
        let shared = shared.clone();
        let narrative = narrative.to_owned();
        // Run 设定集整理 (upkeep) and 章节摘要 (chapter) concurrently (R31-P3):
        // each step acquires `shared` only briefly outside `.await` and gets a unique step key.
        let upkeep_fut = async {
            if let Some(messages) = plan.meta["upkeepMessages"].as_array() {
                let messages = crate::stage_context::organization(plan, messages, &narrative);
                if let Some(response) = self.optional_complete(&shared, "upkeep", messages).await? {
                    let patch = crate::organize::upkeep_patch(&response.text, upkeep_state);
                    let mut guard = shared.lock().map_err(|_| Error::Cancelled)?;
                    if let Some(patch) = patch {
                        guard.draft["upkeepPatch"] = patch;
                    }
                    guard.draft["upkeepAttempted"] = true.into();
                }
            }
            Ok::<(), Error>(())
        };
        let chapter_fut = async {
            if let Some(messages) = plan.meta["chapterMessages"].as_array() {
                if let Some(chapter) = self.summarize_chapter(&shared, plan, messages, &narrative, "chapter").await? {
                    shared.lock().map_err(|_| Error::Cancelled)?.draft["chapter"] = chapter;
                }
            }
            Ok::<(), Error>(())
        };
        tokio::try_join!(upkeep_fut, chapter_fut)?;
        // Chapters a later edit made out of date are summarized again from the text now (D183).
        for (index, refresh) in plan.meta["chapterRefresh"].as_array().into_iter().flatten().enumerate() {
            let (Some(id), Some(messages)) = (refresh["id"].as_str(), refresh["messages"].as_array()) else { continue };
            if let Some(chapter) = self.summarize_chapter(&shared, plan, messages, "", &format!("chapter:refresh:{index}")).await? {
                shared.lock().map_err(|_| Error::Cancelled)?.draft["chapterRefreshed"][id] = chapter;
            }
        }
        Ok(())
    }

    /// One chapter summary: grouped when the chapter is long, then merged; None when any step fails.
    async fn summarize_chapter(self: &Arc<Self>, shared: &Shared, plan: &RunPlan, messages: &[Value], narrative: &str, purpose: &str) -> Result<Option<Value>> {
        let (mut messages, groups) = crate::stage_context::chapter(messages, narrative, plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize);
        if plan.state["era"]["mode"] == "free" {
            for message in &mut messages {
                if message["role"] == "system" {
                    message["content"] = message["content"].as_str().unwrap_or("").replace("历史互动小说", "互动小说").into();
                }
            }
        }
        let mut summaries = vec![];
        if groups.len() > 1 {
            for (index, group) in groups.iter().enumerate() {
                let mut request = messages.clone();
                let content = request.last_mut().ok_or_else(|| Error::Invalid("章节上下文缺失".into()))?;
                content["content"] = format!("{}\n【本章剧情·第{}/{}组】\n{}\n仅总结本组实际发生的事，后续将合并整章。", content["content"].as_str().unwrap_or(""), index + 1, groups.len(), group).into();
                let Some(response) = self.optional_complete(shared, &format!("{purpose}:part:{index}"), request).await? else { return Ok(None) };
                let Some(chapter) = crate::organize::parse_chapter(&response.text) else { return Ok(None) };
                summaries.push(chapter);
            }
        }
        let content = messages.last_mut().ok_or_else(|| Error::Invalid("章节上下文缺失".into()))?;
        content["content"] = format!("{}\n【本章剧情】\n{}", content["content"].as_str().unwrap_or(""), if groups.len() > 1 { format!("以下为按原文顺序核实的分组摘要，请合并整章，不能新增事实：\n{}", json!(summaries)) } else { groups.first().cloned().unwrap_or_default() }).into();
        Ok(match self.optional_complete(shared, purpose, messages).await? {
            Some(response) => crate::organize::parse_chapter(&response.text),
            None => None,
        })
    }

    /// Registers the tidying that follows a saved passage as its own run (D168).
    /// It holds a lease of its own, so the next passage never waits for it.
    pub(super) fn start_maintenance(self: &Arc<Self>, plan: &RunPlan, narrative: &str, result: &Value) -> Result<Option<String>> {
        let refresh = plan.meta["chapterRefresh"].as_array().filter(|a| !a.is_empty());
        if plan.meta["upkeepMessages"].is_null() && plan.meta["chapterMessages"].is_null() && refresh.is_none() {
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
        for key in ["upkeepMessages", "upkeepTextGuard", "upkeepVersion", "chapterMessages", "chapterTextGuard", "chapterFirstId", "chapterVersion", "modelRequestLimit"] {
            if !plan.meta[key].is_null() { meta[key] = plan.meta[key].clone(); }
        }
        if let Some(refresh) = refresh {
            // The text each refresh reads, so a summary of text edited again meanwhile is not saved.
            let db = self.store.lock()?;
            let mut list = vec![];
            for item in refresh.iter().take(2) {
                let (Some(first), Some(last)) = (item["firstNodeId"].as_str(), item["lastNodeId"].as_str()) else { continue };
                let mut item = item.clone();
                if item["textGuard"].is_null() {
                    item["hash"] = span_hash(&db, first, last)?.into();
                }
                list.push(item);
            }
            meta["chapterRefresh"] = Value::Array(list);
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
        let world_active: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM worlds WHERE id=? AND archived=0)",
            [&plan.world_id],
            |r| r.get(0),
        )?;
        let head: Option<String> = if world_active {
            tx.query_row(
                "SELECT node_id FROM lines WHERE id=? AND world_id=? AND deleted_at IS NULL",
                params![plan.line_id, plan.world_id],
                |r| r.get(0),
            )
            .optional()?
        } else {
            None
        };
        let node_exists: bool = world_active
            && !node.is_empty()
            && tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM nodes WHERE id=? AND world_id=?)",
                params![node, plan.world_id],
                |r| r.get(0),
            )?;
        if !world_active || head.is_none() || !node_exists {
            write_usage(&tx, &plan.id, &plan.world_id, None, "ok")?;
            tx.execute(
                "UPDATE execution_runs SET status='committed',result_json=?,updated_at=? WHERE id=? AND status='running'",
                params![
                    json!({"worldId":plan.world_id,"nodeId":node,"skipped":true}).to_string(),
                    time,
                    plan.id
                ],
            )?;
            tx.commit()?;
            return Ok(());
        }
        // The 设定集 patch applies to the story as it was; once the player has
        // gone on, the next passage asks for it again.
        // A newer writer can already be using this head, before its commit changes it.
        let writer = execution_lease::current(&tx, &plan.world_id)?;
        let available = writer.is_none_or(|l| l.ticket.owner_id.is_empty()
            || l.expires_at_ms <= execution_lease::now_ms()
            || Some(l.ticket.owner_id.as_str()) == plan.meta["passageRun"].as_str());
        // The passage's text when the tidy-up was asked for: an edit since then
        // means its results describe text that is gone (D183).
        let text_now: Option<String> = tx.query_row("SELECT narrative FROM nodes WHERE id=? AND world_id=?", params![node, plan.world_id], |r| r.get(0)).optional()?;
        let same_text = text_now.as_deref() == Some(plan.original.as_str());
        let head_node_exists: bool = tx.query_row(
            "SELECT EXISTS(SELECT 1 FROM nodes WHERE id=? AND world_id=?)",
            params![plan.head_id, plan.world_id],
            |r| r.get(0),
        )?;
        let still_head = available && same_text && head_node_exists && head.as_deref() == Some(plan.head_id.as_str())
            && text_guard_matches(&tx, &plan.world_id, &plan.meta["upkeepTextGuard"])?;
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
                tx.execute("UPDATE lines SET node_id=? WHERE id=? AND world_id=? AND deleted_at IS NULL", params![next_id, plan.line_id, plan.world_id])?;
            }
            upkeep_done = true;
        }
        if still_head && c.draft["upkeepAttempted"] == true && (upkeep_done || !c.draft["upkeepPatch"].is_object()) {
            tx.execute("UPDATE nodes SET meta_json=json_set(meta_json,'$.upkeep',json('true')) WHERE id=? AND world_id=?", params![node, plan.world_id])?;
        }
        if c.draft["chapter"].is_object() {
            let chapter = &c.draft["chapter"];
            let first = plan.meta["chapterFirstId"].as_str().filter(|s| *s != "{{NODE_ID}}").unwrap_or(&node).to_owned();
            let span_valid: bool = tx.query_row(
                "WITH RECURSIVE up(id) AS (
                     SELECT id FROM nodes WHERE id=?1 AND world_id=?2
                     UNION ALL
                     SELECT n.parent_id FROM nodes n JOIN up u ON n.id=u.id WHERE n.world_id=?2 AND n.parent_id IS NOT NULL
                 )
                 SELECT EXISTS(SELECT 1 FROM up WHERE id=?3)
                    AND EXISTS(SELECT 1 FROM nodes WHERE id=?3 AND world_id=?2)",
                params![node, plan.world_id, first],
                |r| r.get(0),
            )?;
            // A later passage may have summarized the same chapter first, on this route.
            // Another route sharing the first passage has a chapter of its own (D183).
            let taken = span_valid && tx.query_row("WITH RECURSIVE up(id) AS (SELECT ? UNION ALL SELECT n.parent_id FROM nodes n JOIN up u ON n.id=u.id WHERE n.parent_id IS NOT NULL)
                SELECT 1 FROM chapters WHERE world_id=? AND first_node_id=? AND last_node_id IN (SELECT id FROM up)", params![node, plan.world_id, first], |_| Ok(())).optional()?.is_some();
            if span_valid && !taken {
                let fresh = same_text && text_guard_matches(&tx, &plan.world_id, &plan.meta["chapterTextGuard"])?;
                tx.execute("INSERT INTO chapters(id,world_id,first_node_id,last_node_id,title,gist,summary,model,prompt_version,created_at,stale) VALUES(?,?,?,?,?,?,?,?,?,?,?)",params![uuid::Uuid::new_v4().simple().to_string(),plan.world_id,first,node,chapter["title"].as_str().unwrap_or("未命名章节"),chapter["gist"].as_str().unwrap_or(""),chapter["summary"].as_str().unwrap_or(""),plan.model.aux_model.as_ref().unwrap_or(&plan.model.model),plan.meta["chapterVersion"].as_str().unwrap_or("chapter-2"),time,if fresh { None } else { Some(1) }])?;
            }
        }
        for refresh in plan.meta["chapterRefresh"].as_array().into_iter().flatten() {
            let (Some(id), Some(first), Some(last)) = (refresh["id"].as_str(), refresh["firstNodeId"].as_str(), refresh["lastNodeId"].as_str()) else { continue };
            let chapter = &c.draft["chapterRefreshed"][id];
            if !chapter.is_object() {
                continue;
            }
            let refresh_nodes_valid: bool = tx.query_row(
                "SELECT EXISTS(SELECT 1 FROM nodes WHERE id=?1 AND world_id=?3)
                    AND EXISTS(SELECT 1 FROM nodes WHERE id=?2 AND world_id=?3)",
                params![first, last, plan.world_id],
                |r| r.get(0),
            )?;
            if !refresh_nodes_valid {
                continue;
            }
            let fresh = if refresh["textGuard"].is_null() {
                refresh["hash"].as_str() == Some(span_hash(&tx, first, last)?.as_str())
            } else {
                text_guard_matches(&tx, &plan.world_id, &refresh["textGuard"])?
            };
            if !fresh { continue; }
            // Only one still waiting and not written by the player since.
            tx.execute("UPDATE chapters SET title=?,gist=?,summary=?,model=?,prompt_version=?,stale=NULL WHERE id=? AND world_id=? AND stale=1 AND edited=0",
                params![chapter["title"].as_str().unwrap_or("未命名章节"), chapter["gist"].as_str().unwrap_or(""), chapter["summary"].as_str().unwrap_or(""), plan.model.aux_model.as_ref().unwrap_or(&plan.model.model), plan.meta["chapterVersion"].as_str().unwrap_or("chapter-2"), id, plan.world_id])?;
        }
        write_usage(&tx, &plan.id, &plan.world_id, Some(&node), "ok")?;
        tx.execute("UPDATE execution_runs SET status='committed',result_json=?,updated_at=? WHERE id=? AND status='running'", params![json!({"worldId":plan.world_id,"nodeId":node}).to_string(), time, plan.id])?;
        tx.commit()?;
        Ok(())
    }
}

/// Compare the passages used to build the request (game.ts textGuard), in the
/// same order. The new passage is guarded separately by `same_text`.
fn text_guard_matches(db: &rusqlite::Connection, world: &str, guard: &Value) -> Result<bool> {
    if guard.is_null() { return Ok(true); }
    let Some(expected) = guard["hash"].as_str() else { return Ok(false) };
    if !guard["ids"].is_array() { return Ok(false); }
    let mut rows = db.prepare("SELECT n.id,n.narrative FROM json_each(?1) AS selected
        LEFT JOIN nodes n ON n.id=selected.value AND n.world_id=?2 AND n.kind<>'edit'
        ORDER BY CAST(selected.key AS INTEGER)")?;
    let mut passages = rows.query(params![guard["ids"].to_string(), world])?;
    let mut hash: u64 = 0xcbf29ce484222325;
    while let Some(row) = passages.next()? {
        let Some(id) = row.get::<_, Option<String>>(0)? else { return Ok(false) };
        let text: String = row.get(1)?;
        for ch in id.chars().chain(['\x1f']).chain(text.chars()).chain(['\x1e']) {
            hash = (hash ^ ch as u64).wrapping_mul(0x100000001b3);
        }
    }
    Ok(format!("{hash:x}") == expected)
}

/// The text of a chapter's span (its passages from `last` back to `first`), as one fingerprint.
fn span_hash(db: &rusqlite::Connection, first: &str, last: &str) -> Result<String> {
    let mut stmt = db.prepare("WITH RECURSIVE up(id, parent, narrative, seq) AS (SELECT id,parent_id,narrative,seq FROM nodes WHERE id=?1 UNION ALL SELECT n.id,n.parent_id,n.narrative,n.seq FROM nodes n JOIN up u ON n.id=u.parent WHERE u.id<>?2) SELECT id,narrative FROM up ORDER BY seq")?;
    let mut hasher = Sha256::new();
    let rows = stmt.query_map(params![last, first], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?;
    for row in rows {
        let (id, narrative) = row?;
        hasher.update(id.as_bytes());
        hasher.update([0x1f]);
        hasher.update(narrative.as_bytes());
        hasher.update([0x1e]);
    }
    Ok(format!("{:x}", hasher.finalize()))
}
