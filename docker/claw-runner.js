#!/usr/bin/env node
'use strict';

const http      = require('http');
const https     = require('https');
const { execSync, spawnSync } = require('child_process');
const fs        = require('fs');
const crypto    = require('crypto');

const PORT          = 5182;
const TMUX_SESSION  = 'claw-task';
const OUTPUT_FILE   = '/tmp/claw-output.txt';
const SHIELD_SCRIPT = '/opt/repo-intelligence/context-shield.mjs';
const STATE_SCRIPT  = '/opt/repo-intelligence/session-state.mjs';

// Max age for automatic restore injection (task-start path)
const RESTORE_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ── Swarm configuration ───────────────────────────────────────────────────────
const SWARM_MAX_WORKERS       = parseInt(process.env.SWARM_MAX_WORKERS || '4', 10);
// SWARM_CONCURRENCY controls parallel fan-out; defaults to SWARM_MAX_WORKERS.
// Set lower (e.g. 2) to queue excess tasks rather than running all at once.
const SWARM_CONCURRENCY       = Math.min(
  parseInt(process.env.SWARM_CONCURRENCY || String(SWARM_MAX_WORKERS), 10),
  SWARM_MAX_WORKERS
);
const SWARM_WORKER_TIMEOUT_MS = parseInt(process.env.SWARM_WORKER_TIMEOUT_MS || String(10 * 60 * 1000), 10);
const SWARM_WORKER_RETRY      = 1; // one automatic retry on transient failure
// VLLM_BASE_URL should include the /v1 path segment for OpenAI-compatible endpoints.
// Default assumes litellm proxy at 8081 with standard /v1 prefix.
const VLLM_BASE_URL           = process.env.VLLM_BASE_URL || 'http://localhost:8081/v1';
const SERVED_MODEL            = process.env.SERVED_MODEL_NAME || 'kimi-k2-6';
// Separate API key for vLLM/litellm proxy (internal). Defaults to OMNIQL_MEM_AUTH_TOKEN
// for environments where the same token is reused, but can be overridden independently.
const VLLM_API_KEY            = process.env.VLLM_API_KEY || '';
const SYNTHESIS_MAX_TOKENS    = parseInt(process.env.SYNTHESIS_MAX_TOKENS || '8192', 10);
const WORKER_MAX_TOKENS       = parseInt(process.env.WORKER_MAX_TOKENS || '4096', 10);

// Decompose delimiters
const DECOMPOSE_START = '@@DECOMPOSE_START@@';
const DECOMPOSE_END   = '@@DECOMPOSE_END@@';
const SEQUENTIAL_TAG  = '@@SEQUENTIAL_REASON@@';

// ── Swarm state ───────────────────────────────────────────────────────────────
let swarmState = {
  active:         false,
  phase:          'idle',
  requestId:      null,
  totalWorkers:   0,
  doneWorkers:    0,
  failedWorkers:  0,
  skipped:        false,
  skipReason:     null,
  workers:        [],
  abortRequested: false,
};

function resetSwarmState() {
  swarmState = {
    active:         false,
    phase:          'idle',
    requestId:      null,
    totalWorkers:   0,
    doneWorkers:    0,
    failedWorkers:  0,
    skipped:        false,
    skipReason:     null,
    workers:        [],
    abortRequested: false,
  };
}

// ── Module-level shared state ─────────────────────────────────────────────────
let currentTaskId      = null;
let compactionPending  = false; // Set by /floatr/compact — cleared after restore injection

// ── Tmux helpers ──────────────────────────────────────────────────────────────

function isRunning() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function isTmuxSessionRunning(session) {
  try {
    execSync(`tmux has-session -t ${session} 2>/dev/null`);
    return true;
  } catch {
    return false;
  }
}

function getOutput() {
  try {
    const buf = execSync(`tmux capture-pane -p -t ${TMUX_SESSION} -S -500 2>/dev/null`);
    return buf.toString();
  } catch {
    try { return fs.readFileSync(OUTPUT_FILE, 'utf8'); } catch { return ''; }
  }
}

// ── Journal helpers (fire-and-forget) ────────────────────────────────────────

function appendEvent(event) {
  if (!fs.existsSync(STATE_SCRIPT)) return;
  try {
    spawnSync('node', [STATE_SCRIPT, 'append-event', JSON.stringify(event)], {
      timeout: 4000, stdio: 'ignore',
    });
  } catch {}
}

function incrementStats(delta) {
  if (!fs.existsSync(STATE_SCRIPT)) return;
  try {
    spawnSync('node', [STATE_SCRIPT, 'increment-stats', JSON.stringify(delta)], {
      timeout: 3000, stdio: 'ignore',
    });
  } catch {}
}

// Derive the routing-stats callback URL from OMNIQL_CALLBACK_URL.
const _rawCallbackUrl = process.env.OMNIQL_CALLBACK_URL || '';
const ROUTING_STATS_URL = _rawCallbackUrl
  ? _rawCallbackUrl.replace(/\/status$/, '/routing-stats')
  : '';
const CALLBACK_BEARER_TOKEN = process.env.OMNIQL_MEM_AUTH_TOKEN || '';

function pushRoutingStats() {
  if (!ROUTING_STATS_URL) return;
  if (!fs.existsSync(SHIELD_SCRIPT)) return;
  try {
    const r = spawnSync('node', [SHIELD_SCRIPT, 'stats'], { encoding: 'utf8', timeout: 4000 });
    if (!r.stdout) return;
    const stats = JSON.parse(r.stdout);
    const payload = JSON.stringify({
      totalBytesAvoided: stats.total_bytes_avoided || 0,
      totalShielded:     stats.total_shielded     || 0,
      totalArtifacts:    stats.total_artifacts    || 0,
      totalBlocked:      stats.total_blocked      || 0,
      routingFailures:   stats.routing_failures   || 0,
    });
    const url = new URL(ROUTING_STATS_URL);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (CALLBACK_BEARER_TOKEN) headers['Authorization'] = `Bearer ${CALLBACK_BEARER_TOKEN}`;
    const options = {
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
    };
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request(options);
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

// Push swarm status snapshot to callback URL
function pushSwarmCallback(snapshot) {
  if (!_rawCallbackUrl) return;
  try {
    const swarmCallbackUrl = _rawCallbackUrl.replace(/\/status$/, '/swarm-status');
    const payload = JSON.stringify(snapshot);
    const url = new URL(swarmCallbackUrl);
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload),
    };
    if (CALLBACK_BEARER_TOKEN) headers['Authorization'] = `Bearer ${CALLBACK_BEARER_TOKEN}`;
    const mod = url.protocol === 'https:' ? https : http;
    const req = mod.request({
      hostname: url.hostname,
      port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname,
      method: 'POST',
      headers,
    });
    req.on('error', () => {});
    req.write(payload);
    req.end();
  } catch {}
}

// ── Restore helpers ───────────────────────────────────────────────────────────

