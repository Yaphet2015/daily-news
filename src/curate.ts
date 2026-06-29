import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type {
  CollectedItem,
  CuratedItem,
  CurateResult,
  CurationDiagnostics,
  CurationRejectionReason,
  CurationUrlCorrectionReason,
  MediaAsset,
  NewsCategory,
  RankedItem,
  ReaderBrief,
} from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'curator.md');
const DEFAULT_READER_MODEL = 'deepseek-v4-flash';
const FORCED_ROUNDUP_MODEL = 'deepseek-v4-flash';
const REJECTION_SAMPLE_LIMIT = 10;
const TRACKING_QUERY_PARAMS = new Set(['ref', 'ref_code', 'gclid', 'fbclid', 'mc_cid', 'mc_eid']);

interface LlmCuratedItem {
  id: string;
  title: string;
  summary: string;
  url: string;
  author: string;
  category: NewsCategory;
  editorialReason: string;
}

interface CurateResponse {
  items: LlmCuratedItem[];
}

type ReaderFn = (item: CollectedItem) => Promise<ReaderBrief>;
type ForcedRoundupGenerator = (items: CollectedItem[]) => Promise<CurateResponse>;
type LlmCallLabel = 'reader_brief' | 'main_curate' | 'forced_roundup';
type LlmJsonErrorCode = 'empty_response' | 'invalid_json' | 'invalid_schema';

interface LlmUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

interface LlmJsonResponse {
  callLabel: LlmCallLabel;
  model: string;
  rawText: string;
  finishReason: string | null;
  usage: LlmUsage | null;
}

interface JsonCallRequest {
  systemPrompt: string;
  userContent: string;
  model: string;
  callLabel: LlmCallLabel;
}

export interface LlmJsonCallOptions {
  model?: string;
  jsonCaller?: (request: JsonCallRequest) => Promise<LlmJsonResponse>;
  warn?: (message: string) => void;
}

const VALID_CATEGORIES: NewsCategory[] = ['Product', 'Tutorial', 'Opinions/Thoughts'];
const CURATED_ITEM_SOFT_FLOOR = 40;
const JSON_RETRY_LIMIT = 2;
const RESPONSE_PREVIEW_LIMIT = 160;

class LlmJsonError extends Error {
  constructor(
    readonly code: LlmJsonErrorCode,
    readonly response: LlmJsonResponse,
    detail: string,
  ) {
    super(formatLlmJsonErrorMessage(code, response, detail));
    this.name = 'LlmJsonError';
  }
}

function isRankedItem(item: CollectedItem): item is RankedItem {
  return (
    'priorityScore' in item &&
    typeof item.priorityScore === 'number' &&
    'editorialScore' in item &&
    typeof item.editorialScore === 'number' &&
    'engagementScore' in item &&
    typeof item.engagementScore === 'number' &&
    'decisionReasons' in item &&
    Array.isArray(item.decisionReasons)
  );
}

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
}

function parseJson<T>(raw: string): T {
  return JSON.parse(stripJsonFences(raw)) as T;
}

function summarizeUsage(usage: LlmUsage | null): string {
  if (!usage) return 'unknown';

  const prompt = usage.promptTokens ?? '?';
  const completion = usage.completionTokens ?? '?';
  const total = usage.totalTokens ?? '?';
  return `prompt=${prompt}, completion=${completion}, total=${total}`;
}

function toPreview(value: string, mode: 'head' | 'tail'): string {
  const compact = value.replace(/\s+/g, ' ').trim();
  if (compact.length <= RESPONSE_PREVIEW_LIMIT) return compact;
  return mode === 'head'
    ? `${compact.slice(0, RESPONSE_PREVIEW_LIMIT)}...`
    : `...${compact.slice(-RESPONSE_PREVIEW_LIMIT)}`;
}

function formatLlmJsonErrorMessage(code: LlmJsonErrorCode, response: LlmJsonResponse, detail: string): string {
  return [
    `[curate][${response.callLabel}] ${detail}`,
    `model=${response.model}`,
    `finishReason=${response.finishReason ?? 'unknown'}`,
    `usage=${summarizeUsage(response.usage)}`,
    `rawTextLength=${response.rawText.length}`,
    `headPreview="${toPreview(response.rawText, 'head')}"`,
    `tailPreview="${toPreview(response.rawText, 'tail')}"`,
    `code=${code}`,
  ].join(', ');
}

function summarizeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
}

