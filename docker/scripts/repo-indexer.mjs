#!/usr/bin/env node
/**
 * repo-indexer.mjs — Repo Intelligence: Main orchestrator
 *
 * Indexing pipeline per job:
 *   queued → scanning → fingerprinting → indexing_graph
 *   → indexing_fts → indexing_vectors → summarizing → ready | error
 *
 * Storage:
 *   /workspace/.floatr/repo-graph.db — SQLite with FTS5 + optional vector table
 *
 * Parsing:
 *   Tree-sitter (tree-sitter + language packs) with regex fallback
 *
 * Semantic scoring:
 *   Character n-gram TF-IDF vectors (lightweight, no model download required)
 *   Falls back to zero-vector if embedding store is empty.
 *
 * Hard limits (env-configurable):
 *   REPO_INDEX_MAX_DURATION_MS  (default 300000 = 5 min)
 *   REPO_INDEX_MAX_SYMBOLS      (default 5000)
 *   REPO_INDEX_MAX_FILES        (default 2000)
 *   REPO_INDEX_MAX_EDGES        (default 5000)
 *   REPO_INDEX_POLL_INTERVAL_SECS (default 30 — daemon mode)
 *
 * Env:
 *   OMNIQL_CALLBACK_URL, OMNIQL_MEM_AUTH_TOKEN, OMNIQL_SESSION_ID
 *   FLOATR_REPO_JOB_ID   — if set: single-job mode and exit
 *   FLOATR_REPO_PATH     — repo root (default /workspace/projects)
 *   FLOATR_GRAPH_DB      — SQLite path (default /workspace/.floatr/repo-graph.db)
 */

import { fingerprint as runFingerprint } from './repo-fingerprint.mjs';
import { buildGraph, computeFileCentrality } from './repo-graph.mjs';
import { buildSummary } from './repo-summary.mjs';
import {
  openDb, closeDb, setMeta, getMeta,
  upsertFile, insertSymbols, deleteSymbolsForFile, insertEdge,
  rebuildFts, searchFts, searchFtsFiles,
  getAllFiles, getAllSymbols, getAllEdges, getStats,
  storeEmbedding,
} from './repo-db.mjs';
import { extractSymbols } from './repo-parse.mjs';
import { readFileSync, statSync, readdirSync } from 'fs';
import { createHash } from 'crypto';
import { join, extname, relative } from 'path';

const CALLBACK_BASE_RAW = process.env.OMNIQL_CALLBACK_URL || '';
const AUTH_TOKEN = process.env.OMNIQL_MEM_AUTH_TOKEN || '';
const SESSION_ID = process.env.OMNIQL_SESSION_ID || '';
const SPECIFIC_JOB_ID = parseInt(process.env.FLOATR_REPO_JOB_ID || '0', 10);
const DEFAULT_REPO_PATH = process.env.FLOATR_REPO_PATH || '/workspace/projects';

const MAX_DURATION_MS = parseInt(process.env.REPO_INDEX_MAX_DURATION_MS || '300000', 10);
const MAX_SYMBOLS = parseInt(process.env.REPO_INDEX_MAX_SYMBOLS || '5000', 10);
const MAX_FILES = parseInt(process.env.REPO_INDEX_MAX_FILES || '2000', 10);
const MAX_EDGES = parseInt(process.env.REPO_INDEX_MAX_EDGES || '5000', 10);
const POLL_INTERVAL_SECS = parseInt(process.env.REPO_INDEX_POLL_INTERVAL_SECS || '30', 10);

// ─── Embeddings: character n-gram TF-IDF (no model required) ─────────────────

const NGRAM_DIM = 512;

function charNgrams(text, n = 3) {
  const t = text.toLowerCase().replace(/[^a-z0-9_]/g, ' ').trim();
  const grams = [];
  for (let i = 0; i <= t.length - n; i++) grams.push(t.slice(i, i + n));
  return grams;
}

function ngramVector(text) {
  const vec = new Float32Array(NGRAM_DIM);
  for (const g of charNgrams(text)) {
    let h = 0;
    for (let i = 0; i < g.length; i++) h = (Math.imul(31, h) + g.charCodeAt(i)) | 0;
    vec[Math.abs(h) % NGRAM_DIM] += 1;
  }
  const mag = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
  return Array.from(vec).map(v => v / mag);
}

function cosineSim(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return Math.max(0, dot);
}

// ─── API callbacks ────────────────────────────────────────────────────────────

function getApiBase() {
  if (!CALLBACK_BASE_RAW) return null;
  return CALLBACK_BASE_RAW.replace(/\/api\/sessions\/\d+\/status$/, '');
}

