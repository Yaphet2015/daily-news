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
        substackSourceBonus: 0,
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

test('attachReaderBriefs skips Substack roundup child items', async () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).attachReaderBriefs, 'function');

  const attachReaderBriefs = (curateModule as Record<string, Function>).attachReaderBriefs;
  const seen: string[] = [];

  const items = await attachReaderBriefs(
    [
      {
        id: 'ss-parent',
        source: 'substack',
        kind: 'substack_post',
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
      {
        id: 'ss-child',
        source: 'substack',
        kind: 'substack_roundup_entry',
        title: 'Tool',
        sectionLabel: 'Dev dish',
        parentItemId: 'ss-parent',
        text: 'A useful developer tool.',
        author: { name: "Ben's Bites" },
        publication: { name: "Ben's Bites", handle: 'bensbites', url: 'https://www.bensbites.com' },
        publishedAt: '2026-03-15T01:00:00Z',
        url: 'https://example.com/tool',
        originUrl: 'https://www.bensbites.com/p/article',
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

  assert.deepEqual(seen, ['ss-parent']);
  assert.equal(items[1].readerBrief, undefined);
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

test('curateWithModel retries once after an empty main_curate response and then succeeds', async () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).curateWithModel, 'function');

  const curateWithModel = (curateModule as Record<string, Function>).curateWithModel;
  let calls = 0;

  const items = await curateWithModel('system', 'user', {
    model: 'fake-main-model',
    jsonCaller: async () => {
      calls += 1;
      if (calls === 1) {
        return {
          callLabel: 'main_curate',
          model: 'fake-main-model',
          rawText: '',
          finishReason: 'stop',
          usage: { promptTokens: 10, completionTokens: 0, totalTokens: 10 },
        };
      }

      return {
        callLabel: 'main_curate',
        model: 'fake-main-model',
        rawText: JSON.stringify({
          items: [
            {
              id: 'tw-1',
              title: '标题',
              summary: '摘要',
              url: 'https://example.com/story',
              author: 'Alice',
              category: 'Product',
              editorialReason: '值得关注。',
            },
          ],
        }),
        finishReason: 'stop',
        usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
      };
    },
    warn: () => {},
  });

  assert.equal(calls, 2);
  assert.deepEqual(items, [
    {
      id: 'tw-1',
      title: '标题',
      summary: '摘要',
      url: 'https://example.com/story',
      author: 'Alice',
      category: 'Product',
      editorialReason: '值得关注。',
    },
  ]);
});

test('curateWithModel surfaces metadata-rich errors after truncated fenced JSON responses', async () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).curateWithModel, 'function');

  const curateWithModel = (curateModule as Record<string, Function>).curateWithModel;

  await assert.rejects(
    curateWithModel('system', 'user', {
      model: 'fake-main-model',
      jsonCaller: async () => ({
        callLabel: 'main_curate',
        model: 'fake-main-model',
        rawText: '```json\n{"items":[{"id":"tw-1"}]',
        finishReason: 'length',
        usage: { promptTokens: 42, completionTokens: 7, totalTokens: 49 },
      }),
      warn: () => {},
    }),
    (error: unknown) => {
      assert.match(String(error), /main_curate/);
      assert.match(String(error), /fake-main-model/);
      assert.match(String(error), /finishReason=length/);
      assert.match(String(error), /rawTextLength=/);
      assert.match(String(error), /headPreview=/);
      assert.match(String(error), /tailPreview=/);
      return true;
    },
  );
});

