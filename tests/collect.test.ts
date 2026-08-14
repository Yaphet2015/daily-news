import test from 'node:test';
import assert from 'node:assert/strict';
import * as collectModule from '../src/collect.js';

test('redactCollectDiagnosticCommand hides proxy credentials and Twitter auth env values', () => {
  assert.equal(
    collectModule.redactCollectDiagnosticCommand(
      'TWITTER_PROXY=http://user:pass@127.0.0.1:6152 HTTP_PROXY=http://user:pass@127.0.0.1:6152 TWITTER_AUTH_TOKEN=secret TWITTER_CT0=ct0 twitter list 123 --max 5 --json',
    ),
    'TWITTER_PROXY=http://***:***@127.0.0.1:6152 HTTP_PROXY=http://***:***@127.0.0.1:6152 TWITTER_AUTH_TOKEN=<redacted> TWITTER_CT0=<redacted> twitter list 123 --max 5 --json',
  );
});

test('diagnoseCollectEnvironment logs real child-process checks without throwing on failures', async () => {
  const logs: string[] = [];
  const twitterCommands: string[] = [];
  const curlCalls: Array<{ file: string; args: string[] }> = [];

  await collectModule.diagnoseCollectEnvironment({
    env: {
      HTTP_PROXY: 'http://user:pass@127.0.0.1:6152',
      TWITTER_LIST_ID: 'list-1',
    },
    execTwitterCliCommand: async (command) => {
      twitterCommands.push(command);
      throw new Error('No Twitter cookies found.\nmore details');
    },
    execFile: async (file, args) => {
      curlCalls.push({ file, args });
      throw new Error("curl: (7) Failed to connect to 127.0.0.1 port 6152");
    },
    log: (message) => logs.push(message),
  });

  assert.deepEqual(twitterCommands, [
    'TWITTER_PROXY=http://user:pass@127.0.0.1:6152 HTTP_PROXY=http://user:pass@127.0.0.1:6152 HTTPS_PROXY=http://user:pass@127.0.0.1:6152 twitter list list-1 --max 5 --json',
  ]);
  assert.equal(curlCalls[0]?.file, 'curl');
  assert.ok(curlCalls[0]?.args.includes('--proxy'));
  assert.ok(logs.some((line) => line.includes('preflight twitter command=TWITTER_PROXY=http://***:***@127.0.0.1:6152')));
  assert.ok(logs.some((line) => line.includes('preflight twitter failed error=No Twitter cookies found.')));
  assert.ok(logs.some((line) => line.includes('preflight curl failed error=curl: (7) Failed to connect')));
});

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
      htmlBody: '<p>Full article body</p>',
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
    kind: 'substack_post',
    title: 'The model launch',
    subtitle: 'A closer look',
    text: 'Short summary',
    body: 'Full article body',
    htmlBody: '<p>Full article body</p>',
    publishedAt: '2026-03-15T08:00:00.000Z',
    url: 'https://example.substack.com/p/model-launch',
    author: { name: 'Example Publication' },
    publication: {
      name: 'Example Publication',
      handle: 'examplepub',
      url: 'https://example.substack.com',
      roundupMode: undefined,
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
        htmlBody: '<p>In this newsletter:</p><p>Plus links and notes.</p>',
        truncatedBody: 'GPT-5.4 and Gemini 3.1 Flash-Lite',
        publishedAt: '2026-03-06T03:55:36.000Z',
        url: 'https://simonw.substack.com/p/can-coding-agents-relicense-open',
        coverImage: 'https://substackcdn.com/image/fetch/example.jpeg',
      },
    ],
  });
});

test('mergeConfiguredSubstackPublications appends pinned publications without duplicating followed ones', () => {
  assert.equal(
    typeof (collectModule as Record<string, unknown>).mergeConfiguredSubstackPublications,
    'function',
  );

  const mergeConfiguredSubstackPublications = (collectModule as Record<string, Function>)
    .mergeConfiguredSubstackPublications;

  assert.deepEqual(
    mergeConfiguredSubstackPublications([
      {
        name: "Ben's Bites",
        handle: 'bensbites',
        slug: 'bensbites',
        url: 'https://www.bensbites.com',
      },
      {
        name: 'Other Pub',
        handle: 'otherpub',
        slug: 'otherpub',
        url: 'https://otherpub.substack.com',
      },
    ]),
    [
      {
        name: "Ben's Bites",
        handle: 'bensbites',
        slug: 'bensbites',
        url: 'https://www.bensbites.com',
        roundupMode: 'bullet_links',
      },
      {
        name: 'Other Pub',
        handle: 'otherpub',
        slug: 'otherpub',
        url: 'https://otherpub.substack.com',
      },
    ],
  );
});

test("extractSubstackRoundupEntries expands Ben's Bites bullet sections and skips sponsor or internal links", () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).extractSubstackRoundupEntries, 'function');

  const extractSubstackRoundupEntries = (collectModule as Record<string, Function>)
    .extractSubstackRoundupEntries;

  const entries = extractSubstackRoundupEntries({
    id: 'substack-parent-1',
    source: 'substack',
    kind: 'substack_post',
    title: 'AI media goes mainstream',
    subtitle: 'new tools for creating and editing images, videos and audio',
    text: 'newsletter excerpt',
    body: 'newsletter body',
    htmlBody: [
      '<h3>🔎 News worth knowing</h3>',
      '<ul>',
      '<li><p><strong><a href="https://x.com/AravSrinivas/status/1">Perplexity launched Labs</a></strong><span> - A new mode that combines research, codegen and image generation.</span></p></li>',
      '<li><p><strong><a href="https://www.bensbites.com/chat">share with us</a></strong><span> your startup</span></p></li>',
      '</ul>',
      '<h3>Sponsored</h3>',
      '<ul><li><p><a href="https://sponsor.example.com">Buy now</a></p></li></ul>',
      '<h3>🥣 Dev dish</h3>',
      '<ul>',
      '<li><p><a href="https://github.com/browser-use/vibetest-use">MCP server</a><span> from Browser Use runs parallel agents to test your vibe-coded app.</span></p></li>',
      '<li><p><a href="https://example.ai/releases"></a><span>Example AI shipped agent mode.</span></p></li>',
      '<li><p><a href="https://www.bensbites.com/subscribe">Subscribe</a></p></li>',
      '</ul>',
    ].join(''),
    publishedAt: '2026-03-15T08:00:00.000Z',
    url: 'https://www.bensbites.com/p/ai-media-goes-mainstream',
    author: { name: "Ben's Bites" },
    publication: {
      name: "Ben's Bites",
      handle: 'bensbites',
      url: 'https://www.bensbites.com',
      roundupMode: 'bullet_links',
    },
    media: [],
  });

  assert.deepEqual(
    entries.map((entry: { id: string; title: string; url: string; sectionLabel: string; originUrl: string; sourceLabel: string }) => ({
      id: entry.id,
      title: entry.title,
      url: entry.url,
      sectionLabel: entry.sectionLabel,
      originUrl: entry.originUrl,
      sourceLabel: entry.sourceLabel,
    })),
    [
      {
        id: 'substack-parent-1-roundup-news-worth-knowing-1',
        title: 'Perplexity launched Labs',
        url: 'https://x.com/AravSrinivas/status/1',
        sectionLabel: 'News worth knowing',
        originUrl: 'https://www.bensbites.com/p/ai-media-goes-mainstream',
        sourceLabel: 'Perplexity launched Labs',
      },
      {
        id: 'substack-parent-1-roundup-dev-dish-1',
        title: 'MCP server',
        url: 'https://github.com/browser-use/vibetest-use',
        sectionLabel: 'Dev dish',
        originUrl: 'https://www.bensbites.com/p/ai-media-goes-mainstream',
        sourceLabel: 'MCP server',
      },
      {
        id: 'substack-parent-1-roundup-dev-dish-2',
        title: 'Example AI shipped agent mode.',
        url: 'https://example.ai/releases',
        sectionLabel: 'Dev dish',
        originUrl: 'https://www.bensbites.com/p/ai-media-goes-mainstream',
        sourceLabel: 'example.ai',
      },
    ],
  );

  assert.equal(entries.some((entry: { sourceLabel?: string }) => entry.sourceLabel?.includes("Ben's Bites")), false);
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

