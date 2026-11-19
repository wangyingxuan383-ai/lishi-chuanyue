//! Model-authored organization is a proposal, never an unrestricted state patch.
//! These boundaries mirror the classic codex, upkeep and chapter parsers.
use crate::rules::{apply::match_name, record::lenient_json, utf16_prefix, values};
use regex::Regex;
use serde_json::{json, Map, Value};

const KINDS: [&str; 3] = ["势力", "物品", "设定"];
const MAX_EACH: usize = 3;

fn text(value: &Value, max: usize) -> String {
    utf16_prefix(value.as_str().unwrap_or("").trim(), max)
}

fn names(value: &Value) -> Vec<String> {
    values(value)
        .iter()
        .map(|v| text(v, 20))
        .filter(|s| !s.is_empty())
        .take(4)
        .collect()
}

fn card_kind(value: &Value) -> &str {
    value
        .as_str()
        .filter(|s| KINDS.contains(s))
        .unwrap_or("设定")
}

fn card_names(state: &Value) -> Vec<Value> {
    values(&state["cards"])
        .iter()
        .filter(|c| c["kind"] != "时代")
        .map(|c| json!({"id": c["id"], "name": c["name"], "aliases": c["keys"]}))
        .collect()
}

fn dismissed(state: &Value, name: &str) -> bool {
    values(&state["dismissed"])
        .iter()
        .any(|n| n.as_str() == Some(name))
}

