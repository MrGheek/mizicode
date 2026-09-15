import type { FactoryProduct, FactoryDashboard } from "@/lib/factory-types";

export type ProductHealth = "flowing" | "constrained" | "stalled" | "unknown";

export function deriveHealth(dashboard: FactoryDashboard | null | undefined): ProductHealth {
  if (!dashboard) return "unknown";
  const clamped = (dashboard.stationUtilization ?? []).some((u) => u.effectiveLimit != null && u.effectiveLimit < u.limit);
  const saturated = dashboard.productWip.used >= dashboard.productWip.limit;
  if (clamped) return "constrained";
  if (saturated) return "constrained";
  return "flowing";
}

const HEALTH_STYLE: Record<ProductHealth, { color: string; label: string }> = {
  flowing: { color: "var(--accent-success)", label: "Flowing" },
  constrained: { color: "#f59e0b", label: "Constrained" },
  stalled: { color: "var(--accent-danger)", label: "Stalled" },
  unknown: { color: "var(--text-muted)", label: "Unknown" },
};

export function ProductHealthLight({ health }: { health: ProductHealth }) {
  const style = HEALTH_STYLE[health];
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="relative flex h-2 w-2">
        <span className="animate-ping absolute inline-flex h-full w-full rounded-full opacity-40" style={{ background: style.color }} />
        <span className="relative inline-flex rounded-full h-2 w-2" style={{ background: style.color }} />
      </span>
      <span className="text-[10px] font-medium" style={{ color: style.color }}>{style.label}</span>
    </span>
  );
}

export function ProductCard({ product, dashboard }: { product: FactoryProduct; dashboard?: FactoryDashboard | null }) {
  const health = deriveHealth(dashboard);
  return (
    <div className="glass-card p-4 space-y-2" style={{ borderRadius: 14 }}>
      <div className="flex items-center justify-between gap-2">
        <p className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{product.name}</p>
        <ProductHealthLight health={health} />
      </div>
      <p className="text-[10px] font-mono truncate" style={{ color: "var(--text-muted)" }}>{product.repoUrl}</p>
      <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
        <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-glass)" }}>
          {product.priority.toUpperCase()}
        </span>
        {dashboard ? (
          <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-glass)" }}>
            WIP {dashboard.productWip.used}/{dashboard.productWip.limit}
          </span>
        ) : (
          <span style={{ color: "var(--text-muted)" }}>WIP —/—</span>
        )}
        <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-glass)" }}>
          ${(dashboard?.totalSpendUsd ?? 0).toFixed(2)}
        </span>
      </div>
    </div>
  );
}
