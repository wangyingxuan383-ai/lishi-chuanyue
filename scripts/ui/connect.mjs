// Connects the local fake model on the AI service screen (scripts/fake-llm.mjs).
// Shared by the UI scripts so a change to that screen is made once.
//   await connectFake(page, { port: 18800, model: "fake-normal" })
export async function connectFake(page, { port = Number(process.env.LISHI_FAKE_PORT ?? 18800), model = "fake-normal", check } = {}) {
  await page.getByRole("button", { name: /^服务商：/ }).click();
  await page.locator(".sheet .mode-option", { hasText: "自定义" }).click();
  await page.getByLabel("服务地址").fill(`http://127.0.0.1:${port}/v1`);
  await page.getByText(/这是 HTTP 地址/).click();
  await page.getByLabel(/API Key/).fill("fake-ui-key");
  // The model list arrives by itself once a key is in.
  await page.getByRole("button", { name: /^写故事用的模型：/ }).waitFor({ timeout: 15000 });
  check?.("setup: the model list arrives after the key, no button needed", true);
  await page.getByRole("button", { name: /^写故事用的模型：/ }).click();
  await page.locator(".sheet .mode-option", { hasText: new RegExp(`^${model}`) }).click();
  check?.("setup: a custom service gets a name of its own", (await page.getByLabel("名称").inputValue()) === "127.0.0.1");
  await page.getByRole("button", { name: /^连接并(开始|保存)$/ }).click();
}
