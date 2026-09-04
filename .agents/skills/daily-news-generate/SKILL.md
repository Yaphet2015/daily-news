---
name: daily-news-generate
description: Use when running the user's daily-news workflow from an agent session — collecting Twitter/Substack, curating the digest, selecting items, or publishing — especially from outside the daily-news repo. The agent performs curation; no third-party LLM is called.
---

# Daily-News Generate (agent-driven)

This skill mirrors the full `npm run generate` pipeline but **the agent is the curator**: there is no
third-party LLM or AI API anywhere in the loop. The skill owns orchestration; the repo's `src/*.ts`
modules own all deterministic domain logic (collect, rank, enrich, format, publish, state).

## Command surface

```bash
node .agents/skills/daily-news-generate/scripts/daily-news-agent.mjs <command> [flags]
```

The default repo root is the **current working directory** (run the command from the repo root). Set
`DAILY_NEWS_REPO=/path/to/daily-news` only when invoking from outside the repo. The **default command is `collect`** — running the bare
command starts a fresh collection, and if a draft already exists it reports and exits without
destroying it. Run `status` any time to see where you are (e.g. when resuming an interrupted run).

| Command | What it does |
|---|---|
| `preflight` | Validate repo root, modules, data/output dirs, repo-local `tsx`. |
| `diagnose` | Environment fingerprint + collection preflight. |
| `status` | Draft date, which stage artifacts exist, and the **next action**. |
| `collect [--resume\|--discard]` | Collect into `data/pending-draft.json`. With an existing draft and no flag it reports and exits so you can ask the user. |
| `curate-input` | Deterministic rank → `output/<date>-curate-input.json` (the pool **you** curate from). |
| `curate-apply` | Enrich **your** `output/<date>-curate-output.json` into `output/<date>-curation.json`. |
| `select-start [--force]` | **Preferred.** Launch the select server **detached** (survives the turn boundary), **auto-open the default browser**, write `output/<date>-select.pid` + `select.log`, then **return immediately** (the agent is NOT blocking). Server self-exits on confirm. |
| `select-stop` | Stop the detached server from `select.pid` (SIGTERM→SIGKILL) and remove the pidfile. **Always run after `publish`.** Idempotent. |
| `select [--force]` | Legacy foreground HTML server. Selection, score feedback, and per-item remarks persist to `output/<date>-selection-decision.json`. |
| `publish` | Publish from canonical ranking/curation/decision artifacts, record feedback, advance state, clear draft. |
| `feedback-apply --date=YYYY-MM-DD` | Validate the Agent-authored adjustment and atomically update `data/preference-rules.json`. |

## Hard rules

- **No third-party LLM / AI API.** You are the curator. Never call `curateWithDiagnostics`, `attachReaderBriefs`,
  the `ai`/`openai` SDKs, or any external model. Deterministic helpers (`rankItems`, `enrichCuratedItemsWithDiagnostics`)
  are fine — they are pure functions.
