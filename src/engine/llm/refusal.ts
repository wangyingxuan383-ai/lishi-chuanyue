// Recognises a provider refusing to write (PLAN_V3 §5.8): hard signals from
// the response, or a short reply without a record that reads like a refusal.

const SOFT_PHRASES = ["抱歉，我无法", "抱歉，我不能", "我无法继续", "我不能继续", "作为AI", "作为一个AI", "作为人工智能", "I can't", "I cannot", "I'm sorry"];

export function isRefusal(input: { finishReason: string | null; narrative: string; hasRecord: boolean; httpMessage?: string }): boolean {
  const reason = (input.finishReason ?? "").toLowerCase();
  if (reason === "content_filter" || reason === "safety" || reason === "prohibited_content" || reason === "recitation") return true;
  if (input.httpMessage && /safety|content[_ ]?filter|policy|敏感|违规|安全/i.test(input.httpMessage)) return true;
  if (!input.hasRecord && isNotice(input.narrative)) return true;
  const text = input.narrative.replace(/\s/g, "");
  return !input.hasRecord && text.length < 80 && SOFT_PHRASES.some((p) => text.includes(p.replace(/\s/g, "")));
}

/**
 * A reply with next to no Chinese in it is not a passage of this story but a
 * provider's notice sent as text (eval I: "The prompt could not be submitted.
 * The prompt contains sensitive words…" was saved as a turn).
 */
export function isNotice(text: string): boolean {
  const chinese = text.match(/[\u3400-\u9fff]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  return chinese < 20 && latin >= 20 && latin > chinese * 3;
}
