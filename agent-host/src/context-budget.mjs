const positiveInteger = (value, name) => {
  if (!Number.isSafeInteger(value) || value <= 0) {
    const error = new Error(`${name} must be a positive safe integer`);
    error.code = "invalid_context_budget";
    throw error;
  }
  return value;
};

// The pinned Pi provider adapter retains this margin when fitting response caps.
// Do not shrink its model window to the APP input cap and accidentally consume it.
const PI_CONTEXT_SAFETY_TOKENS = 4096;

/** Keep configured model capacity separate from Pi's application input cap. */
export function contextBudget(model) {
  const inputBudgetTokens = positiveInteger(model.inputTokens ?? 475_000, "inputTokens");
  const outputReserveTokens = positiveInteger(model.maxOutputTokens ?? 8192, "maxOutputTokens");
  const modelContextWindowTokens = model.contextWindowTokens == null
    ? null : positiveInteger(model.contextWindowTokens, "contextWindowTokens");
  if (modelContextWindowTokens !== null && modelContextWindowTokens <= outputReserveTokens) {
    const error = new Error("contextWindowTokens must leave input space after maxOutputTokens");
    error.code = "invalid_context_budget";
    throw error;
  }
  const effectiveInputBudgetTokens = Math.min(inputBudgetTokens,
    modelContextWindowTokens === null ? inputBudgetTokens : modelContextWindowTokens - outputReserveTokens);
  const runtimeContextWindowTokens = modelContextWindowTokens ?? positiveInteger(inputBudgetTokens + outputReserveTokens + PI_CONTEXT_SAFETY_TOKENS, "effective context window");
  const compactionReserveTokens = runtimeContextWindowTokens - effectiveInputBudgetTokens;
  return { inputBudgetTokens, outputReserveTokens, modelContextWindowTokens, effectiveInputBudgetTokens,
    runtimeContextWindowTokens, compactionReserveTokens };
}

/** Use Pi's estimator; this is not an official provider tokenizer. */
export function estimateRequestTokens(pi, context) {
  const messages = context.messages ?? [];
  let tokens = messages.reduce((sum, message) => sum + pi.estimateTokens(message), 0);
  const systemMessages = messages.filter((message) => message.role === "system");
  if (context.systemPrompt && systemMessages.length === 0) {
    tokens += pi.estimateTokens({ role: "system", content: context.systemPrompt });
  }
  // Current Pi declares tools on system messages. Also account for a legacy or
  // custom caller that supplies executable tools separately, without counting
  // the same declaration twice.
  const declared = new Set(systemMessages.flatMap((message) => message.toolsAdded ?? []).map((tool) => tool.name));
  const undeclared = (context.tools ?? []).filter((tool) => !declared.has(tool.name));
  if (undeclared.length) {
    tokens += pi.estimateTokens({ role: "system", content: "", toolsAdded: undeclared.map(({ name, description, parameters }) => ({ name, description, parameters })) });
  }
  return tokens;
}

export function checkRequestBudget(pi, budget, context, options = {}) {
  const outputTokens = Math.max(budget.outputReserveTokens, options.maxTokens ?? 0);
  const effectiveInputBudgetTokens = Math.min(budget.effectiveInputBudgetTokens, budget.runtimeContextWindowTokens - outputTokens);
  const estimatedInputTokens = estimateRequestTokens(pi, context);
  const details = { ...budget, effectiveInputBudgetTokens, estimatedInputTokens, requestOutputTokens: outputTokens, estimateMethod: "pi-estimateTokens" };
  if (estimatedInputTokens > effectiveInputBudgetTokens) {
    const error = new Error(`输入内容按 Pi 估算为 ${estimatedInputTokens} tokens，超过本次可用输入预算 ${effectiveInputBudgetTokens}；请缩小本次资料或提高任务输入预算。内容未截断，本次请求未发送。`);
    error.code = "input_budget_exceeded";
    error.details = details;
    throw error;
  }
  return details;
}
