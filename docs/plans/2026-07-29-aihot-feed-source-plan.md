# AI HOT 条目源接入 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 AI HOT 的条目级 RSS（`feed.xml`，50 条精选）作为第三个采集源 `aihot` 接入 daily-news，默认开启，参与统一打分/筛选池；发布产物的来源与描述一律按原始来源，不出现 AI HOT。

**Architecture:** 在 `collect.ts` 新增纯解析 helpers + RSS 解析器 + 采集器，复用既有 RSS/URL 归一化、curl+proxy 抓取、`applyDuplicatePenalties` 跨来源去重与 `getAttribution`→`sourceLabel` 归属路径。新增 `SourceName='aihot'` 为原子类型变更，其所有消费点（types/state/collect/generate/draft）在同一任务内一并改完以保持编译通过。

**Tech Stack:** TypeScript、Node 内建 `node:test`、既有 `execFile('curl')` + `buildSubstackCurlArgs` 抓取路径、`tsx`。

## Global Constraints

- **Feed**：默认 `https://aihot.virxact.com/feed.xml`（经 env `AIHOT_FEED_URL` 可切 `feed/full.xml`/`feed/all.xml`）；**不接** `feed/daily.xml`（日报级非条目）。
- **默认开启**：`ENABLED_SOURCES` 默认值由 `'twitter'` 改为 `'twitter,aihot'`；显式设 `ENABLED_SOURCES=twitter` 可关闭。substack 仍 opt-in。
- **原始来源归属**：每条 `url`/`originUrl` = feed「🔗 阅读原文」原始链接（按 twitter 一致方式归一化）；`author.name` 与 `sourceLabel` = 解析自 `<author>` 的原始来源标签（去 `（RSS）`）；`text` 剥掉 `via AI HOT` 页脚与「阅读原文」行。**发布产物全文不得出现 `AI HOT` / `aihot.virxact.com`**（`format.ts`/`publish.ts` 不读 `source`，用 `attribution`，故天然满足）。
- **不打分加成**：`rank.ts` 不改；aihot 条目无 engagement，纯靠 substance/evidence 竞争，不强制入选（无 `forceSelect`）。
- **失败安全**：feed 不可达只降级为 warning（`collectSources` 用 `Promise.allSettled`），不连累 twitter。
- **TDD**：每个纯函数/采集器先写失败测试再实现；`npm test` 全绿才提交。

## File Structure

- `src/types.ts` — `SourceName` 加 `'aihot'`；`RunState.sources` 加 `aihot`。
- `src/state.ts` — `createEmptyState` / `normalizeRunState`（3 处对象字面量）补 aihot。
- `src/collect.ts` — 新增纯 helpers、`parseAihotFeed`、`mapAihotItem`、`collectAihotItems`、`fetchAihotFeed`、常量；`parseEnabledSources` 放行 aihot 并改默认；`collect()` collectors map 注册 aihot。
- `src/generate.ts` — `advancePublishedState`（nextState 对象 + 循环守卫）与 `createAppendCollectionState` 补 aihot。
- `src/draft.ts` — `normalizeEnabledSources` 过滤器放行 aihot。
- `tests/collect.test.ts` — 新增 helpers / parser / collector 测试。
- `tests/state.test.ts` — 更新 2 处 `deepEqual` 期望以包含 aihot。
- `.env.example` / `docs/design.md` / `.agents/skills/daily-news-generate/SKILL.md` — 文档与 env 示例。

---

### Task 1: AI HOT 纯解析 helpers（不碰 SourceName，独立可编译）

**Files:**
- Modify: `src/collect.ts`（在既有 `stripHtml` 附近新增导出函数）
- Test: `tests/collect.test.ts`

**Interfaces:**
- Produces（均 `export`，位于 `src/collect.ts`）:
  - `extractAihotOriginalUrl(descriptionHtml: string): string | null` — 从 description HTML 提取「🔗 阅读原文」`<a href>` 的原始 URL；无则 `null`。
  - `stripAihotSummaryText(descriptionHtml: string): string` — 剥掉含 `阅读原文` 或 `via AI HOT` 的 `<p>` 块后 `stripHtml`，返回纯摘要。
  - `parseAihotAuthorLabel(authorField: string): { name: string; username?: string }` — 解析 `noreply@aihot.virxact.com (LABEL)`，去尾部 `（RSS）`/`(RSS)`，提取 `@handle`。

