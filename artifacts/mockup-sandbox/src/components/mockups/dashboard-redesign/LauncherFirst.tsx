import { useState } from "react";
import { Zap, Monitor, Settings, Terminal } from "lucide-react";

type Filter = "all" | "fast" | "gpu";
type Sort = "fast" | "powerful" | "cheap";

const ALL_OPTIONS = [
  { type: "nim" as const, name: "Kimi K2.6", sub: "Vultr", ctx: "128k", badge: "Partner", price: "Partner", live: true },
  { type: "nim" as const, name: "Kimi K2", sub: "NVIDIA NIM", ctx: "64k", badge: "Free", price: "Free", live: true },
  { type: "nim" as const, name: "DeepSeek V4 Pro", sub: "Vultr", ctx: "128k", badge: "Partner", price: "Partner", live: true },
  { type: "gpu" as const, name: "Kimi K2.5 Starter", sub: "1x RTX 4090", ctx: "24GB", badge: "", price: "$0.13/hr", live: false },
  { type: "nim" as const, name: "Qwen3 Coder 480B", sub: "Together AI", ctx: "32k", badge: "Partner", price: "Partner", live: false },
  { type: "gpu" as const, name: "Kimi K2.5 Standard", sub: "2x RTX 4090", ctx: "48GB", badge: "", price: "$0.50/hr", live: false },
  { type: "nim" as const, name: "MiniMax M2.7", sub: "NVIDIA NIM", ctx: "256k", badge: "Free", price: "Free", live: true },
  { type: "gpu" as const, name: "Kimi K2.5 Pro", sub: "1x A100", ctx: "80GB", badge: "", price: "$1.85/hr", live: false },
  { type: "nim" as const, name: "Devstral 2", sub: "NVIDIA NIM", ctx: "32k", badge: "Free", price: "Free", live: true },
  { type: "gpu" as const, name: "DeepSeek V3.2", sub: "2x RTX 4090", ctx: "48GB", badge: "", price: "$0.55/hr", live: false },
  { type: "gpu" as const, name: "Kimi K2.5 Ultra", sub: "8x H100", ctx: "640GB", badge: "", price: "$18.50/hr", live: false },
  { type: "gpu" as const, name: "Qwen3 Standard", sub: "1x A100", ctx: "80GB", badge: "", price: "$1.90/hr", live: false },
];

function FilterBtn({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={"px-3 py-1.5 rounded-lg text-xs font-medium transition-all border " +
        (active
          ? "bg-white/10 border-white/20 text-white"
          : "border-white/5 text-slate-500 hover:border-white/10 hover:text-slate-300")}
    >
      {label}
    </button>
  );
}