function readRestoreData() {
  if (!fs.existsSync(STATE_SCRIPT)) return null;
  try {
    const r = spawnSync('node', [STATE_SCRIPT, 'restore'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return null;
    return JSON.parse(r.stdout);
  } catch { return null; }
}

function isSnapshotUsable(data, forceCompactionRestore = false) {
  if (!data?.snapshot) return false;
  if (forceCompactionRestore) return true;
  const createdAt = data.snapshot._created_at
    ? new Date(data.snapshot._created_at).getTime()
    : 0;
  return Date.now() - createdAt < RESTORE_MAX_AGE_MS;
}

function buildRestoreBlock(data, reason = 'reconnect') {
  const s = data.snapshot;
  const lines = [
    `[WORKING STATE RESTORED — trigger: ${reason}]`,
    `Snapshot age: ${s._created_at ? Math.round((Date.now() - new Date(s._created_at).getTime()) / 60000) + ' min' : 'unknown'}`,
  ];
  if (s.activeTask)         lines.push(`Active task     : ${s.activeTask}`);
  if (s.planCheckpoint)     lines.push(`Plan checkpoint :\n${s.planCheckpoint}`);
  if (s.activeFiles?.length) lines.push(`Active files    : ${s.activeFiles.slice(0, 5).join(', ')}`);
  if (s.unresolvedErrors)   lines.push(`Unresolved err  : ${s.unresolvedErrors}`);
  if (s.bundleSlug)         lines.push(`Bundle          : ${s.bundleSlug}`);
  if (s.tokenMode)          lines.push(`Token mode      : ${s.tokenMode}`);
  lines.push('[END RESTORE — validate fields against current filesystem state before using]\n');
  return lines.join('\n');
}

function writeSnapshot(state) {
  if (!fs.existsSync(STATE_SCRIPT)) return false;
  const r = spawnSync('node', [STATE_SCRIPT, 'snapshot', JSON.stringify(state)], {
    encoding: 'utf8', timeout: 5000,
  });
  return r.status === 0;
}

// ── Swarm orchestrator system prompt ──────────────────────────────────────────

const ORCHESTRATOR_SWARM_PROMPT = `
[SWARM ORCHESTRATION CAPABILITY]
You are running inside a swarm-capable harness. If this task would genuinely benefit from parallel execution (multiple independent workstreams that do not depend on each other), you MAY emit a structured decomposition block. This is entirely optional — simple, sequential, or tightly coupled tasks should NOT decompose and should be executed normally.

If you decide to decompose, emit EXACTLY the following structure (no other text between the delimiters):

${DECOMPOSE_START}
[
  {
    "id": "worker-1",
    "task": "Concise description of the sub-task (unique, specific)",
    "goal": "What success looks like for this sub-task",
    "inputs": "What context/files/data this worker needs",
    "expected_output": "What the worker must produce",
    "priority": 1
  }
]
${DECOMPOSE_END}

Rules:
- Minimum 2 sub-tasks, maximum ${SWARM_MAX_WORKERS} sub-tasks.
- Each sub-task MUST be independently executable (no inter-worker dependencies).
- All fields are required. No free-form tags — only the fields above.
- "priority" is optional (integer 1=highest); omit or set to 5 for normal.
- Do NOT decompose if tasks are sequential, if they share mutable state, or if parallelism would not save meaningful work.
- Workers are forbidden from spawning further sub-agents.

If you choose NOT to decompose and the reason is that sequential execution is better, you may optionally emit:
${SEQUENTIAL_TAG}: <one-line reason>

Otherwise, execute the task normally without any decomposition block.
[END SWARM ORCHESTRATION CAPABILITY]
`;

// ── Decomposition gate ─────────────────────────────────────────────────────────

function parseDecomposition(output) {
  const startIdx = output.indexOf(DECOMPOSE_START);
  const endIdx   = output.indexOf(DECOMPOSE_END);
  if (startIdx === -1 || endIdx === -1 || endIdx <= startIdx) return { found: false };
  const jsonStr = output.slice(startIdx + DECOMPOSE_START.length, endIdx).trim();
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed)) {
      return { found: true, subtasks: null, error: 'decomposition block is not a JSON array' };
    }
    return { found: true, subtasks: parsed };
  } catch (e) {
    return { found: true, subtasks: null, error: `invalid JSON in decomposition block: ${e.message}` };
  }
}

function parseSequentialReason(output) {
  const idx = output.indexOf(SEQUENTIAL_TAG + ':');
  if (idx === -1) return null;
  const rest = output.slice(idx + SEQUENTIAL_TAG.length + 1).split('\n')[0].trim();
  return rest || 'model chose sequential execution';
}

// Allowed keys per sub-task schema — free-form tags are rejected
const ALLOWED_SUBTASK_KEYS = new Set(['id', 'task', 'goal', 'inputs', 'expected_output', 'priority']);

function validateDecomposition(subtasks) {
  const errors = [];

  // Guard: must be a non-empty array before iterating
  if (!Array.isArray(subtasks)) {
    errors.push('decomposition block is not a JSON array');
    return errors;
  }

  if (subtasks.length < 2) {
    errors.push('fewer than 2 sub-tasks');
  }

  if (subtasks.length > SWARM_MAX_WORKERS) {
    errors.push(`exceeds SWARM_MAX_WORKERS (${SWARM_MAX_WORKERS})`);
  }

  const ids   = new Set();
  const tasks = [];

  for (const st of subtasks) {
    // Guard: must be a plain object
    if (!st || typeof st !== 'object' || Array.isArray(st)) {
      errors.push('sub-task entry is not an object');
      continue;
    }

    // Reject free-form/unknown keys — strict schema
    for (const key of Object.keys(st)) {
      if (!ALLOWED_SUBTASK_KEYS.has(key)) {
        errors.push(`sub-task contains unknown field "${key}" (only id, task, goal, inputs, expected_output, priority allowed)`);
      }
    }

    if (!st.id || typeof st.id !== 'string') {
      errors.push(`sub-task missing id: ${JSON.stringify(st).slice(0, 80)}`);
      continue;
    }
    if (ids.has(st.id)) {
      errors.push(`duplicate id: ${st.id}`);
    }
    ids.add(st.id);

    if (!st.task || !st.task.trim()) {
      errors.push(`sub-task ${st.id} missing task`);
    }
    if (!st.goal || !st.goal.trim()) {
      errors.push(`sub-task ${st.id} missing goal`);
    }
    if (!st.inputs || !String(st.inputs).trim()) {
      errors.push(`sub-task ${st.id} missing inputs`);
    }
    if (!st.expected_output || !st.expected_output.trim()) {
      errors.push(`sub-task ${st.id} missing expected_output`);
    }

    // Check specificity: task description must be > 10 chars
    if (st.task && st.task.trim().length < 10) {
      errors.push(`sub-task ${st.id} task description lacks specificity`);
    }

    // Validate optional priority field type
    if ('priority' in st && (typeof st.priority !== 'number' || !Number.isInteger(st.priority) || st.priority < 1)) {
      errors.push(`sub-task ${st.id} priority must be a positive integer`);
    }

    // Near-duplicate detection
    for (const existing of tasks) {
      const similarity = levenshteinSimilarity(
        (st.task || '').toLowerCase(),
        (existing || '').toLowerCase()
      );
      if (similarity > 0.85) {
        errors.push(`sub-task ${st.id} is near-duplicate of another sub-task`);
        break;
      }
    }
    tasks.push(st.task || '');

    // Check for inherently sequential markers
    const taskLower = (st.task || '').toLowerCase();
    if (taskLower.includes('after worker') || taskLower.includes('depends on worker') ||
        taskLower.includes('once worker') || taskLower.includes('wait for worker')) {
      errors.push(`sub-task ${st.id} appears inherently sequential (references other workers)`);
    }
  }

  return errors;
}

function levenshteinSimilarity(a, b) {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const la = a.length, lb = b.length;
  if (la === 0 || lb === 0) return 0;
  const dp = Array.from({ length: la + 1 }, (_, i) => [i, ...Array(lb).fill(0)]);
  for (let j = 0; j <= lb; j++) dp[0][j] = j;
  for (let i = 1; i <= la; i++) {
    for (let j = 1; j <= lb; j++) {
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
    }
  }
  const dist = dp[la][lb];
  return 1 - dist / Math.max(la, lb);
}

// Sanitize model-controlled id strings before shell interpolation.
// Allows only alphanumeric, hyphen, underscore — max 64 chars.
function sanitizeShellToken(str) {
  return String(str || 'worker').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ── Direct vLLM HTTP call (for synthesis) ─────────────────────────────────────

function callVLLM({ messages, maxTokens = 2048, priority = 5, requestId }) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      model:      SERVED_MODEL,
      messages,
      max_tokens: maxTokens,
      temperature: 0.2,
      stream: false,
    });

    const url = new URL(`${VLLM_BASE_URL}/chat/completions`);
    const mod = url.protocol === 'https:' ? https : http;

    const headers = {
      'Content-Type':  'application/json',
      'Content-Length': Buffer.byteLength(body),
      'X-Request-Id':   requestId || crypto.randomUUID(),
      'X-Priority':     String(priority),
    };
    // Use VLLM_API_KEY for the model proxy — separate from the API server callback token
    if (VLLM_API_KEY) headers['Authorization'] = `Bearer ${VLLM_API_KEY}`;

    const req = mod.request({
      hostname: url.hostname,
      port:     url.port || (url.protocol === 'https:' ? 443 : 80),
      path:     url.pathname + (url.search || ''),
      method:   'POST',
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => { data += c; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          const text = parsed?.choices?.[0]?.message?.content || '';
          resolve(text);
        } catch {
          reject(new Error(`vLLM parse error: ${data.slice(0, 200)}`));
        }
      });
    });

    req.on('error', reject);
    req.setTimeout(SWARM_WORKER_TIMEOUT_MS, () => {
      req.destroy(new Error('vLLM request timeout'));
    });
    req.write(body);
    req.end();
  });
}

