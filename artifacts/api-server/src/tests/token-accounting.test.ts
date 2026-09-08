import { beforeEach, describe, expect, it } from "vitest";
import {
  LLM_RATES,
  SAVINGS_DEFAULT_USD_PER_TOKEN,
  _resetLedgerForTest,
  _resetSavingsForTest,
  compressCachedPrefixWorthIt,
  estimateTokenCostUsd,
  isTripwireTripped,
  prefixCacheEconomics,
  recordSaving,
  recordSpend,
  reserveLevelFor,
  savingsSummary,
  sessionSpendSummary,
  setSessionTripwire,
} from "../services/token-accounting";

beforeEach(() => {
  _resetLedgerForTest();
  _resetSavingsForTest();
});

describe("cost model", () => {
  it("splits the combined Vultr rate across input/output and charges cached tokens at $0", () => {
    expect(LLM_RATES.vultr).toBeDefined();
    const usd = estimateTokenCostUsd("vultr", { promptTokens: 1_000_000, completionTokens: 1_000_000, cachedTokens: 500_000 });
    const billedInput = 1_000_000 - 500_000;
    const expected = (billedInput / 1e6) * LLM_RATES.vultr!.inputPer1M + (1_000_000 / 1e6) * LLM_RATES.vultr!.outputPer1M;
    expect(usd).toBeCloseTo(expected, 12);
  });

  it("is $0 for unpriced (NIM/local) providers", () => {
    expect(estimateTokenCostUsd("nvidia", { promptTokens: 5_000_000, completionTokens: 500_000 })).toBe(0);
    expect(estimateTokenCostUsd("ollama-local", { promptTokens: 5_000_000, completionTokens: 500_000 })).toBe(0);
  });

  it("keeps a cached prefix cheap and honors the never-rewrite rule when expensive", () => {
    const ec = prefixCacheEconomics("vultr", 10_000, 8_000);
    expect(ec.savingsUsd).toBeGreaterThan(0);
    // Rewriting a big cached prefix to save few tokens is not worth it.
    expect(compressCachedPrefixWorthIt("vultr", 10_000, 50)).toBe(false);
    // Compressing a lot of tokens is worth the invalidation.
    expect(compressCachedPrefixWorthIt("vultr", 10_000, 9_000)).toBe(true);
  });
});

describe("ledger", () => {
  it("accumulates spend across calls and providers", async () => {
    await recordSpend({ sessionId: 7, provider: "vultr", model: "meta", taskClass: "plan-generate", promptTokens: 150_000, completionTokens: 50_000 });
    await recordSpend({ sessionId: 7, provider: "nvidia", model: "qwen72b", taskClass: "plan-reassess", promptTokens: 3_000, completionTokens: 200 });
    await recordSpend({ sessionId: 8, provider: "vultr", model: "meta", taskClass: "palette-map", promptTokens: 1_000, completionTokens: 100 });

    const s7 = await sessionSpendSummary(7);
    expect(s7.calls).toBe(2);
    expect(s7.promptTokens).toBe(153_000);
    expect(s7.completionTokens).toBe(50_200);
    expect(s7.costUsd).toBeGreaterThan(0); // vultr half of the spend priced

    const global = await sessionSpendSummary();
    expect(global.calls).toBe(3);

    const s8 = await sessionSpendSummary(8);
    expect(s8.costUsd).toBeGreaterThan(0);
  });
});

describe("tripwires", () => {
  it("aborts when a call cap is reached", async () => {
    await setSessionTripwire(1, { maxCalls: 2 });
    await recordSpend({ sessionId: 1, provider: "nvidia", model: "m", promptTokens: 100, completionTokens: 10 });
    await recordSpend({ sessionId: 1, provider: "nvidia", model: "m", promptTokens: 100, completionTokens: 10 });
    expect((await isTripwireTripped(1)).tripped).toBe(true);
    expect((await isTripwireTripped(1)).reason).toContain("call cap");
  });

  it("aborts on token and USD caps", async () => {
    await setSessionTripwire(2, { maxTokens: 500 });
    await recordSpend({ sessionId: 2, provider: "nvidia", model: "m", promptTokens: 600, completionTokens: 0 });
    expect((await isTripwireTripped(2)).tripped).toBe(true);

    await setSessionTripwire(3, { maxUsd: 0.0000001 });
    await recordSpend({ sessionId: 3, provider: "vultr", model: "m", promptTokens: 1_000_000, completionTokens: 0 });
    expect((await isTripwireTripped(3)).tripped).toBe(true);
  });

  it("does not trip without a tripwire", async () => {
    await recordSpend({ sessionId: 4, provider: "vultr", model: "m", promptTokens: 500_000, completionTokens: 0 });
    expect((await isTripwireTripped(4)).tripped).toBe(false);
  });
});

describe("reserve-based auto-degrade", () => {
  it("degrades as headroom shrinks", async () => {
    expect(await reserveLevelFor(1)).toBe("full");

    await setSessionTripwire(2, { maxTokens: 1000 });
    await recordSpend({ sessionId: 2, provider: "nvidia", model: "m", promptTokens: 300, completionTokens: 0 });
    expect(await reserveLevelFor(2)).toBe("full"); // 30% used

    await recordSpend({ sessionId: 2, provider: "nvidia", model: "m", promptTokens: 300, completionTokens: 0 });
    expect(await reserveLevelFor(2)).toBe("reduce"); // 60% used

    await recordSpend({ sessionId: 2, provider: "nvidia", model: "m", promptTokens: 300, completionTokens: 0 });
    expect(await reserveLevelFor(2)).toBe("minimal"); // 90% used
  });
});

describe("savings ledger", () => {
  it("totals cache_hit tokens, bytes avoided, and $ saved", async () => {
    await recordSaving({ sessionId: 9, kind: "cache_hit", unit: "tokens", amount: 2000 });
    await recordSaving({ sessionId: 9, kind: "cache_hit", unit: "tokens", amount: 2000 });
    await recordSaving({ sessionId: 9, kind: "externalized_pointer", unit: "bytes", amount: 150_000, estUsd: 0.012 });
    await recordSaving({ sessionId: 9, kind: "local_offload", unit: "tokens", amount: 500_000 });

    const s = savingsSummary();
    expect(s.cacheHits).toBe(2);
    expect(s.tokensSaved).toBe(2_000 + 2_000 + 500_000);
    expect(s.bytesAvoided).toBe(150_000);
    // 2×2000 tokens + 500_000 tokens at $1.4e-6, plus the explicit $0.012.
    expect(s.estUsdSaved).toBeCloseTo(2_000 * 2 * SAVINGS_DEFAULT_USD_PER_TOKEN + 500_000 * SAVINGS_DEFAULT_USD_PER_TOKEN + 0.012, 9);
  });
});