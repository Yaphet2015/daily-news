# Source Resolution Fallbacks

**Date**: 2026-03-29
**Status**: Implemented

## Problem

Two source resolution gaps cause high-value content to lose evidence scoring and rank lower than it should.

### Case 1: X Article Without Article URL

Twitter CLI sometimes returns `articleTitle` / `articleText` fields (indicating the tweet has an embedded X article) but does NOT include a `/i/article/` URL in `tweet.urls` or the tweet text. Current code requires the URL to exist before creating a linkedSource, so the article metadata is silently discarded.

Example: chenchengpro's AI coding landscape analysis (2026-03-25) — the tweet has an X article but CLI returned it as a regular status URL. Result: `linkedSource: none`, `evidence: 0`, `priorityScore: 34`.

### Case 2: Author Self-Reply With Blog Link

Authors (notably chenchengpro) sometimes post a summary tweet and then reply to their own tweet with a link to the full blog post. Current resolution never checks replies for same-author content links when the original tweet has long text (the wrapper detection path only triggers for short tweets).

Example: chenchengpro's Claude Code feature flag analysis (2026-03-23) — the blog post URL is in the first reply by the same author. Result: `linkedSource: none`, `evidence: 0`, `priorityScore: 31`.

## Implementation

### Fix 1: X Article Metadata Fallback

**File**: `src/collect.ts` — `buildArticleMetadataLinkedSource()`

New function that creates a `LinkedSource` from `articleTitle`/`articleText` when no `/i/article/` URL is found. Called as fallback in `mapTwitterCliTweet`:

```typescript
embeddedLinkedSource: extractTwitterCliEmbeddedLinkedSource(tweet) ?? buildArticleMetadataLinkedSource(tweet),
```

Uses the tweet's own URL as the linked source URL (since the tweet IS the article). Downstream scoring picks up `hasLinkedSource` → evidence +8.

### Fix 2: Author Self-Reply Fallback

**File**: `src/collect.ts` — `findAuthorReplySource()`

New async function called in two places within `resolveTwitterPrimarySource` (both "no linked source" return paths):

1. Fetch up to 3 replies via `fetchTwitterReplies`
2. Find first reply where `reply.author.username === tweet.author.username`
3. For each outbound link in that reply, fetch the linked page
4. If `excerpt.length > 500`, treat it as the primary source

Returns `null` if: no author username, reply fetch fails, no same-author reply found, reply has no links, or linked page is too short.

**Resolution reason**: `{ decision: 'use_linked_source', reason: 'author_reply_source' }`

### Threshold

`AUTHOR_REPLY_ARTICLE_MIN_LENGTH = 500` — filters out navigation-only pages, social profiles, and other non-article content.

## Scope

- No changes to scoring formulas (`rank.ts`)
- No changes to curator prompt (`prompts/curator.md`)
- No new dependencies

## Tests

5 new tests in `tests/collect.test.ts`:

1. `mapTwitterCliTweet creates embeddedLinkedSource from articleTitle/articleText when no /i/article/ URL exists` — Fix 1 positive
2. `mapTwitterCliTweet does not create article metadata fallback when articleTitle and articleText are empty` — Fix 1 negative
3. `resolveTwitterPrimarySource uses author reply source when author replies with a link to a substantial article` — Fix 2 positive
4. `resolveTwitterPrimarySource does not use author reply when reply link leads to a short page` — Fix 2 threshold
5. `resolveTwitterPrimarySource does not use reply source from a different author` — Fix 2 same-author check
