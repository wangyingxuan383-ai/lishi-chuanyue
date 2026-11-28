// Custom & preset chapter re-splitter for imported TXT novels (R36-T003, R41-T006).
// Reconstructs full book text cleanly and updates `source_books`, `source_sections`,
// `source_chunks`, and `source_terms` atomically—using copy-on-write (`forked: true`)
// whenever the original book is referenced by worlds, canon notes, or analysis jobs.
import type { SqlStatement } from "../../platform";
import { newId, type Repo } from "../db/repo";
import {
  chunkStatements,
  chunksOf,
  getBook,
  hasBookExternalReferences,
  indexChunksTermsAsync,
  sectionStatements,
  slimBookJson,
  splitCleanParagraphs,
  termStatements,
} from "./library";
import { checkCancelled } from "./parse";
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

interface RegexGroupFrame {
  hasInnerQuantifier: boolean;
  hasAlternation: boolean;
  branchExposedWildcard: boolean;
  anyBranchExposedWildcard: boolean;
  branchHasAnchor: boolean;
  allBranchesAnchored: boolean;
  atBranchStart: boolean;
}

function readQuantifierAt(pattern: string, pos: number): { len: number; min: number; max: number } | null {
  const ch = pattern[pos];
  if (!ch) return null;
  if (ch === "*") {
    const lazy = pattern[pos + 1] === "?" ? 1 : 0;
    return { len: 1 + lazy, min: 0, max: Infinity };
  }
  if (ch === "+") {
    const lazy = pattern[pos + 1] === "?" ? 1 : 0;
    return { len: 1 + lazy, min: 1, max: Infinity };
  }
  if (ch === "?") {
    const lazy = pattern[pos + 1] === "?" ? 1 : 0;
    return { len: 1 + lazy, min: 0, max: 1 };
  }
  if (ch === "{") {
    const m = /^\{(\d+)(?:,(\d*))?\}(\?)?/.exec(pattern.slice(pos));
    if (m) {
      const min = Number(m[1]);
      const hasComma = m[0].includes(",");
      const max = !hasComma ? min : m[2] ? Number(m[2]) : Infinity;
      return { len: m[0].length, min, max };
    }
  }
  return null;
}

function isBroadWildcardClass(rawClassContent: string): boolean {
  const compact = rawClassContent.trim();
  return (
    compact === "^\\n" ||
    compact === "^\\r\\n" ||
    compact === "^\\n\\r" ||
    compact === "\\s\\S" ||
    compact === "\\S\\s" ||
    compact === "\\d\\D" ||
    compact === "\\D\\d" ||
    compact === "\\w\\W" ||
    compact === "\\W\\w"
  );
}

/**
 * Character- and escape-aware regex validator preventing catastrophic backtracking:
 * 1. Rejects any quantified group (`(...)+`, `(...)*`, `(...)?`, `(...){m,n}`) whose interior
 *    contains sub-quantifiers or alternation `|` (blocks `(a|aa)+`, `((a+))+`, `([a-z]+)*`, `(a|a?)+`).
 * 2. Rejects backreferences (`\1`..`\9`, `\k<name>`).
 * 3. Rejects overlapping adjacent wildcards (`.*.*`, `.+.+`, `^.*\s*.*$`), >=2 unanchored wildcards,
 *    or >=3 broad wildcards in a single line expression.
 * 4. Preserves normal Chinese chapter patterns including unquantified groups `(?:楔子|序章|第.+章).*`.
 */
