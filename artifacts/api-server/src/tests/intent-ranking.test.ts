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
import type { MiziSkillManifest, SessionContext } from "../services/skills-types";

// ---------------------------------------------------------------------------
// Minimal manifest factory
// ---------------------------------------------------------------------------

function makeManifest(overrides: Partial<MiziSkillManifest> & { id: string }): MiziSkillManifest {
  return {
    schemaVersion: 1,
    id: overrides.id,
    name: overrides.name ?? overrides.id,
    class: overrides.class ?? "workflow",
    source: overrides.source ?? {
      repoUrl: "https://github.com/mizi/skills",
      trust: "mizi_native",
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

// ---------------------------------------------------------------------------
// rankSkills — language-specific workflow skills rank for their repo type
// ---------------------------------------------------------------------------

const LANG_NATIVE_SOURCE = { repoUrl: "https://github.com/mizi/skills", trust: "mizi_native" as const };

const pythonWorkflow = makeManifest({
  id: "python-workflow",
  name: "Python Workflow",
  class: "efficiency",
  source: LANG_NATIVE_SOURCE,
  summary: "Idiomatic Python toolchain guidance — uv for packages, mypy/ruff for quality, pytest via uv run — prevents broken venvs and silent type errors.",
  triggers: {
    tasks: ["build", "debug", "refactor", "review"],
    repoKinds: ["python", "django", "fastapi", "flask"],
    sessionModes: ["solo", "team"],
  },
  compatibility: { models: ["kimi", "qwen", "glm", "deepseek", "minimax"], interfaces: ["claw", "vscode", "bolt"] },
  cost: { tokenOverheadEstimate: 200 },
  rankingHints: { taskFitWeight: 0.9, repoFitWeight: 0.9, measuredLiftWeight: 0.9 },
});

const goWorkflow = makeManifest({
  id: "go-workflow",
  name: "Go Workflow",
  class: "efficiency",
  source: LANG_NATIVE_SOURCE,
  summary: "Idiomatic Go toolchain guidance — build, vet, mod tidy, gofmt — prevents silent compile failures and import errors.",
  triggers: {
    tasks: ["build", "debug", "refactor", "review"],
    repoKinds: ["go", "golang"],
    sessionModes: ["solo", "team"],
  },
  compatibility: { models: ["kimi", "qwen", "glm", "deepseek", "minimax"], interfaces: ["claw", "vscode", "bolt"] },
  cost: { tokenOverheadEstimate: 160 },
  rankingHints: { taskFitWeight: 0.9, repoFitWeight: 0.9, measuredLiftWeight: 0.9 },
});

const rustWorkflow = makeManifest({
  id: "rust-workflow",
  name: "Rust Workflow",
  class: "efficiency",
  source: LANG_NATIVE_SOURCE,
  summary: "Idiomatic Rust toolchain guidance — cargo check, clippy, fmt, cargo add — prevents silent compile failures and avoids hand-editing Cargo.toml.",
  triggers: {
    tasks: ["build", "debug", "refactor", "review"],
    repoKinds: ["rust"],
    sessionModes: ["solo", "team"],
  },
  compatibility: { models: ["kimi", "qwen", "glm", "deepseek", "minimax"], interfaces: ["claw", "vscode", "bolt"] },
  cost: { tokenOverheadEstimate: 180 },
  rankingHints: { taskFitWeight: 0.9, repoFitWeight: 0.95, measuredLiftWeight: 0.9 },
});

// Five generic competitor skills with repoKinds: ["any"] — broad but not
// language-specialised. They score well (~5.05 each) against a deepseek
// model profile but cannot match the language-specific repoFit boost that
// the workflow skills earn when the session language aligns.
const genericCompetitors = ["generic-a", "generic-b", "generic-c", "generic-d", "generic-e"].map(id =>
  makeManifest({
    id,
    name: id,
    summary: `General-purpose skill: ${id}`,
    triggers: { tasks: ["build"], repoKinds: ["any"], sessionModes: ["solo"] },
    compatibility: { models: ["all"], interfaces: ["all"] },
    cost: { tokenOverheadEstimate: 100 },
    rankingHints: { taskFitWeight: 1.0, repoFitWeight: 0.5, measuredLiftWeight: 0.0 },
  }),
);

// Helper: build a build-mode session context for a given language.
// modelProfile "deepseek" is in the compatibility list of all three language
// workflow skills, giving them full modelFit (1.0) and making the repo-kind
// signal the clean differentiator under test.
function langCtx(lang: string): SessionContext {
  return {
    sessionType: "solo",
    taskMode: "build",
    modelProfile: "deepseek",
    repoLangs: [lang],
    tokenMode: "core",
  };
}

describe("rankSkills — language workflow skills rank in top 5 for their repo type", () => {
  it("python-workflow ranks in top 5 for a Python build session", () => {
    const pool = [...genericCompetitors, pythonWorkflow, goWorkflow, rustWorkflow];
    const ranked = rankSkills(pool, langCtx("python"));
    const position = ranked.findIndex(r => r.manifest.id === "python-workflow");
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(5);
  });

  it("go-workflow ranks in top 5 for a Go build session", () => {
    const pool = [...genericCompetitors, pythonWorkflow, goWorkflow, rustWorkflow];
    const ranked = rankSkills(pool, langCtx("go"));
    const position = ranked.findIndex(r => r.manifest.id === "go-workflow");
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(5);
  });

  it("rust-workflow ranks in top 5 for a Rust build session", () => {
    const pool = [...genericCompetitors, pythonWorkflow, goWorkflow, rustWorkflow];
    const ranked = rankSkills(pool, langCtx("rust"));
    const position = ranked.findIndex(r => r.manifest.id === "rust-workflow");
    expect(position).toBeGreaterThanOrEqual(0);
    expect(position).toBeLessThan(5);
  });

  it("go-workflow does NOT appear in top 5 for a Python build session", () => {
    // python-workflow (repoKinds: python/django/fastapi/flask) gets full
    // repoFit against repoLangs:["python"]; go-workflow (repoKinds: go/golang)
    // falls back to the no-match score (0.2) and is pushed outside the top 5
    // by python-workflow plus the five generic competitors.
    const pool = [...genericCompetitors, pythonWorkflow, goWorkflow];
    const ranked = rankSkills(pool, langCtx("python"));
    const position = ranked.findIndex(r => r.manifest.id === "go-workflow");
    expect(position).toBeGreaterThanOrEqual(5);
  });
});
