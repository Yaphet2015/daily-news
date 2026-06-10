import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSelectionLabel } from '../src/select.js';

test('formatSelectionLabel shows ranking metadata before a multi-line summary preview when available', () => {
  const label = formatSelectionLabel(
    {
      id: 'tw-1',
      title: 'Launch',
      summary: 'A'.repeat(180),
      url: 'https://docs.example.com/launch',
      originUrl: 'https://x.com/alice/status/1',
      author: 'Alice',
      attribution: 'OpenAI Docs',
      source: 'twitter',
      category: 'Product',
      media: [],
      priorityScore: 72,
      decisionReasons: ['高信息密度', '有理有据'],
    },
    0,
  );

  assert.match(label, /^ 1\. Launch\n/);
  assert.match(label, /twitter · OpenAI Docs · Alice/);
  assert.match(label, /优先级分 72 · 高信息密度, 有理有据/);
  assert.match(label, /原帖: https:\/\/x.com\/alice\/status\/1/);
  assert.match(label, /来源: https:\/\/docs.example.com\/launch/);
  assert.match(label, /      A{70}\n      A{70}\n      A{40}/);
});

test('formatSelectionLabel preserves paragraph breaks in short origin tweet previews without splitting words', () => {
  const label = formatSelectionLabel(
    {
      id: 'tw-sama',
      title: 'Sam Altman：对 GPT-5.5 市场反馈的感言',
      summary: 'unused summary',
      url: 'https://x.com/sama/status/2048554097985593849',
      originUrl: 'https://x.com/sama/status/2048554097985593849',
      author: 'sama',
      attribution: '@sama',
      source: 'twitter',
      category: 'Opinions/Thoughts',
      media: [],
      priorityScore: 31,
      decisionReasons: ['新', '低质量内容', '弱证据'],
      sourceResolution: { decision: 'keep_origin', reason: 'test' },
      originText:
        'so fun to see the reception to 5.5!\n\nthere is almost nothing that feels more gratifying to me than builders saying they find our tools useful.',
    },
    0,
  );

  assert.match(label, /      so fun to see the reception to 5\.5!\n      \n      there is almost nothing that feels/);
  assert.doesNotMatch(label, /\nthere is almost nothing/);
  assert.doesNotMatch(label, /feel\n      s/);
  assert.doesNotMatch(label, /usefu\n      l/);
});

test('formatSelectionLabel only shows the original-post URL line when url matches originUrl', () => {
  const label = formatSelectionLabel(
    {
      id: 'tw-2',
      title: 'Launch',
      summary: 'Short summary',
      url: 'https://x.com/alice/status/1',
      originUrl: 'https://x.com/alice/status/1',
      author: 'Alice',
      attribution: '@alice',
      source: 'twitter',
      category: 'Product',
      media: [],
    },
    1,
  );

  assert.match(label, /原帖: https:\/\/x.com\/alice\/status\/1/);
  assert.doesNotMatch(label, /来源:/);
});

test('formatSelectionLabel shows both newsletter origin and resolved roundup link for Substack roundup entries', () => {
  const label = formatSelectionLabel(
    {
      id: 'ss-roundup-1',
      title: 'Perplexity 推出 Labs 模式',
      summary: '这是一条较长的中文摘要，用来确认 preview 仍然会正常渲染。',
      url: 'https://example.com/perplexity-labs',
      originUrl: 'https://www.bensbites.com/p/ai-media-goes-mainstream',
      author: "Ben's Bites",
      attribution: 'Perplexity launched Labs',
      source: 'substack',
      category: 'Product',
      media: [],
    },
    2,
  );

  assert.match(label, /^ 3\. Perplexity 推出 Labs 模式\n/);
  assert.match(label, /substack · Perplexity launched Labs · Ben's Bites/);
  assert.match(label, /原帖: https:\/\/www\.bensbites\.com\/p\/ai-media-goes-mainstream/);
  assert.match(label, /来源: https:\/\/example\.com\/perplexity-labs/);
});

test('formatSelectionLabel marks self-thread items and keeps the root X URL as origin', () => {
  const label = formatSelectionLabel(
    {
      id: 'thread-1',
      title: 'Thread title',
      summary: 'Summary for a long thread item.',
      url: 'https://x.com/alice/status/thread-1',
      originUrl: 'https://x.com/alice/status/thread-1',
      author: 'Alice',
      attribution: '@alice',
      source: 'twitter',
      category: 'Product',
      media: [],
      threadPartCount: 20,
    },
    3,
  );

  assert.match(label, /^ 4\. Thread title\n/);
  assert.match(label, /twitter · @alice · Alice · thread · 20 posts/);
  assert.match(label, /原帖: https:\/\/x.com\/alice\/status\/thread-1/);
  assert.doesNotMatch(label, /来源: https:\/\/lessons\.md/);
});