// ── Worker prompt construction ────────────────────────────────────────────────

function buildWorkerPrompt(subtask, sharedContext) {
  return [
    'You are a worker agent. Do not synthesise the full task or spawn sub-agents.',
    'Complete ONLY your assigned sub-task and return the result.',
    'Do NOT emit @@DECOMPOSE_START@@ or any decomposition blocks.',
    '',
    '=== YOUR ASSIGNED SUB-TASK ===',
    `ID: ${subtask.id}`,
    `Task: ${subtask.task}`,
    `Goal: ${subtask.goal}`,
    `Inputs: ${subtask.inputs || 'see shared context below'}`,
    `Expected output: ${subtask.expected_output}`,
    '',
    '=== SHARED CONTEXT ===',
    sharedContext || '(no additional shared context provided)',
    '',
    '=== CONSTRAINTS ===',
    `- Token budget: ${WORKER_MAX_TOKENS} tokens maximum`,
    '- Do not synthesise results from other workers',
    '- Do not spawn sub-agents or further decompose this task',
    '- Complete only what is described in YOUR ASSIGNED SUB-TASK above',
    '',
    'Begin working on your assigned sub-task now.',
  ].join('\n');
}

// ── SwarmManager ──────────────────────────────────────────────────────────────

// Single-agent fallback: run the original task directly via claw without any
// swarm prompt injection. Used after gate_rejected so the task always completes.
// Uses a dedicated output file to avoid false-positive [CLAW DONE] detection
// from the earlier orchestrator pass already written to OUTPUT_FILE.
function runSingleAgentFallback(originalTask, taskId, requestId) {
  return new Promise((resolve) => {
    const SESSION      = `${TMUX_SESSION}-fallback`;
    const FALLBACK_OUT = '/tmp/claw-fallback.txt';

    try { execSync(`tmux kill-session -t ${SESSION} 2>/dev/null`); } catch {}
    try { fs.writeFileSync(FALLBACK_OUT, ''); } catch {}

    appendEvent({
      actor_type: 'claw-runner',
      task_id:    taskId,
      event_type: 'single_agent_fallback_start',
      payload:    { requestId, reason: 'gate_rejected' },
    });

    const escaped = originalTask.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
    try {
      execSync(`tmux new-session -d -s ${SESSION} -x 220 -y 50`);
      // Write to dedicated FALLBACK_OUT — never touches OUTPUT_FILE during execution
      execSync(
        `tmux send-keys -t ${SESSION} "VLLM_REQUEST_PRIORITY=1 REQUEST_ID=${requestId}-fallback ` +
        `cd /workspace/projects && claw '${escaped}' 2>&1 | tee ${FALLBACK_OUT}; echo '[CLAW DONE]'" Enter`
      );
    } catch (err) {
      appendEvent({
        actor_type: 'claw-runner',
        task_id:    taskId,
        event_type: 'single_agent_fallback_error',
        payload:    { requestId, error: err.message },
      });
      // Write minimal done marker so output contract is preserved
      try { fs.writeFileSync(OUTPUT_FILE, '[FALLBACK FAILED: ' + err.message + ']\n[CLAW DONE]'); } catch {}
      resolve();
      return;
    }

    // Poll FALLBACK_OUT (not OUTPUT_FILE) for completion
    const deadline = Date.now() + SWARM_WORKER_TIMEOUT_MS * 2;
    const pollMs   = 2000;
    const timer    = setInterval(() => {
      let out = '';
      try { out = fs.readFileSync(FALLBACK_OUT, 'utf8'); } catch {}

      const sessionDone = !isTmuxSessionRunning(SESSION);
      const hasDone     = out.includes('[CLAW DONE]');

      if (hasDone || sessionDone || Date.now() > deadline) {
        clearInterval(timer);
        try { execSync(`tmux kill-session -t ${SESSION} 2>/dev/null`); } catch {}

        // Refresh output in case session just exited
        try { out = fs.readFileSync(FALLBACK_OUT, 'utf8'); } catch {}
        if (!out.includes('[CLAW DONE]')) out += '\n[CLAW DONE]';

        // Replace OUTPUT_FILE with clean fallback result (strip any stale markers)
        try { fs.writeFileSync(OUTPUT_FILE, out); } catch {}

        appendEvent({
          actor_type: 'claw-runner',
          task_id:    taskId,
          event_type: 'single_agent_fallback_done',
          payload:    { requestId, timedOut: Date.now() > deadline && !hasDone },
        });
        resolve();
      }
    }, pollMs);
  });
}

