// Run from repo root: node src/ui/components/quality.ui.mjs
// Fresh browser + in-memory fake credentials. No devBridge, no secret files, no external traffic.
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";
import { connectFake } from "../../../scripts/ui/connect.mjs";

const root = process.cwd();
const port = Number(process.env.QUALITY_UI_PORT ?? 19334);
const fakePort = Number(process.env.QUALITY_FAKE_PORT ?? 19335);
const origin = `http://127.0.0.1:${port}`;
const fakeOrigin = `http://127.0.0.1:${fakePort}`;
const out = `${root}/output/playwright/r13-quality`;
await fs.mkdir(out, { recursive: true });
const fake = spawn(process.execPath, ["scripts/fake-llm.mjs", "--port", String(fakePort)], { cwd: root, windowsHide: true, stdio: "ignore" });
let server, browser, page;
const results = [];
const check = (name, condition) => { assert.ok(condition, name); results.push(name); };
try {
  server = await createServer({ configFile: false, root, cacheDir: `${root}/.cache/vite-quality`, plugins: [react()], define: { __APP_VERSION__: JSON.stringify(JSON.parse(await fs.readFile("package.json", "utf8")).version) }, server: { host: "127.0.0.1", port, strictPort: true, watch: { ignored: ["**/target/**", "**/src-tauri/**", "**/output/**", "**/.cache/**"] } } });
  await server.listen();
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
  const secrets = new Map();
  await context.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== origin) return route.fulfill({ status: 404, body: "[]" });
    if (!url.pathname.startsWith("/__dev/")) return route.continue();
    const body = route.request().postDataJSON();
    const reply = (json) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(json) });
    if (url.pathname === "/__dev/config") return reply({});
    if (url.pathname === "/__dev/secret/set") { secrets.set(body.slot, body); return reply(null); }
    if (url.pathname === "/__dev/secret/remove") { secrets.delete(body.slot); return reply(null); }
    if (url.pathname === "/__dev/secret/has") return reply({ configured: secrets.has(body.slot), boundBaseUrl: secrets.get(body.slot)?.boundBaseUrl ?? null });
    assert.equal(new URL(body.url).origin, fakeOrigin, "only local fake model traffic");
    if (url.pathname === "/__dev/llm/get") {
      const response = await fetch(body.url); return reply({ status: response.status, body: await response.text() });
    }
    if (url.pathname === "/__dev/llm/stream") {
      const response = await fetch(body.url, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer local-fake" }, body: JSON.stringify(body.body) });
      const text = await response.text();
      const events = [{ type: "open", status: response.status }];
      for (const line of text.split("\n")) {
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data && data !== "[DONE]") events.push({ type: "data", data });
      }
      events.push({ type: "done" });
      return route.fulfill({ contentType: "application/x-ndjson", body: events.map((e) => JSON.stringify(e)).join("\n") + "\n" });
    }
    throw new Error("unexpected fake bridge route");
  });
  page = await context.newPage();
  const errors = []; page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin);
  await connectFake(page, { port: fakePort });
  await page.getByRole("button", { name: /随便穿/ }).waitFor();
  check("setup connects only to the local fake service", true);
  await page.evaluate(async () => {
    const { game } = window.__lishi;
    const { sampleState } = await import("/src/engine/testing/fixtures.ts");
    const state = sampleState();
    state.people = [{ id: "friend", name: "王掌柜", aliases: [], role: "邸店掌柜", attitude: "友善", notes: "为你留了一盏灯", origin: "旧识", alive: true }];
    const initial = await game.repo.createWorld({ title: "长安灯下", eraId: "tang-748", settings: { chapterEvery: 0, autoUpkeep: false }, opening: { parentId: null, kind: "opening", state, narrative: "晚风拂过街口，灯火逐盏亮起。", choices: [] } });
    let parentId = initial.node.id;
    for (const text of ["你沿街走到邸店，王掌柜正在门口等你。", "桌上摆着热茶，你坐下来听他说起城中的旧事。最后一句完整保留。"] ) {
      const node = await game.repo.appendNode(initial.world.id, initial.line.id, { parentId, kind: "turn", narrative: text, state }); parentId = node.id;
    }
    await game.repo.setSetting("autoUpdateCheck", false);
    await game.platform.sql.batch([
      { sql: "INSERT INTO usage (id, purpose, prompt_tokens, completion_tokens, outcome, at) VALUES ('quality-known', 'turn', 1000000, 500000, 'ok', ?)", params: [new Date().toISOString()] },
      { sql: "INSERT INTO usage (id, purpose, prompt_tokens, completion_tokens, outcome, at) VALUES ('quality-unknown', 'turn', NULL, NULL, 'ok', ?)", params: [new Date().toISOString()] },
    ]);
  });
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "继续“长安灯下”" }).waitFor();
  check("home cover is local SVG", await page.locator(".book-art").count() === 1);
  await page.getByRole("button", { name: "看看新增" }).click();
  await page.getByRole("heading", { name: "这一版新增" }).waitFor();
  await page.screenshot({ path: `${out}/whats-new.png`, animations: "disabled" });
  await page.getByRole("dialog", { name: "这一版新增" }).getByRole("button", { name: "知道了" }).click();
  check("new-version entry dismisses", await page.getByRole("button", { name: "看看新增" }).count() === 0);
  for (const theme of ["paper", "day", "night"]) {
    await page.evaluate((theme) => { document.documentElement.dataset.theme = theme; }, theme);
    await page.screenshot({ path: `${out}/home-${theme}.png`, animations: "disabled" });
    check(`${theme} cover fits mobile width`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await page.getByRole("button", { name: "设置", exact: true }).click();
  await page.getByRole("button", { name: /用量与花费/ }).click();
  await page.getByText("还没填全单价，本月花费未知。").waitFor();
  await page.getByLabel("每月预算（元）").fill("1");
  await page.getByLabel("输入单价（元／百万 token）").fill("1");
  await page.getByLabel("输出单价（元／百万 token）").fill("2");
  await page.getByRole("button", { name: "保存", exact: true }).click();
  await page.getByText("约 2.00 元", { exact: true }).waitFor();
  check("budget excludes unknown usage and exposes a partial estimate", await page.getByText(/另有 1 次没有用量数据/).count() === 1);
  await page.screenshot({ path: `${out}/budget.png`, animations: "disabled" });
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: /网络与代理/ }).click();
  await page.getByRole("button", { name: "自定义代理", exact: true }).click();
  check("custom proxy opens without an existing address", await page.getByLabel("代理地址").count() === 1);
  check("proxy explains plaintext backup risk", await page.getByText(/别把账号密码写进去/).count() === 1);
  await page.screenshot({ path: `${out}/proxy.png`, animations: "disabled" });
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: /关于与更新/ }).click();
  check("privacy explains sending context to configured AI", await page.getByText(/相关设定、正文和人物等上下文/).count() === 1);
  await page.getByRole("button", { name: "这一版新增", exact: true }).click();
  await page.getByRole("dialog", { name: "这一版新增" }).getByRole("button", { name: "知道了" }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByText(/本月估算花费已到 1 元预算/).waitFor();
  check("budget reminder is claimed for this month", await page.evaluate(async () => !!await window.__lishi.game.repo.getSetting("budgetReminderMonth", "")));
  await page.getByRole("button", { name: "继续“长安灯下”" }).click();
  const budgetHead = await page.evaluate(async () => {
    const { game } = window.__lishi;
    const world = (await game.repo.listWorlds())[0];
    const head = (await game.repo.getLine(world.currentLineId)).nodeId;
    await game.repo.setSetting("budgetReminderMonth", "");
    await game.repo.setSetting("monthlyBudget", { limit: 3, input: 1, output: 2 });
    // Like a failed chapter parse: a charged request with no new story node/event.
    await game.platform.sql.batch([{ sql: "INSERT INTO usage (id, purpose, prompt_tokens, completion_tokens, outcome, at) VALUES ('quality-no-change', 'chapter', 2000000, 0, 'no_record', ?)", params: [new Date().toISOString()] }]);
    return head;
  });
  // No timer: the next check comes with the next thing the player does — here, opening and closing the ⋯ menu.
  await page.getByRole("button", { name: "更多", exact: true }).click();
  await page.keyboard.press("Escape");
  await page.getByText(/本月估算花费已到 3 元预算/).waitFor({ timeout: 5000 });
  check("usage without a story change shows the budget reminder at the next check", await page.evaluate(async (head) => {
    const { game } = window.__lishi; const world = (await game.repo.listWorlds())[0];
    return (await game.repo.getLine(world.currentLineId)).nodeId === head;
  }, budgetHead));
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("tab", { name: "人物", exact: true }).click();
  check("people use local name seals", await page.locator(".person-avatar").count() === 1);
  await page.screenshot({ path: `${out}/people.png`, animations: "disabled" });
  await page.getByRole("dialog", { name: "角色", exact: true }).getByRole("button", { name: "关闭", exact: true }).click();
  const turn = page.locator(".turn").last();
  await turn.dispatchEvent("pointerdown", { pointerType: "touch", button: 0, pointerId: 1 });
  await page.waitForTimeout(650);
  await turn.dispatchEvent("pointerup", { pointerType: "touch", button: 0, pointerId: 1 });
  await page.getByRole("button", { name: "做成书摘卡" }).click();
  await page.getByRole("group", { name: "分享范围" }).getByRole("button", { name: "共 3 段" }).click();
  await page.getByAltText("书摘卡预览").waitFor();
  await page.screenshot({ path: `${out}/share-three.png`, animations: "disabled" });
  const dimensions = await page.getByAltText("书摘卡预览").evaluate((img) => [img.naturalWidth, img.naturalHeight]);
  check("three passages render into a bounded image", dimensions[0] === 1080 && dimensions[1] <= 8192);
  const download = page.waitForEvent("download");
  await page.getByRole("button", { name: "保存图片", exact: true }).click();
  await (await download).saveAs(`${out}/three-passages.png`);
  check("share card downloads as an actual PNG", (await fs.readFile(`${out}/three-passages.png`)).subarray(1, 4).toString() === "PNG");
  check("huge card is rejected instead of clipped", await page.evaluate(async () => {
    const { renderCard } = await import("/src/ui/components/ShareCard.tsx");
    try { renderCard({ title: "长图", body: "全文".repeat(20000), date: "", name: "", place: "" }, "册页"); return false; }
    catch (e) { return e.message.includes("文字太多"); }
  }));
  check("no page runtime errors", errors.length === 0);
  console.log(`PASS ${results.length} UI checks\n${results.join("\n")}`);
  await fs.writeFile(`${out}/results.json`, JSON.stringify({ results, errors }, null, 2));
} catch (error) {
  await page?.screenshot({ path: `${out}/failure.png` }).catch(() => {});
  throw error;
} finally {
  await browser?.close(); await server?.close(); fake.kill();
}
