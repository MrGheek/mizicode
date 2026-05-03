/**
 * Passive Semantic Memory Recall (Task #225)
 *
 * Layers on top of the existing FTS5 memory store. For every conversation turn:
 *   1. The turn is embedded and persisted (mem_turns + mem_embeddings).
 *   2. A non-blocking recall pass runs similarity search across mem_items
 *      embeddings, BFS-expands via the typed memory edge graph (mem_edges),
 *      and verifies candidates via a sidecar pass (LLM if configured, else
 *      heuristic). The verified shortlist is persisted in mem_recall_audit.
 *   3. The runner queries GET /mem/recall before assembling its next prompt
 *      and POSTs /mem/recall/inject to mark which items were actually injected.
 *
 * Feature flagging:
 *   - Global:   OMNIQL_MEM_PASSIVE_RECALL=1
 *   - Per-session: row in mem_passive_settings (overrides global).
 */
import Database from "better-sqlite3";
import path from "path";
import os from "os";
import { logger } from "../lib/logger";
import { cosineSimilarity, computeSemanticSimilarityBatch, tfidfCosineSimilarity } from "./memory-semantic";

const DATA_DIR = process.env["MEM_DATA_DIR"] || path.join(os.homedir(), "omniql-memory");
const DB_PATH = path.join(DATA_DIR, "mem.db");

let _db: Database.Database | null = null;
let _migrated = false;
function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
  }
  if (!_migrated) {
    _migrated = true;
    try {
      runPassiveRecallMigrations();
    } catch (err) {
      _migrated = false;
      throw err;
    }
  }
  return _db;
}

/** Test-only: reset the cached db handle and migration flag. */
export function _resetForTests(): void {
  if (_db) {
    try { _db.close(); } catch { /* ignore */ }
  }
  _db = null;
  _migrated = false;
}

export type EdgeType = "relates_to" | "supersedes" | "contradicts";

export const VALID_EDGE_TYPES: EdgeType[] = ["relates_to", "supersedes", "contradicts"];

const EMBEDDING_MODEL = "text-embedding-3-small";
const SIMILARITY_TOPK = 12;
const BFS_MAX_DEPTH = 2;
const BFS_FANOUT = 5;
const SIDECAR_ACCEPT_THRESHOLD = 0.55;
const RELATES_TO_AUTO_THRESHOLD = 0.75;

export function passiveRecallGloballyEnabled(): boolean {
  return process.env["OMNIQL_MEM_PASSIVE_RECALL"] === "1";
}

/**
 * Stand up extra tables/columns needed by the passive recall pipeline.
 * Idempotent — safe to call repeatedly.
 */