function normalizeOptionalStringArray(value: unknown): string[] | null {
  if (value == null) return [];
  return validateStringArray(value);
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

const SUBSTACK_TEASER_BODY_MAX_CHARS = 600;
const SUBSTACK_TEASER_PATTERNS = [
  /\bread more\b/i,
  /\bsubscriber-only\b/i,
  /\bmembers-only\b/i,
  /\bpaid subscribers?\b/i,
  /\bsubscribe to (?:continue|read)\b/i,
  /\bupgrade to paid\b/i,
  /\bsign in to read\b/i,
  /\bcontinue reading\b/i,
];

function isSubstackTeaserOnly(item: CollectedItem): boolean {
  if (item.source !== 'substack' || item.kind === 'substack_roundup_entry') return false;

  const body = normalizeWhitespace([item.body, item.text].filter(Boolean).join(' '));
  return body.length > 0 &&
    body.length <= SUBSTACK_TEASER_BODY_MAX_CHARS &&
    SUBSTACK_TEASER_PATTERNS.some((pattern) => pattern.test(body));
}

function formatMediaForPrompt(media: MediaAsset[]): string {
  if (media.length === 0) return 'Media: none';

  const lines = media.map((item) => {
    const size =
      typeof item.width === 'number' && typeof item.height === 'number'
        ? `${item.width}x${item.height}`
        : 'unknown';
    return `- ${item.type} ${size} ${item.url}`;
  });

  return ['Media:', ...lines].join('\n');
}

function getAttribution(item: CollectedItem): string {
  if (item.sourceLabel) return item.sourceLabel;
  if (item.source === 'substack') {
    const publicationName = item.publication?.name;
    if (!publicationName) return item.author.name;
    if (item.author.name === publicationName) return publicationName;
    return `${publicationName} / ${item.author.name}`;
  }

  return `@${item.author.username ?? item.author.name}`;
}

function normalizeUrl(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, '');
  try {
    const url = new URL(trimmed);
    url.protocol = url.protocol.toLowerCase();
    url.hostname = url.hostname.toLowerCase();
    url.hash = '';
    return url.toString().replace(/\/+$/, '');
  } catch {
    return trimmed;
  }
}

function normalizeUrlWithoutTracking(value: string): string {
  const normalized = normalizeUrl(value);
  try {
    const url = new URL(normalized);
    for (const key of Array.from(url.searchParams.keys())) {
      const normalizedKey = key.toLowerCase();
      if (normalizedKey.startsWith('utm_') || TRACKING_QUERY_PARAMS.has(normalizedKey)) {
        url.searchParams.delete(key);
      }
    }
    url.searchParams.sort();
    return url.toString().replace(/\/+$/, '');
  } catch {
    return normalized;
  }
}

function createEmptyCurationDiagnostics(inputCount: number): CurationDiagnostics {
  return {
    inputCount,
    outputCount: 0,
    rejectedCount: 0,
    rejectionCounts: {
      unknown_id: 0,
      url_mismatch: 0,
      duplicate_id: 0,
      duplicate_url: 0,
    },
    rejectionSamples: [],
    urlCorrections: [],
  };
}

function recordCurationRejection(
  diagnostics: CurationDiagnostics,
  reason: CurationRejectionReason,
  item: Pick<LlmCuratedItem, 'id' | 'title' | 'url'>,
  sourceItem?: CollectedItem,
): void {
  diagnostics.rejectedCount += 1;
  diagnostics.rejectionCounts[reason] += 1;

  if (diagnostics.rejectionSamples.length >= REJECTION_SAMPLE_LIMIT) return;
  const sample = {
    reason,
    id: item.id,
    title: item.title,
    modelUrl: item.url,
  };
  diagnostics.rejectionSamples.push({
    ...sample,
    ...(sourceItem?.url ? { sourceUrl: sourceItem.url } : {}),
    ...(sourceItem?.originUrl ? { originUrl: sourceItem.originUrl } : {}),
  });
}

function recordUrlCorrection(
  diagnostics: CurationDiagnostics,
  item: LlmCuratedItem,
  sourceItem: CollectedItem,
  reason: CurationUrlCorrectionReason,
): void {
  diagnostics.urlCorrections.push({
    id: item.id,
    fromUrl: item.url,
    toUrl: sourceItem.url,
    reason,
  });
}

export function formatCurationDiagnosticsSummary(diagnostics: CurationDiagnostics): string {
  const rejectionSummary = formatNonZeroRejectionCounts(diagnostics) || 'none';
  const recoveredCount = diagnostics.urlCorrections.filter((correction) =>
    correction.reason === 'recovered_primary_url' || correction.reason === 'recovered_origin_url'
  ).length;
  const sampleSummary = diagnostics.rejectionSamples.length > 0
    ? diagnostics.rejectionSamples
        .slice(0, 3)
        .map((sample) =>
          [
            `${sample.reason}:${sample.id}`,
            sample.title ? `title=${sample.title}` : null,
            sample.modelUrl ? `url=${sample.modelUrl}` : null,
          ]
            .filter(Boolean)
            .join(' '),
        )
        .join(' | ')
    : 'none';

  return [
    `input=${diagnostics.inputCount}`,
    `output=${diagnostics.outputCount}`,
    `rejected=${diagnostics.rejectedCount}`,
    `rejection_counts=${rejectionSummary}`,
    `corrected_urls=${diagnostics.urlCorrections.length}`,
    `recovered_by_url=${recoveredCount}`,
    `samples=${sampleSummary}`,
  ].join(', ');
}

