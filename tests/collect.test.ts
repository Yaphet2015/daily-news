import test from 'node:test';
import assert from 'node:assert/strict';
import * as collectModule from '../src/collect.js';

test('mapTwitterCliTweet preserves empty media arrays', () => {
  const tweet = collectModule.mapTwitterCliTweet({
    id: '1',
    text: 'hello',
    author: {
      id: 'u1',
      name: 'Alice',
      screenName: 'alice',
    },
    createdAt: '2026-03-15T00:00:00Z',
    media: [],
  });

  assert.deepEqual(tweet.media, []);
  assert.equal(tweet.url, 'https://x.com/alice/status/1');
  assert.equal(tweet.originUrl, 'https://x.com/alice/status/1');
  assert.deepEqual(tweet.outboundLinks, []);
});

test('mapTwitterCliTweet preserves structured outbound links for later source resolution', () => {
  const tweet = collectModule.mapTwitterCliTweet({
    id: '1b',
    text: 'docs https://t.co/short',
    author: {
      id: 'u1b',
      name: 'Alice',
      screenName: 'alice',
    },
    createdAt: '2026-03-15T00:00:00Z',
    media: [],
    urls: ['https://docs.example.com/launch?utm_source=x', 'https://x.com/ignored/status/1'],
  } as never);

  assert.equal(tweet.originUrl, 'https://x.com/alice/status/1b');
  assert.deepEqual(tweet.outboundLinks, ['https://docs.example.com/launch']);
});

test('mapTwitterCliTweet preserves quoted X status hints for later source resolution', () => {
  const tweet = collectModule.mapTwitterCliTweet({
    id: '1c',
    text: 'Complete guide https://t.co/quoted',
    author: {
      id: 'u1c',
      name: 'Alice',
      screenName: 'alice',
    },
    createdAt: '2026-03-15T00:00:00Z',
    media: [],
    urls: [],
    quotedTweet: {
      id: 'quoted-1',
      text: 'The full guide lives here',
      author: {
        name: 'AI Edge',
        screenName: 'aiedge_',
      },
    },
  } as never);

  assert.equal(tweet.embeddedLinkedSource, undefined);
  assert.equal(tweet.quotedStatusUrl, 'https://x.com/aiedge_/status/quoted-1');
});

test('isLikelyPrimarySourceUrl only accepts external articles/pages and X articles', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).isLikelyPrimarySourceUrl, 'function');

  const isLikelyPrimarySourceUrl = (collectModule as Record<string, Function>).isLikelyPrimarySourceUrl;

  assert.equal(isLikelyPrimarySourceUrl('https://docs.example.com/launch'), true);
  assert.equal(isLikelyPrimarySourceUrl('https://x.com/i/article/2034035257553690624'), true);
  assert.equal(isLikelyPrimarySourceUrl('https://x.com/aiedge_/status/2036815449225298369'), false);
  assert.equal(isLikelyPrimarySourceUrl('https://www.youtube.com/watch?v=123'), false);
});

test('mapTwitterCliTweet preserves mixed media from twitter-cli', () => {
  const tweet = collectModule.mapTwitterCliTweet({
    id: '2',
    text: 'media',
    author: {
      id: 'u2',
      name: 'Bob',
      screenName: 'bob',
    },
    createdAt: '2026-03-15T00:00:00Z',
    media: [
      { type: 'photo', url: 'https://img/1.jpg', width: 1200, height: 675 },
      { type: 'video', url: 'https://video/1.mp4', width: 1920, height: 1080 },
    ],
  });

  assert.deepEqual(tweet.media, [
    { type: 'photo', url: 'https://img/1.jpg', width: 1200, height: 675 },
    { type: 'video', url: 'https://video/1.mp4', width: 1920, height: 1080 },
  ]);
});

test('mapTwitterCliTweet preserves optional engagement metrics', () => {
  const tweet = collectModule.mapTwitterCliTweet({
    id: '2b',
    text: 'metrics',
    author: {
      id: 'u2b',
      name: 'Bob',
      screenName: 'bob',
    },
    createdAt: '2026-03-15T00:00:00Z',
    media: [],
    likeCount: 11,
    replyCount: 3,
    repostCount: 5,
    quoteCount: 2,
  } as never);

  assert.equal(tweet.likeCount, 11);
  assert.equal(tweet.replyCount, 3);
  assert.equal(tweet.repostCount, 5);
  assert.equal(tweet.quoteCount, 2);
});

test('mapTwitterApiTweet extracts photo media when fallback payload includes it', () => {
  const tweet = collectModule.mapTwitterApiTweet({
    id: '3',
    text: 'fallback',
    author: {
      name: 'Carol',
      userName: 'carol',
    },
    createdAt: '2026-03-15T00:00:00Z',
    media: {
      photos: [
        { media_url_https: 'https://img/2.jpg', original_info: { width: 800, height: 600 } },
      ],
    },
  });

  assert.deepEqual(tweet.media, [
    { type: 'photo', url: 'https://img/2.jpg', width: 800, height: 600 },
  ]);
});

test('mapTwitterApiTweet degrades to empty media when fallback payload has none', () => {
  const tweet = collectModule.mapTwitterApiTweet({
    id: '4',
    text: 'no media',
    author: {
      name: 'Dana',
      userName: 'dana',
    },
    createdAt: '2026-03-15T00:00:00Z',
  });

  assert.deepEqual(tweet.media, []);
});

test('mapTwitterApiTweet preserves optional engagement metrics', () => {
  const tweet = collectModule.mapTwitterApiTweet({
    id: '4b',
    text: 'metrics',
    author: {
      name: 'Dana',
      userName: 'dana',
    },
    createdAt: '2026-03-15T00:00:00Z',
    favorite_count: 21,
    reply_count: 4,
    retweet_count: 7,
    quote_count: 3,
  } as never);

  assert.equal(tweet.likeCount, 21);
  assert.equal(tweet.replyCount, 4);
  assert.equal(tweet.repostCount, 7);
  assert.equal(tweet.quoteCount, 3);
});

