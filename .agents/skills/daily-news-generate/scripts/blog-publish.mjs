#!/usr/bin/env node
// blog-publish.mjs — 把已发布的 AI 日刊同步到 blog.yaphet.me
// 流程: repo output/<date>-daily-news.md（回退 Vault）→ astro-blog 分支 → gh PR → squash merge → CI 构建部署 → 线上验证
// 依赖: gh 已登录（gh auth login + gh auth setup-git）。不依赖 astro-blog 本地 node_modules、不依赖 EdgeOne token——部署在 astro-blog 的 GitHub Actions 里跑。
// 用法: node blog-publish.mjs [--date=YYYY-MM-DD] [--force]
// 幂等: main 上已有同日同内容则跳过；--force 覆盖重发。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GH_REPO = 'Yaphet2015/astro-blog';
const BLOG_REPO_URL = 'https://github.com/Yaphet2015/astro-blog.git';
const BLOG_REPO = process.env.DAILY_NEWS_BLOG_REPO || join(homedir(), 'workspace/project/astro-blog');
const VAULT = process.env.OBSIDIAN_VAULT_PATH?.trim() ||
  join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Vault');
const SITE = 'https://blog.yaphet.me';
const DN_DESC_FALLBACK = 'AI 日刊：每天从 Product / Tutorial / Opinions 三栏精选值得看的信息';
const DST_REL = 'src/data/blog/Daily-News';
const WAIT_DEADLINE_MS = 6.5 * 60 * 1000; // CI 等待上限，须小于 runtime 的 10min 超时

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const force = args.includes('--force');
const log = (m) => console.log(`[blog-publish] ${m}`);
const fail = (m) => { console.error(`[blog-publish] FAIL: ${m}`); process.exitCode = 1; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function run(cmd, cwd, envExtra = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd, stdio: 'pipe', env: { ...process.env, ...envExtra } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
    p.on('error', () => resolve({ code: 1, out, err: `${cmd[0]} not found` }));
  });
}
const ok = (r) => r.code === 0;

function resolveRepo() { return process.env.DAILY_NEWS_REPO || process.cwd(); }

function resolveDate() {
  const explicit = flag('date');
  if (explicit) return explicit;
  try {
    const files = readdirSync(join(resolveRepo(), 'output'));
    // 优先：最新的 *-daily-news.md（publish 的 Markdown 产物）
    const md = files.map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-daily-news\.md$/)?.[1]).filter(Boolean).sort();
    if (md.length) return md.at(-1);
    // 其次：最新的 *-substack.html（旧管线只有它时，用于确定日期）
    const html = files.map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-substack\.html$/)?.[1]).filter(Boolean).sort();
    if (html.length) return html.at(-1);
  } catch { /* ignore */ }
  return undefined;
}

function findSourceNote(date) {
  const month = date.slice(0, 7);
  const candidates = [
    join(resolveRepo(), 'output', `${date}-daily-news.md`),          // 新管线：repo 自己的 output
    join(VAULT, 'Clippings', 'Daily-News', month, `${date}-daily-news.md`), // 旧回退：Obsidian Vault
    join(VAULT, 'clippings', 'daily-news', month, `${date}-daily-news.md`),
    join(VAULT, 'Clippings', 'Daily-News', `${date}-daily-news.md`),
  ];
  return candidates.find((p) => existsSync(p));
}

// 本期副标题：agent 在 publish 前写 output/<date>-desc.txt（一行中文，~240 字，硬范围 200–280，标点计入、空白不计）。
// 缺文件或多行时回退默认句，并提示 agent 补写——回退不阻塞发布。
function resolveDesc(date) {
  const descPath = join(resolveRepo(), 'output', `${date}-desc.txt`);
  if (!existsSync(descPath)) {
    log(`⚠️ 未找到 ${descPath}，副标题用默认句。publish 前让 agent 写一句话摘要可换成本期专属描述。`);
    return DN_DESC_FALLBACK;
  }
  const desc = readFileSync(descPath, 'utf-8').trim();
  if (!desc || desc.includes('\n')) {
    log(`⚠️ ${descPath} 内容为空或多行，副标题用默认句`);
    return DN_DESC_FALLBACK;
  }
  return desc;
}

