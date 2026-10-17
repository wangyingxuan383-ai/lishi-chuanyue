// R09-T003: renders assets/app-icon.svg to assets/app-icon.png (1024 x 1024)
// (and app-icon-desktop) with Noto Serif SC (SIL OFL) from Google Fonts, so the
// glyphs do not depend on the fonts of this machine. Then see docs/design/DESIGN_SPEC.md §7.
//   node scripts/ui/icon.mjs
import fs from "node:fs";
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge" });
const page = await browser.newPage({ viewport: { width: 1024, height: 1024 }, deviceScaleFactor: 1 });
// app-icon: padded, for Android (the launcher masks the edges); app-icon-desktop: the seal fills the canvas.
for (const name of ["app-icon", "app-icon-desktop"]) {
  const svg = fs.readFileSync(`assets/${name}.svg`, "utf8");
  await page.setContent(`<!doctype html><html><head>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Noto+Serif+SC:wght@700&text=${encodeURIComponent("穿越")}&display=block">
<style>html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${svg}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const loaded = await page.evaluate(() => document.fonts.check('700 196px "Noto Serif SC"', "穿越"));
  if (!loaded) throw new Error("Noto Serif SC did not load; the icon would use a fallback font");
  await page.locator("svg").screenshot({ path: `assets/${name}.png`, omitBackground: true });
  console.log(`assets/${name}.png`);
}
await browser.close();
