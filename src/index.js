import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { searchForum, getThread, listForums, listThreads, fetchImages } from "./forum.js";

const server = new McpServer({ name: "glp1forum", version: "0.3.0" });

server.registerTool("search_forum",
  { description: "Full-text search glp1forum.com with granular XenForo filters. Multi-word keywords are AND-matched (all terms must appear). Category/parent nodes (e.g. 45 Vendor Connection) return nothing unless includeChildNodes: true. A rate-limit error means wait ~60s before retrying. Result has truncated: true when more result pages exist than were fetched — re-search with a higher maxPages (max 3) to get the rest.",
    annotations: { title: "Search glp1forum", readOnlyHint: true },
    inputSchema: {
      keywords: z.string(),
      titlesOnly: z.boolean().optional(),
      nodes: z.array(z.number()).optional(),
      includeChildNodes: z.boolean().optional(),
      author: z.string().optional(),
      newerThan: z.string().optional(),   // YYYY-MM-DD
      olderThan: z.string().optional(),
      minReplies: z.number().optional(),
      prefixes: z.array(z.number()).optional(),
      order: z.enum(["date", "replies"]).optional(),
      groupByThread: z.boolean().optional(),
      searchType: z.enum(["post", "thread"]).optional(),
      page: z.number().optional(),
      maxPages: z.number().optional(),    // clamped 1-3 in forum.js
    } },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(await searchForum(a)) }] }));

server.registerTool("get_thread",
  { description: "Read a thread's posts (paginated) for full context.",
    annotations: { title: "Read thread", readOnlyHint: true },
    inputSchema: { url: z.string().optional(), threadId: z.number().optional(), page: z.number().optional() } },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(await getThread(a)) }] }));

server.registerTool("get_thread_images",
  { description: "Opt-in: download a thread's image attachments so their text (pricing tables, per-warehouse stock boards, payment pages) is readable by vision. Much of the vendor pricing on glp1forum is image-only and invisible to get_thread's text. Returns a summary plus the images as blocks; use max to cap how many download (default 6). Costs one throttled request per image.",
    annotations: { title: "Read thread images", readOnlyHint: true },
    inputSchema: { url: z.string().optional(), threadId: z.number().optional(), page: z.number().optional(), max: z.number().optional() } },
  async (a) => {
    const r = await fetchImages(a);
    const summary = `"${r.title}" — ${r.images.length} image(s)` +
      (r.skipped.length ? `; skipped ${r.skipped.length}: ${r.skipped.map(s => `${s.url} (${s.reason})`).join("; ")}` : "");
    return { content: [{ type: "text", text: summary }, ...r.images.map(i => ({ type: "image", data: i.data, mimeType: i.mimeType }))] };
  });

server.registerTool("list_threads",
  { description: "Browse a forum section's threads (use list_forums for nodeIds).",
    annotations: { title: "List threads in section", readOnlyHint: true },
    inputSchema: { nodeId: z.number(), page: z.number().optional() } },
  async (a) => ({ content: [{ type: "text", text: JSON.stringify(await listThreads(a)) }] }));

server.registerTool("list_forums",
  { description: "List forum sections with numeric node IDs (feed these to search_forum.nodes).",
    annotations: { title: "List forum sections", readOnlyHint: true },
    inputSchema: {} },
  async () => ({ content: [{ type: "text", text: JSON.stringify(await listForums()) }] }));

await server.connect(new StdioServerTransport());
