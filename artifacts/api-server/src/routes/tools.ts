/**
 * Agent Tools Routes
 *
 * Exposes tool endpoints that swarm agents call during sessions:
 *   POST /sessions/:id/tools/web-search  — live web search via Brave Search API
 *   POST /sessions/:id/tools/fetch-url   — fetch and extract text from a URL
 */

import { Router } from "express";
import { requireAgentAuth } from "../middlewares/agent-auth";
import { logger } from "../lib/logger";

const router = Router();

const BRAVE_API_KEY = process.env["BRAVE_SEARCH_API_KEY"] ?? "";
const SERPER_API_KEY = process.env["SERPER_API_KEY"] ?? "";

if (!BRAVE_API_KEY && !SERPER_API_KEY) {
  logger.warn(
    "Neither BRAVE_SEARCH_API_KEY nor SERPER_API_KEY is set — " +
    "POST /sessions/:id/tools/web-search will return 503 until a key is configured."
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function searchViaBrave(query: string, limit: number): Promise<SearchResult[]> {
  const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${limit}`;
  const res = await fetch(url, {
    headers: {
      "Accept": "application/json",
      "Accept-Encoding": "gzip",
      "X-Subscription-Token": BRAVE_API_KEY,
    },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Brave Search API error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    web?: { results?: Array<{ title: string; url: string; description?: string }> };
  };
  return (data.web?.results ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.url ?? "",
    snippet: r.description ?? "",
  }));
}

async function searchViaSerper(query: string, limit: number): Promise<SearchResult[]> {
  const res = await fetch("https://google.serper.dev/search", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-API-KEY": SERPER_API_KEY,
    },
    body: JSON.stringify({ q: query, num: limit }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) {
    throw new Error(`Serper API error ${res.status}: ${await res.text()}`);
  }
  const data = (await res.json()) as {
    organic?: Array<{ title: string; link: string; snippet?: string }>;
  };
  return (data.organic ?? []).map((r) => ({
    title: r.title ?? "",
    url: r.link ?? "",
    snippet: r.snippet ?? "",
  }));
}

/**
 * Strip HTML tags, collapse whitespace, and return plain text.
 * Handles common boilerplate patterns (nav/header/footer/script/style removal).
 */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<nav[\s\S]*?<\/nav>/gi, " ")
    .replace(/<header[\s\S]*?<\/header>/gi, " ")
    .replace(/<footer[\s\S]*?<\/footer>/gi, " ")
    .replace(/<aside[\s\S]*?<\/aside>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|li|h[1-6]|section|article|blockquote|tr)[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const MAX_FETCH_CHARS = 8_000;

// ─── POST /sessions/:id/tools/web-search ──────────────────────────────────────

router.post(
  "/sessions/:id/tools/web-search",
  requireAgentAuth(["sessions:read"]),
  async (req, res) => {
    if (!BRAVE_API_KEY && !SERPER_API_KEY) {
      res.status(503).json({
        error: "Web search is not configured. Set BRAVE_SEARCH_API_KEY or SERPER_API_KEY on the server.",
      });
      return;
    }

    const sessionId = parseInt(String(req.params["id"] ?? ""));
    if (!Number.isFinite(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const { query, limit } = req.body as { query?: string; limit?: number };
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const resultLimit = Math.min(Math.max(1, Number(limit) || 8), 20);

    try {
      const results = BRAVE_API_KEY
        ? await searchViaBrave(query.trim(), resultLimit)
        : await searchViaSerper(query.trim(), resultLimit);

      logger.info({ sessionId, query: query.trim(), resultCount: results.length }, "tools: web-search completed");
      res.json({ query: query.trim(), results });
    } catch (err) {
      logger.error({ err, sessionId, query }, "tools: web-search failed");
      res.status(502).json({ error: "Search request failed", detail: String(err) });
    }
  }
);

// ─── POST /sessions/:id/tools/fetch-url ───────────────────────────────────────

router.post(
  "/sessions/:id/tools/fetch-url",
  requireAgentAuth(["sessions:read"]),
  async (req, res) => {
    const sessionId = parseInt(String(req.params["id"] ?? ""));
    if (!Number.isFinite(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const { url } = req.body as { url?: string };
    if (!url || typeof url !== "string" || url.trim().length === 0) {
      res.status(400).json({ error: "url is required" });
      return;
    }

    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url.trim());
    } catch {
      res.status(400).json({ error: "Invalid URL" });
      return;
    }

    if (!["http:", "https:"].includes(parsedUrl.protocol)) {
      res.status(400).json({ error: "Only http and https URLs are supported" });
      return;
    }

    try {
      const fetchRes = await fetch(parsedUrl.toString(), {
        headers: {
          "User-Agent": "MIZIBot/1.0 (research; +https://mizicode.com/bot)",
          "Accept": "text/html,text/plain,application/xhtml+xml",
        },
        signal: AbortSignal.timeout(10_000),
      });

      if (!fetchRes.ok) {
        res.status(502).json({ error: `Remote server returned ${fetchRes.status}`, url: parsedUrl.toString() });
        return;
      }

      const contentType = fetchRes.headers.get("content-type") ?? "";
      const rawText = await fetchRes.text();

      let text: string;
      if (contentType.includes("text/html") || contentType.includes("application/xhtml")) {
        text = htmlToText(rawText);
      } else {
        text = rawText.replace(/\s+/g, " ").trim();
      }

      const truncated = text.length > MAX_FETCH_CHARS;
      const content = truncated ? text.slice(0, MAX_FETCH_CHARS) + "\n\n[... content truncated at 8 000 chars ...]" : text;

      logger.info({ sessionId, url: parsedUrl.toString(), chars: content.length, truncated }, "tools: fetch-url completed");
      res.json({ url: parsedUrl.toString(), content, truncated, charCount: content.length });
    } catch (err) {
      logger.error({ err, sessionId, url }, "tools: fetch-url failed");
      res.status(502).json({ error: "URL fetch failed", detail: String(err) });
    }
  }
);

export default router;
