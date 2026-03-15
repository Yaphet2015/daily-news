import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import * as stateModule from '../src/state.js';

test('normalizeRunState migrates legacy state to per-source cursors', () => {
  assert.equal(typeof (stateModule as Record<string, unknown>).normalizeRunState, 'function');

  const normalizeRunState = (stateModule as Record<string, Function>).normalizeRunState;
  assert.deepEqual(normalizeRunState({ lastRunTime: 123 }), {
    sources: {
      twitter: { lastRunTime: 123 },
      substack: { lastRunTime: 0 },
    },
  });
});

test('readState returns the new empty shape when state file is missing', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'daily-news-state-'));
  const statePath = join(tempDir, 'state.json');

  const state = await stateModule.readState(statePath as never);

  assert.deepEqual(state, {
    sources: {
      twitter: { lastRunTime: 0 },
      substack: { lastRunTime: 0 },
    },
  });
});

test('writeState persists per-source cursors', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'daily-news-state-'));
  const statePath = join(tempDir, 'state.json');

  await stateModule.writeState(
    {
      sources: {
        twitter: { lastRunTime: 11 },
        substack: { lastRunTime: 22 },
      },
    } as never,
    statePath as never,
  );

  const raw = await readFile(statePath, 'utf-8');
  assert.match(raw, /"twitter"/);
  assert.match(raw, /"substack"/);
  assert.match(raw, /11/);
  assert.match(raw, /22/);
});
