// Failure matrix (R30-T010): each way a passage can fail, on the phone-size
// play screen, with the notice it gives and whether its main action really
// writes the passage. Start the isolated dev console (fresh) and the fake model:
//   node scripts/ui/dev-isolated.mjs --fresh   (port 1421)
//   node scripts/fake-llm.mjs                  (port 18800, a fresh process: some modes fail only at first)
//   LISHI_BROWSER=/usr/bin/chromium node scripts/ui/failure-matrix.mjs
// Screenshots and the report go to output/playwright/failure-matrix/.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { connectFake } from "./connect.mjs";
import { launchBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = process.env.LISHI_APP ?? "http://127.0.0.1:1421/";
const out = path.join(root, "output/playwright/failure-matrix");
const timeout = Number(process.env.LISHI_UI_TIMEOUT_MS ?? 30000);
fs.mkdirSync(out, { recursive: true });
const results = [];
const errors = [];
const check = (name, ok, detail = "") => { results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`); console.log(results.at(-1)); };
let shots = 0;

const browser = await launchBrowser(chromium, { headless: true });
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, hasTouch: true, isMobile: true, serviceWorkers: "block" });
// Only this machine: the fake model and the dev console.
await context.route("**/*", (route) => ["127.0.0.1", "localhost", "[::1]"].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort("blockedbyclient"));
const page = await context.newPage();
page.setDefaultTimeout(timeout);
page.on("pageerror", (error) => errors.push(String(error.message ?? error)));
const shot = (name) => page.screenshot({ path: path.join(out, `${String(++shots).padStart(2, "0")}-${name}.png`) });
const finish = async (code) => {
  fs.writeFileSync(path.join(out, "report.md"), [`# 失败矩阵 ${new Date().toISOString()}`, "", ...results, ...errors.map((e) => `page error: ${e}`), ""].join("\n"));
  await browser.close().catch(() => {});
  process.exit(code);
};
process.on("uncaughtException", async (error) => { await shot("crash").catch(() => {}); check("crashed", false, String(error?.message ?? error).split("\n")[0]); await finish(1); });
process.on("unhandledRejection", async (error) => { await shot("crash").catch(() => {}); check("crashed", false, String(error?.message ?? error).split("\n")[0]); await finish(1); });

const passages = () => page.locator(".turn").count();
const step = (text) => console.log(`… ${text}`);
const notice = page.locator(".notice[role=status]").last();

/** Points the connected service at another fake model, then reopens the story. */
async function useModel(model) {
  step(`switching to ${model}`);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.getByRole("button", { name: /^设置/ }).click();
  await page.getByRole("button", { name: /^AI 服务/ }).first().click();
  await page.getByRole("button", { name: "修改" }).first().click();
  await page.getByRole("button", { name: /^写故事用的模型：/ }).click();
  await page.locator(".sheet .mode-option", { hasText: new RegExp(`^${model}`) }).click();
  await page.getByRole("button", { name: /^连接并保存$/ }).click();
  // Saving tests the connection first; leaving earlier would drop the change.
  await page.locator(".service-hero, .service-card", { hasText: model }).first().waitFor({ timeout });
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  await page.locator(".home-scene, .shelf-book, .strip-card").first().click();
  await page.locator(".dock").waitFor({ timeout });
  await page.waitForTimeout(600);
}

/** Taps the first suggested next step (the path that failed on the phone). */
async function tapChoice() {
  await page.locator(".choice").first().click();
}

step("opening the dev console");
await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 180000 });
step("loaded");
// A fresh store opens on the service screen; one already opened elsewhere starts at home.
const service = page.getByRole("button", { name: /^服务商：/ });
const begin = page.getByRole("button", { name: /^(开始穿越|开始新的故事)/ });
await service.or(begin).first().waitFor({ timeout: 180000 });
if (!await service.isVisible()) { await begin.click(); await service.waitFor(); }
step("connecting the fake model");
await connectFake(page, { model: "fake-normal" });
step("connected");
await page.getByRole("button", { name: /随便穿/ }).click();
// 随便穿 fills a random setup; 开始 writes the opening.
const startButton = page.getByRole("button", { name: "开始", exact: true });
if (await startButton.isVisible().catch(() => false)) await startButton.click();
else await startButton.click({ timeout: 5000 }).catch(() => {});
await page.locator(".choice").first().waitFor({ timeout: timeout * 2 });
check("opening written with the normal fake model", (await passages()) >= 1);

