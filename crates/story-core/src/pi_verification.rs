//! Pure draft resource boundaries. These helpers bind a selection to complete
//! original/after objects; they do not verify prose, grant adoption authority,
//! run story replay, rebase the remainder or access storage.
use crate::{pi_store::arguments_hash, Error, Result};
use serde_json::{json, Value};
use std::collections::{BTreeMap, BTreeSet};

fn invalid(message: impl Into<String>) -> Error {
    Error::Invalid(message.into())
}
fn text<'a>(value: &'a Value, key: &str) -> &'a str {
    value[key].as_str().unwrap_or("")
}
fn list<'a>(workspace: &'a Value, key: &str) -> Result<&'a [Value]> {
    match workspace.get(key) {
        None | Some(Value::Null) => Ok(&[]),
        Some(Value::Array(items)) => Ok(items),
        _ => Err(invalid(format!("草稿{key}须为数组"))),
    }
}
fn calls(value: &Value, property: &str) -> Result<Vec<String>> {
    match value.get(property) {
        None | Some(Value::Null) => Ok(vec![]),
        Some(Value::String(call)) if !call.is_empty() => Ok(vec![call.clone()]),
        Some(Value::Array(items)) => {
            let mut result = vec![];
            for item in items {
                let Some(call) = item
                    .as_str()
                    .filter(|call| !call.is_empty() && call.len() <= 256)
                else {
                    return Err(invalid("草稿修改调用标识无效"));
                };
                if !result.iter().any(|old| old == call) {
                    result.push(call.into());
                }
            }
            Ok(result)
        }
        _ => Err(invalid("草稿修改调用标识格式无效")),
    }
}

