/**
 * lane-intent.ts — RFC 0002 Phase 2 (durable intent events)
 *
 * Lanes publish typed, durable engineering context as they work — decisions,
 * interface/contract changes, warnings, and verification results — so every
 * lane can read every other lane's intent. This is the raw material for:
 *   - the Arbiter's intent-aware conflict resolution (lane-arbiter.ts),
 *   - plan-reassessment's code context (what actually changed and why),
 *   - the eval harness (conflict-resolution notes).
 *
 * The store is pluggable so the service is unit-testable without a DB; the
 * production store writes lane_events rows (reusing the existing table) and
 * lane_conflict_resolutions rows.
 */

import { logger } from "../lib/logger";

// ── Typed intent events ──────────────────────────────────────────────────────

export type IntentEventType =
  | "intent_decision"
  | "intent_interface_change"
  | "intent_warning"
  | "intent_verification";

export interface IntentEvent {
  id: number;
  sessionId: number;
  laneId: number;
  eventType: IntentEventType;
  /** Human-readable summary of the intent. */
  summary: string;
  /** File the intent concerns (optional). */
  file?: string | null;
  /** Interface-change contract, e.g. "UserIdentity(providerType, providerId)". */
  contract?: string | null;
  /** Warning risk description. */
  risk?: string | null;
  /** Verification evidence, e.g. "pytest tests/auth -q: PASS". */
  evidence?: string | null;
  createdAt: Date;
}

export interface PublishIntentParams {
  sessionId: number;
  laneId: number;
  eventType: IntentEventType;
  summary: string;
  file?: string | null;
  contract?: string | null;
  risk?: string | null;
  evidence?: string | null;
}

export interface IntentStore {
  publish(params: PublishIntentParams): Promise<IntentEvent>;
  listForSession(sessionId: number, laneId?: number): Promise<IntentEvent[]>;
  get(id: number): Promise<IntentEvent | null>;
}

export class MemoryIntentStore implements IntentStore {
  private nextId = 1;
  private events: IntentEvent[] = [];

  async publish(params: PublishIntentParams): Promise<IntentEvent> {
    const event: IntentEvent = {
      id: this.nextId++,
      sessionId: params.sessionId,
      laneId: params.laneId,
      eventType: params.eventType,
      summary: params.summary,
      file: params.file ?? null,
      contract: params.contract ?? null,
      risk: params.risk ?? null,
      evidence: params.evidence ?? null,
      createdAt: new Date(),
    };
    this.events.push(event);
    return event;
  }

  async listForSession(sessionId: number, laneId?: number): Promise<IntentEvent[]> {
    return this.events
      .filter((e) => e.sessionId === sessionId)
      .filter((e) => (laneId === undefined ? true : e.laneId === laneId))
      .sort((a, b) => a.id - b.id);
  }

  async get(id: number): Promise<IntentEvent | null> {
    return this.events.find((e) => e.id === id) ?? null;
  }

  clear(): void {
    this.events = [];
  }
}

// ── Conflict-resolution notes ─────────────────────────────────────────────────

export type ConflictResolutionOutcome = "preserved_both" | "chose_one" | "escalated";

export interface ConflictResolution {
  id: number;
  sessionId: number;
  mergeJobId: number | null;
  filePath: string;
  outcome: ConflictResolutionOutcome;
  summary: string;
  intentEventIds: number[];
  testVerified: boolean;
  createdAt: Date;
}

export interface RecordResolutionParams {
  sessionId: number;
  mergeJobId?: number | null;
  filePath: string;
  outcome: ConflictResolutionOutcome;
  summary: string;
  intentEventIds?: number[];
  testVerified?: boolean;
}

export interface ResolutionStore {
  record(params: RecordResolutionParams): Promise<ConflictResolution>;
  listForSession(sessionId: number): Promise<ConflictResolution[]>;
}

export class MemoryResolutionStore implements ResolutionStore {
  private nextId = 1;
  private rows: ConflictResolution[] = [];

  async record(params: RecordResolutionParams): Promise<ConflictResolution> {
    const row: ConflictResolution = {
      id: this.nextId++,
      sessionId: params.sessionId,
      mergeJobId: params.mergeJobId ?? null,
      filePath: params.filePath,
      outcome: params.outcome,
      summary: params.summary,
      intentEventIds: params.intentEventIds ?? [],
      testVerified: params.testVerified ?? false,
      createdAt: new Date(),
    };
    this.rows.push(row);
    return row;
  }

  async listForSession(sessionId: number): Promise<ConflictResolution[]> {
    return this.rows.filter((r) => r.sessionId === sessionId).sort((a, b) => a.id - b.id);
  }

  clear(): void {
    this.rows = [];
  }
}

// ── Production DB-backed stores ──────────────────────────────────────────────

