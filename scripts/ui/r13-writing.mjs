// R13-T103: isolated UI checks; zero real-model calls, no devBridge/secrets file.
// Run: node scripts/ui/r13-writing.mjs   (R13_WRITING_PORT picks the dev-server port, default 1439)
import fs from "node:fs";
import path from "node:path";
import { createServer } from "vite";
import react from "@vitejs/plugin-react";
import { chromium } from "playwright-core";

const root = path.resolve(import.meta.dirname, "../..");
const out = path.join(root, "output/playwright/r13-writing");
fs.mkdirSync(out, { recursive: true });
const checks = [];
const requests = [];
const errors = [];
let slow = false;
let failure = false;
const rewrite = "细雨轻叩窗棂。";
const polish = "问掌柜能否再宽限几日。";
const fake = {
  name: "writing-local-fake",
  configureServer(server) {
    server.middlewares.use("/__dev", async (req, res) => {
      let raw = "";
      for await (const chunk of req) raw += chunk;
      const body = JSON.parse(raw || "{}");
      const json = (value) => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(value)); };
      if (req.url.startsWith("/secret/has")) return json({ configured: true, boundBaseUrl: "http://127.0.0.1:18839/v1" });
      if (req.url.startsWith("/secret/")) return json(null);
      if (req.url.startsWith("/config")) return json({ baseUrl: null, model: null });
      if (!req.url.startsWith("/llm/stream")) return json({ status: 200, body: "{}" });
      // This fake never contacts an upstream service, regardless of the requested URL.
      requests.push(body.body);
      res.writeHead(200, { "Content-Type": "application/x-ndjson" });
      const emit = (event) => { if (!res.destroyed) res.write(JSON.stringify(event) + "\n"); };
      emit({ type: "open", status: 200 });
      const prompt = JSON.stringify(body.body.messages);
      if (failure) { emit({ type: "error", kind: "http", status: 401 }); return res.end(); }
      const text = prompt.includes("润色玩家还没发送") ? polish : rewrite;
      const timer = setTimeout(() => {
        emit({ type: "data", data: JSON.stringify({ choices: [{ delta: { content: text }, finish_reason: "stop" }], usage: { prompt_tokens: 90, completion_tokens: 12 } }) });
        emit({ type: "done" }); res.end();
      }, slow ? 1400 : 80);
      res.on("close", () => clearTimeout(timer));
    });
  },
};
// configFile:false deliberately avoids the project's disk-backed devBridge and .env.local.
const server = await createServer({ root, configFile: false, envDir: false, cacheDir: path.join(root, ".cache/vite-writing"), plugins: [fake, react()],
  define: { __APP_VERSION__: JSON.stringify(JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version) },
  server: { host: "127.0.0.1", port: Number(process.env.R13_WRITING_PORT ?? 1439), strictPort: true, watch: { ignored: ["**/target/**", "**/src-tauri/**", "**/output/**", "**/.cache/**", "**/.claude/**"] } } });
