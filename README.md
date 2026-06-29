# daily-news

AI 驱动的每日资讯日刊系统。一条命令完成：Twitter / Substack 采集 → AI 筛选 → 人工复选 → Obsidian 备份 + Substack 草稿。

## 工作流程

```
npm run generate
    │
    ├─ 1. 采集  → 拉取 Twitter 列表 + X For You 推荐流 + 已订阅 Substack publication 新文章
    ├─    暂存  → 采集成功后立即写入 pending draft，后续失败可恢复
    ├─ 2. 归一化 → 对 Twitter 条目抽取正文 / replies 外链；若 tweet 只是宣发或摘要，则改用外链作为主 source
    ├─ 3. 预读  → 用额外的快模型读完 Substack 全文并压缩成 briefing，供后续排序和整理复用
    ├─ 4. 排序  → 推荐流先过 AI 相关性预筛，再基于外链证据、briefing、新鲜度和重复关系做候选池裁剪
    ├─ 5. 整理  → 主模型基于跨来源文本 + briefing + 媒体元数据筛选并归纳为 40-50 条结构化资讯，按 Product / Tutorial / Opinions/Thoughts 分组
    ├─ 6. 复选  → 终端交互，人工勾选 6-10 条
    ├─ 7. 格式化 → 生成 Obsidian Markdown + Substack HTML（附带图片会渲染照片）
    └─ 8. 发布  → 保存到 Obsidian Vault / output/ 目录

npm run generate:review
    │
    ├─ 若已有 pending draft，先采集 fresh 内容并合并成一份新草稿
    ├─ 跑完预读 / 排序 / AI 整理
    ├─ 写入 output/YYYY-MM-DD-review.json + output/YYYY-MM-DD-review.md
    └─ 保留 pending draft，不复选、不发布、不推进 state.json
```

偏好学习闭环：

```bash
npm run preferences:update
npm run preferences:review
```

`generate` 在人工 `select` 确认后会把本次全候选结构化特征和最终选择结果追加到本机私有历史。`preferences:update` 会回填历史 `selection-report` 并生成偏好画像和建议；`preferences:review` 只把你勾选确认的建议写入生效规则，后续 X For You 预筛和 ranking 才会使用这些规则。

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

用编辑器打开 `.env`，按注释填写各项配置。若启用 `substack` 来源，建议填写 `SUBSTACK_PUBLICATION_URL` 以读取你公开 follow 的 publications；仓库内显式配置的 pinned publication（如 Ben's Bites）即使未出现在你的 follow 列表里也会照常抓取。

### 3. 运行

```bash
npm run generate
```

交互发布仍然走 `npm run generate`。如果要交给 Codex 自动化先准备审阅材料，使用：

```bash
npm run generate:review
```

`generate:review` 是非交互模式：发现 `data/pending-draft.json` 时会用这份草稿的采集时间作为临时游标继续采集 fresh 内容，并把新旧条目去重合并回同一份草稿；没有草稿时会重新采集并先写入草稿。它只生成审阅包，不会进入 checkbox 复选、不会写 Obsidian/Substack 发布产物、不会推进 `data/state.json`，也不会清空草稿。审阅后继续发布时，再运行 `npm run generate`，选择 `resume`，然后人工勾选最终条目。

当前 Codex 自动化建议配置为每天 Asia/Singapore 时间 09:00 运行 `npm run generate:review`，并在结果里汇报审阅包路径与失败阶段。

如果要确认自动化环境是否和手动终端一致，先运行：

```bash
npm run generate:review:diagnose
```

该命令会在同一个 Node 入口里打印运行时指纹（cwd、父进程、PATH、代理变量、`node/npm/twitter/curl` 路径、draft/state 文件状态），并用真实的 child-process 路径执行 `twitter list --max 5 --json` 和代理 `curl` 检查；它不会进入 AI 整理、复选或发布。

---

## 环境变量说明

### 启用来源

| 变量 | 说明 |
|------|------|
| `ENABLED_SOURCES` | 逗号分隔，可选 `twitter`、`substack` |

### Twitter 采集

