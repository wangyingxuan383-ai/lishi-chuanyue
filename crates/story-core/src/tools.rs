//! The built-in tool contract. Scope and writes are enforced by the run's
//! dispatcher; a model cannot supply another world's id or change book limits.
use crate::{Error, Result};
use serde_json::{json, Map, Value};

#[derive(Clone)]
pub struct ToolDefinition {
    pub name: &'static str,
    pub description: &'static str,
    pub parameters: Value,
    pub read_only: bool,
}

impl ToolDefinition {
    pub fn function(&self) -> Value {
        json!({"type":"function","function":{"name":self.name,"description":self.description,"parameters":self.parameters}})
    }
}

fn object(properties: Value, required: &[&str]) -> Value {
    json!({"type":"object","properties":properties,"required":required,"additionalProperties":false})
}

fn text(description: &str, max: usize) -> Value {
    json!({"type":"string","description":description,"minLength":1,"maxLength":max})
}

fn integer(description: &str, min: u64, max: u64) -> Value {
    json!({"type":"integer","description":description,"minimum":min,"maximum":max})
}

pub fn catalog() -> Vec<ToolDefinition> {
    vec![
        ToolDefinition { name: "read_world", description: "读取本次运行绑定路线的当前世界、玩家要求、人物处境、参考配置和玩法；不读取别的世界。", parameters: object(json!({}), &[]), read_only: true },
        ToolDefinition { name: "read_history", description: "查阅当前路线已经发生的正文和章节摘要，可用关键词寻找旧事；其他路线不混入。", parameters: object(json!({"query":text("要寻找的旧事或关键词",4000),"limit":integer("最多返回几回合",1,40)}), &[]), read_only: true },
        ToolDefinition { name: "read_characters", description: "读取本局人物、已知身份、别名、关系及其出处；不把原著将来的身份直接透露给人物。", parameters: object(json!({"query":text("人物名、别名或关系线索",2000),"offset":integer("起始条目",0,9007199254740991),"limit":integer("返回人数",1,20)}), &[]), read_only: true },
        ToolDefinition { name: "search_original", description: "在本局绑定书籍与允许章节范围内检索原文，返回候选位置和片段；命中并不等于已核实，随后用 read_original 阅读证据。", parameters: object(json!({"query":text("待核实的人名、别名、关系、事件或具体原著细节",4000)}), &["query"]), read_only: true },
        ToolDefinition { name: "read_original", description: "阅读命中的原著正文及邻近片段，保留书籍版本、章节、文本块和位置出处；程序执行章节边界。", parameters: object(json!({"section":integer("章节序号，从 0 开始",0,9_007_199_254_740_991),"chunk":integer("检索返回的文本块序号",0,9_007_199_254_740_991),"neighbors":integer("同时读取前后几个相邻片段，仍须遵守章节范围",0,2),"ref":object(json!({"bookId":text("书籍标识",256),"bookVersion":text("检索返回的版本",512),"section":integer("章节序号",0,9007199254740991),"chunk":integer("文本块序号",0,9007199254740991),"start":integer("UTF16起点",0,9007199254740991),"end":integer("UTF16终点",0,9007199254740991)}), &["bookId","bookVersion","section","chunk"]),"start":integer("UTF16起点",0,9007199254740991),"end":integer("UTF16终点",0,9007199254740991)}), &[]), read_only: true },
        ToolDefinition { name: "read_canon_notes", description: "读取玩家为本书整理的原著札记（章节主线、人物、设定、时间线等，AI整理，可编辑）；按人名、设定或章节关键词查找，留空列出全部标题。札记可能有误，需要原句时再read_original。", parameters: object(json!({"query":text("人名、设定、事件或章节关键词，可留空",500)}), &[]), read_only: true },
        ToolDefinition { name: "read_canon_facts", description: "读取带原著出处的已核实资料，区分原著、玩家明确改写和模型错误；摘要与模型印象不能替代原文。", parameters: object(json!({"query":text("人物、关系、地点、规则或事件",4000)}), &[]), read_only: true },
        ToolDefinition { name: "locate_original_event", description: "按当前事件、人物和地点寻找原著候选章节；不改变开局位置，不把候选当已核实。用read_original直接回传ref读原文。", parameters:object(json!({"query":text("当前事件与具体线索",4000),"queries":{"type":"array","maxItems":8,"items":{"type":"string"}}}),&[]),read_only:true },
        ToolDefinition { name: "prepare_reference_check", description: "将最多8项具体主张批量定位到原著候选；为身份、关系、能力、物品、时点和遗漏事件分别准备资料。返回verified=false，须read_original核对原句。", parameters:object(json!({"claims":{"type":"array","maxItems":8,"items":{"type":"string"}}}),&["claims"]),read_only:true },
        ToolDefinition { name: "preview_turn_record", description: "只读预演本回合记录对时间、钱物和状态的影响，返回前后对照与程序提示；不保存、不推进实际故事。", parameters:object(json!({"record":{"type":"object"}}),&["record"]),read_only:true },
        ToolDefinition { name: "read_story_resources", description: "查询本路线地点places、设定cards、目标goals、人物people或物品items；用返回ref分页读字段。仅正式资料，定位不授予修改权限。", parameters: object(json!({"kind":{"type":"string","enum":["places","cards","goals","people","items"]},"query":text("查询线索",1000),"ref":{"type":"object"},"pageSize":integer("条目数",1,20),"charBudget":integer("文字预算",128,6000),"nextCursor":{"type":"string"}}), &[]), read_only:true },
        ToolDefinition { name: "read_continuity", description: "查询本路线人物知情knowledge或线索承诺threads及原句；相信或传闻不等于事实，未记录不等于不知情。", parameters: object(json!({"kind":{"type":"string","enum":["knowledge","threads"]},"query":text("人物或线索",1000),"includeInactive":{"type":"boolean"},"ref":{"type":"object"},"pageSize":integer("条目数",1,20),"charBudget":integer("文字预算",128,6000),"nextCursor":{"type":"string"}}), &[]), read_only:true },
        ToolDefinition { name: "list_skills", description: "列出本机内置技能的名称、说明和版本；按当前世界与玩法选择并读取。", parameters: object(json!({}), &[]), read_only: true },
        ToolDefinition { name: "read_skill", description: "读取指定内置技能的完整正文与固定版本；技能是工作指导，不是可执行代码。", parameters: object(json!({"name":text("list_skills 返回的技能名称",64)}), &["name"]), read_only: true },
        ToolDefinition { name: "read_skill_resource", description: "按read_skill返回的内置技能版本和路径分段读取支持资料。必须传同版本，不执行脚本，不访问自定义包或任意文件；SKILL.md仅返回普通只读配置。", parameters: object(json!({"id":text("固定内置技能标识",64),"path":text("资源目录返回的相对路径",500),"version":text("read_skill返回的版本",64),"offset":integer("起始文字位置",0,9007199254740991),"limit":integer("最多返回字符数",1,6000)}), &["id","path","version"]), read_only: true },
    ]
}

