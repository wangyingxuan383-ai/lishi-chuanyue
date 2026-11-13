//! Deterministic clock calibration shared by direct edits and Agent tools.
//! This module has no model, permission, task or database dependency.
use super::calendar;
use serde_json::{json, Value};

fn invalid(message: &str) -> String { message.into() }

fn validate_date_input(raw: &Value, rules: &Value, field: &str) -> Result<(), String> {
    let era = super::text(&raw["era"]);
    let maximum = if ["公元", "公元前"].contains(&era) { 9999 } else { calendar::MAX_CUSTOM_ERA_YEAR };
    if !raw["year"].as_f64().is_some_and(|year| year.fract() == 0.0 && (1.0..=maximum as f64).contains(&year)) {
        return Err(invalid(&format!("{field}.year={} 无效，允许范围为1～{maximum}的整数", raw["year"])));
    }
    if !raw["month"].as_i64().is_some_and(|month| (1..=12).contains(&month)) {
        return Err(invalid(&format!("{field}.month={} 无效，允许范围为1～12的整数", raw["month"])));
    }
    let date = calendar::coerce_date(raw, rules).ok_or_else(|| invalid(&format!("{field}不是有效日期")))?;
    if raw.get("day").is_some_and(|day| !day.as_i64().is_some_and(|day| day == date.day && (1..=calendar::month_days(&date)).contains(&day))) {
        return Err(invalid(&format!("{field}.day={} 无效，该月允许范围为1～{}", raw["day"], calendar::month_days(&date))));
    }
    if !raw["ceYear"].is_null() && raw["ceYear"].as_i64() != date.ce_year {
        return Err(invalid(&format!("{field}.ceYear={}与实际公元年不符；自定纪年请使用null，不能把纪年数字当成公元年", raw["ceYear"])));
    }
    Ok(())
}
fn validate_calendar(rules: &Value) -> Result<(), String> {
    let object = rules.as_object().ok_or_else(|| invalid("历法必须是对象"))?;
    if object
        .keys()
        .any(|k| !["eras", "yearWord", "lunar"].contains(&k.as_str()))
        || rules.get("lunar").is_some_and(|v| !v.is_boolean())
        || rules
            .get("yearWord")
            .is_some_and(|v| !v.as_str().is_some_and(|s| s.chars().count() <= 24))
    {
        return Err(invalid("历法字段无效"));
    }
    if let Some(eras) = rules.get("eras") {
        let eras = eras.as_array().ok_or_else(|| invalid("年号表必须是列表"))?;
        let mut previous = None;
        let mut names = std::collections::HashSet::new();
        for era in eras {
            let name = era["name"].as_str().unwrap_or("").trim();
            let ce = era["startCe"]
                .as_i64()
                .filter(|n| *n != 0 && (-9999..=9999).contains(n))
                .ok_or_else(|| invalid("年号起始年份无效"))?;
            let month = era
                .get("startMonth")
                .map(|v| v.as_i64())
                .unwrap_or(Some(1))
                .filter(|n| (1..=12).contains(n))
                .ok_or_else(|| invalid("年号起始月份无效"))?;
            let at = calendar::month_index(ce, month);
            if name.is_empty()
                || name.encode_utf16().count() > 12
                || !names.insert(name.to_owned())
                || previous.is_some_and(|old| old >= at)
                || era
                    .get("firstYear")
                    .is_some_and(|v| !v.as_i64().is_some_and(|n| (1..=9999).contains(&n)))
                || era
                    .get("yearWord")
                    .is_some_and(|v| !v.as_str().is_some_and(|s| s.chars().count() <= 24))
            {
                return Err(invalid(
                    "年号表须按生效时间排序，且名称、纪年不得重复或越界",
                ));
            }
            previous = Some(at);
        }
    }
    Ok(())
}

/// Basic invariants apply even when an unrelated edit retains an old unknown
/// calendar. Stricter date requirements belong to a clock transition below.
pub fn validate_state_clock(state: &Value) -> Result<(), String> {
    if !state["time"]["elapsedMinutes"]
        .as_f64()
        .is_some_and(|n| n.is_finite() && n >= 0.0 && n <= 9_007_199_254_740_991.0)
    {
        return Err(invalid("经过时间必须是非负有限数值"));
    }
    if state["time"].get("startHour").is_some_and(|v| {
        !v.as_f64()
            .is_some_and(|n| n.is_finite() && (0.0..24.0).contains(&n))
    }) {
        return Err(invalid("开局时间须在0至24点之间"));
    }
    for (key, choices) in [
        ("clockStyle", ["era", "elapsed"]),
        ("timeStyle", ["24h", "shichen"]),
    ] {
        if state["era"]
            .get(key)
            .is_some_and(|v| !v.as_str().is_some_and(|s| choices.contains(&s)))
        {
            return Err(invalid("时间显示方式无效"));
        }
    }
    Ok(())
}

