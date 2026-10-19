// Focused source-book check; ephemeral profile and local fake model only.
// node --import tsx scripts/ui/sources.mjs --text-pdf <Chinese text PDF> --image-pdf <image-only PDF>
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { relayStream } from "../../devserver/relay.ts";
import { extractBookPdf } from "../../devserver/books.ts";
import { zipSync, strToU8 } from "fflate";
import { connectFake } from "./connect.mjs";

const root = process.cwd();
const origin = "http://127.0.0.1:1465";
const fakeOrigin = "http://127.0.0.1:18865";
const out = `${root}/output/playwright/sources`;
await fs.mkdir(out, { recursive: true });
const fake = spawn(process.execPath, ["scripts/fake-llm.mjs", "--port", "18865"], { cwd: root, windowsHide: true, stdio: "ignore" });
let server, browser, page, slow = false;
const checks = [];
const check = (name, ok) => { assert.ok(ok, name); checks.push(name); console.log(`PASS ${name}`); };
const secrets = new Map();
const bridge = { name: "scroll-check-memory-bridge", configureServer(vite) {
  vite.middlewares.use("/__dev", async (req, res) => {
    try {
      if (req.url === "/book/pdf") return extractBookPdf(root, req, res);
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const reply = (value) => { res.writeHead(200, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
      if (req.url === "/config") return reply({});
      if (req.url === "/secret/set") { secrets.set(body.slot, body); return reply(null); }
      if (req.url === "/secret/remove") { secrets.delete(body.slot); return reply(null); }
      if (req.url === "/secret/has") return reply({ configured: secrets.has(body.slot), boundBaseUrl: secrets.get(body.slot)?.boundBaseUrl ?? null });
      assert.equal(new URL(body.url).origin, fakeOrigin);
      if (req.url === "/llm/get") { const upstream = await fetch(body.url); return reply({ status: upstream.status, body: await upstream.text() }); }
      if (req.url === "/llm/stream") {
        res.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
        res.flushHeaders();
        const controller = new AbortController();
        res.on("close", () => controller.abort());
        await relayStream({ ...body, body: { ...body.body, model: slow ? "fake-slow" : "fake-normal" }, key: "local-fake", signal: controller.signal }, (event) => res.write(JSON.stringify(event) + "\n"));
        res.end(); return;
      }
      throw new Error("unexpected bridge route");
    } catch (error) { if (!res.headersSent) res.writeHead(500); res.end(String(error)); }
  });
} };
const fixture = (name, buffer) => ({ name, mimeType: "application/octet-stream", buffer: Buffer.from(buffer) });
const bookText = "第一章 灯\n阿青在青石桥经营书铺。她守信，不愿出卖朋友。青铜钥匙藏在灯座下。\n第二章 信\n阿青把青铜钥匙交给阿白，二人约定救下阿兰。\n第三章 雪\n终章秘密：阿白其实是北地王子，原著阿兰在雪夜死去。";
try {
  server = await createServer({ root, configFile: false, envDir: false, cacheDir: `${root}/.cache/vite-sources`, plugins: [react(), bridge], logLevel: "warn", define: { __APP_VERSION__: JSON.stringify(JSON.parse(await fs.readFile("package.json", "utf8")).version) }, server: { host: "127.0.0.1", port: 1465, strictPort: true, watch: null } });
  await server.listen();
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, reducedMotion: "reduce", locale: "zh-CN" });
  await context.route("**/*", (route) => new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
  page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.setDefaultTimeout(60000);
  await page.goto(origin);
  await connectFake(page, { port: 18865 });
  await page.getByRole("button", { name: /随便穿/ }).waitFor();
  await page.evaluate(async () => {
    const { game } = window.__lishi;
    const { sampleState } = await import("/src/engine/testing/fixtures.ts");
    await game.repo.createWorld({ title: "资料验证", eraId: "free", settings: { mode: "free", chapterEvery: 0, autoUpkeep: false }, opening: { parentId: null, kind: "opening", narrative: "阿兰已经被你救下，你正坐在书铺里。\n\n".repeat(60), state: sampleState() } });
    await game.repo.setSetting("autoUpdateCheck", false); await game.repo.setSetting("tip:longPress", true);
    await window.__lishiFlush();
  });
  await page.reload();
  const upload = async (file) => { const chooser = page.waitForEvent("filechooser"); await page.getByRole("button", { name: "导入书籍", exact: true }).click(); await (await chooser).setFiles(file); };
  const close = () => page.locator(".sheet-close").last().click();
  const saveBook = () => page.getByRole("button", { name: "保存书籍", exact: true }).click();
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /^存档与数据/ }).click();
  await page.getByRole("button", { name: "参考书籍", exact: true }).click();
  await upload(fixture("灯下书.txt", strToU8(bookText)));
  await page.getByLabel("书名", { exact: true }).waitFor();
  check("TXT preview detects three chapters", await page.getByLabel("书籍目录", { exact: true }).locator("option").count() === 3);
  await page.getByLabel("文本编码", { exact: true }).selectOption("utf-8");
  await page.getByLabel("书名", { exact: true }).waitFor();
  await saveBook(); await page.getByRole("button", { name: "返回书库", exact: true }).click();
  const epub = zipSync({ "META-INF/container.xml": strToU8('<container><rootfiles><rootfile full-path="b.opf"/></rootfiles></container>'), "b.opf": strToU8('<package><metadata><title>顺序验证</title></metadata><manifest><item id="z" href="z.xhtml"/><item id="a" href="a.xhtml"/></manifest><spine><itemref idref="z"/><itemref idref="a"/></spine></package>'), "z.xhtml": strToU8('<html><body><h1>第一章</h1><p>先读这里。</p></body></html>'), "a.xhtml": strToU8('<html><body><h1>第二章</h1><p>再读这里。</p></body></html>') });
  await upload(fixture("顺序.epub", epub)); await page.getByLabel("书名", { exact: true }).waitFor();
  check("EPUB follows spine order", await page.getByLabel("书籍目录", { exact: true }).locator("option").first().textContent() === "1. 第一章");
  await saveBook(); await page.getByRole("button", { name: "返回书库", exact: true }).click();
  const pdfArg = (name) => { const index = process.argv.indexOf(name); if (index < 0 || !process.argv[index + 1]) throw new Error(`请提供 ${name} 短样本`); return process.argv[index + 1]; };
  await upload(fixture("扫描.pdf", await fs.readFile(pdfArg("--image-pdf")))); await page.getByText(/没有提取到文字/).waitFor();
  check("scanned PDF has an explicit explanation", await page.getByText(/扫描图片型 PDF/).count() === 1);
  await upload(fixture("中文页.pdf", await fs.readFile(pdfArg("--text-pdf")))); await page.getByLabel("书名", { exact: true }).waitFor();
  check("Rust PDF core extracts Chinese with page provenance", await page.getByRole("dialog", { name: "参考书籍" }).getByText("中文书籍第一页阿青守信", { exact: true }).count() === 1);
  await saveBook(); await page.getByRole("button", { name: "返回书库", exact: true }).click();
  const docx = zipSync({ "word/document.xml": strToU8('<w:document xmlns:w="w"><w:body><w:p><w:r><w:t>文档开头</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格里的阿青</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>文档结尾</w:t></w:r></w:p></w:body></w:document>') });
  await upload(fixture("段落.docx", docx)); await page.getByLabel("书名", { exact: true }).waitFor();
  check("DOCX preview keeps table text in order", /文档开头[\s\S]*表格里的阿青[\s\S]*文档结尾/.test(await page.getByRole("dialog", { name: "参考书籍" }).textContent()));
  await saveBook(); await page.getByRole("button", { name: "返回书库", exact: true }).click();
  await upload(fixture("坏.epub", Buffer.from("PK坏书"))); await page.getByText(/损坏/).waitFor();
  check("failed import leaves no partial book", await page.evaluate(async () => Number((await window.__lishi.game.platform.sql.query("SELECT COUNT(*) AS n FROM source_books"))[0].n)) === 4);
  await page.screenshot({ path: `${out}/library-paper.png` });
  await close();
  await page.getByRole("button", { name: "返回", exact: true }).click(); await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "开始新的故事", exact: true }).click();
  await page.getByRole("button", { name: "同人", exact: true }).click();
  await page.getByRole("button", { name: "选择或导入参考书籍", exact: true }).click();
  await page.getByRole("button", { name: "灯下书 · TXT", exact: true }).click();
  await page.getByLabel("搜索书籍", { exact: true }).fill("北地王子");
  check("library text search finds the chapter", await page.getByText("找到 1 节", { exact: true }).count() === 1);
  await page.getByRole("button", { name: "使用这本书", exact: true }).click();
  await page.getByRole("button", { name: "截至指定章节", exact: true }).click();
  await page.getByLabel("截至章节", { exact: true }).selectOption("1");
  await page.getByLabel("原著位置", { exact: true }).selectOption("1");
  await page.getByLabel("原著怎么用", { exact: true }).fill("参考人物关系和世界规则。阿兰已被我救下，继续这条改写分支。");
  await page.getByText("选择已保存用法", { exact: true }).click();
  await page.getByRole("button", { name: /保存为常用用法/ }).click();
  await page.getByRole("alertdialog", { name: "保存为常用用法" }).getByRole("textbox").fill("救下阿兰");
  await page.getByRole("alertdialog", { name: "保存为常用用法" }).getByRole("button", { name: "保存", exact: true }).click();
  await page.getByRole("button", { name: "选用", exact: true }).waitFor();
  check("source handling preset is copied into the form", (await page.getByLabel("原著怎么用", { exact: true }).inputValue()).includes("改写分支"));
  await page.getByRole("button", { name: "先让 AI 通读整理", exact: true }).click();
  await page.getByRole("button", { name: "通读整理", exact: true }).click();
  check("analysis estimate states unknown money", (await page.getByRole("dialog", { name: "通读整理", exact: true }).textContent()).includes("金额未知"));
  await page.getByRole("button", { name: "开始整理", exact: true }).click();
  await page.getByRole("alertdialog", { name: "开始通读整理？" }).getByRole("button", { name: "开始", exact: true }).click();
  await page.getByText(/已整理 2\/2 段 · 已完成/).waitFor();
  check("AI analysis completes the selected range", true);
  await close();
  await page.getByLabel("原著怎么用", { exact: true }).scrollIntoViewIfNeeded();
  await page.screenshot({ path: `${out}/fanfic-paper.png` });
  await page.getByLabel("原著怎么用", { exact: true }).fill("临时修改，不更新预设");
  await page.getByRole("button", { name: "选用", exact: true }).click();
  check("editing a world does not change its saved preset", (await page.getByLabel("原著怎么用", { exact: true }).inputValue()).includes("改写分支"));
  await page.evaluate(async () => { await new Promise((r) => setTimeout(r, 650)); await window.__lishiFlush(); });
  await page.reload();
  await page.getByRole("button", { name: "开始新的故事", exact: true }).click();
  check("draft retains source scope and handling after reopening", await page.getByLabel("截至章节", { exact: true }).inputValue() === "1" && (await page.getByLabel("原著怎么用", { exact: true }).inputValue()).includes("改写分支"));
  await page.getByRole("button", { name: "返回", exact: true }).click(); await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "继续“资料验证”", exact: true }).click();
  await page.getByRole("button", { name: "更多", exact: true }).click(); await page.getByRole("button", { name: "本局设置", exact: true }).click();
  await page.getByText("参考书籍", { exact: true }).click();
  await page.getByRole("button", { name: "选择或导入参考书籍", exact: true }).click(); await page.getByRole("button", { name: "灯下书 · TXT", exact: true }).click(); await page.getByRole("button", { name: "使用这本书", exact: true }).click();
  await page.getByRole("button", { name: "保存书籍用法", exact: true }).click();
  await close();
  await page.locator(".story").evaluate((el) => { el.scrollTop = 800; });
  await page.locator(".send-btn").click();
  await page.waitForFunction(() => document.querySelector(".story-text.streaming")?.textContent.length > 15);
  await page.locator(".story").evaluate((el) => { el.scrollTop = 200; });
  await page.waitForFunction(() => document.querySelector(".send-btn")?.textContent !== "停止");
  check("manual upward reading during generation is retained at finish", Math.abs(await page.locator(".story").evaluate((el) => el.scrollTop) - 200) < 3);
  const used = await page.evaluate(async () => { const { game } = window.__lishi; const world = (await game.repo.listWorlds()).find((w) => w.title === "资料验证"); const { cursor } = await import("/src/engine/tree.ts"); return (await cursor(game.repo, world.id)).head.meta.reference; });
  check("existing world generation records actual source passages", used?.passages?.length > 0);
  check("no browser page errors", errors.length === 0);
  await fs.writeFile(`${out}/results.json`, JSON.stringify({ checks, errors, viewport: "393x852" }, null, 2));
  console.log(`${checks.length} source checks passed`);
} catch (error) {
  console.log("UI text:", (await page?.locator("body").textContent())?.slice(-4500));
  await page?.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally { await browser?.close(); await server?.close(); fake.kill(); }