async function runSwarmOrchestration(originalTask, orchestratorOutput, taskId, requestId) {
  const parsed = parseDecomposition(orchestratorOutput);

  if (!parsed.found) {
    // No decomposition block emitted at all — check for sequential reason
    const seqReason = parseSequentialReason(orchestratorOutput);
    swarmState.skipped    = true;
    swarmState.skipReason = seqReason || 'no decomposition block emitted';
    swarmState.phase      = 'done';
    swarmState.active     = false;

    appendEvent({
      actor_type: 'claw-runner',
      task_id:    taskId,
      event_type: 'swarm_skipped',
      payload:    { requestId, reason: swarmState.skipReason },
    });
    pushSwarmCallback({ ...getSwarmSnapshot(), taskId });
    return;
  }

  // Decomposition delimiters were present — run gate
  const subtasks   = parsed.subtasks;
  const parseError = parsed.error;

  // Malformed JSON / non-array is treated as gate_rejected, not swarm_skipped
  const gateErrors = parseError
    ? [parseError]
    : validateDecomposition(subtasks);

  if (gateErrors.length > 0) {
    swarmState.skipped    = true;
    swarmState.skipReason = 'gate_rejected: ' + gateErrors.join('; ');
    swarmState.phase      = 'done';
    swarmState.active     = false;

    appendEvent({
      actor_type: 'claw-runner',
      task_id:    taskId,
      event_type: 'gate_rejected',
      payload:    { requestId, errors: gateErrors, subtaskCount: subtasks ? subtasks.length : 0 },
    });
    pushSwarmCallback({ ...getSwarmSnapshot(), taskId });

    // Spec requires: fall back to single-agent execution on gate rejection.
    // The orchestrator already ran with swarm prompt which may have left the model
    // focused on decomposition rather than solving. Run a fresh sequential pass.
    await runSingleAgentFallback(originalTask, taskId, requestId);
    return;
  }

  // Gate passed — initialise swarm
  swarmState.active       = true;
  swarmState.phase        = 'working';
  swarmState.totalWorkers = subtasks.length;
  swarmState.doneWorkers  = 0;
  swarmState.failedWorkers = 0;
  swarmState.workers      = subtasks.map((st, i) => ({
    index:      i,
    id:         st.id,                         // original display id (may be any string)
    shellId:    sanitizeShellToken(st.id),     // sanitized — safe for shell interpolation
    task:       st.task,
    priority:   typeof st.priority === 'number' ? st.priority : 5,
    status:     'queued',
    output:     '',
    error:      null,
    retries:    0,
    outputFile: `/tmp/swarm-worker-${i}.txt`,
    session:    `claw-swarm-${i}`,
  }));

  appendEvent({
    actor_type: 'claw-runner',
    task_id:    taskId,
    event_type: 'swarm_start',
    payload:    { requestId, totalWorkers: swarmState.totalWorkers, subtaskIds: subtasks.map(s => s.id) },
  });
  pushSwarmCallback({ ...getSwarmSnapshot(), taskId });

  // Extract shared context from the orchestrator output (everything before the decompose block)
  const decomposeIdx = orchestratorOutput.indexOf(DECOMPOSE_START);
  const sharedContext = decomposeIdx > 0
    ? orchestratorOutput.slice(0, decomposeIdx).trim().slice(-3000)
    : '';

  // Sort by priority (lower number = higher priority)
  const sortedWorkers = [...swarmState.workers].sort((a, b) => a.priority - b.priority);

  // Process workers with concurrency cap
  const queue     = [...sortedWorkers];
  let   inFlight  = 0;
  const completed = new Promise((resolveAll) => {
    function tryNext() {
      if (swarmState.abortRequested) {
        // Kill all running sessions
        for (const w of swarmState.workers) {
          if (w.status === 'running') {
            try { execSync(`tmux kill-session -t ${w.session} 2>/dev/null`); } catch {}
            w.status = 'aborted';
          }
        }
        resolveAll();
        return;
      }

      while (inFlight < SWARM_CONCURRENCY && queue.length > 0) {
        const worker = queue.shift();
        inFlight++;
        runWorker(worker, subtasks[worker.index], sharedContext, taskId, requestId)
          .then(() => {
            inFlight--;
            tryNext();
            if (inFlight === 0 && queue.length === 0) resolveAll();
          })
          .catch(() => {
            inFlight--;
            tryNext();
            if (inFlight === 0 && queue.length === 0) resolveAll();
          });
      }
      if (inFlight === 0 && queue.length === 0) resolveAll();
    }
    tryNext();
  });

  await completed;

  if (swarmState.abortRequested) {
    swarmState.phase  = 'aborted';
    swarmState.active = false;
    appendEvent({
      actor_type: 'claw-runner',
      task_id:    taskId,
      event_type: 'swarm_aborted',
      payload:    { requestId },
    });
    pushSwarmCallback({ ...getSwarmSnapshot(), taskId });
    return;
  }

  // Synthesis
  swarmState.phase = 'synthesizing';
  appendEvent({
    actor_type: 'claw-runner',
    task_id:    taskId,
    event_type: 'swarm_synthesis_start',
    payload:    { requestId, doneWorkers: swarmState.doneWorkers, failedWorkers: swarmState.failedWorkers },
  });
  pushSwarmCallback({ ...getSwarmSnapshot(), taskId });

  try {
    const synthesisPrompt = buildSynthesisPrompt(originalTask, swarmState.workers);
    const synthesisResult = await callVLLM({
      messages: [
        { role: 'system', content: 'You are a synthesis agent. Combine worker results into a cohesive final answer.' },
        { role: 'user',   content: synthesisPrompt },
      ],
      maxTokens: SYNTHESIS_MAX_TOKENS,
      priority:  1,
      requestId: requestId + '-synthesis',
    });

    // Write synthesis result as canonical terminal output.
    // Strip any prior [CLAW DONE] from the orchestrator run so downstream
    // consumers see exactly one completion marker at the very end.
    try {
      const existing = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8') : '';
      const cleaned  = existing.replace(/\[CLAW DONE\]/g, '').trimEnd();
      fs.writeFileSync(OUTPUT_FILE, cleaned + '\n\n[SWARM SYNTHESIS RESULT]\n' + synthesisResult + '\n[CLAW DONE]');
    } catch {}

    swarmState.phase  = 'done';
    swarmState.active = false;

    appendEvent({
      actor_type: 'claw-runner',
      task_id:    taskId,
      event_type: 'swarm_synthesis_done',
      payload:    { requestId, outputLength: synthesisResult.length },
    });
    pushSwarmCallback({ ...getSwarmSnapshot(), taskId });

  } catch (err) {
    swarmState.phase  = 'done';
    swarmState.active = false;

    appendEvent({
      actor_type: 'claw-runner',
      task_id:    taskId,
      event_type: 'swarm_synthesis_error',
      payload:    { requestId, error: err.message },
    });
    pushSwarmCallback({ ...getSwarmSnapshot(), taskId });

    // Still write done marker; strip stale [CLAW DONE] so exactly one appears
    try {
      const existing = fs.existsSync(OUTPUT_FILE) ? fs.readFileSync(OUTPUT_FILE, 'utf8') : '';
      const cleaned  = existing.replace(/\[CLAW DONE\]/g, '').trimEnd();
      fs.writeFileSync(OUTPUT_FILE, cleaned + '\n\n[SWARM SYNTHESIS FAILED: ' + err.message + ']\n[CLAW DONE]');
    } catch {}
  }
}

function buildSynthesisPrompt(originalTask, workers) {
  const lines = [
    '=== SYNTHESIS REQUEST ===',
    `Original task: ${originalTask}`,
    '',
    'The following worker results are available:',
    '',
  ];

  for (const w of workers) {
    lines.push(`--- Worker: ${w.id} [${w.status}] ---`);
    if (w.status === 'done') {
      lines.push(w.output ? w.output.slice(-2000) : '(no output captured)');
    } else {
      lines.push(`[FAILED] ${w.error || 'unknown error'}`);
      if (w.output) lines.push('Partial output: ' + w.output.slice(-500));
    }
    lines.push('');
  }

  lines.push('=== END WORKER RESULTS ===');
  lines.push('');
  lines.push('Synthesise the above worker results into a single, coherent final answer for the original task.');
  lines.push('If some workers failed, incorporate their error context and note what was not completed.');

  return lines.join('\n');
}

async function runWorker(worker, subtask, sharedContext, taskId, requestId) {
  worker.status = 'running';
  appendEvent({
    actor_type: 'claw-runner',
    task_id:    taskId,
    event_type: 'worker_start',
    payload:    { requestId, workerId: worker.id, workerIndex: worker.index, priority: worker.priority },
  });
  pushSwarmCallback({ ...getSwarmSnapshot(), taskId });

  const workerPrompt = buildWorkerPrompt(subtask, sharedContext);

  // Kill any existing session with the same name
  try { execSync(`tmux kill-session -t ${worker.session} 2>/dev/null`); } catch {}

  // Clear output file
  try { fs.writeFileSync(worker.outputFile, ''); } catch {}

  const escaped = workerPrompt.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");

  // Priority 5 = worker; use sanitized shellId (never raw model id) in shell env
  execSync(
    `tmux new-session -d -s ${worker.session} -x 220 -y 50 \\; ` +
    `send-keys -t ${worker.session} ` +
    `"VLLM_REQUEST_PRIORITY=5 REQUEST_ID=${requestId}-${worker.shellId} CLAW_MAX_TOKENS=${WORKER_MAX_TOKENS} ` +
    `cd /workspace/projects && claw --max-tokens ${WORKER_MAX_TOKENS} '${escaped}' 2>&1 | tee ${worker.outputFile}; echo '[WORKER DONE]'" Enter`
  );

  // Wait for worker to complete or timeout
  const success = await waitForWorkerCompletion(worker, taskId, requestId);

  if (!success && !swarmState.abortRequested && worker.retries < SWARM_WORKER_RETRY) {
    // One automatic retry (skipped if abort was requested)
    worker.retries++;
    appendEvent({
      actor_type: 'claw-runner',
      task_id:    taskId,
      event_type: 'worker_retry',
      payload:    { requestId, workerId: worker.id, attempt: worker.retries },
    });

    try { execSync(`tmux kill-session -t ${worker.session} 2>/dev/null`); } catch {}
    try { fs.writeFileSync(worker.outputFile, ''); } catch {}

    execSync(
      `tmux new-session -d -s ${worker.session} -x 220 -y 50 \\; ` +
      `send-keys -t ${worker.session} ` +
      `"VLLM_REQUEST_PRIORITY=5 REQUEST_ID=${requestId}-${worker.shellId}-retry CLAW_MAX_TOKENS=${WORKER_MAX_TOKENS} ` +
      `cd /workspace/projects && claw --max-tokens ${WORKER_MAX_TOKENS} '${escaped}' 2>&1 | tee ${worker.outputFile}; echo '[WORKER DONE]'" Enter`
    );

    await waitForWorkerCompletion(worker, taskId, requestId);
  }

  // Kill session when done
  try { execSync(`tmux kill-session -t ${worker.session} 2>/dev/null`); } catch {}

  if (worker.status !== 'done') {
    worker.status = 'failed';
    swarmState.failedWorkers++;
  } else {
    swarmState.doneWorkers++;
  }

  appendEvent({
    actor_type: 'claw-runner',
    task_id:    taskId,
    event_type: worker.status === 'done' ? 'worker_done' : 'worker_failed',
    payload:    {
      requestId,
      workerId:    worker.id,
      workerIndex: worker.index,
      retries:     worker.retries,
      outputBytes: worker.output ? Buffer.byteLength(worker.output) : 0,
      error:       worker.error,
    },
  });
  pushSwarmCallback({ ...getSwarmSnapshot(), taskId });
}

