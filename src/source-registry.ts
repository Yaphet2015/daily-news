import type { RunState } from './types.js';

export const SOURCE_NAMES = ['twitter', 'substack', 'aihot'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];

export interface SourceDefinition {
  id: SourceName;
  displayName: string;
  configurationEnvNames: readonly string[];
}

export const SOURCE_REGISTRY: Readonly<Record<SourceName, SourceDefinition>> = {
  twitter: {
    id: 'twitter',
    displayName: 'Twitter',
    configurationEnvNames: ['TWITTER_LIST_ID'],
  },
  substack: {
    id: 'substack',
    displayName: 'Substack',
    configurationEnvNames: ['SUBSTACK_PUBLICATION_URL'],
  },
  aihot: {
    id: 'aihot',
    displayName: 'AI HOT',
    configurationEnvNames: ['AIHOT_FEED_URL'],
  },
};

export const DEFAULT_ENABLED_SOURCES: readonly SourceName[] = ['twitter', 'aihot'];

export function normalizeSourceNames(value: unknown): SourceName[] | null {
  if (!Array.isArray(value)) return null;

  const sources: SourceName[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string' || !SOURCE_NAMES.includes(entry as SourceName)) return null;
    const source = entry as SourceName;
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

export function formatPublishedCursorStatus(state: RunState): string {
  return SOURCE_NAMES.map((source) =>
    `${SOURCE_REGISTRY[source].displayName}=${state.sources[source].lastPublishedTime}`).join(', ');
}

export function advancePublishedState(
  state: RunState,
  enabledSources: readonly SourceName[],
  collectedAt: number,
): RunState {
  const sources = Object.fromEntries(
    SOURCE_NAMES.map((source) => [source, { ...state.sources[source] }]),
  ) as RunState['sources'];

  for (const source of enabledSources) {
    sources[source] = { lastPublishedTime: collectedAt };
  }

  return { sources };
}
