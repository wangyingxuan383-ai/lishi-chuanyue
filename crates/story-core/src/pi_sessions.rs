//! User-requested conversation cleanup, independent of formal story recovery.
use crate::{pi_store::PiStore, Error, Result};
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::{Component, Path};

fn invalid(message: &str) -> Error {
    Error::Invalid(message.into())
}

fn no_links(path: &Path) -> Result<()> {
    let metadata = std::fs::symlink_metadata(path).map_err(|_| invalid("无法核对助手会话文件"))?;
    if metadata.file_type().is_symlink() {
        return Err(invalid("助手会话目录包含链接，未删除"));
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        if metadata.file_attributes() & 0x400 != 0 {
            return Err(invalid("助手会话目录包含重解析点，未删除"));
        }
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path).map_err(|_| invalid("无法读取助手会话目录"))?
        {
            no_links(&entry.map_err(|_| invalid("无法读取助手会话文件"))?.path())?;
        }
    }
    Ok(())
}

pub(crate) fn delete(store: &PiStore, root: &Path, id: &str) -> Result<Value> {
    if id.is_empty()
        || id.len() > 128
        || !id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
        || !root.is_absolute()
        || root.components().any(|c| matches!(c, Component::ParentDir))
    {
        return Err(invalid("助手会话目录标识无效"));
    }
    let root = std::fs::canonicalize(root).map_err(|_| invalid("无法核对原生助手目录"))?;
    let target = root.join(id);
    let mut db = store.0.lock()?;
    let tx = db.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let exists = tx
        .query_row("SELECT 1 FROM pi_sessions WHERE id=?", [id], |_| Ok(()))
        .optional()?
        .is_some();
    if !exists {
        return Err(invalid("会话已删除或不属于新的Pi助手"));
    }
    let active=tx.query_row("SELECT 1 FROM pi_tasks t JOIN world_execution_leases l ON l.world_id=t.world_id AND l.owner_id=t.id WHERE t.session_id=? AND l.expires_at_ms>? LIMIT 1",params![id,crate::execution_lease::now_ms()],|_|Ok(())).optional()?.is_some();
    if active {
        return Err(invalid("原生执行尚未确认停止，请先停止后再删除会话"));
    }
    let exists = match std::fs::symlink_metadata(&target) {
        Ok(_) => true,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(_) => return Err(invalid("无法核对会话文件，尚未删除")),
    };
    if exists {
        let resolved =
            std::fs::canonicalize(&target).map_err(|_| invalid("无法核对会话文件位置"))?;
        if resolved.parent() != Some(root.as_path()) || resolved != target {
            return Err(invalid("助手会话文件不在原生目录中，未删除"));
        }
        no_links(&target)?;
        // The exact canonical child was verified above. No model-supplied path,
        // story data folder or independent recovery point is removed here.
        std::fs::remove_dir_all(&target)
            .map_err(|_| invalid("会话文件清理未完成，对话记录暂保留，请重试删除"))?;
    }
    let has_packages = tx
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_skill_packages'",
            [],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    if has_packages {
        tx.execute("DELETE FROM agent_skill_packages WHERE status='draft' AND task_id IN (SELECT id FROM pi_tasks WHERE session_id=?)",[id])?;
    }
    // Parser artifacts belong to tasks, never to formal story recovery.
    let mut task_ids=vec![];{let mut stmt=tx.prepare("SELECT id FROM pi_tasks WHERE session_id=?")?;for row in stmt.query_map([id],|r|r.get::<_,String>(0))?{task_ids.push(row?);}}
    if let Some(data)=root.parent(){for task in task_ids {if task.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-'){
        let cache=data.join("agent-documents").join(&task);if cache.exists(){if std::fs::canonicalize(&cache).map_err(|_|invalid("资料缓存位置不可核对"))?!=cache{return Err(invalid("资料缓存目录包含外部链接，未删除"));}no_links(&cache)?;std::fs::remove_dir_all(&cache).map_err(|_|invalid("资料缓存清理未完成，对话暂保留，请重试"))?;}
    }}}
    tx.execute("DELETE FROM pi_sessions WHERE id=?", [id])?;
    tx.commit()?;
    Ok(json!({"id":id,"deleted":true,"storyChanged":false,"recoveryPointsPreserved":true}))
}
