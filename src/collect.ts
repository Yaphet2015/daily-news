import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { confirm, input } from '@inquirer/prompts';
import { createOpenAI } from '@ai-sdk/openai';
import { generateText } from 'ai';
import OpenAI from 'openai';
import WebSocket from 'ws';
import {
  formatPreferenceHintsForPrompt,
  normalizeConfirmedPreferenceRules,
  readConfirmedPreferenceRules,
  type ConfirmedPreferenceRules,
} from './preferences.js';
import { collapseSameIdItems } from './collapse-same-id.js';
import { DEFAULT_ENABLED_SOURCES, normalizeSourceNames } from './source-registry.js';
import type { SourceName } from './source-registry.js';
import type {
  CollectionSnapshot,
  CollectedItem,
  LinkedSource,
  MediaAsset,
  ReplyContext,
  RoundupMode,
  RunState,
  SelfThread,
  SelfThreadPart,
  SourceResolution,
} from './types.js';

export { collapseSameIdItems };

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const TWITTER_API_BASE = 'https://api.twitterapi.io';
const MAX_TWEETS = 500;
const DIAGNOSTIC_TWEET_LIMIT = 5;
const DEFAULT_TWITTER_LIST_ID = '2043983199311913431';
const DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60;
const DEFAULT_SUBSTACK_MAX_POSTS = 40;
const DEFAULT_SUBSTACK_MAX_POSTS_PER_PUBLICATION = 2;
const DEFAULT_AIHOT_FEED_URL = 'https://aihot.virxact.com/feed.xml';
const DEFAULT_AIHOT_MAX_ITEMS = 50;
const SELF_THREAD_MAX_SPAN_SECONDS = 15 * 60;
const DEFAULT_TWITTER_RECOMMENDATION_BATCH_SIZE = 50;
const DEFAULT_TWITTER_RECOMMENDATION_BATCH_COUNT = 6;
const DEFAULT_TWITTER_RECOMMENDATION_BATCH_MIN_DELAY_MS = 8000;
const DEFAULT_TWITTER_RECOMMENDATION_BATCH_MAX_DELAY_MS = 20000;
const FALLBACK_TWITTER_RECOMMENDATION_MAX_TWEETS = 20;
const DEFAULT_TWITTER_ENRICHMENT_MAX_TRANSIENT_FAILURES = 3;
const DEFAULT_TWITTER_RECOMMENDATION_CDP_ENDPOINT = 'http://127.0.0.1:9222';
const DEFAULT_TWITTER_RECOMMENDATION_FILTER_MODEL = 'deepseek-v4-flash';

interface TwitterCliTweet {
  id: string;
  text: string;
  author: {
    id: string;
    name: string;
    screenName: string;
  };
  createdAt: string;
  createdAtLocal?: string;
  media?: Array<{
    type?: string;
    url?: string;
    width?: number;
    height?: number;
  }>;
  urls?: string[];
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  quoteCount?: number;
  metrics?: {
    likes?: number;
    replies?: number;
    retweets?: number;
    quotes?: number;
  };
  articleTitle?: string;
  articleText?: string;
  quotedTweet?: {
    id?: string;
    text?: string;
    author?: {
      name?: string;
      screenName?: string;
    };
  };
}

interface TwitterCliOutput {
  ok: boolean;
  data: TwitterCliTweet[];
}

type TwitterCliReplyPayload = TwitterCliTweet[] | TwitterCliOutput;

interface TwitterApiTweet {
  id: string;
  text: string;
  author: {
    name: string;
    userName: string;
  };
  createdAt: string;
  url?: string;
  media?: unknown;
  entities?: {
    urls?: Array<{
      expanded_url?: string;
      url?: string;
    }>;
  };
  extendedEntities?: {
    media?: unknown[];
  };
  favorite_count?: number;
  reply_count?: number;
  retweet_count?: number;
  quote_count?: number;
}

interface TwitterApiResponse {
  tweets: TwitterApiTweet[];
  has_next_page: boolean;
  next_cursor: string;
  status: string;
  message?: string;
}

interface TwitterApiReplyResponse {
  replies?: TwitterApiReply[];
  has_next_page?: boolean;
  next_cursor?: string;
  status?: string;
  message?: string;
}

interface TwitterApiReply {
  id: string;
  text: string;
  url?: string;
  createdAt?: string;
  author?: {
    name?: string;
    userName?: string;
  };
  entities?: {
    urls?: Array<{
      expanded_url?: string;
      url?: string;
    }>;
  };
}

interface SubstackPublicationLike {
  handle?: string;
  slug?: string;
  name: string;
  url?: string;
  roundupMode?: RoundupMode;
  posts(options?: { limit?: number }): AsyncIterable<SubstackPreviewLike>;
}

interface SubstackPreviewLike {
  fullPost?(): Promise<SubstackPostLike>;
}

interface SubstackPostLike {
  id: number | string;
  title: string;
  subtitle?: string | null;
  body?: string;
  htmlBody?: string;
  truncatedBody?: string;
  markdown?: string;
  publishedAt: Date | string;
  url: string;
  coverImage?: string | null;
}

interface SubstackOwnProfileLike {
  following(options?: { limit?: number }): AsyncIterable<SubstackPublicationLike>;
}

interface SubstackClientLike {
  ownProfile(): Promise<SubstackOwnProfileLike>;
}

interface SourceCollectionResult {
  items: CollectedItem[];
  warnings?: string[];
}

type SourceCollector = (sinceTime: number) => Promise<CollectedItem[] | SourceCollectionResult>;

interface CollectSourcesOptions {
  enabledSources: SourceName[];
  nowSeconds: number;
  state: RunState;
  collectors: Record<SourceName, SourceCollector>;
}

interface CollectSubstackItemsOptions {
  sinceTime: number;
  maxPosts?: number;
  maxPostsPerPublication?: number;
  client?: SubstackClientLike;
  deps?: {
    fetchPublicSubstackPublications?: typeof fetchPublicSubstackPublications;
    fetchPublicationFeed?: typeof fetchPublicationFeed;
  };
}

interface DiagnoseCollectEnvironmentDeps {
  env?: NodeJS.ProcessEnv;
  execFile?: (file: string, args: string[]) => Promise<{ stdout: string; stderr: string }>;
  execTwitterCliCommand?: typeof execTwitterCliCommand;
  log?: (message: string) => void;
}

interface TwitterRecommendationAuth {
  authToken: string;
  ct0: string;
}

interface CdpCookie {
  name?: string;
  value?: string;
  domain?: string;
}

interface CdpCookieResponse {
  cookies?: CdpCookie[];
}

interface CdpTarget {
  type?: string;
  url?: string;
  webSocketDebuggerUrl?: string;
}

interface FetchTwitterRecommendationAuthFromCdpOptions {
  endpoint?: string;
  fetchJson?: (url: string) => Promise<unknown>;
  sendCdpCommand?: (webSocketUrl: string, method: string) => Promise<unknown>;
}

interface CollectTwitterRecommendationItemsOptions {
  batchSize?: number;
  batchCount?: number;
  minBatchDelayMs?: number;
  maxBatchDelayMs?: number;
  fetchRecommendationAuth?: () => Promise<TwitterRecommendationAuth | null>;
  chooseRecommendationLoginRetry?: () => Promise<boolean>;
  execTwitterCliCommand?: typeof execTwitterCliCommand;
  random?: () => number;
  sleep?: (ms: number) => Promise<void>;
  topicGate?: RecommendationTopicGate;
  warn?: (message: string) => void;
}

interface RecommendationTopicGateCandidate {
  id: string;
  author: string;
  username?: string;
  url: string;
  textPreview: string;
}

type RecommendationTopicGate = (items: RecommendationTopicGateCandidate[]) => Promise<Set<string>>;

interface PublicSubstackFeed {
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>> & {
    roundupMode?: RoundupMode;
  };
  posts: SubstackPostLike[];
}

interface ConfiguredSubstackPublication {
  name: string;
  handle: string;
  slug: string;
  url: string;
  roundupMode?: RoundupMode;
}

const CONFIGURED_SUBSTACK_PUBLICATIONS: ConfiguredSubstackPublication[] = [
  {
    name: "Ben's Bites",
    handle: 'bensbites',
    slug: 'bensbites',
    url: 'https://www.bensbites.com',
    roundupMode: 'bullet_links',
  },
];

function buildTweetUrl(username: string, id: string): string {
  return `https://x.com/${username}/status/${id}`;
}

function normalizeDomain(hostname: string): string {
  return hostname.trim().replace(/^www\./i, '').toLowerCase();
}

function isTwitterDomain(hostname: string): boolean {
  const normalized = normalizeDomain(hostname);
  return normalized === 'x.com' || normalized === 'twitter.com' || normalized === 't.co';
}

function isTwitterShortener(hostname: string): boolean {
  return normalizeDomain(hostname) === 't.co';
}

function isKnownVideoDomain(hostname: string): boolean {
  const normalized = normalizeDomain(hostname);
  return [
    'youtube.com',
    'youtu.be',
    'vimeo.com',
    'tiktok.com',
    'bilibili.com',
    'loom.com',
  ].some((domain) => normalized === domain || normalized.endsWith(`.${domain}`));
}

function hasDirectMediaExtension(pathname: string): boolean {
  return /\.(?:mp4|m4v|mov|avi|wmv|webm|m3u8|mp3|wav|ogg|jpg|jpeg|png|gif|webp|svg|pdf)(?:$|[?#])/i.test(
    pathname,
  );
}

function rewritePaperLandingUrl(raw: string): string {
  try {
    const parsed = new URL(raw);
    const host = normalizeDomain(parsed.hostname);
    if (host !== 'arxiv.org' && !host.endsWith('.arxiv.org')) return raw;
    const match = parsed.pathname.match(/^\/pdf\/([^/]+?)(?:\.pdf)?$/i);
    if (!match?.[1]) return raw;
    return `https://arxiv.org/abs/${match[1]}`;
  } catch {
    return raw;
  }
}

export function isLikelyPrimarySourceUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return false;

    if (isTwitterShortener(parsed.hostname)) return false;
    if (isTwitterDomain(parsed.hostname)) {
      return /^\/i\/article\/[^/?#]+/i.test(parsed.pathname);
    }

    if (isKnownVideoDomain(parsed.hostname)) return false;
    if (hasDirectMediaExtension(parsed.pathname)) return false;
    return true;
  } catch {
    return false;
  }
}

export function normalizeExternalUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (isTwitterDomain(parsed.hostname)) return null;
    parsed.hash = '';

    const paramsToDrop = ['ref', 's'];
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || paramsToDrop.includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

function canonicalizePrimarySourceUrl(raw: string): string | null {
  const normalized = normalizeExternalUrl(rewritePaperLandingUrl(raw));
  if (!normalized || !isLikelyPrimarySourceUrl(normalized)) return null;
  return normalized;
}

function extractUrlsFromText(text: string): string[] {
  return extractRawUrlsFromText(text)
    .map((value) => canonicalizePrimarySourceUrl(value))
    .flatMap((value) => (value ? [value] : []));
}

function extractRawUrlsFromText(text: string): string[] {
  return dedupeUrls(
    Array.from(text.matchAll(/https?:\/\/\S+/gi)).map((match) => match[0].replace(/[),.;!?]+$/g, '')),
  );
}

function dedupeUrls(urls: string[]): string[] {
  return Array.from(new Set(urls));
}

function extractStructuredUrls(urls: Array<string | undefined | null>): string[] {
  return dedupeUrls(
    urls
      .map((url) => (typeof url === 'string' ? canonicalizePrimarySourceUrl(url) : null))
      .flatMap((url) => (url ? [url] : [])),
  );
}

function extractTwitterApiUrls(tweet: Pick<TwitterApiTweet, 'entities' | 'text'>): string[] {
  const structured = extractStructuredUrls(
    (tweet.entities?.urls ?? []).flatMap((entry) => [entry.expanded_url, entry.url]),
  );
  return structured.length > 0 ? structured : extractUrlsFromText(tweet.text);
}

function extractTwitterCliUrls(tweet: Pick<TwitterCliTweet, 'urls' | 'text'>): string[] {
  const structured = extractStructuredUrls(tweet.urls ?? []);
  return structured.length > 0 ? structured : extractUrlsFromText(tweet.text);
}

function normalizeTwitterUrl(raw: string): string | null {
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (!isTwitterDomain(parsed.hostname) || isTwitterShortener(parsed.hostname)) return null;
    parsed.hash = '';
    parsed.hostname = 'x.com';

    const paramsToDrop = ['ref', 's'];
    for (const key of [...parsed.searchParams.keys()]) {
      if (key.toLowerCase().startsWith('utm_') || paramsToDrop.includes(key.toLowerCase())) {
        parsed.searchParams.delete(key);
      }
    }

    const normalized = parsed.toString();
    return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
  } catch {
    return null;
  }
}