| 变量 | 必填 | 说明 |
|------|------|------|
| `HTTP_PROXY` / `HTTPS_PROXY` / `NO_PROXY` | 否 | 项目级代理入口；采集时会同时转发给 Substack 抓取和 `twitter-cli`（内部会映射为 `TWITTER_PROXY` + `HTTP_PROXY` + `HTTPS_PROXY`）。此外进程内的 `fetch`（DeepSeek / OpenAI 等 AI 调用）也会遵循这些变量（Node 20 内置 `fetch` 默认忽略代理，已通过 undici 全局 dispatcher 显式启用）；大小写均可，未设置时直连 |
| `TWITTERAPI_KEY` | 否 | twitterapi.io API Key，作为 `twitter-cli` 失败后的回退数据源 |
| `TWITTER_LIST_ID` | 否 | 要采集的 Twitter 列表 ID，默认已填入 AI/Tech 列表 |
| `ENABLE_TWITTER_RECOMMENDATIONS` | 否 | 是否额外采集 X For You 推荐流，默认启用；设为 `false` / `0` / `no` 可关闭 |
| `TWITTER_RECOMMENDATION_CDP_ENDPOINT` | 否 | 推荐流专用账号所在的 CDP Chrome 地址，默认 `http://127.0.0.1:9222` |
| `TWITTER_RECOMMENDATION_BATCH_SIZE` | 否 | 推荐流每批最多拉取多少条，默认 `50` |
| `TWITTER_RECOMMENDATION_BATCH_COUNT` | 否 | 推荐流批次数，默认 `6`；每批结果会按 tweet ID 去重后再进入 AI 预筛 |
| `TWITTER_RECOMMENDATION_BATCH_MIN_DELAY_MS` | 否 | 推荐流批间随机等待下限，默认 `8000` |
| `TWITTER_RECOMMENDATION_BATCH_MAX_DELAY_MS` | 否 | 推荐流批间随机等待上限，默认 `20000` |
| `TWITTER_RECOMMENDATION_FILTER_MODEL` | 否 | 推荐流 AI 相关性预筛模型，默认 `gpt-4o-mini` |

说明：Twitter 外链页面抓取仅用于补充上下文，属于 best-effort；如果目标站点屏蔽抓取、限流或超时，会跳过外链解析并保留原始 tweet。X List 继续使用 `twitter-cli` 的默认认证路径；X For You 推荐流每次从 CDP Chrome 读取专用新账号的 `auth_token` / `ct0` 并临时注入子进程，不写入 `.env`。推荐流默认分 `6` 批采集，每批 `50` 条，批间随机等待 `8-20` 秒；批量结果按 tweet ID 去重后再进入 AI 相关性预筛。如果未检测到 CDP 浏览器登录，交互运行会询问是否现在登录后重试；选择不重试或非交互运行时，会跳过推荐流并在 review / selection report 中记录 warning。如果 `twitter-cli` 的推荐流分页或超时返回 `Query: Unspecified` / `Timeout: Unspecified`，当前批次会降级重试最近 `20` 条并记录 warning；其他批次失败会保留已采到内容、停止后续推荐流批次并记录 warning。`twitter-cli` 在失败时可能把结构化错误写到 `stdout`、把诊断 warning 写到 `stderr`；项目会优先展示结构化错误消息，便于排查认证和代理问题。