fn clock_configuration(state: &Value) -> Value {
    json!({"mode":state["era"]["mode"],"clockStyle":state["era"]["clockStyle"],"timeStyle":state["era"]["timeStyle"],"calendar":state["era"]["calendar"],"start":state["time"]["start"],"date":state["time"]["date"],"hasDate":state["time"].get("date").is_some(),"startHour":state["time"]["startHour"],"anchor":state["time"]["anchor"],"elapsedAnchor":state["time"]["elapsedAnchor"]})
}

/// Reject newly introduced invalid time settings without forcing a legacy
/// undated story to invent a date just to edit money, people or other facts.
pub fn validate_clock_transition(before: &Value, after: &Value) -> Result<(), String> {
    validate_state_clock(after)?;
    if clock_configuration(before) == clock_configuration(after) { return Ok(()); }
    if let Some(rules) = after["era"].get("calendar").filter(|v| !v.is_null()) {
        validate_calendar(rules)?;
    }
    if let Some(date) = after["time"].get("date").filter(|v| !v.is_null()) {
        if after["era"]["mode"] == "free"
            && before["time"]["date"] != *date
            && !["公元", "公元前"].contains(&super::text(&date["era"]))
            && !date.get("ceYear").is_some_and(Value::is_null)
        {
            return Err(invalid("time.date.ceYear必须显式为null：自由世界的自定纪年不映射为公元年"));
        }
        validate_date_input(date, &after["era"]["calendar"], "time.date")?;
    }
    if let Some(anchor) = after["time"].get("anchor").filter(|v| !v.is_null()) {
        if after["era"]["mode"] == "free"
            && before["time"]["anchor"] != *anchor
            && !["公元", "公元前"].contains(&super::text(&anchor["date"]["era"]))
            && !anchor["date"].get("ceYear").is_some_and(Value::is_null)
        {
            return Err(invalid("anchor.date.ceYear必须显式为null：自由世界的自定纪年不映射为公元年"));
        }
        validate_date_input(&anchor["date"], &after["era"]["calendar"], "anchor.date")?;
        if calendar::read_clock_anchor(anchor, &after["era"]["calendar"]).is_none() {
            return Err(invalid(
                "日期锚点无效：请提供有效日期、非负经过分钟和0至1439的当天分钟",
            ));
        }
    }
    if let Some(anchor) = after["time"].get("elapsedAnchor").filter(|v| !v.is_null()) {
        if calendar::read_elapsed_anchor(anchor).is_none() {
            return Err(invalid("日序锚点无效：须提供非负安全整数经过分钟、正整数日序和0至1439的当天分钟"));
        }
    }
    let style = after["era"]["clockStyle"].as_str().unwrap_or(if after["era"]["mode"] == "free" {"elapsed"} else {"era"});
    if style == "era" {
        let rules = &after["era"]["calendar"];
        let date = if after["time"].get("date").is_some() {
            calendar::coerce_date(&after["time"]["date"], rules)
        } else { calendar::read_date(&after["time"]["start"], rules) };
        if date.is_none() && calendar::read_clock_anchor(&after["time"]["anchor"], rules).is_none() {
            return Err(invalid("clockStyle=era须有有效time.date或anchor；只切换显示方式不能设置纪年"));
        }
    }
    Ok(())
}


/// Apply only the display contract. Elapsed time, dates used for ages and
/// deadlines, and the world's history/free identity remain on their old axis.
pub fn apply_display(before: &Value, changes: &Value) -> Result<Value, String> {
    let object = changes.as_object().ok_or_else(|| invalid("时间显示设置须为对象"))?;
    if object.is_empty() || object.keys().any(|key| !["clockStyle", "timeStyle", "calendar", "anchor", "elapsedAnchor"].contains(&key.as_str())) {
        return Err(invalid("请选择时间显示方式或提供日期/日序锚点；显示设置不能更改实际经过"));
    }
    for (key, choices) in [("clockStyle", ["era", "elapsed"]), ("timeStyle", ["24h", "shichen"])] {
        if changes.get(key).is_some_and(|value| !value.as_str().is_some_and(|s| choices.contains(&s))) {
            return Err(invalid("时间显示方式无效"));
        }
    }
    if let Some(rules) = changes.get("calendar") { validate_calendar(rules)?; }
    if let Some(anchor) = changes.get("elapsedAnchor").filter(|v| !v.is_null()) {
        if calendar::read_elapsed_anchor(anchor).is_none() {
            return Err(invalid("日序锚点无效：须提供非负安全整数经过分钟、正整数日序和0至1439的当天分钟"));
        }
    }
    let mut after = before.clone();
    for key in ["clockStyle", "timeStyle", "calendar"] {
        if let Some(value) = changes.get(key) { after["era"][key] = value.clone(); }
    }
    for key in ["anchor", "elapsedAnchor"] {
        if let Some(value) = changes.get(key) { after["time"][key] = value.clone(); }
    }
    validate_clock_transition(before, &after)?;
    Ok(after)
}
