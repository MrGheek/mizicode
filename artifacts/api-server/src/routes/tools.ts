/**
 * Agent Tools Routes
 *
 * Exposes tool endpoints that swarm agents call during sessions:
 *   POST /sessions/:id/tools/web-search  — live web search via Brave Search API
 *   POST /sessions/:id/tools/fetch-url   — fetch and extract text from a URL
 *
 * Safety:
 *   - Both endpoints verify the session has the "web-search" skill activated
 *     AND that the skill's safety.networkAccess is not "none"
 *   - fetch-url blocks private/internal IP ranges to prevent SSRF, including
 *     redirect-chain hops (every hop is validated before following)
 *   - fetch-url respects robots.txt for MIZIBot and * (fails open)
 */

import { Router } from "express";
import { desc, eq } from "drizzle-orm";
import { db, sessionSkillsTable, sessionsTable } from "@workspace/db";
import { requireAgentAuth } from "../middlewares/agent-auth";
import { logger } from "../lib/logger";
import type { MiziSkillManifest } from "../services/skills-types";

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
const CLOUD_METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata.google.com"]);

function isPrivateHost(hostname: string): boolean {
  if (PRIVATE_HOST_RE.test(hostname)) return true;
  if (PRIVATE_IP_RE.test(hostname)) return true;
  if (CLOUD_METADATA_HOSTS.has(hostname.toLowerCase())) return true;
  return false;
}

class SsrfBlockedError extends Error {
  constructor(msg: string) { super(msg); this.name = "SsrfBlockedError"; }
}

/**
 * A fetch wrapper that follows redirects manually so that every redirect
 * target is validated against the SSRF block-list before being fetched.
 * Returns the final non-redirect Response.
 */
async function safeFetch(startUrl: URL, timeoutMs = 10_000): Promise<Response> {
  const BOT_UA = "MIZIBot/1.0 (research; +https://mizicode.com/bot)";
  const MAX_HOPS = 5;
  let current = startUrl;

  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (isPrivateHost(current.hostname)) {
      throw new SsrfBlockedError(`Host blocked (private/internal): ${current.hostname}`);
    }
    if (!["http:", "https:"].includes(current.protocol)) {
      throw new SsrfBlockedError(`Protocol not allowed: ${current.protocol}`);
    }

    const res = await fetch(current.toString(), {
      redirect: "manual",
      headers: {
        "User-Agent": BOT_UA,
        "Accept": "text/html,text/plain,application/xhtml+xml",
      },
      signal: AbortSignal.timeout(timeoutMs),
    });

    // 3xx — follow manually so every hop is validated
    if (res.status >= 300 && res.status < 400) {
      if (hop === MAX_HOPS) throw new Error("Too many redirects");
      const location = res.headers.get("location");
      if (!location) throw new Error("Redirect with no Location header");
      current = new URL(location, current.toString());
      continue;
    }

    return res;
  }

  throw new Error("Redirect loop exceeded");
}

// ─── robots.txt Compliance ────────────────────────────────────────────────────

/**
 * Returns true if MIZIBot (or any bot) is disallowed from fetching the given path.
 * Fails open — if robots.txt cannot be fetched or parsed, we allow the request.
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
    return parseRobotsDisallow(text, target.pathname || "/");
  } catch {
    return false; // fail open — don't block when robots.txt is unreachable
  }
}

function parseRobotsDisallow(robots: string, path: string): boolean {
  const lines = robots.split(/\r?\n/);
  let applies = false;
  for (const raw of lines) {
    const line = (raw.split("#")[0] ?? "").trim();
    if (!line) continue;
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).toLowerCase().trim();
    const value = line.slice(colonIdx + 1).trim();
    if (key === "user-agent") {
      applies = value === "*" || value.toLowerCase().includes("mizibot");
    } else if (key === "disallow" && applies) {
      if (value && path.startsWith(value)) return true;
    }
  }
  return false;
}

// ─── Session Skill Gate ───────────────────────────────────────────────────────

interface SkillGateResult {
  ok: boolean;
  reason?: "session_not_found" | "skill_not_active" | "network_access_denied";
}

/**
 * Verify the session exists, the given skill is in the latest
 * activatedSkillsJson, and its safety.networkAccess is not "none".
 */
async function checkSkillGate(sessionId: number, skillId: string): Promise<SkillGateResult> {
  const [session] = await db
    .select({ id: sessionsTable.id })
    .from(sessionsTable)
    .where(eq(sessionsTable.id, sessionId))
    .limit(1);

  if (!session) return { ok: false, reason: "session_not_found" };

  const [row] = await db
    .select({ activatedSkillsJson: sessionSkillsTable.activatedSkillsJson })
    .from(sessionSkillsTable)
    .where(eq(sessionSkillsTable.sessionId, sessionId))
    .orderBy(desc(sessionSkillsTable.activatedAt))
    .limit(1);

  if (!row) return { ok: false, reason: "skill_not_active" };

  const skills = row.activatedSkillsJson as MiziSkillManifest[];
  if (!Array.isArray(skills)) return { ok: false, reason: "skill_not_active" };

  const skill = skills.find((s) => s.id === skillId);
  if (!skill) return { ok: false, reason: "skill_not_active" };

  if (skill.safety?.networkAccess === "none") {
    return { ok: false, reason: "network_access_denied" };
  }

  return { ok: true };
}

