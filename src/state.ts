import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SOURCE_NAMES } from './source-registry.js';
import type { SourceName } from './source-registry.js';
import type { RunState } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_PATH = join(__dirname, '..', 'data', 'state.json');

function buildSourceState(getLastPublishedTime: (source: SourceName) => number): RunState['sources'] {
  return Object.fromEntries(
    SOURCE_NAMES.map((source) => [source, { lastPublishedTime: getLastPublishedTime(source) }]),
  ) as RunState['sources'];
}

function createEmptyState(): RunState {
  return { sources: buildSourceState(() => 0) };
}

export function normalizeRunState(raw: unknown): RunState {
  const emptyState = createEmptyState();

  if (!raw || typeof raw !== 'object') {
    return emptyState;
  }

  const candidate = raw as Record<string, unknown>;

  if (typeof candidate.lastRunTime === 'number' && Number.isFinite(candidate.lastRunTime)) {
    return {
      sources: buildSourceState((source) => source === 'twitter' ? candidate.lastRunTime as number : 0),
    };
  }

  const sources =
    candidate.sources && typeof candidate.sources === 'object'
      ? (candidate.sources as Record<string, unknown>)
      : {};

  const getLastPublishedTime = (source: SourceName): number => {
    const sourceState =
      sources[source] && typeof sources[source] === 'object'
        ? (sources[source] as Record<string, unknown>)
        : {};
    if (
      typeof sourceState.lastPublishedTime === 'number' &&
      Number.isFinite(sourceState.lastPublishedTime)
    ) {
      return sourceState.lastPublishedTime;
    }

    return typeof sourceState.lastRunTime === 'number' && Number.isFinite(sourceState.lastRunTime)
      ? sourceState.lastRunTime
      : 0;
  };

  return { sources: buildSourceState(getLastPublishedTime) };
}

export async function readState(statePath = STATE_PATH): Promise<RunState> {
  if (!existsSync(statePath)) {
    return createEmptyState();
  }

  const raw = await readFile(statePath, 'utf-8');
  return normalizeRunState(JSON.parse(raw));
}

export async function writeState(state: RunState, statePath = STATE_PATH): Promise<void> {
  const dir = dirname(statePath);
  await mkdir(dir, { recursive: true });
  await writeFile(statePath, JSON.stringify(normalizeRunState(state), null, 2), 'utf-8');
}
