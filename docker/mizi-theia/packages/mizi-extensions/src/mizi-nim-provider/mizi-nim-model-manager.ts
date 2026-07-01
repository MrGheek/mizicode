import { injectable, postConstruct } from "@theia/core/shared/inversify";
import { BackendApplicationContribution } from "@theia/core/lib/node/backend-application";
import { Emitter, Event } from "@theia/core/lib/common/event";
import { scoreModelsForPhase, getBestLocalModelForPhase, LOCAL_MODEL_CATALOG } from "./local-phase-models";
import { startSwarmJob, listJobs, getJob, abortJob, addSSEClient } from "./local-swarm-orchestrator";

export interface ModelInfo {
  id: string;
  name: string;
  provider: "nim" | "vllm" | "openai" | "ollama";
  contextLength: number;
  quantization?: string;
  available: boolean;
  tier?: string;
}

export interface SessionHealth {
  sessionId: number | null;
  phase: string;
  activeModel: string | null;
  activeProvider: string | null;
  modelRoutingMode: "auto" | "pinned" | null;
  tokenBudget: number;
  tokenUsed: number;
  gpuCost: number;
  status: "healthy" | "degraded" | "error";
}

export interface ScoredModelEntry {
  nimModelId: string;
  displayName: string;
  provider: string;
  latencyMs: number | null;
  score: number;
  qualityComponent: number;
  costComponent: number;
  throughputComponent: number;
  sweBenchScore: number | null;
  throughputClass: string | null;
}

export const MIZI_API_BASE = process.env.MIZI_API_BASE || "";
export const MIZI_SESSION_ID = process.env.MIZI_SESSION_ID
  ? parseInt(process.env.MIZI_SESSION_ID, 10)
  : null;
export const MIZI_OWNER_TOKEN = process.env.MIZI_OWNER_TOKEN || "";
export const NIM_API_KEY = process.env.NIM_API_KEY || "";
export const NIM_API_BASE = process.env.NIM_API_BASE || "https://integrate.api.nvidia.com/v1";
export const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL || "http://localhost:11434";

interface OllamaModelTag {
  name: string;
  modified_at: string;
  size: number;
  digest?: string;
}

interface LocalSessionState {
  phase: string;
  routingMode: "auto" | "pinned";
  modelHistory: Array<{ fromModelId: string; toModelId: string; reason: string; switchedAt: string; estimatedCost: number }>;
  ollamaBaseUrl: string;
}

function isLocalHost(url: string): boolean {
  try {
    const u = new URL(url);
    return u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "0.0.0.0";
  } catch {
    return false;
  }
}

function isLocalMode(): boolean {
  return !MIZI_API_BASE || isLocalHost(new URL(MIZI_API_BASE).hostname);
}

async function listOllamaModels(ollamaBase: string): Promise<OllamaModelTag[]> {
  try {
    const resp = await fetch(`${ollamaBase}/api/tags`);
    if (resp.ok) {
      const data = (await resp.json()) as { models: OllamaModelTag[] };
      return data.models ?? [];
    }
  } catch {
    // Ollama not running
  }
  return [];
}

async function checkOllamaHealth(ollamaBase: string): Promise<boolean> {
  try {
    const resp = await fetch(`${ollamaBase}/api/version`);
    return resp.ok;
  } catch {
    return false;
  }
}

@injectable()
export class MiziNimModelManager implements BackendApplicationContribution {
  private models: ModelInfo[] = [];
  private activeModelId: string | null = null;
  private activeProvider: string | null = null;
  private sessionId: number | null = MIZI_SESSION_ID;
  private ownerToken: string = MIZI_OWNER_TOKEN;
  private health: SessionHealth | null = null;
  private readonly onDidChangeModels = new Emitter<ModelInfo[]>();
  readonly onDidChange: Event<ModelInfo[]> = this.onDidChangeModels.event;

