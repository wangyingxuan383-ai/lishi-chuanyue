// Diagnoses what happens to a stream while the app is in the background.
//   node scripts/ui/android-bg-probe.mjs <adb-serial> [seconds-in-background] [model]
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const ADB = "C:/Users/Windows11/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const [serial, secondsArg = "30", model = "fake-slow"] = process.argv.slice(2);
const PKG = "io.timejump.chuanyue";
const adb = (...args) => execFileSync(ADB, ["-s", serial, ...args], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const pid = adb("shell", "pidof", PKG) || (adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1"), await sleep(3000), adb("shell", "pidof", PKG));
adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
adb("reverse", "tcp:18800", "tcp:18800");
const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
const page = browser.contexts()[0].pages()[0];
await page.waitForFunction(() => document.body.innerText.includes("平台：android") && !document.body.innerText.includes("读取中"));
await page.getByLabel("模型").fill(model);
await page.getByRole("button", { name: "试写一段" }).click();
await page.getByText("写作中…").waitFor();

// Record the stream id from the page by listing active streams through IPC.
const list = () => page.evaluate(() => window.__TAURI_INTERNALS__.invoke("llm_stream_list"));
const streams = await list();
const active = streams.find((s) => s.active);
console.log("active stream", active?.streamId);
adb("shell", "input", "keyevent", "KEYCODE_HOME");
const started = Date.now();
await sleep(Number(secondsArg) * 1000);
adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");
await sleep(2000);
console.log("back after", Math.round((Date.now() - started) / 1000), "s");
const snap = await page.evaluate((id) => window.__TAURI_INTERNALS__.invoke("llm_stream_resume", { streamId: id }), active.streamId).catch((e) => ({ error: String(e) }));
if (snap?.events) {
  const kinds = snap.events.map((e) => e.type === "error" ? `error:${e.kind}` : e.type);
  const data = snap.events.filter((e) => e.type === "data").length;
  console.log("cached events:", data, "data;", kinds.filter((k) => k !== "data").join(","), "active:", snap.active);
} else console.log("resume:", JSON.stringify(snap));
await sleep(15000);
console.log("page note:", await page.locator("p.muted").last().textContent());
console.log("text length:", (await page.locator("article.story").first().textContent()).length);
await browser.close();
