# AI HOT 条目源接入 — 设计文档

**Goal:** 把 AI HOT（aihot.virxact.com）的条目级 RSS 作为第三个采集源接入 daily-news，与 twitter / substack 并列，参与统一的 AI 预选打分与人工筛选池；最终发布的来源、描述一律按**原始来源**，不提及 AI HOT 站点本身。

**Architecture:** 新增 `SourceName = 'aihot'`，采集器解析该站条目级 RSS，把每条 `<item>` 映射成一个 `CollectedItem`，其 `url`/`originUrl` 指向**原始来源 URL**（feed 内的「🔗 阅读原文」链接），归属字段来自 `<author>` 中的原始来源标签。复用既有 RSS 解析、URL 归一化、跨来源去重与 enrich 归属路径，使其天然进入统一筛选池并避免与 twitter 重复刷屏。

**Tech Stack:** TypeScript、Node 内建 `fetch`/既有 curl+proxy 抓取路径、Node test runner

---

## 1. 背景与数据源事实

页面 `https://aihot.virxact.com/agent?tab=api` 暴露多个匿名 RSS（无需 API Key）：

| Feed | 内容 | 是否采用 |
|---|---|---|
| `feed/daily.xml` | **日报级**导语，每个 `<item>` = 整天日报的一句话标题 | ❌ 非条目级，无法参与条目打分 |
| `feed/all.xml` | 最近 7 天全部公开动态，按真实发布时间倒序 | ❌（备选） |
| **`feed.xml`** | 最新 **50 条精选摘要** | ✅ **默认**（精度更高，用户选定） |
| `feed/full.xml` | 全文版（`feed.xml` 描述中提及） | 备选，env 可切 |

**决策：** 默认采用 `feed.xml`（50 条精选，精度优先）；feed URL 经 env `AIHOT_FEED_URL` 暴露，默认 `https://aihot.virxact.com/feed.xml`，未来可切 `feed/full.xml` / `feed/all.xml` 而无需改代码。

### `feed.xml` 单条 `<item>` 结构（关键字段）

```xml
<item>
  <title><![CDATA[OpenRouter 推出专用 LangChain 集成包，支持 400+ 模型与自动故障切换]]></title>
  <link>https://aihot.virxact.com/items/cms5dje230234ro7czv3o3wap</link>
  <description><![CDATA[
    <p>OpenRouter 发布了 langchain-openrouter（Python）和 @langchain/openrouter（TypeScript）专用包……</p>
    <p>🔗 <a href="https://openrouter.ai/blog/tutorials/langchain-chatopenrouter-setup">阅读原文</a></p>
    <p>via AI HOT · <a href="https://aihot.virxact.com/items/...">https://aihot.virxact.com/items/...</a></p>
  ]]></description>
  <category>技巧观点</category>
  <pubDate>Wed, 29 Jul 2026 00:00:00 GMT</pubDate>
  <guid isPermaLink="false">cms5dje230234ro7czv3o3wap</guid>
  <author>noreply@aihot.virxact.com (OpenRouter：Announcements（RSS）)</author>
</item>
```

原始来源信息分散在两处：
- **`<author>`** 形如 `noreply@aihot.virxact.com (<原始来源标签>)`，例如 `(IT之家（RSS）)` / `(X：Tibo (@thsottiaux))` / `(OpenRouter：Announcements（RSS）)`。
- **`<description>`** 正文末尾有「🔗 阅读原文」`<a href>` 指向**原始 URL**（`x.com/...`、`ithome.com/...`、`openrouter.ai/blog/...`），外加一行 `via AI HOT · <站内链接>` 页脚。

## 2. RSS → CollectedItem 映射

