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
