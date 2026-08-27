# Select 评分反馈与 Tag + Ranking Signal 统一评分设计

- 日期：2026-08-27
- 状态：已在对话中确认
- 范围：设计，不包含实现

## 1. 背景

现有 daily-news 在 collect 后执行确定性 ranking，再由 curator 整理候选，最后在 select 阶段由用户选择发布条目。

用户需要在现有 HTML select 页面为每条资讯增加两个反馈按钮：

- `评分过高`
- `评分过低`

反馈必须立即保存。publish 成功后，agent 读取本期反馈，按内容归因并调整后续评分和内容偏好。反馈不能默认归因到作者或域名。

本次设计同时按 SSOT 原则收敛评分、选择决策、报告、发布状态和来源枚举。扫描发现 agent publish 当前复制了不完整的来源状态转换，可能把 `aihot.lastPublishedTime` 重置为 `0`。该正确性问题纳入本次范围。

## 2. 已确认的产品决策

1. 反馈按钮只进入现有 agent HTML select 页面。
2. 终端 `src/select.ts` 不增加按钮。
3. 反馈与“是否选择发布”是两种独立信号。
4. 点击反馈后立即写入本地文件，不等到确认选择或 publish。
5. publish 成功后，由 agent 审查反馈，再应用调整。
6. 反馈主要归因到内容本身，不自动修改作者或域名规则。
7. 内容使用受控 Tag。Tag 可持续细分，但不能成为无约束自由文本。
8. 评分使用 Tag + Ranking Signal 统一模型。不存在另一套隐藏的“基础分 + Tag 修正分”。
9. `@tom_doerr` 继续作为 hard eligibility filter。
10. AI HOT 默认启用。
11. Substack 是可选来源。当前本地实例已启用，并已配置 publication URL。
12. Agent Skill 与 npm 流程保持当前差异。本期只明确标记“待确认”，不统一模型使用、reader brief 或候选池大小。

## 3. 目标

### 3.1 功能目标

- 每条 HTML select 资讯显示一对可撤销的评分反馈按钮。
- 每次点击立即、可靠、可恢复地持久化。
- publish 后生成完整的反馈审查资料。
- agent 根据内容 Tag 和 Ranking Signal 解释偏差。
- 经校验的 adjustment 在下一期生效。
- 每次变化都能追踪到反馈证据。

### 3.2 SSOT 目标

- 来源 ID 和默认启用策略只有一个代码级 registry。
- Tag ID、Ranking Signal ID 和基础评分 policy 只有一个代码级定义位置。
- 用户确认的 policy overlay 只有一个本地持久化文件。
- 选择与评分反馈只有一个当期决策载荷。
- selection report 只有一个构造模块。
- publish finalization 和 state advancement 只有一个领域流程。
- `decisionReasons` 只用于展示，不能再作为持久化身份或学习键。

## 4. 非目标

- 不合并 HTML、终端和 Markdown 渲染器。
- 不给终端 checkbox 增加评分反馈交互。
- 不自动关闭、启用或删除来源。
- 不根据一次反馈修改 hard eligibility filter。
- 不自动根据按钮反馈创建作者或域名规则。
- 不统一 Agent Skill 与 npm 的 curator 实现。
- 不改变 Agent Skill 禁止第三方 LLM 的规则。
- 不在本期解决 Substack reader brief 在两条流程中的能力差异。
- 不将所有历史自由文本 `decisionReasons` 猜测成新 Tag。

## 5. 当前行为的权威来源

发生冲突时，本期采用以下优先级：

1. 已确认的本设计决策。
2. 当前回归测试表达的行为。
3. 当前生产代码。
4. README 和 skill 运行文档。
5. `docs/design.md` 中的历史意图。

因此：

- `@tom_doerr` 是硬过滤，不是普通降权。
- 应用默认来源是 `twitter,aihot`。
- `.env.example` 可以示例启用 `twitter,substack,aihot`。
- Substack 未启用时不要求 `SUBSTACK_PUBLICATION_URL`。
- 当前本地实例启用 Substack，但本地配置值不写入仓库文档。

