import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PendingDraft, SourceName } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAFT_PATH = join(__dirname, '..', 'data', 'pending-draft.json');

function normalizeEnabledSources(value: unknown): SourceName[] | null {
  if (!Array.isArray(value)) return null;

  const sources = value.filter((entry): entry is SourceName => entry === 'twitter' || entry === 'substack');
  return sources.length === value.length ? Array.from(new Set(sources)) : null;
}

export function normalizePendingDraft(raw: unknown): PendingDraft | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const collectedAt = candidate.collectedAt;
  const enabledSources = normalizeEnabledSources(candidate.enabledSources);
  const items = candidate.items;

  if (typeof collectedAt !== 'number' || !Number.isFinite(collectedAt) || !enabledSources || !Array.isArray(items)) {
    return null;
  }

  return {
    collectedAt,
    enabledSources,
    items: items as PendingDraft['items'],
  };
}

export async function readPendingDraft(draftPath = DRAFT_PATH): Promise<PendingDraft | null> {
  if (!existsSync(draftPath)) return null;

  const raw = await readFile(draftPath, 'utf-8');
  return normalizePendingDraft(JSON.parse(raw));
}

export async function writePendingDraft(draft: PendingDraft, draftPath = DRAFT_PATH): Promise<void> {
  await mkdir(dirname(draftPath), { recursive: true });
  await writeFile(draftPath, JSON.stringify(draft, null, 2), 'utf-8');
}

export async function clearPendingDraft(draftPath = DRAFT_PATH): Promise<void> {
  await rm(draftPath, { force: true });
}
