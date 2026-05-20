import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { writeReviewPacket } from '../src/review.js';
import type { CurationDiagnostics, ReviewPacket } from '../src/types.js';

test('writeReviewPacket persists JSON and human-readable Markdown review artifacts', async () => {
  const outputDir = await mkdtemp(join(tmpdir(), 'daily-news-review-'));
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
        id: 'tw-2',
        title: 'Wrong URL',
        modelUrl: 'https://example.com/wrong',
        sourceUrl: 'https://example.com/right',
      },
    ],
    urlCorrections: [
      {
        id: 'tw-1',
        fromUrl: 'https://x.com/alice/status/1',
        toUrl: 'https://docs.example.com/launch',
        reason: 'origin_url',
      },
    ],
  };
  const packet: ReviewPacket = {
    date: '2026-05-06',
    collectedAt: 1778000400,
    enabledSources: ['twitter', 'substack'],
    nextAction: 'Run `npm run generate`, choose `resume`, then select the final items.',
    curationDiagnostics,
    rankedItems: [
      {
        id: 'tw-1',
        source: 'twitter',
        url: 'https://x.com/alice/status/1',
        originUrl: 'https://x.com/alice/status/1',
        publishedAt: '2026-05-06T00:00:00Z',
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
      },
    ],
    curatedItems: [
      {
        id: 'tw-1',
        title: 'OpenAI 发布新文档',
        summary: 'OpenAI 发布了新的文档和 benchmark，给开发者提供了更清晰的落地参考。',
        url: 'https://docs.example.com/launch',
        originUrl: 'https://x.com/alice/status/1',
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

  const paths = await writeReviewPacket(packet, outputDir);
  const json = JSON.parse(await readFile(paths.jsonPath, 'utf-8')) as ReviewPacket;
  const markdown = await readFile(paths.markdownPath, 'utf-8');

  assert.equal(paths.jsonPath, join(outputDir, '2026-05-06-review.json'));
  assert.equal(paths.markdownPath, join(outputDir, '2026-05-06-review.md'));
  assert.equal(json.collectedAt, 1778000400);
  assert.deepEqual(json.curationDiagnostics, curationDiagnostics);
  assert.equal(json.rankedItems[0]?.enteredCandidatePool, true);
  assert.equal(json.rankedItems[0]?.selectedByLlm, true);
  assert.match(markdown, /# daily-news Review · 2026-05-06/);
  assert.match(markdown, /Next action: Run `npm run generate`, choose `resume`, then select the final items\./);
  assert.match(markdown, /Curation diagnostics: rejected=1 \(url_mismatch=1\), corrected_urls=1/);
  assert.match(markdown, /## Product/);
  assert.match(markdown, /### 1\. OpenAI 发布新文档/);
  assert.match(markdown, /Source: https:\/\/docs\.example\.com\/launch/);
  assert.match(markdown, /Original: https:\/\/x\.com\/alice\/status\/1/);
  assert.match(markdown, /Priority: 63/);
  assert.match(markdown, /Reasons: 高信息密度, 有理有据/);
  assert.match(markdown, /Editorial reason: 这条信息同时给出发布事实与一手证据。/);
});