test('generateForcedRoundupResponse rejects schema-mismatch responses that omit items', async () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).generateForcedRoundupResponse, 'function');

  const generateForcedRoundupResponse = (curateModule as Record<string, Function>).generateForcedRoundupResponse;

  await assert.rejects(
    generateForcedRoundupResponse(
      [
        {
          id: 'roundup-1',
          source: 'substack',
          kind: 'substack_roundup_entry',
          title: 'Perplexity launched Labs',
          text: 'A useful roundup entry',
          sectionLabel: 'News worth knowing',
          forceSelect: true,
          originUrl: 'https://www.bensbites.com/p/post',
          publishedAt: '2026-03-15T01:00:00Z',
          url: 'https://example.com/perplexity-labs',
          author: { name: "Ben's Bites" },
          publication: { name: "Ben's Bites", handle: 'bensbites', url: 'https://www.bensbites.com' },
          media: [],
        },
      ],
      {
        model: 'fake-roundup-model',
        jsonCaller: async () => ({
          callLabel: 'forced_roundup',
          model: 'fake-roundup-model',
          rawText: JSON.stringify({
            digest: [],
          }),
          finishReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
        }),
        warn: () => {},
      },
    ),
    /forced_roundup.*items/i,
  );
});

test('generateForcedRoundupResponse rejects invalid roundup categories', async () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).generateForcedRoundupResponse, 'function');

  const generateForcedRoundupResponse = (curateModule as Record<string, Function>).generateForcedRoundupResponse;

  await assert.rejects(
    generateForcedRoundupResponse(
      [
        {
          id: 'roundup-1',
          source: 'substack',
          kind: 'substack_roundup_entry',
          title: 'Perplexity launched Labs',
          text: 'A useful roundup entry',
          sectionLabel: 'News worth knowing',
          forceSelect: true,
          originUrl: 'https://www.bensbites.com/p/post',
          publishedAt: '2026-03-15T01:00:00Z',
          url: 'https://example.com/perplexity-labs',
          author: { name: "Ben's Bites" },
          publication: { name: "Ben's Bites", handle: 'bensbites', url: 'https://www.bensbites.com' },
          media: [],
        },
      ],
      {
        model: 'fake-roundup-model',
        jsonCaller: async () => ({
          callLabel: 'forced_roundup',
          model: 'fake-roundup-model',
          rawText: JSON.stringify({
            items: [
              {
                id: 'roundup-1',
                title: '标题',
                summary: '摘要',
                url: 'https://example.com/perplexity-labs',
                author: "Ben's Bites",
                category: '其他',
                editorialReason: '值得关注。',
              },
            ],
          }),
          finishReason: 'stop',
          usage: { promptTokens: 20, completionTokens: 8, totalTokens: 28 },
        }),
        warn: () => {},
      },
    ),
    /forced_roundup.*无效分类|invalid category/i,
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

test('buildCollectedItemsPayload includes full self-thread content for Twitter thread items', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).buildCollectedItemsPayload, 'function');

  const buildCollectedItemsPayload = (curateModule as Record<string, Function>).buildCollectedItemsPayload;
  const payload = buildCollectedItemsPayload([
    {
      id: 'thread-1',
      source: 'twitter',
      text: '[1/2] 1/2\nRoot\n\n[2/2] 2/2\nFollow-up',
      author: { name: 'Alice', username: 'alice' },
      publishedAt: '2026-04-21T00:00:00Z',
      url: 'https://x.com/alice/status/thread-1',
      originUrl: 'https://x.com/alice/status/thread-1',
      media: [],
      selfThread: {
        partIds: ['thread-1', 'thread-2'],
        partCount: 2,
        combinedText: '[1/2] 1/2\nRoot\n\n[2/2] 2/2\nFollow-up',
        parts: [
          {
            id: 'thread-1',
            originUrl: 'https://x.com/alice/status/thread-1',
            text: '1/2\nRoot',
            publishedAt: '2026-04-21T00:00:00Z',
            media: [],
          },
          {
            id: 'thread-2',
            originUrl: 'https://x.com/alice/status/thread-2',
            text: '2/2\nFollow-up',
            publishedAt: '2026-04-21T00:00:05Z',
            media: [],
          },
        ],
      },
      sourceResolution: { decision: 'keep_origin', reason: 'numbered_self_thread' },
    },
  ]);

  assert.match(payload, /Thread Parts: 2/);
  assert.match(payload, /Full Thread Content:\s*\[1\/2\] 1\/2/);
  assert.doesNotMatch(payload, /Primary Source URL: https:\/\/lessons\.md/);
});