function getSafeUrlCorrectionReason(
  modelUrl: string,
  sourceItem: CollectedItem,
): CurationUrlCorrectionReason | null {
  const normalizedModelUrl = normalizeUrl(modelUrl);
  const normalizedSourceUrl = normalizeUrl(sourceItem.url);
  if (normalizedModelUrl === normalizedSourceUrl) return null;

  if (sourceItem.originUrl && normalizedModelUrl === normalizeUrl(sourceItem.originUrl)) {
    return 'origin_url';
  }

  if (normalizeUrlWithoutTracking(modelUrl) === normalizeUrlWithoutTracking(sourceItem.url)) {
    return 'tracking_params';
  }

  return null;
}

function hasHigherPriority(candidate: CuratedItem, current: CuratedItem): boolean {
  return (candidate.priorityScore ?? Number.NEGATIVE_INFINITY) > (current.priorityScore ?? Number.NEGATIVE_INFINITY);
}

function formatReaderBrief(brief: ReaderBrief): string {
  const formatList = (label: string, values: string[]) =>
    values.length > 0 ? `${label}:\n${values.map((value) => `- ${value}`).join('\n')}` : `${label}: none`;

  return [
    `Reader Summary: ${brief.summary}`,
    formatList('Key Points', brief.keyPoints),
    formatList('Claims', brief.claims),
    `Why It Matters: ${brief.whyItMatters || 'none'}`,
    formatList('Signals', brief.signals),
    formatList('Caveats', brief.caveats),
  ].join('\n');
}

function isSubstackRoundupEntry(item: CollectedItem): boolean {
  return item.source === 'substack' && item.kind === 'substack_roundup_entry';
}

function normalizeLlmUsage(raw: unknown): LlmUsage | null {
  if (!raw || typeof raw !== 'object') return null;

  const usage = raw as Record<string, unknown>;
  const promptTokens = typeof usage.promptTokens === 'number'
    ? usage.promptTokens
    : typeof usage.prompt_tokens === 'number'
      ? usage.prompt_tokens
      : undefined;
  const completionTokens = typeof usage.completionTokens === 'number'
    ? usage.completionTokens
    : typeof usage.completion_tokens === 'number'
      ? usage.completion_tokens
      : undefined;
  const totalTokens = typeof usage.totalTokens === 'number'
    ? usage.totalTokens
    : typeof usage.total_tokens === 'number'
      ? usage.total_tokens
      : undefined;

  if (
    typeof promptTokens !== 'number' &&
    typeof completionTokens !== 'number' &&
    typeof totalTokens !== 'number'
  ) {
    return null;
  }

  return { promptTokens, completionTokens, totalTokens };
}

function extractOpenAiMessageContent(content: unknown): string {
  if (typeof content === 'string') return content;

  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!part || typeof part !== 'object') return '';
        const text = (part as Record<string, unknown>).text;
        return typeof text === 'string' ? text : '';
      })
      .join('\n');
  }

  return '';
}

async function generateJsonResponse({
  systemPrompt,
  userContent,
  model,
  callLabel,
}: JsonCallRequest): Promise<LlmJsonResponse> {
  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasAiSdk = Boolean(process.env.AI_BASE_URL && process.env.AI_API_KEY);

  if (hasOpenAI) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY! });
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
    });

    return {
      callLabel,
      model,
      rawText: extractOpenAiMessageContent(response.choices[0]?.message?.content ?? ''),
      finishReason: response.choices[0]?.finish_reason ?? null,
      usage: normalizeLlmUsage(response.usage),
    };
  }

  if (hasAiSdk) {
    const openai = createOpenAI({
      baseURL: process.env.AI_BASE_URL!,
      apiKey: process.env.AI_API_KEY!,
    });

    const result = await generateText({
      model: openai(model),
      system: systemPrompt,
      prompt: userContent,
    });

    return {
      callLabel,
      model,
      rawText: result.text,
      finishReason: result.finishReason ?? null,
      usage: normalizeLlmUsage(result.usage),
    };
  }

  throw new Error('AI 配置缺失：请在 .env 中设置 OPENAI_API_KEY，或同时设置 AI_BASE_URL 和 AI_API_KEY');
}

function parseStructuredJson<T>(response: LlmJsonResponse): T {
  const cleaned = stripJsonFences(response.rawText);
  if (cleaned.length === 0) {
    throw new LlmJsonError('empty_response', response, 'AI 响应为空，无法解析 JSON');
  }

  try {
    return JSON.parse(cleaned) as T;
  } catch (error) {
    throw new LlmJsonError('invalid_json', response, `AI 响应不是有效 JSON: ${summarizeError(error)}`);
  }
}

