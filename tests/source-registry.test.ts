import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ENABLED_SOURCES,
  SOURCE_NAMES,
  SOURCE_REGISTRY,
  advancePublishedState,
  normalizeSourceNames,
} from '../src/source-registry.js';

test('source registry is the single ordered source definition', () => {
  assert.deepEqual(SOURCE_NAMES, ['twitter', 'substack', 'aihot']);
  assert.deepEqual(DEFAULT_ENABLED_SOURCES, ['twitter', 'aihot']);
  assert.deepEqual(Object.keys(SOURCE_REGISTRY), SOURCE_NAMES);
  assert.equal(SOURCE_REGISTRY.aihot.displayName, 'AI HOT');
});

test('normalizeSourceNames validates, deduplicates, and preserves order', () => {
  assert.deepEqual(normalizeSourceNames(['aihot', 'twitter', 'aihot']), ['aihot', 'twitter']);
  assert.equal(normalizeSourceNames(['twitter', 'rss']), null);
  assert.equal(normalizeSourceNames('twitter'), null);
});

test('advancePublishedState changes enabled cursors and preserves disabled cursors', () => {
  const state = {
    sources: {
      twitter: { lastPublishedTime: 10 },
      substack: { lastPublishedTime: 20 },
      aihot: { lastPublishedTime: 30 },
    },
  };

  assert.deepEqual(advancePublishedState(state, ['twitter', 'aihot'], 99), {
    sources: {
      twitter: { lastPublishedTime: 99 },
      substack: { lastPublishedTime: 20 },
      aihot: { lastPublishedTime: 99 },
    },
  });
  assert.deepEqual(state.sources.aihot, { lastPublishedTime: 30 });
});
