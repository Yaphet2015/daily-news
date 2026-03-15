# Editorial Depth Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Raise curated summaries from compact leads to materially longer, investigative briefs with clearer context, evidence, implications, and caveats.

**Architecture:** The behavior is controlled primarily by the curation system prompt, so the safest change is to treat the prompt as a versioned contract and lock the new editorial requirements with tests. Supporting docs should mirror the same output standard so future edits do not silently revert the product back to short recaps.

**Tech Stack:** TypeScript, Node test runner, Markdown prompt files

### Task 1: Lock the new editorial contract in tests

**Files:**
- Modify: `tests/curate.test.ts`
- Test: `tests/curate.test.ts`

**Step 1: Write the failing test**

Add a prompt-contract test that asserts:
- the summary requirement no longer says `2-4 sentences`
- the prompt requires `4-7 sentences` or an equivalent materially longer target
- the prompt explicitly asks for deeper analytical layers such as underlying dynamics, structural shifts, second-order implications, or unresolved uncertainty

**Step 2: Run test to verify it fails**

Run: `node --import tsx --test-name-pattern="curator prompt requires materially longer investigative summaries" --test tests/curate.test.ts`
Expected: FAIL because `prompts/curator.md` still instructs the model to write `2-4 sentences`

**Step 3: Write minimal implementation**

Update `prompts/curator.md` so the summary requirement becomes materially longer and explicitly investigative.

**Step 4: Run test to verify it passes**

Run: `node --import tsx --test-name-pattern="curator prompt requires materially longer investigative summaries" --test tests/curate.test.ts`
Expected: PASS

### Task 2: Align product docs with the new output standard

**Files:**
- Modify: `docs/design.md`

**Step 1: Update the design note**

Add a short sentence to the curation step explaining that the main model should output editor-style deep briefings rather than compact summaries, including facts, evidence, structural signal, and uncertainty.

**Step 2: Verify docs remain accurate**

Read the updated section and confirm it matches the prompt contract without adding new unsupported behavior.

### Task 3: Run regression checks

**Files:**
- Test: `tests/curate.test.ts`
- Test: `tests/format.test.ts`

**Step 1: Run targeted tests**

Run: `npm test`
Expected: PASS

**Step 2: Review for scope control**

Confirm no formatter or type changes were introduced, since the output schema remains unchanged and only editorial depth changed.
