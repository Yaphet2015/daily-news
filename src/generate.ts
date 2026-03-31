import 'dotenv/config';
import { collect } from './collect.js';
import { attachReaderBriefs, curate } from './curate.js';
import { select } from './select.js';
import { format } from './format.js';
import { publish } from './publish.js';
import { rankItems, selectCandidatePool } from './rank.js';

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log(' AI daily-news');
  console.log('═══════════════════════════════════════════════════════════\n');

  const collectedItems = await collect();
  if (collectedItems.length === 0) {
    console.log('没有采集到新内容，本次运行结束。');
    process.exit(0);
  }

  const enrichedCollectedItems = await attachReaderBriefs(collectedItems);
  const rankedItems = rankItems(enrichedCollectedItems);
  const candidateItems = selectCandidatePool(rankedItems);
  const curatedItems = await curate(candidateItems);
  if (curatedItems.length === 0) {
    console.log('AI 未整理出任何资讯，本次运行结束。');
    process.exit(0);
  }

  const selectedItems = await select(curatedItems);
  const formatted = format(selectedItems);

  const candidateIds = new Set(candidateItems.map((item) => item.id));
  const curatedIds = new Set(curatedItems.map((item) => item.id));
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  const report = {
    date: formatted.date,
    rankedItems: rankedItems.map((item) => ({
      ...item,
      enteredCandidatePool: candidateIds.has(item.id),
      selectedByLlm: curatedIds.has(item.id),
      selectedByHuman: selectedIds.has(item.id),
    })),
    curatedItems,
    selectedItems,
  };

  await publish(formatted, report);

  console.log('\n✅  全部完成！');
}

main().catch((err) => {
  console.error('\n❌  运行失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
