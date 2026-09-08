/**
 * RFC 0001 E2E cost gate (vitest form). Asserts the graph-sliced prompt paths
 * reduce rendered prompt tokens by ≥40% vs the pre-RFC naive full-file context
 * on plan.generate / plan.reassess / plan.decompose.
 */

import { describe, expect, it } from "vitest";
import { COST_GATE_TARGET_PCT, runCostGate } from "./e2e/cost-gate";

describe("RFC 0001 E2E cost gate", () => {
  it("reduces rendered prompt tokens by ≥40% on all three plan paths", () => {
    const results = runCostGate();
    expect(results).toHaveLength(3);

    for (const r of results) {
      expect(r.optimizedTokens, `${r.path} optimized tokens`).toBeLessThan(r.baselineTokens);
      expect(r.reductionPct, `${r.path} reduction`).toBeGreaterThanOrEqual(COST_GATE_TARGET_PCT);
    }
  });

  it("reports the per-path snapshot for the dashboard", () => {
    const results = runCostGate();
    for (const r of results) {
      expect(r).toMatchObject({
        path: expect.any(String),
        baselineTokens: expect.any(Number),
        optimizedTokens: expect.any(Number),
        reductionPct: expect.any(Number),
        passed: expect.any(Boolean),
      });
    }
  });
});