export function runPassiveRecallMigrations(): void {
  // Use the raw handle (bypass getDb) so we can be called from inside getDb
  // during the lazy-init bootstrap without recursing.
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("foreign_keys = ON");
  }
  const db = _db;
  _migrated = true;
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_embeddings (
      item_id INTEGER PRIMARY KEY,
      vector_json TEXT NOT NULL,
      dim INTEGER NOT NULL,
      model TEXT NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS mem_turns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      vector_json TEXT,
      dim INTEGER,
      model TEXT,
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_mem_turns_session ON mem_turns(session_id);
    CREATE INDEX IF NOT EXISTS idx_mem_turns_user ON mem_turns(user_id);
    CREATE INDEX IF NOT EXISTS idx_mem_turns_recorded ON mem_turns(recorded_at DESC);

    CREATE TABLE IF NOT EXISTS mem_edges (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      src_item_id INTEGER NOT NULL,
      dst_item_id INTEGER NOT NULL,
      edge_type TEXT NOT NULL,
      weight REAL NOT NULL DEFAULT 0.0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      UNIQUE(src_item_id, dst_item_id, edge_type)
    );
    CREATE INDEX IF NOT EXISTS idx_mem_edges_src ON mem_edges(src_item_id);
    CREATE INDEX IF NOT EXISTS idx_mem_edges_dst ON mem_edges(dst_item_id);
    CREATE INDEX IF NOT EXISTS idx_mem_edges_type ON mem_edges(edge_type);

    CREATE TABLE IF NOT EXISTS mem_recall_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id INTEGER NOT NULL,
      session_id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      similarity REAL NOT NULL,
      bfs_depth INTEGER NOT NULL DEFAULT 0,
      sidecar_accepted INTEGER NOT NULL DEFAULT 0,
      sidecar_score REAL,
      sidecar_reason TEXT,
      injected INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_mem_recall_turn ON mem_recall_audit(turn_id);
    CREATE INDEX IF NOT EXISTS idx_mem_recall_session ON mem_recall_audit(session_id);
    CREATE INDEX IF NOT EXISTS idx_mem_recall_user ON mem_recall_audit(user_id);
    CREATE INDEX IF NOT EXISTS idx_mem_recall_created ON mem_recall_audit(created_at DESC);

    CREATE TABLE IF NOT EXISTS mem_passive_settings (
      session_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
  `);
}

/** Returns true when passive recall should run for this session. */
export function isPassiveRecallEnabled(sessionId: string | null | undefined): boolean {
  if (sessionId) {
    const db = getDb();
    const row = db.prepare(
      `SELECT enabled FROM mem_passive_settings WHERE session_id = ?`
    ).get(sessionId) as { enabled: number } | undefined;
    if (row) return row.enabled === 1;
  }
  return passiveRecallGloballyEnabled();
}

export function setPassiveRecallForSession(sessionId: string, enabled: boolean): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO mem_passive_settings (session_id, enabled, updated_at)
    VALUES (?, ?, unixepoch())
    ON CONFLICT(session_id) DO UPDATE SET enabled = excluded.enabled, updated_at = unixepoch()
  `).run(sessionId, enabled ? 1 : 0);
}

/**
 * Embed text via the OpenAI embeddings API (or compatible AI Integrations
 * proxy). Returns null on any failure so callers can fall back gracefully.
 */
export async function embedText(text: string): Promise<{ vector: number[]; model: string } | null> {
  const baseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  if (!baseUrl || !apiKey) return null;
  try {
    const response = await fetch(`${baseUrl}/embeddings`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ model: EMBEDDING_MODEL, input: [text] }),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as { data: Array<{ embedding: number[] }> };
    const v = data.data[0]?.embedding;
    if (!v || v.length === 0) return null;
    return { vector: v, model: EMBEDDING_MODEL };
  } catch (err) {
    logger.debug({ err }, "[mem-passive] embedText failed");
    return null;
  }
}

/** Persist (or replace) a memory item's embedding. Fire-and-forget friendly.
 *  Returns true when an embedding was written, false when the embeddings
 *  provider is unavailable / returned null. */
export async function embedAndStoreItem(itemId: number, content: string): Promise<boolean> {
  const result = await embedText(content);
  if (!result) return false;
  const db = getDb();
  db.prepare(`
    INSERT INTO mem_embeddings (item_id, vector_json, dim, model)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(item_id) DO UPDATE SET
      vector_json = excluded.vector_json,
      dim = excluded.dim,
      model = excluded.model,
      created_at = unixepoch()
  `).run(itemId, JSON.stringify(result.vector), result.vector.length, result.model);
  return true;
}

/**
 * Backfill embeddings for items missing them. Runs in chunks to keep memory
 * pressure low. Returns the number of items embedded.
 */
