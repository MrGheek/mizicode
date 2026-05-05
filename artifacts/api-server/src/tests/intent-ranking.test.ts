/**
 * Unit tests verifying that SessionContext.intentText is a real ranking signal
 * in the Smart Skills ranker.
 *
 * Covers:
 *   - intentFit returns 0 when intentText is absent or too short (≤ 10 chars)
 *   - intentFit returns > 0 when intent keywords match manifest fields
 *   - intentFit is capped at 1.0
 *   - rankSkills orders manifests differently when intentText changes
 *   - Two sessions with the same taskMode but different goals pick different
 *     top-ranked skills
 *   - stop-words are ignored and do not inflate the score
 *   - Very short intent (≤ 10 chars) produces zero score, leaving ranking unchanged
 *   - Code snippets wrapped in backticks are stripped from token extraction
 *
 * No DB mocks needed — rankSkills and intentFit are pure functions.
 */

import { describe, it, expect } from "vitest";
import { rankSkills, intentFit } from "../services/skills-ranker";
import type { FloatrSkillManifest, SessionContext } from "../services/skills-types";

// ---------------------------------------------------------------------------
// Minimal manifest factory
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<FloatrSkillManifest> & { id: string }): FloatrSkillManifest {
  return {
    schemaVersion: 1,
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    class: overrides.class ?? "workflow",
    source: overrides.source ?? {
      repoUrl: "https://github.com/floatr/skills",
      trust: "floatr_native",
    },
    summary: overrides.summary ?? "",
    triggers: overrides.triggers ?? {
      tasks: ["build"],
      repoKinds: ["any"],
      sessionModes: ["solo"],
    },
    compatibility: overrides.compatibility ?? { models: ["all"], interfaces: ["all"] },
    instructions: overrides.instructions ?? { system: [] },
    install: overrides.install ?? { type: "virtual", outputs: [] },
    cost: overrides.cost ?? { tokenOverheadEstimate: 100 },
    rankingHints: overrides.rankingHints ?? {
      taskFitWeight: 1.0,
      repoFitWeight: 0.5,
      measuredLiftWeight: 0.0,
    },
    safety: overrides.safety ?? { shellExecution: "none", networkAccess: "none" },
  };
}

// ---------------------------------------------------------------------------
// Base session context
// ---------------------------------------------------------------------------

function baseCtx(intentText?: string): SessionContext {
  return {
    sessionType: "solo",
    taskMode: "build",
    modelProfile: "gpt-4o",
    repoLangs: ["ts"],
    tokenMode: "core",
    intentText,
  };
}

// ---------------------------------------------------------------------------
// Manifests used across multiple tests
// ---------------------------------------------------------------------------

const stripeSkill = makeManifest({
  id: "stripe-payments",
  name: "Stripe Payments",
  summary: "Handles Stripe checkout integration, billing, and subscription management",
  triggers: { tasks: ["build"], repoKinds: ["any"], sessionModes: ["solo"] },
});

const authSkill = makeManifest({
  id: "auth-middleware",
  name: "Auth Middleware",
  summary: "JWT and API key authentication middleware, session management",
  triggers: { tasks: ["build"], repoKinds: ["any"], sessionModes: ["solo"] },
});

const refactorSkill = makeManifest({
  id: "refactor-helper",
  name: "Refactor Helper",
  summary: "Assists with code restructuring, dead code removal, and naming conventions",
  triggers: { tasks: ["refactor", "build"], repoKinds: ["any"], sessionModes: ["solo"] },
});

// ---------------------------------------------------------------------------
// intentFit unit tests
// ---------------------------------------------------------------------------

