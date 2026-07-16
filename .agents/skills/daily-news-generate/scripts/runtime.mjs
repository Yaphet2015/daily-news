import { createRequire } from 'node:module';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import http from 'node:http';

const DEFAULT_REPO_ROOT = '/Users/suosuo/workspace/personal/daily-news';
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
  'collect',
  'curate',
  'draft',
  'envDiagnostics',
  'format',
  'preferences',
  'proxy',
  'publish',
  'rank',
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
  'publish',
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
  select [--force]     Serve an interactive HTML page on a stable local port and block until the
                       user confirms, writing output/<date>-selection.json. Selections persist in
                       the browser across reloads. Idempotent unless --force.
  publish              Format the selection, publish files, advance state, clear the draft.

Default command: status. Set DAILY_NEWS_REPO to override the daily-news repo path.
Env: DAILY_NEWS_SELECT_PORT (default 8427) pins the select server port.
     DAILY_NEWS_COLLECT_NOW_SECONDS overrides the collection cutoff Unix timestamp.`);
}

function hasHelp(args) {
  return args.includes('--help') || args.includes('-h');
}

export function parseCliArgs(args) {
  if (hasHelp(args)) return { command: 'help' };
  const positional = args.filter((arg) => !arg.startsWith('-'));
  const command = positional[0] ?? 'status';
  if (!VALID_COMMANDS.has(command)) {
    throw new Error(`Unsupported daily-news agent command: ${command}`);
  }
  return {
    command,
    resume: args.includes('--resume'),
    discard: args.includes('--discard'),
    force: args.includes('--force'),
  };
}

export function resolveRepoRoot({ cwd = process.cwd(), env = process.env } = {}) {
  if (env.DAILY_NEWS_REPO?.trim()) {
    return resolve(cwd, env.DAILY_NEWS_REPO.trim());
  }
  return DEFAULT_REPO_ROOT;
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
    collectModule,
    curateModule,
    draftModule,
    envDiagnosticsModule,
    formatModule,
    preferencesModule,
    proxyModule,
    publishModule,
    rankModule,
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
    stateModule,
  };
}

// ───────────────────────── deterministic helpers (no LLM) ─────────────────────────

export function formatDateFromUnixSeconds(unixSeconds) {
  return new Date(unixSeconds * 1000).toISOString().slice(0, 10);
}

export function advancePublishedState(state, sources, collectedAt) {
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

export function annotateRankedItems(rankedItems, candidateItems, curatedItems, selectedItems) {
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

export function buildSelectionReport({
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

export function buildSelectHtml(curation, serverOrigin) {
  const date = curation.date;
  const target = `${DEFAULT_SELECT_TARGET_MIN}-${DEFAULT_SELECT_TARGET_MAX}`;
  // Escape so the JSON is safe inside <script> (handles </script>, U+2028/2029, etc.).
  const dataJson = JSON.stringify({
    date,
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
<style>
  :root {
    --bg: #ffffff; --fg: #1a1a1a; --muted: #6b7280; --card: #f7f7f8; --border: #e5e7eb;
    --accent: #2563eb; --accent-fg: #ffffff; --warn: #b45309; --ok: #047857; --bad: #b91c1c;
  }
  @media (prefers-color-scheme: dark) {
    :root { --bg:#0f1115; --fg:#e6e6e6; --muted:#9aa3af; --card:#171a21; --border:#272b33; --accent:#60a5fa; --accent-fg:#061020; }
  }
  * { box-sizing: border-box; }
  body { margin:0; background:var(--bg); color:var(--fg);
    font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"PingFang SC","Microsoft YaHei",sans-serif;
    line-height:1.6; padding:1rem 1rem 9rem; }
  header { max-width:920px; margin:0 auto 1rem; }
  header h1 { font-size:1.4rem; margin:0 0 .25rem; }
  header .sub { color:var(--muted); font-size:.95rem; }
  .warn { background:#fef3c7; color:var(--warn); border:1px solid #fcd34d; border-radius:8px; padding:.6rem .8rem; margin:.6rem 0; }
  @media (prefers-color-scheme: dark){ .warn{ background:#3a2f12; border-color:#5a4a1a; } }
  main { max-width:920px; margin:0 auto; }
  h2.cat { font-size:1.05rem; margin:1.4rem 0 .5rem; padding-bottom:.3rem; border-bottom:1px solid var(--border); display:flex; gap:.6rem; align-items:baseline; }
  h2.cat .count { color:var(--muted); font-weight:400; font-size:.85rem; }
  .item { display:flex; gap:.7rem; background:var(--card); border:1px solid var(--border); border-radius:10px; padding:.7rem .8rem; margin:.5rem 0; }
  .item input[type=checkbox] { width:1.1rem; height:1.1rem; margin-top:.25rem; accent-color:var(--accent); flex:0 0 auto; }
  .item .body { min-width:0; }
  .item .title { font-weight:600; font-size:1rem; }
  .item .summary { color:var(--fg); margin:.25rem 0 .4rem; font-size:.95rem; white-space:pre-wrap; }
  .item .meta { color:var(--muted); font-size:.8rem; display:flex; flex-wrap:wrap; gap:.35rem .7rem; align-items:center; }
  .badge { background:var(--bg); border:1px solid var(--border); border-radius:999px; padding:.05rem .5rem; font-size:.72rem; }
  .badge.src-twitter{ color:#1d9bf0; } .badge.src-substack{ color:#ff6719; }
  .score{ color:var(--accent); font-variant-numeric:tabular-nums; }
  .reason{ color:var(--muted); font-style:italic; }
  .ed{ color:var(--ok); }
  .teaser{ color:var(--warn); }
  a { color:var(--accent); text-decoration:none; word-break:break-all; }
  a:hover{ text-decoration:underline; }
  .thumbs{ display:flex; flex-wrap:wrap; gap:.4rem; margin:.35rem 0; }
  .thumbs img{ width:96px; height:96px; object-fit:cover; border-radius:6px; border:1px solid var(--border); }
  footer { position:fixed; left:0; right:0; bottom:0; background:var(--card); border-top:1px solid var(--border);
    padding:.7rem 1rem; display:flex; gap:.7rem; align-items:center; flex-wrap:wrap; justify-content:center; }
  .count-pill{ font-weight:600; }
  .count-pill.bad{ color:var(--bad); } .count-pill.ok{ color:var(--ok); }
  button { background:var(--accent); color:var(--accent-fg); border:none; border-radius:8px; padding:.55rem 1rem; font-size:.95rem; cursor:pointer; }
  button.ghost{ background:transparent; color:var(--fg); border:1px solid var(--border); }
  button:disabled{ opacity:.55; cursor:not-allowed; }
  .msg{ flex:1 1 100%; text-align:center; min-height:1.2rem; font-size:.9rem; }
  .msg.ok{ color:var(--ok); } .msg.bad{ color:var(--bad); }
</style>
</head>
<body>
<header>
  <h1>AI 日刊选择 · ${date}</h1>
  <div class="sub">勾选要发布的条目，建议选 ${target} 条，然后点「确认发布」。</div>
  <div id="warn"></div>
</header>
<main id="main"></main>
<footer>
  <span>已选 <span id="count" class="count-pill">0</span> / <span id="target">${target}</span></span>
  <button class="ghost" id="all">全选</button>
  <button class="ghost" id="none">清空</button>
  <button id="confirm">确认发布</button>
  <div class="msg" id="msg"></div>
</footer>
<script>
const DATA = ${dataJson};
// Persist the user's ticks across reloads/restarts so an accidental refresh or a server
// restart never loses their selections.
const STORE_KEY = 'daily-news-select-' + DATA.date;
const CATS = ['Product','Tutorial','Opinions/Thoughts'];
const byCat = {};
for (const c of CATS) byCat[c] = [];
for (const it of DATA.curatedItems) (byCat[it.category] || (byCat[it.category]=[])).push(it);
const warn = document.getElementById('warn');
if (DATA.collectionWarnings.length) {
  warn.innerHTML = '<div class="warn"><b>采集告警：</b>' + DATA.collectionWarnings.map(esc).join('；') + '</div>';
}
const main = document.getElementById('main');
for (const cat of CATS) {
  const list = byCat[cat]; if (!list || !list.length) continue;
  const h = document.createElement('h2'); h.className='cat';
  h.innerHTML = '<span>'+esc(cat)+'</span><span class="count">'+list.length+' 条</span>';
  main.appendChild(h);
  for (const it of list) main.appendChild(renderItem(it));
}
function renderItem(it){
  const label = document.createElement('label'); label.className='item';
  const cb = document.createElement('input'); cb.type='checkbox'; cb.value=it.id; cb.dataset.id=it.id;
  cb.addEventListener('change', () => { recount(); saveSelection(); });
  const body = document.createElement('div'); body.className='body';
  const title = document.createElement('div'); title.className='title'; title.textContent = it.title; body.appendChild(title);
  const sum = document.createElement('div'); sum.className='summary'; sum.textContent = it.summary; body.appendChild(sum);
  if (Array.isArray(it.media) && it.media.length){
    const thumbs=document.createElement('div'); thumbs.className='thumbs';
    for (const m of it.media.filter(m=>m.type==='photo').slice(0,4)){
      const img=document.createElement('img'); img.src=m.url; img.alt=it.title; img.loading='lazy'; img.referrerPolicy='no-referrer';
      thumbs.appendChild(img);
    }
    if (thumbs.childNodes.length) body.appendChild(thumbs);
  }
  const meta=document.createElement('div'); meta.className='meta';
  meta.appendChild(chip('badge src-'+esc(it.source), it.source));
  meta.appendChild(textNode(it.attribution || it.author || ''));
  if (typeof it.priorityScore==='number') meta.appendChild(chip('score', '优先级 '+it.priorityScore));
  if (it.threadPartCount) meta.appendChild(chip('', 'thread · '+it.threadPartCount));
  if (it.substackTeaserOnly) meta.appendChild(chip('teaser', '订阅墙/预览'));
  for (const r of (it.decisionReasons||[]).slice(0,3)) meta.appendChild(chip('reason', r));
  if (it.editorialReason) { meta.appendChild(document.createElement('br')); const e=document.createElement('span'); e.className='ed'; e.textContent='编辑理由：'+it.editorialReason; meta.appendChild(e); }
  const links=document.createElement('div'); links.className='meta'; links.style.marginTop='.3rem';
  links.appendChild(link('原帖/来源', it.originUrl || it.url));
  if (it.originUrl && it.originUrl!==it.url) links.appendChild(link('引用', it.url));
  body.appendChild(meta); body.appendChild(links);
  label.appendChild(cb); label.appendChild(body); return label;
}
function chip(cls, txt){ const s=document.createElement('span'); s.className='badge '+cls; s.textContent=txt; return s; }
function textNode(t){ if(!t) return document.createElement('span'); return chip('', t); }
function link(label, href){ const a=document.createElement('a'); a.href=href; a.target='_blank'; a.rel='noopener noreferrer'; a.textContent=label; a.style.marginRight='.7rem'; return a; }
function esc(s){ return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c])); }
function recount(){
  const n=document.querySelectorAll('input[type=checkbox]:checked').length;
  const el=document.getElementById('count'); el.textContent=n;
  el.classList.remove('ok','bad');
  if (n>=DATA.targetMin && n<=DATA.targetMax) el.classList.add('ok');
  else if (n>DATA.targetMax) el.classList.add('bad');
}
function checkedIds(){ return [...document.querySelectorAll('input[type=checkbox]:checked')].map(c=>c.dataset.id); }
function saveSelection(){ try { localStorage.setItem(STORE_KEY, JSON.stringify(checkedIds())); } catch(e){} }
function restoreSelection(){
  let ids; try { ids = JSON.parse(localStorage.getItem(STORE_KEY) || '[]'); } catch(e){ return; }
  if (!Array.isArray(ids) || !ids.length) return;
  const set = new Set(ids);
  document.querySelectorAll('input[type=checkbox]').forEach(c=>{ if (set.has(c.dataset.id)) c.checked = true; });
}
document.getElementById('all').addEventListener('click',()=>{ document.querySelectorAll('input[type=checkbox]').forEach(c=>c.checked=true); recount(); saveSelection(); });
document.getElementById('none').addEventListener('click',()=>{ document.querySelectorAll('input[type=checkbox]').forEach(c=>c.checked=false); recount(); saveSelection(); });
document.getElementById('confirm').addEventListener('click', confirm);
async function confirm(){
  const ids=[...document.querySelectorAll('input[type=checkbox]:checked')].map(c=>c.dataset.id);
  const msg=document.getElementById('msg'); msg.className='msg';
  if (ids.length===0){ msg.className='msg bad'; msg.textContent='未选择任何条目'; return; }
  msg.textContent='提交中…'; document.getElementById('confirm').disabled=true;
  try{
    const res=await fetch(DATA.serverOrigin+'/select', {method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({date:DATA.date, selectedIds:ids})});
    const data=await res.json().catch(()=>({}));
    if (!res.ok || !data.ok){ throw new Error(data.error || ('HTTP '+res.status)); }
    msg.className='msg ok'; msg.textContent='✓ 已保存 '+data.count+' 条选择，可以关闭页面并回到终端。';
    document.querySelectorAll('input[type=checkbox]').forEach(c=>c.disabled=true);
    document.getElementById('all').disabled=true; document.getElementById('none').disabled=true;
    try { localStorage.removeItem(STORE_KEY); } catch(e){}
  }catch(err){
    msg.className='msg bad'; msg.textContent='提交失败：'+err.message+'（服务器可能已关闭，请重新运行 select）';
    document.getElementById('confirm').disabled=false;
  }
}
restoreSelection(); recount();
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

async function runStatus({ pipeline, repoRoot, log }) {
  const draft = await pipeline.draftModule.readPendingDraft();
  if (!draft || !draft.items?.length) {
    return ['daily-news status', 'No pending draft.', 'Next action: run `collect`.'].join('\n');
  }
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const state = await pipeline.stateModule.readState();
  const out = join(repoRoot, 'output');
  const files = {
    'curate-input.json': existsSync(join(out, `${date}-curate-input.json`)),
    'curate-output.json': existsSync(join(out, `${date}-curate-output.json`)),
    'curation.json': existsSync(join(out, `${date}-curation.json`)),
    'select.html': existsSync(join(out, `${date}-select.html`)),
    'selection.json': existsSync(join(out, `${date}-selection.json`)),
  };

  let next;
  if (!files['curate-input.json']) {
    next = 'run `curate-input`';
  } else if (!files['curate-output.json']) {
    next = 'agent curates (read curate-input.json → write curate-output.json), then run `curate-apply`';
  } else if (!files['curation.json']) {
    next = 'run `curate-apply`';
  } else if (!files['selection.json']) {
    next = 'run `select`, open the URL, choose items, confirm';
  } else {
    next = 'run `publish`';
  }

  const lines = [
    'daily-news status',
    `Date: ${date}`,
    `Draft items: ${draft.items.length}`,
    `Collected at: ${new Date(draft.collectedAt * 1000).toISOString()}`,
    `Enabled sources: ${draft.enabledSources.join(', ') || '<none>'}`,
    `State lastPublished: twitter=${state.sources.twitter.lastPublishedTime}, substack=${state.sources.substack.lastPublishedTime}`,
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

  const ranked = pipeline.rankModule.rankItems(draft.items, pipeline.preferencesModule.readConfirmedPreferenceRules());
  const candidate = pipeline.rankModule.selectCandidatePool(ranked);
  const merged = mergeForcedSelectItems(candidate, ranked);
  const pool = trimCandidatePool(merged, poolSize);
  if (pool.length === 0) {
    throw new Error('curate-input produced zero candidates (all items hard-filtered?).');
  }

  const payload = {
    date,
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

  const curation = {
    date,
    collectedAt: input.collectedAt ?? draft.collectedAt,
    enabledSources: input.enabledSources ?? draft.enabledSources,
    ...(input.collectionWarnings?.length ? { collectionWarnings: input.collectionWarnings } : {}),
    curatedItems: result.items,
    curationDiagnostics: result.diagnostics,
  };
  const curationPath = artifactPath(repoRoot, date, 'curation.json');
  await writeJson(curationPath, curation);

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

async function probeHealth(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/health`);
    const data = await res.json().catch(() => ({}));
    return res.ok && data.ok === true;
  } catch {
    return false;
  }
}

