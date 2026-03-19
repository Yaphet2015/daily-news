# Priority Scoring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an explicit ranking stage with score breakdowns, candidate-pool gating, editorial reasons, and a selection report.

**Architecture:** Extend collected Twitter items with optional engagement metrics, rank all collected items deterministically before main curation, then feed only the top-ranked candidate pool into the final model. Keep LLM editorial judgment for the last pass, but make ranking and rejection reasons explicit and inspectable.

**Tech Stack:** TypeScript, Node test runner, existing OpenAI / ai-sdk path, Markdown prompts, JSON artifacts

### Task 1: Lock ranking behavior in tests

**Files:**
- Create: `tests/rank.test.ts`
- Modify: `src/types.ts`
- Test: `tests/rank.test.ts`

**Step 1: Write the failing test**

Add tests that assert:
- high-substance items outrank vague promotional items
- duplicate items are marked and penalized
- Twitter engagement helps break ties but does not override weak substance
- candidate pool sizing stays bounded

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/rank.test.ts`
Expected: FAIL because the ranking module and types do not exist yet.

**Step 3: Write minimal implementation**

Add ranked types to `src/types.ts` and create `src/rank.ts` with deterministic scoring helpers and candidate pool selection.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/rank.test.ts`
Expected: PASS

### Task 2: Lock curation prompt and response contract

**Files:**
- Modify: `tests/curate.test.ts`
- Modify: `prompts/curator.md`
- Modify: `src/curate.ts`
- Test: `tests/curate.test.ts`

**Step 1: Write the failing test**

Add tests that assert:
- ranked metadata is included in the model payload
- the prompt requires `editorialReason`
- enriched curated items preserve ranking metadata and editorial reason

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/curate.test.ts`
Expected: FAIL because the prompt and curate pipeline do not expose the new contract yet.

**Step 3: Write minimal implementation**

Update the prompt contract and `src/curate.ts` so the main model operates on ranked candidates and returns `editorialReason`.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/curate.test.ts`
Expected: PASS

### Task 3: Extend Twitter collection with optional engagement metrics

**Files:**
- Modify: `src/collect.ts`
- Modify: `src/types.ts`
- Modify: `tests/collect.test.ts`
- Test: `tests/collect.test.ts`

**Step 1: Write the failing test**

Add tests that assert `mapTwitterCliTweet` and `mapTwitterApiTweet` preserve optional engagement counts when present.

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/collect.test.ts`
Expected: FAIL because these counts are currently discarded.

**Step 3: Write minimal implementation**

Extend the input and output mappings to carry optional counts without making them required.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/collect.test.ts`
Expected: PASS

### Task 4: Integrate ranking into the generate flow and UI

**Files:**
- Modify: `src/generate.ts`
- Modify: `src/select.ts`
- Modify: `tests/select.test.ts`
- Test: `tests/select.test.ts`

**Step 1: Write the failing test**

Add tests that assert selection labels show score and reason hints when ranking metadata exists.

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test tests/select.test.ts`
Expected: FAIL because labels do not yet expose ranking context.

**Step 3: Write minimal implementation**

Insert the ranking stage into `generate.ts` and render lightweight ranking metadata in `select.ts`.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test tests/select.test.ts`
Expected: PASS

### Task 5: Emit selection report artifacts

**Files:**
- Modify: `src/publish.ts`
- Modify: `src/types.ts`
- Create or Modify: helper logic under `src/`
- Test: `tests/format.test.ts`

**Step 1: Write the failing test**

Add a test that asserts the report writer preserves ranking, LLM selection, and human selection metadata.

**Step 2: Run test to verify it fails**

Run: `npm test`
Expected: FAIL because no report artifact is generated.

**Step 3: Write minimal implementation**

Write `output/selection-report.json` during publish using the current run metadata.

**Step 4: Run test to verify it passes**

Run: `npm test`
Expected: PASS

### Task 6: Run full verification

**Files:**
- Test: `tests/*.test.ts`

**Step 1: Run the full test suite**

Run: `npm test`
Expected: PASS

**Step 2: Review scope**

Confirm the change set is limited to scoring, ranking integration, prompt contract, and reporting. Avoid unrelated formatter or publishing behavior changes.
