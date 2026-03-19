import 'dotenv/config';
import { collect } from './collect.js';
import { curate } from './curate.js';
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

  const rankedItems = rankItems(collectedItems);
  const candidateItems = selectCandidatePool(rankedItems);
  const curatedItems = await curate(candidateItems);
  if (curatedItems.length === 0) {
    console.log('AI 未整理出任何资讯，本次运行结束。');
    process.exit(0);
  }

  const selectedItems = await select(curatedItems);
  const formatted = format(selectedItems);

  const candidateUrls = new Set(candidateItems.map((item) => item.url));
  const curatedUrls = new Set(curatedItems.map((item) => item.url));
  const selectedUrls = new Set(selectedItems.map((item) => item.url));
  const report = {
    date: formatted.date,
    rankedItems: rankedItems.map((item) => ({
      ...item,
      enteredCandidatePool: candidateUrls.has(item.url),
      selectedByLlm: curatedUrls.has(item.url),
      selectedByHuman: selectedUrls.has(item.url),
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
