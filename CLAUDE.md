# glp1forum-mcp

Read-only MCP stdio server that scrapes https://glp1forum.com (XenForo), no API keys. Shells out to
system `curl` because Cloudflare blocks Node's TLS fingerprint but passes real curl + a browser UA.

`src/index.js` is a thin shim — tool registration only. All logic is `src/forum.js`. It is densely
commented and those comments are load-bearing: read them before editing, don't restate them here.

## The rule that bites first

**`dist/index.mjs` is committed and IS what runs.** Both install channels execute it directly and no
build runs on the user's machine — `.claude-plugin/plugin.json:13` (`${CLAUDE_PLUGIN_ROOT}/...`) and
`manifest.json:17` (`${__dirname}/...`). The two path syntaxes are not interchangeable; each is
expanded by a different host. `npm start` runs `src/`, but nothing in production does.

So: **any `src/` edit → `npm run build` → commit `dist/` in the same commit.** The selftest won't
catch a stale bundle (it tests `src/` directly and never loads `dist/`); CI will. Precedent: `41721ae`.

Anything users install is downstream of that bundle, so a `src/` change isn't shipped until it's
rebuilt, committed, **and released** — `npm run pack` + a new Release, every time. See *Releasing*.

## Lockstep

Nothing here is generated. Every row is a manual edit.

| When you change | Also update |
|---|---|
| version | `package.json:3`, `manifest.json:5`, `.claude-plugin/plugin.json:4`, `.claude-plugin/marketplace.json:10`, `src/index.js:6` — 5 hand edits, then rebuild (the 6th copy is baked into `dist/`) and **cut a release** (see below). Never regex-bump: `manifest.json:2` `"manifest_version": "0.3"` is the MCPB spec version. `package-lock.json` is a 6th copy that CI does *not* check — bump it with `npm install --package-lock-only` (never by hand), then eyeball the diff: at v0.5.0 it was still carrying a `bin` of `dist/index.js`, a file that has never existed. It has drifted before (`5a3950d`). CI fails if the 5 disagree. |
| a tool (new/renamed) | `src/index.js`, `README.md`, `skills/glp1forum-mcp/SKILL.md`. The manifest deliberately carries **no** `tools` array — it's optional in the MCPB v0.3 schema (`required` is name/version/description/author/server), and the hand-synced copy it used to hold drifted from `src/index.js` with nothing checking it. Don't re-add one. |
| `keywords` | `package.json`, `manifest.json`, `.claude-plugin/plugin.json`, `.claude-plugin/marketplace.json` — 4 copies, plus the GitHub repo topics (`gh repo edit --add-topic`, a 5th copy outside the tree). CI checks none of them; they drift silently. |
| a param name | `src/index.js`, `README.md`, `SKILL.md` (the manifest lists no params) |
| param *guidance* | The `.describe()` strings in `src/index.js` are a port of `SKILL.md`'s param cheat-sheet — same advice, two places, nothing enforcing it. They exist separately **because `.mcpbignore:5` drops `skills/`**, so `.mcpb` users get the schema and never the skill. Change one, change the other. |
| a return field | `src/forum.js`, `SKILL.md` — it documents the row shape and `lastPage`/`truncated` with no schema binding, so it silently lies when the parser drifts |
| `BACKOFF`/`INTERVAL`/`max`/`maxPages` | `README.md` rate-limit section, `SKILL.md`, and the tool descriptions in `src/index.js` (which restate the numbers in prose) |

`.mcpbignore:5` drops `skills/`, so **`.mcpb` users never see SKILL.md**. Guidance they need must live
in the tool descriptions or README, never only in the skill.

SKILL.md is a tested artifact, not documentation — `b9cd663` rewrote it after two rounds of
blind-execution agent tests, cutting ~44% of the body. It has a leanness budget. Keep it prescriptive.

## Releasing

`README.md` Install Option B points users at the `.mcpb` on the Releases page, so **a version that
isn't released is a broken install path**. The `.mcpb` is gitignored — the Release *is* its only
distribution channel, and it goes stale the moment `src/` changes.

Ship a release with every version bump:

```
npm run selftest                  # must pass — CI can't check this (see below)
npm run pack                      # rebuild + fresh glp1forum-mcp.mcpb
git push
gh release create v<X.Y.Z> glp1forum-mcp.mcpb --title "v<X.Y.Z>" --notes "..."
```

