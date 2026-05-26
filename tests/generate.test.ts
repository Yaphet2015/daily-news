import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGenerateOptions, runGenerate } from '../src/generate.js';
import type { CollectionSnapshot, CuratedItem, CurationDiagnostics, PendingDraft, ReviewPacket } from '../src/types.js';

function createSnapshot(overrides: Partial<CollectionSnapshot> = {}): CollectionSnapshot {
  return {
    collectedAt: 1710000000,
    enabledSources: ['twitter'],
    items: [
      {
        id: 'tw-1',
        source: 'twitter',
        text: 'tweet',
        publishedAt: '2026-03-15T00:00:00Z',
        url: 'https://x.com/alice/status/1',
        author: { name: 'Alice', username: 'alice' },
        media: [],
      },
    ],
    ...overrides,
  };
}

function createCollectedItem(overrides: Partial<CollectionSnapshot['items'][number]> = {}): CollectionSnapshot['items'][number] {
  return {
    id: 'tw-1',
    source: 'twitter',
    text: 'tweet',
    publishedAt: '2026-03-15T00:00:00Z',
    url: 'https://x.com/alice/status/1',
    author: { name: 'Alice', username: 'alice' },
    media: [],
    ...overrides,
  };
}

function createDraft(overrides: Partial<PendingDraft> = {}): PendingDraft {
  return {
    collectedAt: 1710000000,
    enabledSources: ['twitter'],
    items: createSnapshot().items,
    ...overrides,
  };
}

function createCuratedItem(overrides: Partial<CuratedItem> = {}): CuratedItem {
  return {
    id: 'tw-1',
    title: 'Launch',
    summary: 'Summary',
    url: 'https://x.com/alice/status/1',
    author: 'Alice',
    attribution: '@alice',
    source: 'twitter',
    category: 'Product',
    media: [],
    ...overrides,
  };
}

function createCurationDiagnostics(overrides: Partial<CurationDiagnostics> = {}): CurationDiagnostics {
  return {
    inputCount: 2,
    outputCount: 1,
    rejectedCount: 1,
    rejectionCounts: {
      unknown_id: 0,
      url_mismatch: 1,
      duplicate_id: 0,
      duplicate_url: 0,
    },
    rejectionSamples: [
      {
        reason: 'url_mismatch',
        id: 'tw-2',
        title: 'Wrong URL',
        modelUrl: 'https://example.com/wrong',
        sourceUrl: 'https://example.com/right',
      },
    ],
    urlCorrections: [
      {
        id: 'tw-1',
        fromUrl: 'https://x.com/alice/status/1',
        toUrl: 'https://example.com/right',
        reason: 'origin_url',
      },
    ],
    ...overrides,
  };
}

test('runGenerate resumes an existing pending draft without recollecting and clears it after publish', async () => {
  const events: string[] = [];
  const draft = createDraft();

  await runGenerate({
    readDraft: async () => draft,
    choosePendingDraftAction: async () => 'resume',
    collect: async () => {
      events.push('collect');
      return createSnapshot();
    },
    writeDraft: async () => {
      events.push('writeDraft');
    },
    clearDraft: async () => {
      events.push('clearDraft');
    },
    readState: async () => ({
      sources: {
        twitter: { lastPublishedTime: 100 },
        substack: { lastPublishedTime: 0 },
      },
    }),
    writeState: async (state) => {
      events.push(`writeState:${state.sources.twitter.lastPublishedTime}`);
    },
    attachReaderBriefs: async (items) => {
      events.push(`attach:${items.length}`);
      return items;
    },
    rankItems: (items) => {
      events.push(`rank:${items.length}`);
      return items as never;
    },
    selectCandidatePool: (items) => {
      events.push(`pool:${items.length}`);
      return items as never;
    },
    curate: async () => [
      {
        id: 'tw-1',
        title: 'Launch',
        summary: 'Summary',
        url: 'https://x.com/alice/status/1',
        author: 'Alice',
        attribution: '@alice',
        source: 'twitter',
        category: 'Product',
        media: [],
      },
    ],
    select: async (items) => items,
    format: (items, date) => {
      events.push(`format:${date}:${items.length}`);
      return { date, obsidian: 'obsidian', substack: 'substack' };
    },
    publish: async () => {
      events.push('publish');
    },
    log: () => {},
  });

  assert.deepEqual(events, [
    'attach:1',
    'rank:1',
    'pool:1',
    'format:2024-03-09:1',
    'publish',
    'writeState:1710000000',
    'clearDraft',
  ]);
});