| `CollectedItem` 字段 | 取值 | 说明 |
|---|---|---|
| `id` | `<guid>` 原值（如 `cms5dje230234ro7czv3o3wap`） | 稳定唯一；enricher 按精确 id 匹配 |
| `source` | `'aihot'` | 新增 `SourceName` |
| `url` / `originUrl` | **原始 URL**，经归一化（见 §3） | 来自 description 的「阅读原文」`href`；不是站内 `/items/` 链接 |
| `title` | `<title>`（中文标题） | |
| `text` | description 正文，**剥掉**末尾 `via AI HOT` 段落与「🔗 阅读原文」锚点行后的纯文本 | 用既有 `stripHtml`；只保留摘要正文 |
| `author.name` | 解析自 `<author>` 的原始来源标签，去掉尾部 `（RSS）`/`(RSS)` 传输标记 | 例如 `IT之家`、`X：Tibo (@thsottiaux)`、`OpenRouter：Announcements` |
| `author.username` | 若标签内含 `@handle`（X 来源）则取该 handle，否则 `undefined` | 提升 X 类条目的归属一致性 |
| `sourceLabel` | 同 `author.name` | **驱动发布归属**：`getAttribution` 优先返回 `sourceLabel`（curate.ts:195），成品永不出现 AI HOT |
| `publishedAt` | `<pubDate>` → ISO 字符串 | |
| `media` | `[]` | feed 无图；如出现 `<enclosure>` 可后续增强（YAGNI 暂不做） |
| 互动指标 | 不设置 | engagement 计 0，纯靠 substance/evidence 打分 |
| `forceSelect` | 不设置（`undefined`） | 与 twitter/substack 一样按分竞争，不强制入选 |

`<category>`（行业动态 / AI 产品 / AI 模型 / 技巧观点）**不落字段**：最终分类由 curation 阶段的 agent 依据标题/正文判定（既有行为），AI HOT 分类仅作隐含线索、无独立字段承接（YAGNI）。

## 3. URL 归一化（跨来源去重的前提）

`rank.ts:applyDuplicatePenalties` 按 `item.url` **精确字符串**分组去重。为让 AI HOT 条目与同源的 twitter 条目命中同一组，采集器对原始 URL 做与 twitter 一致的归一化：

- X / twitter 域名 → 复用 `normalizeTwitterStatusUrl(raw)`（同 host `x.com`、去 hash、去 utm/ref/s、去尾斜杠），与 `buildTweetUrl` 产出的 `https://x.com/{user}/status/{id}` 形态对齐。
- 其他域名 → 复用既有导出函数 `normalizeExternalUrl(raw)`。
- 解析失败 / 无「阅读原文」链接 → **丢弃该条**并计入 collection warning（fail loud，不静默吞）。

> 已知限制：跨来源 X 去重依赖 URL 精确匹配（含 screenName 大小写）。命中常见情况即可满足"不重复刷屏"诉求；文本指纹去重（`byFingerprint`）因中文摘要 ≠ 原推文而无法兜底，属可接受折衷。

## 4. 进入统一筛选池的行为（既有机制，无需新代码）

1. `collectSources`（collect.ts:3002）已用 `Promise.allSettled` 并发各源、合并 `CollectedItem[]` 后按时间排序——aihot 条目自动并入。
2. `rank.ts` 打分 + `applyDuplicatePenalties`：aihot 条目与 twitter/substack 同池竞争，相同原始 URL 的重复条目判 `duplicateOf` 并降权，分高者留。
3. `curate-input` 取候选池前 N（默认 80），aihot 条目照常进入供 agent 策展。
4. agent 策展写入 `curate-output.json`（id/url 照抄候选），`curate-apply` 的 `enrichCuratedItemsWithDiagnostics` 解析归属：`getAttribution` 返回 `sourceLabel`（原始来源），`url` 取候选原始 URL——**发布物链接原始来源、署名原始来源，全文不出现 AI HOT**。

## 5. 时间窗与状态推进

- 采集器按 `sinceTime` 过滤（复用 `filterSinceTime`），与 twitter/substack 一致。
- 首次运行：aihot 无 `lastPublishedTime` → 回退 `now - 24h`（`DEFAULT_LOOKBACK_SECONDS`）。`feed.xml` 虽含 50 条，但仅近 24h 内的入选（符合"今日"语义；精度优先即可能偏少，切 `feed/all.xml` 可增召回）。
- 发布成功后 `advancePublishedState` 把 aihot 的 `lastPublishedTime` 推进到本次 `collectedAt`，下次滑窗。

