// Phone-size checks of the play screen, menus, assistant page, themes and font size.
// Start the isolated dev console and the fake model first, then run:
//   node scripts/ui/dev-isolated.mjs        (port 1421, store .cache/ui-isolated)
//   node scripts/fake-llm.mjs               (port 18800)
//   node scripts/ui/play-check.mjs          (LISHI_BROWSER=/path/to/chromium on Linux)
// The 1421 server must identify .cache/ui-isolated as its isolated store.
// For a full first-launch run, use a fresh isolated store; this script never
// deletes a database or silently resets an existing service configuration.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";
import { connectFake } from "./connect.mjs";
import { launchBrowser } from "./browser.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const origin = "http://127.0.0.1:1421";
const output = path.join(root, "output/playwright/play-check");
const reportFile = path.join(root, "output/playwright/play-check/report.md");
const titles = [
  "首次启动、模拟模型与三种开局类型",
  "随机开局与游玩页顶栏",
  "更多菜单分组与入口",
  "此时此地与时间、货币编辑入口",
  "发送第一回合行动",
  "触摸长按与段落更多菜单",
  "输入方式、助手常用任务与玩家词汇",
  "助手设置的高级容量折叠项",
  "从助手返回后的阅读位置",
  "纸张、白天、夜间主题",
  "20px 系统字号与菜单按钮溢出",
  "流式生成时既有回合的 DOM 稳定性",
];
const results = [];
const pageErrors = [];
const blockedRequests = new Set();
const started = new Date();
let browser;
let page;
let current;
let screenshotNumber = 0;
let fatal;
let readingBefore;
let visitedAssistant = false;
let firstNodeId;
let environment = "尚未核对隔离服务";
let networkGuardInstalled = false;

fs.mkdirSync(output, { recursive: true });
fs.mkdirSync(path.dirname(reportFile), { recursive: true });

const shortError = (error) => {
  const message = String(error?.message ?? error).split("\n")
    .filter((line) => line.trim() && line.trim() !== "Call log:" && !line.includes("<launching>"))
    .slice(0, 3).join(" | ");
  const cause = error?.cause;
  return `${message}${cause?.code ? ` (${cause.code}${cause.port ? `，端口 ${cause.port}` : ""})` : ""}`.slice(0, 600);
};
const clean = (text) => String(text).replaceAll("|", "／").replaceAll("\n", " ");
const loopback = (hostname) => ["127.0.0.1", "localhost", "[::1]"].includes(hostname);
const play = () => page.locator(".play:visible:not(.agent-conversation)");
const story = () => play().locator(".story");
const sheet = () => page.locator(".sheet:visible").last();

function verify(name, ok, detail = "") {
  const check = { name, status: ok ? "PASS" : "FAIL", detail };
  current.checks.push(check);
  console.log(`${check.status} ${String(current.id).padStart(2, "0")}.${current.checks.length} ${name}${detail ? ` — ${detail}` : ""}`);
  return ok;
}

async function settle() {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });
}

async function shot(name) {
  const filename = `${String(++screenshotNumber).padStart(2, "0")}-${name}.png`;
  await settle();
  await page.screenshot({ path: path.join(output, filename), animations: "disabled" });
  current.shots.push(filename);
  return filename;
}

async function failureShot(name) {
  if (!page || page.isClosed()) return;
  try { await shot(name); }
  catch (error) { current.notes.push(`截图失败：${shortError(error)}`); }
}

async function step(id, work) {
  current = { id, title: titles[id - 1], executed: true, status: "PASS", checks: [], notes: [], shots: [] };
  results.push(current);
  try { await work(); }
  catch (error) {
    current.notes.push(shortError(error));
    current.status = "FAIL";
    await failureShot(`error-step-${String(id).padStart(2, "0")}`);
  }
  if (current.checks.some((check) => check.status === "FAIL")) current.status = "FAIL";
  if (!current.checks.length) current.status = "FAIL";
  console.log(`${current.status} ${String(id).padStart(2, "0")} ${current.title}`);
}

async function closeSheets() {
  for (let count = 0; count < 8; count++) {
    if (!await page.locator(".sheet:visible").count()) return;
    await sheet().locator(".sheet-close").first().click();
    await settle();
  }
  throw new Error("弹层未能关闭，无法继续独立检查");
}

