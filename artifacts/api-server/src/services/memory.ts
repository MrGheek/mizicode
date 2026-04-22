import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";
import { EventEmitter } from "events";
import { logger } from "../lib/logger";

const observationEmitter = new EventEmitter();
observationEmitter.setMaxListeners(200);

export function subscribeToObservations(userId: string, handler: (obs: Observation) => void): () => void {
  const event = `observation:${userId}`;
  observationEmitter.on(event, handler);
  return () => observationEmitter.off(event, handler);
}

const DATA_DIR = process.env["MEM_DATA_DIR"] || path.join(os.homedir(), "omniql-memory");
const DB_PATH = path.join(DATA_DIR, "mem.db");

/**
 * Validate that the memory data directory is writable at startup.
 *
 * Called once from index.ts before the server accepts requests.  Throws with
 * a descriptive message if the directory cannot be created or written to so
 * that the process exits immediately instead of silently falling back to an
 * unexpected path or losing data.
 *
 * On success it logs the resolved DB path so operators can confirm the correct
 * volume is mounted at deploy time.
 */
export function validateMemoryDataDir(): void {
  const source = process.env["MEM_DATA_DIR"] ? "MEM_DATA_DIR env var" : "default (~omniql-memory)";

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    const msg =
      `[mem] FATAL: Cannot create memory data directory "${DATA_DIR}" (source: ${source}). ` +
      `Ensure the directory exists and is writable, or that the volume is mounted correctly. ` +
      `The server will not start without a writable data directory.`;
    logger.error({ err, DATA_DIR, source }, msg);
    throw new Error(msg);
  }

  // Verify writability with a probe file — directory creation alone does not
  // guarantee writes succeed (e.g. read-only volume mounts).
  // Use a per-process unique filename to avoid races when multiple processes
  // start against the same directory simultaneously.
  const probe = path.join(DATA_DIR, `.write-probe-${process.pid}-${Date.now()}`);
  try {
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
  } catch (err) {
    const msg =
      `[mem] FATAL: Memory data directory "${DATA_DIR}" exists but is not writable (source: ${source}). ` +
      `Check volume mount permissions. The server will not start without a writable data directory.`;
    logger.error({ err, DATA_DIR, source }, msg);
    throw new Error(msg);
  }

  logger.info(
    { DATA_DIR, DB_PATH, source },
    "[mem] Memory data directory validated — database will be stored at DB_PATH"
  );
}

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  // Directory is already validated at startup via validateMemoryDataDir().
  // mkdirSync here is a last-resort safety net for the lazy-init path only.
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    logger.error({ err, DATA_DIR }, "[mem] FATAL: Could not create memory data directory at DB init time");
    throw new Error(`[mem] Cannot create memory data directory "${DATA_DIR}": ${String(err)}`);
  }

  logger.info({ db: DB_PATH }, "Memory database initializing");

  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");

  _db.exec(`
    CREATE TABLE IF NOT EXISTS mem_sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      project_path TEXT NOT NULL DEFAULT '',
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at INTEGER,
      summary TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_mem_sessions_user ON mem_sessions(user_id);

    CREATE TABLE IF NOT EXISTS mem_observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL REFERENCES mem_sessions(id),
      user_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      input_summary TEXT NOT NULL DEFAULT '',
      output_summary TEXT NOT NULL DEFAULT '',
      recorded_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE INDEX IF NOT EXISTS idx_mem_obs_session ON mem_observations(session_id);
    CREATE INDEX IF NOT EXISTS idx_mem_obs_user ON mem_observations(user_id);

    CREATE VIRTUAL TABLE IF NOT EXISTS mem_observations_fts USING fts5(
      tool_name, input_summary, output_summary,
      content=mem_observations,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS obs_ai AFTER INSERT ON mem_observations BEGIN
      INSERT INTO mem_observations_fts(rowid, tool_name, input_summary, output_summary)
        VALUES (new.id, new.tool_name, new.input_summary, new.output_summary);
    END;
  `);

  runGovernanceMigrations(_db);

  return _db;
}

function runGovernanceMigrations(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS mem_conflict_groups (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      scope TEXT NOT NULL DEFAULT 'session_core',
      conflict_status TEXT NOT NULL DEFAULT 'open',
      first_item_id INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_mem_cg_user ON mem_conflict_groups(user_id);
    CREATE INDEX IF NOT EXISTS idx_mem_cg_status ON mem_conflict_groups(conflict_status);

    CREATE TABLE IF NOT EXISTS mem_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id TEXT NOT NULL,
      session_id TEXT,
      memory_type TEXT NOT NULL DEFAULT 'observation',
      scope TEXT NOT NULL DEFAULT 'session_core',
      content TEXT NOT NULL DEFAULT '',
      symbol_ref TEXT,
      content_hash_at_save TEXT,
      validity_status TEXT NOT NULL DEFAULT 'valid',
      stale_status TEXT NOT NULL DEFAULT 'fresh',
      ttl_expires_at INTEGER,
      access_count INTEGER NOT NULL DEFAULT 0,
      retrieval_count INTEGER NOT NULL DEFAULT 0,
      injection_count INTEGER NOT NULL DEFAULT 0,
      layer3_count INTEGER NOT NULL DEFAULT 0,
      roi_score REAL NOT NULL DEFAULT 0.0,
      promoted_from INTEGER,
      promotion_status TEXT NOT NULL DEFAULT 'none',
      conflict_group_id INTEGER REFERENCES mem_conflict_groups(id),
      conflict_status TEXT NOT NULL DEFAULT 'none',
      last_used_at INTEGER,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
      metadata_json TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mem_items_user ON mem_items(user_id);
    CREATE INDEX IF NOT EXISTS idx_mem_items_scope ON mem_items(scope);
    CREATE INDEX IF NOT EXISTS idx_mem_items_type ON mem_items(memory_type);
    CREATE INDEX IF NOT EXISTS idx_mem_items_roi ON mem_items(roi_score DESC);
    CREATE INDEX IF NOT EXISTS idx_mem_items_stale ON mem_items(stale_status);
    CREATE INDEX IF NOT EXISTS idx_mem_items_conflict ON mem_items(conflict_group_id);
    CREATE INDEX IF NOT EXISTS idx_mem_items_symbol ON mem_items(symbol_ref);

    CREATE VIRTUAL TABLE IF NOT EXISTS mem_items_fts USING fts5(
      content, memory_type, scope,
      content=mem_items,
      content_rowid=id
    );

    CREATE TRIGGER IF NOT EXISTS mem_items_ai AFTER INSERT ON mem_items BEGIN
      INSERT INTO mem_items_fts(rowid, content, memory_type, scope)
        VALUES (new.id, new.content, new.memory_type, new.scope);
    END;

    CREATE TRIGGER IF NOT EXISTS mem_items_au AFTER UPDATE OF content ON mem_items BEGIN
      INSERT INTO mem_items_fts(mem_items_fts, rowid, content, memory_type, scope)
        VALUES ('delete', old.id, old.content, old.memory_type, old.scope);
      INSERT INTO mem_items_fts(rowid, content, memory_type, scope)
        VALUES (new.id, new.content, new.memory_type, new.scope);
    END;

    CREATE TABLE IF NOT EXISTS mem_promotion_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      item_id INTEGER NOT NULL REFERENCES mem_items(id),
      from_type TEXT NOT NULL,
      to_type TEXT NOT NULL,
      from_status TEXT NOT NULL,
      to_status TEXT NOT NULL,
      roi_score_at_promotion REAL,
      promoted_at INTEGER NOT NULL DEFAULT (unixepoch()),
      promoted_by TEXT NOT NULL DEFAULT 'auto',
      notes TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_mem_promo_item ON mem_promotion_history(item_id);
  `);

  // Migrations: add governance columns to pre-existing mem_items schemas.
  // Each ALTER TABLE is wrapped in try/catch; SQLite throws if column already exists.
  const safeAlter = (sql: string) => { try { db.prepare(sql).run(); } catch { /* already exists */ } };
  safeAlter(`ALTER TABLE mem_items ADD COLUMN layer3_count INTEGER NOT NULL DEFAULT 0`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN stale_status TEXT NOT NULL DEFAULT 'fresh'`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN validity_status TEXT NOT NULL DEFAULT 'valid'`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN conflict_status TEXT NOT NULL DEFAULT 'none'`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN conflict_group_id INTEGER`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN promoted_from INTEGER`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN content_hash_at_save TEXT`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN roi_score REAL NOT NULL DEFAULT 0.0`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN access_count INTEGER NOT NULL DEFAULT 0`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN retrieval_count INTEGER NOT NULL DEFAULT 0`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN injection_count INTEGER NOT NULL DEFAULT 0`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN promotion_status TEXT NOT NULL DEFAULT 'none'`);
  safeAlter(`ALTER TABLE mem_items ADD COLUMN last_used_at INTEGER`);
}