test('enrichCuratedItems restores source metadata, attribution, and media by matching id', () => {
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
      title: 'Other launch',
      summary: 'Other summary',
      url: 'https://docs.example.com/other',
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
        substackSourceBonus: 0,
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
      url: 'https://docs.example.com/other',
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
        substackSourceBonus: 0,
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
      sourceResolution: { decision: 'use_linked_source', reason: 'tweet_wrapper' },
    },
    {
      id: 'tw-2',
      title: 'Other launch',
      summary: 'Other summary',
      url: 'https://docs.example.com/other',
      originUrl: 'https://x.com/other/status/2',
      author: 'other',
      category: 'Product',
      source: 'twitter',
      attribution: 'OpenAI Docs',
      media: [],
    },
  ]);
});

test('enrichCuratedItems drops untrusted model rows with unknown ids or mismatched urls', () => {
  const items = [
    {
      id: 'known',
      title: 'Known',
      summary: 'Known summary',
      url: 'https://example.com/known',
      author: 'ignored',
      category: 'Product',
    },
    {
      id: 'known',
      title: 'Wrong URL',
      summary: 'Wrong URL summary',
      url: 'https://example.com/other-story',
      author: 'ignored',
      category: 'Product',
    },
    {
      id: 'missing',
      title: 'Missing',
      summary: 'Missing summary',
      url: 'https://example.com/missing',
      author: 'missing',
      category: 'Tutorial',
    },
  ];

  const collectedItems = [
    {
      id: 'known',
      source: 'twitter',
      text: 'known source text',
      author: { name: 'Alice', username: 'alice' },
      publishedAt: '2026-04-09T08:00:00Z',
      url: 'https://example.com/known',
      media: [],
    },
  ];

  assert.deepEqual(
    curateModule.enrichCuratedItems(items as never[], collectedItems as never[]).map((item) => item.id),
    ['known'],
  );
});

test('enrichCuratedItems dedupes repeated model rows by id and canonical url', () => {
  const items = [
    {
      id: 'lower-score',
      title: 'Lower',
      summary: 'Lower summary',
      url: 'https://example.com/shared',
      author: 'ignored',
      category: 'Product',
    },
    {
      id: 'higher-score',
      title: 'Higher',
      summary: 'Higher summary',
      url: 'https://example.com/shared',
      author: 'ignored',
      category: 'Product',
    },
    {
      id: 'higher-score',
      title: 'Higher duplicate',
      summary: 'Higher duplicate summary',
      url: 'https://example.com/shared',
      author: 'ignored',
      category: 'Product',
    },
  ];

  const collectedItems = [
    {
      id: 'lower-score',
      source: 'twitter',
      text: 'lower',
      author: { name: 'Alice', username: 'alice' },
      publishedAt: '2026-04-09T08:00:00Z',
      url: 'https://example.com/shared',
      media: [],
      editorialScore: 60,
      engagementScore: 0,
      priorityScore: 40,
      decisionReasons: [],
      scoreBreakdown: {
        substance: 20,
        evidence: 10,
        sourceSignal: 5,
        xArticleBonus: 0,
        substackSourceBonus: 0,
        freshness: 8,
        novelty: 15,
        actionability: 0,
        penalties: 0,
      },
    },
    {
      id: 'higher-score',
      source: 'twitter',
      text: 'higher',
      author: { name: 'Bob', username: 'bob' },
      publishedAt: '2026-04-09T08:01:00Z',
      url: 'https://example.com/shared',
      media: [],
      editorialScore: 80,
      engagementScore: 0,
      priorityScore: 70,
      decisionReasons: [],
      scoreBreakdown: {
        substance: 25,
        evidence: 15,
        sourceSignal: 7,
        xArticleBonus: 0,
        substackSourceBonus: 0,
        freshness: 8,
        novelty: 15,
        actionability: 0,
        penalties: 0,
      },
    },
  ];

  const enriched = curateModule.enrichCuratedItems(items as never[], collectedItems as never[]);

  assert.deepEqual(enriched.map((item) => item.id), ['higher-score']);
  assert.equal(enriched[0]?.title, 'Higher');
});

