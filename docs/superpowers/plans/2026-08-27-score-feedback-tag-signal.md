# 评分反馈、Tag 评分与工作流 SSOT 实施计划

**目标：** 在现有 Agent HTML select 页面加入“评分过高 / 评分过低”反馈。反馈立即持久化。publish 成功后，Agent 根据内容 Tag 审查反馈，并通过确定性校验更新下一期评分偏好。

**设计依据：** `docs/superpowers/specs/2026-08-27-score-feedback-tag-signal-design.md`

**执行方式：** 按本文顺序在当前仓库执行。每个任务先写失败测试，再做最小实现，再运行目标测试。Plan 本身不修改生产代码。

## 成功标准

- HTML 每条消息有两个互斥、可撤销的反馈按钮。
- 每次反馈点击立即原子写入 canonical selection decision。
- 刷新页面、重启 select server 后，反馈仍可恢复。
- publish 使用用户当时看到的 ranking artifact，不重新评分。
- publish 后先记录 selection history 和 score feedback history，再推进 state 和清理 draft。
- 有反馈时，Agent 在 publish 后生成并应用一个受约束 adjustment；无反馈时明确输出“本期无评分反馈”。
- 调整主要归因到内容 Tag。按钮反馈不能修改作者、域名、来源开关或 hard filter。
- `@tom_doerr` 保持硬过滤。
- 默认来源保持 `twitter,aihot`；Substack 保持可选。
- npm 与 Agent Skill 的 curator、reader brief、recommendation、候选池差异保持现状，并标记“待确认”。
- 无 overlay 时，现有分数、排序、duplicate 行为和候选池行为不变。
- 所有测试通过，且没有 skipped test。

## SSOT 边界

| 领域 | 唯一权威位置 |
|---|---|
| 来源 ID、默认来源、来源 metadata、state 推进 | `src/source-registry.ts` |
| Tag、Ranking Signal、matcher、baseline weights、overlay 合成 | `src/scoring-policy.ts` |
| 当期 ranking | `output/<date>-ranking.json` |
| 当期 curation | `output/<date>-curation.json` |
| 当期选择与评分反馈 | `output/<date>-selection-decision.json` |
| selection report 构造 | `src/selection-report.ts` |
| publish finalization | `src/publication-workflow.ts` |
| 用户确认的评分 overlay | `data/preference-rules.json` |
| 长期评分反馈历史 | `data/score-feedback-history.jsonl` |

`decisionReasons` 只用于展示。计算、持久化身份和学习都不能反向解析它。

---

## 阶段 A：工作流 SSOT 基础

### Task 1：建立 Source Registry

**文件**

- 新增：`src/source-registry.ts`
- 修改：`src/types.ts`
- 修改：`src/state.ts`
- 修改：`src/draft.ts`
- 修改：`src/collect.ts`
- 修改：`src/generate.ts`
- 修改：`.agents/skills/daily-news-generate/scripts/runtime.mjs`
- 测试：`tests/source-registry.test.ts`
- 测试：`tests/state.test.ts`
- 测试：`tests/draft.test.ts`
- 测试：`tests/collect.test.ts`
- 测试：`.agents/skills/daily-news-generate/tests/daily-news-agent.test.mjs`

**步骤**

- [ ] 先记录基线：运行 `npm test`、Agent test 和 `npx tsc --noEmit`。任何已有失败都先停下并报告。
- [ ] 写失败测试：registry 只包含 `twitter | substack | aihot`，默认值是 `twitter,aihot`。
- [ ] 写失败测试：只推进 enabled source 的 cursor；disabled source cursor 必须原样保留。
- [ ] 写失败测试：未知来源 fail loud；Substack 未启用时不要求 publication URL。
- [ ] 新增 `SOURCE_NAMES`、派生 `SourceName`、`SOURCE_REGISTRY`、`DEFAULT_ENABLED_SOURCES`、`normalizeSourceNames()` 和 `advancePublishedState()`。
- [ ] 删除 `src/generate.ts` 内的本地 `advancePublishedState()`。
- [ ] 删除 `.agents/skills/daily-news-generate/scripts/runtime.mjs` 内的本地 `advancePublishedState()`。
- [ ] 让 state、draft、collect、npm adapter 和 Agent adapter 都只调用 registry。
- [ ] 不读取或输出真实 `.env` 内容。
- [ ] 运行本任务测试和 `npx tsc --noEmit`。