## 6. 总体架构

```text
Source Registry
      │
      ▼
CollectedItem[]
      │
      ▼
Ranking Engine ── Effective Scoring Policy
      │                 ▲
      │                 │
      │            Confirmed Overlay
      ▼
Ranked Artifact
      │
      ▼
Curator Adapter
(npm-model / agent-curator)
      │
      ▼
Curation Artifact
      │
      ▼
HTML Select Server
      │
      ├─ immediate feedback update
      └─ selection confirm
      │
      ▼
Selection Decision Artifact
      │
      ▼
Finalize Publication
      │
      ├─ selection report
      ├─ preference histories
      ├─ feedback review
      ├─ publication outputs
      ├─ state advancement
      └─ draft clear
      │
      ▼
Agent Review → Feedback Adjustment → Validated Apply
```

## 7. 深模块与 Interface

### 7.1 Source Registry

建议新增 `src/source-registry.ts`。

它拥有：

- `SourceName` 的运行时值集合和派生类型。
- 默认启用来源。
- 每个来源的显示名。
- 相关环境变量名。
- 是否需要持久化发布游标。
- state 初始化和推进时需要枚举的来源。

最小 interface：

```ts
export const SOURCE_NAMES = ['twitter', 'substack', 'aihot'] as const;
export type SourceName = (typeof SOURCE_NAMES)[number];
export const DEFAULT_ENABLED_SOURCES: readonly SourceName[];
export function normalizeSourceNames(value: unknown): SourceName[] | null;
export function advancePublishedState(
  state: RunState,
  enabledSources: readonly SourceName[],
  collectedAt: number,
): RunState;
```

`collect.ts`、`state.ts`、`draft.ts`、`generate.ts` 和 agent runtime 必须调用该 interface，不再复制来源枚举。

### 7.2 Ranking Engine

`src/rank.ts` 继续拥有公开的 `rankItems()` 和 candidate pool 行为。复杂的 policy 解析和 Factor 计算放到新的 `src/scoring-policy.ts`，避免 `rank.ts` 同时承担配置、匹配、计算、解释和迁移。

最小 interface：

```ts
export function resolveEffectiveScoringPolicy(
  overlay?: ConfirmedPreferencePolicy,
): EffectiveScoringPolicy;

export function evaluateRankingFactors(
  item: CollectedItem,
  context: RankingContext,
  policy: EffectiveScoringPolicy,
): RankingEvaluation;

export function recomputeRankingEvaluation(
  evaluation: RankingEvaluation,
  change: RankingMutation,
  policy: EffectiveScoringPolicy,
): RankingEvaluation;
```

`rankItems()` 只负责：

1. hard eligibility。
2. 构建批次 context。
3. 调用统一 Factor 计算。
4. 执行重复检测。
5. 通过同一个 recompute interface 更新重复项。
6. 排序。

### 7.3 Selection Decision

建议新增 `src/selection-decision.ts`。

它拥有选择和评分反馈的运行时 schema、校验、更新和解析。HTML server 只负责 HTTP 和浏览器交互。

最小 interface：

```ts
export function decodeSelectionDecision(value: unknown): SelectionDecision;
export function updateScoreFeedback(
  decision: SelectionDecision,
  input: ScoreFeedbackUpdate,
  curation: CurationArtifact,
): SelectionDecision;
export function confirmSelection(
  decision: SelectionDecision,
  selectedIds: string[],
  curation: CurationArtifact,
): SelectionDecision;
export function resolveSelectedItems(
  decision: SelectionDecision,
  curation: CurationArtifact,
): CuratedItem[];
```

### 7.4 Selection Report

建议新增 `src/selection-report.ts`。

它拥有 ranked/candidate/curated/selected annotation 和 selection report 构造。`src/generate.ts` 与 agent runtime 不再分别实现。

```ts
export function buildSelectionReport(input: SelectionReportInput): SelectionReport;
```

### 7.5 Publication Finalization

建议新增 `src/publication-workflow.ts`。