test('runGenerate writes curation diagnostics into the selection report when curate returns diagnostics', async () => {
  let publishedReport: unknown;
  const diagnostics = createCurationDiagnostics();

  await runGenerate({
    readDraft: async () => null,
    collect: async () => createSnapshot(),
    writeDraft: async () => {},
    clearDraft: async () => {},
    readState: async () => ({
      sources: {
        twitter: { lastPublishedTime: 100 },
        substack: { lastPublishedTime: 0 },
      },
    }),
    writeState: async () => {},
    attachReaderBriefs: async (items) => items,
    rankItems: (items) => items as never,
    selectCandidatePool: (items) => items as never,
    curate: async () => ({
      items: [createCuratedItem()],
      diagnostics,
    }),
    select: async (items) => items,
    format: (items, date) => ({ date, obsidian: `obsidian:${items.length}`, substack: 'substack' }),
    publish: async (_formatted, report) => {
      publishedReport = report;
    },
    log: () => {},
  });

  assert.deepEqual((publishedReport as { curationDiagnostics?: CurationDiagnostics }).curationDiagnostics, diagnostics);
});

test('runGenerate writes curation diagnostics into review packets when curate returns diagnostics', async () => {
  let reviewPacket: ReviewPacket | undefined;
  const diagnostics = createCurationDiagnostics();

  await runGenerate(
    {
      readDraft: async () => createDraft(),
      collect: async () => createSnapshot({ items: [] }),
      writeDraft: async () => {},
      clearDraft: async () => {},
      readState: async () => ({
        sources: {
          twitter: { lastPublishedTime: 100 },
          substack: { lastPublishedTime: 0 },
        },
      }),
      writeState: async () => {},
      attachReaderBriefs: async (items) => items,
      rankItems: (items) => items as never,
      selectCandidatePool: (items) => items as never,
      curate: async () => ({
        items: [createCuratedItem()],
        diagnostics,
      }),
      select: async (items) => items,
      format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
      publish: async () => {},
      writeReviewPacket: async (packet) => {
        reviewPacket = packet;
        return {
          jsonPath: '/tmp/2024-03-09-review.json',
          markdownPath: '/tmp/2024-03-09-review.md',
        };
      },
      log: () => {},
    },
    { mode: 'review' },
  );

  assert.deepEqual(reviewPacket?.curationDiagnostics, diagnostics);
});

test('parseGenerateOptions detects review diagnose mode without changing review mode parsing', () => {
  assert.deepEqual(parseGenerateOptions(['--mode=review', '--diagnose-collect-env']), {
    mode: 'review',
    diagnoseCollectEnv: true,
  });
});

test('runGenerate logs environment diagnostics and exits before normal flow in collect diagnose mode', async () => {
  const events: string[] = [];

  await runGenerate(
    {
      shouldLogEnvironmentDiagnostics: () => true,
      logEnvironmentDiagnostics: async () => {
        events.push('env');
      },
      diagnoseCollectEnvironment: async () => {
        events.push('diagnose');
      },
      readState: async () => {
        events.push('readState');
        return {
          sources: {
            twitter: { lastPublishedTime: 100 },
            substack: { lastPublishedTime: 0 },
          },
        };
      },
      log: () => {},
    },
    { mode: 'review', diagnoseCollectEnv: true },
  );

  assert.deepEqual(events, ['env', 'diagnose']);
});

