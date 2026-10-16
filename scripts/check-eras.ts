// Lists problems in every registered era pack and the length of its prompt
// excerpt month by month (docs/contracts/ERA_PACK.md).
//   node_modules/.bin/tsx scripts/check-eras.ts
import { ERAS } from "../src/content/eras/index.ts";
import { EXCERPT_LIMIT, eraExcerpt } from "../src/engine/era/excerpt.ts";
import { validatePack } from "../src/engine/era/validate.ts";

let failed = false;
for (const pack of ERAS) {
  const issues = validatePack(pack);
  const lengths = Array.from({ length: 12 }, (_, i) => eraExcerpt(pack, { ...pack.start.date, month: i + 1, day: 1 }).length);
  console.log(`${pack.id}（${pack.title}）：身份 ${pack.identities.length}，禁忌 ${pack.taboos.length}，事件 ${pack.timeline.length}，摘录 ${Math.min(...lengths)}～${Math.max(...lengths)} 字（上限 ${EXCERPT_LIMIT}）`);
  for (const issue of issues) console.log(`  ✗ ${issue.path}：${issue.message}`);
  if (issues.length) failed = true;
}
if (failed) process.exitCode = 1;
else console.log("全部通过");
