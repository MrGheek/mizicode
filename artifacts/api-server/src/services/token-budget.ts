/**
 * token-budget.ts — RFC 0001 Phase 3 TokenBudgetCore
 *
 * Layered resolve() entry point for call sites (Avoid → Compress → Cache →
 * Decide → Cap). This phase realizes the CACHE layer (byte-identical prompt
 * result cache with TTL) and the CAP layer (per-task output ceilings, tripwire
 * gate); the Decide layer stays in llm-client (resolveLlmConfig) which already
 * routes task classes to live local/hosted models.
 *
 * The cache key covers the *rendered* messages, so any mutation — including
 * mutating the frozen system/turn prefix — produces a different hash and a
 * miss. That is the pure-hash form of "never mutate the frozen prefix": the
 * provider KV cache is only reused when the prefix is byte-identical.
 */

import { createHash } from "node:crypto";
import { isTripwireTripped } from "./token-accounting";
import { TOKEN_MODE_PROFILES, type TokenMode } from "./skills-types";

export type BudgetTaskClass =
  | "sidecar-verify"
  | "classify"
  | "recommend"
  | "plan-generate"
  | "plan-reassess"
  | "plan-decompose"
  | "palette-map"
  | "swarm-step"
  | "embed"
  | "summarize";

export interface TokenTask {
  taskClass: BudgetTaskClass;
  intentText?: string;
  sessionId?: number | null;
  phase?: string;
  tokenMode?: TokenMode;
}

export interface TokenDecision {
  /** Resolved model/provider hints — null means llm-client decides as today. */
  model: string | null;
  provider: string | null;
  /** Input token budget for context assemblers (Layer 2 enforce). */
  inputBudgetTokens: number;
  /** Hard output ceiling for the task class. */
  maxOutputTokens: number;
  /** Avoid layer: a byte-identical prompt was served within TTL. */
  skip: boolean;
  reason: string | null;
  cachedResult: string | null;
  cacheKey: string | null;
}

export const RESULT_CACHE_TTL_MS = 6 * 60 * 60 * 1000;

export const TASK_MAX_OUTPUT_TOKENS: Record<BudgetTaskClass, number> = {
  "sidecar-verify": 80,
  classify: 32,
  recommend: 640,
  "plan-generate": 2200,
  "plan-reassess": 800,
  "plan-decompose": 2200,
  "palette-map": 512,
  "swarm-step": 1200,
  embed: 0,
  summarize: 1536,
};

/** Fraction of the active token-mode context budget reserved for input. */
export const TASK_INPUT_BUDGET_RATIO: Record<BudgetTaskClass, number> = {
  "sidecar-verify": 0.05,
  classify: 0.05,
  recommend: 0.2,
  "plan-generate": 0.6,
  "plan-reassess": 0.5,
  "plan-decompose": 0.6,
  "palette-map": 0.1,
  "swarm-step": 0.5,
  embed: 0.05,
  summarize: 0.3,
};

export function shouldCacheForTask(taskClass: BudgetTaskClass): boolean {
  return taskClass !== "embed";
}

// ── TTL result cache ──────────────────────────────────────────────────────────

export interface CacheEntry {
  result: string;
  expiresAt: number;
}

class TtlResultCache {
  private entries = new Map<string, CacheEntry>();
  clock: () => number;

  constructor(clock?: () => number) {
    this.clock = clock ?? Date.now;
  }

  get(key: string): string | null {
    const e = this.entries.get(key);
    if (!e) return null;
    if (this.clock() >= e.expiresAt) {
      this.entries.delete(key);
      return null;
    }
    return e.result;
  }

  set(key: string, result: string, ttlMs: number): void {
    this.entries.set(key, { result, expiresAt: this.clock() + ttlMs });
  }

  has(key: string): boolean {
    return this.get(key) !== null;
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
  }
}

const defaultCache = new TtlResultCache();

export function getResultCache(): TtlResultCache {
  return defaultCache;
}

/** Test seam: overrides the TTL clock (then restores Date.now on reset). */
export function _setBudgetCacheClockForTest(clock: () => number): void {
  defaultCache.clock = clock;
}

/** Test seam: wipes cached results and restores the wall clock. */
export function _resetBudgetCacheForTest(): void {
  defaultCache.clear();
  defaultCache.clock = Date.now;
}

export interface PromptCacheKeyInput {
  messages: Array<{ role: string; content: string }>;
  promptVersion?: string;
  taskClass: BudgetTaskClass;
  tokenMode?: string;
  phase?: string;
}

/**
 * Deterministic key for a rendered prompt: byte-identical messages + the
 * task-class/token-mode/phase context. Identical prompts share one key; any
 * message mutation (prefix or tail) busts it.
 */
export function budgetCacheKey(input: PromptCacheKeyInput): string {
  const payload = JSON.stringify([
    input.messages.map((m) => [m.role, m.content]),
    input.promptVersion ?? "",
    input.taskClass,
    input.tokenMode ?? "",
    input.phase ?? "",
  ]);
  return createHash("sha256").update(payload).digest("hex");
}

/** Coarse token estimate (≈4 chars/token of content, roles excluded) for savings attribution. */
export function estimateMessageTokens(messages: Array<{ role: string; content: string }>): number {
  const chars = messages.reduce((n, m) => n + m.content.length, 0);
  return Math.max(1, Math.ceil(chars / 4));
}

export interface BudgetResolveOptions {
  messages: Array<{ role: string; content: string }>;
  promptVersion?: string;
  /** TTL override for a specific task. */
  cacheTtlMs?: number;
}

/**
 * Resolve the Avoid→Cache→Cap layers for a task. Pure advisory — llm-client
 * executes the decision and writes the result back after a successful call.
 */
export async function resolveTokenDecision(task: TokenTask, opts: BudgetResolveOptions): Promise<TokenDecision> {
  const maxOutputTokens = TASK_MAX_OUTPUT_TOKENS[task.taskClass];
  const profile = TOKEN_MODE_PROFILES[task.tokenMode ?? "full"];
  const inputBudgetTokens = Math.floor(profile.maxContextBudget * TASK_INPUT_BUDGET_RATIO[task.taskClass]);

  const key = budgetCacheKey({
    messages: opts.messages,
    promptVersion: opts.promptVersion,
    taskClass: task.taskClass,
    tokenMode: task.tokenMode,
    phase: task.phase,
  });

  const cached = getResultCache().get(key);
  if (cached !== null) {
    return {
      model: null,
      provider: null,
      inputBudgetTokens,
      maxOutputTokens,
      skip: true,
      reason: "cache-hit",
      cachedResult: cached,
      cacheKey: key,
    };
  }

  if (task.sessionId != null) {
    const trip = await isTripwireTripped(task.sessionId);
    if (trip.tripped) {
      return {
        model: null,
        provider: null,
        inputBudgetTokens,
        maxOutputTokens,
        skip: true,
        reason: `tripwire:${trip.reason}`,
        cachedResult: null,
        cacheKey: key,
      };
    }
  }

  return {
    model: null,
    provider: null,
    inputBudgetTokens,
    maxOutputTokens,
    skip: false,
    reason: null,
    cachedResult: null,
    cacheKey: shouldCacheForTask(task.taskClass) ? key : null,
  };
}

/** Write a completed result into the cache (called by llm-client on success). */
export function cacheResult(key: string, result: string, ttlMs?: number): void {
  getResultCache().set(key, result, ttlMs ?? RESULT_CACHE_TTL_MS);
}