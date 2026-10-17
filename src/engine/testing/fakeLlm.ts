// Scripted model for engine tests: each stream() call takes the next script.
import type { Platform, StreamEvent } from "../../platform";

export type Script = StreamEvent[] | { text: string; finish?: string | null; usage?: boolean };

const chunk = (content: string) => ({ type: "data" as const, data: JSON.stringify({ choices: [{ delta: { content } }] }) });

/** Turns a reply text into SSE-like events, split into small pieces. */
export function reply(text: string, opts: { finish?: string | null; usage?: boolean; size?: number } = {}): StreamEvent[] {
  const size = opts.size ?? 7;
  const events: StreamEvent[] = [{ type: "open", status: 200 }];
  for (let i = 0; i < text.length; i += size) events.push(chunk(text.slice(i, i + size)));
  events.push({ type: "data", data: JSON.stringify({ choices: [{ delta: {}, finish_reason: opts.finish ?? "stop" }] }) });
  if (opts.usage !== false) events.push({ type: "data", data: JSON.stringify({ choices: [], usage: { prompt_tokens: 100, completion_tokens: 50 } }) });
  events.push({ type: "done" });
  return events;
}

export function fakeLlm(scripts: Script[]): Platform["llm"] & { calls: { body: any }[]; cache: Map<string, StreamEvent[]> } {
  const calls: { body: any }[] = [];
  const cache = new Map<string, StreamEvent[]>();
  let n = 0;
  return {
    calls,
    cache,
    async stream(request, onEvent) {
      calls.push({ body: request.body });
      const script = scripts.shift();
      if (!script) throw new Error("fake llm: no script left");
      const events = Array.isArray(script) ? script : reply(script.text, script);
      const id = `s${++n}`;
      cache.set(id, []);
      queueMicrotask(() => {
        for (const e of events) {
          cache.get(id)?.push(e);
          onEvent(e);
        }
      });
      return id;
    },
    async cancel() {},
    async resume(id) {
      const events = cache.get(id);
      return events ? { events, active: false } : null;
    },
    async list() { return []; },
    async ack(id) { cache.delete(id); },
    async get() { return { status: 200, body: "{}" }; },
    async getPublic() { return { status: 404, body: "{}" }; },
    async setNetwork() {},
  };
}

export const RECORD = (fields: Record<string, unknown>) => `\n\n<record>\n${JSON.stringify({ time: "一刻", log: "略", choices: ["甲", "乙", "丙"], ...fields })}\n</record>`;
