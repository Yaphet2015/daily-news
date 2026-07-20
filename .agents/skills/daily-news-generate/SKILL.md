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
`DAILY_NEWS_REPO=/path/to/daily-news` only when invoking from outside the repo. Run `status` (the default)
any time to see where you are.

| Command | What it does |
|---|---|
| `preflight` | Validate repo root, modules, data/output dirs, repo-local `tsx`. |
| `diagnose` | Environment fingerprint + collection preflight. |
| `status` | Draft date, which stage artifacts exist, and the **next action**. |
| `collect [--resume\|--discard]` | Collect into `data/pending-draft.json`. With an existing draft and no flag it reports and exits so you can ask the user. |
| `curate-input` | Deterministic rank → `output/<date>-curate-input.json` (the pool **you** curate from). |
| `curate-apply` | Enrich **your** `output/<date>-curate-output.json` into `output/<date>-curation.json`. |
| `select [--force]` | Serve interactive HTML on a **stable** port (default 8427, override `DAILY_NEWS_SELECT_PORT`); blocks until the user confirms, then writes `output/<date>-selection.json`. Selections persist in the browser across reloads. |
| `publish` | Format + publish files, advance `data/state.json`, clear the draft. |

## Hard rules

- **No third-party LLM / AI API.** You are the curator. Never call `curateWithDiagnostics`, `attachReaderBriefs`,
  the `ai`/`openai` SDKs, or any external model. Deterministic helpers (`rankItems`, `enrichCuratedItemsWithDiagnostics`)
  are fine — they are pure functions.
- Do not run `npm run …` scripts or the monolithic `src/generate.ts` entrypoint.
- Do not auto-select or auto-publish. Selection is the user's, in the HTML page.
- **During `select`, keep the server alive until the user confirms.** The simplest way is one **foreground**
  blocking `select` call — it occupies the turn, so the server lives until the call returns. Only fall back to a
  background launch if you also keep a foreground poll running: a background task is reaped (SIGTERM) at turn's
  end, killing the server mid-selection and making the user's 确认发布 fail with "Failed to fetch" (see stage 5).
  Proceed only once the selection file exists.
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
curate-input → output/<date>-curate-input.json   (candidate pool for you)
YOU curate   → output/<date>-curate-output.json   (you write this — see below)
curate-apply → output/<date>-curation.json        (enriched CuratedItem[])
select       → output/<date>-select.html  +  output/<date>-selection.json
publish      → output/<date>-substack.html , output/<date>-selection-report.json , Obsidian file
              then advances state.json and clears pending-draft.json
```

### 1. collect
Run `collect`. If a draft already exists, the command prints `PENDING_DRAFT_EXISTS` with its date/count and
exits **without flags**. Ask the user: resume the existing draft or discard and re-collect, then re-run with
`--resume` or `--discard`. (Mirrors the interactive resume/discard/cancel choice in `npm run generate`.)

**Sources:** `collect` reads `ENABLED_SOURCES`, which **defaults to `twitter` only**. To also collect Substack,
set `ENABLED_SOURCES=twitter,substack` plus the required Substack env (`SUBSTACK_PUBLICATION_URL`, etc.) in `.env`
— so a Twitter-only run is by design, not a bug. Transient Twitter `429`/timeout aborts that leave no draft are
safe to retry: just re-run `collect` (idempotent until a draft is written).

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

**Categories:** `Product` = launches, feature updates, tooling, company moves, research that changes what people
can use/buy now · `Tutorial` = how-to, workflows, implementation guidance, teardown explainers ·
`Opinions/Thoughts` = analysis, essays, strategic takes, market interpretation.

**Faithfulness:** do not invent facts. Careful inference is allowed but must stay anchored to the source. If a post
looks like showing off but reveals capability/progress/distribution/strategy, make that deeper signal explicit.
Treat media metadata as "a visual exists", not pixel-level knowledge. For Substack, use the body text provided; do
not invent beyond it. If you need more detail on an item, you may fetch its URL — but the published summary must
stay faithful to what the source actually says.

> If the file is large, you may curate in batches and merge into one `curate-output.json` between batches — the
> stage is recoverable. Keep going until you've covered the high-signal pool.

### 4. curate-apply
Run `curate-apply`. It calls the repo's **deterministic** `enrichCuratedItemsWithDiagnostics(yourItems, candidateItems)`
to resolve url/author/attribution/media/scores/sourceResolution/threadPartCount from the source candidates, drops
items with bad ids/urls or duplicates, and writes `output/<date>-curation.json` + diagnostics. If it reports zero
curated items or many rejections, inspect: usually a copied-id or copied-url mistake in your `curate-output.json`.

### 5. select (user, via HTML)
The select server binds a **stable** port (default 8427, override `DAILY_NEWS_SELECT_PORT`), blocks until the user
clicks 确认发布, and persists ticks to `localStorage` (keyed by date) — so a restart or accidental reload never
loses selections. The confirm endpoint is `serverOrigin + '/select'` POST `{date, selectedIds}`.

**Preferred — one foreground blocking call** (simplest and robust; the command blocks until confirm by design):
1. Run `select` as a **foreground** Bash call with a long `timeout` (e.g. ~600000ms). It prints `SELECT_URL=` and
   `SELECTION_FILE=`, then **blocks until the user confirms**, at which point it writes the selection file and
   returns.
2. Give the user the URL; ask them to open it, choose **6–10** items, and click 确认发布.
3. If the call returns (e.g. on timeout) **without** the selection file yet, just re-run `select` in the same turn —
   it is idempotent, lands on the same stable port, and the user's ticks are still in `localStorage`. Repeat until
   the file exists.
4. Once the selection file exists, proceed to `publish`.

**Fallback — background launch + foreground poll** (only if your harness caps foreground Bash too short): launch
`select` in the background (`run_in_background: true`), then keep a **foreground** poll for `SELECTION_FILE` running
in the same turn. Do **not** end your turn while polling — a background task is reaped (SIGTERM) at turn's end,
which kills the server and makes 确认发布 fail with "Failed to fetch". If the poll times out, re-issue it in the
same turn (selections survive via `localStorage`).

If the browser can't reach the page, the user's proxy is likely intercepting `127.0.0.1` — have them add
`127.0.0.1`/`localhost` to the proxy bypass list, then re-open.

**Escape hatch:** the user may interrupt and paste their picks (by title/number from the curation). In that case
write `output/<date>-selection.json` directly as `{date, selectedItems}` (resolve ids against
`output/<date>-curation.json`), then run `publish`. Re-running `select` is idempotent unless `--force`.

### 6. publish (you complete it)
Run `publish` once `output/<date>-selection.json` exists. It formats the selection, writes
`output/<date>-substack.html`, `output/<date>-selection-report.json`, and the Obsidian file (when
`OBSIDIAN_VAULT_PATH` is set), records preference history, advances `data/state.json`, and clears the draft.

## Reporting

After `publish`, report: date, selected count, the substack draft path, the selection-report path, and that state
was advanced + draft cleared. If a run fails, run `diagnose` when it looks environment/proxy/Twitter/cwd/PATH/
dependency related; otherwise report the failing stage and the exact error. Run `status` first whenever resuming.
