/**
 * local-migrate.ts
 *
 * SQLite migration runner for Mizi-Local.
 * Creates tables on first boot if they do not exist.
 * Uses a simplified schema for local-only tables (sessions, profiles, skills).
 * Runs synchronously at startup to ensure DB is ready before serving requests.
 */

import Database from "better-sqlite3";
import path from "path";
import os from "os";
import fs from "fs";
import { logger } from "../lib/logger.js";

const LOCAL_DB_DIR =
  process.env.MIZI_LOCAL_DB_DIR || path.join(os.homedir(), ".mizi");
const LOCAL_DB_PATH =
  process.env.MIZI_LOCAL_DB_PATH || path.join(LOCAL_DB_DIR, "local.db");

const LOCAL_DDL = `
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_id INTEGER NOT NULL DEFAULT 0,
  provider TEXT NOT NULL DEFAULT 'local',
  status TEXT NOT NULL DEFAULT 'ready',
  status_message TEXT,
  model_id TEXT,
  workspace_dir TEXT,
  template_slug TEXT,
  intent_text TEXT,
  plan_snapshot_json TEXT,
  repo_url TEXT,
  started_at TEXT DEFAULT (datetime('now')),
  stopped_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS local_models (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  model_id TEXT NOT NULL UNIQUE,
  display_name TEXT,
  source TEXT NOT NULL DEFAULT 'ollama',
  hf_repo TEXT,
  hf_file TEXT,
  size_gb REAL,
  pulled_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS workspace_templates_used (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id INTEGER NOT NULL REFERENCES sessions(id),
  template_slug TEXT NOT NULL,
  applied_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS hardware_profiles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  profile_json TEXT NOT NULL,
  detected_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS local_migrations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  version TEXT NOT NULL UNIQUE,
  applied_at TEXT DEFAULT (datetime('now'))
);
`;

export function runLocalMigrations(): void {
  if (!fs.existsSync(LOCAL_DB_DIR)) {
    fs.mkdirSync(LOCAL_DB_DIR, { recursive: true });
  }

  logger.info({ dbPath: LOCAL_DB_PATH }, "[local-migrate] Running SQLite migrations");

  const db = new Database(LOCAL_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    db.exec(LOCAL_DDL);

    // ── Incremental column additions for existing databases ──────────────────
    // SQLite does not support IF NOT EXISTS for ALTER TABLE ADD COLUMN, so we
    // probe the schema and add columns that may be missing from older DBs.
    const existingCols: string[] = (
      db.pragma("table_info(sessions)") as Array<{ name: string }>
    ).map((r) => r.name);
    if (!existingCols.includes("repo_url")) {
      db.exec("ALTER TABLE sessions ADD COLUMN repo_url TEXT;");
      logger.info("[local-migrate] Added repo_url column to sessions");
    }

    const version = "v1.1.0-local";
    db.prepare(
      "INSERT OR IGNORE INTO local_migrations (version) VALUES (?)"
    ).run(version);
    logger.info({ version }, "[local-migrate] Migrations complete");
  } finally {
    db.close();
  }
}
