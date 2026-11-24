//! A whole spectator sequence belongs to the native owner, including the
//! pauses between passages. Child turns keep ordinary transactional settlement.
use crate::{
    runtime::{Context, Engine, Shared},
    Error, Result, RunBudget, RunPlan, Store,
};
use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
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
    text_hash: String,
}

/// Read only chapter gists, independently of the bounded prose window.
fn chapters_on_route(db: &Connection, world_id: &str, head_id: &str) -> Result<Vec<Value>> {
    let mut query = db.prepare(
        "WITH RECURSIVE route(id) AS (
            SELECT id FROM nodes WHERE world_id=?1 AND id=?2
            UNION
            SELECT n.parent_id FROM nodes n JOIN route r ON n.id=r.id
            WHERE n.world_id=?1 AND n.parent_id IS NOT NULL
         )
         SELECT c.first_node_id, c.last_node_id, c.title, c.gist, COALESCE(c.stale,0)
         FROM chapters c
         JOIN route start ON start.id=c.first_node_id
         JOIN route finish ON finish.id=c.last_node_id
         JOIN nodes first ON first.id=start.id AND first.world_id=?1
         JOIN nodes last ON last.id=finish.id AND last.world_id=?1
         WHERE c.world_id=?1 AND first.seq<=last.seq
         ORDER BY last.seq, c.created_at, c.id",
    )?;
    let rows = query.query_map(params![world_id, head_id], |row| {
        Ok(json!({
            "firstNodeId":row.get::<_, String>(0)?,
            "lastNodeId":row.get::<_, String>(1)?,
            "title":row.get::<_, String>(2)?,
            "gist":row.get::<_, String>(3)?,
            "stale":row.get::<_, i64>(4)? != 0,
        }))
    })?;
    Ok(rows.collect::<std::result::Result<Vec<_>, _>>()?)
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
            let mut plan = self.store.plan(&initial.id)?;
            // The stored plan does not carry a continued run's pause point (D159).
            if initial.meta["resumeBudgetBase"].is_object() { plan.meta["resumeBudgetBase"] = initial.meta["resumeBudgetBase"].clone(); }
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
            let live = self.autoplay_live(&plan, true)?;
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
                    self.store.finish(&child_id, "interrupted", None, None)?;
                }
                let previous = self.store.plan(&child_id)?;
                let changed = previous.meta["autoplayTextHash"].as_str() != Some(&live.text_hash);
                if changed {
                    let existing_note = previous.action["directorNote"].as_str().map(str::to_owned);
                    let pending_note = take_pending_director_note(&self.store, &plan.id)?.or(existing_note);
                    let mut fresh = self.autoplay_plan(&plan, live, index, total, pending_note)?;
                    if let Some(base) = previous.meta.get("stepBudgetBase") {
                        fresh.meta["stepBudgetBase"] = base.clone();
                    }
                    self.store.owned(&plan, |tx| {
                        Store::guard(tx, &fresh)?;
                        // Keep usage and error history, but do not replay replies for the older prose.
                        tx.execute("UPDATE execution_runs SET plan_json=?,draft_json='{}' WHERE id=?",
                            params![serde_json::to_string(&fresh)?, child_id])?;
                        tx.execute("UPDATE execution_steps SET status='stale' WHERE run_id=? AND status='done'", [&child_id])?;
                        Ok(())
                    })?;
                    self.emit_run_event(&plan, json!({"type":"text","delta":"","full":""}))?;
                }
                self.store.resume(&child_id)?;
                (self.store.plan(&child_id)?, if changed { json!({}) } else { saved.draft }, saved.budget)
            } else {
                let pending_note = take_pending_director_note(&self.store, &plan.id)?;
                let mut child = self.autoplay_plan(&plan, live, index, total, pending_note)?;
                if plan.meta["autoplayBudgetVersion"]=="per-passage-1"{child.meta["stepBudgetBase"]=serde_json::to_value(shared.lock().map_err(|_|Error::Cancelled)?.budget())?;}
                self.store.register(&child)?;
                (child, json!({}), RunBudget::default())
            };
            // A sequence continued after a pause hands its new starting point to each passage (D159).
            let mut child_plan = child_plan;
            if initial.meta["resumeBudgetBase"].is_object() { child_plan.meta["resumeBudgetBase"] = initial.meta["resumeBudgetBase"].clone(); }
            merge_budget(&shared, &previous_budget)?;
            let (budget, cancel) = {
                let mut parent = shared.lock().map_err(|_| Error::Cancelled)?;
                parent.draft["childId"] = child_id.clone().into();
                (parent.budget(), parent.cancel.child_token())
            };
            self.checkpoint(&shared)?;
            let step_note = child_plan.action.get("directorNote").cloned().unwrap_or(Value::Null);
            self.emit_run_event(&plan, json!({"type":"step","index":index,"total":total,"directorNote":step_note}))?;
            let child = Arc::new(Mutex::new(Context::new(child_plan.clone(), budget, child_draft, cancel)));
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
                    Error::SystemStop(_) => "interrupted",
                    _ => "failed",
                };
                let failure = child.lock().map_err(|_| Error::Cancelled)?.failure(&error);
                self.store
                    .finish(&child_id, status, Some(&error), Some(&failure))?;
                self.flush_usage(&child_id, status)?;
                // A terminal event can fail after the child committed. Keep
                // the parent's atomic route/step update before checkpointing.
                let saved = self.store.snapshot(&plan.id, 0)?;
                let persisted_plan = self.store.plan(&plan.id)?;
                {
                    let mut parent = shared.lock().map_err(|_| Error::Cancelled)?;
                    parent.stage = child.lock().map_err(|_| Error::Cancelled)?.stage;
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
            let after = self.autoplay_live(&latest, false)?;
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

    fn autoplay_live(&self, plan: &RunPlan, capture_text: bool) -> Result<Live> {
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
        if plan.meta["autoplayPilot"]=="temporary-ai" {settings["pilot"]="ai".into();}
        let state: String = tx.query_row(
            "SELECT state_json FROM states WHERE node_id=?",
            [&plan.head_id],
            |r| r.get(0),
        )?;
        let state: Value = serde_json::from_str(&state)?;
        let mut statement = tx.prepare("WITH RECURSIVE path AS (SELECT id,parent_id,seq,kind,action_text,narrative,meta_json,action_mode,rewritten FROM nodes WHERE id=? UNION ALL SELECT n.id,n.parent_id,n.seq,n.kind,n.action_text,n.narrative,n.meta_json,n.action_mode,n.rewritten FROM nodes n JOIN path p ON n.id=p.parent_id) SELECT id,kind,action_text,narrative,meta_json,action_mode,rewritten FROM path ORDER BY seq DESC LIMIT 200")?;
        let rows = statement.query_map([&plan.head_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, Option<String>>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<i64>>(6)?.unwrap_or(0) != 0,
            ))
        })?;
        let mut history = vec![];
        for row in rows {
            let (id, kind, action, narrative, meta, action_mode, rewritten) = row?;
            history.push(json!({"id":id,"kind":kind,"actionText":action,"actionMode":action_mode,"narrative":narrative,"meta":serde_json::from_str::<Value>(&meta)?,"rewritten":rewritten}));
        }
        drop(statement);
        history.reverse();
        let chapters = chapters_on_route(&tx, &plan.world_id, &plan.head_id)?;
        let text_hash = if capture_text { route_text_hash(&tx, &plan.world_id, &plan.head_id)? } else { String::new() };
        Ok(Live {
            state,
            settings,
            raw_settings,
            history,
            chapters,
            text_hash,
        })
    }

    fn autoplay_plan(&self, parent: &RunPlan, live: Live, index: u64, total: u64, director_note: Option<String>) -> Result<RunPlan> {
        let mut plan = parent.clone();
        let true_spectator = parent.meta["autoplayPilot"] != "temporary-ai"
            && live
                .raw_settings
                .get("pilot")
                .and_then(Value::as_str)
                .or_else(|| parent.settings.get("pilot").and_then(Value::as_str))
                == Some("ai");
        let player_choices_on_exit = !true_spectator && index >= total;
        plan.id = format!("{}:step:{index}", parent.id);
        plan.kind = "turn".into();
        plan.base_id = Some(parent.head_id.clone());
        plan.state = live.state;
        plan.settings = live.settings;
        let step_depth = crate::writing_context::normalize_depth(
            plan.settings["depth"]
                .as_str()
                .filter(|s| matches!(*s, "fast" | "standard" | "deep"))
                .or_else(|| plan.meta["depth"].as_str()),
        );
        plan.settings["depth"] = step_depth.into();
        plan.meta["depth"] = step_depth.into();
        if crate::runtime_sources::notes_only(&plan) || !plan.state["source"].is_object() {
            if let Some(m) = plan.meta.as_object_mut() {
                m.remove("referenceReviewVersion");
            }
        } else {
            let review_ver = match step_depth {
                "deep" => Some("reference-review-4"),
                "standard" if plan.state["source"]["fanfic"] == true => Some("reference-review-lite-5"),
                _ => None,
            };
            match review_ver {
                Some(v) => plan.meta["referenceReviewVersion"] = v.into(),
                None => {
                    if let Some(m) = plan.meta.as_object_mut() {
                        m.remove("referenceReviewVersion");
                    }
                }
            }
        }
        if index < total {
            // Intermediate autoplay steps continue immediately; never trigger a fallback extract call just for unused choices.
            plan.settings["choiceCount"] = 0.into();
        }
        let director_note = director_note.map(|s| s.trim().to_owned()).filter(|s| !s.is_empty());
        plan.action = match &director_note {
            Some(note) => json!({"mode":"continue","text":"","directorNote":note}),
            None => json!({"mode":"continue","text":""}),
        };
        plan.original.clear();
        plan.carried_edits.clear();
        plan.trailing_ids.clear();
        plan.new_world = None;
        for key in [
            "upkeepMessages",
            "upkeepTextGuard",
            "chapterMessages",
            "chapterTextGuard",
            "chapterFirstId",
            "targetId",
            "rewriteHint",
        ] {
            plan.meta.as_object_mut().map(|m| m.remove(key));
        }
        plan.meta["parentRun"] = parent.id.clone().into();
        plan.meta["autoplayIndex"] = index.into();
        plan.meta["autoplayPromptVersion"] = "autoplay-1".into();
        plan.meta["autoplayTextHash"] = live.text_hash.into();
        plan.meta["settingsGuard"] = live.raw_settings;
        plan.meta["sourceGuard"] = plan.state.get("source").cloned().unwrap_or(Value::Null);
        plan.options["mode"] = "continue".into();
        plan.options["difficulty"] = plan.settings["difficulty"].clone();
        let fortune_mode = effective_fortune_mode(&plan.settings, &plan.state).to_owned();
        let rolled_fortune = if fortune_mode == "off" {
            None
        } else if index == 1 && parent.options["fortune"].as_str().is_some_and(|s| !s.is_empty()) {
            parent.options["fortune"].as_str().map(str::to_owned)
        } else {
            Some(roll_step_fortune(
                plan.settings["difficulty"].as_str().unwrap_or("标准"),
                &parent.id,
                index,
                &plan.head_id,
            ))
        };
        plan.options["fortune"] = if fortune_mode == "on" {
            rolled_fortune.clone().map(Value::String).unwrap_or(Value::Null)
        } else {
            Value::Null
        };
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
            ("timeStyle", &plan.state["era"]["timeStyle"]),
            ("date", &plan.state["time"]["date"]),
            ("hour", &plan.state["time"]["startHour"]),
            ("rules", &plan.state["era"]["calendar"]),
            ("label", &plan.state["time"]["start"]),
        ] {
            if !source.is_null() {
                clock[key] = source.clone();
            }
        }
        for key in ["anchor", "elapsedAnchor"] {
            if let Some(val) = plan.state["time"].get(key) {
                clock[key] = val.clone();
            }
        }
        plan.options["clock"] = clock;
        prepare_messages(
            &self.store,
            &mut plan,
            &live.history,
            &live.chapters,
            director_note.as_deref(),
            rolled_fortune.as_deref(),
            &fortune_mode,
            player_choices_on_exit,
        )?;
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
        let mut c = shared.lock().map_err(|_| Error::Cancelled)?;
        let mut result = json!({"steps":c.draft["steps"].as_u64().unwrap_or(0),"reason":reason,"nodeId":c.draft["lastNodeId"]});
        let mut db = self.store.lock()?;
        let tx = db.transaction()?;
        let mut route = c.plan.clone();
        route
            .meta
            .as_object_mut()
            .map(|m| m.remove("settingsGuard"));
        Store::guard(&tx, &route)?;
        let note_key = format!("autoplayNote:{}", c.plan.id);
        let unused_note: Option<String> = tx
            .query_row("SELECT value FROM settings WHERE key=?", [&note_key], |r| r.get::<_, String>(0))
            .optional()?
            .and_then(|v| serde_json::from_str::<String>(&v).ok().or(Some(v)))
            .map(|s| s.trim().to_owned())
            .filter(|s| !s.is_empty());
        let _ = tx.execute("DELETE FROM settings WHERE key=?", [&note_key]);
        if let Some(note) = &unused_note {
            c.draft["unusedDirectorNote"] = json!(note);
            result["unusedDirectorNote"] = json!(note);
            let _ = tx.execute(
                "INSERT INTO settings(key, value) VALUES(?1, ?2) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                params![format!("autoplayUnusedNote:{}", c.plan.world_id), serde_json::to_string(note)?],
            );
        }
        tx.execute(
            "UPDATE execution_runs SET status='committed',draft_json=?,result_json=?,updated_at=? WHERE id=? AND status='running'",
            params![c.draft.to_string(), result.to_string(), Utc::now().to_rfc3339(), c.plan.id],
        )?;
        tx.commit()?;
        drop(db);
        let mut fin_event = json!({"type":"finished","steps":result["steps"],"reason":reason});
        if let Some(note) = &unused_note {
            fin_event["unusedDirectorNote"] = json!(note);
        }
        let finished = self.store.event(&c.plan.id, fin_event)?;
        self.push_live_event(&c.plan, finished.seq, &finished.event);
        let completion = c.draft["lastNodeId"]
            .as_str()
            .filter(|id| !id.is_empty() && result["steps"].as_u64().unwrap_or(0) > 0)
            .map(|node_id| format!("{}:{}", c.plan.world_id, node_id));
        drop(c);
        if let Some(id) = completion {
            (self.committed)(id);
        }
        Ok(())
    }
}

