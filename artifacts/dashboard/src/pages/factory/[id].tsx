import { useMemo, useState } from "react";
import { Link, useRoute } from "wouter";
import { ArrowLeft, Play, Loader2, GitBranch, Coins } from "lucide-react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useFactoryProduct,
  useFactoryWorkOrders,
  useFactoryStations,
  useFactoryDashboard,
  useFactoryMetrics,
  useFactoryArbitration,
  useRunDispatch,
  useUpdateFactoryProduct,
} from "@/hooks/use-factory";
import { useFactoryStream, type FactoryStreamStatus } from "@/hooks/use-factory-stream";
import { FlowBoard } from "@/components/factory/flow-board";
import { SignalRail, computeSignals } from "@/components/factory/signal-rail";
import { ArbitrationPanel } from "@/components/factory/arbitration-panel";

function StreamStatusBadge({ status }: { status: FactoryStreamStatus }) {
  if (status === "connected") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-emerald-400">
        <span className="relative flex h-1.5 w-1.5">
          <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
          <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400" />
        </span>
        Live
      </span>
    );
  }
  if (status === "reconnecting") {
    return (
      <span className="inline-flex items-center gap-1 text-[10px] font-medium text-amber-400">
        <span className="relative flex h-1.5 w-1.5 rounded-full bg-amber-400 animate-pulse" />
        Reconnecting
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 text-[10px] font-medium text-muted-foreground/60">
      <span className="relative flex h-1.5 w-1.5 rounded-full bg-muted-foreground/40" />
      Polling
    </span>
  );
}