async function ensurePlay() {
  await closeSheets();
  for (let count = 0; count < 5; count++) {
    if (await play().isVisible()) return;
    const assistantBack = page.getByRole("button", { name: "返回故事", exact: true });
    if (await assistantBack.isVisible()) {
      await assistantBack.click();
    } else if (await page.locator(".world-open:visible").count()) {
      await page.locator(".world-open:visible").first().click();
    } else {
      const back = page.getByRole("button", { name: "返回", exact: true });
      if (!await back.isVisible()) throw new Error("找不到返回故事的界面入口");
      await back.click();
    }
    await settle();
  }
  await play().waitFor();
}

async function waitComplete(minimumTurns) {
  await page.waitForFunction((minimum) => {
    const play = document.querySelector(".preserved-play:not([data-inactive]) .play");
    if (!play) return false;
    const turns = play.querySelectorAll(".story .turn[data-node-id]");
    const send = play.querySelector(".dock .send-btn");
    return turns.length >= minimum && !play.querySelector(".story-text.streaming")
      && !play.querySelector(".story .turn:not([data-node-id])")
      && !!send && !send.disabled && send.textContent.trim() !== "停止"
      && !play.querySelector(".mode-btn")?.disabled;
  }, minimumTurns, { timeout: 120_000 });
  await settle();
}

async function sendAction(text, onStreaming) {
  await ensurePlay();
  const before = await story().locator(".turn[data-node-id]").count();
  await play().locator(".inputbar textarea").fill(text);
  await play().locator(".dock .send-btn").click();
  await play().locator(".story-text.streaming").first().waitFor({ timeout: 30_000 });
  if (onStreaming) await onStreaming();
  await waitComplete(before + 1);
  return story().locator(".turn[data-node-id]").count();
}

async function longPress(turnIndex) {
  await closeSheets();
  const paragraph = story().locator(".turn[data-node-id]").nth(turnIndex).locator(".story-text p").first();
  await paragraph.scrollIntoViewIfNeeded();
  const box = await paragraph.boundingBox();
  if (!box) throw new Error(`第 ${turnIndex + 1} 回合正文不可见`);
  // Dispatch the requested touch pointer sequence, not a mouse context menu.
  const pointer = { pointerId: 26, pointerType: "touch", isPrimary: true, button: 0,
    clientX: box.x + Math.min(box.width / 2, 30), clientY: box.y + Math.min(box.height / 2, 12) };
  await paragraph.dispatchEvent("pointerdown", { ...pointer, buttons: 1, pressure: 0.5 });
  await page.waitForTimeout(700);
  await paragraph.dispatchEvent("pointerup", { ...pointer, buttons: 0, pressure: 0 });
  await sheet().locator(".sheet-menu").waitFor();
  return sheet().locator(".sheet-menu > button").allTextContents();
}

async function changeTheme(label, value) {
  await ensurePlay();
  await play().locator(".topbar").getByRole("button", { name: "返回", exact: true }).click();
  await page.locator(".world-open:visible").first().waitFor();
  await page.getByRole("button", { name: /^设置(?:，有新版本)?$/ }).click();
  await page.getByRole("button", { name: /^阅读与外观/ }).click();
  await page.locator(".theme-cards").getByRole("button", { name: label, exact: true }).click();
  await page.waitForFunction((theme) => document.documentElement.dataset.theme === theme, value);
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.locator(".world-open:visible").first().click();
  await play().waitFor();
  await waitComplete(2);
}

async function preflight() {
  // Refuse a normal 1420 server or an unmarked 1421 instance before booting
  // the application: no request to the personal host or secrets store.
  const response = await fetch(`${origin}/__ui-isolation`, { signal: AbortSignal.timeout(8000) });
  if (!response.ok) throw new Error(`隔离标记读取失败：HTTP ${response.status}`);
  const marker = await response.json();
  if (marker.databaseDir !== ".cache/ui-isolated"
    || marker.secretsFile !== ".cache/ui-isolated/fake-secrets.json"
    || marker.port !== 1421 || marker.loopbackOnly !== true) {
    throw new Error("隔离标记不匹配；拒绝连接应用");
  }
  const fakeResponse = await fetch("http://127.0.0.1:18800/v1/models", { signal: AbortSignal.timeout(8000) });
  if (!fakeResponse.ok || !(await fakeResponse.json()).data?.some((model) => model.id === "fake-normal")) {
    throw new Error("18800 未提供 fake-normal；拒绝连接其他模型服务");
  }
  environment = "1421 隔离标记匹配；数据库 .cache/ui-isolated；密钥文件为该目录内的 fake-secrets.json；18800 提供 fake-normal。";
  console.log("PASS ENV 隔离服务与本机模拟模型核对通过");
}

