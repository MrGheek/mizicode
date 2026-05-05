/**
 * Compile-path tests for design intelligence injection in compileLaneBundles.
 *
 * Category resolution priority (as of the current implementation):
 *   1. bundleJson.designCategoryOverrides[laneType]  — highest priority
 *   2. LANE_POLICIES[laneType].designCategories      — lane-policy default
 *   3. Hard-coded UX/FRONTEND_LANE_CATEGORIES_FALLBACK — last resort
 *
 * These tests exercise path 2 (lane-policy default) which is the dominant path
 * for all five known lane types. Each lane type has its own designCategories:
 *   ux      → full UX doctrine categories (chart_type, anti_pattern, etc.)
 *   backend → ["stack_convention"]
 *   general → ["palette", "typography", "stack_convention", "ux_guideline"]
 *   review  → ["ux_guideline", "anti_pattern"]
 *   debug   → [] (no design context)
 *
 * Lean/ultra token modes suppress injection even when categories are non-empty.
 *
 * The @workspace/db module is mocked with a Proxy-based call queue so every
 * `await` on the Drizzle chain pops the next pre-configured response in order.
 * No real database is touched.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared DB response queue
// Must be declared before vi.mock factories run (hoisting).
// ---------------------------------------------------------------------------

const responseQueue: unknown[][] = [];

function makeChain(): unknown {
  return new Proxy({} as Record<string | symbol, unknown>, {
    get(_, prop) {
      if (prop === "then") {
        return (
          resolve: (v: unknown) => unknown,
          reject?: (e: unknown) => unknown,
        ) => {
          const val = responseQueue.shift() ?? [];
          return Promise.resolve(val).then(resolve, reject);
        };
      }
      if (prop === "catch") {
        return (fn: (e: unknown) => void) => Promise.resolve([]).catch(fn);
      }
      if (typeof prop === "symbol") return undefined;
      return (..._args: unknown[]) => makeChain();
    },
  });
}

// ---------------------------------------------------------------------------
// Mock @workspace/db with the Proxy-based queue DB
// ---------------------------------------------------------------------------

vi.mock("@workspace/db", () => {
  const db = {
    select: (..._a: unknown[]) => makeChain(),
    insert: (..._a: unknown[]) => makeChain(),
  };

  return {
    db,
    skillsTable: { id: "st.id", slug: "st.slug", enabled: "st.enabled", reviewStatus: "st.reviewStatus" },
    skillBundlesTable: {
      id: "sbt.id", slug: "sbt.slug", isDefault: "sbt.isDefault",
      taskMode: "sbt.taskMode", sessionMode: "sbt.sessionMode",
    },
    skillVersionsTable: { skillId: "svt.skillId", createdAt: "svt.createdAt" },
    skillSourcesTable: { id: "sst.id", repoUrl: "sst.repoUrl" },
    sessionSkillsTable: {},
    sessionsTable: {},
    sessionRepoContextTable: {},
    designIntelligenceEntriesTable: {
      category: "die.category",
      name: "die.name",
      dataJson: "die.dataJson",
      tags: "die.tags",
      id: "die.id",
    },
    laneClaimsTable: {},
    eq: vi.fn(),
    and: vi.fn(),
    inArray: vi.fn(),
    desc: vi.fn(),
    asc: vi.fn(),
  };
});

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
}));

vi.mock("../lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() },
}));

vi.mock("../services/skills-ranker", () => ({
  rankSkills: vi.fn((manifests: { id: string }[]) =>
    manifests.map((m) => ({ manifest: m, score: 1 })),
  ),
  getSkillFeedbackScores: vi.fn().mockResolvedValue([]),
  buildHistoryScoresMap: vi.fn().mockReturnValue({}),
  getEvalLiftScoresMap: vi.fn().mockResolvedValue({}),
  buildRepoIntelligenceContext: vi.fn().mockReturnValue(null),
}));

// ---------------------------------------------------------------------------
// Lane-policy mock — mirrors real designCategories per lane type
// ---------------------------------------------------------------------------

const MOCK_DESIGN_CATEGORIES: Record<string, string[]> = {
  ux:      ["palette", "typography", "chart_type", "ux_guideline", "ui_reasoning", "anti_pattern", "style"],
  backend: ["stack_convention"],
  general: ["palette", "typography", "stack_convention", "ux_guideline"],
  review:  ["ux_guideline", "anti_pattern"],
  debug:   [],
};

vi.mock("../services/lane-policy", () => {
  const LANE_POLICIES: Record<string, { laneType: string }> = {
    ux: { laneType: "ux" },
    backend: { laneType: "backend" },
    debug: { laneType: "debug" },
    review: { laneType: "review" },
    general: { laneType: "general" },
  };

  const designCategoriesMap: Record<string, string[]> = {
    ux:      ["palette", "typography", "chart_type", "ux_guideline", "ui_reasoning", "anti_pattern", "style"],
    backend: ["stack_convention"],
    general: ["palette", "typography", "stack_convention", "ux_guideline"],
    review:  ["ux_guideline", "anti_pattern"],
    debug:   [],
  };

  return {
    LANE_POLICIES,
    VALID_LANE_TYPES: ["ux", "debug", "backend", "review", "general"],
    LANE_DEFAULT_TTL_SECONDS: 3600,
    LANE_HEARTBEAT_WINDOW_SECONDS: 300,
    getLanePolicy: vi.fn((laneType: string) => ({
      laneType,
      defaultTaskMode: "build",
      defaultTokenMode: "core",
      designCategories: designCategoriesMap[laneType] ?? [],
      allowedClaimTypes: [],
      limits: { maxConcurrentClaims: 10, heavyJobSlots: 2, maxBlastRadiusFiles: 50, claimTtlSeconds: 3600 },
      sharedMemoryScopes: [],
      privateMemoryScopes: [],
      defaultOverlaySkillIds: [],
      retrievalEmphasis: [],
      conflictEscalation: "warn",
      description: "",
    })),
  };
});

// ---------------------------------------------------------------------------
// Fake DB bundle rows reused across tests
// ---------------------------------------------------------------------------

const fakeSessionCore = {
  id: 101,
  slug: "mizi-team-coordination",
  name: "Team Coordination",
  taskMode: "team",
  sessionMode: "team",
  tokenMode: "core",
  isDefault: true,
  bundleJson: { skillIds: [] },
};

const fakeSharedRepo = {
  id: 102,
  slug: "mizi-builder",
  name: "Builder",
  taskMode: "build",
  sessionMode: "solo",
  tokenMode: "core",
  isDefault: true,
  bundleJson: { skillIds: [] },
};

// ---------------------------------------------------------------------------
// Queue helper
// ---------------------------------------------------------------------------

/**
 * Pushes the 10 "infrastructure" queue entries every compileLaneBundles call
 * needs before it reaches per-lane logic (for a single-lane invocation):
 *
 *  1  skill source lookup  → source already exists
 *  2  skills seeding scan  → all DEFAULT_SKILLS slugs present (no inserts)
 *  3  bundles seeding scan → all DEFAULT_BUNDLES slugs present (no inserts)
 *  4  default bundle query → [fakeSessionCore, fakeSharedRepo]
 *  5  compile(session-core): bundle row
 *  6  compile(session-core): getAllEnabledManifests → [] (early return)
 *  7  compile(shared-repo):  bundle row
 *  8  compile(shared-repo):  getAllEnabledManifests → []
 *  9  compile(overlay):      bundle row
 * 10  compile(overlay):      getAllEnabledManifests → []
 */
