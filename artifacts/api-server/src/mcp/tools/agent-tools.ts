import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { logger } from "../../lib/logger.js";

const BRAVE_API_KEY = process.env["BRAVE_SEARCH_API_KEY"] ?? "";
const SERPER_API_KEY = process.env["SERPER_API_KEY"] ?? "";

const PRIVATE_HOST_RE = /^(localhost|.*\.local|.*\.internal|.*\.corp|.*\.intranet)$/i;
const PRIVATE_IP_RE = /^(127\.|10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.|169\.254\.|::1$|fc[0-9a-f]{2}:|fd[0-9a-f]{2}:)/i;
const CLOUD_METADATA_HOSTS = new Set(["169.254.169.254", "metadata.google.internal", "metadata.google.com"]);

function isPrivateHost(hostname: string): boolean {
  if (PRIVATE_HOST_RE.test(hostname)) return true;
  if (PRIVATE_IP_RE.test(hostname)) return true;
  if (CLOUD_METADATA_HOSTS.has(hostname.toLowerCase())) return true;
  return false;
}

/**
 * Checks robots.txt for MIZIBot and * user-agent.
 * Fails open — if robots.txt cannot be fetched, the request is allowed.
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
    return false;
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

async function safeFetch(startUrl: URL, timeoutMs = 10_000): Promise<Response> {
  const BOT_UA = "MIZIBot/1.0 (research; +https://mizicode.com/bot)";
  const MAX_HOPS = 5;
  let current = startUrl;
  for (let hop = 0; hop <= MAX_HOPS; hop++) {
    if (isPrivateHost(current.hostname)) {
      throw new Error(`Host blocked (private/internal): ${current.hostname}`);
    }
    if (!["http:", "https:"].includes(current.protocol)) {
      throw new Error(`Protocol not allowed: ${current.protocol}`);
    }
    const res = await fetch(current.toString(), {
      redirect: "manual",
      headers: { "User-Agent": BOT_UA, "Accept": "text/html,text/plain,application/xhtml+xml" },
      signal: AbortSignal.timeout(timeoutMs),
    });
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

export function registerAgentTools(server: McpServer): void {
  server.registerTool("web_search", {
    description: "[Read] Run a web search via the configured search provider (Brave/Serper). Scoped to a session context.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      sessionId: z.number().int().optional().describe("Session ID for context (optional)"),
      limit: z.number().int().min(1).max(20).optional().describe("Max results (default 5)"),
    }),
  }, async ({ query, sessionId, limit }) => {
    const count = limit ?? 5;

    if (BRAVE_API_KEY) {
      try {
        const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
        const resp = await fetch(url, {
          headers: { "Accept": "application/json", "X-Subscription-Token": BRAVE_API_KEY },
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          const data = await resp.json() as { web?: { results?: unknown[] } };
          const results = data?.web?.results ?? [];
          return { content: [{ type: "text", text: JSON.stringify({ query, results, provider: "brave" }, null, 2) }] };
        }
      } catch (err) {
        logger.warn({ err, sessionId }, "[MCP] web_search Brave failed");
      }
    }

    if (SERPER_API_KEY) {
      try {
        const resp = await fetch("https://google.serper.dev/search", {
          method: "POST",
          headers: { "Content-Type": "application/json", "X-API-KEY": SERPER_API_KEY },
          body: JSON.stringify({ q: query, num: count }),
          signal: AbortSignal.timeout(10_000),
        });
        if (resp.ok) {
          const data = await resp.json() as { organic?: unknown[] };
          const results = data?.organic ?? [];
          return { content: [{ type: "text", text: JSON.stringify({ query, results, provider: "serper" }, null, 2) }] };
        }
      } catch (err) {
        logger.warn({ err, sessionId }, "[MCP] web_search Serper failed");
      }
    }

    return { content: [{ type: "text", text: JSON.stringify({ error: "No search provider configured. Set BRAVE_SEARCH_API_KEY or SERPER_API_KEY." }) }] };
  });

  server.registerTool("fetch_url", {
    description: "[Read] Fetch and extract text content from a URL. SSRF-protected — private/internal hosts are blocked. Respects robots.txt for MIZIBot.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to fetch"),
      maxBytes: z.number().int().min(1024).max(524288).optional().describe("Max response bytes (default 65536)"),
    }),
  }, async ({ url, maxBytes }) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid URL" }) }] };
    }

    if (isPrivateHost(target.hostname)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "URL blocked — private/internal hosts are not allowed" }) }] };
    }

    if (await isDisallowedByRobots(target)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "This URL is disallowed by the site's robots.txt for automated agents" }) }] };
    }

    try {
      const resp = await safeFetch(target, 15_000);
      const rawText = await resp.text();
      const limit = maxBytes ?? 65536;
      const truncated = rawText.length > limit;
      const text = truncated ? rawText.slice(0, limit) : rawText;

      const stripped = text
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
        .replace(/<[^>]+>/g, " ")
        .replace(/\s+/g, " ")
        .trim();

      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            url,
            statusCode: resp.status,
            contentType: resp.headers.get("content-type"),
            truncated,
            text: stripped,
          }, null, 2),
        }],
      };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : "Fetch failed" }) }] };
    }
  });

  server.registerTool("screenshot_url", {
    description: "[Read] Capture a screenshot of a URL using the browser inspector service.",
    inputSchema: z.object({
      url: z.string().url().describe("URL to screenshot"),
      width: z.number().int().min(320).max(2560).optional().describe("Viewport width (default 1280)"),
      height: z.number().int().min(240).max(2000).optional().describe("Viewport height (default 720)"),
    }),
  }, async ({ url, width, height }) => {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Invalid URL" }) }] };
    }

    if (isPrivateHost(target.hostname)) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "URL blocked — private/internal hosts are not allowed" }) }] };
    }

    try {
      const { screenshotUrl } = await import("../../services/browser-inspector.js");
      const buf = await screenshotUrl(url, { width: width ?? 1280, height: height ?? 720 });
      const screenshot = buf.toString("base64");
      return { content: [{ type: "text", text: JSON.stringify({ url, screenshot, contentType: "image/png" }, null, 2) }] };
    } catch (err) {
      logger.warn({ err, url }, "[MCP] screenshot_url failed");
      return { content: [{ type: "text", text: JSON.stringify({ error: "Screenshot failed", url }) }] };
    }
  });
}
