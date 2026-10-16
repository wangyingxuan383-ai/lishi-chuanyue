// Drives the native Windows app through WebView2's debugging port.
//   start:  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS='--remote-debugging-port=9224'; target\debug\lishi-app.exe
//   run:    node scripts/ui/native-devcheck.mjs [phase]   phase = first | after-restart | cleanup
// Android: adb forward tcp:9333 localabstract:webview_devtools_remote_<pid>; adb reverse tcp:18800 tcp:18800;
//          set CDP_PORT=9333 EXPECT_PLATFORM=android
// Needs scripts/fake-llm.mjs on :18800. Uses an obviously fake key.
import { chromium } from "playwright-core";

const phase = process.argv[2] ?? "first";
const browser = await chromium.connectOverCDP(`http://127.0.0.1:${process.env.CDP_PORT ?? 9224}`);
const page = browser.contexts()[0].pages().find((p) => p.url().includes("tauri.localhost")) ?? browser.contexts()[0].pages()[0];
const results = [];
const check = (name, ok, detail = "") => results.push(`${ok ? "PASS" : "FAIL"} ${name}${detail ? ` — ${detail}` : ""}`);
const body = () => page.textContent("body");

await page.waitForFunction(() => /平台：(windows|android|other)/.test(document.body.innerText) && !document.body.innerText.includes("读取中"));
const expected = process.env.EXPECT_PLATFORM ?? "windows";
check(`native platform detected (${expected})`, (await body()).includes(`平台：${expected}`));

if (phase === "first") {
  await page.getByLabel("服务地址").fill("http://127.0.0.1:18800/v1");
  await page.getByLabel("模型").fill("fake-normal");
  await page.getByLabel(/API Key/).fill("fake-native-key");
  await page.getByRole("button", { name: "保存" }).click();
  await page.getByText("服务已保存").waitFor();
  check("key stored via platform secret store", (await body()).includes("已保存（http://127.0.0.1:18800/v1）"));
  const leaked = await page.evaluate(() => JSON.stringify(localStorage) + document.cookie);
  check("key not visible to page storage", !leaked.includes("fake-native-key"));

  await page.getByRole("button", { name: "获取模型" }).click();
  await page.getByText(/获取到 5 个模型/).waitFor();
  check("llm_get through Rust", true);

  await page.getByRole("button", { name: "试写一段" }).click();
  const lengths = [];
  for (let i = 0; i < 8; i++) {
    await page.waitForTimeout(120);
    lengths.push((await page.locator("article.story").first().textContent()).length);
  }
  await page.getByText(/^完成：/).waitFor({ timeout: 15000 });
  check("progressive streaming through Rust channel", new Set(lengths).size >= 3, lengths.join(","));
  check("usage via include_usage", (await body()).includes("用量 50/120"));

  await page.getByLabel("模型").fill("fake-slow");
  await page.getByRole("button", { name: "试写一段" }).click();
  await page.getByText("写作中…").waitFor();
  await page.waitForTimeout(900);
  await page.getByRole("button", { name: "停止" }).click();
  await page.getByText("已停止").waitFor({ timeout: 5000 });
  check("cancel", true);


  await page.getByLabel("服务地址").fill("http://127.0.0.1:18801/v1");
  await page.getByLabel("模型").fill("fake-normal");
  await page.getByRole("button", { name: "试写一段" }).click();
  await page.getByText(/地址和保存 Key 时的服务不一致/).waitFor({ timeout: 5000 });
  check("unbound url refused", true);

  const samples = await page.locator("details").count();
  check("sample saved", samples >= 1, `${samples}`);
}

if (phase === "after-restart") {
  const samples = await page.locator("details").count();
  check("samples survive app restart", samples >= 1, `${samples}`);
  check("key status survives restart", (await body()).includes("已保存（http://127.0.0.1:18800/v1）"));
}

if (phase === "cleanup") {
  await page.evaluate(() => (window).__TAURI_INTERNALS__.invoke("secret_remove", { slot: "main" }));
  await page.reload();
  await page.waitForFunction(() => !document.body.innerText.includes("读取中"));
  check("test key removed", (await body()).includes("Key：未保存"));
}

console.log(results.join("\n"));
await browser.close();
process.exitCode = results.some((r) => r.startsWith("FAIL")) ? 1 : 0;
