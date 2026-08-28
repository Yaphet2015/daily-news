import { appendFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeJsonAtomic } from './artifact-codec.js';
import type {
  CollectedItem,
  ContentTagId,
  CuratedItem,
  CustomContentTagDefinition,
  RankedItem,
  RankingSignalId,
  ScoreFactor,
  SelectionReport,
  SourceName,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT_DIR = join(__dirname, '..');
const DATA_DIR = join(ROOT_DIR, 'data');
const OUTPUT_DIR = join(ROOT_DIR, 'output');

export const DEFAULT_PREFERENCE_HISTORY_PATH = join(DATA_DIR, 'preference-history.jsonl');
export const DEFAULT_PREFERENCE_PROFILE_PATH = join(DATA_DIR, 'preference-profile.json');
export const DEFAULT_PREFERENCE_SUGGESTIONS_PATH = join(DATA_DIR, 'preference-suggestions.json');
export const DEFAULT_PREFERENCE_RULES_PATH = join(DATA_DIR, 'preference-rules.json');

const SCHEMA_VERSION = 1;
const PREVIEW_LIMIT = 240;

export interface PreferenceRule {
  bonus?: number;
  penalty?: number;
  reason: string;
}

export interface ConfirmedPreferenceRules {
  schemaVersion: 1;
  updatedAt: string;
  authorRules: Record<string, PreferenceRule>;
  domainRules: Record<string, PreferenceRule>;
  positiveTopicHints: string[];
  negativeTopicHints: string[];
  policyRevision?: number;
  tagWeightOverrides?: Partial<Record<ContentTagId, number>>;
  rankingSignalWeightOverrides?: Partial<Record<RankingSignalId, number>>;
  appliedAdjustmentIds?: string[];
  customTags?: CustomContentTagDefinition[];
  adjustmentEvidence?: Array<{
    adjustmentId: string;
    feedbackEventIds: string[];
    attribution: string;
    outcome: 'applied' | 'no_change';
    recordedAt: string;
  }>;
}

export interface PreferenceItemSnapshot {
  rankPosition: number;
  id: string;
  source: SourceName;
  twitterFeed?: 'list' | 'for-you';
  kind?: string;
  url: string;
  originUrl?: string;
  domain?: string;
  authorName: string;
  authorUsername?: string;
  title?: string;
  summaryPreview?: string;
  textPreview: string;
  category?: string;
  priorityScore?: number;
  editorialScore?: number;
  engagementScore?: number;
  decisionReasons: string[];
  contentTags?: ContentTagId[];
  scoreFactors?: ScoreFactor[];
  enteredCandidatePool?: boolean;
  selectedByLlm?: boolean;
  selected: boolean;
}

export interface PreferenceHistoryEvent {
  schemaVersion: 1;
  runId: string;
  recordedAt: string;
  date: string;
  reportPath?: string;
  candidateCount: number;
  selectedCount: number;
  items: PreferenceItemSnapshot[];
}

export interface PreferenceAggregateEntry {
  key: string;
  label?: string;
  seen: number;
  selected: number;
  rejected: number;
  selectedRate: number;
}

export interface PreferenceRuleSuggestion {
  key: string;
  label?: string;
  seen: number;
  selected: number;
  rejected: number;
  selectedRate: number;
  bonus: number;
  penalty: number;
  reason: string;
}

export interface PreferenceSuggestions {
  authorRules: PreferenceRuleSuggestion[];
  domainRules: PreferenceRuleSuggestion[];
  positiveTopicHints: string[];
  negativeTopicHints: string[];
}

export interface PreferenceProfile {
  schemaVersion: 1;
  generatedAt: string;
  source: {
    historyEvents: number;
    candidateItems: number;
    selectedItems: number;
    baselineSelectedRate: number;
  };
  aggregates: {
    authors: PreferenceAggregateEntry[];
    domains: PreferenceAggregateEntry[];
    sources: PreferenceAggregateEntry[];
    twitterFeeds: PreferenceAggregateEntry[];
    categories: PreferenceAggregateEntry[];
    decisionReasons: PreferenceAggregateEntry[];
    tags: PreferenceAggregateEntry[];
  };
  suggestions: PreferenceSuggestions;
}

interface BuildEventOptions {
  runId?: string;
  recordedAt?: string;
  reportPath?: string;
}

interface BuildProfileOptions {
  generatedAt?: string;
  minSeen?: number;
}

interface BackfillOptions {
  outputDir?: string;
  historyPath?: string;
}

interface BackfillResult {
  appended: number;
  skippedExisting: number;
  failedReports: Array<{ path: string; error: string }>;
}

interface UpdatePreferenceResult extends BackfillResult {
  profilePath: string;
  suggestionsPath: string;
  profile: PreferenceProfile;
}

function createEmptyRules(updatedAt = ''): ConfirmedPreferenceRules {
  return {
    schemaVersion: 1,
    updatedAt,
    authorRules: {},
    domainRules: {},
    positiveTopicHints: [],
    negativeTopicHints: [],
    policyRevision: 1,
    tagWeightOverrides: {},
    rankingSignalWeightOverrides: {},
    appliedAdjustmentIds: [],
    customTags: [],
    adjustmentEvidence: [],
  };
}

function truncatePreview(value: unknown, limit = PREVIEW_LIMIT): string {
  if (typeof value !== 'string') return '';
  const compact = value.replace(/\s+/g, ' ').trim();
  return compact.length > limit ? compact.slice(0, limit).trimEnd() : compact;
}

function normalizeAuthorKey(username?: string): string | undefined {
  const normalized = username?.trim().replace(/^@+/, '').toLowerCase();
  return normalized || undefined;
}

function normalizeDomain(domain?: string): string | undefined {
  const normalized = domain?.trim().replace(/^\.+/, '').toLowerCase();
  return normalized || undefined;
}

function getDomainFromUrl(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return normalizeDomain(new URL(url).hostname);
  } catch {
    return undefined;
  }
}

