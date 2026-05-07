import { useState } from "react";
import { Link } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Brain, Wand2, ArrowRight, Search, Activity, Layers, Zap, ShieldAlert, AlertCircle, Loader2,
} from "lucide-react";
import { API_BASE_URL as BASE_URL } from "@/lib/api-url";
import type { MemoryGovernanceStatsResponse } from "@workspace/api-client-react";
import { useListSkillBundles, useListSkills } from "@workspace/api-client-react";

interface ReviewCount {
  stale: number;
  openConflicts: number;
  total: number;
}

function MemorySummaryCard() {
  const { data: stats, isLoading } = useQuery<MemoryGovernanceStatsResponse>({
    queryKey: ["memory-governance-stats"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/governance-stats`);
      if (!res.ok) throw new Error("Failed to fetch governance stats");
      return res.json();
    },
    refetchInterval: 30000,
    staleTime: 20000,
  });

  const { data: reviewCount } = useQuery<ReviewCount>({
    queryKey: ["mem-review-count"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/review-count`);
      if (!res.ok) throw new Error("Failed to fetch review count");
      return res.json();
    },
    refetchInterval: 120000,
    staleTime: 30000,
  });

  if (isLoading) {
    return (
      <div className="glass-card p-6 space-y-4 animate-pulse">
        <div className="h-4 w-24 rounded shimmer" />
        <div className="grid grid-cols-3 gap-3">
          {[1,2,3].map(i => <div key={i} className="h-16 rounded-lg shimmer" />)}
        </div>
      </div>
    );
  }

  const totalItems = stats?.totalItems ?? 0;
  const hitRate = stats?.hitRate ?? 0;
  const stalePct = totalItems > 0 && stats?.staleCount ? Math.round((stats.staleCount / totalItems) * 100) : 0;
  const healthColor = stalePct > 40 ? "#f43f5e" : stalePct > 20 ? "#f59e0b" : "#10b981";
  const healthLabel = stalePct > 40 ? "Degraded" : stalePct > 20 ? "Fair" : "Healthy";

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "rgba(124,111,247,0.15)", border: "1px solid rgba(124,111,247,0.2)" }}
          >
            <Brain className="w-4 h-4" style={{ color: "var(--accent-violet)" }} />
          </div>
          <div>
            <h3 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>Memory</h3>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>Agent memory & recall</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="text-[10px] font-semibold px-2 py-0.5 rounded-full"
            style={{ color: healthColor, background: `${healthColor}15`, border: `1px solid ${healthColor}30` }}
          >
            {healthLabel}
          </span>
          <Link href="/intelligence/memory">
            <span className="flex items-center gap-1 text-xs transition-colors cursor-pointer"
              style={{ color: "var(--accent-cyan)" }}>
              Manage <ArrowRight className="w-3 h-3" />
            </span>
          </Link>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl p-3" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}>
          <div className="flex items-center gap-1 mb-1" style={{ color: "var(--text-muted)" }}>
            <Layers className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Items</span>
          </div>
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {totalItems.toLocaleString()}
          </div>
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}>
          <div className="flex items-center gap-1 mb-1" style={{ color: "var(--text-muted)" }}>
            <Zap className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Hit Rate</span>
          </div>
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {Math.round(hitRate * 100)}%
          </div>
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}>
          <div className="flex items-center gap-1 mb-1" style={{ color: "var(--text-muted)" }}>
            <ShieldAlert className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Review</span>
          </div>
          <div className="text-xl font-bold" style={{ color: reviewCount?.total ? "#f59e0b" : "var(--text-primary)" }}>
            {reviewCount?.total ?? 0}
          </div>
        </div>
      </div>
    </div>
  );
}

