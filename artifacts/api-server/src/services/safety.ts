import Database from "better-sqlite3";
import path from "path";
import fs from "fs";
import os from "os";
import { EventEmitter } from "events";
import { logger } from "../lib/logger";

/**
 * Safety / Approval subsystem.
 *
 * A standalone module: classifies actions, queues those that need a human in
 * the loop, dispatches notifications across pluggable channels, and keeps a
 * full transcript for audit. Designed so that ambient mode, scheduled jobs,
 * autonomous swarms, and future autonomy features can plug into the same
 * approval rails by calling `requestPermission`.
 */

const DATA_DIR = process.env["MEM_DATA_DIR"] || path.join(os.homedir(), "mizi-memory");
const DB_PATH = path.join(DATA_DIR, "ambient.db");

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;
  fs.mkdirSync(DATA_DIR, { recursive: true });
  _db = new Database(DB_PATH);
  _db.pragma("journal_mode = WAL");
  _db.pragma("foreign_keys = ON");
  // Drop legacy single-row ambient_lock from earlier prototype so we can
  // recreate it keyed by account_id. Safe because no other code relies on
  // the lock surviving across schema changes.
  try {
    const info = _db.prepare(`PRAGMA table_info(ambient_lock)`).all() as Array<{ name: string }>;
    if (info.length > 0 && !info.some(c => c.name === "account_id")) {
      _db.exec(`DROP TABLE ambient_lock`);
    }
  } catch { /* table didn't exist yet */ }
  _db.exec(`
    CREATE TABLE IF NOT EXISTS safety_actions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL DEFAULT 'default',
      kind TEXT NOT NULL,
      summary TEXT NOT NULL,
      details_json TEXT,
      requested_by TEXT NOT NULL,
      session_id INTEGER,
      cycle_id INTEGER,
      classification TEXT NOT NULL,
      status TEXT NOT NULL,
      reversible INTEGER NOT NULL DEFAULT 1,
      external_surface INTEGER NOT NULL DEFAULT 0,
      scope TEXT NOT NULL DEFAULT 'local',
      policy_bundle TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch()),
      decided_at INTEGER,
      decided_by TEXT,
      decision_note TEXT,
      expires_at INTEGER
    );
    CREATE INDEX IF NOT EXISTS idx_safety_status ON safety_actions(status);
    CREATE INDEX IF NOT EXISTS idx_safety_account ON safety_actions(account_id);

    CREATE TABLE IF NOT EXISTS safety_transcript (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER REFERENCES safety_actions(id),
      cycle_id INTEGER,
      kind TEXT NOT NULL,
      message TEXT NOT NULL,
      metadata_json TEXT,
      created_at INTEGER NOT NULL DEFAULT (unixepoch())
    );
    CREATE INDEX IF NOT EXISTS idx_safety_transcript_action ON safety_transcript(action_id);
    CREATE INDEX IF NOT EXISTS idx_safety_transcript_cycle ON safety_transcript(cycle_id);

    CREATE TABLE IF NOT EXISTS safety_policies (
      bundle TEXT PRIMARY KEY,
      description TEXT,
      rules_json TEXT NOT NULL,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS safety_notifications (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      action_id INTEGER NOT NULL REFERENCES safety_actions(id),
      channel TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'queued',
      attempt_at INTEGER NOT NULL DEFAULT (unixepoch()),
      error TEXT
    );

    CREATE TABLE IF NOT EXISTS ambient_config (
      account_id TEXT PRIMARY KEY,
      enabled INTEGER NOT NULL DEFAULT 0,
      kill_switch INTEGER NOT NULL DEFAULT 0,
      feature_flag INTEGER NOT NULL DEFAULT 0,
      token_budget INTEGER NOT NULL DEFAULT 100000,
      gpu_minute_budget INTEGER NOT NULL DEFAULT 60,
      wall_clock_budget_ms INTEGER NOT NULL DEFAULT 3600000,
      rolling_window_ms INTEGER NOT NULL DEFAULT 86400000,
      base_interval_ms INTEGER NOT NULL DEFAULT 600000,
      policy_bundle TEXT NOT NULL DEFAULT 'local-only',
      allow_listed_kinds TEXT NOT NULL DEFAULT '[]',
      operator_user_id TEXT NOT NULL DEFAULT 'operator',
      preempt_on_any_session INTEGER NOT NULL DEFAULT 1,
      next_wake_at INTEGER,
      updated_at INTEGER NOT NULL DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS ambient_cycles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL DEFAULT 'default',
      started_at INTEGER NOT NULL DEFAULT (unixepoch()),
      ended_at INTEGER,
      status TEXT NOT NULL DEFAULT 'running',
      reason TEXT,
      scout_summary TEXT,
      garden_summary TEXT,
      work_summary TEXT,
      tokens_used INTEGER DEFAULT 0,
      wall_clock_ms INTEGER DEFAULT 0,
      next_wake_at INTEGER,
      approvals_requested INTEGER DEFAULT 0,
      approvals_granted INTEGER DEFAULT 0,
      approvals_denied INTEGER DEFAULT 0,
      gardening_deltas INTEGER DEFAULT 0,
      gpu_minutes_used REAL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_ambient_cycles_account ON ambient_cycles(account_id);
    CREATE INDEX IF NOT EXISTS idx_ambient_cycles_started ON ambient_cycles(started_at DESC);

    CREATE TABLE IF NOT EXISTS ambient_lock (
      account_id TEXT PRIMARY KEY,
      holder TEXT NOT NULL,
      acquired_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);

  // Lightweight column migrations for upgrades from earlier prototypes.
  for (const [table, col, decl] of [
    ["ambient_config", "next_wake_at", "INTEGER"],
    ["ambient_config", "operator_user_id", "TEXT NOT NULL DEFAULT 'operator'"],
    ["ambient_config", "preempt_on_any_session", "INTEGER NOT NULL DEFAULT 1"],
    ["ambient_cycles", "gpu_minutes_used", "REAL DEFAULT 0"],
  ] as const) {
    const cols = (_db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(c => c.name);
    if (!cols.includes(col)) {
      _db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
    }
  }

  seedDefaultPolicies(_db);

  return _db;
}

// ─── Policy bundles ──────────────────────────────────────────────────────────

export interface PolicyRules {
  /** Action kinds that are always auto-allowed regardless of properties. */
  autoAllowKinds?: string[];
  /** Action kinds that always require approval. */
  alwaysGateKinds?: string[];
  /** If true, any action with externalSurface=true requires approval. */
  gateExternalSurface?: boolean;
  /** If true, any action with reversible=false requires approval. */
  gateIrreversible?: boolean;
  /** Scopes that auto-pass (e.g. ["local", "sandbox"]). */
  autoAllowScopes?: string[];
}

export const POLICY_BUNDLES: Record<string, { description: string; rules: PolicyRules }> = {
  "local-only": {
    description: "Auto-allow local, reversible, sandbox-bound actions. Anything with external surface or that is irreversible requires approval.",
    rules: {
      autoAllowScopes: ["local", "sandbox"],
      gateExternalSurface: true,
      gateIrreversible: true,
    },
  },
  "team-coord": {
    description: "Same as local-only, but also allow lane/team coordination actions without explicit approval. External communication still gated.",
    rules: {
      autoAllowScopes: ["local", "sandbox", "team"],
      autoAllowKinds: ["coord_handoff_post", "coord_lane_note"],
      gateExternalSurface: true,
      gateIrreversible: true,
    },
  },
  "external-comm": {
    description: "Permissive bundle that allows messaging external systems (email, slack, webhooks) without per-action approval. Use with care.",
    rules: {
      autoAllowScopes: ["local", "sandbox", "team", "external"],
      gateIrreversible: true,
    },
  },
};

function seedDefaultPolicies(db: Database.Database): void {
  const insert = db.prepare(`
    INSERT INTO safety_policies (bundle, description, rules_json, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(bundle) DO NOTHING
  `);
  for (const [name, def] of Object.entries(POLICY_BUNDLES)) {
    insert.run(name, def.description, JSON.stringify(def.rules));
  }
}

// ─── Types ───────────────────────────────────────────────────────────────────

export type ActionScope = "local" | "sandbox" | "team" | "external";
export type Classification = "auto-allowed" | "requires-permission" | "denied";
export type ActionStatus =
  | "auto-approved"
  | "pending"
  | "approved"
  | "denied"
  | "expired"
  | "executed"
  | "failed";

export interface ActionRequest {
  /** Stable kind identifier, e.g. "memory_prune", "send_email", "git_commit". */
  kind: string;
  /** One-line human-readable summary surfaced in approval UI / notifications. */
  summary: string;
  /** Optional structured details (target ids, payloads, etc). */
  details?: Record<string, unknown>;
  requestedBy: string;
  sessionId?: number | null;
  cycleId?: number | null;
  scope?: ActionScope;
  reversible?: boolean;
  externalSurface?: boolean;
  /** Policy bundle to apply; defaults to current ambient config bundle. */
  policyBundle?: string;
  accountId?: string;
}

export interface Decision {
  actionId: number;
  classification: Classification;
  status: ActionStatus;
  /**
   * If true, the caller is cleared to execute the action immediately.
   * `false` means the action was queued, denied, or expired.
   */
  allowed: boolean;
  reason: string;
}

export interface SafetyAction {
  id: number;
  accountId: string;
  kind: string;
  summary: string;
  details: Record<string, unknown> | null;
  requestedBy: string;
  sessionId: number | null;
  cycleId: number | null;
  classification: Classification;
  status: ActionStatus;
  reversible: boolean;
  externalSurface: boolean;
  scope: ActionScope;
  policyBundle: string | null;
  createdAt: number;
  decidedAt: number | null;
  decidedBy: string | null;
  decisionNote: string | null;
  expiresAt: number | null;
}

// ─── Notification channels (pluggable) ───────────────────────────────────────

export type NotificationChannel = (action: SafetyAction) => Promise<void> | void;

const channels = new Map<string, NotificationChannel>();
const events = new EventEmitter();
events.setMaxListeners(100);

export function registerNotificationChannel(name: string, fn: NotificationChannel): void {
  channels.set(name, fn);
  logger.info({ channel: name }, "[safety] notification channel registered");
}

export function unregisterNotificationChannel(name: string): void {
  channels.delete(name);
}

/** Subscribe to in-process safety events (approval requested / decided). */
export function subscribeSafetyEvents(handler: (event: { type: string; action: SafetyAction }) => void): () => void {
  events.on("event", handler);
  return () => events.off("event", handler);
}

// Built-in dashboard channel: drops a row that the dashboard can poll. The
// in-app banner is purely a frontend concern that reads /api/safety/pending.
registerNotificationChannel("dashboard", () => {
  /* no-op: pending list is already queryable */
});

// Built-in log channel for visibility / debugging.
registerNotificationChannel("log", (action) => {
  logger.warn(
    { actionId: action.id, kind: action.kind, summary: action.summary, scope: action.scope },
    "[safety] approval required",
  );
});

/**
 * Email-equivalent channel that actually delivers. Operators set
 * `SAFETY_EMAIL_TO` and one of:
 *   - `SAFETY_EMAIL_WEBHOOK_URL` — any HTTPS endpoint that accepts the
 *     payload below (Resend, SendGrid, Mailgun, Postmark, an internal
 *     proxy, etc.). Optional `SAFETY_EMAIL_WEBHOOK_AUTH` is sent verbatim
 *     as the `Authorization` header (e.g. `Bearer …`).
 * If `SAFETY_EMAIL_TO` is set without a webhook we fail explicitly (a
 * loud warning + an audit transcript entry on the action) rather than
 * silently dropping notifications. This honors the project's
 * "explicit-failure over silent fallback" rule.
 *
 * Operators who run an SMTP server can re-register this channel with a
 * nodemailer-backed implementation; the channel registry permits that
 * override (see `registerNotificationChannel`).
 */
registerNotificationChannel("email", async (action) => {
  const to = process.env["SAFETY_EMAIL_TO"];
  if (!to) return;
  const webhookUrl = process.env["SAFETY_EMAIL_WEBHOOK_URL"];
  if (!webhookUrl) {
    const msg = "SAFETY_EMAIL_TO is set but SAFETY_EMAIL_WEBHOOK_URL is missing — email channel cannot deliver";
    logger.error({ to, actionId: action.id }, `[safety] ${msg}`);
    try { recordTranscript(action.id, action.cycleId, "notify", `email channel misconfigured: ${msg}`, { to }); } catch { /* ignore */ }
    return;
  }
  const payload = {
    to,
    subject: `[Mizi Ambient] Approval needed: ${action.summary}`,
    actionId: action.id,
    accountId: action.accountId,
    kind: action.kind,
    summary: action.summary,
    classification: action.classification,
    scope: action.scope,
    reversible: action.reversible,
    externalSurface: action.externalSurface,
    requestedBy: action.requestedBy,
    createdAt: action.createdAt,
    expiresAt: action.expiresAt,
    details: action.details,
  };
  const headers: Record<string, string> = { "content-type": "application/json" };
  const auth = process.env["SAFETY_EMAIL_WEBHOOK_AUTH"];
  if (auth) headers["authorization"] = auth;
  try {
    const res = await fetch(webhookUrl, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      logger.error({ status: res.status, body, actionId: action.id }, "[safety] email webhook returned non-2xx");
      try { recordTranscript(action.id, action.cycleId, "notify", `email webhook failed status=${res.status}`, { status: res.status }); } catch { /* ignore */ }
      return;
    }
    logger.info({ actionId: action.id, to }, "[safety] email channel: dispatched approval request via webhook");
    try { recordTranscript(action.id, action.cycleId, "notify", "email webhook dispatched approval request", { to }); } catch { /* ignore */ }
  } catch (err) {
    logger.error({ err, actionId: action.id }, "[safety] email webhook threw");
    try { recordTranscript(action.id, action.cycleId, "notify", `email webhook threw: ${err instanceof Error ? err.message : String(err)}`, {}); } catch { /* ignore */ }
  }
});

// ─── Classifier ──────────────────────────────────────────────────────────────

function getActivePolicy(bundle: string): PolicyRules {
  const db = getDb();
  const row = db.prepare(`SELECT rules_json FROM safety_policies WHERE bundle = ?`).get(bundle) as { rules_json: string } | undefined;
  if (row) {
    try { return JSON.parse(row.rules_json) as PolicyRules; } catch { /* fall through */ }
  }
  return POLICY_BUNDLES[bundle]?.rules ?? POLICY_BUNDLES["local-only"].rules;
}

function getAccountConfig(accountId: string) {
  const db = getDb();
  let row = db.prepare(`SELECT * FROM ambient_config WHERE account_id = ?`).get(accountId) as Record<string, unknown> | undefined;
  if (!row) {
    db.prepare(`INSERT INTO ambient_config (account_id) VALUES (?)`).run(accountId);
    row = db.prepare(`SELECT * FROM ambient_config WHERE account_id = ?`).get(accountId) as Record<string, unknown>;
  }
  return row;
}

export function classifyAction(req: ActionRequest): { classification: Classification; reason: string } {
  const accountId = req.accountId ?? "default";
  const cfg = getAccountConfig(accountId);
  const bundleName = req.policyBundle ?? (cfg["policy_bundle"] as string) ?? "local-only";
  const rules = getActivePolicy(bundleName);
  const allowList = JSON.parse((cfg["allow_listed_kinds"] as string) || "[]") as string[];

  if (allowList.includes(req.kind)) {
    return { classification: "auto-allowed", reason: `kind '${req.kind}' is operator allow-listed` };
  }
  if (rules.alwaysGateKinds?.includes(req.kind)) {
    return { classification: "requires-permission", reason: `kind '${req.kind}' always requires approval` };
  }
  if (rules.autoAllowKinds?.includes(req.kind)) {
    return { classification: "auto-allowed", reason: `kind '${req.kind}' is auto-allowed by policy '${bundleName}'` };
  }
  if (rules.gateExternalSurface && req.externalSurface) {
    return { classification: "requires-permission", reason: "action touches external surface" };
  }
  if (rules.gateIrreversible && req.reversible === false) {
    return { classification: "requires-permission", reason: "action is irreversible" };
  }
  const scope = req.scope ?? "local";
  if (rules.autoAllowScopes?.includes(scope)) {
    return { classification: "auto-allowed", reason: `scope '${scope}' auto-allowed by policy '${bundleName}'` };
  }
  return { classification: "requires-permission", reason: `scope '${scope}' not auto-allowed by policy '${bundleName}'` };
}

// ─── Core API ────────────────────────────────────────────────────────────────

const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

export async function requestPermission(req: ActionRequest): Promise<Decision> {
  const db = getDb();
  const accountId = req.accountId ?? "default";
  const cfg = getAccountConfig(accountId);
  const bundleName = req.policyBundle ?? (cfg["policy_bundle"] as string) ?? "local-only";
  const { classification, reason } = classifyAction(req);

  const status: ActionStatus = classification === "auto-allowed"
    ? "auto-approved"
    : classification === "denied"
      ? "denied"
      : "pending";

  const expiresAt = classification === "requires-permission"
    ? Math.floor((Date.now() + APPROVAL_TTL_MS) / 1000)
    : null;

  const result = db.prepare(`
    INSERT INTO safety_actions (
      account_id, kind, summary, details_json, requested_by, session_id, cycle_id,
      classification, status, reversible, external_surface, scope, policy_bundle, expires_at,
      decided_at, decided_by, decision_note
    )
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    accountId,
    req.kind,
    req.summary,
    req.details ? JSON.stringify(req.details) : null,
    req.requestedBy,
    req.sessionId ?? null,
    req.cycleId ?? null,
    classification,
    status,
    req.reversible === false ? 0 : 1,
    req.externalSurface ? 1 : 0,
    req.scope ?? "local",
    bundleName,
    expiresAt,
    status === "auto-approved" ? Math.floor(Date.now() / 1000) : null,
    status === "auto-approved" ? "policy:auto" : null,
    status === "auto-approved" ? reason : null,
  );

  const actionId = result.lastInsertRowid as number;
  recordTranscript(actionId, req.cycleId ?? null, "classify", reason, { classification, bundle: bundleName });

  if (status === "pending") {
    const action = getActionById(actionId);
    if (action) {
      recordTranscript(actionId, req.cycleId ?? null, "request", `Approval requested via channels`, {});
      await dispatchNotifications(action);
      events.emit("event", { type: "requested", action });
    }
  }

  const allowed = status === "auto-approved";
  return {
    actionId,
    classification,
    status,
    allowed,
    reason: allowed ? `auto-approved: ${reason}` : reason,
  };
}