function getItemDomain(item: Pick<CollectedItem, 'url' | 'linkedSource'>): string | undefined {
  return normalizeDomain(item.linkedSource?.domain) ?? getDomainFromUrl(item.url);
}

function getCuratedKey(item: Pick<CuratedItem, 'id' | 'url'>): string {
  return `${item.id}\n${item.url}`;
}

function getRankedKey(item: Pick<RankedItem, 'id' | 'url'>): string {
  return `${item.id}\n${item.url}`;
}

function normalizeSelectionReport(candidate: unknown): SelectionReport {
  if (!candidate || typeof candidate !== 'object') {
    throw new Error('selection report must be an object');
  }
  const report = candidate as SelectionReport;
  if (typeof report.date !== 'string') throw new Error('selection report date must be a string');
  if (!Array.isArray(report.rankedItems)) throw new Error('selection report rankedItems must be an array');
  if (!Array.isArray(report.curatedItems)) throw new Error('selection report curatedItems must be an array');
  if (!Array.isArray(report.selectedItems)) throw new Error('selection report selectedItems must be an array');
  return report;
}

export function buildPreferenceEventFromSelectionReport(
  rawReport: SelectionReport,
  options: BuildEventOptions = {},
): PreferenceHistoryEvent {
  const report = normalizeSelectionReport(rawReport);
  const reportPath = options.reportPath ? resolve(options.reportPath) : undefined;
  const runId = options.runId ?? `report:${report.date}:${reportPath ?? 'inline'}`;
  const selectedByKey = new Set(report.selectedItems.map(getCuratedKey));
  const selectedById = new Set(report.selectedItems.map((item) => item.id));
  const curatedByKey = new Map(report.curatedItems.map((item) => [getCuratedKey(item), item]));
  const curatedById = new Map(report.curatedItems.map((item) => [item.id, item]));

  const items = report.rankedItems.map((item, index): PreferenceItemSnapshot => {
    const curated = curatedByKey.get(getRankedKey(item)) ?? curatedById.get(item.id);
    const selected = selectedByKey.has(getRankedKey(item)) || selectedById.has(item.id) || item.selectedByHuman === true;
    return {
      rankPosition: index + 1,
      id: item.id,
      source: item.source,
      ...(item.twitterFeed ? { twitterFeed: item.twitterFeed } : {}),
      ...(item.kind ? { kind: item.kind } : {}),
      url: item.url,
      ...(item.originUrl ? { originUrl: item.originUrl } : {}),
      ...(getItemDomain(item) ? { domain: getItemDomain(item) } : {}),
      authorName: item.author.name,
      ...(item.author.username ? { authorUsername: normalizeAuthorKey(item.author.username) ?? item.author.username } : {}),
      ...(curated?.title ?? item.title ? { title: curated?.title ?? item.title } : {}),
      ...(curated?.summary ? { summaryPreview: truncatePreview(curated.summary) } : {}),
      textPreview: truncatePreview(item.text),
      ...(curated?.category ? { category: curated.category } : {}),
      priorityScore: item.priorityScore,
      editorialScore: item.editorialScore,
      engagementScore: item.engagementScore,
      decisionReasons: item.decisionReasons,
      ...(item.contentTags ? { contentTags: item.contentTags } : {}),
      ...(item.scoreFactors ? { scoreFactors: item.scoreFactors } : {}),
      enteredCandidatePool: item.enteredCandidatePool,
      selectedByLlm: item.selectedByLlm,
      selected,
    };
  });

  return {
    schemaVersion: SCHEMA_VERSION,
    runId,
    recordedAt: options.recordedAt ?? new Date().toISOString(),
    date: report.date,
    ...(reportPath ? { reportPath } : {}),
    candidateCount: items.length,
    selectedCount: report.selectedItems.length,
    items,
  };
}

