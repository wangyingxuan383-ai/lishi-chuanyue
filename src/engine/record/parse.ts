// Lenient parsing of the record block into a TurnRecord. Whatever can be
// understood is kept; malformed parts are dropped and reported in `issues`.
import type { TurnRecord } from "../state/apply";

export interface ParsedRecord {
  record: TurnRecord | null;
  issues: string[];
}

/** Tries progressively stronger repairs on a JSON-ish object string. */
export function lenientJson(text: string): unknown {
  let body = text.replace(/<\s*\/?\s*record\s*>/gi, "").replace(/```(?:json)?/gi, "");
  const start = body.indexOf("{");
  if (start < 0) return null;
  body = body.slice(start);
  const end = body.lastIndexOf("}");
  const candidates: string[] = [];
  if (end > 0) candidates.push(body.slice(0, end + 1));
  candidates.push(closeBrackets(body));
  for (const base of candidates) {
    for (const repair of REPAIRS) {
      try {
        return JSON.parse(repair(base));
      } catch {
        /* try the next repair */
      }
    }
  }
  return null;
}

const REPAIRS: Array<(s: string) => string> = [
  (s) => s,
  (s) => s.replace(/,\s*([}\]])/g, "$1"), // trailing commas
  (s) => quoteKeys(s.replace(/,\s*([}\]])/g, "$1")), // unquoted keys
  (s) => quoteKeys(s.replace(/,\s*([}\]])/g, "$1")).replace(/'/g, '"'), // single quotes
  (s) => s.replace(/[“”]/g, '"').replace(/,\s*([}\]])/g, "$1"), // smart quotes used as delimiters
];

function quoteKeys(s: string): string {
  return s.replace(/([{,]\s*)([A-Za-z_][A-Za-z0-9_]*)\s*:/g, '$1"$2":');
}

/** Closes unterminated strings, arrays and objects of a truncated reply. */
function closeBrackets(s: string): string {
  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  let lastSafe = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") stack.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") stack.pop();
    if (!inString && (c === "," || c === "{" || c === "[" || c === "}" || c === "]")) lastSafe = i + 1;
  }
  // Cut back to the last complete element, then close what is open.
  let out = inString ? s.slice(0, lastSafe) : s;
  out = out.replace(/[,:\s]+$/, "");
  const opened: string[] = [];
  inString = false;
  escaped = false;
  for (const c of out) {
    if (inString) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') inString = true;
    else if (c === "{" || c === "[") opened.push(c === "{" ? "}" : "]");
    else if (c === "}" || c === "]") opened.pop();
  }
  return out + opened.reverse().join("");
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : typeof v === "number" ? String(v) : undefined);
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : v && typeof v === "object" ? [v] : []);

/** Normalises whatever came back into the TurnRecord shape. */
export function normalizeRecord(value: unknown, issues: string[] = []): TurnRecord | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const r: TurnRecord = {};

  if (typeof v.time === "number" || typeof v.time === "string") r.time = v.time;
  if (str(v.place)) r.place = str(v.place);
  if (typeof v.money === "number" || typeof v.money === "string") r.money = v.money;

  if (v.stats && typeof v.stats === "object") {
    const s = v.stats as Record<string, unknown>;
    r.stats = {};
    for (const k of ["health", "energy", "fame"] as const) {
      const n = Number(s[k]);
      if (s[k] !== undefined && Number.isFinite(n)) r.stats[k] = n;
    }
  }

  r.items = arr(v.items).flatMap((raw) => {
    if (typeof raw === "string") {
      const m = /^(.+?)\s*([+-]\s*\d+)/.exec(raw);
      if (m) return [{ name: m[1].trim(), delta: Number(m[2].replace(/\s/g, "")) }];
      issues.push(`物品无法理解：${raw}`);
      return [];
    }
    const o = raw as Record<string, unknown>;
    const name = str(o?.name);
    const deltaText = String(o?.delta ?? o?.change ?? "").replace(/[^\d+-]/g, "");
    const delta = typeof o?.delta === "number" ? o.delta : /\d/.test(deltaText) ? Number(deltaText) : NaN;
    if (!name || !Number.isFinite(delta)) {
      issues.push(`物品无法理解：${JSON.stringify(raw)}`);
      return [];
    }
    return [{ name, delta, ...(o.place !== undefined ? { place: str(o.place) ?? null } : {}), ...(str(o.unit) ? { unit: str(o.unit) } : {}) }];
  });

  r.people = arr(v.people).flatMap((raw) => {
    const o = raw as Record<string, unknown>;
    const name = str(o?.name);
    if (!name) { issues.push(`人物缺少名字：${JSON.stringify(raw)}`); return []; }
    const aliases = arr(o.aliases).map(str).filter((x): x is string => !!x);
    return [{
      name,
      ...(str(o.role) ? { role: str(o.role) } : {}),
      ...(str(o.attitude) ? { attitude: str(o.attitude) } : {}),
      ...(str(o.note) ? { note: str(o.note) } : {}),
      ...(typeof o.alive === "boolean" ? { alive: o.alive } : {}),
      ...(aliases.length ? { aliases } : {}),
    }];
  });

  r.status = arr(v.status).flatMap((raw) => {
    const o = raw as Record<string, unknown>;
    const name = str(o?.name);
    if (!name) return [];
    return [{ op: str(o.op) ?? "add", name, ...(str(o.detail) ? { detail: str(o.detail) } : {}) }];
  });

  r.goals = arr(v.goals).flatMap((raw) => {
    const o = raw as Record<string, unknown>;
    const name = str(o?.name);
    if (!name) return [];
    return [{ op: str(o.op) ?? "progress", name, ...(str(o.detail) ? { detail: str(o.detail) } : {}), ...(str(o.kind) ? { kind: str(o.kind) } : {}) }];
  });

  if (str(v.date)) r.date = str(v.date);
  const hour = Number(v.hour);
  if (v.hour !== undefined && Number.isInteger(hour) && hour >= 0 && hour < 24) r.hour = hour;
  const units = arr(v.currency).flatMap((u) => {
    const o = u as Record<string, unknown>;
    const name = str(o?.name);
    const value = Number(o?.value);
    return name && Number.isFinite(value) && value > 0 ? [{ name, value: Math.round(value) }] : [];
  });
  if (units.length) r.currency = units.sort((a, b) => b.value - a.value);

  if (str(v.log)) r.log = str(v.log);
  if (str(v.risk)) r.risk = str(v.risk);
  r.choices = arr(v.choices)
    .map((c) => str(c) ?? str((c as Record<string, unknown>)?.text))
    .filter((c): c is string => !!c)
    .map((c) => c.replace(/^\s*(?:[0-9一二三四五六]+[.、)）]|[-*•])\s*/, ""))
    .slice(0, 6);
  return r;
}

export function parseRecord(recordText: string | null): ParsedRecord {
  const issues: string[] = [];
  if (!recordText) return { record: null, issues: ["没有记录块"] };
  const value = lenientJson(recordText);
  if (value === null) return { record: null, issues: ["记录块无法解析"] };
  const record = normalizeRecord(value, issues);
  if (!record) return { record: null, issues: ["记录块不是对象"] };
  if (record.time === undefined) issues.push("缺少 time");
  if (!record.choices?.length) issues.push("缺少 choices");
  return { record, issues };
}
