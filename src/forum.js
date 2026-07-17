import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { setTimeout as sleep } from "node:timers/promises";
import { load } from "cheerio";
import os from "node:os";
import path from "node:path";
import fs from "node:fs";

const run = promisify(execFile);
const BASE = "https://glp1forum.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
const JAR = path.join(os.tmpdir(), `glp1forum-mcp-cookies-${process.pid}.txt`);
const MARKER = "@@META@@";
const BLOCKED = [403, 429, 503];
const BACKOFF = Number(process.env.GLP1_BACKOFF_MS) || 8000;

// best-effort: reap other processes' stale cookie jars (>10min old) so /tmp doesn't fill up
try {
  for (const f of fs.readdirSync(os.tmpdir())) {
    const m = f.match(/^glp1forum-mcp-cookies-(\d+)\.txt$/);
    if (!m || Number(m[1]) === process.pid) continue;
    const p = path.join(os.tmpdir(), f);
    try { if (Date.now() - fs.statSync(p).mtimeMs > 600000) fs.rmSync(p, { force: true }); } catch {}
  }
} catch {}

// per-process guest _xfToken cache — search re-fetched it every call, doubling requests under the throttle
let cachedToken = null;
function dropSession() { cachedToken = null; fs.rmSync(JAR, { force: true }); }

// ponytail: Cloudflare email obfuscation — first hex byte is the XOR key. Pure, no network.
export function cfDecode(hex) {
  const k = parseInt(hex.slice(0, 2), 16);
  let s = "";
  for (let i = 2; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ k);
  return s;
}

const LOCK = path.join(os.tmpdir(), "glp1forum-mcp.lock");   // mkdir = atomic, cross-platform
const NEXT = path.join(os.tmpdir(), "glp1forum-mcp-next");   // next-allowed epoch ms
const INTERVAL = Number(process.env.GLP1_INTERVAL_MS) || 2500; // raise for heavy concurrent search (each search = 2 requests; 8-way trips Cloudflare at 2.5s)
const STALE = 30000; // ponytail: steal a crashed holder's lock after 30s; raise if a slot could exceed 30s

async function lock() {                        // acquire
  for (;;) {
    try { fs.mkdirSync(LOCK); return; }
    catch (e) {
      if (e.code !== "EEXIST") throw e;
      try { if (Date.now() - fs.statSync(LOCK).mtimeMs > STALE) { fs.rmdirSync(LOCK); continue; } } catch {}
      await sleep(30 + Math.random() * 40);    // spin-wait with jitter
    }
  }
}

export async function reserveSlot() {          // exported for the self-test
  await lock();
  let mySlot;
  try {
    const now = Date.now();
    let next = now;
    try { next = Math.max(now, Number(fs.readFileSync(NEXT, "utf8")) || 0); } catch {}
    mySlot = next;
    fs.writeFileSync(NEXT, String(mySlot + INTERVAL));
  } finally {
    fs.rmdirSync(LOCK);                        // RELEASE before sleeping
  }
  const wait = mySlot - Date.now();
  if (wait > 0) await sleep(wait);
}

// after a request completes, no one may start within INTERVAL of now — matches the old
// per-process throttle's idle-after-completion pacing; 2.5s start-to-start alone trips a 503
async function pushNext() {
  await lock();
  try {
    const floor = Date.now() + INTERVAL;
    let next = 0;
    try { next = Number(fs.readFileSync(NEXT, "utf8")) || 0; } catch {}
    if (next < floor) fs.writeFileSync(NEXT, String(floor));
  } finally {
    fs.rmdirSync(LOCK);
  }
}

