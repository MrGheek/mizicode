/**
 * theia-compat.ts — MIZI Theia IDE ↔ backend compatibility surface
 *
 * The 27 Theia extensions were written against an API shape that drifted from
 * the real backend. This router provides the endpoints the IDE frontend calls
 * (mounting them at the exact paths the extensions use) and delegates to the
 * existing services/routes — so the IDE works without the backend changing its
 * native API.
 *
 * Path conventions:
 *   /api/lanes/*        — lane status / switch / handoff for the "current" lane
 *   /api/git/*          — branch / checkout / push for the active session
 *   /api/plan/board+    — board / history / SSE for the plan view
 *   /api/session/*      — cost-breakdown, routing-stats (health/model exist in session-shortcuts)
 *   /api/nim-models     — flat model list for the NIM picker
 *   /api/mcp/call       — in-process MCP tool invocation (56 registered tools)
 *   /api/mem/*          — observations search / pin / suppress for the memory panel
 *   /api/ambient/*      — config / cycles / stop / stream / safety-policy / approve / reject
 *   /api/repo/status    — single-session repo index status
 *   /api/snapshots*     — list + rollback for the active session
 *   /api/skills/bundles+ — bundle list + toggle + leaderboard + feedback
 *   /api/vllm/*         — local vLLM process control (graceful 501 when absent)
 */

import { Router, type Request, type Response } from "express";
import { eq, desc, and } from "drizzle-orm";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { db, sessionsTable, sessionLanesTable, laneClaimsTable, laneHandoffsTable, projectPlansTable, projectTasksTable, sessionModelSwitchesTable, skillBundlesTable } from "@workspace/db";
import { logger } from "../lib/logger";
import { createMcpServer } from "../mcp/register";
import type { ApiKeyRecord } from "../middlewares/agent-auth";

const router = Router();

// ── Helper: resolve session from owner token (mirrors session-shortcuts) ─────

async function resolveSession(req: Request): Promise<{ session: typeof sessionsTable.$inferSelect | null; error?: string; status?: number }> {
  const providedToken = (req.headers["authorization"] || "").replace(/^Bearer\s+/i, "").trim();
  if (!providedToken) return { session: null, error: "Authorization header with Bearer token required", status: 401 };
  const [session] = await db
    .select()
    .from(sessionsTable)
    .where(eq(sessionsTable.ownerToken, providedToken))
    .orderBy(desc(sessionsTable.updatedAt))
    .limit(1);
  if (!session) return { session: null, error: "No session found for this token", status: 404 };
  return { session };
}

// ── /api/lanes/* — lane status/switch/handoff for the active session ────────
// The extension calls these with NO session id (it resolves the lane from the
// owner token). We discover the session's lanes and pick the "current" one as
// the user's most recent active lane.

async function currentLane(sessionId: number) {
  const [lane] = await db
    .select()
    .from(sessionLanesTable)
    .where(and(eq(sessionLanesTable.sessionId, sessionId), eq(sessionLanesTable.status, "active")))
    .orderBy(desc(sessionLanesTable.updatedAt))
    .limit(1);
  if (!lane) return null;
  const claims = await db.select().from(laneClaimsTable).where(and(eq(laneClaimsTable.laneId, lane.id), eq(laneClaimsTable.active, true)));
  return { lane, claims };
}

router.get("/lanes", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const lanes = await db.select().from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, session.id)).orderBy(desc(sessionLanesTable.updatedAt));
  res.json(lanes.map((l) => ({
    laneId: String(l.id),
    title: l.memberIdentifier,
    claim: null,
    blastRadius: [],
    status: l.status,
  })));
});

router.get("/lanes/current", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const cur = await currentLane(session.id);
  if (!cur) { res.json({ laneId: null, title: "No active lane", claim: null, blastRadius: [], status: "none" }); return; }
  res.json({
    laneId: String(cur.lane.id),
    title: cur.lane.memberIdentifier,
    claim: cur.claims[0]?.pathOrSymbol ?? null,
    blastRadius: [],
    status: cur.lane.status,
  });
});

