import test from 'node:test';
import assert from 'node:assert/strict';
import { getCandidatePoolSize, rankItems } from '../src/rank.js';
import { mapTwitterCliTweet } from '../src/collect.js';
import type { CollectedItem } from '../src/types.js';

function makeTwitterItem(overrides: Partial<CollectedItem> = {}): CollectedItem {
  return {
    id: overrides.id ?? Math.random().toString(36).slice(2),
    source: 'twitter',
    url: overrides.url ?? 'https://x.com/example/status/1',
    publishedAt: overrides.publishedAt ?? '2026-03-19T10:00:00Z',
    author: overrides.author ?? { name: 'Alice', username: 'alice' },
    text: overrides.text ?? 'Default text',
    media: overrides.media ?? [],
    ...overrides,
  };
}

test('rankItems prioritizes substantive evidence-backed items over promotional posts', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'high-signal',
      url: 'https://x.com/alice/status/1',
      text: 'OpenAI released GPT-6 coding agent with benchmark data, API docs, pricing table, and rollout details https://example.com/docs',
      media: [{ type: 'photo', url: 'https://img/launch.jpg' }],
    }),
    makeTwitterItem({
      id: 'promo',
      url: 'https://x.com/bob/status/2',
      text: 'Huge vibes. Join us tomorrow. Hiring now. So excited for what is coming.',
      author: { name: 'Bob', username: 'bob' },
    }),
  ]);

  assert.equal(ranked[0]?.id, 'high-signal');
  assert.ok(ranked[0].priorityScore > ranked[1].priorityScore);
  assert.match(ranked[0].decisionReasons.join(' '), /高信息密度/);
  assert.match(ranked[1].decisionReasons.join(' '), /宣发内容|低质量内容/);
});

test('rankItems marks and penalizes weaker duplicates', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'primary',
      url: 'https://x.com/alice/status/1',
      text: 'Anthropic released Claude 4 with benchmarks, pricing, and API launch docs https://example.com/claude',
      media: [{ type: 'photo', url: 'https://img/claude.jpg' }],
    }),
    makeTwitterItem({
      id: 'duplicate',
      url: 'https://x.com/bob/status/2',
      text: 'Anthropic released Claude 4 with benchmarks, pricing, and API launch docs https://example.com/claude',
      author: { name: 'Bob', username: 'bob' },
    }),
  ]);

  const duplicate = ranked.find((item) => item.id === 'duplicate');
  const primary = ranked.find((item) => item.id === 'primary');

  assert.ok(primary);
  assert.ok(duplicate);
  assert.equal(duplicate?.duplicateOf, 'primary');
  assert.match(duplicate?.decisionReasons.join(' ') ?? '', /重复内容:primary/);
  assert.ok((primary?.priorityScore ?? 0) > (duplicate?.priorityScore ?? 0));
});

test('engagement helps break ties but does not overcome weak substance', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'useful',
      url: 'https://x.com/alice/status/3',
      text: 'New TypeScript 6 RC adds project references caching, migration notes, and compiler benchmarks https://example.com/ts',
      likeCount: 12,
      replyCount: 2,
      repostCount: 1,
      quoteCount: 0,
    }),
    makeTwitterItem({
      id: 'hype',
      url: 'https://x.com/bob/status/4',
      text: 'This is insane. absolutely wild. wow wow wow.',
      author: { name: 'Bob', username: 'bob' },
      likeCount: 5000,
      replyCount: 800,
      repostCount: 700,
      quoteCount: 400,
    }),
  ]);

  assert.equal(ranked[0]?.id, 'useful');
  assert.ok(ranked[0].priorityScore > ranked[1].priorityScore);
  assert.match(ranked[1].decisionReasons.join(' '), /互动支持:仅作辅助信号|低质量内容/);
});

test('getCandidatePoolSize keeps the final model input bounded', () => {
  assert.equal(getCandidatePoolSize(10), 10);
  assert.equal(getCandidatePoolSize(51), 51);
  assert.equal(getCandidatePoolSize(120), 120);
  assert.equal(getCandidatePoolSize(151), 150);
  assert.equal(getCandidatePoolSize(220), 150);
});

