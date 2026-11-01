//! A whole spectator sequence belongs to the native owner, including the
//! pauses between passages. Child turns keep ordinary transactional settlement.
use crate::{
    runtime::{Context, Engine, Shared},
    Error, ExecutionMode, Result, RunBudget, RunPlan, Store,
};
use chrono::Utc;
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use std::{
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

struct Live {
    state: Value,
    settings: Value,
    raw_settings: Value,
    history: Vec<Value>,
    chapters: Vec<Value>,
}

impl Engine {
    pub(crate) async fn execute_autoplay(self: &Arc<Self>, shared: Shared) -> Result<()> {
        let initial = shared.lock().map_err(|_| Error::Cancelled)?.plan.clone();
        let total = initial.meta["autoplayCount"]
            .as_u64()
            .or_else(|| initial.meta["count"].as_u64())
            .unwrap_or(1)
            .min(100);
        loop {
            self.check(&shared)?;
            let persisted = self.store.snapshot(&initial.id, 0)?;
            let plan = self.store.plan(&initial.id)?;
            let steps = persisted.draft["steps"].as_u64().unwrap_or(0);
            merge_budget(&shared, &persisted.budget)?;
            {
                let mut parent = shared.lock().map_err(|_| Error::Cancelled)?;
                parent.plan = plan.clone();
                parent.draft = persisted.draft;
            }
            if steps >= total {
                return self.finish_autoplay(&shared, "count");
            }
            let live = self.autoplay_live(&plan)?;
            if live.settings["pilot"] != "ai" {
                return self.finish_autoplay(&shared, "player");
            }
            if dead(&live.state, &live.settings) {
                return self.finish_autoplay(&shared, "died");
            }
            if steps > 0
                && shared.lock().map_err(|_| Error::Cancelled)?.draft["pauseAfter"].as_u64()
                    != Some(steps)
            {
                let delay = plan.meta["autoplayPauseMs"]
                    .as_u64()
                    .unwrap_or(500)
                    .min(5000);
                let cancel = shared.lock().map_err(|_| Error::Cancelled)?.cancel.clone();
                tokio::select! { _ = cancel.cancelled() => return Err(Error::Cancelled), _ = tokio::time::sleep(Duration::from_millis(delay)) => {} }
                shared.lock().map_err(|_| Error::Cancelled)?.draft["pauseAfter"] = steps.into();
                self.checkpoint(&shared)?;
                // Re-read after the pause before preparing a new request.
                continue;
            }
            let index = steps + 1;
            let child_id = format!("{}:step:{index}", plan.id);
            let exists = self
                .store
                .lock()?
                .query_row(
                    "SELECT 1 FROM execution_runs WHERE id=?",
                    [&child_id],
                    |_| Ok(()),
                )
                .optional()?
                .is_some();
            let (child_plan, child_draft, previous_budget) = if exists {
                let saved = self.store.snapshot(&child_id, 0)?;
                if saved.status == "committed" {
                    // Normally the child's commit advanced the parent in the
                    // same transaction. This also repairs an older checkpoint.
                    self.reconcile_child(&shared, index, &saved)?;
                    continue;
                }
                if matches!(saved.status.as_str(), "stale" | "previewed") {
                    return Err(Error::Stale);
                }
                if saved.status == "running" {
                    self.store.finish(&child_id, "interrupted", None)?;
                }
                self.store.resume(&child_id)?;
                (self.store.plan(&child_id)?, saved.draft, saved.budget)
            } else {
                let mut child = self.autoplay_plan(&plan, live, index)?;
                if plan.meta["autoplayBudgetVersion"]=="per-passage-1"{child.meta["stepBudgetBase"]=serde_json::to_value(shared.lock().map_err(|_|Error::Cancelled)?.budget())?;}
                self.store.register(&child)?;
                (child, json!({}), RunBudget::default())
            };
            merge_budget(&shared, &previous_budget)?;
            let (budget, cancel) = {
                let mut parent = shared.lock().map_err(|_| Error::Cancelled)?;
                parent.draft["childId"] = child_id.clone().into();
                (parent.budget(), parent.cancel.child_token())
            };
            self.checkpoint(&shared)?;
            self.store
                .event(&plan.id, json!({"type":"step","index":index,"total":total}))?;
            let active_before = budget.active_ms;
            let child = Arc::new(Mutex::new(Context {
                plan: child_plan.clone(),
                budget,
                draft: child_draft,
                started: Instant::now(),
                active_before,
                cancel,
            }));
            // Boxing is intentional: execute dispatches autoplay back here.
            let outcome = Box::pin(self.execute(child.clone())).await;
            self.checkpoint(&child)?;
            let used = child.lock().map_err(|_| Error::Cancelled)?.budget();
            merge_budget(&shared, &used)?;
            if let Err(error) = outcome {
                let status = match &error {
                    Error::Cancelled => "cancelled",
                    Error::Limit(_) => "paused",
                    Error::Stale => "stale",
                    _ => "failed",
                };
                self.store
                    .finish(&child_id, status, Some(&error.to_string()))?;
                self.flush_usage(&child_id, status)?;
                // A terminal event can fail after the child committed. Keep
                // the parent's atomic route/step update before checkpointing.
                let saved = self.store.snapshot(&plan.id, 0)?;
                let persisted_plan = self.store.plan(&plan.id)?;
                {
                    let mut parent = shared.lock().map_err(|_| Error::Cancelled)?;
                    parent.plan = persisted_plan;
                    parent.draft = saved.draft;
                }
                self.checkpoint(&shared)?;
                return Err(error);
            }
            let saved = self.store.snapshot(&child_id, 0)?;
            if saved.status != "committed" {
                return Err(Error::Invalid("连播的这一段尚未提交，进度已保留".into()));
            }
            self.reconcile_child(&shared, index, &saved)?;
            let latest = self.store.plan(&plan.id)?;
            let after = self.autoplay_live(&latest)?;
            if dead(&after.state, &after.settings) {
                return self.finish_autoplay(&shared, "died");
            }
            if child_plan.state["challenge"]["status"] == "active"
                && after.state["challenge"]["status"] != "active"
            {
                return self.finish_autoplay(&shared, "challenge");
            }
            if script_finished(&child_plan.state) == Some(false)
                && script_finished(&after.state) == Some(true)
            {
                return self.finish_autoplay(&shared, "script");
            }
        }
    }

    fn autoplay_live(&self, plan: &RunPlan) -> Result<Live> {
        let mut db = self.store.lock()?;
        let tx = db.transaction()?;
        // Settings can be changed between spectator steps. The route and
        // source snapshot stay guarded; the next child guards the fresh settings.
        let mut route = plan.clone();
        route
            .meta
            .as_object_mut()
            .map(|m| m.remove("settingsGuard"));
        Store::guard(&tx, &route)?;
        let raw: String = tx.query_row(
            "SELECT settings_json FROM worlds WHERE id=?",
            [&plan.world_id],
            |r| r.get(0),
        )?;
        let raw_settings: Value = serde_json::from_str(&raw)?;
        let mut settings = plan.settings.clone();
        if let (Some(settings), Some(raw)) = (settings.as_object_mut(), raw_settings.as_object()) {
            settings.extend(raw.clone());
        }
        let state: String = tx.query_row(
            "SELECT state_json FROM states WHERE node_id=?",
            [&plan.head_id],
            |r| r.get(0),
        )?;
        let state: Value = serde_json::from_str(&state)?;
        let mut statement = tx.prepare("WITH RECURSIVE path AS (SELECT id,parent_id,seq,kind,action_text,narrative,meta_json,action_mode FROM nodes WHERE id=? UNION ALL SELECT n.id,n.parent_id,n.seq,n.kind,n.action_text,n.narrative,n.meta_json,n.action_mode FROM nodes n JOIN path p ON n.id=p.parent_id) SELECT id,kind,action_text,narrative,meta_json,action_mode FROM path ORDER BY seq DESC LIMIT 200")?;
        let rows = statement.query_map([&plan.head_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
            ))
        })?;
        let mut history = vec![];
        for row in rows {
            let (id, kind, action, narrative, meta, action_mode) = row?;
            history.push(json!({"id":id,"kind":kind,"actionText":action,"actionMode":action_mode,"narrative":narrative,"meta":serde_json::from_str::<Value>(&meta)?}));
        }
        drop(statement);
        history.reverse();
        let mut statement = tx.prepare("SELECT first_node_id,last_node_id,title,gist,summary FROM chapters WHERE world_id=? ORDER BY created_at")?;
        let chapters = statement.query_map([&plan.world_id], |r|Ok(json!({"firstNodeId":r.get::<_,String>(0)?,"lastNodeId":r.get::<_,String>(1)?,"title":r.get::<_,String>(2)?,"gist":r.get::<_,String>(3)?,"summary":r.get::<_,String>(4)?})))?.collect::<std::result::Result<Vec<_>,_>>()?.into_iter().filter(|c|history.iter().any(|n|n["id"]==c["lastNodeId"])).collect();
        Ok(Live {
            state,
            settings,
            raw_settings,
            history,
            chapters,
        })
    }

    fn autoplay_plan(&self, parent: &RunPlan, live: Live, index: u64) -> Result<RunPlan> {
        let mut plan = parent.clone();
        plan.id = format!("{}:step:{index}", parent.id);
        plan.kind = "turn".into();
        plan.base_id = Some(parent.head_id.clone());
        plan.state = live.state;
        plan.settings = live.settings;
        // Legacy world flags never choose the execution engine for ordinary play.
        plan.execution_mode = ExecutionMode::Classic;
        plan.action = json!({"mode":"continue","text":""});
        plan.original.clear();
        plan.carried_edits.clear();
        plan.trailing_ids.clear();
        plan.new_world = None;
        for key in [
            "upkeepMessages",
            "chapterMessages",
            "chapterFirstId",
            "targetId",
            "rewriteHint",
        ] {
            plan.meta.as_object_mut().map(|m| m.remove(key));
        }
        plan.meta["parentRun"] = parent.id.clone().into();
        plan.meta["autoplayIndex"] = index.into();
        plan.meta["autoplayPromptVersion"] = "autoplay-1".into();
        plan.meta["settingsGuard"] = live.raw_settings;
        plan.meta["sourceGuard"] = plan.state.get("source").cloned().unwrap_or(Value::Null);
        plan.options["mode"] = "continue".into();
        plan.options["difficulty"] = plan.settings["difficulty"].clone();
        plan.options["fortune"] = Value::Null;
        plan.options["asked"] = Value::Null;
        if plan.state["era"]["currency"]["units"]
            .as_array()
            .is_some_and(|a| !a.is_empty())
        {
            plan.options["currency"] = plan.state["era"]["currency"].clone();
        }
        let mut clock = plan.options["clock"].clone();
        for (key, source) in [
            ("mode", &plan.state["era"]["mode"]),
            ("clockStyle", &plan.state["era"]["clockStyle"]),
            ("date", &plan.state["time"]["date"]),
            ("hour", &plan.state["time"]["startHour"]),
            ("rules", &plan.state["era"]["calendar"]),
            ("label", &plan.state["time"]["start"]),
        ] {
            if !source.is_null() {
                clock[key] = source.clone();
            }
        }
        plan.options["clock"] = clock;
        prepare_messages(&self.store, &mut plan, &live.history, &live.chapters)?;
        prepare_organization(&mut plan, &live.history, &live.chapters);
        Ok(plan)
    }

    fn reconcile_child(
        &self,
        shared: &Shared,
        index: u64,
        saved: &crate::RunSnapshot,
    ) -> Result<()> {
        merge_budget(shared, &saved.budget)?;
        let id = shared.lock().map_err(|_| Error::Cancelled)?.plan.id.clone();
        let persisted = self.store.snapshot(&id, 0)?;
        let plan = self.store.plan(&id)?;
        {
            let mut parent = shared.lock().map_err(|_| Error::Cancelled)?;
            parent.plan = plan;
            parent.draft = persisted.draft;
            parent.draft["steps"] = index
                .max(parent.draft["steps"].as_u64().unwrap_or(0))
                .into();
            parent.draft["lastNodeId"] = saved
                .result
                .as_ref()
                .and_then(|r| r.get("nodeId"))
                .cloned()
                .unwrap_or(Value::Null);
            if let Some(draft) = parent.draft.as_object_mut() {
                draft.remove("childId");
            }
        }
        self.checkpoint(shared)
    }

    fn finish_autoplay(&self, shared: &Shared, reason: &str) -> Result<()> {
        self.checkpoint(shared)?;
        let c = shared.lock().map_err(|_| Error::Cancelled)?;
        let result = json!({"steps":c.draft["steps"].as_u64().unwrap_or(0),"reason":reason,"nodeId":c.draft["lastNodeId"]});
        let mut db = self.store.lock()?;
        let tx = db.transaction()?;
        let mut route = c.plan.clone();
        route
            .meta
            .as_object_mut()
            .map(|m| m.remove("settingsGuard"));
        Store::guard(&tx, &route)?;
        tx.execute("UPDATE execution_runs SET status='committed',result_json=?,updated_at=? WHERE id=? AND status='running'",params![result.to_string(),Utc::now().to_rfc3339(),c.plan.id])?;
        tx.commit()?;
        drop(db);
        self.store.event(
            &c.plan.id,
            json!({"type":"finished","steps":result["steps"],"reason":reason}),
        )?;
        Ok(())
    }
}