function waitForWorkerCompletion(worker, taskId, requestId) {
  return new Promise((resolve) => {
    const deadline = Date.now() + SWARM_WORKER_TIMEOUT_MS;
    const intervalMs = 2000;

    const timer = setInterval(() => {
      if (swarmState.abortRequested) {
        clearInterval(timer);
        worker.error = 'aborted by emergency stop';
        resolve(false);
        return;
      }

      // Read output file
      try {
        worker.output = fs.readFileSync(worker.outputFile, 'utf8');
      } catch {}

      // Check for completion marker
      if (worker.output && worker.output.includes('[WORKER DONE]')) {
        clearInterval(timer);
        worker.status = 'done';
        resolve(true);
        return;
      }

      // Check session is still alive
      if (!isTmuxSessionRunning(worker.session)) {
        // Session died — check if output has the done marker
        try { worker.output = fs.readFileSync(worker.outputFile, 'utf8'); } catch {}
        if (worker.output && worker.output.includes('[WORKER DONE]')) {
          clearInterval(timer);
          worker.status = 'done';
          resolve(true);
        } else {
          clearInterval(timer);
          worker.error = 'tmux session died unexpectedly';
          resolve(false);
        }
        return;
      }

      // Timeout check
      if (Date.now() > deadline) {
        clearInterval(timer);
        try { execSync(`tmux kill-session -t ${worker.session} 2>/dev/null`); } catch {}
        worker.error = `timed out after ${SWARM_WORKER_TIMEOUT_MS / 1000}s`;
        resolve(false);
      }
    }, intervalMs);
  });
}

function getSwarmSnapshot() {
  return {
    active:        swarmState.active,
    phase:         swarmState.phase,
    totalWorkers:  swarmState.totalWorkers,
    doneWorkers:   swarmState.doneWorkers,
    failedWorkers: swarmState.failedWorkers,
    skipped:       swarmState.skipped,
    skipReason:    swarmState.skipReason,
    workers: swarmState.workers.map(w => ({
      id:         w.id,
      index:      w.index,
      task:       w.task,
      priority:   w.priority,
      status:     w.status,
      retries:    w.retries,
      error:      w.error,
      outputTail: w.output ? w.output.slice(-800) : '',
    })),
  };
}

// ── Task runner ───────────────────────────────────────────────────────────────

function runTask(taskText, opts = {}) {
  const { restoreContext = true } = opts;

  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}
  fs.writeFileSync(OUTPUT_FILE, '');
  resetSwarmState();

  currentTaskId = `task-${Date.now()}`;
  const requestId = crypto.randomUUID();

  // ─ Restore block injection ────────────────────────────────────────────────
  let finalTask    = taskText;
  let restoreReason = null;

  if (restoreContext) {
    const forceRestore = compactionPending;
    compactionPending  = false;

    const restoreData = readRestoreData();
    if (restoreData && isSnapshotUsable(restoreData, forceRestore)) {
      restoreReason = forceRestore ? 'compaction' : 'reconnect';
      finalTask     = buildRestoreBlock(restoreData, restoreReason) + '\n' + taskText;

      appendEvent({
        actor_type: 'claw-runner',
        task_id:    currentTaskId,
        event_type: 'restore_injected',
        payload:    {
          reason:          restoreReason,
          snapshotCreated: restoreData.snapshot?._created_at,
          ageMsSnapshot:   restoreData.snapshot?._created_at
            ? Date.now() - new Date(restoreData.snapshot._created_at).getTime()
            : null,
        },
      });
      incrementStats({ restoreSuccess: 1 });
    } else if (forceRestore) {
      appendEvent({
        actor_type: 'claw-runner',
        task_id:    currentTaskId,
        event_type: 'restore_failed',
        payload:    { reason: 'compaction_no_snapshot', available: !!restoreData?.snapshot },
      });
      incrementStats({ restoreFailure: 1 });
    }
  }

  // ─ Inject orchestrator swarm prompt ───────────────────────────────────────
  const orchestratorTask = ORCHESTRATOR_SWARM_PROMPT + '\n\n' + finalTask;

  // ─ Event: user_ask ────────────────────────────────────────────────────────
  appendEvent({
    actor_type: 'user',
    task_id:    currentTaskId,
    event_type: 'user_ask',
    payload:    { task: taskText.slice(0, 500), restoreContext, restoreReason, requestId },
  });

  // ─ Event: task_start ──────────────────────────────────────────────────────
  appendEvent({
    actor_type: 'claw-runner',
    task_id:    currentTaskId,
    event_type: 'task_start',
    payload:    { taskId: currentTaskId, restoreInjected: restoreReason !== null, requestId },
  });

  swarmState.requestId = requestId;
  swarmState.phase     = 'orchestrating';

  const escaped = orchestratorTask.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  execSync(`tmux new-session -d -s ${TMUX_SESSION} -x 220 -y 50`);
  // Priority 1 = orchestrator planning; REQUEST_ID correlates this call end-to-end
  execSync(
    `tmux send-keys -t ${TMUX_SESSION} "VLLM_REQUEST_PRIORITY=1 REQUEST_ID=${requestId} ` +
    `cd /workspace/projects && claw '${escaped}' 2>&1 | tee ${OUTPUT_FILE}; echo '[CLAW DONE]'" Enter`
  );

  // Monitor orchestrator completion and trigger swarm if decomposition found
  monitorOrchestratorAndSwarm(taskText, currentTaskId, requestId);
}

function monitorOrchestratorAndSwarm(originalTask, taskId, requestId) {
  const pollMs = 2500;
  const timer  = setInterval(async () => {
    if (isRunning()) return; // orchestrator still running

    clearInterval(timer);

    // Read the output
    let output = '';
    try { output = fs.readFileSync(OUTPUT_FILE, 'utf8'); } catch {}

    // Check if this is still the same task
    if (currentTaskId !== taskId) return;

    // Run swarm orchestration (async, fire-and-forget style but tracked)
    try {
      await runSwarmOrchestration(originalTask, output, taskId, requestId);
    } catch (err) {
      appendEvent({
        actor_type: 'claw-runner',
        task_id:    taskId,
        event_type: 'swarm_error',
        payload:    { requestId, error: err.message },
      });
      swarmState.phase  = 'done';
      swarmState.active = false;
    }

    // Mark overall task complete
    if (currentTaskId === taskId) {
      const finalOutput = (() => { try { return fs.readFileSync(OUTPUT_FILE, 'utf8'); } catch { return ''; } })();
      const success = finalOutput.includes('[CLAW DONE]');
      appendEvent({
        actor_type: 'claw-runner',
        task_id:    taskId,
        event_type: 'task_complete',
        payload:    { success, taskId, requestId, swarmUsed: swarmState.totalWorkers > 0 },
      });
      currentTaskId = null;
    }
  }, pollMs);
}

function stopTask() {
  // Set abortRequested BEFORE killing sessions so worker loops see it first.
  // Do NOT call resetSwarmState() here — in-flight worker polling loops read
  // abortRequested and must not find a cleared state during their next tick.
  // State is reset at the top of the next runTask() call.
  swarmState.abortRequested = true;

  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}

  // Kill any active worker sessions
  for (const w of swarmState.workers) {
    try { execSync(`tmux kill-session -t ${w.session} 2>/dev/null`); } catch {}
    if (w.status === 'running' || w.status === 'queued') w.status = 'aborted';
  }

  if (currentTaskId) {
    appendEvent({
      actor_type: 'claw-runner',
      task_id:    currentTaskId,
      event_type: 'task_stopped',
      payload:    { stoppedBy: 'user' },
    });
    currentTaskId = null;
  }

  // Mark swarm as aborted so /swarm/status reflects the halt
  if (swarmState.active) {
    swarmState.active = false;
    swarmState.phase  = 'aborted';
  }
}

// ── Shield HTTP helpers ───────────────────────────────────────────────────────

function callShield(subcmd, args = []) {
  if (!fs.existsSync(SHIELD_SCRIPT)) {
    return { ok: false, error: 'context-shield.mjs not found', exitCode: -1 };
  }
  const r = spawnSync('node', [SHIELD_SCRIPT, subcmd, ...args], {
    encoding: 'utf8',
    timeout:  35_000,
  });
  if (r.error) return { ok: false, error: r.error.message, exitCode: -1 };
  return { ok: r.status === 0, stdout: r.stdout || '', stderr: r.stderr || '', exitCode: r.status };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try { resolve(JSON.parse(body)); }
      catch { reject(new Error('invalid json')); }
    });
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(body);
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

