import 'dotenv/config';
import { collect } from './collect.js';
import { curate } from './curate.js';
import { select } from './select.js';
import { format } from './format.js';
import { publish } from './publish.js';

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════════');
  console.log('  daily-news  AI 日刊生成器');
  console.log('═══════════════════════════════════════════════════════════\n');

  // Step 1: Collect tweets
  const tweets = await collect();
  if (tweets.length === 0) {
    console.log('没有采集到新推文，本次运行结束。');
    process.exit(0);
  }

  // Step 2: AI curation
  const curated = await curate(tweets);
  if (curated.length === 0) {
    console.log('AI 未整理出任何资讯，本次运行结束。');
    process.exit(0);
  }

  // Step 3: Manual selection
  const selected = await select(curated);

  // Step 4: Format
  const formatted = format(selected);

  // Step 5: Publish
  await publish(formatted);

  console.log('\n✅  全部完成！');
}

main().catch((err) => {
  console.error('\n❌  运行失败:', err instanceof Error ? err.message : err);
  process.exit(1);
});