test('enrichCuratedItems preserves combined self-thread origin text and thread metadata', () => {
  const items = [
    {
      id: 'thread-1',
      title: 'Thread title',
      summary: 'Thread summary',
      url: 'https://x.com/alice/status/thread-1',
      author: 'ignored',
      category: 'Product',
    },
  ];

  const collectedItems = [
    {
      id: 'thread-1',
      source: 'twitter',
      text: '[1/2] 1/2\nRoot\n\n[2/2] 2/2\nFollow-up',
      originUrl: 'https://x.com/alice/status/thread-1',
      author: { name: 'Alice', username: 'alice' },
      publishedAt: '2026-04-21T00:00:00Z',
      url: 'https://x.com/alice/status/thread-1',
      media: [],
      selfThread: {
        partIds: ['thread-1', 'thread-2'],
        partCount: 2,
        combinedText: '[1/2] 1/2\nRoot\n\n[2/2] 2/2\nFollow-up',
        parts: [
          {
            id: 'thread-1',
            originUrl: 'https://x.com/alice/status/thread-1',
            text: '1/2\nRoot',
            publishedAt: '2026-04-21T00:00:00Z',
            media: [],
          },
          {
            id: 'thread-2',
            originUrl: 'https://x.com/alice/status/thread-2',
            text: '2/2\nFollow-up',
            publishedAt: '2026-04-21T00:00:05Z',
            media: [],
          },
        ],
      },
      sourceResolution: { decision: 'keep_origin', reason: 'numbered_self_thread' },
    },
  ];

  assert.deepEqual(curateModule.enrichCuratedItems(items as never[], collectedItems as never[]), [
    {
      id: 'thread-1',
      title: 'Thread title',
      summary: 'Thread summary',
      url: 'https://x.com/alice/status/thread-1',
      originUrl: 'https://x.com/alice/status/thread-1',
      author: 'alice',
      category: 'Product',
      source: 'twitter',
      attribution: '@alice',
      media: [],
      originText: '[1/2] 1/2\nRoot\n\n[2/2] 2/2\nFollow-up',
      sourceResolution: { decision: 'keep_origin', reason: 'numbered_self_thread' },
      threadPartCount: 2,
    },
  ]);
});

test('enrichCuratedItemsWithDiagnostics accepts originUrl for a known wrapper item and canonicalizes to primary url', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).enrichCuratedItemsWithDiagnostics, 'function');

  const enrichCuratedItemsWithDiagnostics = (curateModule as Record<string, Function>).enrichCuratedItemsWithDiagnostics;
  const result = enrichCuratedItemsWithDiagnostics(
    [
      {
        id: 'tw-wrapper',
        title: 'Wrapper item',
        summary: 'Wrapper summary',
        url: 'https://x.com/alice/status/1',
        author: 'ignored',
        category: 'Product',
      },
    ],
    [
      {
        id: 'tw-wrapper',
        source: 'twitter',
        text: 'Launch wrapper',
        originUrl: 'https://x.com/alice/status/1',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-05-19T00:00:00Z',
        url: 'https://docs.example.com/launch',
        media: [],
      },
    ],
  );

  assert.deepEqual(result.items.map((item: { id: string; url: string }) => [item.id, item.url]), [
    ['tw-wrapper', 'https://docs.example.com/launch'],
  ]);
  assert.equal(result.diagnostics.rejectedCount, 0);
  assert.deepEqual(result.diagnostics.urlCorrections, [
    {
      id: 'tw-wrapper',
      fromUrl: 'https://x.com/alice/status/1',
      toUrl: 'https://docs.example.com/launch',
      reason: 'origin_url',
    },
  ]);
});

