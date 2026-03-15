# daily-news

AI 驱动的每日资讯日刊系统。一条命令完成：Twitter / Substack 采集 → AI 筛选 → 人工复选 → Obsidian 备份 + Substack 草稿。

## 工作流程

```
npm run generate
    │
    ├─ 1. 采集  → 拉取 Twitter 列表 + 已订阅 Substack publication 新文章
    ├─ 2. 预读  → 用额外的快模型读完 Substack 全文并压缩成 briefing
    ├─ 3. 整理  → 主模型基于跨来源文本 + briefing + 媒体元数据筛选并归纳为 30+ 条结构化资讯
    ├─ 4. 复选  → 终端交互，人工勾选 6-10 条
    ├─ 5. 格式化 → 生成 Obsidian Markdown + Substack HTML（附带图片会渲染照片）
    └─ 6. 发布  → 保存到 Obsidian Vault / output/ 目录
```

## 快速开始

### 1. 安装依赖

```bash
npm install
```

### 2. 配置环境变量

```bash
cp .env.example .env
```

用编辑器打开 `.env`，按注释填写各项配置。若启用 `substack` 来源，至少需要填写 `SUBSTACK_PUBLICATION_URL`。

### 3. 运行

```bash
npm run generate
```

---

## 环境变量说明

### 启用来源

| 变量 | 说明 |
|------|------|
| `ENABLED_SOURCES` | 逗号分隔，可选 `twitter`、`substack` |

### Twitter 采集

| 变量 | 必填 | 说明 |
|------|------|------|
| `TWITTER_PROXY` | 否 | `twitter-cli` 使用的代理，默认 `http://127.0.0.1:6152` |
| `TWITTERAPI_KEY` | 否 | twitterapi.io API Key，作为 `twitter-cli` 失败后的回退数据源 |
| `TWITTER_LIST_ID` | 否 | 要采集的 Twitter 列表 ID，默认已填入 AI/Tech 列表 |

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

留空则跳过 Obsidian 保存，仅输出到 `output/` 目录。

### Substack

| 变量 | 说明 |
|------|------|
| `SUBSTACK_PUBLICATION_URL` | 你的 Substack 发布地址，如 `https://yourname.substack.com`。程序会从对应公开个人页读取你 follow 的 publications |
| `SUBSTACK_SOURCE_MAX_POSTS` | 每次最多纳入多少篇新文章，默认 `40` |
| `SUBSTACK_SOURCE_MAX_POSTS_PER_PUBLICATION` | 每个 publication 每次最多纳入多少篇文章，默认 `2` |

> 说明：当前版本同时支持 Substack 输入与输出。输入会读取你的公开个人页中展示的 followed publications，再抓取这些 publication 的公开 RSS feed。也就是说，这条路径只覆盖公开文章，不依赖 `substack.sid` / `connect.sid` Cookie。

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

1. 只会读取你公开个人页里可见的 followed publications
2. 只会抓取这些 publication 的公开 RSS 内容
3. 付费、私有、仅订阅者可见的文章不会被这条采集路径纳入

---

## 输出文件

| 路径 | 说明 |
|------|------|
| `output/YYYY-MM-DD-substack.html` | Substack 格式 HTML，每次运行生成 |
| `$OBSIDIAN_VAULT_PATH/YYYY-MM-DD-daily-news.md` | Obsidian Markdown（配置后生成） |
| `data/state.json` | 记录上次运行时间，用于增量采集 |

---

## 媒体处理

- 采集阶段会尽量保留来源中的媒体元数据（图片、视频、GIF 的类型、URL、尺寸）
- Substack 来源当前只提取封面图为 `photo`
- AI 整理阶段只接收媒体元数据，不直接看图片本身；Substack 正文会先交给一个快模型读完并压缩成 briefing，再交给主整理模型
- 发布阶段当前只渲染图片（`photo`）；视频和 GIF 会保留在内部数据中，但不会嵌入 Obsidian / Substack 输出

---

## 运行原理

- **按来源增量采集**：`data/state.json` 分别记录 Twitter 与 Substack 的上次运行时间，首次运行默认各自回溯 24 小时
- **双数据源**：优先使用 `twitter-cli`（可带 cookies / 代理，且能保留更完整的媒体信息），失败时自动切换到 `twitterapi.io`
- **Substack 输入**：通过账号 cookies 枚举你 follow 的 publications，抓取新发布文章，按 publication 限流后再全局排序截断
- **全文预读**：Substack 正文先由 `SUBSTACK_READER_MODEL` 读取并压缩为结构化 briefing，避免把整篇文章直接塞给主整理模型
- **AI 双路径**：优先使用 `OPENAI_API_KEY`，未配置时自动切换到 ai-sdk 聚合商路径
- **交互选择**：使用 `@inquirer/prompts` 的 checkbox，空格选中/取消，回车确认
- **图片输出**：最终 Obsidian Markdown 与 Substack HTML 会在摘要后插入来源中的图片

---

## 项目结构

```
daily-news/
├── src/
│   ├── generate.ts    # 主入口，串联五步 pipeline
│   ├── collect.ts     # Twitter / Substack 采集、归一化与来源级增量状态
│   ├── curate.ts      # Substack 全文预读 + 主整理模型（OpenAI / ai-sdk）
│   ├── select.ts      # 交互式人工复选
│   ├── format.ts      # Obsidian + Substack 格式化
│   ├── publish.ts     # 输出保存
│   ├── state.ts       # 状态持久化
│   └── types.ts       # 共享类型定义
├── prompts/
│   └── curator.md     # AI curation prompt 模板
├── data/
│   └── state.json     # 运行状态（自动生成）
├── output/            # 生成的 Substack HTML
├── .env.example       # 环境变量模板
└── README.md
```
