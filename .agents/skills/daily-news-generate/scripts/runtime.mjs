import { createRequire } from 'node:module';
import { existsSync, openSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import http from 'node:http';
import net from 'node:net';
import { spawn } from 'node:child_process';

const DEFAULT_CURATE_POOL = 80;
const DEFAULT_SELECT_TARGET_MIN = 6;
const DEFAULT_SELECT_TARGET_MAX = 10;
// Pinned so the select URL is stable across restarts: an agent re-run lands on the same port,
// and the user's already-open tab (whose confirm POST targets this origin) keeps working.
const DEFAULT_SELECT_PORT = 8427;

// Only the modules this engine actually imports. The agent-driven pipeline
// never calls any LLM: curateModule is imported solely for the deterministic
// enrichCuratedItemsWithDiagnostics helper.
const MODULE_FILES = [
  'artifact-identity',
  'collect',
  'curate',
  'curation-artifact',
  'draft',
  'envDiagnostics',
  'feedbackCli',
  'format',
  'preferences',
  'proxy',
  'publish',
  'publication-workflow',
  'rank',
  'ranking-artifact',
  'score-feedback-history',
  'selection-decision',
  'selection-decision-store',
  'source-registry',
  'state',
];

const VALID_COMMANDS = new Set([
  'preflight',
  'diagnose',
  'status',
  'collect',
  'curate-input',
  'curate-apply',
  'select',
  'select-start',
  'select-stop',
  'publish',
  'feedback-apply',
]);

const VALID_CATEGORIES = ['Product', 'Tutorial', 'Opinions/Thoughts'];

function printUsage() {
  console.log(`Usage: daily-news-agent <command> [flags]

Agent-driven pipeline (no third-party LLM — the agent curates):
  preflight            Validate repo root, modules, data/output dirs, repo-local tsx.
  diagnose             Print environment fingerprint and collection preflight.
  status               Show the current draft date, which stage artifacts exist, and the next action.
  collect [--resume|--discard]
                       Collect into data/pending-draft.json. If a draft already exists with no
                       flag, it reports and exits so the agent can ask the user. --resume keeps
                       the draft; --discard clears it and re-collects.
  curate-input         Rank (deterministic, no LLM) and write output/<date>-curate-input.json,
                       the candidate pool the agent curates from.
  curate-apply         Enrich the agent's output/<date>-curate-output.json into
                       output/<date>-curation.json (CuratedItem[] + diagnostics).
  select [--force]     Serve the interactive HTML page on a stable local port and BLOCK until the
                       user confirms (legacy foreground mode; the agent stays working). Prefer
                       select-start/select-stop so the agent is free during selection.
  select-start [--force]
                       Launch the select server DETACHED so it survives the agent's turn ending,
                       auto-open the default browser, write output/<date>-select.pid + select.log,
                       then return immediately. The agent is NOT blocking — end the turn so the
                       user can steer. The server self-exits on confirm.
  select-stop          Stop the detached select server (from select-start's select.pid) and remove
                       the pidfile. Idempotent — run it after publish to clean up lingering servers.
  publish              Format the selection, persist feedback review, advance state, clear the draft.
  feedback-apply --date=YYYY-MM-DD
                       Validate output/<date>-feedback-adjustment.json and atomically update policy.

Default command: collect (start a fresh collection; if a draft already exists it reports and
                     exits without destroying it). Set DAILY_NEWS_REPO to override the daily-news repo path.
Env: DAILY_NEWS_SELECT_PORT (default 8427) pins the select server port.
     DAILY_NEWS_COLLECT_NOW_SECONDS overrides the collection cutoff Unix timestamp.`);
}

function hasHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

export function parseCliArgs(args) {
  if (hasHelp(args)) return { command: 'help' };
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const command = positional[0] ?? 'collect';
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unsupported daily-news agent command: ${command}`);
  }
  const date = args.find((arg) => arg.startsWith('--date='))?.slice('--date='.length);
  return {
    command,
    resume: args.includes('--resume'),
    discard: args.includes('--discard'),
    force: args.includes('--force'),
    ...(date ? { date } : {}),
  };
}

export function resolveRepoRoot({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.DAILY_NEWS_REPO?.trim()) {
    return resolve(cwd, env.DAILY_NEWS_REPO.trim());
  }
  return cwd;
}

function modulePath(repoRoot, name) {
  return join(repoRoot, 'src', `${name}.ts`);
}

function loadTsxPath(repoRoot) {
  const require = createRequire(join(repoRoot, 'noop.cjs'));
  return require.resolve('tsx', { paths: [repoRoot] });
}

function loadRepoEnv(repoRoot) {
  try {
    const require = createRequire(join(repoRoot, 'noop.cjs'));
    const dotenv = require('dotenv');
    dotenv.config({ path: join(repoRoot, '.env') });
  } catch {
    // dotenv is a normal repo dependency; its absence surfaces via module imports.
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
    dataDir: existsSync(join(repoRoot, 'data')),
    outputDir: existsSync(join(repoRoot, 'output')),
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
    artifactIdentityModule,
    collectModule,
    curateModule,
    curationArtifactModule,
    draftModule,
    envDiagnosticsModule,
    feedbackCliModule,
    formatModule,
    preferencesModule,
    proxyModule,
    publishModule,
    publicationWorkflowModule,
    rankModule,
    rankingArtifactModule,
    scoreFeedbackHistoryModule,
    selectionDecisionModule,
    selectionDecisionStoreModule,
    sourceRegistryModule,
    stateModule,
  ] = await Promise.all([
    importRepoModule(repoRoot, 'artifact-identity'),
    importRepoModule(repoRoot, 'collect'),
    importRepoModule(repoRoot, 'curate'),
    importRepoModule(repoRoot, 'curation-artifact'),
    importRepoModule(repoRoot, 'draft'),
    importRepoModule(repoRoot, 'envDiagnostics'),
    importRepoModule(repoRoot, 'feedbackCli'),
    importRepoModule(repoRoot, 'format'),
    importRepoModule(repoRoot, 'preferences'),
    importRepoModule(repoRoot, 'proxy'),
    importRepoModule(repoRoot, 'publish'),
    importRepoModule(repoRoot, 'publication-workflow'),
    importRepoModule(repoRoot, 'rank'),
    importRepoModule(repoRoot, 'ranking-artifact'),
    importRepoModule(repoRoot, 'score-feedback-history'),
    importRepoModule(repoRoot, 'selection-decision'),
    importRepoModule(repoRoot, 'selection-decision-store'),
    importRepoModule(repoRoot, 'source-registry'),
    importRepoModule(repoRoot, 'state'),
  ]);

  return {
    artifactIdentityModule,
    collectModule,
    curateModule,
    curationArtifactModule,
    draftModule,
    envDiagnosticsModule,
    feedbackCliModule,
    formatModule,
    preferencesModule,
    proxyModule,
    publishModule,
    publicationWorkflowModule,
    rankModule,
    rankingArtifactModule,
    scoreFeedbackHistoryModule,
    selectionDecisionModule,
    selectionDecisionStoreModule,
    sourceRegistryModule,
    stateModule,
  };
}

// ───────────────────────── deterministic helpers (no LLM) ─────────────────────────

export function formatDateFromUnixSeconds(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function buildAgentRankingArtifact({
  draft, rankedItems, candidateItems, date, policyRevision, createRunId, featureVersion,
}) {
  return {
    schemaVersion: 1,
    runId: createRunId({
      collectedAt: draft.collectedAt,
      enabledSources: draft.enabledSources,
      itemIds: draft.items.map((item) => item.id),
    }),
    date,
    curationMode: 'agent-curator',
    featureVersion,
    collectedAt: draft.collectedAt,
    policyRevision,
    rankedItems,
    candidateIds: candidateItems.map((item) => item.id),
  };
}

export function mergeForcedSelectItems(candidateItems, rankedItems) {
  const merged = [...candidateItems];
  const seen = new Set(candidateItems.map((item) => item.id));

  for (const item of rankedItems) {
    if (!item.forceSelect || seen.has(item.id)) continue;
    merged.push(item);
    seen.add(item.id);
  }

  return merged;
}

export function trimCandidatePool(items, poolSize) {
  const forced = items.filter((item) => item.forceSelect);
  const optional = items.filter((item) => !item.forceSelect);
  const optionalQuota = Math.max(0, poolSize - forced.length);
  const optionalTop = [...optional]
    .sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0))
    .slice(0, optionalQuota);

  const seen = new Set();
  const pool = [];
  for (const item of [...forced, ...optionalTop]) {
    if (seen.has(item.id)) continue;
    seen.add(item.id);
    pool.push(item);
  }
  return pool.sort((a, b) => (b.priorityScore ?? 0) - (a.priorityScore ?? 0));
}

export function resolveSelection(curation, selectedIds) {
  if (!Array.isArray(selectedIds)) {
    throw new Error('selectedIds must be an array of item ids');
  }
  const byId = new Map((curation.curatedItems ?? []).map((item) => [item.id, item]));
  const unknown = selectedIds.filter((id) => !byId.has(id));
  if (unknown.length > 0) {
    const preview = unknown.slice(0, 5).join(', ');
    throw new Error(`Unknown selection ids: ${preview}${unknown.length > 5 ? ` (+${unknown.length - 5} more)` : ''}`);
  }

  const wanted = new Set(selectedIds);
  return (curation.curatedItems ?? []).filter((item) => wanted.has(item.id));
}

// ───────────────────────── json artifact io ─────────────────────────

function artifactPath(repoRoot, date, suffix) {
  return join(repoRoot, 'output', `${date}-${suffix}`);
}

async function readJson(file) {
  return JSON.parse(await readFile(file, 'utf-8'));
}

async function readJsonOrNull(file) {
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch {
    return null;
  }
}

async function writeJson(file, data) {
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(data, null, 2), 'utf-8');
}

async function readDraftOrFail(pipeline) {
  const draft = await pipeline.draftModule.readPendingDraft();
  if (!draft) {
    throw new Error('No pending draft found in data/pending-draft.json. Run `collect` first.');
  }
  if (!Array.isArray(draft.items) || draft.items.length === 0) {
    throw new Error('Pending draft has no items. Run `collect --discard` to re-collect.');
  }
  return draft;
}

function validateCurateOutput(output) {
  if (!output || typeof output !== 'object') {
    throw new Error('curate-output.json must be a JSON object: { "items": [...] }.');
  }
  const items = output.items;
  if (!Array.isArray(items) || items.length === 0) {
    throw new Error('curate-output.json has no items. The agent must curate at least one item.');
  }
  for (const [index, item] of items.entries()) {
    const where = `items[${index}]`;
    if (!item || typeof item !== 'object') throw new Error(`${where} is not an object.`);
    for (const key of ['id', 'title', 'summary', 'url', 'category']) {
      if (typeof item[key] !== 'string' || item[key].trim() === '') {
        throw new Error(`${where}.${key} must be a non-empty string.`);
      }
    }
    if (!VALID_CATEGORIES.includes(item.category)) {
      throw new Error(`${where}.category must be one of ${VALID_CATEGORIES.join(', ')} (got "${item.category}").`);
    }
  }
  return items;
}

// ───────────────────────── interactive select html ─────────────────────────

export function buildSelectHtml(curation, serverOrigin, decision = null) {
  const date = curation.date;
  // Escape so the JSON is safe inside <script> (handles </script>, U+2028/2029, etc.).
  const dataJson = JSON.stringify({
    date,
    runId: curation.runId,
    curationRevision: curation.curationRevision,
    decisionRevision: decision?.revision ?? 0,
    scoreFeedbackById: decision?.scoreFeedbackById ?? {},
    serverOrigin,
    targetMin: DEFAULT_SELECT_TARGET_MIN,
    targetMax: DEFAULT_SELECT_TARGET_MAX,
    curatedItems: curation.curatedItems ?? [],
    collectionWarnings: curation.collectionWarnings ?? [],
  }).replace(/</g, '\\u003c');

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>AI 日刊选择 · ${date}</title>
<!-- Ant Design default theme (no custom styles). Versions are pinned so the page renders
     the same every day. These are the official UMD builds; antd needs React/ReactDOM/dayjs
     globals loaded first. -->
<link rel="stylesheet" href="https://unpkg.com/antd@5.29.3/dist/reset.css" />
<script src="https://unpkg.com/react@18.3.1/umd/react.production.min.js"></script>
<script src="https://unpkg.com/react-dom@18.3.1/umd/react-dom.production.min.js"></script>
<script src="https://unpkg.com/dayjs@1.11.23/dayjs.min.js"></script>
<script src="https://unpkg.com/antd@5.29.3/dist/antd-with-locales.min.js"></script>
<script src="https://unpkg.com/@babel/standalone@7.29.8/babel.min.js"></script>
<style>
  /* Structural layout only — colors, fonts and component looks all come from the antd default theme.
     width:100% is required: Content is a flex item, and margin:auto without a width makes it
     shrink-to-fit its content instead of filling the page column. */
  .select-page { width: 100%; max-width: 920px; margin: 0 auto; padding: 16px 16px 112px; box-sizing: border-box; }
  .select-action-bar { position: fixed; left: 0; right: 0; bottom: 0; z-index: 100; display: flex; justify-content: center; padding: 12px 16px; box-sizing: border-box; }
</style>
</head>
<body>
<div id="root"></div>
<script>
  // Fail loud when the CDN assets cannot load (e.g. offline): babel then never runs and #root stays empty.
  window.addEventListener('load', function () {
    if (document.getElementById('root').childElementCount === 0) {
      document.getElementById('root').innerHTML =
        '<p style="padding:24px;font-family:system-ui;color:#b91c1c">页面加载失败：Ant Design 组件（CDN）未能载入，请检查网络后刷新。</p>';
    }
  });
</script>
<script type="text/babel" data-presets="react">
const DATA = ${dataJson};
const { useState } = React;
const {
  Alert, App, Button, Card, Checkbox, ConfigProvider, Divider, Flex, Image, Layout, Space, Tag, Typography, theme,
} = antd;
const { Title, Text, Paragraph, Link } = Typography;
const { Content, Footer } = Layout;

const CATS = ['Product', 'Tutorial', 'Opinions/Thoughts'];
const TARGET = DATA.targetMin + '-' + DATA.targetMax;
// Persist the user's ticks across reloads/restarts so an accidental refresh or a server
// restart never loses their selections. The confirmed decision file on the server is SSOT;
// this cache only applies while runId + curationRevision are unchanged.
const STORE_KEY = 'daily-news-select:' + DATA.runId + ':' + DATA.curationRevision;
const byCat = {};
for (const c of CATS) byCat[c] = [];
const unknownCategoryItems = [];
for (const it of DATA.curatedItems) {
  if (byCat[it.category]) byCat[it.category].push(it);
  else unknownCategoryItems.push(it); // fail loud instead of silently dropping
}

function restoreSelection() {
  let ids;
  try { ids = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch (e) { return []; }
  if (!Array.isArray(ids) || ids.length === 0) return [];
  const valid = new Set(DATA.curatedItems.map((it) => it.id));
  return ids.filter((id) => valid.has(id));
}

function saveSelection(ids) {
  try { localStorage.setItem(STORE_KEY, JSON.stringify(ids)); } catch (e) { /* best-effort cache */ }
}

function RootApp() {
  // antd default theme; follow the OS dark preference via antd's own dark algorithm (no custom tokens).
  const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
  return (
    <ConfigProvider theme={prefersDark ? { algorithm: theme.darkAlgorithm } : undefined}>
      <App>
        <SelectPage />
      </App>
    </ConfigProvider>
  );
}

function ItemCard({ item, checked, disabled, activeDirection, rowState, onToggle, onFeedback }) {
  const photos = (Array.isArray(item.media) ? item.media : []).filter((m) => m.type === 'photo').slice(0, 4);
  // One quiet meta line instead of a wall of same-looking tags: source · author · thread · teaser.
  const metaParts = [item.source, item.attribution || item.author];
  if (item.threadPartCount) metaParts.push('thread · ' + item.threadPartCount);
  if (item.substackTeaserOnly) metaParts.push('订阅墙/预览');
  return (
    <Card size="small" style={{ marginBottom: 12 }}>
      <Flex align="flex-start" gap={10}>
        <Checkbox
          style={{ marginTop: 3 }}
          checked={checked}
          disabled={disabled}
          onChange={(e) => onToggle(item.id, e.target.checked)}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          <Flex align="baseline" gap={8} wrap>
            <Title level={5} style={{ margin: 0, flex: '1 1 auto' }}>{item.title}</Title>
            {typeof item.priorityScore === 'number' && (
              <Tag color="blue" style={{ marginInlineEnd: 0, flex: '0 0 auto' }}>优先级 {item.priorityScore}</Tag>
            )}
          </Flex>
          <Text type="secondary" style={{ fontSize: 12 }}>{metaParts.filter(Boolean).join(' · ')}</Text>
          <Paragraph style={{ whiteSpace: 'pre-wrap', marginTop: 8, marginBottom: 8 }}>{item.summary}</Paragraph>
          {photos.length > 0 && (
            <Image.PreviewGroup>
              <Space size={8} wrap style={{ marginBottom: 4 }}>
                {photos.map((m) => (
                  <Image
                    key={m.url}
                    width={96}
                    height={96}
                    src={m.url}
                    alt={item.title}
                    style={{ objectFit: 'cover', borderRadius: 6 }}
                    referrerPolicy="no-referrer"
                  />
                ))}
              </Space>
            </Image.PreviewGroup>
          )}
          {(item.decisionReasons || []).length > 0 && (
            <Paragraph type="secondary" italic style={{ marginBottom: 4 }}>
              {(item.decisionReasons || []).slice(0, 3).join(' · ')}
            </Paragraph>
          )}
          {item.editorialReason && (
            <Paragraph type="success" style={{ marginBottom: 4 }}>编辑理由：{item.editorialReason}</Paragraph>
          )}
          <Divider dashed style={{ margin: '8px 0' }} />
          <Flex justify="space-between" align="center" gap={12} wrap>
            <Space size={16} wrap>
              <Link href={item.originUrl || item.url} target="_blank" rel="noopener noreferrer">原帖/来源</Link>
              {item.originUrl && item.originUrl !== item.url && (
                <Link href={item.url} target="_blank" rel="noopener noreferrer">引用</Link>
              )}
            </Space>
            <Space size={8} wrap>
              <Button
                size="small"
                loading={rowState.saving}
                type={activeDirection === 'too_high' ? 'primary' : 'default'}
                onClick={() => onFeedback(item.id, 'too_high')}
              >评分过高</Button>
              <Button
                size="small"
                loading={rowState.saving}
                danger
                type={activeDirection === 'too_low' ? 'primary' : 'default'}
                onClick={() => onFeedback(item.id, 'too_low')}
              >评分过低</Button>
              {rowState.status && <Text type="secondary">{rowState.status}</Text>}
              {rowState.error && <Text type="danger">保存失败：{rowState.error}</Text>}
            </Space>
          </Flex>
        </div>
      </Flex>
    </Card>
  );
}

function SelectPage() {
  const { message } = App.useApp();
  const [checkedIds, setCheckedIds] = useState(restoreSelection);
  const [revision, setRevision] = useState(DATA.decisionRevision);
  const [confirmedFeedback, setConfirmedFeedback] = useState({ ...DATA.scoreFeedbackById });
  const [rowStates, setRowStates] = useState({});
  const [submitting, setSubmitting] = useState(false);
  const [done, setDone] = useState(false);

  const checked = new Set(checkedIds);
  const count = checkedIds.length;

  function toggleItem(id, next) {
    const ids = next ? [...checkedIds, id] : checkedIds.filter((x) => x !== id);
    setCheckedIds(ids);
    saveSelection(ids);
  }
  function selectAll() {
    const ids = DATA.curatedItems.map((it) => it.id);
    setCheckedIds(ids);
    saveSelection(ids);
  }
  function selectNone() {
    setCheckedIds([]);
    saveSelection([]);
  }
  async function sendFeedback(itemId, direction) {
    setRowStates((prev) => ({ ...prev, [itemId]: { saving: true, status: '保存中…', error: '' } }));
    try {
      const res = await fetch(DATA.serverOrigin+'/feedback', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: DATA.date,
          runId: DATA.runId,
          curationRevision: DATA.curationRevision,
          revision,
          itemId,
          direction,
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      setRevision(data.decision.revision);
      setConfirmedFeedback({ ...data.decision.scoreFeedbackById });
      const saved = data.decision.scoreFeedbackById[itemId];
      setRowStates((prev) => ({ ...prev, [itemId]: { saving: false, status: saved ? '已保存' : '已撤销', error: '' } }));
    } catch (err) {
      setRowStates((prev) => ({ ...prev, [itemId]: { saving: false, status: '', error: err.message } }));
    }
  }
  async function confirmSelection() {
    if (count === 0) { message.error('未选择任何条目'); return; }
    setSubmitting(true);
    try {
      const res = await fetch(DATA.serverOrigin+'/select', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          date: DATA.date,
          runId: DATA.runId,
          curationRevision: DATA.curationRevision,
          revision,
          selectedIds: DATA.curatedItems.filter((it) => checked.has(it.id)).map((it) => it.id),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) throw new Error(data.error || ('HTTP ' + res.status));
      setDone(true);
      message.success('✓ 已保存 ' + data.count + ' 条选择，可以关闭页面并回到终端。');
      try { localStorage.removeItem(STORE_KEY); } catch (e) { /* best-effort cache */ }
    } catch (err) {
      message.error('提交失败：' + err.message + '（服务器可能已关闭，请重新运行 select）');
    } finally {
      setSubmitting(false);
    }
  }

  const countNode = count > DATA.targetMax
    ? <Text type="danger" strong>{count}</Text>
    : count >= DATA.targetMin
      ? <Text type="success" strong>{count}</Text>
      : <Text strong>{count}</Text>;

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Content className="select-page">
        <Title level={3} style={{ marginTop: 8 }}>AI 日刊选择 · {DATA.date}</Title>
        <Paragraph type="secondary">勾选要发布的条目，建议选 {TARGET} 条，然后点「确认发布」。</Paragraph>
        {DATA.collectionWarnings.length > 0 && (
          <Alert
            type="warning"
            showIcon
            message="采集告警"
            description={DATA.collectionWarnings.join('；')}
            style={{ marginBottom: 8 }}
          />
        )}
        {unknownCategoryItems.length > 0 && (
          <Alert
            type="error"
            showIcon
            message="存在未知分类的条目，未显示在下方列表"
            description={unknownCategoryItems.map((it) => it.id + ' → ' + it.category).join('；')}
            style={{ marginBottom: 8 }}
          />
        )}
        {CATS.map((cat) => {
          const list = byCat[cat];
          if (!list || list.length === 0) return null;
          return (
            <section key={cat}>
              <Flex justify="space-between" align="baseline" style={{ marginTop: 24 }}>
                <Title level={5} style={{ margin: 0 }}>{cat}</Title>
                <Text type="secondary">{list.length} 条</Text>
              </Flex>
              <Divider style={{ margin: '8px 0 12px' }} />
              {list.map((it) => (
                <ItemCard
                  key={it.id}
                  item={it}
                  checked={checked.has(it.id)}
                  disabled={done}
                  activeDirection={confirmedFeedback[it.id]?.direction}
                  rowState={rowStates[it.id] || {}}
                  onToggle={toggleItem}
                  onFeedback={sendFeedback}
                />
              ))}
            </section>
          );
        })}
      </Content>
      <Footer className="select-action-bar">
        <Space size={12} wrap align="center">
          <span>已选 {countNode} / {TARGET}</span>
          <Button disabled={done} onClick={selectAll}>全选</Button>
          <Button disabled={done} onClick={selectNone}>清空</Button>
          <Button id="confirm" type="primary" disabled={submitting || done} onClick={confirmSelection}>确认发布</Button>
        </Space>
      </Footer>
    </Layout>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<RootApp />);
</script>
</body>
</html>`;
}

// ───────────────────────── command handlers ─────────────────────────

function formatRejectionCounts(diagnostics) {
  if (!diagnostics?.rejectionCounts) return 'none';
  const parts = Object.entries(diagnostics.rejectionCounts)
    .filter(([, count]) => count > 0)
    .map(([reason, count]) => `${reason}=${count}`);
  return parts.length > 0 ? parts.join(', ') : 'none';
}

export async function runStatus({ pipeline, repoRoot, log }) {
  const draft = await pipeline.draftModule.readPendingDraft();
  if (!draft || !draft.items?.length) {
    return ['daily-news status', 'No pending draft.', 'Next action: run `collect`.'].join('\n');
  }
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const state = await pipeline.stateModule.readState();
  const out = join(repoRoot, 'output');
  const files = {
    'curate-input.json': existsSync(join(out, `${date}-curate-input.json`)),
    'ranking.json': existsSync(join(out, `${date}-ranking.json`)),
    'curate-output.json': existsSync(join(out, `${date}-curate-output.json`)),
    'curation.json': existsSync(join(out, `${date}-curation.json`)),
    'select.html': existsSync(join(out, `${date}-select.html`)),
    'selection-decision.json': existsSync(join(out, `${date}-selection-decision.json`)),
    'selection-report.json': existsSync(join(out, `${date}-selection-report.json`)),
    'feedback-review.json': existsSync(join(out, `${date}-feedback-review.json`)),
    'feedback-adjustment.json': existsSync(join(out, `${date}-feedback-adjustment.json`)),
  };

  let next;
  if (!files['curate-input.json']) {
    next = 'run `curate-input`';
  } else if (!files['curate-output.json']) {
    next = 'agent curates (read curate-input.json → write curate-output.json), then run `curate-apply`';
  } else if (!files['curation.json']) {
    next = 'run `curate-apply`';
  } else if (!files['selection-decision.json']) {
    next = 'run `select`, open the URL, choose items, add optional score feedback, confirm';
  } else {
    next = 'run `publish`';
  }

  const lines = [
    'daily-news status',
    `Date: ${date}`,
    `Draft items: ${draft.items.length}`,
    `Collected at: ${new Date(draft.collectedAt * 1000).toISOString()}`,
    `Enabled sources: ${draft.enabledSources.join(', ') || '<none>'}`,
    `State lastPublished: ${pipeline.sourceRegistryModule.formatPublishedCursorStatus(state)}`,
    '',
    'Stage artifacts:',
    ...Object.entries(files).map(([name, ok]) => `  ${ok ? '✓' : '✗'} ${name}`),
    '',
    `Next action: ${next}`,
  ];
  return lines.join('\n');
}

function resolveCollectNowSeconds(env = process.env) {
  const raw = env.DAILY_NEWS_COLLECT_NOW_SECONDS;
  if (!raw) return undefined;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`Invalid DAILY_NEWS_COLLECT_NOW_SECONDS: ${raw}`);
  }
  return parsed;
}

