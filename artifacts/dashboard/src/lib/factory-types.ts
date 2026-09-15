/**
 * factory-types.ts — RFC 0005/0006: typed shapes for the factory control room.
 * Mirrors the backend serializers in artifacts/api-server/src/routes/factory.ts.
 */

export type ProductPriority = "p0" | "p1" | "p2";
export type WorkOrderPriority = "high" | "normal" | "low";
export type WorkOrderStatus = "queued" | "dispatched" | "in_progress" | "blocked" | "done" | "skipped";
export type StationRole = "build" | "review" | "debug" | "refactor" | "explore" | "team";

export interface FactoryProduct {
  id: number;
  name: string;
  repoUrl: string;
  factoryId: number | null;
  priority: ProductPriority;
  dueDate: string | null;
  budgetUsd: number | null;
  roadmap: number[];
  wipLimit: number;
  qualityGateConfig: Record<string, unknown> | null;
  pipelineConfig: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryWorkOrder {
  id: number;
  productId: number;
  goal: string;
  priority: WorkOrderPriority;
  dependencies: number[];
  acceptanceCriteria: Record<string, unknown> | null;
  assignedStationId: number | null;
  status: WorkOrderStatus;
  reworkCount: number;
  lastDefectClass: string | null;
  sessionId: number | null;
  createdAt: string;
  updatedAt: string;
  startedAt: string | null;
  completedAt: string | null;
}

export interface FactoryStation {
  id: number;
  productId: number;
  sessionId: number | null;
  role: StationRole;
  capacity: number;
  wipLimit: number;
  defectCount: number;
  reworkCycles: number;
  createdAt: string;
  updatedAt: string;
}

export interface FactoryDashboard {
  completedThisPeriod: number;
  completedTotal: number;
  avgCycleTimeMs: number | null;
  medianCycleTimeMs: number | null;
  defectRate: number;
  reworkRate: number;
  meanCyclesToClear: number | null;
  productWip: { used: number; limit: number };
  stationUtilization: Array<{
    stationId: number;
    used: number;
    limit: number;
    effectiveLimit: number;
    defectRate: number;
  }>;
  pipelineStages: unknown;
  totalSpendUsd: number;
  costPerWorkOrder: number;
  snapshotTime: string;
}

export interface FactoryMetric {
  id: number;
  productId: number;
  snapshotTime: string;
  snapshotJson: Record<string, unknown>;
  createdAt: string;
}

export interface ArbitrationFactors {
  productWeight: number;
  orderWeight: number;
  dueDatePressure: number;
  budgetWeight: number;
}

export interface ArbitrationLine {
  workOrderId: number;
  productId: number;
  productPriority: ProductPriority;
  orderPriority: WorkOrderPriority;
  dueDate: string | null;
  dispatchScore: number;
  factors: ArbitrationFactors;
  outcome: "dispatched" | "held";
  reason: string | null;
  lostTo: Array<{ workOrderId: number; dispatchScore: number; productId: number }>;
}

export interface StarvationSignal {
  starvedWorkOrderId: number;
  productId: number;
  heldForMs: number;
  holdingClaims: Array<{ claimId: number; productId: number; stationId: number; sessionId: number; score: number }>;
}

export interface LanePoolStatus {
  lanePoolUsed: number;
  lanePoolLimit: number;
  freeLanes: number;
  activeClaims: number;
}

export interface ArbitrationPass {
  passId: number;
  ranAt: string;
  dispatched: number;
  held: number;
  lines: ArbitrationLine[];
  starvationSignals: StarvationSignal[];
  lanePool: LanePoolStatus;
}

export interface FabStatus {
  fab: { id: number; name: string; lanePoolLimit: number; budgetUsd: number | null };
  lanePool: LanePoolStatus;
  products: number;
}

export interface FactoryEventPayload {
  type: string;
  [key: string]: unknown;
}

export interface FactoryEventMessage {
  type: "factory_event";
  event: FactoryEventPayload;
}
