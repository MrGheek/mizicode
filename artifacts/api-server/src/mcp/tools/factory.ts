import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createDbFactoryStore, FactoryRegistry } from "../../services/factory.js";
import { dispatchWorkOrders, completeWorkOrder, rejectToRework } from "../../services/factory-dispatcher.js";
import { admitMerge } from "../../services/factory-admission.js";

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
}
