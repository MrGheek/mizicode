/**
 * Unit tests for design intelligence context injection in bundle compilation.
 *
 * Covers:
 *   - lean/ultra token modes return no design context (token budget constraint)
 *   - full/core modes return entries up to DESIGN_CONTEXT_LIMIT
 *   - UX_LANE_CATEGORIES and FRONTEND_LANE_CATEGORIES are distinct and correct
 *   - Tag-overlap scoring prefers stack-matched entries over unmatched ones
 *   - Fallback to all candidates when zero stack-tag matches exist
 *   - Empty table returns gracefully (no throw, empty array)
 *   - DB error returns gracefully (no throw, empty array)
 *   - repoIntelligence.frameworks augment the stack tag set
 *
 * The DB module is fully mocked — no external dependencies.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Shared mock state — must be declared before vi.mock() factory runs
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockWhere = vi.fn();
const mockOrderBy = vi.fn();
const mockLimit = vi.fn();

const mockDb = { select: mockSelect };

vi.mock("@workspace/db", () => ({
  db: mockDb,
  designIntelligenceEntriesTable: {
    category: "designIntelligenceEntriesTable.category",
    name: "designIntelligenceEntriesTable.name",
    dataJson: "designIntelligenceEntriesTable.dataJson",
    tags: "designIntelligenceEntriesTable.tags",
    id: "designIntelligenceEntriesTable.id",
  },
  skillsTable: {},
  skillBundlesTable: {},
  skillVersionsTable: {},
  skillSourcesTable: {},
  sessionSkillsTable: {},
  sessionsTable: {},
  sessionRepoContextTable: {},
  skillFeedbackTable: {},
  skillEvalsTable: {},
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  and: vi.fn(),
  inArray: vi.fn(),
  desc: vi.fn(),
  asc: vi.fn(),
}));

// Mock logger to suppress output during tests
vi.mock("../lib/logger", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type FakeRow = {
  category: string;
  name: string;
  dataJson: Record<string, string>;
  tags: string[];
};

function makeRow(category: string, name: string, tags: string[] = [], data: Record<string, string> = {}): FakeRow {
  return { category, name, dataJson: data, tags };
}

function setupDbMock(rows: FakeRow[]) {
  mockLimit.mockResolvedValue(rows);
  mockOrderBy.mockReturnValue({ limit: mockLimit });
  mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
}

function setupDbError(err: Error) {
  mockLimit.mockRejectedValue(err);
  mockOrderBy.mockReturnValue({ limit: mockLimit });
  mockWhere.mockReturnValue({ orderBy: mockOrderBy });
  mockFrom.mockReturnValue({ where: mockWhere });
  mockSelect.mockReturnValue({ from: mockFrom });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("queryDesignIntelligenceContext", () => {
  let queryDesignIntelligenceContext: Awaited<
    ReturnType<typeof import("../services/skills-bundler")>
  >["queryDesignIntelligenceContext"];

  let UX_LANE_CATEGORIES: string[];
  let FRONTEND_LANE_CATEGORIES: string[];
  let DESIGN_CONTEXT_LIMIT: Partial<Record<string, number>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const mod = await import("../services/skills-bundler");
    queryDesignIntelligenceContext = mod.queryDesignIntelligenceContext;
    UX_LANE_CATEGORIES = mod.UX_LANE_CATEGORIES;
    FRONTEND_LANE_CATEGORIES = mod.FRONTEND_LANE_CATEGORIES;
    DESIGN_CONTEXT_LIMIT = mod.DESIGN_CONTEXT_LIMIT as Partial<Record<string, number>>;
  });

  // ── Token mode suppression ────────────────────────────────────────────────

  it("lean mode: returns empty array without querying the DB", async () => {
    setupDbMock([makeRow("palette", "Brand palette", ["ts"])]);

    const result = await queryDesignIntelligenceContext(
      ["palette", "typography"],
      ["ts"],
      "lean",
    );

    expect(result).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  it("ultra mode: returns empty array without querying the DB", async () => {
    setupDbMock([makeRow("palette", "Brand palette", ["ts"])]);

    const result = await queryDesignIntelligenceContext(
      ["palette", "typography"],
      ["ts"],
      "ultra",
    );

    expect(result).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  // ── Limit enforcement ─────────────────────────────────────────────────────

  it("full mode: returns at most DESIGN_CONTEXT_LIMIT[full] entries", async () => {
    const fullLimit = DESIGN_CONTEXT_LIMIT["full"]!;
    const rows = Array.from({ length: fullLimit + 5 }, (_, i) =>
      makeRow("palette", `palette-${i}`, ["ts"]),
    );
    setupDbMock(rows);

    const result = await queryDesignIntelligenceContext(
      ["palette"],
      ["ts"],
      "full",
    );

    expect(result.length).toBeLessThanOrEqual(fullLimit);
  });

  it("core mode: returns at most DESIGN_CONTEXT_LIMIT[core] entries", async () => {
    const coreLimit = DESIGN_CONTEXT_LIMIT["core"]!;
    const rows = Array.from({ length: coreLimit + 5 }, (_, i) =>
      makeRow("ux_guideline", `guideline-${i}`, ["ts"]),
    );
    setupDbMock(rows);

    const result = await queryDesignIntelligenceContext(
      ["ux_guideline"],
      ["ts"],
      "core",
    );

    expect(result.length).toBeLessThanOrEqual(coreLimit);
  });

  it("full mode returns more entries than core mode (larger limit)", async () => {
    const fullLimit = DESIGN_CONTEXT_LIMIT["full"]!;
    const coreLimit = DESIGN_CONTEXT_LIMIT["core"]!;
    expect(fullLimit).toBeGreaterThan(coreLimit);
  });

  // ── Empty table / no rows ─────────────────────────────────────────────────

  it("returns empty array gracefully when the table has no matching rows", async () => {
    setupDbMock([]);

    const result = await queryDesignIntelligenceContext(
      ["palette"],
      ["ts"],
      "full",
    );

    expect(result).toEqual([]);
    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("returns empty array gracefully when categories list is empty", async () => {
    setupDbMock([makeRow("palette", "Brand palette", ["ts"])]);

    const result = await queryDesignIntelligenceContext(
      [],
      ["ts"],
      "full",
    );

    expect(result).toEqual([]);
    expect(mockSelect).not.toHaveBeenCalled();
  });

  // ── DB error handling ─────────────────────────────────────────────────────

  it("returns empty array gracefully when the DB throws", async () => {
    setupDbError(new Error("Connection refused"));

    const result = await queryDesignIntelligenceContext(
      ["palette"],
      ["ts"],
      "full",
    );

    expect(result).toEqual([]);
  });

  // ── Tag-overlap scoring ───────────────────────────────────────────────────

  it("prefers entries that match repo stack tags over unmatched entries", async () => {
    const rows = [
      makeRow("palette", "unmatched", ["python", "django"]),
      makeRow("palette", "matched", ["ts", "react"]),
    ];
    setupDbMock(rows);

    const result = await queryDesignIntelligenceContext(
      ["palette"],
      ["ts", "react"],
      "full",
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe("matched");
  });

  it("falls back to all candidates when no entries match the repo stack", async () => {
    const rows = [
      makeRow("palette", "entry-a", ["elixir"]),
      makeRow("palette", "entry-b", ["erlang"]),
    ];
    setupDbMock(rows);

    const result = await queryDesignIntelligenceContext(
      ["palette"],
      ["ts"],
      "full",
    );

    expect(result.length).toBe(2);
  });

  it("tag matching is case-insensitive", async () => {
    const rows = [
      makeRow("palette", "upper-matched", ["TS", "REACT"]),
    ];
    setupDbMock(rows);

    const result = await queryDesignIntelligenceContext(
      ["palette"],
      ["ts", "react"],
      "full",
    );

    expect(result.length).toBe(1);
    expect(result[0].name).toBe("upper-matched");
  });

  it("uses repoIntelligence.frameworks to broaden stack tags", async () => {
    const rows = [
      makeRow("palette", "framework-matched", ["next"]),
      makeRow("palette", "unmatched", ["vue"]),
    ];
    setupDbMock(rows);

    const result = await queryDesignIntelligenceContext(
      ["palette"],
      ["ts"],
      "full",
      { primaryLangs: ["ts"], frameworks: ["next"], monorepo: false, confidenceLevel: "full", isStale: false },
    );

    expect(result.length).toBeGreaterThan(0);
    expect(result[0].name).toBe("framework-matched");
  });

  // ── High-priority category boost ──────────────────────────────────────────

  it("boosts ux_guideline and palette entries over non-priority categories at equal tag overlap", async () => {
    const rows = [
      makeRow("stack_convention", "low-priority", ["ts"]),
      makeRow("ux_guideline", "high-priority", ["ts"]),
    ];
    setupDbMock(rows);

    const result = await queryDesignIntelligenceContext(
      ["stack_convention", "ux_guideline"],
      ["ts"],
      "full",
    );

    expect(result.length).toBe(2);
    expect(result[0].name).toBe("high-priority");
  });

  // ── Returned entry shape ──────────────────────────────────────────────────

  it("maps DB rows to DesignContextEntry shape correctly", async () => {
    const rows = [
      makeRow("palette", "Brand blue", ["ts"], { primary: "#0057FF", secondary: "#E8F0FF" }),
    ];
    setupDbMock(rows);

    const result = await queryDesignIntelligenceContext(
      ["palette"],
      ["ts"],
      "full",
    );

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      category: "palette",
      name: "Brand blue",
      tags: ["ts"],
      data: { primary: "#0057FF", secondary: "#E8F0FF" },
    });
  });
});

// ---------------------------------------------------------------------------
// Category constant correctness
// ---------------------------------------------------------------------------

describe("UX_LANE_CATEGORIES vs FRONTEND_LANE_CATEGORIES", () => {
  let UX_LANE_CATEGORIES: string[];
  let FRONTEND_LANE_CATEGORIES: string[];

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("../services/skills-bundler");
    UX_LANE_CATEGORIES = mod.UX_LANE_CATEGORIES;
    FRONTEND_LANE_CATEGORIES = mod.FRONTEND_LANE_CATEGORIES;
  });

  it("both category lists share the core design foundation categories (palette, typography, ux_guideline)", () => {
    const shared = ["palette", "typography", "ux_guideline"];
    for (const cat of shared) {
      expect(UX_LANE_CATEGORIES).toContain(cat);
      expect(FRONTEND_LANE_CATEGORIES).toContain(cat);
    }
  });

  it("UX_LANE_CATEGORIES has additional design-doctrine categories not in FRONTEND_LANE_CATEGORIES", () => {
    const uxOnly = UX_LANE_CATEGORIES.filter(c => !FRONTEND_LANE_CATEGORIES.includes(c));
    expect(uxOnly.length).toBeGreaterThan(0);
  });

  it("UX_LANE_CATEGORIES includes ux-specific categories: chart_type, ui_reasoning, anti_pattern, style", () => {
    expect(UX_LANE_CATEGORIES).toContain("chart_type");
    expect(UX_LANE_CATEGORIES).toContain("ui_reasoning");
    expect(UX_LANE_CATEGORIES).toContain("anti_pattern");
    expect(UX_LANE_CATEGORIES).toContain("style");
  });

  it("FRONTEND_LANE_CATEGORIES includes stack_convention (narrower/codebase-focused subset)", () => {
    expect(FRONTEND_LANE_CATEGORIES).toContain("stack_convention");
  });

  it("both category lists are non-empty", () => {
    expect(UX_LANE_CATEGORIES.length).toBeGreaterThan(0);
    expect(FRONTEND_LANE_CATEGORIES.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// DESIGN_CONTEXT_LIMIT constant correctness
// ---------------------------------------------------------------------------

describe("DESIGN_CONTEXT_LIMIT", () => {
  let DESIGN_CONTEXT_LIMIT: Partial<Record<string, number>>;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("../services/skills-bundler");
    DESIGN_CONTEXT_LIMIT = mod.DESIGN_CONTEXT_LIMIT as Partial<Record<string, number>>;
  });

  it("defines a limit for full mode", () => {
    expect(DESIGN_CONTEXT_LIMIT["full"]).toBeGreaterThan(0);
  });

  it("defines a limit for core mode", () => {
    expect(DESIGN_CONTEXT_LIMIT["core"]).toBeGreaterThan(0);
  });

  it("does NOT define a limit for lean mode (suppressed)", () => {
    expect(DESIGN_CONTEXT_LIMIT["lean"]).toBeUndefined();
  });

  it("does NOT define a limit for ultra mode (suppressed)", () => {
    expect(DESIGN_CONTEXT_LIMIT["ultra"]).toBeUndefined();
  });
});
