/**
 * repo-db.mjs — SQLite graph/FTS/vector store for Repo Intelligence
 *
 * Creates and manages a SQLite database at /workspace/.mizi/repo-graph.db with:
 *   - files table (path, lang, size, centrality, hash, mtime)
 *   - symbols table (name, kind, path, line, lang, signature, docstring)
 *   - edges table (from_path, to_path, kind)
 *   - files_fts  — FTS5 virtual table over files
 *   - symbols_fts — FTS5 virtual table over symbols
 *   - embeddings table (path_or_symbol, vec BLOB of float32[])
 *
 * Uses better-sqlite3 (synchronous, safe for single-threaded indexing scripts).
 * Falls back gracefully if better-sqlite3 is not available.
 */

const DB_PATH = process.env.MIZI_GRAPH_DB || '/workspace/.mizi/repo-graph.db';

let _db = null;
let _available = null;

async function isAvailable() {
  if (_available !== null) return _available;
  try {
    const mod = await import('better-sqlite3');
    _available = true;
    return true;
  } catch {
    _available = false;
    return false;
  }
}

export async function openDb(dbPath) {
  if (_db) return _db;
  if (!(await isAvailable())) {
    console.warn('[repo-db] better-sqlite3 not available — falling back to in-memory JSON store');
    return null;
  }

  const { default: Database } = await import('better-sqlite3');
  const { mkdirSync } = await import('fs');
  const { dirname } = await import('path');

  const resolvedPath = dbPath || DB_PATH;
  mkdirSync(dirname(resolvedPath), { recursive: true });

  const db = new Database(resolvedPath);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -32000');
  db.pragma('temp_store = MEMORY');

  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE TABLE IF NOT EXISTS files (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      path          TEXT NOT NULL UNIQUE,
      lang          TEXT,
      size_bytes    INTEGER DEFAULT 0,
      content_hash  TEXT,
      mtime         INTEGER DEFAULT 0,
      centrality    REAL DEFAULT 0,
      dep_in        INTEGER DEFAULT 0,
      dep_out       INTEGER DEFAULT 0,
      indexed_at    INTEGER DEFAULT (unixepoch())
    );

    CREATE TABLE IF NOT EXISTS symbols (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      file_id       INTEGER REFERENCES files(id) ON DELETE CASCADE,
      name          TEXT NOT NULL,
      kind          TEXT NOT NULL,
      path          TEXT NOT NULL,
      line          INTEGER,
      lang          TEXT,
      signature     TEXT,
      docstring     TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(path);
    CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name);

    CREATE TABLE IF NOT EXISTS edges (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      from_path     TEXT NOT NULL,
      to_path       TEXT NOT NULL,
      kind          TEXT DEFAULT 'import',
      UNIQUE(from_path, to_path, kind)
    );
    CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_path);
    CREATE INDEX IF NOT EXISTS idx_edges_to   ON edges(to_path);

    CREATE TABLE IF NOT EXISTS embeddings (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      ref           TEXT NOT NULL UNIQUE,
      ref_type      TEXT NOT NULL,
      vec           BLOB
    );

    CREATE VIRTUAL TABLE IF NOT EXISTS files_fts
      USING fts5(path, lang, content='files', content_rowid='id', tokenize='unicode61 remove_diacritics 1');

    CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts
      USING fts5(name, kind, path, signature, docstring, content='symbols', content_rowid='id', tokenize='unicode61 remove_diacritics 1');
  `);

  _db = db;
  return db;
}

export function closeDb() {
  if (_db) {
    _db.close();
    _db = null;
  }
}

export function setMeta(db, key, value) {
  db.prepare('INSERT OR REPLACE INTO meta(key, value) VALUES (?, ?)').run(key, JSON.stringify(value));
}

export function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? JSON.parse(row.value) : null;
}

export function upsertFile(db, file) {
  return db.prepare(`
    INSERT INTO files (path, lang, size_bytes, content_hash, mtime, centrality, dep_in, dep_out)
    VALUES (@path, @lang, @size_bytes, @content_hash, @mtime, @centrality, @dep_in, @dep_out)
    ON CONFLICT(path) DO UPDATE SET
      lang = excluded.lang,
      size_bytes = excluded.size_bytes,
      content_hash = excluded.content_hash,
      mtime = excluded.mtime,
      centrality = excluded.centrality,
      dep_in = excluded.dep_in,
      dep_out = excluded.dep_out,
      indexed_at = unixepoch()
    RETURNING id
  `).get(file);
}

export function insertSymbols(db, symbols) {
  const stmt = db.prepare(`
    INSERT OR IGNORE INTO symbols (file_id, name, kind, path, line, lang, signature, docstring)
    VALUES (@file_id, @name, @kind, @path, @line, @lang, @signature, @docstring)
  `);
  const insertMany = db.transaction((syms) => {
    for (const s of syms) stmt.run(s);
  });
  insertMany(symbols);
}

export function deleteSymbolsForFile(db, fileId) {
  db.prepare('DELETE FROM symbols WHERE file_id = ?').run(fileId);
}

export function insertEdge(db, fromPath, toPath, kind) {
  db.prepare('INSERT OR IGNORE INTO edges(from_path, to_path, kind) VALUES (?, ?, ?)').run(fromPath, toPath, kind || 'import');
}

export function rebuildFts(db) {
  try {
    db.exec(`INSERT INTO files_fts(files_fts) VALUES('rebuild')`);
    db.exec(`INSERT INTO symbols_fts(symbols_fts) VALUES('rebuild')`);
  } catch (err) {
    console.warn('[repo-db] FTS rebuild error:', err.message);
  }
}

export function storeEmbedding(db, ref, refType, vec) {
  const buf = Buffer.from(new Float32Array(vec).buffer);
  db.prepare('INSERT OR REPLACE INTO embeddings(ref, ref_type, vec) VALUES (?, ?, ?)').run(ref, refType, buf);
}

export function getEmbedding(db, ref) {
  const row = db.prepare('SELECT vec FROM embeddings WHERE ref = ?').get(ref);
  if (!row || !row.vec) return null;
  return Array.from(new Float32Array(row.vec.buffer));
}

export function searchFts(db, query, limit = 20) {
  try {
    const results = db.prepare(`
      SELECT s.name, s.kind, s.path, s.line, s.lang, s.signature,
             rank AS fts_rank
      FROM symbols_fts
      JOIN symbols s ON s.id = symbols_fts.rowid
      WHERE symbols_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsEscape(query), limit);
    return results;
  } catch {
    return [];
  }
}

