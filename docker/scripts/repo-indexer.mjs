#!/usr/bin/env node
/**
 * repo-indexer.mjs — Repo Intelligence: Main orchestrator
 *
 * Supports two modes:
 * 1. Single-job mode (FLOATR_REPO_JOB_ID set): index one specific job and exit
 * 2. Daemon mode (FLOATR_REPO_JOB_ID not set): poll for queued jobs every N seconds
 *
 * Flow for each job:
 * 1. POST sync: status=scanning
 * 2. Fingerprint the repo → POST partial sync
 * 3. Build import graph
 * 4. Build summary
 * 5. POST full sync: status=ready (or error)
 *
 * Hard limits (env-configurable):
 * - REPO_INDEX_MAX_DURATION_MS (default 300000 = 5 min)
 * - REPO_INDEX_MAX_SYMBOLS (default 5000)
 * - REPO_INDEX_POLL_INTERVAL_SECS (default 30)
 *
 * Env vars:
 * - OMNIQL_CALLBACK_URL: instance callback URL (used to derive base API URL)
 * - OMNIQL_MEM_AUTH_TOKEN: bearer token for API auth
 * - OMNIQL_SESSION_ID: session ID
 * - FLOATR_REPO_JOB_ID: (optional) specific job to run
 * - FLOATR_REPO_PATH: (optional) override repo path
 */

import { fingerprint } from './repo-fingerprint.mjs';
import { buildGraph, computeFileCentrality } from './repo-graph.mjs';
import { buildSummary } from './repo-summary.mjs';

const CALLBACK_BASE_RAW = process.env.OMNIQL_CALLBACK_URL || '';
const AUTH_TOKEN = process.env.OMNIQL_MEM_AUTH_TOKEN || '';
const SESSION_ID = process.env.OMNIQL_SESSION_ID || '';
const SPECIFIC_JOB_ID = parseInt(process.env.FLOATR_REPO_JOB_ID || '0', 10);
const DEFAULT_REPO_PATH = process.env.FLOATR_REPO_PATH || '/workspace/projects';

const MAX_DURATION_MS = parseInt(process.env.REPO_INDEX_MAX_DURATION_MS || '300000', 10);
const MAX_SYMBOLS = parseInt(process.env.REPO_INDEX_MAX_SYMBOLS || '5000', 10);
const POLL_INTERVAL_SECS = parseInt(process.env.REPO_INDEX_POLL_INTERVAL_SECS || '30', 10);

const activeJobs = new Set();

function getApiBase() {
  if (!CALLBACK_BASE_RAW) return null;
  return CALLBACK_BASE_RAW.replace(/\/api\/sessions\/\d+\/status$/, '');
}

