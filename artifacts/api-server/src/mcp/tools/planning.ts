import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
type PlanTaskStatus = "planned" | "in_progress" | "done" | "partial" | "skipped";
type PlanTaskPriority = "high" | "normal" | "low";
import {
  generatePlan,
  getPlansForUser,
  getPlanById,
  getTasksForPlan,
  updateTask,
  addTaskToPlan,
  reassessSession,
} from "../../services/plan.js";

export function registerPlanningTools(server: McpServer): void {
  server.registerTool("list_plans", {
    description: "[Read] List all project plans for a user.",
    inputSchema: z.object({
      userId: z.string().describe("User ID"),
      repoUrl: z.string().optional().describe("Filter by repository URL"),
    }),
  }, async ({ userId, repoUrl }) => {
    const plans = await getPlansForUser(userId, repoUrl ?? null);
    return { content: [{ type: "text", text: JSON.stringify({ plans, count: plans.length }, null, 2) }] };
  });

  server.registerTool("get_plan", {
    description: "[Read] Get a full plan with its task list.",
    inputSchema: z.object({
      planId: z.number().int().describe("Plan ID"),
    }),
  }, async ({ planId }) => {
    const plan = await getPlanById(planId);
    if (!plan) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Plan not found" }) }] };
    }
    const tasks = await getTasksForPlan(planId);
    return { content: [{ type: "text", text: JSON.stringify({ plan, tasks }, null, 2) }] };
  });

  server.registerTool("get_session_plan", {
    description: "[Read] Get the plan linked to a specific session.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID"),
    }),
  }, async ({ sessionId }) => {
    const { sql } = await import("drizzle-orm");
    const { db } = await import("@workspace/db");
    const result = await db.execute<{ planId: number | null }>(
      sql`SELECT plan_id AS "planId" FROM sessions WHERE id = ${sessionId} LIMIT 1`
    );
    const session = result.rows[0];
    if (!session?.planId) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No plan linked to this session" }) }] };
    }
    const plan = await getPlanById(session.planId);
    if (!plan) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "Linked plan not found" }) }] };
    }
    const tasks = await getTasksForPlan(session.planId);
    return { content: [{ type: "text", text: JSON.stringify({ sessionId, plan, tasks }, null, 2) }] };
  });

  server.registerTool("generate_plan", {
    description: "[Write] LLM-generate a plan from a natural language intent string.",
    inputSchema: z.object({
      intentText: z.string().describe("Natural language description of the project/task"),
      userId: z.string().describe("User ID who owns the plan"),
      repoUrl: z.string().optional().describe("Repository URL for context"),
      existingPlanId: z.number().int().optional().describe("Existing plan ID to extend"),
    }),
  }, async ({ intentText, userId, repoUrl, existingPlanId }) => {
    const result = await generatePlan({
      intentText,
      userId,
      repoUrl: repoUrl ?? null,
      existingPlanId: existingPlanId ?? null,
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("update_task", {
    description: "[Write] Update a task's status, priority, or ordering. Status values: planned, in_progress, done, partial, skipped. Priority values: high, normal, low.",
    inputSchema: z.object({
      taskId: z.number().int().describe("Task ID"),
      userId: z.string().describe("User ID (for ownership verification)"),
      status: z.enum(["planned", "in_progress", "done", "partial", "skipped"]).optional().describe("New task status"),
      priority: z.enum(["high", "normal", "low"]).optional().describe("New task priority"),
      text: z.string().optional().describe("Updated task description"),
    }),
  }, async ({ taskId, userId, status, priority, text }) => {
    const result = await updateTask({
      taskId,
      userId,
      updates: {
        status: status as PlanTaskStatus | undefined,
        priority: priority as PlanTaskPriority | undefined,
        text,
      },
    });
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });

  server.registerTool("add_task", {
    description: "[Write] Add a task to an existing plan. Priority values: high, normal, low.",
    inputSchema: z.object({
      planId: z.number().int().describe("Plan ID to add task to"),
      userId: z.string().describe("User ID (for ownership verification)"),
      text: z.string().describe("Task description"),
      priority: z.enum(["high", "normal", "low"]).optional().describe("Task priority (default: normal)"),
    }),
  }, async ({ planId, userId, text, priority }) => {
    const task = await addTaskToPlan({
      planId,
      userId,
      text,
      priority: priority as PlanTaskPriority | undefined,
    });
    return { content: [{ type: "text", text: JSON.stringify(task, null, 2) }] };
  });

  server.registerTool("reassess_plan", {
    description: "[Write] Post-session task update based on what was accomplished during the session.",
    inputSchema: z.object({
      sessionId: z.number().int().describe("Session ID to reassess"),
      userId: z.string().describe("User ID who owns the session's plan"),
    }),
  }, async ({ sessionId, userId }) => {
    const result = await reassessSession({ sessionId, userId });
    if (!result) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "No linked plan found for this session" }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
  });
}
