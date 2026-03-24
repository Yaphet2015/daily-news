import test from 'node:test';
import assert from 'node:assert/strict';
import { getCandidatePoolSize, rankItems } from '../src/rank.js';
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
  assert.match(ranked[0].decisionReasons.join(' '), /high_substance/);
  assert.match(ranked[1].decisionReasons.join(' '), /promotional|low_substance/);
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
  assert.match(duplicate?.decisionReasons.join(' ') ?? '', /duplicate_of:primary/);
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
  assert.match(ranked[1].decisionReasons.join(' '), /engagement_supporting_only|low_substance/);
});

test('getCandidatePoolSize keeps the final model input bounded', () => {
  assert.equal(getCandidatePoolSize(10), 10);
  assert.equal(getCandidatePoolSize(51), 51);
  assert.equal(getCandidatePoolSize(120), 120);
  assert.equal(getCandidatePoolSize(151), 150);
  assert.equal(getCandidatePoolSize(220), 150);
});

test('rankItems strongly deprioritizes configured authors for otherwise similar tweets', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'tom',
      url: 'https://x.com/tom_doerr/status/5',
      author: { name: 'Tom Doerr', username: 'tom_doerr' },
      text: 'New agent memory tool with docs, benchmark notes, and repo link https://github.com/example/agent-memory',
      likeCount: 220,
      replyCount: 18,
      repostCount: 25,
      quoteCount: 9,
    }),
    makeTwitterItem({
      id: 'peer',
      url: 'https://x.com/alice/status/6',
      author: { name: 'Alice', username: 'alice' },
      text: 'New agent memory tool with docs, benchmark notes, and repo link https://github.com/example/agent-memory',
      likeCount: 90,
      replyCount: 6,
      repostCount: 8,
      quoteCount: 3,
    }),
  ]);

  const tom = ranked.find((item) => item.id === 'tom');
  const peer = ranked.find((item) => item.id === 'peer');

  assert.ok(tom);
  assert.ok(peer);
  assert.ok((peer?.priorityScore ?? 0) > (tom?.priorityScore ?? 0));
  assert.match(tom?.decisionReasons.join(' ') ?? '', /deprioritized_author:tom_doerr/);
  assert.doesNotMatch(tom?.decisionReasons.join(' ') ?? '', /promotional/);
});

test('rankItems keeps deprioritized authors in results instead of hard filtering them out', () => {
  const ranked = rankItems([
    makeTwitterItem({
      id: 'tom',
      url: 'https://x.com/tom_doerr/status/7',
      author: { name: 'Tom Doerr', username: 'tom_doerr' },
      text: 'OpenAI released an agent SDK guide with migration notes and docs https://example.com/agents',
      likeCount: 120,
      replyCount: 14,
      repostCount: 16,
      quoteCount: 5,
    }),
  ]);

  assert.equal(ranked.length, 1);
  assert.equal(ranked[0]?.id, 'tom');
  assert.match(ranked[0]?.decisionReasons.join(' ') ?? '', /deprioritized_author:tom_doerr/);
  assert.ok((ranked[0]?.priorityScore ?? 0) < 60);
});
