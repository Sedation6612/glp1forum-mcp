import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchForum, getThread, listForums, listThreads, fetchImages } from "./forum.js";

const server = new McpServer({ name: "glp1forum", version: "0.5.0" });

server.registerTool("search_forum",
  { description: "Full-text search glp1forum.com with granular XenForo filters. Multi-word keywords are AND-matched (all terms must appear). Category/parent nodes (e.g. 45 Vendor Connection) return nothing unless includeChildNodes: true. A rate-limit error means wait ~60s before retrying. Result has truncated: true when more result pages exist than were fetched — re-search with a higher maxPages (max 3) to get the rest.",
    annotations: { title: "Search glp1forum", readOnlyHint: true },
    inputSchema: {
      // Text ported from SKILL.md, which survived two rounds of blind-execution agent tests.
      // It lives here because .mcpbignore drops skills/ — .mcpb users only ever see this schema.
      keywords: z.string()
        .describe("AND-matched: every word must appear. Start with one or two broad terms; if you get 0 hits, drop a term, never add one."),
      titlesOnly: z.boolean().optional()
        .describe("Rarely worth setting."),
      nodes: z.array(z.number()).optional()
        .describe("Section IDs from list_forums. Never guess one — a wrong ID silently returns 0 rows instead of erroring."),
      includeChildNodes: z.boolean().optional()
        .describe("Set true when nodes names a parent/category section: those hold no posts of their own and return 0 rows if searched alone."),
      author: z.string().optional()
        .describe("Rarely worth setting."),
      newerThan: z.string().optional()
        .describe("YYYY-MM-DD. Only to hard-exclude stale rows — order:\"date\" alone usually suffices, so don't agonize over a cutoff."),
      olderThan: z.string().optional()
        .describe("YYYY-MM-DD. Only to hard-exclude rows newer than a cutoff."),
      minReplies: z.number().optional()
        .describe("Rarely worth setting."),
      order: z.enum(["date", "replies"]).optional()
        .describe("Omit for relevance. \"date\" (newest first) for any current / latest / in-stock question. \"replies\" (most-discussed) for reputation, consensus, or what-are-people-saying questions."),
      groupByThread: z.boolean().optional()
        .describe("true collapses results to one row per thread. Omitting searchType plus groupByThread:true is the discovery default."),
      searchType: z.enum(["post", "thread"]).optional()
        .describe("Omit (= \"post\") so a keyword buried in a reply still matches. \"thread\" matches only titles/opening posts."),
      page: z.number().optional(),
      maxPages: z.number().optional()     // clamped 1-3 in forum.js
        .describe("Clamped 1-3. A result with truncated:true has more pages — re-search with a higher maxPages."),
    } },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(await searchForum(a)) }] }));

server.registerTool("get_thread",
  { description: "Read a thread's posts (paginated) for full context.",
    annotations: { title: "Read thread", readOnlyHint: true },
    inputSchema: {
      url: z.string().optional()
        .describe("Prefer this: pass the url from a search_forum result row."),
      threadId: z.number().optional()
        .describe("Alternative to url."),
      page: z.number().optional()
        .describe("Clamped to lastPage. For current status read page 1 then re-fetch page: lastPage — the opening post may be months stale."),
    } },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(await getThread(a)) }] }));

server.registerTool("get_thread_images",
  { description: "Opt-in: download a thread's image attachments at full size so their text (pricing tables, per-warehouse stock boards, COA purity figures, payment pages) is readable by vision. Much of the vendor pricing on glp1forum is image-only and invisible to get_thread's text. Returns a summary plus the images as blocks; use max to cap how many download (default 4, max 5). Costs one throttled request per image.",
    annotations: { title: "Read thread images", readOnlyHint: true },
    inputSchema: {
      url: z.string().optional()
        .describe("Prefer this: pass the url from a search_forum result row."),
      threadId: z.number().optional()
        .describe("Alternative to url."),
      page: z.number().optional()
        .describe("Clamped to lastPage."),
      max: z.number().optional()
        .describe("How many images to download (default 4, capped at 5). Each costs one throttled request and ~4.6k tokens — lower it when you only need the first table."),
    } },
  async (a) => {
    const r = await fetchImages(a);
    const summary = `"${r.title}" — ${r.images.length} image(s)` +
      (r.skipped.length ? `; skipped ${r.skipped.length}: ${r.skipped.map(s => `${s.url} (${s.reason})`).join("; ")}` : "");
    return { content: [{ type: "text", text: summary }, ...r.images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType }))] };
  });

server.registerTool("list_threads",
  { description: "Browse a forum section's threads (use list_forums for nodeIds).",
    annotations: { title: "List threads in section", readOnlyHint: true },
    inputSchema: {
      nodeId: z.number()
        .describe("Section ID from list_forums. Never guess one."),
      page: z.number().optional(),
    } },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(await listThreads(a)) }] }));

server.registerTool("list_forums",
  { description: "List forum sections with numeric node IDs (feed these to search_forum.nodes).",
    annotations: { title: "List forum sections", readOnlyHint: true },
    inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify(await listForums()) }] }));

await server.connect(new StdioServerTransport());