async function dispatchNotifications(action: SafetyAction): Promise<void> {
  const db = getDb();
  for (const [name, fn] of channels.entries()) {
    try {
      await fn(action);
      db.prepare(`INSERT INTO safety_notifications (action_id, channel, status) VALUES (?, ?, 'delivered')`).run(action.id, name);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      db.prepare(`INSERT INTO safety_notifications (action_id, channel, status, error) VALUES (?, ?, 'failed', ?)`).run(action.id, name, msg);
      logger.warn({ err, channel: name, actionId: action.id }, "[safety] notification channel failed");
    }
  }
}

function rowToAction(row: Record<string, unknown>): SafetyAction {
  return {
    id: row["id"] as number,
    accountId: row["account_id"] as string,
    kind: row["kind"] as string,
    summary: row["summary"] as string,
    details: row["details_json"] ? JSON.parse(row["details_json"] as string) : null,
    requestedBy: row["requested_by"] as string,
    sessionId: (row["session_id"] as number | null) ?? null,
    cycleId: (row["cycle_id"] as number | null) ?? null,
    classification: row["classification"] as Classification,
    status: row["status"] as ActionStatus,
    reversible: !!row["reversible"],
    externalSurface: !!row["external_surface"],
    scope: row["scope"] as ActionScope,
    policyBundle: (row["policy_bundle"] as string | null) ?? null,
    createdAt: row["created_at"] as number,
    decidedAt: (row["decided_at"] as number | null) ?? null,
    decidedBy: (row["decided_by"] as string | null) ?? null,
    decisionNote: (row["decision_note"] as string | null) ?? null,
    expiresAt: (row["expires_at"] as number | null) ?? null,
  };
}

