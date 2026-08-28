import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import http from 'node:http';
import { EnvHttpProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from 'undici';
import {
  buildAgentRankingArtifact,
  buildSelectHtml,
  mergeForcedSelectItems,
  parseCliArgs,
  probeHealth,
  resolveRepoRoot,
  resolveSelectPort,
  resolveSelection,
  runPublish,
  runStatus,
  trimCandidatePool,
  validatePreflight,
  findMostRecentSelectPid,
} from '../scripts/runtime.mjs';

// ───────────────────────── fixtures ─────────────────────────

async function makeTempRepo() {
  const repo = await mkdtemp(join(tmpdir(), 'daily-news-skill-test-'));
  await mkdir(join(repo, 'src'), { recursive: true });
  await mkdir(join(repo, 'data'), { recursive: true });
  await mkdir(join(repo, 'output'), { recursive: true });
  await mkdir(join(repo, 'node_modules', 'tsx', 'dist'), { recursive: true });
  await writeFile(
    join(repo, 'node_modules', 'tsx', 'package.json'),
    '{"name":"tsx","exports":{".":"./dist/loader.mjs"}}',
  );
  await writeFile(join(repo, 'node_modules', 'tsx', 'dist', 'loader.mjs'), 'export {}');
  for (const name of [
    'artifact-identity', 'collect', 'curate', 'curation-artifact', 'draft', 'envDiagnostics', 'feedbackCli', 'format',
    'preferences', 'proxy', 'publish', 'publication-workflow', 'rank', 'ranking-artifact',
    'score-feedback-history', 'selection-decision', 'selection-decision-store', 'source-registry', 'state',
  ]) {
    await writeFile(join(repo, 'src', `${name}.ts`), 'export {};');
  }
  return repo;
}

// ───────────────────────── cli + repo resolution ─────────────────────────

test('parseCliArgs defaults to collect, captures flags, rejects unknown stages', () => {
  assert.deepEqual(parseCliArgs([]), { command: 'collect', resume: false, discard: false, force: false });
  assert.deepEqual(parseCliArgs(['collect', '--resume']), { command: 'collect', resume: true, discard: false, force: false });
  assert.deepEqual(parseCliArgs(['select', '--force']), { command: 'select', resume: false, discard: false, force: true });
  // select-start / select-stop are valid commands; --force still parses for select-start.
  assert.deepEqual(parseCliArgs(['select-start']), { command: 'select-start', resume: false, discard: false, force: false });
  assert.deepEqual(parseCliArgs(['select-start', '--force']), { command: 'select-start', resume: false, discard: false, force: true });
  assert.deepEqual(parseCliArgs(['select-stop']), { command: 'select-stop', resume: false, discard: false, force: false });
  assert.deepEqual(parseCliArgs(['feedback-apply', '--date=2026-08-27']), {
    command: 'feedback-apply', resume: false, discard: false, force: false, date: '2026-08-27',
  });
  assert.equal(parseCliArgs(['--help']).command, 'help');
  assert.throws(() => parseCliArgs(['review']), /Unsupported daily-news agent command/);
});

test('resolveRepoRoot honors an absolute DAILY_NEWS_REPO without doubling the path', () => {
  const abs = '/Users/someone/workspace/personal/daily-news';
  assert.equal(resolveRepoRoot({ cwd: '/elsewhere', env: { DAILY_NEWS_REPO: abs } }), abs);
  assert.equal(
    resolveRepoRoot({ cwd: '/elsewhere', env: { DAILY_NEWS_REPO: './local' } }),
    join('/elsewhere', 'local'),
  );
});

test('resolveRepoRoot falls back to cwd when DAILY_NEWS_REPO is unset (no hardcoded machine path)', () => {
  // Regression intent: the default must NOT be a hardcoded absolute path belonging to a
  // specific developer's machine. Running the skill from the repo root just works.
  assert.equal(resolveRepoRoot({ cwd: '/any/repo/root', env: {} }), '/any/repo/root');
  assert.equal(resolveRepoRoot({ cwd: '/any/repo/root', env: { DAILY_NEWS_REPO: '   ' } }), '/any/repo/root');
});

test('validatePreflight reports only the modules this engine imports, and never package scripts', async () => {
  const repo = await makeTempRepo();
  try {
    const result = await validatePreflight({ repoRoot: repo, env: { PATH: '/bin' } });
    assert.equal(result.hasTsx, true);
    assert.equal(result.modules.collect, true);
    assert.equal(result.modules.curate, true);
    assert.equal(result.modules.generate, undefined);
    assert.equal(result.modules.review, undefined);
    assert.equal(result.modules.select, undefined);
    assert.equal(result.usesPackageScripts, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ───────────────────────── deterministic helpers ─────────────────────────

test('buildAgentRankingArtifact records the exact curator pool', () => {
  const draft = { collectedAt: 100, enabledSources: ['twitter', 'aihot'], items: [{ id: 'a' }, { id: 'b' }] };
  const rankedItems = [{ id: 'a', priorityScore: 2 }, { id: 'b', priorityScore: 1 }];
  const artifact = buildAgentRankingArtifact({
    draft,
    rankedItems,
    candidateItems: [rankedItems[1]],
    date: '2026-08-27',
    policyRevision: 3,
    createRunId: () => 'run-a',
    featureVersion: 'tag-signal-feedback-v1',
  });
  assert.equal(artifact.runId, 'run-a');
  assert.deepEqual(artifact.candidateIds, ['b']);
  assert.equal(artifact.policyRevision, 3);
});

test('mergeForcedSelectItems appends each forceSelect item once, without duplicates', () => {
  const candidate = [{ id: 'a' }, { id: 'b' }];
  const ranked = [{ id: 'a' }, { id: 'c', forceSelect: true }, { id: 'd', forceSelect: true }, { id: 'c', forceSelect: true }];
  assert.deepEqual(mergeForcedSelectItems(candidate, ranked).map((i) => i.id), ['a', 'b', 'c', 'd']);
});

test('trimCandidatePool keeps all forceSelect items even below the score cap, dedupes, sorts by score', () => {
  const items = [
    { id: 'a', priorityScore: 10 },
    { id: 'b', priorityScore: 90, forceSelect: true },
    { id: 'c', priorityScore: 50 },
    { id: 'd', priorityScore: 1, forceSelect: true },
    { id: 'a', priorityScore: 10 }, // duplicate id
  ];
  // Cap of 2: both forceSelect items survive despite low score on 'd'; no room for optional.
  assert.deepEqual(trimCandidatePool(items, 2).map((i) => i.id), ['b', 'd']);
  // Cap of 3: forceSelect (b,d) + top optional (c), sorted by score desc.
  assert.deepEqual(trimCandidatePool(items, 3).map((i) => i.id), ['b', 'c', 'd']);
});

test('resolveSelection preserves curated order, rejects unknown ids, dedupes', () => {
  const curation = { curatedItems: [{ id: '1' }, { id: '2' }, { id: '3' }] };
  // Curated order wins over the order the user clicked.
  assert.deepEqual(resolveSelection(curation, ['3', '1']).map((i) => i.id), ['1', '3']);
  // Repeated ids collapse to one.
  assert.deepEqual(resolveSelection(curation, ['1', '1']).map((i) => i.id), ['1']);
  assert.throws(() => resolveSelection(curation, ['nope']), /Unknown selection ids: nope/);
  assert.throws(() => resolveSelection(curation, '1'), /selectedIds must be an array/);
});

// ───────────────────────── detached select cleanup ─────────────────────────

test('findMostRecentSelectPid locates the latest output/*-select.pid by date (post-publish cleanup)', async () => {
  // Intent: after publish the draft is cleared, so select-stop cannot read the date from the draft —
  // it must find the pid by scanning output/. It picks the newest DATE, not filesystem creation order,
  // and returns null when nothing is running so cleanup is a safe no-op.
  const repo = await mkdtemp(join(tmpdir(), 'daily-news-skill-test-'));
  try {
    const out = join(repo, 'output');
    await mkdir(out, { recursive: true });
    assert.equal(await findMostRecentSelectPid(repo), null); // nothing to stop
    await writeFile(join(out, '2026-07-19-select.pid'), '111');
    await writeFile(join(out, '2026-07-21-select.pid'), '222');
    await writeFile(join(out, '2026-07-20-select.pid'), '333'); // written last, but not the newest date
    const found = await findMostRecentSelectPid(repo);
    assert.equal(found.date, '2026-07-21');
    assert.equal(found.path, join(out, '2026-07-21-select.pid'));
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ───────────────────────── select html ─────────────────────────

test('buildSelectHtml embeds the date, the absolute confirm endpoint, and every curated item', () => {
  const curation = {
    date: '2026-07-08', runId: 'run-a', curationRevision: 'curation-a',
    collectionWarnings: ['recommendation feed skipped'],
    curatedItems: [
      { id: '1', title: 'T1', summary: 'S1', category: 'Product', source: 'twitter', attribution: '@a', url: 'https://x.com/1', media: [] },
      { id: '2', title: 'T2', summary: 'S2', category: 'Tutorial', source: 'substack', attribution: 'pub', url: 'https://sub.com/2', media: [] },
    ],
  };
  const html = buildSelectHtml(curation, 'http://127.0.0.1:9999');
  assert.match(html, /2026-07-08/);
  // The confirm endpoint is built at runtime as serverOrigin + '/select'; both tokens must be present.
  assert.match(html, /"serverOrigin":"http:\/\/127\.0\.0\.1:9999"/);
  assert.match(html, /serverOrigin\+'\/select'/);
  assert.match(html, /"title":"T1"/);
  assert.match(html, /"title":"T2"/);
  assert.match(html, /recommendation feed skipped/);
  // The confirm button and a per-item checkbox must exist.
  assert.match(html, /id="confirm"/);
  // Selections persist in the browser across reloads/restarts (localStorage), so a restart never loses ticks.
  assert.match(html, /localStorage/);
  assert.match(html, /restoreSelection/);
  assert.match(html, /saveSelection/);
  assert.match(html, /daily-news-select:/);
  assert.match(html, /评分过高/);
  assert.match(html, /评分过低/);
  assert.match(html, /serverOrigin\+'\/feedback'/);
  assert.match(html, /"runId":"run-a"/);
  assert.match(html, /"curationRevision":"curation-a"/);
});

test('resolveSelectPort honors DAILY_NEWS_SELECT_PORT, falls back to the default, and validates', () => {
  assert.equal(resolveSelectPort({}), 8427);
  assert.equal(resolveSelectPort({ DAILY_NEWS_SELECT_PORT: '' }), 8427);
  assert.equal(resolveSelectPort({ DAILY_NEWS_SELECT_PORT: '9100' }), 9100);
  assert.throws(() => resolveSelectPort({ DAILY_NEWS_SELECT_PORT: 'nope' }), /Invalid DAILY_NEWS_SELECT_PORT/);
  assert.throws(() => resolveSelectPort({ DAILY_NEWS_SELECT_PORT: '0' }), /Invalid DAILY_NEWS_SELECT_PORT/);
  assert.throws(() => resolveSelectPort({ DAILY_NEWS_SELECT_PORT: '70000' }), /Invalid DAILY_NEWS_SELECT_PORT/);
  assert.throws(() => resolveSelectPort({ DAILY_NEWS_SELECT_PORT: '1.5' }), /Invalid DAILY_NEWS_SELECT_PORT/);
});

test('probeHealth reaches 127.0.0.1 even when global fetch is forced through a dead proxy', async () => {
  // Intent: select-start must not kill a healthy server because HTTP_PROXY intercepted /health.
  const original = getGlobalDispatcher();
  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  try {
    setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: 'http://127.0.0.1:9' }));
    assert.equal(await probeHealth(port), true);
  } finally {
    setGlobalDispatcher(original);
    await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  }
});

test('status lists canonical feedback artifacts and every source cursor', async () => {
  const repo = await makeTempRepo();
  const draft = { collectedAt: 1_783_476_198, enabledSources: ['twitter', 'aihot'], items: [{ id: '1' }] };
  await writeFile(join(repo, 'output', '2026-07-08-ranking.json'), '{}');
  await writeFile(join(repo, 'output', '2026-07-08-selection-decision.json'), '{}');
  const status = await runStatus({ pipeline: {
    draftModule: { readPendingDraft: async () => draft },
    stateModule: { readState: async () => ({ sources: { twitter: { lastPublishedTime: 1 },
      substack: { lastPublishedTime: 2 }, aihot: { lastPublishedTime: 3 } } }) },
    sourceRegistryModule: { formatPublishedCursorStatus: (state) =>
      `Twitter=${state.sources.twitter.lastPublishedTime}, Substack=${state.sources.substack.lastPublishedTime}, AI HOT=${state.sources.aihot.lastPublishedTime}` },
  }, repoRoot: repo, log: () => {} });
  assert.match(status, /ranking\.json/);
  assert.match(status, /selection-decision\.json/);
  assert.match(status, /AI HOT=3/);
  await rm(repo, { recursive: true, force: true });
});

// ───────────────────────── publish wiring (fake pipeline) ─────────────────────────

test('runPublish consumes canonical artifacts without reranking', async () => {
  const repo = await makeTempRepo();
  const date = '2026-07-08';
  const draft = { collectedAt: 1_783_476_198, enabledSources: ['twitter'], items: [{ id: '1' }] };
  const ranking = { runId: 'run-a', date };
  const curation = { runId: 'run-a', date, curationRevision: 'curation-a' };
  const decision = { runId: 'run-a', date, curationRevision: 'curation-a', revision: 2 };
  for (const [name, value] of Object.entries({ ranking, curation, 'selection-decision': decision })) {
    await writeFile(join(repo, 'output', `${date}-${name}.json`), JSON.stringify(value));
  }
  let finalizeInput;
  const fakePipeline = {
    draftModule: { readPendingDraft: async () => draft },
    rankingArtifactModule: { decodeRankingArtifact: (value) => value },
    curationArtifactModule: { decodeCurationArtifact: (value) => value },
    selectionDecisionModule: { decodeSelectionDecision: (value) => value },
    stateModule: { readState: async () => ({}), writeState: async () => {} },
    publishModule: { publish: async () => {} },
    preferencesModule: { recordPreferenceHistoryFromSelectionReport: async () => {} },
    scoreFeedbackHistoryModule: { appendScoreFeedbackHistoryIdempotently: async () => 0 },
    publicationWorkflowModule: { finalizePublication: async (input) => {
      finalizeInput = input;
      return { selectedItems: [{ id: '1' }], feedbackCount: 1, report: {} };
    } },
  };
  try {
    const summary = await runPublish({ pipeline: fakePipeline, repoRoot: repo, log: () => {} });
    assert.deepEqual(finalizeInput.ranking, ranking);
    assert.deepEqual(finalizeInput.curation, curation);
    assert.deepEqual(finalizeInput.decision, decision);
    assert.match(summary, /feedback-review\.json/);
  } finally { await rm(repo, { recursive: true, force: true }); }
});

test('runPublish formats the selection, builds the report, publishes, advances state, clears the draft', async () => {
  const repo = await makeTempRepo();
  const date = '2026-07-08';
  const collectedAt = 1_783_476_198; // 2026-07-08 in unix seconds
  const draftItem = (id) => ({ id, source: 'twitter', url: `https://x.com/${id}`, author: { name: 'A', username: 'a' }, media: [], text: 't', publishedAt: '2026-07-08T00:00:00Z' });
  const draft = { items: [draftItem('1'), draftItem('2'), draftItem('3')], enabledSources: ['twitter'], collectedAt };

  const curatedItems = [
    { id: '1', title: '一', summary: 's', category: 'Product', source: 'twitter', url: 'https://x.com/1', author: 'a', attribution: '@a', media: [], priorityScore: 50 },
    { id: '2', title: '二', summary: 's', category: 'Product', source: 'twitter', url: 'https://x.com/2', author: 'a', attribution: '@a', media: [], priorityScore: 40 },
    { id: '3', title: '三', summary: 's', category: 'Tutorial', source: 'twitter', url: 'https://x.com/3', author: 'a', attribution: '@a', media: [], priorityScore: 30 },
  ];
  const selectedItems = curatedItems.slice(0, 2);

  await mkdir(join(repo, 'output'), { recursive: true });
  const ranking = { runId: 'run-a', date, rankedItems: draft.items };
  const curation = { runId: 'run-a', date, collectedAt, collectionWarnings: ['w'], curatedItems,
    curationDiagnostics: { rejectedCount: 0 } };
  const decision = { runId: 'run-a', date, selectedItems };
  await writeFile(join(repo, 'output', `${date}-ranking.json`), JSON.stringify(ranking));
  await writeFile(join(repo, 'output', `${date}-curation.json`), JSON.stringify(curation));
  await writeFile(join(repo, 'output', `${date}-selection-decision.json`), JSON.stringify(decision));

  const calls = { format: null, recordPref: null, publish: null, writeState: null, cleared: false };
  const initialState = { sources: {
    twitter: { lastPublishedTime: 0 }, substack: { lastPublishedTime: 0 }, aihot: { lastPublishedTime: 77 },
  } };
  const fakePipeline = {
    draftModule: {
      readPendingDraft: async () => draft,
      clearPendingDraft: async () => {
        calls.cleared = true;
      },
    },
    stateModule: {
      readState: async () => initialState,
      writeState: async (state) => {
        calls.writeState = state;
      },
    },
    sourceRegistryModule: {
      advancePublishedState: (state, enabledSources, nextTime) => ({
        sources: Object.fromEntries(Object.entries(state.sources).map(([source, value]) => [
          source, enabledSources.includes(source) ? { lastPublishedTime: nextTime } : value,
        ])),
      }),
    },
    rankingArtifactModule: { decodeRankingArtifact: (value) => value },
    curationArtifactModule: { decodeCurationArtifact: (value) => value },
    selectionDecisionModule: { decodeSelectionDecision: (value) => value },
    scoreFeedbackHistoryModule: { appendScoreFeedbackHistoryIdempotently: async () => 0 },
    publicationWorkflowModule: { finalizePublication: async (input, deps) => {
      const formatted = fakePipeline.formatModule.format(input.decision.selectedItems, date);
      const report = { ...input.ranking, curatedItems: input.curation.curatedItems,
        selectedItems: input.decision.selectedItems, collectionWarnings: input.curation.collectionWarnings };
      await deps.recordSelectionHistory(report);
      await deps.writePublicationOutputs(formatted, report);
      await deps.writeState({ sources: { twitter: { lastPublishedTime: collectedAt },
        substack: { lastPublishedTime: 0 }, aihot: { lastPublishedTime: 77 } } });
      await deps.clearDraft();
      return { report, selectedItems: input.decision.selectedItems, feedbackCount: 0 };
    } },
    formatModule: {
      format: (selected, d) => {
        calls.format = { selected, d };
        return { obsidian: 'obs', substack: 'sub', date: d };
      },
    },
    preferencesModule: {
      readConfirmedPreferenceRules: () => null,
      recordPreferenceHistoryFromSelectionReport: async (report, opts) => {
        calls.recordPref = { report, opts };
      },
    },
    publishModule: {
      publish: async (formatted, report) => {
        calls.publish = { formatted, report };
      },
    },
  };

  try {
    const summary = await runPublish({ pipeline: fakePipeline, repoRoot: repo, log: () => {} });
    assert.match(summary, /publish: complete/);

    // format received exactly the user's selection and the correct date
    assert.deepEqual(calls.format.selected.map((i) => i.id), ['1', '2']);
    assert.equal(calls.format.d, date);

    // publish received the formatted output and a report carrying the selection + curation
    assert.equal(calls.publish.formatted.date, date);
    assert.equal(calls.publish.report.selectedItems.length, 2);
    assert.equal(calls.publish.report.curatedItems.length, 3);
    assert.deepEqual(calls.publish.report.collectionWarnings, ['w']);

    // preference history recorded to the dated report path
    assert.equal(calls.recordPref.opts.reportPath, `output/${date}-selection-report.json`);

    // state advanced: twitter (enabled) -> collectedAt; every disabled source remains unchanged
    assert.equal(calls.writeState.sources.twitter.lastPublishedTime, collectedAt);
    assert.equal(calls.writeState.sources.substack.lastPublishedTime, 0);
    assert.equal(calls.writeState.sources.aihot.lastPublishedTime, 77);

    // draft cleared only after everything else succeeded
    assert.equal(calls.cleared, true);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('runPublish fails loud when the selection artifact is missing', async () => {
  const repo = await makeTempRepo();
  const date = '2026-07-08';
  const collectedAt = 1_783_476_198;
  await writeFile(join(repo, 'output', `${date}-ranking.json`), JSON.stringify({ rankedItems: [{ id: '1' }] }));
  await writeFile(join(repo, 'output', `${date}-curation.json`), JSON.stringify({ curatedItems: [{ id: '1' }] }));
  const fakePipeline = {
    draftModule: { readPendingDraft: async () => ({ items: [{ id: '1' }], enabledSources: ['twitter'], collectedAt }) },
    stateModule: { readState: async () => ({ sources: { twitter: { lastPublishedTime: 0 }, substack: { lastPublishedTime: 0 } } }) },
    rankModule: { rankItems: () => [], selectCandidatePool: (i) => i },
    formatModule: { format: () => ({}) },
    preferencesModule: {},
    publishModule: { publish: async () => {} },
  };
  try {
    await assert.rejects(() => runPublish({ pipeline: fakePipeline, repoRoot: repo, log: () => {} }), /selection/);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

// ───────────────────────── the core invariant: no LLM inside the skill ─────────────────────────

test('skill documents the post-publish content-tag feedback protocol', async () => {
  const skill = await readFile(join(import.meta.dirname, '..', 'SKILL.md'), 'utf-8');
  for (const phrase of ['评分过高', '评分过低', 'selection-decision.json', 'smallest content Tag',
    'no_change', 'never modify author/domain rules', 'feedback-apply']) {
    assert.match(skill, new RegExp(phrase, 'i'));
  }
});

test('the skill scripts never invoke a third-party LLM or the monolithic generate entrypoint', async () => {
  const skillRoot = join(import.meta.dirname, '..');
  const scriptPaths = [join(skillRoot, 'scripts', 'daily-news-agent.mjs'), join(skillRoot, 'scripts', 'runtime.mjs')];
  for (const scriptPath of scriptPaths) {
    if (!existsSync(scriptPath)) continue;
    const content = await readFile(scriptPath, 'utf-8');
    // No package-script / monolithic-entrypoint coupling.
    assert.doesNotMatch(content, /\bnpm\b/, `${scriptPath} must not shell out via npm`);
    assert.doesNotMatch(content, /src\/generate\.ts/, `${scriptPath} must not reference the monolithic entrypoint`);
    assert.doesNotMatch(content, /generate:review/, `${scriptPath} must not reference package review scripts`);
    // No third-party LLM / AI SDK calls anywhere in the engine.
    assert.doesNotMatch(content, /generateText|streamText|attachReaderBriefs|curateWithDiagnostics|curateWithModel|generateForcedRoundupResponse/, `${scriptPath} must not call any LLM curation/reader function`);
    assert.doesNotMatch(content, /@ai-sdk|from\s+['"]ai['"]|openai|anthropic/, `${scriptPath} must not import any LLM SDK`);
  }
});
