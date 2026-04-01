import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as draftModule from '../src/draft.js';
import type { PendingDraft } from '../src/types.js';

test('readPendingDraft returns null when draft file is missing', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'daily-news-draft-'));
  const draftPath = join(tempDir, 'pending-draft.json');

  const draft = await draftModule.readPendingDraft(draftPath as never);

  assert.equal(draft, null);
});

test('writePendingDraft persists and readPendingDraft restores the pending draft', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'daily-news-draft-'));
  const draftPath = join(tempDir, 'pending-draft.json');
  const draft: PendingDraft = {
    collectedAt: 1710000000,
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
      },
    ],
  };

  await draftModule.writePendingDraft(draft, draftPath as never);
  const restored = await draftModule.readPendingDraft(draftPath as never);

  assert.deepEqual(restored, draft);
});

test('clearPendingDraft removes the persisted draft file', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'daily-news-draft-'));
  const draftPath = join(tempDir, 'pending-draft.json');

  await draftModule.writePendingDraft(
    {
      collectedAt: 1710000000,
      enabledSources: ['twitter'],
      items: [],
    },
    draftPath as never,
  );

  await draftModule.clearPendingDraft(draftPath as never);

  await assert.rejects(() => stat(draftPath), /ENOENT/);
});
