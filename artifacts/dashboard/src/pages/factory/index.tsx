import { Link } from "wouter";
import { Factory, Plus, Boxes, Coins } from "lucide-react";
import { useFabStatus, useFactoryProducts } from "@/hooks/use-factory";
import { deriveHealth, ProductHealthLight } from "@/components/factory/product-health-light";
import type { FactoryProduct } from "@/lib/factory-types";

function ProductTile({ product }: { product: FactoryProduct }) {
  return (
    <Link href={`/factory/${product.id}`}>
      <div className="glass-card p-4 space-y-2 transition-all hover:-translate-y-0.5 cursor-pointer" style={{ borderRadius: 14 }}>
        <div className="flex items-center justify-between gap-2">
          <p className="text-sm font-semibold truncate" style={{ color: "var(--text-primary)" }}>{product.name}</p>
          <ProductHealthLight health={deriveHealth(null)} />
        </div>
        <p className="text-[10px] font-mono truncate" style={{ color: "var(--text-muted)" }}>{product.repoUrl}</p>
        <div className="flex items-center gap-2 flex-wrap text-[10px] font-mono">
          <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-glass)" }}>
            {product.priority.toUpperCase()}
          </span>
          <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-glass)" }}>
            WIP limit {product.wipLimit}
          </span>
          {product.dueDate && (
            <span className="px-1.5 py-0.5 rounded" style={{ background: "var(--bg-glass-hover)", color: "var(--text-secondary)", border: "1px solid var(--border-glass)" }}>
              due {new Date(product.dueDate).toLocaleDateString()}
            </span>
          )}
        </div>
      </div>
    </Link>
  );
}

export default function FactoryPortfolio() {
  const { data: fab, isLoading: fabLoading } = useFabStatus();
  const { data: productsData, isLoading: productsLoading } = useFactoryProducts();

  const products = productsData?.products ?? [];
  const loading = fabLoading || productsLoading;

  return (
    <div className="p-6 lg:p-8 space-y-6 max-w-6xl mx-auto glass-emerge">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>
            Factory
          </h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            The fab — products running over a shared lane pool.
          </p>
        </div>
        <Link href="/factory/new">
          <button
            type="button"
            className="inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-xl transition-all"
            style={{
              background: "linear-gradient(135deg, var(--accent-cyan), var(--accent-violet))",
              color: "#fff",
              boxShadow: "0 2px 10px rgba(0,180,216,0.25)",
            }}
          >
            <Plus className="w-3.5 h-3.5" />
            New product
          </button>
        </Link>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <div className="glass-card p-4 space-y-1" style={{ borderRadius: 14 }}>
          <div className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <Boxes className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Lane pool</span>
          </div>
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {fab ? `${fab.lanePool.lanePoolUsed}/${fab.lanePool.lanePoolLimit}` : "—"}
          </div>
          <p className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            {fab ? `${fab.lanePool.freeLanes} free` : "loading"}
          </p>
        </div>
        <div className="glass-card p-4 space-y-1" style={{ borderRadius: 14 }}>
          <div className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <Factory className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Products</span>
          </div>
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {fab?.products ?? products.length}
          </div>
          <p className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            in fab {fab?.fab.name ?? ""}
          </p>
        </div>
        <div className="glass-card p-4 space-y-1" style={{ borderRadius: 14 }}>
          <div className="flex items-center gap-1.5" style={{ color: "var(--text-muted)" }}>
            <Coins className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Fab budget</span>
          </div>
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {fab?.fab.budgetUsd != null ? `$${fab.fab.budgetUsd}` : "Untracked"}
          </div>
          <p className="text-[10px] font-mono" style={{ color: "var(--text-muted)" }}>
            per-product 30-day caps
          </p>
        </div>
      </div>

      {loading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {[1, 2, 3].map((i) => (
            <div key={i} className="glass-card p-4 h-28 shimmer" style={{ borderRadius: 14 }} />
          ))}
        </div>
      ) : products.length === 0 ? (
        <div className="glass-card p-12 text-center" style={{ borderRadius: 18 }}>
          <Factory className="w-10 h-10 mx-auto mb-3 opacity-20" />
          <p className="text-sm font-medium" style={{ color: "var(--text-primary)" }}>
            The fab is empty
          </p>
          <p className="text-xs mt-1" style={{ color: "var(--text-secondary)" }}>
            Start with a pilot product: a name, a repo, and an intent — MIZI decomposes the roadmap.
          </p>
          <Link href="/factory/new">
            <button
              type="button"
              className="mt-4 inline-flex items-center gap-2 text-xs font-semibold px-3 py-2 rounded-xl transition-all"
              style={{ color: "var(--accent-cyan)", background: "var(--bg-glass-hover)", border: "1px solid var(--border-glass)" }}
            >
              <Plus className="w-3.5 h-3.5" />
              Launch the pilot line
            </button>
          </Link>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {products.map((p) => (
            <ProductTile key={p.id} product={p} />
          ))}
        </div>
      )}
    </div>
  );
}
