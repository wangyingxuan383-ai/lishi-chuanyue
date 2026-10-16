// Matching the names a model uses for people and goals against existing ones,
// so "孙管事", "管事孙某" and "孙管事儿" stay one person (PLAN_V3 §5.2).

const TITLES = [
  "管事", "掌柜", "东家", "郎君", "娘子", "大人", "先生", "师傅", "老丈", "大娘", "小娘子", "郎中", "主簿", "县令",
  "司马", "校尉", "将军", "相公", "员外", "少爷", "小姐", "娘", "郎", "公", "翁", "婆",
];

export function normalize(name: string): string {
  return name
    .normalize("NFKC")
    .replace(/[\s·・•．.]/g, "")
    .replace(/(儿|子|的)$/u, (m, _g, offset: number) => (offset > 1 ? "" : m));
}

/** Splits a name into a core (usually the surname / given name) and a title. */
function split(name: string): { core: string; title: string } {
  let core = normalize(name).replace(/某$/, "");
  let title = "";
  for (const t of TITLES) {
    if (core.length > t.length && core.endsWith(t)) { title = t; core = core.slice(0, -t.length); break; }
    if (core.length > t.length && core.startsWith(t)) { title = t; core = core.slice(t.length); break; }
  }
  return { core, title };
}

export interface Named {
  name: string;
  aliases?: string[];
}

/** Finds the existing entry a model-supplied name refers to, or undefined. */
export function matchName<T extends Named>(entries: T[], name: string): T | undefined {
  const wanted = normalize(name);
  if (!wanted) return undefined;
  const all = (e: T) => [e.name, ...(e.aliases ?? [])];
  return (
    entries.find((e) => all(e).some((n) => n === name)) ??
    entries.find((e) => all(e).some((n) => normalize(n) === wanted)) ??
    entries.find((e) => all(e).some((n) => {
      const a = split(n);
      const b = split(name);
      return a.core !== "" && a.core === b.core && a.title === b.title;
    })) ??
    // Containment only for names of 3+ characters, to avoid two-character collisions.
    entries.find((e) => all(e).some((n) => {
      const x = normalize(n);
      return Math.min(x.length, wanted.length) >= 3 && (x.includes(wanted) || wanted.includes(x));
    }))
  );
}
