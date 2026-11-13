//! Clock display calibration and historical duration corrections use separate paths.
//! Neither path changes the world's history/free identity or creates a story turn.
use crate::{
    agent_workspace as ws, rules::calendar, tools::ToolDefinition, Error, Result, RunPlan,
};
use rusqlite::Connection;
use serde_json::{json, Map, Value};

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}
fn safe_minute(value: &Value) -> Option<f64> {
    value
        .as_f64()
        .filter(|n| n.is_finite() && n.fract() == 0.0 && *n >= 0.0 && *n <= 9_007_199_254_740_991.0)
}
pub(crate) fn validate_state_clock(state: &Value) -> Result<()> {
    crate::rules::clock::validate_state_clock(state).map_err(Error::Invalid)
}
pub(crate) fn validate_clock_transition(before: &Value, after: &Value) -> Result<()> {
    crate::rules::clock::validate_clock_transition(before, after).map_err(Error::Invalid)
}

fn current_state(db: &Connection, plan: &RunPlan) -> Result<Value> {
    let task = ws::text(&plan.meta["agent"], "taskId");
    if !task.is_empty() {
        let workspace = ws::workspace(db, task)?;
        if let Some(edit) = workspace["edits"].as_array().and_then(|edits| {
            edits
                .iter()
                .rev()
                .find(|e| e["kind"] == "state" && ws::text(e, "id").is_empty())
        }) {
            return Ok(edit["after"].clone());
        }
    }
    ws::resource(db, plan, "state", "")
}

fn clock_of(state: &Value, plan: &RunPlan) -> Value {
    let rules = state["era"]
        .get("calendar")
        .filter(|r| !r.is_null())
        .cloned()
        .unwrap_or_else(|| {
            plan.options
                .get("clock")
                .and_then(|c| c.get("rules"))
                .cloned()
                .unwrap_or_else(|| json!({}))
        });
    let style = state["era"]["clockStyle"]
        .as_str()
        .unwrap_or(if state["era"]["mode"] == "free" {
            "elapsed"
        } else {
            "era"
        });
    let date = if let Some(date) = state["time"].get("date") {
        date.clone()
    } else if state["era"]["mode"] == "free" && style == "elapsed" {
        Value::Null
    } else {
        json!(calendar::read_date(&state["time"]["start"], &rules))
    };
    json!({"mode":state["era"]["mode"],"clockStyle":style,"timeStyle":state["era"]["timeStyle"].as_str().unwrap_or(if style=="elapsed"{"24h"}else{"shichen"}),"date":date,"hour":state["time"]["startHour"].as_f64().unwrap_or(8.0),"label":state["time"]["start"],"rules":rules,"anchor":state["time"]["anchor"],"elapsedAnchor":state["time"]["elapsedAnchor"]})
}

pub(crate) fn read_clock(db: &Connection, plan: &RunPlan, args: &Value) -> Result<Value> {
    let state = if !ws::text(args,"routeId").is_empty(){let id=ws::route_head(db,plan,ws::text(&plan.meta["agent"],"taskId"),ws::text(args,"routeId"))?;ws::draft_view(db,plan,ws::text(&plan.meta["agent"],"taskId"),&json!({"kind":"state","id":id}))?}else{current_state(db, plan)?};
    let elapsed = if let Some(at) = args.get("atElapsedMinutes") {
        safe_minute(at).ok_or_else(|| invalid("查询时间须为非负安全整数分钟"))?
    } else {
        state["time"]["elapsedMinutes"].as_f64().unwrap_or(0.0)
    };
    let clock = clock_of(&state, plan);
    Ok(
        json!({"mode":state["era"]["mode"].as_str().unwrap_or("history"),"elapsedMinutes":state["time"]["elapsedMinutes"],"atElapsedMinutes":elapsed,"clock":clock,"now":calendar::now_of(&clock,elapsed),"message":"display只校准显示，不改变经过时间、年龄、期限或世界类型；纠正已发生时长须correct_history修改对应回合记录并重算。"}),
    )
}

