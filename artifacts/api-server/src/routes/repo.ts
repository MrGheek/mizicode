import { Router } from "express";
import { db, repoGraphJobsTable, sessionRepoContextTable, sessionsTable } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { logger } from "../lib/logger";
import { markSymbolsStaleForSession } from "../services/memory";

export const batchRepoRouter = Router();

/**
 * Auto-enqueue a repo indexing job for a session that just became ready,
 * if no index or active job already exists.
 * Safe to call fire-and-forget; logs but never throws.
 * Uses the shared createRepoIndexJob helper to guarantee consistent DB behaviour
 * with the manual POST /sessions/:id/repo/index route.
 */
export async function autoEnqueueRepoIndexIfNeeded(sessionId: number): Promise<void> {
  try {
    const repoPath = DEFAULT_REPO_PATH;

    const activeJobs = await db
      .select({ id: repoGraphJobsTable.id })
      .from(repoGraphJobsTable)
      .where(
        and(
          eq(repoGraphJobsTable.sessionId, sessionId),
          inArray(repoGraphJobsTable.status, ACTIVE_JOB_STATUSES)
        )
      )
      .limit(1);

    if (activeJobs.length > 0) {
      logger.debug({ sessionId }, "Auto-index: active job already exists, skipping");
      return;
    }

    const existingCtx = await db
      .select({ id: sessionRepoContextTable.id, indexStatus: sessionRepoContextTable.indexStatus })
      .from(sessionRepoContextTable)
      .where(eq(sessionRepoContextTable.sessionId, sessionId))
      .orderBy(desc(sessionRepoContextTable.updatedAt))
      .limit(1);

    if (existingCtx.length > 0 && existingCtx[0].indexStatus !== "error") {
      logger.debug({ sessionId, indexStatus: existingCtx[0].indexStatus }, "Auto-index: repo context already exists, skipping");
      return;
    }

    const { jobId } = await createRepoIndexJob(sessionId, repoPath, null);

    logger.info({ sessionId, jobId, repoPath }, "Auto-index: repo indexing job enqueued on session ready");
  } catch (err) {
    logger.warn({ err, sessionId }, "Auto-index: failed to auto-enqueue repo indexing job (non-fatal)");
  }
}

batchRepoRouter.get("/status", async (req, res) => {
  const raw = (req.query["ids"] as string | undefined)?.trim() || "";
  if (!raw) {
    res.status(400).json({ error: "ids query parameter is required" });
    return;
  }

  const ids = raw
    .split(",")
    .map(s => Number(s.trim()))
    .filter(n => Number.isFinite(n) && n > 0);

  if (ids.length === 0) {
    res.status(400).json({ error: "No valid session IDs provided" });
    return;
  }

  if (ids.length > 100) {
    res.status(400).json({ error: "Too many IDs — maximum 100 per request" });
    return;
  }

  const rows = await db
    .select({
      sessionId: sessionRepoContextTable.sessionId,
      indexStatus: sessionRepoContextTable.indexStatus,
      isStale: sessionRepoContextTable.isStale,
      confidenceLevel: sessionRepoContextTable.confidenceLevel,
      updatedAt: sessionRepoContextTable.updatedAt,
    })
    .from(sessionRepoContextTable)
    .where(inArray(sessionRepoContextTable.sessionId, ids));

  const latestBySession = new Map<number, typeof rows[0]>();
  for (const row of rows) {
    const existing = latestBySession.get(row.sessionId);
    if (!existing || row.updatedAt > existing.updatedAt) {
      latestBySession.set(row.sessionId, row);
    }
  }

  const statusMap: Record<number, { indexStatus: string; isStale: boolean; confidenceLevel: string }> = {};
  for (const id of ids) {
    const row = latestBySession.get(id);
    if (row) {
      statusMap[id] = {
        indexStatus: row.indexStatus,
        isStale: row.isStale,
        confidenceLevel: row.confidenceLevel,
      };
    }
  }

  logger.debug({ ids, found: Object.keys(statusMap).length }, "Batch repo status");
  res.json({ statuses: statusMap });
});

const router = Router({ mergeParams: true });

const ACTIVE_JOB_STATUSES = ["queued", "scanning", "fingerprinting", "indexing_graph", "indexing_fts", "indexing_vectors", "summarizing"];

// Canonical token: server reads OMNIQL_MEM_TOKEN; instances receive it as OMNIQL_MEM_AUTH_TOKEN.
// Accept both to handle both server-side and direct instance-callback auth.
const CALLBACK_TOKEN = process.env["OMNIQL_MEM_TOKEN"] || process.env["OMNIQL_MEM_AUTH_TOKEN"] || "";

const DEFAULT_REPO_PATH = "/workspace/projects";
const IS_DEV = process.env.NODE_ENV === "development";

function getParam(req: import("express").Request, key: string): string {
  return (req.params as Record<string, string>)[key] ?? "";
}