它拥有 publish 成功后的领域顺序和幂等语义。CLI 和 agent runtime 是 adapter，只提供 artifact 和 I/O 依赖。

```ts
export async function finalizePublication(
  input: FinalizePublicationInput,
  deps: FinalizePublicationDeps,
): Promise<FinalizePublicationResult>;
```

## 8. Canonical Ranking Artifact

为避免 publish 重新计算并替换用户看到的评分，两种 adapter 都必须产出 canonical ranking artifact：

`output/<date>-ranking.json`

```ts
interface RankingArtifact {
  schemaVersion: 1;
  featureVersion: string;
  runId: string;
  date: string;
  curationMode: 'npm-model' | 'agent-curator';
  collectedAt: number;
  policyRevision: number;
  rankedItems: RankedItem[];
  candidateIds: string[];
}
```

- `rankedItems` 保存本次实际用于候选裁剪的全量排序结果。
- `candidateIds` 保存该 adapter 实际暴露给 curator 的候选集合。
- agent 的 `curate-input.json` 从该 artifact 投影 candidate items。
- npm 可以在同一进程继续执行，但仍写出相同 artifact，供恢复、报告和审计。
- publish 只消费该 artifact，禁止按新的时间或 policy revision 重新 ranking。
- artifact decoder 必须验证每个 candidate ID 都存在于 rankedItems。

`runId` 使用 draft 的 `collectedAt`、enabled source IDs 和按顺序排列的 collected item IDs 计算稳定 hash。同一 draft 重试必须得到相同 runId；追加 fresh 内容后必须得到新 runId。

## 9. Tag 模型

### 8.1 Tag ID

Tag 使用稳定、无本地化文案的 ID：

```text
topic:agents
topic:model-evaluation
topic:ai-infra
format:launch
format:tutorial
format:research
quality:evidence-rich
quality:vague
utility:actionable
pattern:vague-launch
```

维度包括：

- `topic:*`：内容主题。
- `format:*`：内容形态。
- `quality:*`：质量属性。
- `utility:*`：读者用途。
- `pattern:*`：不能由单一宽泛 Tag 准确表达的组合模式。

作者、域名、来源平台和 publication 不属于内容 Tag。

### 8.2 Tag 定义

```ts
interface ContentTagDefinition {
  id: ContentTagId;
  label: string;
  description: string;
  learnable: boolean;
  matcher: ContentTagMatcher;
  aliases?: string[];
}
```

约束：

- 每个可加权 Tag 必须有可执行 matcher。
- matcher 可以使用正文、标题、linked source metadata 和已计算的客观 Ranking Signal。
- 展示文案不能作为 matcher 身份。
- alias 只做迁移和合并，不能产生第二个权重。
- 同义 Tag 必须合并。
- 宽泛 Tag 出现混合反馈时，优先增加更准确的子 Tag 或 pattern Tag。

### 8.3 Tag 匹配结果

```ts
interface ContentTagMatch {
  tagId: ContentTagId;
  matchedBy: string[];
  strength: number; // 0..1
}
```

每条匹配都保留依据，支持 feedback review。

## 10. Ranking Signal 与 Score Factor

`ReaderBrief.signals` 是文章阅读观察。本设计不复用 `signals` 这个裸字段名。

评分中的连续量统一命名为 `RankingSignal`：

```text
ranking:substance
ranking:evidence
ranking:freshness
ranking:novelty
ranking:actionability
ranking:engagement
ranking:source-credibility
ranking:x-article
ranking:substack-full-post
ranking:penalty
```

Tag 与 Ranking Signal 都转换为统一的 Factor：

```ts
interface ScoreFactor {
  factorId: string;
  kind: 'tag' | 'ranking-signal';
  strength: number;
  weight: number;
  contribution: number;
  evidence: string[];
  provenance: 'baseline' | 'confirmed-overlay';
}
```

计算原则：

```text
Factor contribution = strength × weight
editorialScore = clamp(editorial Factors 合计, 0, 100)
priorityScore = clamp(round(editorialScore × 0.75 + engagementScore × 0.25), 0, 100)
```

