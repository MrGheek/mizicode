import { z } from "zod";
import { db, designIntelligenceEntriesTable, skillDesignCategoriesTable } from "@workspace/db";
import { eq, and, inArray, sql, SQL } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LANE_POLICIES, VALID_LANE_TYPES } from "../../services/lane-policy.js";

export function registerDesignTools(server: McpServer): void {
  server.registerTool("query_design_patterns", {
    description: "[Read] Query UI patterns and palettes for a given context.",
    inputSchema: z.object({
      query: z.string().optional().describe("Search term for design patterns"),
      category: z.string().optional().describe("Filter by design category"),
      limit: z.number().int().min(1).max(100).optional().describe("Max results (default 20)"),
    }),
  }, async ({ query, category, limit }) => {
    const conditions: SQL[] = [];

    if (category) {
      conditions.push(eq(designIntelligenceEntriesTable.category, category));
    }
    if (query) {
      const pattern = `%${query}%`;
      conditions.push(
        sql`(${designIntelligenceEntriesTable.name} ilike ${pattern} or ${designIntelligenceEntriesTable.dataJson}::text ilike ${pattern})`,
      );
    }

    const whereClause = conditions.length > 0 ? and(...(conditions as Parameters<typeof and>)) : undefined;
    const entries = await db.select({
      id: designIntelligenceEntriesTable.id,
      category: designIntelligenceEntriesTable.category,
      name: designIntelligenceEntriesTable.name,
      tags: designIntelligenceEntriesTable.tags,
      dataJson: designIntelligenceEntriesTable.dataJson,
    })
      .from(designIntelligenceEntriesTable)
      .where(whereClause)
      .limit(limit ?? 20);

    return { content: [{ type: "text", text: JSON.stringify({ entries, count: entries.length }, null, 2) }] };
  });

  server.registerTool("list_design_categories", {
    description: "[Read] List available design pattern categories.",
    inputSchema: z.object({}),
  }, async () => {
    const rows = await db.select({ category: skillDesignCategoriesTable.category })
      .from(skillDesignCategoriesTable);

    const categories = [...new Set(rows.map(r => r.category))].sort();
    return { content: [{ type: "text", text: JSON.stringify({ categories }, null, 2) }] };
  });

  server.registerTool("get_design_lane_config", {
    description: "[Read] Get the design category injection rules for a specific lane type. Returns the default design categories injected for that lane, the lane description, and available skill-linked categories from the DB.",
    inputSchema: z.object({
      laneType: z.string().describe(`Lane type to get config for. Built-in values: ${VALID_LANE_TYPES.join(", ")}. Custom lane types fall back to the 'general' policy.`),
    }),
  }, async ({ laneType }) => {
    const policy = LANE_POLICIES[laneType as keyof typeof LANE_POLICIES] ?? LANE_POLICIES["general"];

    // Fetch skill-linked DB categories for the design categories in this lane's policy
    const linkedSkills = policy.designCategories.length > 0
      ? await db.select()
          .from(skillDesignCategoriesTable)
          .where(inArray(skillDesignCategoriesTable.category, policy.designCategories))
      : [];

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          laneType,
          description: policy.description,
          designCategories: policy.designCategories,
          linkedSkillCategories: linkedSkills,
        }, null, 2),
      }],
    };
  });
}
