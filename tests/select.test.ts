import test from 'node:test';
import assert from 'node:assert/strict';
import { formatSelectionLabel } from '../src/select.js';

test('formatSelectionLabel omits tags and keeps only title plus summary preview', () => {
  const label = formatSelectionLabel(
    {
      title: 'Launch',
      summary: 'A'.repeat(90),
      url: 'https://x.com/alice/status/1',
      author: 'alice',
      attribution: '@alice',
      source: 'twitter',
      category: 'Product',
      media: [],
    },
    0,
  );

  assert.match(label, /^ 1\. Launch\n/);
  assert.doesNotMatch(label, /\[/);
  assert.match(label, /A{70}…/);
});