/**
 * Validate Bearer token for internal callback endpoints (/sync, /jobs/pending).
 * Fail-closed: if CALLBACK_TOKEN is not configured, only allow in development mode.
 * This prevents unauthenticated access to callback endpoints in production.
 */
function validateAuth(req: import("express").Request): boolean {
  const auth = req.headers["authorization"] || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!CALLBACK_TOKEN) {
    // Fail-closed: no token configured → only allow in dev mode
    return IS_DEV;
  }
  return token === CALLBACK_TOKEN;
}

async function getSession(sessionId: number) {
  const [session] = await db.select().from(sessionsTable).where(eq(sessionsTable.id, sessionId));
  return session || null;
}

async function getRepoContext(sessionId: number) {
  const [ctx] = await db
    .select()
    .from(sessionRepoContextTable)
    .where(eq(sessionRepoContextTable.sessionId, sessionId))
    .orderBy(desc(sessionRepoContextTable.updatedAt))
    .limit(1);
  return ctx || null;
}

/**
 * Core repo-index enqueue logic shared by both the manual POST /index route
 * and the automatic session-ready trigger.
 *
 * Inserts a queued job row and upserts the session_repo_context row.
 * Returns the new job id and whether the existing context was stale.
 */
async function createRepoIndexJob(
  sessionId: number,
  repoPath: string,
  repoUrl?: string | null,
): Promise<{ jobId: number; isStale: boolean }> {
  const [newJob] = await db
    .insert(repoGraphJobsTable)
    .values({
      sessionId,
      repoPath,
      status: "queued",
      indexVersion: 1,
      lastRunAt: new Date(),
    })
    .returning();

  const ctx = await getRepoContext(sessionId);
  const isStale = ctx !== null && ctx.indexStatus === "ready";

  if (ctx) {
    await db
      .update(sessionRepoContextTable)
      .set({ indexStatus: "queued", isStale: true, updatedAt: new Date() })
      .where(eq(sessionRepoContextTable.id, ctx.id));
  } else {
    await db.insert(sessionRepoContextTable).values({
      sessionId,
      repoPath,
      repoUrl: repoUrl || null,
      indexStatus: "queued",
      isStale: false,
      confidenceLevel: "none",
    });
  }

  return { jobId: newJob.id, isStale };
}

router.post("/index", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const { repoPath: rawRepoPath, repoUrl } = (req.body || {}) as { repoPath?: string; repoUrl?: string };
  const repoPath = rawRepoPath?.trim() || DEFAULT_REPO_PATH;

  const activeJobs = await db
    .select()
    .from(repoGraphJobsTable)
    .where(
      and(
        eq(repoGraphJobsTable.sessionId, sessionId),
        eq(repoGraphJobsTable.repoPath, repoPath),
        inArray(repoGraphJobsTable.status, ACTIVE_JOB_STATUSES)
      )
    )
    .limit(1);

  if (activeJobs.length > 0) {
    const existing = activeJobs[0];
    logger.info({ sessionId, jobId: existing.id, status: existing.status, repoPath }, "Repo index: deduplicating — active job exists for this repoPath");
    res.status(202).json({
      jobId: existing.id,
      status: existing.status,
      isExisting: true,
      isStale: false,
    });
    return;
  }

  const { jobId, isStale } = await createRepoIndexJob(sessionId, repoPath, repoUrl);

  logger.info({ sessionId, jobId, repoPath }, "Repo index: job enqueued");
  res.status(202).json({
    jobId,
    status: "queued",
    isExisting: false,
    isStale,
  });
});

router.get("/fingerprint", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const ctx = await getRepoContext(sessionId);
  if (!ctx) {
    res.json({
      sessionId,
      indexStatus: "none",
      isStale: false,
      fingerprint: null,
      indexedAt: null,
    });
    return;
  }

  res.json({
    sessionId,
    indexStatus: ctx.indexStatus,
    isStale: ctx.isStale,
    fingerprint: ctx.fingerprintJson || null,
    indexedAt: ctx.indexedAt?.toISOString() || null,
  });
});

router.get("/summary", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const ctx = await getRepoContext(sessionId);
  if (!ctx) {
    res.json({
      sessionId,
      indexStatus: "none",
      isStale: false,
      confidenceLevel: "none",
      summary: null,
      indexedAt: null,
      symbolCount: 0,
      chunkCount: 0,
      fileCount: 0,
      repoPath: null,
    });
    return;
  }

  const symbolCount = Array.isArray(ctx.symbolsJson) ? (ctx.symbolsJson as unknown[]).length : 0;
  const chunkCount = Array.isArray(ctx.chunksJson) ? (ctx.chunksJson as unknown[]).length : 0;
  const fileCount = Array.isArray(ctx.filesJson) ? (ctx.filesJson as unknown[]).length : 0;

  res.json({
    sessionId,
    indexStatus: ctx.indexStatus,
    isStale: ctx.isStale,
    confidenceLevel: ctx.confidenceLevel,
    summary: ctx.summaryJson || null,
    indexedAt: ctx.indexedAt?.toISOString() || null,
    symbolCount,
    chunkCount,
    fileCount,
    repoPath: ctx.repoPath || null,
  });
});