test('buildTwitterCliCommand exports TWITTER_PROXY and HTTP(S)_PROXY for twitter-cli', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).buildTwitterCliCommand, 'function');

  const buildTwitterCliCommand = (collectModule as Record<string, Function>).buildTwitterCliCommand;

  assert.equal(
    buildTwitterCliCommand('2043983199311913431', 500, 'http://127.0.0.1:6152'),
    'TWITTER_PROXY=http://127.0.0.1:6152 HTTP_PROXY=http://127.0.0.1:6152 HTTPS_PROXY=http://127.0.0.1:6152 twitter list 2043983199311913431 --max 500 --json',
  );
});

test('buildTwitterFeedCommand injects recommendation account cookies only for the feed command', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).buildTwitterFeedCommand, 'function');

  const buildTwitterFeedCommand = (collectModule as Record<string, Function>).buildTwitterFeedCommand;

  assert.equal(
    buildTwitterFeedCommand('for-you', 500, 'http://127.0.0.1:6152', {
      authToken: 'recommend-auth',
      ct0: 'recommend-ct0',
    }),
    'TWITTER_PROXY=http://127.0.0.1:6152 HTTP_PROXY=http://127.0.0.1:6152 HTTPS_PROXY=http://127.0.0.1:6152 TWITTER_AUTH_TOKEN=recommend-auth TWITTER_CT0=recommend-ct0 twitter feed --type for-you --max 500 --json',
  );
});

test('fetchTwitterRecommendationAuthFromCdp extracts auth_token and ct0 from CDP cookies', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).fetchTwitterRecommendationAuthFromCdp, 'function');

  const fetchTwitterRecommendationAuthFromCdp = (collectModule as Record<string, Function>)
    .fetchTwitterRecommendationAuthFromCdp;

  const auth = await fetchTwitterRecommendationAuthFromCdp({
    fetchJson: async (url: string) => {
      assert.equal(url, 'http://127.0.0.1:9222/json/version');
      return { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/1' };
    },
    sendCdpCommand: async (webSocketUrl: string, method: string) => {
      assert.equal(webSocketUrl, 'ws://127.0.0.1:9222/devtools/browser/1');
      assert.equal(method, 'Network.getAllCookies');
      return {
        cookies: [
          { name: 'auth_token', value: 'recommend-auth', domain: '.x.com' },
          { name: 'ct0', value: 'recommend-ct0', domain: '.x.com' },
        ],
      };
    },
  });

  assert.deepEqual(auth, {
    authToken: 'recommend-auth',
    ct0: 'recommend-ct0',
  });
});

test('fetchTwitterRecommendationAuthFromCdp reads browser cookies through Storage when Network is unavailable', async () => {
  const fetchTwitterRecommendationAuthFromCdp = (collectModule as Record<string, Function>)
    .fetchTwitterRecommendationAuthFromCdp;
  const commandCalls: string[] = [];

  const auth = await fetchTwitterRecommendationAuthFromCdp({
    fetchJson: async (url: string) => {
      if (url.endsWith('/json/version')) {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/1' };
      }
      if (url.endsWith('/json/list')) return [];
      throw new Error(`unexpected url: ${url}`);
    },
    sendCdpCommand: async (webSocketUrl: string, method: string) => {
      commandCalls.push(`${webSocketUrl} ${method}`);
      if (method === 'Network.getAllCookies') throw new Error("'Network.getAllCookies' wasn't found");
      return {
        cookies: [
          { name: 'auth_token', value: 'storage-auth', domain: '.x.com' },
          { name: 'ct0', value: 'storage-ct0', domain: '.x.com' },
        ],
      };
    },
  });

  assert.deepEqual(auth, {
    authToken: 'storage-auth',
    ct0: 'storage-ct0',
  });
  assert.deepEqual(commandCalls, [
    'ws://127.0.0.1:9222/devtools/browser/1 Network.getAllCookies',
    'ws://127.0.0.1:9222/devtools/browser/1 Storage.getCookies',
  ]);
});

test('fetchTwitterRecommendationAuthFromCdp falls back to an open X page target', async () => {
  const fetchTwitterRecommendationAuthFromCdp = (collectModule as Record<string, Function>)
    .fetchTwitterRecommendationAuthFromCdp;
  const commandCalls: string[] = [];

  const auth = await fetchTwitterRecommendationAuthFromCdp({
    fetchJson: async (url: string) => {
      if (url.endsWith('/json/version')) {
        return { webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/browser/1' };
      }
      if (url.endsWith('/json/list')) {
        return [
          {
            type: 'page',
            url: 'https://x.com/home',
            webSocketDebuggerUrl: 'ws://127.0.0.1:9222/devtools/page/x-home',
          },
        ];
      }
      throw new Error(`unexpected url: ${url}`);
    },
    sendCdpCommand: async (webSocketUrl: string, method: string) => {
      commandCalls.push(`${webSocketUrl} ${method}`);
      if (webSocketUrl.includes('/browser/')) throw new Error('browser target does not expose cookies');
      return {
        cookies: [
          { name: 'auth_token', value: 'page-auth', domain: '.x.com' },
          { name: 'ct0', value: 'page-ct0', domain: '.x.com' },
        ],
      };
    },
  });

  assert.deepEqual(auth, {
    authToken: 'page-auth',
    ct0: 'page-ct0',
  });
  assert.deepEqual(commandCalls, [
    'ws://127.0.0.1:9222/devtools/browser/1 Network.getAllCookies',
    'ws://127.0.0.1:9222/devtools/browser/1 Storage.getCookies',
    'ws://127.0.0.1:9222/devtools/page/x-home Network.getAllCookies',
  ]);
});

test('collectTwitterRecommendationItems skips recommendation feed when CDP has no logged-in X cookies', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collectTwitterRecommendationItems, 'function');

  const collectTwitterRecommendationItems = (collectModule as Record<string, Function>)
    .collectTwitterRecommendationItems;
  const warnings: string[] = [];
  let retried = false;

  const result = await collectTwitterRecommendationItems(100, {
    fetchRecommendationAuth: async () => null,
    chooseRecommendationLoginRetry: async () => {
      retried = true;
      return false;
    },
    warn: (message: string) => warnings.push(message),
  });

  assert.equal(retried, true);
  assert.deepEqual(result.items, []);
  assert.equal(result.warnings.length, 1);
  assert.match(result.warnings[0], /未检测到 CDP 浏览器中的 X 登录/);
  assert.match(warnings[0], /跳过推荐流/);
});