export async function appendPreferenceHistoryEvent(
  event: PreferenceHistoryEvent,
  historyPath = DEFAULT_PREFERENCE_HISTORY_PATH,
): Promise<void> {
  await mkdir(dirname(historyPath), { recursive: true });
  await appendFile(historyPath, `${JSON.stringify(event)}\n`, 'utf-8');
}

export async function recordPreferenceHistoryFromSelectionReport(
  report: SelectionReport,
  options: BuildEventOptions = {},
  historyPath = DEFAULT_PREFERENCE_HISTORY_PATH,
): Promise<PreferenceHistoryEvent> {
  const event = buildPreferenceEventFromSelectionReport(report, options);
  if (options.runId) {
    const existing = await readPreferenceHistory(historyPath);
    if (existing.some((entry) => entry.runId === event.runId)) return event;
  }
  await appendPreferenceHistoryEvent(event, historyPath);
  return event;
}

export async function readPreferenceHistory(
  historyPath = DEFAULT_PREFERENCE_HISTORY_PATH,
): Promise<PreferenceHistoryEvent[]> {
  if (!existsSync(historyPath)) return [];
  const raw = await readFile(historyPath, 'utf-8');
  return raw
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PreferenceHistoryEvent);
}

export async function backfillPreferenceHistoryFromReports({
  outputDir = OUTPUT_DIR,
  historyPath = DEFAULT_PREFERENCE_HISTORY_PATH,
}: BackfillOptions = {}): Promise<BackfillResult> {
  await mkdir(dirname(historyPath), { recursive: true });
  const existingRunIds = new Set((await readPreferenceHistory(historyPath)).map((event) => event.runId));
  const files = existsSync(outputDir)
    ? (await readdir(outputDir))
        .filter((file) => file.endsWith('-selection-report.json'))
        .sort()
    : [];
  let appended = 0;
  let skippedExisting = 0;
  const failedReports: BackfillResult['failedReports'] = [];

  for (const file of files) {
    const reportPath = join(outputDir, file);
    try {
      const report = normalizeSelectionReport(JSON.parse(await readFile(reportPath, 'utf-8')));
      const event = buildPreferenceEventFromSelectionReport(report, { reportPath });
      if (existingRunIds.has(event.runId)) {
        skippedExisting += 1;
        continue;
      }
      await appendPreferenceHistoryEvent(event, historyPath);
      existingRunIds.add(event.runId);
      appended += 1;
    } catch (error) {
      failedReports.push({ path: reportPath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  return { appended, skippedExisting, failedReports };
}

function getDedupedItems(events: PreferenceHistoryEvent[]): PreferenceItemSnapshot[] {
  const items: PreferenceItemSnapshot[] = [];
  for (const event of events) {
    const byKey = new Map<string, PreferenceItemSnapshot>();
    for (const item of event.items) {
      const key = `${item.id}\n${item.url}\n${item.originUrl ?? ''}`;
      const current = byKey.get(key);
      if (!current || (!current.selected && item.selected)) {
        byKey.set(key, item);
      }
    }
    items.push(...byKey.values());
  }
  return items;
}

function incrementAggregate(
  map: Map<string, PreferenceAggregateEntry>,
  key: string | undefined,
  selected: boolean,
  label?: string,
): void {
  if (!key) return;
  const current = map.get(key) ?? { key, label, seen: 0, selected: 0, rejected: 0, selectedRate: 0 };
  current.seen += 1;
  if (selected) current.selected += 1;
  else current.rejected += 1;
  current.selectedRate = current.selected / current.seen;
  if (label && !current.label) current.label = label;
  map.set(key, current);
}

function sortedAggregate(map: Map<string, PreferenceAggregateEntry>): PreferenceAggregateEntry[] {
  return [...map.values()].sort((a, b) => b.seen - a.seen || b.selected - a.selected || a.key.localeCompare(b.key));
}

function suggestionReason(entry: PreferenceAggregateEntry, direction: 'boost' | 'penalty'): string {
  const rate = Math.round(entry.selectedRate * 100);
  const base = `${entry.selected}/${entry.seen} selected (${rate}%)`;
  return direction === 'boost' ? `historically preferred: ${base}` : `historically rejected: ${base}`;
}

function buildRuleSuggestions(
  entries: PreferenceAggregateEntry[],
  baselineRate: number,
  minSeen: number,
): PreferenceRuleSuggestion[] {
  return entries.flatMap((entry) => {
    if (entry.seen < minSeen) return [];
    const lift = entry.selectedRate - baselineRate;
    if (entry.selected >= 2 && lift >= 0.2) {
      return [
        {
          ...entry,
          bonus: Math.min(8, Math.max(2, Math.round(lift * 12))),
          penalty: 0,
          reason: suggestionReason(entry, 'boost'),
        },
      ];
    }
    if (entry.rejected >= 2 && lift <= -0.15) {
      return [
        {
          ...entry,
          bonus: 0,
          penalty: Math.min(8, Math.max(2, Math.round(Math.abs(lift) * 12))),
          reason: suggestionReason(entry, 'penalty'),
        },
      ];
    }
    return [];
  });
}

function buildTopicHints(
  entries: PreferenceAggregateEntry[],
  baselineRate: number,
  minSeen: number,
  direction: 'positive' | 'negative',
): string[] {
  return entries
    .filter((entry) => {
      if (entry.seen < minSeen) return false;
      if (direction === 'positive') return entry.selected >= 2 && entry.selectedRate - baselineRate >= 0.2;
      return entry.rejected >= 2 && entry.selectedRate - baselineRate <= -0.15;
    })
    .sort((a, b) =>
      direction === 'positive'
        ? b.selected - a.selected || b.selectedRate - a.selectedRate
        : b.rejected - a.rejected || a.selectedRate - b.selectedRate,
    )
    .slice(0, 12)
    .map((entry) => entry.key);
}

export function buildPreferenceProfile(
  events: PreferenceHistoryEvent[],
  options: BuildProfileOptions = {},
): PreferenceProfile {
  const items = getDedupedItems(events);
  const selectedItems = items.filter((item) => item.selected).length;
  const baselineSelectedRate = items.length > 0 ? selectedItems / items.length : 0;
  const minSeen = options.minSeen ?? 3;

  const authors = new Map<string, PreferenceAggregateEntry>();
  const domains = new Map<string, PreferenceAggregateEntry>();
  const sources = new Map<string, PreferenceAggregateEntry>();
  const twitterFeeds = new Map<string, PreferenceAggregateEntry>();
  const categories = new Map<string, PreferenceAggregateEntry>();
  const decisionReasons = new Map<string, PreferenceAggregateEntry>();
  const tags = new Map<string, PreferenceAggregateEntry>();

  for (const item of items) {
    incrementAggregate(authors, item.authorUsername, item.selected, item.authorName);
    incrementAggregate(domains, item.domain, item.selected);
    incrementAggregate(sources, item.source, item.selected);
    incrementAggregate(twitterFeeds, item.twitterFeed, item.selected);
    incrementAggregate(categories, item.category, item.selected);
    for (const reason of item.decisionReasons) incrementAggregate(decisionReasons, reason, item.selected);
    for (const tag of item.contentTags ?? []) incrementAggregate(tags, tag, item.selected);
  }

  const authorEntries = sortedAggregate(authors);
  const domainEntries = sortedAggregate(domains);
  const reasonEntries = sortedAggregate(decisionReasons);

  return {
    schemaVersion: SCHEMA_VERSION,
    generatedAt: options.generatedAt ?? new Date().toISOString(),
    source: {
      historyEvents: events.length,
      candidateItems: items.length,
      selectedItems,
      baselineSelectedRate,
    },
    aggregates: {
      authors: authorEntries,
      domains: domainEntries,
      sources: sortedAggregate(sources),
      twitterFeeds: sortedAggregate(twitterFeeds),
      categories: sortedAggregate(categories),
      decisionReasons: reasonEntries,
      tags: sortedAggregate(tags),
    },
    suggestions: {
      authorRules: buildRuleSuggestions(authorEntries, baselineSelectedRate, minSeen),
      domainRules: buildRuleSuggestions(domainEntries, baselineSelectedRate, minSeen),
      positiveTopicHints: buildTopicHints(reasonEntries, baselineSelectedRate, minSeen, 'positive'),
      negativeTopicHints: buildTopicHints(reasonEntries, baselineSelectedRate, minSeen, 'negative'),
    },
  };
}

export async function writePreferenceProfile(
  profile: PreferenceProfile,
  profilePath = DEFAULT_PREFERENCE_PROFILE_PATH,
  suggestionsPath = DEFAULT_PREFERENCE_SUGGESTIONS_PATH,
): Promise<void> {
  await mkdir(dirname(profilePath), { recursive: true });
  await writeFile(profilePath, JSON.stringify(profile, null, 2), 'utf-8');
  await writeFile(suggestionsPath, JSON.stringify(profile.suggestions, null, 2), 'utf-8');
}

export async function updatePreferenceProfileFromReports({
  outputDir = OUTPUT_DIR,
  historyPath = DEFAULT_PREFERENCE_HISTORY_PATH,
  profilePath = DEFAULT_PREFERENCE_PROFILE_PATH,
  suggestionsPath = DEFAULT_PREFERENCE_SUGGESTIONS_PATH,
}: BackfillOptions & { profilePath?: string; suggestionsPath?: string } = {}): Promise<UpdatePreferenceResult> {
  const backfill = await backfillPreferenceHistoryFromReports({ outputDir, historyPath });
  const profile = buildPreferenceProfile(await readPreferenceHistory(historyPath));
  await writePreferenceProfile(profile, profilePath, suggestionsPath);
  return {
    ...backfill,
    profilePath,
    suggestionsPath,
    profile,
  };
}

function normalizeRule(rule: unknown): PreferenceRule | null {
  if (!rule || typeof rule !== 'object') return null;
  const candidate = rule as PreferenceRule;
  const bonus = typeof candidate.bonus === 'number' && Number.isFinite(candidate.bonus) ? candidate.bonus : undefined;
  const penalty = typeof candidate.penalty === 'number' && Number.isFinite(candidate.penalty) ? candidate.penalty : undefined;
  const reason = typeof candidate.reason === 'string' && candidate.reason.trim() ? candidate.reason.trim() : undefined;
  if (!reason || (bonus == null && penalty == null)) return null;
  return { ...(bonus != null ? { bonus } : {}), ...(penalty != null ? { penalty } : {}), reason };
}

function normalizeRuleRecord(value: unknown): Record<string, PreferenceRule> {
  if (!value || typeof value !== 'object') return {};
  const result: Record<string, PreferenceRule> = {};
  for (const [key, rule] of Object.entries(value)) {
    const normalizedKey = normalizeDomain(key) ?? normalizeAuthorKey(key);
    const normalizedRule = normalizeRule(rule);
    if (normalizedKey && normalizedRule) result[normalizedKey] = normalizedRule;
  }
  return result;
}

function normalizeStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return Array.from(
    new Set(
      value
        .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
        .map((item) => item.trim()),
    ),
  );
}

function normalizeCustomTags(value: unknown): CustomContentTagDefinition[] {
  if (!Array.isArray(value)) return [];
  const result: CustomContentTagDefinition[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') continue;
    const candidate = entry as Partial<CustomContentTagDefinition>;
    if (typeof candidate.id !== 'string' || !candidate.id.startsWith('custom:') ||
        typeof candidate.label !== 'string' || !candidate.label.trim()) continue;
    const keywords = normalizeStringArray(candidate.keywords).map((keyword) => keyword.toLowerCase());
    if (keywords.length === 0) continue;
    result.push({ id: candidate.id as `custom:${string}`, label: candidate.label.trim(), keywords });
  }
  return [...new Map(result.map((tag) => [tag.id, tag])).values()];
}

function normalizeWeightRecord(value: unknown, prefix: string): Record<string, number> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([key, weight]) =>
    key.startsWith(prefix) && typeof weight === 'number' && Number.isFinite(weight)));
}