async function runSelect({ pipeline, repoRoot, args, log, env = process.env }) {
  const draft = await readDraftOrFail(pipeline);
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const curationPath = artifactPath(repoRoot, date, 'curation.json');
  const selectionPath = artifactPath(repoRoot, date, 'selection.json');
  const htmlPath = artifactPath(repoRoot, date, 'select.html');

  if (!existsSync(curationPath)) {
    throw new Error(`Missing ${curationPath}. Run \`curate-apply\` first.`);
  }
  if (existsSync(selectionPath) && !args.force) {
    return [
      'daily-news select: selection already exists',
      `Selection: ${selectionPath}`,
      'Re-run with --force to discard it and choose again.',
      'Next action: run `publish`.',
    ].join('\n');
  }

  const curation = await readJson(curationPath);
  if (!Array.isArray(curation.curatedItems) || curation.curatedItems.length === 0) {
    throw new Error(`${curationPath} has no curated items.`);
  }

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
        if (req.method === 'POST' && url.pathname === '/select') {
          let payload;
          try {
            payload = JSON.parse(await readRequestBody(req));
          } catch {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: false, error: 'invalid JSON body' }));
            return;
          }
          try {
            const selected = resolveSelection(curation, payload.selectedIds);
            if (selected.length === 0) {
              throw new Error('no items selected');
            }
            await writeJson(selectionPath, { date, selectedItems: selected });
            log(`[daily-news-agent] selection saved: ${selected.length} items → ${selectionPath}`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ ok: true, count: selected.length, path: selectionPath }));
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
      html = buildSelectHtml(curation, origin);
      // Persist a static copy as an audit trail / file:// fallback (raw HTML, not JSON).
      mkdir(dirname(htmlPath), { recursive: true })
        .then(() => writeFile(htmlPath, html, 'utf-8'))
        .catch(() => {});
      log(`SELECT_URL=${origin}/`);
      log(`SELECT_HTML=${htmlPath}`);
      log(`SELECTION_FILE=${selectionPath}`);
      log('STATUS=waiting — open the URL, choose 6-10 items, then click 确认发布.');
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
  return `daily-news select: waiting for confirm; selection will be written to ${selectionPath}`;
}

