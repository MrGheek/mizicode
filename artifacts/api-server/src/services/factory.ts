/**
 * factory.ts — RFC 0003 Phase 1: product / work-order / station registry.
 *
 * A product is a repo with a roadmap that outlives any single session. Work
 * orders are the unit of factory work — they flow through stations (sessions
 * with a role + capacity), not through sessions directly. This module owns the
 * CRUD + lifecycle of those three entities; the dispatcher
 * (factory-dispatcher.ts) owns WIP-bounded scheduling.
 *
 * The store is pluggable so tests run against memory while production uses
 * the products / work_orders / stations tables.
 */

import { db, productsTable, workOrdersTable, stationsTable, reworkItemsTable, pipelineRunsTable, factoryMetricsTable } from "@workspace/db";
import { eq, and, inArray, desc, sql } from "drizzle-orm";
import { logger } from "../lib/logger";
import type { Product, WorkOrder, Station, ReworkItem, PipelineRun, FactoryMetrics, WorkOrderStatus, WorkOrderPriority, StationRole, PipelineStage, PipelineStatus } from "@workspace/db";

// ── Types ──────────────────────────────────────────────────────────────────────

export interface CreateProductParams {
  name: string;
  repoUrl: string;
  wipLimit?: number;
  qualityGateConfig?: Record<string, unknown> | null;
  pipelineConfig?: Record<string, unknown> | null;
}

export interface CreateWorkOrderParams {
  productId: number;
  goal: string;
  priority?: WorkOrderPriority;
  dependencies?: number[];
  acceptanceCriteria?: Record<string, unknown> | null;
}

export interface CreateStationParams {
  productId: number;
  sessionId?: number | null;
  role?: StationRole;
  capacity?: number;
  wipLimit?: number;
}

export interface FactoryStore {
  // products
  createProduct(params: CreateProductParams): Promise<Product>;
  getProduct(id: number): Promise<Product | null>;
  getProductByRepo(repoUrl: string): Promise<Product | null>;
  listProducts(): Promise<Product[]>;
  updateProduct(id: number, patch: Partial<Product>): Promise<Product | null>;
  // work orders
  createWorkOrder(params: CreateWorkOrderParams): Promise<WorkOrder>;
  getWorkOrder(id: number): Promise<WorkOrder | null>;
  listWorkOrders(productId: number, statuses?: WorkOrderStatus[]): Promise<WorkOrder[]>;
  updateWorkOrder(id: number, patch: Partial<WorkOrder>): Promise<WorkOrder | null>;
  // stations
  createStation(params: CreateStationParams): Promise<Station>;
  getStation(id: number): Promise<Station | null>;
  listStations(productId: number): Promise<Station[]>;
  updateStation(id: number, patch: Partial<Station>): Promise<Station | null>;
  // rework items
  createReworkItem(params: { workOrderId: number; stationId: number; defectClass: string; cycle: number }): Promise<ReworkItem>;
  listReworkItems(workOrderId: number): Promise<ReworkItem[]>;
  clearReworkItems(workOrderId: number): Promise<void>;
  // pipeline runs
  createPipelineRun(params: { productId: number; triggerWorkOrderId?: number | null; stage: PipelineStage }): Promise<PipelineRun>;
  getPipelineRun(id: number): Promise<PipelineRun | null>;
  listPipelineRuns(productId: number, stage?: PipelineStage): Promise<PipelineRun[]>;
  updatePipelineRun(id: number, patch: Partial<PipelineRun>): Promise<PipelineRun | null>;
  // factory metrics
  insertFactoryMetrics(params: { productId: number; snapshot: Record<string, unknown> }): Promise<FactoryMetrics>;
  listFactoryMetrics(productId: number, limit?: number): Promise<FactoryMetrics[]>;
}

// ── In-memory store (tests) ───────────────────────────────────────────────────