test('enrichCuratedItemsWithDiagnostics accepts primary urls that only differ by tracking params', () => {
  const enrichCuratedItemsWithDiagnostics = (curateModule as Record<string, Function>).enrichCuratedItemsWithDiagnostics;
  const result = enrichCuratedItemsWithDiagnostics(
    [
      {
        id: 'tracked',
        title: 'Tracked item',
        summary: 'Tracked summary',
        url: 'https://example.com/report',
        author: 'ignored',
        category: 'Product',
      },
    ],
    [
      {
        id: 'tracked',
        source: 'twitter',
        text: 'Report',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-05-19T00:00:00Z',
        url: 'https://example.com/report?utm_source=x&ref_code=os_tw_spring',
        media: [],
      },
    ],
  );

  assert.deepEqual(result.items.map((item: { id: string; url: string }) => [item.id, item.url]), [
    ['tracked', 'https://example.com/report?utm_source=x&ref_code=os_tw_spring'],
  ]);
  assert.equal(result.diagnostics.rejectedCount, 0);
  assert.deepEqual(result.diagnostics.urlCorrections, [
    {
      id: 'tracked',
      fromUrl: 'https://example.com/report',
      toUrl: 'https://example.com/report?utm_source=x&ref_code=os_tw_spring',
      reason: 'tracking_params',
    },
  ]);
});

test('enrichCuratedItemsWithDiagnostics recovers ordinal model ids from exact primary urls', () => {
  const enrichCuratedItemsWithDiagnostics = (curateModule as Record<string, Function>).enrichCuratedItemsWithDiagnostics;
  const result = enrichCuratedItemsWithDiagnostics(
    [
      {
        id: '1',
        title: 'Recovered item',
        summary: 'Recovered summary',
        url: 'https://example.com/recovered',
        author: 'ignored',
        category: 'Product',
      },
    ],
    [
      {
        id: 'tw-recovered',
        source: 'twitter',
        text: 'Recovered source text',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-05-19T00:00:00Z',
        url: 'https://example.com/recovered',
        media: [],
      },
    ],
  );

  assert.deepEqual(result.items.map((item: { id: string; url: string }) => [item.id, item.url]), [
    ['tw-recovered', 'https://example.com/recovered'],
  ]);
  assert.equal(result.diagnostics.inputCount, 1);
  assert.equal(result.diagnostics.rejectedCount, 0);
  assert.deepEqual(result.diagnostics.urlCorrections, [
    {
      id: 'tw-recovered',
      fromUrl: 'https://example.com/recovered',
      toUrl: 'https://example.com/recovered',
      reason: 'recovered_primary_url',
    },
  ]);
});

test('enrichCuratedItemsWithDiagnostics recovers ordinal model ids from exact origin urls', () => {
  const enrichCuratedItemsWithDiagnostics = (curateModule as Record<string, Function>).enrichCuratedItemsWithDiagnostics;
  const result = enrichCuratedItemsWithDiagnostics(
    [
      {
        id: '2',
        title: 'Recovered origin item',
        summary: 'Recovered origin summary',
        url: 'https://x.com/alice/status/2',
        author: 'ignored',
        category: 'Product',
      },
    ],
    [
      {
        id: 'tw-origin-recovered',
        source: 'twitter',
        text: 'Recovered source text',
        originUrl: 'https://x.com/alice/status/2',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-05-19T00:00:00Z',
        url: 'https://example.com/origin-recovered',
        media: [],
      },
    ],
  );

  assert.deepEqual(result.items.map((item: { id: string; url: string }) => [item.id, item.url]), [
    ['tw-origin-recovered', 'https://example.com/origin-recovered'],
  ]);
  assert.equal(result.diagnostics.rejectedCount, 0);
  assert.deepEqual(result.diagnostics.urlCorrections, [
    {
      id: 'tw-origin-recovered',
      fromUrl: 'https://x.com/alice/status/2',
      toUrl: 'https://example.com/origin-recovered',
      reason: 'recovered_origin_url',
    },
  ]);
});