### Task 2：建立 canonical ranking 与 curation artifact

**文件**

- 新增：`src/artifact-identity.ts`
- 新增：`src/artifact-codec.ts`
- 新增：`src/ranking-artifact.ts`
- 新增：`src/curation-artifact.ts`
- 修改：`src/types.ts`
- 修改：`src/generate.ts`
- 修改：`.agents/skills/daily-news-generate/scripts/runtime.mjs`
- 测试：`tests/artifact-identity.test.ts`
- 测试：`tests/ranking-artifact.test.ts`
- 测试：`tests/curation-artifact.test.ts`
- 测试：`tests/generate.test.ts`
- 测试：`.agents/skills/daily-news-generate/tests/daily-news-agent.test.mjs`

**步骤**

- [ ] 写失败测试：`runId` 对同一 collectedAt、enabledSources 和 item IDs 稳定；任一输入变化时改变。
- [ ] 写失败测试：`curationRevision` 对有序 item ID + canonical URL 稳定。
- [ ] 写失败测试：decoder 拒绝未知 schema、无效 identity、重复 item ID 和悬空 candidate ID。
- [ ] 定义 `ArtifactIdentity<Version extends number = 1>`。ranking 和 curation 使用 schema v1。
- [ ] ranking artifact 保存完整 ranked items 和“实际送入 curator”的 candidate IDs。force-selected item 必须包含在 candidate IDs。
- [ ] curation artifact 保存 canonical curated items、diagnostics 和 warnings。
- [ ] npm 与 Agent 都在 curation 前写 ranking，在 curation 后写 curation。
- [ ] 使用临时文件 + rename 原子写 artifact。
- [ ] 运行本任务测试和 `npx tsc --noEmit`。

### 阶段 A 检查点

- [ ] 运行 `npm test`、Agent test、`npx tsc --noEmit` 和 `git diff --check`。
- [ ] 确认 Agent 的 AI HOT cursor 不会因 disabled/enabled 分支被重置。
- [ ] 确认 npm 和 Agent 仍保留各自 curator 行为。

---

## 阶段 B：Tag + Ranking Signal 统一评分

### Task 3：建立受控 Tag、Ranking Signal 和 matcher

**文件**

- 新增：`src/scoring-policy.ts`
- 修改：`src/types.ts`
- 测试：`tests/scoring-policy.test.ts`

**步骤**

- [ ] 写失败测试覆盖 baseline Tag registry、Ranking Signal ID、matcher DSL 和 weight 完整性。
- [ ] 初始 Tag 至少覆盖 topic、format、quality、utility 和组合 pattern；允许 `custom:*`，但必须通过严格 decoder。
- [ ] matcher 只读取内容字段和 Ranking Signal。作者、域名、平台和 publication 不能成为可学习 Tag。
- [ ] 所有 match 都输出稳定 evidence 和 0–1 strength。
- [ ] 定义唯一公式：`contribution = strength × weight`；editorial score clamp 到 0–100；priority 保持现有 75/25 聚合。
- [ ] `data/preference-rules.json` 只保存 overlay，不复制 baseline。
- [ ] 同一 factor ID 的 override 是替换，不是叠加。
- [ ] 旧 author/domain rules 只作为 `legacy-confirmed` 兼容读取；反馈流程不能创建或修改它们。
- [ ] `@tom_doerr` 留在 scoring 之前的 hard eligibility，不进入 overlay。
- [ ] 运行 `tests/scoring-policy.test.ts` 和 `npx tsc --noEmit`。

### Task 4：把 rank 收敛到单一 Factor 计算

**文件**

- 修改：`src/rank.ts`
- 修改：`src/ranking-preferences.ts`
- 修改：`src/types.ts`
- 测试：`tests/rank.test.ts`
- 测试：`tests/scoring-policy.test.ts`

**步骤**

- [ ] 先用 characterization tests 固定当前无 overlay 的分数、排序、candidate pool、pointer rescue 和 duplicate 行为。
- [ ] 实现 `evaluateRankingFactors()`，作为首次评分的唯一入口。
- [ ] 实现 `recomputeRankingEvaluation()`，作为 duplicate 更新 novelty、Tag、Factor 和总分的唯一入口。
- [ ] 删除 `rank.ts` 中两套重复算分公式。
- [ ] 保留 `ScoreBreakdown` 兼容输出，但由 Factor 聚合产生。
- [ ] `formatDecisionReasons()` 从结构化结果单向生成展示文本。
- [ ] 测试无 overlay 前后结果完全一致。
- [ ] 测试一个 Tag override 只生效一次，不与旧规则重复叠加。
- [ ] 运行 `tests/rank.test.ts tests/scoring-policy.test.ts` 和 `npx tsc --noEmit`。

