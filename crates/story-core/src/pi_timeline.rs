//! Bounded active-route timeline: one query, explicit fields and source refs.
use crate::{agent_workspace as ws,pi_store::arguments_hash,tools::ToolDefinition,Error,Result,RunPlan};
use rusqlite::{params,Connection};
use serde_json::{json,Value};
pub(crate) fn catalog()->Vec<ToolDefinition>{vec![ToolDefinition{name:"read_timeline",description:"按当前路线批量读取时间线。默认返回序号、父回合、时间记录及状态中的时间，一次读取避免逐回合逐字段扫描。fromSeq/toSeq限制范围，fields只选必要字段；用pageSize/charBudget/nextCursor分页。日期校准默认只读当前位置附近，只有玩家明确纠正历史经过时才展开全局。",parameters:json!({"type":"object","properties":{"fromSeq":{"type":"integer","minimum":0},"toSeq":{"type":"integer","minimum":0},"fields":{"type":"array","items":{"type":"string","enum":["seq","parentId","record","time","timeChange","action"]}}},"additionalProperties":false}),read_only:true}]}
pub(crate) fn read(db:&Connection,task:&Value,plan:&RunPlan,args:&Value)->Result<Value>{
    let fields=args["fields"].as_array().cloned().unwrap_or(json!(["seq","parentId","record","time","timeChange"]).as_array().unwrap().clone());
    let from=args["fromSeq"].as_i64().unwrap_or(0);let to=args["toSeq"].as_i64().unwrap_or(i64::MAX);
    if from>to {return Err(Error::Invalid("时间线起止序号颠倒".into()));}
    let mut stmt=db.prepare("WITH RECURSIVE route AS (SELECT id,parent_id,seq,record_json,action_text FROM nodes WHERE id=? AND world_id=? UNION ALL SELECT n.id,n.parent_id,n.seq,n.record_json,n.action_text FROM nodes n JOIN route r ON r.parent_id=n.id WHERE n.world_id=?) SELECT r.id,r.parent_id,r.seq,json_object('time',json_extract(r.record_json,'$.time')),r.action_text,json_extract(s.state_json,'$.time'),json_extract(p.state_json,'$.time.elapsedMinutes') FROM route r LEFT JOIN states s ON s.node_id=r.id LEFT JOIN states p ON p.node_id=r.parent_id WHERE r.seq>=? AND r.seq<=? ORDER BY r.seq")?;
    let rows=stmt.query_map(params![plan.head_id,plan.world_id,plan.world_id,from,to],|r|Ok((r.get::<_,String>(0)?,r.get::<_,Option<String>>(1)?,r.get::<_,i64>(2)?,r.get::<_,Option<String>>(3)?,r.get::<_,Option<String>>(4)?,r.get::<_,Option<String>>(5)?,r.get::<_,Option<i64>>(6)?)))?.collect::<std::result::Result<Vec<_>,_>>()?;
    let values=rows.into_iter().map(|(id,parent,seq,record,action,state,previous)|{let mut item=json!({"nodeId":id,"source":{"kind":"node","id":id,"worldVersion":task["base_world_version"],"read":{"kind":"node","id":id}}});for field in &fields {match field.as_str().unwrap_or(""){"seq"=>item["seq"]=seq.into(),"parentId"=>item["parentId"]=json!(parent),"record"=>{let parsed=ws::parse(record.as_deref().unwrap_or("null"));item["record"]=json!({"time":parsed["time"],"elapsedMinutes":parsed["elapsedMinutes"],"timeChange":parsed["timeChange"]});},"time"=>item["time"]=ws::parse(state.as_deref().unwrap_or("null")),"timeChange"=>{let current=ws::parse(state.as_deref().unwrap_or("null"))["elapsedMinutes"].as_i64();item["timeChangeMinutes"]=json!(current.zip(previous).map(|(now,before)|now-before));},"action"=>item["action"]=json!(action),_=>{}}}item}).collect::<Vec<_>>();
    let mut paging=args.clone();if paging.get("pageSize").is_none(){paging["pageSize"]=40.into();}
    let mut page=ws::page(json!(values),&paging);page["worldVersion"]=task["base_world_version"].clone();page["routeVersion"]=arguments_hash(&json!([plan.line_id,plan.head_id,task["base_world_version"]])).into();page["sourceTool"]="read_timeline".into();Ok(page)
}

#[cfg(test)]mod tests {
 use super::*;
 #[test]fn batch_timeline_stays_on_route_and_returns_real_time_delta_and_paging(){
  let(store,gw,attempt)=crate::pi_lifecycle::tests::fixture();crate::pi_lifecycle::request_stop(&store,"t",&attempt,"fixture-stop").unwrap();crate::pi_lifecycle::settle(&store,"t",&attempt,"独立夹具准备").unwrap();
  {let db=store.lock().unwrap();db.execute_batch("INSERT INTO nodes(id,world_id,parent_id,seq,kind,narrative,record_json,created_at) VALUES('n1','w','n',1,'turn','新正文','{\"time\":7}','test'),('n2','w','n1',2,'turn','第二段','{\"time\":5}','test'),('side','w','n',1,'turn','别的路线','{\"time\":999}','test');INSERT INTO states VALUES('n1','{\"time\":{\"elapsedMinutes\":7}}'),('n2','{\"time\":{\"elapsedMinutes\":12}}'),('side','{\"time\":{\"elapsedMinutes\":999}}');UPDATE lines SET node_id='n2' WHERE id='l';").unwrap();}
  let task=gw.start_task("s","timeline","只读时间线","auto-reversible",true,json!({"model":"no-http"}),json!({})).unwrap();let permit=gw.permit("timeline").unwrap();
  let call=|id:&str,args:Value|gw.invoke(&permit,crate::pi_store::PiCallRequest{task_id:"timeline".into(),call_id:id.into(),tool:"read_timeline".into(),args,intent_revision:0,world_version:task["base_world_version"].as_str().unwrap().into(),external_write:false}).unwrap()["data"].clone();
  let first=call("first",json!({"fromSeq":1,"pageSize":1,"charBudget":5000}));assert_eq!(first["value"][0]["nodeId"],"n1");assert_eq!(first["value"][0]["timeChangeMinutes"],7);assert_eq!(first["value"][0]["source"]["read"]["id"],"n1");
  let next=call("next",json!({"fromSeq":1,"pageSize":1,"charBudget":5000,"nextCursor":first["nextCursor"]}));assert_eq!(next["value"][0]["nodeId"],"n2");assert_eq!(next["value"][0]["time"]["elapsedMinutes"],12);assert_eq!(next["value"][0]["timeChangeMinutes"],5);assert_eq!(next["complete"],true);assert!(!next.to_string().contains("side"));
 }
}
