import { resolveSelectedItems } from './selection-decision.js';
import type {
  CanonicalSelectionReport,
  CurationArtifact,
  RankingArtifact,
  SelectionDecision,
} from './types.js';

function assertMatchingIdentity(
  ranking: RankingArtifact,
  curation: CurationArtifact,
  decision: SelectionDecision,
): void {
  for (const artifact of [curation, decision]) {
    if (artifact.runId !== ranking.runId || artifact.date !== ranking.date ||
        artifact.curationMode !== ranking.curationMode || artifact.featureVersion !== ranking.featureVersion) {
      throw new Error('selection report identity mismatch');
    }
  }
  if (decision.curationRevision !== curation.curationRevision) {
    throw new Error('selection report curation identity mismatch');
  }
}

export function buildSelectionReport(input: {
  ranking: RankingArtifact;
  curation: CurationArtifact;
  decision: SelectionDecision;
}): CanonicalSelectionReport {
  assertMatchingIdentity(input.ranking, input.curation, input.decision);
  const selectedItems = resolveSelectedItems(input.decision, input.curation);
  const selectedIds = new Set(selectedItems.map((item) => item.id));
  const candidateIds = new Set(input.ranking.candidateIds);
  const curatedIds = new Set(input.curation.curatedItems.map((item) => item.id));
  return {
    schemaVersion: 1,
    runId: input.ranking.runId,
    date: input.ranking.date,
    curationMode: input.ranking.curationMode,
    featureVersion: input.ranking.featureVersion,
    policyRevision: input.ranking.policyRevision,
    curationRevision: input.curation.curationRevision,
    selectionDecisionRevision: input.decision.revision,
    scoreFeedbackById: input.decision.scoreFeedbackById,
    ...(input.curation.collectionWarnings?.length ? { collectionWarnings: input.curation.collectionWarnings } : {}),
    ...(input.curation.curationDiagnostics ? { curationDiagnostics: input.curation.curationDiagnostics } : {}),
    rankedItems: input.ranking.rankedItems.map((item) => ({
      ...item,
      enteredCandidatePool: candidateIds.has(item.id),
      selectedByLlm: curatedIds.has(item.id),
      selectedByHuman: selectedIds.has(item.id),
      ...(input.decision.scoreFeedbackById[item.id]
        ? { scoreFeedback: input.decision.scoreFeedbackById[item.id] }
        : {}),
    })),
    curatedItems: input.curation.curatedItems,
    selectedItems,
  };
}
