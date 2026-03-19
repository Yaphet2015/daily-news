import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSelectionLabel } from '../src/select.js';

test('formatSelectionLabel shows ranking metadata before the summary preview when available', () => {
  const label = formatSelectionLabel(
    {
      title: 'Launch',
      summary: 'A'.repeat(90),
      url: 'https://x.com/alice/status/1',
      author: 'Alice',
      attribution: '@alice',
      source: 'twitter',
      category: 'Product',
      media: [],
      priorityScore: 72,
      decisionReasons: ['high_substance', 'strong_evidence'],
    },
    0,
  );

  assert.match(label, /^ 1\. Launch\n/);
  assert.match(label, /twitter · @alice · Alice/);
  assert.match(label, /score 72 · high_substance, strong_evidence/);
  assert.match(label, /A{70}…/);
});