pub(crate) fn stage_clock(
    db: &Connection,
    plan: &RunPlan,
    task: &str,
    args: &Value,
) -> Result<Value> {
    if !args["summary"]
        .as_str()
        .is_some_and(|s| !s.trim().is_empty())
    {
        return Err(invalid("请说明本次时间调整"));
    }
    let target = if !ws::text(args,"routeId").is_empty() {Some(ws::route_head(db,plan,task,ws::text(args,"routeId"))?)}else{None};
    let before = if let Some(id)=&target {ws::draft_view(db,plan,task,&json!({"kind":"state","id":id}))?}else{current_state(db, plan)?};
    let before_elapsed = before["time"]["elapsedMinutes"].as_f64().unwrap_or(0.0);
    let before_now = calendar::now_of(&clock_of(&before, plan), before_elapsed);
    let mut after_now = Value::Null;
    let mut stage =
        json!({"operation":"merge","summary":args["summary"],"_agentCall":args["_agentCall"]});
    if let Some(route) = args.get("routeId") {
        stage["routeId"] = route.clone();
        if let Some(id)=&target { stage["id"] = id.clone().into(); }
    }
    match ws::text(args, "operation") {
        "display" => {
            if ["nodeId", "time", "hour"]
                .iter()
                .any(|k| args.get(k).is_some())
            {
                return Err(invalid("显示校准不能修改历史时长，请使用correct_history"));
            }
            let mut changes = Map::new();
            for key in ["clockStyle", "timeStyle", "calendar", "anchor", "elapsedAnchor"] {
                if let Some(value) = args.get(key) { changes.insert(key.into(), value.clone()); }
            }
            let after = crate::rules::clock::apply_display(&before, &changes.clone().into()).map_err(Error::Invalid)?;
            let mut patch = json!({"era":{},"time":{}});
            for (key, value) in changes {
                let section = if ["anchor", "elapsedAnchor"].contains(&key.as_str()) {"time"} else {"era"};
                patch[section][key] = value;
            }
            after_now = calendar::now_of(&clock_of(&after, plan), before_elapsed);
            if after["era"]["clockStyle"] == "era" && after_now["date"].is_null() {
                return Err(invalid("anchor.date超出可显示日期范围，请校准到当前经过时间内的有效纪年"));
            }
            stage["kind"] = "state".into();
            stage["value"] = patch;
        }
        "correct_history" => {
            if ["clockStyle", "timeStyle", "calendar", "anchor", "elapsedAnchor"]
                .iter()
                .any(|k| args.get(k).is_some())
            {
                return Err(invalid("历史时长纠错与显示校准须分别暂存"));
            }
            let node_id = ws::text(args, "nodeId");
            if node_id.is_empty() {
                return Err(invalid("历史时长纠错须指定nodeId"));
            }
            let node = ws::resource(db, plan, "node", node_id)?;
            if !["turn", "fastforward"].contains(&ws::text(&node, "kind")) {
                return Err(invalid("这个节点不推进时间；请指定实际剧情回合"));
            }
            let mut patch = Map::new();
            if let Some(time) = args.get("time") {
                let negative = time.as_str().is_some_and(|s| s.contains(['-', '−', '负']));
                let minutes = calendar::parse_duration_minutes(time)
                    .filter(|n| {
                        !negative && n.is_finite() && *n >= 0.0 && *n <= 9_007_199_254_740_991.0
                    })
                    .ok_or_else(|| invalid("经过时长必须是可识别的非负分钟或时长文字"))?;
                patch.insert("time".into(), json!(minutes));
            }
            if let Some(hour) = args.get("hour") {
                if ws::text(&node, "action_mode") != "skip" {
                    return Err(invalid("结束时刻仅用于过些日子的回合"));
                }
                if !hour.is_null()
                    && !hour
                        .as_f64()
                        .is_some_and(|n| n.is_finite() && (0.0..24.0).contains(&n))
                {
                    return Err(invalid("结束时刻须在0至24点之间，或null清除"));
                }
                patch.insert("hour".into(), hour.clone());
            }
            if patch.is_empty() {
                return Err(invalid("请提供要纠正的经过时长"));
            }
            stage["kind"] = "node".into();
            stage["id"] = node_id.into();
            stage["path"] = "/record".into();
            stage["value"] = patch.into();
        }
        _ => return Err(invalid("时间操作应为display或correct_history")),
    }
    let mut result = ws::stage(db, plan, task, &stage)?;
    result["beforeDisplay"] = before_now["text"].clone();
    result["beforeClock"] = before_now;
    result["afterDisplay"] = after_now["text"].clone();
    result["afterClock"] = after_now;
    result["elapsedMinutesBefore"] = json!(before_elapsed);
    result["elapsedMinutesPreserved"] = json!(args["operation"] == "display");
    if args["operation"] == "display" {
        result["elapsedMinutesAfter"] = json!(before_elapsed);
    } else {
        result["requiresRecalculation"] = true.into();
    }
    Ok(result)
}

