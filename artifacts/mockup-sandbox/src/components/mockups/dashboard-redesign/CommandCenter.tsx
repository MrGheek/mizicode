import { useState } from "react";
import { Zap, Monitor, Calendar, Terminal, Activity, Clock, DollarSign, ChevronRight } from "lucide-react";

type Tab = "fast" | "gpu" | "scheduler";

const NIM_MODELS = [
  { name: "Kimi K2.6", provider: "Vultr", ctx: "128k", badge: "Partner", live: true },
  { name: "Kimi K2", provider: "NVIDIA NIM", ctx: "64k", badge: "Free", live: true },
  { name: "DeepSeek V4 Pro", provider: "Vultr", ctx: "128k", badge: "Partner", live: true },
  { name: "Qwen3 Coder 480B", provider: "Together AI", ctx: "32k", badge: "Partner", live: false },
  { name: "MiniMax M2.7", provider: "NVIDIA NIM", ctx: "256k", badge: "Free", live: true },
  { name: "Devstral 2", provider: "NVIDIA NIM", ctx: "32k", badge: "Free", live: true },
];

const GPU_PROFILES = [
  { name: "Kimi K2.5 Starter", gpu: "1x RTX 4090", price: "$0.13–0.20/hr", tokens: "~80 tok/s" },
  { name: "Kimi K2.5 Standard", gpu: "2x RTX 4090", price: "$0.50–0.80/hr", tokens: "~160 tok/s" },
  { name: "Kimi K2.5 Pro", gpu: "1x A100", price: "$2–4/hr", tokens: "~240 tok/s" },
];

function FilterChip({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={"px-3 py-1 rounded-full text-xs font-medium transition-all border " +
        (active
          ? "bg-emerald-500/15 border-emerald-500/50 text-emerald-300"
          : "border-white/10 text-slate-400 hover:border-white/20 hover:text-slate-200")}
    >
      {label}
    </button>
  );
}