export function normalizeConfirmedPreferenceRules(value: unknown): ConfirmedPreferenceRules {
  if (!value || typeof value !== 'object') return createEmptyRules();
  const candidate = value as Partial<ConfirmedPreferenceRules>;
  return {
    schemaVersion: SCHEMA_VERSION,
    updatedAt: typeof candidate.updatedAt === 'string' ? candidate.updatedAt : '',
    authorRules: normalizeRuleRecord(candidate.authorRules),
    domainRules: normalizeRuleRecord(candidate.domainRules),
    positiveTopicHints: normalizeStringArray(candidate.positiveTopicHints),
    negativeTopicHints: normalizeStringArray(candidate.negativeTopicHints),
    policyRevision: typeof candidate.policyRevision === 'number' && Number.isInteger(candidate.policyRevision)
      && candidate.policyRevision >= 1 ? candidate.policyRevision : 1,
    tagWeightOverrides: normalizeWeightRecord(candidate.tagWeightOverrides, '') as Partial<Record<ContentTagId, number>>,
    rankingSignalWeightOverrides: normalizeWeightRecord(
      candidate.rankingSignalWeightOverrides,
      'ranking:',
    ) as Partial<Record<RankingSignalId, number>>,
    appliedAdjustmentIds: normalizeStringArray(candidate.appliedAdjustmentIds),
    customTags: normalizeCustomTags(candidate.customTags),
    adjustmentEvidence: Array.isArray(candidate.adjustmentEvidence)
      ? candidate.adjustmentEvidence.filter((entry) => entry && typeof entry === 'object') as ConfirmedPreferenceRules['adjustmentEvidence']
      : [],
  };
}