test('collectTwitterRecommendationItems defaults to six small recommendation batches with random delays', async () => {
  const collectTwitterRecommendationItems = (collectModule as Record<string, Function>)
    .collectTwitterRecommendationItems;
  const commands: string[] = [];
  const sleeps: number[] = [];
  const topicGateIds: string[][] = [];

  const result = await collectTwitterRecommendationItems(0, {
    fetchRecommendationAuth: async () => ({ authToken: 'recommend-auth', ct0: 'recommend-ct0' }),
    execTwitterCliCommand: async (command: string) => {
      commands.push(command);
      const batch = commands.length;
      return {
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          data: [
            {
              id: `recommend-${batch}`,
              text: `AI infrastructure launch batch ${batch}.`,
              author: { id: `user-${batch}`, name: 'Alice', screenName: 'alice' },
              createdAt: '2026-03-15T09:00:00Z',
              media: [],
            },
            {
              id: 'shared-recommendation',
              text: 'Duplicate AI recommendation.',
              author: { id: 'shared-user', name: 'Bob', screenName: 'bob' },
              createdAt: '2026-03-15T09:00:00Z',
              media: [],
            },
          ],
        }),
      };
    },
    topicGate: async (items: Array<{ id: string }>) => {
      topicGateIds.push(items.map((item) => item.id));
      return new Set(items.map((item) => item.id));
    },
    random: () => 0.5,
    sleep: async (ms: number) => {
      sleeps.push(ms);
    },
  });

  assert.equal(commands.length, 6);
  assert.deepEqual(
    commands.map((command) => command.match(/twitter feed --type for-you --max \d+ --json/)?.[0]),
    Array.from({ length: 6 }, () => 'twitter feed --type for-you --max 50 --json'),
  );
  assert.equal(sleeps.length, 5);
  assert.ok(sleeps.every((ms) => ms >= 8000 && ms <= 20000));
  assert.deepEqual(topicGateIds, [
    [
      'recommend-1',
      'shared-recommendation',
      'recommend-2',
      'recommend-3',
      'recommend-4',
      'recommend-5',
      'recommend-6',
    ],
  ]);
  assert.deepEqual(result.items.map((item: { id: string }) => item.id), [
    'recommend-1',
    'shared-recommendation',
    'recommend-2',
    'recommend-3',
    'recommend-4',
    'recommend-5',
    'recommend-6',
  ]);
});

test('collectTwitterRecommendationItems falls back to a smaller batch when twitter-cli pagination fails', async () => {
  const collectTwitterRecommendationItems = (collectModule as Record<string, Function>)
    .collectTwitterRecommendationItems;
  const commands: string[] = [];
  const warnings: string[] = [];

  const paginationError = new Error('twitter-cli failed') as Error & { stdout?: string };
  paginationError.stdout = JSON.stringify({
    ok: false,
    error: {
      message: 'Twitter API error (HTTP 0): Twitter API returned errors: Query: Unspecified',
    },
  });

  const result = await collectTwitterRecommendationItems(0, {
    batchSize: 50,
    batchCount: 1,
    fetchRecommendationAuth: async () => ({ authToken: 'recommend-auth', ct0: 'recommend-ct0' }),
    execTwitterCliCommand: async (command: string) => {
      commands.push(command);
      if (command.includes('--max 50')) throw paginationError;
      assert.match(command, /--max 20\b/);
      return {
        stderr: '',
        stdout: JSON.stringify({
          ok: true,
          data: [
            {
              id: 'recommend-1',
              text: 'An AI infrastructure launch.',
              author: { id: 'user-1', name: 'Alice', screenName: 'alice' },
              createdAt: '2026-03-15T09:00:00Z',
              media: [],
            },
          ],
        }),
      };
    },
    topicGate: async (items: Array<{ id: string }>) => new Set(items.map((item) => item.id)),
    warn: (message: string) => warnings.push(message),
  });

  assert.deepEqual(commands.map((command) => command.match(/--max \d+/)?.[0]), ['--max 50', '--max 20']);
  assert.deepEqual(result.items.map((item: { id: string }) => item.id), ['recommend-1']);
  assert.match(result.warnings?.[0] ?? '', /改用最近 20 条/);
  assert.match(warnings[0] ?? '', /改用最近 20 条/);
});

test('collectTwitterRecommendationItems degrades on DeadlineExceeded and keeps collecting later batches', async () => {
  const collectTwitterRecommendationItems = (collectModule as Record<string, Function>)
    .collectTwitterRecommendationItems;
  const commands: string[] = [];
  const warnings: string[] = [];

  const deadlineError = new Error('twitter-cli failed') as Error & { stdout?: string };
  deadlineError.stdout = JSON.stringify({
    ok: false,
    error: {
      message: 'Twitter API error (HTTP 0): Twitter API returned errors: DeadlineExceeded: Unspecified',
    },
  });

  const payload = (id: string) => ({
    stderr: '',
    stdout: JSON.stringify({
      ok: true,
      data: [
        {
          id,
          text: `tweet ${id}`,
          author: { id: 'user-1', name: 'Alice', screenName: 'alice' },
          createdAt: '2026-03-15T09:00:00Z',
          media: [],
        },
      ],
    }),
  });

  let seenMax50 = 0;
  const result = await collectTwitterRecommendationItems(0, {
    batchSize: 50,
    batchCount: 6,
    fetchRecommendationAuth: async () => ({ authToken: 'recommend-auth', ct0: 'recommend-ct0' }),
    execTwitterCliCommand: async (command: string) => {
      commands.push(command);
      if (command.includes('--max 50')) {
        seenMax50 += 1;
        // 只有第 1 批的首次请求触发瞬态 DeadlineExceeded，降级为 --max 20 后成功；后续批次正常返回。
        if (seenMax50 === 1) throw deadlineError;
        return payload(`recommend-${seenMax50}`);
      }
      assert.match(command, /--max 20\b/);
      return payload('recommend-1');
    },
    topicGate: async (items: Array<{ id: string }>) => new Set(items.map((item) => item.id)),
    warn: (message: string) => warnings.push(message),
    sleep: async () => {},
  });

  // 关键意图：第 1 批的瞬态 DeadlineExceeded 只触发降级重试（50→20），不连坐中断后续 5 批。
  // 若有人回退成"直接 break"，此处的命令序列与 items 都会变短而失败。
  assert.deepEqual(
    commands.map((command) => command.match(/--max \d+/)?.[0]),
    [
      '--max 50', '--max 20',
      '--max 50', '--max 50', '--max 50', '--max 50', '--max 50',
    ],
  );
  assert.deepEqual(result.items.map((item: { id: string }) => item.id), [
    'recommend-1', 'recommend-2', 'recommend-3', 'recommend-4', 'recommend-5', 'recommend-6',
  ]);
  assert.match(result.warnings?.[0] ?? '', /改用最近 20 条/);
  assert.match(warnings[0] ?? '', /改用最近 20 条/);
});

test('filterAiRelatedRecommendationItems sends only 500-character previews and keeps AI-related recommendations', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).filterAiRelatedRecommendationItems, 'function');

  const filterAiRelatedRecommendationItems = (collectModule as Record<string, Function>)
    .filterAiRelatedRecommendationItems;
  const longText = `OpenAI released a new agent workflow. ${'x'.repeat(700)}`;
  const seen: Array<{ id: string; textPreview: string }> = [];

  const result = await filterAiRelatedRecommendationItems(
    [
      {
        id: 'ai-1',
        source: 'twitter',
        twitterFeed: 'for-you',
        text: longText,
        publishedAt: '2026-03-15T09:00:00Z',
        url: 'https://x.com/alice/status/1',
        author: { name: 'Alice', username: 'alice' },
        media: [],
      },
      {
        id: 'non-ai-1',
        source: 'twitter',
        twitterFeed: 'for-you',
        text: 'A general note about mobile app design.',
        publishedAt: '2026-03-15T09:01:00Z',
        url: 'https://x.com/bob/status/2',
        author: { name: 'Bob', username: 'bob' },
        media: [],
      },
    ],
    async (items: Array<{ id: string; textPreview: string }>) => {
      seen.push(...items);
      return new Set(['ai-1']);
    },
  );

  assert.deepEqual(result.items.map((item: { id: string }) => item.id), ['ai-1']);
  assert.equal(seen[0]?.id, 'ai-1');
  assert.equal(seen[0]?.textPreview.length, 500);
  assert.deepEqual(seen.map((item) => item.id), ['ai-1', 'non-ai-1']);
});

