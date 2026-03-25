# Rank Reason Chinese Sync Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** 把 rank 相关 reason 文案、展示文案和测试样例统一到当前中文版本，消除仍残留的英文漂移。

**Architecture:** 保持现有 ranking 逻辑不变，只同步字符串常量、面向模型的 payload 标签、交互式选择展示文案，以及依赖这些文案的测试与设计说明。避免新增抽象或改动打分行为。

**Tech Stack:** TypeScript, Node.js test runner

### Task 1: 锁定中文文案基线

**Files:**
- Modify: `src/rank.ts`
- Modify: `src/ranking-preferences.ts`
- Test: `tests/rank.test.ts`

**Step 1: 写出失败测试**

把 `tests/rank.test.ts` 中仍断言英文 reason 的用例改成中文版本。

**Step 2: 运行测试确认失败**

Run: `npm test -- tests/rank.test.ts`
Expected: FAIL，因为实现里还残留英文 reason。

**Step 3: 写最小实现**

把 `src/rank.ts` 与 `src/ranking-preferences.ts` 中残留的英文 reason 文案改为中文，并保持重复项/作者规则提取逻辑可用。

**Step 4: 运行测试确认通过**

Run: `npm test -- tests/rank.test.ts`
Expected: PASS

### Task 2: 同步展示层与报告测试

**Files:**
- Modify: `src/curate.ts`
- Modify: `src/select.ts`
- Test: `tests/curate.test.ts`
- Test: `tests/select.test.ts`
- Test: `tests/publish.test.ts`

**Step 1: 写出失败测试**

把 payload 标签、选择器标签和 report 中的 reason 样例改成中文版本。

**Step 2: 运行测试确认失败**

Run: `npm test -- tests/curate.test.ts tests/select.test.ts tests/publish.test.ts`
Expected: FAIL，因为实现展示文案还是英文。

**Step 3: 写最小实现**

更新 `src/curate.ts` 和 `src/select.ts` 的标签文案，使其与中文 reason 一致。

**Step 4: 运行测试确认通过**

Run: `npm test -- tests/curate.test.ts tests/select.test.ts tests/publish.test.ts`
Expected: PASS

### Task 3: 同步设计文档

**Files:**
- Modify: `docs/plans/2026-03-19-priority-scoring-design.md`

**Step 1: 更新 reason 列表**

把仍描述英文 reason code 的段落改为当前中文版本，避免设计文档继续漂移。

**Step 2: 做最终验证**

Run: `npm test`
Expected: PASS
