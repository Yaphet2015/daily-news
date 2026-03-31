import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState, writeState } from './state.js';
import type {
  CollectedItem,
  LinkedSource,
  MediaAsset,
  ReplyContext,
  RunState,
  SourceName,
  SourceResolution,
} from './types.js';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

const TWITTER_API_BASE = 'https://api.twitterapi.io';
const MAX_TWEETS = 500;
const DEFAULT_LOOKBACK_SECONDS = 24 * 60 * 60;
const DEFAULT_SUBSTACK_MAX_POSTS = 40;
const DEFAULT_SUBSTACK_MAX_POSTS_PER_PUBLICATION = 2;

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
  truncatedBody?: string;
  markdown?: string;
  htmlBody?: string;
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

type SourceCollector = (sinceTime: number) => Promise<CollectedItem[]>;

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

interface PublicSubstackFeed {
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>;
  posts: SubstackPostLike[];
}

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
  return /\.(?:mp4|m4v|mov|avi|wmv|webm|m3u8|mp3|wav|ogg|jpg|jpeg|png|gif|webp|svg)(?:$|[?#])/i.test(
    pathname,
  );
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

function extractUrlsFromText(text: string): string[] {
  return extractRawUrlsFromText(text)
    .map((value) => normalizeExternalUrl(value))
    .flatMap((value) => (value && isLikelyPrimarySourceUrl(value) ? [value] : []));
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
      .map((url) => (typeof url === 'string' ? normalizeExternalUrl(url) : null))
      .flatMap((url) => (url && isLikelyPrimarySourceUrl(url) ? [url] : [])),
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

function parsePositiveInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getSourceSinceTime(state: RunState, source: SourceName, nowSeconds: number): number {
  const lastRunTime = state.sources[source].lastRunTime;
  return lastRunTime > 0 ? lastRunTime : nowSeconds - DEFAULT_LOOKBACK_SECONDS;
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
  const match = block.match(new RegExp(`<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`, 'i'));
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
      const content = stripHtml(cleanXmlText(extractXmlTag(block, 'content:encoded')));
      const publishedAt = new Date(cleanXmlText(extractXmlTag(block, 'pubDate'))).toISOString();
      const coverImage = extractXmlAttribute(block, 'enclosure', 'url');

      return [
        {
          id: url,
          title,
          subtitle: description || null,
          body: content,
          truncatedBody: description || content,
          publishedAt,
          url,
          coverImage,
        },
      ];
    }),
  };
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
  const proxyPrefix = proxy ? `HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} ` : '';
  return `${proxyPrefix}twitter list ${listId} --max ${maxTweets} --json`;
}

