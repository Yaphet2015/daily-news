import { exec, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readState, writeState } from './state.js';
import type { CollectedItem, MediaAsset, RunState, SourceName } from './types.js';

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
  likeCount?: number;
  replyCount?: number;
  repostCount?: number;
  quoteCount?: number;
}

interface TwitterCliOutput {
  ok: boolean;
  data: TwitterCliTweet[];
}

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
}

interface PublicSubstackFeed {
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>;
  posts: SubstackPostLike[];
}

function buildTweetUrl(username: string, id: string): string {
  return `https://x.com/${username}/status/${id}`;
}

function toOptionalNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function toUnixSeconds(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
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

async function fetchSubstackText(url: string): Promise<string> {
  const proxy = resolveHttpProxy();
  const { stdout } = await execFileAsync(
    'curl',
    buildSubstackCurlArgs(url, proxy),
    { maxBuffer: 20 * 1024 * 1024 },
  );
  return stdout;
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

async function fetchPublicationFeed(
  publication: Required<Pick<SubstackPublicationLike, 'name' | 'handle' | 'slug' | 'url'>>,
): Promise<PublicSubstackFeed> {
  const feedUrl = new URL('/feed', publication.url).toString();
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
  console.log(`[collect] Twitter 完成，共采集 ${filtered.length} 条内容`);
  return sortNewestFirst(filtered);
}

export function mapTwitterCliTweet(tweet: TwitterCliTweet): CollectedItem {
  return {
    id: tweet.id,
    source: 'twitter',
    text: tweet.text,
    author: { name: tweet.author.name, username: tweet.author.screenName },
    publishedAt: tweet.createdAt,
    url: buildTweetUrl(tweet.author.screenName, tweet.id),
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
  return {
    id: tweet.id,
    source: 'twitter',
    text: tweet.text,
    author: { name: tweet.author.name, username: tweet.author.userName },
    publishedAt: tweet.createdAt,
    url: tweet.url ?? buildTweetUrl(tweet.author.userName, tweet.id),
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
    const publications = await fetchPublicSubstackPublications();

    for (const publication of publications) {
      const feed = await fetchPublicationFeed(publication);
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
