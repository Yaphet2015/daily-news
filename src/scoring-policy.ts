import type {
  CollectedItem,
  ContentTagId,
  ContentTagMatch,
  CustomContentTagDefinition,
  RankingSignalId,
  RankingSignalMap,
  ScoreBreakdown,
  ScoreFactor,
} from './types.js';

export const RANKING_SIGNAL_IDS: readonly RankingSignalId[] = [
  'ranking:substance', 'ranking:evidence', 'ranking:freshness', 'ranking:novelty',
  'ranking:actionability', 'ranking:engagement', 'ranking:source-credibility',
  'ranking:x-article', 'ranking:substack-full-post', 'ranking:penalty',
];

export const BASELINE_TAG_IDS: readonly ContentTagId[] = [
  'topic:agents', 'topic:model-evaluation', 'topic:ai-infra', 'format:launch',
  'format:tutorial', 'format:research', 'quality:evidence-rich', 'quality:vague',
  'utility:actionable', 'pattern:vague-launch',
];

export type ScoringWeightMap = Record<RankingSignalId | ContentTagId, number>;
export interface EffectiveScoringPolicy {
  policyRevision: number;
  weights: ScoringWeightMap;
  customTags: CustomContentTagDefinition[];
}

const BASELINE_WEIGHTS = Object.freeze({
  ...Object.fromEntries(RANKING_SIGNAL_IDS.map((id) => [id, 1])),
  ...Object.fromEntries(BASELINE_TAG_IDS.map((id) => [id, 0])),
}) as ScoringWeightMap;

export function resolveEffectiveScoringPolicy(overlay: {
  policyRevision?: number;
  tagWeightOverrides?: Partial<Record<ContentTagId, number>>;
  rankingSignalWeightOverrides?: Partial<Record<RankingSignalId, number>>;
  customTags?: CustomContentTagDefinition[];
} = {}): EffectiveScoringPolicy {
  return {
    policyRevision: overlay.policyRevision ?? 1,
    weights: {
      ...BASELINE_WEIGHTS,
      ...(overlay.tagWeightOverrides ?? {}),
      ...(overlay.rankingSignalWeightOverrides ?? {}),
    },
    customTags: overlay.customTags ?? [],
  };
}

export function toRankingSignals(breakdown: ScoreBreakdown, engagementScore: number): RankingSignalMap {
  return {
    'ranking:substance': breakdown.substance,
    'ranking:evidence': breakdown.evidence,
    'ranking:freshness': breakdown.freshness,
    'ranking:novelty': breakdown.novelty,
    'ranking:actionability': breakdown.actionability,
    'ranking:engagement': engagementScore,
    'ranking:source-credibility': breakdown.sourceSignal,
    'ranking:x-article': breakdown.xArticleBonus,
    'ranking:substack-full-post': breakdown.substackSourceBonus,
    'ranking:penalty': breakdown.penalties,
  };
}

function searchableText(item: CollectedItem): string {
  return [item.title, item.text, item.linkedSource?.title, item.linkedSource?.description,
    item.linkedSource?.excerpt, item.readerBrief?.summary]
    .filter((value): value is string => typeof value === 'string')
    .join(' ')
    .toLowerCase();
}

function keywordMatch(tagId: ContentTagId, text: string, keywords: string[]): ContentTagMatch | null {
  const hits = keywords.filter((keyword) => text.includes(keyword));
  return hits.length ? { tagId, matchedBy: hits.map((hit) => `text:${hit}`), strength: 1 } : null;
}

export function matchContentTags(
  item: CollectedItem,
  signals: RankingSignalMap,
  policy?: Pick<EffectiveScoringPolicy, 'customTags'>,
): ContentTagMatch[] {
  const text = searchableText(item);
  const matches = [
    keywordMatch('topic:agents', text, ['agent', 'agentic', 'copilot']),
    keywordMatch('topic:model-evaluation', text, ['benchmark', 'evaluation', ' eval ']),
    keywordMatch('topic:ai-infra', text, ['inference', 'gpu', 'training', 'serving']),
    keywordMatch('format:launch', text, ['launch', 'released', 'release']),
    keywordMatch('format:tutorial', text, ['tutorial', 'guide', 'how to', 'workflow']),
    keywordMatch('format:research', text, ['research', 'paper', 'arxiv', 'study']),
    signals['ranking:evidence'] >= 10
      ? { tagId: 'quality:evidence-rich' as const, matchedBy: ['signal:ranking:evidence>=10'], strength: 1 }
      : null,
    signals['ranking:substance'] < 12
      ? { tagId: 'quality:vague' as const, matchedBy: ['signal:ranking:substance<12'], strength: 1 }
      : null,
    signals['ranking:actionability'] >= 5
      ? { tagId: 'utility:actionable' as const, matchedBy: ['signal:ranking:actionability>=5'], strength: 1 }
      : null,
  ].filter((match): match is ContentTagMatch => match !== null);

  for (const definition of policy?.customTags ?? []) {
    const match = keywordMatch(definition.id, text, definition.keywords.map((keyword) => keyword.toLowerCase()));
    if (match) matches.push(match);
  }
  if (matches.some((match) => match.tagId === 'format:launch') &&
      matches.some((match) => match.tagId === 'quality:vague')) {
    matches.push({ tagId: 'pattern:vague-launch', matchedBy: ['tag:format:launch', 'tag:quality:vague'], strength: 1 });
  }
  return matches;
}

export function buildScoreFactors(
  signals: RankingSignalMap,
  tagMatches: readonly ContentTagMatch[],
  policy: EffectiveScoringPolicy,
): ScoreFactor[] {
  const signalFactors = RANKING_SIGNAL_IDS.map((factorId): ScoreFactor => ({
    factorId,
    kind: 'ranking-signal',
    strength: signals[factorId],
    weight: policy.weights[factorId],
    contribution: signals[factorId] * policy.weights[factorId],
    evidence: [`signal:${factorId}`],
    provenance: 'baseline',
  }));
  const tagFactors = tagMatches.map((match): ScoreFactor => {
    const weight = policy.weights[match.tagId] ?? 0;
    return {
      factorId: match.tagId,
      kind: 'tag',
      strength: match.strength,
      weight,
      contribution: match.strength * weight,
      evidence: match.matchedBy,
      provenance: weight === 0 ? 'baseline' : 'confirmed-overlay',
    };
  });
  return [...signalFactors, ...tagFactors];
}
