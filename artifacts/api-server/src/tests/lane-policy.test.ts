/**
 * Unit tests for lane-policy service.
 * Tests computeClaimOverlap, estimateBlastRadiusOverlap, computeSymbolAwareClaimOverlap,
 * and estimateBlastRadiusOverlapAnnotated without any database access.
 */

import { describe, it, expect } from "vitest";
import {
  computeClaimOverlap,
  estimateBlastRadiusOverlap,
  computeSymbolAwareClaimOverlap,
  estimateBlastRadiusOverlapAnnotated,
  getLanePolicy,
  VALID_LANE_TYPES,
  LANE_DEFAULT_TTL_SECONDS,
  LANE_HEARTBEAT_WINDOW_SECONDS,
} from "../services/lane-policy";

describe("getLanePolicy", () => {
  it("returns the correct policy for each valid lane type", () => {
    for (const laneType of VALID_LANE_TYPES) {
      const policy = getLanePolicy(laneType);
      expect(policy.laneType).toBe(laneType);
      expect(policy.defaultTaskMode).toBeTruthy();
      expect(policy.defaultTokenMode).toBeTruthy();
      expect(Array.isArray(policy.allowedClaimTypes)).toBe(true);
      expect(policy.limits.maxConcurrentClaims).toBeGreaterThan(0);
    }
  });

  it("falls back to general policy for unknown lane types", () => {
    const policy = getLanePolicy("unknown_type");
    expect(policy.laneType).toBe("general");
  });

  it("exports correct constants", () => {
    expect(LANE_DEFAULT_TTL_SECONDS).toBe(3600);
    expect(LANE_HEARTBEAT_WINDOW_SECONDS).toBe(300);
  });
});