export async function runPublish({ pipeline, repoRoot, log }) {
  const draft = await readDraftOrFail(pipeline);
  const date = formatDateFromUnixSeconds(draft.collectedAt);
  const curationPath = artifactPath(repoRoot, date, 'curation.json');
  const selectionPath = artifactPath(repoRoot, date, 'selection.json');

  if (!existsSync(curationPath)) {
    throw new Error(`Missing ${curationPath}. Run \`curate-apply\` first.`);
  }
  if (!existsSync(selectionPath)) {
    throw new Error(`Missing ${selectionPath}. Run \`select\` and confirm a selection first.`);
  }

  const curation = await readJson(curationPath);
  const selection = await readJson(selectionPath);
  const selectedItems = Array.isArray(selection.selectedItems) ? selection.selectedItems : [];
  if (selectedItems.length === 0) {
    throw new Error(`${selectionPath} has no selectedItems.`);
  }

  const publishedState = await pipeline.stateModule.readState();
  const ranked = pipeline.rankModule.rankItems(draft.items, pipeline.preferencesModule.readConfirmedPreferenceRules());
  const candidateItems = pipeline.rankModule.selectCandidatePool(ranked);

  const formatted = pipeline.formatModule.format(selectedItems, date);
  const report = buildSelectionReport({
    date,
    collectionWarnings: curation.collectionWarnings,
    rankedItems: ranked,
    candidateItems,
    curatedItems: curation.curatedItems,
    selectedItems,
    curationDiagnostics: curation.curationDiagnostics,
  });

  await pipeline.preferencesModule.recordPreferenceHistoryFromSelectionReport(report, {
    reportPath: `output/${date}-selection-report.json`,
  });
  await pipeline.publishModule.publish(formatted, report);
  await pipeline.stateModule.writeState(
    advancePublishedState(publishedState, draft.enabledSources, draft.collectedAt),
  );
  await pipeline.draftModule.clearPendingDraft();

  return [
    'daily-news publish: complete',
    `Date: ${date}`,
    `Selected items: ${selectedItems.length}`,
    `Substack draft: output/${date}-substack.html`,
    `Selection report: output/${date}-selection-report.json`,
    'State advanced and pending draft cleared.',
  ].join('\n');
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

  const args = { resume, discard, force };

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
    case 'publish':
      return runPublish({ pipeline, repoRoot, log });
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
