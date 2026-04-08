import { checkbox } from '@inquirer/prompts';
import type { CuratedItem, MediaAsset } from './types.js';

const PREVIEW_LINE_LENGTH = 70;
const PREVIEW_MAX_LINES = 3;
const SHORT_TWEET_THRESHOLD = 500;

function formatPreview(summary: string): string[] {
  const lines: string[] = [];

  for (let offset = 0; offset < summary.length && lines.length < PREVIEW_MAX_LINES; offset += PREVIEW_LINE_LENGTH) {
    lines.push(summary.slice(offset, offset + PREVIEW_LINE_LENGTH));
  }

  if (summary.length > PREVIEW_LINE_LENGTH * PREVIEW_MAX_LINES && lines.length > 0) {
    const lastLine = lines[lines.length - 1] ?? '';
    lines[lines.length - 1] = lastLine.slice(0, Math.max(0, PREVIEW_LINE_LENGTH - 1)) + '…';
  }

  return lines;
}

function formatMediaPlaceholder(media: MediaAsset[]): string | null {
  if (media.length === 0) return null;
  const photoCount = media.filter((m) => m.type === 'photo').length;
  const videoCount = media.filter((m) => m.type === 'video' || m.type === 'animated_gif').length;
  const parts: string[] = [];
  if (photoCount > 0) parts.push(`${photoCount} photo${photoCount > 1 ? 's' : ''}`);
  if (videoCount > 0) parts.push(`${videoCount} video${videoCount > 1 ? 's' : ''}`);
  return parts.length > 0 ? `[📷 ${parts.join(', ')}]` : null;
}

function isShortOriginTweet(item: CuratedItem): boolean {
  return (
    item.source === 'twitter' &&
    item.sourceResolution?.decision === 'keep_origin' &&
    item.originText != null &&
    item.originText.length <= SHORT_TWEET_THRESHOLD
  );
}

export function formatSelectionLabel(item: CuratedItem, index: number): string {
  const metadata = `${item.source} · ${item.attribution} · ${item.author}`;
  const rankingHint =
    typeof item.priorityScore === 'number'
      ? `优先级分 ${item.priorityScore}` +
        (item.decisionReasons?.length ? ` · ${item.decisionReasons.join(', ')}` : '')
      : null;
  const originUrl = item.originUrl ?? item.url;
  const resolvedUrl = item.originUrl && item.originUrl !== item.url ? `来源: ${item.url}` : null;

  const contentLines = isShortOriginTweet(item)
    ? [
        ...formatPreview(item.originText!).map((line) => `      ${line}`),
        ...(item.media.length > 0 ? [`      ${formatMediaPlaceholder(item.media)!}`] : []),
      ]
    : formatPreview(item.summary).map((line) => `      ${line}`);

  return [
    `${String(index + 1).padStart(2, ' ')}. ${item.title}`,
    `      ${metadata}`,
    rankingHint ? `      ${rankingHint}` : null,
    `      原帖: ${originUrl}`,
    resolvedUrl ? `      ${resolvedUrl}` : null,
    ...contentLines,
  ]
    .filter(Boolean)
    .join('\n');
}

export async function select(items: CuratedItem[]): Promise<CuratedItem[]> {
  if (items.length === 0) {
    throw new Error('没有可选的资讯条目');
  }

  console.log(`\n[select] AI 整理出 ${items.length} 条资讯，请选择 6-10 条发布：\n`);

  const selected = await checkbox<CuratedItem>({
    message: '用空格键选中/取消，↑↓ 翻页，回车确认（建议选 6-10 条）：',
    choices: items.map((item, i) => ({
      name: formatSelectionLabel(item, i),
      value: item,
      short: item.title,
    })),
    pageSize: 12,
  });

  if (selected.length === 0) {
    throw new Error('未选择任何条目，已取消发布');
  }

  console.log(`\n[select] 已选择 ${selected.length} 条资讯`);
  return selected;
}