初始 policy 必须复刻当前公式和排序。迁移本身不能造成无反馈时的排名变化。

`editorialScore` 与 `engagementScore` 继续分开。互动仍是辅助信号。重复检测继续在初次评分后执行，但必须通过唯一的 `recomputeRankingEvaluation()` 更新 novelty、Tag、Factor 和最终分数。

## 11. Policy 分层与优先级

SSOT 不表示把不同语义放进同一张表。有效 policy 按明确顺序合成：

1. hard eligibility policy。
2. baseline identity 和基础 Factor policy。
3. 内容 Tag 匹配。
4. 用户确认的 policy overlay。
5. 统一评分聚合。

### 11.1 Baseline policy

代码级 baseline 位于 `src/scoring-policy.ts`。它拥有：

- Tag registry 的内置 Tag。
- Ranking Signal 定义和默认权重。
- hard eligibility policy。
- 官方身份和可信来源的 baseline metadata。
- 当前评分公式的兼容默认值。

`@tom_doerr` 继续在 hard eligibility 阶段过滤。

### 11.2 Confirmed overlay

`data/preference-rules.json` 是本机确认 overlay 的唯一持久化文件。它不复制完整 baseline。

它可以保存：

- 自定义 Tag 定义。
- baseline Tag/Signal 的权重 override。
- 自定义 Tag 权重。
- 旧作者/域名规则的兼容数据。
- adjustment evidence。
- policy revision。
- 已应用 adjustment ID。

同一个 Factor ID 只能有一个有效 weight。override 是替换，不是叠加。

按钮反馈不能创建或修改作者/域名规则。旧作者/域名规则保持可读，直到单独决定迁移策略。

## 12. decisionReasons 的新职责

`decisionReasons` 保留，供 HTML、终端、Markdown 和历史 artifact 展示。

它必须由结构化 Tag、Factor 和重复信息生成：

```ts
formatDecisionReasons(evaluation): string[]
```

禁止：

- 从 `decisionReasons` 反向解析计算状态。
- 用本地化 reason 字符串作为偏好学习键。
- 把 `重复内容:<id>` 当作 topic hint。
- 把作者规则说明当作内容 Tag。

旧 `ScoreBreakdown` 可以继续输出，但它由 Score Factors 聚合生成，不再作为计算 SSOT。

## 13. Collection 偏好的语义

评分反馈不能影响 AI 相关性的 hard admission gate，否则被过滤的条目不会进入反馈历史，并会形成自我强化偏差。

本期将“收集偏好”定义为：

- collector 继续尽量收集广泛的合格来源。
- static AI relevance eligibility 与用户偏好分开。
- 内容 Tag 可用于候选排序和 curator guidance。
- Tag 权重不能直接关闭来源。
- Agent Skill 可在 curate input 中读取 Tag guidance。
- npm recommendation gate 可以读取 Tag 描述用于标注，但不能因个人升降权改变 `isAiRelated` 判定。

如果未来需要按 Tag 调整抓取额度或源配额，应作为独立设计，不在本期实现。

## 14. HTML 反馈交互

### 14.1 渲染范围

已检查三个 render site：

- HTML select：`.agents/skills/daily-news-generate/scripts/runtime.mjs`。本期修改。
- 终端 select：`src/select.ts`。保持不变。
- Markdown review：`src/review.ts`。只消费共享展示 metadata，不增加按钮。

### 14.2 按钮行为

每条 HTML item 显示：

- `评分过高`
- `评分过低`

行为：

- 同一条最多激活一个方向。
- 点击另一方向会覆盖。
- 再点当前方向会撤销。
- 按钮点击不能改变发布 checkbox。
- 保存期间显示 pending 状态。
- 服务端确认成功后才显示已保存状态。
- 保存失败时显示明确错误，并保留上一个已确认状态。

当前 item 容器是 `<label>`。加入按钮时必须调整 DOM 结构，避免按钮冒泡触发 checkbox。

### 14.3 浏览器缓存

localStorage 只作缓存，不是 SSOT。

