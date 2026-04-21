/**
 * Unit tests for lane-policy service.
 * Tests computeClaimOverlap and estimateBlastRadiusOverlap without any database access.
 */

import { describe, it, expect } from "vitest";
import {
  computeClaimOverlap,
  estimateBlastRadiusOverlap,
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