export type MemoryType = "observation" | "research" | "session_summary" | "convention" | "guardrail" | "note" | "warning";
export type MemoryScope = "task" | "lane_user" | "repo_shared" | "session_core" | "user_operator" | "global";
export type ConflictStatus = "none" | "open" | "reviewed" | "resolved" | "accepted_override";
export type StaleStatus = "fresh" | "stale" | "invalidated";
export type ValidityStatus = "valid" | "superseded" | "retracted";
export type PromotionStatus = "none" | "candidate" | "promoted" | "demoted";

export const SCOPE_PRIORITY: MemoryScope[] = ["task", "lane_user", "repo_shared", "session_core", "user_operator", "global"];

/**
 * Resolve the appropriate default scope and retrieval scope order based on the session type.
 *
 * - "team"  → save default is `lane_user` (user-attributed but team-visible);
 *             retrieval prioritises task → lane_user → repo_shared first so shared
 *             team knowledge surfaces before private session state.
 * - "solo"  → save default is `session_core` (private to the session);
 *             retrieval uses the canonical SCOPE_PRIORITY order.
 * - unset   → falls back to "solo" semantics.
 */
export function resolveSessionScopePolicy(sessionType?: string): {
  defaultScope: MemoryScope;
  retrievalOrder: MemoryScope[];
} {
  if (sessionType === "team") {
    return {
      defaultScope: "lane_user",
      retrievalOrder: ["task", "lane_user", "repo_shared", "session_core", "user_operator", "global"],
    };
  }
  return {
    defaultScope: "session_core",
    retrievalOrder: SCOPE_PRIORITY,
  };
}

export const TTL_BY_TYPE: Record<MemoryType, number | null> = {
  observation: 7 * 86400,
  research: 30 * 86400,
  session_summary: 60 * 86400,
  convention: 365 * 86400,
  guardrail: 365 * 86400,
  note: 30 * 86400,
  warning: 14 * 86400,
};

export const DECAY_RATE_BY_TYPE: Record<MemoryType, number> = {
  observation: 0.95,
  research: 0.5,
  session_summary: 0.3,
  convention: 0.05,
  guardrail: 0.05,
  note: 0.5,
  warning: 0.7,
};

export interface MemoryBudgetProfile {
  memoryCandidateCount: number;
  memoryLayerAccess: 1 | 2 | 3;
  memoryStaleSuppressionStrength: "strict" | "moderate" | "off";
  memoryMetadataVerbosity: "compact" | "standard" | "full";
  memoryContradictionSurfacing: "off" | "hint" | "full";
}

export const BUDGET_PROFILES_BY_MODE: Record<string, MemoryBudgetProfile> = {
  full: {
    memoryCandidateCount: 20,
    memoryLayerAccess: 3,
    memoryStaleSuppressionStrength: "moderate",
    memoryMetadataVerbosity: "full",
    memoryContradictionSurfacing: "full",
  },
  core: {
    memoryCandidateCount: 10,
    memoryLayerAccess: 2,
    memoryStaleSuppressionStrength: "moderate",
    memoryMetadataVerbosity: "standard",
    memoryContradictionSurfacing: "hint",
  },
  lean: {
    memoryCandidateCount: 5,
    memoryLayerAccess: 1,
    memoryStaleSuppressionStrength: "strict",
    memoryMetadataVerbosity: "compact",
    memoryContradictionSurfacing: "off",
  },
  ultra: {
    memoryCandidateCount: 3,
    memoryLayerAccess: 1,
    memoryStaleSuppressionStrength: "strict",
    memoryMetadataVerbosity: "compact",
    memoryContradictionSurfacing: "off",
  },
};

export interface MemoryItem {
  id: number;
  userId: string;
  sessionId: string | null;
  memoryType: MemoryType;
  scope: MemoryScope;
  content: string;
  symbolRef: string | null;
  contentHashAtSave: string | null;
  validityStatus: ValidityStatus;
  staleStatus: StaleStatus;
  ttlExpiresAt: number | null;
  accessCount: number;
  retrievalCount: number;
  injectionCount: number;
  roiScore: number;
  promotedFrom: number | null;
  promotionStatus: PromotionStatus;
  conflictGroupId: number | null;
  conflictStatus: ConflictStatus;
  lastUsedAt: number | null;
  createdAt: number;
  updatedAt: number;
  metadataJson: Record<string, unknown> | null;
}

export interface ConflictGroup {
  id: number;
  userId: string;
  scope: MemoryScope;
  conflictStatus: ConflictStatus;
  firstItemId: number | null;
  createdAt: number;
  updatedAt: number;
}

export interface PromotionHistoryEntry {
  id: number;
  itemId: number;
  fromType: string;
  toType: string;
  fromStatus: string;
  toStatus: string;
  roiScoreAtPromotion: number | null;
  promotedAt: number;
  promotedBy: string;
  notes: string | null;
}

function rowToMemoryItem(row: Record<string, unknown>): MemoryItem {
  return {
    id: row["id"] as number,
    userId: row["user_id"] as string,
    sessionId: row["session_id"] as string | null,
    memoryType: row["memory_type"] as MemoryType,
    scope: row["scope"] as MemoryScope,
    content: row["content"] as string,
    symbolRef: row["symbol_ref"] as string | null,
    contentHashAtSave: row["content_hash_at_save"] as string | null,
    validityStatus: row["validity_status"] as ValidityStatus,
    staleStatus: row["stale_status"] as StaleStatus,
    ttlExpiresAt: row["ttl_expires_at"] as number | null,
    accessCount: row["access_count"] as number,
    retrievalCount: row["retrieval_count"] as number,
    injectionCount: row["injection_count"] as number,
    roiScore: row["roi_score"] as number,
    promotedFrom: row["promoted_from"] as number | null,
    promotionStatus: row["promotion_status"] as PromotionStatus,
    conflictGroupId: row["conflict_group_id"] as number | null,
    conflictStatus: row["conflict_status"] as ConflictStatus,
    lastUsedAt: row["last_used_at"] as number | null,
    createdAt: row["created_at"] as number,
    updatedAt: row["updated_at"] as number,
    metadataJson: row["metadata_json"] ? JSON.parse(row["metadata_json"] as string) : null,
  };
}