export class MemoryFactoryStore implements FactoryStore {
  private nextProduct = 1;
  private nextWorkOrder = 1;
  private nextStation = 1;
  private products: Product[] = [];
  private workOrders: WorkOrder[] = [];
  private stations: Station[] = [];
  private reworkItems: ReworkItem[] = [];
  private nextReworkItem = 1;
  private pipelineRuns: PipelineRun[] = [];
  private nextPipelineRun = 1;
  private factoryMetrics: FactoryMetrics[] = [];
  private nextFactoryMetrics = 1;

  async createProduct(params: CreateProductParams): Promise<Product> {
    const now = new Date();
    const p: Product = {
      id: this.nextProduct++,
      name: params.name,
      repoUrl: params.repoUrl,
      roadmapJson: [],
      wipLimit: params.wipLimit ?? 4,
      qualityGateConfig: params.qualityGateConfig ?? null,
      pipelineConfig: params.pipelineConfig ?? null,
      createdAt: now,
      updatedAt: now,
    };
    this.products.push(p);
    return p;
  }

  async getProduct(id: number): Promise<Product | null> {
    return this.products.find((p) => p.id === id) ?? null;
  }

  async getProductByRepo(repoUrl: string): Promise<Product | null> {
    return this.products.find((p) => p.repoUrl === repoUrl) ?? null;
  }

  async listProducts(): Promise<Product[]> {
    return [...this.products];
  }

  async updateProduct(id: number, patch: Partial<Product>): Promise<Product | null> {
    const p = this.products.find((x) => x.id === id);
    if (!p) return null;
    Object.assign(p, patch, { updatedAt: new Date() });
    return p;
  }

  async createWorkOrder(params: CreateWorkOrderParams): Promise<WorkOrder> {
    const now = new Date();
    const w: WorkOrder = {
      id: this.nextWorkOrder++,
      productId: params.productId,
      goal: params.goal,
      priority: params.priority ?? "normal",
      dependenciesJson: params.dependencies ?? [],
      acceptanceCriteria: params.acceptanceCriteria ?? null,
      assignedStationId: null,
      status: "queued",
      reworkCount: 0,
      lastDefectClass: null,
      sessionId: null,
      createdAt: now,
      updatedAt: now,
      startedAt: null,
      completedAt: null,
    };
    this.workOrders.push(w);
    return w;
  }

  async getWorkOrder(id: number): Promise<WorkOrder | null> {
    return this.workOrders.find((w) => w.id === id) ?? null;
  }

  async listWorkOrders(productId: number, statuses?: WorkOrderStatus[]): Promise<WorkOrder[]> {
    return this.workOrders
      .filter((w) => w.productId === productId)
      .filter((w) => (statuses ? statuses.includes(w.status) : true))
      .sort((a, b) => a.id - b.id);
  }

  async updateWorkOrder(id: number, patch: Partial<WorkOrder>): Promise<WorkOrder | null> {
    const w = this.workOrders.find((x) => x.id === id);
    if (!w) return null;
    Object.assign(w, patch, { updatedAt: new Date() });
    return w;
  }

  async createStation(params: CreateStationParams): Promise<Station> {
    const now = new Date();
    const s: Station = {
      id: this.nextStation++,
      productId: params.productId,
      sessionId: params.sessionId ?? null,
      role: params.role ?? "build",
      capacity: params.capacity ?? 2,
      wipLimit: params.wipLimit ?? 2,
      defectCount: 0,
      reworkCycles: 0,
      createdAt: now,
      updatedAt: now,
    };
    this.stations.push(s);
    return s;
  }

  async getStation(id: number): Promise<Station | null> {
    return this.stations.find((s) => s.id === id) ?? null;
  }

  async listStations(productId: number): Promise<Station[]> {
    return this.stations.filter((s) => s.productId === productId);
  }

  async updateStation(id: number, patch: Partial<Station>): Promise<Station | null> {
    const s = this.stations.find((x) => x.id === id);
    if (!s) return null;
    Object.assign(s, patch, { updatedAt: new Date() });
    return s;
  }

