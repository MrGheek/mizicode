import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDbFactoryStore, FactoryRegistry } from "../../services/factory.js";
import { dispatchWorkOrders, completeWorkOrder, rejectToRework } from "../../services/factory-dispatcher.js";
import { admitMerge } from "../../services/factory-admission.js";
import { submitDeliverable, productTelemetry } from "../../services/rework-loop.js";
import type { Deliverable } from "../../services/deliverable-contract.js";
import type { StationRole } from "@workspace/db";
import { triggerPipeline, advancePipeline, latestPipelineSnapshot } from "../../services/factory-pipeline.js";
import { computeDashboard } from "../../services/factory-telemetry.js";
import { getFactoryResourcePool, resetFactoryResourcePool } from "../../services/factory-resource-pool.js";
import { runFactoryEval, simulateFactoryRun, type FactoryEvalScenario, type FactoryEvalConfig } from "../../services/factory-eval.js";

/**
 * RFC 0003 Phase 1 — factory MCP tools: create_product, dispatch_work_order,
 * admit_merge, rework, factory_status.
 */
export function registerFactoryTools(server: McpServer): void {
  server.registerTool("create_product", {
    description: "[Write] Register a repo as a factory product (RFC 0003). A product is a repo with a roadmap that outlives any single session.",
    inputSchema: z.object({
      name: z.string().describe("Product name"),
      repoUrl: z.string().describe("Repo URL (unique product key)"),
      wipLimit: z.number().int().positive().optional().describe("Max concurrent work orders (default 4)"),
    }),
  }, async ({ name, repoUrl, wipLimit }) => {
    const registry = new FactoryRegistry(createDbFactoryStore());
    try {
      const product = await registry.createProduct({ name, repoUrl, wipLimit });
      return { content: [{ type: "text", text: JSON.stringify({ product }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("create_work_order", {
    description: "[Write] Add a work order to a product's roadmap (RFC 0003). The dispatcher assigns it to a station when WIP allows.",
    inputSchema: z.object({
      productId: z.number().int().describe("Product ID"),
      goal: z.string().describe("Work order goal"),
      priority: z.enum(["high", "normal", "low"]).optional().describe("Priority (default normal)"),
      dependencies: z.array(z.number().int()).optional().describe("Work-order ids that must complete first (DAG)"),
    }),
  }, async ({ productId, goal, priority, dependencies }) => {
    const registry = new FactoryRegistry(createDbFactoryStore());
    try {
      const order = await registry.createWorkOrder({
        productId,
        goal,
        priority: priority ?? "normal",
        dependencies: dependencies ?? [],
      });
      return { content: [{ type: "text", text: JSON.stringify({ workOrder: order }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("create_station", {
    description: "[Write] Register a session as a factory station with a role + capacity (RFC 0003).",
    inputSchema: z.object({
      productId: z.number().int().describe("Product ID"),
      sessionId: z.number().int().optional().describe("Session backing this station"),
      role: z.enum(["build", "review", "debug", "refactor", "explore", "team"]).optional().describe("Station role (default build)"),
      capacity: z.number().int().positive().optional().describe("Max concurrent lanes (default 2)"),
      wipLimit: z.number().int().positive().optional().describe("Max concurrent work orders (default 2)"),
    }),
  }, async ({ productId, sessionId, role, capacity, wipLimit }) => {
    const registry = new FactoryRegistry(createDbFactoryStore());
    try {
      const station = await registry.createStation({
        productId,
        sessionId: sessionId ?? null,
        role: role ?? "build",
        capacity,
        wipLimit,
      });
      return { content: [{ type: "text", text: JSON.stringify({ station }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("dispatch_work_order", {
    description: "[Write] Run a dispatch pass: assign ready work orders to stations, respecting product WIP + station capacity (RFC 0003).",
    inputSchema: z.object({
      productId: z.number().int().describe("Product ID"),
      maxDispatch: z.number().int().positive().optional().describe("Cap on orders dispatched in this pass"),
    }),
  }, async ({ productId, maxDispatch }) => {
    try {
      const result = await dispatchWorkOrders(createDbFactoryStore(), productId, { maxDispatch });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("admit_merge", {
    description: "[Read] Check whether a lane merge may be enqueued under the product's WIP + station capacity (RFC 0003 admission control).",
    inputSchema: z.object({
      repoUrl: z.string().describe("Session repo URL (product key)"),
      sessionId: z.number().int().describe("Session ID"),
      laneCount: z.number().int().positive().optional().describe("Lanes the session is running (default 1)"),
    }),
  }, async ({ repoUrl, sessionId, laneCount }) => {
    const decision = await admitMerge(createDbFactoryStore(), repoUrl, sessionId, laneCount ?? 1);
    return { content: [{ type: "text", text: JSON.stringify(decision, null, 2) }] };
  });

  server.registerTool("rework_work_order", {
    description: "[Write] Reject a work order at a station gate → route to rework. Increments rework counter + station defect telemetry (RFC 0003).",
    inputSchema: z.object({
      workOrderId: z.number().int().describe("Work order ID"),
      defectClass: z.string().optional().describe("Defect class (default gate_failure)"),
    }),
  }, async ({ workOrderId, defectClass }) => {
    const order = await rejectToRework(createDbFactoryStore(), workOrderId, defectClass ?? "gate_failure");
    if (!order) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "work order not found" }, null, 2) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ workOrder: order }, null, 2) }] };
  });

  server.registerTool("factory_status", {
    description: "[Read] Factory status: products, work orders, stations, WIP occupancy (RFC 0003).",
    inputSchema: z.object({
      productId: z.number().int().optional().describe("Filter to one product"),
    }),
  }, async ({ productId }) => {
    const registry = new FactoryRegistry(createDbFactoryStore());
    const single = productId ? await registry.getProduct(productId) : null;
    const products = single ? [single] : await registry.listProducts();
    const status = await Promise.all(products.map(async (p) => {
      const orders = await registry.listWorkOrders(p.id);
      const stations = await registry.listStations(p.id);
      const inFlight = orders.filter((o) => o.status === "dispatched" || o.status === "in_progress").length;
      return {
        product: { id: p.id, name: p.name, repoUrl: p.repoUrl, wipLimit: p.wipLimit },
        wip: { used: inFlight, limit: p.wipLimit },
        workOrders: orders.map((o) => ({ id: o.id, goal: o.goal, status: o.status, priority: o.priority, reworkCount: o.reworkCount })),
        stations: stations.map((s) => ({ id: s.id, role: s.role, sessionId: s.sessionId, wipLimit: s.wipLimit, defectCount: s.defectCount })),
      };
    }));
    return { content: [{ type: "text", text: JSON.stringify({ products: status, total: status.length }, null, 2) }] };
  });

  server.registerTool("submit_deliverable", {
    description: "[Write] Submit a lane's output for gate inspection (RFC 0003 Phase 2). Passes → work order done; fails → rework with defect class.",
    inputSchema: z.object({
      workOrderId: z.number().int().describe("Work order ID"),
      stationId: z.number().int().describe("Station that produced the deliverable"),
      stationRole: z.enum(["build", "review", "debug", "refactor", "explore", "team"]).describe("Station role (determines which gates apply)"),
      diff: z.string().describe("Unified diff / patch content (must be non-empty)"),
      intentEvents: z.array(z.string()).describe("RFC 0002 intent event IDs (must be non-empty)"),
      tests: z.array(z.object({ suite: z.string(), passed: z.number().int(), failed: z.number().int(), status: z.enum(["pass", "fail"]) })).optional().describe("Test suite results"),
      verification: z.array(z.object({ taskName: z.string(), taskType: z.enum(["compile", "lint", "typecheck", "test"]), status: z.enum(["pass", "fail"]), detail: z.string().optional() })).optional().describe("Verification evidence"),
      worktreeClean: z.boolean().optional().describe("Clean worktree flag (default true)"),
    }),
  }, async (args) => {
    try {
      const deliverable: Deliverable = {
        workOrderId: args.workOrderId,
        stationId: args.stationId,
        diff: args.diff,
        intentEvents: args.intentEvents,
        tests: args.tests ?? [],
        verification: args.verification ?? [],
        worktreeClean: args.worktreeClean ?? true,
      };
      const result = await submitDeliverable(createDbFactoryStore(), deliverable, args.stationRole as StationRole, getFactoryResourcePool());
      return { content: [{ type: "text", text: JSON.stringify({ accepted: result.accepted, inspection: result.inspection, workOrder: result.workOrder }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("factory_telemetry", {
    description: "[Read] Per-station defect rate, rework cycles, mean cycles-to-clear, defect classes, and effective WIP for a product (RFC 0003 Phase 2).",
    inputSchema: z.object({
      productId: z.number().int().describe("Product ID"),
    }),
  }, async ({ productId }) => {
    try {
      const telemetry = await productTelemetry(createDbFactoryStore(), productId);
      return { content: [{ type: "text", text: JSON.stringify(telemetry, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("trigger_pipeline", {
    description: "[Write] Trigger the continuous build → test → stage → ship pipeline for a product after a work order completes (RFC 0003 Phase 3).",
    inputSchema: z.object({
      productId: z.number().int().describe("Product ID"),
      workOrderId: z.number().int().describe("Work order that triggered the run"),
    }),
  }, async ({ productId, workOrderId }) => {
    try {
      const run = await triggerPipeline(createDbFactoryStore(), productId, workOrderId);
      return { content: [{ type: "text", text: JSON.stringify({ pipelineRun: run }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("advance_pipeline", {
    description: "[Write] Complete a pipeline stage (passed/failed) and advance to the next stage (RFC 0003 Phase 3).",
    inputSchema: z.object({
      pipelineRunId: z.number().int().describe("Pipeline run ID"),
      stage: z.enum(["build", "test", "stage", "ship"]).describe("Stage being completed"),
      status: z.enum(["passed", "failed"]).describe("Stage result"),
      artifacts: z.array(z.object({ name: z.string(), url: z.string(), hash: z.string() })).optional().describe("Staged artifacts"),
      evidence: z.array(z.object({ taskType: z.string(), status: z.enum(["pass", "fail"]), detail: z.string().optional() })).optional().describe("Gate evidence"),
    }),
  }, async ({ pipelineRunId, stage, status, artifacts, evidence }) => {
    try {
      const result = await advancePipeline(createDbFactoryStore(), pipelineRunId, {
        stage,
        status,
        artifacts: artifacts ?? [],
        evidence: evidence ?? [],
      });
      return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("factory_dashboard", {
    description: "[Read] Factory dashboard for a product: throughput, cycle time, defect/rework rate, station utilization, WIP occupancy, pipeline status (RFC 0003 Phase 3).",
    inputSchema: z.object({
      productId: z.number().int().describe("Product ID"),
    }),
  }, async ({ productId }) => {
    try {
      const store = createDbFactoryStore();
      const dashboard = await computeDashboard(store, productId);
      const pipeline = await latestPipelineSnapshot(store, productId);
      return { content: [{ type: "text", text: JSON.stringify({ dashboard, pipeline }, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });

  server.registerTool("factory_pool_status", {
    description: "[Read] Cross-product resource pool status: total/used/free units, per-product caps and reservations (RFC 0003 Phase 4).",
    inputSchema: z.object({}),
  }, async () => {
    const pool = getFactoryResourcePool();
    return { content: [{ type: "text", text: JSON.stringify({ status: pool.status(), config: pool.configSnapshot() }, null, 2) }] };
  });

  server.registerTool("factory_pool_set_cap", {
    description: "[Write] Set a per-product GPU cap on the shared resource pool, or reset the pool to defaults (RFC 0003 Phase 4).",
    inputSchema: z.object({
      productId: z.number().int().optional().describe("Product to cap"),
      cap: z.number().int().positive().optional().describe("Max concurrently reserved units for the product"),
      reset: z.boolean().optional().describe("Reset the pool to default config"),
    }),
  }, async ({ productId, cap, reset }) => {
    const pool = getFactoryResourcePool();
    if (reset) {
      const fresh = resetFactoryResourcePool();
      return { content: [{ type: "text", text: JSON.stringify({ status: fresh.status(), config: fresh.configSnapshot() }, null, 2) }] };
    }
    if (productId == null || cap == null || cap <= 0) {
      return { content: [{ type: "text", text: JSON.stringify({ error: "productId and cap (>0) required" }, null, 2) }] };
    }
    pool.setProductCap(productId, cap);
    return { content: [{ type: "text", text: JSON.stringify({ productId, status: pool.status(), config: pool.configSnapshot() }, null, 2) }] };
  });

  server.registerTool("run_factory_eval", {
    description: "[Write] Run a factory-scale multi-product A/B eval: two factory configs race on throughput, cycle time, defect rate, and cost (RFC 0003 Phase 4).",
    inputSchema: z.object({
      scenario: z.object({
        goal: z.string().describe("Shared goal across both arms"),
        tasks: z.array(z.string()).describe("Work-order goals dispatched across stations"),
        acceptanceCriteria: z.array(z.string()).optional().describe("Criteria for correctness judgment"),
      }),
      configA: z.object({
        label: z.string().describe("Arm A label"),
        stations: z.array(z.object({ role: z.enum(["build", "review", "debug", "refactor", "explore", "team"]), wipLimit: z.number().int().positive().optional(), capacity: z.number().int().positive().optional() })).describe("Station roles"),
        wipLimit: z.number().int().positive().optional(),
        pool: z.object({ totalUnits: z.number().int().positive().optional(), productCap: z.number().int().positive().optional() }).optional(),
        defectRate: z.number().min(0).max(1).optional(),
      }),
      configB: z.object({
        label: z.string().describe("Arm B label"),
        stations: z.array(z.object({ role: z.enum(["build", "review", "debug", "refactor", "explore", "team"]), wipLimit: z.number().int().positive().optional(), capacity: z.number().int().positive().optional() })).describe("Station roles"),
        wipLimit: z.number().int().positive().optional(),
        pool: z.object({ totalUnits: z.number().int().positive().optional(), productCap: z.number().int().positive().optional() }).optional(),
        defectRate: z.number().min(0).max(1).optional(),
      }),
    }),
  }, async ({ scenario, configA, configB }) => {
    try {
      const report = await runFactoryEval({
        scenario: scenario as FactoryEvalScenario,
        runner: simulateFactoryRun,
        configA: configA as FactoryEvalConfig,
        configB: configB as FactoryEvalConfig,
      });
      return { content: [{ type: "text", text: JSON.stringify(report, null, 2) }] };
    } catch (err) {
      return { content: [{ type: "text", text: JSON.stringify({ error: err instanceof Error ? err.message : String(err) }, null, 2) }] };
    }
  });
}