struct Group {
    collection: &'static str,
    index: usize,
    group_id: String,
    kind: String,
    id: String,
    route: String,
    original: String,
    after: String,
    fingerprint: String,
    calls: Vec<String>,
    history: bool,
    memory: bool,
    world_settings: bool,
}
impl Group {
    fn value(&self, atomic_set: &str, atomic_size: usize) -> Value {
        json!({"groupId":self.group_id,"collection":self.collection,"kind":self.kind,"id":self.id,"routeId":self.route,"originalFingerprint":self.original,"afterFingerprint":self.after,"fingerprint":self.fingerprint,"callIds":self.calls,"atomicSetId":atomic_set,"atomicSetSize":atomic_size})
    }
}
fn group(
    collection: &'static str,
    index: usize,
    kind: &str,
    id: &str,
    route: &str,
    original: &Value,
    after: &Value,
    flags: Value,
    calls: Vec<String>,
) -> Group {
    let identity = json!({"collection":collection,"kind":kind,"id":id,"routeId":route});
    let group_id = format!("resource:{}", arguments_hash(&identity));
    let fingerprint = arguments_hash(
        &json!({"identity":identity,"original":original,"after":after,"flags":flags,"calls":calls}),
    );
    Group {
        collection,
        index,
        group_id,
        kind: kind.into(),
        id: id.into(),
        route: route.into(),
        original: arguments_hash(original),
        after: arguments_hash(after),
        fingerprint,
        calls,
        history: matches!(
            kind,
            "node"
                | "state"
                | "protagonist"
                | "people"
                | "places"
                | "cards"
                | "goals"
                | "facts"
                | "book"
                | "line"
                | "story"
                | "route"
        ),
        memory: matches!(kind, "pin" | "chapter"),
        world_settings: matches!(kind, "world" | "settings"),
    }
}
struct Analysis {
    groups: Vec<Group>,
    component: Vec<usize>,
}
impl Analysis {
    fn analyze(workspace: &Value) -> Result<Self> {
        if !workspace.is_object() {
            return Err(invalid("修改草稿须为对象"));
        }
        let mut groups = vec![];
        let mut resources = BTreeSet::new();
        for (index, edit) in list(workspace, "edits")?.iter().enumerate() {
            let (Some(original), Some(after)) = (edit.get("original"), edit.get("after")) else {
                return Err(invalid("资源草稿缺少完整original或after"));
            };
            if original == after {
                continue;
            }
            let kind = text(edit, "kind");
            let id = text(edit, "id");
            let route = text(edit, "routeId");
            if ![
                "node",
                "state",
                "protagonist",
                "people",
                "places",
                "cards",
                "goals",
                "facts",
                "settings",
                "world",
                "line",
                "pin",
                "chapter",
                "book",
            ]
            .contains(&kind)
            {
                return Err(invalid("草稿含未知的资源修改类型"));
            }
            // The writer merges state/node targets by kind+id regardless of
            // routeId. Two such entries are not separate editable resources.
            let target = if ["world", "settings"].contains(&kind) {
                ""
            } else if kind == "node" && id.is_empty() {
                original["id"].as_str().unwrap_or("")
            } else {
                id
            };
            if !resources.insert((kind.to_owned(), target.to_owned())) {
                return Err(invalid(
                    "同一实际资源有重复草稿，不能按路线或调用拆开采用；请先合并为完整after",
                ));
            }
            let edit_calls = calls(edit, "callIds")?;
            if edit_calls.is_empty() {
                return Err(invalid(
                    "资源草稿缺少修改调用归属，无法安全划分采用批次；请重新准备该资源的完整草稿",
                ));
            }
            let mut item = group(
                "edits",
                index,
                kind,
                id,
                route,
                original,
                after,
                json!({"recordReviewed":edit["recordReviewed"]}),
                edit_calls,
            );
            if kind == "world"
                && (after["current_line_id"] != original["current_line_id"]
                    || after["era_id"] != original["era_id"])
            {
                item.history = true;
            }
            groups.push(item);
        }
        let mut turn_ids = BTreeSet::new();
        for (index, turn) in list(workspace, "turns")?.iter().enumerate() {
            if !turn["narrative"]
                .as_str()
                .is_some_and(|text| !text.trim().is_empty())
                || !turn["record"].is_object()
            {
                return Err(invalid("剧情草稿须保留完整正文及record，不能选择局部文字"));
            }
            let turn_calls = calls(turn, "_agentCall")?;
            if turn_calls.len() != 1 || !turn_ids.insert(turn_calls[0].clone()) {
                return Err(invalid("剧情草稿须有唯一的真实修改调用标识"));
            }
            groups.push(group(
                "turns",
                index,
                "story",
                &turn_calls[0],
                "",
                &Value::Null,
                turn,
                Value::Null,
                turn_calls.clone(),
            ));
        }
        let mut route_ids = BTreeSet::new();
        for (index, route) in list(workspace, "routes")?.iter().enumerate() {
            let id = text(route, "id");
            if id.is_empty() || !route_ids.insert(id.to_owned()) || text(route, "headId").is_empty()
            {
                return Err(invalid("路线草稿须保留不重复的路线标识和起点"));
            }
            let route_calls = calls(route, "callId")?;
            if route_calls.len() != 1 {
                return Err(invalid("路线草稿须有真实修改调用标识"));
            }
            groups.push(group(
                "routes",
                index,
                "route",
                id,
                "",
                &Value::Null,
                route,
                Value::Null,
                route_calls,
            ));
        }
        if groups.len() > 1024 {
            return Err(invalid("本批资源过多，请先按任务整理草稿"));
        }
        let mut component = (0..groups.len()).collect::<Vec<_>>();
        fn root(parents: &mut [usize], at: usize) -> usize {
            let parent = parents[at];
            if parent != at {
                parents[at] = root(parents, parent);
            }
            parents[at]
        }
        fn join(parents: &mut [usize], a: usize, b: usize) {
            let a = root(parents, a);
            let b = root(parents, b);
            if a != b {
                parents[b] = a;
            }
        }
        // Without the guarded base/head and actual route paths, a pure helper
        // cannot prove that two replay/state mutations are independent. Keep
        // them closed, including implicit head targets and derived book binds.
        let first_history = groups.iter().position(|group| group.history);
        let first_settings = groups.iter().position(|group| group.world_settings);
        let mut owners = BTreeMap::new();
        for (index, group) in groups.iter().enumerate() {
            if let Some(first) = first_history {
                if group.history || group.memory {
                    join(&mut component, first, index);
                }
            }
            if let Some(first) = first_settings {
                if group.world_settings {
                    join(&mut component, first, index);
                }
            }
            for call in &group.calls {
                if let Some(previous) = owners.insert(call.clone(), index) {
                    join(&mut component, previous, index);
                }
            }
        }
        for index in 0..component.len() {
            component[index] = root(&mut component, index);
        }
        Ok(Self { groups, component })
    }
    fn views(&self) -> Vec<Value> {
        let mut sets: BTreeMap<usize, Vec<String>> = BTreeMap::new();
        for (index, group) in self.groups.iter().enumerate() {
            sets.entry(self.component[index])
                .or_default()
                .push(group.group_id.clone());
        }
        for ids in sets.values_mut() {
            ids.sort();
        }
        self.groups
            .iter()
            .enumerate()
            .map(|(index, group)| {
                let ids = &sets[&self.component[index]];
                group.value(
                    &format!("atomic:{}", arguments_hash(&json!(ids))),
                    ids.len(),
                )
            })
            .collect()
    }
    fn workspace(&self, original: &Value, indices: &BTreeSet<usize>) -> Result<Value> {
        let mut result = original.clone();
        let mut actual_calls = BTreeSet::new();
        let mut members = BTreeSet::new();
        for index in indices {
            let group = &self.groups[*index];
            members.insert((group.collection, group.index));
            actual_calls.extend(group.calls.iter().cloned());
        }
        for key in ["edits", "turns", "routes"] {
            result[key] = json!(list(original, key)?
                .iter()
                .enumerate()
                .filter(|(index, _)| members.contains(&(key, *index)))
                .map(|(_, value)| value.clone())
                .collect::<Vec<_>>());
        }
        let mut applied = vec![];
        for call in calls(original, "appliedCalls")? {
            if actual_calls.remove(&call) {
                applied.push(call);
            }
        }
        // Complete resource provenance is authoritative even if an old draft
        // omitted it from the convenience appliedCalls list.
        applied.extend(actual_calls);
        result["appliedCalls"] = json!(applied);
        Ok(result)
    }
}

