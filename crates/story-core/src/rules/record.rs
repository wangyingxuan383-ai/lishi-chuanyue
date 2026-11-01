//! Lenient JSON record decoding. Panel-only edits are intentionally excluded
//! here; they enter apply_record through the trusted editing API instead.
use super::{js_number, js_round, js_string};
use regex::Regex;
use serde_json::{json, Map, Value};

fn str_value(v: &Value) -> Option<String> {
    match v {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().into()),
        Value::Number(_) => Some(v.to_string()),
        _ => None,
    }
}
fn arr(v: &Value) -> Vec<&Value> {
    if let Some(a) = v.as_array() {
        a.iter().collect()
    } else if v.is_object() {
        vec![v]
    } else {
        vec![]
    }
}
fn insert_str(out: &mut Map<String, Value>, key: &str, v: &Value) {
    if let Some(s) = str_value(v) {
        out.insert(key.into(), json!(s));
    }
}
fn trailing_commas(s: &str) -> String {
    Regex::new(r",\s*([}\]])")
        .unwrap()
        .replace_all(s, "$1")
        .into_owned()
}
fn quote_keys(s: &str) -> String {
    Regex::new(r"([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:")
        .unwrap()
        .replace_all(s, "$1\"$2\":")
        .into_owned()
}

fn close_brackets(s: &str) -> String {
    let (mut in_string, mut escaped, mut last_safe) = (false, false, 0);
    for (i, c) in s.char_indices() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        if c == '"' {
            in_string = true;
        }
        if matches!(c, ',' | '{' | '[' | '}' | ']') {
            last_safe = i + c.len_utf8();
        }
    }
    let mut out = if in_string { &s[..last_safe] } else { s }
        .trim_end_matches(|c: char| c == ',' || c == ':' || c.is_whitespace())
        .to_owned();
    let mut opened = Vec::new();
    in_string = false;
    escaped = false;
    for c in out.chars() {
        if in_string {
            if escaped {
                escaped = false;
            } else if c == '\\' {
                escaped = true;
            } else if c == '"' {
                in_string = false;
            }
            continue;
        }
        match c {
            '"' => in_string = true,
            '{' => opened.push('}'),
            '[' => opened.push(']'),
            '}' | ']' => {
                opened.pop();
            }
            _ => {}
        }
    }
    out.extend(opened.into_iter().rev());
    out
}
pub fn lenient_json(text: &str) -> Option<Value> {
    let body = Regex::new(r"(?i)<\s*/?\s*record\s*>|```(?:json)?")
        .unwrap()
        .replace_all(text, "");
    let body = &body[body.find('{')?..];
    let mut candidates = Vec::new();
    if let Some(end) = body.rfind('}').filter(|n| *n > 0) {
        candidates.push(body[..=end].to_owned());
    }
    candidates.push(close_brackets(body));
    for base in candidates {
        let trailing = trailing_commas(&base);
        let quoted = quote_keys(&trailing);
        let smart = trailing_commas(&base.replace(['“', '”'], "\""));
        for repaired in [
            base,
            trailing,
            quoted.clone(),
            quoted.replace('\'', "\""),
            smart,
        ] {
            if let Ok(v) = serde_json::from_str(&repaired) {
                return Some(v);
            }
        }
    }
    None
}