export function getActionById(id: number): SafetyAction | null {
  const db = getDb();
  const row = db.prepare(`SELECT * FROM safety_actions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
  return row ? rowToAction(row) : null;
}

export function listPendingApprovals(params: { accountId?: string; limit?: number; offset?: number } = {}): SafetyAction[] {
  const db = getDb();
  const limit = Math.min(params.limit ?? 50, 200);
  const offset = params.offset ?? 0;
  const accountId = params.accountId ?? "default";
  const rows = db.prepare(`
    SELECT * FROM safety_actions
    WHERE account_id = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT ? OFFSET ?
  `).all(accountId, limit, offset) as Record<string, unknown>[];
  return rows.map(rowToAction);
}

export function listActions(params: {
  accountId?: string;
  status?: ActionStatus;
  limit?: number;
  offset?: number;
} = {}): SafetyAction[] {
  const db = getDb();
  const limit = Math.min(params.limit ?? 100, 500);
  const offset = params.offset ?? 0;
  const accountId = params.accountId ?? "default";
  const rows = params.status
    ? db.prepare(`SELECT * FROM safety_actions WHERE account_id = ? AND status = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(accountId, params.status, limit, offset)
    : db.prepare(`SELECT * FROM safety_actions WHERE account_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(accountId, limit, offset);
  return (rows as Record<string, unknown>[]).map(rowToAction);
}

export function decideAction(params: {
  actionId: number;
  decision: "approve" | "deny";
  decidedBy: string;
  note?: string;
}): SafetyAction | null {
  const db = getDb();
  const action = getActionById(params.actionId);
  if (!action) return null;
  if (action.status !== "pending") return action;

  const newStatus: ActionStatus = params.decision === "approve" ? "approved" : "denied";
  db.prepare(`
    UPDATE safety_actions
    SET status = ?, decided_at = unixepoch(), decided_by = ?, decision_note = ?
    WHERE id = ?
  `).run(newStatus, params.decidedBy, params.note ?? null, params.actionId);

  recordTranscript(params.actionId, action.cycleId, "decide", `${params.decision} by ${params.decidedBy}`, { note: params.note ?? null });

  const updated = getActionById(params.actionId);
  if (updated) {
    events.emit("event", { type: "decided", action: updated });
    if (updated.status === "approved") {
      scheduleExecutor(updated);
    }
  }
  return updated;
}

// ─── Action executors (deferred approval pipeline) ──────────────────────────

/**
 * Executors run when a previously-pending action is approved by an operator.
 * Each kind registers a single executor; once approved, the safety subsystem
 * invokes it asynchronously and marks the action executed/failed automatically.
 */
export type ActionExecutor = (action: SafetyAction) => Promise<void> | void;
const executors = new Map<string, ActionExecutor>();

export function registerActionExecutor(kind: string, fn: ActionExecutor): void {
  executors.set(kind, fn);
  logger.info({ kind }, "[safety] executor registered");
}

export function unregisterActionExecutor(kind: string): void {
  executors.delete(kind);
}

function scheduleExecutor(action: SafetyAction): void {
  const fn = executors.get(action.kind);
  if (!fn) {
    // No registered executor — leave the action in 'approved' state. An
    // out-of-band operator/process can still inspect it, and a pickup worker
    // (drainApprovedActions) will retry once an executor is registered.
    return;
  }
  setImmediate(async () => {
    try {
      await fn(action);
      const cur = getActionById(action.id);
      if (cur && cur.status === "approved") {
        markExecuted(action.id, true, "executor completed");
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error({ err, actionId: action.id, kind: action.kind }, "[safety] executor failed");
      markExecuted(action.id, false, msg);
    }
  });
}

/**
 * Sweep approved-but-not-yet-executed actions and dispatch them to their
 * registered executors. Called on startup so an executor that registers
 * after a restart still picks up actions approved while the process was down.
 */
export function drainApprovedActions(): number {
  const db = getDb();
  const rows = db.prepare(`SELECT * FROM safety_actions WHERE status = 'approved'`).all() as Record<string, unknown>[];
  let scheduled = 0;
  for (const row of rows) {
    const action = rowToAction(row);
    if (executors.has(action.kind)) {
      scheduleExecutor(action);
      scheduled++;
    }
  }
  if (scheduled > 0) logger.info({ scheduled }, "[safety] drained approved actions on startup");
  return scheduled;
}

/**
 * Find an existing pending action with the same kind (and optionally the
 * same dedupe signature) for an account. Used by callers to avoid
 * re-requesting approval for the same intent on every cycle.
 */
export function findPendingByKind(accountId: string, kind: string): SafetyAction | null {
  const db = getDb();
  const row = db.prepare(`
    SELECT * FROM safety_actions
    WHERE account_id = ? AND kind = ? AND status = 'pending'
    ORDER BY created_at DESC LIMIT 1
  `).get(accountId, kind) as Record<string, unknown> | undefined;
  return row ? rowToAction(row) : null;
}

/**
 * Block until an approval request is decided or expires. Returns the final
 * SafetyAction state. Useful for callers that need to await a decision
 * synchronously (e.g. a single ambient cycle waiting for explicit consent).
 */
export function awaitDecision(actionId: number, timeoutMs = APPROVAL_TTL_MS): Promise<SafetyAction | null> {
  const initial = getActionById(actionId);
  if (!initial) return Promise.resolve(null);
  if (initial.status !== "pending") return Promise.resolve(initial);

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      events.off("event", onEvent);
      // Mark as expired if still pending
      const cur = getActionById(actionId);
      if (cur && cur.status === "pending") {
        const db = getDb();
        db.prepare(`UPDATE safety_actions SET status = 'expired' WHERE id = ?`).run(actionId);
        recordTranscript(actionId, cur.cycleId, "decide", `expired after ${timeoutMs}ms`, {});
        resolve(getActionById(actionId));
      } else {
        resolve(cur);
      }
    }, timeoutMs);

    function onEvent(event: { type: string; action: SafetyAction }) {
      if (event.action.id !== actionId) return;
      if (event.action.status === "pending") return;
      clearTimeout(timer);
      events.off("event", onEvent);
      resolve(event.action);
    }
    events.on("event", onEvent);
  });
}

export function markExecuted(actionId: number, success: boolean, note?: string): void {
  const db = getDb();
  db.prepare(`UPDATE safety_actions SET status = ? WHERE id = ?`).run(success ? "executed" : "failed", actionId);
  recordTranscript(actionId, null, "execute", success ? "executed" : "failed", { note: note ?? null });
}

// ─── Transcript ──────────────────────────────────────────────────────────────

export function recordTranscript(
  actionId: number | null,
  cycleId: number | null,
  kind: string,
  message: string,
  metadata?: Record<string, unknown>,
): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO safety_transcript (action_id, cycle_id, kind, message, metadata_json)
    VALUES (?, ?, ?, ?, ?)
  `).run(actionId, cycleId, kind, message, metadata ? JSON.stringify(metadata) : null);
}

export interface TranscriptEntry {
  id: number;
  actionId: number | null;
  cycleId: number | null;
  kind: string;
  message: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export function listTranscript(params: {
  actionId?: number;
  cycleId?: number;
  kind?: string;
  limit?: number;
  offset?: number;
} = {}): TranscriptEntry[] {
  const db = getDb();
  const conds: string[] = [];
  const args: unknown[] = [];
  if (params.actionId !== undefined) { conds.push("action_id = ?"); args.push(params.actionId); }
  if (params.cycleId !== undefined) { conds.push("cycle_id = ?"); args.push(params.cycleId); }
  if (params.kind) { conds.push("kind = ?"); args.push(params.kind); }
  const where = conds.length > 0 ? `WHERE ${conds.join(" AND ")}` : "";
  const limit = Math.min(params.limit ?? 200, 1000);
  const offset = params.offset ?? 0;
  args.push(limit, offset);
  const rows = db.prepare(`SELECT * FROM safety_transcript ${where} ORDER BY created_at DESC LIMIT ? OFFSET ?`).all(...args) as Record<string, unknown>[];
  return rows.map(r => ({
    id: r["id"] as number,
    actionId: (r["action_id"] as number | null) ?? null,
    cycleId: (r["cycle_id"] as number | null) ?? null,
    kind: r["kind"] as string,
    message: r["message"] as string,
    metadata: r["metadata_json"] ? JSON.parse(r["metadata_json"] as string) : null,
    createdAt: r["created_at"] as number,
  }));
}

// ─── Policy management ───────────────────────────────────────────────────────

export function listPolicies(): { bundle: string; description: string | null; rules: PolicyRules; updatedAt: number }[] {
  const db = getDb();
  const rows = db.prepare(`SELECT bundle, description, rules_json, updated_at FROM safety_policies`).all() as Array<{
    bundle: string; description: string | null; rules_json: string; updated_at: number;
  }>;
  return rows.map(r => ({
    bundle: r.bundle,
    description: r.description,
    rules: JSON.parse(r.rules_json) as PolicyRules,
    updatedAt: r.updated_at,
  }));
}

export function setPolicy(bundle: string, rules: PolicyRules, description?: string): void {
  const db = getDb();
  db.prepare(`
    INSERT INTO safety_policies (bundle, description, rules_json, updated_at)
    VALUES (?, ?, ?, unixepoch())
    ON CONFLICT(bundle) DO UPDATE SET rules_json = excluded.rules_json, description = excluded.description, updated_at = unixepoch()
  `).run(bundle, description ?? null, JSON.stringify(rules));
}

// ─── Initialization helper ───────────────────────────────────────────────────

export function initSafetySubsystem(): void {
  getDb();
  logger.info("[safety] subsystem initialized");
}

/** Internal accessor for ambient.ts to share the same DB. */
export function _internalGetDb(): Database.Database {
  return getDb();
}
