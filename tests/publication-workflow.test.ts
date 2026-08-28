import test from 'node:test';
import assert from 'node:assert/strict';
import { createRunId } from '../src/artifact-identity.js';
import { finalizePublication } from '../src/publication-workflow.js';
import { rankItems } from '../src/rank.js';
import type { CurationArtifact, PendingDraft, RankingArtifact, SelectionDecision } from '../src/types.js';

const collected = { id: 'a', source: 'twitter' as const, url: 'https://x.com/a/1',
  publishedAt: '2026-08-27T00:00:00Z', author: { name: 'A', username: 'a' },
  text: 'Agent tutorial with benchmark evidence', media: [] };
const draft: PendingDraft = { collectedAt: 100, enabledSources: ['twitter'], items: [collected] };
const runId = createRunId({ collectedAt: 100, enabledSources: ['twitter'], itemIds: ['a'] });
const ranking: RankingArtifact = { schemaVersion: 1, runId, date: '1970-01-01', curationMode: 'agent-curator',
  featureVersion: 'tag-signal-feedback-v1', collectedAt: 100, policyRevision: 1,
  rankedItems: rankItems([collected]), candidateIds: ['a'] };
const curation: CurationArtifact = { schemaVersion: 1, runId, date: ranking.date, curationMode: ranking.curationMode,
  featureVersion: ranking.featureVersion, collectedAt: 100, curationRevision: 'curation-a',
  curatedItems: [{ id: 'a', title: 'A', summary: 'S', url: collected.url, author: 'A', attribution: '@a',
    source: 'twitter', category: 'Tutorial', media: [] }] };
const decision: SelectionDecision = { schemaVersion: 1, runId, date: ranking.date, curationMode: ranking.curationMode,
  featureVersion: ranking.featureVersion, curationRevision: 'curation-a', revision: 2,
  updatedAt: '2026-08-27T10:00:00Z', selection: { status: 'confirmed', selectedIds: ['a'],
    confirmedAt: '2026-08-27T10:00:00Z' }, scoreFeedbackById: {
      a: { direction: 'too_low', updatedAt: '2026-08-27T09:00:00Z' },
    } };

function deps(events: string[]) {
  return {
    readState: async () => ({ sources: { twitter: { lastPublishedTime: 0 }, substack: { lastPublishedTime: 2 }, aihot: { lastPublishedTime: 3 } } }),
    writePublicationOutputs: async () => { events.push('outputs'); },
    recordSelectionHistory: async () => { events.push('selection-history'); },
    recordScoreFeedbackHistory: async () => { events.push('feedback-history'); },
    writeFeedbackReview: async () => { events.push('review'); },
    writeState: async () => { events.push('state'); },
    clearDraft: async () => { events.push('clear'); },
  };
}

test('finalization records feedback before state and draft effects', async () => {
  const events: string[] = [];
  const result = await finalizePublication({ draft, ranking, curation, decision }, deps(events));
  assert.equal(result.feedbackCount, 1);
  assert.deepEqual(events, ['outputs', 'selection-history', 'feedback-history', 'review', 'state', 'clear']);
});

test('no-feedback finalization does not write a review', async () => {
  const events: string[] = [];
  const result = await finalizePublication({ draft, ranking, curation,
    decision: { ...decision, scoreFeedbackById: {} } }, deps(events));
  assert.equal(result.feedbackCount, 0);
  assert.deepEqual(events, ['outputs', 'selection-history', 'feedback-history', 'state', 'clear']);
});