async function runCurl(url, post) {
  await reserveSlot();
  // leading \n is load-bearing: a -w format starting with @ makes curl read it as @filename
  const args = ["-sL", "-A", UA, "-b", JAR, "-c", JAR, "-w", `\n${MARKER}%{http_code} %{url_effective}`];
  if (post) for (const [k, v] of post) args.push("--data-urlencode", `${k}=${v}`);
  args.push(url);
  let stdout;
  try {
    ({ stdout } = await run("curl", args, { maxBuffer: 20 * 1024 * 1024 }));
  } finally {
    await pushNext();
  }
  const i = stdout.lastIndexOf(MARKER);
  const meta = stdout.slice(i + MARKER.length).trim();
  const sp = meta.indexOf(" "); // first space only — everything after it is the URL, whatever it contains
  return {
    html: stdout.slice(0, i).trimEnd(),
    status: Number(meta.slice(0, sp)),
    effectiveUrl: meta.slice(sp + 1),
  };
}

// ponytail: system curl transport (Cloudflare passes curl's TLS fingerprint but not
// node's — verified only on Windows curl 8.18/Schannel; other OSes unverified).
// If Cloudflare adds a JS Turnstile challenge, swap fetchHtml for Playwright.
async function fetchHtml(url, { post } = {}) {
  let res = await runCurl(url, post);
  if (BLOCKED.includes(res.status)) {
    // a 503 challenge clears after ~60s (verified 2026-07-16), but a >60s handler trips the MCP
    // client's 60s timeout (-32001), and this sleep now runs inside the search mutex — so fail fast
    // (8s) with a retryable error instead of stalling the whole queue. GLP1_BACKOFF_MS overrides.
    // jitter breaks the thundering herd — without it, N processes that 503 together all retry in lockstep and re-trip
    await sleep(BACKOFF + Math.floor(Math.random() * 10000));
    // retry with the EXISTING jar first — the session-paired _xfToken stays valid
    res = await runCurl(url, post);
    if (BLOCKED.includes(res.status)) {
      fs.rmSync(JAR, { force: true });
      throw new Error(`glp1forum rate-limited or unavailable (HTTP ${res.status}) — wait ~60s before retrying`);
    }
  }
  return res;
}

export async function getToken() {
  const { html } = await fetchHtml(`${BASE}/search/?type=post`);
  const m = html.match(/name="_xfToken" value="([^"]+)"/);
  if (!m) throw new Error("no _xfToken (Cloudflare block or layout change?)");
  return { token: m[1], html };
}

function lastPageOf($) {
  return Math.max(1, ...$(".pageNav a, .pageNav li").map((_, el) => parseInt($(el).text(), 10)).get().filter(Number.isFinite));
}

function parseResults(html, effectiveUrl) {
  const $ = load(html);
  const rows = $(".contentRow").map((_, el) => {
    const a = $(el).find(".contentRow-title a").first();
    const minor = $(el).find(".contentRow-minor li");
    const forum = minor.filter((_, li) => $(li).text().trim().startsWith("Forum:")).first()
      .text().replace(/^\s*Forum:\s*/, "").trim();
    const author = minor.filter((_, li) => $(li).find("a[data-user-id]").length > 0).first()
      .find("a[data-user-id]").first().text().trim();
    const repliesM = minor.filter((_, li) => /^Replies:/.test($(li).text().trim())).first()
      .text().match(/Replies:\s*([\d,]+)/);
    return {
      title: a.text().trim(),
      url: new URL(a.attr("href") ?? "", BASE).href,
      snippet: $(el).find(".contentRow-snippet").text().trim(),
      date: $(el).find("time[datetime]").attr("datetime") ?? null,
      forum: forum || null,
      author: author || null,
      replies: repliesM ? Number(repliesM[1].replace(/,/g, "")) : null,
    };
  }).get().filter(r => r.title);
  return { rows, effectiveUrl, lastPage: lastPageOf($) };
}

