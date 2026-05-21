/**
 * llm-client.ts — LLM call layer for server-side inference (plan generation, reassessment).
 *
 * Provider resolution uses the same registry as inference-router.ts:
 * getConfiguredProviders() + PROVIDER_CONFIG from nim-catalog (priority: nvidia →
 * together → deepinfra → vultr), with Replit AI Integrations as a dev fallback.
 *
 * Token-usage accounting: when the active provider is Vultr (per-token billing) and
 * a sessionId is supplied, the prompt+completion tokens from each response are
 * atomically accumulated on the sessions row via a direct DB update.
 */

import { logger } from "../lib/logger";
import { getConfiguredProviders, PROVIDER_CONFIG, PROVIDER_TOKEN_RATES } from "./nim-catalog";

export interface LlmClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
}

export function getLlmClientConfig(overrideModel?: string): LlmClientConfig | null {
  const model = overrideModel ?? process.env["PLAN_LLM_MODEL"] ?? "meta/llama-3.3-70b-instruct";

  const configured = getConfiguredProviders();
  for (const key of ["nvidia", "together", "deepinfra", "vultr"] as const) {
    if (!configured[key]) continue;
    const info = PROVIDER_CONFIG[key];
    if (!info) continue;
    const apiKey = process.env[info.envKey];
    if (!apiKey) continue;
    return { baseUrl: info.apiBase, apiKey, model, provider: key };
  }

  const baseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  if (baseUrl && apiKey) return { baseUrl, apiKey, model, provider: "replit" };

  return null;
}

export interface LlmMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface LlmCallOptions {
  messages: LlmMessage[];
  temperature?: number;
  max_tokens?: number;
  timeoutMs?: number;
  overrideModel?: string;
  logTag?: string;
  promptVersion?: string;
  /** When set and the active provider charges per-token (e.g. Vultr), token
   *  usage from each response is atomically accumulated on this session row. */
  sessionId?: number | null;
}

export async function callLlm(opts: LlmCallOptions): Promise<string | null> {
  const cfg = getLlmClientConfig(opts.overrideModel);
  if (!cfg) {
    logger.warn({ tag: opts.logTag, promptVersion: opts.promptVersion }, "[llm-client] No LLM provider configured");
    return null;
  }

  try {
    const resp = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({
        model: cfg.model,
        temperature: opts.temperature ?? 0.3,
        max_tokens: opts.max_tokens ?? 1200,
        messages: opts.messages,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, tag: opts.logTag, promptVersion: opts.promptVersion }, "[llm-client] LLM request failed");
      return null;
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    const content = data.choices?.[0]?.message?.content?.trim() ?? null;
    logger.debug({ tag: opts.logTag, promptVersion: opts.promptVersion, hasContent: content !== null }, "[llm-client] LLM call succeeded");

    // Accumulate token usage for per-token billing providers (currently Vultr).
    // Fire-and-forget — a billing accounting failure must never block the caller.
    const tokenRate = PROVIDER_TOKEN_RATES[cfg.provider];
    if (tokenRate !== undefined && opts.sessionId != null) {
      const promptTokens  = data.usage?.prompt_tokens     ?? 0;
      const completionTokens = data.usage?.completion_tokens ?? 0;
      if (promptTokens > 0 || completionTokens > 0) {
        recordTokenUsage(opts.sessionId, promptTokens, completionTokens, cfg.provider, opts.logTag).catch(() => {});
      }
    }

    return content;
  } catch (err) {
    logger.warn({ err, tag: opts.logTag, promptVersion: opts.promptVersion }, "[llm-client] LLM call threw");
    return null;
  }
}

/**
 * Atomically add token deltas to the session's nim_tokens_in/out counters.
 * Uses a single UPDATE…RETURNING to avoid any read-modify-write race.
 */
async function recordTokenUsage(
  sessionId: number,
  promptTokens: number,
  completionTokens: number,
  provider: string,
  logTag?: string,
): Promise<void> {
  try {
    // Lazy-import to avoid circular dependency at module load time.
    const { db, sessionsTable } = await import("@workspace/db");
    const { sql, eq } = await import("drizzle-orm");

    await db
      .update(sessionsTable)
      .set({
        nimTokensIn:  sql`COALESCE(${sessionsTable.nimTokensIn},  0) + ${promptTokens}`,
        nimTokensOut: sql`COALESCE(${sessionsTable.nimTokensOut}, 0) + ${completionTokens}`,
        updatedAt: new Date(),
      })
      .where(eq(sessionsTable.id, sessionId));

    logger.debug(
      { sessionId, promptTokens, completionTokens, provider, tag: logTag },
      "[llm-client] Vultr token usage recorded",
    );
  } catch (err) {
    logger.warn({ err, sessionId, provider, tag: logTag }, "[llm-client] Failed to record token usage (non-fatal)");
  }
}
