//! Ledger settlement shared by classic and Agent execution. Model changes are
//! validated one by one; invalid changes leave a note rather than abort a turn.
use super::{
    calendar, js_round, js_string, money, num, safe_integer, strings, text, utf16_len,
    utf16_prefix, values,
};
use regex::Regex;
use serde_json::{json, Value};
use unicode_normalization::UnicodeNormalization;
use uuid::Uuid;

const ATTITUDES: [&str; 7] = ["仇视", "敌意", "冷淡", "一般", "友善", "亲近", "生死之交"];
const TITLES: [&str; 26] = [
    "管事",
    "掌柜",
    "东家",
    "郎君",
    "娘子",
    "大人",
    "先生",
    "师傅",
    "老丈",
    "大娘",
    "小娘子",
    "郎中",
    "主簿",
    "县令",
    "司马",
    "校尉",
    "将军",
    "相公",
    "员外",
    "少爷",
    "小姐",
    "娘",
    "郎",
    "公",
    "翁",
    "婆",
];
fn id() -> String {
    Uuid::new_v4().to_string()
}
fn chip(chips: &mut Vec<Value>, s: impl Into<String>, tone: &str) {
    chips.push(json!({"text":s.into(),"tone":tone}));
}
fn clean_names(names: Vec<String>, name: &str) -> Vec<String> {
    let mut out = Vec::new();
    for n in names {
        let n = n.trim();
        if !n.is_empty() && n != name && !out.iter().any(|x| x == n) {
            out.push(n.to_owned());
        }
    }
    out
}
pub fn normalize_name(name: &str) -> String {
    let mut n: String = name
        .nfkc()
        .filter(|c| !c.is_whitespace() && !"·・•．.".contains(*c))
        .collect();
    if utf16_len(&n) > 2 && n.ends_with(['儿', '子', '的']) {
        n.pop();
    }
    n
}
fn split_name(name: &str) -> (String, String) {
    let normalized = normalize_name(name);
    let mut core = normalized
        .strip_suffix('某')
        .unwrap_or(&normalized)
        .to_owned();
    let mut title = String::new();
    for t in TITLES.iter().filter(|t| !t.is_empty()) {
        if utf16_len(&core) > utf16_len(t) && core.ends_with(t) {
            title = (*t).into();
            core = core[..core.len() - t.len()].into();
            break;
        }
        if utf16_len(&core) > utf16_len(t) && core.starts_with(t) {
            title = (*t).into();
            core = core[t.len()..].into();
            break;
        }
    }
    (core, title)
}
fn all_names(entry: &Value) -> Vec<&str> {
    let mut names = vec![text(&entry["name"])];
    names.extend(values(&entry["aliases"]).iter().filter_map(Value::as_str));
    names
}
pub fn match_name(entries: &[Value], name: &str, partial: bool) -> Option<usize> {
    let wanted = normalize_name(name);
    if wanted.is_empty() {
        return None;
    }
    entries
        .iter()
        .position(|e| all_names(e).contains(&name))
        .or_else(|| {
            entries
                .iter()
                .position(|e| all_names(e).iter().any(|n| normalize_name(n) == wanted))
        })
        .or_else(|| {
            entries.iter().position(|e| {
                all_names(e).iter().any(|n| {
                    let (a, at) = split_name(n);
                    let (b, bt) = split_name(name);
                    !a.is_empty() && a == b && at == bt
                })
            })
        })
        .or_else(|| {
            if partial {
                entries.iter().position(|e| {
                    all_names(e).iter().any(|n| {
                        let x = normalize_name(n);
                        utf16_len(&x).min(utf16_len(&wanted)) >= 3
                            && (x.contains(&wanted) || wanted.contains(&x))
                    })
                })
            } else {
                None
            }
        })
}
fn attitude(raw: &Value) -> Option<&'static str> {
    let s = text(raw);
    if s.is_empty() {
        None
    } else {
        ATTITUDES.iter().find(|a| s.contains(**a)).copied()
    }
}
fn dismiss(state: &mut Value, name: &str) {
    let mut names = strings(&state["dismissed"]);
    if !names.iter().any(|n| n == name) {
        names.push(name.into());
    }
    state["dismissed"] = json!(names);
}
fn describe_minutes(minutes: f64, free: bool) -> String {
    if minutes >= 525600.0 * 0.95 {
        return format!("过了 {} 年", js_round(minutes / 525600.0));
    }
    if minutes >= 43200.0 * 0.95 {
        return format!("过了 {} 个月", js_round(minutes / 43200.0));
    }
    if minutes >= 1440.0 {
        return format!("过了 {} 天", js_round(minutes / 1440.0));
    }
    if free {
        return if minutes >= 60.0 {
            format!(
                "过了 {} 小时{}",
                (minutes / 60.0).floor(),
                if minutes % 60.0 != 0.0 {
                    format!(" {} 分钟", minutes % 60.0)
                } else {
                    String::new()
                }
            )
        } else {
            format!("过了 {} 分钟", minutes)
        };
    }
    if minutes >= 120.0 {
        return format!("过了 {} 个时辰", js_round(minutes / 120.0));
    }
    if minutes == 60.0 {
        return "过了半个时辰".into();
    }
    if minutes >= 15.0 {
        return format!("过了 {} 刻", js_round(minutes / 15.0));
    }
    "片刻".into()
}
fn ending_at(minutes: f64, hour: &Value, elapsed: f64, clock: &Value) -> f64 {
    let Some(hour) = hour.as_f64() else {
        return minutes;
    };
    if !clock.is_object() || minutes < 1440.0 {
        return minutes;
    }
    let start = calendar::clock_offset_minutes(clock);
    let end = start + elapsed + minutes;
    let adjusted = (end / 1440.0).floor() * 1440.0 + hour * 60.0 - start - elapsed;
    if adjusted > 0.0 {
        adjusted
    } else {
        minutes
    }
}
fn duplicates_money(name: &str, delta: f64, money: Option<f64>, currency: &Value) -> bool {
    let Some(money) = money.filter(|n| *n != 0.0) else {
        return false;
    };
    if delta == 0.0 {
        return false;
    }
    let n = name.trim();
    let unit = values(&currency["units"]).iter().find(|u| {
        !text(&u["name"]).is_empty()
            && (text(&u["name"]) == n || text(&currency["aliases"][n]) == text(&u["name"]))
    });
    let mut names: Vec<&str> = values(&currency["units"])
        .iter()
        .map(|u| text(&u["name"]))
        .collect();
    if let Some(aliases) = currency["aliases"].as_object() {
        names.extend(aliases.keys().map(String::as_str));
    }
    let number = Regex::new(r"^[\d零〇一二两俩三四五六七八九十百千万]+$").unwrap();
    let amount = if names
        .iter()
        .filter(|u| !u.is_empty())
        .any(|u| n.strip_suffix(u).is_some_and(|s| number.is_match(s)))
    {
        money::parse_money(&json!(n), currency)
    } else {
        None
    };
    let coin = Regex::new(r"^(?:铜钱|铜板|铜子儿?|..[通重元]宝)$")
        .unwrap()
        .is_match(n);
    let each = unit
        .map(|u| num(&u["value"]))
        .or(amount)
        .or(if coin { Some(1.0) } else { None });
    each.is_some_and(|n| delta * n == money)
}
fn valid_binding(b: &Value) -> bool {
    b.is_object()
        && b["bookId"].is_string()
        && b["fanfic"].is_boolean()
        && ["rewrite", "canon"].contains(&text(&b["plot"]))
        && b.get("through").is_some_and(|through| {
            through.is_null() || safe_integer(through).is_some_and(|n| n >= 0.0)
        })
        && safe_integer(&b["position"]).is_some_and(|n| n >= 0.0)
        && b["instructions"].is_string()
        && utf16_len(text(&b["instructions"])) <= 12000
        && ["search", "analysis"].contains(&text(&b["method"]))
        && b.get("analysisId").is_none_or(Value::is_string)
}
fn brief(s: &str) -> String {
    if utf16_len(s) > 20 {
        format!("{}…", utf16_prefix(s, 20))
    } else {
        s.into()
    }
}
fn beat_title(s: &str) -> String {
    let line = s.trim().split('\n').next().unwrap_or("");
    let clause = line
        .split(['，', ',', '。', '；', ';', '：', ':', '！', '!', '？', '?'])
        .next()
        .unwrap_or("");
    let title = if utf16_len(clause) >= 2 { clause } else { line };
    if utf16_len(title) > 16 {
        format!("{}…", utf16_prefix(title, 16))
    } else {
        title.into()
    }
}