test('rankItems hard filters configured blocked authors before ranking', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'tom',
      url: 'https://x.com/tom_doerr/status/7',
      author: { name: 'Tom Doerr', username: '@Tom_Doerr' },
      text: 'OpenAI released an agent SDK guide with migration notes and docs https://example.com/agents',
      likeCount: 120,
      replyCount: 14,
      repostCount: 16,
      quoteCount: 5,
    }),
  ]);

  assert.equal(ranked.length, 0);
});

test('rankItems boosts configured official authors for otherwise similar tweets', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'openai',
      url: 'https://x.com/OpenAI/status/8',
      author: { name: 'OpenAI', username: 'OpenAI' },
      text: 'GPT model update with API docs, pricing notes, and benchmark details https://example.com/openai',
      likeCount: 80,
      replyCount: 9,
      repostCount: 11,
      quoteCount: 3,
    }),
    makeTwitterItem({
      id: 'anthropic',
      url: 'https://x.com/AnthropicAI/status/9',
      author: { name: 'Anthropic', username: 'AnthropicAI' },
      text: 'Claude model update with API docs, pricing notes, and benchmark details https://example.com/anthropic',
      likeCount: 78,
      replyCount: 8,
      repostCount: 10,
      quoteCount: 3,
    }),
    makeTwitterItem({
      id: 'peer',
      url: 'https://x.com/alice/status/10',
      author: { name: 'Alice', username: 'alice' },
      text: 'Model update with API docs, pricing notes, and benchmark details https://example.com/peer',
      likeCount: 82,
      replyCount: 9,
      repostCount: 11,
      quoteCount: 3,
    }),
  ]);

  const openai = ranked.find((item) => item.id === 'openai');
  const anthropic = ranked.find((item) => item.id === 'anthropic');
  const peer = ranked.find((item) => item.id === 'peer');

  assert.ok(openai);
  assert.ok(anthropic);
  assert.ok(peer);
  assert.ok((openai?.priorityScore ?? 0) > (peer?.priorityScore ?? 0));
  assert.ok((anthropic?.priorityScore ?? 0) > (peer?.priorityScore ?? 0));
  assert.match(openai?.decisionReasons.join(' ') ?? '', /作者规则:openai官号/);
  assert.match(anthropic?.decisionReasons.join(' ') ?? '', /作者规则:anthropicai官号/);
});

test('rankItems does not mark a personal tweet with a linked source as official', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'personal-linked-source',
      text: 'Deep dive into the new API design and migration path.',
      author: { name: 'Alice', username: 'alice' },
      linkedSource: {
        url: 'https://blog.example.com/api-design',
        title: 'API Design Notes',
        description: 'Personal analysis',
        excerpt: 'Long analysis of the API trade-offs and rollout details.',
        domain: 'blog.example.com',
        via: 'tweet',
      },
      sourceResolution: { decision: 'use_linked_source', reason: 'tweet_wrapper' },
    }),
  ]);

  assert.equal(ranked.length, 1);
  assert.doesNotMatch(ranked[0]?.decisionReasons.join(' ') ?? '', /官方/);
});

test('rankItems marks allowlisted official source domains as official', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'official-domain',
      text: 'Official documentation update with migration notes and examples.',
      author: { name: 'Alice', username: 'alice' },
      linkedSource: {
        url: 'https://docs.openai.com/guides/responses',
        title: 'Responses API Guide',
        description: 'Official docs',
        excerpt: 'Guide covering migration notes and usage examples.',
        domain: 'docs.openai.com',
        via: 'tweet',
      },
      sourceResolution: { decision: 'use_linked_source', reason: 'tweet_wrapper' },
    }),
  ]);

  assert.equal(ranked.length, 1);
  assert.match(ranked[0]?.decisionReasons.join(' ') ?? '', /官方/);
});

