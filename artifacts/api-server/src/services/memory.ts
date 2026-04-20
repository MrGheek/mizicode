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

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (_db) return _db;

  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  } catch (err) {
    logger.warn({ err, DATA_DIR }, "Could not create memory data directory");
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

  return _db;
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

export function listSessions(userId: string, limit = 50, offset = 0): SessionSummary[] {
  const db = getDb();
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

export function searchMemory(userId: string, rawQuery: string, limit = 30): MemorySearchResult {
  const db = getDb();
  const trimmed = rawQuery.trim();
  if (!trimmed) return { observations: [], sessions: [] };

  const ftsQuery = trimmed
    .split(/\s+/)
    .map((w) => `"${w.replace(/"/g, '""')}"*`)
    .join(" ");

  let observations: SearchResultObservation[] = [];
  try {
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
  } catch (err) {
    logger.warn({ err, ftsQuery, rawQuery }, "[mem] FTS5 query parse failed — returning empty observations");
    observations = [];
  }

  const likePattern = `%${trimmed.replace(/%/g, "\\%").replace(/_/g, "\\_")}%`;
  const sessions = db.prepare(`
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
