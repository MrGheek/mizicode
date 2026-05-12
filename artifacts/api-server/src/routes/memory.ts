import { Router, Request, Response } from "express";
import {
  initSession,
  addObservation,
  addSummary,
  getPastContext,
  listObservations,
  listSessions,
  subscribeToObservations,
  saveMemoryItem,
  memoryIndex,
  memorySearch,
  memoryGet,
  markItemInjected,
  markSymbolStale,
  listConflicts,
  updateConflictStatus,
  listStaleItems,
  getPromotionHistory,
  getGovernanceStats,
  listMemoryItems,
  reversePromotion,
  shapeItemForProfile,
  BUDGET_PROFILES_BY_MODE,
  SCOPE_PRIORITY,
} from "../services/memory";
import type { MemoryType, MemoryScope, ConflictStatus, PromotionStatus } from "../services/memory";
import {
  recordTurn,
  runPassiveRecallForTurn,
  getLatestRecallShortlist,
  markRecallInjected,
  recordEdge,
  listEdges,
  listRecallAudit,
  getRecallMetrics,
  isPassiveRecallEnabled,
  setPassiveRecallForSession,
  passiveRecallGloballyEnabled,
  VALID_EDGE_TYPES,
} from "../services/memory-passive";
import type { EdgeType } from "../services/memory-passive";
import { logger } from "../lib/logger";

const router = Router();

const MEM_TOKEN = process.env["MIZI_MEM_TOKEN"];
const IS_PROD = process.env["NODE_ENV"] === "production";

const VALID_TOKEN_MODES = ["full", "core", "lean", "ultra"] as const;
const VALID_SESSION_TYPES = ["team", "solo"] as const;

function validateTokenMode(raw: string | undefined, res: Response): string | null {
  if (!raw) return "core";
  if (!(VALID_TOKEN_MODES as readonly string[]).includes(raw)) {
    res.status(400).json({ error: `Invalid tokenMode. Must be one of: ${VALID_TOKEN_MODES.join(", ")}` });
    return null;
  }
  return raw;
}

function validateSessionType(raw: string | undefined, res: Response): string | null | undefined {
  if (raw === undefined) return undefined;
  if (!(VALID_SESSION_TYPES as readonly string[]).includes(raw)) {
    res.status(400).json({ error: `Invalid sessionType. Must be one of: ${VALID_SESSION_TYPES.join(", ")}` });
    return null;
  }
  return raw;
}

