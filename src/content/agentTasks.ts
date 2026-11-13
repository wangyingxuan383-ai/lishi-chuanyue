/** Editable task recipes. Picking one only prepares an input draft. */
export interface AgentTaskRecipe {
  id: string;
  name: string;
  description: string;
  scope: string;
  skills: readonly string[];
  readOnly: boolean;
  request: string;
}

export const AGENT_TASK_RECIPES: readonly AgentTaskRecipe[] = [
  { id: "recap", name: "回顾本局", description: "梳理当前处境、近期变化和待决定的事。", scope: "当前路线，重点回顾近期剧情", skills: ["story-recap"], readOnly: true,
    request: "按需读取本局历史、人物、目标及章节，概括当前处境、近期关键变化和仍待决定的事。区分正式发生、人物看法和资料不足，给出可回读的依据。只答复，不修改故事或推进时间。" },
  { id: "characters", name: "核对人物", description: "查身份、关系、称谓与人物在此时知道的事。", scope: "当前场景涉及的人物", skills: ["character-knowledge"], readOnly: true,
    request: "核对范围内人物的身份、称谓、关系和关键经历，区分旁白知道、人物亲见、听闻或误信。参考书内容不等于本局已经发生；关键结论给出本局或原著依据，找不到时明确保留未知。只列核对结果和具体问题，不修改故事。" },
  { id: "canon", name: "查证原著", description: "寻找原文，核对具体设定与事件。", scope: "当前剧情涉及的关键原著细节", skills: ["canon-reference"], readOnly: true,
    request: "自行定位已导入的参考书，批量搜索并阅读相关原文及必要邻段，遵守本局章节范围。逐项区分原文明示、合理推定、玩家分支及资料不足，给出引文与章节或页码。不要凭模型记忆补成确定事实；本次只查证，不修改本局。" },
  { id: "omissions", name: "补全遗漏", description: "围绕指定片段，补足遗漏的动作、因果或原著细节。", scope: "请填写要补全的回合、段落及遗漏内容", skills: ["story-writing", "continuity-check"], readOnly: false,
    request: "先读取指定片段、必要前后文和相关记录，再补足明确遗漏的动作、因果或细节。绑定参考书时按需读取原文核实；保留玩家主动分支，不恢复已被改变的原著事件。修改限定在指定范围，同步受影响记录；跨范围问题单列。按当前采用策略处理，最后说明实际修改、依据和未解决项。" },
  { id: "continuity", name: "检查连续性", description: "核对时间、地点、物件去向和人物行为是否衔接。", scope: "近期剧情及其直接相关的旧事", skills: ["continuity-check"], readOnly: true,
    request: "按需读取目标范围和有关旧事，检查人物身份与知情、时间地点、物件去向、行动因果和未完约定。不要把正常留白或玩家改写直接认定为错误。每个问题说明对应正文、影响范围和建议；资料不足单列。本次只分析，不改正文、记录或路线。" },
  { id: "clock-ledger", name: "核对时间与账目", description: "检查经过时长、日期显示和钱物记录。", scope: "当前时间及近期涉及钱物或耗时的回合", skills: ["world-upkeep"], readOnly: true,
    request: "读取实际时间、显示配置及范围内的回合记录，核对耗时、钱物和状态变化。区分显示校准与实际经过纠正，使用现有计算和预演能力，不逐字段扫描整局。给出具体差异、影响与依据；只报告，不修改日期、账目或历史。" },
  { id: "organize", name: "整理人物与设定", description: "整理重复、过时或矛盾的本局资料。", scope: "当前路线中与近期剧情相关的人物和设定", skills: ["world-upkeep"], readOnly: false,
    request: "按需查找范围内的人物、设定、记忆和来源，合并明确重复内容，保留仍有效的玩家设定与分支。过时资料和待核实矛盾分别处理，不凭空补写事实，不擅自改写历史正文。先核对关联影响，按当前采用策略保存完整修改组，最后说明实际采用范围和仍待核对事项。" },
  { id: "threads", name: "追查线索与约定", description: "查看当前路线仍待追查或兑现的事项及原句。", scope: "当前路线，与近期人物和物件有关的未完事项", skills: ["story-threads"], readOnly: true,
    request: "读取本局线索与承诺，按相关人物和物件回读起源及最新进展。区分未解决、已解决、作废和暂不提醒；传闻不当事实。只报告实际记录、出处和需要核对的事，不强行安排下一幕或自动修改剧情。" },
  { id: "routes", name: "比较故事路线", description: "比较指定路线分歧后的正文与状态。", scope: "请填写要比较的两条路线和关注范围", skills: ["continuity-check"], readOnly: true,
    request: "定位指定路线及共同分歧点，按关注范围比较正式剧情、人物、时间、钱物和关键设定。分别标注路线与来源，不把一条路线事实混入另一条。只说明差异和可能的连续性问题，不切换、合并或撤回路线。" },
  { id: "source-notes", name: "整理资料依据", description: "为某个问题汇总可回读的原文与本局依据。", scope: "请填写要整理的具体问题或主张", skills: ["canon-reference"], readOnly: true,
    request: "围绕指定问题查阅本局和已导入资料，整理少量最相关的摘录、出处和适用范围。区分原著规则、本局发生事实及玩家明确设定；一个宽泛依据不能证明无关经历。资料只用于本次答复，不自动写成故事事实或覆盖已有设定。" },
];

export function taskRecipe(id: unknown): AgentTaskRecipe | undefined {
  return AGENT_TASK_RECIPES.find(recipe => recipe.id === id);
}

export function taskRecipeText(recipe: AgentTaskRecipe, scope: string, extra: string): string {
  return [`${recipe.name}\n范围：${scope.trim() || recipe.scope}`, recipe.request,
    extra.trim() ? `补充要求：\n${extra.trim()}` : ""].filter(Boolean).join("\n\n");
}

export const WRITING_REQUIREMENT_PRESETS = [
  { name: "简练一些", hint: "删去重复和空泛描写，让表达简练自然；保留原有事实、信息与情节。", canon: false },
  { name: "补足动作与因果", hint: "补足选中范围内动作的衔接、原因和后果，不新增未经依据的关键事实，也不改动范围外的剧情。", canon: false },
  { name: "多用对白", hint: "用自然对白承载选中范围的信息与冲突，保留原有人物立场、事实和情节，不让人物说出尚不知道的事。", canon: false },
  { name: "限定人物视角", hint: "按本段主要视角人物的见闻重写，不把旁白或原著未来信息当作人物已知；保留原有事实。", canon: false },
  { name: "保留事实改写", hint: "保留人物、关系、事件、时间、钱物和结果，只调整叙述与节奏，不新增或删改事实。", canon: false },
  { name: "核对原著细节", hint: "查阅原文，核对本段人物身份、称谓、关系、能力和事件细节；保留玩家主动改写，只纠正有依据的错误。", canon: true },
  { name: "补全原著相关遗漏", hint: "查阅当前事件对应原文，补全选中范围中确实遗漏的关键动作、因果或细节；保留本局分支，不强行补回已被改变的原著事件，跨回合影响单列。", canon: true },
] as const;
