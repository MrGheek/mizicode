import { Router, Request, Response } from "express";
import {
  initSession,
  addObservation,
  addSummary,
  getPastContext,
  listObservations,
  listSessions,
  subscribeToObservations,
} from "../services/memory";
import { logger } from "../lib/logger";

const router = Router();

const MEM_TOKEN = process.env["OMNIQL_MEM_TOKEN"];
const IS_PROD = process.env["NODE_ENV"] === "production";

if (!MEM_TOKEN) {
  if (IS_PROD) {
    throw new Error("OMNIQL_MEM_TOKEN must be set in production to protect memory endpoints");
  }
  // Development: warn but allow unauthenticated access
  console.warn("[mem] OMNIQL_MEM_TOKEN not set — memory endpoints are unprotected (dev mode)");
}

function verifyMemToken(req: Request, res: Response): boolean {
  if (!MEM_TOKEN) {
    return true;
  }
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== MEM_TOKEN) {
    res.status(401).json({ error: "Unauthorized" });
    return false;
  }
  return true;
}

router.post("/mem/init", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { sessionId, userId, projectPath } = req.body as { sessionId: string; userId: string; projectPath?: string };
  if (!sessionId || !userId) {
    res.status(400).json({ error: "sessionId and userId are required" });
    return;
  }
  try {
    initSession(sessionId, userId, projectPath || "");
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "Failed to init mem session");
    res.status(500).json({ error: "Failed to initialize session" });
  }
});

router.post("/mem/observation", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { sessionId, userId, toolName, inputSummary, outputSummary } = req.body as {
    sessionId: string;
    userId: string;
    toolName: string;
    inputSummary: string;
    outputSummary: string;
  };
  if (!sessionId || !userId || !toolName) {
    res.status(400).json({ error: "sessionId, userId, toolName are required" });
    return;
  }
  try {
    addObservation(sessionId, userId, toolName, inputSummary || "", outputSummary || "");
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "Failed to record mem observation");
    res.status(500).json({ error: "Failed to record observation" });
  }
});

router.post("/mem/summarize", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { sessionId, userId, summary } = req.body as {
    sessionId: string;
    userId: string;
    summary: string;
  };
  if (!sessionId || !userId || !summary) {
    res.status(400).json({ error: "sessionId, userId, summary are required" });
    return;
  }
  try {
    addSummary(sessionId, userId, summary);
    res.json({ ok: true });
  } catch (err) {
    logger.error(err, "Failed to store mem summary");
    res.status(500).json({ error: "Failed to store summary" });
  }
});

router.get("/mem/context/:userId", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { userId } = req.params;
  const projectPath = req.query["projectPath"] as string | undefined;
  try {
    const context = getPastContext(userId, projectPath);
    res.json({ context, empty: context.length === 0 });
  } catch (err) {
    logger.error(err, "Failed to get mem context");
    res.status(500).json({ error: "Failed to get context" });
  }
});

router.get("/mem/observations", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const limit = Math.min(parseInt(String(req.query["limit"] || "100"), 10), 500);
  const offset = parseInt(String(req.query["offset"] || "0"), 10);
  try {
    const observations = listObservations(userId, limit, offset);
    res.json(observations);
  } catch (err) {
    logger.error(err, "Failed to list observations");
    res.status(500).json({ error: "Failed to list observations" });
  }
});

router.get("/mem/sessions", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const limit = Math.min(parseInt(String(req.query["limit"] || "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] || "0"), 10);
  try {
    const sessions = listSessions(userId, limit, offset);
    res.json(sessions);
  } catch (err) {
    logger.error(err, "Failed to list mem sessions");
    res.status(500).json({ error: "Failed to list sessions" });
  }
});

// SSE stream: real-time feed of new tool observations for a given userId.
// Clients (e.g. AI agents, the dashboard) connect while a session is active and
// receive each new observation as a JSON data event as it is recorded.
router.get("/mem/observations/stream", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("X-Accel-Buffering", "no");
  res.flushHeaders();

  const keepAlive = setInterval(() => {
    res.write(": ping\n\n");
  }, 20000);

  const unsubscribe = subscribeToObservations(userId, (obs) => {
    res.write(`data: ${JSON.stringify(obs)}\n\n`);
  });

  req.on("close", () => {
    clearInterval(keepAlive);
    unsubscribe();
  });
});

export default router;
