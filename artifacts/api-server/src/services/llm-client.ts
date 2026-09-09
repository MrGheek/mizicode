/**
 * llm-client.ts — LLM call layer for server-side inference (plan generation, reassessment).
 *
 * Provider resolution uses the same registry as inference-router.ts:
 * getConfiguredProviders() + PROVIDER_CONFIG from nim-catalog (priority: nvidia →
 * together → deepinfra → vultr), with Replit AI Integrations as a dev fallback.
 *
 * RFC 0001 integration:
 * - Decide layer: task-class routing (cheap → local Ollama / hosted small).
 * - Cache/Avoid layer: byte-identical prompt results are served from the TTL
 *   budget cache without a provider call (budget.cacheable path).
 * - Cap layer: per-task output ceilings + per-session tripwires.
 * - Universal ledger: every provider's usage/cost is recorded in
 *   token-accounting; the legacy Vultr DB write is preserved when per-token
 *   billing applies to a session.
 */

import { logger } from "../lib/logger";
import { getConfiguredProviders, PROVIDER_CONFIG, PROVIDER_TOKEN_RATES } from "./nim-catalog";
import { LOCAL_OLLAMA_MODEL_IDS } from "./inference-router";
import {
  budgetCacheKey,
  cacheResult,
  estimateMessageTokens,
  resolveTokenDecision,
  TASK_MAX_OUTPUT_TOKENS,
  type BudgetTaskClass,
} from "./token-budget";
import { recordSaving, recordSpend } from "./token-accounting";
import type { TokenMode } from "./skills-types";

export interface LlmClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  provider: string;
}

/**
 * Cheap-task model fallback.
 *
 * Hosted small model (OpenAI-compatible NIM path). When the local Ollama daemon
 * is a live peer (RFC 0001 Layer 3 — cheapest adequate model), cheap tasks
 * prefer a local coder model instead and pay no per-token cost at all.
 */
const CHEAP_HOSTED_MODEL = "meta/llama-3.1-8b-instruct";
const CHEAP_LOCAL_MODEL = "qwen2.5-coder:7b";

const DEFAULT_OLLAMA_ROOT = "http://localhost:11434";

function ollamaRoot(): string {
  return (process.env["OLLAMA_BASE_URL"] || DEFAULT_OLLAMA_ROOT).replace(/\/+$/, "");
}

/** True when the configured Ollama points at the hosted cloud, not a local daemon. */
function isOllamaCloud(): boolean {
  return (process.env["OLLAMA_BASE_URL"] ?? "").includes("ollama.com");
}

/** True when a model id is one of the routed-local Ollama candidates. */
export function isLocalOllamaModelId(model: string): boolean {
  return LOCAL_OLLAMA_MODEL_IDS.has(model);
}

/** OpenAI-compatible config for the local Ollama daemon. */
export function getLocalOllamaClientConfig(model: string): LlmClientConfig {
  return { baseUrl: `${ollamaRoot()}/v1`, apiKey: "ollama", model, provider: "ollama-local" };
}

// Liveness probe cache — probing the daemon on every call would add latency to
// every LLM path; a 30s TTL keeps the cheap-task routing honest without cost.
let localLiveCache: boolean | null = null;
let localProbedAt = 0;
const LOCAL_LIVE_TTL_MS = 30_000;

async function probeLocalOllamaLive(): Promise<boolean> {
  // Ollama Cloud is a hosted remote, not a local daemon peer — never probe.
  if (isOllamaCloud()) return false;
  const now = Date.now();
  if (localLiveCache !== null && now - localProbedAt < LOCAL_LIVE_TTL_MS) return localLiveCache;
  try {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 1500);
    const resp = await fetch(`${ollamaRoot()}/api/tags`, { signal: controller.signal });
    clearTimeout(tid);
    localLiveCache = resp.ok;
  } catch {
    localLiveCache = false;
  }
  localProbedAt = Date.now();
  return localLiveCache;
}

