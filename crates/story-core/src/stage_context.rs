//! Per-stage views of durable story data. Never mutates or truncates the save.
use crate::RunPlan;
use serde_json::{json, Value};

pub fn units(s: &str) -> usize { s.encode_utf16().count() }
pub fn excerpt(s: &str, query: &str, cap: usize) -> String {
    if units(s)<=cap {return s.into();}
    let hit=query.split(|c:char|c.is_whitespace()||"，。；：、！？\"{}[]".contains(c)).filter(|s|s.chars().count()>=2).find_map(|word|s.find(word)).unwrap_or(0);
    let start=s[..hit].char_indices().rev().nth(36).map(|(i,_)|i).unwrap_or(0);
    let mut n=0;let body:String=s[start..].chars().take_while(|c|{n+=c.len_utf16();n<=cap.saturating_sub(24)}).collect();
    format!("{}{}（仅片段，完整资料可回读）",if start>0{"…"}else{""},body)
}
fn arr<'a>(v:&'a Value)->&'a [Value]{v.as_array().map(Vec::as_slice).unwrap_or(&[])}
fn text(v:&Value)->&str{v.as_str().unwrap_or("")}
fn relevant(v:&Value,q:&str)->bool{
    std::iter::once(text(&v["name"])).chain(arr(&v["aliases"]).iter().filter_map(Value::as_str)).any(|name|!name.is_empty()&&q.contains(name))
}
/// Fixed scalars survive; expandable descriptions and lists fit a character
/// allowance. Entity ids remain usable with the ordinary read tools.
pub fn state(state:&Value,query:&str,cap:usize)->Value {
    let mut out=json!({"time":state["time"],"placeId":state["placeId"],"era":state["era"],"protagonist":state["protagonist"]});
    for key in ["items","statuses"]{out["protagonist"].as_object_mut().map(|o|o.remove(key));}
    for key in ["identity","origin","cheat","panel"] {
        if let Some(s)=out["protagonist"][key].as_str(){out["protagonist"][key]=excerpt(s,query,240).into();}
    }
    // Large calendar/currency/custom snapshots are not facts needed to extract
    // a turn. Native settlement still uses the complete original era/options.
    out["era"]=json!({"mode":state["era"]["mode"],"clockStyle":state["era"]["clockStyle"]});
    let base=units(&out.to_string());let mut remaining=cap.saturating_sub(base+260);
    for key in ["people","items","statuses","goals","places","cards"]{
        let values=if ["items","statuses"].contains(&key){arr(&state["protagonist"][key])}else{arr(&state[key])};
        let mut ranked=values.iter().collect::<Vec<_>>();
        ranked.sort_by_key(|v|(!relevant(v,query),std::cmp::Reverse(v["lastSeenMinute"].as_i64().unwrap_or(-1))));
        let allowance=remaining.min(if key=="people"{cap/3}else{cap/6});let mut used=0;let mut selected=vec![];
        for value in ranked{
            if key=="goals"&&value["status"].as_str().is_some_and(|s|s!="进行中"){continue;}
            let fields=if key=="people"{&["id","name","aliases","role","alive","attitude","origin","notes"][..]}else{&["id","name","kind","quantity","unit","place","status","progress","detail","description","content","source"][..]};
            let mut item=json!({});for field in fields{if let Some(v)=value.get(*field){item[*field]=if let Some(s)=v.as_str(){excerpt(s,query,if relevant(value,query){180}else{64}).into()}else{v.clone()};}}
            let cost=units(&item.to_string())+1;if used+cost>allowance{continue;}used+=cost;selected.push(item);
        }
        remaining=remaining.saturating_sub(used);
        if ["items","statuses"].contains(&key){out["protagonist"][key]=selected.into();}else{out[key]=selected.into();}
    }
    out["view"]=json!({"partial":true,"note":"仅本段相关资料，遗漏不等于不存在；read_world/read_characters/read_history可回读，所有原始记录留在本机。"});out
}
pub fn organization(plan:&RunPlan,messages:&[Value],narrative:&str)->Vec<Value>{
    let cap=plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize;
    let original=messages.iter().filter_map(|m|m["content"].as_str()).last().unwrap_or("");
    let old=original.split("【最近的剧情】").last().unwrap_or("").split("【最近剧情】").last().unwrap_or("").replace("{{NARRATIVE}}",narrative);
    let recent=if units(&old)>4500{let chunks=parts(&old,4500);chunks.last().cloned().unwrap_or_default()}else{old};
    let mut output=messages.iter().filter(|m|m["role"]=="system").cloned().collect::<Vec<_>>();
    output.push(json!({"role":"user","content":format!("【故事设定】{}\n【玩家规则】{}\n【要点】{}\n【相关资料】{}\n【玩家删除的，不要再建】{}\n【最近的剧情】{}\n未展开的旧资料仍存在，不能据此重复创建；只整理实际读到的剧情。",plan.settings["premise"].as_str().unwrap_or(""),plan.settings["rules"].as_str().unwrap_or(""),plan.settings["essentials"].as_str().unwrap_or(""),state(&plan.state,&recent,(cap/4).min(3000)),excerpt(&plan.state["dismissed"].to_string(),&recent,800),recent)}));output
}
pub fn facts(state:&Value,query:&str,cap:usize)->Value{
    let names=arr(&state["people"]).iter().filter(|p|relevant(p,query)).map(|p|text(&p["name"])).collect::<Vec<_>>();
    let mut facts=arr(&state["facts"]).iter().filter(|f|["player","branch"].contains(&text(&f["origin"]))).rev().collect::<Vec<_>>();
    facts.sort_by_key(|f|!names.iter().any(|name|text(&f["detail"]).contains(name)));
    let mut used=0;let mut picked=vec![];
    for f in facts {let item=json!({"id":f["id"],"nodeId":f["nodeId"],"origin":f["origin"],"detail":excerpt(text(&f["detail"]),query,400)});let n=units(&item.to_string())+1;if used+n>cap{continue;}used+=n;picked.push(item);}
    json!({"items":picked,"partial":true,"note":"仅相关玩家事实；未取得依据的旧事实不能当成玩家改写，可read_history核对。"})
}
pub fn extraction(plan:&RunPlan,narrative:&str)->Vec<Value>{
    let cap=plan.meta["budgetChars"].as_u64().unwrap_or(12000) as usize;
    let mut system=plan.extract_messages.first().and_then(|m|m["content"].as_str()).unwrap_or("只输出本回合变化的JSON记录，time/log/choices必须有。").to_owned();
    if plan.kind=="opening"&&plan.meta["titlePolicy"]=="auto"{system+="请结合本段实际开场拟一个小说书名（2～12字为宜，最多24字）：像书架上的网文或小说名，点出核心处境、悬念或人物志向，可用意象或反差；不用“某某的故事/某某传/穿越之XX/重生之XX/我在XX当XX”等套式，不堆砌“天下、风云、传奇、录”，不照抄主角姓名或朝代名。写入额外字段storyTitle，不要写进正文或状态。";}
    vec![json!({"role":"system","content":system}),json!({"role":"user","content":format!("【当前相关状态】{}\n【结算货币】{}\n【当前时钟】{}\n【本回合行动】{}\n【本回合正文】\n{}",state(&plan.state,narrative,(cap/5).min(3000)),plan.options["currency"],plan.options["clock"],plan.action,narrative)})]
}
/// Lossless paragraph groups; even an unusually long paragraph is split on a
/// UTF-8 boundary. Joining the returned pieces reproduces the exact original.
pub fn parts(body:&str,cap:usize)->Vec<String>{
    let cap=cap.max(128);let mut result=vec![];let mut part=String::new();let mut count=0;
    for para in body.split_inclusive('\n'){
        let len=units(para);if count+len>cap&&!part.is_empty(){result.push(std::mem::take(&mut part));count=0;}
        for c in para.chars(){if count+c.len_utf16()>cap{result.push(std::mem::take(&mut part));count=0;}part.push(c);count+=c.len_utf16();}
    }
    if !part.is_empty(){result.push(part);}result
}
pub fn label(purpose:&str)->&str{match purpose.split(':').next().unwrap_or(purpose){"writing"=>"写作","extract"=>"补记回合记录","reference-review"=>"原著核对","upkeep"=>"整理世界资料","chapter"=>"整理章节摘要",_=>"准备请求"}}
pub fn report(plan:&RunPlan,purpose:&str,messages:&[Value],tools:&[Value])->Value{
    let messages=crate::chat::wire_messages(messages);
    let size=|role:&str|messages.iter().filter(|m|m["role"]==role).map(|m|units(&m.to_string())).sum::<usize>();
    json!({"version":"stage-context-1","phase":purpose,"budgetChars":plan.meta["budgetChars"],"chars":units(&json!({"messages":messages,"tools":tools}).to_string()),"system":size("system"),"user":size("user"),"toolResults":size("tool"),"assistant":size("assistant"),"tools":units(&json!(tools).to_string())})
}
/// Keep the complete chapter body, grouping it when necessary. Old chapter
/// gists are supporting context; they must not crowd out this chapter's text.
pub fn chapter(messages:&[Value],narrative:&str,budget:usize)->(Vec<Value>,Vec<String>){
    let original=messages.iter().filter_map(|m|m["content"].as_str()).last().unwrap_or("");
    let split=original.find("【本章剧情");
    let (prefix,body)=if let Some(at)=split{let tail=&original[at..];let end=tail.find('】').map(|n|n+'】'.len_utf8()).unwrap_or(0);(&original[..at],tail[end..].trim_start())}else{("",original)};
    let prefix=excerpt(prefix,"",1200);
    let mut base=messages.iter().filter(|m|m["role"]=="system").cloned().collect::<Vec<_>>();
    let system=units(&json!(base).to_string());
    let room=budget.saturating_sub(system+units(&prefix)+1600).max(128);
    let groups=parts(&body.replace("{{NARRATIVE}}",narrative),room);
    base.push(json!({"role":"user","content":prefix}));(base,groups)
}

