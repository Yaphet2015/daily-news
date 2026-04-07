import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as curateModule from '../src/curate.js';

test('buildCollectedItemsPayload includes media metadata for Twitter items', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).buildCollectedItemsPayload, 'function');

  const buildCollectedItemsPayload = (curateModule as Record<string, Function>).buildCollectedItemsPayload;
  const payload = buildCollectedItemsPayload([
    {
      id: '1',
      source: 'twitter',
      text: 'launch',
      author: { name: 'Alice', username: 'alice' },
      publishedAt: '2026-03-15T00:00:00Z',
      url: 'https://x.com/alice/status/1',
      media: [
        { type: 'photo', url: 'https://img/1.jpg', width: 1200, height: 675 },
        { type: 'video', url: 'https://video/1.mp4' },
      ],
    },
    {
      id: '2',
      source: 'twitter',
      text: 'plain text',
      author: { name: 'Bob', username: 'bob' },
      publishedAt: '2026-03-15T00:01:00Z',
      url: 'https://x.com/bob/status/2',
      media: [],
    },
  ]);

  assert.match(payload, /Source: twitter/);
  assert.match(payload, /Media:\n- photo 1200x675 https:\/\/img\/1\.jpg\n- video unknown https:\/\/video\/1\.mp4/);
  assert.match(payload, /Media: none/);
});

test('buildCollectedItemsPayload includes ranking metadata when present', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).buildCollectedItemsPayload, 'function');

  const buildCollectedItemsPayload = (curateModule as Record<string, Function>).buildCollectedItemsPayload;
  const payload = buildCollectedItemsPayload([
    {
      id: '1',
      source: 'twitter',
      text: 'launch',
      author: { name: 'Alice', username: 'alice' },
      publishedAt: '2026-03-15T00:00:00Z',
      url: 'https://x.com/alice/status/1',
      media: [],
      editorialScore: 78,
      engagementScore: 15,
      priorityScore: 62,
      decisionReasons: ['高信息密度', '有理有据'],
      scoreBreakdown: {
        substance: 24,
        evidence: 16,
        sourceSignal: 6,
        xArticleBonus: 0,
        freshness: 9,
        novelty: 15,
        actionability: 0,
        penalties: 0,
      },
    },
  ]);

  assert.match(payload, /优先级分: 62/);
  assert.match(payload, /编辑分: 78/);
  assert.match(payload, /互动分: 15/);
  assert.match(payload, /决策依据: 高信息密度, 有理有据/);
});

test('attachReaderBriefs only invokes the reader for Substack items', async () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).attachReaderBriefs, 'function');

  const attachReaderBriefs = (curateModule as Record<string, Function>).attachReaderBriefs;
  const seen: string[] = [];

  const items = await attachReaderBriefs(
    [
      {
        id: 'tw-1',
        source: 'twitter',
        text: 'tweet',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-03-15T00:00:00Z',
        url: 'https://x.com/alice/status/1',
        media: [],
      },
      {
        id: 'ss-1',
        source: 'substack',
        title: 'Article',
        subtitle: 'Subtitle',
        text: 'excerpt',
        body: 'Full article body',
        author: { name: 'Pub' },
        publication: { name: 'Pub', handle: 'pub', url: 'https://pub.substack.com' },
        publishedAt: '2026-03-15T01:00:00Z',
        url: 'https://pub.substack.com/p/article',
        media: [],
      },
    ],
    async (item: { id: string }) => {
      seen.push(item.id);
      return {
        summary: 'summary',
        keyPoints: ['point'],
        claims: ['claim'],
        whyItMatters: 'why',
        signals: ['signal'],
        caveats: ['caveat'],
      };
    },
  );

  assert.deepEqual(seen, ['ss-1']);
  assert.equal(items[0].readerBrief, undefined);
  assert.deepEqual(items[1].readerBrief, {
    summary: 'summary',
    keyPoints: ['point'],
    claims: ['claim'],
    whyItMatters: 'why',
    signals: ['signal'],
    caveats: ['caveat'],
  });
});

test('attachReaderBriefs reuses an existing reader brief instead of reading the Substack article twice', async () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).attachReaderBriefs, 'function');

  const attachReaderBriefs = (curateModule as Record<string, Function>).attachReaderBriefs;
  let calls = 0;

  const existingBrief = {
    summary: 'Existing summary',
    keyPoints: ['Point A'],
    claims: ['Claim A'],
    whyItMatters: 'Because it matters.',
    signals: ['Signal A'],
    caveats: ['Caveat A'],
  };

  const items = await attachReaderBriefs(
    [
      {
        id: 'ss-existing',
        source: 'substack',
        title: 'Article',
        subtitle: 'Subtitle',
        text: 'excerpt',
        body: 'Full article body',
        author: { name: 'Pub' },
        publication: { name: 'Pub', handle: 'pub', url: 'https://pub.substack.com' },
        publishedAt: '2026-03-15T01:00:00Z',
        url: 'https://pub.substack.com/p/article',
        media: [],
        readerBrief: existingBrief,
      },
    ],
    async () => {
      calls += 1;
      return {
        summary: 'new summary',
        keyPoints: ['point'],
        claims: ['claim'],
        whyItMatters: 'why',
        signals: ['signal'],
        caveats: ['caveat'],
      };
    },
  );

  assert.equal(calls, 0);
  assert.deepEqual(items[0].readerBrief, existingBrief);
});

