//! Desktop file adapter, shared by the app and development host. Selected roots
//! come only from the native capability store, never a model-provided path.
use serde_json::{json,Value};
use sha2::{Digest,Sha256};
use std::{fs,io::{Read,Write},path::{Path,PathBuf}};
use story_core::{Error,Result};
use tokio_util::sync::CancellationToken;

fn invalid(message:&str)->Error{Error::Invalid(message.into())}
fn hash(bytes:&[u8])->String{format!("{:x}",Sha256::digest(bytes))}
fn text<'a>(value:&'a Value,key:&str)->&'a str{value[key].as_str().unwrap_or("")}
fn cancelled(cancel:&CancellationToken)->Result<()>{if cancel.is_cancelled(){Err(Error::Cancelled)}else{Ok(())}}
fn guarded_path(request:&Value,data:&Path,writing:bool)->Result<PathBuf>{
    let scope=&request["_documentGrant"];
    let root=Path::new(text(scope,"path")).canonicalize().map_err(|_|invalid("所选资料已移动、删除或无权访问"))?;
    let relative=text(request,"path");
    if Path::new(relative).is_absolute()||relative.contains(['\\',':','\0'])||relative.split('/').any(|s|s=="."||s==".."){return Err(invalid("资料路径越出所选范围"));}
    if scope["directory"]!=true&&!relative.is_empty(){return Err(invalid("单文件授权不能访问同目录其他文件"));}
    let path=if scope["directory"]==true{root.join(relative)}else{root.clone()};
    let canonical=if writing&&!path.exists(){let parent=path.parent().ok_or_else(||invalid("写入位置无效"))?.canonicalize().map_err(|_|invalid("目标目录不存在"))?;parent.join(path.file_name().ok_or_else(||invalid("文件名无效"))?)}else{path.canonicalize().map_err(|_|invalid("资料不存在或访问被撤销"))?};
    if scope["directory"]==true&&!canonical.starts_with(&root)||scope["directory"]!=true&&canonical!=root{return Err(invalid("资料链接越出已授权范围"));}
    let private=data.canonicalize().unwrap_or_else(|_|data.to_owned());
    let name=canonical.file_name().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();
    if canonical.starts_with(private)||name=="dev-secrets.json"||name.starts_with(".env"){return Err(invalid("资料工具不能访问应用凭据、数据库或私有执行目录"));}
    Ok(canonical)
}
fn read_bytes(path:&Path,cancel:&CancellationToken)->Result<Vec<u8>>{
    let mut file=fs::File::open(path).map_err(|_|invalid("无法打开资料文件"))?;
    let mut bytes=vec![];let mut buffer=[0u8;65536];
    loop{cancelled(cancel)?;let count=file.read(&mut buffer).map_err(|_|invalid("读取资料文件失败"))?;if count==0{break;}if bytes.len()+count>64*1024*1024{return Err(invalid("资料文件超过64MiB，请拆分后选择"));}bytes.extend_from_slice(&buffer[..count]);}
    Ok(bytes)
}
pub fn execute(request:Value,data:PathBuf,cancel:CancellationToken)->Result<Value>{
    cancelled(&cancel)?;let writing=request["op"]=="write_document";
    let path=guarded_path(&request,&data,writing)?;
    if request["op"]=="list_documents"{
        if !path.is_dir(){return Ok(json!({"entries":[{"path":"","name":path.file_name().and_then(|s|s.to_str()).unwrap_or("资料文件"),"directory":false}],"complete":true}));}
        let mut entries=vec![];
        for entry in fs::read_dir(&path).map_err(|_|invalid("无法读取资料目录"))?{
            cancelled(&cancel)?;let entry=entry.map_err(|_|invalid("目录读取中断"))?;
            let name=entry.file_name().to_string_lossy().into_owned();
            let relative=if text(&request,"path").is_empty(){name.clone()}else{format!("{}/{}",text(&request,"path"),name)};
            let metadata=entry.metadata().map_err(|_|invalid("目录项目已变化，请重新读取"))?;
            entries.push(json!({"name":name,"path":relative,"directory":metadata.is_dir(),"bytes":metadata.len()}));
            if entries.len()>10000{return Err(invalid("资料目录超过一万项，请选择更具体的目录"));}
        }
        entries.sort_by(|a,b|text(a,"name").cmp(text(b,"name")));
        let version=hash(serde_json::to_string(&entries)?.as_bytes());
        if request["version"].as_str().is_some_and(|old|old!=version){return Err(invalid("目录内容已变化，请从第一页重新读取"));}
        let offset=request["offset"].as_u64().unwrap_or(0) as usize;let size=request["pageSize"].as_u64().unwrap_or(40).clamp(1,100)as usize;
        let total=entries.len();let next=(offset+size).min(total);
        return Ok(json!({"entries":entries.into_iter().skip(offset).take(size).collect::<Vec<_>>(),"offset":offset,"nextOffset":next,"complete":next>=total,"total":total,"version":version}));
    }
    let extension=path.extension().and_then(|s|s.to_str()).unwrap_or("").to_ascii_lowercase();
    if !["txt","md","json","epub","pdf","docx"].contains(&extension.as_str()){return Err(invalid("资料工具支持TXT、MD、JSON、EPUB、PDF和DOCX，不读取任意程序或配置文件"));}
    if writing{
        if !["txt","md","json"].contains(&extension.as_str()){return Err(invalid("外部写入仅支持UTF-8的TXT、MD和JSON笔记"));}
        let body=text(&request,"text");if body.len()>256*1024{return Err(invalid("单次写出最多256KiB文字"));}
        if path.exists(){let previous=hash(&read_bytes(&path,&cancel)?);if request["version"]!=previous{return Err(invalid("目标文件已变化或未提供读取版本，未覆盖原文件"));}}
        let temporary=path.with_file_name(format!(".lishi-note-{}.tmp",uuid::Uuid::new_v4()));
        let result=(||{let mut file=fs::OpenOptions::new().write(true).create_new(true).open(&temporary).map_err(|_|invalid("无法建立写出临时文件"))?;cancelled(&cancel)?;file.write_all(body.as_bytes()).map_err(|_|invalid("写出未完成"))?;file.sync_all().map_err(|_|invalid("写出确认失败"))?;cancelled(&cancel)?;fs::rename(&temporary,&path).map_err(|_|invalid("无法采用写出文件，原文件保留"))?;Ok(json!({"written":true,"version":hash(body.as_bytes()),"bytes":body.len(),"storyUndoApplies":false}))})();
        let _=fs::remove_file(temporary);return result;
    }
    let bytes=read_bytes(&path,&cancel)?;let version=hash(&bytes);
    if request["version"].as_str().is_some_and(|old|old!=version){return Err(invalid("资料文件已变化，请重新读取并核对位置"));}
    let task=text(&request,"taskId");if task.is_empty()||!task.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'){return Err(invalid("资料请求不属于有效任务"));}
    let directory=data.join("agent-documents").join(task);fs::create_dir_all(&directory).map_err(|_|invalid("无法准备资料缓存"))?;
    let artifact=directory.join(format!("{version}.bin"));
    if !artifact.exists(){let temporary=directory.join(format!("{}.tmp",uuid::Uuid::new_v4()));fs::write(&temporary,&bytes).map_err(|_|invalid("资料缓存未能保存"))?;if fs::rename(&temporary,&artifact).is_err(){let _=fs::remove_file(temporary);if !artifact.exists(){return Err(invalid("资料缓存未能就位"));}}}
    let pdf=if bytes.starts_with(b"%PDF-"){Some(serde_json::to_value(book_pdf::extract(&bytes).map_err(invalid)?)?)}else{None};
    cancelled(&cancel)?;
    Ok(json!({"_documentRead":{"path":artifact,"name":path.file_name().and_then(|s|s.to_str()).unwrap_or("资料.txt"),"version":version,"pdf":pdf}}))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn selected_file_caches_exact_bytes_and_versioned_notes_never_replace_a_stale_file(){
        let root=std::env::temp_dir().join(format!("lishi-file-test-{}",uuid::Uuid::new_v4()));fs::create_dir_all(&root).unwrap();
        struct Cleanup(PathBuf);impl Drop for Cleanup{fn drop(&mut self){let _=fs::remove_dir_all(&self.0);}}let _cleanup=Cleanup(root.clone());
        let selected=root.join("selected");let data=root.join("private");fs::create_dir_all(&selected).unwrap();fs::create_dir_all(&data).unwrap();fs::write(selected.join("note.txt"),"原始文字😀").unwrap();
        let mut request=json!({"op":"read_document","taskId":"isolated-task","_documentGrant":{"path":selected,"directory":true},"path":"note.txt"});
        let read=execute(request.clone(),data.clone(),CancellationToken::new()).unwrap();
        assert_eq!(fs::read_to_string(read["_documentRead"]["path"].as_str().unwrap()).unwrap(),"原始文字😀");
        request["op"]="write_document".into();request["text"]="新的笔记".into();request["version"]="stale".into();
        assert!(execute(request.clone(),data.clone(),CancellationToken::new()).is_err());assert_eq!(fs::read_to_string(selected.join("note.txt")).unwrap(),"原始文字😀");
        request["version"]=read["_documentRead"]["version"].clone();let saved=execute(request.clone(),data.clone(),CancellationToken::new()).unwrap();assert_eq!(saved["written"],true);assert_eq!(saved["storyUndoApplies"],false);assert_eq!(fs::read_to_string(selected.join("note.txt")).unwrap(),"新的笔记");
        request["path"]="../private/data.json".into();assert!(execute(request.clone(),data.clone(),CancellationToken::new()).is_err());
        request["_documentGrant"]=json!({"path":data,"directory":true});request["path"]="secret.json".into();assert!(execute(request.clone(),data.clone(),CancellationToken::new()).is_err());
        let cancel=CancellationToken::new();cancel.cancel();assert!(matches!(execute(request,data,cancel),Err(Error::Cancelled)));
    }
}
