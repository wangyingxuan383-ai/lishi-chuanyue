import { describe, expect, it, vi } from "vitest";
import type { Game, LlmConfig } from "./game";
import { AgentClient, mergeAgentDelta, agentConversationTurns, agentSessionProjection, agentSnapshotEvents, agentSnapshotNeedsRead, agentTaskStatus, DEFAULT_AGENT_LIMITS, type AgentMessage, type AgentSessionDetail, type AgentSnapshot, type AgentStart, type AgentTask } from "./agent";

const task = (patch: Partial<AgentTask> = {}): AgentTask => ({ id: "task", runId: "task", sessionId: "session", status: "running", policy: "auto-reversible", limits: DEFAULT_AGENT_LIMITS, updatedAt: "2026-10-30T10:00:00+08:00", ...patch });
const message = (id: string, content: string, role: AgentMessage["role"] = "assistant"): AgentMessage => ({ id, taskId: "task", sessionId: "session", role, content, createdAt: "2026-10-30T10:00:00+08:00" });
const snapshot = (current: AgentTask, patch: Partial<AgentSnapshot> = {}): AgentSnapshot => ({ id: current.id, worldId: "world", status: current.status, task: current, result: null, error: null, events: [], steps: [], messages: [], nextAfter: 0, ...patch });

