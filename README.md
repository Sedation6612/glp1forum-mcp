# glp1forum-mcp

An MCP stdio server that searches and reads **https://glp1forum.com** (a XenForo forum) with no API keys. It shells out to system `curl` because Cloudflare there blocks Node's own TLS fingerprint but passes a real `curl` with a browser User-Agent.

## ⚠️ The one gotcha

**Verified only with Windows curl 8.18 (Schannel).** Linux/macOS curl presents a different TLS fingerprint and may get a `403` from Cloudflare. If every request 403s, this is almost certainly why.

## Requirements

- Node 18+
- System `curl` on your `PATH` (`curl --version` should work)

## Tools

- **`search_forum`** — full-text search with XenForo filters (keywords, nodes, author, date range, min replies, prefixes, order, page, `maxPages` up to 3). Keywords are AND-matched; category nodes need `includeChildNodes: true`.
- **`get_thread`** — read a thread's posts (author, datetime, body, permalink), paginated.
- **`get_thread_images`** — opt-in: download a thread's image attachments at full size as image blocks so vision can read image-only pricing tables / stock boards / COA figures. `max` caps the count (default 4, max 5 — full-size images are token-expensive).
- **`list_threads`** — browse a forum section's thread list by `nodeId`, paginated.
- **`list_forums`** — list forum sections with their numeric node IDs (feed these to `search_forum.nodes` and `list_threads.nodeId`).

## Rate limiting

All requests share a global throttle: **≥2.5s between hits**. On HTTP `403/429/503` the server waits **~65s** (the observed 503 clear time) and retries once; if still blocked it throws `glp1forum rate-limited or unavailable — wait ~60s before retrying`.

That backoff plus request time can blow past a 2-minute caller timeout. **Give callers ≥90s**, or lower the backoff with the `GLP1_BACKOFF_MS` env var.

## Install

### Option A — Claude Code plugin marketplace (recommended)

```
/plugin marketplace add Sedation6612/glp1forum-mcp
```

Then install the `glp1forum-mcp` plugin. This auto-wires the MCP server; the plugin's config uses `${CLAUDE_PLUGIN_ROOT}` so there are no paths to edit.

### Option B — Desktop Extension (.mcpb, one-click Claude Desktop)

Download `glp1forum-mcp.mcpb` from the repo's Releases and double-click it — Claude Desktop
installs it with no paths to edit and no `npm install` (the server is bundled into a single
dependency-free `dist/index.mjs`). You still need system `curl` on your `PATH`.

### Option C — manual (Claude Desktop)

Run `npm install && npm run build` first, then add to `claude_desktop_config.json`:

```json
"glp1forum": { "command": "node", "args": ["C:\\path\\to\\glp1forum-mcp\\dist\\index.mjs"] }
```

> MSIX Claude Desktop installs put this config under
> `%LOCALAPPDATA%\Packages\Claude_pzs8sxrjxfjjc\LocalCache\Roaming\Claude\`, not plain `%APPDATA%`.

## Build (contributors)

The distributed artifact is a single bundled `dist/index.mjs` (esbuild). After editing anything
in `src/`, rebuild and commit `dist/`:

```
npm install
npm run build       # -> dist/index.mjs (what the plugin & .mcpb run)
npm run pack        # build + produce glp1forum-mcp.mcpb for Claude Desktop
```

## Self-test

```
npm run selftest      # or: node src/selftest.js
```

Runs ~7 live requests (≈25s under the throttle). Failure means `curl` is being blocked or the site's HTML drifted.

## License

**All rights reserved** (see [LICENSE](LICENSE)). The source is public for viewing and
for contributions back to this repository via pull request. It is not open source — you
may not redistribute it or publish your own version. See the LICENSE file for details.