function getCurateItemSchemaError(item: unknown): string | null {
  if (!item || typeof item !== 'object') return 'AI 响应包含非对象条目';

  const candidate = item as Record<string, unknown>;
  if (typeof candidate.id !== 'string' || candidate.id.length === 0) return 'AI 响应包含无效 id';
  if (typeof candidate.title !== 'string' || candidate.title.length === 0) return 'AI 响应包含无效标题';
  if (typeof candidate.summary !== 'string' || candidate.summary.length === 0) return 'AI 响应包含无效摘要';
  if (typeof candidate.url !== 'string' || candidate.url.length === 0) return 'AI 响应包含无效 URL';
  if (typeof candidate.author !== 'string' || candidate.author.length === 0) return 'AI 响应包含无效作者';
  if (!VALID_CATEGORIES.includes(candidate.category as NewsCategory)) {
    return `AI 响应包含无效分类: ${String(candidate.category)}`;
  }
  if (typeof candidate.editorialReason !== 'string' || candidate.editorialReason.length === 0) {
    return 'AI 响应包含无效 editorialReason';
  }

  return null;
}

function validateCurateItems(items: unknown, response: LlmJsonResponse | null): LlmCuratedItem[] {
  if (!Array.isArray(items)) {
    if (response) throw new LlmJsonError('invalid_schema', response, 'AI 响应缺少顶层 items 数组');
    throw new Error('AI 响应缺少 items 字段');
  }

  return items.map((item) => {
    const schemaError = getCurateItemSchemaError(item);
    if (schemaError) {
      if (response) {
        throw new LlmJsonError('invalid_schema', response, schemaError);
      }
      throw new Error(schemaError);
    }

    return item as LlmCuratedItem;
  });
}

function filterValidCurateItems(items: unknown): { items: LlmCuratedItem[]; rejectedCount: number } {
  if (!Array.isArray(items)) return { items: [], rejectedCount: 0 };

  const validItems: LlmCuratedItem[] = [];
  let rejectedCount = 0;
  for (const item of items) {
    if (getCurateItemSchemaError(item)) {
      rejectedCount += 1;
    } else {
      validItems.push(item as LlmCuratedItem);
    }
  }

  return { items: validItems, rejectedCount };
}

function parseCurateResponse(raw: string | LlmJsonResponse): LlmCuratedItem[] {
  if (typeof raw === 'string') {
    const parsed = parseJson<CurateResponse>(raw);
    return validateCurateItems(parsed.items, null);
  }

  const parsed = parseStructuredJson<Record<string, unknown>>(raw);
  return validateCurateItems(parsed.items, raw);
}

function parseMainCurateResponse(raw: LlmJsonResponse): { items: LlmCuratedItem[]; rejectedCount: number } {
  const parsed = parseStructuredJson<Record<string, unknown>>(raw);
  if (!Array.isArray(parsed.items)) {
    throw new LlmJsonError('invalid_schema', raw, 'AI 响应缺少顶层 items 数组');
  }

  const result = filterValidCurateItems(parsed.items);
  if (result.items.length === 0 && result.rejectedCount > 0) {
    throw new LlmJsonError('invalid_schema', raw, 'AI 响应没有任何 schema 有效条目');
  }

  return result;
}

// Accepts a plain string or an array of strings (AI sometimes returns arrays).
const normalizeString = (v: unknown): string | null =>
  Array.isArray(v)
    ? (v as unknown[]).every((x) => typeof x === 'string') ? normalizeWhitespace((v as string[]).join(' ')) : null
    : typeof v === 'string' ? normalizeWhitespace(v) : null;

const normalizeOptionalString = (value: unknown): string | null =>
  value == null ? '' : normalizeString(value);

function isSubstantiveReaderBrief(brief: ReaderBrief): boolean {
  return brief.keyPoints.length > 0 ||
    brief.claims.length > 0 ||
    brief.signals.length > 0 ||
    brief.whyItMatters.trim().length > 0;
}

export function parseReaderBrief(raw: string | LlmJsonResponse): ReaderBrief {
  const parsed = typeof raw === 'string'
    ? parseJson<Record<string, unknown>>(raw)
    : parseStructuredJson<Record<string, unknown>>(raw);
  const summary = normalizeString(parsed.summary);
  const whyItMatters = normalizeOptionalString(parsed.whyItMatters);
  const keyPoints = normalizeOptionalStringArray(parsed.keyPoints);
  const claims = normalizeOptionalStringArray(parsed.claims);
  const signals = normalizeOptionalStringArray(parsed.signals);
  const caveats = normalizeOptionalStringArray(parsed.caveats);

  if (
    !summary ||
    whyItMatters == null ||
    !keyPoints ||
    !claims ||
    !signals ||
    !caveats
  ) {
    console.error(`❌ || parseReaderBrief error, parsed: `, JSON.stringify(parsed, null, 2));
    console.error(`❌ || whyItMatters`, whyItMatters);
    console.error(`❌ || keyPoints`, keyPoints);
    console.error(`❌ || claims`, claims);
    console.error(`❌ || signals`, signals);
    console.error(`❌ || caveats`, caveats);
    if (typeof raw !== 'string') {
      throw new LlmJsonError('invalid_schema', raw, 'reader brief 缺少必填字段或字段类型无效');
    }
    throw new Error('Invalid reader brief response');
  }

  return {
    summary,
    keyPoints,
    claims,
    whyItMatters,
    signals,
    caveats,
  };
}