test('filterAiRelatedRecommendationItems keeps ALL recommendations when no AI API is configured (skill/agent path, fail-open)', async () => {
  // 意图：skill 路径刻意不配外部 AI 接口（策展由 agent 完成）。默认 LLM 预筛门此时不可用，
  // 必须 fail-open 放行全部推荐流、把相关性判断交还策展阶段，而不是清零。若回归成“调门 → 抛 AI 配置缺失 → 清零”，
  // 下方“全部保留”断言会失败。
  const filterAiRelatedRecommendationItems = (collectModule as Record<string, Function>)
    .filterAiRelatedRecommendationItems;
  const savedOpenAI = process.env.OPENAI_API_KEY;
  const savedBaseUrl = process.env.AI_BASE_URL;
  const savedApiKey = process.env.AI_API_KEY;
  delete process.env.OPENAI_API_KEY;
  delete process.env.AI_BASE_URL;
  delete process.env.AI_API_KEY;

  const warnings: string[] = [];
  try {
    const result = await filterAiRelatedRecommendationItems(
      [
        {
          id: 'rec-noai-1',
          source: 'twitter',
          twitterFeed: 'for-you',
          text: 'Some off-topic algorithmic recommendation.',
          publishedAt: '2026-03-15T09:00:00Z',
          url: 'https://x.com/alice/status/1',
          author: { name: 'Alice', username: 'alice' },
          media: [],
        },
        {
          id: 'rec-noai-2',
          source: 'twitter',
          twitterFeed: 'for-you',
          text: 'Another noisy for-you tweet.',
          publishedAt: '2026-03-15T09:01:00Z',
          url: 'https://x.com/bob/status/2',
          author: { name: 'Bob', username: 'bob' },
          media: [],
        },
      ],
      undefined, // 触发默认门 runRecommendationTopicGate
      (message: string) => warnings.push(message),
    );

    assert.deepEqual(
      result.items.map((item: { id: string }) => item.id),
      ['rec-noai-1', 'rec-noai-2'],
    );
    assert.ok(warnings.some((w) => /跳过推荐流 AI 预筛/.test(w)));
  } finally {
    if (savedOpenAI === undefined) delete process.env.OPENAI_API_KEY;
    else process.env.OPENAI_API_KEY = savedOpenAI;
    if (savedBaseUrl === undefined) delete process.env.AI_BASE_URL;
    else process.env.AI_BASE_URL = savedBaseUrl;
    if (savedApiKey === undefined) delete process.env.AI_API_KEY;
    else process.env.AI_API_KEY = savedApiKey;
  }
});

test('buildRecommendationTopicGatePrompt includes confirmed preference hints without expanding previews', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).buildRecommendationTopicGatePrompt, 'function');

  const buildRecommendationTopicGatePrompt = (collectModule as Record<string, Function>)
    .buildRecommendationTopicGatePrompt;
  const prompt = buildRecommendationTopicGatePrompt(
    [
      {
        id: 'ai-1',
        author: 'Alice',
        username: 'alice',
        url: 'https://x.com/alice/status/1',
        textPreview: `OpenAI released a new agent workflow. ${'x'.repeat(700)}`,
      },
    ],
    {
      schemaVersion: 1,
      updatedAt: '2026-06-12T00:00:00.000Z',
      authorRules: {},
      domainRules: {},
      positiveTopicHints: ['hands-on agent workflow'],
      negativeTopicHints: ['vague launch teaser'],
    },
  );

  assert.match(prompt.systemPrompt, /Confirmed reader preference hints/);
  assert.match(prompt.systemPrompt, /Prefer: hands-on agent workflow/);
  assert.match(prompt.systemPrompt, /Deprioritize: vague launch teaser/);
  const parsed = JSON.parse(prompt.userContent.match(/\{\n[\s\S]*\}$/)?.[0] ?? '{}');
  assert.equal(parsed.items[0]?.textPreview.length, 500);
});

test('collectSources preserves source collection warnings alongside successful items', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collectSources, 'function');

  const collectSources = (collectModule as Record<string, Function>).collectSources;
  const result = await collectSources({
    enabledSources: ['twitter'],
    nowSeconds: 1710000000,
    state: {
      sources: {
        twitter: { lastPublishedTime: 100 },
        substack: { lastPublishedTime: 200 },
      },
    },
    collectors: {
      twitter: async () => ({
        items: [
          {
            id: 'tw-1',
            source: 'twitter',
            text: 'tweet',
            publishedAt: '2026-03-15T09:00:00Z',
            url: 'https://x.com/alice/status/1',
            author: { name: 'Alice', username: 'alice' },
            media: [],
          },
        ],
        warnings: ['recommendation feed skipped'],
      }),
      substack: async () => [],
    },
  });

  assert.deepEqual(result.items.map((item: { id: string }) => item.id), ['tw-1']);
  assert.deepEqual(result.collectionWarnings, ['recommendation feed skipped']);
});

test('summarizeTwitterCliError prefers structured stdout payloads over stderr warnings', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).summarizeTwitterCliError, 'function');

  const summarizeTwitterCliError = (collectModule as Record<string, Function>).summarizeTwitterCliError;
  const error = Object.assign(
    new Error('Command failed: twitter tweet 2044861930884776000 --max 3 --json'),
    {
      stdout: JSON.stringify({
        ok: false,
        error: {
          code: 'not_authenticated',
          message: 'No Twitter cookies found.',
        },
      }),
      stderr:
        "WARNING twitter_cli.client: Failed to init ClientTransaction: 'NoneType' object has no attribute 'split'",
    },
  );

  assert.equal(summarizeTwitterCliError(error), 'No Twitter cookies found.');
});

test('summarizeTwitterCliError falls back to stderr when stdout is not structured JSON', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).summarizeTwitterCliError, 'function');

  const summarizeTwitterCliError = (collectModule as Record<string, Function>).summarizeTwitterCliError;
  const error = Object.assign(new Error('Command failed: twitter list 1 --max 3 --json'), {
    stdout: '',
    stderr: 'WARNING twitter_cli.client: Failed to init ClientTransaction: timed out',
  });

  assert.equal(summarizeTwitterCliError(error), 'WARNING twitter_cli.client: Failed to init ClientTransaction: timed out');
});

test('summarizeTwitterCliError prefers the terminal traceback line when stderr is a Python traceback', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).summarizeTwitterCliError, 'function');

  const summarizeTwitterCliError = (collectModule as Record<string, Function>).summarizeTwitterCliError;
  const error = Object.assign(new Error('Command failed: twitter tweet 1 --max 3 --json'), {
    stdout: '',
    stderr: `Traceback (most recent call last):
  File "/Users/suosuo/.local/bin/twitter", line 10, in <module>
    sys.exit(cli())
RuntimeError: Invalid tweet ID: tw-fail-open
`,
  });

  assert.equal(summarizeTwitterCliError(error), 'RuntimeError: Invalid tweet ID: tw-fail-open');
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