export async function backfillItemEmbeddings(maxItems: number = 500): Promise<number> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT mi.id, mi.content FROM mem_items mi
    LEFT JOIN mem_embeddings me ON me.item_id = mi.id
    WHERE me.item_id IS NULL
      AND mi.validity_status != 'retracted'
    ORDER BY mi.id DESC
    LIMIT ?
  `).all(maxItems) as Array<{ id: number; content: string }>;

  let embedded = 0;
  for (const r of rows) {
    try {
      if (await embedAndStoreItem(r.id, r.content)) {
        embedded++;
      }
    } catch (err) {
      logger.debug({ err, itemId: r.id }, "[mem-passive] backfill embed failed");
    }
  }
  if (embedded > 0) {
    logger.info({ embedded, total: rows.length }, "[mem-passive] Embedding backfill completed");
  }
  return embedded;
}

/** Record a conversation turn. Embedding is computed asynchronously. */
export async function recordTurn(params: {
  sessionId: string;
  userId: string;
  role: string;
  content: string;
}): Promise<{ turnId: number }> {
  const db = getDb();
  const result = db.prepare(`
    INSERT INTO mem_turns (session_id, user_id, role, content)
    VALUES (?, ?, ?, ?)
  `).run(params.sessionId, params.userId, params.role, params.content);
  const turnId = Number(result.lastInsertRowid);

  // Embed asynchronously and persist on the same row.
  (async () => {
    const emb = await embedText(params.content);
    if (!emb) return;
    try {
      db.prepare(`
        UPDATE mem_turns SET vector_json = ?, dim = ?, model = ? WHERE id = ?
      `).run(JSON.stringify(emb.vector), emb.vector.length, emb.model, turnId);
    } catch (err) {
      logger.debug({ err, turnId }, "[mem-passive] failed to persist turn embedding");
    }
  })();

  return { turnId };
}

export function recordEdge(params: {
  srcItemId: number;
  dstItemId: number;
  edgeType: EdgeType;
  weight?: number;
}): { id: number } | null {
  if (params.srcItemId === params.dstItemId) return null;
  const db = getDb();
  try {
    const result = db.prepare(`
      INSERT INTO mem_edges (src_item_id, dst_item_id, edge_type, weight)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(src_item_id, dst_item_id, edge_type) DO UPDATE SET
        weight = excluded.weight
    `).run(params.srcItemId, params.dstItemId, params.edgeType, params.weight ?? 0);
    return { id: Number(result.lastInsertRowid) };
  } catch (err) {
    logger.debug({ err, params }, "[mem-passive] recordEdge failed");
    return null;
  }
}

export function listEdges(itemId: number): Array<{
  id: number;
  srcItemId: number;
  dstItemId: number;
  edgeType: EdgeType;
  weight: number;
  createdAt: number;
}> {
  const db = getDb();
  const rows = db.prepare(`
    SELECT id, src_item_id, dst_item_id, edge_type, weight, created_at
    FROM mem_edges
    WHERE src_item_id = ? OR dst_item_id = ?
    ORDER BY created_at DESC
  `).all(itemId, itemId) as Array<{
    id: number; src_item_id: number; dst_item_id: number;
    edge_type: string; weight: number; created_at: number;
  }>;
  return rows.map(r => ({
    id: r.id,
    srcItemId: r.src_item_id,
    dstItemId: r.dst_item_id,
    edgeType: r.edge_type as EdgeType,
    weight: r.weight,
    createdAt: r.created_at,
  }));
}

/**
 * Auto-create `relates_to` edges for newly saved items by comparing against
 * recently embedded sibling items in the same scope. Also materialises
 * `contradicts` edges from the existing contradiction-detection signal.
 */
export async function inferEdgesForNewItem(params: {
  itemId: number;
  scope: string;
  userId: string;
  contradictionIds: number[];
}): Promise<void> {
  const db = getDb();

  // contradiction edges (from existing detector output)
  for (const dst of params.contradictionIds) {
    recordEdge({ srcItemId: params.itemId, dstItemId: dst, edgeType: "contradicts", weight: 1 });
    recordEdge({ srcItemId: dst, dstItemId: params.itemId, edgeType: "contradicts", weight: 1 });
  }

  const newRow = db.prepare(`
    SELECT mi.content, me.vector_json FROM mem_items mi
    LEFT JOIN mem_embeddings me ON me.item_id = mi.id
    WHERE mi.id = ?
  `).get(params.itemId) as { content: string; vector_json: string | null } | undefined;
  if (!newRow) return;

  const candidates = db.prepare(`
    SELECT mi.id, mi.content, me.vector_json FROM mem_items mi
    LEFT JOIN mem_embeddings me ON me.item_id = mi.id
    WHERE mi.user_id = ? AND mi.scope = ? AND mi.id != ?
      AND mi.validity_status != 'retracted'
    ORDER BY mi.id DESC
    LIMIT 30
  `).all(params.userId, params.scope, params.itemId) as Array<{
    id: number; content: string; vector_json: string | null;
  }>;

  if (candidates.length === 0) return;

  let newVec: number[] | null = newRow.vector_json ? JSON.parse(newRow.vector_json) : null;
  if (!newVec) {
    const emb = await embedText(newRow.content);
    if (emb) {
      newVec = emb.vector;
      db.prepare(`
        INSERT INTO mem_embeddings (item_id, vector_json, dim, model)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(item_id) DO UPDATE SET vector_json = excluded.vector_json, dim = excluded.dim
      `).run(params.itemId, JSON.stringify(emb.vector), emb.vector.length, emb.model);
    }
  }

  for (const c of candidates) {
    let sim = 0;
    if (newVec && c.vector_json) {
      try {
        const cVec: number[] = JSON.parse(c.vector_json);
        sim = cosineSimilarity(newVec, cVec);
      } catch {
        sim = tfidfCosineSimilarity(newRow.content, c.content);
      }
    } else {
      sim = tfidfCosineSimilarity(newRow.content, c.content);
    }
    if (sim >= RELATES_TO_AUTO_THRESHOLD) {
      recordEdge({ srcItemId: params.itemId, dstItemId: c.id, edgeType: "relates_to", weight: sim });
    }
  }
}

/** Sidecar verifier: tries an LLM call when configured, otherwise heuristic. */
async function sidecarVerify(
  turnContent: string,
  candidate: { id: number; content: string; similarity: number },
): Promise<{ accepted: boolean; score: number; reason: string }> {
  // Heuristic baseline: lexical overlap × similarity.
  const lexical = tfidfCosineSimilarity(turnContent, candidate.content);
  const blended = candidate.similarity * 0.7 + lexical * 0.3;
  const heuristicAccepted = blended >= SIDECAR_ACCEPT_THRESHOLD;
  const heuristic = {
    accepted: heuristicAccepted,
    score: blended,
    reason: heuristicAccepted
      ? `heuristic: blended=${blended.toFixed(2)} (sim=${candidate.similarity.toFixed(2)}, lex=${lexical.toFixed(2)})`
      : `heuristic-rejected: blended=${blended.toFixed(2)} below ${SIDECAR_ACCEPT_THRESHOLD}`,
  };

  if (process.env["OMNIQL_MEM_RECALL_SIDECAR_LLM"] !== "1") {
    return heuristic;
  }
  const baseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  if (!baseUrl || !apiKey) return heuristic;

  try {
    const model = process.env["OMNIQL_MEM_RECALL_SIDECAR_MODEL"] || "gpt-4o-mini";
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 80,
        messages: [
          { role: "system", content: "You are a strict relevance judge. Decide if a retrieved memory is genuinely useful for the current conversation turn. Reply ONLY with JSON: {\"relevant\": boolean, \"reason\": string}." },
          { role: "user", content: `TURN:\n${turnContent.slice(0, 1500)}\n\nMEMORY:\n${candidate.content.slice(0, 1500)}` },
        ],
      }),
    });
    if (!response.ok) return heuristic;
    const data = await response.json() as { choices: Array<{ message?: { content?: string } }> };
    const text = data.choices?.[0]?.message?.content?.trim() ?? "";
    const json = text.match(/\{[\s\S]*\}/)?.[0];
    if (!json) return heuristic;
    const parsed = JSON.parse(json) as { relevant?: boolean; reason?: string };
    return {
      accepted: !!parsed.relevant,
      score: parsed.relevant ? Math.max(blended, 0.6) : blended,
      reason: `sidecar(${model}): ${parsed.reason || (parsed.relevant ? "accepted" : "rejected")}`,
    };
  } catch (err) {
    logger.debug({ err }, "[mem-passive] sidecar LLM verify failed; falling back to heuristic");
    return heuristic;
  }
}

interface RecallCandidate {
  itemId: number;
  content: string;
  similarity: number;
  bfsDepth: number;
}

/**
 * Run the full passive recall pipeline for a given turn:
 *   embed → similarity search (scope-aware) → BFS edge expansion →
 *   sidecar verify → persist audit + return shortlist.
 */
export async function runPassiveRecallForTurn(params: {
  turnId: number;
  sessionId: string;
  userId: string;
  scopes?: string[];
  topK?: number;
}): Promise<Array<{ itemId: number; similarity: number; bfsDepth: number; accepted: boolean; score: number; reason: string }>> {
  const db = getDb();
  const turn = db.prepare(`
    SELECT id, content, vector_json FROM mem_turns WHERE id = ?
  `).get(params.turnId) as { id: number; content: string; vector_json: string | null } | undefined;
  if (!turn) return [];

  // Ensure we have an embedding for this turn (compute now if the async write hadn't landed).
  let turnVec: number[] | null = turn.vector_json ? JSON.parse(turn.vector_json) : null;
  if (!turnVec) {
    const emb = await embedText(turn.content);
    if (emb) {
      turnVec = emb.vector;
      try {
        db.prepare(`UPDATE mem_turns SET vector_json = ?, dim = ?, model = ? WHERE id = ?`)
          .run(JSON.stringify(emb.vector), emb.vector.length, emb.model, params.turnId);
      } catch { /* ignore */ }
    }
  }

  const scopeFilter = params.scopes && params.scopes.length > 0 ? params.scopes : null;
  // LEFT JOIN so that items without an embedding still surface as
  // candidates; we'll fall back to TF-IDF cosine for those rows.
  const candidateRows = db.prepare(`
    SELECT mi.id, mi.content, me.vector_json
    FROM mem_items mi
    LEFT JOIN mem_embeddings me ON me.item_id = mi.id
    WHERE mi.user_id = ?
      AND mi.validity_status != 'retracted'
      AND mi.stale_status != 'invalidated'
      ${scopeFilter ? `AND mi.scope IN (${scopeFilter.map(() => "?").join(",")})` : ""}
    ORDER BY mi.roi_score DESC, mi.id DESC
    LIMIT 200
  `).all(params.userId, ...(scopeFilter ?? [])) as Array<{
    id: number; content: string; vector_json: string | null;
  }>;

  // Compute similarities. Vector-vs-vector cosine when both sides have an
  // embedding; otherwise fall back to TF-IDF cosine on raw content. If we
  // don't even have a turn embedding, use the batched embedding-API helper
  // (which itself transparently falls back to TF-IDF).
  const sims = new Map<number, number>();
  if (turnVec) {
    for (const c of candidateRows) {
      if (c.vector_json) {
        try {
          const v: number[] = JSON.parse(c.vector_json);
          sims.set(c.id, cosineSimilarity(turnVec, v));
          continue;
        } catch { /* fall through to lexical */ }
      }
      sims.set(c.id, tfidfCosineSimilarity(turn.content, c.content));
    }
  } else {
    const batched = await computeSemanticSimilarityBatch(turn.content, candidateRows.map(c => c.content));
    candidateRows.forEach((c, i) => sims.set(c.id, batched[i] ?? 0));
  }

  const topK = params.topK ?? SIMILARITY_TOPK;
  const ranked: RecallCandidate[] = candidateRows
    .map(c => ({ itemId: c.id, content: c.content, similarity: sims.get(c.id) ?? 0, bfsDepth: 0 }))
    .sort((a, b) => b.similarity - a.similarity)
    .slice(0, topK);

  // BFS expand via mem_edges (relates_to weight, supersedes carries forward,
  // contradicts surfaces too because operators want to see disagreements).
  const visited = new Set<number>(ranked.map(r => r.itemId));
  let frontier = ranked.slice();
  for (let depth = 1; depth <= BFS_MAX_DEPTH; depth++) {
    if (frontier.length === 0) break;
    const next: RecallCandidate[] = [];
    for (const node of frontier) {
      const edges = db.prepare(`
        SELECT dst_item_id, edge_type, weight FROM mem_edges
        WHERE src_item_id = ?
        ORDER BY weight DESC
        LIMIT ?
      `).all(node.itemId, BFS_FANOUT) as Array<{ dst_item_id: number; edge_type: string; weight: number }>;
      for (const e of edges) {
        if (visited.has(e.dst_item_id)) continue;
        visited.add(e.dst_item_id);
        const row = db.prepare(`
          SELECT id, content FROM mem_items WHERE id = ? AND validity_status != 'retracted'
        `).get(e.dst_item_id) as { id: number; content: string } | undefined;
        if (!row) continue;
        // Discount by depth and edge weight; contradicts edges keep meaningful weight too.
        const inheritedSim = node.similarity * Math.max(0.4, e.weight) * Math.pow(0.7, depth);
        next.push({ itemId: row.id, content: row.content, similarity: inheritedSim, bfsDepth: depth });
      }
    }
    ranked.push(...next);
    frontier = next;
  }

  // Sidecar verify and persist audit
  const audit: Array<{ itemId: number; similarity: number; bfsDepth: number; accepted: boolean; score: number; reason: string }> = [];
  const insertAudit = db.prepare(`
    INSERT INTO mem_recall_audit
      (turn_id, session_id, user_id, item_id, similarity, bfs_depth, sidecar_accepted, sidecar_score, sidecar_reason)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const c of ranked) {
    const verdict = await sidecarVerify(turn.content, { id: c.itemId, content: c.content, similarity: c.similarity });
    insertAudit.run(
      params.turnId,
      params.sessionId,
      params.userId,
      c.itemId,
      c.similarity,
      c.bfsDepth,
      verdict.accepted ? 1 : 0,
      verdict.score,
      verdict.reason,
    );
    audit.push({ itemId: c.itemId, similarity: c.similarity, bfsDepth: c.bfsDepth, ...verdict });
  }

  return audit;
}

