#!/usr/bin/env node
/**
 * acp-runner.mjs — Local ACP (Agent Communication Protocol) runner
 *
 * A lightweight HTTP server that bridges the ACP protocol used by Mizi-Local
 * to the local Ollama instance. Replaces the legacy cloud WebSocket bridge
 * for local claw invocations.
 *
 * Protocol:
 *   POST /acp/run              → submit a task; returns { taskId }
 *   GET  /acp/status/:taskId   → poll task phase + output
 *   POST /acp/abort/:taskId    → abort a running task
 *   GET  /acp/health           → liveness probe
 *
 * Environment:
 *   ACP_PORT          (default 5185)
 *   OLLAMA_BASE_URL   (default http://localhost:11434)
 *
 * Started by mizi-local-start.sh before the API server.
 */

import http from "http";

const PORT = parseInt(process.env.ACP_PORT ?? "5185", 10);
const OLLAMA = process.env.OLLAMA_BASE_URL ?? "http://localhost:11434";

/** In-memory task store (process-local, reset on restart) */
const tasks = new Map(); // taskId → { phase, prompt, model, output, error, startedAt, completedAt, aborted }

function taskId() {
  return `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function streamOllama(task) {
  const { prompt, model, templateSlug, workspaceDir, context } = task;

  let systemPrompt = "You are a helpful AI coding assistant running on the user's local machine.";
  if (templateSlug) systemPrompt += ` Active workspace template: ${templateSlug}.`;
  if (workspaceDir) systemPrompt += ` Working directory: ${workspaceDir}.`;

  const body = JSON.stringify({
    model,
    prompt,
    system: systemPrompt,
    stream: true,
    options: { temperature: 0.2 },
    ...(context?.ollamaOptions ?? {}),
  });

  let output = "";
  try {
    const res = await fetch(`${OLLAMA}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });

    if (!res.ok) throw new Error(`Ollama HTTP ${res.status}`);

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (task.aborted) {
        await reader.cancel().catch(() => {});
        task.phase = "aborted";
        task.completedAt = new Date().toISOString();
        return;
      }
      const chunk = dec.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.response) output += obj.response;
          if (obj.done) break;
        } catch {
          // skip malformed JSON lines
        }
      }
    }
    task.output = output;
    task.phase = "done";
    task.completedAt = new Date().toISOString();
  } catch (err) {
    task.error = String(err);
    task.phase = "error";
    task.completedAt = new Date().toISOString();
    console.error(`[acp-runner] Task ${task.id} failed:`, err);
  }
}

function jsonBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", c => { data += c; });
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); }
      catch (e) { reject(e); }
    });
    req.on("error", reject);
  });
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) });
  res.end(payload);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;
  const method = req.method;

  try {
    // GET /acp/health
    if (method === "GET" && path === "/acp/health") {
      send(res, 200, { ok: true, ollama: OLLAMA, tasks: tasks.size });
      return;
    }

    // POST /acp/run
    if (method === "POST" && path === "/acp/run") {
      const body = await jsonBody(req);
      const id = body.taskId ?? taskId();
      const task = {
        id,
        phase: "queued",
        prompt: String(body.prompt ?? ""),
        model: String(body.model ?? "qwen2.5-coder:7b"),
        templateSlug: body.templateSlug ?? null,
        workspaceDir: body.workspaceDir ?? null,
        context: body.context ?? {},
        output: null,
        error: null,
        aborted: false,
        startedAt: new Date().toISOString(),
        completedAt: null,
      };
      tasks.set(id, task);
      task.phase = "running";
      // Fire-and-forget: stream Ollama response in background
      streamOllama(task);
      send(res, 202, { taskId: id });
      return;
    }

    // GET /acp/status/:taskId
    const statusMatch = path.match(/^\/acp\/status\/([^/]+)$/);
    if (method === "GET" && statusMatch) {
      const task = tasks.get(statusMatch[1]);
      if (!task) { send(res, 404, { error: "Task not found" }); return; }
      send(res, 200, {
        taskId: task.id,
        phase: task.phase,
        output: task.output ?? undefined,
        error: task.error ?? undefined,
        startedAt: task.startedAt,
        completedAt: task.completedAt ?? undefined,
      });
      return;
    }

    // POST /acp/abort/:taskId
    const abortMatch = path.match(/^\/acp\/abort\/([^/]+)$/);
    if (method === "POST" && abortMatch) {
      const task = tasks.get(abortMatch[1]);
      if (!task) { send(res, 404, { error: "Task not found" }); return; }
      task.aborted = true;
      if (task.phase === "queued" || task.phase === "running") {
        task.phase = "aborted";
        task.completedAt = new Date().toISOString();
      }
      send(res, 200, { ok: true, taskId: task.id });
      return;
    }

    send(res, 404, { error: "Not found" });
  } catch (err) {
    console.error("[acp-runner] Unhandled error:", err);
    send(res, 500, { error: String(err) });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[acp-runner] Local ACP runner listening on http://127.0.0.1:${PORT}`);
  console.log(`[acp-runner] Proxying to Ollama at ${OLLAMA}`);
});

process.on("SIGTERM", () => { server.close(); process.exit(0); });
process.on("SIGINT",  () => { server.close(); process.exit(0); });