function SkillsSummaryCard() {
  const { data: skillsData, isLoading: loadingSkills } = useListSkills();
  const { data: bundlesData } = useListSkillBundles();

  if (loadingSkills) {
    return (
      <div className="glass-card p-6 animate-pulse">
        <div className="h-4 w-24 rounded shimmer mb-4" />
        <div className="grid grid-cols-3 gap-3">
          {[1,2,3].map(i => <div key={i} className="h-16 rounded-lg shimmer" />)}
        </div>
      </div>
    );
  }

  const skills = skillsData?.skills ?? [];
  const bundles = bundlesData?.bundles ?? [];
  const enabledSkills = skills.filter((s) => s.enabled);
  const bundleCount = bundles.length;

  return (
    <div className="glass-card p-6">
      <div className="flex items-start justify-between gap-3 mb-4">
        <div className="flex items-center gap-2">
          <div
            className="w-8 h-8 rounded-lg flex items-center justify-center shrink-0"
            style={{ background: "rgba(0,200,255,0.1)", border: "1px solid rgba(0,200,255,0.15)" }}
          >
            <Wand2 className="w-4 h-4" style={{ color: "var(--accent-cyan)" }} />
          </div>
          <div>
            <h3 className="font-semibold text-sm" style={{ color: "var(--text-primary)" }}>Skills</h3>
            <p className="text-[11px]" style={{ color: "var(--text-muted)" }}>Agent capabilities</p>
          </div>
        </div>
        <Link href="/intelligence/skills">
          <span className="flex items-center gap-1 text-xs transition-colors cursor-pointer"
            style={{ color: "var(--accent-cyan)" }}>
            Browse library <ArrowRight className="w-3 h-3" />
          </span>
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl p-3" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}>
          <div className="flex items-center gap-1 mb-1" style={{ color: "var(--text-muted)" }}>
            <Activity className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Enabled</span>
          </div>
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {enabledSkills.length}
          </div>
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}>
          <div className="flex items-center gap-1 mb-1" style={{ color: "var(--text-muted)" }}>
            <Layers className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Bundles</span>
          </div>
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {bundleCount}
          </div>
        </div>
        <div className="rounded-xl p-3" style={{ background: "var(--bg-glass)", border: "1px solid var(--border-glass)" }}>
          <div className="flex items-center gap-1 mb-1" style={{ color: "var(--text-muted)" }}>
            <Wand2 className="w-3 h-3" />
            <span className="text-[10px] uppercase tracking-wide font-medium">Total</span>
          </div>
          <div className="text-xl font-bold" style={{ color: "var(--text-primary)" }}>
            {skills.length}
          </div>
        </div>
      </div>
    </div>
  );
}

interface MemObservation {
  id: number;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  recordedAt: number;
  sessionSummary: string | null;
  sessionStartedAt: number;
}

interface SkillRecord {
  id: number;
  name: string;
  class: string;
  summary: string;
  enabled: boolean;
}

interface UnifiedSearchResult {
  type: "memory" | "skill";
  id: string | number;
  label: string;
  description: string;
}

