import { ContextState } from "./context-state.mjs";
// Thin application adapter. Pi owns the loop, transcript, compression and retry;
// the native gateway owns authorization, effects, durable steps and commits.
import fs from "node:fs/promises";
import path from "node:path";
import { loadPiSdk, UPSTREAM } from "./upstream.mjs";
import { contextBudget, checkRequestBudget, estimateRequestTokens } from "./context-budget.mjs";
import { modelTransport, withModelTransport } from "./model-config.mjs";
import { taskContextExtensions } from "./task-context.mjs";
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
    const { session } = await pi.createAgentSession({
      cwd: directory, agentDir: directory, modelRuntime: runtime,
      model: runtime.getModel("lishi", options.model.id), thinkingLevel: "off",
      noTools: "builtin", tools: tools.map((tool) => tool.name),
      customTools: tools, resourceLoader: resourceLoader(pi, options.systemPrompt, taskContext?.extensions),
      sessionManager: manager, settingsManager: settings,
    });
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
    host.unsubscribe = session.subscribe((event) => {
      if (event.type === "message_update") {
        if (event.assistantMessageEvent?.type?.startsWith("thinking")) return;
        const now = performance.now();
        if (now - lastVisibleUpdate < 100) return;
        lastVisibleUpdate = now;
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
    runtime.streamSimple = (model, context, requestOptions) => {
      this.taskContext?.assertRequest();
      if (this.lastAccountingError) throw this.lastAccountingError;
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
      const delegate = this.nativeFetch ? async (input, init) => {
        await Promise.all(priorWrites);
        if (this.lastAccountingError) throw this.lastAccountingError;
        try { return await this.nativeFetch.fetch(input, init, { onRequest: id => { ids.push(id); this.contextState?.identifyRequest(id,purpose); }, receipts, purpose }); }
        catch (error) { if (error?.name !== "AbortError" && this.requestGeneration === generation) this.lastModelTransportError = error; throw error; }
      } : undefined;
      const stream = withModelTransport(this.transport, () => streamSimple(model, context, boundedOptions), delegate);
      if (this.nativeFetch) {
        const write = stream.result().then(async message => {
          if (message?.stopReason === "error" && this.requestGeneration === generation && !this.lastModelTransportError) {
            const error = new Error("模型服务未完成本次请求，要求与草稿已保留");
            error.code = "model_response_failed"; this.lastModelTransportError = error;
          }
          await this.nativeFetch.recordUsage(ids, message);
        }, () => this.nativeFetch.recordUsage(ids, { stopReason: "error" })).catch(() => {
          const error = new Error("模型用量尚未确认，未重复发送请求");
          error.code = "model_accounting_unconfirmed"; this.lastAccountingError = error;
        });
        this.accountingWrites.add(write);
        void write.finally(() => this.accountingWrites.delete(write));
      }
      return stream;
    };
  }

  registerModel(model) {
    const transport = modelTransport(model);
    const budget = contextBudget(model);
    this.runtime.registerProvider("lishi", {
      api: transport.api, baseUrl: transport.baseUrl, apiKey: model.apiKey,
      models: [providerModel(model, budget)],
    });
    this.transport = transport;
    return budget;
  }

  compactionSettings() {
    return { enabled: true, reserveTokens: this.budget.compactionReserveTokens,
      keepRecentTokens: Math.min(20_000, Math.floor(this.budget.effectiveInputBudgetTokens / 2)) };
  }

  async preflightPrompt(text) {
    const projection = this.manager.buildSessionProjection();
    const incoming = { role: "user", content: [{ type: "text", text }], timestamp: Date.now() };
    const common = { systemPrompt: this.session.systemPrompt || this.options.systemPrompt,
      tools: this.session.agent.state.tools };
    const standalone = estimateRequestTokens(this.pi, { ...common,
      messages: [...projection.messages.filter(message => message.role === "system"), incoming] });
    const projected = estimateRequestTokens(this.pi, { ...common, messages: [...projection.messages, incoming] });
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

  async prompt(text, taskId) {
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
      await this.preflightPrompt(text);
      if (this.promptCancelled) {
        const error = new Error("Task cancelled before the next model request");
        error.code = "aborted"; throw error;
      }
      await this.session.prompt(text);
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
    await this.session.setModel(this.runtime.getModel("lishi", model.id));
    this.options.model = model;
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