test('runGenerate writes a fresh pending draft before analysis and preserves it on downstream failure', async () => {
  const events: string[] = [];

  await assert.rejects(
    () =>
      runGenerate({
        readDraft: async () => null,
        collect: async () => {
          events.push('collect');
          return createSnapshot();
        },
        writeDraft: async () => {
          events.push('writeDraft');
        },
        clearDraft: async () => {
          events.push('clearDraft');
        },
        readState: async () => ({
          sources: {
            twitter: { lastPublishedTime: 100 },
            substack: { lastPublishedTime: 0 },
          },
        }),
        writeState: async () => {
          events.push('writeState');
        },
        attachReaderBriefs: async () => {
          events.push('attach');
          throw new Error('reader failed');
        },
        rankItems: (items) => items as never,
        selectCandidatePool: (items) => items as never,
        curate: async () => [],
        select: async (items) => items,
        format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
        publish: async () => {
          events.push('publish');
        },
        log: () => {},
      }),
    /reader failed/,
  );

  assert.deepEqual(events, ['collect', 'writeDraft', 'attach']);
});

test('runGenerate preserves the pending draft when curate fails during main_curate', async () => {
  const events: string[] = [];

  await assert.rejects(
    () =>
      runGenerate({
        readDraft: async () => null,
        collect: async () => {
          events.push('collect');
          return createSnapshot();
        },
        writeDraft: async () => {
          events.push('writeDraft');
        },
        clearDraft: async () => {
          events.push('clearDraft');
        },
        readState: async () => ({
          sources: {
            twitter: { lastPublishedTime: 100 },
            substack: { lastPublishedTime: 0 },
          },
        }),
        writeState: async () => {
          events.push('writeState');
        },
        attachReaderBriefs: async (items) => {
          events.push(`attach:${items.length}`);
          return items;
        },
        rankItems: (items) => {
          events.push(`rank:${items.length}`);
          return items as never;
        },
        selectCandidatePool: (items) => {
          events.push(`pool:${items.length}`);
          return items as never;
        },
        curate: async () => {
          events.push('curate:main_curate');
          throw new Error('main_curate failed');
        },
        select: async (items) => items,
        format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
        publish: async () => {
          events.push('publish');
        },
        log: () => {},
      }),
    /main_curate failed/,
  );

  assert.deepEqual(events, ['collect', 'writeDraft', 'attach:1', 'rank:1', 'pool:1', 'curate:main_curate']);
});

test('runGenerate preserves the pending draft when curate fails during forced_roundup', async () => {
  const events: string[] = [];

  await assert.rejects(
    () =>
      runGenerate({
        readDraft: async () => null,
        collect: async () => {
          events.push('collect');
          return createSnapshot({
            enabledSources: ['twitter', 'substack'],
            items: [
              ...createSnapshot().items,
              {
                id: 'ss-roundup-1',
                source: 'substack',
                kind: 'substack_roundup_entry',
                title: 'Perplexity launched Labs',
                text: 'A useful roundup entry',
                sectionLabel: 'News worth knowing',
                parentItemId: 'substack-parent-1',
                forceSelect: true,
                originUrl: 'https://www.bensbites.com/p/post',
                publishedAt: '2026-03-15T00:00:00Z',
                url: 'https://example.com/perplexity-labs',
                author: { name: "Ben's Bites" },
                publication: { name: "Ben's Bites", handle: 'bensbites', url: 'https://www.bensbites.com' },
                media: [],
              },
            ] as unknown as CollectionSnapshot['items'],
          });
        },
        writeDraft: async () => {
          events.push('writeDraft');
        },
        clearDraft: async () => {
          events.push('clearDraft');
        },
        readState: async () => ({
          sources: {
            twitter: { lastPublishedTime: 100 },
            substack: { lastPublishedTime: 0 },
          },
        }),
        writeState: async () => {
          events.push('writeState');
        },
        attachReaderBriefs: async (items) => {
          events.push(`attach:${items.length}`);
          return items;
        },
        rankItems: (items) => {
          events.push(`rank:${items.length}`);
          return items as never;
        },
        selectCandidatePool: (items) => {
          events.push(`pool:${items.length}`);
          return items.filter((item) => item.id === 'tw-1') as never;
        },
        curate: async () => {
          events.push('curate:forced_roundup');
          throw new Error('forced_roundup failed');
        },
        select: async (items) => items,
        format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
        publish: async () => {
          events.push('publish');
        },
        log: () => {},
      }),
    /forced_roundup failed/,
  );

  assert.deepEqual(events, ['collect', 'writeDraft', 'attach:2', 'rank:2', 'pool:2', 'curate:forced_roundup']);
});

