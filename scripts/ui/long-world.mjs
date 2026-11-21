// Long-story regression against the isolated console and loopback fake service.
//   LISHI_APP=http://127.0.0.1:1449/ node scripts/ui/long-world.mjs --play 60
// Seeds 1,000 old passages. --play advances and rewrites the new passages through Game.
import assert from "node:assert/strict";
import { chromium } from "playwright-core";
import { launchBrowser } from "./browser.mjs";
import { connectFake } from "./connect.mjs";

const origin = new URL(process.env.LISHI_APP ?? "http://127.0.0.1:1421/");
const port = Number(process.env.LISHI_FAKE_PORT ?? 18800);
const option = (name, fallback) => process.argv.includes(name) ? Number(process.argv[process.argv.indexOf(name) + 1]) : fallback;
const count = option("--history", 1000), rounds = option("--play", 0);
assert.ok(Number.isInteger(count) && count >= 60 && count <= 2000 && Number.isInteger(rounds) && rounds >= 0 && rounds <= 100);
assert.equal(origin.hostname, "127.0.0.1");
const marker = await (await fetch(new URL("/__ui-isolation", origin))).json();
assert.ok(marker.loopbackOnly && marker.databaseDir?.startsWith(".cache/") && marker.secretsFile === marker.databaseDir + "/fake-secrets.json");
const models = await (await fetch("http://127.0.0.1:" + port + "/v1/models")).json();
assert.ok(models.data?.some((m) => m.id === "fake-normal"));