  async createReworkItem(params: { workOrderId: number; stationId: number; defectClass: string; cycle: number }): Promise<ReworkItem> {
    const now = new Date();
    const r: ReworkItem = {
      id: this.nextReworkItem++,
      workOrderId: params.workOrderId,
      stationId: params.stationId,
      defectClass: params.defectClass,
      cycle: params.cycle,
      createdAt: now,
      clearedAt: null,
    };
    this.reworkItems.push(r);
    return r;
  }

  async listReworkItems(workOrderId: number): Promise<ReworkItem[]> {
    return this.reworkItems.filter((r) => r.workOrderId === workOrderId);
  }

  async clearReworkItems(workOrderId: number): Promise<void> {
    const now = new Date();
    for (const r of this.reworkItems) {
      if (r.workOrderId === workOrderId && r.clearedAt === null) {
        r.clearedAt = now;
      }
    }
  }

  async createPipelineRun(params: { productId: number; triggerWorkOrderId?: number | null; stage: PipelineStage }): Promise<PipelineRun> {
    const now = new Date();
    const run: PipelineRun = {
      id: this.nextPipelineRun++,
      productId: params.productId,
      triggerWorkOrderId: params.triggerWorkOrderId ?? null,
      stage: params.stage,
      status: "pending" as PipelineStatus,
      startedAt: null,
      completedAt: null,
      artifactsJson: null,
      gatePassed: false,
      gateDetail: null,
      createdAt: now,
    };
    this.pipelineRuns.push(run);
    return run;
  }

  async getPipelineRun(id: number): Promise<PipelineRun | null> {
    return this.pipelineRuns.find((r) => r.id === id) ?? null;
  }

  async listPipelineRuns(productId: number, stage?: PipelineStage): Promise<PipelineRun[]> {
    return this.pipelineRuns
      .filter((r) => r.productId === productId)
      .filter((r) => (stage ? r.stage === stage : true))
      .sort((a, b) => a.id - b.id);
  }

  async updatePipelineRun(id: number, patch: Partial<PipelineRun>): Promise<PipelineRun | null> {
    const r = this.pipelineRuns.find((x) => x.id === id);
    if (!r) return null;
    Object.assign(r, patch);
    return r;
  }

  async insertFactoryMetrics(params: { productId: number; snapshot: Record<string, unknown> }): Promise<FactoryMetrics> {
    const now = new Date();
    const m: FactoryMetrics = {
      id: this.nextFactoryMetrics++,
      productId: params.productId,
      snapshotTime: now,
      snapshotJson: params.snapshot,
      createdAt: now,
    };
    this.factoryMetrics.push(m);
    return m;
  }

  async listFactoryMetrics(productId: number, limit?: number): Promise<FactoryMetrics[]> {
    const items = this.factoryMetrics
      .filter((m) => m.productId === productId)
      .sort((a, b) => b.snapshotTime.getTime() - a.snapshotTime.getTime() || b.id - a.id);
    return limit ? items.slice(0, limit) : items;
  }

  clear(): void {
    this.products = [];
    this.workOrders = [];
    this.stations = [];
    this.reworkItems = [];
    this.pipelineRuns = [];
    this.factoryMetrics = [];
    this.nextProduct = 1;
    this.nextWorkOrder = 1;
    this.nextStation = 1;
    this.nextReworkItem = 1;
    this.nextPipelineRun = 1;
    this.nextFactoryMetrics = 1;
  }
}

// ── DB store (production) ─────────────────────────────────────────────────────