async function runCollect({ pipeline, args, log, env = process.env }) {
  const existing = await pipeline.draftModule.readPendingDraft();

  if (existing && !args.discard) {
    if (args.resume) {
      const date = formatDateFromUnixSeconds(existing.collectedAt);
      return `daily-news collect: resumed existing draft (date=${date}, items=${existing.items.length}).`;
    }
    const date = formatDateFromUnixSeconds(existing.collectedAt);
    return [
      'daily-news collect: PENDING_DRAFT_EXISTS',
      `  date=${date}, items=${existing.items.length}, collectedAt=${existing.collectedAt}`,
      '  Ask the user how to proceed, then re-run:',
      '    --resume   keep this draft and continue the pipeline',
      '    --discard  delete this draft and collect fresh',
    ].join('\n');
  }

  if (existing && args.discard) {
    await pipeline.draftModule.clearPendingDraft();
    log('[daily-news-agent] discarded existing draft');
  }

  const publishedState = await pipeline.stateModule.readState();
  const snapshot = await pipeline.collectModule.collect(publishedState, resolveCollectNowSeconds(env));
  if (!snapshot.items || snapshot.items.length === 0) {
    throw new Error('daily-news collect returned zero items');
  }
  await pipeline.draftModule.writePendingDraft(snapshot);

  const date = formatDateFromUnixSeconds(snapshot.collectedAt);
  return [
    'daily-news collect: complete',
    `Date: ${date}`,
    `Items: ${snapshot.items.length}`,
    `Sources: ${(snapshot.enabledSources || []).join(', ') || '<none>'}`,
    ...(snapshot.collectionWarnings?.length ? [`Warnings: ${snapshot.collectionWarnings.join('; ')}`] : []),
    'Next action: run `curate-input`, then curate.',
  ].join('\n');
}

