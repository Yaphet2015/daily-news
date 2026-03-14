import { readFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import OpenAI from 'openai';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import type { RawTweet, CuratedItem } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROMPT_PATH = join(__dirname, '..', 'prompts', 'curator.md');

interface CurateResponse {
  items: CuratedItem[];
}

function buildTweetsPayload(tweets: RawTweet[]): string {
  return tweets
    .map(
      (t, i) =>
        `[${i + 1}] @${t.author.username} (${t.author.name})\n` +
        `时间: ${t.createdAt}\n` +
        `内容: ${t.text}\n` +
        `链接: ${t.url}`,
    )
    .join('\n\n---\n\n');
}

function parseResponse(raw: string): CuratedItem[] {
  // Strip markdown code fences if present
  const cleaned = raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
  const parsed = JSON.parse(cleaned) as CurateResponse;
  if (!Array.isArray(parsed.items)) throw new Error('AI 响应缺少 items 字段');
  return parsed.items;
}

async function curateWithOpenAI(systemPrompt: string, userContent: string): Promise<CuratedItem[]> {
  const apiKey = process.env.OPENAI_API_KEY!;
  const model = process.env.OPENAI_MODEL ?? 'gpt-4o';

  const client = new OpenAI({ apiKey });
  console.log(`[curate] 使用 OpenAI (${model})...`);

  const response = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userContent },
    ],
    response_format: { type: 'json_object' },
  });

  const raw = response.choices[0]?.message?.content ?? '';
  return parseResponse(raw);
}

async function curateWithAiSdk(systemPrompt: string, userContent: string): Promise<CuratedItem[]> {
  const baseURL = process.env.AI_BASE_URL!;
  const apiKey = process.env.AI_API_KEY!;
  const model = process.env.AI_MODEL ?? 'gpt-4o';

  const openai = createOpenAI({ baseURL, apiKey });
  console.log(`[curate] 使用 ai-sdk 聚合商 (${model})...`);

  const { text } = await generateText({
    model: openai(model),
    system: systemPrompt,
    prompt: userContent,
  });

  return parseResponse(text);
}

export async function curate(tweets: RawTweet[]): Promise<CuratedItem[]> {
  if (tweets.length === 0) {
    console.log('[curate] 没有推文需要整理');
    return [];
  }

  const systemPrompt = await readFile(PROMPT_PATH, 'utf-8');
  const userContent =
    `以下是从 Twitter 列表采集的 ${tweets.length} 条推文，请按要求筛选整理：\n\n` +
    buildTweetsPayload(tweets);

  let items: CuratedItem[];

  const hasOpenAI = Boolean(process.env.OPENAI_API_KEY);
  const hasAiSdk = Boolean(process.env.AI_BASE_URL && process.env.AI_API_KEY);

  if (hasOpenAI) {
    items = await curateWithOpenAI(systemPrompt, userContent);
  } else if (hasAiSdk) {
    items = await curateWithAiSdk(systemPrompt, userContent);
  } else {
    throw new Error(
      'AI 配置缺失：请在 .env 中设置 OPENAI_API_KEY，或同时设置 AI_BASE_URL 和 AI_API_KEY',
    );
  }

  console.log(`[curate] AI 整理完成，共 ${items.length} 条资讯`);
  return items;
}
