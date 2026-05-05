#!/usr/bin/env node
/**
 * context-shield.mjs — Bounded-output subprocess execution (Context Shield)
 *
 * Prevents raw high-volume tool output from entering the model context.
 * Only compact summaries with artifact references reach the model.
 *
 * Threshold constants are defined HERE and ONLY here.
 * Callers do not define or scatter their own limits.
 *
 * Token-mode multipliers:
 *   ultra  → tightest  (0.25×)
 *   lean   → tight     (0.5×)
 *   core   → default   (1.0×)
 *   full   → permissive (3.0×)
 */

import { spawnSync }                                            from 'child_process';
import { writeFileSync, readFileSync, readdirSync, statSync,
         existsSync, mkdirSync, unlinkSync }                   from 'fs';
import { join, dirname }                                       from 'path';
import { createHash }                                          from 'crypto';
import { fileURLToPath }                                       from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Central threshold constants ───────────────────────────────────────────────
// All sizes in bytes. All durations in milliseconds.
// Override via environment variable; token-mode multiplier applied on top.

const TOKEN_MODE_MULTIPLIERS   = { ultra: 0.25, lean: 0.5, core: 1.0, full: 3.0 };
const BASE_INLINE_BYTES        = parseInt(process.env.MIZI_SHIELD_INLINE_BYTES    || '8000',          10);
const MAX_ARTIFACT_BYTES       = parseInt(process.env.MIZI_SHIELD_ARTIFACT_BYTES  || String(10 * 1024 * 1024),  10);
const MAX_SESSION_BYTES        = parseInt(process.env.MIZI_SHIELD_SESSION_BYTES   || String(200 * 1024 * 1024), 10);
const ARTIFACT_RETENTION_MS    = parseInt(process.env.MIZI_SHIELD_RETENTION_HOURS || '24',            10) * 3_600_000;
const EXEC_TIMEOUT_MS          = parseInt(process.env.MIZI_SHIELD_TIMEOUT_MS      || '30000',         10);
const MAX_BATCH_COMMANDS       = parseInt(process.env.MIZI_SHIELD_BATCH_MAX       || '10',            10);

const ARTIFACTS_DIR  = process.env.MIZI_ARTIFACTS_DIR || '/workspace/.mizi/artifacts';
const STATE_SCRIPT   = join(__dirname, 'session-state.mjs');

// ── Dangerous command patterns ────────────────────────────────────────────────
// Blocked regardless of token mode or inline limit.
const DANGEROUS_PATTERNS = [
  /\brm\s+-[a-z]*r[a-z]*f\s+\/(?!\w)/i,        // rm -rf /
  /\bmkfs\b/i,                                   // format filesystem
  /\bdd\s+if=\/dev\/zero\s+of=\/dev\//i,         // zero a block device
  /:\s*\(\s*\)\s*\{.*:.*\|.*&.*\}/,             // fork bomb pattern
  /\bchmod\s+-R\s+777\s+\//i,                    // world-writable root
  /\biptables\s+.*-F\b/i,                        // flush all firewall rules
  /\bkillall\s+-9\s+-r\s+\./i,                   // kill all processes
  /\bshred\s+.*\/dev\/sd/i,                      // shred block device
];

// ── Token mode ────────────────────────────────────────────────────────────────

export function getTokenMode() {
  try {
    const modeFile = '/workspace/.mizi/token-mode.json';
    if (existsSync(modeFile)) {
      const data = JSON.parse(readFileSync(modeFile, 'utf8'));
      return (data.tokenMode || 'core').toLowerCase();
    }
  } catch {}
  return (process.env.MIZI_TOKEN_MODE || 'core').toLowerCase();
}

export function getInlineLimit() {
  const mode       = getTokenMode();
  const multiplier = TOKEN_MODE_MULTIPLIERS[mode] ?? 1.0;
  return Math.floor(BASE_INLINE_BYTES * multiplier);
}

// ── Dangerous command check ───────────────────────────────────────────────────

