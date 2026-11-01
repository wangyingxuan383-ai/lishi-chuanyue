//! Versioned, local skill resources. Import/adoption are user RPCs; models may
//! only prepare drafts and read resources already present in their snapshot.
use crate::{agent_workspace as ws, Error, Result, RunPlan, Store};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeMap,
    io::{Cursor, Read},
};

const MAX_FILE: usize = 256 * 1024;
const MAX_PACKAGE: usize = 8 * 1024 * 1024;
fn invalid(s: &str) -> Error {
    Error::Invalid(s.into())
}
fn initialize(store: &Store) -> Result<()> {
    initialize_db(&*store.lock()?)
}
fn initialize_db(db:&rusqlite::Connection)->Result<()> {
    db.execute_batch("CREATE TABLE IF NOT EXISTS agent_skill_packages(id TEXT PRIMARY KEY,task_id TEXT,hash TEXT NOT NULL,source TEXT NOT NULL,status TEXT NOT NULL,skill_json TEXT NOT NULL,created_at TEXT NOT NULL); CREATE INDEX IF NOT EXISTS agent_skill_package_task ON agent_skill_packages(task_id,status);")?;
    Ok(())
}
fn safe_path(path: &str) -> bool {
    !path.is_empty()
        && path.len() <= 500
        && !path.starts_with('/')
        && !path.contains(['\\', ':', '\0'])
        && path
            .split('/')
            .all(|p| !p.is_empty() && p != "." && p != "..")
}
fn scalar(text: &str) -> String {
    text.trim().trim_matches(['\'', '"']).to_owned()
}
fn header(content: &str) -> Result<BTreeMap<String, String>> {
    let mut result = BTreeMap::new();
    let normalized = content.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    if !normalized.starts_with("---\n") {
        return Ok(result);
    }
    let end = normalized[4..]
        .find("\n---")
        .ok_or_else(|| invalid("技能说明的元数据没有结束标记"))?
        + 4;
    if end > 16384 {
        return Err(invalid("技能元数据过长"));
    }
    let mut continuation = None::<String>;
    for line in normalized[4..end].lines() {
        if line.trim().is_empty() || line.trim_start().starts_with('#') {
            continue;
        }
        if line.starts_with([' ', '\t']) {
            if let Some(k) = continuation.as_ref() {
                result.entry(k.clone()).and_modify(|v| {
                    if !v.is_empty() {
                        v.push(' ')
                    }
                    v.push_str(line.trim());
                });
            } else if line.trim_start().starts_with("version:") {
                result.insert(
                    "version".into(),
                    scalar(line.trim_start().trim_start_matches("version:")),
                );
            }
            continue;
        }
        continuation = None;
        if let Some((key, value)) = line.split_once(':') {
            let value = scalar(value);
            if [
                "name",
                "description",
                "version",
                "compatibility",
                "allowed-tools",
            ]
            .contains(&key)
            {
                if value == ">" || value == "|" || value == ">-" || value == "|-" {
                    result.insert(key.into(), String::new());
                    continuation = Some(key.into());
                } else {
                    result.insert(key.into(), value);
                }
            }
        }
    }
    Ok(result)
}
fn make_skill(value: Value, source: &str) -> Result<Value> {
    let mut files = BTreeMap::<String, String>::new();
    for (path, text) in value["files"].as_object().into_iter().flatten() {
        let text = text
            .as_str()
            .ok_or_else(|| invalid("技能资源必须是UTF-8文字"))?;
        if !safe_path(path) || text.len() > MAX_FILE {
            return Err(invalid("技能资源路径无效或单文件超过256KiB"));
        }
        files.insert(path.clone(), text.into());
    }
    let content = value["content"]
        .as_str()
        .or_else(|| files.get("SKILL.md").map(String::as_str))
        .unwrap_or("")
        .to_owned();
    if content.trim().is_empty() || content.len() > MAX_FILE {
        return Err(invalid("请提供有效的SKILL.md说明，单文件最多256KiB"));
    }
    let h = header(&content)?;
    let name = value["name"]
        .as_str()
        .filter(|s| !s.trim().is_empty())
        .map(str::to_owned)
        .or_else(|| h.get("name").cloned())
        .unwrap_or_else(|| "导入的技能".into());
    if name.len() > 256 {
        return Err(invalid("技能名称过长"));
    }
    let description = value["description"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| h.get("description").cloned())
        .unwrap_or_default();
    if description.len() > 4096 {
        return Err(invalid("技能适用说明过长"));
    }
    let version = value["version"]
        .as_str()
        .map(str::to_owned)
        .or_else(|| h.get("version").cloned())
        .unwrap_or_else(|| "1.0.0".into());
    files.insert("SKILL.md".into(), content.clone());
    if files.len() > 256 || files.values().map(String::len).sum::<usize>() > MAX_PACKAGE {
        return Err(invalid("技能包超过256个文件或8MiB"));
    }
    let capabilities = value
        .get("requiredCapabilities")
        .or_else(|| value.get("capabilities"))
        .and_then(Value::as_array)
        .map(|v| {
            v.iter()
                .filter_map(Value::as_str)
                .take(100)
                .map(str::to_owned)
                .collect::<Vec<_>>()
        })
        .unwrap_or_else(|| {
            h.get("allowed-tools")
                .map(|s| {
                    s.split([',', ' ', '\n'])
                        .filter(|s| !s.is_empty())
                        .take(100)
                        .map(str::to_owned)
                        .collect()
                })
                .unwrap_or_default()
        });
    let hash = format!(
        "{:x}",
        Sha256::digest(serde_json::to_vec(
            &json!({"name":name,"description":description,"version":version,"files":files,"capabilities":capabilities})
        )?)
    );
    let unsupported = files
        .keys()
        .filter(|p| {
            p.ends_with(".py")
                || p.ends_with(".sh")
                || p.ends_with(".ts")
                || p.ends_with("package.json")
        })
        .cloned()
        .collect::<Vec<_>>();
    let mut compatibility = json!({"javascript":true,"unsupportedScripts":unsupported});
    let mut messages = vec![];
    if let Some(declared) = h.get("compatibility").filter(|s| !s.is_empty()) {
        messages.push(format!("技能声明的环境要求：{declared}"));
    }
    if !unsupported.is_empty() {
        messages.push(
            "Shell、Python、TypeScript和Node依赖不能在手机内直接执行，可使用已授权外部服务".into(),
        );
    }
    if !messages.is_empty() {
        compatibility["message"] = messages.join("；").into();
    }
    Ok(
        json!({"id":format!("skill-{}",&hash[..20]),"name":name,"description":description,"version":version,"content":content,"files":files,"source":source,"hash":hash,"capabilities":capabilities,"compatibility":compatibility}),
    )
}
fn import(bytes: &[u8], name: &str) -> Result<Value> {
    if bytes.len() > MAX_PACKAGE {
        return Err(invalid("技能包最多8MiB"));
    }
    if bytes.starts_with(b"PK") {
        let mut zip =
            zip::ZipArchive::new(Cursor::new(bytes)).map_err(|_| invalid("技能ZIP无法读取"))?;
        if zip.len() > 256 {
            return Err(invalid("技能包最多256个文件"));
        }
        let mut files = BTreeMap::new();
        let mut size = 0;
        for i in 0..zip.len() {
            let mut f = zip
                .by_index(i)
                .map_err(|_| invalid("技能包损坏或受密码保护"))?;
            if f.is_dir() {
                continue;
            }
            let path = f
                .name()
                .map_err(|_| invalid("技能包路径不是有效UTF-8"))?
                .into_owned();
            if !safe_path(&path)
                || f.unix_mode().is_some_and(|m| m & 0o170000 == 0o120000)
                || f.size() > MAX_FILE as u64
            {
                return Err(invalid("技能包包含越界路径、链接或过大文件"));
            }
            let mut raw = Vec::new();
            f.by_ref()
                .take((MAX_FILE + 1) as u64)
                .read_to_end(&mut raw)
                .map_err(|_| invalid("技能资源无法读取"))?;
            size += raw.len();
            if raw.len() > MAX_FILE || size > MAX_PACKAGE {
                return Err(invalid("技能包解压后过大"));
            }
            let text = String::from_utf8(raw)
                .map_err(|_| invalid("当前技能资源需为UTF-8说明、脚本、模板或数据"))?;
            if files.insert(path, text).is_some() {
                return Err(invalid("技能包存在重复资源路径"));
            }
        }
        if !files.contains_key("SKILL.md") {
            let root = files
                .keys()
                .find(|s| s.ends_with("/SKILL.md"))
                .and_then(|s| s.strip_suffix("SKILL.md"))
                .map(str::to_owned)
                .ok_or_else(|| invalid("技能包缺少SKILL.md"))?;
            if !files.keys().all(|k| k.starts_with(&root)) {
                return Err(invalid("请每次导入一个完整技能目录"));
            }
            files = files
                .into_iter()
                .map(|(k, v)| (k[root.len()..].to_owned(), v))
                .collect();
        }
        make_skill(json!({"files":files}), name)
    } else {
        let text = std::str::from_utf8(bytes).map_err(|_| invalid("技能文件不是有效UTF-8"))?;
        let value = if text.trim_start().starts_with('{') {
            let v: Value = serde_json::from_str(text)?;
            v.get("skill").cloned().unwrap_or(v)
        } else {
            json!({"content":text})
        };
        make_skill(value, name)
    }
}
fn save_draft(store: &Store, skill: Value, task: Option<&str>) -> Result<Value> {
    initialize(store)?;
    save_draft_db(&*store.lock()?,skill,task)
}
fn save_draft_db(db:&rusqlite::Connection, skill:Value,task:Option<&str>)->Result<Value> {
    let id = ws::id();
    db.execute("INSERT INTO agent_skill_packages(id,task_id,hash,source,status,skill_json,created_at) VALUES(?,?,?,?,'draft',?,?)",params![id,task,skill["hash"].as_str().unwrap_or(""),skill["source"].as_str().unwrap_or(""),skill.to_string(),ws::now()])?;
    let mut draft = skill;
    draft["id"] = id.into();
    Ok(draft)
}
pub(crate) fn draft_tx(db:&rusqlite::Connection,task:&str,args:&Value)->Result<Value> {
    initialize_db(db)?;
    let skill=make_skill(args.clone(),"Agent任务草稿")?;
    Ok(json!({"draft":save_draft_db(db,skill,Some(task))?,"message":"技能草稿已保存；玩家采用后成为常用技能，没有安装扩展或新增授权。"}))
}
pub(crate) fn rpc(store: &Store, request: &Value) -> Result<Option<Value>> {
    let op = request["op"].as_str().unwrap_or("");
    if !["package_import", "package_drafts", "package_adopt"].contains(&op) {
        return Ok(None);
    }
    initialize(store)?;
    let pi_filter=if request["_piOnly"]==true {" AND (task_id IS NULL OR EXISTS(SELECT 1 FROM pi_tasks p WHERE p.id=agent_skill_packages.task_id))"}else{""};
    let result = match op {
        "package_import" => {
            let values = request["bytes"]
                .as_array()
                .ok_or_else(|| invalid("没有选择技能文件"))?;
            if values.len() > MAX_PACKAGE {
                return Err(invalid("技能包最多8MiB"));
            }
            let bytes = values
                .iter()
                .map(|v| {
                    v.as_u64()
                        .filter(|n| *n <= 255)
                        .map(|n| n as u8)
                        .ok_or_else(|| invalid("文件内容无效"))
                })
                .collect::<Result<Vec<_>>>()?;
            let skill = import(&bytes, request["name"].as_str().unwrap_or("技能文件"))?;
            json!({"draft":save_draft(store,skill,None)?})
        }
        "package_drafts" => {
            let db = store.lock()?;
            let task = request["taskId"].as_str().unwrap_or("");
            let mut stmt=db.prepare(&format!("SELECT id,skill_json FROM agent_skill_packages WHERE status='draft' AND (?='' OR task_id=?) {pi_filter} ORDER BY created_at"))?;
            let rows = stmt
                .query_map(params![task, task], |r| {
                    Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?))
                })?
                .collect::<std::result::Result<Vec<_>, _>>()?;
            let drafts = rows
                .into_iter()
                .map(|(id, s)| {
                    let mut v = ws::parse(&s);
                    v["id"] = id.into();
                    v
                })
                .collect::<Vec<_>>();
            json!({"drafts":drafts})
        }
        _ => {
            let mut db = store.lock()?;
            let tx = db.transaction()?;
            let id = request["draftId"]
                .as_str()
                .ok_or_else(|| invalid("技能草稿不存在"))?;
            let s: String = tx
                .query_row(
                    &format!("SELECT skill_json FROM agent_skill_packages WHERE id=? AND status='draft' {pi_filter}"),
                    [id],
                    |r| r.get(0),
                )
                .optional()?
                .ok_or_else(|| invalid("技能草稿不存在或已采用"))?;
            let skill = ws::parse(&s);
            let previous: Option<String> = tx
                .query_row(
                    "SELECT value FROM settings WHERE key='agent:preferences'",
                    [],
                    |r| r.get(0),
                )
                .optional()?;
            let mut prefs = previous
                .as_deref()
                .map(ws::parse)
                .filter(Value::is_object)
                .unwrap_or(json!({}));
            let mut skills = prefs["customSkills"]
                .as_array()
                .cloned()
                .unwrap_or_default();
            skills.retain(|s| s["id"] != skill["id"]);
            skills.push(skill.clone());
            prefs["customSkills"] = json!(skills);
            tx.execute("INSERT INTO settings(key,value) VALUES('agent:preferences',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",[prefs.to_string()])?;
            tx.execute(
                "UPDATE agent_skill_packages SET status='adopted' WHERE id=?",
                [id],
            )?;
            tx.commit()?;
            json!({"skill":skill})
        }
    };
    Ok(Some(result))
}
pub(crate) fn tool(store: &Store, plan: &RunPlan, name: &str, args: &Value) -> Result<Value> {
    match name {
        "draft_skill" => {
            let skill = make_skill(args.clone(), "Agent任务草稿")?;
            Ok(
                json!({"draft":save_draft(store,skill,plan.meta["agent"]["taskId"].as_str())?,"message":"技能草稿已保存，需玩家采用后成为常用技能；没有新增授权"}),
            )
        }
        "read_skill_resource" => {
            let id = args["id"].as_str().unwrap_or("");
            let path = args["path"].as_str().unwrap_or("SKILL.md");
            if !safe_path(path) {
                return Err(invalid("只能读取所选技能包内的资源"));
            }
            let skill = plan.meta["agent"]["customSkills"]
                .as_array()
                .and_then(|a| a.iter().find(|s| s["id"] == id))
                .ok_or_else(|| invalid("本任务没有这个技能包"))?;
            let text = skill["files"][path]
                .as_str()
                .or_else(|| {
                    if path == "SKILL.md" {
                        skill["content"].as_str()
                    } else {
                        None
                    }
                })
                .ok_or_else(|| invalid("技能资源不存在"))?;
            let offset = args["offset"].as_u64().unwrap_or(0) as usize;
            let limit = args["limit"].as_u64().unwrap_or(2400).clamp(1, 12000) as usize;
            let part = text.chars().skip(offset).take(limit).collect::<String>();
            Ok(
                json!({"id":id,"path":path,"hash":skill["hash"],"version":skill["version"],"text":part,"offset":offset,"nextOffset":offset+part.chars().count(),"total":text.chars().count()}),
            )
        }
        _ => Err(invalid("没有这项技能资源操作")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn import_skill_preserves_resources_and_never_grants_capabilities() {
        let s=import(br#"{"name":"reader","content":"Read evidence","files":{"references/test.md":"facts","scripts/check.js":"return 1"},"capabilities":["call_remote_tool"]}"#,"sample.json").unwrap();
        assert_eq!(s["files"]["scripts/check.js"], "return 1");
        assert!(s.get("allowedTools").is_none());
        assert!(make_skill(json!({"content":"x","files":{"../secret":"x"}}), "bad").is_err());
    }
    #[test]
    fn zip_package_adoption_preserves_preferences_without_enabling_it() {
        use std::{
            io::Write,
            sync::{Arc, Mutex},
        };
        let mut zip = zip::ZipWriter::new(Cursor::new(Vec::new()));
        let options = zip::write::SimpleFileOptions::default();
        zip.start_file("reader/SKILL.md", options).unwrap();
        zip.write_all(b"---\nname: reader\ndescription: Read evidence\nmetadata:\n  version: 2.0.0\n---\n# Read evidence").unwrap();
        zip.start_file("reader/references/note.md", options)
            .unwrap();
        zip.write_all(b"Evidence.").unwrap();
        let bytes = zip.finish().unwrap().into_inner();
        let db = rusqlite::Connection::open_in_memory().unwrap();
        db.execute_batch("CREATE TABLE settings(key TEXT PRIMARY KEY,value TEXT NOT NULL); INSERT INTO settings VALUES('agent:preferences','{\"skills\":[\"canon-reference\"],\"readOnly\":true}')").unwrap();
        let store = Store(Arc::new(Mutex::new(db)));
        let draft = rpc(
            &store,
            &json!({"op":"package_import","name":"reader.zip","bytes":bytes}),
        )
        .unwrap()
        .unwrap()["draft"]
            .clone();
        assert_eq!(draft["version"], "2.0.0");
        let adopted = rpc(&store, &json!({"op":"package_adopt","draftId":draft["id"]}))
            .unwrap()
            .unwrap()["skill"]
            .clone();
        assert_eq!(adopted["files"]["references/note.md"], "Evidence.");
        let prefs: String = store
            .lock()
            .unwrap()
            .query_row(
                "SELECT value FROM settings WHERE key='agent:preferences'",
                [],
                |r| r.get(0),
            )
            .unwrap();
        let prefs: Value = serde_json::from_str(&prefs).unwrap();
        assert_eq!(prefs["skills"], json!(["canon-reference"]));
        assert_eq!(prefs["readOnly"], true);
        assert_eq!(prefs["customSkills"][0]["hash"], adopted["hash"]);
        assert!(rpc(&store, &json!({"op":"package_adopt","draftId":draft["id"]})).is_err());
    }
}
