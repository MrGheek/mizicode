/**
 * local.ts
 *
 * Local session provider for Mizi-Local distribution.
 * When MIZI_DISTRIBUTION=local, sessions use this provider instead of
 * Vast.ai or Fly.io. The host machine IS the workspace — no remote
 * provisioning occurs.
 */

import { logger } from "../lib/logger.js";
import { probeHardware } from "./hardware-probe.js";
import { checkHealth, tryAutoStartOllama } from "./ollama-driver.js";

export interface LocalSessionConfig {
  sessionId: number;
  modelId: string;
  workspaceDir?: string;
  templateSlug?: string;
}

export interface LocalSessionResult {
  status: "ready";
  provider: "local";
  ollamaEndpoint: string;
  workspaceDir: string;
  localChatUrl: string;
}

const OLLAMA_ENDPOINT = process.env.OLLAMA_BASE_URL || "http://localhost:11434";
const LOCAL_WORKSPACE_ROOT =
  process.env.MIZI_LOCAL_WORKSPACE || `${process.env.HOME || "/tmp"}/.mizi/workspace`;
const LOCAL_CHAT_PATH = "/api/local/chat";

export async function ensureOllamaRunning(): Promise<boolean> {
  const health = await checkHealth();
  if (health.ok) {
    logger.info({ version: health.version }, "[local] Ollama is running");
    return true;
  }

  logger.info("[local] Ollama not responding — attempting auto-start...");
  const hw = probeHardware();
  const started = tryAutoStartOllama(hw);
  if (!started) return false;

  // Wait up to 10 s for Ollama to come up
  for (let i = 0; i < 20; i++) {
    await new Promise((r) => setTimeout(r, 500));
    const h2 = await checkHealth();
    if (h2.ok) {
      logger.info("[local] Ollama started successfully");
      return true;
    }
  }

  logger.error("[local] Ollama did not start within 10 seconds");
  return false;
}

export async function startLocalSession(
  config: LocalSessionConfig,
): Promise<LocalSessionResult> {
  logger.info({ sessionId: config.sessionId, model: config.modelId }, "[local] Starting local session");

  const ollamaReady = await ensureOllamaRunning();
  if (!ollamaReady) {
    throw new Error(
      "Ollama is not running and could not be started. " +
      "Install Ollama from https://ollama.com and ensure it is in your PATH, " +
      "then retry."
    );
  }

  const workspaceDir = config.workspaceDir ?? `${LOCAL_WORKSPACE_ROOT}/session-${config.sessionId}`;

  // ── ACP task registration ─────────────────────────────────────────────────
  // Register the session with the local ACP (Agent Communication Protocol) runner
  // so that HuggingClaw task dispatch goes through the ACP HTTP path instead of
  // the legacy cloud WebSocket bridge.  Non-blocking: if the ACP runner hasn't
  // started yet the session remains usable via the direct Ollama fallback chat
  // at LOCAL_CHAT_PATH.  The ACP runner is started by mizi-local-start.sh before
  // the API server, so the connection should succeed in normal operation.
  void (async () => {
    try {
      const { submitACPTask } = await import("./acp-local.js");
      await submitACPTask({
        taskId: `session-${config.sessionId}`,
        prompt: "Session ready — awaiting user intent",
        model: config.modelId,
        templateSlug: config.templateSlug,
        workspaceDir,
        context: {
          provider: "local",
          ollamaEndpoint: OLLAMA_ENDPOINT,
          templateSlug: config.templateSlug ?? null,
        },
      });
      logger.info({ sessionId: config.sessionId }, "[local] ACP task registered successfully");
    } catch (acpErr) {
      // ACP runner not available — local Ollama fallback chat still works
      logger.debug({ err: acpErr }, "[local] ACP task registration skipped (runner not reachable)");
    }
  })();

  return {
    status: "ready",
    provider: "local",
    ollamaEndpoint: OLLAMA_ENDPOINT,
    workspaceDir,
    localChatUrl: LOCAL_CHAT_PATH,
  };
}

export function isLocalDistribution(): boolean {
  return process.env.MIZI_DISTRIBUTION === "local";
}

/**
 * Create a local session record in SQLite.
 * This is used by the /sessions route when provider=local (MIZI_DISTRIBUTION=local).
 * Returns an id that the dashboard can poll or use to open the fallback chat.
 */
export async function createLocalSessionRecord(opts: {
  modelId: string;
  intentText?: string | null;
  templateSlug?: string | null;
  repoUrl?: string | null;
}): Promise<{ id: number; provider: "local"; status: string; ollamaEndpoint: string; localChatUrl: string }> {
  const { default: Database } = await import("better-sqlite3");
  const path = await import("path");
  const os = await import("os");

  const LOCAL_DB_DIR = process.env.MIZI_LOCAL_DB_DIR || path.join(os.homedir(), ".mizi");
  const LOCAL_DB_PATH = process.env.MIZI_LOCAL_DB_PATH || path.join(LOCAL_DB_DIR, "local.db");

  const db = new Database(LOCAL_DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");

  try {
    const result = db.prepare(
      `INSERT INTO sessions (provider, status, status_message, model_id, intent_text, template_slug, repo_url)
       VALUES ('local', 'ready', 'Local session ready', ?, ?, ?, ?)`
    ).run(opts.modelId, opts.intentText ?? null, opts.templateSlug ?? null, opts.repoUrl ?? null);

    const id = result.lastInsertRowid as number;
    logger.info({ sessionId: id, model: opts.modelId }, "[local] Created local session record");

    return {
      id,
      provider: "local",
      status: "ready",
      ollamaEndpoint: process.env.OLLAMA_BASE_URL || "http://localhost:11434",
      localChatUrl: LOCAL_CHAT_PATH,
    };
  } finally {
    db.close();
  }
}