function normalizeTwitterStatusUrl(raw: string): string | null {
  const normalizedUrl = normalizeTwitterUrl(raw);
  if (!normalizedUrl) return null;
  return /^https:\/\/x\.com\/[^/]+\/status\/[^/?#]+/i.test(normalizedUrl) ? normalizedUrl : null;
}

function buildEmbeddedLinkedSourceFromTwitterUrl(
  raw: string,
  hints: { title?: string; description?: string; excerpt?: string } = {},
  via: LinkedSource['via'] = 'quote',
): LinkedSource | undefined {
  const normalizedUrl = normalizeTwitterUrl(raw);
  if (!normalizedUrl) return undefined;

  const parsed = new URL(normalizedUrl);
  const articleMatch = parsed.pathname.match(/^\/i\/article\/([^/?#]+)/i);

  if (!articleMatch) return undefined;

  const title =
    hints.title?.trim() ||
    (articleMatch ? 'X Article' : undefined);
  const excerpt = hints.excerpt?.trim() || undefined;
  const description = hints.description?.trim() || undefined;

  return {
    url: normalizedUrl,
    title,
    description,
    excerpt,
    domain: normalizeDomain(parsed.hostname),
    via,
  };
}

function buildQuotedStatusUrl(tweet: Pick<TwitterCliTweet, 'quotedTweet'>): string | undefined {
  const quotedTweet = tweet.quotedTweet;
  const quoteId = quotedTweet?.id?.trim();
  const quoteAuthor = quotedTweet?.author?.screenName?.trim();
  return quoteId && quoteAuthor ? buildTweetUrl(quoteAuthor, quoteId) : undefined;
}

function extractTwitterCliEmbeddedLinkedSource(
  tweet: Pick<TwitterCliTweet, 'urls' | 'text' | 'articleTitle' | 'articleText'>,
): LinkedSource | undefined {
  const structuredArticle =
    (tweet.urls ?? []).find((url): url is string => {
      return typeof url === 'string' && Boolean(buildEmbeddedLinkedSourceFromTwitterUrl(url));
    }) ?? extractRawUrlsFromText(tweet.text).find((url) => Boolean(buildEmbeddedLinkedSourceFromTwitterUrl(url)));

  if (!structuredArticle) return undefined;

  return buildEmbeddedLinkedSourceFromTwitterUrl(
    structuredArticle,
    {
      title: tweet.articleTitle,
      description: tweet.articleTitle ? 'X article' : undefined,
      excerpt: tweet.articleText,
    },
    'tweet',
  );
}

// Fallback when CLI returns articleTitle/articleText but no /i/article/ URL.
// This happens when a tweet IS an X article but CLI surfaces it as a regular tweet.
function buildArticleMetadataLinkedSource(
  tweet: Pick<TwitterCliTweet, 'id' | 'author' | 'articleTitle' | 'articleText'>,
): LinkedSource | undefined {
  const title = tweet.articleTitle?.trim();
  const excerpt = tweet.articleText?.trim().slice(0, 1500);
  if (!title && !excerpt) return undefined;

  const tweetUrl = buildTweetUrl(tweet.author.screenName, tweet.id);
  return {
    url: tweetUrl,
    title: title || undefined,
    description: title ? 'X article' : undefined,
    excerpt: excerpt || undefined,
    domain: 'x.com',
    via: 'tweet',
  };
}

function extractTwitterApiEmbeddedLinkedSource(
  tweet: Pick<TwitterApiTweet, 'entities' | 'text'>,
): LinkedSource | undefined {
  const structuredArticle =
    (tweet.entities?.urls ?? [])
      .flatMap((entry) => [entry.expanded_url, entry.url])
      .find((url): url is string => {
        return typeof url === 'string' && Boolean(buildEmbeddedLinkedSourceFromTwitterUrl(url));
      }) ?? extractRawUrlsFromText(tweet.text).find((url) => Boolean(buildEmbeddedLinkedSourceFromTwitterUrl(url)));

  return structuredArticle ? buildEmbeddedLinkedSourceFromTwitterUrl(structuredArticle, {}, 'tweet') : undefined;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toUnixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, ' ').trim();
}

function sortNewestFirst(items: CollectedItem[]): CollectedItem[] {
  return [...items].sort((a, b) => Date.parse(b.publishedAt) - Date.parse(a.publishedAt));
}

function filterSinceTime(items: CollectedItem[], sinceTime: number): CollectedItem[] {
  return items.filter((item) => toUnixSeconds(item.publishedAt) > sinceTime);
}

function parseThreadPrefix(text: string): { part: number; total: number } | null {
  const match = text.match(/^\s*(\d{1,3})\s*\/\s*(\d{1,3})\b/);
  if (!match) return null;

  const part = Number.parseInt(match[1] ?? '', 10);
  const total = Number.parseInt(match[2] ?? '', 10);
  if (!Number.isFinite(part) || !Number.isFinite(total) || part < 1 || total < 2 || part > total) {
    return null;
  }

  return { part, total };
}

function compareThreadOrder(a: CollectedItem, b: CollectedItem): number {
  const timeDiff = Date.parse(a.publishedAt) - Date.parse(b.publishedAt);
  if (timeDiff !== 0) return timeDiff;
  return a.id.localeCompare(b.id);
}

function buildSelfThreadPart(item: CollectedItem): SelfThreadPart {
  return {
    id: item.id,
    originUrl: item.originUrl,
    text: item.text,
    publishedAt: item.publishedAt,
    media: item.media,
  };
}

function buildCombinedThreadText(
  parts: Array<{ item: CollectedItem; prefix: { part: number; total: number } }>,
): string {
  return parts
    .map(({ item, prefix }) => `[${prefix.part}/${prefix.total}] ${item.text.trim()}`)
    .join('\n\n');
}

function buildCollapsedThreadItem(
  root: CollectedItem,
  parts: Array<{ item: CollectedItem; prefix: { part: number; total: number } }>,
): CollectedItem {
  const selfThread: SelfThread = {
    partIds: parts.map(({ item }) => item.id),
    partCount: parts.length,
    combinedText: buildCombinedThreadText(parts),
    parts: parts.map(({ item }) => buildSelfThreadPart(item)),
  };

  return {
    ...root,
    text: selfThread.combinedText,
    url: root.originUrl ?? root.url,
    originUrl: root.originUrl ?? root.url,
    media: parts.flatMap(({ item }) => item.media),
    sourceResolution: { decision: 'keep_origin', reason: 'numbered_self_thread' },
    selfThread,
  };
}

export function collapseNumberedSelfThreads(items: CollectedItem[]): CollectedItem[] {
  const itemsByAuthor = new Map<string, CollectedItem[]>();
  for (const item of items) {
    if (item.source !== 'twitter') continue;
    const username = item.author.username?.trim().toLowerCase();
    if (!username) continue;
    const authorItems = itemsByAuthor.get(username) ?? [];
    authorItems.push(item);
    itemsByAuthor.set(username, authorItems);
  }

  const rootReplacements = new Map<string, CollectedItem>();
  const omittedIds = new Set<string>();

  for (const authorItems of itemsByAuthor.values()) {
    const sorted = [...authorItems].sort(compareThreadOrder);

    for (let index = 0; index < sorted.length; index += 1) {
      const root = sorted[index];
      if (!root || rootReplacements.has(root.id) || omittedIds.has(root.id)) continue;

      const rootPrefix = parseThreadPrefix(root.text);
      if (!rootPrefix || rootPrefix.part !== 1) continue;

      const startedAt = toUnixSeconds(root.publishedAt);
      const candidateParts: Array<{ item: CollectedItem; prefix: { part: number; total: number } }> = [
        { item: root, prefix: rootPrefix },
      ];
      let nextPart = 2;

      for (let probe = index + 1; probe < sorted.length && nextPart <= rootPrefix.total; probe += 1) {
        const candidate = sorted[probe];
        if (!candidate || rootReplacements.has(candidate.id) || omittedIds.has(candidate.id)) continue;
        if (toUnixSeconds(candidate.publishedAt) - startedAt > SELF_THREAD_MAX_SPAN_SECONDS) break;

        const candidatePrefix = parseThreadPrefix(candidate.text);
        if (!candidatePrefix) continue;
        if (candidatePrefix.total !== rootPrefix.total) continue;
        if (candidatePrefix.part !== nextPart) continue;

        candidateParts.push({ item: candidate, prefix: candidatePrefix });
        nextPart += 1;
      }

      if (candidateParts.length !== rootPrefix.total || candidateParts.length < 2) continue;

      rootReplacements.set(root.id, buildCollapsedThreadItem(root, candidateParts));
      for (const { item } of candidateParts.slice(1)) {
        omittedIds.add(item.id);
      }
    }
  }

  const result: CollectedItem[] = [];
  for (const item of items) {
    if (omittedIds.has(item.id)) continue;
    result.push(rootReplacements.get(item.id) ?? item);
  }

  return result;
}

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getSourceSinceTime(state: RunState, source: SourceName, nowSeconds: number): number {
  const lastPublishedTime = state.sources[source].lastPublishedTime;
  return lastPublishedTime > 0 ? lastPublishedTime : nowSeconds - DEFAULT_LOOKBACK_SECONDS;
}

function normalizeMediaItem(item: unknown, fallbackType?: string): MediaAsset | null {
  if (!item || typeof item !== 'object') return null;

  const candidate = item as Record<string, unknown>;
  const urlFields = ['url', 'media_url_https', 'media_url', 'src'];
  const url = urlFields.find((key) => typeof candidate[key] === 'string');

  if (!url) return null;

  const originalInfo =
    candidate.original_info && typeof candidate.original_info === 'object'
      ? (candidate.original_info as Record<string, unknown>)
      : null;

  const type =
    typeof candidate.type === 'string' && candidate.type.length > 0
      ? candidate.type
      : fallbackType ?? 'photo';

  return {
    type,
    url: candidate[url] as string,
    width: toOptionalNumber(candidate.width) ?? toOptionalNumber(originalInfo?.width),
    height: toOptionalNumber(candidate.height) ?? toOptionalNumber(originalInfo?.height),
  };
}

function normalizeTwitterApiMedia(media: unknown, extendedMedia?: unknown[]): MediaAsset[] {
  const normalized: MediaAsset[] = [];

  const pushItems = (items: unknown[], fallbackType?: string) => {
    for (const item of items) {
      const normalizedItem = normalizeMediaItem(item, fallbackType);
      if (normalizedItem) normalized.push(normalizedItem);
    }
  };

  if (Array.isArray(media)) {
    pushItems(media);
    return normalized;
  }

  if (media && typeof media === 'object') {
    const candidate = media as Record<string, unknown>;

    if (Array.isArray(candidate.photos)) pushItems(candidate.photos, 'photo');
    if (Array.isArray(candidate.videos)) pushItems(candidate.videos, 'video');
    if (Array.isArray(candidate.animated_gifs)) pushItems(candidate.animated_gifs, 'animated_gif');
    if (Array.isArray(candidate.gifs)) pushItems(candidate.gifs, 'animated_gif');
    if (Array.isArray(candidate.media)) pushItems(candidate.media);
  }

  if (normalized.length === 0 && Array.isArray(extendedMedia)) {
    pushItems(extendedMedia);
  }

  return normalized;
}

function stripHtml(value: string): string {
  return value.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

const AIHOT_ORIGINAL_LINK_RE = /<a\b[^>]*\bhref="([^"]+)"[^>]*>\s*阅读原文\s*<\/a>/i;

export function extractAihotOriginalUrl(descriptionHtml: string): string | null {
  const match = descriptionHtml.match(AIHOT_ORIGINAL_LINK_RE);
  return match?.[1] ? match[1].trim() : null;
}

export function stripAihotSummaryText(descriptionHtml: string): string {
  const blocks = Array.from(
    descriptionHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi),
  ).map((match) => match[1] ?? '');
  const kept = blocks.filter((block) => !/阅读原文|via\s+AI\s+HOT/i.test(block));
  return stripHtml(kept.join(' ')).trim();
}

export function parseAihotAuthorLabel(authorField: string): { name: string; username?: string } {
  const parenthesized = authorField.match(/^[^()]*\(([\s\S]*)\)\s*$/);
  let label = (parenthesized?.[1] ?? authorField).trim();
  label = label.replace(/\s*[（(]\s*RSS\s*[)）]\s*$/i, '').trim();

  const handleMatch = label.match(/@([A-Za-z0-9_]+)/);
  const username = handleMatch?.[1];
  const name = label.replace(/\s*[（(]@[A-Za-z0-9_]+[)）]\s*$/, '').trim() || label;

  return username ? { name, username } : { name };
}

export interface AihotRawItem {
  guid: string;
  title: string;
  descriptionHtml: string;
  publishedAt: string;
  authorField: string;
}

export function parseAihotFeed(xml: string): AihotRawItem[] {
  const channelMatch = xml.match(/<channel>([\s\S]*?)<\/channel>/i);
  if (!channelMatch?.[1]) return [];

  const channel = channelMatch[1];
  return Array.from(channel.matchAll(/<item>([\s\S]*?)<\/item>/gi)).flatMap((match) => {
    const block = match[1] ?? '';
    const guid = cleanXmlText(extractXmlTag(block, 'guid'));
    const title = cleanXmlText(extractXmlTag(block, 'title'));
    if (!guid || !title) return [];
    return [
      {
        guid,
        title,
        descriptionHtml: cleanXmlText(extractXmlTag(block, 'description')),
        publishedAt: cleanXmlText(extractXmlTag(block, 'pubDate')),
        authorField: cleanXmlText(extractXmlTag(block, 'author')),
      },
    ];
  });
}

function mapAihotItem(raw: AihotRawItem): CollectedItem | null {
  const originalUrl = extractAihotOriginalUrl(raw.descriptionHtml);
  if (!originalUrl) return null;

  let normalized: string | null = null;
  try {
    const parsed = new URL(originalUrl);
    normalized = isTwitterDomain(parsed.hostname)
      ? (normalizeTwitterStatusUrl(originalUrl) ?? normalizeExternalUrl(originalUrl))
      : normalizeExternalUrl(originalUrl);
  } catch {
    normalized = null;
  }
  if (!normalized) return null;

  const { name, username } = parseAihotAuthorLabel(raw.authorField);
  const parsedDate = Date.parse(raw.publishedAt);
  const publishedAt = Number.isFinite(parsedDate)
    ? new Date(parsedDate).toISOString()
    : raw.publishedAt;

  return {
    id: raw.guid,
    source: 'aihot',
    url: normalized,
    originUrl: normalized,
    title: raw.title,
    text: stripAihotSummaryText(raw.descriptionHtml),
    author: username ? { name, username } : { name },
    sourceLabel: name,
    publishedAt,
    media: [],
  };
}

interface CollectAihotItemsOptions {
  sinceTime: number;
  feedUrl?: string;
  maxItems?: number;
  deps?: { fetchFeed?: (url: string) => Promise<string> };
}

export async function collectAihotItems({
  sinceTime,
  feedUrl,
  maxItems = DEFAULT_AIHOT_MAX_ITEMS,
  deps,
}: CollectAihotItemsOptions): Promise<CollectedItem[]> {
  const url = (feedUrl ?? process.env.AIHOT_FEED_URL ?? DEFAULT_AIHOT_FEED_URL).trim();
  if (!url) return [];

  const fetchFeed = deps?.fetchFeed ?? fetchAihotFeed;
  console.log(
    `[collect] 采集 AI HOT feed，sinceTime=${new Date(sinceTime * 1000).toLocaleString('zh-CN')} url=${url}`,
  );

  let xml: string;
  try {
    xml = await fetchFeed(url);
  } catch (error) {
    console.warn(`[collect] AI HOT feed 抓取失败: ${summarizeError(error)}`);
    return [];
  }

  const rawItems = parseAihotFeed(xml);
  const mapped: CollectedItem[] = [];
  let dropped = 0;
  for (const raw of rawItems) {
    const item = mapAihotItem(raw);
    if (item) mapped.push(item);
    else dropped += 1;
  }

  const filtered = filterSinceTime(mapped, sinceTime);
  const result = sortNewestFirst(filtered).slice(0, maxItems);
  console.log(
    `[collect] AI HOT 完成，解析 ${rawItems.length} 条，丢弃 ${dropped} 条无原始来源，时间窗内 ${filtered.length} 条，取 ${result.length} 条`,
  );
  return result;
}

async function fetchAihotFeed(url: string): Promise<string> {
  const proxy = resolveHttpProxy();
  const args = buildSubstackCurlArgs(url, proxy);
  logCollectDiagnostic(
    `aihot proxy=${proxy ? redactProxyValue(proxy) : 'disabled'} command=curl ${redactCurlArgs(args).join(' ')}`,
  );
  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    logCollectDiagnostic(`aihot error=${summarizeDiagnosticError(error)}`);
    throw error;
  }
}

