#!/usr/bin/env node
'use strict';

const http      = require('http');
const { execSync, spawnSync } = require('child_process');
const fs        = require('fs');
const path      = require('path');

const PORT         = 5182;
const TMUX_SESSION = 'claw-task';
const OUTPUT_FILE  = '/tmp/claw-output.txt';
const SHIELD_SCRIPT = '/opt/repo-intelligence/context-shield.mjs';
const STATE_SCRIPT  = '/opt/repo-intelligence/session-state.mjs';
const SNAPSHOT_MAX_AGE_MS = 2 * 60 * 60 * 1000; // 2 hours

// ── Shared state ─────────────────────────────────────────────────────────────
let currentTaskId = null;

// ── Tmux helpers ─────────────────────────────────────────────────────────────

function isRunning() {
  try {
    execSync(`tmux has-session -t ${TMUX_SESSION} 2>/dev/null`);
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

// ── Session journal helpers ───────────────────────────────────────────────────

function appendEvent(event) {
  if (!fs.existsSync(STATE_SCRIPT)) return;
  try {
    spawnSync('node', [STATE_SCRIPT, 'append-event', JSON.stringify(event)], {
      timeout: 4000, stdio: 'ignore',
    });
  } catch {}
}

function readRestore() {
  if (!fs.existsSync(STATE_SCRIPT)) return null;
  try {
    const r = spawnSync('node', [STATE_SCRIPT, 'restore'], { encoding: 'utf8', timeout: 5000 });
    if (r.status !== 0 || !r.stdout) return null;
    const data = JSON.parse(r.stdout);
    if (!data.snapshot) return null;

    // Only use snapshot if it is recent
    const createdAt = data.snapshot._created_at
      ? new Date(data.snapshot._created_at).getTime()
      : 0;
    if (Date.now() - createdAt > SNAPSHOT_MAX_AGE_MS) return null;

    return data;
  } catch { return null; }
}

function buildRestoreBlock(data) {
  const s = data.snapshot;
  const lines = ['[WORKING STATE RESTORED from previous context]'];

  if (s.activeTask)       lines.push(`Active task   : ${s.activeTask}`);
  if (s.planCheckpoint)   lines.push(`Plan checkpoint:\n${s.planCheckpoint}`);
  if (s.activeFiles?.length) lines.push(`Active files  : ${s.activeFiles.slice(0, 5).join(', ')}`);
  if (s.unresolvedErrors) lines.push(`Unresolved err: ${s.unresolvedErrors}`);
  if (s.bundleSlug)       lines.push(`Bundle        : ${s.bundleSlug}`);
  if (s.tokenMode)        lines.push(`Token mode    : ${s.tokenMode}`);

  lines.push('[END RESTORE BLOCK — verify against current filesystem before acting on this context]\n');
  return lines.join('\n');
}

// ── Task runner ───────────────────────────────────────────────────────────────

function runTask(task, { restoreContext = true } = {}) {
  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}
  fs.writeFileSync(OUTPUT_FILE, '');

  currentTaskId = `task-${Date.now()}`;

  // Optionally prepend restore block if a recent snapshot exists
  let finalTask = task;
  if (restoreContext) {
    const restoreData = readRestore();
    if (restoreData) {
      const block = buildRestoreBlock(restoreData);
      finalTask   = block + '\n' + task;
      appendEvent({
        actor_type: 'claw-runner',
        task_id:    currentTaskId,
        event_type: 'restore_injected',
        payload:    { snapshot_age_ms: Date.now() - new Date(restoreData.snapshot._created_at).getTime() },
      });
      // Track restore success
      try {
        spawnSync('node', [STATE_SCRIPT, 'increment-stats', JSON.stringify({ restoreSuccess: 1 })], {
          timeout: 3000, stdio: 'ignore',
        });
      } catch {}
    }
  }

  appendEvent({
    actor_type: 'claw-runner',
    task_id:    currentTaskId,
    event_type: 'task_start',
    payload:    { task: task.slice(0, 500), taskId: currentTaskId },
  });

  const escaped = finalTask.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  execSync(`tmux new-session -d -s ${TMUX_SESSION} -x 220 -y 50`);
  execSync(
    `tmux send-keys -t ${TMUX_SESSION} "cd /workspace/projects && claw '${escaped}' 2>&1 | tee ${OUTPUT_FILE}; echo '[CLAW DONE]'" Enter`
  );
}

function stopTask() {
  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}
  if (currentTaskId) {
    appendEvent({
      actor_type: 'claw-runner',
      task_id:    currentTaskId,
      event_type: 'task_stopped',
      payload:    { stoppedBy: 'user' },
    });
    currentTaskId = null;
  }
}

// ── Shield HTTP helpers ───────────────────────────────────────────────────────

