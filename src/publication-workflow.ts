import { createRunId } from './artifact-identity.js';
import { buildFeedbackReview, buildScoreFeedbackHistoryEvents } from './feedback-review.js';
import { format } from './format.js';
import { resolveSelectedItems } from './selection-decision.js';
import { buildSelectionReport } from './selection-report.js';
import { advancePublishedState } from './source-registry.js';
import type {
  CanonicalSelectionReport,
  CurationArtifact,
  FeedbackReview,
  FormatResult,
  PendingDraft,
  RankingArtifact,
  RunState,
  ScoreFeedbackHistoryEvent,
  SelectionDecision,
} from './types.js';

export interface FinalizePublicationInput {
  draft: PendingDraft;
  ranking: RankingArtifact;
  curation: CurationArtifact;
  decision: SelectionDecision;
}

export interface FinalizePublicationDeps {
  readState(): Promise<RunState>;
  formatSelection?(items: CanonicalSelectionReport['selectedItems'], date: string): FormatResult;
  writePublicationOutputs(formatted: FormatResult, report: CanonicalSelectionReport): Promise<void>;
  recordSelectionHistory(report: CanonicalSelectionReport): Promise<void>;
  recordScoreFeedbackHistory(events: readonly ScoreFeedbackHistoryEvent[]): Promise<void>;
  writeFeedbackReview(review: FeedbackReview): Promise<void>;
  writeState(state: RunState): Promise<void>;
  clearDraft(): Promise<void>;
}

export interface FinalizePublicationResult {
  report: CanonicalSelectionReport;
  selectedItems: CanonicalSelectionReport['selectedItems'];
  feedbackCount: number;
  review?: FeedbackReview;
}

function assertIdentity(input: FinalizePublicationInput): void {
  const expectedRunId = createRunId({
    collectedAt: input.draft.collectedAt,
    enabledSources: input.draft.enabledSources,
    itemIds: input.draft.items.map((item) => item.id),
  });
  if (input.ranking.runId !== expectedRunId) throw new Error('draft and ranking runId mismatch');
  if (input.ranking.collectedAt !== input.draft.collectedAt ||
      input.curation.collectedAt !== input.draft.collectedAt) throw new Error('artifact collectedAt mismatch');
}

export async function finalizePublication(
  input: FinalizePublicationInput,
  deps: FinalizePublicationDeps,
): Promise<FinalizePublicationResult> {
  assertIdentity(input);
  const selectedItems = resolveSelectedItems(input.decision, input.curation);
  const report = buildSelectionReport(input);
  const reviewInput = { ranking: input.ranking, curation: input.curation, decision: input.decision };
  const review = buildFeedbackReview(reviewInput);
  const feedbackEvents = buildScoreFeedbackHistoryEvents(reviewInput);
  const formatted = (deps.formatSelection ?? format)(selectedItems, input.ranking.date);
  const state = await deps.readState();

  await deps.writePublicationOutputs(formatted, report);
  await deps.recordSelectionHistory(report);
  await deps.recordScoreFeedbackHistory(feedbackEvents);
  if (review) await deps.writeFeedbackReview(review);
  await deps.writeState(advancePublishedState(state, input.draft.enabledSources, input.draft.collectedAt));
  await deps.clearDraft();

  return {
    report,
    selectedItems,
    feedbackCount: feedbackEvents.length,
    ...(review ? { review } : {}),
  };
}