function resolveSubstackBody(post: SubstackPostLike): string {
  if (typeof post.body === 'string' && post.body.trim().length > 0) return post.body.trim();
  if (typeof post.markdown === 'string' && post.markdown.trim().length > 0) return post.markdown.trim();
  if (typeof post.htmlBody === 'string' && post.htmlBody.trim().length > 0) {
    return stripHtml(post.htmlBody);
  }
  return '';
}

function resolveSubstackText(post: SubstackPostLike, body: string): string {
  if (typeof post.truncatedBody === 'string' && post.truncatedBody.trim().length > 0) {
    return post.truncatedBody.trim();
  }
  if (typeof post.subtitle === 'string' && post.subtitle.trim().length > 0) {
    return post.subtitle.trim();
  }
  return body;
}

function resolveSubstackDate(value: Date | string): string {
  if (value instanceof Date) return value.toISOString();
  return new Date(value).toISOString();
}

function resolveSubstackHandle(publication: SubstackPublicationLike): string | undefined {
  return publication.handle ?? publication.slug;
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#x?[0-9a-fA-F]+|amp|lt|gt|quot|apos);/g, (_match, entity: string) => {
    switch (entity) {
      case 'amp':
        return '&';
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default:
        if (entity.startsWith('#x')) {
          return String.fromCodePoint(Number.parseInt(entity.slice(2), 16));
        }
        if (entity.startsWith('#')) {
          return String.fromCodePoint(Number.parseInt(entity.slice(1), 10));
        }
        return '';
    }
  });
}

function cleanXmlText(value: string | undefined): string {
  if (!value) return '';
  const withoutCdata = value.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '');
  return decodeHtmlEntities(withoutCdata).trim();
}

function extractXmlTag(block: string, tagName: string): string | undefined {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escapedTag}\\b[^>]*>([\\s\\S]*?)</${escapedTag}>`, 'i'));
  return match?.[1];
}

function extractXmlAttribute(block: string, tagName: string, attributeName: string): string | undefined {
  const escapedTag = tagName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const escapedAttr = attributeName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = block.match(new RegExp(`<${escapedTag}\\b[^>]*\\b${escapedAttr}="([^"]+)"`, 'i'));
  return match?.[1];
}

function decodeEmbeddedJsonString(value: string): string {
  return JSON.parse(`"${value}"`);
}

function parsePublicationUrl(publicationUrl: string): URL {
  try {
    return new URL(publicationUrl);
  } catch {
    throw new Error(`SUBSTACK_PUBLICATION_URL 无效: ${publicationUrl}`);
  }
}

function normalizePublicationUrl(publicationUrl: string): string {
  const parsed = parsePublicationUrl(publicationUrl);
  parsed.hash = '';
  parsed.search = '';
  const normalized = parsed.toString();
  return normalized.endsWith('/') ? normalized.slice(0, -1) : normalized;
}

export function mergeConfiguredSubstackPublications(
  publications: Array<Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>>,
): Array<Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>> & { roundupMode?: RoundupMode }> {
  const byUrl = new Map<string, Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>> & {
    roundupMode?: RoundupMode;
  }>();

  for (const publication of CONFIGURED_SUBSTACK_PUBLICATIONS) {
    byUrl.set(normalizePublicationUrl(publication.url), { ...publication });
  }

  for (const publication of publications) {
    const key = normalizePublicationUrl(publication.url);
    const configured = byUrl.get(key);
    byUrl.set(key, configured ? { ...publication, roundupMode: configured.roundupMode } : publication);
  }

  return Array.from(byUrl.values());
}

function deriveSubstackProfileHandle(publicationUrl: string): string {
  const url = parsePublicationUrl(publicationUrl);
  const match = url.hostname.match(/^([^.]+)\.substack\.com$/i);

  if (!match?.[1]) {
    throw new Error('SUBSTACK_PUBLICATION_URL 必须是形如 https://<handle>.substack.com 的地址');
  }

  return match[1];
}

export function parsePublicSubstackSubscriptions(
  html: string,
): Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>[] {
  const preloadMatch = html.match(/window\._preloads\s*=\s*JSON\.parse\("([\s\S]*?)"\)<\/script>/);
  if (!preloadMatch?.[1]) {
    throw new Error('未找到 Substack profile 预加载数据');
  }

  const decoded = decodeEmbeddedJsonString(preloadMatch[1]);
  const parsed = JSON.parse(decoded) as {
    profile?: {
      subscriptions?: Array<{
        publication?: {
          name?: string;
          subdomain?: string;
          custom_domain?: string | null;
        };
      }>;
    };
  };

  const results: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>[] = [];
  const seen = new Set<string>();

  for (const item of parsed.profile?.subscriptions ?? []) {
    const name = item.publication?.name?.trim();
    const subdomain = item.publication?.subdomain?.trim();
    const customDomain = item.publication?.custom_domain?.trim();
    if (!name || !subdomain) continue;

    const url = customDomain ? `https://${customDomain}` : `https://${subdomain}.substack.com`;
    if (seen.has(url)) continue;
    seen.add(url);

    results.push({
      name,
      handle: subdomain,
      slug: subdomain,
      url,
    });
  }

  return results;
}

export function parseSubstackFeed(xml: string): PublicSubstackFeed {
  const channelMatch = xml.match(/<channel>([\s\S]*?)<\/channel>/i);
  if (!channelMatch?.[1]) {
    throw new Error('Substack feed 缺少 channel 节点');
  }

  const channel = channelMatch[1];
  const publicationUrl = cleanXmlText(extractXmlTag(channel, 'link'));
  const publicationName = cleanXmlText(extractXmlTag(channel, 'title'));
  const parsedUrl = parsePublicationUrl(publicationUrl);
  const handleMatch = parsedUrl.hostname.match(/^([^.]+)\.substack\.com$/i);
  const fallbackHandle = handleMatch?.[1] ?? parsedUrl.hostname;
  const itemMatches = Array.from(channel.matchAll(/<item>([\s\S]*?)<\/item>/gi));

  return {
    publication: {
      name: publicationName,
      handle: fallbackHandle,
      slug: fallbackHandle,
      url: publicationUrl,
    },
    posts: itemMatches.flatMap((match) => {
      const block = match[1];
      const url = cleanXmlText(extractXmlTag(block, 'link'));
      const title = cleanXmlText(extractXmlTag(block, 'title'));
      if (!url || !title) return [];

      const description = cleanXmlText(extractXmlTag(block, 'description'));
      const htmlBody = cleanXmlText(extractXmlTag(block, 'content:encoded'));
      const content = stripHtml(htmlBody);
      const publishedAt = new Date(cleanXmlText(extractXmlTag(block, 'pubDate'))).toISOString();
      const coverImage = extractXmlAttribute(block, 'enclosure', 'url');

      return [
        {
          id: url,
          title,
          subtitle: description || null,
          body: content,
          htmlBody: htmlBody || undefined,
          truncatedBody: description || content,
          publishedAt,
          url,
          coverImage,
        },
      ];
    }),
  };
}

function normalizeRoundupSectionLabel(value: string): string {
  return stripHtml(value)
    .replace(/^[^A-Za-z0-9]+/, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function slugifyRoundupSection(value: string): string {
  return normalizeRoundupSectionLabel(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractRoundupAnchors(html: string): Array<{ href: string; text: string }> {
  return Array.from(html.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi)).flatMap((match) => {
    const href = match[1]?.trim();
    const text = stripHtml(match[2] ?? '').trim();
    return href ? [{ href, text }] : [];
  });
}

function isSkippableRoundupSection(sectionLabel: string): boolean {
  const normalized = sectionLabel.trim().toLowerCase();
  return [
    'sponsor',
    'sponsored',
    'ready for more',
    'advertise',
    'partner',
    'job board',
  ].some((keyword) => normalized.includes(keyword));
}

function isInternalRoundupUrl(raw: string, publicationUrl: string): boolean {
  try {
    const url = new URL(raw);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return true;

    const publicationHost = new URL(publicationUrl).hostname.replace(/^www\./i, '').toLowerCase();
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    if (host === publicationHost) return true;

    const path = `${url.pathname}${url.search}`.toLowerCase();
    if (/(?:^|\/)(chat|subscribe|podcast|advertise|media-kit)(?:\/|$)/.test(path)) {
      return true;
    }

    return false;
  } catch {
    return true;
  }
}

function resolveRoundupEntryTitle(
  anchors: Array<{ href: string; text: string }>,
  bulletText: string,
  publicationUrl: string,
): string {
  const externalAnchor = anchors.find((anchor) => anchor.text && !isInternalRoundupUrl(anchor.href, publicationUrl));
  if (externalAnchor?.text) return externalAnchor.text;

  const leading = bulletText.split(/\s+-\s+|:\s+/)[0]?.trim();
  return leading && leading.length > 0 ? leading : bulletText.slice(0, 120).trim();
}

function resolveRoundupEntrySourceLabel(anchor: { href: string; text: string }): string {
  const label = anchor.text.trim();
  if (label) return label;

  try {
    return normalizeDomain(new URL(anchor.href).hostname);
  } catch {
    return anchor.href;
  }
}

export function extractSubstackRoundupEntries(parent: CollectedItem): CollectedItem[] {
  if (
    parent.source !== 'substack' ||
    parent.kind !== 'substack_post' ||
    parent.publication?.roundupMode !== 'bullet_links'
  ) {
    return [];
  }

  const html = parent.htmlBody?.trim();
  if (!html) return [];

  const sections = Array.from(
    html.matchAll(/<h[1-6]\b[^>]*>([\s\S]*?)<\/h[1-6]>([\s\S]*?)(?=<h[1-6]\b[^>]*>|$)/gi),
  );
  const items: CollectedItem[] = [];

  for (const [, headingHtml, sectionHtml] of sections) {
    const sectionLabel = normalizeRoundupSectionLabel(headingHtml);
    if (!sectionLabel || isSkippableRoundupSection(sectionLabel)) continue;

    const listItems = Array.from(sectionHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi));
    if (listItems.length === 0) continue;

    let sectionIndex = 0;
    for (const [, listItemHtml] of listItems) {
      const anchors = extractRoundupAnchors(listItemHtml);
      const externalAnchor = anchors.find((anchor) => !isInternalRoundupUrl(anchor.href, parent.publication?.url ?? parent.url));
      if (!externalAnchor?.href) continue;

      const bulletText = stripHtml(listItemHtml).replace(/\s+/g, ' ').trim();
      if (!bulletText) continue;

      sectionIndex += 1;
      items.push({
        id: `${parent.id}-roundup-${slugifyRoundupSection(sectionLabel)}-${sectionIndex}`,
        source: 'substack',
        kind: 'substack_roundup_entry',
        title: resolveRoundupEntryTitle(anchors, bulletText, parent.publication?.url ?? parent.url),
        text: bulletText,
        url: externalAnchor.href,
        originUrl: parent.url,
        parentItemId: parent.id,
        sectionLabel,
        publishedAt: parent.publishedAt,
        author: { ...parent.author },
        publication: parent.publication ? { ...parent.publication } : undefined,
        sourceLabel: resolveRoundupEntrySourceLabel(externalAnchor),
        media: [],
        forceSelect: true,
      });
    }
  }

  return items;
}

async function expandSubstackRoundupItems(
  items: CollectedItem[],
  fetchPostHtml: (url: string) => Promise<string> = fetchSubstackText,
): Promise<CollectedItem[]> {
  const expanded: CollectedItem[] = [];

  for (const item of items) {
    expanded.push(item);
    if (item.source !== 'substack' || item.kind !== 'substack_post' || item.publication?.roundupMode !== 'bullet_links') {
      continue;
    }

    let children = extractSubstackRoundupEntries(item);
    if (children.length === 0 && !item.htmlBody) {
      try {
        const htmlBody = await fetchPostHtml(item.url);
        children = extractSubstackRoundupEntries({ ...item, htmlBody });
      } catch (error) {
        console.warn(`[collect] Ben's Bites roundup fallback 抓取失败 ${item.url}: ${summarizeError(error)}`);
      }
    }

    expanded.push(...children);
  }

  return expanded;
}

function resolveFullSubstackPost(preview: SubstackPreviewLike | SubstackPostLike): Promise<SubstackPostLike> {
  if (typeof (preview as SubstackPreviewLike).fullPost === 'function') {
    return (preview as SubstackPreviewLike).fullPost!();
  }

  return Promise.resolve(preview as SubstackPostLike);
}

function readProxyEnvValue(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function resolveHttpProxy(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return readProxyEnvValue(env.HTTP_PROXY) ?? readProxyEnvValue(env.http_proxy);
}

function resolveTwitterListId(env: NodeJS.ProcessEnv = process.env): string {
  return env.TWITTER_LIST_ID?.trim() || DEFAULT_TWITTER_LIST_ID;
}

export function buildSubstackCurlArgs(url: string, proxy: string | undefined): string[] {
  return [
    '-fsSL',
    '--compressed',
    '--connect-timeout',
    '10',
    '--max-time',
    '20',
    ...(proxy ? ['--proxy', proxy] : []),
    '-H',
    'Accept: text/html,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    url,
  ];
}

export function buildTwitterCliCommand(listId: string, maxTweets: number, proxy: string | undefined): string {
  const proxyPrefix = buildTwitterCliEnvPrefix(proxy);
  return `${proxyPrefix}twitter list ${listId} --max ${maxTweets} --json`;
}

export function buildTwitterFeedCommand(
  feedType: 'for-you' | 'following',
  maxTweets: number,
  proxy: string | undefined,
  auth?: TwitterRecommendationAuth,
): string {
  const proxyPrefix = buildTwitterCliEnvPrefix(proxy);
  const authPrefix = auth ? `TWITTER_AUTH_TOKEN=${auth.authToken} TWITTER_CT0=${auth.ct0} ` : '';
  return `${proxyPrefix}${authPrefix}twitter feed --type ${feedType} --max ${maxTweets} --json`;
}

function buildTwitterReplyCommand(tweetId: string, maxReplies: number, proxy: string | undefined): string {
  const proxyPrefix = buildTwitterCliEnvPrefix(proxy);
  return `${proxyPrefix}twitter tweet ${tweetId} --max ${maxReplies} --json`;
}

function buildTwitterCliEnvPrefix(proxy: string | undefined): string {
  if (!proxy) return '';
  return `TWITTER_PROXY=${proxy} HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} `;
}

function shouldLogCollectDiagnostics(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.DAILY_NEWS_ENV_DIAGNOSTICS?.trim().toLowerCase();
  return value === '1' || value === 'true';
}

function writeCollectDiagnostic(log: (message: string) => void, message: string): void {
  log(`[collect:diagnostics] ${message}`);
}

function logCollectDiagnostic(message: string): void {
  if (shouldLogCollectDiagnostics()) {
    writeCollectDiagnostic(console.log, message);
  }
}

function firstDiagnosticLine(value: string): string {
  return value
    .split('\n')
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? 'unknown error';
}

function summarizeDiagnosticError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return firstDiagnosticLine(message);
}

function redactProxyValue(value: string): string {
  return value.replace(/\/\/([^/@:\s]+)(?::([^/@\s]*))?@/, '//***:***@');
}

export function redactCollectDiagnosticCommand(command: string): string {
  return command
    .replace(
      /\b(TWITTER_PROXY|HTTP_PROXY|HTTPS_PROXY|http_proxy|https_proxy|ALL_PROXY|all_proxy)=([^\s]+)/g,
      (_match, key: string, value: string) => `${key}=${redactProxyValue(value)}`,
    )
    .replace(/\b(TWITTER_AUTH_TOKEN|TWITTER_CT0)=([^\s]+)/g, (_match, key: string) => `${key}=<redacted>`);
}

function redactCurlArgs(args: string[]): string[] {
  return args.map((arg, index) => (args[index - 1] === '--proxy' ? redactProxyValue(arg) : arg));
}

function buildProxyCheckCurlArgs(proxy: string | undefined): string[] {
  return [
    '-fsSL',
    '--compressed',
    '--connect-timeout',
    '10',
    '--max-time',
    '20',
    ...(proxy ? ['--proxy', proxy] : []),
    '-o',
    '/dev/null',
    'https://example.com',
  ];
}

function buildGenericCurlArgs(url: string, proxy: string | undefined): string[] {
  return [
    '-fsSL',
    '--compressed',
    '--connect-timeout',
    '10',
    '--max-time',
    '20',
    ...(proxy ? ['--proxy', proxy] : []),
    '-H',
    'Accept: text/html,text/plain;q=0.9,*/*;q=0.8',
    url,
  ];
}

function summarizeErrorText(text: string): string | undefined {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return undefined;

  const preferred = lines.find((line) => !/^Command failed(?::|\s)/.test(line));
  return preferred ?? lines[0];
}

function summarizeError(error: unknown): string {
  if (error instanceof Error) {
    const stderrLine = summarizeErrorText((error as Error & { stderr?: string }).stderr ?? '');
    if (stderrLine) return stderrLine;

    const messageLine = summarizeErrorText(error.message);
    return messageLine || error.name;
  }

  return String(error);
}

function extractTwitterCliErrorMessage(stdout: string): string | undefined {
  if (!stdout.trim()) return undefined;

  try {
    const payload = JSON.parse(stdout) as {
      error?: string | { message?: string };
      message?: string;
    };

    if (typeof payload?.error === 'string' && payload.error.trim()) {
      return payload.error.trim();
    }

    if (
      payload?.error &&
      typeof payload.error === 'object' &&
      typeof payload.error.message === 'string' &&
      payload.error.message.trim()
    ) {
      return payload.error.message.trim();
    }

    if (typeof payload?.message === 'string' && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function extractTwitterCliTracebackMessage(stderr: string): string | undefined {
  const lines = stderr
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (!lines.some((line) => line.startsWith('Traceback '))) return undefined;

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index];
    if (/^[A-Za-z_][A-Za-z0-9_.]*(?:Error|Exception):\s+/.test(line)) {
      return line;
    }
  }

  return undefined;
}

export function summarizeTwitterCliError(error: unknown): string {
  if (error instanceof Error) {
    const stdoutMessage = extractTwitterCliErrorMessage((error as Error & { stdout?: string }).stdout ?? '');
    if (stdoutMessage) return stdoutMessage;

    const tracebackMessage = extractTwitterCliTracebackMessage((error as Error & { stderr?: string }).stderr ?? '');
    if (tracebackMessage) return tracebackMessage;
  }

  return summarizeError(error);
}

function isTwitterCliQueryUnspecifiedError(message: string): boolean {
  return /Twitter API returned errors:\s*Query:\s*Unspecified/i.test(message);
}

function isTwitterCliRecommendationFallbackError(message: string): boolean {
  return (
    isTwitterCliQueryUnspecifiedError(message)
    // DeadlineExceeded 是 X for-you 推荐后端的瞬态处理超期（服务端返回的错误，非客户端超时），
    // 与 Timeout/Query Unspecified 同属可重试的瞬态错误，走降级重试而非直接中断整批采集。
    || /Twitter API returned errors:\s*(?:Timeout|DeadlineExceeded):\s*Unspecified/i.test(message)
  );
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function randomDelayMs(minMs: number, maxMs: number, random: () => number): number {
  const min = Math.max(0, Math.floor(minMs));
  const max = Math.max(min, Math.floor(maxMs));
  if (max === min) return min;
  return min + Math.floor(random() * (max - min + 1));
}

async function execTwitterCliCommand(command: string, maxBuffer: number): Promise<{ stdout: string; stderr: string }> {
  try {
    return await execAsync(command, { maxBuffer });
  } catch (error) {
    throw new Error(summarizeTwitterCliError(error), { cause: error instanceof Error ? error : undefined });
  }
}

async function defaultFetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`CDP 请求失败: ${response.status} ${response.statusText}`);
  }
  return response.json();
}

async function sendCdpCommand(webSocketUrl: string, method: string): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(webSocketUrl);
    const requestId = 1;
    const timer = setTimeout(() => {
      socket.close();
      reject(new Error(`CDP ${method} 超时`));
    }, 5000);

    socket.on('open', () => {
      socket.send(JSON.stringify({ id: requestId, method }));
    });

    socket.on('message', (raw) => {
      let message: { id?: number; result?: unknown; error?: { message?: string } };
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        clearTimeout(timer);
        socket.close();
        reject(error);
        return;
      }

      if (message.id !== requestId) return;
      clearTimeout(timer);
      socket.close();

      if (message.error) {
        reject(new Error(message.error.message ?? `CDP ${method} failed`));
        return;
      }

      resolve(message.result);
    });

    socket.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function isTwitterCookieDomain(domain: string | undefined): boolean {
  const normalized = domain?.trim().replace(/^\./, '').toLowerCase();
  return Boolean(
    normalized &&
      (normalized === 'x.com' ||
        normalized === 'twitter.com' ||
        normalized.endsWith('.x.com') ||
        normalized.endsWith('.twitter.com')),
  );
}