function UnifiedSearch() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UnifiedSearchResult[]>([]);
  const [loading, setLoading] = useState(false);

  const handleSearch = async (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    setLoading(true);
    try {
      const [memRes, skillRes] = await Promise.all([
        fetch(`${BASE_URL}api/memory/search?q=${encodeURIComponent(q)}&limit=5`).then(r => r.ok ? r.json() : { observations: [] }),
        fetch(`${BASE_URL}api/skills?q=${encodeURIComponent(q)}&limit=5`).then(r => r.ok ? r.json() : { skills: [] }),
      ]);
      const memItems: UnifiedSearchResult[] = (memRes.observations ?? []).map((o: MemObservation) => ({
        type: "memory" as const,
        id: o.id,
        label: o.toolName || "Memory observation",
        description: o.outputSummary || o.inputSummary || "",
      }));
      const skillItems: UnifiedSearchResult[] = (skillRes.skills ?? []).map((s: SkillRecord) => ({
        type: "skill" as const,
        id: s.id,
        label: s.name,
        description: s.summary || "",
      }));
      setResults([...memItems, ...skillItems]);
    } catch {
      setResults([]);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="relative">
      <div
        className="flex items-center gap-3 px-4 py-3 rounded-xl"
        style={{
          background: "var(--bg-glass)",
          border: "1px solid var(--border-glass)",
          backdropFilter: "blur(10px)",
        }}
      >
        {loading ? (
          <Loader2 className="w-4 h-4 shrink-0 animate-spin" style={{ color: "var(--text-muted)" }} />
        ) : (
          <Search className="w-4 h-4 shrink-0" style={{ color: "var(--text-muted)" }} />
        )}
        <input
          type="text"
          value={query}
          onChange={(e) => handleSearch(e.target.value)}
          placeholder="Search memory observations and skills…"
          className="flex-1 bg-transparent outline-none text-sm"
          style={{ color: "var(--text-primary)" }}
        />
        {query && (
          <button onClick={() => { setQuery(""); setResults([]); }} style={{ color: "var(--text-muted)" }}>
            ×
          </button>
        )}
      </div>

      {results.length > 0 && (
        <div
          className="absolute top-full left-0 right-0 mt-2 rounded-xl overflow-hidden z-10 glass-emerge"
          style={{
            background: "rgba(10,10,20,0.96)",
            border: "1px solid var(--border-glass)",
            backdropFilter: "blur(20px)",
          }}
        >
          {results.map((r) => (
            <div
              key={`${r.type}-${r.id}`}
              className="flex items-start gap-3 px-4 py-3 cursor-pointer transition-colors"
              style={{ borderBottom: "1px solid var(--border-glass)" }}
              onMouseEnter={(e) => { (e.currentTarget as HTMLElement).style.background = "var(--bg-glass)"; }}
              onMouseLeave={(e) => { (e.currentTarget as HTMLElement).style.background = ""; }}
            >
              <span
                className="shrink-0 text-[10px] font-semibold px-1.5 py-0.5 rounded mt-0.5 uppercase tracking-wide"
                style={
                  r.type === "memory"
                    ? { background: "rgba(124,111,247,0.15)", color: "#a78bfa", border: "1px solid rgba(124,111,247,0.2)" }
                    : { background: "rgba(0,200,255,0.1)", color: "var(--accent-cyan)", border: "1px solid rgba(0,200,255,0.15)" }
                }
              >
                {r.type}
              </span>
              <div className="min-w-0">
                <p className="text-sm font-medium truncate" style={{ color: "var(--text-primary)" }}>{r.label}</p>
                {r.description && (
                  <p className="text-xs truncate mt-0.5" style={{ color: "var(--text-secondary)" }}>{r.description}</p>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      {query.length >= 2 && !loading && results.length === 0 && (
        <div
          className="absolute top-full left-0 right-0 mt-2 px-4 py-4 rounded-xl text-sm text-center"
          style={{ background: "rgba(10,10,20,0.96)", border: "1px solid var(--border-glass)", color: "var(--text-secondary)" }}
        >
          No results found for "{query}"
        </div>
      )}
    </div>
  );
}

export default function IntelligencePage() {
  return (
    <div className="min-h-full" style={{ background: "var(--bg-base)" }}>
      {/* Background glow effects */}
      <div className="fixed top-[-200px] left-[100px] w-[500px] h-[500px] rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(124,111,247,0.04) 0%, transparent 70%)", filter: "blur(60px)" }} />
      <div className="fixed bottom-[-100px] right-[-100px] w-[400px] h-[400px] rounded-full pointer-events-none"
        style={{ background: "radial-gradient(circle, rgba(0,200,255,0.04) 0%, transparent 70%)", filter: "blur(60px)" }} />

      <div className="relative max-w-4xl mx-auto px-8 py-10 space-y-8">
        {/* Header */}
        <div className="glass-emerge">
          <h1 className="text-2xl font-bold tracking-tight" style={{ color: "var(--text-primary)" }}>Intelligence</h1>
          <p className="text-sm mt-1" style={{ color: "var(--text-secondary)" }}>
            Agent memory, skills, and learning — all in one place.
          </p>
        </div>

        {/* Summary cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 glass-emerge" style={{ animationDelay: "50ms" }}>
          <MemorySummaryCard />
          <SkillsSummaryCard />
        </div>

        {/* Unified search */}
        <div className="glass-emerge" style={{ animationDelay: "100ms" }}>
          <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
            Search Memory & Skills
          </p>
          <UnifiedSearch />
        </div>

        {/* Quick links */}
        <div className="glass-emerge" style={{ animationDelay: "150ms" }}>
          <p className="text-[11px] font-semibold uppercase tracking-wider mb-3" style={{ color: "var(--text-muted)" }}>
            Deep Dive
          </p>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <Link href="/intelligence/memory">
              <div
                className="glass-card p-4 cursor-pointer group transition-all"
                style={{ borderRadius: "12px" }}
              >
                <div className="flex items-center gap-3">
                  <Brain className="w-5 h-5" style={{ color: "var(--accent-violet)" }} />
                  <div className="flex-1">
                    <p className="font-medium text-sm" style={{ color: "var(--text-primary)" }}>Memory Explorer</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                      Browse observations, sessions, backup & restore
                    </p>
                  </div>
                  <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: "var(--accent-cyan)" }} />
                </div>
              </div>
            </Link>
            <Link href="/intelligence/skills">
              <div
                className="glass-card p-4 cursor-pointer group transition-all"
                style={{ borderRadius: "12px" }}
              >
                <div className="flex items-center gap-3">
                  <Wand2 className="w-5 h-5" style={{ color: "var(--accent-cyan)" }} />
                  <div className="flex-1">
                    <p className="font-medium text-sm" style={{ color: "var(--text-primary)" }}>Skills Library</p>
                    <p className="text-xs mt-0.5" style={{ color: "var(--text-secondary)" }}>
                      Browse, import, and manage skill bundles
                    </p>
                  </div>
                  <ArrowRight className="w-4 h-4 opacity-0 group-hover:opacity-100 transition-opacity" style={{ color: "var(--accent-cyan)" }} />
                </div>
              </div>
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}