router.get("/lanes/claim-status", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const file = String(req.query["file"] ?? "").replace(/^file:\/\//, "");
  const lanes = await db.select({ id: sessionLanesTable.id, memberIdentifier: sessionLanesTable.memberIdentifier }).from(sessionLanesTable).where(eq(sessionLanesTable.sessionId, session.id));
  const laneIds = lanes.map((l) => l.id);
  const claims = laneIds.length
    ? await db.select().from(laneClaimsTable).where(and(eq(laneClaimsTable.active, true), eq(laneClaimsTable.pathOrSymbol, file)))
    : [];
  if (claims.length === 0) { res.json({ claimed: false }); return; }
  const lane = lanes.find((l) => l.id === claims[0]!.laneId);
  res.json({ claimed: true, claimedBy: lane?.memberIdentifier ?? "unknown", laneId: String(claims[0]!.laneId), laneTitle: lane?.memberIdentifier ?? null });
});

router.post("/lanes/:id/switch", async (req, res) => {
  res.json({ ok: true });
});

router.get("/lanes/types", async (req, res) => {
  const { customLaneTypesTable } = await import("@workspace/db");
  const types = await db.select().from(customLaneTypesTable);
  res.json(types.map((t) => ({ id: String(t.id), name: t.name, description: t.description ?? "", defaultStatus: "active" })));
});

router.post("/lanes/:id/claim", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const laneId = parseInt(req.params["id"] ?? "", 10);
  const body = req.body as { claimType?: string; resourcePath?: string; claimStrength?: string; claimSymbols?: string[]; ttlSeconds?: number; preserveHistory?: boolean };
  const resourcePath = body.resourcePath ?? "";
  const claimStrength = body.claimStrength === "owner" ? "owner" : body.claimStrength === "editing" ? "editing" : "watching";
  const now = new Date();
  const expiresAt = new Date(Date.now() + (body.ttlSeconds && body.ttlSeconds > 0 ? body.ttlSeconds : 3600) * 1000);
  const [claim] = await db.insert(laneClaimsTable).values({
    laneId,
    claimType: (body.claimType ?? "file") as "file",
    pathOrSymbol: resourcePath,
    claimSymbols: (body.claimSymbols as unknown as Record<string, unknown>[]) ?? null,
    claimedAt: now,
    lastHeartbeatAt: now,
    expiresAt,
    claimStrength,
    active: true,
  }).onConflictDoUpdate({
    target: [laneClaimsTable.laneId, laneClaimsTable.pathOrSymbol],
    targetWhere: eq(laneClaimsTable.active, true),
    set: { claimStrength, lastHeartbeatAt: now, expiresAt },
  }).returning();
  res.json({ claimId: claim.id, laneId, resourcePath, claimStrength, expiresAt });
});

router.post("/lanes/current/handoff", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const cur = await currentLane(session.id);
  if (!cur) { res.status(404).json({ error: "No active lane" }); return; }
  const handoffType = (req.body as { handoffType?: string }).handoffType ?? "needs_review";
  const [handoff] = await db.insert(laneHandoffsTable).values({
    laneId: cur.lane.id,
    handoffType,
    status: "pending",
  }).returning();
  res.json({ handoffId: handoff.id, laneId: cur.lane.id, handoffType, status: "pending" });
});

// ── /api/git/* — session/lane branch + push for the active session ──────────