- [ ] **Step 1: 写失败测试**

追加到 `tests/collect.test.ts`：

```ts
test('extractAihotOriginalUrl pulls the 阅读原文 href from AI HOT description HTML', () => {
  const html =
    '<p>摘要正文</p>' +
    '<p>🔗 <a href="https://openrouter.ai/blog/x">阅读原文</a></p>' +
    '<p>via AI HOT · <a href="https://aihot.virxact.com/items/abc">abc</a></p>';
  assert.equal(collectModule.extractAihotOriginalUrl(html), 'https://openrouter.ai/blog/x');
  assert.equal(collectModule.extractAihotOriginalUrl('<p>无链接</p>'), null);
});

test('stripAihotSummaryText drops 阅读原文 and via AI HOT footer lines', () => {
  const html =
    '<p>OpenRouter 发布了 langchain-openrouter 专用包，调用 400+ 模型。</p>' +
    '<p>🔗 <a href="https://openrouter.ai/blog/x">阅读原文</a></p>' +
    '<p>via AI HOT · <a href="https://aihot.virxact.com/items/abc">abc</a></p>';
  const text = collectModule.stripAihotSummaryText(html);
  assert.ok(text.includes('langchain-openrouter'));
  assert.ok(!/阅读原文/.test(text));
  assert.ok(!/via\s+AI\s+HOT/i.test(text));
  assert.ok(!/aihot\.virxact\.com/.test(text));
});

test('parseAihotAuthorLabel extracts original source label and optional X handle', () => {
  assert.deepEqual(
    collectModule.parseAihotAuthorLabel('noreply@aihot.virxact.com (IT之家（RSS）)'),
    { name: 'IT之家' },
  );
  assert.deepEqual(
    collectModule.parseAihotAuthorLabel('noreply@aihot.virxact.com (X：Tibo (@thsottiaux))'),
    { name: 'X：Tibo', username: 'thsottiaux' },
  );
  assert.deepEqual(
    collectModule.parseAihotAuthorLabel('noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)'),
    { name: 'OpenRouter：Announcements' },
  );
  assert.deepEqual(collectModule.parseAihotAuthorLabel('AI HOT'), { name: 'AI HOT' });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --test-name-pattern "Aihot"`
Expected: 3 个新测试 FAIL（`collectModule.extractAihotOriginalUrl is not a function` 等）。

- [ ] **Step 3: 实现纯 helpers**

在 `src/collect.ts` 既有 `stripHtml` 函数定义附近新增：

```ts
const AIHOT_ORIGINAL_LINK_RE = /<a\b[^>]*\bhref="([^"]+)"[^>]*>\s*阅读原文\s*<\/a>/i;

export function extractAihotOriginalUrl(descriptionHtml: string): string | null {
  const match = descriptionHtml.match(AIHOT_ORIGINAL_LINK_RE);
  return match?.[1] ? match[1].trim() : null;
}

export function stripAihotSummaryText(descriptionHtml: string): string {
  const blocks = Array.from(
    descriptionHtml.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi),
  ).map((match) => match[1] ?? '');
  const kept = blocks.filter((block) => !/阅读原文|via\s+AI\s+HOT/i.test(block));
  return stripHtml(kept.join(' ')).trim();
}

export function parseAihotAuthorLabel(authorField: string): { name: string; username?: string } {
  const parenthesized = authorField.match(/^[^()]*\(([\s\S]*)\)\s*$/);
  let label = (parenthesized?.[1] ?? authorField).trim();
  label = label.replace(/\s*[（(]\s*RSS\s*[)）]\s*$/i, '').trim();

  const handleMatch = label.match(/@([A-Za-z0-9_]+)/);
  const username = handleMatch?.[1];
  const name = label.replace(/\s*[（(]@[A-Za-z0-9_]+[)）]\s*$/, '').trim() || label;

  return username ? { name, username } : { name };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --test-name-pattern "Aihot"`