test('runGenerate discards an old pending draft before collecting a fresh snapshot', async () => {
  const events: string[] = [];

  await runGenerate({
    readDraft: async () => createDraft(),
    choosePendingDraftAction: async () => 'discard',
    collect: async () => {
      events.push('collect');
      return createSnapshot({ collectedAt: 1710100000 });
    },
    writeDraft: async () => {
      events.push('writeDraft');
    },
    clearDraft: async () => {
      events.push('clearDraft');
    },
    readState: async () => ({
      sources: {
        twitter: { lastPublishedTime: 100 },
        substack: { lastPublishedTime: 0 },
      },
    }),
    writeState: async (state) => {
      events.push(`writeState:${state.sources.twitter.lastPublishedTime}`);
    },
    attachReaderBriefs: async (items) => items,
    rankItems: (items) => items as never,
    selectCandidatePool: (items) => items as never,
    curate: async () => [
      {
        id: 'tw-1',
        title: 'Launch',
        summary: 'Summary',
        url: 'https://x.com/alice/status/1',
        author: 'Alice',
        attribution: '@alice',
        source: 'twitter',
        category: 'Product',
        media: [],
      },
    ],
    select: async (items) => items,
    format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
    publish: async () => {
      events.push('publish');
    },
    log: () => {},
  });

  assert.deepEqual(events, [
    'clearDraft',
    'collect',
    'writeDraft',
    'publish',
    'writeState:1710100000',
    'clearDraft',
  ]);
});

test('runGenerate always passes forced roundup entries into curate even when the normal candidate pool excludes them', async () => {
  const curateInputs: string[][] = [];

  await runGenerate({
    readDraft: async () => null,
    collect: async () =>
      createSnapshot({
        enabledSources: ['twitter', 'substack'],
        items: [
          {
            id: 'tw-1',
            source: 'twitter',
            text: 'tweet',
            publishedAt: '2026-03-15T00:00:00Z',
            url: 'https://x.com/alice/status/1',
            author: { name: 'Alice', username: 'alice' },
            media: [],
            priorityScore: 80,
            editorialScore: 80,
            engagementScore: 0,
            decisionReasons: [],
            scoreBreakdown: {
              substance: 20,
              evidence: 10,
              sourceSignal: 5,
              xArticleBonus: 0,
              substackSourceBonus: 0,
              freshness: 10,
              novelty: 15,
              actionability: 0,
              penalties: 0,
            },
          },
          {
            id: 'ss-roundup-1',
            source: 'substack',
            kind: 'substack_roundup_entry',
            title: 'Perplexity launched Labs',
            text: 'A useful roundup entry',
            sectionLabel: 'News worth knowing',
            parentItemId: 'substack-parent-1',
            forceSelect: true,
            originUrl: 'https://www.bensbites.com/p/post',
            publishedAt: '2026-03-15T00:00:00Z',
            url: 'https://example.com/perplexity-labs',
            author: { name: "Ben's Bites" },
            publication: { name: "Ben's Bites", handle: 'bensbites', url: 'https://www.bensbites.com' },
            media: [],
            priorityScore: 5,
            editorialScore: 5,
            engagementScore: 0,
            decisionReasons: [],
            scoreBreakdown: {
              substance: 5,
              evidence: 5,
              sourceSignal: 5,
              xArticleBonus: 0,
              substackSourceBonus: 0,
              freshness: 10,
              novelty: 15,
              actionability: 0,
              penalties: 0,
            },
          },
        ] as unknown as CollectionSnapshot['items'],
      }),
    writeDraft: async () => {},
    clearDraft: async () => {},
    readState: async () => ({
      sources: {
        twitter: { lastPublishedTime: 100 },
        substack: { lastPublishedTime: 0 },
      },
    }),
    writeState: async () => {},
    attachReaderBriefs: async (items) => items,
    rankItems: (items) => items as never,
    selectCandidatePool: (items) => items.filter((item) => item.id === 'tw-1') as never,
    curate: async (items) => {
      curateInputs.push(items.map((item) => item.id));
      return [
        {
          id: 'tw-1',
          title: 'Launch',
          summary: 'Summary',
          url: 'https://x.com/alice/status/1',
          author: 'Alice',
          attribution: '@alice',
          source: 'twitter',
          category: 'Product',
          media: [],
        },
        {
          id: 'ss-roundup-1',
          title: 'Perplexity 推出 Labs',
          summary: 'Summary',
          url: 'https://example.com/perplexity-labs',
          originUrl: 'https://www.bensbites.com/p/post',
          author: "Ben's Bites",
          attribution: "Ben's Bites · News worth knowing",
          source: 'substack',
          category: 'Product',
          media: [],
        },
      ];
    },
    select: async (items) => items,
    format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
    publish: async () => {},
    log: () => {},
  });

  assert.deepEqual(curateInputs, [['tw-1', 'ss-roundup-1']]);
});