pub fn definitions() -> Vec<Value> {
    catalog().iter().map(ToolDefinition::function).collect()
}

/// Validate the small schema subset used above. The dispatcher additionally
/// checks semantic scope, original-book evidence and staged state changes.
pub fn validate(name: &str, arguments: &Value) -> Result<()> {
    validate_with(&catalog(), name, arguments)?;
    if name=="read_original" && !arguments["ref"].is_object() && !arguments["section"].is_u64(){return Err(Error::Invalid("read_original需要ref或section定位".into()));}
    Ok(())
}
pub fn validate_with(definitions: &[ToolDefinition], name: &str, arguments: &Value) -> Result<()> {
    let tool = definitions
        .iter()
        .find(|tool| tool.name == name)
        .ok_or_else(|| Error::Invalid(format!("没有名为 {name} 的内置工具")))?;
    let args = arguments
        .as_object()
        .ok_or_else(|| Error::Invalid("工具参数必须是对象".into()))?;
    if tool.parameters["type"] != "object" {
        return Err(Error::Invalid(format!("工具 {name} 的参数定义不是对象")));
    }
    let properties = tool.parameters["properties"]
        .as_object()
        .ok_or_else(|| Error::Invalid(format!("工具 {name} 的参数定义无效")))?;
    let required = match tool.parameters.get("required") {
        None => &[][..],
        Some(required) => required
            .as_array()
            .map(Vec::as_slice)
            .ok_or_else(|| Error::Invalid(format!("工具 {name} 的必填参数定义无效")))?,
    };
    for required in required {
        let key = required
            .as_str()
            .ok_or_else(|| Error::Invalid(format!("工具 {name} 的必填参数名称无效")))?;
        if !args.contains_key(key) {
            return Err(Error::Invalid(format!("缺少工具参数 {key}")));
        }
    }
    for (key, value) in args {
        let schema = properties
            .get(key)
            .ok_or_else(|| Error::Invalid(format!("不支持工具参数 {key}")))?;
        if !schema.is_object() {
            return Err(Error::Invalid(format!("工具 {name} 的参数 {key} 定义无效")));
        }
        validate_field(key, value, schema)?;
    }
    Ok(())
}

