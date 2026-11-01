//! Versioned, bundled Agent Skills. Only metadata is put in every prompt;
//! read_skill returns the selected document body without executing it.
use crate::{Error, Result};
use serde_json::{json, Value};

const DOCUMENTS: &[&str] = &[
    include_str!("../skills/canon-reference/SKILL.md"),
    include_str!("../skills/story-writing/SKILL.md"),
    include_str!("../skills/world-upkeep/SKILL.md"),
    include_str!("../skills/historical-world/SKILL.md"),
    include_str!("../skills/script-play/SKILL.md"),
    include_str!("../skills/challenge-play/SKILL.md"),
    include_str!("../skills/spectator-play/SKILL.md"),
];

struct Skill {
    name: &'static str,
    description: &'static str,
    version: &'static str,
    body: &'static str,
}

impl Skill {
    /// The shipped frontmatter uses only plain one-line scalars and a version
    /// mapping. No runtime YAML loader or arbitrary local-file lookup is needed.
    fn parse(document: &'static str) -> Result<Self> {
        let (header, body) = document
            .strip_prefix("---\n")
            .and_then(|text| text.split_once("\n---\n"))
            .or_else(|| {
                document
                    .strip_prefix("---\r\n")
                    .and_then(|text| text.split_once("\r\n---\r\n"))
            })
            .ok_or_else(|| Error::Invalid("内置技能缺少标准元数据".into()))?;
        let scalar = |prefix: &str| {
            header
                .lines()
                .find_map(|line| line.strip_prefix(prefix))
                .map(str::trim)
                .filter(|value| !value.is_empty())
        };
        let name = scalar("name: ").ok_or_else(|| Error::Invalid("内置技能缺少名称".into()))?;
        let description =
            scalar("description: ").ok_or_else(|| Error::Invalid("内置技能缺少说明".into()))?;
        let version =
            scalar("  version: ").ok_or_else(|| Error::Invalid("内置技能缺少版本".into()))?;
        if !header.lines().any(|line| line == "metadata:") || body.trim().is_empty() {
            return Err(Error::Invalid("内置技能内容不完整".into()));
        }
        Ok(Self {
            name,
            description,
            version,
            body: body.trim(),
        })
    }

    fn metadata(&self) -> Value {
        json!({"name":self.name,"description":self.description,"metadata":{"version":self.version}})
    }
}

pub fn catalog_json() -> Value {
    Value::Array(
        DOCUMENTS
            .iter()
            .map(|document| {
                Skill::parse(document)
                    .expect("shipped Agent Skill metadata")
                    .metadata()
            })
            .collect(),
    )
}

pub fn catalog_text() -> String {
    format!("【内置技能目录】\n以下仅是技能元数据。根据世界和玩法使用 read_skill 阅读所需正文，再执行其中的步骤。技能版本随本次运行记录；没有读取技能正文，不声称已经依照它完成检查。\n{}", catalog_json())
}

pub fn read(name: &str) -> Result<Value> {
    for document in DOCUMENTS {
        let skill = Skill::parse(document)?;
        if skill.name == name {
            let mut result = skill.metadata();
            result["body"] = Value::String(skill.body.into());
            return Ok(result);
        }
    }
    Err(Error::Invalid(format!("没有名为 {name} 的内置技能")))
}

/// The same common rules, without Agent-only commit protocols. This is a
/// named execution profile, not a size-dependent truncation of instructions.
pub fn read_writing(name:&str)->Result<Value>{
    let mut skill=read(name)?;
    if let Some((common,_))=skill["body"].as_str().and_then(|body|body.split_once("\n## Agent执行\n")){
        let common=common.trim().to_owned();skill["body"]=common.into();skill["bodyProfile"]="ordinary-writing-1".into();
    }
    Ok(skill)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashSet;

    #[test]
    fn ordinary_profile_retains_shared_evidence_rules_without_agent_submission_protocol(){
        let common=read_writing("canon-reference").unwrap();let full=read("canon-reference").unwrap();
        let body=common["body"].as_str().unwrap();assert!(body.contains("章节"));assert!(body.contains("AI 自行误写"));assert!(body.contains("locate_original_event"));assert!(!body.contains("finish_task"));assert!(full["body"].as_str().unwrap().starts_with(body));assert_eq!(common["bodyProfile"],"ordinary-writing-1");
    }
    #[test]
    fn bundled_skills_have_standard_metadata_and_readable_bodies() {
        let catalog = catalog_json();
        let catalog = catalog.as_array().unwrap();
        assert_eq!(catalog.len(), 7);
        let names: HashSet<_> = catalog
            .iter()
            .map(|skill| skill["name"].as_str().unwrap())
            .collect();
        assert_eq!(names.len(), catalog.len());
        for skill in catalog {
            let name = skill["name"].as_str().unwrap();
            assert!(name.len() <= 64 && name.bytes().all(|b| b.is_ascii_lowercase() || b == b'-'));
            assert_eq!(
                skill["metadata"]["version"],
                match name {
                    "canon-reference" => "1.7.1",
                    "story-writing" => "1.5.1",
                    "world-upkeep" => "1.4.1",
                    "script-play" | "spectator-play" => "1.0.0",
                    _ => "1.1.0",
                }
            );
            assert!(read(name).unwrap()["body"]
                .as_str()
                .unwrap()
                .starts_with('#'));
        }
        assert!(read("../../private").is_err());
        assert!(read("canon-reference").unwrap()["body"]
            .as_str()
            .unwrap()
            .contains("insufficient"));
        assert!(!catalog_text().contains("# 遵循原著"));
    }
}