**获取 twitterapi.io API Key：**
1. 前往 [https://twitterapi.io](https://twitterapi.io) 注册账号
2. 进入 Dashboard → API Keys，创建一个新 Key
3. 复制填入 `.env`

### AI 配置（二选一）

**主路径 — OpenAI（推荐）：**

| 变量 | 说明 |
|------|------|
| `OPENAI_API_KEY` | OpenAI API Key |
| `OPENAI_MODEL` | 模型名，默认 `gpt-4o` |
| `SUBSTACK_READER_MODEL` | Substack 全文预读模型，默认 `gpt-4o-mini` |

**备用路径 — 第三方 API 聚合商：**

当 `OPENAI_API_KEY` 为空时自动启用，适合使用兼容 OpenAI 格式的聚合服务。

| 变量 | 说明 |
|------|------|
| `AI_BASE_URL` | 聚合商 API 地址（如 `https://api.example.com/v1`） |
| `AI_API_KEY` | 聚合商 API Key |
| `AI_MODEL` | 模型名 |

### Obsidian

| 变量 | 说明 |
|------|------|
| `OBSIDIAN_VAULT_PATH` | Vault 中保存日刊的目录绝对路径，如 `/Users/you/Vault/daily-news` |

留空则跳过 Obsidian 保存，仅输出到 `output/` 目录。配置后会在该目录下按月保存到 `YYYY-MM/` 子目录。

### Substack

| 变量 | 说明 |
|------|------|
| `SUBSTACK_PUBLICATION_URL` | 你的 Substack 发布地址，如 `https://yourname.substack.com`。程序会从对应公开个人页读取你 follow 的 publications；未配置时仍会继续抓取仓库内显式配置的 pinned publications |
| `SUBSTACK_SOURCE_MAX_POSTS` | 每次最多纳入多少篇新文章，默认 `40` |
| `SUBSTACK_SOURCE_MAX_POSTS_PER_PUBLICATION` | 每个 publication 每次最多纳入多少篇文章，默认 `2` |

> 说明：当前版本同时支持 Substack 输入与输出。输入会读取你的公开个人页中展示的 followed publications，并与仓库内显式配置的 pinned publications 合并，再抓取这些 publication 的公开 RSS feed。也就是说，这条路径只覆盖公开文章，不依赖 `substack.sid` / `connect.sid` Cookie。公开 RSS 抓取按 publication best-effort 处理；如果单个站点因为坏重定向、TLS 或超时失败，会记录 warning 并跳过该 publication，不会中断整次生成。

---

## 发布到 Substack

每次运行后，Substack 格式文件保存在：

```
output/YYYY-MM-DD-substack.html
```

### 方法一：复制 HTML（推荐）

1. 用浏览器打开 `output/YYYY-MM-DD-substack.html`
2. 全选（`Cmd+A`）并复制（`Cmd+C`）
3. 打开 Substack 编辑器：[https://substack.com/publish/post/new](https://substack.com/publish/post/new)
4. 在正文区域粘贴（`Cmd+V`），Substack 会自动识别 HTML 格式
5. 补填标题与副标题，预览后发布

### 方法二：手动录入

1. 登录 Substack，新建文章
2. 参考 `output/` 文件，逐条粘贴标题和摘要
3. 为每条资讯添加原文链接

### Substack 输入限制

1. 公开 follow 路径只会读取你公开个人页里可见的 followed publications；另外仓库也可以显式 pin 某些 publication（当前包括 Ben's Bites）
2. 只会抓取这些 publication 的公开 RSS 内容
3. 付费、私有、仅订阅者可见的文章不会被这条采集路径纳入

### Ben's Bites roundup 展开

1. `https://www.bensbites.com/` 作为仓库内置的 pinned publication，会独立于 `SUBSTACK_PUBLICATION_URL` 抓取
2. 系统会保留整篇 Ben's Bites newsletter 作为原始 Substack 条目
3. 如果文章正文里存在稳定的 `heading + bullet list` roundup 结构，会额外把其中每条 bullet 展开成独立子条目
4. 展开后的子条目会在 `select` 阶段平铺显示，保留 newsletter 原文链接作为 `originUrl`，并把 bullet 中的外部链接作为最终 `url`
5. 面向读者的 `来源` 使用 bullet 外部链接的锚文本；锚文本为空时退回外部链接域名，不显示 Ben's Bites 这条采集渠道
6. 当前只对仓库显式配置为 roundup 的 publication 启用这套拆分逻辑，不会自动作用于所有 Substack

---

## 输出文件

| 路径 | 说明 |
|------|------|
| `output/YYYY-MM-DD-substack.html` | Substack 格式 HTML，每次运行生成 |
| `output/YYYY-MM-DD-review.json` | 非交互审阅包，包含采集时间、来源、排序元数据、AI 整理结果和下一步命令 |
| `output/YYYY-MM-DD-review.md` | 面向人工和 Codex 摘要的审阅版 Markdown |
| `$OBSIDIAN_VAULT_PATH/YYYY-MM/YYYY-MM-DD-daily-news.md` | Obsidian Markdown（配置后生成） |
| `data/state.json` | 已成功走完整理并发布到本地输出的最近发布时间游标，用于增量采集 |
| `data/pending-draft.json` | 采集成功但尚未走完整个发布链路的暂存草稿 |
| `data/preference-history.jsonl` | 本机私有的人工选择历史，记录每次 select 的全候选结构化特征与选中/未选中结果 |
| `data/preference-profile.json` | 本机私有的偏好画像，由历史选择汇总生成 |
| `data/preference-suggestions.json` | 本机私有的待确认偏好建议 |
| `data/preference-rules.json` | 本机私有、经人工确认后才生效的采集/排序偏好规则 |

---

## 媒体处理

- 采集阶段会尽量保留来源中的媒体元数据（图片、视频、GIF 的类型、URL、尺寸）
- Substack 来源当前只提取封面图为 `photo`
- AI 整理阶段只接收媒体元数据，不直接看图片本身；Substack 正文会先交给一个快模型读完并压缩成 briefing，再交给主整理模型
- 发布阶段当前只渲染图片（`photo`）；视频和 GIF 会保留在内部数据中，但不会嵌入 Obsidian / Substack 输出

---

## 运行原理

- **按来源增量采集**：每个来源都会用 `data/state.json` 中记录的最近一次成功发布采集时间作为增量游标；首次运行默认各自回溯 24 小时
- **可恢复草稿**：只要采集成功，就会先把原始采集结果写入 `data/pending-draft.json`。如果后续 Substack 预读、AI 整理、人工复选或本地发布阶段失败，下次运行会先提示是继续发布这份历史草稿、丢弃后重新采集，还是直接取消
- **发布游标 SSOT**：`data/state.json` 只在本地发布阶段成功结束后才推进，记录每个来源最近一次成功发布到本地产物的采集时间；单纯采集成功不会推进这个游标，避免分析失败后丢稿
- **自动化审阅模式**：`npm run generate:review` 复用同一条采集、预读、排序和 AI 整理链路，但停止在人工复选前。已有 pending draft 时，它会先从草稿采集时间继续采集 fresh 内容，按条目 ID 和来源 URL 去重合并后再写回同一份草稿；发布游标仍不推进，方便后续交互发布从合并后的采集结果继续
- **双数据源**：X List 优先使用 `twitter-cli`（可带 cookies / 代理，且能保留更完整的媒体信息），失败时自动切换到 `twitterapi.io`；X For You 推荐流使用 CDP Chrome 中登录的新账号 Cookie，失败时只跳过推荐流
- **Twitter source 归一化**：会先抽取 tweet 正文里的外链；必要时再看 1-3 条 replies。即使 tweet 本身较长，只要它仍明显是在转述/分发外链内容，最终条目的 `url` 也会切到外部页面；只有当 tweet 明显是独立分析且与外链上下文重叠很低时，才继续保留 X origin。原 tweet permalink 会保留在内部元数据与 selection report 中
- **Substack 输入**：通过公开个人页枚举你 follow 的 publications，并与仓库内 pinned publications 合并，再抓取这些 publication 的公开 RSS，按 publication 限流后再全局排序截断
- **公开 RSS 容错**：单个 publication 的 feed 若因为站点自身重定向、TLS 或超时异常而抓取失败，会打印带 publication/feed URL/代理信息的 warning，并继续处理其余 publications
- **Roundup 展开**：对显式配置为 roundup 的 publication，采集阶段会保留原 newsletter，同时按正文里的 `heading + bullet list` 结构展开子条目。当前 Ben's Bites 的子条目会被强制纳入 `select`，避免只保留整篇 newsletter 而错过其中的单条产品/教程/讨论链接；最终发布的 `来源` 使用 bullet 外部链接的锚文本或域名，而不是 Ben's Bites
- **全文预读**：Substack 正文先由 `SUBSTACK_READER_MODEL` 读取并压缩为结构化 briefing，避免把整篇文章直接塞给主整理模型；同一份 briefing 会在排序和主整理之间复用。briefing 里的列表字段在模型返回 `null` 或缺失时会归一成空数组，`whyItMatters` 可为空字符串，不再因为单篇文章缺少 caveat/signals/why 而整次中断。若 RSS 只暴露订阅墙/预览内容，则保留该条用于审计，但跳过全文 briefing、排序降权，并在候选理由中标记 `订阅墙/预览内容`
- **显式排序层**：主整理模型之前先做确定性打分、重复惩罚与候选池裁剪；Substack 长文会先带着 briefing 参与 ranking，避免只看 RSS teaser 造成误判。互动数据只作为 Twitter 的辅助信号；当前候选池稳定上限为 `150`
- **推荐流预筛**：X For You scope 更宽，进入 source resolution 和 ranking 前会先用快模型读取每条前 500 字，只保留 AI 模型、AI 产品、agent/devtools、ML research、AI infra、benchmark、AI 行业结构等相关内容
- **按 canonical source 去重**：如果多条 tweet 指向同一个官方页面，会优先按最终 source URL 做重复惩罚，再退回文本级重复判断。主整理模型返回后还会再次校验：只保留 ID 与 source URL 都可信匹配的条目；若模型返回的是已知原帖 URL 或只差 `utm_*` / `ref` 等追踪参数，会纠正回采集到的 canonical URL，否则按原因丢弃。selection report 会记录丢弃计数、样例和 URL 纠正记录，方便回看低产出是否来自内容不足还是校验丢弃
- **编辑偏好配置**：ranking 支持仓库内维护的作者级硬过滤名单和加权规则；当前默认对 `@tom_doerr` 做硬过滤，避免高频 GitHub 项目转发账号进入候选池
- **AI 双路径**：优先使用 `OPENAI_API_KEY`，未配置时自动切换到 ai-sdk 聚合商路径
- **交互选择**：使用 `@inquirer/prompts` 的 checkbox，空格选中/取消，回车确认；每个候选项会显示来源、评分提示和最多 3 行摘要预览，便于人工决策
- **偏好闭环**：人工 `select` 后会记录全候选的结构化特征、正负选择结果和排序/LLM 选择状态；不记录完整正文、HTML、cookie 或 token。历史统计只生成建议，必须通过 `npm run preferences:review` 人工确认后，才会反哺 X For You 预筛提示和 ranking 加降权
- **审阅包**：自动化模式会额外写出 `output/<date>-review.json` 和 `output/<date>-review.md`，供定时任务汇报和人工预读；如果跳过一天，下一次 09:00 review 会先追加新内容到同一份 pending draft。v1 不做隐藏自动精选，最终 6-10 条仍由人工复选决定
- **图片输出**：最终 Obsidian Markdown 与 Substack HTML 会在摘要后插入来源中的图片
- **固定分组**：发布输出按 `Product`、`Tutorial`、`Opinions/Thoughts` 三组组织，不再展示条目标签
- **决策可追踪**：每次运行会额外写出 `output/<date>-selection-report.json`，记录分数、候选池、AI 入选、人工入选状态和 curation 诊断信息

---

## 项目结构

```
daily-news/
├── src/
│   ├── generate.ts    # 主入口，串联五步 pipeline
│   ├── collect.ts     # Twitter / Substack 采集、归一化、pinned publication 与 roundup 展开
│   ├── rank.ts        # 显式优先级打分、重复惩罚、候选池筛选
│   ├── ranking-preferences.ts # 仓库内维护的编辑偏好规则（如作者降权）
│   ├── curate.ts      # Substack 全文预读 + 主整理模型 + roundup 强制摘要补全
│   ├── draft.ts       # pending draft 的读写与清理
│   ├── select.ts      # 交互式人工复选
│   ├── format.ts      # Obsidian + Substack 格式化
│   ├── publish.ts     # 输出保存
│   ├── preferences.ts # 本机私有选择历史、偏好画像、确认规则
│   ├── preferenceCli.ts # 偏好画像更新与规则确认 CLI
│   ├── review.ts      # 非交互审阅包输出
│   ├── state.ts       # 已发布游标状态持久化
│   └── types.ts       # 共享类型定义
├── prompts/
│   └── curator.md     # AI curation prompt 模板（固定三分类）
├── data/
│   ├── state.json     # 已发布游标状态（自动生成）
│   └── pending-draft.json # 未完成发布链路的暂存草稿（自动生成）
├── output/            # 生成的 Substack HTML + selection report
├── .env.example       # 环境变量模板
└── README.md
```