test('fetchTwitterReplies stops later lookups after a Twitter rate limit', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).createTwitterEnrichmentCircuitBreaker, 'function');
  assert.equal(typeof (collectModule as Record<string, unknown>).fetchTwitterReplies, 'function');

  const createTwitterEnrichmentCircuitBreaker = (collectModule as Record<string, Function>)
    .createTwitterEnrichmentCircuitBreaker;
  const fetchTwitterReplies = (collectModule as Record<string, Function>).fetchTwitterReplies;
  const breaker = createTwitterEnrichmentCircuitBreaker();
  const item = {
    id: 'tw-rate-limited',
    source: 'twitter',
    text: 'root tweet',
    publishedAt: '2026-03-15T09:00:00Z',
    url: 'https://x.com/alice/status/tw-rate-limited',
    originUrl: 'https://x.com/alice/status/tw-rate-limited',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: [],
  };
  let cliCalls = 0;

  const first = await fetchTwitterReplies(item, 3, {
    enrichmentBreaker: breaker,
    fetchTwitterRepliesViaCli: async () => {
      cliCalls += 1;
      throw new Error('Twitter API error (HTTP 429): Twitter API error 429: Rate limit exceeded');
    },
  });
  const second = await fetchTwitterReplies({ ...item, id: 'tw-after-rate-limit' }, 3, {
    enrichmentBreaker: breaker,
    fetchTwitterRepliesViaCli: async () => {
      cliCalls += 1;
      return [
        {
          id: 'reply-should-not-fetch',
          text: 'reply',
          author: { name: 'Alice', username: 'alice' },
          publishedAt: '2026-03-15T09:01:00Z',
          url: 'https://x.com/alice/status/reply-should-not-fetch',
          outboundLinks: [],
        },
      ];
    },
  });

  assert.deepEqual(first, []);
  assert.deepEqual(second, []);
  assert.equal(cliCalls, 1);
});

test('fetchTwitterReplies stops later lookups after repeated transient Twitter failures', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).createTwitterEnrichmentCircuitBreaker, 'function');
  assert.equal(typeof (collectModule as Record<string, unknown>).fetchTwitterReplies, 'function');

  const createTwitterEnrichmentCircuitBreaker = (collectModule as Record<string, Function>)
    .createTwitterEnrichmentCircuitBreaker;
  const fetchTwitterReplies = (collectModule as Record<string, Function>).fetchTwitterReplies;
  const breaker = createTwitterEnrichmentCircuitBreaker({ maxTransientFailures: 2 });
  const item = {
    id: 'tw-timeout',
    source: 'twitter',
    text: 'root tweet',
    publishedAt: '2026-03-15T09:00:00Z',
    url: 'https://x.com/alice/status/tw-timeout',
    originUrl: 'https://x.com/alice/status/tw-timeout',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: [],
  };
  let cliCalls = 0;
  const timeoutOptions = {
    enrichmentBreaker: breaker,
    fetchTwitterRepliesViaCli: async () => {
      cliCalls += 1;
      throw new Error(
        'Twitter API error (HTTP 0): Twitter API network error: Failed to perform, curl: (28) Connection timed out after 30002 milliseconds.',
      );
    },
  };

  await fetchTwitterReplies(item, 3, timeoutOptions);
  await fetchTwitterReplies({ ...item, id: 'tw-timeout-2' }, 3, timeoutOptions);
  const skipped = await fetchTwitterReplies({ ...item, id: 'tw-timeout-3' }, 3, timeoutOptions);

  assert.deepEqual(skipped, []);
  assert.equal(cliCalls, 2);
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
        assert.equal(maxReplies, 3);
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

test('resolveTwitterPrimarySource reuses wrapper reply lookup for author reply fallback', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const replyLookupMaxValues: number[] = [];
  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-single-reply-pass',
      source: 'twitter',
      text: 'Read more here',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/tw-single-reply-pass',
      originUrl: 'https://x.com/alice/status/tw-single-reply-pass',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: [],
    },
    {
      fetchTwitterReplies: async (_item: unknown, maxReplies: number) => {
        replyLookupMaxValues.push(maxReplies);
        return [
          {
            id: 'reply-1',
            text: 'first reply without a link',
            author: { name: 'Bob', username: 'bob' },
            publishedAt: '2026-03-15T09:01:00Z',
            url: 'https://x.com/bob/status/reply-1',
            outboundLinks: [],
          },
          {
            id: 'reply-2',
            text: 'full post https://blog.example.com/deep-dive',
            author: { name: 'Alice', username: 'alice' },
            publishedAt: '2026-03-15T09:02:00Z',
            url: 'https://x.com/alice/status/reply-2',
            outboundLinks: ['https://blog.example.com/deep-dive'],
          },
        ].slice(0, maxReplies);
      },
      fetchLinkedPage: async (url: string) => ({
        url,
        title: 'Deep Dive',
        description: 'A substantial article',
        excerpt: 'A substantial article about the launch. '.repeat(20),
        domain: 'blog.example.com',
        via: 'reply',
      }),
    },
  );

  assert.deepEqual(replyLookupMaxValues, [3]);
  assert.equal(resolved.url, 'https://blog.example.com/deep-dive');
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

test('mapTwitterCliTweet preserves the embedded quoted tweet text for local source resolution', () => {
  const tweet = collectModule.mapTwitterCliTweet({
    id: 'tw-1',
    text: 'recommended reading.',
    author: { id: '1', name: 'Mario', screenName: 'badlogicgames' },
    createdAt: '2026-08-11T15:58:36Z',
    quotedTweet: { id: 'q-1', text: 'my new paper on scaling laws https://t.co/abc', author: { name: 'Jonas', screenName: 'jonasgeiping' } },
  });
  assert.equal(tweet.quotedStatusUrl, 'https://x.com/jonasgeiping/status/q-1');
  assert.equal(tweet.quotedTweetText, 'my new paper on scaling laws https://t.co/abc');
});

test('resolveTwitterPrimarySource resolves the quoted article from embedded quote text without an X API call', async () => {
  // Regression (Bug B): a quote-wrapper tweet whose own text has no link used to require an extra
  // `twitter tweet <quoted-id>` call to find the article — an N+1 that triggers X 429s and leaves
  // the item as no_linked_source. The list payload already carries the quoted tweet's text, so we
  // resolve the article locally and never hit the X API.
  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const resolved = await resolveTwitterPrimarySource({
    id: 'tw',
    source: 'twitter',
    text: 'recommended reading.',
    publishedAt: '2026-08-11T15:58:36Z',
    url: 'https://x.com/badlogicgames/status/tw',
    originUrl: 'https://x.com/badlogicgames/status/tw',
    author: { name: 'Mario', username: 'badlogicgames' },
    media: [],
    outboundLinks: [],
    quotedStatusUrl: 'https://x.com/jonasgeiping/status/q-1',
    quotedTweetText: 'my new paper on scaling laws https://t.co/abc',
  }, {
    resolveShortUrl: async (url: string) => (url.includes('t.co') ? 'https://arxiv.org/abs/2401.12345' : null),
    fetchLinkedPage: async () => ({
      url: 'https://arxiv.org/abs/2401.12345',
      title: 'Scaling Laws v2',
      description: 'we study scaling',
      excerpt: 'we study scaling across...',
      domain: 'arxiv.org',
      via: 'quote',
    }),
    fetchQuotedPrimarySource: async () => { throw new Error('network quote lookup must not run when embedded text resolves'); },
    fetchTwitterReplies: async () => { throw new Error('should not fetch replies'); },
  });

  assert.equal(resolved.url, 'https://arxiv.org/abs/2401.12345');
  assert.equal(resolved.linkedSource?.url, 'https://arxiv.org/abs/2401.12345');
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'embedded_quote_wrapper' });
});

test('resolveTwitterPrimarySource falls back to the network quote lookup when embedded quote text has no link', async () => {
  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  let networkCalled = false;
  const resolved = await resolveTwitterPrimarySource({
    id: 'tw',
    source: 'twitter',
    text: 'this.',
    publishedAt: '2026-08-11T15:58:36Z',
    url: 'https://x.com/badlogicgames/status/tw',
    originUrl: 'https://x.com/badlogicgames/status/tw',
    author: { name: 'Mario', username: 'badlogicgames' },
    media: [],
    outboundLinks: [],
    quotedStatusUrl: 'https://x.com/jonasgeiping/status/q-1',
    quotedTweetText: 'great thread!', // no link in the embedded text
  }, {
    resolveShortUrl: async () => null,
    fetchLinkedPage: async () => null,
    fetchQuotedPrimarySource: async (url: string) => {
      networkCalled = true;
      assert.equal(url, 'https://x.com/jonasgeiping/status/q-1');
      return { url: 'https://example.com/article', title: 'Article', domain: 'example.com', via: 'quote' };
    },
    fetchTwitterReplies: async () => { throw new Error('should not fetch replies'); },
  });

  assert.ok(networkCalled, 'network quote lookup should run when embedded text has no link');
  assert.equal(resolved.url, 'https://example.com/article');
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'quote_wrapper' });
});

