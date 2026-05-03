import { useQuery, useQueryClient, useMutation } from "@tanstack/react-query";
import { format } from "date-fns";
import {
  Brain,
  Search,
  X,
  Clock,
  ChevronDown,
  ChevronRight,
  FolderOpen,
  Download,
  Upload,
  AlertTriangle,
  Loader2,
  Pencil,
  Check,
  Activity,
  Layers,
  Zap,
  TrendingUp,
  ShieldAlert,
  RefreshCw,
  Trash2,
  EyeOff,
  GitMerge,
} from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { useState, useEffect, useRef, useMemo } from "react";
import { toast } from "sonner";
import type { MemoryGovernanceStatsResponse } from "@workspace/api-client-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip as RechartsTooltip, ResponsiveContainer, Cell,
} from "recharts";

const BASE_URL = import.meta.env.BASE_URL ?? "/";
const PAGE_SIZE = 30;
const SESSIONS_PAGE_SIZE = 50;

interface MemSession {
  id: string;
  userId: string;
  projectPath: string;
  startedAt: number;
  endedAt: number | null;
  summary: string | null;
  observationCount: number;
}

interface MemObservation {
  id: number;
  sessionId: string;
  userId: string;
  toolName: string;
  inputSummary: string;
  outputSummary: string;
  recordedAt: number;
}

interface SearchResultObservation extends MemObservation {
  sessionSummary: string | null;
  sessionStartedAt: number;
}

interface MemorySearchResult {
  observations: SearchResultObservation[];
  sessions: MemSession[];
  totalObservations: number;
  totalSessions: number;
}

interface ReviewCount {
  stale: number;
  openConflicts: number;
  total: number;
}

interface StaleMemItem {
  id: number;
  memoryType: string;
  scope: string;
  content: string;
  staleStatus: string;
  validityStatus: string;
  ttlExpiresAt: number | null;
  createdAt: number;
  updatedAt: number;
  symbolRef: string | null;
  roiScore: number;
}

interface ConflictGroup {
  id: number;
  scope: string;
  conflictStatus: string;
  firstItemId: number | null;
  createdAt: number;
  updatedAt: number;
}

interface ConflictWithItems {
  group: ConflictGroup;
  items: StaleMemItem[];
}

function useSessionsPage(offset: number) {
  return useQuery<MemSession[]>({
    queryKey: ["mem-all-sessions", offset],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/sessions?limit=${SESSIONS_PAGE_SIZE}&offset=${offset}`);
      if (!res.ok) throw new Error("Failed to fetch memory sessions");
      return res.json();
    },
    refetchInterval: offset === 0 ? 60000 : false,
  });
}

function useGlobalSearch(query: string, projectPath: string, offset: number) {
  return useQuery<MemorySearchResult>({
    queryKey: ["mem-global-search", query, projectPath, offset],
    enabled: query.trim().length > 1,
    queryFn: async () => {
      const params = new URLSearchParams({ q: query, limit: String(PAGE_SIZE), offset: String(offset) });
      if (projectPath) params.set("projectPath", projectPath);
      const res = await fetch(`${BASE_URL}api/memory/search?${params.toString()}`);
      if (!res.ok) throw new Error("Failed to search memory");
      return res.json();
    },
    staleTime: 5000,
  });
}

export function useMemoryReviewCount() {
  return useQuery<ReviewCount>({
    queryKey: ["mem-review-count"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/review-count`);
      if (!res.ok) throw new Error("Failed to fetch review count");
      return res.json();
    },
    refetchInterval: 120000,
    staleTime: 30000,
  });
}

function useStaleItems(limit = 50) {
  return useQuery<{ items: StaleMemItem[]; count: number }>({
    queryKey: ["mem-stale-items", limit],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/stale?limit=${limit}`);
      if (!res.ok) throw new Error("Failed to fetch stale items");
      return res.json();
    },
  });
}

function useOpenConflicts() {
  return useQuery<{ conflicts: ConflictWithItems[] }>({
    queryKey: ["mem-open-conflicts"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/governance/conflicts`);
      if (!res.ok) throw new Error("Failed to fetch conflicts");
      return res.json();
    },
  });
}

const LAST_BACKUP_KEY = "floatr:last-memory-backup";
const LAST_BACKUP_KEY_LEGACY = "omniql:last-memory-backup";

function useLastBackupTime() {
  const [lastBackup, setLastBackup] = useState<Date | null>(() => {
    try {
      const stored = localStorage.getItem(LAST_BACKUP_KEY);
      if (stored) return new Date(stored);
      const legacy = localStorage.getItem(LAST_BACKUP_KEY_LEGACY);
      if (legacy) {
        localStorage.setItem(LAST_BACKUP_KEY, legacy);
        localStorage.removeItem(LAST_BACKUP_KEY_LEGACY);
        return new Date(legacy);
      }
      return null;
    } catch {
      return null;
    }
  });

  const recordBackup = () => {
    const now = new Date();
    try {
      localStorage.setItem(LAST_BACKUP_KEY, now.toISOString());
    } catch {
      // ignore storage errors
    }
    setLastBackup(now);
  };

  return { lastBackup, recordBackup };
}

const LAYER_COLORS = ["#6366f1", "#8b5cf6", "#a78bfa", "#c4b5fd", "#e9d5ff"];
const TYPE_COLORS = ["#3b82f6", "#10b981", "#f59e0b", "#ef4444", "#06b6d4", "#ec4899", "#84cc16"];
const SCOPE_COLORS = ["#f97316", "#14b8a6", "#8b5cf6", "#ef4444", "#6366f1", "#22c55e"];

