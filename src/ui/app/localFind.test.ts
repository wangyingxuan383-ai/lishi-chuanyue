import { describe, expect, it } from "vitest";
import { localFind } from "./localFind";

describe("local display field lookup", () => {
  it("matches normalized names and requires each word across supplied fields", () => {
    expect(localFind("　ＡＩ 自动滚动　", "AI", "生成时自动滚动")).toBe(true);
    expect(localFind("甲 密信", "城中旧事", "主角甲", "拿到了密信")).toBe(true);
    expect(localFind("甲 密信", "城中旧事", "主角乙", "拿到了密信")).toBe(false);
    expect(localFind("  ", undefined, null)).toBe(true);
  });
  it("treats metacharacters as text and never searches unspecified fields", () => {
    const entry = { label: "AI服务", keywords: "连接 模型 Key", privateAddress: "private.invalid", key: "not-public" };
    expect(localFind("private.invalid", entry.label, entry.keywords)).toBe(false);
    expect(localFind("not-public", entry.label, entry.keywords)).toBe(false);
    expect(localFind(".*", "任意标题")).toBe(false);
    expect(localFind(".*", "字面内容.*")).toBe(true);
  });
});