test('runGenerate review mode appends fresh items into an existing pending draft before review', async () => {
  const events: string[] = [];
  const reviewPackets: ReviewPacket[] = [];
  const writtenDrafts: PendingDraft[] = [];
  const collectStates: number[] = [];

  await runGenerate(
    {
      readDraft: async () =>
        createDraft({
          collectedAt: 1710000000,
          enabledSources: ['twitter'],
          items: [
            createCollectedItem({
              id: 'tw-old',
              publishedAt: '2026-03-15T00:00:00Z',
              url: 'https://x.com/alice/status/old',
            }),
            createCollectedItem({
              id: 'tw-duplicate-url',
              publishedAt: '2026-03-14T00:00:00Z',
              url: 'https://example.com/same',
            }),
          ],
        }),
      choosePendingDraftAction: async () => {
        events.push('prompt');
        return 'cancel';
      },
      collect: async (state) => {
        events.push('collect');
        collectStates.push(state.sources.twitter.lastPublishedTime, state.sources.substack.lastPublishedTime);
        return createSnapshot({
          collectedAt: 1710100000,
          enabledSources: ['twitter', 'substack'],
          items: [
            createCollectedItem({
              id: 'tw-new',
              publishedAt: '2026-03-16T00:00:00Z',
              url: 'https://x.com/alice/status/new',
            }),
            createCollectedItem({
              id: 'tw-old',
              publishedAt: '2026-03-16T01:00:00Z',
              url: 'https://x.com/alice/status/old-updated',
            }),
            createCollectedItem({
              id: 'tw-fresh-duplicate-url',
              publishedAt: '2026-03-16T02:00:00Z',
              url: 'https://example.com/same',
            }),
          ],
        });
      },
      writeDraft: async (draft) => {
        events.push(`writeDraft:${draft.collectedAt}:${draft.items.map((item) => item.id).join(',')}`);
        writtenDrafts.push(draft);
      },
      clearDraft: async () => {
        events.push('clearDraft');
      },
      readState: async () => ({
        sources: {
          twitter: { lastPublishedTime: 100 },
          substack: { lastPublishedTime: 0 },
        },
      }),
      writeState: async () => {
        events.push('writeState');
      },
      attachReaderBriefs: async (items) => {
        events.push(`attach:${items.map((item) => item.id).join(',')}`);
        return items;
      },
      rankItems: (items) => {
        events.push(`rank:${items.length}`);
        return items as never;
      },
      selectCandidatePool: (items) => {
        events.push(`pool:${items.length}`);
        return items as never;
      },
      curate: async () => {
        events.push('curate');
        return [createCuratedItem()];
      },
      select: async () => {
        events.push('select');
        return [];
      },
      format: (items, date) => {
        events.push(`format:${date}:${items.length}`);
        return { date, obsidian: 'obsidian', substack: 'substack' };
      },
      publish: async () => {
        events.push('publish');
      },
      writeReviewPacket: async (packet) => {
        events.push(`review:${packet.date}:${packet.curatedItems.length}`);
        reviewPackets.push(packet);
        return {
          jsonPath: '/tmp/2024-03-09-review.json',
          markdownPath: '/tmp/2024-03-09-review.md',
        };
      },
      log: () => {},
    },
    { mode: 'review' },
  );

  assert.deepEqual(collectStates, [1710000000, 1710000000]);
  assert.deepEqual(events, [
    'collect',
    'writeDraft:1710100000:tw-new,tw-old,tw-duplicate-url',
    'attach:tw-new,tw-old,tw-duplicate-url',
    'rank:3',
    'pool:3',
    'curate',
    'review:2024-03-10:1',
  ]);
  assert.deepEqual(writtenDrafts[0]?.enabledSources, ['twitter', 'substack']);
  assert.equal(reviewPackets[0]?.nextAction, 'Run `npm run generate`, choose `resume`, then select the final items.');
});

