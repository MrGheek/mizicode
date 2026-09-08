#!/usr/bin/env -S npx tsx
/**
 * RFC 0001 E2E cost gate — standalone runner.
 *
 * Snapshots rendered prompt token counts for plan.generate / plan.reassess /
 * plan.decompose with the pre-RFC naive full-file context vs the RFC
 * graph-sliced signature block, and enforces the ≥40% reduction gate.
 *
 * Usage:
 *   pnpm tsx src/tests/e2e/cost-gate-e2e.ts
 *
 * Exit code 0 when every path passes the gate; 1 otherwise.
 */

import { COST_GATE_TARGET_PCT, runCostGate } from "./cost-gate";

const results = runCostGate();

console.log("RFC 0001 E2E cost gate (target ≥ " + COST_GATE_TARGET_PCT + "% reduction)");
console.log("─".repeat(64));
for (const r of results) {
  const mark = r.passed ? "PASS" : "FAIL";
  console.log(
    `  ${mark}  ${r.path.padEnd(16)} ${String(r.baselineTokens).padStart(6)} → ${String(r.optimizedTokens).padStart(6)} tokens  (${r.reductionPct}% reduction)`,
  );
}
console.log("─".repeat(64));

const allPassed = results.every((r) => r.passed);
const avg = results.reduce((n, r) => n + r.reductionPct, 0) / results.length;
console.log(`Average reduction: ${avg.toFixed(1)}%  →  ${allPassed ? "GATE PASSED" : "GATE FAILED"}`);
process.exit(allPassed ? 0 : 1);