async function postSync(payload) {
  const base = getApiBase();
  if (!base) { console.warn('[repo-indexer] No callback URL — skipping sync'); return; }
  const url = `${base}/api/sessions/${SESSION_ID}/repo/sync`;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${AUTH_TOKEN}` },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) console.warn(`[repo-indexer] Sync ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`);
    else console.log(`[repo-indexer] Sync OK: status=${payload.status}`);
  } catch (err) {
    console.warn(`[repo-indexer] Sync error: ${err.message}`);
  }
}

async function pollForPendingJob() {
  const base = getApiBase();
  if (!base) return null;
  const url = `${base}/api/sessions/${SESSION_ID}/repo/jobs/pending`;
  try {
    const res = await fetch(url, {
      headers: { 'Authorization': `Bearer ${AUTH_TOKEN}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return null;
    return res.json().catch(() => null);
  } catch { return null; }
}

// ─── File content hash + mtime ────────────────────────────────────────────────

function fileContentHash(filePath) {
  try {
    const content = readFileSync(filePath);
    const stat = statSync(filePath);
    return { hash: createHash('sha1').update(content).digest('hex'), mtime: Math.floor(stat.mtimeMs), content };
  } catch {
    return { hash: '', mtime: 0, content: null };
  }
}

// ─── Incremental indexing ─────────────────────────────────────────────────────

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.py', '.go', '.rs', '.rb', '.java', '.c', '.cpp', '.cs', '.kt', '.swift']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '__pycache__', '.next', '.nuxt', 'target', 'vendor', '.venv', 'venv']);

function langFromExt(ext) {
  const m = {
    '.ts': 'ts', '.tsx': 'tsx', '.js': 'js', '.jsx': 'jsx', '.mjs': 'js', '.cjs': 'js',
    '.py': 'py', '.go': 'go', '.rs': 'rs', '.rb': 'rb', '.java': 'java',
    '.c': 'c', '.cpp': 'cpp', '.cs': 'cs', '.kt': 'kt', '.swift': 'swift',
  };
  return m[ext] || null;
}

function walkSourceFiles(dir, root, maxFiles) {
  const results = [];
  function walk(d) {
    if (results.length >= maxFiles) return;
    let entries;
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= maxFiles) break;
      if (e.name.startsWith('.') && e.name !== '.floatr') continue;
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) walk(join(d, e.name));
      } else if (e.isFile()) {
        const ext = extname(e.name);
        if (SOURCE_EXTS.has(ext)) {
          results.push({ absPath: join(d, e.name), relPath: relative(root, join(d, e.name)), lang: langFromExt(ext), ext });
        }
      }
    }
  }
  walk(dir);
  return results;
}

// ─── Import edge extraction ───────────────────────────────────────────────────

const IMPORT_PATTERNS = [
  { re: /^import\s+.*?from\s+['"]([^'"]+)['"]/gm, lang: ['ts', 'tsx', 'js', 'jsx'] },
  { re: /^(?:const|let|var)\s+.*?=\s*require\(['"]([^'"]+)['"]\)/gm, lang: ['ts', 'tsx', 'js', 'jsx'] },
  { re: /^export\s+.*?from\s+['"]([^'"]+)['"]/gm, lang: ['ts', 'tsx', 'js', 'jsx'] },
  { re: /^from\s+['"]([^'"]+)['"]\s+import/gm, lang: ['py'] },
  { re: /^import\s+['"]([^'"]+)['"]/gm, lang: ['py'] },
  { re: /^import\s+"([^"]+)"/gm, lang: ['go'] },
  { re: /^use\s+([\w:]+)/gm, lang: ['rs'] },
];

function extractEdges(code, fromRel, lang, root) {
  const edges = [];
  for (const { re, lang: langs } of IMPORT_PATTERNS) {
    if (langs && !langs.includes(lang)) continue;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(code)) !== null) {
      const imp = m[1];
      if (!imp || imp.startsWith('http') || !imp.startsWith('.')) continue;
      edges.push({ from: fromRel, to: imp, kind: 'import' });
    }
  }
  return edges;
}

// ─── Core indexing job ────────────────────────────────────────────────────────

const activeJobs = new Set();