fn validate_field(key: &str, value: &Value, schema: &Value) -> Result<()> {
    let valid = match schema["type"].as_str() {
        Some("string") => value.as_str().is_some_and(|s| {
            !s.trim().is_empty()
                && s.chars().count() <= schema["maxLength"].as_u64().unwrap_or(u64::MAX) as usize
        }),
        Some("integer") => value.as_u64().is_some_and(|n| {
            n >= schema["minimum"].as_u64().unwrap_or(0)
                && n <= schema["maximum"].as_u64().unwrap_or(u64::MAX)
        }),
        Some("object") => value.is_object(),
        Some("array") => value.is_array(),
        Some("boolean") => value.is_boolean(),
        None => true,
        _ => false,
    };
    if !valid
        || schema
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|allowed| !allowed.contains(value))
    {
        return Err(Error::Invalid(format!("工具参数 {key} 的内容或范围无效")));
    }
    Ok(())
}

pub fn parameter_object(schema: &Value) -> Result<Map<String, Value>> {
    schema
        .as_object()
        .cloned()
        .ok_or_else(|| Error::Invalid("工具参数定义必须是对象".into()))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn optional_required_is_valid_but_malformed_definitions_return_errors() {
        let mut tool = ToolDefinition {
            name: "read",
            description: "",
            parameters: json!({"type":"object","properties":{},"additionalProperties":false}),
            read_only: true,
        };
        validate_with(&[tool.clone()], "read", &json!({})).unwrap();
        for schema in [
            json!({"type":"object","properties":{},"required":null}),
            json!({"type":"object","properties":{},"required":[12]}),
            json!({"type":"object","properties":[]}),
            json!({"type":"array"}),
        ] {
            tool.parameters = schema;
            assert!(validate_with(&[tool.clone()], "read", &json!({})).is_err());
        }
    }

    #[test]
    fn definitions_and_validation_share_the_contract() {
        let tools = definitions();
        assert_eq!(tools.len(), 15);
        assert!(catalog().iter().all(|tool| tool.read_only));
        assert!(tools
            .iter()
            .all(|t| t["type"] == "function" && t["function"]["parameters"]["type"] == "object"));
        validate(
            "read_original",
            &json!({"section":2,"chunk":7,"neighbors":1}),
        )
        .unwrap();
        for (name, args) in [
            ("search_original", json!({})),
            ("search_original", json!({"query":" "})),
            ("read_original", json!({"section":-1})),
            ("read_original", json!({"section":0,"neighbors":3})),
            ("read_world", json!({"worldId":"another-world"})),
            ("commit_turn", json!({})),
            ("arbitrary_sql", json!({})),
        ] {
            assert!(validate(name, &args).is_err(), "{name}: {args}");
        }
    }
}
