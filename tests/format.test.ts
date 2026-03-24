import test from 'node:test';
import assert from 'node:assert/strict';
import { format } from '../src/format.js';

test('format renders photo media and uses source-aware attribution', () => {
  const result = format([
    {
      id: 'tw-1',
      title: 'Launch',
      summary: 'Summary',
      url: 'https://docs.example.com/launch',
      originUrl: 'https://x.com/alice/status/1',
      author: 'alice',
      attribution: 'OpenAI Docs',
      source: 'twitter',
      category: 'Product',
      media: [
        { type: 'photo', url: 'https://img/1.jpg', width: 1200, height: 675 },
        { type: 'animated_gif', url: 'https://img/2.gif' },
        { type: 'video', url: 'https://video/1.mp4' },
        { type: 'photo', url: 'https://img/3.jpg' },
      ],
    },
    {
      id: 'ss-1',
      title: 'Article',
      summary: 'Article summary',
      url: 'https://example.substack.com/p/article',
      author: 'Ben Thompson',
      attribution: 'Stratechery / Ben Thompson',
      source: 'substack',
      category: 'Opinions/Thoughts',
      media: [{ type: 'photo', url: 'https://img/cover.jpg' }],
    },
  ] as never[]);

  assert.match(result.obsidian, /## Product/);
  assert.match(result.obsidian, /## Opinions\/Thoughts/);
  assert.doesNotMatch(result.obsidian, /<code>|`AI`/);
  assert.match(result.obsidian, /tags: \[daily-news\]/);
  assert.match(result.obsidian, /!\[Launch\]\(https:\/\/img\/1\.jpg\)/);
  assert.match(result.obsidian, /!\[Launch\]\(https:\/\/img\/3\.jpg\)/);
  assert.match(result.obsidian, /来源：\[OpenAI Docs\]\(https:\/\/docs\.example\.com\/launch\)/);
  assert.match(result.obsidian, /来源：\[Stratechery \/ Ben Thompson\]\(https:\/\/example\.substack\.com\/p\/article\)/);
  assert.doesNotMatch(result.obsidian, /x\.com\/alice\/status\/1/);
  assert.doesNotMatch(result.obsidian, /video\/1\.mp4/);
  assert.doesNotMatch(result.obsidian, /img\/2\.gif/);

  assert.match(result.substack, /<h2>Product<\/h2>/);
  assert.match(result.substack, /<h2>Opinions\/Thoughts<\/h2>/);
  assert.doesNotMatch(result.substack, /<code>AI<\/code>/);
  assert.match(result.substack, /<img src="https:\/\/img\/1\.jpg" alt="Launch" \/>/);
  assert.match(result.substack, /<img src="https:\/\/img\/3\.jpg" alt="Launch" \/>/);
  assert.match(result.substack, /<p>来源：<a href="https:\/\/docs\.example\.com\/launch" target="_blank">OpenAI Docs<\/a><\/p>/);
  assert.match(result.substack, /<p>来源：<a href="https:\/\/example\.substack\.com\/p\/article" target="_blank">Stratechery \/ Ben Thompson<\/a><\/p>/);
  assert.doesNotMatch(result.substack, /x\.com\/alice\/status\/1/);
  assert.doesNotMatch(result.substack, /video\/1\.mp4/);
  assert.doesNotMatch(result.substack, /img\/2\.gif/);
});