if (!MEM_TOKEN) {
  if (IS_PROD) {
    throw new Error("MIZI_MEM_TOKEN must be set in production to protect memory endpoints");
  }
  console.warn("[mem] MIZI_MEM_TOKEN not set — memory endpoints are unprotected (dev mode)");
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
  const repoUrl = req.query["repoUrl"] as string | undefined;
  try {
    const context = getPastContext(userId, projectPath, 8000, repoUrl);
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

// ─── Governance: Layer 1 — memory index (tiny shortlist) ─────────────────────

router.get("/mem/index", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const tokenMode = validateTokenMode(req.query["tokenMode"] as string | undefined, res);
  if (tokenMode === null) return;
  const rawScope = req.query["scope"] as string | undefined;
  const scope = rawScope && SCOPE_PRIORITY.includes(rawScope as MemoryScope)
    ? (rawScope as MemoryScope)
    : undefined;
  if (rawScope && !scope) {
    res.status(400).json({ error: `Invalid scope. Must be one of: ${SCOPE_PRIORITY.join(", ")}` });
    return;
  }
  const sessionType = validateSessionType(req.query["sessionType"] as string | undefined, res);
  if (sessionType === null) return;
  const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : undefined;

  try {
    const rawItems = memoryIndex({ userId, scope, sessionType, tokenMode, limit });
    const profile = BUDGET_PROFILES_BY_MODE[tokenMode] || BUDGET_PROFILES_BY_MODE["core"];
    const items = rawItems.map(item => shapeItemForProfile(item, profile));
    res.json({
      layer: 1,
      tokenMode,
      items,
      budgetProfile: profile,
    });
  } catch (err) {
    logger.error(err, "Failed to get mem index");
    res.status(500).json({ error: "Failed to get memory index" });
  }
});

// ─── Governance: Layer 2 — memory search (richer filtered set) ───────────────

router.get("/mem/search", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  const q = req.query["q"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  if (!q) {
    res.status(400).json({ error: "q query param required" });
    return;
  }

  const tokenMode = validateTokenMode(req.query["tokenMode"] as string | undefined, res);
  if (tokenMode === null) return;
  const rawScope = req.query["scope"] as string | undefined;
  const scope = rawScope && SCOPE_PRIORITY.includes(rawScope as MemoryScope)
    ? (rawScope as MemoryScope)
    : undefined;
  if (rawScope && !scope) {
    res.status(400).json({ error: `Invalid scope. Must be one of: ${SCOPE_PRIORITY.join(", ")}` });
    return;
  }
  const sessionType = validateSessionType(req.query["sessionType"] as string | undefined, res);
  if (sessionType === null) return;
  const VALID_MEMORY_TYPES: MemoryType[] = ["observation", "research", "session_summary", "convention", "guardrail", "note", "warning"];
  const rawMemoryType = req.query["memoryType"] as string | undefined;
  const memoryType = rawMemoryType && VALID_MEMORY_TYPES.includes(rawMemoryType as MemoryType)
    ? (rawMemoryType as MemoryType)
    : undefined;
  if (rawMemoryType && !memoryType) {
    res.status(400).json({ error: `Invalid memoryType. Must be one of: ${VALID_MEMORY_TYPES.join(", ")}` });
    return;
  }
  const includeStale = req.query["includeStale"] === "true";
  const limit = req.query["limit"] ? parseInt(String(req.query["limit"]), 10) : undefined;

  try {
    const rawItems = memorySearch({ userId, query: q, scope, sessionType, memoryType, tokenMode, includeStale, limit });
    const profile = BUDGET_PROFILES_BY_MODE[tokenMode] || BUDGET_PROFILES_BY_MODE["core"];
    const items = rawItems.map(item => shapeItemForProfile(item, profile));
    res.json({
      layer: 2,
      tokenMode,
      query: q,
      items,
      budgetProfile: profile,
    });
  } catch (err) {
    logger.error(err, "Failed to search memory");
    res.status(500).json({ error: "Failed to search memory" });
  }
});

// ─── Governance: Layer 3 — memory get (full item, escalation required) ────────

router.get("/mem/item/:itemId", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const itemId = parseInt(req.params["itemId"], 10);
  if (isNaN(itemId)) {
    res.status(400).json({ error: "Invalid itemId" });
    return;
  }
  const tokenMode = validateTokenMode(req.query["tokenMode"] as string | undefined, res);
  if (tokenMode === null) return;
  const escalate = req.query["escalate"] === "true";

  try {
    const item = memoryGet({ userId, itemId, tokenMode, escalate });
    if (!item) {
      const profile = BUDGET_PROFILES_BY_MODE[tokenMode] || BUDGET_PROFILES_BY_MODE["core"];
      if (profile.memoryLayerAccess < 3 && !escalate) {
        res.status(403).json({ error: "Layer 3 access requires escalation in this token mode. Pass escalate=true." });
      } else {
        res.status(404).json({ error: "Memory item not found" });
      }
      return;
    }
    res.json({ layer: 3, item });
  } catch (err) {
    logger.error(err, "Failed to get memory item");
    res.status(500).json({ error: "Failed to get memory item" });
  }
});

// ─── Governance: Save item with contradiction check ───────────────────────────

