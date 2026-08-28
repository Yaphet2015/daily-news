import { existsSync } from 'node:fs';
import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
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
import type { ScoreFeedbackHistoryEvent } from './types.js';

export const DEFAULT_SCORE_FEEDBACK_HISTORY_PATH = join(process.cwd(), 'data', 'score-feedback-history.jsonl');

function decodeRevision(value: unknown, path: string, minimum: number): number {
  const revision = decodeFiniteNumber(value, path);
  if (!Number.isInteger(revision) || revision < minimum) throw new Error(`${path} is invalid`);
  return revision;
}

export function decodeScoreFeedbackHistoryEvent(value: unknown): ScoreFeedbackHistoryEvent {
  const raw = decodeObject(value, 'score feedback history event');
  const identity = decodeArtifactIdentity(raw, 'score feedback history event');
  if (raw.direction !== 'too_high' && raw.direction !== 'too_low') throw new Error('feedback history direction is invalid');
  return {
    ...identity,
    feedbackEventId: decodeNonEmptyString(raw.feedbackEventId, 'feedbackEventId'),
    curationRevision: decodeNonEmptyString(raw.curationRevision, 'curationRevision'),
    selectionDecisionRevision: decodeRevision(raw.selectionDecisionRevision, 'selectionDecisionRevision', 0),
    policyRevision: decodeRevision(raw.policyRevision, 'policyRevision', 1),
    itemId: decodeNonEmptyString(raw.itemId, 'itemId'),
    direction: raw.direction,
    updatedAt: decodeNonEmptyString(raw.updatedAt, 'updatedAt'),
    textPreview: decodeNonEmptyString(raw.textPreview, 'textPreview'),
    contentTags: decodeContentTagIds(raw.contentTags, 'contentTags'),
    tagMatches: decodeContentTagMatches(raw.tagMatches, 'tagMatches'),
    rankingSignals: decodeRankingSignalMap(raw.rankingSignals, 'rankingSignals'),
    scoreFactors: decodeScoreFactors(raw.scoreFactors, 'scoreFactors'),
  };
}

export async function readScoreFeedbackHistory(
  path = DEFAULT_SCORE_FEEDBACK_HISTORY_PATH,
): Promise<ScoreFeedbackHistoryEvent[]> {
  if (!existsSync(path)) return [];
  const lines = (await readFile(path, 'utf-8')).split('\n').map((line) => line.trim()).filter(Boolean);
  return lines.map((line, index) => {
    try { return decodeScoreFeedbackHistoryEvent(JSON.parse(line)); }
    catch (error) { throw new Error(`invalid score feedback history line ${index + 1}: ${error instanceof Error ? error.message : String(error)}`); }
  });
}

export async function appendScoreFeedbackHistoryIdempotently(
  events: readonly ScoreFeedbackHistoryEvent[],
  path = DEFAULT_SCORE_FEEDBACK_HISTORY_PATH,
): Promise<number> {
  const existing = new Set((await readScoreFeedbackHistory(path)).map((event) => event.feedbackEventId));
  const fresh = events.map(decodeScoreFeedbackHistoryEvent).filter((event) => !existing.has(event.feedbackEventId));
  if (fresh.length === 0) return 0;
  await mkdir(dirname(path), { recursive: true });
  await appendFile(path, `${fresh.map((event) => JSON.stringify(event)).join('\n')}\n`, 'utf-8');
  return fresh.length;
}
