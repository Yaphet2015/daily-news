---
name: daily-news-generate
description: Use when the user asks to run, resume, collect, curate, select, or publish the daily-news digest from an agent session.
---

# Daily-News Generate (agent-driven)

You are the curator. No third-party LLM. Deterministic logic lives in `src/*.ts`.

```bash
node .agents/skills/daily-news-generate/scripts/daily-news-agent.mjs <command> [flags]
```

Cwd is the repo root. Set `DAILY_NEWS_REPO` only when outside the repo. Flags: `--help`.
`preflight` already runs inside every command. `diagnose` only when collect/env fails.
Do **not** use this skill to change ranking code or to reread an old report.

Agent-facing commands: `status`, `collect [--resume|--discard]`, `curate-input`, `curate-apply`, `select-start [--force]`, `select-stop`, `publish`, `blog-publish [--date=YYYY-MM-DD] [--force]`, `feedback-apply --date=YYYY-MM-DD`.
Never run blocking `select`. `select-start` still spawns it internally.

## Recovery

**`status` is the pre-publish recovery guide.** If a draft exists, run `status` and do only the next action it names.

**After publish, do not collect yet.** Publish clears the draft, so `status` says `collect`. That starts the *next* day. For the date you just published: run `select-stop`, then review feedback (below).

`select-start` writes a pending `selection-decision.json` immediately. **Pending is not confirmed.** Do not publish until `status` says publish.

## Hard rules

- No `curateWithDiagnostics`, `attachReaderBriefs`, `ai`/`openai` SDKs, `npm run …`, or `src/generate.ts`. `rankItems` and `enrichCuratedItemsWithDiagnostics` are fine.
- Do not auto-select or auto-publish.
- `select-start`, then **end the turn**. After publish, `select-stop`.
- Fail loud on missing/malformed/empty stage output.
- `ClientTransaction` stderr is non-fatal unless JSON parse failure, `ok:false`, or process exit failure.
- Do not treat teaser-only Substack as the full article.

## Pipeline

```
collect      → data/pending-draft.json
curate-input → output/<date>-ranking.json + output/<date>-curate-input.json
YOU curate   → output/<date>-curate-output.json
curate-apply → output/<date>-curation.json
select-start → pending then confirmed selection-decision.json
publish      → report + histories; advances state.json; clears draft
then          select-stop, then feedback-apply if you write an adjustment
```

Date comes from the draft's `collectedAt`. One in-flight draft. Inputs stay until publish succeeds.

### 1. collect

Run `collect`. Existing draft + no flag → `PENDING_DRAFT_EXISTS`, nothing destroyed. Ask resume vs discard, then `--resume` or `--discard`.
`ENABLED_SOURCES` defaults to `twitter,aihot`. Substack is opt-in. Twitter-only is `ENABLED_SOURCES=twitter`.
Same-author tweets within 30s collapse into `selfThread`. Retry empty 429/timeout collects.

### 2. curate-input

Run `curate-input`. Pool is `candidateItems` (not `items`), cap `DAILY_NEWS_CURATE_POOL` (default 80), `forceSelect` kept. No LLM; `readerBrief` is skipped.

### 3. curate (you)

Read `prompts/curator.md` for tone, filters, categories, volume, and JSON shape.

This pipeline has **no reader brief**. Use card body / `linkedSource` / fetched original.

**Copy contract:** `id` and `url` verbatim from the candidate. If you cannot copy the id, omit the item. `author` is fallback; the enricher re-derives it. Duplicate normalized urls collapse (`duplicate_url`). A url that does not match after normalization is dropped (`url_mismatch`).

**`twitterFeed: 'for-you'`:** keep only AI models/products/agents/tooling/research/infra/industry moves. Drop general tech, jokes, hiring, engagement-farming.

**Do not read the whole `curate-input.json`.** A typical file is ~0.5–0.7MB / 80 items. Slice `candidateItems`. Keep fields: id, url, author, text, media, linkedSource, selfThread, outboundLinks, quotedStatusUrl, quotedTweetText, sourceResolution, twitterFeed, kind, collectionWarnings.
Write progress to `output/<date>-curate-output.partial.json`. Do **not** write `output/<date>-curate-output.json` until the high-signal pool is covered (deduped, ordered). Near the session token budget, stop after saving the partial and resume later. `curate-apply` reads only the final file; a premature final file will look done.

