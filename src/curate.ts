import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { CollectedItem, CuratedItem, MediaAsset, NewsCategory, RankedItem, ReaderBrief } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'curator.md');
const DEFAULT_READER_MODEL = 'gpt-4o-mini';
const FORCED_ROUNDUP_MODEL = 'gpt-4o-mini';

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
    `Why It Matters: ${brief.whyItMatters}`,
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

function validateCurateItems(items: unknown, response: LlmJsonResponse | null): LlmCuratedItem[] {
  if (!Array.isArray(items)) {
    if (response) throw new LlmJsonError('invalid_schema', response, 'AI 响应缺少顶层 items 数组');
    throw new Error('AI 响应缺少 items 字段');
  }

  return items.map((item) => {
    if (!item || typeof item !== 'object') {
      if (response) throw new LlmJsonError('invalid_schema', response, 'AI 响应包含非对象条目');
      throw new Error('AI 响应包含非对象条目');
    }

    const candidate = item as LlmCuratedItem;
    if (typeof candidate.id !== 'string' || candidate.id.length === 0) {
      if (response) throw new LlmJsonError('invalid_schema', response, 'AI 响应包含无效 id');
      throw new Error('AI 响应包含无效 id');
    }
    if (!VALID_CATEGORIES.includes(candidate.category)) {
      if (response) {
        throw new LlmJsonError('invalid_schema', response, `AI 响应包含无效分类: ${String(candidate.category)}`);
      }
      throw new Error(`AI 响应包含无效分类: ${String(candidate.category)}`);
    }

    return candidate;
  });
}

function parseCurateResponse(raw: string | LlmJsonResponse): LlmCuratedItem[] {
  if (typeof raw === 'string') {
    const parsed = parseJson<CurateResponse>(raw);
    return validateCurateItems(parsed.items, null);
  }

  const parsed = parseStructuredJson<Record<string, unknown>>(raw);
  return validateCurateItems(parsed.items, raw);
}

// Accepts a plain string or an array of strings (AI sometimes returns arrays).
const normalizeString = (v: unknown): string | null =>
  Array.isArray(v)
    ? (v as unknown[]).every((x) => typeof x === 'string') ? (v as string[]).join(' ') : null
    : typeof v === 'string' ? v : null;

export function parseReaderBrief(raw: string | LlmJsonResponse): ReaderBrief {
  const parsed = typeof raw === 'string'
    ? parseJson<Record<string, unknown>>(raw)
    : parseStructuredJson<Record<string, unknown>>(raw);
  const summary = normalizeString(parsed.summary);
  const whyItMatters = normalizeString(parsed.whyItMatters);
  const keyPoints = normalizeOptionalStringArray(parsed.keyPoints);
  const claims = normalizeOptionalStringArray(parsed.claims);
  const signals = normalizeOptionalStringArray(parsed.signals);
  const caveats = normalizeOptionalStringArray(parsed.caveats);

  if (
    !summary ||
    !whyItMatters ||
    !keyPoints ||
    !claims ||
    !signals ||
    !caveats
  ) {
    console.error(`❌ || parseReaderBrief error, parsed: `, JSON.stringify(parsed, null, 2));
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
    results[i] =
      item.source === 'substack' && item.kind !== 'substack_roundup_entry'
        ? item.readerBrief
          ? item
          : { ...item, readerBrief: await reader(item) }
        : item;
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
          ...rankingLines,
          item.readerBrief ? formatReaderBrief(item.readerBrief) : `Excerpt: ${item.text}`,
          formatMediaForPrompt(item.media),
        ].join('\n');
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

export function enrichCuratedItems(items: LlmCuratedItem[], collectedItems: CollectedItem[]): CuratedItem[] {
  const itemById = new Map(collectedItems.map((item) => [item.id, item]));

  const enrichedItems = items.flatMap((item) => {
    const sourceItem = itemById.get(item.id);
    if (!sourceItem || normalizeUrl(item.url) !== normalizeUrl(sourceItem.url)) return [];

    const author =
      sourceItem.author.username ??
      sourceItem.author.name ??
      item.author;

    const curatedItem: CuratedItem = {
      ...item,
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

    if (item.editorialReason) {
      curatedItem.editorialReason = item.editorialReason;
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
      byId.set(item.id, item);
    }
  }

  const byUrl = new Map<string, CuratedItem>();
  for (const item of byId.values()) {
    const key = normalizeUrl(item.url);
    const current = byUrl.get(key);
    if (!current || hasHigherPriority(item, current)) {
      byUrl.set(key, item);
    }
  }

  return Array.from(byUrl.values());
}

async function parseCurateItemsWithRetry(
  request: JsonCallRequest,
  options: LlmJsonCallOptions = {},
): Promise<LlmCuratedItem[]> {
  const jsonCaller = options.jsonCaller ?? generateJsonResponse;
  const warn = options.warn ?? console.warn;
  let lastError: unknown;

  for (let attempt = 1; attempt <= JSON_RETRY_LIMIT; attempt += 1) {
    const response = await jsonCaller(request);
    try {
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
  );
}

export async function curate(items: CollectedItem[]): Promise<CuratedItem[]> {
  if (items.length === 0) {
    console.log('[curate] 没有内容需要整理');
    return [];
  }

  const normalItems = items.filter((item) => !isSubstackRoundupEntry(item) || !item.forceSelect);
  const forcedRoundupItems = items.filter((item) => isSubstackRoundupEntry(item) && item.forceSelect);

  let curatedItems: CuratedItem[] = [];
  if (normalItems.length > 0) {
    const systemPrompt = await readFile(PROMPT_PATH, 'utf-8');
    const userContent =
      `以下是从多个信息源采集的 ${normalItems.length} 条内容，请按要求筛选整理：\n\n` +
      buildCollectedItemsPayload(normalItems);

    console.log('[curate] main_curate: 预处理 Substack 文章并调用主整理模型...');
    try {
      const llmItems = await curateWithModel(systemPrompt, userContent);
      curatedItems = enrichCuratedItems(llmItems, normalItems);
      if (curatedItems.length < llmItems.length) {
        console.warn(`[curate] 已丢弃 ${llmItems.length - curatedItems.length} 条重复或无效的 AI 输出条目`);
      }
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
  return merged;
}
