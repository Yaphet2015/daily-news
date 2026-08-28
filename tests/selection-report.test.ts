import test from 'node:test';
import assert from 'node:assert/strict';
import { buildSelectionReport } from '../src/selection-report.js';
import type { CurationArtifact, RankingArtifact, SelectionDecision } from '../src/types.js';

const ranked = (id: string) => ({ id, source: 'twitter' as const, url: `https://x.com/a/${id}`,
  publishedAt: '2026-08-27T00:00:00Z', author: { name: 'A', username: 'a' }, text: 'agent', media: [],
  editorialScore: 20, engagementScore: 0, priorityScore: 15,
  scoreBreakdown: { substance: 4, evidence: 0, sourceSignal: 6, xArticleBonus: 0,
    substackSourceBonus: 0, freshness: 10, novelty: 15, actionability: 0, penalties: -15 },
  decisionReasons: [], contentTags: ['topic:agents' as const], tagMatches: [], rankingSignals: undefined,
  scoreFactors: [] });
const curated = (id: string) => ({ id, title: id, summary: id, url: `https://x.com/a/${id}`,
  author: 'A', attribution: '@a', source: 'twitter' as const, category: 'Product' as const, media: [] });
const ranking: RankingArtifact = { schemaVersion: 1, runId: 'run-a', date: '2026-08-27',
  curationMode: 'agent-curator', featureVersion: 'tag-signal-feedback-v1', collectedAt: 100,
  policyRevision: 2, rankedItems: [ranked('a'), ranked('b')], candidateIds: ['a'] };
const curation: CurationArtifact = { schemaVersion: 1, runId: 'run-a', date: '2026-08-27',
  curationMode: 'agent-curator', featureVersion: 'tag-signal-feedback-v1', collectedAt: 100,
  curationRevision: 'curation-a', curatedItems: [curated('a'), curated('b')] };
const decision: SelectionDecision = { schemaVersion: 1, runId: 'run-a', date: '2026-08-27',
  curationMode: 'agent-curator', featureVersion: 'tag-signal-feedback-v1', curationRevision: 'curation-a',
  revision: 3, updatedAt: '2026-08-27T10:00:00Z',
  selection: { status: 'confirmed', selectedIds: ['b'], confirmedAt: '2026-08-27T10:00:00Z' },
  scoreFeedbackById: { a: { direction: 'too_high', updatedAt: '2026-08-27T09:00:00Z' } } };

test('canonical report derives selection and explicit feedback from decision', () => {
  const report = buildSelectionReport({ ranking, curation, decision });
  assert.equal(report.runId, 'run-a');
  assert.equal(report.selectionDecisionRevision, 3);
  assert.deepEqual(report.selectedItems.map((item) => item.id), ['b']);
  assert.equal(report.rankedItems[0].scoreFeedback?.direction, 'too_high');
  assert.equal(report.rankedItems[1].selectedByHuman, true);
});

test('report rejects mixed artifact identities', () => {
  assert.throws(() => buildSelectionReport({ ranking, curation: { ...curation, runId: 'stale' }, decision }), /identity mismatch/);
});