**When the card is not enough, fetch; otherwise drop or stay on verbatim card text:**

| You see | Do |
|---|---|
| Truncated text, bare `t.co`, or missing method/data | Fetch the original. Never put collection-limitation notes in the summary. |
| Video / caption-only | Read `selfThread.combinedText` and later-part `outboundLinks` first. Do not write from the caption alone. |
| `quotedStatusUrl` set but no `linkedSource`, or the quote is itself a rec | Trace to the final article. Do not write lab/product news from the wrapper. |
| `collectionWarnings` has `官方博文抓取失败（403）`, or links to openai.com / anthropic.com (incl. subdomains) | Open that URL and write from the page. Other 403s: drop or stay on the card. |
| `kind: substack_roundup_entry` or `sourceResolution.reason` is `roundup_destination` / missing | `url` is the source. Open the destination before writing institutional news. |
| `sourceResolution.reason` is `quote_wrapper` / `embedded_quote_wrapper` | `author` is the quoted account. Summarize `linkedSource`. Wrapper text is commentary only. |

### 4. curate-apply

Run `curate-apply`. Zero curated items or many rejections → usually a copied id/url mistake. Inspect; do not paper over.

### 5. select-start

Run `select-start`, tell the user to pick 6–10 items (optional 评分过高 / 评分过低, optional 备注), then **end the turn**.
Do not operate the HTML. `selection-decision.json` is SSOT. Legacy `selection.json` is not publish input.

### 5b. Write the one-line description (before publish)

After selection is confirmed (status says publish), write `output/<date>-desc.txt`: **one line of Chinese, ≤80 chars**, summarizing this issue's highlights (names + numbers beat adjectives, e.g. `Gemini 3.5 发布、OpenAI 开源 o4-mini，本期 9 条`). One `writeFile`, no extra deps. If missing or multi-line, `blog-publish` falls back to the generic tagline and the publish output will flag it — write it before every publish; on a flagged retry, write the file then re-run `blog-publish --date=<date>`.

### 6. publish

After `status` says publish: `publish`, then `select-stop`.

`publish` now also syncs the issue to **blog.yaphet.me** (Daily-News section) automatically: repo `output/` Markdown (Vault fallback) → astro-blog branch → `gh` PR → squash merge → CI build & EdgeOne deploy → live check. The sync is idempotent and fire-and-report: if it fails, publish still succeeds and the output shows a retry hint — run `blog-publish --date=<date>` to retry. Set `DAILY_NEWS_BLOG_AUTOSYNC=0` to skip the blog sync entirely. Requires `gh` logged in on the machine (`gh auth login && gh auth setup-git`); no local astro-blog build, no EdgeOne token needed.

## Post-publish feedback

If publish prints `本期无评分反馈和备注`, stop. Else read `output/<date>-feedback-review.json`.

1. Scoring remarks ("down-weight this author/topic") — treat like button feedback. Attribute to the **smallest content Tag** or Ranking Signal. Do not default to author/domain.
2. Collection/parse remarks — bug report, not a preference. Do not touch scoring. Investigate collect / linked-source / curate-input. Propose a fix. No transient known-issues list.
3. Prefer one existing matched Tag. If too broad, one controlled `custom:*` Tag.
4. One event: at most one Tag, at most 2 points. Never adjust a Ranking Signal from one event.
5. A global Ranking Signal needs 3 same-direction events across at least 2 runs.
6. Conflict or weak evidence → `no_change` with a reason.
7. Never modify author/domain rules, source enablement, or the `@tom_doerr` hard filter.
8. Write `output/<date>-feedback-adjustment.json`, then `feedback-apply --date=<date>`.
9. Report before/after policy revision, evidence IDs, changed Tag/Signal IDs, expected next-run effect.

The Agent attributes. `feedback-apply` is the only validator and writer.

## Reporting

After publish (and any feedback-apply): date, selected count, artifact paths, feedback count, adjustment status, policy revision. On failure: exact stage and error. Do not claim completion.
