import { join } from 'node:path';
import {
  decodeArtifactIdentity,
  decodeContentTagIds,
  decodeContentTagMatches,
  decodeFiniteNumber,
  decodeObject,
  decodePositiveInteger,
  decodeRankingSignalMap,
  decodeScoreFactors,
  writeJsonAtomic,
} from './artifact-codec.js';
import type { RankedItem, RankingArtifact } from './types.js';

function decodeRankedItems(value: unknown): RankedItem[] {
  if (!Array.isArray(value)) throw new Error('ranking.rankedItems must be an array');
  const ids = new Set<string>();
  return value.map((raw, index) => {
    const item = decodeObject(raw, `ranking.rankedItems[${index}]`);
    const id = typeof item.id === 'string' && item.id.trim() ? item.id : null;
    if (!id) throw new Error(`ranking.rankedItems[${index}].id is invalid`);
    if (ids.has(id)) throw new Error(`ranking.rankedItems contains duplicate id ${id}`);
    ids.add(id);
    decodeFiniteNumber(item.priorityScore, `ranking.rankedItems[${index}].priorityScore`);
    const structuredValues = [item.contentTags, item.tagMatches, item.rankingSignals, item.scoreFactors];
    if (structuredValues.some((entry) => entry !== undefined)) {
      if (structuredValues.some((entry) => entry === undefined)) {
        throw new Error(`ranking.rankedItems[${index}] has incomplete structured scoring data`);
      }
      return {
        ...(raw as RankedItem),
        contentTags: decodeContentTagIds(item.contentTags, `ranking.rankedItems[${index}].contentTags`),
        tagMatches: decodeContentTagMatches(item.tagMatches, `ranking.rankedItems[${index}].tagMatches`),
        rankingSignals: decodeRankingSignalMap(item.rankingSignals, `ranking.rankedItems[${index}].rankingSignals`),
        scoreFactors: decodeScoreFactors(item.scoreFactors, `ranking.rankedItems[${index}].scoreFactors`),
      };
    }
    return raw as RankedItem;
  });
}

export function decodeRankingArtifact(value: unknown): RankingArtifact {
  const artifact = decodeObject(value, 'ranking');
  const identity = decodeArtifactIdentity(artifact, 'ranking');
  const collectedAt = decodeFiniteNumber(artifact.collectedAt, 'ranking.collectedAt');
  const policyRevision = decodePositiveInteger(artifact.policyRevision, 'ranking.policyRevision');
  const rankedItems = decodeRankedItems(artifact.rankedItems);
  if (!Array.isArray(artifact.candidateIds)) throw new Error('ranking.candidateIds must be an array');
  const rankedIds = new Set(rankedItems.map((item) => item.id));
  const candidateIds = artifact.candidateIds.map((value, index) => {
    if (typeof value !== 'string' || !rankedIds.has(value)) {
      throw new Error(`ranking.candidateIds[${index}] is absent from rankedItems`);
    }
    return value;
  });
  if (new Set(candidateIds).size !== candidateIds.length) throw new Error('ranking.candidateIds contains duplicates');
  return { ...identity, collectedAt, policyRevision, rankedItems, candidateIds };
}

export async function writeRankingArtifact(
  artifact: RankingArtifact,
  outputDir = join(process.cwd(), 'output'),
): Promise<string> {
  const decoded = decodeRankingArtifact(artifact);
  const path = join(outputDir, `${decoded.date}-ranking.json`);
  await writeJsonAtomic(path, decoded);
  return path;
}
