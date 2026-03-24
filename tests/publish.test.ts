import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeSelectionReport } from '../src/publish.js';
import type { SelectionReport } from '../src/types.js';

test('writeSelectionReport persists ranking, curation, and human selection metadata', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'daily-news-report-'));
  const report: SelectionReport = {
    date: '2026-03-19',
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
          freshness: 9,
          novelty: 15,
          actionability: 0,
          penalties: 0,
        },
        decisionReasons: ['high_substance', 'strong_evidence'],
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
        decisionReasons: ['high_substance', 'strong_evidence'],
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
        decisionReasons: ['high_substance', 'strong_evidence'],
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
  assert.equal(saved.selectedItems.length, 1);
});
