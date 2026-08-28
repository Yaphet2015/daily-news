import { decodeContentTagIds, decodeFiniteNumber, decodeNonEmptyString, decodeObject } from './artifact-codec.js';
import type { ConfirmedPreferenceRules } from './preferences.js';
import { RANKING_SIGNAL_IDS, resolveEffectiveScoringPolicy } from './scoring-policy.js';
import type {
  ContentTagId,
  CustomContentTagDefinition,
  FeedbackReview,
  RankingSignalId,
  ScoreFeedbackHistoryEvent,
} from './types.js';

export interface FeedbackAdjustment {
  schemaVersion: 1;
  adjustmentId: string;
  reviewRunId: string;
  basePolicyRevision: number;
  feedbackEventIds: string[];
  outcome: 'applied' | 'no_change';
  attribution: string;
  customTags?: CustomContentTagDefinition[];
  tagWeightOverrides: Partial<Record<ContentTagId, number>>;
  rankingSignalWeightOverrides?: Partial<Record<RankingSignalId, number>>;
}

export type FeedbackApplyResult =
  | { status: 'already-applied'; policyRevision: number }
  | { status: 'no-change-recorded'; policyRevision: number }
  | { status: 'applied'; policyRevision: number };

export function decodeFeedbackAdjustment(value: unknown): FeedbackAdjustment {
  const raw = decodeObject(value, 'feedback adjustment');
  if (raw.schemaVersion !== 1) throw new Error('feedback adjustment schemaVersion is unsupported');
  if (raw.outcome !== 'applied' && raw.outcome !== 'no_change') throw new Error('feedback adjustment outcome is invalid');
  if (!Array.isArray(raw.feedbackEventIds) || raw.feedbackEventIds.length === 0) {
    throw new Error('feedback adjustment needs evidence');
  }
  const tagsRaw = decodeObject(raw.tagWeightOverrides ?? {}, 'feedback adjustment.tagWeightOverrides');
  const tagIds = decodeContentTagIds(Object.keys(tagsRaw), 'feedback adjustment tag ids');
  const tagWeightOverrides = Object.fromEntries(tagIds.map((id) => [id,
    decodeFiniteNumber(tagsRaw[id], `feedback adjustment.tagWeightOverrides.${id}`)]));
  const customTags = Array.isArray(raw.customTags) ? raw.customTags.map((entry, index) => {
    const tag = decodeObject(entry, `feedback adjustment.customTags[${index}]`);
    const id = decodeNonEmptyString(tag.id, `feedback adjustment.customTags[${index}].id`);
    if (!id.startsWith('custom:')) throw new Error('custom Tag id must start with custom:');
    if (!Array.isArray(tag.keywords) || tag.keywords.length === 0) throw new Error('custom Tag needs keywords');
    return { id: id as `custom:${string}`,
      label: decodeNonEmptyString(tag.label, `feedback adjustment.customTags[${index}].label`),
      keywords: tag.keywords.map((keyword, keywordIndex) =>
        decodeNonEmptyString(keyword, `feedback adjustment.customTags[${index}].keywords[${keywordIndex}]`).toLowerCase()) };
  }) : [];
  const signalsRaw = decodeObject(raw.rankingSignalWeightOverrides ?? {}, 'feedback adjustment.rankingSignalWeightOverrides');
  const rankingSignalWeightOverrides = Object.fromEntries(Object.entries(signalsRaw).map(([id, weight]) => {
    if (!RANKING_SIGNAL_IDS.includes(id as RankingSignalId)) throw new Error(`unknown Ranking Signal ${id}`);
    return [id, decodeFiniteNumber(weight, `feedback adjustment.rankingSignalWeightOverrides.${id}`)];
  })) as Partial<Record<RankingSignalId, number>>;
  return {
    schemaVersion: 1,
    adjustmentId: decodeNonEmptyString(raw.adjustmentId, 'adjustmentId'),
    reviewRunId: decodeNonEmptyString(raw.reviewRunId, 'reviewRunId'),
    basePolicyRevision: decodeFiniteNumber(raw.basePolicyRevision, 'basePolicyRevision'),
    feedbackEventIds: raw.feedbackEventIds.map((id, index) => decodeNonEmptyString(id, `feedbackEventIds[${index}]`)),
    outcome: raw.outcome,
    attribution: decodeNonEmptyString(raw.attribution, 'attribution'),
    ...(customTags.length ? { customTags } : {}),
    tagWeightOverrides,
    ...(Object.keys(rankingSignalWeightOverrides).length ? { rankingSignalWeightOverrides } : {}),
  };
}