fn merge_budget(shared: &Shared, used: &RunBudget) -> Result<()> {
    let mut parent = shared.lock().map_err(|_| Error::Cancelled)?;
    let current = parent.budget();
    parent.budget.model_requests = current.model_requests.max(used.model_requests);
    parent.budget.tool_calls = current.tool_calls.max(used.tool_calls);
    parent.budget.corrections = current.corrections.max(used.corrections);
    parent.active_before = current.active_ms.max(used.active_ms);
    parent.started = Instant::now();
    parent.budget.active_ms = parent.active_before;
    Ok(())
}
fn dead(state: &Value, settings: &Value) -> bool {
    state["protagonist"]["stats"]["health"]
        .as_f64()
        .is_some_and(|v| v <= 0.0)
        && settings["difficulty"] != "宽松"
}
fn script_finished(state: &Value) -> Option<bool> {
    let beats = state["script"]["beats"]
        .as_array()
        .filter(|a| !a.is_empty())?;
    Some(!beats.iter().any(|b| b["status"] == "todo"))
}

fn prepare_messages(store: &Store, plan: &mut RunPlan, history: &[Value], chapters: &[Value]) -> Result<()> {
    let cap=plan.meta["budgetChars"].as_u64().unwrap_or(24000);
    let mut reference=Value::Null;
    if plan.state["source"].is_object() {
        let query=history.iter().rev().filter_map(|n|n["narrative"].as_str()).take(3).collect::<Vec<_>>().join("\n");
        let original=crate::runtime_sources::read(store,plan,"search_original",&json!({"query":query}))?;
        reference=json!({"bookId":original["bookId"],"title":original["title"],"binding":plan.state["source"],"status":original["status"],"passages":original["excerpts"].as_array().cloned().unwrap_or_default()});
    }
    let saved=&plan.meta["writingContext"];
    let mut template=if saved["template"].is_object(){saved["template"].clone()}else{
        json!({"rules":plan.meta["autoplayTurnSystem"].as_str().or_else(||plan.messages.first().and_then(|m|m["content"].as_str())).unwrap_or(""),"era":"","spec":"","notes":"","action":""})
    };
    template["action"]="".into();
    template["notes"]=history.last().and_then(|n|n["meta"]["notes"].as_array()).map(|a|a.iter().filter_map(Value::as_str).collect::<Vec<_>>().join("；")).unwrap_or_default().into();
    let era=json!({"currency":plan.options["currency"],"clock":plan.options["clock"]});
    let input=json!({"state":plan.state,"settings":plan.settings,"era":era,"template":template,"history":history,"budgetChars":cap,"reference":reference,"mode":"continue","text":"","pins":saved["pins"],"chapters":chapters});
    let context=crate::writing_context::build(&input)?;
    if context["budgetExceeded"]==true{return Err(Error::Invalid(format!("连播上下文{}字符超过{}字符预算，请检查必要状态及要求",context["chars"],cap)));}
    plan.messages=context["messages"].as_array().cloned().unwrap_or_default();
    plan.reference=context.get("reference").filter(|v|v.is_object()).cloned();
    plan.meta["contextUsage"]=json!({"chars":context["chars"],"budgetChars":cap,"layers":context["layers"],"version":context["contextVersion"]});
    let extract = plan.meta["autoplayExtractSystem"]
        .as_str()
        .or_else(|| {
            plan.extract_messages
                .first()
                .and_then(|m| m["content"].as_str())
        })
        .unwrap_or("");
    plan.extract_messages = vec![
        json!({"role":"system","content":extract}),
        json!({"role":"user","content":format!("【当前状态】{}\n【本回合行动】继续\n【本回合正文】\n{{{{NARRATIVE}}}}",plan.state)}),
    ];
    Ok(())
}