function TrendsBand({ productId }: { productId: number }) {
  const { data: metrics } = useFactoryMetrics(productId, 50);
  const { data: dashboard } = useFactoryDashboard(productId);
  const [range, setRange] = useState<24 | 168 | 720>(24);

  const points = (metrics?.metrics ?? []).filter((m) => {
    const age = Date.now() - new Date(m.snapshotTime).getTime();
    return age <= range * 3_600_000;
  });

  const series = (key: string): Array<{ t: number; v: number }> => {
    const raw = points
      .map((m) => ({ t: new Date(m.snapshotTime).getTime(), v: Number((m.snapshotJson as Record<string, unknown>)[key]) }))
      .filter((p) => Number.isFinite(p.v));
    if (dashboard) raw.push({ t: Date.now(), v: Number((dashboard as unknown as Record<string, unknown>)[key] ?? 0) });
    return raw;
  };

  const charts: Array<{ label: string; key: string; color: string; fmt: (v: number) => string }> = [
    { label: "Defect rate", key: "defectRate", color: "var(--accent-danger)", fmt: (v) => `${(v * 100).toFixed(0)}%` },
    { label: "Rework rate", key: "reworkRate", color: "var(--accent-violet)", fmt: (v) => `${(v * 100).toFixed(0)}%` },
    { label: "Cost / order", key: "costPerWorkOrder", color: "var(--accent-cyan)", fmt: (v) => `$${v.toFixed(2)}` },
    { label: "Cycle (min)", key: "avgCycleTimeMs", color: "#f59e0b", fmt: (v) => `${(v / 60000).toFixed(0)}m` },
  ];

  const spark = (data: Array<{ t: number; v: number }>, color: string) => {
    if (data.length < 2) return null;
    const tMin = Math.min(...data.map((p) => p.t));
    const tMax = Math.max(...data.map((p) => p.t));
    const vMin = Math.min(...data.map((p) => p.v));
    const vMax = Math.max(...data.map((p) => p.v));
    const span = vMax - vMin || 1;
    const path = data
      .map((p, i) => {
        const x = ((p.t - tMin) / (tMax - tMin || 1)) * 100;
        const y = 28 - ((p.v - vMin) / span) * 24;
        return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`;
      })
      .join(" ");
    return <path d={path} fill="none" stroke={color} strokeWidth="1.5" strokeLinecap="round" />;
  };

  return (
    <div className="glass-card p-4 space-y-3" style={{ borderRadius: 14 }}>
      <div className="flex items-center justify-between">
        <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Trends</span>
        <div className="flex items-center gap-1">
          {([24, 168, 720] as const).map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className="text-[9px] font-mono px-1.5 py-0.5 rounded transition-colors"
              style={{
                color: range === r ? "var(--text-primary)" : "var(--text-muted)",
                background: range === r ? "var(--bg-glass-hover)" : undefined,
              }}
            >
              {r === 24 ? "24h" : r === 168 ? "7d" : "30d"}
            </button>
          ))}
        </div>
      </div>
      {points.length === 0 ? (
        <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
          Collecting metrics — snapshots appear as the line runs.
        </p>
      ) : (
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {charts.map((c) => {
            const data = series(c.key);
            const last = data[data.length - 1];
            return (
              <div key={c.key} className="rounded-xl p-2.5" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)" }}>
                <p className="text-[9px] uppercase tracking-wide" style={{ color: "var(--text-muted)" }}>{c.label}</p>
                <p className="text-sm font-bold mt-0.5" style={{ color: "var(--text-primary)" }}>
                  {last ? c.fmt(last.v) : "—"}
                </p>
                <svg viewBox="0 0 100 30" className="w-full h-8 mt-1" preserveAspectRatio="none">
                  {spark(data, c.color)}
                </svg>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

function RoadmapPanel({ productId, roadmap, orders }: { productId: number; roadmap: number[]; orders: { id: number; goal: string; status: string }[] }) {
  const byId = new Map(orders.map((o) => [o.id, o]));
  const items = roadmap.map((id) => ({ id, order: byId.get(id) })).filter((x) => x.order);
  return (
    <div className="glass-card p-4 space-y-2" style={{ borderRadius: 14 }}>
      <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Roadmap</span>
      {items.length === 0 ? (
        <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
          No roadmap yet — decompose an intent or create work orders.
        </p>
      ) : (
        <div className="space-y-1.5">
          {items.map(({ order }) => (
            <div key={order!.id} className="flex items-center gap-2 text-[11px] rounded-lg px-2 py-1.5" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)" }}>
              <span className="font-mono text-[9px]" style={{ color: "var(--text-muted)" }}>#{order!.id}</span>
              <span className="flex-1 truncate" style={{ color: "var(--text-primary)" }}>{order!.goal}</span>
              <span className="font-mono text-[9px]" style={{ color: order!.status === "done" || order!.status === "skipped" ? "var(--accent-success)" : "var(--text-muted)" }}>
                {order!.status}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

export default function FactoryControlRoom() {
  const [, params] = useRoute("/factory/:id");
  const productId = params?.id ? parseInt(params.id, 10) : NaN;
  const validId = Number.isFinite(productId) && productId > 0 ? productId : null;

  const qc = useQueryClient();
  const streamStatus = useFactoryStream(validId);

  const { data: productData, isLoading: productLoading } = useFactoryProduct(validId);
  const { data: ordersData } = useFactoryWorkOrders(validId);
  const { data: stationsData } = useFactoryStations(validId);
  const { data: dashboard } = useFactoryDashboard(validId);
  const { data: arbitrationData } = useFactoryArbitration(validId);

  const dispatch = useRunDispatch(validId);
  const updateProduct = useUpdateFactoryProduct();

  const product = productData?.product ?? null;
  const orders = ordersData?.workOrders ?? [];
  const stations = stationsData?.stations ?? [];

  const signals = useMemo(
    () =>
      computeSignals(dashboard, arbitrationData, {
        raiseStationWip: () => qc.invalidateQueries({ queryKey: ["factory"] }),
        reviewPriority: () => qc.invalidateQueries({ queryKey: ["factory"] }),
        reviewBudget: () => qc.invalidateQueries({ queryKey: ["factory"] }),
        openDeps: () => qc.invalidateQueries({ queryKey: ["factory"] }),
      }),
    [dashboard, arbitrationData, qc],
  );

  if (!validId) {
    return (
      <div className="p-8 text-center" style={{ color: "var(--text-secondary)" }}>
        Invalid product id.
      </div>
    );
  }

  if (productLoading) {
    return (
      <div className="p-6 space-y-4">
        <div className="glass-card p-4 h-20 shimmer" style={{ borderRadius: 14 }} />
        <div className="glass-card p-4 h-96 shimmer" style={{ borderRadius: 14 }} />
      </div>
    );
  }

  if (!product) {
    return (
      <div className="p-8 text-center space-y-3" style={{ color: "var(--text-secondary)" }}>
        <p>Product not found.</p>
        <Link href="/factory" className="text-xs" style={{ color: "var(--accent-cyan)" }}>
          Back to the factory
        </Link>
      </div>
    );
  }

  const bumpPriority = async () => {
    const next = product.priority === "p0" ? "p0" : product.priority === "p1" ? "p0" : "p1";
    await updateProduct.mutateAsync({ id: product.id, priority: next });
  };

  return (
    <div className="p-6 lg:p-8 space-y-4 max-w-7xl mx-auto glass-emerge">
      <div className="flex items-center gap-3">
        <Link href="/factory">
          <span className="p-2 rounded-xl transition-colors cursor-pointer" style={{ color: "var(--text-secondary)", background: "var(--bg-glass)" }}>
            <ArrowLeft className="w-3.5 h-3.5" />
          </span>
        </Link>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <h1 className="text-lg font-bold tracking-tight truncate" style={{ color: "var(--text-primary)" }}>
              {product.name}
            </h1>
            <span className="text-[10px] font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-glass)" }}>
              {product.priority.toUpperCase()}
            </span>
          </div>
          <p className="text-[11px] font-mono flex items-center gap-1.5 truncate" style={{ color: "var(--text-muted)" }}>
            <GitBranch className="w-3 h-3" />
            {product.repoUrl}
          </p>
        </div>
        <StreamStatusBadge status={streamStatus} />
        <button
          type="button"
          disabled={dispatch.isPending}
          onClick={() => dispatch.mutate()}
          className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-xl transition-all disabled:opacity-50"
          style={{
            background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-violet))",
            color: "#fff",
            boxShadow: "0 2px 10px rgba(0,180,216,0.25)",
          }}
        >
          {dispatch.isPending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
          Run dispatch
        </button>
      </div>

      <div className="flex items-center gap-3 flex-wrap text-[11px] font-mono">
        <span className="px-2 py-1 rounded-lg" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)", color: "var(--text-secondary)" }}>
          WIP {dashboard?.productWip.used ?? orders.filter((o) => o.status === "dispatched" || o.status === "in_progress").length}/{product.wipLimit}
        </span>
        <span className="px-2 py-1 rounded-lg flex items-center gap-1" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)", color: "var(--text-secondary)" }}>
          <Coins className="w-3 h-3" />
          ${(dashboard?.totalSpendUsd ?? 0).toFixed(2)} spend
        </span>
        <button
          type="button"
          onClick={bumpPriority}
          className="px-2 py-1 rounded-lg transition-colors"
          style={{ color: "var(--accent-cyan)", background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)" }}
        >
          Bump to P0
        </button>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_300px] gap-4">
        <div className="space-y-4 min-w-0">
          <FlowBoard orders={orders} stations={stations} dashboard={dashboard ?? null} />
          <TrendsBand productId={validId} />
          <RoadmapPanel productId={validId} roadmap={product.roadmap} orders={orders} />
        </div>
        <div className="space-y-4">
          <SignalRail signals={signals} onFix={() => qc.invalidateQueries({ queryKey: ["factory"] })} />
          <ArbitrationPanel
            pass={arbitrationData ? {
              passId: arbitrationData.passId,
              ranAt: arbitrationData.ranAt,
              dispatched: arbitrationData.lines.filter((l) => l.outcome === "dispatched").length,
              held: arbitrationData.lines.filter((l) => l.outcome === "held").length,
              lines: arbitrationData.lines,
              starvationSignals: arbitrationData.starvationSignals,
              lanePool: arbitrationData.lanePool,
            } : null}
            product={product}
            onMutated={() => dispatch.mutate()}
          />
        </div>
      </div>
    </div>
  );
}
