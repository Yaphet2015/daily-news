import { mkdir, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { BASELINE_TAG_IDS, RANKING_SIGNAL_IDS } from './scoring-policy.js';
import type {
  ArtifactIdentity,
  ContentTagId,
  ContentTagMatch,
  CurationMode,
  RankingSignalId,
  RankingSignalMap,
  ScoreFactor,
} from './types.js';

export function decodeObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${path} must be an object`);
  return value as Record<string, unknown>;
}

export function decodeNonEmptyString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${path} must be a non-empty string`);
  return value;
}

export function decodeFiniteNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} must be finite`);
  return value;
}

export function decodePositiveInteger(value: unknown, path: string): number {
  const number = decodeFiniteNumber(value, path);
  if (!Number.isInteger(number) || number < 1) throw new Error(`${path} must be a positive integer`);
  return number;
}

export function decodeArtifactIdentity(value: Record<string, unknown>, path: string): ArtifactIdentity {
  if (value.schemaVersion !== 1) throw new Error(`${path}.schemaVersion is unsupported: ${String(value.schemaVersion)}`);
  const curationMode = value.curationMode;
  if (curationMode !== 'npm-model' && curationMode !== 'agent-curator') {
    throw new Error(`${path}.curationMode is invalid`);
  }
  return {
    schemaVersion: 1,
    runId: decodeNonEmptyString(value.runId, `${path}.runId`),
    date: decodeNonEmptyString(value.date, `${path}.date`),
    curationMode: curationMode as CurationMode,
    featureVersion: decodeNonEmptyString(value.featureVersion, `${path}.featureVersion`),
  };
}

function decodeContentTagId(value: unknown, path: string): ContentTagId {
  const id = decodeNonEmptyString(value, path);
  if (!BASELINE_TAG_IDS.includes(id as ContentTagId) && !id.startsWith('custom:')) {
    throw new Error(`${path} is an unknown ContentTagId`);
  }
  return id as ContentTagId;
}

export function decodeContentTagIds(value: unknown, path: string): ContentTagId[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => decodeContentTagId(entry, `${path}[${index}]`));
}

export function decodeContentTagMatches(value: unknown, path: string): ContentTagMatch[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => {
    const match = decodeObject(entry, `${path}[${index}]`);
    const strength = decodeFiniteNumber(match.strength, `${path}[${index}].strength`);
    if (strength < 0 || strength > 1) throw new Error(`${path}[${index}].strength must be between 0 and 1`);
    if (!Array.isArray(match.matchedBy)) throw new Error(`${path}[${index}].matchedBy must be an array`);
    return {
      tagId: decodeContentTagId(match.tagId, `${path}[${index}].tagId`),
      matchedBy: match.matchedBy.map((item, evidenceIndex) =>
        decodeNonEmptyString(item, `${path}[${index}].matchedBy[${evidenceIndex}]`)),
      strength,
    };
  });
}

export function decodeRankingSignalMap(value: unknown, path: string): RankingSignalMap {
  const raw = decodeObject(value, path);
  const result = {} as RankingSignalMap;
  for (const id of RANKING_SIGNAL_IDS) result[id] = decodeFiniteNumber(raw[id], `${path}.${id}`);
  return result;
}

export function decodeScoreFactors(value: unknown, path: string): ScoreFactor[] {
  if (!Array.isArray(value)) throw new Error(`${path} must be an array`);
  return value.map((entry, index) => {
    const factor = decodeObject(entry, `${path}[${index}]`);
    if (factor.kind !== 'tag' && factor.kind !== 'ranking-signal') throw new Error(`${path}[${index}].kind is invalid`);
    const factorId = factor.kind === 'tag'
      ? decodeContentTagId(factor.factorId, `${path}[${index}].factorId`)
      : decodeNonEmptyString(factor.factorId, `${path}[${index}].factorId`) as RankingSignalId;
    if (factor.kind === 'ranking-signal' && !RANKING_SIGNAL_IDS.includes(factorId as RankingSignalId)) {
      throw new Error(`${path}[${index}].factorId is unknown`);
    }
    const strength = decodeFiniteNumber(factor.strength, `${path}[${index}].strength`);
    const weight = decodeFiniteNumber(factor.weight, `${path}[${index}].weight`);
    const contribution = decodeFiniteNumber(factor.contribution, `${path}[${index}].contribution`);
    if (Math.abs(contribution - strength * weight) > 1e-9) throw new Error(`${path}[${index}].contribution is invalid`);
    if (!Array.isArray(factor.evidence)) throw new Error(`${path}[${index}].evidence must be an array`);
    if (factor.provenance !== 'baseline' && factor.provenance !== 'confirmed-overlay') {
      throw new Error(`${path}[${index}].provenance is invalid`);
    }
    return {
      factorId,
      kind: factor.kind,
      strength,
      weight,
      contribution,
      evidence: factor.evidence.map((item, evidenceIndex) =>
        decodeNonEmptyString(item, `${path}[${index}].evidence[${evidenceIndex}]`)),
      provenance: factor.provenance,
    };
  });
}

export async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const tempPath = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, JSON.stringify(value, null, 2), 'utf-8');
  await rename(tempPath, path);
}