async function runCurateInput({ pipeline, repoRoot, env, log }) {
  const draft = await readDraftOrFail(pipeline);
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const poolSize = Number(env.DAILY_NEWS_CURATE_POOL ?? DEFAULT_CURATE_POOL);
  if (!Number.isFinite(poolSize) || poolSize <= 0) {
    throw new Error(`Invalid DAILY_NEWS_CURATE_POOL: ${env.DAILY_NEWS_CURATE_POOL}`);
  }

  const preferenceRules = pipeline.preferencesModule.readConfirmedPreferenceRules();
  const ranked = pipeline.rankModule.rankItems(draft.items, preferenceRules);
  const candidate = pipeline.rankModule.selectCandidatePool(ranked);
  const merged = mergeForcedSelectItems(candidate, ranked);
  const pool = trimCandidatePool(merged, poolSize);
  if (pool.length === 0) {
    throw new Error('curate-input produced zero candidates (all items hard-filtered?).');
  }

  const ranking = buildAgentRankingArtifact({
    draft,
    rankedItems: ranked,
    candidateItems: pool,
    date,
    policyRevision: preferenceRules.policyRevision ?? 1,
    createRunId: pipeline.artifactIdentityModule.createRunId,
    featureVersion: pipeline.artifactIdentityModule.FEATURE_VERSION,
  });
  await pipeline.rankingArtifactModule.writeRankingArtifact(ranking, join(repoRoot, 'output'));

  const payload = {
    date,
    runId: ranking.runId,
    collectedAt: draft.collectedAt,
    enabledSources: draft.enabledSources,
    ...(draft.collectionWarnings?.length ? { collectionWarnings: draft.collectionWarnings } : {}),
    poolSize,
    candidateCount: pool.length,
    candidateItems: pool,
  };
  const inputPath = artifactPath(repoRoot, date, 'curate-input.json');
  await writeJson(inputPath, payload);

  return [
    'daily-news curate-input: complete',
    `Date: ${date}`,
    `Candidate pool: ${pool.length} (cap ${poolSize}, draft had ${draft.items.length} items)`,
    `Curate input: ${inputPath}`,
    'Next action: agent curates → write output/<date>-curate-output.json → run `curate-apply`.',
  ].join('\n');
}