test('resolveTwitterPrimarySource still resolves embedded quote text when the enrichment breaker has tripped', async () => {
  // The embedded path never touches the X API, so an X rate-limit breaker must NOT block it.
  const createTwitterEnrichmentCircuitBreaker = (collectModule as Record<string, Function>).createTwitterEnrichmentCircuitBreaker;
  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const breaker = createTwitterEnrichmentCircuitBreaker();
  breaker.recordFailure(new Error('Twitter API error (HTTP 429): Rate limit exceeded'));
  assert.equal(breaker.shouldSkip(), true);

  const resolved = await resolveTwitterPrimarySource({
    id: 'tw',
    source: 'twitter',
    text: 'recommended reading.',
    publishedAt: '2026-08-11T15:58:36Z',
    url: 'https://x.com/badlogicgames/status/tw',
    originUrl: 'https://x.com/badlogicgames/status/tw',
    author: { name: 'Mario', username: 'badlogicgames' },
    media: [],
    outboundLinks: [],
    quotedStatusUrl: 'https://x.com/jonasgeiping/status/q-1',
    quotedTweetText: 'paper https://t.co/abc',
  }, {
    enrichmentBreaker: breaker,
    resolveShortUrl: async () => 'https://arxiv.org/abs/2401.999',
    fetchLinkedPage: async () => ({ url: 'https://arxiv.org/abs/2401.999', title: 'Paper', domain: 'arxiv.org', via: 'quote' }),
    fetchQuotedPrimarySource: async () => { throw new Error('breaker should skip network path; embedded path must resolve instead'); },
    fetchTwitterReplies: async () => { throw new Error('should not fetch replies'); },
  });

  assert.equal(resolved.url, 'https://arxiv.org/abs/2401.999');
  assert.deepEqual(resolved.sourceResolution, { decision: 'use_linked_source', reason: 'embedded_quote_wrapper' });
});

test('buildUnresolvedQuoteWarning reports how many quotes failed to resolve, with samples', () => {
  const buildUnresolvedQuoteWarning = (collectModule as Record<string, Function>).buildUnresolvedQuoteWarning;
  const warning = buildUnresolvedQuoteWarning([
    { quotedStatusUrl: 'https://x.com/a/status/111', sourceResolution: { decision: 'use_linked_source', reason: 'embedded_quote_wrapper' } },
    { quotedStatusUrl: 'https://x.com/b/status/222', sourceResolution: { decision: 'keep_origin', reason: 'no_linked_source' } },
    { quotedStatusUrl: 'https://x.com/c/status/333', sourceResolution: { decision: 'keep_origin', reason: 'no_linked_source' } },
  ]);
  assert.ok(warning, 'should produce a warning when some quotes are unresolved');
  assert.match(warning, /3 条带 quote/);
  assert.match(warning, /1 条经嵌入文本本地解析/);
  assert.match(warning, /2 条未解析/);
  assert.match(warning, /x\.com\/c\/status\/333/, 'sample should be a full clickable URL');

  assert.equal(buildUnresolvedQuoteWarning([]), null, 'no quotes -> no warning');
  assert.equal(
    buildUnresolvedQuoteWarning([{ quotedStatusUrl: 'https://x.com/a/status/1', sourceResolution: { decision: 'use_linked_source', reason: 'embedded_quote_wrapper' } }]),
    null,
    'all resolved -> no warning',
  );
});

test('resolveTwitterPrimarySource skips quoted tweet and reply lookups after enrichment breaker trips', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).createTwitterEnrichmentCircuitBreaker, 'function');
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const createTwitterEnrichmentCircuitBreaker = (collectModule as Record<string, Function>)
    .createTwitterEnrichmentCircuitBreaker;
  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const breaker = createTwitterEnrichmentCircuitBreaker();
  breaker.recordFailure(new Error('Twitter API error (HTTP 429): Rate limit exceeded'));

  const resolved = await resolveTwitterPrimarySource(
    {
      id: 'tw-quote-skipped',
      source: 'twitter',
      text: 'Read more here',
      publishedAt: '2026-03-15T09:00:00Z',
      url: 'https://x.com/alice/status/tw-quote-skipped',
      originUrl: 'https://x.com/alice/status/tw-quote-skipped',
      author: { name: 'Alice', username: 'alice' },
      media: [],
      outboundLinks: [],
      quotedStatusUrl: 'https://x.com/bob/status/quoted',
    },
    {
      enrichmentBreaker: breaker,
      fetchQuotedPrimarySource: async () => {
        throw new Error('should not fetch quoted tweet');
      },
      fetchTwitterReplies: async () => {
        throw new Error('should not fetch replies');
      },
    },
  );

  assert.equal(resolved.url, 'https://x.com/alice/status/tw-quote-skipped');
  assert.deepEqual(resolved.replyContext, []);
  assert.deepEqual(resolved.sourceResolution, { decision: 'keep_origin', reason: 'no_linked_source' });
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

test('createLinkedPageFetcher caches null results across repeated linked-page lookups', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).createLinkedPageFetcher, 'function');
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySources, 'function');
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const createLinkedPageFetcher = (collectModule as Record<string, Function>).createLinkedPageFetcher;
  const resolveTwitterPrimarySources = (collectModule as Record<string, Function>).resolveTwitterPrimarySources;
  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  let fetchCount = 0;
  const fetchLinkedPage = createLinkedPageFetcher(async () => {
    fetchCount += 1;
    return null;
  });

  const items = ['tw-cache-1', 'tw-cache-2'].map((id) => ({
    id,
    source: 'twitter',
    text: 'Read more here',
    publishedAt: '2026-03-15T09:00:00Z',
    url: `https://x.com/alice/status/${id}`,
    originUrl: `https://x.com/alice/status/${id}`,
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: ['https://thariqs.github.io/cc-video-editing-deck'],
  }));

  const resolved = await resolveTwitterPrimarySources(items, {
    resolveTwitterPrimarySource: (item: unknown) => resolveTwitterPrimarySource(item, { fetchLinkedPage }),
  });

  assert.equal(fetchCount, 1);
  assert.deepEqual(
    resolved.map((item: { sourceResolution: { reason: string } }) => item.sourceResolution.reason),
    ['no_linked_source', 'no_linked_source'],
  );
});

