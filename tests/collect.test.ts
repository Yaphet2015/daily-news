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

test('resolveTwitterPrimarySources processes reply enrichment sequentially', async () => {
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

  assert.equal(maxInFlight, 1);
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

test('collectSources merges source outputs newest-first and updates per-source cursors', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collectSources, 'function');

  const collectSources = (collectModule as Record<string, Function>).collectSources;
  const result = await collectSources({
    enabledSources: ['twitter', 'substack'],
    nowSeconds: 1710000000,
    state: {
      sources: {
        twitter: { lastRunTime: 100 },
        substack: { lastRunTime: 200 },
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
  assert.deepEqual(result.state, {
    sources: {
      twitter: { lastRunTime: 1710000000 },
      substack: { lastRunTime: 1710000000 },
    },
  });
});