router.get("/search", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const q = (req.query["q"] as string | undefined)?.trim() || "";
  const typeFilter = req.query["type"] as string | undefined;
  const limit = Math.min(Number(req.query["limit"] || 20), 100);
  const offset = Number(req.query["offset"] || 0);
  const langFilter = req.query["lang"] as string | undefined;
  const pathPrefix = req.query["pathPrefix"] as string | undefined;

  if (!q) {
    res.status(400).json({ error: "q parameter is required" });
    return;
  }

  const ctx = await getRepoContext(sessionId);
  if (!ctx) {
    res.json({
      sessionId,
      q,
      total: 0,
      indexStatus: "none",
      isStale: false,
      confidenceLevel: "none",
      results: [],
    });
    return;
  }

  // Embed the search query into the same vector space as stored embeddings.
  // When embeddingDim === 384 (real MiniLM vectors), we attempt a remote call so
  // that cosine similarity is meaningful. Falls back to n-gram on any failure.
  const storedDim = ctx.embeddingDim ?? 0;
  const { vec: queryVec, isRemote: queryVecIsRemote } = await getQueryEmbedding(q, storedDim);

  logger.debug(
    { sessionId, storedDim, queryVecIsRemote, queryVecLen: queryVec.length },
    "Repo search: query embedding resolved",
  );

  const results = approximateSearch({
    q,
    typeFilter,
    limit,
    offset,
    langFilter,
    pathPrefix,
    symbolsJson: ctx.symbolsJson as RepoSymbolRaw[] | null,
    filesJson: ctx.filesJson as RepoFileRaw[] | null,
    chunksJson: ctx.chunksJson as RepoChunkRaw[] | null,
    embeddingsJson: ctx.embeddingsJson as RepoEmbeddingRaw[] | null,
    embeddingDim: ctx.embeddingDim ?? null,
    queryVec,
    queryVecIsRemote,
  });

  res.json({
    sessionId,
    q,
    total: results.total,
    indexStatus: ctx.indexStatus,
    isStale: ctx.isStale,
    confidenceLevel: ctx.confidenceLevel,
    results: results.items,
  });
});

router.get("/blast-radius", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const file = (req.query["file"] as string | undefined)?.trim();
  if (!file) {
    res.status(400).json({ error: "file parameter is required" });
    return;
  }

  const ctx = await getRepoContext(sessionId);
  if (!ctx) {
    res.json({
      sessionId,
      file,
      indexStatus: "none",
      isStale: false,
      directDependents: [],
      affectedTests: [],
      relatedModules: [],
      overallConfidence: 0,
    });
    return;
  }

  const blastRadius = computeBlastRadius({
    file,
    edgesJson: ctx.edgesJson as RepoEdgeRaw[] | null,
    filesJson: ctx.filesJson as RepoFileRaw[] | null,
  });

  res.json({
    sessionId,
    file,
    indexStatus: ctx.indexStatus,
    isStale: ctx.isStale,
    ...blastRadius,
  });
});

router.get("/symbol", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  const session = await getSession(sessionId);
  if (!session) {
    res.status(404).json({ error: "Session not found" });
    return;
  }

  const nameFilter = (req.query["name"] as string | undefined)?.toLowerCase();
  const pathFilter = req.query["path"] as string | undefined;
  const langFilter = req.query["lang"] as string | undefined;
  const kindFilter = req.query["kind"] as string | undefined;

  const ctx = await getRepoContext(sessionId);
  if (!ctx) {
    res.json({
      sessionId,
      indexStatus: "none",
      isStale: false,
      symbols: [],
      total: 0,
    });
    return;
  }

  const symbols = (ctx.symbolsJson as RepoSymbolRaw[] | null) || [];
  let filtered = symbols;

  if (nameFilter) {
    filtered = filtered.filter(s => s.name?.toLowerCase().includes(nameFilter));
  }
  if (pathFilter) {
    filtered = filtered.filter(s => s.path?.includes(pathFilter));
  }
  if (langFilter) {
    filtered = filtered.filter(s => s.lang?.toLowerCase() === langFilter.toLowerCase());
  }
  if (kindFilter) {
    filtered = filtered.filter(s => s.kind?.toLowerCase() === kindFilter.toLowerCase());
  }

  res.json({
    sessionId,
    indexStatus: ctx.indexStatus,
    isStale: ctx.isStale,
    symbols: filtered.slice(0, 50).map(s => ({
      name: s.name || "",
      kind: s.kind || "unknown",
      path: s.path || "",
      line: s.line || null,
      lang: s.lang || null,
      signature: s.signature || null,
      docstring: s.docstring || null,
      callers: s.callers || [],
      callees: s.callees || [],
    })),
    total: filtered.length,
  });
});