async function runCurateApply({ pipeline, repoRoot, log }) {
  const draft = await readDraftOrFail(pipeline);
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const inputPath = artifactPath(repoRoot, date, 'curate-input.json');
  const outputPath = artifactPath(repoRoot, date, 'curate-output.json');

  if (!existsSync(inputPath)) {
    throw new Error(`Missing ${inputPath}. Run \`curate-input\` first.`);
  }
  if (!existsSync(outputPath)) {
    throw new Error(
      `Missing ${outputPath}. The agent must curate first: read curate-input.json, then write curate-output.json as { items: [{ id, title, summary, url, author, category, editorialReason }] }.`,
    );
  }

  const input = await readJson(inputPath);
  const output = await readJson(outputPath);
  const llmItems = validateCurateOutput(output);

  const result = pipeline.curateModule.enrichCuratedItemsWithDiagnostics(llmItems, input.candidateItems);
  if (!result.items || result.items.length === 0) {
    throw new Error(
      `curate-apply produced zero curated items; diagnostics: ${pipeline.curateModule.formatCurationDiagnosticsSummary(result.diagnostics)}`,
    );
  }

  const rankingPath = artifactPath(repoRoot, date, 'ranking.json');
  if (!existsSync(rankingPath)) throw new Error(`Missing ${rankingPath}. Run \`curate-input\` first.`);
  const ranking = pipeline.rankingArtifactModule.decodeRankingArtifact(await readJson(rankingPath));
  if (input.runId !== ranking.runId) throw new Error('curate-input and ranking runId mismatch');
  const curation = pipeline.curationArtifactModule.createCurationArtifact({
    ranking,
    curatedItems: result.items,
    collectionWarnings: input.collectionWarnings,
    curationDiagnostics: result.diagnostics,
  });
  const curationPath = await pipeline.curationArtifactModule.writeCurationArtifact(curation, join(repoRoot, 'output'));

  return [
    'daily-news curate-apply: complete',
    `Date: ${date}`,
    `Curated items: ${result.items.length}`,
    `Rejected: ${result.diagnostics.rejectedCount} (${formatRejectionCounts(result.diagnostics)})`,
    `Curation: ${curationPath}`,
    'Next action: run `select`.',
  ].join('\n');
}

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', reject);
  });
}

