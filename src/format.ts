import type { CuratedItem, FormatResult, NewsCategory } from './types.js';

const CATEGORY_ORDER: NewsCategory[] = ['Product', 'Tutorial', 'Opinions/Thoughts'];

function getDateString(): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getPhotoUrls(item: CuratedItem): string[] {
  return item.media
    .filter((media) => media.type === 'photo')
    .map((media) => media.url);
}

function getAttribution(item: CuratedItem): string {
  return item.attribution;
}

function groupItems(items: CuratedItem[]): Array<{ category: NewsCategory; items: CuratedItem[] }> {
  return CATEGORY_ORDER
    .map((category) => ({
      category,
      items: items.filter((item) => item.category === category),
    }))
    .filter((group) => group.items.length > 0);
}

function formatObsidian(items: CuratedItem[], date: string): string {
  const frontmatter = `---\ndate: ${date}\ntags: [daily-news]\n---\n`;
  const heading = `# AI 日刊 · ${date}\n`;

  const body = groupItems(items)
    .map(({ category, items: groupItems }) => {
      const section = groupItems
        .map((item, index) => {
          const photoLines = getPhotoUrls(item).map((url) => `![${item.title}](${url})`);
          const lines = [
            `### ${index + 1}. ${item.title}`,
            `> ${item.summary}`,
            ...photoLines,
            '',
            `来源：[${getAttribution(item)}](${item.url})`,
          ].filter((line) => line !== undefined);
          return lines.join('\n');
        })
        .join('\n\n---\n\n');

      return `## ${category}\n\n${section}`;
    })
    .join('\n\n');

  return `${frontmatter}\n${heading}\n${body}\n`;
}

function formatSubstack(items: CuratedItem[], date: string): string {
  const header = `<h1>AI 日刊 · ${date}</h1>\n`;

  const body = groupItems(items)
    .map(({ category, items: groupItems }) => {
      const section = groupItems
        .map((item) => {
          const photoHtml = getPhotoUrls(item)
            .map((url) => `<img src="${url}" alt="${item.title}" />`)
            .join('\n');

          return [
            `<h3>${item.title}</h3>`,
            `<p>${item.summary}</p>`,
            photoHtml,
            `<p>来源：<a href="${item.url}" target="_blank">${getAttribution(item)}</a></p>`,
          ]
            .filter(Boolean)
            .join('\n');
        })
        .join('\n<hr />\n\n');

      return `<h2>${category}</h2>\n${section}`;
    })
    .join('\n\n');

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