test('runGenerate review mode reviews an existing draft without rewriting it when no fresh items are collected', async () => {
  const events: string[] = [];

  await runGenerate(
    {
      readDraft: async () => createDraft(),
      collect: async () => {
        events.push('collect');
        return createSnapshot({ collectedAt: 1710100000, items: [] });
      },
      writeDraft: async () => {
        events.push('writeDraft');
      },
      clearDraft: async () => {
        events.push('clearDraft');
      },
      readState: async () => ({
        sources: {
          twitter: { lastPublishedTime: 100 },
          substack: { lastPublishedTime: 0 },
        },
      }),
      writeState: async () => {
        events.push('writeState');
      },
      attachReaderBriefs: async (items) => {
        events.push(`attach:${items.length}`);
        return items;
      },
      rankItems: (items) => {
        events.push(`rank:${items.length}`);
        return items as never;
      },
      selectCandidatePool: (items) => {
        events.push(`pool:${items.length}`);
        return items as never;
      },
      curate: async () => {
        events.push('curate');
        return [createCuratedItem()];
      },
      select: async () => {
        events.push('select');
        return [];
      },
      format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
      publish: async () => {
        events.push('publish');
      },
      writeReviewPacket: async (packet) => {
        events.push(`review:${packet.date}`);
        return {
          jsonPath: '/tmp/2024-03-09-review.json',
          markdownPath: '/tmp/2024-03-09-review.md',
        };
      },
      log: () => {},
    },
    { mode: 'review' },
  );

  assert.deepEqual(events, ['collect', 'attach:1', 'rank:1', 'pool:1', 'curate', 'review:2024-03-09']);
});

test('runGenerate review mode preserves an existing draft when fresh collection fails', async () => {
  const events: string[] = [];

  await assert.rejects(
    () =>
      runGenerate(
        {
          readDraft: async () => createDraft(),
          collect: async () => {
            events.push('collect');
            throw new Error('collect failed');
          },
          writeDraft: async () => {
            events.push('writeDraft');
          },
          clearDraft: async () => {
            events.push('clearDraft');
          },
          readState: async () => ({
            sources: {
              twitter: { lastPublishedTime: 100 },
              substack: { lastPublishedTime: 0 },
            },
          }),
          writeState: async () => {
            events.push('writeState');
          },
          attachReaderBriefs: async () => {
            events.push('attach');
            return [];
          },
          rankItems: (items) => items as never,
          selectCandidatePool: (items) => items as never,
          curate: async () => [],
          select: async (items) => items,
          format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
          publish: async () => {
            events.push('publish');
          },
          writeReviewPacket: async () => {
            events.push('review');
            return {
              jsonPath: '/tmp/2024-03-09-review.json',
              markdownPath: '/tmp/2024-03-09-review.md',
            };
          },
          log: () => {},
        },
        { mode: 'review' },
      ),
    /collect failed/,
  );

  assert.deepEqual(events, ['collect']);
});

