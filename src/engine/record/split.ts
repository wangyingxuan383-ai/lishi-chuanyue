// Separates the visible narrative from the trailing record block while the
// reply streams in (format A: narrative + <record>{json}</record>, V101).
// Text that could be the start of a record is held back until it is clear.

const TAG = /<\s*record\s*>/i;
const FENCE_LINE = /(^|\n)[ \t]*```/;
/**
 * A line starting with one of the request's own section headers: the model
 * copied part of its context (eval H, Tang turn 120 echoed 【当前】 after the
 * story). Nothing from there on is narrative.
 */
const ECHO = /(^|\n)[ \t]*【(?:当前|相关设定|相关旧事|前情提要|要点|天下大事|历史偏离|叙事方针|上回合的实际结果|用词提醒|本回合运势|玩家行动)/;
/** The start of such a line, still incomplete at the end of the buffer. */
const ECHO_START = /\n[ \t]*【[^】\n]{0,8}$/;

export class RecordSplitter {
  private buffer = "";
  private shown = 0; // characters of buffer already released to the UI
  private recordStart = -1;
  private echoStart = -1;

  /** Where the narrative ends: at the record tag or at an echoed section, whichever comes first. */
  private end(): number {
    const ends = [this.recordStart, this.echoStart].filter((i) => i >= 0);
    return ends.length ? Math.min(...ends) : -1;
  }

  /** Feeds a streamed chunk; returns the newly visible narrative text. */
  push(chunk: string): string {
    this.buffer += chunk;
    if (this.recordStart >= 0) return "";
    if (this.echoStart < 0) {
      const echo = ECHO.exec(this.buffer);
      if (echo) this.echoStart = echo.index + echo[1].length;
    }
    const tag = TAG.exec(this.buffer);
    if (tag) {
      this.recordStart = tag.index;
      return this.release(this.end());
    }
    if (this.echoStart >= 0) return this.release(this.echoStart);
    // Hold back a possible partial tag ("<", "<rec") and any fenced block.
    let safe = this.buffer.length;
    const lt = this.buffer.lastIndexOf("<");
    if (lt >= 0 && /^<\s*r?e?c?o?r?d?\s*$/i.test(this.buffer.slice(lt))) safe = Math.min(safe, lt);
    const fence = FENCE_LINE.exec(this.buffer.slice(this.shown));
    if (fence) safe = Math.min(safe, this.shown + fence.index + fence[1].length);
    // A lone trailing backtick run may become a fence.
    const ticks = /`{1,2}$/.exec(this.buffer);
    if (ticks) safe = Math.min(safe, ticks.index);
    const header = ECHO_START.exec(this.buffer);
    if (header) safe = Math.min(safe, header.index);
    return this.release(safe);
  }

  private release(upTo: number): string {
    if (upTo <= this.shown) return "";
    const out = this.buffer.slice(this.shown, upTo);
    this.shown = upTo;
    return out;
  }

  /** Call when the stream ends. Returns the final narrative and raw record text. */
  finish(): { narrative: string; recordText: string | null; tail: string } {
    if (this.recordStart >= 0) {
      return {
        narrative: this.buffer.slice(0, this.end()).trim(),
        recordText: this.buffer.slice(this.recordStart),
        tail: "",
      };
    }
    // No tag: accept a trailing fenced or bare JSON object that looks like a record.
    const trailing = /(?:\n|^)[ \t]*(?:```(?:json)?\s*)?(\{[\s\S]*"(?:choices|log|time)"[\s\S]*\})\s*(?:```)?\s*$/.exec(this.buffer);
    if (trailing) {
      const cut = this.echoStart >= 0 ? Math.min(this.echoStart, trailing.index) : trailing.index;
      return { narrative: this.buffer.slice(0, cut).trim(), recordText: trailing[1], tail: "" };
    }
    if (this.echoStart >= 0) return { narrative: this.buffer.slice(0, this.echoStart).trim(), recordText: null, tail: "" };
    // Held-back text (e.g. an unrelated code fence) turns out to be narrative.
    const tail = this.buffer.slice(this.shown);
    this.shown = this.buffer.length;
    return { narrative: this.buffer.trim(), recordText: null, tail };
  }
}
