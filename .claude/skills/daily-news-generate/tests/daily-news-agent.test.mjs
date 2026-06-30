import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  createReviewPacket,
  findFreshReviewPacket,
  formatRunSummary,
  mergePendingDraftWithFreshSnapshot,
  parseCliArgs,
  resolveRepoRoot,
  runAgent,
  validatePreflight,
} from '../scripts/runtime.mjs';

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
  await writeFile(join(repo, 'src', 'collect.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'curate.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'rank.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'draft.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'state.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'review.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'select.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'format.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'publish.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'preferences.ts'), 'export {}');
  await writeFile(join(repo, 'src', 'proxy.ts'), 'export {}');
  return repo;
}

function makeCollectedItem(overrides = {}) {
  return {
    id: 'tw-1',
    source: 'twitter',
    text: 'tweet',
    publishedAt: '2026-06-30T00:00:00Z',
    url: 'https://x.com/a/status/1',
    author: { name: 'A', username: 'a' },
    media: [],
    ...overrides,
  };
}

function makeCuratedItem(overrides = {}) {
  return {
    id: 'tw-1',
    title: 'Useful launch',
    summary: 'A useful launch happened.',
    url: 'https://x.com/a/status/1',
    author: 'A',
    attribution: '@a',
    source: 'twitter',
    category: 'Product',
    media: [],
    ...overrides,
  };
}

test('resolveRepoRoot works from arbitrary cwd and honors DAILY_NEWS_REPO', async () => {
  const repo = await makeTempRepo();
  const arbitraryCwd = await mkdtemp(join(tmpdir(), 'elsewhere-'));

  try {
    assert.equal(resolveRepoRoot({ cwd: arbitraryCwd, env: { DAILY_NEWS_REPO: repo } }), repo);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await rm(arbitraryCwd, { recursive: true, force: true });
  }
});

test('validatePreflight reports repo module availability without using package scripts', async () => {
  const repo = await makeTempRepo();

  try {
    const result = await validatePreflight({ repoRoot: repo, env: { PATH: '/bin' } });

    assert.equal(result.repoRoot, repo);
    assert.equal(result.hasTsx, true);
    assert.equal(result.modules.collect, true);
    assert.equal(result.modules.generate, undefined);
    assert.equal(result.usesPackageScripts, false);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test('parseCliArgs defaults to review and rejects unknown stages', () => {
  assert.deepEqual(parseCliArgs([]), { command: 'review' });
  assert.deepEqual(parseCliArgs(['diagnose']), { command: 'diagnose' });
  assert.throws(() => parseCliArgs(['unknown']), /Unsupported daily-news agent command/);
});

test('mergePendingDraftWithFreshSnapshot appends fresh unique source URLs', () => {
  const oldItem = makeCollectedItem({
    id: 'old',
    url: 'https://example.com/old',
    publishedAt: '2026-06-29T00:00:00Z',
  });
  const duplicateUrl = makeCollectedItem({ id: 'dupe-id', url: 'https://example.com/old' });
  const freshItem = makeCollectedItem({
    id: 'fresh',
    url: 'https://example.com/fresh',
    publishedAt: '2026-06-30T00:00:00Z',
  });

  const merged = mergePendingDraftWithFreshSnapshot(
    {
      collectedAt: 100,
      enabledSources: ['twitter'],
      collectionWarnings: ['old warning'],
      items: [oldItem],
    },
    {
      collectedAt: 200,
      enabledSources: ['substack'],
      collectionWarnings: ['fresh warning'],
      items: [duplicateUrl, freshItem],
    },
  );

  assert.equal(merged.collectedAt, 200);
  assert.deepEqual(merged.enabledSources, ['twitter', 'substack']);
  assert.deepEqual(merged.collectionWarnings, ['old warning', 'fresh warning']);
  assert.deepEqual(merged.items.map((item) => item.id), ['fresh', 'old']);
});

test('createReviewPacket fails loud on zero curated items', () => {
  assert.throws(
    () =>
      createReviewPacket({
        snapshot: {
          collectedAt: 1782777600,
          enabledSources: ['twitter'],
          items: [makeCollectedItem()],
        },
        rankedItems: [],
        candidateItems: [],
        curatedItems: [],
      }),
    /zero curated items/,
  );
});

test('findFreshReviewPacket ignores stale review files and parses the fresh artifact', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'daily-news-output-'));
  const stalePath = join(outputDir, '2026-06-29-review.json');
  const freshPath = join(outputDir, '2026-06-30-review.json');
  const after = Date.now();

  try {
    await writeFile(stalePath, JSON.stringify({ date: '2026-06-29', curatedItems: [makeCuratedItem()] }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await writeFile(
      freshPath,
      JSON.stringify({
        date: '2026-06-30',
        enabledSources: ['twitter'],
        curatedItems: [makeCuratedItem()],
        collectionWarnings: ['recommendation feed skipped'],
        curationDiagnostics: {
          inputCount: 2,
          outputCount: 1,
          rejectedCount: 1,
          rejectionCounts: {
            unknown_id: 1,
            url_mismatch: 0,
            duplicate_id: 0,
            duplicate_url: 0,
          },
          rejectionSamples: [],
          urlCorrections: [],
        },
      }),
    );

    const result = await findFreshReviewPacket({ outputDir, startedAtMs: after });

    assert.equal(result.jsonPath, freshPath);
    assert.equal(result.markdownPath, join(outputDir, '2026-06-30-review.md'));
    assert.equal(result.packet.curatedItems.length, 1);
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('findFreshReviewPacket fails loud when only stale review files exist', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'daily-news-output-'));

  try {
    await writeFile(
      join(outputDir, '2026-06-29-review.json'),
      JSON.stringify({ date: '2026-06-29', curatedItems: [makeCuratedItem()] }),
    );

    await assert.rejects(
      () => findFreshReviewPacket({ outputDir, startedAtMs: Date.now() + 1000 }),
      /No fresh review packet/,
    );
  } finally {
    await rm(outputDir, { recursive: true, force: true });
  }
});

test('formatRunSummary surfaces paths, warnings, diagnostics, and next action', () => {
  const summary = formatRunSummary({
    command: 'review',
    jsonPath: '/repo/output/2026-06-30-review.json',
    markdownPath: '/repo/output/2026-06-30-review.md',
    packet: {
      date: '2026-06-30',
      enabledSources: ['twitter'],
      curatedItems: [makeCuratedItem()],
      collectionWarnings: ['recommendation feed skipped'],
      curationDiagnostics: {
        inputCount: 2,
        outputCount: 1,
        rejectedCount: 1,
        rejectionCounts: {
          unknown_id: 1,
          url_mismatch: 0,
          duplicate_id: 0,
          duplicate_url: 0,
        },
        rejectionSamples: [],
        urlCorrections: [],
      },
      nextAction: 'Run publish when ready.',
    },
  });

  assert.match(summary, /Review JSON: \/repo\/output\/2026-06-30-review\.json/);
  assert.match(summary, /Curated items: 1/);
  assert.match(summary, /Collection warnings: recommendation feed skipped/);
  assert.match(summary, /unknown_id=1/);
  assert.match(summary, /Next action: Run publish when ready\./);
});

test('runAgent refuses publish when the terminal is not interactive', async () => {
  await assert.rejects(
    () =>
      runAgent({
        command: 'publish',
        repoRoot: '/tmp/missing',
        io: { stdinIsTTY: false, stdoutIsTTY: true },
      }),
    /interactive TTY/,
  );
});

test('skill scripts do not shell out through npm or reference src/generate.ts', async () => {
  const skillRoot = join(import.meta.dirname, '..');
  const scriptPaths = [
    join(skillRoot, 'scripts', 'daily-news-agent.mjs'),
    join(skillRoot, 'scripts', 'runtime.mjs'),
  ];

  for (const scriptPath of scriptPaths) {
    if (!existsSync(scriptPath)) continue;
    const content = await readFile(scriptPath, 'utf-8');
    assert.doesNotMatch(content, /\bnpm\b/);
    assert.doesNotMatch(content, /src\/generate\.ts/);
    assert.doesNotMatch(content, /generate:review/);
  }
});
