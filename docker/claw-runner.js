#!/usr/bin/env node
'use strict';

const http = require('http');
const { execSync } = require('child_process');
const fs = require('fs');

const PORT = 5182;
const TMUX_SESSION = 'claw-task';
const OUTPUT_FILE = '/tmp/claw-output.txt';

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

function runTask(task) {
  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}
  fs.writeFileSync(OUTPUT_FILE, '');
  const escaped = task.replace(/\\/g, '\\\\').replace(/'/g, "'\\''");
  execSync(`tmux new-session -d -s ${TMUX_SESSION} -x 220 -y 50`);
  execSync(`tmux send-keys -t ${TMUX_SESSION} "cd /workspace/projects && claw '${escaped}' 2>&1 | tee ${OUTPUT_FILE}; echo '[CLAW DONE]'" Enter`);
}

function stopTask() {
  try { execSync(`tmux kill-session -t ${TMUX_SESSION} 2>/dev/null`); } catch {}
}

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
.actions{display:flex;gap:8px;margin-top:10px}
button{border:none;border-radius:6px;padding:9px 20px;font-size:0.83rem;font-weight:600;cursor:pointer;transition:background .15s,opacity .15s}
button:disabled{opacity:.4;cursor:not-allowed}
#runBtn{background:#2563eb;color:#fff}
#runBtn:hover:not(:disabled){background:#1d4ed8}
#stopBtn{background:#1e293b;color:#f87171;border:1px solid #2d3748}
#stopBtn:hover:not(:disabled){background:#273044}
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
    <p>Agentic coding powered by Kimi K2.5</p>
  </div>
</header>

<section>
  <label>Task Description</label>
  <textarea id="task" placeholder="Describe what you want claw to build or fix in plain English.&#10;&#10;Example: Add a /health endpoint to the Express app in src/server.js that returns JSON with uptime and version from package.json."></textarea>
  <div class="actions">
    <button id="runBtn" onclick="runTask()">▶ Run with Claw</button>
    <button id="stopBtn" onclick="stopTask()">■ Stop</button>
  </div>
  <p class="hint">Claw will work inside /workspace/projects. Changes are saved to disk immediately.</p>
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
    document.getElementById('runBtn').disabled = true;
    document.getElementById('output').textContent = 'Starting claw…';
    setStatus('running', 'Starting…');
    try {
      await fetch('/run', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({task})
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

  // Check on load whether something is already running
  startPolling();
</script>
</body>
</html>`;

const server = http.createServer((req, res) => {
  const { method, url } = req;

  if (method === 'GET' && url === '/') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    return res.end(HTML);
  }

  if (method === 'POST' && url === '/run') {
    let body = '';
    req.on('data', d => { body += d; });
    req.on('end', () => {
      try {
        const { task } = JSON.parse(body);
        if (!task || typeof task !== 'string') {
          res.writeHead(400, { 'Content-Type': 'application/json' });
          return res.end(JSON.stringify({ error: 'task string required' }));
        }
        runTask(task.trim());
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: 'invalid json' }));
      }
    });
    return;
  }

  if (method === 'GET' && url === '/output') {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end(getOutput());
  }

  if (method === 'GET' && url === '/status') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ running: isRunning() }));
  }

  if (method === 'POST' && url === '/stop') {
    stopTask();
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true }));
  }

  res.writeHead(404);
  res.end('Not found');
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`claw-runner listening on 127.0.0.1:${PORT}`);
});