export function readConfirmedPreferenceRules(rulesPath = DEFAULT_PREFERENCE_RULES_PATH): ConfirmedPreferenceRules {
  if (!existsSync(rulesPath)) return createEmptyRules();
  return normalizeConfirmedPreferenceRules(JSON.parse(readFileSync(rulesPath, 'utf-8')));
}

export async function writeConfirmedPreferenceRules(
  rules: ConfirmedPreferenceRules,
  rulesPath = DEFAULT_PREFERENCE_RULES_PATH,
): Promise<void> {
  await writeJsonAtomic(rulesPath, normalizeConfirmedPreferenceRules(rules));
}

function matchesDomainRule(itemDomain: string | undefined, ruleDomain: string): boolean {
  if (!itemDomain) return false;
  return itemDomain === ruleDomain || itemDomain.endsWith(`.${ruleDomain}`);
}

export function getPreferenceRuleAdjustment(
  item: CollectedItem,
  rules: ConfirmedPreferenceRules = readConfirmedPreferenceRules(),
): { bonus: number; penalty: number; reasons: string[] } {
  let bonus = 0;
  let penalty = 0;
  const reasons: string[] = [];
  const authorKey = normalizeAuthorKey(item.author.username);
  const authorRule = authorKey ? rules.authorRules[authorKey] : undefined;
  if (authorRule) {
    bonus += authorRule.bonus ?? 0;
    penalty += authorRule.penalty ?? 0;
    reasons.push(`偏好作者:${authorRule.reason}`);
  }

  const itemDomain = getItemDomain(item);
  for (const [domain, rule] of Object.entries(rules.domainRules)) {
    if (!matchesDomainRule(itemDomain, domain)) continue;
    bonus += rule.bonus ?? 0;
    penalty += rule.penalty ?? 0;
    reasons.push(`偏好域名:${rule.reason}`);
  }

  return { bonus, penalty, reasons };
}

