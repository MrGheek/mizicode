/**
 * Agent Tools Routes
 *
 * Exposes tool endpoints that swarm agents call during sessions:
 *   POST /sessions/:id/tools/web-search  — live web search via Brave Search API
 *   POST /sessions/:id/tools/fetch-url   — fetch and extract text from a URL
 *
 * Safety:
 *   - Both endpoints verify the session has the "web-search" skill activated
 *   - fetch-url blocks private/internal IP ranges to prevent SSRF
 *   - fetch-url respects robots.txt for MIZIBot and *
 */

import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db, sessionSkillsTable, sessionsTable } from "@workspace/db";
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

// ─── SSRF Guard ───────────────────────────────────────────────────────────────

const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.corp|.*\.intranet)$/i;

const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;

function isPrivateHost(hostname: string): boolean {
  if (PRIVATE_HOST_RE.test(hostname)) return true;
  if (PRIVATE_IP_RE.test(hostname)) return true;
  // Block AWS / GCP / Azure metadata endpoints by IP
  if (hostname === "169.254.169.254" || hostname === "metadata.google.internal") return true;
  return false;
}

// ─── robots.txt Compliance ────────────────────────────────────────────────────

/**
 * Returns true if MIZIBot (or any bot) is disallowed from fetching the given path.
 * Fails open — if robots.txt cannot be fetched, we allow the request.
 */
async function isDisallowedByRobots(target: URL): Promise<boolean> {
  const robotsUrl = `${target.protocol}//${target.host}/robots.txt`;
  try {
    const res = await fetch(robotsUrl, {
      headers: { "User-Agent": "MIZIBot/1.0" },
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return false;
    const text = await res.text();
    const path = target.pathname || "/";
    return parseRobotsDisallow(text, path);
  } catch {
    return false; // fail open — don't block if robots.txt is unavailable
  }
}

function parseRobotsDisallow(robots: string, path: string): boolean {
  const lines = robots.split(/\r?\n/);
  let applies = false;
  for (const raw of lines) {
    const line = raw.split("#")[0]!.trim();
    if (!line) continue;
    const [field, ...rest] = line.split(":");
    const key = (field ?? "").toLowerCase().trim();
    const value = rest.join(":").trim();
    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase().includes("mizibot");
    } else if (key === "disallow" && applies) {
      if (value && path.startsWith(value)) return true;
    }
  }
  return false;
}

// ─── Session Skill Gate ───────────────────────────────────────────────────────

/**
 * Returns true when the session's latest activated skill bundle contains
 * the "web-search" skill (matched via manifest id "web-search").
 */
async function sessionHasWebSearch(sessionId: number): Promise<boolean> {
  const [row] = await db
    .select({ activatedSkillsJson: sessionSkillsTable.activatedSkillsJson })
    .from(sessionSkillsTable)
    .where(eq(sessionSkillsTable.sessionId, sessionId))
    .orderBy(desc(sessionSkillsTable.activatedAt))
    .limit(1);

  if (!row) return false;
  const skills = row.activatedSkillsJson as Array<{ slug?: string; id?: string }>;
  if (!Array.isArray(skills)) return false;
  return skills.some((s) => s.slug === "web-search" || s.id === "web-search");
}

/**
 * Verify session exists (not deleted) and return whether the "web-search"
 * skill is active on it.  Returns null when the session does not exist.
 */
async function checkSession(sessionId: number): Promise<{ skillActive: boolean } | null> {
  const [session] = await db
    .select({ id: sessionsTable.id, status: sessionsTable.status })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);

  if (!session) return null;

  const skillActive = await sessionHasWebSearch(sessionId);
  return { skillActive };
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
 * Removes common boilerplate sections before stripping tags.
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

    const sessionCtx = await checkSession(sessionId);
    if (!sessionCtx) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!sessionCtx.skillActive) {
      res.status(403).json({ error: "The web-search skill is not active for this session" });
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

    const sessionCtx = await checkSession(sessionId);
    if (!sessionCtx) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    if (!sessionCtx.skillActive) {
      res.status(403).json({ error: "The web-search skill is not active for this session" });
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

    if (isPrivateHost(parsedUrl.hostname)) {
      res.status(403).json({ error: "Fetching private or internal hosts is not permitted" });
      return;
    }

    const disallowed = await isDisallowedByRobots(parsedUrl);
    if (disallowed) {
      res.status(403).json({
        error: "This URL is disallowed by the site's robots.txt for automated agents",
        url: parsedUrl.toString(),
      });
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
