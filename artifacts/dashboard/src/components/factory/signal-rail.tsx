/**
 * signal-rail.tsx — RFC 0005: computed signals over the same payloads, each
 * with a rationale and a one-click policy fix.
 */

import { AlertTriangle, ArrowUpRight, Link2, Coins, RefreshCcw, Gauge, ShieldAlert } from "lucide-react";
import type { FactoryDashboard, ArbitrationPass } from "@/lib/factory-types";

export interface Signal {
  id: string;
  icon: typeof Gauge;
  tone: "danger" | "warn" | "info";
  title: string;
  detail: string;
  fix?: { label: string; action: () => void };
}

export function computeSignals(
  dashboard: FactoryDashboard | null | undefined,
  arbitration: { lines: ArbitrationPass["lines"]; starvationSignals: ArbitrationPass["starvationSignals"] } | null | undefined,
  actions: {
    raiseStationWip: () => void;
    reviewPriority: () => void;
    reviewBudget: () => void;
    openDeps: () => void;
  },
): Signal[] {
  const signals: Signal[] = [];

  for (const u of dashboard?.stationUtilization ?? []) {
    if (u.effectiveLimit != null && u.effectiveLimit < u.limit) {
      signals.push({
        id: `station-clamped-${u.stationId}`,
        icon: Gauge,
        tone: "danger",
        title: `Station ${u.stationId} defect-clamped`,
        detail: `Effective WIP ${u.effectiveLimit} vs limit ${u.limit} (defect rate ${Math.round((u.defectRate ?? 0) * 100)}%)`,
        fix: { label: "Review station", action: actions.raiseStationWip },
      });
    }
  }

  const held = arbitration?.lines.filter((l) => l.outcome === "held") ?? [];
  const outranked = held.filter((l) => (l.reason ?? "").includes("saturated") || (l.reason ?? "").includes("pool"));
  if (outranked.length > 0) {
    signals.push({
      id: "outranked",
      icon: ArrowUpRight,
      tone: "warn",
      title: `${outranked.length} order${outranked.length > 1 ? "s" : ""} outranked`,
      detail: "The fab pool is held by higher-scored work. See arbitration for why.",
      fix: { label: "Change priority", action: actions.reviewPriority },
    });
  }

  if ((arbitration?.starvationSignals.length ?? 0) > 0) {
    signals.push({
      id: "starved",
      icon: ShieldAlert,
      tone: "danger",
      title: "Starved by lower-priority claims",
      detail: "A senior order waits on the pool. Release a claim to free a box.",
      fix: { label: "Arbitration panel", action: actions.reviewPriority },
    });
  }

  const blocked = (arbitration?.lines ?? []).some((l) => (l.reason ?? "").includes("budget"));
  if (blocked) {
    signals.push({
      id: "budget",
      icon: Coins,
      tone: "warn",
      title: "Budget exhausted",
      detail: "Orders are held on the product's rolling 30-day budget.",
      fix: { label: "Raise budget", action: actions.reviewBudget },
    });
  }

  const depBlocked = held.filter((l) => (l.reason ?? "").includes("dependency"));
  if (depBlocked.length > 0) {
    signals.push({
      id: "deps",
      icon: Link2,
      tone: "info",
      title: `${depBlocked.length} blocked on dependencies`,
      detail: "These orders wait for their dependency DAG to clear.",
      fix: { label: "View chain", action: actions.openDeps },
    });
  }

  return signals;
}

export function SignalRail({ signals, onFix }: { signals: Signal[]; onFix: (signal: Signal) => void }) {
  if (signals.length === 0) {
    return (
      <div className="glass-card p-4 space-y-3" style={{ borderRadius: 14 }}>
        <div className="flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5" style={{ color: "var(--accent-success)" }} />
          <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Signals</span>
        </div>
        <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
          Line is clear — no signals.
        </p>
      </div>
    );
  }

  return (
    <div className="glass-card p-4 space-y-3" style={{ borderRadius: 14 }}>
      <div className="flex items-center gap-2">
        <AlertTriangle className="w-3.5 h-3.5" style={{ color: "var(--accent-danger)" }} />
        <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Signals</span>
        <span className="text-[9px] font-mono px-1.5 py-0.5 rounded-full" style={{ background: "rgba(225,29,72,0.12)", color: "var(--accent-danger)" }}>
          {signals.length}
        </span>
      </div>
      <div className="space-y-2">
        {signals.map((signal) => {
          const Icon = signal.icon;
          const toneColor = signal.tone === "danger" ? "var(--accent-danger)" : signal.tone === "warn" ? "#f59e0b" : "var(--accent-cyan)";
          return (
            <div key={signal.id} className="rounded-xl p-2.5" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)" }}>
              <div className="flex items-start gap-2">
                <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" style={{ color: toneColor }} />
                <div className="min-w-0 flex-1">
                  <p className="text-[11px] font-medium" style={{ color: "var(--text-primary)" }}>{signal.title}</p>
                  <p className="text-[10px] leading-snug mt-0.5" style={{ color: "var(--text-secondary)" }}>{signal.detail}</p>
                  {signal.fix && (
                    <button
                      type="button"
                      onClick={() => onFix(signal)}
                      className="mt-1.5 inline-flex items-center gap-1 text-[10px] font-medium px-2 py-0.5 rounded-lg transition-colors"
                      style={{ color: toneColor, background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)" }}
                    >
                      <RefreshCcw className="w-2.5 h-2.5" />
                      {signal.fix.label}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