test('rankItems adds exactly 10 editorial points for X articles', () => {
  const articleText = 'Long-form analysis of agentic coding workflows with concrete evaluation criteria alpha.';
  const nonArticleText = 'Long-form analysis of agentic coding workflows with concrete evaluation criteria bravo.';
  const ranked = rankItems([
    makeTwitterItem({
      id: 'x-article',
      url: 'https://x.com/alice/status/x-article',
      text: articleText,
      linkedSource: {
        url: 'https://x.com/i/article/2034035257553690624',
        title: 'Agentic Coding Workflows',
        description: 'X article',
        excerpt: 'A long-form analysis of agentic coding workflows and evaluation criteria.',
        domain: 'x.com',
        via: 'tweet',
      },
      sourceResolution: { decision: 'use_linked_source', reason: 'tweet_wrapper' },
    }),
    makeTwitterItem({
      id: 'external-article',
      url: 'https://x.com/alice/status/external-article',
      text: nonArticleText,
      linkedSource: {
        url: 'https://blog.example.com/agentic-coding',
        title: 'Agentic Coding Workflows',
        description: 'Article',
        excerpt: 'A long-form analysis of agentic coding workflows and evaluation criteria.',
        domain: 'blog.example.com',
        via: 'tweet',
      },
      sourceResolution: { decision: 'use_linked_source', reason: 'tweet_wrapper' },
    }),
  ]);

  const articleItem = ranked.find((item) => item.id === 'x-article');
  const nonArticleItem = ranked.find((item) => item.id === 'external-article');

  assert.equal(articleItem?.editorialScore, (nonArticleItem?.editorialScore ?? 0) + 10);
  assert.match(articleItem?.decisionReasons.join(' ') ?? '', /X article/);
  assert.doesNotMatch(nonArticleItem?.decisionReasons.join(' ') ?? '', /X article/);
});

test('rankItems does not add X article bonus to normal X status links', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'x-status-link',
      text: 'A tweet with a normal X status link should not count as a long-form article.',
      linkedSource: {
        url: 'https://x.com/alice/status/1234567890',
        title: 'Normal status',
        description: 'Tweet',
        excerpt: 'This is still just a normal X status link.',
        domain: 'x.com',
        via: 'tweet',
      },
      sourceResolution: { decision: 'use_linked_source', reason: 'tweet_wrapper' },
    }),
  ]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.scoreBreakdown.xArticleBonus, 0);
  assert.doesNotMatch(ranked[0]?.decisionReasons.join(' ') ?? '', /X article/);
});

test('rankItems adds X article bonus for articleTitle/articleText fallback tweets', () => {
  const mapped = mapTwitterCliTweet({
    id: 'fallback-article',
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

  const ranked = rankItems([mapped]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.scoreBreakdown.xArticleBonus, 10);
  assert.match(ranked[0]?.decisionReasons.join(' ') ?? '', /X article/);
});

test('rankItems stops marking long-form Substack posts as low quality when a reader brief is present', () => {
  const withoutBrief = makeTwitterItem({
    id: 'llm-bench-without-brief',
    source: 'substack',
    url: 'https://cameronrwolfe.substack.com/p/llm-bench',
    publishedAt: '2026-03-30T09:33:10Z',
    author: { name: 'Cameron R. Wolfe, Ph.D.' },
    publication: {
      name: 'Deep (Learning) Focus',
      handle: 'cameronrwolfe',
      url: 'https://cameronrwolfe.substack.com',
    },
    title: 'The Anatomy of an LLM Benchmark',
    subtitle: 'Common patterns used to create the most effective LLM evaluation datasets...',
    text: 'Common patterns used to create the most effective LLM evaluation datasets...',
    body:
      'Throughout the history of AI research, progress has been measured and accelerated by high-quality benchmarks.',
    media: [{ type: 'photo', url: 'https://img.example/llm-bench.png' }],
  });

  const withBrief = {
    ...withoutBrief,
    id: 'llm-bench-with-brief',
    readerBrief: {
      summary: 'An overview of how strong LLM benchmarks are designed and maintained.',
      keyPoints: ['Benchmark saturation', 'Dataset construction', 'Measurement design'],
      claims: ['LLM benchmarks need continual reinvention'],
      whyItMatters: 'Benchmark quality shapes research progress.',
      signals: ['Practical patterns', 'Survey depth'],
      caveats: ['Agent benchmarks intentionally out of scope'],
    },
  } satisfies CollectedItem;

  const ranked = rankItems([withoutBrief, withBrief]);
  const baseline = ranked.find((item) => item.id === 'llm-bench-without-brief');
  const improved = ranked.find((item) => item.id === 'llm-bench-with-brief');

  assert.ok(baseline);
  assert.ok(improved);
  assert.match(baseline?.decisionReasons.join(' ') ?? '', /低质量内容/);
  assert.doesNotMatch(improved?.decisionReasons.join(' ') ?? '', /低质量内容/);
  assert.ok((improved?.priorityScore ?? 0) > (baseline?.priorityScore ?? 0));
});
