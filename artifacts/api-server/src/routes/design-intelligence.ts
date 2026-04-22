import { Router } from "express";
import { db, designIntelligenceEntriesTable, skillSourcesTable } from "@workspace/db";
import { eq, and, like, sql } from "drizzle-orm";

const router = Router();

/**
 * GET /api/design-intelligence
 *
 * Query params:
 *   category  — filter by category (exact match)
 *   tag       — filter by tag (substring match within the tags JSON array)
 *   q         — search within name (ILIKE %q%)
 *   limit     — max rows returned (default 50, max 200)
 *   offset    — pagination offset (default 0)
 */
router.get("/design-intelligence", async (req, res) => {
  try {
    const category = typeof req.query["category"] === "string" ? req.query["category"] : undefined;
    const tag = typeof req.query["tag"] === "string" ? req.query["tag"] : undefined;
    const q = typeof req.query["q"] === "string" ? req.query["q"] : undefined;
    const limitRaw = Number(req.query["limit"] ?? 50);
    const offsetRaw = Number(req.query["offset"] ?? 0);
    const limit = Math.min(Math.max(1, isNaN(limitRaw) ? 50 : limitRaw), 200);
    const offset = Math.max(0, isNaN(offsetRaw) ? 0 : offsetRaw);

    const conditions = [];

    if (category) {
      conditions.push(eq(designIntelligenceEntriesTable.category, category));
    }

    if (q) {
      conditions.push(like(designIntelligenceEntriesTable.name, `%${q}%`));
    }

    if (tag) {
      conditions.push(
        sql`${designIntelligenceEntriesTable.tags}::jsonb @> ${JSON.stringify([tag])}::jsonb`,
      );
    }

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;

    const [entries, countResult] = await Promise.all([
      db
        .select({
          id: designIntelligenceEntriesTable.id,
          category: designIntelligenceEntriesTable.category,
          name: designIntelligenceEntriesTable.name,
          dataJson: designIntelligenceEntriesTable.dataJson,
          tags: designIntelligenceEntriesTable.tags,
          createdAt: designIntelligenceEntriesTable.createdAt,
        })
        .from(designIntelligenceEntriesTable)
        .where(whereClause)
        .limit(limit)
        .offset(offset),
      db
        .select({ count: sql<number>`count(*)::int` })
        .from(designIntelligenceEntriesTable)
        .where(whereClause),
    ]);

    const total = countResult[0]?.count ?? 0;

    return res.json({
      entries,
      pagination: { total, limit, offset },
    });
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
 * Returns the ingested skill sources and their current commit SHAs.
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
      .where(eq(skillSourcesTable.sourceType, "github"));

    return res.json({ sources });
  } catch (err) {
    req.log.error({ err }, "Failed to query design intelligence sources");
    return res.status(500).json({ error: "Failed to query design intelligence sources" });
  }
});

export default router;
