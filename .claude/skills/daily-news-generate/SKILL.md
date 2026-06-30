---
name: daily-news-generate
description: Use when preparing, diagnosing, reviewing, or publishing the user's daily-news workflow from an agent session, especially from outside the daily-news repo.
---

# Daily-News Generate

Use this as the entry point for the daily-news workflow. The skill owns orchestration; the repo modules own domain logic.

## Command Surface

Run from any workspace:

```bash
node /Users/suosuo/.agents/skills/daily-news-generate/scripts/daily-news-agent.mjs review
```

Set `DAILY_NEWS_REPO=/path/to/daily-news` only when using a non-default checkout. Default repo:
`/Users/suosuo/workspace/personal/daily-news`.

## Modes

- `review` default: collect or append draft, attach reader briefs, rank, curate, write review packet, summarize paths and diagnostics.
- `diagnose`: print environment fingerprint and run collection preflight checks.
- `preflight`: validate repo root, split pipeline modules, output/data dirs, and repo-local `tsx`.
- `publish`: explicit user request only; requires interactive TTY for manual selection, then formats, publishes local files, records preference history, advances state, and clears draft.

## Hard Rules

- Do not run package scripts for this workflow.
- Do not call the monolithic generate entrypoint.
- Do not auto-publish or auto-select items.
- Fail loud if review output is missing, malformed, empty, or curation diagnostics indicate likely contract drift.
- Treat `twitter-feed stderr` ClientTransaction noise as non-fatal unless paired with JSON parse failure, `ok:false`, or child-process exit failure.
- Preserve auditability for teaser-only Substack content; do not summarize inaccessible preview text as if it were full article content.

## Reporting

After `review`, report:

- Review JSON path
- Review Markdown path
- Curated item count
- Enabled sources
- Collection warnings
- Curation diagnostics
- Next action

If a run fails, run `diagnose` when the failure looks environment, proxy, Twitter, cwd, PATH, or dependency related. Otherwise report the failing stage and the exact error.
