import 'dotenv/config';
import { pathToFileURL } from 'node:url';
import { createRunId, FEATURE_VERSION } from './artifact-identity.js';
import { select as promptSelect } from '@inquirer/prompts';
import { collect, diagnoseCollectEnvironment } from './collect.js';
import { attachReaderBriefs, curateWithDiagnostics, formatCurationDiagnosticsSummary } from './curate.js';
import { createCurationArtifact, writeCurationArtifact as persistCurationArtifact } from './curation-artifact.js';
import { clearPendingDraft, readPendingDraft, writePendingDraft } from './draft.js';
import {
  logEnvironmentDiagnostics,
  shouldLogEnvironmentDiagnostics,
} from './envDiagnostics.js';
import { format, formatDateFromUnixSeconds } from './format.js';
import { applyProxyFromEnv } from './proxy.js';
import { publish } from './publish.js';
import { readConfirmedPreferenceRules, recordPreferenceHistoryFromSelectionReport } from './preferences.js';
import { rankItems, selectCandidatePool } from './rank.js';
import { writeRankingArtifact as persistRankingArtifact } from './ranking-artifact.js';
import { finalizePublication } from './publication-workflow.js';
import { writeReviewPacket } from './review.js';
import { select } from './select.js';
import { readState, writeState } from './state.js';
import type {
  CollectionSnapshot,
  CollectedItem,
  CurateResult,
  CurationArtifact,
  CuratedItem,
  CurationDiagnostics,
  PendingDraft,
  RankedItem,
  RankingArtifact,
  ReviewPacket,
  ReviewPacketPaths,
  RunState,
  SelectionReport,
} from './types.js';

type PendingDraftAction = 'resume' | 'discard' | 'cancel';
type GenerateMode = 'interactive' | 'review';

interface RunGenerateOptions {
  mode?: GenerateMode;
  diagnoseCollectEnv?: boolean;
}

interface GenerateDeps {
  readState: () => Promise<RunState>;
  writeState: (state: RunState) => Promise<void>;
  readDraft: () => Promise<PendingDraft | null>;
  writeDraft: (draft: PendingDraft) => Promise<void>;
  clearDraft: () => Promise<void>;
  choosePendingDraftAction: (draft: PendingDraft) => Promise<PendingDraftAction>;
  collect: (state: RunState) => Promise<CollectionSnapshot>;
  attachReaderBriefs: (items: CollectedItem[]) => Promise<CollectedItem[]>;
  rankItems: typeof rankItems;
  selectCandidatePool: typeof selectCandidatePool;
  curate: (items: CollectedItem[]) => Promise<CuratedItem[] | CurateResult>;
  select: (items: CuratedItem[]) => Promise<CuratedItem[]>;
  format: typeof format;
  recordPreferenceHistory: (report: SelectionReport) => Promise<void>;
  publish: (result: ReturnType<typeof format>, report?: SelectionReport) => Promise<void>;
  writeReviewPacket: (packet: ReviewPacket) => Promise<ReviewPacketPaths>;
  writeRankingArtifact: (artifact: RankingArtifact) => Promise<void>;
  writeCurationArtifact: (artifact: CurationArtifact) => Promise<void>;
  getPolicyRevision: () => number;
  shouldLogEnvironmentDiagnostics: () => boolean;
  logEnvironmentDiagnostics: () => Promise<void>;
  diagnoseCollectEnvironment: () => Promise<void>;
  log: (message: string) => void;
}

function createGenerateDeps(): GenerateDeps {
  return {
    readState,
    writeState,
    readDraft: readPendingDraft,
    writeDraft: writePendingDraft,
    clearDraft: clearPendingDraft,
    choosePendingDraftAction: async (draft) =>
      promptSelect<PendingDraftAction>({
        message: `发现一份未发布草稿（采集时间 ${formatDateFromUnixSeconds(draft.collectedAt)}，共 ${draft.items.length} 条），如何处理？`,
        default: 'resume',
        choices: [
          { name: '继续发布已采集草稿', value: 'resume' },
          { name: '丢弃草稿并重新采集', value: 'discard' },
          { name: '取消本次运行', value: 'cancel' },
        ],
      }),
    collect,
    attachReaderBriefs,
    rankItems: (items) => rankItems(items, readConfirmedPreferenceRules()),
    selectCandidatePool,
    curate: curateWithDiagnostics,
    select,
    format,
    recordPreferenceHistory: async () => {},
    publish,
    writeReviewPacket,
    writeRankingArtifact: async () => {},
    writeCurationArtifact: async () => {},
    getPolicyRevision: () => readConfirmedPreferenceRules().policyRevision ?? 1,
    shouldLogEnvironmentDiagnostics,
    logEnvironmentDiagnostics,
    diagnoseCollectEnvironment,
    log: console.log,
  };
}

function createAppendCollectionState(draft: PendingDraft): RunState {
  return {
    sources: {
      twitter: { lastPublishedTime: draft.collectedAt },
      substack: { lastPublishedTime: draft.collectedAt },
      aihot: { lastPublishedTime: draft.collectedAt },
    },
  };
}