test('enrichCuratedItemsWithDiagnostics rejects ordinal ids when the recovery url is ambiguous', () => {
  const enrichCuratedItemsWithDiagnostics = (curateModule as Record<string, Function>).enrichCuratedItemsWithDiagnostics;
  const result = enrichCuratedItemsWithDiagnostics(
    [
      {
        id: '1',
        title: 'Ambiguous item',
        summary: 'Ambiguous summary',
        url: 'https://example.com/shared',
        author: 'ignored',
        category: 'Product',
      },
    ],
    [
      {
        id: 'tw-shared-1',
        source: 'twitter',
        text: 'Shared one',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-05-19T00:00:00Z',
        url: 'https://example.com/shared',
        media: [],
      },
      {
        id: 'tw-shared-2',
        source: 'twitter',
        text: 'Shared two',
        author: { name: 'Bob', username: 'bob' },
        publishedAt: '2026-05-19T00:01:00Z',
        url: 'https://example.com/shared',
        media: [],
      },
    ],
  );

  assert.deepEqual(result.items, []);
  assert.equal(result.diagnostics.rejectedCount, 1);
  assert.equal(result.diagnostics.rejectionCounts.unknown_id, 1);
  assert.deepEqual(result.diagnostics.rejectionSamples, [
    {
      reason: 'unknown_id',
      id: '1',
      title: 'Ambiguous item',
      modelUrl: 'https://example.com/shared',
    },
  ]);
});

test('enrichCuratedItemsWithDiagnostics dedupes items recovered to the same candidate id', () => {
  const enrichCuratedItemsWithDiagnostics = (curateModule as Record<string, Function>).enrichCuratedItemsWithDiagnostics;
  const result = enrichCuratedItemsWithDiagnostics(
    [
      {
        id: '1',
        title: 'Recovered item',
        summary: 'Recovered summary',
        url: 'https://example.com/recovered',
        author: 'ignored',
        category: 'Product',
      },
      {
        id: '2',
        title: 'Recovered duplicate item',
        summary: 'Recovered duplicate summary',
        url: 'https://example.com/recovered',
        author: 'ignored',
        category: 'Product',
      },
    ],
    [
      {
        id: 'tw-recovered',
        source: 'twitter',
        text: 'Recovered source text',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-05-19T00:00:00Z',
        url: 'https://example.com/recovered',
        media: [],
      },
    ],
  );

  assert.deepEqual(result.items.map((item: { id: string }) => item.id), ['tw-recovered']);
  assert.equal(result.diagnostics.rejectedCount, 1);
  assert.equal(result.diagnostics.rejectionCounts.unknown_id, 1);
  assert.equal(result.diagnostics.urlCorrections.length, 1);
});

test('enrichCuratedItemsWithDiagnostics rejects unrelated urls and records url_mismatch samples', () => {
  const enrichCuratedItemsWithDiagnostics = (curateModule as Record<string, Function>).enrichCuratedItemsWithDiagnostics;
  const result = enrichCuratedItemsWithDiagnostics(
    [
      {
        id: 'known',
        title: 'Wrong URL',
        summary: 'Wrong URL summary',
        url: 'https://example.com/other-story',
        author: 'ignored',
        category: 'Product',
      },
    ],
    [
      {
        id: 'known',
        source: 'twitter',
        text: 'Known source text',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-05-19T00:00:00Z',
        url: 'https://example.com/known',
        media: [],
      },
    ],
  );

  assert.deepEqual(result.items, []);
  assert.equal(result.diagnostics.rejectedCount, 1);
  assert.equal(result.diagnostics.rejectionCounts.url_mismatch, 1);
  assert.deepEqual(result.diagnostics.rejectionSamples, [
    {
      reason: 'url_mismatch',
      id: 'known',
      title: 'Wrong URL',
      modelUrl: 'https://example.com/other-story',
      sourceUrl: 'https://example.com/known',
    },
  ]);
});

