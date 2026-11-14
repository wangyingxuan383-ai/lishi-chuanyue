//! What a phone notification says about a story (R29-T006): the story's
//! title, the new passage's first sentence, a short reason when a run stopped.
//! Pure text and one read; the host decides whether and how to show it.
use crate::Store;
use rusqlite::OptionalExtension;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Notice {
    pub world_id: String,
    pub title: String,
    pub excerpt: String,
}

/// The first sentence of a passage, at most `max` characters, on one line.
pub fn excerpt(narrative: &str, max: usize) -> String {
    let flat: String = narrative.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut out = String::new();
    for (count, c) in flat.chars().enumerate() {
        if count >= max {
            out.push('…');
            break;
        }
        out.push(c);
        // A sentence long enough to say something ends here.
        if "。！？!?…".contains(c) && out.chars().count() >= 12 {
            break;
        }
    }
    out
}

/// For a commit id "world:node": the story's title and its passage's first sentence.
pub fn committed(store: &Store, completion: &str) -> Option<Notice> {
    let (world, node) = completion.split_once(':')?;
    let db = store.lock().ok()?;
    let title: String = db.query_row("SELECT title FROM worlds WHERE id=?", [world], |r| r.get(0)).optional().ok()??;
    let narrative: String = db.query_row("SELECT narrative FROM nodes WHERE id=? AND world_id=?", [node, world], |r| r.get(0)).optional().ok().flatten().unwrap_or_default();
    Some(Notice { world_id: world.to_owned(), title, excerpt: excerpt(&narrative, 60) })
}

/// One line for "没写完": the engine's reason, without the trailing note the app shows anyway.
pub fn reason(status: &str, reason: &str) -> String {
    match status {
        "paused" => "已先停下，进度已保存，可以接着写完".into(),
        "cancelled" => "已停止，进度已保存".into(),
        _ => {
            let line = reason.trim().trim_end_matches("，进度已保存");
            if line.is_empty() { "这次没写成，进度已保存".into() } else { excerpt(line, 40) }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn excerpt_is_the_first_real_sentence_on_one_line() {
        assert_eq!(excerpt("  你推开门。\n\n院子里站着一个人，背对着你，一动不动。他转过身。", 60), "你推开门。 院子里站着一个人，背对着你，一动不动。");
        assert_eq!(excerpt(&"长".repeat(80), 10), format!("{}…", "长".repeat(10)));
        assert_eq!(excerpt("", 10), "");
    }
    #[test]
    fn reasons_are_short_and_for_players() {
        assert_eq!(reason("paused", "本次生成用到的模型请求较多，已先停下，进度已保存"), "已先停下，进度已保存，可以接着写完");
        assert_eq!(reason("failed", "AI 服务暂时不可用，进度已保存"), "AI 服务暂时不可用");
    }
}
