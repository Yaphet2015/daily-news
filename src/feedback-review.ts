import { createHash } from 'node:crypto';
import {
  decodeArtifactIdentity,
  decodeContentTagIds,
  decodeContentTagMatches,
  decodeFiniteNumber,
  decodeNonEmptyString,
  decodeObject,
  decodeRankingSignalMap,
  decodeScoreFactors,
} from './artifact-codec.js';
import type {
  CurationArtifact,
  FeedbackReview,
  FeedbackReviewItem,
  RankingArtifact,
  ScoreFeedbackHistoryEvent,
  SelectionDecision,
} from './types.js';

export interface FeedbackReviewInput {
  ranking: RankingArtifact;
  curation: CurationArtifact;
  decision: SelectionDecision;
}

function assertIdentity(input: FeedbackReviewInput): void {
  for (const artifact of [input.curation, input.decision]) {
    if (artifact.runId !== input.ranking.runId || artifact.date !== input.ranking.date ||
        artifact.curationMode !== input.ranking.curationMode ||
        artifact.featureVersion !== input.ranking.featureVersion) throw new Error('feedback identity mismatch');
  }
  if (input.decision.curationRevision !== input.curation.curationRevision) {
    throw new Error('feedback curation identity mismatch');
  }
}

function decodeRevision(value: unknown, path: string, minimum: number): number {
  const revision = decodeFiniteNumber(value, path);
  if (!Number.isInteger(revision) || revision < minimum) throw new Error(`${path} is invalid`);
  return revision;
}

function decodeLinkedSource(value: unknown, path: string): NonNullable<FeedbackReviewItem['linkedSource']> {
  const source = decodeObject(value, path);
  if (source.via !== 'tweet' && source.via !== 'reply' && source.via !== 'quote') {
    throw new Error(`${path}.via is invalid`);
  }
  const optional = (key: 'title' | 'description' | 'excerpt') =>
    source[key] === undefined ? {} : { [key]: decodeNonEmptyString(source[key], `${path}.${key}`) };
  return {
    url: decodeNonEmptyString(source.url, `${path}.url`),
    domain: decodeNonEmptyString(source.domain, `${path}.domain`),
    via: source.via,
    ...optional('title'),
    ...optional('description'),
    ...optional('excerpt'),
  };
}

export function decodeFeedbackReview(value: unknown): FeedbackReview {
  const raw = decodeObject(value, 'feedback review');
  const identity = decodeArtifactIdentity(raw, 'feedback review');
  if (!Array.isArray(raw.items) || raw.items.length === 0) throw new Error('feedback review.items must not be empty');
  const items = raw.items.map((entry, index): FeedbackReviewItem => {
    const item = decodeObject(entry, `feedback review.items[${index}]`);
    if (item.direction !== 'too_high' && item.direction !== 'too_low') throw new Error(`feedback review.items[${index}].direction is invalid`);
    if (typeof item.selectedByLlm !== 'boolean' || typeof item.selectedByHuman !== 'boolean') {
      throw new Error(`feedback review.items[${index}] selection flags are invalid`);
    }
    return {
      id: decodeNonEmptyString(item.id, `feedback review.items[${index}].id`),
      feedbackEventId: decodeNonEmptyString(item.feedbackEventId, `feedback review.items[${index}].feedbackEventId`),
      direction: item.direction,
      updatedAt: decodeNonEmptyString(item.updatedAt, `feedback review.items[${index}].updatedAt`),
      text: decodeNonEmptyString(item.text, `feedback review.items[${index}].text`),
      textPreview: decodeNonEmptyString(item.textPreview, `feedback review.items[${index}].textPreview`),
      ...(item.linkedSource ? { linkedSource: decodeLinkedSource(item.linkedSource, `feedback review.items[${index}].linkedSource`) } : {}),
      contentTags: decodeContentTagIds(item.contentTags, `feedback review.items[${index}].contentTags`),
      tagMatches: decodeContentTagMatches(item.tagMatches, `feedback review.items[${index}].tagMatches`),
      rankingSignals: decodeRankingSignalMap(item.rankingSignals, `feedback review.items[${index}].rankingSignals`),
      scoreFactors: decodeScoreFactors(item.scoreFactors, `feedback review.items[${index}].scoreFactors`),
      editorialScore: decodeFiniteNumber(item.editorialScore, `feedback review.items[${index}].editorialScore`),
      engagementScore: decodeFiniteNumber(item.engagementScore, `feedback review.items[${index}].engagementScore`),
      priorityScore: decodeFiniteNumber(item.priorityScore, `feedback review.items[${index}].priorityScore`),
      selectedByLlm: item.selectedByLlm,
      selectedByHuman: item.selectedByHuman,
    };
  });
  return {
    ...identity,
    curationRevision: decodeNonEmptyString(raw.curationRevision, 'feedback review.curationRevision'),
    selectionDecisionRevision: decodeRevision(raw.selectionDecisionRevision, 'selectionDecisionRevision', 0),
    policyRevision: decodeRevision(raw.policyRevision, 'policyRevision', 1),
    items,
  };
}