/** Test-only seam: clears the local-daemon liveness probe cache. */
export function _resetLocalOllamaProbe(): void {
  localLiveCache = null;
  localProbedAt = 0;
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

  // Ollama Cloud (hosted remote — distinct from the local daemon peers).
  // https://ollama.com/v1 is OpenAI-compatible; the same OLLAMA_API_KEY works.
  const ollamaKey = process.env["OLLAMA_API_KEY"];
  if (ollamaKey && process.env["OLLAMA_BASE_URL"]?.includes("ollama.com")) {
    return { baseUrl: "https://ollama.com/v1", apiKey: ollamaKey, model, provider: "ollama-cloud" };
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

/**
 * Rough cost-class of the task (RFC 0001 Layer 3 — cheapest adequate model).
 * - `quality`: quality-first, hosted frontier default (existing behavior).
 * - `cheap`:   prefer a local Ollama model when the daemon is a live peer;
 *              otherwise fall back to a hosted small model.
 */
export type TaskClass = "cheap" | "quality";

export interface LlmCallOptions {
  messages: LlmMessage[];
  temperature?: number;
  max_tokens?: number;
  timeoutMs?: number;
  overrideModel?: string;
  /** When set, overrides the model chosen through {@link taskClass} routing. */
  taskClass?: TaskClass;
  /**
   * RFC 0001 budget layers for this call: enables the byte-identical prompt
   * result cache (Avoid/Cache) and per-task output ceiling + tripwire gate
   * (Cap), and attributes usage to the universal ledger.
   */
  budget?: {
    taskClass: BudgetTaskClass;
    tokenMode?: TokenMode;
    phase?: string;
    sessionId?: number | null;
    cacheTtlMs?: number;
  };
  logTag?: string;
  promptVersion?: string;
  /** When set and the active provider charges per-token (e.g. Vultr), token
   *  usage from each response is atomically accumulated on this session row. */
  sessionId?: number | null;
}

/**
 * Resolve the model for a call. Local Ollama candidates are routed to the local
 * daemon (OpenAI-compatible `/v1`); a `cheap` task prefers a local model when
 * the daemon is live, else a hosted small model.
 *
 * Exported for the unit test; callers should use {@link callLlm}.
 */
export async function resolveLlmConfig(opts: LlmCallOptions): Promise<LlmClientConfig | null> {
  const requested = opts.overrideModel;

  // Explicit local candidate — must go to the Ollama daemon, never a NIM
  // provider. The daemon is chosen over the remote so a dead daemon falls back
  // to the default hosted model instead of failing the call.
  if (requested !== undefined && isLocalOllamaModelId(requested)) {
    if (await probeLocalOllamaLive()) return getLocalOllamaClientConfig(requested);
    logger.warn({ model: requested, tag: opts.logTag }, "[llm-client] Local Ollama candidate requested but daemon is not live; falling back to hosted default");
    return getLlmClientConfig(undefined);
  }

  // Cheap task with no explicit override — local when live, else hosted small.
  if (opts.taskClass === "cheap" && requested === undefined) {
    const model = (await probeLocalOllamaLive()) ? CHEAP_LOCAL_MODEL : CHEAP_HOSTED_MODEL;
    return model === CHEAP_LOCAL_MODEL
      ? getLocalOllamaClientConfig(model)
      : getLlmClientConfig(model);
  }

  const cfg = getLlmClientConfig(requested);
  return cfg;
}

export async function callLlm(opts: LlmCallOptions): Promise<string | null> {
  // RFC 0001 Avoid/Cache/Cap layers run before any provider resolution: a
  // byte-identical prompt served from the TTL cache never touches the network.
  let budgetKey: string | null = null;
  if (opts.budget) {
    const decision = await resolveTokenDecision(
      {
        taskClass: opts.budget.taskClass,
        sessionId: opts.budget.sessionId ?? opts.sessionId,
        tokenMode: opts.budget.tokenMode,
        phase: opts.budget.phase,
      },
      { messages: opts.messages, promptVersion: opts.promptVersion, cacheTtlMs: opts.budget.cacheTtlMs },
    );

    if (decision.skip) {
      if (decision.reason?.startsWith("cache-hit")) {
        logger.debug({ cacheKey: decision.cacheKey, taskClass: opts.budget.taskClass, tag: opts.logTag }, "[llm-client] result cache hit — no API call");
        void recordSaving({
          sessionId: opts.budget.sessionId ?? opts.sessionId,
          kind: "cache_hit",
          unit: "tokens",
          amount: estimateMessageTokens(opts.messages),
          meta: { cacheKey: decision.cacheKey, taskClass: opts.budget.taskClass },
        });
        return decision.cachedResult;
      }
      logger.warn({ reason: decision.reason, taskClass: opts.budget.taskClass, tag: opts.logTag }, "[llm-client] budget gate blocked call");
      return null;
    }
    budgetKey = decision.cacheKey;
  }

  const cfg = await resolveLlmConfig(opts);
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
        max_tokens: opts.max_tokens ?? (opts.budget ? TASK_MAX_OUTPUT_TOKENS[opts.budget.taskClass] : 1200),
        messages: opts.messages,
      }),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 20000),
    });

    if (!resp.ok) {
      logger.warn({ status: resp.status, tag: opts.logTag, promptVersion: opts.promptVersion }, "[llm-client] LLM request failed");
      return null;
    }

    const data = await resp.json() as {
      choices?: Array<{ message?: { content?: string; reasoning?: string } }>;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    // Ollama Cloud / reasoning models (deepseek-v4-*, gpt-oss, qwen3.5) return the
    // answer in a `reasoning` field with content:''. Fall back to `reasoning` so
    // those models work through the same client.
    const rawContent = data.choices?.[0]?.message?.content?.trim() || data.choices?.[0]?.message?.reasoning?.trim() || null;
    const content = rawContent;
    logger.debug({ tag: opts.logTag, promptVersion: opts.promptVersion, hasContent: content !== null }, "[llm-client] LLM call succeeded");

    // Cache the result for later byte-identical prompts (TTL per task).
    if (budgetKey !== null && content !== null) {
      cacheResult(budgetKey, content, opts.budget?.cacheTtlMs);
    }

    // Universal ledger — every provider's usage is recorded. Fire-and-forget:
    // an accounting failure must never block the caller.
    const promptTokens     = data.usage?.prompt_tokens     ?? 0;
    const completionTokens = data.usage?.completion_tokens ?? 0;
    if (promptTokens > 0 || completionTokens > 0) {
      void recordSpend({
        sessionId: opts.budget?.sessionId ?? opts.sessionId,
        provider: cfg.provider,
        model: cfg.model,
        taskClass: opts.budget?.taskClass ?? null,
        promptTokens,
        completionTokens,
      });

      // Legacy per-token billing DB write (currently Vultr only).
      const tokenRate = PROVIDER_TOKEN_RATES[cfg.provider];
      if (tokenRate !== undefined && opts.sessionId != null) {
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