describe("Pi Agent facade and projections", () => {
  it("keeps adopted work busy until receipt closeout actually ends",()=>{
    const adopted=task({status:"committed",result:{worldChanged:true},execution:{attemptId:"a",phase:"closing",ownerStatus:"active",hostActive:true}});
    expect(agentTaskStatus(adopted)).toBe("committing");
    expect(agentTaskStatus({...adopted,execution:{...adopted.execution!,phase:"committed",hostActive:false}})).toBe("committed");
    expect(agentTaskStatus({...adopted,execution:{...adopted.execution!,phase:"stopping"}})).toBe("stopping");
  });
  it("replaces a task stream by identity while preserving intermediate replies and other tasks", () => {
    const stale = task(), other = task({ id: "other", runId: "other" });
    const detail: AgentSessionDetail = { session: { id: "session", worldId: "world", lineId: "line", title: "助手", createdAt: "", updatedAt: "" }, tasks: [stale, other], messages: [message("user", "核对时间", "user"), message("reply", "旧片段"), { ...message("other-reply", "另一项答复"), taskId: "other" }] };
    const current = task({ status: "committed", updatedAt: "2026-10-30T10:01:00+08:00" });
    const projected = agentSessionProjection(detail, { task: snapshot(current, { messages: [message("user", "核对时间", "user"), message("explanation", "先核对时间锚点"), message("reply", "已改为斗罗历10015年")] }) });
    expect(projected.messages.map(item => item.content)).toEqual(["核对时间", "先核对时间锚点", "已改为斗罗历10015年", "另一项答复"]);
    expect(agentConversationTurns(projected.messages, projected.tasks).map(turn => [turn.task?.id, turn.messages.length])).toEqual([["task", 3], ["other", 1]]);
    expect(projected.tasks[0].status).toBe("committed");
    const undone = { ...detail, tasks: [task({ status: "undone" }), other] };
    expect(agentSessionProjection(undone, { task: snapshot(current) }).tasks[0].status).toBe("undone");
    expect(agentSessionProjection(detail, { task: snapshot(task({ sessionId: "foreign" })) }).tasks[0]).toBe(stale);
  });

  it("keeps business outcomes distinct from the execution lifecycle", () => {
    expect(agentTaskStatus(task({ status: "completed", result: { status: "answered", changed: false } }))).toBe("answered");
    expect(agentTaskStatus(task({ status: "completed", result: { status: "partial" } }))).toBe("partial");
    expect(agentTaskStatus(task({ phase: "compacting" }))).toBe("compacting");
    expect(agentTaskStatus(task({ status: "previewed", result: { status: "answered" } }))).toBe("previewed");
    expect(agentTaskStatus(task({ status: "failed" }))).toBe("failed");
  });

  it("continues reading terminal event pages and merges retried pages without duplicate calls", () => {
    const completed = task({ status: "completed" });
    const first = snapshot(completed, { hasMore: true, nextAfter: 2, events: [{ seq: 1, event: { type: "tool_start" } }, { seq: 2, event: { type: "tool_end" } }] });
    expect(agentSnapshotNeedsRead(first, "completed", true)).toBe(true);
    const last = snapshot(completed, { hasMore: false, nextAfter: 3, events: [{ seq: 2, event: { type: "tool_end" } }, { seq: 3, event: { type: "message_end" } }] });
    expect(agentSnapshotEvents(first, last).map(event => event.seq)).toEqual([1, 2, 3]);
    expect(agentSnapshotNeedsRead(last, "completed", true)).toBe(false);
    expect(agentSnapshotNeedsRead({...last,hasMoreCalls:true}, "completed", true)).toBe(true);
    expect(agentSnapshotNeedsRead(last, "running", true)).toBe(true);
    expect(agentSnapshotNeedsRead(last, "completed", false)).toBe(true);
  });

  it("uses dedicated Pi RPC for start, model selection, queue, stop and deletion", async () => {
    const rpc = vi.fn(async (_request: unknown) => ({ taskId: "task", runId: "task", deleted: true }));
    const oldSnapshot = vi.fn(), oldStop = vi.fn(), ordinary = { model: "ordinary" };
    const game = { platform: { execution: { agent: rpc, snapshot: oldSnapshot, stop: oldStop } }, llm: ordinary } as unknown as Game;
    const client = new AgentClient(game);
    const model: LlmConfig = { slot: "saved-slot", url: "https://not-an-authorization.invalid/v1/messages", model: "chosen", includeUsage: true, contextTokens: 475000, maxTokens: 8192, protocol: "anthropic" };
    const input: AgentStart = { sessionId: "session", text: "只改时间", policy: "auto-reversible", skills: [], customSkills: [], network: { mode: "off" }, limits: DEFAULT_AGENT_LIMITS, profileId: "saved-profile", modelUrl: "https://saved-endpoint.invalid/v1/messages", model };
    await client.start(input);
    await client.enqueue("task", "保留经过时长", "queued", input);
    await client.continue("task", undefined, DEFAULT_AGENT_LIMITS, 24000, model, input.modelUrl);
    await client.compact("task", 36000, model, DEFAULT_AGENT_LIMITS, input.modelUrl);
    await client.stop("task", "attempt");
    await client.stopStatus("task", "attempt");
    await client.delete("session");
    const requests = rpc.mock.calls.map(([request]) => request) as unknown as Record<string, unknown>[];
    expect(requests.map(request => request.op)).toEqual(["start", "enqueue_input", "continue", "compact", "stop", "stop_status", "delete"]);
    expect(requests[0]).toMatchObject({ profileId: "saved-profile", modelUrl: input.modelUrl, inputTokens: 475000, model: { slot: "saved-slot", model: "chosen", protocol: "anthropic", maxOutputTokens: 8192 } });
    expect(requests[0].model).not.toHaveProperty("url");
    expect(requests[1].request).toMatchObject({ modelUrl: input.modelUrl, model: { model: "chosen" } });
    expect(requests[2]).toMatchObject({ inputTokens: 24000, modelUrl: input.modelUrl });
    expect(requests[3]).toMatchObject({ inputTokens: 36000, modelUrl: input.modelUrl });
    expect(requests[4]).toMatchObject({ taskId: "task", attemptId: "attempt" });
    expect(requests[4].requestId).toEqual(expect.any(String));
    expect(requests[5]).toMatchObject({op:"stop_status",taskId:"task",attemptId:"attempt"});
    expect(oldSnapshot).not.toHaveBeenCalled(); expect(oldStop).not.toHaveBeenCalled();
    expect(game.llm).toBe(ordinary);
  });

  it("normalizes only the safe native model locator while keeping task projections intact", async () => {
    const current = task({ status: "completed", model: { slot: "saved-slot", id: "native-model", inputTokens: 12000, contextWindowTokens: 32000, maxOutputTokens: 8192 } as unknown as LlmConfig });
    const rpc = vi.fn(async () => snapshot(current, { messages: [message("reply", "核对结果")], steps: [{ id: "call", callId: "call", taskId: "task", childId: "child", parentCallId: "delegate", tool: "read_original", action: "阅读原著", object: "第二章", status: "failed", outcome: "invalid", summary: "阅读第二章：资料不足", resultText: "资料不足", seq: 1, attempts: 1 }] }));
    const client = new AgentClient({ platform: { execution: { agent: rpc } } } as unknown as Game);
    const result = await client.snapshot("task", 100);
    expect(rpc).toHaveBeenCalledWith({ op: "snapshot", taskId: "task", after: 100, limit: 200 });
    expect(result.task.model?.model).toBe("native-model");
    expect(result.task.inputBudget?.effectiveTokens).toBe(12000);
    expect(result.messages[0].content).toBe("核对结果");
    expect(result.steps[0]).toMatchObject({ childId: "child", parentCallId: "delegate", status: "failed", resultText: "资料不足" });
  });
});

it("merges deltas by identity while keeping ledger totals beyond the process viewport", () => {
  const current=task({budget:{modelRequests:42,toolCalls:2505,activeMs:1},execution:{attemptId:"a",phase:"stopping",ownerStatus:"active"}});
  const first=snapshot(current,{steps:Array.from({length:200},(_,n)=>({id:String(n),callId:String(n),taskId:"task",tool:"read_resource",action:"读取",object:"",status:"running",outcome:"running",summary:"正在读取",resultText:"正在读取",seq:n,attempts:1}))});
  const last=snapshot(current,{steps:[{...first.steps[0],status:"completed",resultText:"已读取10字"}]});
  const merged=mergeAgentDelta(first,last);expect(merged.steps).toHaveLength(200);expect(merged.steps[0].status).toBe("completed");expect(merged.task.budget?.toolCalls).toBe(2505);expect(agentTaskStatus(current,merged)).toBe("stopping");
});
