import { useState } from "react";
import { Link, useLocation } from "wouter";
import { ArrowLeft, Loader2, Sparkles, GitBranch, Factory } from "lucide-react";
import { useCreateFactoryProduct, useDecomposeProduct } from "@/hooks/use-factory";
import { useToast } from "@/hooks/use-toast";
import type { ProductPriority } from "@/lib/factory-types";

const PRIORITIES: Array<{ value: ProductPriority; label: string; hint: string }> = [
  { value: "p0", label: "P0", hint: "Critical — wins the pool" },
  { value: "p1", label: "P1", hint: "Important — weighted 0.6" },
  { value: "p2", label: "P2", hint: "Standard — weighted 0.3" },
];

export default function FactoryProductSpec() {
  const [, navigate] = useLocation();
  const { toast } = useToast();
  const createProduct = useCreateFactoryProduct();
  const [name, setName] = useState("");
  const [repoUrl, setRepoUrl] = useState("");
  const [intentText, setIntentText] = useState("");
  const [priority, setPriority] = useState<ProductPriority>("p2");
  const [wipLimit, setWipLimit] = useState(4);
  const [budgetUsd, setBudgetUsd] = useState<string>("");
  const [roadmapPreview, setRoadmapPreview] = useState<string[] | null>(null);
  const [planId, setPlanId] = useState<number | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [createdId, setCreatedId] = useState<number | null>(null);
  const decompose = useDecomposeProduct(createdId);

  const preview = async () => {
    if (!name.trim()) {
      toast({ title: "Give the product a name first", variant: "destructive" });
      return;
    }
    setPreviewing(true);
    try {
      const created = await createProduct.mutateAsync({
        name: name.trim(),
        repoUrl: repoUrl.trim(),
        priority,
        wipLimit,
        budgetUsd: budgetUsd ? Number(budgetUsd) : null,
      });
      setCreatedId(created.product.id);
      if (intentText.trim()) {
        const result = await decompose.mutateAsync({ intentText: intentText.trim(), commit: false });
        setPlanId(result.planId);
        setRoadmapPreview(result.roadmap);
      } else {
        setRoadmapPreview([]);
      }
      toast({ title: "Roadmap preview ready" });
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Preview failed", variant: "destructive" });
    } finally {
      setPreviewing(false);
    }
  };

  const commitRoadmap = async () => {
    if (createdId == null) return;
    try {
      await decompose.mutateAsync({ intentText: intentText.trim(), commit: true });
      toast({ title: "Roadmap committed — the pilot line is live" });
      navigate(`/factory/${createdId}`);
    } catch (err) {
      toast({ title: err instanceof Error ? err.message : "Commit failed", variant: "destructive" });
    }
  };

  const done = createdId != null && roadmapPreview != null;

  return (
    <div className="p-6 lg:p-8 max-w-3xl mx-auto glass-emerge">
      <div className="flex items-center gap-3 mb-6">
        <Link href="/factory">
          <span className="p-2 rounded-xl transition-colors cursor-pointer" style={{ color: "var(--text-secondary)", background: "var(--bg-glass)" }}>
            <ArrowLeft className="w-3.5 h-3.5" />
          </span>
        </Link>
        <div>
          <h1 className="text-lg font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            Product specification
          </h1>
          <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
            Spec-first launch: name, repo, priority, intent → roadmap → commit. Work starts from a spec, never an empty board.
          </p>
        </div>
      </div>

      <div className="space-y-4">
        <div className="glass-card p-5 space-y-4" style={{ borderRadius: 16 }}>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>Product name</label>
              <input
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="checkout-service"
                className="w-full px-3 py-2 rounded-xl text-sm outline-none"
                style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", color: "var(--text-primary)" }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium flex items-center gap-1" style={{ color: "var(--text-secondary)" }}>
                <GitBranch className="w-3 h-3" /> Repo URL
              </label>
              <input
                value={repoUrl}
                onChange={(e) => setRepoUrl(e.target.value)}
                placeholder="https://github.com/org/repo"
                className="w-full px-3 py-2 rounded-xl text-sm font-mono outline-none"
                style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", color: "var(--text-primary)" }}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>
              Intent — what should this product become?
            </label>
            <textarea
              value={intentText}
              onChange={(e) => setIntentText(e.target.value)}
              rows={3}
              placeholder="A payment checkout service with Stripe integration, idempotency, and a webhook retry queue"
              className="w-full px-3 py-2 rounded-xl text-sm outline-none resize-none"
              style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", color: "var(--text-primary)" }}
            />
            <p className="text-[10px]" style={{ color: "var(--text-muted)" }}>
              MIZI decomposes this into the roadmap preview via the plan pipeline.
            </p>
          </div>

          <div className="space-y-1.5">
            <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>Standing priority</label>
            <div className="flex items-center gap-2">
              {PRIORITIES.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  onClick={() => setPriority(p.value)}
                  className="flex-1 px-3 py-2 rounded-xl text-xs transition-all"
                  style={{
                    background: priority === p.value ? "var(--bg-glass-active)" : "var(--bg-glass)",
                    border: `1px solid ${priority === p.value ? "var(--accent-cyan)" : "var(--border-glass)"}`,
                    color: priority === p.value ? "var(--accent-cyan)" : "var(--text-secondary)",
                  }}
                >
                  <span className="font-semibold">{p.label}</span>
                  <span className="block text-[9px] opacity-70 mt-0.5">{p.hint}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>WIP limit</label>
              <input
                type="number"
                min={1}
                max={32}
                value={wipLimit}
                onChange={(e) => setWipLimit(Math.max(1, Math.min(32, Number(e.target.value) || 4)))}
                className="w-full px-3 py-2 rounded-xl text-sm font-mono outline-none"
                style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", color: "var(--text-primary)" }}
              />
            </div>
            <div className="space-y-1.5">
              <label className="text-[11px] font-medium" style={{ color: "var(--text-secondary)" }}>Budget (30-day, USD, optional)</label>
              <input
                type="number"
                min={0}
                value={budgetUsd}
                onChange={(e) => setBudgetUsd(e.target.value)}
                placeholder="untracked"
                className="w-full px-3 py-2 rounded-xl text-sm font-mono outline-none"
                style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)", color: "var(--text-primary)" }}
              />
            </div>
          </div>

          {!done ? (
            <button
              type="button"
              disabled={previewing || createProduct.isPending}
              onClick={preview}
              className="w-full inline-flex items-center justify-center gap-2 text-xs font-semibold px-3 py-2.5 rounded-xl transition-all disabled:opacity-50"
              style={{
                background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-violet))",
                color: "#fff",
                boxShadow: "0 2px 10px rgba(0,180,216,0.25)",
              }}
            >
              {previewing ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Sparkles className="w-3.5 h-3.5" />}
              Decompose the spec
            </button>
          ) : (
            <div className="rounded-xl p-4 space-y-3" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass-soft)" }}>
              <div className="flex items-center gap-2">
                <Factory className="w-3.5 h-3.5" style={{ color: "var(--accent-success)" }} />
                <span className="text-xs font-semibold" style={{ color: "var(--text-primary)" }}>
                  Roadmap preview
                </span>
                <span className="text-[9px] font-mono" style={{ color: "var(--text-muted)" }}>
                  plan #{planId ?? "—"} · {roadmapPreview?.length ?? 0} steps
                </span>
              </div>
              {roadmapPreview && roadmapPreview.length > 0 ? (
                <ol className="space-y-1">
                  {roadmapPreview.map((step, i) => (
                    <li key={i} className="flex items-center gap-2 text-[11px]" style={{ color: "var(--text-primary)" }}>
                      <span className="font-mono text-[9px] shrink-0" style={{ color: "var(--accent-cyan)" }}>{i + 1}.</span>
                      {step}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="text-[11px]" style={{ color: "var(--text-secondary)" }}>
                  No intent — the product starts with an empty board. Work orders can be created manually or from an intent later.
                </p>
              )}
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  disabled={decompose.isPending}
                  onClick={commitRoadmap}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl transition-all disabled:opacity-50"
                  style={{ background: "var(--accent-success)", color: "#fff" }}
                >
                  {decompose.isPending ? <Loader2 className="w-3 h-3 animate-spin" /> : null}
                  Commit roadmap & launch
                </button>
                <Link href={`/factory/${createdId}`}>
                  <button type="button" className="text-xs font-medium px-3 py-2 rounded-xl transition-colors" style={{ color: "var(--text-secondary)", background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)" }}>
                    Skip — open control room
                  </button>
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
