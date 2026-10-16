import type { WorldState } from "../types";

export function sampleState(money = 300): WorldState {
  return {
    version: 1,
    time: { start: "天宝七载冬月十七", elapsedMinutes: 0 },
    placeId: null,
    protagonist: {
      name: "李安", aliases: [], age: 22, gender: "男", identity: "落第举子", origin: "历史系研究生", cheat: "",
      stats: { money, debt: 0, health: 80, energy: 70, fame: 10 }, statuses: [], items: [],
    },
    people: [], places: [], cards: [], goals: [], era: { packId: "tang-748" }, deviations: [],
  };
}
