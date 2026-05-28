/**
 * local.ts (route)
 *
 * Routes for Mizi-Local distribution:
 *   GET  /local/hardware       — hardware capability profile
 *   GET  /local/recommendations — ranked model recommendations
 *   GET  /local/ollama/models  — list locally available Ollama models
 *   POST /local/ollama/pull    — pull a model from Ollama registry
 *   DELETE /local/ollama/models/:modelId — delete a local model
 *   GET  /local/hf-models      — search HuggingFace Hub for GGUF models
 *   POST /local/hf-pull        — download HF GGUF and import into Ollama
 *   GET  /local/ollama/health  — Ollama health check
 *   GET  /local/acp/health     — ACP runner health check
 *   GET  /local/chat           — lightweight fallback chat UI (HTML)
 *   GET  /local/templates      — list available workspace templates
 */

import { Router, type Request, type Response } from "express";
import { probeHardware, clearHardwareCache } from "../services/hardware-probe.js";
import { getRecommendations, getTopRecommendation } from "../services/model-recommender.js";
import {
  checkHealth as ollamaHealth,
  listModels,
  pullModel,
  deleteModel,
} from "../services/ollama-driver.js";
import { searchHFGGUFModels, pullHFGGUFIntoOllama } from "../services/hf-model-sourcer.js";
import { checkACPHealth } from "../services/acp-local.js";
import { getHailoStatus } from "../services/hailo-backend.js";
import { WORKSPACE_TEMPLATES } from "../services/workspace-templates.js";
import { logger } from "../lib/logger.js";

const router = Router();

// GET /local/hardware
router.get("/local/hardware", (_req: Request, res: Response) => {
  try {
    const hw = probeHardware();
    const hailo = getHailoStatus(hw);
    res.json({ ...hw, hailo });
  } catch (err) {
    logger.error({ err }, "[local] hardware probe failed");
    res.status(500).json({ error: "Hardware probe failed" });
  }
});

// POST /local/hardware/refresh
router.post("/local/hardware/refresh", (_req: Request, res: Response) => {
  clearHardwareCache();
  const hw = probeHardware();
  res.json(hw);
});

// GET /local/recommendations
router.get("/local/recommendations", (_req: Request, res: Response) => {
  try {
    const hw = probeHardware();
    const recommendations = getRecommendations(hw);
    const top = getTopRecommendation(hw);
    res.json({
      hardware: {
        arch: hw.arch,
        totalRamGb: hw.totalRamGb,
        primaryBackend: hw.primaryBackend,
        gpus: hw.gpus,
        isAppleSilicon: hw.isAppleSilicon,
        hasHailo: hw.hasHailo,
        unifiedMemoryGb: hw.unifiedMemoryGb,
      },
      topRecommendation: top,
      recommendations,
    });
  } catch (err) {
    logger.error({ err }, "[local] recommendations failed");
    res.status(500).json({ error: "Recommendation engine failed" });
  }
});

// GET /local/ollama/health
router.get("/local/ollama/health", async (_req: Request, res: Response) => {
  const result = await ollamaHealth();
  res.status(result.ok ? 200 : 503).json(result);
});

// GET /local/ollama/models
router.get("/local/ollama/models", async (_req: Request, res: Response) => {
  try {
    const models = await listModels();
    res.json({ models });
  } catch (err) {
    logger.error({ err }, "[local] list models failed");
    res.status(500).json({ error: String(err) });
  }
});

// POST /local/ollama/pull
router.post("/local/ollama/pull", async (req: Request, res: Response) => {
  const { modelId } = req.body as { modelId?: string };
  if (!modelId) {
    res.status(400).json({ error: "modelId is required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    await pullModel(modelId, (status, completed, total) => {
      const data = JSON.stringify({ status, completed, total });
      res.write(`data: ${data}\n\n`);
    });
    res.write(`data: ${JSON.stringify({ status: "success", done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ status: "error", error: String(err) })}\n\n`);
  } finally {
    res.end();
  }
});

