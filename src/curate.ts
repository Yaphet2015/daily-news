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
const VALID_CATEGORIES: NewsCategory[] = ['Product', 'Tutorial', 'Opinions/Thoughts'];
const CURATED_ITEM_SOFT_FLOOR = 40;

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

function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  return JSON.parse(cleaned) as T;
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

async function generateJsonObject<T>(
  systemPrompt: string,
  userContent: string,
  model: string,
): Promise<T> {
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

    return parseJson<T>(response.choices[0]?.message?.content ?? '');
  }

  if (hasAiSdk) {
    const openai = createOpenAI({
      baseURL: process.env.AI_BASE_URL!,
      apiKey: process.env.AI_API_KEY!,
    });

    const { text } = await generateText({
      model: openai(model),
      system: systemPrompt,
      prompt: userContent,
    });

    return parseJson<T>(text);
  }

  throw new Error('AI 配置缺失：请在 .env 中设置 OPENAI_API_KEY，或同时设置 AI_BASE_URL 和 AI_API_KEY');
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

  const brief = await generateJsonObject<ReaderBrief>(systemPrompt, userContent, model);
  return parseReaderBrief(JSON.stringify(brief));
}

function parseCurateResponse(raw: string): LlmCuratedItem[] {
  const parsed = parseJson<CurateResponse>(raw);
  if (!Array.isArray(parsed.items)) throw new Error('AI 响应缺少 items 字段');

  return parsed.items.map((item) => {
    if (typeof item.id !== 'string' || item.id.length === 0) {
      throw new Error('AI 响应包含无效 id');
    }
    if (!VALID_CATEGORIES.includes(item.category)) {
      throw new Error(`AI 响应包含无效分类: ${item.category}`);
    }

    return item;
  });
}

// Accepts a plain string or an array of strings (AI sometimes returns arrays).
const normalizeString = (v: unknown): string | null =>
  Array.isArray(v)
    ? (v as unknown[]).every((x) => typeof x === 'string') ? (v as string[]).join(' ') : null
    : typeof v === 'string' ? v : null;

export function parseReaderBrief(raw: string): ReaderBrief {
  const parsed = parseJson<Record<string, unknown>>(raw);
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

async function generateForcedRoundupResponse(items: CollectedItem[]): Promise<CurateResponse> {
  const model = process.env.OPENAI_API_KEY
    ? process.env.SUBSTACK_READER_MODEL ?? FORCED_ROUNDUP_MODEL
    : process.env.AI_MODEL ?? FORCED_ROUNDUP_MODEL;

  const response = await generateJsonObject<CurateResponse>(
    'You are a technology news editor. Return strict JSON only. For every input roundup entry, produce one Chinese digest item with id, title, summary, url, author, category, and editorialReason. Do not drop any item.',
    `请将以下 roundup 子条目逐条整理成中文资讯，每条输入都必须返回一条输出：\n\n${buildForcedRoundupPayload(items)}`,
    model,
  );

  return response;
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

async function curateWithModel(systemPrompt: string, userContent: string): Promise<LlmCuratedItem[]> {
  const model = process.env.OPENAI_API_KEY
    ? process.env.OPENAI_MODEL ?? 'gpt-4o'
    : process.env.AI_MODEL ?? 'gpt-4o';

  const response = await generateJsonObject<CurateResponse>(systemPrompt, userContent, model);
  return parseCurateResponse(JSON.stringify(response));
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

    console.log('[curate] 预处理 Substack 文章并调用主整理模型...');
    const llmItems = await curateWithModel(systemPrompt, userContent);
    curatedItems = enrichCuratedItems(llmItems, normalItems);
    if (curatedItems.length < llmItems.length) {
      console.warn(`[curate] 已丢弃 ${llmItems.length - curatedItems.length} 条重复或无效的 AI 输出条目`);
    }
  }

  const forcedCuratedItems = await enrichForcedRoundupItems(forcedRoundupItems);
  const merged = mergeCuratedItems(curatedItems, forcedCuratedItems);
  warnOnUnderfilledCuratedItems(merged.length);

  console.log(`[curate] AI 整理完成，共 ${merged.length} 条资讯`);
  return merged;
}