fn route_text_hash(db: &Connection, world: &str, head: &str) -> Result<String> {
    let mut statement = db.prepare("WITH RECURSIVE route(id,parent_id) AS (
        SELECT id,parent_id FROM nodes WHERE world_id=?1 AND id=?2
        UNION SELECT n.id,n.parent_id FROM nodes n JOIN route r ON n.id=r.parent_id WHERE n.world_id=?1
      ) SELECT n.id,n.narrative FROM route r JOIN nodes n ON n.id=r.id WHERE n.kind<>'edit' ORDER BY n.seq")?;
    let mut rows = statement.query(params![world, head])?;
    let mut hash = Sha256::new();
    while let Some(row) = rows.next()? {
        for column in 0..2 {
            let value: String = row.get(column)?;
            hash.update((value.len() as u64).to_le_bytes());
            hash.update(value.as_bytes());
        }
    }
    Ok(format!("{:x}", hash.finalize()))
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

fn take_pending_director_note(store: &Store, run_id: &str) -> Result<Option<String>> {
    let key = format!("autoplayNote:{run_id}");
    let mut db = store.lock()?;
    let tx = db.transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)?;
    let raw: Option<String> = tx
        .query_row("SELECT value FROM settings WHERE key=?", [&key], |r| r.get(0))
        .optional()?;
    let note = raw
        .as_deref()
        .and_then(|v| serde_json::from_str::<String>(v).ok().or_else(|| Some(v.to_owned())))
        .map(|s| s.trim().to_owned())
        .filter(|s| !s.is_empty());
    if raw.is_some() {
        tx.execute("DELETE FROM settings WHERE key=?", [&key])?;
    }
    tx.commit()?;
    Ok(note)
}

