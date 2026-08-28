import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeRankingArtifact } from '../src/ranking-artifact.js';
import { rankItems } from '../src/rank.js';
import type { RankedItem, RankingArtifact } from '../src/types.js';

const item: RankedItem = {
  id: 'a', source: 'twitter', url: 'https://x.com/a/1', publishedAt: '2026-08-27T00:00:00Z',
  author: { name: 'A', username: 'a' }, text: 'agent release', media: [],
  editorialScore: 50, engagementScore: 0, priorityScore: 38,
  scoreBreakdown: { substance: 10, evidence: 5, sourceSignal: 5, xArticleBonus: 0,
    substackSourceBonus: 0, freshness: 10, novelty: 15, actionability: 5, penalties: 0 },
  decisionReasons: ['新'],
};
const artifact: RankingArtifact = {
  schemaVersion: 1, runId: 'run-a', date: '2026-08-27', curationMode: 'agent-curator',
  featureVersion: 'tag-signal-feedback-v1', collectedAt: 100, policyRevision: 1,
  rankedItems: [item], candidateIds: ['a'],
};

test('ranking decoder accepts canonical artifacts', () => {
  assert.deepEqual(decodeRankingArtifact(artifact), artifact);
});

test('ranking decoder rejects malformed nested score factors', () => {
  const structured = rankItems([{ id: 'structured', source: 'twitter', url: 'https://x.com/a/2',
    publishedAt: '2026-08-27T00:00:00Z', author: { name: 'A', username: 'a' }, text: 'agent tutorial', media: [] }])[0]!;
  const invalid = { ...artifact, rankedItems: [{ ...structured,
    scoreFactors: [{ ...structured.scoreFactors![0], contribution: 999 }] }], candidateIds: ['structured'] };
  assert.throws(() => decodeRankingArtifact(invalid), /contribution/);
});

test('ranking decoder rejects unsupported versions and dangling candidates', () => {
  assert.throws(() => decodeRankingArtifact({ ...artifact, schemaVersion: 2 }), /schemaVersion/);
  assert.throws(() => decodeRankingArtifact({ ...artifact, candidateIds: ['missing'] }), /candidateIds/);
});
