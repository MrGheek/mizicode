import type { FactoryWorkOrder } from "@/lib/factory-types";

const PRIORITY_LABEL: Record<string, string> = { high: "High", normal: "Normal", low: "Low" };

export function priorityColor(priority: string): string {
  if (priority === "high") return "var(--accent-danger)";
  if (priority === "low") return "var(--text-muted)";
  return "var(--accent-cyan)";
}

export function WorkOrderCard({
  order,
  stationRole,
  blocked,
  heldReason,
}: {
  order: FactoryWorkOrder;
  stationRole?: string | null;
  blocked?: boolean;
  heldReason?: string | null;
}) {
  const stateColor = blocked
    ? "#f59e0b"
    : order.reworkCount > 0 && order.status !== "done" && order.status !== "skipped"
      ? "var(--accent-violet)"
      : "var(--accent-cyan)";

  return (
    <div
      className="glass-card p-3 space-y-1.5"
      style={{ borderRadius: 12, borderLeft: `3px solid ${stateColor}` }}
      role="listitem"
      aria-label={`Work order ${order.id}: ${order.goal}`}
    >
      <div className="flex items-start justify-between gap-2">
        <p className="text-xs font-medium leading-snug" style={{ color: "var(--text-primary)" }}>
          {order.goal}
        </p>
        <span
          className="text-[9px] font-mono shrink-0 px-1.5 py-0.5 rounded-full"
          style={{ color: priorityColor(order.priority), background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)" }}
        >
          {PRIORITY_LABEL[order.priority] ?? order.priority}
        </span>
      </div>
      <div className="flex items-center gap-1.5 flex-wrap">
        <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
          #{order.id}
        </span>
        {stationRole && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "var(--accent-warm)", color: "var(--accent-cyan)" }}>
            {stationRole}
          </span>
        )}
        {order.reworkCount > 0 && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(108,99,245,0.12)", color: "var(--accent-violet)" }}>
            rework ×{order.reworkCount}
          </span>
        )}
        {blocked && (
          <span className="text-[9px] font-mono px-1.5 py-0.5 rounded" style={{ background: "rgba(245,158,11,0.12)", color: "#f59e0b" }}>
            blocked
          </span>
        )}
      </div>
      {heldReason && (
        <p className="text-[10px] leading-snug" style={{ color: "#f59e0b" }}>
          {heldReason}
        </p>
      )}
    </div>
  );
}