function MemoryHealthPanel() {
  // Fetches from the dashboard proxy (/api/memory/governance-stats) rather than
  // the generated client hook (useGetMemoryGovernanceStats → /api/mem/stats)
  // because /api/mem/* routes are token-gated by verifyMemToken in production
  // and cannot be safely called from the browser without a bearer token.
  // The proxy uses server-side MEM_USER_ID and follows the existing pattern
  // used by /api/memory/sessions, /api/memory/search, etc.
  const { data: stats, isLoading, isError } = useQuery<MemoryGovernanceStatsResponse>({
    queryKey: ["memory-governance-stats"],
    queryFn: async () => {
      const res = await fetch(`${BASE_URL}api/memory/governance-stats`);
      if (!res.ok) throw new Error("Failed to fetch governance stats");
      return res.json() as Promise<MemoryGovernanceStatsResponse>;
    },
    refetchInterval: 30000,
    staleTime: 20000,
  });

  if (isLoading) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
            <Activity className="w-4 h-4" /> Memory Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3 mb-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-16 w-full rounded-md" />
            ))}
          </div>
          <Skeleton className="h-32 w-full rounded-md" />
        </CardContent>
      </Card>
    );
  }

  if (isError || !stats) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
            <Activity className="w-4 h-4" /> Memory Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground text-center py-4">
            Could not load memory health stats.
          </p>
        </CardContent>
      </Card>
    );
  }

  const totalItems = stats.totalItems ?? 0;

  if (totalItems === 0) {
    return (
      <Card className="bg-card/50 border-border/50">
        <CardHeader className="pb-3">
          <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
            <Activity className="w-4 h-4" /> Memory Health
          </CardTitle>
        </CardHeader>
        <CardContent>
          <div className="py-6 text-center text-muted-foreground text-sm">
            <Layers className="w-8 h-8 mx-auto mb-2 opacity-20" />
            <p>No memory items yet.</p>
            <p className="text-xs mt-1 opacity-70">Stats will appear once the agent records memory during sessions.</p>
          </div>
        </CardContent>
      </Card>
    );
  }

  const staleCount = stats.staleCount ?? 0;
  const stalePct = totalItems > 0 ? Math.round((staleCount / totalItems) * 100) : 0;
  const contradictionCount = stats.contradictionCount ?? 0;
  const promotionCount = stats.promotionCount ?? 0;
  const hitRate = stats.hitRate ?? 0;
  const avgTokens = stats.avgInjectedTokensEstimate ?? 0;

  const layerData = Object.entries(stats.layerUsage ?? {})
    .map(([name, count]) => ({ name, count: count as number }))
    .sort((a, b) => b.count - a.count);

  const typeData = Object.entries(stats.byType ?? {})
    .map(([name, count]) => ({ name, count: count as number }))
    .sort((a, b) => b.count - a.count);

  const scopeData = Object.entries(stats.byScope ?? {})
    .map(([name, count]) => ({ name, count: count as number }))
    .sort((a, b) => b.count - a.count);

  const healthColor = stalePct > 40 ? "text-red-400" : stalePct > 20 ? "text-amber-400" : "text-emerald-400";
  const healthLabel = stalePct > 40 ? "Degraded" : stalePct > 20 ? "Fair" : "Healthy";

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
          <Activity className="w-4 h-4" /> Memory Health
          <span className={`ml-auto text-[10px] font-semibold normal-case px-2 py-0.5 rounded-full border ${healthColor} border-current bg-current/10`}>
            {healthLabel}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        {/* Stat tiles */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          <div className="rounded-lg border border-border/40 bg-secondary/20 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] uppercase tracking-wide font-medium">
              <Layers className="w-3.5 h-3.5" /> Total Items
            </div>
            <div className="text-2xl font-bold tracking-tight">{totalItems.toLocaleString()}</div>
          </div>

          <div className="rounded-lg border border-border/40 bg-secondary/20 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] uppercase tracking-wide font-medium">
              <Clock className="w-3.5 h-3.5" /> Stale
            </div>
            <div className={`text-2xl font-bold tracking-tight ${stalePct > 20 ? "text-amber-400" : ""}`}>
              {stalePct}%
            </div>
            <div className="text-[10px] text-muted-foreground">{staleCount} item{staleCount !== 1 ? "s" : ""}</div>
          </div>

          <div className="rounded-lg border border-border/40 bg-secondary/20 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] uppercase tracking-wide font-medium">
              <ShieldAlert className="w-3.5 h-3.5" /> Conflicts
            </div>
            <div className={`text-2xl font-bold tracking-tight ${contradictionCount > 0 ? "text-red-400" : ""}`}>
              {contradictionCount}
            </div>
            <div className="text-[10px] text-muted-foreground">{promotionCount} promoted</div>
          </div>

          <div className="rounded-lg border border-border/40 bg-secondary/20 p-3 space-y-1">
            <div className="flex items-center gap-1.5 text-muted-foreground text-[10px] uppercase tracking-wide font-medium">
              <Zap className="w-3.5 h-3.5" /> Hit Rate
            </div>
            <div className="text-2xl font-bold tracking-tight">{Math.round(hitRate * 100)}%</div>
            <div className="text-[10px] text-muted-foreground">~{Math.round(avgTokens)} avg tokens</div>
          </div>
        </div>

        {/* Charts row */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          {/* Layer usage bar chart */}
          {layerData.length > 0 && (
            <div className="sm:col-span-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-2 flex items-center gap-1.5">
                <TrendingUp className="w-3 h-3" /> Layer Hit Distribution
              </p>
              <ResponsiveContainer width="100%" height={110}>
                <BarChart data={layerData} margin={{ top: 0, right: 0, left: -24, bottom: 0 }}>
                  <XAxis dataKey="name" tick={{ fontSize: 9, fill: "currentColor" }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 9, fill: "currentColor" }} tickLine={false} axisLine={false} />
                  <RechartsTooltip
                    contentStyle={{ fontSize: 11, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 6 }}
                    labelStyle={{ color: "hsl(var(--foreground))" }}
                    itemStyle={{ color: "hsl(var(--muted-foreground))" }}
                  />
                  <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                    {layerData.map((_, idx) => (
                      <Cell key={idx} fill={LAYER_COLORS[idx % LAYER_COLORS.length]} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}

          {/* By type breakdown */}
          {typeData.length > 0 && (
            <div className="sm:col-span-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-2 flex items-center gap-1.5">
                <Layers className="w-3 h-3" /> By Type
              </p>
              <div className="space-y-1">
                {typeData.slice(0, 6).map((d, idx) => (
                  <div key={d.name} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: TYPE_COLORS[idx % TYPE_COLORS.length] }} />
                    <span className="text-[10px] text-muted-foreground flex-1 truncate">{d.name}</span>
                    <span className="text-[10px] font-mono text-foreground/70 flex-shrink-0">{d.count}</span>
                    <div className="w-14 bg-secondary/40 rounded-full h-1.5 flex-shrink-0">
                      <div
                        className="h-1.5 rounded-full"
                        style={{
                          width: `${Math.round((d.count / totalItems) * 100)}%`,
                          background: TYPE_COLORS[idx % TYPE_COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* By scope */}
          {scopeData.length > 0 && (
            <div className="sm:col-span-1">
              <p className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium mb-2 flex items-center gap-1.5">
                <Activity className="w-3 h-3" /> By Scope
              </p>
              <div className="space-y-1">
                {scopeData.slice(0, 6).map((d, idx) => (
                  <div key={d.name} className="flex items-center gap-2">
                    <span className="w-2 h-2 rounded-full flex-shrink-0" style={{ background: SCOPE_COLORS[idx % SCOPE_COLORS.length] }} />
                    <span className="text-[10px] text-muted-foreground flex-1 truncate">{d.name}</span>
                    <span className="text-[10px] font-mono text-foreground/70 flex-shrink-0">{d.count}</span>
                    <div className="w-14 bg-secondary/40 rounded-full h-1.5 flex-shrink-0">
                      <div
                        className="h-1.5 rounded-full"
                        style={{
                          width: `${Math.round((d.count / totalItems) * 100)}%`,
                          background: SCOPE_COLORS[idx % SCOPE_COLORS.length],
                        }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>

        {/* Budget profile badge */}
        {stats.budgetProfile && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground border-t border-border/30 pt-3">
            <span className="uppercase tracking-wide font-medium">Budget:</span>
            <span className="font-mono bg-secondary/40 rounded px-2 py-0.5 text-foreground/70">
              {stats.budgetProfile.memoryCandidateCount} candidates
            </span>
            <span className="font-mono bg-secondary/40 rounded px-2 py-0.5 text-foreground/70">
              layer {stats.budgetProfile.memoryLayerAccess}
            </span>
            <span className="font-mono bg-secondary/40 rounded px-2 py-0.5 text-foreground/70">
              stale: {stats.budgetProfile.memoryStaleSuppressionStrength}
            </span>
            <span className="font-mono bg-secondary/40 rounded px-2 py-0.5 text-foreground/70">
              verbosity: {stats.budgetProfile.memoryMetadataVerbosity}
            </span>
            {stats.semanticContradictionActive && (
              <span className="ml-auto flex items-center gap-1 text-emerald-400">
                <span className="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse inline-block" />
                Semantic contradiction active
              </span>
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function MemoryBackupCard() {
  const [restoring, setRestoring] = useState(false);
  const [downloading, setDownloading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { lastBackup, recordBackup } = useLastBackupTime();

  async function handleDownload() {
    setDownloading(true);
    try {
      const res = await fetch(`${BASE_URL}api/memory/backup`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || "Download failed");
      }
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const disposition = res.headers.get("Content-Disposition") || "";
      const match = disposition.match(/filename="([^"]+)"/);
      a.download = match?.[1] ?? `mem-backup-${new Date().toISOString().slice(0, 10)}.db`;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
      recordBackup();
      toast.success("Memory backup downloaded");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download backup");
    } finally {
      setDownloading(false);
    }
  }

  async function handleRestore(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!e.target.files) return;
    e.target.value = "";
    if (!file) return;
    if (!file.name.endsWith(".db") && !file.name.endsWith(".sqlite") && !file.name.endsWith(".sqlite3")) {
      toast.error("Please select a .db or .sqlite file");
      return;
    }
    setRestoring(true);
    try {
      const buf = await file.arrayBuffer();
      const res = await fetch(`${BASE_URL}api/memory/restore`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: buf,
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error((body as { error?: string }).error || "Restore failed");
      }
      toast.success("Memory database restored — reload the page to see updated data");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to restore backup");
    } finally {
      setRestoring(false);
    }
  }

  return (
    <Card className="bg-card/50 border-border/50">
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
          <Download className="w-4 h-4" /> Backup &amp; Restore
          {lastBackup && (
            <span className="ml-auto text-[10px] font-normal normal-case text-muted-foreground/70 flex items-center gap-1">
              <Clock className="w-3 h-3" />
              Last backed up: {format(lastBackup, "MMM d, yyyy 'at' HH:mm")}
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-col sm:flex-row gap-3">
          <div className="flex-1 space-y-1.5">
            <p className="text-xs font-medium text-foreground">Download backup</p>
            <p className="text-xs text-muted-foreground">
              Export your full memory database as a <code className="font-mono text-[10px] bg-secondary/40 rounded px-1">.db</code> file.
            </p>
            <Button
              size="sm"
              variant="outline"
              className="mt-2 gap-1.5"
              onClick={handleDownload}
              disabled={downloading}
            >
              <Download className="w-3.5 h-3.5" />
              {downloading ? "Downloading…" : "Download .db"}
            </Button>
          </div>

          <div className="w-px bg-border/40 hidden sm:block" />

          <div className="flex-1 space-y-1.5">
            <p className="text-xs font-medium text-foreground">Restore from backup</p>
            <p className="text-xs text-muted-foreground">
              Upload a previously downloaded <code className="font-mono text-[10px] bg-secondary/40 rounded px-1">.db</code> file to replace the current database.
            </p>
            <div className="flex items-center gap-2 mt-2">
              <Button
                size="sm"
                variant="outline"
                className="gap-1.5"
                onClick={() => fileInputRef.current?.click()}
                disabled={restoring}
              >
                <Upload className="w-3.5 h-3.5" />
                {restoring ? "Restoring…" : "Upload & Restore"}
              </Button>
            </div>
            <input
              ref={fileInputRef}
              type="file"
              accept=".db,.sqlite,.sqlite3"
              className="hidden"
              onChange={handleRestore}
            />
            <p className="text-[10px] text-amber-500/80 flex items-center gap-1 mt-1">
              <AlertTriangle className="w-3 h-3 flex-shrink-0" />
              This overwrites all current memory data.
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

const STALE_STATUS_LABELS: Record<string, string> = {
  stale: "Stale",
  invalidated: "Invalidated",
  fresh: "TTL expired",
};

const STALE_STATUS_COLORS: Record<string, string> = {
  stale: "text-amber-400 bg-amber-400/10 border-amber-400/20",
  invalidated: "text-red-400 bg-red-400/10 border-red-400/20",
  fresh: "text-orange-400 bg-orange-400/10 border-orange-400/20",
};

function MemoryReviewCard() {
  const queryClient = useQueryClient();
  const { data: reviewCount, isLoading: countLoading } = useMemoryReviewCount();
  const { data: staleData, isLoading: staleLoading } = useStaleItems(50);
  const { data: conflictsData, isLoading: conflictsLoading } = useOpenConflicts();

  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const [sweeping, setSweeping] = useState(false);

  const staleItems = staleData?.items ?? [];
  const conflicts = conflictsData?.conflicts ?? [];

  const bulkMutation = useMutation({
    mutationFn: async ({ itemIds, action }: { itemIds: number[]; action: "dismiss" | "retract" }) => {
      const res = await fetch(`${BASE_URL}api/memory/stale/bulk`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ itemIds, action }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || "Operation failed");
      }
      return res.json();
    },
    onSuccess: (data, vars) => {
      const label = vars.action === "dismiss" ? "dismissed" : "retracted";
      toast.success(`${data.updated} item${data.updated !== 1 ? "s" : ""} ${label}`);
      setSelectedIds(new Set());
      queryClient.invalidateQueries({ queryKey: ["mem-stale-items"] });
      queryClient.invalidateQueries({ queryKey: ["mem-review-count"] });
    },
    onError: (err: Error) => {
      toast.error(err.message || "Operation failed");
    },
  });

  async function handleSweep() {
    setSweeping(true);
    try {
      const res = await fetch(`${BASE_URL}api/memory/sweep`, { method: "POST" });
      if (!res.ok) throw new Error("Sweep failed");
      const data = await res.json() as { markedStale: number };
      toast.success(data.markedStale > 0
        ? `Sweep complete — ${data.markedStale} item${data.markedStale !== 1 ? "s" : ""} newly marked stale`
        : "Sweep complete — no new stale items found");
      queryClient.invalidateQueries({ queryKey: ["mem-stale-items"] });
      queryClient.invalidateQueries({ queryKey: ["mem-review-count"] });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Sweep failed");
    } finally {
      setSweeping(false);
    }
  }

  const allSelectableIds = staleItems.map(i => i.id);
  const allSelected = allSelectableIds.length > 0 && allSelectableIds.every(id => selectedIds.has(id));

  function toggleAll() {
    if (allSelected) {
      setSelectedIds(new Set());
    } else {
      setSelectedIds(new Set(allSelectableIds));
    }
  }

  function toggleItem(id: number) {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  const isLoading = countLoading || staleLoading || conflictsLoading;
  const hasReviewItems = (reviewCount?.total ?? 0) > 0;

  return (
    <Card className={`border-border/50 ${hasReviewItems ? "bg-amber-950/10 border-amber-500/20" : "bg-card/50"}`}>
      <CardHeader className="pb-3">
        <CardTitle className="text-sm flex items-center gap-2 font-medium uppercase tracking-wide">
          <ShieldAlert className={`w-4 h-4 ${hasReviewItems ? "text-amber-400" : "text-muted-foreground"}`} />
          <span className={hasReviewItems ? "text-amber-300" : "text-muted-foreground"}>
            Memory Review
          </span>
          {countLoading ? (
            <Skeleton className="h-4 w-12 ml-1" />
          ) : hasReviewItems ? (
            <span className="ml-1 text-xs font-mono bg-amber-500/20 text-amber-300 border border-amber-500/30 rounded px-1.5 py-0.5 font-bold">
              {reviewCount!.total} to review
            </span>
          ) : (
            <span className="ml-1 text-[10px] font-normal normal-case text-muted-foreground/70">
              All memories are fresh
            </span>
          )}
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-6 px-2 gap-1 text-xs text-muted-foreground"
            onClick={handleSweep}
            disabled={sweeping}
          >
            <RefreshCw className={`w-3 h-3 ${sweeping ? "animate-spin" : ""}`} />
            Sweep
          </Button>
        </CardTitle>
      </CardHeader>

      <CardContent className="space-y-4">
        {isLoading ? (
          <div className="space-y-2">
            {Array.from({ length: 3 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full" />
            ))}
          </div>
        ) : !hasReviewItems ? (
          <p className="text-xs text-muted-foreground text-center py-4">
            No stale or conflicted memories. Run a sweep to check TTL expiry.
          </p>
        ) : (
          <>
            {/* Summary row */}
            <div className="flex gap-3 text-xs">
              {(reviewCount?.stale ?? 0) > 0 && (
                <span className="flex items-center gap-1 text-amber-400">
                  <Clock className="w-3 h-3" />
                  {reviewCount!.stale} stale
                </span>
              )}
              {(reviewCount?.openConflicts ?? 0) > 0 && (
                <span className="flex items-center gap-1 text-red-400">
                  <GitMerge className="w-3 h-3" />
                  {reviewCount!.openConflicts} conflict{reviewCount!.openConflicts !== 1 ? "s" : ""}
                </span>
              )}
            </div>

            {/* Stale items section */}
            {staleItems.length > 0 && (
              <div>
                <div className="flex items-center gap-2 mb-2">
                  <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    Stale Items ({staleItems.length})
                  </p>
                  {selectedIds.size > 0 && (
                    <div className="flex gap-1.5 ml-auto">
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs gap-1 border-amber-500/30 text-amber-300 hover:bg-amber-500/10"
                        onClick={() => bulkMutation.mutate({ itemIds: Array.from(selectedIds), action: "dismiss" })}
                        disabled={bulkMutation.isPending}
                      >
                        <EyeOff className="w-3 h-3" />
                        Dismiss {selectedIds.size}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-6 px-2 text-xs gap-1 border-red-500/30 text-red-400 hover:bg-red-500/10"
                        onClick={() => bulkMutation.mutate({ itemIds: Array.from(selectedIds), action: "retract" })}
                        disabled={bulkMutation.isPending}
                      >
                        <Trash2 className="w-3 h-3" />
                        Retract {selectedIds.size}
                      </Button>
                    </div>
                  )}
                </div>

                <div className="border border-border/30 rounded overflow-hidden">
                  {/* Header row */}
                  <div className="flex items-center gap-2 px-3 py-2 bg-secondary/20 border-b border-border/20">
                    <input
                      type="checkbox"
                      checked={allSelected}
                      onChange={toggleAll}
                      className="w-3.5 h-3.5 accent-primary cursor-pointer"
                    />
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium flex-1">
                      Content
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium w-20 text-right hidden sm:block">
                      Type
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium w-16 text-right hidden sm:block">
                      Status
                    </span>
                    <span className="text-[10px] uppercase tracking-wide text-muted-foreground font-medium w-24 text-right hidden md:block">
                      Expired
                    </span>
                  </div>

                  {/* Item rows */}
                  <div className="divide-y divide-border/20">
                    {staleItems.map(item => {
                      const isSelected = selectedIds.has(item.id);
                      const statusKey = item.staleStatus !== "fresh" ? item.staleStatus : "fresh";
                      return (
                        <div
                          key={item.id}
                          className={`flex items-center gap-2 px-3 py-2.5 text-xs transition-colors ${isSelected ? "bg-primary/5" : "hover:bg-secondary/10"}`}
                        >
                          <input
                            type="checkbox"
                            checked={isSelected}
                            onChange={() => toggleItem(item.id)}
                            className="w-3.5 h-3.5 accent-primary cursor-pointer flex-shrink-0"
                          />
                          <div className="flex-1 min-w-0">
                            <p className="truncate text-foreground/80" title={item.content}>
                              {item.content}
                            </p>
                            {item.symbolRef && (
                              <p className="text-[10px] text-muted-foreground/60 font-mono truncate mt-0.5">
                                symbol: {item.symbolRef}
                              </p>
                            )}
                          </div>
                          <span className="text-[10px] text-muted-foreground w-20 text-right hidden sm:block flex-shrink-0">
                            {item.memoryType}
                          </span>
                          <span className={`text-[10px] border rounded px-1 py-0.5 w-16 text-center hidden sm:block flex-shrink-0 ${STALE_STATUS_COLORS[statusKey] ?? "text-muted-foreground bg-secondary/20 border-border/30"}`}>
                            {STALE_STATUS_LABELS[statusKey] ?? item.staleStatus}
                          </span>
                          <span className="text-[10px] text-muted-foreground w-24 text-right hidden md:block flex-shrink-0">
                            {item.ttlExpiresAt
                              ? format(new Date(item.ttlExpiresAt * 1000), "MMM d, yyyy")
                              : "—"}
                          </span>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <p className="text-[10px] text-muted-foreground mt-2">
                  <span className="font-medium">Dismiss</span> hides stale items from AI suggestions.{" "}
                  <span className="font-medium">Retract</span> permanently removes them.
                </p>
              </div>
            )}

            {/* Open conflict groups */}
            {conflicts.length > 0 && (
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                  Open Conflicts ({conflicts.length})
                </p>
                <div className="space-y-2">
                  {conflicts.map(({ group, items }) => (
                    <div key={group.id} className="border border-red-500/20 bg-red-950/10 rounded p-3">
                      <div className="flex items-center gap-2 mb-2">
                        <GitMerge className="w-3.5 h-3.5 text-red-400 flex-shrink-0" />
                        <span className="text-xs font-medium text-red-300">
                          Conflict Group #{group.id}
                        </span>
                        <span className="text-[10px] text-muted-foreground ml-auto">
                          {format(new Date(group.createdAt * 1000), "MMM d, yyyy")} · scope: {group.scope}
                        </span>
                      </div>
                      <div className="space-y-1">
                        {items.map(item => (
                          <div key={item.id} className="text-xs text-foreground/70 border border-border/20 rounded px-2 py-1.5 bg-card/30">
                            <p className="truncate" title={item.content}>{item.content}</p>
                            <p className="text-[10px] text-muted-foreground mt-0.5">
                              {item.memoryType} · {item.scope}
                            </p>
                          </div>
                        ))}
                      </div>
                      <p className="text-[10px] text-muted-foreground mt-2">
                        Resolve conflicts via the governance API or update the conflicting items.
                      </p>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        )}
      </CardContent>
    </Card>
  );
}

const MEMORY_PROJECT_FILTER_PARAM = "projectPath";

function getProjectFromUrl(): string {
  try {
    return new URLSearchParams(window.location.search).get(MEMORY_PROJECT_FILTER_PARAM) ?? "";
  } catch {
    return "";
  }
}

function setProjectInUrl(value: string) {
  try {
    const params = new URLSearchParams(window.location.search);
    if (value) {
      params.set(MEMORY_PROJECT_FILTER_PARAM, value);
    } else {
      params.delete(MEMORY_PROJECT_FILTER_PARAM);
    }
    const search = params.toString();
    const newUrl = window.location.pathname + (search ? `?${search}` : "");
    window.history.replaceState(null, "", newUrl);
  } catch {
    // ignore
  }
}

export default function MemoryPage() {
  const queryClient = useQueryClient();
  const [searchInput, setSearchInput] = useState("");
  const [debouncedQuery, setDebouncedQuery] = useState("");
  const [expandedSessions, setExpandedSessions] = useState<Set<string>>(new Set());
  const [selectedProject, setSelectedProjectState] = useState(getProjectFromUrl);

  function setSelectedProject(value: string) {
    setSelectedProjectState(value);
    setProjectInUrl(value);
  }
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const [editingSessionId, setEditingSessionId] = useState<string | null>(null);
  const [editDraft, setEditDraft] = useState("");
  const [savingSessionId, setSavingSessionId] = useState<string | null>(null);

  async function handleSaveSummary(sessId: string) {
    setSavingSessionId(sessId);
    try {
      const res = await fetch(`${BASE_URL}api/memory/sessions/${encodeURIComponent(sessId)}/summary`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ summary: editDraft }),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { error?: string }).error || "Failed to save");
      }
      setAllLoadedSessions(prev =>
        prev.map(s => s.id === sessId ? { ...s, summary: editDraft || null } : s)
      );
      queryClient.invalidateQueries({ queryKey: ["mem-all-sessions"] });
      toast.success("Session note saved");
      setEditingSessionId(null);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to save note");
    } finally {
      setSavingSessionId(null);
    }
  }

  function startEdit(sess: MemSession) {
    setEditingSessionId(sess.id);
    setEditDraft(sess.summary ?? "");
  }

  // Default sessions list pagination
  const [sessionsOffset, setSessionsOffset] = useState(0);
  const [allLoadedSessions, setAllLoadedSessions] = useState<MemSession[]>([]);
  const { data: sessionsPage, isLoading: sessionsLoading, isFetching: sessionsFetching } = useSessionsPage(sessionsOffset);

  useEffect(() => {
    if (!sessionsPage) return;
    if (sessionsOffset === 0) {
      setAllLoadedSessions(sessionsPage);
    } else {
      setAllLoadedSessions(prev => {
        const seen = new Set(prev.map(s => s.id));
        return [...prev, ...sessionsPage.filter(s => !seen.has(s.id))];
      });
    }
  }, [sessionsPage]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasMoreSessions = (sessionsPage?.length ?? 0) >= SESSIONS_PAGE_SIZE;

  // Search pagination
  const [searchOffset, setSearchOffset] = useState(0);
  const [allObservations, setAllObservations] = useState<SearchResultObservation[]>([]);
  const [allSessions, setAllSessions] = useState<MemSession[]>([]);
  const [totalObservations, setTotalObservations] = useState(0);
  const [totalSessions, setTotalSessions] = useState(0);

  useEffect(() => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => setDebouncedQuery(searchInput), 350);
    return () => { if (debounceTimer.current) clearTimeout(debounceTimer.current); };
  }, [searchInput]);

  // Reset accumulated results when query or project filter changes
  useEffect(() => {
    setSearchOffset(0);
    setAllObservations([]);
    setAllSessions([]);
    setTotalObservations(0);
    setTotalSessions(0);
  }, [debouncedQuery, selectedProject]);

  const isSearching = debouncedQuery.trim().length > 1;
  const { data: searchResults, isLoading: searchLoading, isFetching } = useGlobalSearch(debouncedQuery, selectedProject, searchOffset);

  const projectPaths = useMemo(() => {
    const paths = [...new Set(allLoadedSessions.map(s => s.projectPath).filter(Boolean))].sort();
    return paths;
  }, [allLoadedSessions]);

  const filteredSessions = useMemo(() => {
    if (!selectedProject) return allLoadedSessions;
    return allLoadedSessions.filter(s => s.projectPath === selectedProject);
  }, [allLoadedSessions, selectedProject]);


  // Accumulate results as pages load (dedup by id)
  useEffect(() => {
    if (!searchResults) return;
    setTotalObservations(searchResults.totalObservations);
    setTotalSessions(searchResults.totalSessions);
    if (searchOffset === 0) {
      setAllObservations(searchResults.observations);
      setAllSessions(searchResults.sessions);
    } else {
      setAllObservations(prev => {
        const seen = new Set(prev.map(o => o.id));
        return [...prev, ...searchResults.observations.filter(o => !seen.has(o.id))];
      });
      setAllSessions(prev => {
        const seen = new Set(prev.map(s => s.id));
        return [...prev, ...searchResults.sessions.filter(s => !seen.has(s.id))];
      });
    }
  }, [searchResults]); // eslint-disable-line react-hooks/exhaustive-deps

  const hasMoreSearchObservations = allObservations.length < totalObservations;
  const hasMoreSearchSessions = allSessions.length < totalSessions;
  const hasMore = hasMoreSearchObservations || hasMoreSearchSessions;

  const loadMore = () => {
    setSearchOffset(prev => prev + PAGE_SIZE);
  };

  const toggleSession = (id: string) => {
    setExpandedSessions(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const sessionsWithSummaries = filteredSessions.filter(s => s.summary);
  const sessionsWithoutSummaries = filteredSessions.filter(s => !s.summary);

  return (
    <div className="p-8 max-w-3xl mx-auto space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-3">
          <Brain className="w-6 h-6 text-primary" />
          Memory
        </h1>
        <p className="text-muted-foreground text-sm mt-1">
          AI session notes and tool observations — searchable across all sessions.
        </p>
      </div>

      {/* Memory Health Panel */}
      <MemoryHealthPanel />

      {/* Filter + Search row */}
      <div className="flex gap-2 items-center">
        {/* Project path filter */}
        {projectPaths.length > 0 && (
          <div className="relative flex-shrink-0">
            <FolderOpen className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-muted-foreground pointer-events-none" />
            <select
              value={selectedProject}
              onChange={e => setSelectedProject(e.target.value)}
              className="pl-8 pr-8 py-2 text-xs rounded-md border border-border/50 bg-secondary/30 text-foreground appearance-none focus:outline-none focus:ring-1 focus:ring-ring cursor-pointer min-w-[160px] max-w-[240px]"
            >
              <option value="">All projects</option>
              {projectPaths.map(p => (
                <option key={p} value={p}>{p.length > 30 ? `…${p.slice(-30)}` : p}</option>
              ))}
            </select>
            <ChevronDown className="absolute right-2 top-1/2 -translate-y-1/2 w-3 h-3 text-muted-foreground pointer-events-none" />
          </div>
        )}

        {/* Search bar */}
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground pointer-events-none" />
          <Input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value)}
            placeholder="Search session notes and tool observations…"
            className="pl-9 pr-9 bg-secondary/30 border-border/50"
          />
          {searchInput && (
            <button
              onClick={() => setSearchInput("")}
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </div>

      {/* Active project filter badge */}
      {selectedProject && (
        <div className="flex items-center gap-2">
          <span className="text-xs text-muted-foreground">Filtered by project:</span>
          <span className="inline-flex items-center gap-1 text-xs font-mono bg-primary/10 text-primary rounded px-2 py-0.5 border border-primary/20">
            <FolderOpen className="w-3 h-3" />
            {selectedProject.length > 40 ? `…${selectedProject.slice(-40)}` : selectedProject}
            <button
              onClick={() => setSelectedProject("")}
              className="ml-1 hover:text-foreground"
            >
              <X className="w-3 h-3" />
            </button>
          </span>
        </div>
      )}

      {/* Search results */}
      {isSearching && (
        <Card className="bg-card/50 border-border/50">
          <CardHeader className="pb-2">
            <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
              <Search className="w-4 h-4" /> Results for &ldquo;{debouncedQuery}&rdquo;
              {selectedProject && (
                <span className="ml-1 text-[10px] font-normal normal-case text-primary/70">
                  in {selectedProject.length > 24 ? `…${selectedProject.slice(-24)}` : selectedProject}
                </span>
              )}
            </CardTitle>
          </CardHeader>
          <CardContent>
            {searchLoading && searchOffset === 0 ? (
              <div className="space-y-2">
                {Array.from({ length: 3 }).map((_, i) => (
                  <Skeleton key={i} className="h-14 w-full" />
                ))}
              </div>
            ) : allObservations.length === 0 && allSessions.length === 0 ? (
              <p className="text-sm text-muted-foreground text-center py-6">No results found.</p>
            ) : (
              <div className="space-y-4">
                {allSessions.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                      Sessions — showing {allSessions.length} of {totalSessions}
                    </p>
                    <div className="space-y-2">
                      {allSessions.map(sess => (
                        <div key={sess.id} className="border border-primary/30 bg-primary/5 rounded p-3">
                          <div className="flex items-center gap-2 mb-1.5">
                            <span className="font-mono text-[10px] text-primary/70 bg-primary/10 rounded px-1.5 py-0.5">
                              {sess.id.length > 20 ? `${sess.id.slice(0, 20)}…` : sess.id}
                            </span>
                            <span className="text-xs text-muted-foreground">
                              {format(new Date(sess.startedAt * 1000), "MMM d, yyyy HH:mm")}
                            </span>
                            <span className="text-[10px] text-muted-foreground ml-auto">
                              {sess.observationCount} observations
                            </span>
                          </div>
                          {sess.projectPath && (
                            <p className="text-[10px] font-mono text-muted-foreground/70 mb-1">
                              {sess.projectPath}
                            </p>
                          )}
                          {sess.summary && (
                            <p className="text-xs text-foreground/90 leading-relaxed">{sess.summary}</p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {allObservations.length > 0 && (
                  <div>
                    <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-2">
                      Tool Observations — showing {allObservations.length} of {totalObservations}
                    </p>
                    <div className="space-y-1.5">
                      {allObservations.map(obs => (
                        <div key={obs.id} className="border border-border/40 rounded p-2 text-xs font-mono">
                          <div className="flex items-center justify-between mb-1">
                            <span className="text-primary font-semibold">{obs.toolName}</span>
                            <span className="text-muted-foreground text-[10px]">
                              {format(new Date(obs.recordedAt * 1000), "MMM d HH:mm")}
                            </span>
                          </div>
                          {obs.inputSummary && (
                            <p className="text-muted-foreground truncate" title={obs.inputSummary}>
                              In: {obs.inputSummary}
                            </p>
                          )}
                          {obs.outputSummary && (
                            <p className="text-muted-foreground truncate" title={obs.outputSummary}>
                              Out: {obs.outputSummary}
                            </p>
                          )}
                          {obs.sessionSummary && (
                            <p className="text-muted-foreground/60 text-[10px] mt-1 border-t border-border/30 pt-1 truncate" title={obs.sessionSummary}>
                              Session: {obs.sessionSummary}
                            </p>
                          )}
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {hasMore && (
                  <div className="flex justify-center pt-2">
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={loadMore}
                      disabled={isFetching}
                      className="gap-2"
                    >
                      {isFetching ? (
                        <Loader2 className="w-3.5 h-3.5 animate-spin" />
                      ) : null}
                      Load more
                    </Button>
                  </div>
                )}
              </div>
            )}
          </CardContent>
        </Card>
      )}

      {/* Memory Review — always visible (not hidden during search) */}
      {!isSearching && <MemoryReviewCard />}

      {/* Backup & Restore */}
      {!isSearching && <MemoryBackupCard />}

      {/* Default view */}
      {!isSearching && (
        <>
          {sessionsLoading ? (
            <div className="space-y-3">
              {Array.from({ length: 4 }).map((_, i) => (
                <Skeleton key={i} className="h-20 w-full" />
              ))}
            </div>
          ) : filteredSessions.length === 0 ? (
            <Card className="bg-card/50 border-border/50">
              <CardContent className="pt-8 pb-8 text-center text-muted-foreground text-sm">
                <Brain className="w-10 h-10 mx-auto mb-3 opacity-20" />
                {selectedProject ? (
                  <>
                    <p>No sessions found for this project.</p>
                    <p className="text-xs mt-1 opacity-70">
                      Try selecting a different project or clear the filter.
                    </p>
                  </>
                ) : (
                  <>
                    <p>No memory recorded yet.</p>
                    <p className="text-xs mt-1 opacity-70">
                      Memory is captured automatically as the AI uses tools during sessions.
                    </p>
                  </>
                )}
              </CardContent>
            </Card>
          ) : (
            <>
              {/* Sessions with summaries */}
              {sessionsWithSummaries.length > 0 && (
                <Card className="bg-card/50 border-border/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                      <Clock className="w-4 h-4" /> Session Notes
                      <span className="ml-auto text-[10px] font-normal normal-case">
                        {sessionsWithSummaries.length} session{sessionsWithSummaries.length !== 1 ? "s" : ""}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-2">
                    {sessionsWithSummaries.map(sess => {
                      const isExpanded = expandedSessions.has(sess.id);
                      const isEditing = editingSessionId === sess.id;
                      const isSaving = savingSessionId === sess.id;
                      return (
                        <div key={sess.id} className="border border-border/40 rounded">
                          <div className="flex items-center gap-2 p-2">
                            <button
                              onClick={() => toggleSession(sess.id)}
                              className="flex items-center gap-2 flex-1 text-left hover:bg-secondary/20 transition-colors rounded min-w-0"
                            >
                              {isExpanded ? (
                                <ChevronDown className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              ) : (
                                <ChevronRight className="w-3 h-3 text-muted-foreground flex-shrink-0" />
                              )}
                              <span className="font-mono text-[10px] text-primary/60 flex-shrink-0 bg-primary/10 rounded px-1">
                                {sess.id.length > 16 ? `${sess.id.slice(0, 16)}…` : sess.id}
                              </span>
                              <span className="font-mono text-xs text-muted-foreground flex-shrink-0">
                                {format(new Date(sess.startedAt * 1000), "MMM d, HH:mm")}
                              </span>
                              <span className="text-[10px] text-muted-foreground ml-auto flex-shrink-0">
                                {sess.observationCount} obs
                              </span>
                            </button>
                            {!isEditing && (
                              <button
                                onClick={() => startEdit(sess)}
                                title="Edit session note"
                                className="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            )}
                          </div>

                          {/* Inline edit area */}
                          {isEditing ? (
                            <div className="mx-2 mb-2 space-y-1.5">
                              <textarea
                                value={editDraft}
                                onChange={e => setEditDraft(e.target.value)}
                                rows={4}
                                className="w-full text-xs rounded border border-primary/40 bg-primary/5 px-2.5 py-2 text-foreground/90 leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-primary/50"
                                placeholder="Write your session notes here…"
                                autoFocus
                              />
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  className="h-6 text-xs px-2 gap-1"
                                  onClick={() => handleSaveSummary(sess.id)}
                                  disabled={isSaving}
                                >
                                  {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 text-xs px-2"
                                  onClick={() => setEditingSessionId(null)}
                                  disabled={isSaving}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          ) : (
                            /* Summary — always shown as a note block */
                            sess.summary && (
                              <div className="mx-2 mb-2 px-3 py-2 bg-primary/5 border border-primary/20 rounded text-xs text-foreground/90 leading-relaxed">
                                {sess.summary}
                              </div>
                            )
                          )}

                          {isExpanded && sess.projectPath && (
                            <div className="px-3 pb-3">
                              <span className="text-[10px] text-muted-foreground font-mono">
                                Project: {sess.projectPath}
                              </span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              )}

              {/* Sessions without summaries */}
              {sessionsWithoutSummaries.length > 0 && (
                <Card className="bg-card/50 border-border/50">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm flex items-center gap-2 text-muted-foreground font-medium uppercase tracking-wide">
                      <Brain className="w-4 h-4" /> Other Sessions
                      <span className="ml-auto text-[10px] font-normal normal-case">
                        {sessionsWithoutSummaries.length} session{sessionsWithoutSummaries.length !== 1 ? "s" : ""}
                      </span>
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-1">
                    {sessionsWithoutSummaries.map(sess => {
                      const isEditing = editingSessionId === sess.id;
                      const isSaving = savingSessionId === sess.id;
                      return (
                        <div key={sess.id} className="rounded border border-border/30">
                          <div className="flex items-center gap-2 px-2 py-1.5 text-xs">
                            <span className="font-mono text-[10px] text-primary/50 bg-primary/10 rounded px-1 flex-shrink-0">
                              {sess.id.length > 16 ? `${sess.id.slice(0, 16)}…` : sess.id}
                            </span>
                            <span className="font-mono text-muted-foreground">
                              {format(new Date(sess.startedAt * 1000), "MMM d, HH:mm")}
                            </span>
                            <span className="text-muted-foreground/60 text-[10px] ml-auto">
                              {sess.observationCount} obs · no summary
                            </span>
                            {!isEditing && (
                              <button
                                onClick={() => startEdit(sess)}
                                title="Add session note"
                                className="flex-shrink-0 p-1 rounded text-muted-foreground hover:text-foreground hover:bg-secondary/40 transition-colors"
                              >
                                <Pencil className="w-3 h-3" />
                              </button>
                            )}
                          </div>
                          {isEditing && (
                            <div className="mx-2 mb-2 space-y-1.5">
                              <textarea
                                value={editDraft}
                                onChange={e => setEditDraft(e.target.value)}
                                rows={4}
                                className="w-full text-xs rounded border border-primary/40 bg-primary/5 px-2.5 py-2 text-foreground/90 leading-relaxed resize-y focus:outline-none focus:ring-1 focus:ring-primary/50"
                                placeholder="Write your session notes here…"
                                autoFocus
                              />
                              <div className="flex gap-2">
                                <Button
                                  size="sm"
                                  className="h-6 text-xs px-2 gap-1"
                                  onClick={() => handleSaveSummary(sess.id)}
                                  disabled={isSaving}
                                >
                                  {isSaving ? <Loader2 className="w-3 h-3 animate-spin" /> : <Check className="w-3 h-3" />}
                                  Save
                                </Button>
                                <Button
                                  size="sm"
                                  variant="ghost"
                                  className="h-6 text-xs px-2"
                                  onClick={() => setEditingSessionId(null)}
                                  disabled={isSaving}
                                >
                                  Cancel
                                </Button>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </CardContent>
                </Card>
              )}

              {/* Load more sessions */}
              {hasMoreSessions && (
                <div className="flex justify-center">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => setSessionsOffset(prev => prev + SESSIONS_PAGE_SIZE)}
                    disabled={sessionsFetching}
                    className="gap-2"
                  >
                    {sessionsFetching ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : null}
                    Load more sessions
                  </Button>
                </div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