test('parseReaderBrief rejects malformed JSON payloads', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).parseReaderBrief, 'function');

  const parseReaderBrief = (curateModule as Record<string, Function>).parseReaderBrief;
  assert.throws(
    () => parseReaderBrief('{"summary":"only summary"}'),
    /reader brief/i,
  );
});

test('parseReaderBrief normalizes null list fields to empty arrays', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).parseReaderBrief, 'function');

  const parseReaderBrief = (curateModule as Record<string, Function>).parseReaderBrief;
  const brief = parseReaderBrief(
    JSON.stringify({
      summary: 'Summary',
      keyPoints: null,
      claims: ['Claim'],
      whyItMatters: 'Why',
      signals: null,
      caveats: null,
    }),
  );

  assert.deepEqual(brief, {
    summary: 'Summary',
    keyPoints: [],
    claims: ['Claim'],
    whyItMatters: 'Why',
    signals: [],
    caveats: [],
  });
});

test('parseReaderBrief normalizes missing list fields to empty arrays', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).parseReaderBrief, 'function');

  const parseReaderBrief = (curateModule as Record<string, Function>).parseReaderBrief;
  const brief = parseReaderBrief(
    JSON.stringify({
      summary: 'Summary',
      whyItMatters: 'Why',
    }),
  );

  assert.deepEqual(brief, {
    summary: 'Summary',
    keyPoints: [],
    claims: [],
    whyItMatters: 'Why',
    signals: [],
    caveats: [],
  });
});

test('parseReaderBrief still rejects invalid list payload types', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).parseReaderBrief, 'function');

  const parseReaderBrief = (curateModule as Record<string, Function>).parseReaderBrief;
  assert.throws(
    () =>
      parseReaderBrief(
        JSON.stringify({
          summary: 'Summary',
          keyPoints: 'not-an-array',
          claims: [],
          whyItMatters: 'Why',
          signals: [],
          caveats: [],
        }),
      ),
    /reader brief/i,
  );
});

test('buildCollectedItemsPayload uses reader brief for Substack items instead of raw body', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).buildCollectedItemsPayload, 'function');

  const buildCollectedItemsPayload = (curateModule as Record<string, Function>).buildCollectedItemsPayload;
  const payload = buildCollectedItemsPayload([
    {
      id: 'ss-1',
      source: 'substack',
      title: 'Article',
      subtitle: 'Subtitle',
      text: 'excerpt',
      body: 'THIS SHOULD NOT APPEAR',
      author: { name: 'Example Author' },
      publication: { name: 'Example Publication', handle: 'examplepub', url: 'https://example.substack.com' },
      publishedAt: '2026-03-15T08:00:00Z',
      url: 'https://example.substack.com/p/article',
      media: [{ type: 'photo', url: 'https://img.example/cover.jpg' }],
      readerBrief: {
        summary: 'Reader summary',
        keyPoints: ['Point A', 'Point B'],
        claims: ['Claim A'],
        whyItMatters: 'Because it shifts the market.',
        signals: ['Signal A'],
        caveats: ['Caveat A'],
      },
    },
  ]);

  assert.match(payload, /Source: substack/);
  assert.match(payload, /Publication: Example Publication/);
  assert.match(payload, /Reader summary/);
  assert.doesNotMatch(payload, /THIS SHOULD NOT APPEAR/);
});