export function resolveSelectPort(env = process.env) {
  const raw = env.DAILY_NEWS_SELECT_PORT;
  const port = raw === undefined || raw === null || raw === '' ? DEFAULT_SELECT_PORT : Number(raw);
  if (!Number.isFinite(port) || port < 1 || port > 65535 || !Number.isInteger(port)) {
    throw new Error(`Invalid DAILY_NEWS_SELECT_PORT: ${String(raw)}`);
  }
  return port;
}

export function probeHealth(port) {
  // Direct loopback HTTP — never `fetch`. applyProxyFromEnv installs a global
  // dispatcher that honors HTTP_PROXY; an empty NO_PROXY would send this probe
  // through Surge and make a healthy select server look dead.
  return new Promise((resolve) => {
    const req = http.get({
      host: '127.0.0.1',
      port,
      path: '/health',
      timeout: 1000,
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        try {
          const data = JSON.parse(Buffer.concat(chunks).toString('utf-8'));
          resolve(res.statusCode === 200 && data.ok === true);
        } catch {
          resolve(false);
        }
      });
    });
    req.on('error', () => resolve(false));
    req.on('timeout', () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function waitForSelectHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probeHealth(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
}

function isPortTaken(port) {
  return new Promise((resolve) => {
    const tester = net.createServer();
    tester.once('error', () => resolve(true));
    tester.once('listening', () => tester.close(() => resolve(false)));
    tester.listen(port, '127.0.0.1');
  });
}

function isPidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code !== 'ESRCH';
  }
}