async function readSubstackArticle(item: CollectedItem): Promise<ReaderBrief> {
  const model = process.env.SUBSTACK_READER_MODEL ?? DEFAULT_READER_MODEL;
  const systemPrompt =
    'You read Substack articles and return strict JSON only. Summarize the article faithfully without inventing facts.';
  const userContent = [
    'Read the full Substack article below and return strict JSON with these fields:',
    'summary, keyPoints, claims, whyItMatters, signals, caveats',
    'All list fields must always be JSON arrays of strings. If a section is empty, return []. Never return null.',
    '',
    `Publication: ${item.publication?.name ?? 'Unknown'}`,
    `Author: ${item.author.name}`,
    `Title: ${item.title ?? 'Untitled'}`,
    `Subtitle: ${item.subtitle ?? 'None'}`,
    `URL: ${item.url}`,
    '',
    'Body:',
    item.body ?? item.text,
  ].join('\n');

  try {
    const response = await generateJsonResponse({
      systemPrompt,
      userContent,
      model,
      callLabel: 'reader_brief',
    });
    return parseReaderBrief(response);
  } catch (error) {
    console.error(`[curate] reader_brief failed for ${item.id}: ${summarizeError(error)}`);
    throw error;
  }
}

export function warnOnUnderfilledCuratedItems(
  itemCount: number,
  warn: (message: string) => void = console.warn,
): void {
  if (itemCount >= CURATED_ITEM_SOFT_FLOOR) return;
  warn(
    `[curate] AI 仅整理出 ${itemCount} 条资讯，低于软下限 ${CURATED_ITEM_SOFT_FLOOR}；本次不会回填低优先级条目。`,
  );
}