fn note_within_scope(kind: &str, scope: &Value, refs: &[i64], through: Option<i64>, same_world: bool) -> bool {
    let Some(limit) = through else { return true; };
    if refs.iter().any(|&s| s < 0 || s > limit) {
        return false;
    }
    if matches!(kind, "plot" | "timeline") {
        return scope["to"].as_i64().is_some_and(|to| to <= limit);
    }
    if scope["through"].as_i64().is_some_and(|t| t >= 0 && t <= limit) {
        return refs.len() < 400;
    }
    (!refs.is_empty() || (kind == "question" && same_world)) && refs.len() < 400
}

fn note_named(scope: &Value, recent: &str) -> bool {
    if let Some(sub) = scope["subject"].as_str().map(str::trim).filter(|s| !s.is_empty()) {
        if recent.contains(sub) {
            return true;
        }
    }
    scope["aliases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
        .any(|name| recent.contains(name))
}

fn note_asked(scope: &Value, title: &str, recent: &str) -> bool {
    let q = scope["question"].as_str().unwrap_or(title);
    let pairs = crate::recall::pairs_of(q);
    pairs.iter().filter(|p| recent.contains(p.as_str())).count() >= 2
}

fn clip_note_content(content: &str, cap: usize) -> String {
    if content.chars().count() <= cap {
        return content.to_owned();
    }
    // Keep complete lines up to `cap` instead of slicing mid-sentence.
    let mut out = String::new();
    let mut used = 0usize;
    for line in content.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() {
            continue;
        }
        let len = trimmed.chars().count();
        let sep = if out.is_empty() { 0 } else { 1 };
        if used + sep + len <= cap {
            if sep > 0 {
                out.push('\n');
            }
            out.push_str(trimmed);
            used += sep + len;
        } else if out.is_empty() {
            out = trimmed.chars().take(cap).collect();
            break;
        } else {
            break;
        }
    }
    out
}