export function searchFtsFiles(db, query, limit = 20) {
  try {
    return db.prepare(`
      SELECT f.path, f.lang, f.size_bytes, f.centrality,
             rank AS fts_rank
      FROM files_fts
      JOIN files f ON f.id = files_fts.rowid
      WHERE files_fts MATCH ?
      ORDER BY rank
      LIMIT ?
    `).all(ftsEscape(query), limit);
  } catch {
    return [];
  }
}

export function getAllFiles(db) {
  return db.prepare('SELECT path, lang, size_bytes, centrality, dep_in, dep_out, content_hash, mtime FROM files').all();
}

export function getAllSymbols(db, limit = 5000) {
  return db.prepare('SELECT name, kind, path, line, lang, signature, docstring FROM symbols LIMIT ?').all(limit);
}

export function getAllEdges(db, limit = 2000) {
  return db.prepare('SELECT from_path, to_path, kind FROM edges LIMIT ?').all(limit);
}

export function getStats(db) {
  const files = db.prepare('SELECT COUNT(*) as n FROM files').get().n;
  const symbols = db.prepare('SELECT COUNT(*) as n FROM symbols').get().n;
  const edges = db.prepare('SELECT COUNT(*) as n FROM edges').get().n;
  const embeddings = db.prepare('SELECT COUNT(*) as n FROM embeddings').get().n;
  return { files, symbols, edges, embeddings };
}

/**
 * Retrieve top-N stored MiniLM (or n-gram fallback) embeddings from local SQLite.
 * Intended for future use when the cloud sync path adds server-side query encoding
 * (e.g. via a remote embedding API) so that real 384-dim model vectors can be sent
 * and used for cosine similarity at search time.
 * Currently the sync payload uses 512-dim n-gram vectors (see syncNgramVec in
 * repo-indexer.mjs) to guarantee dimension compatibility with the server query encoder.
 * Returns an array of { ref, refType, vec } where vec is a float32 number[].
 */
export function getAllEmbeddings(db, limit = 300) {
  const rows = db.prepare('SELECT ref, ref_type, vec FROM embeddings LIMIT ?').all(limit);
  return rows.map(row => ({
    ref: row.ref,
    refType: row.ref_type,
    vec: row.vec ? Array.from(new Float32Array(row.vec.buffer)) : [],
  }));
}

function ftsEscape(q) {
  return q.replace(/["'*]/g, ' ').trim() + '*';
}