缓存 key 使用：

```text
daily-news-select:<runId>:<curationRevision>
```

不能只使用日期。`--force` 或重新 curate 后，旧缓存不能误应用到新 curation。

## 15. Selection Decision Artifact

当前 `selection.json` 保存完整 `selectedItems` 副本。新 canonical artifact 改为：

`output/<date>-selection-decision.json`

```ts
interface SelectionDecision {
  schemaVersion: 1;
  runId: string;
  date: string;
  curationRevision: string;
  curationMode: 'npm-model' | 'agent-curator';
  featureVersion: string;
  updatedAt: string;
  selection: {
    status: 'pending' | 'confirmed';
    selectedIds: string[];
    confirmedAt?: string;
  };
  scoreFeedbackById: Record<string, {
    direction: 'too_high' | 'too_low';
    updatedAt: string;
  }>;
}
```

- feedback click 立即原子更新该文件。
- 再点当前方向时，从 `scoreFeedbackById` 删除该 ID，表示撤销。
- selection confirm 更新同一文件的 selection 部分。
- 每次更新都校验 date、runId、curationRevision 和 item ID。
- selected items 在消费时从 canonical curation artifact 解析。
- curation 顺序决定最终 selection 顺序。

为了兼容当前流程，迁移期可以生成旧 `output/<date>-selection.json` 作为派生产物。它不能继续作为 publish SSOT。

## 16. Artifact 身份与版本

所有新或修改的领域 artifact 必须包含：

- `schemaVersion`
- `runId`
- `date`
- `curationMode`
- `featureVersion`

`curationMode`：

```text
npm-model
agent-curator
```

`curationRevision` 由 curation schemaVersion、date、按顺序排列的 item ID 和 canonical URL 计算稳定 hash。

这可以阻止旧 select server、旧 localStorage 或同日重新 curate 的 artifact 混用。

## 17. Agent 与 npm 当前差异

本期保留现状：

| 能力 | npm | Agent Skill |
|---|---|---|
| curator | 外部模型 | 当前 agent |
| Substack reader brief | 当前启用 | 当前不调用第三方模型 |
| recommendation AI prefilter | 当前代码支持 | skill 明确禁止第三方 AI |
| 默认最终 curator pool | rank 上限 150 | 默认 80 |
| selection UI | 终端 checkbox | HTML server |

这些差异标记为：**待确认，未来单独设计**。

本期只要求：

- 两种模式使用同一 Source Registry。
- 两种模式使用同一 Tag/Ranking Signal schema 和评分实现。
- artifact 写入 `curationMode` 和 `featureVersion`。
- publish 不重新计算并替换用户当时看到的 ranked artifact。

## 18. Feedback Review 与 Adjustment

### 18.1 publish 后产物

如果本期存在评分反馈，finalization 生成：

`output/<date>-feedback-review.json`

内容包括：

- run identity。
- direction。
- item 正文和 linked source 上下文。
- 当前 Tag matches。
- 当前 Ranking Signals。
- 全部 Score Factors。
- 当前分数和候选位置。
- 是否被 curator 和用户选择。
- 当前 effective policy revision。

完整正文只进入当期本地 review artifact。长期历史只保存必要预览、Tag、Factor 和证据。

### 18.2 长期历史

追加到：

`data/score-feedback-history.jsonl`

每个事件使用稳定 `feedbackEventId`。写入必须按 ID 幂等。

### 18.3 Agent 审查

publish 成功后，daily-news skill 要求 agent：

1. 读取 feedback review。
2. 判断偏差来自内容 Tag、Tag matcher 或 Ranking Signal。
3. 不默认归因到作者或域名。
4. 先选择最小范围原因。
5. 如果 Tag 太宽，细分 Tag。
6. 如果正负证据冲突，写 `no_change` 和原因。
7. 写 adjustment artifact。
8. 调用确定性的 apply 命令。
9. 报告 before/after、证据和下一期影响。

### 18.4 Adjustment artifact

`output/<date>-feedback-adjustment.json`

必须包含：

