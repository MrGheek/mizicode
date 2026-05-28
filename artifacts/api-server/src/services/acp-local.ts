/**
 * acp-local.ts
 *
 * ACP (Agent Communication Protocol) adapter for Mizi-Local sessions.
 * Replaces the legacy WebSocket bridge used in cloud sessions.
 *
 * ACP is a simple HTTP-based request/response protocol used by HuggingClaw
 * for claw agent invocations. In local mode, the claw runner listens on
 * an ACP endpoint (POST /acp/run) and the API server dispatches tasks to it.
 *
 * Protocol:
 *   POST /acp/run  — submit a task to the local claw runner
 *   GET  /acp/status/:id — poll task status
 *   POST /acp/abort/:id  — abort a running task
 *
 * The claw runner in local mode must have ACP_MODE=true and listen on
 * ACP_PORT (default 5185).
 */

import { logger } from "../lib/logger.js";

const ACP_BASE = process.env.ACP_BASE_URL || `http://localhost:${process.env.ACP_PORT || "5185"}`;

export interface ACPTaskRequest {
  taskId: string;
  prompt: string;
  model: string;
  templateSlug?: string;
  workspaceDir?: string;
  context?: Record<string, unknown>;
}

export interface ACPTaskStatus {
  taskId: string;
  phase: "queued" | "running" | "done" | "error" | "aborted";
  progress?: number;
  output?: string;
  error?: string;
  startedAt?: string;
  completedAt?: string;
}

async function acpFetch<T>(
  path: string,
  opts: RequestInit = {},
  timeoutMs = 10000,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${ACP_BASE}${path}`, {
      ...opts,
      signal: controller.signal,
      headers: {
        "Content-Type": "application/json",
        ...(opts.headers as Record<string, string>),
      },
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`ACP ${path} → HTTP ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

export async function submitACPTask(req: ACPTaskRequest): Promise<{ taskId: string }> {
  logger.info({ taskId: req.taskId, model: req.model }, "[acp-local] Submitting task");
  return acpFetch<{ taskId: string }>("/acp/run", {
    method: "POST",
    body: JSON.stringify(req),
  }, 30000);
}

export async function getACPTaskStatus(taskId: string): Promise<ACPTaskStatus> {
  return acpFetch<ACPTaskStatus>(`/acp/status/${taskId}`, {}, 5000);
}

export async function abortACPTask(taskId: string): Promise<void> {
  await acpFetch<void>(`/acp/abort/${taskId}`, { method: "POST" }, 5000);
  logger.info({ taskId }, "[acp-local] Task aborted");
}

export async function checkACPHealth(): Promise<boolean> {
  try {
    await acpFetch<unknown>("/acp/health", {}, 2000);
    return true;
  } catch {
    return false;
  }
}

/**
 * Submit a task and poll until completion (or timeout).
 * Returns the final task output.
 */
export async function runACPTaskSync(
  req: ACPTaskRequest,
  options: { pollIntervalMs?: number; timeoutMs?: number } = {},
): Promise<string> {
  const { pollIntervalMs = 1000, timeoutMs = 5 * 60 * 1000 } = options;
  const { taskId } = await submitACPTask(req);

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await getACPTaskStatus(taskId);
    if (status.phase === "done") return status.output ?? "";
    if (status.phase === "error") throw new Error(`ACP task failed: ${status.error}`);
    if (status.phase === "aborted") throw new Error("ACP task was aborted");
    await new Promise((r) => setTimeout(r, pollIntervalMs));
  }

  await abortACPTask(taskId).catch(() => {});
  throw new Error(`ACP task ${taskId} timed out after ${timeoutMs}ms`);
}