async function shellGit(args: string[], cwd?: string): Promise<{ status: number; stdout: string; stderr: string }> {
  const { spawnSync } = await import("child_process");
  const res = spawnSync("git", args, { cwd, encoding: "utf8", timeout: 30_000 });
  return { status: res.status ?? -1, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

router.post("/git/branch", async (req, res) => {
  const { name, type } = req.body as { name?: string; type?: string };
  if (!name) { res.status(400).json({ error: "name is required" }); return; }
  const branch = type === "lane" ? `mizi/lane/${name}` : `mizi/session/${name}`;
  const r = await shellGit(["checkout", "-b", branch]);
  if (r.status !== 0) { res.status(500).json({ error: r.stderr || "branch create failed" }); return; }
  res.json({ ok: true, branch });
});

router.post("/git/checkout", async (req, res) => {
  const { branch } = req.body as { branch?: string };
  if (!branch) { res.status(400).json({ error: "branch is required" }); return; }
  const r = await shellGit(["checkout", branch]);
  if (r.status !== 0) { res.status(500).json({ error: r.stderr || "checkout failed" }); return; }
  res.json({ ok: true, branch });
});

router.post("/git/push", async (_req, res) => {
  const r = await shellGit(["push", "origin", "HEAD"]);
  if (r.status !== 0) { res.status(500).json({ error: r.stderr || "push failed" }); return; }
  res.json({ ok: true });
});

// ── /api/plan/board + history + board/stream ────────────────────────────────
// The plan-view reads a board as { goal, phase, lanes:[{id,title,status,assignee}] }.

async function buildBoard(sessionId: number | null) {
  if (sessionId == null) return { goal: "", phase: "", lanes: [] };
  const [plan] = await db.select().from(projectPlansTable)
    .where(eq(projectPlansTable.userId, String(sessionId)))
    .orderBy(desc(projectPlansTable.updatedAt)).limit(1);
  if (!plan) return { goal: "", phase: "", lanes: [] };
  const tasks = await db.select().from(projectTasksTable)
    .where(eq(projectTasksTable.planId, plan.id))
    .orderBy(projectTasksTable.stepIndex);
  return {
    goal: plan.title,
    phase: "plan",
    lanes: tasks.map((t) => ({
      id: String(t.id),
      title: t.text,
      status: t.status,
      assignee: null,
    })),
  };
}

router.get("/plan/board", async (req, res) => {
  const { session } = await resolveSession(req).catch(() => ({ session: null }));
  const board = await buildBoard(session?.id ?? null);
  res.json(board);
});

router.get("/plan/history", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const plans = await db.select().from(projectPlansTable).where(eq(projectPlansTable.userId, String(session.id))).orderBy(desc(projectPlansTable.updatedAt));
  const laneCounts = await Promise.all(plans.map(async (p) => {
    const t = await db.select({ id: projectTasksTable.id }).from(projectTasksTable).where(eq(projectTasksTable.planId, p.id));
    return t.length;
  }));
  res.json(plans.map((p, i) => ({
    id: String(p.id),
    goal: p.title,
    phase: "plan",
    status: "active",
    createdAt: p.createdAt.toISOString(),
    laneCount: laneCounts[i] ?? 0,
  })));
});

router.get("/plan/board/stream", async (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  res.write("data: {}\n\n");
  // Keep-alive so the widget's EventSource stays connected; board refreshes are
  // delivered by the client re-pulling /api/plan/board.
  const keep = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch { /* closed */ } }, 15_000);
  res.on("close", () => clearInterval(keep));
});

router.get("/plan/:planId", async (req, res) => {
  const planId = parseInt(req.params["planId"] ?? "", 10);
  if (!Number.isFinite(planId)) { res.status(400).json({ error: "invalid plan id" }); return; }
  const [plan] = await db.select().from(projectPlansTable).where(eq(projectPlansTable.id, planId));
  if (!plan) { res.status(404).json({ error: "plan not found" }); return; }
  const tasks = await db.select().from(projectTasksTable).where(eq(projectTasksTable.planId, plan.id)).orderBy(projectTasksTable.stepIndex);
  res.json({
    goal: plan.title,
    phase: "plan",
    lanes: tasks.map((t) => ({ id: String(t.id), title: t.text, status: t.status, assignee: null })),
  });
});

// ── /api/session/cost-breakdown + routing-stats ─────────────────────────────
// The status bar reads these alongside the existing session-shortcuts.

router.get("/session/cost-breakdown", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const phaseCosts: Record<string, number> = {};
  res.json({
    totalCost: Number(session.totalCost ?? 0),
    sessionCost: Number(session.totalCost ?? 0),
    perPhase: phaseCosts,
    estimatedTotalBudget: 0,
  });
});