async function runJob({ jobId, repoPath }) {
  if (activeJobs.has(jobId)) return;
  activeJobs.add(jobId);

  const startTime = Date.now();
  const elapsed = () => Date.now() - startTime;
  const timedOut = () => elapsed() > MAX_DURATION_MS;
  const tlog = msg => console.log(`[repo-indexer][job ${jobId}] ${msg}`);

  tlog(`Starting at ${repoPath}`);

  let db = null;
  let fp = null;
  let fingerprintHash = null;
  let fallbackMode = 'full';

  try {
    await postSync({ jobId, status: 'scanning', repoPath });

    // ── Phase: fingerprint ──────────────────────────────────────────────────
    await postSync({ jobId, status: 'fingerprinting', repoPath });
    fp = await runFingerprint(repoPath);
    fingerprintHash = fp.fingerprintHash;
    tlog(`Fingerprint: ${fp.primaryLangs.join(', ')} — ${fp.fileCount} files (hash: ${fingerprintHash?.slice(0, 8)})`);

    await postSync({ jobId, status: 'fingerprinting', repoPath, fingerprintHash, fingerprint: fp });

    if (timedOut()) { fallbackMode = 'fingerprint-only'; throw Object.assign(new Error('TIME_LIMIT'), { phase: 'fingerprint' }); }

    // ── Phase: open SQLite DB ───────────────────────────────────────────────
    db = await openDb();
    const prevHash = db ? getMeta(db, 'fingerprintHash') : null;
    const hashUnchanged = prevHash && prevHash === fingerprintHash;
    if (hashUnchanged) tlog('Hash unchanged — incremental update only');

    // ── Phase: indexing_graph ───────────────────────────────────────────────
    await postSync({ jobId, status: 'indexing_graph', repoPath });

    const sourceFiles = walkSourceFiles(repoPath, repoPath, MAX_FILES);
    tlog(`Found ${sourceFiles.length} source files`);

    let symbolCount = 0;
    const allEdges = [];

    for (const { absPath, relPath, lang } of sourceFiles) {
      if (timedOut()) { fallbackMode = 'graph-lite'; break; }

      const { hash, mtime, content: contentBuf } = fileContentHash(absPath);
      if (!contentBuf) continue;
      const code = contentBuf.toString('utf8');

      // Upsert file record
      const fileRow = db ? upsertFile(db, {
        path: relPath, lang, size_bytes: contentBuf.length,
        content_hash: hash, mtime,
        centrality: 0, dep_in: 0, dep_out: 0,
      }) : null;

      // Extract symbols (tree-sitter or regex)
      const syms = await extractSymbols(code, lang);
      if (db && fileRow) {
        deleteSymbolsForFile(db, fileRow.id);
        if (syms.length > 0) {
          insertSymbols(db, syms.map(s => ({
            file_id: fileRow.id,
            name: s.name, kind: s.kind, path: relPath,
            line: s.line || null, lang: s.lang || lang,
            signature: s.signature || null, docstring: s.docstring || null,
          })));
          symbolCount += syms.length;
        }
      } else {
        symbolCount += syms.length;
      }

      // Extract import edges
      const edges = extractEdges(code, relPath, lang, repoPath);
      for (const e of edges) {
        allEdges.push(e);
        if (db) insertEdge(db, e.from, e.to, e.kind);
      }
    }

    tlog(`Graph: ${symbolCount} symbols, ${allEdges.length} edges`);

    // ── Phase: indexing_fts ─────────────────────────────────────────────────
    await postSync({ jobId, status: 'indexing_fts', repoPath });
    if (db) {
      rebuildFts(db);
      tlog('FTS5 index rebuilt');
    } else {
      tlog('FTS5 skipped (better-sqlite3 unavailable)');
    }
    if (timedOut()) { fallbackMode = 'lexical-only'; throw Object.assign(new Error('TIME_LIMIT'), { phase: 'fts' }); }

    // ── Phase: indexing_vectors ─────────────────────────────────────────────
    await postSync({ jobId, status: 'indexing_vectors', repoPath });
    if (db) {
      tlog('Computing character n-gram embeddings...');
      const embBatch = db ? getAllSymbols(db, 1000) : [];
      let embCount = 0;
      for (const sym of embBatch) {
        if (timedOut()) break;
        const text = [sym.name, sym.kind, sym.path, sym.signature].filter(Boolean).join(' ');
        const vec = ngramVector(text);
        storeEmbedding(db, `sym:${sym.name}:${sym.path}`, 'symbol', vec);
        embCount++;
      }
      tlog(`Embeddings: ${embCount} n-gram vectors stored`);
    } else {
      tlog('Vector indexing skipped (no SQLite)');
    }

    // ── Phase: summarizing ──────────────────────────────────────────────────
    await postSync({ jobId, status: 'summarizing', repoPath });

    const graphResult = await buildGraph(repoPath).catch(() => ({ fileNodes: sourceFiles.map(f => ({ path: f.relPath, lang: f.lang, sizeBytes: 0 })), edges: allEdges, symbolNodes: [], indexedSymbols: symbolCount, edgeCount: allEdges.length }));
    const filesWithCentrality = computeFileCentrality(graphResult.fileNodes || [], graphResult.edges || []);
    const summary = buildSummary({ fileNodes: filesWithCentrality, edges: graphResult.edges || [], fingerprint: fp });
    tlog(`Summary: complexity=${summary.complexityClass}`);

    // Update centrality in DB
    if (db) {
      const updateCentrality = db.prepare('UPDATE files SET centrality = ?, dep_in = ? WHERE path = ?');
      const txn = db.transaction((files) => {
        for (const f of files) updateCentrality.run(f.centralityScore || 0, f.dependencyDegree || 0, f.path);
      });
      txn(filesWithCentrality.slice(0, 500));
      if (fingerprintHash) setMeta(db, 'fingerprintHash', fingerprintHash);
    }

    // ── Build sync payload ──────────────────────────────────────────────────
    const dbStats = db ? getStats(db) : null;
    const finalSymbols = (db ? getAllSymbols(db, MAX_SYMBOLS) : graphResult.symbolNodes || []).slice(0, MAX_SYMBOLS).map(s => ({
      name: s.name, kind: s.kind, path: s.path, line: s.line || null,
      lang: s.lang || null, signature: s.signature || null, docstring: s.docstring || null,
      callers: [], callees: [],
    }));
    const finalFiles = filesWithCentrality.slice(0, MAX_FILES).map(f => ({
      path: f.path, lang: f.lang || null, sizeBytes: f.sizeBytes || 0,
      centralityScore: f.centralityScore || 0, dependencyDegree: f.dependencyDegree || 0,
    }));
    const finalEdges = (db ? getAllEdges(db, MAX_EDGES) : allEdges).slice(0, MAX_EDGES).map(e => ({
      from: e.from_path || e.from,
      to: e.to_path || e.to,
      kind: e.kind || 'import',
    }));

    await postSync({
      jobId, status: 'ready', repoPath,
      fingerprintHash, fingerprint: fp, summary,
      symbols: finalSymbols, files: finalFiles, edges: finalEdges,
      indexedSymbols: dbStats?.symbols ?? symbolCount,
      edgeCount: dbStats?.edges ?? allEdges.length,
      durationMs: elapsed(),
    });

    tlog(`Done in ${elapsed()}ms (mode: ${fallbackMode})`);

  } catch (err) {
    if (err.message === 'TIME_LIMIT') {
      tlog(`Time limit reached in phase ${err.phase} — reporting partial sync (mode: ${fallbackMode})`);
      const partialStatus = fallbackMode === 'fingerprint-only' ? 'ready' : 'ready';
      const dbStats = db ? getStats(db) : null;
      await postSync({
        jobId, status: partialStatus, repoPath,
        fingerprintHash, fingerprint: fp,
        durationMs: elapsed(),
        indexedSymbols: dbStats?.symbols ?? 0,
        edgeCount: dbStats?.edges ?? 0,
      });
    } else {
      tlog(`Failed: ${err.stack || err.message}`);
      await postSync({ jobId, status: 'error', repoPath, errorDetails: err.message, durationMs: elapsed(), fingerprintHash, fingerprint: fp });
    }
  } finally {
    if (db) closeDb();
    activeJobs.delete(jobId);
  }
}

// ─── Daemon + main ────────────────────────────────────────────────────────────

async function runDaemon() {
  console.log(`[repo-indexer] Daemon started (session=${SESSION_ID}, poll=${POLL_INTERVAL_SECS}s)`);
  while (true) {
    try {
      const pending = await pollForPendingJob();
      if (pending?.jobId && !activeJobs.has(pending.jobId)) {
        const repoPath = pending.repoPath || DEFAULT_REPO_PATH;
        runJob({ jobId: pending.jobId, repoPath }).catch(err => {
          console.error(`[repo-indexer] Unhandled job error: ${err.message}`);
        });
      }
    } catch (err) {
      console.warn(`[repo-indexer] Poll error: ${err.message}`);
    }
    await new Promise(r => setTimeout(r, POLL_INTERVAL_SECS * 1000));
  }
}

async function main() {
  if (!SESSION_ID) { console.error('[repo-indexer] OMNIQL_SESSION_ID required'); process.exit(1); }
  if (SPECIFIC_JOB_ID) await runJob({ jobId: SPECIFIC_JOB_ID, repoPath: DEFAULT_REPO_PATH });
  else await runDaemon();
}

main().catch(err => { console.error(`[repo-indexer] Fatal: ${err.stack}`); process.exit(1); });
