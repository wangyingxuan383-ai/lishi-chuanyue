import { ContextState } from "./context-state.mjs";
// Thin application adapter. Pi owns the loop, transcript, compression and retry;
// the native gateway owns authorization, effects, durable steps and commits.
import fs from "node:fs/promises";
import path from "node:path";
import { loadPiSdk, UPSTREAM } from "./upstream.mjs";
import { contextBudget, checkRequestBudget, estimateRequestTokens, auxModelSpec } from "./context-budget.mjs";
import { modelTransport, withModelTransport } from "./model-config.mjs";
import { taskContextExtensions, coalesceConsecutiveUsers, wrapConvertToLlm } from "./task-context.mjs";
import { NativeModelFetch } from "./model-fetch.mjs";
import { ProgressReview } from "./progress-review.mjs";
import { ReadonlyChildren } from "./children.mjs";
import { createManualCompactControl } from "./manual-compact.mjs";
import { contextReceipts } from "./context-receipts.mjs";
import { createHash } from "node:crypto";

function resourceLoader(pi, systemPrompt, extensions) {
  return {
    getExtensions: () => extensions ?? ({ extensions: [], errors: [], runtime: pi.createExtensionRuntime() }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function hostNameOf(baseUrl) {
  try { return new URL(baseUrl).hostname.toLowerCase(); } catch { return ""; }
}

function classifyGeminiFamily(rawId) {
  const cleanId = String(rawId ?? "").trim().replace(/^models\//iu, "").toLowerCase();
  const isLegacy = /^gemini-(?:1(?:\.\d+)?|2\.0)(?:[-.]|$)/u.test(cleanId);
  const is25Pro = /^gemini-2\.5-pro/u.test(cleanId);
  const is25Flash = /^gemini-2\.5-flash/u.test(cleanId);
  const isLevelFamily = /^gemini-(?:3(?:\.\d+)?|[4-9]|[1-9]\d)(?:[-.]|$)/u.test(cleanId)
    || /^gemma-?4/u.test(cleanId)
    || cleanId === "gemini-flash-latest"
    || cleanId === "gemini-flash-lite-latest";
  return { cleanId, isLegacy, is25Pro, is25Flash, isLevelFamily };
}

function classifyOpenAiFamily(rawId) {
  const leafId = String(rawId ?? "").trim().replace(/^[^/]+\//u, "").toLowerCase();
  const supportsNoneEffort = /^gpt-5\.[1-9]\d*/u.test(leafId) && !/codex/u.test(leafId);
  const isReasoningFamily = supportsNoneEffort || /^(?:o[134](?:[-.]|$)|gpt-5(?:[-.]|$)|codex)/u.test(leafId);
  const isNonReasoningGpt = /^gpt-(?:3\.5|4(?:\.|o|-|$))/u.test(leafId);
  return { leafId, supportsNoneEffort, isReasoningFamily, isNonReasoningGpt };
}

function resolveThinking(model, transport) {
  const mode = model.thinkingMode ?? "off";
  const protocol = transport?.protocol ?? model.protocol ?? "chat-completions";
  const rawId = String(model.id ?? "").trim();
  const hostname = hostNameOf(transport?.baseUrl ?? model.baseUrl ?? "");
  const isOfficialOpenAI = hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");

  if (protocol === "gemini") {
    const { cleanId, isLegacy, is25Pro, is25Flash, isLevelFamily } = classifyGeminiFamily(rawId);
    if (isLegacy || mode === "default") {
      return { mode, reasoning: false, thinkingLevel: "off", thinkingLevelMap: { off: null } };
    }
    if (mode === "deep") {
      return { mode, reasoning: true, thinkingLevel: "high", ...(isLevelFamily ? { thinkingLevelMap: { off: null } } : {}) };
    }
    if (is25Flash) return { mode: "off", reasoning: true, thinkingLevel: "off" };
    if (is25Pro) return { mode: "off", reasoning: true, thinkingLevel: "minimal", thinkingLevelMap: { off: null } };
    if (isLevelFamily) return { mode: "off", reasoning: true, thinkingLevel: /flash/u.test(cleanId) ? "minimal" : "low", thinkingLevelMap: { off: null } };
    return { mode: "off", reasoning: false, thinkingLevel: "off", thinkingLevelMap: { off: null } };
  }

  if (protocol === "openai-responses") {
    const { supportsNoneEffort, isReasoningFamily, isNonReasoningGpt } = classifyOpenAiFamily(rawId);
    if (mode === "default") return { mode, reasoning: Boolean(model.reasoning), thinkingLevel: "off", thinkingLevelMap: { off: null } };
    if (mode === "deep") {
      if (isNonReasoningGpt) return { mode, reasoning: false, thinkingLevel: "off", thinkingLevelMap: { off: null } };
      return { mode, reasoning: true, thinkingLevel: "high", thinkingLevelMap: supportsNoneEffort ? { off: "none" } : { off: "low" } };
    }
    if (supportsNoneEffort) return { mode: "off", reasoning: true, thinkingLevel: "off", thinkingLevelMap: { off: "none" } };
    if (isReasoningFamily) return { mode: "off", reasoning: true, thinkingLevel: "off", thinkingLevelMap: { off: "low" } };
    return { mode: "off", reasoning: false, thinkingLevel: "off", thinkingLevelMap: { off: null } };
  }

  if (protocol === "anthropic") {
    if (mode === "deep") return { mode: "deep", reasoning: true, thinkingLevel: "high", thinkingLevelMap: { off: null } };
    return { mode, reasoning: false, thinkingLevel: "off", thinkingLevelMap: { off: null } };
  }

  // chat-completions
  const needsReasoningContent = /deepseek-reasoner|deepseek-r1|kimi-k2-thinking/iu.test(rawId);
  const baseCompat = isOfficialOpenAI ? {} : {
    supportsStore: false,
    supportsDeveloperRole: false,
    maxTokensField: "max_tokens",
    supportsReasoningEffort: false,
    ...(needsReasoningContent ? { requiresReasoningContentOnAssistantMessages: true } : {}),
  };
  const compat = { ...baseCompat, ...(model.compat ?? {}) };
  if (isOfficialOpenAI) {
    const { supportsNoneEffort, isReasoningFamily, isNonReasoningGpt } = classifyOpenAiFamily(rawId);
    compat.supportsReasoningEffort = model.compat?.supportsReasoningEffort ?? true;
    if (mode === "default") return { mode, reasoning: false, thinkingLevel: "off", compat, thinkingLevelMap: { off: null } };
    if (mode === "deep") {
      return isNonReasoningGpt
        ? { mode, reasoning: false, thinkingLevel: "off", compat, thinkingLevelMap: { off: null } }
        : { mode, reasoning: true, thinkingLevel: "high", compat };
    }
    if (supportsNoneEffort) return { mode: "off", reasoning: true, thinkingLevel: "off", compat, thinkingLevelMap: { off: "none" } };
    if (isReasoningFamily) return { mode: "off", reasoning: true, thinkingLevel: "off", compat, thinkingLevelMap: { off: "low" } };
    return { mode: "off", reasoning: false, thinkingLevel: "off", compat, thinkingLevelMap: { off: null } };
  }
  return {
    mode,
    reasoning: mode === "deep" || needsReasoningContent || Boolean(model.compat) || model.reasoning === true,
    thinkingLevel: mode === "deep" ? "high" : "off",
    compat,
  };
}

function adaptProviderPayload(params, spec, transport, budget, estimatedInputTokens) {
  if (!params || typeof params !== "object") return params;
  const protocol = transport.protocol;
  const mode = spec.thinkingMode ?? "off";
  const rawId = String(spec.id ?? "").trim();

  if (protocol === "gemini") {
    const { cleanId, isLegacy, is25Pro, is25Flash, isLevelFamily } = classifyGeminiFamily(rawId);
    params.config = { ...(params.config ?? {}) };
    if (isLegacy || mode === "default") {
      delete params.config.thinkingConfig;
    } else if (mode === "off") {
      if (is25Flash) params.config.thinkingConfig = { thinkingBudget: 0 };
      else if (is25Pro) params.config.thinkingConfig = { thinkingBudget: 128 };
      else if (isLevelFamily) params.config.thinkingConfig = { thinkingLevel: /flash/u.test(cleanId) ? "MINIMAL" : "LOW" };
      else delete params.config.thinkingConfig;
    } else if (mode === "deep") {
      if (isLevelFamily) params.config.thinkingConfig = { includeThoughts: true, thinkingLevel: "HIGH" };
      else if (is25Pro) params.config.thinkingConfig = { includeThoughts: true, thinkingBudget: 32768 };
      else if (is25Flash) params.config.thinkingConfig = { includeThoughts: true, thinkingBudget: 24576 };
    }
    return params;
  }

  if (protocol === "openai-responses") {
    const { supportsNoneEffort, isReasoningFamily, isNonReasoningGpt } = classifyOpenAiFamily(rawId);
    if (mode === "default") {
      delete params.reasoning;
      delete params.include;
    } else if (mode === "off") {
      if (supportsNoneEffort) { params.reasoning = { effort: "none" }; delete params.include; }
      else if (isReasoningFamily) { params.reasoning = { effort: "low" }; delete params.include; }
      else { delete params.reasoning; delete params.include; }
    } else if (mode === "deep") {
      if (isNonReasoningGpt) { delete params.reasoning; delete params.include; }
      else {
        params.reasoning = { effort: "high", summary: params.reasoning?.summary || "auto" };
        params.include = ["reasoning.encrypted_content"];
      }
    }
    return params;
  }

  if (protocol === "anthropic") {
    if (mode !== "deep") {
      delete params.thinking;
      delete params.output_config;
      if (Array.isArray(params.betas)) {
        params.betas = params.betas.filter(beta => !String(beta).startsWith("interleaved-thinking-"));
        if (!params.betas.length) delete params.betas;
      }
    } else {
      const maxAvailableOutput = Math.max(0, budget.runtimeContextWindowTokens - estimatedInputTokens);
      if (maxAvailableOutput < 3072) {
        delete params.thinking;
        delete params.output_config;
        params.max_tokens = Math.max(1, Math.min(params.max_tokens ?? budget.outputReserveTokens, maxAvailableOutput || budget.outputReserveTokens));
      } else {
        const configuredMax = Math.min(maxAvailableOutput, Math.max(3072, budget.outputReserveTokens));
        const desiredBudget = Math.min(16384, Math.max(1024, configuredMax - 2048));
        const finalMaxTokens = Math.min(maxAvailableOutput, Math.max(configuredMax, desiredBudget + 2048));
        const finalBudgetTokens = Math.max(1024, Math.min(desiredBudget, finalMaxTokens - 2048));
        params.max_tokens = finalMaxTokens;
        params.thinking = {
          ...(params.thinking?.type === "enabled" ? params.thinking : { type: "enabled", display: "summarized" }),
          type: "enabled",
          budget_tokens: finalBudgetTokens,
        };
        delete params.temperature;
      }
    }
    return params;
  }

  // chat-completions
  const hostname = hostNameOf(transport.baseUrl);
  const isOfficialOpenAI = hostname === "api.openai.com" || hostname.endsWith(".api.openai.com");
  const leafId = rawId.replace(/^[^/]+\//u, "").toLowerCase();
  if (!isOfficialOpenAI) {
    if (spec.compat?.supportsStore !== true) delete params.store;
    if (params.max_completion_tokens !== undefined && spec.compat?.maxTokensField !== "max_completion_tokens") {
      params.max_tokens = params.max_tokens ?? params.max_completion_tokens;
      delete params.max_completion_tokens;
    }
    if (Array.isArray(params.messages) && spec.compat?.supportsDeveloperRole !== true) {
      for (const msg of params.messages) {
        if (msg?.role === "developer") msg.role = "system";
      }
    }
    const needsReasoningContent = /deepseek-reasoner|deepseek-r1|kimi-k2-thinking/iu.test(rawId)
      || (Array.isArray(params.messages) && params.messages.some(msg => msg?.role === "assistant" && typeof msg.reasoning_content === "string"));
    if (needsReasoningContent && Array.isArray(params.messages)) {
      for (const msg of params.messages) {
        if (msg?.role === "assistant" && msg.reasoning_content === undefined) {
          msg.reasoning_content = "";
        }
      }
    }
    if (!spec.compat?.thinkingFormat) {
      delete params.thinking;
      delete params.enable_thinking;
      delete params.reasoning;
    }
    if (!spec.compat?.supportsReasoningEffort) {
      delete params.reasoning_effort;
    }
    if (mode !== "default" && !spec.compat?.thinkingFormat) {
      const isOpenRouter = hostname === "openrouter.ai" || hostname.endsWith(".openrouter.ai");
      const isDeepSeekHost = hostname === "api.deepseek.com" || hostname.endsWith(".deepseek.com");
      const isDashScope = hostname.includes("dashscope.aliyuncs.com");
      const isZhipuHost = hostname.includes("open.bigmodel.cn") || hostname.includes("api.z.ai");
      const isQwenHybrid = /^qwen3(?!.*-instruct)/u.test(leafId) || (isDashScope && /^qwen-(?:plus|turbo|flash)/u.test(leafId));
      const isGlmThinking = /^glm-(?:4\.[5-9]|5|z1)/u.test(leafId)
        || (isZhipuHost && /^glm-/u.test(leafId) && !/^glm-(?:3|4-(?:flash|air|plus|0520|9b|long))/u.test(leafId));
      const isDoubaoThinking = /^doubao-(?:seed|1[-.]5-thinking)/u.test(leafId);
      if (isOpenRouter) {
        params.reasoning = mode === "deep" ? { effort: "high" } : { enabled: false };
      } else if (isDeepSeekHost && /^deepseek-(?:chat|reasoner|v3)/u.test(leafId)) {
        params.thinking = { type: mode === "deep" ? "enabled" : "disabled" };
      } else if (isQwenHybrid) {
        params.enable_thinking = mode === "deep";
      } else if (isGlmThinking) {
        if (mode === "deep") params.thinking = { type: "enabled" };
        else if (!/^glm-z1/u.test(leafId)) params.thinking = { type: "disabled" };
      } else if (isDoubaoThinking) {
        if (mode === "deep") params.thinking = { type: "enabled" };
        else if (/seed/u.test(leafId)) params.thinking = { type: "disabled" };
      }
    }
  }
  return params;
}

function providerModel(model, budget) {
  const cost = model.cost ?? {};
  for (const name of ["input", "output", "cacheRead", "cacheWrite"]) {
    if (cost[name] !== undefined && (!Number.isFinite(cost[name]) || cost[name] < 0)) throw new Error("Invalid configured model price");
  }
  return {
    id: model.id, name: model.name ?? model.id, reasoning: model.reasoning ?? false,
    input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, ...cost },
    // Preserve model capacity for Pi's provider output fitting. The APP cap
    // is enforced by Pi's compaction reserve and the public request guard.
    contextWindow: budget.runtimeContextWindowTokens,
    maxTokens: budget.outputReserveTokens,
    ...(model.compat ? { compat: model.compat } : {}),
    ...(model.thinkingLevelMap ? { thinkingLevelMap: model.thinkingLevelMap } : {}),
  };
}

export class PiHost {
  static async create(options) {
    if (options.nativeModelHttp === true && typeof options.invokeModelHttp !== "function") throw new Error("Native model HTTP host is required");
    const pi = await loadPiSdk();
    const directory = path.resolve(options.directory);
    await fs.mkdir(directory, { recursive: true });
    const runtime = await pi.ModelRuntime.create({
      credentials: new pi.InMemoryCredentialStore(), modelsPath: null,
      allowModelNetwork: false, refreshOnCreate: false,
    });
    const host = new PiHost(options, runtime, pi);
    host.budget = host.registerModel(options.model);
    const manager = options.sessionFile
      ? pi.SessionManager.open(options.sessionFile, path.join(directory, "sessions"), directory)
      : pi.SessionManager.create(directory, path.join(directory, "sessions"));
    const tools = (options.tools ?? []).map((tool) => ({
      name: tool.name, label: tool.label ?? tool.name, description: tool.description,
      parameters: tool.parameters,
      executionMode: tool.readOnly ? "parallel" : "sequential",
      execute: async (toolCallId, args, signal, onUpdate) => {
        // A tool can commit a story. Confirm the request that produced it
        // before entering the native side-effect gateway.
        await Promise.all([...host.accountingWrites]);
        host.assertRequestErrors();
        const request = {
          sessionId: manager.getSessionId(), taskId: host.taskId, toolCallId,
          name: tool.name, args,
        };
        const result = tool.name === "delegate_readonly" && !options.readonlyChild
          ? await host.children.delegate(request, { signal, onUpdate })
          : await options.invokeTool(request, { signal, onUpdate });
        const value = result ?? { ok: false, error: { code: "invalid_tool_result", message: "Native tool returned no result" } };
        if (tool.name === "ask_user" && value.ok === true && value.data?.waitingForUser === true) host.waitingForUser = true;
        const loadout = value.toolLoadout ?? value.data?.enabledTools;
        if (tool.name === "discover_tools" && value.ok === true && Array.isArray(loadout)) {
          // Pi's public loadout API keeps complete tool groups and owns the
          // next model turn. Discovery may add, never discard, valid tools.
          const known = new Set((options.tools ?? []).map(item => item.name));
          host.session.setActiveToolsByName([...new Set([...host.session.getActiveToolNames(),
            ...loadout.filter(name => known.has(name))])]);
        }
        return {
          // Pi's structuredContent is for the UI only. The complete bounded
          // native result (or its read-back locator) must reach the model too.
          content: [{ type: "text", text: JSON.stringify(value) }],
          details: value,
          structuredContent: value.ok === true ? value.data : value.error,
          isError: value.ok !== true,
        };
      },
    }));
    const settings = pi.SettingsManager.inMemory({
      enableInstallTelemetry: false, enableAnalytics: false,
      cacheWarming: "off",
      compaction: host.compactionSettings(),
      retry: { enabled: true, maxRetries: 2, provider: { maxRetries: 0 } },
    });
    const taskContext = await taskContextExtensions(pi, {
      enabled: options.taskContext === true, directory, settingsManager: settings,
      getTaskId: () => host.taskId, getTaskState: async controls => {
        let result=await options.getTaskState(controls);
        if(result?.data?.reviewRequest && !options.readonlyChild && !options.reviewSession) {
          await host.progressReview.run(result.data.reviewRequest,controls);
          result=await options.getTaskState(controls);
        }
        return result;
      },
      onError: error => { host.lastContextError = error; },
    });
    host.taskContext = taskContext?.context;
    host.progressReview = new ProgressReview(host, options=>PiHost.create(options));
    const mainModelId = typeof options.model.id === "string" ? options.model.id.trim() : options.model.id;
    const { session } = await pi.createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime: runtime,
      model: runtime.getModel("lishi", mainModelId), thinkingLevel: host.thinkingLevel ?? "off",
      noTools: "builtin", tools: tools.map((tool) => tool.name),
      customTools: tools, resourceLoader: resourceLoader(pi, options.systemPrompt, taskContext?.extensions),
      sessionManager: manager, settingsManager: settings,
    });
    if (typeof session.agent?.convertToLlm === "function") {
      session.agent.convertToLlm = wrapConvertToLlm(session.agent.convertToLlm.bind(session.agent));
    }
    host.session = session;
    host.children = new ReadonlyChildren(host, options => PiHost.create(options));
    host.manualCompact = createManualCompactControl({
      getSession: () => host.session,
      isRunning: () => !!host.activePrompt || session.isStreaming || session.isCompacting,
      abort: () => host.abort(),
      waitForIdle: async () => { await session.waitForIdle(); await host.promptDone; },
      assertAvailable: ({ phase }) => {
        if (host.closed) throw new Error("The Pi session is closed");
        if (phase === "compacting") host.clearRequestErrors();
      },
      afterCompact: async () => { await Promise.all([...host.accountingWrites]); host.assertRequestErrors(); },
    });
    const finishTurn = session.agent.finishTurn;
    session.agent.finishTurn = async (turn, signal) => host.manualCompact.withTurnBoundary(async () => {
      // Public Pi turn boundary, after every result in the tool group is
      // persisted. Keep AgentSession's extension processing, then end this
      // run while the native question waits. No extra provider request and
      // no synthetic aborted assistant message are needed.
      const decision = await finishTurn?.(turn, signal);
      return host.waitingForUser ? { action: "end" } : decision;
    });
    if (Array.isArray(options.activeTools)) session.setActiveToolsByName(options.activeTools);
    host.settings = settings;
    host.manager = manager;
    host.contextState = new ContextState(host);
    if (options.nativeModelHttp === true) host.nativeFetch = new NativeModelFetch(options.invokeModelHttp);
    let lastVisibleUpdate = -Infinity;
    let thinkingActive = false;
    let lastThinkingUpdate = -Infinity;
    host.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        const kind = event.assistantMessageEvent?.type;
        if (kind?.startsWith("thinking")) {
          const now = performance.now();
          if (!thinkingActive || now - lastThinkingUpdate >= 1500) {
            thinkingActive = true;
            lastThinkingUpdate = now;
            options.onEvent?.({
              sessionId: session.sessionId,
              taskId: host.taskId,
              event: { type: "thinking_status", active: true, attemptId: options.nativeAttempt },
            });
          }
          return;
        }
        if (thinkingActive && (kind === "text_start" || kind === "text_delta" || kind === "toolcall_start")) {
          thinkingActive = false;
          options.onEvent?.({
            sessionId: session.sessionId,
            taskId: host.taskId,
            event: { type: "thinking_status", active: false, attemptId: options.nativeAttempt },
          });
        }
        const now = performance.now();
        if (now - lastVisibleUpdate < 100) return;
        lastVisibleUpdate = now;
      }
      if (event.type === "message_end" && thinkingActive) {
        thinkingActive = false;
        options.onEvent?.({
          sessionId: session.sessionId,
          taskId: host.taskId,
          event: { type: "thinking_status", active: false, attemptId: options.nativeAttempt },
        });
      }
      if (["message_end","tool_execution_end","turn_end","compaction_start","compaction_end"].includes(event.type)) {
        if(event.type==="message_end"&&event.message?.role==="assistant")host.contextState.response(event.message,"model");
        queueMicrotask(()=>event.type==="compaction_end"?host.contextState.compacted():host.contextState.emit());
      }
      // Final message/tool transitions are never throttled. Pi retains its
      // full stream; this subscriber only feeds the durable UI projection.
      options.onEvent?.({ sessionId: session.sessionId, taskId: host.taskId, event });
      if (event.type === "message_end" && ["user", "assistant"].includes(event.message?.role)) {
        // AgentSession emits before its synchronous appendMessage. Read its
        // public manager after that boundary; never manufacture an entry ID.
        const message = event.message, taskId = host.taskId;
        queueMicrotask(() => {
          const entry = manager.getEntries().findLast(item => item.type === "message" && item.message === message);
          if (!entry || !taskId) return;
          const key = typeof message.id === "string" ? `id:${message.id}`
            : Number.isSafeInteger(message.timestamp) ? `at:${message.timestamp}` : "";
          const text = typeof message.content === "string" ? message.content
            : Array.isArray(message.content) && message.content.every(part => part.type === "text")
              ? message.content.map(part => part.text).join("") : null;
          options.onEvent?.({ sessionId: session.sessionId, taskId,
            event: { type: "message_anchor", role: message.role, entryId: entry.id, messageKey: key,
              ...(message.role === "user" && text !== null ? { userHash: createHash("sha256").update(text).digest("hex") } : {}) } });
        });
      }
    });
    return host;
  }

  constructor(options, runtime, pi) {
    this.options = options;
    this.runtime = runtime;
    this.pi = pi;
    this.taskId = null;
    this.accountingWrites = new Set();
    const streamSimple = runtime.streamSimple.bind(runtime);
    // Guard the public request boundary, after Pi has prepared/compacted its
    // own transcript. completeSimple and summarization use this same method.
    runtime.streamSimple = (model, rawContext, requestOptions) => {
      this.taskContext?.assertRequest();
      if (this.lastAccountingError) throw this.lastAccountingError;
      const context = Array.isArray(rawContext?.messages)
        ? { ...rawContext, messages: coalesceConsecutiveUsers(rawContext.messages) }
        : rawContext;
      const generation = this.requestGeneration = (this.requestGeneration ?? 0) + 1;
      const priorWrites = [...this.accountingWrites];
      this.lastModelTransportError = undefined;
      const requestedMax = requestOptions?.maxTokens ?? this.budget.outputReserveTokens;
      if (!Number.isSafeInteger(requestedMax) || requestedMax <= 0) {
        const error = new Error("The requested output limit must be a positive safe integer");
        error.code = "invalid_output_budget"; throw error;
      }
      const boundedOptions = { ...requestOptions, maxTokens: Math.min(requestedMax, this.budget.outputReserveTokens) };
      try {
        this.lastRequestBudget = checkRequestBudget(pi, this.budget, context, boundedOptions);
        this.lastBudgetError = undefined;
      } catch (error) {
        if (error.details) this.lastRequestBudget = error.details;
        this.lastBudgetError = error;
        throw error;
      }
      const ids = [];
      const receipts = contextReceipts(context.messages ?? [], { actorId: this.options.nativeActor });
      const purpose = this.options.reviewSession ? "progress_review" : this.manualCompact?.active || this.session?.isCompacting ? "compaction" : "model";
      this.contextState?.request(this.lastRequestBudget,purpose);
      const useAuxForPurpose = purpose === "compaction" && Boolean(
        this.auxModelId && this.auxTransport && this.auxBudget
        && this.lastRequestBudget.estimatedInputTokens <= this.auxBudget.effectiveInputBudgetTokens,
      );
      const effectiveModel = useAuxForPurpose ? (this.runtime.getModel("lishi", this.auxModelId) ?? model) : model;
      const effectiveSpec = useAuxForPurpose ? this.auxSpec : this.modelSpec;
      const effectiveBudget = useAuxForPurpose ? this.auxBudget : this.budget;
      const effectiveTransport = useAuxForPurpose ? this.auxTransport : this.transport;
      const callerOnPayload = requestOptions?.onPayload;
      const onPayload = async (params, payloadModel) => {
        const modified = callerOnPayload ? await callerOnPayload(params, payloadModel) : undefined;
        return adaptProviderPayload(
          modified !== undefined ? modified : params,
          effectiveSpec,
          effectiveTransport,
          effectiveBudget,
          this.lastRequestBudget.estimatedInputTokens,
        );
      };
      const effectiveOptions = useAuxForPurpose
        ? { ...boundedOptions, maxTokens: Math.min(boundedOptions.maxTokens, effectiveBudget.outputReserveTokens), reasoning: undefined, onPayload }
        : { ...boundedOptions, onPayload };
      const delegate = this.nativeFetch ? async (input, init) => {
        await Promise.all(priorWrites);
        if (this.lastAccountingError) throw this.lastAccountingError;
        try {
          return await this.nativeFetch.fetch(input, init, {
            onRequest: id => { ids.push(id); this.contextState?.identifyRequest(id,purpose); },
            receipts,
            purpose,
            model: effectiveModel.id,
          });
        } catch (error) {
          if (error?.name !== "AbortError" && this.requestGeneration === generation) this.lastModelTransportError = error;
          throw error;
        }
      } : undefined;
      const stream = withModelTransport(effectiveTransport, () => streamSimple(effectiveModel, context, effectiveOptions), delegate);
      if (this.nativeFetch) {
        const write = stream.result().then(async message => {
          if (message?.stopReason === "error" && this.requestGeneration === generation && !this.lastModelTransportError) {
            const overflow = /context_length_exceeded|maximum context length|exceeds the context window|上下文窗口/i.test(message.errorMessage ?? "");
            const error = new Error(overflow ? "AI 服务报告模型上下文窗口不足，要求与草稿已保留" : "模型服务未完成本次请求，要求与草稿已保留");
            error.code = overflow ? "model_context_window" : "model_response_failed";
            this.lastModelTransportError = error;
          }
          await this.nativeFetch.recordUsage(ids, message ? { ...message, model: message.model ?? effectiveModel.id } : message);
        }, () => this.nativeFetch.recordUsage(ids, { stopReason: "error", model: effectiveModel.id })).catch(() => {
          const error = new Error("模型用量尚未确认，未重复发送请求");
          error.code = "model_accounting_unconfirmed"; this.lastAccountingError = error;
        });
        this.accountingWrites.add(write);
        void write.finally(() => this.accountingWrites.delete(write));
      }
      return stream;
    };
  }

  registerModel(rawModel) {
    const model = { ...rawModel, id: typeof rawModel.id === "string" ? rawModel.id.trim() : rawModel.id };
    const transport = modelTransport(model);
    const budget = contextBudget(model);
    const thinking = resolveThinking(model, transport);
    const models = [providerModel({
      ...model,
      reasoning: thinking.reasoning,
      ...(thinking.compat ? { compat: thinking.compat } : {}),
      ...(thinking.thinkingLevelMap ? { thinkingLevelMap: thinking.thinkingLevelMap } : {}),
    }, budget)];
    this.modelSpec = model;
    this.auxModelId = null;
    this.auxSpec = null;
    this.auxBudget = null;
    this.auxTransport = null;
    const auxSpec = auxModelSpec(model);
    if (auxSpec) {
      const auxTransport = modelTransport(auxSpec);
      const auxBudget = contextBudget(auxSpec);
      const auxThinking = resolveThinking(auxSpec, auxTransport);
      models.push(providerModel({
        ...auxSpec,
        reasoning: auxThinking.reasoning,
        ...(auxThinking.compat ? { compat: auxThinking.compat } : {}),
        ...(auxThinking.thinkingLevelMap ? { thinkingLevelMap: auxThinking.thinkingLevelMap } : {}),
      }, auxBudget));
      this.auxModelId = auxSpec.id;
      this.auxSpec = auxSpec;
      this.auxBudget = auxBudget;
      this.auxTransport = auxTransport;
    }
    this.runtime.registerProvider("lishi", {
      api: transport.api, baseUrl: transport.baseUrl, apiKey: model.apiKey,
      models,
    });
    this.transport = transport;
    this.thinkingLevel = thinking.thinkingLevel;
    return budget;
  }

  compactionSettings() {
    return { enabled: true, reserveTokens: this.budget.compactionReserveTokens,
      keepRecentTokens: Math.min(20_000, Math.floor(this.budget.effectiveInputBudgetTokens / 2)) };
  }

  async preflightPrompt(text) {
    const projection = this.manager.buildSessionProjection();
    const hasText = typeof text === "string" && text.length > 0;
    const incoming = hasText ? { role: "user", content: [{ type: "text", text }], timestamp: Date.now() } : null;
    const common = { systemPrompt: this.session.systemPrompt || this.options.systemPrompt,
      tools: this.session.agent.state.tools };
    const standalone = estimateRequestTokens(this.pi, { ...common,
      messages: [...projection.messages.filter(message => message.role === "system"), ...(incoming ? [incoming] : [])] });
    const projected = estimateRequestTokens(this.pi, { ...common,
      messages: incoming ? [...projection.messages, incoming] : projection.messages });
    this.preflightCompaction = null;
    if (standalone > this.budget.effectiveInputBudgetTokens || projected <= this.budget.effectiveInputBudgetTokens) return;
    const settings = this.settings.getCompactionSettings(this.session.model);
    const keepRecentTokens = Math.min(settings.keepRecentTokens,
      Math.floor((this.budget.effectiveInputBudgetTokens - standalone) / 2));
    // Let Pi select complete message/tool groups and write its own checkpoint.
    // Only one preflight attempt is made; a still-large request hits the guard.
    this.settings.applyOverrides({ compaction: { keepRecentTokens } });
    try {
      await this.session.compact();
      this.preflightCompaction = { attempted: true, ok: true };
    } catch (error) {
      this.preflightCompaction = { attempted: true, ok: false,
        error: { code: error.code ?? "compaction_failed", message: error.message } };
    } finally {
      this.settings.applyOverrides({ compaction: { keepRecentTokens: settings.keepRecentTokens } });
    }
  }

  async continueSession() {
    const session = this.session;
    if (session._isEmittingAgentSettled) {
      return new Promise((resolve, reject) => {
        session._deferredSettledActions.push(() => this.continueSession().then(resolve, reject));
      });
    }
    if (session._compactionAbortController !== undefined) {
      throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
    }
    if (!session.model) throw new Error("No model selected");
    session._isAgentRunActive = true;
    session._agentRunAbortRequested = false;
    try {
      session._refreshFinalizedContext?.();
      const lastAssistant = session._findLastAssistantMessage?.();
      if (lastAssistant) await session._checkCompaction?.(lastAssistant, false);
      const baseOpts = session._baseSystemPromptOptions;
      if (baseOpts) {
        const selectedToolsBefore = baseOpts.selectedTools;
        const result = session._extensionRunner
          ? await session._extensionRunner.emitBeforeAgentStart({ messageType: "user", prompt: "" }, baseOpts)
          : { messages: [], systemPromptOptions: { ...baseOpts } };
        if (
          result.systemPromptOptions.selectedTools.length === selectedToolsBefore.length
          && !result.systemPromptOptions.selectedTools.some((name, idx) => name !== selectedToolsBefore[idx])
        ) {
          result.systemPromptOptions.selectedTools = session.getActiveToolNames();
        }
        const updateMessage = session._preparePromptAndToolLoadout?.(result.systemPromptOptions);
        session._runSystemPromptOptions = result.systemPromptOptions;
        if (updateMessage) {
          const entryId = session.sessionManager.appendMessage(updateMessage);
          if (entryId) session._entryIdsByMessage?.set(updateMessage, entryId);
        }
        if (Array.isArray(session._pendingNextTurnMessages) && session._pendingNextTurnMessages.length) {
          for (const msg of session._pendingNextTurnMessages.splice(0)) {
            const entryId = session.sessionManager.appendMessage(msg);
            if (entryId) session._entryIdsByMessage?.set(msg, entryId);
          }
        }
        for (const msg of result.messages ?? []) {
          session.sessionManager.appendCustomMessageEntry(msg.customType, msg.content ?? [], msg.display, msg.details);
        }
        session._refreshFinalizedContext?.();
      }
    } catch (error) {
      session._isAgentRunActive = false;
      session._flushPendingBashMessages?.();
      session._flushPendingCustomMessages?.();
      session._resolveIdleWaitIfIdle?.();
      throw error;
    }
    session._flushPendingBashMessages?.();
    session._flushPendingCustomMessages?.();
    session._failedResponse = undefined;
    session._recordSelection?.();
    session._pendingToolNames?.clear?.();
    try {
      await session.agent.continue();
      while (!session._agentRunAbortRequested) {
        if (await session._handlePostAgentRun()) {
          if (session._agentRunAbortRequested) break;
          await session.agent.continue();
          continue;
        }
        if (session._agentRunAbortRequested || !(await session._runBeforeSettleBoundary()) || session._agentRunAbortRequested) {
          break;
        }
        await session.agent.continue();
      }
    } finally {
      if (session._agentRunAbortRequested) session._finishCancelledRetry?.();
      session._failedResponse = undefined;
      session._runSystemPromptOptions = undefined;
      session._flushPendingBashMessages?.();
      session._flushPendingCustomMessages?.();
      await session._emitAgentSettled?.();
    }
  }

  async prompt(text, taskId, { resume = false } = {}) {
    this.manualCompact.assertCanPrompt();
    if (this.activePrompt || this.session.isStreaming) throw new Error("Use steer or followUp while a task is running");
    this.activePrompt = true;
    this.promptDone = new Promise(resolve => { this.resolvePromptDone = resolve; });
    this.promptCancelled = false;
    this.taskId = taskId;
    this.lastBudgetError = undefined;
    this.lastModelTransportError = undefined;
    this.lastAccountingError = undefined;
    this.waitingForUser = false;
    try {
      const hasText = typeof text === "string" && text.length > 0;
      const tailRole = this.manager.buildSessionProjection().messages.findLast(message => message.role !== "system")?.role;
      const canContinueDirectly = resume && !hasText
        && (tailRole === "user" || tailRole === "toolResult")
        && typeof this.session.agent?.continue === "function";
      const effectiveText = canContinueDirectly
        ? ""
        : (hasText ? text : "请接着上次中断处继续完成当前任务，不要重复已完成的工作，并核对最新草稿与状态。");
      await this.preflightPrompt(effectiveText);
      if (this.promptCancelled) {
        const error = new Error("Task cancelled before the next model request");
        error.code = "aborted"; throw error;
      }
      if (canContinueDirectly) {
        await this.continueSession();
      } else {
        await this.session.prompt(effectiveText);
      }
      await Promise.all([...this.accountingWrites]);
      if (this.promptCancelled) {
        const error = new Error("本次执行已停止，任务与草稿已保留");
        error.code = "aborted"; throw error;
      }
      // Pi persists its own failed response. Expose the actionable budget error
      // to the native caller too; an ended loop is not a successful request.
      if (this.lastContextError) throw this.lastContextError;
      if (this.lastBudgetError) throw this.lastBudgetError;
      if (this.lastModelTransportError) throw this.lastModelTransportError;
      if (this.lastAccountingError) throw this.lastAccountingError;
      return { text: this.session.getLastAssistantText() ?? "", ...this.inspect(), streaming: false, waitingForUser: this.waitingForUser };
    } finally { this.activePrompt = false; this.resolvePromptDone?.(); }
  }
  async steer(text) { await this.session.steer(text); await this.children.stop();
    await this.progressReview?.stop(); }
  async followUp(text) { await this.session.followUp(text); }
  async abort() { this.promptCancelled = true; await this.children?.stop(); await this.progressReview?.stop(); await this.session.abort(); }
  clearRequestErrors() {
    this.lastContextError = this.lastBudgetError = this.lastModelTransportError = this.lastAccountingError = undefined;
  }
  assertRequestErrors() {
    for (const error of [this.lastContextError, this.lastBudgetError, this.lastModelTransportError, this.lastAccountingError]) if (error) throw error;
  }
  async compact(instructions, taskId) {
    if (taskId && this.activePrompt && taskId !== this.taskId) throw new Error("Cannot compact another running task");
    if (taskId) this.taskId = taskId;
    const result = await this.manualCompact.compact(instructions ?? undefined);
    return { firstKeptEntryId: result?.firstKeptEntryId ?? null, tokensBefore: result?.tokensBefore ?? null,
      summaryChars: result?.summary?.length ?? 0, ...this.inspect() };
  }
  async setModel(model) {
    this.manualCompact.assertCanPrompt();
    if (this.activePrompt || this.session.isStreaming) throw new Error("Cannot switch a running task's model");
    const budget = this.registerModel(model);
    const nextId = typeof model.id === "string" ? model.id.trim() : model.id;
    await this.session.setModel(this.runtime.getModel("lishi", nextId));
    if (typeof this.session.setThinkingLevel === "function") this.session.setThinkingLevel(this.thinkingLevel ?? "off");
    this.options.model = { ...model, id: nextId };
    this.budget = budget;
    this.settings.applyOverrides({ compaction: this.compactionSettings() });
  }
  inspect() {
    return {
      engine: "pi", upstream: UPSTREAM,
      sessionId: this.session.sessionId, sessionFile: this.manager.getSessionFile(),
      tools: this.session.getActiveToolNames(), streaming: !!this.activePrompt || this.session.isStreaming,
      model: this.session.model?.id, messageCount: this.session.messages.length,
      modelWindowConfigured: this.budget.modelContextWindowTokens !== null,
      modelWindowSource: this.budget.modelContextWindowTokens === null ? "unknown" : "configured",
      modelWindowVerified: false,
      priceKnown: ["input", "output", "cacheRead", "cacheWrite"].every((key) => this.options.model.cost?.[key] !== undefined),
      ...this.budget,
      lastRequestBudget: this.lastRequestBudget ?? null,
      preflightCompaction: this.preflightCompaction ?? null,
    };
  }
  async close() {
    this.closed = true;
    await this.abort();
    await this.nativeFetch?.close();
    await Promise.all([...this.accountingWrites]);
    this.unsubscribe?.();
    this.session.dispose();
  }
}