export function checkDangerous(cmd) {
  for (const pattern of DANGEROUS_PATTERNS) {
    if (pattern.test(cmd)) {
      return { dangerous: true, pattern: pattern.source };
    }
  }
  return { dangerous: false };
}

// ── Pre-routing classification ────────────────────────────────────────────────
// Stage 1 routing: classify command class and determine if shielding is advised
// before execution. Shielding = bounded output + artifact persistence.

export function preRoute(cmd, opts = {}) {
  if (!cmd || typeof cmd !== 'string') return { class: 'unknown', shield: false };
  const lower = cmd.trim().toLowerCase();

  if (/^\s*(grep|rg|find|ls\s+-la|ls\s+-al|du\s+|df\s+|cat\s+.*\.log|tail\s+-f|journalctl|dmesg|strace|ltrace)/.test(lower))
    return { class: 'search_or_list', shield: true };

  if (/^\s*(npm\s+(test|run\s+test|run\s+build)|pytest|jest|cargo\s+test|go\s+test|make\s+(test|check)|mocha)/.test(lower))
    return { class: 'test_run', shield: true };

  if (/^\s*(git\s+(log|diff|show|blame|reflog)|svn\s+log)/.test(lower))
    return { class: 'git_history', shield: true };

  if (/^\s*(tsc\s+|webpack|esbuild|cargo\s+build|go\s+build|mvn\s+|gradle\s+|bazel\s+)/.test(lower))
    return { class: 'build', shield: true };

  if (/\|\s*(head|tail|wc\s+-[lc]|sort|uniq)/.test(lower))
    return { class: 'piped', shield: true };

  if (opts.forceShield) return { class: 'forced', shield: true };

  return { class: 'general', shield: false };
}

// ── Artifact storage ──────────────────────────────────────────────────────────

function ensureArtifactsDir() {
  if (!existsSync(ARTIFACTS_DIR)) mkdirSync(ARTIFACTS_DIR, { recursive: true });
}

function sessionArtifactBytes() {
  if (!existsSync(ARTIFACTS_DIR)) return 0;
  let total = 0;
  for (const f of readdirSync(ARTIFACTS_DIR)) {
    try { total += statSync(join(ARTIFACTS_DIR, f)).size; } catch {}
  }
  return total;
}

