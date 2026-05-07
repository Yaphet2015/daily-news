import { mkdir, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { CuratedItem, NewsCategory, ReviewPacket, ReviewPacketPaths } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_DIR = join(__dirname, '..', 'output');
const CATEGORY_ORDER: NewsCategory[] = ['Product', 'Tutorial', 'Opinions/Thoughts'];

function groupItems(items: CuratedItem[]): Array<{ category: NewsCategory; items: CuratedItem[] }> {
  return CATEGORY_ORDER
    .map((category) => ({
      category,
      items: items.filter((item) => item.category === category),
    }))
    .filter((group) => group.items.length > 0);
}

function formatOptionalLine(label: string, value: string | number | undefined): string | null {
  return value == null || value === '' ? null : `- ${label}: ${value}`;
}

function formatReviewMarkdown(packet: ReviewPacket): string {
  const header = [
    `# daily-news Review · ${packet.date}`,
    '',
    `Next action: ${packet.nextAction}`,
    '',
    `Collected at: ${new Date(packet.collectedAt * 1000).toISOString()}`,
    `Sources: ${packet.enabledSources.join(', ')}`,
    `Curated items: ${packet.curatedItems.length}`,
  ].join('\n');

  const body = groupItems(packet.curatedItems)
    .map(({ category, items }) => {
      const section = items
        .map((item, index) => {
          const originalUrl = item.originUrl && item.originUrl !== item.url ? item.originUrl : undefined;
          const lines = [
            `### ${index + 1}. ${item.title}`,
            formatOptionalLine('Attribution', item.attribution),
            formatOptionalLine('Source', item.url),
            formatOptionalLine('Original', originalUrl),
            formatOptionalLine('Priority', item.priorityScore),
            formatOptionalLine('Reasons', item.decisionReasons?.join(', ')),
            formatOptionalLine('Editorial reason', item.editorialReason),
            '',
            item.summary,
          ].filter((line): line is string => line != null);

          return lines.join('\n');
        })
        .join('\n\n');

      return `## ${category}\n\n${section}`;
    })
    .join('\n\n');

  return `${header}\n\n${body}\n`;
}

export async function writeReviewPacket(
  packet: ReviewPacket,
  outputDir = OUTPUT_DIR,
): Promise<ReviewPacketPaths> {
  await mkdir(outputDir, { recursive: true });
  const jsonPath = join(outputDir, `${packet.date}-review.json`);
  const markdownPath = join(outputDir, `${packet.date}-review.md`);

  await writeFile(jsonPath, JSON.stringify(packet, null, 2), 'utf-8');
  await writeFile(markdownPath, formatReviewMarkdown(packet), 'utf-8');

  return { jsonPath, markdownPath };
}
