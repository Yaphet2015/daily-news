import { createRequire } from 'node:module';
import { readdir, readFile, stat } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const DEFAULT_REPO_ROOT = '/Users/suosuo/workspace/personal/daily-news';
const REVIEW_NEXT_ACTION = 'Run daily-news-generate publish, then select the final items.';
const VALID_COMMANDS = new Set(['review', 'diagnose', 'preflight', 'collect', 'analyze', 'review-write', 'publish']);
const MODULE_FILES = [
  'collect',
  'curate',
  'rank',
  'draft',
  'state',
  'review',
  'select',
  'format',
  'publish',
  'preferences',
  'proxy',
  'envDiagnostics',
];

function printUsage() {
  console.log(`Usage: daily-news-agent [review|diagnose|preflight|collect|analyze|review-write|publish]

Defaults to review. Set DAILY_NEWS_REPO to override the daily-news repo path.`);
}

function hasHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

export function parseCliArgs(args) {
  if (hasHelp(args)) return { command: 'help' };
  const command = args[0] ?? 'review';
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unsupported daily-news agent command: ${command}`);
  }
  return { command };
}

export function resolveRepoRoot({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.DAILY_NEWS_REPO?.trim()) {
    return path.resolve(cwd, env.DAILY_NEWS_REPO.trim());
  }
  return DEFAULT_REPO_ROOT;
}

function modulePath(repoRoot, name) {
  return path.join(repoRoot, 'src', `${name}.ts`);
}

function loadTsxPath(repoRoot) {
  const require = createRequire(path.join(repoRoot, 'noop.cjs'));
  return require.resolve('tsx', { paths: [repoRoot] });
}

function loadRepoEnv(repoRoot) {
  try {
    const require = createRequire(path.join(repoRoot, 'noop.cjs'));
    const dotenv = require('dotenv');
    dotenv.config({ path: path.join(repoRoot, '.env') });
  } catch {
    // dotenv is a normal repo dependency, but absence should be reported by
    // module imports if the checkout is not installed.
  }
}

export async function validatePreflight({ repoRoot = resolveRepoRoot(), env = process.env } = {}) {
  const modules = {};
  for (const name of MODULE_FILES) {
    modules[name] = existsSync(modulePath(repoRoot, name));
  }

  let tsxPath = null;
  try {
    tsxPath = loadTsxPath(repoRoot);
  } catch {
    tsxPath = null;
  }

  return {
    repoRoot,
    node: process.version,
    cwd: process.cwd(),
    path: env.PATH ?? '',
    dataDir: existsSync(path.join(repoRoot, 'data')),
    outputDir: existsSync(path.join(repoRoot, 'output')),
    hasTsx: Boolean(tsxPath),
    tsxPath,
    modules,
    usesPackageScripts: false,
  };
}

function assertPreflightReady(preflight) {
  const missingModules = Object.entries(preflight.modules)
    .filter(([, present]) => !present)
    .map(([name]) => name);
  const failures = [];

  if (!existsSync(preflight.repoRoot)) failures.push(`repo root does not exist: ${preflight.repoRoot}`);
  if (!preflight.hasTsx) failures.push('repo-local tsx is missing; run dependency installation in the daily-news repo');
  if (!preflight.dataDir) failures.push('data directory is missing');
  if (!preflight.outputDir) failures.push('output directory is missing');
  if (missingModules.length > 0) failures.push(`missing pipeline modules: ${missingModules.join(', ')}`);

  if (failures.length > 0) {
    throw new Error(`daily-news preflight failed: ${failures.join('; ')}`);
  }
}

async function importRepoModule(repoRoot, name) {
  return import(pathToFileURL(modulePath(repoRoot, name)).href);
}

async function loadPipeline(repoRoot) {
  const [
    collectModule,
    curateModule,
    draftModule,
    envDiagnosticsModule,
    formatModule,
    preferencesModule,
    proxyModule,
    publishModule,
    rankModule,
    reviewModule,
    selectModule,
    stateModule,
  ] = await Promise.all([
    importRepoModule(repoRoot, 'collect'),
    importRepoModule(repoRoot, 'curate'),
    importRepoModule(repoRoot, 'draft'),
    importRepoModule(repoRoot, 'envDiagnostics'),
    importRepoModule(repoRoot, 'format'),
    importRepoModule(repoRoot, 'preferences'),
    importRepoModule(repoRoot, 'proxy'),
    importRepoModule(repoRoot, 'publish'),
    importRepoModule(repoRoot, 'rank'),
    importRepoModule(repoRoot, 'review'),
    importRepoModule(repoRoot, 'select'),
    importRepoModule(repoRoot, 'state'),
  ]);

  return {
    collectModule,
    curateModule,
    draftModule,
    envDiagnosticsModule,
    formatModule,
    preferencesModule,
    proxyModule,
    publishModule,
    rankModule,
    reviewModule,
    selectModule,
    stateModule,
  };
}

function createAppendCollectionState(draft) {
  return {
    sources: {
      twitter: { lastPublishedTime: draft.collectedAt },
      substack: { lastPublishedTime: draft.collectedAt },
    },
  };
}

function advancePublishedState(state, sources, collectedAt) {
  const nextState = {
    sources: {
      twitter: { lastPublishedTime: state.sources.twitter.lastPublishedTime },
      substack: { lastPublishedTime: state.sources.substack.lastPublishedTime },
    },
  };

  for (const source of sources) {
    if (source === 'twitter' || source === 'substack') {
      nextState.sources[source] = { lastPublishedTime: collectedAt };
    }
  }

  return nextState;
}

function getItemTimestamp(item) {
  const timestamp = Date.parse(item.publishedAt);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function getSourceUrlKey(item) {
  return `${item.source}:${item.url.trim().toLowerCase()}`;
}

export function mergePendingDraftWithFreshSnapshot(draft, freshSnapshot) {
  const items = [];
  const seenIds = new Set();
  const seenSourceUrls = new Set();

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

function mergeForcedSelectItems(candidateItems, rankedItems) {
  const merged = [...candidateItems];
  const seen = new Set(candidateItems.map((item) => item.id));

  for (const item of rankedItems) {
    if (!item.forceSelect || seen.has(item.id)) continue;
    merged.push(item);
    seen.add(item.id);
  }

  return merged;
}

function annotateRankedItems(rankedItems, candidateItems, curatedItems, selectedItems) {
  const candidateIds = new Set(candidateItems.map((item) => item.id));
  const curatedIds = new Set(curatedItems.map((item) => item.id));
  const selectedIds = selectedItems ? new Set(selectedItems.map((item) => item.id)) : null;

  return rankedItems.map((item) => {
    const annotated = {
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

function normalizeCurateResult(result) {
  return Array.isArray(result) ? { items: result } : result;
}

function buildSelectionReport({
  date,
  collectionWarnings,
  rankedItems,
  candidateItems,
  curatedItems,
  selectedItems,
  curationDiagnostics,
}) {
  return {
    date,
    ...(collectionWarnings && collectionWarnings.length > 0 ? { collectionWarnings } : {}),
    curationDiagnostics,
    rankedItems: annotateRankedItems(rankedItems, candidateItems, curatedItems, selectedItems),
    curatedItems,
    selectedItems,
  };
}

export function createReviewPacket({ snapshot, rankedItems, candidateItems, curatedItems, curationDiagnostics }) {
  if (!Array.isArray(curatedItems) || curatedItems.length === 0) {
    throw new Error('daily-news review produced zero curated items');
  }

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

function formatDateFromUnixSeconds(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

async function collectSnapshot({ pipeline, mode, log = console.log }) {
  const { collectModule, draftModule, stateModule } = pipeline;
  const publishedState = await stateModule.readState();
  const existingDraft = await draftModule.readPendingDraft();

  if (existingDraft) {
    if (mode === 'publish') {
      log(`[daily-news-agent] resume pending draft with ${existingDraft.items.length} items`);
      return { snapshot: existingDraft, publishedState };
    }

    const freshSnapshot = await collectModule.collect(createAppendCollectionState(existingDraft));
    if (freshSnapshot.items.length > 0) {
      const merged = mergePendingDraftWithFreshSnapshot(existingDraft, freshSnapshot);
      await draftModule.writePendingDraft(merged);
      log(`[daily-news-agent] appended ${freshSnapshot.items.length} fresh items, merged total ${merged.items.length}`);
      return { snapshot: merged, publishedState };
    }

    log('[daily-news-agent] no fresh appendable items; reviewing existing pending draft');
    return { snapshot: existingDraft, publishedState };
  }

  const snapshot = await collectModule.collect(publishedState);
  if (snapshot.items.length === 0) {
    throw new Error('daily-news collect returned zero items');
  }
  await draftModule.writePendingDraft(snapshot);
  return { snapshot, publishedState };
}

async function analyzeSnapshot({ pipeline, snapshot }) {
  const { curateModule, preferencesModule, rankModule } = pipeline;
  const enrichedCollectedItems = await curateModule.attachReaderBriefs(snapshot.items);
  const rankedItems = rankModule.rankItems(enrichedCollectedItems, preferencesModule.readConfirmedPreferenceRules());
  const candidateItems = rankModule.selectCandidatePool(rankedItems);
  const curatedInputItems = mergeForcedSelectItems(candidateItems, rankedItems);
  const curateResult = normalizeCurateResult(await curateModule.curateWithDiagnostics(curatedInputItems));

  if (!Array.isArray(curateResult.items) || curateResult.items.length === 0) {
    const diagnostics = curateResult.diagnostics
      ? curateModule.formatCurationDiagnosticsSummary(curateResult.diagnostics)
      : 'none';
    throw new Error(`daily-news analyze produced zero curated items; curation diagnostics: ${diagnostics}`);
  }

  return {
    rankedItems,
    candidateItems,
    curatedItems: curateResult.items,
    curationDiagnostics: curateResult.diagnostics,
  };
}

async function writeReview({ pipeline, snapshot, analysis }) {
  const packet = createReviewPacket({ snapshot, ...analysis });
  const paths = await pipeline.reviewModule.writeReviewPacket(packet);
  return { packet, ...paths };
}

async function runReview({ pipeline, log = console.log }) {
  const { snapshot } = await collectSnapshot({ pipeline, mode: 'review', log });
  const analysis = await analyzeSnapshot({ pipeline, snapshot });
  const result = await writeReview({ pipeline, snapshot, analysis });
  return formatRunSummary({
    command: 'review',
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    packet: result.packet,
  });
}

async function runDiagnose({ pipeline }) {
  await pipeline.envDiagnosticsModule.logEnvironmentDiagnostics();
  await pipeline.collectModule.diagnoseCollectEnvironment();
  return 'daily-news diagnose completed';
}

async function runCollectOnly({ pipeline, log = console.log }) {
  const { snapshot } = await collectSnapshot({ pipeline, mode: 'review', log });
  return `daily-news collect completed: items=${snapshot.items.length}, collectedAt=${snapshot.collectedAt}`;
}

async function runAnalyzeOnly({ pipeline, log = console.log }) {
  const { snapshot } = await collectSnapshot({ pipeline, mode: 'review', log });
  const analysis = await analyzeSnapshot({ pipeline, snapshot });
  return `daily-news analyze completed: curated=${analysis.curatedItems.length}, candidates=${analysis.candidateItems.length}`;
}

async function runReviewWriteOnly({ pipeline, log = console.log }) {
  const { snapshot } = await collectSnapshot({ pipeline, mode: 'review', log });
  const analysis = await analyzeSnapshot({ pipeline, snapshot });
  const result = await writeReview({ pipeline, snapshot, analysis });
  return formatRunSummary({
    command: 'review-write',
    jsonPath: result.jsonPath,
    markdownPath: result.markdownPath,
    packet: result.packet,
  });
}

async function runPublish({ pipeline, log = console.log }) {
  const { snapshot, publishedState } = await collectSnapshot({ pipeline, mode: 'publish', log });
  const analysis = await analyzeSnapshot({ pipeline, snapshot });
  const selectedItems = await pipeline.selectModule.select(analysis.curatedItems);
  const formatted = pipeline.formatModule.format(selectedItems, formatDateFromUnixSeconds(snapshot.collectedAt));
  const report = buildSelectionReport({
    date: formatted.date,
    collectionWarnings: snapshot.collectionWarnings,
    selectedItems,
    ...analysis,
  });

  await pipeline.preferencesModule.recordPreferenceHistoryFromSelectionReport(report, {
    reportPath: `output/${report.date}-selection-report.json`,
  });
  await pipeline.publishModule.publish(formatted, report);
  await pipeline.stateModule.writeState(advancePublishedState(publishedState, snapshot.enabledSources, snapshot.collectedAt));
  await pipeline.draftModule.clearPendingDraft();
  return `daily-news publish completed: selected=${selectedItems.length}, date=${formatted.date}`;
}

export async function findFreshReviewPacket({ outputDir, startedAtMs }) {
  const entries = await readdir(outputDir);
  const candidates = [];

  for (const entry of entries) {
    if (!entry.endsWith('-review.json')) continue;
    const jsonPath = path.join(outputDir, entry);
    const fileStat = await stat(jsonPath);
    if (fileStat.mtimeMs < startedAtMs) continue;
    candidates.push({ jsonPath, mtimeMs: fileStat.mtimeMs });
  }

  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  const candidate = candidates[0];
  if (!candidate) {
    throw new Error(`No fresh review packet found in ${outputDir}`);
  }

  let packet;
  try {
    packet = JSON.parse(await readFile(candidate.jsonPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Malformed review packet ${candidate.jsonPath}: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (!Array.isArray(packet.curatedItems) || packet.curatedItems.length === 0) {
    throw new Error(`Fresh review packet has zero curated items: ${candidate.jsonPath}`);
  }

  return {
    jsonPath: candidate.jsonPath,
    markdownPath: candidate.jsonPath.replace(/\.json$/, '.md'),
    packet,
  };
}

function formatRejectionCounts(diagnostics) {
  if (!diagnostics?.rejectionCounts) return 'none';
  const parts = Object.entries(diagnostics.rejectionCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

export function formatRunSummary({ command, jsonPath, markdownPath, packet }) {
  const lines = [
    `daily-news ${command} completed`,
    `Review JSON: ${jsonPath}`,
    `Review Markdown: ${markdownPath}`,
    `Date: ${packet.date ?? '<unknown>'}`,
    `Sources: ${(packet.enabledSources ?? []).join(', ') || '<none>'}`,
    `Curated items: ${packet.curatedItems.length}`,
  ];

  if (packet.collectionWarnings?.length) {
    lines.push(`Collection warnings: ${packet.collectionWarnings.join('; ')}`);
  }

  if (packet.curationDiagnostics) {
    lines.push(
      `Curation diagnostics: rejected=${packet.curationDiagnostics.rejectedCount}, ${formatRejectionCounts(packet.curationDiagnostics)}`,
    );
  }

  if (packet.nextAction) {
    lines.push(`Next action: ${packet.nextAction}`);
  }

  return lines.join('\n');
}

export async function runAgent({
  command = 'review',
  repoRoot = resolveRepoRoot(),
  env = process.env,
  io = { stdinIsTTY: Boolean(process.stdin.isTTY), stdoutIsTTY: Boolean(process.stdout.isTTY) },
  log = console.log,
} = {}) {
  if (command === 'publish' && (!io.stdinIsTTY || !io.stdoutIsTTY)) {
    throw new Error('daily-news publish requires an interactive TTY');
  }

  const preflight = await validatePreflight({ repoRoot, env });
  assertPreflightReady(preflight);

  if (command === 'preflight') {
    return JSON.stringify(preflight, null, 2);
  }

  process.chdir(repoRoot);
  loadRepoEnv(repoRoot);
  const pipeline = await loadPipeline(repoRoot);
  pipeline.proxyModule.applyProxyFromEnv();

  if (command === 'diagnose') return runDiagnose({ pipeline });
  if (command === 'collect') return runCollectOnly({ pipeline, log });
  if (command === 'analyze') return runAnalyzeOnly({ pipeline, log });
  if (command === 'review-write') return runReviewWriteOnly({ pipeline, log });
  if (command === 'publish') return runPublish({ pipeline, log });
  return runReview({ pipeline, log });
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help') {
    printUsage();
    return;
  }

  const repoRoot = resolveRepoRoot();
  const result = await runAgent({ command: parsed.command, repoRoot });
  if (result) console.log(result);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
