import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurationRevision, createRunId } from '../src/artifact-identity.js';

test('run identity is stable and changes with collection identity', () => {
  const input = { collectedAt: 100, enabledSources: ['twitter', 'aihot'] as const, itemIds: ['b', 'a'] };
  assert.equal(createRunId(input), createRunId(input));
  assert.notEqual(createRunId(input), createRunId({ ...input, itemIds: ['a', 'b'] }));
  assert.notEqual(createRunId(input), createRunId({ ...input, collectedAt: 101 }));
});

test('curation revision includes ordered ids and canonical urls', () => {
  const input = { schemaVersion: 1, date: '2026-08-27', items: [
    { id: 'a', url: 'https://example.com/a?utm_source=x' },
    { id: 'b', url: 'https://example.com/b' },
  ] };
  assert.equal(createCurationRevision(input), createCurationRevision(input));
  assert.notEqual(createCurationRevision(input), createCurationRevision({ ...input, items: [...input.items].reverse() }));
  assert.equal(createCurationRevision(input), createCurationRevision({ ...input, items: [
    { ...input.items[0], url: 'https://example.com/a' }, input.items[1],
  ] }));
});