router.post("/mem/item", async (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const {
    userId,
    sessionId,
    sessionType,
    memoryType,
    scope,
    content,
    symbolRef,
    symbolContentHash,
    metadata,
  } = req.body as {
    userId: string;
    sessionId?: string;
    /** "team" | "solo" — drives default scope resolution when scope is not provided. */
    sessionType?: string;
    memoryType?: MemoryType;
    scope?: MemoryScope;
    content: string;
    symbolRef?: string;
    symbolContentHash?: string;
    metadata?: Record<string, unknown>;
  };

  if (!userId || !content) {
    res.status(400).json({ error: "userId and content are required" });
    return;
  }

  const VALID_MEMORY_TYPES_SAVE: MemoryType[] = ["observation", "research", "session_summary", "convention", "guardrail", "note", "warning"];
  // Validate scope if provided
  if (scope !== undefined && !SCOPE_PRIORITY.includes(scope as MemoryScope)) {
    res.status(400).json({ error: `Invalid scope. Must be one of: ${SCOPE_PRIORITY.join(", ")}` });
    return;
  }
  // Validate memoryType if provided
  if (memoryType !== undefined && !VALID_MEMORY_TYPES_SAVE.includes(memoryType as MemoryType)) {
    res.status(400).json({ error: `Invalid memoryType. Must be one of: ${VALID_MEMORY_TYPES_SAVE.join(", ")}` });
    return;
  }
  // Validate sessionType if provided
  const validatedSessionType = validateSessionType(sessionType, res);
  if (validatedSessionType === null) return;

  const resolvedScope: MemoryScope | undefined = scope as MemoryScope | undefined;
  const resolvedType: MemoryType = (memoryType as MemoryType) || "observation";

  try {
    const result = await saveMemoryItem({
      userId,
      sessionId,
      sessionType: validatedSessionType ?? undefined,
      memoryType: resolvedType,
      scope: resolvedScope,
      content,
      symbolRef,
      symbolContentHash,
      metadata,
    });
    res.status(201).json({
      itemId: result.itemId,
      conflictGroupId: result.conflictGroupId,
      contradictionCount: result.contradictions.length,
      contradictionIds: result.contradictions,
      hasConflict: result.contradictions.length > 0,
    });
  } catch (err) {
    logger.error(err, "Failed to save memory item");
    res.status(500).json({ error: "Failed to save memory item" });
  }
});

// ─── Governance: Inject tracking ─────────────────────────────────────────────

router.post("/mem/injected", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { userId, itemIds } = req.body as { userId: string; itemIds: number[] };
  if (!userId || typeof userId !== "string") {
    res.status(400).json({ error: "userId string required" });
    return;
  }
  if (!Array.isArray(itemIds)) {
    res.status(400).json({ error: "itemIds array required" });
    return;
  }
  try {
    markItemInjected(userId, itemIds);
    res.json({ success: true });
  } catch (err) {
    logger.error(err, "Failed to mark items injected");
    res.status(500).json({ error: "Failed to mark items injected" });
  }
});

// ─── Governance: Symbol staleness ────────────────────────────────────────────

router.post("/mem/symbol-stale", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { userId, symbolRef, newContentHash } = req.body as { userId: string; symbolRef: string; newContentHash: string };
  if (!userId || !symbolRef || !newContentHash) {
    res.status(400).json({ error: "userId, symbolRef, and newContentHash are required" });
    return;
  }
  try {
    const count = markSymbolStale(userId, symbolRef, newContentHash);
    res.json({ ok: true, markedStale: count });
  } catch (err) {
    logger.error(err, "Failed to mark symbol stale");
    res.status(500).json({ error: "Failed to mark symbol stale" });
  }
});

// ─── Governance: Conflicts ────────────────────────────────────────────────────

router.get("/mem/conflicts", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const VALID_CONFLICT_STATUSES: ConflictStatus[] = ["none", "open", "reviewed", "resolved", "accepted_override"];
  const rawConflictStatus = req.query["conflictStatus"] as string | undefined;
  if (rawConflictStatus && !VALID_CONFLICT_STATUSES.includes(rawConflictStatus as ConflictStatus)) {
    res.status(400).json({ error: `Invalid conflictStatus. Must be one of: ${VALID_CONFLICT_STATUSES.join(", ")}` });
    return;
  }
  const conflictStatus = (rawConflictStatus as ConflictStatus) || "open";
  const limit = Math.min(parseInt(String(req.query["limit"] || "20"), 10), 100);
  const offset = parseInt(String(req.query["offset"] || "0"), 10);
  try {
    const conflicts = listConflicts({ userId, conflictStatus, limit, offset });
    res.json({ conflicts });
  } catch (err) {
    logger.error(err, "Failed to list conflicts");
    res.status(500).json({ error: "Failed to list conflicts" });
  }
});