function extractTwitterRecommendationAuth(cookies: CdpCookie[]): TwitterRecommendationAuth | null {
  const authToken = cookies.find((cookie) => cookie.name === 'auth_token' && isTwitterCookieDomain(cookie.domain))?.value;
  const ct0 = cookies.find((cookie) => cookie.name === 'ct0' && isTwitterCookieDomain(cookie.domain))?.value;

  return authToken && ct0 ? { authToken, ct0 } : null;
}

async function fetchAuthFromCdpTarget(
  webSocketUrl: string | undefined,
  sendCommand: (webSocketUrl: string, method: string) => Promise<unknown>,
): Promise<TwitterRecommendationAuth | null> {
  if (!webSocketUrl) return null;
  for (const method of ['Network.getAllCookies', 'Storage.getCookies']) {
    try {
      const rawCookies = await sendCommand(webSocketUrl, method);
      const cookies = rawCookies && typeof rawCookies === 'object'
        ? (rawCookies as CdpCookieResponse).cookies
        : undefined;
      const auth = Array.isArray(cookies) ? extractTwitterRecommendationAuth(cookies) : null;
      if (auth) return auth;
    } catch {
      // Browser targets expose Storage.getCookies, while page targets may expose Network.getAllCookies.
    }
  }
  return null;
}

function isXPageTarget(target: CdpTarget): boolean {
  if (target.type !== 'page') return false;
  try {
    const url = new URL(target.url ?? '');
    const host = url.hostname.replace(/^www\./, '').toLowerCase();
    return host === 'x.com' || host === 'twitter.com';
  } catch {
    return false;
  }
}

export async function fetchTwitterRecommendationAuthFromCdp({
  endpoint = DEFAULT_TWITTER_RECOMMENDATION_CDP_ENDPOINT,
  fetchJson = defaultFetchJson,
  sendCdpCommand: sendCommand = sendCdpCommand,
}: FetchTwitterRecommendationAuthFromCdpOptions = {}): Promise<TwitterRecommendationAuth | null> {
  try {
    const normalizedEndpoint = endpoint.replace(/\/+$/, '');
    const version = await fetchJson(`${normalizedEndpoint}/json/version`);
    const webSocketUrl =
      version && typeof version === 'object'
        ? (version as { webSocketDebuggerUrl?: string }).webSocketDebuggerUrl
        : undefined;
    let browserAuth: TwitterRecommendationAuth | null = null;
    try {
      browserAuth = await fetchAuthFromCdpTarget(webSocketUrl, sendCommand);
    } catch {
      browserAuth = null;
    }
    if (browserAuth) return browserAuth;

    const targets = await fetchJson(`${normalizedEndpoint}/json/list`);
    if (!Array.isArray(targets)) return null;

    for (const target of targets) {
      if (!target || typeof target !== 'object' || !isXPageTarget(target as CdpTarget)) continue;
      let pageAuth: TwitterRecommendationAuth | null = null;
      try {
        pageAuth = await fetchAuthFromCdpTarget((target as CdpTarget).webSocketDebuggerUrl, sendCommand);
      } catch {
        pageAuth = null;
      }
      if (pageAuth) return pageAuth;
    }

    return null;
  } catch {
    return null;
  }
}

async function chooseRecommendationLoginRetry(): Promise<boolean> {
  if (!process.stdin.isTTY || !process.stdout.isTTY) return false;

  const shouldRetry = await confirm({
    message: '未检测到 CDP 浏览器中的 X 推荐流账号登录。是否现在登录后重试推荐流采集？',
    default: false,
  });
  if (!shouldRetry) return false;

  await input({
    message: '请在 9222 端口的 CDP Chrome 中完成 X 登录，然后按回车重试推荐流采集。',
  });
  return true;
}

function stripJsonFences(raw: string): string {
  return raw.replace(/^```(?:json)?\s*/m, '').replace(/\s*```\s*$/m, '').trim();
}

function buildRecommendationTopicGateCandidates(items: CollectedItem[]): RecommendationTopicGateCandidate[] {
  return items.map((item) => ({
    id: item.id,
    author: item.author.name,
    username: item.author.username,
    url: item.originUrl ?? item.url,
    textPreview: item.text.slice(0, 500),
  }));
}

function parseRecommendationTopicGateResponse(raw: string, knownIds: Set<string>): Set<string> {
  const parsed = JSON.parse(stripJsonFences(raw)) as {
    items?: Array<{ id?: unknown; isAiRelated?: unknown }>;
  };
  const items = Array.isArray(parsed.items) ? parsed.items : [];
  return new Set(
    items.flatMap((item) =>
      typeof item.id === 'string' && knownIds.has(item.id) && item.isAiRelated === true
        ? [item.id]
        : [],
    ),
  );
}

export function buildRecommendationTopicGatePrompt(
  candidates: RecommendationTopicGateCandidate[],
  preferenceRules: ConfirmedPreferenceRules = normalizeConfirmedPreferenceRules(null),
): { systemPrompt: string; userContent: string } {
  const normalizedCandidates = candidates.map((candidate) => ({
    ...candidate,
    textPreview: candidate.textPreview.slice(0, 500),
  }));
  const preferenceLines = formatPreferenceHintsForPrompt(preferenceRules);
  const systemPrompt = [
    'You classify X recommendation posts for an AI daily news pipeline.',
    'Return strict JSON only.',
    'The top-level object must contain exactly one field named items.',
    'Each item must include id, isAiRelated, and reason.',
    'Mark true only for AI models, AI products, agents, developer tools for AI, ML research, AI infrastructure, benchmarks, or AI industry structure.',
    'Mark false for general tech, generic productivity, mobile apps, jokes, hiring, or vague commentary without AI relevance.',
    ...preferenceLines,
  ].join(' ');
  const userContent = [
    'Classify whether each X recommendation post is AI-related enough to enter an AI daily-news pipeline.',
    'Only use the provided 500-character preview. Do not infer beyond it.',
    '',
    JSON.stringify({ items: normalizedCandidates }, null, 2),
  ].join('\n');
  return { systemPrompt, userContent };
}

async function generateRecommendationTopicGateJson(candidates: RecommendationTopicGateCandidate[]): Promise<string> {
  const model =
    process.env.TWITTER_RECOMMENDATION_FILTER_MODEL ??
    (process.env.OPENAI_API_KEY
      ? DEFAULT_TWITTER_RECOMMENDATION_FILTER_MODEL
      : process.env.AI_MODEL ?? DEFAULT_TWITTER_RECOMMENDATION_FILTER_MODEL);
  const { systemPrompt, userContent } = buildRecommendationTopicGatePrompt(candidates, readConfirmedPreferenceRules());

  if (process.env.OPENAI_API_KEY) {
    const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      response_format: { type: 'json_object' },
    });
    const content = response.choices[0]?.message?.content;
    return typeof content === 'string' ? content : '';
  }

  if (process.env.AI_BASE_URL && process.env.AI_API_KEY) {
    const openai = createOpenAI({
      baseURL: process.env.AI_BASE_URL,
      apiKey: process.env.AI_API_KEY,
    });
    const result = await generateText({
      model: openai(model),
      system: systemPrompt,
      prompt: userContent,
    });
    return result.text;
  }

  throw new Error('AI 配置缺失：请在 .env 中设置 OPENAI_API_KEY，或同时设置 AI_BASE_URL 和 AI_API_KEY');
}

async function runRecommendationTopicGate(candidates: RecommendationTopicGateCandidate[]): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const raw = await generateRecommendationTopicGateJson(candidates);
  return parseRecommendationTopicGateResponse(raw, new Set(candidates.map((item) => item.id)));
}

function isRecommendationTopicGateConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  return Boolean(env.OPENAI_API_KEY) || Boolean(env.AI_BASE_URL && env.AI_API_KEY);
}

export async function filterAiRelatedRecommendationItems(
  items: CollectedItem[],
  topicGate: RecommendationTopicGate = runRecommendationTopicGate,
  warn: (message: string) => void = console.warn,
): Promise<SourceCollectionResult> {
  if (items.length === 0) return { items: [] };

  // Skill / agent 路径刻意不配置外部 AI 接口（策展由 agent 完成）。此时默认的 LLM 预筛门不可用：
  // 与其 fail-closed 把整批推荐流清零，不如直接放行，把 AI 相关性判断交还给策展阶段的 agent（fail-open）。
  // 仅对默认门生效；显式注入的自定义门（如测试）照常执行。
  if (topicGate === runRecommendationTopicGate && !isRecommendationTopicGateConfigured()) {
    const warning = '未配置 AI 接口，已跳过推荐流 AI 预筛，相关性判断交由策展阶段';
    warn(`[collect] ${warning}`);
    return { items, warnings: [warning] };
  }

  const candidates = buildRecommendationTopicGateCandidates(items);

  try {
    const acceptedIds = await topicGate(candidates);
    return {
      items: items.filter((item) => acceptedIds.has(item.id)),
    };
  } catch (error) {
    const warning = `推荐流 AI 相关性预筛失败，已跳过推荐流: ${summarizeError(error)}`;
    warn(`[collect] ${warning}`);
    return { items: [], warnings: [warning] };
  }
}

