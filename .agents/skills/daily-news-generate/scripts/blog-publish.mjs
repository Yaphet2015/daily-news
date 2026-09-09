#!/usr/bin/env node
// blog-publish.mjs — 把已发布的 AI 日刊同步到 blog.yaphet.me
// 用法: node blog-publish.mjs [--date=YYYY-MM-DD] [--dry-run]
// 幂等：博客里已有同日文章则跳过转换（--force 覆盖）。
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const BLOG_REPO = process.env.DAILY_NEWS_BLOG_REPO || join(homedir(), 'workspace/project/astro-blog');
const VAULT = process.env.OBSIDIAN_VAULT_PATH?.trim() ||
  join(homedir(), 'Library/Mobile Documents/iCloud~md~obsidian/Documents/Obsidian Vault');
const TOKEN_FILE = process.env.EDGEONE_TOKEN_FILE || join(homedir(), '.hermes/secrets/eo_pages_token.txt');
const AUTODEPLOY = process.env.DAILY_NEWS_BLOG_AUTODEPLOY !== '0';
const SITE = 'https://blog.yaphet.me';
const DN_DESC = 'AI 日刊：每天从 Product / Tutorial / Opinions 三栏精选值得看的信息';

const args = process.argv.slice(2);
const flag = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=');
const dryRun = args.includes('--dry-run');
const force = args.includes('--force');
const log = (m) => console.log(`[blog-publish] ${m}`);
const fail = (m) => { console.error(`[blog-publish] FAIL: ${m}`); process.exitCode = 1; };

function run(cmd, cwd, envExtra = {}) {
  return new Promise((resolve) => {
    const p = spawn(cmd[0], cmd.slice(1), { cwd, stdio: 'pipe', env: { ...process.env, ...envExtra } });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; });
    p.on('exit', (code) => resolve({ code, out, err }));
  });
}

function resolveDate() {
  const explicit = flag('date');
  if (explicit) return explicit;
  // 优先：repo output/ 里最新的 *-substack.html
  try {
    const dates = readdirSync(join(resolveRepo(), 'output'))
      .map((f) => f.match(/^(\d{4}-\d{2}-\d{2})-substack\.html$/)?.[1]).filter(Boolean).sort();
    if (dates.length) return dates.at(-1);
  } catch { /* ignore */ }
  // 其次：Vault 里最新的日刊（按月文件夹扫描）
  try {
    const root = join(VAULT, 'Clippings', 'Daily-News');
    const all = [];
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (entry.isFile()) {
        const m = entry.name.match(/^(\d{4}-\d{2}-\d{2})-daily-news\.md$/);
        if (m) all.push(m[1]);
      } else if (entry.isDirectory() && /^\d{4}-\d{2}$/.test(entry.name)) {
        for (const f of readdirSync(join(root, entry.name))) {
          const m = f.match(/^(\d{4}-\d{2}-\d{2})-daily-news\.md$/);
          if (m) all.push(m[1]);
        }
      }
    }
    if (all.length) return all.sort().at(-1);
  } catch { /* ignore */ }
  return undefined;
}
function resolveRepo() { return process.env.DAILY_NEWS_REPO || process.cwd(); }

function findVaultNote(date) {
  const month = date.slice(0, 7);
  const candidates = [
    join(VAULT, 'Clippings', 'Daily-News', month, `${date}-daily-news.md`),
    join(VAULT, 'clippings', 'daily-news', month, `${date}-daily-news.md`),
    join(VAULT, 'Clippings', 'Daily-News', `${date}-daily-news.md`),
  ];
  return candidates.find((p) => existsSync(p));
}