describe("computeClaimOverlap", () => {
  it("returns 0 when either claim set is empty", () => {
    expect(computeClaimOverlap([], ["src/app.ts"])).toBe(0);
    expect(computeClaimOverlap(["src/app.ts"], [])).toBe(0);
    expect(computeClaimOverlap([], [])).toBe(0);
  });

  it("returns 0 when there is no overlap", () => {
    const score = computeClaimOverlap(
      ["src/frontend/App.tsx"],
      ["src/backend/server.ts"],
    );
    expect(score).toBe(0);
  });

  it("detects direct file overlap (case-insensitive)", () => {
    const score = computeClaimOverlap(
      ["src/routes/auth.ts"],
      ["src/routes/auth.ts"],
    );
    expect(score).toBeGreaterThan(0);
  });

  it("detects case-insensitive direct overlap", () => {
    const score = computeClaimOverlap(
      ["SRC/Routes/Auth.ts"],
      ["src/routes/auth.ts"],
    );
    expect(score).toBeGreaterThan(0);
  });

  it("detects prefix (parent directory) overlap", () => {
    const score = computeClaimOverlap(
      ["src/api"],
      ["src/api/routes.ts"],
    );
    expect(score).toBeGreaterThan(0);
  });

  it("full overlap (all paths match) produces score of 1.0", () => {
    const paths = ["src/a.ts", "src/b.ts"];
    const score = computeClaimOverlap(paths, paths);
    expect(score).toBe(1.0);
  });

  it("partial overlap produces intermediate score", () => {
    const score = computeClaimOverlap(
      ["src/a.ts", "src/b.ts", "src/c.ts"],
      ["src/a.ts"],
    );
    expect(score).toBeGreaterThan(0);
    expect(score).toBeLessThan(1);
  });

  it("score is capped at 1.0", () => {
    const score = computeClaimOverlap(
      ["src/a.ts"],
      ["src/a.ts", "src/b.ts", "src/c.ts"],
    );
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("score >= 0.75 classifies as block-level conflict", () => {
    const paths = ["src/shared.ts"];
    const score = computeClaimOverlap(paths, paths);
    expect(score).toBeGreaterThanOrEqual(0.75);
  });
});

describe("estimateBlastRadiusOverlap", () => {
  it("returns 0 when edges list is empty", () => {
    expect(estimateBlastRadiusOverlap(["a.ts"], ["b.ts"], [])).toBe(0);
  });

  it("returns 0 when either claim set is empty", () => {
    const edges = [{ from: "a.ts", to: "b.ts" }];
    expect(estimateBlastRadiusOverlap([], ["b.ts"], edges)).toBe(0);
    expect(estimateBlastRadiusOverlap(["a.ts"], [], edges)).toBe(0);
  });

  it("detects transitive dependency overlap via graph edges", () => {
    const edges = [{ from: "src/a.ts", to: "src/b.ts" }];
    const score = estimateBlastRadiusOverlap(["src/a.ts"], ["src/b.ts"], edges);
    expect(score).toBeGreaterThan(0);
  });

  it("also detects reverse direction edges", () => {
    const edges = [{ from: "src/b.ts", to: "src/a.ts" }];
    const score = estimateBlastRadiusOverlap(["src/a.ts"], ["src/b.ts"], edges);
    expect(score).toBeGreaterThan(0);
  });

  it("returns 0 when edges don't connect the two claim sets", () => {
    const edges = [{ from: "unrelated.ts", to: "other.ts" }];
    const score = estimateBlastRadiusOverlap(["src/a.ts"], ["src/b.ts"], edges);
    expect(score).toBe(0);
  });

  it("score is capped at 1.0", () => {
    const claimsA = ["a.ts"];
    const claimsB = ["b.ts", "c.ts", "d.ts"];
    const edges = [
      { from: "a.ts", to: "b.ts" },
      { from: "a.ts", to: "c.ts" },
      { from: "a.ts", to: "d.ts" },
    ];
    const score = estimateBlastRadiusOverlap(claimsA, claimsB, edges);
    expect(score).toBeLessThanOrEqual(1.0);
  });

  it("is case-insensitive", () => {
    const edges = [{ from: "SRC/A.ts", to: "SRC/B.ts" }];
    const score = estimateBlastRadiusOverlap(["src/a.ts"], ["src/b.ts"], edges);
    expect(score).toBeGreaterThan(0);
  });
});

// ─── Symbol-level conflict detection ──────────────────────────────────────────

describe("computeSymbolAwareClaimOverlap", () => {
  it("returns zero score when either set is empty", () => {
    const result = computeSymbolAwareClaimOverlap([], [{ pathOrSymbol: "src/a.ts" }]);
    expect(result.score).toBe(0);
    expect(result.conflictingResources).toHaveLength(0);
    expect(result.conflictingSymbols).toHaveLength(0);
  });

  it("falls back to file-level detection when neither claim has symbols", () => {
    const claimsA = [{ pathOrSymbol: "src/utils.ts" }];
    const claimsB = [{ pathOrSymbol: "src/utils.ts" }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBeGreaterThan(0);
    expect(result.conflictingResources).toContain("src/utils.ts");
    expect(result.conflictingSymbols).toHaveLength(0);
  });

  it("falls back to file-level when only one side has symbols", () => {
    const claimsA = [{ pathOrSymbol: "src/utils.ts", symbols: ["validateEmail"] }];
    const claimsB = [{ pathOrSymbol: "src/utils.ts" }]; // no symbols
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBeGreaterThan(0);
    expect(result.conflictingResources).toContain("src/utils.ts");
    // No symbol collision info since one side lacks symbol metadata
    expect(result.conflictingSymbols).toHaveLength(0);
  });

  it("reports NO conflict when both claims have symbols that do not overlap", () => {
    const claimsA = [{ pathOrSymbol: "src/utils.ts", symbols: ["validateEmail", "parseDate"] }];
    const claimsB = [{ pathOrSymbol: "src/utils.ts", symbols: ["fetchUser", "renderNav"] }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBe(0);
    expect(result.conflictingResources).toHaveLength(0);
    expect(result.conflictingSymbols).toHaveLength(0);
  });

  it("reports conflict and lists symbols when symbol sets overlap", () => {
    const claimsA = [{ pathOrSymbol: "src/utils.ts", symbols: ["validateEmail", "parseDate"] }];
    const claimsB = [{ pathOrSymbol: "src/utils.ts", symbols: ["validateEmail", "fetchUser"] }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBeGreaterThan(0);
    expect(result.conflictingResources).toContain("src/utils.ts");
    expect(result.conflictingSymbols).toContain("validateEmail");
    expect(result.conflictingSymbols).not.toContain("parseDate");
    expect(result.conflictingSymbols).not.toContain("fetchUser");
  });

  it("is case-insensitive when comparing symbols", () => {
    const claimsA = [{ pathOrSymbol: "src/utils.ts", symbols: ["ValidateEmail"] }];
    const claimsB = [{ pathOrSymbol: "src/utils.ts", symbols: ["validateEmail"] }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBeGreaterThan(0);
    expect(result.conflictingSymbols.length).toBeGreaterThan(0);
  });

  it("does not flag different files as conflicting even without symbols", () => {
    const claimsA = [{ pathOrSymbol: "src/auth.ts" }];
    const claimsB = [{ pathOrSymbol: "src/utils.ts" }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBe(0);
    expect(result.conflictingResources).toHaveLength(0);
  });

  it("detects prefix/directory-level overlap for non-symbol claims", () => {
    const claimsA = [{ pathOrSymbol: "src/api" }];
    const claimsB = [{ pathOrSymbol: "src/api/routes.ts" }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBeGreaterThan(0);
    expect(result.conflictingResources).toContain("src/api");
  });

  it("all-symbol-conflict produces score of 1.0", () => {
    const claimsA = [{ pathOrSymbol: "src/utils.ts", symbols: ["fn"] }];
    const claimsB = [{ pathOrSymbol: "src/utils.ts", symbols: ["fn"] }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBe(1.0);
  });

  it("multiple files: only conflicting file appears in conflictingResources", () => {
    const claimsA = [
      { pathOrSymbol: "src/a.ts", symbols: ["foo"] },
      { pathOrSymbol: "src/b.ts", symbols: ["bar"] },
    ];
    const claimsB = [
      { pathOrSymbol: "src/a.ts", symbols: ["baz"] }, // different symbol — no conflict
      { pathOrSymbol: "src/b.ts", symbols: ["bar"] }, // same symbol — conflict
    ];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.conflictingResources).not.toContain("src/a.ts");
    expect(result.conflictingResources).toContain("src/b.ts");
    expect(result.conflictingSymbols).toContain("bar");
    expect(result.conflictingSymbols).not.toContain("foo");
    expect(result.conflictingSymbols).not.toContain("baz");
  });

  // ── Parity regression tests: no-symbol fallback must match computeClaimOverlap ──

  it("parity: prefix overlap score matches computeClaimOverlap (0.5 weight, not 1.0)", () => {
    // computeClaimOverlap(["src/api"], ["src/api/routes.ts"]) = (0 + 1*0.5) / 1 = 0.5
    const legacyScore = computeClaimOverlap(["src/api"], ["src/api/routes.ts"]);
    const claimsA = [{ pathOrSymbol: "src/api" }];
    const claimsB = [{ pathOrSymbol: "src/api/routes.ts" }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBe(legacyScore);
  });

  it("parity: direct overlap score matches computeClaimOverlap (1.0 weight)", () => {
    const legacyScore = computeClaimOverlap(["src/a.ts", "src/b.ts"], ["src/a.ts"]);
    const claimsA = [{ pathOrSymbol: "src/a.ts" }, { pathOrSymbol: "src/b.ts" }];
    const claimsB = [{ pathOrSymbol: "src/a.ts" }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBe(legacyScore);
  });

  it("parity: full direct overlap produces 1.0 score (same as computeClaimOverlap)", () => {
    const paths = ["src/a.ts", "src/b.ts"];
    const legacyScore = computeClaimOverlap(paths, paths);
    const claims = paths.map(p => ({ pathOrSymbol: p }));
    const result = computeSymbolAwareClaimOverlap(claims, claims);
    expect(result.score).toBe(legacyScore);
    expect(result.score).toBe(1.0);
  });

  it("parity: no overlap returns 0 (same as computeClaimOverlap)", () => {
    const legacyScore = computeClaimOverlap(["src/auth.ts"], ["src/utils.ts"]);
    const claimsA = [{ pathOrSymbol: "src/auth.ts" }];
    const claimsB = [{ pathOrSymbol: "src/utils.ts" }];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBe(legacyScore);
    expect(result.score).toBe(0);
  });

  it("parity: duplicate path claims are deduplicated (set semantics, not pair-wise)", () => {
    // Duplicate paths in B must not inflate the score beyond what computeClaimOverlap produces
    const legacyScore = computeClaimOverlap(["src/a.ts"], ["src/a.ts"]);
    const claimsA = [{ pathOrSymbol: "src/a.ts" }];
    const claimsB = [
      { pathOrSymbol: "src/a.ts" },
      { pathOrSymbol: "src/a.ts" }, // duplicate
    ];
    const result = computeSymbolAwareClaimOverlap(claimsA, claimsB);
    expect(result.score).toBe(legacyScore);
    expect(result.score).toBe(1.0);
  });
});

describe("estimateBlastRadiusOverlapAnnotated", () => {
  it("returns score 0 and empty edges when no repo edges provided", () => {
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "src/a.ts" }],
      [{ pathOrSymbol: "src/b.ts" }],
      [],
    );
    expect(result.score).toBe(0);
    expect(result.triggeringEdges).toHaveLength(0);
  });

  it("detects a dependency edge and returns triggering edge info", () => {
    const edges = [{ from: "src/a.ts", to: "src/b.ts" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "src/a.ts" }],
      [{ pathOrSymbol: "src/b.ts" }],
      edges,
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.triggeringEdges).toHaveLength(1);
    expect(result.triggeringEdges[0]?.fromPath).toBe("src/a.ts");
    expect(result.triggeringEdges[0]?.toPath).toBe("src/b.ts");
  });

  it("annotates triggering edges with callerSymbol / calleeSymbol when present", () => {
    const edges = [{ from: "src/a.ts", to: "src/b.ts", fromSymbol: "callFoo", toSymbol: "fooHandler" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "src/a.ts" }],
      [{ pathOrSymbol: "src/b.ts" }],
      edges,
    );
    expect(result.triggeringEdges[0]?.callerSymbol).toBe("callFoo");
    expect(result.triggeringEdges[0]?.calleeSymbol).toBe("fooHandler");
  });

  it("detects reverse-direction edges (B→A)", () => {
    const edges = [{ from: "src/b.ts", to: "src/a.ts" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "src/a.ts" }],
      [{ pathOrSymbol: "src/b.ts" }],
      edges,
    );
    expect(result.score).toBeGreaterThan(0);
  });

  it("returns 0 for unrelated edges", () => {
    const edges = [{ from: "unrelated.ts", to: "other.ts" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "src/a.ts" }],
      [{ pathOrSymbol: "src/b.ts" }],
      edges,
    );
    expect(result.score).toBe(0);
    expect(result.triggeringEdges).toHaveLength(0);
  });

  it("score is capped at 1.0 with multiple triggering edges", () => {
    const edges = [
      { from: "a.ts", to: "b.ts" },
      { from: "a.ts", to: "c.ts" },
      { from: "a.ts", to: "d.ts" },
    ];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "a.ts" }],
      [{ pathOrSymbol: "b.ts" }, { pathOrSymbol: "c.ts" }, { pathOrSymbol: "d.ts" }],
      edges,
    );
    expect(result.score).toBeLessThanOrEqual(1.0);
    expect(result.triggeringEdges.length).toBeGreaterThan(0);
  });

  it("suppresses blast-radius when edge fromSymbol is NOT in claimed symbols for that file", () => {
    const edges = [{ from: "auth.ts", to: "src/db.ts", fromSymbol: "initSession" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "auth.ts", symbols: ["handleLogin"] }],
      [{ pathOrSymbol: "src/db.ts" }],
      edges,
    );
    expect(result.score).toBe(0);
    expect(result.triggeringEdges).toHaveLength(0);
  });

  it("allows blast-radius edge when fromSymbol IS in claimed symbols", () => {
    const edges = [{ from: "auth.ts", to: "src/db.ts", fromSymbol: "handleLogin" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "auth.ts", symbols: ["handleLogin"] }],
      [{ pathOrSymbol: "src/db.ts" }],
      edges,
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.triggeringEdges).toHaveLength(1);
    expect(result.triggeringEdges[0]?.callerSymbol).toBe("handleLogin");
  });

  it("suppresses blast-radius when edge toSymbol is NOT in claimed symbols for the callee side", () => {
    const edges = [{ from: "auth.ts", to: "db.ts", toSymbol: "queryRaw" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "auth.ts" }],
      [{ pathOrSymbol: "db.ts", symbols: ["saveUser"] }],
      edges,
    );
    expect(result.score).toBe(0);
    expect(result.triggeringEdges).toHaveLength(0);
  });

  it("allows blast-radius when edge has no symbol metadata (file-level fallback)", () => {
    const edges = [{ from: "auth.ts", to: "db.ts" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "auth.ts", symbols: ["handleLogin"] }],
      [{ pathOrSymbol: "db.ts", symbols: ["saveUser"] }],
      edges,
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.triggeringEdges).toHaveLength(1);
  });

  it("allows blast-radius when claim has no symbols (file-level fallback per side)", () => {
    const edges = [{ from: "auth.ts", to: "db.ts", fromSymbol: "handleLogin" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "auth.ts" }],
      [{ pathOrSymbol: "db.ts" }],
      edges,
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.triggeringEdges).toHaveLength(1);
  });

  // ── Same-file / both-claimed edge regression tests ──

  it("same-file edge: still triggers when B owns the calling symbol (B-as-caller path)", () => {
    // Lane A claims shared.ts with symbol "renderUI"; Lane B claims shared.ts with "fetchData".
    // Edge: shared.ts/fetchData → shared.ts/renderUI (B calls into A).
    // Should trigger because B IS the caller side, even though A is checked first.
    const edges = [{ from: "shared.ts", to: "shared.ts", fromSymbol: "fetchData", toSymbol: "renderUI" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "shared.ts", symbols: ["renderUI"] }],
      [{ pathOrSymbol: "shared.ts", symbols: ["fetchData"] }],
      edges,
    );
    expect(result.score).toBeGreaterThan(0);
    expect(result.triggeringEdges).toHaveLength(1);
  });

  it("same-file edge: suppressed when neither side owns the caller symbol", () => {
    // Both sides claim shared.ts but with unrelated symbols; the edge caller is an unclaimed symbol.
    const edges = [{ from: "shared.ts", to: "shared.ts", fromSymbol: "unclaimed", toSymbol: "renderUI" }];
    const result = estimateBlastRadiusOverlapAnnotated(
      [{ pathOrSymbol: "shared.ts", symbols: ["renderUI"] }],
      [{ pathOrSymbol: "shared.ts", symbols: ["fetchData"] }],
      edges,
    );
    expect(result.score).toBe(0);
    expect(result.triggeringEdges).toHaveLength(0);
  });

  it("reversed lane order: edge still detected when lane ordering is swapped", () => {
    // If A and B are swapped relative to the original order, the edge should still be found.
    const edges = [{ from: "src/b.ts", to: "src/a.ts", fromSymbol: "callerFn" }];
    const claimsA = [{ pathOrSymbol: "src/a.ts" }];
    const claimsB = [{ pathOrSymbol: "src/b.ts", symbols: ["callerFn"] }];
    const result = estimateBlastRadiusOverlapAnnotated(claimsA, claimsB, edges);
    expect(result.score).toBeGreaterThan(0);
    expect(result.triggeringEdges).toHaveLength(1);
  });
});