router.get("/jobs/pending", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  if (!validateAuth(req)) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const [pending] = await db
    .select()
    .from(repoGraphJobsTable)
    .where(
      and(
        eq(repoGraphJobsTable.sessionId, sessionId),
        eq(repoGraphJobsTable.status, "queued")
      )
    )
    .orderBy(repoGraphJobsTable.createdAt)
    .limit(1);

  if (!pending) {
    res.json({ jobId: null, repoPath: null });
    return;
  }

  res.json({
    jobId: pending.id,
    repoPath: pending.repoPath || DEFAULT_REPO_PATH,
  });
});

router.get("/jobs/:jobId", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  const jobId = Number(getParam(req, "jobId"));

  if (!Number.isFinite(sessionId) || !Number.isFinite(jobId)) {
    res.status(400).json({ error: "Invalid ID" });
    return;
  }

  const [job] = await db
    .select()
    .from(repoGraphJobsTable)
    .where(and(eq(repoGraphJobsTable.id, jobId), eq(repoGraphJobsTable.sessionId, sessionId)));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  res.json({
    id: job.id,
    sessionId: job.sessionId,
    repoPath: job.repoPath,
    status: job.status,
    indexedSymbols: job.indexedSymbols,
    edgeCount: job.edgeCount,
    embeddingsStatus: job.embeddingsStatus,
    retrievalStatus: job.retrievalStatus,
    errorDetails: job.errorDetails,
    durationMs: job.durationMs,
    lastRunAt: job.lastRunAt?.toISOString() || null,
    createdAt: job.createdAt.toISOString(),
  });
});

router.post("/sync", async (req, res) => {
  const sessionId = Number(getParam(req, "sessionId"));
  if (!Number.isFinite(sessionId)) {
    res.status(400).json({ error: "Invalid session ID" });
    return;
  }

  if (!validateAuth(req)) {
    logger.warn({ sessionId }, "Repo sync: invalid token");
    res.status(401).json({ error: "Unauthorized" });
    return;
  }

  const body = req.body as RepoSyncPayload;
  const { jobId, status, repoPath, fingerprintHash, fingerprint, summary, symbols, files, edges, chunks, embeddings, embeddingDim, indexedSymbols, edgeCount, durationMs, errorDetails } = body;

  if (!jobId || !status || !repoPath) {
    res.status(400).json({ error: "jobId, status, and repoPath are required" });
    return;
  }

  const [job] = await db
    .select()
    .from(repoGraphJobsTable)
    .where(and(eq(repoGraphJobsTable.id, jobId), eq(repoGraphJobsTable.sessionId, sessionId)));

  if (!job) {
    res.status(404).json({ error: "Job not found" });
    return;
  }

  const normalizedStatus = normalizeStatus(status);
  const isTerminal = normalizedStatus === "ready" || normalizedStatus === "error";

  await db
    .update(repoGraphJobsTable)
    .set({
      status: normalizedStatus,
      repoPath,
      indexedSymbols: indexedSymbols ?? job.indexedSymbols,
      edgeCount: edgeCount ?? job.edgeCount,
      errorDetails: errorDetails ?? null,
      durationMs: durationMs ?? null,
      lastRunAt: new Date(),
    })
    .where(eq(repoGraphJobsTable.id, jobId));

  const confidenceLevel = computeConfidenceLevel({ fingerprint, summary, symbols, edges, embeddings });

  const ctx = await getRepoContext(sessionId);

  // Staleness detection based on fingerprint hash divergence:
  // - If the fingerprinting phase reports a hash different from the stored hash, the repo
  //   content has changed since last index — mark isStale=true so callers know the data is stale.
  // - When the index reaches 'ready', the new data is authoritative — always clear stale flag.
  // - For intermediate phases (scanning, indexing_*), preserve existing stale state.
  const prevHash = ctx?.fingerprintHash ?? null;
  const incomingHash = fingerprintHash ?? null;
  const contentChanged = incomingHash !== null && prevHash !== null && incomingHash !== prevHash;

  let newIsStale: boolean;
  if (normalizedStatus === "ready") {
    newIsStale = false; // fresh index, no longer stale
  } else if (normalizedStatus === "error") {
    newIsStale = ctx?.isStale ?? false; // preserve existing stale state on error
  } else if (normalizedStatus === "fingerprinting" && contentChanged) {
    newIsStale = true; // hash diverged — current stored data does not reflect current repo
    // Automatically mark all symbol-bearing memory items for this session as stale.
    // NOTE: This is intentionally session-wide (conservative): any memory items keyed to symbols
    // may be outdated when repo content changes. Per-symbol precision is a future improvement:
    // when the repo sync payload includes per-symbol hash deltas, pass them to a targeted
    // markSymbolsStaleByRef(sessionId, changedSymbolRefs[]) instead of session-wide staling.
    try {
      const staleCount = markSymbolsStaleForSession(String(sessionId));
      if (staleCount > 0) {
        logger.info({ sessionId, staleCount }, "[mem] Auto-stale: symbol memories marked stale due to repo fingerprint change");
      }
    } catch (err) {
      // Non-fatal: memory store may not have items for this session
      logger.warn({ sessionId, err }, "[mem] Auto-stale: failed to mark symbol memories stale on repo change");
    }
  } else {
    newIsStale = ctx?.isStale ?? false; // preserve for all other intermediate phases
  }

  const incomingEmbeddings = embeddings && embeddings.length > 0 ? embeddings : undefined;

  // When a terminal (ready/error) sync arrives without embeddings, explicitly clear
  // any previously stored embedding data so stale vectors from a prior index run
  // don't persist into search results for the updated index.
  const shouldClearEmbeddings = isTerminal && !incomingEmbeddings;

  const baseUpdate = {
    repoPath,
    indexStatus: normalizedStatus,
    isStale: newIsStale,
    confidenceLevel,
    updatedAt: new Date(),
    fingerprintHash: incomingHash ?? undefined,
    fingerprintJson: fingerprint ? (fingerprint as Record<string, unknown>) : undefined,
    summaryJson: summary ? (summary as Record<string, unknown>) : undefined,
    symbolsJson: symbols ? (symbols as Record<string, unknown>[]) : undefined,
    filesJson: files ? (files as Record<string, unknown>[]) : undefined,
    edgesJson: edges ? (edges as Record<string, unknown>[]) : undefined,
    chunksJson: chunks ? (chunks as Record<string, unknown>[]) : undefined,
    embeddingsJson: incomingEmbeddings
      ? (incomingEmbeddings as Record<string, unknown>[])
      : shouldClearEmbeddings ? null : undefined,
    hasEmbeddings: incomingEmbeddings ? true : shouldClearEmbeddings ? false : undefined,
    embeddingDim: incomingEmbeddings
      ? (embeddingDim ?? null)
      : shouldClearEmbeddings ? null : undefined,
    indexedAt: isTerminal ? new Date() : undefined,
  };

  if (ctx) {
    await db.update(sessionRepoContextTable).set(baseUpdate).where(eq(sessionRepoContextTable.id, ctx.id));
  } else {
    await db.insert(sessionRepoContextTable).values({ sessionId, ...baseUpdate });
  }

  logger.info({ sessionId, jobId, status: normalizedStatus, confidenceLevel, symbolCount: indexedSymbols, embeddingCount: incomingEmbeddings?.length ?? 0, embeddingDim, contentChanged, isStale: newIsStale, prevHash, newHash: incomingHash }, "Repo sync received");
  res.json({ success: true, contentChanged, isStale: newIsStale });
});