function stripTrackingTitle(value: string): string {
  return value.replace(/\s*[|\-]\s*(twitter|x)\s*$/i, '').trim();
}

function decodeHtml(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function extractMetaTag(html: string, attr: string, value: string): string | undefined {
  const match = html.match(
    new RegExp(`<meta[^>]+${attr}=["']${value}["'][^>]+content=["']([^"']+)["']`, 'i'),
  );
  return match?.[1] ? decodeHtml(match[1]).trim() : undefined;
}

function extractTitle(html: string): string | undefined {
  const match = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return match?.[1] ? stripTrackingTitle(decodeHtml(match[1]).replace(/\s+/g, ' ').trim()) : undefined;
}

function extractMainText(html: string): string {
  const bodyMatch =
    html.match(/<article[^>]*>([\s\S]*?)<\/article>/i) ??
    html.match(/<main[^>]*>([\s\S]*?)<\/main>/i) ??
    html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);
  const body = bodyMatch?.[1] ?? html;
  return stripHtml(
    body
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' '),
  ).slice(0, 4000);
}

function resolveSourceLabel(linkedSource: LinkedSource): string {
  const preferred = linkedSource.title?.trim();
  if (preferred) return preferred;
  return linkedSource.domain;
}

function countSentences(text: string): number {
  return text.split(/[.!?。！？\n]+/).filter((part) => part.trim().length > 0).length;
}

function hasBulletLikeStructure(text: string): boolean {
  return /(^|\n)\s*(?:[-*•]|\d+\.)\s+/m.test(text);
}

const OVERLAP_STOPWORDS = new Set([
  'the',
  'and',
  'for',
  'with',
  'that',
  'this',
  'from',
  'into',
  'onto',
  'over',
  'under',
  'our',
  'your',
  'their',
  'they',
  'them',
  'have',
  'has',
  'had',
  'was',
  'were',
  'are',
  'but',
  'not',
  'one',
  'two',
  'three',
  'some',
  'more',
  'most',
  'here',
  'there',
  'about',
  'into',
  'than',
  'then',
  'what',
  'when',
  'where',
  'while',
]);

function tokenizeForOverlap(text: string): string[] {
  return normalizeText(text)
    .split(/[^a-z0-9\u4e00-\u9fff]+/i)
    .filter((token) => token.length >= 3 && !OVERLAP_STOPWORDS.has(token));
}

/** Fraction of tweet tokens that also appear in the linked page context. */
function overlapRatio(tweetText: string, pageContext: string): number {
  const tweetTokens = tokenizeForOverlap(tweetText);
  if (tweetTokens.length === 0) return 0;
  const pageTokenSet = new Set(tokenizeForOverlap(pageContext));
  if (pageTokenSet.size === 0) return 0;
  const shared = tweetTokens.filter((t) => pageTokenSet.has(t)).length;
  return shared / tweetTokens.length;
}

function looksLikeWrapperText(text: string): boolean {
  const normalized = normalizeText(text);
  const promoPhrases = [
    'details',
    'read more',
    'full post',
    'blog post',
    'docs',
    'documentation',
    'announcement',
    'announcing',
    'introducing',
    'launch',
    'launched',
    'release',
    'released',
    'available now',
    'more here',
    'link below',
    'see here',
    '发布',
    '详情',
    '文档',
    '博客',
    '全文',
    '链接',
    '更多信息',
  ];

  const hasPromoPhrase = promoPhrases.some((phrase) => normalized.includes(phrase));
  const shortEnough = normalized.length <= 280;
  return shortEnough && (hasPromoPhrase || countSentences(text) <= 2);
}

function hasLinkedSourceHandoffCue(text: string): boolean {
  const normalized = normalizeText(text);
  const handoffPhrases = [
    'sharing',
    'we’re sharing',
    "we're sharing",
    'shared',
    'report',
    'paper',
    'guide',
    'docs',
    'documentation',
    'announcement',
    'announcing',
    'launch post',
    'blog post',
    'read more',
    'full post',
    'see here',
    'more here',
    '发布',
    '报告',
    '论文',
    '文档',
    '博客',
    '全文',
    '详见',
    '更多信息',
  ];

  return handoffPhrases.some((phrase) => normalized.includes(phrase));
}

function shouldKeepOriginTweet(item: CollectedItem, linkedSource: LinkedSource): boolean {
  const text = item.text.trim();
  const pageContext = [linkedSource.title, linkedSource.description, linkedSource.excerpt]
    .filter(Boolean)
    .join(' ');

  // Explicit handoff cues ("we're sharing", "read more", "详见") are
  // strong signals that the tweet is a pointer, not original content.
  if (hasLinkedSourceHandoffCue(text)) return false;

  const ratio = overlapRatio(text, pageContext);

  // High overlap: tweet is mostly restating page content regardless of length.
  // For long tweets (≥4 sentences), even moderate overlap (≥0.15) suggests
  // retelling — a long tweet sharing domain vocabulary with the linked page
  // is likely summarizing it. Short tweets use a higher bar (≥0.4).
  const isLong = countSentences(text) >= 4;
  if ((!isLong && ratio >= 0.4) || (isLong && ratio >= 0.15)) return false;

  // Structural evidence: bullet points indicate original content.
  if (hasBulletLikeStructure(text)) return true;

  return !looksLikeWrapperText(text);
}

function buildResolveUrlCurlArgs(url: string, proxy: string | undefined): string[] {
  return [
    '-sSLI',
    '--connect-timeout',
    '10',
    '--max-time',
    '20',
    ...(proxy ? ['--proxy', proxy] : []),
    '-o',
    '/dev/null',
    '-w',
    '%{url_effective}',
    url,
  ];
}

function isTransientCurlError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  // curl exit code 28 = timeout, 35 = SSL connect error
  return /(?:exit code 2[89]|exit code 3[0-9]|SSL_ERROR|ECONNRESET|EPIPE)/i.test(msg);
}

interface TwitterEnrichmentCircuitBreaker {
  shouldSkip(): boolean;
  recordFailure(error: unknown): void;
}

interface CreateTwitterEnrichmentCircuitBreakerOptions {
  maxTransientFailures?: number;
}

function isTwitterRateLimitError(error: unknown): boolean {
  return /(?:HTTP 429|error 429|Rate limit exceeded|Too Many Requests)/i.test(summarizeError(error));
}

function isTwitterTransientEnrichmentError(error: unknown): boolean {
  return /(?:HTTP 0|network error|curl:\s*\(28\)|timed out|timeout|TLS connect|SSL connection timeout|SSL_ERROR)/i.test(
    summarizeError(error),
  );
}

export function createTwitterEnrichmentCircuitBreaker({
  maxTransientFailures = DEFAULT_TWITTER_ENRICHMENT_MAX_TRANSIENT_FAILURES,
}: CreateTwitterEnrichmentCircuitBreakerOptions = {}): TwitterEnrichmentCircuitBreaker {
  let rateLimited = false;
  let transientFailures = 0;

  return {
    shouldSkip() {
      return rateLimited || transientFailures >= maxTransientFailures;
    },
    recordFailure(error: unknown) {
      if (isTwitterRateLimitError(error)) {
        rateLimited = true;
        return;
      }

      if (isTwitterTransientEnrichmentError(error)) {
        transientFailures += 1;
      }
    },
  };
}

function createShortUrlResolver(): (url: string, retries?: number) => Promise<string | null> {
  const cache = new Map<string, string | null>();
  return async (url: string, retries = 2): Promise<string | null> => {
    if (cache.has(url)) return cache.get(url)!;
    const result = await resolveShortUrlUncached(url, retries);
    cache.set(url, result);
    return result;
  };
}

async function resolveShortUrlUncached(url: string, retries = 2): Promise<string | null> {
  const proxy = resolveHttpProxy();
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const { stdout } = await execFileAsync('curl', buildResolveUrlCurlArgs(url, proxy), {
        maxBuffer: 256 * 1024,
      });
      const resolved = stdout.trim();
      return resolved.length > 0 ? resolved : null;
    } catch (error) {
      if (attempt < retries && isTransientCurlError(error)) {
        await new Promise((r) => setTimeout(r, 1000 * (attempt + 1)));
        continue;
      }
      console.warn(`[collect] 跳过短链接解析 ${url}: ${summarizeError(error)}`);
      return null;
    }
  }
  return null;
}

const resolveShortUrl = resolveShortUrlUncached;

function isOwnTweetStatusUrl(
  item: Pick<CollectedItem, 'url' | 'originUrl'>,
  candidate: string | undefined,
): boolean {
  if (!candidate) return false;
  const normalized = normalizeTwitterStatusUrl(candidate);
  if (!normalized) return false;
  return normalized === normalizeTwitterStatusUrl(item.originUrl)
    || normalized === normalizeTwitterStatusUrl(item.url);
}

function quotedStatusUrlUnlessOwn(
  item: Pick<CollectedItem, 'url' | 'originUrl'>,
  ...candidates: Array<string | null | undefined>
): string | undefined {
  for (const url of candidates) {
    if (url && !isOwnTweetStatusUrl(item, url)) return url;
  }
  return undefined;
}

async function enrichTwitterTextCandidates(
  item: Pick<CollectedItem, 'text' | 'url' | 'originUrl' | 'outboundLinks' | 'embeddedLinkedSource' | 'quotedStatusUrl'>,
  resolveShortUrlImpl: (url: string) => Promise<string | null>,
): Promise<Pick<CollectedItem, 'outboundLinks' | 'embeddedLinkedSource' | 'quotedStatusUrl'>> {
  const outboundLinks = dedupeUrls(item.outboundLinks ?? []);
  let embeddedLinkedSource = item.embeddedLinkedSource;
  let quotedStatusUrl = quotedStatusUrlUnlessOwn(item, item.quotedStatusUrl);

  if (outboundLinks.length > 0 && embeddedLinkedSource && quotedStatusUrl) {
    return { outboundLinks, embeddedLinkedSource, quotedStatusUrl };
  }

  for (const rawUrl of extractRawUrlsFromText(item.text)) {
    let candidateUrl = rawUrl;

    try {
      const parsed = new URL(rawUrl);
      if (isTwitterShortener(parsed.hostname)) {
        const resolved = await resolveShortUrlImpl(rawUrl);
        if (!resolved) continue;
        candidateUrl = resolved;
      }
    } catch {
      continue;
    }

    const normalizedExternal = canonicalizePrimarySourceUrl(candidateUrl);
    if (normalizedExternal) {
      outboundLinks.push(normalizedExternal);
      continue;
    }

    if (!embeddedLinkedSource) {
      embeddedLinkedSource = buildEmbeddedLinkedSourceFromTwitterUrl(candidateUrl, {}, 'tweet');
    }

    if (!quotedStatusUrl) {
      quotedStatusUrl = quotedStatusUrlUnlessOwn(item, normalizeTwitterStatusUrl(candidateUrl));
    }
  }

  return {
    outboundLinks: dedupeUrls(outboundLinks),
    embeddedLinkedSource,
    quotedStatusUrl,
  };
}

// Minimum excerpt length (chars) to consider a linked page a substantial article.
const AUTHOR_REPLY_ARTICLE_MIN_LENGTH = 500;

async function findAuthorReplySource(
  item: CollectedItem,
  fetchReplies: (item: CollectedItem, maxReplies: number) => Promise<ReplyContext[]>,
  fetchPage: (url: string) => Promise<LinkedSource | null>,
  existingReplies?: ReplyContext[],
): Promise<LinkedSource | null> {
  const authorUsername = item.author.username?.toLowerCase();
  if (!authorUsername) return null;

  let replies: ReplyContext[];
  try {
    replies = existingReplies ?? (await fetchReplies(item, 3));
  } catch {
    return null;
  }

  // Find first reply by the same author
  const authorReply = replies.find(
    (reply) => reply.author.username?.toLowerCase() === authorUsername,
  );
  if (!authorReply?.outboundLinks?.length) return null;

  // Check each outbound link for substantial article content
  for (const link of authorReply.outboundLinks) {
    try {
      const linkedSource = await fetchPage(link);
      if (linkedSource && (linkedSource.excerpt?.length ?? 0) > AUTHOR_REPLY_ARTICLE_MIN_LENGTH) {
        return { ...linkedSource, via: 'reply' };
      }
    } catch {
      continue;
    }
  }

  return null;
}

export function resolveTwitterLinkedSource(
  item: CollectedItem,
  linkedSources: LinkedSource[],
): { linkedSource?: LinkedSource; sourceResolution: SourceResolution; sourceLabel?: string } {
  if (item.source !== 'twitter' || linkedSources.length === 0) {
    return { sourceResolution: { decision: 'keep_origin', reason: 'no_linked_source' } };
  }

  const preferred = linkedSources[0]!;
  if (shouldKeepOriginTweet(item, preferred)) {
    return { sourceResolution: { decision: 'keep_origin', reason: 'tweet_has_unique_context' } };
  }

  return {
    linkedSource: preferred,
    sourceLabel: resolveSourceLabel(preferred),
    sourceResolution: { decision: 'use_linked_source', reason: `${preferred.via}_wrapper` },
  };
}

export function shouldFetchRepliesForPrimarySource(item: CollectedItem): boolean {
  if (item.source !== 'twitter') return false;
  if ((item.outboundLinks ?? []).length > 0) return false;
  return looksLikeWrapperText(item.text);
}

async function fetchSubstackText(url: string): Promise<string> {
  const proxy = resolveHttpProxy();
  const args = buildSubstackCurlArgs(url, proxy);
  logCollectDiagnostic(`substack proxy=${proxy ? redactProxyValue(proxy) : 'disabled'} command=curl ${redactCurlArgs(args).join(' ')}`);

  try {
    const { stdout } = await execFileAsync(
      'curl',
      args,
      { maxBuffer: 20 * 1024 * 1024 },
    );
    return stdout;
  } catch (error) {
    logCollectDiagnostic(`substack error=${summarizeDiagnosticError(error)}`);
    throw error;
  }
}

