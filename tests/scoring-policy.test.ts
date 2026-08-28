import test from 'node:test';
import assert from 'node:assert/strict';
import { matchContentTags, resolveEffectiveScoringPolicy, toRankingSignals } from '../src/scoring-policy.js';
import type { CollectedItem, ScoreBreakdown } from '../src/types.js';

const item: CollectedItem = {
  id: 'a', source: 'twitter', url: 'https://x.com/a/1', publishedAt: '2026-08-27T00:00:00Z',
  author: { name: 'Unrelated', username: 'launch' },
  text: 'A practical agent tutorial with benchmark evidence and API workflow', media: [],
};
const breakdown: ScoreBreakdown = {
  substance: 20, evidence: 12, sourceSignal: 4, xArticleBonus: 0, substackSourceBonus: 0,
  freshness: 8, novelty: 15, actionability: 5, penalties: 0,
};

test('content tags are derived from content and signals, not author identity', () => {
  const signals = toRankingSignals(breakdown, 0);
  const tags = matchContentTags(item, signals);
  assert.ok(tags.some((match) => match.tagId === 'topic:agents'));
  assert.ok(tags.some((match) => match.tagId === 'format:tutorial'));
  assert.ok(tags.some((match) => match.tagId === 'quality:evidence-rich'));

  const authorOnly = matchContentTags({ ...item, text: 'hello', author: { name: 'Agent Tutorial', username: 'agent' } },
    toRankingSignals({ ...breakdown, evidence: 0, actionability: 0 }, 0));
  assert.equal(authorOnly.some((match) => match.tagId === 'topic:agents'), false);
});

test('confirmed custom tags refine content attribution with controlled keywords', () => {
  const policy = resolveEffectiveScoringPolicy({ customTags: [{
    id: 'custom:agent-memory', label: 'Agent memory', keywords: ['memory layer'],
  }] });
  const tags = matchContentTags({ ...item, text: 'A new memory layer for assistants' },
    toRankingSignals(breakdown, 0), policy);
  assert.ok(tags.some((match) => match.tagId === 'custom:agent-memory'));
  const authorOnly = matchContentTags({ ...item, text: 'hello', author: { name: 'Memory Layer' } },
    toRankingSignals(breakdown, 0), policy);
  assert.equal(authorOnly.some((match) => match.tagId === 'custom:agent-memory'), false);
});

test('effective policy applies one replacement weight per tag', () => {
  const policy = resolveEffectiveScoringPolicy({ tagWeightOverrides: { 'topic:agents': 2 } });
  assert.equal(policy.weights['topic:agents'], 2);
  assert.equal(policy.weights['ranking:substance'], 1);
});