  private localState: LocalSessionState = {
    phase: "explore",
    routingMode: "auto",
    modelHistory: [],
    ollamaBaseUrl: OLLAMA_BASE_URL,
  };

  @postConstruct()
  protected init(): void {
    if (isLocalMode()) {
      this.refreshLocalModels().catch(() => {});
    } else {
      this.discoverSession().catch(() => {});
      this.refreshModels().catch(() => {});
    }
  }

  onStart(): void {
    if (isLocalMode()) {
      setInterval(() => this.refreshLocalModels().catch(() => {}), 120_000);
      setInterval(() => this.pollOllamaHealth().catch(() => {}), 30_000);
    } else {
      setInterval(() => this.refreshModels().catch(() => {}), 120_000);
      setInterval(() => this.refreshHealth().catch(() => {}), 30_000);
      setInterval(() => this.discoverSession().catch(() => {}), 300_000);
    }
  }

  configure(app: import("express").Application): void {
    app.get("/api/nim-models", async (_req, res) => {
      const models = await this.getModels();
      res.json(models);
    });

    app.get("/api/session/health", async (_req, res) => {
      const health = await this.getHealth();
      res.json(health);
    });

    app.get("/api/session/id", async (_req, res) => {
      const sid = await this.getSessionId();
      res.json({ sessionId: sid, ownerToken: sid ? this.ownerToken || null : null, isLocal: isLocalMode() });
    });

    app.patch("/api/session/phase", async (req, res) => {
      const { phase } = req.body as { phase?: string };
      if (!phase) { res.status(400).json({ error: "phase required" }); return; }
      const ok = await this.setPhase(phase);
      if (ok) { res.json({ ok: true, phase }); return; }
      res.status(500).json({ error: "Failed to set phase" });
    });

    app.patch("/api/session/model", async (req, res) => {
      const { modelId } = req.body as { modelId?: string };
      if (!modelId) { res.status(400).json({ error: "modelId required" }); return; }
      const ok = await this.switchModel(modelId);
      if (ok) { res.json({ ok: true, modelId }); return; }
      res.status(500).json({ error: "Failed to switch model" });
    });

    app.patch("/api/session/routing-mode", async (req, res) => {
      const { mode } = req.body as { mode?: string };
      if (mode !== "auto" && mode !== "pinned") {
        res.status(400).json({ error: 'mode must be "auto" or "pinned"' }); return;
      }
      const ok = await this.setRoutingMode(mode);
      if (ok) { res.json({ ok: true, mode }); return; }
      res.status(500).json({ error: "Failed to set routing mode" });
    });

    app.get("/api/session/inference-ranking", async (_req, res) => {
      const ranking = await this.getInferenceRanking();
      res.json(ranking);
    });

    app.get("/api/session/swarm-model", async (_req, res) => {
      const swarm = await this.getSwarmModel();
      res.json(swarm);
    });

    app.get("/api/session/model-history", async (_req, res) => {
      const history = await this.getModelHistory();
      res.json(history);
    });

    // Routing stats for local mode
    app.get("/api/session/routing-stats", async (_req, res) => {
      if (isLocalMode()) {
        res.json({
          modelSwitches: this.localState.modelHistory.length,
          phaseTransitions: 0,
          lastModelSwitch: this.localState.modelHistory.length > 0
            ? this.localState.modelHistory[this.localState.modelHistory.length - 1]!.switchedAt : null,
          lastPhaseTransition: this.localState.phase,
          autoDecisions: this.localState.modelHistory.filter((h) => h.reason === "auto_phase_switch").length,
          pinnedOverrides: this.localState.modelHistory.filter((h) => h.reason === "user_manual_switch").length,
        });
      } else {
        try {
          const resp = await fetch(`${MIZI_API_BASE}/api/session/routing-stats`);
          if (resp.ok) { const d = await resp.json(); res.json(d); return; }
        } catch { /* fall through */ }
        res.json({ modelSwitches: 0, phaseTransitions: 0, lastModelSwitch: null, lastPhaseTransition: null, autoDecisions: 0, pinnedOverrides: 0 });
      }
    });

    // Cost breakdown for local mode
    app.get("/api/session/cost-breakdown", async (_req, res) => {
      if (isLocalMode()) {
        res.json({
          totalCost: 0,
          sessionCost: 0,
          perPhase: {},
          estimatedTotalBudget: 0,
        });
      } else {
        try {
          const resp = await fetch(`${MIZI_API_BASE}/api/session/cost-breakdown`);
          if (resp.ok) { const d = await resp.json(); res.json(d); return; }
        } catch { /* fall through */ }
        res.json({ totalCost: 0, sessionCost: 0, perPhase: {}, estimatedTotalBudget: 0 });
      }
    });

    // ── Swarm routes ──────────────────────────────────────────────────────

    // Start a swarm job (local mode uses in-process orchestrator)
    app.post("/api/swarm/run", async (req, res) => {
      const { goal } = req.body as { goal?: string };
      if (!goal) { res.status(400).json({ error: "goal required" }); return; }

      if (isLocalMode()) {
        const availableIds = this.models.filter((m) => m.available).map((m) => m.id);
        const job = await startSwarmJob(goal, availableIds);
        res.json({ ok: true, jobId: job.id });
      } else if (MIZI_API_BASE) {
        try {
          const headers: Record<string, string> = { "Content-Type": "application/json" };
          if (this.ownerToken) headers["Authorization"] = `Bearer ${this.ownerToken}`;
          const resp = await fetch(`${MIZI_API_BASE}/api/swarm/run`, {
            method: "POST", headers, body: JSON.stringify({ goal }),
          });
          const data = await resp.json();
          res.status(resp.status).json(data);
        } catch (err) {
          res.status(502).json({ error: "Failed to reach API server" });
        }
      } else {
        res.status(400).json({ error: "No inference backend configured" });
      }
    });

    // List swarm jobs
    app.get("/api/swarm/jobs", async (_req, res) => {
      if (isLocalMode()) {
        res.json(listJobs());
      } else if (MIZI_API_BASE) {
        try {
          const resp = await fetch(`${MIZI_API_BASE}/api/swarm/jobs`);
          const data = await resp.json();
          res.status(resp.status).json(data);
        } catch {
          res.status(502).json({ error: "Failed to reach API server" });
        }
      } else {
        res.json([]);
      }
    });

    // Abort a swarm job
    app.post("/api/swarm/stop/:jobId", async (req, res) => {
      const { jobId } = req.params;
      if (isLocalMode()) {
        const ok = abortJob(jobId);
        if (ok) { res.json({ ok: true }); return; }
        res.status(404).json({ error: "Job not found or already completed" });
      } else if (MIZI_API_BASE) {
        try {
          const resp = await fetch(`${MIZI_API_BASE}/api/swarm/stop/${jobId}`, { method: "POST" });
          const data = await resp.json();
          res.status(resp.status).json(data);
        } catch {
          res.status(502).json({ error: "Failed to reach API server" });
        }
      } else {
        res.status(400).json({ error: "No inference backend configured" });
      }
    });

    // SSE stream for a swarm job
    app.get("/api/swarm/stream/:jobId", (req, res) => {
      const { jobId } = req.params;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      res.write(`data: ${JSON.stringify({ type: "connected", jobId })}\n\n`);

      if (isLocalMode()) {
        addSSEClient(jobId, res);
      } else {
        // In remote mode, proxy the SSE stream
        fetch(`${MIZI_API_BASE}/api/swarm/stream/${jobId}`)
          .then((upstream) => {
            const reader = upstream.body?.getReader();
            if (!reader) { res.end(); return; }
            const decoder = new TextDecoder();
            const pump = () => {
              reader.read().then(({ done, value }) => {
                if (done) { res.end(); return; }
                res.write(decoder.decode(value));
                pump();
              }).catch(() => res.end());
            };
            pump();
          })
          .catch(() => res.end());
      }
    });
  }