test('collapseNumberedSelfThreads merges numbered same-author threads into the root tweet and keeps X origin', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collapseNumberedSelfThreads, 'function');

  const collapseNumberedSelfThreads = (collectModule as Record<string, Function>).collapseNumberedSelfThreads;
  const collapsed = collapseNumberedSelfThreads([
    {
      id: 'part-2',
      source: 'twitter',
      text: '2/3\nSecond point with quoted source',
      publishedAt: '2026-04-21T00:00:05Z',
      url: 'https://lessons.md',
      originUrl: 'https://x.com/alice/status/part-2',
      author: { name: 'Alice', username: 'alice' },
      media: [{ type: 'photo', url: 'https://img/2.jpg' }],
      quotedStatusUrl: 'https://x.com/bob/status/quoted-1',
      sourceLabel: 'lessons.md',
      sourceResolution: { decision: 'use_linked_source', reason: 'quote_wrapper' },
    },
    {
      id: 'part-1',
      source: 'twitter',
      text: '1/3\nRoot point',
      publishedAt: '2026-04-21T00:00:00Z',
      url: 'https://x.com/alice/status/part-1',
      originUrl: 'https://x.com/alice/status/part-1',
      author: { name: 'Alice', username: 'alice' },
      media: [{ type: 'photo', url: 'https://img/1.jpg' }],
      likeCount: 10,
      replyCount: 2,
      repostCount: 3,
      quoteCount: 1,
    },
    {
      id: 'part-3',
      source: 'twitter',
      text: '3/3\nThird point',
      publishedAt: '2026-04-21T00:00:10Z',
      url: 'https://github.com/example/repo',
      originUrl: 'https://x.com/alice/status/part-3',
      author: { name: 'Alice', username: 'alice' },
      media: [{ type: 'video', url: 'https://video/1.mp4' }],
      sourceLabel: 'GitHub',
      sourceResolution: { decision: 'use_linked_source', reason: 'tweet_wrapper' },
    },
  ]);

  assert.equal(collapsed.length, 1);
  assert.deepEqual(collapsed[0], {
    id: 'part-1',
    source: 'twitter',
    text: '[1/3] 1/3\nRoot point\n\n[2/3] 2/3\nSecond point with quoted source\n\n[3/3] 3/3\nThird point',
    publishedAt: '2026-04-21T00:00:00Z',
    url: 'https://x.com/alice/status/part-1',
    originUrl: 'https://x.com/alice/status/part-1',
    author: { name: 'Alice', username: 'alice' },
    media: [
      { type: 'photo', url: 'https://img/1.jpg' },
      { type: 'photo', url: 'https://img/2.jpg' },
      { type: 'video', url: 'https://video/1.mp4' },
    ],
    likeCount: 10,
    replyCount: 2,
    repostCount: 3,
    quoteCount: 1,
    sourceResolution: { decision: 'keep_origin', reason: 'numbered_self_thread' },
    selfThread: {
      partIds: ['part-1', 'part-2', 'part-3'],
      partCount: 3,
      combinedText:
        '[1/3] 1/3\nRoot point\n\n[2/3] 2/3\nSecond point with quoted source\n\n[3/3] 3/3\nThird point',
      parts: [
        {
          id: 'part-1',
          originUrl: 'https://x.com/alice/status/part-1',
          text: '1/3\nRoot point',
          publishedAt: '2026-04-21T00:00:00Z',
          media: [{ type: 'photo', url: 'https://img/1.jpg' }],
        },
        {
          id: 'part-2',
          originUrl: 'https://x.com/alice/status/part-2',
          text: '2/3\nSecond point with quoted source',
          publishedAt: '2026-04-21T00:00:05Z',
          media: [{ type: 'photo', url: 'https://img/2.jpg' }],
        },
        {
          id: 'part-3',
          originUrl: 'https://x.com/alice/status/part-3',
          text: '3/3\nThird point',
          publishedAt: '2026-04-21T00:00:10Z',
          media: [{ type: 'video', url: 'https://video/1.mp4' }],
        },
      ],
    },
  });
});

test('collapseNumberedSelfThreads leaves invalid thread candidates as separate tweets', () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collapseNumberedSelfThreads, 'function');

  const collapseNumberedSelfThreads = (collectModule as Record<string, Function>).collapseNumberedSelfThreads;
  const collapsed = collapseNumberedSelfThreads([
    {
      id: 'missing-root-2',
      source: 'twitter',
      text: '2/3\nNo root',
      publishedAt: '2026-04-21T00:00:00Z',
      url: 'https://x.com/alice/status/missing-root-2',
      originUrl: 'https://x.com/alice/status/missing-root-2',
      author: { name: 'Alice', username: 'alice' },
      media: [],
    },
    {
      id: 'missing-root-3',
      source: 'twitter',
      text: '3/3\nNo root',
      publishedAt: '2026-04-21T00:00:05Z',
      url: 'https://x.com/alice/status/missing-root-3',
      originUrl: 'https://x.com/alice/status/missing-root-3',
      author: { name: 'Alice', username: 'alice' },
      media: [],
    },
    {
      id: 'different-author-1',
      source: 'twitter',
      text: '1/2\nOther author root',
      publishedAt: '2026-04-21T00:00:00Z',
      url: 'https://x.com/bob/status/different-author-1',
      originUrl: 'https://x.com/bob/status/different-author-1',
      author: { name: 'Bob', username: 'bob' },
      media: [],
    },
    {
      id: 'different-author-2',
      source: 'twitter',
      text: '2/2\nOther author tail',
      publishedAt: '2026-04-21T00:20:00Z',
      url: 'https://x.com/bob/status/different-author-2',
      originUrl: 'https://x.com/bob/status/different-author-2',
      author: { name: 'Bob', username: 'carol' },
      media: [],
    },
  ]);

  assert.deepEqual(collapsed.map((item: { id: string }) => item.id), [
    'missing-root-2',
    'missing-root-3',
    'different-author-1',
    'different-author-2',
  ]);
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

test('resolveTwitterPrimarySource does not query replies when existing linked-page candidates fail', async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).resolveTwitterPrimarySource, 'function');

  const resolveTwitterPrimarySource = (collectModule as Record<string, Function>).resolveTwitterPrimarySource;
  const item = {
    id: 'tw-link-fail-no-replies',
    source: 'twitter',
    text: 'Read more here',
    publishedAt: '2026-03-15T09:00:00Z',
    url: 'https://x.com/alice/status/tw-link-fail-no-replies',
    originUrl: 'https://x.com/alice/status/tw-link-fail-no-replies',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    outboundLinks: ['https://docs.example.com/launch'],
  };
  let replyCalls = 0;

  const resolved = await resolveTwitterPrimarySource(item, {
    fetchLinkedPage: async () => null,
    fetchTwitterReplies: async () => {
      replyCalls += 1;
      return [];
    },
  });

  assert.equal(replyCalls, 0);
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