async function fetchLinkedPage(url: string): Promise<LinkedSource | null> {
  const normalizedUrl = canonicalizePrimarySourceUrl(url);
  if (!normalizedUrl) return null;

  let stdout = '';
  try {
    const proxy = resolveHttpProxy();
    let lastError: unknown;
    for (let attempt = 0; attempt <= 1; attempt++) {
      try {
        const response = await execFileAsync(
          'curl',
          buildGenericCurlArgs(normalizedUrl, proxy),
          { maxBuffer: 2 * 1024 * 1024 },
        );
        stdout = response.stdout;
        lastError = undefined;
        break;
      } catch (error) {
        lastError = error;
        if (attempt < 1 && isTransientCurlError(error)) {
          await new Promise((r) => setTimeout(r, 1000));
          continue;
        }
        throw error;
      }
    }
    if (lastError) throw lastError;
  } catch (error) {
    console.warn(`[collect] 跳过外链抓取 ${normalizedUrl}: ${summarizeError(error)}`);
    return null;
  }

  const trimmed = stdout.trim();
  if (!trimmed) return null;

  const parsedUrl = new URL(normalizedUrl);
  const isHtml = /<html|<body|<article|<main|<title/i.test(trimmed);
  const title = isHtml
    ? extractMetaTag(trimmed, 'property', 'og:site_name') ??
      extractMetaTag(trimmed, 'property', 'og:title') ??
      extractTitle(trimmed)
    : undefined;
  const description = isHtml
    ? extractMetaTag(trimmed, 'name', 'description') ??
      extractMetaTag(trimmed, 'property', 'og:description')
    : undefined;
  const excerpt = (isHtml ? extractMainText(trimmed) : trimmed.replace(/\s+/g, ' ').trim()).slice(0, 1500);

  if (!title && !description && excerpt.length < 80) return null;

  return {
    url: normalizedUrl,
    title,
    description,
    excerpt,
    domain: normalizeDomain(parsedUrl.hostname),
    via: 'tweet',
  };
}

export function createLinkedPageFetcher(
  fetchPage: (url: string) => Promise<LinkedSource | null> = fetchLinkedPage,
): (url: string) => Promise<LinkedSource | null> {
  const cache = new Map<string, Promise<LinkedSource | null>>();
  return async (url: string): Promise<LinkedSource | null> => {
    const cacheKey = normalizeExternalUrl(url) ?? url;
    const cached = cache.get(cacheKey);
    if (cached) return cached;

    const pending = fetchPage(url);
    cache.set(cacheKey, pending);
    return pending;
  };
}

interface ResolveTwitterPrimarySourceOptions {
  fetchLinkedPage?: (url: string) => Promise<LinkedSource | null>;
  fetchTwitterReplies?: (item: CollectedItem, maxReplies: number) => Promise<ReplyContext[]>;
  resolveShortUrl?: (url: string) => Promise<string | null>;
  fetchQuotedPrimarySource?: (url: string) => Promise<LinkedSource | null>;
  resolveEmbeddedQuoteSource?: (quotedTweetText: string) => Promise<LinkedSource | null>;
  enrichmentBreaker?: TwitterEnrichmentCircuitBreaker;
}

interface FetchTwitterRepliesOptions {
  fetchTwitterRepliesViaApi?: (tweetId: string, maxReplies: number) => Promise<ReplyContext[]>;
  fetchTwitterRepliesViaCli?: (tweetId: string, maxReplies: number) => Promise<ReplyContext[]>;
  enrichmentBreaker?: TwitterEnrichmentCircuitBreaker;
}

export function parseTwitterCliReplyPayload(payload: TwitterCliReplyPayload): TwitterCliTweet[] {
  if (Array.isArray(payload)) return payload;

  if (!payload || typeof payload !== 'object') {
    throw new Error('twitter-cli replies payload is not an array or object');
  }

  if (!payload.ok) {
    throw new Error('twitter-cli replies returned ok=false');
  }

  if (!Array.isArray(payload.data)) {
    throw new Error('twitter-cli replies payload missing data array');
  }

  return payload.data;
}

async function fetchTwitterRepliesViaCli(tweetId: string, maxReplies: number): Promise<ReplyContext[]> {
  const proxy = resolveHttpProxy();
  const { stdout } = await execTwitterCliCommand(buildTwitterReplyCommand(tweetId, maxReplies, proxy), 10 * 1024 * 1024);
  const payload = parseTwitterCliReplyPayload(JSON.parse(stdout) as TwitterCliReplyPayload);
  return payload.slice(1, 1 + maxReplies).map((reply) => ({
    id: reply.id,
    text: reply.text,
    author: { name: reply.author.name, username: reply.author.screenName },
    publishedAt: reply.createdAt,
    url: buildTweetUrl(reply.author.screenName, reply.id),
    outboundLinks: extractTwitterCliUrls(reply),
  }));
}

async function fetchTwitterRepliesViaApi(tweetId: string, maxReplies: number): Promise<ReplyContext[]> {
  const apiKey = process.env.TWITTERAPI_KEY;
  if (!apiKey) return [];

  const params = new URLSearchParams({
    tweetId,
    queryType: 'Latest',
    cursor: '',
  });
  const res = await fetch(`${TWITTER_API_BASE}/twitter/tweet/replies/v2?${params}`, {
    headers: { 'X-API-Key': apiKey },
  });

  if (!res.ok) {
    throw new Error(`twitterapi.io replies 请求失败: ${res.status} ${res.statusText}`);
  }

  const data = (await res.json()) as TwitterApiReplyResponse;
  if (data.status !== 'success') {
    throw new Error(`twitterapi.io replies 返回错误: ${data.message ?? data.status}`);
  }

  return (data.replies ?? []).slice(0, maxReplies).map((reply) => ({
    id: reply.id,
    text: reply.text,
    author: {
      name: reply.author?.name ?? reply.author?.userName ?? 'Unknown',
      username: reply.author?.userName,
    },
    publishedAt: reply.createdAt,
    url: reply.url,
    outboundLinks: extractStructuredUrls(
      (reply.entities?.urls ?? []).flatMap((entry) => [entry.expanded_url, entry.url]),
    ),
  }));
}