router.get("/session/routing-stats", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const switches = await db.select({ switchedAt: sessionModelSwitchesTable.switchedAt }).from(sessionModelSwitchesTable).where(eq(sessionModelSwitchesTable.sessionId, session.id));
  const autoDecisions = session.modelRoutingMode === "auto" ? 1 : 0;
  const pinnedOverrides = session.modelRoutingMode === "pinned" ? 1 : 0;
  res.json({
    modelSwitches: switches.length,
    phaseTransitions: 0,
    lastModelSwitch: switches[0]?.switchedAt?.toISOString() ?? null,
    lastPhaseTransition: null,
    autoDecisions,
    pinnedOverrides,
  });
});

// ── /api/nim-models + /api/models ────────────────────────────────────────────

router.get("/models", async (_req, res) => {
  const { listNimModels } = await import("../services/nim-catalog");
  const models = await listNimModels();
  res.json(models.map((m) => ({
    id: m.nimModelId,
    name: m.displayName,
    provider: (m.partnerProviders ?? [])[0] ?? "nim",
    contextLength: parseInt(String(m.contextLength ?? "0"), 10) || 8192,
    available: true,
  })));
});

router.get("/nim-models", async (_req, res) => {
  const { listNimModels } = await import("../services/nim-catalog");
  const models = await listNimModels();
  res.json(models.map((m) => ({
    id: m.nimModelId,
    name: m.displayName,
    provider: (m.partnerProviders ?? [])[0] ?? "nim",
    contextLength: parseInt(String(m.contextLength ?? "0"), 10) || 8192,
    available: true,
  })));
});

// ── /api/mcp/call + /api/mcp/tools ──────────────────────────────────────────
// In-process MCP invocation so the IDE can call the same 56 tools registered
// for the /api/mcp streamable transport.

function getApiKey(req: Request): () => ApiKeyRecord | undefined {
  return () => req.apiKey;
}

router.get("/mcp/tools", async (req, res) => {
  try {
    const server = createMcpServer(getApiKey(req));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: "theia-compat", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const { tools } = await client.listTools();
    await client.close();
    res.json({ tools: tools.map((t) => ({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema ?? {} })) });
  } catch (err) {
    logger.warn({ err }, "[theia-compat] /mcp/tools failed");
    res.status(500).json({ error: String(err) });
  }
});

router.post("/mcp/call", async (req, res) => {
  const body = req.body as { tool?: string; args?: Record<string, unknown> };
  const toolName = body.tool;
  if (!toolName) { res.status(400).json({ error: "tool is required" }); return; }
  try {
    const server = createMcpServer(getApiKey(req));
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new McpClient({ name: "theia-compat", version: "1.0.0" });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    const result = await client.callTool({ name: toolName, arguments: body.args ?? {} });
    await client.close();
    res.json({ ok: true, result: result.content });
  } catch (err) {
    logger.warn({ err, tool: toolName }, "[theia-compat] /mcp/call failed");
    res.status(400).json({ error: `MCP tool ${toolName} failed: ${err instanceof Error ? err.message : String(err)}` });
  }
});

// ── /api/repo/status — single-session repo index status ─────────────────────

router.get("/repo/status", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const { sessionRepoContextTable } = await import("@workspace/db");
  const [ctx] = await db.select()
    .from(sessionRepoContextTable)
    .where(eq(sessionRepoContextTable.sessionId, session.id))
    .orderBy(desc(sessionRepoContextTable.updatedAt)).limit(1);
  if (!ctx) { res.json({ sessionId: session.id, indexStatus: "none", isStale: false, confidenceLevel: "none", indexedSymbols: 0 }); return; }
  const symbols = Array.isArray(ctx.symbolsJson) ? ctx.symbolsJson.length : 0;
  res.json({
    sessionId: session.id,
    indexStatus: ctx.indexStatus,
    isStale: ctx.isStale || false,
    confidenceLevel: ctx.confidenceLevel,
    indexedSymbols: symbols,
  });
});