pub(crate) fn catalog() -> Vec<ToolDefinition> {
    let anchor = json!({"type":["object","null"],"properties":{"atElapsedMinutes":{"type":"integer","minimum":0,"maximum":9_007_199_254_740_991_u64},"date":{"type":"object","description":"有效GameDate：era/year/month/day/lunar；自定纪年year允许1～999999999，ceYear必须为null，不把自定纪年映射成公元。阳历式纪年仍为12个月、不含闰日。"},"minuteOfDay":{"type":"integer","minimum":0,"maximum":1439}},"required":["atElapsedMinutes","date","minuteOfDay"],"additionalProperties":false});
    let elapsed_anchor = json!({"type":["object","null"],"properties":{"atElapsedMinutes":{"type":"integer","minimum":0,"maximum":9_007_199_254_740_991_u64},"day":{"type":"integer","minimum":1,"maximum":9_007_199_254_740_991_u64},"minuteOfDay":{"type":"integer","minimum":0,"maximum":1439}},"required":["atElapsedMinutes","day","minuteOfDay"],"additionalProperties":false});
    vec![
        ToolDefinition { name:"read_clock", description:"读取本局当前或指定经过分钟的日期、时间与锚点。实际经过时间和显示校准独立，不改变世界类型。",parameters:json!({"type":"object","properties":{"atElapsedMinutes":{"type":"integer","minimum":0,"maximum":9_007_199_254_740_991_u64}},"required":[],"additionalProperties":false}),read_only:true },
        ToolDefinition { name:"stage_clock", description:"调整时间：display切换纪年/经过天和24h/时辰，或用anchor把指定经过分钟映射为日期与当天分钟、elapsedAnchor映射为第N天与当天分钟，不改年龄、期限和已过时间；correct_history须指定剧情nodeId，修改record.time后由核心重算后续状态，不能只改头部。可分别多次暂存。",parameters:json!({"type":"object","properties":{"operation":{"type":"string","enum":["display","correct_history"]},"clockStyle":{"type":"string","enum":["era","elapsed"]},"timeStyle":{"type":"string","enum":["24h","shichen"]},"anchor":anchor,"elapsedAnchor":elapsed_anchor,"calendar":{"type":"object"},"nodeId":{"type":"string"},"time":{"type":["number","string"]},"hour":{"type":["number","null"],"minimum":0,"exclusiveMaximum":24},"routeId":{"type":"string"},"summary":{"type":"string","minLength":1}},"required":["operation","summary"],"additionalProperties":false}),read_only:false },
    ]
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::params;

    fn anchor(at: f64) -> Value {
        json!({"atElapsedMinutes":at,"date":{"era":"斗罗","year":2631,"month":5,"day":8,"ceYear":null,"lunar":false},"minuteOfDay":1205})
    }
    fn state(elapsed: i64, money: i64) -> Value {
        json!({"version":2,"time":{"start":"","elapsedMinutes":elapsed,"startHour":8},"placeId":null,"protagonist":{"name":"旅人","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"","stats":{"money":money,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},"people":[],"places":[],"cards":[],"goals":[],"facts":[],"era":{"packId":null,"mode":"free","clockStyle":"elapsed","calendar":{"lunar":false}},"deviations":[]})
    }
    fn fixture() -> (Connection, RunPlan) {
        let mut db = Connection::open_in_memory().unwrap();
        db.execute_batch("PRAGMA foreign_keys=ON").unwrap();
        crate::migration::migrate(&mut db,None).unwrap();
        db.execute("INSERT INTO worlds(id,title,era_id,current_line_id,settings_json,created_at,updated_at,played_at) VALUES('world','时间检查','','line','{}','test','test','test')", []).unwrap();
        for (id, parent, seq, record, money) in [
            ("n0", None, 0, Value::Null, 10),
            ("n1", Some("n0"), 1, json!({"time":5,"money":-2}), 8),
            ("n2", Some("n1"), 2, json!({"time":5,"money":-3}), 5),
        ] {
            db.execute("INSERT INTO nodes(id,world_id,parent_id,seq,kind,action_mode,narrative,record_json,created_at) VALUES(?,'world',?,?,?,?,?,?, 'test')",params![id,parent,seq,if seq==0{"opening"}else{"turn"},"do",format!("正文{seq}"),record.to_string()]).unwrap();
            db.execute(
                "INSERT INTO states VALUES(?,?)",
                params![id, state(seq * 5, money).to_string()],
            )
            .unwrap();
        }
        db.execute("INSERT INTO lines(id,world_id,name,node_id,kind,created_at) VALUES('line','world','主线','n2','line','test')", []).unwrap();
        db.execute(
            "INSERT INTO agent_sessions VALUES('session','world','line','时间检查','test','test')",
            [],
        )
        .unwrap();
        let base = ws::base(&db, "world", "line").unwrap();
        db.execute("INSERT INTO agent_tasks(id,session_id,run_id,text,policy,status,base_json,created_at,updated_at) VALUES('task','session','run','时间调整','auto-reversible','running',?,'test','test')", [base.to_string()]).unwrap();
        let plan = serde_json::from_value(json!({"id":"run","worldId":"world","lineId":"line","headId":"n2","baseId":"n2","kind":"agent","model":{"slot":"main","url":"","model":"fixture","auxModel":null,"includeUsage":false,"maxTokens":null,"extra":{}},"messages":[],"extractMessages":[],"state":state(10,5),"settings":{},"options":{},"action":{},"meta":{"agent":{"taskId":"task"}}})).unwrap();
        (db, plan)
    }

    #[test]
    fn continuity_history_adoption_reanchors_quotes_to_the_copied_node() {
        let(mut db,plan)=fixture();
        let change=json!({"knowledge":[{"id":"seen","person":"protagonist","claim":"旅人见到正文中的消息","awareness":"witnessed","source":{"from":"narrative","nodeId":"n1","quote":"正文1"}}]});
        ws::stage(&db,&plan,"task",&json!({"kind":"node","id":"n1","path":"/record/continuity","operation":"set","value":change,"summary":"补记本回合获知"})).unwrap();
        let tx=db.transaction().unwrap();ws::apply(&tx,&plan,"task","补记获知").unwrap();tx.commit().unwrap();
        let head:String=db.query_row("SELECT l.node_id FROM lines l JOIN worlds w ON w.current_line_id=l.id WHERE w.id='world'",[],|r|r.get(0)).unwrap();
        let projected=crate::continuity::project(&db,"world",&head).unwrap();assert_eq!(projected["knowledge"][0]["awareness"],"witnessed");assert_ne!(projected["knowledge"][0]["source"]["nodeId"],"n1");
        assert_eq!(crate::continuity::project(&db,"world","n2").unwrap()["knowledge"],json!([]));
    }

    #[test]
    fn clock_elapsed_calibration_has_its_own_day_axis_and_keeps_ages() {
        let elapsed = 4054.0 * 1440.0 + 725.0;
        let mut clock = json!({"mode":"free","clockStyle":"elapsed","timeStyle":"24h","hour":8,"date":null,"rules":{"lunar":false},"anchor":anchor(elapsed),"elapsedAnchor":{"atElapsedMinutes":elapsed,"day":31,"minuteOfDay":1430}});
        assert_eq!(calendar::now_of(&clock, elapsed)["text"], "第 31 天 · 23:50");
        assert_eq!(calendar::now_of(&clock, elapsed+20.0)["text"], "第 32 天 · 00:10");
        assert_eq!(calendar::now_of(&clock, elapsed-1440.0)["text"], "第 30 天 · 23:50");
        assert_eq!(calendar::new_years_between(&clock, elapsed, elapsed+525600.0), 1.0);
        clock["clockStyle"]="era".into();
        assert_eq!(calendar::now_of(&clock, elapsed)["text"], "斗罗2631年 5月8日 · 20:05");
        assert_eq!(calendar::now_of(&clock, elapsed)["day"], 4055.0);
        clock["clockStyle"]="elapsed".into();
        clock["elapsedAnchor"]=json!({"atElapsedMinutes":elapsed,"day":0,"minuteOfDay":0});
        // Invalid imported optional anchors fall back to the legacy formula.
        assert_eq!(calendar::now_of(&clock, elapsed)["text"], "第 4055 天 · 20:05");
    }

    #[test]
    fn clock_manual_record_and_agent_share_calibration_and_atomic_validation() {
        let before=state(10, 5);
        let changes=json!({"clockStyle":"elapsed","timeStyle":"24h","elapsedAnchor":{"atElapsedMinutes":10,"day":4055,"minuteOfDay":1205}});
        let result=crate::rules::apply_record(&before,&json!({"rules":{"clock":changes}}),&json!({"mode":"do","advanceTime":false})).unwrap();
        let after=&result["state"];
        assert_eq!(after["time"]["elapsedMinutes"],10.0);
        assert_eq!(after["protagonist"]["age"],20);
        assert_eq!(after["era"]["mode"],"free");
        assert_eq!(calendar::now_of(&clock_of(after,&fixture().1),10.0)["text"],"第 4055 天 · 20:05");
        for bad in [json!({"elapsedAnchor":{"atElapsedMinutes":10,"day":0,"minuteOfDay":0}}),json!({"elapsedAnchor":{"atElapsedMinutes":10,"day":1,"minuteOfDay":1440}}),json!({"clockStyle":"era"}),json!({"elapsedMinutes":0})] {
            assert!(crate::rules::apply_record(&before,&json!({"money":100,"rules":{"clock":bad}}),&json!({"advanceTime":false})).is_err());
        }
        assert_eq!(before,state(10,5));
        let (db,plan)=fixture();
        let mut args=changes;
        args["operation"]="display".into(); args["summary"]="直接日序校准".into();
        let staged=stage_clock(&db,&plan,"task",&args).unwrap();
        assert_eq!(staged["afterDisplay"],"第 4055 天 · 20:05");
        let tx=db.unchecked_transaction().unwrap();
        ws::apply(&tx,&plan,"task","日序校准").unwrap(); tx.commit().unwrap();
        let formal=ws::resource(&db,&plan,"state","").unwrap();
        assert_eq!(formal["time"]["elapsedAnchor"],after["time"]["elapsedAnchor"]);
        let tx=db.unchecked_transaction().unwrap(); ws::undo(&tx,"task").unwrap(); tx.commit().unwrap();
        assert_eq!(ws::resource(&db,&plan,"state","").unwrap(),before);
    }

    #[test]
    fn clock_styles_and_day_4055_keep_actual_elapsed_and_free_identity() {
        let elapsed = 4054.0 * 1440.0 + 725.0;
        let mut clock = json!({"mode":"free","clockStyle":"era","timeStyle":"24h","hour":8,"date":null,"label":"","rules":{"lunar":false},"anchor":anchor(elapsed)});
        assert_eq!(
            calendar::now_of(&clock, elapsed)["text"],
            "斗罗2631年 5月8日 · 20:05"
        );
        assert_eq!(calendar::now_of(&clock, elapsed)["day"], 4055.0);
        clock["clockStyle"] = "elapsed".into();
        assert_eq!(
            calendar::now_of(&clock, elapsed)["text"],
            "第 4055 天 · 20:05"
        );
        clock["timeStyle"] = "shichen".into();
        assert_eq!(
            calendar::now_of(&clock, elapsed)["text"],
            "第 4055 天 · 戌时"
        );
        assert_eq!(
            calendar::new_years_between(&clock, elapsed, elapsed + 525600.0),
            1.0
        );
    }

    #[test]
    fn clock_anchor_projects_backwards_without_year_zero_and_does_not_change_history_ages() {
        let mut clock = json!({"mode":"history","clockStyle":"era","timeStyle":"24h","hour":20,"date":{"era":"天宝","year":7,"month":12,"day":29,"ceYear":748,"lunar":true},"rules":{},"anchor":{"atElapsedMinutes":120,"minuteOfDay":0,"date":{"era":"公元","year":1,"month":1,"day":1,"ceYear":1,"lunar":false}}});
        assert_eq!(calendar::now_of(&clock, 0.0)["date"]["ceYear"], -1);
        assert_eq!(
            calendar::now_of(&clock, 0.0)["text"],
            "公元前1年 12月31日 · 22:00"
        );
        assert_eq!(calendar::now_of(&clock, 240.0)["date"]["ceYear"], 1);
        assert_eq!(calendar::new_years_between(&clock, 0.0, 240.0), 1.0);
        clock["clockStyle"] = "elapsed".into();
        assert_eq!(calendar::new_years_between(&clock, 0.0, 240.0), 1.0);
        clock["mode"] = "free".into();
        assert_eq!(calendar::new_years_between(&clock, 0.0, 240.0), 0.0);
    }

    #[test]
    fn clock_display_stages_only_clock_fields_and_reuses_call_ids() {
        let (mut db, plan) = fixture();
        let args = json!({"operation":"display","clockStyle":"era","timeStyle":"24h","anchor":anchor(10.0),"summary":"校准纪年","_agentCall":"clock1"});
        stage_clock(&db, &plan, "task", &args).unwrap();
        assert_eq!(
            stage_clock(&db, &plan, "task", &args).unwrap()["reused"],
            true
        );
        let read = read_clock(&db, &plan, &json!({})).unwrap();
        assert_eq!(read["now"]["text"], "斗罗2631年 5月8日 · 20:05");
        assert_eq!(read["elapsedMinutes"], 10);
        let tx = db.transaction().unwrap();
        ws::apply(&tx, &plan, "task", "校准纪年").unwrap();
        tx.commit().unwrap();
        let after = ws::resource(&db, &plan, "state", "").unwrap();
        assert_eq!(after["time"]["elapsedMinutes"], 10);
        assert_eq!(after["protagonist"]["age"], 20);
        assert_eq!(after["era"]["mode"], "free");
        assert_eq!(after["deviations"], json!([]));
        let tx = db.transaction().unwrap();
        ws::undo(&tx, "task").unwrap();
        tx.commit().unwrap();
        assert_eq!(ws::resource(&db, &plan, "state", "").unwrap(), state(10, 5));
    }

    #[test]
    fn clock_history_correction_replays_following_records_and_keeps_old_route() {
        let (mut db, plan) = fixture();
        stage_clock(&db,&plan,"task",&json!({"operation":"correct_history","nodeId":"n1","time":"一年零一天","summary":"修正经过时长"})).unwrap();
        let workspace = ws::workspace(&db, "task").unwrap();
        assert_eq!(workspace["edits"][0]["after"]["record"]["money"], -2);
        assert_eq!(workspace["edits"][0]["after"]["record"]["time"], 527040.0);
        let tx = db.transaction().unwrap();
        ws::apply(&tx, &plan, "task", "修正经过时长").unwrap();
        tx.commit().unwrap();
        let after = ws::resource(&db, &plan, "state", "").unwrap();
        assert_eq!(after["time"]["elapsedMinutes"], 527045.0);
        assert_eq!(after["protagonist"]["age"], 21.0);
        assert_eq!(after["protagonist"]["stats"]["money"], 5.0);
        assert_eq!(
            ws::resource(&db, &plan, "state", "n2").unwrap(),
            state(10, 5)
        );
        let tx = db.transaction().unwrap();
        ws::undo(&tx, "task").unwrap();
        tx.commit().unwrap();
        assert_eq!(ws::resource(&db, &plan, "state", "").unwrap(), state(10, 5));
    }

    #[test]
    fn clock_invalid_inputs_cannot_leave_a_partial_time_edit() {
        let (db, plan) = fixture();
        for args in [
            json!({"operation":"display","anchor":{"atElapsedMinutes":-1,"date":anchor(0.0)["date"],"minuteOfDay":0},"summary":"无效"}),
            json!({"operation":"display","anchor":{"atElapsedMinutes":0,"date":{"era":"公元","year":2026,"month":2,"day":29,"lunar":false},"minuteOfDay":0},"summary":"无效"}),
            json!({"operation":"display","timeStyle":"invalid","summary":"无效"}),
            json!({"operation":"display","clockStyle":"era","time":20,"summary":"混合用途"}),
            json!({"operation":"correct_history","nodeId":"n1","time":"-两天","summary":"负时间"}),
            json!({"operation":"correct_history","nodeId":"n0","time":20,"summary":"开场"}),
            json!({"operation":"correct_history","nodeId":"n1","hour":24,"summary":"无效时刻"}),
        ] {
            assert!(stage_clock(&db, &plan, "task", &args).is_err(), "{args}");
        }
        assert!(read_clock(&db, &plan, &json!({"atElapsedMinutes":-1})).is_err());
        assert_eq!(ws::workspace(&db, "task").unwrap(), json!({}));
        let mut invalid_state = state(10, 5);
        invalid_state["time"]["date"] =
            json!({"era":"公元","year":0,"month":1,"day":1,"lunar":false});
        assert!(validate_clock_transition(&state(10,5), &invalid_state).is_err());
    }

    #[test]
    fn custom_era_above_ten_thousand_has_no_ce_alias_and_rejects_invalid_display() {
        let (db,plan)=fixture();
        let result=stage_clock(&db,&plan,"task",&json!({"operation":"display","clockStyle":"era","timeStyle":"24h","calendar":{"lunar":false},"anchor":{"atElapsedMinutes":10,"minuteOfDay":1430,"date":{"era":"斗罗历","year":10015,"month":12,"day":31,"ceYear":null,"lunar":false}},"summary":"校准斗罗纪年"})).unwrap();
        assert_eq!(result["afterDisplay"],"斗罗历10015年 12月31日 · 23:50");
        assert_eq!(result["elapsedMinutesPreserved"],true);
        let tomorrow=read_clock(&db,&plan,&json!({"atElapsedMinutes":30})).unwrap();
        assert_eq!(tomorrow["now"]["text"],"斗罗历10016年 1月1日 · 00:10");
        assert!(tomorrow["now"]["date"]["ceYear"].is_null());
        assert_eq!(tomorrow["elapsedMinutes"],10);
        let mut date=anchor(0.0);
        date["date"]["year"]=1_000_000_000_i64.into();
        let error=stage_clock(&db,&plan,"task",&json!({"operation":"display","anchor":date,"summary":"越界"})).unwrap_err().to_string();
        assert!(error.contains("999999999"),"{error}");
        let (empty,empty_plan)=fixture();
        assert!(stage_clock(&empty,&empty_plan,"task",&json!({"operation":"display","clockStyle":"era","summary":"仅切开关"})).is_err());
    }

    #[test]
    fn new_free_anchor_requires_explicit_unknown_ce_even_with_matching_era_table() {
        let (db,plan)=fixture();
        let rules=json!({"lunar":false,"eras":[{"name":"斗罗历","startCe":1}]});
        for date in [
            json!({"era":"斗罗历","year":10015,"month":1,"day":1,"lunar":false}),
            json!({"era":"斗罗历","year":10015,"month":1,"day":1,"lunar":false,"ceYear":10015}),
        ] {
            let error=stage_clock(&db,&plan,"task",&json!({"operation":"display","clockStyle":"era","calendar":rules,"anchor":{"atElapsedMinutes":10,"minuteOfDay":0,"date":date},"summary":"校准纪年"})).unwrap_err().to_string();
            assert!(error.contains("anchor.date.ceYear") && error.contains("null"),"{error}");
            assert_eq!(ws::workspace(&db,"task").unwrap(),json!({}));
        }
        let mut independent=anchor(10.0);
        independent["date"]["era"]="斗罗历".into();
        independent["date"]["year"]=10015.into();
        stage_clock(&db,&plan,"task",&json!({"operation":"display","clockStyle":"era","calendar":rules,"anchor":independent,"summary":"独立纪年"})).unwrap();
        assert!(read_clock(&db,&plan,&json!({})).unwrap()["now"]["date"]["ceYear"].is_null());

        // Existing calibration is not silently rewritten by unrelated work.
        let mut legacy=state(10,5);
        legacy["time"]["anchor"]=json!({"atElapsedMinutes":10,"minuteOfDay":0,"date":{"era":"斗罗历","year":10015,"month":1,"day":1,"lunar":false,"ceYear":10015}});
        legacy["era"]["calendar"]=rules;
        let mut unrelated=legacy.clone();
        unrelated["protagonist"]["stats"]["money"]=6.into();
        validate_clock_transition(&legacy,&unrelated).unwrap();
        assert_eq!(unrelated["time"]["anchor"],legacy["time"]["anchor"]);
    }

    #[test]
    fn legacy_undated_era_world_can_edit_people_but_new_era_setting_cannot_bypass_transition() {
        let (mut db,plan)=fixture();
        let mut legacy=state(10,5);
        legacy["era"]["clockStyle"]="era".into();
        legacy["time"]["date"]=Value::Null;
        legacy["time"]["start"]="来历未明".into();
        db.execute("UPDATE states SET state_json=? WHERE node_id='n2'",[legacy.to_string()]).unwrap();
        let base=ws::base(&db,"world","line").unwrap();
        db.execute("UPDATE agent_tasks SET base_json=? WHERE id='task'",[base.to_string()]).unwrap();
        ws::stage(&db,&plan,"task",&json!({"kind":"state","operation":"merge","value":{"protagonist":{"stats":{"money":9}}},"summary":"更正钱数"})).unwrap();
        let tx=db.transaction().unwrap();
        ws::apply(&tx,&plan,"task","更正钱数").unwrap();
        tx.commit().unwrap();
        let after=ws::resource(&db,&plan,"state","").unwrap();
        assert_eq!(after["protagonist"]["stats"]["money"],9);
        assert_eq!(after["time"],legacy["time"]);

        let (mut empty,empty_plan)=fixture();
        ws::stage(&empty,&empty_plan,"task",&json!({"kind":"state","operation":"merge","value":{"era":{"clockStyle":"era"}},"summary":"直接设纪年"})).unwrap();
        let tx=empty.transaction().unwrap();
        let error=ws::apply(&tx,&empty_plan,"task","直接设纪年").unwrap_err().to_string();
        assert!(error.contains("clockStyle=era"),"{error}");
        tx.rollback().unwrap();
    }

    #[test]
    fn generic_free_base_date_cannot_introduce_a_ce_alias() {
        for ce in [None,Some(json!(10015))] {
            let (mut db,plan)=fixture();
            let mut date=json!({"era":"斗罗历","year":10015,"month":1,"day":1,"lunar":false});
            if let Some(ce)=ce {date["ceYear"]=ce;}
            ws::stage(&db,&plan,"task",&json!({"kind":"state","operation":"merge","value":{"era":{"clockStyle":"era","calendar":{"lunar":false,"eras":[{"name":"斗罗历","startCe":1}]}},"time":{"date":date}},"summary":"设置基准纪年"})).unwrap();
            let tx=db.transaction().unwrap();
            let error=ws::apply(&tx,&plan,"task","设置基准纪年").unwrap_err().to_string();
            assert!(error.contains("time.date.ceYear") && error.contains("null"),"{error}");
            tx.rollback().unwrap();
        }
        let (mut db,plan)=fixture();
        ws::stage(&db,&plan,"task",&json!({"kind":"state","operation":"merge","value":{"era":{"clockStyle":"era","timeStyle":"24h","calendar":{"lunar":false,"eras":[{"name":"斗罗历","startCe":1}]}},"time":{"date":{"era":"斗罗历","year":10015,"month":12,"day":31,"ceYear":null,"lunar":false},"startHour":23.5}},"summary":"设置独立基准纪年"})).unwrap();
        let tx=db.transaction().unwrap();
        ws::apply(&tx,&plan,"task","设置独立基准纪年").unwrap();
        tx.commit().unwrap();
        let mut formal=plan.clone();
        formal.meta["agent"]["taskId"]="".into();
        let current=read_clock(&db,&formal,&json!({})).unwrap();
        assert_eq!(current["now"]["text"],"斗罗历10015年 12月31日 · 23:40");
        assert!(current["now"]["date"]["ceYear"].is_null());
        assert_eq!(current["elapsedMinutes"],10);
        let tomorrow=read_clock(&db,&formal,&json!({"atElapsedMinutes":40})).unwrap();
        assert_eq!(tomorrow["now"]["text"],"斗罗历10016年 1月1日 · 00:10");
        let preserved=ws::resource(&db,&formal,"state","").unwrap();
        assert_eq!(preserved["protagonist"]["age"],20);
        assert_eq!(preserved["protagonist"]["stats"]["money"],5);
        let historical=json!({"mode":"history","clockStyle":"era","timeStyle":"24h","hour":8,"rules":{"eras":[{"name":"天宝","startCe":742}],"lunar":true},"date":{"era":"天宝","year":7,"month":1,"day":1,"ceYear":null,"lunar":true}});
        assert_eq!(calendar::now_of(&historical,0.0)["date"]["ceYear"],748);
    }
    #[test]
    fn draft_route_clock_targets_its_own_head_and_rejects_later_node() {
        let (mut db,plan)=fixture();
        let route=ws::stage_route(&db,&plan,"task",&json!({"headId":"n1","name":"回退","activate":true,"summary":"回退"})).unwrap();
        let id=route["routeId"].as_str().unwrap();
        let out=stage_clock(&db,&plan,"task",&json!({"routeId":id,"operation":"display","clockStyle":"elapsed","timeStyle":"shichen","summary":"只改回退路线时刻格式"})).unwrap();
        assert_eq!(out["elapsedMinutesBefore"],5.0);
        let work=ws::workspace(&db,"task").unwrap();
        assert_eq!(work["edits"][0]["id"],"n1");
        assert!(ws::stage(&db,&plan,"task",&json!({"kind":"state","id":"n2","routeId":id,"operation":"merge","value":{"time":{}},"summary":"越出目标路线"})).is_err());
        let tx=db.transaction().unwrap();
        assert_eq!(ws::validate(&tx,&plan,"task").unwrap()["valid"],true);
    }

}