test('enrichCuratedItemsWithDiagnostics records duplicate id and duplicate url rejections', () => {
  const enrichCuratedItemsWithDiagnostics = (curateModule as Record<string, Function>).enrichCuratedItemsWithDiagnostics;
  const result = enrichCuratedItemsWithDiagnostics(
    [
      {
        id: 'same-id',
        title: 'Same id',
        summary: 'Same id summary',
        url: 'https://example.com/same-id',
        author: 'ignored',
        category: 'Product',
      },
      {
        id: 'same-id',
        title: 'Same id duplicate',
        summary: 'Same id duplicate summary',
        url: 'https://example.com/same-id',
        author: 'ignored',
        category: 'Product',
      },
      {
        id: 'same-url-lower',
        title: 'Same URL lower',
        summary: 'Same URL lower summary',
        url: 'https://example.com/shared',
        author: 'ignored',
        category: 'Product',
      },
      {
        id: 'same-url-higher',
        title: 'Same URL higher',
        summary: 'Same URL higher summary',
        url: 'https://example.com/shared',
        author: 'ignored',
        category: 'Product',
      },
    ],
    [
      {
        id: 'same-id',
        source: 'twitter',
        text: 'Same id',
        author: { name: 'Alice', username: 'alice' },
        publishedAt: '2026-05-19T00:00:00Z',
        url: 'https://example.com/same-id',
        media: [],
        priorityScore: 80,
        editorialScore: 80,
        engagementScore: 0,
        decisionReasons: [],
        scoreBreakdown: {
          substance: 25,
          evidence: 15,
          sourceSignal: 8,
          xArticleBonus: 0,
          substackSourceBonus: 0,
          freshness: 8,
          novelty: 15,
          actionability: 9,
          penalties: 0,
        },
      },
      {
        id: 'same-url-lower',
        source: 'twitter',
        text: 'Same URL lower',
        author: { name: 'Bob', username: 'bob' },
        publishedAt: '2026-05-19T00:01:00Z',
        url: 'https://example.com/shared',
        media: [],
        priorityScore: 30,
        editorialScore: 30,
        engagementScore: 0,
        decisionReasons: [],
        scoreBreakdown: {
          substance: 10,
          evidence: 10,
          sourceSignal: 5,
          xArticleBonus: 0,
          substackSourceBonus: 0,
          freshness: 8,
          novelty: 10,
          actionability: 0,
          penalties: 0,
        },
      },
      {
        id: 'same-url-higher',
        source: 'twitter',
        text: 'Same URL higher',
        author: { name: 'Carol', username: 'carol' },
        publishedAt: '2026-05-19T00:02:00Z',
        url: 'https://example.com/shared',
        media: [],
        priorityScore: 70,
        editorialScore: 70,
        engagementScore: 0,
        decisionReasons: [],
        scoreBreakdown: {
          substance: 24,
          evidence: 15,
          sourceSignal: 7,
          xArticleBonus: 0,
          substackSourceBonus: 0,
          freshness: 8,
          novelty: 15,
          actionability: 1,
          penalties: 0,
        },
      },
    ],
  );

  assert.deepEqual(result.items.map((item: { id: string }) => item.id), ['same-id', 'same-url-higher']);
  assert.equal(result.diagnostics.rejectedCount, 2);
  assert.equal(result.diagnostics.rejectionCounts.duplicate_id, 1);
  assert.equal(result.diagnostics.rejectionCounts.duplicate_url, 1);
  assert.deepEqual(
    result.diagnostics.rejectionSamples.map((sample: { reason: string; id: string }) => [sample.reason, sample.id]),
    [
      ['duplicate_id', 'same-id'],
      ['duplicate_url', 'same-url-lower'],
    ],
  );
});

