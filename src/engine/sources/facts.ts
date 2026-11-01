import { newId, type Repo } from "../db/repo";
import type { SqlStatement } from "../../platform";
import { lenientJson } from "../record/parse";
import type { SourceChunk } from "./library";
import type { AnalysisJob, SourceBinding, SourceBook, SourceFact, SourceFactData, SourceFactKind, StructuredSourceAnalysis } from "./types";

const KINDS: SourceFactKind[] = ["person", "relation", "event", "rule"];
const text = (value: unknown, max: number) => typeof value === "string" ? value.trim().slice(0, max) : "";

/** Only this marker means structured storage. Old notes remain readable as plain text. */
export function structuredSourceAnalysis(raw: string): StructuredSourceAnalysis | null {
  try {
    const value = JSON.parse(raw);
    return value?.version === "source-3" && typeof value.summary === "string" && Array.isArray(value.facts) ? value : null;
  } catch { return null; }
}

export function sourceAnalysisText(raw: string): string {
  return structuredSourceAnalysis(raw)?.summary ?? raw;
}

/** Verify the exact immutable chunk and analysis scope before accepting any model data. */
function assertChunk(book: SourceBook, chunk: SourceChunk, job: AnalysisJob) {
  const base = book.sections.slice(0, chunk.section).reduce((n, s) => n + Math.ceil(s.text.length / 2400), 0);
  const start = (chunk.ordinal - base) * 2400;
  const section = book.sections[chunk.section];
  if (job.bookId !== book.id || !Number.isSafeInteger(chunk.section) || chunk.section < 0 || !section
    || !Number.isSafeInteger(chunk.ordinal) || start < 0 || start >= section.text.length
    || section.text.slice(start, start + 2400) !== chunk.text
    || job.through !== null && chunk.section > job.through) throw new Error("整理片段与原著或参考范围不一致");
}

/** Host-authored provenance is never taken from fields supplied by the model. */
export function sourceAnalysisResult(raw: string, book: SourceBook, chunk: SourceChunk, job: AnalysisJob): { text: string; statements: SqlStatement[] } {
  assertChunk(book, chunk, job);
  const value = lenientJson(raw) as Partial<StructuredSourceAnalysis> | null;
  const reset: SqlStatement = { sql: "DELETE FROM canon_facts WHERE job_id=? AND book_id=? AND chunk=?", params: [job.id, book.id, chunk.ordinal] };
  // Legacy, already paid-for notes are retained. They do not manufacture verified facts.
  if (!value || typeof value.summary !== "string" || !Array.isArray(value.facts)) return { text: raw.trim().slice(0, 20000), statements: [reset] };
  const facts: SourceFactData[] = [], seen = new Set<string>();
  for (const item of value.facts.slice(0, 32)) {
    if (!item || !KINDS.includes(item.kind)) continue;
    const subject = text(item.subject, 80), statement = text(item.statement, 500);
    const quote = typeof item.quote === "string" ? item.quote.trim() : "";
    if (!subject || !statement || !quote || quote.length > 800 || !chunk.text.includes(quote)) continue;
    const aliases = [...new Set((Array.isArray(item.aliases) ? item.aliases : []).map((v) => text(v, 80)).filter((v) => v && v !== subject))].slice(0, 8);
    const validFrom = item.validFrom === undefined ? undefined : item.validFrom;
    const validThrough = item.validThrough === undefined ? undefined : item.validThrough;
    // A fragment can describe an earlier identity, but cannot invent a later chapter boundary.
    if (validFrom !== undefined && (!Number.isSafeInteger(validFrom) || validFrom < 0 || validFrom > chunk.section)
      || validThrough !== undefined && (!Number.isSafeInteger(validThrough) || validThrough < (validFrom ?? chunk.section) || validThrough > chunk.section)) continue;
    const key = JSON.stringify([item.kind, subject, statement]);
    if (seen.has(key)) continue;
    seen.add(key);
    facts.push({ kind: item.kind, subject, aliases, statement, quote, ...(validFrom !== undefined ? { validFrom } : {}), ...(validThrough !== undefined ? { validThrough } : {}) });
  }
  const structured: StructuredSourceAnalysis = { version: "source-3", summary: text(value.summary, 4000), facts };
  while (JSON.stringify(structured).length > 20000 && facts.length) facts.pop();
  return {
    text: JSON.stringify(structured),
    statements: [reset, ...facts.map((fact) => ({
      sql: "INSERT INTO canon_facts(id,book_id,job_id,section,chunk,kind,subject,aliases_json,statement,quote,valid_from,valid_through) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      params: [newId(), book.id, job.id, chunk.section, chunk.ordinal, fact.kind, fact.subject, JSON.stringify(fact.aliases), fact.statement, fact.quote, fact.validFrom ?? null, fact.validThrough ?? null],
    } satisfies SqlStatement))],
  };
}

/** Scoped and time-appropriate entity notes only expand a query; they never replace text. */
export async function relevantSourceFacts(repo: Repo, binding: SourceBinding, keys: Map<string, number>, through: number, position: number): Promise<SourceFact[]> {
  if (!keys.size) return [];
  const patterns = [...keys.keys()].slice(0, 240).map((key) => `%${key}%`);
  const rows = await repo.platform.sql.query(`SELECT f.*,c.text AS original FROM canon_facts f
JOIN source_chunks c ON c.book_id=f.book_id AND c.ordinal=f.chunk AND c.section=f.section
JOIN source_jobs j ON j.id=f.job_id AND j.book_id=f.book_id
WHERE f.book_id=? AND f.section<=? AND COALESCE(f.valid_from,f.section)<=? AND (f.valid_through IS NULL OR f.valid_through>=?)
${binding.analysisId ? "AND f.job_id=?" : ""}
AND (${patterns.map(() => "(f.subject LIKE ? OR f.aliases_json LIKE ? OR f.statement LIKE ?)").join(" OR ")})`,
  [binding.bookId, through, position, position, ...(binding.analysisId ? [binding.analysisId] : []), ...patterns.flatMap((pattern) => [pattern, pattern, pattern])]);
  const scored: { fact: SourceFact; score: number }[] = [], seen = new Set<string>();
  for (const row of rows) {
    const kind = row.kind as SourceFactKind, quote = String(row.quote);
    if (!KINDS.includes(kind) || !quote || !String(row.original).includes(quote)) continue;
    let aliases: string[];
    try { const value: unknown = JSON.parse(String(row.aliases_json)); aliases = Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : []; } catch { continue; }
    const fact: SourceFact = { id: String(row.id), bookId: String(row.book_id), jobId: String(row.job_id), section: Number(row.section), chunk: Number(row.chunk), kind,
      subject: String(row.subject), aliases, statement: String(row.statement), quote,
      ...(row.valid_from !== null ? { validFrom: Number(row.valid_from) } : {}), ...(row.valid_through !== null ? { validThrough: Number(row.valid_through) } : {}) };
    const identity = [fact.subject, ...aliases].join("\n").toLowerCase(), statement = fact.statement.toLowerCase();
    const score = [...keys].reduce((n, [key, weight]) => n + (identity.includes(key) ? weight * 4 : statement.includes(key) ? weight : 0), 0);
    const fingerprint = JSON.stringify([fact.section, fact.chunk, kind, fact.subject, fact.statement, quote]);
    if (!score || seen.has(fingerprint)) continue;
    seen.add(fingerprint); scored.push({ fact, score });
  }
  return scored.sort((a, b) => b.score - a.score || Math.abs(a.fact.section - position) - Math.abs(b.fact.section - position) || a.fact.chunk - b.fact.chunk).slice(0, 16).map(({ fact }) => fact);
}