/**
 * Get the verified shortlist for the most recent turn in a session that has
 * a recall audit. Used by the runner before assembling the next prompt.
 */
export function getLatestRecallShortlist(params: {
  sessionId: string;
  userId: string;
  limit?: number;
}): Array<{
  itemId: number;
  content: string;
  memoryType: string;
  scope: string;
  similarity: number;
  bfsDepth: number;
  sidecarScore: number;
  reason: string;
  turnId: number;
}> {
  const db = getDb();
  const limit = params.limit ?? 8;
  // Single-use semantics (turn N → N+1): pick the most recent turn that
  // still has accepted-but-not-yet-injected audit rows. Once a shortlist
  // has been marked injected, the same turn must NOT resurface again on
  // subsequent recalls — otherwise the same memories would get re-injected
  // every turn until a newer audit exists.
  const lastTurn = db.prepare(`
    SELECT MAX(a.turn_id) as turn_id FROM mem_recall_audit a
    WHERE a.session_id = ? AND a.user_id = ?
      AND a.sidecar_accepted = 1 AND a.injected = 0
  `).get(params.sessionId, params.userId) as { turn_id: number | null } | undefined;
  if (!lastTurn?.turn_id) return [];

  const rows = db.prepare(`
    SELECT a.item_id, a.similarity, a.bfs_depth, a.sidecar_score, a.sidecar_reason, a.turn_id,
           mi.content, mi.memory_type, mi.scope
    FROM mem_recall_audit a
    JOIN mem_items mi ON mi.id = a.item_id
    WHERE a.turn_id = ? AND a.sidecar_accepted = 1 AND a.injected = 0
      AND mi.validity_status != 'retracted'
    ORDER BY a.sidecar_score DESC, a.similarity DESC
    LIMIT ?
  `).all(lastTurn.turn_id, limit) as Array<{
    item_id: number; similarity: number; bfs_depth: number;
    sidecar_score: number; sidecar_reason: string; turn_id: number;
    content: string; memory_type: string; scope: string;
  }>;

  return rows.map(r => ({
    itemId: r.item_id,
    content: r.content,
    memoryType: r.memory_type,
    scope: r.scope,
    similarity: r.similarity,
    bfsDepth: r.bfs_depth,
    sidecarScore: r.sidecar_score,
    reason: r.sidecar_reason,
    turnId: r.turn_id,
  }));
}