export function compileSafeLineRegex(pattern: string): RegExp {
  const trimmed = pattern.trim();
  if (!trimmed) throw new Error("请输入正则表达式");
  if (trimmed.length > 180) throw new Error("正则表达式过长（最多 180 个字符）");

  const stack: RegexGroupFrame[] = [];
  let topExposedWildcard = false;
  let topBranchAnchored = false;
  let topAllBranchesAnchored = true;
  let topAtStart = true;
  let wildcardCount = 0;

  const markQuantifierInScope = () => {
    if (stack.length > 0) {
      stack[stack.length - 1]!.hasInnerQuantifier = true;
    }
  };

  const getExposedWildcard = () =>
    stack.length > 0 ? stack[stack.length - 1]!.branchExposedWildcard : topExposedWildcard;

  const setExposedWildcard = (val: boolean) => {
    if (stack.length > 0) {
      stack[stack.length - 1]!.branchExposedWildcard = val;
    } else {
      topExposedWildcard = val;
    }
  };

  const markNonStartToken = () => {
    if (stack.length > 0) {
      stack[stack.length - 1]!.atBranchStart = false;
    } else {
      topAtStart = false;
    }
  };

  let i = 0;
  while (i < trimmed.length) {
    const ch = trimmed[i]!;

    if (ch === "\\") {
      const next = trimmed[i + 1];
      if (!next) {
        throw new Error("正则表达式语法有误，请检查括号或转义符");
      }
      if (/^[1-9]$/.test(next) || next === "k") {
        throw new Error("正则表达式不支持反向引用（如 \\1），请简化写法");
      }
      let atomEnd = i + 2;
      if ((next === "p" || next === "P" || next === "u") && trimmed[atomEnd] === "{") {
        const closeBrace = trimmed.indexOf("}", atomEnd + 1);
        if (closeBrace > atomEnd) atomEnd = closeBrace + 1;
      } else if (next === "x" && /^[0-9a-fA-F]{2}/.test(trimmed.slice(atomEnd, atomEnd + 2))) {
        atomEnd += 2;
      } else if (next === "u" && /^[0-9a-fA-F]{4}/.test(trimmed.slice(atomEnd, atomEnd + 4))) {
        atomEnd += 4;
      }
      markNonStartToken();
      const q = readQuantifierAt(trimmed, atomEnd);
      if (q) {
        markQuantifierInScope();
        if (q.min > 0 && !["b", "B", "s", "S"].includes(next)) {
          setExposedWildcard(false);
        }
        i = atomEnd + q.len;
      } else {
        if (!["b", "B"].includes(next)) {
          setExposedWildcard(false);
        }
        i = atomEnd;
      }
      continue;
    }

    if (ch === "[") {
      let j = i + 1;
      if (trimmed[j] === "^") j++;
      if (trimmed[j] === "]") j++;
      let closed = false;
      while (j < trimmed.length) {
        if (trimmed[j] === "\\") {
          j += 2;
          continue;
        }
        if (trimmed[j] === "]") {
          closed = true;
          break;
        }
        j++;
      }
      if (!closed) {
        throw new Error("正则表达式语法有误，请检查括号或转义符");
      }
      const classBody = trimmed.slice(i + 1, j);
      const broadClass = isBroadWildcardClass(classBody);
      markNonStartToken();
      const q = readQuantifierAt(trimmed, j + 1);
      if (q) {
        markQuantifierInScope();
        if (broadClass && q.max > 1) {
          if (getExposedWildcard()) {
            throw new Error("正则表达式包含重叠通配符，可能导致卡顿，请简化写法");
          }
          wildcardCount += 1;
          setExposedWildcard(true);
        } else if (q.min > 0 && !broadClass) {
          setExposedWildcard(false);
        }
        i = j + 1 + q.len;
      } else {
        if (!broadClass) setExposedWildcard(false);
        i = j + 1;
      }
      continue;
    }

    if (ch === "(") {
      let headerLen = 1;
      if (trimmed[i + 1] === "?") {
        const rest = trimmed.slice(i + 2);
        if (rest.startsWith(":") || rest.startsWith("=") || rest.startsWith("!")) {
          headerLen = 3;
        } else if (rest.startsWith("<=") || rest.startsWith("<!")) {
          headerLen = 4;
        } else if (rest.startsWith("<")) {
          const closeAngle = rest.indexOf(">");
          if (closeAngle > 1) {
            headerLen = 2 + closeAngle + 1;
          }
        }
      }
      const parentAtStart = stack.length > 0 ? stack[stack.length - 1]!.atBranchStart : topAtStart;
      stack.push({
        hasInnerQuantifier: false,
        hasAlternation: false,
        branchExposedWildcard: getExposedWildcard(),
        anyBranchExposedWildcard: false,
        branchHasAnchor: parentAtStart ? (stack.length > 0 ? stack[stack.length - 1]!.branchHasAnchor : topBranchAnchored) : false,
        allBranchesAnchored: true,
        atBranchStart: parentAtStart,
      });
      i += headerLen;
      continue;
    }

    if (ch === "|") {
      if (stack.length > 0) {
        const top = stack[stack.length - 1]!;
        top.hasAlternation = true;
        if (top.branchExposedWildcard) top.anyBranchExposedWildcard = true;
        if (!top.branchHasAnchor) top.allBranchesAnchored = false;
        const parentExposed = stack.length >= 2 ? stack[stack.length - 2]!.branchExposedWildcard : topExposedWildcard;
        const parentAnchored = stack.length >= 2 ? stack[stack.length - 2]!.branchHasAnchor : topBranchAnchored;
        const parentAtStart = stack.length >= 2 ? stack[stack.length - 2]!.atBranchStart : topAtStart;
        top.branchExposedWildcard = parentExposed;
        top.branchHasAnchor = parentAtStart ? parentAnchored : false;
        top.atBranchStart = parentAtStart;
      } else {
        if (!topBranchAnchored) topAllBranchesAnchored = false;
        topBranchAnchored = false;
        topAtStart = true;
        topExposedWildcard = false;
      }
      i += 1;
      continue;
    }

    if (ch === ")") {
      const frame = stack.pop();
      if (!frame) {
        throw new Error("正则表达式语法有误，请检查括号或转义符");
      }
      const groupExposedWildcard = frame.anyBranchExposedWildcard || frame.branchExposedWildcard;
      const groupAllAnchored = frame.allBranchesAnchored && frame.branchHasAnchor;
      const q = readQuantifierAt(trimmed, i + 1);
      if (q) {
        if (frame.hasInnerQuantifier || frame.hasAlternation) {
          throw new Error("正则表达式包含嵌套量词或带量词的分支结构，可能导致卡顿，请简化写法");
        }
        markQuantifierInScope();
        if (q.min === 0) {
          // Optional group keeps prior exposed wildcard state if it could match empty
          if (groupExposedWildcard) setExposedWildcard(true);
        } else {
          setExposedWildcard(groupExposedWildcard);
        }
        markNonStartToken();
        i += 1 + q.len;
      } else {
        if (frame.hasInnerQuantifier) markQuantifierInScope();
        if (frame.hasAlternation && stack.length > 0) {
          stack[stack.length - 1]!.hasAlternation = true;
        }
        if (groupAllAnchored) {
          if (stack.length > 0) stack[stack.length - 1]!.branchHasAnchor = true;
          else topBranchAnchored = true;
        }
        setExposedWildcard(groupExposedWildcard);
        markNonStartToken();
        i += 1;
      }
      continue;
    }

    if (ch === "^") {
      if (stack.length > 0) {
        if (stack[stack.length - 1]!.atBranchStart) {
          stack[stack.length - 1]!.branchHasAnchor = true;
        }
      } else if (topAtStart) {
        topBranchAnchored = true;
      }
      i += 1;
      continue;
    }

    if (ch === "$") {
      i += 1;
      continue;
    }

    if (ch === ".") {
      markNonStartToken();
      const q = readQuantifierAt(trimmed, i + 1);
      if (q) {
        markQuantifierInScope();
        if (q.max > 1) {
          if (getExposedWildcard()) {
            throw new Error("正则表达式包含重叠通配符（如 .*.*），可能导致卡顿，请简化写法");
          }
          wildcardCount += 1;
          setExposedWildcard(true);
        } else if (q.min > 0) {
          setExposedWildcard(false);
        }
        i += 1 + q.len;
      } else {
        setExposedWildcard(false);
        i += 1;
      }
      continue;
    }

    // Any other literal or standalone quantifier
    const standaloneQ = readQuantifierAt(trimmed, i);
    if (standaloneQ) {
      throw new Error("正则表达式语法有误，量词前缺少匹配内容");
    }

    markNonStartToken();
    const q = readQuantifierAt(trimmed, i + 1);
    if (q) {
      markQuantifierInScope();
      if (q.min > 0 && !/\s/.test(ch)) {
        setExposedWildcard(false);
      }
      i += 1 + q.len;
    } else {
      if (!/\s/.test(ch)) {
        setExposedWildcard(false);
      }
      i += 1;
    }
  }

  if (stack.length > 0) {
    throw new Error("正则表达式语法有误，请检查括号或转义符");
  }

  const anchoredAtStart = topAllBranchesAnchored && topBranchAnchored;
  if (!anchoredAtStart && wildcardCount >= 2) {
    throw new Error("正则表达式包含两处以上无锚重叠通配，可能导致卡顿，请简化写法");
  }
  if (wildcardCount >= 3) {
    throw new Error("正则表达式包含过多通配符，可能导致卡顿，请简化写法");
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

export const DEFAULT_RESPLIT_TIMEOUT_MS = 800;

export function splitTextWithRule(
  rawText: string,
  rule: ResplitRule,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): BookSection[] {
  checkCancelled(opts?.signal);
  const startedAt = typeof performance !== "undefined" ? performance.now() : Date.now();
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RESPLIT_TIMEOUT_MS;
  const checkBudget = () => {
    checkCancelled(opts?.signal);
    const now = typeof performance !== "undefined" ? performance.now() : Date.now();
    if (timeoutMs > 0 && now - startedAt > timeoutMs) {
      throw new Error("章节匹配超时，请简化正则表达式或换用预设规则");
    }
  };

  const normalized = cleanBody(rawText);
  if (!normalized) return [];

  if (rule.preset === "fixed_length") {
    checkBudget();
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

  for (let idx = 0; idx < lines.length; idx++) {
    if (rule.preset === "custom" || (idx & 255) === 0) {
      checkBudget();
    }
    const rawLine = lines[idx]!;
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

export const RESPLIT_WORKER_SOURCE = String.raw`
const STANDARD_RE = new RegExp(${JSON.stringify(STANDARD_RE.source)}, ${JSON.stringify(STANDARD_RE.flags)});
const NUMBERED_RE = new RegExp(${JSON.stringify(NUMBERED_RE.source)}, ${JSON.stringify(NUMBERED_RE.flags)});
const SYMBOLS_RE = new RegExp(${JSON.stringify(SYMBOLS_RE.source)}, ${JSON.stringify(SYMBOLS_RE.flags)});
const FRONT_MATTER_KEYWORD_RE = new RegExp(${JSON.stringify(FRONT_MATTER_KEYWORD_RE.source)}, ${JSON.stringify(FRONT_MATTER_KEYWORD_RE.flags)});

function cleanBody(s) {
  return String(s || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[\t \u00a0]+/g, " ")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function inferFrontMatterTitle(body) {
  const rawFirst = (body.split("\n")[0] || "").trim();
  if (!rawFirst) return "前言";
  const cleaned = rawFirst.replace(/^[=*#◆◇✦\s]+|[=*#◆◇✦\s]+$/g, "").trim();
  const match = FRONT_MATTER_KEYWORD_RE.exec(cleaned);
  if (!match) return "前言";
  const colonIdx = cleaned.search(/[：:]/);
  if (colonIdx > 0 && colonIdx <= 12) {
    const label = cleaned.slice(0, colonIdx).trim();
    if (FRONT_MATTER_KEYWORD_RE.test(label)) return label;
  }
  if (cleaned.length <= 24 && !/[。！？；]$/.test(cleaned)) {
    return cleaned;
  }
  return match[1];
}

function splitByFixedLength(rawText, targetChars = 4000) {
  const safeTarget = Math.min(20000, Math.max(800, Math.round(targetChars)));
  const paras = rawText
    .split(/\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paras.length) return [];

  const sections = [];
  let buf = [];
  let len = 0;

  const flush = () => {
    if (!buf.length) return;
    const body = buf.join("\n\n");
    const idx = sections.length + 1;
    const firstSnippet = buf[0]
      .replace(/^[“「『\s]+/, "")
      .slice(0, 12)
      .replace(/[，。！？；：,.!?;:]+$/, "");
    sections.push({
      title: firstSnippet ? "第 " + idx + " 节 · " + firstSnippet : "第 " + idx + " 节",
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

self.onmessage = (ev) => {
  try {
    const { rawText, rule } = ev.data || {};
    const normalized = cleanBody(String(rawText || ""));
    if (!normalized) {
      self.postMessage({ ok: true, sections: [] });
      return;
    }
    if (rule.preset === "fixed_length") {
      self.postMessage({ ok: true, sections: splitByFixedLength(normalized, rule.fixedChars ?? 4000) });
      return;
    }
    const matcher =
      rule.preset === "standard"
        ? STANDARD_RE
        : rule.preset === "numbered"
          ? NUMBERED_RE
          : rule.preset === "symbols"
            ? SYMBOLS_RE
            : new RegExp(String(rule.customPattern || "").trim(), "i");
    const lines = normalized.split("\n");
    const sections = [];
    let currentTitle = "序言 / 开篇";
    let hasMatchedHeading = false;
    let buf = [];
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
    for (let i = 0; i < lines.length; i++) {
      const rawLine = lines[i];
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
      self.postMessage({ ok: false, error: "该规则未匹配到任何章节标题，可换个预设或改用“按字数分段”" });
      return;
    }
    self.postMessage({ ok: true, sections });
  } catch (err) {
    self.postMessage({ ok: false, error: err && err.message ? String(err.message) : "分章失败" });
  }
};
`;

/**
 * Asynchronous, abortable, hard-time-bounded (`800ms` default) chapter splitter.
 * Uses an isolated `Blob` Web Worker in browser environments so extreme inputs can be
 * terminated instantaneously via `worker.terminate()` without blocking the UI thread,
 * and falls back cleanly to synchronous safe validation + budget checks in Node/Vitest.
 */
export async function splitTextWithRuleAsync(
  rawText: string,
  rule: ResplitRule,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<BookSection[]> {
  const signal = opts?.signal;
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_RESPLIT_TIMEOUT_MS;
  checkCancelled(signal);

  // Always validate custom regex syntax and backtracking safety upfront before spawning a worker.
  if (rule.preset === "custom") {
    compileSafeLineRegex(rule.customPattern ?? "");
  }

  const canUseBlobWorker =
    typeof Worker === "function" &&
    typeof Blob === "function" &&
    typeof URL !== "undefined" &&
    typeof URL.createObjectURL === "function" &&
    typeof URL.revokeObjectURL === "function";

  if (canUseBlobWorker) {
    let blobUrl: string | null = null;
    let worker: Worker | null = null;
    try {
      const blob = new Blob([RESPLIT_WORKER_SOURCE], { type: "application/javascript" });
      blobUrl = URL.createObjectURL(blob);
      worker = new Worker(blobUrl);
    } catch {
      if (blobUrl) URL.revokeObjectURL(blobUrl);
      worker = null;
      blobUrl = null;
    }

    if (worker && blobUrl) {
      const activeWorker = worker;
      const activeUrl = blobUrl;
      return await new Promise<BookSection[]>((resolve, reject) => {
        let settled = false;
        const cleanup = () => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          signal?.removeEventListener("abort", onAbort);
          try {
            activeWorker.terminate();
          } catch {
            /* ignore */
          }
          try {
            URL.revokeObjectURL(activeUrl);
          } catch {
            /* ignore */
          }
        };
        const onAbort = () => {
          cleanup();
          reject(new DOMException("已取消", "AbortError"));
        };
        const timer = setTimeout(() => {
          cleanup();
          reject(new Error("章节匹配超时，请简化正则表达式或换用预设规则"));
        }, Math.max(50, timeoutMs));

        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });

        activeWorker.onmessage = (ev: MessageEvent<{ ok?: boolean; sections?: BookSection[]; error?: string }>) => {
          const payload = ev.data;
          cleanup();
          if (payload?.ok && Array.isArray(payload.sections)) {
            resolve(payload.sections);
          } else {
            reject(new Error(payload?.error || "分章失败"));
          }
        };
        activeWorker.onerror = (ev) => {
          cleanup();
          reject(new Error(ev?.message || "分章工作线程异常"));
        };
        activeWorker.postMessage({ rawText, rule });
      });
    }
  }

  return splitTextWithRule(rawText, rule, { signal, timeoutMs });
}

export interface LocatedBookSnippet {
  sectionIndex: number;
  sectionTitle: string;
  paragraphIndex: number;
  charStart: number;
  charEnd: number;
}

/**
 * Builds a memoized paragraph snippet locator across `sections` for re-anchoring
 * `reader_bookmarks`, `reader_highlights`, and `reader_progress` after chapter re-splitting
 * or in-place novel re-compilation.
 */
export function createSectionSnippetLocator(sections: BookSection[], oldSectionCount: number) {
  const maxSection = Math.max(0, sections.length - 1);
  const paraCache = new Map<number, { text: string; start: number; end: number }[]>();
  const getParas = (secIdx: number) => {
    let p = paraCache.get(secIdx);
    if (!p) {
      p = splitCleanParagraphs(sections[secIdx]!.text);
      paraCache.set(secIdx, p);
    }
    return p;
  };

  const locateSnippet = (rawNeedle: string, oldSecIdx: number): LocatedBookSnippet | null => {
    const needle = rawNeedle.trim();
    if (!needle || !sections.length) return null;
    const shortNeedle = needle.replace(/\s+/g, " ").slice(0, 24).trim();
    const hint = Math.min(
      maxSection,
      Math.max(0, Math.round((Math.max(0, oldSecIdx) / Math.max(1, oldSectionCount - 1)) * maxSection)),
    );

    const checkSection = (sIdx: number, exactOnly: boolean): LocatedBookSnippet | null => {
      const sec = sections[sIdx]!;
      if (exactOnly) {
        if (!sec.text.includes(needle)) return null;
        const paras = getParas(sIdx);
        for (let pIdx = 0; pIdx < paras.length; pIdx++) {
          const pos = paras[pIdx]!.text.indexOf(needle);
          if (pos >= 0) {
            return {
              sectionIndex: sIdx,
              sectionTitle: sec.title,
              paragraphIndex: pIdx,
              charStart: pos,
              charEnd: pos + needle.length,
            };
          }
        }
        return null;
      }
      if (shortNeedle.length < 4 || !sec.text.includes(shortNeedle)) return null;
      const paras = getParas(sIdx);
      for (let pIdx = 0; pIdx < paras.length; pIdx++) {
        const pText = paras[pIdx]!.text;
        const pos = pText.indexOf(shortNeedle);
        if (pos >= 0) {
          const end = Math.min(pText.length, Math.max(pos + shortNeedle.length, pos + needle.length));
          return {
            sectionIndex: sIdx,
            sectionTitle: sec.title,
            paragraphIndex: pIdx,
            charStart: pos,
            charEnd: end,
          };
        }
      }
      return null;
    };

    for (const exactOnly of [true, false]) {
      for (let delta = 0; delta <= maxSection; delta++) {
        const left = hint - delta;
        if (left >= 0) {
          const hit = checkSection(left, exactOnly);
          if (hit) return hit;
        }
        const right = hint + delta;
        if (delta > 0 && right <= maxSection) {
          const hit = checkSection(right, exactOnly);
          if (hit) return hit;
        }
        if (left < 0 && right > maxSection) break;
      }
    }
    return null;
  };

  return { maxSection, getParas, locateSnippet };
}

export async function previewBookResplit(
  repo: Repo,
  bookId: string,
  rule: ResplitRule,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<ResplitPreview> {
  const book = await getBook(repo, bookId);
  if (!book) throw new Error("找不到该书籍");
  const fullText = reconstructBookText(book);
  const sections = await splitTextWithRuleAsync(fullText, rule, opts);
  return {
    sectionCount: sections.length,
    sampleTitles: sections.slice(0, 8).map((s) => s.title),
    sections,
  };
}

export interface ApplyBookResplitResult {
  bookId: string;
  forked: boolean;
  title: string;
  sectionCount: number;
  sampleTitles: string[];
}

function nextForkedResplitTitle(currentTitle: string, usedTitles: ReadonlySet<string>): string {
  const base = currentTitle.replace(/（重分章(?:\s*\d+)?）$/, "").trim() || currentTitle;
  const firstCandidate = `${base}（重分章）`;
  if (!currentTitle.endsWith("（重分章）") && !usedTitles.has(firstCandidate)) {
    return firstCandidate;
  }
  let n = 2;
  while (usedTitles.has(`${base}（重分章 ${n}）`)) {
    n += 1;
  }
  return `${base}（重分章 ${n}）`;
}

/**
 * Rebuilds a book's chapters, chunks, and inverted search terms:
 * - When `bookId` has ZERO external world/note/job references, atomically updates `bookId` in-place
 *   and re-anchors `reader_bookmarks`, `reader_highlights`, and `reader_progress` (`forked: false`).
 * - When `bookId` IS referenced by any world snapshot/citation/revision/task, `canon_notes`, or
 *   `source_jobs`, preserves `bookId` 100% untouched (guaranteeing archive & provenance integrity),
 *   saves the re-split edition under a fresh `newBookId`, clones shelf preferences and re-anchored
 *   reader annotations, and returns `{ bookId: newBookId, forked: true }`.
 */
export async function applyBookResplit(
  repo: Repo,
  bookId: string,
  rule: ResplitRule,
  opts?: { signal?: AbortSignal; timeoutMs?: number; precomputedSections?: BookSection[] },
): Promise<ApplyBookResplitResult> {
  const signal = opts?.signal;
  checkCancelled(signal);

  let bookHeader: { id: string; title: string; format: SourceBook["format"]; createdAt: string };
  let sections: BookSection[];

  const [oldSecCountRow] = await repo.platform.sql
    .query("SELECT COUNT(*) AS cnt FROM source_sections WHERE book_id = ?", [bookId])
    .catch(() => []);
  const oldSectionCount = Math.max(1, Number(oldSecCountRow?.cnt ?? 1));

  if (opts?.precomputedSections) {
    const [headerRow] = await repo.platform.sql.query(
      "SELECT id, title, format, created_at FROM source_books WHERE id = ?",
      [bookId],
    );
    if (!headerRow) throw new Error("找不到该书籍");
    bookHeader = {
      id: String(headerRow.id),
      title: String(headerRow.title),
      format: String(headerRow.format) as SourceBook["format"],
      createdAt: String(headerRow.created_at),
    };
    sections = opts.precomputedSections;
  } else {
    const book = await getBook(repo, bookId);
    if (!book) throw new Error("找不到该书籍");
    checkCancelled(signal);
    const fullText = reconstructBookText(book);
    sections = await splitTextWithRuleAsync(fullText, rule, { signal, timeoutMs: opts?.timeoutMs });
    bookHeader = {
      id: book.id,
      title: book.title,
      format: book.format,
      createdAt: book.createdAt,
    };
  }

  if (!sections.length) throw new Error("重分章后内容为空");

  const hasExternalRefs = await hasBookExternalReferences(repo, bookId);
  checkCancelled(signal);

  const targetBookId = hasExternalRefs ? newId() : bookId;
  const nowIso = new Date().toISOString();
  let resolvedBookTitle = bookHeader.title;
  if (hasExternalRefs) {
    const titleRows = await repo.platform.sql
      .query("SELECT title FROM source_books")
      .catch(() => []);
    const usedTitles = new Set(titleRows.map((r) => String(r.title ?? "")));
    resolvedBookTitle = nextForkedResplitTitle(bookHeader.title, usedTitles);
  }
  const updatedBook: SourceBook = {
    id: targetBookId,
    title: resolvedBookTitle,
    format: bookHeader.format,
    createdAt: hasExternalRefs ? nowIso : bookHeader.createdAt,
    sections,
  };
  const chunks = chunksOf(updatedBook);
  const index = await indexChunksTermsAsync(chunks, signal);
  checkCancelled(signal);

  const tableRows = await repo.platform.sql.query(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('canon_facts','source_analysis','source_jobs','reader_progress','reader_bookmarks','reader_highlights')",
  );
  const existingTables = new Set(tableRows.map((r) => String(r.name)));

  const { maxSection, getParas, locateSnippet } = createSectionSnippetLocator(sections, oldSectionCount);
  const annotationStmts: SqlStatement[] = [];

  if (existingTables.has("reader_bookmarks")) {
    const bmRows = await repo.platform.sql.query(
      "SELECT id, section_index, snippet, node_id, created_at FROM reader_bookmarks WHERE target_type = 'book' AND target_id = ?",
      [bookId],
    );
    for (const r of bmRows) {
      const oldSec = Number(r.section_index ?? 0);
      const hit = locateSnippet(String(r.snippet ?? ""), oldSec);
      const nextSec = hit ? hit.sectionIndex : Math.min(maxSection, Math.max(0, oldSec));
      const nextTitle = hit ? hit.sectionTitle : sections[nextSec]!.title;
      const nextPara = hit ? hit.paragraphIndex : 0;
      if (hasExternalRefs) {
        annotationStmts.push({
          sql: `INSERT INTO reader_bookmarks (
                  id, target_type, target_id, section_index, section_title, snippet, paragraph_index, node_id, created_at
                ) VALUES (?, 'book', ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            newId(),
            targetBookId,
            nextSec,
            nextTitle,
            String(r.snippet ?? ""),
            nextPara,
            r.node_id == null ? null : String(r.node_id),
            String(r.created_at ?? nowIso),
          ],
        });
      } else {
        annotationStmts.push({
          sql: "UPDATE reader_bookmarks SET section_index = ?, section_title = ?, paragraph_index = ? WHERE id = ?",
          params: [nextSec, nextTitle, nextPara, String(r.id)],
        });
      }
    }
  }

  if (existingTables.has("reader_highlights")) {
    const hlRows = await repo.platform.sql.query(
      "SELECT id, world_id, section_index, char_start, char_end, selected_text, note, color, node_id, created_at, updated_at FROM reader_highlights WHERE target_type = 'book' AND target_id = ?",
      [bookId],
    );
    for (const r of hlRows) {
      const oldSec = Number(r.section_index ?? 0);
      const hit = locateSnippet(String(r.selected_text ?? ""), oldSec);
      const clamped = Math.min(maxSection, Math.max(0, oldSec));
      const nextSec = hit ? hit.sectionIndex : clamped;
      const nextTitle = hit ? hit.sectionTitle : sections[clamped]!.title;
      const nextPara = hit ? hit.paragraphIndex : 0;
      const nextStart = hit ? hit.charStart : Number(r.char_start ?? 0);
      const nextEnd = hit ? hit.charEnd : Number(r.char_end ?? 0);
      if (hasExternalRefs) {
        annotationStmts.push({
          sql: `INSERT INTO reader_highlights (
                  id, target_type, target_id, world_id, section_index, section_title,
                  paragraph_index, char_start, char_end, selected_text, note, color,
                  node_id, created_at, updated_at
                ) VALUES (?, 'book', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          params: [
            newId(),
            targetBookId,
            r.world_id == null ? null : String(r.world_id),
            nextSec,
            nextTitle,
            nextPara,
            nextStart,
            nextEnd,
            String(r.selected_text ?? ""),
            String(r.note ?? ""),
            String(r.color ?? "cinnabar"),
            r.node_id == null ? null : String(r.node_id),
            String(r.created_at ?? nowIso),
            String(r.updated_at ?? nowIso),
          ],
        });
      } else if (hit) {
        annotationStmts.push({
          sql: "UPDATE reader_highlights SET section_index = ?, section_title = ?, paragraph_index = ?, char_start = ?, char_end = ? WHERE id = ?",
          params: [nextSec, nextTitle, nextPara, nextStart, nextEnd, String(r.id)],
        });
      } else {
        annotationStmts.push({
          sql: "UPDATE reader_highlights SET section_index = ?, section_title = ?, paragraph_index = 0 WHERE id = ?",
          params: [clamped, sections[clamped]!.title, String(r.id)],
        });
      }
    }
  }

  if (existingTables.has("reader_progress")) {
    const progRows = await repo.platform.sql.query(
      "SELECT section_index, page_index, scroll_ratio, anchor_text, node_id FROM reader_progress WHERE target_type = 'book' AND target_id = ?",
      [bookId],
    );
    if (progRows[0]) {
      const pRow = progRows[0];
      const oldSec = Number(pRow.section_index ?? 0);
      const hit = locateSnippet(String(pRow.anchor_text ?? ""), oldSec);
      if (hasExternalRefs) {
        const nextSec = hit ? hit.sectionIndex : Math.min(maxSection, Math.max(0, oldSec));
        const paras = hit ? getParas(hit.sectionIndex) : [];
        const nextRatio = hit
          ? paras.length > 1
            ? Number((hit.paragraphIndex / (paras.length - 1)).toFixed(4))
            : 0
          : oldSec > maxSection
            ? 0
            : Number(pRow.scroll_ratio ?? 0);
        const nextPage = hit || oldSec > maxSection ? 0 : Number(pRow.page_index ?? 0);
        annotationStmts.push({
          sql: `INSERT INTO reader_progress (
                  target_type, target_id, section_index, page_index, scroll_ratio, anchor_text, node_id, updated_at
                ) VALUES ('book', ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(target_type, target_id) DO UPDATE SET
                  section_index = excluded.section_index,
                  page_index = excluded.page_index,
                  scroll_ratio = excluded.scroll_ratio,
                  anchor_text = excluded.anchor_text,
                  node_id = excluded.node_id,
                  updated_at = excluded.updated_at`,
          params: [
            targetBookId,
            nextSec,
            nextPage,
            nextRatio,
            String(pRow.anchor_text ?? ""),
            pRow.node_id == null ? null : String(pRow.node_id),
            nowIso,
          ],
        });
      } else if (hit) {
        const paras = getParas(hit.sectionIndex);
        const approxRatio = paras.length > 1 ? Number((hit.paragraphIndex / (paras.length - 1)).toFixed(4)) : 0;
        annotationStmts.push({
          sql: `UPDATE reader_progress
                SET section_index = ?, page_index = 0, scroll_ratio = ?
                WHERE target_type = 'book' AND target_id = ?`,
          params: [hit.sectionIndex, approxRatio, bookId],
        });
      } else {
        annotationStmts.push({
          sql: `UPDATE reader_progress
                SET section_index = MIN(section_index, ?), page_index = 0, scroll_ratio = 0
                WHERE target_type = 'book' AND target_id = ? AND section_index > ?`,
          params: [maxSection, bookId, maxSection],
        });
      }
    }
  }

  checkCancelled(signal);

  if (hasExternalRefs) {
    const forkStatements: SqlStatement[] = [
      {
        sql: "INSERT INTO source_books(id,title,format,created_at,json) VALUES(?,?,?,?,?)",
        params: [
          updatedBook.id,
          updatedBook.title,
          updatedBook.format,
          updatedBook.createdAt,
          slimBookJson(updatedBook),
        ],
      },
      ...sectionStatements(targetBookId, sections),
      ...chunkStatements(targetBookId, chunks),
      ...termStatements(targetBookId, index),
      ...annotationStmts,
    ];
    await repo.platform.sql.batch(forkStatements);

    const existingPrefs = await repo.getSetting<Record<string, unknown> | null>("reader:bookPrefs", null);
    if (
      existingPrefs &&
      typeof existingPrefs === "object" &&
      !Array.isArray(existingPrefs) &&
      existingPrefs[bookId] &&
      typeof existingPrefs[bookId] === "object"
    ) {
      const srcPref = existingPrefs[bookId] as Record<string, unknown>;
      const wasPinned = srcPref.pinned === true;
      const clonedPref: Record<string, unknown> = {
        pinned: wasPinned,
        coverTone: typeof srcPref.coverTone === "number" ? srcPref.coverTone : null,
        finished: srcPref.finished === true,
        author: typeof srcPref.author === "string" ? srcPref.author : "",
        ...(typeof srcPref.origin === "string" && srcPref.origin !== "world-novel"
          ? { origin: srcPref.origin }
          : {}),
      };
      await repo.setSetting("reader:bookPrefs", {
        ...existingPrefs,
        ...(wasPinned ? { [bookId]: { ...srcPref, pinned: false } } : {}),
        [targetBookId]: clonedPref,
      });
    }

    if (typeof window !== "undefined" && typeof window.dispatchEvent === "function") {
      window.dispatchEvent(new CustomEvent("lishi:library-changed", { detail: { bookId: targetBookId } }));
    }

    return {
      bookId: targetBookId,
      forked: true,
      title: updatedBook.title,
      sectionCount: sections.length,
      sampleTitles: sections.slice(0, 8).map((s) => s.title),
    };
  }

  const statements: SqlStatement[] = [
    ...(existingTables.has("canon_facts")
      ? [{ sql: "DELETE FROM canon_facts WHERE book_id = ?", params: [bookId] }]
      : []),
    ...(existingTables.has("source_analysis")
      ? [{ sql: "DELETE FROM source_analysis WHERE book_id = ?", params: [bookId] }]
      : []),
    ...(existingTables.has("source_jobs")
      ? [{ sql: "DELETE FROM source_jobs WHERE book_id = ?", params: [bookId] }]
      : []),
    { sql: "DELETE FROM source_terms WHERE book_id = ?", params: [bookId] },
    { sql: "DELETE FROM source_chunks WHERE book_id = ?", params: [bookId] },
    { sql: "DELETE FROM source_sections WHERE book_id = ?", params: [bookId] },
    {
      sql: "UPDATE source_books SET json = ? WHERE id = ?",
      params: [slimBookJson(updatedBook), bookId],
    },
    ...sectionStatements(bookId, sections),
    ...chunkStatements(bookId, chunks),
    ...termStatements(bookId, index),
    ...annotationStmts,
  ];

  await repo.platform.sql.batch(statements);

  const existingPrefs = await repo.getSetting<Record<string, unknown> | null>("reader:bookPrefs", null);
  if (
    existingPrefs &&
    typeof existingPrefs === "object" &&
    !Array.isArray(existingPrefs) &&
    existingPrefs[bookId] &&
    typeof existingPrefs[bookId] === "object"
  ) {
    const srcPref = existingPrefs[bookId] as Record<string, unknown>;
    if (srcPref.origin === "world-novel" || srcPref.sourceWorldId) {
      const detachedPref: Record<string, unknown> = {
        ...srcPref,
        origin: "imported",
      };
      delete detachedPref.sourceWorldId;
      delete detachedPref.sourceLineId;
      await repo.setSetting("reader:bookPrefs", {
        ...existingPrefs,
        [bookId]: detachedPref,
      });
    }
  }

  return {
    bookId,
    forked: false,
    title: updatedBook.title,
    sectionCount: sections.length,
    sampleTitles: sections.slice(0, 8).map((s) => s.title),
  };
}
