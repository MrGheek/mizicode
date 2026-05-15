/**
 * MCP Streamable HTTP transport handler for Express.
 *
 * Mounts:
 *   POST   /api/mcp  — primary MCP endpoint (tools/list, tools/call, resources/*, etc.)
 *   GET    /api/mcp  — SSE stream for MCP clients that prefer server-sent events
 *   DELETE /api/mcp  — session termination
 *
 * Auth: the existing requireAgentAuth middleware is applied at the app.ts level
 * before this router, so the bearer token is already validated and req.apiKey
 * is populated (or undefined for MIZI_MEM_TOKEN operator callers).
 *
 * Session model:
 *   Each MCP session (identified by the Mcp-Session-Id response header that the
 *   transport assigns on initialization) gets its own McpServer + Transport pair
 *   stored in the sessionMap. Stateless clients (no session header) get a fresh
 *   pair per request and the pair is discarded after the response.
 */

import { Router, type Request, type Response } from "express";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createMcpServer } from "./register.js";
import { logger } from "../lib/logger.js";
import type { ApiKeyRecord } from "../middlewares/agent-auth.js";

const router = Router();

interface SessionEntry {
  server: McpServer;
  transport: StreamableHTTPServerTransport;
  apiKey: ApiKeyRecord | undefined;
}

const sessionMap = new Map<string, SessionEntry>();

// Periodic cleanup of stale sessions (every 15 minutes)
const SESSION_TTL_MS = 60 * 60 * 1000;
const sessionLastActivity = new Map<string, number>();

setInterval(() => {
  const now = Date.now();
  for (const [sid, lastActive] of sessionLastActivity.entries()) {
    if (now - lastActive > SESSION_TTL_MS) {
      const entry = sessionMap.get(sid);
      if (entry) {
        entry.transport.close().catch(() => {});
        sessionMap.delete(sid);
      }
      sessionLastActivity.delete(sid);
    }
  }
}, 15 * 60 * 1000).unref();

async function handleMcpRequest(req: Request, res: Response): Promise<void> {
  const reqApiKey = req.apiKey;

  try {
    const sessionId = req.headers["mcp-session-id"] as string | undefined;

    if (sessionId && sessionMap.has(sessionId)) {
      const entry = sessionMap.get(sessionId)!;

      // Enforce strict session-to-key binding: the API key that created the session
      // must match the key on every subsequent request. This prevents privilege
      // escalation where a lower-privilege key reuses a higher-privilege session
      // (or vice versa), ensuring auth context is always request-consistent.
      const sessionKeyId = entry.apiKey?.id ?? null;
      const requestKeyId = reqApiKey?.id ?? null;
      if (sessionKeyId !== requestKeyId) {
        res.status(401).json({
          jsonrpc: "2.0",
          error: { code: -32001, message: "Unauthorized: API key does not match the session." },
          id: null,
        });
        return;
      }

      sessionLastActivity.set(sessionId, Date.now());
      await entry.transport.handleRequest(req, res, req.body);
      return;
    }

    let resolvedSessionId: string | undefined;

    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: () => {
        resolvedSessionId = crypto.randomUUID();
        return resolvedSessionId;
      },
      onsessioninitialized: (sid) => {
        const getApiKey = () => reqApiKey;
        const server = createMcpServer(getApiKey);
        sessionMap.set(sid, { server, transport, apiKey: reqApiKey });
        sessionLastActivity.set(sid, Date.now());
        logger.info({ sessionId: sid }, "[MCP] Session initialized");

        transport.onclose = () => {
          sessionMap.delete(sid);
          sessionLastActivity.delete(sid);
          logger.info({ sessionId: sid }, "[MCP] Session closed");
        };

        server.connect(transport).catch((err) => {
          logger.error({ err, sessionId: sid }, "[MCP] Failed to connect server to transport");
        });
      },
    });

    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    logger.error({ err }, "[MCP] Request handler error");
    if (!res.headersSent) {
      res.status(500).json({ error: "MCP handler error" });
    }
  }
}

router.post("/", handleMcpRequest);
router.get("/", handleMcpRequest);
router.delete("/", handleMcpRequest);

export default router;