// 1. The passage is written but its record is not: retrying asks for the record again.
await useModel("fake-norecord");
let before = await passages();
await tapChoice();
await notice.waitFor({ timeout });
await page.waitForTimeout(400);
const formatText = await notice.textContent();
check("bad record: one tidy sentence, no raw error", formatText.includes("整理记录没有成功") && !/record|Invalid|：.*：/.test(formatText), formatText);
check("bad record: main action is 重试这一步, with 查看原因", (await notice.locator("button.primary").textContent()) === "重试这一步" && (await notice.getByRole("button", { name: "查看原因" }).count()) === 1);
await shot("format-notice");
await notice.getByRole("button", { name: "查看原因" }).click();
await page.locator(".sheet", { hasText: "为什么没写成" }).waitFor({ timeout });
const sheet = await page.locator(".sheet").last().textContent();
check("查看原因 names the step, the request and offers 复制诊断", sheet.includes("整理记录") && sheet.includes("请求") && sheet.includes("复制诊断"), sheet.slice(0, 200));
await shot("format-sheet");
await page.keyboard.press("Escape");
await page.waitForTimeout(500);
check("closing the sheet keeps the notice", (await notice.count()) === 1);
await notice.locator("button.primary").click();
await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n && !document.querySelector(".notice[role=status] button.primary"), before, { timeout });
check("bad record: 重试这一步 writes the passage (a real request, not a replay)", (await passages()) > before);

// 2. The service refuses the passage: rewrite it, or switch service.
await useModel("fake-refuse");
before = await passages();
await tapChoice();
await notice.waitFor({ timeout });
await page.waitForTimeout(400);
const refusedText = await notice.textContent();
check("refused: says so in one sentence", refusedText.includes("被服务拒绝"), refusedText);
check("refused: 重新写这一段 first, 换个服务 offered", (await notice.locator("button.primary").textContent()) === "重新写这一段" && (await notice.getByRole("button", { name: "换个服务" }).count()) === 1);
await shot("refused-notice");

// 3. The service errors twice (retried once automatically), then works.
await useModel("fake-flaky");
before = await passages();
await tapChoice();
await notice.waitFor({ timeout });
await page.waitForTimeout(400);
const flakyText = await notice.textContent();
check("server error: plain sentence and 再试一次", flakyText.includes("服务暂时出了问题") && (await notice.locator("button.primary").textContent()) === "再试一次", flakyText);
await notice.locator("button.primary").click();
await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n, before, { timeout });
check("server error: 再试一次 writes the passage", (await passages()) > before);

// 4. The service breaks off mid-stream twice: one tidy line, continue offered.
await useModel("fake-midstream");
await tapChoice();
await notice.waitFor({ timeout });
await page.waitForTimeout(400);
const streamText = await notice.textContent();
check("mid-stream break: says it broke off, offers 接着写完", streamText.includes("断开") && (await notice.locator("button.primary").textContent()) === "接着写完", streamText);
await shot("stream-notice");

// 6. 备用服务 (D179): the main service keeps failing with 500; the backup writes the passage.
step("adding a second service as the backup");
await page.goto(origin, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /^设置/ }).click();
await page.getByRole("button", { name: /^AI 服务/ }).first().click();
await page.getByRole("button", { name: /添加服务/ }).click();
await connectFake(page, { model: "fake-normal" });
// Saving returns to the settings home with the new service in use.
await page.getByText(/127\.0\.0\.1 2/).first().waitFor({ timeout });
await page.goto(origin, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /^设置/ }).click();
await page.getByRole("button", { name: /^AI 服务/ }).first().click();
// Adding a service may switch to it; the first one stays the main service here.
await page.locator(".service-card .service-main").first().click();
await page.waitForTimeout(300);
const backupId = await page.locator("select").last().evaluate((el) => [...el.options].find((o) => o.value && o.textContent.includes("fake-normal"))?.value ?? "");
await page.locator("select").last().selectOption(backupId);
check("settings offers 备用服务 once a second service is connected", !!backupId);
await shot("fallback-setting");
await useModel("fake-http500");
before = await passages();
await tapChoice();
const takeover = page.locator(".toast", { hasText: "备用服务" });
await takeover.waitFor({ timeout });
check("backup: says the backup took over", (await takeover.textContent()).includes("主服务出错"), await takeover.textContent());
await page.waitForFunction((n) => document.querySelectorAll(".turn").length > n && !document.querySelector(".writing-turn"), before, { timeout: timeout * 2 });
check("backup: the passage is written without a failure notice", (await passages()) > before && (await page.locator(".notice[role=status] button.primary").count()) === 0);
await shot("fallback-done");

// 5. Settings → 存档与数据 → 复制诊断 lists the failures.
await page.goto(origin, { waitUntil: "domcontentloaded" });
await page.getByRole("button", { name: /^设置/ }).click();
await page.getByRole("button", { name: /^存档与数据/ }).first().click();
await page.getByRole("heading", { name: "生成失败诊断" }).waitFor({ timeout });
check("settings offers 复制诊断 for recent failures", (await page.getByRole("button", { name: "复制诊断" }).count()) === 1);
await shot("settings-diagnosis");

check("no page errors", errors.length === 0, errors.join(" | "));
await finish(results.some((r) => r.startsWith("FAIL")) ? 1 : 0);