function computeContentHash(content: string): string {
  const words = content.toLowerCase().split(/\s+/).sort();
  let hash = 0;
  for (const w of words) {
    for (let i = 0; i < w.length; i++) {
      hash = ((hash << 5) - hash) + w.charCodeAt(i);
      hash |= 0;
    }
  }
  return Math.abs(hash).toString(16).padStart(8, "0");
}

function lexicalOverlapScore(a: string, b: string): number {
  const tokenize = (s: string) => new Set(s.toLowerCase().split(/\W+/).filter(t => t.length > 2));
  const setA = tokenize(a);
  const setB = tokenize(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let intersection = 0;
  for (const tok of setA) {
    if (setB.has(tok)) intersection++;
  }
  return intersection / (setA.size + setB.size - intersection);
}

function computeRoiScore(item: { access_count: number; retrieval_count: number; injection_count: number; created_at: number; memory_type?: string }): number {
  const ageDays = Math.max(1, (Date.now() / 1000 - item.created_at) / 86400);
  const raw = item.access_count * 1 + item.retrieval_count * 2 + item.injection_count * 3;
  const baseRoi = raw / ageDays;
  // Apply per-type temporal decay: higher DECAY_RATE_BY_TYPE = faster ROI erosion with age
  const decayRate = item.memory_type ? (DECAY_RATE_BY_TYPE[item.memory_type as MemoryType] ?? 0.3) : 0.3;
  const ageWeeks = ageDays / 7;
  const decayFactor = Math.exp(-decayRate * ageWeeks);
  return baseRoi * decayFactor;
}

const PROMOTION_THRESHOLDS: Record<string, { targetType: MemoryType; roiMin: number; injectionMin: number; highConfidenceRoi: number }> = {
  note: { targetType: "convention", roiMin: 10.0, injectionMin: 5, highConfidenceRoi: 20.0 },
  warning: { targetType: "guardrail", roiMin: 8.0, injectionMin: 3, highConfidenceRoi: 15.0 },
};

function checkAutoPromotion(
  db: Database.Database,
  itemId: number,
  item: { memory_type: string; promotion_status: string; roi_score: number; injection_count: number; access_count: number; retrieval_count: number }
): void {
  const rule = PROMOTION_THRESHOLDS[item.memory_type];
  if (!rule) return;
  if (item.roi_score < rule.roiMin || item.injection_count < rule.injectionMin) return;

  const isHighConfidence = item.roi_score >= rule.highConfidenceRoi;
  const newPromotionStatus: PromotionStatus = isHighConfidence ? "promoted" : "candidate";
  const newType = isHighConfidence ? rule.targetType : item.memory_type;

  // Only update if status would change (avoid duplicate history entries)
  if (item.promotion_status === newPromotionStatus && item.memory_type === newType) return;

  db.prepare(`
    UPDATE mem_items SET
      promotion_status = ?,
      memory_type = ?,
      -- promoted_from = self means in-place type-morph auto-promotion; used for lineage tracking
      promoted_from = COALESCE(promoted_from, ?),
      updated_at = unixepoch()
    WHERE id = ?
  `).run(newPromotionStatus, newType, itemId, itemId);

  db.prepare(`
    INSERT INTO mem_promotion_history (item_id, from_type, to_type, from_status, to_status, roi_score_at_promotion, promoted_by)
    VALUES (?, ?, ?, ?, ?, ?, 'auto')
  `).run(
    itemId,
    item.memory_type,
    newType,
    item.promotion_status,
    newPromotionStatus,
    item.roi_score
  );

  logger.info({ itemId, fromType: item.memory_type, toType: newType, promotionStatus: newPromotionStatus }, "[mem] Auto-promotion candidate created");
}

export function saveMemoryItem(params: {
  userId: string;
  sessionId?: string;
  /** Session type ("team" | "solo") drives default scope when scope is not explicitly provided. */
  sessionType?: string;
  memoryType: MemoryType;
  /** Explicit scope. When omitted, resolved from sessionType via resolveSessionScopePolicy. */
  scope?: MemoryScope;
  content: string;
  symbolRef?: string;
  symbolContentHash?: string;
  metadata?: Record<string, unknown>;
}): { itemId: number; conflictGroupId: number | null; contradictions: number[] } {
  const db = getDb();
  const { userId, sessionId, sessionType, memoryType, content, symbolRef, symbolContentHash, metadata } = params;
  // Derive scope: caller-provided wins; fall back to session-type-aware default
  const scope: MemoryScope = params.scope ?? resolveSessionScopePolicy(sessionType).defaultScope;

  // Warn when symbolRef is set but symbolContentHash is absent — staleness detection falls back
  // to hashing memory content, which can over-mark entries stale on re-save of identical symbols.
  if (symbolRef && !symbolContentHash) {
    logger.warn({ userId, symbolRef }, "[mem] symbolRef provided without symbolContentHash; staleness detection will use content hash fallback — callers should supply symbolContentHash for accurate symbol staleness tracking");
  }

  const now = Math.floor(Date.now() / 1000);
  const ttlSecs = TTL_BY_TYPE[memoryType];
  const ttlExpiresAt = ttlSecs ? now + ttlSecs : null;
  const contentHash = computeContentHash(content);

  const nearbyScopes = getScopeAndNearby(scope);

  const candidateRows = db.prepare(`
    SELECT id, content, memory_type, conflict_group_id, conflict_status
    FROM mem_items
    WHERE user_id = ?
      AND scope IN (${nearbyScopes.map(() => "?").join(",")})
      AND validity_status = 'valid'
      AND stale_status != 'invalidated'
    ORDER BY roi_score DESC
    LIMIT 50
  `).all(userId, ...nearbyScopes) as Array<{
    id: number;
    content: string;
    memory_type: string;
    conflict_group_id: number | null;
    conflict_status: string;
  }>;

  const contradictions: number[] = [];
  let conflictGroupId: number | null = null;

  const CONTRADICTION_THRESHOLD = 0.4;
  // Feature flag: set OMNIQL_MEM_SEMANTIC_CONTRADICTION=1 to enable embedding-based
  // semantic overlap as a secondary signal alongside lexical Jaccard.
  // When enabled (future), semantic similarity will be computed via an embedding API call
  // and averaged with the lexical score before threshold comparison.
  const semanticContradictionEnabled = process.env["OMNIQL_MEM_SEMANTIC_CONTRADICTION"] === "1";

  for (const candidate of candidateRows) {
    const lexScore = lexicalOverlapScore(content, candidate.content);
    // IMPORTANT: Contradiction detection is currently lexical-only (Jaccard).
    // Semantic path: currently a stub (returns 0); when enabled but unavailable (semScore = 0),
    // fall back to lexical-only so detection is NOT diluted. Only blend when semantic data
    // is actually available (semScore > 0). TODO: replace 0 with real embedding API call.
    const semScore = semanticContradictionEnabled ? 0 : 0; // TODO: embedding API call when enabled
    const finalScore = semanticContradictionEnabled && semScore > 0
      ? (lexScore + semScore) / 2  // blend only when semantic result is available
      : lexScore;                  // lexical-only fallback (default and stub path)
    if (finalScore >= CONTRADICTION_THRESHOLD) {
      contradictions.push(candidate.id);
    }
  }

  if (contradictions.length > 0) {
    const existing = db.prepare(`
      SELECT cg.id FROM mem_conflict_groups cg
      JOIN mem_items mi ON mi.conflict_group_id = cg.id
      WHERE mi.id = ? AND cg.conflict_status = 'open'
    `).get(contradictions[0]) as { id: number } | undefined;

    if (existing) {
      conflictGroupId = existing.id;
      db.prepare(`
        UPDATE mem_conflict_groups SET updated_at = unixepoch() WHERE id = ?
      `).run(conflictGroupId);
    } else {
      const res = db.prepare(`
        INSERT INTO mem_conflict_groups (user_id, scope, conflict_status)
        VALUES (?, ?, 'open')
      `).run(userId, scope);
      conflictGroupId = Number(res.lastInsertRowid);
    }

    for (const cid of contradictions) {
      db.prepare(`
        UPDATE mem_items SET conflict_group_id = ?, conflict_status = 'open', updated_at = unixepoch()
        WHERE id = ? AND (conflict_group_id IS NULL OR conflict_status = 'none')
      `).run(conflictGroupId, cid);
    }

    if (conflictGroupId) {
      db.prepare(`
        UPDATE mem_conflict_groups SET first_item_id = ? WHERE id = ? AND first_item_id IS NULL
      `).run(contradictions[0], conflictGroupId);
    }
  }

  const result = db.prepare(`
    INSERT INTO mem_items
      (user_id, session_id, memory_type, scope, content, symbol_ref, content_hash_at_save,
       ttl_expires_at, conflict_group_id, conflict_status, metadata_json)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    userId,
    sessionId || null,
    memoryType,
    scope,
    content,
    symbolRef || null,
    symbolContentHash || contentHash,
    ttlExpiresAt,
    conflictGroupId,
    conflictGroupId ? "open" : "none",
    metadata ? JSON.stringify(metadata) : null
  );

  const itemId = Number(result.lastInsertRowid);

  if (conflictGroupId && conflictGroupId !== null) {
    db.prepare(`
      UPDATE mem_conflict_groups SET first_item_id = ?, updated_at = unixepoch()
      WHERE id = ? AND first_item_id IS NULL
    `).run(itemId, conflictGroupId);
  }

  return { itemId, conflictGroupId, contradictions };
}

function getScopeAndNearby(scope: MemoryScope): MemoryScope[] {
  const idx = SCOPE_PRIORITY.indexOf(scope);
  const nearbyScopes: MemoryScope[] = [scope];
  if (idx > 0) nearbyScopes.push(SCOPE_PRIORITY[idx - 1]);
  if (idx < SCOPE_PRIORITY.length - 1) nearbyScopes.push(SCOPE_PRIORITY[idx + 1]);
  return nearbyScopes;
}

function isStaleByTtl(item: { ttl_expires_at: number | null }): boolean {
  if (!item.ttl_expires_at) return false;
  return Math.floor(Date.now() / 1000) > item.ttl_expires_at;
}

function applyBudgetFilter(items: MemoryItem[], tokenMode: string, includeStale: boolean): MemoryItem[] {
  const profile = BUDGET_PROFILES_BY_MODE[tokenMode] || BUDGET_PROFILES_BY_MODE["core"];

  let filtered = items;
  if (profile.memoryStaleSuppressionStrength === "strict") {
    filtered = filtered.filter(i => i.staleStatus === "fresh" && i.validityStatus === "valid");
  } else if (profile.memoryStaleSuppressionStrength === "moderate") {
    filtered = filtered.filter(i => i.validityStatus === "valid" && (includeStale || i.staleStatus !== "invalidated"));
  }

  return filtered.slice(0, profile.memoryCandidateCount);
}

export function memoryIndex(params: {
  userId: string;
  projectPath?: string;
  scope?: MemoryScope;
  /** Session type ("team" | "solo") — drives retrieval scope ordering when scope is not pinned. */
  sessionType?: string;
  tokenMode?: string;
  limit?: number;
}): MemoryItem[] {
  const db = getDb();
  const { userId, scope, sessionType, tokenMode = "core", limit } = params;
  const profile = BUDGET_PROFILES_BY_MODE[tokenMode] || BUDGET_PROFILES_BY_MODE["core"];
  // Hard-cap to profile budget — callers cannot exceed the token-mode limit
  const maxItems = Math.min(limit ?? profile.memoryCandidateCount, profile.memoryCandidateCount);

  const { retrievalOrder } = resolveSessionScopePolicy(sessionType);
  const scopeFilter = scope
    ? retrievalOrder.slice(0, retrievalOrder.indexOf(scope) + 1).filter(s => retrievalOrder.includes(s))
    : retrievalOrder;

  const now = Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT * FROM mem_items
    WHERE user_id = ?
      AND scope IN (${scopeFilter.map(() => "?").join(",")})
      AND validity_status != 'retracted'
      AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)
      ${profile.memoryStaleSuppressionStrength === "strict" ? "AND stale_status = 'fresh'" : "AND stale_status != 'invalidated'"}
      AND memory_type IN ('convention', 'guardrail', 'note', 'warning', 'session_summary')
    ORDER BY
      CASE memory_type WHEN 'guardrail' THEN 0 WHEN 'convention' THEN 1 ELSE 2 END,
      roi_score DESC
    LIMIT ?
  `).all(userId, ...scopeFilter, now, maxItems) as Record<string, unknown>[];

  const items = rows.map(rowToMemoryItem);

  if (items.length > 0) {
    db.prepare(`
      UPDATE mem_items SET access_count = access_count + 1, last_used_at = unixepoch(), updated_at = unixepoch()
      WHERE id IN (${items.map(() => "?").join(",")})
    `).run(...items.map(i => i.id));

    // Recompute ROI after L1 access so access_count affects promotion eligibility
    const updatedRowsL1 = db.prepare(`
      SELECT id, memory_type, promotion_status, access_count, retrieval_count, injection_count, created_at FROM mem_items
      WHERE id IN (${items.map(() => "?").join(",")})
    `).all(...items.map(i => i.id)) as Array<{ id: number; memory_type: string; promotion_status: string; access_count: number; retrieval_count: number; injection_count: number; created_at: number }>;
    for (const r of updatedRowsL1) {
      const roi = computeRoiScore(r);
      db.prepare(`UPDATE mem_items SET roi_score = ? WHERE id = ?`).run(roi, r.id);
      checkAutoPromotion(db, r.id, { ...r, roi_score: roi });
    }
  }

  return items;
}

export function memorySearch(params: {
  userId: string;
  query: string;
  scope?: MemoryScope;
  /** Session type ("team" | "solo") — drives retrieval scope ordering when scope is not pinned. */
  sessionType?: string;
  memoryType?: MemoryType;
  tokenMode?: string;
  includeStale?: boolean;
  limit?: number;
}): MemoryItem[] {
  const db = getDb();
  const { userId, query, scope, sessionType, memoryType, tokenMode = "core", includeStale = false, limit } = params;
  const profile = BUDGET_PROFILES_BY_MODE[tokenMode] || BUDGET_PROFILES_BY_MODE["core"];
  if (profile.memoryLayerAccess < 2) return [];

  // Hard-cap to profile budget — callers cannot exceed the token-mode limit
  const maxItems = Math.min(limit ?? profile.memoryCandidateCount, profile.memoryCandidateCount);
  const trimmed = query.trim();
  if (!trimmed) return [];

  const { retrievalOrder } = resolveSessionScopePolicy(sessionType);
  const scopeFilter = scope ? [scope] : retrievalOrder;
  const now = Math.floor(Date.now() / 1000);

  const ftsQuery = trimmed
    .split(/\s+/)
    .map(w => `"${w.replace(/"/g, '""')}"*`)
    .join(" ");

  let rows: Record<string, unknown>[] = [];
  try {
    const staleClause = profile.memoryStaleSuppressionStrength === "strict"
      ? "AND mi.stale_status = 'fresh'"
      : includeStale ? "" : "AND mi.stale_status != 'invalidated'";

    const typeClause = memoryType ? "AND mi.memory_type = ?" : "";
    const args: unknown[] = [userId, ...scopeFilter, now];
    if (memoryType) args.push(memoryType);
    args.push(ftsQuery, userId, maxItems);

    rows = db.prepare(`
      SELECT mi.* FROM mem_items_fts fts
      JOIN mem_items mi ON fts.rowid = mi.id
      WHERE mi.user_id = ?
        AND mi.scope IN (${scopeFilter.map(() => "?").join(",")})
        AND mi.validity_status != 'retracted'
        AND (mi.ttl_expires_at IS NULL OR mi.ttl_expires_at > ?)
        ${staleClause}
        ${typeClause}
        AND fts MATCH ?
        AND mi.user_id = ?
      ORDER BY mi.roi_score DESC, mi.created_at DESC
      LIMIT ?
    `).all(...args) as Record<string, unknown>[];
  } catch (err) {
    logger.warn({ err, query }, "[mem] memorySearch FTS failed — falling back to LIKE");
    try {
      const likePattern = `%${trimmed.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
      // Apply the same stale suppression as the primary FTS path so LIKE results are mode-consistent
      const likeStaleClause = profile.memoryStaleSuppressionStrength === "strict"
        ? "AND stale_status = 'fresh'"
        : includeStale ? "" : "AND stale_status != 'invalidated'";
      const args2: unknown[] = [userId, ...scopeFilter, now, likePattern];
      if (memoryType) args2.push(memoryType);
      args2.push(maxItems);
      rows = db.prepare(`
        SELECT * FROM mem_items
        WHERE user_id = ?
          AND scope IN (${scopeFilter.map(() => "?").join(",")})
          AND validity_status != 'retracted'
          AND (ttl_expires_at IS NULL OR ttl_expires_at > ?)
          ${likeStaleClause}
          AND content LIKE ? ESCAPE '\\'
          ${memoryType ? "AND memory_type = ?" : ""}
        ORDER BY roi_score DESC
        LIMIT ?
      `).all(...args2) as Record<string, unknown>[];
    } catch {
      rows = [];
    }
  }

  const items = rows.map(rowToMemoryItem);

  if (items.length > 0) {
    db.prepare(`
      UPDATE mem_items SET retrieval_count = retrieval_count + 1, last_used_at = unixepoch(), updated_at = unixepoch()
      WHERE id IN (${items.map(() => "?").join(",")})
    `).run(...items.map(i => i.id));

    const updatedRows = db.prepare(`
      SELECT id, memory_type, promotion_status, access_count, retrieval_count, injection_count, created_at FROM mem_items
      WHERE id IN (${items.map(() => "?").join(",")})
    `).all(...items.map(i => i.id)) as Array<{ id: number; memory_type: string; promotion_status: string; access_count: number; retrieval_count: number; injection_count: number; created_at: number }>;

    for (const r of updatedRows) {
      const roi = computeRoiScore(r);
      db.prepare(`UPDATE mem_items SET roi_score = ? WHERE id = ?`).run(roi, r.id);
      checkAutoPromotion(db, r.id, { ...r, roi_score: roi });
    }
  }

  return items;
}

export function memoryGet(params: {
  userId: string;
  itemId: number;
  tokenMode?: string;
  escalate?: boolean;
}): MemoryItem | null {
  const db = getDb();
  const { userId, itemId, tokenMode = "core", escalate = false } = params;
  const profile = BUDGET_PROFILES_BY_MODE[tokenMode] || BUDGET_PROFILES_BY_MODE["core"];

  if (profile.memoryLayerAccess < 3 && !escalate) {
    return null;
  }

  const row = db.prepare(`
    SELECT * FROM mem_items WHERE id = ? AND user_id = ?
  `).get(itemId, userId) as Record<string, unknown> | undefined;

  if (!row) return null;

  db.prepare(`
    UPDATE mem_items SET access_count = access_count + 1, layer3_count = layer3_count + 1, last_used_at = unixepoch(), updated_at = unixepoch()
    WHERE id = ?
  `).run(itemId);

  // Recompute ROI after L3 access so access_count + layer3_count affect promotion eligibility
  const updatedRowL3 = db.prepare(`
    SELECT id, memory_type, promotion_status, access_count, retrieval_count, injection_count, created_at FROM mem_items WHERE id = ?
  `).get(itemId) as { id: number; memory_type: string; promotion_status: string; access_count: number; retrieval_count: number; injection_count: number; created_at: number } | undefined;
  if (updatedRowL3) {
    const roi = computeRoiScore(updatedRowL3);
    db.prepare(`UPDATE mem_items SET roi_score = ? WHERE id = ?`).run(roi, itemId);
    checkAutoPromotion(db, itemId, { ...updatedRowL3, roi_score: roi });
  }

  const item = rowToMemoryItem(row);
  return item;
}

export function markItemInjected(userId: string, itemIds: number[]): void {
  if (itemIds.length === 0) return;
  const db = getDb();
  // Scope by userId to prevent cross-tenant counter manipulation
  db.prepare(`
    UPDATE mem_items SET injection_count = injection_count + 1, last_used_at = unixepoch(), updated_at = unixepoch()
    WHERE user_id = ? AND id IN (${itemIds.map(() => "?").join(",")})
  `).run(userId, ...itemIds);

  const rows = db.prepare(`
    SELECT id, memory_type, promotion_status, access_count, retrieval_count, injection_count, roi_score, created_at
    FROM mem_items WHERE user_id = ? AND id IN (${itemIds.map(() => "?").join(",")})
  `).all(userId, ...itemIds) as Array<{ id: number; memory_type: string; promotion_status: string; access_count: number; retrieval_count: number; injection_count: number; roi_score: number; created_at: number }>;

  for (const r of rows) {
    const roi = computeRoiScore(r);
    db.prepare(`UPDATE mem_items SET roi_score = ? WHERE id = ? AND user_id = ?`).run(roi, r.id, userId);
    checkAutoPromotion(db, r.id, { ...r, roi_score: roi });
  }
}

/** Shape a MemoryItem based on the token-mode budget profile.
 *
 * - `compact`: minimal fields for tight token budgets (id, content, type, scope, ROI)
 * - `standard`: most fields, drops low-value metadata (metadataJson, contentHashAtSave)
 * - `full`: all fields
 *
 * Contradiction info is surfaced according to `memoryContradictionSurfacing`:
 * - `off`: no conflict fields
 * - `hint`: adds a boolean `hasConflict` flag
 * - `full`: includes conflictGroupId + conflictStatus
 */
export function shapeItemForProfile(
  item: MemoryItem,
  profile: MemoryBudgetProfile
): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: item.id,
    content: item.content,
    memoryType: item.memoryType,
    scope: item.scope,
    roiScore: item.roiScore,
  };

  if (profile.memoryMetadataVerbosity === "standard" || profile.memoryMetadataVerbosity === "full") {
    base["staleStatus"] = item.staleStatus;
    base["validityStatus"] = item.validityStatus;
    base["promotionStatus"] = item.promotionStatus;
    base["accessCount"] = item.accessCount;
    base["injectionCount"] = item.injectionCount;
    base["ttlExpiresAt"] = item.ttlExpiresAt;
    base["symbolRef"] = item.symbolRef;
    base["createdAt"] = item.createdAt;
    base["lastUsedAt"] = item.lastUsedAt;
  }

  if (profile.memoryMetadataVerbosity === "full") {
    base["retrievalCount"] = item.retrievalCount;
    base["contentHashAtSave"] = item.contentHashAtSave;
    base["metadataJson"] = item.metadataJson;
    base["promotedFrom"] = item.promotedFrom;
    base["updatedAt"] = item.updatedAt;
  }

  // Contradiction surfacing
  if (profile.memoryContradictionSurfacing === "hint") {
    base["hasConflict"] = item.conflictStatus === "open" || item.conflictGroupId != null;
  } else if (profile.memoryContradictionSurfacing === "full") {
    base["hasConflict"] = item.conflictStatus === "open" || item.conflictGroupId != null;
    base["conflictGroupId"] = item.conflictGroupId;
    base["conflictStatus"] = item.conflictStatus;
  }

  return base;
}

export function markSymbolStale(userId: string, symbolRef: string, newContentHash: string): number {
  const db = getDb();
  // userId scoping prevents cross-tenant staleness side-effects when symbol refs are not globally unique
  const result = db.prepare(`
    UPDATE mem_items SET stale_status = 'stale', updated_at = unixepoch()
    WHERE user_id = ?
      AND symbol_ref = ?
      AND (content_hash_at_save != ? OR content_hash_at_save IS NULL)
      AND stale_status = 'fresh'
      AND validity_status != 'retracted'
  `).run(userId, symbolRef, newContentHash);
  return result.changes;
}

/**
 * Mark all symbol-bearing memory items for a session as stale.
 * Called automatically by the repo-graph sync when a fingerprint-hash divergence
 * is detected, indicating that repo content has changed since items were saved.
 *
 * @param sessionId  The session identifier (stored as TEXT in mem_items.session_id).
 * @returns Number of items marked stale.
 */
export function markSymbolsStaleForSession(sessionId: string): number {
  const db = getDb();
  const result = db.prepare(`
    UPDATE mem_items SET stale_status = 'stale', updated_at = unixepoch()
    WHERE session_id = ?
      AND symbol_ref IS NOT NULL
      AND stale_status = 'fresh'
      AND validity_status != 'retracted'
  `).run(sessionId);
  return result.changes;
}

export function listConflicts(params: {
  userId: string;
  conflictStatus?: ConflictStatus;
  limit?: number;
  offset?: number;
}): { group: ConflictGroup; items: MemoryItem[] }[] {
  const db = getDb();
  const { userId, conflictStatus = "open", limit = 20, offset = 0 } = params;

  const groups = db.prepare(`
    SELECT * FROM mem_conflict_groups
    WHERE user_id = ? AND conflict_status = ?
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, conflictStatus, limit, offset) as Array<{
    id: number;
    user_id: string;
    scope: string;
    conflict_status: string;
    first_item_id: number | null;
    created_at: number;
    updated_at: number;
  }>;

  return groups.map(g => {
    const items = db.prepare(`
      SELECT * FROM mem_items WHERE conflict_group_id = ? ORDER BY created_at ASC
    `).all(g.id) as Record<string, unknown>[];

    return {
      group: {
        id: g.id,
        userId: g.user_id,
        scope: g.scope as MemoryScope,
        conflictStatus: g.conflict_status as ConflictStatus,
        firstItemId: g.first_item_id,
        createdAt: g.created_at,
        updatedAt: g.updated_at,
      },
      items: items.map(rowToMemoryItem),
    };
  });
}

export function updateConflictStatus(params: {
  userId: string;
  conflictGroupId: number;
  conflictStatus: ConflictStatus;
}): boolean {
  const db = getDb();
  const result = db.prepare(`
    UPDATE mem_conflict_groups SET conflict_status = ?, updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `).run(params.conflictStatus, params.conflictGroupId, params.userId);

  if (result.changes > 0) {
    // Propagate all group status transitions to member items so governance state stays consistent
    db.prepare(`
      UPDATE mem_items SET conflict_status = ?, updated_at = unixepoch()
      WHERE conflict_group_id = ?
    `).run(params.conflictStatus, params.conflictGroupId);
  }

  return result.changes > 0;
}

export function listStaleItems(params: {
  userId: string;
  limit?: number;
  offset?: number;
}): MemoryItem[] {
  const db = getDb();
  const now = Math.floor(Date.now() / 1000);

  const rows = db.prepare(`
    SELECT * FROM mem_items
    WHERE user_id = ?
      AND (stale_status = 'stale'
           OR (ttl_expires_at IS NOT NULL AND ttl_expires_at <= ?))
      AND validity_status != 'retracted'
    ORDER BY updated_at DESC
    LIMIT ? OFFSET ?
  `).all(params.userId, now, params.limit || 50, params.offset || 0) as Record<string, unknown>[];

  return rows.map(rowToMemoryItem);
}

export function getPromotionHistory(params: {
  userId: string;
  itemId?: number;
  limit?: number;
  offset?: number;
}): PromotionHistoryEntry[] {
  const db = getDb();
  const { userId, itemId, limit = 50, offset = 0 } = params;

  const rows = db.prepare(`
    SELECT ph.* FROM mem_promotion_history ph
    JOIN mem_items mi ON ph.item_id = mi.id
    WHERE mi.user_id = ?
      ${itemId ? "AND ph.item_id = ?" : ""}
    ORDER BY ph.promoted_at DESC
    LIMIT ? OFFSET ?
  `).all(...[userId, ...(itemId ? [itemId] : []), limit, offset]) as Array<{
    id: number;
    item_id: number;
    from_type: string;
    to_type: string;
    from_status: string;
    to_status: string;
    roi_score_at_promotion: number | null;
    promoted_at: number;
    promoted_by: string;
    notes: string | null;
  }>;

  return rows.map(r => ({
    id: r.id,
    itemId: r.item_id,
    fromType: r.from_type,
    toType: r.to_type,
    fromStatus: r.from_status,
    toStatus: r.to_status,
    roiScoreAtPromotion: r.roi_score_at_promotion,
    promotedAt: r.promoted_at,
    promotedBy: r.promoted_by,
    notes: r.notes,
  }));
}

export function reversePromotion(params: {
  userId: string;
  itemId: number;
  promotionStatus: PromotionStatus;
  notes?: string;
}): MemoryItem | null {
  const db = getDb();
  const { userId, itemId, promotionStatus, notes } = params;

  const existing = db.prepare(`
    SELECT id, memory_type, promotion_status, roi_score FROM mem_items
    WHERE id = ? AND user_id = ?
  `).get(itemId, userId) as {
    id: number; memory_type: string; promotion_status: string; roi_score: number;
  } | undefined;

  if (!existing) return null;

  const fromStatus = existing.promotion_status;
  let targetType = existing.memory_type;

  // On promotion: apply the same note->convention / warning->guardrail type mapping as auto-promotion,
  // so manual reviewed promotions produce the intended durable memory type.
  if (promotionStatus === "promoted") {
    const rule = PROMOTION_THRESHOLDS[existing.memory_type];
    if (rule) {
      targetType = rule.targetType;
    }
  }

  // On demotion: look up the original type from the earliest promotion history entry
  // for this item so we can restore it correctly.
  if (promotionStatus === "demoted") {
    const firstPromotion = db.prepare(`
      SELECT from_type FROM mem_promotion_history
      WHERE item_id = ?
      ORDER BY promoted_at ASC
      LIMIT 1
    `).get(itemId) as { from_type: string } | undefined;
    if (firstPromotion) {
      targetType = firstPromotion.from_type as MemoryType;
    }
    // If no history exists the item was never auto-promoted; type stays the same.
  }

  db.prepare(`
    UPDATE mem_items SET
      promotion_status = ?,
      memory_type = ?,
      updated_at = unixepoch()
    WHERE id = ? AND user_id = ?
  `).run(promotionStatus, targetType, itemId, userId);

  // Log to history
  db.prepare(`
    INSERT INTO mem_promotion_history
      (item_id, from_type, to_type, from_status, to_status, roi_score_at_promotion, promoted_by, notes)
    VALUES (?, ?, ?, ?, ?, ?, 'user', ?)
  `).run(itemId, existing.memory_type, targetType, fromStatus, promotionStatus, existing.roi_score, notes ?? null);

  const updated = db.prepare(`SELECT * FROM mem_items WHERE id = ?`).get(itemId) as Record<string, unknown> | undefined;
  return updated ? rowToMemoryItem(updated) : null;
}

export function getGovernanceStats(params: {
  userId: string;
  tokenMode?: string;
}): {
  totalItems: number;
  staleCount: number;
  contradictionCount: number;
  promotionCount: number;
  byType: Record<string, number>;
  byScope: Record<string, number>;
  layerUsage: Record<string, number>;
  avgInjectedTokensEstimate: number;
  hitRate: number;
  budgetProfile: MemoryBudgetProfile;
  /** True only when OMNIQL_MEM_SEMANTIC_CONTRADICTION=1 AND a real embedding backend is wired.
   *  Currently always false because the semantic path is a stub (semScore always 0). */
  semanticContradictionActive: boolean;
} {
  const db = getDb();
  const { userId, tokenMode = "core" } = params;
  const now = Math.floor(Date.now() / 1000);

  const totals = db.prepare(`
    SELECT COUNT(*) as total,
           SUM(CASE WHEN stale_status != 'fresh' OR (ttl_expires_at IS NOT NULL AND ttl_expires_at <= ?) THEN 1 ELSE 0 END) as stale_count,
           SUM(CASE WHEN conflict_status = 'open' THEN 1 ELSE 0 END) as conflict_count,
           SUM(CASE WHEN promotion_status IN ('candidate', 'promoted') THEN 1 ELSE 0 END) as promotion_count,
           SUM(access_count) as total_access,
           SUM(injection_count) as total_injections,
           SUM(retrieval_count) as total_retrievals,
           SUM(layer3_count) as total_layer3,
           AVG(LENGTH(content)) as avg_content_len
    FROM mem_items WHERE user_id = ? AND validity_status != 'retracted'
  `).get(now, userId) as {
    total: number;
    stale_count: number;
    conflict_count: number;
    promotion_count: number;
    total_access: number;
    total_injections: number;
    total_retrievals: number;
    total_layer3: number;
    avg_content_len: number | null;
  };

  const byTypeRows = db.prepare(`
    SELECT memory_type, COUNT(*) as cnt FROM mem_items
    WHERE user_id = ? AND validity_status != 'retracted'
    GROUP BY memory_type
  `).all(userId) as Array<{ memory_type: string; cnt: number }>;

  const byScopeRows = db.prepare(`
    SELECT scope, COUNT(*) as cnt FROM mem_items
    WHERE user_id = ? AND validity_status != 'retracted'
    GROUP BY scope
  `).all(userId) as Array<{ scope: string; cnt: number }>;

  const byType: Record<string, number> = {};
  for (const r of byTypeRows) byType[r.memory_type] = r.cnt;

  const byScope: Record<string, number> = {};
  for (const r of byScopeRows) byScope[r.scope] = r.cnt;

  const hitRate = totals.total_retrievals > 0
    ? Math.min(1, totals.total_injections / totals.total_retrievals)
    : 0;

  // Token estimate: average content length / 4 chars per token (GPT-family heuristic),
  // multiplied by how many times items were injected on average.
  const avgCharsPerItem = totals.avg_content_len ?? 0;
  const avgInjectedTokensEstimate = totals.total_injections > 0
    ? Math.round((avgCharsPerItem / 4) * (totals.total_injections / Math.max(1, totals.total || 1)))
    : 0;

  const budgetProfile = BUDGET_PROFILES_BY_MODE[tokenMode] || BUDGET_PROFILES_BY_MODE["core"];

  return {
    totalItems: totals.total,
    staleCount: totals.stale_count || 0,
    contradictionCount: totals.conflict_count || 0,
    promotionCount: totals.promotion_count || 0,
    byType,
    byScope,
    layerUsage: {
      // L1 = index accesses (access_count includes both L1 and L3; subtract L3 to isolate L1)
      layer1: Math.max(0, (totals.total_access || 0) - (totals.total_layer3 || 0)),
      // L2 = search retrieval accesses
      layer2: totals.total_retrievals || 0,
      // L3 = deep-get escalation accesses
      layer3: totals.total_layer3 || 0,
    },
    avgInjectedTokensEstimate,
    hitRate,
    budgetProfile,
    // Semantic path is a deliberate stub until embedding backend is wired.
    // Even with the env flag on, semScore is always 0, so blending is never triggered.
    semanticContradictionActive: false,
  };
}

export function listMemoryItems(params: {
  userId: string;
  scope?: MemoryScope;
  memoryType?: MemoryType;
  limit?: number;
  offset?: number;
}): MemoryItem[] {
  const db = getDb();
  const { userId, scope, memoryType, limit = 50, offset = 0 } = params;

  const clauses: string[] = ["user_id = ?"];
  const args: unknown[] = [userId];

  if (scope) { clauses.push("scope = ?"); args.push(scope); }
  if (memoryType) { clauses.push("memory_type = ?"); args.push(memoryType); }

  args.push(limit, offset);

  const rows = db.prepare(`
    SELECT * FROM mem_items WHERE ${clauses.join(" AND ")}
    ORDER BY roi_score DESC, created_at DESC
    LIMIT ? OFFSET ?
  `).all(...args) as Record<string, unknown>[];

  return rows.map(rowToMemoryItem);
}

export function initSession(sessionId: string, userId: string, projectPath: string): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO mem_sessions (id, user_id, project_path)
    VALUES (?, ?, ?)
  `).run(sessionId, userId, projectPath);
}

export function addObservation(
  sessionId: string,
  userId: string,
  toolName: string,
  inputSummary: string,
  outputSummary: string,
): void {
  const db = getDb();
  db.prepare(`
    INSERT OR IGNORE INTO mem_sessions (id, user_id, project_path)
    VALUES (?, ?, '')
  `).run(sessionId, userId);

  const result = db.prepare(`
    INSERT INTO mem_observations (session_id, user_id, tool_name, input_summary, output_summary)
    VALUES (?, ?, ?, ?, ?)
  `).run(sessionId, userId, toolName, inputSummary, outputSummary);

  const obs: Observation = {
    id: Number(result.lastInsertRowid),
    sessionId,
    userId,
    toolName,
    inputSummary,
    outputSummary,
    recordedAt: Math.floor(Date.now() / 1000),
  };
  observationEmitter.emit(`observation:${userId}`, obs);
}

export function addSummary(sessionId: string, userId: string, summary: string): void {
  const db = getDb();
  db.prepare(`
    UPDATE mem_sessions SET summary = ?, ended_at = unixepoch() WHERE id = ?
  `).run(summary, sessionId);

  if ((db.prepare("SELECT changes()").get() as { "changes()": number })["changes()"] === 0) {
    db.prepare(`
      INSERT OR IGNORE INTO mem_sessions (id, user_id, project_path, summary, ended_at)
      VALUES (?, ?, '', ?, unixepoch())
    `).run(sessionId, userId, summary);
  }
}

export interface SessionSummary {
  id: string;
  userId: string;
  projectPath: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  observationCount: number;
}

export interface Observation {
  id: number;
  sessionId: string;
  userId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  recordedAt: number;
}

export function getPastContext(userId: string, projectPath?: string, maxChars = 8000): string {
  const db = getDb();

  const sessions = db.prepare(`
    SELECT s.id, s.project_path, s.started_at, s.ended_at, s.summary,
           COUNT(o.id) as observation_count
    FROM mem_sessions s
    LEFT JOIN mem_observations o ON o.session_id = s.id
    WHERE s.user_id = ?
      AND (? IS NULL OR s.project_path = '' OR s.project_path = ?)
      AND s.summary IS NOT NULL
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT 10
  `).all(userId, projectPath || null, projectPath || null) as Array<{
    id: string;
    project_path: string;
    started_at: number;
    ended_at: number | null;
    summary: string | null;
    observation_count: number;
  }>;

  if (sessions.length === 0) return "";

  const lines: string[] = [];
  let totalChars = 0;

  for (const session of sessions) {
    if (!session.summary) continue;
    const date = new Date(session.started_at * 1000).toISOString().slice(0, 10);
    const line = `[${date}] Session ${session.id}: ${session.summary}`;
    if (totalChars + line.length > maxChars) break;
    lines.push(line);
    totalChars += line.length + 1;
  }

  return lines.join("\n");
}

export function listObservations(userId: string, limit = 100, offset = 0): Observation[] {
  const db = getDb();
  return db.prepare(`
    SELECT id, session_id as sessionId, user_id as userId, tool_name as toolName,
           input_summary as inputSummary, output_summary as outputSummary,
           recorded_at as recordedAt
    FROM mem_observations
    WHERE user_id = ?
    ORDER BY recorded_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as Observation[];
}

export function listSessions(userId: string, limit = 50, offset = 0, projectPath?: string): SessionSummary[] {
  const db = getDb();
  if (projectPath) {
    return db.prepare(`
      SELECT s.id, s.user_id as userId, s.project_path as projectPath,
             s.started_at as startedAt, s.ended_at as endedAt, s.summary,
             COUNT(o.id) as observationCount
      FROM mem_sessions s
      LEFT JOIN mem_observations o ON o.session_id = s.id
      WHERE s.user_id = ?
        AND s.project_path = ?
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ? OFFSET ?
    `).all(userId, projectPath, limit, offset) as SessionSummary[];
  }
  return db.prepare(`
    SELECT s.id, s.user_id as userId, s.project_path as projectPath,
           s.started_at as startedAt, s.ended_at as endedAt, s.summary,
           COUNT(o.id) as observationCount
    FROM mem_sessions s
    LEFT JOIN mem_observations o ON o.session_id = s.id
    WHERE s.user_id = ?
    GROUP BY s.id
    ORDER BY s.started_at DESC
    LIMIT ? OFFSET ?
  `).all(userId, limit, offset) as SessionSummary[];
}

export interface SearchResultObservation extends Observation {
  sessionSummary: string | null;
  sessionStartedAt: number;
}

export interface MemorySearchResult {
  observations: SearchResultObservation[];
  sessions: SessionSummary[];
}

export function searchMemory(userId: string, rawQuery: string, limit = 30, projectPath?: string): MemorySearchResult {
  const db = getDb();
  const trimmed = rawQuery.trim();
  if (!trimmed) return { observations: [], sessions: [] };

  const ftsQuery = trimmed
    .split(/\s+/)
    .map((w) => `"${w.replace(/"/g, '""')}"*`)
    .join(" ");

  let observations: SearchResultObservation[] = [];
  try {
    if (projectPath) {
      observations = db.prepare(`
        SELECT o.id, o.session_id as sessionId, o.user_id as userId,
               o.tool_name as toolName, o.input_summary as inputSummary,
               o.output_summary as outputSummary, o.recorded_at as recordedAt,
               s.summary as sessionSummary, s.started_at as sessionStartedAt
        FROM mem_observations_fts fts
        JOIN mem_observations o ON fts.rowid = o.id
        JOIN mem_sessions s ON o.session_id = s.id
        WHERE fts MATCH ?
          AND o.user_id = ?
          AND s.project_path = ?
        ORDER BY o.recorded_at DESC
        LIMIT ?
      `).all(ftsQuery, userId, projectPath, limit) as SearchResultObservation[];
    } else {
      observations = db.prepare(`
        SELECT o.id, o.session_id as sessionId, o.user_id as userId,
               o.tool_name as toolName, o.input_summary as inputSummary,
               o.output_summary as outputSummary, o.recorded_at as recordedAt,
               s.summary as sessionSummary, s.started_at as sessionStartedAt
        FROM mem_observations_fts fts
        JOIN mem_observations o ON fts.rowid = o.id
        JOIN mem_sessions s ON o.session_id = s.id
        WHERE fts MATCH ?
          AND o.user_id = ?
        ORDER BY o.recorded_at DESC
        LIMIT ?
      `).all(ftsQuery, userId, limit) as SearchResultObservation[];
    }
  } catch (err) {
    logger.warn({ err, ftsQuery, rawQuery }, "[mem] FTS5 query parse failed — returning empty observations");
    observations = [];
  }

  const likePattern = `%${trimmed.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  let sessions: SessionSummary[];
  if (projectPath) {
    sessions = db.prepare(`
      SELECT s.id, s.user_id as userId, s.project_path as projectPath,
             s.started_at as startedAt, s.ended_at as endedAt, s.summary,
             COUNT(o.id) as observationCount
      FROM mem_sessions s
      LEFT JOIN mem_observations o ON o.session_id = s.id
      WHERE s.user_id = ?
        AND s.project_path = ?
        AND s.summary LIKE ? ESCAPE '\\'
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(userId, projectPath, likePattern, limit) as SessionSummary[];
  } else {
    sessions = db.prepare(`
      SELECT s.id, s.user_id as userId, s.project_path as projectPath,
             s.started_at as startedAt, s.ended_at as endedAt, s.summary,
             COUNT(o.id) as observationCount
      FROM mem_sessions s
      LEFT JOIN mem_observations o ON o.session_id = s.id
      WHERE s.user_id = ?
        AND s.summary LIKE ? ESCAPE '\\'
      GROUP BY s.id
      ORDER BY s.started_at DESC
      LIMIT ?
    `).all(userId, likePattern, limit) as SessionSummary[];
  }

  return { observations, sessions };
}

