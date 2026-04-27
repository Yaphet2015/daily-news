import { checkbox } from '@inquirer/prompts';
import type { CuratedItem, MediaAsset } from './types.js';

const PREVIEW_LINE_LENGTH = 70;
const PREVIEW_MAX_LINES = 3;
const SHORT_TWEET_THRESHOLD = 500;

function formatPreview(summary: string): string[] {
  const paragraphs = summary
    .replace(/\r\n?/g, '\n')
    .trim()
    .split(/\n\s*\n+/)
    .map((paragraph) =>
      paragraph
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    )
    .filter(Boolean);
  const lines: string[] = [];
  let truncated = false;

  for (const paragraph of paragraphs) {
    const paragraphLines = wrapParagraph(paragraph);

    if (lines.length > 0) {
      if (lines.length + 1 >= PREVIEW_MAX_LINES) {
        truncated = true;
        break;
      }
      lines.push('');
    }

    for (const line of paragraphLines) {
      if (lines.length >= PREVIEW_MAX_LINES) {
        truncated = true;
        break;
      }
      lines.push(line);
    }

    if (truncated) break;
  }

  if (truncated) {
    appendEllipsis(lines);
  }

  return lines;
}

function wrapParagraph(paragraph: string): string[] {
  const lines: string[] = [];
  let currentLine = '';

  for (const word of paragraph.split(' ')) {
    if (word.length === 0) continue;

    if (currentLine.length === 0) {
      currentLine = appendWordToEmptyLine(lines, word);
      continue;
    }

    if (currentLine.length + 1 + word.length <= PREVIEW_LINE_LENGTH) {
      currentLine += ` ${word}`;
      continue;
    }

    lines.push(currentLine);
    currentLine = appendWordToEmptyLine(lines, word);
  }

  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

function appendWordToEmptyLine(lines: string[], word: string): string {
  let remaining = word;

  while (remaining.length > PREVIEW_LINE_LENGTH) {
    lines.push(remaining.slice(0, PREVIEW_LINE_LENGTH));
    remaining = remaining.slice(PREVIEW_LINE_LENGTH);
  }

  return remaining;
}

function appendEllipsis(lines: string[]): void {
  for (let index = lines.length - 1; index >= 0; index--) {
    const line = lines[index];
    if (line == null || line.length === 0) continue;

    lines[index] = `${line.slice(0, Math.max(0, PREVIEW_LINE_LENGTH - 1)).trimEnd()}…`;
    return;
  }

  if (lines.length > 0) {
    lines[lines.length - 1] = '…';
  }
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
  const threadMetadata = item.threadPartCount ? ` · thread · ${item.threadPartCount} posts` : '';
  const metadata = `${item.source} · ${item.attribution} · ${item.author}${threadMetadata}`;
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
