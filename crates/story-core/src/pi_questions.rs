//! Durable application questions, separate from Pi's model transcript.
use crate::{agent_workspace as ws, pi_store::PiStore, Error, Result};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};

fn invalid(message: &str) -> Error { Error::Invalid(message.into()) }

pub(crate) fn display_answer(payload:&Value)->Option<String> {
    if payload["cancelled"]==true {return Some("已取消回答，未提供同意或新的要求。".into());}
    let legacy=payload["text"].as_str().and_then(|s|s.strip_prefix("【玩家回答】")).and_then(|s|serde_json::from_str::<Value>(s.trim()).ok()).unwrap_or(Value::Null);
    let answers=payload["answers"].as_object().or_else(||legacy["answers"].as_object())?;
    let questions=payload.get("questionSnapshot").unwrap_or(&legacy["question"]);
    let lines=answers.iter().filter_map(|(id,answer)|{
        let answer=answer.as_str()?;
        let label=questions["questions"].as_array().into_iter().flatten().find(|q|q["id"]==*id).and_then(|q|q["question"].as_str());
        Some(match label {Some(label)=>format!("{}\n{}",label.chars().take(70).collect::<String>(),answer),None=>answer.to_owned()})
    }).collect::<Vec<_>>();
    (!lines.is_empty()).then(||format!("回答：\n{}",lines.join("\n\n")))
}

pub(crate) fn ask(db:&rusqlite::Connection, task:&Value, args:&Value)->Result<Value> {
    if !task["question_json"].is_null() { return Err(invalid("当前问题尚未回答，请等待玩家")); }
    if serde_json::to_vec(args)?.len()>64*1024 {return Err(invalid("问题过长，请只询问必要信息"));}
    let mut questions=args["questions"].as_array().filter(|q|!q.is_empty()&&q.len()<=3).cloned().ok_or_else(||invalid("一次请集中询问1至3项必要问题"))?;
    let mut ids=std::collections::HashSet::new();
    for (index,item) in questions.iter_mut().enumerate() {
        if !item["question"].as_str().is_some_and(|q|!q.trim().is_empty()&&q.len()<=12000) {return Err(invalid("请提供有效的问题内容"));}
        if item["id"].as_str().unwrap_or("").is_empty(){item["id"]=format!("question-{}",index+1).into();}
        let id=item["id"].as_str().filter(|id|id.len()<=128).ok_or_else(||invalid("问题标识无效"))?;
        if !ids.insert(id.to_owned()){return Err(invalid("问题标识不能重复"));}
        if let Some(options)=item.get("options") {
            let options=options.as_array().filter(|v|v.len()<=10).ok_or_else(||invalid("问题选项过多或格式无效"))?;
            if options.iter().any(|o|!o["label"].as_str().is_some_and(|s|!s.trim().is_empty()&&s.len()<=1000)){return Err(invalid("问题选项内容无效"));}
        }
        item["allowFreeText"]=true.into();
    }
    let question=json!({"id":ws::id(),"title":args["title"].as_str().unwrap_or("需要你补充"),"questions":questions});
    let id=ws::text(task,"id");
    db.execute("UPDATE pi_tasks SET status='waiting_user',question_json=?,updated_at=? WHERE id=?",params![question.to_string(),ws::now(),id])?;
    crate::pi_budget::clock_pause(db,id)?;
    Ok(json!({"waitingForUser":true,"question":question,"message":"问题已保存，等待玩家回答；没有回答前不继续执行或提交。"}))
}