function convert(src, date, hasCover) {
  const txt = readFileSync(src, 'utf-8');
  if (!txt.includes('## Product')) throw new Error('源笔记缺少 ## Product 段（非正式日报）');
  const fm = txt.match(/^---\n(.*?)\n---\n/s);
  const body0 = fm ? txt.slice(fm[0].length) : txt;
  const body = body0.replace(/^#\s+.*\n+/, '').trimEnd();
  const updated = fm?.[1].match(/^updated:\s*(\S+)/m)?.[1];
  const compact = date.replaceAll('-', '');
  const desc = resolveDesc(date);
  const lines = ['---', 'author: Yaphet', `pubDatetime: ${date}T00:00:00.000Z`];
  if (updated) {
    const z = new Date(new Date(updated).getTime() - 8 * 3600e3).toISOString().replace(/\.\d+Z$/, '.000Z');
    if (!z.startsWith('NaN') && !z.includes('Invalid')) lines.push(`modDatetime: ${z}`);
  }
  lines.push(`title: AI 日刊 · ${date}`, `slug: DailyNews${compact}`, 'draft: false',
    'tags:', '  - daily-news', ...(hasCover ? ['ogImage: ../../../assets/images/dailynews-cover.png'] : []),
    'description:', `  ${desc}`, '', '---', '');
  return lines.join('\n') + body + '\n';
}

function liveUrl(date) {
  return `${SITE}/posts/daily-news/DailyNews${date.replaceAll('-', '')}/`;
}

async function ensureGh() {
  const v = await run(['gh', '--version']);
  if (!ok(v)) throw new Error('未找到 gh CLI。安装: https://cli.github.com/ 或 brew install gh');
  const st = await run(['gh', 'auth', 'status']);
  if (!ok(st)) throw new Error('gh 未登录。先 gh auth login，再 gh auth setup-git');
  await run(['gh', 'auth', 'setup-git']); // 幂等；给 https git push 配 github.com 凭据
}

async function ensureBlogRepo() {
  if (existsSync(join(BLOG_REPO, '.git'))) return;
  log(`astro-blog 不存在，clone 到 ${BLOG_REPO.replace(homedir(), '~')} …`);
  mkdirSync(dirname(BLOG_REPO), { recursive: true });
  const c = await run(['gh', 'repo', 'clone', GH_REPO, BLOG_REPO]);
  if (!ok(c)) throw new Error(`clone 失败\n${(c.out + c.err).slice(-500)}`);
}

async function ensureCleanAndIdentity() {
  const s = await run(['git', 'status', '--porcelain'], BLOG_REPO);
  if (s.out.trim()) throw new Error(`astro-blog 有未提交变更，先处理再发布：\n${s.out.trim().slice(0, 300)}`);
  const email = (await run(['git', 'config', 'user.email'], BLOG_REPO)).out.trim();
  if (!email) {
    await run(['git', 'config', 'user.name', 'Yaphet2015'], BLOG_REPO);
    await run(['git', 'config', 'user.email', 'Yaphet2015@users.noreply.github.com'], BLOG_REPO);
    log('已设置 repo 级 git identity（新机器首次运行）');
  }
}

async function waitForDeploy(mergeSha) {
  const deadline = Date.now() + WAIT_DEADLINE_MS;
  log('等待 astro-blog CI 构建部署…');
  while (Date.now() < deadline) {
    const r = await run(['gh', 'run', 'list', '--repo', GH_REPO, '--branch', 'main',
      '--workflow', 'build-and-deploy.yml', '--limit', '5', '--json', 'headSha,status,conclusion,databaseId'], BLOG_REPO);
    if (ok(r)) {
      try {
        const runs = JSON.parse(r.out);
        const hit = mergeSha ? runs.find((x) => x.headSha === mergeSha) : runs[0];
        if (hit && hit.status === 'completed') {
          if (hit.conclusion !== 'success') {
            log(`⚠️ CI conclusion=${hit.conclusion}（run ${hit.databaseId}）`);
            return false;
          }
          return true;
        }
      } catch { /* retry */
      }
    }
    await sleep(15000);
  }
  log('⚠️ 等待 CI 超时（部署可能仍在进行）');
  return false;
}

async function verifyLive(date) {
  const url = liveUrl(date);
  for (let i = 0; i < 4; i++) {
    const v = await run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url], BLOG_REPO);
    if (v.out.trim() === '200') { log(`✅ 已上线: ${url}`); return true; }
    await sleep(15000);
  }
  log(`⚠️ ${url} 暂未 200（CDN 可能延迟，稍后再查）`);
  return false;
}

async function restoreBranch(prev) {
  const target = !prev || prev.startsWith('daily-news/') ? 'main' : prev;
  await run(['git', 'checkout', target], BLOG_REPO);
  await run(['git', 'pull', '--ff-only'], BLOG_REPO);
}