pub fn normalize_record(value: &Value, issues: &mut Vec<String>) -> Option<Value> {
    value.as_object()?;
    let v = value;
    let mut out = Map::new();
    for key in ["time", "money"] {
        if v[key].is_number() || v[key].is_string() {
            out.insert(key.into(), v[key].clone());
        }
    }
    insert_str(&mut out, "place", &v["place"]);
    if v["stats"].is_object() || v["stats"].is_array() {
        let mut stats = Map::new();
        for k in ["health", "energy", "fame"] {
            if let Some(raw) = v["stats"].get(k) {
                if let Some(n) = js_number(raw) {
                    stats.insert(k.into(), json!(n));
                }
            }
        }
        out.insert("stats".into(), Value::Object(stats));
    }
    let mut items = Vec::new();
    for raw in arr(&v["items"]) {
        if let Some(s) = raw.as_str() {
            if let Some(m) = Regex::new(r"^(.+?)\s*([+-]\s*\d+)").unwrap().captures(s) {
                if let Ok(n) = Regex::new(r"\s")
                    .unwrap()
                    .replace_all(&m[2], "")
                    .parse::<f64>()
                {
                    items.push(json!({"name":m[1].trim(),"delta":n}));
                    continue;
                }
            }
            issues.push(format!("物品无法理解：{}", s));
            continue;
        }
        let name = str_value(&raw["name"]);
        let delta_raw = raw
            .get("delta")
            .filter(|v| !v.is_null())
            .or_else(|| raw.get("change"))
            .unwrap_or(&Value::Null);
        let stripped = Regex::new(r"[^\d+-]")
            .unwrap()
            .replace_all(&js_string(delta_raw), "")
            .into_owned();
        let delta = raw["delta"].as_f64().or_else(|| {
            if stripped.chars().any(|c| c.is_ascii_digit()) {
                stripped.parse::<f64>().ok()
            } else {
                None
            }
        });
        let (Some(name), Some(delta)) = (name, delta) else {
            issues.push(format!("物品无法理解：{}", raw));
            continue;
        };
        let mut item = json!({"name":name,"delta":delta});
        if raw.get("place").is_some() {
            item["place"] = str_value(&raw["place"])
                .map(Value::String)
                .unwrap_or(Value::Null);
        }
        if let Some(unit) = str_value(&raw["unit"]) {
            item["unit"] = json!(unit);
        }
        items.push(item);
    }
    out.insert("items".into(), json!(items));
    let mut people = Vec::new();
    for raw in arr(&v["people"]) {
        let Some(name) = str_value(&raw["name"]) else {
            issues.push(format!("人物缺少名字：{}", raw));
            continue;
        };
        let mut person = Map::from_iter([("name".into(), json!(name))]);
        for key in ["role", "attitude", "note"] {
            insert_str(&mut person, key, &raw[key]);
        }
        if raw["alive"].is_boolean() {
            person.insert("alive".into(), raw["alive"].clone());
        }
        let aliases: Vec<String> = arr(&raw["aliases"])
            .into_iter()
            .filter_map(str_value)
            .collect();
        if !aliases.is_empty() {
            person.insert("aliases".into(), json!(aliases));
        }
        people.push(Value::Object(person));
    }
    out.insert("people".into(), json!(people));
    for (key, default) in [("status", "add"), ("goals", "progress")] {
        let mut entries = Vec::new();
        for raw in arr(&v[key]) {
            let Some(name) = str_value(&raw["name"]) else {
                continue;
            };
            let mut entry = Map::from_iter([
                ("name".into(), json!(name)),
                (
                    "op".into(),
                    json!(str_value(&raw["op"]).unwrap_or(default.into())),
                ),
            ]);
            insert_str(&mut entry, "detail", &raw["detail"]);
            if key == "goals" {
                insert_str(&mut entry, "kind", &raw["kind"]);
            }
            entries.push(Value::Object(entry));
        }
        out.insert(key.into(), json!(entries));
    }
    if let Some(s) = str_value(&v["date"]) {
        out.insert("date".into(), json!(s));
    } else if v["date"].is_object() {
        out.insert("date".into(), v["date"].clone());
    }
    if let Some(raw) = v.get("hour") {
        if let Some(hour) = js_number(raw).filter(|n| n.fract() == 0.0 && *n >= 0.0 && *n < 24.0) {
            out.insert("hour".into(), json!(hour));
        }
    }
    if v["died"] == true || v["died"] == "true" {
        out.insert("died".into(), json!(true));
    }
    let mut units: Vec<Value> = arr(&v["currency"])
        .into_iter()
        .filter_map(|u| {
            let name = str_value(&u["name"])?;
            let value = js_number(&u["value"])?;
            (value > 0.0).then(|| json!({"name":name,"value":js_round(value)}))
        })
        .collect();
    if !units.is_empty() {
        units.sort_by(|a, b| {
            b["value"]
                .as_f64()
                .unwrap()
                .total_cmp(&a["value"].as_f64().unwrap())
        });
        out.insert("currency".into(), json!(units));
    }
    for key in ["log", "deviation"] {
        insert_str(&mut out, key, &v[key]);
    }
    if v["report"].is_object() {
        let mut report = Map::new();
        for key in ["world", "local", "people"] {
            insert_str(&mut report, key, &v["report"][key]);
        }
        if !report.is_empty() {
            out.insert("report".into(), Value::Object(report));
        }
    }
    let what = if v["risk"].is_object() || v["risk"].is_array() {
        str_value(&v["risk"]["what"])
    } else {
        str_value(&v["risk"])
    };
    if let Some(what) = what {
        let said = str_value(&v["risk"]["result"]).unwrap_or_default();
        let mut risk = json!({"what":what});
        if said.contains('半') {
            risk["result"] = json!("半成");
        } else if Regex::new("败|没成|未成|不成").unwrap().is_match(&said) {
            risk["result"] = json!("败");
        } else if said.contains('成') {
            risk["result"] = json!("成");
        }
        out.insert("risk".into(), risk);
    }
    if v["beat"] == true || str_value(&v["beat"]).is_some_and(|s| s.eq_ignore_ascii_case("done")) {
        out.insert("beat".into(), json!("done"));
    }
    let mut challenge = Map::new();
    if v["challenge"].is_object() {
        insert_str(&mut challenge, "progress", &v["challenge"]["progress"]);
        insert_str(&mut challenge, "why", &v["challenge"]["why"]);
        if let Some(outcome) = str_value(&v["challenge"]["result"])
            .map(|s| s.to_lowercase())
            .filter(|s| s == "won" || s == "lost")
        {
            challenge.insert("result".into(), json!(outcome));
        }
    } else {
        insert_str(&mut challenge, "progress", &v["challenge"]);
    }
    if !challenge.is_empty() {
        out.insert("challenge".into(), Value::Object(challenge));
    }
    let prefix = Regex::new(r"^\s*(?:[0-9一二三四五六]+[.、)）]|[-*•])\s*").unwrap();
    let choices: Vec<String> = arr(&v["choices"])
        .into_iter()
        .filter_map(|v| str_value(v).or_else(|| str_value(&v["text"])))
        .map(|s| prefix.replace(&s, "").into_owned())
        .take(6)
        .collect();
    out.insert("choices".into(), json!(choices));
    Some(Value::Object(out))
}

pub fn parse_record(text: &str) -> Result<Value, String> {
    if text.is_empty() {
        return Ok(json!({"record":null,"issues":["没有记录块"]}));
    }
    let Some(value) = lenient_json(text) else {
        return Ok(json!({"record":null,"issues":["记录块无法解析"]}));
    };
    let mut issues = Vec::new();
    let Some(record) = normalize_record(&value, &mut issues) else {
        return Ok(json!({"record":null,"issues":["记录块不是对象"]}));
    };
    if record.get("time").is_none() {
        issues.push("缺少 time".into());
    }
    if record["choices"].as_array().is_none_or(Vec::is_empty) {
        issues.push("缺少 choices".into());
    }
    Ok(json!({"record":record,"issues":issues}))
}