async function apiCall(method, path, body) {
  const base = getApiBase();
  if (!base) return null;
  const url = `${base}/api/sessions/${SESSION_ID}${path}`;
  try {
    const res = await fetch(url, {
      method,
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AUTH_TOKEN}`,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(30000),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.warn(`[repo-indexer] API ${method} ${path} failed: ${res.status} ${text.slice(0, 200)}`);
      return null;
    }
    return res.json().catch(() => null);
  } catch (err) {
    console.warn(`[repo-indexer] API call error ${path}: ${err.message}`);
    return null;
  }
}

async function postSync(payload) {
  const result = await apiCall('POST', '/repo/sync', payload);
  if (result) {
    console.log(`[repo-indexer] Sync OK: status=${payload.status}`);
  }
  return result;
}

async function pollForPendingJob() {
  const result = await apiCall('GET', '/repo/jobs/pending', null);
  return result || null;
}

async function runJob({ jobId, repoPath }) {
  if (activeJobs.has(jobId)) {
    console.log(`[repo-indexer] Job ${jobId} already in progress — skipping`);
    return;
  }
  activeJobs.add(jobId);

  const startTime = Date.now();
  const elapsed = () => Date.now() - startTime;
  const timedOut = () => elapsed() > MAX_DURATION_MS;

  console.log(`[repo-indexer] Starting job ${jobId} at ${repoPath}`);

  let fp = null;
  let fingerprintHash = null;
  let graph = null;
  let filesWithCentrality = null;
  let summary = null;

  try {
    await postSync({ jobId, status: 'scanning', repoPath });

    console.log('[repo-indexer] Running fingerprint...');
    await postSync({ jobId, status: 'fingerprinting', repoPath });
    fp = await fingerprint(repoPath);
    fingerprintHash = fp.fingerprintHash;
    console.log(`[repo-indexer] Fingerprint: ${fp.primaryLangs.join(', ')} (${fp.fileCount} files)`);

    await postSync({
      jobId, status: 'fingerprinting', repoPath,
      fingerprintHash, fingerprint: fp,
    });

    if (timedOut()) {
      console.warn('[repo-indexer] Time limit reached after fingerprint — reporting ready with fingerprint-only');
      await postSync({
        jobId, status: 'ready', repoPath,
        fingerprintHash, fingerprint: fp,
        durationMs: elapsed(),
      });
      return;
    }

    console.log('[repo-indexer] Building import graph...');
    await postSync({ jobId, status: 'indexing_graph', repoPath });
    graph = await buildGraph(repoPath);
    console.log(`[repo-indexer] Graph: ${graph.indexedSymbols} symbols, ${graph.edgeCount} edges`);

    // indexing_fts: lexical index pass-through (structural graph is our FTS proxy)
    await postSync({ jobId, status: 'indexing_fts', repoPath });
    console.log('[repo-indexer] FTS indexing (structural graph used as lexical proxy — no FTS5 available in pure Node.js mode)');

    // indexing_vectors: embedding pass-through (requires ONNX/model — skipped)
    await postSync({ jobId, status: 'indexing_vectors', repoPath });
    console.log('[repo-indexer] Vector indexing skipped (no local embedding model available — hybrid search uses lexical+graph scores)');

    await postSync({ jobId, status: 'summarizing', repoPath });
    filesWithCentrality = computeFileCentrality(graph.fileNodes, graph.edges);
    summary = buildSummary({
      fileNodes: filesWithCentrality,
      edges: graph.edges,
      fingerprint: fp,
    });
    console.log(`[repo-indexer] Summary: complexity=${summary.complexityClass}`);

    const symbols = graph.symbolNodes.slice(0, MAX_SYMBOLS).map(s => ({
      name: s.name,
      kind: s.kind,
      path: s.path,
      line: s.line || null,
      lang: s.lang || null,
      signature: null,
      docstring: null,
      callers: [],
      callees: [],
    }));

    const files = (timedOut() ? filesWithCentrality.slice(0, 100) : filesWithCentrality.slice(0, 500)).map(f => ({
      path: f.path,
      lang: f.lang || null,
      sizeBytes: f.sizeBytes,
      centralityScore: f.centralityScore,
      dependencyDegree: f.dependencyDegree,
    }));

    const edges = graph.edges.slice(0, 2000).map(e => ({
      from: e.from,
      to: e.to,
      kind: e.kind,
    }));

    await postSync({
      jobId, status: 'ready', repoPath,
      fingerprintHash, fingerprint: fp, summary,
      symbols, files, edges,
      indexedSymbols: graph.indexedSymbols,
      edgeCount: graph.edgeCount,
      durationMs: elapsed(),
    });

    console.log(`[repo-indexer] Job ${jobId} done in ${elapsed()}ms`);

  } catch (err) {
    console.error(`[repo-indexer] Job ${jobId} failed: ${err.stack || err.message}`);
    await postSync({
      jobId, status: 'error', repoPath,
      errorDetails: err.message,
      durationMs: elapsed(),
      fingerprintHash: fingerprintHash || null,
      fingerprint: fp || null,
    });
  } finally {
    activeJobs.delete(jobId);
  }
}

async function runDaemon() {
  console.log(`[repo-indexer] Starting daemon (session=${SESSION_ID}, poll=${POLL_INTERVAL_SECS}s)`);

  while (true) {
    try {
      const pending = await pollForPendingJob();
      if (pending && pending.jobId && !activeJobs.has(pending.jobId)) {
        const repoPath = pending.repoPath || DEFAULT_REPO_PATH;
        runJob({ jobId: pending.jobId, repoPath }).catch(err => {
          console.error(`[repo-indexer] Unhandled job error: ${err.message}`);
        });
      }
    } catch (err) {
      console.warn(`[repo-indexer] Poll error: ${err.message}`);
    }

    await new Promise(resolve => setTimeout(resolve, POLL_INTERVAL_SECS * 1000));
  }
}

async function main() {
  if (!SESSION_ID) {
    console.error('[repo-indexer] OMNIQL_SESSION_ID is required');
    process.exit(1);
  }

  if (SPECIFIC_JOB_ID) {
    const repoPath = DEFAULT_REPO_PATH;
    await runJob({ jobId: SPECIFIC_JOB_ID, repoPath });
  } else {
    await runDaemon();
  }
}

main().catch(err => {
  console.error(`[repo-indexer] Fatal: ${err.stack || err.message}`);
  process.exit(1);
});