## 6. 失败处理（默认开启的安全性）

aihot 默认开启是安全的：feed 不可达时 `Promise.allSettled` 把异常转为 collection warning，**不影响** twitter 采集（与 substack opt-in 不同，aihot 无需任何额外凭证，仅依赖既有 curl+proxy 抓取与默认 feed URL）。

## 7. 配置

| Env | 默认 | 说明 |
|---|---|---|
| `AIHOT_FEED_URL` | `https://aihot.virxact.com/feed.xml` | 条目级 RSS；可切 `feed/full.xml` / `feed/all.xml` |
| `AIHOT_SOURCE_MAX_ITEMS` | `50` | 单次采集上限（feed.xml 本就 ≤50，作保护性上界） |
| `ENABLED_SOURCES` | **`twitter,aihot`**（新增 aihot） | 显式设 `twitter` 可关闭 aihot；substack 仍 opt-in |

`parseEnabledSources()` 改动两处：默认值 `'twitter' → 'twitter,aihot'`；空回退 `['twitter'] → ['twitter','aihot']`。

## 8. 代码改动范围

1. **`src/types.ts`** — `SourceName` 加 `'aihot'`；`RunState.sources` 加 `aihot: SourceRunState`。
2. **`src/state.ts`** — `createEmptyState` 与 `normalizeRunState` 补 aihot（含 `getLastPublishedTime` 泛化）。
3. **`src/collect.ts`** — 新增 `collectAihotItems()`（解析 RSS → `CollectedItem[]`，复用 `cleanXmlText`/`extractXmlTag`/`decodeHtmlEntities`/`stripHtml`/`normalizeTwitterStatusUrl`/`normalizeExternalUrl`/`filterSinceTime`）；在 `collect()` 的 collectors map 注册 aihot；`parseEnabledSources()` 放行 aihot 并改默认。
4. **`src/generate.ts:98`** `advancePublishedState` — 初始 `nextState.sources` 对象补 aihot；循环守卫 `source === 'twitter' || 'substack'` 加 `|| 'aihot'`。
5. **`src/draft.ts:13`** `normalizeEnabledSources` 过滤器加 `|| 'aihot'`。
6. **测试 `tests/collect.test.ts`** — TDD：RSS→CollectedItem 解析、原始 URL 提取与归一化、`via AI HOT` 页脚剥离、`（RSS）` 标记清理、`<author>` 标签解析、无阅读原文条目丢弃。`tests/state.test.ts` 补 aihot 源存在性。
7. **`docs`** — 更新 `docs/design.md`（若涉及来源章节）与 skill `SKILL.md` 的「Sources」段（默认源含 aihot、feed URL、env）；`.env.example` 加 `AIHOT_FEED_URL`。

## 9. 不做（YAGNI）

- 不接入 `feed/daily.xml`（日报级，非条目）。
- 不抓原始页全文（agent 策展时如需可按既有 skill 自行 fetch 单条 URL）。
- 不映射 AI HOT `<category>` 到独立字段。
- 不解析 `<media:content>` / `<enclosure>` 图片（feed.xml 无）。
- 不做模糊/语义去重（既有 URL + 文本指纹去重已满足诉求）。

## 10. 验收标准

- `npm test` 全绿，含新增 aihot 解析单测。
- 设 `ENABLED_SOURCES=aihot` 单独跑 `collect`：`data/pending-draft.json` 含 aihot 条目，`url` 全为原始来源、`text` 无 `via AI HOT`、`sourceLabel` 为原始来源标签。
- `npm run generate:review`（或 skill 的 curate 流程）后，候选池出现 aihot 条目并与既有 twitter 条目同池竞争；与同 URL twitter 条目不重复刷屏。
- 发布产物（substack HTML / Obsidian）中，凡源自 aihot 的条目，链接与署名均为原始来源，**全文无 "AI HOT" / "aihot.virxact.com" 字样**。