Expected: 3 个新测试 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/collect.ts tests/collect.test.ts
git commit -m "feat(collect): AI HOT 摘要/作者/原文链接纯解析 helpers"
```

---

### Task 2: AI HOT RSS feed 解析器（不碰 SourceName，独立可编译）

**Files:**
- Modify: `src/collect.ts`（新增 `AihotRawItem` + `parseAihotFeed`）
- Test: `tests/collect.test.ts`

**Interfaces:**
- Consumes: 既有 `cleanXmlText`、`extractXmlTag`（`src/collect.ts` 私有，同文件可调用）。
- Produces（`export`）:
  - `interface AihotRawItem { guid: string; title: string; descriptionHtml: string; publishedAt: string; authorField: string }`
  - `parseAihotFeed(xml: string): AihotRawItem[]`

- [ ] **Step 1: 写失败测试**

追加到 `tests/collect.test.ts`：

```ts
test('parseAihotFeed extracts item guid/title/description/pubDate/author from RSS', () => {
  const xml = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel>
<title>AI HOT — 精选</title>
<link>https://aihot.virxact.com/</link>
<item>
<title><![CDATA[OpenRouter 推出专用 LangChain 集成包]]></title>
<link>https://aihot.virxact.com/items/cms5dje23</link>
<description><![CDATA[<p>OpenRouter 发布了专用包。</p><p>🔗 <a href="https://openrouter.ai/blog/x">阅读原文</a></p><p>via AI HOT · <a href="https://aihot.virxact.com/items/cms5dje23">x</a></p>]]></description>
<category>技巧观点</category>
<pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
<guid isPermaLink="false">cms5dje23</guid>
<author>noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)</author>
</item>
<item>
<title><![CDATA[无 guid 的条目应被跳过]]></title>
<link>https://aihot.virxact.com/items/skip</link>
<description><![CDATA[<p>x</p>]]></description>
<pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
<author>noreply@aihot.virxact.com (AI HOT)</author>
</item>
</channel></rss>`;

  assert.deepEqual(collectModule.parseAihotFeed(xml), [
    {
      guid: 'cms5dje23',
      title: 'OpenRouter 推出专用 LangChain 集成包',
      descriptionHtml:
        '<p>OpenRouter 发布了专用包。</p><p>🔗 <a href="https://openrouter.ai/blog/x">阅读原文</a></p><p>via AI HOT · <a href="https://aihot.virxact.com/items/cms5dje23">x</a></p>',
      publishedAt: 'Wed, 29 Jul 2026 00:00:00 GMT',
      authorField: 'noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)',
    },
  ]);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --test-name-pattern "parseAihotFeed"`
Expected: FAIL（`collectModule.parseAihotFeed is not a function`）。

- [ ] **Step 3: 实现 parser**

先修共享 helper `extractXmlTag` 以容忍标签属性（real feed 的 `<guid isPermaLink="false">` 带属性；对无属性标签 `[^>]*` 匹配零字符，`parseSubstackFeed` 行为不变）：

```ts
// extractXmlTag 内：把
const match = block.match(new RegExp(`<${escapedTag}>([\\s\\S]*?)</${escapedTag}>`, 'i'));
// 改为
const match = block.match(new RegExp(`<${escapedTag}\\b[^>]*>([\\s\\S]*?)</${escapedTag}>`, 'i'));
```

在 `src/collect.ts` Task 1 新增 helpers 之后追加：

```ts
export interface AihotRawItem {
  guid: string;
  title: string;
  descriptionHtml: string;
  publishedAt: string;
  authorField: string;
}

export function parseAihotFeed(xml: string): AihotRawItem[] {
  const channelMatch = xml.match(/<channel>([\s\S]*?)<\/channel>/i);
  if (!channelMatch?.[1]) return [];

  const channel = channelMatch[1];
  return Array.from(channel.matchAll(/<item>([\s\S]*?)<\/item>/gi)).flatMap((match) => {
    const block = match[1] ?? '';
    const guid = cleanXmlText(extractXmlTag(block, 'guid'));
    const title = cleanXmlText(extractXmlTag(block, 'title'));
    if (!guid || !title) return [];
    return [
      {
        guid,
        title,
        descriptionHtml: cleanXmlText(extractXmlTag(block, 'description')),
        publishedAt: cleanXmlText(extractXmlTag(block, 'pubDate')),
        authorField: cleanXmlText(extractXmlTag(block, 'author')),
      },
    ];
  });
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npm test -- --test-name-pattern "parseAihotFeed"`
Expected: PASS。

- [ ] **Step 5: 提交**

```bash
git add src/collect.ts tests/collect.test.ts
git commit -m "feat(collect): AI HOT RSS 解析器; extractXmlTag 容忍标签属性"
```

---

### Task 3: 注册 aihot 源（原子类型变更，一次性改完所有消费点）

**Files:**
- Modify: `src/types.ts`、`src/state.ts`、`src/generate.ts`、`src/draft.ts`、`src/collect.ts`
- Test: `tests/collect.test.ts`（新增 collector 测试）、`tests/state.test.ts`（更新既有期望）、`tests/generate.test.ts`（既有 inline `readState` 的 `RunState` 字面量补 aihot，见 Step 8）

**Interfaces:**
- Consumes: Task 1 的 `extractAihotOriginalUrl`/`stripAihotSummaryText`/`parseAihotAuthorLabel`、Task 2 的 `AihotRawItem`/`parseAihotFeed`；既有 `normalizeTwitterStatusUrl`、`normalizeExternalUrl`、`isTwitterDomain`、`filterSinceTime`、`sortNewestFirst`、`buildSubstackCurlArgs`、`resolveHttpProxy`、`logCollectDiagnostic`、`redactProxyValue`、`redactCurlArgs`、`summarizeError`、`summarizeDiagnosticError`、`execFileAsync`、`parsePositiveInt`、`stripHtml`、`CollectedItem`。
- Produces:
  - `collectAihotItems({ sinceTime: number; feedUrl?: string; maxItems?: number; deps?: { fetchFeed?: (url: string) => Promise<string> } }): Promise<CollectedItem[]>`（`export`）
  - `SourceName` 增 `'aihot'`；`RunState.sources.aihot: SourceRunState`。

- [ ] **Step 1: 写失败测试（collector 行为）**

追加到 `tests/collect.test.ts`：

```ts
test('collectAihotItems maps feed items to CollectedItem with original source attribution', async () => {
  const xml = String.raw`<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0"><channel><title>AI HOT — 精选</title><link>https://aihot.virxact.com/</link>
<item>
<title><![CDATA[OpenRouter 推出专用 LangChain 集成包]]></title>
<link>https://aihot.virxact.com/items/cms5dje23</link>
<description><![CDATA[<p>OpenRouter 发布了 langchain-openrouter 专用包，调用 400+ 模型。</p><p>🔗 <a href="https://openrouter.ai/blog/x?utm_source=feed">阅读原文</a></p><p>via AI HOT · <a href="https://aihot.virxact.com/items/cms5dje23">x</a></p>]]></description>
<pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
<guid isPermaLink="false">cms5dje23</guid>
<author>noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)</author>
</item>
<item>
<title><![CDATA[无阅读原文的条目应被丢弃]]></title>
<link>https://aihot.virxact.com/items/cms5zz</link>
<description><![CDATA[<p>这条没有原始链接。</p>]]></description>
<pubDate>Wed, 29 Jul 2026 01:00:00 GMT</pubDate>
<guid isPermaLink="false">cms5zz</guid>
<author>noreply@aihot.virxact.com (AI HOT)</author>
</item>
</channel></rss>`;

  const items = await collectModule.collectAihotItems({
    sinceTime: 0,
    feedUrl: 'https://example.com/feed.xml',
    deps: { fetchFeed: async () => xml },
  });

  assert.equal(items.length, 1);
  const item = items[0];
  assert.equal(item.source, 'aihot');
  assert.equal(item.id, 'cms5dje23');
  assert.equal(item.url, 'https://openrouter.ai/blog/x');
  assert.equal(item.originUrl, 'https://openrouter.ai/blog/x');
  assert.equal(item.title, 'OpenRouter 推出专用 LangChain 集成包');
  assert.equal(item.author.name, 'OpenRouter：Announcements');
  assert.equal(item.sourceLabel, 'OpenRouter：Announcements');
  assert.equal(item.publishedAt, '2026-07-29T00:00:00.000Z');
  assert.ok(item.text.includes('langchain-openrouter'));
  assert.ok(!/阅读原文|via\s+AI\s+HOT/i.test(item.text));
  assert.deepEqual(item.media, []);
});

test('collectAihotItems respects sinceTime and maxItems', async () => {
  const item = (guid: string, pub: string) =>
    `<item><title><![CDATA[t-${guid}]]></title><link>https://aihot.virxact.com/items/${guid}</link>` +
    `<description><![CDATA[<p>body</p><p>🔗 <a href="https://example.com/${guid}">阅读原文</a></p>]]></description>` +
    `<pubDate>${pub}</pubDate><guid isPermaLink="false">${guid}</guid><author>noreply@aihot.virxact.com (Example)</author></item>`;
  const xml =
    '<rss version="2.0"><channel><title>x</title><link>https://aihot.virxact.com/</link>' +
    item('a', 'Wed, 29 Jul 2026 00:00:00 GMT') +
    item('b', 'Wed, 28 Jul 2026 00:00:00 GMT') +
    item('c', 'Wed, 27 Jul 2026 00:00:00 GMT') +
    '</channel></rss>';

  const sinceTime = Math.floor(Date.parse('2026-07-28T12:00:00Z') / 1000);
  const windowed = await collectModule.collectAihotItems({
    sinceTime,
    deps: { fetchFeed: async () => xml },
  });
  assert.deepEqual(windowed.map((i) => i.id), ['a']);

  const capped = await collectModule.collectAihotItems({
    sinceTime: 0,
    maxItems: 2,
    deps: { fetchFeed: async () => xml },
  });
  assert.equal(capped.length, 2);
  assert.deepEqual(capped.map((i) => i.id), ['a', 'b']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npm test -- --test-name-pattern "collectAihotItems"`
Expected: 2 个测试 FAIL（`collectModule.collectAihotItems is not a function`）。

- [ ] **Step 3: 改 `src/types.ts`（原子类型变更起点）**

把 `SourceName` 与 `RunState.sources` 改为：

```ts
export type SourceName = 'twitter' | 'substack' | 'aihot';
```

```ts
export interface RunState {
  sources: {
    twitter: SourceRunState;
    substack: SourceRunState;
    aihot: SourceRunState;
  };
}
```

- [ ] **Step 4: 改 `src/state.ts`（3 处对象字面量 + `getLastPublishedTime` 泛化）**

`createEmptyState()`：

```ts
function createEmptyState(): RunState {
  return {
    sources: {
      twitter: { lastPublishedTime: 0 },
      substack: { lastPublishedTime: 0 },
      aihot: { lastPublishedTime: 0 },
    },
  };
}
```

`normalizeRunState()` 内：`getLastPublishedTime` 形参类型与两个返回对象都补 aihot：

```ts
  const getLastPublishedTime = (source: 'twitter' | 'substack' | 'aihot'): number => {
```

legacy `lastRunTime` 分支返回值：

```ts
    return {
      sources: {
        twitter: { lastPublishedTime: candidate.lastRunTime },
        substack: { lastPublishedTime: 0 },
        aihot: { lastPublishedTime: 0 },
      },
    };
```

正常分支返回值：

```ts
  return {
    sources: {
      twitter: { lastPublishedTime: getLastPublishedTime('twitter') },
      substack: { lastPublishedTime: getLastPublishedTime('substack') },
      aihot: { lastPublishedTime: getLastPublishedTime('aihot') },
    },
  };
```

- [ ] **Step 5: 改 `src/generate.ts`（`advancePublishedState` + `createAppendCollectionState`）**

`advancePublishedState` 的 `nextState` 初始对象与循环守卫：

```ts
  const nextState: RunState = {
    sources: {
      twitter: { lastPublishedTime: state.sources.twitter.lastPublishedTime },
      substack: { lastPublishedTime: state.sources.substack.lastPublishedTime },
      aihot: { lastPublishedTime: state.sources.aihot.lastPublishedTime },
    },
  };

  for (const source of sources) {
    if (source === 'twitter' || source === 'substack' || source === 'aihot') {
      nextState.sources[source] = { lastPublishedTime: collectedAt };
    }
  }
```

`createAppendCollectionState`：

```ts
function createAppendCollectionState(draft: PendingDraft): RunState {
  return {
    sources: {
      twitter: { lastPublishedTime: draft.collectedAt },
      substack: { lastPublishedTime: draft.collectedAt },
      aihot: { lastPublishedTime: draft.collectedAt },
    },
  };
}
```

- [ ] **Step 6: 改 `src/draft.ts`（过滤器放行 aihot）**

```ts
  const sources = value.filter(
    (entry): entry is SourceName => entry === 'twitter' || entry === 'substack' || entry === 'aihot',
  );
```

- [ ] **Step 7: 改 `src/collect.ts`（常量 + collector + mapAihotItem + parseEnabledSources + collect() 注册）**

在文件顶部既有 `DEFAULT_*` 常量区新增：

```ts
const DEFAULT_AIHOT_FEED_URL = 'https://aihot.virxact.com/feed.xml';
const DEFAULT_AIHOT_MAX_ITEMS = 50;
```

在 Task 2 的 `parseAihotFeed` 之后新增 `mapAihotItem` + `collectAihotItems` + `fetchAihotFeed`：

```ts
function mapAihotItem(raw: AihotRawItem): CollectedItem | null {
  const originalUrl = extractAihotOriginalUrl(raw.descriptionHtml);
  if (!originalUrl) return null;

  let normalized: string | null = null;
  try {
    const parsed = new URL(originalUrl);
    normalized = isTwitterDomain(parsed.hostname)
      ? (normalizeTwitterStatusUrl(originalUrl) ?? normalizeExternalUrl(originalUrl))
      : normalizeExternalUrl(originalUrl);
  } catch {
    normalized = null;
  }
  if (!normalized) return null;

  const { name, username } = parseAihotAuthorLabel(raw.authorField);
  const parsedDate = Date.parse(raw.publishedAt);
  const publishedAt = Number.isFinite(parsedDate)
    ? new Date(parsedDate).toISOString()
    : raw.publishedAt;

  return {
    id: raw.guid,
    source: 'aihot',
    url: normalized,
    originUrl: normalized,
    title: raw.title,
    text: stripAihotSummaryText(raw.descriptionHtml),
    author: username ? { name, username } : { name },
    sourceLabel: name,
    publishedAt,
    media: [],
  };
}

interface CollectAihotItemsOptions {
  sinceTime: number;
  feedUrl?: string;
  maxItems?: number;
  deps?: { fetchFeed?: (url: string) => Promise<string> };
}

export async function collectAihotItems({
  sinceTime,
  feedUrl,
  maxItems = DEFAULT_AIHOT_MAX_ITEMS,
  deps,
}: CollectAihotItemsOptions): Promise<CollectedItem[]> {
  const url = (feedUrl ?? process.env.AIHOT_FEED_URL ?? DEFAULT_AIHOT_FEED_URL).trim();
  if (!url) return [];

  const fetchFeed = deps?.fetchFeed ?? fetchAihotFeed;
  console.log(
    `[collect] 采集 AI HOT feed，sinceTime=${new Date(sinceTime * 1000).toLocaleString('zh-CN')} url=${url}`,
  );

  let xml: string;
  try {
    xml = await fetchFeed(url);
  } catch (error) {
    console.warn(`[collect] AI HOT feed 抓取失败: ${summarizeError(error)}`);
    return [];
  }

  const rawItems = parseAihotFeed(xml);
  const mapped: CollectedItem[] = [];
  let dropped = 0;
  for (const raw of rawItems) {
    const item = mapAihotItem(raw);
    if (item) mapped.push(item);
    else dropped += 1;
  }

  const filtered = filterSinceTime(mapped, sinceTime);
  const result = sortNewestFirst(filtered).slice(0, maxItems);
  console.log(
    `[collect] AI HOT 完成，解析 ${rawItems.length} 条，丢弃 ${dropped} 条无原始来源，时间窗内 ${filtered.length} 条，取 ${result.length} 条`,
  );
  return result;
}

async function fetchAihotFeed(url: string): Promise<string> {
  const proxy = resolveHttpProxy();
  const args = buildSubstackCurlArgs(url, proxy);
  logCollectDiagnostic(
    `aihot proxy=${proxy ? redactProxyValue(proxy) : 'disabled'} command=curl ${redactCurlArgs(args).join(' ')}`,
  );
  try {
    const { stdout } = await execFileAsync('curl', args, { maxBuffer: 20 * 1024 * 1024 });
    return stdout;
  } catch (error) {
    logCollectDiagnostic(`aihot error=${summarizeDiagnosticError(error)}`);
    throw error;
  }
}
```

改 `parseEnabledSources()`（默认值 + 过滤器放行 aihot）：

```ts
function parseEnabledSources(): SourceName[] {
  const raw = process.env.ENABLED_SOURCES ?? 'twitter,aihot';
  const sources = raw
    .split(',')
    .map((value) => value.trim())
    .filter(
      (value): value is SourceName => value === 'twitter' || value === 'substack' || value === 'aihot',
    );

  return sources.length > 0 ? Array.from(new Set(sources)) : ['twitter', 'aihot'];
}
```

在 `collect()` 的 `collectors` map 中、`substack` 条目之后新增 `aihot` 条目：

```ts
      aihot: (sinceTime) =>
        collectAihotItems({
          sinceTime,
          feedUrl: process.env.AIHOT_FEED_URL,
          maxItems: parsePositiveInt(process.env.AIHOT_SOURCE_MAX_ITEMS, DEFAULT_AIHOT_MAX_ITEMS),
        }),
```

- [ ] **Step 8: 更新 `tests/state.test.ts`（既有 deepEqual 期望补 aihot）**

把「migrates legacy state」测试期望改为：

```ts
  assert.deepEqual(normalizeRunState({ lastRunTime: 123 }), {
    sources: {
      twitter: { lastPublishedTime: 123 },
      substack: { lastPublishedTime: 0 },
      aihot: { lastPublishedTime: 0 },
    },
  });
```

把「readState returns the new empty shape」测试期望改为：

```ts
  assert.deepEqual(state, {
    sources: {
      twitter: { lastPublishedTime: 0 },
      substack: { lastPublishedTime: 0 },
      aihot: { lastPublishedTime: 0 },
    },
  });
```

（`writeState` 测试用 `assert.match` 正则断言，新增 aihot 不影响其通过，无需改动。）

`tests/generate.test.ts` 内约 18 处 inline `readState` mock 字面量按 `RunState` 结构类型校验，加 aihot 后缺键会让 `tsc --noEmit` 失败：给每处 `{ sources: { twitter: {...}, substack: {...} } }` 补上 `aihot: { lastPublishedTime: 0 }`（不改任何断言/运行行为）。用 `npx tsc --noEmit` 验证 exit 0。

- [ ] **Step 9: 跑全量测试确认通过**

Run: `npm test`
Expected: 全绿（含新增 2 个 collector 测试、Task 1/2 测试、更新后的 state 测试）。

- [ ] **Step 10: 提交**

```bash
git add src/types.ts src/state.ts src/generate.ts src/draft.ts src/collect.ts tests/collect.test.ts tests/state.test.ts tests/generate.test.ts
git commit -m "feat(collect): 接入 aihot 源(默认开启,原始来源归属)"
```

---

### Task 4: 文档与 env 示例（SSOT 同步）

**Files:**
- Modify: `.env.example`、`docs/design.md`、`.agents/skills/daily-news-generate/SKILL.md`

**Interfaces:** 无代码接口；纯文档。

- [ ] **Step 1: 更新 `.env.example`**

把「启用来源」段改为：

```
# ── 启用来源 ─────────────────────────────────────────────────
# 逗号分隔，可选 twitter,substack,aihot。默认 twitter,aihot
ENABLED_SOURCES=twitter,substack,aihot
```

在 Twitter 段之前（或「启用来源」段之后）新增 AI HOT 段：

```
# ── AI HOT 条目源 ────────────────────────────────────────────
# 条目级 RSS（无需 API Key）。默认 feed.xml（50 条精选）；
# 可切 https://aihot.virxact.com/feed/full.xml（全文）或 /feed/all.xml（7 天全部）
AIHOT_FEED_URL=https://aihot.virxact.com/feed.xml
AIHOT_SOURCE_MAX_ITEMS=50
```

- [ ] **Step 2: 更新 `docs/design.md`**

把第 8 行来源说明「当前包括一个 twitter list、一个……publications；后面有需要再增补新的列表或 Blog RSS 地址」扩写为：

> 当前包括一个 twitter list、一个使用独立新账号的 X For You 推荐流、我 Substack 账号 follow 的 publications，以及 AI HOT 的条目级精选 RSS（`feed.xml`，作为补充信源默认开启）；后面有需要再增补新的列表或 Blog RSS 地址。AI HOT 条目仅作为候选来源参与统一打分与筛选，发布产物的来源、描述一律按其**原始来源**（解析自 feed 的「阅读原文」链接与 `<author>` 标签），不出现 AI HOT 站点本身。

- [ ] **Step 3: 更新 `.agents/skills/daily-news-generate/SKILL.md`**

把「Sources:」段（当前第 77–78 行）改为：

```
**Sources:** `collect` reads `ENABLED_SOURCES`, which **defaults to `twitter,aihot`**. AI HOT pulls the
item-level `feed.xml` (50 curated items, no API key) and attributes each item to its **original source**
(the feed's "阅读原文" link + `<author>` label), so it enters the unified pool without surfacing the AI HOT
site. To also collect Substack, set `ENABLED_SOURCES=twitter,substack,aihot` plus the required Substack env
(`SUBSTACK_PUBLICATION_URL`, etc.) in `.env`. To disable AI HOT, set `ENABLED_SOURCES=twitter`. A Twitter-only
run is therefore opt-out (set `ENABLED_SOURCES=twitter`), not the default.
```

- [ ] **Step 4: 验证文档一致 + 测试仍绿**

Run: `npm test`
Expected: 全绿（文档改动不影响测试）。

校验命令（应均有命中）：

```bash
grep -n "aihot" .env.example docs/design.md .agents/skills/daily-news-generate/SKILL.md
```

- [ ] **Step 5: 提交**

```bash
git add .env.example docs/design.md .agents/skills/daily-news-generate/SKILL.md
git commit -m "docs: AI HOT 源文档与 env 示例"
```

---

## 验收（实现完成后人工确认）

- `npm test` 全绿。
- `ENABLED_SOURCES=aihot node --import tsx -e "import('./src/collect.ts').then(async m=>{const s=await m.collect({sources:{twitter:{lastPublishedTime:0},substack:{lastPublishedTime:0},aihot:{lastPublishedTime:0}}} as any);console.log(s.items.length, s.enabledSources)})"`（或等价的 skill `collect`）：aihot 条目入 `pending-draft.json`，`url` 全为原始来源、`text` 无 `via AI HOT`、`sourceLabel` 为原始来源标签。
- 不设 `ENABLED_SOURCES` 时（默认）：候选池含 aihot 条目并与 twitter 同池竞争；与同 URL 的 twitter 条目不重复刷屏（`rank.ts` 判 `duplicateOf`）。
- 发布产物（substack HTML / Obsidian）中源自 aihot 的条目链接与署名均为原始来源，**全文无 `AI HOT` / `aihot.virxact.com`**。