/**
 * Production intent store backed by lane_events. Lazy-imports @workspace/db to
 * avoid a static import cycle at module load.
 */
export function createDbIntentStore(): IntentStore {
  return {
    async publish(params) {
      const { db, laneEventsTable } = await import("@workspace/db");
      const [row] = await db.insert(laneEventsTable).values({
        sessionId: params.sessionId,
        laneId: params.laneId,
        eventType: params.eventType,
        payload: {
          summary: params.summary,
          file: params.file ?? null,
          contract: params.contract ?? null,
          risk: params.risk ?? null,
          evidence: params.evidence ?? null,
        },
      }).returning();
      return mapIntentRow(row);
    },
    async listForSession(sessionId, laneId) {
      const { db, laneEventsTable } = await import("@workspace/db");
      const { eq, and, inArray } = await import("drizzle-orm");
      const types = ["intent_decision", "intent_interface_change", "intent_warning", "intent_verification"] as const;
      let q = db.select().from(laneEventsTable)
        .where(and(eq(laneEventsTable.sessionId, sessionId), inArray(laneEventsTable.eventType, [...types])))
        .$dynamic();
      if (laneId !== undefined) {
        q = q.where(eq(laneEventsTable.laneId, laneId));
      }
      const rows = await q;
      return rows.map(mapIntentRow);
    },
    async get(id) {
      const { db, laneEventsTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const [row] = await db.select().from(laneEventsTable).where(eq(laneEventsTable.id, id));
      return row ? mapIntentRow(row) : null;
    },
  };
}

function mapIntentRow(row: {
  id: number;
  sessionId: number;
  laneId: number;
  eventType: string;
  payload: unknown;
  createdAt: Date;
}): IntentEvent {
  const p = (row.payload ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    sessionId: row.sessionId,
    laneId: row.laneId,
    eventType: row.eventType as IntentEventType,
    summary: typeof p["summary"] === "string" ? p["summary"] : "",
    file: typeof p["file"] === "string" ? p["file"] : null,
    contract: typeof p["contract"] === "string" ? p["contract"] : null,
    risk: typeof p["risk"] === "string" ? p["risk"] : null,
    evidence: typeof p["evidence"] === "string" ? p["evidence"] : null,
    createdAt: row.createdAt,
  };
}

/**
 * Production resolution store backed by lane_conflict_resolutions.
 */
export function createDbResolutionStore(): ResolutionStore {
  return {
    async record(params) {
      const { db, laneConflictResolutionsTable } = await import("@workspace/db");
      const [row] = await db.insert(laneConflictResolutionsTable).values({
        sessionId: params.sessionId,
        mergeJobId: params.mergeJobId ?? null,
        filePath: params.filePath,
        outcome: params.outcome,
        summary: params.summary,
        intentEventIds: params.intentEventIds ?? [],
        testVerified: params.testVerified ?? false,
      }).returning();
      return mapResolutionRow(row);
    },
    async listForSession(sessionId) {
      const { db, laneConflictResolutionsTable } = await import("@workspace/db");
      const { eq } = await import("drizzle-orm");
      const rows = await db.select().from(laneConflictResolutionsTable).where(eq(laneConflictResolutionsTable.sessionId, sessionId));
      return rows.map(mapResolutionRow);
    },
  };
}

function mapResolutionRow(row: {
  id: number;
  sessionId: number;
  mergeJobId: number | null;
  filePath: string;
  outcome: string;
  summary: string;
  intentEventIds: unknown;
  testVerified: boolean;
  createdAt: Date;
}): ConflictResolution {
  return {
    id: row.id,
    sessionId: row.sessionId,
    mergeJobId: row.mergeJobId,
    filePath: row.filePath,
    outcome: row.outcome as ConflictResolutionOutcome,
    summary: row.summary,
    intentEventIds: Array.isArray(row.intentEventIds) ? (row.intentEventIds as number[]) : [],
    testVerified: row.testVerified,
    createdAt: row.createdAt,
  };
}

// ── Rendering intent for prompts ─────────────────────────────────────────────

/**
 * Render a session's intent events as a compact prompt block (for the Arbiter
 * and plan-reassessment). Empty when there are no intent events.
 */
export function renderIntentBlock(events: IntentEvent[]): string {
  if (events.length === 0) return "";
  const lines = events.map((e) => {
    const lane = `lane ${e.laneId}`;
    const file = e.file ? ` @ ${e.file}` : "";
    const extra = e.contract ? ` contract=${e.contract}` : e.risk ? ` risk=${e.risk}` : e.evidence ? ` evidence=${e.evidence}` : "";
    return `  [${e.eventType}] ${lane}${file}: ${e.summary}${extra}`;
  });
  return `\n\nLane intent (durable engineering context):\n${lines.join("\n")}`;
}