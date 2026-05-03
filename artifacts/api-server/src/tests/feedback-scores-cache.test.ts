/**
 * Unit tests for getSkillFeedbackScores() caching behaviour.
 *
 * The DB module is fully mocked so these tests never touch the database.
 * Focus areas:
 *   - Cache hit: second call returns cached data without querying DB
 *   - Cache miss after TTL: stale cache is discarded and DB is re-queried
 *   - invalidateFeedbackScoresCache(): forces a fresh DB fetch on the next call
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock @workspace/db before importing the module under test
// ---------------------------------------------------------------------------

const mockSelect = vi.fn();
const mockFrom = vi.fn();
const mockInnerJoin = vi.fn();

const mockDb = {
  select: mockSelect,
};

vi.mock("@workspace/db", () => ({
  db: mockDb,
  skillsTable: { id: "skillsTable.id", slug: "skillsTable.slug" },
  skillFeedbackTable: {
    skillId: "skillFeedbackTable.skillId",
    helpful: "skillFeedbackTable.helpful",
    taskSuccessScore: "skillFeedbackTable.taskSuccessScore",
    createdAt: "skillFeedbackTable.createdAt",
  },
  skillEvalsTable: {},
  eq: vi.fn(),
  inArray: vi.fn(),
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn(),
  inArray: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Helper: produce a minimal fake DB row
// ---------------------------------------------------------------------------

function makeRow(skillId: number, slug: string, helpful: boolean) {
  return {
    skillId,
    slug,
    helpful,
    taskSuccessScore: null,
    createdAt: new Date(), // current timestamp → full decay weight 1.0
  };
}

// ---------------------------------------------------------------------------
// Wire up the chainable query mock
// ---------------------------------------------------------------------------

function setupDbMock(rows: ReturnType<typeof makeRow>[]) {
  mockInnerJoin.mockResolvedValue(rows);
  mockFrom.mockReturnValue({ innerJoin: mockInnerJoin });
  mockSelect.mockReturnValue({ from: mockFrom });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("getSkillFeedbackScores() caching", () => {
  let getSkillFeedbackScores: () => Promise<unknown[]>;
  let invalidateFeedbackScoresCache: () => void;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Re-import after resetting modules so the module-level cache starts null
    const mod = await import("../services/skills-ranker");
    getSkillFeedbackScores = mod.getSkillFeedbackScores;
    invalidateFeedbackScoresCache = mod.invalidateFeedbackScoresCache;
  });

  it("returns DB results on first call (cache miss)", async () => {
    setupDbMock([makeRow(1, "my-skill", true)]);

    const result = await getSkillFeedbackScores();

    expect(mockSelect).toHaveBeenCalledTimes(1);
    expect(result).toHaveLength(1);
    expect((result[0] as { slug: string }).slug).toBe("my-skill");
  });

  it("returns cached data on second call (cache hit — no extra DB query)", async () => {
    setupDbMock([makeRow(1, "my-skill", true)]);

    await getSkillFeedbackScores();
    await getSkillFeedbackScores();

    expect(mockSelect).toHaveBeenCalledTimes(1);
  });

  it("re-queries DB after TTL expires", async () => {
    setupDbMock([makeRow(1, "my-skill", true)]);

    await getSkillFeedbackScores();

    // Advance time past the default 5-minute TTL
    const now = Date.now();
    vi.spyOn(Date, "now").mockReturnValue(now + 6 * 60 * 1000);

    setupDbMock([makeRow(1, "my-skill", false)]);
    const result = await getSkillFeedbackScores();

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect((result[0] as { helpfulCount: number }).helpfulCount).toBe(0);

    vi.restoreAllMocks();
  });

  it("invalidateFeedbackScoresCache() forces fresh DB fetch on next call", async () => {
    setupDbMock([makeRow(1, "skill-a", true)]);
    await getSkillFeedbackScores();

    invalidateFeedbackScoresCache();

    setupDbMock([makeRow(2, "skill-b", false)]);
    const result = await getSkillFeedbackScores();

    expect(mockSelect).toHaveBeenCalledTimes(2);
    expect((result[0] as { slug: string }).slug).toBe("skill-b");
  });

  it("aggregates multiple feedback rows for the same skill correctly", async () => {
    const rows = [
      makeRow(1, "multi-skill", true),
      makeRow(1, "multi-skill", true),
      makeRow(1, "multi-skill", false),
    ];
    setupDbMock(rows);

    const result = await getSkillFeedbackScores();

    expect(result).toHaveLength(1);
    const score = result[0] as { totalCount: number; helpfulCount: number; unhelpfulCount: number };
    expect(score.totalCount).toBe(3);
    expect(score.helpfulCount).toBe(2);
    expect(score.unhelpfulCount).toBe(1);
  });
});