- **Always `npm run pack` immediately before attaching.** Never upload the `.mcpb` sitting in the
  working dir — it's untracked, so nothing tells you it predates your last `src/` edit. This has
  already happened once: the local build was 67 minutes stale and shipped the thumbnail-era server.
- **Tag must match the 5 version strings.** CI checks those agree with each other, not with the tag.
- **Notes are a real changelog** — what changed and why it matters to a user, grouped, not a `git log`
  dump. Match the commit-message register below. Call out anything that changes tool behavior or
  output size, since that's what breaks callers.

## Verification

`npm run selftest` — plain `node:assert/strict`, no framework, no lint, no formatter. This one file
is the entire behavioral safety net. Prints `ALL BLOCKS PASSED`; takes ~40s under the throttle.

**CI (`.github/workflows/ci.yml`) does not and must not run it.** It makes live requests to a
Cloudflare-protected site, and Linux curl's TLS fingerprint gets 403s where Windows curl passes — it
would be permanently red on runners. CI only checks the two deterministic, offline things that drift:
`dist/` is a clean rebuild of `src/`, and the 5 version strings agree. Everything behavioral is on
you running the selftest locally before you tag.

It mixes pure guards with live requests against the real forum, and is pinned to live state (threads
20694 / 9613 / 21325 / 20630, nodes 16 / 29 / 80, the forum name `"Retatrutide"`, `>= 14` inline
images, `> 50_000` bytes). **It will rot.** A failure is as likely to be forum drift or Cloudflare as
a real regression — check which before "fixing" code.

- `reserveSlot`, `classifyResultPage`, and `serialize` are exported *only* for the selftest. Don't
  un-export. `serialize` is the search mutex itself (`searchForum` *is* `serialize(_searchForum)`) —
  it's a named export purely so the selftest drives the shipped code instead of a copy of it, which
  is what the RC3 block used to do while being incapable of failing.
- `selftest.js:122`'s `>= 4800` is coupled to `INTERVAL = 2500` (`forum.js:35`).
- Convention (`41721ae`): a behavior fix leaves a tripwire that fails before the change and passes
  after. The comments explain *why* each assert points where it does — 20694 was the one thread where
  the thumbnail bug's old selector worked, so asserting there would have validated the bug. Preserve
  that reasoning when you touch an assert.

## Traps the code comments don't cover

- **Error strings are coupled across three literals with no shared constant.** `forum.js:116` and
  `forum.js:210` must both keep matching the `/rate-limited|blocked/` regex at `forum.js:230`. Break
  the match and you get a retry storm against a flooding server.
- **The `~60s` in the error message is advice to the caller about the site**, deliberately distinct
  from the 8s internal backoff (`forum.js:107-109` explains). Don't "fix" it to say 8s.
- **`listForums` returns `{id, name}` — there is no `depth`, and re-adding one is a mistake.** There
  was one, derived by counting literal U+00A0 characters, and the trap this bullet used to warn about
  *fired*: something normalized them to U+0020, so `depth` silently counted the spaces in a forum
  *name* instead of its indentation, and shipped that way through v0.4.0 — 61 of 76 nodes wrong
  ("Other Peptides / Stacking / Etc." reported `depth: 6` at hierarchy level 2). Nothing read the
  field and no assert covered it, so it stayed green for a full release. **Never write parsing that
  depends on a literal U+00A0 in the source.** JS `\s` already matches U+00A0, which is why `name`'s
  leading-strip survived the normalization untouched while `depth` died silently.

The `ponytail:` markers in `forum.js` name each shortcut's ceiling and upgrade path — curl transport
(→ Playwright if Cloudflare adds Turnstile), the attachment-href scrape (collapses if XF exposes a
size param), the search mutex (search-vs-search only; the other 3 tools don't take it). Read them
before assuming something is an oversight.

## Conventions

Commit messages are long and reason-dense: root cause, verified numbers (`8,502B -> 182,420B`), and
what was deliberately *not* changed. Match that register.

This server is not installed in Claude Desktop or Claude Code locally. Verify with `npm run selftest`
or by running `node dist/index.mjs` directly.
