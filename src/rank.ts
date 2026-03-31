import type { CollectedItem, RankedItem, ScoreBreakdown } from './types.js';
import { AUTHOR_RANKING_RULES, HARD_FILTERED_AUTHOR_USERNAMES } from './ranking-preferences.js';

const SUBSTANCE_KEYWORDS = [
  'release',
  'released',
  'launch',
  'launched',
  'benchmark',
  'benchmarks',
  'pricing',
  'docs',
  'api',
  'guide',
  'tutorial',
  'workflow',
  'migration',
  'research',
  'paper',
  'model',
  'agent',
  'rc',
  'beta',
  'version',
  'dataset',
  'compiler',
  'cache',
];

const ACTIONABILITY_KEYWORDS = ['tutorial', 'guide', 'workflow', 'how to', 'how-to', 'migration'];
const PROMOTIONAL_KEYWORDS = ['hiring', 'join us', 'excited', 'coming soon', 'vibes', 'wow', 'insane'];

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function countKeywordHits(text: string, keywords: string[]): number {
  return keywords.reduce((count, keyword) => count + (text.includes(keyword) ? 1 : 0), 0);
}

function hasExternalLink(text: string): boolean {
  return /https?:\/\/\S+/i.test(text);
}

function normalizeAuthorKey(username?: string): string | undefined {
  if (!username) return undefined;
  return username.trim().replace(/^@+/, '').toLowerCase();
}

function isHardFilteredAuthor(item: CollectedItem): boolean {
  const authorKey = normalizeAuthorKey(item.author.username);
  return authorKey ? HARD_FILTERED_AUTHOR_USERNAMES.includes(authorKey) : false;
}

function getAuthorAdjustment(item: CollectedItem): { penalty: number; bonus: number; reason?: string } {
  const authorKey = normalizeAuthorKey(item.author.username);
  if (!authorKey) return { penalty: 0, bonus: 0 };

  const rule = AUTHOR_RANKING_RULES[authorKey];
  if (!rule) return { penalty: 0, bonus: 0 };

  return { penalty: rule.penalty ?? 0, bonus: rule.bonus ?? 0, reason: rule.reason };
}

function extractAuthorReason(decisionReasons: string[]): string | undefined {
  const wrapped = decisionReasons.find((reason) => reason.startsWith('作者规则:'));
  return wrapped?.slice('作者规则:'.length);
}

function computeFreshnessScore(item: CollectedItem, newestTimestamp: number): number {
  const published = Date.parse(item.publishedAt);
  if (!Number.isFinite(published) || !Number.isFinite(newestTimestamp)) return 0;

  const ageHours = Math.max(0, (newestTimestamp - published) / (1000 * 60 * 60));
  return clamp(Math.round(10 - ageHours / 6), 0, 10);
}

function computeEditorialBreakdown(item: CollectedItem, newestTimestamp: number): ScoreBreakdown {
  const text = normalizeText(item.text);
  const linkedText = normalizeText(
    [item.linkedSource?.title, item.linkedSource?.description, item.linkedSource?.excerpt]
      .filter(Boolean)
      .join(' '),
  );
  const substanceHits = countKeywordHits(text, SUBSTANCE_KEYWORDS);
  const linkedSubstanceHits = countKeywordHits(linkedText, SUBSTANCE_KEYWORDS);
  const actionabilityHits = countKeywordHits(text, ACTIONABILITY_KEYWORDS);
  const promoHits = countKeywordHits(text, PROMOTIONAL_KEYWORDS);
  const hasMedia = item.media.length > 0;
  const hasBrief = Boolean(item.readerBrief);
  const hasLinkedSource = Boolean(item.linkedSource);
  const { penalty: authorPenalty, bonus: authorBonus } = getAuthorAdjustment(item);

  const substance = clamp(
    (text.length >= 80 ? 10 : 4) +
      substanceHits * 4 +
      linkedSubstanceHits * 3 +
      (hasBrief ? 8 : 0),
    0,
    30,
  );
  const evidence = clamp(
    (hasExternalLink(text) ? 10 : 0) +
      (hasLinkedSource ? 8 : 0) +
      (hasMedia ? 8 : 0) +
      (hasBrief ? 6 : 0),
    0,
    20,
  );
  const sourceSignal = clamp(
    (item.source === 'substack' ? 8 : 4) +
      (item.author.username ? 2 : 0) +
      (item.sourceResolution?.decision === 'use_linked_source' ? 3 : 0) +
      authorBonus,
    0,
    15,
  );
  const freshness = computeFreshnessScore(item, newestTimestamp);
  const novelty = 15;
  const actionability = clamp(actionabilityHits * 5, 0, 10);
  const penalties = clamp(-(promoHits * 8) - (text.length < 40 ? 8 : 0) - authorPenalty, -30, 0);

  return {
    substance,
    evidence,
    sourceSignal,
    freshness,
    novelty,
    actionability,
    penalties,
  };
}