function evictArtifactsLRU(targetBytes = MAX_SESSION_BYTES * 0.8) {
  if (!existsSync(ARTIFACTS_DIR)) return;
  const files = readdirSync(ARTIFACTS_DIR)
    .map(f => {
      try {
        const s = statSync(join(ARTIFACTS_DIR, f));
        return { path: join(ARTIFACTS_DIR, f), size: s.size, mtimeMs: s.mtimeMs };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => a.mtimeMs - b.mtimeMs);   // oldest first

  let total = files.reduce((s, f) => s + f.size, 0);
  for (const file of files) {
    if (total <= targetBytes) break;
    try { unlinkSync(file.path); total -= file.size; } catch {}
  }
}

export function cleanupStaleArtifacts() {
  if (!existsSync(ARTIFACTS_DIR)) return 0;
  const cutoff = Date.now() - ARTIFACT_RETENTION_MS;
  let removed = 0;
  for (const f of readdirSync(ARTIFACTS_DIR)) {
    const p = join(ARTIFACTS_DIR, f);
    try {
      if (statSync(p).mtimeMs < cutoff) { unlinkSync(p); removed++; }
    } catch {}
  }
  return removed;
}

function persistArtifact(id, content) {
  ensureArtifactsDir();
  let bytes = Buffer.byteLength(content, 'utf8');

  if (bytes > MAX_ARTIFACT_BYTES) {
    content = content.slice(0, MAX_ARTIFACT_BYTES) +
      `\n[ARTIFACT TRUNCATED at ${MAX_ARTIFACT_BYTES.toLocaleString()} bytes]`;
    bytes = MAX_ARTIFACT_BYTES;
  }

  if (sessionArtifactBytes() + bytes > MAX_SESSION_BYTES) {
    evictArtifactsLRU();
  }

  const filePath = join(ARTIFACTS_DIR, `${id}.txt`);
  writeFileSync(filePath, content, 'utf8');
  return filePath;
}

// ── Compact summary builder ───────────────────────────────────────────────────

function buildSummary({ cmd, exitCode, timedOut, outputBytes, lines, artifactFile, previewLines = 8 }) {
  const head   = lines.slice(0, previewLines).join('\n');
  const tail   = lines.length > previewLines + 4 ? lines.slice(-3).join('\n') : '';
  const status = exitCode === 0 ? 'OK' : `EXIT ${exitCode}${timedOut ? ' (timed out)' : ''}`;

  return [
    `[SHIELDED] ${status} | ${outputBytes.toLocaleString()} bytes, ${lines.length} lines`,
    `Command : ${(cmd || '').slice(0, 120)}`,
    `Artifact: ${artifactFile}`,
    `--- First ${previewLines} lines ---`,
    head,
    tail ? `--- Last 3 lines ---\n${tail}` : '',
    `--- Full output at: ${artifactFile} ---`,
  ].filter(Boolean).join('\n');
}

// ── Core shielded execution ───────────────────────────────────────────────────

export function shieldedExec(cmd, opts = {}) {
  // Safety gate
  const safetyCheck = checkDangerous(cmd);
  if (safetyCheck.dangerous) {
    _dbIncrement({ blocked: 1 });
    _dbRoutingDecision({ class: 'dangerous', shielded: 0, blocked: 1 });
    _dbAppendEvent({
      actor_type: 'context-shield',
      event_type: 'exec_blocked',
      payload:    { cmd: String(cmd).slice(0, 300), pattern: safetyCheck.pattern },
    });
    return {
      ok: false,
      blocked: true,
      reason:  `Command blocked by context shield (pattern: ${safetyCheck.pattern})`,
      summary: `[BLOCKED] This command was blocked because it matches a dangerous operation pattern.\nCommand: ${cmd}`,
      bytesAvoided: 0,
    };
  }

  const inlineLimit = opts.inlineLimit ?? getInlineLimit();
  const timeout     = opts.timeout     ?? EXEC_TIMEOUT_MS;
  const routing     = preRoute(cmd, opts);
  const id          = `exec-${Date.now()}-${createHash('sha1').update(cmd).digest('hex').slice(0, 8)}`;

  const result = spawnSync('bash', ['-c', cmd], {
    encoding:  'utf8',
    timeout,
    maxBuffer: MAX_ARTIFACT_BYTES,
    env:       { ...process.env },
  });

  const stdout   = result.stdout || '';
  const stderr   = result.stderr || '';
  const combined = stdout + (stderr ? `\n[stderr]\n${stderr}` : '');
  const exitCode = result.status ?? 1;
  const timedOut = result.error?.code === 'ETIMEDOUT';
  const outputBytes = Buffer.byteLength(combined, 'utf8');
  const lines       = combined.split('\n');

  // Stage 2: post-execution — shield if output exceeds inline limit or pre-routed
  if (outputBytes > inlineLimit || routing.shield) {
    const artifactFile  = persistArtifact(id, combined);
    const bytesAvoided  = Math.max(0, outputBytes - inlineLimit);
    const previewLines  = Math.min(10, Math.max(4, Math.floor(inlineLimit / 80)));
    const summary       = buildSummary({ cmd, exitCode, timedOut, outputBytes, lines, artifactFile, previewLines });

    _dbIncrement({ shielded: 1, bytesAvoided, artifacts: 1 });
    _dbRoutingDecision({ class: routing.class, shielded: 1, blocked: 0, bytesAvoided });

    if (exitCode !== 0) {
      _dbAppendEvent({
        actor_type: 'context-shield',
        event_type: 'exec_error',
        payload:    { cmd: String(cmd).slice(0, 300), exitCode, timedOut, class: routing.class },
      });
      _dbIncrement({ routingFailures: 1 });
    }

    return {
      ok:         exitCode === 0,
      exitCode,
      timedOut,
      shielded:   true,
      artifactFile,
      outputBytes,
      bytesAvoided,
      summary,
      class:      routing.class,
    };
  }

  // Output fits inline — return directly (no artifact)
  _dbRoutingDecision({ class: routing.class, shielded: 0, blocked: 0, bytesAvoided: 0 });

  if (exitCode !== 0) {
    _dbAppendEvent({
      actor_type: 'context-shield',
      event_type: 'exec_error',
      payload:    { cmd: String(cmd).slice(0, 300), exitCode, timedOut, class: routing.class },
    });
    _dbIncrement({ routingFailures: 1 });
  }

  return {
    ok:          exitCode === 0,
    exitCode,
    timedOut,
    shielded:    false,
    output:      combined,
    outputBytes,
    bytesAvoided: 0,
    class:       routing.class,
  };
}

export function shieldedExecFile(filePath, opts = {}) {
  if (!existsSync(filePath)) {
    return { ok: false, error: `File not found: ${filePath}` };
  }

  const inlineLimit = opts.inlineLimit ?? getInlineLimit();

  let stat;
  try { stat = statSync(filePath); } catch (e) {
    return { ok: false, error: `Cannot stat file: ${e.message}` };
  }

  if (stat.size > inlineLimit) {
    const id       = `file-${Date.now()}-${createHash('sha1').update(filePath).digest('hex').slice(0, 8)}`;
    let content;
    try { content = readFileSync(filePath, 'utf8'); } catch (e) {
      return { ok: false, error: `Cannot read file: ${e.message}` };
    }
    const artifactFile  = persistArtifact(id, content);
    const lines         = content.split('\n');
    const previewLines  = Math.min(10, Math.max(4, Math.floor(inlineLimit / 80)));
    const bytesAvoided  = Math.max(0, stat.size - inlineLimit);

    _dbIncrement({ shielded: 1, bytesAvoided, artifacts: 1 });

    return {
      ok:         true,
      shielded:   true,
      artifactFile,
      outputBytes: stat.size,
      bytesAvoided,
      summary: [
        `[SHIELDED FILE] ${filePath}`,
        `Size: ${stat.size.toLocaleString()} bytes, ${lines.length} lines → ${artifactFile}`,
        `--- First ${previewLines} lines ---`,
        lines.slice(0, previewLines).join('\n'),
        `--- Full content at: ${artifactFile} ---`,
      ].join('\n'),
    };
  }

  let content;
  try { content = readFileSync(filePath, 'utf8'); } catch (e) {
    return { ok: false, error: `Cannot read file: ${e.message}` };
  }
  return { ok: true, shielded: false, output: content, outputBytes: stat.size, bytesAvoided: 0 };
}

export function batchExec(commands, opts = {}) {
  if (!Array.isArray(commands)) return { ok: false, error: 'commands must be an array' };

  const capped  = commands.slice(0, MAX_BATCH_COMMANDS);
  const results = capped.map((entry, i) => {
    const cmd    = typeof entry === 'string' ? entry : entry.cmd;
    const cmdOpts = typeof entry === 'object' ? (entry.opts || {}) : {};
    return { index: i, command: cmd, ...shieldedExec(cmd, { ...cmdOpts, ...opts }) };
  });

  return {
    ok:               results.every(r => r.ok),
    results,
    totalBytesAvoided: results.reduce((s, r) => s + (r.bytesAvoided || 0), 0),
    skipped:          commands.length - capped.length,
  };
}

// ── Observability ─────────────────────────────────────────────────────────────

export function mizi_stats() {
  let dbStats = {};
  let routingBreakdown = [];

  // Aggregate DB stats
  try {
    const r = spawnSync('node', [STATE_SCRIPT, 'stats'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) dbStats = JSON.parse(r.stdout || '{}');
  } catch {}

  // Routing decision breakdown by class
  try {
    const r = spawnSync('node', [STATE_SCRIPT, 'routing-breakdown'], { encoding: 'utf8', timeout: 5000 });
    if (r.status === 0) {
      const parsed = JSON.parse(r.stdout || '{}');
      routingBreakdown = parsed.breakdown || [];
    }
  } catch {}

  // Artifact directory stats
  let artifactCount = 0, artifactBytes = 0;
  if (existsSync(ARTIFACTS_DIR)) {
    for (const f of readdirSync(ARTIFACTS_DIR)) {
      try { const s = statSync(join(ARTIFACTS_DIR, f)); artifactCount++; artifactBytes += s.size; } catch {}
    }
  }

  const tokenMode     = getTokenMode();
  const inlineLimit   = getInlineLimit();

  return {
    db: {
      totals:            dbStats,
      routingBreakdown,
      contextBytesAvoided: dbStats.total_bytes_avoided || 0,
      shieldedCalls:     dbStats.total_shielded        || 0,
      blockedCalls:      dbStats.total_blocked         || 0,
      routingFailures:   dbStats.routing_failures      || 0,
      restoreSuccesses:  dbStats.restore_success       || 0,
      restoreFailures:   dbStats.restore_failure       || 0,
    },
    artifacts: {
      count:      artifactCount,
      totalBytes: artifactBytes,
      capBytes:   MAX_SESSION_BYTES,
      capPct:     Math.round((artifactBytes / MAX_SESSION_BYTES) * 100),
    },
    thresholds: {
      tokenMode,
      inlineLimitBytes:  inlineLimit,
      maxArtifactBytes:  MAX_ARTIFACT_BYTES,
      execTimeoutMs:     EXEC_TIMEOUT_MS,
      retentionHours:    ARTIFACT_RETENTION_MS / 3_600_000,
    },
  };
}

const SNAPSHOT_STALE_HOURS = 2;

export function mizi_doctor() {
  const issues = [];
  const checks = {};

  // Journal DB check
  const dbPath = process.env.MIZI_STATE_DB || '/workspace/.mizi/session-state.db';
  checks.journalExists = existsSync(dbPath);
  if (!checks.journalExists) issues.push('WARN: Session journal DB not found — event capture unavailable');

  // Stale snapshot check
  if (checks.journalExists) {
    try {
      const r = spawnSync('node', [STATE_SCRIPT, 'restore'], { encoding: 'utf8', timeout: 5000 });
      if (r.status === 0) {
        const data = JSON.parse(r.stdout || '{}');
        if (data.snapshot?._created_at) {
          const ageMsSnapshot = Date.now() - new Date(data.snapshot._created_at).getTime();
          const ageHours = ageMsSnapshot / 3_600_000;
          checks.latestSnapshotAgeHours = Math.round(ageHours * 10) / 10;
          if (ageHours > SNAPSHOT_STALE_HOURS) {
            issues.push(`WARN: Latest snapshot is ${checks.latestSnapshotAgeHours}h old — may not reflect current working state`);
          }
        } else {
          checks.latestSnapshotAgeHours = null;
          issues.push('INFO: No snapshots found — working state will not survive context compaction');
        }

        // Routing failures check
        const failures = data.stats?.routing_failures || 0;
        checks.routingFailures = failures;
        if (failures > 0) {
          issues.push(`WARN: ${failures} routing failure(s) recorded — check exec_error events in journal`);
        }
      }
    } catch {}
  }

  // Artifacts directory
  checks.artifactsDirExists = existsSync(ARTIFACTS_DIR);
  if (!checks.artifactsDirExists) issues.push(`INFO: Artifacts directory not yet created at ${ARTIFACTS_DIR}`);

  // Artifact cap
  const sessionBytes = sessionArtifactBytes();
  checks.artifactCapPct = Math.round((sessionBytes / MAX_SESSION_BYTES) * 100);
  if (checks.artifactCapPct > 80)
    issues.push(`WARN: Artifact storage at ${checks.artifactCapPct}% capacity (${sessionBytes.toLocaleString()}/${MAX_SESSION_BYTES.toLocaleString()} bytes)`);

  // Stale artifacts
  if (existsSync(ARTIFACTS_DIR)) {
    const cutoff     = Date.now() - ARTIFACT_RETENTION_MS;
    const staleCount = readdirSync(ARTIFACTS_DIR).filter(f => {
      try { return statSync(join(ARTIFACTS_DIR, f)).mtimeMs < cutoff; } catch { return false; }
    }).length;
    checks.staleArtifacts = staleCount;
    if (staleCount > 0) issues.push(`INFO: ${staleCount} stale artifact(s) eligible for cleanup`);
  }

  // Token mode and state script
  checks.tokenModeFile     = existsSync('/workspace/.mizi/token-mode.json');
  checks.tokenMode         = getTokenMode();
  checks.stateScriptExists = existsSync(STATE_SCRIPT);
  if (!checks.stateScriptExists) issues.push('WARN: session-state.mjs not found — routing stats and snapshots unavailable');

  return {
    healthy: !issues.some(i => i.startsWith('WARN') || i.startsWith('ERROR')),
    issues,
    checks,
  };
}

// ── Internal DB helpers (fire-and-forget) ─────────────────────────────────────

function _dbIncrement(delta) {
  try {
    spawnSync('node', [STATE_SCRIPT, 'increment-stats', JSON.stringify(delta)], {
      timeout: 3000, stdio: 'ignore',
    });
  } catch {}
}

function _dbRoutingDecision({ class: cls, shielded, blocked, bytesAvoided = 0 }) {
  try {
    const decision = JSON.stringify({ class: cls, shielded: shielded ? 1 : 0, blocked: blocked ? 1 : 0, bytesAvoided });
    spawnSync('node', [STATE_SCRIPT, 'routing-decision', decision], {
      timeout: 3000, stdio: 'ignore',
    });
  } catch {}
}

function _dbAppendEvent(event) {
  try {
    spawnSync('node', [STATE_SCRIPT, 'append-event', JSON.stringify(event)], {
      timeout: 3000, stdio: 'ignore',
    });
  } catch {}
}

// ── CLI entry point ───────────────────────────────────────────────────────────
// Usage (also available as /usr/local/bin/mizi_execute via onstart.sh):
//   node context-shield.mjs exec      <bash command>
//   node context-shield.mjs exec-file <path>
//   node context-shield.mjs batch     '[{"cmd":"ls","opts":{}}]'
//   node context-shield.mjs stats
//   node context-shield.mjs doctor
//   node context-shield.mjs cleanup

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [,, cmd, ...args] = process.argv;

  switch (cmd) {
    case 'exec': {
      const command = args.join(' ');
      const result  = shieldedExec(command);
      if (result.blocked || result.shielded) {
        process.stdout.write((result.summary || result.reason) + '\n');
      } else {
        process.stdout.write(result.output || '');
      }
      process.exit(result.ok ? 0 : (result.blocked ? 2 : 1));
      break;
    }

    case 'exec-file': {
      const result = shieldedExecFile(args[0]);
      if (result.shielded) {
        process.stdout.write(result.summary + '\n');
      } else if (result.error) {
        process.stderr.write(result.error + '\n');
      } else {
        process.stdout.write(result.output || '');
      }
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'batch': {
      const commands = JSON.parse(args[0] || '[]');
      const result   = batchExec(commands);
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.ok ? 0 : 1);
      break;
    }

    case 'stats':
      process.stdout.write(JSON.stringify(mizi_stats(), null, 2) + '\n');
      break;

    case 'doctor': {
      const result = mizi_doctor();
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.exit(result.healthy ? 0 : 1);
      break;
    }

    case 'cleanup': {
      const removed = cleanupStaleArtifacts();
      evictArtifactsLRU();
      process.stdout.write(JSON.stringify({ removed }) + '\n');
      break;
    }

    default:
      process.stderr.write(
        `Usage: context-shield.mjs <exec|exec-file|batch|stats|doctor|cleanup> [args]\n`
      );
      process.exit(1);
  }
}
