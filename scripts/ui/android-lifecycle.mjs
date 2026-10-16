// Android lifecycle checks for the R01 self-check page, driven over adb + WebView devtools.
//   node scripts/ui/android-lifecycle.mjs <adb-serial>
// Needs scripts/fake-llm.mjs on :18800 and the key saved by native-devcheck "first".
import { execFileSync } from "node:child_process";
import { chromium } from "playwright-core";

const ADB = "C:/Users/Windows11/AppData/Local/Android/Sdk/platform-tools/adb.exe";
const serial = process.argv[2];
const PKG = "io.timejump.chuanyue";
const adb = (...args) => execFileSync(ADB, ["-s", serial, ...args], { encoding: "utf8" }).trim();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);

async function attach() {
  for (let i = 0; i < 20; i++) {
    let pid = "";
    try { pid = adb("shell", "pidof", PKG); } catch { pid = ""; }
    if (pid) {
      adb("forward", "tcp:9333", `localabstract:webview_devtools_remote_${pid}`);
      adb("reverse", "tcp:18800", "tcp:18800");
      try {
        const browser = await chromium.connectOverCDP("http://127.0.0.1:9333");
        const page = browser.contexts()[0].pages()[0];
        await page.waitForFunction(() => document.body.innerText.includes("平台：android") && !document.body.innerText.includes("读取中"), null, { timeout: 15000 });
        return { browser, page };
      } catch { /* retry */ }
    }
    await sleep(1000);
  }
  throw new Error("could not attach to the app WebView");
}

const launch = () => adb("shell", "monkey", "-p", PKG, "-c", "android.intent.category.LAUNCHER", "1");

// 1. Background during generation, return after the stream has finished.
let { browser, page } = await attach();
await page.getByLabel("服务地址").fill("http://127.0.0.1:18800/v1");
await page.getByLabel("模型").fill("fake-slow");
await page.getByRole("button", { name: "保存" }).click();
await page.getByText("服务已保存").waitFor();
await page.getByRole("button", { name: "试写一段" }).click();
await page.getByText("写作中…").waitFor();
const before = (await page.locator("article.story").first().textContent()).length;
adb("shell", "input", "keyevent", "KEYCODE_HOME");
await sleep(30000);
launch();
await sleep(2500);
await page.getByText(/^完成：/).waitFor({ timeout: 20000 }).catch(() => {});
const after = (await page.locator("article.story").first().textContent()).length;
check("background 30s during generation → text complete on return", after >= 151, `${before} → ${after} 字`);

// 2. Back button: first press warns and the app stays.
adb("shell", "input", "keyevent", "KEYCODE_BACK");
await sleep(600);
const warned = await page.getByText("再按一次退出").isVisible().catch(() => false);
const stillTop = adb("shell", "dumpsys", "activity", "activities").includes(`${PKG}/`);
check("first back shows 再按一次退出 and app stays", warned && stillTop);
await browser.close();

// 3. Force stop and relaunch: saved samples and key status survive.
adb("shell", "am", "force-stop", PKG);
await sleep(1000);
launch();
({ browser, page } = await attach());
const samples = await page.locator("details").count();
check("samples survive force-stop", samples >= 2, `${samples}`);
check("key survives force-stop", (await page.textContent("body")).includes("已保存（http://127.0.0.1:18800/v1）"));

// 4. Second back within 2 s exits.
adb("shell", "input", "keyevent", "KEYCODE_BACK");
await sleep(300);
adb("shell", "input", "keyevent", "KEYCODE_BACK");
await sleep(1500);
await browser.close().catch(() => {});
let pidAfter = "";
try { pidAfter = adb("shell", "pidof", PKG); } catch { pidAfter = ""; }
check("double back exits the app", pidAfter === "", pidAfter ? `still running (pid ${pidAfter})` : "");

console.log(results.join("\n"));
