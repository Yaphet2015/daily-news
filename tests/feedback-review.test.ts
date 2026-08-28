import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildFeedbackReview, buildScoreFeedbackHistoryEvents } from '../src/feedback-review.js';
import { appendScoreFeedbackHistoryIdempotently, readScoreFeedbackHistory } from '../src/score-feedback-history.js';
import { rankItems } from '../src/rank.js';
import type { CurationArtifact, RankingArtifact, SelectionDecision } from '../src/types.js';

const rankedItem = rankItems([{ id: 'a', source: 'twitter', url: 'https://x.com/a/1',
  publishedAt: '2026-08-27T00:00:00Z', author: { name: 'A', username: 'a' },
  text: 'Agent tutorial with benchmark evidence and API workflow', media: [] }])[0]!;
const ranking: RankingArtifact = { schemaVersion: 1, runId: 'run-a', date: '2026-08-27',
  curationMode: 'agent-curator', featureVersion: 'tag-signal-feedback-v1', collectedAt: 100,
  policyRevision: 2, rankedItems: [rankedItem], candidateIds: ['a'] };
const curation: CurationArtifact = { schemaVersion: 1, runId: 'run-a', date: '2026-08-27',
  curationMode: 'agent-curator', featureVersion: 'tag-signal-feedback-v1', collectedAt: 100,
  curationRevision: 'curation-a', curatedItems: [{ id: 'a', title: 'A', summary: 'S', url: rankedItem.url,
    author: 'A', attribution: '@a', source: 'twitter', category: 'Tutorial', media: [] }] };
const decision: SelectionDecision = { schemaVersion: 1, runId: 'run-a', date: '2026-08-27',
  curationMode: 'agent-curator', featureVersion: 'tag-signal-feedback-v1', curationRevision: 'curation-a',
  revision: 2, updatedAt: '2026-08-27T10:00:00Z',
  selection: { status: 'confirmed', selectedIds: ['a'], confirmedAt: '2026-08-27T10:00:00Z' },
  scoreFeedbackById: { a: { direction: 'too_low', updatedAt: '2026-08-27T09:00:00Z' } } };

test('feedback review contains content attribution evidence', () => {
  const review = buildFeedbackReview({ ranking, curation, decision });
  assert.equal(review?.items[0].direction, 'too_low');
  assert.match((review?.items[0] as { feedbackEventId?: string } | undefined)?.feedbackEventId ?? '', /^[a-f0-9]{64}$/);
  assert.ok(review?.items[0].contentTags.includes('topic:agents'));
  assert.ok(review?.items[0].scoreFactors.length);
  assert.match((review?.items[0] as { text?: string } | undefined)?.text ?? '', /Agent tutorial/);
  assert.equal(buildFeedbackReview({ ranking, curation, decision: { ...decision, scoreFeedbackById: {} } }), null);
});

test('feedback history is strict and idempotent by event id', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'feedback-history-')), 'history.jsonl');
  const events = buildScoreFeedbackHistoryEvents({ ranking, curation, decision });
  assert.equal(await appendScoreFeedbackHistoryIdempotently(events, path), 1);
  assert.equal(await appendScoreFeedbackHistoryIdempotently(events, path), 0);
  assert.equal((await readScoreFeedbackHistory(path)).length, 1);
  assert.equal((await readFile(path, 'utf-8')).trim().split('\n').length, 1);
});