/** Mark audit rows for a given turn as injected (idempotent). */
export function markRecallInjected(turnId: number, itemIds: number[]): number {
  if (itemIds.length === 0) return 0;
  const db = getDb();
  const result = db.prepare(`
    UPDATE mem_recall_audit SET injected = 1
    WHERE turn_id = ? AND item_id IN (${itemIds.map(() => "?").join(",")})
  `).run(turnId, ...itemIds);
  return result.changes;
}

/** List recall-audit entries for the dashboard. */
export function listRecallAudit(params: {
  userId: string;
  sessionId?: string;
  limit?: number;
  offset?: number;
}): Array<{
  id: number;
  turnId: number;
  sessionId: string;
  itemId: number;
  itemContent: string;
  memoryType: string;
  scope: string;
  turnExcerpt: string;
  similarity: number;
  bfsDepth: number;
  sidecarAccepted: boolean;
  sidecarScore: number | null;
  sidecarReason: string | null;
  injected: boolean;
  createdAt: number;
}> {
  const db = getDb();
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;
  const rows = db.prepare(`
    SELECT a.id, a.turn_id, a.session_id, a.item_id, a.similarity, a.bfs_depth,
           a.sidecar_accepted, a.sidecar_score, a.sidecar_reason, a.injected, a.created_at,
           t.content as turn_content,
           mi.content as item_content, mi.memory_type, mi.scope
    FROM mem_recall_audit a
    LEFT JOIN mem_turns t ON t.id = a.turn_id
    LEFT JOIN mem_items mi ON mi.id = a.item_id
    WHERE a.user_id = ?
      ${params.sessionId ? "AND a.session_id = ?" : ""}
    ORDER BY a.created_at DESC
    LIMIT ? OFFSET ?
  `).all(...[params.userId, ...(params.sessionId ? [params.sessionId] : []), limit, offset]) as Array<{
    id: number; turn_id: number; session_id: string; item_id: number;
    similarity: number; bfs_depth: number; sidecar_accepted: number;
    sidecar_score: number | null; sidecar_reason: string | null;
    injected: number; created_at: number;
    turn_content: string | null; item_content: string | null;
    memory_type: string | null; scope: string | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    turnId: r.turn_id,
    sessionId: r.session_id,
    itemId: r.item_id,
    itemContent: r.item_content ?? "",
    memoryType: r.memory_type ?? "",
    scope: r.scope ?? "",
    turnExcerpt: (r.turn_content ?? "").slice(0, 240),
    similarity: r.similarity,
    bfsDepth: r.bfs_depth,
    sidecarAccepted: r.sidecar_accepted === 1,
    sidecarScore: r.sidecar_score,
    sidecarReason: r.sidecar_reason,
    injected: r.injected === 1,
    createdAt: r.created_at,
  }));
}