/// Refresh active story & book canon notes per autoplay step instead of keeping
/// step-0's frozen snapshot (R31-P4).
fn dynamic_canon_notes(store: &Store, plan: &RunPlan, history: &[Value], director_note: &str) -> Result<Vec<Value>> {
    let mut recent = history
        .iter()
        .rev()
        .filter(|n| n["kind"] != "edit")
        .filter_map(|n| n["narrative"].as_str())
        .take(3)
        .collect::<Vec<_>>()
        .join("\n");
    if !director_note.is_empty() {
        recent.push('\n');
        recent.push_str(director_note);
    }
    let db = store.lock()?;
    let mut ranked: Vec<(u8, Value)> = Vec::new();
    // 1. This story's own active notes (story_notes), skipping off-route notes.
    let mut route_ids: Option<std::collections::HashSet<String>> = None;
    let mut stmt = db.prepare(
        "SELECT kind, title, scope_json, content, progress_json, origin_world_id, origin_title
         FROM story_notes
         WHERE world_id=? AND active=1 AND status='done' AND TRIM(content)<>''
         ORDER BY updated_at DESC",
    )?;
    let story_rows = stmt
        .query_map([&plan.world_id], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, String>(1)?,
                r.get::<_, String>(2)?,
                r.get::<_, String>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, Option<String>>(5)?,
                r.get::<_, Option<String>>(6)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    drop(stmt);
    for (kind, title, scope_raw, content, progress_raw, origin_world_id, origin_title) in story_rows {
        let scope: Value = serde_json::from_str(&scope_raw).unwrap_or_default();
        let progress: Value = serde_json::from_str(&progress_raw).unwrap_or_default();
        let carried = origin_world_id.is_some();
        let route_anchor = scope["toNode"].as_str().or_else(|| progress["routeNode"].as_str());
        if !carried {
            if let Some(anchor) = route_anchor {
                let ids = route_ids.get_or_insert_with(|| {
                    let mut set = std::collections::HashSet::new();
                    if let Ok(mut q) = db.prepare(
                        "WITH RECURSIVE route(id) AS (
                            SELECT id FROM nodes WHERE world_id=?1 AND id=?2
                            UNION ALL
                            SELECT n.parent_id FROM nodes n JOIN route r ON n.id=r.id
                            WHERE n.world_id=?1 AND n.parent_id IS NOT NULL
                        ) SELECT id FROM route",
                    ) {
                        if let Ok(rows) = q.query_map(params![&plan.world_id, &plan.head_id], |r| r.get::<_, String>(0)) {
                            for id in rows.flatten() {
                                set.insert(id);
                            }
                        }
                    }
                    set
                });
                if !ids.contains(anchor) {
                    continue;
                }
            }
        }
        let brief_title = if let Some(origin) = origin_title.as_deref().filter(|s| !s.is_empty()) {
            format!("{title}（前作《{origin}》）")
        } else {
            title.clone()
        };
        let prio = if kind == "plot" && !carried {
            Some(0)
        } else if matches!(kind.as_str(), "person" | "setting") && note_named(&scope, &recent) {
            Some(if carried { 4 } else { 2 })
        } else if kind == "question" && note_asked(&scope, &title, &recent) {
            Some(if carried { 4 } else { 2 })
        } else if carried && matches!(kind.as_str(), "plot" | "timeline") {
            Some(5)
        } else {
            None
        };
        if let Some(p) = prio {
            ranked.push((p, json!({
                "title": brief_title,
                "kind": kind,
                "content": clip_note_content(&content, 2400),
                "source": "story",
            })));
        }
    }
    // 2. Bound book's canon_notes within allowed reading scope.
    if let Some(book_id) = plan.state["source"]["bookId"].as_str().filter(|s| !s.is_empty()) {
        let position = plan.state["source"]["position"].as_i64().unwrap_or(0);
        let through = plan.state["source"]["through"].as_i64();
        let mut stmt = db.prepare(
            "SELECT kind, title, scope_json, content, refs_json, world_id
             FROM canon_notes
             WHERE book_id=?1 AND (world_id IS NULL OR world_id=?2)
               AND active=1 AND status='done' AND TRIM(content)<>''
             ORDER BY updated_at DESC",
        )?;
        let book_rows = stmt
            .query_map(params![book_id, &plan.world_id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, Option<String>>(5)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        drop(stmt);
        let mut covering = Vec::new();
        let mut before: Vec<(i64, Value)> = Vec::new();
        for (kind, title, scope_raw, content, refs_raw, note_world_id) in book_rows {
            let scope: Value = serde_json::from_str(&scope_raw).unwrap_or_default();
            let refs: Vec<i64> = serde_json::from_str(&refs_raw).unwrap_or_default();
            let same_world = note_world_id.as_deref() == Some(plan.world_id.as_str());
            if !note_within_scope(&kind, &scope, &refs, through, same_world) {
                continue;
            }
            let item = json!({
                "title": title,
                "kind": kind,
                "content": clip_note_content(&content, 2400),
                "source": "book",
            });
            if matches!(kind.as_str(), "plot" | "timeline") {
                let from = scope["from"].as_i64().unwrap_or(0);
                let to = scope["to"].as_i64().unwrap_or(i64::MAX);
                if from <= position && position <= to {
                    covering.push(item);
                } else if to < position {
                    before.push((to, item));
                }
            } else if (matches!(kind.as_str(), "person" | "setting") && note_named(&scope, &recent))
                || (kind == "question" && note_asked(&scope, &title, &recent))
            {
                ranked.push((3, item));
            }
        }
        if !covering.is_empty() {
            for item in covering {
                ranked.push((1, item));
            }
        } else if let Some((_, item)) = before.into_iter().max_by_key(|(to, _)| *to) {
            ranked.push((1, item));
        }
    }
    ranked.sort_by_key(|(p, _)| *p);
    Ok(ranked.into_iter().map(|(_, item)| item).collect())
}

fn effective_fortune_mode<'a>(settings: &'a Value, state: &Value) -> &'a str {
    match settings["fortune"].as_str() {
        Some("on") => "on",
        Some("hint") => "hint",
        Some("off") => "off",
        _ if state["challenge"]["status"] == "active" => "on",
        _ => "off",
    }
}

