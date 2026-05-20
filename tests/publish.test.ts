import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { publish, writeSelectionReport } from '../src/publish.js';
import type { CurationDiagnostics, SelectionReport } from '../src/types.js';

test('publish saves Obsidian markdown under a YYYY-MM monthly folder', async () => {
  const vaultDir = await mkdtemp(join(tmpdir(), 'daily-news-vault-'));
  const originalVaultPath = process.env.OBSIDIAN_VAULT_PATH;
  process.env.OBSIDIAN_VAULT_PATH = vaultDir;

  try {
    await publish({
      date: '2026-04-30',
      obsidian: '# note',
      substack: '<p>x</p>',
    });

    const filepath = join(vaultDir, '2026-04', '2026-04-30-daily-news.md');
    assert.equal(await readFile(filepath, 'utf-8'), '# note');
  } finally {
    if (originalVaultPath === undefined) {
      delete process.env.OBSIDIAN_VAULT_PATH;
    } else {
      process.env.OBSIDIAN_VAULT_PATH = originalVaultPath;
    }
  }
});

test('writeSelectionReport persists ranking, curation, and human selection metadata', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'daily-news-report-'));
  const curationDiagnostics: CurationDiagnostics = {
    inputCount: 2,
    outputCount: 1,
    rejectedCount: 1,
    rejectionCounts: {
      unknown_id: 0,
      url_mismatch: 1,
      duplicate_id: 0,
      duplicate_url: 0,
    },
    rejectionSamples: [
      {
        reason: 'url_mismatch',
        id: '2',
        title: 'Wrong URL',
        modelUrl: 'https://example.com/wrong',
        sourceUrl: 'https://example.com/right',
      },
    ],
    urlCorrections: [
      {
        id: '1',
        fromUrl: 'https://x.com/alice/status/1',
        toUrl: 'https://x.com/alice/status/1',
        reason: 'origin_url',
      },
    ],
  };
  const report: SelectionReport = {
    date: '2026-03-19',
    curationDiagnostics,
    rankedItems: [
      {
        id: '1',
        source: 'twitter',
        url: 'https://x.com/alice/status/1',
        publishedAt: '2026-03-19T10:00:00Z',
        author: { name: 'Alice', username: 'alice' },
        text: 'OpenAI released docs and benchmarks https://example.com',
        media: [],
        editorialScore: 80,
        engagementScore: 12,
        priorityScore: 63,
        scoreBreakdown: {
          substance: 24,
          evidence: 14,
          sourceSignal: 6,
          xArticleBonus: 0,
          freshness: 9,
          novelty: 15,
          actionability: 0,
          penalties: 0,
        },
        decisionReasons: ['高信息密度', '有理有据'],
        enteredCandidatePool: true,
        selectedByLlm: true,
        selectedByHuman: true,
      },
    ],
    curatedItems: [
      {
        id: '1',
        title: 'OpenAI 发布新文档',
        summary: 'Summary',
        url: 'https://x.com/alice/status/1',
        author: 'Alice',
        attribution: '@alice',
        source: 'twitter',
        category: 'Product',
        media: [],
        priorityScore: 63,
        decisionReasons: ['高信息密度', '有理有据'],
        editorialReason: '这条信息同时给出发布事实与一手证据。',
      },
    ],
    selectedItems: [
      {
        id: '1',
        title: 'OpenAI 发布新文档',
        summary: 'Summary',
        url: 'https://x.com/alice/status/1',
        author: 'Alice',
        attribution: '@alice',
        source: 'twitter',
        category: 'Product',
        media: [],
        priorityScore: 63,
        decisionReasons: ['高信息密度', '有理有据'],
        editorialReason: '这条信息同时给出发布事实与一手证据。',
      },
    ],
  };

  const filepath = await writeSelectionReport(report, outputDir);
  const saved = JSON.parse(await readFile(filepath, 'utf-8')) as SelectionReport;

  assert.equal(filepath, join(outputDir, '2026-03-19-selection-report.json'));
  assert.equal(saved.rankedItems[0]?.priorityScore, 63);
  assert.equal(saved.rankedItems[0]?.selectedByHuman, true);
  assert.equal(saved.curatedItems[0]?.editorialReason, '这条信息同时给出发布事实与一手证据。');
  assert.deepEqual(saved.curationDiagnostics, curationDiagnostics);
  assert.equal(saved.selectedItems.length, 1);
});