export function formatPreferenceHintsForPrompt(rules: ConfirmedPreferenceRules): string[] {
  const prefer = [
    ...rules.positiveTopicHints,
    ...Object.entries(rules.authorRules).flatMap(([author, rule]) => (rule.bonus ? [`@${author} (${rule.reason})`] : [])),
    ...Object.entries(rules.domainRules).flatMap(([domain, rule]) => (rule.bonus ? [`${domain} (${rule.reason})`] : [])),
  ];
  const deprioritize = [
    ...rules.negativeTopicHints,
    ...Object.entries(rules.authorRules).flatMap(([author, rule]) => (rule.penalty ? [`@${author} (${rule.reason})`] : [])),
    ...Object.entries(rules.domainRules).flatMap(([domain, rule]) => (rule.penalty ? [`${domain} (${rule.reason})`] : [])),
  ];

  if (prefer.length === 0 && deprioritize.length === 0) return [];

  return [
    'Confirmed reader preference hints. Use these as tie-breakers after AI relevance; do not override clear topical mismatch.',
    prefer.length > 0 ? `Prefer: ${prefer.slice(0, 12).join('; ')}` : null,
    deprioritize.length > 0 ? `Deprioritize: ${deprioritize.slice(0, 12).join('; ')}` : null,
  ].filter((line): line is string => Boolean(line));
}
