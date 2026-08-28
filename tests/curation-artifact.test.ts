import test from 'node:test';
import assert from 'node:assert/strict';
import { createCurationArtifact, decodeCurationArtifact } from '../src/curation-artifact.js';
import type { CuratedItem, RankingArtifact } from '../src/types.js';

const curated: CuratedItem = {
  id: 'a', title: 'A', summary: 'S', url: 'https://example.com/a', author: 'A', attribution: '@a',
  source: 'twitter', category: 'Product', media: [],
};
const ranking: RankingArtifact = {
  schemaVersion: 1, runId: 'run-a', date: '2026-08-27', curationMode: 'agent-curator',
  featureVersion: 'tag-signal-feedback-v1', collectedAt: 100, policyRevision: 1,
  rankedItems: [], candidateIds: [],
};

test('curation artifact inherits ranking identity and gets a stable revision', () => {
  const artifact = createCurationArtifact({ ranking, curatedItems: [curated], collectionWarnings: ['warning'] });
  assert.equal(artifact.runId, ranking.runId);
  assert.match(artifact.curationRevision, /^curation-/);
  assert.deepEqual(decodeCurationArtifact(artifact), artifact);
});

test('curation decoder rejects duplicate item ids', () => {
  const artifact = createCurationArtifact({ ranking, curatedItems: [curated] });
  assert.throws(() => decodeCurationArtifact({ ...artifact, curatedItems: [curated, curated] }), /duplicate id/);
});