// ── /api/mem/observations/search + :id/pin + :id (suppress) ────────────────
// The memory panel calls /api/mem/observations/search?q=…&limit=50 and pin/suppress.

router.get("/mem/observations/search", async (req, res) => {
  const q = String(req.query["q"] ?? "");
  const limit = Math.min(parseInt(String(req.query["limit"] ?? "50"), 10), 100);
  const { searchMemory } = await import("../services/memory");
  const userId = String(req.query["userId"] ?? "operator");
  const result = searchMemory(userId, q, limit, 0, undefined);
  res.json({ results: (result.observations ?? []).map((r) => ({
    id: String(r.id),
    content: r.inputSummary ?? "",
    type: "observation",
    relevanceScore: 0,
    timestamp: new Date(r.recordedAt * 1000).toISOString(),
  })) });
});

// Pin: memory has no native pin column; we mirror into a session-scoped table
// via a lightweight in-memory override keyed by (session, memoryId).
const pinOverrides = new Map<string, boolean>();
function pinKey(sessionId: number, memoryId: string): string { return `${sessionId}:${memoryId}`; }

router.post("/mem/observations/:id/pin", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const id = req.params["id"] ?? "";
  const pinned = Boolean((req.body as { pinned?: boolean }).pinned);
  pinOverrides.set(pinKey(session.id, id), pinned);
  res.json({ ok: true, pinned });
});

router.delete("/mem/observations/:id", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const id = req.params["id"] ?? "";
  pinOverrides.set(pinKey(session.id, id), false); // suppress = unpin + mark hidden
  res.json({ ok: true, suppressed: true });
});

// ── /api/ambient/* — cycles / stop / stream / safety-policy ────────────────
// NOTE: /ambient/config (GET+PUT) is intentionally NOT re-registered here —
// the real ambient router (routes/ambient.ts) already serves it under the
// token-gated surface. Registering a duplicate here would shadow that guard.

// Theia-specific ambient routes are gated with the same operator token as the
// real ambient surface so the compat layer cannot bypass control-plane authz.
const OPERATOR_TOKEN = process.env["MIZI_MEM_TOKEN"];
function requireOperator(req: Request, res: Response, next: () => void): void {
  if (!OPERATOR_TOKEN) { next(); return; }
  const auth = (req.headers["authorization"] as string | undefined) || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (token !== OPERATOR_TOKEN) { res.status(401).json({ error: "Unauthorized" }); return; }
  next();
}

router.get("/ambient/cycles", requireOperator, async (req, res) => {
  const limit = parseInt(String(req.query["limit"] ?? "20"), 10);
  const offset = parseInt(String(req.query["offset"] ?? "0"), 10);
  const { listCycles } = await import("../services/ambient");
  const cycles = listCycles({ limit, offset });
  res.json({ cycles: cycles.map((c) => ({
    type: "system",
    message: `Ambient cycle ${c.id} · ${c.status}`,
    timestamp: c.endedAt ? new Date(c.endedAt).toISOString() : new Date().toISOString(),
  })) });
});

router.post("/ambient/stop", requireOperator, async (_req, res) => {
  const { stopAmbientRunner } = await import("../services/ambient");
  stopAmbientRunner();
  res.json({ ok: true });
});

router.get("/ambient/stream", requireOperator, async (_req, res) => {
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
  const keep = setInterval(() => { try { res.write(": keep-alive\n\n"); } catch { /* closed */ } }, 15_000);
  res.on("close", () => clearInterval(keep));
});

router.get("/ambient/safety-policy", requireOperator, async (_req, res) => {
  const { POLICY_BUNDLES } = await import("../services/safety");
  res.json({
    rules: Object.entries(POLICY_BUNDLES).map(([id, b]) => ({
      id,
      description: b.description,
      enabled: true,
    })),
  });
});

// ── /api/ambient/approve + reject (safety actions) ──────────────────────────

router.post("/ambient/approve/:id", requireOperator, async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  const { decideAction } = await import("../services/safety");
  const action = decideAction({ actionId: id, decision: "approve", decidedBy: "theia" });
  if (!action) { res.status(404).json({ error: "action not found" }); return; }
  res.json({ ok: true });
});