#[cfg(test)]mod tests{
 use super::*;
 #[test]fn growing_saves_have_bounded_stage_views_and_durable_facts(){for n in [30,100,300]{let snapshot=json!({"protagonist":{"name":"旅人","stats":{"money":125},"items":[],"statuses":[]},"time":{"elapsedMinutes":42},"people":(0..n).map(|i|json!({"id":format!("p{i}"),"name":format!("人物{i}"),"notes":"长备注".repeat(1000),"alive":true})).collect::<Vec<_>>(),"facts":(0..n).map(|i|json!({"id":format!("f{i}"),"origin":"player","detail":"历史行动".repeat(400)})).collect::<Vec<_>>()});let original=snapshot.clone();let view=state(&snapshot,"人物12",2600);assert!(units(&view.to_string())<3000);assert_eq!(view["protagonist"]["stats"]["money"],125);assert!(units(&facts(&snapshot,"人物12",1200).to_string())<1500);assert_eq!(snapshot,original);}}
 #[test]fn paragraph_groups_preserve_unicode_and_every_character(){let body="第一段🧭。\n\n".repeat(800);let p=parts(&body,500);assert_eq!(p.concat(),body);assert!(p.iter().all(|s|units(s)<=500));}
 #[test]fn chapter_groups_preserve_all_turns_with_bounded_previous_gists(){let body="回合正文🧭。\n".repeat(2000);let messages=vec![json!({"role":"system","content":"记录员"}),json!({"role":"user","content":format!("【故事设定】青桥\n【前几章梗概】{}\n【本章剧情（第1～5回合）】\n{}\n{{{{NARRATIVE}}}}","旧摘要".repeat(4000),body)})];let(base,groups)=chapter(&messages,"最后一段",6000);assert_eq!(groups.concat(),format!("{body}\n最后一段"));for group in groups{assert!(units(&json!(base).to_string())+units(&group)+1024<6000);}}
}
