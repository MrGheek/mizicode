import { Router } from "express";
import { db, repoGraphJobsTable, sessionRepoContextTable, sessionsTable } from "@workspace/db";
import { eq, and, inArray, desc } from "drizzle-orm";
import { logger } from "../lib/logger";

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

  logger.info({ sessionId, jobId: newJob.id, repoPath }, "Repo index: job enqueued");
  res.status(202).json({
    jobId: newJob.id,
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
    });
    return;
  }

  res.json({
    sessionId,
    indexStatus: ctx.indexStatus,
    isStale: ctx.isStale,
    confidenceLevel: ctx.confidenceLevel,
    summary: ctx.summaryJson || null,
    indexedAt: ctx.indexedAt?.toISOString() || null,
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
  const { jobId, status, repoPath, fingerprintHash, fingerprint, summary, symbols, files, edges, chunks, indexedSymbols, edgeCount, durationMs, errorDetails } = body;

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

  const confidenceLevel = computeConfidenceLevel({ fingerprint, summary, symbols, edges });

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
  } else {
    newIsStale = ctx?.isStale ?? false; // preserve for all other intermediate phases
  }

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
    indexedAt: isTerminal ? new Date() : undefined,
  };

  if (ctx) {
    await db.update(sessionRepoContextTable).set(baseUpdate).where(eq(sessionRepoContextTable.id, ctx.id));
  } else {
    await db.insert(sessionRepoContextTable).values({ sessionId, ...baseUpdate });
  }

  logger.info({ sessionId, jobId, status: normalizedStatus, confidenceLevel, symbolCount: indexedSymbols, contentChanged, isStale: newIsStale, prevHash, newHash: incomingHash }, "Repo sync received");
  res.json({ success: true, contentChanged, isStale: newIsStale });
});

function normalizeStatus(raw: string): string {
  const valid = ["queued", "scanning", "fingerprinting", "indexing_graph", "indexing_fts", "indexing_vectors", "summarizing", "ready", "error"];
  return valid.includes(raw) ? raw : "error";
}

function computeConfidenceLevel(data: { fingerprint?: unknown; summary?: unknown; symbols?: unknown[]; edges?: unknown[] }): string {
  if (data.symbols && data.symbols.length > 0 && data.edges && data.edges.length > 0) return "full";
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
  const { q, typeFilter, limit, offset, langFilter, pathPrefix, symbolsJson, filesJson, chunksJson } = opts;

  const qVec = charNgramVec(q);
  const results: SearchResult[] = [];

  const avgSymDocLen = 5;
  const avgFileDocLen = 4;

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

      if (lexical < 0.02) continue;

      // Semantic (n-gram cosine)
      const docText = [sym.name, sym.kind, sym.signature, sym.docstring].filter(Boolean).join(" ");
      const docVec = charNgramVec(docText);
      const semantic = cosineSim(qVec, docVec);

      // Graph (zero on symbol level — centrality is file-level)
      const graph = 0;

      const combined = lexical * 0.55 + semantic * 0.35 + graph * 0.1;
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
      if (lexical < 0.02) continue;

      const docVec = charNgramVec(chunkDoc);
      const semantic = cosineSim(qVec, docVec);
      const combined = lexical * 0.50 + semantic * 0.40 + 0.10; // chunks score higher on semantic

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
  indexedSymbols?: number;
  edgeCount?: number;
  durationMs?: number;
  errorDetails?: string;
}

export default router;