export function CommandCenter() {
  const [activeTab, setActiveTab] = useState<Tab>("fast");
  const [nimFilter, setNimFilter] = useState<"all" | "free" | "partner">("all");

  const filteredModels = NIM_MODELS.filter((m) =>
    nimFilter === "all" ? true : nimFilter === "free" ? m.badge === "Free" : m.badge === "Partner"
  );

  return (
    <div className="h-screen w-full bg-[#0a0a0f] text-slate-300 font-sans flex flex-col overflow-hidden">

      {/* TOP SESSION STATUS BAR */}
      <div className="flex-shrink-0 bg-[#0d0d14] border-b border-white/5 px-6 py-3 flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-7 h-7 rounded-md bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center">
            <Terminal className="w-3.5 h-3.5 text-white" />
          </div>
          <span className="font-bold text-sm text-white tracking-wide">MIZI</span>
          <span className="text-slate-600 text-xs">·</span>
          <span className="text-xs text-slate-500 font-mono">MISSION_CONTROL</span>
        </div>

        <div className="flex items-center gap-6">
          <div className="flex items-center gap-2 text-xs text-slate-400">
            <span className="w-1.5 h-1.5 rounded-full bg-slate-600 inline-block"></span>
            No active session
          </div>
          <button className="px-3 py-1.5 text-xs font-medium bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-slate-300 transition-colors">
            View Cockpit
          </button>
        </div>

        <div className="flex items-center gap-5 text-xs text-slate-500 font-mono">
          <span><span className="text-slate-300">11</span> sessions</span>
          <span><span className="text-slate-300">16.8h</span> compute</span>
          <span><span className="text-slate-300">$3.59</span> spent</span>
        </div>
      </div>

      {/* TABS NAV */}
      <div className="flex-shrink-0 border-b border-white/5 px-6 flex items-end gap-0">
        {[
          { id: "fast" as Tab, icon: Zap, label: "Fast Launch", sub: "~2 min", color: "emerald" },
          { id: "gpu" as Tab, icon: Monitor, label: "GPU Sessions", sub: "~25 min", color: "cyan" },
          { id: "scheduler" as Tab, icon: Calendar, label: "Scheduler", sub: "", color: "slate" },
        ].map((tab) => (
          <button
            key={tab.id}
            onClick={() => setActiveTab(tab.id)}
            className={"flex items-center gap-2 px-5 py-3 text-sm font-medium border-b-2 transition-all " +
              (activeTab === tab.id
                ? (tab.color === "emerald"
                    ? "border-emerald-500 text-emerald-300"
                    : tab.color === "cyan"
                    ? "border-cyan-500 text-cyan-300"
                    : "border-slate-400 text-slate-200")
                : "border-transparent text-slate-500 hover:text-slate-300")}
          >
            <tab.icon className="w-4 h-4" />
            {tab.label}
            {tab.sub && (
              <span className={"text-[10px] px-1.5 py-0.5 rounded font-mono " +
                (activeTab === tab.id && tab.color === "emerald"
                  ? "bg-emerald-500/15 text-emerald-400"
                  : "bg-white/5 text-slate-500")}>
                {tab.sub}
              </span>
            )}
          </button>
        ))}
      </div>

      {/* TAB CONTENT */}
      <div className="flex-1 overflow-y-auto p-6">

        {/* FAST LAUNCH TAB */}
        {activeTab === "fast" && (
          <div className="max-w-5xl mx-auto space-y-5">
            <div className="flex items-center justify-between">
              <div>
                <h2 className="text-xl font-bold text-white flex items-center gap-2">
                  <Zap className="w-5 h-5 text-emerald-400" />
                  Hosted Inference
                  <span className="flex items-center gap-1.5 text-xs text-emerald-400 font-normal font-mono ml-1">
                    <span className="relative flex h-1.5 w-1.5">
                      <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                      <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
                    </span>
                    NVIDIA NIM &amp; Vultr live
                  </span>
                </h2>
                <p className="text-sm text-slate-500 mt-0.5">No GPU rental — workspace ready in ~2 minutes</p>
              </div>
              <div className="flex gap-1.5">
                {(["all", "free", "partner"] as const).map((f) => (
                  <FilterChip key={f} label={f === "all" ? "All" : f.charAt(0).toUpperCase() + f.slice(1)} active={nimFilter === f} onClick={() => setNimFilter(f)} />
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              {filteredModels.map((model, i) => (
                <div
                  key={i}
                  className={"rounded-xl border p-4 flex flex-col gap-3 transition-all cursor-pointer group " +
                    (model.live
                      ? "bg-emerald-500/5 border-emerald-500/30 hover:border-emerald-500/60 hover:bg-emerald-500/8"
                      : "bg-white/[0.02] border-white/8 hover:border-white/15")}
                >
                  <div className="flex items-start justify-between">
                    <div>
                      <div className="flex items-center gap-2 mb-0.5">
                        <span className="font-semibold text-sm text-white">{model.name}</span>
                        {model.live && (
                          <span className="relative flex h-1.5 w-1.5">
                            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
                            <span className="relative inline-flex rounded-full h-1.5 w-1.5 bg-emerald-400"></span>
                          </span>
                        )}
                      </div>
                      <div className="text-[11px] text-slate-500 font-mono">{model.provider} · {model.ctx}</div>
                    </div>
                    <span className={"text-[10px] px-2 py-0.5 rounded font-medium uppercase tracking-wide " +
                      (model.badge === "Free"
                        ? "bg-emerald-500/10 text-emerald-400"
                        : "bg-amber-500/10 text-amber-400")}>
                      {model.badge}
                    </span>
                  </div>
                  <button className={"w-full py-1.5 rounded-lg text-xs font-medium transition-all flex items-center justify-center gap-1.5 border " +
                    (model.live
                      ? "bg-emerald-500/10 border-emerald-500/30 text-emerald-300 group-hover:bg-emerald-500 group-hover:text-emerald-950 group-hover:border-transparent"
                      : "bg-white/5 border-white/10 text-slate-400 group-hover:bg-white/10 group-hover:text-slate-200")}>
                    <Zap className="w-3 h-3" />
                    {model.live ? "Launch now" : "Launch"}
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* GPU SESSIONS TAB */}
        {activeTab === "gpu" && (
          <div className="max-w-4xl mx-auto space-y-5">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Monitor className="w-5 h-5 text-cyan-400" />
                GPU Sessions
              </h2>
              <p className="text-sm text-slate-500 mt-0.5">Dedicated instances. Full model weights on-device. Boot time: ~25-35 min.</p>
            </div>

            <div className="grid grid-cols-1 gap-3">
              {GPU_PROFILES.map((p, i) => (
                <div key={i} className="bg-white/[0.02] border border-white/8 rounded-xl p-4 flex items-center justify-between hover:border-cyan-500/30 transition-all group cursor-pointer">
                  <div className="flex items-center gap-4">
                    <div className="w-10 h-10 rounded-lg bg-cyan-500/10 border border-cyan-500/20 flex items-center justify-center">
                      <Monitor className="w-5 h-5 text-cyan-400" />
                    </div>
                    <div>
                      <div className="font-semibold text-sm text-white">{p.name}</div>
                      <div className="text-xs text-slate-500 font-mono mt-0.5">{p.gpu} · {p.tokens}</div>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <div className="text-right">
                      <div className="text-sm font-mono text-cyan-400">{p.price}</div>
                      <div className="text-[11px] text-slate-600 font-mono">~25-35 min boot</div>
                    </div>
                    <button className="px-4 py-1.5 rounded-lg bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 text-xs font-medium hover:bg-cyan-500 hover:text-cyan-950 hover:border-transparent transition-all flex items-center gap-1.5">
                      <ChevronRight className="w-3.5 h-3.5" />
                      Launch
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* SCHEDULER TAB */}
        {activeTab === "scheduler" && (
          <div className="max-w-2xl mx-auto space-y-5">
            <div>
              <h2 className="text-xl font-bold text-white flex items-center gap-2">
                <Calendar className="w-5 h-5 text-slate-400" />
                Session Scheduler
              </h2>
              <p className="text-sm text-slate-500 mt-0.5">Auto-launch a session before your workday starts</p>
            </div>

            <div className="bg-white/[0.02] border border-white/8 rounded-xl p-6 space-y-5">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-medium text-sm text-white">Enable Scheduler</div>
                  <div className="text-xs text-slate-500 mt-0.5">Launch a session automatically on schedule</div>
                </div>
                <div className="w-10 h-5 bg-cyan-500/20 rounded-full relative border border-cyan-500/50">
                  <div className="absolute right-0.5 top-0.5 w-4 h-4 bg-cyan-400 rounded-full"></div>
                </div>
              </div>

              <div className="h-px bg-white/5"></div>

              <div className="grid grid-cols-2 gap-4">
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">GPU Profile</label>
                  <div className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-300">Kimi K2.5 Starter</div>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">Timezone</label>
                  <div className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-300">America/New_York</div>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">Launch At</label>
                  <div className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-300 font-mono">09:00 AM</div>
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-500 uppercase tracking-wider block mb-2">Stop At</label>
                  <div className="w-full bg-white/5 border border-white/10 rounded-lg px-3 py-2 text-sm text-slate-300 font-mono">07:00 PM</div>
                </div>
              </div>

              <div className="rounded-lg bg-slate-500/5 border border-slate-500/20 p-3 text-xs text-slate-400 flex items-center gap-2">
                <Clock className="w-4 h-4 text-slate-500 shrink-0" />
                Next launch: Monday 09:00 AM (in 2 days)
              </div>

              <button className="w-full py-2 bg-white/5 hover:bg-white/10 border border-white/10 rounded-lg text-sm font-medium text-slate-300 transition-colors">
                Save Schedule
              </button>
            </div>
          </div>
        )}
      </div>

      {/* STATS ROW - BOTTOM */}
      <div className="flex-shrink-0 border-t border-white/5 bg-[#0d0d14] px-6 py-2.5 flex items-center gap-8">
        {[
          { icon: Activity, label: "Active", value: "0" },
          { icon: Monitor, label: "Total", value: "11" },
          { icon: Clock, label: "Hours", value: "16.8h" },
          { icon: DollarSign, label: "Spend", value: "$3.59" },
        ].map((s, i) => (
          <div key={i} className="flex items-center gap-2 text-xs">
            <s.icon className="w-3.5 h-3.5 text-slate-600" />
            <span className="text-slate-500">{s.label}:</span>
            <span className="font-mono text-slate-300">{s.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
