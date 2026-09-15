/**
 * arbitration-panel.tsx — RFC 0005/0006: the operator's answer to "why B not
 * A". Renders the dispatcher's per-order scores, factors, and lostTo, plus the
 * fab lane-pool occupancy. Actionable: change-priority / pull-due-date /
 * release-claim actions (RFC decisions).
 */

import { Scale, Zap, ShieldAlert } from "lucide-react";
import type { ArbitrationPass, FactoryProduct, ProductPriority } from "@/lib/factory-types";
import { useUpdateFactoryProduct, useReleaseClaim } from "@/hooks/use-factory";

const PRIORITY_LABEL: Record<ProductPriority, string> = { p0: "P0", p1: "P1", p2: "P2" };

export function ArbitrationPanel({
  pass,
  product,
  onMutated,
}: {
  pass: ArbitrationPass | null | undefined;
  product: FactoryProduct | null | undefined;
  onMutated: () => void;
}) {
  const updateProduct = useUpdateFactoryProduct();
  const releaseClaim = useReleaseClaim();

  if (!pass) {
    return (
      <div className="glass-card p-4 space-y-2" style={{ borderRadius: 14 }}>
        <div className="flex items-center gap-2">
          <Scale className="w-3.5 h-3.5" style={{ color: "var(--accent-violet)" }} />
          <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Arbitration</span>
        </div>
        <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
          No arbitration pass has run yet. Run dispatch to produce a readout.
        </p>
      </div>
    );
  }

  const myLines = (pass.lines ?? []).filter((l) => !product || l.productId === product.id);
  const signals = (pass.starvationSignals ?? []).filter((s) => !product || s.productId === product.id);

  const changePriority = async (line: { productId: number; productPriority: ProductPriority }) => {
    const next: ProductPriority = line.productPriority === "p0" ? "p0" : line.productPriority === "p1" ? "p0" : "p1";
    await updateProduct.mutateAsync({ id: line.productId, priority: next });
    onMutated();
  };

  const pullDueDate = async (line: { productId: number }) => {
    await updateProduct.mutateAsync({ id: line.productId, dueDate: new Date().toISOString() });
    onMutated();
  };

  return (
    <div className="glass-card p-4 space-y-3" style={{ borderRadius: 14 }}>
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Scale className="w-3.5 h-3.5" style={{ color: "var(--accent-violet)" }} />
          <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>Arbitration</span>
        </div>
        <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
          pass #{pass.passId} · {new Date(pass.ranAt).toLocaleTimeString()}
        </span>
      </div>

      <div className="flex items-center gap-2 text-[10px] font-mono">
        <span className="px-2 py-1 rounded-lg" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)", color: "var(--text-secondary)" }}>
          pool {pass.lanePool.lanePoolUsed}/{pass.lanePool.lanePoolLimit}
        </span>
        <span style={{ color: "var(--accent-success)" }}>{pass.dispatched} dispatched</span>
        <span style={{ color: "#f59e0b" }}>{pass.held} held</span>
      </div>

      {signals.length > 0 && (
        <div className="rounded-xl p-2.5" style={{ background: "rgba(225,29,72,0.08)", border: "1px solid rgba(225,29,72,0.2)" }}>
          <div className="flex items-center gap-1.5 mb-1">
            <ShieldAlert className="w-3 h-3" style={{ color: "var(--accent-danger)" }} />
            <span className="text-[10px] font-semibold" style={{ color: "var(--accent-danger)" }}>Starved</span>
          </div>
          <p className="text-[10px] leading-snug" style={{ color: "var(--text-secondary)" }}>
            Held on the pool while lower-priority products hold boxes. Release a claim to free capacity.
          </p>
          {signals[0]!.holdingClaims.map((c, i) => (
            <button
              key={i}
              type="button"
              disabled={releaseClaim.isPending}
              onClick={async () => {
                await releaseClaim.mutateAsync(c.claimId).catch(() => undefined);
                onMutated();
              }}
              className="mt-1.5 w-full text-left inline-flex items-center gap-1 text-[10px] font-medium px-2 py-1 rounded-lg transition-colors"
              style={{ color: "var(--accent-danger)", background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)" }}
            >
              <Zap className="w-2.5 h-2.5" />
              Release claim (product {c.productId}, session {c.sessionId})
            </button>
          ))}
        </div>
      )}

      <div className="space-y-1.5 max-h-64 overflow-y-auto">
        {myLines.length === 0 && (
          <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>No lines for this product in the latest pass.</p>
        )}
        {myLines.map((line) => (
          <div key={line.workOrderId} className="rounded-xl p-2.5" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)" }}>
            <div className="flex items-center justify-between gap-2">
              <span className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
                #{line.workOrderId} {PRIORITY_LABEL[line.productPriority]}/{line.orderPriority}
              </span>
              <div className="flex items-center gap-1">
                <span className="text-[9px] font-mono" style={{ color: line.outcome === "dispatched" ? "var(--accent-success)" : "#f59e0b" }}>
                  {line.outcome}
                </span>
                <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                  score {line.dispatchScore.toFixed(2)}
                </span>
              </div>
            </div>
            <div className="flex items-center gap-1 flex-wrap mt-1">
              {(["productWeight", "orderWeight", "dueDatePressure", "budgetWeight"] as const).map((f) => (
                <span key={f} className="text-[8px] font-mono px-1 py-0.5 rounded" style={{ background: "var(--bg-glass-hover)", color: "var(--text-muted)", border: "1px solid var(--border-glass-ultra)" }}>
                  {f.replace("Weight", "").replace("Pressure", "")}={line.factors[f].toFixed(2)}
                </span>
              ))}
            </div>
            {line.reason && (
              <p className="text-[10px] mt-1" style={{ color: "#f59e0b" }}>{line.reason}</p>
            )}
            {line.outcome === "held" && line.lostTo.length > 0 && (
              <p className="text-[9px] mt-0.5 font-mono" style={{ color: "var(--text-muted)" }}>
                lost to {line.lostTo.map((l) => `#${l.workOrderId}`).join(", ")}
              </p>
            )}
            {line.outcome === "held" && product && line.productId === product.id && (
              <div className="flex items-center gap-1.5 mt-1.5">
                <button
                  type="button"
                  disabled={updateProduct.isPending}
                  onClick={() => changePriority(line)}
                  className="text-[9px] font-medium px-2 py-0.5 rounded-lg transition-colors"
                  style={{ color: "var(--accent-cyan)", background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)" }}
                >
                  Bump priority
                </button>
                <button
                  type="button"
                  disabled={updateProduct.isPending}
                  onClick={() => pullDueDate(line)}
                  className="text-[9px] font-medium px-2 py-0.5 rounded-lg transition-colors"
                  style={{ color: "var(--accent-violet)", background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)" }}
                >
                  Pull due date
                </button>
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
