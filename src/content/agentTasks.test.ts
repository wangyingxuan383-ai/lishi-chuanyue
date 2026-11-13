import { describe, expect, it } from "vitest";
import { BUILTIN_AGENT_SKILLS } from "../engine/agent";
import { AGENT_TASK_RECIPES, taskRecipe, taskRecipeText } from "./agentTasks";

describe("editable Agent task drafts", () => {
  it("resolves every recipe skill and safely ignores retired draft selections", () => {
    const skills = new Set<string>(BUILTIN_AGENT_SKILLS.map(skill => skill.id));
    expect(AGENT_TASK_RECIPES.flatMap(recipe => recipe.skills).every(id => skills.has(id))).toBe(true);
    expect(taskRecipe("retired-recipe")).toBeUndefined();
    expect(taskRecipe({ id: AGENT_TASK_RECIPES[0].id })).toBeUndefined();
  });

  it("keeps a chosen range and the player's existing multiline requirements editable", () => {
    const recipe = AGENT_TASK_RECIPES[0];
    const original = "保留我改写的人物结局。\n只读前十章，不要查后文。";
    const text = taskRecipeText(recipe, "第12回合及其直接关联", original);
    expect(text).toContain("范围：第12回合及其直接关联");
    expect(text).toContain(original);
    expect(text.indexOf(original)).toBeGreaterThan(text.indexOf(recipe.request));
    expect(taskRecipeText(recipe, "  ", "")).toContain(`范围：${recipe.scope}`);
  });
});
