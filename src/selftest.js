import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { searchForum, getThread, listForums, listThreads, fetchImages, cfDecode, reserveSlot, classifyResultPage } from "./forum.js";

// RC1 guard (network-free): _xfToken is on every page; genuine empty is positively detected as 'empty',
// an unrecognized 0-row page (login/challenge) is 'unknown' → distinct error, not a silent empty.
assert.equal(classifyResultPage('<input name="_xfToken" value="x"><div class="blockMessage">No results found.</div>'), "empty");
assert.equal(classifyResultPage('<input name="_xfToken" value="x">Security error occurred. Please press back…'), "csrf");
assert.equal(classifyResultPage('<input name="_xfToken" value="x">You must wait at least 30 seconds before performing this action.'), "flood");
assert.equal(classifyResultPage('<html><body>please log in</body></html>'), "unknown");
console.log("classifyResultPage ok");

// RC3 guard (network-free): a copy of the searchForum mutex must run tasks strictly in order
{
  let chain = Promise.resolve();
  const order = [];
  const guarded = (label, ms) => {
    const r = chain.then(() => task(label, ms), () => task(label, ms));
    chain = r.catch(() => {});
    return r;
  };
  const task = async (label, ms) => {
    order.push(`${label}:start`);
    await new Promise(res => setTimeout(res, ms));
    order.push(`${label}:end`);
  };
  await Promise.all([guarded("A", 30), guarded("B", 1)]); // B is faster but must still wait for A
  assert.deepEqual(order, ["A:start", "A:end", "B:start", "B:end"], `mutex order broken: ${order.join(",")}`);
  console.log("search mutex ordering ok");
}

// cf-email decoder — pure, no network; known vector from the live MIX thread
assert.equal(cfDecode("137b727e537e7a6b3e637663677a7776603d707c7e"), "ham@mix-peptides.com");
console.log("cfDecode ok");

const search = await searchForum({ keywords: "retatrutide dose", order: "date" });
assert.ok(search.rows.length >= 1, "search returned no rows");
assert.ok(search.rows[0].title && search.rows[0].url, "row missing title/url");
assert.ok(search.rows[0].forum, "row missing forum");
assert.ok(search.lastPage >= 1, "lastPage missing");
assert.equal(typeof search.truncated, "boolean", "search.truncated flag missing");
// scoping tripwire: the only automated guard for the silent-unscoped bug class
const scoped = await searchForum({ keywords: "retatrutide dose", nodes: [16] });
assert.ok(scoped.rows.length >= 1, "scoped search returned no rows");
assert.ok(scoped.rows.every(r => r.forum === "Retatrutide"),
  `node scoping broken: forums = ${[...new Set(scoped.rows.map(r => r.forum))].join(", ")}`);
console.log(`search ok: ${search.rows.length} rows (lastPage ${search.lastPage}), scoped ${scoped.rows.length} rows all Retatrutide`);

// noResults disambiguation: a normal search must not be flagged; node 80 (parent category) has zero matches
assert.ok(!search.noResults, "normal search should not be flagged noResults");
const empty = await searchForum({ keywords: "retatrutide", nodes: [80] });
assert.equal(empty.rows.length, 0, "node-80 should have zero rows");
assert.equal(empty.noResults, true, "genuine empty must set noResults:true");
console.log("noResults ok: node-80 empty flagged, normal search not");

const thread = await getThread({ url: search.rows[0].url });
assert.ok(thread.posts.length >= 1, "thread returned no posts");
assert.ok(thread.posts[0].author && thread.posts[0].body, "post missing author/body");
assert.ok(thread.posts.every(p => !p.body.includes("Click to expand")), "quote residue: 'Click to expand' in a body");
console.log(`thread ok: "${thread.title}", ${thread.posts.length} posts`);

const forums = await listForums();
assert.ok(forums.some(f => f.id === 16 && /Retatrutide/.test(f.name)), "node 16 Retatrutide missing");
assert.ok(forums.some(f => f.id === 29 && /Public Square/.test(f.name)), "node 29 Public Square missing");
console.log(`forums ok: ${forums.length} nodes`);

const lt = await listThreads({ nodeId: 16 });
assert.ok(lt.threads.length >= 1, "listThreads returned no threads");
assert.ok(lt.threads[0].title && lt.threads[0].url, "thread row missing title/url");
console.log(`list_threads ok: ${lt.threads.length} threads (lastPage ${lt.lastPage})`);

// getThread images — known attachment thread; repoint to any node-64 attachment thread if it ages out
const vt = await getThread({ url: "https://glp1forum.com/threads/now-launching-china-warehouse-private-customizationflag-chinasmall-airplaneflag-united-states.20694/" });
assert.ok(vt.posts.some(p => p.images.length), "no post had images");
assert.ok(vt.posts.flatMap(p => p.images).every(u => u.startsWith("https://")), "image URL not absolute");
console.log(`images ok: ${vt.posts.flatMap(p => p.images).length} urls across ${vt.posts.filter(p => p.images.length).length} posts`);

// fetchImages — downloads attachments, sniffs real mime from magic bytes (this thread's .jpg URL is really WebP)
const fi = await fetchImages({ url: "https://glp1forum.com/threads/now-launching-china-warehouse-private-customizationflag-chinasmall-airplaneflag-united-states.20694/", max: 2 });
assert.ok(fi.images.length >= 1, "fetchImages returned no images");
assert.ok(fi.images.every(i => /^image\/(jpeg|png|webp|gif)$/.test(i.mimeType)), "image missing sniffed mimeType");
assert.ok(fi.images.every(i => i.data && Buffer.from(i.data, "base64").length > 100), "image data not valid base64");
console.log(`fetchImages ok: ${fi.images.length} images, mimes ${[...new Set(fi.images.map(i => i.mimeType))].join(", ")}`);

// quote snippet — thread 9613 has real quoted text; the collapse must keep an inline snippet, no "Click to expand" residue
const qt = await getThread({ url: "https://glp1forum.com/threads/9613/" });
assert.ok(qt.posts.some(p => /\[quote: [^\]]*: "/.test(p.body)), "no [quote: name: \"...\"] snippet found");
assert.ok(qt.posts.every(p => !p.body.includes("Click to expand")), "quote residue: 'Click to expand' leaked");
console.log(`quote ok: ${qt.posts.filter(p => /\[quote: [^\]]*: "/.test(p.body)).length} posts with quoted snippets`);

// cross-process throttle — 3 processes reserving slots (network-free); slots at 0 / 2.5 / 5.0s
const t0 = Date.now();
await Promise.all([0, 1, 2].map(() => new Promise((res, rej) => {
  const c = spawn(process.execPath, ["-e",
    `import(${JSON.stringify(new URL("./forum.js", import.meta.url).href)}).then(m=>m.reserveSlot())`]);
  c.on("exit", code => code === 0 ? res() : rej(new Error("throttle proc exit " + code)));
})));
assert.ok(Date.now() - t0 >= 4800, "cross-process throttle too fast");
console.log(`throttle ok: 3 procs in ${Date.now() - t0}ms`);

console.log("ALL BLOCKS PASSED");
