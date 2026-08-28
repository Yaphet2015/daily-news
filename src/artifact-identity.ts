import { createHash } from 'node:crypto';
import type { SourceName } from './source-registry.js';
import type { CuratedItem } from './types.js';

export const FEATURE_VERSION = 'tag-signal-feedback-v1';

function digest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, 24);
}

function canonicalUrl(value: string): string {
  try {
    const url = new URL(value);
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith('utm_') || key === 'fbclid' || key === 'gclid') url.searchParams.delete(key);
    }
    url.hash = '';
    return url.toString().replace(/\/$/, '');
  } catch {
    return value.trim();
  }
}

export function createRunId(input: {
  collectedAt: number;
  enabledSources: readonly SourceName[];
  itemIds: readonly string[];
}): string {
  return `run-${digest([input.collectedAt, input.enabledSources, input.itemIds])}`;
}

export function createCurationRevision(input: {
  schemaVersion: number;
  date: string;
  items: readonly Pick<CuratedItem, 'id' | 'url'>[];
}): string {
  return `curation-${digest([
    input.schemaVersion,
    input.date,
    input.items.map((item) => [item.id, canonicalUrl(item.url)]),
  ])}`;
}
