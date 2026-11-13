// Applying built-in notes creates ordinary, editable cards in this story.
import type { WorldState } from "../types";
import type { CardPatch } from "../state/apply";
import { matchName } from "../state/names";

export interface ContentCardDraft { id: string; name: string; content: string; keys: string[]; selected: boolean }

/** Prevent add-by-name from overwriting a player card or one of its aliases. */
export function contentCardPatch(state: Pick<WorldState, "cards">, cards: ContentCardDraft[]): CardPatch[] {
  const chosen = cards.filter(card => card.selected);
  if (!chosen.length) throw new Error("先选择要加入本局的资料");
  const pool = state.cards.filter(card => card.kind !== "时代").map(card => ({ id: card.id, name: card.name, aliases: card.keys }));
  const patch: CardPatch[] = [];
  for (const card of chosen) {
    const name = card.name.trim(), content = card.content.trim();
    if (!name || !content) throw new Error("选中的资料需要名称和内容");
    if (matchName(pool, name)) throw new Error(`已经有“${name}”或对应别名，请改名或取消选择，不会覆盖原资料`);
    patch.push({ op: "add", kind: "设定", name, content, keys: [...new Set(card.keys.map(key => key.trim()).filter(Boolean))], source: "玩家" });
    pool.push({ id: card.id, name, aliases: card.keys });
  }
  return patch;
}

/** This is a copy: no stored card subscribes to future built-in content. */
export function editableContentCards(pack: { id: string; version: string; title: string; scope: string; cards: { id: string; title: string; text: string; keywords?: string[]; sourceIds?: string[] }[]; sources?: { id: string; title: string; url: string }[] }): ContentCardDraft[] {
  return pack.cards.map(card => ({
    id: `${pack.id}:${card.id}`, name: `${pack.title} · ${card.title}`, selected: true,
    keys: [...card.keywords ?? []],
    content: [card.text, `适用范围：${pack.scope}`, `资料版本：${pack.title} ${pack.version}`, ...(card.sourceIds ?? []).map(id => pack.sources?.find(source => source.id === id)).filter((source): source is { id: string; title: string; url: string } => !!source).map(source => `来源：${source.title} ${source.url}`)].join("\n"),
  }));
}