async function stopPid(pid) {
  // Graceful SIGTERM (the select server closes + exits on SIGTERM), then SIGKILL if still alive.
  if (!Number.isFinite(pid) || pid <= 0) return false;
  if (!isPidAlive(pid)) return false;
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    throw error;
  }
  for (let i = 0; i < 10; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100));
    if (!isPidAlive(pid)) return true;
  }
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (error.code === 'ESRCH') return true;
    throw error;
  }
  await new Promise((resolve) => setTimeout(resolve, 200));
  return !isPidAlive(pid);
}

function openInBrowser(url, log) {
  // The select server opens the page itself on listen; disable for headless/CI/testing.
  if (process.env.DAILY_NEWS_SELECT_OPEN_BROWSER === '0') {
    log(`[daily-news-agent] browser auto-open disabled (DAILY_NEWS_SELECT_OPEN_BROWSER=0): ${url}`);
    return;
  }
  let cmd;
  let args;
  if (process.platform === 'darwin') {
    cmd = 'open';
    args = [url];
  } else if (process.platform === 'win32') {
    cmd = 'cmd';
    args = ['/c', 'start', '', url];
  } else {
    cmd = 'xdg-open';
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { detached: true, stdio: 'ignore' });
    child.unref();
    child.on('spawn', () => log(`[daily-news-agent] opened default browser: ${url}`));
    child.on('error', (error) =>
      log(`[daily-news-agent] could not auto-open browser (${cmd}): ${error instanceof Error ? error.message : String(error)}`),
    );
  } catch (error) {
    log(`[daily-news-agent] could not auto-open browser (${cmd}): ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function findMostRecentSelectPid(repoRoot) {
  // After publish the draft is cleared, so cleanup locates the latest output/*-select.pid by date.
  const dir = join(repoRoot, 'output');
  if (!existsSync(dir)) return null;
  const entries = await readdir(dir);
  const matches = entries
    .map((name) => name.match(/^(\d{4}-\d{2}-\d{2})-select\.pid$/))
    .filter(Boolean)
    .sort((a, b) => a[1].localeCompare(b[1]));
  if (matches.length === 0) return null;
  const latest = matches[matches.length - 1];
  return { date: latest[1], path: join(dir, `${latest[1]}-select.pid`) };
}

async function runSelect({ pipeline, repoRoot, args, log, env = process.env }) {
  const draft = await readDraftOrFail(pipeline);
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const curationPath = artifactPath(repoRoot, date, 'curation.json');
  const selectionPath = artifactPath(repoRoot, date, 'selection.json');
  const decisionPath = artifactPath(repoRoot, date, 'selection-decision.json');
  const htmlPath = artifactPath(repoRoot, date, 'select.html');

  if (!existsSync(curationPath)) {
    throw new Error(`Missing ${curationPath}. Run \`curate-apply\` first.`);
  }
  if (existsSync(selectionPath) && existsSync(decisionPath) && !args.force) {
    return [
      'daily-news select: selection already exists',
      `Selection: ${decisionPath}`,
      'Re-run with --force to discard it and choose again.',
      'Next action: run `publish`.',
    ].join('\n');
  }

  const curation = pipeline.curationArtifactModule.decodeCurationArtifact(await readJson(curationPath));
  if (curation.curatedItems.length === 0) throw new Error(`${curationPath} has no curated items.`);
  const decisionStore = new pipeline.selectionDecisionStoreModule.SelectionDecisionStore(decisionPath, curation);
  const initialDecision = await decisionStore.initialize(new Date().toISOString());

  await new Promise((resolve, reject) => {
    const server = http.createServer(async (req, res) => {
      try {
        const url = new URL(req.url, 'http://127.0.0.1');
        if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
          return;
        }
        if (req.method === 'GET' && url.pathname === '/health') {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === 'POST' && url.pathname === '/feedback') {
          let payload;
          try { payload = JSON.parse(await readRequestBody(req)); }
          catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' })); return;
          }
          if (payload.date !== curation.date || payload.runId !== curation.runId ||
              payload.curationRevision !== curation.curationRevision) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'feedback identity mismatch' })); return;
          }
          if (payload.direction !== 'too_high' && payload.direction !== 'too_low') {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid feedback direction' })); return;
          }
          try {
            const decision = await decisionStore.update((current) =>
              pipeline.selectionDecisionModule.updateScoreFeedback(current, {
                itemId: payload.itemId, direction: payload.direction, updatedAt: new Date().toISOString(),
              }, curation));
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, decision })); return;
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })); return;
          }
        }
        if (req.method === 'POST' && url.pathname === '/select') {          let payload;
          try {
            payload = JSON.parse(await readRequestBody(req));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
            return;
          }
          try {
            if (payload.date !== curation.date || payload.runId !== curation.runId ||
                payload.curationRevision !== curation.curationRevision) throw new Error('selection identity mismatch');
            const decision = await decisionStore.update((current) =>
              pipeline.selectionDecisionModule.confirmSelection(
                current, payload.selectedIds, curation, new Date().toISOString()));
            const selected = pipeline.selectionDecisionModule.resolveSelectedItems(decision, curation);
            await writeJson(selectionPath, { date, selectedItems: selected });
            log(`[daily-news-agent] selection saved: ${selected.length} items → ${decisionPath}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: selected.length, path: decisionPath, decision }));
            setTimeout(() => {
              server.close();
              process.exit(0);
            }, 200);
            return;
          } catch (error) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
            return;
          }
        }
        res.writeHead(404, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: 'not found' }));
      } catch (error) {
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
      }
    });

    let html = '';
    const desiredPort = resolveSelectPort(env);
    const origin = `http://127.0.0.1:${desiredPort}`;

    server.on('error', async (err) => {
      // Port already taken. If it's one of our own select servers, reuse it — it will write the
      // selection file on confirm and the agent's poll will pick that up. Otherwise fail loud.
      if (err && err.code === 'EADDRINUSE' && (await probeHealth(desiredPort))) {
        server.close();
        log(`SELECT_URL=${origin}/ (reusing already-running select server on port ${desiredPort})`);
        log(`SELECTION_FILE=${selectionPath}`);
        log('STATUS=waiting — a select server is already running. Open the URL and click 确认发布.');
        resolve();
        return;
      }
      reject(err);
    });
    server.listen(desiredPort, '127.0.0.1', () => {
      html = buildSelectHtml(curation, origin, initialDecision);
      // Persist a static copy as an audit trail / file:// fallback (raw HTML, not JSON).
      mkdir(dirname(htmlPath), { recursive: true })
        .then(() => writeFile(htmlPath, html, 'utf-8'))
        .catch(() => {});
      log(`SELECT_URL=${origin}/`);
      log(`SELECT_HTML=${htmlPath}`);
      log(`SELECTION_FILE=${decisionPath}`);
      log('STATUS=waiting — open the URL, choose 6-10 items, add optional score feedback, then click 确认发布.');
      openInBrowser(`${origin}/`, log);
    });

    const shutdown = (signal) => {
      log(`[daily-news-agent] select interrupted (${signal}); no selection written.`);
      server.close();
      process.exit(130);
    };
    process.once('SIGINT', () => shutdown('SIGINT'));
    process.once('SIGTERM', () => shutdown('SIGTERM'));
  });

  // Reached only when a confirm was short-circuited in tests, or in the reuse path (another select
  // server was already running on this port and will write the file on confirm).
  return `daily-news select: waiting for confirm; selection will be written to ${decisionPath}`;
}