// ─── Shared gate handler ──────────────────────────────────────────────────────

function applyGate(gate: SkillGateResult, res: import("express").Response): boolean {
  if (gate.ok) return false;
  if (gate.reason === "session_not_found") {
    res.status(404).json({ error: "Session not found" });
  } else if (gate.reason === "network_access_denied") {
    res.status(403).json({ error: "Session network access policy prohibits this tool" });
  } else {
    res.status(403).json({ error: "The required skill is not active for this session" });
  }
  return true; // caller should return early
}

// ─── Search helpers ───────────────────────────────────────────────────────────

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
    headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_API_KEY },
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
    const sessionId = parseInt(String(req.params["id"] ?? ""));
    if (!Number.isFinite(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    // Gate first: session existence + skill activation + network-access policy
    const gate = await checkSkillGate(sessionId, "web-search");
    if (applyGate(gate, res)) return;

    if (!BRAVE_API_KEY && !SERPER_API_KEY) {
      res.status(503).json({
        error: "Web search is not configured. Set BRAVE_SEARCH_API_KEY or SERPER_API_KEY on the server.",
      });
      return;
    }

    const { query, limit } = req.body as { query?: string; limit?: number };
    if (!query || typeof query !== "string" || query.trim().length === 0) {
      res.status(400).json({ error: "query is required" });
      return;
    }

    const resultLimit = Math.min(Math.max(1, Number(limit) || 8), 20);

    try {
      const results: SearchResult[] = BRAVE_API_KEY
        ? await searchViaBrave(query.trim(), resultLimit)
        : await searchViaSerper(query.trim(), resultLimit);

      logger.info({ sessionId, query: query.trim(), resultCount: results.length }, "tools: web-search completed");
      // Return array directly per contract: [{ title, url, snippet }]
      res.json(results);
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

    const gate = await checkSkillGate(sessionId, "web-search");
    if (applyGate(gate, res)) return;

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

    // Initial SSRF check before any network call
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
      // safeFetch validates every redirect hop against the SSRF block-list
      const fetchRes = await safeFetch(parsedUrl);

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
      const content = truncated
        ? text.slice(0, MAX_FETCH_CHARS) + "\n\n[... content truncated at 8 000 chars ...]"
        : text;

      logger.info({ sessionId, url: parsedUrl.toString(), chars: content.length, truncated }, "tools: fetch-url completed");
      res.json({ url: parsedUrl.toString(), content, truncated, charCount: content.length });
    } catch (err) {
      if (err instanceof SsrfBlockedError) {
        res.status(403).json({ error: err.message });
        return;
      }
      logger.error({ err, sessionId, url }, "tools: fetch-url failed");
      res.status(502).json({ error: "URL fetch failed", detail: String(err) });
    }
  }
);

// ─── POST /sessions/:id/tools/screenshot ─────────────────────────────────────

router.post(
  "/sessions/:id/tools/screenshot",
  requireAgentAuth(["sessions:read"]),
  async (req, res) => {
    const sessionId = parseInt(String(req.params["id"] ?? ""));
    if (!Number.isFinite(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const gate = await checkSkillGate(sessionId, "browser-preview");
    if (applyGate(gate, res)) return;

    const { url, viewportWidth, viewportHeight } = req.body as {
      url?: string;
      viewportWidth?: number;
      viewportHeight?: number;
    };
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

    const viewport = {
      width: Math.min(Math.max(400, Number(viewportWidth) || 1280), 2560),
      height: Math.min(Math.max(300, Number(viewportHeight) || 720), 1920),
    };

    try {
      const { screenshotUrl: takeSS } = await import("../services/browser-inspector.js");
      const buf = await takeSS(parsedUrl.toString(), viewport);
      logger.info({ sessionId, url: parsedUrl.toString(), viewport }, "tools: screenshot completed");
      res.json({
        imageBase64: buf.toString("base64"),
        mimeType: "image/png",
        capturedAt: new Date().toISOString(),
      });
    } catch (err) {
      logger.error({ err, sessionId, url }, "tools: screenshot failed");
      res.status(502).json({ error: "Screenshot failed", detail: String(err) });
    }
  }
);

// ─── POST /sessions/:id/tools/console-capture ─────────────────────────────────

router.post(
  "/sessions/:id/tools/console-capture",
  requireAgentAuth(["sessions:read"]),
  async (req, res) => {
    const sessionId = parseInt(String(req.params["id"] ?? ""));
    if (!Number.isFinite(sessionId)) {
      res.status(400).json({ error: "Invalid session ID" });
      return;
    }

    const gate = await checkSkillGate(sessionId, "browser-preview");
    if (applyGate(gate, res)) return;

    const { url, durationMs } = req.body as { url?: string; durationMs?: number };
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

    const duration = Math.min(Math.max(1_000, Number(durationMs) || 5_000), 30_000);

    try {
      const { captureConsoleLogs } = await import("../services/browser-inspector.js");
      const logs = await captureConsoleLogs(parsedUrl.toString(), duration);
      logger.info({ sessionId, url: parsedUrl.toString(), durationMs: duration, logCount: logs.length }, "tools: console-capture completed");
      res.json({ url: parsedUrl.toString(), durationMs: duration, logs });
    } catch (err) {
      logger.error({ err, sessionId, url }, "tools: console-capture failed");
      res.status(502).json({ error: "Console capture failed", detail: String(err) });
    }
  }
);

export default router;

