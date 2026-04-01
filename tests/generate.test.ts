import test from 'node:test';
import assert from 'node:assert/strict';
import { runGenerate } from '../src/generate.js';
import type { CollectionSnapshot, PendingDraft } from '../src/types.js';

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

function createDraft(overrides: Partial<PendingDraft> = {}): PendingDraft {
  return {
    collectedAt: 1710000000,
    enabledSources: ['twitter'],
    items: createSnapshot().items,
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
