import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  TASK_MAX_OUTPUT_TOKENS,
  _resetBudgetCacheForTest,
  _setBudgetCacheClockForTest,
  budgetCacheKey,
  cacheResult,
  estimateMessageTokens,
  resolveTokenDecision,
} from "../services/token-budget";
import {
  _resetLedgerForTest,
  _resetSavingsForTest,
  savingsSummary,
  sessionSpendSummary,
  setSessionTripwire,
} from "../services/token-accounting";
import { classifyModelSize, MODEL_SIZE_BUDGET_FACTOR } from "../services/skills-types";
import { FLAT_RATE_BUDGET_RELAXATION } from "../services/token-budget";

const messages = [
  { role: "system" as const, content: "You plan software." },
  { role: "user" as const, content: "Build a logging system." },
];

beforeEach(() => {
  _resetBudgetCacheForTest();
  _resetLedgerForTest();
  _resetSavingsForTest();
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("budgetCacheKey — frozen-prefix preservation", () => {
  it("is deterministic for a byte-identical prompt", () => {
    const a = budgetCacheKey({ messages, promptVersion: "1.0", taskClass: "plan-generate", tokenMode: "full" });
    const b = budgetCacheKey({ messages: [...messages], promptVersion: "1.0", taskClass: "plan-generate", tokenMode: "full" });
    expect(a).toBe(b);
  });

  it("busts when ANY message mutates (including the frozen prefix)", () => {
    const base = budgetCacheKey({ messages, promptVersion: "1.0", taskClass: "plan-generate", tokenMode: "full" });
    const mutatedPrefix = budgetCacheKey({
      messages: [{ role: "system", content: "You plan software. [changed]" }, messages[1]!],
      promptVersion: "1.0",
      taskClass: "plan-generate",
      tokenMode: "full",
    });
    const mutatedTail = budgetCacheKey({
      messages: [messages[0]!, { role: "user", content: "Build a logging system. [more]" }],
      promptVersion: "1.0",
      taskClass: "plan-generate",
      tokenMode: "full",
    });
    expect(mutatedPrefix).not.toBe(base);
    expect(mutatedTail).not.toBe(base);
  });

  it("separates prompt version, task class, token mode, and phase", () => {
    const base = budgetCacheKey({ messages, promptVersion: "1.0", taskClass: "plan-generate", tokenMode: "full" });
    expect(budgetCacheKey({ messages, promptVersion: "1.1", taskClass: "plan-generate", tokenMode: "full" })).not.toBe(base);
    expect(budgetCacheKey({ messages, promptVersion: "1.0", taskClass: "plan-decompose", tokenMode: "full" })).not.toBe(base);
    expect(budgetCacheKey({ messages, promptVersion: "1.0", taskClass: "plan-generate", tokenMode: "lean" })).not.toBe(base);
    expect(budgetCacheKey({ messages, promptVersion: "1.0", taskClass: "plan-generate", tokenMode: "full", phase: "review" })).not.toBe(base);
  });
});

describe("resolveTokenDecision — Cache + Cap layers", () => {
  it("returns a cache hit (skip) for a byte-identical prompt within TTL", async () => {
    const key = budgetCacheKey({ messages, promptVersion: "2.0", taskClass: "plan-generate" });
    const miss = await resolveTokenDecision({ taskClass: "plan-generate" }, { messages, promptVersion: "2.0" });
    expect(miss.skip).toBe(false);
    expect(miss.cacheKey).toBe(key);

    cacheResult(key, "cached-plan", 60_000);
    const hit = await resolveTokenDecision({ taskClass: "plan-generate" }, { messages, promptVersion: "2.0" });
    expect(hit.skip).toBe(true);
    expect(hit.reason).toBe("cache-hit");
    expect(hit.cachedResult).toBe("cached-plan");
  });

  it("honors TTL expiry", async () => {
    const key = budgetCacheKey({ messages, promptVersion: "3.0", taskClass: "plan-reassess" });
    _setBudgetCacheClockForTest(() => 1_000);
    cacheResult(key, "stale", 5_000);

    _setBudgetCacheClockForTest(() => 7_000); // past expiry
    const d = await resolveTokenDecision({ taskClass: "plan-reassess" }, { messages, promptVersion: "3.0" });
    expect(d.skip).toBe(false);
  });

  it("assigns per-task caps and mode-aware input budgets", async () => {
    const d = await resolveTokenDecision({ taskClass: "plan-decompose", tokenMode: "lean" }, { messages });
    expect(d.maxOutputTokens).toBe(TASK_MAX_OUTPUT_TOKENS["plan-decompose"]);
    expect(d.inputBudgetTokens).toBeGreaterThan(0);
    expect(d.inputBudgetTokens).toBeLessThan(TASK_MAX_OUTPUT_TOKENS["plan-decompose"] * 400);

    const cheap = await resolveTokenDecision({ taskClass: "sidecar-verify" }, { messages });
    expect(cheap.maxOutputTokens).toBe(80);
  });

  it("gates on a session tripwire with reason", async () => {
    await setSessionTripwire(42, { maxCalls: 1 });
    const d = await resolveTokenDecision({ taskClass: "swarm-step", sessionId: 42 }, { messages });
    // No cached result and no spend yet → not tripped (spend counting is per-call).
    expect(d.skip).toBe(false);

    await setSessionTripwire(43, { maxCalls: 0 });
    const t = await resolveTokenDecision({ taskClass: "swarm-step", sessionId: 43 }, { messages });
    expect(t.skip).toBe(true);
    expect(t.reason).toContain("tripwire");
  });
});

describe("estimateMessageTokens", () => {
  it("is a coarse chars/4 estimate", () => {
    expect(estimateMessageTokens([{ role: "user", content: "a".repeat(400) }])).toBe(100);
    expect(estimateMessageTokens([{ role: "user", content: "" }])).toBe(1);
  });
});

describe("classifyModelSize — RFC 0004 Phase 2", () => {
  it("classifies by context window", () => {
    expect(classifyModelSize("128K")).toBe("large");
    expect(classifyModelSize("64K")).toBe("mid");
    expect(classifyModelSize("40K")).toBe("mid");
    expect(classifyModelSize("8K")).toBe("small");
    expect(classifyModelSize("1M")).toBe("large");
  });

  it("treats unknown/absent as mid (neutral)", () => {
    expect(classifyModelSize(null)).toBe("mid");
    expect(classifyModelSize(undefined)).toBe("mid");
    expect(classifyModelSize("")).toBe("mid");
    expect(classifyModelSize("unknown")).toBe("mid");
  });

  it("budget factors are bounded and centered on mid", () => {
    expect(MODEL_SIZE_BUDGET_FACTOR.mid).toBe(1.0);
    expect(MODEL_SIZE_BUDGET_FACTOR.large).toBeGreaterThan(1.0);
    expect(MODEL_SIZE_BUDGET_FACTOR.small).toBeLessThan(1.0);
    expect(MODEL_SIZE_BUDGET_FACTOR.large).toBeLessThan(1.2);
    expect(MODEL_SIZE_BUDGET_FACTOR.small).toBeGreaterThan(0.8);
  });
});

describe("resolveTokenDecision — model-size-aware budgets (RFC 0004 Phase 2)", () => {
  it("scales the input budget by the model-size factor", async () => {
    const base = await resolveTokenDecision({ taskClass: "plan-decompose", tokenMode: "core" }, { messages });
    const large = await resolveTokenDecision({ taskClass: "plan-decompose", tokenMode: "core", modelSize: "large" }, { messages });
    const small = await resolveTokenDecision({ taskClass: "plan-decompose", tokenMode: "core", modelSize: "small" }, { messages });

    expect(large.inputBudgetTokens).toBeGreaterThan(base.inputBudgetTokens);
    expect(small.inputBudgetTokens).toBeLessThan(base.inputBudgetTokens);
    // Bounded: large ≤ base × 1.15, small ≥ base × 0.85 (floor rounding).
    expect(large.inputBudgetTokens).toBeLessThanOrEqual(Math.floor(base.inputBudgetTokens * 1.15) + 1);
    expect(small.inputBudgetTokens).toBeGreaterThanOrEqual(Math.floor(base.inputBudgetTokens * 0.85) - 1);
  });

  it("defaults to mid (no change) when modelSize is absent", async () => {
    const a = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full" }, { messages });
    const b = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full", modelSize: "mid" }, { messages });
    expect(a.inputBudgetTokens).toBe(b.inputBudgetTokens);
  });
});

describe("resolveTokenDecision — flat-rate billing relaxation (RFC 0004 Phase 3)", () => {
  it("relaxes the input budget on flat-rate providers", async () => {
    const standard = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full" }, { messages });
    const flatRate = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full" }, { messages, activeProviderBilling: "flat-rate" });

    expect(flatRate.inputBudgetTokens).toBeGreaterThan(standard.inputBudgetTokens);
    expect(flatRate.flatRateRelaxed).toBe(true);
    // Bounded: flat-rate ≤ standard × 1.1 (floor rounding).
    expect(flatRate.inputBudgetTokens).toBeLessThanOrEqual(Math.floor(standard.inputBudgetTokens * FLAT_RATE_BUDGET_RELAXATION) + 1);
  });

  it("does not relax on per-token providers", async () => {
    const a = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full" }, { messages });
    const b = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full" }, { messages, activeProviderBilling: "per-token" });
    expect(a.inputBudgetTokens).toBe(b.inputBudgetTokens);
    expect(b.flatRateRelaxed).toBe(false);
  });

  it("defaults to per-token (no relaxation) when billing is absent", async () => {
    const d = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full" }, { messages });
    expect(d.flatRateRelaxed).toBe(false);
  });

  it("combines flat-rate relaxation with model-size factor", async () => {
    const base = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full" }, { messages });
    const flatLarge = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full", modelSize: "large" }, { messages, activeProviderBilling: "flat-rate" });
    const flatSmall = await resolveTokenDecision({ taskClass: "plan-generate", tokenMode: "full", modelSize: "small" }, { messages, activeProviderBilling: "flat-rate" });

    expect(flatLarge.inputBudgetTokens).toBeGreaterThan(base.inputBudgetTokens);
    expect(flatSmall.inputBudgetTokens).toBeGreaterThan(0);
    // Both relaxed by flat-rate, then scaled by model-size.
    expect(flatLarge.flatRateRelaxed).toBe(true);
    expect(flatSmall.flatRateRelaxed).toBe(true);
  });
});

describe("callLlm integration — cache write/read through the real budget path", () => {
  it("serves the second identical cacheable call with no network", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: "GENERATED-PLAN" } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      }), { status: 200 }));

    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "https://repl.it/v1";
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key";
    // Use a per-token provider (replit) so savings claims are recorded.
    // NVIDIA (flat-rate) would suppress savings — that's tested separately.

    // Temporarily set the module's fetch.
    const { callLlm } = await import("../services/llm-client");
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;

    try {
      const first = await callLlm({
        messages,
        promptVersion: "4.0",
        logTag: "plan.generate.integration",
        budget: { taskClass: "plan-generate" },
      });
      expect(first).toBe("GENERATED-PLAN");

      const second = await callLlm({
        messages,
        promptVersion: "4.0",
        logTag: "plan.generate.integration",
        budget: { taskClass: "plan-generate" },
      });
      expect(second).toBe("GENERATED-PLAN");

      // Only one network call: the second was served from the result cache.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const savings = savingsSummary();
      expect(savings.cacheHits).toBe(1);
      expect(savings.tokensSaved).toBeGreaterThan(0);
      // Ledger recorded the single real call.
      expect((await sessionSpendSummary()).calls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("does not cache embed tasks", async () => {
    process.env["AI_INTEGRATIONS_OPENAI_BASE_URL"] = "https://repl.it/v1";
    process.env["AI_INTEGRATIONS_OPENAI_API_KEY"] = "test-key";
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({ choices: [{ message: { content: "vec" } }], usage: { prompt_tokens: 10, completion_tokens: 1 } }), { status: 200 }));

    const { callLlm } = await import("../services/llm-client");
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      await callLlm({ messages, promptVersion: "5.0", budget: { taskClass: "embed" } });
      await callLlm({ messages, promptVersion: "5.0", budget: { taskClass: "embed" } });
      expect(fetchSpy).toHaveBeenCalledTimes(2); // embed never caches
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  it("suppresses cache-hit savings claims on flat-rate providers (RFC 0004 Phase 3)", async () => {
    // NVIDIA NIM is flat-rate — tokens are free, so a cache hit saves nothing.
    process.env["NVIDIA_NIM_API_KEY"] = "nv-test";
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({
        choices: [{ message: { content: "FLAT-PLAN" } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      }), { status: 200 }));

    const { callLlm } = await import("../services/llm-client");
    const realFetch = globalThis.fetch;
    globalThis.fetch = fetchSpy as unknown as typeof fetch;
    try {
      const first = await callLlm({ messages, promptVersion: "6.0", logTag: "plan.generate.flat", budget: { taskClass: "plan-generate" } });
      expect(first).toBe("FLAT-PLAN");
      const second = await callLlm({ messages, promptVersion: "6.0", logTag: "plan.generate.flat", budget: { taskClass: "plan-generate" } });
      expect(second).toBe("FLAT-PLAN");
      // Served from cache (single network call) but NO savings claimed.
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const savings = savingsSummary();
      expect(savings.cacheHits).toBe(0);
    } finally {
      globalThis.fetch = realFetch;
      delete process.env["NVIDIA_NIM_API_KEY"];
    }
  });
});