function normalizeStatus(raw: string): string {
  const valid = ["queued", "scanning", "fingerprinting", "indexing_graph", "indexing_fts", "indexing_vectors", "summarizing", "ready", "error"];
  return valid.includes(raw) ? raw : "error";
}

function computeConfidenceLevel(data: { fingerprint?: unknown; summary?: unknown; symbols?: unknown[]; edges?: unknown[]; embeddings?: unknown[] }): string {
  if (data.symbols && data.symbols.length > 0 && data.edges && data.edges.length > 0 && data.embeddings && data.embeddings.length > 0) return "full";
  if (data.symbols && data.symbols.length > 0 && data.edges && data.edges.length > 0) return "partial";
  if (data.summary) return "partial";
  if (data.fingerprint) return "fingerprint";
  return "none";
}

interface RepoSymbolRaw {
  name?: string;
  kind?: string;
  path?: string;
  line?: number;
  lang?: string;
  signature?: string;
  docstring?: string;
  callers?: string[];
  callees?: string[];
}

interface RepoFileRaw {
  path?: string;
  lang?: string;
  sizeBytes?: number;
  centralityScore?: number;
  dependencyDegree?: number;
}

interface RepoEdgeRaw {
  from?: string;
  to?: string;
  kind?: string;
}

interface RepoEmbeddingRaw {
  ref: string;
  refType?: string;
  vec: number[];
}

interface HybridSearchOptions {
  q: string;
  typeFilter?: string;
  limit: number;
  offset: number;
  langFilter?: string;
  pathPrefix?: string;
  symbolsJson: RepoSymbolRaw[] | null;
  filesJson: RepoFileRaw[] | null;
  chunksJson: RepoChunkRaw[] | null;
  embeddingsJson: RepoEmbeddingRaw[] | null;
  embeddingDim: number | null;
  /** Pre-computed query embedding vector (same dim as stored embeddings). */
  queryVec?: number[];
  /** True when queryVec was produced by the remote embedding API (real MiniLM space). */
  queryVecIsRemote?: boolean;
}

type SearchResult = {
  type: string;
  path: string;
  name?: string | null;
  lang?: string | null;
  kind?: string | null;
  snippet?: string | null;
  line?: number | null;
  scores: { combined: number; lexical: number; semantic: number; graph: number; confidence: number };
};

