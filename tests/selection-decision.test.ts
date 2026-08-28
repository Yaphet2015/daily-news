import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  confirmSelection,
  createPendingSelectionDecision,
  resolveSelectedItems,
  updateScoreFeedback,
} from '../src/selection-decision.js';
import { SelectionDecisionStore } from '../src/selection-decision-store.js';
import type { CurationArtifact } from '../src/types.js';

const item = (id: string) => ({ id, title: id, summary: id, url: `https://example.com/${id}`,
  author: 'A', attribution: '@a', source: 'twitter' as const, category: 'Product' as const, media: [] });
const curation: CurationArtifact = {
  schemaVersion: 1, runId: 'run-a', date: '2026-08-27', curationMode: 'agent-curator',
  featureVersion: 'tag-signal-feedback-v1', collectedAt: 100, curationRevision: 'curation-a',
  curatedItems: [item('a'), item('b')],
};

test('feedback direction replaces and toggles without changing selection', () => {
  const pending = createPendingSelectionDecision(curation, '2026-08-27T09:00:00Z');
  const low = updateScoreFeedback(pending, { itemId: 'a', direction: 'too_low', updatedAt: '2026-08-27T09:01:00Z' }, curation);
  const high = updateScoreFeedback(low, { itemId: 'a', direction: 'too_high', updatedAt: '2026-08-27T09:02:00Z' }, curation);
  const cleared = updateScoreFeedback(high, { itemId: 'a', direction: 'too_high', updatedAt: '2026-08-27T09:03:00Z' }, curation);
  assert.equal(low.scoreFeedbackById.a.direction, 'too_low');
  assert.equal(high.scoreFeedbackById.a.direction, 'too_high');
  assert.deepEqual(cleared.scoreFeedbackById, {});
  assert.deepEqual(cleared.selection.selectedIds, []);
  assert.equal(cleared.revision, 3);
});

test('confirmed ids resolve in curation order and reject unknown ids', () => {
  const pending = createPendingSelectionDecision(curation, '2026-08-27T09:00:00Z');
  const confirmed = confirmSelection(pending, ['b', 'a'], curation, '2026-08-27T10:00:00Z');
  assert.deepEqual(resolveSelectedItems(confirmed, curation).map((entry) => entry.id), ['a', 'b']);
  assert.throws(() => confirmSelection(pending, ['missing'], curation, '2026-08-27T10:00:00Z'), /unknown item/);
});

test('store serializes concurrent feedback updates', async () => {
  const path = join(await mkdtemp(join(tmpdir(), 'selection-decision-')), 'decision.json');
  const store = new SelectionDecisionStore(path, curation);
  await store.initialize('2026-08-27T09:00:00Z');
  await Promise.all([
    store.update((decision) => updateScoreFeedback(decision, { itemId: 'a', direction: 'too_low', updatedAt: '2026-08-27T09:01:00Z' }, curation)),
    store.update((decision) => updateScoreFeedback(decision, { itemId: 'b', direction: 'too_high', updatedAt: '2026-08-27T09:02:00Z' }, curation)),
  ]);
  const decision = await store.read();
  assert.equal(decision.scoreFeedbackById.a.direction, 'too_low');
  assert.equal(decision.scoreFeedbackById.b.direction, 'too_high');
  assert.equal(decision.revision, 2);
});
