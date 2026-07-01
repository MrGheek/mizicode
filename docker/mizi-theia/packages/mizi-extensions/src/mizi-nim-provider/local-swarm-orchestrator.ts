import { Response } from "express";
import { OLLAMA_BASE_URL } from "./mizi-nim-model-manager";
import { getBestLocalModelForPhase, LOCAL_MODEL_CATALOG } from "./local-phase-models";

export interface SwarmJob {
  id: string;
  goal: string;
  status: "pending" | "running" | "completed" | "failed" | "aborted";
  createdAt: string;
  completedAt?: string;
  subtasks: SwarmSubtask[];
  result?: string;
  error?: string;
}

export interface SwarmSubtask {
  id: string;
  title: string;
  status: "pending" | "running" | "completed" | "failed";
  modelId: string;
  result?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

interface SwarmEvent {
  type: "job_created" | "subtask_started" | "subtask_completed" | "subtask_failed" | "job_completed" | "job_failed" | "job_aborted";
  jobId: string;
  data: unknown;
  timestamp: string;
}

const jobs = new Map<string, SwarmJob>();
const sseClients = new Map<string, Set<Response>>();
let jobCounter = 0;

function broadcast(jobId: string, event: SwarmEvent): void {
  const clients = sseClients.get(jobId);
  if (!clients) return;
  const msg = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) {
    try { res.write(msg); } catch { clients.delete(res); }
  }
}

function broadcastAll(event: SwarmEvent): void {
  for (const [jid] of sseClients) {
    broadcast(jid, event);
  }
}

const DECOMPOSITION_MAX_RETRIES = 2;

function buildDecompositionPrompt(errorFeedback?: string): string {
  const examples = `Example:
[
  {"title": "Analyze requirements", "prompt": "Review the goal and list all functional requirements, constraints, and acceptance criteria. Identify key stakeholders and dependencies."},
  {"title": "Research approaches", "prompt": "Research 2-3 technical approaches for solving this problem. Compare trade-offs in complexity, performance, and maintainability."},
  {"title": "Implement solution", "prompt": "Implement the chosen solution. Write clean, well-documented code with appropriate error handling and tests."}
]`;

  const base = `You are a task decomposition assistant. Break down the following goal into 3-5 concrete subtasks.

Return ONLY a JSON array of objects, each with:
- "title": short subtask name (max 60 chars)
- "prompt": instructions for an AI agent to complete this subtask (2-3 sentences)

${examples}`;

  if (errorFeedback) {
    return `${base}

IMPORTANT FEEDBACK FROM PREVIOUS ATTEMPT:
${errorFeedback}

Please fix the JSON format and try again. Ensure the response is a valid JSON array.`;
  }

  return base;
}

function tryParseDecomposition(text: string): Array<{ title: string; prompt: string }> | null {
  const jsonStr = text.match(/\[[\s\S]*\]/)?.[0];
  if (!jsonStr) return null;
  try {
    const parsed = JSON.parse(jsonStr);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    const result: Array<{ title: string; prompt: string }> = [];
    for (const entry of parsed) {
      if (typeof entry !== "object" || entry === null) continue;
      const title = String(entry["title"] ?? "").trim();
      const prompt = String(entry["prompt"] ?? "").trim();
      if (title && prompt) result.push({ title, prompt });
    }
    return result.length > 0 ? result : null;
  } catch {
    return null;
  }
}

async function callOllamaForDecomposition(goal: string, ollamaBase: string): Promise<Array<{ title: string; prompt: string }>> {
  for (let attempt = 0; attempt <= DECOMPOSITION_MAX_RETRIES; attempt++) {
    const errorFeedback = attempt > 0 ? `Previous response was not valid JSON. Got: (see raw output above). Ensure the response is ONLY a JSON array with no extra text.` : undefined;
    const systemPrompt = buildDecompositionPrompt(errorFeedback);

    try {
      const resp = await fetch(`${ollamaBase}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: "qwen2.5-coder:7b",
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: goal },
          ],
          stream: false,
          options: { temperature: 0.2, num_predict: 2000 },
        }),
      });

      if (!resp.ok) continue;

      const data = (await resp.json()) as { message?: { content?: string } };
      const text = data.message?.content ?? "";
      const parsed = tryParseDecomposition(text);
      if (parsed) return parsed.slice(0, 5);
    } catch {
      continue;
    }
  }

  return [{
    title: "Process goal",
    prompt: `Work through this goal step by step: ${goal}`,
  }];
}

async function runWorker(
  subtask: SwarmSubtask,
  ollamaBase: string,
  jobId: string,
  abortSignal: AbortSignal,
): Promise<void> {
  subtask.status = "running";
  subtask.startedAt = new Date().toISOString();
  broadcast(jobId, {
    type: "subtask_started", jobId,
    data: { subtaskId: subtask.id, title: subtask.title, modelId: subtask.modelId },
    timestamp: subtask.startedAt,
  });

  try {
    const resp = await fetch(`${ollamaBase}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: abortSignal,
      body: JSON.stringify({
        model: subtask.modelId,
        messages: [
          { role: "system", content: "You are a helpful AI assistant completing a subtask. Provide thorough, well-reasoned output." },
          { role: "user", content: subtask.title },
        ],
        stream: false,
        options: { temperature: 0.3, num_predict: 4000 },
      }),
    });

    if (!resp.ok) throw new Error(`Worker error ${resp.status}`);
    const data = (await resp.json()) as { message?: { content?: string } };

    subtask.status = "completed";
    subtask.result = data.message?.content ?? "";
    subtask.completedAt = new Date().toISOString();
    broadcast(jobId, {
      type: "subtask_completed", jobId,
      data: { subtaskId: subtask.id, title: subtask.title, resultLength: subtask.result.length },
      timestamp: subtask.completedAt,
    });
  } catch (err) {
    if (abortSignal.aborted) {
      subtask.status = "failed";
      subtask.error = "Aborted";
      return;
    }
    subtask.status = "failed";
    subtask.error = err instanceof Error ? err.message : String(err);
    subtask.completedAt = new Date().toISOString();
    broadcast(jobId, {
      type: "subtask_failed", jobId,
      data: { subtaskId: subtask.id, title: subtask.title, error: subtask.error },
      timestamp: subtask.completedAt,
    });
  }
}

