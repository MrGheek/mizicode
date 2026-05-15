import { z } from "zod";
import { db, skillsTable } from "@workspace/db";
import { desc } from "drizzle-orm";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DEFAULT_SKILLS } from "../../services/default-skills.js";
import { getSkillLeaderboard } from "../../services/skills-leaderboard.js";
import { scheduleEvalRun } from "../../services/skills-evals.js";

export function registerSkillsTools(server: McpServer): void {
  server.registerTool("list_skills", {
    description: "[Read] List available skills and built-ins.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("Max results (default 50)"),
      offset: z.number().int().min(0).optional().describe("Pagination offset"),
    }),
  }, async ({ limit, offset }) => {
    const skills = await db.select({
      id: skillsTable.id,
      slug: skillsTable.slug,
      name: skillsTable.name,
      class: skillsTable.class,
      description: skillsTable.description,
      trustTier: skillsTable.trustTier,
      reviewStatus: skillsTable.reviewStatus,
      createdAt: skillsTable.createdAt,
    })
      .from(skillsTable)
      .orderBy(desc(skillsTable.createdAt))
      .limit(limit ?? 50)
      .offset(offset ?? 0);

    const builtins = DEFAULT_SKILLS.map(s => ({ id: s.id, name: s.name, class: s.class }));
    return { content: [{ type: "text", text: JSON.stringify({ skills, builtins, count: skills.length }, null, 2) }] };
  });

  server.registerTool("get_skills_leaderboard", {
    description: "[Read] Get ranked skills by helpfulness score.",
    inputSchema: z.object({
      limit: z.number().int().min(1).max(200).optional().describe("Max results"),
      taskMode: z.string().optional().describe("Filter by task mode"),
      minConfidence: z.number().min(0).max(1).optional().describe("Minimum confidence threshold"),
    }),
  }, async ({ limit, taskMode, minConfidence }) => {
    const result = await getSkillLeaderboard({ limit, taskMode, minConfidence });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("run_skill_eval", {
    description: "[Write] Schedule performance benchmarks for a skill set.",
    inputSchema: z.object({
      runType: z.enum(["baseline", "skill", "bundle", "bundle_variant"]).describe("Type of eval run"),
      targetSkillId: z.number().int().optional().describe("Skill ID (required for runType=skill)"),
      targetBundleId: z.number().int().optional().describe("Bundle ID (required for runType=bundle or bundle_variant)"),
      taskMode: z.enum(["build", "debug", "review", "refactor", "explore", "team"]).optional().describe("Task mode for the eval"),
      notes: z.string().optional().describe("Optional notes for this eval run"),
    }),
  }, async ({ runType, targetSkillId, targetBundleId, taskMode, notes }) => {
    const run = await scheduleEvalRun({
      runType: runType as "baseline" | "skill" | "bundle" | "bundle_variant",
      targetSkillId,
      targetBundleId,
      taskMode: taskMode ?? "build",
      sessionType: "solo",
      tokenMode: "core",
      modelProfile: "default",
      notes,
    });
    return { content: [{ type: "text", text: JSON.stringify({ run, message: "Eval run scheduled. Status: queued." }, null, 2) }] };
  });
}
