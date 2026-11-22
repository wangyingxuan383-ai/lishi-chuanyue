// Lightweight text diff for 改稿预览 and 改后同步: trims common edges and runs
// a bounded LCS over tokens (characters for short edits, clauses for long ones)
// so mobile sheets stay instant even on long passages.

export interface DiffPart {
  kind: "same" | "del" | "ins";
  text: string;
}

const MAX_DP_CELLS = 160_000;

function mergeParts(parts: DiffPart[]): DiffPart[] {
  const out: DiffPart[] = [];
  for (const part of parts) {
    if (!part.text) continue;
    const prev = out[out.length - 1];
    if (prev && prev.kind === part.kind) prev.text += part.text;
    else out.push({ ...part });
  }
  return out;
}

/** Splits text into clause/word chunks when a character-level LCS would exceed the DP cap. */
function chunkTokens(text: string): string[] {
  return text.match(/\n+|[，。！？；：、…—（）「」『』“”"'.!?,;:\s]+|[^，。！？；：、…—（）「」『』“”"'.!?,;:\s\n]+/g) ?? [];
}

function lcsDiff(a: string[], b: string[]): DiffPart[] {
  const n = a.length, m = b.length;
  if (!n && !m) return [];
  if (!n) return [{ kind: "ins", text: b.join("") }];
  if (!m) return [{ kind: "del", text: a.join("") }];
  if (n * m > MAX_DP_CELLS) {
    return [
      { kind: "del", text: a.join("") },
      { kind: "ins", text: b.join("") },
    ];
  }
  const stride = m + 1;
  const dp = new Uint16Array((n + 1) * stride);
  for (let i = n - 1; i >= 0; i--) {
    const row = i * stride, next = (i + 1) * stride;
    for (let j = m - 1; j >= 0; j--) {
      dp[row + j] = a[i] === b[j]
        ? dp[next + j + 1] + 1
        : Math.max(dp[next + j], dp[row + j + 1]);
    }
  }
  const parts: DiffPart[] = [];
  let i = 0, j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      parts.push({ kind: "same", text: a[i] });
      i++; j++;
    } else if (dp[(i + 1) * stride + j] >= dp[i * stride + j + 1]) {
      parts.push({ kind: "del", text: a[i] });
      i++;
    } else {
      parts.push({ kind: "ins", text: b[j] });
      j++;
    }
  }
  while (i < n) parts.push({ kind: "del", text: a[i++] });
  while (j < m) parts.push({ kind: "ins", text: b[j++] });
  return parts;
}

/** Computes a merged inline diff between `before` and `after`. */
export function diffText(before: string, after: string): DiffPart[] {
  if (before === after) return before ? [{ kind: "same", text: before }] : [];
  const aChars = [...before], bChars = [...after];
  let head = 0;
  while (head < aChars.length && head < bChars.length && aChars[head] === bChars[head]) head++;
  let aTail = aChars.length, bTail = bChars.length;
  while (aTail > head && bTail > head && aChars[aTail - 1] === bChars[bTail - 1]) { aTail--; bTail--; }

  const prefix = aChars.slice(0, head).join("");
  const suffix = aChars.slice(aTail).join("");
  const aMid = aChars.slice(head, aTail);
  const bMid = bChars.slice(head, bTail);

  const middle = aMid.length * bMid.length <= MAX_DP_CELLS
    ? lcsDiff(aMid, bMid)
    : lcsDiff(chunkTokens(aMid.join("")), chunkTokens(bMid.join("")));

  return mergeParts([
    ...(prefix ? [{ kind: "same" as const, text: prefix }] : []),
    ...middle,
    ...(suffix ? [{ kind: "same" as const, text: suffix }] : []),
  ]);
}

export function diffStats(parts: DiffPart[]): { added: number; removed: number } {
  let added = 0, removed = 0;
  for (const part of parts) {
    if (part.kind === "ins") added += [...part.text].length;
    else if (part.kind === "del") removed += [...part.text].length;
  }
  return { added, removed };
}