fn roll_step_fortune(difficulty: &str, run_id: &str, index: u64, head_id: &str) -> String {
    const FORTUNES: [&str; 5] = ["大顺", "顺", "平", "不顺", "大不顺"];
    let weights: [u32; 5] = match difficulty {
        "宽松" => [12, 35, 38, 12, 3],
        "残酷" => [4, 16, 35, 33, 12],
        _ => [5, 25, 45, 20, 5],
    };
    let mut hasher = Sha256::new();
    hasher.update(run_id.as_bytes());
    hasher.update(b":");
    hasher.update(index.to_le_bytes());
    hasher.update(b":");
    hasher.update(head_id.as_bytes());
    let digest = hasher.finalize();
    let sample = u32::from_le_bytes([digest[0], digest[1], digest[2], digest[3]]) % weights.iter().sum::<u32>();
    let mut acc = 0u32;
    for (i, w) in weights.iter().enumerate() {
        acc += w;
        if sample < acc {
            return FORTUNES[i].to_owned();
        }
    }
    "平".to_owned()
}

fn fortune_prompt_note(fortune: Option<&str>, mode: &str) -> String {
    let Some(f) = fortune.filter(|_| mode != "off") else {
        return String::new();
    };
    const PLAUSIBLE: &str = "成败先看情理：局面悬殊的（人多势众、实力或准备远胜对方，或者本来就容易、本来就办不到的事），按情理写，运势最多影响代价和细节，不翻转结果。要合情合理，不写荒唐的倒霉，也不写荒唐的走运。没有风险的日常行动不受运势影响，也不要在正文里提运势。";
    if mode == "on" {
        let detail = match f {
            "大顺" => "大顺——玩家这次的行动若有风险、胜负难料，结果顺利，还可能有意外之喜。",
            "顺" => "顺——玩家这次的行动若有风险、胜负难料，结果多半顺利，最多小有波折。",
            "不顺" => "不顺——玩家这次的行动若有风险、胜负难料，结果多半受阻，或要付出代价。",
            "大不顺" => "大不顺——玩家这次的行动若有风险、胜负难料，结果失败，还可能节外生枝。",
            _ => "平——玩家这次的行动若有风险，按情理决定成败。",
        };
        format!("\n【本回合运势（玩家看不到）】{detail}{PLAUSIBLE}")
    } else {
        let detail = match f {
            "大顺" => "大顺——胜负难料时偏向顺利，可以有点小惊喜。",
            "顺" => "顺——胜负难料时稍稍偏向顺利。",
            "不顺" => "不顺——胜负难料时稍稍偏向受阻，或多些波折、小代价。",
            "大不顺" => "大不顺——胜负难料时偏向失手；占上风的事也可能出点小岔子，但不推翻明摆着的结果。",
            _ => "平——完全按情理。",
        };
        format!("\n【本回合运势（玩家看不到，只作参考）】{detail}运势只是一点倾向，只在胜负确实难料（双方相当、全凭运气）时起作用，顺就多些顺手，不顺就多些波折。{PLAUSIBLE}")
    }
}

fn era_taboo_line(plan: &RunPlan) -> Option<String> {
    if plan.settings["mode"] == "free" || plan.state["era"]["mode"] == "free" {
        return None;
    }
    let from_cards = plan.state["cards"]
        .as_array()
        .and_then(|cards| cards.iter().find(|c| c["kind"] == "时代"))
        .and_then(|c| c["content"].as_str());
    let from_template = plan.meta["writingContext"]["template"]["era"].as_str();
    for source in [from_cards, from_template].into_iter().flatten() {
        for line in source.lines() {
            if let Some(rest) = line.trim_start().strip_prefix("不要出现") {
                if let Some(items) = rest.trim_start().strip_prefix(['：', ':']) {
                    let trimmed = items.trim();
                    if !trimmed.is_empty() {
                        return Some(trimmed.to_owned());
                    }
                }
            }
        }
    }
    None
}

fn taboo_reminder_for_last_turn(plan: &RunPlan, history: &[Value]) -> String {
    if plan.settings["mode"] == "free"
        || plan.state["era"]["mode"] == "free"
        || plan.settings["tabooHints"] == false
    {
        return String::new();
    }
    let Some(last_text) = history
        .iter()
        .rev()
        .find(|n| n["kind"] != "edit")
        .and_then(|n| n["narrative"].as_str())
        .filter(|s| !s.is_empty())
    else {
        return String::new();
    };
    let Some(raw_line) = era_taboo_line(plan) else {
        return String::new();
    };
    let mut hits = Vec::new();
    for item in raw_line.split(['；', ';', '、']).map(str::trim).filter(|s| !s.is_empty()) {
        let (term_part, instead) = if let Some((head, tail)) = item.split_once(['（', '(']) {
            let hint = tail.trim_end_matches(['）', ')']).trim();
            (head.trim(), (!hint.is_empty()).then_some(hint))
        } else {
            (item, None)
        };
        for term in term_part.split('/').map(str::trim).filter(|t| t.chars().count() >= 2) {
            if last_text.contains(term) {
                hits.push(match instead {
                    Some(ins) => format!("“{term}”（该用：{ins}）"),
                    None => format!("“{term}”"),
                });
                break;
            }
        }
    }
    if hits.is_empty() {
        String::new()
    } else {
        format!(
            "\n【用词提醒】上一段用了这个时代不该有的说法：{}。之后不要再用，已经写出的不必解释。",
            hits.join("、")
        )
    }
}