router.patch("/mem/conflicts/:groupId", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const groupId = parseInt(req.params["groupId"], 10);
  if (isNaN(groupId)) {
    res.status(400).json({ error: "Invalid groupId" });
    return;
  }
  const { conflictStatus } = req.body as { conflictStatus: ConflictStatus };
  const VALID_STATUSES: ConflictStatus[] = ["open", "reviewed", "resolved", "accepted_override"];
  if (!VALID_STATUSES.includes(conflictStatus)) {
    res.status(400).json({ error: `conflictStatus must be one of: ${VALID_STATUSES.join(", ")}` });
    return;
  }
  try {
    const updated = updateConflictStatus({ userId, conflictGroupId: groupId, conflictStatus });
    if (!updated) {
      res.status(404).json({ error: "Conflict group not found" });
      return;
    }
    res.json({ success: true, conflictGroupId: groupId, conflictStatus });
  } catch (err) {
    logger.error(err, "Failed to update conflict status");
    res.status(500).json({ error: "Failed to update conflict status" });
  }
});

// ─── Governance: Stale items ──────────────────────────────────────────────────

router.get("/mem/stale", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const limit = Math.min(parseInt(String(req.query["limit"] || "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] || "0"), 10);
  try {
    const items = listStaleItems({ userId, limit, offset });
    res.json({ items, count: items.length });
  } catch (err) {
    logger.error(err, "Failed to list stale items");
    res.status(500).json({ error: "Failed to list stale items" });
  }
});

// ─── Governance: Promotion history ───────────────────────────────────────────

router.get("/mem/promotions", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const itemId = req.query["itemId"] ? parseInt(String(req.query["itemId"]), 10) : undefined;
  const limit = Math.min(parseInt(String(req.query["limit"] || "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] || "0"), 10);
  try {
    const history = getPromotionHistory({ userId, itemId, limit, offset });
    res.json({ history });
  } catch (err) {
    logger.error(err, "Failed to get promotion history");
    res.status(500).json({ error: "Failed to get promotion history" });
  }
});

// ─── Governance: Reversible promotion ────────────────────────────────────────

router.patch("/mem/item/:itemId/promote", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const itemId = parseInt(req.params["itemId"], 10);
  if (isNaN(itemId)) {
    res.status(400).json({ error: "Invalid itemId" });
    return;
  }
  const { promotionStatus, notes } = req.body as { promotionStatus: PromotionStatus; notes?: string };
  const VALID_STATUSES: PromotionStatus[] = ["none", "candidate", "promoted", "demoted"];
  if (!VALID_STATUSES.includes(promotionStatus)) {
    res.status(400).json({ error: `promotionStatus must be one of: ${VALID_STATUSES.join(", ")}` });
    return;
  }
  try {
    const item = reversePromotion({ userId, itemId, promotionStatus, notes });
    if (!item) {
      res.status(404).json({ error: "Memory item not found" });
      return;
    }
    res.json({ success: true, item });
  } catch (err) {
    logger.error(err, "Failed to update promotion status");
    res.status(500).json({ error: "Failed to update promotion status" });
  }
});

// ─── Governance: Budget stats ─────────────────────────────────────────────────

router.get("/mem/stats", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const tokenMode = validateTokenMode(req.query["tokenMode"] as string | undefined, res);
  if (tokenMode === null) return;
  try {
    const stats = getGovernanceStats({ userId, tokenMode });
    res.json(stats);
  } catch (err) {
    logger.error(err, "Failed to get governance stats");
    res.status(500).json({ error: "Failed to get governance stats" });
  }
});

// ─── Governance: List items (general browsing) ────────────────────────────────

router.get("/mem/items", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId query param required" });
    return;
  }
  const VALID_MEM_TYPES_LIST: MemoryType[] = ["observation", "research", "session_summary", "convention", "guardrail", "note", "warning"];
  const rawScopeList = req.query["scope"] as string | undefined;
  const scope = rawScopeList && SCOPE_PRIORITY.includes(rawScopeList as MemoryScope)
    ? (rawScopeList as MemoryScope)
    : undefined;
  if (rawScopeList && !scope) {
    res.status(400).json({ error: `Invalid scope. Must be one of: ${SCOPE_PRIORITY.join(", ")}` });
    return;
  }
  const rawMemoryTypeList = req.query["memoryType"] as string | undefined;
  const memoryType = rawMemoryTypeList && VALID_MEM_TYPES_LIST.includes(rawMemoryTypeList as MemoryType)
    ? (rawMemoryTypeList as MemoryType)
    : undefined;
  if (rawMemoryTypeList && !memoryType) {
    res.status(400).json({ error: `Invalid memoryType. Must be one of: ${VALID_MEM_TYPES_LIST.join(", ")}` });
    return;
  }
  const limit = Math.min(parseInt(String(req.query["limit"] || "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] || "0"), 10);

  try {
    const items = listMemoryItems({ userId, scope, memoryType, limit, offset });
    res.json({ items });
  } catch (err) {
    logger.error(err, "Failed to list memory items");
    res.status(500).json({ error: "Failed to list memory items" });
  }
});

// ─── Passive Semantic Recall (Task #225) ─────────────────────────────────────

/**
 * Record a conversation turn and (optionally) run the recall pipeline
 * synchronously. The recall pass is fire-and-forget by default so the runner
 * never blocks on it; pass ?awaitRecall=1 to wait for the audit shortlist
 * (useful for tests).
 */
router.post("/mem/turn", async (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { sessionId, userId, role, content, scopes } = req.body as {
    sessionId: string; userId: string; role: string; content: string; scopes?: string[];
  };
  if (!sessionId || !userId || !role || !content) {
    res.status(400).json({ error: "sessionId, userId, role, content are required" });
    return;
  }
  const awaitRecall = req.query["awaitRecall"] === "1";
  try {
    const { turnId } = await recordTurn({ sessionId, userId, role, content });
    if (!isPassiveRecallEnabled(sessionId)) {
      res.json({ ok: true, turnId, passiveRecallEnabled: false });
      return;
    }
    if (awaitRecall) {
      const audit = await runPassiveRecallForTurn({ turnId, sessionId, userId, scopes });
      res.json({ ok: true, turnId, passiveRecallEnabled: true, audit });
      return;
    }
    // Fire-and-forget so turn N+1 prompt assembly is not blocked.
    void runPassiveRecallForTurn({ turnId, sessionId, userId, scopes }).catch((err) => {
      logger.warn({ err, turnId }, "[mem] passive recall pipeline failed");
    });
    res.json({ ok: true, turnId, passiveRecallEnabled: true });
  } catch (err) {
    logger.error(err, "Failed to record turn");
    res.status(500).json({ error: "Failed to record turn" });
  }
});

/** Return the verified recall shortlist for the latest audited turn. */
router.get("/mem/recall", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const sessionId = req.query["sessionId"] as string | undefined;
  const userId = req.query["userId"] as string | undefined;
  const limit = Math.min(parseInt(String(req.query["limit"] || "8"), 10), 50);
  if (!sessionId || !userId) {
    res.status(400).json({ error: "sessionId and userId are required" });
    return;
  }
  if (!isPassiveRecallEnabled(sessionId)) {
    res.json({ turnId: null, items: [], shortlist: [], enabled: false });
    return;
  }
  try {
    const shortlist = getLatestRecallShortlist({ sessionId, userId, limit });
    // Contract for the Rust runtime client (mem_client.rs::fetch_recall):
    // it expects `{ turnId, items: [{ itemId, content }] }`. We also keep the
    // richer `shortlist` array for dashboard / debugging consumers.
    const turnId = shortlist.length > 0 ? shortlist[0].turnId : null;
    const items = shortlist.map(s => ({ itemId: s.itemId, content: s.content }));
    res.json({ turnId, items, shortlist, enabled: true });
  } catch (err) {
    logger.error(err, "Failed to get recall shortlist");
    res.status(500).json({ error: "Failed to get recall shortlist" });
  }
});

/** Mark recall-audit rows as injected (idempotent). */
router.post("/mem/recall/inject", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { turnId, itemIds } = req.body as { turnId: number; itemIds: number[] };
  if (!turnId || !Array.isArray(itemIds)) {
    res.status(400).json({ error: "turnId and itemIds[] are required" });
    return;
  }
  try {
    const updated = markRecallInjected(turnId, itemIds);
    res.json({ ok: true, updated });
  } catch (err) {
    logger.error(err, "Failed to mark recall injected");
    res.status(500).json({ error: "Failed to mark injected" });
  }
});

/** Manual edge create. */
router.post("/mem/edges", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { srcItemId, dstItemId, edgeType, weight } = req.body as {
    srcItemId: number; dstItemId: number; edgeType: EdgeType; weight?: number;
  };
  if (!srcItemId || !dstItemId || !edgeType) {
    res.status(400).json({ error: "srcItemId, dstItemId, edgeType are required" });
    return;
  }
  if (!VALID_EDGE_TYPES.includes(edgeType)) {
    res.status(400).json({ error: `edgeType must be one of: ${VALID_EDGE_TYPES.join(", ")}` });
    return;
  }
  try {
    const result = recordEdge({ srcItemId, dstItemId, edgeType, weight });
    if (!result) {
      res.status(400).json({ error: "Edge could not be created (self-loop or constraint failure)" });
      return;
    }
    res.json({ ok: true, id: result.id });
  } catch (err) {
    logger.error(err, "Failed to record edge");
    res.status(500).json({ error: "Failed to record edge" });
  }
});

