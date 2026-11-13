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
    include_str!("../skills/story-recap/SKILL.md"),
    include_str!("../skills/character-knowledge/SKILL.md"),
    include_str!("../skills/continuity-check/SKILL.md"),
    include_str!("../skills/story-threads/SKILL.md"),
];

// Fixed support resources travel with the same immutable task snapshot/hash
// as their method. Only their paths are shown until explicitly requested.
const SUPPORT: &[(&str, &[(&str, &str)])] = &[
    ("story-recap", &[
        ("references/method.md", include_str!("../skills/story-recap/references/method.md")),
        ("examples/check.json", include_str!("../skills/story-recap/examples/check.json")),
    ]),
    ("character-knowledge", &[
        ("references/method.md", include_str!("../skills/character-knowledge/references/method.md")),
        ("examples/check.json", include_str!("../skills/character-knowledge/examples/check.json")),
    ]),
    ("continuity-check", &[
        ("references/method.md", include_str!("../skills/continuity-check/references/method.md")),
        ("examples/check.json", include_str!("../skills/continuity-check/examples/check.json")),
    ]),
    ("story-threads", &[
        ("references/method.md", include_str!("../skills/story-threads/references/method.md")),
        ("examples/check.json", include_str!("../skills/story-threads/examples/check.json")),
    ]),
    ("historical-world", &[
        ("references/life-notes.md", include_str!("../skills/historical-world/references/life-notes.md")),
    ]),
];

pub(crate) fn resource_directory(skill: &Value) -> Value {
    json!(skill["files"].as_object().into_iter().flat_map(|files| files.iter()).filter_map(|(path, content)| {
        content.as_str().map(|content| json!({"path":path,"chars":content.chars().count()}))
    }).collect::<Vec<_>>())
}

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

/// For ordinary passages: the same catalog, but reading a skill is optional.
pub fn catalog_brief() -> String {
    format!("【内置技能目录】\n以下仅是技能元数据，普通回合不必读取；确需某个方法时再用 read_skill 阅读正文。\n{}", catalog_json())
}

pub fn read(name: &str) -> Result<Value> {
    for document in DOCUMENTS {
        let skill = Skill::parse(document)?;
        if skill.name == name {
            let mut result = skill.metadata();
            result["body"] = Value::String(skill.body.into());
            if let Some((_, files)) = SUPPORT.iter().find(|(name, _)| *name == skill.name) {
                result["files"] = Value::Object(files.iter().map(|(path, content)| ((*path).into(), Value::String((*content).into()))).collect());
                result["resources"] = resource_directory(&result);
            }
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
    // Ordinary writing receives only the resource directory. Resource bodies
    // are read later against this exact built-in version, never auto-loaded.
    if let Some(object)=skill.as_object_mut(){object.remove("files");}
    Ok(skill)
}

pub(crate) fn read_writing_resource(name: &str, path: &str, version: &str, offset: usize, limit: usize) -> Result<Value> {
    if path.is_empty() || path.len()>500 || path.starts_with('/') || path.contains(['\\', ':', '\0']) || path.split('/').any(|part| part.is_empty() || part=="." || part=="..") {
        return Err(Error::Invalid("只能读取固定内置技能包内的资源路径".into()));
    }
    let skill=read(name)?;
    if version.is_empty() || skill["metadata"]["version"]!=version {
        return Err(Error::Invalid("内置技能版本已变化，请重新read_skill取得版本与资源目录".into()));
    }
    let method=if path=="SKILL.md" {Some(read_writing(name)?)} else {None};
    let content=if let Some(method)=&method {method["body"].as_str()} else {skill["files"][path].as_str()}
        .ok_or_else(||Error::Invalid("该内置技能没有这个支持资源".into()))?;
    let total=content.chars().count();let offset=offset.min(total);let limit=limit.clamp(1,6000);
    let text=content.chars().skip(offset).take(limit).collect::<String>();let next=offset+text.chars().count();
    Ok(json!({"id":name,"path":path,"version":version,"text":text,"offset":offset,"nextOffset":next,"total":total,"complete":next>=total,"executed":false,"bodyProfile":"ordinary-writing-1"}))
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
    fn task_skills_have_read_only_ordinary_profiles() {
        for name in ["story-recap", "character-knowledge", "continuity-check", "story-threads"] {
            let common = read_writing(name).unwrap();
            let full = read(name).unwrap();
            let body = common["body"].as_str().unwrap();
            assert_eq!(common["bodyProfile"], "ordinary-writing-1");
            assert!(full["body"].as_str().unwrap().starts_with(body));
            assert!(!body.contains("stage_edit"));
            assert!(!body.contains("finish_task"));
        }
    }
    #[test]
    fn bundled_skills_have_standard_metadata_and_readable_bodies() {
        let catalog = catalog_json();
        let catalog = catalog.as_array().unwrap();
        assert_eq!(catalog.len(), 11);
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
                    "canon-reference" => "1.8.0",
                    "story-writing" => "1.6.0",
                    "world-upkeep" => "1.5.0",
                    "continuity-check" => "1.1.1",
                    "story-recap" | "story-threads" => "1.1.0",
                    "character-knowledge" => "1.3.0",
                    "historical-world" => "1.2.0",
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
    #[test]
    fn builtin_resources_are_explicit_versioned_and_do_not_expand_ordinary_method_authority() {
        let skill=read("story-recap").unwrap();let version=skill["metadata"]["version"].as_str().unwrap();
        let ordinary=read_writing("story-recap").unwrap();
        assert!(ordinary.get("files").is_none());assert_eq!(ordinary["resources"].as_array().unwrap().len(),2);
        assert!(skill["files"]["examples/check.json"].is_string());
        let first=read_writing_resource("story-recap","references/method.md",version,0,10).unwrap();
        assert_eq!(first["text"].as_str().unwrap().chars().count(),10);assert_eq!(first["nextOffset"],10);
        assert_eq!(read_writing_resource("story-recap","references/method.md",version,10,6000).unwrap()["offset"],10);
        for path in ["../private", "/references/method.md", "references\\method.md", "references/./method.md", "references/missing.md"] {
            assert!(read_writing_resource("story-recap",path,version,0,20).is_err());
        }
        assert!(read_writing_resource("story-recap","references/method.md","old",0,20).is_err());
        let knowledge=read("character-knowledge").unwrap();
        let common=read_writing_resource("character-knowledge","SKILL.md",knowledge["metadata"]["version"].as_str().unwrap(),0,6000).unwrap();
        assert!(!common["text"].as_str().unwrap().contains("stage_edit"));
        assert!(crate::tools::validate("read_skill_resource",&json!({"id":"story-recap","path":"references/method.md"})).is_err());
    }

}
