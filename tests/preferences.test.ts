import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  appendPreferenceHistoryEvent,
  backfillPreferenceHistoryFromReports,
  buildPreferenceEventFromSelectionReport,
  buildPreferenceProfile,
  getPreferenceRuleAdjustment,
  readConfirmedPreferenceRules,
  writeConfirmedPreferenceRules,
} from '../src/preferences.js';
import type { SelectionReport } from '../src/types.js';

function makeReport(overrides: Partial<SelectionReport> = {}): SelectionReport {
  return {
    date: '2026-06-10',
    rankedItems: [
      {
        id: 'selected-1',
        source: 'twitter',
        twitterFeed: 'for-you',
        url: 'https://github.com/apple/coreai-models',
        originUrl: 'https://x.com/alice/status/1',
        publishedAt: '2026-06-10T01:00:00Z',
        author: { name: 'Alice', username: 'alice' },
        text: `Long original tweet ${'x'.repeat(500)}`,
        body: 'body must not be copied',
        htmlBody: '<p>html must not be copied</p>',
        media: [],
        editorialScore: 70,
        engagementScore: 10,
        priorityScore: 55,
        scoreBreakdown: {
          substance: 20,
          evidence: 10,
          sourceSignal: 5,
          xArticleBonus: 0,
          substackSourceBonus: 0,
          freshness: 8,
          novelty: 15,
          actionability: 4,
          penalties: 0,
        },
        decisionReasons: ['高信息密度', '实践教程'],
        enteredCandidatePool: true,
        selectedByLlm: true,
        selectedByHuman: true,
      },
      {
        id: 'rejected-1',
        source: 'twitter',
        twitterFeed: 'for-you',
        url: 'https://example.com/vague',
        originUrl: 'https://x.com/bob/status/2',
        publishedAt: '2026-06-10T02:00:00Z',
        author: { name: 'Bob', username: 'bob' },
        text: 'A vague launch teaser with no details.',
        media: [],
        editorialScore: 20,
        engagementScore: 0,
        priorityScore: 15,
        scoreBreakdown: {
          substance: 4,
          evidence: 0,
          sourceSignal: 4,
          xArticleBonus: 0,
          substackSourceBonus: 0,
          freshness: 8,
          novelty: 15,
          actionability: 0,
          penalties: -8,
        },
        decisionReasons: ['低质量内容', '弱证据'],
        enteredCandidatePool: true,
        selectedByLlm: true,
        selectedByHuman: false,
      },
    ],
    curatedItems: [
      {
        id: 'selected-1',
        title: 'Apple 开源 Core AI Models',
        summary: 'Apple 开源了 Core AI Models，提供可复用的端侧 AI 开发组件。',
        url: 'https://github.com/apple/coreai-models',
        originUrl: 'https://x.com/alice/status/1',
        author: 'alice',
        attribution: '@alice',
        source: 'twitter',
        category: 'Product',
        media: [],
        priorityScore: 55,
        decisionReasons: ['高信息密度', '实践教程'],
      },
      {
        id: 'rejected-1',
        title: '模糊发布预告',
        summary: '这条内容缺少可验证细节。',
        url: 'https://example.com/vague',
        originUrl: 'https://x.com/bob/status/2',
        author: 'bob',
        attribution: '@bob',
        source: 'twitter',
        category: 'Opinions/Thoughts',
        media: [],
        priorityScore: 15,
        decisionReasons: ['低质量内容', '弱证据'],
      },
    ],
    selectedItems: [
      {
        id: 'selected-1',
        title: 'Apple 开源 Core AI Models',
        summary: 'Apple 开源了 Core AI Models，提供可复用的端侧 AI 开发组件。',
        url: 'https://github.com/apple/coreai-models',
        originUrl: 'https://x.com/alice/status/1',
        author: 'alice',
        attribution: '@alice',
        source: 'twitter',
        category: 'Product',
        media: [],
        priorityScore: 55,
        decisionReasons: ['高信息密度', '实践教程'],
      },
    ],
    ...overrides,
  };
}

test('buildPreferenceEventFromSelectionReport records every ranked candidate without full raw bodies', () => {
  const event = buildPreferenceEventFromSelectionReport(makeReport(), {
    recordedAt: '2026-06-10T10:00:00.000Z',
    reportPath: '/tmp/2026-06-10-selection-report.json',
  });

  assert.equal(event.schemaVersion, 1);
  assert.equal(event.runId, 'report:2026-06-10:/tmp/2026-06-10-selection-report.json');
  assert.equal(event.candidateCount, 2);
  assert.equal(event.selectedCount, 1);
  assert.deepEqual(
    event.items.map((item) => ({ id: item.id, selected: item.selected, domain: item.domain })),
    [
      { id: 'selected-1', selected: true, domain: 'github.com' },
      { id: 'rejected-1', selected: false, domain: 'example.com' },
    ],
  );
  assert.equal(event.items[0]?.summaryPreview, 'Apple 开源了 Core AI Models，提供可复用的端侧 AI 开发组件。');
  assert.ok((event.items[0]?.textPreview.length ?? 0) <= 240);
  assert.equal(JSON.stringify(event).includes('body must not be copied'), false);
  assert.equal(JSON.stringify(event).includes('html must not be copied'), false);
});