  private async discoverSession(): Promise<void> {
    if (!MIZI_API_BASE || this.sessionId) return;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions`, {
        headers: MIZI_OWNER_TOKEN ? { Authorization: `Bearer ${MIZI_OWNER_TOKEN}` } : {},
      });
      if (!resp.ok) return;
      const sessions = (await resp.json()) as Array<{ id: number }>;
      if (sessions.length > 0) {
        this.sessionId = sessions[0].id;
      }
    } catch {
      // Silent
    }
  }

  private async getSessionId(): Promise<number | null> {
    if (isLocalMode()) return null;
    if (this.sessionId) return this.sessionId;
    await this.discoverSession();
    return this.sessionId;
  }

  async getHealth(): Promise<SessionHealth> {
    if (isLocalMode()) {
      const ollamaOk = await checkOllamaHealth(this.localState.ollamaBaseUrl);
      return {
        sessionId: null,
        phase: this.localState.phase,
        activeModel: this.activeModelId,
        activeProvider: this.activeProvider ?? "ollama",
        modelRoutingMode: this.localState.routingMode,
        tokenBudget: 0,
        tokenUsed: 0,
        gpuCost: 0,
        status: ollamaOk ? "healthy" : "error",
      };
    }
    const sid = await this.getSessionId();
    if (sid) {
      await this.refreshHealth();
    }
    return this.health ?? {
      sessionId: sid,
      phase: "unknown",
      activeModel: this.activeModelId,
      activeProvider: this.activeProvider,
      modelRoutingMode: null,
      tokenBudget: 0,
      tokenUsed: 0,
      gpuCost: 0,
      status: "error",
    };
  }

  private async refreshHealth(): Promise<void> {
    const sid = this.sessionId;
    if (!MIZI_API_BASE || !sid) return;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}`);
      if (resp.ok) {
        const data = (await resp.json()) as Record<string, unknown>;
        const tokenBudget = Number(data.tokenBudget ?? 0);
        const tokenUsed = Number(data.tokenUsed ?? 0);
        this.health = {
          sessionId: sid,
          phase: String(data.currentPhase ?? "unknown"),
          activeModel: String(data.activeNimModelId ?? data.nimModelId ?? ""),
          activeProvider: String(data.activeNimProvider ?? ""),
          modelRoutingMode: (data.modelRoutingMode === "auto" || data.modelRoutingMode === "pinned")
            ? data.modelRoutingMode
            : null,
          tokenBudget: isNaN(tokenBudget) ? 0 : tokenBudget,
          tokenUsed: isNaN(tokenUsed) ? 0 : tokenUsed,
          gpuCost: Number(data.gpuCost ?? 0),
          status: data.status === "healthy" || data.status === "degraded" || data.status === "error"
            ? data.status
            : "degraded",
        };
        this.activeModelId = this.health.activeModel;
        this.activeProvider = this.health.activeProvider;
      }
    } catch {
      // Silent
    }
  }

  async getModels(): Promise<ModelInfo[]> {
    if (isLocalMode()) {
      if (this.models.length === 0) await this.refreshLocalModels();
      return this.models;
    }
    if (this.models.length === 0) await this.refreshModels();
    return this.models;
  }

  async getActiveModel(): Promise<string | null> {
    return this.activeModelId;
  }

  async setPhase(phase: string): Promise<boolean> {
    if (isLocalMode()) {
      const prevPhase = this.localState.phase;
      this.localState.phase = phase;
      if (this.localState.routingMode === "auto") {
        const availableIds = this.models.filter((m) => m.available).map((m) => m.id);
        const best = getBestLocalModelForPhase(phase, availableIds);
        if (best && best.modelId !== this.activeModelId) {
          const prevModel = this.activeModelId;
          this.activeModelId = best.modelId;
          this.activeProvider = "ollama";
          this.localState.modelHistory.push({
            fromModelId: prevModel ?? "",
            toModelId: best.modelId,
            reason: "auto_phase_switch",
            switchedAt: new Date().toISOString(),
            estimatedCost: 0,
          });
          this.onDidChangeModels.fire(this.models);
        }
      }
      return true;
    }
    const sid = await this.getSessionId();
    if (!sid) return false;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.ownerToken) headers["Authorization"] = `Bearer ${this.ownerToken}`;
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}/phase`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ phase }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async switchModel(modelId: string): Promise<boolean> {
    if (isLocalMode()) {
      const prevModel = this.activeModelId;
      this.activeModelId = modelId;
      this.activeProvider = "ollama";
      this.localState.modelHistory.push({
        fromModelId: prevModel ?? "",
        toModelId: modelId,
        reason: "user_manual_switch",
        switchedAt: new Date().toISOString(),
        estimatedCost: 0,
      });
      this.onDidChangeModels.fire(this.models);
      return true;
    }
    const sid = await this.getSessionId();
    if (sid) {
      try {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        if (this.ownerToken) headers["Authorization"] = `Bearer ${this.ownerToken}`;
        const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}/model`, {
          method: "PATCH",
          headers,
          body: JSON.stringify({ modelId }),
        });
        if (resp.ok) {
          this.activeModelId = modelId;
          return true;
        }
      } catch {
        // Fall through
      }
    }
    if (!MIZI_API_BASE) return false;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/session/model`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ modelId }),
      });
      if (resp.ok) {
        this.activeModelId = modelId;
        return true;
      }
    } catch {
      return false;
    }
    return false;
  }

  async setRoutingMode(mode: "auto" | "pinned"): Promise<boolean> {
    if (isLocalMode()) {
      this.localState.routingMode = mode;
      return true;
    }
    const sid = await this.getSessionId();
    if (!sid) return false;
    try {
      const headers: Record<string, string> = { "Content-Type": "application/json" };
      if (this.ownerToken) headers["Authorization"] = `Bearer ${this.ownerToken}`;
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}/routing-mode`, {
        method: "PATCH",
        headers,
        body: JSON.stringify({ mode }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  async getInferenceRanking(): Promise<{ phase: string; ranked: ScoredModelEntry[] }> {
    if (isLocalMode()) {
      const phase = this.localState.phase;
      const availableIds = this.models.filter((m) => m.available).map((m) => m.id);
      const scored = scoreModelsForPhase(phase, availableIds);
      return {
        phase,
        ranked: scored.map((m) => ({
          nimModelId: m.modelId,
          displayName: m.displayName,
          provider: "ollama",
          latencyMs: 0,
          score: m.phaseScore,
          qualityComponent: m.phaseScore * 0.8,
          costComponent: 0,
          throughputComponent: m.phaseScore * 0.2,
          sweBenchScore: null,
          throughputClass: m.tags.includes("fast") ? "high" : m.tier === "ultra-light" ? "high" : "standard",
        })),
      };
    }
    const sid = await this.getSessionId();
    if (!sid) return { phase: "unknown", ranked: [] };
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}/inference-ranking`);
      if (resp.ok) return (await resp.json()) as { phase: string; ranked: ScoredModelEntry[] };
    } catch {
      // Silent
    }
    return { phase: "unknown", ranked: [] };
  }

  async getSwarmModel(): Promise<{
    sessionId: number | null;
    phase: string;
    recommendation: { modelId: string; provider: string; latencyMs: number | null } | null;
    scored: Array<{ modelId: string; provider: string; score: number; latencyMs: number | null }>;
  }> {
    const empty = { sessionId: null, phase: "swarm", recommendation: null, scored: [] };
    if (isLocalMode()) {
      const availableIds = this.models.filter((m) => m.available).map((m) => m.id);
      const best = getBestLocalModelForPhase("swarm", availableIds);
      if (best) {
        return {
          sessionId: null,
          phase: "swarm",
          recommendation: { modelId: best.modelId, provider: "ollama", latencyMs: 0 },
          scored: [{ modelId: best.modelId, provider: "ollama", score: best.phaseScore, latencyMs: 0 }],
        };
      }
      return empty;
    }
    if (!MIZI_API_BASE) return empty;
    const sid = await this.getSessionId();
    if (!sid) return empty;
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}/swarm-model`);
      if (resp.ok) return await resp.json();
    } catch {
      // Silent
    }
    return empty;
  }

  async getModelHistory(): Promise<unknown[]> {
    if (isLocalMode()) {
      return this.localState.modelHistory.slice(-50);
    }
    if (!MIZI_API_BASE) return [];
    const sid = await this.getSessionId();
    if (!sid) return [];
    try {
      const resp = await fetch(`${MIZI_API_BASE}/api/sessions/${sid}/model-history`);
      if (resp.ok) return (await resp.json()) as unknown[];
    } catch {
      // Silent
    }
    return [];
  }

  private async refreshModels(): Promise<void> {
    if (!MIZI_API_BASE) return;
    try {
      const [modelsResp, activeResp] = await Promise.all([
        fetch(`${MIZI_API_BASE}/api/models`),
        fetch(`${MIZI_API_BASE}/api/session/model`),
      ]);
      if (modelsResp.ok) {
        const allModels = (await modelsResp.json()) as ModelInfo[];
        this.models = allModels.filter((m) => m.provider === "nim");
        this.onDidChangeModels.fire(this.models);
      }
      if (activeResp.ok) {
        const data = (await activeResp.json()) as { modelId: string };
        this.activeModelId = data.modelId;
      }
    } catch {
      // Silent
    }
  }

  private async refreshLocalModels(): Promise<void> {
    const ollamaTags = await listOllamaModels(this.localState.ollamaBaseUrl);
    const ollamaModels: ModelInfo[] = ollamaTags.map((tag) => {
      const catalogEntry = LOCAL_MODEL_CATALOG.find(
        (c) => tag.name === c.modelId || tag.name.startsWith(c.modelId + ":") || tag.name === `${c.modelId}:latest`,
      );
      return {
        id: tag.name,
        name: catalogEntry?.displayName ?? tag.name,
        provider: "ollama" as const,
        contextLength: 8192,
        available: true,
        tier: catalogEntry?.tier,
      };
    });

    // Also check local NIM
    if (NIM_API_BASE && isLocalHost(NIM_API_BASE)) {
      try {
        const nimResp = await fetch(`${NIM_API_BASE}/v1/models`);
        if (nimResp.ok) {
          const nimData = (await nimResp.json()) as { data?: Array<{ id: string; object: string }> };
          if (nimData.data) {
            for (const m of nimData.data) {
              if (!ollamaModels.some((o) => o.id === m.id)) {
                ollamaModels.push({
                  id: m.id,
                  name: m.id,
                  provider: "nim",
                  contextLength: 131072,
                  available: true,
                });
              }
            }
          }
        }
      } catch {
        // Local NIM not available
      }
    }

    if (ollamaModels.length > 0 || this.models.length === 0) {
      this.models = ollamaModels;
      if (!this.activeModelId && ollamaModels.length > 0) {
        this.activeModelId = ollamaModels[0]!.id;
        this.activeProvider = "ollama";
      }
      this.onDidChangeModels.fire(this.models);
    }
  }

  private async pollOllamaHealth(): Promise<void> {
    const ok = await checkOllamaHealth(this.localState.ollamaBaseUrl);
    if (!ok) {
      // Mark all models as unavailable if Ollama is down
      this.models = this.models.map((m) => ({ ...m, available: false }));
      this.onDidChangeModels.fire(this.models);
    } else {
      // Re-mark all as available
      const changed = this.models.some((m) => !m.available);
      if (changed) {
        this.models = this.models.map((m) => ({ ...m, available: true }));
        this.onDidChangeModels.fire(this.models);
      }
    }
  }
}