fn apply_protagonist_exit_choices(template: &mut Value, extract_sys: &mut String, choice_count: i64) {
    if choice_count <= 0 {
        return;
    }
    let spec_dir = " \"choices\":[\"接下来的一种走向\",\"另一种走向\"]}";
    let spec_act = " \"choices\":[\"建议行动1\",\"建议行动2\",\"建议行动3\"]}";
    if let Some(spec) = template["spec"].as_str() {
        template["spec"] = spec.replace(spec_dir, spec_act).into();
    }
    let spectator_rule = "记录里给 2～3 个“接下来可以怎样发展”的短句（各不超过二十字），写成事件或局面走向、不以主角作主语（如“旧识带来一个坏消息”“让日子先平静几天”），供玩家在幕后挑选";
    let player_rule = format!("记录里给 {choice_count} 个简短、不同的建议行动（各不超过二十字），由玩家选择");
    if let Some(rules) = template["rules"].as_str() {
        if rules.contains(spectator_rule) {
            template["rules"] = rules.replace(spectator_rule, &player_rule).into();
        } else {
            template["rules"] = format!("{rules}\n- 本段结束后将交还玩家扮演主角：{player_rule}。").into();
        }
    }
    *extract_sys = extract_sys.replace(spec_dir, spec_act);
    let extract_spectator = "choices 给 2～3 个“接下来可以怎样发展”的短句（各不超过二十字，写成事件或局面走向、不以主角作主语）。";
    let extract_player = format!("choices 给 {choice_count} 个简短、不同的建议行动（各不超过二十字）。");
    if extract_sys.contains(extract_spectator) {
        *extract_sys = extract_sys.replace(extract_spectator, &extract_player);
    } else if !extract_sys.contains("建议行动") {
        extract_sys.push_str(&format!("\n{extract_player}"));
    }
}

