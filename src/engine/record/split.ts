// Separates the visible narrative from the trailing record block while the
// reply streams in (format A: narrative + <record>{json}</record>, V101).
// Text that could be the start of a record is held back until it is clear.

const TAG = /<\s*record\s*>/i;
const FENCE_LINE = /(^|\n)[ \t]*```/;

export class RecordSplitter {
  private buffer = "";
  private shown = 0; // characters of buffer already released to the UI
  private recordStart = -1;

  /** Feeds a streamed chunk; returns the newly visible narrative text. */
  push(chunk: string): string {
    this.buffer += chunk;
    if (this.recordStart >= 0) return "";
    const tag = TAG.exec(this.buffer);
    if (tag) {
      this.recordStart = tag.index;
      return this.release(tag.index);
    }
    // Hold back a possible partial tag ("<", "<rec") and any fenced block.
    let safe = this.buffer.length;
    const lt = this.buffer.lastIndexOf("<");
    if (lt >= 0 && /^<\s*r?e?c?o?r?d?\s*$/i.test(this.buffer.slice(lt))) safe = Math.min(safe, lt);
    const fence = FENCE_LINE.exec(this.buffer.slice(this.shown));
    if (fence) safe = Math.min(safe, this.shown + fence.index + fence[1].length);
    // A lone trailing backtick run may become a fence.
    const ticks = /`{1,2}$/.exec(this.buffer);
    if (ticks) safe = Math.min(safe, ticks.index);
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
        narrative: this.buffer.slice(0, this.recordStart).trim(),
        recordText: this.buffer.slice(this.recordStart),
        tail: "",
      };
    }
    // No tag: accept a trailing fenced or bare JSON object that looks like a record.
    const trailing = /(?:\n|^)[ \t]*(?:```(?:json)?\s*)?(\{[\s\S]*"(?:choices|log|time)"[\s\S]*\})\s*(?:```)?\s*$/.exec(this.buffer);
    if (trailing) {
      const narrative = this.buffer.slice(0, trailing.index).trim();
      return { narrative, recordText: trailing[1], tail: "" };
    }
    // Held-back text (e.g. an unrelated code fence) turns out to be narrative.
    const tail = this.buffer.slice(this.shown);
    this.shown = this.buffer.length;
    return { narrative: this.buffer.trim(), recordText: null, tail };
  }
}
