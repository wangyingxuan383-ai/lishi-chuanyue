// Request-only task constraints. The native store remains authoritative; Pi
// owns messages, compaction and tool groups. No second transcript is retained.
export const TASK_CONTEXT_VERSION = "1.2.0";
export const TASK_CONTEXT_TYPE = "lishi-task-state";

function unavailable(aborted = false) {
  const error = new Error(aborted
    ? "任务已停止，未读取或发送新的模型上下文"
    : "当前任务要求未能重新读取，本次模型请求未发送；任务与草稿已保留");
  error.code = aborted ? "task_context_cancelled" : "task_context_unavailable";
  return error;
}

function snapshotOf(result) {
  const state = result?.data;
  if (result?.ok !== true || !state || typeof state !== "object" || Array.isArray(state)
      || typeof state.goal !== "string" || !Array.isArray(state.corrections)
      || !Number.isSafeInteger(state.intentRevision) || state.intentRevision < 0
      || !Number.isSafeInteger(state.consumedIntentRevision) || state.consumedIntentRevision < 0
      || state.corrections.some(item => !item || typeof item !== "object" || typeof item.text !== "string")) {
    throw unavailable();
  }
  const snapshot = {};
  for (const key of ["goal", "target", "corrections", "plan", "question", "draftRefs", "skillRefs", "requestedSkills",
    "intentRevision", "consumedIntentRevision", "storyVersion", "status", "receipt", "resource", "warning", "runtimeGuidance"]) {
    if (Object.hasOwn(state, key)) snapshot[key] = state[key];
  }
  return snapshot;
}

function ownMessage(message) {
  return message?.role === "custom" && message.customType === TASK_CONTEXT_TYPE
    && message.details?.owner === "native-task-context";
}

function userBlocks(content) {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (Array.isArray(content)) return content;
  return [{ type: "text", text: String(content ?? "") }];
}

/** Merge consecutive user turns in the outgoing request projection only so
 * Anthropic/Gemini/strict-role relays never reject consecutive user messages
 * (including after custom task-state or compaction summary blocks convert to user). */
export function coalesceConsecutiveUsers(messages) {
  let hasAdjacent = false;
  for (let i = 1; i < messages.length; i++) {
    if (messages[i]?.role === "user" && messages[i - 1]?.role === "user") {
      hasAdjacent = true;
      break;
    }
  }
  if (!hasAdjacent) return messages;
  const out = [];
  for (const message of messages) {
    const prev = out.at(-1);
    if (message?.role === "user" && prev?.role === "user") {
      const merged = [...userBlocks(prev.content), { type: "text", text: "\n\n" }, ...userBlocks(message.content)];
      out[out.length - 1] = { ...prev, content: merged, timestamp: message.timestamp ?? prev.timestamp };
    } else {
      out.push(message);
    }
  }
  return out;
}

/** Wrap Pi's convertToLlm so dynamic custom/compaction blocks mapped to role:"user"
 * are coalesced with any adjacent user message as the final LLM projection step. */
export function wrapConvertToLlm(convertToLlm) {
  return async messages => coalesceConsecutiveUsers(await convertToLlm(messages));
}

export class TaskContext {
  constructor({ getTaskId, getTaskState, onError = () => {} }) {
    if (typeof getTaskId !== "function" || typeof getTaskState !== "function") throw unavailable();
    this.getTaskId = getTaskId;
    this.getTaskState = getTaskState;
    this.onError = onError;
    this.lastError = null;
    this.lastTaskId = null;
    this.lastSnapshotJson = null;
    this.lastTimestamp = null;
    this.lastMessageCount = 0;
    this.factory = api => {
      api.on("context", (event, context) => this.prepare(event, context));
      api.on("session_before_compact", (event, context) => this.prepareCompaction(event, context));
    };
  }

  setError(error) {
    this.lastError = error;
    this.onError(error);
  }