// ─── Remote query embedding for real MiniLM vectors ─────────────────────────

const REMOTE_EMBEDDINGS_URL = process.env["FLOATR_REMOTE_EMBEDDINGS_URL"] || "";
const REMOTE_EMBEDDINGS_TOKEN =
  process.env["FLOATR_REMOTE_EMBEDDINGS_TOKEN"] ||
  process.env["OMNIQL_MEM_AUTH_TOKEN"] ||
  "";
const MINILM_DIM = 384;

async function embedQueryRemote(text: string): Promise<number[]> {
  if (!REMOTE_EMBEDDINGS_URL) throw new Error("FLOATR_REMOTE_EMBEDDINGS_URL not configured");
  const res = await fetch(REMOTE_EMBEDDINGS_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(REMOTE_EMBEDDINGS_TOKEN ? { Authorization: `Bearer ${REMOTE_EMBEDDINGS_TOKEN}` } : {}),
    },
    body: JSON.stringify({ input: text }),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`Remote embeddings HTTP ${res.status}`);
  const data = await res.json() as Record<string, unknown>;
  const raw =
    (data?.data as { embedding: number[] }[] | undefined)?.[0]?.embedding ??
    (data?.embedding as number[] | undefined) ??
    data;
  if (!Array.isArray(raw)) throw new Error("Remote embeddings: unexpected response shape");
  return raw as number[];
}

/**
 * Embed a search query into the same vector space as the stored embeddings.
 * - When storedDim === 384 (MiniLM), attempt a remote call to get a real 384-dim vector.
 *   Falls back to n-gram on any failure.
 * - Otherwise returns a 512-dim n-gram vector.
 */
async function getQueryEmbedding(
  q: string,
  storedDim: number,
): Promise<{ vec: number[]; isRemote: boolean }> {
  if (storedDim === MINILM_DIM) {
    try {
      const vec = await embedQueryRemote(q);
      if (vec.length === MINILM_DIM) {
        return { vec, isRemote: true };
      }
      logger.warn(
        { storedDim, remoteLen: vec.length },
        "Remote query embedding dimension mismatch — falling back to n-gram",
      );
    } catch (err) {
      logger.warn({ err }, "Remote query embedding failed — falling back to n-gram for search");
    }
  }
  return { vec: charNgramVec(q), isRemote: false };
}

// ─── Hybrid Retrieval: BM25 lexical + n-gram semantic + graph centrality ─────

const NGRAM_DIM_SEARCH = 512;

function charNgramVec(text: string): number[] {
  const t = text.toLowerCase().replace(/[^a-z0-9_]/g, " ").trim();
  const vec = new Array(NGRAM_DIM_SEARCH).fill(0);
  for (let i = 0; i <= t.length - 3; i++) {
    const g = t.slice(i, i + 3);
    let h = 0;
    for (let k = 0; k < g.length; k++) h = (Math.imul(31, h) + g.charCodeAt(k)) | 0;
    vec[Math.abs(h) % NGRAM_DIM_SEARCH] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return vec.map(v => v / mag);
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, Math.min(1, dot));
}

/** BM25 score for a term in a document field. */
function bm25(termFreq: number, docLen: number, avgDocLen: number, k1 = 1.5, b = 0.75): number {
  if (termFreq === 0 || avgDocLen === 0) return 0;
  const norm = termFreq * (k1 + 1) / (termFreq + k1 * (1 - b + b * docLen / avgDocLen));
  return norm;
}