async function main() {
  const date = resolveDate();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(`无法确定日期（用 --date=YYYY-MM-DD 指定）`);
  log(`date=${date}`);

  const src = findSourceNote(date);
  if (!src) {
    return fail(`${resolveRepo()}/output/${date}-daily-news.md 不存在，Vault 回退也没找到。publish 之后才有产物。`);
  }
  log(`源: ${src.replace(homedir(), '~')}`);

  await ensureGh();
  await ensureBlogRepo();
  await ensureCleanAndIdentity();

  const branch = `daily-news/${date}`;
  const dstRel = `${DST_REL}/${date}-daily-news.md`;
  const dst = join(BLOG_REPO, dstRel);
  const hasCover = existsSync(join(BLOG_REPO, 'src/assets/images/dailynews-cover.png'));
  const content = convert(src, date, hasCover);

  const prevBranch = (await run(['git', 'branch', '--show-current'], BLOG_REPO)).out.trim();
  await run(['git', 'fetch', 'origin', 'main'], BLOG_REPO);

  // 幂等检查：不动工作区，直接比对 origin/main 上的文件内容
  const mainVer = await run(['git', 'show', `origin/main:${dstRel}`], BLOG_REPO);
  if (ok(mainVer)) {
    if (mainVer.out === content && !force) {
      log(`Blog already had ${date}; nothing to do.`);
      return console.log(`[blog-publish] URL: ${liveUrl(date)}`);
    }
    if (mainVer.out !== content && !force) {
      log(`main 上已有 ${date} 但内容不同，未加 --force，跳过`);
      return;
    }
  }

  const co = await run(['git', 'checkout', '-B', branch, 'origin/main'], BLOG_REPO);
  if (!ok(co)) return fail(`切分支失败\n${co.err.slice(-300)}`);

  let prUrl = '';
  try {
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, content, 'utf-8');
    log(`已转换 -> ${dst.replace(homedir(), '~')}`);

    await run(['git', 'add', dstRel], BLOG_REPO);
    const c = await run(['git', 'commit', '-m', `Publish AI daily news ${date}`], BLOG_REPO);
    if (!ok(c)) return fail(`git commit 失败\n${c.err.slice(-300)}`);
    const p = await run(['git', 'push', '-u', 'origin', branch], BLOG_REPO);
    if (!ok(p)) return fail(`git push 失败\n${(p.out + p.err).slice(-500)}`);

    const pr = await run(['gh', 'pr', 'create', '--repo', GH_REPO, '--base', 'main',
      '--head', branch, '--title', `Publish AI daily news ${date}`,
      '--body', `Automated daily-news sync for ${date}. Build runs in CI; deploy to EdgeOne on merge.`], BLOG_REPO);
    if (ok(pr)) prUrl = pr.out.trim().split('\n').at(-1);
    else {
      const v = await run(['gh', 'pr', 'view', branch, '--repo', GH_REPO, '--json', 'url'], BLOG_REPO);
      if (!ok(v)) return fail(`PR 创建失败\n${(pr.out + pr.err).slice(-500)}`);
      prUrl = JSON.parse(v.out).url;
      log('PR 已存在，复用');
    }
    log(`PR: ${prUrl}`);

    const m = await run(['gh', 'pr', 'merge', prUrl, '--squash', '--delete-branch'], BLOG_REPO)
      .then(async (r) => ok(r) ? r : await run(['gh', 'pr', 'merge', prUrl, '--merge', '--delete-branch'], BLOG_REPO));
    if (!ok(m)) {
      return fail(`PR 合并失败，请手动合并后重跑验证\n${prUrl}\n${(m.out + m.err).slice(-500)}`);
    }
    log('PR 已合并，main 部署由 CI 执行');

    const mc = await run(['gh', 'pr', 'view', prUrl, '--repo', GH_REPO, '--json', 'mergeCommit'], BLOG_REPO);
    let mergeSha;
    try { mergeSha = JSON.parse(mc.out)?.mergeCommit?.oid; } catch { /* ignore */ }

    const deployed = await waitForDeploy(mergeSha);
    const live = await verifyLive(date);
    if (live) {
      console.log(`[blog-publish] Blog published: ${liveUrl(date)}`);
      if (prUrl) console.log(`[blog-publish] PR: ${prUrl}`);
    } else {
      fail(`合并完成但未确认上线（deployed=${deployed}）。稍后重跑: node ${__dirname}/blog-publish.mjs --date=${date}`);
    }
  } finally {
    await restoreBranch(prevBranch);
  }
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