test('runGenerate review mode writes a fresh pending draft and leaves it for interactive resume', async () => {
  const events: string[] = [];

  await runGenerate(
    {
      readDraft: async () => null,
      collect: async () => {
        events.push('collect');
        return createSnapshot({ collectedAt: 1710100000 });
      },
      writeDraft: async (draft) => {
        events.push(`writeDraft:${draft.collectedAt}`);
      },
      clearDraft: async () => {
        events.push('clearDraft');
      },
      readState: async () => ({
        sources: {
          twitter: { lastPublishedTime: 100 },
          substack: { lastPublishedTime: 0 },
        },
      }),
      writeState: async () => {
        events.push('writeState');
      },
      attachReaderBriefs: async (items) => items,
      rankItems: (items) => items as never,
      selectCandidatePool: (items) => items as never,
      curate: async () => [createCuratedItem()],
      select: async () => {
        events.push('select');
        return [];
      },
      format: (items, date) => {
        events.push(`format:${date}:${items.length}`);
        return { date, obsidian: 'obsidian', substack: 'substack' };
      },
      publish: async () => {
        events.push('publish');
      },
      writeReviewPacket: async (packet) => {
        events.push(`review:${packet.collectedAt}`);
        return {
          jsonPath: '/tmp/2024-03-10-review.json',
          markdownPath: '/tmp/2024-03-10-review.md',
        };
      },
      log: () => {},
    },
    { mode: 'review' },
  );

  assert.deepEqual(events, ['collect', 'writeDraft:1710100000', 'review:1710100000']);
});

test('runGenerate review mode preserves draft and state when curation fails', async () => {
  const events: string[] = [];
  const writtenDrafts: PendingDraft[] = [];

  await assert.rejects(
    () =>
      runGenerate(
        {
          readDraft: async () => createDraft(),
          collect: async () => {
            events.push('collect');
            return createSnapshot({
              collectedAt: 1710100000,
              items: [
                createCollectedItem({
                  id: 'tw-2',
                  publishedAt: '2026-03-16T00:00:00Z',
                  url: 'https://x.com/alice/status/2',
                }),
              ],
            });
          },
          writeDraft: async (draft) => {
            events.push('writeDraft');
            writtenDrafts.push(draft);
          },
          clearDraft: async () => {
            events.push('clearDraft');
          },
          readState: async () => ({
            sources: {
              twitter: { lastPublishedTime: 100 },
              substack: { lastPublishedTime: 0 },
            },
          }),
          writeState: async () => {
            events.push('writeState');
          },
          attachReaderBriefs: async (items) => items,
          rankItems: (items) => items as never,
          selectCandidatePool: (items) => items as never,
          curate: async () => {
            events.push('curate');
            throw new Error('main_curate failed');
          },
          select: async () => {
            events.push('select');
            return [];
          },
          format: (items, date) => ({ date, obsidian: 'obsidian', substack: 'substack' }),
          publish: async () => {
            events.push('publish');
          },
          writeReviewPacket: async () => {
            events.push('review');
            return {
              jsonPath: '/tmp/2024-03-09-review.json',
              markdownPath: '/tmp/2024-03-09-review.md',
            };
          },
          log: () => {},
        },
        { mode: 'review' },
      ),
    /main_curate failed/,
  );

  assert.deepEqual(events, ['collect', 'writeDraft', 'curate']);
  assert.deepEqual(writtenDrafts[0]?.items.map((item) => item.id), ['tw-2', 'tw-1']);
});
