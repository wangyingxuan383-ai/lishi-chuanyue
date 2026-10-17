// Isolated browser profile and fake provider only; never touches native saves.
import fs from "node:fs";
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { connectFake } from "./connect.mjs";
const out = "output/playwright/r13-free";
fs.mkdirSync(out, { recursive: true });
const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (e) => errors.push(e.message));
let checks = 0;
const check = (value, name) => { assert.ok(value, name); console.log(`PASS ${name}`); checks++; };
try {
  await page.goto(process.env.LISHI_APP ?? "http://127.0.0.1:1450/");
  await connectFake(page, { port: Number(process.env.LISHI_FAKE_PORT ?? 18850) });
  await page.getByRole("button", { name: "自由世界", exact: true }).click();
  await page.getByRole("button", { name: /查看全部/ }).click();
  check(await page.locator(".template-card").count() === 10, "ten free-world inspirations");
  check(await page.getByRole("button", { name: "写一个作品里的世界", exact: true }).count() === 1, "authored-world entry discoverable");
  await page.screenshot({ path: `${out}/inspirations.png`, fullPage: true });
  await page.locator(".template-card", { hasText: "青崖山下的小院" }).click();
  await page.getByLabel("年龄", { exact: true }).fill("1200");
  check(await page.getByRole("button", { name: "开始", exact: true }).isEnabled(), "non-human age accepted");
  const premise = await page.getByLabel("故事设定", { exact: true }).inputValue();
  await page.getByRole("button", { name: "历史穿越", exact: true }).click();
  check(await page.getByLabel("故事设定", { exact: true }).inputValue() === premise, "mode switch preserves writing");
  await page.getByRole("button", { name: "自由世界", exact: true }).click();
  await page.getByRole("button", { name: /^更多/ }).click();
  check(await page.getByRole("button", { name: /（内置）/ }).count() === 0, "no historical pack in free setup");
  await page.setViewportSize({ width: 360, height: 800 });
  check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "360px no horizontal overflow");
  await page.screenshot({ path: `${out}/setup-360.png`, fullPage: true });
  if (process.argv.includes("--play")) {
    await page.getByRole("button", { name: "开始", exact: true }).click();
    await page.getByRole("button", { name: "角色", exact: true }).waitFor({ timeout: 30000 });
    check(/第\s*1\s*天/.test(await page.locator(".topbar").first().textContent()), "free elapsed clock in actual play");
    await page.getByRole("button", { name: "角色", exact: true }).click();
    await page.getByRole("tab", { name: "设定", exact: true }).click();
    check((await page.locator(".panel-body").textContent()).includes("世界卡"), "world card label");
    await page.getByRole("tab", { name: "记事", exact: true }).click();
    check(!(await page.locator(".panel-body").textContent()).includes("天下大事"), "no historical timeline editor");
    await page.screenshot({ path: `${out}/journal.png` });
  }
  check(errors.length === 0, "no page errors");
  console.log(`${checks} checks passed`);
} catch (error) {
  await page.screenshot({ path: `${out}/failure.png`, fullPage: true }).catch(() => {});
  throw error;
} finally { await browser.close(); }
