import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { CollectedItem, CuratedItem, MediaAsset, NewsCategory, ReaderBrief } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'curator.md');
const DEFAULT_READER_MODEL = 'gpt-4o-mini';

interface LlmCuratedItem {
  title: string;
  summary: string;
  url: string;
  author: string;
  category: NewsCategory;
}

interface CurateResponse {
  items: LlmCuratedItem[];
}

type ReaderFn = (item: CollectedItem) => Promise<ReaderBrief>;
const VALID_CATEGORIES: NewsCategory[] = ['Product', 'Tutorial', 'Opinions/Thoughts'];

function parseJson<T>(raw: string): T {
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  return JSON.parse(cleaned) as T;
}

function validateStringArray(value: unknown): string[] | null {
  return Array.isArray(value) && value.every((entry) => typeof entry === 'string')
    ? value
    : null;
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
  if (item.source === 'substack') {
    const publicationName = item.publication?.name;
    if (!publicationName) return item.author.name;
    if (item.author.name === publicationName) return publicationName;
    return `${publicationName} / ${item.author.name}`;
  }

  return `@${item.author.username ?? item.author.name}`;
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
    if (!VALID_CATEGORIES.includes(item.category)) {
      throw new Error(`AI 响应包含无效分类: ${item.category}`);
    }

    return item;
  });
}

export function parseReaderBrief(raw: string): ReaderBrief {
  const parsed = parseJson<Record<string, unknown>>(raw);
  const keyPoints = validateStringArray(parsed.keyPoints);
  const claims = validateStringArray(parsed.claims);
  const signals = validateStringArray(parsed.signals);
  const caveats = validateStringArray(parsed.caveats);

  if (
    typeof parsed.summary !== 'string' ||
    typeof parsed.whyItMatters !== 'string' ||
    !keyPoints ||
    !claims ||
    !signals ||
    !caveats
  ) {
    throw new Error('Invalid reader brief response');
  }

  return {
    summary: parsed.summary,
    keyPoints,
    claims,
    whyItMatters: parsed.whyItMatters,
    signals,
    caveats,
  };
}

export async function attachReaderBriefs(
  items: CollectedItem[],
  reader: ReaderFn = readSubstackArticle,
): Promise<CollectedItem[]> {
  return Promise.all(
    items.map(async (item) => {
      if (item.source !== 'substack') return item;
      return {
        ...item,
        readerBrief: await reader(item),
      };
    }),
  );
}

export function buildCollectedItemsPayload(items: CollectedItem[]): string {
  return items
    .map((item, index) => {
      if (item.source === 'substack') {
        return [
          `[${index + 1}] Source: substack`,
          `Publication: ${item.publication?.name ?? 'Unknown publication'}`,
          `Author: ${item.author.name}`,
          `Time: ${item.publishedAt}`,
          `Title: ${item.title ?? 'Untitled'}`,
          `Subtitle: ${item.subtitle ?? 'None'}`,
          `URL: ${item.url}`,
          item.readerBrief ? formatReaderBrief(item.readerBrief) : `Excerpt: ${item.text}`,
          formatMediaForPrompt(item.media),
        ].join('\n');
      }

      return [
        `[${index + 1}] Source: twitter`,
        `Author: @${item.author.username ?? item.author.name} (${item.author.name})`,
        `Time: ${item.publishedAt}`,
        `Content: ${item.text}`,
        `URL: ${item.url}`,
        formatMediaForPrompt(item.media),
      ].join('\n');
    })
    .join('\n\n---\n\n');
}

export function enrichCuratedItems(items: LlmCuratedItem[], collectedItems: CollectedItem[]): CuratedItem[] {
  const itemByUrl = new Map(collectedItems.map((item) => [item.url, item]));

  return items.map((item) => {
    const sourceItem = itemByUrl.get(item.url);
    const author =
      sourceItem?.author.username ??
      sourceItem?.author.name ??
      item.author;

    return {
      ...item,
      author,
      source: sourceItem?.source ?? 'twitter',
      attribution: sourceItem ? getAttribution(sourceItem) : `@${item.author}`,
      media: sourceItem?.media ?? [],
    };
  });
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

  const systemPrompt = await readFile(PROMPT_PATH, 'utf-8');
  const enrichedItems = await attachReaderBriefs(items);
  const userContent =
    `以下是从多个信息源采集的 ${enrichedItems.length} 条内容，请按要求筛选整理：\n\n` +
    buildCollectedItemsPayload(enrichedItems);

  console.log('[curate] 预处理 Substack 文章并调用主整理模型...');
  const llmItems = await curateWithModel(systemPrompt, userContent);
  const curatedItems = enrichCuratedItems(llmItems, enrichedItems);

  console.log(`[curate] AI 整理完成，共 ${curatedItems.length} 条资讯`);
  return curatedItems;
}