/** Aggregate metrics for the dashboard's passive-recall card. */
export function getRecallMetrics(userId: string): {
  enabled: boolean;
  totalCandidates: number;
  acceptedCandidates: number;
  injectedCandidates: number;
  acceptRate: number;
  injectRate: number;
  uniqueTurns: number;
  avgInjectedTokensEstimate: number;
} {
  const db = getDb();
  const row = db.prepare(`
    SELECT
      COUNT(*) as total,
      SUM(CASE WHEN sidecar_accepted = 1 THEN 1 ELSE 0 END) as accepted,
      SUM(CASE WHEN injected = 1 THEN 1 ELSE 0 END) as injected,
      COUNT(DISTINCT turn_id) as turns
    FROM mem_recall_audit WHERE user_id = ?
  `).get(userId) as { total: number; accepted: number; injected: number; turns: number };

  const charsRow = db.prepare(`
    SELECT AVG(LENGTH(mi.content)) as avg_len
    FROM mem_recall_audit a
    JOIN mem_items mi ON mi.id = a.item_id
    WHERE a.user_id = ? AND a.injected = 1
  `).get(userId) as { avg_len: number | null } | undefined;

  const totalCandidates = row.total ?? 0;
  const acceptedCandidates = row.accepted ?? 0;
  const injectedCandidates = row.injected ?? 0;
  const turns = row.turns ?? 0;
  const avgInjectedTokensEstimate = injectedCandidates > 0
    ? Math.round(((charsRow?.avg_len ?? 0) / 4) * (injectedCandidates / Math.max(1, turns)))
    : 0;

  return {
    enabled: passiveRecallGloballyEnabled(),
    totalCandidates,
    acceptedCandidates,
    injectedCandidates,
    acceptRate: totalCandidates > 0 ? acceptedCandidates / totalCandidates : 0,
    injectRate: acceptedCandidates > 0 ? injectedCandidates / acceptedCandidates : 0,
    uniqueTurns: turns,
    avgInjectedTokensEstimate,
  };
}
