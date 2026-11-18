import { describe, expect, it } from "vitest";
import { templateName, TEMPLATES, TEMPLATE_NAME_MAX } from "./templates";
import { FREE_TEMPLATES } from "./freeTemplates";

describe("random template names fit the name field", () => {
  it("never exceeds the limit, for every template and gender", () => {
    for (const t of [...TEMPLATES, ...FREE_TEMPLATES]) for (const gender of ["男", "女"] as const) for (let i = 0; i < 30; i++) {
      const name = templateName(t, gender);
      expect([...name].length, `${t.id}: ${name}`).toBeLessThanOrEqual(TEMPLATE_NAME_MAX);
      expect(name.trim(), t.id).not.toBe("");
    }
  });
});