test('enrichForcedRoundupItems returns one curated row for every forced roundup entry', async () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).enrichForcedRoundupItems, 'function');

  const enrichForcedRoundupItems = (curateModule as Record<string, Function>).enrichForcedRoundupItems;

  const items = await enrichForcedRoundupItems(
    [
      {
        id: 'roundup-1',
        source: 'substack',
        kind: 'substack_roundup_entry',
        title: 'Perplexity launched Labs',
        text: 'A new mode that combines deep research, codegen, and image generation.',
        sectionLabel: 'News worth knowing',
        forceSelect: true,
        originUrl: 'https://www.bensbites.com/p/post',
        publishedAt: '2026-03-15T01:00:00Z',
        url: 'https://example.com/perplexity-labs',
        author: { name: "Ben's Bites" },
        publication: { name: "Ben's Bites", handle: 'bensbites', url: 'https://www.bensbites.com' },
        sourceLabel: 'Perplexity launched Labs',
        media: [],
      },
    ],
    async () => ({
      items: [
        {
          id: 'roundup-1',
          title: 'Perplexity 推出 Labs 模式',
          summary: '这是一条中文摘要。',
          url: 'https://example.com/perplexity-labs',
          author: "Ben's Bites",
          category: 'Product',
          editorialReason: '这条 roundup 提供了可执行的新产品信号。',
        },
      ],
    }),
  );

  assert.deepEqual(items, [
    {
      id: 'roundup-1',
      title: 'Perplexity 推出 Labs 模式',
      summary: '这是一条中文摘要。',
      url: 'https://example.com/perplexity-labs',
      originUrl: 'https://www.bensbites.com/p/post',
      author: "Ben's Bites",
      attribution: 'Perplexity launched Labs',
      source: 'substack',
      category: 'Product',
      media: [],
      editorialReason: '这条 roundup 提供了可执行的新产品信号。',
    },
  ]);
});

test('mergeCuratedItems keeps all forced roundup rows and prefers normal curated rows on conflicts', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).mergeCuratedItems, 'function');

  const mergeCuratedItems = (curateModule as Record<string, Function>).mergeCuratedItems;
  const merged = mergeCuratedItems(
    [
      {
        id: 'normal-1',
        title: 'Normal item',
        summary: 'Normal summary',
        url: 'https://example.com/normal',
        author: 'alice',
        attribution: '@alice',
        source: 'twitter',
        category: 'Product',
        media: [],
        priorityScore: 80,
      },
      {
        id: 'roundup-1',
        title: 'Preferred normal version',
        summary: 'Normal summary for roundup',
        url: 'https://example.com/roundup',
        author: "Ben's Bites",
        attribution: "Ben's Bites · News worth knowing",
        source: 'substack',
        category: 'Product',
        media: [],
        priorityScore: 70,
      },
    ],
    [
      {
        id: 'roundup-1',
        title: 'Forced version',
        summary: 'Forced summary',
        url: 'https://example.com/roundup',
        author: "Ben's Bites",
        attribution: "Ben's Bites · News worth knowing",
        source: 'substack',
        category: 'Product',
        media: [],
      },
      {
        id: 'roundup-2',
        title: 'Forced only',
        summary: 'Forced only summary',
        url: 'https://example.com/forced-only',
        author: "Ben's Bites",
        attribution: "Ben's Bites · Dev dish",
        source: 'substack',
        category: 'Tutorial',
        media: [],
      },
    ],
  );

  assert.deepEqual(
    merged.map((item: { id: string; title: string }) => ({ id: item.id, title: item.title })),
    [
      { id: 'normal-1', title: 'Normal item' },
      { id: 'roundup-1', title: 'Preferred normal version' },
      { id: 'roundup-2', title: 'Forced only' },
    ],
  );
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
