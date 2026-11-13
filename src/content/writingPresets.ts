// Built-in suggestions are copied into the current form. They never become
// shared live settings, and a later catalog update cannot rewrite a story.
export interface BuiltinNarrativePreset {
  id: string;
  version: string;
  name: string;
  directive: string;
  rules: string;
}
export interface BuiltinSourceUsage {
  id: string;
  version: string;
  name: string;
  text: string;
}

export const BUILTIN_NARRATIVE_PRESETS: readonly BuiltinNarrativePreset[] = [
  {
    id: "player-decides", version: "1.0.0", name: "主角由我决定",
    directive: "围绕眼前处境和我写下的行动展开。把可观察的反应写清楚，留出选择的余地。",
    rules: "主角的决定、承诺、立场与关键台词由我给出；不替我接受任务、透露秘密或跳过需要决定的时刻。人物可以误会和拒绝，结果仍按本局事实与情理发展。",
  },
  {
    id: "restrained-prose", version: "1.0.0", name: "克制叙述",
    directive: "用具体的动作、对白和少量感官细节呈现，不反复解释已经表达的情绪。",
    rules: "少用空泛感叹、夸张比喻与总结升华。保留人物差异和必要因果，不因文字简练而略过关键证据、选择或结果。",
  },
  {
    id: "leisurely-rhythm", version: "1.0.0", name: "节奏舒缓",
    directive: "允许日常、交谈和观察自然展开，让人物关系在相处中变化。",
    rules: "不为了每段都有转折而凭空制造危机，也不急着结束正在进行的场景。明确的期限、危险和已经发生的后果仍然有效，主角下一步由我决定。",
  },
  {
    id: "focused-conflict", version: "1.0.0", name: "冲突紧凑",
    directive: "围绕当前问题推进，每段呈现清楚的行动、阻力或新信息，减少重复铺陈。",
    rules: "紧凑不等于连续升级灾难；不重复同一种威胁，不跳过必要因果与玩家选择。解决一个局部问题后允许收束，不强行追加新的悬念。",
  },
];

export const BUILTIN_SOURCE_USAGES: readonly BuiltinSourceUsage[] = [
  {
    id: "canon-details", version: "1.0.0", name: "原著细节优先",
    text: "涉及原著人物的身份、称谓、关系、能力、物品与事件顺序时，先定位并阅读允许范围内的原文，核实本次实际写到的细节。摘要与模型记忆只辅助定位；找不到依据时保留不确定，不编成原著定论。是否沿原剧情仍按本局的剧情关系设置处理。",
  },
  {
    id: "keep-player-branch", version: "1.0.0", name: "保留玩家分支",
    text: "参考原著的人物性格、关系和世界规则，同时保留我明确设定或行动造成的本局变化。先区分原著事实、玩家分支与AI自行写错，再处理冲突；原著可能发生的事不能直接记成本局已经发生，也不把我改变的结果强行恢复。",
  },
  {
    id: "related-missing-events", version: "1.0.0", name: "核对相关遗漏",
    text: "围绕当前场景和已经出现的人物定位原著，检查与这次行动相关的重要情节、必要前提及细节是否遗漏。只有符合本局当前事实和剧情关系的内容才作为发展或改稿参考；被玩家改变的事件单列，不照抄后文，也不为补齐原著替主角作决定。",
  },
  {
    id: "limited-character-knowledge", version: "1.0.0", name: "限定人物视角",
    text: "叙事可以在允许范围内查阅原著，但人物只能依据本局已经亲见、获知、听闻或合理推断的信息行动。原著未来身份与事件不能提前赋给人物；相信或传闻不等于事情为真，没有知情记录也不等于绝对不知道。资料不足时先核对必要正文。",
  },
];

/** Only editable wording is copied; catalog identity and version stay local. */
export function copyNarrativePreset(preset: BuiltinNarrativePreset): { directive: string; rules: string } {
  return { directive: preset.directive, rules: preset.rules };
}
