use super::*;
use serde_json::{json, Value};

fn state(money: f64) -> Value {
    json!({"version":2,"time":{"start":"天宝七载 冬月十七","elapsedMinutes":0},"placeId":null,"protagonist":{"name":"李安","aliases":[],"age":20,"gender":"男","identity":"行旅","origin":"现代","cheat":"","stats":{"money":money,"debt":0,"health":100,"energy":100,"fame":0},"statuses":[],"items":[]},"people":[],"places":[],"cards":[],"goals":[],"era":{"packId":null},"deviations":[]})
}

#[test]
fn chinese_time_and_money_keep_existing_rules() {
    for (word, minutes) in [
        ("半个时辰", 60.0),
        ("两刻钟", 30.0),
        ("十几息", 1.0),
        ("二十余日", 28800.0),
        ("月余", 43200.0),
        ("转眼三个月", 129600.0),
        ("片刻", 5.0),
    ] {
        assert_eq!(
            calendar::parse_duration_minutes(&json!(word)),
            Some(minutes),
            "{word}"
        );
    }
    let tang = money::tang_currency();
    for (word, amount) in [
        ("三贯二百文", 3200.0),
        ("一贯半", 1500.0),
        ("−二十文", -20.0),
    ] {
        assert_eq!(
            money::parse_money(&json!(word), &tang),
            Some(amount),
            "{word}"
        );
    }
    assert_eq!(
        money::parse_money(
            &json!("三两二百文"),
            &json!({"units":[{"name":"两","value":1000},{"name":"文","value":1}]})
        ),
        Some(3200.0)
    );
    assert_eq!(money::format_money(3200.0, &tang), "3 贯 200 文");
    assert_eq!(money::format_money(-1.5, &tang), "−1 文");
}

#[test]
fn lenient_record_preserves_valid_changes_and_excludes_panel_edits() {
    let r=parse_record("<record>{time:'半个时辰',money:'二百文',items:[{name:'胡饼',delta:'+2个'}],sourceSet:{bookId:'bad'},profile:{identity:'bad'},choices:['1. 问路'],}</record>").unwrap();
    assert_eq!(r["record"]["time"], "半个时辰");
    assert_eq!(r["record"]["money"], "二百文");
    assert_eq!(r["record"]["items"][0]["delta"], json!(2.0));
    assert!(r["record"].get("profile").is_none());
    assert!(r["record"].get("sourceSet").is_none());
    assert_eq!(r["record"]["choices"], json!(["问路"]));
    assert_eq!(
        parse_record("{\"time\":15,\"items\":[{\"name\":\"纸\",\"delta\":1}],\"choices\":[\"说")
            .unwrap()["record"]["items"][0]["name"],
        "纸"
    );
}

#[test]
fn failed_purchase_does_not_create_items_or_lose_money() {
    let r = apply_record(
        &state(3.0),
        &json!({"money":-20,"items":[{"name":"胡饼","delta":2}]}),
        &json!({"mode":"do","difficulty":"标准","currency":money::tang_currency()}),
    )
    .unwrap();
    assert_eq!(num(&r["state"]["protagonist"]["stats"]["money"]), 3.0);
    assert_eq!(r["state"]["protagonist"]["items"], json!([]));
    assert!(text(&r["chips"][1]["text"]).contains("胡饼没到手"));
    let easy = apply_record(
        &state(3.0),
        &json!({"money":-20}),
        &json!({"mode":"do","difficulty":"宽松"}),
    )
    .unwrap();
    assert_eq!(num(&easy["state"]["protagonist"]["stats"]["debt"]), 17.0);
}

#[test]
fn history_death_requires_written_death_after_dying() {
    let mut s = state(30.0);
    s["protagonist"]["stats"]["health"] = json!(1);
    let first = apply_record(
        &s,
        &json!({"stats":{"health":-10}}),
        &json!({"mode":"do","difficulty":"标准"}),
    )
    .unwrap();
    assert_eq!(num(&first["state"]["protagonist"]["stats"]["health"]), 1.0);
    assert_eq!(first["state"]["protagonist"]["statuses"][0]["name"], "垂危");
    let repeated = apply_record(
        &first["state"],
        &json!({"stats":{"health":-10}}),
        &json!({"mode":"do","difficulty":"标准"}),
    )
    .unwrap();
    assert_eq!(
        num(&repeated["state"]["protagonist"]["stats"]["health"]),
        1.0
    );
    let death = apply_record(
        &repeated["state"],
        &json!({"died":true}),
        &json!({"mode":"do","difficulty":"标准"}),
    )
    .unwrap();
    assert_eq!(num(&death["state"]["protagonist"]["stats"]["health"]), 0.0);
}