- `schemaVersion`
- `adjustmentId`
- `reviewRunId`
- `basePolicyRevision`
- 使用的 feedback event IDs
- Tag definition changes
- weight overrides
- `no_change` 原因（如适用）
- agent 的简短归因说明

### 18.5 调整边界

- 单条明确反馈可以产生小幅、窄范围 Tag 调整。
- 不把 penalty 分摊给该条目的全部 Tag。
- Global Ranking Signal weight 至少需要 3 个同方向样本，并跨 2 个 run。
- 作者/域名规则不由评分按钮调整。
- hard eligibility 不由评分按钮调整。
- 调整必须引用存在的 review 和 feedback event。

## 19. Apply 语义

新增确定性 `feedback-apply` 命令或等价 interface。

要求：

- 严格 decode adjustment schema。
- 验证 base policy revision。
- 验证 evidence ID。
- 验证 Tag ID、matcher 和 weight 范围。
- 拒绝自定义 Tag 覆盖 baseline Tag 定义。
- 只允许明确的 weight override。
- 使用临时文件 + rename 原子更新 overlay。
- 已存在 adjustment ID 时安全 no-op。
- policy revision 单调增加。
- 失败时保留旧 policy 文件。

## 20. Selection Report 与偏好历史

selection report 必须记录当时实际展示的 ranked artifact。publish 不得重新 ranking。

报告增加：

- run identity。
- curation mode 和 feature version。
- tags。
- score factors。
- explicit score feedback。
- selection decision revision。

隐式 selection preference 与显式 score feedback 分开：

- `selectedByHuman` 只表示发布选择。
- `scoreFeedback` 只表示用户认为当前 priority score 过高或过低。
- 未选择不能自动解释为评分过高。
- 已选择不能自动解释为评分过低。

现有 preference profile 只聚合稳定 learnable Tag，不再聚合自由文本 reasons。

## 21. Publication Finalization 顺序

finalization 先完成全部纯校验和 payload 构造，再执行副作用：

1. 验证 draft、canonical ranking artifact、curation 和 decision 的 run identity。
2. 从 ID 解析 selected items。
3. 构建 selection report 和 feedback review payload。
4. 写 publication outputs 和 selection report。
5. 按 runId 幂等记录 selection preference history。
6. 按 feedbackEventId 幂等记录 score feedback history。
7. 写 feedback review（如有反馈）。
8. 使用 Source Registry 推进 enabled source state。
9. 清除 pending draft。
10. 返回是否需要 agent feedback review。

如果步骤 4 后失败：

- draft 不清除。
- state 不推进。
- 重试使用相同 runId。
- 已完成的 history append 必须 no-op。
- publication 文件允许按相同 runId 幂等覆盖。

feedback adjustment 在 finalization 完整成功后执行。adjustment 失败不回滚已发布文件，但 agent 必须明确报告失败。

## 22. 持久化 Schema 与迁移

### 22.1 严格 decoder

TypeScript interface 不是运行时验证。所有持久化 artifact 必须通过版本化 decoder 读取。

未知 schemaVersion：

- 不静默降级。
- fail loud。
- 提示支持的版本和迁移命令。

### 22.2 preference-rules v1

v1 迁移到新 overlay 时：

- 保留 authorRules/domainRules，标记 provenance 为 legacy-confirmed。
- 评分按钮不修改这些字段。
- positive/negative topic hints 暂时迁入 legacy collection hints。
- 不把 topic hint 自动变成有权重 Tag，除非 agent 审查确认。

### 22.3 preference history v1

旧历史没有稳定 Tag 和 Factor：

- 标记 `featureVersion: legacy-v1`。
- 只对已知、固定 reason 文案做显式映射。
- 参数化 reason、重复 ID 和未知字符串不映射。
- “字段缺失”与“已计算为空”必须保持区别。

## 23. 展示 metadata 的共享范围

HTML、终端、Markdown 保留不同布局。建议由 `src/item-display.ts` 提供纯 metadata projection：