fn prepare_organization(plan: &mut RunPlan, history: &[Value], chapters: &[Value]) {
    let newest = history
        .iter()
        .rev()
        .take_while(|n| n["kind"] != "opening" && n["meta"]["upkeep"] != true)
        .filter(|n| n["kind"] == "turn")
        .cloned()
        .collect::<Vec<_>>();
    let every = plan.meta["upkeepEvery"].as_u64().unwrap_or(6) as usize;
    if plan.settings["autoUpkeep"] == true && newest.len() + 1 >= every {
        if let Some(system) = plan.meta["autoplayUpkeepSystem"].as_str() {
            let turns = newest
                .iter()
                .rev()
                .map(|n| n["narrative"].as_str().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n\n");
            plan.meta["upkeepMessages"] = json!([{"role":"system","content":system},{"role":"user","content":format!("【故事设定】{}\n【当前资料、人物、主角状态及玩家删去的项目】{}\n【最近剧情】{}\n{{{{NARRATIVE}}}}",plan.settings["premise"],plan.state,turns)}]);
        }
    }
    let last = chapters.last().map(|c| c["lastNodeId"].clone());
    let pending = history
        .iter()
        .skip(
            last.as_ref()
                .and_then(|id| history.iter().position(|n| &n["id"] == id))
                .map(|i| i + 1)
                .unwrap_or(0),
        )
        .filter(|n| n["kind"] == "turn")
        .collect::<Vec<_>>();
    let every = plan.settings["chapterEvery"]
        .as_u64()
        .or_else(|| plan.meta["chapterEvery"].as_u64())
        .unwrap_or(0) as usize;
    if every > 0 && pending.len() + 1 >= every && (pending.len() + 1 - every) % 3 == 0 {
        if let Some(system) = plan.meta["autoplayChapterSystem"].as_str() {
            let story = pending
                .iter()
                .map(|n| n["narrative"].as_str().unwrap_or(""))
                .collect::<Vec<_>>()
                .join("\n\n");
            plan.meta["chapterMessages"] = json!([{"role":"system","content":system},{"role":"user","content":format!("【故事设定】{}\n【主角】{}\n【前几章】{}\n【本章剧情】{}\n{{{{NARRATIVE}}}}",plan.settings["premise"],plan.state["protagonist"]["name"],chapters.iter().map(|c|json!({"title":c["title"],"gist":c["gist"]})).collect::<Vec<_>>().iter().map(Value::to_string).collect::<Vec<_>>().join("\n"),story)}]);
            plan.meta["chapterFirstId"] = pending
                .first()
                .map(|n| n["id"].clone())
                .unwrap_or_else(|| json!("{{NODE_ID}}"));
        }
    }
}
