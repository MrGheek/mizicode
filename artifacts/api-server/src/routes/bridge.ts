/**
 * Remote CLI Bridge Routes
 *
 * Exposes two REST endpoints:
 *   GET  /sessions/:id/lanes/:laneId/bridge/status — readiness check
 *   POST /sessions/:id/lanes/:laneId/exec          — send prompt, relay reply via SSE
 *
 * The WebSocket upgrade handler (handleBridgeUpgrade) is wired up in src/index.ts
 * because it operates at the http.Server level, not the Express router level.
 */

import { Router } from "express";
import type { WebSocket, RawData } from "ws";
import type { IncomingMessage } from "http";
import { requireAgentAuth } from "../middlewares/agent-auth";
import { logger } from "../lib/logger";
import {
  registerBridge,
  unregisterBridge,
  getBridge,
  getBridgeStatus,
  bridgeKey,
  tryAcquireExecLock,
  releaseExecLock,
} from "../services/bridge-registry";
import { triggerSnapshot } from "../services/snapshot";

const router = Router();

// Exported for test teardown only — do not use in production paths.
// Delegates to the centralized exec lock in bridge-registry so the file-tree
// routes and the bridge exec route share the same mutual-exclusion domain.
export function _clearActiveExec(sessionId: number, laneId: number): void {
  releaseExecLock(sessionId, laneId);
}

// ─── WebSocket upgrade handler ────────────────────────────────────────────────
// Called from index.ts on every HTTP upgrade request matched to
// /api/bridge/:sessionId/:laneId.

export function handleBridgeUpgrade(
  ws: WebSocket,
  req: IncomingMessage,
  sessionId: number,
  laneId: number,
): void {
  const memToken = process.env["MIZI_MEM_TOKEN"] || "";
  const isProd = process.env["NODE_ENV"] === "production";

  // Auth: accept Bearer token in Authorization header OR ?token= query param
  // (query param lets onstart.sh open the socket without curl's header flag)
  const authHeader = (req.headers["authorization"] as string | undefined) ?? "";
  const rawFromHeader = authHeader.startsWith("Bearer ") ? authHeader.slice(7).trim() : "";
  const urlParams = new URL(req.url ?? "", "http://localhost").searchParams;
  const rawFromQuery = urlParams.get("token") ?? "";
  const raw = rawFromHeader || rawFromQuery;

  if (memToken) {
    if (raw !== memToken) {
      logger.warn({ sessionId, laneId }, "Bridge: unauthorized connection attempt");
      ws.close(1008, "Unauthorized");
      return;
    }
  } else if (isProd) {
    // Production requires MIZI_MEM_TOKEN to be set
    logger.error({ sessionId, laneId }, "Bridge: MIZI_MEM_TOKEN not set in production — rejecting connection");
    ws.close(1008, "Server misconfigured");
    return;
  }
  // Dev mode: MIZI_MEM_TOKEN not set → open access (mirrors memory/ambient posture)

  logger.info({ sessionId, laneId }, "Bridge: instance connected");
  registerBridge(sessionId, laneId, ws);

  // Keep-alive pings so the connection doesn't time out on idle lanes
  const pingInterval = setInterval(() => {
    if (ws.readyState === ws.OPEN) {
      ws.ping();
    } else {
      clearInterval(pingInterval);
    }
  }, 30_000);

  ws.on("close", (code, reason) => {
    clearInterval(pingInterval);
    logger.info({ sessionId, laneId, code, reason: reason.toString() }, "Bridge: instance disconnected");
    unregisterBridge(sessionId, laneId);
  });

  ws.on("error", (err) => {
    logger.warn({ err, sessionId, laneId }, "Bridge: WebSocket error");
  });

  // Send a welcome frame so the client knows registration succeeded
  ws.send(JSON.stringify({ type: "registered", sessionId, laneId }), (err) => {
    if (err) logger.warn({ err }, "Bridge: failed to send registration ack");
  });
}

// ─── GET /sessions/:id/lanes/:laneId/bridge/status ────────────────────────────

router.get(
  "/sessions/:id/lanes/:laneId/bridge/status",
  requireAgentAuth(["coordination:read"]),
  (req, res) => {
    const sessionId = parseInt(String(req.params["id"] ?? ""));
    const laneId = parseInt(String(req.params["laneId"] ?? ""));
    if (!Number.isFinite(sessionId) || !Number.isFinite(laneId)) {
      res.status(400).json({ error: "Invalid session or lane ID" });
      return;
    }
    const status = getBridgeStatus(sessionId, laneId);
    res.json({ sessionId, laneId, bridge: status });
  },
);

