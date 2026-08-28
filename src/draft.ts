import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { normalizeSourceNames } from './source-registry.js';
import type { PendingDraft } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DRAFT_PATH = join(__dirname, '..', 'data', 'pending-draft.json');

function normalizeStringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (!Array.isArray(value)) return undefined;
  const warnings = value.filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0);
  return warnings.length === value.length ? Array.from(new Set(warnings)) : undefined;
}

export function normalizePendingDraft(raw: unknown): PendingDraft | null {
  if (!raw || typeof raw !== 'object') return null;

  const candidate = raw as Record<string, unknown>;
  const collectedAt = candidate.collectedAt;
  const enabledSources = normalizeSourceNames(candidate.enabledSources);
  const collectionWarnings = normalizeStringArray(candidate.collectionWarnings);
  const items = candidate.items;

  if (typeof collectedAt !== 'number' || !Number.isFinite(collectedAt) || !enabledSources || !Array.isArray(items)) {
    return null;
  }

  return {
    collectedAt,
    enabledSources,
    ...(collectionWarnings && collectionWarnings.length > 0 ? { collectionWarnings } : {}),
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