/// `options` contains mode, difficulty, currency, clock, fortune, asked and
/// advanceTime. It can also contain `{ctx,opts}` for existing callers.
pub fn apply_record(before: &Value, record: &Value, options: &Value) -> Result<Value, String> {
    if !before.is_object() || !before["protagonist"].is_object() || !before["time"].is_object() {
        return Err("世界状态不完整，无法结算".into());
    }
    let ctx = options.get("ctx").unwrap_or(options);
    let opts = options.get("opts").unwrap_or(options);
    let playing = opts["advanceTime"] != false;
    let mode = ctx["mode"].as_str().unwrap_or("continue");
    let difficulty = ctx["difficulty"].as_str().unwrap_or("标准");
    let currency = ctx
        .get("currency")
        .filter(|c| c.is_object())
        .cloned()
        .or_else(|| before["era"].get("currency").cloned())
        .unwrap_or_else(money::tang_currency);
    let clock = &ctx["clock"];
    let mut s = before.clone();
    let mut me = s["protagonist"].take();
    let free = text(&s["era"]["mode"]) == "free";
    let (mut chips, mut notes, mut log) = (Vec::new(), Vec::<String>::new(), Vec::<String>::new());
    if !playing {
        if let Some(binding) = record.get("sourceSet") {
            if binding.is_null() || valid_binding(binding) {
                s["source"] = binding.clone();
            }
        }
    }
    let parsed = calendar::parse_duration_minutes(&record["time"]);
    let default = match mode {
        "do" => 15.0,
        "say" => 5.0,
        "skip" => 1440.0,
        _ => 30.0,
    };
    let stated = if !playing {
        0.0
    } else {
        parsed.unwrap_or(default)
    };
    if parsed.is_none() && !record["time"].is_null() {
        log.push(format!(
            "时间“{}”无法识别，按 {} 分钟计",
            js_string(&record["time"]),
            stated
        ));
    }
    let elapsed = num(&s["time"]["elapsedMinutes"]);
    let minutes = if mode == "skip" {
        ending_at(stated, &record["hour"], elapsed, clock)
    } else {
        stated
    };
    let now = elapsed + minutes;
    s["time"]["elapsedMinutes"] = json!(now);
    if stated >= 15.0 {
        chip(&mut chips, describe_minutes(stated, free), "info");
    }
    if mode == "skip"
        && num(&ctx["asked"]) != 0.0
        && playing
        && parsed.is_some()
        && stated < num(&ctx["asked"]) / 2.0
    {
        chip(&mut chips, "快进停在这里：有事要你拿主意", "warn");
    }
    let new_years = if free {
        calendar::play_years(elapsed, now)
    } else if clock.is_object() {
        calendar::new_years_between(clock, elapsed, now)
    } else {
        0.0
    };
    if !free {
        let mut events: Vec<&Value> = values(&s["timeline"])
            .iter()
            .filter(|e| {
                e["atMinute"]
                    .as_f64()
                    .is_some_and(|n| n > elapsed && n <= now)
            })
            .collect();
        events.sort_by(|a, b| num(&a["atMinute"]).total_cmp(&num(&b["atMinute"])));
        for event in events {
            chip(
                &mut chips,
                if text(&event["kind"]) == "固定" {
                    format!("📜 {}", text(&event["title"]))
                } else {
                    format!("📜 按史书，此时应有：{}", text(&event["title"]))
                },
                "info",
            );
        }
    }
    if new_years > 0.0 {
        if !me["age"].is_null() {
            me["age"] = json!(num(&me["age"]) + new_years);
        }
        if !free {
            chip(
                &mut chips,
                format!(
                    "{}{}",
                    if new_years == 1.0 {
                        "过年了".into()
                    } else {
                        format!("过了 {} 个年", new_years)
                    },
                    if !me["age"].is_null() {
                        format!("，{} 岁", num(&me["age"]))
                    } else {
                        String::new()
                    }
                ),
                "info",
            );
        } else if !me["age"].is_null() {
            chip(&mut chips, format!("{} 岁了", num(&me["age"])), "info");
        }
    }
    if record.is_null() {
        apply_modes(&mut s, record, playing, &mut chips, &mut log);
        s["protagonist"] = me;
        log.push("本回合没有记录".into());
        return Ok(json!({"state":s,"chips":chips,"notes":notes,"log":log,"minutes":minutes}));
    }
    if !record.is_object() {
        return Err("记录不是对象".into());
    }

    if !free && !text(&record["deviation"]).trim().is_empty() {
        let news = text(&record["deviation"]).trim();
        let when = if !clock["date"].is_null() {
            Some(calendar::now_of(clock, now))
        } else {
            None
        };
        let prefix = when
            .as_ref()
            .and_then(|n| calendar::coerce_date(&n["date"], &clock["rules"]))
            .map(|d| format!("{}：", calendar::format_date(&d, &clock["rules"])))
            .unwrap_or_default();
        let mut deviations = values(&s["deviations"]).to_vec();
        deviations.push(json!(format!("{}{}", prefix, news)));
        s["deviations"] = json!(deviations);
        chip(&mut chips, format!("⚠ 历史偏离：{}", news), "warn");
    }
    if !free {
        let mut timeline = values(&s["timeline"]).to_vec();
        for raw in values(&record["timeline"]) {
            if text(&raw["op"]) == "remove" {
                if let Some(i) = timeline.iter().position(|e| e["id"] == raw["id"]) {
                    timeline.remove(i);
                }
                continue;
            }
            if text(&raw["date"]).trim().is_empty() || text(&raw["title"]).trim().is_empty() {
                log.push(format!("大事缺少日期或内容：{}", raw));
                continue;
            }
            if !clock.is_object() {
                log.push("没有游戏日期，大事无法放进年表".into());
                continue;
            }
            let mut event = calendar::place_event(clock, raw);
            if event["atMinute"].is_null() {
                log.push(format!(
                    "大事“{}”的日期无法换算，只记录不提醒",
                    text(&event["title"])
                ));
            }
            if timeline.iter().any(|e| e["title"] == event["title"]) {
                log.push(format!("年表里已经有“{}”了", text(&event["title"])));
                continue;
            }
            event["id"] = json!(id());
            event["source"] = raw.get("source").cloned().unwrap_or(json!("玩家"));
            timeline.push(event);
            timeline.sort_by(|a, b| {
                a["atMinute"]
                    .as_f64()
                    .unwrap_or(f64::INFINITY)
                    .total_cmp(&b["atMinute"].as_f64().unwrap_or(f64::INFINITY))
            });
        }
        if s.get("timeline").is_some() || !timeline.is_empty() {
            s["timeline"] = json!(timeline);
        }
    }
    if !text(&record["risk"]["what"]).is_empty() && !text(&ctx["fortune"]).is_empty() {
        let result = text(&record["risk"]["result"]);
        let suffix = match result {
            "成" => " · 成了",
            "败" => " · 没成",
            "半成" => " · 成了一半",
            _ => "",
        };
        chip(
            &mut chips,
            format!(
                "签·{} · {}{}",
                text(&ctx["fortune"]),
                text(&record["risk"]["what"]),
                suffix
            ),
            if result == "败" {
                "loss"
            } else if result == "成" {
                "gain"
            } else {
                "info"
            },
        );
    }
    let mut places = values(&s["places"]).to_vec();
    if !text(&record["place"]).is_empty() {
        let name = text(&record["place"]);
        let i = match match_name(&places, name, true) {
            Some(i) => i,
            None => {
                places.push(json!({"id":id(),"name":name,"description":""}));
                places.len() - 1
            }
        };
        if s["placeId"] != places[i]["id"] {
            s["placeId"] = places[i]["id"].clone();
            chip(
                &mut chips,
                format!("到 {}", text(&places[i]["name"])),
                "info",
            );
        }
    }
    s["places"] = json!(places);

    let mut recorded_money = None;
    let mut unpaid: Option<(f64, f64, usize)> = None;
    let mut withheld = Vec::<String>::new();
    if !record["money"].is_null() {
        if let Some(delta) = money::parse_money(&record["money"], &currency) {
            if delta != 0.0 {
                let had = num(&me["stats"]["money"]);
                let next = had + delta;
                if next >= 0.0 {
                    me["stats"]["money"] = json!(next);
                    recorded_money = Some(delta);
                    chip(
                        &mut chips,
                        format!(
                            "钱 {}{}",
                            if delta > 0.0 { "+" } else { "−" },
                            money::format_money(delta.abs(), &currency)
                        ),
                        if delta > 0.0 { "gain" } else { "loss" },
                    );
                } else if difficulty == "宽松" {
                    let owed = -next;
                    me["stats"]["money"] = json!(0);
                    me["stats"]["debt"] = json!(num(&me["stats"]["debt"]) + owed);
                    recorded_money = Some(delta);
                    chip(
                        &mut chips,
                        format!("钱不够，赊欠 {}", money::format_money(owed, &currency)),
                        "warn",
                    );
                    notes.push(format!(
                        "上回合钱不够，主角赊欠了 {}，现在身上没有钱。",
                        money::format_money(owed, &currency)
                    ));
                } else {
                    unpaid = Some((had, -delta, chips.len()));
                    chip(&mut chips, "钱不够，这笔没付成", "warn");
                    log.push(format!("钱 {} 超出余额 {}，交易取消", delta, had));
                }
            }
        } else {
            log.push(format!(
                "钱数“{}”无法识别，已忽略",
                js_string(&record["money"])
            ));
        }
    }
    for (key, name) in [("health", "健康"), ("energy", "精力"), ("fame", "名望")] {
        let Some(raw) = record["stats"][key]
            .as_f64()
            .filter(|n| n.is_finite() && *n != 0.0)
        else {
            continue;
        };
        let delta = js_round(raw).clamp(-40.0, 40.0);
        if delta != raw {
            log.push(format!(
                "{}变化 {} 超出单回合上限，按 {} 计",
                name, raw, delta
            ));
        }
        let old = num(&me["stats"][key]);
        let next = (old + delta).clamp(0.0, 100.0);
        me["stats"][key] = json!(next);
        if next != old {
            chip(
                &mut chips,
                format!("{} {}", name, if delta > 0.0 { "↑" } else { "↓" }),
                if delta > 0.0 { "gain" } else { "loss" },
            );
        }
    }
    if !playing && record["setStats"].is_object() {
        for key in ["money", "health", "energy", "fame"] {
            if let Some(value) = record["setStats"].get(key).and_then(Value::as_f64) {
                me["stats"][key] =
                    json!(value.clamp(0.0, if key == "money" { f64::INFINITY } else { 100.0 }));
            }
        }
    }
    let mut statuses = values(&me["statuses"]).to_vec();
    let dying = statuses.iter().any(|x| text(&x["name"]) == "垂危");
    let wrote_death = playing && record["died"] == true;
    if playing && (num(&me["stats"]["health"]) <= 0.0 || wrote_death) {
        if difficulty == "宽松" {
            me["stats"]["health"] = json!(num(&me["stats"]["health"]).max(1.0));
            if !statuses.iter().any(|x| text(&x["name"]) == "昏迷") {
                statuses.push(json!({"name":"昏迷","detail":"伤重昏迷","sinceMinute":now}));
            }
            chip(&mut chips, "昏迷", "warn");
            if wrote_death {
                notes.push("主角没有死，只是伤重昏了过去：下一段从他醒来写起。".into());
            }
        } else if difficulty == "残酷" || (dying && wrote_death) {
            me["stats"]["health"] = json!(0);
            chip(&mut chips, "你死了", "warn");
        } else if !dying {
            me["stats"]["health"] = json!(1);
            statuses
                .push(json!({"name":"垂危","detail":"伤重濒死，再受重伤就会死","sinceMinute":now}));
            chip(&mut chips, "垂危", "warn");
            notes.push(if wrote_death{"主角没有死，只是伤重垂危、还剩一口气：下一段从这里写起；在伤势好转之前再受重伤，就会死去。"}else{"主角伤重濒死、命悬一线：叙述里要写出来；在伤势好转之前再受重伤，就会死去。"}.into());
        } else {
            me["stats"]["health"] = json!(1);
            if let Some(i) = chips.iter().position(|c| text(&c["text"]) == "健康 ↓") {
                chips[i] = json!({"text":"伤上加伤","tone":"warn"});
            }
            notes
                .push("主角仍然垂危：再受重伤就会死去；真写到他死了，记录里写 died: true。".into());
        }
    } else if dying && num(&me["stats"]["health"]) > 30.0 {
        statuses.retain(|x| text(&x["name"]) != "垂危");
        chip(&mut chips, "垂危 好了", "gain");
    }

    let mut items = values(&me["items"]).to_vec();
    for raw in values(&record["items"]) {
        if raw["set"].is_object() {
            if playing {
                log.push(format!(
                    "物品“{}”的直接修改只能来自面板，已忽略",
                    text(&raw["name"])
                ));
                continue;
            }
            let set = &raw["set"];
            let found = items.iter().position(|i| i["name"] == raw["name"]);
            let name = if text(&set["name"]).trim().is_empty() {
                text(&raw["name"])
            } else {
                text(&set["name"]).trim()
            };
            let quantity = set["quantity"]
                .as_f64()
                .filter(|n| n.is_finite())
                .map(|n| js_round(n).max(0.0));
            if let Some(i) = found {
                let item = &mut items[i];
                item["name"] = json!(name);
                if let Some(q) = quantity {
                    item["quantity"] = json!(q);
                }
                for key in ["unit", "note"] {
                    if set.get(key).is_some() {
                        item[key] = json!(text(&set[key]).trim());
                    }
                }
                if set.get("place").is_some() {
                    item["place"] = if text(&set["place"]).trim().is_empty() {
                        Value::Null
                    } else {
                        json!(text(&set["place"]).trim())
                    };
                }
            } else if quantity.is_some_and(|q| q != 0.0) {
                items.push(json!({"name":name,"quantity":quantity,"unit":text(&set["unit"]).trim(),"place":if text(&set["place"]).trim().is_empty(){Value::Null}else{json!(text(&set["place"]).trim())},"note":text(&set["note"]).trim()}));
            } else {
                log.push(format!("没有 {}，修改已忽略", text(&raw["name"])));
            }
            continue;
        }
        let stripped = Regex::new(r"[^\d+-]")
            .unwrap()
            .replace_all(
                &raw.get("delta")
                    .filter(|v| !v.is_null())
                    .map(js_string)
                    .unwrap_or_default(),
                "",
            )
            .into_owned();
        let delta = raw["delta"].as_f64().or_else(|| {
            if stripped.is_empty() {
                Some(0.0)
            } else {
                stripped.parse::<f64>().ok()
            }
        });
        let Some(delta) = delta.filter(|n| n.is_finite()) else {
            log.push(format!("物品记录不完整：{}", raw));
            continue;
        };
        let name = text(&raw["name"]);
        if name.is_empty() {
            log.push(format!("物品记录不完整：{}", raw));
            continue;
        }
        if delta > 0.0 && unpaid.is_some() {
            withheld.push(name.into());
            log.push(format!("钱不够，未获得 {}", name));
            continue;
        }
        let mut found = match_name(&items, name, true);
        if found.is_none() && playing && duplicates_money(name, delta, recorded_money, &currency) {
            log.push(format!("“{}”的 {} 已记入钱数，不重复放进行囊", name, delta));
            continue;
        }
        if delta == 0.0 && found.is_some() && raw.get("place").is_some() {
            items[found.unwrap()]["place"] = if text(&raw["place"]).is_empty() {
                Value::Null
            } else {
                raw["place"].clone()
            };
            continue;
        }
        if delta > 0.0 {
            if found.is_none() {
                items.push(json!({"name":name,"quantity":0,"unit":text(&raw["unit"]),"place":raw.get("place").cloned().unwrap_or(Value::Null),"note":""}));
                found = Some(items.len() - 1);
            }
            let item = &mut items[found.unwrap()];
            item["quantity"] = json!(num(&item["quantity"]) + delta);
            chip(
                &mut chips,
                format!(
                    "得 {}{}",
                    text(&item["name"]),
                    if delta > 1.0 {
                        format!("×{}", delta)
                    } else {
                        String::new()
                    }
                ),
                "gain",
            );
        } else if delta < 0.0 {
            if found.is_none() || num(&items[found.unwrap()]["quantity"]) <= 0.0 {
                log.push(format!("没有 {}，无法减少", name));
                notes.push(format!("主角身上并没有“{}”。", name));
                continue;
            }
            let item = &mut items[found.unwrap()];
            let old = num(&item["quantity"]);
            let used = old.min(-delta);
            if used < -delta {
                log.push(format!("{} 只有 {}，按实际扣减", text(&item["name"]), old));
            }
            item["quantity"] = json!(old - used);
            chip(
                &mut chips,
                format!(
                    "失 {}{}",
                    text(&item["name"]),
                    if used > 1.0 {
                        format!("×{}", used)
                    } else {
                        String::new()
                    }
                ),
                "loss",
            );
        }
    }
    items.retain(|i| num(&i["quantity"]) > 0.0);
    me["items"] = json!(items);
    if let Some((had, cost, index)) = unpaid {
        if !withheld.is_empty() {
            chips[index]["text"] = json!(format!(
                "{}，{}没到手",
                text(&chips[index]["text"]),
                withheld.join("、")
            ));
        }
        notes.push(format!(
            "上回合主角只有 {}，付不起 {}，这笔交易没有成交{}；请在叙述中自然交代{}。",
            money::format_money(had, &currency),
            money::format_money(cost, &currency),
            if !withheld.is_empty() {
                format!("，记录里同时得到的{}也没有记上", withheld.join("、"))
            } else {
                String::new()
            },
            if !withheld.is_empty() {
                "，其中与这笔钱无关、确实到手的，本回合再记一次"
            } else {
                ""
            }
        ));
    }

    if !playing && record["profile"].is_object() {
        let profile = &record["profile"];
        if profile.get("name").is_some() {
            let name = text(&profile["name"]).trim();
            if name.is_empty() {
                log.push("名字不能为空，没有生效".into());
            } else if name != text(&me["name"]) {
                let mut aliases = strings(&me["aliases"]);
                aliases.push(text(&me["name"]).into());
                me["aliases"] = json!(clean_names(aliases, name));
                me["name"] = json!(name);
            }
        }
        if let Some(age) = profile.get("age") {
            if age.is_null() {
                me["age"] = Value::Null;
            } else if safe_integer(age).is_some_and(|n| n >= 1.0 && (free || n <= 120.0)) {
                me["age"] = age.clone();
            } else {
                log.push(if free {
                    format!("年龄 {} 不是有效的正整数，没有生效", js_string(age))
                } else {
                    format!("年龄 {} 不在 1～120 之间，没有生效", js_string(age))
                });
            }
        }
        for key in ["identity", "origin", "cheat"] {
            if profile.get(key).is_some() {
                me[key] = json!(text(&profile[key]).trim());
            }
        }
        if profile["panel"].is_string() {
            me["panel"] = profile["panel"].clone();
        }
    }
    apply_people(
        &mut s, record, playing, free, now, &mut chips, &mut notes, &mut log,
    );
    for raw in values(&record["status"]) {
        let name = text(&raw["name"]);
        if name.is_empty() {
            continue;
        }
        let removing = Regex::new(r"(?i)^(remove|del|-|解除|痊愈|结束)")
            .unwrap()
            .is_match(text(&raw["op"]));
        let found = match_name(&statuses, name, true);
        if removing {
            if let Some(i) = found {
                let current = statuses.remove(i);
                chip(
                    &mut chips,
                    format!("{} 好了", text(&current["name"])),
                    "gain",
                );
            }
        } else if let Some(i) = found {
            if !text(&raw["detail"]).is_empty() {
                statuses[i]["detail"] = raw["detail"].clone();
            }
        } else {
            statuses.push(json!({"name":name,"detail":text(&raw["detail"]),"sinceMinute":now}));
            chip(&mut chips, name, "warn");
        }
    }
    if playing && statuses.len() > 12 {
        let mut oldest: Vec<usize> = (0..statuses.len())
            .filter(|i| !matches!(text(&statuses[*i]["name"]), "垂危" | "昏迷"))
            .collect();
        oldest.sort_by(|a, b| {
            num(&statuses[*a]["sinceMinute"]).total_cmp(&num(&statuses[*b]["sinceMinute"]))
        });
        oldest.truncate(statuses.len() - 12);
        let names: Vec<&str> = oldest.iter().map(|i| text(&statuses[*i]["name"])).collect();
        log.push(format!(
            "状况超过 12 项，去掉了最早的：{}",
            names.join("、")
        ));
        chip(
            &mut chips,
            format!("去掉 {} 项旧状况", oldest.len()),
            "info",
        );
        statuses = statuses
            .into_iter()
            .enumerate()
            .filter(|(i, _)| !oldest.contains(i))
            .map(|(_, s)| s)
            .collect();
    }
    me["statuses"] = json!(statuses);
    apply_goals(&mut s, record, now, &mut chips, &mut log);
    apply_rules(&mut s, record, free, clock, &mut log)?;
    apply_cards(&mut s, record, &mut log);
    apply_places(&mut s, record, &mut log);
    apply_modes(&mut s, record, playing, &mut chips, &mut log);
    s["protagonist"] = me;
    Ok(json!({"state":s,"chips":chips,"notes":notes,"log":log,"minutes":minutes}))
}