/// Save before restarting the host. Lost UI waiters or a changed story cannot
/// discard an answer, and cancelled questions never turn into permission.
pub(crate) fn answer(store:&PiStore,request:&Value)->Result<Value> {
    let task=ws::text(request,"taskId");let id=ws::text(request,"id");let question_id=ws::text(request,"questionId");
    if task.is_empty()||id.is_empty()||id.len()>128||question_id.is_empty(){return Err(invalid("回答缺少任务、问题或输入标识"));}
    let cancelled=request["cancelled"]==true;
    let answers=request["answers"].clone();
    let mut db=store.0.lock()?;let tx=db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if let Some((old_task,payload))=tx.query_row("SELECT task_id,content_json FROM pi_inputs WHERE id=?",[id],|r|Ok((r.get::<_,String>(0)?,r.get::<_,String>(1)?))).optional()? {
        let old:Value=serde_json::from_str(&payload)?;
        if old_task!=task||old["questionId"]!=question_id||old["answers"]!=answers||old["cancelled"]!=cancelled {return Err(invalid("这条回答标识已用于其他内容"));}
        return Ok(json!({"accepted":true,"duplicate":true,"cancelled":cancelled,"taskId":task,"id":id}));
    }
    let (session,status,raw,meta):(String,String,Option<String>,String)=tx.query_row("SELECT session_id,status,question_json,metadata_json FROM pi_tasks WHERE id=?",[task],|r|Ok((r.get(0)?,r.get(1)?,r.get(2)?,r.get(3)?)))?;
    let question:Value=raw.as_deref().and_then(|s|serde_json::from_str(s).ok()).unwrap_or(Value::Null);
    let meta:Value=serde_json::from_str(&meta)?;
    if status!="waiting_user"||question["id"]!=question_id {return Err(invalid("这条问题已变化或已经处理，请刷新后查看"));}
    if meta["_nativeHostActive"]==true {return Err(invalid("助手正在保存提问，请稍后回答"));}
    if !cancelled {
        let values=answers.as_object().filter(|v|v.len()<=3).ok_or_else(||invalid("回答应为问题与文字的对应表"))?;
        let expected=question["questions"].as_array().ok_or_else(||invalid("问题记录不完整"))?;
        if values.len()!=expected.len() || expected.iter().any(|q|!values.get(ws::text(q,"id")).and_then(Value::as_str).is_some_and(|v|!v.trim().is_empty()&&v.len()<=100000)) {return Err(invalid("请回答所有问题，也可以自行填写"));}
    }
    let text=if cancelled {"【玩家取消提问】没有提供回答，不得将取消视为同意。".to_owned()} else {format!("【玩家回答】\n{}",json!({"question":question,"answers":answers}))};
    let seq:i64=tx.query_row("SELECT COALESCE(MAX(seq),0)+1 FROM pi_inputs WHERE session_id=?",[&session],|r|r.get(0))?;
    let intent:i64=tx.query_row("SELECT intent_revision+1 FROM pi_tasks WHERE id=?",[task],|r|r.get(0))?;
    let mut payload=json!({"text":text,"questionId":question_id,"questionSnapshot":question,"answers":answers,"cancelled":cancelled,"nonce":ws::id()});
    payload["displayText"]=json!(display_answer(&payload));
    tx.execute("INSERT INTO pi_inputs(id,session_id,task_id,seq,delivery,content_json,intent_revision,created_at) VALUES(?,?,?,?,'answer',?,?,?)",params![id,session,task,seq,payload.to_string(),intent,ws::now()])?;
    tx.execute("UPDATE pi_tasks SET status='paused',question_json=NULL,intent_revision=?,updated_at=? WHERE id=?",params![intent,ws::now(),task])?;
    tx.commit()?;
    Ok(json!({"accepted":true,"duplicate":false,"cancelled":cancelled,"taskId":task,"id":id}))
}

#[cfg(test)] mod tests {
 use super::*;
 #[test] fn readable_answers_use_new_snapshot_and_old_nested_question_without_touching_player_json(){
  let q=json!({"questions":[{"id":"range","question":"回退到哪一回合？"}]});
  let new=json!({"questionSnapshot":q,"answers":{"range":"314"}});
  let legacy=json!({"text":format!("【玩家回答】\n{}",json!({"question":q,"answers":{"range":"314"}}))});
  assert_eq!(display_answer(&new),Some("回答：\n回退到哪一回合？\n314".into()));
  assert_eq!(display_answer(&legacy),display_answer(&new));
  assert_eq!(display_answer(&json!({"text":"{\"player\":true}"})),None);
  assert!(display_answer(&json!({"cancelled":true})).unwrap().contains("未提供同意"));
 }
}