// ── HTML UI ───────────────────────────────────────────────────────────────────

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Claw Task Runner</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0f1117;color:#e2e8f0;font-family:'Segoe UI',system-ui,sans-serif;padding:28px 32px;min-height:100vh}
header{display:flex;align-items:center;gap:12px;margin-bottom:24px;padding-bottom:20px;border-bottom:1px solid #1e293b}
.logo{width:32px;height:32px;background:#1d4ed8;border-radius:8px;display:flex;align-items:center;justify-content:center;flex-shrink:0;font-size:18px}
.logo-text h1{font-size:1rem;font-weight:700;color:#fff;line-height:1.2}
.logo-text p{font-size:0.75rem;color:#64748b}
section{margin-bottom:20px}
label{display:block;font-size:0.75rem;font-weight:600;color:#64748b;text-transform:uppercase;letter-spacing:.06em;margin-bottom:8px}
textarea{width:100%;background:#141b2d;border:1px solid #1e293b;border-radius:8px;color:#e2e8f0;font-size:0.88rem;line-height:1.6;padding:12px 14px;resize:vertical;min-height:130px;outline:none;transition:border-color .15s;font-family:inherit}
textarea:focus{border-color:#3b82f6}
.actions{display:flex;gap:8px;margin-top:10px;flex-wrap:wrap;align-items:center}
button{border:none;border-radius:6px;padding:9px 20px;font-size:0.83rem;font-weight:600;cursor:pointer;transition:background .15s,opacity .15s}
button:disabled{opacity:.4;cursor:not-allowed}
#runBtn{background:#2563eb;color:#fff}
#runBtn:hover:not(:disabled){background:#1d4ed8}
#stopBtn{background:#1e293b;color:#f87171;border:1px solid #2d3748}
#stopBtn:hover:not(:disabled){background:#273044}
#snapshotBtn{background:#1e293b;color:#a78bfa;border:1px solid #2d3748;font-size:0.76rem;padding:7px 14px}
#snapshotBtn:hover:not(:disabled){background:#1a2035}
#compactBtn{background:#1e293b;color:#fb923c;border:1px solid #2d3748;font-size:0.76rem;padding:7px 14px}
#compactBtn:hover:not(:disabled){background:#1a2035}
.restore-toggle{display:flex;align-items:center;gap:6px;font-size:0.78rem;color:#64748b;cursor:pointer;user-select:none}
.restore-toggle input{accent-color:#3b82f6}
.status-bar{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.dot{width:8px;height:8px;border-radius:50%;background:#334155;flex-shrink:0;transition:background .3s}
.dot.running{background:#22c55e;animation:pulse 1.4s ease-in-out infinite}
.dot.done{background:#3b82f6}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.3}}
.status-label{font-size:0.78rem;color:#64748b}
pre{background:#07090f;border:1px solid #1a2035;border-radius:8px;padding:14px 16px;font-size:0.75rem;font-family:'JetBrains Mono','Fira Code',ui-monospace,monospace;color:#94a3b8;line-height:1.7;overflow:auto;max-height:440px;white-space:pre-wrap;word-break:break-all;min-height:60px}
.hint{font-size:0.73rem;color:#334155;margin-top:8px}

/* Swarm Activity Panel */
#swarmPanel{display:none;margin-top:20px;border:1px solid #1e3a5f;border-radius:10px;background:#0d1626;padding:18px 20px}
#swarmPanel.visible{display:block}
.swarm-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px}
.swarm-title{font-size:0.85rem;font-weight:700;color:#60a5fa;letter-spacing:.04em}
.swarm-phase{font-size:0.75rem;color:#64748b;background:#0f1827;border:1px solid #1e293b;border-radius:4px;padding:2px 8px}
.swarm-progress-bar{width:100%;height:6px;background:#1e293b;border-radius:3px;margin-bottom:14px;overflow:hidden}
.swarm-progress-fill{height:100%;background:#2563eb;border-radius:3px;transition:width .4s}
.worker-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:10px;margin-bottom:14px}
.worker-card{background:#0f1827;border:1px solid #1e293b;border-radius:7px;padding:10px 12px}
.worker-card.running{border-color:#22c55e}
.worker-card.done{border-color:#3b82f6}
.worker-card.failed{border-color:#f87171}
.worker-card.queued{border-color:#334155}
.worker-card.aborted{border-color:#f59e0b}
.worker-id{font-size:0.7rem;font-weight:700;color:#64748b;margin-bottom:4px;text-transform:uppercase}
.worker-task{font-size:0.75rem;color:#94a3b8;margin-bottom:6px;line-height:1.4}
.worker-status{display:flex;align-items:center;gap:6px;font-size:0.72rem}
.worker-badge{border-radius:3px;padding:1px 6px;font-weight:600;font-size:0.68rem}
.badge-queued{background:#1e293b;color:#64748b}
.badge-running{background:#14532d;color:#4ade80}
.badge-done{background:#1e3a8a;color:#93c5fd}
.badge-failed{background:#450a0a;color:#fca5a5}
.badge-aborted{background:#451a03;color:#fdba74}
.worker-output{font-size:0.68rem;font-family:'JetBrains Mono',ui-monospace,monospace;color:#475569;margin-top:6px;background:#07090f;border-radius:4px;padding:5px 7px;max-height:80px;overflow:auto;white-space:pre-wrap;word-break:break-all;line-height:1.5;display:none}
.worker-card.running .worker-output,.worker-card.done .worker-output,.worker-card.failed .worker-output{display:block}
.swarm-skipped{background:#0f1827;border:1px solid #422006;border-radius:6px;padding:10px 14px;font-size:0.75rem;color:#92400e}
.abort-link{display:none;font-size:0.73rem;color:#f87171;cursor:pointer;text-decoration:underline;margin-top:10px}
.abort-link.visible{display:block}
.swarm-stats{display:flex;gap:16px;margin-bottom:12px;font-size:0.75rem;color:#64748b}
.swarm-stat span{color:#e2e8f0;font-weight:600}
</style>
</head>
<body>
<header>
  <div class="logo">⚡</div>
  <div class="logo-text">
    <h1>Claw Task Runner</h1>
    <p>Agentic coding powered by Kimi K2.6 + Context Shield</p>
  </div>
</header>

<section>
  <label>Task Description</label>
  <textarea id="task" placeholder="Describe what you want claw to build or fix in plain English.&#10;&#10;Example: Add a /health endpoint to the Express app in src/server.js that returns JSON with uptime and version from package.json."></textarea>
  <div class="actions">
    <button id="runBtn" onclick="runTask()">▶ Run with Claw</button>
    <button id="stopBtn" onclick="stopTask()">■ Stop</button>
    <button id="snapshotBtn" onclick="takeSnapshot()">📸 Snapshot</button>
    <button id="compactBtn" onclick="signalCompact()">🔄 Signal Compact</button>
    <label class="restore-toggle">
      <input type="checkbox" id="restoreToggle" checked>
      Restore context on start
    </label>
  </div>
  <p class="hint">Claw works inside /workspace/projects. Shielded execution routes high-output commands through /workspace/.floatr/artifacts/.</p>
</section>

<section>
  <div class="status-bar">
    <div class="dot" id="dot"></div>
    <span class="status-label" id="statusLabel">Idle — no task running</span>
  </div>
  <label>Live Output</label>
  <pre id="output">Output will appear here once a task is running.</pre>
</section>

<!-- Swarm Activity Panel -->
<div id="swarmPanel">
  <div class="swarm-header">
    <span class="swarm-title">Swarm Activity</span>
    <span class="swarm-phase" id="swarmPhase">idle</span>
  </div>
  <div class="swarm-stats" id="swarmStats" style="display:none">
    Workers: <span id="swarmTotal">0</span> total &nbsp;|&nbsp;
    <span id="swarmDone">0</span> done &nbsp;|&nbsp;
    <span id="swarmFailed">0</span> failed
  </div>
  <div class="swarm-progress-bar" id="swarmProgressBar" style="display:none">
    <div class="swarm-progress-fill" id="swarmProgressFill" style="width:0%"></div>
  </div>
  <div class="worker-grid" id="workerGrid"></div>
  <div class="swarm-skipped" id="swarmSkipped" style="display:none"></div>
  <a class="abort-link" id="abortLink" onclick="abortSwarm()">Abort swarm (emergency)</a>
</div>

<script>
  let pollTimer = null;
  let swarmPollTimer = null;

  async function runTask() {
    const task = document.getElementById('task').value.trim();
    if (!task) { document.getElementById('task').focus(); return; }
    const restoreContext = document.getElementById('restoreToggle').checked;
    document.getElementById('runBtn').disabled = true;
    document.getElementById('output').textContent = 'Starting claw…';
    setStatus('running', 'Starting…');
    resetSwarmPanel();
    try {
      await fetch('/run', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({task, restoreContext})
      });
    } catch(e) {
      setStatus('idle', 'Failed to start: ' + e.message);
      document.getElementById('runBtn').disabled = false;
      return;
    }
    startPolling();
    startSwarmPolling();
  }

  async function stopTask() {
    try { await fetch('/stop', {method:'POST'}); } catch {}
    clearInterval(pollTimer);
    clearInterval(swarmPollTimer);
    setStatus('idle', 'Stopped by user');
    document.getElementById('runBtn').disabled = false;
  }

  async function abortSwarm() {
    if (!confirm('Emergency abort the swarm? This will kill all running workers immediately.')) return;
    try { await fetch('/swarm/abort', {method:'POST'}); } catch {}
  }

  async function takeSnapshot() {
    const task = document.getElementById('task').value.trim();
    const btn  = document.getElementById('snapshotBtn');
    btn.disabled = true; btn.textContent = 'Saving…';
    try {
      const r = await fetch('/floatr/snapshot', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ activeTask: task.slice(0, 200) || 'unknown', tokenMode: 'core' })
      });
      const data = await r.json();
      btn.textContent = data.ok ? '✓ Saved' : '✗ Failed';
    } catch { btn.textContent = '✗ Error'; }
    setTimeout(() => { btn.disabled = false; btn.textContent = '📸 Snapshot'; }, 2000);
  }

  async function signalCompact() {
    const task = document.getElementById('task').value.trim();
    const btn  = document.getElementById('compactBtn');
    btn.disabled = true; btn.textContent = 'Compacting…';
    try {
      const r = await fetch('/floatr/compact', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ activeTask: task.slice(0, 200) || 'unknown', tokenMode: 'core' })
      });
      const data = await r.json();
      btn.textContent = data.ok ? '✓ Snapshot saved' : '✗ Failed';
    } catch { btn.textContent = '✗ Error'; }
    setTimeout(() => { btn.disabled = false; btn.textContent = '🔄 Signal Compact'; }, 2500);
  }

  function setStatus(state, text) {
    const dot = document.getElementById('dot');
    dot.className = 'dot' + (state === 'running' ? ' running' : state === 'done' ? ' done' : '');
    document.getElementById('statusLabel').textContent = text;
  }

  async function poll() {
    try {
      const [sr, or] = await Promise.all([fetch('/status'), fetch('/output')]);
      const {running, swarmActive} = await sr.json();
      const out = await or.text();
      const pre = document.getElementById('output');
      const atBottom = pre.scrollHeight - pre.scrollTop <= pre.clientHeight + 40;
      pre.textContent = out || '(no output yet)';
      if (atBottom) pre.scrollTop = pre.scrollHeight;
      const anyActive = running || swarmActive;
      if (anyActive) {
        setStatus('running', running ? 'Running…' : 'Swarm running…');
      } else {
        clearInterval(pollTimer);
        setStatus('done', out.includes('[CLAW DONE]') ? 'Task complete' : 'Finished');
        document.getElementById('runBtn').disabled = false;
      }
    } catch {}
  }

  function startPolling() {
    clearInterval(pollTimer);
    poll();
    pollTimer = setInterval(poll, 1500);
  }

  function resetSwarmPanel() {
    document.getElementById('swarmPanel').classList.remove('visible');
    document.getElementById('workerGrid').innerHTML = '';
    document.getElementById('swarmSkipped').style.display = 'none';
    document.getElementById('swarmStats').style.display = 'none';
    document.getElementById('swarmProgressBar').style.display = 'none';
    document.getElementById('abortLink').classList.remove('visible');
    document.getElementById('swarmPhase').textContent = 'idle';
  }

  async function pollSwarm() {
    try {
      const r = await fetch('/swarm/status');
      if (!r.ok) return;
      const s = await r.json();

      const panel = document.getElementById('swarmPanel');

      // Show panel if swarm ever had workers or skipped
      if (s.totalWorkers > 0 || s.skipped || ['working','synthesizing','orchestrating'].includes(s.phase)) {
        panel.classList.add('visible');
      }

      document.getElementById('swarmPhase').textContent = s.phase || 'idle';

      if (s.skipped) {
        document.getElementById('swarmSkipped').style.display = 'block';
        document.getElementById('swarmSkipped').textContent =
          'Sequential execution chosen' + (s.skipReason ? ': ' + s.skipReason : '');
      } else {
        document.getElementById('swarmSkipped').style.display = 'none';
      }

      if (s.totalWorkers > 0) {
        document.getElementById('swarmStats').style.display = 'flex';
        document.getElementById('swarmTotal').textContent = s.totalWorkers;
        document.getElementById('swarmDone').textContent  = s.doneWorkers;
        document.getElementById('swarmFailed').textContent = s.failedWorkers;

        document.getElementById('swarmProgressBar').style.display = 'block';
        const pct = s.totalWorkers > 0 ? Math.round(((s.doneWorkers + s.failedWorkers) / s.totalWorkers) * 100) : 0;
        document.getElementById('swarmProgressFill').style.width = pct + '%';
      }

      // Abort link — only while swarm is active
      const abortLink = document.getElementById('abortLink');
      if (s.active && s.totalWorkers > 0) {
        abortLink.classList.add('visible');
      } else {
        abortLink.classList.remove('visible');
      }

      // Worker cards
      const grid = document.getElementById('workerGrid');
      if (s.workers && s.workers.length > 0) {
        grid.innerHTML = s.workers.map(w => \`
          <div class="worker-card \${w.status}">
            <div class="worker-id">\${escHtml(w.id)}</div>
            <div class="worker-task">\${escHtml((w.task || '').slice(0, 120))}</div>
            <div class="worker-status">
              <span class="worker-badge badge-\${w.status}">\${w.status.toUpperCase()}\${w.retries > 0 ? ' (retry '+w.retries+')' : ''}</span>
              \${w.error ? '<span style="color:#f87171;font-size:0.68rem"> ' + escHtml(w.error) + '</span>' : ''}
            </div>
            \${w.outputTail ? '<div class="worker-output">' + escHtml(w.outputTail.slice(-400)) + '</div>' : ''}
          </div>
        \`).join('');
      }

      // Stop polling if done
      if (!s.active && ['done','aborted','idle'].includes(s.phase) && s.phase !== 'idle') {
        clearInterval(swarmPollTimer);
      }
    } catch {}
  }

  function startSwarmPolling() {
    clearInterval(swarmPollTimer);
    pollSwarm();
    swarmPollTimer = setInterval(pollSwarm, 2000);
  }

  function escHtml(str) {
    return String(str || '')
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/"/g,'&quot;').replace(/'/g,'&#39;');
  }

  startPolling();
  startSwarmPolling();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // ── Standard Claw Runner routes ──────────────────────────────────────────

  if (method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  if (method === 'POST' && url === '/run') {
    try {
      const body = await parseBody(req);
      if (!body.task || typeof body.task !== 'string') {
        return sendJson(res, 400, { error: 'task string required' });
      }
      runTask(body.task.trim(), { restoreContext: body.restoreContext !== false });
      return sendJson(res, 200, { ok: true });
    } catch (e) {
      return sendJson(res, 400, { error: e.message || 'invalid json' });
    }
  }

  if (method === 'GET' && url === '/output') {
    return sendText(res, 200, getOutput());
  }

  if (method === 'GET' && url === '/status') {
    const running    = isRunning();
    const swarmActive = swarmState.active;
    return sendJson(res, 200, { running, swarmActive });
  }

  if (method === 'POST' && url === '/stop') {
    stopTask();
    return sendJson(res, 200, { ok: true });
  }

  // ── Swarm routes ──────────────────────────────────────────────────────────

  if (method === 'GET' && url === '/swarm/status') {
    return sendJson(res, 200, getSwarmSnapshot());
  }

  if (method === 'POST' && url === '/swarm/abort') {
    if (!swarmState.active) {
      return sendJson(res, 200, { ok: true, message: 'no active swarm' });
    }
    swarmState.abortRequested = true;

    // Kill all worker sessions immediately
    for (const w of swarmState.workers) {
      try { execSync(`tmux kill-session -t ${w.session} 2>/dev/null`); } catch {}
      if (w.status === 'running' || w.status === 'queued') {
        w.status = 'aborted';
      }
    }

    appendEvent({
      actor_type: 'claw-runner',
      task_id:    currentTaskId || '',
      event_type: 'swarm_abort_requested',
      payload:    { requestId: swarmState.requestId },
    });

    return sendJson(res, 200, { ok: true, message: 'abort signal sent' });
  }

  // ── Context Shield routes (/floatr/*) ─────────────────────────────────────

  if (url === '/floatr/execute' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }

    const cmd = typeof body === 'string' ? body : body.cmd;
    if (!cmd) return sendJson(res, 400, { error: 'cmd required' });

    appendEvent({
      actor_type: 'tool',
      task_id:    currentTaskId || '',
      event_type: 'tool_use',
      payload:    { tool: 'floatr_execute', cmd: String(cmd).slice(0, 300) },
    });

    const result = callShield('exec', [cmd]);
    const output = result.stdout || '';

    appendEvent({
      actor_type: 'tool',
      task_id:    currentTaskId || '',
      event_type: 'tool_result',
      payload:    { tool: 'floatr_execute', exitCode: result.exitCode, outputBytes: Buffer.byteLength(output, 'utf8') },
    });

    if (result.exitCode === 2) {
      return sendText(res, 403, output + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''));
    }
    if (result.exitCode !== 0 && result.exitCode !== null) {
      return sendText(res, 500, output + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''));
    }

    return sendText(res, 200, output + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''));
  }

  if (url === '/floatr/execute-file' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }

    const filePath = body.path || body.filePath;
    if (!filePath) return sendJson(res, 400, { error: 'path required' });

    appendEvent({
      actor_type: 'tool',
      task_id:    currentTaskId || '',
      event_type: 'tool_use',
      payload:    { tool: 'floatr_execute_file', path: filePath },
    });

    const result = callShield('exec-file', [filePath]);

    appendEvent({
      actor_type: 'tool',
      task_id:    currentTaskId || '',
      event_type: 'tool_result',
      payload:    { tool: 'floatr_execute_file', exitCode: result.exitCode },
    });

    if (!result.ok) {
      return sendText(res, 500, result.stderr || result.error || 'exec-file failed');
    }
    return sendText(res, 200, result.stdout || '');
  }

  if (url === '/floatr/batch-execute' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }

    const commands = Array.isArray(body) ? body : body.commands;
    if (!Array.isArray(commands)) return sendJson(res, 400, { error: 'commands array required' });

    appendEvent({
      actor_type: 'tool',
      task_id:    currentTaskId || '',
      event_type: 'tool_use',
      payload:    { tool: 'floatr_batch_execute', count: commands.length },
    });

    const result = callShield('batch', [JSON.stringify(commands)]);
    let parsed;
    try { parsed = JSON.parse(result.stdout || '{}'); }
    catch { parsed = { ok: false, raw: result.stdout }; }

    appendEvent({
      actor_type: 'tool',
      task_id:    currentTaskId || '',
      event_type: 'tool_result',
      payload:    { tool: 'floatr_batch_execute', ok: parsed.ok, totalBytesAvoided: parsed.totalBytesAvoided },
    });

    if (parsed.totalBytesAvoided > 0) pushRoutingStats();

    return sendJson(res, result.ok ? 200 : 500, parsed);
  }

  if (url === '/floatr/stats' && method === 'GET') {
    const result = callShield('stats');
    let parsed;
    try { parsed = JSON.parse(result.stdout || '{}'); }
    catch { parsed = { raw: result.stdout }; }
    return sendJson(res, 200, parsed);
  }

  if (url === '/floatr/doctor' && method === 'GET') {
    const result = callShield('doctor');
    let parsed;
    try { parsed = JSON.parse(result.stdout || '{}'); }
    catch { parsed = { raw: result.stdout }; }
    return sendJson(res, result.ok ? 200 : 503, parsed);
  }

  if (url === '/floatr/snapshot' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }

    if (!fs.existsSync(STATE_SCRIPT)) {
      return sendJson(res, 503, { ok: false, error: 'session-state.mjs not found' });
    }

    const snapshot = {
      activeTask:       body.activeTask       || '',
      planCheckpoint:   body.planCheckpoint   || '',
      activeFiles:      body.activeFiles      || [],
      unresolvedErrors: body.unresolvedErrors || '',
      bundleSlug:       body.bundleSlug       || '',
      tokenMode:        body.tokenMode        || 'core',
    };

    const ok = writeSnapshot(snapshot);
    appendEvent({
      actor_type: 'claw-runner',
      task_id:    currentTaskId || '',
      event_type: 'snapshot_written',
      payload:    { activeTask: snapshot.activeTask, trigger: 'manual' },
    });

    return sendJson(res, ok ? 200 : 500, {
      ok,
      ...(ok ? {} : { error: 'snapshot failed' }),
    });
  }

  if (url === '/floatr/compact' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { body = {}; }

    const snapshot = {
      activeTask:       body.activeTask       || '',
      planCheckpoint:   body.planCheckpoint   || '',
      activeFiles:      body.activeFiles      || [],
      unresolvedErrors: body.unresolvedErrors || '',
      bundleSlug:       body.bundleSlug       || '',
      tokenMode:        body.tokenMode        || 'core',
    };

    const snapshotWritten = writeSnapshot(snapshot);
    compactionPending = true;

    appendEvent({
      actor_type: 'claw-runner',
      task_id:    currentTaskId || '',
      event_type: 'compaction_signal',
      payload:    { activeTask: snapshot.activeTask, snapshotWritten },
    });

    if (!snapshotWritten) {
      return sendJson(res, 500, {
        ok:               false,
        snapshotWritten:  false,
        compactionPending: true,
        error:            'Snapshot write failed — session-state.mjs may be unavailable. compactionPending is still set; restore may use last good snapshot.',
      });
    }

    return sendJson(res, 200, {
      ok:               true,
      snapshotWritten:  true,
      compactionPending: true,
      message:          'Compaction signal received. Next task start will inject restore block from this snapshot.',
    });
  }

  if (url === '/floatr/restore' && method === 'GET') {
    const data = readRestoreData();
    if (!data) return sendJson(res, 200, { ok: true, snapshot: null, message: 'No restore data found' });
    const usable = isSnapshotUsable(data, false);
    return sendJson(res, 200, { ok: true, usable, compactionPending, ...data });
  }

  if (url === '/floatr/event' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }

    if (!body.event_type) return sendJson(res, 400, { error: 'event_type required' });

    const ALLOWED_EXTERNAL_EVENTS = new Set([
      'tool_use', 'tool_result', 'plan_change', 'plan_checkpoint',
      'user_note', 'error_observed', 'decision', 'task_progress',
    ]);

    if (!ALLOWED_EXTERNAL_EVENTS.has(body.event_type)) {
      return sendJson(res, 400, {
        error: `event_type '${body.event_type}' not allowed from external callers`,
        allowed: [...ALLOWED_EXTERNAL_EVENTS],
      });
    }

    appendEvent({
      actor_type: body.actor_type || 'model',
      actor_id:   body.actor_id   || '',
      task_id:    body.task_id    || currentTaskId || '',
      event_type: body.event_type,
      payload:    body.payload    || {},
    });

    return sendJson(res, 200, { ok: true });
  }

  if (url === '/floatr/plan' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }

    if (!body.checkpoint) return sendJson(res, 400, { error: 'checkpoint string required' });

    appendEvent({
      actor_type: 'model',
      task_id:    currentTaskId || '',
      event_type: 'plan_change',
      payload:    {
        checkpoint:    body.checkpoint,
        activeFiles:   body.activeFiles   || [],
        taskSummary:   body.taskSummary   || '',
      },
    });

    if (fs.existsSync(STATE_SCRIPT)) {
      const currentState = { planCheckpoint: body.checkpoint, activeFiles: body.activeFiles || [] };
      spawnSync('node', [STATE_SCRIPT, 'update-state', JSON.stringify(currentState)], {
        timeout: 3000, stdio: 'ignore',
      });
    }

    return sendJson(res, 200, { ok: true });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`claw-runner listening on 127.0.0.1:${PORT}`);
});
