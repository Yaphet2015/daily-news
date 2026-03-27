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