fn prepare_messages(
    store: &Store,
    plan: &mut RunPlan,
    history: &[Value],
    chapters: &[Value],
    director_note: Option<&str>,
    fortune: Option<&str>,
    fortune_mode: &str,
    player_choices_on_exit: bool,
) -> Result<()> {
    let cap=plan.meta["budgetChars"].as_u64().unwrap_or(24000);
    let mut reference=Value::Null;
    let note_str = director_note.unwrap_or("").trim();
    if plan.state["source"].is_object() {
        // Keep query focused on director note (if any) so search_original ranks by active entities,
        // place, instructions and current book position instead of drowning in 3 full narratives.
        let original=crate::runtime_sources::read(store,plan,"search_original",&json!({"query":note_str}))?;
        reference=json!({"bookId":original["bookId"],"title":original["title"],"binding":plan.state["source"],"status":original["status"],"passages":original["excerpts"].as_array().cloned().unwrap_or_default()});
    }
    let saved=&plan.meta["writingContext"];
    let mut template=if saved["template"].is_object(){saved["template"].clone()}else{
        json!({"rules":plan.meta["autoplayTurnSystem"].as_str().or_else(||plan.messages.first().and_then(|m|m["content"].as_str())).unwrap_or(""),"era":"","spec":"","notes":"","action":""})
    };
    // Keep action empty so writing_context::build emits the standard 【继续】 header + directorNote + <record> reminder (B17).
    template["action"] = "".into();
    let ledger_notes = history
        .iter()
        .rev()
        .find(|n| n["kind"] != "edit")
        .and_then(|n| n["meta"]["notes"].as_array())
        .map(|a| a.iter().filter_map(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).collect::<Vec<_>>())
        .filter(|v| !v.is_empty())
        .map(|v| format!("\n【上回合的实际结果，请在叙述中自然体现】\n- {}", v.join("\n- ")))
        .unwrap_or_default();
    let taboo_note = taboo_reminder_for_last_turn(plan, history);
    let luck_note = fortune_prompt_note(fortune, fortune_mode);
    template["notes"] = format!("{ledger_notes}{taboo_note}{luck_note}").into();
    let mut extract_sys = plan.meta["autoplayExtractSystem"]
        .as_str()
        .or_else(|| {
            plan.extract_messages
                .first()
                .and_then(|m| m["content"].as_str())
        })
        .unwrap_or("")
        .to_owned();
    if player_choices_on_exit {
        let choice_count = plan.settings["choiceCount"].as_i64().unwrap_or(3);
        apply_protagonist_exit_choices(&mut template, &mut extract_sys, choice_count);
    }
    extract_sys = crate::stage_context::enrich_extract_system(&extract_sys, &plan.state);
    let era=json!({"currency":plan.options["currency"],"clock":plan.options["clock"]});
    // 相关旧事 numbers passages from the opening; history holds the last 200.
    let total: i64 = store.lock()?.query_row("WITH RECURSIVE path AS (SELECT id,parent_id,kind FROM nodes WHERE id=? UNION ALL SELECT n.id,n.parent_id,n.kind FROM nodes n JOIN path p ON n.id=p.parent_id) SELECT COUNT(*) FROM path WHERE kind<>'edit'", [&plan.head_id], |r| r.get(0))?;
    let offset = (total as usize).saturating_sub(history.iter().filter(|n| n["kind"] != "edit").count());
    let refreshed_notes = dynamic_canon_notes(store, plan, history, note_str).unwrap_or_default();
    let canon_notes = if !refreshed_notes.is_empty() {
        Value::Array(refreshed_notes)
    } else {
        saved["canonNotes"].clone()
    };
    let step_depth = crate::writing_context::normalize_depth(
        plan.meta["depth"]
            .as_str()
            .filter(|s| matches!(*s, "fast" | "standard" | "deep"))
            .or_else(|| plan.settings["depth"].as_str()),
    );
    let input=json!({"state":plan.state,"settings":plan.settings,"depth":step_depth,"era":era,"template":template,"history":history,"historyOffset":offset,"budgetChars":cap,"reference":reference,"mode":"continue","text":"","directorNote":note_str,"pins":saved["pins"],"chapters":chapters,"canonNotes":canon_notes});
    let mut input=input;
    let fact_ids = plan.state["facts"].as_array().into_iter().flatten()
        .filter(|fact| fact["origin"] == "ai").filter_map(|fact| fact["nodeId"].as_str()).collect::<Vec<_>>();
    if !fact_ids.is_empty() {
        let db = store.lock()?;
        let mut statement = db.prepare("SELECT DISTINCT n.id FROM json_each(?1) f JOIN nodes n ON n.id=f.value WHERE n.world_id=?2 AND n.rewritten<>0")?;
        let ids = statement.query_map(params![serde_json::to_string(&fact_ids)?, plan.world_id], |row| row.get::<_, String>(0))?
            .collect::<rusqlite::Result<Vec<_>>>()?;
        input["editedFactNodeIds"] = json!(ids);
    }
    input["continuity"]=crate::continuity::project(&*store.lock()?,&plan.world_id,plan.base_id.as_deref().unwrap_or(&plan.head_id)).unwrap_or_else(|_|json!({"unavailable":true}));
    let context=crate::writing_context::build(&input)?;
    plan.messages=context["messages"].as_array().cloned().unwrap_or_default();
    plan.reference=context.get("reference").filter(|v|v.is_object()).cloned();
    plan.meta["contextUsage"]=json!({"chars":context["chars"],"budgetChars":cap,"layers":context["layers"],"version":context["contextVersion"]});
    let modes_prompt = crate::stage_context::active_modes_prompt(&plan.state);
    let action_desc = if note_str.is_empty() {
        "继续".to_owned()
    } else {
        format!("继续（幕后要求：{note_str}）")
    };
    plan.extract_messages = vec![
        json!({"role":"system","content":extract_sys}),
        json!({"role":"user","content":format!("【当前状态】{}{}\n【本回合行动】{action_desc}\n【本回合正文】\n{{{{NARRATIVE}}}}",crate::stage_context::state(&plan.state,"",(cap as usize/5).min(3000)),modes_prompt)}),
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
            let taboos = era_taboo_line(plan);
            let prefix = crate::stage_context::upkeep_roster_prefix(&plan.state, &plan.settings, taboos.as_deref());
            let raw_messages = vec![
                json!({"role":"system","content":system}),
                json!({"role":"user","content":format!("{prefix}\n\n【最近的剧情】\n{turns}\n\n{{{{NARRATIVE}}}}")}),
            ];
            plan.meta["upkeepMessages"] = json!(crate::stage_context::organization(plan, &raw_messages, "{{NARRATIVE}}"));
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chapters_follow_route_endpoints_beyond_the_prose_window() {
        let db = Connection::open_in_memory().unwrap();
        db.execute_batch(
            "CREATE TABLE nodes(id TEXT PRIMARY KEY, parent_id TEXT, world_id TEXT, seq INT);
             CREATE TABLE chapters(id TEXT PRIMARY KEY, first_node_id TEXT, last_node_id TEXT,
                world_id TEXT, title TEXT, gist TEXT, created_at TEXT, stale INTEGER);
             WITH RECURSIVE sequence(seq) AS (
                VALUES (0) UNION ALL SELECT seq+1 FROM sequence WHERE seq<300
             )
             INSERT INTO nodes
                SELECT 'n'||seq, CASE WHEN seq>0 THEN 'n'||(seq-1) END, 'w', seq FROM sequence;
             INSERT INTO nodes VALUES ('side', 'n5', 'w', 301), ('other', NULL, 'z', 0);
             INSERT INTO chapters(id, first_node_id, last_node_id, world_id, title, gist, created_at) VALUES
                ('early', 'n6', 'n12', 'w', '早期', '找到青铜密匣', 'later-edit'),
                ('near', 'n272', 'n288', 'w', '近期', '回到古庙', 'earlier-create'),
                ('side', 'n5', 'side', 'w', '另一条路线', '不应带进正文', 'middle'),
                ('cross', 'side', 'n289', 'w', '跨支', '不应带进正文', 'middle'),
                ('reverse', 'n289', 'n288', 'w', '倒序', '不应带进正文', 'middle'),
                ('other', 'other', 'n290', 'w', '另一部故事', '不应带进正文', 'middle');",
        ).unwrap();
        let chapters = chapters_on_route(&db, "w", "n300").unwrap();
        assert_eq!(chapters.iter().map(|chapter| chapter["title"].as_str().unwrap()).collect::<Vec<_>>(), ["早期", "近期"]);
        let side = chapters_on_route(&db, "w", "side").unwrap();
        assert_eq!(side.len(), 1);
        assert_eq!(side[0]["lastNodeId"], "side");
    }

    #[test]
    fn take_pending_director_note_reads_once_and_deletes() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut conn, None).unwrap();
        conn.execute(
            "INSERT INTO settings(key, value) VALUES('autoplayNote:run-1', '\"下一段让掌柜先开口\"')",
            [],
        )
        .unwrap();
        let store = Store(Arc::new(Mutex::new(conn)));
        assert_eq!(
            take_pending_director_note(&store, "run-1").unwrap(),
            Some("下一段让掌柜先开口".into())
        );
        assert_eq!(take_pending_director_note(&store, "run-1").unwrap(), None);
    }

    #[test]
    fn dynamic_canon_notes_refreshes_on_route_and_in_scope_notes() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut conn, None).unwrap();
        conn.execute_batch(
            "INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('w','测试','free','t','t','t');
             INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,meta_json,created_at) VALUES
               ('n1','w',NULL,0,'opening','长安城初雪。','{}','t'),
               ('n2','w','n1',1,'turn','李白走入酒肆。','{}','t'),
               ('off','w','n1',2,'turn','另一条支线。','{}','t');
             INSERT INTO source_books(id,title,format,created_at,json) VALUES('b1','原著','txt','t','{}');
             INSERT INTO story_notes(id,world_id,kind,title,scope_json,content,progress_json,active,status,created_at,updated_at) VALUES
               ('sn-plot','w','plot','本局主线','{\"toNode\":\"n2\"}','长安寻剑进行中','{}',1,'done','t','2026-01-02'),
               ('sn-off','w','plot','支线笔记','{\"toNode\":\"off\"}','不应出现在当前路线','{}',1,'done','t','2026-01-03');
             INSERT INTO canon_notes(id,book_id,world_id,kind,title,scope_json,content,refs_json,active,status,created_at,updated_at) VALUES
               ('cn-plot','b1',NULL,'plot','前五回','{\"from\":1,\"to\":5}','酒肆相逢','[1,3]',1,'done','t','2026-01-02'),
               ('cn-person','b1',NULL,'person','李白札记','{\"subject\":\"李白\",\"aliases\":[\"太白\"]}','好酒善剑','[2]',1,'done','t','2026-01-02'),
               ('cn-spoiler','b1',NULL,'person','后期剧透','{\"subject\":\"李白\"}','后期秘密','[12]',1,'done','t','2026-01-02');",
        )
        .unwrap();
        let store = Store(Arc::new(Mutex::new(conn)));
        let plan: RunPlan = serde_json::from_value(json!({
            "id": "r1", "worldId": "w", "lineId": "l1", "headId": "n2", "baseId": "n2", "kind": "turn",
            "model": {"slot":"s","url":"http://127.0.0.1","model":"m","auxModel":null,"includeUsage":true,"maxTokens":null,"extra":{}},
            "messages": [], "extractMessages": [],
            "state": {"source": {"bookId": "b1", "position": 3, "through": 5}},
            "settings": {}, "options": {}, "action": {}, "meta": {}
        }))
        .unwrap();
        let history = vec![json!({"kind": "turn", "narrative": "李白举杯独饮。"})];
        let notes = dynamic_canon_notes(&store, &plan, &history, "").unwrap();
        let titles: Vec<&str> = notes.iter().filter_map(|v| v["title"].as_str()).collect();
        assert!(titles.contains(&"本局主线"), "got {titles:?}");
        assert!(titles.contains(&"前五回"), "got {titles:?}");
        assert!(titles.contains(&"李白札记"), "got {titles:?}");
        assert!(!titles.contains(&"支线笔记"), "off-route note leaked: {titles:?}");
        assert!(!titles.contains(&"后期剧透"), "spoiler note leaked: {titles:?}");
    }

    #[test]
    fn dynamic_canon_notes_retains_carried_sequel_story_notes_across_steps() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut conn, None).unwrap();
        conn.execute_batch(
            "INSERT INTO worlds(id,title,era_id,created_at,updated_at,played_at) VALUES('w2','续作','free','t','t','t');
             INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,meta_json,created_at) VALUES
               ('new-1','w2',NULL,0,'opening','新世界开场。','{}','t'),
               ('new-2','w2','new-1',1,'turn','阿青再次现身。','{}','t');
             INSERT INTO story_notes(id,world_id,kind,title,scope_json,content,progress_json,origin_world_id,origin_title,active,status,created_at,updated_at) VALUES
               ('carried-plot','w2','plot','前作终局','{\"toNode\":\"old-world-node-99\"}','前作大结局梗概','{\"routeNode\":\"old-world-node-99\"}','w1','旧长安',1,'done','t','2026-01-02'),
               ('carried-person','w2','person','阿青','{\"subject\":\"阿青\",\"toNode\":\"old-world-node-50\"}','前作剑客','{}','w1','旧长安',1,'done','t','2026-01-03');",
        )
        .unwrap();
        let store = Store(Arc::new(Mutex::new(conn)));
        let plan: RunPlan = serde_json::from_value(json!({
            "id": "r2", "worldId": "w2", "lineId": "l2", "headId": "new-2", "baseId": "new-2", "kind": "turn",
            "model": {"slot":"s","url":"http://127.0.0.1","model":"m","auxModel":null,"includeUsage":true,"maxTokens":null,"extra":{}},
            "messages": [], "extractMessages": [], "state": {}, "settings": {}, "options": {}, "action": {}, "meta": {}
        }))
        .unwrap();
        let history = vec![json!({"kind": "turn", "narrative": "阿青拔剑相助。"})];
        let notes = dynamic_canon_notes(&store, &plan, &history, "").unwrap();
        let titles: Vec<&str> = notes.iter().filter_map(|v| v["title"].as_str()).collect();
        assert!(titles.contains(&"前作终局（前作《旧长安》）"), "carried plot note dropped: {titles:?}");
        assert!(titles.contains(&"阿青（前作《旧长安》）"), "carried person note dropped: {titles:?}");
    }

    #[tokio::test]
    async fn finish_autoplay_preserves_unconsumed_director_note() {
        let mut conn = Connection::open_in_memory().unwrap();
        crate::migration::migrate(&mut conn, None).unwrap();
        conn.execute_batch(
            "INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('w','测试','free','l','{}','t','t','t');
             INSERT INTO nodes(id,world_id,seq,kind,narrative,created_at) VALUES('h','w',0,'opening','开场','t');
             INSERT INTO lines(id,world_id,name,node_id,created_at) VALUES('l','w','主线','h','t');
             INSERT INTO states VALUES('h','{\"version\":2,\"protagonist\":{\"stats\":{\"health\":80}}}');
             INSERT INTO settings(key, value) VALUES('autoplayNote:run-fin', '\"留给下一段的提示\"');",
        ).unwrap();
        let store = Store(Arc::new(Mutex::new(conn)));
        store.initialize().unwrap();
        struct DummyModel;
        impl crate::chat::Model for DummyModel {
            fn complete(&self, _: crate::ModelConfig, _: Value, _: tokio_util::sync::CancellationToken, _: crate::chat::TextSink) -> crate::chat::BoxFuture<Result<crate::chat::Completion>> {
                Box::pin(async { unreachable!() })
            }
        }
        let engine = Arc::new(Engine::new(store.clone(), Arc::new(DummyModel), Arc::new(|_| Box::new(())), Arc::new(|_| {})));
        let plan: RunPlan = serde_json::from_value(json!({
            "id": "run-fin", "worldId": "w", "lineId": "l", "headId": "h", "baseId": "h", "kind": "autoplay",
            "model": {"slot":"s","url":"http://127.0.0.1","model":"m","auxModel":null,"includeUsage":false,"maxTokens":null,"extra":{}},
            "messages": [], "extractMessages": [], "state": {}, "settings": {}, "options": {}, "action": {},
            "meta": {"autoplayCount": 0}
        })).unwrap();
        engine.start(plan).unwrap();
        let settled = tokio::time::timeout(Duration::from_secs(2), async {
            loop {
                let s = engine.snapshot("run-fin", 0).unwrap();
                if s.status != "running" { break s; }
                tokio::time::sleep(Duration::from_millis(5)).await;
            }
        }).await.unwrap();
        assert_eq!(settled.status, "committed");
        assert_eq!(settled.result.as_ref().unwrap()["unusedDirectorNote"], "留给下一段的提示");
        assert_eq!(settled.draft["unusedDirectorNote"], "留给下一段的提示");
    }
}