- Do not run `npm run …` scripts or the monolithic `src/generate.ts` entrypoint.
- Do not auto-select or auto-publish. Selection is the user's, in the HTML page.
- **`select` is non-blocking: use `select-start` (detached) + `select-stop`, never a blocking foreground `select`.**
  A blocking `select` keeps you "working" (the user cannot steer mid-selection) and dies when aborted (timeout or
  the user's next message), making 确认发布 fail with "Failed to fetch". `select-start` spawns a detached server
  (new session — not reaped at turn's end) that survives the turn boundary and auto-opens the browser; you then
  end your turn and stay free. After the user confirms and you run `publish`, **always run `select-stop`** to clean
  up the detached server. See stage 5.
- Fail loud: if any stage output is missing, malformed, empty, or rejected every item, stop and report — do not paper over it.
- Treat `twitter-feed stderr` `ClientTransaction` noise as non-fatal unless paired with a JSON parse failure, `ok:false`, or child-process exit failure.
- Preserve auditability for teaser-only Substack content; do not summarize inaccessible preview text as if it were the full article.

## The pipeline (and where each stage is recovered from)

Every stage persists a dated artifact, so the pipeline is **interruptible and recoverable**: if a run is
cut off, re-run `status`, then re-run the stage it names. Inputs are never destroyed until `publish` succeeds.
The date is derived from the draft's `collectedAt`; there is at most one in-flight draft.

```
data/state.json ── lastPublishedTime per source (advances ONLY on successful publish)
data/pending-draft.json ── collected snapshot (the anchor; cleared ONLY on successful publish)

collect      → data/pending-draft.json
curate-input → output/<date>-ranking.json + output/<date>-curate-input.json
YOU curate   → output/<date>-curate-output.json
curate-apply → output/<date>-curation.json
select       → output/<date>-select.html + output/<date>-selection-decision.json
publish      → selection-report.json + score-feedback-history.jsonl + optional feedback-review.json
              then advances state.json and clears pending-draft.json
Agent review → output/<date>-feedback-adjustment.json → feedback-apply → data/preference-rules.json
```

### 1. collect
Run `collect`. If a draft already exists, the command prints `PENDING_DRAFT_EXISTS` with its date/count and
exits **without flags**. Ask the user: resume the existing draft or discard and re-collect, then re-run with
`--resume` or `--discard`. (Mirrors the interactive resume/discard/cancel choice in `npm run generate`.)

**Sources:** `collect` reads `ENABLED_SOURCES`, which **defaults to `twitter,aihot`**. AI HOT pulls the
item-level `feed.xml` (50 curated items, no API key) and attributes each item to its **original source**
(the feed's "阅读原文" link + `<author>` label), so it enters the unified pool without surfacing the AI HOT
site. To also collect Substack, set `ENABLED_SOURCES=twitter,substack,aihot` plus the required Substack env
(`SUBSTACK_PUBLICATION_URL`, etc.) in `.env`. To disable AI HOT, set `ENABLED_SOURCES=twitter`. A Twitter-only
run is therefore opt-out (set `ENABLED_SOURCES=twitter`), not the default. Transient Twitter
`429`/timeout aborts that leave no draft are safe to retry: just re-run `collect` (idempotent until a draft
is written).

### 2. curate-input (deterministic)
Run `curate-input`. It ranks the draft (no LLM — `readerBrief` is only a ranking bonus and is skipped here),
takes the candidate pool, preserves any `forceSelect` items, caps to `DAILY_NEWS_CURATE_POOL` (default 80), and
writes `output/<date>-curate-input.json`. The top level is
`{ date, collectedAt, enabledSources, candidateItems: CollectedItem[] }` — read **`candidateItems`** (not `items`).
Each candidate carries its full `CollectedItem` fields (id, url, author `{name,username}`, text, media,
linkedSource `{title,description,excerpt}`, selfThread, replyContext, scores, decisionReasons) — exactly what the
deterministic enricher needs later.

### 3. curate (YOUR job — the heart of this skill)
Read `output/<date>-curate-input.json`. Apply the editorial standard below, then **write**
`output/<date>-curate-output.json` as strict JSON:

```json
{ "items": [ { "id": "...", "title": "...", "summary": "...", "url": "...", "author": "...", "category": "Product", "editorialReason": "..." } ] }
```

- **`id`** — copy the exact `id` from the input. Never invent, shorten, renumber, or repair ids; if you can't
  copy it verbatim, omit the item.
- **`title`** — concise **Chinese** headline, ~15–30 Chinese characters; keep technical terms in English.
- **`summary`** — **Chinese**, **4–9 sentences / ~120–320 characters**. Read like a deeply reported briefing, not
  a recap. Preserve as many layers as the source supports: what happened → key details/data → the evidence → the
  underlying dynamic or structural shift → why it matters now → what is unclear/contested/unverified.
- **`url`** — copy the candidate's `url` (the primary source URL) **exactly**. A mismatch is rejected by the enricher.
- **`author`** — the source byline/username from the input (the enricher re-derives attribution from it).
- **`category`** — exactly one of `Product`, `Tutorial`, `Opinions/Thoughts` (see below). No other value is valid.
- **`editorialReason`** — one short **Chinese** sentence on why this earns a place in today's digest.

**Enricher hard constraints (why `curate-apply` rejects items):** `id` must match a candidate id exactly (matched
first); `url` must equal that candidate's `url` after normalization, else it is dropped as `url_mismatch`;
`author` is **re-derived from the source** (`username ?? name`), so the value you write is only a fallback and
need not be exact. Two of your items sharing the same normalized `url` collapse to one (`duplicate_url`).

**Volume:** aim for **40–50 items** (soft floor 40) when enough distinct high-signal items exist; on thin days,
quality over filler. Group mentally by category, most important first within each.

**Select / filter (from the curator standard):** prioritize launches, research, important updates, useful tools,
items with links/screenshots/charts/demos, and respected/official sources; treat `priorityScore`/`decisionReasons`
as a deterministic first-pass hint, not a verdict. Filter out pure emotion/jokes, ads/promotions/recruiting,
reposts with no added commentary, duplicates (keep only the most informative), and engagement-farming.

**Recommendation feed (`twitterFeed: 'for-you'`):** these are X's algorithmic recommendations for a fresh account
— far noisier than the curated `list`. The collect stage no longer AI-pre-filters them (no external API in this
skill), so **you** apply the AI-relevance bar during curation: keep only AI models/products, agents, AI dev tooling,
ML research, AI infra, benchmarks, AI-industry moves; drop general tech, generic productivity, mobile apps, jokes,
hiring, and engagement-farming even if high-engagement. Hold `for-you` items to a stricter bar than `list` items.

**Categories:** `Product` = launches, feature updates, tooling, company moves, research that changes what people
can use/buy now · `Tutorial` = how-to, workflows, implementation guidance, teardown explainers ·
`Opinions/Thoughts` = analysis, essays, strategic takes, market interpretation.

**Faithfulness:** do not invent facts. Careful inference is allowed but must stay anchored to the source. If a post
looks like showing off but reveals capability/progress/distribution/strategy, make that deeper signal explicit.
Treat media metadata as "a visual exists", not pixel-level knowledge. For Substack, use the body text provided; do
not invent beyond it. If a card is truncated, only has a `t.co`, or lacks method/data the summary needs, resolve and
fetch the original (paper HTML abstract, blog, docs) **before** writing. Never put collection-limitation notes in the
published summary (no 「帖文被截断」, 「没有给出方法名」, 「不能从推荐语发明」). If the original is still
unreachable, write only facts on the card, or drop the item. Fetched text must stay faithful to the source.
Roundup 子项（`kind: substack_roundup_entry`，或 `sourceResolution.reason` 为 `roundup_destination` / 缺失）：`url` 才是主源，bullet / `title` 不是事实。若 bullet 把动作安到学校、公司、政府头上，必须先打开 destination（推文、博客、论文）再写。打不开就丢掉，或只写卡片上逐字出现的句子，禁止写成机构新闻。
When `sourceResolution.reason` is `quote_wrapper` or `embedded_quote_wrapper`, `author` is the **quoted** account
(from `quotedStatusUrl`). Tweet `text` is the wrapper's commentary; `linkedSource` is the article. Do **not** write
that the quoting account wrote the article. Summarize the linked source; treat wrapper text as commentary only.

> If the file is large, you may curate in batches and merge into one `curate-output.json` between batches — the
> stage is recoverable. Keep going until you've covered the high-signal pool.

### 4. curate-apply
Run `curate-apply`. It calls the repo's **deterministic** `enrichCuratedItemsWithDiagnostics(yourItems, candidateItems)`
to resolve url/author/attribution/media/scores/sourceResolution/threadPartCount from the source candidates, drops
items with bad ids/urls or duplicates, and writes `output/<date>-curation.json` + diagnostics. If it reports zero
curated items or many rejections, inspect: usually a copied-id or copied-url mistake in your `curate-output.json`.

### 5. select (user, via HTML — non-blocking)

Use `select-start`, then end the turn. The HTML keeps publication checkboxes separate from score feedback. Each
item has `评分过高` and `评分过低`; the buttons are mutually exclusive and clicking the active direction revokes it.
Each card also has a free-text `备注` box on the right for human feedback (e.g. a linked article that failed to
parse, an author or topic that should be down-weighted): it saves on blur, empty text deletes the remark, and a
page reload restores saved remarks via `GET /decision`. Every click and remark save is immediately and atomically
persisted to `output/<date>-selection-decision.json` (`remarkById` mirrors `scoreFeedbackById`). The file is SSOT.
`localStorage` only caches checkbox state under `daily-news-select:<runId>:<curationRevision>`.

The feedback endpoint validates run identity and item ID. Selection and score feedback are independent: selected
or unselected never implies a score direction. After confirmation, verify `selection-decision.json`, run `publish`,
then run `select-stop`. Legacy `selection.json` is only a derived compatibility file and is not publish input.

### 6. publish and post-publish score review

Run `publish` after the canonical decision is confirmed. Publish consumes the persisted ranking; it never reranks.
It writes the selection report and idempotent histories before advancing state or clearing the draft.

If publish prints `本期无评分反馈和备注`, do not create an adjustment and there is nothing to investigate.
Otherwise it writes `output/<date>-feedback-review.json` (direction items, remark-only items, or both; a remark
rides along on its item's direction event). Continue the same workflow:

1. Read the review and its feedback evidence.
2. Split remarks into two classes:
   - **Scoring remarks** ("this author/topic should be down-weighted") — treat exactly like button feedback:
     attribute to the **smallest content Tag** or Ranking Signal, under the constraints below. Do not default to
     author/domain.
   - **Collection/parse remarks** ("the linked article failed to parse") — a bug report, not a preference signal.
     Do **not** touch scoring. Investigate the collection/enrichment code path involved (collect, linked-source
     extraction, curate-input generation), decide one-off bad URL vs systematic defect, and propose a fix plan to
     the user. Approved fixes land in the repo and persist — do not keep a transient known-issues list.
3. Prefer one existing matched Tag. If it is too broad, define one controlled `custom:*` Tag with content keywords.
4. With one event, adjust at most one Tag by at most 2 points. Never adjust a Ranking Signal from one event.
5. A global Ranking Signal requires 3 same-direction events across at least 2 runs.
6. If evidence conflicts or is insufficient, write `no_change` with a reason.
7. Never modify author/domain rules, source enablement, or the `@tom_doerr` hard filter.
8. Write `output/<date>-feedback-adjustment.json`, then run `feedback-apply --date=<date>`.
9. Report the before/after policy revision, evidence IDs, changed Tag/Signal IDs, and expected next-run effect.

The Agent provides semantic attribution. `feedback-apply` is the only validator and writer. It rejects broad or
unsupported changes and atomically updates `data/preference-rules.json`.

## Reporting

After publish and any feedback apply, report date, selected count, artifact paths, feedback count, adjustment
status, and policy revision. If any stage fails, report the exact stage and error; do not claim completion.