function preview(value: string): string {
  return value.replace(/\s+/g, ' ').trim().slice(0, 240);
}

function eventId(runId: string, itemId: string, direction: string, updatedAt: string): string {
  return createHash('sha256').update(JSON.stringify([runId, itemId, direction, updatedAt])).digest('hex');
}

export function buildFeedbackReview(input: FeedbackReviewInput): FeedbackReview | null {
  const feedbackEntries = Object.entries(input.decision.scoreFeedbackById);
  if (feedbackEntries.length === 0) return null;
  assertIdentity(input);
  const curatedIds = new Set(input.curation.curatedItems.map((item) => item.id));
  const selectedIds = new Set(input.decision.selection.selectedIds);
  const items = feedbackEntries.map(([id, feedback]): FeedbackReviewItem => {
    const item = input.ranking.rankedItems.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`feedback item ${id} is absent from ranking`);
    if (!item.contentTags || !item.tagMatches || !item.rankingSignals || !item.scoreFactors) {
      throw new Error(`feedback item ${id} lacks structured scoring data`);
    }
    return {
      id,
      feedbackEventId: eventId(input.ranking.runId, id, feedback.direction, feedback.updatedAt),
      direction: feedback.direction,
      updatedAt: feedback.updatedAt,
      text: [item.title, item.text, item.body, item.readerBrief?.summary,
        item.linkedSource?.title, item.linkedSource?.description, item.linkedSource?.excerpt]
        .filter(Boolean).join('\n\n'),
      textPreview: preview([item.title, item.text, item.linkedSource?.title,
        item.linkedSource?.description].filter(Boolean).join(' ')),
      ...(item.linkedSource ? { linkedSource: item.linkedSource } : {}),
      contentTags: item.contentTags,
      tagMatches: item.tagMatches,
      rankingSignals: item.rankingSignals,
      scoreFactors: item.scoreFactors,
      editorialScore: item.editorialScore,
      engagementScore: item.engagementScore,
      priorityScore: item.priorityScore,
      selectedByLlm: curatedIds.has(id),
      selectedByHuman: selectedIds.has(id),
    };
  });
  return {
    schemaVersion: 1,
    runId: input.ranking.runId,
    date: input.ranking.date,
    curationMode: input.ranking.curationMode,
    featureVersion: input.ranking.featureVersion,
    curationRevision: input.curation.curationRevision,
    selectionDecisionRevision: input.decision.revision,
    policyRevision: input.ranking.policyRevision,
    items,
  };
}

export function buildScoreFeedbackHistoryEvents(input: FeedbackReviewInput): ScoreFeedbackHistoryEvent[] {
  const review = buildFeedbackReview(input);
  if (!review) return [];
  return review.items.map((item) => ({
    schemaVersion: 1,
    runId: review.runId,
    date: review.date,
    curationMode: review.curationMode,
    featureVersion: review.featureVersion,
    feedbackEventId: item.feedbackEventId,
    curationRevision: review.curationRevision,
    selectionDecisionRevision: review.selectionDecisionRevision,
    policyRevision: review.policyRevision,
    itemId: item.id,
    direction: item.direction,
    updatedAt: item.updatedAt,
    textPreview: item.textPreview,
    contentTags: item.contentTags,
    tagMatches: item.tagMatches,
    rankingSignals: item.rankingSignals,
    scoreFactors: item.scoreFactors,
  }));
}
