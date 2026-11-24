// Custom & preset chapter re-splitter for imported TXT novels (R36-T003).
// Reconstructs full book text cleanly and updates `source_books`, `source_sections`,
// `source_chunks`, and `source_terms` in one atomic SQLite batch without breaking `book_id` references.
import type { SqlStatement } from "../../platform";
import type { Repo } from "../db/repo";
import { ensureReaderSchema } from "../reader/store";
import { chunksOf, getBook, terms } from "./library";
import type { BookSection, SourceBook } from "./types";

export type ResplitPresetId = "standard" | "numbered" | "symbols" | "fixed_length" | "custom";

export interface ResplitRule {
  preset: ResplitPresetId;
  customPattern?: string;
  fixedChars?: number;
}

export interface ResplitPreview {
  sectionCount: number;
  sampleTitles: string[];
  sections: BookSection[];
}

export const RESPLIT_PRESETS: { id: ResplitPresetId; label: string; desc: string; example: string }[] = [
  {
    id: "standard",
    label: "标准章回",
    desc: "识别“第X章/回/节/卷/篇”及序章、楔子、尾声、番外",
    example: "第一章 风起长安 / 第12回 夜宴",
  },
  {
    id: "numbered",
    label: "数字序号",
    desc: "识别纯数字或括号序号开头的章节行",
    example: "001 初入京城 / 【12】暗流 / 1、楔子",
  },
  {
    id: "symbols",
    label: "分隔符标题",
    desc: "识别 ===、***、###、◆ 等特殊标记行",
    example: "=== 第一幕 === / ### 卷二",
  },
  {
    id: "fixed_length",
    label: "按字数分段",
    desc: "适合完全无章名的长篇 TXT，每节约 4000 字按自然段切分",
    example: "第 1 节 · 开篇…",
  },
  {
    id: "custom",
    label: "自定义正则",
    desc: "输入匹配整行章节名的正则表达式（单行不超过 80 字）",
    example: "^第[0-9一二三四五六七八九十百千]+话.*",
  },
];

const STANDARD_RE =
  /^\s*(?![^\n]*[。！？]$)(?:第\s*[零〇一二三四五六七八九十百千万两\d]+\s*[卷章节回集部篇话幕折][^\n]{0,65}|(?:[上中下前后全]\s*[卷部篇集]|[卷部篇集]\s*[零〇一二三四五六七八九十百千万两上中下\d]+)(?:\s*$|[\s：:·—\-]+[^\n]{1,40})|(?:序章|序言|楔子|尾声|后记|前言|引子|番外)(?:\s*$|[\s：:·—\-\d]+[^\n]{0,40})|(?:chapter|part)\s+[\divxlc]+[^\n]{0,65})\s*$/i;

const NUMBERED_RE =
  /^\s*(?![^\n]*[。！？；]$)(?:[\[【（(]\s*\d{1,5}\s*[\]】）)]\s*[^\n]{0,50}|\d{1,4}\s*[、.．：:\-—]\s*[^\n]{1,50}|0\d{1,4}\s+[^\n]{1,50}|[一二三四五六七八九十百千]{1,6}\s*[、.．]\s*[^\n]{1,50})\s*$/;

