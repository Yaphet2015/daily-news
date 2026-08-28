import { join } from 'node:path';
import { createCurationRevision } from './artifact-identity.js';
import { decodeArtifactIdentity, decodeFiniteNumber, decodeNonEmptyString, decodeObject, writeJsonAtomic } from './artifact-codec.js';
import type { CurationArtifact, CuratedItem, RankingArtifact } from './types.js';

function decodeCuratedItems(value: unknown): CuratedItem[] {
  if (!Array.isArray(value)) throw new Error('curation.curatedItems must be an array');
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const item = decodeObject(raw, `curation.curatedItems[${index}]`);
    const id = decodeNonEmptyString(item.id, `curation.curatedItems[${index}].id`);
    decodeNonEmptyString(item.url, `curation.curatedItems[${index}].url`);
    if (ids.has(id)) throw new Error(`curation.curatedItems contains duplicate id ${id}`);
    ids.add(id);
    return raw as CuratedItem;
  });
}

export function createCurationArtifact(input: {
  ranking: RankingArtifact;
  curatedItems: CuratedItem[];
  collectionWarnings?: string[];
  curationDiagnostics?: CurationArtifact['curationDiagnostics'];
}): CurationArtifact {
  const curationRevision = createCurationRevision({
    schemaVersion: 1,
    date: input.ranking.date,
    items: input.curatedItems,
  });
  return {
    schemaVersion: 1,
    runId: input.ranking.runId,
    date: input.ranking.date,
    curationMode: input.ranking.curationMode,
    featureVersion: input.ranking.featureVersion,
    collectedAt: input.ranking.collectedAt,
    curationRevision,
    curatedItems: input.curatedItems,
    ...(input.collectionWarnings?.length ? { collectionWarnings: input.collectionWarnings } : {}),
    ...(input.curationDiagnostics ? { curationDiagnostics: input.curationDiagnostics } : {}),
  };
}

export function decodeCurationArtifact(value: unknown): CurationArtifact {
  const artifact = decodeObject(value, 'curation');
  const identity = decodeArtifactIdentity(artifact, 'curation');
  const collectedAt = decodeFiniteNumber(artifact.collectedAt, 'curation.collectedAt');
  const curationRevision = decodeNonEmptyString(artifact.curationRevision, 'curation.curationRevision');
  const curatedItems = decodeCuratedItems(artifact.curatedItems);
  const collectionWarnings = artifact.collectionWarnings;
  if (collectionWarnings !== undefined && (!Array.isArray(collectionWarnings) || collectionWarnings.some((x) => typeof x !== 'string'))) {
    throw new Error('curation.collectionWarnings must be a string array');
  }
  return {
    ...identity,
    collectedAt,
    curationRevision,
    curatedItems,
    ...(collectionWarnings?.length ? { collectionWarnings: collectionWarnings as string[] } : {}),
    ...(artifact.curationDiagnostics ? { curationDiagnostics: artifact.curationDiagnostics as CurationArtifact['curationDiagnostics'] } : {}),
  };
}

export async function writeCurationArtifact(
  artifact: CurationArtifact,
  outputDir = join(process.cwd(), 'output'),
): Promise<string> {
  const decoded = decodeCurationArtifact(artifact);
  const path = join(outputDir, `${decoded.date}-curation.json`);
  await writeJsonAtomic(path, decoded);
  return path;
}
