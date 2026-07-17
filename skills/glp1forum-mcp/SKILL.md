---
name: glp1forum-mcp
description: Drive the glp1forum-mcp server to research glp1forum.com effectively. Use this WHENEVER a task needs anything from glp1forum.com — GLP-1 vendor pricing or reputation, warehouse stock levels, group buys, peptide / research-chem sourcing threads, retatrutide / tirzepatide / semaglutide vendor discussion, or any XenForo search, thread read, or forum-section lookup on that specific site. Reach for it even when the user doesn't name the tools, as long as they want info that lives on glp1forum.com. It teaches the node-scoping, AND-matched-keyword, image-only-pricing, and rate-limit traps that the raw tool descriptions gloss over.
---

# Driving glp1forum-mcp

This server scrapes glp1forum.com (a XenForo forum) through system `curl`. It is slow on purpose — every request is globally throttled — so plan the fewest calls that answer the question. The tools are simple; the traps below are what make the difference between 0 results and the answer.

## Canonical flow

Work outside-in, and don't skip step 1:

1. **`list_forums`** — get the real numeric node IDs and section names. Do this first; never invent node IDs.
2. **`search_forum`** — find threads, scoped to the right node(s).
3. **`get_thread`** — read the posts of a promising result.
4. **`get_thread_images`** — only when the text is missing pricing/stock that must be in an image.

Each step narrows the last. Skipping to `search_forum` with a guessed node is the most common way to get an empty or wrong result.

## Trap 1: node-scoping needs `includeChildNodes`

Many useful nodes are **category / parent nodes** (e.g. node 45 "Vendor Connection") that contain sub-forums but no posts of their own. Searching them directly returns **0 rows**. To search a parent and everything under it, pass `includeChildNodes: true`. Always get the actual IDs from `list_forums` — the tree changes and guessed IDs silently return nothing.

## Trap 2: keywords are AND-matched

Every word in `keywords` must appear in a result. More terms = narrower search. If you get 0 hits, **drop terms**, don't add them. Start broad (`"retatrutide pricing"`), then tighten only if you're drowning in results. Over-constraining (`"retatrutide reta vendor stock price july restock"`) is the #2 cause of empty results after node-scoping.

## Trap 3: vendor pricing is often image-only

A lot of vendor pricing, per-warehouse stock boards, and payment info is posted as **image attachments** — invisible to `get_thread`, which only extracts text. When a thread obviously *should* have prices (it's a vendor's pricing thread) but `get_thread`'s `posts[].body` has none, call **`get_thread_images`** so vision can read the tables. It costs **one throttled request per image**, so cap it with `max` (default 6). Don't call it reflexively on every thread — only when the text is genuinely missing the numbers.

## Trap 4: pagination

`search_forum` results carry `truncated: true` and `lastPage`. If `truncated`, the answer may be on a later page — re-search with a higher `maxPages` (max 3). `get_thread` is paginated too (`page`, clamped to `lastPage`); page through a long thread if the relevant reply isn't on page 1.

## Trap 5: rate limits — wait, don't hammer

Requests are globally throttled ≥2.5s apart, so a multi-call sequence is inherently slow. On a rate-limit error (`… wait ~60s before retrying`), **wait ~60–90s and retry ONCE**. Do not retry in a tight loop — hammering *extends* the block. Budget **≥90s** for any call that might hit the backoff, and tell the user a lookup will take a bit rather than firing off parallel calls.

## Worked example: "find current retatrutide vendor pricing"

1. `list_forums` → locate the vendor section (say node 45 "Vendor Connection", a parent node).
2. `search_forum` with `keywords: "retatrutide"`, `nodes: [45]`, `includeChildNodes: true`, `order: "date"` — recent first, and the child-nodes flag is essential or node 45 returns nothing.
3. Open the top / most recent thread with `get_thread`.
4. If `posts[].body` has the vendor's blurb but no numbers, call `get_thread_images` (`max: 6`) — the price list is almost certainly an image. Read the pricing/stock off the returned images.

If step 2 is empty: drop to a single keyword, confirm the node ID from step 1, and make sure `includeChildNodes` is set.