// ─── POST /sessions/:id/lanes/:laneId/exec ────────────────────────────────────

router.post(
  "/sessions/:id/lanes/:laneId/exec",
  requireAgentAuth(["coordination:write"]),
  async (req, res) => {
    const sessionId = parseInt(String(req.params["id"] ?? ""));
    const laneId = parseInt(String(req.params["laneId"] ?? ""));
    if (!Number.isFinite(sessionId) || !Number.isFinite(laneId)) {
      res.status(400).json({ error: "Invalid session or lane ID" });
      return;
    }

    const { prompt } = req.body as { prompt?: string };
    if (!prompt || typeof prompt !== "string" || prompt.trim().length === 0) {
      res.status(400).json({ error: "prompt is required" });
      return;
    }

    const bridgeWs = getBridge(sessionId, laneId);
    if (!bridgeWs || bridgeWs.readyState !== bridgeWs.OPEN) {
      res.status(503).json({ error: "Bridge not connected" });
      return;
    }

    // Enforce single-active-exec per lane to prevent listener cross-talk.
    // Lane-busy check runs BEFORE snapshot so rejected calls don't create commits.
    // Uses the centralized lock in bridge-registry so file-tree exec calls
    // on the same lane are also blocked (and vice-versa).
    if (!tryAcquireExecLock(sessionId, laneId)) {
      res.status(409).json({ error: "Another exec is already in progress for this lane" });
      return;
    }

    // Create a git checkpoint BEFORE dispatching the exec prompt so the snapshot
    // captures the true "before" state. Fail-open: any error from triggerSnapshot
    // (bridge disconnect, shell_error, git failure) is swallowed so the exec stream
    // is never blocked by a snapshot failure. Bounded timeout prevents hangs.
    const SNAPSHOT_TIMEOUT_MS = 8_000;
    try {
      await Promise.race([
        triggerSnapshot(sessionId, laneId, "bridge_exec"),
        new Promise<void>((resolve) => setTimeout(resolve, SNAPSHOT_TIMEOUT_MS)),
      ]);
    } catch {
      // snapshot failed — fail open, exec continues regardless
    }

    // Capture as non-nullable after the guard above so TS can prove it's defined
    // inside the closures below.
    const liveWs = bridgeWs;

    // Open SSE stream to the caller
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
      "X-Accel-Buffering": "no",
    });
    res.flushHeaders();

    const writeEvent = (data: unknown): void => {
      try {
        res.write(`data: ${JSON.stringify(data)}\n\n`);
      } catch {
        // caller disconnected
      }
    };

    let finished = false;

    function finish(): void {
      if (finished) return;
      finished = true;
      liveWs.off("message", onMessage);
      liveWs.off("close", onBridgeClose);
      res.off("close", onCallerClose);
      releaseExecLock(sessionId, laneId);
    }

    function onMessage(raw: RawData): void {
      let frame: { type: string; [key: string]: unknown };
      try {
        frame = JSON.parse(raw.toString()) as { type: string; [key: string]: unknown };
      } catch {
        return;
      }
      writeEvent(frame);
      if (frame.type === "done" || frame.type === "error") {
        finish();
        res.end();
      }
    }

    function onBridgeClose(): void {
      if (finished) return;
      writeEvent({ type: "error", message: "Bridge disconnected before exec completed" });
      finish();
      res.end();
    }

    function onCallerClose(): void {
      // Caller dropped the SSE connection — stop relaying, but don't kill the
      // running claw process (it will finish naturally and the done frame is dropped)
      if (!finished) finish();
    }

    liveWs.on("message", onMessage);
    liveWs.on("close", onBridgeClose);
    // Use res "close" (fires when client drops the *response* stream) rather than
    // req "close" (which fires when the request body is fully consumed / half-closed
    // by the HTTP client, causing premature cleanup of the message listener).
    res.on("close", onCallerClose);

    // Dispatch the exec command to the claw process
    const execMsg = JSON.stringify({ type: "exec", prompt: prompt.trim() });
    liveWs.send(execMsg, (err) => {
      if (err) {
        logger.error({ err, sessionId, laneId }, "Bridge: failed to forward exec command");
        writeEvent({ type: "error", message: "Failed to send command to bridge" });
        finish();
        res.end();
      }
    });

    logger.info({ sessionId, laneId, promptLength: prompt.trim().length }, "Bridge: exec command dispatched");
  },
);

export default router;