function buildTwitterReplyCommand(tweetId: string, maxReplies: number, proxy: string | undefined): string {
  const proxyPrefix = proxy ? `HTTP_PROXY=${proxy} HTTPS_PROXY=${proxy} ` : '';
  return `${proxyPrefix}twitter tweet ${tweetId} --max ${maxReplies} --json`;
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

function hasMeaningfulOverlap(left: string, right: string): boolean {
  const leftTokens = new Set(tokenizeForOverlap(left));
  if (leftTokens.size === 0) return false;
  let overlap = 0;
  for (const token of tokenizeForOverlap(right)) {
    if (leftTokens.has(token)) overlap += 1;
    if (overlap >= 2) return true;
  }
  return false;
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
  const hasOverlap = hasMeaningfulOverlap(text, pageContext);
  const hasHandoffCue = hasLinkedSourceHandoffCue(text);

  if (hasOverlap || hasHandoffCue) return false;
  if (hasBulletLikeStructure(text)) return true;
  if (countSentences(text) >= 4 && !looksLikeWrapperText(text)) return true;

  return !looksLikeWrapperText(text) && !hasOverlap;
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

async function resolveShortUrl(url: string): Promise<string | null> {
  const proxy = resolveHttpProxy();
  try {
    const { stdout } = await execFileAsync('curl', buildResolveUrlCurlArgs(url, proxy), {
      maxBuffer: 256 * 1024,
    });
    const resolved = stdout.trim();
    return resolved.length > 0 ? resolved : null;
  } catch (error) {
    console.warn(`[collect] 跳过短链接解析 ${url}: ${summarizeError(error)}`);
    return null;
  }
}

async function enrichTwitterTextCandidates(
  item: CollectedItem,
  resolveShortUrlImpl: (url: string) => Promise<string | null>,
): Promise<Pick<CollectedItem, 'outboundLinks' | 'embeddedLinkedSource' | 'quotedStatusUrl'>> {
  const outboundLinks = dedupeUrls(item.outboundLinks ?? []);
  let embeddedLinkedSource = item.embeddedLinkedSource;
  let quotedStatusUrl = item.quotedStatusUrl;

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

    const normalizedExternal = normalizeExternalUrl(candidateUrl);
    if (normalizedExternal) {
      outboundLinks.push(normalizedExternal);
      continue;
    }

    if (!embeddedLinkedSource) {
      embeddedLinkedSource = buildEmbeddedLinkedSourceFromTwitterUrl(candidateUrl, {}, 'tweet');
    }

    if (!quotedStatusUrl) {
      quotedStatusUrl = normalizeTwitterStatusUrl(candidateUrl) ?? quotedStatusUrl;
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
): Promise<LinkedSource | null> {
  const authorUsername = item.author.username?.toLowerCase();
  if (!authorUsername) return null;

  let replies: ReplyContext[];
  try {
    replies = await fetchReplies(item, 3);
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
  const { stdout } = await execFileAsync(
    'curl',
    buildSubstackCurlArgs(url, proxy),
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return stdout;
}

async function fetchLinkedPage(url: string): Promise<LinkedSource | null> {
  const normalizedUrl = normalizeExternalUrl(url);
  if (!normalizedUrl) return null;
  if (!isLikelyPrimarySourceUrl(normalizedUrl)) return null;

  let stdout: string;
  try {
    const proxy = resolveHttpProxy();
    const response = await execFileAsync(
      'curl',
      buildGenericCurlArgs(normalizedUrl, proxy),
      { maxBuffer: 2 * 1024 * 1024 },
    );
    stdout = response.stdout;
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

interface ResolveTwitterPrimarySourceOptions {
  fetchLinkedPage?: (url: string) => Promise<LinkedSource | null>;
  fetchTwitterReplies?: (item: CollectedItem, maxReplies: number) => Promise<ReplyContext[]>;
  resolveShortUrl?: (url: string) => Promise<string | null>;
  fetchQuotedPrimarySource?: (url: string) => Promise<LinkedSource | null>;
}

interface FetchTwitterRepliesOptions {
  fetchTwitterRepliesViaApi?: (tweetId: string, maxReplies: number) => Promise<ReplyContext[]>;
  fetchTwitterRepliesViaCli?: (tweetId: string, maxReplies: number) => Promise<ReplyContext[]>;
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
  const { stdout } = await execAsync(buildTwitterReplyCommand(tweetId, maxReplies, proxy), {
    maxBuffer: 10 * 1024 * 1024,
  });
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
  const { stdout } = await execAsync(buildTwitterReplyCommand(tweetId, 1, proxy), {
    maxBuffer: 10 * 1024 * 1024,
  });
  const payload = parseTwitterCliReplyPayload(JSON.parse(stdout) as TwitterCliReplyPayload);
  return payload[0] ?? null;
}

async function fetchQuotedPrimarySource(
  url: string,
  fetchLinkedPageImpl: (url: string) => Promise<LinkedSource | null>,
  resolveShortUrlImpl: (url: string) => Promise<string | null>,
): Promise<LinkedSource | null> {
  const tweetId = extractTweetIdFromStatusUrl(url);
  if (!tweetId) return null;

  let quotedTweet: TwitterCliTweet | null;
  try {
    quotedTweet = await fetchTwitterTweetViaCli(tweetId);
  } catch (error) {
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
  Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>[]
> {
  const publicationUrl = process.env.SUBSTACK_PUBLICATION_URL;
  if (!publicationUrl) {
    throw new Error('Substack source 已启用，但缺少 SUBSTACK_PUBLICATION_URL');
  }

  const handle = deriveSubstackProfileHandle(publicationUrl);
  const html = await fetchSubstackText(`https://substack.com/@${handle}`);
  return parsePublicSubstackSubscriptions(html);
}

function buildPublicationFeedUrl(
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>,
): string {
  return new URL('/feed', publication.url).toString();
}

async function fetchPublicationFeed(
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>,
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
    },
    posts: parsed.posts,
  };
}

function warnSubstackFeedFailure(
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>,
  error: unknown,
): void {
  const proxy = resolveHttpProxy();
  const feedUrl = buildPublicationFeedUrl(publication);
  console.warn(
    `[collect] 跳过 Substack publication feed: publication="${publication.name}" publicationUrl=${publication.url} feedUrl=${feedUrl} proxy=${proxy ?? 'disabled'} error=${summarizeError(error)}`,
  );
}

async function collectViaCli(listId: string, maxTweets: number): Promise<CollectedItem[]> {
  const proxy = resolveHttpProxy();
  console.log(`[collect] 使用 twitter-cli 采集`);

  const { stdout, stderr } = await execAsync(
    buildTwitterCliCommand(listId, maxTweets, proxy),
    { maxBuffer: 50 * 1024 * 1024 },
  );

  if (stderr && !stderr.includes('Getting Twitter cookies')) {
    console.warn(`[collect] twitter-cli stderr: ${stderr}`);
  }

  const result = JSON.parse(stdout) as TwitterCliOutput;

  if (!result.ok) {
    throw new Error('twitter-cli returned ok=false');
  }

  return result.data.map(mapTwitterCliTweet);
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

  const fetchTwitterRepliesViaApiImpl = options.fetchTwitterRepliesViaApi ?? fetchTwitterRepliesViaApi;
  const fetchTwitterRepliesViaCliImpl = options.fetchTwitterRepliesViaCli ?? fetchTwitterRepliesViaCli;

  if (process.env.TWITTERAPI_KEY) {
    try {
      return await fetchTwitterRepliesViaApiImpl(item.id, maxReplies);
    } catch (error) {
      console.warn(`[collect] twitterapi replies 失败，回退到 twitter-cli: ${error}`);
    }
  }

  try {
    return await fetchTwitterRepliesViaCliImpl(item.id, maxReplies);
  } catch (error) {
    console.warn(`[collect] twitter-cli replies 失败，跳过 replies: ${error}`);
    return [];
  }
}

export async function resolveTwitterPrimarySource(
  item: CollectedItem,
  options: ResolveTwitterPrimarySourceOptions = {},
): Promise<CollectedItem> {
  if (item.source !== 'twitter') return item;

  const fetchLinkedPageImpl = options.fetchLinkedPage ?? fetchLinkedPage;
  const fetchTwitterRepliesImpl = options.fetchTwitterReplies ?? fetchTwitterReplies;
  const resolveShortUrlImpl = options.resolveShortUrl ?? resolveShortUrl;
  const fetchQuotedPrimarySourceImpl =
    options.fetchQuotedPrimarySource ??
    ((url: string) => fetchQuotedPrimarySource(url, fetchLinkedPageImpl, resolveShortUrlImpl));
  const enrichedCandidates = await enrichTwitterTextCandidates(item, resolveShortUrlImpl);
  const enrichedItem = {
    ...item,
    outboundLinks: enrichedCandidates.outboundLinks,
    embeddedLinkedSource: enrichedCandidates.embeddedLinkedSource ?? item.embeddedLinkedSource,
    quotedStatusUrl: enrichedCandidates.quotedStatusUrl ?? item.quotedStatusUrl,
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

  if (tweetLinks.length === 0 && enrichedItem.quotedStatusUrl) {
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

  const replyContext =
    tweetLinks.length === 0 && shouldFetchRepliesForPrimarySource(enrichedItem)
      ? await fetchTwitterRepliesImpl(enrichedItem, 1)
      : [];
  const replyLinks = dedupeUrls(replyContext.flatMap((reply) => reply.outboundLinks));
  const candidateLinks = tweetLinks.length > 0 ? tweetLinks : replyLinks;

  if (candidateLinks.length === 0) {
    if (enrichedItem.embeddedLinkedSource) {
      return useEmbeddedLinkedSource(replyContext);
    }

    // Fallback: check if the author posted a reply with a link to the full article
    const authorReplySource = await findAuthorReplySource(
      enrichedItem,
      fetchTwitterRepliesImpl,
      fetchLinkedPageImpl,
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
    if (enrichedItem.quotedStatusUrl) {
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

    // Fallback: check if the author posted a reply with a link to the full article
    const authorReplySource = await findAuthorReplySource(
      enrichedItem,
      fetchTwitterRepliesImpl,
      fetchLinkedPageImpl,
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
  const resolved: CollectedItem[] = [];

  for (const item of items) {
    resolved.push(await resolveTwitterPrimarySourceImpl(item));
  }

  return resolved;
}

async function collectTwitterItems(sinceTime: number): Promise<CollectedItem[]> {
  const listId = process.env.TWITTER_LIST_ID ?? '1602502639287435265';
  console.log(
    `[collect] 采集 Twitter listId=${listId}，sinceTime=${new Date(sinceTime * 1000).toLocaleString('zh-CN')}`,
  );

  let items: CollectedItem[];

  try {
    items = await collectViaCli(listId, MAX_TWEETS);
  } catch (cliError) {
    console.warn(`[collect] twitter-cli 失败: ${cliError}`);
    console.error(`❌ || cliError error`, cliError);

    if (!process.env.TWITTERAPI_KEY) {
      throw new Error('twitter-cli 失败且未配置 TWITTERAPI_KEY，无法回退');
    }

    console.log('[collect] 回退到 twitterapi.io...');
    items = await collectViaApi(listId, sinceTime, MAX_TWEETS);
  }

  const filtered = filterSinceTime(items, sinceTime);
  const resolved = await resolveTwitterPrimarySources(filtered);
  console.log(`[collect] Twitter 完成，共采集 ${resolved.length} 条内容`);
  return sortNewestFirst(resolved);
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
    media: Array.isArray(tweet.media)
      ? tweet.media.flatMap((item) => {
          const normalized = normalizeMediaItem(item);
          return normalized ? [normalized] : [];
        })
      : [],
    likeCount: toOptionalNumber(tweet.likeCount),
    replyCount: toOptionalNumber(tweet.replyCount),
    repostCount: toOptionalNumber(tweet.repostCount),
    quoteCount: toOptionalNumber(tweet.quoteCount),
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
  publication: Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>,
): CollectedItem {
  const body = resolveSubstackBody(post);
  const coverImage =
    typeof post.coverImage === 'string' && post.coverImage.trim().length > 0
      ? [{ type: 'photo', url: post.coverImage.trim() }]
      : [];

  return {
    id: `substack-${post.id}`,
    source: 'substack',
    title: post.title,
    subtitle: post.subtitle ?? null,
    text: resolveSubstackText(post, body),
    body,
    publishedAt: resolveSubstackDate(post.publishedAt),
    url: post.url,
    author: { name: publication.name },
    publication: {
      name: publication.name,
      handle: publication.handle ?? publication.slug,
      url: publication.url,
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

    for (const publication of publications) {
      let feed: PublicSubstackFeed;
      try {
        feed = await fetchFeed(publication);
      } catch (error) {
        warnSubstackFeedFailure(publication, error);
        continue;
      }
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

  const sorted = sortNewestFirst(items).slice(0, maxPosts);
  console.log(`[collect] Substack 完成，共采集 ${sorted.length} 篇文章`);
  return sorted;
}

export async function collectSources({
  enabledSources,
  nowSeconds,
  state,
  collectors,
}: CollectSourcesOptions): Promise<{ items: CollectedItem[]; state: RunState }> {
  const mergedItems: CollectedItem[] = [];
  const nextState: RunState = {
    sources: {
      twitter: { lastRunTime: state.sources.twitter.lastRunTime },
      substack: { lastRunTime: state.sources.substack.lastRunTime },
    },
  };

  for (const source of enabledSources) {
    const collectSource = collectors[source];
    const sinceTime = getSourceSinceTime(state, source, nowSeconds);
    const items = await collectSource(sinceTime);
    mergedItems.push(...items);
    nextState.sources[source] = { lastRunTime: nowSeconds };
  }

  return {
    items: sortNewestFirst(mergedItems),
    state: nextState,
  };
}

function parseEnabledSources(): SourceName[] {
  const raw = process.env.ENABLED_SOURCES ?? 'twitter';
  const sources = raw
    .split(',')
    .map((value) => value.trim())
    .filter((value): value is SourceName => value === 'twitter' || value === 'substack');

  return sources.length > 0 ? Array.from(new Set(sources)) : ['twitter'];
}

export async function collect(): Promise<CollectedItem[]> {
  const state = await readState();
  const nowSeconds = Math.floor(Date.now() / 1000);
  const enabledSources = parseEnabledSources();

  const { items, state: nextState } = await collectSources({
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
    },
  });

  await writeState(nextState);
  console.log(`[collect] 完成，共采集 ${items.length} 条跨来源内容`);
  return items;
}
