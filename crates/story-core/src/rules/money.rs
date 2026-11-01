use super::{calendar::parse_chinese_number, js_round, num, text, values};
use regex::Regex;
use serde_json::{json, Value};

pub fn tang_currency() -> Value {
    json!({"units":[{"name":"贯","value":1000},{"name":"文","value":1}],"aliases":{"缗":"贯","钱":"文","枚":"文","个":"文"}})
}

pub fn format_money(amount: f64, currency: &Value) -> String {
    let mut rest = js_round(amount).abs();
    let mut parts = Vec::new();
    for unit in values(&currency["units"]) {
        let value = num(&unit["value"]);
        if value <= 0.0 {
            continue;
        }
        let n = (rest / value).floor();
        rest -= n * value;
        if n != 0.0 {
            parts.push(format!("{} {}", n, text(&unit["name"])).trim().to_owned());
        }
    }
    let fallback = currency["units"]
        .as_array()
        .and_then(|a| a.last())
        .map(|u| text(&u["name"]))
        .unwrap_or("");
    format!(
        "{}{}",
        if amount < 0.0 { "−" } else { "" },
        if parts.is_empty() {
            format!("0 {}", fallback).trim().into()
        } else {
            parts.join(" ")
        }
    )
}

pub fn parse_money(input: &Value, currency: &Value) -> Option<f64> {
    if let Some(n) = input.as_f64() {
        return n.is_finite().then(|| js_round(n));
    }
    let raw = input.as_str()?;
    let raw = Regex::new(r"\s+|，|,").unwrap().replace_all(raw, "");
    let (sign, s) = if raw.starts_with(['-', '−', '－']) {
        (-1.0, &raw[raw.chars().next()?.len_utf8()..])
    } else if raw.starts_with(['+', '＋']) {
        (1.0, &raw[raw.chars().next()?.len_utf8()..])
    } else {
        (1.0, raw.as_ref())
    };
    if Regex::new(r"^\d+$").unwrap().is_match(s) {
        return s.parse::<f64>().ok().map(|n| sign * n);
    }
    let mut names: Vec<String> = values(&currency["units"])
        .iter()
        .map(|u| regex::escape(text(&u["name"])))
        .collect();
    names.extend(
        currency["aliases"]
            .as_object()
            .into_iter()
            .flat_map(|a| a.keys().map(|k| regex::escape(k))),
    );
    if names.is_empty() {
        return None;
    }
    let pattern = Regex::new(&format!(
        r"(\d+(?:\.\d+)?|[零〇一二两俩三四五六七八九十百千]+?)({})(半)?",
        names.join("|")
    ))
    .ok()?;
    let (mut total, mut matched) = (0.0, false);
    for m in pattern.captures_iter(s) {
        let Some(amount) = parse_chinese_number(&m[1]) else {
            continue;
        };
        let canonical = currency["aliases"][&m[2]].as_str().unwrap_or(&m[2]);
        let Some(unit) = values(&currency["units"])
            .iter()
            .find(|u| text(&u["name"]) == canonical)
        else {
            continue;
        };
        total += (amount + if m.get(3).is_some() { 0.5 } else { 0.0 }) * num(&unit["value"]);
        matched = true;
    }
    matched.then(|| sign * js_round(total))
}

pub fn currency_issues(units: &[Value]) -> Vec<Value> {
    if units.is_empty() {
        return vec![json!({"index":null,"message":"缺少货币单位"})];
    }
    let mut seen = std::collections::HashSet::new();
    let mut issues = Vec::new();
    for (i, u) in units.iter().enumerate() {
        let name = text(&u["name"]).trim();
        if name.is_empty() {
            issues.push(json!({"index":i,"message":"货币单位缺少名字"}));
            continue;
        }
        if !seen.insert(name) {
            issues.push(json!({"index":i,"message":format!("单位“{}”重复",name)}));
        }
        let value = u["value"].as_f64();
        if value.is_none_or(|n| n.fract() != 0.0 || n < 1.0) {
            issues.push(json!({"index":i,"message":format!("“{}”缺少换算（value 要是正整数，以最小单位计）",name)}));
            continue;
        }
        let value = value.unwrap();
        if let Some(next) = units.get(i + 1) {
            if let Some(v) = next["value"]
                .as_f64()
                .filter(|n| n.fract() == 0.0 && *n >= 1.0)
            {
                if v >= value {
                    issues.push(json!({"index":i,"message":"单位要从大到小排列"}));
                } else if value % v != 0.0 {
                    issues.push(json!({"index":i,"message":format!("“{}”不是“{}”的整数倍",name,text(&next["name"]))}));
                }
            }
        }
        if i == units.len() - 1 && value != 1.0 {
            issues.push(json!({"index":i,"message":"最小单位的 value 要是 1"}));
        }
    }
    issues
}
