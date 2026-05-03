import { Router } from "express";
import { db, designIntelligenceEntriesTable, skillSourcesTable, skillsTable, skillDesignCategoriesTable } from "@workspace/db";
import { eq, and, sql, or, ilike } from "drizzle-orm";
import { getDesignSyncStatus, triggerDesignSync } from "../services/scheduler";

const router = Router();

/**
 * Compute which categories a skill matches based on keyword matching against
 * the skill's name, description, and class fields.
 */
function computeSkillCategories(
  skill: { id: number; slug: string; name: string; class: string; description: string },
  allCategories: string[],
): string[] {
  const haystack = `${skill.name} ${skill.description} ${skill.class} ${skill.slug}`.toLowerCase();
  const matched: string[] = [];

  for (const cat of allCategories) {
    const catLower = cat.toLowerCase();
    const catKeywords = catLower.split(/[-_\s]+/);
    if (catKeywords.some((kw) => kw.length >= 3 && haystack.includes(kw))) {
      matched.push(cat);
    }
  }

  return matched;
}

/**
 * GET /api/design-intelligence
 *
 * Query params:
 *   category  — filter by category (exact match)
 *   q         — keyword matched via ILIKE against name and data_json::text
 *   limit     — page size (default 20, max 100)
 *   offset    — number of rows to skip for pagination (default 0)
 */
router.get("/design-intelligence", async (req, res) => {
  try {
    const category = typeof req.query["category"] === "string" ? req.query["category"] : undefined;
    const q = typeof req.query["q"] === "string" ? req.query["q"] : undefined;
    const limitRaw = Number(req.query["limit"] ?? 20);
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 20 : limitRaw), 100);
    const offsetRaw = Number(req.query["offset"] ?? 0);
    const offset = Math.max(0, isNaN(offsetRaw) ? 0 : offsetRaw);

    const conditions = [];

    if (category) {
      conditions.push(eq(designIntelligenceEntriesTable.category, category));
    }

    if (q) {
      const pattern = `%${q}%`;
      conditions.push(
        sql`(${designIntelligenceEntriesTable.name} ilike ${pattern} or ${designIntelligenceEntriesTable.dataJson}::text ilike ${pattern})`,
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [entries, totalResult] = await Promise.all([
      db
        .select({
          id: designIntelligenceEntriesTable.id,
          category: designIntelligenceEntriesTable.category,
          name: designIntelligenceEntriesTable.name,
          data_json: designIntelligenceEntriesTable.dataJson,
          tags: designIntelligenceEntriesTable.tags,
        })
        .from(designIntelligenceEntriesTable)
        .where(whereClause)
        .orderBy(designIntelligenceEntriesTable.id)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(designIntelligenceEntriesTable)
        .where(whereClause),
    ]);

    const total = totalResult[0]?.total ?? 0;

    return res.json({ entries, total, limit, offset });
  } catch (err) {
    req.log.error({ err }, "Failed to query design intelligence entries");
    return res.status(500).json({ error: "Failed to query design intelligence entries" });
  }
});

/**
 * GET /api/design-intelligence/categories
 *
 * Returns the distinct categories with entry counts.
 */
router.get("/design-intelligence/categories", async (req, res) => {
  try {
    const categories = await db
      .select({
        category: designIntelligenceEntriesTable.category,
        count: sql<number>`count(*)::int`,
      })
      .from(designIntelligenceEntriesTable)
      .groupBy(designIntelligenceEntriesTable.category)
      .orderBy(designIntelligenceEntriesTable.category);

    return res.json({ categories });
  } catch (err) {
    req.log.error({ err }, "Failed to query design intelligence categories");
    return res.status(500).json({ error: "Failed to query design intelligence categories" });
  }
});

/**
 * GET /api/design-intelligence/skill-map
 *
 * Returns a map of category → related skills.
 * Skills are matched by:
 *   1. Explicit rows in the skill_design_categories join table
 *   2. Keyword matching between skill name/description/class and each category name
 *
 * Response: { skillMap: { [category: string]: SkillSummary[] }, totalCategories: number }
 */