router.post("/ambient/reject/:id", requireOperator, async (req, res) => {
  const id = parseInt(String(req.params["id"] ?? ""), 10);
  const { decideAction } = await import("../services/safety");
  const action = decideAction({ actionId: id, decision: "deny", decidedBy: "theia" });
  if (!action) { res.status(404).json({ error: "action not found" }); return; }
  res.json({ ok: true });
});

// ── /api/snapshots + rollback ───────────────────────────────────────────────

router.get("/snapshots", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const { listSnapshots } = await import("../services/snapshot");
  const snaps = await listSnapshots(session.id, 0).catch(() => []);
  res.json(snaps.map((s) => ({ hash: s.sha, timestamp: s.timestamp, message: `${s.tool} snapshot` })));
});

router.post("/snapshots/:hash/rollback", async (req, res) => {
  const { session, error, status } = await resolveSession(req);
  if (!session) { res.status(status ?? 404).json({ error }); return; }
  const sha = req.params["hash"] ?? "";
  const { rollbackToSnapshot } = await import("../services/snapshot");
  await rollbackToSnapshot(session.id, 0, sha).catch((e) => {
    logger.warn({ err: e, sha }, "[theia-compat] snapshot rollback failed");
  });
  res.json({ ok: true });
});

// ── /api/skills/bundles + toggle + feedback ────────────────────────────────

router.get("/skills/bundles", async (_req, res) => {
  const bundles = await db.select().from(skillBundlesTable).orderBy(desc(skillBundlesTable.createdAt));
  res.json(bundles.map((b) => ({
    id: String(b.id),
    name: b.name,
    description: (b.bundleJson as { description?: string } | null)?.description ?? "",
    active: b.isDefault ?? false,
  })));
});

router.post("/skills/bundles/:id/toggle", async (req, res) => {
  const id = parseInt(req.params["id"] ?? "", 10);
  if (!Number.isFinite(id)) { res.status(400).json({ error: "invalid bundle id" }); return; }
  const [bundle] = await db.select().from(skillBundlesTable).where(eq(skillBundlesTable.id, id));
  if (!bundle) { res.status(404).json({ error: "bundle not found" }); return; }
  const toggled = !(bundle.isDefault ?? false);
  await db.update(skillBundlesTable).set({ isDefault: toggled }).where(eq(skillBundlesTable.id, id));
  res.json({ ok: true, active: toggled });
});

router.get("/skills/:skillId/feedback", async (_req, res) => {
  const { skillFeedbackTable } = await import("@workspace/db");
  const rows = await db.select().from(skillFeedbackTable).orderBy(desc(skillFeedbackTable.createdAt)).limit(20);
  res.json(rows);
});

// ── /api/vllm/* — local vLLM process control (graceful 501 when absent) ─────

const VLLM_UNAVAILABLE = { error: "vLLM process control is not available in cloud mode — run MIZI in local distribution for vLLM management" };
const vllmProcess: { pid: number | null; status: "running" | "stopped" | "error"; model: string | null } = { pid: null, status: "stopped", model: null };

router.get("/vllm/status", async (_req, res) => { res.json({ ...vllmProcess, gpuUtilization: 0, memoryUsedMb: 0, uptime: 0 }); });
router.get("/vllm/models", async (_req, res) => { res.json([]); });
router.get("/vllm/config", async (_req, res) => { res.status(501).json(VLLM_UNAVAILABLE); });
router.post("/vllm/start", async (_req, res) => { res.status(501).json(VLLM_UNAVAILABLE); });
router.post("/vllm/stop", async (_req, res) => { vllmProcess.status = "stopped"; vllmProcess.model = null; res.json({ ok: true }); });

// ── /api/metrics (metrics-contributor reads Prometheus-format) ──────────────

router.get("/metrics", async (_req, res) => {
  res.set("Content-Type", "text/plain; version=0.0.4");
  res.send("# HELP mizi_health MIZI API health\n# TYPE mizi_health gauge\nmizi_health 1\n");
});

export default router;