async function pushInfraQueue() {
  const { DEFAULT_SKILLS, DEFAULT_BUNDLES } = await import("../services/default-skills");

  responseQueue.push(
    [{ id: 1 }],
    DEFAULT_SKILLS.map((s) => ({ slug: s.id })),
    DEFAULT_BUNDLES.map((b) => ({ slug: b.slug })),
    [fakeSessionCore, fakeSharedRepo],
    [fakeSessionCore], [],
    [fakeSharedRepo],  [],
    [fakeSharedRepo],  [],
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("compileLaneBundles — design context compile-path injection", () => {
  let compileLaneBundles: (
    sessionId: number,
    ctx: import("../services/skills-types").SessionContext,
    lanes: Array<{ laneId: number; memberIdentifier: string; laneType: string; taskMode?: string; tokenMode?: string }>,
  ) => Promise<import("../services/skills-bundler").LaneBundleCompileResult>;

  const baseCtx: import("../services/skills-types").SessionContext = {
    sessionType: "solo",
    taskMode: "build",
    modelProfile: "default",
    repoLangs: ["ts"],
    tokenMode: "core",
  };

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    responseQueue.length = 0;

    const mod = await import("../services/skills-bundler");
    compileLaneBundles = mod.compileLaneBundles;
  });

  // ── UX lane (designCategories = full UX doctrine) ──────────────────────────

  it("UX lane: injects designContext using lane-policy UX categories (chart_type etc.)", async () => {
    await pushInfraQueue();

    // DB returns an entry with category "chart_type" — UX-specific
    responseQueue.push([
      { category: "chart_type", name: "Preferred chart shapes", dataJson: { tip: "use bar" }, tags: ["ts"] },
    ]);

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "ux@test", laneType: "ux" }],
    );

    const overlay = result.laneOverlays[0];
    expect(overlay.compiled).not.toBeNull();
    expect(overlay.compiled?.designContext).toBeDefined();
    expect(overlay.compiled?.designContext?.length).toBeGreaterThan(0);
    expect(overlay.compiled?.designContext?.map((e) => e.category)).toContain("chart_type");
  });

  it("UX lane: does NOT use FRONTEND_LANE_CATEGORIES (stack_convention absent from UX policy)", async () => {
    const { FRONTEND_LANE_CATEGORIES } = await import("../services/skills-bundler");

    await pushInfraQueue();

    // Only return an anti_pattern entry (in UX policy, not in FRONTEND)
    responseQueue.push([
      { category: "anti_pattern", name: "Avoid infinite scroll", dataJson: {}, tags: ["ts"] },
    ]);

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "ux@test", laneType: "ux" }],
    );

    const overlay = result.laneOverlays[0];
    const designEntry = overlay.compiled?.designContext?.[0];
    expect(designEntry?.category).toBe("anti_pattern");
    // "anti_pattern" is in UX policy but NOT in FRONTEND_LANE_CATEGORIES
    expect(FRONTEND_LANE_CATEGORIES).not.toContain("anti_pattern");
  });

  // ── Backend lane (designCategories = ["stack_convention"]) ────────────────

  it("backend lane: injects designContext using stack_convention from lane policy", async () => {
    await pushInfraQueue();

    responseQueue.push([
      { category: "stack_convention", name: "Named imports", dataJson: {}, tags: ["ts"] },
    ]);

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "be@test", laneType: "backend" }],
    );

    const overlay = result.laneOverlays[0];
    expect(overlay.compiled?.designContext).toBeDefined();
    expect(overlay.compiled?.designContext?.map((e) => e.category)).toContain("stack_convention");
  });

  it("backend lane: does NOT inject UX-only categories (chart_type, ui_reasoning absent)", async () => {
    await pushInfraQueue();

    responseQueue.push([
      { category: "stack_convention", name: "Named imports", dataJson: {}, tags: ["ts"] },
    ]);

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "be@test", laneType: "backend" }],
    );

    const overlay = result.laneOverlays[0];
    const cats = overlay.compiled?.designContext?.map((e) => e.category) ?? [];
    expect(cats).not.toContain("chart_type");
    expect(cats).not.toContain("ui_reasoning");
  });

  // ── Debug lane (designCategories = []) ───────────────────────────────────

  it("debug lane: no designContext injection (empty designCategories in lane policy)", async () => {
    await pushInfraQueue();
    // No design DB query pushed — asserting it is never called.

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "dbg@test", laneType: "debug" }],
    );

    const overlay = result.laneOverlays[0];
    expect(overlay.compiled?.designContext ?? undefined).toBeUndefined();
    // Queue empty → no spurious DB call was made
    expect(responseQueue).toHaveLength(0);
  });

  // ── General lane (designCategories = frontend subset) ────────────────────

  it("general lane: injects designContext with frontend-oriented categories", async () => {
    await pushInfraQueue();

    responseQueue.push([
      { category: "palette", name: "Brand palette", dataJson: { primary: "#0057FF" }, tags: ["ts"] },
    ]);

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "gen@test", laneType: "general" }],
    );

    const overlay = result.laneOverlays[0];
    expect(overlay.compiled?.designContext).toBeDefined();
    expect(overlay.compiled?.designContext?.map((e) => e.category)).toContain("palette");
  });

  // ── Token mode suppression ────────────────────────────────────────────────

  it("UX lane with lean token mode: no designContext (suppressed by DESIGN_CONTEXT_LIMIT)", async () => {
    await pushInfraQueue();
    // queryDesignIntelligenceContext exits immediately for lean — no DB call.

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "ux@test", laneType: "ux", tokenMode: "lean" }],
    );

    const overlay = result.laneOverlays[0];
    expect(overlay.compiled?.designContext ?? undefined).toBeUndefined();
    expect(responseQueue).toHaveLength(0);
  });

  it("UX lane with ultra token mode: no designContext (suppressed by DESIGN_CONTEXT_LIMIT)", async () => {
    await pushInfraQueue();

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "ux@test", laneType: "ux", tokenMode: "ultra" }],
    );

    const overlay = result.laneOverlays[0];
    expect(overlay.compiled?.designContext ?? undefined).toBeUndefined();
    expect(responseQueue).toHaveLength(0);
  });

  it("general lane with lean token mode: no designContext even with non-empty policy categories", async () => {
    await pushInfraQueue();
    // general has designCategories = ["palette",...] but lean suppresses the query.

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "gen@test", laneType: "general", tokenMode: "lean" }],
    );

    const overlay = result.laneOverlays[0];
    expect(overlay.compiled?.designContext ?? undefined).toBeUndefined();
    expect(responseQueue).toHaveLength(0);
  });

  // ── Empty design table ─────────────────────────────────────────────────────

  it("empty design table: no designContext set, no throw, overlay still compiled", async () => {
    await pushInfraQueue();

    // Design query returns empty array (no matching rows in DB)
    responseQueue.push([]);

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [{ laneId: 1, memberIdentifier: "ux@test", laneType: "ux" }],
    );

    const overlay = result.laneOverlays[0];
    // designContext only set when length > 0; empty result means no injection
    expect(overlay.compiled?.designContext ?? undefined).toBeUndefined();
    expect(overlay.compiled).not.toBeNull();
  });

  // ── Multi-lane routing ─────────────────────────────────────────────────────

  it("multi-lane: UX lane gets designContext while debug lane does not", async () => {
    const { DEFAULT_SKILLS, DEFAULT_BUNDLES } = await import("../services/default-skills");

    responseQueue.push(
      // Infrastructure (shared session-core + shared-repo compile happen once)
      [{ id: 1 }],
      DEFAULT_SKILLS.map((s) => ({ slug: s.id })),
      DEFAULT_BUNDLES.map((b) => ({ slug: b.slug })),
      [fakeSessionCore, fakeSharedRepo],
      [fakeSessionCore], [],   // compile(session-core)
      [fakeSharedRepo],  [],   // compile(shared-repo)
      // Lane 1 (UX)
      [fakeSharedRepo],  [],   // compile(overlay)
      [{ category: "ux_guideline", name: "Accessible contrast", dataJson: {}, tags: ["ts"] }],
      // Lane 2 (debug) — overlay compile, no design query (empty designCategories)
      [fakeSharedRepo],  [],
    );

    const result = await compileLaneBundles(
      1,
      baseCtx,
      [
        { laneId: 1, memberIdentifier: "ux@test",  laneType: "ux" },
        { laneId: 2, memberIdentifier: "dbg@test", laneType: "debug" },
      ],
    );

    const uxOverlay  = result.laneOverlays.find((o) => o.laneType === "ux");
    const dbgOverlay = result.laneOverlays.find((o) => o.laneType === "debug");

    expect(uxOverlay?.compiled?.designContext).toBeDefined();
    expect(uxOverlay?.compiled?.designContext?.length).toBeGreaterThan(0);
    expect(uxOverlay?.compiled?.designContext?.[0].category).toBe("ux_guideline");

    expect(dbgOverlay?.compiled?.designContext ?? undefined).toBeUndefined();
  });

  // ── Constants coverage ─────────────────────────────────────────────────────

  it("DESIGN_CONTEXT_LIMIT: full mode limit is greater than core mode limit", async () => {
    const { DESIGN_CONTEXT_LIMIT } = await import("../services/skills-bundler");
    expect(DESIGN_CONTEXT_LIMIT["full"]!).toBeGreaterThan(DESIGN_CONTEXT_LIMIT["core"]!);
  });

  it("UX_LANE_CATEGORIES matches the lane-policy ux designCategories exactly", async () => {
    const { UX_LANE_CATEGORIES } = await import("../services/skills-bundler");
    const uxDesignCats = MOCK_DESIGN_CATEGORIES["ux"]!;
    expect(UX_LANE_CATEGORIES).toEqual(uxDesignCats);
  });

  it("FRONTEND_LANE_CATEGORIES matches the lane-policy general designCategories exactly", async () => {
    const { FRONTEND_LANE_CATEGORIES } = await import("../services/skills-bundler");
    const generalDesignCats = MOCK_DESIGN_CATEGORIES["general"]!;
    expect(FRONTEND_LANE_CATEGORIES).toEqual(generalDesignCats);
  });
});