function toEditorialScore(breakdown: ScoreBreakdown): number {
  const raw =
    breakdown.substance +
    breakdown.evidence +
    breakdown.sourceSignal +
    breakdown.freshness +
    breakdown.novelty +
    breakdown.actionability +
    breakdown.penalties;

  return clamp(raw, 0, 100);
}

function computeEngagementScore(item: CollectedItem, breakdown: ScoreBreakdown): { score: number; reason?: string } {
  if (item.source !== 'twitter') return { score: 0 };

  const rawEngagement =
    (item.likeCount ?? 0) +
    3 * (item.replyCount ?? 0) +
    2 * (item.repostCount ?? 0) +
    4 * (item.quoteCount ?? 0);

  if (rawEngagement <= 0) return { score: 0 };

  const published = Date.parse(item.publishedAt);
  const newest = Number.isFinite(published) ? published : Date.now();
  const ageHours = Math.max(0, (Date.now() - newest) / (1000 * 60 * 60));
  const velocity = Math.log(1 + rawEngagement) / Math.pow(ageHours + 2, 0.7);
  let score = clamp(Math.round(velocity * 8), 0, 100);

  if (breakdown.substance < 12 || breakdown.evidence < 6) {
    score = Math.min(score, 8);
    return { score, reason: '仅作辅助信号' };
  }

  return { score };
}

function buildDecisionReasons(
  breakdown: ScoreBreakdown,
  engagementReason: string | undefined,
  authorReason: string | undefined,
  duplicateOf?: string,
  isPromotional = false,
): string[] {
  const reasons: string[] = [];

  if (breakdown.substance >= 16) reasons.push('高信息密度');
  if (breakdown.evidence >= 10) reasons.push('有理有据');
  if (breakdown.actionability >= 5) reasons.push('实践教程');
  if (breakdown.freshness >= 8) reasons.push('新');
  if (breakdown.sourceSignal >= 6) reasons.push('官方');
  if (breakdown.substance < 12) reasons.push('低质量内容');
  if (breakdown.evidence < 6) reasons.push('弱证据');
  if (isPromotional) reasons.push('宣发内容');
  if (engagementReason) reasons.push(`互动支持:${engagementReason}`);
  if (authorReason) reasons.push(`作者规则:${authorReason}`);
  if (duplicateOf) reasons.push(`重复内容:${duplicateOf}`);

  return Array.from(new Set(reasons));
}