router.get("/design-intelligence/skill-map", async (req, res) => {
  try {
    const [categoriesResult, allSkills, explicitLinks] = await Promise.all([
      db
        .select({ category: designIntelligenceEntriesTable.category })
        .from(designIntelligenceEntriesTable)
        .groupBy(designIntelligenceEntriesTable.category),
      db
        .select({
          id: skillsTable.id,
          slug: skillsTable.slug,
          name: skillsTable.name,
          class: skillsTable.class,
          description: skillsTable.description,
          reviewStatus: skillsTable.reviewStatus,
          enabled: skillsTable.enabled,
        })
        .from(skillsTable)
        .where(eq(skillsTable.reviewStatus, "approved")),
      db
        .select({
          skillId: skillDesignCategoriesTable.skillId,
          category: skillDesignCategoriesTable.category,
          matchMethod: skillDesignCategoriesTable.matchMethod,
        })
        .from(skillDesignCategoriesTable),
    ]);

    const allCategories = categoriesResult.map((r) => r.category);

    const skillSummaryById = new Map(
      allSkills.map((s) => [s.id, { id: s.id, slug: s.slug, name: s.name, class: s.class, enabled: s.enabled }]),
    );

    const skillMap: Record<string, Array<{ id: number; slug: string; name: string; class: string; enabled: boolean }>> = {};

    for (const cat of allCategories) {
      skillMap[cat] = [];
    }

    const explicitByCategory = new Map<string, Set<number>>();
    for (const link of explicitLinks) {
      if (!explicitByCategory.has(link.category)) {
        explicitByCategory.set(link.category, new Set());
      }
      const skill = skillSummaryById.get(link.skillId);
      if (skill && skillMap[link.category]) {
        explicitByCategory.get(link.category)!.add(link.skillId);
        skillMap[link.category].push(skill);
      }
    }

    for (const skill of allSkills) {
      const matched = computeSkillCategories(skill, allCategories);
      for (const cat of matched) {
        if (!skillMap[cat]) continue;
        const alreadyAdded = skillMap[cat].some((s) => s.id === skill.id);
        if (!alreadyAdded) {
          skillMap[cat].push({
            id: skill.id,
            slug: skill.slug,
            name: skill.name,
            class: skill.class,
            enabled: skill.enabled,
          });
        }
      }
    }

    return res.json({ skillMap, totalCategories: allCategories.length });
  } catch (err) {
    req.log.error({ err }, "Failed to build design intelligence skill map");
    return res.status(500).json({ error: "Failed to build skill map" });
  }
});

/**
 * GET /api/design-intelligence/sources
 *
 * Returns the ingested curated skill sources and their current commit SHAs.
 */
router.get("/design-intelligence/sources", async (req, res) => {
  try {
    const sources = await db
      .select({
        id: skillSourcesTable.id,
        repoUrl: skillSourcesTable.repoUrl,
        sourceType: skillSourcesTable.sourceType,
        trustLevel: skillSourcesTable.trustLevel,
        pinnedCommitSha: skillSourcesTable.pinnedCommitSha,
        importedAt: skillSourcesTable.importedAt,
      })
      .from(skillSourcesTable)
      .where(eq(skillSourcesTable.sourceType, "curated"));

    const syncStatus = getDesignSyncStatus();

    return res.json({
      sources,
      sync: {
        lastSyncedAt: syncStatus.lastSyncedAt?.toISOString() ?? null,
        lastAttemptedAt: syncStatus.lastAttemptedAt?.toISOString() ?? null,
        lastError: syncStatus.lastError,
        nextSyncAt: syncStatus.nextSyncAt?.toISOString() ?? null,
        intervalMs: syncStatus.intervalMs,
        isRunning: syncStatus.isRunning,
      },
    });
  } catch (err) {
    req.log.error({ err }, "Failed to query design intelligence sources");
    return res.status(500).json({ error: "Failed to query design intelligence sources" });
  }
});

/**
 * POST /api/design-intelligence/sync
 *
 * Triggers an on-demand re-sync of curated design intelligence sources.
 * Returns 409 if a sync is already running.
 */
router.post("/design-intelligence/sync", async (req, res) => {
  const currentStatus = getDesignSyncStatus();
  if (currentStatus.isRunning) {
    return res.status(409).json({ error: "Sync already in progress" });
  }

  const result = await triggerDesignSync();

  if (!result.success) {
    return res.status(500).json({ ok: false, error: result.reason });
  }

  return res.json({ ok: true, message: result.reason });
});

export default router;