// classify a 0-row page. Only called when parseResults found no rows.
// 'empty' is POSITIVELY detected (XF renders <div class="blockMessage">No results found.</div>);
// the other blockMessage divs on the page are warnings, so match the exact-class div, not just .blockMessage.
// _xfToken is on EVERY XenForo page so it discriminates nothing — the old |_xfToken clause was the bug.
export function classifyResultPage(html) {
  if (/security error/i.test(html)) return "csrf";
  if (/must wait at least \d+ second/i.test(html)) return "flood";
  if (/blockMessage">\s*No results found/i.test(html)) return "empty";
  return "unknown"; // login / challenge / layout drift — NOT a genuine empty
}

// ponytail: in-process mutex — search-vs-search only. A concurrent get_thread/list_*
// still shares the jar and can clobber a search's session mid-sequence (unobserved —
// give search its own jar if it ever surfaces). The other 3 tools do NOT take this mutex.
let searchChain = Promise.resolve();
export function searchForum(p) {
  const r = searchChain.then(() => _searchForum(p), () => _searchForum(p));
  searchChain = r.catch(() => {}); // a rejection must not break the chain
  return r;
}

async function _searchForum(p) {
  // ponytail: cached guest token in the cookie jar, refetch once on failure
  for (let attempt = 0; ; attempt++) {
    try {
      const token = cachedToken ?? (cachedToken = (await getToken()).token);
      const post = [["keywords", p.keywords], ["_xfToken", token]];
      if (p.titlesOnly) post.push(["c[title_only]", "1"]);
      for (const n of p.nodes ?? []) post.push(["c[nodes][]", String(n)]);
      if (p.includeChildNodes) post.push(["c[child_nodes]", "1"]);
      if (p.author) post.push(["c[users]", p.author]);
      if (p.newerThan) post.push(["c[newer_than]", p.newerThan]);
      if (p.olderThan) post.push(["c[older_than]", p.olderThan]);
      if (p.minReplies != null) post.push(["c[min_reply_count]", String(p.minReplies)]);
      for (const pre of p.prefixes ?? []) post.push(["c[prefixes][]", String(pre)]);
      if (p.order) post.push(["order", p.order]);
      if (p.groupByThread) post.push(["grouped", "1"]);
      post.push(["search_type", p.searchType ?? "post"]);

      let { html, effectiveUrl } = await fetchHtml(`${BASE}/search/search`, { post });
      if ((p.page ?? 1) > 1)
        ({ html, effectiveUrl } = await fetchHtml(`${effectiveUrl}&page=${p.page}`));
      const out = parseResults(html, effectiveUrl);
      if (!out.rows.length) {
        const kind = classifyResultPage(html);
        if (kind === "csrf") throw new Error("token rejected");
        // message MUST match the :199 /rate-limited|blocked/ rethrow so it doesn't dropSession+retry a flooded server
        if (kind === "flood") throw new Error("glp1forum rate-limited (flood) — wait ~60s before retrying");
        if (kind !== "empty") // login/challenge/layout drift masquerading as empty → distinct, non-retryable error
          throw new Error(`glp1forum: unrecognized search page (no rows, no 'No results found') at ${effectiveUrl} — possible layout change or block`);
        out.noResults = true; // genuine empty; fall through so pagesFetched/truncated still get set, returns rows: []
      }

      const maxPages = Math.min(3, Math.max(1, p.maxPages ?? 1)); // 3-page cap: ~19k tokens worst case vs the 25k client limit
      const start = p.page ?? 1;
      out.pagesFetched = 1;
      const pageUrl = new URL(effectiveUrl);
      for (let n = start + 1; n <= Math.min(start + maxPages - 1, out.lastPage); n++) {
        pageUrl.searchParams.set("page", String(n)); // replaces any existing page param
        const next = await fetchHtml(pageUrl.href);
        out.rows.push(...parseResults(next.html, next.effectiveUrl).rows);
        out.pagesFetched++;
      }
      out.truncated = out.lastPage > out.pagesFetched; // more pages exist than were fetched — re-search with higher maxPages
      out.noResults = out.noResults ?? false; // explicit signal; effectiveUrl is no longer the only tell
      return out;
    } catch (e) {
      if (attempt > 0 || /rate-limited|blocked/.test(e.message)) throw e;
      dropSession(); // rejected token → clear cache + jar, re-pair on the retry
    }
  }
}

export async function getThread({ url, threadId, page }) {
  let u = url ?? `${BASE}/threads/${threadId}/`;
  if (page && page > 1) u = u.replace(/(\/page-\d+)?\/?(#.*)?$/, `/page-${page}`);
  const { html, effectiveUrl } = await fetchHtml(u);
  const $ = load(html);
  const posts = $("article.message, .message").map((_, el) => {
    // clone so the marker swap never mutates the parsed doc for later selectors
    const wrap = $(el).find(".message-body .bbWrapper").first().clone();
    wrap.find("blockquote").each((_, bq) => {
      const who = $(bq).attr("data-quote") ?? "?";
      const inner = $(bq).find(".bbCodeBlock-content").clone();
      inner.find(".bbCodeBlock-expandLink").remove();     // strips the "Click to expand…" toggle
      let q = (inner.text() || $(bq).text()).replace(/\s+/g, " ").trim();
      if (q.length > 200) q = q.slice(0, 200) + "…";
      $(bq).replaceWith(q ? `[quote: ${who}: "${q}"]` : `[quote: ${who}]`);
    });
    wrap.find("[data-cfemail]").each((_, e) => $(e).replaceWith(cfDecode($(e).attr("data-cfemail"))));
    wrap.find("a[href*='/cdn-cgi/l/email-protection#']").each((_, a) =>
      $(a).replaceWith(cfDecode($(a).attr("href").split("#")[1])));   // alternate mailto-link form
    // keep raw hrefs (discord/telegram invites, unfurl embeds) that wrap.text() would otherwise drop
    wrap.find("a[href]").each((_, a) => {
      const $a = $(a), href = $a.attr("href"), t = $a.text().trim();
      if (!href || href.startsWith("#")) return;
      const abs = new URL(href, BASE).href;
      if (!t.includes(href) && !t.includes(abs)) $a.replaceWith(t ? `${t} (${abs})` : abs);
    });
    const perma = $(el).find(".message-attribution a[href*='post-']").last().attr("href");
    const abs = (h) => (h ? new URL(h, BASE).href : null);
    // ponytail: XF wraps every attachment img in <a href="/attachments/<slug>.<id>/"> — the strip
    // adds class="file-preview", inline [ATTACH] uses a bare anchor. src is always a thumbnail
    // (verified 2026-07-17: strip 279x150 -> 2584x1392; inline 154x150 -> 951x928).
    // data-url is NOT an attachment's full-size URL — it's only set on hotlinked [IMG], where it's
    // the un-proxied external original; prefer src so we fetch site-local. Bare /attachments/<id>/
    // 403s, so the href must be scraped. If XF ever exposes a size param, this whole rung collapses.
    const images = [...new Set(
      $(el).find(".message-body .bbWrapper img:not(.smilie):not(.bbCodeBlockUnfurl-image):not(.bbCodeBlockUnfurl-icon), .message-attachments img")
        .map((_, im) => $(im).closest("a[href*='/attachments/']").attr("href") || $(im).attr("src")).get()
        .map(abs).filter(u => u && /^https?:/.test(u))
    )];
    return {
      author: $(el).attr("data-author") ?? $(el).find(".message-name").first().text().trim(),
      datetime: $(el).find("time[datetime]").first().attr("datetime") ?? null,
      body: wrap.text().trim(),
      images,
      permalink: perma ? new URL(perma, BASE).href : null,
    };
  }).get().filter(p => p.body);
  const lastPage = lastPageOf($);
  return { title: $("h1.p-title-value").text().trim(), url: effectiveUrl, page: Math.min(Math.max(1, page ?? 1), lastPage), lastPage, posts };
}

// ponytail: sniff real type from magic bytes — the site serves WebP at .jpg URLs (verified 2026-07-16)
export function sniffMime(b) {
  if (b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return "image/jpeg";
  if (b.length >= 4 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return "image/png";
  if (b.length >= 12 && b.toString("ascii", 0, 4) === "RIFF" && b.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (b.length >= 4 && b.toString("ascii", 0, 4) === "GIF8") return "image/gif";
  return null;
}

// binary download — separate from runCurl: its -w marker in stdout corrupts binary bodies, so body → -o file
let dlSeq = 0;
async function downloadBinary(url) {
  await reserveSlot();
  const tmp = path.join(os.tmpdir(), `glp1forum-mcp-img-${process.pid}-${dlSeq++}.bin`);
  try {
    const args = ["-sL", "-A", UA, "-b", JAR, "-c", JAR, "-o", tmp, "-w", "%{http_code}", url];
    const { stdout } = await run("curl", args, { maxBuffer: 1024 * 1024 });
    return { status: Number(stdout.trim()), buf: fs.readFileSync(tmp) };
  } finally {
    fs.rmSync(tmp, { force: true });
    await pushNext();
  }
}

// opt-in: download a thread's image attachments so their pixels (pricing tables, stock boards) can be read
export async function fetchImages({ url, threadId, page, max = 4 }) {
  max = Math.min(5, Math.max(1, max));  // ponytail: ~4.6k tok/full-size image vs the 25k default
                                        // MAX_MCP_OUTPUT_TOKENS (4x4600=18.4k ok, 6x4600=27.6k over).
                                        // Raise the ceiling only if the client's cap is raised.
  const t = await getThread({ url, threadId, page });
  const urls = [...new Set(t.posts.flatMap(p => p.images))];
  const images = [], skipped = [];
  for (const u of urls) {
    if (images.length >= max) { skipped.push({ url: u, reason: "max reached" }); continue; }
    try {
      const { status, buf } = await downloadBinary(u);
      if (status !== 200) { skipped.push({ url: u, reason: `HTTP ${status}` }); continue; }
      if (buf.length > 4 * 1024 * 1024) { skipped.push({ url: u, reason: `too large (${buf.length}B)` }); continue; }
      const mimeType = sniffMime(buf);
      if (!mimeType) { skipped.push({ url: u, reason: "not a recognized image" }); continue; }
      images.push({ url: u, data: buf.toString("base64"), mimeType });
    } catch (e) { skipped.push({ url: u, reason: e.message }); }
  }
  return { title: t.title, images, skipped };
}

export async function listThreads({ nodeId, page }) {
  // numeric /forums/16/ 301s to the slug URL; curl -L follows
  const { html } = await fetchHtml(`${BASE}/forums/${nodeId}/${page && page > 1 ? `page-${page}` : ""}`);
  const $ = load(html);
  const threads = $(".structItem--thread").map((_, el) => {
    // href filter matters: a ?prefix_id filter link precedes the thread anchor
    const a = $(el).find('.structItem-title a[href*="/threads/"]').first();
    return {
      title: a.text().trim(),
      url: new URL(a.attr("href") ?? "", BASE).href,
      author: $(el).find(".structItem-parts a.username").first().text().trim() || null,
      replies: $(el).find(".structItem-cell--meta dl.pairs dd").first().text().trim() || null,
      date: $(el).find(".structItem-startDate time[datetime]").attr("datetime") ?? null,
    };
  }).get().filter(t => t.title);
  return { threads, lastPage: lastPageOf($) };
}

export async function listForums() {
  const { html } = await getToken();
  const $ = load(html);
  return $('select[name="c[nodes][]"] option').map((_, el) => {
    const raw = $(el).text();
    return {
      id: Number($(el).attr("value")),
      name: raw.replace(/^[\s ]+/, "").trim(),
      depth: (raw.match(/ /g) ?? []).length,
    };
  }).get().filter(f => f.id);
}
