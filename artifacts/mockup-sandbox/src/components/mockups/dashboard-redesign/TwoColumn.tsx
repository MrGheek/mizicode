import React from "react";
import { 
  Terminal, 
  Activity, 
  Clock, 
  DollarSign, 
  Calendar, 
  Cpu, 
  Zap, 
  ChevronDown,
  Play,
  Settings,
  Power
} from "lucide-react";

export function TwoColumn() {
  return (
    <div className="flex h-screen w-full bg-[#0a0a0f] text-slate-300 font-sans overflow-hidden selection:bg-cyan-500/30">
      {/* LEFT SIDEBAR */}
      <div className="w-[280px] flex-shrink-0 bg-[#0d0d14] border-r border-white/5 flex flex-col h-full overflow-y-auto">
        <div className="p-6 flex flex-col gap-6">
          {/* Header */}
          <div className="flex items-center gap-3 text-white">
            <div className="w-8 h-8 rounded-md bg-gradient-to-br from-cyan-500 to-blue-600 flex items-center justify-center shadow-[0_0_15px_rgba(0,191,255,0.3)]">
              <Terminal className="w-4 h-4 text-white" />
            </div>
            <div>
              <div className="font-bold tracking-wide text-sm">FLOATR</div>
              <div className="text-xs text-slate-500 font-mono">MISSION_CONTROL</div>
            </div>
          </div>

          {/* Active Session */}
          <div className="bg-white/[0.02] border border-white/10 rounded-xl p-4 relative overflow-hidden">
            <div className="absolute top-0 left-0 w-full h-[2px] bg-gradient-to-r from-transparent via-cyan-500 to-transparent opacity-50"></div>
            <div className="flex items-center justify-between mb-3">
              <div className="text-xs font-semibold text-slate-400 uppercase tracking-wider">Active Session</div>
              <div className="flex items-center gap-1.5">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-cyan-400 opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-cyan-500"></span>
                </span>
                <span className="text-[10px] text-cyan-400 font-mono">ONLINE</span>
              </div>
            </div>
            <div className="font-medium text-white mb-1">DeepSeek V4 Omni</div>
            <div className="text-xs text-slate-500 font-mono mb-4">vm-alpha-9x2</div>
            <button className="w-full py-2 bg-white/5 hover:bg-white/10 transition-colors border border-white/10 rounded-lg text-sm font-medium text-white flex items-center justify-center gap-2">
              <Terminal className="w-4 h-4" />
              View Cockpit
            </button>
          </div>

          {/* Stats */}
          <div className="flex flex-col gap-3">
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-1">Overview</div>
            <div className="grid grid-cols-2 gap-3">
              <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
                <div className="flex items-center gap-2 text-slate-400 mb-1">
                  <Activity className="w-3.5 h-3.5" />
                  <span className="text-xs">Active</span>
                </div>
                <div className="text-lg font-mono text-white">1</div>
              </div>
              <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
                <div className="flex items-center gap-2 text-slate-400 mb-1">
                  <Terminal className="w-3.5 h-3.5" />
                  <span className="text-xs">Total</span>
                </div>
                <div className="text-lg font-mono text-white">11</div>
              </div>
              <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
                <div className="flex items-center gap-2 text-slate-400 mb-1">
                  <Clock className="w-3.5 h-3.5" />
                  <span className="text-xs">Hours</span>
                </div>
                <div className="text-lg font-mono text-white">16.8h</div>
              </div>
              <div className="bg-white/[0.02] border border-white/5 rounded-lg p-3">
                <div className="flex items-center gap-2 text-slate-400 mb-1">
                  <DollarSign className="w-3.5 h-3.5" />
                  <span className="text-xs">Spend</span>
                </div>
                <div className="text-lg font-mono text-white">$3.59</div>
              </div>
            </div>
          </div>

          <div className="h-px w-full bg-white/5"></div>

          {/* Scheduler */}
          <div>
            <div className="flex items-center justify-between group cursor-pointer">
              <div className="flex items-center gap-2">
                <Calendar className="w-4 h-4 text-slate-400" />
                <span className="text-sm font-medium text-slate-300 group-hover:text-white transition-colors">Scheduler</span>
              </div>
              <div className="flex items-center gap-2">
                <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded text-slate-300 font-mono">Next: 9:00 AM Mon</span>
                <div className="w-8 h-4 bg-cyan-500/20 rounded-full relative border border-cyan-500/50">
                  <div className="absolute right-0.5 top-0.5 w-3 h-3 bg-cyan-400 rounded-full"></div>
                </div>
              </div>
            </div>
          </div>

          <div className="h-px w-full bg-white/5"></div>

          {/* Recent */}
          <div>
            <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider mb-3">Recent Sessions</div>
            <div className="flex flex-col gap-3">
              {[
                { name: "Kimi K2.6", date: "Today", cost: "$0.45", active: false },
                { name: "Qwen3 Coder", date: "Yesterday", cost: "$1.12", active: false },
                { name: "DeepSeek V4", date: "Mar 14", cost: "$0.89", active: false },
              ].map((s, i) => (
                <div key={i} className="flex items-center justify-between text-sm group cursor-pointer">
                  <div className="flex items-center gap-2">
                    <div className="w-1.5 h-1.5 rounded-full bg-slate-600 group-hover:bg-slate-400 transition-colors"></div>
                    <span className="text-slate-400 group-hover:text-slate-200 transition-colors">{s.name}</span>
                  </div>
                  <div className="flex items-center gap-3 font-mono text-[11px] text-slate-500">
                    <span>{s.date}</span>
                    <span>{s.cost}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* RIGHT MAIN AREA */}
      <div className="flex-1 h-full overflow-y-auto p-8 lg:p-12 relative">
        {/* Background glow effects */}
        <div className="fixed top-[-200px] right-[-200px] w-[600px] h-[600px] bg-emerald-500/5 rounded-full blur-[120px] pointer-events-none"></div>
        <div className="fixed bottom-[-200px] right-[200px] w-[500px] h-[500px] bg-cyan-500/5 rounded-full blur-[100px] pointer-events-none"></div>

        <div className="max-w-5xl mx-auto space-y-12 relative z-10">
          
          {/* SECTION 1: Hosted Inference */}
          <section>
            <div className="flex items-center gap-3 mb-2">
              <Zap className="w-6 h-6 text-emerald-400" />
              <h1 className="text-2xl font-bold text-white tracking-tight">Hosted Inference</h1>
            </div>
            <p className="text-emerald-400/70 text-sm mb-6 flex items-center gap-2">
              <span className="w-1 h-1 bg-emerald-500 rounded-full"></span>
              Start in ~2 minutes — no GPU rental needed
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {[
                { name: "Kimi K2.6", provider: "Vultr/Partner", ctx: "128k", badge: "Partner" },
                { name: "Kimi K2", provider: "Free/NVIDIA", ctx: "64k", badge: "Free" },
                { name: "DeepSeek V4 Pro", provider: "Vultr/Partner", ctx: "128k", badge: "Partner" },
                { name: "Qwen3 Coder", provider: "Partner", ctx: "32k", badge: "Partner" },
                { name: "MiniMax M2.7", provider: "Free+Partner", ctx: "256k", badge: "Free" },
                { name: "Devstral 2", provider: "Free", ctx: "32k", badge: "Free" },
              ].map((model, i) => (
                <div key={i} className="bg-[#0f111a] border border-emerald-500/20 hover:border-emerald-500/50 transition-all rounded-xl p-5 group flex flex-col justify-between min-h-[160px] shadow-[0_0_20px_rgba(16,185,129,0.02)] hover:shadow-[0_0_30px_rgba(16,185,129,0.05)]">
                  <div>
                    <div className="flex items-start justify-between mb-2">
                      <h3 className="font-semibold text-emerald-50 text-base">{model.name}</h3>
                      <span className={'text-[10px] px-2 py-0.5 rounded font-medium uppercase tracking-wider ' + (model.badge === 'Free' ? 'bg-emerald-500/10 text-emerald-400' : 'bg-blue-500/10 text-blue-400')}>
                        {model.badge}
                      </span>
                    </div>
                    <div className="flex items-center gap-2 text-xs text-slate-400 font-mono mb-4">
                      <span>{model.provider}</span>
                      <span>•</span>
                      <span>{model.ctx} ctx</span>
                    </div>
                  </div>
                  <button className="w-full py-2 bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 rounded-lg text-sm font-medium transition-all flex items-center justify-center gap-2 group-hover:bg-emerald-500 group-hover:text-emerald-950 border border-emerald-500/20 group-hover:border-transparent">
                    <Play className="w-3.5 h-3.5" fill="currentColor" />
                    Launch
                  </button>
                </div>
              ))}
            </div>
          </section>

          <div className="h-px w-full bg-gradient-to-r from-transparent via-white/5 to-transparent"></div>

          {/* SECTION 2: GPU Profiles */}
          <section>
            <div className="flex items-center gap-3 mb-2">
              <Cpu className="w-5 h-5 text-cyan-400" />
              <h2 className="text-xl font-bold text-white tracking-tight">GPU Sessions</h2>
            </div>
            <p className="text-slate-400 text-sm mb-6 flex items-center gap-2">
              <span className="w-1 h-1 bg-slate-500 rounded-full"></span>
              Full dedicated instances. Boot time: 25-35m.
            </p>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {[
                { name: "Kimi K2.5 Starter", gpu: "1x RTX 4090", ram: "24GB VRAM", price: "$0.45/hr" },
                { name: "Kimi K2.5 Standard", gpu: "2x RTX 4090", ram: "48GB VRAM", price: "$0.90/hr" },
                { name: "Kimi K2.5 Pro", gpu: "1x A100", ram: "80GB VRAM", price: "$1.85/hr" },
                { name: "Kimi K2.5 Ultra", gpu: "8x H100", ram: "640GB VRAM", price: "$18.50/hr" },
              ].map((gpu, i) => (
                <div key={i} className="bg-white/[0.02] border border-white/5 hover:border-cyan-500/30 transition-all rounded-xl p-4 group flex items-center justify-between">
                  <div>
                    <h3 className="font-medium text-slate-200 text-sm mb-1">{gpu.name}</h3>
                    <div className="flex items-center gap-3 text-xs text-slate-500 font-mono">
                      <span>{gpu.gpu}</span>
                      <span>{gpu.ram}</span>
                    </div>
                  </div>
                  <div className="flex items-center gap-4">
                    <span className="text-sm font-mono text-cyan-400">{gpu.price}</span>
                    <button className="w-8 h-8 rounded-lg bg-white/5 hover:bg-cyan-500/20 text-slate-400 hover:text-cyan-400 flex items-center justify-center transition-colors border border-white/5 group-hover:border-cyan-500/30">
                      <Power className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </section>

        </div>
      </div>
    </div>
  );
}
