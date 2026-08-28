import { decodeArtifactIdentity, decodeNonEmptyString, decodeObject } from './artifact-codec.js';
import type {
  CurationArtifact,
  CuratedItem,
  ScoreFeedbackDirection,
  SelectionDecision,
} from './types.js';

function assertIdentity(decision: SelectionDecision, curation: CurationArtifact): void {
  if (decision.runId !== curation.runId || decision.date !== curation.date ||
      decision.curationMode !== curation.curationMode || decision.featureVersion !== curation.featureVersion ||
      decision.curationRevision !== curation.curationRevision) {
    throw new Error('selection decision identity mismatch');
  }
}

export function createPendingSelectionDecision(
  curation: CurationArtifact,
  updatedAt: string,
): SelectionDecision {
  return {
    schemaVersion: 1,
    runId: curation.runId,
    date: curation.date,
    curationMode: curation.curationMode,
    featureVersion: curation.featureVersion,
    curationRevision: curation.curationRevision,
    revision: 0,
    updatedAt,
    selection: { status: 'pending', selectedIds: [] },
    scoreFeedbackById: {},
  };
}

export function decodeSelectionDecision(value: unknown): SelectionDecision {
  const raw = decodeObject(value, 'selection decision');
  const identity = decodeArtifactIdentity(raw, 'selection decision');
  const curationRevision = decodeNonEmptyString(raw.curationRevision, 'selection decision.curationRevision');
  if (!Number.isInteger(raw.revision) || Number(raw.revision) < 0) throw new Error('selection decision.revision is invalid');
  const updatedAt = decodeNonEmptyString(raw.updatedAt, 'selection decision.updatedAt');
  const selection = decodeObject(raw.selection, 'selection decision.selection');
  if (selection.status !== 'pending' && selection.status !== 'confirmed') throw new Error('selection status is invalid');
  if (!Array.isArray(selection.selectedIds) || selection.selectedIds.some((id) => typeof id !== 'string')) {
    throw new Error('selection selectedIds is invalid');
  }
  const feedbackRaw = decodeObject(raw.scoreFeedbackById, 'selection decision.scoreFeedbackById');
  const scoreFeedbackById = Object.fromEntries(Object.entries(feedbackRaw).map(([id, value]) => {
    const entry = decodeObject(value, `selection decision.scoreFeedbackById.${id}`);
    if (entry.direction !== 'too_high' && entry.direction !== 'too_low') throw new Error(`feedback direction is invalid for ${id}`);
    return [id, { direction: entry.direction as ScoreFeedbackDirection,
      updatedAt: decodeNonEmptyString(entry.updatedAt, `selection decision.scoreFeedbackById.${id}.updatedAt`) }];
  }));
  return {
    ...identity,
    curationRevision,
    revision: Number(raw.revision),
    updatedAt,
    selection: {
      status: selection.status,
      selectedIds: [...new Set(selection.selectedIds as string[])],
      ...(selection.confirmedAt ? { confirmedAt: decodeNonEmptyString(selection.confirmedAt, 'selection confirmedAt') } : {}),
    },
    scoreFeedbackById,
  };
}

export function updateScoreFeedback(
  decision: SelectionDecision,
  input: { itemId: string; direction: ScoreFeedbackDirection; updatedAt: string },
  curation: CurationArtifact,
): SelectionDecision {
  assertIdentity(decision, curation);
  if (!curation.curatedItems.some((item) => item.id === input.itemId)) throw new Error(`unknown item ${input.itemId}`);
  const scoreFeedbackById = { ...decision.scoreFeedbackById };
  if (scoreFeedbackById[input.itemId]?.direction === input.direction) delete scoreFeedbackById[input.itemId];
  else scoreFeedbackById[input.itemId] = { direction: input.direction, updatedAt: input.updatedAt };
  return { ...decision, revision: decision.revision + 1, updatedAt: input.updatedAt, scoreFeedbackById };
}

export function confirmSelection(
  decision: SelectionDecision,
  selectedIds: string[],
  curation: CurationArtifact,
  confirmedAt: string,
): SelectionDecision {
  assertIdentity(decision, curation);
  const wanted = new Set(selectedIds);
  if (wanted.size === 0) throw new Error('no items selected');
  for (const id of wanted) {
    if (!curation.curatedItems.some((item) => item.id === id)) throw new Error(`unknown item ${id}`);
  }
  const ordered = curation.curatedItems.filter((item) => wanted.has(item.id)).map((item) => item.id);
  return {
    ...decision,
    revision: decision.revision + 1,
    updatedAt: confirmedAt,
    selection: { status: 'confirmed', selectedIds: ordered, confirmedAt },
  };
}

export function resolveSelectedItems(
  decision: SelectionDecision,
  curation: CurationArtifact,
): CuratedItem[] {
  assertIdentity(decision, curation);
  if (decision.selection.status !== 'confirmed') throw new Error('selection is not confirmed');
  const wanted = new Set(decision.selection.selectedIds);
  const selected = curation.curatedItems.filter((item) => wanted.has(item.id));
  if (selected.length !== wanted.size) throw new Error('selection contains unknown item');
  return selected;
}
