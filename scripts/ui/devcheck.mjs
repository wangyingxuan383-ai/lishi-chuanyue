// R01 browser harness check at phone size, against scripts/fake-llm.mjs.
//   node scripts/fake-llm.mjs & pnpm dev &  node scripts/ui/devcheck.mjs
// Screenshots go to .cache/ui/.
import fs from "node:fs";
import { chromium } from "playwright-core";

const out = ".cache/ui";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

for (const [w, h] of [[393, 852], [360, 800]]) {
  const context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const page = await context.newPage();
  await page.goto("http://127.0.0.1:1420/");
  await page.getByText("开发自检").waitFor();
  await page.waitForFunction(() => document.body.innerText.includes("web-dev") && !document.body.innerText.includes("读取中"));

  if (w === 393) {
    await page.getByLabel("服务地址").fill("http://127.0.0.1:18800/v1");
    await page.getByLabel("模型").fill("fake-normal");
    await page.getByLabel(/API Key/).fill("fake-dev-key");
    await page.getByRole("button", { name: "保存" }).click();
    await page.getByText("服务已保存").waitFor();
    check("save service + key", (await page.textContent("body")).includes("已保存（http://127.0.0.1:18800/v1）"));

    await page.getByRole("button", { name: "获取模型" }).click();
    await page.getByText(/获取到 5 个模型/).waitFor();
    check("list models", true);

    // Streaming: text must appear progressively, not all at once.
    await page.getByRole("button", { name: "试写一段" }).click();
    const lengths = [];
    for (let i = 0; i < 8; i++) {
      await page.waitForTimeout(120);
      lengths.push((await page.locator("article.story").first().textContent()).length);
    }
    await page.getByText(/^完成：/).waitFor({ timeout: 15000 });
    const finalLen = (await page.locator("article.story").first().textContent()).length;
    const growing = new Set(lengths).size >= 3 && lengths[0] < finalLen;
    check("progressive streaming", growing, `lengths ${lengths.join(",")} → ${finalLen}`);
    check("usage reported", (await page.textContent("body")).includes("用量 50/120"));
    await page.screenshot({ path: `${out}/devcheck-${w}-done.png`, fullPage: true });

    // Stop mid-stream.
    await page.getByLabel("模型").fill("fake-slow");
    await page.getByRole("button", { name: "试写一段" }).click();
    await page.getByText("写作中…").waitFor();
    await page.waitForTimeout(900);
    await page.getByRole("button", { name: "停止" }).click();
    await page.getByText("已停止").waitFor({ timeout: 5000 });
    const partial = (await page.locator("article.story").first().textContent()).length;
    check("stop keeps partial text", partial > 0 && partial < finalLen, `partial ${partial}`);

    // HTTP error is reported in plain words.
    await page.getByLabel("模型").fill("fake-http500");
    await page.getByRole("button", { name: "试写一段" }).click();
    await page.getByText(/服务返回了错误/).waitFor({ timeout: 5000 });
    check("http error message", (await page.textContent("body")).includes("HTTP 500"));

    // Persistence across reload (debounced IndexedDB write).
    await page.waitForTimeout(1500);
    await page.reload();
    await page.getByText("开发自检").waitFor();
    await page.waitForTimeout(800);
    const saved = await page.locator("details").count();
    check("samples survive reload", saved >= 1, `${saved} saved`);
    check("settings survive reload", (await page.getByLabel("模型").inputValue()) === "fake-normal");

    // Esc acts as back: first press warns.
    await page.keyboard.press("Escape");
    check("back warns before exit", await page.getByText("再按一次退出").isVisible());
  }

  const overflow = await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth);
  check(`no horizontal overflow at ${w}px`, !overflow);
  await page.screenshot({ path: `${out}/devcheck-${w}.png` });
  await context.close();
}

await browser.close();
console.log(results.join("\n"));
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
