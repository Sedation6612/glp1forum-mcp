---
name: glp1forum-mcp
description: Drive the glp1forum-mcp server to research glp1forum.com effectively. Use this WHENEVER a task needs anything from glp1forum.com — GLP-1 vendor pricing or reputation, warehouse stock levels, group buys, peptide / research-chem sourcing, retatrutide / tirzepatide / semaglutide vendor discussion, OR non-commercial user experiences like dosing, titration, and side-effect threads — any XenForo search, thread read, or forum-section lookup on that specific site. Reach for it even when the user doesn't name the tools, as long as they want info that lives on glp1forum.com. It teaches the node-scoping, AND-matched-keyword, image-only-pricing, and rate-limit traps that the raw tool descriptions gloss over.
---

# Driving glp1forum-mcp

Scrapes glp1forum.com (a XenForo forum) via system `curl`. Every request is globally throttled ≥2.5s apart, so plan few calls.

## Flow

1. **`list_forums`** first — returns real `{id, name, depth}` for every section: vendor boards *and* general/experience discussion (dosing, side effects, etc.). Never invent node IDs; a guessed one silently returns nothing.
2. **`search_forum`** — scoped to the right node(s); see params below.
3. **`get_thread`** — read a result via its row `url`.
4. **`get_thread_images`** — only to read pricing/stock that lives in an image (see trap).

## search_forum

Each result row is `{url, title, date, forum, author, replies, snippet}` — so you can pick and rank threads without extra calls.

- **`keywords` are AND-matched** (not shown in the schema) — every word must appear. Start with one or two broad terms; if you get 0 hits, **drop a term, never add one**.
- **`nodes` + `includeChildNodes: true`** — parent/category sections hold no posts of their own and return 0 rows if searched alone; set `includeChildNodes` to search everything under them. Use the IDs from step 1.
- **`searchType` + `groupByThread`** — default (omit `searchType`) searches posts, so a keyword buried in a reply still matches; add `groupByThread: true` for one row per thread. This is the discovery default. `searchType: "thread"` matches only titles/opening posts.
- **`order`** — omit for relevance; `"date"` (newest first) for any *current / latest / in-stock* question — read the top rows and check their `date`; `"replies"` (most-discussed) for reputation, consensus, or "what are people saying" questions. `newerThan`/`olderThan` (`YYYY-MM-DD`) only to hard-exclude stale rows — `order: "date"` alone usually suffices, so don't agonize over a cutoff.
- **Skip `prefixes`** — the numeric IDs aren't discoverable. `author`/`minReplies`/`titlesOnly` are rarely worth setting.

## Trap: pricing/stock is often image-only

Vendor price lists, per-warehouse stock boards, and payment info are frequently **image attachments**, invisible to `get_thread`'s text. When a pricing/stock thread's `posts[].body` has no numbers, call `get_thread_images` — one throttled request **per image**, so `max` (default 6) means up to 6 fetches. Skip it for text/experience questions; it only helps with images.

## Trap: pages

`get_thread` and `search_forum` both return `lastPage`. For **current** status the live answer is on the last page (the opening post may be months stale) — read page 1, then re-fetch `page: lastPage` if needed. A search with `truncated: true` has more pages — re-search with a higher `maxPages` (max 3).

## Trap: rate limits

On a rate-limit error (`… wait ~60s before retrying`), wait ~60–90s and retry that one call **once** — don't loop. (`list_threads` browses a section without a keyword — a fallback for eyeballing a node's newest threads.)

Example: `list_forums` → `search_forum {keywords:"retatrutide", nodes:[<vendorNodeId>], includeChildNodes:true, groupByThread:true, order:"date"}` → `get_thread` on the newest row → `get_thread_images` only if its body shows a blurb but no prices.
