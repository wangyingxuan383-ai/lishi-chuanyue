export type BookFormat = "txt" | "epub" | "pdf" | "docx";
export interface BookSection { title: string; text: string; page?: number }
/** Normalized text is immutable. Reimporting creates a new id. */
export interface SourceBook { id: string; title: string; format: BookFormat; createdAt: string; sections: BookSection[] }
export interface SourceBinding {
  bookId: string;
  fanfic: boolean;
  plot: "rewrite" | "canon";
  through: number | null;
  position: number;
  instructions: string;
  method: "search" | "analysis";
  analysisId?: string;
}
export interface ReferencePassage {
  section: number; title: string; page?: number; chunk: number; text: string; kind: "original" | "analysis";
  /** Offsets inside the immutable chunk; old references may omit them. */
  start?: number; end?: number;
  /** Query focus in the same chunk coordinates, used when fitting a smaller budget. */
  focus?: number;
  /** A verified locator; its quotation must still occur in an original passage. */
  fact?: SourceFactData;
}
export type SourceFactKind = "person" | "relation" | "event" | "rule";
export interface SourceFactData {
  kind: SourceFactKind; subject: string; aliases: string[]; statement: string; quote: string;
  /** Section indices, not dates; omitted start means the chapter supplying the evidence. */
  validFrom?: number; validThrough?: number;
}
export interface SourceFact extends SourceFactData {
  id: string; bookId: string; jobId: string; section: number; chunk: number;
}
export interface StructuredSourceAnalysis {
  version: "source-3"; summary: string; facts: SourceFactData[];
}
export interface ReferenceContext {
  bookId: string; title: string; binding: SourceBinding; passages: ReferencePassage[];
  status?: "ready" | "insufficient";
  reason?: "budget" | "no_match";
}
/** Keep the immediate request separate from background so long history cannot hide it. */
export interface ReferenceQuery {
  text: string;
  rewriteHint?: string | null;
  directorNote?: string | null;
  recent?: string;
  entities?: { name: string; aliases?: string[] }[];
  place?: string;
}
export interface AnalysisJob {
  id: string; bookId: string; instructions: string; through: number | null;
  status: "paused" | "running" | "failed" | "done"; error?: string;
  completed: number; total: number; model: string; promptVersion: string;
}
export const SOURCE_INSTRUCTIONS = "参考原著的人物性格、关系和世界规则。原著事件作为可能的发展参考；已经在本局改变的事实继续保留。";
export const newBinding = (bookId: string, fanfic = false): SourceBinding => ({ bookId, fanfic, plot: "rewrite", through: null, position: 0, instructions: SOURCE_INSTRUCTIONS, method: "search" });
export function validBinding(value: unknown): value is SourceBinding {
  const b = value as SourceBinding;
  return !!b && typeof b.bookId === "string" && typeof b.fanfic === "boolean" && ["rewrite", "canon"].includes(b.plot)
    && (b.through === null || Number.isSafeInteger(b.through) && b.through >= 0) && Number.isSafeInteger(b.position) && b.position >= 0
    && typeof b.instructions === "string" && b.instructions.length <= 12000 && ["search", "analysis"].includes(b.method)
    && (b.analysisId === undefined || typeof b.analysisId === "string");
}