function callShield(subcmd, args = []) {
  if (!fs.existsSync(SHIELD_SCRIPT)) {
    return { ok: false, error: 'context-shield.mjs not found — repo intelligence not installed' };
  }
  const r = spawnSync('node', [SHIELD_SCRIPT, subcmd, ...args], {
    encoding: 'utf8',
    timeout:  35_000,
  });
  if (r.error) return { ok: false, error: r.error.message };
  // For exec/exec-file the response is text, not JSON — return as-is
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
</style>
</head>
<body>
<header>
  <div class="logo">⚡</div>
  <div class="logo-text">
    <h1>Claw Task Runner</h1>
    <p>Agentic coding powered by Kimi K2.5 + Context Shield</p>
  </div>
</header>

<section>
  <label>Task Description</label>
  <textarea id="task" placeholder="Describe what you want claw to build or fix in plain English.&#10;&#10;Example: Add a /health endpoint to the Express app in src/server.js that returns JSON with uptime and version from package.json."></textarea>
  <div class="actions">
    <button id="runBtn" onclick="runTask()">▶ Run with Claw</button>
    <button id="stopBtn" onclick="stopTask()">■ Stop</button>
    <button id="snapshotBtn" onclick="takeSnapshot()">📸 Snapshot</button>
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

<script>
  let pollTimer = null;

  async function runTask() {
    const task = document.getElementById('task').value.trim();
    if (!task) { document.getElementById('task').focus(); return; }
    const restoreContext = document.getElementById('restoreToggle').checked;
    document.getElementById('runBtn').disabled = true;
    document.getElementById('output').textContent = 'Starting claw…';
    setStatus('running', 'Starting…');
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
  }

  async function stopTask() {
    try { await fetch('/stop', {method:'POST'}); } catch {}
    clearInterval(pollTimer);
    setStatus('idle', 'Stopped by user');
    document.getElementById('runBtn').disabled = false;
  }

  async function takeSnapshot() {
    const task = document.getElementById('task').value.trim();
    const btn  = document.getElementById('snapshotBtn');
    btn.disabled = true;
    btn.textContent = 'Saving…';
    try {
      const r = await fetch('/floatr/snapshot', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ activeTask: task.slice(0, 200) || 'unknown', tokenMode: 'core' })
      });
      const data = await r.json();
      btn.textContent = data.ok ? '✓ Saved' : '✗ Failed';
    } catch {
      btn.textContent = '✗ Error';
    }
    setTimeout(() => { btn.disabled = false; btn.textContent = '📸 Snapshot'; }, 2000);
  }

  function setStatus(state, text) {
    const dot = document.getElementById('dot');
    dot.className = 'dot' + (state === 'running' ? ' running' : state === 'done' ? ' done' : '');
    document.getElementById('statusLabel').textContent = text;
  }

  async function poll() {
    try {
      const [sr, or] = await Promise.all([fetch('/status'), fetch('/output')]);
      const {running} = await sr.json();
      const out = await or.text();
      const pre = document.getElementById('output');
      const atBottom = pre.scrollHeight - pre.scrollTop <= pre.clientHeight + 40;
      pre.textContent = out || '(no output yet)';
      if (atBottom) pre.scrollTop = pre.scrollHeight;
      if (running) {
        setStatus('running', 'Running…');
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

  startPolling();
</script>
</body>
</html>`;

// ── HTTP server ───────────────────────────────────────────────────────────────

const server = http.createServer(async (req, res) => {
  const { method, url } = req;

  // ── Standard Claw Runner routes ─────────────────────────────────────────────

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
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(getOutput());
  }

  if (method === 'GET' && url === '/status') {
    const running = isRunning();
    // Detect task completion and write event
    if (!running && currentTaskId) {
      const output = getOutput();
      appendEvent({
        actor_type: 'claw-runner',
        task_id:    currentTaskId,
        event_type: 'task_complete',
        payload:    { success: output.includes('[CLAW DONE]'), taskId: currentTaskId },
      });
      currentTaskId = null;
    }
    return sendJson(res, 200, { running });
  }

  if (method === 'POST' && url === '/stop') {
    stopTask();
    return sendJson(res, 200, { ok: true });
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
      event_type: 'floatr_execute',
      payload:    { cmd: String(cmd).slice(0, 300), opts: body.opts || {} },
    });

    const result = callShield('exec', [cmd]);
    const output = result.stdout || '';

    // If output is JSON (unlikely for exec), wrap in text; otherwise return text
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(output + (result.stderr ? `\n[stderr]\n${result.stderr}` : ''));
  }

  if (url === '/floatr/execute-file' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }

    const filePath = body.path || body.filePath;
    if (!filePath) return sendJson(res, 400, { error: 'path required' });

    const result = callShield('exec-file', [filePath]);
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(result.stdout || '');
  }

  if (url === '/floatr/batch-execute' && method === 'POST') {
    let body;
    try { body = await parseBody(req); }
    catch { return sendJson(res, 400, { error: 'invalid json' }); }

    const commands = Array.isArray(body) ? body : body.commands;
    if (!Array.isArray(commands)) return sendJson(res, 400, { error: 'commands array required' });

    const result = callShield('batch', [JSON.stringify(commands)]);
    let parsed;
    try { parsed = JSON.parse(result.stdout || '{}'); }
    catch { parsed = { ok: false, raw: result.stdout }; }

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

    const r = spawnSync('node', [STATE_SCRIPT, 'snapshot', JSON.stringify(snapshot)], {
      encoding: 'utf8', timeout: 5000,
    });

    appendEvent({
      actor_type: 'claw-runner',
      task_id:    currentTaskId || '',
      event_type: 'snapshot_written',
      payload:    { activeTask: snapshot.activeTask },
    });

    return sendJson(res, r.status === 0 ? 200 : 500, {
      ok:  r.status === 0,
      ...(r.status !== 0 ? { error: r.stderr || 'snapshot failed' } : {}),
    });
  }

  if (url === '/floatr/restore' && method === 'GET') {
    const data = readRestore();
    if (!data) return sendJson(res, 200, { ok: true, snapshot: null, message: 'No recent snapshot found' });
    return sendJson(res, 200, { ok: true, ...data });
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`claw-runner listening on 127.0.0.1:${PORT}`);
});