### Task 5：严格持久化结构化评分数据

**文件**

- 修改：`src/artifact-codec.ts`
- 修改：`src/ranking-artifact.ts`
- 修改：`src/preferences.ts`
- 新增：`src/item-display.ts`
- 修改：`src/curate.ts`
- 测试：`tests/ranking-artifact.test.ts`
- 测试：`tests/preferences.test.ts`
- 测试：`tests/item-display.test.ts`
- 测试：`tests/curate.test.ts`

**步骤**

- [ ] 在 artifact codec 导出严格 helpers：`decodeContentTagIds()`、`decodeContentTagMatches()`、`decodeRankingSignalMap()`、`decodeScoreFactors()`。
- [ ] 每个 helper 校验数组形状、必需键、枚举、有限数字、strength 范围和 contribution 等式；禁止用类型断言跳过 nested validation。
- [ ] ranked artifact 保存 `contentTags`、`tagMatches`、`rankingSignals` 和 `scoreFactors`。
- [ ] preference profile 只聚合 `learnable` Tag；不再聚合自由文本 `decisionReasons`。
- [ ] 旧历史缺少 Tag 时标记 `legacy-v1`；“字段缺失”和“空数组”保持不同语义。
- [ ] HTML、terminal 和 Markdown 共享纯 `item-display` metadata，但保留三个独立 renderer。
- [ ] 写 malformed nested structure 测试，确认 decoder fail loud。
- [ ] 运行目标测试和 `npx tsc --noEmit`。

### 阶段 B 检查点

- [ ] 运行 `npm test`、Agent test、`npx tsc --noEmit` 和 `git diff --check`。
- [ ] 用固定 fixture 比较迁移前后无 overlay 的完整排名结果。
- [ ] 确认没有作者/域名 Tag，也没有从 `decisionReasons` 反向学习。

---

## 阶段 C：HTML 反馈、发布记录与调整闭环

### Task 6：建立 canonical Selection Decision 和串行写入

**文件**

- 新增：`src/selection-decision.ts`
- 新增：`src/selection-decision-store.ts`
- 修改：`src/types.ts`
- 测试：`tests/selection-decision.test.ts`
- 测试：`tests/selection-decision-store.test.ts`

**步骤**

- [ ] 定义 schema v1：identity、`curationRevision`、单调 `revision`、selection 状态和 `scoreFeedbackById`。
- [ ] artifact 只保存 selected IDs，不保存 CuratedItem 副本。
- [ ] 写失败测试：设置方向、切换方向、再点撤销、选择与反馈互不影响。
- [ ] 写失败测试：未知 item、旧 runId、旧 curationRevision 和旧 revision 被拒绝。
- [ ] 写失败测试：并发 feedback，以及 feedback 与 confirm 竞态时，所有更新都保留。
- [ ] store 使用单一 promise queue 串行 read-modify-write，并用临时文件 + rename 原子落盘。
- [ ] server restart 后从文件恢复；文件是 SSOT，localStorage 不是。
- [ ] 如需兼容旧 `selection.json`，只把它作为 derived output；publish 不读取它。
- [ ] 运行目标测试和 `npx tsc --noEmit`。

### Task 7：在现有 Agent HTML select 页面加入反馈按钮

**文件**

- 修改：`.agents/skills/daily-news-generate/scripts/runtime.mjs`
- 测试：`.agents/skills/daily-news-generate/tests/daily-news-agent.test.mjs`
- 测试：可新增 `tests/html-select-feedback.test.ts`，使用 `linkedom`

**步骤**