function formatNonZeroRejectionCounts(diagnostics: CurationDiagnostics): string {
  return Object.entries(diagnostics.rejectionCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`)
    .join(', ');
}

function warnOnCurationDiagnostics(
  diagnostics: CurationDiagnostics,
  warn: (message: string) => void = console.warn,
): void {
  const correctedCount = diagnostics.urlCorrections.length;
  if (diagnostics.rejectedCount === 0 && correctedCount === 0) return;

  const rejectedSummary =
    diagnostics.rejectedCount > 0
      ? `已丢弃 ${diagnostics.rejectedCount} 条 AI 输出：${formatNonZeroRejectionCounts(diagnostics)}`
      : '未丢弃 AI 输出';
  const recoveredCount = diagnostics.urlCorrections.filter((correction) =>
    correction.reason === 'recovered_primary_url' || correction.reason === 'recovered_origin_url'
  ).length;
  const correctionParts = [
    correctedCount > 0 ? `已纠正 ${correctedCount} 条 URL` : null,
    recoveredCount > 0 ? `recovered_by_url=${recoveredCount}` : null,
  ].filter(Boolean);
  const correctionSummary = correctionParts.length > 0 ? `；${correctionParts.join('，')}` : '';
  const sampleSummary = diagnostics.rejectionSamples.length > 0
    ? `；samples=${diagnostics.rejectionSamples
        .slice(0, 3)
        .map((sample) => `${sample.reason}:${sample.id}:${sample.title ?? ''}`)
        .join(' | ')}`
    : '';
  warn(`[curate] ${rejectedSummary}${correctionSummary}${sampleSummary}`);
}

export async function attachReaderBriefs(
  items: CollectedItem[],
  reader: ReaderFn = readSubstackArticle,
  concurrency = 10,
): Promise<CollectedItem[]> {
  const results: CollectedItem[] = new Array(items.length);

  // Process in sliding window of `concurrency` to avoid overwhelming AI_BASE_URL
  let index = 0;
  async function runNext(): Promise<void> {
    const i = index++;
    if (i >= items.length) return;
    const item = items[i];
    if (item.source === 'substack' && item.kind !== 'substack_roundup_entry') {
      if (item.readerBrief) {
        results[i] = item;
      } else if (isSubstackTeaserOnly(item)) {
        results[i] = { ...item, substackTeaserOnly: true };
      } else {
        const readerBrief = await reader(item);
        results[i] = isSubstantiveReaderBrief(readerBrief)
          ? { ...item, readerBrief }
          : { ...item, substackTeaserOnly: true };
      }
    } else {
      results[i] = item;
    }
    await runNext();
  }

  await Promise.all(Array.from({ length: concurrency }, runNext));
  return results;
}

export function buildCollectedItemsPayload(items: CollectedItem[]): string {
  return items
    .map((item, index) => {
      const rankingLines = isRankedItem(item)
        ? [
            `优先级分: ${item.priorityScore}`,
            `编辑分: ${item.editorialScore}`,
            `互动分: ${item.engagementScore}`,
            `决策依据: ${item.decisionReasons.join(', ') || '无'}`,
          ]
        : [];

      if (item.source === 'substack') {
        return [
          `[${index + 1}] Source: substack`,
          `Item ID: ${item.id}`,
          `Publication: ${item.publication?.name ?? 'Unknown publication'}`,
          `Author: ${item.author.name}`,
          `Time: ${item.publishedAt}`,
          `Title: ${item.title ?? 'Untitled'}`,
          `Subtitle: ${item.subtitle ?? 'None'}`,
          `URL: ${item.url}`,
          item.substackTeaserOnly ? 'Content access: teaser-only / subscriber preview; full article body was not available' : null,
          ...rankingLines,
          item.readerBrief ? formatReaderBrief(item.readerBrief) : `Excerpt: ${item.text}`,
          formatMediaForPrompt(item.media),
        ].filter((line): line is string => Boolean(line)).join('\n');
      }

      return [
        `[${index + 1}] Source: twitter`,
        `Item ID: ${item.id}`,
        `Author: @${item.author.username ?? item.author.name} (${item.author.name})`,
        `Time: ${item.publishedAt}`,
        item.selfThread ? `Thread Parts: ${item.selfThread.partCount}` : null,
        item.selfThread ? `Full Thread Content: ${item.selfThread.combinedText}` : `Content: ${item.text}`,
        `Primary Source URL: ${item.url}`,
        `Original Post URL: ${item.originUrl ?? item.url}`,
        item.sourceLabel ? `Primary Source: ${item.sourceLabel}` : null,
        item.linkedSource?.title ? `Linked Title: ${item.linkedSource.title}` : null,
        item.linkedSource?.description ? `Linked Description: ${item.linkedSource.description}` : null,
        item.linkedSource?.excerpt ? `Linked Excerpt: ${item.linkedSource.excerpt}` : null,
        item.replyContext && item.replyContext.length > 0
          ? `Reply Context:\n${item.replyContext
              .map((reply) => `- @${reply.author.username ?? reply.author.name}: ${reply.text}`)
              .join('\n')}`
          : null,
        ...rankingLines,
        formatMediaForPrompt(item.media),
      ]
        .filter((line): line is string => Boolean(line))
        .join('\n');
    })
    .join('\n\n---\n\n');
}

function buildForcedRoundupPayload(items: CollectedItem[]): string {
  return items
    .map((item, index) =>
      [
        `[${index + 1}] Source: substack_roundup_entry`,
        `Item ID: ${item.id}`,
        `Publication: ${item.publication?.name ?? 'Unknown publication'}`,
        `Section: ${item.sectionLabel ?? 'Unknown section'}`,
        `Title Hint: ${item.title ?? 'Untitled'}`,
        `Bullet Text: ${item.text}`,
        `External URL: ${item.url}`,
        `Newsletter URL: ${item.originUrl ?? 'None'}`,
      ].join('\n'),
    )
    .join('\n\n---\n\n');
}

function buildUniqueUrlIndex(items: CollectedItem[], getUrl: (item: CollectedItem) => string | undefined): Map<string, CollectedItem | null> {
  const index = new Map<string, CollectedItem | null>();
  for (const item of items) {
    const url = getUrl(item);
    if (!url) continue;
    const key = normalizeUrl(url);
    if (!key) continue;
    index.set(key, index.has(key) ? null : item);
  }
  return index;
}

function recoverSourceItemByUrl(
  item: LlmCuratedItem,
  primaryUrlIndex: Map<string, CollectedItem | null>,
  originUrlIndex: Map<string, CollectedItem | null>,
  usedSourceIds: Set<string>,
): { sourceItem: CollectedItem; reason: CurationUrlCorrectionReason } | null {
  const urlKey = normalizeUrl(item.url);
  if (!urlKey) return null;

  if (primaryUrlIndex.has(urlKey)) {
    const sourceItem = primaryUrlIndex.get(urlKey);
    if (!sourceItem || usedSourceIds.has(sourceItem.id)) return null;
    return { sourceItem, reason: 'recovered_primary_url' };
  }

  if (originUrlIndex.has(urlKey)) {
    const sourceItem = originUrlIndex.get(urlKey);
    if (!sourceItem || usedSourceIds.has(sourceItem.id)) return null;
    return { sourceItem, reason: 'recovered_origin_url' };
  }

  return null;
}

export function enrichCuratedItemsWithDiagnostics(
  items: LlmCuratedItem[],
  collectedItems: CollectedItem[],
): CurateResult {
  const diagnostics = createEmptyCurationDiagnostics(collectedItems.length);
  const itemById = new Map(collectedItems.map((item) => [item.id, item]));
  const primaryUrlIndex = buildUniqueUrlIndex(collectedItems, (item) => item.url);
  const originUrlIndex = buildUniqueUrlIndex(collectedItems, (item) => item.originUrl);
  const usedSourceIds = new Set<string>();

  const enrichedItems = items.flatMap((item) => {
    let sourceItem = itemById.get(item.id);
    let recoveredReason: CurationUrlCorrectionReason | null = null;
    if (!sourceItem) {
      const recovered = recoverSourceItemByUrl(item, primaryUrlIndex, originUrlIndex, usedSourceIds);
      if (!recovered) {
        recordCurationRejection(diagnostics, 'unknown_id', item);
        return [];
      }
      sourceItem = recovered.sourceItem;
      recoveredReason = recovered.reason;
    }

    const trustedItem = recoveredReason ? { ...item, id: sourceItem.id } : item;
    const correctionReason = recoveredReason ?? getSafeUrlCorrectionReason(trustedItem.url, sourceItem);
    if (correctionReason !== null) {
      recordUrlCorrection(diagnostics, trustedItem, sourceItem, correctionReason);
    } else if (normalizeUrl(trustedItem.url) !== normalizeUrl(sourceItem.url)) {
      recordCurationRejection(diagnostics, 'url_mismatch', trustedItem, sourceItem);
      return [];
    }
    usedSourceIds.add(sourceItem.id);

    const author =
      sourceItem.author.username ??
      sourceItem.author.name ??
      trustedItem.author;

    const curatedItem: CuratedItem = {
      ...trustedItem,
      url: sourceItem.url,
      author,
      source: sourceItem.source,
      attribution: getAttribution(sourceItem),
      media: sourceItem.media,
    };

    if (sourceItem.originUrl) {
      curatedItem.originUrl = sourceItem.originUrl;
    }

    if (sourceItem && isRankedItem(sourceItem)) {
      curatedItem.priorityScore = sourceItem.priorityScore;
      curatedItem.decisionReasons = sourceItem.decisionReasons;
    }

    if (trustedItem.editorialReason) {
      curatedItem.editorialReason = trustedItem.editorialReason;
    }

    if (sourceItem.sourceResolution) {
      curatedItem.sourceResolution = sourceItem.sourceResolution;
    }

    if (sourceItem.source === 'twitter' && sourceItem.sourceResolution?.decision === 'keep_origin') {
      curatedItem.originText = sourceItem.selfThread?.combinedText ?? sourceItem.text;
    }

    if (sourceItem.selfThread) {
      curatedItem.threadPartCount = sourceItem.selfThread.partCount;
    }

    return [curatedItem];
  });

  const byId = new Map<string, CuratedItem>();
  for (const item of enrichedItems) {
    const current = byId.get(item.id);
    if (!current || hasHigherPriority(item, current)) {
      if (current) {
        recordCurationRejection(diagnostics, 'duplicate_id', current, itemById.get(current.id));
      }
      byId.set(item.id, item);
    } else {
      recordCurationRejection(diagnostics, 'duplicate_id', item, itemById.get(item.id));
    }
  }

  const byUrl = new Map<string, CuratedItem>();
  for (const item of byId.values()) {
    const key = normalizeUrl(item.url);
    const current = byUrl.get(key);
    if (!current || hasHigherPriority(item, current)) {
      if (current) {
        recordCurationRejection(diagnostics, 'duplicate_url', current, itemById.get(current.id));
      }
      byUrl.set(key, item);
    } else {
      recordCurationRejection(diagnostics, 'duplicate_url', item, itemById.get(item.id));
    }
  }

  const resultItems = Array.from(byUrl.values());
  diagnostics.outputCount = resultItems.length;

  return {
    items: resultItems,
    diagnostics,
  };
}

export function enrichCuratedItems(items: LlmCuratedItem[], collectedItems: CollectedItem[]): CuratedItem[] {
  return enrichCuratedItemsWithDiagnostics(items, collectedItems).items;
}

async function parseCurateItemsWithRetry(
  request: JsonCallRequest,
  options: LlmJsonCallOptions = {},
  parseMode: 'strict' | 'main_partial' = 'strict',
): Promise<LlmCuratedItem[]> {
  const jsonCaller = options.jsonCaller ?? generateJsonResponse;
  const warn = options.warn ?? console.warn;
  let lastError: unknown;

  for (let attempt = 1; attempt <= JSON_RETRY_LIMIT; attempt += 1) {
    const response = await jsonCaller(request);
    try {
      if (parseMode === 'main_partial') {
        const result = parseMainCurateResponse(response);
        if (result.rejectedCount > 0) {
          warn(`[curate] ${request.callLabel} 丢弃 ${result.rejectedCount} 条 schema 无效条目，继续处理有效条目`);
        }
        return result.items;
      }
      return parseCurateResponse(response);
    } catch (error) {
      lastError = error;
      if (!(error instanceof LlmJsonError) || attempt >= JSON_RETRY_LIMIT) throw error;
      warn(
        `[curate] ${request.callLabel} 返回了无效 JSON/schema，正在重试一次: ${error.message}`,
      );
    }
  }

  throw lastError ?? new Error(`[curate] ${request.callLabel} 未返回有效结果`);
}

export async function generateForcedRoundupResponse(
  items: CollectedItem[],
  options: LlmJsonCallOptions = {},
): Promise<CurateResponse> {
  const model = options.model ?? (
    process.env.OPENAI_API_KEY
      ? process.env.SUBSTACK_READER_MODEL ?? FORCED_ROUNDUP_MODEL
      : process.env.AI_MODEL ?? FORCED_ROUNDUP_MODEL
  );

  const responseItems = await parseCurateItemsWithRetry(
    {
      callLabel: 'forced_roundup',
      model,
      systemPrompt: [
        'You are a technology news editor.',
        'Return strict JSON only.',
        'The top-level object must contain exactly one field named items.',
        'For every input roundup entry, produce exactly one Chinese digest item.',
        'Each item must include id, title, summary, url, author, category, and editorialReason.',
        'category must be exactly one of Product, Tutorial, or Opinions/Thoughts.',
        'Do not drop any item and do not rename the top-level field.',
      ].join(' '),
      userContent: `请将以下 roundup 子条目逐条整理成中文资讯，每条输入都必须返回一条输出，顶层字段名必须是 items：\n\n${buildForcedRoundupPayload(items)}`,
    },
    options,
  );

  return { items: responseItems };
}

export async function enrichForcedRoundupItems(
  items: CollectedItem[],
  generator: ForcedRoundupGenerator = generateForcedRoundupResponse,
): Promise<CuratedItem[]> {
  if (items.length === 0) return [];

  const response = await generator(items);
  return enrichCuratedItems(parseCurateResponse(JSON.stringify(response)), items);
}

export function mergeCuratedItems(primary: CuratedItem[], forced: CuratedItem[]): CuratedItem[] {
  const idsFromPrimary = new Set(primary.map((item) => item.id));
  const urlsFromPrimary = new Set(primary.map((item) => normalizeUrl(item.url)));
  const combined = [
    ...primary,
    ...forced.filter((item) => !idsFromPrimary.has(item.id) && !urlsFromPrimary.has(normalizeUrl(item.url))),
  ];

  const seenIds = new Set<string>();
  const seenUrls = new Set<string>();

  return combined
    .filter((item) => {
      const urlKey = normalizeUrl(item.url);
      if (seenIds.has(item.id) || seenUrls.has(urlKey)) return false;
      seenIds.add(item.id);
      seenUrls.add(urlKey);
      return true;
    })
    .sort((a, b) => (b.priorityScore ?? Number.NEGATIVE_INFINITY) - (a.priorityScore ?? Number.NEGATIVE_INFINITY));
}

export async function curateWithModel(
  systemPrompt: string,
  userContent: string,
  options: LlmJsonCallOptions = {},
): Promise<LlmCuratedItem[]> {
  const model = options.model ?? (
    process.env.OPENAI_API_KEY
      ? process.env.OPENAI_MODEL ?? 'gpt-4o'
      : process.env.AI_MODEL ?? 'gpt-4o'
  );

  return parseCurateItemsWithRetry(
    {
      callLabel: 'main_curate',
      model,
      systemPrompt,
      userContent,
    },
    options,
    'main_partial',
  );
}

export async function curateWithDiagnostics(items: CollectedItem[]): Promise<CurateResult> {
  if (items.length === 0) {
    console.log('[curate] 没有内容需要整理');
    return {
      items: [],
      diagnostics: createEmptyCurationDiagnostics(0),
    };
  }

  const normalItems = items.filter((item) => !isSubstackRoundupEntry(item) || !item.forceSelect);
  const forcedRoundupItems = items.filter((item) => isSubstackRoundupEntry(item) && item.forceSelect);

  let curatedItems: CuratedItem[] = [];
  let diagnostics = createEmptyCurationDiagnostics(0);
  if (normalItems.length > 0) {
    const systemPrompt = await readFile(PROMPT_PATH, 'utf-8');
    const userContent =
      `以下是从多个信息源采集的 ${normalItems.length} 条内容，请按要求筛选整理：\n\n` +
      buildCollectedItemsPayload(normalItems);

    console.log('[curate] main_curate: 预处理 Substack 文章并调用主整理模型...');
    try {
      const llmItems = await curateWithModel(systemPrompt, userContent);
      console.log(
        `[curate] main_curate: candidates=${normalItems.length}, unique_candidate_ids=${
          new Set(normalItems.map((item) => item.id)).size
        }, model_output=${llmItems.length}`,
      );
      const enriched = enrichCuratedItemsWithDiagnostics(llmItems, normalItems);
      curatedItems = enriched.items;
      diagnostics = enriched.diagnostics;
      warnOnCurationDiagnostics(diagnostics);
    } catch (error) {
      console.error(`[curate] main_curate failed: ${summarizeError(error)}`);
      throw error;
    }
  }

  let forcedCuratedItems: CuratedItem[] = [];
  if (forcedRoundupItems.length > 0) {
    console.log(`[curate] forced_roundup: 整理 ${forcedRoundupItems.length} 条 roundup 子项...`);
    try {
      forcedCuratedItems = await enrichForcedRoundupItems(forcedRoundupItems);
    } catch (error) {
      console.error(`[curate] forced_roundup failed: ${summarizeError(error)}`);
      throw error;
    }
  }

  const merged = mergeCuratedItems(curatedItems, forcedCuratedItems);
  warnOnUnderfilledCuratedItems(merged.length);

  console.log(`[curate] AI 整理完成，共 ${merged.length} 条资讯`);
  return {
    items: merged,
    diagnostics,
  };
}

export async function curate(items: CollectedItem[]): Promise<CuratedItem[]> {
  return (await curateWithDiagnostics(items)).items;
}
