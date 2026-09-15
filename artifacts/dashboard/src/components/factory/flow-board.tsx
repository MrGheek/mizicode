/**
 * flow-board.tsx — RFC 0005: the andon. Work moving through the line with WIP
 * constraints drawn on the columns. Derived from the same data the dispatcher
 * uses: work-orders + stationUtilization.
 */

import type { FactoryWorkOrder, FactoryStation, FactoryDashboard } from "@/lib/factory-types";
import { WorkOrderCard } from "./work-order-card";

interface BoardColumn {
  key: string;
  label: string;
  statuses: FactoryWorkOrder["status"][];
  wip?: { used: number; limit: number; effectiveLimit?: number } | null;
  wipLabel?: string | null;
}

export function FlowBoard({
  orders,
  stations,
  dashboard,
}: {
  orders: FactoryWorkOrder[];
  stations: FactoryStation[];
  dashboard?: FactoryDashboard | null;
}) {
  const stationById = new Map(stations.map((s) => [s.id, s]));
  const utilization = dashboard?.stationUtilization ?? [];

  const byColumn = new Map<string, FactoryWorkOrder[]>();
  for (const o of orders) {
    const key =
      o.status === "dispatched" || o.status === "in_progress"
        ? stationById.get(o.assignedStationId ?? -1)?.role ?? "dispatched"
        : o.status;
    if (!byColumn.has(key)) byColumn.set(key, []);
    byColumn.get(key)!.push(o);
  }

  const roleColumns = new Set<string>(stations.map((s) => s.role));
  const orderedKeys = [...roleColumns].sort();

  const columns: BoardColumn[] = [
    { key: "queued", label: "Queued", statuses: ["queued"] },
    { key: "blocked", label: "Blocked", statuses: ["blocked"] },
    ...orderedKeys.map((role) => ({ key: role, label: role, statuses: [] as FactoryWorkOrder["status"][] })),
    { key: "done", label: "Shipped", statuses: ["done", "skipped"] },
  ];

  const doneOrders = orders.filter((o) => o.status === "done" || o.status === "skipped");
  const roleWip = new Map<string, { used: number; limit: number; effectiveLimit?: number }>();
  for (const role of roleColumns) {
    const station = stations.find((s) => s.role === role);
    if (!station) continue;
    const util = utilization.find((u) => u.stationId === station.id);
    const used = orders.filter((o) => o.assignedStationId === station.id && (o.status === "dispatched" || o.status === "in_progress")).length;
    roleWip.set(role, {
      used,
      limit: station.wipLimit,
      effectiveLimit: util?.effectiveLimit,
    });
  }

  return (
    <div className="overflow-x-auto pb-2" role="list" aria-label="Factory flow board">
      <div className="flex gap-3 min-w-max">
        {columns.map((col) => {
          const ordersInColumn =
            col.key === "done"
              ? doneOrders
              : col.statuses.length > 0
                ? orders.filter((o) => col.statuses.includes(o.status))
                : byColumn.get(col.key) ?? [];
          const wip = roleWip.get(col.key) ?? null;
          const effective = wip?.effectiveLimit;
          const clamped = effective != null && effective !== wip?.limit;
          return (
            <div key={col.key} className="w-56 shrink-0">
              <div className="mb-2 px-1">
                <div className="flex items-center justify-between">
                  <span className="text-[10px] font-semibold uppercase tracking-wider" style={{ color: "var(--text-secondary)" }}>
                    {col.label}
                  </span>
                  <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                    {ordersInColumn.length}
                  </span>
                </div>
                {wip && (
                  <div className="mt-0.5">
                    <span
                      className="text-[9px] font-mono px-1.5 py-0.5 rounded"
                      style={{
                        background: clamped ? "rgba(245,158,11,0.14)" : "var(--bg-glass-hover)",
                        color: clamped ? "#f59e0b" : "var(--text-muted)",
                        border: "1px solid var(--border-glass)",
                      }}
                      title={clamped ? `Effective limit ${effective} (defect-clamped from ${wip.limit})` : `WIP limit ${wip.limit}`}
                    >
                      {wip.used}/{effective ?? wip.limit}
                    </span>
                  </div>
                )}
              </div>
              <div className="space-y-2" role="listitem" aria-label={`${col.label} column`}>
                {ordersInColumn.length === 0 ? (
                  <div
                    className="rounded-xl border border-dashed h-16 flex items-center justify-center text-[10px]"
                    style={{ borderColor: "var(--border-glass)", color: "var(--text-muted)", opacity: 0.6 }}
                  >
                    empty
                  </div>
                ) : (
                  ordersInColumn.map((o) => {
                    const station = o.assignedStationId != null ? stationById.get(o.assignedStationId) : undefined;
                    return (
                      <WorkOrderCard
                        key={o.id}
                        order={o}
                        stationRole={station?.role}
                        blocked={o.status === "blocked" || (o.status === "queued" && o.dependencies.some((d) => {
                          const dep = orders.find((x) => x.id === d);
                          return dep && dep.status !== "done" && dep.status !== "skipped";
                        }))}
                      />
                    );
                  })
                )}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
