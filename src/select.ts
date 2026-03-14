import { checkbox } from '@inquirer/prompts';
import type { CuratedItem } from './types.js';

export async function select(items: CuratedItem[]): Promise<CuratedItem[]> {
  if (items.length === 0) {
    throw new Error('没有可选的资讯条目');
  }

  console.log(`\n[select] AI 整理出 ${items.length} 条资讯，请选择 6-10 条发布：\n`);

  const selected = await checkbox<CuratedItem>({
    message: '用空格键选中/取消，↑↓ 翻页，回车确认（建议选 6-10 条）：',
    choices: items.map((item, i) => {
      const index = String(i + 1).padStart(2, ' ');
      const tags = item.tags.length > 0 ? ` [${item.tags.join('/')}]` : '';
      const preview = item.summary.length > 70
        ? item.summary.slice(0, 70) + '…'
        : item.summary;
      return {
        name: `${index}. ${item.title}${tags}\n      ${preview}`,
        value: item,
        short: item.title,
      };
    }),
    pageSize: 12,
  });

  if (selected.length === 0) {
    throw new Error('未选择任何条目，已取消发布');
  }

  console.log(`\n[select] 已选择 ${selected.length} 条资讯`);
  return selected;
}
