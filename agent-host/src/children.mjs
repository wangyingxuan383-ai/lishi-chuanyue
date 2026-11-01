// Restricted full Pi sessions, not an application-owned model loop. Native
// authority and the root ledger are checked for every read and model request.
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";

export function childCallId(childId, original) {
  return `child-${childId}-${createHash("sha256").update(JSON.stringify({ id: original })).digest("hex")}`;
}
const clipped = text => Array.from(text ?? "").slice(0, 16_000).join("");

export class ReadonlyChildren {
  constructor(root, createHost) { this.root = root; this.createHost = createHost; this.live = new Map(); }

  async delegate(request, options = {}) {
    if (this.root.options.readonlyChild) throw new Error("Readonly children cannot delegate");
    const prepared = await this.root.options.invokeTool(request, options);
    if (prepared?.ok !== true || !Array.isArray(prepared.data?.children)) return prepared;
    const children = prepared.data.children;
    if (children.length < 1 || children.length > 2 || this.live.size + children.length > 2) throw new Error("Invalid readonly child allocation");
    const tools = prepared.data.tools;
    if (!Array.isArray(tools) || tools.some(tool => tool.readOnly !== true || ["delegate_readonly", "run_script", "finish_task"].includes(tool.name))) throw new Error("Invalid readonly tool catalog");
    const stop = () => { void this.stop(); };
    options.signal?.addEventListener("abort", stop, { once: true });
    try {
      await Promise.allSettled(children.map(child => this.run(child, tools, request, options.signal)));
      if (options.signal?.aborted) throw new Error("Readonly delegation cancelled");
      return await this.root.options.invokeTool({ sessionId: request.sessionId, taskId: request.taskId,
        toolCallId: `control-${randomUUID()}`, name: "__children_finish", args: { parentCallId: request.toolCallId } }, {});
    } finally { options.signal?.removeEventListener("abort", stop); }
  }

  async run(descriptor, tools, parent, signal) {
    const childId = descriptor.id;
    if (typeof childId !== "string" || !/^[0-9a-f-]{36}$/.test(childId) || this.live.has(childId)) throw new Error("Invalid native child identity");
    const entry = { host: null, stopped: !!signal?.aborted };
    this.live.set(childId, entry);
    const invoke = (name, args, callId, options = {}) => this.root.options.invokeTool({
      sessionId: parent.sessionId, taskId: parent.taskId, childId, parentCallId: parent.toolCallId,
      toolCallId: callId, name, args,
    }, options);
    let text = "", ok = false;
    try {
      entry.host = await this.createHost({
        directory: path.join(this.root.options.directory, "children", childId),
        // Frozen task model, never global Game.llm or a later model selection.
        model: this.root.options.model, readonlyChild: true, nativeActor: childId,
        systemPrompt: `你是本局的只读核对助手。只完成交给你的子任务，按需查阅正式资料；草稿只读主助手明确提供的部分。不能修改、提交、提问、执行脚本或派生助手。查不到时说明资料不足，结论要带实际出处。当前世界版本：${descriptor.worldVersion}。明确提供的草稿定位：${JSON.stringify(descriptor.providedDrafts ?? [])}。用discover_tools按需加载工具，目录：${JSON.stringify(tools.map(tool => ({ name: tool.name, description: tool.description })))}。`,
        tools, activeTools: ["discover_tools", "list_resources", "read_resource", "read_world", "read_tool_result", "list_skills", "read_skill", "read_provided_draft"],
        taskContext: true, nativeModelHttp: this.root.options.nativeModelHttp === true,
        invokeTool: (call, options) => invoke(call.name, call.args, call.toolCallId, options),
        invokeModelHttp: (action, args, options) => invoke(`__model_http_${action}`, args, `http-${randomUUID()}`, options),
        getTaskState: options => invoke("read_task_state", {}, `context-${randomUUID()}`, options),
        onEvent: record => {
          const event = { ...record.event };
          if (typeof event.toolCallId === "string") event.toolCallId = childCallId(childId, event.toolCallId);
          this.root.options.onEvent?.({ sessionId: parent.sessionId, taskId: parent.taskId,
            childId, parentCallId: parent.toolCallId, event });
        },
      });
      const opened = await invoke("__child_open", { sessionFile: entry.host.inspect().sessionFile }, `control-${randomUUID()}`);
      if (opened?.ok !== true) throw new Error("Native child session was not admitted");
      if (entry.stopped || signal?.aborted) throw new Error("Readonly child cancelled before model request");
      const result = await entry.host.prompt(descriptor.prompt, parent.taskId);
      text = clipped(result.text); ok = !entry.stopped && !signal?.aborted;
    } catch {
      text ||= "本项只读核对未完整结束；请根据已保存的调用记录重新判断，不能视作已经核实。";
    } finally {
      await entry.host?.close().catch(() => {});
      this.live.delete(childId);
    }
    if (!signal?.aborted) {
      const result = await invoke("__child_finish", { ok, text }, `control-${randomUUID()}`);
      if (result?.ok !== true) throw new Error("Native child result was not confirmed");
    }
  }
  async stop() {
    const entries = [...this.live.values()];
    for (const entry of entries) entry.stopped = true;
    await Promise.all(entries.map(entry => entry.host?.abort().catch(() => {})));
  }
}
