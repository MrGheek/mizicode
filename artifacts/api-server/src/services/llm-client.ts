/**
 * llm-client.ts — LLM call layer for server-side inference (plan generation, reassessment).
 *
 * Provider resolution uses the same registry as inference-router.ts:
 * getConfiguredProviders() + PROVIDER_CONFIG from nim-catalog (priority: nvidia →
 * together → deepinfra → vultr), with Replit AI Integrations as a dev fallback.
 */

import { logger } from "../lib/logger";
import { getConfiguredProviders, PROVIDER_CONFIG } from "./nim-catalog";

export interface LlmClientConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
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
    return { baseUrl: info.apiBase, apiKey, model };
  }

  const baseUrl = process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"];
  const apiKey = process.env["AI_INTEGRATIONS_OPENAI_API_KEY"];
  if (baseUrl && apiKey) return { baseUrl, apiKey, model };

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
}

export async function callLlm(opts: LlmCallOptions): Promise<string | null> {
  const cfg = getLlmClientConfig(opts.overrideModel);
  if (!cfg) {
    logger.warn({ tag: opts.logTag }, "[llm-client] No LLM provider configured");
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
      logger.warn({ status: resp.status, tag: opts.logTag }, "[llm-client] LLM request failed");
      return null;
    }

    const data = await resp.json() as { choices?: Array<{ message?: { content?: string } }> };
    return data.choices?.[0]?.message?.content?.trim() ?? null;
  } catch (err) {
    logger.warn({ err, tag: opts.logTag }, "[llm-client] LLM call threw");
    return null;
  }
}
