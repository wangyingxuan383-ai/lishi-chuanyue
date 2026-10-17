// R08-T003 in the browser: a 1000-turn world at phone size. Builds the world
// through the dev-only window.__lishi handle, reloads, and times opening the
// home screen and the play screen, then scrolls through loaded pages.
//   node scripts/fake-llm.mjs & pnpm dev &  node scripts/ui/long-world.mjs
import { chromium } from "playwright-core";

const browser = await chromium.launch({ channel: "msedge" });
const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await context.newPage();
await page.goto("http://127.0.0.1:1420/");
// A fresh profile starts at the service setup; connect the fake model first.
await page.getByText("连接 AI 服务").waitFor();
await page.getByRole("button", { name: "自定义" }).click();
await page.getByLabel("服务地址").fill("http://127.0.0.1:18800/v1");
await page.getByText(/这是 HTTP 地址/).click();
await page.getByLabel(/API Key/).fill("fake-ui-key");
await page.getByRole("button", { name: "获取模型列表" }).click();
await page.locator("select").waitFor();
await page.locator("select").selectOption("fake-normal");
await page.getByRole("button", { name: "测试连接" }).click();
await page.getByText(/连接成功/).waitFor();
await page.getByRole("button", { name: "保存，开始穿越" }).click();
await page.waitForFunction(() => !!window.__lishi);
const built = await page.evaluate(async () => {
  const { game } = window.__lishi;
  const repo = game.repo;
  const state = { version: 2, time: { start: "天宝七载 冬月十七", elapsedMinutes: 0 }, placeId: null,
    protagonist: { name: "李安", aliases: [], age: 22, gender: "男", identity: "落第举子", origin: "", cheat: "", stats: { money: 300, debt: 0, health: 80, energy: 70, fame: 10 }, statuses: [], items: [] },
    people: [], places: [], cards: [], goals: [], era: { packId: "tang-748" }, deviations: [] };
  const started = performance.now();
  const { world, line, node } = await repo.createWorld({ title: "千回合", eraId: "tang-748", opening: { parentId: null, kind: "opening", narrative: "开场。".repeat(100), state } });
  let parent = node.id;
  for (let i = 1; i <= 1000; i++) {
    const next = await repo.appendNode(world.id, line.id, { parentId: parent, kind: "turn", actionMode: "do", actionText: `第${i}步`, narrative: `第${i}段。`.padEnd(600, "文"), state, choices: ["甲", "乙"] });
    parent = next.id;
  }
  return { ms: performance.now() - started };
});
console.log(`建好 1000 回合：${(built.ms / 1000).toFixed(1)} 秒`);
await page.waitForTimeout(1500); // the harness saves one second after the last write
let t = Date.now();
await page.reload();
await page.locator(".card", { hasText: "千回合" }).waitFor();
console.log(`首页出现：${Date.now() - t} 毫秒`);
t = Date.now();
await page.locator(".card", { hasText: "千回合" }).click();
await page.locator(".turn").last().waitFor();
console.log(`游玩页出现：${Date.now() - t} 毫秒（显示 ${await page.locator(".turn").count()} 段）`);
// Scroll up through five pages of earlier turns and time each frame.
const frames = await page.evaluate(async () => {
  const el = document.querySelector(".story");
  const times = [];
  for (let i = 0; i < 60; i++) {
    const start = performance.now();
    el.scrollTop = Math.max(0, el.scrollTop - 600);
    await new Promise((r) => requestAnimationFrame(() => r()));
    times.push(performance.now() - start);
    const more = [...document.querySelectorAll("button")].find((b) => b.textContent?.includes("更早"));
    if (more && el.scrollTop < 200) more.click();
  }
  times.sort((a, b) => a - b);
  return { median: times[30], p95: times[57], turns: document.querySelectorAll(".turn").length };
});
console.log(`往上翻 60 次：每帧中位 ${frames.median.toFixed(1)} 毫秒，95% ${frames.p95.toFixed(1)} 毫秒；共载入 ${frames.turns} 段`);
await browser.close();