async function executeJob(job: SwarmJob, ollamaBase: string, availableModels: string[]): Promise<void> {
  const abortController = new AbortController();
  const abortKey = `swarm-abort-${job.id}`;
  (globalThis as Record<string, unknown>)[abortKey] = abortController;

  try {
    job.status = "running";

    // Decompose goal into subtasks
    const decomposition = await callOllamaForDecomposition(job.goal, ollamaBase);

    const swarmModel = getBestLocalModelForPhase("swarm", availableModels);
    const defaultModelId = swarmModel?.modelId ?? "qwen2.5-coder:7b";

    // Pick per-subtask model based on content keywords
    const codingKeywords = /code|implement|write|build|develop|program|script|function/i;
    const researchKeywords = /research|analyze|investigate|review|understand|learn|explore/i;
    const balancedModel = getBestLocalModelForPhase("implement", availableModels)?.modelId ?? defaultModelId;
    const qualityModel = getBestLocalModelForPhase("plan", availableModels)?.modelId ?? defaultModelId;

    job.subtasks = decomposition.map((d, i) => {
      let modelId = defaultModelId;
      if (codingKeywords.test(d.title) || codingKeywords.test(d.prompt)) {
        modelId = balancedModel;
      } else if (researchKeywords.test(d.title) || researchKeywords.test(d.prompt)) {
        modelId = qualityModel;
      }
      return {
        id: `${job.id}-sub-${i}`,
        title: d.title,
        status: "pending" as const,
        modelId,
      };
    });

    // Execute subtasks sequentially
    for (const subtask of job.subtasks) {
      if (abortController.signal.aborted) break;
      await runWorker(subtask, ollamaBase, job.id, abortController.signal);
    }

    const allDone = job.subtasks.every((s) => s.status === "completed");
    if (abortController.signal.aborted) {
      job.status = "aborted";
      broadcast(job.id, { type: "job_aborted", jobId: job.id, data: {}, timestamp: new Date().toISOString() });
    } else if (allDone) {
      job.status = "completed";
      job.result = job.subtasks.map((s) => `## ${s.title}\n\n${s.result}`).join("\n\n---\n\n");
      job.completedAt = new Date().toISOString();
      broadcast(job.id, { type: "job_completed", jobId: job.id, data: { subtaskCount: job.subtasks.length }, timestamp: job.completedAt });
    } else {
      job.status = "failed";
      job.error = "Some subtasks failed";
      job.completedAt = new Date().toISOString();
      broadcast(job.id, { type: "job_failed", jobId: job.id, data: { error: job.error }, timestamp: job.completedAt });
    }
  } catch (err) {
    job.status = "failed";
    job.error = err instanceof Error ? err.message : String(err);
    job.completedAt = new Date().toISOString();
    broadcast(job.id, { type: "job_failed", jobId: job.id, data: { error: job.error }, timestamp: job.completedAt });
  } finally {
    delete (globalThis as Record<string, unknown>)[abortKey];
  }
}

export function listJobs(): SwarmJob[] {
  return Array.from(jobs.values()).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
}

export function getJob(jobId: string): SwarmJob | undefined {
  return jobs.get(jobId);
}

export function abortJob(jobId: string): boolean {
  const job = jobs.get(jobId);
  if (!job || job.status === "completed" || job.status === "aborted") return false;
  const abortKey = `swarm-abort-${jobId}`;
  const abortController = (globalThis as Record<string, unknown>)[abortKey] as AbortController | undefined;
  abortController?.abort();
  return true;
}

export function addSSEClient(jobId: string, res: Response): void {
  if (!sseClients.has(jobId)) sseClients.set(jobId, new Set());
  sseClients.get(jobId)!.add(res);
  res.on("close", () => {
    sseClients.get(jobId)?.delete(res);
  });
}

export async function startSwarmJob(goal: string, availableModels: string[]): Promise<SwarmJob> {
  const ollamaBase = OLLAMA_BASE_URL;
  const id = `swarm-${++jobCounter}-${Date.now()}`;
  const job: SwarmJob = {
    id,
    goal,
    status: "pending",
    createdAt: new Date().toISOString(),
    subtasks: [],
  };
  jobs.set(id, job);

  broadcastAll({
    type: "job_created", jobId: id,
    data: { goal },
    timestamp: job.createdAt,
  });

  executeJob(job, ollamaBase, availableModels).catch(() => {});

  return job;
}
