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
      decisionReasons: ['high_substance', 'strong_evidence'],
    },
    0,
  );

  assert.match(label, /^ 1\. Launch\n/);
  assert.match(label, /twitter · OpenAI Docs · Alice/);
  assert.match(label, /score 72 · high_substance, strong_evidence/);
  assert.match(label, /      A{70}\n      A{70}\n      A{40}/);
});