```ts
getItemDisplayMetadata(item): {
  sourceLabel: string;
  attribution: string;
  primaryUrl: string;
  secondaryUrl?: string;
  priorityScore?: number;
  reasonLabels: string[];
  threadPartCount?: number;
  teaserOnly: boolean;
  editorialReason?: string;
}
```

以下保持 renderer 私有：

- 终端 preview wrapping 和 media placeholder。
- HTML thumbnails、CSS、localStorage 和按钮状态。
- Markdown category sections、diagnostics 和 warning prose。

固定 category 顺序从共享常量读取。未知 category 必须 fail loud，不能在 HTML 中静默消失。

## 24. 错误处理

- 无效 feedback direction：HTTP 400，不写文件。
- 未知 item ID：HTTP 400，不写文件。
- date/run/revision 不匹配：HTTP 409，不写文件。
- feedback 持久化失败：HTTP 500，UI 不显示保存成功。
- selection confirm 时存在未完成 feedback write：等待完成后再确认和退出。
- server restart：读取 canonical decision artifact 恢复状态。
- static HTML：只作派生产物，不能保存反馈。
- 无反馈：publish 明确报告“本期无评分反馈”，不生成虚假 adjustment。
- adjustment 冲突：写 `no_change` 或拒绝，不能猜测。
- overlay 写失败：旧 policy 保持完整。
- feedback apply 重试：按 adjustment ID no-op。
- finalization 部分失败：保留 draft 和 state，允许相同 runId 重试。

## 25. 测试策略

### 25.1 Source Registry

- 默认来源严格为 Twitter + AI HOT。
- 启用 Substack 时三个来源均保留。
- 仅推进 enabled source。
- agent 和 npm 使用同一 state transition。
- 回归测试覆盖 AI HOT 游标不被重置。

### 25.2 Ranking Policy

- 当前无 overlay 的 golden ranking 保持不变。
- 每个 Ranking Signal 的范围和贡献可解释。
- Tag matcher 输出稳定 ID 和 evidence。
- alias 不重复贡献。
- 同义和相关 Tag 总贡献不重复放大。
- hard filter 先于评分。
- duplicate 两个分支走同一 recompute interface。
- URL duplicate 不再丢失 promotion Tag。
- `decisionReasons` 变化不影响 Tag identity。
- built-in 与 overlay precedence 有冲突测试。

### 25.3 持久化 Policy

- v1 overlay 迁移。
- 未知版本 fail loud。
- `@Author` 与 domain 使用不同 normalizer。
- adjustment revision 冲突。
- adjustment 重复应用 no-op。
- 原子写失败保留旧文件。

### 25.4 HTML 与 Decision

- 每个 HTML item 只渲染一对反馈按钮。
- 点击按钮不切换 checkbox。
- 方向互斥、覆盖和撤销。
- 成功后更新状态。
- 失败后恢复旧状态。
- localStorage 以 run/revision 隔离。
- server 重启从 decision artifact 恢复。
- stale date/run/revision 被拒绝。
- selected IDs 与 feedback IDs 均校验。
- selection 顺序由 curation 决定。

DOM 状态测试必须执行真实事件逻辑。仅用正则检查 HTML token 不足以验证按钮行为。

### 25.5 Report 与 Finalization

- 两个 adapter 使用同一 report builder。
- selection report 使用原 ranked artifact，不在 publish 重算。
- selection 与 score feedback 分开。
- 有反馈时生成 review 和幂等 history。
- 无反馈时不生成虚假 review。
- side effect 顺序失败注入测试。
- history 写入后重试不重复。
- state 只在 publication/history 成功后推进。
- draft 最后清除。

### 25.6 全量验证

- 运行全部项目测试。
- 运行 agent skill 测试。
- 不允许 skipped test。
- 检查 TypeScript 编译或等价类型检查。
- 检查 git diff 不包含本机 `.env`、pending draft、state 或历史数据。

## 26. 文档更新

实现时同步更新：