export function createDbFactoryStore(): FactoryStore {
  return {
    async createProduct(params) {
      const [row] = await db.insert(productsTable).values({
        name: params.name,
        repoUrl: params.repoUrl,
        wipLimit: params.wipLimit ?? 4,
        qualityGateConfig: params.qualityGateConfig ?? null,
        pipelineConfig: params.pipelineConfig ?? null,
      }).returning();
      return row;
    },
    async getProduct(id) {
      const [row] = await db.select().from(productsTable).where(eq(productsTable.id, id));
      return row ?? null;
    },
    async getProductByRepo(repoUrl) {
      const [row] = await db.select().from(productsTable).where(eq(productsTable.repoUrl, repoUrl));
      return row ?? null;
    },
    async listProducts() {
      return db.select().from(productsTable).orderBy(desc(productsTable.createdAt));
    },
    async updateProduct(id, patch) {
      const [row] = await db.update(productsTable).set({ ...patch, updatedAt: new Date() }).where(eq(productsTable.id, id)).returning();
      return row ?? null;
    },
    async createWorkOrder(params) {
      const [row] = await db.insert(workOrdersTable).values({
        productId: params.productId,
        goal: params.goal,
        priority: params.priority ?? "normal",
        dependenciesJson: params.dependencies ?? [],
        acceptanceCriteria: params.acceptanceCriteria ?? null,
      }).returning();
      return row;
    },
    async getWorkOrder(id) {
      const [row] = await db.select().from(workOrdersTable).where(eq(workOrdersTable.id, id));
      return row ?? null;
    },
    async listWorkOrders(productId, statuses) {
      if (statuses && statuses.length > 0) {
        return db.select().from(workOrdersTable)
          .where(and(eq(workOrdersTable.productId, productId), inArray(workOrdersTable.status, statuses)))
          .orderBy(desc(workOrdersTable.priority), workOrdersTable.id);
      }
      return db.select().from(workOrdersTable)
        .where(eq(workOrdersTable.productId, productId))
        .orderBy(desc(workOrdersTable.priority), workOrdersTable.id);
    },
    async updateWorkOrder(id, patch) {
      const [row] = await db.update(workOrdersTable).set({ ...patch, updatedAt: new Date() }).where(eq(workOrdersTable.id, id)).returning();
      return row ?? null;
    },
    async createStation(params) {
      const [row] = await db.insert(stationsTable).values({
        productId: params.productId,
        sessionId: params.sessionId ?? null,
        role: params.role ?? "build",
        capacity: params.capacity ?? 2,
        wipLimit: params.wipLimit ?? 2,
      }).returning();
      return row;
    },
    async getStation(id) {
      const [row] = await db.select().from(stationsTable).where(eq(stationsTable.id, id));
      return row ?? null;
    },
    async listStations(productId) {
      return db.select().from(stationsTable).where(eq(stationsTable.productId, productId));
    },
    async updateStation(id, patch) {
      const [row] = await db.update(stationsTable).set({ ...patch, updatedAt: new Date() }).where(eq(stationsTable.id, id)).returning();
      return row ?? null;
    },
    async createReworkItem(params) {
      const [row] = await db.insert(reworkItemsTable).values({
        workOrderId: params.workOrderId,
        stationId: params.stationId,
        defectClass: params.defectClass,
        cycle: params.cycle,
      }).returning();
      return row;
    },
    async listReworkItems(workOrderId) {
      return db.select().from(reworkItemsTable).where(eq(reworkItemsTable.workOrderId, workOrderId)).orderBy(reworkItemsTable.cycle);
    },
    async clearReworkItems(workOrderId) {
      await db.update(reworkItemsTable)
        .set({ clearedAt: new Date() })
        .where(and(eq(reworkItemsTable.workOrderId, workOrderId), sql`${reworkItemsTable.clearedAt} IS NULL`));
    },
    async createPipelineRun(params) {
      const [row] = await db.insert(pipelineRunsTable).values({
        productId: params.productId,
        triggerWorkOrderId: params.triggerWorkOrderId ?? null,
        stage: params.stage,
      }).returning();
      return row;
    },
    async getPipelineRun(id) {
      const [row] = await db.select().from(pipelineRunsTable).where(eq(pipelineRunsTable.id, id));
      return row ?? null;
    },
    async listPipelineRuns(productId, stage) {
      if (stage) {
        return db.select().from(pipelineRunsTable)
          .where(and(eq(pipelineRunsTable.productId, productId), eq(pipelineRunsTable.stage, stage)))
          .orderBy(pipelineRunsTable.id);
      }
      return db.select().from(pipelineRunsTable)
        .where(eq(pipelineRunsTable.productId, productId))
        .orderBy(pipelineRunsTable.id);
    },
    async updatePipelineRun(id, patch) {
      const [row] = await db.update(pipelineRunsTable).set(patch).where(eq(pipelineRunsTable.id, id)).returning();
      return row ?? null;
    },
    async insertFactoryMetrics(params) {
      const [row] = await db.insert(factoryMetricsTable).values({
        productId: params.productId,
        snapshotJson: params.snapshot,
      }).returning();
      return row;
    },
    async listFactoryMetrics(productId, limit) {
      const query = db.select().from(factoryMetricsTable)
        .where(eq(factoryMetricsTable.productId, productId))
        .orderBy(desc(factoryMetricsTable.snapshotTime), desc(factoryMetricsTable.id))
        .limit(limit ?? 100);
      return query;
    },
  };
}