export async function applyFeedbackAdjustment(
  rawAdjustment: FeedbackAdjustment,
  review: FeedbackReview,
  history: readonly ScoreFeedbackHistoryEvent[],
  currentPolicy: ConfirmedPreferenceRules,
  deps: { writePolicy(policy: ConfirmedPreferenceRules): Promise<void>; now?: () => string },
): Promise<FeedbackApplyResult> {
  const adjustment = decodeFeedbackAdjustment(rawAdjustment);
  const currentRevision = currentPolicy.policyRevision ?? 1;
  if (currentPolicy.appliedAdjustmentIds?.includes(adjustment.adjustmentId)) {
    return { status: 'already-applied', policyRevision: currentRevision };
  }
  if (adjustment.reviewRunId !== review.runId) throw new Error('adjustment reviewRunId mismatch');
  if (adjustment.basePolicyRevision !== currentRevision) throw new Error('base policy revision mismatch');
  const byId = new Map(history.map((event) => [event.feedbackEventId, event]));
  const evidence = adjustment.feedbackEventIds.map((id) => {
    const event = byId.get(id);
    if (!event) throw new Error(`unknown feedback evidence ${id}`);
    return event;
  });
  const tagEntries = Object.entries(adjustment.tagWeightOverrides) as Array<[ContentTagId, number]>;
  const signalEntries = Object.entries(adjustment.rankingSignalWeightOverrides ?? {}) as Array<[RankingSignalId, number]>;
  if (!evidence.some((event) => event.runId === review.runId)) {
    throw new Error('adjustment evidence must include the current review run');
  }
  if (adjustment.outcome === 'no_change' && (tagEntries.length || signalEntries.length || adjustment.customTags?.length)) {
    throw new Error('no_change cannot include changes');
  }
  const effective = resolveEffectiveScoringPolicy(currentPolicy);
  if (evidence.length === 1) {
    if (tagEntries.length > 1) throw new Error('one feedback event may adjust only one Tag');
    if (signalEntries.length) throw new Error('one feedback event cannot adjust a Ranking Signal');
    const event = evidence[0];
    const newCustomTags = new Map((adjustment.customTags ?? []).map((tag) => [tag.id, tag]));
    if (newCustomTags.size > 1) throw new Error('one feedback event may define only one custom Tag');
    for (const [tagId, nextWeight] of tagEntries) {
      const customTag = newCustomTags.get(tagId as `custom:${string}`);
      const customMatches = customTag?.keywords.some((keyword) => event.textPreview.toLowerCase().includes(keyword));
      if (!event.contentTags.includes(tagId) && !customMatches) {
        throw new Error(`Tag ${tagId} was not matched by the feedback item`);
      }
      const previousWeight = effective.weights[tagId] ?? 0;
      if (Math.abs(nextWeight - previousWeight) > 2) throw new Error('single feedback Tag delta exceeds 2');
      if (event.direction === 'too_low' && nextWeight <= previousWeight) throw new Error('too_low requires a higher weight');
      if (event.direction === 'too_high' && nextWeight >= previousWeight) throw new Error('too_high requires a lower weight');
    }
  }
  if (signalEntries.length) {
    const directions = new Set(evidence.map((event) => event.direction));
    const runIds = new Set(evidence.map((event) => event.runId));
    if (evidence.length < 3 || directions.size !== 1 || runIds.size < 2) {
      throw new Error('Ranking Signal adjustment needs 3 same-direction events across 2 runs');
    }
  }
  const evidenceRecord = {
    adjustmentId: adjustment.adjustmentId,
    feedbackEventIds: adjustment.feedbackEventIds,
    attribution: adjustment.attribution,
    outcome: adjustment.outcome,
    recordedAt: deps.now?.() ?? new Date().toISOString(),
  };
  const nextPolicy: ConfirmedPreferenceRules = {
    ...currentPolicy,
    updatedAt: evidenceRecord.recordedAt,
    policyRevision: adjustment.outcome === 'applied' ? currentRevision + 1 : currentRevision,
    tagWeightOverrides: { ...(currentPolicy.tagWeightOverrides ?? {}), ...adjustment.tagWeightOverrides },
    rankingSignalWeightOverrides: {
      ...(currentPolicy.rankingSignalWeightOverrides ?? {}),
      ...(adjustment.rankingSignalWeightOverrides ?? {}),
    },
    appliedAdjustmentIds: [...(currentPolicy.appliedAdjustmentIds ?? []), adjustment.adjustmentId],
    customTags: [...new Map([...(currentPolicy.customTags ?? []), ...(adjustment.customTags ?? [])]
      .map((tag) => [tag.id, tag])).values()],
    adjustmentEvidence: [...(currentPolicy.adjustmentEvidence ?? []), evidenceRecord],
  };
  await deps.writePolicy(nextPolicy);
  return adjustment.outcome === 'no_change'
    ? { status: 'no-change-recorded', policyRevision: currentRevision }
    : { status: 'applied', policyRevision: currentRevision + 1 };
}