function applyDuplicatePenalties(items: RankedItem[]): RankedItem[] {
  const byCanonicalUrl = new Map<string, RankedItem[]>();
  for (const item of items) {
    const group = byCanonicalUrl.get(item.url) ?? [];
    group.push(item);
    byCanonicalUrl.set(item.url, group);
  }

  for (const group of byCanonicalUrl.values()) {
    if (group.length < 2) continue;

    const [primary, ...duplicates] = [...group].sort((a, b) => b.priorityScore - a.priorityScore);
    for (const item of duplicates) {
      const authorReason = extractAuthorReason(item.decisionReasons);
      const engagementReason = item.decisionReasons
        .find((reason) => reason.startsWith('互动支持:'))
        ?.slice('互动支持:'.length);
      item.duplicateOf = primary.id;
      item.scoreBreakdown.novelty = 0;
      item.editorialScore = toEditorialScore(item.scoreBreakdown);
      item.priorityScore = clamp(Math.round(item.editorialScore * 0.75 + item.engagementScore * 0.25), 0, 100);
      item.decisionReasons = buildDecisionReasons(
        item.scoreBreakdown,
        engagementReason,
        authorReason,
        primary.id,
      );
    }
  }

  const byFingerprint = new Map<string, RankedItem[]>();

  for (const item of items) {
    const fingerprint = normalizeText(item.text);
    const group = byFingerprint.get(fingerprint) ?? [];
    group.push(item);
    byFingerprint.set(fingerprint, group);
  }

  for (const group of byFingerprint.values()) {
    if (group.length < 2) continue;

    const [primary, ...duplicates] = [...group].sort((a, b) => b.priorityScore - a.priorityScore);
    for (const item of duplicates) {
      const authorReason = extractAuthorReason(item.decisionReasons);
      const engagementReason = item.decisionReasons
        .find((reason) => reason.startsWith('互动支持:'))
        ?.slice('互动支持:'.length);
      const isPromotional = item.decisionReasons.includes('宣发内容');
      item.duplicateOf = primary.id;
      item.scoreBreakdown.novelty = 0;
      item.editorialScore = toEditorialScore(item.scoreBreakdown);
      item.priorityScore = clamp(Math.round(item.editorialScore * 0.75 + item.engagementScore * 0.25), 0, 100);
      item.decisionReasons = buildDecisionReasons(
        item.scoreBreakdown,
        engagementReason,
        authorReason,
        primary.id,
        isPromotional,
      );
    }
  }

  return items.sort((a, b) => b.priorityScore - a.priorityScore);
}

export function rankItems(items: CollectedItem[]): RankedItem[] {
  const eligibleItems = items.filter((item) => !isHardFilteredAuthor(item));
  if (eligibleItems.length === 0) return [];

  const newestTimestamp = eligibleItems.reduce((latest, item) => {
    const published = Date.parse(item.publishedAt);
    return Number.isFinite(published) ? Math.max(latest, published) : latest;
  }, 0);

  const ranked = eligibleItems.map((item) => {
    const normalizedText = normalizeText(item.text);
    const isPromotional = countKeywordHits(normalizedText, PROMOTIONAL_KEYWORDS) > 0;
    const scoreBreakdown = computeEditorialBreakdown(item, newestTimestamp);
    const editorialScore = toEditorialScore(scoreBreakdown);
    const { score: engagementScore, reason: engagementReason } = computeEngagementScore(item, scoreBreakdown);
    const { reason: authorReason } = getAuthorAdjustment(item);
    const priorityScore = clamp(Math.round(editorialScore * 0.75 + engagementScore * 0.25), 0, 100);

    return {
      ...item,
      scoreBreakdown,
      editorialScore,
      engagementScore,
      priorityScore,
      decisionReasons: buildDecisionReasons(scoreBreakdown, engagementReason, authorReason, undefined, isPromotional),
    };
  });

  return applyDuplicatePenalties(ranked);
}

export function getCandidatePoolSize(totalItems: number): number {
  return Math.min(totalItems, 150);
}

export function selectCandidatePool(items: RankedItem[]): RankedItem[] {
  const poolSize = getCandidatePoolSize(items.length);
  return items
    .slice(0, poolSize)
    .map((item) => ({ ...item, enteredCandidatePool: true }));
}