function getItemTimestamp(item: CollectedItem): number {
  const timestamp = Date.parse(item.publishedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSourceUrlKey(item: CollectedItem): string {
  return `${item.source}:${item.url.trim().toLowerCase()}`;
}

function mergePendingDraftWithFreshSnapshot(draft: PendingDraft, freshSnapshot: CollectionSnapshot): PendingDraft {
  const items: CollectedItem[] = [];
  const seenIds = new Set<string>();
  const seenSourceUrls = new Set<string>();

  for (const item of [...draft.items, ...freshSnapshot.items]) {
    const sourceUrlKey = getSourceUrlKey(item);
    if (seenIds.has(item.id) || seenSourceUrls.has(sourceUrlKey)) continue;

    seenIds.add(item.id);
    seenSourceUrls.add(sourceUrlKey);
    items.push(item);
  }

  items.sort((a, b) => getItemTimestamp(b) - getItemTimestamp(a));

  return {
    collectedAt: freshSnapshot.collectedAt,
    enabledSources: Array.from(new Set([...draft.enabledSources, ...freshSnapshot.enabledSources])),
    collectionWarnings: Array.from(
      new Set([...(draft.collectionWarnings ?? []), ...(freshSnapshot.collectionWarnings ?? [])]),
    ),
    items,
  };
}

function mergeForcedSelectItems(candidateItems: CollectedItem[], rankedItems: CollectedItem[]): CollectedItem[] {
  const merged = [...candidateItems];
  const seen = new Set(candidateItems.map((item) => item.id));

  for (const item of rankedItems) {
    if (!item.forceSelect || seen.has(item.id)) continue;
    merged.push(item);
    seen.add(item.id);
  }

  return merged;
}

const REVIEW_NEXT_ACTION = 'Run `npm run generate`, choose `resume`, then select the final items.';

function annotateRankedItems(
  rankedItems: RankedItem[],
  candidateItems: CollectedItem[],
  curatedItems: CuratedItem[],
  selectedItems?: CuratedItem[],
): RankedItem[] {
  const candidateIds = new Set(candidateItems.map((item) => item.id));
  const curatedIds = new Set(curatedItems.map((item) => item.id));
  const selectedIds = selectedItems ? new Set(selectedItems.map((item) => item.id)) : null;

  return rankedItems.map((item) => {
    const annotated: RankedItem = {
      ...item,
      enteredCandidatePool: candidateIds.has(item.id),
      selectedByLlm: curatedIds.has(item.id),
    };

    if (selectedIds) {
      annotated.selectedByHuman = selectedIds.has(item.id);
    }

    return annotated;
  });
}

function normalizeCurateResult(result: CuratedItem[] | CurateResult): { items: CuratedItem[]; diagnostics?: CurationDiagnostics } {
  if (Array.isArray(result)) {
    return { items: result };
  }

  return result;
}

function buildReviewPacket(
  snapshot: PendingDraft | CollectionSnapshot,
  rankedItems: RankedItem[],
  candidateItems: CollectedItem[],
  curatedItems: CuratedItem[],
  curationDiagnostics?: CurationDiagnostics,
): ReviewPacket {
  return {
    date: formatDateFromUnixSeconds(snapshot.collectedAt),
    collectedAt: snapshot.collectedAt,
    enabledSources: snapshot.enabledSources,
    ...(snapshot.collectionWarnings && snapshot.collectionWarnings.length > 0
      ? { collectionWarnings: snapshot.collectionWarnings }
      : {}),
    rankedItems: annotateRankedItems(rankedItems, candidateItems, curatedItems),
    curatedItems,
    curationDiagnostics,
    nextAction: REVIEW_NEXT_ACTION,
  };
}

export function parseGenerateMode(args: string[]): GenerateMode {
  const modeArg = args.find((arg) => arg.startsWith('--mode='));
  if (!modeArg) return 'interactive';

  const mode = modeArg.slice('--mode='.length);
  if (mode === 'interactive' || mode === 'review') return mode;

  throw new Error(`Unsupported generate mode: ${mode}`);
}

export function parseGenerateOptions(args: string[]): RunGenerateOptions {
  return {
    mode: parseGenerateMode(args),
    diagnoseCollectEnv: args.includes('--diagnose-collect-env'),
  };
}

export async function runGenerate(
  overrides: Partial<GenerateDeps> = {},
  options: RunGenerateOptions = {},
): Promise<void> {
  const deps = { ...createGenerateDeps(), ...overrides };
  const mode = options.mode ?? 'interactive';

  console.log('═══════════════════════════════════════════════════════════');
  console.log(' AI daily-news');
  console.log('═══════════════════════════════════════════════════════════\n');

  if (deps.shouldLogEnvironmentDiagnostics()) {
    await deps.logEnvironmentDiagnostics();
  }

  if (options.diagnoseCollectEnv) {
    await deps.diagnoseCollectEnvironment();
    return;
  }

  const publishedState = await deps.readState();
  const existingDraft = await deps.readDraft();
  let snapshot: PendingDraft | CollectionSnapshot | null = null;

  if (existingDraft) {
    if (mode === 'review') {
      const freshSnapshot = await deps.collect(createAppendCollectionState(existingDraft));
      if (freshSnapshot.items.length > 0) {
        snapshot = mergePendingDraftWithFreshSnapshot(existingDraft, freshSnapshot);
        await deps.writeDraft(snapshot);
        deps.log(`[generate:review] 已追加 ${freshSnapshot.items.length} 条新内容，合并后共 ${snapshot.items.length} 条内容`);
      } else {
        deps.log('[generate:review] 没有采集到可追加的新内容，继续审阅历史草稿');
        snapshot = existingDraft;
      }
    } else {
      const action = await deps.choosePendingDraftAction(existingDraft);
      if (action === 'cancel') {
        deps.log('本次运行已取消。');
        return;
      }

      if (action === 'resume') {
        deps.log(`[generate] 继续处理历史草稿，共 ${existingDraft.items.length} 条内容`);
        snapshot = existingDraft;
      } else {
        await deps.clearDraft();
      }
    }
  }

  if (!snapshot) {
    snapshot = await deps.collect(publishedState);
    if (snapshot.items.length === 0) {
      deps.log('没有采集到新内容，本次运行结束。');
      return;
    }

    await deps.writeDraft(snapshot);
  }

  const enrichedCollectedItems = await deps.attachReaderBriefs(snapshot.items);
  const rankedItems = deps.rankItems(enrichedCollectedItems);
  const candidateItems = deps.selectCandidatePool(rankedItems);
  const curatedInputItems = mergeForcedSelectItems(candidateItems, rankedItems);
  const date = formatDateFromUnixSeconds(snapshot.collectedAt);
  const ranking: RankingArtifact = {
    schemaVersion: 1,
    runId: createRunId({ collectedAt: snapshot.collectedAt, enabledSources: snapshot.enabledSources,
      itemIds: snapshot.items.map((item) => item.id) }),
    date,
    curationMode: 'npm-model',
    featureVersion: FEATURE_VERSION,
    collectedAt: snapshot.collectedAt,
    policyRevision: deps.getPolicyRevision(),
    rankedItems,
    candidateIds: curatedInputItems.map((item) => item.id),
  };
  await deps.writeRankingArtifact(ranking);
  const curateResult = normalizeCurateResult(await deps.curate(curatedInputItems));
  const curatedItems = curateResult.items;
  if (curatedItems.length === 0) {
    if (curateResult.diagnostics) {
      deps.log(`[generate] curation diagnostics: ${formatCurationDiagnosticsSummary(curateResult.diagnostics)}`);
    }
    deps.log('AI 未整理出任何资讯，本次运行结束。');
    return;
  }
  const curation = createCurationArtifact({ ranking, curatedItems,
    collectionWarnings: snapshot.collectionWarnings, curationDiagnostics: curateResult.diagnostics });
  await deps.writeCurationArtifact(curation);

  if (mode === 'review') {
    const packet = buildReviewPacket(snapshot, rankedItems, candidateItems, curatedItems, curateResult.diagnostics);
    const paths = await deps.writeReviewPacket(packet);
    deps.log(`[generate:review] Review JSON 已保存: ${paths.jsonPath}`);
    deps.log(`[generate:review] Review Markdown 已保存: ${paths.markdownPath}`);
    deps.log(`[generate:review] 下一步: ${REVIEW_NEXT_ACTION}`);
    return;
  }

  const selectedItems = await deps.select(curatedItems);
  const now = new Date().toISOString();
  const decision = {
    schemaVersion: 1 as const,
    runId: ranking.runId,
    date: ranking.date,
    curationMode: ranking.curationMode,
    featureVersion: ranking.featureVersion,
    curationRevision: curation.curationRevision,
    revision: 1,
    updatedAt: now,
    selection: { status: 'confirmed' as const, selectedIds: selectedItems.map((item) => item.id), confirmedAt: now },
    scoreFeedbackById: {},
  };
  await finalizePublication({ draft: snapshot, ranking, curation, decision }, {
    readState: async () => publishedState,
    formatSelection: deps.format,
    writePublicationOutputs: (formatted, report) => deps.publish(formatted, report),
    recordSelectionHistory: deps.recordPreferenceHistory,
    recordScoreFeedbackHistory: async () => {},
    writeFeedbackReview: async () => {},
    writeState: deps.writeState,
    clearDraft: deps.clearDraft,
  });

  deps.log('\n✅  全部完成！');
}

async function main(): Promise<void> {
  applyProxyFromEnv();

  await runGenerate(
    {
      recordPreferenceHistory: async (report) => {
        await recordPreferenceHistoryFromSelectionReport(report, {
          reportPath: `output/${report.date}-selection-report.json`,
        });
      },
      writeRankingArtifact: async (artifact) => { await persistRankingArtifact(artifact); },
      writeCurationArtifact: async (artifact) => { await persistCurationArtifact(artifact); },
    },
    parseGenerateOptions(process.argv.slice(2)),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error('\n❌  运行失败:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