async function runSelectStart({ pipeline, repoRoot, args, log, env = process.env }) {
  const draft = await readDraftOrFail(pipeline);
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const curationPath = artifactPath(repoRoot, date, 'curation.json');
  const selectionPath = artifactPath(repoRoot, date, 'selection.json');
  const decisionPath = artifactPath(repoRoot, date, 'selection-decision.json');
  const htmlPath = artifactPath(repoRoot, date, 'select.html');
  const pidPath = artifactPath(repoRoot, date, 'select.pid');
  const logPath = artifactPath(repoRoot, date, 'select.log');
  const port = resolveSelectPort(env);
  const origin = `http://127.0.0.1:${port}`;

  if (!existsSync(curationPath)) {
    throw new Error(`Missing ${curationPath}. Run \`curate-apply\` first.`);
  }
  const existingDecision = existsSync(decisionPath)
    ? pipeline.selectionDecisionModule.decodeSelectionDecision(await readJson(decisionPath)) : null;
  if (existingDecision?.selection.status === 'confirmed' && !args.force) {
    return [
      'daily-news select-start: selection already exists',
      `Selection: ${decisionPath}`,
      'Re-run with --force to discard it and choose again.',
      'Next action: run `publish` (then `select-stop` if a server is still running).',
    ].join('\n');
  }

  // Reuse an already-running select server (no fresh bind -> open the browser here).
  if (await probeHealth(port)) {
    openInBrowser(`${origin}/`, log);
    return [
      'daily-news select-start: a select server is already running (reused).',
      `SELECT_URL=${origin}/`,
      `SELECTION_FILE=${decisionPath}`,
      'Choose 6-10 items, add optional score feedback, and click 确认发布. The agent is NOT blocking.',
    ].join('\n');
  }

  // Port held by something that isn't our select server -> fail loud instead of hanging on health.
  if (await isPortTaken(port)) {
    throw new Error(
      `Port ${port} is in use by a non-select process. Free it or set DAILY_NEWS_SELECT_PORT.`,
    );
  }

  const selectArgs = ['select'];
  if (args.force) selectArgs.push('--force');
  const tsxPath = loadTsxPath(repoRoot);
  const runtimePath = fileURLToPath(import.meta.url);
  await mkdir(dirname(logPath), { recursive: true });
  const logFd = openSync(logPath, 'w');
  // detached:true puts the child in a new session (it survives the agent's turn ending and any
  // SIGTERM to the agent's own process group); unref() lets this parent exit without waiting.
  const child = spawn(
    process.execPath,
    ['--import', tsxPath, runtimePath, ...selectArgs],
    { cwd: repoRoot, env: { ...env, DAILY_NEWS_REPO: repoRoot }, detached: true, stdio: ['ignore', logFd, logFd] },
  );
  child.unref();
  await writeFile(pidPath, String(child.pid));

  // The detached server opens the browser itself on listen; here we just wait for it to bind.
  const ready = await waitForSelectHealth(port, 20000);
  if (!ready) {
    await stopPid(child.pid).catch(() => {});
    await rm(pidPath, { force: true });
    throw new Error(`select server did not become healthy on port ${port}; see ${logPath}`);
  }

  return [
    'daily-news select-start: detached select server launched (browser opens automatically).',
    `SELECT_URL=${origin}/`,
    `SELECT_HTML=${htmlPath}`,
    `SELECTION_FILE=${decisionPath}`,
    `SERVER_PID_FILE=${pidPath}`,
    `SERVER_LOG=${logPath}`,
    'The agent is NOT blocking. Tell the user to choose 6-10 items and click 确认发布, then to tell',
    'you to publish. After publish, run `select-stop` to clean up the detached server.',
  ].join('\n');
}