/// Metadata only: complete resource hashes and atomic dependency sets. No raw
/// original/after prose is duplicated into the model's checklist.
pub(crate) fn resource_groups(workspace: &Value) -> Result<Value> {
    Ok(json!(Analysis::analyze(workspace)?.views()))
}
pub(crate) fn remaining_workspace(workspace:&Value,selected:&Value)->Result<Value> {
    select_verified_workspace(workspace,selected)?;
    let analysis=Analysis::analyze(workspace)?;
    let ids=selected.as_array().unwrap().iter().filter_map(|v|v["groupId"].as_str()).collect::<BTreeSet<_>>();
    let remaining=analysis.groups.iter().enumerate().filter(|(_,g)|!ids.contains(g.group_id.as_str())).map(|(i,_)|i).collect();
    analysis.workspace(workspace,&remaining)
}

/// `selected` is an explicit array of {groupId, fingerprint, afterFingerprint}
/// from resource_groups; optional originalFingerprint is also checked. Call
/// IDs are deliberately not a selection mechanism. This establishes bounded
/// selection only, never factual or narrative verification.
pub(crate) fn select_verified_workspace(workspace: &Value, selected: &Value) -> Result<Value> {
    let analysis = Analysis::analyze(workspace)?;
    let selections = selected
        .as_array()
        .ok_or_else(|| invalid("采用选择须为完整资源组数组，不能按调用标识过滤"))?;
    let mut chosen = BTreeSet::new();
    for selection in selections {
        let Some(object) = selection.as_object() else {
            return Err(invalid("采用选择须含资源组及原稿指纹"));
        };
        if object.keys().any(|key| {
            ![
                "groupId",
                "fingerprint",
                "afterFingerprint",
                "originalFingerprint",
            ]
            .contains(&key.as_str())
        }) {
            return Err(invalid(
                "只能选择完整资源组；不能按字段、调用或局部原文拆分",
            ));
        }
        let id = text(selection, "groupId");
        let Some((index, group)) = analysis
            .groups
            .iter()
            .enumerate()
            .find(|(_, group)| group.group_id == id)
        else {
            return Err(invalid("所选资源组已不存在，请重新读取草稿"));
        };
        if !chosen.insert(index) {
            return Err(invalid("资源组不能重复选择"));
        }
        if selection["fingerprint"] != group.fingerprint
            || selection["afterFingerprint"] != group.after
            || selection
                .get("originalFingerprint")
                .is_some_and(|value| value != &group.original)
        {
            return Err(invalid(
                "资源的完整原稿、改稿或调用归属已变化，请重新核对后选择",
            ));
        }
    }
    let chosen_components = chosen
        .iter()
        .map(|index| analysis.component[*index])
        .collect::<BTreeSet<_>>();
    let missing = analysis
        .groups
        .iter()
        .enumerate()
        .filter(|(index, _)| {
            chosen_components.contains(&analysis.component[*index]) && !chosen.contains(index)
        })
        .map(|(_, group)| json!({"groupId":group.group_id,"kind":group.kind,"id":group.id}))
        .collect::<Vec<_>>();
    if !missing.is_empty() {
        return Err(invalid(format!("本批包含状态、回放、路线或共享写入依赖，不能拆开采用；还需一同核对资源：{}。未采用任何修改。",json!(missing))));
    }
    let remaining = (0..analysis.groups.len())
        .filter(|index| !chosen.contains(index))
        .collect::<BTreeSet<_>>();
    Ok(
        json!({"selectedWorkspace":analysis.workspace(workspace,&chosen)?,"remainingWorkspace":analysis.workspace(workspace,&remaining)?,"selectedGroups":chosen.iter().map(|index|analysis.groups[*index].group_id.clone()).collect::<Vec<_>>(),"remainingGroups":remaining.iter().map(|index|analysis.groups[*index].group_id.clone()).collect::<Vec<_>>(),"requiresStoryValidation":!chosen.is_empty(),"requiresRemainingRebase":!chosen.is_empty()&&!remaining.is_empty(),"factsVerified":false,"narrativeVerified":false}),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    fn edit(kind: &str, id: &str, original: Value, after: Value, call: &str) -> Value {
        json!({"kind":kind,"id":id,"original":original,"after":after,"callIds":[call],"summaries":[format!("改{kind}")]})
    }
    fn selection(group: &Value) -> Value {
        json!({"groupId":group["groupId"],"fingerprint":group["fingerprint"],"afterFingerprint":group["afterFingerprint"]})
    }
    #[test]
    fn selects_complete_resources_keeps_original_order_and_rebuilds_actual_calls() {
        let no_op = edit("settings", "", json!({"a":1}), json!({"a":1}), "no-op");
        let pin = edit(
            "pin",
            "p1",
            json!({"detail":"旧"}),
            json!({"detail":"甲"}),
            "pin",
        );
        let chapter = edit(
            "chapter",
            "c1",
            json!({"summary":"旧"}),
            json!({"summary":"乙"}),
            "chapter",
        );
        let workspace = json!({"edits":[no_op,pin.clone(),chapter.clone()],"appliedCalls":["orphan","chapter","pin","no-op"]});
        let groups = resource_groups(&workspace).unwrap();
        assert_eq!(groups.as_array().unwrap().len(), 2);
        let result =
            select_verified_workspace(&workspace, &json!([selection(&groups[0])])).unwrap();
        assert_eq!(result["selectedWorkspace"]["edits"], json!([pin]));
        assert_eq!(result["remainingWorkspace"]["edits"], json!([chapter]));
        assert_eq!(result["selectedWorkspace"]["appliedCalls"], json!(["pin"]));
        assert_eq!(
            result["remainingWorkspace"]["appliedCalls"],
            json!(["chapter"])
        );
        assert_eq!(result["requiresRemainingRebase"], true);
        assert_eq!(result["factsVerified"], false);
        assert_eq!(
            workspace["appliedCalls"],
            json!(["orphan", "chapter", "pin", "no-op"]),
            "input is untouched"
        );
    }
    #[test]
    fn cannot_approve_half_a_merged_resource_or_reuse_a_stale_original() {
        let mut resource = edit(
            "settings",
            "",
            json!({"first":"旧","second":"旧"}),
            json!({"first":"已验","second":"未验"}),
            "a",
        );
        resource["callIds"] = json!(["a", "b"]);
        let workspace = json!({"edits":[resource]});
        let groups = resource_groups(&workspace).unwrap();
        let mut half = selection(&groups[0]);
        half["callIds"] = json!(["a"]);
        assert!(select_verified_workspace(&workspace, &json!([half])).is_err());
        let mut changed = workspace.clone();
        changed["edits"][0]["after"]["second"] = "后来修改".into();
        assert!(select_verified_workspace(&changed, &json!([selection(&groups[0])])).is_err());
        let mut changed = workspace.clone();
        changed["edits"][0]["original"]["first"] = "新基线".into();
        assert!(select_verified_workspace(&changed, &json!([selection(&groups[0])])).is_err());
        assert_eq!(
            select_verified_workspace(&workspace, &json!([selection(&groups[0])])).unwrap()
                ["selectedWorkspace"]["appliedCalls"],
            json!(["a", "b"])
        );
    }
    #[test]
    fn overlapping_state_node_history_and_implicit_head_are_atomic() {
        let workspace = json!({"edits":[edit("state","",json!({"protagonist":{"age":20}}),json!({"protagonist":{"age":21}}),"clock"),edit("protagonist","n9",json!({"age":20}),json!({"age":21}),"person"),edit("node","n2",json!({"id":"n2","record":{"time":0}}),json!({"id":"n2","record":{"time":5}}),"history")]});
        let groups = resource_groups(&workspace).unwrap();
        assert_eq!(groups[0]["atomicSetId"], groups[1]["atomicSetId"]);
        assert_eq!(groups[1]["atomicSetId"], groups[2]["atomicSetId"]);
        assert!(select_verified_workspace(&workspace, &json!([selection(&groups[0])])).is_err());
        let all = groups
            .as_array()
            .unwrap()
            .iter()
            .map(selection)
            .collect::<Vec<_>>();
        let result = select_verified_workspace(&workspace, &json!(all)).unwrap();
        assert_eq!(
            result["selectedWorkspace"]["edits"]
                .as_array()
                .unwrap()
                .len(),
            3
        );
    }
    #[test]
    fn routes_turns_books_and_history_memories_remain_closed() {
        let turn = json!({"narrative":"新增正式剧情","record":{"time":2},"_agentCall":"write"});
        let route = json!({"id":"branch","headId":"n","activate":true,"callId":"route"});
        let workspace = json!({"edits":[edit("book","b",json!({"title":"旧"}),json!({"title":"修订"}),"book"),edit("pin","p",json!({"detail":"旧"}),json!({"detail":"修订"}),"pin")],"turns":[turn.clone()],"routes":[route.clone()]});
        let groups = resource_groups(&workspace).unwrap();
        assert_eq!(groups.as_array().unwrap().len(), 4);
        assert!(groups
            .as_array()
            .unwrap()
            .iter()
            .all(|group| group["atomicSetId"] == groups[0]["atomicSetId"]));
        assert!(select_verified_workspace(&workspace, &json!([selection(&groups[2])])).is_err());
        let all = groups
            .as_array()
            .unwrap()
            .iter()
            .map(selection)
            .collect::<Vec<_>>();
        let result = select_verified_workspace(&workspace, &json!(all)).unwrap();
        assert_eq!(result["selectedWorkspace"]["turns"], json!([turn]));
        assert_eq!(result["selectedWorkspace"]["routes"], json!([route]));
    }
    #[test]
    fn shared_sql_targets_and_shared_call_ids_cannot_be_split() {
        let workspace = json!({"edits":[edit("world","w",json!({"settings":{"a":1}}),json!({"settings":{"a":2}}),"world"),edit("settings","",json!({"a":1}),json!({"a":3}),"settings")]});
        let groups = resource_groups(&workspace).unwrap();
        assert!(select_verified_workspace(&workspace, &json!([selection(&groups[0])])).is_err());
        let workspace = json!({"edits":[edit("pin","p1",json!("旧"),json!("甲"),"shared"),edit("pin","p2",json!("旧"),json!("乙"),"shared")]});
        let groups = resource_groups(&workspace).unwrap();
        assert!(select_verified_workspace(&workspace, &json!([selection(&groups[0])])).is_err());
        let mut duplicate = workspace.clone();
        duplicate["edits"][1]["id"] = "p1".into();
        duplicate["edits"][1]["routeId"] = "other".into();
        assert!(resource_groups(&duplicate).is_err());
    }
}