/** List edges incident to a memory item. */
router.get("/mem/edges/:itemId", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const itemId = parseInt(req.params["itemId"], 10);
  if (isNaN(itemId)) {
    res.status(400).json({ error: "Invalid itemId" });
    return;
  }
  try {
    const edges = listEdges(itemId);
    res.json({ edges });
  } catch (err) {
    logger.error(err, "Failed to list edges");
    res.status(500).json({ error: "Failed to list edges" });
  }
});

/** Per-session feature flag override. */
router.post("/mem/passive-config", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const { sessionId, enabled } = req.body as { sessionId: string; enabled: boolean };
  if (!sessionId || typeof enabled !== "boolean") {
    res.status(400).json({ error: "sessionId and enabled (boolean) are required" });
    return;
  }
  try {
    setPassiveRecallForSession(sessionId, enabled);
    res.json({ ok: true, sessionId, enabled, globalDefault: passiveRecallGloballyEnabled() });
  } catch (err) {
    logger.error(err, "Failed to update passive-recall config");
    res.status(500).json({ error: "Failed to update config" });
  }
});

/** Dashboard audit trail. */
router.get("/mem/recall/audit", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  const sessionId = req.query["sessionId"] as string | undefined;
  const limit = Math.min(parseInt(String(req.query["limit"] || "50"), 10), 200);
  const offset = parseInt(String(req.query["offset"] || "0"), 10);
  try {
    const entries = listRecallAudit({ userId, sessionId, limit, offset });
    res.json({ entries });
  } catch (err) {
    logger.error(err, "Failed to list recall audit");
    res.status(500).json({ error: "Failed to list audit" });
  }
});

router.get("/mem/recall/metrics", (req, res) => {
  if (!verifyMemToken(req, res)) return;
  const userId = req.query["userId"] as string | undefined;
  if (!userId) {
    res.status(400).json({ error: "userId is required" });
    return;
  }
  try {
    res.json(getRecallMetrics(userId));
  } catch (err) {
    logger.error(err, "Failed to get recall metrics");
    res.status(500).json({ error: "Failed to get metrics" });
  }
});

export default router;
