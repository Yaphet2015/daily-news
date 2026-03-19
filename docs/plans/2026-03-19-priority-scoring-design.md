# Priority Scoring And Selection Explainability Design

**Goal:** Make curation ranking explicit, reproducible, and inspectable without throwing away the current editor-style final selection.

**Architecture:** Introduce a deterministic ranking stage between `collect` and `curate`. The ranking stage computes a per-item `priorityScore`, a structured score breakdown, duplicate relationships, and machine-readable decision reasons. The main LLM no longer acts as the only ranking brain; it becomes the final editorial layer operating on a pre-ranked candidate pool.

**Tech Stack:** TypeScript, Node.js, existing OpenAI / ai-sdk curation path, JSON debug artifacts

## Problem

Today the pipeline collects all candidates and asks the main curation model to choose and rewrite the best items in one pass. This is simple, but it has three long-term problems:

- ranking is implicit, so it is hard to explain why one item beat another
- selection is not reproducible, because the model can make slightly different trade-offs on the same batch
- debugging quality regressions is expensive, because there is no score history or structured rejection reason

The system needs a stable first-pass notion of "information value" while preserving LLM judgment for final editorial packaging.

## Non-Goals

- Do not build a personalized recommender system
- Do not introduce author-level historical baselines in v1
- Do not let engagement metrics dominate the ranking
- Do not require the LLM to generate natural-language rejection explanations for every dropped item

## Proposed Flow

### Stage 1: Collect

Keep the existing source collection flow, but extend Twitter collection to capture engagement metrics when available:

- `likeCount`
- `replyCount`
- `repostCount`
- `quoteCount`

If a source path cannot provide these metrics, the value remains absent rather than guessed.

### Stage 2: Rank

Add a new `rank.ts` stage that processes every collected item before main curation.

Responsibilities:

- compute deterministic per-item features
- compute `editorialScore`
- compute Twitter-only `engagementScore`
- compute final `priorityScore`
- detect near-duplicate items inside the same batch
- assign structured `decisionReasons`
- keep an inspectable ranking report for every candidate

### Stage 3: Curate

Change the main LLM curation step so it no longer sees the entire raw batch by default. Instead:

- pass only the top-ranked candidate pool to the main model
- include score metadata and duplicate markers in the prompt
- ask the model for final item ordering, rewritten summaries, and a short `editorialReason` for selected items

The main model still decides the final digest composition, but inside a bounded, higher-signal pool.

### Stage 4: Select

Update the interactive selection UI to show lightweight ranking context:

- `priorityScore`
- concise score highlights
- optional duplicate or penalty hints

This keeps human override simple while making the machine's ranking legible.

### Stage 5: Report

Write a machine-readable artifact such as `output/selection-report.json` containing:

- all candidates
- score breakdowns
- duplicate relationships
- whether each item reached the LLM candidate pool
- whether each item was selected by the LLM
- final human selection state if available

This artifact becomes the debugging and tuning surface.

## Scoring Model

### Overview

The scoring system should reward information value first, then use engagement as a weak market-validating signal.

`priorityScore = 0.75 * editorialScore + 0.25 * engagementScore`

If `substance` or `evidence` is below a minimum floor, cap the contribution from `engagementScore` so weak posts cannot rank highly just because a large account posted them.

### Editorial Score

`editorialScore` is the main signal and should stay dominant.

Suggested dimensions:

- `substance`
  - concrete facts, launches, version numbers, data points, product changes, research claims, implementation details
- `evidence`
  - external links, screenshots, charts, media assets, Substack reader brief claims, concrete supporting detail
- `sourceSignal`
  - official source, credible publication, identifiable operator, clear domain expertise
- `freshness`
  - favor newer items, but with a smooth decay rather than a cliff
- `novelty`
  - reward distinct information and penalize items that repeat the same event already covered in the batch
- `actionability`
  - tutorials, workflows, tools, implementation guidance, reproducible lessons
- `penalties`
  - hiring posts, self-promotion without substance, vague excitement, pure reposts, engagement bait, thin commentary

Implementation should use bounded per-dimension scores rather than opaque floats so tuning stays practical.

Suggested v1 shape:

- `substance`: 0-30
- `evidence`: 0-20
- `sourceSignal`: 0-15
- `freshness`: 0-10
- `novelty`: 0-15
- `actionability`: 0-10
- `penalties`: -30 to 0

Then normalize to `editorialScore` in the range 0-100.

### Engagement Score

`engagementScore` applies only to Twitter items and should remain secondary.

Use time-weighted engagement velocity rather than raw totals:

`rawEngagement = likeCount + 3 * replyCount + 2 * repostCount + 4 * quoteCount`

`engagementVelocity = log(1 + rawEngagement) / (ageHours + 2)^0.7`

Rationale:

- `reply` and `quote` are stronger signals than `like`
- `log` reduces superstar-account distortion
- time decay rewards strong early pickup rather than old accumulated volume

For non-Twitter items, `engagementScore` defaults to 0 unless a future source provides equivalent structured signals.

### Duplicate Handling

Near-duplicates should be penalized before main curation so the LLM is not wasting budget comparing many copies of the same event.

Duplicate detection should combine:

- identical URL
- same normalized title or same dominant entity + event wording
- very high text similarity
- same outbound link with different commentary wrappers

When duplicates exist:

- keep the strongest representative as the primary item
- mark weaker siblings with `duplicateOf`
- apply a ranking penalty to non-primary duplicates

Do not hard-delete duplicates before reporting; keep them visible in the report.

## Explainability Model

### Machine Reasons

Every ranked item should carry machine-readable `decisionReasons`. These are the canonical explanation surface for debugging and future UI.

Recommended reason codes:

- `high_substance`
- `strong_evidence`
- `official_source`
- `actionable_tutorial`
- `fresh_high_signal`
- `duplicate_of:<item-id>`
- `low_substance`
- `weak_evidence`
- `promotional`
- `stale`
- `engagement_supporting_only`
- `below_cutoff`

These codes should be produced deterministically by the ranking layer.

### Editorial Reason

Only selected items need a natural-language `editorialReason` from the main model. Keep it short, one sentence, and anchored to the actual signal:

- what happened
- why this specific item is the best representative
- why a reader should care now

This avoids wasting tokens generating story-like explanations for every rejected candidate.

## Candidate Pool Strategy

Do not send every collected item to the final curation model.

Recommended v1 approach:

- rank all items
- remove or heavily de-prioritize obvious low-value items
- send top `N` items to the main model

Suggested `N`:

- if collected items <= 80: send top 50
- if collected items > 80: send top 60

The exact number can be tuned later, but the important part is that the LLM receives a bounded high-signal pool rather than the full noisy batch.

## Data Model Changes

### Extend `CollectedItem`

Add optional Twitter engagement fields:

- `likeCount?: number`
- `replyCount?: number`
- `repostCount?: number`
- `quoteCount?: number`

### Add Ranked Types

Introduce explicit ranking types in `types.ts`:

- `ScoreBreakdown`
- `RankedItem`
- `SelectionDecision`

Suggested contents:

- `editorialScore`
- `engagementScore`
- `priorityScore`
- `scoreBreakdown`
- `duplicateOf?`
- `decisionReasons`
- `enteredCandidatePool`
- `selectedByLlm`
- `selectedByHuman`
- `editorialReason?`

## LLM Prompt Contract Changes

The curation prompt should stop carrying full responsibility for hidden ranking. Instead it should:

- accept pre-ranked candidates
- prefer higher-ranked representatives when similar items overlap
- preserve editorial freedom when two items are close in score but differ in reader value
- return selected items plus a short `editorialReason`

The prompt should explicitly state that score is guidance, not a blind command. The LLM remains free to reject a high-scoring item if it is still editorially weak, but that override becomes visible.

## Testing Strategy

### Unit Tests

Add deterministic tests for:

- per-dimension score calculation
- engagement velocity calculation
- duplicate detection behavior
- cutoff and reason-code assignment
- capping engagement influence when substance or evidence is weak

### Prompt Contract Tests

Add tests to confirm the curation prompt now expects:

- ranked candidate input
- `editorialReason` output
- no requirement for the model to explain every rejected item

### Regression Tests

Use fixed candidate fixtures to validate that:

- high-substance posts outrank high-hype low-substance posts
- duplicate variants do not crowd out the candidate pool
- engagement helps break close ties but does not override clearly weak content

## Rollout Plan

### Phase 1

- extend collected Twitter data with optional engagement metrics
- add ranking types and scoring module
- emit ranking report without changing the existing curation behavior

### Phase 2

- gate the main LLM candidate pool using ranked output
- add `editorialReason`
- surface scores and reason hints in `select`

### Phase 3

- tune weights against real daily batches
- refine duplicate detection and penalty rules based on observed misses

## Key Trade-Off

This design intentionally chooses a hybrid model:

- deterministic ranking for stability, debugging, and explainability
- LLM editorial selection for nuance, grouping, and final digest quality

Pure rules would be easier to explain but worse at editorial judgment. Pure LLM would stay flexible but remain opaque. The hybrid approach is the smallest change that materially improves long-term control.