export function LauncherFirst() {
  const [filter, setFilter] = useState<Filter>("all");
  const [sort, setSort] = useState<Sort>("fast");

  const filtered = ALL_OPTIONS.filter((o) =>
    filter === "all" ? true : filter === "fast" ? o.type === "nim" : o.type === "gpu"
  );

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "fast") {
      if (a.live && !b.live) return -1;
      if (!a.live && b.live) return 1;
      if (a.type === "nim" && b.type !== "nim") return -1;
      if (a.type !== "nim" && b.type === "nim") return 1;
      return 0;
    }
    if (sort === "cheap") {
      if (a.price === "Free") return -1;
      if (b.price === "Free") return 1;
      if (a.price === "Partner" && b.price !== "Partner") return -1;
      if (a.price !== "Partner" && b.price === "Partner") return 1;
      const ap = parseFloat(a.price.replace(/[^0-9.]/g, "")) || 999;
      const bp = parseFloat(b.price.replace(/[^0-9.]/g, "")) || 999;
      return ap - bp;
    }
    return 0;
  });

  const liveCount = ALL_OPTIONS.filter((o) => o.type === "nim" && o.live).length;

  return (
    <div className="h-screen w-full bg-[#0a0a0f] text-slate-300 font-sans flex flex-col overflow-hidden">

      {/* STICKY TOP BANNER */}
      <div className="flex-shrink-0 bg-[#0d0d14] border-b border-white/5 px-6 py-2.5 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
            <Terminal className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-bold text-sm text-white tracking-wide">FLOATR</span>
          <span className="text-slate-600 mx-1">·</span>
          <span className="flex items-center gap-1.5 text-xs text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-600 inline-block"></span>
            No active session
          </span>
        </div>

        <div className="flex items-center gap-5 text-xs font-mono text-slate-500">
          <span><span className="text-slate-300">11</span> sessions</span>
          <span><span className="text-slate-300">16.8h</span></span>
          <span><span className="text-slate-300">$3.59</span></span>
          <button className="w-7 h-7 rounded-lg bg-white/5 border border-white/10 flex items-center justify-center hover:bg-white/10 transition-colors">
            <Settings className="w-3.5 h-3.5 text-slate-400" />
          </button>
        </div>
      </div>

      {/* HERO + FILTERS */}
      <div className="flex-shrink-0 px-8 pt-7 pb-4">
        <div className="max-w-5xl mx-auto">
          <div className="flex items-end justify-between mb-5">
            <div>
              <h1 className="text-2xl font-bold text-white leading-tight">Launch a session</h1>
              <p className="text-slate-400 text-sm mt-1">
                Choose a model to start coding ·{" "}
                <span className="text-emerald-400 font-medium">
                  <span className="relative inline-flex mr-1">
                    <span className="animate-ping absolute inline-flex h-1.5 w-1.5 rounded-full bg-emerald-400 opacity-75 top-0.5"></span>
                    <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
                  </span>
                  {liveCount} providers live now
                </span>
              </p>
            </div>
            <div className="flex items-center gap-3 text-xs">
              <span className="text-slate-500">Sort:</span>
              {(["fast", "powerful", "cheap"] as Sort[]).map((s) => (
                <button
                  key={s}
                  onClick={() => setSort(s)}
                  className={"px-2.5 py-1 rounded text-xs transition-colors " +
                    (sort === s ? "text-white bg-white/10" : "text-slate-500 hover:text-slate-300")}
                >
                  {s.charAt(0).toUpperCase() + s.slice(1)}
                </button>
              ))}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <FilterBtn label="All" active={filter === "all"} onClick={() => setFilter("all")} />
            <FilterBtn label="⚡ Hosted ~2min" active={filter === "fast"} onClick={() => setFilter("fast")} />
            <FilterBtn label="🖥 GPU ~25min" active={filter === "gpu"} onClick={() => setFilter("gpu")} />
          </div>
        </div>
      </div>

      {/* CARD GRID */}
      <div className="flex-1 overflow-y-auto px-8 pb-8">
        <div className="max-w-5xl mx-auto grid grid-cols-3 gap-3">
          {sorted.map((item, i) => (
            <div
              key={i}
              className={"rounded-xl border p-4 cursor-pointer group transition-all flex flex-col gap-3 relative " +
                (item.type === "nim"
                  ? item.live
                    ? "bg-emerald-500/5 border-emerald-500/25 hover:border-emerald-500/55 hover:bg-emerald-500/8"
                    : "bg-white/[0.02] border-emerald-500/12 hover:border-emerald-500/30"
                  : "bg-white/[0.02] border-white/6 hover:border-cyan-500/30")}
            >
              {/* Type badge */}
              <div className="absolute top-3 right-3">
                {item.type === "nim" ? (
                  <span className={"text-[9px] px-1.5 py-0.5 rounded font-bold uppercase tracking-widest " +
                    (item.live ? "bg-emerald-500/20 text-emerald-400" : "bg-emerald-500/8 text-emerald-600")}>
                    ⚡ ~2min
                  </span>
                ) : (
                  <span className="text-[9px] px-1.5 py-0.5 rounded bg-cyan-500/10 text-cyan-500 font-bold uppercase tracking-widest">
                    🖥 ~25min
                  </span>
                )}
              </div>

              <div className="pr-14">
                <div className="flex items-center gap-2 mb-0.5">
                  <span className="font-semibold text-sm text-white leading-tight">{item.name}</span>
                  {item.live && (
                    <span className="relative flex h-1.5 w-1.5 shrink-0">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
                    </span>
                  )}
                </div>
                <div className="text-[11px] text-slate-500 font-mono">{item.sub} · {item.ctx}</div>
              </div>

              <div className="flex items-center justify-between mt-auto">
                <span className={"text-xs font-medium " +
                  (item.price === "Free" ? "text-emerald-400" : item.price === "Partner" ? "text-amber-400" : "text-cyan-400 font-mono")}>
                  {item.price}
                </span>
                <button className={"px-3 py-1 rounded-lg text-xs font-medium transition-all opacity-0 group-hover:opacity-100 " +
                  (item.type === "nim"
                    ? "bg-emerald-500 text-emerald-950"
                    : "bg-cyan-500 text-cyan-950")}>
                  Launch →
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
