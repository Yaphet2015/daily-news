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
node .claude/skills/daily-news-generate/scripts/daily-news-agent.mjs <command> [flags]
```

Set `DAILY_NEWS_REPO=/path/to/daily-news` only when using a non-default checkout. Default repo:
`/Users/suosuo/workspace/personal/daily-news`. Run `status` (the default) any time to see where you are.

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
- **During `select`, never end your turn while the server is still needed.** A background bash task is reaped
  (SIGTERM) the moment your turn ends, which kills the select server mid-selection and makes the user's 确认发布
  fail with "Failed to fetch". Keep the turn alive by polling for the selection file (see stage 5); only after it
  exists may you proceed.
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

### 2. curate-input (deterministic)
Run `curate-input`. It ranks the draft (no LLM — `readerBrief` is only a ranking bonus and is skipped here),
takes the candidate pool, preserves any `forceSelect` items, caps to `DAILY_NEWS_CURATE_POOL` (default 80), and
writes `output/<date>-curate-input.json`. Each candidate carries its full `CollectedItem` fields (url, author,
media, linkedSource, selfThread, replyContext, scores, decisionReasons) — exactly what the deterministic
enricher needs later.

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
The select server must stay alive from the moment you start it until the user clicks 确认发布. In this harness a
background bash task is reaped (SIGTERM) when your turn ends — so the server only survives while you keep a tool
call running. Procedure:

1. Launch **`select` in the background** (`run_in_background: true`). It binds a **stable** port (default 8427,
   override `DAILY_NEWS_SELECT_PORT`) and stays up until confirm. Read `SELECT_URL=` and `SELECTION_FILE=` from its
   output.
2. In the **same turn**, give the user the URL and ask them to open it, choose **6–10** items, and click 确认发布.
3. Immediately run a **foreground** wait that polls for the `SELECTION_FILE` (Bash, `timeout` ~590000ms). This is
   what keeps the turn — and therefore the server — alive.
4. **Do not end your turn while waiting** — no final message, no handing control back. If the poll times out with no
   selection yet, **re-issue the foreground poll in the same turn** and keep waiting. The server stays up on its
   stable port and the user's ticks are persisted in the browser (localStorage), so neither a server restart nor an
   accidental reload loses selections.
5. Once the selection file exists, proceed to `publish`.

The page persists selections to localStorage (keyed by date); the confirm endpoint is `serverOrigin + '/select'`
POST `{date, selectedIds}`. If the browser can't reach the page, the user's proxy is likely intercepting `127.0.0.1`
— have them add `127.0.0.1`/`localhost` to the proxy bypass list, then re-open.

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