fn apply_people(
    s: &mut Value,
    record: &Value,
    playing: bool,
    free: bool,
    now: f64,
    chips: &mut Vec<Value>,
    notes: &mut Vec<String>,
    log: &mut Vec<String>,
) {
    let mut people = values(&s["people"]).to_vec();
    for raw in values(&record["people"]) {
        if !text(&raw["id"]).is_empty() {
            let Some(i) = people.iter().position(|p| p["id"] == raw["id"]) else {
                log.push(format!("人物“{}”不存在，修改已忽略", text(&raw["name"])));
                continue;
            };
            if text(&raw["op"]) == "remove" {
                dismiss(s, text(&people[i]["name"]));
                people.remove(i);
                continue;
            }
            let person = &mut people[i];
            let name = text(&raw["name"]).trim();
            let renamed = !name.is_empty() && name != text(&person["name"]);
            let mut aliases = strings(raw.get("aliases").unwrap_or(&person["aliases"]));
            if renamed {
                aliases.push(text(&person["name"]).into());
                person["name"] = json!(name);
            }
            person["aliases"] = json!(clean_names(aliases, text(&person["name"])));
            for (key, target) in [("role", "role"), ("note", "notes")] {
                if raw.get(key).is_some() {
                    person[target] = json!(text(&raw[key]).trim());
                }
            }
            if raw.get("origin").is_some() {
                if text(&raw["origin"]).trim().is_empty() {
                    person.as_object_mut().unwrap().remove("origin");
                } else {
                    person["origin"] = json!(text(&raw["origin"]).trim());
                }
            }
            if let Some(a) = attitude(&raw["attitude"]) {
                person["attitude"] = json!(a);
            }
            if let Some(alive) = raw.get("alive") {
                person["alive"] = alive.clone();
            }
            continue;
        }
        let name = text(&raw["name"]);
        if name.is_empty() {
            continue;
        }
        let found = match_name(&people, name, false).or_else(|| {
            strings(&raw["aliases"])
                .iter()
                .find_map(|a| match_name(&people, a, false))
        });
        let Some(i) = found else {
            let mut person = json!({"id":id(),"name":name,"aliases":strings(&raw["aliases"]),"role":text(&raw["role"]),"attitude":attitude(&raw["attitude"]).unwrap_or("一般"),"alive":raw["alive"]!=false,"notes":text(&raw["note"]),"lastSeenMinute":now});
            if !text(&raw["origin"]).trim().is_empty() {
                person["origin"] = json!(text(&raw["origin"]).trim());
            }
            people.push(person);
            chip(chips, format!("结识 {}", name), "info");
            log.push(format!("新人物：{}", name));
            continue;
        };
        let person = &mut people[i];
        let mut aliases = strings(&person["aliases"]);
        if name != text(&person["name"]) {
            let learned = strings(&raw["aliases"])
                .iter()
                .any(|a| a == text(&person["name"]) || aliases.contains(a));
            if learned {
                let old = text(&person["name"]);
                if !aliases.iter().any(|a| a == old) {
                    aliases.push(old.into());
                }
                chip(chips, format!("得知 {} 名叫 {}", old, name), "info");
                person["name"] = json!(name);
            } else if !aliases.iter().any(|a| a == name) {
                aliases.push(name.into());
            }
        }
        person["aliases"] = json!(aliases);
        if !text(&raw["role"]).is_empty() {
            person["role"] = raw["role"].clone();
        }
        if raw.get("note").is_some() {
            let next = text(&raw["note"]).trim();
            if next != text(&person["notes"]) {
                if !next.is_empty()
                    && text(&person["origin"]).is_empty()
                    && !text(&person["notes"]).trim().is_empty()
                {
                    person["origin"] = json!(text(&person["notes"]).trim());
                }
                person["notes"] = json!(next);
            }
        }
        if playing {
            person["lastSeenMinute"] = json!(now);
        }
        if let Some(a) = attitude(&raw["attitude"]) {
            if a != text(&person["attitude"]) {
                let old = ATTITUDES
                    .iter()
                    .position(|x| *x == text(&person["attitude"]));
                let up =
                    old.is_none_or(|old| ATTITUDES.iter().position(|x| *x == a).unwrap() > old);
                person["attitude"] = json!(a);
                chip(
                    chips,
                    format!("{}：{}", text(&person["name"]), a),
                    if up { "gain" } else { "loss" },
                );
            }
        }
        if raw["alive"] == false && person["alive"] == true {
            person["alive"] = json!(false);
            chip(chips, format!("{} 身故", text(&person["name"])), "warn");
        } else if raw["alive"] == true && person["alive"] == false {
            if !playing || free {
                person["alive"] = json!(true);
            } else {
                log.push(format!("{} 已死亡，不能复活", text(&person["name"])));
                notes.push(format!("{} 已经去世。", text(&person["name"])));
            }
        }
    }
    s["people"] = json!(people);
}
fn step(goal: &mut Value, news: &Value, now: f64) {
    let t = text(news).trim();
    if t.is_empty() {
        return;
    }
    let mut steps = values(&goal["steps"]).to_vec();
    if steps.last().is_some_and(|s| text(&s["text"]) == t) {
        return;
    }
    steps.push(json!({"minute":now,"text":t}));
    if steps.len() > 12 {
        steps.drain(..steps.len() - 12);
    }
    goal["steps"] = json!(steps);
}
fn apply_goals(
    s: &mut Value,
    record: &Value,
    now: f64,
    chips: &mut Vec<Value>,
    log: &mut Vec<String>,
) {
    let mut goals = values(&s["goals"]).to_vec();
    for raw in values(&record["goals"]) {
        if text(&raw["name"]).is_empty() && text(&raw["id"]).is_empty() {
            continue;
        }
        let op = raw["op"].as_str().unwrap_or("progress").to_lowercase();
        let found = if !text(&raw["id"]).is_empty() {
            goals.iter().position(|g| g["id"] == raw["id"])
        } else {
            let candidates: Vec<usize> = (0..goals.len())
                .filter(|i| text(&goals[*i]["status"]) == "进行中" || op == "add")
                .collect();
            let entries: Vec<Value> = candidates.iter().map(|i| goals[*i].clone()).collect();
            match_name(&entries, text(&raw["name"]), true).map(|i| candidates[i])
        };
        if op == "add" {
            if let Some(i) = found {
                log.push(format!("已经有目标“{}”了", text(&goals[i]["name"])));
                continue;
            }
            let kind = match text(&raw["kind"]) {
                "主线" => "主线",
                "心愿" => "心愿",
                _ => "支线",
            };
            let mut goal = json!({"id":id(),"name":text(&raw["name"]),"kind":kind,"progress":text(&raw["detail"]),"status":"进行中","startedMinute":now,"steps":[]});
            step(&mut goal, &raw["detail"], now);
            goals.push(goal);
            chip(
                chips,
                format!(
                    "{}：{}",
                    match kind {
                        "心愿" => "新心愿",
                        "主线" => "主线目标",
                        _ => "新目标",
                    },
                    text(&raw["name"])
                ),
                "info",
            );
            continue;
        }
        let Some(i) = found else {
            log.push(format!("目标“{}”不存在，{} 已忽略", text(&raw["name"]), op));
            continue;
        };
        let goal = &mut goals[i];
        if op == "reopen" {
            if text(&goal["status"]) != "进行中" {
                goal["status"] = json!("进行中");
                goal.as_object_mut().unwrap().remove("endedMinute");
                step(goal, &json!("重新开始"), now);
            }
            continue;
        }
        if text(&goal["status"]) != "进行中" {
            continue;
        }
        step(goal, &raw["detail"], now);
        if !text(&raw["detail"]).is_empty() {
            goal["progress"] = raw["detail"].clone();
        }
        let end = match op.as_str() {
            "done" => "完成",
            "fail" => "失败",
            "abandon" => "放弃",
            _ => continue,
        };
        goal["status"] = json!(end);
        goal["endedMinute"] = json!(now);
        chip(
            chips,
            format!("{}：{}", end, text(&goal["name"])),
            if end == "完成" {
                "gain"
            } else if end == "失败" {
                "loss"
            } else {
                "info"
            },
        );
    }
    s["goals"] = json!(goals);
}
fn apply_rules(s: &mut Value, record: &Value, free: bool, clock: &Value, log: &mut Vec<String>) -> Result<(), String> {
    if let Some(changes) = record["rules"].get("clock") {
        *s = super::clock::apply_display(s, changes)?;
    }
    let rules = &record["rules"];
    if rules["currency"].is_array() {
        let problems = money::currency_issues(values(&rules["currency"]));
        if let Some(problem) = problems.first() {
            log.push(format!("货币设置没有生效：{}", text(&problem["message"])));
        } else {
            let units: Vec<Value> = values(&rules["currency"])
                .iter()
                .map(|u| json!({"name":text(&u["name"]).trim(),"value":u["value"]}))
                .collect();
            let names: Vec<String> = units.iter().map(|u| text(&u["name"]).into()).collect();
            let aliases: serde_json::Map<String, Value> = s["era"]["currency"]["aliases"]
                .as_object()
                .into_iter()
                .flat_map(|a| a.iter())
                .filter(|(alias, target)| {
                    names.iter().any(|n| n == text(target)) && !names.contains(alias)
                })
                .map(|(a, t)| (a.clone(), t.clone()))
                .collect();
            s["era"]["currency"] = json!({"units":units});
            if !aliases.is_empty() {
                s["era"]["currency"]["aliases"] = json!(aliases);
            }
        }
    }
    let mut start_moved = !free && rules.get("lunar").is_some();
    if !free && rules.get("lunar").is_some() {
        if !s["era"]["calendar"].is_object() {
            s["era"]["calendar"] = json!({});
        }
        s["era"]["calendar"]["lunar"] = rules["lunar"].clone();
        if s["time"]["date"].is_object() && rules.get("date").is_none() {
            s["time"]["date"]["lunar"] = rules["lunar"].clone();
        }
    }
    if !free && rules.get("date").is_some() {
        let calendar = s["era"].get("calendar").cloned().unwrap_or(json!({}));
        let mut raw = rules["date"].clone();
        if raw.is_object() {
            raw["lunar"] = calendar
                .get("lunar")
                .filter(|v| !v.is_null())
                .unwrap_or(&rules["date"]["lunar"])
                .clone();
        }
        let date = if !rules["date"].is_null() {
            calendar::coerce_date(&raw, &calendar)
        } else {
            None
        };
        if !rules["date"].is_null() && date.is_none() {
            log.push("开局日期写得不完整，没有生效".into());
        } else {
            if let Some(d) = &date {
                s["time"]["start"] = json!(calendar::format_date(d, &calendar));
            }
            s["time"]["date"] = json!(date);
            start_moved = true;
        }
    }
    if !free && start_moved && !values(&s["timeline"]).is_empty() {
        let calendar = s["era"]
            .get("calendar")
            .or_else(|| clock.get("rules"))
            .cloned()
            .unwrap_or(json!({}));
        let start = s["time"]
            .get("date")
            .or_else(|| clock.get("date"))
            .cloned()
            .unwrap_or(Value::Null);
        let c = json!({"date":start,"hour":s["time"].get("startHour").or_else(||clock.get("hour")).cloned().unwrap_or(json!(8)),"label":s["time"]["start"],"rules":calendar});
        s["timeline"] = json!(calendar::retime(values(&s["timeline"]), &c));
    }
    Ok(())
}
fn apply_cards(s: &mut Value, record: &Value, log: &mut Vec<String>) {
    let mut cards = values(&s["cards"]).to_vec();
    for raw in values(&record["cards"]) {
        let kind = raw["kind"]
            .as_str()
            .filter(|k| ["时代", "势力", "物品", "设定"].contains(k));
        let name = raw["name"].as_str().map(str::trim);
        let found = if !text(&raw["id"]).is_empty() {
            cards.iter().position(|c| c["id"] == raw["id"])
        } else if kind == Some("时代") {
            cards.iter().position(|c| text(&c["kind"]) == "时代")
        } else if let Some(name) = name.filter(|n| !n.is_empty()) {
            let indexes: Vec<usize> = (0..cards.len())
                .filter(|i| {
                    text(&cards[*i]["kind"]) != "时代"
                        && kind.is_none_or(|k| text(&cards[*i]["kind"]) == k)
                })
                .collect();
            let entries: Vec<Value> = indexes
                .iter()
                .map(|i| json!({"name":cards[*i]["name"],"aliases":cards[*i]["keys"]}))
                .collect();
            match_name(&entries, name, true).map(|i| indexes[i])
        } else {
            None
        };
        if text(&raw["op"]) == "remove" {
            if let Some(i) = found {
                let card = cards.remove(i);
                if text(&card["kind"]) != "时代" {
                    dismiss(s, text(&card["name"]));
                }
            } else {
                log.push(format!(
                    "卡片“{}”不存在，删除已忽略",
                    name.unwrap_or(text(&raw["id"]))
                ));
            }
            continue;
        }
        if let Some(i) = found {
            let card = &mut cards[i];
            let renamed = (!text(&raw["id"]).is_empty() || text(&card["kind"]) == "时代")
                && name.is_some_and(|n| !n.is_empty() && n != text(&card["name"]));
            let mut keys = strings(raw.get("keys").unwrap_or(&card["keys"]));
            if renamed {
                if text(&card["kind"]) != "时代" {
                    keys.push(text(&card["name"]).into());
                }
                card["name"] = json!(name);
            }
            if raw.get("keys").is_some() || renamed {
                card["keys"] = json!(clean_names(keys, text(&card["name"])));
            }
            if raw.get("content").is_some() {
                card["content"] = json!(text(&raw["content"]).trim());
            }
            if !text(&raw["source"]).is_empty() {
                card["source"] = raw["source"].clone();
            }
            continue;
        }
        let (Some(kind), Some(name)) = (kind, name.filter(|n| !n.is_empty())) else {
            log.push(format!("卡片缺少种类或名称：{}", raw));
            continue;
        };
        cards.push(json!({"id":id(),"kind":kind,"name":name,"keys":clean_names(strings(&raw["keys"]),name),"content":text(&raw["content"]).trim(),"source":raw.get("source").cloned().unwrap_or(json!("玩家"))}));
    }
    s["cards"] = json!(cards);
}
fn apply_places(s: &mut Value, record: &Value, log: &mut Vec<String>) {
    let mut places = values(&s["places"]).to_vec();
    for raw in values(&record["places"]) {
        let name = raw["name"].as_str().map(str::trim);
        let found = if !text(&raw["id"]).is_empty() {
            places.iter().position(|p| p["id"] == raw["id"])
        } else {
            name.filter(|n| !n.is_empty())
                .and_then(|n| match_name(&places, n, true))
        };
        if text(&raw["op"]) == "remove" {
            if let Some(i) = found {
                if places[i]["id"] == s["placeId"] {
                    log.push(format!(
                        "“{}”是当前所在地，不能删除",
                        text(&places[i]["name"])
                    ));
                } else {
                    let place = places.remove(i);
                    dismiss(s, text(&place["name"]));
                }
            } else {
                log.push(format!(
                    "地点“{}”不存在，删除已忽略",
                    name.unwrap_or(text(&raw["id"]))
                ));
            }
            continue;
        }
        if let Some(i) = found {
            let place = &mut places[i];
            let renamed = !text(&raw["id"]).is_empty()
                && name.is_some_and(|n| !n.is_empty() && n != text(&place["name"]));
            let mut aliases = strings(raw.get("aliases").unwrap_or(&place["aliases"]));
            if renamed {
                aliases.push(text(&place["name"]).into());
                place["name"] = json!(name);
            }
            if raw.get("aliases").is_some() || renamed {
                place["aliases"] = json!(clean_names(aliases, text(&place["name"])));
            }
            if raw.get("description").is_some() {
                place["description"] = json!(text(&raw["description"]).trim());
            }
            if !text(&raw["source"]).is_empty() {
                place["source"] = raw["source"].clone();
            }
            continue;
        }
        let Some(name) = name.filter(|n| !n.is_empty()) else {
            log.push(format!("地点缺少名称：{}", raw));
            continue;
        };
        let mut place = json!({"id":id(),"name":name,"aliases":clean_names(strings(&raw["aliases"]),name),"description":text(&raw["description"]).trim()});
        if !text(&raw["source"]).is_empty() {
            place["source"] = raw["source"].clone();
        }
        places.push(place);
    }
    s["places"] = json!(places);
}

