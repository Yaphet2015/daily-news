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

test('parseReaderBrief rejects malformed JSON payloads', () => {
  assert.equal(typeof (curateModule as Record<string, unknown>).parseReaderBrief, 'function');

  const parseReaderBrief = (curateModule as Record<string, Function>).parseReaderBrief;
  assert.throws(
    () => parseReaderBrief('{"summary":"only summary"}'),
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

test('enrichCuratedItems restores source metadata, attribution, and media by matching url', () => {
  assert.equal(typeof curateModule.enrichCuratedItems, 'function');

  const items = [
    {
      title: 'Title',
      summary: 'Summary',
      url: 'https://example.substack.com/p/article',
      author: 'ignored',
      tags: ['AI'],
    },
    {
      title: 'Missing',
      summary: 'Missing summary',
      url: 'https://x.com/missing/status/9',
      author: 'missing',
      tags: ['工具'],
    },
  ];

  const collectedItems = [
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
      publishedAt: '2026-03-15T08:00:00Z',
      url: 'https://example.substack.com/p/article',
      media: [{ type: 'photo', url: 'https://img/cover.jpg' }],
    },
  ];

  assert.deepEqual(curateModule.enrichCuratedItems(items as never[], collectedItems as never[]), [
    {
      title: 'Title',
      summary: 'Summary',
      url: 'https://example.substack.com/p/article',
      author: 'Ben Thompson',
      tags: ['AI'],
      source: 'substack',
      attribution: 'Stratechery / Ben Thompson',
      media: [{ type: 'photo', url: 'https://img/cover.jpg' }],
    },
    {
      title: 'Missing',
      summary: 'Missing summary',
      url: 'https://x.com/missing/status/9',
      author: 'missing',
      tags: ['工具'],
      source: 'twitter',
      attribution: '@missing',
      media: [],
    },
  ]);
});

test('curator prompt requires materially longer investigative summaries', () => {
  const prompt = readFileSync(new URL('../prompts/curator.md', import.meta.url), 'utf-8');

  assert.match(prompt, /4-9 sentences|120-320 Chinese characters/);
  assert.doesNotMatch(prompt, /2-4 sentences/);
  assert.match(prompt, /underlying dynamics|structural shift|second-order implications|what is still unclear/i);
});
