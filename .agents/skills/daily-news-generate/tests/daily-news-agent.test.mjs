import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  advancePublishedState,
  annotateRankedItems,
  buildSelectHtml,
  buildSelectionReport,
  mergeForcedSelectItems,
  parseCliArgs,
  resolveRepoRoot,
  resolveSelectPort,
  resolveSelection,
  runPublish,
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
  for (const name of ['collect', 'curate', 'draft', 'envDiagnostics', 'format', 'preferences', 'proxy', 'publish', 'rank', 'state']) {
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

test('advancePublishedState advances only the enabled sources to collectedAt', () => {
  const state = { sources: { twitter: { lastPublishedTime: 100 }, substack: { lastPublishedTime: 200 } } };
  const next = advancePublishedState(state, ['twitter'], 999);
  assert.equal(next.sources.twitter.lastPublishedTime, 999);
  assert.equal(next.sources.substack.lastPublishedTime, 200); // untouched
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

test('buildSelectionReport annotates candidate/curated/selected membership and omits empty warnings', () => {
  const rankedItems = [{ id: '1', priorityScore: 50 }, { id: '2', priorityScore: 40 }, { id: '3', priorityScore: 30 }];
  const report = buildSelectionReport({
    date: '2026-07-08',
    collectionWarnings: [],
    rankedItems,
    candidateItems: [{ id: '1' }, { id: '2' }],
    curatedItems: [{ id: '1' }],
    selectedItems: [{ id: '1' }],
    curationDiagnostics: { rejectedCount: 0 },
  });

  assert.equal(report.collectionWarnings, undefined);
  const byId = new Map(report.rankedItems.map((i) => [i.id, i]));
  assert.equal(byId.get('1').enteredCandidatePool, true);
  assert.equal(byId.get('1').selectedByLlm, true);
  assert.equal(byId.get('1').selectedByHuman, true);
  assert.equal(byId.get('2').enteredCandidatePool, true);
  assert.equal(byId.get('2').selectedByLlm, false);
  assert.equal(byId.get('3').enteredCandidatePool, false);
  assert.equal(report.selectedItems.length, 1);
  assert.deepEqual(report.curationDiagnostics, { rejectedCount: 0 });
});

// annotateRankedItems is the engine behind buildSelectionReport's annotations.
test('annotateRankedItems marks selectedByHuman only when a selection is provided', () => {
  const annotated = annotateRankedItems([{ id: '1' }], [{ id: '1' }], [{ id: '1' }], [{ id: '1' }]);
  assert.equal(annotated[0].selectedByHuman, true);
  const noSelection = annotateRankedItems([{ id: '1' }], [{ id: '1' }], [{ id: '1' }]);
  assert.equal(noSelection[0].selectedByHuman, undefined);
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
    date: '2026-07-08',
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
  assert.match(html, /daily-news-select-/);
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

// ───────────────────────── publish wiring (fake pipeline) ─────────────────────────

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
  await writeFile(join(repo, 'output', `${date}-curation.json`), JSON.stringify({ date, collectedAt, enabledSources: ['twitter'], collectionWarnings: ['w'], curatedItems, curationDiagnostics: { rejectedCount: 0 } }));
  await writeFile(join(repo, 'output', `${date}-selection.json`), JSON.stringify({ date, selectedItems }));

  const calls = { format: null, recordPref: null, publish: null, writeState: null, cleared: false };
  const initialState = { sources: { twitter: { lastPublishedTime: 0 }, substack: { lastPublishedTime: 0 } } };
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
    rankModule: {
      rankItems: (items) => items.map((i, idx) => ({ ...i, priorityScore: 50 - idx, editorialScore: 1, engagementScore: 0, decisionReasons: [] })),
      selectCandidatePool: (items) => items,
    },
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

    // state advanced: twitter (enabled) -> collectedAt, substack (not enabled) -> unchanged
    assert.equal(calls.writeState.sources.twitter.lastPublishedTime, collectedAt);
    assert.equal(calls.writeState.sources.substack.lastPublishedTime, 0);

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
