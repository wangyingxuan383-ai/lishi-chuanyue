//! One SQLite read snapshot for formal story, books, sources and readable Pi.
use crate::{agent_workspace as ws, pi_archive, Error, Result, Store};
use rusqlite::TransactionBehavior;
use serde_json::{json, Value};
use std::collections::BTreeSet;

fn book_ids(value:&Value,ids:&mut BTreeSet<String>) {
    match value {
        Value::Object(map)=>{if let Some(id)=map.get("bookId").and_then(Value::as_str){ids.insert(id.into());}for item in map.values(){book_ids(item,ids);}},
        Value::Array(items)=>for item in items{book_ids(item,ids);},_=>{}
    }
}
pub fn export(store:&Store,world:&str)->Result<Value> {
    let mut db=store.lock()?;
    db.pragma_update(None,"query_only",true)?;
    let result=(||{
        let tx=db.transaction_with_behavior(TransactionBehavior::Deferred)?;
        let worlds=ws::rows(&tx,"SELECT * FROM worlds WHERE id=?",&[&world])?;
        let row=worlds.first().ok_or_else(||Error::Invalid("故事不存在".into()))?;
        let nodes=ws::rows(&tx,"SELECT * FROM nodes WHERE world_id=? ORDER BY seq,id",&[&world])?;
        let states=ws::rows(&tx,"SELECT s.* FROM states s JOIN nodes n ON n.id=s.node_id WHERE n.world_id=? ORDER BY s.node_id",&[&world])?;
        let lines=ws::rows(&tx,"SELECT * FROM lines WHERE world_id=? ORDER BY id",&[&world])?;
        let mut sources=ws::rows(&tx,"SELECT * FROM story_fact_sources WHERE world_id=? ORDER BY id",&[&world])?;
        for source in &mut sources {source["source_json"]=pi_archive::formal_source(&ws::parse(ws::text(source,"source_json"))).to_string().into();}
        let corrections=ws::rows(&tx,"SELECT * FROM fact_corrections WHERE world_id=? ORDER BY id",&[&world])?;
        let pi=pi_archive::export_readable(&tx,world)?;
        let mut ids=BTreeSet::new();
        for rows in [&nodes,&states,&sources,&corrections] {
            for row in rows {for(key,value)in row.as_object().into_iter().flatten(){
                if key.ends_with("_json")||key=="json"{book_ids(&ws::parse(value.as_str().unwrap_or("")),&mut ids);}
            }}
        }
        book_ids(&pi,&mut ids);
        let mut books=vec![];
        for id in ids {
            let rows=ws::rows(&tx,"SELECT json FROM source_books WHERE id=?",&[&id])?;
            let Some(book)=rows.first() else{return Err(Error::Invalid("参考书籍缺失，无法导出完整故事".into()));};
            let jobs=ws::rows(&tx,"SELECT json FROM source_jobs WHERE book_id=? ORDER BY id",&[&id])?.iter().map(|r|ws::parse(ws::text(r,"json"))).collect::<Vec<_>>();
            let analysis=ws::rows(&tx,"SELECT job_id AS jobId,ordinal,section,text FROM source_analysis WHERE book_id=? ORDER BY job_id,ordinal",&[&id])?;
            books.push(json!({"book":ws::parse(ws::text(book,"json")),"jobs":jobs,"analysis":analysis}));
        }
        let archive=json!({"format":"lishi-world","version":7,"exportedAt":ws::now(),"world":row,"nodes":nodes,"states":states,"lines":lines,
          "pins":ws::rows(&tx,"SELECT * FROM pins WHERE world_id=? ORDER BY id",&[&world])?,"chapters":ws::rows(&tx,"SELECT * FROM chapters WHERE world_id=? ORDER BY id",&[&world])?,
          "books":books,"pi":pi,"factSources":sources,"factCorrections":corrections});
        tx.commit()?;Ok(archive)
    })();
    db.pragma_update(None,"query_only",false)?;
    result
}
pub fn validate_history(request:&Value)->Result<Value> {
    let world=ws::text(request,"worldId");
    let lines=request["lineIds"].as_array().ok_or_else(||Error::Invalid("缺少归档路线".into()))?.iter().filter_map(Value::as_str).map(str::to_owned).collect::<Vec<_>>();
    pi_archive::validate_readable(&request["pi"],world,&lines)
}