test("collectSubstackItems still includes pinned Ben's Bites when SUBSTACK_PUBLICATION_URL is missing", async () => {
  assert.equal(typeof (collectModule as Record<string, unknown>).collectSubstackItems, 'function');

  const collectSubstackItems = (collectModule as Record<string, Function>).collectSubstackItems;
  const originalPublicationUrl = process.env.SUBSTACK_PUBLICATION_URL;

  delete process.env.SUBSTACK_PUBLICATION_URL;

  try {
    const items = await collectSubstackItems({
      sinceTime: Date.parse('2026-03-15T07:30:00Z') / 1000,
      deps: {
        fetchPublicSubstackPublications: async () => [
          {
            name: "Ben's Bites",
            handle: 'bensbites',
            slug: 'bensbites',
            url: 'https://www.bensbites.com',
            roundupMode: 'bullet_links',
          },
        ],
        fetchPublicationFeed: async () => ({
          publication: {
            name: "Ben's Bites",
            handle: 'bensbites',
            slug: 'bensbites',
            url: 'https://www.bensbites.com',
            roundupMode: 'bullet_links',
          },
          posts: [
            {
              id: 'https://www.bensbites.com/p/ai-media-goes-mainstream',
              title: 'ai media goes mainstream',
              subtitle: 'new tools for creating and editing images',
              body: 'newsletter body',
              htmlBody:
                '<h3>🔎 News worth knowing</h3><ul><li><p><a href="https://example.com/perplexity-labs">Perplexity launched Labs</a> - a new mode.</p></li></ul>',
              truncatedBody: 'newsletter excerpt',
              publishedAt: '2026-03-15T08:00:00.000Z',
              url: 'https://www.bensbites.com/p/ai-media-goes-mainstream',
            },
          ],
        }),
      },
    });

    assert.deepEqual(items.map((item: { id: string }) => item.id), [
      'substack-https://www.bensbites.com/p/ai-media-goes-mainstream',
      'substack-https://www.bensbites.com/p/ai-media-goes-mainstream-roundup-news-worth-knowing-1',
    ]);
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

test('extractAihotOriginalUrl pulls the 阅读原文 href from AI HOT description HTML', () => {
  const html =
    '<p>摘要正文</p>' +
    '<p>🔗 <a href="https://openrouter.ai/blog/x">阅读原文</a></p>' +
    '<p>via AI HOT · <a href="https://aihot.virxact.com/items/abc">abc</a></p>';
  assert.equal(collectModule.extractAihotOriginalUrl(html), 'https://openrouter.ai/blog/x');
  assert.equal(collectModule.extractAihotOriginalUrl('<p>无链接</p>'), null);
});

test('stripAihotSummaryText drops 阅读原文 and via AI HOT footer lines', () => {
  const html =
    '<p>OpenRouter 发布了 langchain-openrouter 专用包，调用 400+ 模型。</p>' +
    '<p>🔗 <a href="https://openrouter.ai/blog/x">阅读原文</a></p>' +
    '<p>via AI HOT · <a href="https://aihot.virxact.com/items/abc">abc</a></p>';
  const text = collectModule.stripAihotSummaryText(html);
  assert.ok(text.includes('langchain-openrouter'));
  assert.ok(!/阅读原文/.test(text));
  assert.ok(!/via\s+AI\s+HOT/i.test(text));
  assert.ok(!/aihot\.virxact\.com/.test(text));
});

test('parseAihotAuthorLabel extracts original source label and optional X handle', () => {
  assert.deepEqual(
    collectModule.parseAihotAuthorLabel('noreply@aihot.virxact.com (IT之家（RSS）)'),
    { name: 'IT之家' },
  );
  assert.deepEqual(
    collectModule.parseAihotAuthorLabel('noreply@aihot.virxact.com (X：Tibo (@thsottiaux))'),
    { name: 'X：Tibo', username: 'thsottiaux' },
  );
  assert.deepEqual(
    collectModule.parseAihotAuthorLabel('noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)'),
    { name: 'OpenRouter：Announcements' },
  );
  assert.deepEqual(collectModule.parseAihotAuthorLabel('AI HOT'), { name: 'AI HOT' });
});

test('parseAihotFeed extracts item guid/title/description/pubDate/author from RSS', () => {
  const xml = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>AI HOT — 精选</title>
<link>https://aihot.virxact.com/</link>
<item>
<title><![CDATA[OpenRouter 推出专用 LangChain 集成包]]></title>
<link>https://aihot.virxact.com/items/cms5dje23</link>
<description><![CDATA[<p>OpenRouter 发布了专用包。</p><p>🔗 <a href="https://openrouter.ai/blog/x">阅读原文</a></p><p>via AI HOT · <a href="https://aihot.virxact.com/items/cms5dje23">x</a></p>]]></description>
<category>技巧观点</category>
<pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
<guid isPermaLink="false">cms5dje23</guid>
<author>noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)</author>
</item>
<item>
<title><![CDATA[无 guid 的条目应被跳过]]></title>
<link>https://aihot.virxact.com/items/skip</link>
<description><![CDATA[<p>x</p>]]></description>
<pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
<author>noreply@aihot.virxact.com (AI HOT)</author>
</item>
</channel></rss>`;

  assert.deepEqual(collectModule.parseAihotFeed(xml), [
    {
      guid: 'cms5dje23',
      title: 'OpenRouter 推出专用 LangChain 集成包',
      descriptionHtml:
        '<p>OpenRouter 发布了专用包。</p><p>🔗 <a href="https://openrouter.ai/blog/x">阅读原文</a></p><p>via AI HOT · <a href="https://aihot.virxact.com/items/cms5dje23">x</a></p>',
      publishedAt: 'Wed, 29 Jul 2026 00:00:00 GMT',
      authorField: 'noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)',
    },
  ]);
});

test('collectAihotItems maps feed items to CollectedItem with original source attribution', async () => {
  const xml = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>AI HOT — 精选</title><link>https://aihot.virxact.com/</link>
<item>
<title><![CDATA[OpenRouter 推出专用 LangChain 集成包]]></title>
<link>https://aihot.virxact.com/items/cms5dje23</link>
<description><![CDATA[<p>OpenRouter 发布了 langchain-openrouter 专用包，调用 400+ 模型。</p><p>🔗 <a href="https://openrouter.ai/blog/x?utm_source=feed">阅读原文</a></p><p>via AI HOT · <a href="https://aihot.virxact.com/items/cms5dje23">x</a></p>]]></description>
<pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
<guid isPermaLink="false">cms5dje23</guid>
<author>noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)</author>
</item>
<item>
<title><![CDATA[无阅读原文的条目应被丢弃]]></title>
<link>https://aihot.virxact.com/items/cms5zz</link>
<description><![CDATA[<p>这条没有原始链接。</p>]]></description>
<pubDate>Wed, 29 Jul 2026 01:00:00 GMT</pubDate>
<guid isPermaLink="false">cms5zz</guid>
<author>noreply@aihot.virxact.com (AI HOT)</author>
</item>
</channel></rss>`;

  const items = await collectModule.collectAihotItems({
    sinceTime: 0,
    feedUrl: 'https://example.com/feed.xml',
    deps: { fetchFeed: async () => xml },
  });

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.source, 'aihot');
  assert.equal(item.id, 'cms5dje23');
  assert.equal(item.url, 'https://openrouter.ai/blog/x');
  assert.equal(item.originUrl, 'https://openrouter.ai/blog/x');
  assert.equal(item.title, 'OpenRouter 推出专用 LangChain 集成包');
  assert.equal(item.author.name, 'OpenRouter：Announcements');
  assert.equal(item.sourceLabel, 'OpenRouter：Announcements');
  assert.equal(item.publishedAt, '2026-07-29T00:00:00.000Z');
  assert.ok(item.text.includes('langchain-openrouter'));
  assert.ok(!/阅读原文|via\s+AI\s+HOT/i.test(item.text));
  assert.deepEqual(item.media, []);
});

test('collectAihotItems respects sinceTime and maxItems', async () => {
  const item = (guid: string, pub: string) =>
    `<item><title><![CDATA[t-${guid}]]></title><link>https://aihot.virxact.com/items/${guid}</link>` +
    `<description><![CDATA[<p>body</p><p>🔗 <a href="https://example.com/${guid}">阅读原文</a></p>]]></description>` +
    `<pubDate>${pub}</pubDate><guid isPermaLink="false">${guid}</guid><author>noreply@aihot.virxact.com (Example)</author></item>`;
  const xml =
    '<rss version="2.0"><channel><title>x</title><link>https://aihot.virxact.com/</link>' +
    item('a', 'Wed, 29 Jul 2026 00:00:00 GMT') +
    item('b', 'Wed, 28 Jul 2026 00:00:00 GMT') +
    item('c', 'Wed, 27 Jul 2026 00:00:00 GMT') +
    '</channel></rss>';

  const sinceTime = Math.floor(Date.parse('2026-07-28T12:00:00Z') / 1000);
  const windowed = await collectModule.collectAihotItems({
    sinceTime,
    deps: { fetchFeed: async () => xml },
  });
  assert.deepEqual(windowed.map((i) => i.id), ['a']);

  const capped = await collectModule.collectAihotItems({
    sinceTime: 0,
    maxItems: 2,
    deps: { fetchFeed: async () => xml },
  });
  assert.equal(capped.length, 2);
  assert.deepEqual(capped.map((i) => i.id), ['a', 'b']);
});