- [ ] 先写 DOM 测试：每条 item 渲染“评分过高”和“评分过低”。
- [ ] 调整 item DOM，避免按钮位于 checkbox `<label>` 的冒泡路径中。
- [ ] 同一 item 最多激活一个方向；点击当前方向撤销；按钮不改变 checkbox。
- [ ] 保存中显示 pending；成功后显示 confirmed；失败时回滚到上一个 confirmed 状态并显示错误。
- [ ] 新增 feedback POST endpoint。每次请求校验 date、runId、curationRevision、revision 和 item ID。
- [ ] confirm endpoint 与 feedback endpoint 共用同一个 decision store。
- [ ] localStorage key 固定为 `daily-news-select:<runId>:<curationRevision>`，只作为缓存。
- [ ] 写 HTTP 400、409、500、restart 和 race 测试。
- [ ] 检查全部 render site：仅 Agent HTML 有按钮；`src/select.ts` 和 `src/review.ts` 没有按钮。
- [ ] 运行 Agent test、DOM test 和 `npx tsc --noEmit`。

### Task 8：统一 Selection Report 与 Publication Finalization

**文件**

- 新增：`src/selection-report.ts`
- 新增：`src/publication-workflow.ts`
- 新增：`src/feedback-review.ts`
- 新增：`src/score-feedback-history.ts`
- 修改：`src/types.ts`
- 修改：`src/preferences.ts`
- 修改：`src/publish.ts`
- 修改：`src/generate.ts`
- 修改：`.agents/skills/daily-news-generate/scripts/runtime.mjs`
- 测试：`tests/selection-report.test.ts`
- 测试：`tests/publication-workflow.test.ts`
- 测试：`tests/feedback-review.test.ts`
- 测试：`tests/score-feedback-history.test.ts`
- 测试：`tests/generate.test.ts`
- 测试：`.agents/skills/daily-news-generate/tests/daily-news-agent.test.mjs`

**步骤**

- [ ] 一次定义最终 SelectionReport schema v1。它必须包含完整 identity、policy revision、curation revision、selection decision revision、显式 feedback、structured scoring 和最终 selected items。
- [ ] decoder 只支持当前 unversioned legacy report 和最终 v1；拒绝未知版本。不要引入一个随后立刻废弃的中间 v1 形状。
- [ ] `buildSelectionReport()` 只接受 ranking、curation 和 decision，并校验完整 identity。
- [ ] `finalizePublication()` 只接受 draft、ranking、curation 和 decision。selection 只有 decision 一个权威输入。
- [ ] npm adapter 创建一个空反馈、已确认的 decision；Agent adapter 读取持久化 decision。
- [ ] publish 从 persisted ranking 读取分数。删除 Agent publish 路径中的第二次 `rankItems()`。
- [ ] 删除 `src/generate.ts` 内的 `annotateRankedItems()` 和 `buildSelectionReport()`。
- [ ] 删除 Agent runtime 内的 `annotateRankedItems()` 和 `buildSelectionReport()`；只保留 shared module 调用。
- [ ] feedback review 保存本期完整上下文；长期 history 只保存 bounded preview、Tag、Factor 和 evidence。
- [ ] score feedback history decoder 必须调用 Task 5 的四个 strict nested decoders。
- [ ] history 按 `runId` 或 `feedbackEventId` 幂等。
- [ ] finalization 副作用顺序固定：preflight → outputs/report → selection history → score feedback history → feedback review（如有）→ state → clear draft。
- [ ] 写明确的 no-feedback 测试：`feedbackCount === 0`、不写 review、不写 adjustment、仍按正常顺序写 outputs/history/state/clear。
- [ ] 写失败注入测试：history/review 失败时不推进 state，不清 draft；重试不会重复 history。
- [ ] 运行本任务全部测试和 `npx tsc --noEmit`。

### Task 9：实现受约束的 post-publish adjustment

**文件**

- 新增：`src/feedback-adjustment.ts`
- 新增：`src/feedbackCli.ts`
- 修改：`src/scoring-policy.ts`
- 修改：`src/types.ts`
- 修改：`package.json`
- 测试：`tests/feedback-adjustment.test.ts`
- 测试：`tests/feedbackCli.test.ts`

**步骤**