function extractTweetIdFromStatusUrl(url: string): string | null {
  const normalizedUrl = normalizeTwitterStatusUrl(url);
  if (!normalizedUrl) return null;
  const match = new URL(normalizedUrl).pathname.match(/^\/[^/]+\/status\/([^/?#]+)/i);
  return match?.[1] ?? null;
}

async function fetchTwitterTweetViaCli(tweetId: string): Promise<TwitterCliTweet | null> {
  const proxy = resolveHttpProxy();
  const { stdout } = await execTwitterCliCommand(buildTwitterReplyCommand(tweetId, 1, proxy), 10 * 1024 * 1024);
  const payload = parseTwitterCliReplyPayload(JSON.parse(stdout) as TwitterCliReplyPayload);
  return payload[0] ?? null;
}

/**
 * Resolve the quoted tweet's primary source from the quote text already embedded in the list
 * payload — no `twitter tweet <id>` X API call. The X N+1 this avoids is the main cause of the 429s
 * that left quote-wrapper tweets (e.g. "recommended reading." quoting a paper) as no_linked_source.
 * Reuses the same t.co-resolution + page-fetch path as the network fallback.
 */
async function resolveEmbeddedQuoteSource(
  quotedTweetText: string,
  resolveShortUrlImpl: (url: string) => Promise<string | null>,
  fetchLinkedPageImpl: (url: string) => Promise<LinkedSource | null>,
): Promise<LinkedSource | null> {
  const enriched = await enrichTwitterTextCandidates(
    { text: quotedTweetText, outboundLinks: [], embeddedLinkedSource: undefined, quotedStatusUrl: undefined },
    resolveShortUrlImpl,
  );
  for (const link of enriched.outboundLinks ?? []) {
    const linkedSource = await fetchLinkedPageImpl(link);
    if (linkedSource) return { ...linkedSource, via: 'quote' };
  }
  return null;
}

async function fetchQuotedPrimarySource(
  url: string,
  fetchLinkedPageImpl: (url: string) => Promise<LinkedSource | null>,
  resolveShortUrlImpl: (url: string) => Promise<string | null>,
  enrichmentBreaker?: TwitterEnrichmentCircuitBreaker,
): Promise<LinkedSource | null> {
  const tweetId = extractTweetIdFromStatusUrl(url);
  if (!tweetId) return null;
  if (enrichmentBreaker?.shouldSkip()) return null;

  let quotedTweet: TwitterCliTweet | null;
  try {
    quotedTweet = await fetchTwitterTweetViaCli(tweetId);
  } catch (error) {
    enrichmentBreaker?.recordFailure(error);
    console.warn(`[collect] 拉取 quoted tweet 失败 ${url}: ${summarizeError(error)}`);
    return null;
  }

  if (!quotedTweet) return null;

  const mappedQuotedTweet = mapTwitterCliTweet(quotedTweet);
  const enrichedQuotedTweet = await enrichTwitterTextCandidates(mappedQuotedTweet, resolveShortUrlImpl);
  const embeddedLinkedSource = enrichedQuotedTweet.embeddedLinkedSource;
  if (embeddedLinkedSource) {
    return { ...embeddedLinkedSource, via: 'quote' };
  }

  for (const link of enrichedQuotedTweet.outboundLinks ?? []) {
    const linkedSource = await fetchLinkedPageImpl(link);
    if (linkedSource) return { ...linkedSource, via: 'quote' };
  }

  return null;
}

async function fetchPublicSubstackPublications(): Promise<
  Array<Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>> & { roundupMode?: RoundupMode }>
> {
  const publicationUrl = process.env.SUBSTACK_PUBLICATION_URL;
  if (!publicationUrl) {
    return mergeConfiguredSubstackPublications([]);
  }

  const handle = deriveSubstackProfileHandle(publicationUrl);
  const html = await fetchSubstackText(`https://substack.com/@${handle}`);
  return mergeConfiguredSubstackPublications(parsePublicSubstackSubscriptions(html));
}

function buildPublicationFeedUrl(
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>,
): string {
  return new URL('/feed', publication.url).toString();
}

async function fetchPublicationFeed(
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>> & { roundupMode?: RoundupMode },
): Promise<PublicSubstackFeed> {
  const feedUrl = buildPublicationFeedUrl(publication);
  const xml = await fetchSubstackText(feedUrl);
  const parsed = parseSubstackFeed(xml);

  return {
    publication: {
      ...parsed.publication,
      name: publication.name,
      handle: publication.handle,
      slug: publication.slug,
      url: publication.url,
      roundupMode: publication.roundupMode,
    },
    posts: parsed.posts,
  };
}

function warnSubstackFeedFailure(
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>> & { roundupMode?: RoundupMode },
  error: unknown,
): void {
  const proxy = resolveHttpProxy();
  const feedUrl = buildPublicationFeedUrl(publication);
  logCollectDiagnostic(`substack publication="${publication.name}" error=${summarizeDiagnosticError(error)}`);
  console.warn(
    `[collect] 跳过 Substack publication feed: publication="${publication.name}" publicationUrl=${publication.url} feedUrl=${feedUrl} proxy=${proxy ?? 'disabled'} error=${summarizeError(error)}`,
  );
}

async function collectViaCli(listId: string, maxTweets: number): Promise<CollectedItem[]> {
  const proxy = resolveHttpProxy();
  console.log(`[collect] 使用 twitter-cli 采集`);
  const command = buildTwitterCliCommand(listId, maxTweets, proxy);
  logCollectDiagnostic(`twitter proxy=${proxy ? redactProxyValue(proxy) : 'disabled'} command=${redactCollectDiagnosticCommand(command)}`);

  let stdout: string;
  let stderr: string;
  try {
    const result = await execTwitterCliCommand(command, 50 * 1024 * 1024);
    stdout = result.stdout;
    stderr = result.stderr;
  } catch (error) {
    logCollectDiagnostic(`twitter error=${summarizeDiagnosticError(error)}`);
    throw error;
  }

  if (stderr && !stderr.includes('Getting Twitter cookies')) {
    console.warn(`[collect] twitter-cli stderr: ${stderr}`);
  }

  const result = JSON.parse(stdout) as TwitterCliOutput;

  if (!result.ok) {
    throw new Error('twitter-cli returned ok=false');
  }

  return result.data.map(mapTwitterCliTweet);
}

export async function collectTwitterRecommendationItems(
  sinceTime: number,
  {
    batchSize = DEFAULT_TWITTER_RECOMMENDATION_BATCH_SIZE,
    batchCount = DEFAULT_TWITTER_RECOMMENDATION_BATCH_COUNT,
    minBatchDelayMs = DEFAULT_TWITTER_RECOMMENDATION_BATCH_MIN_DELAY_MS,
    maxBatchDelayMs = DEFAULT_TWITTER_RECOMMENDATION_BATCH_MAX_DELAY_MS,
    fetchRecommendationAuth = () =>
      fetchTwitterRecommendationAuthFromCdp({
        endpoint: process.env.TWITTER_RECOMMENDATION_CDP_ENDPOINT ?? DEFAULT_TWITTER_RECOMMENDATION_CDP_ENDPOINT,
      }),
    chooseRecommendationLoginRetry: chooseLoginRetry = chooseRecommendationLoginRetry,
    execTwitterCliCommand: runTwitterCliCommand = execTwitterCliCommand,
    random = Math.random,
    sleep = defaultSleep,
    topicGate,
    warn = console.warn,
  }: CollectTwitterRecommendationItemsOptions = {},
): Promise<SourceCollectionResult> {
  const warnings: string[] = [];
  let auth = await fetchRecommendationAuth();

  if (!auth && await chooseLoginRetry()) {
    auth = await fetchRecommendationAuth();
  }

  if (!auth) {
    const warning = '未检测到 CDP 浏览器中的 X 登录，跳过推荐流采集';
    warnings.push(warning);
    warn(`[collect] ${warning}`);
    return { items: [], warnings };
  }

  const proxy = resolveHttpProxy();
  const itemsById = new Map<string, CollectedItem>();

  for (let batchIndex = 0; batchIndex < batchCount; batchIndex += 1) {
    const batchNumber = batchIndex + 1;
    const command = buildTwitterFeedCommand('for-you', batchSize, proxy, auth);
    logCollectDiagnostic(
      `twitter recommendation batch=${batchNumber}/${batchCount} command=${redactCollectDiagnosticCommand(command)}`,
    );

    let stdout: string;
    let stderr: string;
    try {
      const result = await runTwitterCliCommand(command, 50 * 1024 * 1024);
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (error) {
      const summary = summarizeTwitterCliError(error);
      const fallbackMaxTweets = Math.min(FALLBACK_TWITTER_RECOMMENDATION_MAX_TWEETS, batchSize);
      if (fallbackMaxTweets < batchSize && isTwitterCliRecommendationFallbackError(summary)) {
        const fallbackWarning = `推荐流第 ${batchNumber}/${batchCount} 批采集触发 X 分页或超时错误，已改用最近 ${fallbackMaxTweets} 条: ${summary}`;
        warnings.push(fallbackWarning);
        warn(`[collect] ${fallbackWarning}`);

        const fallbackCommand = buildTwitterFeedCommand('for-you', fallbackMaxTweets, proxy, auth);
        logCollectDiagnostic(
          `twitter recommendation fallback batch=${batchNumber}/${batchCount} command=${redactCollectDiagnosticCommand(fallbackCommand)}`,
        );
        try {
          const result = await runTwitterCliCommand(fallbackCommand, 50 * 1024 * 1024);
          stdout = result.stdout;
          stderr = result.stderr;
        } catch (fallbackError) {
          const warning = `推荐流第 ${batchNumber}/${batchCount} 批采集失败，停止后续批次: ${summarizeTwitterCliError(fallbackError)}`;
          warnings.push(warning);
          warn(`[collect] ${warning}`);
          break;
        }
      } else {
        const warning = `推荐流第 ${batchNumber}/${batchCount} 批采集失败，停止后续批次: ${summary}`;
        warnings.push(warning);
        warn(`[collect] ${warning}`);
        break;
      }
    }

    if (stderr && !stderr.includes('Getting Twitter cookies')) {
      console.warn(`[collect] twitter-feed stderr: ${stderr}`);
    }

    let result: TwitterCliOutput;
    try {
      result = JSON.parse(stdout) as TwitterCliOutput;
    } catch (error) {
      const warning = `推荐流第 ${batchNumber}/${batchCount} 批采集失败，停止后续批次: ${summarizeError(error)}`;
      warnings.push(warning);
      warn(`[collect] ${warning}`);
      break;
    }

    if (!result.ok) {
      const warning = `推荐流第 ${batchNumber}/${batchCount} 批采集失败，停止后续批次: twitter-cli returned ok=false`;
      warnings.push(warning);
      warn(`[collect] ${warning}`);
      break;
    }

    const batchItems = filterSinceTime(result.data.map(mapTwitterCliTweet), sinceTime)
      .map((item) => ({ ...item, twitterFeed: 'for-you' as const }));
    for (const item of batchItems) {
      if (!itemsById.has(item.id)) {
        itemsById.set(item.id, item);
      }
    }

    if (batchIndex < batchCount - 1) {
      await sleep(randomDelayMs(minBatchDelayMs, maxBatchDelayMs, random));
    }
  }

  const items = Array.from(itemsById.values());
  const filtered = await filterAiRelatedRecommendationItems(items, topicGate, warn);
  return {
    items: filtered.items,
    warnings: [...warnings, ...(filtered.warnings ?? [])],
  };
}

async function collectViaApi(
  listId: string,
  sinceTime: number,
  maxTweets: number,
): Promise<CollectedItem[]> {
  const apiKey = process.env.TWITTERAPI_KEY;
  if (!apiKey) throw new Error('TWITTERAPI_KEY is not set');

  console.log('[collect] 使用 twitterapi.io 采集');

  const tweets: CollectedItem[] = [];
  let cursor = '';

  while (tweets.length < maxTweets) {
    const params = new URLSearchParams({
      listId,
      sinceTime: String(sinceTime),
      includeReplies: 'false',
      cursor,
    });

    const res = await fetch(`${TWITTER_API_BASE}/twitter/list/tweets?${params}`, {
      headers: { 'X-API-Key': apiKey },
    });

    if (!res.ok) {
      throw new Error(`twitterapi.io 请求失败: ${res.status} ${res.statusText}`);
    }

    const data = (await res.json()) as TwitterApiResponse;

    if (data.status !== 'success') {
      throw new Error(`twitterapi.io 返回错误: ${data.message ?? data.status}`);
    }

    for (const tweet of data.tweets) {
      tweets.push(mapTwitterApiTweet(tweet));
      if (tweets.length >= maxTweets) break;
    }

    console.log(`[collect] 已采集 ${tweets.length} 条...`);

    if (!data.has_next_page || !data.next_cursor) break;
    cursor = data.next_cursor;
  }

  return tweets;
}

export async function fetchTwitterReplies(
  item: CollectedItem,
  maxReplies = 3,
  options: FetchTwitterRepliesOptions = {},
): Promise<ReplyContext[]> {
  if (item.source !== 'twitter') return [];
  if (options.enrichmentBreaker?.shouldSkip()) return [];

  const fetchTwitterRepliesViaApiImpl = options.fetchTwitterRepliesViaApi ?? fetchTwitterRepliesViaApi;
  const fetchTwitterRepliesViaCliImpl = options.fetchTwitterRepliesViaCli ?? fetchTwitterRepliesViaCli;

  if (process.env.TWITTERAPI_KEY) {
    try {
      return await fetchTwitterRepliesViaApiImpl(item.id, maxReplies);
    } catch (error) {
      options.enrichmentBreaker?.recordFailure(error);
      if (options.enrichmentBreaker?.shouldSkip()) {
        console.warn(`[collect] twitterapi replies 失败，跳过 replies: ${error}`);
        return [];
      }
      console.warn(`[collect] twitterapi replies 失败，回退到 twitter-cli: ${error}`);
    }
  }

  try {
    return await fetchTwitterRepliesViaCliImpl(item.id, maxReplies);
  } catch (error) {
    options.enrichmentBreaker?.recordFailure(error);
    console.warn(`[collect] twitter-cli replies 失败，跳过 replies: ${error}`);
    return [];
  }
}

export async function resolveTwitterPrimarySource(
  item: CollectedItem,
  options: ResolveTwitterPrimarySourceOptions = {},
): Promise<CollectedItem> {
  if (item.source !== 'twitter') return item;
  if (item.selfThread) return item;

  const fetchLinkedPageImpl = options.fetchLinkedPage ?? fetchLinkedPage;
  const resolveShortUrlImpl = options.resolveShortUrl ?? resolveShortUrl;
  const enrichmentBreaker = options.enrichmentBreaker;
  const fetchTwitterRepliesImpl =
    options.fetchTwitterReplies ??
    ((replyItem: CollectedItem, maxReplies: number) =>
      fetchTwitterReplies(replyItem, maxReplies, { enrichmentBreaker }));
  const fetchQuotedPrimarySourceImpl =
    options.fetchQuotedPrimarySource ??
    ((url: string) => fetchQuotedPrimarySource(url, fetchLinkedPageImpl, resolveShortUrlImpl, enrichmentBreaker));
  const resolveEmbeddedQuoteSourceImpl =
    options.resolveEmbeddedQuoteSource ??
    ((quoteText: string) => resolveEmbeddedQuoteSource(quoteText, resolveShortUrlImpl, fetchLinkedPageImpl));
  const enrichedCandidates = await enrichTwitterTextCandidates(item, resolveShortUrlImpl);
  const enrichedItem = {
    ...item,
    outboundLinks: enrichedCandidates.outboundLinks,
    embeddedLinkedSource: enrichedCandidates.embeddedLinkedSource ?? item.embeddedLinkedSource,
    quotedStatusUrl: quotedStatusUrlUnlessOwn(
      item,
      enrichedCandidates.quotedStatusUrl,
      item.quotedStatusUrl,
    ),
  };
  const tweetLinks = enrichedItem.outboundLinks ?? [];

  const useEmbeddedLinkedSource = (replyContext: ReplyContext[] = []): CollectedItem => {
    const embeddedLinkedSource = enrichedItem.embeddedLinkedSource!;
    return {
      ...enrichedItem,
      url: embeddedLinkedSource.url,
      sourceLabel: resolveSourceLabel(embeddedLinkedSource),
      linkedSource: embeddedLinkedSource,
      replyContext,
      sourceResolution: { decision: 'use_linked_source', reason: 'quote_wrapper' },
    };
  };

  if (tweetLinks.length === 0 && enrichedItem.embeddedLinkedSource) {
    return useEmbeddedLinkedSource([]);
  }

  // Prefer the quoted tweet's text already embedded in the list payload. This never touches the
  // X API (so it is NOT gated by the enrichment breaker — an X 429 elsewhere must not block it),
  // and it removes the per-quote N+1 that triggered those 429s in the first place.
  if (tweetLinks.length === 0 && enrichedItem.quotedStatusUrl && enrichedItem.quotedTweetText) {
    const embeddedQuoteSource = await resolveEmbeddedQuoteSourceImpl(enrichedItem.quotedTweetText);
    if (embeddedQuoteSource) {
      return {
        ...enrichedItem,
        url: embeddedQuoteSource.url,
        sourceLabel: resolveSourceLabel(embeddedQuoteSource),
        linkedSource: embeddedQuoteSource,
        replyContext: [],
        sourceResolution: { decision: 'use_linked_source', reason: 'embedded_quote_wrapper' },
      };
    }
  }

  if (tweetLinks.length === 0 && enrichedItem.quotedStatusUrl && !enrichmentBreaker?.shouldSkip()) {
    const quotedPrimarySource = await fetchQuotedPrimarySourceImpl(enrichedItem.quotedStatusUrl);
    if (quotedPrimarySource) {
      return {
        ...enrichedItem,
        url: quotedPrimarySource.url,
        sourceLabel: resolveSourceLabel(quotedPrimarySource),
        linkedSource: quotedPrimarySource,
        replyContext: [],
        sourceResolution: { decision: 'use_linked_source', reason: 'quote_wrapper' },
      };
    }
  }

  const shouldFetchReplyContext =
    tweetLinks.length === 0 && shouldFetchRepliesForPrimarySource(enrichedItem) && !enrichmentBreaker?.shouldSkip();
  const replyContext =
    shouldFetchReplyContext
      ? await fetchTwitterRepliesImpl(enrichedItem, 3)
      : [];
  const replyLinks = dedupeUrls(replyContext.flatMap((reply) => reply.outboundLinks));
  const candidateLinks = tweetLinks.length > 0 ? tweetLinks : replyLinks;

  if (candidateLinks.length === 0) {
    if (enrichedItem.embeddedLinkedSource) {
      return useEmbeddedLinkedSource(replyContext);
    }

    // Fallback: check if the author posted a reply with a link to the full article
    const authorReplySource = enrichmentBreaker?.shouldSkip()
      ? null
      : await findAuthorReplySource(
          enrichedItem,
          fetchTwitterRepliesImpl,
          fetchLinkedPageImpl,
          shouldFetchReplyContext ? replyContext : undefined,
        );
    if (authorReplySource) {
      return {
        ...enrichedItem,
        url: authorReplySource.url,
        sourceLabel: resolveSourceLabel(authorReplySource),
        linkedSource: authorReplySource,
        replyContext,
        sourceResolution: { decision: 'use_linked_source', reason: 'author_reply_source' },
      };
    }

    return {
      ...enrichedItem,
      replyContext,
      sourceResolution: { decision: 'keep_origin', reason: 'no_linked_source' },
    };
  }

  const linkedSources: LinkedSource[] = [];
  for (const [index, link] of candidateLinks.entries()) {
    let linkedSource: LinkedSource | null;
    try {
      linkedSource = await fetchLinkedPageImpl(link);
    } catch (error) {
      console.warn(`[collect] 跳过外链抓取 ${link}: ${summarizeError(error)}`);
      continue;
    }
    if (!linkedSource) continue;
    linkedSources.push({
      ...linkedSource,
      via: tweetLinks.length > 0 && index < tweetLinks.length ? 'tweet' : 'reply',
    });
  }

  const resolved = resolveTwitterLinkedSource(item, linkedSources);
  if (!resolved.linkedSource) {
    if (enrichedItem.quotedStatusUrl && !enrichmentBreaker?.shouldSkip()) {
      const quotedPrimarySource = await fetchQuotedPrimarySourceImpl(enrichedItem.quotedStatusUrl);
      if (quotedPrimarySource) {
        return {
          ...enrichedItem,
          url: quotedPrimarySource.url,
          sourceLabel: resolveSourceLabel(quotedPrimarySource),
          linkedSource: quotedPrimarySource,
          replyContext,
          sourceResolution: { decision: 'use_linked_source', reason: 'quote_wrapper' },
        };
      }
    }

    if (enrichedItem.embeddedLinkedSource) {
      return useEmbeddedLinkedSource(replyContext);
    }

    return {
      ...enrichedItem,
      replyContext,
      sourceResolution: resolved.sourceResolution,
    };
  }

  return {
    ...enrichedItem,
    url: resolved.linkedSource.url,
    sourceLabel: resolved.sourceLabel,
    linkedSource: resolved.linkedSource,
    replyContext,
    sourceResolution: resolved.sourceResolution,
  };
}

interface ResolveTwitterPrimarySourcesOptions {
  resolveTwitterPrimarySource?: (item: CollectedItem) => Promise<CollectedItem>;
}

export async function resolveTwitterPrimarySources(
  items: CollectedItem[],
  options: ResolveTwitterPrimarySourcesOptions = {},
): Promise<CollectedItem[]> {
  const resolveTwitterPrimarySourceImpl = options.resolveTwitterPrimarySource ?? resolveTwitterPrimarySource;
  const results = new Array<CollectedItem>(items.length);
  let index = 0;

  async function runNext(): Promise<void> {
    const i = index++;
    if (i >= items.length) return;
    results[i] = await resolveTwitterPrimarySourceImpl(items[i]);
    await runNext();
  }

  await Promise.all(Array.from({ length: 2 }, runNext));
  return results;
}

/**
 * Summarize quote-wrapper tweets whose primary source could not be resolved (neither from the
 * embedded quote text nor the network fallback). Surfaced as a collection warning so the residual
 * is visible — it tells us whether the network fallback needs hardening (caching/rate-limit) and
 * whether a ranker safety net for unresolved curation-intent quotes is warranted.
 */
export function buildUnresolvedQuoteWarning(
  items: readonly Pick<CollectedItem, 'quotedStatusUrl' | 'sourceResolution'>[],
): string | null {
  const quotes = items.filter((it) => it.quotedStatusUrl);
  if (quotes.length === 0) return null;
  const unresolved = quotes.filter((it) => it.sourceResolution?.decision !== 'use_linked_source');
  if (unresolved.length === 0) return null;
  const embeddedResolved = quotes.filter(
    (it) => it.sourceResolution?.reason === 'embedded_quote_wrapper',
  ).length;
  const samples = unresolved
    .map((it) => it.quotedStatusUrl!)
    .filter(Boolean)
    .slice(0, 3)
    .join(' \n ');
  return (
    `Twitter quote 解析：共 ${quotes.length} 条带 quote，` +
    `${embeddedResolved} 条经嵌入文本本地解析，` +
    `${unresolved.length} 条未解析出主源（嵌入文本无外链或 X 回退被限流/失败）；样本 ${samples}`
  );
}

function normalizeSourceCollectionResult(result: CollectedItem[] | SourceCollectionResult): SourceCollectionResult {
  return Array.isArray(result) ? { items: result } : result;
}

function shouldCollectTwitterRecommendations(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.ENABLE_TWITTER_RECOMMENDATIONS?.trim().toLowerCase();
  return raw !== '0' && raw !== 'false' && raw !== 'no';
}

async function collectTwitterItems(sinceTime: number): Promise<SourceCollectionResult> {
  const listId = resolveTwitterListId();
  console.log(
    `[collect] 采集 Twitter listId=${listId}，sinceTime=${new Date(sinceTime * 1000).toLocaleString('zh-CN')}`,
  );

  let listItems: CollectedItem[];

  try {
    listItems = await collectViaCli(listId, MAX_TWEETS);
  } catch (cliError) {
    logCollectDiagnostic(`twitter-cli failed error=${summarizeDiagnosticError(cliError)}`);
    console.warn(`[collect] twitter-cli 失败: ${cliError}`);
    console.error(`❌ || cliError error`, cliError);

    if (!process.env.TWITTERAPI_KEY) {
      throw new Error('twitter-cli 失败且未配置 TWITTERAPI_KEY，无法回退');
    }

    console.log('[collect] 回退到 twitterapi.io...');
    listItems = await collectViaApi(listId, sinceTime, MAX_TWEETS);
  }

  const recommendationResult = shouldCollectTwitterRecommendations()
    ? await collectTwitterRecommendationItems(sinceTime, {
        batchSize: parsePositiveInt(
          process.env.TWITTER_RECOMMENDATION_BATCH_SIZE,
          DEFAULT_TWITTER_RECOMMENDATION_BATCH_SIZE,
        ),
        batchCount: parsePositiveInt(
          process.env.TWITTER_RECOMMENDATION_BATCH_COUNT,
          DEFAULT_TWITTER_RECOMMENDATION_BATCH_COUNT,
        ),
        minBatchDelayMs: parsePositiveInt(
          process.env.TWITTER_RECOMMENDATION_BATCH_MIN_DELAY_MS,
          DEFAULT_TWITTER_RECOMMENDATION_BATCH_MIN_DELAY_MS,
        ),
        maxBatchDelayMs: parsePositiveInt(
          process.env.TWITTER_RECOMMENDATION_BATCH_MAX_DELAY_MS,
          DEFAULT_TWITTER_RECOMMENDATION_BATCH_MAX_DELAY_MS,
        ),
      })
    : { items: [], warnings: [] };
  const filtered = collapseSameIdItems([
    ...filterSinceTime(listItems, sinceTime).map((item) => ({ ...item, twitterFeed: 'list' as const })),
    ...recommendationResult.items,
  ]);
  const collapsed = collapseNumberedSelfThreads(filtered);
  if (process.env.DAILY_NEWS_SKIP_TWITTER_PRIMARY_SOURCE_RESOLUTION?.trim() === '1') {
    console.log(`[collect] 跳过 Twitter primary source 解析，共采集 ${collapsed.length} 条内容`);
    return {
      items: sortNewestFirst(collapsed),
      warnings: recommendationResult.warnings,
    };
  }
  const sharedShortUrlResolver = createShortUrlResolver();
  const sharedLinkedPageFetcher = createLinkedPageFetcher();
  const twitterEnrichmentBreaker = createTwitterEnrichmentCircuitBreaker();
  const resolved = await resolveTwitterPrimarySources(collapsed, {
    resolveTwitterPrimarySource: (item) =>
      resolveTwitterPrimarySource(item, {
        resolveShortUrl: sharedShortUrlResolver,
        fetchLinkedPage: sharedLinkedPageFetcher,
        enrichmentBreaker: twitterEnrichmentBreaker,
      }),
  });
  const quoteWarning = buildUnresolvedQuoteWarning(resolved);
  console.log(`[collect] Twitter 完成，共采集 ${resolved.length} 条内容`);
  return {
    items: sortNewestFirst(resolved),
    warnings: quoteWarning
      ? [...(recommendationResult.warnings ?? []), quoteWarning]
      : recommendationResult.warnings,
  };
}

export function mapTwitterCliTweet(tweet: TwitterCliTweet): CollectedItem {
  const originUrl = buildTweetUrl(tweet.author.screenName, tweet.id);
  return {
    id: tweet.id,
    source: 'twitter',
    text: tweet.text,
    author: { name: tweet.author.name, username: tweet.author.screenName },
    publishedAt: tweet.createdAt,
    url: originUrl,
    originUrl,
    outboundLinks: extractTwitterCliUrls(tweet),
    embeddedLinkedSource: extractTwitterCliEmbeddedLinkedSource(tweet) ?? buildArticleMetadataLinkedSource(tweet),
    quotedStatusUrl: buildQuotedStatusUrl(tweet),
    quotedTweetText: tweet.quotedTweet?.text?.trim() || undefined,
    media: Array.isArray(tweet.media)
      ? tweet.media.flatMap((item) => {
          const normalized = normalizeMediaItem(item);
          return normalized ? [normalized] : [];
        })
      : [],
    likeCount: toOptionalNumber(tweet.likeCount) ?? toOptionalNumber(tweet.metrics?.likes),
    replyCount: toOptionalNumber(tweet.replyCount) ?? toOptionalNumber(tweet.metrics?.replies),
    repostCount: toOptionalNumber(tweet.repostCount) ?? toOptionalNumber(tweet.metrics?.retweets),
    quoteCount: toOptionalNumber(tweet.quoteCount) ?? toOptionalNumber(tweet.metrics?.quotes),
  };
}

export function mapTwitterApiTweet(tweet: TwitterApiTweet): CollectedItem {
  const originUrl = tweet.url ?? buildTweetUrl(tweet.author.userName, tweet.id);
  return {
    id: tweet.id,
    source: 'twitter',
    text: tweet.text,
    author: { name: tweet.author.name, username: tweet.author.userName },
    publishedAt: tweet.createdAt,
    url: originUrl,
    originUrl,
    outboundLinks: extractTwitterApiUrls(tweet),
    embeddedLinkedSource: extractTwitterApiEmbeddedLinkedSource(tweet),
    media: normalizeTwitterApiMedia(tweet.media, tweet.extendedEntities?.media),
    likeCount: toOptionalNumber(tweet.favorite_count),
    replyCount: toOptionalNumber(tweet.reply_count),
    repostCount: toOptionalNumber(tweet.retweet_count),
    quoteCount: toOptionalNumber(tweet.quote_count),
  };
}

export function mapSubstackPost(
  post: SubstackPostLike,
  publication: Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url' | 'roundupMode'>,
): CollectedItem {
  const body = resolveSubstackBody(post);
  const coverImage =
    typeof post.coverImage === 'string' && post.coverImage.trim().length > 0
      ? [{ type: 'photo', url: post.coverImage.trim() }]
      : [];

  return {
    id: `substack-${post.id}`,
    source: 'substack',
    kind: 'substack_post',
    title: post.title,
    subtitle: post.subtitle ?? null,
    text: resolveSubstackText(post, body),
    body,
    htmlBody: post.htmlBody,
    publishedAt: resolveSubstackDate(post.publishedAt),
    url: post.url,
    author: { name: publication.name },
    publication: {
      name: publication.name,
      handle: publication.handle ?? publication.slug,
      url: publication.url,
      roundupMode: publication.roundupMode,
    },
    media: coverImage,
  };
}

export async function collectSubstackItems({
  sinceTime,
  maxPosts = DEFAULT_SUBSTACK_MAX_POSTS,
  maxPostsPerPublication = DEFAULT_SUBSTACK_MAX_POSTS_PER_PUBLICATION,
  client,
  deps,
}: CollectSubstackItemsOptions): Promise<CollectedItem[]> {
  console.log(
    `[collect] 采集 Substack subscriptions，sinceTime=${new Date(sinceTime * 1000).toLocaleString('zh-CN')}`,
  );

  const items: CollectedItem[] = [];

  if (client) {
    const ownProfile = await client.ownProfile();

    for await (const publication of ownProfile.following()) {
      let collectedForPublication = 0;

      for await (const preview of publication.posts({ limit: maxPostsPerPublication })) {
        const post = await resolveFullSubstackPost(preview);
        const item = mapSubstackPost(post, publication);

        if (toUnixSeconds(item.publishedAt) <= sinceTime) {
          continue;
        }

        items.push(item);
        collectedForPublication += 1;

        if (collectedForPublication >= maxPostsPerPublication) {
          break;
        }
      }
    }
  } else {
    const fetchPublications = deps?.fetchPublicSubstackPublications ?? fetchPublicSubstackPublications;
    const fetchFeed = deps?.fetchPublicationFeed ?? fetchPublicationFeed;
    const publications = await fetchPublications();

    const feedResults = new Array<PublicSubstackFeed | null>(publications.length);
    let pubIndex = 0;

    async function fetchNextFeed(): Promise<void> {
      const i = pubIndex++;
      if (i >= publications.length) return;
      try {
        feedResults[i] = await fetchFeed(publications[i]);
      } catch (error) {
        warnSubstackFeedFailure(publications[i], error);
        feedResults[i] = null;
      }
      await fetchNextFeed();
    }

    await Promise.all(Array.from({ length: 3 }, fetchNextFeed));

    for (const feed of feedResults) {
      if (!feed) continue;
      let collectedForPublication = 0;

      for (const post of feed.posts) {
        const item = mapSubstackPost(post, feed.publication);

        if (toUnixSeconds(item.publishedAt) <= sinceTime) {
          continue;
        }

        items.push(item);
        collectedForPublication += 1;

        if (collectedForPublication >= maxPostsPerPublication) {
          break;
        }
      }
    }
  }

  const parents = sortNewestFirst(items).slice(0, maxPosts);
  const expanded = await expandSubstackRoundupItems(parents);
  console.log(`[collect] Substack 完成，共采集 ${parents.length} 篇文章，展开 ${expanded.length - parents.length} 条 roundup 子项`);
  return sortNewestFirst(expanded);
}

export async function collectSources({
  enabledSources,
  nowSeconds,
  state,
  collectors,
}: CollectSourcesOptions): Promise<CollectionSnapshot> {
  const sourceResults = await Promise.allSettled(
    enabledSources.map(async (source) => {
      const sinceTime = getSourceSinceTime(state, source, nowSeconds);
      return { source, items: await collectors[source](sinceTime) };
    }),
  );

  const mergedItems: CollectedItem[] = [];
  const collectionWarnings: string[] = [];
  for (const result of sourceResults) {
    if (result.status === 'fulfilled') {
      const sourceResult = normalizeSourceCollectionResult(result.value.items);
      mergedItems.push(...sourceResult.items);
      collectionWarnings.push(...(sourceResult.warnings ?? []));
    } else {
      console.warn(`[collect] 数据源采集失败: ${summarizeError(result.reason)}`);
    }
  }

  return {
    collectedAt: nowSeconds,
    enabledSources,
    ...(collectionWarnings.length > 0 ? { collectionWarnings: Array.from(new Set(collectionWarnings)) } : {}),
    items: sortNewestFirst(mergedItems),
  };
}

export function parseEnabledSources(value = process.env.ENABLED_SOURCES): SourceName[] {
  if (value == null || value.trim() === '') return [...DEFAULT_ENABLED_SOURCES];

  const requested = value.split(',').map((source) => source.trim()).filter(Boolean);
  const sources = normalizeSourceNames(requested);
  if (!sources) {
    const unsupported = requested.filter((source) => !normalizeSourceNames([source]));
    throw new Error(`Unsupported ENABLED_SOURCES: ${unsupported.join(', ')}`);
  }

  return sources.length > 0 ? sources : [...DEFAULT_ENABLED_SOURCES];
}

export async function diagnoseCollectEnvironment({
  env = process.env,
  execFile: runExecFile,
  execTwitterCliCommand: runTwitterCliCommand = execTwitterCliCommand,
  log = console.log,
}: DiagnoseCollectEnvironmentDeps = {}): Promise<void> {
  const proxy = resolveHttpProxy(env);
  const listId = resolveTwitterListId(env);
  const twitterCommand = buildTwitterCliCommand(listId, DIAGNOSTIC_TWEET_LIMIT, proxy);
  writeCollectDiagnostic(
    log,
    `preflight twitter command=${redactCollectDiagnosticCommand(twitterCommand)}`,
  );

  try {
    const { stdout, stderr } = await runTwitterCliCommand(twitterCommand, 5 * 1024 * 1024);
    writeCollectDiagnostic(
      log,
      `preflight twitter ok stdoutBytes=${stdout.length} stderr=${stderr ? firstDiagnosticLine(stderr) : '<empty>'}`,
    );
  } catch (error) {
    writeCollectDiagnostic(log, `preflight twitter failed error=${summarizeDiagnosticError(error)}`);
  }

  const curlArgs = buildProxyCheckCurlArgs(proxy);
  writeCollectDiagnostic(log, `preflight curl command=curl ${redactCurlArgs(curlArgs).join(' ')}`);

  try {
    const execFileImpl =
      runExecFile ??
      (async (file: string, args: string[]) => {
        const { stdout, stderr } = await execFileAsync(file, args, { maxBuffer: 1024 * 1024 });
        return { stdout: String(stdout), stderr: String(stderr) };
      });
    await execFileImpl('curl', curlArgs);
    writeCollectDiagnostic(log, 'preflight curl ok');
  } catch (error) {
    writeCollectDiagnostic(log, `preflight curl failed error=${summarizeDiagnosticError(error)}`);
  }
}

export async function collect(
  state: RunState,
  nowSeconds = Math.floor(Date.now() / 1000),
): Promise<CollectionSnapshot> {
  const enabledSources = parseEnabledSources();

  const snapshot = await collectSources({
    enabledSources,
    nowSeconds,
    state,
    collectors: {
      twitter: collectTwitterItems,
      substack: (sinceTime) =>
        collectSubstackItems({
          sinceTime,
          maxPosts: parsePositiveInt(process.env.SUBSTACK_SOURCE_MAX_POSTS, DEFAULT_SUBSTACK_MAX_POSTS),
          maxPostsPerPublication: parsePositiveInt(
            process.env.SUBSTACK_SOURCE_MAX_POSTS_PER_PUBLICATION,
            DEFAULT_SUBSTACK_MAX_POSTS_PER_PUBLICATION,
          ),
        }),
      aihot: (sinceTime) =>
        collectAihotItems({
          sinceTime,
          feedUrl: process.env.AIHOT_FEED_URL,
          maxItems: parsePositiveInt(process.env.AIHOT_SOURCE_MAX_ITEMS, DEFAULT_AIHOT_MAX_ITEMS),
        }),
    },
  });

  console.log(`[collect] 完成，共采集 ${snapshot.items.length} 条跨来源内容`);
  return snapshot;
}