const SYMBOLS_RE =
  /^\s*(?:[=*#◆◇✦—\-]{2,}\s*[^\n=*#]{1,60}\s*[=*#◆◇✦—\-]*|第?\s*\d+\s*节)\s*$/;

function cleanBody(s: string): string {
  return s
    .replace(/\r\n?/g, "\n")
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const FRONT_MATTER_KEYWORD_RE = /(提要|内容简介|简介|楔子|序言|序章|引子|前言)/;

/**
 * Infers an intuitive heading for front-matter text appearing before the first matched chapter:
 * adopts a matching front-matter title when the first line contains
 * `提要|内容简介|简介|楔子|序言|序章|引子|前言`, otherwise falls back to `"前言"`.
 */
export function inferFrontMatterTitle(body: string): string {
  const rawFirst = body.split("\n")[0]?.trim() ?? "";
  if (!rawFirst) return "前言";
  const cleaned = rawFirst.replace(/^[=*#◆◇✦\s]+|[=*#◆◇✦\s]+$/g, "").trim();
  const match = FRONT_MATTER_KEYWORD_RE.exec(cleaned);
  if (!match) return "前言";
  // If first line has an inline label before colon like "作品简介：一卷塞北风云录。", adopt the clean label
  const colonIdx = cleaned.search(/[：:]/);
  if (colonIdx > 0 && colonIdx <= 12) {
    const label = cleaned.slice(0, colonIdx).trim();
    if (FRONT_MATTER_KEYWORD_RE.test(label)) return label;
  }
  // If the whole first line is already a concise heading without sentence-ending punctuation
  if (cleaned.length <= 24 && !/[。！？；]$/.test(cleaned)) {
    return cleaned;
  }
  return match[1]!;
}

/** Reconstructs full raw text from an existing `SourceBook`, preserving non-synthetic headings. */
export function reconstructBookText(book: SourceBook): string {
  return book.sections
    .map((sec, idx) => {
      const t = sec.title?.trim() ?? "";
      const firstLine = sec.text.split("\n")[0]?.trim() ?? "";
      const isSynthetic =
        !t ||
        t === "正文" ||
        (idx === 0 && t === "前言" && firstLine !== "前言") ||
        /^第\s*\d+\s*节(?:\s*·.*)?$/.test(t);
      if (isSynthetic) return sec.text;
      // Avoid duplicating if the body already begins with the heading or front-matter label
      if (
        firstLine === t ||
        (idx === 0 && (t === book.title.trim() || firstLine.startsWith(t)))
      ) {
        return sec.text;
      }
      return `${t}\n\n${sec.text}`;
    })
    .join("\n\n");
}

function compileSafeLineRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) throw new Error("请输入正则表达式");
  if (trimmed.length > 180) throw new Error("正则表达式过长（最多 180 个字符）");
  // Guard against nested quantifiers like (a+)+ that can stall on 80-char lines
  if (/\([^)]*[+*][^)]*\)[+*?]/.test(trimmed)) {
    throw new Error("正则表达式包含嵌套量词，可能导致卡顿，请简化写法");
  }
  try {
    return new RegExp(trimmed, "i");
  } catch {
    throw new Error("正则表达式语法有误，请检查括号或转义符");
  }
}

function splitByFixedLength(rawText: string, targetChars = 4000): BookSection[] {
  const safeTarget = Math.min(20000, Math.max(800, Math.round(targetChars)));
  const paras = rawText
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return [];

  const sections: BookSection[] = [];
  let buf: string[] = [];
  let len = 0;

  const flush = () => {
    if (!buf.length) return;
    const body = buf.join("\n\n");
    const idx = sections.length + 1;
    const firstSnippet = buf[0]!
      .replace(/^[“「『\s]+/, "")
      .slice(0, 12)
      .replace(/[，。！？；：,.!?;:]+$/, "");
    sections.push({
      title: firstSnippet ? `第 ${idx} 节 · ${firstSnippet}` : `第 ${idx} 节`,
      text: body,
    });
    buf = [];
    len = 0;
  };

  for (const p of paras) {
    if (len > 0 && len + p.length > safeTarget) {
      flush();
    }
    buf.push(p);
    len += p.length;
  }
  flush();
  return sections;
}

export function splitTextWithRule(rawText: string, rule: ResplitRule): BookSection[] {
  const normalized = cleanBody(rawText);
  if (!normalized) return [];

  if (rule.preset === "fixed_length") {
    return splitByFixedLength(normalized, rule.fixedChars ?? 4000);
  }

  const matcher =
    rule.preset === "standard"
      ? STANDARD_RE
      : rule.preset === "numbered"
        ? NUMBERED_RE
        : rule.preset === "symbols"
          ? SYMBOLS_RE
          : compileSafeLineRegex(rule.customPattern ?? "");

  const lines = normalized.split("\n");
  const sections: BookSection[] = [];
  let currentTitle = "序言 / 开篇";
  let hasMatchedHeading = false;
  let buf: string[] = [];

  const flush = () => {
    const body = cleanBody(buf.join("\n"));
    if (body) {
      sections.push({
        title: hasMatchedHeading
          ? currentTitle
          : sections.length === 0
            ? inferFrontMatterTitle(body)
            : currentTitle,
        text: body,
      });
    }
    buf = [];
  };

  for (const rawLine of lines) {
    const trimmed = rawLine.trim();
    if (trimmed.length > 0 && trimmed.length <= 85 && matcher.test(trimmed)) {
      flush();
      currentTitle = trimmed.replace(/^[=*#◆◇✦\s]+|[=*#◆◇✦\s]+$/g, "").trim() || trimmed;
      hasMatchedHeading = true;
    } else {
      buf.push(rawLine);
    }
  }
  flush();

  if (!hasMatchedHeading) {
    throw new Error("该规则未匹配到任何章节标题，可换个预设或改用“按字数分段”");
  }
  return sections;
}

export async function previewBookResplit(
  repo: Repo,
  bookId: string,
  rule: ResplitRule,
): Promise<ResplitPreview> {
  const book = await getBook(repo, bookId);
  if (!book) throw new Error("找不到该书籍");
  const fullText = reconstructBookText(book);
  const sections = splitTextWithRule(fullText, rule);
  return {
    sectionCount: sections.length,
    sampleTitles: sections.slice(0, 8).map((s) => s.title),
    sections,
  };
}

function buildTermInsertStatements(bookId: string, index: Map<string, number[]>): SqlStatement[] {
  const out: SqlStatement[] = [];
  let values: string[] = [];
  let params: SqlStatement["params"] = [];
  const flush = () => {
    if (!values.length) return;
    out.push({
      sql: `INSERT INTO source_terms(book_id,term,postings) VALUES ${values.join(",")}`,
      params,
    });
    values = [];
    params = [];
  };
  for (const [term, postings] of index) {
    values.push("(?,?,?)");
    params!.push(bookId, term, JSON.stringify(postings));
    if (values.length === 200) flush();
  }
  flush();
  return out;
}

/**
 * Atomically replaces a book's chapters, chunks, and inverted search terms in SQLite
 * without deleting the `source_books` row itself, preserving all references and clamping progress.
 */
export async function applyBookResplit(
  repo: Repo,
  bookId: string,
  rule: ResplitRule,
): Promise<{ sectionCount: number; sampleTitles: string[] }> {
  await ensureReaderSchema(repo.platform);
  const book = await getBook(repo, bookId);
  if (!book) throw new Error("找不到该书籍");
  const fullText = reconstructBookText(book);
  const sections = splitTextWithRule(fullText, rule);
  if (!sections.length) throw new Error("重分章后内容为空");

  const updatedBook: SourceBook = {
    ...book,
    sections,
  };
  const chunks = chunksOf(updatedBook);
  const index = new Map<string, number[]>();
  for (const chunk of chunks) {
    for (const term of terms(chunk.text)) {
      const postings = index.get(term) ?? [];
      postings.push(chunk.ordinal);
      index.set(term, postings);
    }
  }

  const maxSection = Math.max(0, sections.length - 1);
  const statements: SqlStatement[] = [
    { sql: "DELETE FROM source_terms WHERE book_id = ?", params: [bookId] },
    { sql: "DELETE FROM source_chunks WHERE book_id = ?", params: [bookId] },
    { sql: "DELETE FROM source_sections WHERE book_id = ?", params: [bookId] },
    {
      sql: "UPDATE source_books SET json = ? WHERE id = ?",
      params: [JSON.stringify(updatedBook), bookId],
    },
    ...sections.map((s, idx) => ({
      sql: "INSERT INTO source_sections(book_id,section,title,page) VALUES(?,?,?,?)",
      params: [bookId, idx, s.title, s.page ?? null],
    })),
    ...chunks.map((c) => ({
      sql: "INSERT INTO source_chunks(book_id,ordinal,section,text) VALUES(?,?,?,?)",
      params: [bookId, c.ordinal, c.section, c.text],
    })),
    ...buildTermInsertStatements(bookId, index),
    {
      sql: `UPDATE reader_progress
            SET section_index = MIN(section_index, ?), page_index = 0, scroll_ratio = 0
            WHERE target_type = 'book' AND target_id = ? AND section_index > ?`,
      params: [maxSection, bookId, maxSection],
    },
  ];

  await repo.platform.sql.batch(statements);
  return {
    sectionCount: sections.length,
    sampleTitles: sections.slice(0, 8).map((s) => s.title),
  };
}