test('mapSubstackPost preserves full body, source metadata, and cover image', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).mapSubstackPost, 'function');

  const mapSubstackPost = (collectModule as Record<string, Function>).mapSubstackPost;
  const item = mapSubstackPost(
    {
      id: 42,
      title: 'The model launch',
      subtitle: 'A closer look',
      body: 'Full article body',
      truncatedBody: 'Short summary',
      publishedAt: new Date('2026-03-15T08:00:00Z'),
      url: 'https://example.substack.com/p/model-launch',
      coverImage: 'https://img.example/cover.jpg',
    },
    {
      handle: 'examplepub',
      name: 'Example Publication',
      url: 'https://example.substack.com',
    },
  );

  assert.deepEqual(item, {
    id: 'substack-42',
    source: 'substack',
    title: 'The model launch',
    subtitle: 'A closer look',
    text: 'Short summary',
    body: 'Full article body',
    publishedAt: '2026-03-15T08:00:00.000Z',
    url: 'https://example.substack.com/p/model-launch',
    author: { name: 'Example Publication' },
    publication: {
      name: 'Example Publication',
      handle: 'examplepub',
      url: 'https://example.substack.com',
    },
    media: [{ type: 'photo', url: 'https://img.example/cover.jpg' }],
  });
});

test('parsePublicSubstackSubscriptions extracts followed publications from public profile HTML', () => {
  assert.equal(
    typeof (collectModule as Record<string, unknown>).parsePublicSubstackSubscriptions,
    'function',
  );

  const parsePublicSubstackSubscriptions = (collectModule as Record<string, Function>)
    .parsePublicSubstackSubscriptions;

  const html = String.raw`<script>window._preloads = JSON.parse("{\"profile\":{\"visibleSubscriptionsCount\":2,\"subscriptions\":[{\"publication\":{\"name\":\"Simon Willison's Newsletter\",\"subdomain\":\"simonw\",\"custom_domain\":null}}, {\"publication\":{\"name\":\"AI Frontiers\",\"subdomain\":\"aifrontiersmedia\",\"custom_domain\":\"www.ai-frontiers.org\"}}]}}")</script>`;

  assert.deepEqual(parsePublicSubstackSubscriptions(html), [
    {
      name: "Simon Willison's Newsletter",
      handle: 'simonw',
      slug: 'simonw',
      url: 'https://simonw.substack.com',
    },
    {
      name: 'AI Frontiers',
      handle: 'aifrontiersmedia',
      slug: 'aifrontiersmedia',
      url: 'https://www.ai-frontiers.org',
    },
  ]);
});