// DELETE /local/ollama/models/:modelId
router.delete("/local/ollama/models/:modelId", async (req: Request, res: Response) => {
  const modelId = String(req.params.modelId);
  try {
    await deleteModel(decodeURIComponent(modelId));
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
});

// GET /local/hf-models
router.get("/local/hf-models", async (req: Request, res: Response) => {
  const query = (req.query.q as string) || "GGUF coding";
  const hw = probeHardware();
  const budgetGb = hw.isAppleSilicon
    ? (hw.unifiedMemoryGb ?? hw.totalRamGb) * 0.7
    : hw.gpus.length > 0
    ? hw.gpus.reduce((a, g) => a + g.vramGb, 0) * 0.85
    : hw.totalRamGb * 0.6;

  try {
    const models = await searchHFGGUFModels({
      query,
      paramBudgetGb: budgetGb,
      limit: 20,
    });
    res.json({ models, budgetGb: Math.round(budgetGb * 10) / 10 });
  } catch (err) {
    logger.error({ err }, "[local] HF model search failed");
    res.status(500).json({ error: String(err) });
  }
});

// POST /local/hf-pull
router.post("/local/hf-pull", async (req: Request, res: Response) => {
  const { modelId, ggufFile } = req.body as { modelId?: string; ggufFile?: string };
  if (!modelId || !ggufFile) {
    res.status(400).json({ error: "modelId and ggufFile are required" });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.flushHeaders();

  try {
    res.write(`data: ${JSON.stringify({ status: "downloading", modelId, ggufFile })}\n\n`);
    const ollamaModelId = await pullHFGGUFIntoOllama(
      modelId,
      ggufFile,
      (downloaded, total) => {
        res.write(`data: ${JSON.stringify({ status: "progress", downloaded, total })}\n\n`);
      },
    );
    res.write(`data: ${JSON.stringify({ status: "success", ollamaModelId, done: true })}\n\n`);
  } catch (err) {
    res.write(`data: ${JSON.stringify({ status: "error", error: String(err) })}\n\n`);
  } finally {
    res.end();
  }
});

// GET /local/acp/health
router.get("/local/acp/health", async (_req: Request, res: Response) => {
  const ok = await checkACPHealth();
  res.status(ok ? 200 : 503).json({ ok });
});

// POST /local/acp/run
// Proxy an ACP task submission to the local claw runner.
// Body: { taskId, prompt, model, templateSlug?, workspaceDir?, context? }
router.post("/local/acp/run", async (req: Request, res: Response) => {
  try {
    const { submitACPTask } = await import("../services/acp-local.js");
    const result = await submitACPTask({
      taskId:      String(req.body.taskId ?? `task-${Date.now()}`),
      prompt:      String(req.body.prompt ?? ""),
      model:       String(req.body.model ?? "qwen2.5-coder:7b"),
      templateSlug: typeof req.body.templateSlug === "string" ? req.body.templateSlug : undefined,
      workspaceDir: typeof req.body.workspaceDir === "string" ? req.body.workspaceDir : undefined,
      context:     typeof req.body.context === "object" ? req.body.context as Record<string, unknown> : undefined,
    });
    res.status(202).json(result);
  } catch (err) {
    res.status(503).json({ error: "ACP runner not reachable", detail: String(err) });
  }
});

// GET /local/acp/status/:taskId
// Poll the status of a running ACP task.
router.get("/local/acp/status/:taskId", async (req: Request, res: Response) => {
  const taskId = String(req.params["taskId"] ?? "");
  if (!taskId) {
    res.status(400).json({ error: "taskId is required" });
    return;
  }
  try {
    const { getACPTaskStatus } = await import("../services/acp-local.js");
    const status = await getACPTaskStatus(taskId);
    res.json(status);
  } catch (err) {
    res.status(503).json({ error: "ACP runner not reachable", detail: String(err) });
  }
});

// POST /local/acp/abort/:taskId
// Abort a running ACP task.
router.post("/local/acp/abort/:taskId", async (req: Request, res: Response) => {
  const taskId = String(req.params["taskId"] ?? "");
  if (!taskId) {
    res.status(400).json({ error: "taskId is required" });
    return;
  }
  try {
    const { abortACPTask } = await import("../services/acp-local.js");
    await abortACPTask(taskId);
    res.json({ ok: true, taskId });
  } catch (err) {
    res.status(503).json({ error: "ACP runner not reachable", detail: String(err) });
  }
});

// GET /local/templates
router.get("/local/templates", (_req: Request, res: Response) => {
  res.json({ templates: WORKSPACE_TEMPLATES });
});

// GET /local/chat — lightweight fallback chat UI
router.get("/local/chat", (_req: Request, res: Response) => {
  const hw = probeHardware();
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(buildChatUI(hw));
});

function buildChatUI(hw: ReturnType<typeof probeHardware>): string {
  const backendLabel = hw.primaryBackend.toUpperCase();
  const ramLabel = hw.isAppleSilicon
    ? `${hw.unifiedMemoryGb ?? hw.totalRamGb} GB unified`
    : `${hw.totalRamGb} GB RAM`;

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>MIZI Local Chat</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f0f0f; color: #e0e0e0; height: 100vh; display: flex; flex-direction: column; }
    header { padding: 12px 16px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 12px; }
    .logo { font-weight: 700; font-size: 18px; color: #fff; letter-spacing: -0.5px; }
    .badge { font-size: 11px; padding: 2px 8px; border-radius: 99px; background: #2a2a2a; color: #888; }
    .hw-info { font-size: 11px; color: #666; margin-left: auto; }
    #chat { flex: 1; overflow-y: auto; padding: 16px; display: flex; flex-direction: column; gap: 12px; }
    .msg { max-width: 80%; padding: 10px 14px; border-radius: 12px; font-size: 14px; line-height: 1.5; white-space: pre-wrap; }
    .msg.user { background: #1e3a5f; align-self: flex-end; }
    .msg.assistant { background: #1a1a1a; border: 1px solid #2a2a2a; align-self: flex-start; }
    .msg.system { background: transparent; border: 1px solid #2a2a2a; color: #666; font-size: 12px; align-self: center; text-align: center; }
    footer { padding: 12px 16px; background: #1a1a1a; border-top: 1px solid #2a2a2a; }
    .input-row { display: flex; gap: 8px; }
    #model-select { background: #2a2a2a; color: #e0e0e0; border: 1px solid #3a3a3a; border-radius: 8px; padding: 8px 10px; font-size: 13px; flex: 0 0 200px; }
    #prompt { flex: 1; background: #2a2a2a; color: #e0e0e0; border: 1px solid #3a3a3a; border-radius: 8px; padding: 8px 12px; font-size: 14px; resize: none; min-height: 40px; max-height: 120px; }
    #send-btn { background: #2563eb; color: #fff; border: none; border-radius: 8px; padding: 8px 18px; font-size: 14px; cursor: pointer; font-weight: 600; }
    #send-btn:disabled { opacity: 0.5; cursor: not-allowed; }
    #send-btn:hover:not(:disabled) { background: #1d4ed8; }
    .spinner { display: inline-block; width: 14px; height: 14px; border: 2px solid #888; border-top-color: transparent; border-radius: 50%; animation: spin 0.8s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
  </style>
</head>
<body>
  <header>
    <span class="logo">MIZI</span>
    <span class="badge">Local</span>
    <span class="badge">${backendLabel}</span>
    <span class="hw-info">${hw.cpuCores} cores · ${ramLabel}</span>
  </header>
  <div id="chat">
    <div class="msg system">MIZI Local Chat — powered by Ollama · ${backendLabel} backend</div>
  </div>
  <footer>
    <div class="input-row">
      <select id="model-select"><option value="">Loading models…</option></select>
      <textarea id="prompt" placeholder="Ask MIZI anything…" rows="1"></textarea>
      <button id="send-btn">Send</button>
    </div>
  </footer>
  <script>
    const chat = document.getElementById('chat');
    const promptEl = document.getElementById('prompt');
    const sendBtn = document.getElementById('send-btn');
    const modelSelect = document.getElementById('model-select');
    const API_BASE = window.location.origin;

    async function loadModels() {
      try {
        const res = await fetch(API_BASE + '/api/local/ollama/models');
        const { models } = await res.json();
        modelSelect.innerHTML = models.length
          ? models.map(m => '<option value="' + m.name + '">' + m.name + '</option>').join('')
          : '<option value="">No models — pull one first</option>';
      } catch {
        modelSelect.innerHTML = '<option value="">Ollama offline</option>';
      }
    }

    function appendMsg(role, text) {
      const div = document.createElement('div');
      div.className = 'msg ' + role;
      div.textContent = text;
      chat.appendChild(div);
      chat.scrollTop = chat.scrollHeight;
      return div;
    }

    async function sendMessage() {
      const model = modelSelect.value;
      const prompt = promptEl.value.trim();
      if (!model || !prompt) return;

      promptEl.value = '';
      promptEl.style.height = 'auto';
      sendBtn.disabled = true;
      appendMsg('user', prompt);

      const assistantDiv = appendMsg('assistant', '');
      const spinnerSpan = document.createElement('span');
      spinnerSpan.className = 'spinner';
      assistantDiv.appendChild(spinnerSpan);

      try {
        const res = await fetch(API_BASE + '/api/local/ollama/chat', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: true
          })
        });

        if (!res.body) throw new Error('No stream');
        assistantDiv.textContent = '';

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          const lines = buf.split('\\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            if (!line.startsWith('data: ')) continue;
            try {
              const evt = JSON.parse(line.slice(6));
              if (evt.message?.content) assistantDiv.textContent += evt.message.content;
            } catch {}
          }
          chat.scrollTop = chat.scrollHeight;
        }
      } catch (err) {
        assistantDiv.textContent = 'Error: ' + err.message;
      } finally {
        sendBtn.disabled = false;
        promptEl.focus();
      }
    }

    sendBtn.addEventListener('click', sendMessage);
    promptEl.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendMessage(); }
    });
    promptEl.addEventListener('input', () => {
      promptEl.style.height = 'auto';
      promptEl.style.height = Math.min(promptEl.scrollHeight, 120) + 'px';
    });

    loadModels();
  </script>
</body>
</html>`;
}

// POST /local/ollama/chat — streaming chat completions for fallback UI
router.post("/local/ollama/chat", async (req: Request, res: Response) => {
  const { model, messages, stream = true } = req.body as {
    model: string;
    messages: Array<{ role: string; content: string }>;
    stream?: boolean;
  };

  const ollamaRes = await fetch(`${process.env.OLLAMA_BASE_URL || "http://localhost:11434"}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream }),
  });

  if (!ollamaRes.ok) {
    res.status(ollamaRes.status).json({ error: await ollamaRes.text() });
    return;
  }

  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");

  if (!ollamaRes.body) {
    res.end();
    return;
  }

  const reader = ollamaRes.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = decoder.decode(value, { stream: true });
      for (const line of chunk.split("\n")) {
        if (line.trim()) {
          res.write(`data: ${line}\n\n`);
        }
      }
    }
  } finally {
    res.end();
  }
});

export default router;