test('enrichCuratedItems restores source metadata, attribution, and media by matching id when urls collide', () => {
  assert.equal(typeof curateModule.enrichCuratedItems, 'function');

  const items = [
    {
      id: 'tw-1',
      title: 'Title',
      summary: 'Summary',
      url: 'https://docs.example.com/launch',
      author: 'ignored',
      category: 'Product',
    },
    {
      id: 'tw-2',
      title: 'Competing wrapper',
      summary: 'Wrapper summary',
      url: 'https://docs.example.com/launch',
      author: 'ignored-2',
      category: 'Product',
    },
    {
      id: 'missing',
      title: 'Missing',
      summary: 'Missing summary',
      url: 'https://x.com/missing/status/9',
      author: 'missing',
      category: 'Tutorial',
    },
  ];

  const collectedItems = [
    {
      id: 'tw-1',
      source: 'twitter',
      text: 'launch',
      originUrl: 'https://x.com/openai/status/1',
      sourceLabel: 'OpenAI Docs',
      sourceResolution: { decision: 'use_linked_source', reason: 'tweet_wrapper' },
      linkedSource: {
        url: 'https://docs.example.com/launch',
        title: 'OpenAI Docs',
        description: 'Launch docs',
        excerpt: 'Product docs',
        domain: 'docs.example.com',
        via: 'tweet',
      },
      author: { name: 'OpenAI', username: 'openai' },
      editorialScore: 77,
      engagementScore: 0,
      priorityScore: 58,
      decisionReasons: ['高信息密度', '有理有据'],
      scoreBreakdown: {
        substance: 24,
        evidence: 14,
        sourceSignal: 8,
        xArticleBonus: 0,
        freshness: 9,
        novelty: 15,
        actionability: 7,
        penalties: 0,
      },
      publishedAt: '2026-03-15T08:00:00Z',
      url: 'https://docs.example.com/launch',
      media: [{ type: 'photo', url: 'https://img/cover.jpg' }],
    },
    {
      id: 'tw-2',
      source: 'twitter',
      text: 'another wrapper',
      originUrl: 'https://x.com/other/status/2',
      sourceLabel: 'OpenAI Docs',
      author: { name: 'Other', username: 'other' },
      publishedAt: '2026-03-15T08:01:00Z',
      url: 'https://docs.example.com/launch',
      media: [],
    },
    {
      id: 'ss-1',
      source: 'substack',
      title: 'Article',
      text: 'excerpt',
      body: 'body',
      author: { name: 'Ben Thompson' },
      publication: {
        name: 'Stratechery',
        handle: 'stratechery',
        url: 'https://stratechery.com',
      },
      editorialScore: 77,
      engagementScore: 0,
      priorityScore: 58,
      decisionReasons: ['高信息密度', '有理有据'],
      scoreBreakdown: {
        substance: 24,
        evidence: 14,
        sourceSignal: 8,
        xArticleBonus: 0,
        freshness: 9,
        novelty: 15,
        actionability: 7,
        penalties: 0,
      },
      publishedAt: '2026-03-15T08:00:00Z',
      url: 'https://example.substack.com/p/article',
      media: [{ type: 'photo', url: 'https://img/cover.jpg' }],
    },
  ];

  assert.deepEqual(curateModule.enrichCuratedItems(items as never[], collectedItems as never[]), [
    {
      id: 'tw-1',
      title: 'Title',
      summary: 'Summary',
      url: 'https://docs.example.com/launch',
      originUrl: 'https://x.com/openai/status/1',
      author: 'openai',
      category: 'Product',
      source: 'twitter',
      attribution: 'OpenAI Docs',
      media: [{ type: 'photo', url: 'https://img/cover.jpg' }],
      priorityScore: 58,
      decisionReasons: ['高信息密度', '有理有据'],
    },
    {
      id: 'tw-2',
      title: 'Competing wrapper',
      summary: 'Wrapper summary',
      url: 'https://docs.example.com/launch',
      originUrl: 'https://x.com/other/status/2',
      author: 'other',
      category: 'Product',
      source: 'twitter',
      attribution: 'OpenAI Docs',
      media: [],
    },
    {
      id: 'missing',
      title: 'Missing',
      summary: 'Missing summary',
      url: 'https://x.com/missing/status/9',
      author: 'missing',
      category: 'Tutorial',
      source: 'twitter',
      attribution: '@missing',
      media: [],
    },
  ]);
});

test('curator prompt requires materially longer investigative summaries, editorial reasons, and fixed categories', () => {
  const prompt = readFileSync(new URL('../prompts/curator.md', import.meta.url), 'utf-8');

  assert.match(prompt, /`id`/);
  assert.match(prompt, /4-9 sentences|120-320 Chinese characters/);
  assert.doesNotMatch(prompt, /2-4 sentences/);
  assert.match(prompt, /underlying dynamics|structural shift|second-order implications|what is still unclear/i);
  assert.match(prompt, /Product, Tutorial, and Opinions\/Thoughts/);
  assert.match(prompt, /editorialReason/);
  assert.match(prompt, /at least 40 items/i);
  assert.doesNotMatch(prompt, /at least 30 items/i);
  assert.match(prompt, /closer to 50|prefer returning closer to 50/i);
  assert.match(prompt, /`category`/);
  assert.doesNotMatch(prompt, /`tags`/);
});

test('warnOnUnderfilledCuratedItems only warns when curated output is below the soft floor', () => {
  assert.equal(typeof curateModule.warnOnUnderfilledCuratedItems, 'function');

  const warnings: string[] = [];
  curateModule.warnOnUnderfilledCuratedItems(39, (message: string) => warnings.push(message));
  curateModule.warnOnUnderfilledCuratedItems(40, (message: string) => warnings.push(message));

  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /39/);
  assert.match(warnings[0], /40/);
});