// ── Registry service ──────────────────────────────────────────────────────────

export class FactoryRegistry {
  constructor(private store: FactoryStore) {}

  async createProduct(params: CreateProductParams): Promise<Product> {
    const existing = await this.store.getProductByRepo(params.repoUrl);
    if (existing) {
      throw new Error(`Product already exists for repo ${params.repoUrl} (id ${existing.id})`);
    }
    const product = await this.store.createProduct(params);
    logger.info({ productId: product.id, repoUrl: params.repoUrl }, "[factory] product created");
    return product;
  }

  async getProduct(id: number): Promise<Product | null> {
    return this.store.getProduct(id);
  }

  async listProducts(): Promise<Product[]> {
    return this.store.listProducts();
  }

  async createWorkOrder(params: CreateWorkOrderParams): Promise<WorkOrder> {
    const product = await this.store.getProduct(params.productId);
    if (!product) throw new Error(`Product ${params.productId} does not exist`);
    const order = await this.store.createWorkOrder(params);
    // Append to the product roadmap.
    await this.store.updateProduct(params.productId, {
      roadmapJson: [...product.roadmapJson, order.id],
    });
    logger.info({ productId: params.productId, workOrderId: order.id }, "[factory] work order created");
    return order;
  }

  async getWorkOrder(id: number): Promise<WorkOrder | null> {
    return this.store.getWorkOrder(id);
  }

  async listWorkOrders(productId: number, statuses?: WorkOrderStatus[]): Promise<WorkOrder[]> {
    return this.store.listWorkOrders(productId, statuses);
  }

  async createStation(params: CreateStationParams): Promise<Station> {
    const product = await this.store.getProduct(params.productId);
    if (!product) throw new Error(`Product ${params.productId} does not exist`);
    const station = await this.store.createStation(params);
    logger.info({ productId: params.productId, stationId: station.id, role: station.role }, "[factory] station created");
    return station;
  }

  async listStations(productId: number): Promise<Station[]> {
    return this.store.listStations(productId);
  }

  async getStation(id: number): Promise<Station | null> {
    return this.store.getStation(id);
  }

  /** Record a defect on a station (rework loop telemetry). */
  async recordDefect(stationId: number, defectClass: string): Promise<void> {
    const station = await this.store.getStation(stationId);
    if (!station) return;
    await this.store.updateStation(stationId, {
      defectCount: station.defectCount + 1,
      reworkCycles: station.reworkCycles + 1,
    });
    logger.warn({ stationId, defectClass }, "[factory] defect recorded on station");
  }
}