export function healthCheck(): boolean {
  try {
    getDb();
    return true;
  } catch (err) {
    logger.error(err, "Memory DB health check failed");
    return false;
  }
}

/**
 * Creates a safe backup of the memory database using better-sqlite3's
 * built-in backup API (handles WAL mode correctly).
 * Returns the path to the temporary backup file — caller must delete it.
 */
export async function backupDb(): Promise<string> {
  const db = getDb();
  const tmpPath = `${DB_PATH}.backup-${Date.now()}.db`;
  await db.backup(tmpPath);
  return tmpPath;
}

/**
 * Restores the memory database from the provided buffer.
 * Validates the buffer is a valid SQLite file, closes the current connection,
 * replaces the DB file, and re-initialises the singleton.
 */
export function restoreDb(buf: Buffer): void {
  const SQLITE_HEADER = "SQLite format 3\0";
  if (buf.length < 16 || buf.slice(0, 16).toString("utf8") !== SQLITE_HEADER) {
    throw new Error("Invalid SQLite file: header mismatch");
  }

  if (_db) {
    _db.close();
    _db = null;
  }

  const walPath = `${DB_PATH}-wal`;
  const shmPath = `${DB_PATH}-shm`;
  try { fs.unlinkSync(walPath); } catch { /* ignore */ }
  try { fs.unlinkSync(shmPath); } catch { /* ignore */ }

  fs.writeFileSync(DB_PATH, buf);

  getDb();
  logger.info({ db: DB_PATH }, "Memory database restored from backup");
}
