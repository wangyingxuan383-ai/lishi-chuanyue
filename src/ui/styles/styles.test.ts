// The stylesheets parse the way they are meant to (R29-T001): a selector must
// never run into an at-rule (".x @media (…) {"), which Vite's dev server
// tolerates but the production build rejects. Also braces balance, and inline
// SVGs are encoded once (R29: a double-encoded "#" turned a paper texture into
// a black page).
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const dir = join(__dirname, "..");
const files = (readdirSync(dir, { recursive: true }) as string[]).filter((f) => f.endsWith(".css"));

/** Each block's opening text (selector or at-rule prelude), with comments removed. */
function preludes(css: string): { text: string; line: number }[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "));
  const out: { text: string; line: number }[] = [];
  let start = 0, depth = 0;
  for (let i = 0; i < clean.length; i++) {
    const ch = clean[i];
    if (ch === "{") { out.push({ text: clean.slice(start, i).trim(), line: clean.slice(0, i).split("\n").length }); depth++; start = i + 1; }
    else if (ch === "}") { depth--; start = i + 1; }
    else if (ch === ";") start = i + 1;
    if (depth < 0) throw new Error(`unbalanced } at line ${clean.slice(0, i).split("\n").length}`);
  }
  if (depth !== 0) throw new Error(`unbalanced braces (${depth} left open)`);
  return out;
}

describe("stylesheets", () => {
  it.each(files)("%s: no selector runs into an at-rule, braces balance", (file) => {
    const css = readFileSync(join(dir, file), "utf8");
    const glued = preludes(css).filter((p) => !p.text.startsWith("@") && /(^|\s)@[a-z-]+/.test(p.text));
    expect(glued.map((p) => `${file}:${p.line} ${p.text.slice(0, 80)}`)).toEqual([]);
  });

  it.each(files)("%s: inline images are encoded once", (file) => {
    const css = readFileSync(join(dir, file), "utf8");
    expect(css.match(/%25(?:2[0-9A-F]|3[A-F]|5[BD]|7[BD])/gi) ?? [], relative(dir, join(dir, file))).toEqual([]);
  });

  it("would have caught the 0.14.0 build break", () => {
    expect(preludes(".a { x: 1; }\n.b @media (min-width: 1px) { .c { y: 2; } }").some((p) => !p.text.startsWith("@") && /(^|\s)@media/.test(p.text))).toBe(true);
  });
});