function lexicalBm25(doc: string, query: string): number {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return 0;
  const docLower = doc.toLowerCase();
  const docLen = docLower.split(/\s+/).length;
  let score = 0;
  for (const term of terms) {
    const tf = (docLower.match(new RegExp(term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    score += bm25(tf, docLen, 5);
    if (docLower.startsWith(term)) score += 0.5;
    if (docLower === term) score += 1.0;
  }
  return Math.min(1, score / terms.length);
}

function hybridSearch(opts: HybridSearchOptions) {
  const { q, typeFilter, limit, offset, langFilter, pathPrefix, symbolsJson, filesJson, chunksJson, embeddingsJson, embeddingDim, queryVec, queryVecIsRemote } = opts;

  // Build a ref → vec lookup from stored embeddings.
  // Stored vectors are usable only when the query vector lives in the same space:
  //   - storedDim === 512 AND queryVec is an n-gram vector (not remote) → n-gram compatible
  //   - storedDim === 384 AND queryVec is a real MiniLM remote vector   → MiniLM compatible
  // In any other case (e.g. remote embedding failed and fell back to n-gram while stored dim
  // is 384) we skip the stored vectors to avoid cross-dim cosine noise.
  const embeddingLookup = new Map<string, number[]>();
  const storedDim = embeddingDim ?? 0;
  const ngramCompatible = storedDim === NGRAM_DIM_SEARCH && !queryVecIsRemote;
  const miniLmCompatible = storedDim === MINILM_DIM && queryVecIsRemote === true;
  const storedVecCompatible = ngramCompatible || miniLmCompatible;
  if (embeddingsJson && embeddingsJson.length > 0) {
    for (const e of embeddingsJson) {
      if (e.ref && Array.isArray(e.vec) && e.vec.length > 0) {
        embeddingLookup.set(e.ref, e.vec);
      }
    }
  }

  // Use the pre-computed query vector when provided (real MiniLM or n-gram), otherwise
  // fall back to on-the-fly n-gram (preserves backward-compat when called without queryVec).
  const qVec = queryVec ?? charNgramVec(q);
  const results: SearchResult[] = [];

  const avgSymDocLen = 5;
  const avgFileDocLen = 4;

  // Minimum semantic score to admit a candidate even when lexical score is near zero.
  // Only applies when n-gram-compatible stored embeddings are present, so the semantic
  // score carries richer signal (computed from code content + docstrings at index time).
  const SEMANTIC_ADMISSION_THRESHOLD = 0.15;

  if (!typeFilter || typeFilter === "symbol") {
    for (const sym of symbolsJson || []) {
      if (langFilter && sym.lang?.toLowerCase() !== langFilter.toLowerCase()) continue;
      if (pathPrefix && !sym.path?.startsWith(pathPrefix)) continue;

      // Lexical (BM25 over name + path + signature)
      const nameDoc = sym.name || "";
      const fullDoc = [sym.name, sym.path, sym.docstring, sym.signature].filter(Boolean).join(" ");
      const lxName = lexicalBm25(nameDoc, q);
      const lxFull = lexicalBm25(fullDoc, q) * 0.5;
      const lexical = Math.min(1, lxName + lxFull);

      // Semantic: use pre-computed embedding if available and dimension-compatible,
      // otherwise fall back to on-the-fly n-gram cosine.
      const symRef = `sym:${sym.name || ""}:${sym.path || ""}`;
      let docVec: number[];
      let usingStoredVec = false;
      if (storedVecCompatible && embeddingLookup.has(symRef)) {
        docVec = embeddingLookup.get(symRef)!;
        usingStoredVec = true;
      } else {
        const docText = [sym.name, sym.kind, sym.signature, sym.docstring].filter(Boolean).join(" ");
        docVec = charNgramVec(docText);
      }
      const semantic = cosineSim(qVec, docVec);

      // Admission: always require some signal. When stored embeddings are present,
      // allow semantic-only matches (items with different wording but related meaning).
      // Without embeddings, fall back to the original pure-lexical gate.
      const admitted = lexical >= 0.02 || (usingStoredVec && semantic >= SEMANTIC_ADMISSION_THRESHOLD);
      if (!admitted) continue;

      // Graph (zero on symbol level — centrality is file-level)
      const graph = 0;

      // When using stored (pre-computed) embeddings, weight semantic score higher
      // since the stored vector was computed from richer text (includes docstrings).
      const combined = usingStoredVec
        ? lexical * 0.45 + semantic * 0.45 + graph * 0.1
        : lexical * 0.55 + semantic * 0.35 + graph * 0.1;
      const confidence = lexical > 0.5 ? 0.9 : 0.5;

      results.push({
        type: "symbol", path: sym.path || "", name: sym.name || null,
        lang: sym.lang || null, kind: sym.kind || null,
        snippet: sym.signature?.slice(0, 200) || sym.docstring?.slice(0, 200) || null,
        line: sym.line || null,
        scores: { combined, lexical, semantic, graph, confidence },
      });
    }
  }

  if (!typeFilter || typeFilter === "file") {
    for (const file of filesJson || []) {
      if (langFilter && file.lang?.toLowerCase() !== langFilter.toLowerCase()) continue;
      if (pathPrefix && !file.path?.startsWith(pathPrefix)) continue;

      const pathStr = file.path || "";
      const lexical = lexicalBm25(pathStr, q);
      if (lexical < 0.02) continue;

      // Semantic
      const docVec = charNgramVec(pathStr + " " + (file.lang || ""));
      const semantic = cosineSim(qVec, docVec);

      // Graph centrality score
      const centralityNorm = Math.min(1, (file.centralityScore || 0));
      const degreeNorm = Math.min(1, (file.dependencyDegree || 0) / 20);
      const graph = centralityNorm * 0.6 + degreeNorm * 0.4;

      const combined = lexical * 0.50 + semantic * 0.25 + graph * 0.25;
      const confidence = graph > 0.3 ? 0.8 : 0.6;

      results.push({
        type: "file", path: pathStr, name: null,
        lang: file.lang || null, kind: null, snippet: null, line: null,
        scores: { combined, lexical, semantic, graph, confidence },
      });
    }
  }

  // ── Chunk retrieval ──────────────────────────────────────────────────────────
  // Chunks are code snippets (function/class bodies) extracted during indexing.
  // They are indexed by path, symbolName, symbolKind, and raw content.
  if (!typeFilter || typeFilter === "chunk") {
    for (const chunk of chunksJson || []) {
      if (langFilter && chunk.lang?.toLowerCase() !== langFilter.toLowerCase()) continue;
      if (pathPrefix && !chunk.path?.startsWith(pathPrefix)) continue;

      const chunkDoc = [chunk.symbolName, chunk.symbolKind, chunk.path, chunk.content?.slice(0, 500)].filter(Boolean).join(" ");
      const lexical = lexicalBm25(chunkDoc, q);

      // Use stored symbol embedding for this chunk if available (keyed by sym:name:path)
      const chunkRef = `sym:${chunk.symbolName || ""}:${chunk.path || ""}`;
      let chunkDocVec: number[];
      let chunkUsesStoredVec = false;
      if (storedVecCompatible && embeddingLookup.has(chunkRef)) {
        chunkDocVec = embeddingLookup.get(chunkRef)!;
        chunkUsesStoredVec = true;
      } else {
        chunkDocVec = charNgramVec(chunkDoc);
      }
      const semantic = cosineSim(qVec, chunkDocVec);

      // Semantic admission: admit chunk if it has lexical overlap OR strong semantic match
      const chunkAdmitted = lexical >= 0.02 || (chunkUsesStoredVec && semantic >= SEMANTIC_ADMISSION_THRESHOLD);
      if (!chunkAdmitted) continue;

      const combined = chunkUsesStoredVec
        ? lexical * 0.40 + semantic * 0.50 + 0.10
        : lexical * 0.50 + semantic * 0.40 + 0.10;

      results.push({
        type: "chunk",
        path: chunk.path || "",
        name: chunk.symbolName || null,
        lang: chunk.lang || null,
        kind: chunk.symbolKind || null,
        snippet: chunk.content?.slice(0, 300) || null,
        line: chunk.startLine || null,
        scores: { combined, lexical, semantic, graph: 0, confidence: 0.75 },
      });
    }
  }

  results.sort((a, b) => b.scores.combined - a.scores.combined);
  return { total: results.length, items: results.slice(offset, offset + limit) };
}

function approximateSearch(opts: HybridSearchOptions) {
  return hybridSearch(opts);
}

function computeBlastRadius(opts: { file: string; edgesJson: RepoEdgeRaw[] | null; filesJson: RepoFileRaw[] | null }) {
  const { file, edgesJson, filesJson } = opts;
  const edges = edgesJson || [];
  const files = filesJson || [];
  const fileSet = new Set(files.map(f => f.path));

  const directDependents: { path: string; relation: string; confidence: number }[] = [];
  const affectedTests: { path: string; relation: string; confidence: number }[] = [];
  const relatedModules: { path: string; relation: string; confidence: number }[] = [];
  const seen = new Set<string>();

  for (const edge of edges) {
    if (edge.to === file || edge.from === file) {
      const other = edge.to === file ? (edge.from || "") : (edge.to || "");
      if (!other || seen.has(other) || other === file) continue;
      seen.add(other);

      const isTest = /\.(test|spec)\.|__tests__|\/tests?\//i.test(other);
      const item = { path: other, relation: "direct_dependent" as const, confidence: 0.7 };

      if (isTest) {
        affectedTests.push({ ...item, relation: "affected_test", confidence: 0.6 });
      } else {
        directDependents.push(item);
      }
    }
  }

  for (const f of files) {
    if (!f.path || seen.has(f.path) || f.path === file) continue;
    const isSameDir = f.path.includes(file.split("/").slice(0, -1).join("/"));
    if (isSameDir && fileSet.has(f.path)) {
      relatedModules.push({ path: f.path, relation: "related_module", confidence: 0.3 });
    }
  }

  const hasData = directDependents.length > 0 || affectedTests.length > 0;
  const overallConfidence = hasData ? 0.65 : 0;

  return {
    directDependents: directDependents.slice(0, 20),
    affectedTests: affectedTests.slice(0, 20),
    relatedModules: relatedModules.slice(0, 10),
    overallConfidence,
  };
}

interface RepoChunkRaw {
  path?: string;
  lang?: string;
  content?: string;
  startLine?: number;
  endLine?: number;
  symbolName?: string;
  symbolKind?: string;
}

interface RepoSyncPayload {
  jobId: number;
  status: string;
  repoPath: string;
  fingerprintHash?: string;
  fingerprint?: unknown;
  summary?: unknown;
  symbols?: RepoSymbolRaw[];
  files?: RepoFileRaw[];
  edges?: RepoEdgeRaw[];
  chunks?: RepoChunkRaw[];
  embeddings?: RepoEmbeddingRaw[];
  embeddingDim?: number;
  indexedSymbols?: number;
  edgeCount?: number;
  durationMs?: number;
  errorDetails?: string;
}

export default router;
