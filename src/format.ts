import type { CuratedItem, FormatResult } from './types.js';

function getDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function collectAllTags(items: CuratedItem[]): string[] {
  const tagSet = new Set<string>();
  for (const item of items) {
    for (const tag of item.tags) tagSet.add(tag);
  }
  return Array.from(tagSet);
}

function getPhotoUrls(item: CuratedItem): string[] {
  return item.media
    .filter((media) => media.type === 'photo')
    .map((media) => media.url);
}

function getAttribution(item: CuratedItem): string {
  return item.attribution;
}

function formatObsidian(items: CuratedItem[], date: string): string {
  const tags = collectAllTags(items);
  const tagList = ['daily-news', ...tags].join(', ');

  const frontmatter = `---\ndate: ${date}\ntags: [${tagList}]\n---\n`;
  const heading = `# AI 日刊 · ${date}\n`;

  const body = items
    .map((item, index) => {
      const tagsStr = item.tags.length > 0 ? `\`${item.tags.join('` `')}\`` : '';
      const photoLines = getPhotoUrls(item).map((url) => `![${item.title}](${url})`);
      const lines = [
        `## ${index + 1}. ${item.title}`,
        tagsStr ? `${tagsStr}\n` : '',
        `> ${item.summary}`,
        ...photoLines,
        '',
        `来源：[${getAttribution(item)}](${item.url})`,
      ].filter((line) => line !== undefined);
      return lines.join('\n');
    })
    .join('\n\n---\n\n');

  return `${frontmatter}\n${heading}\n${body}\n`;
}

function formatSubstack(items: CuratedItem[], date: string): string {
  const header = `<h1>AI 日刊 · ${date}</h1>\n`;

  const body = items
    .map((item) => {
      const tagsHtml =
        item.tags.length > 0
          ? `<p><small>${item.tags.map((tag) => `<code>${tag}</code>`).join(' ')}</small></p>`
          : '';
      const photoHtml = getPhotoUrls(item)
        .map((url) => `<img src="${url}" alt="${item.title}" />`)
        .join('\n');

      return [
        `<h2>${item.title}</h2>`,
        tagsHtml,
        `<p>${item.summary}</p>`,
        photoHtml,
        `<p>来源：<a href="${item.url}" target="_blank">${getAttribution(item)}</a></p>`,
      ]
        .filter(Boolean)
        .join('\n');
    })
    .join('\n<hr />\n\n');

  return `${header}\n${body}\n`;
}

export function format(items: CuratedItem[]): FormatResult {
  const date = getDateString();
  return {
    date,
    obsidian: formatObsidian(items, date),
    substack: formatSubstack(items, date),
  };
}