const browser = await launchBrowser(chromium, { headless: true });
try {
  const context = await browser.newContext({ viewport: { width: 393, height: 852 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true, serviceWorkers: "block" });
  await context.route("**/*", (route) => {
    const url = new URL(route.request().url());
    return ["127.0.0.1", "localhost"].includes(url.hostname) || ["data:", "blob:"].includes(url.protocol) ? route.continue() : route.abort();
  });
  const page = await context.newPage();
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => { if (message.text().startsWith("LONG ")) console.log(message.text()); });
  await page.goto(origin.href);
  await page.waitForFunction(() => !!window.__lishi?.game, null, { timeout: 180000 });
  if (!await page.evaluate(() => !!window.__lishi.game.llm)) {
    const service = page.getByRole("button", { name: /^服务商：/ });
    const begin = page.getByRole("button", { name: /^开始穿越/ });
    await service.or(begin).first().waitFor({ timeout: 120000 });
    if (!await service.isVisible()) await begin.click();
    await connectFake(page, { port });
  }
  await page.waitForFunction(({ port }) => {
    const llm = window.__lishi?.game.llm;
    return llm?.model === "fake-normal" && llm.url.startsWith("http://127.0.0.1:" + port + "/");
  }, { port }, { timeout: 30000 });
  const title = "千回合演练 · " + Date.now();
  const result = await page.evaluate(async ({ count, rounds, title }) => {
    const { game } = window.__lishi, repo = game.repo;
    const tree = await import("/src/engine/tree.ts");
    const { sampleState } = await import("/src/engine/testing/fixtures.ts");
    const { adoptRewrite, adoptPlayerRevision } = await import("/src/engine/writing/assist.ts");
    const state = sampleState();
    state.protagonist.name = "林舟";
    const { world } = await repo.createWorld({
      title, eraId: "free", settings: { depth: "standard", choiceCount: 3, chapterEvery: 12, autoUpkeep: true },
      opening: { parentId: null, kind: "opening", narrative: "林舟在渡口落脚。".repeat(24), state, meta: { openingSeed: state } },
    });
    await repo.setSetting("autoStoryPlot", false);
    let current = await tree.cursor(repo, world.id);
    const start = performance.now();
    let penultimate;
    for (let i = 1; i <= count; i++) {
      if (i === count) penultimate = current.head;
      const narrative = ("第" + i + "段：林舟记录了渡口的变化。").padEnd(600, "文");
      const next = await repo.appendNode(world.id, current.line.id, { parentId: current.head.id, kind: "turn", actionMode: "do", actionText: "记录渡口", narrative, state, choices: ["继续记事", "出门"] });
      current = { ...current, head: next };
    }
    const seedMs = Math.round(performance.now() - start);
    console.log("LONG seeded=" + count + " seedMs=" + seedMs);
    const anchorFor = (target = current.head) => ({ worldId: world.id, lineId: current.line.id, headId: current.head.id, nodeId: target.id, original: target.narrative });
    let staleMarked = false, updatedChapter = false, revisions = 0;
    if (rounds) {
      const chapter = await repo.addChapter({ worldId: world.id, firstNodeId: penultimate.id, lastNodeId: current.head.id,
        title: "渡口旧事", gist: "记事", summary: "换班的时刻尚未确定。", model: "fake-normal", promptVersion: "chapter-1" });
      await adoptRewrite(game, anchorFor(penultimate), "林舟定下了换班时刻。");
      staleMarked = !!(await repo.chaptersOnPath(world.id, current.head.id)).find((row) => row.id === chapter.id)?.stale;
      if (!staleMarked) throw new Error("修改较早正文后，覆盖它的章节没有标为待更新");

      for (let i = 1; i <= rounds; i++) {
        let failure = null;
        const before = current.head.id;
        const handle = game.play(world.id, { mode: "do", text: "林舟查阅渡口记事，准备继续巡看。" }, (event) => {
          if (event.type === "failed") failure = event.reason;
        });
        await handle.done;
        await game.settled();
        current = await tree.cursor(repo, world.id);
        if (failure || current.head.id === before) throw new Error("第 " + i + " 次推进失败：" + (failure ?? "未保存"));
        if (i % 15 === 0) {
          const path = await repo.path(current.head.id);
          const target = [...path].reverse().find((node) => node.kind === "turn");
          const anchor = anchorFor(target);
          const sameLine = current.line.id;
          const manual = i % 30 === 0;
          const text = "你把旧匕首换成短剑，再记录渡口换班的时刻。";
          const preview = manual
            ? await game.runFactSync({ anchor, text }).done
            : await game.runPlayerRevision({ anchor, range: { start: 0, end: anchor.original.length }, hint: "把手里的匕首改为短剑，保持事件先后。" }, () => {}).done;
          const adopted = await adoptPlayerRevision(game, preview);
          if (adopted.line.id !== sameLine || adopted.head.parentId !== target.parentId || !adopted.head.narrative.includes("短剑") || (manual && adopted.head.narrative !== text)) {
            throw new Error("第 " + i + " 次推进后的改稿未按同路线保存");
          }
          current = adopted;
          revisions++;
        }
        if (i % 15 === 0) console.log("LONG play=" + i + "/" + rounds + " revisions=" + revisions);
      }
      updatedChapter = (await repo.chaptersOnPath(world.id, current.head.id)).some((row) => row.id === chapter.id && !row.stale);
      if (!updatedChapter) throw new Error("推进后仍未重写过期章节");
    }
    const saved = (await repo.path(current.head.id)).filter(({ kind }) => kind === "turn").length;
    if (saved !== count + rounds) throw new Error("线路保存的回合数不符：" + saved);
    await window.__lishiFlush?.();
    return { seedMs, saved, staleMarked, updatedChapter, revisions };
  }, { count, rounds, title });

  const start = Date.now();
  await page.reload();
  const card = page.locator(".home-scene, .shelf-book, .strip-card").filter({ hasText: title }).first();
  await card.waitFor();
  const homeMs = Date.now() - start;
  await card.click();
  await page.locator(".turn[data-node-id]").last().waitFor();
  const playMs = Date.now() - start - homeMs;
  const visible = await page.locator(".turn[data-node-id]").count();
  assert.ok(visible > 0 && visible < result.saved, "The long story should render a window of turns.");
  const scrollStart = Date.now();
  await page.getByRole("button", { name: "加载更早的剧情" }).click();
  await page.waitForFunction((size) => document.querySelectorAll(".turn[data-node-id]").length > size, visible);
  const olderMs = Date.now() - scrollStart;
  assert.deepEqual(errors, []);
  console.log(JSON.stringify({ ...result, homeMs, playMs, visible, olderMs }));
} finally {
  await browser.close();
}
