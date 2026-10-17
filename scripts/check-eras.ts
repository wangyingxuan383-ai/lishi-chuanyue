// Lists problems in every registered era pack and the length of the
// era card it turns into (docs/contracts/ERA_PACK.md).
//   node_modules/.bin/tsx scripts/check-eras.ts
import { ERAS } from "../src/content/eras/index.ts";
import { eraCardText } from "../src/engine/era/card.ts";
import { ERA_CARD_LIMIT } from "../src/engine/memory/cards.ts";
import { validatePack } from "../src/engine/era/validate.ts";

let failed = false;
for (const pack of ERAS) {
  const issues = validatePack(pack);
  const length = eraCardText(pack).length;
  console.log(`${pack.id}（${pack.title}）：身份 ${pack.identities.length}，禁忌 ${pack.taboos.length}，事件 ${pack.timeline.length}，时代卡 ${length} 字（上限 ${ERA_CARD_LIMIT}）`);
  for (const issue of issues) console.log(`  ✗ ${issue.path}：${issue.message}`);
  if (issues.length) failed = true;
}
if (failed) process.exitCode = 1;
else console.log("全部通过");