await server.listen();
let browser;
let page;
const check = (name, ok) => { checks.push({ name, ok: !!ok }); if (!ok) throw new Error(name); };
const shot = async (name) => { await page.waitForTimeout(300); await page.screenshot({ path: path.join(out, `${name}.png`) }); };
try {
  browser = await chromium.launch({ channel: "msedge" });
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 });
  await context.route("**/*", (route) => { const url = new URL(route.request().url()); return url.hostname === "127.0.0.1" ? route.continue() : route.abort(); });
  page = await context.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`http://127.0.0.1:${process.env.R13_WRITING_PORT ?? 1439}`, { waitUntil: "domcontentloaded", timeout: 60000 });
  await page.waitForFunction(() => !!window.__lishi?.game);
  const seeded = await page.evaluate(async () => {
    const { game } = window.__lishi;
    const { saveProfile } = await import("/src/engine/llm/providers.ts");
    const { sampleState } = await import("/src/engine/testing/fixtures.ts");
    const profile = await saveProfile(game.repo, { name: "本地假服务", provider: "custom", baseUrl: "http://127.0.0.1:18839/v1", mainModel: "fake-main", auxModel: "fake-aux", includeUsage: true, allowHttp: true }, null);
    await game.repo.setSetting("activeProfile", profile.id);
    await game.repo.setSetting("autoUpdateCheck", false);
    await game.repo.setSetting("welcomed", true);
    const state = sampleState();
    state.placeId = "inn";
    state.places = [{ id: "inn", name: "客栈", aliases: [], description: "你在这里落脚" }, { id: "bookshop", name: "旧书铺", aliases: ["书摊"], description: "卖旧书" }];
    state.cards = [{ id: "era", name: "长安", kind: "时代", content: "市井生活", keys: [] }, { id: "guild", name: "商会", kind: "势力", content: "商人同行", keys: ["同行"] }, { id: "key", name: "铜钥匙", kind: "物品", content: "开门用", keys: [] }];
    const first = await game.repo.createWorld({ title: "写作测试", eraId: "tang-748", settings: { chapterEvery: 0, autoUpkeep: false }, opening: { parentId: null, kind: "opening", narrative: "客栈里很安静。\n\n细雨落在窗边。\n\n掌柜拨着算盘。", state } });
    const freeState = structuredClone(state); freeState.era.mode = "free"; freeState.era.clockStyle = "elapsed";
    const second = await game.repo.createWorld({ title: "异世界测试", eraId: "free", settings: { mode: "free", clockStyle: "elapsed", chapterEvery: 0, autoUpkeep: false }, opening: { parentId: null, kind: "opening", narrative: "云海浮岛，风声入窗。", state: freeState } });
    return { worldId: first.world.id, originalId: first.node.id, originalLine: first.line.id, original: first.node.narrative, otherId: second.world.id };
  });
  await page.evaluate(() => window.__lishiFlush?.());
  await page.reload();
  await page.getByRole("button", { name: "继续“写作测试”" }).click();
  const input = page.locator(".inputbar textarea");
  await input.fill("问掌柜宽限几日");
  await page.getByRole("button", { name: "展开输入", exact: true }).click();
  await page.getByLabel("完整输入").fill("问掌柜宽限几日\n说明我的打算");
  await page.keyboard.press("Control+Enter");
  check("展开输入的快捷键不会发送", requests.length === 0);
  await shot("01-full-input");
  await page.getByText("常用行动", { exact: true }).click();
  await page.getByRole("button", { name: "存为常用行动" }).click();
  await page.getByRole("textbox", { name: "保存为常用行动" }).fill("问掌柜");
  await page.getByRole("alertdialog").getByRole("button", { name: "保存" }).click();
  await page.getByRole("button", { name: "完成输入" }).click();
  check("全文编辑只填入输入框", (await input.inputValue()).includes("\n说明我的打算") && requests.length === 0);
  await page.getByRole("button", { name: "展开输入", exact: true }).click();
  await page.getByLabel("完整输入").fill("");
  await page.locator("summary", { hasText: "常用行动" }).click();
  await page.getByRole("button", { name: "问掌柜", exact: true }).click();
  check("常用行动可复用", (await page.getByLabel("完整输入").inputValue()).includes("问掌柜宽限"));
  await page.getByRole("button", { name: "完成输入" }).click();

  await page.getByRole("button", { name: "润色行动" }).click();
  await page.getByRole("button", { name: "生成改稿" }).click();
  await page.getByRole("button", { name: "采用到输入框" }).waitFor();
  check("润色生成期间原输入未变化", (await input.inputValue()).includes("说明我的打算"));
  await page.getByRole("button", { name: "采用到输入框" }).click();
  check("采用润色只填输入且使用辅助模型", (await input.inputValue()) === polish && requests.length === 1 && requests[0].model === "fake-aux");
  await page.getByRole("button", { name: "撤回", exact: true }).click();
  check("润色输入可以撤回", (await input.inputValue()).includes("说明我的打算"));

  slow = true;
  await page.getByRole("button", { name: "润色行动" }).click();
  await page.getByRole("button", { name: "生成改稿" }).click();
  await page.waitForTimeout(200);
  await page.getByRole("button", { name: "取消生成" }).click();
  await page.waitForTimeout(1500);
  check("取消后迟到回复不出现采用按钮", await page.getByRole("button", { name: "采用到输入框" }).count() === 0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  slow = false;

  const menu = async () => { await page.locator(".turn").last().click({ button: "right" }); };
  await menu(); await page.getByRole("button", { name: "AI 改写", exact: true }).click();
  await page.getByRole("radio", { name: /^第 2 段/ }).check({ force: true });
  await page.getByRole("button", { name: "生成改稿" }).click();
  await page.getByRole("button", { name: "采用改稿", exact: true }).waitFor();
  await shot("02-rewrite-preview");
  check("段落改写采用前保留原文", (await page.locator(".story").textContent()).includes("细雨落在窗边"));
  await page.getByRole("button", { name: "采用改稿", exact: true }).click();
  await page.getByText(rewrite, { exact: true }).waitFor();
  const saved = await page.evaluate(async ({ worldId, originalId, originalLine }) => {
    const { game } = window.__lishi;
    const world = await game.repo.getWorld(worldId);
    const lines = await game.repo.lines(worldId);
    return { line: world.currentLineId, lines: lines.length, originalHead: (await game.repo.getLine(originalLine)).nodeId, node: await game.repo.getNode(originalId) };
  }, seeded);
  // R14: the adopted wording goes into the passage itself, as the player's own 改写 does; no new route.
  check("改写只替换选中段落，就地改在这一段上", saved.line === seeded.originalLine && saved.lines === 1 && saved.originalHead === seeded.originalId
    && saved.node.narrative === `客栈里很安静。\n\n${rewrite}\n\n掌柜拨着算盘。` && saved.node.meta.original === seeded.original);
  await menu(); await page.getByRole("button", { name: "恢复 AI 写的原文" }).click();
  await page.getByText("细雨落在窗边。", { exact: true }).waitFor();
  check("采用后可恢复原文", true);
  await menu(); await page.getByRole("button", { name: "AI 改写", exact: true }).click();
  await page.getByRole("radio", { name: /^第 2 段/ }).check({ force: true });
  await page.getByRole("button", { name: "生成改稿" }).click();
  await page.getByRole("button", { name: "采用改稿", exact: true }).click();
  await page.getByText(rewrite, { exact: true }).waitFor();
  await menu(); await page.getByRole("button", { name: "恢复 AI 写的原文" }).click();
  await page.getByText("细雨落在窗边。", { exact: true }).waitFor();
  check("恢复后还能再改、再恢复", true);

  const more = async (name) => { await page.getByRole("button", { name: "更多", exact: true }).click(); await page.getByRole("button", { name, exact: true }).click(); };
  await more("故事设定与要点");
  await page.getByRole("textbox", { name: "叙事方针", exact: true }).fill("多写市井闲谈");
  await page.getByLabel("给 AI 的额外规则").fill("不要替我回答");
  await page.getByText("我的要求组", { exact: true }).click();
  await page.getByRole("button", { name: "将下方要求存为一组" }).click();
  await page.getByRole("textbox", { name: "保存叙事要求组" }).fill("市井闲谈");
  await page.getByRole("alertdialog").getByRole("button", { name: "保存" }).click();
  await page.getByRole("button", { name: "选用“市井闲谈”" }).waitFor();
  await page.getByRole("textbox", { name: "叙事方针", exact: true }).fill("紧张些");
  await page.getByRole("button", { name: "选用“市井闲谈”" }).click();
  check("要求组先填入草稿", (await page.getByRole("textbox", { name: "叙事方针", exact: true }).inputValue()) === "多写市井闲谈");
  await page.getByRole("button", { name: "撤回选用" }).click();
  check("选用要求组可撤回", (await page.getByRole("textbox", { name: "叙事方针", exact: true }).inputValue()) === "紧张些");
  await page.getByRole("button", { name: "选用“市井闲谈”" }).click();
  await shot("03-presets");
  await page.getByRole("button", { name: "保存", exact: true }).click();

  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("tab", { name: "设定", exact: true }).click();
  await page.getByLabel("搜索设定").fill("同行");
  check("设定可按别名搜索", (await page.locator(".codex-item").count()) === 1 && (await page.locator(".codex-item").textContent()).includes("商会"));
  await page.getByLabel("搜索设定").fill("");
  await page.getByRole("group", { name: "设定分类" }).getByRole("button", { name: "物品", exact: true }).click();
  check("分类筛选有效", (await page.locator(".codex-item").count()) === 1 && (await page.locator(".codex-item").textContent()).includes("铜钥匙"));
  await page.getByRole("group", { name: "设定分类" }).getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("button", { name: "批量删除" }).click();
  check("不能多选删除当前所在地", await page.getByLabel("选择地点：客栈", { exact: true }).isDisabled());
  await page.getByLabel("选择地点：旧书铺").check();
  await page.getByLabel("选择势力：商会").check();
  await shot("04-codex-batch");
  await page.getByRole("button", { name: "删除所选（2）" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "删除", exact: true }).click();
  await page.getByRole("button", { name: "批量删除" }).waitFor();
  check("批量删除两项", !(await page.locator(".panel-body").textContent()).includes("旧书铺") && !(await page.locator(".panel-body").textContent()).includes("商会"));
  await page.keyboard.press("Escape");
  await more("撤销");
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("tab", { name: "设定", exact: true }).click();
  check("整批删除一步撤销", (await page.locator(".panel-body").textContent()).includes("旧书铺") && (await page.locator(".panel-body").textContent()).includes("商会"));
  await page.keyboard.press("Escape");

  slow = true;
  await input.fill("问掌柜宽限几日");
  await page.getByRole("button", { name: "润色行动" }).click();
  await page.getByRole("button", { name: "生成改稿" }).click();
  await page.waitForTimeout(150);
  await input.fill("我刚刚改写的新输入");
  await page.getByRole("button", { name: "采用到输入框" }).click();
  await page.getByRole("alert").waitFor();
  check("预览采用不能覆盖新输入", (await input.inputValue()) === "我刚刚改写的新输入" && (await page.getByRole("alert").textContent()).includes("输入已经改过"));
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "润色行动" }).click();
  await page.getByRole("button", { name: "生成改稿" }).click();
  await page.waitForTimeout(150);
  await page.evaluate(async ({ worldId }) => { await window.__lishi.game.editState(worldId, { setStats: { money: 700 } }, "测试期间的新修改"); }, seeded);
  await page.getByRole("alert").waitFor();
  check("生成期间节点变化拒绝迟到结果", (await page.getByRole("alert").textContent()).includes("故事或原文已经变了") && await page.getByRole("button", { name: "采用到输入框" }).count() === 0);
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "继续“写作测试”" }).click();
  slow = false;

  failure = true;
  await input.fill("再问问");
  await page.getByRole("button", { name: "润色行动" }).click();
  await page.getByRole("button", { name: "生成改稿" }).click();
  await page.getByRole("alert").waitFor();
  check("失败不改输入并可重试", (await input.inputValue()) === "再问问" && await page.getByRole("button", { name: "生成改稿" }).isEnabled());
  await page.getByRole("button", { name: "取消", exact: true }).click();
  failure = false; slow = true;
  await page.getByRole("button", { name: "润色行动" }).click();
  await page.getByRole("button", { name: "生成改稿" }).click();
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "返回", exact: true }).click();
  await page.getByRole("button", { name: "继续“异世界测试”" }).click();
  await input.fill("另一个世界的输入");
  await page.waitForTimeout(1500);
  check("离开并切换世界后迟到结果不覆盖", (await input.inputValue()) === "另一个世界的输入" && (await page.locator(".sheet").count()) === 0);
  slow = false;
  await more("本局设置");
  check("异世界设置隐藏用词提醒与纪年入口", !(await page.locator(".sheet").textContent()).includes("用词提醒") && !(await page.locator(".sheet").textContent()).includes("纪年与货币"));
  check("主角面板默认关闭", !(await page.getByLabel("显示主角面板").isChecked()));
  await page.getByLabel("显示主角面板").check();
  check("主角面板限制2000字", await page.getByLabel("主角面板内容").getAttribute("maxlength") === "2000");
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "角色", exact: true }).click();
  await page.getByRole("tab", { name: "设定", exact: true }).click();
  check("异世界显示世界卡", (await page.locator(".codex-era").textContent()).includes("世界卡") && !(await page.locator(".codex-era").textContent()).includes("时代卡"));
  await page.locator(".codex-era").getByRole("button", { name: "编辑", exact: true }).click();
  check("异世界编辑世界卡", await page.getByRole("dialog", { name: "修改世界卡" }).count() === 1);
  await page.keyboard.press("Escape"); await page.keyboard.press("Escape");
  await more("故事设定与要点");
  await page.getByText(/我的要求组/).click();
  check("要求组可以跨世界复用", await page.getByRole("button", { name: "选用“市井闲谈”" }).count() === 1);
  await page.keyboard.press("Escape");
  await page.getByRole("button", { name: "展开输入", exact: true }).click();
  check("手机尺寸无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  await page.setViewportSize({ width: 1280, height: 900 });
  await shot("05-desktop-input");
  check("桌面尺寸无横向溢出", await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  check("桌面侧栏不会挡住关闭按钮", await page.locator(".sheet-close").evaluate((el) => { const r = el.getBoundingClientRect(); return el.contains(document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)); }));
  await page.keyboard.press("Escape");
  await page.evaluate(() => window.__lishiFlush?.()); await page.reload();
  await page.getByRole("button", { name: "继续“异世界测试”" }).click();
  await more("故事设定与要点");
  await page.getByText(/我的要求组/).click();
  check("重开后要求组仍在", await page.getByRole("button", { name: "选用“市井闲谈”" }).count() === 1);
  const usage = await page.evaluate(async () => window.__lishi.game.platform.sql.query("SELECT purpose, outcome, model, world_id, node_id FROM usage"));
  check("写作调用日志绑定世界节点并记录取消失败", usage.every((u) => u.world_id && u.node_id && u.model === "fake-aux") && usage.some((u) => u.outcome === "cancelled") && usage.some((u) => u.outcome === "failed"));
  check("浏览器无运行错误", errors.length === 0);
} catch (e) {
  checks.push({ name: e.message, ok: false });
  if (page) await shot("failure").catch(() => {});
  process.exitCode = 1;
} finally {
  fs.writeFileSync(path.join(out, "results.json"), JSON.stringify({ at: new Date().toISOString(), modelBudget: 0, checks, errors, requests: requests.length }, null, 2));
  console.log(checks.map((c) => `${c.ok ? "PASS" : "FAIL"} ${c.name}`).join("\n"));
  if (errors.length) console.log("Page errors:", errors);
  await browser?.close();
  await server.close();
}