  async prepare(event, context = {}, options = {}) {
    // Pi creates the session before its native task is attached. No read is
    // made during that phase, and a different task's snapshot is never reused.
    const taskId = this.getTaskId();
    if (!taskId) return undefined;
    const messages = event.messages.filter(message => !ownMessage(message));
    try {
      if (context.signal?.aborted) throw unavailable(true);
      const result = await this.getTaskState({ signal: context.signal });
      if (context.signal?.aborted) throw unavailable(true);
      const snapshot = snapshotOf(result);
      const snapshotJson = JSON.stringify(snapshot);
      const unchanged = !options.forceFull
        && this.lastTaskId === taskId
        && this.lastSnapshotJson === snapshotJson;
      const timestamp = unchanged && this.lastTimestamp !== null ? this.lastTimestamp : Date.now();
      const compactUnchanged = unchanged && messages.length > this.lastMessageCount;
      const body = compactUnchanged
        ? JSON.stringify({
            unchanged: true,
            intentRevision: snapshot.intentRevision,
            consumedIntentRevision: snapshot.consumedIntentRevision,
            ...(Object.hasOwn(snapshot, "storyVersion") ? { storyVersion: snapshot.storyVersion } : {}),
            ...(Object.hasOwn(snapshot, "status") ? { status: snapshot.status } : {}),
          })
        : snapshotJson;
      const content = `本次任务实时约束 ${TASK_CONTEXT_VERSION}。以下是程序重新读取的任务要求、已生效补充及真实进度；对话摘要不能替代这些内容，草稿不是正式剧情。\n${body}`;
      if (options.recordCache !== false) {
        this.lastTaskId = taskId;
        this.lastSnapshotJson = snapshotJson;
        this.lastTimestamp = timestamp;
        this.lastMessageCount = messages.length;
      }
      this.setError(null);
      return { messages: [...messages, {
        role: "custom", customType: TASK_CONTEXT_TYPE, display: false, content,
        details: { owner: "native-task-context", version: TASK_CONTEXT_VERSION, ephemeral: true, ...(compactUnchanged ? { unchanged: true } : {}) }, timestamp,
      }] };
    } catch (error) {
      this.setError(["task_context_cancelled","progress_saved"].includes(error?.code) ? error : unavailable(context.signal?.aborted));
      // Pi catches extension exceptions. The host request guard checks this
      // error before starting a provider; returning messages cannot fail open.
      return { messages };
    }
  }

  assertRequest() {
    if (this.lastError) throw this.lastError;
  }

  async prepareCompaction(event, context = {}) {
    if (!this.getTaskId()) return undefined;
    const preparation = event.preparation;
    if (!preparation || !Array.isArray(preparation.messagesToSummarize)
        || !Array.isArray(preparation.turnPrefixMessages)) {
      this.setError(unavailable());
      return { cancel: true };
    }
    const projected = await this.prepare({ messages: preparation.messagesToSummarize }, {
      signal: event.signal ?? context.signal,
    }, { forceFull: true, recordCache: false });
    if (this.lastError) return { cancel: true };
    if (!projected) return undefined;
    // Pi passes this request-only preparation to its own summary generator.
    // Keep all cut points and full message/tool groups. A split turn may need
    // a separate prefix-summary request; both receive the same native state.
    preparation.messagesToSummarize = projected.messages;
    if (preparation.isSplitTurn && preparation.turnPrefixMessages.length) {
      preparation.turnPrefixMessages = [
        ...preparation.turnPrefixMessages.filter(message => !ownMessage(message)),
        projected.messages.at(-1),
      ];
    }
    return undefined;
  }
}

export async function taskContextExtensions(pi, { enabled, directory, settingsManager, ...options }) {
  if (enabled !== true) return null;
  const context = new TaskContext(options);
  const loader = new pi.DefaultResourceLoader({
    cwd: directory, agentDir: directory, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    additionalExtensionPaths: [], additionalSkillPaths: [], additionalThemePaths: [], additionalPromptTemplatePaths: [],
    systemPrompt: "", appendSystemPrompt: [],
    extensionFactories: [{ name: "lishi-task-context", hidden: true, factory: context.factory }],
  });
  await loader.reload();
  const extensions = loader.getExtensions();
  if (extensions.errors?.length || extensions.extensions?.length !== 1) throw unavailable();
  return { context, extensions };
}
