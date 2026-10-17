// Quick R02 smoke on the phone via WebView devtools, against fake-llm through
// `adb reverse tcp:18800 tcp:18800`. Cleans up the test profile and world.
//   node scripts/ui/phone-flow.mjs <adb-serial>
import { execFileSync } from "node:child_process";
import path from "node:path";
import { chromium } from "playwright-core";

const SDK = process.env.ANDROID_HOME || path.join(process.env.LOCALAPPDATA ?? "", "Android", "Sdk");
const ADB = path.join(SDK, "platform-tools", "adb.exe");
const serial = process.argv[2];
const adb = (...a) => execFileSync(ADB, ["-s", serial, ...a], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (n, ok, d = "") => results.push(`${ok ? "PASS" : "FAIL"} ${n}${d ? ` — ${d}` : ""}`);

const pid = adb("shell", "pidof", "io.timejump.chuanyue");
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
adb("reverse", "tcp:18800", "tcp:18800");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0];
const shot = (n) => page.screenshot({ path: `.cache/ui/phone-${n}.png` });

try {
  await page.getByText("连接 AI 服务").waitFor();
  await page.getByRole("button", { name: "自定义" }).click();
  await page.getByLabel("服务地址").fill("http://127.0.0.1:18800/v1");
  await page.getByText(/这是 HTTP 地址/).click();
  await page.getByLabel(/API Key/).fill("fake-phone-key");
  await page.getByRole("button", { name: "获取模型列表" }).click();
  await page.locator("select").selectOption("fake-normal");
  await page.getByRole("button", { name: "测试连接" }).click();
  await page.getByText(/连接成功/).waitFor({ timeout: 15000 });
  check("setup on phone (Keystore + Rust stream)", true);
  await page.getByRole("button", { name: "保存，开始穿越" }).click();
  await page.getByRole("button", { name: "随便穿" }).click();
  await page.locator(".dock .choice").first().waitFor({ timeout: 30000 });
  await shot("opening");
  check("opening on phone", true);

  await page.locator(".inputbar textarea").click();
  await sleep(1200);
  const kb = await page.evaluate(() => ({ h: innerHeight, dock: document.querySelector(".dock").getBoundingClientRect().bottom }));
  await shot("keyboard");
  check("input bar visible with keyboard", kb.dock <= kb.h + 1, JSON.stringify(kb));
  await page.locator(".inputbar textarea").fill("推开门出去看看");
  await page.locator(".send-btn").click();
  await page.getByRole("button", { name: "重说" }).waitFor({ timeout: 30000 });
  check("turn on phone", (await page.textContent("body")).includes("王掌柜叉着腰"));

  await page.getByRole("button", { name: "角色" }).click();
  await page.locator(".panel").waitFor();
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await page.locator(".panel").waitFor({ state: "detached", timeout: 5000 });
  check("Android back closes the panel", true);
  adb("shell", "input", "keyevent", "KEYCODE_BACK");
  await page.getByText("继续游玩").waitFor({ timeout: 5000 });
  check("Android back returns to home", true);
  await shot("home");
} finally {
  // Remove the fake profile, its key and the test world.
  await page.evaluate(async () => {
    const invoke = window.__TAURI_INTERNALS__.invoke;
    const profiles = await invoke("sql_query", { sql: "SELECT key_slot FROM profiles", params: [] });
    for (const p of profiles) await invoke("secret_remove", { slot: p.key_slot });
    await invoke("secret_remove", { slot: "main" });
    await invoke("sql_batch", { statements: [
      { sql: "DELETE FROM lines", params: [] }, { sql: "DELETE FROM states", params: [] }, { sql: "DELETE FROM nodes", params: [] },
      { sql: "DELETE FROM worlds", params: [] }, { sql: "DELETE FROM profiles", params: [] }, { sql: "DELETE FROM usage", params: [] },
      { sql: "DELETE FROM settings", params: [] },
      { sql: "DROP TABLE IF EXISTS dev_settings", params: [] }, { sql: "DROP TABLE IF EXISTS dev_samples", params: [] },
    ] });
  });
  await page.reload();
  await page.getByText("连接 AI 服务").waitFor({ timeout: 10000 }).then(() => check("test data cleaned, back to first launch", true)).catch(() => check("cleanup", false));
  await browser.close();
  console.log(results.join("\n"));
}
