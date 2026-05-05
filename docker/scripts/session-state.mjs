#!/usr/bin/env node
/**
 * session-state.mjs — Per-session SQLite event journal and working state store
 *
 * DB path: /workspace/.mizi/session-state.db  (MIZI_STATE_DB override)
 *
 * Tables:
 *   events        — append-only actor/event log (task, tool use, plan changes, etc.)
 *   snapshots     — compaction snapshots with schema_version for forward-compat restore
 *   active_state  — singleton mutable working state (current task, plan, active files)
 *   routing_stats — cumulative shielded-execution counters
 */

import { createRequire } from 'module';
import { existsSync, mkdirSync } from 'fs';
import { dirname } from 'path';

const require = createRequire(import.meta.url);

export const DB_PATH = process.env.MIZI_STATE_DB || '/workspace/.mizi/session-state.db';
export const SCHEMA_VERSION = 1;

// ── DB open + schema provision ────────────────────────────────────────────────

export function openDb(dbPath = DB_PATH) {
  const dir = dirname(dbPath);
  if (!existsSync(dir)) {
    try {
      mkdirSync(dir, { recursive: true });
    } catch {
      return null; // Cannot create DB directory (permissions or path not writable)
    }
  }

  let Database;
  try {
    Database = require('better-sqlite3');
  } catch {
    return null;
  }

  const db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS events (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      actor_type TEXT    NOT NULL,
      actor_id   TEXT    NOT NULL DEFAULT '',
      timestamp  TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      task_id    TEXT    NOT NULL DEFAULT '',
      event_type TEXT    NOT NULL,
      payload    TEXT    NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS events_event_type ON events (event_type);
    CREATE INDEX IF NOT EXISTS events_task_id    ON events (task_id);

    CREATE TABLE IF NOT EXISTS snapshots (
      id             INTEGER PRIMARY KEY AUTOINCREMENT,
      created_at     TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      schema_version INTEGER NOT NULL DEFAULT ${SCHEMA_VERSION},
      payload        TEXT    NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS active_state (
      id         INTEGER PRIMARY KEY DEFAULT 1,
      updated_at TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      state      TEXT    NOT NULL DEFAULT '{}'
    );

    CREATE TABLE IF NOT EXISTS routing_stats (
      id                  INTEGER PRIMARY KEY DEFAULT 1,
      total_shielded      INTEGER NOT NULL DEFAULT 0,
      total_bytes_avoided INTEGER NOT NULL DEFAULT 0,
      total_artifacts     INTEGER NOT NULL DEFAULT 0,
      total_blocked       INTEGER NOT NULL DEFAULT 0,
      restore_success     INTEGER NOT NULL DEFAULT 0,
      restore_failure     INTEGER NOT NULL DEFAULT 0,
      routing_failures    INTEGER NOT NULL DEFAULT 0,
      updated_at          TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
    );

    CREATE TABLE IF NOT EXISTS routing_decisions (
      id        INTEGER PRIMARY KEY AUTOINCREMENT,
      timestamp TEXT    NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
      class     TEXT    NOT NULL,
      shielded  INTEGER NOT NULL DEFAULT 1,
      blocked   INTEGER NOT NULL DEFAULT 0,
      bytes_avoided INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS routing_decisions_class ON routing_decisions (class);

    INSERT OR IGNORE INTO active_state  (id, state)  VALUES (1, '{}');
    INSERT OR IGNORE INTO routing_stats (id)          VALUES (1);
  `);

  return db;
}

// ── Event log ─────────────────────────────────────────────────────────────────

export function appendEvent(db, {
  actor_type,
  actor_id = '',
  task_id = '',
  event_type,
  payload = {},
}) {
  if (!db) return;
  db.prepare(`
    INSERT INTO events (actor_type, actor_id, task_id, event_type, payload)
    VALUES (?, ?, ?, ?, ?)
  `).run(actor_type, actor_id, task_id, event_type, JSON.stringify(payload));
}

export function readRecentEvents(db, limit = 50) {
  if (!db) return [];
  const rows = db.prepare(
    `SELECT * FROM events ORDER BY id DESC LIMIT ?`
  ).all(limit);
  return rows.reverse().map(r => {
    try { return { ...r, payload: JSON.parse(r.payload) }; } catch { return r; }
  });
}

// ── Snapshots ─────────────────────────────────────────────────────────────────

export function writeSnapshot(db, state) {
  if (!db) return;
  const payload = { ...state, schema_version: SCHEMA_VERSION };
  db.prepare(`
    INSERT INTO snapshots (schema_version, payload) VALUES (?, ?)
  `).run(SCHEMA_VERSION, JSON.stringify(payload));
  db.prepare(
    `DELETE FROM snapshots WHERE id NOT IN (SELECT id FROM snapshots ORDER BY id DESC LIMIT 10)`
  ).run();
}

export function readLatestSnapshot(db) {
  if (!db) return null;
  const row = db.prepare(
    `SELECT * FROM snapshots ORDER BY id DESC LIMIT 1`
  ).get();
  if (!row) return null;
  try {
    return {
      ...JSON.parse(row.payload),
      _created_at: row.created_at,
      _schema_version: row.schema_version,
    };
  } catch { return null; }
}

// ── Active state (singleton working state) ────────────────────────────────────

export function updateActiveState(db, state) {
  if (!db) return;
  db.prepare(`
    UPDATE active_state
    SET state = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = 1
  `).run(JSON.stringify(state));
}

export function readActiveState(db) {
  if (!db) return {};
  const row = db.prepare(`SELECT state FROM active_state WHERE id = 1`).get();
  if (!row) return {};
  try { return JSON.parse(row.state); } catch { return {}; }
}

// ── Routing stats ─────────────────────────────────────────────────────────────

export function incrementRoutingStats(db, {
  shielded = 0,
  bytesAvoided = 0,
  artifacts = 0,
  blocked = 0,
  restoreSuccess = 0,
  restoreFailure = 0,
  routingFailures = 0,
} = {}) {
  if (!db) return;
  db.prepare(`
    UPDATE routing_stats SET
      total_shielded      = total_shielded      + ?,
      total_bytes_avoided = total_bytes_avoided + ?,
      total_artifacts     = total_artifacts     + ?,
      total_blocked       = total_blocked       + ?,
      restore_success     = restore_success     + ?,
      restore_failure     = restore_failure     + ?,
      routing_failures    = routing_failures    + ?,
      updated_at          = strftime('%Y-%m-%dT%H:%M:%SZ', 'now')
    WHERE id = 1
  `).run(shielded, bytesAvoided, artifacts, blocked, restoreSuccess, restoreFailure, routingFailures);
}

export function readRoutingStats(db) {
  if (!db) return {};
  return db.prepare(`SELECT * FROM routing_stats WHERE id = 1`).get() || {};
}

// ── Routing decision log ──────────────────────────────────────────────────────

export function appendRoutingDecision(db, { class: cls, shielded = 1, blocked = 0, bytesAvoided = 0 }) {
  if (!db) return;
  db.prepare(`
    INSERT INTO routing_decisions (class, shielded, blocked, bytes_avoided)
    VALUES (?, ?, ?, ?)
  `).run(cls, shielded ? 1 : 0, blocked ? 1 : 0, bytesAvoided);
}

export function readRoutingBreakdown(db) {
  if (!db) return [];
  return db.prepare(`
    SELECT class,
           COUNT(*)                         AS total,
           SUM(shielded)                    AS shielded,
           SUM(blocked)                     AS blocked,
           SUM(bytes_avoided)               AS bytes_avoided
    FROM routing_decisions
    GROUP BY class
    ORDER BY total DESC
  `).all();
}

export function readRecentRoutingFailures(db, limit = 20) {
  if (!db) return [];
  const rows = db.prepare(`
    SELECT * FROM events WHERE event_type IN ('exec_blocked','exec_error','routing_failure')
    ORDER BY id DESC LIMIT ?
  `).all(limit);
  return rows.map(r => {
    try { return { ...r, payload: JSON.parse(r.payload) }; } catch { return r; }
  });
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// Usage:
//   node session-state.mjs provision
//   node session-state.mjs append-event  '{"actor_type":"claw","event_type":"task_start","payload":{}}'
//   node session-state.mjs snapshot      '{"activeTask":"...","planCheckpoint":"..."}'
//   node session-state.mjs restore
//   node session-state.mjs stats
//   node session-state.mjs update-state  '{"activeTask":"..."}'

if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [,, cmd, ...args] = process.argv;
  const db = openDb();

  try {
    switch (cmd) {
      case 'provision':
        if (!db) {
          process.stderr.write(JSON.stringify({ ok: false, error: `Cannot open DB at ${DB_PATH} — directory may not be writable` }) + '\n');
          process.exit(1);
        }
        console.log(JSON.stringify({ ok: true, dbPath: DB_PATH }));
        break;

      case 'append-event': {
        const ev = JSON.parse(args[0] || '{}');
        appendEvent(db, ev);
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'snapshot': {
        const state = JSON.parse(args[0] || '{}');
        writeSnapshot(db, state);
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'restore': {
        const snapshot = readLatestSnapshot(db);
        const events   = readRecentEvents(db, 20);
        const stats    = readRoutingStats(db);
        const state    = readActiveState(db);
        console.log(JSON.stringify({ snapshot, events, stats, state }));
        break;
      }

      case 'stats':
        console.log(JSON.stringify(readRoutingStats(db)));
        break;

      case 'update-state': {
        const state = JSON.parse(args[0] || '{}');
        updateActiveState(db, state);
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'increment-stats': {
        const delta = JSON.parse(args[0] || '{}');
        incrementRoutingStats(db, {
          shielded:        delta.shielded        || 0,
          bytesAvoided:    delta.bytesAvoided    || 0,
          artifacts:       delta.artifacts       || 0,
          blocked:         delta.blocked         || 0,
          restoreSuccess:  delta.restoreSuccess  || 0,
          restoreFailure:  delta.restoreFailure  || 0,
          routingFailures: delta.routingFailures || 0,
        });
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'routing-decision': {
        const d = JSON.parse(args[0] || '{}');
        appendRoutingDecision(db, {
          class:        d.class      || 'unknown',
          shielded:     d.shielded   || 0,
          blocked:      d.blocked    || 0,
          bytesAvoided: d.bytesAvoided || 0,
        });
        console.log(JSON.stringify({ ok: true }));
        break;
      }

      case 'routing-breakdown': {
        const breakdown = readRoutingBreakdown(db);
        const failures  = readRecentRoutingFailures(db, 5);
        console.log(JSON.stringify({ breakdown, recentFailures: failures }));
        break;
      }

      default:
        process.stderr.write(
          `Usage: session-state.mjs <provision|append-event|snapshot|restore|stats|update-state|increment-stats> [json]\n`
        );
        process.exit(1);
    }
  } finally {
    if (db) db.close();
  }
}
