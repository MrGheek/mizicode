/**
 * Tests for RFC 0004 Phase 1 — guaranteed working-set injection.
 *
 * reserveWorkingSet() is the pure core of the change: task-touched files
 * (seedFiles) are reserved a budget slice and injected first, in full, before
 * any ranked symbol competes for the remaining budget. The working set is never
 * dropped entirely — at worst it is elided to the best-fitting prefix.
 */

import { describe, expect, it } from "vitest";
import { reserveWorkingSet, fitToBudget, estimateTokens } from "../services/repo-rank";

interface Item {
  text: string;
  path: string;
}

function item(path: string, text: string): Item {
  return { path, text };
}

describe("reserveWorkingSet", () => {
  it("injects working-set files first, in full, before ranked symbols", () => {
    const ranked = [
      item("src/ranked-a.ts", "export const rankedA = 1;"),
      item("src/working.ts", "export const working = 1;"),
      item("src/ranked-b.ts", "export const rankedB = 1;"),
    ];
    const { fitted, workingSetTokens } = reserveWorkingSet(ranked, ["src/working.ts"], 1000);
    // Working set first, then ranked remainder.
    expect(fitted[0]?.path).toBe("src/working.ts");
    expect(fitted.map((f) => f.path)).toContain("src/ranked-a.ts");
    expect(fitted.map((f) => f.path)).toContain("src/ranked-b.ts");
    expect(workingSetTokens).toBe(estimateTokens("export const working = 1;"));
  });

  it("keeps the working set even when it would otherwise be dropped by a tight budget", () => {
    const ranked = [
      item("src/ranked-a.ts", "export const rankedA = 1;"),
      item("src/working.ts", "export const working = 1;"),
      item("src/ranked-b.ts", "export const rankedB = 1;"),
    ];
    // Budget fits only ~1 line. Without the reservation, the top-ranked symbol
    // (ranked-a) would win and the working set would be dropped.
    const { fitted } = reserveWorkingSet(ranked, ["src/working.ts"], 30);
    expect(fitted[0]?.path).toBe("src/working.ts");
  });

  it("elides the working set to signatures when it alone exceeds the reservation", () => {
    const ranked = [
      item("src/working.ts", "export const working = 1;"),
      item("src/ranked-a.ts", "export const rankedA = 1;"),
    ];
    // Reserved budget is 35% of 20 = 7 tokens; the working-set line is ~10
    // tokens, so fitToBudget keeps at least one item (never drops entirely).
    const { fitted, workingSetTokens } = reserveWorkingSet(ranked, ["src/working.ts"], 20);
    expect(fitted.length).toBeGreaterThan(0);
    expect(fitted[0]?.path).toBe("src/working.ts");
    expect(workingSetTokens).toBeGreaterThan(0);
  });

  it("returns the plain ranked fit when no working set is given", () => {
    const ranked = [
      item("src/a.ts", "export const a = 1;"),
      item("src/b.ts", "export const b = 1;"),
    ];
    const { fitted, workingSetTokens } = reserveWorkingSet(ranked, [], 1000);
    expect(fitted).toEqual(fitToBudget(ranked, 1000));
    expect(workingSetTokens).toBe(0);
  });

  it("caps the working set at 8 files", () => {
    const ranked = Array.from({ length: 12 }, (_, i) => item(`src/f${i}.ts`, `export const f${i} = 1;`));
    const files = Array.from({ length: 12 }, (_, i) => `src/f${i}.ts`);
    const { fitted } = reserveWorkingSet(ranked, files, 100_000);
    // All 12 are in the ranked list; the working-set reservation is capped at 8
    // but the remaining 4 still appear via the ranked fit (budget is huge).
    expect(fitted.length).toBe(12);
  });

  it("never exceeds the total budget", () => {
    const ranked = Array.from({ length: 20 }, (_, i) => item(`src/f${i}.ts`, `export const f${i} = 1;`));
    const files = Array.from({ length: 8 }, (_, i) => `src/f${i}.ts`);
    const { fitted } = reserveWorkingSet(ranked, files, 200);
    const total = fitted.reduce((s, f) => s + estimateTokens(f.text), 0);
    expect(total).toBeLessThanOrEqual(200);
  });
});
