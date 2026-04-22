import { Router } from "express";
import { db, designIntelligenceEntriesTable, skillSourcesTable } from "@workspace/db";
import { eq, and, like, sql } from "drizzle-orm";

const router = Router();

/**
 * GET /api/design-intelligence
 *
 * Query params:
 *   category  — filter by category (exact match)
 *   q         — keyword matched via ILIKE against name and data_json::text
 *   limit     — max rows returned (default 20, max 100)
 */
router.get("/design-intelligence", async (req, res) => {
  try {
    const category = typeof req.query["category"] === "string" ? req.query["category"] : undefined;
    const q = typeof req.query["q"] === "string" ? req.query["q"] : undefined;
    const limitRaw = Number(req.query["limit"] ?? 20);
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 20 : limitRaw), 100);

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

    const entries = await db
      .select({
        id: designIntelligenceEntriesTable.id,
        category: designIntelligenceEntriesTable.category,
        name: designIntelligenceEntriesTable.name,
        data_json: designIntelligenceEntriesTable.dataJson,
        tags: designIntelligenceEntriesTable.tags,
      })
      .from(designIntelligenceEntriesTable)
      .where(whereClause)
      .limit(limit);

    return res.json({ entries });
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

    return res.json({ sources });
  } catch (err) {
    req.log.error({ err }, "Failed to query design intelligence sources");
    return res.status(500).json({ error: "Failed to query design intelligence sources" });
  }
});

export default router;