- README：来源列表包含 AI HOT；Substack 标记为可选；说明 feedback 闭环。
- `.env.example`：说明应用默认来源与示例启用来源的区别。
- `docs/design.md`：把 `@tom_doerr` 改为硬过滤；修正 Substack 可选语义。
- Agent Skill：增加 feedback review/apply 阶段。
- Agent Skill：把与 npm 的差异标记为“待确认”，不再无条件称为完全 mirror。
- 输出文件表：增加 selection decision、feedback review、feedback adjustment 和 feedback history。

## 27. 成功标准

1. HTML select 每条资讯有且仅有一对评分反馈按钮。
2. 点击立即落盘，刷新和 server restart 不丢失。
3. publish 后能追踪到完整 Tag、Ranking Signal、Factor 和 feedback evidence。
4. agent 能生成受校验的 Tag/weight adjustment。
5. 下一期相同内容模式产生可解释的分数变化。
6. 按钮反馈不会修改作者/域名规则或 hard eligibility。
7. 无反馈时当前 ranking 结果保持不变。
8. publish 使用用户当时看到的 ranked artifact。
9. AI HOT state 在 agent publish 后正确推进或保持，不再归零。
10. 所有持久化 schema 有版本 decoder 和迁移测试。
11. Agent 与 npm 差异保留现状并明确标记 mode。
12. 全部测试通过且没有跳过。

## 28. 已拒绝方案

### 28.1 每次反馈直接修改源码常量

拒绝。它会造成高频代码抖动，也难以审计单次变化来源。

### 28.2 自动在线学习所有权重

拒绝。单次误点会造成漂移，也不符合 agent 审查要求。

### 28.3 继续使用作者/域名作为主要归因

拒绝。作者和域名可能只是第三方传播者或平台。

### 28.4 把每个连续数值离散为 Tag

拒绝。新鲜度和互动速度是连续量，强制离散会产生 Tag 膨胀。它们应是 Ranking Signal。

### 28.5 保留“基础分 + Tag 修正分”两套计算

拒绝。它违反评分 SSOT。Tag 与 Ranking Signal 必须进入同一 Factor 模型。

### 28.6 合并三个 renderer

拒绝。终端、浏览器和 Markdown 有不同限制。只共享 metadata 语义。

## 29. 待确认但本期不处理

- Agent Skill 是否未来也生成 Substack reader brief。
- Agent 与 npm 是否统一 candidate pool 大小。
- recommendation AI gate 是否未来输出统一 Tag annotation。
- 是否淘汰 npm 外部模型 curation 路径。
- 是否新增基于 Tag 的抓取额度或来源配额。

这些事项不能在本期通过隐式折中处理。未来需要单独设计和批准。

## 30. 实施拆分

本设计跨越工作流 SSOT、评分模型和反馈闭环。它们有明确依赖，不应放进一个超大实施计划。

### 子项目 A：Workflow SSOT Foundation

交付：

- Source Registry。
- AI HOT state 修复。
- versioned run identity。
- canonical ranking artifact。
- shared selection report builder。
- shared publication finalization。
- Agent/npm mode marker。

验收结果：现有用户行为保持不变，但两个 adapter 不再复制状态推进、报告构造和 publish-time reranking。

### 子项目 B：Tag + Ranking Signal Scoring

依赖子项目 A。

交付：

- baseline scoring policy。
- stable ContentTag taxonomy。
- Ranking Signal 和 Score Factor。
- unified recompute path。
- derived decision reasons。
- confirmed overlay v2 和 migration。

验收结果：无 overlay 时 ranking golden behavior 保持不变；结构化 Tag/Factor 可进入 artifact 和 report。

### 子项目 C：HTML Score Feedback Loop

依赖子项目 B。

交付：

- selection decision artifact。
- HTML feedback buttons 和立即持久化。
- feedback review/history。
- agent adjustment artifact。
- deterministic feedback apply。
- Agent Skill 的 publish 后审查流程。

验收结果：显式反馈能在下一期通过可解释的 Tag/Factor weight 变化生效。

三个子项目分别生成实施计划和验证检查点。不能在 A 未验证时开始 B，也不能在 B 未验证时开始 C。
