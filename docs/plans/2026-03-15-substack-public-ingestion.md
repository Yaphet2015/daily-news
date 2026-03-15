# Substack Public Ingestion Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the stale authenticated Substack input path with a public profile plus RSS collector that works without `connect.sid`.

**Architecture:** Discover followed publications from the reader's public `substack.com/@handle` profile page, then fetch each publication's public RSS feed and map feed entries into the existing `CollectedItem` shape. Keep the current filtering, sorting, and per-publication/global caps so the rest of the pipeline stays unchanged.

**Tech Stack:** TypeScript, Node.js built-in `fetch`, Node test runner

### Task 1: Lock behavior with failing parser tests

**Files:**
- Modify: `tests/collect.test.ts`

**Step 1: Write the failing test**

Add tests for:
- extracting followed publications from saved public profile HTML
- extracting recent post metadata from a publication RSS feed

**Step 2: Run test to verify it fails**

Run: `npm test -- --test-name-pattern "Substack"`
Expected: FAIL because the parser helpers do not exist yet.

### Task 2: Implement public Substack helpers

**Files:**
- Modify: `src/collect.ts`

**Step 1: Write minimal implementation**

Add helpers to:
- derive the profile handle from `SUBSTACK_PUBLICATION_URL`
- parse followed publications from embedded `window._preloads`
- parse RSS items into the existing `SubstackPostLike` shape
- fetch public profile HTML and publication feeds

**Step 2: Run tests**

Run: `npm test -- --test-name-pattern "Substack"`
Expected: PASS

### Task 3: Replace the gateway collector path

**Files:**
- Modify: `src/collect.ts`

**Step 1: Update collector wiring**

Replace `createSubstackClient()` usage with the new public-data collector while preserving:
- `sinceTime`
- `SUBSTACK_SOURCE_MAX_POSTS`
- `SUBSTACK_SOURCE_MAX_POSTS_PER_PUBLICATION`

**Step 2: Run focused tests**

Run: `npm test`
Expected: PASS

### Task 4: Update docs and config examples

**Files:**
- Modify: `README.md`
- Modify: `.env.example`
- Modify: `package.json`

**Step 1: Remove stale auth guidance**

Document that Substack input now reads public followed publications and no longer needs `SUBSTACK_CONNECT_SID`.

**Step 2: Run tests after cleanup**

Run: `npm test`
Expected: PASS