async function runSelectStop({ pipeline, repoRoot, log }) {
  let pidPath = null;
  // Prefer the current draft's pidfile; fall back to the most recent output/*-select.pid, because
  // the draft is cleared after publish and cleanup typically runs in that state.
  try {
    const draft = await pipeline.draftModule.readPendingDraft();
    if (draft) {
      pidPath = artifactPath(repoRoot, formatDateFromUnixSeconds(draft.collectedAt), 'select.pid');
    }
  } catch {
    // ignore — fall through to the scan
  }
  if (!pidPath || !existsSync(pidPath)) {
    const found = await findMostRecentSelectPid(repoRoot);
    if (!found) {
      return 'daily-news select-stop: no output/*-select.pid found; nothing to stop.';
    }
    pidPath = found.path;
  }

  let pid = NaN;
  try {
    pid = parseInt((await readFile(pidPath, 'utf-8')).trim(), 10);
  } catch {
    pid = NaN;
  }
  let outcome;
  if (Number.isFinite(pid) && pid > 0) {
    try {
      const stopped = await stopPid(pid);
      outcome = stopped
        ? `stopped detached select server (pid ${pid})`
        : `server pid ${pid} was already gone`;
    } catch (error) {
      outcome = `error stopping pid ${pid}: ${error instanceof Error ? error.message : String(error)}`;
    }
  } else {
    outcome = `no valid pid in ${pidPath}`;
  }
  await rm(pidPath, { force: true });
  return ['daily-news select-stop: ' + outcome, `removed ${pidPath}`].join('\n');
}

export async function runPublish({ pipeline, repoRoot, log }) {
  const draft = await readDraftOrFail(pipeline);
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const rankingPath = artifactPath(repoRoot, date, 'ranking.json');
  const curationPath = artifactPath(repoRoot, date, 'curation.json');
  const decisionPath = artifactPath(repoRoot, date, 'selection-decision.json');
  for (const path of [rankingPath, curationPath, decisionPath]) {
    if (!existsSync(path)) throw new Error(`Missing ${path}. Complete curate and select first.`);
  }

  const ranking = pipeline.rankingArtifactModule.decodeRankingArtifact(await readJson(rankingPath));
  const curation = pipeline.curationArtifactModule.decodeCurationArtifact(await readJson(curationPath));
  const decision = pipeline.selectionDecisionModule.decodeSelectionDecision(await readJson(decisionPath));
  const reviewPath = artifactPath(repoRoot, date, 'feedback-review.json');
  const historyPath = join(repoRoot, 'data', 'score-feedback-history.jsonl');
  const result = await pipeline.publicationWorkflowModule.finalizePublication(
    { draft, ranking, curation, decision },
    {
      readState: pipeline.stateModule.readState,
      writePublicationOutputs: (formatted, report) => pipeline.publishModule.publish(formatted, report),
      recordSelectionHistory: (report) => pipeline.preferencesModule.recordPreferenceHistoryFromSelectionReport(
        report, { reportPath: `output/${date}-selection-report.json`, runId: report.runId }),
      recordScoreFeedbackHistory: (events) =>
        pipeline.scoreFeedbackHistoryModule.appendScoreFeedbackHistoryIdempotently(events, historyPath),
      writeFeedbackReview: (review) => writeJson(reviewPath, review),
      writeState: pipeline.stateModule.writeState,
      clearDraft: pipeline.draftModule.clearPendingDraft,
    },
  );

  return [
    'daily-news publish: complete',
    `Date: ${date}`,
    `Selected items: ${result.selectedItems.length}`,
    `Substack draft: output/${date}-substack.html`,
    `Selection report: output/${date}-selection-report.json`,
    result.feedbackCount === 0
      ? '本期无评分反馈'
      : `Feedback review: output/${date}-feedback-review.json`,
    'State advanced and pending draft cleared.',
  ].join('\n');
}

async function runFeedbackApply({ pipeline, date }) {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    throw new Error('feedback-apply requires --date=YYYY-MM-DD');
  }
  const parsed = pipeline.feedbackCliModule.parseFeedbackCliArgs(['apply', `--date=${date}`]);
  const result = await pipeline.feedbackCliModule.runFeedbackApply(parsed);
  return `daily-news feedback-apply: ${result.status} (policyRevision=${result.policyRevision})`;
}

async function runDiagnose({ pipeline }) {
  await pipeline.envDiagnosticsModule.logEnvironmentDiagnostics();
  await pipeline.collectModule.diagnoseCollectEnvironment();
  return 'daily-news diagnose completed';
}

// ───────────────────────── dispatch ─────────────────────────

export async function runAgent({
  command = 'status',
  resume = false,
  discard = false,
  force = false,
  date,
  repoRoot = resolveRepoRoot(),
  env = process.env,
  log = console.log,
} = {}) {
  const preflight = await validatePreflight({ repoRoot, env });
  assertPreflightReady(preflight);

  if (command === 'preflight') {
    return JSON.stringify(preflight, null, 2);
  }

  process.chdir(repoRoot);
  loadRepoEnv(repoRoot);
  const pipeline = await loadPipeline(repoRoot);
  pipeline.proxyModule.applyProxyFromEnv();

  const args = { resume, discard, force, date };

  switch (command) {
    case 'diagnose':
      return runDiagnose({ pipeline });
    case 'status':
      return runStatus({ pipeline, repoRoot, log });
    case 'collect':
      return runCollect({ pipeline, args, log });
    case 'curate-input':
      return runCurateInput({ pipeline, repoRoot, env, log });
    case 'curate-apply':
      return runCurateApply({ pipeline, repoRoot, log });
    case 'select':
      return runSelect({ pipeline, repoRoot, args, log, env });
    case 'select-start':
      return runSelectStart({ pipeline, repoRoot, args, log, env });
    case 'select-stop':
      return runSelectStop({ pipeline, repoRoot, log });
    case 'publish':
      return runPublish({ pipeline, repoRoot, log });
    case 'feedback-apply':
      return runFeedbackApply({ pipeline, date });
    default:
      throw new Error(`Unsupported daily-news agent command: ${command}`);
  }
}

export async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (parsed.command === 'help') {
    printUsage();
    return;
  }

  const repoRoot = resolveRepoRoot();
  const result = await runAgent({
    command: parsed.command,
    resume: parsed.resume,
    discard: parsed.discard,
    force: parsed.force,
    date: parsed.date,
    repoRoot,
  });
  if (result) console.log(result);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