fn short_taboo_line(content: &str) -> String {
    let line_pattern = Regex::new(r"^\s*不要出现\s*[：:]\s*(.*)$").unwrap();
    content
        .split('\n')
        .filter_map(|line| {
            let Some(caps) = line_pattern.captures(line) else {
                return Some(line.to_owned());
            };
            let items: Vec<&str> = caps[1]
                .split(['；', ';'])
                .map(str::trim)
                .filter(|s| !s.is_empty())
                .take(8)
                .collect();
            (!items.is_empty()).then(|| format!("不要出现：{}", items.join("；")))
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn patch(fields: Vec<(&str, Vec<Value>)>) -> Option<Value> {
    let fields: Map<String, Value> = fields
        .into_iter()
        .filter(|(_, items)| !items.is_empty())
        .map(|(name, items)| (name.to_owned(), Value::Array(items)))
        .collect();
    (!fields.is_empty()).then_some(Value::Object(fields))
}

/// Build setup proposals without replacing the player's era card or described places.
pub fn codex_patch(raw: &str, state: &Value, options: &Value) -> Option<Value> {
    let value = lenient_json(raw)?;
    value.as_object()?;
    let free = state["era"]["mode"] == "free";
    let mut cards = Vec::new();
    let mut places = Vec::new();
    let era_name = text(&value["era"]["name"], 40);
    let era_content = text(&value["era"]["content"], 1200);
    let era_content = if free {
        era_content
    } else {
        short_taboo_line(&era_content)
    };
    let era_own = values(&state["cards"]).iter().find(|c| c["kind"] == "时代");
    if !era_content.is_empty()
        && (era_own.is_none_or(|c| c["source"] != "玩家") || options["replaceOwnEra"] == true)
    {
        cards.push(json!({"op":"add", "kind":"时代", "name": if era_name.is_empty() { if free {"世界"} else {"时代"} } else {&era_name}, "content":era_content, "source":"AI"}));
    }
    // The first five supplied items count, including unusable entries.
    // Five cards, plus the protagonist's abilities (“某某的本事”) when the premise gives them.
    let ability = |c: &&Value| text(&c["name"], 20).ends_with("的本事");
    let listed = values(&value["cards"]);
    let chosen: Vec<&Value> = listed.iter().filter(|c| !ability(c)).take(5).chain(listed.iter().filter(|c| ability(c)).take(1)).collect();
    for c in chosen {
        let name = text(&c["name"], 20);
        let content = text(&c["content"], if name.ends_with("的本事") { 400 } else { 200 });
        if name.is_empty() || content.is_empty() {
            continue;
        }
        let keys = names(&c["keys"]);
        if c["kind"] == "地点" {
            let described = match_name(values(&state["places"]), &name, true)
                .is_some_and(|i| !text(&state["places"][i]["description"], usize::MAX).is_empty());
            if !described && !dismissed(state, &name) {
                places.push(json!({"op":"add", "name":name, "aliases":keys, "description":content, "source":"AI"}));
            }
        } else {
            let kind = card_kind(&c["kind"]);
            let player_cards: Vec<Value> = values(&state["cards"])
                .iter()
                .filter(|c| c["source"] == "玩家" && c["kind"] == kind)
                .map(|c| json!({"name":c["name"], "aliases":c["keys"]}))
                .collect();
            if !dismissed(state, &name) && match_name(&player_cards, &name, true).is_none() {
                cards.push(json!({"op":"add", "kind":kind, "name":name, "keys":keys, "content":content, "source":"AI"}));
            }
        }
    }
    let timeline = if free {
        Vec::new()
    } else {
        values(&value["timeline"])
            .iter()
            .take(8)
            .filter_map(|e| {
                let date = text(&e["date"], 20);
                let title = text(&e["title"], 60);
                if date.is_empty() || title.is_empty() {
                    return None;
                }
                let mut event = json!({"op":"add", "date":date, "title":title, "kind":if e["kind"] == "固定" {"固定"} else {"可变"}, "source":"AI"});
                if e["ceYear"].as_f64().is_some_and(|n| n.is_finite() && n.fract() == 0.0) {
                    event["ceYear"] = e["ceYear"].clone();
                }
                Some(event)
            })
            .collect()
    };
    patch(vec![
        ("cards", cards),
        ("places", places),
        ("timeline", timeline),
    ])
}

/// Retain only allowed upkeep changes; player and pack descriptions stay protected.
pub fn upkeep_patch(raw: &str, state: &Value) -> Option<Value> {
    let value = lenient_json(raw)?;
    value.as_object()?;
    let card_names = card_names(state);
    let known = |name: &str| {
        dismissed(state, name)
            || match_name(&card_names, name, true).is_some()
            || match_name(values(&state["people"]), name, false).is_some()
            || match_name(values(&state["places"]), name, true).is_some()
    };
    let mut cards = Vec::<Value>::new();
    let mut places = Vec::<Value>::new();
    let mut people = Vec::<Value>::new();
    // “某某的本事” (upkeep-6): the protagonist's abilities, kept in one longer card.
    let me = text(&state["protagonist"]["name"], 20);
    let ability_name = format!("{}的本事", if me.is_empty() { "主角" } else { me.as_str() });
    let is_ability = |name: &str| name == ability_name || name == "主角的本事";
    let room = |name: &str| if is_ability(name) { 400 } else { 200 };
    for item in values(&value["cards"]) {
        if cards.len() >= MAX_EACH {
            break;
        }
        let name = text(&item["name"], 20);
        let content = text(&item["content"], room(&name));
        if name.is_empty()
            || content.is_empty()
            || known(&name)
            || cards.iter().any(|c| c["name"] == name)
        {
            continue;
        }
        cards.push(json!({"op":"add", "kind":card_kind(&item["kind"]), "name":name, "keys":names(&item["keys"]), "content":content, "source":"AI"}));
    }
    let mut updates = 0;
    for item in values(&value["updates"]) {
        if updates >= MAX_EACH {
            break;
        }
        let name = text(&item["name"], 20);
        let found = match_name(&card_names, &name, true).map(|i| &card_names[i]);
        let card = found.and_then(|found| {
            values(&state["cards"])
                .iter()
                .find(|c| c.get("id") == found.get("id"))
        });
        let content = text(&item["content"], room(&name));
        if content.is_empty() {
            continue;
        }
        if let Some(card) = card {
            if card["source"] != "AI" || card["content"] == content {
                continue;
            }
            cards.push(json!({"op":"update", "id":card["id"], "name":card["name"], "content":content, "source":"AI"}));
            updates += 1;
            continue;
        }
        if let Some(i) = match_name(values(&state["places"]), &name, true) {
            let place = &state["places"][i];
            if place["source"] == "AI"
                && place["description"] != content
                && !places.iter().any(|p| p.get("id") == place.get("id"))
            {
                places.push(json!({"op":"update", "id":place["id"], "name":place["name"], "description":content, "source":"AI"}));
                updates += 1;
            }
        }
    }
    for item in values(&value["places"]) {
        if places.len() >= MAX_EACH {
            break;
        }
        let name = text(&item["name"], 20);
        let description = text(&item["description"], 200);
        if name.is_empty() || description.is_empty() || dismissed(state, &name) {
            continue;
        }
        if let Some(i) = match_name(values(&state["places"]), &name, true) {
            let place = &state["places"][i];
            if (!text(&place["description"], usize::MAX).is_empty() && place["source"] != "AI")
                || place["description"] == description
            {
                continue;
            }
            let mut aliases = values(&place["aliases"]).to_vec();
            aliases.extend(names(&item["aliases"]).into_iter().map(Value::String));
            places.push(json!({"op":"update", "id":place["id"], "name":place["name"], "aliases":aliases, "description":description, "source":"AI"}));
        } else if !known(&name) && !places.iter().any(|p| p["name"] == name) {
            places.push(json!({"op":"add", "name":name, "aliases":names(&item["aliases"]), "description":description, "source":"AI"}));
        }
    }
    for item in values(&value["people"]) {
        if people.len() >= MAX_EACH {
            break;
        }
        let name = text(&item["name"], 20);
        if name.is_empty() || known(&name) || people.iter().any(|p| p["name"] == name) {
            continue;
        }
        let mut person =
            json!({"name":name, "role":text(&item["role"],30), "note":text(&item["note"],80)});
        let attitude = text(&item["attitude"], 6);
        if !attitude.is_empty() {
            person["attitude"] = json!(attitude);
        }
        people.push(person);
    }
    // Deaths are allowed only for an already listed, living person; no partial matching.
    for name in values(&value["deaths"])
        .iter()
        .map(|v| text(v, 20))
        .filter(|s| !s.is_empty())
    {
        if let Some(i) = match_name(values(&state["people"]), &name, false) {
            let person = &state["people"][i];
            if person["alive"] == true && !people.iter().any(|p| p.get("id") == person.get("id")) {
                people.push(json!({"id":person["id"], "name":person["name"], "alive":false}));
            }
        }
    }
    // One thing under two names (upkeep-5): AI-written duplicates become one card
    // or place, the dropped name kept as an alias so it still brings it in.
    let mut merged = 0;
    for item in values(&value["merges"]) {
        if merged >= MAX_EACH {
            break;
        }
        let (keep, drop) = (text(&item["keep"], 20), text(&item["drop"], 20));
        if keep.is_empty() || drop.is_empty() || keep == drop {
            continue;
        }
        let card = |name: &str| {
            match_name(&card_names, name, true).and_then(|i| {
                values(&state["cards"]).iter().find(|c| c.get("id") == card_names[i].get("id"))
            })
        };
        let touched = |id: &Value, list: &[Value]| list.iter().any(|x| x.get("id") == Some(id) && x["op"] == "remove");
        if let (Some(k), Some(d)) = (card(&keep), card(&drop)) {
            if k["id"] != d["id"] && k["source"] == "AI" && d["source"] == "AI" && k["kind"] == d["kind"] && !touched(&k["id"], &cards) && !touched(&d["id"], &cards) {
                let mut keys = values(&k["keys"]).to_vec();
                keys.push(d["name"].clone());
                keys.extend(values(&d["keys"]).iter().cloned());
                let content = text(&item["content"], 200);
                let content = if content.is_empty() { k["content"].clone() } else { json!(content) };
                cards.push(json!({"op":"update", "id":k["id"], "name":k["name"], "keys":keys, "content":content, "source":"AI"}));
                cards.push(json!({"op":"remove", "id":d["id"], "name":d["name"]}));
                merged += 1;
            }
            continue;
        }
        let list = values(&state["places"]);
        let mergeable = |p: &Value| p["source"] == "AI" || text(&p["description"], usize::MAX).is_empty();
        if let (Some(mut k), Some(mut d)) = (match_name(list, &keep, true), match_name(list, &drop, true)) {
            if k == d || !mergeable(&list[k]) || !mergeable(&list[d]) || touched(&list[k]["id"], &places) || touched(&list[d]["id"], &places) {
                continue;
            }
            // Where the protagonist stands stays; the other name joins it.
            if list[d]["id"] == state["placeId"] {
                std::mem::swap(&mut k, &mut d);
            }
            let (kp, dp) = (&list[k], &list[d]);
            let mut aliases = values(&kp["aliases"]).to_vec();
            aliases.push(dp["name"].clone());
            aliases.extend(values(&dp["aliases"]).iter().cloned());
            let given = text(&item["content"], 200);
            let description = if !given.is_empty() { given } else if text(&kp["description"], usize::MAX).is_empty() { text(&dp["description"], 200) } else { text(&kp["description"], 200) };
            places.push(json!({"op":"update", "id":kp["id"], "name":kp["name"], "aliases":aliases, "description":description, "source":"AI"}));
            places.push(json!({"op":"remove", "id":dp["id"], "name":dp["name"]}));
            merged += 1;
        }
    }
    // The AI's own cards that turned out to be one-offs (upkeep-6); never the
    // player's, a pack's, the protagonist's abilities, or one changed above.
    let mut dropped = 0;
    for name in values(&value["drop"]).iter().map(|v| text(v, 20)).filter(|s| !s.is_empty()) {
        if dropped >= MAX_EACH {
            break;
        }
        let Some(card) = match_name(&card_names, &name, true).and_then(|i| values(&state["cards"]).iter().find(|c| c.get("id") == card_names[i].get("id"))) else { continue };
        if card["source"] != "AI" || is_ability(text(&card["name"], 20).as_str()) || cards.iter().any(|c| c.get("id") == card.get("id")) {
            continue;
        }
        cards.push(json!({"op":"remove", "id":card["id"], "name":card["name"]}));
        dropped += 1;
    }
    let mut status = Vec::<Value>::new();
    for name in values(&value["statusRemove"])
        .iter()
        .map(|v| text(v, 30))
        .filter(|s| !s.is_empty())
    {
        if name != "垂危"
            && !status.iter().any(|s| s["name"] == name)
            && values(&state["protagonist"]["statuses"])
                .iter()
                .any(|s| s["name"] == name)
        {
            status.push(json!({"op":"remove", "name":name}));
        }
    }
    patch(vec![
        ("cards", cards),
        ("places", places),
        ("people", people),
        ("status", status),
    ])
}

/// A nonempty summary is required; absent titles and gists use the classic fallback.
pub fn parse_chapter(raw: &str) -> Option<Value> {
    let value = lenient_json(raw)?;
    let summary = text(&value["summary"], 600);
    if summary.is_empty() {
        return None;
    }
    let title = text(&value["title"], 16);
    let gist = text(&value["gist"], 80);
    Some(
        json!({"title":if title.is_empty() {"无题"} else {&title}, "gist":if gist.is_empty() {utf16_prefix(&summary,40)} else {gist}, "summary":summary}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    // Expected patches were checked against the TypeScript parsers, not settlement output.
    #[test]
    fn setup_keeps_player_sources_aliases_and_limits() {
        let state = json!({"era":{"mode":"history"},"cards":[{"id":"era","kind":"时代","source":"玩家","name":"时代","content":"自定"},{"id":"card","kind":"势力","name":"天地会","keys":["青木堂"],"source":"玩家"}],"places":[{"name":"西市","aliases":["西集"],"description":"玩家已写"}],"dismissed":["旧物"]});
        let raw = json!({"era":{"content":"重写"},"cards":[{"name":"青木堂","kind":"势力","content":"不要覆盖"},{"name":"西集","kind":"地点","content":"不要覆盖"},{"name":"旧物","kind":"物品","content":"不要复活"},{"name":"印信","kind":"物品","keys":[" 官印 ","",9,"印","第三","第四","不收"],"content":" 应保存 "},{"name":"新集","kind":"地点","content":"可补"},{"name":"第六项","content":"不收"}]}).to_string();
        assert_eq!(
            codex_patch(&raw, &state, &json!({})),
            Some(
                json!({"cards":[{"op":"add","kind":"物品","name":"印信","keys":["官印","印","第三","第四"],"content":"应保存","source":"AI"}],"places":[{"op":"add","name":"新集","aliases":[],"description":"可补","source":"AI"}]})
            )
        );
        let eras = json!({"era":{"content":"背景\n 不要出现 : 甲;乙；丙;丁;戊;己;庚;辛;壬\n不要出现： ;"},"timeline":[{"date":"元年","title":"事件","ceYear":1629.0,"kind":"固定"}]}).to_string();
        let history = codex_patch(&eras, &state, &json!({"replaceOwnEra":true})).unwrap();
        assert_eq!(
            history["cards"][0]["content"],
            "背景\n不要出现：甲；乙；丙；丁；戊；己；庚；辛"
        );
        assert_eq!(history["timeline"][0]["ceYear"], json!(1629.0));
        let mut free = state;
        free["era"]["mode"] = json!("free");
        let free_patch = codex_patch(&eras, &free, &json!({"replaceOwnEra":true})).unwrap();
        assert!(free_patch.get("timeline").is_none());
        assert_eq!(free_patch["cards"][0]["name"], "世界");
    }

    #[test]
    fn upkeep_protects_owned_content_and_only_marks_exact_deaths() {
        let state = json!({"cards":[{"id":"own","name":"商号","kind":"势力","keys":["商行"],"content":"玩家写","source":"玩家"},{"id":"pack","name":"城防","kind":"设定","content":"卡组写","source":"卡组"},{"id":"ai","name":"信物","kind":"物品","keys":["铜牌"],"content":"仍在","source":"AI"}],"places":[{"id":"p","name":"驿站","aliases":["旧驿"],"description":"卡组写","source":"卡组"},{"id":"blank","name":"东市","aliases":["东集"],"description":" ","source":"玩家"},{"id":"aip","name":"码头","description":"尚在","source":"AI"}],"people":[{"id":"person","name":"孙管事","aliases":["老孙"],"alive":true},{"id":"other","name":"孙管事的侄子","alive":true}],"dismissed":["不要再建"],"protagonist":{"statuses":[{"name":"垂危"},{"name":"旧伤"}]}});
        let raw = json!({"cards":[{"name":"商行","content":"不许改"},{"name":"老孙","content":"不建人物卡"},{"name":"新帮会","content":"可建"}],"updates":[{"name":"商行","content":"不许改"},{"name":"城防","content":"不许改"},{"name":"铜牌","content":"已失"},{"name":"码头","content":"已毁"}],"places":[{"name":"旧驿","description":"不许改"},{"name":"东集","aliases":["早市"],"description":"已到访"}],"people":[{"name":"老孙"},{"name":"王六","role":"舟子","attitude":"友善","note":"引路"}],"deaths":["管事孙某","管事孙某","孙管事的侄子远亲"],"statusRemove":["垂危","旧伤","旧伤","不存在"]}).to_string();
        assert_eq!(
            upkeep_patch(&raw, &state),
            Some(
                json!({"cards":[{"op":"add","kind":"设定","name":"新帮会","keys":[],"content":"可建","source":"AI"},{"op":"update","id":"ai","name":"信物","content":"已失","source":"AI"}],"places":[{"op":"update","id":"aip","name":"码头","description":"已毁","source":"AI"},{"op":"update","id":"blank","name":"东市","aliases":["东集","早市"],"description":"已到访","source":"AI"}],"people":[{"name":"王六","role":"舟子","attitude":"友善","note":"引路"},{"id":"person","name":"孙管事","alive":false}],"status":[{"op":"remove","name":"旧伤"}]})
            )
        );
    }

    #[test]
    fn upkeep_merges_ai_duplicates_and_keeps_where_the_protagonist_stands() {
        let state = json!({"placeId":"hall","cards":[
            {"id":"letter","name":"密信","kind":"物品","keys":[],"content":"藏在袖中","source":"AI"},
            {"id":"that","name":"那封信","kind":"物品","keys":["信"],"content":"写着地址","source":"AI"},
            {"id":"own","name":"玉佩","kind":"物品","keys":[],"content":"玩家写","source":"玩家"},
            {"id":"jade","name":"那块玉","kind":"物品","keys":[],"content":"AI 写","source":"AI"}],
            "places":[{"id":"yamen","name":"县衙","aliases":[],"description":"","source":null},{"id":"hall","name":"县衙大堂","aliases":[],"description":"升堂之处","source":"AI"},
            {"id":"inn","name":"客栈","aliases":[],"description":"玩家写","source":"玩家"},{"id":"tavern","name":"酒肆","aliases":[],"description":"","source":null}],
            "people":[],"protagonist":{"statuses":[]}});
        let raw = json!({"merges":[
            {"keep":"密信","drop":"那封信","content":"藏在袖中，写着地址"},
            {"keep":"玉佩","drop":"那块玉"},
            {"keep":"县衙","drop":"县衙大堂"},
            {"keep":"客栈","drop":"酒肆"},
            {"keep":"密信","drop":"密信"}]}).to_string();
        assert_eq!(
            upkeep_patch(&raw, &state),
            Some(json!({
                "cards":[{"op":"update","id":"letter","name":"密信","keys":["那封信","信"],"content":"藏在袖中，写着地址","source":"AI"},{"op":"remove","id":"that","name":"那封信"}],
                "places":[{"op":"update","id":"hall","name":"县衙大堂","aliases":["县衙"],"description":"升堂之处","source":"AI"},{"op":"remove","id":"yamen","name":"县衙"}]
            }))
        );
    }

    #[test]
    fn upkeep_keeps_a_long_ability_card_and_drops_only_its_own_one_offs() {
        let state = json!({"protagonist":{"name":"唐舞","statuses":[]},"people":[],"places":[],"cards":[
            {"id":"ab","name":"唐舞的本事","kind":"设定","keys":[],"content":"一环","source":"AI"},
            {"id":"scene","name":"雨夜茶摊","kind":"设定","keys":[],"content":"一次性","source":"AI"},
            {"id":"own","name":"玩家的规矩","kind":"设定","keys":[],"content":"玩家写","source":"玩家"}]});
        let long = "魂环：".to_owned() + &"千年紫环；".repeat(60);
        let raw = json!({"updates":[{"name":"唐舞的本事","content":long}],"drop":["雨夜茶摊","玩家的规矩","唐舞的本事","不存在"]}).to_string();
        let patch = upkeep_patch(&raw, &state).unwrap();
        let cards = patch["cards"].as_array().unwrap();
        assert_eq!(cards[0]["id"], "ab");
        assert!(cards[0]["content"].as_str().unwrap().encode_utf16().count() > 200);
        assert_eq!(cards[1], json!({"op":"remove","id":"scene","name":"雨夜茶摊"}));
        assert_eq!(cards.len(), 2);
    }

    #[test]
    fn chapter_lenient_json_and_utf16_limits() {
        let summary = format!(" {}末尾 ", "😀文文".repeat(200));
        let raw = json!({"summary":summary,"title":"","gist":""}).to_string();
        let chapter = parse_chapter(&raw).unwrap();
        assert_eq!(chapter["title"], "无题");
        assert_eq!(chapter["summary"].as_str().unwrap(), "😀文文".repeat(150));
        assert_eq!(chapter["gist"], "😀文文".repeat(10));
        assert_eq!(
            parse_chapter("```json\n{summary:'正文', title:'标题',}\n```"),
            Some(json!({"title":"标题","gist":"正文","summary":"正文"}))
        );
        assert_eq!(parse_chapter("{\"summary\":\"  \"}"), None);
        assert_eq!(upkeep_patch("{}", &json!({})), None);
    }
}