fn minute(v: &Value) -> Option<f64> {
    v.as_f64()
        .filter(|n| n.is_finite() && *n >= 0.0)
        .map(js_round)
}
fn deadline(limit: &str, started: f64) -> Option<f64> {
    let s = limit.trim();
    if s.is_empty() || Regex::new(r"^\d+$").unwrap().is_match(s) {
        return None;
    }
    calendar::parse_duration_minutes(&json!(s))
        .filter(|n| *n != 0.0)
        .map(|m| started + m)
}
fn check_script(raw: &Value) -> Result<Value, String> {
    let Some(input) = raw["beats"].as_array() else {
        return Err("剧本的内容不完整".into());
    };
    let mut beats = Vec::new();
    for item in input {
        let t = text(&item["text"]).trim();
        if t.is_empty() {
            continue;
        }
        let status = item["status"].as_str().unwrap_or("todo");
        if !["todo", "done", "skipped"].contains(&status) {
            return Err("剧本的内容不完整".into());
        }
        let mut beat = json!({"id":if text(&item["id"]).trim().is_empty(){id()}else{text(&item["id"]).trim().into()},"text":t,"status":status});
        if status != "todo" {
            if let Some(ended) = minute(&item["endedMinute"]) {
                beat["endedMinute"] = json!(ended);
            }
        }
        beats.push(beat);
    }
    if beats.is_empty() {
        return Err("剧本至少要有一幕".into());
    }
    if beats.len() > 12 {
        return Err("剧本最多 12 幕".into());
    }
    Ok(
        json!({"line":text(&raw["line"]).trim(),"beats":beats,"ending":text(&raw["ending"]).trim(),"steer":if text(&raw["steer"])=="firm"{"firm"}else{"gentle"}}),
    )
}
fn check_challenge(raw: &Value) -> Result<Value, String> {
    if !raw.is_object() {
        return Err("挑战的内容不完整".into());
    }
    let goal = text(&raw["goal"]).trim();
    if goal.is_empty() {
        return Err("挑战要有一个目标".into());
    }
    let status = text(&raw["status"]);
    let Some(started) = minute(&raw["startedMinute"]) else {
        return Err("挑战的内容不完整".into());
    };
    if !["active", "won", "lost", "abandoned"].contains(&status) {
        return Err("挑战的内容不完整".into());
    }
    let limit = text(&raw["limit"]).trim();
    let mut c = json!({"goal":goal,"limit":limit,"deadlineMinute":deadline(limit,started),"failIf":text(&raw["failIf"]).trim(),"progress":text(&raw["progress"]).trim(),"status":status,"startedMinute":started});
    if status != "active" {
        if let Some(ended) = minute(&raw["endedMinute"]) {
            c["endedMinute"] = json!(ended);
        }
        if !text(&raw["outcome"]).trim().is_empty() {
            c["outcome"] = json!(text(&raw["outcome"]).trim());
        }
    }
    if let Some(turns) = minute(&raw["turns"]).filter(|n| *n != 0.0) {
        c["turns"] = json!(turns);
    }
    Ok(c)
}
fn apply_modes(
    s: &mut Value,
    record: &Value,
    playing: bool,
    chips: &mut Vec<Value>,
    log: &mut Vec<String>,
) {
    let now = num(&s["time"]["elapsedMinutes"]);
    if let Some(raw) = record.get("scriptSet") {
        if playing {
            log.push("剧本只能在剧本页修改，记录里的修改已忽略".into());
        } else if raw.is_null() {
            s.as_object_mut().unwrap().remove("script");
        } else {
            match check_script(raw) {
                Err(e) => log.push(e),
                Ok(mut next) => {
                    for b in next["beats"].as_array_mut().unwrap() {
                        if text(&b["status"]) != "todo" && b["endedMinute"].is_null() {
                            b["endedMinute"] = json!(now);
                        }
                    }
                    s["script"] = next;
                }
            }
        }
    }
    if let Some(raw) = record.get("challengeSet") {
        if playing {
            log.push("挑战只能在挑战页修改，记录里的修改已忽略".into());
        } else if raw.is_null() {
            s.as_object_mut().unwrap().remove("challenge");
        } else {
            match check_challenge(raw) {
                Err(e) => log.push(e),
                Ok(mut next) => {
                    if text(&next["status"]) == "active"
                        && next["deadlineMinute"]
                            .as_f64()
                            .is_some_and(|deadline| deadline <= now)
                    {
                        log.push("这个期限已经过了".into());
                    } else {
                        if text(&next["status"]) != "active" && next["endedMinute"].is_null() {
                            next["endedMinute"] = json!(now);
                        }
                        if !text(&next["limit"]).is_empty() && next["deadlineMinute"].is_null() {
                            log.push(format!(
                                "期限“{}”无法换算，按不限时处理",
                                text(&next["limit"])
                            ));
                        }
                        s["challenge"] = next;
                    }
                }
            }
        }
    }
    if text(&record["beat"]) == "done" {
        if let Some(beats) = s["script"]["beats"].as_array_mut() {
            if let Some(i) = beats.iter().position(|b| text(&b["status"]) == "todo") {
                beats[i]["status"] = json!("done");
                beats[i]["endedMinute"] = json!(now);
                chip(
                    chips,
                    format!(
                        "📜 第 {} 幕演完：{}",
                        i + 1,
                        beat_title(text(&beats[i]["text"]))
                    ),
                    "info",
                );
            } else {
                log.push("没有正在演的一幕，beat 已忽略".into());
            }
        } else {
            log.push("没有正在演的一幕，beat 已忽略".into());
        }
    }
    if text(&s["challenge"]["status"]) != "active" {
        if !record["challenge"].is_null() {
            log.push("没有进行中的挑战，记录里的挑战进展已忽略".into());
        }
        return;
    }
    let c = &mut s["challenge"];
    if playing {
        c["turns"] = json!(num(&c["turns"]) + 1.0);
    }
    let news = &record["challenge"];
    let progress = text(&news["progress"]).trim();
    if !progress.is_empty() && progress != text(&c["progress"]) {
        c["progress"] = json!(progress);
        if text(&news["result"]).is_empty() {
            chip(chips, format!("⚑ 挑战进展：{}", brief(progress)), "info");
        }
    }
    if !text(&news["result"]).is_empty() {
        c["status"] = news["result"].clone();
        c["endedMinute"] = json!(now);
        let why = text(&news["why"]).trim();
        c["outcome"] = json!(if !why.is_empty() {
            why
        } else if !text(&c["progress"]).is_empty() {
            text(&c["progress"])
        } else if text(&news["result"]) == "won" {
            "达成了目标"
        } else {
            "没能完成"
        });
        if text(&news["result"]) == "won" {
            chip(chips, "⚑ 挑战成功", "gain");
        } else {
            chip(
                chips,
                format!("⚑ 挑战失败：{}", brief(text(&c["outcome"]))),
                "loss",
            );
        }
    } else if playing
        && c["deadlineMinute"]
            .as_f64()
            .is_some_and(|deadline| now >= deadline)
    {
        c["status"] = json!("lost");
        c["endedMinute"] = c["deadlineMinute"].clone();
        c["outcome"] = json!("期限已到");
        chip(chips, "⚑ 挑战失败：期限已到", "loss");
    }
}