#[test]
fn calendar_crosses_reign_and_bc_without_year_zero() {
    let rules = json!({"lunar":true,"eras":[{"name":"天宝","startCe":742,"yearWord":"载"},{"name":"至德","startCe":756,"startMonth":7}]});
    let d = calendar::read_date(&json!("大唐天宝十五载六月廿九"), &rules).unwrap();
    let (next, years) = calendar::add_days(&d, 2.0, &rules);
    assert_eq!(next.era, "至德");
    assert_eq!(next.year, 1);
    assert_eq!(next.month, 7);
    assert_eq!(next.day, 2);
    assert_eq!(years, 0);
    let bc = calendar::read_date(&json!("公元前1年12月31日"), &json!({"lunar":false})).unwrap();
    let (ad, years) = calendar::add_days(&bc, 1.0, &json!({"lunar":false}));
    assert_eq!(ad.ce_year, Some(1));
    assert_eq!(ad.year, 1);
    assert_eq!(years, 1);
}

#[test]
fn names_do_not_merge_unrelated_people_but_learn_aliases() {
    let p = json!([{"name":"孙管事","aliases":[]},{"name":"ＡＢＣ","aliases":[]}]);
    assert_eq!(apply::match_name(values(&p), "管事孙某", false), Some(0));
    assert_eq!(apply::match_name(values(&p), "孙管事儿", false), Some(0));
    assert_eq!(apply::match_name(values(&p), "孙掌柜", false), None);
    assert_eq!(apply::match_name(values(&p), "ABC", false), Some(1));
}

#[test]
fn panel_edits_do_not_advance_or_complete_challenge() {
    let mut s = state(30.0);
    s["challenge"] = json!({"goal":"还债","limit":"一天","deadlineMinute":10,"failIf":"","progress":"","status":"active","startedMinute":0});
    let r = apply_record(
        &s,
        &json!({"profile":{"name":"李平","age":21},"setStats":{"money":100}}),
        &json!({"advanceTime":false,"mode":"do"}),
    )
    .unwrap();
    assert_eq!(num(&r["minutes"]), 0.0);
    assert_eq!(r["state"]["challenge"]["status"], "active");
    assert_eq!(r["state"]["protagonist"]["aliases"], json!(["李安"]));
}

fn normalize(value: &Value, ids: &mut std::collections::HashMap<String, String>) -> Value {
    match value {
        Value::Number(n) => json!(n.as_f64().unwrap()),
        Value::String(s) if uuid::Uuid::parse_str(s).is_ok() => {
            let next = format!("generated-id-{}", ids.len());
            json!(ids.entry(s.clone()).or_insert(next).clone())
        }
        Value::Array(a) => Value::Array(a.iter().map(|v| normalize(v, ids)).collect()),
        Value::Object(o) => Value::Object(
            o.iter()
                .map(|(k, v)| (k.clone(), normalize(v, ids)))
                .collect(),
        ),
        _ => value.clone(),
    }
}

#[test]
fn targeted_typescript_migration_oracle() {
    let fixtures: Vec<Value> = serde_json::from_str(include_str!("fixtures.json")).unwrap();
    let mut failures = Vec::new();
    for f in fixtures {
        let actual = match text(&f["kind"]) {
            "apply" => apply_record(&f["state"], &f["record"], &f["options"]).unwrap(),
            "parse" => parse_record(text(&f["input"])).unwrap(),
            "duration" => json!(calendar::parse_duration_minutes(&f["input"])),
            "date" => calendar::parse_date_label(text(&f["input"]), &f["rules"])
                .map(|(date, precision)| json!({"date":date,"precision":precision}))
                .unwrap_or(Value::Null),
            "now" => calendar::now_of(&f["clock"], num(&f["elapsed"])),
            "money" => json!(money::parse_money(&f["input"], &f["currency"])),
            _ => panic!("unknown fixture"),
        };
        let actual = normalize(&actual, &mut Default::default());
        let expected = normalize(&f["expected"], &mut Default::default());
        if actual != expected {
            failures.push(format!(
                "{}\nactual: {}\nexpected: {}",
                text(&f["name"]),
                actual,
                expected
            ));
        }
    }
    assert!(failures.is_empty(), "{}", failures.join("\n\n"));
}