describe("intentFit", () => {
  it("returns 0 when intentText is absent", () => {
    expect(intentFit(stripeSkill, baseCtx(undefined))).toBe(0);
  });

  it("returns 0 when intentText is empty string", () => {
    expect(intentFit(stripeSkill, baseCtx(""))).toBe(0);
  });

  it("returns 0 when intentText is ≤ 10 chars (gate threshold)", () => {
    expect(intentFit(stripeSkill, baseCtx("Stripe"))).toBe(0);
    expect(intentFit(stripeSkill, baseCtx("checkout"))).toBe(0);
  });

  it("returns > 0 when intent keywords match manifest summary", () => {
    const score = intentFit(stripeSkill, baseCtx("Add Stripe checkout to the billing page"));
    expect(score).toBeGreaterThan(0);
  });

  it("returns > 0 when intent keywords match manifest name", () => {
    const score = intentFit(authSkill, baseCtx("Refactor auth middleware to support API keys"));
    expect(score).toBeGreaterThan(0);
  });

  it("score is capped at 1.0", () => {
    const longIntent = "stripe checkout billing subscription payments stripe checkout billing subscription payments";
    const score = intentFit(stripeSkill, baseCtx(longIntent));
    expect(score).toBeLessThanOrEqual(1.0);
    expect(score).toBeGreaterThan(0);
  });

  it("stop-words do not inflate the score (all-stopword intent returns 0)", () => {
    const stopWordOnly = "the and for with that this from into have been will";
    const score = intentFit(stripeSkill, baseCtx(stopWordOnly));
    expect(score).toBe(0);
  });

  it("backtick-wrapped code is stripped before tokenising", () => {
    const intentWithCode = "Refactor the `authentication` `middleware` to support `apikeys`";
    const scoreWithCode = intentFit(authSkill, baseCtx(intentWithCode));
    const intentPlain = "Refactor the authentication middleware to support apikeys";
    const scorePlain = intentFit(authSkill, baseCtx(intentPlain));
    expect(scoreWithCode).toBe(0);
    expect(scorePlain).toBeGreaterThanOrEqual(scoreWithCode);
  });

  it("matching is case-insensitive (lowercase intent finds mixed-case manifest)", () => {
    const score = intentFit(stripeSkill, baseCtx("add stripe checkout and billing integration"));
    expect(score).toBeGreaterThan(0);
  });

  it("non-matching intent returns 0 for unrelated skill", () => {
    const score = intentFit(refactorSkill, baseCtx("Add Stripe checkout to the billing page"));
    expect(score).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// rankSkills — intent as a differentiating signal
// ---------------------------------------------------------------------------

describe("rankSkills — intent signal differentiates same-taskMode sessions", () => {
  it("Stripe-focused goal ranks stripeSkill above authSkill", () => {
    const ctx = baseCtx("Add Stripe checkout and billing subscription to the payments page");
    const ranked = rankSkills([stripeSkill, authSkill], ctx);
    const stripeRank = ranked.findIndex(r => r.manifest.id === "stripe-payments");
    const authRank = ranked.findIndex(r => r.manifest.id === "auth-middleware");
    expect(stripeRank).toBeLessThan(authRank);
  });

  it("auth-focused goal ranks authSkill above stripeSkill", () => {
    const ctx = baseCtx("Refactor auth middleware to support API keys and session tokens");
    const ranked = rankSkills([stripeSkill, authSkill], ctx);
    const stripeRank = ranked.findIndex(r => r.manifest.id === "stripe-payments");
    const authRank = ranked.findIndex(r => r.manifest.id === "auth-middleware");
    expect(authRank).toBeLessThan(stripeRank);
  });

  it("same taskMode, different goals → different top-ranked skill", () => {
    const ctxStripe = baseCtx("Add Stripe checkout and billing subscription to the payments page");
    const ctxAuth = baseCtx("Refactor auth middleware to support API keys and session tokens");

    const rankedStripe = rankSkills([stripeSkill, authSkill], ctxStripe);
    const rankedAuth = rankSkills([stripeSkill, authSkill], ctxAuth);

    expect(rankedStripe[0].manifest.id).not.toBe(rankedAuth[0].manifest.id);
  });

  it("no intent → rankSkills produces valid output (intent does not crash absent context)", () => {
    const ctx = baseCtx(undefined);
    const ranked = rankSkills([stripeSkill, authSkill, refactorSkill], ctx);
    expect(ranked).toHaveLength(3);
    expect(ranked.every(r => typeof r.score === "number" && isFinite(r.score))).toBe(true);
  });

  it("short intent (≤ 10 chars) does not change ranking relative to no-intent baseline", () => {
    const ctxNone = baseCtx(undefined);
    const ctxShort = baseCtx("Stripe");

    const rankedNone = rankSkills([stripeSkill, authSkill], ctxNone);
    const rankedShort = rankSkills([stripeSkill, authSkill], ctxShort);

    expect(rankedNone[0].manifest.id).toBe(rankedShort[0].manifest.id);
    expect(rankedNone[1].manifest.id).toBe(rankedShort[1].manifest.id);
  });

  it("intent score is additive — higher total score for matching manifest", () => {
    const ctx = baseCtx("Add Stripe checkout and billing subscription to the payments page");
    const ranked = rankSkills([stripeSkill, authSkill], ctx);

    const stripeEntry = ranked.find(r => r.manifest.id === "stripe-payments")!;
    const authEntry = ranked.find(r => r.manifest.id === "auth-middleware")!;

    expect(stripeEntry.score).toBeGreaterThan(authEntry.score);
  });

  it("bundle-level: same taskMode + different goals → different top-3 skill selections", () => {
    // Simulate bundler skill selection: rank a pool of skills and take the top N.
    // This mirrors what compileBundle does after calling rankSkills.
    const debtSkill = makeManifest({
      id: "tech-debt-scanner",
      name: "Tech Debt Scanner",
      summary: "Identifies legacy code, dead code, and technical debt patterns",
      triggers: { tasks: ["build", "refactor"], repoKinds: ["any"], sessionModes: ["solo"] },
    });
    const securitySkill = makeManifest({
      id: "security-audit",
      name: "Security Audit",
      summary: "Detects authentication vulnerabilities and insecure API access patterns",
      triggers: { tasks: ["build", "review"], repoKinds: ["any"], sessionModes: ["solo"] },
    });

    const pool = [stripeSkill, authSkill, refactorSkill, debtSkill, securitySkill];
    const TOP_N = 3;

    const ctxStripe = baseCtx("Add Stripe checkout and billing subscription to the payments page");
    const ctxSecurity = baseCtx("Audit authentication vulnerabilities and insecure API access patterns");

    const bundleForStripe = rankSkills(pool, ctxStripe).slice(0, TOP_N).map(r => r.manifest.id);
    const bundleForSecurity = rankSkills(pool, ctxSecurity).slice(0, TOP_N).map(r => r.manifest.id);

    // The two goal-driven bundles must differ in at least one skill slot.
    const sameIds = bundleForStripe.filter(id => bundleForSecurity.includes(id));
    expect(sameIds.length).toBeLessThan(TOP_N);

    // Spot-check: Stripe skill should appear in the payment-focused bundle
    expect(bundleForStripe).toContain("stripe-payments");
    // Spot-check: security/auth skill should appear in the security-focused bundle
    const securityBundle = bundleForSecurity;
    expect(
      securityBundle.includes("auth-middleware") || securityBundle.includes("security-audit"),
    ).toBe(true);
  });
});