test('backfillPreferenceHistoryFromReports appends valid reports once and reports corrupt files', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'daily-news-preferences-'));
  const outputDir = join(tempDir, 'output');
  const historyPath = join(tempDir, 'data', 'preference-history.jsonl');
  await mkdir(outputDir, { recursive: true });

  await writeFile(join(outputDir, '2026-06-10-selection-report.json'), JSON.stringify(makeReport()), 'utf-8');
  await writeFile(join(outputDir, '2026-06-11-selection-report.json'), '{ broken json', 'utf-8');

  const first = await backfillPreferenceHistoryFromReports({ outputDir, historyPath });
  const second = await backfillPreferenceHistoryFromReports({ outputDir, historyPath });

  assert.equal(first.appended, 1);
  assert.equal(first.failedReports.length, 1);
  assert.match(first.failedReports[0]?.path ?? '', /2026-06-11-selection-report\.json$/);
  assert.equal(second.appended, 0);
  assert.equal(second.skippedExisting, 1);

  const lines = (await readFile(historyPath, 'utf-8')).trim().split('\n');
  assert.equal(lines.length, 1);
});

test('buildPreferenceProfile turns repeated selections into reviewable suggestions', async () => {
  const selectedReport = makeReport();
  const rejectedReport = makeReport({
    date: '2026-06-11',
    selectedItems: [],
    rankedItems: makeReport().rankedItems.map((item) => ({ ...item, selectedByHuman: false })),
  });
  const events = [
    buildPreferenceEventFromSelectionReport(selectedReport, { reportPath: '/tmp/2026-06-10-selection-report.json' }),
    buildPreferenceEventFromSelectionReport(selectedReport, { reportPath: '/tmp/2026-06-10-second-selection-report.json' }),
    buildPreferenceEventFromSelectionReport(rejectedReport, { reportPath: '/tmp/2026-06-11-selection-report.json' }),
  ];

  const profile = buildPreferenceProfile(events, { generatedAt: '2026-06-12T00:00:00.000Z', minSeen: 2 });

  assert.equal(profile.source.historyEvents, 3);
  assert.equal(profile.source.selectedItems, 2);
  assert.ok(profile.aggregates.domains.some((domain) => domain.key === 'github.com' && domain.selected === 2));
  assert.ok(profile.suggestions.domainRules.some((rule) => rule.key === 'github.com' && rule.bonus > 0));
  assert.ok(profile.suggestions.authorRules.some((rule) => rule.key === 'bob' && rule.penalty > 0));
  assert.ok(profile.suggestions.positiveTopicHints.includes('实践教程'));
  assert.ok(profile.suggestions.negativeTopicHints.includes('弱证据'));
});

test('confirmed preference rules are readable and produce item adjustments', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'daily-news-rules-'));
  const rulesPath = join(tempDir, 'preference-rules.json');

  await writeConfirmedPreferenceRules(
    {
      schemaVersion: 1,
      updatedAt: '2026-06-12T00:00:00.000Z',
      authorRules: {
        alice: { bonus: 4, reason: 'historically selected' },
      },
      domainRules: {
        'example.com': { penalty: 6, reason: 'historically rejected' },
      },
      positiveTopicHints: ['hands-on agent workflow'],
      negativeTopicHints: ['vague launch teaser'],
    },
    rulesPath,
  );

  const rules = readConfirmedPreferenceRules(rulesPath);
  const boosted = getPreferenceRuleAdjustment(
    {
      id: 'selected-1',
      source: 'twitter',
      url: 'https://github.com/apple/coreai-models',
      publishedAt: '2026-06-10T00:00:00Z',
      author: { name: 'Alice', username: 'alice' },
      text: 'useful agent workflow',
      media: [],
    },
    rules,
  );
  const penalized = getPreferenceRuleAdjustment(
    {
      id: 'rejected-1',
      source: 'twitter',
      url: 'https://news.example.com/vague',
      publishedAt: '2026-06-10T00:00:00Z',
      author: { name: 'Bob', username: 'bob' },
      text: 'vague launch teaser',
      media: [],
    },
    rules,
  );

  assert.equal(boosted.bonus, 4);
  assert.deepEqual(boosted.reasons, ['偏好作者:historically selected']);
  assert.equal(penalized.penalty, 6);
  assert.deepEqual(penalized.reasons, ['偏好域名:historically rejected']);
});

test('appendPreferenceHistoryEvent writes JSONL events', async () => {
  const tempDir = await mkdtemp(join(tmpdir(), 'daily-news-history-'));
  const historyPath = join(tempDir, 'preference-history.jsonl');
  const event = buildPreferenceEventFromSelectionReport(makeReport(), {
    reportPath: '/tmp/2026-06-10-selection-report.json',
  });

  await appendPreferenceHistoryEvent(event, historyPath);
  await appendPreferenceHistoryEvent({ ...event, runId: 'manual:2' }, historyPath);

  const lines = (await readFile(historyPath, 'utf-8')).trim().split('\n').map((line) => JSON.parse(line));
  assert.deepEqual(lines.map((line) => line.runId), [event.runId, 'manual:2']);
});