function convert(src, date) {
  const txt = readFileSync(src, 'utf-8');
  if (!txt.includes('## Product')) throw new Error('Vault 笔记缺少 ## Product 段（非正式日报）');
  const fm = txt.match(/^---\n(.*?)\n---\n/s);
  const body0 = fm ? txt.slice(fm[0].length) : txt;
  const body = body0.replace(/^#\s+.*\n+/, '').trimEnd();
  const updated = fm?.[1].match(/^updated:\s*(\S+)/m)?.[1];
  const compact = date.replaceAll('-', '');
  const hasCover = existsSync(join(BLOG_REPO, 'src/assets/images/dailynews-cover.png'));
  const lines = [
    '---', 'author: Yaphet', `pubDatetime: ${date}T00:00:00.000Z`,
  ];
  if (updated) {
    const z = new Date(new Date(updated).getTime() - 8 * 3600e3).toISOString().replace(/\.\d+Z$/, '.000Z');
    if (!z.startsWith('NaN') && !z.includes('Invalid')) lines.push(`modDatetime: ${z}`);
  }
  lines.push(`title: AI 日刊 · ${date}`, `slug: DailyNews${compact}`, 'draft: false',
    'tags:', '  - daily-news', ...(hasCover ? [`ogImage: ../../../assets/images/dailynews-cover.png`] : []),
    'description:', `  ${DN_DESC}`, '', '---', '');
  return lines.join('\n') + body + '\n';
}

async function main() {
  const date = resolveDate();
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return fail(`无法确定日期（用 --date=YYYY-MM-DD 指定）`);
  log(`date=${date}`);

  const src = findVaultNote(date);
  if (!src) return fail(`Vault 里找不到 ${date} 的日报笔记`);
  const dst = join(BLOG_REPO, 'src/data/blog/Daily-News', `${date}-daily-news.md`);
  let converted = false;
  if (existsSync(dst) && !force) {
    log(`博客已有 ${date}，跳过转换（--force 覆盖）`);
  } else {
    if (dryRun) return log('dry-run：转换未写入');
    mkdirSync(dirname(dst), { recursive: true });
    writeFileSync(dst, convert(src, date), 'utf-8');
    log(`已转换 -> ${dst.replace(homedir(), '~')}`);
    converted = true;
  }
  if (dryRun) return log('dry-run 结束（未构建未部署）');

  if (!existsSync(join(BLOG_REPO, 'node_modules'))) return fail('astro-blog 缺 node_modules，先 npm install');

  // 无新内容则早退，省掉 2-3 分钟构建
  await run(['git', 'add', `src/data/blog/Daily-News/${date}-daily-news.md`], BLOG_REPO);
  if (!converted) {
    const noChange = (await run(['git', 'diff', '--cached', '--quiet'], BLOG_REPO)).code === 0;
    if (noChange) { log('博客无变更，无需重新构建部署'); return console.log(`[blog-publish] URL: ${SITE}/posts/daily-news/DailyNews${date.replaceAll('-', '')}/`); }
  }

  log('构建 astro-blog（约 2-3 分钟）…');
  const b = await run(['npm', 'run', 'build'], BLOG_REPO);
  if (b.code !== 0) return fail(`构建失败\n${(b.out + b.err).slice(-2000)}`);

  const g2 = await run(['git', 'diff', '--cached', '--quiet'], BLOG_REPO);
  if (g2.code !== 0) {
    const c = await run(['git', 'commit', '-m', `Publish AI daily news ${date}`], BLOG_REPO);
    if (c.code !== 0) return fail(`git commit 失败\n${c.err.slice(-500)}`);
  }
  const p = await run(['git', 'push', 'origin', 'main'], BLOG_REPO);
  if (p.code !== 0) log(`git push 失败（可稍后手动推）：${p.err.slice(-200)}`);

  if (!AUTODEPLOY) { log('DAILY_NEWS_BLOG_AUTODEPLOY=0，跳过部署'); return report(date); }

  if (!existsSync(TOKEN_FILE)) return fail(`缺 EdgeOne token：${TOKEN_FILE}`);
  const token = readFileSync(TOKEN_FILE, 'utf-8').trim();
  log('部署 EdgeOne…');
  const d = await run(['npx', 'edgeone@latest', 'makers', 'deploy', 'dist', '-n', 'astro-blog-2', '--json'],
    BLOG_REPO, { EDGEONE_PAGES_API_TOKEN: token });
  if (d.code !== 0 || !/Deploy Success/.test(d.out + d.err)) {
    return fail(`部署失败\n${(d.out + d.err).slice(-1000)}\n重试: node ${__dirname}/blog-publish.mjs --date=${date}`);
  }
  await report(date);
}

async function report(date) {
  const compact = date.replaceAll('-', '');
  const url = `${SITE}/posts/daily-news/DailyNews${compact}/`;
  await new Promise((r) => setTimeout(r, 15000));
  const v = await run(['curl', '-s', '-o', '/dev/null', '-w', '%{http_code}', url], BLOG_REPO);
  const code = v.out.trim();
  if (code === '200') log(`✅ 已上线: ${url}`);
  else log(`⚠️ 部署完成但 ${url} 返回 ${code}（CDN 可能延迟，稍后再查）`);
  console.log(`[blog-publish] URL: ${url}`);
}

main().catch((e) => fail(e instanceof Error ? e.message : String(e)));
