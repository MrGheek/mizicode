/**
 * factory-resource-pool.ts — RFC 0003 Phase 4: cross-product resource
 * arbitration over a shared GPU pool.
 *
 * Products share one pool of compute units (GPU budgets). Arbitration is the
 * explicit, advisory layer on top of WIP-bounded dispatch: before a work order
 * is dispatched, the dispatcher asks the pool for units; the pool grants them
 * only when BOTH the per-product cap and the shared pool headroom allow it.
 *
 * Like the factory dispatcher, the pool is advisory by design (RFC 0003
 * non-goal: no central scheduler as a single point of failure) — stations keep
 * working when it is down. Reservations are keyed by work order and released on
 * completion / rework, so a product that exceeds its cap holds orders instead
 * of spawning unbounded lanes.
 */

export interface ResourcePoolConfig {
  /** Total units in the shared pool. */
  totalUnits: number;
  /** Cap applied to any product without an explicit per-product cap. */
  defaultProductCap: number;
  /** Explicit per-product caps: productId → max concurrently reserved units. */
  perProductCaps: Record<number, number>;
}

export const DEFAULT_POOL_TOTAL_UNITS = 8;
/** Fair-share default: a product may hold at most half the pool. */
export const DEFAULT_PRODUCT_CAP_UNITS = 4;

export const DEFAULT_RESOURCE_POOL_CONFIG: ResourcePoolConfig = {
  totalUnits: DEFAULT_POOL_TOTAL_UNITS,
  defaultProductCap: DEFAULT_PRODUCT_CAP_UNITS,
  perProductCaps: {},
};

export interface PoolReservation {
  workOrderId: number;
  productId: number;
  units: number;
}

export interface ResourceAllowance {
  allowed: boolean;
  /** Human-readable reason when not allowed. */
  reason: string | null;
  /** Units re-checked against. */
  units: number;
  /** Reserved units for the product at time of check. */
  productReserved: number;
  /** Effective cap for the product. */
  productCap: number;
  /** Total pool units reserved at time of check. */
  poolUsed: number;
  /** Total pool units. */
  poolTotal: number;
}

export interface ProductPoolStatus {
  productId: number;
  cap: number;
  reservedUnits: number;
  freeUnits: number;
}

export interface ResourcePoolStatus {
  totalUnits: number;
  usedUnits: number;
  freeUnits: number;
  products: ProductPoolStatus[];
  reservations: Array<{ workOrderId: number; productId: number; units: number }>;
}

export interface ResourcePool {
  canReserve(productId: number, units: number): ResourceAllowance;
  reserve(productId: number, workOrderId: number, units: number): void;
  release(productId: number, workOrderId: number): void;
  setProductCap(productId: number, cap: number): void;
  status(): ResourcePoolStatus;
}

/** Effective cap for a product from a pool config. */
export function productCap(config: ResourcePoolConfig, productId: number): number {
  return config.perProductCaps[productId] ?? config.defaultProductCap;
}

/**
 * Pure arbitration decision: can `units` more units be reserved for a product
 * given the current reservations and pool config? Ends both the per-product
 * cap and the shared pool headroom.
 */
export function canAllocate(
  config: ResourcePoolConfig,
  reservations: PoolReservation[],
  productId: number,
  units: number,
): ResourceAllowance {
  const cap = productCap(config, productId);
  const productReserved = reservations
    .filter((r) => r.productId === productId)
    .reduce((acc, r) => acc + r.units, 0);
  const poolUsed = reservations.reduce((acc, r) => acc + r.units, 0);

  if (productReserved + units > cap) {
    return {
      allowed: false,
      reason: `product resource cap reached (${productReserved}/${cap} units reserved)`,
      units,
      productReserved,
      productCap: cap,
      poolUsed,
      poolTotal: config.totalUnits,
    };
  }
  if (poolUsed + units > config.totalUnits) {
    return {
      allowed: false,
      reason: `shared pool exhausted (${poolUsed}/${config.totalUnits} units reserved)`,
      units,
      productReserved,
      productCap: cap,
      poolUsed,
      poolTotal: config.totalUnits,
    };
  }
  return {
    allowed: true,
    reason: null,
    units,
    productReserved,
    productCap: cap,
    poolUsed,
    poolTotal: config.totalUnits,
  };
}

/**
 * In-memory ResourcePool. Reservations are keyed by work order so a product
 * holds exactly the units of its in-flight work — released on completion or
 * rework. Kept in memory (advisory); caps are runtime-configurable.
 */
export class MemoryResourcePool implements ResourcePool {
  private config: ResourcePoolConfig;
  private reservations: Map<number, PoolReservation> = new Map();

  constructor(config: ResourcePoolConfig = DEFAULT_RESOURCE_POOL_CONFIG) {
    this.config = {
      totalUnits: config.totalUnits,
      defaultProductCap: config.defaultProductCap,
      perProductCaps: { ...config.perProductCaps },
    };
  }

  listReservations(): PoolReservation[] {
    return Array.from(this.reservations.values());
  }

  canReserve(productId: number, units: number): ResourceAllowance {
    return canAllocate(this.config, this.listReservations(), productId, units);
  }

  reserve(productId: number, workOrderId: number, units: number): void {
    this.reservations.set(workOrderId, { workOrderId, productId, units });
  }

  release(productId: number, workOrderId: number): void {
    const existing = this.reservations.get(workOrderId);
    if (existing && existing.productId === productId) {
      this.reservations.delete(workOrderId);
    }
  }

  setProductCap(productId: number, cap: number): void {
    this.config.perProductCaps[productId] = Math.max(1, Math.floor(cap));
  }

  configSnapshot(): ResourcePoolConfig {
    return {
      totalUnits: this.config.totalUnits,
      defaultProductCap: this.config.defaultProductCap,
      perProductCaps: { ...this.config.perProductCaps },
    };
  }

  status(): ResourcePoolStatus {
    const reservations = this.listReservations();
    const usedUnits = reservations.reduce((acc, r) => acc + r.units, 0);
    const byProduct = new Map<number, { cap: number; reserved: number }>();
    for (const r of reservations) {
      const entry = byProduct.get(r.productId) ?? { cap: productCap(this.config, r.productId), reserved: 0 };
      entry.reserved += r.units;
      byProduct.set(r.productId, entry);
    }
    const productIds = new Set<number>([...byProduct.keys(), ...Object.keys(this.config.perProductCaps).map(Number)]);
    const products: ProductPoolStatus[] = Array.from(productIds).map((productId) => {
      const cap = productCap(this.config, productId);
      const reserved = byProduct.get(productId)?.reserved ?? 0;
      return { productId, cap, reservedUnits: reserved, freeUnits: Math.max(0, cap - reserved) };
    });
    return {
      totalUnits: this.config.totalUnits,
      usedUnits,
      freeUnits: Math.max(0, this.config.totalUnits - usedUnits),
      products,
      reservations: reservations.map(({ workOrderId, productId, units }) => ({ workOrderId, productId, units })),
    };
  }
}

let singleton: MemoryResourcePool | null = null;

/** Process-wide default pool used by HTTP/MCP surfaces (advisory singleton). */
export function getFactoryResourcePool(): MemoryResourcePool {
  if (!singleton) {
    singleton = new MemoryResourcePool(DEFAULT_RESOURCE_POOL_CONFIG);
  }
  return singleton;
}

/** Test helper / reset for the process-wide pool. */
export function resetFactoryResourcePool(config?: ResourcePoolConfig): MemoryResourcePool {
  singleton = new MemoryResourcePool(config ?? DEFAULT_RESOURCE_POOL_CONFIG);
  return singleton;
}