- [ ] 定义严格 adjustment schema：identity、adjustment ID、base policy revision、evidence IDs、Tag changes、weight overrides、attribution 和 `no_change`。
- [ ] Agent 负责语义归因；确定性 apply module 只负责校验与原子应用。不能建立第二套自动归因器。
- [ ] 单条 feedback 最多修改一个 matched Tag，绝对 delta 不超过 2，不能修改 Ranking Signal。
- [ ] 拒绝把同一方向同时分摊到多个 matched Tags。
- [ ] Ranking Signal override 至少需要 3 个同方向事件，且跨至少 2 个 run ID。
- [ ] 拒绝修改 author/domain rules、source enablement、`@tom_doerr` 或其他 hard eligibility。
- [ ] 自定义 Tag 必须是受控 matcher；不能覆盖 baseline Tag 定义。
- [ ] 校验 base policy revision 和全部 evidence IDs。
- [ ] `applied` 原子更新 `data/preference-rules.json` 并单调增加 revision。
- [ ] `no_change` 原子记录 adjustment ID 和证据，但不增加 revision。
- [ ] 重复 adjustment ID 安全 no-op。
- [ ] apply 失败时保留原 policy 文件并输出明确错误。
- [ ] 增加 `feedback-apply` npm/模块入口并运行目标测试。

### Task 10：让 Agent 在 publish 后完成反馈审查

**文件**

- 修改：`.agents/skills/daily-news-generate/scripts/runtime.mjs`
- 修改：`.agents/skills/daily-news-generate/scripts/daily-news-agent.mjs`
- 修改：`.agents/skills/daily-news-generate/SKILL.md`
- 修改：`.agents/skills/daily-news-generate/tests/daily-news-agent.test.mjs`
- 修改：`README.md`
- 修改：`.env.example`
- 修改：`docs/design.md`

**步骤**

- [ ] publish 返回 `feedbackCount` 和 review path。
- [ ] 无反馈时，准确输出 `本期无评分反馈`，不创建 review 或 adjustment。
- [ ] 有反馈时，daily-news skill 在 publish 成功后继续：读 review → 选择最小内容 Tag/Signal 原因 → 写 adjustment → 调用确定性 `feedback-apply` → 报告 before/after。
- [ ] 证据不足或冲突时写 `no_change`，不能猜测作者或域名原因。
- [ ] `status` 明确显示 ranking、curation、selection-decision、selection-report、feedback-review 和 feedback-adjustment 是否存在，并显示下一步。
- [ ] `feedback-apply --date=YYYY-MM-DD` 在 draft 已清理后仍可定位 artifact。
- [ ] 写命令测试、status 测试、有反馈摘要测试和 no-feedback 摘要测试。
- [ ] 文档说明按钮是独立信号、立即持久化、artifact 路径、调整边界和恢复方式。
- [ ] 文档保留默认 `twitter,aihot`，Substack 可选。
- [ ] 文档把 npm/Agent 差异标为“待确认”；不改变现状。
- [ ] 不把 Tag 偏好接入 AI hard admission gate。Tag 只影响评分、候选排序和 curator guidance。
- [ ] 运行 Agent test、`npm test` 和 `npx tsc --noEmit`。

---

## 最终验证

- [ ] `npm test`：零失败，零 skipped。
- [ ] `node --test .agents/skills/daily-news-generate/tests/daily-news-agent.test.mjs`：零失败，零 skipped。
- [ ] `npx tsc --noEmit`：exit 0。
- [ ] `git diff --check`：exit 0。
- [ ] `rg "function advancePublishedState" src/generate.ts .agents/skills/daily-news-generate/scripts/runtime.mjs`：无结果；唯一实现位于 `src/source-registry.ts`。
- [ ] `rg "function buildSelectionReport" src/generate.ts .agents/skills/daily-news-generate/scripts/runtime.mjs`：无结果；唯一实现位于 `src/selection-report.ts`。
- [ ] Agent publish 路径没有 `rankItems()`；rank 只发生在 curate-input 阶段。
- [ ] 手工 smoke test：反馈过高 → 刷新仍存在 → 改为过低 → 再点撤销 → confirm → publish。
- [ ] 手工 smoke test：模拟 feedback write 失败，UI 保留上一个 confirmed 状态，selection checkbox 不变。
- [ ] 检查三个 render site：Agent HTML 有按钮；terminal 和 Markdown 没有按钮。
- [ ] 检查最终 diff 没有读取、打印或提交本机 `.env` 值。

## 实施顺序

严格执行：**阶段 A → 阶段 A 检查点 → 阶段 B → 阶段 B 检查点 → 阶段 C → 最终验证**。

不要并行修改共享的 `src/types.ts`、`src/generate.ts`、`runtime.mjs` 或 artifact schema。每个阶段通过后再进入下一阶段。
