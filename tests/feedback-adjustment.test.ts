import test from 'node:test';
import assert from 'node:assert/strict';
import { applyFeedbackAdjustment, decodeFeedbackAdjustment } from '../src/feedback-adjustment.js';
import { normalizeConfirmedPreferenceRules } from '../src/preferences.js';
import type { ConfirmedPreferenceRules } from '../src/preferences.js';
import type { FeedbackReview, ScoreFeedbackHistoryEvent } from '../src/types.js';

const identity = { schemaVersion: 1 as const, runId: 'run-a', date: '2026-08-27',
  curationMode: 'agent-curator' as const, featureVersion: 'tag-signal-feedback-v1' };
const history: ScoreFeedbackHistoryEvent[] = [{ ...identity, feedbackEventId: 'event-a',
  curationRevision: 'curation-a', selectionDecisionRevision: 2, policyRevision: 1,
  itemId: 'a', direction: 'too_low', updatedAt: '2026-08-27T09:00:00Z', textPreview: 'agent tutorial',
  contentTags: ['topic:agents', 'format:tutorial'],
  tagMatches: [{ tagId: 'topic:agents', matchedBy: ['text:agent'], strength: 1 },
    { tagId: 'format:tutorial', matchedBy: ['text:tutorial'], strength: 1 }],
  rankingSignals: { 'ranking:substance': 10, 'ranking:evidence': 5, 'ranking:freshness': 8,
    'ranking:novelty': 15, 'ranking:actionability': 5, 'ranking:engagement': 0,
    'ranking:source-credibility': 4, 'ranking:x-article': 0, 'ranking:substack-full-post': 0,
    'ranking:penalty': 0 }, scoreFactors: [] }];
const review: FeedbackReview = { ...identity, curationRevision: 'curation-a',
  selectionDecisionRevision: 2, policyRevision: 1, items: [{ id: 'a', feedbackEventId: 'event-a', direction: 'too_low',
    updatedAt: history[0].updatedAt, text: 'agent tutorial', textPreview: 'agent tutorial', contentTags: history[0].contentTags,
    tagMatches: history[0].tagMatches, rankingSignals: history[0].rankingSignals, scoreFactors: [],
    editorialScore: 40, engagementScore: 0, priorityScore: 30, selectedByLlm: true, selectedByHuman: true }] };

test('adjustment decoder rejects unknown Ranking Signal ids', () => {
  assert.throws(() => decodeFeedbackAdjustment({ schemaVersion: 1, adjustmentId: 'bad-signal',
    reviewRunId: 'run-a', basePolicyRevision: 1, feedbackEventIds: ['event-a'], outcome: 'applied',
    attribution: 'invalid', tagWeightOverrides: {}, rankingSignalWeightOverrides: { 'ranking:made-up': 2 } }),
  /unknown Ranking Signal/);
});

test('single feedback can adjust one matched content tag by at most two', async () => {
  let written: ConfirmedPreferenceRules | undefined;
  const current = normalizeConfirmedPreferenceRules(null);
  const result = await applyFeedbackAdjustment({ schemaVersion: 1, adjustmentId: 'adjust-a',
    reviewRunId: 'run-a', basePolicyRevision: 1, feedbackEventIds: ['event-a'], outcome: 'applied',
    attribution: 'Agent tutorial content was underweighted', tagWeightOverrides: { 'topic:agents': 2 } },
    review, history, current, { writePolicy: async (policy) => { written = policy; } });
  assert.equal(result.status, 'applied');
  assert.ok(written);
  assert.equal(written.policyRevision, 2);
  assert.equal(written.tagWeightOverrides?.['topic:agents'], 2);
});

test('single feedback may define one narrower custom content tag', async () => {
  let written: ConfirmedPreferenceRules | undefined;
  await applyFeedbackAdjustment({ schemaVersion: 1, adjustmentId: 'adjust-custom', reviewRunId: 'run-a',
    basePolicyRevision: 1, feedbackEventIds: ['event-a'], outcome: 'applied',
    attribution: 'The memory-layer subset needs a narrower tag',
    customTags: [{ id: 'custom:agent-tutorial', label: 'Agent tutorial', keywords: ['agent tutorial'] }],
    tagWeightOverrides: { 'custom:agent-tutorial': 2 } }, review, history,
    normalizeConfirmedPreferenceRules(null), { writePolicy: async (policy) => { written = policy; } });
  assert.ok(written);
  assert.equal(written.customTags?.[0]?.id, 'custom:agent-tutorial');
  assert.equal(written.tagWeightOverrides?.['custom:agent-tutorial'], 2);
});

test('single feedback cannot spread one direction across multiple tags', async () => {
  await assert.rejects(() => applyFeedbackAdjustment({ schemaVersion: 1, adjustmentId: 'adjust-many',
    reviewRunId: 'run-a', basePolicyRevision: 1, feedbackEventIds: ['event-a'], outcome: 'applied',
    attribution: 'too broad', tagWeightOverrides: { 'topic:agents': 1, 'format:tutorial': 1 } },
    review, history, normalizeConfirmedPreferenceRules(null), { writePolicy: async () => {} }), /one Tag/);
});

test('no_change records evidence without incrementing policy revision', async () => {
  let written: ConfirmedPreferenceRules | undefined;
  const result = await applyFeedbackAdjustment({ schemaVersion: 1, adjustmentId: 'adjust-none',
    reviewRunId: 'run-a', basePolicyRevision: 1, feedbackEventIds: ['event-a'], outcome: 'no_change',
    attribution: 'one sample is ambiguous', tagWeightOverrides: {} }, review, history,
    normalizeConfirmedPreferenceRules(null), { writePolicy: async (policy) => { written = policy; } });
  assert.equal(result.status, 'no-change-recorded');
  assert.ok(written);
  assert.equal(written.policyRevision, 1);
  assert.deepEqual(written.appliedAdjustmentIds, ['adjust-none']);
});
