// Clean accidental Markdown syntax from novel prose (e.g. **bold**, * bullets,
// ### headings, --- horizontal rules) so story turns, Reader volumes, and
// excerpt cards always render as clean book typography without mutating raw DB nodes.

export type CleanProseBlock =
  | { kind: "prose"; text: string }
  | { kind: "divider" };

const HR_LINE_RE = /^[\s\u3000]*(?:-{3,}|\*{3,}|_{3,})[\s\u3000]*$/;
const ATX_HEADING_RE = /^([\s\u3000]*)#{1,6}\s+/;
const BULLET_PREFIX_RE = /^([\s\u3000]*)[-*+]\s+(?=\S)/;
const BOLD_STAR_RE = /\*\*\s*([^*\n]+?)\s*\*\*/g;
const BOLD_UNDER_RE = /__(?=[^\s_])([^_\n]+?)(?<=[^\s_])__/g;

/** Clean inline Markdown emphasis markers from a single line of novel prose. */
export function cleanNovelLine(line: string): string {
  let out = line;
  out = out.replace(ATX_HEADING_RE, "$1");
  out = out.replace(BULLET_PREFIX_RE, "$1");
  // Run twice in case of nested/adjacent emphasis pairs on the same line.
  out = out.replace(BOLD_STAR_RE, "$1").replace(BOLD_STAR_RE, "$1");
  out = out.replace(BOLD_UNDER_RE, "$1");
  return out;
}

/** Parse multi-line novel prose into clean prose paragraphs and scene dividers. */
export function parseNovelProseBlocks(text: string): CleanProseBlock[] {
  if (!text) return [];
  const rawLines = text.split(/\r?\n+/);
  const blocks: CleanProseBlock[] = [];
  for (const raw of rawLines) {
    if (!raw.trim()) continue;
    if (HR_LINE_RE.test(raw)) {
      if (blocks.length > 0 && blocks[blocks.length - 1].kind !== "divider") {
        blocks.push({ kind: "divider" });
      }
      continue;
    }
    const cleaned = cleanNovelLine(raw);
    if (cleaned.trim()) {
      blocks.push({ kind: "prose", text: cleaned });
    }
  }
  if (blocks.length > 1 && blocks[blocks.length - 1].kind === "divider") {
    blocks.pop();
  }
  return blocks;
}

/** Return cleaned plain-text novel prose (horizontal rules become `◇` scene breaks). */
export function cleanNovelProse(text: string, divider = "◇"): string {
  return parseNovelProseBlocks(text)
    .map((b) => (b.kind === "divider" ? divider : b.text))
    .join("\n");
}