test('parseSubstackFeed extracts recent post metadata from RSS', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).parseSubstackFeed, 'function');

  const parseSubstackFeed = (collectModule as Record<string, Function>).parseSubstackFeed;

  const xml = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
  <channel>
    <title><![CDATA[Simon Willison's Newsletter]]></title>
    <link>https://simonw.substack.com</link>
    <item>
      <title><![CDATA[Can coding agents relicense open source?]]></title>
      <description><![CDATA[GPT-5.4 and Gemini 3.1 Flash-Lite]]></description>
      <link>https://simonw.substack.com/p/can-coding-agents-relicense-open</link>
      <pubDate>Fri, 06 Mar 2026 03:55:36 GMT</pubDate>
      <enclosure url="https://substackcdn.com/image/fetch/example.jpeg" length="0" type="image/jpeg"/>
      <content:encoded><![CDATA[<p>In this newsletter:</p><p>Plus links and notes.</p>]]></content:encoded>
    </item>
  </channel>
</rss>`;

  assert.deepEqual(parseSubstackFeed(xml), {
    publication: {
      name: "Simon Willison's Newsletter",
      handle: 'simonw',
      slug: 'simonw',
      url: 'https://simonw.substack.com',
    },
    posts: [
      {
        id: 'https://simonw.substack.com/p/can-coding-agents-relicense-open',
        title: 'Can coding agents relicense open source?',
        subtitle: 'GPT-5.4 and Gemini 3.1 Flash-Lite',
        body: 'In this newsletter: Plus links and notes.',
        truncatedBody: 'GPT-5.4 and Gemini 3.1 Flash-Lite',
        publishedAt: '2026-03-06T03:55:36.000Z',
        url: 'https://simonw.substack.com/p/can-coding-agents-relicense-open',
        coverImage: 'https://substackcdn.com/image/fetch/example.jpeg',
      },
    ],
  });
});

test('buildSubstackCurlArgs routes requests through HTTP_PROXY', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).buildSubstackCurlArgs, 'function');

  const buildSubstackCurlArgs = (collectModule as Record<string, Function>).buildSubstackCurlArgs;

  assert.deepEqual(buildSubstackCurlArgs('https://substack.com/@yaphetyan', 'http://127.0.0.1:6152'), [
    '-fsSL',
    '--compressed',
    '--connect-timeout',
    '10',
    '--max-time',
    '20',
    '--proxy',
    'http://127.0.0.1:6152',
    '-H',
    'Accept: text/html,application/rss+xml,application/xml,text/xml;q=0.9,*/*;q=0.8',
    'https://substack.com/@yaphetyan',
  ]);
});

test('buildTwitterCliCommand exports HTTP_PROXY for twitter-cli', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).buildTwitterCliCommand, 'function');

  const buildTwitterCliCommand = (collectModule as Record<string, Function>).buildTwitterCliCommand;

  assert.equal(
    buildTwitterCliCommand('1602502639287435265', 500, 'http://127.0.0.1:6152'),
    'HTTP_PROXY=http://127.0.0.1:6152 HTTPS_PROXY=http://127.0.0.1:6152 twitter list 1602502639287435265 --max 500 --json',
  );
});

test('parseTwitterCliReplyPayload accepts wrapped twitter-cli reply payloads', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).parseTwitterCliReplyPayload, 'function');

  const parseTwitterCliReplyPayload = (collectModule as Record<string, Function>).parseTwitterCliReplyPayload;
  const parsed = parseTwitterCliReplyPayload({
    ok: true,
    data: [
      {
        id: 'root',
        text: 'root tweet',
        author: { id: 'u0', name: 'Alice', screenName: 'alice' },
        createdAt: '2026-03-15T09:00:00Z',
        urls: [],
      },
      {
        id: 'reply-1',
        text: 'reply tweet',
        author: { id: 'u1', name: 'Bob', screenName: 'bob' },
        createdAt: '2026-03-15T09:01:00Z',
        urls: ['https://docs.example.com/launch?utm_source=x'],
      },
    ],
  });

  assert.deepEqual(parsed.map((tweet: { id: string }) => tweet.id), ['root', 'reply-1']);
});

test('parseTwitterCliReplyPayload accepts legacy bare reply arrays', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).parseTwitterCliReplyPayload, 'function');

  const parseTwitterCliReplyPayload = (collectModule as Record<string, Function>).parseTwitterCliReplyPayload;
  const parsed = parseTwitterCliReplyPayload([
    {
      id: 'root',
      text: 'root tweet',
      author: { id: 'u0', name: 'Alice', screenName: 'alice' },
      createdAt: '2026-03-15T09:00:00Z',
      urls: [],
    },
    {
      id: 'reply-1',
      text: 'reply tweet',
      author: { id: 'u1', name: 'Bob', screenName: 'bob' },
      createdAt: '2026-03-15T09:01:00Z',
      urls: [],
    },
  ]);

  assert.deepEqual(parsed.map((tweet: { id: string }) => tweet.id), ['root', 'reply-1']);
});

test('parseTwitterCliReplyPayload rejects wrapped twitter-cli reply payloads with ok=false', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).parseTwitterCliReplyPayload, 'function');

  const parseTwitterCliReplyPayload = (collectModule as Record<string, Function>).parseTwitterCliReplyPayload;

  assert.throws(
    () => parseTwitterCliReplyPayload({ ok: false, data: [], error: 'rate limited' }),
    /twitter-cli replies returned ok=false/i,
  );
});

test('fetchTwitterReplies falls back to empty reply context when twitter-cli reply parsing fails', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).fetchTwitterReplies, 'function');

  const fetchTwitterReplies = (collectModule as Record<string, Function>).fetchTwitterReplies;
  const replies = await fetchTwitterReplies(
    {
      id: 'tw-replies',
      source: 'twitter',
      text: 'root tweet',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/tw-replies',
      originUrl: 'https://x.com/alice/status/tw-replies',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: [],
    },
    3,
    {
      fetchTwitterRepliesViaCli: async () => {
        throw new Error('twitter-cli replies returned ok=false');
      },
    },
  );

  assert.deepEqual(replies, []);
});

test('shouldFetchRepliesForPrimarySource only enables reply lookup for wrapper-like tweets without outbound links', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).shouldFetchRepliesForPrimarySource, 'function');

  const shouldFetchRepliesForPrimarySource = (collectModule as Record<string, Function>)
    .shouldFetchRepliesForPrimarySource;

  assert.equal(
    shouldFetchRepliesForPrimarySource({
      id: 'wrapper',
      source: 'twitter',
      text: 'Read more here',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/wrapper',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: [],
    }),
    true,
  );

  assert.equal(
    shouldFetchRepliesForPrimarySource({
      id: 'already-has-link',
      source: 'twitter',
      text: 'Read more here',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/already-has-link',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: ['https://docs.example.com/launch'],
    }),
    false,
  );

  assert.equal(
    shouldFetchRepliesForPrimarySource({
      id: 'non-wrapper',
      source: 'twitter',
      text:
        'I spent the morning comparing the new version with the previous one. The onboarding flow is cleaner. The benchmark methodology is still weak. My main takeaway is that the product direction improved even if the marketing copy oversells it.',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/non-wrapper',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: [],
    }),
    false,
  );
});

test('resolveTwitterPrimarySource skips reply lookup for non-wrapper tweets without outbound links', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-no-reply-fetch',
      source: 'twitter',
      text:
        'I spent the morning comparing the new version with the previous one. The onboarding flow is cleaner. The benchmark methodology is still weak. My main takeaway is that the product direction improved even if the marketing copy oversells it.',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/tw-no-reply-fetch',
      originUrl: 'https://x.com/alice/status/tw-no-reply-fetch',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: [],
    },
    {
      fetchTwitterReplies: async () => {
        throw new Error('should not fetch replies');
      },
    },
  );

  assert.deepEqual(resolved.replyContext, []);
  assert.deepEqual(resolved.sourceResolution, { decision: 'keep_origin', reason: 'no_linked_source' });
});

test('resolveTwitterPrimarySource uses the latest reply link when wrapper tweets have no outbound links', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-latest-reply',
      source: 'twitter',
      text: 'Read more here',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/tw-latest-reply',
      originUrl: 'https://x.com/alice/status/tw-latest-reply',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: [],
    },
    {
      fetchTwitterReplies: async (_item: unknown, maxReplies: number) => {
        assert.equal(maxReplies, 1);
        return [
          {
            id: 'reply-1',
            text: '@alice official docs',
            author: { name: 'Alice', username: 'alice' },
            publishedAt: '2026-03-15T09:01:00Z',
            url: 'https://x.com/alice/status/reply-1',
            outboundLinks: ['https://docs.example.com/launch'],
          },
        ];
      },
      fetchLinkedPage: async (url: string) => ({
        url,
        title: 'Docs Launch',
        description: 'Official docs for the launch',
        excerpt: 'Official docs for the launch with details.',
        domain: 'docs.example.com',
        via: 'reply',
      }),
    },
  );

  assert.equal(resolved.url, 'https://docs.example.com/launch');
  assert.deepEqual(resolved.replyContext, [
    {
      id: 'reply-1',
      text: '@alice official docs',
      author: { name: 'Alice', username: 'alice' },
      publishedAt: '2026-03-15T09:01:00Z',
      url: 'https://x.com/alice/status/reply-1',
      outboundLinks: ['https://docs.example.com/launch'],
    },
  ]);
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'reply_wrapper' });
});

test('resolveTwitterPrimarySource resolves text-only t.co links into outboundLinks and primary source', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-text-short-link',
      source: 'twitter',
      text: 'Read more here https://t.co/short',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/tw-text-short-link',
      originUrl: 'https://x.com/alice/status/tw-text-short-link',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: [],
    },
    {
      resolveShortUrl: async (url: string) => {
        assert.equal(url, 'https://t.co/short');
        return 'https://docs.example.com/launch?utm_source=x';
      },
      fetchLinkedPage: async (url: string) => ({
        url,
        title: 'Docs Launch',
        description: 'Official docs for the launch',
        excerpt: 'Official docs for the launch with details.',
        domain: 'docs.example.com',
        via: 'tweet',
      }),
      fetchTwitterReplies: async () => {
        throw new Error('should not fetch replies');
      },
    },
  );

  assert.deepEqual(resolved.outboundLinks, ['https://docs.example.com/launch']);
  assert.equal(resolved.url, 'https://docs.example.com/launch');
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'tweet_wrapper' });
});

test('resolveTwitterPrimarySource prefers quoted X article sources over reply lookup', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const resolved = await resolveTwitterPrimarySource({
    id: 'tw-quoted-source',
    source: 'twitter',
    text: 'Complete guide https://t.co/quoted',
    publishedAt: '2026-03-15T09:00:00Z',
    url: 'https://x.com/alice/status/tw-quoted-source',
    originUrl: 'https://x.com/alice/status/tw-quoted-source',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: [],
    quotedStatusUrl: 'https://x.com/aiedge_/status/quoted-1',
  }, {
    resolveShortUrl: async () => 'https://x.com/aiedge_/status/quoted-1',
    fetchQuotedPrimarySource: async (url: string) => {
      assert.equal(url, 'https://x.com/aiedge_/status/quoted-1');
      return {
        url: 'https://x.com/i/article/2034035257553690624',
        title: 'Claude Skills: Ultimate Guide (March 2026)',
        description: 'X article',
        excerpt: 'The full guide lives here',
        domain: 'x.com',
        via: 'quote',
      };
    },
    fetchTwitterReplies: async () => {
      throw new Error('should not fetch replies');
    },
  });

  assert.equal(resolved.url, 'https://x.com/i/article/2034035257553690624');
  assert.equal(resolved.sourceLabel, 'Claude Skills: Ultimate Guide (March 2026)');
  assert.deepEqual(resolved.linkedSource, {
    url: 'https://x.com/i/article/2034035257553690624',
    title: 'Claude Skills: Ultimate Guide (March 2026)',
    description: 'X article',
    excerpt: 'The full guide lives here',
    domain: 'x.com',
    via: 'quote',
  });
  assert.deepEqual(resolved.replyContext, []);
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'quote_wrapper' });
});

test('resolveTwitterPrimarySource skips short-link resolution when structured outbound links already exist', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-structured-link',
      source: 'twitter',
      text: 'Read more here https://t.co/short',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/tw-structured-link',
      originUrl: 'https://x.com/alice/status/tw-structured-link',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: ['https://docs.example.com/launch'],
    },
    {
      resolveShortUrl: async () => {
        throw new Error('should not resolve short links');
      },
      fetchLinkedPage: async (url: string) => ({
        url,
        title: 'Docs Launch',
        description: 'Official docs for the launch',
        excerpt: 'Official docs for the launch with details.',
        domain: 'docs.example.com',
        via: 'tweet',
      }),
    },
  );

  assert.deepEqual(resolved.outboundLinks, ['https://docs.example.com/launch']);
  assert.equal(resolved.url, 'https://docs.example.com/launch');
});

test('resolveTwitterPrimarySources processes items concurrently with bounded concurrency', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySources, 'function');

  const resolveTwitterPrimarySources = (collectModule as Record<string, Function>).resolveTwitterPrimarySources;
  let inFlight = 0;
  let maxInFlight = 0;

  const resolved = await resolveTwitterPrimarySources(
    [
      {
        id: 'tw-1',
        source: 'twitter',
        text: 'Read more here',
        publishedAt: '2026-03-15T09:00:00Z',
        url: 'https://x.com/alice/status/tw-1',
        originUrl: 'https://x.com/alice/status/tw-1',
        author: { name: 'Alice', username: 'alice' },
        media: [],
        outboundLinks: [],
      },
      {
        id: 'tw-2',
        source: 'twitter',
        text: 'Read more here too',
        publishedAt: '2026-03-15T09:00:30Z',
        url: 'https://x.com/bob/status/tw-2',
        originUrl: 'https://x.com/bob/status/tw-2',
        author: { name: 'Bob', username: 'bob' },
        media: [],
        outboundLinks: [],
      },
    ],
    {
      resolveTwitterPrimarySource: async (item: { id: string }) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 5));
        inFlight -= 1;
        return {
          id: item.id,
        };
      },
    },
  );

  assert.ok(maxInFlight >= 1 && maxInFlight <= 2, `expected maxInFlight between 1 and 2, got ${maxInFlight}`);
  assert.deepEqual(resolved.map((item: { id: string }) => item.id), ['tw-1', 'tw-2']);
});

test('resolveTwitterPrimarySource keeps the origin tweet when linked-page fetch fails', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const item = {
    id: 'tw-fail-open',
    source: 'twitter',
    text: 'Read more here',
    publishedAt: '2026-03-15T09:00:00Z',
    url: 'https://x.com/alice/status/tw-fail-open',
    originUrl: 'https://x.com/alice/status/tw-fail-open',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: ['https://cursor.directory'],
  };

  const resolved = await resolveTwitterPrimarySource(item, {
    fetchLinkedPage: async () => {
      throw new Error('429 Too Many Requests');
    },
  });

  assert.equal(resolved.url, item.originUrl);
  assert.equal(resolved.linkedSource, undefined);
  assert.deepEqual(resolved.sourceResolution, { decision: 'keep_origin', reason: 'no_linked_source' });
});

test('resolveTwitterPrimarySource continues to later links after an earlier linked-page failure', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const item = {
    id: 'tw-later-link',
    source: 'twitter',
    text: 'Read more here',
    publishedAt: '2026-03-15T09:00:00Z',
    url: 'https://x.com/alice/status/tw-later-link',
    originUrl: 'https://x.com/alice/status/tw-later-link',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: ['https://cursor.directory', 'https://docs.example.com/launch'],
  };

  const resolved = await resolveTwitterPrimarySource(item, {
    fetchLinkedPage: async (url: string) => {
      if (url === 'https://cursor.directory') {
        throw new Error('429 Too Many Requests');
      }

      return {
        url,
        title: 'Docs Launch',
        description: 'Release notes and documentation for the launch',
        excerpt: 'Release notes and documentation for the new launch.',
        domain: 'docs.example.com',
        via: 'tweet',
      };
    },
  });

  assert.equal(resolved.url, 'https://docs.example.com/launch');
  assert.equal(resolved.sourceLabel, 'Docs Launch');
  assert.deepEqual(resolved.linkedSource, {
    url: 'https://docs.example.com/launch',
    title: 'Docs Launch',
    description: 'Release notes and documentation for the launch',
    excerpt: 'Release notes and documentation for the new launch.',
    domain: 'docs.example.com',
    via: 'tweet',
  });
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'tweet_wrapper' });
});

test('resolveTwitterPrimarySource falls back to the origin tweet when all linked pages fail', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const item = {
    id: 'tw-all-fail',
    source: 'twitter',
    text: 'Read more here',
    publishedAt: '2026-03-15T09:00:00Z',
    url: 'https://x.com/alice/status/tw-all-fail',
    originUrl: 'https://x.com/alice/status/tw-all-fail',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: ['https://cursor.directory', 'https://docs.example.com/launch'],
  };

  const resolved = await resolveTwitterPrimarySource(item, {
    fetchLinkedPage: async () => {
      throw new Error('blocked');
    },
  });

  assert.equal(resolved.url, item.originUrl);
  assert.equal(resolved.linkedSource, undefined);
  assert.deepEqual(resolved.sourceResolution, { decision: 'keep_origin', reason: 'no_linked_source' });
});

test('resolveTwitterPrimarySource prefers a linked source for long announcement tweets with strong handoff cues', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-vercel-handoff',
      source: 'twitter',
      text:
        'When Opus 4.5 came out, it was a one-way door to a new way of engineering. Agents now do most of our coding.\n\n' +
        'Knowing the inherent flaws and over-confidence of LLMs, we sent a clear message to our teams. Vibing and mission-critical infrastructure don’t go together.\n\n' +
        'We’re sharing some of our early internal guidance in how we’re “agenting responsibly”, prioritizing security, durability, and availability at all times.\n' +
        'https://t.co/b36GiE76Ue',
      publishedAt: '2026-03-30T23:23:40Z',
      url: 'https://x.com/rauchg/status/2038759092442050651',
      originUrl: 'https://x.com/rauchg/status/2038759092442050651',
      author: { name: 'Guillermo Rauch', username: 'rauchg' },
      media: [],
      outboundLinks: [],
    },
    {
      resolveShortUrl: async () => 'https://vercel.com/blog/agent-responsibly',
      fetchLinkedPage: async (url: string) => ({
        url,
        title: 'Agent Responsibly',
        description: 'How Vercel approaches security, durability, and availability with coding agents.',
        excerpt:
          'We are sharing internal guidance on security, durability, availability, and responsible agent usage.',
        domain: 'vercel.com',
        via: 'tweet',
      }),
      fetchTwitterReplies: async () => {
        throw new Error('should not fetch replies');
      },
    },
  );

  assert.deepEqual(resolved.outboundLinks, ['https://vercel.com/blog/agent-responsibly']);
  assert.equal(resolved.url, 'https://vercel.com/blog/agent-responsibly');
  assert.equal(resolved.sourceLabel, 'Agent Responsibly');
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'tweet_wrapper' });
});

test('resolveTwitterPrimarySource prefers the one-hop landing page for long linked summaries with strong overlap', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-agent-report',
      source: 'twitter',
      text:
        '刚刚看到这个 agent of chaos 的工作，更具象感受到，现在 genai 的“连起来能做”的上限已经非常高了，但是真正能在严肃、大规模、大组织里持续运行的系统还是需要非常多工程工作 + human nodes 的。\n\n' +
        '他们搞了一堆自主 agent（openclaw），给一般 harness 的能力，然后 20 个研究人员开始做一些攻防。\n\n' +
        '他们的结论是 Agents 目前在 L2 自主水平：能执行子任务，但无法识别“我已超出自己能力边界，应该交还人类控制”，缺乏 L3 所需的自我监控和主动移交能力。\n\n' +
        '最核心的危险来自 agentic 层带来的新风险：持久内存、工具访问、多方通信和 Agent 间交互。\n\n' +
        'https://t.co/XxM705uxef',
      publishedAt: '2026-03-31T01:12:47Z',
      url: 'https://x.com/wey_gu/status/2038786551480832127',
      originUrl: 'https://x.com/wey_gu/status/2038786551480832127',
      author: { name: 'Wey Gu 古思为', username: 'wey_gu' },
      media: [{ type: 'photo', url: 'https://pbs.twimg.com/media/HEs5jl6asAAKAQv.jpg' }],
      outboundLinks: [],
    },
    {
      resolveShortUrl: async () => 'https://agentsofchaos.baulab.info/report.html',
      fetchLinkedPage: async (url: string) => ({
        url,
        title: 'Agent of Chaos Report',
        description: 'OpenClaw red-team report on agentic risk boundaries and human handoff limits.',
        excerpt:
          'The report studies OpenClaw agents, shows L2 autonomy without reliable self-monitoring, and highlights persistent memory, tool use, multi-party communication, and inter-agent coordination risks.',
        domain: 'agentsofchaos.baulab.info',
        via: 'tweet',
      }),
      fetchTwitterReplies: async () => {
        throw new Error('should not fetch replies');
      },
    },
  );

  assert.deepEqual(resolved.outboundLinks, ['https://agentsofchaos.baulab.info/report.html']);
  assert.equal(resolved.url, 'https://agentsofchaos.baulab.info/report.html');
  assert.equal(resolved.sourceLabel, 'Agent of Chaos Report');
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'tweet_wrapper' });
});

test('resolveTwitterPrimarySource keeps origin for long standalone analysis with low overlap to the linked page', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const item = {
    id: 'tw-standalone-analysis',
    source: 'twitter',
    text:
      'I spent the week comparing agent deployment patterns across large teams. The strongest signal was not raw model quality but org design, escalation discipline, and ownership boundaries.\n\n' +
      'My own view is that most companies are underestimating the operational load of review queues, rollback design, and access scoping. The linked reference mentions one subsystem, but my argument here is broader and mostly independent.\n\n' +
      'I would keep the focus on operating models, not on any single product write-up.\n' +
      'https://t.co/independent',
    publishedAt: '2026-03-31T03:00:00Z',
    url: 'https://x.com/alice/status/tw-standalone-analysis',
    originUrl: 'https://x.com/alice/status/tw-standalone-analysis',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: [],
  };

  const resolved = await resolveTwitterPrimarySource(item, {
    resolveShortUrl: async () => 'https://support.example.com/telescope-warranty',
    fetchLinkedPage: async (url: string) => ({
      url,
      title: 'Telescope Warranty Terms',
      description: 'Support policy for telescope calibration, replacement parts, and shipping claims.',
      excerpt: 'Warranty durations, lens cleaning exclusions, and claims processing steps for physical telescopes.',
      domain: 'support.example.com',
      via: 'tweet',
    }),
    fetchTwitterReplies: async () => {
      throw new Error('should not fetch replies');
    },
  });

  assert.deepEqual(resolved.outboundLinks, ['https://support.example.com/telescope-warranty']);
  assert.equal(resolved.url, item.originUrl);
  assert.equal(resolved.linkedSource, undefined);
  assert.deepEqual(resolved.sourceResolution, { decision: 'keep_origin', reason: 'tweet_has_unique_context' });
});

test('collectSubstackItems keeps only recent posts and honors global and per-publication caps', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collectSubstackItems, 'function');

  const collectSubstackItems = (collectModule as Record<string, Function>).collectSubstackItems;
  const items = await collectSubstackItems({
    sinceTime: Date.parse('2026-03-15T07:30:00Z') / 1000,
    maxPosts: 2,
    maxPostsPerPublication: 2,
    client: {
      ownProfile: async () => ({
        following: async function* () {
          yield {
            handle: 'pub-a',
            name: 'Pub A',
            url: 'https://pub-a.substack.com',
            posts: async function* () {
              yield {
                fullPost: async () => ({
                  id: 1,
                  title: 'Too old',
                  subtitle: null,
                  body: 'old',
                  truncatedBody: 'old',
                  publishedAt: new Date('2026-03-15T07:00:00Z'),
                  url: 'https://pub-a.substack.com/p/old',
                  coverImage: null,
                }),
              };
              yield {
                fullPost: async () => ({
                  id: 2,
                  title: 'Fresh A1',
                  subtitle: null,
                  body: 'a1',
                  truncatedBody: 'a1',
                  publishedAt: new Date('2026-03-15T09:00:00Z'),
                  url: 'https://pub-a.substack.com/p/fresh-a1',
                  coverImage: null,
                }),
              };
              yield {
                fullPost: async () => ({
                  id: 3,
                  title: 'Fresh A2',
                  subtitle: null,
                  body: 'a2',
                  truncatedBody: 'a2',
                  publishedAt: new Date('2026-03-15T10:00:00Z'),
                  url: 'https://pub-a.substack.com/p/fresh-a2',
                  coverImage: null,
                }),
              };
            },
          };

          yield {
            handle: 'pub-b',
            name: 'Pub B',
            url: 'https://pub-b.substack.com',
            posts: async function* () {
              yield {
                fullPost: async () => ({
                  id: 4,
                  title: 'Fresh B1',
                  subtitle: null,
                  body: 'b1',
                  truncatedBody: 'b1',
                  publishedAt: new Date('2026-03-15T11:00:00Z'),
                  url: 'https://pub-b.substack.com/p/fresh-b1',
                  coverImage: null,
                }),
              };
            },
          };
        },
      }),
    },
  });

  assert.deepEqual(
    items.map((item: { title: string; url: string }) => [item.title, item.url]),
    [
      ['Fresh B1', 'https://pub-b.substack.com/p/fresh-b1'],
      ['Fresh A2', 'https://pub-a.substack.com/p/fresh-a2'],
    ],
  );
});

test('collectSubstackItems skips broken public feeds and logs the curl failure summary', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collectSubstackItems, 'function');

  const collectSubstackItems = (collectModule as Record<string, Function>).collectSubstackItems;
  const warnings: string[] = [];
  const originalWarn = console.warn;
  const originalHttpProxy = process.env.HTTP_PROXY;
  const originalLowerHttpProxy = process.env.http_proxy;

  console.warn = (message?: unknown, ...args: unknown[]) => {
    warnings.push([message, ...args].map((value) => String(value)).join(' '));
  };
  process.env.HTTP_PROXY = 'http://127.0.0.1:6152';
  delete process.env.http_proxy;

  try {
    const items = await collectSubstackItems({
      sinceTime: Date.parse('2026-03-15T07:30:00Z') / 1000,
      maxPosts: 5,
      maxPostsPerPublication: 2,
      deps: {
        fetchPublicSubstackPublications: async () => [
          {
            name: 'Broken Pub',
            handle: 'broken',
            slug: 'broken',
            url: 'https://broken.example.com',
          },
          {
            name: 'Healthy Pub',
            handle: 'healthy',
            slug: 'healthy',
            url: 'https://healthy.example.com',
          },
        ],
        fetchPublicationFeed: async (publication: { handle: string; name: string; url: string }) => {
          if (publication.handle === 'broken') {
            throw new Error(
              'Command failed: curl -fsSL --proxy http://127.0.0.1:6152 https://broken.example.com/feed\ncurl: (28) SSL connection timeout\n',
            );
          }

          return {
            publication: {
              name: publication.name,
              handle: publication.handle,
              slug: publication.handle,
              url: publication.url,
            },
            posts: [
              {
                id: 9,
                title: 'Healthy post',
                subtitle: null,
                body: 'body',
                truncatedBody: 'body',
                publishedAt: new Date('2026-03-15T12:00:00Z'),
                url: 'https://healthy.example.com/p/healthy-post',
                coverImage: null,
              },
            ],
          };
        },
      },
    });

    assert.deepEqual(
      items.map((item: { title: string; url: string }) => [item.title, item.url]),
      [['Healthy post', 'https://healthy.example.com/p/healthy-post']],
    );
    assert.equal(warnings.length, 1);
    assert.match(warnings[0]!, /Broken Pub/);
    assert.match(warnings[0]!, /https:\/\/broken\.example\.com/);
    assert.match(warnings[0]!, /https:\/\/broken\.example\.com\/feed/);
    assert.match(warnings[0]!, /proxy=http:\/\/127\.0\.0\.1:6152/);
    assert.match(warnings[0]!, /curl: \(28\) SSL connection timeout/);
    assert.doesNotMatch(warnings[0]!, /Command failed:/);
  } finally {
    console.warn = originalWarn;

    if (originalHttpProxy === undefined) {
      delete process.env.HTTP_PROXY;
    } else {
      process.env.HTTP_PROXY = originalHttpProxy;
    }

    if (originalLowerHttpProxy === undefined) {
      delete process.env.http_proxy;
    } else {
      process.env.http_proxy = originalLowerHttpProxy;
    }
  }
});

test('collectSubstackItems still fails when SUBSTACK_PUBLICATION_URL is missing', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collectSubstackItems, 'function');

  const collectSubstackItems = (collectModule as Record<string, Function>).collectSubstackItems;
  const originalPublicationUrl = process.env.SUBSTACK_PUBLICATION_URL;

  delete process.env.SUBSTACK_PUBLICATION_URL;

  try {
    await assert.rejects(
      collectSubstackItems({
        sinceTime: Date.parse('2026-03-15T07:30:00Z') / 1000,
      }),
      /缺少 SUBSTACK_PUBLICATION_URL/,
    );
  } finally {
    if (originalPublicationUrl === undefined) {
      delete process.env.SUBSTACK_PUBLICATION_URL;
    } else {
      process.env.SUBSTACK_PUBLICATION_URL = originalPublicationUrl;
    }
  }
});

test('collectSources merges source outputs newest-first and returns a collection snapshot', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collectSources, 'function');

  const collectSources = (collectModule as Record<string, Function>).collectSources;
  const result = await collectSources({
    enabledSources: ['twitter', 'substack'],
    nowSeconds: 1710000000,
    state: {
      sources: {
        twitter: { lastPublishedTime: 100 },
        substack: { lastPublishedTime: 200 },
      },
    },
    collectors: {
      twitter: async () => [
        {
          id: 'tw-1',
          source: 'twitter',
          title: undefined,
          text: 'tweet',
          publishedAt: '2026-03-15T09:00:00Z',
          url: 'https://x.com/alice/status/1',
          author: { name: 'Alice', username: 'alice' },
          media: [],
        },
      ],
      substack: async () => [
        {
          id: 'ss-1',
          source: 'substack',
          title: 'post',
          text: 'article',
          publishedAt: '2026-03-15T10:00:00Z',
          url: 'https://pub.substack.com/p/post',
          author: { name: 'Pub' },
          publication: { name: 'Pub', handle: 'pub', url: 'https://pub.substack.com' },
          media: [],
        },
      ],
    },
  });

  assert.deepEqual(result.items.map((item: { id: string }) => item.id), ['ss-1', 'tw-1']);
  assert.equal(result.collectedAt, 1710000000);
  assert.deepEqual(result.enabledSources, ['twitter', 'substack']);
});

// --- X article metadata fallback ---

test('mapTwitterCliTweet creates embeddedLinkedSource from articleTitle/articleText when no /i/article/ URL exists', () => {
  const tweet = collectModule.mapTwitterCliTweet({
    id: 'article-1',
    text: 'Analysis of the new feature...',
    author: {
      id: 'u1',
      name: '陈成',
      screenName: 'chenchengpro',
    },
    createdAt: '2026-03-25T00:00:00Z',
    media: [],
    articleTitle: 'AI Coding Competition Landscape 2026',
    articleText: 'A deep analysis of the AI coding landscape that covers multiple dimensions.'.repeat(20),
  } as never);

  assert.ok(tweet.embeddedLinkedSource);
  assert.equal(tweet.embeddedLinkedSource!.title, 'AI Coding Competition Landscape 2026');
  assert.equal(tweet.embeddedLinkedSource!.domain, 'x.com');
  assert.equal(tweet.embeddedLinkedSource!.via, 'tweet');
  assert.ok(tweet.embeddedLinkedSource!.excerpt!.length > 0);
});

test('mapTwitterCliTweet does not create article metadata fallback when articleTitle and articleText are empty', () => {
  const tweet = collectModule.mapTwitterCliTweet({
    id: 'no-article',
    text: 'Regular tweet, no article',
    author: {
      id: 'u2',
      name: 'Bob',
      screenName: 'bob',
    },
    createdAt: '2026-03-25T00:00:00Z',
    media: [],
  });

  assert.equal(tweet.embeddedLinkedSource, undefined);
});

// --- Author reply fallback ---

test('resolveTwitterPrimarySource uses author reply source when author replies with a link to a substantial article', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  // Use long text to bypass the existing wrapper-tweet reply resolution path
  const longText = 'Deep analysis of Claude Code feature flags hidden in the source code. '.repeat(20);
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-author-reply',
      source: 'twitter',
      text: longText,
      publishedAt: '2026-03-23T00:00:00Z',
      url: 'https://x.com/chenchengpro/status/tw-author-reply',
      originUrl: 'https://x.com/chenchengpro/status/tw-author-reply',
      author: { name: '陈成', username: 'chenchengpro' },
      media: [],
      outboundLinks: [],
    },
    {
      fetchTwitterReplies: async () => [
        {
          id: 'reply-1',
          text: 'Full blog post: https://blog.example.com/claude-code-flags',
          author: { name: '陈成', username: 'chenchengpro' },
          publishedAt: '2026-03-23T00:01:00Z',
          url: 'https://x.com/chenchengpro/status/reply-1',
          outboundLinks: ['https://blog.example.com/claude-code-flags'],
        },
      ],
      fetchLinkedPage: async (url: string) => ({
        url,
        title: 'Claude Code Feature Flags Deep Dive',
        description: 'A comprehensive analysis of hidden feature flags',
        excerpt: 'A comprehensive analysis of hidden feature flags in Claude Code source code. '.repeat(15),
        domain: 'blog.example.com',
        via: 'reply',
      }),
    },
  );

  assert.equal(resolved.url, 'https://blog.example.com/claude-code-flags');
  assert.equal(resolved.linkedSource!.title, 'Claude Code Feature Flags Deep Dive');
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'author_reply_source' });
});

test('resolveTwitterPrimarySource does not use author reply when reply link leads to a short page', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const longText = 'Deep analysis of Claude Code feature flags hidden in the source code. '.repeat(20);
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-author-reply-short',
      source: 'twitter',
      text: longText,
      publishedAt: '2026-03-23T00:00:00Z',
      url: 'https://x.com/chenchengpro/status/tw-author-reply-short',
      originUrl: 'https://x.com/chenchengpro/status/tw-author-reply-short',
      author: { name: '陈成', username: 'chenchengpro' },
      media: [],
      outboundLinks: [],
    },
    {
      fetchTwitterReplies: async () => [
        {
          id: 'reply-short',
          text: 'Short link',
          author: { name: '陈成', username: 'chenchengpro' },
          publishedAt: '2026-03-23T00:01:00Z',
          url: 'https://x.com/chenchengpro/status/reply-short',
          outboundLinks: ['https://example.com/short'],
        },
      ],
      fetchLinkedPage: async () => ({
        url: 'https://example.com/short',
        title: 'Short Page',
        description: 'Not much here',
        excerpt: 'Short content',
        domain: 'example.com',
        via: 'reply',
      }),
    },
  );

  assert.equal(resolved.url, 'https://x.com/chenchengpro/status/tw-author-reply-short');
  assert.equal(resolved.linkedSource, undefined);
  assert.deepEqual(resolved.sourceResolution, { decision: 'keep_origin', reason: 'no_linked_source' });
});

test('resolveTwitterPrimarySource does not use reply source from a different author', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const longText = 'Deep analysis of Claude Code feature flags hidden in the source code. '.repeat(20);
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-diff-author-reply',
      source: 'twitter',
      text: longText,
      publishedAt: '2026-03-23T00:00:00Z',
      url: 'https://x.com/chenchengpro/status/tw-diff-author-reply',
      originUrl: 'https://x.com/chenchengpro/status/tw-diff-author-reply',
      author: { name: '陈成', username: 'chenchengpro' },
      media: [],
      outboundLinks: [],
    },
    {
      fetchTwitterReplies: async () => [
        {
          id: 'reply-other',
          text: 'Check this out https://blog.example.com/article',
          author: { name: 'Someone Else', username: 'someoneelse' },
          publishedAt: '2026-03-23T00:01:00Z',
          url: 'https://x.com/someoneelse/status/reply-other',
          outboundLinks: ['https://blog.example.com/article'],
        },
      ],
      fetchLinkedPage: async (url: string) => ({
        url,
        title: 'Article',
        description: 'Long article',
        excerpt: 'A'.repeat(600),
        domain: 'blog.example.com',
        via: 'reply',
      }),
    },
  );

  assert.equal(resolved.url, 'https://x.com/chenchengpro/status/tw-diff-author-reply');
  assert.equal(resolved.linkedSource, undefined);
});