async function main() {
  try {
    await preflight();
    browser = await launchBrowser(chromium);
    environment += ` Edge ${browser.version()}；393×852、deviceScaleFactor=2、isMobile=true、hasTouch=true。`;
    const context = await browser.newContext({ viewport: { width: 393, height: 852 },
      deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
    // The browser is restricted to loopback even if an automatic update or
    // an unintended external URL is requested by the application.
    await context.route("**/*", (route) => {
      const url = new URL(route.request().url());
      if (loopback(url.hostname)) return route.continue();
      blockedRequests.add(`${url.protocol}//${url.hostname}`);
      return route.abort("blockedbyclient");
    });
    await context.routeWebSocket(/.*/, (socket) => {
      const url = new URL(socket.url());
      if (loopback(url.hostname)) socket.connectToServer();
      else { blockedRequests.add(`${url.protocol}//${url.hostname}`); socket.close(); }
    });
    networkGuardInstalled = true;
    page = await context.newPage();
    // Slow machines and network-mounted checkouts: LISHI_UI_TIMEOUT_MS raises every wait.
    page.setDefaultTimeout(Number(process.env.LISHI_UI_TIMEOUT_MS ?? 12_000));
    page.on("pageerror", (error) => pageErrors.push(shortError(error)));
    await page.goto(`${origin}/`, { waitUntil: "domcontentloaded", timeout: 180_000 });

    await step(1, async () => {
      await page.getByRole("button", { name: /^服务商：/ }).waitFor({ timeout: 120_000 });
      verify("首次启动进入连接 AI 服务页", await page.getByText("连接 AI 服务", { exact: true }).isVisible());
      await shot("first-launch");
      await connectFake(page, { port: 18800, model: "fake-normal" });
      await page.getByRole("heading", { name: "新的故事", exact: true }).waitFor({ timeout: 30_000 });
      for (const [label, suffix] of [["历史穿越", "history"], ["自由世界", "free"], ["同人", "fanfic"]]) {
        await page.getByRole("group", { name: "故事模式" }).getByRole("button", { name: label, exact: true }).click();
        // 同人 has no 开局灵感: those are original-world templates; the others must stay.
        const expected = label === "同人" ? ["随便穿", "我的开局", "AI 补全空着的设定"] : ["随便穿", "我的开局", "开局灵感", "AI 补全空着的设定"];
        const missing = [];
        for (const entry of expected) if (!await page.getByRole("button", { name: entry, exact: true }).isVisible()) missing.push(entry);
        verify(`${label}四个入口均可见`, missing.length === 0, missing.length ? `缺少：${missing.join("、")}` : expected.join("、"));
        await shot(`new-${suffix}`);
      }
      // Return to history so fanfiction's required original-book binding
      // cannot interfere with the unrelated play-screen checks.
      await page.getByRole("group", { name: "故事模式" }).getByRole("button", { name: "历史穿越", exact: true }).click();
    });

    await step(2, async () => {
      await page.getByRole("button", { name: "随便穿", exact: true }).click();
      await page.locator(".sticky-bar").getByRole("button", { name: "开始", exact: true }).waitFor();
      await page.locator(".sticky-bar").getByRole("button", { name: "开始", exact: true }).click();
      await waitComplete(1);
      firstNodeId = await story().locator(".turn[data-node-id]").first().getAttribute("data-node-id");
      const place = (await play().locator(".topbar h1").innerText()).trim();
      verify("顶栏地点标题非空且有更多按钮", !!place && await play().getByRole("button", { name: "更多", exact: true }).isVisible(), `地点：${place}`);
      await shot("opening-play");
    });
    if (!firstNodeId) throw new Error("未能完成开场，后续游玩检查缺少前置条件");

    await step(3, async () => {
      await ensurePlay();
      await play().getByRole("button", { name: "更多", exact: true }).click();
      const headings = (await sheet().locator(".sheet-menu h3").allTextContents()).map((text) => text.trim());
      verify("分组依次为阅读、推进、本局、其他", JSON.stringify(headings) === JSON.stringify(["阅读", "推进", "本局", "其他"]), headings.join(" → "));
      const labels = (await sheet().locator(".sheet-menu > button").allTextContents()).map((text) => text.trim());
      const forbidden = ["时间与货币", "助手", "Agent 助手", "回到首页"];
      verify("菜单不含重复或废弃入口", forbidden.every((text) => !labels.some((label) => label.includes(text))), labels.join("、"));
      await shot("more-menu");
      await closeSheets();
    });

    await step(4, async () => {
      await ensurePlay();
      await play().getByRole("button", { name: "此时此地", exact: true }).click();
      const edit = sheet().getByRole("button", { name: /^修改(时间|纪年)与货币$/ });
      verify("此时此地提供时间与货币编辑入口", await edit.isVisible());
      await shot("here-and-now");
      await edit.click();
      await page.getByRole("dialog", { name: "时间与货币", exact: true }).waitFor();
      verify("时间与货币弹层已打开", await sheet().getByRole("heading", { name: "时间与货币", exact: true }).isVisible());
      await shot("time-currency");
      await closeSheets();
    });

    await step(5, async () => {
      const turns = await sendAction("我起身去开门");
      verify("行动写完且回合数至少为 2", turns >= 2, `正文回合数：${turns}（含开场）`);
      verify("行动显示在故事中", await story().locator(".turn-action", { hasText: "我起身去开门" }).isVisible());
      await shot("first-action");
    });

    await step(6, async () => {
      await ensurePlay();
      const opening = (await longPress(0)).map((text) => text.trim());
      // 回到这里 appears on every passage except the current head (you are already there).
      verify("较早一段的长按菜单为五项且含回到这里", JSON.stringify(opening) === JSON.stringify(["AI 改写", "记住这件事", "回到这里", "复制", "更多…"]), opening.join("、"));
      await shot("opening-longpress");
      const second = (await longPress(1)).map((text) => text.trim());
      verify("当前最新一段的长按菜单为四项且没有回到这里", JSON.stringify(second) === JSON.stringify(["AI 改写", "记住这件事", "复制", "更多…"]), second.join("、"));
      await shot("second-longpress");
      await sheet().getByRole("button", { name: "更多…", exact: true }).click();
      const more = (await sheet().locator(".sheet-menu > button").allTextContents()).map((text) => text.trim());
      verify("段落更多标题与三种操作可见", await sheet().getByRole("heading", { name: "这一段还可以", exact: true }).isVisible()
        && ["自己改写这段文字", "加书签", "做成书摘卡"].every((text) => more.includes(text)), more.join("、"));
      await shot("passage-more");
      await closeSheets();
    });

    await step(7, async () => {
      await ensurePlay();
      // Use a real, non-bottom position where the short fake story permits it.
      readingBefore = await story().evaluate(async (element) => {
        const max = element.scrollHeight - element.clientHeight;
        element.scrollTop = max > 8 ? Math.floor(max * 0.4) : 0;
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        return { top: element.scrollTop, max };
      });
      await play().locator(".mode-btn").click();
      const pickerText = await sheet().innerText();
      verify("输入方式含助手 ›，不含 Agent", pickerText.includes("助手 ›") && !pickerText.includes("Agent"));
      await shot("input-modes");
      await sheet().getByRole("button", { name: /^助手 ›/ }).click();
      const assistant = page.locator(".agent-conversation:visible");
      await assistant.waitFor();
      visitedAssistant = true;
      await assistant.locator(".agent-recipes .mode-option").first().waitFor();
      verify("助手顶栏标题", (await assistant.locator(".topbar h1").innerText()).trim() === "助手");
      const tasks = (await assistant.locator(".agent-recipes .mode-option b").allTextContents()).map((text) => text.trim());
      verify("空对话列出至少六项常用任务并含回顾本局", tasks.length >= 6 && tasks.includes("回顾本局"), tasks.join("、"));
      const devMode = await page.evaluate(() => window.__lishi.game.repo.getSetting("devMode", false));
      verify("开发者模式关闭", devMode === false);
      const text = await page.locator("body").innerText();
      const leaks = text.match(/Agent|token\w*|MCP/gi) ?? [];
      verify("助手页可见文字不含工程词汇", !leaks.length, leaks.length ? leaks.join("、") : "Agent、token、MCP 均未出现");
      await shot("assistant-home");
    });

    await step(8, async () => {
      if (!visitedAssistant) throw new Error("未进入助手，设置检查未运行");
      // Select the gear by its settings label; allow the current legacy label
      // so wording defects cannot prevent checking the settings contents.
      await page.locator(".agent-conversation .topbar").getByRole("button", { name: "助手设置", exact: true }).click();
      const advanced = sheet().locator("details").filter({ has: page.locator("summary", { hasText: /^接口与记忆容量（高级）$/ }) }).first();
      await advanced.waitFor();
      verify("容量高级项默认折叠", !await advanced.evaluate((element) => element.open));
      verify("折叠时没有可见 tokens", !/tokens/i.test(await sheet().innerText()));
      await shot("assistant-settings");
      await advanced.locator(":scope > summary").click();
      // Count visible text nodes only. textContent would include closed
      // details and falsely report hidden engineering text as visible.
      const tokenNodes = await sheet().evaluate((element) => {
        const advanced = [...element.querySelectorAll("details")].find((details) => details.querySelector(":scope > summary")?.textContent.trim() === "接口与记忆容量（高级）");
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const found = [];
        while (walker.nextNode()) {
          const node = walker.currentNode;
          if (!/tokens/i.test(node.textContent)) continue;
          const range = document.createRange();
          range.selectNodeContents(node);
          const style = getComputedStyle(node.parentElement);
          if (range.getClientRects().length && style.visibility !== "hidden" && style.display !== "none") {
            found.push({ text: node.textContent.trim(), inside: advanced.contains(node) });
          }
        }
        return found;
      });
      verify("展开后所有可见 tokens 都属于容量高级项", tokenNodes.length > 0 && tokenNodes.every((node) => node.inside), `共 ${tokenNodes.length} 处；外部 ${tokenNodes.filter((node) => !node.inside).length} 处`);
      await shot("assistant-advanced");
      await advanced.locator(":scope > summary").click();
      verify("再次折叠隐藏 tokens", !/tokens/i.test(await sheet().innerText()));
      await closeSheets();
    });

    await step(9, async () => {
      await closeSheets();
      if (!visitedAssistant || !readingBefore) throw new Error("缺少进入助手前的阅读位置，未运行往返比较");
      await page.getByRole("button", { name: "返回故事", exact: true }).click();
      await play().waitFor();
      await settle();
      // Let any delayed scroll restoration execute before measuring.
      await page.waitForTimeout(350);
      const after = await story().evaluate((element) => element.scrollTop);
      const delta = Math.abs(after - readingBefore.top);
      verify("往返助手阅读位置差不超过 4px", delta <= 4, `进入前 ${readingBefore.top}px，返回后 ${after}px，差 ${delta}px；可滚范围 ${readingBefore.max}px`);
      await shot("returned-reading");
    });

    await step(10, async () => {
      try {
        for (const [label, value] of [["纸张", "paper"], ["白天", "day"], ["夜间", "night"]]) {
          try {
            await changeTheme(label, value);
            verify(`${label}主题在同一故事生效`, await page.evaluate(() => document.documentElement.dataset.theme) === value
              && await story().locator(".turn[data-node-id]").first().getAttribute("data-node-id") === firstNodeId);
            await shot(`theme-${value}`);
          } catch (error) {
            verify(`${label}主题检查`, false, shortError(error));
            await failureShot(`error-theme-${value}`);
          }
        }
      } finally {
        await changeTheme("纸张", "paper");
        verify("最后恢复纸张主题", await page.evaluate(() => document.documentElement.dataset.theme) === "paper");
      }
    });

    await step(11, async () => {
      await ensurePlay();
      const initialSize = await page.evaluate(() => ({ value: document.documentElement.style.getPropertyValue("font-size"), priority: document.documentElement.style.getPropertyPriority("font-size") }));
      try {
        await page.evaluate(() => { document.documentElement.style.fontSize = "20px"; });
        await settle();
        verify("根元素字号为 20px", await page.evaluate(() => getComputedStyle(document.documentElement).fontSize) === "20px");
        await shot("large-font-play");
        await play().getByRole("button", { name: "更多", exact: true }).click();
        const buttons = await sheet().locator(".sheet-menu > button").evaluateAll((elements) => elements.map((element) => ({ text: element.textContent.trim(), scroll: element.scrollWidth, client: element.clientWidth })));
        const overflow = buttons.filter((button) => button.scroll > button.client);
        verify("大字号菜单按钮文字无横向溢出", buttons.length > 0 && overflow.length === 0,
          overflow.length ? overflow.map((button) => `${button.text} ${button.scroll}>${button.client}`).join("；") : `检查 ${buttons.length} 个按钮`);
        await shot("large-font-menu");
      } finally {
        await page.evaluate(({ value, priority }) => {
          if (value) document.documentElement.style.setProperty("font-size", value, priority);
          else document.documentElement.style.removeProperty("font-size");
        }, initialSize);
        await closeSheets();
      }
    });

    await step(12, async () => {
      await ensurePlay();
      if (await story().locator(".turn[data-node-id]").count() < 2) throw new Error("第一回合行动未完成，不能测第二个行动");
      await settle();
      await story().evaluate((element) => {
        const node = element.querySelector(".turn");
        node.setAttribute("data-probe", "1");
        const state = { node, mutations: 0, changes: [], samples: 0, lastText: "" };
        const record = (records) => {
          state.mutations += records.length;
          for (const change of records.slice(0, Math.max(0, 8 - state.changes.length))) {
            state.changes.push({ type: change.type, target: change.target.nodeName, attribute: change.attributeName });
          }
        };
        state.record = record;
        state.observer = new MutationObserver(record);
        state.observer.observe(node, { subtree: true, childList: true, characterData: true, attributes: true });
        state.streamObserver = new MutationObserver(() => {
          const text = element.querySelector(".story-text.streaming")?.textContent;
          if (text && text !== state.lastText) { state.samples++; state.lastText = text; }
        });
        state.streamObserver.observe(element, { subtree: true, childList: true, characterData: true });
        window.__playProbe = state;
      });
      try {
        const turns = await sendAction("我先付三十文房钱，再向掌柜打听差事", () => shot("stream-live"));
        const probe = await page.evaluate(() => {
          const state = window.__playProbe;
          state.record(state.observer.takeRecords());
          state.observer.disconnect();
          state.streamObserver.disconnect();
          return { mutations: state.mutations, samples: state.samples, changes: state.changes,
            same: state.node.isConnected && document.querySelector(".preserved-play .story .turn") === state.node,
            marker: state.node.getAttribute("data-probe") };
        });
        verify("第二个行动实际经历多次流式更新并写完", turns >= 3 && probe.samples >= 2, `回合 ${turns}，不同流式正文采样 ${probe.samples} 次`);
        verify("第一个回合保留原 DOM 和探针", probe.same && probe.marker === "1", `同一元素：${probe.same}；data-probe=${probe.marker}`);
        verify("已有第一回合子树变更数为 0", probe.mutations === 0, `${probe.mutations} 次${probe.changes.length ? `；${JSON.stringify(probe.changes)}` : ""}`);
        await shot("stream-finished");
      } finally {
        await page.evaluate(() => {
          window.__playProbe?.observer.disconnect();
          window.__playProbe?.streamObserver.disconnect();
          window.__playProbe?.node.removeAttribute("data-probe");
          delete window.__playProbe;
        });
      }
    });
  } catch (error) {
    fatal = shortError(error);
    console.log(`FAIL ENV ${fatal}`);
    if (current) await failureShot("fatal-error");
    for (let id = 1; id <= titles.length; id++) {
      if (results.some((result) => result.id === id)) continue;
      results.push({ id, title: titles[id - 1], executed: false, status: "FAIL", checks: [], notes: [`未运行：${fatal}`], shots: [] });
      console.log(`FAIL ${String(id).padStart(2, "0")} ${titles[id - 1]} — 未运行，环境或前置条件受阻`);
    }
  } finally {
    if (browser) await browser.close().catch((error) => { fatal ??= shortError(error); });
    writeReport();
  }
}

function writeReport() {
  const pass = results.filter((result) => result.status === "PASS").length;
  const unrun = results.filter((result) => !result.executed).length;
  const assertionCount = results.reduce((count, result) => count + result.checks.length, 0);
  const failedAssertions = results.flatMap((result) => result.checks).filter((check) => check.status === "FAIL").length;
  const timestamp = new Intl.DateTimeFormat("sv-SE", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false }).format(started).replace(" ", "T") + "+08:00";
  const lines = ["# 游玩页界面检查报告", "", `- 检查时间：${timestamp}（Asia/Shanghai）。`,
    "- 脚本：`scripts/ui/play-check.mjs`。",
    `- 环境：${environment}`,
    `- 汇总：${pass}/12 项通过，${results.length - pass}/12 项失败标记，其中 ${unrun} 项未运行；执行 ${assertionCount} 条断言，${failedAssertions} 条失败；本次生成 ${results.reduce((count, result) => count + result.shots.length, 0)} 张截图。`,
    "- FAIL 中的“未运行”表示环境或前置条件阻塞，不代表发现了应用缺陷。截图仅列出本次实际写入的文件；旧截图不计入本次证据。",
    "- 限制：仅本机模拟模型；手机尺寸桌面浏览器检查不能替代 Android 真机、系统字号或输入法验收。", "",
    "| 项目 | 结果 | 执行情况 | 本次截图 |", "| --- | --- | --- | --- |"];
  for (const result of results) lines.push(`| ${result.id}. ${result.title} | ${result.status} | ${result.executed ? "已尝试，详见下文" : "未运行"} | ${result.shots.length ? result.shots.map((name) => `[${name}](${name})`).join("、") : "无"} |`);
  lines.push("", "## 检查明细", "");
  for (const result of results) {
    lines.push(`### ${String(result.id).padStart(2, "0")} ${result.title}：${result.status}`, "");
    for (const check of result.checks) lines.push(`- ${check.status}：${check.name}${check.detail ? `。${clean(check.detail)}` : ""}。`);
    for (const note of result.notes) lines.push(`- ${clean(note)}`);
    lines.push(`- 截图：${result.shots.length ? result.shots.map((name) => `\`${name}\``).join("、") : "未生成"}。`, "");
  }
  lines.push("## 发现的问题与待验项", "");
  let issues = 0;
  if (fatal) {
    lines.push(`- 运行阻塞：${clean(fatal)}。${page ? "可用的失败截图见上表。" : "浏览器或页面未能创建，无法取得真实界面截图；未使用空白图或人工图片替代证据。"}`);
    issues++;
  }
  for (const result of results) {
    const failures = result.checks.filter((check) => check.status === "FAIL");
    if (result.executed && (failures.length || result.notes.length)) {
      lines.push(`- 第 ${result.id} 项：${[...failures.map((check) => `${check.name}：${check.detail || "断言不满足"}`), ...result.notes].map(clean).join("；")}。截图：${result.shots.join("、") || "未生成"}。`);
      issues++;
    }
  }
  if (pageErrors.length) { lines.push(`- 浏览器未捕获异常：${pageErrors.map(clean).join("；")}。`); issues++; }
  if (!issues) lines.push("- 已执行的清单断言未发现问题。截图仍需结合实际设备体验验收。");
  if (unrun) lines.push(`- 后续：解决运行环境或前置条件后重跑脚本；当前 ${unrun} 项未运行，不得据此宣称界面验收通过。`);
  lines.push(`- 网络策略：预检仅访问本机；${networkGuardInstalled ? `已安装浏览器本机网络限制，拦截外部来源 ${blockedRequests.size} 个` : "浏览器网络限制尚未执行（浏览器初始化未完成）"}。`,
    "- 本轮只交付测试脚本、隔离启动器调整和检查产物；未修复应用代码。", "");
  fs.writeFileSync(reportFile, lines.join("\n"), "utf8");
  console.log(`SUMMARY PASS=${pass} FAIL=${results.length - pass} UNRUN=${unrun} CHECKS=${assertionCount} CHECK_FAIL=${failedAssertions} PAGE_ERRORS=${pageErrors.length}`);
  console.log("REPORT output/playwright/play-check/report.md");
  process.exitCode = fatal || pass !== titles.length || pageErrors.length ? 1 : 0;
}

await main();
