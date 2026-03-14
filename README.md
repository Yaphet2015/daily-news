# daily-news

AI 驱动的每日资讯日刊系统。一条命令完成：Twitter 采集 → AI 筛选 → 人工复选 → Obsidian 备份 + Substack 草稿。

## 工作流程

```
npm run generate
    │
    ├─ 1. 采集  → 从 twitterapi.io 拉取 Twitter 列表增量推文（上限 500 条）
    ├─ 2. 整理  → AI 筛选并归纳为 30+ 条结构化资讯
    ├─ 3. 复选  → 终端交互，人工勾选 6-10 条
    ├─ 4. 格式化 → 生成 Obsidian Markdown + Substack HTML
    └─ 5. 发布  → 保存到 Obsidian Vault / output/ 目录
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

用编辑器打开 `.env`，按注释填写各项配置（至少填写 `TWITTERAPI_KEY` 和 AI 密钥）。

### 3. 运行

```bash
npm run generate
```

---

## 环境变量说明

### Twitter 采集

| 变量 | 必填 | 说明 |
|------|------|------|
| `TWITTERAPI_KEY` | ✅ | twitterapi.io API Key |
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
| `SUBSTACK_SID` | `substack.sid` Cookie 值（见下方获取步骤） |
| `SUBSTACK_CONNECT_SID` | `connect.sid` Cookie 值 |
| `SUBSTACK_PUBLICATION_URL` | 你的发布地址，如 `https://yourname.substack.com` |

> 注意：当前版本 Substack 相关变量预留，Substack 草稿通过本地 HTML 文件方式输出，见「发布到 Substack」章节。

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

### 获取 Substack Cookie（备用）

如需通过 API 操作：

1. 在浏览器登录 [https://substack.com](https://substack.com)
2. 打开开发者工具（`F12` 或 `Cmd+Option+I`）
3. 切换到 **Application** 标签 → **Cookies** → `https://substack.com`
4. 找到 `substack.sid` 和 `connect.sid`，复制各自的 **Value** 填入 `.env`

---

## 输出文件

| 路径 | 说明 |
|------|------|
| `output/YYYY-MM-DD-substack.html` | Substack 格式 HTML，每次运行生成 |
| `$OBSIDIAN_VAULT_PATH/YYYY-MM-DD-daily-news.md` | Obsidian Markdown（配置后生成） |
| `data/state.json` | 记录上次运行时间，用于增量采集 |

---

## 运行原理

- **增量采集**：`data/state.json` 记录上次运行的 Unix 时间戳，下次运行只拉取该时间点之后的新推文，首次运行默认回溯 24 小时
- **AI 双路径**：优先使用 `OPENAI_API_KEY`，未配置时自动切换到 ai-sdk 聚合商路径
- **交互选择**：使用 `@inquirer/prompts` 的 checkbox，空格选中/取消，回车确认

---

## 项目结构

```
daily-news/
├── src/
│   ├── generate.ts    # 主入口，串联五步 pipeline
│   ├── collect.ts     # twitterapi.io 推文采集
│   ├── curate.ts      # AI 整理（OpenAI / ai-sdk）
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
